import * as THREE from 'three';
import type { BandContext, BandFrame, BandInstance } from '../core/types.ts';
import {
  applyGpuMotion,
  count,
  detail,
  disposeScene,
  fillInstances,
  makeRail,
  makeRng,
  makeScaffold,
  subdiv,
  type MotionHandle,
} from './common.ts';

/**
 * BAND 5 — Skin microbiome (89 µm → 6.3 µm across the screen)
 *
 * Still inside the follicle, now down on the wall. This is where the skin's
 * bacteria actually live in quantity: Cutibacterium acnes is a follicular
 * organism, anaerobic and lipophilic, and the infundibulum is its habitat.
 *
 *   - C. acnes: rods about 0.5 × 1–1.5 µm, often slightly club-shaped or
 *     branched (it is a diphtheroid), lying in the sebum.
 *   - Staphylococcus epidermidis: cocci about 0.8–1 µm, in irregular
 *     grape-like clusters, never in chains.
 *   - Both are embedded in biofilm — extracellular polymeric substance drawn
 *     here as fine strands bridging cells and surface.
 *
 * Order of magnitude: roughly a million organisms per square centimetre of
 * skin, far more inside a follicle.
 *
 * Motion is Brownian jitter plus tumbling, done on the GPU. At 1 µm, thermal
 * motion is the dominant thing that happens to you: these cells are being
 * visibly kicked around by water molecules the whole time.
 */

const METRES_PER_UNIT = Math.pow(10, -4.05) / 60; // ≈ 1.49 µm per local unit
const L = 1 / METRES_PER_UNIT;

export function makeMicrobiomeBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;
  const rng = makeRng(5150);

  const rail = makeRail([
    { p: [0, 0, 60e-6 * L] },
    { p: [4e-6 * L, 2e-6 * L, 24e-6 * L], roll: 0.02 },
    { p: [1.5e-6 * L, 0.5e-6 * L, 5e-6 * L], roll: 0.04 },
    { p: [0, 0, 0] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    fogFactor: 0.20,
    keyColor: 0xffeede,
    fillColor: 0xffc9a4,
    rimColor: 0x9fd0ff,
    keyPower: 6.5,
    fillPower: 2.0,
    rimPower: 2.6,
    keyOffset: [1.1, 1.0, 0.55],
    fillOffset: [-1.0, -0.7, 0.4],
    rimOffset: [-0.3, 0.5, -1.1],
    hemiSky: 0x4d3a34,
    hemiGround: 0x0e0a0a,
    hemiPower: 0.85,
  });
  const { scene } = sc;

  // ---- the follicle wall -------------------------------------------------
  // Overlapping keratinocyte shingles. Toward the top of the band these read as
  // the same corneocyte plates band 3 showed; the camera lands on one.
  const wall = new THREE.Group();
  wall.position.set(0, 0, -22e-6 * L);
  scene.add(wall);

  const plateGeo = makeShingleGeometry(detail(quality, 5, 2));
  const plateMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xd6b49c).convertSRGBToLinear(),
    roughness: 0.66,
    metalness: 0,
  });
  const PLATES = count(quality, 320, 60);
  const plates = new THREE.InstancedMesh(plateGeo, plateMat, PLATES);
  fillInstances(plates, (i, d) => {
    // A loose hexagonal packing with jitter, so the shingles interlock.
    const cols = Math.ceil(Math.sqrt(PLATES));
    const gx = i % cols;
    const gy = Math.floor(i / cols);
    const pitch = 9e-6 * L;
    d.position.set(
      (gx - cols / 2 + (gy % 2) * 0.5) * pitch + (rng() - 0.5) * pitch * 0.35,
      (gy - cols / 2) * pitch * 0.88 + (rng() - 0.5) * pitch * 0.3,
      (rng() - 0.35) * 1.2e-6 * L,
    );
    d.rotation.set((rng() - 0.5) * 0.25, (rng() - 0.5) * 0.25, rng() * Math.PI);
    // Wider than the pitch, so neighbours overlap like real shingles instead of
    // leaving the wall showing through between them.
    d.scale.set(
      (10.5e-6 + rng() * 4.0e-6) * L,
      (10.5e-6 + rng() * 4.0e-6) * L,
      (0.5e-6 + rng() * 0.4e-6) * L,
    );
  });
  wall.add(plates);

  // ---- Cutibacterium acnes ------------------------------------------------
  // Rods, capsule-shaped, ~0.5 µm across and 1–1.5 µm long.
  const rodGeo = new THREE.CapsuleGeometry(0.25, 0.85, detail(quality, 7, 3), detail(quality, 22, 9));
  rodGeo.rotateZ(Math.PI / 2);
  const rodMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xcfe0b6).convertSRGBToLinear(),
    roughness: 0.4,
    metalness: 0,
  });
  const rodMotion: MotionHandle = applyGpuMotion(rodMat, {
    drift: 0.09e-6 * L,
    driftRate: 1.5,
    spin: 0.35,
  });
  const RODS = count(quality, 420, 70);
  const rods = new THREE.InstancedMesh(rodGeo, rodMat, RODS);
  fillInstances(rods, (_i, d) => {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * 34e-6;
    d.position.set(
      Math.cos(a) * r * L,
      Math.sin(a) * r * L,
      (-20e-6 + rng() * 3.5e-6) * L,
    );
    d.rotation.set(rng() * 0.7 - 0.35, rng() * 0.7 - 0.35, rng() * Math.PI * 2);
    const len = (1.0e-6 + rng() * 0.6e-6) * L;
    d.scale.set(len, 0.52e-6 * L, 0.52e-6 * L);
  });
  scene.add(rods);

  // ---- Staphylococcus epidermidis ----------------------------------------
  // Cocci ~0.9 µm, in irregular clusters. Built cluster by cluster so they
  // group the way staphylococci actually do rather than scattering evenly.
  const cocGeo = new THREE.IcosahedronGeometry(0.5, subdiv(quality, 2, 1));
  const cocMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xf0d9c4).convertSRGBToLinear(),
    roughness: 0.34,
    metalness: 0,
  });
  const cocMotion = applyGpuMotion(cocMat, {
    drift: 0.07e-6 * L,
    driftRate: 1.9,
    spin: 0.2,
  });
  const CLUSTERS = count(quality, 26, 6);
  const PER_CLUSTER = 9;
  const cocci = new THREE.InstancedMesh(cocGeo, cocMat, CLUSTERS * PER_CLUSTER);
  {
    const centres: THREE.Vector3[] = [];
    for (let c = 0; c < CLUSTERS; c++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * 30e-6;
      centres.push(
        new THREE.Vector3(Math.cos(a) * r * L, Math.sin(a) * r * L, (-20e-6 + rng() * 3e-6) * L),
      );
    }
    fillInstances(cocci, (i, d) => {
      const c = centres[Math.floor(i / PER_CLUSTER)];
      const spread = 1.5e-6 * L;
      d.position.set(
        c.x + (rng() - 0.5) * spread,
        c.y + (rng() - 0.5) * spread,
        c.z + (rng() - 0.5) * spread * 0.6,
      );
      d.scale.setScalar((0.8e-6 + rng() * 0.25e-6) * L);
    });
  }
  scene.add(cocci);

  // ---- a cell caught mid-division ----------------------------------------
  // Binary fission: the septum forms and the cell pinches into two. Modelled as
  // two capsules whose separation is animated.
  const divMat = rodMat;
  const half1 = new THREE.Mesh(rodGeo, divMat);
  const half2 = new THREE.Mesh(rodGeo, divMat);
  const divider = new THREE.Group();
  divider.position.set(-4e-6 * L, 3e-6 * L, -17e-6 * L);
  divider.rotation.set(0.2, 0.4, 0.6);
  const divScale = 0.55e-6 * L;
  for (const h of [half1, half2]) {
    h.scale.set(0.75e-6 * L, divScale, divScale);
    divider.add(h);
  }
  scene.add(divider);

  // ---- biofilm ------------------------------------------------------------
  // Extracellular polymeric substance: fine strands bridging cells and wall.
  const strandGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, detail(quality, 8, 5), 1, true);
  const strandMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xbfd4c8).convertSRGBToLinear(),
    roughness: 0.25,
    metalness: 0,
    transparent: true,
    opacity: 0.34,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const STRANDS = count(quality, 260, 40);
  const strands = new THREE.InstancedMesh(strandGeo, strandMat, STRANDS);
  {
    const up = new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const dir = new THREE.Vector3();
    fillInstances(strands, (_i, d) => {
      const t1 = rng() * Math.PI * 2;
      const r1 = Math.sqrt(rng()) * 30e-6;
      a.set(Math.cos(t1) * r1 * L, Math.sin(t1) * r1 * L, (-20e-6 + rng() * 3e-6) * L);
      b.copy(a).add(
        new THREE.Vector3(
          (rng() - 0.5) * 6e-6 * L,
          (rng() - 0.5) * 6e-6 * L,
          (rng() - 0.2) * 3e-6 * L,
        ),
      );
      dir.copy(b).sub(a);
      const len = dir.length();
      d.position.copy(a).addScaledVector(dir, 0.5);
      d.quaternion.setFromUnitVectors(up, dir.normalize());
      d.scale.set(0.05e-6 * L, len, 0.05e-6 * L);
    });
  }
  scene.add(strands);

  // ---- sebum --------------------------------------------------------------
  const sebGeo = new THREE.IcosahedronGeometry(1, subdiv(quality, 2, 1));
  // Plain transparency rather than MeshPhysicalMaterial transmission.
  // Transmission makes three.js render the whole scene an extra time into a
  // back buffer every frame, per material that uses it. Across bands 4-8 that
  // was several full extra passes for droplets and membranes whose refraction
  // nobody can see through an already-translucent stack.
  const sebMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xf2e2a8).convertSRGBToLinear(),
    roughness: 0.09,
    transparent: true,
    opacity: 0.55,
  });
  const SEB = count(quality, 40, 10);
  const seb = new THREE.InstancedMesh(sebGeo, sebMat, SEB);
  fillInstances(seb, (_i, d) => {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * 28e-6;
    d.position.set(Math.cos(a) * r * L, Math.sin(a) * r * L, (-19e-6 + rng() * 3e-6) * L);
    d.scale.setScalar((0.4e-6 + rng() * 1.6e-6) * L);
  });
  scene.add(seb);

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    const t = frame.elapsed;
    rodMotion.uniforms.uTime.value = t;
    cocMotion.uniforms.uTime.value = t;

    // One cell dividing, on a slow loop: elongate, septate, separate.
    const cycle = (t * 0.055) % 1;
    const sep = cycle < 0.6 ? cycle / 0.6 : 1;
    const gap = sep * 0.85e-6 * L;
    half1.position.x = -gap * 0.5;
    half2.position.x = gap * 0.5;
    const pinch = 1 - 0.35 * Math.sin(Math.min(1, sep * 1.4) * Math.PI);
    half1.scale.y = half2.scale.y = divScale * pinch;
    half1.scale.z = half2.scale.z = divScale * pinch;
    divider.rotation.z += frame.dt * 0.12;
  }

  function dispose(): void {
    plateGeo.dispose();
    plateMat.dispose();
    rodGeo.dispose();
    rodMat.dispose();
    cocGeo.dispose();
    cocMat.dispose();
    strandGeo.dispose();
    strandMat.dispose();
    sebGeo.dispose();
    sebMat.dispose();
    disposeScene(scene);
  }

  return {
    scene,
    camera: sc.camera,
    rail,
    background: sc.background,
    fogFactor: 0.20,
    update,
    dispose,
  };
}

/** A flattened irregular polygon — one keratinocyte of the follicular lining. */
function makeShingleGeometry(subdiv: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 6 + subdiv, 1);
  geo.rotateX(Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const rng = makeRng(17);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const s = 0.86 + rng() * 0.28;
    pos.setXYZ(i, v.x * s, v.y * s, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}
