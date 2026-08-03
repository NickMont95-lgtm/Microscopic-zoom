import * as THREE from 'three';
import { Rail, type RailKey } from '../core/rail.ts';
import type { BandContext, BandFrame, BandInstance } from '../core/types.ts';
import { SURFACE_LOG, wrapOrigin } from '../core/constants.ts';

/**
 * PHASE 1 PLACEHOLDER CONTENT — the seam test rig.
 *
 * This is deliberately not "some grey boxes". It is built to make a bad
 * cross-fade impossible to miss:
 *
 *  - Every band draws the same thing: a tunnel of rings ("gates") the camera
 *    flies through, one every 0.25 decades.
 *  - Gate size, colour, spin phase and lateral drift are all functions of the
 *    ABSOLUTE real-world log scale, not of the band. So a ring at 100 µm looks
 *    identical whether band 3 or band 4 is drawing it, and sits in the same
 *    place on screen.
 *  - At a band boundary the two bands are therefore drawing very nearly the
 *    same picture from two completely separate scenes with separate depth
 *    buffers and separate local coordinate systems. If the hand-off has any
 *    flaw — a pop in size, a jump in position, a brightness dip, a stutter —
 *    it shows up immediately as a doubled or sliding ring.
 *
 * Press K to tint the two active bands red/cyan and see exactly where the
 * overlap is and how long it lasts.
 */

// One gate every quarter decade. Divides 1.0 evenly, which is what lets the
// wrapping bands (11-13) re-anchor invisibly.
const GATE_STEP = 0.25;

// Gate diameter as a fraction of screen width when the camera is level with it.
const GATE_SCREEN_FRACTION = 0.72;

// Radians of helical drift per decade of descent. Must be a whole multiple of
// 2*PI per decade or the wrapping bands would visibly rotate when they re-anchor.
const HELIX_OMEGA = Math.PI * 2;
const HELIX_AMPLITUDE = 0.22;

/** Shared tangent of the descent helix, in absolute decades below the surface. */
function pathTangent(absDecades: number, out: THREE.Vector3): THREE.Vector3 {
  const p = HELIX_OMEGA * absDecades;
  out.set(Math.sin(p) * HELIX_AMPLITUDE, Math.cos(p * 0.5) * HELIX_AMPLITUDE * 0.7, -1);
  return out.normalize();
}

/** Hue repeats once per decade, so it matches across every band boundary. */
function gateHue(logSize: number): number {
  const f = logSize - Math.floor(logSize);
  return (f + 0.58) % 1;
}

/** Backdrop colour driven purely by the current scale, so both bands agree. */
function atmosphereColor(logScale: number, out: THREE.Color): THREE.Color {
  const f = logScale - Math.floor(logScale);
  return out.setHSL((f + 0.58) % 1, 0.5, 0.035);
}

interface Gate {
  mesh: THREE.Mesh;
  spin: number;
  phase: number;
}

/**
 * Builds the look-curve for a band by integrating the shared helix.
 *
 * Step length shrinks by 10x per decade, so the path converges on a point —
 * which is what an infinite zoom needs. Because it is generated from absolute
 * decades, every band traces the same corkscrew and the paths line up where
 * bands overlap.
 */
function buildRail(logTop: number, localSpan: number, localTopWidth: number): {
  rail: Rail;
  lookAt: (delta: number, out: THREE.Vector3) => void;
} {
  const A = 1.389 * localTopWidth;
  const absTop = SURFACE_LOG - logTop;

  // Integrate a little above and below the band so the spline has room at both
  // ends and never extrapolates.
  const d0 = -0.6;
  const d1 = localSpan + 0.6;
  const STEPS = 400;
  const dd = (d1 - d0) / STEPS;

  const samples: THREE.Vector3[] = [];
  const pos = new THREE.Vector3();
  const tan = new THREE.Vector3();

  // Integrate forward from d0.
  for (let i = 0; i <= STEPS; i++) {
    const delta = d0 + dd * i;
    samples.push(pos.clone());
    pathTangent(absTop + delta, tan);
    pos.addScaledVector(tan, A * Math.pow(10, -delta) * dd);
  }

  // Re-origin so that delta = 0 sits at the local origin.
  const zeroIdx = Math.round((0 - d0) / dd);
  const origin = samples[zeroIdx].clone();
  for (const s of samples) s.sub(origin);

  const lookAt = (delta: number, out: THREE.Vector3) => {
    const f = THREE.MathUtils.clamp((delta - d0) / dd, 0, STEPS);
    const i = Math.min(STEPS - 1, Math.floor(f));
    out.copy(samples[i]).lerp(samples[i + 1], f - i);
  };

  // Rail keys. The density is per DECADE, not per band: if two bands used
  // different key counts for the same decade, their Catmull-Rom splines would
  // deviate from the true integral by different amounts and the rings would
  // drift apart by a pixel or two at the seam.
  const KEYS = Math.round(THREE.MathUtils.clamp(localSpan * 40, 24, 200));
  const keys: RailKey[] = [];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let i = 0; i <= KEYS; i++) {
    const delta = (localSpan * i) / KEYS;
    lookAt(delta, p);
    pathTangent(absTop + delta, t);
    keys.push({
      look: [p.x, p.y, p.z],
      // dir points from the look target back toward the camera.
      dir: [-t.x, -t.y, -t.z],
      roll: Math.sin((absTop + delta) * 0.7) * 0.10,
    });
  }

  return { rail: new Rail(keys), lookAt };
}

export function makePlaceholderBand(ctx: BandContext): BandInstance {
  const { def, quality } = ctx;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);

  // Every band is authored in local units. This is the only place real metres
  // and local units meet, and it is a constant within a dolly window.
  const localTopWidth = def.localTopWidth;
  const dollySpan = def.wrapDecades ?? def.localSpan;

  // Wrapping bands re-anchor on the global decade grid rather than on their own
  // logTop, so every wrapping band is at the same phase of the same tunnel.
  const anchorTop = def.wrapDecades ? wrapOrigin(def.logTop, def.wrapDecades) : def.logTop;

  const { rail, lookAt } = buildRail(anchorTop, dollySpan, localTopWidth);

  const bg = new THREE.Color();
  scene.background = bg;
  scene.fog = new THREE.FogExp2(0x000000, 0.02);

  // --- lighting -----------------------------------------------------------
  // The key light is parented to the camera and re-positioned every frame in
  // proportion to the focus distance, so illumination is identical at every
  // point of a 35-decade descent. Real bands will use the same trick.
  scene.add(camera);
  const key = new THREE.PointLight(0xffffff, 1, 0, 2);
  camera.add(key);
  const rim = new THREE.PointLight(0x88bbff, 1, 0, 2);
  camera.add(rim);
  scene.add(new THREE.HemisphereLight(0x445577, 0x110c18, 0.55));

  // --- gates --------------------------------------------------------------
  const gateGeo = new THREE.TorusGeometry(
    1,
    0.055,
    Math.max(6, Math.round(12 * quality.detailScale)),
    Math.max(24, Math.round(72 * quality.detailScale)),
  );

  const gates: Gate[] = [];
  const tmp = new THREE.Vector3();
  const tan = new THREE.Vector3();

  // Gate log-sizes snapped to a global 0.25-decade grid so that neighbouring
  // bands place rings at exactly the same real-world sizes.
  const deltaLo = -0.5;
  const deltaHi = dollySpan + 0.5;
  const firstK = Math.ceil((anchorTop - deltaHi) / GATE_STEP);
  const lastK = Math.floor((anchorTop - deltaLo) / GATE_STEP);

  for (let k = firstK; k <= lastK; k++) {
    const logSize = k * GATE_STEP;
    const delta = anchorTop - logSize;
    // Local width visible when logScale == logSize.
    const localWidthHere = localTopWidth * Math.pow(10, -delta);
    const radius = 0.5 * GATE_SCREEN_FRACTION * localWidthHere;

    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(gateHue(logSize), 0.62, 0.52),
      emissive: new THREE.Color().setHSL(gateHue(logSize), 0.7, 0.10),
      roughness: 0.35,
      metalness: 0.15,
    });
    const mesh = new THREE.Mesh(gateGeo, mat);
    lookAt(delta, tmp);
    mesh.position.copy(tmp);
    mesh.scale.setScalar(radius);

    // Face along the direction of travel.
    pathTangent(SURFACE_LOG - logSize, tan);
    mesh.lookAt(tmp.clone().add(tan));

    const frac = logSize - Math.floor(logSize);
    gates.push({ mesh, spin: 0.15 + frac * 0.4, phase: frac * Math.PI * 2 });
    scene.add(mesh);
  }

  // --- satellites ---------------------------------------------------------
  // Small debris around each gate. Uses InstancedMesh, which is the pattern the
  // real bands will use for bacteria, ribosomes, nucleosomes and atoms.
  const perGate = Math.max(6, Math.round(26 * quality.instanceScale));
  const total = gates.length * perGate;
  const satGeo = new THREE.IcosahedronGeometry(1, quality.detailScale > 0.6 ? 2 : 1);
  const satMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 });
  const sats = new THREE.InstancedMesh(satGeo, satMat, total);
  sats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sats.frustumCulled = false;
  scene.add(sats);

  interface Sat {
    origin: THREE.Vector3;
    radius: number;
    size: number;
    axis: THREE.Vector3;
    rate: number;
    phase: number;
  }
  const satData: Sat[] = [];
  for (let g = 0; g < gates.length; g++) {
    const gate = gates[g];
    const r = gate.mesh.scale.x;
    const logSize = (firstK + g) * GATE_STEP;
    const col = new THREE.Color().setHSL(gateHue(logSize), 0.45, 0.42);
    for (let i = 0; i < perGate; i++) {
      const a = (i / perGate) * Math.PI * 2 + g;
      const rr = r * (0.75 + 0.9 * ((i * 0.618) % 1));
      const y = (((i * 0.379) % 1) - 0.5) * r * 1.4;
      satData.push({
        origin: new THREE.Vector3(
          gate.mesh.position.x + Math.cos(a) * rr,
          gate.mesh.position.y + y,
          gate.mesh.position.z + Math.sin(a) * rr * 0.6,
        ),
        radius: r * 0.09,
        size: r * (0.02 + 0.03 * ((i * 0.117) % 1)),
        axis: new THREE.Vector3(Math.sin(a * 1.7), Math.cos(a * 2.3), Math.sin(a * 0.9)).normalize(),
        rate: 0.3 + ((i * 0.271) % 1) * 0.9,
        phase: a * 3.1,
      });
      sats.setColorAt(satData.length - 1, col);
    }
  }
  if (sats.instanceColor) sats.instanceColor.needsUpdate = true;

  // --- update -------------------------------------------------------------
  const dummy = new THREE.Object3D();
  const fogColor = new THREE.Color();

  function update(frame: BandFrame): void {
    // Backdrop and fog are functions of the CURRENT SCALE, not of the band.
    // That means both bands in a dissolve paint the same background, so the
    // hand-off can never show as a colour shift.
    atmosphereColor(frame.logScale, bg);
    fogColor.copy(bg);
    const fog = scene.fog as THREE.FogExp2;
    fog.color.copy(fogColor);
    fog.density = 0.32 / Math.max(1e-9, frame.focusDistance);

    // Keep lighting scale-invariant: a point light with physical falloff needs
    // intensity proportional to distance squared to look the same at any scale.
    const d = frame.focusDistance;
    key.position.set(0.35 * d, 0.5 * d, 0.25 * d);
    key.intensity = 2.6 * d * d;
    rim.position.set(-0.7 * d, -0.2 * d, 0.9 * d);
    rim.intensity = 1.4 * d * d;

    const t = frame.elapsed;
    for (const g of gates) {
      g.mesh.rotateZ(g.spin * frame.dt);
    }

    // Satellites jitter. CPU-side for Phase 1 because the counts are tiny;
    // the real bands move this to a GPU particle system.
    for (let i = 0; i < satData.length; i++) {
      const s = satData[i];
      const w = t * s.rate + s.phase;
      dummy.position.set(
        s.origin.x + Math.sin(w) * s.radius,
        s.origin.y + Math.sin(w * 1.31 + 1.7) * s.radius,
        s.origin.z + Math.cos(w * 0.87) * s.radius,
      );
      dummy.quaternion.setFromAxisAngle(s.axis, w * 0.5);
      dummy.scale.setScalar(s.size);
      dummy.updateMatrix();
      sats.setMatrixAt(i, dummy.matrix);
    }
    sats.instanceMatrix.needsUpdate = true;
  }

  function dispose(): void {
    gateGeo.dispose();
    satGeo.dispose();
    satMat.dispose();
    for (const g of gates) (g.mesh.material as THREE.Material).dispose();
    sats.dispose();
    scene.clear();
  }

  return {
    scene,
    camera,
    rail,
    background: bg,
    fogFactor: 0.32,
    update,
    dispose,
  };
}
