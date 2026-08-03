import * as THREE from 'three';
import type { BandContext, BandFrame, BandInstance } from '../core/types.ts';
import { disposeScene, makeRail, makeScaffold } from './common.ts';
import { makeHairField, makeSkinPatch, type HairField } from './skin.ts';

/**
 * BAND 2 — Cheek and beard (178 mm → 1 mm across the screen)
 *
 * The upper cheek, lateral to the nose and just above the beard line. Terminal
 * beard hair (60-120 µm across) crowds the lower part of frame; fine vellus
 * hair (under 30 µm, and much shorter) covers the rest. The surface is lit at a
 * raking angle, which is the only way skin microrelief reads at all.
 *
 * The camera settles onto one follicle, which stays the dive target for the
 * next two bands.
 */

const METRES_PER_UNIT = Math.pow(10, -0.90) / 60; // ≈ 2.10 mm per local unit
const L = 1 / METRES_PER_UNIT; // metres → local units

// Beard follicles are oblique, not perpendicular. Tilting the surface by the
// same angle the camera approaches at means the follicle we dive into is
// aligned with the view axis, and the raking light shows the microrelief.
const TILT = 0.60; // radians, ~34 degrees

export function makeCheekBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;

  // Drift is deliberately a small fraction of the frame width. A rail that
  // wanders as far as the band's own top framing would leave the subject.
  const rail = makeRail([
    { p: [0.030 * L, 0.019 * L, 0.004 * L] },
    { p: [0.010 * L, 0.006 * L, 0.001 * L], roll: 0.03 },
    { p: [0.0018 * L, 0.001 * L, 0], roll: 0.01 },
    { p: [0, 0, 0] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    fogFactor: 0.10,
    keyColor: 0xfff0dd,
    fillColor: 0xffd9c4,
    rimColor: 0xd8e6ff,
    keyPower: 22.0,
    fillPower: 5.5,
    rimPower: 5.0,
    // Grazing key light. Everything about skin texture depends on this.
    keyOffset: [1.5, 0.9, 0.28],
    fillOffset: [-1.2, -0.7, 0.5],
    rimOffset: [-0.3, 1.4, -0.7],
    hemiSky: 0x6b5148,
    hemiGround: 0x1a1010,
    hemiPower: 1.15,
  });
  const { scene } = sc;

  const skin = makeSkinPatch({
    quality,
    coverage: 4.0,
    centre: [0.0031, -0.0017],
    tilt: TILT,
    color: 0xd3a893,
    roughness: 0.55,
  });
  scene.add(skin.group);

  // ---- hair --------------------------------------------------------------
  // Terminal beard hair: 60-120 µm across, several mm long, growing obliquely.
  // Real cheek density is roughly 2 per mm²; 4000 over a 60 mm patch gets close
  // enough that the mass reads correctly without the cost of 100,000 strands.
  const beard: HairField = makeHairField({
    quality,
    count: 4000,
    areaMetres: 0.060,
    localPerMetre: L,
    diameter: [60e-6, 120e-6],
    length: [0.004, 0.014],
    color: 0x54402f,
    clearRadiusMetres: 0.0016,
    seed: 12,
  });
  // Push the beard mass toward the lower part of frame — we are above the line.
  beard.mesh.position.set(0, -0.012 * L, 0);
  const beardGroup = new THREE.Group();
  beardGroup.rotation.y = TILT;
  beardGroup.add(beard.mesh);
  scene.add(beardGroup);

  // Vellus hair: under 30 µm, short, nearly colourless. Dense — this is the
  // "peach fuzz" that covers almost all skin.
  const vellus: HairField = makeHairField({
    quality,
    count: 1500,
    areaMetres: 0.008,
    localPerMetre: L,
    diameter: [12e-6, 28e-6],
    length: [0.0004, 0.0016],
    color: 0xb59a80,
    clearRadiusMetres: 0.00012,
    seed: 77,
  });
  const vellusGroup = new THREE.Group();
  vellusGroup.rotation.y = TILT;
  vellusGroup.add(vellus.mesh);
  scene.add(vellusGroup);

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    skin.update(frame, sc.camera);
    beard.update(frame.elapsed);
    vellus.update(frame.elapsed);

    // A hair only reads as a hair between about two pixels and a third of the
    // frame. Above that a 90 µm shaft is sub-pixel and aliases into a hard black
    // scratch; below it, it becomes a tree trunk beside a single pore. Both
    // ends are gated, and the upper gate also helps the band 1 hand-off, since
    // the cheek we arrive on is bare skin above the beard line.
    beardGroup.visible = frame.metresVisible < 0.030 && frame.metresVisible > 0.0025;
    vellusGroup.visible = frame.metresVisible < 0.006 && frame.metresVisible > 0.0004;
  }

  function dispose(): void {
    skin.dispose();
    beard.dispose();
    vellus.dispose();
    disposeScene(scene);
  }

  return {
    scene,
    camera: sc.camera,
    rail,
    background: sc.background,
    fogFactor: 0.10,
    update,
    dispose,
  };
}
