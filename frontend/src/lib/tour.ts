/**
 * The guided tour: its steps, and the pure geometry that puts the card beside the part of the
 * interface each step highlights (tested in tour.test.ts; the DOM side is ui/tour.ts).
 */

export interface TourStep {
  id: string;
  title: string;
  text: string;
  /** CSS selectors of what to highlight (their union); none: a card in the middle of the screen */
  targets?: string[];
  /** where the targets live: that panel is brought forward first (a bottom sheet on narrow screens) */
  panel?: 'create' | 'print' | 'viewport' | 'topbar';
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Benvenuto nell’atelier',
    text: 'Forma trasforma una frase, una foto o una mesh in un modello 3D pronto per la tua stampante: riparato, orientato, in millimetri. Ecco dove si trova tutto, in nove passi.',
  },
  {
    id: 'prompt',
    title: 'Descrivi l’oggetto',
    text: 'Scrivi cosa vuoi stampare e premi Invio, o parti da un’ispirazione qui sotto. Con «Mostrami prima l’immagine» approvi la foto di partenza prima del 3D, che usa la GPU. Con «Immagine» parti invece da una foto tua: trascinala nel riquadro.',
    targets: ['.block-prompt', '.block-examples'],
    panel: 'create',
  },
  {
    id: 'upload',
    title: 'Ripara una mesh',
    text: 'Trascina un file STL, OBJ, 3MF, GLB o PLY, o una foto, in un punto qualsiasi della finestra, oppure incollalo: la mesh viene riparata e preparata, la foto va nel riquadro Immagine.',
    targets: ['.block-upload'],
    panel: 'create',
  },
  {
    id: 'model',
    title: 'Il modello 3D',
    text: 'Scegli dove generare, il modello e la qualità. Accanto a ogni nome c’è la sua licenza: Hunyuan3D non vale nell’Unione Europea. Da un’immagine scegli fra Idol, sulla tua GPU, e gli Space di Hugging Face.',
    targets: ['.block-model'],
    panel: 'create',
  },
  {
    id: 'bed',
    title: 'Il piatto di stampa',
    text: 'Trascina per girare intorno al modello, rotella o due dita per lo zoom. In alto a destra: inquadra, rotazione, sbalzi, sezione, triangoli e le viste rapide (tasti da 1 a 4).',
    targets: ['.viewport'],
    panel: 'viewport',
  },
  {
    id: 'report',
    title: 'Resoconto ed esportazione',
    text: 'Grammi di filamento sulla bobina, costo, tempo, misure, sbalzi e riparazioni. Sotto, i file per lo slicer: il 3MF conserva i millimetri.',
    targets: ['.block-report', '.block-export'],
    panel: 'print',
  },
  {
    id: 'printer',
    title: 'Stampante e filamento',
    text: 'Il piatto prende le misure della tua stampante. Il colore del filamento tinge il modello e le cifre del resoconto; materiale, riempimento e prezzo rifanno le stime.',
    targets: ['.block-printer'],
    panel: 'print',
  },
  {
    id: 'prepare',
    title: 'Dimensioni e preparazione',
    text: 'Misura in millimetri con la verifica del piatto, orientamento, base piana, svuotamento e base d’appoggio. Quando hai scelto, premi Applica.',
    targets: ['.block-prep'],
    panel: 'print',
  },
  {
    id: 'finish',
    title: 'Modifica, cronologia, scorciatoie',
    text: 'Con la matita (o il tasto E) modifichi la forma a mano, poi «Ripara e aggiorna». Ogni modello resta in Cronologia; ? elenca le scorciatoie. La guida si riapre da «Guida». Buona stampa.',
    targets: ['.topbar-actions'],
    panel: 'topbar',
  },
];

/** Roman numerals, for the house's numbering (1 to 3999). */
export function roman(n: number): string {
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let rest = Math.max(0, Math.floor(n));
  for (const [v, s] of table) {
    while (rest >= v) {
      out += s;
      rest -= v;
    }
  }
  return out;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
export type Side = 'right' | 'left' | 'below' | 'above' | 'inside' | 'center' | 'top' | 'bottom';

/** The smallest rectangle holding all of them (null for none). */
export function union(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Their overlap, or null when they do not overlap. */
export function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export interface PlaceOptions {
  /** phones and tablets: the card is docked above or below, the width of the screen */
  narrow?: boolean;
  /** space between the highlight and the card */
  gap?: number;
  /** space kept from the edges of the screen */
  margin?: number;
  /** narrow screens: height of the top bar and of the tab bar, never covered */
  top?: number;
  bottom?: number;
}

/**
 * Where the card goes. Wide screens: beside the highlight, on the first side that fits (right,
 * left, below, above; below and above first for a wide, short highlight like a toolbar); a
 * highlight too big for any side (the viewport) takes the card inside, in its lower left corner.
 * Narrow screens: docked at the top when the highlight is in the lower half, at the bottom
 * otherwise. No highlight: the middle of the screen. Always inside the screen.
 */
export function placeCard(target: Rect | null, card: Size, view: Size, opts: PlaceOptions = {}): { x: number; y: number; side: Side } {
  const gap = opts.gap ?? 16, m = opts.margin ?? 16;
  const top = opts.top ?? 0, bottom = opts.bottom ?? 0;
  const maxX = view.w - card.w - m, maxY = view.h - card.h - m;
  if (!target) {
    return { x: clamp((view.w - card.w) / 2, m, maxX), y: clamp((view.h - card.h) / 2, m, maxY), side: 'center' };
  }
  if (opts.narrow) {
    const x = clamp((view.w - card.w) / 2, m, maxX);
    const low = target.y + target.h / 2 > (top + view.h - bottom) / 2;
    return low
      ? { x, y: clamp(top + m, m, maxY), side: 'top' }
      : { x, y: clamp(view.h - bottom - card.h - m, m, maxY), side: 'bottom' };
  }
  const t = target;
  const sides: Record<'right' | 'left' | 'below' | 'above', () => { x: number; y: number } | null> = {
    right: () => (t.x + t.w + gap + card.w <= view.w - m ? { x: t.x + t.w + gap, y: clamp(t.y, m, maxY) } : null),
    left: () => (t.x - gap - card.w >= m ? { x: t.x - gap - card.w, y: clamp(t.y, m, maxY) } : null),
    below: () => (t.y + t.h + gap + card.h <= view.h - m ? { x: clamp(t.x, m, maxX), y: t.y + t.h + gap } : null),
    above: () => (t.y - gap - card.h >= m ? { x: clamp(t.x, m, maxX), y: t.y - gap - card.h } : null),
  };
  const order = t.w > t.h * 2 ? (['below', 'above', 'right', 'left'] as const) : (['right', 'left', 'below', 'above'] as const);
  for (const side of order) {
    const p = sides[side]();
    if (p) return { ...p, side };
  }
  const inset = 24;
  return {
    x: clamp(t.x + inset, m, maxX),
    y: clamp(t.y + t.h - card.h - inset, m, maxY),
    side: 'inside',
  };
}
