/**
 * Mouse and touch sculpting on the viewer's mesh: a brush cursor that follows the surface,
 * grab / smooth / inflate strokes with soft selection and X symmetry, undo and redo.
 * The pure maths lives in brushes.ts, mesh.ts and history.ts.
 *
 * The brush ring is alive but quiet: it opens when the pointer reaches the model, breathes very
 * slightly while it rests there (and settles after a few seconds, so an idle view renders
 * nothing), sinks like a pressed key with a ripple going out when a stroke starts, and glides to
 * a new radius. The viewer's loop calls tick() each frame; under reduced motion it stays still.
 */
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { reducedMotion } from '../lib/dom';
import { DUR } from '../lib/motion';
import { Glide, clamp01, easeOut, pressScale } from '../viewer/anim';
import {
  GrabStroke,
  StrokeRecorder,
  influence,
  inflateWith,
  smoothWith,
  type BrushSettings,
  type Vec3,
} from './brushes';
import type { Falloff } from './falloff';
import { History } from './history';
import { type CSR, updateNormals, vertexFaces, vertexNeighbors } from './mesh';

export type Tool = 'grab' | 'smooth' | 'inflate';

export const TOOLS: readonly { key: Tool; label: string; shortcut: string }[] = [
  { key: 'grab', label: 'Sposta', shortcut: 'G' },
  { key: 'smooth', label: 'Leviga', shortcut: 'S' },
  { key: 'inflate', label: 'Gonfia', shortcut: 'I' },
];

export interface SculptState {
  tool: Tool;
  radius: number;
  strength: number;
  falloff: Falloff;
  symmetry: boolean;
  canUndo: boolean;
  canRedo: boolean;
  steps: number;
}

interface Context {
  dom: HTMLElement;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  scene: THREE.Scene;
  requestRender(): void;
  onChange(state: SculptState): void;
  onShapeChanged(): void;
}

/** The ring's breath: one slow cycle, and how long it goes on after the pointer stops. */
const BREATH_PERIOD = 2800;
const BREATH_FOR = 5000;
const BREATH_SETTLE = 1200;
const RIPPLE_MS = 560;

interface Cursor {
  group: THREE.Group;
  ripple: THREE.Mesh;
  ring: THREE.MeshBasicMaterial;
  disc: THREE.MeshBasicMaterial;
  dot: THREE.MeshBasicMaterial;
  wave: THREE.MeshBasicMaterial;
  opacity: number;
}

interface Active {
  pointerId: number;
  tool: Tool;
  grab?: GrabStroke;
  plane?: THREE.Plane;
  start?: THREE.Vector3;
  last?: THREE.Vector3;
  sign: 1 | -1;
}

export class Sculpt {
  tool: Tool = 'grab';
  radius = 8;
  strength = 0.5;
  falloff: Falloff = 'smooth';
  symmetry = true;

  private enabled = false;
  private mesh: THREE.Mesh | null = null;
  private positions: Float32Array | null = null;
  private normals: Float32Array | null = null;
  private index: Uint32Array | null = null;
  private faces: CSR | null = null;
  private neighbors: CSR | null = null;
  private readonly history = new History();
  private readonly recorder = new StrokeRecorder();
  private active: Active | null = null;
  private readonly pointers = new Set<number>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly brushRing: Cursor;
  private readonly mirrorRing: Cursor;
  private readonly rings: readonly Cursor[];
  private readonly cursor: THREE.Group;
  private readonly mirrorCursor: THREE.Group;
  private refitPending = false;
  // the ring's motion (times from performance.now())
  private readonly shownRadius = new Glide(8);
  private openedAt = -1e9; // the pointer reached the model: the ring opens, then breathes
  private movedAt = 0; // the breath settles a while after the pointer stops
  private pressedAt = -1e9; // a stroke began: the ring sinks, a ripple goes out
  private pulsedAt = -1e9; // a tool was picked: a ripple
  private wasMoving = false;
  private calm = false; // prefers-reduced-motion, read when sculpting starts and at each stroke

  constructor(private readonly ctx: Context) {
    (this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
    this.brushRing = makeCursor();
    this.mirrorRing = makeCursor(0.45);
    this.rings = [this.brushRing, this.mirrorRing];
    this.cursor = this.brushRing.group;
    this.mirrorCursor = this.mirrorRing.group;
    ctx.scene.add(this.cursor, this.mirrorCursor);
    const dom = ctx.dom;
    // Capture phase: decide before OrbitControls whether this press sculpts or orbits.
    dom.addEventListener('pointerdown', this.onDown, { capture: true });
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointercancel', this.onUp);
    dom.addEventListener('pointerleave', this.onLeave);
  }

  /** Use this mesh (its geometry is welded and indexed; positions are edited in place). */
  attach(mesh: THREE.Mesh): void {
    this.mesh = mesh;
    const g = mesh.geometry;
    this.positions = g.getAttribute('position').array as Float32Array;
    this.normals = g.getAttribute('normal').array as Float32Array;
    this.index = g.getIndex()!.array as Uint32Array;
    this.faces = null; // adjacency is built on first use
    this.neighbors = null;
    this.history.clear();
    g.computeBoundingBox();
    const size = g.boundingBox!.getSize(new THREE.Vector3());
    this.radius = Math.max(1, Math.round(Math.max(size.x, size.y, size.z) * 0.12));
    this.emit();
  }

  detach(): void {
    this.mesh = this.positions = this.normals = this.index = null;
    this.faces = this.neighbors = null;
    this.history.clear();
    this.hideCursor();
    this.emit();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.calm = reducedMotion();
    if (on && this.mesh && !this.faces) {
      const count = this.positions!.length / 3;
      this.faces = vertexFaces(this.index!, count);
      this.neighbors = vertexNeighbors(this.index!, count);
    }
    if (!on) {
      this.cancelStroke();
      this.hideCursor();
    }
    this.ctx.dom.classList.toggle('is-sculpting', on);
    this.ctx.requestRender();
  }

  get state(): SculptState {
    return {
      tool: this.tool, radius: this.radius, strength: this.strength, falloff: this.falloff,
      symmetry: this.symmetry, canUndo: this.history.canUndo, canRedo: this.history.canRedo,
      steps: this.history.steps,
    };
  }

  get edited(): boolean {
    return this.history.steps > 0;
  }

  set(patch: Partial<Pick<SculptState, 'tool' | 'radius' | 'strength' | 'falloff' | 'symmetry'>>): void {
    if (patch.tool && patch.tool !== this.tool && this.cursor.visible) {
      this.pulsedAt = performance.now(); // a new tool in hand: the ring answers
      this.ctx.requestRender();
    }
    Object.assign(this, patch);
    this.radius = Math.max(0.5, Math.min(this.radius, 500));
    this.strength = Math.max(0.05, Math.min(this.strength, 1));
    this.updateCursorScale();
    this.emit();
  }

  /** [ and ] : radius in steps of 15 %. */
  scaleRadius(factor: number): void {
    this.set({ radius: Math.round(this.radius * factor * 10) / 10 });
  }

  undo(): boolean {
    return this.applyHistory(this.history.undo(this.positions!));
  }

  redo(): boolean {
    return this.applyHistory(this.history.redo(this.positions!));
  }

  /** Forget the edit history (after the edited mesh was sent to the backend). */
  reset(): void {
    this.history.clear();
    this.emit();
  }

  // -- pointer handling ------------------------------------------------------------------
  private onDown = (e: PointerEvent) => {
    this.pointers.add(e.pointerId);
    if (this.pointers.size > 1) {
      this.cancelStroke(); // a second finger: pinch / orbit instead
      return;
    }
    if (!this.enabled || !this.mesh || e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    const hit = this.pick(e);
    if (!hit) return; // empty space: let OrbitControls orbit
    this.ctx.controls.enabled = false;
    this.ctx.dom.setPointerCapture(e.pointerId);
    this.calm = reducedMotion();
    this.pressedAt = performance.now();
    const center = hit.point.clone();
    this.active = { pointerId: e.pointerId, tool: this.tool, sign: e.shiftKey ? -1 : 1, last: center };
    if (this.tool === 'grab') {
      const grab = new GrabStroke(this.positions!, center.toArray() as Vec3, this.brush());
      this.recorder.touch(this.positions!, grab.indices);
      const normal = this.ctx.camera.getWorldDirection(new THREE.Vector3());
      this.active.grab = grab;
      this.active.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center);
      this.active.start = center;
    } else {
      this.dab(center);
    }
    this.showCursor(hit);
    e.preventDefault();
  };

  private onMove = (e: PointerEvent) => {
    if (!this.enabled || !this.mesh) return;
    const a = this.active;
    if (a && e.pointerId === a.pointerId) {
      if (a.grab && a.plane && a.start) {
        const p = this.rayFrom(e).ray.intersectPlane(a.plane, new THREE.Vector3());
        if (p) {
          const d = p.sub(a.start);
          a.grab.apply(this.positions!, [d.x, d.y, d.z]);
          this.afterMove(a.grab.indices, false);
          this.moveCursor(a.start.clone().add(d), null);
        }
      } else {
        const hit = this.pick(e);
        if (hit) {
          this.showCursor(hit);
          const spacing = this.radius * 0.2;
          if (!a.last || hit.point.distanceTo(a.last) >= spacing) {
            this.dab(hit.point);
            a.last = hit.point.clone();
          }
        }
      }
      return;
    }
    if (e.buttons === 0 && e.pointerType !== 'touch') {
      const hit = this.pick(e);
      if (hit) this.showCursor(hit);
      else this.hideCursor();
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    const a = this.active;
    if (!a || e.pointerId !== a.pointerId) return;
    this.finishStroke();
    if (this.ctx.dom.hasPointerCapture(e.pointerId)) this.ctx.dom.releasePointerCapture(e.pointerId);
  };

  private onLeave = () => {
    if (!this.active) this.hideCursor();
  };

  // -- strokes -------------------------------------------------------------------------
  private brush(): BrushSettings {
    return { radius: this.radius, strength: this.strength, falloff: this.falloff, symmetryX: this.symmetry };
  }

  private dab(point: THREE.Vector3): void {
    const s = this.brush();
    const inf = influence(this.positions!, point.toArray() as Vec3, s);
    // record first: the recorder keeps each vertex's position from before the stroke
    this.recorder.touch(this.positions!, inf.indices);
    const moved = this.tool === 'smooth'
      ? smoothWith(this.positions!, this.neighbors!, inf, s.strength)
      : inflateWith(this.positions!, this.normals!, inf, s, this.active?.sign ?? 1);
    this.afterMove(moved, true);
  }

  private afterMove(indices: Uint32Array, refit: boolean): void {
    if (!indices.length) return;
    updateNormals(this.positions!, this.index!, this.normals!, this.faces!, indices);
    const g = this.mesh!.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('normal').needsUpdate = true;
    if (refit) this.scheduleRefit();
    this.ctx.requestRender();
  }

  private scheduleRefit(): void {
    if (this.refitPending) return;
    this.refitPending = true;
    requestAnimationFrame(() => {
      this.refitPending = false;
      this.refit();
    });
  }

  private refit(): void {
    const g = this.mesh?.geometry as (THREE.BufferGeometry & { boundsTree?: { refit(): void } }) | undefined;
    g?.boundsTree?.refit();
    g?.computeBoundingSphere();
  }

  private finishStroke(): void {
    const patch = this.recorder.finish(this.positions!);
    if (patch) this.history.push(patch);
    this.active = null;
    this.ctx.controls.enabled = true;
    this.refit();
    this.mesh!.geometry.computeBoundingBox();
    this.emit();
    if (patch) this.ctx.onShapeChanged();
  }

  private cancelStroke(): void {
    if (this.active) this.finishStroke();
  }

  private applyHistory(patch: ReturnType<History['undo']>): boolean {
    if (!patch || !this.mesh) return false;
    this.afterMove(patch.indices, false);
    this.refit();
    this.mesh.geometry.computeBoundingBox();
    this.emit();
    this.ctx.onShapeChanged();
    return true;
  }

  /** Ink on light filaments, white on dark ones: the brush ring must read on the surface. */
  setCursorColor(hex: number): void {
    for (const c of this.rings) {
      for (const m of [c.ring, c.disc, c.dot, c.wave]) m.color.setHex(hex);
    }
    this.ctx.requestRender();
  }

  /**
   * Animate the brush ring to `now` (the viewer calls this once per frame): its opening, breath,
   * press, ripple and radius. True while it moves, so the viewer renders a frame.
   */
  tick(now: number): boolean {
    const resized = this.shownRadius.step(now);
    if (!this.cursor.visible) {
      this.wasMoving = false;
      return false;
    }
    let moving = resized;
    let open = 1, press = 1, wave = -1, breathe = 0;
    if (!this.calm) {
      const tOpen = (now - this.openedAt) / DUR.micro;
      if (tOpen < 1) {
        open = easeOut(clamp01(tOpen));
        moving = true;
      }
      const tPress = (now - this.pressedAt) / DUR.short;
      if (tPress < 1) {
        press = pressScale(tPress, 0.9);
        moving = true;
      }
      const tWave = (now - Math.max(this.pressedAt, this.pulsedAt)) / RIPPLE_MS;
      if (tWave < 1) {
        wave = clamp01(tWave);
        moving = true;
      }
      // a slow breath while the pointer rests on the model (not while it sculpts), dying away
      const amp = this.active ? 0 : clamp01(1 - (now - this.movedAt - BREATH_FOR) / BREATH_SETTLE);
      if (amp > 0) {
        breathe = amp * Math.sin(((now - this.openedAt) / BREATH_PERIOD) * 2 * Math.PI);
        moving = true;
      }
    }
    const scale = this.shownRadius.value * (0.86 + 0.14 * open) * press * (1 + 0.014 * breathe);
    for (const c of this.rings) {
      c.group.scale.setScalar(scale);
      c.ring.opacity = c.dot.opacity = c.opacity * open;
      c.disc.opacity = 0.07 * c.opacity * open * (1 + 0.45 * breathe);
      c.ripple.visible = wave >= 0;
      if (wave >= 0) {
        c.ripple.scale.setScalar(1 + 0.55 * easeOut(wave));
        c.wave.opacity = 0.5 * c.opacity * (1 - wave) * (1 - wave);
      }
    }
    // one more frame once it stops, to draw it at rest
    const draw = moving || this.wasMoving;
    this.wasMoving = moving;
    return draw;
  }

  // -- picking and cursor ----------------------------------------------------------------
  private rayFrom(e: PointerEvent): THREE.Raycaster {
    const r = this.ctx.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.ctx.camera);
    return this.raycaster;
  }

  private pick(e: PointerEvent): THREE.Intersection | null {
    if (!this.mesh) return null;
    return this.rayFrom(e).intersectObject(this.mesh, false)[0] ?? null;
  }

  private showCursor(hit: THREE.Intersection): void {
    this.moveCursor(hit.point, hit.face?.normal ?? null);
  }

  private moveCursor(point: THREE.Vector3, normal: THREE.Vector3 | null): void {
    const up = new THREE.Vector3(0, 0, 1);
    const now = performance.now();
    if (!this.cursor.visible) {
      this.openedAt = now; // the ring opens where the pointer reached the model
      this.shownRadius.jump(this.radius);
    }
    this.movedAt = now;
    this.cursor.position.copy(point);
    if (normal) this.cursor.quaternion.setFromUnitVectors(up, normal);
    this.cursor.visible = true;
    this.mirrorCursor.visible = this.symmetry && Math.abs(point.x) > this.radius * 0.05;
    if (this.mirrorCursor.visible) {
      this.mirrorCursor.position.set(-point.x, point.y, point.z);
      if (normal) this.mirrorCursor.quaternion.setFromUnitVectors(up, new THREE.Vector3(-normal.x, normal.y, normal.z));
    }
    this.updateCursorScale();
    this.ctx.requestRender();
  }

  /** The ring glides to a new radius ([ and ] or the slider); tick() sets the scale. */
  private updateCursorScale(): void {
    const glide = this.cursor.visible && !this.calm;
    this.shownRadius.to(this.radius, performance.now(), glide ? DUR.micro : 0, easeOut);
    if (!glide) {
      this.cursor.scale.setScalar(this.radius);
      this.mirrorCursor.scale.setScalar(this.radius);
    }
    this.ctx.requestRender();
  }

  private hideCursor(): void {
    if (!this.cursor.visible && !this.mirrorCursor.visible) return;
    this.cursor.visible = this.mirrorCursor.visible = false;
    this.ctx.requestRender();
  }

  private emit(): void {
    this.ctx.onChange(this.state);
  }
}

/**
 * A ring and a faint disc, unit radius, facing +Z (rotated onto the surface normal), and the
 * ripple a stroke sends out (hidden until then).
 */
function makeCursor(opacity = 0.95): Cursor {
  const g = new THREE.Group();
  const material = (o: number) =>
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: o, depthTest: false, side: THREE.DoubleSide });
  const ringMat = material(opacity), discMat = material(0.07 * opacity), dotMat = material(opacity), waveMat = material(0);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.955, 1, 72), ringMat);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 72), discMat);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.035, 16), dotMat);
  const ripple = new THREE.Mesh(new THREE.RingGeometry(0.975, 1, 72), waveMat);
  ripple.visible = false;
  for (const m of [disc, ring, dot, ripple]) {
    m.renderOrder = 10;
    m.position.z = 0.02;
    g.add(m);
  }
  g.visible = false;
  return { group: g, ripple, ring: ringMat, disc: discMat, dot: dotMat, wave: waveMat, opacity };
}
