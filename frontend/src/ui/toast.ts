/**
 * Polite toasts in one live region: short, dismissible, with an optional action.
 * A toast slides in (styles/overlays.css), a hairline at its foot runs out with its time, it
 * leaves on a ghost copy (lib/motion) and the others close up from where they were (FLIP).
 */
import { h } from '../lib/dom';
import { icon } from '../lib/icons';
import { DUR, EASE, canAnimate, ghostOut, play } from '../lib/motion';

type Tone = 'neutral' | 'positive' | 'negative';

let region: HTMLElement | null = null;

const LEAVE: Keyframe[] = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px) scale(0.98)' }];

export function mountToasts(host: HTMLElement): void {
  region = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
  host.appendChild(region);
}

/** Change the stack, then slide every toast that moved from where it was to where it is (FLIP). */
function restack(stack: HTMLElement, change: () => void): void {
  if (!canAnimate()) return change();
  const items = Array.from(stack.children) as HTMLElement[];
  const was = new Map(items.map((el) => [el, el.getBoundingClientRect().top]));
  change();
  for (const el of Array.from(stack.children) as HTMLElement[]) {
    const top = was.get(el);
    const dy = top === undefined ? 0 : top - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) void play(el, [{ translate: `0 ${dy}px` }, { translate: '0 0' }], { duration: DUR.base, easing: EASE.out });
  }
}

/** Out of the stack at once; its ghost fades where it was. */
function drop(el: HTMLElement): void {
  ghostOut(el, LEAVE, { duration: DUR.short });
  el.remove();
}

export function toast(
  message: string,
  opts: { tone?: Tone; action?: { label: string; run: () => void }; timeout?: number } = {},
): void {
  const stack = region;
  if (!stack) return;
  const tone = opts.tone ?? 'neutral';
  const life = opts.timeout ?? (tone === 'negative' ? 7000 : 4200);
  let timer = 0;
  const close = () => {
    window.clearTimeout(timer);
    if (el.isConnected) restack(stack, () => drop(el));
  };
  const el = h(
    'div',
    { class: `toast toast-${tone}`, style: { '--toast-life': `${life}ms` } },
    tone === 'negative' ? icon('alert') : tone === 'positive' ? icon('check') : null,
    h('span', { class: 'toast-text' }, message),
    opts.action
      ? h('button', { class: 'toast-action', type: 'button', onclick: () => { opts.action!.run(); close(); } }, opts.action.label)
      : null,
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Chiudi avviso', onclick: close }, icon('close', 14)),
    h('span', { class: 'toast-timer', 'aria-hidden': 'true' }),
  );
  restack(stack, () => {
    stack.appendChild(el);
    while (stack.children.length > 3) drop(stack.firstElementChild as HTMLElement);
  });
  timer = window.setTimeout(close, life);
}
