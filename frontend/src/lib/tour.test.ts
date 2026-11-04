import { describe, expect, it } from 'vitest';
import { TOUR_STEPS, intersect, placeCard, roman, union } from './tour';

describe('tour steps', () => {
  it('are nine, each with a unique id, a title and a short text', () => {
    expect(TOUR_STEPS).toHaveLength(9);
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
    for (const s of TOUR_STEPS) {
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.text.length).toBeLessThanOrEqual(240);
    }
  });

  it('open with a welcome in the middle, then point at the interface', () => {
    expect(TOUR_STEPS[0].targets).toBeUndefined();
    expect(TOUR_STEPS.slice(1).every((s) => s.targets?.length)).toBe(true);
  });
});

describe('roman numerals', () => {
  it('number the steps', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map(roman)).toEqual(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XII']);
    expect(roman(2026)).toBe('MMXXVI');
  });
});

describe('highlight geometry', () => {
  it('joins and crops rectangles', () => {
    expect(union([{ x: 0, y: 10, w: 100, h: 50 }, { x: 20, y: 70, w: 100, h: 30 }])).toEqual({ x: 0, y: 10, w: 120, h: 90 });
    expect(union([])).toBeNull();
    expect(intersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 80, w: 100, h: 100 })).toEqual({ x: 50, y: 80, w: 50, h: 20 });
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 })).toBeNull();
  });
});

describe('card placement', () => {
  const view = { w: 1440, h: 900 };
  const card = { w: 380, h: 220 };
  const inside = (p: { x: number; y: number }, m = 16) =>
    p.x >= m && p.y >= m && p.x + card.w <= view.w - m && p.y + card.h <= view.h - m;

  it('sits beside a panel on the left, and left of one on the right', () => {
    const leftPanel = placeCard({ x: 0, y: 100, w: 320, h: 400 }, card, view);
    expect(leftPanel).toMatchObject({ side: 'right', x: 336, y: 100 });
    const rightPanel = placeCard({ x: 1096, y: 120, w: 344, h: 300 }, card, view);
    expect(rightPanel).toMatchObject({ side: 'left', x: 1096 - 16 - 380 });
    expect(inside(leftPanel) && inside(rightPanel)).toBe(true);
  });

  it('goes under the top bar and stays on screen', () => {
    const p = placeCard({ x: 1100, y: 10, w: 330, h: 44 }, card, view);
    expect(p.side).toBe('below');
    expect(inside(p)).toBe(true);
  });

  it('goes inside a highlight too big to sit beside (the viewport)', () => {
    const p = placeCard({ x: 340, y: 84, w: 736, h: 796 }, card, view);
    expect(p.side).toBe('inside');
    expect(inside(p)).toBe(true);
  });

  it('centres without a highlight', () => {
    expect(placeCard(null, card, view)).toEqual({ x: 530, y: 340, side: 'center' });
  });

  it('docks on narrow screens, away from the highlight and off the bars', () => {
    const phone = { w: 390, h: 844 };
    const c = { w: 366, h: 200 };
    const opts = { narrow: true, margin: 12, top: 56, bottom: 57 };
    const low = placeCard({ x: 0, y: 500, w: 390, h: 200 }, c, phone, opts);
    expect(low).toMatchObject({ side: 'top', y: 68, x: 12 });
    const high = placeCard({ x: 0, y: 60, w: 390, h: 200 }, c, phone, opts);
    expect(high).toMatchObject({ side: 'bottom', y: 844 - 57 - 200 - 12 });
  });
});
