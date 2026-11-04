/**
 * The virtual print bed: a rounded plate the size of the chosen printer, a millimetre grid
 * (10 mm minor, 50 mm major lines) and the outline of the build volume.
 * The world is Z up, in millimetres, with the bed's centre at the origin (the backend
 * centres every model there).
 * A change of printer resizes the plate from the old size to the new one, and the new grid
 * (its lines a fixed 10 mm apart, so never stretched) fades in as the plate settles.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Printer } from '../lib/printers';
import { num } from '../lib/format';
import { DUR } from '../lib/motion';
import { Glide, easeInOut, easeOut } from './anim';

// A pale stone plate on the ivory sweep, its grid drawn in warm greys like a pattern sheet.
const PLATE = 0xe9e1d3;
const MINOR = 0xd5cab7;
const MAJOR = 0xbfb19a;
const EDGE = 0x9f8f76;
const VOLUME = 0xb9ab95;
const VOLUME_OVER = 0x9b2335;

/** Stencil test of what lies on the plate: drawn where the model (stencil 1) is not. */
const UNDER_MODEL = { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc } as const;

function roundedRect(w: number, d: number, r: number): THREE.Shape {
  const x = -w / 2, y = -d / 2;
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function gridLines(w: number, d: number, step: number, skip: number, z: number): Float32Array {
  const pts: number[] = [];
  const margin = 1;
  for (let x = 0; x <= w / 2 - margin; x += step) {
    for (const sx of x === 0 ? [0] : [x, -x]) {
      if (skip && Math.round(sx / skip) * skip === sx) continue;
      pts.push(sx, -d / 2 + margin, z, sx, d / 2 - margin, z);
    }
  }
  for (let y = 0; y <= d / 2 - margin; y += step) {
    for (const sy of y === 0 ? [0] : [y, -y]) {
      if (skip && Math.round(sy / skip) * skip === sy) continue;
      pts.push(-w / 2 + margin, sy, z, w / 2 - margin, sy, z);
    }
  }
  return new Float32Array(pts);
}

export class Bed {
  readonly group = new THREE.Group();
  private volumeMaterial = new THREE.LineBasicMaterial({ color: VOLUME, transparent: true, opacity: 0.8, visible: false });
  // The grid fades in after a resize (transparent from the start: the flag is baked in the
  // shader). It is drawn only where the model is not (the viewer's model marks the stencil): the
  // lines float 0.05 mm over the plate, and would rule the base of a print rising from it.
  private minorMaterial = new THREE.LineBasicMaterial({ color: MINOR, transparent: true, ...UNDER_MODEL });
  private majorMaterial = new THREE.LineBasicMaterial({ color: MAJOR, transparent: true, ...UNDER_MODEL });
  private labelEl = document.createElement('div');
  printer: Printer | null = null;
  // a resize: the group's scale goes from `from` (old size / new size) to 1
  private readonly grow = new Glide(1);
  private readonly from = new THREE.Vector3(1, 1, 1);
  private readonly grid = new Glide(1);

  constructor() {
    this.labelEl.className = 'bed-label';
    const done = () => this.labelEl.classList.remove('is-entering');
    this.labelEl.addEventListener('animationend', done);
    this.labelEl.addEventListener('animationcancel', done);
  }

  /** Lay the plate of this printer; `animate`: resize from the plate shown now (at time `now`). */
  build(p: Printer, animate = false, now = 0): void {
    const old = this.printer;
    if (old && old.w === p.w && old.d === p.d && old.h === p.h && old.label === p.label) {
      this.printer = p; // the same plate (the store and the app both ask for it): keep any resize going
      return;
    }
    // the size on screen now, a resize may be under way
    const s = this.group.scale;
    const shown = old ? [old.w * s.x, old.d * s.y, old.h * s.z] : null;
    this.printer = p;
    const keep = new Set<THREE.Material>([this.volumeMaterial, this.minorMaterial, this.majorMaterial]);
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => keep.has(x) || x.dispose());
      });
    }
    const shape = roundedRect(p.w, p.d, 8);

    const plate = new THREE.Mesh(
      new THREE.ShapeGeometry(shape, 12),
      new THREE.MeshStandardMaterial({
        // a little see-through: the mirrored model below reads as a soft reflection, as on
        // the glossy acrylic of a product shot
        color: PLATE, roughness: 0.5, metalness: 0, transparent: true, opacity: 0.84,
        // pushed back a hair: the model's base, on the plate at Z = 0, wins the depth test when
        // the print or the section shows it (the first layer) instead of flickering with it
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
      }),
    );
    plate.receiveShadow = true;
    plate.renderOrder = 1;
    this.group.add(plate);

    const minor = new THREE.BufferGeometry();
    minor.setAttribute('position', new THREE.BufferAttribute(gridLines(p.w, p.d, 10, 50, 0.04), 3));
    const major = new THREE.BufferGeometry();
    major.setAttribute('position', new THREE.BufferAttribute(gridLines(p.w, p.d, 50, 0, 0.05), 3));
    const minorLines = new THREE.LineSegments(minor, this.minorMaterial);
    const majorLines = new THREE.LineSegments(major, this.majorMaterial);
    minorLines.renderOrder = majorLines.renderOrder = 2;
    this.group.add(minorLines, majorLines);

    const edge = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(shape.getPoints(10).map((v) => new THREE.Vector3(v.x, v.y, 0.06))),
      new THREE.LineBasicMaterial({ color: EDGE, ...UNDER_MODEL }),
    );
    edge.renderOrder = 2;
    this.group.add(edge);

    const box = new THREE.BoxGeometry(p.w, p.d, p.h);
    box.translate(0, 0, p.h / 2);
    const volume = new THREE.LineSegments(new THREE.EdgesGeometry(box), this.volumeMaterial);
    box.dispose();
    this.group.add(volume);

    this.labelEl.textContent = `${p.label} · ${num(p.w)} × ${num(p.d)} × ${num(p.h)} mm`;
    const label = new CSS2DObject(this.labelEl);
    label.position.set(0, -p.d / 2 - Math.max(8, p.d * 0.04), 0);
    this.group.add(label);

    if (animate && shown) {
      // from the old plate to the new one; the label (put back in the page by the next render,
      // which starts its CSS entry) rides on the plate's front edge
      this.from.set(shown[0] / p.w, shown[1] / p.d, shown[2] / p.h);
      this.grow.jump(0);
      this.grow.to(1, now, DUR.base, easeInOut);
      this.grid.jump(0);
      this.grid.to(1, now, DUR.base, easeOut, DUR.micro);
      this.labelEl.classList.add('is-entering');
    } else {
      this.grow.jump(1);
      this.grid.jump(1);
      this.labelEl.classList.remove('is-entering');
    }
    this.applyGrow();
  }

  /** Advance a resize; true while it runs (a frame to render). */
  tick(now: number): boolean {
    const grew = this.grow.step(now);
    const faded = this.grid.step(now);
    if (grew || faded) this.applyGrow();
    return grew || faded;
  }

  private applyGrow(): void {
    const k = this.grow.value;
    this.group.scale.set(
      this.from.x + (1 - this.from.x) * k,
      this.from.y + (1 - this.from.y) * k,
      this.from.z + (1 - this.from.z) * k,
    );
    this.minorMaterial.opacity = this.majorMaterial.opacity = this.grid.value;
  }

  /**
   * The build volume is drawn only when the model does not fit, in the negative colour:
   * the one moment its edges carry information (otherwise they read as stray lines).
   */
  setFits(fits: boolean): void {
    this.volumeMaterial.color.setHex(fits ? VOLUME : VOLUME_OVER);
    this.volumeMaterial.opacity = 0.8;
    this.volumeMaterial.visible = !fits;
  }

  /** Radius of a sphere that frames the whole plate. */
  get radius(): number {
    const p = this.printer;
    return p ? 0.5 * Math.hypot(p.w, p.d) : 150;
  }
}
