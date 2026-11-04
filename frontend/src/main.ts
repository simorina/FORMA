import '@fontsource-variable/inter';
import './styles/app.css';
import { App, type AppState } from './app';
import { h } from './lib/dom';
import { filamentByKey } from './lib/filaments';
import { icon } from './lib/icons';
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
