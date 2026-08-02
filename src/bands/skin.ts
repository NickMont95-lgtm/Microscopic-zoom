import * as THREE from 'three';
import type { BandFrame, QualitySettings } from '../core/types.ts';
import { detail, metresPerUnit } from './common.ts';

/**
 * Procedural skin surface.
 *
 * No texture has the resolution to survive this zoom — going from a 20 cm view
 * of a cheek to a 200 µm view of a single pore is a factor of a thousand, which
 * would need a 100,000-pixel-wide map. So the surface is a continuous field
 * evaluated in METRES, and the mesh is a fixed grid that the vertex shader
 * re-projects over a smaller and smaller patch as the camera descends.
 *
 * Two consequences worth stating:
 *  - Bands 2, 3 and 4 all sample the identical field, so the same pore is in
 *    the same place in all three. Their hand-offs are the same surface drawn
 *    twice, not two different surfaces blended.
 *  - Normals are computed analytically from the field in the fragment shader,
 *    not from vertex normals. The mesh grid slides over the surface as the
 *    patch shrinks, but the shading never swims, because shading never depends
 *    on where the vertices happen to be.
 *
 * Structures modelled, with real dimensions:
 *  - broad dermal undulation, ~5 mm wavelength
 *  - dermatoglyphic microrelief: the polygonal network of primary skin lines,
 *    cells ~250 µm across, grooves ~35 µm deep
 *  - follicular openings (pores) on a jittered grid at ~450 µm spacing, mouth
 *    40-100 µm across, funnelling into the infundibulum
 *  - corneocyte plates, ~35 µm across, ~1.5 µm of relief
 */

export const FOLLICLE_SPACING = 450e-6; // metres between follicles on the cheek
export const PORE_RADIUS = 45e-6; // mouth radius of the follicular opening
export const MICRORELIEF_CELL = 250e-6;
export const CORNEOCYTE_CELL = 35e-6;

/** Shared GLSL. Every length in here is metres. */
export const SKIN_FIELD_GLSL = /* glsl */ `
uniform float uPatchMetres;   // half-width of the patch currently drawn
uniform vec2  uPatchCentre;   // field coords of the dive target
uniform float uPixelMetres;   // metres per screen pixel, for LOD fade
uniform float uBreath;        // -1..1, slow skin flex
uniform float uFollicleFade;  // 0..1, how open the central pore is
uniform float uSebum;         // 0..1, strength of the sebum sheen

float skHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
vec2 skHash2(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

float skValueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(skHash(i), skHash(i + vec2(1, 0)), u.x),
             mix(skHash(i + vec2(0, 1)), skHash(i + vec2(1, 1)), u.x), u.y);
}

float skFbm(vec2 p, int octaves) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    s += a * skValueNoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

// Worley F1/F2. The ridge between cells is what draws the skin's line network.
vec2 skWorley(vec2 p) {
  vec2 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 c = o + skHash2(ip + o) - fp;
      float d = dot(c, c);
      if (d < f1) { f2 = f1; f1 = d; }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec2(sqrt(f1), sqrt(f2));
}

/** Distance in metres to the nearest follicle centre, and its jitter seed. */
vec3 skNearestFollicle(vec2 pM) {
  vec2 g = pM / ${FOLLICLE_SPACING.toExponential()};
  vec2 ip = floor(g), fp = fract(g);
  float best = 1e9;
  vec2 bestId = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 jitter = skHash2(ip + o) * 0.62 + 0.19;
      vec2 c = o + jitter - fp;
      float d = length(c);
      if (d < best) { best = d; bestId = ip + o; }
    }
  }
  return vec3(best * ${FOLLICLE_SPACING.toExponential()}, bestId);
}

/**
 * Surface height in metres. Positive is outward.
 * Octaves finer than a few pixels are faded out to stop the surface aliasing
 * into noise when seen from far away.
 */
float skHeight(vec2 pM) {
  float h = 0.0;

  // Broad dermal undulation.
  h += (skFbm(pM / 5.0e-3, 3) - 0.5) * 300.0e-6;

  // Dermatoglyphic microrelief: primary lines forming shallow polygons.
  float mrFade = smoothstep(${(MICRORELIEF_CELL * 0.35).toExponential()}, ${(MICRORELIEF_CELL * 0.08).toExponential()}, uPixelMetres);
  if (mrFade > 0.001) {
    vec2 w = skWorley(pM / ${MICRORELIEF_CELL.toExponential()});
    float edge = smoothstep(0.0, 0.34, w.y - w.x);
    h -= (1.0 - edge) * 35.0e-6 * mrFade;
    // The cell interiors bulge very slightly.
    h += edge * 6.0e-6 * mrFade;
  }

  // Corneocyte plates: the flat dead cells of the stratum corneum.
  float ccFade = smoothstep(${(CORNEOCYTE_CELL * 0.4).toExponential()}, ${(CORNEOCYTE_CELL * 0.06).toExponential()}, uPixelMetres);
  if (ccFade > 0.001) {
    vec2 w2 = skWorley(pM / ${CORNEOCYTE_CELL.toExponential()} + 31.7);
    float e2 = smoothstep(0.0, 0.30, w2.y - w2.x);
    h -= (1.0 - e2) * 1.6e-6 * ccFade;
  }

  // Follicular openings. The mouth is a smooth funnel; deeper down it becomes
  // the infundibulum, which band 4 takes over and models as real geometry.
  vec3 fol = skNearestFollicle(pM);
  float r = fol.x;
  float rad = ${PORE_RADIUS.toExponential()} * (0.62 + 0.85 * skHash(fol.yz + 5.0));
  float pore = 1.0 - smoothstep(rad * 0.35, rad * 1.35, r);
  h -= pore * pore * 260.0e-6 * uFollicleFade;

  // The follicle the camera actually dives into. Guaranteed to exist at the
  // dive target rather than left to the jittered grid, and a little larger than
  // its neighbours, the way a real one you happen to notice usually is.
  float rh = length(pM - uPatchCentre);
  float heroRad = 52.0e-6;
  float hero = 1.0 - smoothstep(heroRad * 0.28, heroRad * 1.5, rh);
  h -= hero * hero * 520.0e-6 * uFollicleFade;

  // Breathing flexes the surface very slightly.
  h += uBreath * 40.0e-6 * (0.5 + 0.5 * skValueNoise(pM / 8.0e-3));

  return h;
}

/** Sebum film: pools in the microrelief grooves and around follicle mouths. */
float skSebum(vec2 pM) {
  float rh = length(pM - uPatchCentre);
  float nearPore = 1.0 - smoothstep(40.0e-6, 260.0e-6, rh);
  vec3 fol = skNearestFollicle(pM);
  float nearAny = 1.0 - smoothstep(50.0e-6, 300.0e-6, fol.x);
  float film = skFbm(pM / 400.0e-6, 3);
  return clamp(max(nearPore, nearAny) * 0.75 + film * 0.45, 0.0, 1.0);
}
`;

export interface SkinPatchOptions {
  quality: QualitySettings;
  /**
   * Half-width of the drawn patch, expressed as a multiple of the screen width.
   * 3 means the patch is three screens wide, so it always fills the frame.
   */
  coverage?: number;
  /** Field coordinates (metres) of the point the camera is diving toward. */
  centre?: [number, number];
  /** Tilt of the surface away from the view axis, radians. */
  tilt?: number;
  /** Multiplies the follicle depression. Band 4 opens it fully. */
  follicleFade?: number;
  color?: number;
  /** Base roughness of dry skin. */
  roughness?: number;
  /** Strength of the sebum sheen, 0..1. */
  sebum?: number;
}

export interface SkinPatch {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  update(frame: BandFrame): void;
  dispose(): void;
}

/**
 * Builds the skin surface for one band.
 *
 * The mesh is a plane in the X/Y of its own local space, tilted, facing +Z. The
 * vertex shader spreads that grid over a patch whose size tracks the current
 * scale, so the same 200×200 grid describes 20 cm of cheek or 200 µm of a
 * single pore rim.
 */
export function makeSkinPatch(opts: SkinPatchOptions): SkinPatch {
  const q = opts.quality;
  const seg = detail(q, 220, 64);
  const geo = new THREE.PlaneGeometry(1, 1, seg, seg);

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(opts.color ?? 0xd9a184).convertSRGBToLinear(),
    roughness: opts.roughness ?? 0.52,
    metalness: 0,
  });

  const uniforms = {
    uPatchMetres: { value: 0.1 },
    uPatchCentre: { value: new THREE.Vector2(opts.centre?.[0] ?? 0, opts.centre?.[1] ?? 0) },
    uPixelMetres: { value: 1e-4 },
    uBreath: { value: 0 },
    uFollicleFade: { value: opts.follicleFade ?? 1 },
    uSebum: { value: opts.sebum ?? 0.5 },
    uLocalPerMetre: { value: 1 },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uLocalPerMetre;
         varying vec2 vFieldM;
         varying vec3 vSurfT;
         varying vec3 vSurfB;
         varying vec3 vSurfN;
         ${SKIN_FIELD_GLSL}`,
      )
      .replace(
        '#include <begin_vertex>',
        `// position.xy is the unit grid; spread it over the current patch.
         vec2 fieldM = uPatchCentre + position.xy * (2.0 * uPatchMetres);
         vFieldM = fieldM;
         // The surface basis in view space. modelViewMatrix does not exist in
         // three's fragment shader, so the analytic normal is rebuilt down there
         // from these three vectors instead of being transformed directly.
         vSurfT = normalize((modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
         vSurfB = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
         vSurfN = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
         float hM = skHeight(fieldM);
         vec3 transformed = vec3(
           position.xy * (2.0 * uPatchMetres) * uLocalPerMetre,
           hM * uLocalPerMetre
         );`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec2 vFieldM;
         varying vec3 vSurfT;
         varying vec3 vSurfB;
         varying vec3 vSurfN;
         ${SKIN_FIELD_GLSL}`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `// Analytic normal from the same field the vertices came from. Central
         // differences at roughly one pixel, so detail resolves as we approach
         // instead of being frozen into the mesh.
         float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
         float eps = max(uPixelMetres * 1.2, uPatchMetres * 1.0e-4);
         float hL = skHeight(vFieldM - vec2(eps, 0.0));
         float hR = skHeight(vFieldM + vec2(eps, 0.0));
         float hD = skHeight(vFieldM - vec2(0.0, eps));
         float hU = skHeight(vFieldM + vec2(0.0, eps));
         vec3 nObj = normalize(vec3(-(hR - hL) / (2.0 * eps), -(hU - hD) / (2.0 * eps), 1.0));
         vec3 normal = normalize(nObj.x * vSurfT + nObj.y * vSurfB + nObj.z * vSurfN);
         normal *= faceDirection;
         vec3 nonPerturbedNormal = normal;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         // Sebum makes skin glossy in patches, never uniformly.
         roughnessFactor = mix(roughnessFactor, 0.24, skSebum(vFieldM) * uSebum);`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         // Melanin mottling and a little erythema, so the skin is not one flat
         // colour. Both are low frequency; skin colour varies over millimetres.
         float mel = skFbm(vFieldM / 2.2e-3, 3);
         float ery = skFbm(vFieldM / 6.0e-3 + 19.0, 2);
         diffuseColor.rgb *= mix(0.90, 1.08, mel);
         diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.10, 0.90, 0.88), ery * 0.22);
         // Grooves read darker: less light escapes from inside a crevice. Kept
         // gentle — a hard version turns the microrelief into black cracks.
         float ao = smoothstep(-120.0e-6, 10.0e-6, skHeight(vFieldM));
         diffuseColor.rgb *= mix(0.62, 1.0, ao);`,
      );
  };
  material.customProgramCacheKey = () => 'mz-skin';

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  if (opts.tilt) {
    mesh.rotation.y = opts.tilt;
  }

  const coverage = opts.coverage ?? 2.2;

  function update(frame: BandFrame): void {
    const mpu = metresPerUnit(frame);
    // Patch half-width in metres, tracking the current framing.
    const halfMetres = frame.metresVisible * coverage * 0.5;
    uniforms.uPatchMetres.value = halfMetres;
    uniforms.uLocalPerMetre.value = 1 / mpu;
    // Screen pixels are not known here, so approximate: a 1600-pixel-wide view.
    uniforms.uPixelMetres.value = frame.metresVisible / 1600;
    uniforms.uBreath.value = Math.sin(frame.elapsed * 2 * Math.PI * (14 / 60));
  }

  function dispose(): void {
    geo.dispose();
    material.dispose();
  }

  return { mesh, material, update, dispose };
}

/**
 * Hairs emerging from follicles.
 *
 * Terminal beard hair is 60-120 µm across and grows at a shallow angle; vellus
 * hair is under 30 µm, short and nearly colourless. Both are instanced tapered
 * cylinders with a slow sway, which is enough at these scales — a hair is a
 * smooth cylinder long before you can see its cuticle scales.
 */
export interface HairFieldOptions {
  quality: QualitySettings;
  count: number;
  /** Area covered, in metres. */
  areaMetres: number;
  /** Local units per metre. */
  localPerMetre: number;
  /** Hair shaft diameter range, metres. */
  diameter: [number, number];
  /** Hair length range, metres. */
  length: [number, number];
  color?: number;
  /** Keeps hairs out of a disc around the dive target. */
  clearRadiusMetres?: number;
  seed?: number;
}

export interface HairField {
  mesh: THREE.InstancedMesh;
  update(t: number): void;
  dispose(): void;
}

export function makeHairField(opts: HairFieldOptions): HairField {
  const q = opts.quality;
  const n = Math.max(6, Math.round(opts.count * q.instanceScale));
  const geo = new THREE.CylinderGeometry(0.35, 1, 1, detail(q, 7, 4), 1, true);
  // Move the pivot to the base so instances can be scaled by length directly.
  geo.translate(0, 0.5, 0);

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(opts.color ?? 0x59422f).convertSRGBToLinear(),
    roughness: 0.55,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.frustumCulled = false;

  const L = opts.localPerMetre;
  const rngSeed = opts.seed ?? 4;
  let s = rngSeed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  interface H {
    base: THREE.Vector3;
    dir: THREE.Vector3;
    len: number;
    rad: number;
    phase: number;
  }
  const hairs: H[] = [];
  const clear = opts.clearRadiusMetres ?? 0;

  let placed = 0;
  let guard = 0;
  while (placed < n && guard++ < n * 40) {
    const x = (rnd() - 0.5) * opts.areaMetres;
    const y = (rnd() - 0.5) * opts.areaMetres;
    if (Math.hypot(x, y) < clear) continue;
    const len = opts.length[0] + rnd() * (opts.length[1] - opts.length[0]);
    const rad = (opts.diameter[0] + rnd() * (opts.diameter[1] - opts.diameter[0])) * 0.5;
    // Beard hair leaves the skin at a shallow angle, not perpendicular.
    const tilt = 0.55 + rnd() * 0.55;
    const az = rnd() * Math.PI * 2;
    hairs.push({
      base: new THREE.Vector3(x * L, y * L, 0),
      dir: new THREE.Vector3(
        Math.cos(az) * Math.sin(tilt),
        Math.sin(az) * Math.sin(tilt),
        Math.cos(tilt),
      ),
      len: len * L,
      rad: rad * L,
      phase: rnd() * Math.PI * 2,
    });
    placed++;
  }
  mesh.count = placed;

  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const q0 = new THREE.Quaternion();

  function update(t: number): void {
    for (let i = 0; i < placed; i++) {
      const h = hairs[i];
      // Slow sway, as if from air movement.
      const sway = Math.sin(t * 0.7 + h.phase) * 0.06 + Math.sin(t * 1.31 + h.phase * 2) * 0.03;
      dir.copy(h.dir);
      dir.x += sway;
      dir.y += sway * 0.6;
      dir.normalize();
      q0.setFromUnitVectors(up, dir);
      dummy.position.copy(h.base);
      dummy.quaternion.copy(q0);
      dummy.scale.set(h.rad, h.len, h.rad);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function dispose(): void {
    geo.dispose();
    mat.dispose();
  }

  update(0);
  return { mesh, update, dispose };
}
