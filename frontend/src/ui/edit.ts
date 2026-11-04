/** Sculpting tools (right panel in edit mode): tool, radius, strength, falloff, symmetry, undo. */
import type { App, AppState } from '../app';
import { FALLOFFS, falloffPath } from '../edit/falloff';
import { TOOLS } from '../edit/sculpt';
import { attr, h, isMac, memo, prop, svg } from '../lib/dom';
import { mm, num } from '../lib/format';
import { icon } from '../lib/icons';
import { flash, glide, swap } from './print';

const TOOL_ICON = { grab: 'grab', smooth: 'smooth', inflate: 'inflate' } as const;
const TOOL_NOTE = {
  grab: 'Trascina un punto: l’area intorno lo segue, più piano verso il bordo.',
  smooth: 'Passa sulla superficie per ammorbidire bozzi e spigoli.',
  inflate: 'Passa sulla superficie per gonfiarla; con Maiusc la sgonfi.',
} as const;

export function mountEditTools(root: HTMLElement, app: App): void {
  const sculpt = () => app.viewer?.sculpt;
  const mod = isMac() ? '⌘' : 'Ctrl';

  // the tool and falloff buttons are made once; a choice only moves their marks (and the ink)
  const toolBtns = TOOLS.map((t) => h('button', {
    class: 'tool', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-key': t.key,
    title: `${t.label} · ${t.shortcut}`, onclick: () => sculpt()?.set({ tool: t.key }),
  }, icon(TOOL_ICON[t.key]), h('span', null, t.label), h('kbd', null, t.shortcut)));
  const tools = h('div', { class: 'tools', role: 'radiogroup', 'aria-label': 'Strumento' }, toolBtns);
  const toolNote = h('p', { class: 'meta tool-note' });
  const radius = h('input', { type: 'range', class: 'range', min: 0, max: 100, step: 1, id: 'brush-radius' }) as HTMLInputElement;
  const radiusValue = h('output', { class: 'num value flash', for: 'brush-radius' });
  const strength = h('input', { type: 'range', class: 'range', min: 5, max: 100, step: 1, id: 'brush-strength' }) as HTMLInputElement;
  const strengthValue = h('output', { class: 'num value', for: 'brush-strength' });
  const falloffBtns = FALLOFFS.map((f) => h('button', {
    class: 'falloff', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-key': f.key,
    title: f.label, 'aria-label': f.label, onclick: () => sculpt()?.set({ falloff: f.key }),
  }, svg(`<svg width="36" height="18" viewBox="-2 -2 32 18" aria-hidden="true"><path d="${falloffPath(f.key)}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`),
  h('span', null, f.label)));
  const falloffs = h('div', { class: 'falloffs', role: 'radiogroup', 'aria-label': 'Caduta della selezione morbida' }, falloffBtns);
  const symmetry = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': 'Simmetria sull’asse X' }) as HTMLInputElement;
  const undo = h('button', { class: 'btn btn-secondary', type: 'button', title: `Annulla · ${mod}Z`, onclick: () => sculpt()?.undo() }, icon('undo'), 'Annulla');
  const redo = h('button', { class: 'btn btn-secondary', type: 'button', title: `Ripeti · ${mod}⇧Z`, onclick: () => sculpt()?.redo() }, icon('redo'), 'Ripeti');
  const steps = h('span', { class: 'meta num' });
  const repair = h('button', { class: 'btn btn-primary btn-wide', type: 'button', onclick: () => app.repairEdits() }, 'Ripara e aggiorna');
  const discard = h('button', {
    class: 'btn btn-ghost btn-wide', type: 'button',
    onclick: () => void app.discardEdits(),
  }, 'Esci senza salvare');

  // Radius slider on a log scale: fine control for small brushes, reach for large ones.
  const R_MIN = 0.5, R_MAX = 200;
  const toSlider = (r: number) => Math.round((Math.log(r / R_MIN) / Math.log(R_MAX / R_MIN)) * 100);
  const fromSlider = (v: number) => Math.round(R_MIN * (R_MAX / R_MIN) ** (v / 100) * 10) / 10;
  radius.addEventListener('input', () => sculpt()?.set({ radius: fromSlider(Number(radius.value)) }));
  strength.addEventListener('input', () => sculpt()?.set({ strength: Number(strength.value) / 100 }));
  symmetry.addEventListener('change', () => sculpt()?.set({ symmetry: symmetry.checked }));

  root.append(
    h('section', { class: 'block' },
      h('h2', { class: 'section-title' }, 'Modifica la forma'),
      tools, toolNote,
      h('div', { class: 'slider-field' },
        h('div', { class: 'slider-head' }, h('label', { class: 'label', for: 'brush-radius' }, 'Raggio'), radiusValue),
        radius),
      h('div', { class: 'slider-field' },
        h('div', { class: 'slider-head' }, h('label', { class: 'label', for: 'brush-strength' }, 'Intensità'), strengthValue),
        strength),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Caduta'), falloffs),
      h('label', { class: 'switch-row' },
        h('span', { class: 'switch-text' }, h('span', null, 'Simmetria X'), h('span', { class: 'meta' }, 'Ogni tratto si specchia sull’altro lato')),
        symmetry),
      h('div', { class: 'undo-row' }, undo, redo, steps)),
    h('section', { class: 'block' },
      h('h2', { class: 'section-title' }, 'Quando hai finito'),
      h('p', { class: 'meta' }, 'Forma richiude e ripara la mesh modificata e la salva come nuovo modello, accanto all’originale.'),
      h('div', { class: 'finish' }, repair, discard)),
  );

  // the tool and falloff marks change only when the choice does, not on every stroke; the ink
  // glides to the new one (G, S and I move it from the keyboard too)
  const toolsView = memo(), falloffsView = memo(), repairView = memo();
  const toolInk = glide(tools, '.tool[aria-checked="true"]');
  const falloffInk = glide(falloffs, '.falloff[aria-checked="true"]');
  /** Text that changed comes in, once the panel is up (the first draw is the page itself). */
  const write = (el: HTMLElement, text: string, live: boolean) => {
    if (el.textContent === text) return;
    el.textContent = text;
    if (live) void swap(el);
  };
  let prev: AppState | null = null;
  const update = (s: AppState) => {
    const st = s.sculpt;
    const live = !!prev && s.edit;
    if (!prev || prev.sculpt !== st) {
      toolsView([st.tool], () => {
        for (const b of toolBtns) attr(b, 'aria-checked', String(b.dataset.key === st.tool));
        toolInk(live);
      });
      write(toolNote, TOOL_NOTE[st.tool], live);
      if (document.activeElement !== radius) prop(radius, 'value', String(toSlider(st.radius)));
      const r = `${mm(st.radius)} mm`;
      // a radius changed from the keyboard ([ and ]) underlines itself; the slider shows its own
      if (radiusValue.textContent !== r) {
        radiusValue.textContent = r;
        if (live && document.activeElement !== radius) void flash(radiusValue);
      }
      prop(strength, 'value', String(Math.round(st.strength * 100)));
      prop(strength, 'disabled', st.tool === 'grab');
      const grabbing = st.tool === 'grab', wasGrabbing = prev?.sculpt.tool === 'grab';
      const sv = grabbing ? 'segue il puntatore' : `${num(st.strength * 100)}%`;
      // the words swap when the tool changes them; a dragged percentage just follows the slider
      write(strengthValue, sv, live && grabbing !== wasGrabbing);
      falloffsView([st.falloff], () => {
        for (const b of falloffBtns) attr(b, 'aria-checked', String(b.dataset.key === st.falloff));
        falloffInk(live);
      });
      prop(symmetry, 'checked', st.symmetry);
      prop(undo, 'disabled', !st.canUndo);
      prop(redo, 'disabled', !st.canRedo);
      write(steps, st.steps === 0 ? 'Nessuna modifica' : st.steps === 1 ? '1 modifica' : `${st.steps} modifiche`, live);
    }
    prop(repair, 'disabled', st.steps === 0 || !!s.busy);
    const repairing = s.busy === 'repair';
    repairView([repairing], () => repair.replaceChildren(repairing ? icon('spinner', 14) : '', repairing ? 'Riparo…' : 'Ripara e aggiorna'));
    prop(discard, 'textContent', st.steps > 0 ? 'Esci senza salvare' : 'Esci');
    prev = s;
  };
  app.store.subscribe(update);
  update(app.state);
}
