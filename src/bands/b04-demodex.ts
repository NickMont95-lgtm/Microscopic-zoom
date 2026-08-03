import * as THREE from 'three';
import type { BandContext, BandFrame, BandInstance } from '../core/types.ts';
import { disposeScene, makeRail, makeRng, makeScaffold, subdiv } from './common.ts';
import { makeSkinPatch } from './skin.ts';
import { buildMite, type Mite } from './demodex.ts';

/**
 * BAND 4 — Follicle mites (355 µm → 50 µm across the screen)
 *
 * The camera reaches the follicular opening and drops into the infundibulum.
 * Demodex folliculorum live head-down in here, often several to a follicle,
 * clustered around the hair shaft. They are on most adult faces — prevalence
 * approaches 100% by late adulthood — and are usually harmless commensals.
 *
 * At the top of this band a 350 µm mite spans most of the frame; by the bottom
 * we are down among its legs and the follicle wall.
 */

const METRES_PER_UNIT = Math.pow(10, -3.45) / 60; // ≈ 5.91 µm per local unit
const L = 1 / METRES_PER_UNIT;
const TILT = 0.60;

// Real dimensions, in metres.
const MITE_LENGTH = 350e-6;
const FOLLICLE_MOUTH_R = 62e-6;
const FOLLICLE_DEEP_R = 42e-6;
const FOLLICLE_DEPTH = 900e-6;
const HAIR_R = 13e-6; // a vellus hair, not a terminal one

export function makeDemodexBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;

  // Down the follicle axis, which we aligned with the view axis back in band 2.
  const rail = makeRail([
    { p: [0, 0, 40e-6 * L] },
    { p: [3e-6 * L, -2e-6 * L, -30e-6 * L], roll: 0.03 },
    { p: [1e-6 * L, -1e-6 * L, -90e-6 * L], roll: 0.05 },
    { p: [0, 0, -150e-6 * L] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    fogFactor: 0.16,
    keyColor: 0xffeedd,
    fillColor: 0xffd0b0,
    rimColor: 0xbcd4ff,
    keyPower: 18.0,
    fillPower: 4.5,
    rimPower: 4.2,
    keyOffset: [0.9, 1.2, 0.5],
    fillOffset: [-1.0, -0.6, 0.35],
    rimOffset: [-0.2, 0.6, -0.9],
    hemiSky: 0x5c4038,
    hemiGround: 0x120b0a,
    hemiPower: 1.0,
  });
  const { scene } = sc;

  // ---- skin surface around the mouth ------------------------------------
  const skin = makeSkinPatch({
    quality,
    coverage: 4.0,
    centre: [0.0031, -0.0017],
    tilt: TILT,
    color: 0xd3a893,
    roughness: 0.45,
    sebum: 1.0,
  });
  scene.add(skin.group);

  // ---- the infundibulum --------------------------------------------------
  // A funnel narrowing into a tube, lined with the loosely packed keratinocytes
  // that line the follicular opening.
  const follicle = new THREE.Group();
  scene.add(follicle);

  const tubeGeo = makeFollicleGeometry(quality.detailScale);
  const tubeMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xc08a70).convertSRGBToLinear(),
    roughness: 0.72,
    metalness: 0,
    side: THREE.BackSide,
  });
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  tube.scale.set(1, 1, 1);
  follicle.add(tube);

  // The hair shaft running down the middle.
  const hairGeo = new THREE.CylinderGeometry(HAIR_R * L, HAIR_R * 0.85 * L, FOLLICLE_DEPTH * L, 32);
  hairGeo.rotateX(Math.PI / 2);
  const hairMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xa88e72).convertSRGBToLinear(),
    roughness: 0.4,
  });
  const hair = new THREE.Mesh(hairGeo, hairMat);
  hair.position.set(8e-6 * L, -5e-6 * L, -FOLLICLE_DEPTH * 0.4 * L);
  follicle.add(hair);

  // ---- sebum -------------------------------------------------------------
  const rng = makeRng(4404);
  const sebumGeo = new THREE.IcosahedronGeometry(1, subdiv(quality, 3, 1));
  // Plain transparency rather than MeshPhysicalMaterial transmission.
  // Transmission makes three.js render the whole scene an extra time into a
  // back buffer every frame, per material that uses it. Across bands 4-8 that
  // was several full extra passes for droplets and membranes whose refraction
  // nobody can see through an already-translucent stack.
  const sebumMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xf0dc9a).convertSRGBToLinear(),
    roughness: 0.22,
    metalness: 0,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
  const SEBUM_N = Math.max(10, Math.round(48 * quality.instanceScale));
  const sebum = new THREE.InstancedMesh(sebumGeo, sebumMat, SEBUM_N);
  sebum.frustumCulled = false;
  const sebumData: { p: THREE.Vector3; r: number; ph: number }[] = [];
  for (let i = 0; i < SEBUM_N; i++) {
    const a = rng() * Math.PI * 2;
    const rr = (0.35 + rng() * 0.6) * FOLLICLE_MOUTH_R;
    const z = -rng() * FOLLICLE_DEPTH * 0.55;
    sebumData.push({
      p: new THREE.Vector3(Math.cos(a) * rr * L, Math.sin(a) * rr * L, z * L),
      r: (2e-6 + rng() * 5.5e-6) * L,
      ph: rng() * 6.28,
    });
  }
  follicle.add(sebum);

  // ---- mites -------------------------------------------------------------
  // Two head-down in the follicle, tails toward the opening, plus one out on
  // the surface near the rim. That is the normal arrangement.
  const mites: { mite: Mite; speed: number; retract: number; basePos: THREE.Vector3 }[] = [];
  const miteDetail = quality.detailScale;

  function addMite(
    pos: THREE.Vector3,
    euler: THREE.Euler,
    seed: number,
    speed: number,
    retract: number,
  ): void {
    const m = buildMite({
      length: MITE_LENGTH * L,
      seed,
      detail: miteDetail,
      color: 0xd9d0c1,
    });
    m.root.position.copy(pos);
    m.root.rotation.copy(euler);
    scene.add(m.root);
    mites.push({ mite: m, speed, retract, basePos: pos.clone() });
  }

  // Head-down: the body's +Z (anterior) must point down the follicle, i.e. -Z.
  addMite(
    new THREE.Vector3(-14e-6 * L, 6e-6 * L, -20e-6 * L),
    new THREE.Euler(Math.PI * 0.97, 0.10, 0.25),
    11,
    0.35,
    1,
  );
  addMite(
    new THREE.Vector3(16e-6 * L, -12e-6 * L, -55e-6 * L),
    new THREE.Euler(Math.PI * 0.99, -0.14, -0.45),
    23,
    0.2,
    0.6,
  );
  // On the surface, crawling toward the opening.
  addMite(
    new THREE.Vector3(-95e-6 * L, 60e-6 * L, 30e-6 * L),
    new THREE.Euler(Math.PI * 0.5, 0.0, -0.9),
    37,
    1.0,
    0,
  );

  const dummy = new THREE.Object3D();

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    skin.update(frame, sc.camera);

    const t = frame.elapsed;

    for (let i = 0; i < SEBUM_N; i++) {
      const s = sebumData[i];
      dummy.position.set(
        s.p.x + Math.sin(t * 0.4 + s.ph) * 1.5e-6 * L,
        s.p.y + Math.cos(t * 0.33 + s.ph) * 1.5e-6 * L,
        s.p.z,
      );
      dummy.scale.setScalar(s.r * (1 + 0.08 * Math.sin(t * 0.9 + s.ph)));
      dummy.updateMatrix();
      sebum.setMatrixAt(i, dummy.matrix);
    }
    sebum.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < mites.length; i++) {
      const m = mites[i];
      m.mite.update(t, m.speed);
      if (m.retract > 0) {
        // They withdraw deeper when disturbed and ease back out again.
        const cycle = Math.sin(t * 0.23 + i * 2.1);
        const depth = Math.max(0, cycle) * m.retract * 55e-6 * L;
        m.mite.root.position.z = m.basePos.z - depth;
      } else {
        // The surface mite crawls slowly across the skin.
        m.mite.root.position.x = m.basePos.x + Math.sin(t * 0.09) * 30e-6 * L;
        m.mite.root.position.y = m.basePos.y + t * 1.4e-6 * L * 0.6;
      }
    }
  }

  function dispose(): void {
    skin.dispose();
    tubeGeo.dispose();
    tubeMat.dispose();
    hairGeo.dispose();
    hairMat.dispose();
    sebumGeo.dispose();
    sebumMat.dispose();
    disposeScene(scene);
  }

  return {
    scene,
    camera: sc.camera,
    rail,
    background: sc.background,
    fogFactor: 0.16,
    update,
    dispose,
  };
}

/**
 * The follicular canal: a funnel at the surface narrowing into a tube, with the
 * irregular, loosely stacked lining of the infundibulum rather than a smooth
 * pipe.
 */
function makeFollicleGeometry(detailScale: number): THREE.BufferGeometry {
  const rings = Math.max(32, Math.round(170 * detailScale));
  const radial = Math.max(20, Math.round(96 * detailScale));
  const pos: number[] = [];
  const idx: number[] = [];

  // The wall relief must be a SMOOTH FUNCTION OF POSITION, not per-vertex
  // random values. White noise per vertex looks passable at low resolution and
  // shatters into spikes as the mesh gets finer — every added vertex becomes a
  // new independent spike rather than resolving the surface better. A smooth
  // field converges instead: more vertices simply describe the same wall more
  // accurately, which is what raising detail is supposed to do.
  const wall = (a: number, t: number): number =>
    0.86 +
    0.085 * Math.sin(a * 3.0 + t * 9.0) +
    0.06 * Math.sin(a * 7.0 - t * 14.0) +
    0.045 * Math.sin(a * 11.0 + t * 5.0) * Math.cos(a * 2.0 - t * 21.0) +
    0.03 * Math.sin(a * 17.0 + t * 33.0);

  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const z = -t * FOLLICLE_DEPTH;
    // Funnel for the first fifth, then a gently narrowing tube. The mouth is
    // FOLLICLE_MOUTH_R and no wider — an extra flare multiplier here pushes the
    // wall clean out of frame and the shot loses its sense of being inside
    // anything.
    const flare = Math.exp(-t * 11);
    const r = FOLLICLE_DEEP_R + (FOLLICLE_MOUTH_R - FOLLICLE_DEEP_R) * flare;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const rr = r * wall(a, t);
      pos.push(Math.cos(a) * rr * L, Math.sin(a) * rr * L, z * L);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
