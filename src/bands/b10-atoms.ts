import * as THREE from 'three';
import type { BandContext, BandFrame, BandInstance } from '../core/types.ts';
import { count, detail, disposeScene, fillInstances, makeRail, makeRng, makeScaffold } from './common.ts';

/**
 * BAND 10 — Atoms of the backbone (2.7 nm → 79 pm across the screen)
 *
 * The sugar-phosphate backbone resolved into individual atoms: phosphorus,
 * oxygen, carbon, nitrogen, hydrogen.
 *
 * Real bond lengths:
 *   C–C  0.154 nm      C–O  0.143 nm      C–N  0.147 nm
 *   P–O  0.160 nm      C–H  0.109 nm
 *
 * ELECTRONS ARE NOT DRAWN AS PARTICLES IN ORBIT. That picture is wrong and has
 * been known to be wrong for a century: an electron in an atom has no
 * trajectory and no position between measurements. What is drawn instead is
 * probability density — a cloud that is brightest where the electron is most
 * likely to be found, fading outward with no surface anywhere. The colours are
 * the conventional CPK scheme (carbon grey, oxygen red, nitrogen blue,
 * phosphorus orange), which is a labelling convention: atoms have no colour,
 * being far smaller than the wavelength of visible light.
 *
 * Motion is thermal: bonds stretch and bend continuously at room temperature.
 */

const METRES_PER_UNIT = Math.pow(10, -8.57) / 60; // ≈ 4.5 pm per local unit
const L = 1 / METRES_PER_UNIT;
const U = (m: number) => m * L;
const PM = 1e-12;

// Van der Waals radii, in picometres — the size an atom effectively presents.
const ATOMS = {
  C: { r: 170 * PM, color: 0x909090 },
  N: { r: 155 * PM, color: 0x3050f8 },
  O: { r: 152 * PM, color: 0xff0d0d },
  P: { r: 180 * PM, color: 0xff8000 },
  H: { r: 120 * PM, color: 0xf0f0f0 },
};

/**
 * An electron probability cloud.
 *
 * Additive, depth-write off, with density falling off smoothly from the centre
 * — deliberately with no hard edge anywhere, because there isn't one. The shell
 * is drawn back-to-front as a soft volume rather than as a sphere.
 */
const CLOUD_VERT = /* glsl */ `
varying vec3 vLocal;
varying float vSeed;
void main() {
  vLocal = position;
  #ifdef USE_INSTANCING
    vSeed = instanceMatrix[3].x + instanceMatrix[3].y * 3.7;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    vSeed = 0.0;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
  #endif
  gl_Position = projectionMatrix * mv;
}
`;

const CLOUD_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uDensity;
varying vec3 vLocal;
varying float vSeed;

void main() {
  float r = length(vLocal);
  // Radial probability density, roughly hydrogenic: dense near the nucleus,
  // decaying outward, never reaching a boundary.
  float d = exp(-r * 3.2) * uDensity;
  // A little angular structure and a slow shimmer, so it reads as a
  // distribution being sampled rather than as a solid ball of fog.
  float ang = 0.82 + 0.18 * sin(vLocal.x * 7.0 + uTime * 0.7 + vSeed)
                        * sin(vLocal.y * 6.0 - uTime * 0.5)
                        * sin(vLocal.z * 8.0 + uTime * 0.6);
  d *= ang;
  gl_FragColor = vec4(uColor * d, d);
}
`;

interface AtomSpec {
  el: keyof typeof ATOMS;
  pos: [number, number, number];
}

export function makeAtomsBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;
  const rng = makeRng(1010);

  const rail = makeRail([
    { p: [0, 0, U(2000 * PM)] },
    { p: [U(80 * PM), U(40 * PM), U(700 * PM)], roll: 0.02 },
    { p: [U(20 * PM), U(10 * PM), U(120 * PM)], roll: 0.04 },
    { p: [0, 0, U(-30 * PM)] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    fogFactor: 0.10,
    keyColor: 0xffffff,
    fillColor: 0x8fa8ff,
    rimColor: 0xffb0e0,
    keyPower: 4.0,
    fillPower: 1.9,
    rimPower: 2.2,
    hemiSky: 0x1a1a34,
    hemiGround: 0x06060e,
    hemiPower: 0.7,
  });
  const { scene } = sc;

  // ---- a fragment of the backbone ----------------------------------------
  // Phosphate, then the deoxyribose ring carbons and oxygens, laid out with
  // real bond lengths and roughly tetrahedral angles.
  const chain: AtomSpec[] = [
    { el: 'P', pos: [0, 0, 0] },
    { el: 'O', pos: [0, 160, 0] },
    { el: 'O', pos: [0, -160, 0] },
    { el: 'O', pos: [-150, 0, 60] },
    { el: 'O', pos: [150, 0, -60] },
    { el: 'C', pos: [290, 20, -160] },
    { el: 'C', pos: [430, -60, -80] },
    { el: 'O', pos: [430, -200, -120] },
    { el: 'C', pos: [575, 0, -140] },
    { el: 'C', pos: [640, 30, 10] },
    { el: 'N', pos: [780, 90, 30] },
    { el: 'C', pos: [880, 20, 130] },
    { el: 'C', pos: [-140, 30, -180] },
    { el: 'C', pos: [-280, -30, -110] },
  ];

  const bonds: [number, number][] = [
    [0, 1], [0, 2], [0, 3], [0, 4],
    [4, 5], [5, 6], [6, 7], [6, 8], [8, 9], [9, 10], [10, 11],
    [3, 12], [12, 13],
  ];

  // Nuclei: tiny hard cores at the centre of each cloud. A nucleus is about
  // 1/100,000 of the atom, so at this scale it is far below a pixel — these are
  // markers, not the nucleus to scale. Band 11 makes that point properly.
  const coreGeo = new THREE.IcosahedronGeometry(U(9 * PM), detail(quality, 2, 1));
  const cores: THREE.Mesh[] = [];
  const coreMats: THREE.MeshStandardMaterial[] = [];

  // Clouds: one additive shell per atom, scaled to the van der Waals radius.
  const cloudGeo = new THREE.IcosahedronGeometry(1, detail(quality, 3, 2));
  const cloudMats: THREE.ShaderMaterial[] = [];
  const clouds: THREE.Mesh[] = [];

  const atomGroup = new THREE.Group();
  scene.add(atomGroup);

  for (const a of chain) {
    const spec = ATOMS[a.el];
    const p = new THREE.Vector3(U(a.pos[0] * PM), U(a.pos[1] * PM), U(a.pos[2] * PM));

    const coreMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(spec.color).convertSRGBToLinear(),
      roughness: 0.3,
      emissive: new THREE.Color(spec.color).convertSRGBToLinear().multiplyScalar(0.25),
      transparent: true,
      opacity: 1,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.copy(p);
    atomGroup.add(core);
    cores.push(core);
    coreMats.push(coreMat);

    const cloudMat = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(spec.color).convertSRGBToLinear() },
        uTime: { value: 0 },
        uDensity: { value: 0.85 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    });
    const cloud = new THREE.Mesh(cloudGeo, cloudMat);
    cloud.position.copy(p);
    cloud.scale.setScalar(U(spec.r) * 1.5);
    atomGroup.add(cloud);
    clouds.push(cloud);
    cloudMats.push(cloudMat);
  }

  // ---- bonds --------------------------------------------------------------
  const bondGeo = new THREE.CylinderGeometry(U(14 * PM), U(14 * PM), 1, detail(quality, 10, 5));
  const bondMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xd8d8e8).convertSRGBToLinear(),
    roughness: 0.35,
    transparent: true,
    opacity: 0.55,
  });
  const bondMeshes: THREE.Mesh[] = [];
  for (let i = 0; i < bonds.length; i++) {
    const m = new THREE.Mesh(bondGeo, bondMat);
    atomGroup.add(m);
    bondMeshes.push(m);
  }

  // ---- surrounding water --------------------------------------------------
  // DNA in a nucleus is in water, and at this scale water is not a background —
  // it is a crowd of molecules the same size as the ones we are looking at.
  const waterGeo = new THREE.IcosahedronGeometry(U(140 * PM), 1);
  const waterMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x4a7fd8).convertSRGBToLinear(),
    roughness: 0.2,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const WATER = count(quality, 700, 100);
  const water = new THREE.InstancedMesh(waterGeo, waterMat, WATER);
  const waterHome: THREE.Vector3[] = [];
  fillInstances(water, (_i, d) => {
    const p = new THREE.Vector3(
      (rng() - 0.5) * U(4500 * PM),
      (rng() - 0.5) * U(3500 * PM),
      (rng() - 0.4) * U(4000 * PM),
    );
    waterHome.push(p.clone());
    d.position.copy(p);
  });
  scene.add(water);

  const basePos = chain.map((a) => new THREE.Vector3(U(a.pos[0] * PM), U(a.pos[1] * PM), U(a.pos[2] * PM)));
  const live = basePos.map((p) => p.clone());
  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    const t = frame.elapsed;

    // Taper the electron density toward the bottom of the band.
    //
    // Band 11 opens on the atomic void, which is nearly black. Band 10 ends on
    // additive electron clouds, which are bright. A dissolve between a bright
    // image and a dark one changes brightness no matter how well the geometry
    // lines up, so this band dims into the hand-off rather than being cut away
    // from at full strength. It is also the physically right direction: heading
    // inward from the cloud toward the nucleus, the density really does fall.
    const taper = 1 - smoothstep01(0.55, 1.0, frame.u);

    // Thermal vibration. Bond stretching runs at tens of terahertz in reality;
    // slowed by many orders of magnitude here so it reads as a jitter rather
    // than as a blur. Amplitude is roughly right: a few picometres.
    for (let i = 0; i < live.length; i++) {
      const s = i * 2.399;
      live[i].set(
        basePos[i].x + Math.sin(t * 5.1 + s) * U(4 * PM),
        basePos[i].y + Math.sin(t * 6.3 + s * 1.7) * U(4 * PM),
        basePos[i].z + Math.sin(t * 4.4 + s * 2.3) * U(4 * PM),
      );
      cores[i].position.copy(live[i]);
      clouds[i].position.copy(live[i]);
      cloudMats[i].uniforms.uTime.value = t;
      cloudMats[i].uniforms.uDensity.value = 0.85 * taper;
    }

    for (let i = 0; i < bonds.length; i++) {
      const a = live[bonds[i][0]];
      const b = live[bonds[i][1]];
      dir.copy(b).sub(a);
      const len = dir.length();
      mid.copy(a).addScaledVector(dir, 0.5);
      const m = bondMeshes[i];
      m.position.copy(mid);
      m.quaternion.setFromUnitVectors(up, dir.normalize());
      m.scale.set(1, len, 1);
    }

    // Water diffuses past.
    for (let i = 0; i < WATER; i++) {
      const h = waterHome[i];
      const s = i * 1.618;
      dummy.position.set(
        h.x + Math.sin(t * 0.9 + s) * U(120 * PM),
        h.y + Math.cos(t * 1.1 + s * 1.3) * U(120 * PM),
        h.z + Math.sin(t * 0.7 + s * 2.1) * U(120 * PM),
      );
      dummy.updateMatrix();
      water.setMatrixAt(i, dummy.matrix);
    }
    water.instanceMatrix.needsUpdate = true;
    waterMat.opacity = 0.22 * taper;
    water.visible = taper > 0.02;
    bondMat.opacity = 0.55 * taper;
    for (const m of coreMats) {
      m.emissiveIntensity = taper;
      m.opacity = taper;
    }
    atomGroup.visible = taper > 0.02;

    atomGroup.rotation.y = Math.sin(t * 0.05) * 0.08;
  }

  function dispose(): void {
    coreGeo.dispose();
    cloudGeo.dispose();
    bondGeo.dispose();
    bondMat.dispose();
    waterGeo.dispose();
    waterMat.dispose();
    for (const m of coreMats) m.dispose();
    for (const m of cloudMats) m.dispose();
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

function smoothstep01(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
