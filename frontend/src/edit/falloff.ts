/**
 * Soft-selection falloff curves: weight of a vertex at normalised distance t = d / radius.
 * Every curve is 1 at the centre, 0 from the radius outwards, and never increases.
 */
export type Falloff = 'smooth' | 'sphere' | 'linear' | 'sharp' | 'constant';

export const FALLOFFS: readonly { key: Falloff; label: string }[] = [
  { key: 'smooth', label: 'Morbida' },
  { key: 'sphere', label: 'Sferica' },
  { key: 'linear', label: 'Lineare' },
  { key: 'sharp', label: 'Netta' },
  { key: 'constant', label: 'Costante' },
];

export function falloff(t: number, curve: Falloff): number {
  if (!(t < 1)) return 0; // also catches NaN
  if (t <= 0) return 1;
  switch (curve) {
    case 'smooth': {
      // (1 - t²)²: flat at the centre and at the rim, so strokes blend without a ridge.
      const u = 1 - t * t;
      return u * u;
    }
    case 'sphere':
      return Math.sqrt(1 - t * t);
    case 'linear':
      return 1 - t;
    case 'sharp':
      return (1 - t) * (1 - t);
    case 'constant':
      return 1;
  }
}

/** SVG path of a curve in a w×h box (for the falloff picker), centre on the left. */
export function falloffPath(curve: Falloff, w = 28, h = 14, steps = 24): string {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (t * w).toFixed(2);
    const y = (h - falloff(Math.min(t, 0.9999), curve) * h).toFixed(2);
    pts.push(`${i === 0 ? 'M' : 'L'}${x} ${y}`);
  }
  return pts.join(' ');
}
