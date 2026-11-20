// The download flow, run in Node against a simulated server: the export job moves forward,
// then the file arrives in pieces. What is saved must be every byte the server checked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ExportJob } from './api';
import { Eta, PREPARE_SHARE, type DownloadProgress, downloadModel, formatBytes, formatEta } from './download';

const job = (patch: Partial<ExportJob>): ExportJob => ({
  id: 'e1', model_id: 'm1', format: 'obj', filename: 'drago-100mm.obj', status: 'running', stage: 'write',
  progress: 0, message: 'Converto in OBJ', size: null, error: null, url: '/api/exports/e1/file', ...patch,
});

/** A response whose body arrives in these pieces. */
function streamed(pieces: number[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const n of pieces) c.enqueue(new Uint8Array(n).fill(7));
      c.close();
    },
  });
  return new Response(body, { status });
}

describe('formatBytes and formatEta', () => {
  it('speak Italian', () => {
    expect(formatBytes(229_700_000)).toBe('230 MB');
    expect(formatBytes(1_234_000_000)).toBe('1,2 GB');
    expect(formatBytes(840_000)).toBe('840 kB');
    expect(formatEta(null)).toBe('');
    expect(formatEta(0.4)).toBe('manca meno di un secondo');
    expect(formatEta(12.4)).toBe('mancano circa 12 s');
    expect(formatEta(80)).toBe('mancano circa 1 min 20 s');
    expect(formatEta(120)).toBe('mancano circa 2 min');
  });
});

describe('Eta', () => {
  it('waits for a first measure, then estimates from the rate, smoothed', () => {
    const eta = new Eta();
    eta.reset(0);
    expect(eta.update(0.01, 1000)).toBeNull(); // too early to tell
    expect(eta.update(0.5, 2000)).toBeCloseTo(2); // 2 s for half: 2 s left
    const next = eta.update(0.75, 3000)!; // 1 s left by the rate, smoothed towards it
    expect(next).toBeLessThan(2);
    expect(next).toBeGreaterThan(1);
    expect(eta.update(1, 4000)).toBe(0);
  });
});

describe('downloadModel', () => {
  let saved: { blob: Blob; name: string }[];
  let updates: DownloadProgress[];
  let cancelled: ReturnType<typeof vi.spyOn>;
  const save = (blob: Blob, name: string) => saved.push({ blob, name });

  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
    saved = [];
    updates = [];
    cancelled = vi.spyOn(api, 'cancelExport').mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('follows the server, then fetches and saves every byte it checked', async () => {
    vi.spyOn(api, 'startExport').mockResolvedValue(job({ progress: 0.1 }));
    const statuses = [job({ progress: 0.5 }), job({ stage: 'check', progress: 0.9, message: 'Controllo che il file sia integro' }),
      job({ status: 'ready', stage: 'ready', progress: 1, size: 3000, message: 'OBJ pronto e verificato' })];
    vi.spyOn(api, 'exportStatus').mockImplementation(async () => statuses.shift()!);
    vi.stubGlobal('fetch', vi.fn(async () => streamed([1000, 1000, 1000])));
    let t = 0;
    await downloadModel('m1', 'obj', 'drago-100mm.obj', (p) => updates.push(p), new AbortController().signal, save, () => (t += 300));
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('drago-100mm.obj');
    expect(saved[0].blob.size).toBe(3000);
    const bar = updates.map((u) => u.progress);
    expect(bar).toEqual([...bar].sort((a, b) => a - b)); // only forwards
    expect(updates.some((u) => u.stage === 'check')).toBe(true);
    const fetching = updates.filter((u) => u.phase === 'download');
    expect(fetching.map((u) => u.received)).toEqual([0, 1000, 2000, 3000]);
    expect(fetching[0].progress).toBeCloseTo(PREPARE_SHARE);
    expect(updates.at(-1)).toMatchObject({ phase: 'done', progress: 1, received: 3000, total: 3000 });
    expect(cancelled).not.toHaveBeenCalled(); // the server deletes it once sent
  }, 10_000);

  it('gives no time left while the model is read, then estimates the writing and checking', async () => {
    vi.spyOn(api, 'startExport').mockResolvedValue(job({ stage: 'load', progress: 0.02, message: 'Leggo il modello' }));
    const statuses = [job({ stage: 'load', progress: 0.02, message: 'Leggo il modello' }),
      job({ stage: 'load', progress: 0.02, message: 'Leggo il modello' }),
      job({ progress: 0.2 }), job({ progress: 0.4 }), job({ progress: 0.6 }),
      job({ status: 'ready', stage: 'ready', progress: 1, size: 10 })];
    vi.spyOn(api, 'exportStatus').mockImplementation(async () => statuses.shift()!);
    vi.stubGlobal('fetch', vi.fn(async () => streamed([10])));
    let t = 0;
    await downloadModel('m1', 'obj', 'x.obj', (p) => updates.push(p), new AbortController().signal, save, () => (t += 1000));
    const reading = updates.filter((u) => u.phase === 'prepare' && u.stage === 'load');
    expect(reading.length).toBeGreaterThan(1);
    expect(reading.every((u) => u.eta === null)).toBe(true); // never "1 min" for a 2 s read
    const writing = updates.filter((u) => u.phase === 'prepare' && u.stage === 'write');
    expect(writing.at(-1)!.eta).toBeGreaterThan(0);
    expect(writing.at(-1)!.eta).toBeLessThan(10); // 1 s per 0.2: a few seconds, not minutes
  }, 10_000);

  it('saves nothing when fewer bytes arrive than the server checked', async () => {
    vi.spyOn(api, 'startExport').mockResolvedValue(job({ status: 'ready', stage: 'ready', progress: 1, size: 3000 }));
    vi.stubGlobal('fetch', vi.fn(async () => streamed([1000, 1000])));
    await expect(downloadModel('m1', 'obj', 'x.obj', (p) => updates.push(p), new AbortController().signal, save))
      .rejects.toThrow(/Download incompleto: arrivati 2 kB di 3 kB/);
    expect(saved).toHaveLength(0);
    expect(cancelled).toHaveBeenCalledWith('e1'); // the server drops the file at once
  });

  it('says why when the file fails its check on the server', async () => {
    vi.spyOn(api, 'startExport').mockResolvedValue(job({ status: 'error', error: 'Il file OBJ non ha superato il controllo (prova)' }));
    await expect(downloadModel('m1', 'obj', 'x.obj', () => undefined, new AbortController().signal, save))
      .rejects.toThrow(/non ha superato il controllo/);
    expect(saved).toHaveLength(0);
    expect(cancelled).toHaveBeenCalledWith('e1');
  });

  it('cancelling stops the server too', async () => {
    vi.spyOn(api, 'startExport').mockResolvedValue(job({ progress: 0.1 }));
    vi.spyOn(api, 'exportStatus').mockResolvedValue(job({ progress: 0.2 }));
    const cancel = cancelled;
    const ctrl = new AbortController();
    const run = downloadModel('m1', 'obj', 'x.obj', () => undefined, ctrl.signal, save);
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    await expect(run).rejects.toThrow(/Annullato/);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('e1');
    expect(saved).toHaveLength(0);
  });
});
