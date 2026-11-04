/** Sculpting tools (right panel in edit mode): tool, radius, strength, falloff, symmetry, undo. */
import type { App, AppState } from '../app';
import { FALLOFFS, falloffPath } from '../edit/falloff';
import { TOOLS } from '../edit/sculpt';
import { h, isMac, render, svg } from '../lib/dom';
import { mm, num } from '../lib/format';
import { icon } from '../lib/icons';

const TOOL_ICON = { grab: 'grab', smooth: 'smooth', inflate: 'inflate' } as const;
const TOOL_NOTE = {
  grab: 'Trascina un punto: l’area intorno lo segue, più piano verso il bordo.',
  smooth: 'Passa sulla superficie per ammorbidire bozzi e spigoli.',
  inflate: 'Passa sulla superficie per gonfiarla; con Maiusc la sgonfi.',
} as const;

export function mountEditTools(root: HTMLElement, app: App): void {
  const sculpt = () => app.viewer?.sculpt;
  const mod = isMac() ? '⌘' : 'Ctrl';

  const tools = h('div', { class: 'tools', role: 'radiogroup', 'aria-label': 'Strumento' });
  const toolNote = h('p', { class: 'meta tool-note' });
  const radius = h('input', { type: 'range', class: 'range', min: 0, max: 100, step: 1, id: 'brush-radius' }) as HTMLInputElement;
  const radiusValue = h('output', { class: 'num value', for: 'brush-radius' });
  const strength = h('input', { type: 'range', class: 'range', min: 5, max: 100, step: 1, id: 'brush-strength' }) as HTMLInputElement;
  const strengthValue = h('output', { class: 'num value', for: 'brush-strength' });
  const falloffs = h('div', { class: 'falloffs', role: 'radiogroup', 'aria-label': 'Caduta della selezione morbida' });
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

  let prev: AppState | null = null;
  const update = (s: AppState) => {
    const st = s.sculpt;
    if (!prev || prev.sculpt !== st) {
      render(tools, TOOLS.map((t) => h('button', {
        class: 'tool', type: 'button', role: 'radio', 'aria-checked': String(st.tool === t.key),
        title: `${t.label} · ${t.shortcut}`, onclick: () => sculpt()?.set({ tool: t.key }),
      }, icon(TOOL_ICON[t.key]), h('span', null, t.label), h('kbd', null, t.shortcut))));
      toolNote.textContent = TOOL_NOTE[st.tool];
      if (document.activeElement !== radius) radius.value = String(toSlider(st.radius));
      radiusValue.textContent = `${mm(st.radius)} mm`;
      strength.value = String(Math.round(st.strength * 100));
      strength.disabled = st.tool === 'grab';
      strengthValue.textContent = st.tool === 'grab' ? 'segue il puntatore' : `${num(st.strength * 100)}%`;
      render(falloffs, FALLOFFS.map((f) => h('button', {
        class: 'falloff', type: 'button', role: 'radio', 'aria-checked': String(st.falloff === f.key),
        title: f.label, 'aria-label': f.label, onclick: () => sculpt()?.set({ falloff: f.key }),
      }, svg(`<svg width="36" height="18" viewBox="-2 -2 32 18" aria-hidden="true"><path d="${falloffPath(f.key)}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`),
      h('span', null, f.label))));
      symmetry.checked = st.symmetry;
      undo.disabled = !st.canUndo;
      redo.disabled = !st.canRedo;
      steps.textContent = st.steps === 0 ? 'Nessuna modifica' : st.steps === 1 ? '1 modifica' : `${st.steps} modifiche`;
    }
    repair.disabled = st.steps === 0 || !!s.busy;
    repair.replaceChildren(s.busy === 'repair' ? icon('spinner', 14) : '', s.busy === 'repair' ? 'Riparo…' : 'Ripara e aggiorna');
    discard.textContent = st.steps > 0 ? 'Esci senza salvare' : 'Esci';
    prev = s;
  };
  app.store.subscribe(update);
  update(app.state);
}
