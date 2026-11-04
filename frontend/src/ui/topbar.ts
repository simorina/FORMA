/** 44px top bar: the product, the object's name with its status, actions, the primary download. */
import type { App, AppState } from '../app';
import { h } from '../lib/dom';
import { icon, mark } from '../lib/icons';

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
  const name = h('h1', { class: 'object-name' });
  const pill = h('span', { class: 'pill' });
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
  const download = h('a', { class: 'btn btn-primary btn-download', role: 'button' }, icon('download'), h('span', { class: 'btn-label' }, 'Scarica 3MF'));
  const rule = h('span', { class: 'vrule hide-phone', 'aria-hidden': 'true' });

  root.append(
    h('div', { class: 'brand' }, mark(20), h('span', { class: 'wordmark' }, 'Forma')),
    h('span', { class: 'vrule', 'aria-hidden': 'true' }),
    h('div', { class: 'object' }, name, pill),
    h('div', { class: 'topbar-actions' }, editBtn, historyBtn, helpBtn, rule, download),
  );

  const update = (s: AppState) => {
    name.textContent = app.modelTitle(s);
    name.title = name.textContent;
    const st = status(app, s);
    pill.hidden = !st;
    if (st) {
      pill.className = `pill pill-${st.tone}`;
      pill.replaceChildren(st.busy ? icon('spinner', 12) : '', st.text);
    }
    editBtn.setAttribute('aria-pressed', String(s.edit));
    editBtn.disabled = !s.current || app.generating(s);
    historyBtn.setAttribute('aria-pressed', String(s.panel === 'history'));
    const c = s.current;
    const ready = !!c && s.sculpt.steps === 0; // the server's file would not have the edits
    download.hidden = !c;
    rule.hidden = !c;
    if (c) {
      download.setAttribute('href', c.urls.export['3mf']);
      download.setAttribute('download', '');
      download.setAttribute('aria-disabled', String(!ready));
      download.title = ready ? 'Scarica il file per lo slicer (3MF, millimetri)' : 'Ripara le modifiche prima di scaricare';
    }
  };
  download.addEventListener('click', (e) => {
    if (download.getAttribute('aria-disabled') === 'true') e.preventDefault();
  });
  app.store.subscribe(update);
  update(app.state);
}
