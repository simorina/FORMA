/** Italian number and time formatting (decimal comma, tabular figures in CSS). */

const fixed = new Map<number, Intl.NumberFormat>();

export function num(value: number, decimals = 0): string {
  let f = fixed.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    fixed.set(decimals, f);
  }
  return f.format(value);
}

/** Millimetres: one decimal under 1 m. */
export const mm = (v: number) => num(v, v < 1000 ? 1 : 0);

/** Grams: one decimal under 10 g, whole grams above. */
export const grams = (v: number) => num(v, v < 10 ? 1 : 0);

export const dims = (b: readonly number[]) => b.map((v) => mm(v)).join(' × ');

const rel = new Intl.RelativeTimeFormat('it', { numeric: 'auto' });
const day = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short' });

/** "adesso", "3 minuti fa", "ieri", "12 nov". `ts` in seconds (the backend's time.time()). */
export function ago(ts: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - ts);
  if (s < 45) return 'adesso';
  if (s < 3600) return rel.format(-Math.round(s / 60), 'minute');
  if (s < 6 * 3600) return rel.format(-Math.round(s / 3600), 'hour');
  const d0 = new Date(now * 1000);
  const d1 = new Date(ts * 1000);
  const days = Math.round((Date.UTC(d0.getFullYear(), d0.getMonth(), d0.getDate()) -
    Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate())) / 86400000);
  if (days === 0) return rel.format(-Math.round(s / 3600), 'hour');
  if (days === 1) return 'ieri';
  return day.format(d1);
}

/** A short title for a model: its prompt, or a fallback by kind. */
export function title(prompt: string | null | undefined, kind?: string): string {
  const p = (prompt ?? '').trim();
  if (p) return p.charAt(0).toUpperCase() + p.slice(1);
  if (kind === 'image') return 'Da una foto';
  if (kind === 'upload') return 'Mesh caricata';
  return 'Modello senza nome';
}
