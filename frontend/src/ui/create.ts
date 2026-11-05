/** Left panel: the prompt, examples, a photo, the 3D model to use; and the history tab. */
import type { App, AppState } from '../app';
import { MESH_EXTENSIONS, type ModelInfo, type ProviderInfo, type Quality } from '../lib/api';
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

const PROVIDER_SHORT: Record<string, string> = { hf_remote: 'Remoto', local: 'GPU locale', procedural: 'Offline' };
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
          prompt.focus();
          inscribe();
        },
      }, text)),
    ),
  );

  // -- photo or mesh ----------------------------------------------------------------------
  const accept = ['image/png', 'image/jpeg', 'image/webp', ...MESH_EXTENSIONS.map((e) => `.${e}`)].join(',');
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
    { class: 'drop', role: 'button', tabindex: 0, 'aria-describedby': 'photo-limits', 'aria-label': 'Scegli una foto o una mesh' },
    icon('image'),
    h('span', null, 'Trascina una foto o una mesh, o ', h('span', { class: 'link' }, 'scegli un file')),
  );
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      file.click();
    }
  });
  // dropping a file here, or anywhere in the window, goes through the overlay in main.ts
  const photo = h('div', { class: 'photo' });
  const photoLimits = h('p', { id: 'photo-limits', class: 'meta' },
    'Foto PNG, JPG o WEBP: un oggetto solo, su sfondo semplice. Mesh STL, OBJ, 3MF, GLB o PLY: la riparo e la preparo per la stampa. Fino a 128 MB.');

  // -- model -----------------------------------------------------------------------------
  const providerSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Dove generare' });
  const providerNote = h('p', { class: 'meta provider-note' });
  const models = h('div', { class: 'models', role: 'radiogroup', 'aria-label': 'Modello immagine→3D' });
  const qualitySeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Qualità' });

  const viewCreate = h(
    'div',
    { class: 'view', id: 'view-create', role: 'tabpanel', 'aria-labelledby': 'tab-create' },
    h('section', { class: 'block block-prompt' },
      h('p', { class: 'kicker', 'aria-hidden': 'true' }, 'Su misura'),
      h('label', { class: 'prompt-label', for: 'prompt' }, 'Cosa vuoi ', h('em', null, 'stampare?')),
      promptField,
      h('div', { class: 'prompt-foot' }, hint, generate),
      reviewRow),
    h('section', { class: 'block block-examples' },
      h('h2', { class: 'label' }, 'Ispirazioni'),
      examples),
    h('section', { class: 'block block-upload' },
      h('h2', { class: 'label' }, 'Da una foto o da una mesh'),
      drop, photo, photoLimits, file),
    h('section', { class: 'block block-model' },
      h('h2', { class: 'label' }, 'Modello 3D'),
      providerSeg, providerNote, models,
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
  const quality = segmented<Quality>(qualitySeg, (q) => app.setQuality(q));
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
    prop(reviewRow, 'hidden', !!s.image); // a photo is already the image
    prop(prompt, 'placeholder', s.image ? 'Facoltativo: descrivi la foto' : 'Un vaso a spirale con il collo stretto');

    if (!prev || prev.imageUrl !== s.imageUrl) {
      prop(drop, 'hidden', !!s.image);
      render(photo, s.image && s.imageUrl
        ? h('div', { class: 'photo-chip' },
          h('img', { src: s.imageUrl, alt: 'Foto scelta', width: 56, height: 56 }),
          h('span', { class: 'photo-name' }, s.image.name),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Togli la foto', onclick: () => { app.setImage(null); file.value = ''; } }, icon('close')))
        : null);
      if (live && photo.firstElementChild) void enter.rise(photo.firstElementChild, 0, 8, DUR.base);
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
