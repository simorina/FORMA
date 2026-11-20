/** Left panel: the prompt or a picture, examples, a mesh to repair, the 3D model to use; and the history tab. */
import type { App, AppState, Source } from '../app';
import { type ImageKind, type ImageRoute, MESH_EXTENSIONS, type ModelInfo, type ProviderInfo, type Quality, type ReliefOptions, routeKey } from '../lib/api';
import { attr, h, prop, render } from '../lib/dom';
import { ago, dims, grams, title } from '../lib/format';
import { icon } from '../lib/icons';
import { DUR, EASE, canAnimate, enter, play, stagger } from '../lib/motion';
import { glide, riseIn, segmented, shown, swap } from './print';

/** Italian examples that read well for the AI models and map to the offline shapes too. */
export const EXAMPLES = [
  'Vaso a collo stretto con la pancia morbida',
  'Pedone degli scacchi in stile classico',
  'Portapenne esagonale',
  'Ingranaggio da 18 denti con mozzo',
  'Razzo spaziale con tre alette',
  'Tazza da caffè con manico ad anello',
];

const PROVIDER_SHORT: Record<string, string> = { hf_remote: 'Remoto', local: 'GPU locale', meshy: 'Meshy', procedural: 'Offline' };
const SOURCES: { key: Source; label: string }[] = [
  { key: 'text', label: 'Testo' },
  { key: 'image', label: 'Immagine' },
  { key: 'relief', label: 'Rilievo' },
];
type Opt<T extends string> = { key: T; label: string; title?: string };
const RELIEF_VARIANTS: Opt<ReliefOptions['variant']>[] = [
  { key: 'high', label: 'Alto', title: 'Rilievo profondo, per la stampa 3D (6 mm se non scegli tu)' },
  { key: 'low', label: 'Basso', title: 'Rilievo leggero, per targhe sottili, incisione laser e CNC (3 mm se non scegli tu)' },
];
const RELIEF_CARVING: Opt<ReliefOptions['carving_mode']>[] = [
  { key: 'emboss', label: 'In rilievo', title: 'Le parti vicine della foto escono dalla lastra' },
  { key: 'engrave', label: 'Inciso', title: 'Le parti vicine della foto sono scavate nella lastra' },
];
const RELIEF_BASE: Opt<'with' | 'without'>[] = [
  { key: 'with', label: 'Con base' },
  { key: 'without', label: 'Senza base', title: 'Lo sfondo viene tolto: resta solo il soggetto' },
];
const RELIEF_BEND: Opt<ReliefOptions['bend_mode']>[] = [
  { key: 'off', label: 'Piatto' },
  { key: 'convex', label: 'Convesso', title: 'La faccia si curva in fuori' },
  { key: 'concave', label: 'Concavo', title: 'La faccia si curva in dentro' },
];
const RELIEF_AXIS: Opt<ReliefOptions['bend_axis']>[] = [
  { key: 'xz', label: 'Ai lati', title: 'Si curvano i bordi destro e sinistro' },
  { key: 'yz', label: 'Sopra e sotto', title: 'Si curvano i bordi in alto e in basso' },
];
const KINDS: { key: ImageKind; label: string; title: string }[] = [
  { key: 'real', label: 'Foto', title: 'Una foto di un oggetto vero: Idol lascia più margine attorno' },
  { key: 'synthetic', label: 'Render o AI', title: 'Un render o un’immagine generata: Idol inquadra più stretto' },
];
/** Where each provider runs a picture, and what it costs. */
const ROUTE_WHERE: Record<string, { where: string; cost: string }> = {
  local: { where: 'GPU locale', cost: 'Sulla tua GPU: nessuna coda e nessuna quota.' },
  hf_remote: { where: 'Hugging Face', cost: 'Sullo Space col tuo token: usa quota GPU, con la coda qualche minuto. Se non risponde te lo dico: nessun ripiego su altri modelli.' },
  meshy: { where: 'Meshy', cost: 'Sul cloud di Meshy con la tua chiave: 30–35 crediti a modello, circa 2–4 minuti. Se non risponde te lo dico: nessun ripiego.' },
};
/** Words of our own for the two models most used with pictures. */
const ROUTE_TEXT: Record<string, string> = {
  'local:idol': 'Sulla tua GPU: nessuna coda e nessuna quota, circa 2 minuti, con i colori. Con Hi3D anche il dettaglio fine.',
  'hf_remote:trellis2': 'Microsoft, sullo Space col tuo token: forma su una griglia fino a 1536³ (qualità Alta), colori dalla texture. Usa quota GPU; con la coda 2–5 minuti. Se lo Space non risponde te lo dico: nessun ripiego.',
};
const QUALITIES: { key: Quality; label: string }[] = [
  { key: 'draft', label: 'Bozza' },
  { key: 'standard', label: 'Standard' },
  { key: 'high', label: 'Alta' },
];

type Model = AppState['history'][number];
interface HistoryRow { li: HTMLLIElement; open: HTMLButtonElement; no: HTMLElement; meta: HTMLElement }

export function mountLeftPanel(root: HTMLElement, app: App): { focusPrompt(): void } {
  // -- tabs ------------------------------------------------------------------------------
  const tabCreate = h('button', { class: 'tab', role: 'tab', id: 'tab-create', 'aria-controls': 'view-create', type: 'button', onclick: () => app.setPanel('create') }, 'Crea');
  const tabHistory = h('button', { class: 'tab', role: 'tab', id: 'tab-history', 'aria-controls': 'view-history', type: 'button', onclick: () => app.setPanel('history') }, 'Cronologia');
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Pannello' }, tabCreate, tabHistory);
  const sheetClose = h('button', { class: 'icon-btn sheet-close', type: 'button', 'aria-label': 'Chiudi', onclick: () => app.store.set({ sheet: null }) }, icon('close'));

  // -- prompt ----------------------------------------------------------------------------
  const prompt = h('textarea', {
    id: 'prompt', class: 'prompt-input', rows: 4, maxlength: 600, spellcheck: 'true',
    placeholder: 'Un vaso a spirale con il collo stretto', 'aria-describedby': 'prompt-hint',
  }) as HTMLTextAreaElement;
  prompt.addEventListener('input', () => app.store.set({ prompt: prompt.value }));
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void app.generate();
    }
  });
  // An example is written into the field: the field flashes, then the words appear from left
  // to right behind a fine ink line. Visual only, over the field: its value is set at once.
  const veil = h('span', { class: 'prompt-veil', 'aria-hidden': 'true' });
  const quill = h('span', { class: 'prompt-quill', 'aria-hidden': 'true' });
  const promptField = h('div', { class: 'prompt-field' }, prompt, veil, quill);
  const stopInscribing = () => {
    for (const el of [veil, quill]) for (const a of el.getAnimations()) a.cancel();
  };
  const inscribe = () => {
    stopInscribing();
    if (!canAnimate()) return;
    const w = promptField.clientWidth;
    const o = { duration: DUR.slow, easing: EASE.inOut };
    void play(veil, [{ opacity: 1, clipPath: 'inset(0 0 0 0)' }, { opacity: 1, clipPath: 'inset(0 0 0 100%)' }], o);
    void play(quill, [
      { opacity: 1, transform: 'translateX(2px)' },
      { opacity: 1, offset: 0.8 },
      { opacity: 0, transform: `translateX(${w - 2}px)` },
    ], o);
  };
  prompt.addEventListener('input', stopInscribing); // typing shows what is typed, now
  const generate = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => app.generate() }, 'Genera');
  const hint = h('span', { id: 'prompt-hint', class: 'meta' }, 'Invio per generare');
  const review = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': 'Mostrami prima l’immagine' }) as HTMLInputElement;
  review.addEventListener('change', () => app.setReview(review.checked));
  const reviewRow = h('label', { class: 'switch-row review-row' },
    h('span', { class: 'switch-text' }, h('span', null, 'Mostrami prima l’immagine'),
      h('span', { class: 'meta' }, 'La approvi, poi parte il 3D: risparmi quota GPU')),
    review);
  // Meshy in place of the switch: as on meshy.ai, the prompt goes straight to its Text to 3D
  const meshyNote = h('p', { class: 'meta meshy-note' },
    'Come su meshy.ai: il prompt va a Meshy così come lo scrivi, prima la forma e poi i colori.');

  // -- or a picture, in the prompt's place --------------------------------------------------
  const sourceSeg = h('div', { class: 'segmented source-seg', role: 'radiogroup', 'aria-label': 'Da dove parte il modello 3D' });
  const imageInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' }) as HTMLInputElement;
  imageInput.addEventListener('change', () => {
    const f = imageInput.files?.[0];
    if (f) app.takeFile(f, { quiet: true });
    imageInput.value = ''; // the same file again must fire change again
  });
  // dropping a picture here, or anywhere in the window, goes through the overlay in main.ts
  const imageBox = h('div', { class: 'image-box', role: 'button', tabindex: 0, 'aria-describedby': 'image-limits' });
  imageBox.addEventListener('click', () => imageInput.click());
  imageBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      imageInput.click();
    }
  });
  const imageChip = h('div', { class: 'image-chip' });
  const kindSeg = h('div', { class: 'segmented kind-seg', role: 'radiogroup', 'aria-label': 'Che immagine è' });
  const kindRow = h('div', { class: 'field-inline kind-row' }, h('span', { class: 'label' }, 'È una'), kindSeg);
  const refine = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': 'Rifinisci con Hi3D' }) as HTMLInputElement;
  refine.addEventListener('change', () => app.setRefine(refine.checked));
  const refineNote = h('span', { class: 'meta' });
  const refineRow = h('label', { class: 'switch-row refine-row' },
    h('span', { class: 'switch-text' }, h('span', null, 'Rifinisci con Hi3D'), refineNote), refine);
  const imageLimits = h('p', { id: 'image-limits', class: 'meta' },
    'PNG, JPG o WEBP. Un oggetto solo e intero, su uno sfondo semplice: lo sfondo lo tolgo io.');
  // -- a bas-relief of the picture (Meshy Relief) ------------------------------------------
  const variantSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Stile del rilievo' });
  const carvingSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Effetto' });
  const baseSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Base' });
  const bendSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Curvatura' });
  const axisSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Asse della curvatura' });
  const numberInput = (label: string, min: number, max: number, step: number, set: (v: number | null) => void) => {
    const input = h('input', { type: 'number', class: 'num-input num', min, max, step, inputmode: 'decimal', 'aria-label': label }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const raw = input.value.trim();
      const v = raw === '' ? null : Math.min(max, Math.max(min, Number(raw.replace(',', '.'))));
      set(v === null || Number.isFinite(v) ? v : null);
    });
    return input;
  };
  const depthInput = numberInput('Profondità in millimetri (vuoto: automatica)', 0, 60, 0.5, (v) => app.setRelief({ carving_depth_mm: v }));
  const baseInput = numberInput('Spessore della base in millimetri', 0.1, 10, 0.1, (v) => app.setRelief({ base_thickness_mm: v ?? 1 }));
  const angleInput = numberInput('Angolo della curvatura in gradi', 0, 360, 5, (v) => app.setRelief({ bend_angle: v ?? 60 }));
  const unit = (input: HTMLElement, u: string) => h('span', { class: 'with-unit' }, input, h('span', { class: 'meta' }, u));
  const row = (label: string, ...control: HTMLElement[]) => h('div', { class: 'field-inline relief-row' }, h('span', { class: 'label' }, label), ...control);
  // a row of buttons goes under its label, the width of the panel: side by side they would not fit
  const stack = (label: string, control: HTMLElement) => h('div', { class: 'relief-row relief-stack' }, h('span', { class: 'label' }, label), control);
  const baseThickRow = row('Spessore', unit(baseInput, 'mm'));
  const angleRow = row('Angolo', unit(angleInput, '°'));
  const axisRow = stack('Asse', axisSeg);
  const reliefNote = h('p', { class: 'meta relief-note' });
  const reliefFields = h('div', { class: 'relief-fields' },
    stack('Rilievo', variantSeg), stack('Effetto', carvingSeg), row('Profondità', unit(depthInput, 'mm')),
    stack('Base', baseSeg), baseThickRow, stack('Curvatura', bendSeg), angleRow, axisRow, reliefNote);
  const imageField = h('div', { class: 'image-field' }, imageBox, imageChip, kindRow, refineRow, reliefFields, imageLimits, imageInput);

  // -- examples --------------------------------------------------------------------------
  const examples = h(
    'ul',
    { class: 'examples' },
    EXAMPLES.map((text) =>
      h('li', null, h('button', {
        class: 'example', type: 'button',
        onclick: () => {
          prompt.value = text;
          app.store.set({ prompt: text });
          app.setSource('text'); // an example is words: back to the prompt
          prompt.focus();
          inscribe();
        },
      }, text)),
    ),
  );

  // -- a mesh to repair (a picture dropped here still goes to the picture box) ----------------
  const accept = [...MESH_EXTENSIONS.map((e) => `.${e}`), 'image/png', 'image/jpeg', 'image/webp'].join(',');
  const file = h('input', { type: 'file', accept, class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' }) as HTMLInputElement;
  const take = (f: File | undefined | null) => {
    if (f) app.takeFile(f, { quiet: true });
  };
  file.addEventListener('change', () => {
    take(file.files?.[0]);
    file.value = ''; // the same file again must fire change again
  });
  const drop = h(
    'div',
    { class: 'drop', role: 'button', tabindex: 0, 'aria-describedby': 'photo-limits', 'aria-label': 'Scegli una mesh da riparare' },
    icon('cube'),
    h('span', null, 'Trascina una mesh, o ', h('span', { class: 'link' }, 'scegli un file')),
  );
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      file.click();
    }
  });
  // dropping a file here, or anywhere in the window, goes through the overlay in main.ts
  const photoLimits = h('p', { id: 'photo-limits', class: 'meta' },
    'STL, OBJ, 3MF, GLB o PLY, fino a 512 MB: la chiudo, la riparo e la preparo per la stampa.');

  // -- model -----------------------------------------------------------------------------
  const providerSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Dove generare' });
  const providerNote = h('p', { class: 'meta provider-note' });
  const models = h('div', { class: 'models', role: 'radiogroup', 'aria-label': 'Modello immagine→3D' });
  const qualitySeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Qualità' });
  // From a picture: Idol on this GPU or TRELLIS.2 on its Space (the backend's IMAGE_TO_3D)
  const imageRoute = h('div', { class: 'image-route', role: 'radiogroup', 'aria-label': 'Modello per le immagini' });
  // From a picture, as a relief: only Meshy Relief, drawn as the chosen model
  const reliefCard = h('div', { class: 'image-route' });

  const viewCreate = h(
    'div',
    { class: 'view', id: 'view-create', role: 'tabpanel', 'aria-labelledby': 'tab-create' },
    h('section', { class: 'block block-prompt' },
      h('p', { class: 'kicker', 'aria-hidden': 'true' }, 'Su misura'),
      h('label', { class: 'prompt-label', for: 'prompt' }, 'Cosa vuoi ', h('em', null, 'stampare?')),
      sourceSeg,
      promptField,
      imageField,
      h('div', { class: 'prompt-foot' }, hint, generate),
      reviewRow, meshyNote),
    h('section', { class: 'block block-examples' },
      h('h2', { class: 'label' }, 'Ispirazioni'),
      examples),
    h('section', { class: 'block block-upload' },
      h('h2', { class: 'label' }, 'Ripara una mesh'),
      drop, photoLimits, file),
    h('section', { class: 'block block-model' },
      h('h2', { class: 'label' }, 'Modello 3D'),
      providerSeg, providerNote, models, imageRoute, reliefCard,
      h('div', { class: 'field-inline' }, h('span', { class: 'label' }, 'Qualità'), qualitySeg)),
  );

  // -- history ---------------------------------------------------------------------------
  const historyCount = h('span', { class: 'meta' });
  const historyList = h('ul', { class: 'history' });
  const historyHead = h('div', { class: 'history-head' }, h('h2', { class: 'section-title' }, 'Cronologia'), historyCount);
  const viewHistory = h(
    'div',
    { class: 'view', id: 'view-history', role: 'tabpanel', 'aria-labelledby': 'tab-history' },
    historyHead,
    historyList,
  );

  root.append(h('div', { class: 'panel-head' }, tabs, sheetClose), viewCreate, viewHistory);
  // the first time in, the examples rise one after the other while the panel settles
  void stagger(examples.children, (el, d) => enter.rise(el, d, 10, DUR.base), 45, 10, 260);

  // -- rendering -------------------------------------------------------------------------
  // the choices stay in place (only their marks move) and the ink glides between them
  const provider = segmented(providerSeg, (v) => app.setProvider(v));
  const source = segmented<Source>(sourceSeg, (v) => {
    app.setSource(v);
    if (v === 'text') prompt.focus();
  });
  const kind = segmented<ImageKind>(kindSeg, (v) => app.setImageKind(v));
  const quality = segmented<Quality>(qualitySeg, (q) => app.setQuality(q));
  const variant = segmented<ReliefOptions['variant']>(variantSeg, (v) => app.setRelief({ variant: v }));
  const carving = segmented<ReliefOptions['carving_mode']>(carvingSeg, (v) => app.setRelief({ carving_mode: v }));
  const base = segmented<'with' | 'without'>(baseSeg, (v) => app.setRelief({ remove_base: v === 'without' }));
  const bend = segmented<ReliefOptions['bend_mode']>(bendSeg, (v) => app.setRelief({ bend_mode: v }));
  const axis = segmented<ReliefOptions['bend_axis']>(axisSeg, (v) => app.setRelief({ bend_axis: v }));
  const tabLine = glide(tabs, '.tab[aria-selected="true"]', 'line');

  const modelRow = (m: ModelInfo, selected: boolean) =>
    h('button', {
      class: 'model', type: 'button', role: 'radio', 'aria-checked': String(selected),
      onclick: () => app.setModel(m.key),
    },
      h('span', { class: 'model-top' },
        h('span', { class: 'model-name' }, m.label),
        m.eu_restricted ? h('span', { class: 'pill pill-negative' }, 'Non valido in UE') : h('span', { class: 'model-license' }, m.license)),
      selected ? h('span', { class: 'model-desc' }, m.description) : null,
      selected ? m.notes.map((n) => h('span', { class: m.eu_restricted ? 'model-note is-warning' : 'model-note' }, n)) : null,
    );

  // The history keeps its rows (a row is made once per model it shows): choosing a model only
  // moves the marks, so the list does not flash, and a model that arrives slides in on top
  // while the others make room.
  const rows = new Map<Model, HistoryRow>();
  let listed: string[] = []; // the ids drawn, in order (none while it shows a placeholder)
  const historyRow = (m: Model): HistoryRow => {
    const name = title(m.title || m.prompt, m.kind);
    let armed = false;
    const del = h('button', { class: 'icon-btn history-delete', type: 'button', 'aria-label': `Elimina ${name}`, title: 'Elimina' }, icon('trash'));
    del.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        del.classList.add('is-armed');
        del.replaceChildren('Elimina?');
        window.setTimeout(() => {
          armed = false;
          del.classList.remove('is-armed');
          del.replaceChildren(icon('trash'));
        }, 3000);
        return;
      }
      void app.remove(m);
    });
    // the thumbnail fades up once it has loaded (lazily, as the list scrolls)
    const thumb = h('img', { class: 'thumb', src: m.urls.thumb, alt: '', width: 48, height: 48, loading: 'lazy' }) as HTMLImageElement;
    if (!thumb.complete) {
      thumb.classList.add('is-loading');
      const done = () => thumb.classList.remove('is-loading');
      thumb.addEventListener('load', done, { once: true });
      thumb.addEventListener('error', done, { once: true });
    }
    const no = h('span', { class: 'history-no num', 'aria-hidden': 'true' });
    const meta = h('span', { class: 'history-meta num' });
    const open = h('button', { class: 'history-open', type: 'button', 'aria-current': 'false', onclick: () => void app.select(m, { reveal: true }, { sheet: null }) },
      thumb,
      h('span', { class: 'history-text' }, no, h('span', { class: 'history-title' }, name), meta));
    return { li: h('li', { class: 'history-row' }, open, del), open, no, meta };
  };
  const syncHistory = (s: AppState, live: boolean) => {
    if (!s.history.length) {
      rows.clear();
      listed = [];
      const text = s.historyLoaded
        ? 'Ancora nessun modello. Ogni modello che generi resta qui, con le sue impostazioni di stampa.'
        : 'Carico la cronologia…';
      const only = historyList.children.length === 1 ? historyList.firstElementChild : null;
      if (!only?.classList.contains('empty') || only.textContent !== text) render(historyList, h('li', { class: 'empty' }, text));
      return;
    }
    const moving = live && canAnimate() && shown(historyList);
    const tops = new Map<string, number>(); // where each row was, for the ones that move
    if (moving) for (const [m, r] of rows) if (r.li.isConnected) tops.set(m.id, r.li.getBoundingClientRect().top);
    const keep = new Set(s.history);
    for (const m of [...rows.keys()]) if (!keep.has(m)) rows.delete(m);
    const n = s.history.length;
    const lis = s.history.map((m, i) => {
      let r = rows.get(m);
      if (!r) rows.set(m, (r = historyRow(m)));
      const on = s.current?.id === m.id;
      prop(r.li, 'className', on ? 'history-row is-current' : 'history-row');
      attr(r.open, 'aria-current', on ? 'true' : 'false');
      prop(r.no, 'textContent', `N° ${String(n - i).padStart(2, '0')}`);
      prop(r.meta, 'textContent', `${dims(m.report.bbox_mm)} mm · ${grams(m.report.pla_grams_typical)} g · ${ago(m.created_at)}`);
      return r.li;
    });
    const kids = historyList.children;
    if (kids.length !== lis.length || lis.some((li, i) => kids[i] !== li)) historyList.replaceChildren(...lis);
    const was = listed;
    listed = s.history.map((m) => m.id);
    if (!moving) return;
    if (!was.length) {
      void stagger(lis, (el, d) => enter.rise(el, d, 8, 340), 30, 4); // the list's first rows
      return;
    }
    const seen = new Set(was);
    lis.forEach((li, i) => {
      if (!seen.has(listed[i])) {
        // a new model: in from the left, once the rows under it have begun to make room
        void play(li, [{ opacity: 0, transform: 'translateX(-16px)' }, { opacity: 1, transform: 'none' }],
          { delay: 80, duration: 360, easing: EASE.out, fill: 'backwards' });
        return;
      }
      const top = tops.get(listed[i]);
      const dy = top === undefined ? 0 : top - li.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) void play(li, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: DUR.base, easing: EASE.inOut });
    });
  };

  let prev: AppState | null = null;
  const update = (s: AppState) => {
    const live = !!prev; // the first draw is the page itself: nothing comes in
    if (!prev || prev.panel !== s.panel) {
      attr(tabCreate, 'aria-selected', String(s.panel === 'create'));
      attr(tabHistory, 'aria-selected', String(s.panel === 'history'));
      prop(viewCreate, 'hidden', s.panel !== 'create');
      prop(viewHistory, 'hidden', s.panel !== 'history');
      tabLine(live);
      // the view that comes in rises, block after block
      if (live) void riseIn(s.panel === 'create' ? viewCreate.children : [historyHead, ...historyList.children]);
    }
    prop(prompt, 'value', s.prompt);
    const empty = !s.current && !s.job;
    root.classList.toggle('is-first-run', empty);
    const working = app.working(s);
    prop(generate, 'className', `btn ${s.current ? 'btn-secondary' : 'btn-primary'}`);
    // stays enabled with an empty prompt: pressing it explains what is missing
    prop(generate, 'disabled', working || !!s.offline);
    prop(generate, 'textContent', working ? 'In corso…' : s.current ? 'Genera di nuovo' : 'Genera');
    prop(review, 'checked', s.reviewImage);
    const fromImage = s.source === 'image';
    const asRelief = s.source === 'relief';
    const fromPicture = fromImage || asRelief;
    const meshy = s.provider === 'meshy';
    prop(reviewRow, 'hidden', fromPicture || meshy); // a picture is already the image
    prop(meshyNote, 'hidden', fromPicture || !meshy);
    prop(hint, 'textContent', asRelief ? 'Il rilievo parte dalla foto' : fromImage ? 'Il modello 3D parte dall’immagine' : 'Invio per generare');
    if (!prev || prev.source !== s.source) {
      source(SOURCES, s.source, live);
      const wasPicture = !!prev && prev.source !== 'text';
      prop(promptField, 'hidden', fromPicture);
      prop(imageField, 'hidden', !fromPicture);
      // the field that comes in rises in the place of the other
      if (live && fromPicture !== wasPicture) void enter.rise(fromPicture ? imageField : promptField, 0, 8, DUR.base);
      if (live && asRelief) void enter.rise(reliefFields, 0, 8, DUR.base);
    }
    if (!prev || prev.imageKind !== s.imageKind) kind(KINDS, s.imageKind, live);
    const routes = app.imageRoutes(s);
    const route = app.imageRoute(s);
    // only Idol frames a photo and a render differently, and only its shape goes to Hi3D
    prop(kindRow, 'hidden', asRelief || route?.model !== 'idol');
    prop(refineRow, 'hidden', asRelief || route?.model !== 'idol');
    prop(reliefFields, 'hidden', !asRelief);
    if (asRelief) {
      const r = s.relief;
      variant(RELIEF_VARIANTS, r.variant, live);
      carving(RELIEF_CARVING, r.carving_mode, live);
      base(RELIEF_BASE, r.remove_base ? 'without' : 'with', live);
      bend(RELIEF_BEND, r.bend_mode, live);
      axis(RELIEF_AXIS, r.bend_axis, live);
      if (document.activeElement !== depthInput) prop(depthInput, 'value', r.carving_depth_mm === null ? '' : String(r.carving_depth_mm));
      prop(depthInput, 'placeholder', `auto · ${r.variant === 'high' ? 6 : 3}`);
      if (document.activeElement !== baseInput) prop(baseInput, 'value', String(r.base_thickness_mm));
      if (document.activeElement !== angleInput) prop(angleInput, 'value', String(r.bend_angle));
      prop(baseThickRow, 'hidden', r.remove_base);
      prop(angleRow, 'hidden', r.bend_mode === 'off');
      prop(axisRow, 'hidden', r.bend_mode === 'off');
      const size = Math.min(250, Math.max(20, s.settings.target_size_mm));
      const points = s.quality === 'high' ? 2048 : s.quality === 'draft' ? 512 : 1024;
      prop(reliefNote, 'textContent', `Lato lungo ${size.toLocaleString('it-IT')} mm (da Dimensioni, 20–250), ${points} punti per lato in qualità ${s.quality === 'high' ? 'Alta' : s.quality === 'draft' ? 'Bozza' : 'Standard'}. Sdraiato sul piatto, faccia in su.`);
    }
    prop(refine, 'checked', s.refine);
    const grid = s.quality === 'high' ? '1536³' : s.quality === 'draft' ? '512³' : '1024³';
    const minutes = s.quality === 'high' ? 'circa 8' : s.quality === 'draft' ? 'circa 1' : 'circa 4';
    prop(refineNote, 'textContent', s.refine
      ? `Dopo Idol, la geometria passa a Hi3D sullo Space Hugging Face, col tuo token: dettaglio a ${grid}, ${minutes} minuti di quota GPU. Se non risponde, resta la forma di Idol.`
      : 'Solo Idol, tutto sulla tua GPU.');
    // from a picture: the models the backend allows for pictures replace the provider lists
    for (const el of [providerSeg, providerNote, models]) prop(el, 'hidden', fromPicture);
    prop(imageRoute, 'hidden', !fromImage);
    prop(reliefCard, 'hidden', !asRelief);
    if (asRelief && (!prev || prev.providers !== s.providers || prev.source !== s.source)) {
      const meshy = s.providers?.providers.find((p) => p.name === 'meshy');
      const ok = !!meshy?.available;
      render(reliefCard, h('div', { class: 'model image-route-card', 'aria-current': 'true' },
        h('span', { class: 'model-top' }, h('span', { class: 'model-name' }, 'Meshy Relief'),
          ok ? h('span', { class: 'model-license' }, 'Meshy') : h('span', { class: 'pill pill-negative' }, 'Non disponibile')),
        h('span', { class: 'model-desc' }, 'Da una foto un bassorilievo pronto da stampare, in millimetri: lastra con il soggetto in rilievo o inciso, anche curva. 20 crediti Meshy, circa 1–2 minuti.'),
        ok ? null : h('span', { class: 'model-note is-warning' }, meshy?.reason || 'Meshy non è configurato.')));
    }
    if (!prev || prev.providers !== s.providers || prev.source !== s.source || prev.imageModel !== s.imageModel) {
      const card = (r: ImageRoute) => {
        const key = routeKey(r);
        const chosen = route !== undefined && key === routeKey(route);
        const where = ROUTE_WHERE[r.provider];
        const tag = !r.available ? h('span', { class: 'pill pill-negative' }, 'Non disponibile')
          : r.eu_restricted ? h('span', { class: 'pill pill-negative' }, 'Non valido in UE')
            : h('span', { class: 'model-license' }, where?.where ?? r.provider);
        const text = ROUTE_TEXT[key] ?? [r.description, where?.cost].filter(Boolean).join(' ');
        return h('button', {
          class: 'model image-route-card', type: 'button', role: 'radio', 'aria-checked': String(chosen),
          'data-route': key, onclick: () => app.setImageModel(key),
        },
        h('span', { class: 'model-top' }, h('span', { class: 'model-name' }, r.label), tag),
        chosen ? h('span', { class: 'model-desc' }, text || `Il modello 3D lo fa ${r.label}.`) : null,
        chosen && !r.available ? h('span', { class: 'model-note is-warning' }, r.reason) : null,
        chosen && r.eu_restricted ? (r.notes ?? []).map((n) => h('span', { class: 'model-note is-warning' }, n)) : null);
      };
      render(imageRoute, routes.length ? routes.map(card) : h('p', { class: 'meta' }, 'Carico i modelli…'));
      if (live && fromImage && prev?.source !== s.source) void stagger(imageRoute.children, (el, d) => enter.rise(el, d, 8, DUR.base), 35, 2);
    }

    if (!prev || prev.imageUrl !== s.imageUrl) {
      imageBox.classList.toggle('has-image', !!s.image);
      attr(imageBox, 'aria-label', s.image ? `Cambia l’immagine (${s.image.name})` : 'Scegli l’immagine da cui fare il modello 3D');
      render(imageBox, s.image && s.imageUrl
        ? h('img', { class: 'image-preview', src: s.imageUrl, alt: 'Immagine scelta' })
        : [icon('image'),
          h('span', { class: 'image-box-text' },
            h('span', { class: 'image-box-title' }, 'Trascina qui un’immagine'),
            h('span', { class: 'meta' }, 'o ', h('span', { class: 'link' }, 'scegli un file'), ', o incollala'))]);
      render(imageChip, s.image
        ? h('div', { class: 'photo-chip' },
          h('span', { class: 'photo-name' }, s.image.name),
          h('button', { class: 'btn btn-ghost image-change', type: 'button', onclick: () => imageInput.click() }, 'Cambia'),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Togli l’immagine', onclick: () => app.setImage(null) }, icon('close')))
        : null);
      if (live && s.image && imageBox.firstElementChild) void enter.rise(imageBox.firstElementChild, 0, 8, DUR.base);
    }

    if (!prev || prev.providers !== s.providers || prev.provider !== s.provider || prev.modelKey !== s.modelKey || prev.offline !== s.offline) {
      const list: ProviderInfo[] = s.providers?.providers ?? [];
      provider(list.map((p) => ({
        key: p.name, label: PROVIDER_SHORT[p.name] ?? p.label, disabled: !p.available, title: p.available ? p.description : p.reason,
      })), s.provider, live);
      const info = list.find((p) => p.name === s.provider);
      const note = s.offline
        ? s.offline
        : info ? (info.reason || info.description) : 'Carico i modelli…';
      if (providerNote.textContent !== note) {
        providerNote.textContent = note;
        if (live) void swap(providerNote);
      }
      render(models, (info?.models ?? []).map((m) => modelRow(m, m.key === s.modelKey)));
      if (prev && canAnimate() && shown(models)) {
        if (prev.providers !== s.providers || prev.provider !== s.provider) {
          void stagger(models.children, (el, d) => enter.rise(el, d, 8, 340), 35, 3); // another list
        } else if (prev.modelKey !== s.modelKey) {
          // the chosen model opens: its description and notes come in under its name
          void stagger(models.querySelectorAll('[aria-checked="true"] :is(.model-desc, .model-note)'), (el, d) => enter.rise(el, d, 6, DUR.short), 40, 4);
        }
      }
    }
    if (!prev || prev.quality !== s.quality) {
      quality(QUALITIES, s.quality, live);
    }
    if (!prev || prev.history !== s.history || prev.current !== s.current || prev.historyLoaded !== s.historyLoaded) {
      prop(historyCount, 'textContent', s.history.length === 1 ? '1 modello' : `${s.history.length} modelli`);
      syncHistory(s, live);
    }
    prev = s;
  };
  app.store.subscribe(update);
  update(app.state);
  return { focusPrompt: () => { app.setPanel('create'); prompt.focus(); } };
}
