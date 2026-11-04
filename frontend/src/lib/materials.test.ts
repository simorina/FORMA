import { describe, expect, it } from 'vitest';
import { MATERIALS, copiesOnBed, duration, estimate, euro, materialByKey } from './materials';

const pla = materialByKey('pla');
const base = { infill: 0.15, spoolG: 1000, pricePerKg: 20, flow: 9, layerS: 2.5 };

describe('estimate', () => {
  // 20 mm cube: 8 cm³, 24 cm² surface
  const cube = { volume_cm3: 8, surface_cm2: 24, bbox_mm: [20, 20, 20] as const };

  it('matches the backend: 0.8 mm shell plus infill, times density', () => {
    const e = estimate(cube, { ...base, density: pla.density });
    const shell = Math.min(8, 24 * 0.08); // 1.92 cm³
    expect(e.grams).toBeCloseTo((shell + (8 - shell) * 0.15) * 1.24, 9);
    expect(e.solidGrams).toBeCloseTo(8 * 1.24, 9);
  });

  it('scales with material density and infill', () => {
    const petg = estimate(cube, { ...base, density: materialByKey('petg').density });
    const abs = estimate(cube, { ...base, density: materialByKey('abs').density });
    expect(petg.grams).toBeGreaterThan(abs.grams);
    const full = estimate(cube, { ...base, density: 1.24, infill: 1 });
    expect(full.grams).toBeCloseTo(full.solidGrams, 9);
  });

  it('turns grams into metres of 1.75 mm filament, cost and prints per spool', () => {
    const e = estimate(cube, { ...base, density: 1.24 });
    expect(e.metres).toBeCloseTo(e.grams / (Math.PI * 0.875 ** 2 * 1.24), 9);
    expect(e.cost).toBeCloseTo(e.grams * 0.02, 9);
    expect(e.prints).toBe(Math.floor(1000 / e.grams));
  });

  it('takes longer for bigger, taller prints and slower printers', () => {
    const fast = estimate(cube, { ...base, density: 1.24 });
    const slow = estimate(cube, { ...base, density: 1.24, flow: 4, layerS: 3 });
    const tall = estimate({ ...cube, bbox_mm: [20, 20, 120] }, { ...base, density: 1.24 });
    expect(slow.minutes).toBeGreaterThan(fast.minutes);
    expect(tall.minutes).toBeGreaterThan(fast.minutes);
  });

  it('never divides by zero on an empty report', () => {
    const e = estimate({ volume_cm3: 0, surface_cm2: 0, bbox_mm: [0, 0, 0] }, { ...base, density: 1.24 });
    expect(e.grams).toBe(0);
    expect(e.prints).toBe(0);
  });
});

describe('copies on the bed', () => {
  it('packs a grid with gaps and picks the better quarter turn', () => {
    expect(copiesOnBed(50, 50, 256, 256)).toBe(16); // (256+5)/(55) = 4 per side
    expect(copiesOnBed(120, 40, 250, 210)).toBe(8); // 2 × 4 straight beats 5 × 1 turned
    expect(copiesOnBed(300, 10, 256, 256)).toBe(0);
  });
});

describe('formatting', () => {
  it('writes durations and euros the Italian way', () => {
    expect(duration(42.4)).toBe('42 min');
    expect(duration(65)).toBe('1 h 05 min');
    expect(duration(120)).toBe('2 h');
    expect(duration(725)).toBe('12 h');
    expect(euro(0.6)).toBe('0,60 €'); // a no-break space keeps the sign with the figure
  });

  it('lists five materials with sensible densities', () => {
    expect(MATERIALS.map((m) => m.label)).toEqual(['PLA', 'PETG', 'ABS', 'ASA', 'TPU']);
    for (const m of MATERIALS) expect(m.density).toBeGreaterThan(1);
  });
});
