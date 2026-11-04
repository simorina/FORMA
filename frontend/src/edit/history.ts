/** Undo/redo of sculpt strokes, stored as sparse patches (only the vertices a stroke moved). */

export interface Patch {
  indices: Uint32Array;
  before: Float32Array;
  after: Float32Array;
}

const sizeOf = (p: Patch) => p.indices.byteLength + p.before.byteLength + p.after.byteLength;

function apply(positions: Float32Array, indices: Uint32Array, values: Float32Array): void {
  for (let k = 0; k < indices.length; k++) positions.set(values.subarray(3 * k, 3 * k + 3), 3 * indices[k]);
}

export class History {
  private done: Patch[] = [];
  private undone: Patch[] = [];
  private bytes = 0;

  constructor(
    private readonly limitBytes = 96 * 1024 * 1024,
    private readonly limitSteps = 200,
  ) {}

  push(patch: Patch): void {
    for (const p of this.undone) this.bytes -= sizeOf(p);
    this.undone = [];
    this.done.push(patch);
    this.bytes += sizeOf(patch);
    // Forget the oldest steps first; the latest one is always kept.
    while (this.done.length > 1 && (this.bytes > this.limitBytes || this.done.length > this.limitSteps)) {
      this.bytes -= sizeOf(this.done.shift()!);
    }
  }

  /** Restore the positions before the last stroke; returns it (to refresh normals) or null. */
  undo(positions: Float32Array): Patch | null {
    const p = this.done.pop();
    if (!p) return null;
    apply(positions, p.indices, p.before);
    this.undone.push(p);
    return p;
  }

  redo(positions: Float32Array): Patch | null {
    const p = this.undone.pop();
    if (!p) return null;
    apply(positions, p.indices, p.after);
    this.done.push(p);
    return p;
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Strokes that can be undone. */
  get steps(): number {
    return this.done.length;
  }

  get memory(): number {
    return this.bytes;
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.bytes = 0;
  }
}
