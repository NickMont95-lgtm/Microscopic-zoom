import * as THREE from 'three';
import type { BandContext, BandFrame, BandInstance } from '../core/types.ts';
import { count, disposeScene, fillInstances, makeRail, makeRng, makeScaffold, realToLocal, subdiv } from './common.ts';
import { makeField } from './field.ts';

/**
 * BAND 12 — Inside a proton (17.8 fm → 1 am across the screen)
 *
 * The proton is about 1.7 fm across (charge radius 0.84 fm). Inside it are
 * three valence quarks — two up, one down — but they account for only about 1%
 * of the proton's mass. The rest is the energy of the gluon field binding them,
 * together with a churning sea of virtual quark-antiquark pairs continually
 * appearing and annihilating.
 *
 * Two honesty notes, both of which the visualisation has to fudge:
 *   - Quarks are point-like. Experiment puts any substructure below 10⁻¹⁹ m.
 *     Drawing them as small glowing cores is a convention for "here is where
 *     this one probably is", not a picture of an object with a surface.
 *   - Colour charge has nothing to do with visible colour. Red/green/blue here
 *     is the standard labelling scheme for the three charge states, chosen
 *     because they combine to "colourless" — it is a pun, not an observation.
 *
 * Quarks are never seen alone: pull two apart and the flux tube between them
 * stores enough energy to make a new quark-antiquark pair instead of breaking.
 * That is why the tubes here stretch and snap rather than simply separating.
 */

const FM = 1e-15;
const PROTON_R = 0.84 * FM;

export function makeProtonBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;
  const rng = makeRng(1212);

  const rail = makeRail([
    { p: [0, 0, 0.5] },
    { p: [0.04, 0.02, 0.18] },
    { p: [0.01, 0.004, 0.04] },
    { p: [0, 0, 0] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    fogFactor: 0,
    keyColor: 0xffe8d8,
    fillColor: 0xff7040,
    rimColor: 0x60a0ff,
    keyPower: 2.4,
    fillPower: 1.4,
    rimPower: 1.6,
    hemiSky: 0x301218,
    hemiGround: 0x0a0206,
    hemiPower: 0.4,
  });
  const { scene } = sc;

  // ---- the gluon sea -----------------------------------------------------
  // Violent, constant flux. This is the dominant visual because it is the
  // dominant physical reality: most of the proton's mass is field energy.
  const sea = makeField({
    quality,
    slices: 16,
    extent: 30,
    depth: 70,
    density: 0.30,
    flow: 3.2,
    contrast: 2.2,
    scale: 0.09,
    colorA: 0x8a2010,
    colorB: 0xffc255,
  });
  sc.camera.add(sea.mesh);
  sea.mesh.position.z = -34;

  // ---- the proton's own extent -------------------------------------------
  // A soft boundary, because a proton does not have a surface — its charge
  // density just falls off.
  const shellMat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vLocal;
      uniform float uTime;
      uniform float uOpacity;
      void main() {
        float r = length(vLocal);
        float d = smoothstep(0.55, 1.0, r) * uOpacity;
        d *= 0.7 + 0.3 * sin(vLocal.x * 6.0 + uTime) * sin(vLocal.z * 5.0 - uTime * 1.3);
        gl_FragColor = vec4(vec3(1.0, 0.45, 0.2) * d, d);
      }`,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0.30 } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1, subdiv(quality, 4, 2)), shellMat);
  scene.add(shell);

  // ---- valence quarks ----------------------------------------------------
  // uud. Colour labels red / green / blue.
  const quarkGroup = new THREE.Group();
  scene.add(quarkGroup);
  const quarkColors = [0xff4444, 0x44ff66, 0x5588ff];
  const quarkMats = quarkColors.map(
    (c) =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(c).convertSRGBToLinear(),
        emissive: new THREE.Color(c).convertSRGBToLinear().multiplyScalar(0.8),
        roughness: 0.25,
        transparent: true,
        opacity: 1,
      }),
  );
  const quarkGeo = new THREE.IcosahedronGeometry(1, subdiv(quality, 4, 2));
  const quarks = quarkMats.map((m) => {
    const q = new THREE.Mesh(quarkGeo, m);
    quarkGroup.add(q);
    return q;
  });

  // Flux tubes between each pair.
  // Soft-edged, so a flux tube reads as a filament of field rather than as a
  // solid bar drawn across the frame.
  const tubeMat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec2 vUvT;
      void main() {
        vUvT = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUvT;
      uniform float uOpacity;
      uniform float uTime;
      void main() {
        // uv.x runs around the tube: fade toward the silhouette edges.
        float edge = sin(vUvT.x * 3.14159265);
        float flick = 0.75 + 0.25 * sin(vUvT.y * 24.0 - uTime * 6.0);
        float d = pow(edge, 2.2) * uOpacity * flick;
        gl_FragColor = vec4(vec3(1.0, 0.78, 0.42) * d, d);
      }`,
    uniforms: { uOpacity: { value: 0.4 }, uTime: { value: 0 } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 7, 1, true);
  const tubes = [0, 1, 2].map(() => {
    const t = new THREE.Mesh(tubeGeo, tubeMat);
    quarkGroup.add(t);
    return t;
  });

  // ---- virtual pairs -----------------------------------------------------
  // Quark-antiquark pairs flickering in and out of existence. They are drawn
  // popping into view and vanishing again, because that is what they do.
  const pairGeo = new THREE.IcosahedronGeometry(1, subdiv(quality, 2, 1));
  const pairMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xffe0a0).convertSRGBToLinear(),
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const PAIRS = count(quality, 260, 40);
  const pairs = new THREE.InstancedMesh(pairGeo, pairMat, PAIRS);
  const pairHome: THREE.Vector3[] = [];
  const pairPhase: number[] = [];
  fillInstances(pairs, (_i, d) => {
    const v = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
    if (v.lengthSq() > 1) v.normalize().multiplyScalar(rng());
    pairHome.push(v.clone());
    pairPhase.push(rng() * Math.PI * 2);
    d.position.copy(v);
    d.scale.setScalar(0.02);
  });
  scene.add(pairs);

  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    sea.update(frame);
    const t = frame.elapsed;
    shellMat.uniforms.uTime.value = t;

    // The proton at its true size in the current local units. Below its own
    // scale it stops being an object and we are simply inside the field.
    const R = realToLocal(frame, PROTON_R);
    shell.scale.setScalar(R);
    shell.position.copy(sc.camera.position);
    shell.position.z -= R * 0.1;
    // Fade the boundary out once we are well inside it.
    shellMat.uniforms.uOpacity.value = 0.30 * Math.min(1, Math.max(0, (R - 0.4) / 6));
    shell.visible = shellMat.uniforms.uOpacity.value > 0.01;

    // Valence quarks orbit within the confinement volume, fast and erratic.
    const qpos: THREE.Vector3[] = [];
    for (let i = 0; i < 3; i++) {
      const a = t * 1.6 + (i * Math.PI * 2) / 3;
      const wobble = Math.sin(t * 3.1 + i * 2.2) * 0.22;
      const p = new THREE.Vector3(
        Math.cos(a) * (0.42 + wobble),
        Math.sin(a * 1.3 + i) * (0.34 + wobble * 0.7),
        Math.sin(a) * (0.42 + wobble),
      ).multiplyScalar(R);
      p.add(shell.position);
      qpos.push(p);
      quarks[i].position.copy(p);
      quarks[i].scale.setScalar(R * 0.055);
      quarks[i].visible = R > 0.02;
    }

    // Flux tubes: they stretch, and their brightness rises with separation
    // because the potential grows linearly with distance.
    for (let i = 0; i < 3; i++) {
      const a = qpos[i];
      const b = qpos[(i + 1) % 3];
      dir.copy(b).sub(a);
      const len = dir.length();
      mid.copy(a).addScaledVector(dir, 0.5);
      tubes[i].position.copy(mid);
      tubes[i].quaternion.setFromUnitVectors(up, dir.normalize());
      tubes[i].scale.set(R * 0.012, len, R * 0.012);
      tubes[i].visible = R > 0.02;
    }
    tubeMat.uniforms.uTime.value = t;
    // Once the proton is far larger than the frame we are resolving field, not
    // the quark arrangement, so the valence structure fades out rather than
    // sweeping past as enormous bars.
    const structure = 1 - Math.min(1, Math.max(0, (R - 28) / 45));
    tubeMat.uniforms.uOpacity.value = (0.18 + 0.16 * Math.abs(Math.sin(t * 2.3))) * structure;
    for (const q of quarks) (q.material as THREE.MeshStandardMaterial).opacity = structure;

    // Virtual pairs flicker.
    for (let i = 0; i < PAIRS; i++) {
      const life = Math.sin(t * 4.5 + pairPhase[i]);
      const alive = Math.max(0, life);
      const h = pairHome[i];
      dummy.position.set(
        shell.position.x + h.x * R * 1.1,
        shell.position.y + h.y * R * 1.1,
        shell.position.z + h.z * R * 1.1,
      );
      dummy.scale.setScalar(R * 0.012 * alive);
      dummy.updateMatrix();
      pairs.setMatrixAt(i, dummy.matrix);
    }
    pairs.instanceMatrix.needsUpdate = true;
    pairs.visible = R > 0.02;
    pairMat.opacity = 0.5 + 0.3 * structure;
  }

  function dispose(): void {
    shell.geometry.dispose();
    shellMat.dispose();
    quarkGeo.dispose();
    for (const m of quarkMats) m.dispose();
    tubeGeo.dispose();
    tubeMat.dispose();
    pairGeo.dispose();
    pairMat.dispose();
    sea.dispose();
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
