/**
 * Filament materials and the print estimates shown in the report. The backend reports the
 * geometry (volume, surface, box); everything that depends on the user's material, infill,
 * spool and price is computed here, with the same shell model as the backend
 * (0.8 mm of walls, top and bottom, then infill).
 */

export interface Material {
  key: string;
  label: string;
  density: number; // g/cm³
  price: number; // €/kg, an indicative retail price the user can change
  note: string;
}

export const MATERIALS: readonly Material[] = [
  { key: 'pla', label: 'PLA', density: 1.24, price: 20, note: 'Facile e rigido: va bene per quasi tutto.' },
  { key: 'petg', label: 'PETG', density: 1.27, price: 22, note: 'Più tenace e un po’ flessibile, regge meglio il calore.' },
  { key: 'abs', label: 'ABS', density: 1.04, price: 22, note: 'Resiste al calore; meglio con una stampante chiusa.' },
  { key: 'asa', label: 'ASA', density: 1.07, price: 28, note: 'Come l’ABS, ma non ingiallisce al sole: per l’esterno.' },
  { key: 'tpu', label: 'TPU', density: 1.21, price: 30, note: 'Gommoso e flessibile; si stampa lentamente.' },
];

export const materialByKey = (key: string) => MATERIALS.find((m) => m.key === key) ?? MATERIALS[0];

export const INFILLS = [0.1, 0.15, 0.2, 0.4, 1] as const;
export const SPOOLS = [250, 500, 750, 1000, 2000] as const;

export interface Geometry {
  volume_cm3: number;
  surface_cm2: number;
  bbox_mm: readonly [number, number, number] | readonly number[];
}

export interface EstimateOptions {
  density: number;
  infill: number; // 0..1
  spoolG: number;
  pricePerKg: number;
  /** average volumetric flow of a standard 0.2 mm profile, mm³/s */
  flow: number;
  /** seconds lost per layer (travel, z hop, wipe) */
  layerS: number;
  layerH?: number;
  bed?: { w: number; d: number };
  diameter?: number; // filament, mm
}

export interface Estimate {
  grams: number;
  solidGrams: number;
  metres: number;
  cost: number;
  prints: number;
  minutes: number;
  copies: number;
}

const SHELL_CM = 0.08; // 0.8 mm of perimeters / top / bottom, as in the backend report

export function estimate(g: Geometry, o: EstimateOptions): Estimate {
  const volume = Math.max(0, g.volume_cm3);
  const shell = Math.min(volume, Math.max(0, g.surface_cm2) * SHELL_CM);
  const printed = shell + (volume - shell) * Math.min(1, Math.max(0, o.infill)); // cm³ extruded
  const grams = printed * o.density;
  const d = o.diameter ?? 1.75;
  const gramsPerMetre = Math.PI * (d / 2) ** 2 * o.density; // mm² × 1000 mm × g/1000 mm³
  const layers = (g.bbox_mm[2] ?? 0) / (o.layerH ?? 0.2);
  const seconds = ((printed * 1000) / o.flow + layers * o.layerS) * 1.1; // +10 % for travel
  return {
    grams,
    solidGrams: volume * o.density,
    metres: grams / gramsPerMetre,
    cost: (grams / 1000) * o.pricePerKg,
    prints: grams > 0 ? Math.floor(o.spoolG / grams) : 0,
    minutes: seconds / 60,
    copies: o.bed ? copiesOnBed(g.bbox_mm[0], g.bbox_mm[1], o.bed.w, o.bed.d) : 1,
  };
}

/** How many copies fit side by side on the bed, `gap` mm apart, with a quarter turn if better. */
export function copiesOnBed(x: number, y: number, w: number, d: number, gap = 5): number {
  if (!(x > 0 && y > 0)) return 0;
  const grid = (a: number, b: number) => Math.floor((w + gap) / (a + gap)) * Math.floor((d + gap) / (b + gap));
  return Math.max(grid(x, y), grid(y, x));
}

/** "45 min", "1 h 05 min", "12 h". */
export function duration(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h >= 10) return `${h} h`;
  return r ? `${h} h ${String(r).padStart(2, '0')} min` : `${h} h`;
}

export const euro = (v: number) =>
  new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
