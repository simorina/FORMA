import { describe, expect, it } from 'vitest';
import { History, type Patch } from './history';

function patch(indices: number[], before: number[], after: number[]): Patch {
  return { indices: Uint32Array.from(indices), before: Float32Array.from(before), after: Float32Array.from(after) };
}

describe('History', () => {
  it('undoes and redoes strokes in order', () => {
    const pos = new Float32Array(9);
    const h = new History();
    pos.set([1, 1, 1], 3);
    h.push(patch([1], [0, 0, 0], [1, 1, 1]));
    pos.set([2, 2, 2], 6);
    pos.set([5, 5, 5], 3);
    h.push(patch([1, 2], [1, 1, 1, 0, 0, 0], [5, 5, 5, 2, 2, 2]));

    expect(h.undo(pos)).not.toBeNull();
    expect(Array.from(pos)).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0]);
    h.undo(pos);
    expect(Array.from(pos)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(h.canUndo).toBe(false);
    expect(h.undo(pos)).toBeNull();

    h.redo(pos);
    h.redo(pos);
    expect(Array.from(pos)).toEqual([0, 0, 0, 5, 5, 5, 2, 2, 2]);
    expect(h.canRedo).toBe(false);
  });

  it('drops the redo branch when a new stroke is made', () => {
    const pos = new Float32Array(3);
    const h = new History();
    h.push(patch([0], [0, 0, 0], [1, 0, 0]));
    h.undo(pos);
    expect(h.canRedo).toBe(true);
    h.push(patch([0], [0, 0, 0], [0, 3, 0]));
    expect(h.canRedo).toBe(false);
    expect(h.steps).toBe(1);
  });

  it('forgets the oldest strokes beyond its memory or step limit', () => {
    const one = patch([0], [0, 0, 0], [1, 1, 1]); // 4 + 12 + 12 = 28 bytes
    const h = new History(28 * 3, 100);
    for (let i = 0; i < 5; i++) h.push(patch([0], [i, 0, 0], [i + 1, 0, 0]));
    expect(h.steps).toBe(3);
    expect(h.memory).toBe(28 * 3);
    const byCount = new History(1e9, 2);
    for (let i = 0; i < 4; i++) byCount.push(one);
    expect(byCount.steps).toBe(2);
    const pos = new Float32Array(3);
    h.undo(pos);
    h.undo(pos);
    h.undo(pos);
    expect(pos[0]).toBe(2); // the earliest remaining stroke started from x = 2
  });

  it('clears everything', () => {
    const h = new History();
    h.push(patch([0], [0, 0, 0], [1, 1, 1]));
    h.clear();
    expect(h.canUndo || h.canRedo).toBe(false);
    expect(h.memory).toBe(0);
  });
});
