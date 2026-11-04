import { describe, expect, it } from 'vitest';
import { createStore, sameFields, sameItems, sameJson } from './store';

interface S {
  n: number;
  text: string;
  size: [number, number, number] | null;
  flags: { a: boolean; b: number };
}

const initial = (): S => ({ n: 0, text: '', size: null, flags: { a: false, b: 1 } });

describe('store', () => {
  it('notifies with the new and the previous state', () => {
    const store = createStore(initial());
    const seen: [number, number][] = [];
    store.subscribe((s, prev) => seen.push([s.n, prev.n]));
    store.set({ n: 1 });
    store.set((s) => ({ n: s.n + 1 }));
    expect(seen).toEqual([[1, 0], [2, 1]]);
    expect(store.get().n).toBe(2);
  });

  it('notifies nobody when a set changes nothing', () => {
    const store = createStore(initial());
    let calls = 0;
    store.subscribe(() => calls++);
    const before = store.get();
    store.set({ n: 0, text: '' });
    store.set({});
    expect(calls).toBe(0);
    expect(store.get()).toBe(before); // not even a new state object
    store.set({ n: 0, text: 'x' }); // one key that changes is enough
    expect(calls).toBe(1);
  });

  it('compares the slices it is told to by value, keeping the old object', () => {
    const store = createStore(initial(), { size: sameItems, flags: sameFields });
    let calls = 0;
    store.subscribe(() => calls++);
    store.set({ size: [1, 2, 3] });
    const size = store.get().size;
    store.set({ size: [1, 2, 3], flags: { a: false, b: 1 } });
    expect(calls).toBe(1);
    // with a real change elsewhere, the equal slice keeps its identity
    store.set({ size: [1, 2, 3], n: 5 });
    expect(calls).toBe(2);
    expect(store.get().size).toBe(size);
    store.set({ size: [1, 2, 4] });
    expect(calls).toBe(3);
  });

  it('unsubscribes', () => {
    const store = createStore(initial());
    let calls = 0;
    const off = store.subscribe(() => calls++);
    off();
    store.set({ n: 1 });
    expect(calls).toBe(0);
  });
});

describe('equalities', () => {
  it('sameItems: same items in the same order', () => {
    expect(sameItems([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameItems([1, 2, 3], [1, 3, 2])).toBe(false);
    expect(sameItems([1, 2], [1, 2, 3])).toBe(false);
    expect(sameItems(null, null)).toBe(true);
    expect(sameItems(null, [1])).toBe(false);
  });

  it('sameFields: same flat fields', () => {
    expect(sameFields({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true);
    expect(sameFields({ a: 1, b: 'x' }, { a: 1, b: 'y' })).toBe(false);
    expect(sameFields<Record<string, number>>({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameFields(null, { a: 1 })).toBe(false);
  });

  it('sameJson: a response fetched again', () => {
    const job = { id: 'j', status: 'running', progress: 0.4, stages: [{ key: 'shape', status: 'active' }] };
    expect(sameJson(job, JSON.parse(JSON.stringify(job)))).toBe(true);
    expect(sameJson(job, { ...job, progress: 0.5 })).toBe(false);
    expect(sameJson<typeof job | null>(job, null)).toBe(false);
    expect(sameJson(null, null)).toBe(true);
  });
});
