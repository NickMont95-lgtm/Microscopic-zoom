import * as THREE from 'three';
import { Rail, type RailKey } from '../core/rail.ts';
import type { BandDef, BandFrame, QualitySettings } from '../core/types.ts';

/**
 * Shared scaffolding for every real band.
 *
 * Three things here are load-bearing for the whole project:
 *
 * 1. `realToLocal` — bands are authored in local units, but the things in them
 *    have real sizes. This converts one to the other using the frame's own
 *    numbers, so an object can be placed at its true physical size without the
 *    band ever knowing what scale it is being viewed at. It also works across
 *    the dolly-window wraps in bands 11-13.
 *
 * 2. Scale-invariant lighting. Point lights with physical falloff are parented
 *    to the camera and re-positioned every frame in proportion to the focus
 *    distance, with intensity scaled by distance squared. The result is that a
 *    proton is lit exactly like a face.
 *
 * 3. `makeRail` pins the first and last stretch of every rail to a straight
 *    axial approach. That is what keeps band hand-offs invisible: during an
 *    overlap both bands are flying straight at their respective feature along
 *    the same axis, so their images track each other exactly.
 */

// ---------------------------------------------------------------------------
// Scale conversion
// ---------------------------------------------------------------------------

/** Metres per local unit, right now. Constant within a dolly window. */
export function metresPerUnit(frame: BandFrame): number {
  return frame.metresVisible / frame.localWidth;
}

/** Converts a real-world length in metres into this frame's local units. */
export function realToLocal(frame: BandFrame, metres: number): number {
  return metres / metresPerUnit(frame);
}

// ---------------------------------------------------------------------------
// Atmosphere
// ---------------------------------------------------------------------------

interface AtmoKey {
  log: number;
  color: number;
}

/**
 * Backdrop colour as a pure function of the current scale.
 *
 * Because it depends only on `logScale` and not on which band is drawing, two
 * bands mid-dissolve always paint the exact same background — the hand-off can
 * never show up as a colour shift.
 */
const ATMOSPHERE: AtmoKey[] = [
  { log: 0.48, color: 0x0d1016 }, // studio room
  { log: -1.0, color: 0x140f0e }, // approaching skin
  { log: -3.0, color: 0x1a1210 }, // skin surface, warm
  { log: -4.0, color: 0x140c09 }, // into the follicle, darker
  { log: -4.6, color: 0x0e0b0a }, // follicle depths
  { log: -5.2, color: 0x08110f }, // through the membrane
  { log: -6.0, color: 0x061016 }, // cytoplasm
  { log: -7.0, color: 0x050c17 }, // fine organelles
  { log: -7.6, color: 0x070a16 }, // viral / nuclear envelope
  { log: -8.8, color: 0x090818 }, // nucleoplasm
  { log: -10.1, color: 0x0a0616 }, // atomic
  { log: -11.5, color: 0x030309 }, // the void
  { log: -13.6, color: 0x010104 }, // deepest emptiness
  { log: -15.0, color: 0x120409 }, // nuclear matter, hot
  { log: -18.0, color: 0x160509 }, // inside the proton
  { log: -22.0, color: 0x08050f }, // field
  { log: -34.8, color: 0x05030c }, // Planck
];

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

export function atmosphereColor(logScale: number, out: THREE.Color): THREE.Color {
  if (logScale >= ATMOSPHERE[0].log) return out.setHex(ATMOSPHERE[0].color);
  for (let i = 0; i < ATMOSPHERE.length - 1; i++) {
    const a = ATMOSPHERE[i];
    const b = ATMOSPHERE[i + 1];
    if (logScale <= a.log && logScale >= b.log) {
      const t = (a.log - logScale) / (a.log - b.log);
      _c1.setHex(a.color);
      _c2.setHex(b.color);
      return out.copy(_c1).lerp(_c2, t);
    }
  }
  return out.setHex(ATMOSPHERE[ATMOSPHERE.length - 1].color);
}

// ---------------------------------------------------------------------------
// Rails
// ---------------------------------------------------------------------------

export interface RailPoint {
  /** Look target in local units. */
  p: THREE.Vector3Tuple;
  /**
   * Direction from the look target back toward the camera. Defaults to +Z.
   * Only set this when a band genuinely wants to swing round its subject.
   */
  dir?: THREE.Vector3Tuple;
  /** Optional roll in radians. */
  roll?: number;
}

const PLUS_Z: THREE.Vector3Tuple = [0, 0, 1];

/**
 * Builds a rail from a list of look-targets.
 *
 * The camera sits on the +Z side of its target and looks toward -Z. That
 * direction is AUTHORED, not derived from the path tangent.
 *
 * Deriving it from the tangent seems natural and is wrong: a look path that
 * drifts toward +Z — which band 1's does, because the cheek is in front of the
 * chest — produces a tangent pointing at the camera, and the camera dutifully
 * swings around behind the subject. Authoring the direction and defaulting it
 * to +Z also guarantees the property band hand-offs depend on, which is that
 * both bands in an overlap are looking down the same axis.
 *
 * The sense of flying forward comes from the dolly, which shrinks
 * exponentially, plus whatever lateral drift the look path has. That is plenty
 * of parallax; it does not need the camera to bank as well.
 */
export function makeRail(points: RailPoint[]): Rail {
  const pts = points.map((k) => new THREE.Vector3().fromArray(k.p));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);

  const N = 56;
  const keys: RailKey[] = [];
  const here = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const plusZ = new THREE.Vector3(0, 0, 1);

  // Fraction of each end over which any authored direction is blended back to
  // pure +Z, so hand-offs always meet on the same axis.
  const PIN = 0.18;

  for (let i = 0; i <= N; i++) {
    const u = i / N;
    curve.getPoint(u, here);
    sampleDir(points, u, dir);

    const endBlend = Math.min(smooth01(u / PIN), smooth01((1 - u) / PIN));
    dir.lerp(plusZ, 1 - endBlend).normalize();

    const roll = sampleRoll(points, u) * endBlend;
    keys.push({ look: [here.x, here.y, here.z], dir: [dir.x, dir.y, dir.z], roll });
  }
  return new Rail(keys);
}

function sampleDir(points: RailPoint[], u: number, out: THREE.Vector3): void {
  const n = points.length - 1;
  const f = Math.min(n, Math.max(0, u * n));
  const i = Math.min(n - 1, Math.floor(f));
  const a = points[i].dir ?? PLUS_Z;
  const b = points[i + 1].dir ?? PLUS_Z;
  const t = f - i;
  out.set(
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  );
  if (out.lengthSq() < 1e-12) out.set(0, 0, 1);
  out.normalize();
}

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

function sampleRoll(points: RailPoint[], u: number): number {
  const n = points.length - 1;
  const f = Math.min(n, Math.max(0, u * n));
  const i = Math.min(n - 1, Math.floor(f));
  const a = points[i].roll ?? 0;
  const b = points[i + 1].roll ?? 0;
  return a + (b - a) * (f - i);
}

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

export interface Scaffold {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  rail: Rail;
  background: THREE.Color;
  fog: THREE.FogExp2;
  key: THREE.PointLight;
  fill: THREE.PointLight;
  rim: THREE.PointLight;
  hemi: THREE.HemisphereLight;
  /** Call first in the band's update(). Handles atmosphere, fog and lighting. */
  updateCommon(frame: BandFrame): void;
}

export interface ScaffoldOptions {
  def: BandDef;
  quality: QualitySettings;
  rail: Rail;
  fov?: number;
  /** Fog thickness in units of focus distance. 0 disables. */
  fogFactor?: number;
  keyColor?: number;
  fillColor?: number;
  rimColor?: number;
  keyPower?: number;
  fillPower?: number;
  rimPower?: number;
  hemiSky?: number;
  hemiGround?: number;
  hemiPower?: number;
  /**
   * Camera-parented lights. Correct whenever the SUBJECT changes size through
   * the band. Band 1 turns this off, because a man lit by studio lamps should
   * not have his lighting follow the camera — there the lights are real objects
   * in a real room and inverse-square falloff is the truth, not an artefact.
   */
  cameraLights?: boolean;
  /** Light offsets from the camera, in units of focus distance. */
  keyOffset?: THREE.Vector3Tuple;
  fillOffset?: THREE.Vector3Tuple;
  rimOffset?: THREE.Vector3Tuple;
}

export function makeScaffold(opts: ScaffoldOptions): Scaffold {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(opts.fov ?? 50, 1, 0.1, 1000);

  const background = new THREE.Color(0x000000);
  scene.background = background;
  const fog = new THREE.FogExp2(0x000000, 0.01);
  scene.fog = fog;

  scene.add(camera);
  const useCameraLights = opts.cameraLights !== false;
  const key = new THREE.PointLight(opts.keyColor ?? 0xfff4e6, 1, 0, 2);
  const fill = new THREE.PointLight(opts.fillColor ?? 0x9fc4ff, 1, 0, 2);
  const rim = new THREE.PointLight(opts.rimColor ?? 0xbfd8ff, 1, 0, 2);
  if (useCameraLights) camera.add(key, fill, rim);
  const hemi = new THREE.HemisphereLight(
    opts.hemiSky ?? 0x556677,
    opts.hemiGround ?? 0x120e14,
    opts.hemiPower ?? 0.35,
  );
  scene.add(hemi);

  const keyOff = new THREE.Vector3().fromArray(opts.keyOffset ?? [0.55, 0.7, 0.35]);
  const fillOff = new THREE.Vector3().fromArray(opts.fillOffset ?? [-0.8, -0.25, 0.6]);
  const rimOff = new THREE.Vector3().fromArray(opts.rimOffset ?? [0.2, 0.3, -1.6]);
  const keyPower = opts.keyPower ?? 3.0;
  const fillPower = opts.fillPower ?? 1.1;
  const rimPower = opts.rimPower ?? 1.6;
  const fogFactor = opts.fogFactor ?? 0.25;

  function updateCommon(frame: BandFrame): void {
    atmosphereColor(frame.logScale, background);
    fog.color.copy(background);
    fog.density = fogFactor / Math.max(1e-12, frame.focusDistance);

    if (!useCameraLights) return;

    // Scale-invariant lighting: position in units of focus distance, intensity
    // as distance squared, so inverse-square falloff cancels out exactly.
    const d = frame.focusDistance;
    const d2 = d * d;
    key.position.copy(keyOff).multiplyScalar(d);
    fill.position.copy(fillOff).multiplyScalar(d);
    rim.position.copy(rimOff).multiplyScalar(d);
    key.intensity = keyPower * d2;
    fill.intensity = fillPower * d2;
    rim.intensity = rimPower * d2;
  }

  return { scene, camera, rail: opts.rail, background, fog, key, fill, rim, hemi, updateCommon };
}

// ---------------------------------------------------------------------------
// GPU motion for instanced objects
// ---------------------------------------------------------------------------

export interface GpuMotionOptions {
  /** Translation amplitude, in local units. */
  drift?: number;
  /** Translation frequency, Hz-ish. */
  driftRate?: number;
  /** Tumble rate in radians per second. */
  spin?: number;
  /** Extra per-instance size pulsing, 0..1. */
  pulse?: number;
}

const MOTION_GLSL = /* glsl */ `
uniform float uTime;
uniform float uDrift;
uniform float uDriftRate;
uniform float uSpin;
uniform float uPulse;

float mzHash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

vec3 mzDrift(vec3 seedPos) {
  float s = mzHash(seedPos) * 6.2831853;
  float t = uTime * uDriftRate;
  // Three incommensurate frequencies per axis: the sum never repeats visibly,
  // which is what makes it read as thermal jitter rather than as a loop.
  return uDrift * vec3(
    sin(t * 1.00 + s) + 0.5 * sin(t * 2.31 + s * 3.1),
    sin(t * 1.17 + s * 2.0) + 0.5 * sin(t * 2.73 + s * 1.7),
    sin(t * 0.89 + s * 4.0) + 0.5 * sin(t * 2.11 + s * 2.3)
  );
}

mat3 mzSpin(vec3 seedPos) {
  if (uSpin == 0.0) return mat3(1.0);
  float s = mzHash(seedPos + 17.0);
  vec3 axis = normalize(vec3(
    mzHash(seedPos + 1.0) - 0.5,
    mzHash(seedPos + 2.0) - 0.5,
    mzHash(seedPos + 3.0) - 0.5
  ) + 0.001);
  float a = uTime * uSpin * (0.4 + s);
  float c = cos(a), si = sin(a), ic = 1.0 - c;
  return mat3(
    c + axis.x * axis.x * ic, axis.x * axis.y * ic - axis.z * si, axis.x * axis.z * ic + axis.y * si,
    axis.y * axis.x * ic + axis.z * si, c + axis.y * axis.y * ic, axis.y * axis.z * ic - axis.x * si,
    axis.z * axis.x * ic - axis.y * si, axis.z * axis.y * ic + axis.x * si, c + axis.z * axis.z * ic
  );
}
`;

export interface MotionHandle {
  uniforms: {
    uTime: { value: number };
    uDrift: { value: number };
    uDriftRate: { value: number };
    uSpin: { value: number };
    uPulse: { value: number };
  };
}

/**
 * Adds per-instance Brownian drift and tumbling to a standard material, done
 * entirely in the vertex shader.
 *
 * Everything that appears in quantity — bacteria, ribosomes, nucleosomes,
 * atoms, gluons — uses this. The CPU never touches an instance matrix after
 * setup, so instance counts in the tens of thousands cost nothing per frame.
 */
export function applyGpuMotion(
  material: THREE.Material,
  opts: GpuMotionOptions = {},
): MotionHandle {
  const uniforms = {
    uTime: { value: 0 },
    uDrift: { value: opts.drift ?? 0 },
    uDriftRate: { value: opts.driftRate ?? 1 },
    uSpin: { value: opts.spin ?? 0 },
    uPulse: { value: opts.pulse ?? 0 },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${MOTION_GLSL}`)
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        #ifdef USE_INSTANCING
          objectNormal = mzSpin(instanceMatrix[3].xyz) * objectNormal;
        #endif`,
      )
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          vec3 mzSeed = instanceMatrix[3].xyz;
          mvPosition.xyz = mzSpin(mzSeed) * mvPosition.xyz;
          mvPosition.xyz *= 1.0 + uPulse * sin(uTime * 1.7 + mzHash(mzSeed) * 6.283);
          mvPosition = instanceMatrix * mvPosition;
          mvPosition.xyz += mzDrift(mzSeed);
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  material.customProgramCacheKey = () => 'mz-motion';
  return { uniforms };
}

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

/** Deterministic pseudo-random generator so scenes are reproducible. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Fills an InstancedMesh from a callback, then marks it clean. */
export function fillInstances(
  mesh: THREE.InstancedMesh,
  fn: (i: number, dummy: THREE.Object3D) => void,
): void {
  const dummy = new THREE.Object3D();
  for (let i = 0; i < mesh.count; i++) {
    dummy.position.set(0, 0, 0);
    dummy.quaternion.identity();
    dummy.scale.setScalar(1);
    fn(i, dummy);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
}

/** Scales an instance count by the quality preset, with a sane floor. */
export function count(quality: QualitySettings, n: number, floor = 8): number {
  return Math.max(floor, Math.round(n * quality.instanceScale));
}

/**
 * Scales a LINEAR geometry parameter — segment counts, ring counts, grid
 * resolution — by the quality preset. Cost grows roughly linearly, so a
 * multiplier is the right thing.
 */
export function detail(quality: QualitySettings, n: number, floor = 3): number {
  return Math.max(floor, Math.round(n * quality.detailScale));
}

/**
 * Shifts a SUBDIVISION LEVEL by whole steps.
 *
 * Icosahedron and similar recursive geometries have 4^level faces, so scaling
 * the level by a multiplier is catastrophic: at detailScale 1.5 a level-6 head
 * would become level 9, which is 5 million triangles for one mesh. Quality
 * therefore moves these by at most a step or two, never by a factor.
 */
export function subdiv(quality: QualitySettings, base: number, floor = 0): number {
  const d = quality.detailScale;
  const bump = d >= 2.0 ? 2 : d >= 1.25 ? 1 : d >= 0.8 ? 0 : -1;
  return Math.max(floor, base + bump);
}

/** Disposes every geometry and material reachable from a scene. */
export function disposeScene(scene: THREE.Scene): void {
  const seen = new Set<THREE.Material | THREE.BufferGeometry>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !seen.has(m.geometry)) {
      seen.add(m.geometry);
      m.geometry.dispose();
    }
    const mat = m.material;
    if (mat) {
      const list = Array.isArray(mat) ? mat : [mat];
      for (const x of list) {
        if (!seen.has(x)) {
          seen.add(x);
          x.dispose();
        }
      }
    }
  });
  scene.clear();
}
