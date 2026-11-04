/** Tiny DOM helpers: the UI is plain TypeScript, no framework. */

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) setProps(el, props);
  append(el, children);
  return el;
}

export function setProps(el: HTMLElement, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) {
      if (!key.startsWith('on')) el.removeAttribute(key === 'class' ? 'class' : key);
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value as Record<string, string>)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v); // custom properties need setProperty
        else (el.style as unknown as Record<string, string>)[prop] = v;
      }
    } else if (value === true) {
      el.setAttribute(key, '');
    } else if (key in el && (key === 'value' || key === 'checked' || key === 'disabled')) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Replace all children, in one mutation. */
export function render(parent: Element, ...children: Child[]): void {
  const next = document.createDocumentFragment();
  append(next, children);
  parent.replaceChildren(next);
}

// UI modules update on every store change: these write only what differs, because an equal
// write is not free (setAttribute and textContent still queue mutations and restyle, and a
// rebuilt node loses its focus, its scroll and restarts its animations).

/** Set a property (hidden, disabled, textContent, className, value…) only when it differs. */
export function prop<E extends object, K extends keyof E>(el: E, key: K, value: E[K]): void {
  if (el[key] !== value) el[key] = value;
}

/** Set an attribute only when it differs; null removes it. */
export function attr(el: Element, name: string, value: string | null): void {
  if (value === null) el.removeAttribute(name);
  else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * A part of the UI that redraws only when its inputs change: `const plan = memo();` then, on
 * each update, `plan([w, d, fits], () => render(bed, drawPlan(w, d, fits)))`. The inputs are
 * compared one by one with Object.is; the first call always draws.
 */
export function memo(): (inputs: readonly unknown[], draw: () => void) => void {
  let last: readonly unknown[] | null = null;
  return (inputs, draw) => {
    if (last && last.length === inputs.length && last.every((v, i) => Object.is(v, inputs[i]))) return;
    draw();
    last = inputs;
  };
}

/** An SVG element from markup (icons, small drawings). */
export function svg(markup: string): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as SVGSVGElement;
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T | null;

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** True when the keyboard focus is in a field that takes typing. */
export function typingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    el.isContentEditable ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes((el as HTMLInputElement).type))
  );
}
