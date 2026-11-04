import { describe, expect, it } from 'vitest';
import { FALLOFFS, falloff, falloffPath } from './falloff';

const curves = FALLOFFS.map((f) => f.key);

describe('falloff', () => {
  it.each(curves)('%s is 1 at the centre and 0 at and beyond the radius', (c) => {
    expect(falloff(0, c)).toBe(1);
    expect(falloff(1, c)).toBe(0);
    expect(falloff(1.7, c)).toBe(0);
    expect(falloff(Number.NaN, c)).toBe(0);
    expect(falloff(-0.2, c)).toBe(1);
  });

  it.each(curves)('%s stays in [0, 1] and never increases with distance', (c) => {
    let prev = 1;
    for (let i = 0; i <= 200; i++) {
      const w = falloff(i / 200, c);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
  });

  it('smooth has a flat top and a flat rim (no ridge where strokes meet)', () => {
    const h = 1e-4;
    expect((falloff(h, 'smooth') - falloff(0, 'smooth')) / h).toBeCloseTo(0, 3);
    expect((falloff(1 - h, 'smooth') - 0) / h).toBeCloseTo(0, 3);
    expect(falloff(0.5, 'smooth')).toBeCloseTo(0.5625, 6);
  });

  it('each curve has its own shape at the half radius', () => {
    expect(falloff(0.5, 'linear')).toBe(0.5);
    expect(falloff(0.5, 'sharp')).toBe(0.25);
    expect(falloff(0.5, 'sphere')).toBeCloseTo(Math.sqrt(0.75), 9);
    expect(falloff(0.5, 'constant')).toBe(1);
  });

  it('draws an SVG path from the top left to the bottom right', () => {
    const d = falloffPath('linear', 28, 14, 4);
    expect(d.startsWith('M0.00 0.00')).toBe(true);
    expect(d.split('L')).toHaveLength(5);
  });
});
