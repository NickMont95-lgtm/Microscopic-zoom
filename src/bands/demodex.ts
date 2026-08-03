import * as THREE from 'three';
import { makeRng } from './common.ts';

/**
 * Demodex folliculorum.
 *
 * Anatomy, because getting this wrong is exactly the sort of thing a clinician
 * notices:
 *
 *  - Total length 0.3–0.4 mm; body width about 40 µm. (D. brevis, which lives
 *    in the sebaceous gland rather than the follicle, is roughly half as long.)
 *  - The body is in three parts. Anterior is the GNATHOSOMA — the mouthparts,
 *    a short trapezoidal capitulum with paired palps. Behind it the PODOSOMA,
 *    a stubby segment carrying FOUR PAIRS OF LEGS — eight legs, all crowded
 *    onto the anterior third of the animal, each very short, three-segmented,
 *    ending in claws. Behind that the OPISTHOSOMA: a long, tapering, finely
 *    annulated tail that makes up over half the total length and has no
 *    appendages at all.
 *  - They live head-down in the follicular infundibulum, gnathosoma pointing
 *    into the depth, usually several to a follicle and often clustered around
 *    the hair shaft. They feed on sebum and follicular epithelium.
 *  - The cuticle is semi-transparent and colourless; they look pale grey-cream
 *    under a microscope, not brown.
 *
 * Built along local +Z, anterior (head) at +Z, so "head-down" is a rotation
 * that points +Z into the follicle.
 */

// Radial segments around the body. Twelve read as a faceted tube at the top
// of band 4, where the animal spans most of the frame.
const RADIAL = 40;

/** Radius profile along the body, t = 0 at the tail tip, 1 at the mouthparts. */
function bodyRadius(t: number): number {
  // Opisthosoma: long taper from a rounded tail up to the podosoma.
  if (t < 0.58) {
    const u = t / 0.58;
    // Closes to a point at the tail. Starting at a finite radius left the tube
    // open at the posterior end, and at higher resolution you could see straight
    // down the inside of the animal.
    const taper = Math.min(1, u / 0.06);
    return (0.16 + 0.34 * Math.pow(u, 0.45)) * taper;
  }
  // Podosoma: the widest part, where the legs attach.
  if (t < 0.86) {
    const u = (t - 0.58) / 0.28;
    return 0.50 + 0.05 * Math.sin(u * Math.PI);
  }
  // Gnathosoma: narrows to the mouthparts.
  const u = (t - 0.86) / 0.14;
  return 0.50 - 0.44 * u * u;
}

function buildBodyGeometry(segments: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let r = bodyRadius(t);

    // Transverse annulation of the opisthosoma. Fine cuticular striations,
    // roughly 40 across the tail, and absent on the podosoma.
    if (t < 0.60) {
      // Cuticular striations. The count is deliberately low relative to the
      // segment count: at 40 rings over this many segments the annulation
      // aliased into a stack of visibly separate hoops rather than reading as
      // fine surface texture.
      r *= 1 + 0.042 * Math.sin(t * 26 * Math.PI * 2);
    }

    // Slightly flattened dorsoventrally, as the real animal is.
    for (let j = 0; j <= RADIAL; j++) {
      const a = (j / RADIAL) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r * 0.82;
      pos.push(x, y, t);
      const n = new THREE.Vector3(x, y / 0.82, 0).normalize();
      nor.push(n.x, n.y, 0);
    }
  }

  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < RADIAL; j++) {
      const a = i * (RADIAL + 1) + j;
      const b = a + RADIAL + 1;
      // Winding order matters: (a, b, a+1) makes the surface normal point
      // INWARD, so three.js culls every outward-facing triangle and you see
      // straight through the animal to the inside of its far wall. It reads as
      // a stack of hoops rather than a body. Wound the other way round, the
      // normals face out and the tube is solid.
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }

  // Cap both ends.
  //
  // A swept tube is open at t=0 and t=1. The anterior end has a finite radius
  // where the gnathosoma attaches, so without a cap you can see straight down
  // the inside of the animal — which at any decent resolution reads as a stack
  // of hoops rather than as a body. Two triangle fans close it.
  const ringVerts = RADIAL + 1;
  for (const end of [0, segments]) {
    const centreIndex = pos.length / 3;
    const t = end / segments;
    pos.push(0, 0, t);
    nor.push(0, 0, end === 0 ? -1 : 1);
    for (let j = 0; j < RADIAL; j++) {
      const a = end * ringVerts + j;
      const b = end * ringVerts + j + 1;
      if (end === 0) idx.push(centreIndex, b, a);
      else idx.push(centreIndex, a, b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export interface Mite {
  root: THREE.Group;
  /** Drives the leg cycle and body flex. `speed` 0 means stationary. */
  update(t: number, speed: number): void;
}

export interface MiteOptions {
  /** Body length in local units. */
  length: number;
  color?: number;
  seed?: number;
  detail?: number;
}

/**
 * One mite. Returns a group scaled so the body runs from z = 0 (tail) to
 * z = length (mouthparts).
 */
export function buildMite(opts: MiteOptions): Mite {
  const rng = makeRng(opts.seed ?? 5);
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(opts.color ?? 0xd8cfc0).convertSRGBToLinear(),
    roughness: 0.42,
    metalness: 0,
    // Opaque. The cuticle is genuinely translucent, but a semi-transparent
    // closed tube sorts against its own far wall and reads as hollow, which is
    // a far worse error than losing a little translucency.
  });

  const bodyGeo = buildBodyGeometry(Math.max(64, Math.round(280 * (opts.detail ?? 1))));
  const body = new THREE.Mesh(bodyGeo, mat);
  body.scale.set(opts.length * 0.115, opts.length * 0.115, opts.length);
  bodyGroup.add(body);

  // ---- gnathosoma --------------------------------------------------------
  // Short trapezoidal capitulum with a pair of palps, at the anterior tip.
  const gnGeo = new THREE.CylinderGeometry(0.36, 0.52, 1, 24);
  gnGeo.rotateX(Math.PI / 2);
  const gnatho = new THREE.Mesh(gnGeo, mat);
  gnatho.position.z = opts.length * 1.005;
  gnatho.scale.set(opts.length * 0.058, opts.length * 0.048, opts.length * 0.042);
  bodyGroup.add(gnatho);

  const palpGeo = new THREE.CapsuleGeometry(0.3, 1.0, 6, 16);
  palpGeo.rotateX(Math.PI / 2);
  const palps: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const palp = new THREE.Mesh(palpGeo, mat);
    palp.position.set(sx * opts.length * 0.024, -opts.length * 0.010, opts.length * 1.028);
    palp.scale.setScalar(opts.length * 0.021);
    bodyGroup.add(palp);
    palps.push(palp);
  }

  // ---- legs --------------------------------------------------------------
  // FOUR PAIRS, all on the podosoma — the anterior third. Each is short,
  // three-segmented and ends in a claw. They project laterally and ventrally.
  const legGroups: { pivot: THREE.Group; phase: number; side: number }[] = [];
  const coxaGeo = new THREE.CapsuleGeometry(0.32, 0.5, 6, 16);
  const femurGeo = new THREE.CapsuleGeometry(0.26, 0.6, 6, 16);
  const tarsusGeo = new THREE.CapsuleGeometry(0.19, 0.5, 6, 14);
  const clawGeo = new THREE.ConeGeometry(0.16, 0.45, 14);

  const LEG_Z = [0.635, 0.705, 0.775, 0.845]; // fractions of body length
  for (let pair = 0; pair < 4; pair++) {
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(
        sx * opts.length * 0.048,
        -opts.length * 0.022,
        opts.length * LEG_Z[pair],
      );
      // Legs splay outward and downward.
      pivot.rotation.z = sx * -0.85;
      pivot.rotation.x = 0.35;

      const scale = opts.length * 0.030;
      const coxa = new THREE.Mesh(coxaGeo, mat);
      coxa.position.y = -scale * 0.55;
      coxa.scale.setScalar(scale);
      pivot.add(coxa);

      const knee = new THREE.Group();
      knee.position.y = -scale * 1.1;
      knee.rotation.x = -0.7;
      pivot.add(knee);

      const femur = new THREE.Mesh(femurGeo, mat);
      femur.position.y = -scale * 0.6;
      femur.scale.setScalar(scale * 0.92);
      knee.add(femur);

      const ankle = new THREE.Group();
      ankle.position.y = -scale * 1.15;
      ankle.rotation.x = -0.5;
      knee.add(ankle);

      const tarsus = new THREE.Mesh(tarsusGeo, mat);
      tarsus.position.y = -scale * 0.45;
      tarsus.scale.setScalar(scale * 0.8);
      ankle.add(tarsus);

      const claw = new THREE.Mesh(clawGeo, mat);
      claw.position.y = -scale * 0.85;
      claw.rotation.z = Math.PI;
      claw.scale.setScalar(scale * 0.7);
      ankle.add(claw);

      bodyGroup.add(pivot);
      // Diagonal gait: opposite sides of adjacent pairs move together.
      legGroups.push({ pivot, phase: pair * 1.3 + (sx > 0 ? Math.PI : 0), side: sx });
    }
  }

  const baseRotZ = legGroups.map((l) => l.pivot.rotation.z);
  const baseRotX = legGroups.map((l) => l.pivot.rotation.x);
  const wobblePhase = rng() * Math.PI * 2;

  function update(t: number, speed: number): void {
    for (let i = 0; i < legGroups.length; i++) {
      const l = legGroups[i];
      // A stepping cycle: swing forward fast, drag back slowly.
      const a = t * 2.6 * Math.max(0.15, speed) + l.phase;
      const swing = Math.sin(a);
      const lift = Math.max(0, Math.cos(a));
      l.pivot.rotation.z = baseRotZ[i] + swing * 0.22 * speed - lift * 0.10 * speed;
      l.pivot.rotation.x = baseRotX[i] + swing * 0.30 * speed;
    }
    // The opisthosoma flexes slowly even when the animal is not walking.
    bodyGroup.rotation.z = Math.sin(t * 0.5 + wobblePhase) * 0.05;
    bodyGroup.rotation.x = Math.sin(t * 0.37 + wobblePhase * 1.7) * 0.04;
    for (const p of palps) {
      p.rotation.x = Math.sin(t * 3.1 + wobblePhase) * 0.25 * Math.max(0.2, speed);
    }
  }

  update(0, 0);
  return { root, update };
}
