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
} from './common.ts';

/**
 * BAND 9 — Chromatin and DNA (45 nm → 1.5 nm across the screen)
 *
 * Through the nuclear pore and into the nucleoplasm: chromatin fibre, then the
 * nucleosomes it is made of, then the duplex itself.
 *
 * B-DNA, to specification:
 *   - 2.0 nm across
 *   - 3.4 nm per complete turn, 10.5 base pairs per turn, 0.34 nm rise per pair
 *   - right-handed
 *   - the two backbones are NOT diametrically opposite. They subtend about 125°
 *     on one side and 235° on the other, which is what produces the minor
 *     groove (~1.2 nm) and the major groove (~2.2 nm). Getting this asymmetry
 *     right is the difference between DNA and a generic twisted ladder — the
 *     major groove is where most sequence-reading proteins bind, precisely
 *     because it is the wide one.
 *
 * Nucleosome: 147 bp wrapped in about 1.65 LEFT-handed superhelical turns
 * around a histone octamer, giving a disc roughly 11 nm across and 5.5 nm
 * thick, with 20–50 bp of linker DNA between neighbours.
 *
 * An RNA polymerase tracks along the duplex, unwinding it as it goes.
 */

const METRES_PER_UNIT = Math.pow(10, -7.35) / 60; // ≈ 0.745 nm per local unit
const L = 1 / METRES_PER_UNIT;
const U = (m: number) => m * L;
const NM = 1e-9;

// B-form parameters.
const HELIX_R = 0.9 * NM; // backbone centre radius; duplex is ~2 nm across
const RISE_PER_BP = 0.34 * NM;
const BP_PER_TURN = 10.5;
const MINOR_GROOVE_ANGLE = (125 * Math.PI) / 180;

export function makeDnaBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;
  const rng = makeRng(9090);

  const rail = makeRail([
    { p: [U(-6 * NM), U(2 * NM), U(30 * NM)] },
    { p: [U(-2 * NM), U(0.6 * NM), U(9 * NM)], roll: 0.03 },
    { p: [U(-0.4 * NM), U(0.1 * NM), U(1.2 * NM)], roll: 0.05 },
    { p: [0, 0, U(-0.5 * NM)] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    fogFactor: 0.22,
    keyColor: 0xe4e0ff,
    fillColor: 0x7fb0e8,
    rimColor: 0xffa8d0,
    keyPower: 4.8,
    fillPower: 2.2,
    rimPower: 2.5,
    keyOffset: [0.9, 0.9, 0.55],
    fillOffset: [-1.0, -0.6, 0.5],
    rimOffset: [-0.2, 0.4, -1.2],
    hemiSky: 0x2e2a52,
    hemiGround: 0x0a0812,
    hemiPower: 0.85,
  });
  const { scene } = sc;

  // ---- the hero duplex ---------------------------------------------------
  // Runs across frame through the origin; the camera lands on it.
  const duplex = buildDuplex(90 * NM, quality.detailScale);
  duplex.group.rotation.set(0.12, Math.PI / 2, 0.06);
  scene.add(duplex.group);

  // ---- nucleosomes and the chromatin fibre --------------------------------
  // A zig-zag string receding into the distance, which the hero duplex runs out
  // of. Nucleosome spacing along the fibre is ~11 nm plus linker.
  const chromatin = new THREE.Group();
  chromatin.position.set(U(-26 * NM), U(9 * NM), U(-24 * NM));
  chromatin.rotation.set(0.3, 0.5, 0.2);
  scene.add(chromatin);

  const coreGeo = new THREE.CylinderGeometry(U(5.5 * NM), U(5.5 * NM), U(5.5 * NM), detail(quality, 40, 14));
  const coreMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xd88fb8).convertSRGBToLinear(),
    roughness: 0.5,
  });
  const wrapGeo = makeNucleosomeWrapGeometry(quality.detailScale);
  const wrapMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x7fc4e8).convertSRGBToLinear(),
    roughness: 0.45,
  });

  const NUCS = count(quality, 26, 8);
  const cores = new THREE.InstancedMesh(coreGeo, coreMat, NUCS);
  const wraps = new THREE.InstancedMesh(wrapGeo, wrapMat, NUCS);
  {
    const place = (i: number, d: THREE.Object3D) => {
      // Two-start zig-zag: successive nucleosomes alternate sides of the fibre
      // axis, which is the arrangement the 30 nm fibre is usually modelled as.
      const t = i * 1.0;
      d.position.set(
        U(t * 9 * NM),
        U(Math.sin(t * 1.9) * 8 * NM),
        U(Math.cos(t * 1.9) * 8 * NM),
      );
      d.rotation.set(t * 1.3, t * 0.9, t * 2.1);
    };
    fillInstances(cores, place);
    fillInstances(wraps, place);
  }
  chromatin.add(cores, wraps);

  // ---- RNA polymerase ----------------------------------------------------
  // ~12 nm across, straddling the duplex, unwinding it as it tracks.
  const polMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xffc25c).convertSRGBToLinear(),
    roughness: 0.42,
  });
  const polymerase = new THREE.Mesh(new THREE.IcosahedronGeometry(U(6 * NM), subdiv(quality, 3, 2)), polMat);
  polymerase.scale.set(1, 0.85, 1.1);
  duplex.group.add(polymerase);

  // ---- nucleoplasm crowding ----------------------------------------------
  const blobGeo = new THREE.IcosahedronGeometry(U(1.6 * NM), subdiv(quality, 1, 1));
  const blobMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x6a6ab0).convertSRGBToLinear(),
    roughness: 0.72,
    transparent: true,
    opacity: 0.55,
  });
  const blobMotion = applyGpuMotion(blobMat, { drift: U(4 * NM), driftRate: 3.5, spin: 1.0 });
  const BLOBS = count(quality, 1200, 180);
  const blobs = new THREE.InstancedMesh(blobGeo, blobMat, BLOBS);
  fillInstances(blobs, (_i, d) => {
    d.position.set(
      (rng() - 0.5) * U(90 * NM),
      (rng() - 0.5) * U(70 * NM),
      (rng() - 0.4) * U(80 * NM),
    );
    d.scale.setScalar(0.5 + rng() * 1.3);
  });
  scene.add(blobs);

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    const t = frame.elapsed;
    blobMotion.uniforms.uTime.value = t;

    // The helix breathes and writhes — DNA in solution is never a rigid rod.
    duplex.update(t);

    // Polymerase tracks along the duplex. Real transcription runs at tens of
    // base pairs per second; slowed here so it reads as movement rather than
    // as a blur.
    const along = ((t * 22 * RISE_PER_BP) % (60 * NM)) - 30 * NM;
    polymerase.position.set(0, 0, U(along));
    polymerase.rotation.z = t * 0.4;

    chromatin.rotation.y = 0.5 + Math.sin(t * 0.08) * 0.06;
  }

  function dispose(): void {
    duplex.dispose();
    coreGeo.dispose();
    coreMat.dispose();
    wrapGeo.dispose();
    wrapMat.dispose();
    polMat.dispose();
    polymerase.geometry.dispose();
    blobGeo.dispose();
    blobMat.dispose();
    disposeScene(scene);
  }

  return {
    scene,
    camera: sc.camera,
    rail,
    background: sc.background,
    fogFactor: 0.22,
    update,
    dispose,
  };
}

/**
 * A B-form double helix along the local Z axis.
 *
 * The two sugar-phosphate backbones are placed at a 125°/235° split rather than
 * 180° apart, which is what makes the minor and major grooves different widths.
 */
function buildDuplex(
  lengthMetres: number,
  detailScale: number,
): { group: THREE.Group; update(t: number): void; dispose(): void } {
  const group = new THREE.Group();
  const bpCount = Math.max(40, Math.round((lengthMetres / RISE_PER_BP) * Math.min(1, detailScale)));
  const anglePerBp = (Math.PI * 2) / BP_PER_TURN;

  const strandMats = [
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x5fb8e8).convertSRGBToLinear(),
      roughness: 0.4,
    }),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x9f7fe0).convertSRGBToLinear(),
      roughness: 0.4,
    }),
  ];

  const tubes: THREE.Mesh[] = [];
  for (let s = 0; s < 2; s++) {
    const offset = s === 0 ? 0 : MINOR_GROOVE_ANGLE;
    const pts: THREE.Vector3[] = [];
    const steps = Math.max(60, Math.round(bpCount * 1.2));
    for (let i = 0; i <= steps; i++) {
      const bp = (i / steps) * bpCount;
      const z = bp * RISE_PER_BP - lengthMetres / 2;
      // Right-handed: angle increases with z.
      const a = bp * anglePerBp + offset;
      pts.push(new THREE.Vector3(Math.cos(a) * U(HELIX_R), Math.sin(a) * U(HELIX_R), U(z)));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(
      curve,
      Math.max(120, Math.round(steps * 1.1)),
      U(0.35 * NM),
      Math.max(8, Math.round(15 * detailScale)),
      false,
    );
    const mesh = new THREE.Mesh(geo, strandMats[s]);
    group.add(mesh);
    tubes.push(mesh);
  }

  // Base pairs: flat rungs spanning the two backbones. Purine-pyrimidine pairs
  // are all the same width, which is exactly why the helix has a constant
  // diameter regardless of sequence.
  const rungGeo = new THREE.BoxGeometry(1, 1, 1);
  const rungMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xe8e0c8).convertSRGBToLinear(),
    roughness: 0.55,
  });
  const rungs = new THREE.InstancedMesh(rungGeo, rungMat, bpCount);
  {
    const a0 = new THREE.Vector3();
    const a1 = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    fillInstances(rungs, (i, d) => {
      const z = i * RISE_PER_BP - lengthMetres / 2;
      const a = i * anglePerBp;
      a0.set(Math.cos(a) * U(HELIX_R), Math.sin(a) * U(HELIX_R), U(z));
      const b = a + MINOR_GROOVE_ANGLE;
      a1.set(Math.cos(b) * U(HELIX_R), Math.sin(b) * U(HELIX_R), U(z));
      mid.copy(a0).add(a1).multiplyScalar(0.5);
      dir.copy(a1).sub(a0);
      const len = dir.length();
      d.position.copy(mid);
      d.quaternion.setFromUnitVectors(up, dir.normalize());
      d.scale.set(U(0.5 * NM), len, U(0.24 * NM));
    });
  }
  group.add(rungs);

  function update(t: number): void {
    // Breathing and writhing: a gentle bend that travels along the molecule.
    group.rotation.z = Math.sin(t * 0.25) * 0.04;
    for (let i = 0; i < tubes.length; i++) {
      tubes[i].position.x = Math.sin(t * 0.5 + i) * U(0.05 * NM);
    }
    rungs.position.x = Math.sin(t * 0.5) * U(0.03 * NM);
  }

  function dispose(): void {
    for (const t of tubes) t.geometry.dispose();
    for (const m of strandMats) m.dispose();
    rungGeo.dispose();
    rungMat.dispose();
  }

  return { group, update, dispose };
}

/**
 * The DNA wrapped around a histone octamer: 147 bp in about 1.65 left-handed
 * superhelical turns. Left-handed is not a detail to get wrong — the negative
 * supercoiling it introduces is functionally important.
 */
function makeNucleosomeWrapGeometry(detailScale: number): THREE.BufferGeometry {
  const turns = 1.65;
  const superR = 4.2 * NM;
  const pitch = 2.6 * NM;
  const pts: THREE.Vector3[] = [];
  const steps = Math.max(64, Math.round(240 * detailScale));
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    // Negative angle: left-handed superhelix.
    const a = -f * turns * Math.PI * 2;
    const y = (f - 0.5) * pitch * turns;
    pts.push(new THREE.Vector3(Math.cos(a) * U(superR), y * L, Math.sin(a) * U(superR)));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(
    curve,
    Math.max(40, Math.round(steps * 0.8)),
    U(1.0 * NM),
    Math.max(7, Math.round(13 * detailScale)),
    false,
  );
}
