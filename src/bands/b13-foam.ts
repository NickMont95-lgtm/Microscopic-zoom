import * as THREE from 'three';
import type { BandContext, BandFrame, BandInstance } from '../core/types.ts';
import { disposeScene, makeRail, makeScaffold } from './common.ts';
import { makeField } from './field.ts';

/**
 * BAND 13 — Quantum field (17.8 am → 1.6 × 10⁻³⁵ m across the screen)
 *
 * SPECULATIVE. Nothing has ever been observed at these scales, and most of them
 * are not merely unobserved but unobservable with any apparatus that could
 * exist. The most energetic collisions ever produced probe to around 10⁻¹⁹ m;
 * everything below that in this band is seventeen orders of magnitude of
 * extrapolation.
 *
 * What is drawn is one common way of picturing quantum field theory's vacuum:
 * fields that are never still, fluctuating on every scale, with "particles"
 * being excitations in them rather than objects. The "foam" idea — that
 * spacetime itself becomes turbulent near the Planck length — is a suggestion
 * from the 1950s that remains untested and may well be wrong.
 *
 * The band ends at the Planck length, 1.616 × 10⁻³⁵ m, which is where the
 * ordinary notions of distance and duration are expected to stop meaning
 * anything at all. That is not a wall the visualisation hits; it is where the
 * question stops being answerable.
 *
 * Structurally, this band is 17 decades handled by one decade of camera dolly
 * repeated seventeen times over scale-invariant noise. Nothing else could work,
 * and nothing else is honest: at these scales there is no reason to think one
 * depth looks different from another.
 */

export function makeFoamBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;

  const rail = makeRail([
    { p: [0, 0, 0.4] },
    { p: [0.03, 0.015, 0.15] },
    { p: [0.008, 0.004, 0.03] },
    { p: [0, 0, 0] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    fogFactor: 0,
    keyPower: 0.5,
    fillPower: 0.4,
    rimPower: 0.4,
    hemiSky: 0x140b28,
    hemiGround: 0x03020a,
    hemiPower: 0.3,
  });
  const { scene } = sc;

  // Two overlaid fields at different rates and colours. One slow and broad, one
  // fast and fine — the sense of a medium seething on every scale at once
  // rather than of a single texture scrolling past.
  // One field, not two. This shader is fill-bound — every slice is a
  // full-screen additive layer evaluating an fbm — so a second overlaid stack
  // doubled the per-pixel cost and made the band unrenderable.
  const foam = makeField({
    quality,
    slices: 18,
    extent: 30,
    depth: 70,
    density: 0.42,
    flow: 1.8,
    contrast: 2.0,
    scale: 0.09,
    colorA: 0x2a1a6a,
    colorB: 0x7ad0ff,
  });
  sc.camera.add(foam.mesh);
  foam.mesh.position.z = -34;

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    foam.update(frame);
    // Toward the Planck length the field grows more agitated, which is the
    // conventional way of drawing it — and, to be clear, a stylistic choice.
    const depth = Math.min(1, frame.u);
    (foam.mesh.material as THREE.ShaderMaterial).uniforms.uFlow.value = 1.8 + depth * 4.5;
  }

  function dispose(): void {
    foam.dispose();
    disposeScene(scene);
  }

  return {
    scene,
    camera: sc.camera,
    rail,
    background: sc.background,
    fogFactor: 0,
    update,
    dispose,
  };
}
