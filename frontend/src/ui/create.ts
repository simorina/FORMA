/** Left panel: the prompt, examples, a photo, the 3D model to use; and the history tab. */
import type { App, AppState } from '../app';
import { MESH_EXTENSIONS, type ModelInfo, type ProviderInfo, type Quality } from '../lib/api';
import { attr, h, prop, render } from '../lib/dom';
import { ago, dims, grams, title } from '../lib/format';
import { icon } from '../lib/icons';

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
    'Foto PNG, JPG o WEBP: un oggetto solo, su sfondo semplice. Mesh STL, OBJ, 3MF, GLB o PLY: la riparo e la preparo per la stampa. Fino a 40 MB.');

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
      prompt,
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
  const viewHistory = h(
    'div',
    { class: 'view', id: 'view-history', role: 'tabpanel', 'aria-labelledby': 'tab-history' },
    h('div', { class: 'history-head' }, h('h2', { class: 'section-title' }, 'Cronologia'), historyCount),
    historyList,
  );

  root.append(h('div', { class: 'panel-head' }, tabs, sheetClose), viewCreate, viewHistory);

  // -- rendering -------------------------------------------------------------------------
  const segmented = <T extends string>(
    el: HTMLElement, items: { key: T; label: string; disabled?: boolean; title?: string }[], value: T, set: (v: T) => void,
  ) => {
    render(el, items.map((it) =>
      h('button', {
        class: 'seg', type: 'button', role: 'radio', 'aria-checked': String(it.key === value),
        disabled: it.disabled, title: it.title, onclick: () => set(it.key),
      }, it.label),
    ));
  };

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

  const historyRow = (m: AppState['history'][number], s: AppState, no: number) => {
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
    return h('li', { class: s.current?.id === m.id ? 'history-row is-current' : 'history-row' },
      h('button', { class: 'history-open', type: 'button', 'aria-current': s.current?.id === m.id ? 'true' : 'false', onclick: () => void app.select(m, { reveal: true }, { sheet: null }) },
        h('img', { class: 'thumb', src: m.urls.thumb, alt: '', width: 48, height: 48, loading: 'lazy' }),
        h('span', { class: 'history-text' },
          h('span', { class: 'history-no num', 'aria-hidden': 'true' }, `N° ${String(no).padStart(2, '0')}`),
          h('span', { class: 'history-title' }, name),
          h('span', { class: 'history-meta num' }, `${dims(m.report.bbox_mm)} mm · ${grams(m.report.pla_grams_typical)} g · ${ago(m.created_at)}`))),
      del);
  };

  let prev: AppState | null = null;
  const update = (s: AppState) => {
    if (!prev || prev.panel !== s.panel) {
      attr(tabCreate, 'aria-selected', String(s.panel === 'create'));
      attr(tabHistory, 'aria-selected', String(s.panel === 'history'));
      prop(viewCreate, 'hidden', s.panel !== 'create');
      prop(viewHistory, 'hidden', s.panel !== 'history');
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
    }

    if (!prev || prev.providers !== s.providers || prev.provider !== s.provider || prev.modelKey !== s.modelKey || prev.offline !== s.offline) {
      const list: ProviderInfo[] = s.providers?.providers ?? [];
      segmented(providerSeg, list.map((p) => ({
        key: p.name, label: PROVIDER_SHORT[p.name] ?? p.label, disabled: !p.available, title: p.available ? p.description : p.reason,
      })), s.provider, (v) => app.setProvider(v));
      const info = list.find((p) => p.name === s.provider);
      providerNote.textContent = s.offline
        ? s.offline
        : info ? (info.reason || info.description) : 'Carico i modelli…';
      render(models, (info?.models ?? []).map((m) => modelRow(m, m.key === s.modelKey)));
    }
    if (!prev || prev.quality !== s.quality) {
      segmented(qualitySeg, QUALITIES, s.quality, (q) => app.setQuality(q));
    }
    if (!prev || prev.history !== s.history || prev.current !== s.current || prev.historyLoaded !== s.historyLoaded) {
      prop(historyCount, 'textContent', s.history.length === 1 ? '1 modello' : `${s.history.length} modelli`);
      render(historyList, s.history.length
        ? s.history.map((m, i) => historyRow(m, s, s.history.length - i))
        : h('li', { class: 'empty' }, s.historyLoaded
          ? 'Ancora nessun modello. Ogni modello che generi resta qui, con le sue impostazioni di stampa.'
          : 'Carico la cronologia…'));
    }
    prev = s;
  };
  app.store.subscribe(update);
  update(app.state);
  return { focusPrompt: () => { app.setPanel('create'); prompt.focus(); } };
}
