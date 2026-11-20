/**
 * Right panel: printer and filament, size with the bed-fit check, preparation settings,
 * the printability report led by the filament spool, and export. In edit mode it holds
 * the sculpting tools instead.
 *
 * It also holds the panels' motion (exported for create.ts, edit.ts and topbar.ts; the pieces
 * it moves are in panels.css): it only ever plays on top of a state already written, so text,
 * `hidden`, aria-* and classes change exactly when they did without it.
 */
import '../styles/panels.css';
import type { App, AppState } from '../app';
import { exportName, type ExportFormat, type Orientation } from '../lib/api';
import { attr, h, memo, prop, render, svg } from '../lib/dom';
import { FILAMENTS, filamentByKey } from '../lib/filaments';
import { dims, grams, mm, num } from '../lib/format';
import { icon } from '../lib/icons';
import { INFILLS, MATERIALS, SPOOLS, duration, euro, materialByKey } from '../lib/materials';
import { DUR, EASE, canAnimate, enter, play, stagger } from '../lib/motion';
import { PRINTERS, fitOnBed, scaled } from '../lib/printers';
import { mountEditTools } from './edit';

const ORIENTATIONS: { key: Orientation; label: string; title: string }[] = [
  { key: 'upright', label: 'In piedi', title: 'Come generato, con la base livellata' },
  { key: 'supports', label: 'Meno supporti', title: 'Sulla faccia che lascia meno sbalzi' },
  { key: 'flat', label: 'Disteso', title: 'Sulla faccia piana più ampia' },
  { key: 'keep', label: 'Com’è', title: 'Senza ruotare' },
];
const spoolLabel = (g: number) => (g >= 1000 ? `${num(g / 1000, g % 1000 ? 1 : 0)} kg` : `${g} g`);
const FORMATS: { key: ExportFormat; label: string; note: string }[] = [
  { key: '3mf', label: '3MF', note: 'millimetri, per Bambu Studio, PrusaSlicer, Cura' },
  { key: 'stl', label: 'STL', note: 'binario, millimetri: lo legge ogni slicer' },
  { key: 'obj', label: 'OBJ', note: 'millimetri, Z in alto, per la modellazione' },
  { key: 'glb', label: 'GLB', note: 'metri, Y in alto (glTF), per il web e la AR' },
];
// a model with its own colours: OBJ carries them, and Bambu Studio maps them to the AMS
const OBJ_COLOR_NOTE = 'millimetri, con i colori: Bambu Studio li abbina all’AMS';
// the GLB carries them too, but Blender opens it in Solid view, one grey for the whole material
const GLB_COLOR_NOTE = 'metri, Y in alto, con i colori: in Blender si vedono in Material Preview (tasto Z)';
const COLOR_NOTES: Partial<Record<ExportFormat, string>> = { obj: OBJ_COLOR_NOTE, glb: GLB_COLOR_NOTE };

// -- the panels' motion ------------------------------------------------------------------------

/** On screen: not inside something hidden (a view, a closed tab). */
export const shown = (el: Element) => el.getClientRects().length > 0;

interface Box { x: number; y: number; w: number; h: number }

/**
 * A sliding indicator for a group of choices: one aria-hidden element that glides, on transforms,
 * from the old choice to the new one. `fill` is the ink of a segmented control (panels.css puts
 * the cells' paper under it and their labels over it), `line` the underline of tabs (it reaches
 * for the new tab, then lets go of the old one), `ring` the circle around a colour swatch. Call
 * the returned function after the choice is written (aria-checked…): it measures and glides, or
 * just places with `animate` false. It places itself again when the group is resized or shown.
 */
export function glide(group: HTMLElement, chosen: string, kind: 'fill' | 'line' | 'ring' = 'fill'): (animate?: boolean) => void {
  const bar = h('span', { class: `glide glide-${kind}`, 'aria-hidden': 'true' });
  // paper under the chosen cell, at once: the ink glides over paper, never over the hairlines
  const patch = kind === 'fill' ? h('span', { class: 'glide glide-patch', 'aria-hidden': 'true' }) : null;
  const parts = patch ? [patch, bar] : [bar];
  group.classList.add('has-glide');
  let at: Box | null = null;

  // A box in the group's padding box, where `left: 0; top: 0` puts the indicator. A cell being
  // scaled (a hovered swatch) is read from its layout, so that the indicator keeps its true size.
  const boxOf = (el: HTMLElement): Box => {
    const cs = el === bar ? null : getComputedStyle(el);
    if (cs && (cs.transform !== 'none' || cs.scale !== 'none' || cs.translate !== 'none')) {
      return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    }
    const g = group.getBoundingClientRect(), r = el.getBoundingClientRect();
    const k = g.width / group.offsetWidth || 1; // an ancestor's scale
    return { x: (r.left - g.left) / k - group.clientLeft, y: (r.top - g.top) / k - group.clientTop, w: r.width / k, h: r.height / k };
  };
  const set = (el: HTMLElement, b: Box) => {
    el.style.width = `${b.w}px`;
    if (kind !== 'line') el.style.height = `${b.h}px`;
    el.style.transform = `translate(${b.x}px, ${kind === 'line' ? 0 : b.y}px)`;
  };

  const place = (animate = true) => {
    if (group.firstChild !== parts[0]) group.prepend(...parts); // a render() of the group took them
    const cell = group.querySelector<HTMLElement>(chosen);
    if (!cell) {
      for (const p of parts) p.hidden = true;
      at = null;
      return;
    }
    if (!shown(group)) return; // in a hidden view: placed when it shows (the observer below)
    const c = boxOf(cell);
    const R = 4; // the ring: 3 px off the swatch, 1 px of line, as the outline it replaces
    const to = kind === 'ring' ? { x: c.x - R, y: c.y - R, w: c.w + 2 * R, h: c.h + 2 * R }
      : kind === 'line' ? { x: c.x, y: 0, w: c.w - (parseFloat(getComputedStyle(cell).letterSpacing) || 0), h: 1 } // less the tracking after the last letter
        : c;
    const from = animate && at && !bar.hidden && canAnimate() ? boxOf(bar) : null;
    for (const a of bar.getAnimations()) a.cancel();
    for (const p of parts) {
      p.hidden = false;
      set(p, to);
    }
    at = to;
    if (!from || (Math.abs(from.x - to.x) < 0.5 && Math.abs(from.y - to.y) < 0.5 && Math.abs(from.w - to.w) < 0.5)) return;
    const t = (b: Box) => `translate(${b.x}px, ${kind === 'line' ? 0 : b.y}px) scale(${b.w / to.w}, ${kind === 'line' ? 1 : b.h / to.h})`;
    if (kind === 'line') {
      const x0 = Math.min(from.x, to.x), x1 = Math.max(from.x + from.w, to.x + to.w);
      void play(bar, [
        { transform: t(from), easing: EASE.inOut },
        { transform: t({ x: x0, y: 0, w: x1 - x0, h: 1 }), offset: 0.45, easing: EASE.out },
        { transform: t(to) },
      ], { duration: DUR.slow, easing: 'linear' });
    } else {
      void play(bar, [{ transform: t(from) }, { transform: t(to) }], { duration: DUR.base, easing: EASE.spring });
    }
  };
  new ResizeObserver(() => place(false)).observe(group);
  return place;
}

export interface Choice<T extends string> { key: T; label: string; disabled?: boolean; title?: string }

/**
 * A segmented control whose buttons stay in place: built again only when the items change,
 * marked (aria-checked) when the choice does, so the labels' colours can turn while the ink
 * glides under them. Returns the update.
 */
export function segmented<T extends string>(el: HTMLElement, set: (v: T) => void): (items: readonly Choice<T>[], value: T, animate: boolean) => void {
  const built = memo();
  const slide = glide(el, '.seg[aria-checked="true"]');
  return (items, value, animate) => {
    built([items.map((it) => [it.key, it.label, it.disabled ? 1 : 0, it.title ?? ''].join('␟')).join('␞')], () => render(el, items.map((it) =>
      h('button', {
        class: 'seg', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-key': it.key,
        disabled: it.disabled, title: it.title, onclick: () => set(it.key),
      }, it.label))));
    for (const b of el.querySelectorAll<HTMLElement>(':scope > .seg')) attr(b, 'aria-checked', String(b.dataset.key === value));
    slide(animate);
  };
}

/** Text rising from behind its own baseline, `from` % of its height (a figure, a name). */
export function reveal(el: Element, delay = 0, duration: number = DUR.slow, from = 100): Promise<void> {
  return play(el, [
    { transform: `translateY(${from}%)`, clipPath: `inset(-0.3em -0.2em ${from}% -0.2em)` },
    { transform: 'none', clipPath: 'inset(-0.3em -0.2em 0% -0.2em)' },
  ], { delay, duration, easing: EASE.out, fill: 'backwards' });
}

/** Words that changed come in: up a little, out of transparency (they are written already). */
export function swap(el: Element, delay = 0): Promise<void> {
  return play(el, [{ opacity: 0, transform: 'translateY(0.4em)' }, { opacity: 1, transform: 'none' }],
    { delay, duration: DUR.short, easing: EASE.out, fill: 'backwards' });
}

/** A value that changed: an ink underline draws under it and fades (its ::after: `.flash`). */
export function flash(el: Element, delay = 0): Promise<void> {
  return play(el, [
    { transform: 'scaleX(0)', opacity: 1, easing: EASE.out },
    { transform: 'scaleX(1)', opacity: 1, offset: 0.4, easing: EASE.inOut },
    { transform: 'scaleX(1)', opacity: 0 },
  ], { delay, duration: 1200, easing: 'linear', pseudoElement: '::after' });
}

/** The blocks of a view coming in, one after the other: all settled within ~450 ms. */
export function riseIn(els: Iterable<Element>, start = 0): Promise<void> {
  return stagger(els, (el, d) => enter.rise(el, d, 10, 340), 35, 3, start);
}

// ------------------------------------------------------------------------------------------------

export function mountRightPanel(root: HTMLElement, app: App): void {
  const sheetClose = h('button', { class: 'icon-btn sheet-close', type: 'button', 'aria-label': 'Chiudi', onclick: () => app.store.set({ sheet: null }) }, icon('close'));

  // -- printer and filament --------------------------------------------------------------
  const printer = h('select', { id: 'printer', class: 'select' }, PRINTERS.map((p) =>
    h('option', { value: p.key }, p.key === 'custom' ? p.label : `${p.label} · ${p.w} × ${p.d} × ${p.h}`))) as HTMLSelectElement;
  printer.addEventListener('change', () => app.setPrinter(printer.value));
  const customField = (key: 'w' | 'd' | 'h', label: string) => {
    const input = h('input', { type: 'number', class: 'num-input num', min: 50, max: 1000, step: 1, inputmode: 'numeric', 'aria-label': label }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const v = Math.max(50, Math.min(1000, Number(input.value) || 0));
      input.value = String(v);
      app.setCustom({ [key]: v });
    });
    return input;
  };
  const cw = customField('w', 'Larghezza del piatto (mm)');
  const cd = customField('d', 'Profondità del piatto (mm)');
  const ch = customField('h', 'Altezza di stampa (mm)');
  const custom = h('div', { class: 'custom-bed' }, cw, h('span', { class: 'meta' }, '×'), cd, h('span', { class: 'meta' }, '×'), ch, h('span', { class: 'meta' }, 'mm'));
  const filamentName = h('span', { class: 'meta' });
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colore del filamento' },
    FILAMENTS.map((f) => h('button', {
      class: 'swatch', type: 'button', role: 'radio', 'aria-label': `PLA ${f.label}`, title: `PLA ${f.label}`,
      'data-key': f.key, style: { '--c': f.hex },
      onclick: () => app.setFilament(f.key),
    })));
  const materialSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Materiale' });
  const materialNote = h('p', { class: 'meta material-note' });
  const infill = h('select', { class: 'select select-small', id: 'infill', 'aria-label': 'Riempimento' },
    INFILLS.map((v) => h('option', { value: String(v) }, v === 1 ? 'Pieno' : `${Math.round(v * 100)}%`))) as HTMLSelectElement;
  infill.addEventListener('change', () => app.setInfill(Number(infill.value)));
  const spoolSel = h('select', { class: 'select select-small', id: 'spool', 'aria-label': 'Bobina' },
    SPOOLS.map((g) => h('option', { value: String(g) }, spoolLabel(g)))) as HTMLSelectElement;
  spoolSel.addEventListener('change', () => app.setSpool(Number(spoolSel.value)));
  const priceInput = h('input', { type: 'number', class: 'num-input num', min: 1, max: 500, step: 0.5, inputmode: 'decimal', id: 'price', 'aria-label': 'Prezzo del filamento in euro al chilo' }) as HTMLInputElement;
  priceInput.addEventListener('change', () => {
    const v = Math.max(1, Math.min(500, Number(priceInput.value.replace(',', '.')) || materialByKey(app.state.material).price));
    app.setPrice(Math.round(v * 100) / 100);
  });
  const materialGrid = h('div', { class: 'material-grid' },
    h('label', { class: 'mini-field' }, h('span', { class: 'label' }, 'Riempimento'), infill),
    h('label', { class: 'mini-field' }, h('span', { class: 'label' }, 'Bobina'), spoolSel),
    h('label', { class: 'mini-field' }, h('span', { class: 'label' }, '€ al ', h('span', { class: 'unit' }, 'kg')), priceInput));

  swatches.addEventListener('keydown', (e) => {
    const keys = FILAMENTS.map((f) => f.key);
    const i = keys.indexOf(app.state.filament);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = keys[(i + step + keys.length) % keys.length];
    app.setFilament(next);
    (swatches.querySelector(`[data-key="${next}"]`) as HTMLElement | null)?.focus();
  });

  // -- size and fit ----------------------------------------------------------------------
  const sizeRange = h('input', { type: 'range', id: 'size', min: 10, max: 300, step: 1, class: 'range', 'aria-describedby': 'fit-line' }) as HTMLInputElement;
  const sizeInput = h('input', { type: 'number', class: 'num-input num', min: 5, max: 500, step: 0.5, inputmode: 'decimal', 'aria-label': 'Lato più lungo in millimetri' }) as HTMLInputElement;
  sizeRange.addEventListener('input', () => app.setSetting('target_size_mm', Number(sizeRange.value)));
  sizeInput.addEventListener('change', () => {
    const v = Math.max(5, Math.min(500, Number(sizeInput.value.replace(',', '.')) || 100));
    app.setSetting('target_size_mm', v);
  });
  const bedPlan = h('div', { class: 'bed-plan', 'aria-hidden': 'true' });
  const fitLine = h('p', { id: 'fit-line', class: 'fit-line' });
  const fitDims = h('p', { class: 'meta num' });
  const fitAction = h('button', { class: 'btn btn-secondary btn-small', type: 'button' }, 'Adatta al piatto');
  const orientSeg = h('div', { class: 'segmented segmented-grid', role: 'radiogroup', 'aria-label': 'Orientamento sul piatto' });

  const toggle = (label: string, hintText: string, key: 'hollow' | 'base_plate') => {
    const input = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': label }) as HTMLInputElement;
    input.addEventListener('change', () => app.setSetting(key, input.checked));
    const row = h('label', { class: 'switch-row' }, h('span', { class: 'switch-text' }, h('span', null, label), h('span', { class: 'meta' }, hintText)), input);
    return { row, input };
  };
  const stepper = (label: string, key: 'wall_mm' | 'base_thickness_mm' | 'flat_bottom_mm', min: number, max: number, step = 0.2) => {
    const input = h('input', { type: 'number', class: 'num-input num', min, max, step, inputmode: 'decimal', 'aria-label': `${label} in millimetri` }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, Number(input.value.replace(',', '.')) || min));
      app.setSetting(key, Math.round(v * 10) / 10);
    });
    const row = h('div', { class: 'sub-row' }, h('span', null, label), h('span', { class: 'with-unit' }, input, h('span', { class: 'meta' }, 'mm')));
    return { row, input };
  };
  // flat bottom: a switch over flat_bottom_mm (0 = off), remembering the last depth used
  const flatInput = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': 'Base piana' }) as HTMLInputElement;
  let lastFlat = 2;
  flatInput.addEventListener('change', () => app.setSetting('flat_bottom_mm', flatInput.checked ? lastFlat : 0));
  const flat = {
    row: h('label', { class: 'switch-row' },
      h('span', { class: 'switch-text' }, h('span', null, 'Base piana'), h('span', { class: 'meta' }, 'Taglia il fondo in piano: più presa sul piatto')),
      flatInput),
    input: flatInput,
  };
  const flatDepth = stepper('Taglio dal fondo', 'flat_bottom_mm', 0.5, 30, 0.5);
  const hollow = toggle('Svuota l’interno', 'Meno filamento, pareti piene', 'hollow');
  const wall = stepper('Spessore pareti', 'wall_mm', 0.8, 20);
  const base = toggle('Base d’appoggio', 'Allarga l’impronta sul piatto', 'base_plate');
  const baseT = stepper('Spessore base', 'base_thickness_mm', 0.6, 20);
  const applyNote = h('span', { class: 'meta' });
  const applyBtn = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => app.apply() }, 'Applica');

  // -- report ----------------------------------------------------------------------------
  const spool = h('div', { class: 'spool' });
  const kv = h('dl', { class: 'kv' });
  const notes = h('div', { class: 'notes' });

  // -- export ----------------------------------------------------------------------------
  const formats = h('div', { class: 'formats' });
  const fileName = h('p', { class: 'meta file-name' });
  // Blender on this computer: the GLB opened there, framed and with its colours on
  const blender = h('button', { class: 'btn btn-secondary blender-open', type: 'button', hidden: true },
    'Apri in Blender') as HTMLButtonElement;
  blender.addEventListener('click', async () => {
    blender.disabled = true;
    blender.textContent = 'Apro Blender…';
    try {
      await app.openInBlender();
    } finally {
      blender.disabled = false;
      blender.textContent = 'Apri in Blender';
    }
  });

  // The report answers the screen's question (can I print it, and how much filament?): first.
  const printView = h('div', { class: 'view print-view' },
    h('section', { class: 'block block-report' },
      h('h2', { class: 'section-title' }, 'Resoconto di stampa'),
      spool, kv, notes),
    h('section', { class: 'block block-export' },
      h('h2', { class: 'section-title' }, 'Esporta'),
      formats, fileName, blender),
    h('section', { class: 'block block-printer' },
      h('h2', { class: 'section-title' }, 'Stampante e filamento'),
      h('label', { class: 'label', for: 'printer' }, 'Stampante'),
      printer, custom,
      h('div', { class: 'label label-row' }, h('span', null, 'Filamento'), filamentName),
      swatches,
      h('div', { class: 'label label-row' }, h('span', null, 'Materiale')),
      materialSeg, materialNote, materialGrid),
    h('section', { class: 'block block-prep' },
      h('h2', { class: 'section-title' }, 'Dimensioni e preparazione'),
      h('div', { class: 'size-row' }, h('label', { class: 'label', for: 'size' }, 'Lato più lungo'), h('span', { class: 'with-unit' }, sizeInput, h('span', { class: 'meta' }, 'mm'))),
      sizeRange,
      h('div', { class: 'fit' }, bedPlan, h('div', { class: 'fit-text' }, fitLine, fitDims, fitAction)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Orientamento'), orientSeg),
      flat.row, flatDepth.row, hollow.row, wall.row, base.row, baseT.row,
      h('div', { class: 'apply-row' }, applyNote, applyBtn)),
  );
  const editView = h('div', { class: 'view edit-view' });
  mountEditTools(editView, app);
  root.append(h('div', { class: 'panel-head panel-head-print' }, h('span', { class: 'panel-head-title' }, 'Stampa'), sheetClose), printView, editView);

  // -- rendering -------------------------------------------------------------------------
  // Each part redraws only when what it shows changes (typing, polling and sculpting update the
  // store often); fields the user types in are compared with what they hold, not with the state.
  // The choices stay in place and only change their marks: the indicators glide between them.
  const swatchBtns = Array.from(swatches.querySelectorAll<HTMLElement>('.swatch'));
  const swatchView = memo(), planView = memo(), fitView = memo(), orientView = memo(), applyView = memo();
  const swatchRing = glide(swatches, '.swatch[aria-checked="true"]', 'ring');
  const material = segmented(materialSeg, (key) => app.setMaterial(key));
  const orientation = segmented<Orientation>(orientSeg, (key) => app.setSetting('orientation', key));
  let prev: AppState | null = null;
  const update = (s: AppState) => {
    const live = !!prev; // the first draw is the page itself: nothing comes in
    if (prev && prev.edit !== s.edit) root.scrollTop = 0;
    prop(printView, 'hidden', s.edit);
    prop(editView, 'hidden', !s.edit);
    // the view that comes in rises, block after block
    if (prev && prev.edit !== s.edit) void riseIn((s.edit ? editView : printView).querySelectorAll(':scope > .block'));
    const p = app.printer(s);
    const c = s.current;
    prop(printer, 'value', s.printer);
    prop(custom, 'hidden', s.printer !== 'custom');
    for (const [el, v] of [[cw, s.custom.w], [cd, s.custom.d], [ch, s.custom.h]] as const) {
      if (document.activeElement !== el) prop(el, 'value', String(v));
    }
    const f = filamentByKey(s.filament);
    const mat = materialByKey(s.material);
    const filamentText = `${mat.label} ${f.label}`;
    if (filamentName.textContent !== filamentText) {
      filamentName.textContent = filamentText;
      if (live) void swap(filamentName);
    }
    if (!prev || prev.material !== s.material) {
      material(MATERIALS.map((m) => ({ key: m.key, label: m.label, title: m.note })), s.material, live);
      materialNote.textContent = `${mat.note} Densità ${num(mat.density, 2)} g/cm³.`;
      if (live) void swap(materialNote);
    }
    prop(infill, 'value', String(s.infill));
    prop(spoolSel, 'value', String(s.spoolG));
    if (document.activeElement !== priceInput) prop(priceInput, 'value', String(app.price(s)));
    swatchView([s.filament], () => {
      for (const el of swatchBtns) {
        const on = el.dataset.key === s.filament;
        el.setAttribute('aria-checked', String(on));
        el.tabIndex = on ? 0 : -1;
      }
      swatchRing(live);
    });

    // size: preview the box at the new size before it is applied
    const target = s.settings.target_size_mm;
    // number inputs take a dot decimal; the browser shows it in the user's locale
    if (document.activeElement !== sizeInput) prop(sizeInput, 'value', String(Math.round(target * 10) / 10));
    prop(sizeRange, 'max', String(Math.max(300, Math.ceil(target))));
    prop(sizeRange, 'value', String(target));
    const base0 = app.size(s);
    const box = base0 ? scaled(base0, target) : null;
    const fit = box ? fitOnBed(box, p) : null;
    const rotated = fit?.rotated ?? false, fits = fit?.fits ?? true;
    planView([p.w, p.d, box?.[0], box?.[1], rotated, fits], () => drawPlan(bedPlan, planSVG(p.w, p.d, box, rotated, fits), live));
    const actionWasHidden = fitAction.hidden;
    if (!box || !fit) {
      fitView([null, p.label], () => {
        fitLine.className = 'fit-line';
        fitLine.textContent = p.label;
        if (live) void swap(fitLine);
      });
      prop(fitDims, 'textContent', `Volume di stampa ${num(p.w)} × ${num(p.d)} × ${num(p.h)} mm`);
      prop(fitAction, 'hidden', true);
    } else {
      const verdict = fit.fits ? (fit.rotated ? 'Entra girato di 90°' : 'Entra nel piatto') : `Al massimo ${mm(fit.maxSize)} mm`;
      fitView([fit.fits, verdict], () => {
        fitLine.className = `fit-line ${fit.fits ? 'is-ok' : 'is-over'}`;
        fitLine.replaceChildren(icon(fit.fits ? 'check' : 'alert'), verdict);
        if (live) void swap(fitLine);
      });
      prop(fitDims, 'textContent', `${dims(box)} mm su ${num(p.w)} × ${num(p.d)} × ${num(p.h)}`);
      prop(fitAction, 'hidden', fit.fits);
      fitAction.onclick = () => app.setSetting('target_size_mm', Math.floor(fit.maxSize));
    }
    // (a fade only: a button that moved would make a click wait for it)
    if (live && actionWasHidden && !fitAction.hidden) void enter.fade(fitAction, 60, DUR.base);

    orientView([s.settings.orientation], () => orientation(ORIENTATIONS, s.settings.orientation, live));
    const cut = s.settings.flat_bottom_mm ?? 0;
    if (cut > 0) lastFlat = cut;
    prop(flat.input, 'checked', cut > 0);
    prop(flatDepth.row, 'hidden', cut <= 0);
    if (document.activeElement !== flatDepth.input) prop(flatDepth.input, 'value', String(cut > 0 ? cut : lastFlat));
    prop(hollow.input, 'checked', s.settings.hollow);
    prop(wall.row, 'hidden', !s.settings.hollow);
    if (document.activeElement !== wall.input) prop(wall.input, 'value', String(s.settings.wall_mm));
    prop(base.input, 'checked', s.settings.base_plate);
    prop(baseT.row, 'hidden', !s.settings.base_plate);
    if (document.activeElement !== baseT.input) prop(baseT.input, 'value', String(s.settings.base_thickness_mm));
    const dirty = app.dirty(s);
    prop(applyBtn, 'disabled', !c || !dirty || !!s.busy || app.generating(s));
    const applying = s.busy === 'apply';
    applyView([applying], () => applyBtn.replaceChildren(applying ? icon('spinner', 14) : '', applying ? 'Preparo…' : 'Applica'));
    const applyText = !c ? 'Valgono per il prossimo modello.' : dirty ? 'Modifiche da applicare al modello.' : 'Applicate al modello sul piatto.';
    if (applyNote.textContent !== applyText) {
      applyNote.textContent = applyText;
      if (live) void swap(applyNote);
    }

    // (the filament is not an input: the spool ring takes its colour from the CSS variable)
    if (!prev || prev.current !== c || prev.shape !== s.shape || prev.printer !== s.printer ||
      prev.custom !== s.custom || prev.material !== s.material || prev.infill !== s.infill || prev.spoolG !== s.spoolG ||
      prev.prices !== s.prices) {
      renderReport(s);
    }
    prev = s;
  };

  // The report's parts are keyed on the words and figures they show: a sculpt stroke that
  // leaves them as they are redraws nothing (and an open "Riparazioni" stays open).
  // A new model's report draws itself in (the spool's arc, the figure, the rows one by one);
  // on the same model, the values that changed flash (after Applica, a material, an infill).
  const spoolView = memo(), kvView = memo(), notesView = memo(), formatsView = memo(), fileView = memo();
  let onScreen: string | null = null; // the model whose report is drawn
  let lastSpool: { frac: number; values: string[] } | null = null;
  let lastRows = new Map<string, string>();
  const renderReport = (s: AppState) => {
    const c = s.current;
    // (in edit mode the report is out of sight: it is drawn, not played)
    const live = canAnimate() && shown(printView);
    if (!c) {
      const was = onScreen;
      onScreen = null;
      lastSpool = null;
      lastRows = new Map();
      spoolView([null], () => {
        render(spool, h('p', { class: 'empty' }, 'Appare quando c’è un modello sul piatto: grammi di filamento, misure, sbalzi e riparazioni.'));
        if (live && was) void enter.fade(spool.firstElementChild!, 0, DUR.base);
      });
      kvView([null], () => render(kv));
      notesView([null], () => render(notes));
      formatsView([null], () => render(formats));
      fileView([null], () => { fileName.textContent = 'File 3MF, STL, OBJ o GLB, in millimetri, già riparati e chiusi.'; });
      return;
    }
    const fresh = c.id !== onScreen; // a new model's report appears
    onScreen = c.id;
    const r = c.report;
    const est = app.estimate(s)!;
    const g = est.grams;
    const mat = materialByKey(s.material);
    const frac = Math.min(1, g / s.spoolG);
    const figure = grams(g);
    const of = `di una bobina da ${spoolLabel(s.spoolG)} di ${mat.label}${est.prints > 1 ? `: ne stampi ${num(est.prints)}` : est.prints === 0 ? ': non basta' : ''}`;
    const metres = `≈ ${num(est.metres, 1)} m`, cost = `≈ ${euro(est.cost)}`, time = `≈ ${duration(est.minutes)}`;
    spoolView([c.id, frac, figure, of, metres, cost, time], () => {
      const before = fresh ? null : lastSpool;
      const ring = spoolSVG(frac);
      const gramsEl = h('span', { class: 'spool-grams flash' }, figure);
      const figureEl = h('p', { class: 'spool-figure num' }, gramsEl, h('span', { class: 'spool-unit' }, ' g'));
      const ofEl = h('p', { class: 'spool-of flash' }, of);
      const est3 = [metres, cost, time].map((v) => h('dd', { class: 'flash' }, v));
      const estEl = h('dl', { class: 'spool-est num' },
        h('div', null, h('dt', null, 'Filamento'), est3[0]),
        h('div', null, h('dt', null, 'Costo'), est3[1]),
        h('div', null, h('dt', null, 'Tempo'), est3[2]));
      render(spool, ring, h('div', { class: 'spool-text' }, figureEl, ofEl, estEl));
      const values = [figure, of, metres, cost, time];
      lastSpool = { frac, values };
      if (!live) return;
      if (!before) {
        drawSpool(ring, frac);
        void reveal(figureEl, 60, DUR.slow);
        void enter.rise(ofEl, 200, 6, DUR.base);
        void stagger(estEl.children, (el, d) => enter.rise(el, d, 6, DUR.base), 60, 3, 280);
        return;
      }
      sweepSpool(ring, before.frac, frac);
      const targets = [gramsEl, ofEl, ...est3];
      let k = 0;
      values.forEach((v, i) => { if (v !== before.values[i]) void flash(targets[i], 50 * k++); });
    });
    const size = app.size(s) ?? r.bbox_mm;
    const rows: [string, string][] = [
      ['Misure', `${dims(size)} mm`],
      ['Volume', `${num(r.volume_cm3, 1)} cm³ · pieno ${grams(est.solidGrams)} g`],
      ['Mesh', r.watertight ? 'Chiusa e valida' : 'Aperta'],
      ['Pezzi', num(r.components)],
      ['Sbalzi oltre 45°', `${num(r.overhang_pct, 0)}%`],
      ...(r.bed_contact_cm2 !== undefined ? [['Appoggio sul piatto', `${num(r.bed_contact_cm2, r.bed_contact_cm2 < 10 ? 1 : 0)} cm²`] as [string, string]] : []),
      ...(r.thin_pct !== undefined ? [['Parti sotto 0,8 mm', r.thin_pct > 0.1 && r.thin_mm
        ? `${num(r.thin_pct, r.thin_pct < 10 ? 1 : 0)}% · ≈ ${num(r.thin_mm, 1)} mm`
        : 'Nessuna'] as [string, string]] : []),
      ['Copie per piatto', est.copies > 0 ? num(est.copies) : '—'],
      ['Triangoli', num(r.triangles)],
    ];
    kvView([c.id, ...rows.flat()], () => {
      const before = fresh ? null : lastRows;
      render(kv, rows.map(([k, v]) => h('div', { class: 'kv-row' }, h('dt', null, k), h('dd', { class: 'num flash' }, v))));
      lastRows = new Map(rows);
      if (!live) return;
      const els = Array.from(kv.children);
      if (!before) {
        void stagger(els, (el, d) => enter.rise(el, d, 8, DUR.base), 30, 10, 180);
        return;
      }
      let k = 0;
      rows.forEach(([key, v], i) => {
        const was = before.get(key);
        if (was === undefined) void enter.rise(els[i], 0, 6, DUR.base); // a row the report did not have
        else if (was !== v) void flash(els[i].lastElementChild!, 50 * k++);
      });
    });
    const fb = c.gen_meta?.fallback_from;
    const hi3d = c.gen_meta?.refine === 'hi3d' ? Number(c.gen_meta.hi3d_resolution) : 0;
    const hi3dError = c.gen_meta?.hi3d_error;
    const meshyCredits = c.gen_meta?.meshy_credits;
    notesView([r.warnings.join('\n'), r.repairs.join('\n'), r.process_ms, fb, c.model, s.infill, hi3d, hi3dError, meshyCredits], () => {
      const warn = r.warnings.map((w) => h('p', { class: 'note note-warning' }, icon('alert'), w));
      const repairs = r.repairs.length
        ? h('details', { class: 'repairs' },
          h('summary', null, `Riparazioni (${r.repairs.length}) · ${num(r.process_ms / 1000, 1)} s`),
          h('ul', null, r.repairs.map((x) => h('li', null, x))))
        : h('p', { class: 'meta' }, `Nessuna riparazione necessaria · ${num(r.process_ms / 1000, 1)} s`);
      const time = h('p', { class: 'meta' }, `Tempo e costo sono stime (profilo standard da 0,2 mm, ${Math.round(s.infill * 100)}% di riempimento): lo slicer ti darà quelli esatti.`);
      const made = hi3d
        ? h('p', { class: 'note' }, `Forma di Idol rifinita da Hi3D a ${hi3d}³, colori di Idol.`)
        : hi3dError ? h('p', { class: 'note' }, `Forma di Idol senza rifinitura: ${hi3dError}`)
          : meshyCredits ? h('p', { class: 'note' }, `Generato con Meshy: ${meshyCredits} crediti.`) : null;
      render(notes, warn, fb ? h('p', { class: 'note' }, `Generato con ${c.model}: ${fb} non era disponibile.`) : null, made, repairs, time);
      if (live && fresh) void stagger(notes.children, (el, d) => enter.fade(el, d, DUR.base), 50, 4, 420);
    });
    const colored = !!c.has_colors;
    const best: ExportFormat = colored ? 'obj' : '3mf';
    prop(blender, 'hidden', !s.providers?.blender);
    prop(blender, 'title', colored
      ? 'Apre Blender su questo computer con il modello già a colori e inquadrato'
      : 'Apre Blender su questo computer con il modello inquadrato');
    formatsView([...FORMATS.map((f) => c.urls.export[f.key]), best], () => {
      render(formats, FORMATS.map((f) => h('button', {
        class: f.key === best ? 'btn btn-secondary is-recommended' : 'btn btn-secondary', type: 'button',
        'data-format': f.key, title: (colored && COLOR_NOTES[f.key]) || f.note,
        onclick: () => app.download(f.key), // prepared, checked and fetched in the download popup
      }, f.label)));
      // uncovered from the left: clip only, the links never move under the pointer
      if (live && fresh) void enter.wipe(formats, 0, 'left', DUR.base);
    });
    const slug = exportName(c, best);
    const inBlender = !!s.providers?.blender;
    fileView([slug, best, inBlender], () => {
      const slugEl = h('span', { class: 'file-slug' }, slug);
      fileName.replaceChildren(slugEl, h('span', null, colored
        ? 'Con i colori: OBJ. In Bambu Studio scegli quanti colori usare e lo slot AMS di ciascuno. '
          + (inBlender ? 'Per Blender: «Apri in Blender» lo apre già a colori.'
            : 'Anche il GLB ha i colori: in Blender passa alla vista Material Preview (tasto Z).')
        : '3MF consigliato: conserva i millimetri nello slicer.'));
      if (live) void swap(slugEl, fresh ? 160 : 0);
    });
  };

  app.store.subscribe(update);
  update(app.state);
}

/** The length of the spool's arc for a fraction of the spool: a print of a few grams still shows a mark. */
const SPOOL_R = 33, SPOOL_C = 2 * Math.PI * SPOOL_R;
const arcLength = (frac: number) => Math.max(frac > 0 ? 0.012 : 0, frac) * SPOOL_C;

/**
 * The spool drawn like a watch dial: the hairline flange with its hour ticks, the wound
 * filament as a ring with the arc this print takes, in the filament colour, and the hub.
 */
function spoolSVG(frac: number): SVGSVGElement {
  const r = SPOOL_R, c = SPOOL_C;
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * 2 * Math.PI, long = i % 3 === 0;
    const r0 = long ? 37.5 : 38.6, r1 = 41;
    const [s, k] = [Math.sin(a), -Math.cos(a)];
    return `<line x1="${(46 + s * r0).toFixed(2)}" y1="${(46 + k * r0).toFixed(2)}" x2="${(46 + s * r1).toFixed(2)}" y2="${(46 + k * r1).toFixed(2)}"/>`;
  }).join('');
  return svg(`<svg class="spool-ring" width="92" height="92" viewBox="0 0 92 92" aria-hidden="true">
    <circle cx="46" cy="46" r="44.5" fill="none" stroke="var(--rule-strong)" stroke-width=".75"/>
    <g class="spool-ticks" stroke="var(--ink)" stroke-width=".9" stroke-linecap="round">${ticks}</g>
    <circle cx="46" cy="46" r="${r}" fill="none" stroke="var(--paper-lo)" stroke-width="6"/>
    <circle class="spool-arc" cx="46" cy="46" r="${r}" fill="none" stroke="var(--data)" stroke-width="6"
      stroke-dasharray="${arcLength(frac).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 46 46)"/>
    <circle cx="46" cy="46" r="13" fill="none" stroke="var(--rule-strong)" stroke-width=".75"/>
    <circle cx="46" cy="46" r="2.6" fill="var(--ink)"/>
  </svg>`);
}

/** A new report: the hour ticks come in around the dial, then the arc winds out to its length. */
function drawSpool(ring: SVGSVGElement, frac: number): void {
  void stagger(ring.querySelectorAll('.spool-ticks line'), (el, d) => enter.fade(el, d, DUR.base), 28, 12, 0);
  const arc = ring.querySelector('.spool-arc');
  const len = arcLength(frac);
  if (arc && len > 0) void play(arc, [{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { delay: 140, duration: DUR.hero, easing: EASE.inOut, fill: 'backwards' });
}

/** The same model, a new figure: the arc grows or shrinks from what it showed. */
function sweepSpool(ring: SVGSVGElement, from: number, to: number): void {
  const arc = ring.querySelector('.spool-arc');
  const a = arcLength(from), b = arcLength(to);
  if (!arc || Math.abs(a - b) < 0.05) return;
  const dash = (l: number) => `${l.toFixed(2)} ${SPOOL_C.toFixed(2)}`;
  void play(arc, [{ strokeDasharray: dash(a) }, { strokeDasharray: dash(b) }], { duration: DUR.slow, easing: EASE.inOut });
}

/**
 * Put the new plan in: the bed and the footprint scale from what they were to what they are
 * (from the centre; the outline keeps its hairline), a footprint that was not there lands.
 */
function drawPlan(host: HTMLElement, plan: SVGSVGElement, live: boolean): void {
  const play0 = live && canAnimate() && shown(host);
  const was = play0 ? {
    bed: host.querySelector('.plan-bed')?.getBoundingClientRect(),
    foot: host.querySelector('.plan-foot')?.getBoundingClientRect(),
  } : null;
  render(host, plan);
  if (!was) return;
  const resize = (el: Element | null, old: DOMRect | undefined) => {
    if (!el || !old) return;
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5 || (Math.abs(r.width - old.width) < 0.25 && Math.abs(r.height - old.height) < 0.25)) return;
    void play(el, [{ transform: `scale(${old.width / r.width}, ${old.height / r.height})` }, { transform: 'none' }], { duration: DUR.base, easing: EASE.out });
  };
  resize(plan.querySelector('.plan-bed'), was.bed);
  const foot = plan.querySelector('.plan-foot');
  if (foot && was.foot) resize(foot, was.foot);
  else if (foot) void play(foot, [{ transform: 'scale(0.2)' }, { transform: 'none' }], { duration: DUR.base, easing: EASE.spring, fill: 'backwards' });
}

/** Top-down plan of the bed with the model's footprint. */
function planSVG(w: number, d: number, box: [number, number, number] | null, rotated: boolean, fits: boolean): SVGSVGElement {
  const S = 64;
  const k = (S - 8) / Math.max(w, d);
  const bw = w * k, bd = d * k;
  const ox = (S - bw) / 2, oy = (S - bd) / 2;
  let foot = '';
  if (box) {
    const fx = (rotated ? box[1] : box[0]) * k, fy = (rotated ? box[0] : box[1]) * k;
    foot = `<rect class="plan-foot" x="${(S - fx) / 2}" y="${(S - fy) / 2}" width="${fx}" height="${fy}" fill="${fits ? 'var(--data)' : 'var(--negative)'}" opacity="${fits ? 0.9 : 0.85}"/>`;
  }
  return svg(`<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
    <rect class="plan-bed" x="${ox + 0.5}" y="${oy + 0.5}" width="${bw - 1}" height="${bd - 1}" fill="var(--paper-lo)" stroke="var(--rule-strong)" stroke-width="1"/>
    ${foot}
  </svg>`);
}
