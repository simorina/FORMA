/**
 * Application state and actions. UI modules render from the store and call these actions;
 * the viewer is driven from here.
 */
import { ApiError, api, type Job, type Model, type PrintSettings, type ProvidersResponse, type Quality } from './lib/api';
import { DEFAULT_FILAMENT, filamentByKey, uiColor } from './lib/filaments';
import { PRINTERS, fitOnBed, type Printer } from './lib/printers';
import { createStore, saved, type Store } from './lib/store';
import { title } from './lib/format';
import type { SculptState } from './edit/sculpt';
import type { Viewer } from './viewer/viewer';
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
}

export interface AppState {
  providers: ProvidersResponse | null;
  offline: string | null; // backend unreachable
  provider: string;
  modelKey: string | null;
  quality: Quality;
  prompt: string;
  image: File | null;
  imageUrl: string | null;
  settings: PrintSettings;
  printer: string;
  custom: { w: number; d: number; h: number };
  filament: string;
  job: Job | null;
  lastRequest: GenerateRequest | null;
  current: Model | null;
  shape: [number, number, number] | null; // live size in the viewer (changes while sculpting)
  history: Model[];
  historyLoaded: boolean;
  busy: null | 'apply' | 'repair' | 'load';
  edit: boolean;
  sculpt: SculptState;
  autoRotate: boolean;
  panel: Panel;
  sheet: Sheet;
  shortcuts: boolean;
  viewerError: string | null;
}

/** The print settings the panel exposes (the rest keep the backend defaults). */
export const EDITABLE = ['target_size_mm', 'orientation', 'hollow', 'wall_mm', 'base_plate', 'base_thickness_mm'] as const;

const FALLBACK_SETTINGS: PrintSettings = {
  target_size_mm: 100, orientation: 'upright', hollow: false, wall_mm: 2, base_plate: false,
  base_thickness_mm: 2, base_margin_mm: 3, decimate: true, target_faces: 150000, remove_debris: true,
  repair_resolution: 192,
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
    image: null,
    imageUrl: null,
    settings: { ...FALLBACK_SETTINGS, ...saved.get<Partial<PrintSettings>>('settings', {}) },
    printer: saved.get('printer', PRINTERS[0].key),
    custom: saved.get('custom', { w: 200, d: 200, h: 200 }),
    filament: saved.get('filament', DEFAULT_FILAMENT),
    job: null,
    lastRequest: null,
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
    viewerError: null,
  };
}

export class App {
  readonly store: Store<AppState> = createStore(initial());
  viewer: Viewer | null = null;
  private pollTimer = 0;

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

  modelTitle(s = this.state): string {
    // while a new model is being made, the bar names that one (the old one is only dimmed)
    if (this.generating(s) && s.job) return title(s.job.prompt, s.job.prompt ? 'text' : 'image');
    if (s.current) return title(s.current.prompt, s.current.kind);
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
      this.store.set({ history: models, historyLoaded: true });
      if (openLatest && models.length && !this.state.current && !this.generating()) {
        await this.select(models[0], { reveal: false });
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
    return !this.generating(s) && !s.offline && (s.prompt.trim().length > 0 || !!s.image);
  }

  async generate(): Promise<void> {
    const s = this.state;
    if (this.generating()) return;
    if (!s.prompt.trim() && !s.image) {
      toast('Scrivi cosa vuoi stampare o carica una foto.');
      return;
    }
    if (s.edit) this.setEdit(false);
    const req: GenerateRequest = {
      prompt: s.prompt.trim(),
      provider: s.provider,
      model: s.modelKey,
      seed: Math.floor(Math.random() * 2 ** 31),
      quality: s.quality,
      settings: this.pick(s.settings),
      image: s.image,
    };
    await this.submit(req);
  }

  retry(): void {
    const req = this.state.lastRequest;
    if (req) void this.submit({ ...req, seed: Math.floor(Math.random() * 2 ** 31) });
  }

  private async submit(req: GenerateRequest): Promise<void> {
    this.store.set({ lastRequest: req, sheet: null });
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
    this.store.set({ history });
    await this.select(model, { reveal: true });
    this.store.set({ job: null });
    const fb = model.gen_meta?.fallback_from;
    if (fb) toast(`${fb} non era disponibile: modello generato con ${model.model}.`);
  }

  dismissJob(): void {
    window.clearTimeout(this.pollTimer);
    this.store.set({ job: null });
  }

  // -- models ----------------------------------------------------------------------------
  async select(model: Model, opts: { reveal?: boolean; keepView?: boolean } = {}): Promise<void> {
    if (this.state.edit) this.setEdit(false, { silent: true });
    this.store.set({ current: model, shape: null, settings: { ...this.state.settings, ...model.settings }, busy: 'load' });
    try {
      const shape = (await this.viewer?.load(model.urls.mesh, opts)) ?? null;
      if (this.state.current?.id === model.id) this.store.set({ shape });
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
    toast(`Eliminato: ${title(model.prompt, model.kind)}`);
  }

  /** Re-run the print pipeline on the current model with the panel's settings. */
  async apply(): Promise<void> {
    const c = this.state.current;
    if (!c || this.state.busy) return;
    this.store.set({ busy: 'apply' });
    try {
      const model = await api.process({ modelId: c.id, settings: this.pick(this.state.settings) });
      this.replace(model);
      await this.select(model, { keepView: false });
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
      this.store.set({ history: [model, ...this.state.history] });
      this.setEdit(false, { silent: true });
      await this.select(model, { keepView: true });
      toast('Modifiche riparate: il nuovo modello è in cronologia.', { tone: 'positive' });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'negative' });
    } finally {
      this.store.set({ busy: null });
    }
  }

  private replace(model: Model): void {
    this.store.set({ history: this.state.history.map((m) => (m.id === model.id ? model : m)) });
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

  setImage(file: File | null): void {
    const old = this.state.imageUrl;
    if (old) URL.revokeObjectURL(old);
    this.store.set({ image: file, imageUrl: file ? URL.createObjectURL(file) : null });
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
}
