/** A minimal observable store: components subscribe and compare slices of state. */

export type Listener<S> = (state: S, prev: S) => void;

export interface Store<S> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: Listener<S>): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<Listener<S>>();
  return {
    get: () => state,
    set(patch) {
      const prev = state;
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      for (const l of listeners) l(state, prev);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
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
