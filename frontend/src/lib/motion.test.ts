import { describe, expect, it } from 'vitest';
import { DUR, EASE, canAnimate, play, staggerDelays } from './motion';

describe('motion', () => {
  it('staggers entries and bunches the tail of long lists', () => {
    expect(staggerDelays(4)).toEqual([0, 40, 80, 120]);
    expect(staggerDelays(4, 30, 2, 100)).toEqual([100, 130, 160, 160]);
    expect(staggerDelays(0)).toEqual([]);
  });

  it('has one vocabulary of durations and curves', () => {
    expect(DUR.micro).toBeLessThan(DUR.short);
    expect(DUR.short).toBeLessThan(DUR.base);
    expect(DUR.base).toBeLessThanOrEqual(450); // what can be clicked settles quickly
    expect(EASE.out).toMatch(/^cubic-bezier\(/);
    expect(EASE.spring).toMatch(/^linear\(0,/);
  });

  it('does nothing where it cannot animate, and says so', async () => {
    expect(canAnimate()).toBe(false); // Node: no DOM, no Web Animations
    await expect(play({} as Element, [])).resolves.toBeUndefined();
  });
});
