/**
 * The guided tour. The screen dims except for the part of the interface a step explains, framed
 * with crop marks like the viewport; beside it a card with the step's title and text, the step
 * number in Roman numerals, Indietro and Avanti. ← and → move, Esc leaves, Tab stays in the
 * card. Each step first brings its panel forward (a bottom sheet on narrow screens); when the
 * tour ends, panels, sheets and edit mode go back as they were.
 */
import type { App, AppState, Panel, Sheet } from '../app';
import { h, prop, reducedMotion } from '../lib/dom';
import { icon } from '../lib/icons';
import { TOUR_STEPS, intersect, placeCard, roman, union, type Rect } from '../lib/tour';

const NARROW = 1024; // below this width the panels are bottom sheets (see app.css)
const PAD = 8; // space between the highlight and what it frames

export function mountTour(host: HTMLElement, app: App): void {
  const spot = h('div', { class: 'tour-spot', 'aria-hidden': 'true' });
  const kicker = h('p', { class: 'kicker tour-kicker' });
  const title = h('h2', { class: 'tour-title', id: 'tour-title' });
  const text = h('p', { class: 'tour-text', id: 'tour-text' });
  const marks = TOUR_STEPS.map(() => h('span'));
  const progress = h('div', { class: 'tour-progress', 'aria-hidden': 'true' }, marks);
  const back = h('button', { class: 'btn btn-ghost tour-back', type: 'button' }, 'Indietro');
  const next = h('button', { class: 'btn btn-primary tour-next', type: 'button' });
  const close = h('button', { class: 'icon-btn tour-close', type: 'button', 'aria-label': 'Esci dalla guida', title: 'Esci dalla guida · Esc' }, icon('close'));
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-text' },
    h('div', { class: 'tour-head' }, kicker, close),
    h('div', { class: 'tour-body', 'aria-live': 'polite' }, title, text),
    progress,
    h('div', { class: 'tour-actions' }, back, next));
  // the scrim takes every click outside the card: the tour is modal
  const root = h('div', { class: 'tour' }, h('div', { class: 'tour-scrim' }), spot, card);
  root.hidden = true;
  host.append(root);

  back.addEventListener('click', () => app.tourStep((app.state.tour ?? 0) - 1));
  next.addEventListener('click', () => app.tourStep((app.state.tour ?? 0) + 1));
  close.addEventListener('click', () => app.endTour());

  // -- where things are ------------------------------------------------------------------------
  const narrow = () => window.innerWidth < NARROW;
  const rectOf = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  /** The part of an element that can be seen: cut by the panels it scrolls in, and the window. */
  const visibleRect = (el: HTMLElement): Rect | null => {
    let v: Rect | null = rectOf(el);
    for (let a = el.parentElement; a && v; a = a.parentElement) {
      const o = getComputedStyle(a);
      if (/auto|scroll|hidden|clip/.test(o.overflowX + o.overflowY)) v = intersect(v, rectOf(a));
    }
    return v && intersect(v, { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
  };
  const shown = (el: HTMLElement) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  const measure = () => {
    const i = app.state.tour;
    if (i === null) return;
    const step = TOUR_STEPS[i];
    const view = { w: window.innerWidth, h: window.innerHeight };
    const rects = (step.targets ?? [])
      .map((sel) => document.querySelector<HTMLElement>(sel))
      .filter((el): el is HTMLElement => !!el && shown(el))
      .map(visibleRect)
      .filter((r): r is Rect => !!r);
    const u = union(rects);
    // a step whose part is not on screen (e.g. the print panel while sculpting) talks from the middle
    const t = u && {
      x: Math.max(0, u.x - PAD), y: Math.max(0, u.y - PAD),
      w: Math.min(view.w, u.x + u.w + PAD) - Math.max(0, u.x - PAD),
      h: Math.min(view.h, u.y + u.h + PAD) - Math.max(0, u.y - PAD),
    };
    spot.classList.toggle('is-empty', !t);
    const s = t ?? { x: view.w / 2, y: view.h / 2, w: 0, h: 0 };
    spot.style.transform = `translate(${s.x}px, ${s.y}px)`;
    spot.style.width = `${s.w}px`;
    spot.style.height = `${s.h}px`;
    const n = narrow();
    const p = placeCard(t, { w: card.offsetWidth, h: card.offsetHeight }, view, {
      narrow: n,
      margin: n ? 12 : 16,
      top: document.querySelector('.topbar')?.getBoundingClientRect().height ?? 0,
      bottom: n ? document.querySelector('.tabbar')?.getBoundingClientRect().height ?? 0 : 0,
    });
    card.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    prop(card.dataset, 'side', p.side); // (measured on every frame while it follows: write a change only)
    // opening: the first placement is not animated (the card would fly in from the corner)
    if (root.classList.contains('is-placing')) requestAnimationFrame(() => root.classList.remove('is-placing'));
  };

  // Follow the highlight while a sheet slides in or a panel scrolls smoothly, then rest.
  let raf = 0, until = 0;
  const loop = () => {
    measure();
    raf = performance.now() < until ? requestAnimationFrame(loop) : 0;
  };
  const track = (ms = 700) => {
    until = performance.now() + ms;
    if (!raf) raf = requestAnimationFrame(loop);
  };
  window.addEventListener('resize', () => { if (!root.hidden) track(150); });
  document.addEventListener('scroll', () => { if (!root.hidden) track(150); }, true);

  // -- steps ------------------------------------------------------------------------------------
  const show = (i: number) => {
    const step = TOUR_STEPS[i];
    const n = narrow();
    // the print panel is replaced by the sculpting tools in edit mode: leave it (restored at the end)
    if (step.panel === 'print' && app.state.edit) app.setEdit(false, { silent: true });
    if (step.panel === 'create') app.setPanel('create');
    if (n) app.store.set({ sheet: step.panel === 'create' ? 'create' : step.panel === 'print' ? 'print' : null });
    const first = step.targets?.[0] ? document.querySelector<HTMLElement>(step.targets[0]) : null;
    if (first && shown(first)) first.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });

    kicker.textContent = `Guida · ${roman(i + 1)} / ${roman(TOUR_STEPS.length)}`;
    title.textContent = step.title;
    text.textContent = step.text;
    marks.forEach((m, k) => {
      m.classList.toggle('is-done', k < i);
      m.classList.toggle('is-current', k === i);
    });
    back.hidden = i === 0;
    next.textContent = i === 0 ? 'Inizia' : i === TOUR_STEPS.length - 1 ? 'Fine' : 'Avanti';
    card.dataset.step = step.id;
    track();
    next.focus({ preventScroll: true });
  };

  let before: { panel: Panel; sheet: Sheet; edit: boolean } | null = null;
  let lastFocus: Element | null = null;
  const open = (prev: AppState) => {
    before = { panel: prev.panel, sheet: prev.sheet, edit: prev.edit };
    lastFocus = document.activeElement;
    root.classList.add('is-placing');
    root.hidden = false;
  };
  const shut = () => {
    root.hidden = true;
    cancelAnimationFrame(raf);
    raf = 0;
    const b = before;
    before = null;
    if (b) {
      if (b.edit && !app.state.edit) app.setEdit(true); // (it closes the sheets: restore them after)
      app.setPanel(b.panel);
      app.store.set({ sheet: b.sheet });
    }
    if (lastFocus instanceof HTMLElement && lastFocus.isConnected) lastFocus.focus();
  };

  // the buttons that open the tour wear a gold dot until it has been opened once
  const syncNew = (s: AppState) => document.querySelectorAll('.tour-start').forEach((b) => b.classList.toggle('is-new', !s.tourSeen));
  syncNew(app.state);

  app.store.subscribe((s, prev) => {
    if (s.tourSeen !== prev.tourSeen) syncNew(s);
    if (s.tour === prev.tour) return;
    if (s.tour === null) return shut();
    if (prev.tour === null) open(prev);
    show(s.tour);
  });

  document.addEventListener('keydown', (e) => {
    const i = app.state.tour;
    if (i === null) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      app.endTour();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      app.tourStep(i + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      app.tourStep(i - 1);
    } else if (e.key === 'Tab') {
      e.preventDefault(); // focus stays in the card
      const items = [close, back, next].filter((b) => !b.hidden);
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    }
  });
}
