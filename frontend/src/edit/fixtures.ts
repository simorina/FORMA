/** Small meshes for the unit tests (not imported by the app). */

/** A flat n×n grid of vertices on Z = 0 spanning [-size/2, size/2] in X and Y. */
export function grid(n: number, size: number): { positions: Float32Array; index: Uint32Array } {
  const positions = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = 3 * (j * n + i);
      positions[v] = -size / 2 + (size * i) / (n - 1);
      positions[v + 1] = -size / 2 + (size * j) / (n - 1);
    }
  }
  const tris: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      tris.push(a, b, d, a, d, c);
    }
  }
  return { positions, index: Uint32Array.from(tris) };
}

/**
 * A closed axis-aligned cube of side 2 centred on the origin, outward facing, written
 * like a GLB export: 4 separate vertices per face (24 in all) so the faces do not share any.
 */
export function splitCube(): { positions: Float32Array; index: Uint32Array } {
  const faces: [number, number, number][][] = [
    [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]], // +X
    [[-1, 1, -1], [-1, -1, -1], [-1, -1, 1], [-1, 1, 1]], // -X
    [[1, 1, -1], [-1, 1, -1], [-1, 1, 1], [1, 1, 1]], // +Y
    [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], // -Y
    [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], // +Z
    [[-1, 1, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1]], // -Z
  ];
  const positions: number[] = [];
  const index: number[] = [];
  faces.forEach((quad, f) => {
    quad.forEach((p) => positions.push(...p));
    const o = 4 * f;
    index.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return { positions: Float32Array.from(positions), index: Uint32Array.from(index) };
}

/** Signed volume of a closed mesh (positive when it faces outwards). */
export function volume(positions: Float32Array, index: Uint32Array): number {
  let v = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = 3 * index[t], b = 3 * index[t + 1], c = 3 * index[t + 2];
    v +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v / 6;
}
