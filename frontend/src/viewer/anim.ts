/**
 * Motion in the 3D view: the house's curves (lib/motion.ts EASE) as functions of t in [0, 1],
 * and small tweens the render loop steps once per frame. Nothing here allocates per frame, and
 * every step() says whether its value changed, so the viewer renders only while something moves.
 */

export type Ease = (t: number) => number;

/** EASE.out, cubic-bezier(0.16, 1, 0.3, 1): fast, then a long settle (an exponential out). */
export const easeOut: Ease = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/** EASE.inOut, cubic-bezier(0.65, 0, 0.35, 1): moves from one place to another. */
export const easeInOut: Ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** A gentle in-out at a steady speed in the middle: the print rising layer by layer. */
export const easeSteady: Ease = (t) => (1 - Math.cos(Math.PI * t)) / 2;

/** A cubic out, softer than easeOut: things that grow into place (dimension lines). */
export const easeOutCubic: Ease = (t) => 1 - (1 - t) ** 3;

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * The dolly "breath" of a camera move, as a factor on its distance: 1 at both ends, the camera
 * eases back a little (about `depth`) as it sets off, comes in a touch closer than its goal near
 * the end and settles there, so the move lands instead of stopping.
 */
export function breath(t: number, depth: number): number {
  return 1 + depth * Math.sin(2 * Math.PI * t) * (1 - t);
}

/**
 * A press, as a scale at time t of its duration: exactly lib/motion.ts press() (the keycaps and
 * buttons of the interface), keyframes 1 → `depth` at 35 % → 1 on the EASE.out progress, so it
 * sinks at once and comes back with a long settle.
 */
export function pressScale(t: number, depth = 0.92): number {
  if (t <= 0 || t >= 1) return 1;
  const p = easeOut(t);
  return p < 0.35 ? 1 + (depth - 1) * (p / 0.35) : depth + (1 - depth) * ((p - 0.35) / 0.65);
}

/**
 * Line segments (pairs of xyz points in `src`) drawn from their centres: each one in `dst` is
 * scaled by `s` (0: a point at its middle, 1: whole), for the segments in [first, last).
 */
export function growSegments(src: Float32Array, dst: Float32Array, first: number, last: number, s: number): void {
  for (let k = first; k < last; k++) {
    const i = k * 6;
    for (let c = 0; c < 3; c++) {
      const a = src[i + c], b = src[i + 3 + c];
      const m = (a + b) / 2;
      dst[i + c] = m + (a - m) * s;
      dst[i + 3 + c] = m + (b - m) * s;
    }
  }
}

/** A number that glides to a goal; step() it once per frame. */
export class Glide {
  value: number;
  private from: number;
  private target: number;
  private start = 0;
  private duration = 0;
  private ease: Ease = easeInOut;

  constructor(value = 0) {
    this.value = this.from = this.target = value;
  }

  get goal(): number {
    return this.target;
  }

  get moving(): boolean {
    return this.value !== this.target;
  }

  /** Glide from where it is to `goal` in `duration` ms, after `delay` ms; a duration of 0 jumps. */
  to(goal: number, now: number, duration: number, ease: Ease = easeInOut, delay = 0): void {
    if (goal === this.target && this.moving) return; // already on its way there
    if (duration <= 0 || goal === this.value) {
      this.jump(goal);
      return;
    }
    this.from = this.value;
    this.target = goal;
    this.start = now + delay;
    this.duration = duration;
    this.ease = ease;
  }

  jump(value: number): void {
    this.value = this.from = this.target = value;
  }

  /** Advance to `now`: true when the value changed (there is a frame to draw). */
  step(now: number): boolean {
    if (this.value === this.target) return false;
    const t = (now - this.start) / this.duration;
    if (t <= 0) return false; // waiting for its delay
    const v = t >= 1 ? this.target : this.from + (this.target - this.from) * this.ease(t);
    if (v === this.value) return false;
    this.value = v;
    return true;
  }
}
