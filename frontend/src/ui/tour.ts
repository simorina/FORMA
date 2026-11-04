/**
 * The guided tour. The screen dims except for the part of the interface a step explains, framed
 * with crop marks like the viewport; beside it a card with the step's title and text, the step
 * number in Roman numerals, Indietro and Avanti. ← and → move, Esc leaves, Tab stays in the
 * card. Each step first brings its panel forward (a bottom sheet on narrow screens); when the
 * tour ends, panels, sheets and edit mode go back as they were.
 *
 * In motion (lib/motion, styles/overlays.css): the highlight morphs from part to part and its
 * crop marks breathe a few times when it lands; the title and the text turn like a page (forward
 * one way, back the other); each segment of the progress is drawn as it fills. On leaving, the
 * card and the dimmed screen fade on ghost copies while the tour itself is hidden at once.
 */
import type { App, AppState, Panel, Sheet } from '../app';
import { h, prop, reducedMotion } from '../lib/dom';
import { icon } from '../lib/icons';
import { DUR, EASE, canAnimate, ghostOut, play } from '../lib/motion';
import { TOUR_STEPS, intersect, placeCard, roman, union, type Rect } from '../lib/tour';

const NARROW = 1024; // below this width the panels are bottom sheets (see app.css)
const PAD = 8; // space between the highlight and what it frames
/** The crop marks' corners, and the way each one leans out when it breathes. */
const CORNERS = [['tl', -1, -1], ['tr', 1, -1], ['bl', -1, 1], ['br', 1, 1]] as const;

export function mountTour(host: HTMLElement, app: App): void {
  const crops = CORNERS.map(([c]) => h('i', { class: `tour-crop tour-crop-${c}` }));
  const spot = h('div', { class: 'tour-spot', 'aria-hidden': 'true' }, crops);
  const kicker = h('p', { class: 'kicker tour-kicker' });
  const title = h('h2', { class: 'tour-title', id: 'tour-title' });
  const text = h('p', { class: 'tour-text', id: 'tour-text' });
  const inks = TOUR_STEPS.map(() => h('i', { class: 'tour-ink' }));
  const marks = inks.map((ink) => h('span', null, ink));
  const progress = h('div', { class: 'tour-progress', 'aria-hidden': 'true' }, marks);
  const back = h('button', { class: 'btn btn-ghost tour-back', type: 'button' }, 'Indietro');
  const next = h('button', { class: 'btn btn-primary tour-next', type: 'button' });
  const close = h('button', { class: 'icon-btn tour-close', type: 'button', 'aria-label': 'Esci dalla guida', title: 'Esci dalla guida · Esc' }, icon('close'));
  const body = h('div', { class: 'tour-body', 'aria-live': 'polite' }, title, text);
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-text' },
    h('div', { class: 'tour-head' }, kicker, close),
    body,
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
    // (with nothing to frame, a dot under the card in the middle: the dimmed screen can still fade out)
    const s = t ?? { x: view.w / 2 - 0.5, y: view.h / 2 - 0.5, w: 1, h: 1 };
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

  // -- motion -----------------------------------------------------------------------------------
  /** The words of the step being left, on a copy that slides away under the column's edge. */
  let echo: HTMLElement | null = null;
  const turnOut = (dir: number) => {
    echo?.remove();
    echo = null;
    if (!canAnimate()) return;
    const lines = [title, text];
    // (from where the lines are now: a quick reader may leave a step while it still comes in)
    const now = lines.map((el) => getComputedStyle(el));
    const copies = lines.map((el) => {
      const c = el.cloneNode(true) as HTMLElement;
      c.removeAttribute('id');
      return c;
    });
    const layer = h('div', { class: 'tour-echo', 'aria-hidden': 'true' }, copies);
    body.append(layer);
    echo = layer;
    copies.forEach((c, k) => void play(c, [
      { opacity: now[k].opacity, transform: now[k].transform },
      { opacity: 0, transform: `translateX(${-dir * 28}px)` },
    ], { delay: k * 30, duration: DUR.short, easing: EASE.in, fill: 'both' }));
    window.setTimeout(() => {
      layer.remove();
      if (echo === layer) echo = null;
    }, DUR.short + 80);
  };
  /** The new step's words come in from the side the reader is going to (from below on opening). */
  const turnIn = (dir: number) => {
    const from = dir ? `translateX(${dir * 28}px)` : 'translateY(10px)';
    [title, text].forEach((el, k) => void play(el, [{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }], {
      delay: (dir ? 110 : 90) + k * 60, duration: DUR.base, easing: EASE.out, fill: 'backwards',
    }));
  };
  /** A segment of the progress is drawn as the reader reaches it, and drawn back on Indietro. */
  const drawProgress = (i: number, from: number | null) => {
    if (from === null || i > from) {
      void play(inks[i], [{ transform: 'scaleX(0)' }, { transform: 'none' }], {
        delay: from === null ? 220 : 80, duration: DUR.slow, easing: EASE.out, fill: 'backwards',
      });
    } else if (i < from) {
      void play(inks[from], [{ transform: 'none' }, { transform: 'scaleX(0)' }], { duration: DUR.base, easing: EASE.inOut });
    }
  };
  /** The crop marks close in on opening, then breathe a few times where the highlight lands. */
  const breathe = (opening: boolean) => {
    if (!canAnimate()) return;
    crops.forEach((c, k) => {
      const [, x, y] = CORNERS[k];
      for (const a of c.getAnimations()) a.cancel();
      if (opening) {
        void play(c, [{ opacity: 0, transform: `translate(${x * 14}px, ${y * 14}px)` }, { opacity: 1, transform: 'none' }], {
          duration: DUR.slow, easing: EASE.out, fill: 'backwards',
        });
      }
      void play(c, [{ opacity: 1, transform: 'none' }, { opacity: 0.45, transform: `translate(${x * 3}px, ${y * 3}px)` }], {
        delay: opening ? DUR.slow : 560, duration: 1500, easing: EASE.inOut, iterations: 4, direction: 'alternate',
      });
    });
  };

  // -- steps ------------------------------------------------------------------------------------
  const show = (i: number, from: number | null) => {
    const step = TOUR_STEPS[i];
    const n = narrow();
    // the print panel is replaced by the sculpting tools in edit mode: leave it (restored at the end)
    if (step.panel === 'print' && app.state.edit) app.setEdit(false, { silent: true });
    if (step.panel === 'create') app.setPanel('create');
    if (n) app.store.set({ sheet: step.panel === 'create' ? 'create' : step.panel === 'print' ? 'print' : null });
    const first = step.targets?.[0] ? document.querySelector<HTMLElement>(step.targets[0]) : null;
    if (first && shown(first)) first.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });

    const dir = from === null ? 0 : Math.sign(i - from);
    if (dir) turnOut(dir);
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
    turnIn(dir);
    drawProgress(i, from);
    breathe(from === null);
  };

  let before: { panel: Panel; sheet: Sheet; edit: boolean } | null = null;
  let lastFocus: Element | null = null;
  const open = (prev: AppState) => {
    before = { panel: prev.panel, sheet: prev.sheet, edit: prev.edit };
    lastFocus = document.activeElement;
    root.classList.add('is-placing');
    root.hidden = false;
    // (app.css fades the card in; it also rises a little, on `translate`: its place is the transform)
    void play(card, [{ translate: '0 14px' }, { translate: '0 0' }], { duration: DUR.base, easing: EASE.out });
  };
  const shut = () => {
    // the card and the dimmed screen leave on copies: the tour itself is hidden at once
    ghostOut(spot, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR.short, easing: EASE.out });
    ghostOut(card, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px)' }], { duration: DUR.short });
    echo?.remove();
    echo = null;
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
    show(s.tour, prev.tour);
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
