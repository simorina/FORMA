// Bodoni Moda with both axes (weight and optical size: hairlines get finer as the type grows),
// upright and italic; Jost for labels and text.
import '@fontsource-variable/bodoni-moda/standard.css';
import '@fontsource-variable/bodoni-moda/standard-italic.css';
import '@fontsource-variable/jost/wght.css';
import './styles/app.css';
import { App, type AppState } from './app';
import { attr, h, memo, svg, typingTarget } from './lib/dom';
import { filamentByKey } from './lib/filaments';
import { icon, seal } from './lib/icons';
import { DUR, EASE, ghostOut, play } from './lib/motion';
import { fitOnBed } from './lib/printers';
import { mountLeftPanel } from './ui/create';
import { mountRightPanel } from './ui/print';
import { mountShortcuts } from './ui/shortcuts';
import { mountStage } from './ui/stage';
import { mountToasts } from './ui/toast';
import { mountTopbar } from './ui/topbar';
import { mountTour } from './ui/tour';
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
  tab('Cronologia', 'history', sheet('create', 'history')),
  // the guided tour (wide screens have it in the top bar)
  h('button', { class: 'tabbar-btn tour-start', type: 'button', 'aria-pressed': 'false', 'data-tab': 'guide', onclick: () => app.startTour() },
    icon('guide'), h('span', null, 'Guida')));
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
mountTour(document.body, app);

// -- a photo or a mesh dropped anywhere in the window, or pasted ------------------------------
const take = (f: File) => {
  const kind = app.takeFile(f);
  if (kind === 'image' && window.innerWidth < 1024) app.store.set({ sheet: 'create' });
};
// (it comes in with styles/overlays.css: the paper veils the page, the seal turns in, the title
// rises and the frame's dashes march; it leaves on a ghost copy, hidden at once)
const dropOverlay = h('div', { class: 'drop-overlay' },
  h('div', { class: 'drop-overlay-card' },
    seal(84),
    h('p', { class: 'kicker' }, 'Atelier Forma'),
    h('p', { class: 'drop-overlay-title' }, 'Rilascia qui'),
    h('p', { class: 'meta' }, 'Una foto diventa un modello 3D, una mesh viene riparata e preparata'),
    svg('<svg class="drop-frame" aria-hidden="true"><rect width="100%" height="100%"/></svg>')));
dropOverlay.hidden = true;
document.body.append(dropOverlay);
const hideDrop = () => {
  if (dropOverlay.hidden) return;
  ghostOut(dropOverlay, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR.short, easing: EASE.out });
  dropOverlay.hidden = true;
};
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
dropOverlay.addEventListener('dragleave', (e) => { if (e.target === dropOverlay) hideDrop(); });
dropOverlay.addEventListener('drop', (e) => {
  e.preventDefault();
  hideDrop();
  const f = e.dataTransfer?.files?.[0];
  if (f) take(f);
});
// a drag cancelled outside the window leaves no dragleave behind: the next pointer move clears it
window.addEventListener('pointermove', () => { if (!dropOverlay.hidden) hideDrop(); });

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
// the pressed tab's ink: one line that slides from tab to tab (styles/overlays.css)
const tabInk = h('span', { class: 'tabbar-ink', 'aria-hidden': 'true' });
tabbar.append(tabInk);
let inkTab: HTMLElement | null = null; // the tab the line marks
let inkShown = false;
const placeTabInk = (to: HTMLElement | null, animate: boolean) => {
  inkTab = to;
  if (!tabbar.clientWidth) return; // the bar is not on screen (wide layouts): placed when it shows
  if (!to) {
    if (inkShown && animate) void play(tabInk, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR.short, easing: EASE.out });
    tabInk.style.opacity = '0';
    inkShown = false;
    return;
  }
  const at = `translateX(${to.offsetLeft}px)`;
  tabInk.style.width = `${to.offsetWidth}px`;
  if (animate && inkShown) {
    void play(tabInk, [{ transform: tabInk.style.transform }, { transform: at }], { duration: DUR.base, easing: EASE.inOut });
  } else if (animate) {
    // from no tab: drawn out from the middle of its tab
    void play(tabInk, [{ opacity: 0, transform: `${at} scaleX(0)` }, { opacity: 1, transform: at }], { duration: DUR.base, easing: EASE.out });
  }
  tabInk.style.transform = at;
  tabInk.style.opacity = '1';
  inkShown = true;
  tabbar.classList.add('has-ink');
};
if (typeof ResizeObserver === 'function') new ResizeObserver(() => placeTabInk(inkTab, false)).observe(tabbar);
const printLabel = memo();
const syncSheets = (s: AppState) => {
  // in edit mode the right sheet holds the sculpting tools
  printLabel([s.edit], () => printTab.replaceChildren(icon(s.edit ? 'sculpt' : 'printer'), h('span', null, s.edit ? 'Strumenti' : 'Stampa')));
  left.classList.toggle('is-open', s.sheet === 'create');
  right.classList.toggle('is-open', s.sheet === 'print');
  document.body.classList.toggle('has-sheet', !!s.sheet);
  let pressed: HTMLElement | null = null;
  for (const b of tabbar.querySelectorAll<HTMLElement>('.tabbar-btn')) {
    const t = b.dataset.tab;
    const on = t === 'guide' ? s.tour !== null
      : t === 'print' ? s.sheet === 'print' : s.sheet === 'create' && (t === 'history') === (s.panel === 'history');
    attr(b, 'aria-pressed', String(on));
    if (on) pressed = b;
  }
  if (pressed !== inkTab) placeTabInk(pressed, true);
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
