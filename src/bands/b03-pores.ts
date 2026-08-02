import * as THREE from 'three';
import type { BandContext, BandFrame, BandInstance } from '../core/types.ts';
import { disposeScene, makeRail, makeRng, makeScaffold } from './common.ts';
import { makeHairField, makeSkinPatch } from './skin.ts';

/**
 * BAND 3 — Pores and corneocytes (1.78 mm → 200 µm across the screen)
 *
 * Individual follicular openings, the sebum sheen around them, and corneocytes
 * — the flat dead keratinocytes of the stratum corneum, about 35 µm across and
 * under a micron thick — lifting and drifting off as they desquamate. A person
 * sheds these constantly; most household dust is this.
 *
 * The surface is the same field bands 2 and 4 use, so the pore the camera is
 * heading into is literally the same pore.
 */

const METRES_PER_UNIT = Math.pow(10, -2.75) / 60; // ≈ 29.6 µm per local unit
const L = 1 / METRES_PER_UNIT;
const TILT = 0.60;

export function makePoresBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;

  const rail = makeRail([
    { p: [0.00022 * L, 0.00014 * L, 0.00004 * L] },
    { p: [0.00008 * L, 0.00005 * L, 0.00001 * L], roll: 0.02 },
    { p: [0.00002 * L, 0.00001 * L, -0.00002 * L] },
    { p: [0, 0, -0.00006 * L] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    fogFactor: 0.12,
    keyColor: 0xfff0dd,
    fillColor: 0xffd9c6,
    rimColor: 0xcfe0ff,
    keyPower: 4.6,
    fillPower: 1.2,
    rimPower: 1.5,
    keyOffset: [1.4, 1.0, 0.30],
    fillOffset: [-1.1, -0.8, 0.45],
    rimOffset: [-0.4, 1.2, -0.6],
    hemiSky: 0x6b5148,
    hemiGround: 0x180f0e,
    hemiPower: 0.55,
  });
  const { scene } = sc;

  const skin = makeSkinPatch({
    quality,
    coverage: 2.8,
    centre: [0.0031, -0.0017],
    tilt: TILT,
    color: 0xd6a894,
    roughness: 0.5,
    sebum: 0.85,
  });
  scene.add(skin.mesh);

  // A few vellus hairs still cross frame at the top of this band.
  const vellus = makeHairField({
    quality,
    count: 120,
    areaMetres: 0.0022,
    localPerMetre: L,
    diameter: [12e-6, 28e-6],
    length: [0.0003, 0.0012],
    color: 0xc0a488,
    clearRadiusMetres: 90e-6,
    seed: 91,
  });
  const vellusGroup = new THREE.Group();
  vellusGroup.rotation.y = TILT;
  vellusGroup.add(vellus.mesh);
  scene.add(vellusGroup);

  // ---- desquamating corneocytes -----------------------------------------
  // Irregular polygonal plates ~35 µm across and ~0.7 µm thick. Most lie flat;
  // some have lifted at one edge and are about to come away.
  const rng = makeRng(3103);
  const FLAKES = Math.max(40, Math.round(420 * quality.instanceScale));
  const flakeGeo = makeCorneocyteGeometry();
  const flakeMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xe4c3ab).convertSRGBToLinear(),
    roughness: 0.78,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const flakes = new THREE.InstancedMesh(flakeGeo, flakeMat, FLAKES);
  flakes.frustumCulled = false;

  interface Flake {
    pos: THREE.Vector3;
    size: number;
    spin: number;
    lift: number; // 0 = flat on the surface, 1 = fully detached and drifting
    rate: number;
    phase: number;
    axis: THREE.Vector3;
  }
  const flakeData: Flake[] = [];
  for (let i = 0; i < FLAKES; i++) {
    const r = (0.05 + rng() * 0.95) * 0.0012;
    const a = rng() * Math.PI * 2;
    // A third of them are lifting off.
    const lifting = rng() < 0.34;
    flakeData.push({
      pos: new THREE.Vector3(Math.cos(a) * r * L, Math.sin(a) * r * L, 0),
      size: (26e-6 + rng() * 20e-6) * L,
      spin: (rng() - 0.5) * 0.5,
      lift: lifting ? 0.15 + rng() * 0.85 : 0,
      rate: 0.15 + rng() * 0.5,
      phase: rng() * Math.PI * 2,
      axis: new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize(),
    });
  }
  const flakeGroup = new THREE.Group();
  flakeGroup.rotation.y = TILT;
  flakeGroup.add(flakes);
  scene.add(flakeGroup);

  const dummy = new THREE.Object3D();

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    skin.update(frame);
    vellus.update(frame.elapsed);
    vellusGroup.visible = frame.metresVisible > 0.00035;

    const t = frame.elapsed;
    for (let i = 0; i < FLAKES; i++) {
      const f = flakeData[i];
      // Lifted flakes rise off the surface and tumble slowly away; flat ones
      // just breathe with the skin.
      const drift = f.lift * (0.5 + 0.5 * Math.sin(t * f.rate + f.phase));
      dummy.position.set(
        f.pos.x + Math.sin(t * f.rate * 0.7 + f.phase) * drift * 40e-6 * L,
        f.pos.y + Math.cos(t * f.rate * 0.9 + f.phase) * drift * 40e-6 * L,
        f.pos.z + drift * 55e-6 * L,
      );
      dummy.quaternion.setFromAxisAngle(f.axis, f.phase + t * f.spin * f.lift);
      if (f.lift < 0.01) {
        // Flat plates keep a shallow random tilt instead of tumbling.
        dummy.quaternion.setFromAxisAngle(f.axis, 0.12 * Math.sin(f.phase));
      }
      dummy.scale.set(f.size, f.size, f.size * 0.02);
      dummy.updateMatrix();
      flakes.setMatrixAt(i, dummy.matrix);
    }
    flakes.instanceMatrix.needsUpdate = true;
  }

  function dispose(): void {
    skin.dispose();
    vellus.dispose();
    flakeGeo.dispose();
    flakeMat.dispose();
    disposeScene(scene);
  }

  return {
    scene,
    camera: sc.camera,
    rail,
    background: sc.background,
    fogFactor: 0.12,
    update,
    dispose,
  };
}

/** An irregular polygon, the way a corneocyte actually looks from above. */
function makeCorneocyteGeometry(): THREE.BufferGeometry {
  const sides = 6;
  const rng = makeRng(88);
  const shape = new THREE.Shape();
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const r = 0.5 * (0.78 + rng() * 0.44);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  geo.translate(0, 0, -0.5);
  geo.computeVertexNormals();
  return geo;
}
