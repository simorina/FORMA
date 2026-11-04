/**
 * Overlays inside the viewport: the honest first run, the generation stages with the
 * intermediate image and Retry, the view tools, the sculpt hint, and fatal states.
 */
import type { App, AppState } from '../app';
import type { Stage } from '../lib/api';
import { h, render } from '../lib/dom';
import { num } from '../lib/format';
import { icon } from '../lib/icons';

const STAGE_ICON: Record<Stage['status'], string> = {
  pending: '', active: 'spinner', done: 'check', skipped: 'check', error: 'alert',
};

export function mountStage(root: HTMLElement, app: App): void {
  const empty = h('div', { class: 'stage-empty' });
  const progress = h('div', { class: 'progress', role: 'status', 'aria-live': 'polite' });
  const fatal = h('div', { class: 'stage-fatal', role: 'alert' });
  const hint = h('p', { class: 'sculpt-hint' },
    'Trascina sul modello per scolpire · sul vuoto, o con Alt, per ruotare');

  const fitBtn = h('button', { class: 'icon-btn tool-btn', type: 'button', 'aria-label': 'Inquadra il modello (F)', title: 'Inquadra · F', onclick: () => app.viewer?.fit() }, icon('fit'));
  const rotateBtn = h('button', { class: 'icon-btn tool-btn', type: 'button', 'aria-label': 'Rotazione automatica (Spazio)', title: 'Rotazione automatica · Spazio', onclick: () => app.toggleAutoRotate() }, icon('rotate'));
  const tools = h('div', { class: 'view-tools' }, fitBtn, rotateBtn);
  root.append(empty, progress, fatal, hint, tools);

  const card = {
    figure: h('figure', { class: 'progress-image' }),
    img: h('img', { alt: 'Immagine di partenza generata dal prompt', width: 104, height: 104 }),
    stages: h('ol', { class: 'stages' }),
    message: h('p', { class: 'progress-message' }),
    bar: h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Avanzamento', 'aria-valuemin': 0, 'aria-valuemax': 100 }),
    fill: h('span', { class: 'bar-fill' }),
    value: h('span', { class: 'bar-value num' }),
    actions: h('div', { class: 'progress-actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => app.retry() }, 'Riprova'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => app.dismissJob() }, 'Chiudi')),
  };
  card.figure.append(card.img, h('figcaption', { class: 'meta' }, 'Immagine di partenza'));
  card.bar.append(card.fill, card.value);
  progress.append(card.figure, h('div', { class: 'progress-body' }, card.stages, card.message, card.bar, card.actions));

  let prev: AppState | null = null;
  const update = (s: AppState) => {
    const gen = app.generating(s);
    root.classList.toggle('is-generating', gen);
    root.classList.toggle('is-editing', s.edit);
    rotateBtn.setAttribute('aria-pressed', String(s.autoRotate));
    hint.hidden = !s.edit;
    tools.hidden = !!s.viewerError;

    // fatal: the backend is down, or WebGL is missing
    const fatalText = s.offline ?? s.viewerError;
    fatal.hidden = !fatalText;
    if (fatalText && (!prev || (prev.offline ?? prev.viewerError) !== fatalText)) {
      render(fatal, h('h2', { class: 'stage-title' }, s.offline ? 'Il server non risponde' : 'Vista 3D non disponibile'),
        h('p', null, fatalText),
        s.offline ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => location.reload() }, 'Riprova') : null);
    }

    // first run: nothing on the bed and nothing cooking
    const showEmpty = !s.current && !s.job && !fatalText && s.historyLoaded;
    empty.hidden = !showEmpty;
    if (showEmpty && (!prev || prev.providers !== s.providers || prev.provider !== s.provider || prev.historyLoaded !== s.historyLoaded || prev.printer !== s.printer)) {
      render(empty,
        h('h2', { class: 'stage-title' }, 'Il piatto è vuoto'),
        h('p', null, 'Descrivi un oggetto o carica una foto. Forma lo modella in 3D, lo ripara e lo prepara in millimetri per la tua stampante.'),
        h('p', { class: 'meta' }, honestNote(s)));
    }

    // generation stages: built once, updated in place (polling must not recreate the image)
    const job = s.job;
    progress.hidden = !job;
    if (job && (!prev || prev.job !== job)) {
      const failed = job.status === 'error';
      card.figure.hidden = !job.image_url;
      if (job.image_url && card.img.getAttribute('src') !== job.image_url) card.img.src = job.image_url;
      const stagesKey = job.stages.map((st) => `${st.key}:${st.status}`).join('|');
      if (card.stages.dataset.key !== stagesKey) {
        card.stages.dataset.key = stagesKey;
        render(card.stages, job.stages.map((st) => h('li', { class: `stage is-${st.status}` },
          h('span', { class: 'stage-mark' }, STAGE_ICON[st.status] ? icon(STAGE_ICON[st.status], 12) : ''),
          h('span', null, st.label))));
      }
      card.message.className = failed ? 'progress-message is-error' : 'progress-message';
      card.message.textContent = failed ? (job.error ?? 'Generazione non riuscita.') : job.message;
      card.bar.hidden = failed;
      card.actions.hidden = !failed;
      const pct = Math.round(job.progress * 100);
      card.bar.setAttribute('aria-valuenow', String(pct));
      card.fill.style.width = `${(job.progress * 100).toFixed(1)}%`;
      card.value.textContent = `${num(pct)}%`;
    }
    prev = s;
  };
  app.store.subscribe(update);
  update(app.state);
}

/** What the first generation will really be like with this provider and token. */
function honestNote(s: AppState): string {
  const info = s.providers?.providers.find((p) => p.name === s.provider);
  if (!s.providers || !info) return '';
  if (info.name === 'procedural') {
    return 'Modalità offline: forme parametriche scelte dalle parole del prompt (vaso, tazza, pedone, ingranaggio…). Utile per provare tutto senza rete.';
  }
  if (info.name === 'local') return 'Sulla tua GPU: il primo avvio scarica i pesi del modello e può richiedere qualche minuto.';
  return s.providers.hf_token
    ? 'Con il tuo token Hugging Face: di solito un modello è pronto in uno o due minuti, code permettendo.'
    : 'Senza HF_TOKEN si usa la quota gratuita degli Space di Hugging Face: può esserci coda, e la quota può finire. Aggiungi il token nel file .env.';
}
