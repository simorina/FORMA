/**
 * Application state and actions. UI modules render from the store and call these actions;
 * the viewer is driven from here.
 */
import {
  ApiError, MAX_UPLOAD, MESH_EXTENSIONS, api, routeKey,
  DEFAULT_RELIEF, type Draft, type ExportFormat, type ImageKind, type ImageRoute, type Job, type ReliefOptions, type Model, type PrintSettings, type ProvidersResponse, type Quality,
} from './lib/api';
import { DEFAULT_FILAMENT, filamentByKey, uiColor } from './lib/filaments';
import { estimate, materialByKey, type Estimate } from './lib/materials';
import { TOUR_STEPS } from './lib/tour';
import { PRINTERS, fitOnBed, type Printer } from './lib/printers';
import { createStore, sameFields, sameItems, sameJson, saved, type Store } from './lib/store';
import { title } from './lib/format';
import type { SculptState } from './edit/sculpt';
import type { View, Viewer } from './viewer/viewer';
import { toast } from './ui/toast';

export type Panel = 'create' | 'history';
export type Sheet = null | 'create' | 'print';

interface GenerateRequest {
  prompt: string;
  provider: string;
  model: string | null;
  seed: number;
  quality: Quality;
  settings: Partial<PrintSettings>;
  image: File | null;
  imageKind?: ImageKind;
  refine?: string;
  relief?: ReliefOptions | null;
  draft?: string | null;
}

/** What the 3D model starts from: words (turned into a picture first) or a picture. */
export type Source = 'text' | 'image' | 'relief';

export interface AppState {
  providers: ProvidersResponse | null;
  offline: string | null; // backend unreachable
  provider: string;
  modelKey: string | null;
  quality: Quality;
  prompt: string;
  source: Source;
  image: File | null;
  imageUrl: string | null;
  imageKind: ImageKind;
  /** refine Idol's shape with Hi3D on its Hugging Face Space (pictures only) */
  refine: boolean;
  /** the model chosen for pictures ("provider:model"), among the backend's image routes */
  imageModel: string;
  /** how a picture becomes a bas-relief (Meshy Relief) */
  relief: ReliefOptions;
  settings: PrintSettings;
  printer: string;
  custom: { w: number; d: number; h: number };
  filament: string;
  material: string;
  infill: number; // 0..1
  spoolG: number;
  prices: Record<string, number>; // €/kg the user set, per material
  reviewImage: boolean; // approve the picture before the 3D step
  draft: Draft | null;
  drafting: boolean;
  overhang: boolean; // paint overhangs in the viewport
  wireframe: boolean; // show the triangles
  view: View | null; // the quick view the camera is in (null: orbited freely)
  section: number | null; // cut height as a fraction of the model, or null
  job: Job | null;
  current: Model | null;
  shape: [number, number, number] | null; // live size in the viewer (changes while sculpting)
  history: Model[];
  historyLoaded: boolean;
  busy: null | 'apply' | 'repair' | 'load' | 'upload';
  edit: boolean;
  sculpt: SculptState;
  autoRotate: boolean;
  panel: Panel;
  sheet: Sheet;
  shortcuts: boolean;
  /** the guided tour's step, or null when it is closed */
  tour: number | null;
  tourSeen: boolean;
  viewerError: string | null;
}

/** The print settings the panel exposes (the rest keep the backend defaults). */
export const EDITABLE = ['target_size_mm', 'orientation', 'flat_bottom_mm', 'hollow', 'wall_mm', 'base_plate', 'base_thickness_mm'] as const;

const FALLBACK_SETTINGS: PrintSettings = {
  target_size_mm: 100, orientation: 'upright', flat_bottom_mm: 0, hollow: false, wall_mm: 2, base_plate: false,
  base_thickness_mm: 2, base_margin_mm: 3, decimate: true, target_faces: 10000000, remove_debris: true,
  repair_resolution: 384,
};

function initial(): AppState {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  return {
    providers: null,
    offline: null,
    provider: saved.get('provider', ''),
    modelKey: saved.get<string | null>('model', null),
    quality: saved.get<Quality>('quality', 'standard'),
    prompt: '',
    source: 'text',
    image: null,
    imageUrl: null,
    imageKind: saved.get<ImageKind>('imageKind', 'real'),
    refine: saved.get('refine', true),
    imageModel: saved.get('imageModel', ''),
    relief: { ...DEFAULT_RELIEF, ...saved.get<Partial<ReliefOptions>>('relief', {}) },
    settings: { ...FALLBACK_SETTINGS, ...saved.get<Partial<PrintSettings>>('settings', {}) },
    printer: saved.get('printer', PRINTERS[0].key),
    custom: saved.get('custom', { w: 200, d: 200, h: 200 }),
    filament: saved.get('filament', DEFAULT_FILAMENT),
    material: saved.get('material', 'pla'),
    infill: saved.get('infill', 0.15),
    spoolG: saved.get('spool', 1000),
    prices: saved.get<Record<string, number>>('prices', {}),
    reviewImage: saved.get('reviewImage', true),
    draft: null,
    drafting: false,
    overhang: false,
    wireframe: false,
    view: 'iso',
    section: null,
    job: null,
    current: null,
    shape: null,
    history: [],
    historyLoaded: false,
    busy: null,
    edit: false,
    sculpt: { tool: 'grab', radius: 8, strength: 0.5, falloff: 'smooth', symmetry: true, canUndo: false, canRedo: false, steps: 0 },
    autoRotate: saved.get('autoRotate', !reduce),
    panel: 'create',
    sheet: null,
    shortcuts: false,
    tour: null,
    tourSeen: saved.get('tourSeen', false),
    viewerError: null,
  };
}

export class App {
  // the viewer reports its size and sculpt state as fresh copies, and polling refetches the job:
  // equal values must not wake every panel
  readonly store: Store<AppState> = createStore(initial(), { shape: sameItems, sculpt: sameFields, job: sameJson });
  viewer: Viewer | null = null;
  /** Opens the download popup (ui/download.ts mounts it). */
  downloader: ((model: Model, fmt: ExportFormat) => void) | null = null;
  private pollTimer = 0;
  /** for Riprova; no view shows it, so it stays out of the store (a set would wake every panel) */
  private lastRequest: GenerateRequest | null = null;

  get state(): AppState {
    return this.store.get();
  }

  // -- derived ---------------------------------------------------------------------------
  printer(s = this.state): Printer {
    const p = PRINTERS.find((x) => x.key === s.printer) ?? PRINTERS[0];
    return p.key === 'custom' ? { ...p, ...s.custom } : p;
  }

  /** Size of the model as it will print: the live viewer size, else the report's box. */
  size(s = this.state): [number, number, number] | null {
    return s.shape ?? s.current?.report.bbox_mm ?? null;
  }

  fits(s = this.state): boolean {
    const size = this.size(s);
    return !size || fitOnBed(size, this.printer(s)).fits;
  }

  dirty(s = this.state): boolean {
    const c = s.current;
    if (!c) return false;
    return EDITABLE.some((k) => {
      const a = s.settings[k], b = c.settings[k];
      return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > 1e-6 : a !== b;
    });
  }

  generating(s = this.state): boolean {
    return !!s.job && (s.job.status === 'queued' || s.job.status === 'running');
  }

  /** Something is cooking: a job, a preview image or a mesh being repaired. */
  working(s = this.state): boolean {
    return this.generating(s) || s.drafting || s.busy === 'upload';
  }

  price(s = this.state): number {
    return s.prices[s.material] ?? materialByKey(s.material).price;
  }

  /** Grams, metres, cost, time and copies for the current model with the user's choices. */
  estimate(s = this.state): Estimate | null {
    const r = s.current?.report;
    if (!r) return null;
    const p = this.printer(s);
    return estimate(
      { volume_cm3: r.volume_cm3, surface_cm2: r.surface_cm2, bbox_mm: this.size(s) ?? r.bbox_mm },
      {
        density: materialByKey(s.material).density, infill: s.infill, spoolG: s.spoolG,
        pricePerKg: this.price(s), flow: p.flow, layerS: p.layerS, bed: { w: p.w, d: p.d },
      },
    );
  }

  modelTitle(s = this.state): string {
    // while a new model is being made, the bar names that one (the old one is only dimmed)
    if (s.draft) return title(s.draft.prompt, 'text');
    if (s.drafting && s.prompt.trim()) return title(s.prompt, 'text');
    if (this.generating(s) && s.job) return title(s.job.prompt, s.job.prompt ? 'text' : 'image');
    if (s.current) return title(s.current.title || s.current.prompt, s.current.kind);
    return 'Nuovo modello';
  }

  // -- startup ---------------------------------------------------------------------------
  async init(): Promise<void> {
    this.applyFilament();
    try {
      const providers = await api.providers();
      const names = providers.providers.map((p) => p.name);
      let provider = this.state.provider;
      if (!names.includes(provider) || !providers.providers.find((p) => p.name === provider)?.available) {
        provider = providers.default;
      }
      this.store.set({ providers, provider, offline: null });
      this.ensureModelKey();
    } catch (e) {
      this.store.set({ offline: e instanceof Error ? e.message : String(e) });
      return;
    }
    await this.loadHistory(true);
  }

  async loadHistory(openLatest = false): Promise<void> {
    try {
      const { models } = await api.models();
      const loaded = { history: models, historyLoaded: true };
      if (openLatest && models.length && !this.state.current && !this.generating()) {
        await this.select(models[0], { reveal: false }, loaded);
      } else {
        this.store.set(loaded);
      }
    } catch {
      this.store.set({ historyLoaded: true });
    }
  }

  private ensureModelKey(): void {
    const info = this.state.providers?.providers.find((p) => p.name === this.state.provider);
    if (!info) return;
    if (!info.models.some((m) => m.key === this.state.modelKey)) {
      const def = info.models.find((m) => m.default) ?? info.models[0];
      this.store.set({ modelKey: def?.key ?? null });
    }
  }

  // -- generation ------------------------------------------------------------------------
  canGenerate(s = this.state): boolean {
    return !this.working(s) && !s.offline && (s.source === 'text' ? s.prompt.trim().length > 0 : !!s.image);
  }

  private request(s: AppState, extra: Partial<GenerateRequest> = {}): GenerateRequest {
    const image = s.source === 'text' ? null : s.image;
    const relief = s.source === 'relief';
    // a picture goes only where the backend sends pictures (Idol on this GPU), whatever is chosen for text
    const route = image && !relief ? this.imageRoute(s) : undefined;
    return {
      // from a picture, its file name names the model ("gufo-ceramica.png": "gufo ceramica")
      prompt: image ? image.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() : s.prompt.trim(),
      provider: relief ? 'meshy' : route?.provider ?? s.provider,
      model: relief ? 'relief' : route ? route.model || null : s.modelKey,
      seed: Math.floor(Math.random() * 2 ** 31),
      quality: s.quality,
      settings: this.pick(s.settings),
      image,
      imageKind: s.imageKind,
      refine: image && s.refine && route?.model === 'idol' ? 'hi3d' : '',
      relief: relief ? s.relief : null,
      ...extra,
    };
  }

  async generate(): Promise<void> {
    const s = this.state;
    if (this.working()) return;
    if (s.source !== 'text' && !s.image) {
      toast(s.source === 'relief'
        ? 'Scegli la foto per il rilievo: trascinala nel riquadro o incollala.'
        : 'Scegli un’immagine: trascinala nel riquadro o incollala.');
      return;
    }
    if (s.source === 'text' && !s.prompt.trim()) {
      toast('Scrivi cosa vuoi stampare, o passa a Immagine.');
      return;
    }
    if (s.edit) this.setEdit(false);
    // From text, show the picture first: the 3D step is the slow one that spends GPU quota.
    // Meshy works as on meshy.ai: the prompt goes straight to its Text to 3D, no picture between.
    if (s.reviewImage && s.source === 'text' && s.provider !== 'meshy') {
      await this.preview();
      return;
    }
    await this.submit(this.request(s));
  }

  /** Make (or remake, with a new seed) the preview image for the prompt. */
  async preview(): Promise<void> {
    const s = this.state;
    const prompt = s.prompt.trim() || s.draft?.prompt || '';
    if (!prompt) return;
    this.store.set({ drafting: true, sheet: null });
    try {
      const draft = await api.image({ prompt, provider: s.provider, seed: Math.floor(Math.random() * 2 ** 31) });
      this.store.set({ draft });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'negative' });
    } finally {
      this.store.set({ drafting: false });
    }
  }

  /** The user likes the picture: make the 3D model from it. */
  async approveDraft(): Promise<void> {
    const d = this.state.draft;
    if (!d || this.working()) return;
    this.store.set({ draft: null });
    await this.submit(this.request(this.state, { prompt: d.prompt, image: null, draft: d.draft_id }));
  }

  cancelDraft(): void {
    this.store.set({ draft: null });
  }

  /** Bring any mesh (STL, OBJ, 3MF, GLB, PLY): repaired and prepared as a new model. */
  async uploadMesh(file: File): Promise<void> {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!MESH_EXTENSIONS.includes(ext)) {
      toast(`Formato non supportato: .${ext}`, { tone: 'negative' });
      return;
    }
    if (this.working()) return;
    if (this.state.edit) this.setEdit(false, { silent: true });
    this.store.set({ busy: 'upload', sheet: null, draft: null });
    try {
      const model = await api.process({
        file, prompt: file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim(),
        settings: this.pick(this.state.settings),
      });
      await this.select(model, { reveal: true }, { history: [model, ...this.state.history] });
      const fixes = model.report.repairs.length;
      toast(fixes ? `Mesh riparata (${fixes} interventi) e pronta per la stampa.` : 'Mesh già valida: preparata per la stampa.', { tone: 'positive' });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'negative' });
    } finally {
      if (this.state.busy === 'upload') this.store.set({ busy: null });
    }
  }

  retry(): void {
    const req = this.lastRequest;
    if (req) void this.submit({ ...req, seed: Math.floor(Math.random() * 2 ** 31) });
  }

  private async submit(req: GenerateRequest): Promise<void> {
    this.lastRequest = req;
    this.store.set({ sheet: null, section: null });
    this.viewer?.setSection(null);
    try {
      const { job } = await api.generate(req);
      this.store.set({ job });
      this.poll(job.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'negative' });
    }
  }

  private poll(id: string): void {
    window.clearTimeout(this.pollTimer);
    const tick = async () => {
      try {
        const job = await api.job(id);
        if (this.state.job?.id !== id) return;
        this.store.set({ job });
        if (job.status === 'done' && job.result) {
          await this.finish(job.result);
          return;
        }
        if (job.status === 'error') return;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          this.store.set({ job: null });
          toast('Il server è stato riavviato e il lavoro è andato perso: riprova.', { tone: 'negative' });
          return;
        }
      }
      this.pollTimer = window.setTimeout(tick, 700);
    };
    this.pollTimer = window.setTimeout(tick, 350);
  }

  private async finish(model: Model): Promise<void> {
    const history = [model, ...this.state.history.filter((m) => m.id !== model.id)];
    await this.select(model, { reveal: true }, { history });
    this.store.set({ job: null });
    const fb = model.gen_meta?.fallback_from;
    if (fb) toast(`${fb} non era disponibile: modello generato con ${model.model}.`);
    // Idol's shape stays when Hi3D cannot refine it: say why
    if (model.gen_meta?.hi3d_error) toast(`Hi3D non ha rifinito la forma: ${model.gen_meta.hi3d_error} Resta quella di Idol.`);
  }

  dismissJob(): void {
    window.clearTimeout(this.pollTimer);
    this.store.set({ job: null });
  }

  // -- models ----------------------------------------------------------------------------
  /** Put a model on the bed. `patch` joins the same update (e.g. the history the model enters). */
  async select(model: Model, opts: { reveal?: boolean; keepView?: boolean } = {}, patch: Partial<AppState> = {}): Promise<void> {
    if (this.state.edit) this.setEdit(false, { silent: true });
    if (this.state.section !== null) this.setSection(null);
    this.store.set({ ...patch, current: model, shape: null, settings: { ...this.state.settings, ...model.settings }, busy: 'load' });
    try {
      const shape = (await this.viewer?.load(model.urls.mesh, opts)) ?? null;
      // the size and the end of the load in one update
      if (this.state.current?.id === model.id) this.store.set(this.state.busy === 'load' ? { shape, busy: null } : { shape });
    } catch (e) {
      if (!(e instanceof Error && e.message === 'superseded')) {
        toast('Non riesco a caricare la mesh di questo modello.', { tone: 'negative' });
      }
    } finally {
      if (this.state.busy === 'load') this.store.set({ busy: null });
    }
  }

  async remove(model: Model): Promise<void> {
    try {
      await api.remove(model.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'negative' });
      return;
    }
    const history = this.state.history.filter((m) => m.id !== model.id);
    this.store.set({ history });
    if (this.state.current?.id === model.id) {
      this.store.set({ current: null, shape: null });
      this.viewer?.clear();
    }
    toast(`Eliminato: ${title(model.title || model.prompt, model.kind)}`);
  }

  /** Re-run the print pipeline on the current model with the panel's settings. */
  async apply(): Promise<void> {
    const c = this.state.current;
    if (!c || this.state.busy) return;
    this.store.set({ busy: 'apply' });
    try {
      const model = await api.process({ modelId: c.id, settings: this.pick(this.state.settings) });
      const history = this.state.history.map((m) => (m.id === model.id ? model : m));
      await this.select(model, { keepView: false }, { history });
      toast('Impostazioni applicate.');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'negative' });
    } finally {
      this.store.set({ busy: null });
    }
  }

  /** "Ripara e aggiorna": send the sculpted mesh through the pipeline as a new model. */
  async repairEdits(): Promise<void> {
    const c = this.state.current;
    const stl = this.viewer?.exportSTL();
    if (!c || !stl || this.state.busy) return;
    this.store.set({ busy: 'repair' });
    try {
      const model = await api.process({
        modelId: c.id, prompt: c.prompt, stl,
        settings: { ...this.pick(this.state.settings), orientation: 'keep' },
      });
      this.setEdit(false, { silent: true });
      await this.select(model, { keepView: true }, { history: [model, ...this.state.history] });
      toast('Modifiche riparate: il nuovo modello è in cronologia.', { tone: 'positive' });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'negative' });
    } finally {
      this.store.set({ busy: null });
    }
  }

  private pick(s: PrintSettings): Partial<PrintSettings> {
    const out: Partial<PrintSettings> = {};
    for (const k of EDITABLE) (out as Record<string, unknown>)[k] = s[k];
    return out;
  }

  // -- settings --------------------------------------------------------------------------
  setSetting<K extends keyof PrintSettings>(key: K, value: PrintSettings[K]): void {
    const settings = { ...this.state.settings, [key]: value };
    this.store.set({ settings });
    saved.set('settings', this.pick(settings));
  }

  setPrinter(key: string): void {
    this.store.set({ printer: key });
    saved.set('printer', key);
    this.viewer?.setPrinter(this.printer());
  }

  setCustom(dims: Partial<{ w: number; d: number; h: number }>): void {
    const custom = { ...this.state.custom, ...dims };
    this.store.set({ custom });
    saved.set('custom', custom);
    this.viewer?.setPrinter(this.printer());
  }

  setFilament(key: string): void {
    this.store.set({ filament: key });
    saved.set('filament', key);
    this.applyFilament();
  }

  private applyFilament(): void {
    const f = filamentByKey(this.state.filament);
    const root = document.documentElement.style;
    root.setProperty('--filament', f.hex);
    root.setProperty('--data', uiColor(f.hex));
    this.viewer?.setFilament(f.hex);
  }

  setMaterial(key: string): void {
    this.store.set({ material: key });
    saved.set('material', key);
  }

  setInfill(v: number): void {
    this.store.set({ infill: v });
    saved.set('infill', v);
  }

  setSpool(g: number): void {
    this.store.set({ spoolG: g });
    saved.set('spool', g);
  }

  setPrice(perKg: number): void {
    const prices = { ...this.state.prices, [this.state.material]: perKg };
    this.store.set({ prices });
    saved.set('prices', prices);
  }

  setReview(on: boolean): void {
    this.store.set({ reviewImage: on });
    saved.set('reviewImage', on);
  }

  toggleWireframe(): void {
    const on = !this.state.wireframe;
    this.store.set({ wireframe: on });
    this.viewer?.setWireframe(on);
  }

  /**
   * A file from the picker, dropped anywhere or pasted: a mesh is repaired and prepared right
   * away, a photo becomes the input of the next generation. `quiet`: the panel shows it already.
   */
  takeFile(f: File, opts: { quiet?: boolean } = {}): 'mesh' | 'image' | null {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (f.size > MAX_UPLOAD) {
      toast('Il file supera 512 MB.', { tone: 'negative' });
      return null;
    }
    if (MESH_EXTENSIONS.includes(ext)) {
      if (this.working()) {
        toast('Sto già lavorando a un modello: riprova quando ho finito.');
        return null;
      }
      void this.uploadMesh(f);
      return 'mesh';
    }
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) {
      toast('Usa una foto PNG, JPG o WEBP, o una mesh STL, OBJ, 3MF, GLB, PLY o OFF.', { tone: 'negative' });
      return null;
    }
    this.setImage(f);
    if (!opts.quiet) {
      this.setPanel('create');
      toast('Immagine pronta: premi Genera per farne un modello 3D.');
    }
    return 'image';
  }

  /** Name the current model (also names its files); empty goes back to the prompt. */
  async rename(model: Model, name: string): Promise<void> {
    const clean = name.split(/\s+/).filter(Boolean).join(' ').slice(0, 120);
    // its prompt (as typed or as shown) is not a title of its own
    const next = clean === title(model.prompt, model.kind) || clean === (model.prompt ?? '').trim() ? '' : clean;
    if (next === (model.title ?? '')) return;
    try {
      const updated = await api.rename(model.id, next);
      this.store.set({
        history: this.state.history.map((m) => (m.id === updated.id ? updated : m)),
        current: this.state.current?.id === updated.id ? updated : this.state.current,
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'negative' });
    }
  }

  toggleOverhang(): void {
    const on = !this.state.overhang;
    this.store.set({ overhang: on });
    this.viewer?.setOverhang(on);
  }

  /** Cut the model at a fraction of its height (null: no cut). */
  setSection(frac: number | null): void {
    this.store.set({ section: frac });
    this.viewer?.setSection(frac);
  }

  setProvider(name: string): void {
    this.store.set({ provider: name });
    saved.set('provider', name);
    this.ensureModelKey();
    saved.set('model', this.state.modelKey);
  }

  setModel(key: string): void {
    this.store.set({ modelKey: key });
    saved.set('model', key);
  }

  setQuality(q: Quality): void {
    this.store.set({ quality: q });
    saved.set('quality', q);
  }

  /** A picture to start from: the box switches to it. None: the box waits for another. */
  setImage(file: File | null): void {
    const old = this.state.imageUrl;
    if (old) URL.revokeObjectURL(old);
    // a picture switches to Immagine, unless the box is making a relief of it
    const source = file && this.state.source === 'text' ? { source: 'image' as const } : {};
    this.store.set({ image: file, imageUrl: file ? URL.createObjectURL(file) : null, ...source });
  }

  setRelief(patch: Partial<ReliefOptions>): void {
    const relief = { ...this.state.relief, ...patch };
    this.store.set({ relief });
    saved.set('relief', relief);
  }

  /** Start from words or from a picture (a picture chosen before stays for when it comes back). */
  setSource(source: Source): void {
    this.store.set({ source, draft: null });
  }

  setImageKind(kind: ImageKind): void {
    this.store.set({ imageKind: kind });
    saved.set('imageKind', kind);
  }

  /** The current model as a file: prepared, checked and fetched in the download popup. */
  download(fmt: ExportFormat): void {
    const c = this.state.current;
    if (!c || !this.downloader) return;
    if (this.state.sculpt.steps > 0) {
      toast('Ripara le modifiche prima di scaricare: il file non le avrebbe.');
      return;
    }
    this.downloader(c, fmt);
  }

  /** The current model in Blender, on this computer: imported, framed, colours showing. */
  async openInBlender(): Promise<void> {
    const c = this.state.current;
    if (!c) return;
    if (this.state.sculpt.steps > 0) {
      toast('Ripara le modifiche prima di aprirlo in Blender: il file non le avrebbe.');
      return;
    }
    try {
      await api.openInBlender(c.id);
      toast('Blender si sta aprendo con il modello a colori (vista Material Preview).');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'negative' });
    }
  }

  /** The models a picture may go to, and the one chosen (the default when none or gone). */
  imageRoutes(s = this.state): ImageRoute[] {
    const p = s.providers;
    return p?.image_routes ?? (p?.image_to_3d ? [p.image_to_3d] : []);
  }

  imageRoute(s = this.state): ImageRoute | undefined {
    const routes = this.imageRoutes(s);
    return routes.find((r) => routeKey(r) === s.imageModel) ?? routes[0];
  }

  setImageModel(key: string): void {
    this.store.set({ imageModel: key });
    saved.set('imageModel', key);
  }

  setRefine(on: boolean): void {
    this.store.set({ refine: on });
    saved.set('refine', on);
  }

  // -- view ------------------------------------------------------------------------------
  setEdit(on = !this.state.edit, opts: { silent?: boolean } = {}): void {
    if (on && !this.state.current) {
      toast('Prima genera o apri un modello da modificare.');
      return;
    }
    if (on && this.generating()) return;
    if (on === this.state.edit) return;
    this.store.set({ edit: on, sheet: null });
    this.viewer?.setEdit(on);
    if (!on && !opts.silent && this.state.sculpt.steps > 0) {
      toast('Le modifiche restano sul modello ma non sono ancora riparate.', {
        action: { label: 'Ripara', run: () => void this.repairEdits() },
      });
    }
  }

  /** Leave edit mode and reload the model as it was before sculpting. */
  async discardEdits(): Promise<void> {
    const c = this.state.current;
    const had = this.state.sculpt.steps > 0;
    this.setEdit(false, { silent: true });
    if (c && had) await this.select(c, { keepView: true });
  }

  toggleAutoRotate(): void {
    const on = !this.state.autoRotate;
    this.store.set({ autoRotate: on });
    saved.set('autoRotate', on);
    this.viewer?.setAutoRotate(on);
  }

  setPanel(panel: Panel): void {
    this.store.set({ panel });
  }

  // -- guided tour -------------------------------------------------------------------------
  /** Open the guided tour at its first step; the "new" mark on its button goes away. */
  startTour(): void {
    saved.set('tourSeen', true);
    this.store.set({ tour: 0, tourSeen: true, shortcuts: false });
  }

  /** Go to a step of the tour; past the last one the tour closes. */
  tourStep(i: number): void {
    if (this.state.tour === null) return;
    if (i >= TOUR_STEPS.length) this.endTour();
    else this.store.set({ tour: Math.max(0, i) });
  }

  endTour(): void {
    if (this.state.tour !== null) this.store.set({ tour: null });
  }
}
