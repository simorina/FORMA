/**
 * Plain-array mesh utilities for editing: welding, adjacency and normals.
 * Positions are xyz triplets (Float32Array), triangles are index triplets (Uint32Array).
 * Nothing here depends on three.js, so it is unit-tested directly.
 */

export interface Welded {
  positions: Float32Array;
  index: Uint32Array;
  /** original vertex -> welded vertex */
  remap: Uint32Array;
}

/**
 * Merge vertices closer than `tolerance` (GLB files split vertices along normal and UV seams;
 * sculpting needs one vertex per point of the surface or seams tear open).
 * Degenerate triangles produced by the merge are dropped.
 */
export function weld(positions: Float32Array, index: Uint32Array | null, tolerance = 1e-4): Welded {
  const count = positions.length / 3;
  const inv = 1 / tolerance;
  const lookup = new Map<string, number>();
  const remap = new Uint32Array(count);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = lookup.get(key);
    if (id === undefined) {
      id = out.length / 3;
      lookup.set(key, id);
      out.push(x, y, z);
    }
    remap[i] = id;
  }
  const src = index ?? Uint32Array.from({ length: count }, (_, i) => i);
  const tris: number[] = [];
  for (let t = 0; t < src.length; t += 3) {
    const a = remap[src[t]], b = remap[src[t + 1]], c = remap[src[t + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return { positions: new Float32Array(out), index: new Uint32Array(tris), remap };
}

/** One part of a loaded file: positions, its index (null: not indexed) and RGB colours. */
export interface Part {
  positions: Float32Array;
  index: Uint32Array | null;
  colors: Float32Array | null;
}

/**
 * The parts of a file as one indexed mesh, in typed arrays only (a 4M-triangle model would
 * not fit in plain number arrays). Colours, when any part has them, with `fill` (RGB alike)
 * for the vertices of the parts without; null when no part has colours.
 */
export function mergeParts(parts: Part[], fill: number): Part & { index: Uint32Array } {
  let vertices = 0, corners = 0;
  for (const p of parts) {
    vertices += p.positions.length / 3;
    corners += p.index ? p.index.length : p.positions.length / 3;
  }
  const positions = new Float32Array(vertices * 3);
  const index = new Uint32Array(corners);
  const colored = parts.some((p) => p.colors);
  const colors = colored ? new Float32Array(vertices * 3) : null;
  let v = 0, c = 0;
  for (const p of parts) {
    const count = p.positions.length / 3;
    positions.set(p.positions, v * 3);
    if (colors) {
      if (p.colors) colors.set(p.colors, v * 3);
      else colors.fill(fill, v * 3, (v + count) * 3);
    }
    if (p.index) for (let i = 0; i < p.index.length; i++) index[c++] = p.index[i] + v;
    else for (let i = 0; i < count; i++) index[c++] = v + i;
    v += count;
  }
  return { positions, index, colors };
}

/**
 * A per-vertex attribute (the model's colours) moved onto the welded vertices: each welded
 * vertex takes the value of the last original vertex merged into it.
 */
export function weldAttribute(values: Float32Array, remap: Uint32Array, itemSize: number, count: number): Float32Array {
  const out = new Float32Array(count * itemSize);
  for (let i = 0; i < remap.length; i++) {
    out.set(values.subarray(i * itemSize, (i + 1) * itemSize), remap[i] * itemSize);
  }
  return out;
}

/** Compressed sparse rows: the items of row r are list[offsets[r] .. offsets[r + 1]). */
export interface CSR {
  offsets: Uint32Array;
  list: Uint32Array;
}

/** Faces around each vertex. */
export function vertexFaces(index: Uint32Array, vertexCount: number): CSR {
  const offsets = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < index.length; i++) offsets[index[i] + 1]++;
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v];
  const fill = offsets.slice(0, vertexCount);
  const list = new Uint32Array(index.length);
  for (let i = 0; i < index.length; i++) list[fill[index[i]]++] = (i / 3) | 0;
  return { offsets, list };
}

/** Unique neighbouring vertices of each vertex (the 1-ring). */
export function vertexNeighbors(index: Uint32Array, vertexCount: number): CSR {
  const faces = vertexFaces(index, vertexCount);
  const offsets = new Uint32Array(vertexCount + 1);
  const rows: Uint32Array[] = [];
  const seen = new Set<number>();
  for (let v = 0; v < vertexCount; v++) {
    seen.clear();
    for (let k = faces.offsets[v]; k < faces.offsets[v + 1]; k++) {
      const f = faces.list[k] * 3;
      for (let j = 0; j < 3; j++) {
        const u = index[f + j];
        if (u !== v) seen.add(u);
      }
    }
    const row = Uint32Array.from(seen);
    rows.push(row);
    offsets[v + 1] = offsets[v] + row.length;
  }
  const list = new Uint32Array(offsets[vertexCount]);
  rows.forEach((row, v) => list.set(row, offsets[v]));
  return { offsets, list };
}

/** Area-weighted vertex normals of the whole mesh. */
export function computeNormals(positions: Float32Array, index: Uint32Array, out?: Float32Array): Float32Array {
  const normals = out ?? new Float32Array(positions.length);
  normals.fill(0);
  for (let t = 0; t < index.length; t += 3) {
    const [nx, ny, nz] = faceCross(positions, index, t);
    for (let j = 0; j < 3; j++) {
      const v = index[t + j] * 3;
      normals[v] += nx;
      normals[v + 1] += ny;
      normals[v + 2] += nz;
    }
  }
  for (let v = 0; v < normals.length; v += 3) normalize(normals, v);
  return normals;
}

/**
 * Recompute the normals of `vertices` and of every vertex sharing a face with them,
 * which are all the normals a move of `vertices` can change.
 */
export function updateNormals(
  positions: Float32Array,
  index: Uint32Array,
  normals: Float32Array,
  faces: CSR,
  vertices: ArrayLike<number>,
): void {
  const ring = new Set<number>();
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    for (let k = faces.offsets[v]; k < faces.offsets[v + 1]; k++) {
      const f = faces.list[k] * 3;
      ring.add(index[f]);
      ring.add(index[f + 1]);
      ring.add(index[f + 2]);
    }
  }
  for (const v of ring) {
    let nx = 0, ny = 0, nz = 0;
    for (let k = faces.offsets[v]; k < faces.offsets[v + 1]; k++) {
      const c = faceCross(positions, index, faces.list[k] * 3);
      nx += c[0];
      ny += c[1];
      nz += c[2];
    }
    normals[3 * v] = nx;
    normals[3 * v + 1] = ny;
    normals[3 * v + 2] = nz;
    normalize(normals, 3 * v);
  }
}

/** Cross product of a triangle's edges: its normal scaled by twice its area. */
function faceCross(p: Float32Array, index: Uint32Array, t: number): [number, number, number] {
  const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function normalize(a: Float32Array, i: number): void {
  const len = Math.hypot(a[i], a[i + 1], a[i + 2]);
  if (len > 0) {
    a[i] /= len;
    a[i + 1] /= len;
    a[i + 2] /= len;
  } else {
    a[i + 2] = 1; // isolated vertex: any unit vector
  }
}

/** Axis-aligned bounds of the positions: [minX, minY, minZ, maxX, maxY, maxZ]. */
export function bounds(positions: Float32Array): [number, number, number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (z < z0) z0 = z;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (z > z1) z1 = z;
  }
  return [x0, y0, z0, x1, y1, z1];
}
