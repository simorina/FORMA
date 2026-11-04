/** X, Y and Z dimension lines with their sizes in millimetres, around the model's bounds. */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mm } from '../lib/format';

export class Dimensions {
  readonly group = new THREE.Group();
  private lines: THREE.LineSegments;
  private labels: { el: HTMLDivElement; obj: CSS2DObject }[] = [];

  constructor() {
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x4a4238, transparent: true, opacity: 0.7, depthTest: false }),
    );
    this.lines.renderOrder = 5;
    this.group.add(this.lines);
    for (const axis of ['X', 'Y', 'Z']) {
      const el = document.createElement('div');
      el.className = 'dim-label';
      el.dataset.axis = axis;
      const obj = new CSS2DObject(el);
      this.labels.push({ el, obj });
      this.group.add(obj);
    }
    this.group.visible = false;
  }

  update(box: THREE.Box3 | null): void {
    if (!box || box.isEmpty()) {
      this.group.visible = false;
      return;
    }
    const { min: a, max: b } = box;
    const size = box.getSize(new THREE.Vector3());
    const o = Math.max(4, 0.07 * Math.max(size.x, size.y, size.z)); // offset from the model
    const t = o * 0.35; // tick half-length
    const y0 = a.y - o, x1 = b.x + o, y1 = b.y + o;
    const p: number[] = [
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
    ];
    this.lines.geometry.dispose();
    this.lines.geometry = new THREE.BufferGeometry();
    this.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    const [lx, ly, lz] = this.labels;
    lx.obj.position.set((a.x + b.x) / 2, y0 - t * 2.4, 0);
    ly.obj.position.set(x1 + t * 2.4, (a.y + b.y) / 2, 0);
    lz.obj.position.set(x1 + t * 1.2, y1, (a.z + b.z) / 2);
    lx.el.textContent = `${mm(size.x)} mm`;
    ly.el.textContent = `${mm(size.y)} mm`;
    lz.el.textContent = `${mm(size.z)} mm`;
    this.group.visible = true;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }
}
