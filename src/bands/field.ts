import * as THREE from 'three';
import type { BandFrame, QualitySettings } from '../core/types.ts';

/**
 * A volumetric noise field for the three wrapping bands.
 *
 * The problem it solves: bands 11–13 cover 4, 4 and 17 decades. Float32
 * geometry cannot hold that, so those bands dolly one decade and then re-anchor
 * — the camera jumps back to the start of the window while everything in it
 * jumps 10x in scale. For that jump to be invisible, the content has to look
 * statistically identical at 10x magnification. It has to be a fractal.
 *
 * So the noise is an fbm with lacunarity 10 — one octave per decade — and a
 * sliding window that fades an octave in at the far end exactly as it fades one
 * out at the near end. Advance the phase by a whole octave and the sum is
 * unchanged. That identity is what makes the re-anchor undetectable, and it is
 * the only reason band 13 can cover seventeen orders of magnitude at all.
 *
 * Rendered as a stack of camera-facing additive slices rather than a raymarch:
 * far cheaper, and for a soft seething field the difference is not visible.
 */

const VERT = /* glsl */ `
varying vec3 vPos;
varying float vSlice;
attribute float aSlice;
uniform float uSpread;
void main() {
  vSlice = aSlice;
  // Each slice sits at its own depth in front of the camera, in view space.
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.z -= aSlice * uSpread;
  vPos = position + vec3(0.0, 0.0, -aSlice * uSpread);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vPos;
varying float vSlice;

uniform float uTime;
uniform float uPhase;      // 0..1 fractional octave offset, = uLocal
uniform float uDensity;
uniform float uFlow;       // how fast the field churns
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform float uContrast;
uniform float uScale;

float fHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float fNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(fHash(i + vec3(0, 0, 0)), fHash(i + vec3(1, 0, 0)), f.x),
                 mix(fHash(i + vec3(0, 1, 0)), fHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(fHash(i + vec3(0, 0, 1)), fHash(i + vec3(1, 0, 1)), f.x),
                 mix(fHash(i + vec3(0, 1, 1)), fHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

/**
 * Scale-invariant fbm. Octaves are a decade apart and the window slides with
 * uPhase, so fZoom(p, phase + 1) == fZoom(p * 10, phase) exactly.
 */
float fZoom(vec3 p, float phase, float t) {
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    float o = float(i) + phase;
    float freq = pow(10.0, o - 1.5);
    // Fade in at the coarse end, out at the fine end. The support has to sit
    // entirely inside [0, 4] or advancing the phase by one octave would not
    // reproduce the same sum, and the re-anchor would show.
    float w = smoothstep(0.0, 1.1, o) * smoothstep(4.0, 2.9, o);
    if (w > 0.001) {
      // Finer octaves churn faster: small structures have less inertia.
      sum += w * fNoise(p * freq + vec3(0.0, 0.0, t * freq * 0.35));
      wsum += w;
    }
  }
  return sum / max(wsum, 1e-4);
}

void main() {
  float n = fZoom(vPos * uScale, uPhase, uTime * uFlow);

  float d = pow(max(0.0, n * 1.35 - 0.35), uContrast) * uDensity;
  // Each slice contributes only a fraction, so the stack integrates.
  d *= 1.0 - abs(vSlice - 0.5) * 0.6;

  // Colour ramps off the same noise sample. Evaluating a second fbm here to
  // drive colour separately doubled the shader cost for a difference nobody
  // could see through an additive stack.
  vec3 col = mix(uColorA, uColorB, clamp(n * 2.1 - 0.35, 0.0, 1.0));
  gl_FragColor = vec4(col * d, d);
}
`;

export interface FieldOptions {
  quality: QualitySettings;
  /** Number of slices. Scaled by quality. */
  slices?: number;
  /** Half-width of each slice, in local units. */
  extent: number;
  /** Depth the stack spans, in local units. */
  depth: number;
  density?: number;
  flow?: number;
  contrast?: number;
  /** Spatial frequency multiplier applied before the fbm. */
  scale?: number;
  colorA?: number;
  colorB?: number;
}

export interface Field {
  mesh: THREE.Mesh;
  update(frame: BandFrame): void;
  dispose(): void;
}

export function makeField(opts: FieldOptions): Field {
  const q = opts.quality;
  // Slice count scales conservatively. Each slice is a full-screen additive
  // layer running a four-octave 3D fbm, so this is pure fill cost and doubling
  // it halves the band's frame rate.
  const n = Math.max(5, Math.round((opts.slices ?? 14) * (0.65 + 0.35 * q.detailScale)));

  // One big buffer of n quads, each tagged with its slice index.
  const positions: number[] = [];
  const slices: number[] = [];
  const indices: number[] = [];
  const e = opts.extent;
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    const base = i * 4;
    positions.push(-e, -e, 0, e, -e, 0, e, e, 0, -e, e, 0);
    slices.push(s, s, s, s);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aSlice', new THREE.Float32BufferAttribute(slices, 1));
  geo.setIndex(indices);

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uPhase: { value: 0 },
      uDensity: { value: opts.density ?? 0.5 },
      uFlow: { value: opts.flow ?? 1 },
      uContrast: { value: opts.contrast ?? 1.6 },
      uScale: { value: opts.scale ?? 1 },
      uSpread: { value: opts.depth / Math.max(1, n - 1) },
      uColorA: { value: new THREE.Color(opts.colorA ?? 0x3050a0).convertSRGBToLinear() },
      uColorB: { value: new THREE.Color(opts.colorB ?? 0xff6a3d).convertSRGBToLinear() },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  // Drawn behind everything solid.
  mesh.renderOrder = -1;

  function update(frame: BandFrame): void {
    material.uniforms.uTime.value = frame.elapsed;
    // The octave window slides exactly one octave per dolly window.
    material.uniforms.uPhase.value = frame.uLocal;
  }

  function dispose(): void {
    geo.dispose();
    material.dispose();
  }

  return { mesh, update, dispose };
}
