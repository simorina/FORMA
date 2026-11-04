// Bodoni Moda with both axes (weight and optical size: hairlines get finer as the type grows),
// upright and italic; Jost for labels and text.
import '@fontsource-variable/bodoni-moda/standard.css';
import '@fontsource-variable/bodoni-moda/standard-italic.css';
import '@fontsource-variable/jost/wght.css';
import './styles/app.css';
import { App, type AppState } from './app';
import { h, typingTarget } from './lib/dom';
import { filamentByKey } from './lib/filaments';
import { icon, seal } from './lib/icons';
import { fitOnBed } from './lib/printers';
import { mountLeftPanel } from './ui/create';
import { mountRightPanel } from './ui/print';
import { mountShortcuts } from './ui/shortcuts';
import { mountStage } from './ui/stage';
import { mountToasts } from './ui/toast';
import { mountTopbar } from './ui/topbar';
import { Viewer, webglAvailable } from './viewer/viewer';

const app = new App();
const root = document.getElementById('app')!;

// -- shell: top bar, then prompt | viewport | print, and a tab bar on phones ---------------
const topbar = h('header', { class: 'topbar' });
const left = h('aside', { class: 'panel panel-left', 'aria-label': 'Crea e cronologia' });
const viewport = h('section', { class: 'viewport', 'aria-label': 'Piatto di stampa' });
const host = h('div', { class: 'viewport-host' });
viewport.append(host);
const right = h('aside', { class: 'panel panel-right', 'aria-label': 'Stampa' });
const tab = (label: string, name: string, onclick: () => void) =>
  h('button', { class: 'tabbar-btn', type: 'button', 'aria-pressed': 'false', 'data-tab': name, onclick }, icon(name === 'create' ? 'sparkle' : name === 'print' ? 'printer' : 'history'), h('span', null, label));
const sheet = (name: 'create' | 'print', panel?: 'create' | 'history') => () => {
  const s = app.state;
  const same = s.sheet === name && (!panel || s.panel === panel);
  if (panel) app.setPanel(panel);
  app.store.set({ sheet: same ? null : name });
};
const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Pannelli' },
  tab('Crea', 'create', sheet('create', 'create')),
  tab('Stampa', 'print', sheet('print')),
  tab('Cronologia', 'history', sheet('create', 'history')));
root.append(topbar, h('main', { class: 'workspace' }, left, viewport, right), tabbar);
mountToasts(viewport);

// -- the 3D viewport ---------------------------------------------------------------------------
if (webglAvailable()) {
  try {
    const viewer = new Viewer(host, {
      onSculpt: (sculpt) => app.store.set({ sculpt }),
      onShape: (shape) => app.store.set({ shape }),
      onView: (view) => app.store.set({ view }),
    });
    app.viewer = viewer;
    viewer.setPrinter(app.printer());
    viewer.setFilament(filamentByKey(app.state.filament).hex);
    viewer.setFitTest((size) => fitOnBed(size, app.printer()).fits);
    viewer.setAutoRotate(app.state.autoRotate);
  } catch (e) {
    console.error(e);
    app.store.set({ viewerError: 'La grafica 3D non si è avviata su questo browser. Puoi comunque generare e scaricare i file per la stampa.' });
  }
} else {
  app.store.set({ viewerError: 'Questo browser non supporta WebGL 2, che serve per la vista 3D. Puoi comunque generare e scaricare i file per la stampa.' });
}

mountTopbar(topbar, app);
const leftApi = mountLeftPanel(left, app);
mountRightPanel(right, app);
mountStage(viewport, app);
mountShortcuts(document.body, app, leftApi.focusPrompt);

// -- a photo or a mesh dropped anywhere in the window, or pasted ------------------------------
const take = (f: File) => {
  const kind = app.takeFile(f);
  if (kind === 'image' && window.innerWidth < 1024) app.store.set({ sheet: 'create' });
};
const dropOverlay = h('div', { class: 'drop-overlay' },
  h('div', { class: 'drop-overlay-card' },
    seal(84),
    h('p', { class: 'kicker' }, 'Atelier Forma'),
    h('p', { class: 'drop-overlay-title' }, 'Rilascia qui'),
    h('p', { class: 'meta' }, 'Una foto diventa un modello 3D, una mesh viene riparata e preparata')));
dropOverlay.hidden = true;
document.body.append(dropOverlay);
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (hasFiles(e)) dropOverlay.hidden = false;
});
// the browser would open a file dropped outside the overlay: never
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });
dropOverlay.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
dropOverlay.addEventListener('dragleave', (e) => { if (e.target === dropOverlay) dropOverlay.hidden = true; });
dropOverlay.addEventListener('drop', (e) => {
  e.preventDefault();
  dropOverlay.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) take(f);
});
// a drag cancelled outside the window leaves no dragleave behind: the next pointer move clears it
window.addEventListener('pointermove', () => { if (!dropOverlay.hidden) dropOverlay.hidden = true; });

document.addEventListener('paste', (e) => {
  const f = e.clipboardData?.files?.[0];
  if (!f) return;
  // text copied from a document often carries a picture of itself: in a text field, text wins
  if (typingTarget(e.target) && e.clipboardData?.types.includes('text/plain')) return;
  e.preventDefault();
  take(f);
});

// -- phone sheets ------------------------------------------------------------------------------
const printTab = tabbar.querySelector<HTMLElement>('[data-tab="print"]')!;
const syncSheets = (s: AppState) => {
  // in edit mode the right sheet holds the sculpting tools
  printTab.replaceChildren(icon(s.edit ? 'sculpt' : 'printer'), h('span', null, s.edit ? 'Strumenti' : 'Stampa'));
  left.classList.toggle('is-open', s.sheet === 'create');
  right.classList.toggle('is-open', s.sheet === 'print');
  document.body.classList.toggle('has-sheet', !!s.sheet);
  tabbar.querySelectorAll<HTMLElement>('.tabbar-btn').forEach((b) => {
    const t = b.dataset.tab;
    const on = t === 'print' ? s.sheet === 'print' : s.sheet === 'create' && (t === 'history') === (s.panel === 'history');
    b.setAttribute('aria-pressed', String(on));
  });
};
app.store.subscribe(syncSheets);
syncSheets(app.state);

// printer changes move the bed and re-judge the fit
app.store.subscribe((s, prev) => {
  if (s.printer !== prev.printer || s.custom !== prev.custom) app.viewer?.setPrinter(app.printer());
});

void app.init().then(() => {
  const narrow = window.innerWidth < 1024;
  if (!app.state.current && !app.state.offline) {
    if (narrow) app.store.set({ sheet: 'create' });
    else leftApi.focusPrompt();
  }
});
