/** Build volumes of common home printers, in millimetres (X × Y × Z). */

export interface Printer {
  key: string;
  label: string;
  w: number;
  d: number;
  h: number;
}

export const PRINTERS: readonly Printer[] = [
  { key: 'bambu-a1', label: 'Bambu Lab A1', w: 256, d: 256, h: 256 },
  { key: 'prusa-mk4', label: 'Prusa MK4', w: 250, d: 210, h: 220 },
  { key: 'ender-3', label: 'Creality Ender 3', w: 220, d: 220, h: 250 },
  { key: 'custom', label: 'Personalizzata', w: 200, d: 200, h: 200 },
];

export type Size = readonly [number, number, number];

export interface Fit {
  fits: boolean;
  /** turned 90° on the bed to fit */
  rotated: boolean;
  /** largest "longest side" (mm) at which the shape fits, keeping proportions */
  maxSize: number;
}

/** Does a bounding box fit the printer, allowing a quarter turn around Z? */
export function fitOnBed(size: Size, p: Pick<Printer, 'w' | 'd' | 'h'>): Fit {
  const [x, y, z] = size;
  const longest = Math.max(x, y, z);
  const eps = 1e-6;
  const straight = x <= p.w + eps && y <= p.d + eps;
  const turned = y <= p.w + eps && x <= p.d + eps;
  const fitsZ = z <= p.h + eps;
  const scale = (a: number, b: number) =>
    Math.min(a > 0 ? p.w / a : Infinity, b > 0 ? p.d / b : Infinity, z > 0 ? p.h / z : Infinity);
  const best = Math.max(scale(x, y), scale(y, x));
  return {
    fits: fitsZ && (straight || turned),
    rotated: fitsZ && !straight && turned,
    // round down to 0.1 mm, after absorbing float error (300 * 220/300 is 219.99999…)
    maxSize: Number.isFinite(best) ? Math.floor(longest * best * 10 + 1e-6) / 10 : longest,
  };
}

/** The box after scaling so its longest side becomes `target`. */
export function scaled(size: Size, target: number): [number, number, number] {
  const longest = Math.max(...size);
  const k = longest > 0 ? target / longest : 1;
  return [size[0] * k, size[1] * k, size[2] * k];
}
