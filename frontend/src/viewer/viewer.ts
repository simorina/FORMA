/**
 * The 3D viewport: studio lighting (PMREM room environment, ACES filmic tone mapping,
 * soft shadows), the printer's bed with a subtle reflection, dimension lines, a reveal that
 * builds the model up from the bed like a print, idle auto-rotate, fit-to-view with quick
 * views (front, side, top, 3/4) and a wireframe overlay that shows the triangles.
 *
 * World units are millimetres, Z up: exactly what the backend's mesh.glb preview contains,
 * so an edited mesh can be written back as STL without any conversion.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { computeNormals, weld } from '../edit/mesh';
import { Sculpt, type SculptState } from '../edit/sculpt';
import { writeSTL } from '../edit/stl';
import type { Printer } from '../lib/printers';
import { reducedMotion } from '../lib/dom';
import { Bed } from './bed';
import { Dimensions } from './dims';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export interface ViewerEvents {
  onSculpt?(state: SculptState): void;
  /** the model's size changed (after a sculpt stroke, undo or redo) */
  onShape?(size: [number, number, number]): void;
  /** WebGL could not start */
  onError?(message: string): void;
  /** the quick view the camera is in, or null once the user orbits away from it */
  onView?(view: View | null): void;
}

/** Quick views; "iso" is the 3/4 view the model is framed in when it loads. */
export type View = 'front' | 'side' | 'top' | 'iso';

/** Camera direction from the target, in degrees: azimuth from -Y towards +X, elevation. */
const VIEWS: Record<View, { az: number; el: number }> = {
  front: { az: 0, el: 4 },
  side: { az: 90, el: 4 },
  top: { az: 0, el: 89.9 }, // not exactly 90: OrbitControls needs a direction off the pole
  iso: { az: 32, el: 22 },
};

/** Camera moves orbit the target (direction slerped, distance lerped): no dip through the model. */
interface Tween {
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromDir: THREE.Vector3;
  turn: THREE.Quaternion;
  fromDist: number;
  toDist: number;
  start: number;
  duration: number;
}

const ONE = new THREE.Quaternion();

export class Viewer {
  readonly sculpt: Sculpt;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 1, 20000);
  private readonly controls: OrbitControls;
  private readonly bed = new Bed();
  private readonly dims = new Dimensions();
  private readonly key: THREE.DirectionalLight;
  private readonly material: THREE.MeshPhysicalMaterial;
  private readonly reflectionMaterial: THREE.MeshPhysicalMaterial;
  private readonly wireMaterial: THREE.MeshBasicMaterial;
  private readonly clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6);
  private readonly mirrorClip = new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6);
  private readonly fade = { value: 30 };
  // Overhang map: faces steeper than 45° below horizontal, not resting on the bed, are painted.
  // Section view: inner (back) faces seen through the cut are painted flat, so the wall reads
  // as a solid cut surface instead of a hollow skin.
  private readonly overhangU = {
    uOverhang: { value: 0 },
    uOverColor: { value: new THREE.Color(0xe5566f) },
    uSection: { value: 0 },
    uCutColor: { value: new THREE.Color(0x553311) },
  };
  private section: number | null = null;
  private mesh: THREE.Mesh | null = null;
  private reflection: THREE.Mesh | null = null;
  private wire: THREE.Mesh | null = null;
  private wireframe = false;
  private view: View = 'iso';
  private holdView = false; // a quick view was picked: no auto-rotate until the user moves
  private dirty = true;
  private raf = 0;
  private reveal: { start: number; height: number } | null = null;
  private tween: Tween | null = null;
  private lastInteraction = performance.now();
  private autoRotate = true;
  private editing = false;
  private loadToken = 0;
  private readonly resize: ResizeObserver;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: ViewerEvents = {},
  ) {
    // Transparent: the studio backdrop (an ivory sweep) is painted by CSS behind the canvas.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    // r186: PCF samples a Vogel disk scaled by shadow.radius (PCFSoftShadowMap was removed)
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'viewport-canvas';
    this.renderer.domElement.setAttribute('aria-label', 'Vista 3D del modello sul piatto di stampa');
    this.renderer.domElement.setAttribute('role', 'img');
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'viewport-labels';
    host.appendChild(this.labels.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    pmrem.dispose();

    // Studio lights: a soft key from the front left casting the shadow, a cool rim from behind,
    // and warm light bounced off the ivory floor.
    this.key = new THREE.DirectionalLight(0xfffaf2, 2.3);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.6;
    this.key.shadow.radius = 7;
    const rim = new THREE.DirectionalLight(0xdfe8ff, 0.9);
    rim.position.set(160, 260, 220);
    const fill = new THREE.HemisphereLight(0xfffaf3, 0x8a7a64, 0.45);
    fill.position.set(0, 0, 1);
    this.scene.add(this.key, this.key.target, rim, fill);

    this.material = new THREE.MeshPhysicalMaterial({
      color: 0xff7a1a,
      roughness: 0.42,
      metalness: 0,
      clearcoat: 0.3,
      clearcoatRoughness: 0.5,
      side: THREE.DoubleSide, // the reveal cuts the model open: show its inside, not a hole
      shadowSide: THREE.BackSide,
      clippingPlanes: [this.clip],
    });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.overhangU);
      shader.vertexShader = 'varying float vWorldZ;\n' + shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n vWorldZ = (modelMatrix * vec4(transformed, 1.0)).z;',
      );
      shader.fragmentShader =
        'uniform float uOverhang;\nuniform vec3 uOverColor;\nuniform float uSection;\nuniform vec3 uCutColor;\nvarying float vWorldZ;\n' +
        shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          if (uOverhang > 0.5) {
            vec3 worldN = inverseTransformDirection(normal, viewMatrix);
            // n.z < -sin(45°), softened over a few degrees; faces on the bed rest on it
            float over = (1.0 - smoothstep(-0.74, -0.67, worldN.z)) * step(0.4, vWorldZ);
            diffuseColor.rgb = mix(diffuseColor.rgb, uOverColor, over * 0.92);
          }`,
        ).replace(
          '#include <tonemapping_fragment>',
          `if (uSection > 0.5 && !gl_FrontFacing) gl_FragColor = vec4(uCutColor, 1.0);
          #include <tonemapping_fragment>`,
        );
    };
    this.material.customProgramCacheKey = () => 'forma-model';
    this.reflectionMaterial = this.material.clone();
    this.reflectionMaterial.transparent = true;
    this.reflectionMaterial.opacity = 0.42;
    this.reflectionMaterial.depthWrite = false;
    this.reflectionMaterial.clippingPlanes = [this.mirrorClip];
    this.reflectionMaterial.onBeforeCompile = (shader) => {
      // Fade the mirrored model out with depth below the bed.
      shader.uniforms.uFade = this.fade;
      shader.vertexShader = 'varying float vWorldZ;\n' + shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n vWorldZ = (modelMatrix * vec4(transformed, 1.0)).z;',
      );
      shader.fragmentShader = 'uniform float uFade;\nvarying float vWorldZ;\n' + shader.fragmentShader.replace(
        '#include <tonemapping_fragment>',
        'gl_FragColor.a *= smoothstep(-uFade, 0.0, vWorldZ);\n#include <tonemapping_fragment>',
      );
    };

    // The triangles over the surface: the solid is pushed back a little so the lines win.
    this.wireMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      wireframe: true,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      clippingPlanes: [this.clip],
    });

    this.scene.add(this.bed.group, this.dims.group);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(260, -420, 260);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03; // stay above the bed
    this.controls.minDistance = 15;
    this.controls.maxDistance = 3000;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.addEventListener('start', () => {
      this.holdView = false;
      this.touch();
      this.events.onView?.(null);
    });
    this.controls.addEventListener('change', () => (this.dirty = true));

    this.sculpt = new Sculpt({
      dom: this.renderer.domElement,
      camera: this.camera,
      controls: this.controls,
      scene: this.scene,
      requestRender: () => (this.dirty = true),
      onChange: (s) => this.events.onSculpt?.(s),
      onShapeChanged: () => this.shapeChanged(),
    });

    this.renderer.domElement.addEventListener('pointerdown', () => this.touch());
    this.renderer.domElement.addEventListener('wheel', () => this.touch(), { passive: true });

    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(host);
    this.onResize();
    this.loop();
  }

  // -- public API ------------------------------------------------------------------------
  setPrinter(p: Printer): void {
    this.bed.build(p);
    this.updateFit();
    if (!this.mesh) this.fit(false);
    this.dirty = true;
  }

  setFilament(hex: string): void {
    this.material.color.set(hex);
    this.reflectionMaterial.color.set(hex);
    // the overhang paint must stand out from the filament: blue on warm colours, red otherwise
    this.overhangU.uOverColor.value.set(this.overhangColor(hex));
    this.overhangU.uCutColor.value.set(hex).multiplyScalar(0.38);
    // dark lines on light filaments, light lines on dark ones
    const light = new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 }).l > 0.42;
    this.wireMaterial.color.set(light ? 0x000000 : 0xffffff);
    this.wireMaterial.opacity = light ? 0.34 : 0.22;
    this.sculpt.setCursorColor(light ? 0x17130f : 0xffffff);
    this.dirty = true;
  }

  /** The colour overhangs are painted in, for the legend. */
  overhangColor(hex = '#' + this.material.color.getHexString()): string {
    const hsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(hex).getHSL(hsl);
    const warm = hsl.s > 0.25 && (hsl.h < 0.14 || hsl.h > 0.88);
    return warm ? '#3d8bff' : '#ff4d5e';
  }

  setOverhang(on: boolean): void {
    this.overhangU.uOverhang.value = on ? 1 : 0;
    this.dirty = true;
  }

  /** Show the mesh triangles over the surface. */
  setWireframe(on: boolean): void {
    this.wireframe = on;
    if (this.wire) this.wire.visible = on;
    this.material.polygonOffset = on;
    this.material.polygonOffsetFactor = on ? 1 : 0;
    this.material.polygonOffsetUnits = on ? 1 : 0;
    this.dirty = true;
  }

  /** Look at the model (or the empty bed) from the front, the side, above or 3/4. */
  setView(view: View, animate = !reducedMotion()): void {
    this.view = view;
    this.holdView = view !== 'iso';
    this.touch();
    this.frame(animate);
    this.events.onView?.(view);
  }

  /** Cut the model horizontally at a fraction of its height, to look inside (null: whole). */
  setSection(frac: number | null): void {
    this.section = frac;
    this.overhangU.uSection.value = frac === null ? 0 : 1;
    this.applyClip();
  }

  private applyClip(): void {
    if (this.reveal) return; // the reveal drives the plane while it runs
    const h = this.size()?.[2] ?? 0;
    const c = this.section !== null && this.mesh ? Math.max(0.2, this.section * h) : 1e6;
    this.clip.constant = c;
    this.mirrorClip.constant = c;
    this.dirty = true;
  }

  get hasModel(): boolean {
    return this.mesh !== null;
  }

  /** Load the preview mesh (GLB, millimetres, Z up). Returns its size in mm. */
  async load(url: string, opts: { reveal?: boolean; keepView?: boolean } = {}): Promise<[number, number, number]> {
    const token = ++this.loadToken;
    const gltf = await new GLTFLoader().loadAsync(url);
    if (token !== this.loadToken) throw new Error('superseded');
    const parts: THREE.BufferGeometry[] = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) parts.push(m.geometry.clone().applyMatrix4(m.matrixWorld));
    });
    if (!parts.length) throw new Error('Il file non contiene una mesh');
    const flat: number[] = [];
    for (const g of parts) {
      const pos = g.getAttribute('position');
      const idx = g.getIndex();
      const count = idx ? idx.count : pos.count;
      for (let i = 0; i < count; i++) {
        const v = idx ? idx.getX(i) : i;
        flat.push(pos.getX(v), pos.getY(v), pos.getZ(v));
      }
      g.dispose();
    }
    const welded = weld(new Float32Array(flat), null);
    this.setGeometry(welded.positions, welded.index);
    const size = this.size()!;
    this.updateFit();
    if (!opts.keepView) this.fit(!reducedMotion());
    if (opts.reveal && !reducedMotion()) this.reveal = { start: performance.now(), height: size[2] };
    this.touch();
    return size;
  }

  clear(): void {
    this.loadToken++;
    this.sculpt.detach();
    this.disposeModel();
    this.dims.update(null);
    this.bed.setFits(true);
    this.fit(!reducedMotion());
  }

  /** Model size in mm (X, Y, Z), or null. */
  size(): [number, number, number] | null {
    const g = this.mesh?.geometry;
    if (!g) return null;
    if (!g.boundingBox) g.computeBoundingBox();
    const s = g.boundingBox!.getSize(new THREE.Vector3());
    return [s.x, s.y, s.z];
  }

  /** Frame the model (or the empty bed) in the 3/4 view. */
  fit(animate = true): void {
    this.view = 'iso';
    this.holdView = false;
    this.frame(animate);
    this.events.onView?.('iso');
  }

  private frame(animate: boolean): void {
    let center: THREE.Vector3, radius: number;
    if (this.mesh) {
      const box = this.mesh.geometry.boundingBox!;
      center = box.getCenter(new THREE.Vector3());
      radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 10);
      radius = Math.max(radius * 1.12, 25);
    } else {
      // the empty bed sits low in the frame, under the first-run headline
      radius = this.bed.radius * 1.04;
      center = new THREE.Vector3(0, 0, radius * 0.22);
    }
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = radius / Math.sin(Math.min(vfov, hfov) / 2);
    const v = VIEWS[this.view];
    const az = THREE.MathUtils.degToRad(v.az);
    const el = THREE.MathUtils.degToRad(this.view === 'iso' && !this.mesh ? 34 : v.el);
    const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), -Math.cos(el) * Math.cos(az), Math.sin(el));
    this.placeShadow(center, radius);
    if (!animate) {
      this.tween = null;
      this.camera.position.copy(center).addScaledVector(dir, dist);
      this.controls.target.copy(center);
      this.controls.update();
    } else {
      const offset = this.camera.position.clone().sub(this.controls.target);
      const fromDist = Math.max(offset.length(), 1e-3);
      const fromDir = offset.divideScalar(fromDist);
      this.tween = {
        fromTarget: this.controls.target.clone(),
        toTarget: center,
        fromDir,
        turn: new THREE.Quaternion().setFromUnitVectors(fromDir, dir),
        fromDist,
        toDist: dist,
        start: performance.now(),
        duration: 650,
      };
    }
    this.dirty = true;
  }

  setAutoRotate(on: boolean): void {
    this.autoRotate = on;
    this.touch();
  }

  setEdit(on: boolean): void {
    this.editing = on;
    this.sculpt.setEnabled(on && !!this.mesh);
    this.dirty = true;
  }

  /** The current (possibly sculpted) mesh as binary STL, millimetres, Z up. */
  exportSTL(): ArrayBuffer | null {
    const g = this.mesh?.geometry;
    if (!g) return null;
    return writeSTL(g.getAttribute('position').array as Float32Array, g.getIndex()!.array as Uint32Array);
  }

  /** A PNG of the current view (for the share sheet and screenshots). */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.controls.dispose();
    this.disposeModel();
    this.material.dispose();
    this.reflectionMaterial.dispose();
    this.wireMaterial.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  // -- internals -------------------------------------------------------------------------
  private setGeometry(positions: Float32Array, index: Uint32Array): void {
    this.sculpt.detach();
    this.disposeModel();
    const g = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
    const nor = new THREE.BufferAttribute(computeNormals(positions, index), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pos);
    g.setAttribute('normal', nor);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    g.computeBoundsTree();

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.reflection = new THREE.Mesh(g, this.reflectionMaterial);
    this.reflection.scale.z = -1; // mirrored in the bed plane (the model rests on Z = 0)
    this.reflection.renderOrder = 0;
    this.wire = new THREE.Mesh(g, this.wireMaterial);
    this.wire.visible = this.wireframe;
    this.wire.raycast = () => {}; // the sculpt brush and picking only see the solid
    this.scene.add(this.reflection, this.mesh, this.wire);
    this.sculpt.attach(this.mesh);
    this.sculpt.setEnabled(this.editing);
    const size = this.size()!;
    this.fade.value = Math.max(8, size[2] * 0.35);
    this.dims.update(g.boundingBox);
  }

  private disposeModel(): void {
    if (!this.mesh) return;
    const g = this.mesh.geometry as THREE.BufferGeometry & { disposeBoundsTree?: () => void };
    this.scene.remove(this.mesh);
    if (this.reflection) this.scene.remove(this.reflection);
    if (this.wire) this.scene.remove(this.wire);
    g.disposeBoundsTree?.();
    g.dispose();
    this.mesh = this.reflection = this.wire = null;
    this.reveal = null;
    this.section = null;
    this.clip.constant = this.mirrorClip.constant = 1e6;
  }

  private shapeChanged(): void {
    const g = this.mesh?.geometry;
    if (!g) return;
    g.computeBoundingBox();
    this.dims.update(g.boundingBox);
    this.updateFit();
    const s = this.size();
    if (s) this.events.onShape?.(s);
    this.dirty = true;
  }

  private fits: ((size: [number, number, number]) => boolean) | null = null;

  /** The app tells the viewer how to judge the fit (it owns the printer list and rules). */
  setFitTest(test: (size: [number, number, number]) => boolean): void {
    this.fits = test;
    this.updateFit();
  }

  private updateFit(): void {
    const s = this.size();
    this.bed.setFits(!s || !this.fits || this.fits(s));
    this.dirty = true;
  }

  /** Keep the shadow camera tight around what is on the bed. */
  private placeShadow(center: THREE.Vector3, radius: number): void {
    const r = Math.max(radius, this.mesh ? radius : this.bed.radius) * 1.25;
    this.key.position.set(center.x - r * 0.9, center.y - r * 1.3, center.z + r * 2.1);
    this.key.target.position.copy(center);
    const cam = this.key.shadow.camera;
    cam.left = cam.bottom = -r;
    cam.right = cam.top = r;
    cam.near = 1;
    cam.far = r * 6;
    cam.updateProjectionMatrix();
  }

  private touch(): void {
    this.lastInteraction = performance.now();
    this.controls.autoRotate = false;
  }

  private onResize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const idle = now - this.lastInteraction > 4000;
    this.controls.autoRotate =
      this.autoRotate && idle && !this.holdView && !!this.mesh && !this.editing && !this.reveal && !this.tween && !reducedMotion();

    if (this.tween) {
      const t = Math.min(1, (now - this.tween.start) / this.tween.duration);
      const e = easeInOut(t);
      const tw = this.tween;
      const dir = tw.fromDir.clone().applyQuaternion(ONE.clone().slerp(tw.turn, e));
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
      this.camera.position.copy(this.controls.target).addScaledVector(dir, THREE.MathUtils.lerp(tw.fromDist, tw.toDist, e));
      if (t >= 1) this.tween = null;
      this.dirty = true;
    }
    if (this.reveal) {
      const t = Math.min(1, (now - this.reveal.start) / 1500);
      const h = easeOut(t) * (this.reveal.height + 0.5);
      this.clip.constant = h; // keeps z <= h: the model rises from the bed layer by layer
      this.mirrorClip.constant = h;
      if (t >= 1) {
        this.reveal = null;
        this.applyClip();
      }
      this.dirty = true;
    }
    if (this.controls.update()) this.dirty = true;
    if (this.controls.autoRotate) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };
}

/** True when WebGL2 is available (the viewport needs it). */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}
