/**
 * The house's motion: one vocabulary of durations and curves, and small Web Animations helpers
 * that every module uses. The matching CSS tokens are in app.css (:root, --dur-* and --ease-*).
 *
 * The rules, so that motion never changes what the interface says or does:
 * - motion is visual only: text, `hidden`, aria-* and disabled change at once, exactly when they
 *   did before. An exit plays on a ghost copy (ghostOut), never by delaying the real hiding;
 * - animate transform, opacity, clip-path and filter (cheap), never layout properties;
 * - what can be clicked settles within ~450 ms;
 * - prefers-reduced-motion turns it all off: app.css stops CSS animations and transitions, and
 *   these helpers do nothing and resolve at once.
 */
import { reducedMotion } from './dom';

/** Durations in ms: micro (hover, press), short (small moves), base (cards, panels), slow, hero. */
export const DUR = { micro: 160, short: 260, base: 420, slow: 640, hero: 1100 } as const;

export const EASE = {
  /** entries: fast, then a long settle */
  out: 'cubic-bezier(0.16, 1, 0.3, 1)',
  /** moves from one place to another */
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  /** exits: slow start, quick end */
  in: 'cubic-bezier(0.7, 0, 0.84, 0)',
  /** a soft overshoot, for things that land (keycaps, indicators) */
  spring:
    'linear(0, 0.006, 0.025 2.8%, 0.101 6.1%, 0.539 18.9%, 0.721 25.3%, 0.849 31.5%, 0.937 38.1%, 0.968 41.8%, 0.991 45.7%, 1.006 50.1%, 1.015 55%, 1.017 63.9%, 1.001 85.9%, 1)',
} as const;

/** False under prefers-reduced-motion, and where Web Animations are missing (tests in Node). */
export function canAnimate(): boolean {
  if (typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return false;
  if (typeof matchMedia !== 'function') return false;
  return !reducedMotion();
}

/** el.animate(), or nothing under reduced motion. Resolves when the animation ends (or at once). */
export function play(el: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes, opts: KeyframeAnimationOptions = {}): Promise<void> {
  if (!canAnimate() || !el.isConnected) return Promise.resolve();
  const a = el.animate(keyframes, { duration: DUR.base, easing: EASE.out, ...opts });
  return a.finished.then(() => undefined, () => undefined);
}

/** The delays of a staggered entry: `step` ms apart, the last ones bunched after `max` items. */
export function staggerDelays(n: number, step = 40, max = 10, start = 0): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => start + Math.min(i, max) * step);
}

/** Ready-made entries; `delay` in ms. They start from the hidden state (fill: backwards). */
export const enter = {
  /** up a few pixels, out of transparency */
  rise: (el: Element, delay = 0, distance = 12, duration: number = DUR.base) =>
    play(el, [{ opacity: 0, transform: `translateY(${distance}px)` }, { opacity: 1, transform: 'none' }], { delay, duration, fill: 'backwards' }),
  fade: (el: Element, delay = 0, duration: number = DUR.short) =>
    play(el, [{ opacity: 0 }, { opacity: 1 }], { delay, duration, fill: 'backwards' }),
  /** grows from slightly smaller, landing with a soft overshoot */
  pop: (el: Element, delay = 0, duration: number = DUR.base) =>
    play(el, [{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'none' }], { delay, duration, easing: EASE.spring, fill: 'backwards' }),
  /** uncovered like a curtain going up (or from the side given) */
  wipe: (el: Element, delay = 0, from: 'bottom' | 'top' | 'left' | 'right' = 'bottom', duration: number = DUR.slow) => {
    const hidden = { bottom: 'inset(100% 0 0 0)', top: 'inset(0 0 100% 0)', left: 'inset(0 100% 0 0)', right: 'inset(0 0 0 100%)' }[from];
    return play(el, [{ clipPath: hidden }, { clipPath: 'inset(0 0 0 0)' }], { delay, duration, easing: EASE.inOut, fill: 'backwards' });
  },
};

/** The same entry for each element, one after the other. */
export function stagger(els: Iterable<Element>, entry: (el: Element, delay: number) => Promise<void>, step = 40, max = 10, start = 0): Promise<void> {
  const list = Array.from(els);
  const delays = staggerDelays(list.length, step, max, start);
  return Promise.all(list.map((el, i) => entry(el, delays[i]))).then(() => undefined);
}

/**
 * An exit played on a copy. Call it just BEFORE hiding or removing the real element: the copy
 * takes its place on top of the page (fixed, inert, aria-hidden, at the end of <body>) and plays
 * the keyframes, then goes away. Only for single overlay elements (cards, dialogs, toasts), never
 * for list items or panel content (the copy would be counted with them).
 */
export function ghostOut(el: HTMLElement, keyframes: Keyframe[], opts: KeyframeAnimationOptions = {}): void {
  if (!canAnimate() || !el.isConnected || el.hidden) return;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return;
  const copy = el.cloneNode(true) as HTMLElement;
  for (const n of [copy, ...copy.querySelectorAll('[id]')]) n.removeAttribute('id');
  copy.removeAttribute('role');
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  copy.classList.add('motion-ghost');
  Object.assign(copy.style, {
    position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
    margin: '0', transform: 'none', translate: 'none', pointerEvents: 'none', zIndex: '80',
  });
  document.body.append(copy);
  const a = copy.animate(keyframes, { duration: DUR.short, easing: EASE.in, fill: 'forwards', ...opts });
  const done = () => copy.remove();
  a.finished.then(done, done);
}

/** A press: the element sinks a little and comes back, like a key or a button being pressed. */
export function press(el: Element): Promise<void> {
  return play(el, [{ transform: 'scale(1)' }, { transform: 'scale(0.92)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: DUR.short, easing: EASE.out });
}
