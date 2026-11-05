/**
 * The 3D viewport: studio lighting (PMREM room environment, ACES filmic tone mapping,
 * soft shadows), the printer's bed with a subtle reflection, dimension lines, a reveal that
 * builds the model up from the bed like a print, idle auto-rotate, fit-to-view with quick
 * views (front, side, top, 3/4) and a wireframe overlay that shows the triangles.
 *
 * World units are millimetres, Z up: exactly what the backend's mesh.glb preview contains,
 * so an edited mesh can be written back as STL without any conversion.
 *
 * Motion (the house's vocabulary, lib/motion.ts, in three.js terms: anim.ts): a new model is
 * printed up from the bed under a glowing print head; another one rises quicker; the colour of
 * the filament dissolves, the overhang map and the wireframe fade, the section glides to its
 * height, the camera moves with a little dolly breath, the bed resizes, the dimension lines draw
 * in. Every change is instant under prefers-reduced-motion, and nothing renders while idle:
 * the loop draws a frame only when something moved.
 */
import '../styles/viewer.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { computeNormals, mergeParts, weld, weldAttribute } from '../edit/mesh';
import { Sculpt, type SculptState } from '../edit/sculpt';
import { writeSTL } from '../edit/stl';
import type { Printer } from '../lib/printers';
import { reducedMotion } from '../lib/dom';
import { DUR } from '../lib/motion';
import { Glide, breath, easeInOut, easeOut, easeSteady, type Ease } from './anim';
import { Bed } from './bed';
import { Dimensions } from './dims';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

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

// -- timings (ms), on top of lib/motion.ts DUR ----------------------------------------------
/** A quick view or a fit: deliberate, between DUR.slow and DUR.hero. */
const VIEW_MS = 760;
/** A new model printed up from the bed. */
const PRINT_MS = 1600;
/** Another model (history, new settings) rises quicker, with a fainter print head. */
const RISE_MS = DUR.slow;
/** The idle turntable comes up to speed instead of starting at full speed. */
const ROTATE_SPEED = 0.55;
const ROTATE_RAMP = 1400;

/** The print head's glow: a lifted, warm gold (the gold of the interface, lit). */
const HEAD_GOLD = new THREE.Color(0xffc46a);
/** Radians per ms the nozzle goes round the layer (about 1.4 turns a second). */
const HEAD_SPIN = 0.0088;

/** Camera moves orbit the target (direction slerped, distance eased with a breath). */
interface Tween {
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromDir: THREE.Vector3;
  turn: THREE.Quaternion;
  fromDist: number;
  toDist: number;
  start: number;
  duration: number;
  /** how far the dolly breathes out, as a share of the distance */
  depth: number;
}

/** A model rising from the bed: the clip plane goes up to its top. */
interface Reveal {
  start: number;
  height: number;
  duration: number;
  ease: Ease;
  /** how hot the print head glows, 0..1 */
  glow: number;
}

/** What the filament colour drives, cross-dissolved together when it changes. */
interface Palette {
  color: THREE.Color;
  over: THREE.Color;
  cut: THREE.Color;
  wire: THREE.Color;
  wireAlpha: number;
}
const palette = (): Palette => ({ color: new THREE.Color(), over: new THREE.Color(), cut: new THREE.Color(), wire: new THREE.Color(), wireAlpha: 0.34 });

const ONE = new THREE.Quaternion();
const NO_CUT = 1e6;

// -- shader patches ----------------------------------------------------------------------------
// The print head, shared by the model and its reflection (mirrored: HEAD_POS and HEAD_EYE are
// the fragment and the camera in the model's own, unmirrored space).
const HEAD_PARS = `
uniform float uHead;      // brightness of the print head, 0 = off
uniform float uHeadZ;     // height of the layer being laid: the cut, mm
uniform vec3 uHeadColor;  // its glow
uniform vec3 uHeadCap;    // the fresh layer, seen through the cut
uniform float uHeadSpin;  // where the nozzle is round the layer, radians
uniform vec2 uHeadCenter; // the model's centre on the bed
uniform float uHeadBand;  // how far below the layer the plastic is still warm, mm
uniform float uHeadHatch; // infill spacing on the fresh layer, mm
uniform float uHeadGlow;  // how hot it glows: 1 for a new print, less for a model rising again
varying vec3 vWorldPos;
`;
const HEAD_EMISSIVE = `
  float headInfill = 0.0;
  float headLine = 0.0;
  if (uHead > 0.0) {
    // derivatives first, outside any per-fragment branch
    float below = max(uHeadZ - HEAD_POS.z, 0.0);
    float px = below / max(fwidth(HEAD_POS.z), 1e-4); // pixels under the layer
    // where the eye ray through this pixel meets the layer: the infill lanes are drawn there,
    // so the inside seen through the cut reads as a flat, solid slice
    vec3 ray = HEAD_POS - HEAD_EYE;
    vec2 onLayer = HEAD_EYE.xy + ray.xy * ((uHeadZ - HEAD_EYE.z) / min(ray.z, -1e-3));
    float lane = (onLayer.x + onLayer.y) * 0.70710678 / uHeadHatch;
    float laneW = fwidth(lane);
    headInfill = (1.0 - smoothstep(0.3, 1.1, abs(fract(lane + 0.5) - 0.5) / max(laneW, 1e-4)))
      * (1.0 - smoothstep(0.12, 0.3, laneW)); // too fine to draw when far away
    // the perimeter being laid, all round the cut: on the outer wall in front, on the inner wall
    // seen through the cut behind; brightest where the nozzle has just passed. A few pixels
    // wide whatever the zoom, never more than a few mm (faces seen edge-on).
    float near = 1.0 - smoothstep(1.5, 3.0, below);
    vec2 r = HEAD_POS.xy - uHeadCenter;
    float behind = mod(uHeadSpin - atan(r.y, r.x + 1e-6), 6.2831853);
    float trail = exp(-1.1 * behind);
    headLine = (1.0 - smoothstep(0.9, 2.6, px)) * near * (0.55 + 1.45 * trail) * uHeadGlow;
    if (gl_FrontFacing) {
      // its glow on the wall under it, and the warmth of the fresh plastic fading below
      float halo = exp(-px / 5.0) * near;
      float warm = exp(-below / uHeadBand);
      totalEmissiveRadiance += uHeadColor * uHead * (1.5 * headLine + uHeadGlow * (0.4 * halo + 0.16 * warm));
    }
  }
`;
const HEAD_CAP = `
  if (uHead > 0.0 && !gl_FrontFacing) {
    vec3 headCap = uHeadCap * (1.0 + 0.28 * uHeadGlow * headInfill) + uHeadColor * (1.3 * headLine);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, headCap, uHead);
  }
`;
const WORLD_POS_VERTEX = '#include <project_vertex>\n vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;';

const WHITE = new THREE.Color(0xffffff);
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
// parts without colour inside a coloured model: the backend's neutral grey (160 / 255)
const NEUTRAL_LINEAR = srgbToLinear(160 / 255);

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
  private readonly clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), NO_CUT);
  private readonly mirrorClip = new THREE.Plane(new THREE.Vector3(0, 0, 1), NO_CUT);
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
  // The print head of the reveal (see HEAD_PARS).
  private readonly headU = {
    uHead: { value: 0 },
    uHeadZ: { value: 0 },
    uHeadColor: { value: HEAD_GOLD.clone() },
    uHeadCap: { value: new THREE.Color() },
    uHeadSpin: { value: 0 },
    uHeadCenter: { value: new THREE.Vector2() },
    uHeadBand: { value: 3 },
    uHeadHatch: { value: 2.5 },
    uHeadGlow: { value: 1 },
  };
  private section: number | null = null;
  private mesh: THREE.Mesh | null = null;
  private reflection: THREE.Mesh | null = null;
  private wire: THREE.Mesh | null = null;
  private view: View = 'iso';
  private holdView = false; // a quick view was picked: no auto-rotate until the user moves
  private dirty = true;
  private castVersion = -1; // version of the model's positions the shadow map was drawn with
  private raf = 0;
  private reveal: Reveal | null = null;
  private tween: Tween | null = null;
  private readonly tweenState: Tween = {
    fromTarget: new THREE.Vector3(), toTarget: new THREE.Vector3(), fromDir: new THREE.Vector3(),
    turn: new THREE.Quaternion(), fromDist: 1, toDist: 1, start: 0, duration: VIEW_MS, depth: 0,
  };
  private lastInteraction = performance.now();
  private autoRotate = true;
  private rotateSince = 0;
  private editing = false;
  private loadToken = 0;
  private filament: string | null = null;
  // the model's own colours (an AI model's texture): the surface shows them under white light;
  // the filament keeps colouring the overhang paint, the section, the wire and the print head
  private hasColors = false;
  private readonly filamentColor = new THREE.Color(0xff7a1a); // at the dissolve's point
  // what moves: each one is stepped by the loop and asks for frames only while it runs
  private readonly tint = new Glide(1); // 0 → 1: from paletteFrom to paletteTo
  private readonly paletteFrom = palette();
  private readonly paletteTo = palette();
  private wireAlpha = 0.34; // the wire's opacity for this filament, before its fade
  private readonly wireFade = new Glide(0);
  private readonly overhangFade = new Glide(0);
  private readonly cut = new Glide(NO_CUT); // the section's height, mm (NO_CUT: whole)
  private readonly headFade = new Glide(0);
  private readonly motionQuery: MediaQueryList;
  private calm: boolean; // prefers-reduced-motion, kept current without asking every frame
  private readonly onMotionPref = () => (this.calm = this.motionQuery.matches);
  private readonly resize: ResizeObserver;
  // scratch objects for the loop (it allocates nothing)
  private readonly qTmp = new THREE.Quaternion();
  private readonly vTmp = new THREE.Vector3();

  constructor(
    private readonly host: HTMLElement,
    private readonly events: ViewerEvents = {},
  ) {
    this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
    this.calm = reducedMotion();
    this.motionQuery.addEventListener('change', this.onMotionPref);

    // Transparent: the studio backdrop (an ivory sweep) is painted by CSS behind the canvas.
    // a stencil: the model marks its pixels, so the bed's grid never draws over its base (see Bed)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    // r186: PCF samples a Vogel disk scaled by shadow.radius (PCFSoftShadowMap was removed)
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Only the model casts a shadow (unclipped: clipShadows is off) and the key light moves only
    // when the view is framed, so the shadow map is redrawn when one of them changes (see draw),
    // not on every frame of an orbit or the auto-rotate. The reveal is the exception: the shadow
    // grows with the print (clipShadows on while it runs).
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
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
      // its pixels are marked: the grid lines, 0.05 mm above the plate, skip them, so the base
      // (on the plate, seen through the cut of the print or the section) is not ruled over
      stencilWrite: true,
      stencilRef: 1,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.overhangU, this.headU);
      shader.vertexShader = 'varying vec3 vWorldPos;\n' + shader.vertexShader.replace('#include <project_vertex>', WORLD_POS_VERTEX);
      shader.fragmentShader =
        'uniform float uOverhang;\nuniform vec3 uOverColor;\nuniform float uSection;\nuniform vec3 uCutColor;\n' + HEAD_PARS +
        '#define HEAD_POS vWorldPos\n#define HEAD_EYE cameraPosition\n' +
        shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          if (uOverhang > 0.0) {
            vec3 worldN = inverseTransformDirection(normal, viewMatrix);
            // n.z < -sin(45°), softened over a few degrees; faces on the bed rest on it
            float over = (1.0 - smoothstep(-0.74, -0.67, worldN.z)) * step(0.4, vWorldPos.z);
            diffuseColor.rgb = mix(diffuseColor.rgb, uOverColor, over * 0.92 * uOverhang);
          }`,
        ).replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n' + HEAD_EMISSIVE,
        ).replace(
          '#include <tonemapping_fragment>',
          `if (uSection > 0.5 && !gl_FrontFacing) gl_FragColor = vec4(uCutColor, 1.0);
          ${HEAD_CAP}
          #include <tonemapping_fragment>`,
        );
    };
    this.material.customProgramCacheKey = () => 'forma-model';
    this.reflectionMaterial = this.material.clone();
    this.reflectionMaterial.transparent = true;
    this.reflectionMaterial.opacity = 0.42;
    this.reflectionMaterial.depthWrite = false;
    this.reflectionMaterial.stencilWrite = false; // under the plate: the grid shows over it
    this.reflectionMaterial.clippingPlanes = [this.mirrorClip];
    this.reflectionMaterial.onBeforeCompile = (shader) => {
      // Fade the mirrored model out with depth below the bed; the section cap and the print
      // head show in it too, mirrored.
      Object.assign(shader.uniforms, { uFade: this.fade, uSection: this.overhangU.uSection, uCutColor: this.overhangU.uCutColor }, this.headU);
      shader.vertexShader = 'varying vec3 vWorldPos;\n' + shader.vertexShader.replace('#include <project_vertex>', WORLD_POS_VERTEX);
      shader.fragmentShader =
        'uniform float uFade;\nuniform float uSection;\nuniform vec3 uCutColor;\n' + HEAD_PARS +
        '#define HEAD_POS vec3(vWorldPos.xy, -vWorldPos.z)\n#define HEAD_EYE vec3(cameraPosition.xy, -cameraPosition.z)\n' +
        shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n' + HEAD_EMISSIVE,
        ).replace(
          '#include <tonemapping_fragment>',
          `if (uSection > 0.5 && !gl_FrontFacing) gl_FragColor.rgb = uCutColor;
          ${HEAD_CAP}
          gl_FragColor.a *= smoothstep(-uFade, 0.0, vWorldPos.z);
          #include <tonemapping_fragment>`,
        );
    };
    this.reflectionMaterial.customProgramCacheKey = () => 'forma-reflection';

    // The triangles over the surface: the solid is pushed back a little so the lines win.
    this.wireMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      wireframe: true,
      transparent: true,
      opacity: 0,
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
    this.controls.autoRotateSpeed = ROTATE_SPEED;
    this.controls.addEventListener('start', () => {
      this.holdView = false;
      this.tween = null; // the hand takes over from wherever a camera move has got to
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
    // a restored context comes back with an empty shadow map
    this.renderer.domElement.addEventListener('webglcontextrestored', () => this.shadowsChanged());

    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(host);
    this.onResize();
    this.loop();
  }

  // -- public API ------------------------------------------------------------------------
  setPrinter(p: Printer): void {
    // the plate resizes from the one shown (not on the first one, nor under reduced motion)
    const animate = !!this.bed.printer && !this.still();
    this.bed.build(p, animate, performance.now());
    this.updateFit();
    if (!this.mesh) this.fit(animate);
    this.dirty = true;
  }

  setFilament(hex: string): void {
    const first = this.filament === null;
    this.filament = hex;
    const to = this.paletteTo;
    to.color.set(hex);
    // the overhang paint must stand out from the filament: blue on warm colours, red otherwise
    to.over.set(this.overhangColor(hex));
    to.cut.set(hex).multiplyScalar(0.38);
    // dark lines on light filaments, light lines on dark ones
    const light = to.color.getHSL({ h: 0, s: 0, l: 0 }).l > 0.42;
    to.wire.set(light ? 0x000000 : 0xffffff);
    to.wireAlpha = light ? 0.34 : 0.22;
    this.sculpt.setCursorColor(light ? 0x17130f : 0xffffff);
    // cross-dissolve from the colours on screen now (a dissolve may be under way)
    const from = this.paletteFrom;
    from.color.copy(this.filamentColor);
    from.over.copy(this.overhangU.uOverColor.value);
    from.cut.copy(this.overhangU.uCutColor.value);
    from.wire.copy(this.wireMaterial.color);
    from.wireAlpha = this.wireAlpha;
    this.tint.jump(0);
    this.tint.to(1, performance.now(), first || this.still() ? 0 : DUR.base, easeInOut);
    this.applyPalette();
    this.dirty = true;
  }

  /** The colour overhangs are painted in, for the legend (of the filament, not of a dissolve). */
  overhangColor(hex = this.filament ?? '#' + this.filamentColor.getHexString()): string {
    const hsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(hex).getHSL(hsl);
    const warm = hsl.s > 0.25 && (hsl.h < 0.14 || hsl.h > 0.88);
    return warm ? '#3d8bff' : '#ff4d5e';
  }

  setOverhang(on: boolean): void {
    this.overhangFade.to(on ? 1 : 0, performance.now(), this.still() ? 0 : 300, easeInOut);
    this.overhangU.uOverhang.value = this.overhangFade.value;
    this.dirty = true;
  }

  /** Show the mesh triangles over the surface. */
  setWireframe(on: boolean): void {
    // short: the lines must be there at once, they only arrive softly
    this.wireFade.to(on ? 1 : 0, performance.now(), this.still() ? 0 : DUR.short, easeOut);
    this.applyWire();
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
    const toggled = (this.section === null) !== (frac === null);
    this.section = frac;
    // on and off glide in and out over the model; the slider is followed closely
    this.applyClip(toggled ? 'toggle' : 'follow');
  }

  /** Move the cut to the section's height (or out of the model), gliding unless `how` is 'jump'. */
  private applyClip(how: 'jump' | 'toggle' | 'follow' = 'jump'): void {
    if (this.reveal) return; // the reveal drives the plane while it runs
    const h = this.size()?.[2];
    if (h === undefined) {
      this.cut.jump(NO_CUT);
    } else {
      const top = h + 0.5; // just above the model: no cut, but a place to glide from and to
      if (this.cut.value >= NO_CUT) this.cut.jump(top);
      const goal = this.section !== null ? Math.max(0.2, this.section * h) : top;
      const ms = how === 'jump' || this.still() ? 0 : how === 'toggle' ? DUR.slow : DUR.short;
      this.cut.to(goal, performance.now(), ms, how === 'follow' ? easeOut : easeInOut);
    }
    this.syncClip();
  }

  /** The clip planes and the cap follow the section's glide; settled out of the model, no cut. */
  private syncClip(): void {
    const open = this.section === null && !this.cut.moving;
    if (open && this.cut.value < NO_CUT) this.cut.jump(NO_CUT);
    this.clip.constant = this.mirrorClip.constant = this.cut.value;
    this.overhangU.uSection.value = open ? 0 : 1; // the cap shows while a cut is on or moving
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
    // typed arrays all the way: a full-resolution model has millions of triangles
    const merged = mergeParts(parts.map((g) => {
      const pos = g.getAttribute('position');
      const positions = new Float32Array(pos.count * 3);
      for (let v = 0; v < pos.count; v++) {
        positions[3 * v] = pos.getX(v);
        positions[3 * v + 1] = pos.getY(v);
        positions[3 * v + 2] = pos.getZ(v);
      }
      const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
      let colors: Float32Array | null = null;
      if (col) {
        // the backend writes sRGB bytes (as trimesh reads them); the shader works in linear
        colors = new Float32Array(col.count * 3);
        for (let v = 0; v < col.count; v++) {
          colors[3 * v] = srgbToLinear(col.getX(v));
          colors[3 * v + 1] = srgbToLinear(col.getY(v));
          colors[3 * v + 2] = srgbToLinear(col.getZ(v));
        }
      }
      const idx = g.getIndex();
      const index = idx ? Uint32Array.from(idx.array as ArrayLike<number>) : null;
      g.dispose();
      return { positions, index, colors };
    }), NEUTRAL_LINEAR);
    const welded = weld(merged.positions, merged.index);
    const colors = merged.colors
      ? weldAttribute(merged.colors, welded.remap, 3, welded.positions.length / 3)
      : null;
    this.setGeometry(welded.positions, welded.index, colors);
    const size = this.size()!;
    this.updateFit();
    const still = this.still();
    if (!opts.keepView) this.fit(!still);
    const now = performance.now();
    // a new model is printed up from the bed; another one (the history, new settings) rises
    // quicker under a fainter head; the same one coming back (repaired edits) is just there
    if (!still && opts.reveal) this.startReveal(now, size[2], PRINT_MS, easeSteady, 1);
    else if (!still && !opts.keepView) this.startReveal(now, size[2], RISE_MS, easeInOut, 0.4);
    else this.dims.enter(now, false);
    this.touch();
    return size;
  }

  clear(): void {
    this.loadToken++;
    this.sculpt.detach();
    this.disposeModel();
    this.dims.update(null);
    this.bed.setFits(true);
    this.fit(!this.still());
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
    if (!animate || this.still()) {
      this.tween = null;
      this.camera.position.copy(center).addScaledVector(dir, dist);
      this.controls.target.copy(center);
      this.controls.update();
    } else {
      const tw = this.tweenState;
      const offset = this.vTmp.copy(this.camera.position).sub(this.controls.target);
      tw.fromDist = Math.max(offset.length(), 1e-3);
      tw.fromDir.copy(offset).divideScalar(tw.fromDist);
      tw.fromTarget.copy(this.controls.target);
      tw.toTarget.copy(center);
      tw.turn.setFromUnitVectors(tw.fromDir, dir);
      tw.toDist = dist;
      tw.start = performance.now();
      tw.duration = VIEW_MS;
      // the dolly breathes deeper on a long swing; a fit where the camera already is just breathes
      const angle = 2 * Math.acos(Math.min(1, Math.abs(tw.turn.w)));
      tw.depth = 0.02 + 0.025 * Math.min(1, angle / (Math.PI / 2));
      this.tween = tw;
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
    this.draw();
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.motionQuery.removeEventListener('change', this.onMotionPref);
    this.controls.dispose();
    this.disposeModel();
    this.material.dispose();
    this.reflectionMaterial.dispose();
    this.wireMaterial.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  // -- internals -------------------------------------------------------------------------
  /** Under prefers-reduced-motion every change is instant. */
  private still(): boolean {
    this.calm = reducedMotion();
    return this.calm;
  }

  private setGeometry(positions: Float32Array, index: Uint32Array, colors: Float32Array | null): void {
    this.sculpt.detach();
    this.disposeModel();
    const g = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
    const nor = new THREE.BufferAttribute(computeNormals(positions, index), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pos);
    g.setAttribute('normal', nor);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    // the sculpt brushes move positions only: the colours stay with their vertices
    if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    if (this.hasColors !== !!colors) {
      this.hasColors = !!colors;
      this.material.vertexColors = this.reflectionMaterial.vertexColors = this.hasColors;
      this.material.needsUpdate = this.reflectionMaterial.needsUpdate = true;
      this.applyPalette();
    }
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
    this.wire.raycast = () => {}; // the sculpt brush and picking only see the solid
    this.scene.add(this.reflection, this.mesh, this.wire);
    this.applyWire();
    this.sculpt.attach(this.mesh);
    this.sculpt.setEnabled(this.editing);
    const size = this.size()!;
    this.fade.value = Math.max(8, size[2] * 0.35);
    this.dims.update(g.boundingBox, true); // shown by load(), once the model is on the bed
    this.shadowsChanged();
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
    this.endReveal();
    this.headFade.jump(0);
    this.headU.uHead.value = 0;
    this.section = null;
    this.cut.jump(NO_CUT);
    this.syncClip();
    this.shadowsChanged(); // its shadow goes with it
  }

  /** The model rises from the bed: the clip plane goes up to its top, the print head glowing. */
  private startReveal(now: number, height: number, duration: number, ease: Ease, glow: number): void {
    const box = this.mesh!.geometry.boundingBox!;
    this.reveal = { start: now, height, duration, ease, glow };
    this.headU.uHeadGlow.value = glow;
    this.headU.uHeadCenter.value.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2);
    this.headU.uHeadBand.value = Math.max(1.5, height * 0.03);
    this.headU.uHeadHatch.value = THREE.MathUtils.clamp(Math.max(box.max.x - box.min.x, box.max.y - box.min.y) / 26, 1, 3.5);
    this.headFade.jump(0);
    this.headFade.to(1, now, DUR.micro, easeOut);
    this.material.clipShadows = true; // the shadow grows with the print
    this.stepReveal(now);
  }

  private stepReveal(now: number): void {
    const r = this.reveal!;
    const t = Math.min(1, (now - r.start) / r.duration);
    const z = r.ease(t) * (r.height + 0.5);
    this.clip.constant = this.mirrorClip.constant = z; // keeps z <= h: the model rises layer by layer
    this.headU.uHeadZ.value = z;
    this.headU.uHeadSpin.value = (now - r.start) * HEAD_SPIN;
    // the fresh layer: the filament lifted and warmed by the head's gold (a model rising again:
    // a plain cut, a little darker than its lit surface)
    const cap = this.headU.uHeadCap.value, c = this.filamentColor, g = r.glow;
    cap.setRGB(
      c.r * (0.62 + 0.28 * g) + HEAD_GOLD.r * 0.32 * g,
      c.g * (0.62 + 0.28 * g) + HEAD_GOLD.g * 0.32 * g,
      c.b * (0.62 + 0.28 * g) + HEAD_GOLD.b * 0.32 * g,
    );
    this.renderer.shadowMap.needsUpdate = true;
    if (t >= 1) {
      this.endReveal();
      this.headFade.to(0, now, DUR.base, easeOut); // the last layer cools
      this.applyClip('toggle'); // a section asked for meanwhile glides in now
      this.dims.enter(now, true);
    }
  }

  private endReveal(): void {
    if (!this.reveal) return;
    this.reveal = null;
    this.material.clipShadows = false;
    this.shadowsChanged(); // the whole model's shadow again
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
    this.shadowsChanged();
  }

  /** The key light or the model that casts the shadow changed: redraw the shadow map. */
  private shadowsChanged(): void {
    this.renderer.shadowMap.needsUpdate = true;
    this.dirty = true;
  }

  /** The filament's colours at the dissolve's point (model, reflection, overhang paint, cap, wire). */
  private applyPalette(): void {
    const k = this.tint.value, a = this.paletteFrom, b = this.paletteTo;
    this.filamentColor.lerpColors(a.color, b.color, k);
    // a coloured model: white, so its vertex colours show as they are
    this.material.color.copy(this.hasColors ? WHITE : this.filamentColor);
    this.reflectionMaterial.color.copy(this.material.color);
    this.overhangU.uOverColor.value.lerpColors(a.over, b.over, k);
    this.overhangU.uCutColor.value.lerpColors(a.cut, b.cut, k);
    this.wireMaterial.color.lerpColors(a.wire, b.wire, k);
    this.wireAlpha = a.wireAlpha + (b.wireAlpha - a.wireAlpha) * k;
    this.applyWire();
  }

  /** The wireframe at its fade: drawn (and the solid pushed back under it) while it shows at all. */
  private applyWire(): void {
    const f = this.wireFade.value;
    const on = f > 0;
    if (this.wire) this.wire.visible = on;
    if (this.material.polygonOffset !== on) {
      this.material.polygonOffset = on;
      this.material.polygonOffsetFactor = on ? 1 : 0;
      this.material.polygonOffsetUnits = on ? 1 : 0;
    }
    this.wireMaterial.opacity = this.wireAlpha * f;
  }

  /** Render a frame; a sculpt stroke, undo or redo moves the model's vertices and its shadow. */
  private draw(): void {
    const pos = this.mesh?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (pos && pos.version !== this.castVersion) {
      this.castVersion = pos.version;
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.renderer.render(this.scene, this.camera);
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

  /** The camera move: the direction slerped, the target eased, the distance with its breath. */
  private stepTween(now: number): void {
    const tw = this.tween!;
    const t = Math.min(1, (now - tw.start) / tw.duration);
    const e = easeInOut(t);
    const dir = this.vTmp.copy(tw.fromDir).applyQuaternion(this.qTmp.copy(ONE).slerp(tw.turn, e));
    const dist = THREE.MathUtils.lerp(tw.fromDist, tw.toDist, e) * breath(t, tw.depth);
    this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    if (t >= 1) this.tween = null;
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const idle = now - this.lastInteraction > 4000;
    const rotate =
      this.autoRotate && idle && !this.holdView && !!this.mesh && !this.editing && !this.reveal && !this.tween && !this.calm;
    if (rotate && !this.controls.autoRotate) this.rotateSince = now;
    this.controls.autoRotate = rotate;
    // the turntable comes up to speed (OrbitControls' damping softens its stop)
    if (rotate) this.controls.autoRotateSpeed = ROTATE_SPEED * easeInOut(Math.min(1, (now - this.rotateSince) / ROTATE_RAMP));

    let moved = false;
    if (this.tween) {
      this.stepTween(now);
      moved = true;
    }
    if (this.reveal) {
      this.stepReveal(now);
      moved = true;
    }
    if (this.tint.step(now)) {
      this.applyPalette();
      moved = true;
    }
    if (this.wireFade.step(now)) {
      this.applyWire();
      moved = true;
    }
    if (this.overhangFade.step(now)) {
      this.overhangU.uOverhang.value = this.overhangFade.value;
      moved = true;
    }
    if (this.headFade.step(now)) {
      this.headU.uHead.value = this.headFade.value;
      moved = true;
    }
    if (this.cut.step(now)) {
      if (!this.reveal) this.syncClip();
      moved = true;
    }
    if (this.bed.tick(now)) moved = true;
    if (this.dims.tick(now)) moved = true;
    if (this.sculpt.tick(now)) moved = true;
    if (moved) this.dirty = true;
    if (this.controls.update()) this.dirty = true;
    if (this.controls.autoRotate) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
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
