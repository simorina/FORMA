/**
 * The download popup: from the click until the last byte is saved. Three steps (converting,
 * checking the file, fetching it), one bar over all of them, the step's time left and, while
 * fetching, how many megabytes have arrived. Cancel stops the server's work too.
 */
import type { App } from '../app';
import { ApiError, type ExportFormat, type Model, exportName } from '../lib/api';
import { attr, h, prop } from '../lib/dom';
import { type DownloadProgress, downloadModel, formatBytes, formatEta } from '../lib/download';
import { icon } from '../lib/icons';

const LABEL: Record<ExportFormat, string> = { stl: 'STL', '3mf': '3MF', obj: 'OBJ', glb: 'GLB' };
const STEPS = ['Converto', 'Controllo', 'Scarico'] as const;
const CLOSE_AFTER_MS = 2600;

/** Which of the three steps a progress is in (3: all done). */
export function stepOf(p: Pick<DownloadProgress, 'phase' | 'stage'>): number {
  if (p.phase === 'done') return 3;
  if (p.phase === 'download') return 2;
  return p.stage === 'check' ? 1 : 0;
}

export function mountDownloads(host: HTMLElement, app: App): void {
  const kicker = h('p', { class: 'kicker' });
  const title = h('h2', { id: 'download-title', class: 'section-title download-name' });
  const marks = STEPS.map((label) =>
    h('li', { class: 'download-step' }, h('span', { class: 'download-step-mark', 'aria-hidden': 'true' }), label));
  const steps = h('ol', { class: 'download-steps', 'aria-label': 'Passi' }, marks);
  const pct = h('span', { class: 'download-pct num' }, '0');
  const fill = h('div', { class: 'bar-fill' });
  const bar = h('div', {
    class: 'download-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
    'aria-valuenow': '0', 'aria-labelledby': 'download-title',
  }, fill);
  const status = h('p', { id: 'download-status', class: 'download-status', 'aria-live': 'polite' });
  const detail = h('p', { class: 'meta download-detail num' });
  const retry = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Riprova');
  const action = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Annulla');
  const note = h('p', { class: 'meta download-note' },
    'Ogni file viene riletto e controllato prima di arrivarti: se fosse incompleto o corrotto, non lo ricevi.');
  const dialog = h('div', {
    class: 'dialog download-dialog', role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': 'download-title', 'aria-describedby': 'download-status', tabindex: -1,
  },
  kicker, title, steps,
  h('div', { class: 'download-figure' }, pct, h('span', { class: 'download-pct-unit' }, '%')),
  bar, status, detail,
  h('div', { class: 'dialog-foot' }, note, h('div', { class: 'download-actions' }, retry, action)));
  const scrim = h('div', { class: 'scrim download-scrim' }, dialog);
  scrim.hidden = true;
  host.appendChild(scrim);

  let controller: AbortController | null = null;
  let mode: 'running' | 'done' | 'error' = 'running';
  let last: { model: Model; fmt: ExportFormat } | null = null;
  let closeTimer = 0;
  let lastFocus: Element | null = null;

  const close = () => {
    window.clearTimeout(closeTimer);
    controller?.abort();
    controller = null;
    scrim.hidden = true;
    if (lastFocus instanceof HTMLElement) lastFocus.focus();
  };

  const setMode = (m: typeof mode) => {
    mode = m;
    dialog.classList.toggle('is-done', m === 'done');
    dialog.classList.toggle('is-error', m === 'error');
    prop(action, 'textContent', m === 'running' ? 'Annulla' : 'Chiudi');
    prop(retry, 'hidden', m !== 'error');
  };

  const show = (p: DownloadProgress) => {
    const value = Math.round(p.progress * 100);
    prop(pct, 'textContent', String(value));
    fill.style.width = `${(p.progress * 100).toFixed(1)}%`;
    attr(bar, 'aria-valuenow', String(value));
    prop(title, 'textContent', p.filename);
    const step = stepOf(p);
    marks.forEach((li, i) => {
      li.classList.toggle('is-done', i < step);
      li.classList.toggle('is-current', i === step);
      const mark = li.firstElementChild as HTMLElement;
      if (i < step && !mark.firstChild) mark.replaceChildren(icon('check', 12));
      if (i >= step && mark.firstChild) mark.replaceChildren();
    });
    const left = formatEta(p.eta);
    if (p.phase === 'done') {
      prop(status, 'textContent', `Scaricato e verificato: ${p.filename}`);
      prop(detail, 'textContent', p.total ? formatBytes(p.total) : '');
    } else if (p.phase === 'download') {
      prop(status, 'textContent', ['Scarico il file', left].filter(Boolean).join(' · '));
      prop(detail, 'textContent', p.total ? `${formatBytes(p.received)} di ${formatBytes(p.total)}` : '');
    } else {
      prop(status, 'textContent', [p.message, left].filter(Boolean).join(' · '));
      prop(detail, 'textContent', '');
    }
  };

  const start = async (model: Model, fmt: ExportFormat) => {
    if (controller) return; // one at a time: the popup is open
    last = { model, fmt };
    window.clearTimeout(closeTimer);
    if (scrim.hidden) lastFocus = document.activeElement;
    prop(kicker, 'textContent', `Esporta · ${LABEL[fmt]}`);
    setMode('running');
    show({ fmt, filename: exportName(model, fmt), phase: 'prepare', stage: 'load', message: 'Avvio',
      progress: 0, received: 0, total: null, eta: null, error: null });
    scrim.hidden = false;
    dialog.focus();
    const ctrl = new AbortController();
    controller = ctrl;
    try {
      await downloadModel(model.id, fmt, exportName(model, fmt), show, ctrl.signal);
      setMode('done');
      closeTimer = window.setTimeout(() => { if (mode === 'done') close(); }, CLOSE_AFTER_MS);
    } catch (e) {
      if (ctrl.signal.aborted) return; // cancelled: the popup is closed already
      setMode('error');
      prop(status, 'textContent', e instanceof ApiError || e instanceof Error ? e.message : String(e));
      prop(detail, 'textContent', 'Il file non è stato salvato.');
    } finally {
      if (controller === ctrl) controller = null;
    }
  };

  action.addEventListener('click', close); // Annulla while it runs, Chiudi after
  retry.addEventListener('click', () => { if (last) void start(last.model, last.fmt); });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    if (e.key === 'Tab') { // keep the focus in the popup
      const buttons = [retry, action].filter((b) => !b.hidden);
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      buttons[(i + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
    }
  });
  app.downloader = (model, fmt) => void start(model, fmt);
}
