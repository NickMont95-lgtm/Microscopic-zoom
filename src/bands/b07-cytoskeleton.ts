import * as THREE from 'three';
import type { BandContext, BandFrame, BandInstance } from '../core/types.ts';
import {
  applyGpuMotion,
  detailCapped,
  count,
  detail,
  disposeScene,
  fillInstances,
  makeRail,
  makeRng,
  makeScaffold,
  subdiv,
} from './common.ts';

/**
 * BAND 7 — Cytoskeleton and ribosomes (1.78 µm → 100 nm across the screen)
 *
 * Close in on the cytoplasm, where the individual machines become resolvable.
 *
 *   - Microtubules: 25 nm outer diameter, built from 13 protofilaments of
 *     αβ-tubulin dimers, each dimer 8 nm long. The protofilament ridges are
 *     modelled, because at the bottom of this band they are visible.
 *   - Kinesin-1 walks cargo toward the plus end at roughly 800 nm/s, in 8 nm
 *     steps — one step per tubulin dimer, hand over hand.
 *   - Actin filaments: 7 nm, two protofilaments in a slow right-handed twist,
 *     one crossover every ~36 nm.
 *   - Keratin intermediate filaments: 10 nm, ropelike, no polarity and no
 *     motors — they are structural.
 *   - Ribosomes: ~25 nm, visibly two-part (a large 60S and a small 40S
 *     subunit), free in cytosol and bound to rough ER.
 *   - A mitochondrion with cristae — the folds are 20–50 nm apart, which is
 *     exactly the scale this band resolves.
 */

const METRES_PER_UNIT = Math.pow(10, -5.75) / 60; // ≈ 29.6 nm per local unit
const L = 1 / METRES_PER_UNIT;
const U = (m: number) => m * L;

const MT_RADIUS = 12.5e-9; // 25 nm across
const PROTOFILAMENTS = 13;
const TUBULIN_RISE = 8e-9;

export function makeCytoskeletonBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;
  const rng = makeRng(7070);

  const rail = makeRail([
    { p: [0, 0, U(1.5e-6)] },
    { p: [U(60e-9), U(30e-9), U(0.45e-6)], roll: 0.02 },
    { p: [U(20e-9), U(10e-9), U(60e-9)], roll: 0.04 },
    { p: [0, 0, U(-40e-9)] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    fogFactor: 0.28,
    keyColor: 0xd8ecff,
    fillColor: 0x7fd0c4,
    rimColor: 0xb0b8ff,
    keyPower: 5.0,
    fillPower: 2.2,
    rimPower: 2.5,
    keyOffset: [0.9, 0.9, 0.55],
    fillOffset: [-1.0, -0.6, 0.5],
    rimOffset: [-0.2, 0.5, -1.2],
    hemiSky: 0x24424e,
    hemiGround: 0x080f14,
    hemiPower: 0.85,
  });
  const { scene } = sc;

  // ---- the hero microtubule ----------------------------------------------
  // Runs diagonally through frame; the camera flies alongside it.
  const mtGroup = new THREE.Group();
  mtGroup.rotation.set(0.16, 0.42, 0.1);
  scene.add(mtGroup);

  const mtLength = 3.2e-6;
  // Around ten thousand instances, so each extra segment costs thousands of
  // triangles. Radius 2.2 nm so neighbouring monomers just touch at their 4 nm
  // spacing rather than leaving the protofilament looking like a bead chain.
  const tubulinGeo = new THREE.SphereGeometry(
    U(2.2e-9),
    detailCapped(quality, 10, 5, 16),
    detailCapped(quality, 8, 4, 12),
  );
  const tubulinA = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x6fa8dc).convertSRGBToLinear(),
    roughness: 0.42,
  });
  const tubulinB = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x4b7fb5).convertSRGBToLinear(),
    roughness: 0.42,
  });

  // Alpha and beta tubulin alternate along each protofilament. Two instanced
  // meshes rather than per-instance colour keeps the two subunits visually
  // distinct at any lighting.
  // One ring per MONOMER, not per dimer. TUBULIN_RISE is the 8 nm dimer repeat,
  // and a dimer is two ~4 nm monomers stacked along the protofilament, so the
  // half-rise spacing is correct — removing it left visible gaps between beads
  // where the real lattice is continuous. Not scaled by quality: the count is
  // set by the molecule, not by a preference.
  const ringCount = Math.max(30, Math.round(mtLength / (TUBULIN_RISE / 2)));
  const perMesh = Math.floor((ringCount * PROTOFILAMENTS) / 2);
  const tubA = new THREE.InstancedMesh(tubulinGeo, tubulinA, perMesh);
  const tubB = new THREE.InstancedMesh(tubulinGeo, tubulinB, perMesh);
  {
    let ia = 0;
    let ib = 0;
    const d = new THREE.Object3D();
    for (let r = 0; r < ringCount; r++) {
      const z = (r * TUBULIN_RISE) / 2 - mtLength / 2;
      for (let p = 0; p < PROTOFILAMENTS; p++) {
        // The 13-protofilament lattice has a shallow helical pitch: each turn
        // rises by three monomers, which is why microtubules have a seam.
        const a = (p / PROTOFILAMENTS) * Math.PI * 2 + (r * Math.PI * 2 * 3) / (PROTOFILAMENTS * 2);
        d.position.set(Math.cos(a) * U(MT_RADIUS - 2e-9), Math.sin(a) * U(MT_RADIUS - 2e-9), U(z));
        d.scale.setScalar(1);
        d.updateMatrix();
        if ((r + p) % 2 === 0) {
          if (ia < perMesh) tubA.setMatrixAt(ia++, d.matrix);
        } else if (ib < perMesh) {
          tubB.setMatrixAt(ib++, d.matrix);
        }
      }
    }
    tubA.count = ia;
    tubB.count = ib;
    tubA.instanceMatrix.needsUpdate = true;
    tubB.instanceMatrix.needsUpdate = true;
    tubA.frustumCulled = false;
    tubB.frustumCulled = false;
  }
  mtGroup.add(tubA, tubB);

  // ---- kinesin and its cargo ---------------------------------------------
  // Plain transparency rather than MeshPhysicalMaterial transmission.
  // Transmission makes three.js render the whole scene an extra time into a
  // back buffer every frame, per material that uses it. Across bands 4-8 that
  // was several full extra passes for droplets and membranes whose refraction
  // nobody can see through an already-translucent stack.
  const cargoMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xf0c27a).convertSRGBToLinear(),
    roughness: 0.3,
    transparent: true,
    opacity: 0.92,
  });
  const cargo = new THREE.Mesh(new THREE.IcosahedronGeometry(U(45e-9), subdiv(quality, 3, 2)), cargoMat);
  mtGroup.add(cargo);

  const motorMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xff8a5c).convertSRGBToLinear(),
    roughness: 0.4,
  });
  const motorStalk = new THREE.Mesh(
    new THREE.CylinderGeometry(U(2e-9), U(2e-9), U(40e-9), detail(quality, 10, 6)),
    motorMat,
  );
  mtGroup.add(motorStalk);
  const heads = [0, 1].map(() => {
    const h = new THREE.Mesh(new THREE.SphereGeometry(U(4e-9), detail(quality, 14, 8), detail(quality, 10, 6)), motorMat);
    mtGroup.add(h);
    return h;
  });

  // ---- actin filaments ---------------------------------------------------
  const actinGeo = new THREE.SphereGeometry(U(2.7e-9), detailCapped(quality, 10, 6, 16), detailCapped(quality, 8, 5, 12));
  const actinMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xa8d8a0).convertSRGBToLinear(),
    roughness: 0.5,
  });
  const ACTIN_FILS = count(quality, 7, 2);
  const perFil = 150;
  const actin = new THREE.InstancedMesh(actinGeo, actinMat, ACTIN_FILS * perFil);
  {
    const d = new THREE.Object3D();
    let k = 0;
    for (let f = 0; f < ACTIN_FILS; f++) {
      const origin = new THREE.Vector3(
        (rng() - 0.5) * U(2.4e-6),
        (rng() - 0.5) * U(1.8e-6),
        (rng() - 0.5) * U(2.4e-6),
      );
      const dir = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
      const side = new THREE.Vector3(0, 0, 1).cross(dir).normalize();
      const up = new THREE.Vector3().crossVectors(dir, side);
      for (let i = 0; i < perFil; i++) {
        // Two protofilaments in a slow twist: one crossover every 36 nm.
        const t = i * 2.75e-9;
        const a = (t / 36e-9) * Math.PI * 2 + (i % 2) * Math.PI;
        d.position
          .copy(origin)
          .addScaledVector(dir, U(t))
          .addScaledVector(side, Math.cos(a) * U(1.7e-9))
          .addScaledVector(up, Math.sin(a) * U(1.7e-9));
        d.scale.setScalar(1);
        d.updateMatrix();
        actin.setMatrixAt(k++, d.matrix);
      }
    }
    actin.count = k;
    actin.instanceMatrix.needsUpdate = true;
    actin.frustumCulled = false;
  }
  scene.add(actin);

  // ---- ribosomes ---------------------------------------------------------
  // Two unequal subunits. The large one is roughly twice the small one's mass,
  // and they sit slightly offset rather than concentric.
  const largeGeo = new THREE.IcosahedronGeometry(U(11e-9), subdiv(quality, 1, 1));
  const smallGeo = new THREE.IcosahedronGeometry(U(7.5e-9), subdiv(quality, 1, 1));
  const largeMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x8c6bb1).convertSRGBToLinear(),
    roughness: 0.62,
  });
  const smallMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xb59ad4).convertSRGBToLinear(),
    roughness: 0.62,
  });
  const RIBO = count(quality, 700, 90);
  const riboLarge = new THREE.InstancedMesh(largeGeo, largeMat, RIBO);
  const riboSmall = new THREE.InstancedMesh(smallGeo, smallMat, RIBO);
  const riboMotion = applyGpuMotion(largeMat, { drift: U(12e-9), driftRate: 2.2, spin: 0.5 });
  const riboMotion2 = applyGpuMotion(smallMat, { drift: U(12e-9), driftRate: 2.2, spin: 0.5 });
  {
    const centres: THREE.Vector3[] = [];
    for (let i = 0; i < RIBO; i++) {
      centres.push(
        new THREE.Vector3(
          (rng() - 0.5) * U(3.0e-6),
          (rng() - 0.5) * U(2.2e-6),
          (rng() - 0.5) * U(3.0e-6),
        ),
      );
    }
    fillInstances(riboLarge, (i, d) => d.position.copy(centres[i]));
    fillInstances(riboSmall, (i, d) => {
      d.position.copy(centres[i]).add(new THREE.Vector3(U(9e-9), U(6e-9), 0));
    });
  }
  scene.add(riboLarge, riboSmall);

  // ---- keratin intermediate filaments ------------------------------------
  const kifGeo = new THREE.CylinderGeometry(U(5e-9), U(5e-9), 1, detail(quality, 11, 6), 1, true);
  const kifMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x9fb6c9).convertSRGBToLinear(),
    roughness: 0.6,
    side: THREE.DoubleSide,
  });
  const KIF = count(quality, 60, 12);
  const kifs = new THREE.InstancedMesh(kifGeo, kifMat, KIF);
  {
    const up = new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const dir = new THREE.Vector3();
    fillInstances(kifs, (_i, d) => {
      a.set((rng() - 0.5) * U(3e-6), (rng() - 0.5) * U(2.2e-6), (rng() - 0.5) * U(3e-6));
      b.copy(a).add(
        new THREE.Vector3(
          (rng() - 0.5) * U(2e-6),
          (rng() - 0.5) * U(2e-6),
          (rng() - 0.5) * U(2e-6),
        ),
      );
      dir.copy(b).sub(a);
      const len = dir.length();
      d.position.copy(a).addScaledVector(dir, 0.5);
      d.quaternion.setFromUnitVectors(up, dir.normalize());
      d.scale.set(1, len, 1);
    });
  }
  scene.add(kifs);

  // ---- a mitochondrion, cristae and all ----------------------------------
  const mito = new THREE.Group();
  mito.position.set(U(0.9e-6), U(-0.45e-6), U(-1.1e-6));
  mito.rotation.set(0.3, 0.7, 0.2);
  scene.add(mito);

  const outerMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xe07a5f).convertSRGBToLinear(),
    roughness: 0.4,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
  });
  const outer = new THREE.Mesh(new THREE.CapsuleGeometry(U(180e-9), U(560e-9), detail(quality, 14, 8), detail(quality, 40, 20)), outerMat);
  outer.rotation.z = Math.PI / 2;
  mito.add(outer);

  // Cristae: infoldings of the INNER membrane, 20–50 nm apart. They are where
  // the respiratory chain sits, which is why their surface area matters.
  const cristaMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xc4562f).convertSRGBToLinear(),
    roughness: 0.55,
    side: THREE.DoubleSide,
  });
  const cristaGeo = new THREE.PlaneGeometry(U(300e-9), U(240e-9), detail(quality, 10, 6), detail(quality, 7, 4));
  const CRISTAE = count(quality, 26, 8);
  const cristae = new THREE.InstancedMesh(cristaGeo, cristaMat, CRISTAE);
  fillInstances(cristae, (i, d) => {
    d.position.set(U((i / CRISTAE - 0.5) * 620e-9), 0, 0);
    d.rotation.set(0, Math.PI / 2, (i % 2 ? 0.12 : -0.12));
    d.scale.set(1, 0.75 + 0.3 * Math.sin(i * 1.7), 1);
  });
  mito.add(cristae);

  const dummy = new THREE.Object3D();
  void dummy;

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    const t = frame.elapsed;
    riboMotion.uniforms.uTime.value = t;
    riboMotion2.uniforms.uTime.value = t;

    // Kinesin walks the microtubule at ~800 nm/s in 8 nm steps. The stepping is
    // quantised on purpose: this is a hand-over-hand walk, not a slide.
    const speed = 800e-9;
    const travel = ((t * speed) % (mtLength * 0.8)) - mtLength * 0.4;
    const stepped = Math.floor(travel / TUBULIN_RISE) * TUBULIN_RISE;
    const surface = U(MT_RADIUS + 4e-9);
    cargo.position.set(0, surface + U(52e-9), U(stepped));
    motorStalk.position.set(0, surface + U(22e-9), U(stepped));
    for (let i = 0; i < 2; i++) {
      // The two heads alternate: one bound, one swinging forward.
      const phase = (t * (speed / TUBULIN_RISE) + i * 0.5) % 1;
      const fwd = phase < 0.5 ? 0 : TUBULIN_RISE * 2;
      const lift = phase < 0.5 ? 0 : Math.sin((phase - 0.5) * Math.PI * 2) * 5e-9;
      heads[i].position.set(0, surface + U(lift), U(stepped + fwd - TUBULIN_RISE));
    }

    // The microtubule itself flexes, and the whole cytoplasm streams.
    mtGroup.rotation.z = 0.1 + Math.sin(t * 0.23) * 0.02;
    mtGroup.position.y = Math.sin(t * 0.17) * U(30e-9);
    mito.position.x = U(0.9e-6) + Math.sin(t * 0.13) * U(70e-9);
    mito.rotation.y = 0.7 + Math.sin(t * 0.09) * 0.1;
    // Cristae shift as the inner membrane remodels.
    outer.scale.y = 1 + 0.03 * Math.sin(t * 0.5);
  }

  function dispose(): void {
    tubulinGeo.dispose();
    tubulinA.dispose();
    tubulinB.dispose();
    actinGeo.dispose();
    actinMat.dispose();
    largeGeo.dispose();
    smallGeo.dispose();
    largeMat.dispose();
    smallMat.dispose();
    kifGeo.dispose();
    kifMat.dispose();
    outerMat.dispose();
    cristaGeo.dispose();
    cristaMat.dispose();
    cargoMat.dispose();
    motorMat.dispose();
    disposeScene(scene);
  }

  return {
    scene,
    camera: sc.camera,
    rail,
    background: sc.background,
    fogFactor: 0.28,
    update,
    dispose,
  };
}
