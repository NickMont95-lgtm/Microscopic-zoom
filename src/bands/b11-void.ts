import * as THREE from 'three';
import type { BandContext, BandFrame, BandInstance } from '../core/types.ts';
import { detail, disposeScene, makeRail, makeRng, makeScaffold, realToLocal } from './common.ts';
import { makeField } from './field.ts';

/**
 * BAND 11 — The atomic void (141 pm → 10 fm across the screen)
 *
 * Four decades of almost nothing, and that emptiness is the point of the band.
 *
 * An atom is about 10⁻¹⁰ m across. Its nucleus is about 10⁻¹⁴ m — one
 * hundred-thousandth of the width, and about 10⁻¹⁵ of the volume — yet it holds
 * over 99.9% of the mass. Scaled up so the nucleus is a 1 cm marble, the nearest
 * electron density would be about half a kilometre away, with nothing in
 * between. Solid matter is a lie told by electromagnetic repulsion.
 *
 * So this band deliberately gives the viewer a long fall through emptiness: the
 * electron cloud thins out and vanishes behind, there is a very long stretch of
 * effectively nothing, and only at the very end does the nucleus resolve out of
 * a point into packed nucleons.
 *
 * The nucleus modelled is phosphorus-31 — 15 protons, 16 neutrons — since we
 * came down through the DNA backbone. Nucleons are ~1.7 fm across and the whole
 * nucleus is about 7 fm, following the usual R = 1.2 fm × A^(1/3).
 */

const METRES_PER_UNIT = Math.pow(10, -9) / 60; // wrapping band: one decade per window
const L = 1 / METRES_PER_UNIT;
void L;

const FM = 1e-15;
const NUCLEON_R = 0.85 * FM;
const A = 31; // phosphorus-31
const NUCLEUS_R = 1.2 * FM * Math.cbrt(A); // ≈ 3.7 fm radius, ~7.4 fm across

export function makeVoidBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;
  const rng = makeRng(1111);

  // Nearly straight: there is nothing out here to fly around.
  const rail = makeRail([
    { p: [0, 0, 0.6] },
    { p: [0.05, 0.02, 0.2] },
    { p: [0.01, 0.005, 0.05] },
    { p: [0, 0, 0] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    fogFactor: 0,
    keyColor: 0xfff0e0,
    fillColor: 0x6080ff,
    rimColor: 0xff9060,
    keyPower: 2.2,
    fillPower: 0.8,
    rimPower: 1.2,
    hemiSky: 0x101024,
    hemiGround: 0x02020a,
    hemiPower: 0.25,
  });
  const { scene } = sc;

  // ---- the electron cloud we are leaving ---------------------------------
  // We start inside it, so it is drawn as an inward-facing shell that thins to
  // nothing over the first decade.
  const cloudMat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vLocal;
      uniform float uOpacity;
      uniform float uTime;
      void main() {
        float r = length(vLocal);
        float d = smoothstep(0.35, 1.0, r) * uOpacity;
        d *= 0.75 + 0.25 * sin(vLocal.x * 4.0 + uTime * 0.4) * sin(vLocal.y * 3.0 - uTime * 0.3);
        // Warm, to match the phosphorus cloud band 10 hands over from.
        gl_FragColor = vec4(vec3(1.0, 0.55, 0.22) * d, d);
      }`,
    uniforms: { uOpacity: { value: 1 }, uTime: { value: 0 } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const cloud = new THREE.Mesh(new THREE.IcosahedronGeometry(1, detail(quality, 4, 2)), cloudMat);
  scene.add(cloud);

  // ---- the vacuum --------------------------------------------------------
  // Not literally nothing: quantum vacuum fluctuation, drawn extremely faint.
  // Its job is to give the eye just enough to register that it is still moving.
  const field = makeField({
    quality,
    slices: 9,
    extent: 26,
    depth: 60,
    density: 0.14,
    flow: 0.25,
    contrast: 3.2,
    scale: 0.05,
    colorA: 0x18244f,
    colorB: 0x3a2a5e,
  });
  sc.camera.add(field.mesh);
  field.mesh.position.z = -30;

  // ---- the nucleus -------------------------------------------------------
  // Placed at the rail's end point and rescaled every frame to its true
  // physical size. That is what lets it start far below one pixel and grow to
  // fill the frame across four decades without any geometry changing.
  const nucleusGroup = new THREE.Group();
  scene.add(nucleusGroup);

  const protonMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xff6b4a).convertSRGBToLinear(),
    roughness: 0.42,
    emissive: new THREE.Color(0x35100a).convertSRGBToLinear(),
  });
  const neutronMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x9fb4d8).convertSRGBToLinear(),
    roughness: 0.45,
    emissive: new THREE.Color(0x0e1420).convertSRGBToLinear(),
  });
  const nucleonGeo = new THREE.IcosahedronGeometry(1, detail(quality, 3, 2));

  const protons = new THREE.InstancedMesh(nucleonGeo, protonMat, 15);
  const neutrons = new THREE.InstancedMesh(nucleonGeo, neutronMat, 16);
  protons.frustumCulled = false;
  neutrons.frustumCulled = false;
  nucleusGroup.add(protons, neutrons);

  // Nucleon home positions, packed inside the nuclear radius.
  const homes: THREE.Vector3[] = [];
  for (let i = 0; i < A; i++) {
    let p: THREE.Vector3;
    let tries = 0;
    do {
      p = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
    } while (p.lengthSq() > 1 && ++tries < 50);
    // Scaled so nucleons fill the nucleus without much overlap.
    homes.push(p.multiplyScalar(NUCLEUS_R - NUCLEON_R * 0.9));
  }

  const dummy = new THREE.Object3D();

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    field.update(frame);
    const t = frame.elapsed;
    cloudMat.uniforms.uTime.value = t;

    // The electron cloud is gone within the first decade of the fall.
    const cloudFade = Math.max(0, 1 - frame.u * 3.4);
    cloudMat.uniforms.uOpacity.value = cloudFade * 0.5;
    cloud.visible = cloudFade > 0.005;
    // Sized as a real 150 pm shell, so it recedes at the correct rate.
    const cloudR = realToLocal(frame, 150e-12);
    cloud.scale.setScalar(cloudR);
    cloud.position.copy(sc.camera.position);

    // The nucleus, at its true size in the current local units.
    const nucR = realToLocal(frame, NUCLEUS_R);
    const nucleonR = realToLocal(frame, NUCLEON_R);
    nucleusGroup.visible = nucR > 1e-4;

    if (nucleusGroup.visible) {
      let ip = 0;
      let inn = 0;
      for (let i = 0; i < A; i++) {
        const h = homes[i];
        const s = i * 2.7;
        // Nucleons jostle: the nucleus is a liquid drop, not a crystal.
        const jitter = NUCLEON_R * 0.35;
        dummy.position.set(
          (h.x + Math.sin(t * 1.7 + s) * jitter) / NUCLEUS_R * nucR,
          (h.y + Math.sin(t * 2.1 + s * 1.4) * jitter) / NUCLEUS_R * nucR,
          (h.z + Math.sin(t * 1.4 + s * 2.2) * jitter) / NUCLEUS_R * nucR,
        );
        dummy.scale.setScalar(nucleonR);
        dummy.quaternion.identity();
        dummy.updateMatrix();
        if (i < 15) protons.setMatrixAt(ip++, dummy.matrix);
        else neutrons.setMatrixAt(inn++, dummy.matrix);
      }
      protons.instanceMatrix.needsUpdate = true;
      neutrons.instanceMatrix.needsUpdate = true;
    }
  }

  function dispose(): void {
    cloud.geometry.dispose();
    cloudMat.dispose();
    nucleonGeo.dispose();
    protonMat.dispose();
    neutronMat.dispose();
    field.dispose();
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
