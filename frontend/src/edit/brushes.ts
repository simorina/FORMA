/**
 * Sculpting brushes on plain arrays: grab with soft selection, smooth and inflate,
 * each optionally mirrored across the X = 0 plane (the backend centres every model on it).
 */
import { falloff, type Falloff } from './falloff';
import type { CSR } from './mesh';
import type { Patch } from './history';

export type Vec3 = [number, number, number];

export interface BrushSettings {
  radius: number; // millimetres
  strength: number; // 0..1, ignored by grab (it follows the pointer)
  falloff: Falloff;
  symmetryX: boolean;
}

/** Vertices touched by a brush at `center`: weights from the centre and from its mirror. */
export interface Influence {
  indices: Uint32Array;
  primary: Float32Array;
  mirror: Float32Array;
}

export function influence(positions: Float32Array, center: Vec3, s: BrushSettings): Influence {
  const r = s.radius;
  const r2 = r * r;
  const [cx, cy, cz] = center;
  const idx: number[] = [];
  const wp: number[] = [];
  const wm: number[] = [];
  for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
    const dy = positions[i + 1] - cy, dz = positions[i + 2] - cz;
    const dyz = dy * dy + dz * dz;
    if (dyz >= r2) continue;
    const dx = positions[i] - cx;
    const d1 = dx * dx + dyz;
    let a = 0, b = 0;
    if (d1 < r2) a = falloff(Math.sqrt(d1) / r, s.falloff);
    if (s.symmetryX) {
      const mx = positions[i] + cx; // distance to the mirrored centre (-cx, cy, cz)
      const d2 = mx * mx + dyz;
      if (d2 < r2) b = falloff(Math.sqrt(d2) / r, s.falloff);
    }
    if (a > 0 || b > 0) {
      idx.push(v);
      wp.push(a);
      wm.push(b);
    }
  }
  return { indices: Uint32Array.from(idx), primary: Float32Array.from(wp), mirror: Float32Array.from(wm) };
}

/** Weight of a direction-agnostic brush where the stroke and its mirror overlap. */
const combined = (a: number, b: number) => (a > b ? a : b);

/**
 * Grab: vertices follow the pointer by their falloff weight. Where the stroke and its
 * mirror overlap the two moves blend instead of adding up, so a vertex on the symmetry
 * plane stays on it and is never moved twice as far.
 */
export class GrabStroke {
  readonly indices: Uint32Array;
  readonly before: Float32Array;
  private readonly a: Float32Array;
  private readonly b: Float32Array;

  constructor(positions: Float32Array, center: Vec3, s: BrushSettings) {
    const inf = influence(positions, center, s);
    this.indices = inf.indices;
    this.a = inf.primary;
    this.b = inf.mirror;
    this.before = new Float32Array(this.indices.length * 3);
    this.indices.forEach((v, k) => this.before.set(positions.subarray(3 * v, 3 * v + 3), 3 * k));
  }

  /** Move every touched vertex by its share of `delta` (from where the stroke began). */
  apply(positions: Float32Array, delta: Vec3): void {
    const [dx, dy, dz] = delta;
    for (let k = 0; k < this.indices.length; k++) {
      const a = this.a[k], b = this.b[k];
      const sum = a + b;
      const scale = sum > 0 ? (a > b ? a : b) / sum : 0;
      const v = 3 * this.indices[k];
      positions[v] = this.before[3 * k] + scale * (a - b) * dx;
      positions[v + 1] = this.before[3 * k + 1] + scale * sum * dy;
      positions[v + 2] = this.before[3 * k + 2] + scale * sum * dz;
    }
  }
}

/** One dab of Laplacian smoothing (Jacobi: every vertex reads the positions before the dab). */
export function smoothDab(positions: Float32Array, neighbors: CSR, center: Vec3, s: BrushSettings): Uint32Array {
  return smoothWith(positions, neighbors, influence(positions, center, s), s.strength);
}

/** Smoothing over an influence already computed (lets the caller record it first). */
export function smoothWith(positions: Float32Array, neighbors: CSR, inf: Influence, strength: number): Uint32Array {
  const next = new Float32Array(inf.indices.length * 3);
  for (let k = 0; k < inf.indices.length; k++) {
    const v = inf.indices[k];
    const from = neighbors.offsets[v], to = neighbors.offsets[v + 1];
    const p = 3 * v;
    if (to === from) {
      next.set(positions.subarray(p, p + 3), 3 * k);
      continue;
    }
    let ax = 0, ay = 0, az = 0;
    for (let j = from; j < to; j++) {
      const u = 3 * neighbors.list[j];
      ax += positions[u];
      ay += positions[u + 1];
      az += positions[u + 2];
    }
    const n = to - from;
    const w = combined(inf.primary[k], inf.mirror[k]) * strength;
    next[3 * k] = positions[p] + w * (ax / n - positions[p]);
    next[3 * k + 1] = positions[p + 1] + w * (ay / n - positions[p + 1]);
    next[3 * k + 2] = positions[p + 2] + w * (az / n - positions[p + 2]);
  }
  inf.indices.forEach((v, k) => positions.set(next.subarray(3 * k, 3 * k + 3), 3 * v));
  return inf.indices;
}

/** One dab of inflate (sign +1) or deflate (sign -1) along the vertex normals. */
export function inflateDab(
  positions: Float32Array,
  normals: Float32Array,
  center: Vec3,
  s: BrushSettings,
  sign: 1 | -1 = 1,
): Uint32Array {
  return inflateWith(positions, normals, influence(positions, center, s), s, sign);
}

/** Inflate over an influence already computed. */
export function inflateWith(
  positions: Float32Array,
  normals: Float32Array,
  inf: Influence,
  s: Pick<BrushSettings, 'radius' | 'strength'>,
  sign: 1 | -1 = 1,
): Uint32Array {
  const step = s.radius * 0.05 * s.strength * sign;
  for (let k = 0; k < inf.indices.length; k++) {
    const v = 3 * inf.indices[k];
    const w = combined(inf.primary[k], inf.mirror[k]) * step;
    positions[v] += normals[v] * w;
    positions[v + 1] += normals[v + 1] * w;
    positions[v + 2] += normals[v + 2] * w;
  }
  return inf.indices;
}

/** Remembers where each vertex was when a stroke first touched it, to build one undo step. */
export class StrokeRecorder {
  private readonly before = new Map<number, Vec3>();

  touch(positions: Float32Array, indices: ArrayLike<number>): void {
    for (let k = 0; k < indices.length; k++) {
      const v = indices[k];
      if (!this.before.has(v)) this.before.set(v, [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]]);
    }
  }

  get size(): number {
    return this.before.size;
  }

  /** The stroke as a patch, or null when nothing actually moved. */
  finish(positions: Float32Array): Patch | null {
    const indices = Uint32Array.from([...this.before.keys()].sort((x, y) => x - y));
    const before = new Float32Array(indices.length * 3);
    const after = new Float32Array(indices.length * 3);
    let moved = false;
    indices.forEach((v, k) => {
      const b = this.before.get(v)!;
      before.set(b, 3 * k);
      after.set(positions.subarray(3 * v, 3 * v + 3), 3 * k);
      if (b[0] !== positions[3 * v] || b[1] !== positions[3 * v + 1] || b[2] !== positions[3 * v + 2]) moved = true;
    });
    this.before.clear();
    return moved ? { indices, before, after } : null;
  }
}
