/** Polite toasts in one live region: short, dismissible, with an optional action. */
import { h } from '../lib/dom';
import { icon } from '../lib/icons';

type Tone = 'neutral' | 'positive' | 'negative';

let region: HTMLElement | null = null;

export function mountToasts(host: HTMLElement): void {
  region = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
  host.appendChild(region);
}

export function toast(
  message: string,
  opts: { tone?: Tone; action?: { label: string; run: () => void }; timeout?: number } = {},
): void {
  if (!region) return;
  const tone = opts.tone ?? 'neutral';
  const close = () => {
    el.classList.add('is-leaving');
    window.setTimeout(() => el.remove(), 160);
  };
  const el = h(
    'div',
    { class: `toast toast-${tone}` },
    tone === 'negative' ? icon('alert') : tone === 'positive' ? icon('check') : null,
    h('span', { class: 'toast-text' }, message),
    opts.action
      ? h('button', { class: 'toast-action', type: 'button', onclick: () => { opts.action!.run(); close(); } }, opts.action.label)
      : null,
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Chiudi avviso', onclick: close }, icon('close', 14)),
  );
  region.appendChild(el);
  while (region.children.length > 3) region.firstElementChild?.remove();
  window.setTimeout(close, opts.timeout ?? (tone === 'negative' ? 7000 : 4200));
}
