// The tests run in Node: the write helpers are checked on small stand-ins for elements.
import { describe, expect, it } from 'vitest';
import { attr, memo, prop } from './dom';

describe('memo', () => {
  it('draws the first time, then only when an input changes', () => {
    const view = memo();
    let draws = 0;
    view([1, 'a'], () => draws++);
    view([1, 'a'], () => draws++);
    expect(draws).toBe(1);
    view([2, 'a'], () => draws++);
    view([2, 'a', null], () => draws++); // more inputs: a change
    view([2, 'a', null], () => draws++);
    expect(draws).toBe(3);
  });

  it('compares with Object.is: objects by identity, NaN equal to NaN', () => {
    const view = memo();
    const o = { x: 1 };
    let draws = 0;
    view([o, NaN], () => draws++);
    view([o, NaN], () => draws++);
    view([{ x: 1 }, NaN], () => draws++);
    expect(draws).toBe(2);
  });

  it('draws again after a draw that failed', () => {
    const view = memo();
    expect(() => view([1], () => { throw new Error('boom'); })).toThrow('boom');
    let draws = 0;
    view([1], () => draws++);
    expect(draws).toBe(1);
  });
});

describe('prop', () => {
  it('writes only a value that differs', () => {
    let writes = 0;
    let hidden = false;
    const el = {
      get hidden() { return hidden; },
      set hidden(v: boolean) { writes++; hidden = v; },
    };
    prop(el, 'hidden', false);
    expect(writes).toBe(0);
    prop(el, 'hidden', true);
    prop(el, 'hidden', true);
    expect(writes).toBe(1);
    expect(el.hidden).toBe(true);
  });
});

describe('attr', () => {
  it('sets a value that differs and removes with null', () => {
    const attrs = new Map<string, string>();
    const calls: string[] = [];
    const el = {
      getAttribute: (n: string) => attrs.get(n) ?? null,
      setAttribute: (n: string, v: string) => { calls.push(`set ${n}=${v}`); attrs.set(n, v); },
      removeAttribute: (n: string) => { calls.push(`remove ${n}`); attrs.delete(n); },
    } as unknown as Element;
    attr(el, 'aria-pressed', 'true');
    attr(el, 'aria-pressed', 'true');
    attr(el, 'aria-pressed', 'false');
    attr(el, 'aria-pressed', null);
    expect(calls).toEqual(['set aria-pressed=true', 'set aria-pressed=false', 'remove aria-pressed']);
  });
});
