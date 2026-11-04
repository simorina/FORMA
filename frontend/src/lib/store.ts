/** A minimal observable store: components subscribe and compare slices of state. */

export type Listener<S> = (state: S, prev: S) => void;

/** Per key, when two values count as the same (default: Object.is). */
export type Equality<S> = { [K in keyof S]?: (a: S[K], b: S[K]) => boolean };

export interface Store<S> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: Listener<S>): () => void;
}

/**
 * A set() that changes nothing notifies nobody: every listener runs a UI update, and most
 * patches repeat what is there (the same view, a job polled twice, sheet: null when closed).
 * `equals` compares by value the slices that arrive as fresh copies; an equal value keeps the
 * old object, so listeners that compare identities do not see a change either.
 */
export function createStore<S extends object>(initial: S, equals: Equality<S> = {}): Store<S> {
  let state = initial;
  const listeners = new Set<Listener<S>>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      let next: S | null = null;
      for (const key of Object.keys(p) as (keyof S)[]) {
        const value = p[key] as S[keyof S];
        const same = equals[key];
        if (Object.is(state[key], value) || (same && same(state[key], value))) continue;
        (next ??= { ...state })[key] = value;
      }
      if (!next) return;
      const prev = state;
      state = next;
      for (const l of listeners) l(state, prev);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Same items in the same order (sizes, short tuples). */
export function sameItems<T>(a: readonly T[] | null, b: readonly T[] | null): boolean {
  return a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
}

/** Same own fields with the same values (flat records such as the sculpt state). */
export function sameFields<T extends object>(a: T | null, b: T | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k], b[k]));
}

/** Same JSON (a response fetched again, such as a job polled while nothing moved). */
export function sameJson<T>(a: T, b: T): boolean {
  return a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));
}

/** localStorage that never throws (private windows, blocked storage). */
export const saved = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`forma:${key}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`forma:${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable: preferences just are not remembered */
    }
  },
};
