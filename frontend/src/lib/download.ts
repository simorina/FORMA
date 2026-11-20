/**
 * Downloads with progress. The server writes the model in the format and reads it back to check
 * it (a job we poll); then the page fetches the file counting its bytes, checks it got every one
 * of them, and saves it. Each step reports how far it is and how long is left.
 */
import { ApiError, api, type ExportFormat, type ExportJob } from './api';

export type Phase = 'prepare' | 'download' | 'done' | 'error' | 'cancelled';

export interface DownloadProgress {
  fmt: ExportFormat;
  filename: string;
  phase: Phase;
  /** what the server is doing while preparing: load | write | check | ready */
  stage: string;
  message: string;
  /** 0..1 over the whole download, preparing and fetching */
  progress: number;
  /** bytes fetched so far, and how many there are (once the file is ready) */
  received: number;
  total: number | null;
  /** seconds left in the current step, when it can be told */
  eta: number | null;
  error: string | null;
}

/** Share of the bar for preparing the file (the rest is fetching it). */
export const PREPARE_SHARE = 0.85;
const POLL_MS = 250;

const NUMBER = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });

/** "230 MB", "1,2 GB", "840 kB". */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${NUMBER.format(n / 1e9)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}

/** "mancano circa 12 s", "manca meno di un secondo", "" when it cannot be told yet. */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  if (seconds < 1) return 'manca meno di un secondo';
  const s = Math.round(seconds);
  if (s < 60) return `mancano circa ${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `mancano circa ${m} min${rest ? ` ${rest} s` : ''}`;
}

/** Time left from how far a step is: the rate so far, smoothed so the number does not jump. */
export class Eta {
  private start = 0;
  private value: number | null = null;

  reset(now: number): void {
    this.start = now;
    this.value = null;
  }

  update(frac: number, now: number): number | null {
    const elapsed = (now - this.start) / 1000;
    if (frac >= 1) return (this.value = 0);
    if (frac < 0.02 || elapsed < 0.4) return this.value;
    const raw = (elapsed * (1 - frac)) / frac;
    this.value = this.value === null ? raw : 0.7 * this.value + 0.3 * raw;
    return this.value;
  }
}

/** Save a blob as a file with this name (the browser's own download). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(t);
      reject(new DOMException('Annullato', 'AbortError'));
    }, { once: true });
  });

const MIME: Record<ExportFormat, string> = {
  stl: 'model/stl', '3mf': 'model/3mf', obj: 'model/obj', glb: 'model/gltf-binary',
};

/**
 * Prepare, check, fetch and save one file, telling ``onUpdate`` how far it is.
 * Resolves once the whole file is saved; throws ApiError on failure, AbortError if cancelled.
 */
export async function downloadModel(
  modelId: string,
  fmt: ExportFormat,
  filename: string,
  onUpdate: (p: DownloadProgress) => void,
  signal: AbortSignal,
  save: (blob: Blob, filename: string) => void = saveBlob,
  now: () => number = () => performance.now(),
): Promise<void> {
  const eta = new Eta();
  let state: DownloadProgress = {
    fmt, filename, phase: 'prepare', stage: 'load', message: 'Avvio', progress: 0,
    received: 0, total: null, eta: null, error: null,
  };
  const emit = (patch: Partial<DownloadProgress>) => onUpdate((state = { ...state, ...patch }));
  emit({});

  // 1. the server writes the file and reads it back to check it
  let job: ExportJob = await api.startExport(modelId, fmt);
  // Giving up for any reason (cancel, an error, the network) tells the server: it stops writing
  // and deletes the file at once, instead of keeping it for an hour.
  let saved = false;
  const cancel = () => void api.cancelExport(job.id).catch(() => undefined);
  signal.addEventListener('abort', cancel, { once: true });
  // No estimate while the server reads the model (a couple of seconds with no steps to measure):
  // from the first written slice, the time left covers writing and checking only.
  let base: number | null = null;
  try {
    while (job.status === 'running') {
      let left: number | null = null;
      if (job.stage !== 'load') {
        if (base === null) {
          base = job.progress;
          eta.reset(now());
        }
        left = eta.update((job.progress - base) / Math.max(1 - base, 1e-6), now());
      }
      emit({ stage: job.stage, message: job.message, filename: job.filename,
        progress: PREPARE_SHARE * job.progress, eta: left });
      await sleep(POLL_MS, signal);
      job = await api.exportStatus(job.id);
    }
    if (job.status !== 'ready' || job.size === null) {
      throw new ApiError(job.error || 'Esportazione non riuscita', 500);
    }
    // 2. fetch it, counting every byte
    eta.reset(now());
    emit({ phase: 'download', stage: 'ready', message: job.message, filename: job.filename,
      progress: PREPARE_SHARE, total: job.size, received: 0, eta: null });
    let res: Response;
    try {
      res = await fetch(job.url, { signal });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new ApiError('Il server di Forma non risponde: download interrotto.', 0);
    }
    if (!res.ok || !res.body) throw new ApiError(`Download non riuscito (${res.status}).`, res.status);
    const total = job.size;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      const frac = Math.min(received / total, 1);
      emit({ received, progress: PREPARE_SHARE + (1 - PREPARE_SHARE) * frac, eta: eta.update(frac, now()) });
    }
    // 3. every byte the server checked, and not one more
    if (received !== total) {
      throw new ApiError(`Download incompleto: arrivati ${formatBytes(received)} di ${formatBytes(total)}. Riprova.`, 0);
    }
    save(new Blob(chunks as BlobPart[], { type: MIME[fmt] }), job.filename);
    saved = true;
    emit({ phase: 'done', progress: 1, eta: 0, received });
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!saved && !signal.aborted) cancel(); // (an abort has told the server already)
  }
}
