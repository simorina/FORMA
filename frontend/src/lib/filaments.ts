/**
 * PLA colours. The chosen filament is the product's one data hue: it tints the model and the
 * report's key figures. On the dark surface the UI uses a version lifted to 4.5:1 contrast,
 * so black or navy filament still reads; the 3D model keeps the true colour.
 */

export interface Filament {
  key: string;
  label: string;
  hex: string;
}

export const FILAMENTS: readonly Filament[] = [
  { key: 'arancio', label: 'Arancio', hex: '#ff7a1a' },
  { key: 'bianco', label: 'Bianco', hex: '#f2f1ec' },
  { key: 'grigio', label: 'Grigio', hex: '#8d9196' },
  { key: 'nero', label: 'Nero', hex: '#232325' },
  { key: 'rosso', label: 'Rosso', hex: '#de3a32' },
  { key: 'giallo', label: 'Giallo', hex: '#ffc928' },
  { key: 'verde', label: 'Verde', hex: '#3cae5c' },
  { key: 'azzurro', label: 'Azzurro', hex: '#47b2ef' },
  { key: 'blu', label: 'Blu', hex: '#2c63d8' },
  { key: 'rosa', label: 'Rosa', hex: '#ff7ead' },
];

export const DEFAULT_FILAMENT = 'arancio';

export const filamentByKey = (key: string) => FILAMENTS.find((f) => f.key === key) ?? FILAMENTS[0];

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (c: RGB) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const lin = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** The colour mixed towards white just enough to reach `min` contrast on `bg`. */
export function uiColor(hex: string, bg = '#111111', min = 4.5): string {
  if (contrast(hex, bg) >= min) return hex;
  const c = hexToRgb(hex);
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2;
    const mixed = rgbToHex(c.map((v) => v + (255 - v) * t) as RGB);
    if (contrast(mixed, bg) >= min) hi = t;
    else lo = t;
  }
  return rgbToHex(c.map((v) => v + (255 - v) * hi) as RGB);
}

/** Ink to put on a swatch of this colour. */
export const inkOn = (hex: string) => (luminance(hex) > 0.4 ? '#000000' : '#ffffff');

/** Metres of 1.75 mm PLA (1.24 g/cm³) for a weight in grams. */
export function metres(grams: number, diameter = 1.75, density = 1.24): number {
  const area = Math.PI * (diameter / 2) ** 2; // mm²
  return grams / ((area * 1000 * density) / 1000); // grams per metre = area(mm²) * 1000 mm * ρ / 1000
}
