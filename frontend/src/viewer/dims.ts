/**
 * X, Y and Z dimension lines with their sizes in millimetres, around the model's bounds.
 * When a model arrives they draw in like a pen on a pattern sheet: X, then Y, then Z, each line
 * from its centre out to its end ticks, its label rising into place as the line arrives
 * (.dim-label.is-entering, styles/viewer.css).
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mm } from '../lib/format';
import { DUR } from '../lib/motion';
import { clamp01, easeOut, easeOutCubic, growSegments } from './anim';

/** Segments per axis, in the order they are written: the line first, then its end ticks. */
const AXES = [
  { first: 0, ticks: 1, last: 3 }, // X: line, two ticks
  { first: 3, ticks: 4, last: 6 }, // Y: line, two ticks
  { first: 6, ticks: 7, last: 8 }, // Z: line, the top tick
] as const;
const SEGMENTS = 8;

// The draw-in, in ms from its start
const STAGGER = 90; // between the axes
const LINE = 560; // a line from its centre to its ends
const TICKS_AT = 300; // the ticks open as the line reaches them
const TICK = DUR.short;
const LABEL_AT = 180; // the label starts rising (its CSS animation lasts DUR.base)

type State = 'hidden' | 'held' | 'entering' | 'shown';

export class Dimensions {
  readonly group = new THREE.Group();
  private readonly lines: THREE.LineSegments;
  private readonly goal = new Float32Array(SEGMENTS * 6);
  private readonly drawn = new Float32Array(SEGMENTS * 6);
  private readonly position = new THREE.BufferAttribute(this.drawn, 3);
  private labels: { el: HTMLDivElement; obj: CSS2DObject }[] = [];
  private state: State = 'hidden';
  private start = 0;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', this.position);
    this.lines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: 0x4a4238, transparent: true, opacity: 0.7, depthTest: false }),
    );
    this.lines.renderOrder = 5;
    this.lines.frustumCulled = false; // its vertices are rewritten in place
    this.group.add(this.lines);
    for (const axis of ['X', 'Y', 'Z']) {
      const el = document.createElement('div');
      el.className = 'dim-label';
      el.dataset.axis = axis;
      // once played (or cut short by a hide) the entry goes, so a label shown again is just there
      const done = () => el.classList.remove('is-entering');
      el.addEventListener('animationend', done);
      el.addEventListener('animationcancel', done);
      const obj = new CSS2DObject(el);
      this.labels.push({ el, obj });
      this.group.add(obj);
    }
    this.group.visible = false;
  }

  /**
   * Measure this box (null hides the lines). `hold`: keep them hidden until enter() (a model
   * that is still rising from the bed); otherwise lines already shown or entering follow it.
   */
  update(box: THREE.Box3 | null, hold = false): void {
    if (!box || box.isEmpty()) {
      this.state = 'hidden';
      this.group.visible = false;
      return;
    }
    const { min: a, max: b } = box;
    const size = box.getSize(new THREE.Vector3());
    const o = Math.max(4, 0.07 * Math.max(size.x, size.y, size.z)); // offset from the model
    const t = o * 0.35; // tick half-length
    const y0 = a.y - o, x1 = b.x + o, y1 = b.y + o;
    this.goal.set([
      // X along the front edge, with end ticks
      a.x, y0, 0, b.x, y0, 0,
      a.x, y0 - t, 0, a.x, y0 + t, 0,
      b.x, y0 - t, 0, b.x, y0 + t, 0,
      // Y along the right edge
      x1, a.y, 0, x1, b.y, 0,
      x1 - t, a.y, 0, x1 + t, a.y, 0,
      x1 - t, b.y, 0, x1 + t, b.y, 0,
      // Z up the back-right corner: from the default 3/4 view it stands beside the model,
      // not in front of it
      x1, y1, a.z, x1, y1, b.z,
      x1 - t, y1, b.z, x1 + t, y1, b.z,
    ]);
    const [lx, ly, lz] = this.labels;
    lx.obj.position.set((a.x + b.x) / 2, y0 - t * 2.4, 0);
    ly.obj.position.set(x1 + t * 2.4, (a.y + b.y) / 2, 0);
    lz.obj.position.set(x1 + t * 1.2, y1, (a.z + b.z) / 2);
    lx.el.textContent = `${mm(size.x)} mm`;
    ly.el.textContent = `${mm(size.y)} mm`;
    lz.el.textContent = `${mm(size.z)} mm`;
    if (hold || this.state === 'held') {
      this.state = 'held';
      this.group.visible = false;
    } else if (this.state !== 'entering') {
      this.state = 'shown';
      this.drawn.set(this.goal);
      this.position.needsUpdate = true;
      this.group.visible = true;
    }
  }

  /** Show lines held back by update(): drawn in from their centres, or at once. */
  enter(now: number, animate: boolean): void {
    if (this.state === 'hidden') return;
    this.group.visible = true;
    if (!animate) {
      this.state = 'shown';
      this.drawn.set(this.goal);
      this.position.needsUpdate = true;
      return;
    }
    this.state = 'entering';
    this.start = now;
    this.draw(now);
    this.labels.forEach(({ el }, i) => {
      el.style.setProperty('--dim-delay', `${i * STAGGER + LABEL_AT}ms`);
      el.classList.remove('is-entering');
      if (el.style.display !== 'none') void el.offsetWidth; // shown already: restart the entry
      el.classList.add('is-entering');
    });
  }

  /** Advance the draw-in; true while it runs (a frame to render). */
  tick(now: number): boolean {
    if (this.state !== 'entering') return false;
    this.draw(now);
    if (now - this.start >= (AXES.length - 1) * STAGGER + Math.max(LINE, TICKS_AT + TICK)) {
      this.state = 'shown';
      this.drawn.set(this.goal);
    }
    return true;
  }

  private draw(now: number): void {
    for (let i = 0; i < AXES.length; i++) {
      const axis = AXES[i];
      const local = now - this.start - i * STAGGER;
      growSegments(this.goal, this.drawn, axis.first, axis.ticks, easeOutCubic(clamp01(local / LINE)));
      growSegments(this.goal, this.drawn, axis.ticks, axis.last, easeOut(clamp01((local - TICKS_AT) / TICK)));
    }
    this.position.needsUpdate = true;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }
}
