/**
 * Top bar, as on a fashion house's site: the object's name (click to rename it) with its status
 * on the left, the wordmark in the centre, actions and the primary download on the right.
 */
import type { App, AppState } from '../app';
import { attr, h, memo, prop } from '../lib/dom';
import { icon, mark } from '../lib/icons';
import { DUR, enter } from '../lib/motion';
import { reveal } from './print';

interface Status {
  text: string;
  tone: 'neutral' | 'positive' | 'warning' | 'negative';
  busy?: boolean;
}

export function status(app: App, s: AppState): Status | null {
  if (s.busy === 'upload') return { text: 'Riparo la mesh', tone: 'neutral', busy: true };
  if (s.drafting) return { text: 'Creo l’immagine', tone: 'neutral', busy: true };
  if (s.draft) return { text: 'Immagine da approvare', tone: 'warning' };
  if (s.job && app.generating(s)) {
    return { text: s.job.status === 'queued' ? 'In coda' : 'In preparazione', tone: 'neutral', busy: true };
  }
  if (s.job?.status === 'error') return { text: 'Non riuscito', tone: 'negative' };
  const c = s.current;
  if (!c) return null;
  if (s.busy === 'apply' || s.busy === 'repair') return { text: 'Ripreparo la mesh', tone: 'neutral', busy: true };
  if (s.sculpt.steps > 0) return { text: 'Modifiche da riparare', tone: 'warning' };
  if (!app.fits(s)) return { text: 'Non entra nel piatto', tone: 'negative' };
  if (!c.report.watertight) return { text: 'Mesh aperta', tone: 'warning' };
  if (c.report.overhang_warning) return { text: 'Servono supporti', tone: 'warning' };
  return { text: 'Pronto da stampare', tone: 'positive' };
}

export function mountTopbar(root: HTMLElement, app: App): void {
  // The name is a button while the model on the bed can be renamed, an input while renaming.
  const nameText = h('span', { class: 'object-name-text' });
  const nameHint = h('span', { class: 'visually-hidden' }, ' (rinomina)');
  const nameBtn = h('button', { class: 'object-name-btn', type: 'button', title: 'Rinomina' },
    nameText, nameHint, icon('rename', 14));
  const nameInput = h('input', {
    class: 'object-name-input', type: 'text', maxlength: 120, spellcheck: 'false',
    'aria-label': 'Nome del modello (Invio per salvare, Esc per annullare)',
  }) as HTMLInputElement;
  nameInput.hidden = true;
  const name = h('h1', { class: 'object-name' }, nameBtn, nameInput);
  const pill = h('span', { class: 'pill' });

  let renaming = false;
  const startRename = () => {
    const c = app.state.current;
    if (!c || nameBtn.disabled) return;
    renaming = true;
    nameInput.value = c.title ?? app.modelTitle();
    nameBtn.hidden = true;
    nameInput.hidden = false;
    pill.classList.add('is-hidden-renaming');
    nameInput.focus();
    nameInput.select();
  };
  const endRename = (save: boolean) => {
    if (!renaming) return;
    renaming = false;
    const c = app.state.current;
    nameInput.hidden = true;
    nameBtn.hidden = false;
    pill.classList.remove('is-hidden-renaming');
    if (save && c) void app.rename(c, nameInput.value);
    nameBtn.focus();
  };
  nameBtn.addEventListener('click', startRename);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); endRename(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endRename(false); }
  });
  nameInput.addEventListener('blur', () => endRename(true));
  const guideBtn = h(
    'button',
    { class: 'topbar-link tour-start hide-phone', type: 'button', title: 'Come funziona: la guida in nove passi', onclick: () => app.startTour() },
    icon('guide'), h('span', null, 'Guida'),
  );
  const editBtn = h(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': 'Modifica la forma (E)', title: 'Modifica la forma · E', onclick: () => app.setEdit() },
    icon('sculpt'),
  );
  const historyBtn = h(
    'button',
    {
      class: 'icon-btn hide-phone', type: 'button', 'aria-label': 'Cronologia (H)', title: 'Cronologia · H',
      onclick: () => app.setPanel(app.state.panel === 'history' ? 'create' : 'history'),
    },
    icon('history'),
  );
  const helpBtn = h(
    'button',
    { class: 'icon-btn hide-phone', type: 'button', 'aria-label': 'Scorciatoie da tastiera (?)', title: 'Scorciatoie · ?', onclick: () => app.store.set({ shortcuts: true }) },
    icon('help'),
  );
  const download = h('button', { class: 'btn btn-primary btn-download', type: 'button' }, icon('download'), h('span', { class: 'btn-label' }, 'Scarica 3MF'));
  const rule = h('span', { class: 'vrule hide-phone', 'aria-hidden': 'true' });

  root.append(
    h('div', { class: 'brand' }, mark(26), h('span', { class: 'wordmark' }, 'Forma')),
    h('span', { class: 'vrule', 'aria-hidden': 'true' }),
    h('div', { class: 'object' }, name, pill),
    h('div', { class: 'topbar-actions' }, guideBtn, editBtn, historyBtn, helpBtn, rule, download),
  );

  // The pill is redrawn only when its words change (its dot breathes while something is cooking,
  // and a redraw would restart it). The name and the status come in from below when they
  // change, the download rises when a model arrives: on top of what is already written.
  const pillView = memo();
  let mounted = false;
  const update = (s: AppState) => {
    const text = app.modelTitle(s);
    if (nameText.textContent !== text) {
      nameText.textContent = text;
      if (mounted) void reveal(nameText, 0, DUR.slow, 70);
    }
    // only the model on the bed has a name to change, not a job or a preview in progress
    const renamable = !!s.current && !app.working(s) && !s.draft;
    prop(nameBtn, 'disabled', !renamable);
    prop(nameHint, 'hidden', !renamable);
    prop(nameBtn, 'title', renamable ? `${text} · clic per rinominare` : text);
    if (renaming && !renamable) endRename(false);
    const st = status(app, s);
    const pillWasHidden = pill.hidden;
    prop(pill, 'hidden', !st);
    if (st) {
      pillView([st.tone, st.text, !!st.busy], () => {
        pill.className = `pill pill-${st.tone}${st.busy ? ' is-busy' : ''}`;
        const words = h('span', { class: 'pill-text' }, st.text);
        pill.replaceChildren(words);
        // a pill that was there turns its colour (CSS) while the new words rise into it
        if (mounted && !pillWasHidden) void reveal(words, 0, DUR.base, 100);
      });
      if (mounted && pillWasHidden) void enter.rise(pill, 0, 6, DUR.base);
    }
    attr(editBtn, 'aria-pressed', String(s.edit));
    prop(editBtn, 'disabled', !s.current || app.generating(s));
    attr(historyBtn, 'aria-pressed', String(s.panel === 'history'));
    const c = s.current;
    const ready = !!c && s.sculpt.steps === 0; // the server's file would not have the edits
    const downloadWasHidden = download.hidden;
    prop(download, 'hidden', !c);
    prop(rule, 'hidden', !c);
    if (mounted && c && downloadWasHidden) {
      void enter.fade(rule, 0, DUR.base);
      void enter.rise(download, 60, 10, 360);
    }
    mounted = true;
    if (c) {
      attr(download, 'aria-disabled', String(!ready));
      prop(download, 'title', ready ? 'Scarica il file per lo slicer (3MF, millimetri)' : 'Ripara le modifiche prima di scaricare');
    }
  };
  download.addEventListener('click', () => {
    if (download.getAttribute('aria-disabled') !== 'true') app.download('3mf');
  });
  app.store.subscribe(update);
  update(app.state);
}
