/** Typed client for the Forma FastAPI backend (/api). */

export type Orientation = 'upright' | 'flat' | 'keep';
export type Quality = 'draft' | 'standard' | 'high';

export interface PrintSettings {
  target_size_mm: number;
  orientation: Orientation;
  hollow: boolean;
  wall_mm: number;
  base_plate: boolean;
  base_thickness_mm: number;
  base_margin_mm: number;
  decimate: boolean;
  target_faces: number;
  remove_debris: boolean;
  repair_resolution: number;
}

export interface ModelInfo {
  key: string;
  label: string;
  description: string;
  license: string;
  default: boolean;
  notes: string[];
  eu_restricted: boolean;
}

export interface ProviderInfo {
  name: string;
  label: string;
  description: string;
  available: boolean;
  reason: string;
  models: ModelInfo[];
}

export interface ProvidersResponse {
  default: string;
  hf_token: boolean;
  providers: ProviderInfo[];
  formats: string[];
  defaults: PrintSettings;
}

export interface Report {
  watertight: boolean;
  manifold: boolean;
  volume_cm3: number;
  surface_cm2: number;
  bbox_mm: [number, number, number];
  triangles: number;
  vertices: number;
  pla_grams: number;
  pla_grams_typical: number;
  overhang_pct: number;
  overhang_warning: boolean;
  components: number;
  warnings: string[];
  hollowed: boolean;
  base_plate: boolean;
  repairs: string[];
  process_ms: number;
}

export type ExportFormat = 'stl' | '3mf' | 'obj' | 'glb';

export interface Model {
  id: string;
  prompt: string;
  provider: string | null;
  model: string | null;
  kind: 'text' | 'image' | 'upload' | 'edit';
  has_image?: boolean;
  seed?: number;
  quality?: Quality;
  parent_id?: string;
  gen_meta?: Record<string, string | number>;
  report: Report;
  settings: PrintSettings;
  created_at: number;
  updated_at: number;
  urls: { mesh: string; image: string | null; thumb: string; export: Record<ExportFormat, string> };
}

export type StageStatus = 'pending' | 'active' | 'done' | 'skipped' | 'error';

export interface Stage {
  key: 'image' | 'shape' | 'repair' | 'ready';
  label: string;
  status: StageStatus;
  progress: number;
  message: string;
}

export interface Job {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  stage: string;
  message: string;
  progress: number;
  stages: Stage[];
  error: string | null;
  model_id: string | null;
  image_url: string | null;
  prompt: string | null;
  provider: string;
  model: string | null;
  created_at: number;
  result: Model | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError('Il server di Forma non risponde. È avviato? (make dev)', 0);
  }
  if (!res.ok) {
    let detail = `Errore ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body.detail === 'string') detail = body.detail;
      else if (Array.isArray(body.detail)) detail = body.detail.map((d: { msg?: string }) => d.msg).join('; ');
    } catch {
      /* not JSON */
    }
    throw new ApiError(detail, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  providers: () => request<ProvidersResponse>('/api/providers'),

  generate(input: {
    prompt: string;
    provider: string;
    model: string | null;
    seed: number;
    quality: Quality;
    settings: Partial<PrintSettings>;
    image: File | null;
  }) {
    const form = new FormData();
    form.set('prompt', input.prompt);
    form.set('provider', input.provider);
    if (input.model) form.set('model', input.model);
    form.set('seed', String(input.seed));
    form.set('quality', input.quality);
    form.set('settings', JSON.stringify(input.settings));
    if (input.image) form.set('image', input.image, input.image.name);
    return request<{ job_id: string; job: Job }>('/api/generate', { method: 'POST', body: form });
  },

  job: (id: string) => request<Job>(`/api/jobs/${id}`),

  /** Re-run the print pipeline on a stored model, or on an edited mesh (new model). */
  process(input: { modelId: string; settings: Partial<PrintSettings>; prompt?: string; stl?: ArrayBuffer }) {
    const form = new FormData();
    form.set('model_id', input.modelId);
    form.set('settings', JSON.stringify(input.settings));
    if (input.prompt) form.set('prompt', input.prompt);
    if (input.stl) form.set('file', new Blob([input.stl], { type: 'model/stl' }), 'modifica.stl');
    return request<Model>('/api/process', { method: 'POST', body: form });
  },

  models: () => request<{ models: Model[] }>('/api/models?limit=60'),

  remove: (id: string) => request<{ ok: boolean }>(`/api/models/${id}`, { method: 'DELETE' }),
};

/** File name the backend will use for a download (prompt slug + size), for the preview line. */
export function exportName(model: Model, fmt: ExportFormat): string {
  const slug =
    (model.prompt || 'forma')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 40) || 'forma';
  return `${slug}-${Math.floor(Math.max(...model.report.bbox_mm))}mm.${fmt}`;
}
