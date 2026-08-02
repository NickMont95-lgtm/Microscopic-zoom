import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeRng } from './common.ts';

/**
 * A procedural standing man, roughly 35, with a full beard.
 *
 * This is deliberately a *placeholder that reads correctly* rather than an
 * attempt at photorealism. A convincing human head is the single hardest asset
 * in this project and it cannot be written in code — it needs to be scanned or
 * sculpted. See `loadHeadModel()` below for how to drop a real one in.
 *
 * The compensating factor is that he is only on screen for about 1.3 decades of
 * a 35-decade descent, at which point the cheek surface takes over and the head
 * silhouette stops mattering. The effort is therefore spent on silhouette,
 * beard volume and skin shading rather than on facial likeness.
 *
 * All units here are metres; band 1 scales the whole rig into its local space.
 */

export interface Figure {
  root: THREE.Group;
  head: THREE.Group;
  /** World-space point on the cheek that the camera dives into. */
  cheekPoint: THREE.Vector3;
  /** Outward normal at that point. */
  cheekNormal: THREE.Vector3;
  update(t: number): void;
  dispose(): void;
}

const SKIN = new THREE.Color(0xd8a689).convertSRGBToLinear();
const SKIN_DEEP = new THREE.Color(0xa8654f).convertSRGBToLinear();
const BEARD = new THREE.Color(0x5e4636).convertSRGBToLinear();
const HAIR = new THREE.Color(0x4a382c).convertSRGBToLinear();

/** Smooth radial falloff used to sculpt features. */
function bump(d: number, r: number): number {
  if (d >= r) return 0;
  const t = 1 - d / r;
  return t * t * (3 - 2 * t);
}

/**
 * Sculpts a sphere into a head by displacing vertices with a set of
 * anatomically placed falloffs. Crude, but it produces a real silhouette:
 * cranium, brow, nose, cheekbones, jaw and chin.
 */
function buildHeadGeometry(detail: number): THREE.BufferGeometry {
  // IcosahedronGeometry is non-indexed: every triangle owns its three vertices,
  // so computeVertexNormals() gives per-face normals and the head renders as a
  // visible polyhedron. Welding the duplicates first is what makes the sculpt
  // shade smoothly — and it also stops the hair displacement from splitting the
  // surface along every triangle edge.
  const geo = mergeVertices(new THREE.IcosahedronGeometry(0.092, detail), 1e-6);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.copy(v).normalize();

    // Overall head proportions: taller than wide, slightly flattened at back.
    v.y *= 1.19;
    v.z *= n.z > 0 ? 1.07 : 0.95;
    v.x *= 0.97;

    const { x, y, z } = v;
    const front = Math.max(0, n.z);

    // Jaw and chin: narrow the lower head and push the chin forward.
    if (y < 0) {
      const t = Math.min(1, -y / 0.09);
      v.x *= 1 - 0.34 * t * t;
      v.z *= 1 - 0.10 * t * t;
      v.z += front * 0.022 * t * t;
      v.y -= 0.012 * t;
    }

    // Cranium: broaden the upper skull a little.
    if (y > 0.03) {
      const t = Math.min(1, (y - 0.03) / 0.07);
      v.x *= 1 + 0.05 * t;
    }

    // Brow ridge.
    v.z += front * bump(Math.hypot(x, y - 0.032, Math.max(0, z - 0.06)), 0.055) * 0.011;

    // Cheekbones (malar eminences) — the landmark the camera eventually lands on.
    for (const sx of [-1, 1]) {
      const d = Math.hypot(x - sx * 0.048, y - 0.002, Math.max(0, 0.055 - z));
      v.z += front * bump(d, 0.045) * 0.013;
      v.x += sx * bump(d, 0.045) * 0.006;
    }

    // Eye sockets: pull the surface in.
    for (const sx of [-1, 1]) {
      const d = Math.hypot(x - sx * 0.032, y - 0.021, Math.max(0, 0.06 - z));
      v.z -= front * bump(d, 0.029) * 0.015;
    }

    // Temples.
    for (const sx of [-1, 1]) {
      const d = Math.hypot(x - sx * 0.070, y - 0.040, z);
      v.x -= sx * bump(d, 0.040) * 0.006;
    }

    pos.setXYZ(i, v.x, v.y, v.z);
  }

  geo.computeVertexNormals();
  return geo;
}

/** A simple nose, built separately so it can have its own crisp silhouette. */
function buildNose(): THREE.BufferGeometry {
  const shape = new THREE.BufferGeometry();
  const pts: number[] = [];
  const idx: number[] = [];
  // Bridge to tip, plus two nostril wings. Low poly on purpose.
  const profile: [number, number, number][] = [
    [0, 0.030, 0.088],
    [0, 0.012, 0.098],
    [0, -0.004, 0.106],
    [0, -0.014, 0.100],
  ];
  const halfWidth = [0.007, 0.010, 0.014, 0.017];
  for (let i = 0; i < profile.length; i++) {
    const [, y, z] = profile[i];
    const w = halfWidth[i];
    pts.push(-w, y, z - 0.012, 0, y, z, w, y, z - 0.012);
  }
  for (let i = 0; i < profile.length - 1; i++) {
    const a = i * 3;
    const b = (i + 1) * 3;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
    idx.push(a + 1, b + 1, a + 2, b + 1, b + 2, a + 2);
  }
  shape.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  shape.setIndex(idx);
  shape.computeVertexNormals();
  return shape;
}

/**
 * Beard and scalp hair, applied to the head mesh itself.
 *
 * The earlier approach — building separate offset shells over the hair regions
 * — could not be made to work. A shell has to be culled where hair stops, and
 * culling triangles leaves ragged holes; and where its offset tapers to zero it
 * lands on the skin and z-fights. Both showed as a torn net with skin flashing
 * through it.
 *
 * Displacing and tinting the head's own vertices avoids both failures by
 * construction: one watertight mesh, nothing to tear, nothing to fight.
 * Individual strands are invisible at this scale anyway — a beard hair is 80 µm
 * across, well under a pixel — so what matters is mass, silhouette and the fact
 * that hair is darker and rougher than skin.
 */
function hairNoise(x: number, y: number, z: number, seed: number): number {
  const s = seed * 1.7;
  return (
    0.5 +
    0.24 * Math.sin(x * 165 + s) * Math.cos(y * 148 + s * 1.3) +
    0.15 * Math.sin(y * 300 + s * 2.1) * Math.cos(z * 255 + s) +
    0.09 * Math.sin((x + z) * 430 + s * 0.7)
  );
}

/** Fraction of the head covered by beard at a point. */
function beardMask(x: number, y: number, z: number): number {
  if (z < -0.03) return 0;
  // The beard line runs low at the chin and climbs the jaw toward the ear.
  const line = -0.016 - 0.026 * Math.min(1, Math.max(0, (Math.abs(x) - 0.028) / 0.055));
  const below = smooth01((line - y) / 0.026);
  const sides = smooth01((0.094 - Math.abs(x)) / 0.020);
  // Lips stay bare; the moustache above them does not.
  const lips = y > -0.046 && y < -0.026 && Math.abs(x) < 0.019 && z > 0.070 ? 0.12 : 1;
  return below * sides * lips;
}

/** Fraction covered by scalp hair. */
function scalpMask(x: number, y: number, _z: number): number {
  const hairline = 0.049 - 0.013 * Math.min(1, Math.abs(x) / 0.058);
  return smooth01((y - hairline) / 0.020);
}

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/**
 * Pushes the hair regions outward and writes a per-vertex colour. Returns the
 * geometry with a `color` attribute the material reads.
 */
function applyHair(geo: THREE.BufferGeometry): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);

    const beard = beardMask(v.x, v.y, v.z);
    const scalp = scalpMask(v.x, v.y, v.z);

    const beardT = 0.0092 * beard * (0.55 + 0.85 * hairNoise(v.x, v.y, v.z, 7));
    const scalpT = 0.0125 * scalp * (0.6 + 0.75 * hairNoise(v.x, v.y, v.z, 21));
    const t = Math.max(beardT, scalpT);
    pos.setXYZ(i, v.x + n.x * t, v.y + n.y * t, v.z + n.z * t);

    // Colour: skin, tinted toward beard or scalp hair. Stubble at the edge of
    // the beard shows as skin darkened rather than as hair.
    c.copy(SKIN);
    if (beard > 0.001) c.lerp(BEARD, Math.min(1, beard * 1.25));
    if (scalp > 0.001) c.lerp(HAIR, Math.min(1, scalp * 1.35));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

function capsule(radius: number, length: number, seg = 10): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(radius, length, 4, seg);
}

export function buildFigure(detailLevel: number): Figure {
  // The head carries the whole band, so it never drops below a level where the
  // silhouette reads as a head rather than as a polyhedron.
  const headDetail = Math.max(4, detailLevel);
  const root = new THREE.Group();
  const rng = makeRng(20260802);

  const skinMat = new THREE.MeshStandardMaterial({
    color: SKIN,
    roughness: 0.62,
    metalness: 0,
  });

  // The head carries skin and hair on one mesh, separated by vertex colour.
  // Roughness follows the colour: hair scatters much more than skin does.
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.62,
    metalness: 0,
  });
  headMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
       // Component access rather than dot(): three declares vColor as vec3 or
       // vec4 depending on whether vertex alpha is in play, and dot() will not
       // silently accept the wrong one.
       float hairLuma = vColor.r * 0.299 + vColor.g * 0.587 + vColor.b * 0.114;
       float hairAmt = 1.0 - smoothstep(0.04, 0.26, hairLuma);
       roughnessFactor = mix(roughnessFactor, 0.96, hairAmt);`,
    );
  };
  headMat.customProgramCacheKey = () => 'mz-head';
  const hairMat = new THREE.MeshStandardMaterial({
    color: HAIR,
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const clothMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x6b7280).convertSRGBToLinear(),
    roughness: 0.80,
  });

  // ---- head -------------------------------------------------------------
  const head = new THREE.Group();
  head.position.set(0, 1.655, 0);
  root.add(head);

  const headGeo = buildHeadGeometry(headDetail);
  applyHair(headGeo);
  const headMesh = new THREE.Mesh(headGeo, headMat);
  head.add(headMesh);

  const nose = new THREE.Mesh(buildNose(), skinMat);
  head.add(nose);



  // Ears.
  const earGeo = new THREE.SphereGeometry(0.022, 10, 8);
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(earGeo, skinMat);
    ear.position.set(sx * 0.081, 0.0, -0.004);
    ear.scale.set(0.32, 1.05, 0.72);
    head.add(ear);
  }

  // Eyes: sclera sphere, iris disc, and a lid that scales down to blink.
  const eyes: THREE.Group[] = [];
  const scleraGeo = new THREE.SphereGeometry(0.0125, 14, 12);
  const irisGeo = new THREE.CircleGeometry(0.0058, 20);
  const scleraMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xe8e4de).convertSRGBToLinear(),
    roughness: 0.22,
  });
  const irisMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x4d6b58).convertSRGBToLinear(),
    roughness: 0.18,
  });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.1 });
  const lidGeo = new THREE.SphereGeometry(0.0131, 14, 10);

  for (const sx of [-1, 1]) {
    const g = new THREE.Group();
    g.position.set(sx * 0.034, 0.020, 0.0635);
    const sclera = new THREE.Mesh(scleraGeo, scleraMat);
    g.add(sclera);
    const iris = new THREE.Mesh(irisGeo, irisMat);
    iris.position.z = 0.0122;
    g.add(iris);
    const pupil = new THREE.Mesh(new THREE.CircleGeometry(0.0024, 16), pupilMat);
    pupil.position.z = 0.0126;
    g.add(pupil);
    const lid = new THREE.Mesh(lidGeo, skinMat);
    lid.name = 'lid';
    lid.scale.y = 0.02;
    lid.position.y = 0.0125;
    g.add(lid);
    head.add(g);
    eyes.push(g);
  }

  // Brows.
  const browGeo = capsule(0.0035, 0.030, 6);
  for (const sx of [-1, 1]) {
    const brow = new THREE.Mesh(browGeo, hairMat);
    brow.position.set(sx * 0.034, 0.040, 0.075);
    brow.rotation.set(0, 0, Math.PI / 2 + sx * 0.12);
    head.add(brow);
  }

  // ---- body -------------------------------------------------------------
  const body = new THREE.Group();
  root.add(body);

  const neck = new THREE.Mesh(capsule(0.050, 0.09), skinMat);
  neck.position.set(0, 1.50, -0.004);
  body.add(neck);

  const torso = new THREE.Mesh(capsule(0.150, 0.26, 16), clothMat);
  torso.position.set(0, 1.16, 0);
  torso.scale.set(1.14, 1, 0.62);
  body.add(torso);

  const hips = new THREE.Mesh(capsule(0.132, 0.12, 12), clothMat);
  hips.position.set(0, 0.93, 0);
  hips.scale.set(1.05, 1, 0.72);
  body.add(hips);

  const shoulders = new THREE.Mesh(capsule(0.088, 0.28, 14), clothMat);
  shoulders.position.set(0, 1.38, 0);
  shoulders.rotation.z = Math.PI / 2;
  shoulders.scale.set(1, 1, 0.75);
  body.add(shoulders);

  for (const sx of [-1, 1]) {
    const upper = new THREE.Mesh(capsule(0.050, 0.24), clothMat);
    upper.position.set(sx * 0.195, 1.20, 0.01);
    upper.rotation.z = sx * 0.09;
    body.add(upper);

    // Overlap the sleeve and the forearm so the join is not a visible seam.
    const fore = new THREE.Mesh(capsule(0.042, 0.24), skinMat);
    fore.position.set(sx * 0.225, 0.955, 0.02);
    fore.rotation.z = sx * 0.05;
    body.add(fore);

    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), skinMat);
    hand.position.set(sx * 0.238, 0.81, 0.02);
    hand.scale.set(0.7, 1.15, 0.42);
    body.add(hand);

    const thigh = new THREE.Mesh(capsule(0.078, 0.34), clothMat);
    thigh.position.set(sx * 0.088, 0.67, 0);
    body.add(thigh);

    const shin = new THREE.Mesh(capsule(0.055, 0.34), clothMat);
    shin.position.set(sx * 0.085, 0.28, 0);
    body.add(shin);

    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.055, 0.24), clothMat);
    foot.position.set(sx * 0.085, 0.028, 0.05);
    body.add(foot);
  }

  // ---- the dive target ---------------------------------------------------
  // Upper cheek, just lateral to the nose and below the eye — bare skin, above
  // the beard line. Its normal is about 40 degrees off the view axis, which is
  // exactly the raking angle that makes pores and microrelief read.
  const cheekLocal = new THREE.Vector3(-0.048, 0.002, 0.071);
  const cheekPoint = cheekLocal.clone().add(head.position);
  const cheekNormal = new THREE.Vector3(-0.62, 0.05, 0.78).normalize();

  // ---- motion ------------------------------------------------------------
  const lids = eyes.map((g) => g.getObjectByName('lid') as THREE.Mesh);
  let nextBlink = 2.5;
  let blinkT = -1;

  const baseTorsoY = torso.position.y;
  const baseShoulderY = shoulders.position.y;
  const swayPhase = rng() * 6.28;

  function update(t: number): void {
    // Quiet breathing, about 14 breaths per minute.
    const breath = Math.sin(t * 2 * Math.PI * (14 / 60));
    torso.scale.z = 0.66 * (1 + breath * 0.022);
    torso.scale.x = 1.12 * (1 + breath * 0.012);
    torso.position.y = baseTorsoY + breath * 0.004;
    shoulders.position.y = baseShoulderY + breath * 0.006;

    // Micro sway: a standing person is never still.
    const sway = Math.sin(t * 0.37 + swayPhase) * 0.006 + Math.sin(t * 0.83) * 0.003;
    root.rotation.z = sway * 0.35;
    root.position.x = sway * 0.9;
    head.rotation.y = Math.sin(t * 0.29 + 1.1) * 0.035;
    head.rotation.x = Math.sin(t * 0.23) * 0.02;

    // Blink: ~130 ms, at irregular intervals.
    if (blinkT < 0 && t > nextBlink) {
      blinkT = 0;
      nextBlink = t + 2.2 + rng() * 4.5;
    }
    if (blinkT >= 0) {
      blinkT += 1 / 60;
      const p = Math.min(1, blinkT / 0.13);
      const closed = Math.sin(p * Math.PI);
      for (const lid of lids) {
        lid.scale.y = 0.02 + closed * 0.98;
        lid.position.y = 0.012 - closed * 0.012;
      }
      if (p >= 1) blinkT = -1;
    }
  }

  function dispose(): void {
    headGeo.dispose();
    earGeo.dispose();
    scleraGeo.dispose();
    irisGeo.dispose();
    lidGeo.dispose();
    browGeo.dispose();
    skinMat.dispose();
    headMat.dispose();
    hairMat.dispose();
    clothMat.dispose();
    scleraMat.dispose();
    irisMat.dispose();
    pupilMat.dispose();
  }

  void SKIN_DEEP;
  return { root, head, cheekPoint, cheekNormal, update, dispose };
}

/**
 * Swaps in a real head model if one has been dropped into `public/models/`.
 *
 * Nothing is bundled — the fetch simply fails silently if the file is absent,
 * and the procedural head stays. To use a real one, download a CC0 head, export
 * it as `head.glb`, and put it at `public/models/head.glb`. Good sources:
 *
 *   - MakeHuman (makehumancommunity.org) — free, and models it generates are
 *     CC0. It can produce a bearded 35-year-old male directly and export glTF.
 *     This is the closest fit to what this scene needs.
 *   - Blender Studio "Human Base Meshes" (studio.blender.org) — CC0, clean
 *     topology, no likeness but a proper anatomical base to sculpt on.
 *   - Sketchfab filtered to CC0 + "head scan" — quality varies a lot, check the
 *     licence on each individual model rather than trusting the search filter.
 *
 * The model should be roughly 0.23 m tall, Y-up, facing +Z, origin at the
 * centre of the skull.
 */
export async function loadHeadModel(url: string): Promise<THREE.Object3D | null> {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) return null;
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    return gltf.scene;
  } catch {
    return null;
  }
}
