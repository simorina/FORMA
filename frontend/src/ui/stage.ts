/**
 * Overlays inside the viewport: the honest first run, the preview image to approve, the
 * generation stages with the intermediate image and Retry, the view tools (fit, auto-rotate,
 * overhang map, section), the sculpt hint, and fatal states.
 */
import type { App, AppState } from '../app';
import type { Stage } from '../lib/api';
import { h, render } from '../lib/dom';
import { mm, num } from '../lib/format';
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
  const overBtn = h('button', { class: 'icon-btn tool-btn', type: 'button', 'aria-label': 'Mostra gli sbalzi (O)', title: 'Mostra gli sbalzi · O', onclick: () => app.toggleOverhang() }, icon('overhang'));
  const sectionBtn = h('button', {
    class: 'icon-btn tool-btn', type: 'button', 'aria-label': 'Vista in sezione (C)', title: 'Sezione · C',
    onclick: () => app.setSection(app.state.section === null ? 0.5 : null),
  }, icon('section'));
  const tools = h('div', { class: 'view-tools' }, fitBtn, rotateBtn, overBtn, sectionBtn);

  // bottom-left: the overhang legend and the section slider
  const legend = h('p', { class: 'chip legend' });
  const sectionRange = h('input', { type: 'range', class: 'range', min: 2, max: 100, step: 1, 'aria-label': 'Altezza del taglio' }) as HTMLInputElement;
  const sectionValue = h('output', { class: 'num value' });
  sectionRange.addEventListener('input', () => app.setSection(Number(sectionRange.value) / 100));
  const sectionPanel = h('div', { class: 'chip section-panel' },
    h('span', { class: 'label' }, 'Sezione'), sectionRange, sectionValue);
  const corner = h('div', { class: 'stage-corner' }, legend, sectionPanel);

  // the preview image to approve before the 3D step
  const draftImg = h('img', { class: 'draft-image', alt: 'Immagine di anteprima generata dal prompt', width: 280, height: 280 });
  const draftWait = h('div', { class: 'draft-wait', 'aria-hidden': 'true' }, icon('spinner', 20));
  const draftTitle = h('h2', { class: 'stage-title' });
  const draftText = h('p', { class: 'draft-text' });
  const draftMeta = h('p', { class: 'meta' });
  const approve = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => app.approveDraft() }, 'Crea il modello 3D');
  const another = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => app.preview() }, 'Un’altra immagine');
  const dismiss = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => app.cancelDraft() }, 'Annulla');
  const draftCard = h('div', { class: 'draft', role: 'dialog', 'aria-label': 'Anteprima dell’immagine' },
    h('div', { class: 'draft-media' }, draftImg, draftWait),
    h('div', { class: 'draft-body' }, draftTitle, draftText, draftMeta, h('div', { class: 'draft-actions' }, approve, another, dismiss)));

  root.append(empty, progress, draftCard, fatal, hint, tools, corner);

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
    const busyStage = app.generating(s) || s.busy === 'upload';
    root.classList.toggle('is-generating', busyStage);
    root.classList.toggle('is-editing', s.edit);
    rotateBtn.setAttribute('aria-pressed', String(s.autoRotate));
    overBtn.setAttribute('aria-pressed', String(s.overhang));
    sectionBtn.setAttribute('aria-pressed', String(s.section !== null));
    overBtn.disabled = sectionBtn.disabled = !s.current;
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

    // the preview image: while it is made, then waiting for approval
    const showDraft = s.drafting || !!s.draft;
    draftCard.hidden = !showDraft;
    if (showDraft) {
      draftWait.hidden = !s.drafting;
      draftImg.hidden = s.drafting || !s.draft;
      if (s.draft && draftImg.getAttribute('src') !== s.draft.url) draftImg.src = s.draft.url;
      draftTitle.textContent = s.drafting ? 'Creo l’immagine di partenza…' : 'Ti convince questa forma?';
      draftText.textContent = s.drafting
        ? 'Prima un’immagine, veloce; il modello 3D, che usa la GPU, parte solo quando la approvi.'
        : 'Il modello 3D seguirà questa immagine. Se non è l’oggetto che volevi, chiedine un’altra: costa poco.';
      draftMeta.textContent = s.draft && !s.drafting ? `“${s.draft.prompt}”` : '';
      approve.disabled = s.drafting || !s.draft;
      another.disabled = s.drafting;
    }

    // first run: nothing on the bed and nothing cooking
    const showEmpty = !s.current && !s.job && !fatalText && s.historyLoaded && !showDraft && s.busy !== 'upload';
    empty.hidden = !showEmpty;
    if (showEmpty && (!prev || prev.providers !== s.providers || prev.provider !== s.provider || prev.historyLoaded !== s.historyLoaded || prev.printer !== s.printer)) {
      render(empty,
        h('h2', { class: 'stage-title' }, 'Il piatto è vuoto'),
        h('p', null, 'Descrivi un oggetto, carica una foto o una mesh da riparare. Forma lo modella in 3D, lo ripara e lo prepara in millimetri per la tua stampante.'),
        h('p', { class: 'meta' }, honestNote(s)));
    }

    // overhang legend and section slider
    const over = s.current?.report.overhang_pct ?? 0;
    legend.hidden = !s.overhang || !s.current || s.edit;
    if (!legend.hidden) {
      legend.replaceChildren(
        h('span', { class: 'legend-dot', style: { background: app.viewer?.overhangColor() ?? '#ff4d5e' } }),
        over > 0.5
          ? `Sbalzi oltre 45° sul ${num(over)}% della superficie: lì servono supporti`
          : 'Nessuno sbalzo oltre 45°: si stampa senza supporti');
    }
    sectionPanel.hidden = s.section === null || !s.current;
    if (!sectionPanel.hidden && s.section !== null) {
      const z = (app.size(s)?.[2] ?? 0) * s.section;
      if (document.activeElement !== sectionRange) sectionRange.value = String(Math.round(s.section * 100));
      sectionValue.textContent = `${mm(z)} mm`;
    }
    corner.hidden = legend.hidden && sectionPanel.hidden;

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
