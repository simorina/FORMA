import { describe, expect, it } from 'vitest';
import { readSTL, writeSTL } from './stl';
import { weld } from './mesh';
import { splitCube } from './fixtures';

describe('binary STL writer', () => {
  it('has the exact binary layout: 84 + 50 bytes per triangle', () => {
    const { positions, index } = weld(splitCube().positions, splitCube().index);
    const buf = writeSTL(positions, index);
    expect(buf.byteLength).toBe(84 + 50 * 12);
    expect(new DataView(buf).getUint32(80, true)).toBe(12);
  });

  it('never starts with "solid" so readers do not take it for ASCII STL', () => {
    const p = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const head = (b: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(b, 0, 5));
    expect(head(writeSTL(p, Uint32Array.from([0, 1, 2])))).not.toBe('solid');
    expect(head(writeSTL(p, Uint32Array.from([0, 1, 2]), 'solid trap'))).not.toBe('solid');
  });

  it('writes unit normals from the winding and round-trips the vertices', () => {
    const p = Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    const out = readSTL(writeSTL(p, Uint32Array.from([0, 1, 2])));
    expect(out.count).toBe(1);
    expect(Array.from(out.normals)).toEqual([0, 0, 1]); // counter-clockwise seen from +Z
    expect(Array.from(out.positions)).toEqual(Array.from(p));
  });

  it('keeps millimetre coordinates of a whole mesh', () => {
    const { positions, index } = weld(splitCube().positions, splitCube().index);
    const scaled = positions.map((v) => v * 42.5);
    const out = readSTL(writeSTL(scaled, index));
    expect(Math.max(...out.positions)).toBeCloseTo(42.5, 4);
    for (let t = 0; t < out.count; t++) {
      const n = out.normals.subarray(3 * t, 3 * t + 3);
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
    }
  });

  it('rejects a truncated file', () => {
    const buf = writeSTL(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), Uint32Array.from([0, 1, 2]));
    expect(() => readSTL(buf.slice(0, 100))).toThrow();
  });
});
