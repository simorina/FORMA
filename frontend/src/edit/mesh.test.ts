import { describe, expect, it } from 'vitest';
import { bounds, computeNormals, updateNormals, vertexFaces, vertexNeighbors, weld, weldAttribute } from './mesh';
import { grid, splitCube, volume } from './fixtures';

describe('weld', () => {
  it('merges the 24 split vertices of a cube into 8 and keeps all 12 triangles', () => {
    const { positions, index } = splitCube();
    const w = weld(positions, index);
    expect(w.positions.length / 3).toBe(8);
    expect(w.index.length / 3).toBe(12);
    expect(w.remap.length).toBe(24);
    expect(volume(w.positions, w.index)).toBeCloseTo(8, 5);
  });

  it('merges within the tolerance only', () => {
    const p = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0.00004, 0, 0, 1, 0, 0.5, 0, 1, 0]);
    const w = weld(p, Uint32Array.from([0, 1, 2, 3, 4, 5]), 1e-4);
    expect(w.positions.length / 3).toBe(4); // vertex 3 joins 0, vertex 5 joins 2, 4 is separate
    expect(Array.from(w.remap)).toEqual([0, 1, 2, 0, 3, 2]);
  });

  it('drops triangles that collapse when their vertices merge', () => {
    const p = Float32Array.from([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const w = weld(p, Uint32Array.from([0, 1, 2, 0, 2, 3]));
    expect(Array.from(w.index)).toEqual([0, 1, 2]);
  });

  it('carries a per-vertex attribute (the model colours) to the welded vertices', () => {
    const { positions, index } = splitCube();
    // each split vertex coloured by where it is: the copies of one corner share their colour
    const colors = positions.map((p) => (p + 1) / 2);
    const w = weld(positions, index);
    const welded = weldAttribute(colors, w.remap, 3, w.positions.length / 3);
    expect(welded.length).toBe(24);
    for (let v = 0; v < 8; v++) {
      for (let k = 0; k < 3; k++) expect(welded[3 * v + k]).toBe((w.positions[3 * v + k] + 1) / 2);
    }
  });

  it('accepts non-indexed geometry', () => {
    const { positions, index } = splitCube();
    const flat = new Float32Array(index.length * 3);
    index.forEach((v, i) => flat.set(positions.subarray(3 * v, 3 * v + 3), 3 * i));
    const w = weld(flat, null);
    expect(w.positions.length / 3).toBe(8);
    expect(w.index.length / 3).toBe(12);
  });
});

describe('adjacency', () => {
  it('lists faces and unique neighbours of each vertex', () => {
    const g = grid(3, 2); // 9 vertices, centre is 4
    const faces = vertexFaces(g.index, 9);
    expect(faces.offsets[9]).toBe(g.index.length);
    expect(faces.offsets[5] - faces.offsets[4]).toBe(6); // the centre touches 6 triangles
    const nb = vertexNeighbors(g.index, 9);
    const ring = Array.from(nb.list.subarray(nb.offsets[4], nb.offsets[5])).sort();
    expect(ring).toEqual([0, 1, 3, 5, 7, 8]);
    const corner = Array.from(nb.list.subarray(nb.offsets[0], nb.offsets[1])).sort();
    expect(corner).toEqual([1, 3, 4]);
  });
});

describe('normals', () => {
  it('point outwards with unit length on a closed cube', () => {
    const w = weld(splitCube().positions, splitCube().index);
    const n = computeNormals(w.positions, w.index);
    for (let v = 0; v < 8; v++) {
      const p = w.positions.subarray(3 * v, 3 * v + 3);
      const q = n.subarray(3 * v, 3 * v + 3);
      expect(Math.hypot(q[0], q[1], q[2])).toBeCloseTo(1, 5);
      expect(p[0] * q[0] + p[1] * q[1] + p[2] * q[2]).toBeGreaterThan(0);
    }
  });

  it('local update matches a full recompute after a vertex moves', () => {
    const g = grid(6, 10);
    const faces = vertexFaces(g.index, 36);
    const normals = computeNormals(g.positions, g.index);
    g.positions[3 * 14 + 2] = 3; // lift one inner vertex
    updateNormals(g.positions, g.index, normals, faces, [14]);
    const full = computeNormals(g.positions, g.index);
    for (let i = 0; i < full.length; i++) expect(normals[i]).toBeCloseTo(full[i], 6);
  });

  it('computes bounds', () => {
    expect(bounds(splitCube().positions)).toEqual([-1, -1, -1, 1, 1, 1]);
  });
});
