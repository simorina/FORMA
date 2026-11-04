import { describe, expect, it } from 'vitest';
import { GrabStroke, StrokeRecorder, influence, inflateDab, smoothDab, type BrushSettings } from './brushes';
import { computeNormals, vertexNeighbors, weld } from './mesh';
import { grid, splitCube, volume } from './fixtures';

const base: BrushSettings = { radius: 3, strength: 0.5, falloff: 'linear', symmetryX: false };
const z = (p: Float32Array, v: number) => p[3 * v + 2];
// grid(21, 20): 1 mm spacing, vertex (i, j) at x = i - 10, y = j - 10
const at = (i: number, j: number) => j * 21 + i;

describe('influence', () => {
  it('weights vertices inside the radius by the falloff', () => {
    const g = grid(21, 20);
    const inf = influence(g.positions, [0, 0, 0], base);
    const w = new Map(Array.from(inf.indices, (v, k) => [v, inf.primary[k]]));
    expect(w.get(at(10, 10))).toBe(1);
    expect(w.get(at(11, 10))).toBeCloseTo(2 / 3, 6); // 1 mm of a 3 mm linear radius
    expect(w.has(at(13, 10))).toBe(false); // exactly on the radius
    expect(w.has(at(0, 0))).toBe(false);
  });
});

describe('grab', () => {
  it('moves the centre by the full delta and the rest by their weight', () => {
    const g = grid(21, 20);
    const stroke = new GrabStroke(g.positions, [0, 0, 0], base);
    stroke.apply(g.positions, [0, 0, 6]);
    expect(z(g.positions, at(10, 10))).toBeCloseTo(6, 6);
    expect(z(g.positions, at(11, 10))).toBeCloseTo(4, 5);
    expect(z(g.positions, at(14, 10))).toBe(0);
    stroke.apply(g.positions, [0, 0, 0]); // deltas are from the stroke's start
    expect(z(g.positions, at(10, 10))).toBe(0);
  });

  it('mirrors across X = 0 when symmetry is on', () => {
    const g = grid(21, 20);
    const s = { ...base, symmetryX: true };
    new GrabStroke(g.positions, [-5, 0, 0], s).apply(g.positions, [-2, 0, 3]);
    const left = at(5, 10), right = at(15, 10); // x = -5 and x = +5
    expect(z(g.positions, left)).toBeCloseTo(3, 6);
    expect(z(g.positions, right)).toBeCloseTo(3, 6);
    expect(g.positions[3 * left]).toBeCloseTo(-7, 6);
    expect(g.positions[3 * right]).toBeCloseTo(7, 6); // dx is mirrored
  });

  it('keeps vertices on the symmetry plane on it, and moves them once, not twice', () => {
    const g = grid(21, 20);
    new GrabStroke(g.positions, [0, 0, 0], { ...base, symmetryX: true }).apply(g.positions, [4, 0, 2]);
    const c = at(10, 10);
    expect(g.positions[3 * c]).toBeCloseTo(0, 6);
    expect(z(g.positions, c)).toBeCloseTo(2, 6);
  });
});

describe('smooth', () => {
  it('pulls a spike back towards its neighbours', () => {
    const g = grid(21, 20);
    const nb = vertexNeighbors(g.index, 21 * 21);
    g.positions[3 * at(10, 10) + 2] = 5;
    // the brush is a sphere: it must reach the spike's tip (5 mm up) to touch it
    const touched = smoothDab(g.positions, nb, [0, 0, 0], { ...base, radius: 6, falloff: 'constant', strength: 1 });
    expect(touched).toContain(at(10, 10));
    expect(z(g.positions, at(10, 10))).toBeLessThan(1.5);
    expect(z(g.positions, at(11, 10))).toBeGreaterThan(0); // its ring rises a little
    expect(z(g.positions, at(0, 0))).toBe(0); // outside the brush
  });

  it('leaves a flat surface flat', () => {
    const g = grid(11, 10);
    const before = g.positions.slice();
    smoothDab(g.positions, vertexNeighbors(g.index, 121), [0, 0, 0], { ...base, strength: 1 });
    for (let i = 2; i < g.positions.length; i += 3) expect(g.positions[i]).toBe(before[i]);
  });
});

describe('inflate', () => {
  it('grows a closed shape along its normals, and deflate shrinks it', () => {
    const w = weld(splitCube().positions, splitCube().index);
    const normals = computeNormals(w.positions, w.index);
    // constant falloff: the weights do not change as the vertices move, so the trip is exact
    const s = { ...base, radius: 10, strength: 1, falloff: 'constant' as const };
    const v0 = volume(w.positions, w.index);
    inflateDab(w.positions, normals, [0, 0, 0], s, 1);
    const v1 = volume(w.positions, w.index);
    expect(v1).toBeGreaterThan(v0);
    inflateDab(w.positions, normals, [0, 0, 0], s, -1);
    expect(volume(w.positions, w.index)).toBeCloseTo(v0, 4);
  });
});

describe('stroke recorder', () => {
  it('captures the first position of every touched vertex and the final one', () => {
    const g = grid(21, 20);
    const rec = new StrokeRecorder();
    const stroke = new GrabStroke(g.positions, [0, 0, 0], base);
    rec.touch(g.positions, stroke.indices);
    stroke.apply(g.positions, [0, 0, 1]);
    rec.touch(g.positions, stroke.indices); // touching again keeps the original
    stroke.apply(g.positions, [0, 0, 2]);
    const patch = rec.finish(g.positions)!;
    const k = Array.from(patch.indices).indexOf(at(10, 10));
    expect(patch.before[3 * k + 2]).toBe(0);
    expect(patch.after[3 * k + 2]).toBeCloseTo(2, 6);
    expect(rec.size).toBe(0);
  });

  it('returns null when the stroke moved nothing', () => {
    const g = grid(5, 4);
    const rec = new StrokeRecorder();
    rec.touch(g.positions, [0, 1, 2]);
    expect(rec.finish(g.positions)).toBeNull();
  });
});
