/** Binary STL (little-endian): 80-byte header, uint32 count, 50 bytes per triangle. */

const DEFAULT_HEADER = 'Forma binary STL - millimetres - Z up';

export function writeSTL(positions: Float32Array, index: Uint32Array, header = DEFAULT_HEADER): ArrayBuffer {
  const count = index.length / 3;
  const buf = new ArrayBuffer(84 + 50 * count);
  const dv = new DataView(buf);
  // ASCII only, and never starting with "solid" (readers would take the file for ASCII STL).
  const text = header.startsWith('solid') ? `Forma ${header}` : header;
  for (let i = 0; i < Math.min(80, text.length); i++) dv.setUint8(i, text.charCodeAt(i) & 0x7f);
  dv.setUint32(80, count, true);
  let o = 84;
  for (let t = 0; t < index.length; t += 3) {
    const a = 3 * index[t], b = 3 * index[t + 1], c = 3 * index[t + 2];
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    dv.setFloat32(o, nx, true);
    dv.setFloat32(o + 4, ny, true);
    dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(o, positions[v], true);
      dv.setFloat32(o + 4, positions[v + 1], true);
      dv.setFloat32(o + 8, positions[v + 2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}

export interface ParsedSTL {
  count: number;
  normals: Float32Array;
  positions: Float32Array; // 9 floats per triangle, unwelded
}

export function readSTL(buf: ArrayBuffer): ParsedSTL {
  const dv = new DataView(buf);
  const count = dv.getUint32(80, true);
  if (buf.byteLength !== 84 + 50 * count) throw new Error('STL binario non valido');
  const normals = new Float32Array(count * 3);
  const positions = new Float32Array(count * 9);
  let o = 84;
  for (let t = 0; t < count; t++) {
    for (let j = 0; j < 3; j++) normals[3 * t + j] = dv.getFloat32(o + 4 * j, true);
    for (let j = 0; j < 9; j++) positions[9 * t + j] = dv.getFloat32(o + 12 + 4 * j, true);
    o += 50;
  }
  return { count, normals, positions };
}
