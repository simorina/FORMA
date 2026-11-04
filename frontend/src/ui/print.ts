/**
 * Right panel: printer and filament, size with the bed-fit check, preparation settings,
 * the printability report led by the filament spool, and export. In edit mode it holds
 * the sculpting tools instead.
 */
import type { App, AppState } from '../app';
import { exportName, type ExportFormat, type Orientation } from '../lib/api';
import { h, render, svg } from '../lib/dom';
import { FILAMENTS, filamentByKey } from '../lib/filaments';
import { dims, grams, mm, num } from '../lib/format';
import { icon } from '../lib/icons';
import { INFILLS, MATERIALS, SPOOLS, duration, euro, materialByKey } from '../lib/materials';
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
    h('label', { class: 'mini-field' }, h('span', { class: 'label' }, '€ al kg'), priceInput));

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
  const orientSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Orientamento sul piatto' });

  const toggle = (label: string, hintText: string, key: 'hollow' | 'base_plate') => {
    const input = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': label }) as HTMLInputElement;
    input.addEventListener('change', () => app.setSetting(key, input.checked));
    const row = h('label', { class: 'switch-row' }, h('span', { class: 'switch-text' }, h('span', null, label), h('span', { class: 'meta' }, hintText)), input);
    return { row, input };
  };
  const stepper = (label: string, key: 'wall_mm' | 'base_thickness_mm', min: number, max: number) => {
    const input = h('input', { type: 'number', class: 'num-input num', min, max, step: 0.2, inputmode: 'decimal', 'aria-label': `${label} in millimetri` }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, Number(input.value.replace(',', '.')) || min));
      app.setSetting(key, Math.round(v * 10) / 10);
    });
    const row = h('div', { class: 'sub-row' }, h('span', null, label), h('span', { class: 'with-unit' }, input, h('span', { class: 'meta' }, 'mm')));
    return { row, input };
  };
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

  // The report answers the screen's question (can I print it, and how much filament?): first.
  const printView = h('div', { class: 'view print-view' },
    h('section', { class: 'block' },
      h('h2', { class: 'section-title' }, 'Resoconto di stampa'),
      spool, kv, notes),
    h('section', { class: 'block' },
      h('h2', { class: 'section-title' }, 'Esporta'),
      formats, fileName),
    h('section', { class: 'block' },
      h('h2', { class: 'section-title' }, 'Stampante e filamento'),
      h('label', { class: 'label', for: 'printer' }, 'Stampante'),
      printer, custom,
      h('div', { class: 'label label-row' }, h('span', null, 'Filamento'), filamentName),
      swatches,
      h('div', { class: 'label label-row' }, h('span', null, 'Materiale')),
      materialSeg, materialNote, materialGrid),
    h('section', { class: 'block' },
      h('h2', { class: 'section-title' }, 'Dimensioni e preparazione'),
      h('div', { class: 'size-row' }, h('label', { class: 'label', for: 'size' }, 'Lato più lungo'), h('span', { class: 'with-unit' }, sizeInput, h('span', { class: 'meta' }, 'mm'))),
      sizeRange,
      h('div', { class: 'fit' }, bedPlan, h('div', { class: 'fit-text' }, fitLine, fitDims, fitAction)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Orientamento'), orientSeg),
      hollow.row, wall.row, base.row, baseT.row,
      h('div', { class: 'apply-row' }, applyNote, applyBtn)),
  );
  const editView = h('div', { class: 'view edit-view' });
  mountEditTools(editView, app);
  root.append(h('div', { class: 'panel-head panel-head-print' }, h('span', { class: 'panel-head-title' }, 'Stampa'), sheetClose), printView, editView);

  // -- rendering -------------------------------------------------------------------------
  let prev: AppState | null = null;
  const update = (s: AppState) => {
    printView.hidden = s.edit;
    editView.hidden = !s.edit;
    const p = app.printer(s);
    const c = s.current;
    if (printer.value !== s.printer) printer.value = s.printer;
    custom.hidden = s.printer !== 'custom';
    for (const [el, v] of [[cw, s.custom.w], [cd, s.custom.d], [ch, s.custom.h]] as const) {
      if (document.activeElement !== el) el.value = String(v);
    }
    const f = filamentByKey(s.filament);
    const mat = materialByKey(s.material);
    filamentName.textContent = `${mat.label} ${f.label}`;
    if (!prev || prev.material !== s.material) {
      render(materialSeg, MATERIALS.map((m) => h('button', {
        class: 'seg', type: 'button', role: 'radio', 'aria-checked': String(m.key === s.material),
        title: m.note, onclick: () => app.setMaterial(m.key),
      }, m.label)));
      materialNote.textContent = `${mat.note} Densità ${num(mat.density, 2)} g/cm³.`;
    }
    if (infill.value !== String(s.infill)) infill.value = String(s.infill);
    if (spoolSel.value !== String(s.spoolG)) spoolSel.value = String(s.spoolG);
    if (document.activeElement !== priceInput) priceInput.value = String(app.price(s));
    swatches.querySelectorAll<HTMLElement>('.swatch').forEach((el) => {
      const on = el.dataset.key === s.filament;
      el.setAttribute('aria-checked', String(on));
      el.tabIndex = on ? 0 : -1;
    });

    // size: preview the box at the new size before it is applied
    const target = s.settings.target_size_mm;
    // number inputs take a dot decimal; the browser shows it in the user's locale
    if (document.activeElement !== sizeInput) sizeInput.value = String(Math.round(target * 10) / 10);
    sizeRange.max = String(Math.max(300, Math.ceil(target)));
    sizeRange.value = String(target);
    const base0 = app.size(s);
    const box = base0 ? scaled(base0, target) : null;
    const fit = box ? fitOnBed(box, p) : null;
    render(bedPlan, planSVG(p.w, p.d, box, fit?.rotated ?? false, fit?.fits ?? true));
    if (!box || !fit) {
      fitLine.className = 'fit-line';
      fitLine.textContent = p.label;
      fitDims.textContent = `Volume di stampa ${num(p.w)} × ${num(p.d)} × ${num(p.h)} mm`;
      fitAction.hidden = true;
    } else {
      fitLine.className = `fit-line ${fit.fits ? 'is-ok' : 'is-over'}`;
      fitLine.replaceChildren(icon(fit.fits ? 'check' : 'alert'), fit.fits
        ? (fit.rotated ? 'Entra girato di 90°' : 'Entra nel piatto')
        : `Al massimo ${mm(fit.maxSize)} mm`);
      fitDims.textContent = `${dims(box)} mm su ${num(p.w)} × ${num(p.d)} × ${num(p.h)}`;
      fitAction.hidden = fit.fits;
      fitAction.onclick = () => app.setSetting('target_size_mm', Math.floor(fit.maxSize));
    }

    orientSeg.classList.add('segmented-grid');
    render(orientSeg, ORIENTATIONS.map((o) => h('button', {
      class: 'seg', type: 'button', role: 'radio', title: o.title, 'aria-checked': String(s.settings.orientation === o.key),
      onclick: () => app.setSetting('orientation', o.key),
    }, o.label)));
    hollow.input.checked = s.settings.hollow;
    wall.row.hidden = !s.settings.hollow;
    if (document.activeElement !== wall.input) wall.input.value = String(s.settings.wall_mm);
    base.input.checked = s.settings.base_plate;
    baseT.row.hidden = !s.settings.base_plate;
    if (document.activeElement !== baseT.input) baseT.input.value = String(s.settings.base_thickness_mm);
    const dirty = app.dirty(s);
    applyBtn.disabled = !c || !dirty || !!s.busy || app.generating(s);
    applyBtn.replaceChildren(s.busy === 'apply' ? icon('spinner', 14) : '', s.busy === 'apply' ? 'Preparo…' : 'Applica');
    applyNote.textContent = !c ? 'Valgono per il prossimo modello.' : dirty ? 'Modifiche da applicare al modello.' : 'Applicate al modello sul piatto.';

    if (!prev || prev.current !== c || prev.filament !== s.filament || prev.shape !== s.shape || prev.printer !== s.printer ||
      prev.custom !== s.custom || prev.material !== s.material || prev.infill !== s.infill || prev.spoolG !== s.spoolG ||
      prev.prices !== s.prices) {
      renderReport(s);
    }
    prev = s;
  };

  const renderReport = (s: AppState) => {
    const c = s.current;
    if (!c) {
      render(spool, h('p', { class: 'empty' }, 'Appare quando c’è un modello sul piatto: grammi di filamento, misure, sbalzi e riparazioni.'));
      render(kv);
      render(notes);
      render(formats);
      fileName.textContent = 'File 3MF, STL, OBJ o GLB, in millimetri, già riparati e chiusi.';
      return;
    }
    const r = c.report;
    const est = app.estimate(s)!;
    const g = est.grams;
    const mat = materialByKey(s.material);
    const frac = Math.min(1, g / s.spoolG);
    render(spool,
      spoolSVG(frac),
      h('div', { class: 'spool-text' },
        h('p', { class: 'spool-figure num' }, h('span', { class: 'spool-grams' }, grams(g)), h('span', { class: 'spool-unit' }, ' g')),
        h('p', null, `di una bobina da ${spoolLabel(s.spoolG)} di ${mat.label}${est.prints > 1 ? `: ne stampi ${num(est.prints)}` : est.prints === 0 ? ': non basta' : ''}`),
        h('p', { class: 'meta num' }, `≈ ${num(est.metres, 1)} m · ≈ ${euro(est.cost)} · ≈ ${duration(est.minutes)}`)));
    const size = app.size(s) ?? r.bbox_mm;
    const rows: [string, Node | string][] = [
      ['Misure', `${dims(size)} mm`],
      ['Volume', `${num(r.volume_cm3, 1)} cm³ · pieno ${grams(est.solidGrams)} g`],
      ['Mesh', r.watertight ? 'Chiusa e valida' : 'Aperta'],
      ['Pezzi', num(r.components)],
      ['Sbalzi oltre 45°', `${num(r.overhang_pct, 0)}%`],
      ['Copie per piatto', est.copies > 0 ? num(est.copies) : '—'],
      ['Triangoli', num(r.triangles)],
    ];
    render(kv, rows.map(([k, v]) => h('div', { class: 'kv-row' }, h('dt', null, k), h('dd', { class: 'num' }, v))));
    const warn = r.warnings.map((w) => h('p', { class: 'note note-warning' }, icon('alert'), w));
    const repairs = r.repairs.length
      ? h('details', { class: 'repairs' },
        h('summary', null, `Riparazioni (${r.repairs.length}) · ${num(r.process_ms / 1000, 1)} s`),
        h('ul', null, r.repairs.map((x) => h('li', null, x))))
      : h('p', { class: 'meta' }, `Nessuna riparazione necessaria · ${num(r.process_ms / 1000, 1)} s`);
    const fb = c.gen_meta?.fallback_from;
    const time = h('p', { class: 'meta' }, `Tempo e costo sono stime (profilo standard da 0,2 mm, ${Math.round(s.infill * 100)}% di riempimento): lo slicer ti darà quelli esatti.`);
    render(notes, warn, fb ? h('p', { class: 'note' }, `Generato con ${c.model}: ${fb} non era disponibile.`) : null, repairs, time);
    render(formats, FORMATS.map((f) => h('a', {
      class: f.key === '3mf' ? 'btn btn-secondary is-recommended' : 'btn btn-secondary',
      href: c.urls.export[f.key], download: '', title: f.note,
    }, f.label)));
    fileName.replaceChildren(
      h('span', { class: 'file-slug' }, exportName(c, '3mf')),
      h('span', null, '3MF consigliato: conserva i millimetri nello slicer.'),
    );
  };

  app.store.subscribe(update);
  update(app.state);
}

/** The spool as a ring: the arc this print takes from a 1 kg spool, in the filament colour. */
function spoolSVG(frac: number): SVGSVGElement {
  const r = 34, c = 2 * Math.PI * r;
  const used = Math.max(frac > 0 ? 0.012 : 0, frac); // a print of a few grams still shows a mark
  return svg(`<svg class="spool-ring" width="88" height="88" viewBox="0 0 88 88" aria-hidden="true">
    <circle cx="44" cy="44" r="${r}" fill="none" stroke="#262626" stroke-width="7"/>
    <circle cx="44" cy="44" r="${r}" fill="none" stroke="var(--data)" stroke-width="7"
      stroke-dasharray="${(used * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 44 44)"/>
    <circle cx="44" cy="44" r="12" fill="none" stroke="#2e2e2e" stroke-width="2"/>
    <circle cx="44" cy="44" r="3" fill="#2e2e2e"/>
  </svg>`);
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
    foot = `<rect x="${(S - fx) / 2}" y="${(S - fy) / 2}" width="${fx}" height="${fy}" rx="2" fill="${fits ? 'var(--data)' : 'var(--negative)'}" opacity="${fits ? 0.9 : 0.85}"/>`;
  }
  return svg(`<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
    <rect x="${ox}" y="${oy}" width="${bw}" height="${bd}" rx="4" fill="#1a1a1a" stroke="#333" stroke-width="1"/>
    ${foot}
  </svg>`);
}
