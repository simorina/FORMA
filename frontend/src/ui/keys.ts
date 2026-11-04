/**
 * The keyboard's echo. Every shortcut that does something shows, at the foot of the viewport,
 * its key in a small ink keycap and what it did, read from the state after the action
 * («O · Sbalzi accesi», «3 · Vista dall’alto», «] · Raggio 9,2 mm»). The cap strikes, crop marks
 * register on the caption, the caption slides out from behind the cap; after a moment it slides
 * back and the chip goes. Quick presses stack, three at most: the newest in front at the foot,
 * the older ones shifting up and fading. A key of the same kind changes its own chip in place
 * (the cap strikes again, the words roll like a counter). The on-screen control the key stands
 * for gets a press too, as if it had been clicked.
 *
 * Visual only: the HUD is aria-hidden and inert, takes no pointer events and has no ids; it
 * moves transform and opacity only, and nothing runs while it is empty. Under reduced motion it
 * stays quiet: the controls already show what the key changed.
 */
import '../styles/keys.css';
import type { AppState } from '../app';
import { TOOLS, type Tool } from '../edit/sculpt';
import { h } from '../lib/dom';
import { mm } from '../lib/format';
import { DUR, EASE, canAnimate, play, press } from '../lib/motion';
import { sameItems } from '../lib/store';
import type { View } from '../viewer/viewer';

export type KeyAction =
  | 'generate' | 'undo' | 'redo' | 'radius' | 'prompt' | 'edit' | 'tool' | 'symmetry' | 'fit'
  | 'view' | 'wireframe' | 'overhang' | 'section' | 'rotate' | 'history' | 'help' | 'escape';

/** What the HUD shows for one key press. */
export interface KeyCue {
  /** the keycaps, modifiers first: ['⌘', 'Z'] */
  keys: string[];
  /** what the key did, in Italian, read from the state after it */
  label: string;
  /** cues about the same thing (the camera, the section…) replace each other instead of stacking */
  group: string;
  /** the on-screen controls the key stands for (selectors of existing elements): they get a press */
  controls: string[];
}

/** What the state alone does not tell. */
export interface CueFacts {
  /** the action took place: undo and redo had a step, generate had something to make */
  done?: boolean;
  /** the model's height in mm, for the height of the cut */
  height?: number | null;
}

// -- what a key did: pure, from the states before and after it --------------------------------

const NAMES: Record<string, string> = { ' ': 'Spazio', Escape: 'Esc', Enter: 'Invio', '-': '−' };

/** The keycaps of a press as the house writes them: ⌘ (or Ctrl), ⇧, then the key. */
export function keyCaps(action: KeyAction, key: string, mac: boolean): string[] {
  const mod = mac ? '⌘' : 'Ctrl';
  if (action === 'generate') return [mod, 'Invio'];
  if (action === 'undo') return [mod, 'Z'];
  if (action === 'redo') return key === 'y' || key === 'Y' ? [mod, 'Y'] : [mod, '⇧', 'Z'];
  // the other keys take no modifier: [ and ] need AltGr on Italian keyboards, ? needs Shift
  return [NAMES[key] ?? key.toUpperCase()];
}

const VIEWS: Record<View, string> = {
  front: 'Vista frontale', side: 'Vista laterale', top: 'Vista dall’alto', iso: 'Vista di tre quarti',
};
const VIEW_KEYS: Record<string, View> = { 1: 'front', 2: 'side', 3: 'top', 4: 'iso' };
const TOOL_NAMES = Object.fromEntries(TOOLS.map((t) => [t.key, t.label])) as Record<Tool, string>;

/** The controls each key stands for, found by what they already say (their shortcut, their title). */
const CONTROLS = {
  edit: '.topbar-actions [aria-label$="(E)"]',
  history: '.topbar-actions [aria-label$="(H)"], .tabbar-btn[data-tab="history"]',
  help: '.topbar-actions [aria-label$="(?)"]',
  fit: '.view-tools [aria-label$="(F)"]',
  rotate: '.view-tools [aria-label$="(Spazio)"]',
  overhang: '.view-tools [aria-label$="(O)"]',
  section: '.view-tools [aria-label$="(C)"]',
  wireframe: '.view-tools [aria-label$="(W)"]',
  tool: '.tools .tool[aria-checked="true"]',
  symmetry: '.switch-row .switch[aria-label$="asse X"]',
  radius: 'output[for="brush-radius"]',
  undo: '.undo-row .btn[title^="Annulla"]',
  redo: '.undo-row .btn[title^="Ripeti"]',
  generate: '.prompt-foot .btn',
  view: (v: View) => `.view-presets .preset[data-view="${v}"]`,
} as const;

const cut = (frac: number, height?: number | null) =>
  height && height > 0 ? `Sezione a ${mm(height * frac)} mm` : 'Vista in sezione';

/**
 * The cue for an action of the keyboard handler, or null when the key changed nothing (E with
 * no model, Esc with nothing to close: the toast or the stillness says it already).
 */
export function describe(
  action: KeyAction, key: string, before: AppState, after: AppState, facts: CueFacts = {}, mac = false,
): KeyCue | null {
  const keys = keyCaps(action, key, mac);
  const cue = (group: string, label: string, ...controls: string[]): KeyCue => ({ keys, label, group, controls });
  switch (action) {
    case 'generate':
      return facts.done ? cue('generate', after.drafting ? 'Creo l’immagine' : 'Genero il modello', CONTROLS.generate) : null;
    case 'undo':
      return facts.done ? cue('undo', 'Annullato', CONTROLS.undo) : cue('undo', 'Niente da annullare');
    case 'redo':
      return facts.done ? cue('undo', 'Ripetuto', CONTROLS.redo) : cue('undo', 'Niente da ripetere');
    case 'radius':
      return cue('radius', `Raggio ${mm(after.sculpt.radius)} mm`, CONTROLS.radius);
    case 'prompt':
      return cue('prompt', 'Scrivi il prompt');
    case 'edit':
      return after.edit === before.edit ? null : cue('edit', after.edit ? 'Modifica' : 'Fine modifica', CONTROLS.edit);
    case 'tool':
      return cue('tool', TOOL_NAMES[after.sculpt.tool], CONTROLS.tool);
    case 'symmetry':
      return cue('symmetry', after.sculpt.symmetry ? 'Simmetria X accesa' : 'Simmetria X spenta', CONTROLS.symmetry);
    case 'fit':
      return cue('camera', after.current ? 'Modello inquadrato' : 'Piatto inquadrato', CONTROLS.fit);
    case 'view': {
      const v = after.view ?? VIEW_KEYS[key];
      return v ? cue('camera', VIEWS[v], CONTROLS.view(v)) : null;
    }
    case 'wireframe':
      return cue('wireframe', after.wireframe ? 'Triangoli accesi' : 'Triangoli spenti', CONTROLS.wireframe);
    case 'overhang':
      return cue('overhang', after.overhang ? 'Sbalzi accesi' : 'Sbalzi spenti', CONTROLS.overhang);
    case 'section':
      return cue('section', after.section === null ? 'Modello intero' : cut(after.section, facts.height), CONTROLS.section);
    case 'rotate':
      return cue('rotate', after.autoRotate ? 'Rotazione accesa' : 'Rotazione spenta', CONTROLS.rotate);
    case 'history':
      return cue('panel', after.panel === 'history' ? 'Cronologia aperta' : 'Cronologia chiusa', CONTROLS.history);
    case 'help':
      return after.shortcuts === before.shortcuts ? null
        : cue('help', after.shortcuts ? 'Scorciatoie' : 'Scorciatoie chiuse', CONTROLS.help);
    case 'escape':
      if (before.sheet && !after.sheet) return cue('panel', 'Pannello chiuso');
      if (before.draft && !after.draft) return cue('generate', 'Anteprima annullata');
      if (before.edit && !after.edit) return cue('edit', 'Fine modifica', CONTROLS.edit);
      if (before.section !== null && after.section === null) return cue('section', 'Modello intero', CONTROLS.section);
      return null;
  }
}

/**
 * Where a new cue goes, given the groups of the chips on screen (newest first): into the newest
 * when it is of the same group (it changes in place), else in front, while the chips of its
 * group and those past the `max`-th leave. `leave` holds indices into `groups`.
 */
export function stackPlan(groups: readonly string[], group: string, max = 3): { inPlace: boolean; leave: number[] } {
  if (groups[0] === group) return { inPlace: true, leave: [] };
  const leave: number[] = [];
  let kept = 1; // the new chip
  groups.forEach((g, i) => {
    if (g === group || kept >= max) leave.push(i);
    else kept++;
  });
  return { inPlace: false, leave };
}

// -- the HUD ------------------------------------------------------------------------------------

const HOLD = 1400; // ms a chip stays after its last press
const MAX = 3;
const BASE = 18; // px from the foot of the viewport to the newest chip (keys.css)
const GAP = 12; // px kept clear above an overlay at the foot
/** The overlays that can sit at the foot of the viewport, which the chips rise above. */
const FOOT = '.progress, .stage-corner, .draft, .sculpt-hint, .toasts > .toast';
const CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const;

interface Chip {
  el: HTMLElement;
  body: HTMLElement;
  row: HTMLElement;
  caps: HTMLElement;
  plate: HTMLElement;
  ground: HTMLElement;
  caption: HTMLElement;
  words: HTMLElement;
  text: HTMLElement;
  marks: HTMLElement[];
  keys: string[];
  label: string;
  group: string;
  timer: number;
}

export interface KeysHud {
  /** Show a cue (nothing for null, or under reduced motion); `repeat`: the key is held down. */
  show(cue: KeyCue | null, repeat?: boolean): void;
  /** Something moved in the viewport: keep the chips clear of what sits at its foot. */
  refresh(): void;
}

/** The latest animation this module played on each element: a quick repeat replaces it. */
const playing = new WeakMap<Element, Animation>();
function again(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): void {
  playing.get(el)?.cancel();
  playing.set(el, el.animate(frames, { easing: EASE.out, ...opts }));
}

/** The cap goes down and comes back up on the house's spring (from above, when it arrives). */
function strike(caps: HTMLElement, arriving: boolean): void {
  const down = { transform: 'translateY(1.5px) scale(0.86)', offset: arriving ? 0.3 : 0.32, easing: EASE.spring };
  const from = arriving ? { opacity: 0, transform: 'translateY(-5px) scale(1.06)', easing: EASE.inOut } : { transform: 'none', easing: EASE.inOut };
  Array.from(caps.children).forEach((cap, i) => {
    // a chord lands as fingers do: the modifiers first, the key a beat later
    again(cap, [from, down, { opacity: 1, transform: 'none' }], {
      duration: arriving ? DUR.base : DUR.short, delay: i * 45, easing: 'linear', fill: 'backwards',
    });
  });
}

const capEl = (k: string) => h('span', { class: /^[a-z]{2,}$/i.test(k) ? 'keys-cap keys-cap-word' : 'keys-cap' }, k);

export function mountKeys(host: HTMLElement): KeysHud {
  const hud = h('div', { class: 'keys-hud', 'aria-hidden': 'true' });
  hud.inert = true;
  host.append(hud);
  let live: Chip[] = []; // on screen and staying, newest first
  let lift = 0;
  let frame = 0;

  const build = (c: KeyCue): Chip => {
    const caps = h('span', { class: 'keys-caps' }, c.keys.map(capEl));
    const text = h('span', { class: 'keys-text' }, c.label);
    const words = h('span', { class: 'keys-words' }, text);
    const caption = h('span', { class: 'keys-caption' }, h('span', { class: 'keys-dot' }), words);
    const ground = h('span', { class: 'keys-ground' });
    const plate = h('span', { class: 'keys-plate' }, ground, caption);
    const row = h('span', { class: 'keys-row' }, caps, h('span', { class: 'keys-tail' }, plate));
    const marks = CORNERS.map(([x, y]) => h('span', { class: `keys-mark keys-mark-${y < 0 ? 't' : 'b'}${x < 0 ? 'l' : 'r'}` }));
    const body = h('span', { class: 'keys-body' }, row, marks);
    const el = h('div', { class: 'keys-chip' }, body);
    return { el, body, row, caps, plate, ground, caption, words, text, marks, keys: c.keys, label: c.label, group: c.group, timer: 0 };
  };

  const enter = (c: Chip) => {
    play(c.body, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, offset: 0.5 }, { opacity: 1, transform: 'none' }], { duration: DUR.short });
    strike(c.caps, true);
    // crop marks close in on the chip as the key lands, hold, and fade: the caption is registered
    c.marks.forEach((m, i) => {
      const [x, y] = CORNERS[i];
      play(m, [
        { opacity: 0, transform: `translate(${x * 7}px, ${y * 7}px)`, easing: EASE.out },
        { opacity: 1, transform: 'none', offset: 0.36 },
        { opacity: 1, transform: 'none', offset: 0.62, easing: EASE.in },
        { opacity: 0, transform: 'none' },
      ], { duration: DUR.slow, delay: 70, easing: 'linear' });
    });
    // the caption slides out from behind the cap, its words a step behind
    play(c.plate, [{ transform: 'translateX(-101%)' }, { transform: 'none' }], { duration: DUR.base, delay: 110, fill: 'backwards' });
    play(c.caption, [{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.base, delay: 190, fill: 'backwards' });
  };

  /** New words in place: the old ones roll up and out, the new come up from below. */
  const roll = (c: Chip, label: string, quick: boolean) => {
    const old = c.text;
    c.text = h('span', { class: 'keys-text' }, label);
    c.words.append(c.text);
    if (quick) {
      old.remove(); // a held key ticks like a counter
      return;
    }
    old.classList.add('keys-text-old');
    void play(old, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-22px)' }], { duration: DUR.short, easing: EASE.in })
      .then(() => old.remove());
    play(c.text, [{ opacity: 0, transform: 'translateY(22px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.short });
  };

  const change = (c: Chip, next: KeyCue, repeat: boolean) => {
    const sameKeys = sameItems(c.keys, next.keys);
    if (!sameKeys || c.label !== next.label) {
      // the chip is centred: when it grows or shrinks, the cap glides and the paper stretches
      // (FLIP: measured before and after, played back with transforms)
      const w0 = c.body.offsetWidth, g0 = c.ground.offsetWidth;
      if (!sameKeys) c.caps.replaceChildren(...next.keys.map(capEl));
      if (c.label !== next.label) roll(c, next.label, repeat);
      c.keys = next.keys;
      c.label = next.label;
      const w1 = c.body.offsetWidth, g1 = c.ground.offsetWidth;
      if (w0 !== w1) again(c.row, [{ transform: `translateX(${(w1 - w0) / 2}px)` }, { transform: 'none' }], { duration: DUR.short });
      if (g0 !== g1 && g1 > 0) again(c.ground, [{ transform: `scaleX(${g0 / g1})` }, { transform: 'none' }], { duration: DUR.short });
    }
    if (!repeat || !sameKeys) strike(c.caps, false);
  };

  const slot = () => live.forEach((c, i) => c.el.style.setProperty('--keys-slot', String(i)));

  const leave = (c: Chip) => {
    window.clearTimeout(c.timer);
    c.el.classList.add('keys-leaving'); // the exit is in keys.css
    const gone = () => c.el.remove();
    c.body.addEventListener('animationend', (e) => { if (e.target === c.body) gone(); });
    window.setTimeout(gone, DUR.base + 300); // in case no animation ends (a hidden tab)
  };

  const hold = (c: Chip) => {
    window.clearTimeout(c.timer);
    c.timer = window.setTimeout(() => {
      live = live.filter((x) => x !== c);
      leave(c);
      slot();
    }, HOLD);
  };

  /** How far the stack must rise to clear what sits at the foot of the viewport (the progress card…). */
  const clearance = (): number => {
    if (!live.length) return 0;
    const vp = host.getBoundingClientRect();
    const mid = vp.left + vp.width / 2;
    const half = Math.max(...live.map((c) => c.body.offsetWidth)) / 2 + GAP;
    let need = 0;
    for (const el of host.querySelectorAll<HTMLElement>(FOOT)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right < mid - half || r.left > mid + half) continue;
      if (r.bottom < vp.bottom - vp.height * 0.3 || r.height > vp.height * 0.6) continue; // not at the foot
      need = Math.max(need, vp.bottom - r.top + GAP - BASE);
    }
    return Math.round(Math.min(Math.max(0, need), vp.height * 0.5));
  };

  const place = (instant: boolean) => {
    const next = clearance();
    if (next === lift) return;
    const from = lift;
    lift = next;
    hud.style.transform = next ? `translateY(${-next}px)` : '';
    if (!instant) again(hud, [{ transform: `translateY(${-from}px)` }, { transform: `translateY(${-next}px)` }], { duration: DUR.base });
  };

  return {
    show(c, repeat = false) {
      if (!c || !canAnimate() || !hud.isConnected) return;
      if (!repeat) {
        for (const sel of c.controls) {
          for (const el of document.querySelectorAll(sel)) if (el.getClientRects().length) void press(el);
        }
      }
      const plan = stackPlan(live.map((x) => x.group), c.group, MAX);
      if (plan.inPlace) {
        change(live[0], c, repeat);
      } else {
        const fresh = live.length === 0;
        const going = plan.leave.map((i) => live[i]);
        live = live.filter((x) => !going.includes(x));
        going.forEach(leave);
        const chip = build(c);
        hud.append(chip.el);
        live.unshift(chip);
        slot();
        enter(chip);
        place(fresh);
      }
      hold(live[0]);
    },
    refresh() {
      if (!live.length || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place(false);
      });
    },
  };
}
