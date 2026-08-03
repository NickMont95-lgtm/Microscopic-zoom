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
} from './common.ts';

/**
 * BAND 6 — Inside a keratinocyte (10 µm → 1 µm across the screen)
 *
 * The camera crosses the plasma membrane into a living keratinocyte of the
 * follicular epithelium. That location matters: the cells at the skin SURFACE
 * are corneocytes, which are dead, anucleate and have no organelles at all — a
 * nucleus and mitochondria could not honestly be shown up there. Deeper in the
 * infundibulum the lining is living epithelium, and that is where we are.
 *
 * Real dimensions:
 *   - the cell is ~30 µm across, so at 10 µm of screen we are well inside it
 *   - nucleus ~6 µm, filling most of the frame at the top of the band
 *   - mitochondria 0.5–1 µm long
 *   - rough ER as perinuclear sheets, Golgi as a stack of flattened cisternae
 *   - keratin intermediate filaments, the tonofilament bundles that give a
 *     keratinocyte its name, running to desmosomes at the cell margin
 *
 * Everything drifts: cytoplasm streams, the nuclear envelope flexes, and
 * mitochondria move along the cytoskeleton.
 */

const METRES_PER_UNIT = Math.pow(10, -5) / 60; // ≈ 167 nm per local unit
const L = 1 / METRES_PER_UNIT;
const U = (m: number) => m * L; // metres → local units

export function makeCellBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;
  const rng = makeRng(6060);

  const rail = makeRail([
    { p: [0, 0, U(8e-6)] },
    { p: [U(0.6e-6), U(0.3e-6), U(2.4e-6)], roll: 0.02 },
    { p: [U(0.2e-6), U(0.1e-6), U(0.2e-6)], roll: 0.03 },
    { p: [0, 0, U(-1.2e-6)] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    fogFactor: 0.26,
    keyColor: 0xdff0ff,
    fillColor: 0x8fd9c8,
    rimColor: 0xa8c4ff,
    keyPower: 5.2,
    fillPower: 2.1,
    rimPower: 2.4,
    keyOffset: [0.9, 0.9, 0.6],
    fillOffset: [-1.0, -0.6, 0.5],
    rimOffset: [-0.2, 0.4, -1.2],
    hemiSky: 0x2c4a52,
    hemiGround: 0x0a1014,
    hemiPower: 0.9,
  });
  const { scene } = sc;

  // ---- plasma membrane ---------------------------------------------------
  // A translucent sheet the camera passes through in the first part of the
  // band. Drawn as a large disc so it reads as a wall, not an object.
  const memGeo = new THREE.SphereGeometry(U(15e-6), 48, 32);
  // Plain transparency rather than MeshPhysicalMaterial transmission.
  // Transmission makes three.js render the whole scene an extra time into a
  // back buffer every frame, per material that uses it. Across bands 4-8 that
  // was several full extra passes for droplets and membranes whose refraction
  // nobody can see through an already-translucent stack.
  const memMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x7fd4c0).convertSRGBToLinear(),
    roughness: 0.25,
    transparent: true,
    opacity: 0.4,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const membrane = new THREE.Mesh(memGeo, memMat);
  membrane.position.set(0, 0, U(-2e-6));
  scene.add(membrane);

  // ---- nucleus -----------------------------------------------------------
  const nucleusGroup = new THREE.Group();
  nucleusGroup.position.set(U(-0.4e-6), U(0.2e-6), U(-4.6e-6));
  scene.add(nucleusGroup);

  const NUC_R = U(3.0e-6); // 6 µm across
  const nucGeo = new THREE.SphereGeometry(NUC_R, detail(quality, 72, 28), detail(quality, 48, 20));
  const nucMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x8b7fd0).convertSRGBToLinear(),
    roughness: 0.42,
    transparent: true,
    opacity: 0.8,
  });
  const nucleus = new THREE.Mesh(nucGeo, nucMat);
  nucleusGroup.add(nucleus);

  // Nuclear pore complexes: ~120 nm across, a few thousand per nucleus. Drawn
  // as rings studding the envelope.
  const poreGeo = new THREE.TorusGeometry(U(55e-9), U(14e-9), 5, 12);
  const poreMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xa294d8).convertSRGBToLinear(),
    roughness: 0.5,
  });
  const PORES = count(quality, 280, 50);
  const pores = new THREE.InstancedMesh(poreGeo, poreMat, PORES);
  fillInstances(pores, (_i, d) => {
    const v = randomOnSphere(rng);
    d.position.copy(v).multiplyScalar(NUC_R * 1.005);
    d.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v);
  });
  nucleusGroup.add(pores);

  // Chromatin showing through the envelope, denser at the periphery
  // (heterochromatin) than in the middle.
  const chromGeo = new THREE.IcosahedronGeometry(U(90e-9), 1);
  const chromMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xb9a6ff).convertSRGBToLinear(),
    roughness: 0.55,
    emissive: new THREE.Color(0x241c4a).convertSRGBToLinear(),
    transparent: true,
    opacity: 0.75,
  });
  const CHROM = count(quality, 900, 120);
  const chrom = new THREE.InstancedMesh(chromGeo, chromMat, CHROM);
  const chromMotion = applyGpuMotion(chromMat, { drift: U(30e-9), driftRate: 0.5 });
  fillInstances(chrom, (_i, d) => {
    const v = randomOnSphere(rng);
    // Bias outward: heterochromatin hugs the nuclear lamina.
    const r = NUC_R * (0.35 + 0.62 * Math.pow(rng(), 0.35));
    d.position.copy(v).multiplyScalar(r);
    d.scale.setScalar(0.6 + rng() * 1.2);
  });
  nucleusGroup.add(chrom);

  // Nucleolus: a dense body ~1.5 µm across where ribosomes are assembled.
  const nucleolus = new THREE.Mesh(
    new THREE.IcosahedronGeometry(U(0.75e-6), 3),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x3f3378).convertSRGBToLinear(),
      roughness: 0.75,
    }),
  );
  nucleolus.position.set(U(0.7e-6), U(-0.5e-6), U(0.4e-6));
  nucleusGroup.add(nucleolus);

  // ---- mitochondria ------------------------------------------------------
  const mitoGeo = makeMitochondrionGeometry(quality.detailScale);
  const mitoMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xe07a5f).convertSRGBToLinear(),
    roughness: 0.45,
    metalness: 0,
  });
  const MITO = count(quality, 46, 10);
  const mitos = new THREE.InstancedMesh(mitoGeo, mitoMat, MITO);
  const mitoMotion = applyGpuMotion(mitoMat, { drift: U(120e-9), driftRate: 0.35, spin: 0.05 });
  fillInstances(mitos, (_i, d) => {
    d.position.set(
      (rng() - 0.5) * U(11e-6),
      (rng() - 0.5) * U(8e-6),
      -rng() * U(9e-6),
    );
    d.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    // 0.5–1 µm long, ~0.35 µm across.
    d.scale.set(U(0.18e-6), U(0.18e-6), U(0.28e-6 + rng() * 0.28e-6));
  });
  scene.add(mitos);

  // ---- rough endoplasmic reticulum ---------------------------------------
  // Flattened perinuclear sheets, studded with ribosomes on the cytosolic face.
  const erMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x7fb2a8).convertSRGBToLinear(),
    roughness: 0.5,
    transparent: true,
    opacity: 0.34,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const erGroup = new THREE.Group();
  erGroup.position.copy(nucleusGroup.position);
  scene.add(erGroup);
  const erSheets: THREE.Mesh[] = [];
  const SHEETS = count(quality, 9, 3);
  for (let i = 0; i < SHEETS; i++) {
    const geo = makeErSheetGeometry(NUC_R * (1.12 + rng() * 0.28), detail(quality, 40, 14), rng);
    const m = new THREE.Mesh(geo, erMat);
    m.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    erGroup.add(m);
    erSheets.push(m);
  }

  // Ribosomes on the ER. At 25 nm these are sub-pixel until the very bottom of
  // the band, but they are what makes rough ER rough.
  const riboGeo = new THREE.IcosahedronGeometry(U(12e-9), 0);
  const riboMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x2f4f4a).convertSRGBToLinear(),
    roughness: 0.8,
  });
  const RIBOS = count(quality, 2600, 300);
  const ribos = new THREE.InstancedMesh(riboGeo, riboMat, RIBOS);
  fillInstances(ribos, (_i, d) => {
    const v = randomOnSphere(rng);
    d.position.copy(v).multiplyScalar(NUC_R * (1.12 + rng() * 0.28));
    d.scale.setScalar(0.7 + rng() * 0.7);
  });
  erGroup.add(ribos);

  // ---- Golgi -------------------------------------------------------------
  // A stack of flattened cisternae, progressively larger cis to trans.
  const golgi = new THREE.Group();
  golgi.position.set(U(2.6e-6), U(-1.6e-6), U(-3.4e-6));
  golgi.rotation.set(0.5, 0.8, 0.2);
  const golgiMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xd9b45c).convertSRGBToLinear(),
    roughness: 0.5,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
  });
  const cisternGeo = new THREE.CylinderGeometry(1, 1, 1, detail(quality, 28, 10), 1, true);
  for (let i = 0; i < 6; i++) {
    const c = new THREE.Mesh(cisternGeo, golgiMat);
    const s = U((0.55 + i * 0.09) * 1e-6);
    c.scale.set(s, U(40e-9), s * 0.72);
    c.position.y = U((i - 2.5) * 0.13e-6);
    c.rotation.z = (rng() - 0.5) * 0.12;
    golgi.add(c);
  }
  scene.add(golgi);

  // ---- keratin intermediate filaments ------------------------------------
  // Tonofilament bundles — 10 nm filaments in bundles tens of nm thick, running
  // across the cytoplasm to desmosomes. The defining feature of a keratinocyte.
  const kifGeo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
  const kifMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x9fb6c9).convertSRGBToLinear(),
    roughness: 0.55,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const KIF = count(quality, 220, 40);
  const kifs = new THREE.InstancedMesh(kifGeo, kifMat, KIF);
  {
    const up = new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const dir = new THREE.Vector3();
    fillInstances(kifs, (_i, d) => {
      a.set((rng() - 0.5) * U(12e-6), (rng() - 0.5) * U(9e-6), -rng() * U(10e-6));
      b.set((rng() - 0.5) * U(12e-6), (rng() - 0.5) * U(9e-6), -rng() * U(10e-6));
      dir.copy(b).sub(a);
      const len = dir.length();
      d.position.copy(a).addScaledVector(dir, 0.5);
      d.quaternion.setFromUnitVectors(up, dir.normalize());
      d.scale.set(U(22e-9), len, U(22e-9));
    });
  }
  scene.add(kifs);

  const cytoDrift = new THREE.Vector3();

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    const t = frame.elapsed;
    chromMotion.uniforms.uTime.value = t;
    mitoMotion.uniforms.uTime.value = t;

    // Cytoplasmic streaming: the whole contents circulate slowly.
    cytoDrift.set(Math.sin(t * 0.11) * U(0.25e-6), Math.cos(t * 0.09) * U(0.2e-6), 0);
    nucleusGroup.position.x = U(-0.4e-6) + cytoDrift.x;
    nucleusGroup.position.y = U(0.2e-6) + cytoDrift.y;
    erGroup.position.copy(nucleusGroup.position);
    nucleusGroup.rotation.y = t * 0.02;
    erGroup.rotation.y = t * 0.015;

    // The nuclear envelope flexes.
    const flex = 1 + 0.012 * Math.sin(t * 0.6);
    nucleus.scale.set(flex, 1 / flex, flex);

    golgi.position.x = U(2.6e-6) + cytoDrift.x * 0.7;
    golgi.rotation.z = Math.sin(t * 0.13) * 0.08;

    for (let i = 0; i < erSheets.length; i++) {
      erSheets[i].rotation.z += frame.dt * 0.01 * (i % 2 ? 1 : -1);
    }

    // The membrane recedes past the camera during the first part of the band.
    memMat.opacity = 0.5 * Math.max(0, 1 - frame.u * 2.2);
    membrane.visible = memMat.opacity > 0.01;
  }

  function dispose(): void {
    memGeo.dispose();
    memMat.dispose();
    nucGeo.dispose();
    nucMat.dispose();
    poreGeo.dispose();
    poreMat.dispose();
    chromGeo.dispose();
    chromMat.dispose();
    mitoGeo.dispose();
    mitoMat.dispose();
    erMat.dispose();
    riboGeo.dispose();
    riboMat.dispose();
    cisternGeo.dispose();
    golgiMat.dispose();
    kifGeo.dispose();
    kifMat.dispose();
    for (const m of erSheets) m.geometry.dispose();
    disposeScene(scene);
  }

  return {
    scene,
    camera: sc.camera,
    rail,
    background: sc.background,
    fogFactor: 0.26,
    update,
    dispose,
  };
}

function randomOnSphere(rng: () => number): THREE.Vector3 {
  const u = rng() * 2 - 1;
  const a = rng() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(a), s * Math.sin(a), u);
}

/**
 * A mitochondrion: a capsule with a visibly separate outer membrane. Cristae
 * live at 20–50 nm and are band 7's problem; here the silhouette is the point.
 */
function makeMitochondrionGeometry(detailScale: number): THREE.BufferGeometry {
  const seg = Math.max(6, Math.round(16 * detailScale));
  const geo = new THREE.CapsuleGeometry(1, 1.8, seg, seg * 2);
  geo.rotateX(Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Gentle waisting, so they are not perfect pills.
    const s = 1 + 0.12 * Math.sin(v.z * 2.2);
    pos.setXYZ(i, v.x * s, v.y * s, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** A folded ER cisterna: a perturbed spherical shell segment. */
function makeErSheetGeometry(
  radius: number,
  seg: number,
  rng: () => number,
): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(radius, seg, Math.max(6, seg >> 1), 0, Math.PI * 0.8, 0.4, 0.9);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const j = rng() * 10;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const f = 1 + 0.07 * Math.sin(v.x * 9 / radius + j) * Math.cos(v.y * 7 / radius + j);
    pos.setXYZ(i, v.x * f, v.y * f, v.z * f);
  }
  geo.computeVertexNormals();
  return geo;
}
