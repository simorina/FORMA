import { describe, expect, it } from 'vitest';
import { FILAMENTS, PAPER, contrast, inkOn, metres, uiColor } from './filaments';
import { fitOnBed, scaled } from './printers';
import { ago, dims, grams, mm } from './format';

describe('filament data hue', () => {
  it.each(FILAMENTS.map((f) => [f.label, f.hex]))('%s reads at 4.5:1 on the paper', (_, hex) => {
    expect(contrast(uiColor(hex), PAPER)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps colours that already contrast and darkens light ones towards the ink', () => {
    expect(uiColor('#2c63d8')).toBe('#2c63d8');
    expect(uiColor('#232325')).toBe('#232325');
    const yellow = uiColor('#ffc928');
    expect(yellow).not.toBe('#ffc928');
    expect(contrast(yellow, PAPER)).toBeLessThan(4.8); // just enough, not black
  });

  it('lifts dark colours towards white on a dark ground', () => {
    expect(uiColor('#ff7a1a', '#111111')).toBe('#ff7a1a');
    expect(contrast(uiColor('#232325', '#111111'), '#111111')).toBeGreaterThanOrEqual(4.5);
  });

  it('puts the readable ink on a swatch', () => {
    expect(inkOn('#f2f1ec')).toBe('#000000');
    expect(inkOn('#2c63d8')).toBe('#ffffff');
  });

  it('turns grams of 1.75 mm PLA into metres (about 2.98 g per metre)', () => {
    expect(metres(298.2)).toBeCloseTo(100, 0);
  });
});

describe('bed fit', () => {
  const a1 = { w: 256, d: 256, h: 256 };
  const mk4 = { w: 250, d: 210, h: 220 };

  it('fits, allowing a quarter turn', () => {
    expect(fitOnBed([100, 80, 120], a1)).toMatchObject({ fits: true, rotated: false });
    expect(fitOnBed([200, 240, 100], mk4)).toMatchObject({ fits: true, rotated: true });
  });

  it('reports the largest size that still fits', () => {
    const f = fitOnBed([300, 100, 150], mk4);
    expect(f.fits).toBe(false);
    expect(f.maxSize).toBe(250); // 300 → 250 along X
    expect(fitOnBed([100, 100, 300], mk4).maxSize).toBe(220); // height-limited
  });

  it('scales a box to a new longest side', () => {
    expect(scaled([50, 25, 100], 200)).toEqual([100, 50, 200]);
  });
});

describe('Italian formatting', () => {
  it('uses the decimal comma and the multiplication sign', () => {
    expect(mm(100)).toBe('100,0');
    expect(grams(7.25)).toBe('7,3');
    expect(grams(34.4)).toBe('34');
    expect(dims([100, 62.34, 80.06])).toBe('100,0 × 62,3 × 80,1');
  });

  it('says how long ago in words', () => {
    const now = Date.UTC(2026, 10, 4, 12) / 1000;
    expect(ago(now - 10, now)).toBe('adesso');
    expect(ago(now - 180, now)).toBe('3 minuti fa');
    expect(ago(now - 86400 * 1.2, now)).toBe('ieri');
  });
});
