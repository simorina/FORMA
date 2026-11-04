import { describe, expect, it } from 'vitest';
import { Glide, breath, clamp01, easeInOut, easeOut, easeOutCubic, easeSteady, growSegments, pressScale } from './anim';

describe('3D motion curves', () => {
  it('start at 0, end at 1 and never leave [0, 1]', () => {
    for (const ease of [easeOut, easeInOut, easeSteady, easeOutCubic]) {
      expect(ease(0)).toBeCloseTo(0, 6);
      expect(ease(1)).toBe(1);
      let last = -1;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const v = ease(Math.min(t, 1));
        expect(v).toBeGreaterThanOrEqual(last); // monotonic
        expect(v).toBeLessThanOrEqual(1);
        last = v;
      }
    }
  });

  it('match the house curves: out front-loaded, in-out symmetric', () => {
    expect(easeOut(0.2)).toBeGreaterThan(0.7);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 6);
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1, 6);
  });

  it('breathe out, land a touch closer, settle', () => {
    expect(breath(0, 0.05)).toBe(1);
    expect(breath(1, 0.05)).toBeCloseTo(1, 9);
    const samples = Array.from({ length: 101 }, (_, i) => breath(i / 100, 0.05));
    const max = Math.max(...samples), min = Math.min(...samples);
    expect(max).toBeGreaterThan(1.03);
    expect(max).toBeLessThan(1.05);
    expect(min).toBeLessThan(1);
    expect(1 - min).toBeLessThan(max - 1); // the overshoot is the smaller part
    expect(samples.indexOf(max)).toBeLessThan(50);
    expect(samples.indexOf(min)).toBeGreaterThan(50);
  });

  it('press like the interface: sinks at once, comes back', () => {
    expect(pressScale(0)).toBe(1);
    expect(pressScale(1)).toBe(1);
    expect(pressScale(0.06)).toBeCloseTo(0.92, 2);
    expect(pressScale(0.5)).toBeGreaterThan(0.92);
    expect(pressScale(0.5)).toBeLessThan(1);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });

  it('grows segments from their centres', () => {
    const src = new Float32Array([0, 0, 0, 10, 0, 0, 4, 4, 0, 4, 8, 0]);
    const dst = new Float32Array(12);
    growSegments(src, dst, 0, 2, 0);
    expect(Array.from(dst)).toEqual([5, 0, 0, 5, 0, 0, 4, 6, 0, 4, 6, 0]);
    growSegments(src, dst, 0, 1, 0.5);
    expect(Array.from(dst.subarray(0, 6))).toEqual([2.5, 0, 0, 7.5, 0, 0]);
    growSegments(src, dst, 0, 2, 1);
    expect(Array.from(dst)).toEqual(Array.from(src));
  });
});

describe('Glide', () => {
  it('glides to its goal and stops asking for frames', () => {
    const g = new Glide(0);
    g.to(1, 1000, 400);
    expect(g.moving).toBe(true);
    expect(g.step(1000)).toBe(false); // nothing moved yet
    expect(g.step(1200)).toBe(true);
    expect(g.value).toBeCloseTo(0.5, 6);
    expect(g.step(1400)).toBe(true);
    expect(g.value).toBe(1);
    expect(g.moving).toBe(false);
    expect(g.step(1500)).toBe(false); // idle: no more renders
  });

  it('jumps when the duration is 0 (reduced motion)', () => {
    const g = new Glide(0);
    g.to(5, 0, 0);
    expect(g.value).toBe(5);
    expect(g.moving).toBe(false);
  });

  it('turns back from where it is, and keeps going to the same goal', () => {
    const g = new Glide(0);
    g.to(10, 0, 100, (t) => t);
    g.step(50);
    expect(g.value).toBe(5);
    g.to(10, 60, 100, (t) => t); // same goal: not restarted
    g.step(75);
    expect(g.value).toBe(7.5);
    g.to(0, 75, 100, (t) => t); // back from 7.5
    g.step(125);
    expect(g.value).toBeCloseTo(3.75, 6);
  });

  it('waits for its delay', () => {
    const g = new Glide(0);
    g.to(1, 0, 100, (t) => t, 50);
    expect(g.step(40)).toBe(false);
    expect(g.value).toBe(0);
    expect(g.step(100)).toBe(true);
    expect(g.value).toBeCloseTo(0.5, 6);
  });
});
