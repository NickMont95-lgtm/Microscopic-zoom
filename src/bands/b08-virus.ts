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
 * BAND 8 — Viral particles (178 nm → 25 nm across the screen)
 *
 * Shown for scale contrast, and because one of them provides the way into the
 * nucleus.
 *
 *   - Adenovirus: a non-enveloped icosahedral capsid about 90 nm across,
 *     T = 25, built from 240 hexon capsomers on the faces and 12 penton bases
 *     at the vertices. A fibre projects from each penton, ending in a knob —
 *     that knob is what binds the host receptor.
 *   - Rhinovirus: a picornavirus, ~30 nm, non-enveloped, much smoother; the
 *     receptor-binding site sits in a surface canyon.
 *
 * The docking beat is real biology, not invention: adenovirus is trafficked
 * along microtubules to the nuclear pore complex, binds it, and releases its
 * DNA genome through the pore into the nucleus. That is the transition into
 * band 9.
 *
 * From here down, note that we are past what light can resolve. Visible light
 * bottoms out around 200 nm; everything below is electron microscopy and
 * structural models, drawn with colours that are conventions, not observations.
 */

const METRES_PER_UNIT = Math.pow(10, -6.75) / 60; // ≈ 2.96 nm per local unit
const L = 1 / METRES_PER_UNIT;
const U = (m: number) => m * L;

const ADENO_R = 45e-9; // 90 nm across
const FIBRE_LEN = 30e-9;
const RHINO_R = 15e-9; // 30 nm across
const NPC_R = 60e-9; // nuclear pore complex, ~120 nm across

export function makeVirusBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;
  const rng = makeRng(8080);

  const rail = makeRail([
    { p: [0, 0, U(150e-9)] },
    { p: [U(12e-9), U(6e-9), U(45e-9)], roll: 0.02 },
    { p: [U(4e-9), U(2e-9), U(2e-9)], roll: 0.04 },
    { p: [0, 0, U(-22e-9)] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    fogFactor: 0.24,
    keyColor: 0xdfe8ff,
    fillColor: 0x86c8d8,
    rimColor: 0xb9a8ff,
    keyPower: 5.0,
    fillPower: 2.1,
    rimPower: 2.6,
    keyOffset: [0.95, 0.85, 0.6],
    fillOffset: [-1.0, -0.6, 0.45],
    rimOffset: [-0.25, 0.45, -1.2],
    hemiSky: 0x28374e,
    hemiGround: 0x080a12,
    hemiPower: 0.85,
  });
  const { scene } = sc;

  // ---- nuclear envelope and a pore complex --------------------------------
  // The wall we are heading for. The pore is the door into band 9.
  // Plain transparency rather than MeshPhysicalMaterial transmission.
  // Transmission makes three.js render the whole scene an extra time into a
  // back buffer every frame, per material that uses it. Across bands 4-8 that
  // was several full extra passes for droplets and membranes whose refraction
  // nobody can see through an already-translucent stack.
  const envMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x6a5fa8).convertSRGBToLinear(),
    roughness: 0.45,
    transparent: true,
    opacity: 0.88,
    side: THREE.DoubleSide,
  });
  const envelope = new THREE.Mesh(new THREE.PlaneGeometry(U(1400e-9), U(1400e-9), 40, 40), envMat);
  envelope.position.z = U(-140e-9);
  // Gently domed rather than flat, so it reads as a surface of a large body.
  {
    const pos = envelope.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      pos.setZ(i, -(x * x + y * y) * 0.00018);
    }
    envelope.geometry.computeVertexNormals();
  }
  scene.add(envelope);

  const npc = new THREE.Group();
  npc.position.set(0, 0, U(-138e-9));
  scene.add(npc);
  const npcMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xcfc2ff).convertSRGBToLinear(),
    roughness: 0.4,
  });
  // Eightfold rotational symmetry — the defining feature of the NPC.
  const spokeGeo = new THREE.CapsuleGeometry(U(9e-9), U(26e-9), detail(quality, 8, 4), detail(quality, 16, 8));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const spoke = new THREE.Mesh(spokeGeo, npcMat);
    spoke.position.set(Math.cos(a) * U(NPC_R * 0.72), Math.sin(a) * U(NPC_R * 0.72), 0);
    spoke.rotation.z = a;
    npc.add(spoke);
  }
  const npcRing = new THREE.Mesh(
    new THREE.TorusGeometry(U(NPC_R * 0.72), U(7e-9), detail(quality, 14, 8), detail(quality, 56, 28)),
    npcMat,
  );
  npc.add(npcRing);

  // ---- adenovirus ---------------------------------------------------------
  const adeno = buildAdenovirus(quality.detailScale);
  adeno.group.position.set(U(6e-9), U(4e-9), U(30e-9));
  scene.add(adeno.group);

  // Two more tumbling in the background.
  const adeno2 = buildAdenovirus(quality.detailScale * 0.7);
  adeno2.group.position.set(U(-190e-9), U(90e-9), U(-40e-9));
  scene.add(adeno2.group);
  const adeno3 = buildAdenovirus(quality.detailScale * 0.7);
  adeno3.group.position.set(U(160e-9), U(-120e-9), U(60e-9));
  scene.add(adeno3.group);

  // ---- rhinoviruses -------------------------------------------------------
  // A third the diameter of the adenovirus, so about a 27th of the volume.
  const rhinoGeo = makeRhinovirusGeometry(subdiv(quality, 3, 2));
  const rhinoMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x6fd6b0).convertSRGBToLinear(),
    roughness: 0.4,
    metalness: 0,
  });
  const rhinoMotion = applyGpuMotion(rhinoMat, { drift: U(6e-9), driftRate: 0.9, spin: 0.28 });
  const RHINO = count(quality, 24, 6);
  const rhinos = new THREE.InstancedMesh(rhinoGeo, rhinoMat, RHINO);
  fillInstances(rhinos, (_i, d) => {
    d.position.set(
      (rng() - 0.5) * U(900e-9),
      (rng() - 0.5) * U(700e-9),
      (rng() - 0.3) * U(500e-9),
    );
    d.scale.setScalar(U(RHINO_R));
  });
  scene.add(rhinos);

  // ---- cytosolic crowding -------------------------------------------------
  // Cytoplasm is not empty; it is a dense solution of protein. Small blobs at
  // 5-10 nm keep the shot from looking like objects floating in vacuum.
  const crowdGeo = new THREE.IcosahedronGeometry(U(3.5e-9), subdiv(quality, 1, 1));
  const crowdMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x5b7f96).convertSRGBToLinear(),
    roughness: 0.7,
    transparent: true,
    opacity: 0.7,
  });
  const crowdMotion = applyGpuMotion(crowdMat, { drift: U(9e-9), driftRate: 3.0, spin: 0.8 });
  const CROWD = count(quality, 1400, 200);
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, CROWD);
  fillInstances(crowd, (_i, d) => {
    d.position.set(
      (rng() - 0.5) * U(1000e-9),
      (rng() - 0.5) * U(800e-9),
      (rng() - 0.35) * U(600e-9),
    );
    d.scale.setScalar(0.6 + rng() * 1.4);
  });
  scene.add(crowd);

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    const t = frame.elapsed;
    rhinoMotion.uniforms.uTime.value = t;
    crowdMotion.uniforms.uTime.value = t;

    // The hero particle drifts down onto the pore and docks. Its fibres are
    // what make contact — that is how adenovirus binds.
    const dock = Math.min(1, Math.max(0, (t % 26) / 14));
    const ease = dock * dock * (3 - 2 * dock);
    adeno.group.position.set(
      U(6e-9) * (1 - ease) + Math.sin(t * 0.4) * U(3e-9) * (1 - ease),
      U(4e-9) * (1 - ease) + Math.cos(t * 0.35) * U(3e-9) * (1 - ease),
      U(30e-9) * (1 - ease) + U(-72e-9) * ease,
    );
    adeno.group.rotation.x += frame.dt * 0.09 * (1 - ease);
    adeno.group.rotation.y += frame.dt * 0.13 * (1 - ease);

    adeno2.group.rotation.x += frame.dt * 0.16;
    adeno2.group.rotation.z += frame.dt * 0.1;
    adeno3.group.rotation.y += frame.dt * 0.12;
    adeno3.group.rotation.z -= frame.dt * 0.07;

    npc.rotation.z = t * 0.05;
    // The envelope undulates slowly, as a membrane does.
    envelope.position.z = U(-140e-9) + Math.sin(t * 0.4) * U(4e-9);
  }

  function dispose(): void {
    envMat.dispose();
    envelope.geometry.dispose();
    npcMat.dispose();
    spokeGeo.dispose();
    npcRing.geometry.dispose();
    rhinoGeo.dispose();
    rhinoMat.dispose();
    crowdGeo.dispose();
    crowdMat.dispose();
    adeno.dispose();
    adeno2.dispose();
    adeno3.dispose();
    disposeScene(scene);
  }

  return {
    scene,
    camera: sc.camera,
    rail,
    background: sc.background,
    fogFactor: 0.24,
    update,
    dispose,
  };
}

/**
 * Adenovirus: an icosahedral shell of hexon capsomers, penton bases at the 12
 * vertices, and a fibre with a terminal knob projecting from each penton.
 */
function buildAdenovirus(detailScale: number): {
  group: THREE.Group;
  dispose(): void;
} {
  const group = new THREE.Group();

  const shellGeo = new THREE.IcosahedronGeometry(U(ADENO_R * 0.94), 2);
  const shellMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x8fa8d8).convertSRGBToLinear(),
    roughness: 0.5,
    flatShading: true,
  });
  group.add(new THREE.Mesh(shellGeo, shellMat));

  // Hexons: capsomers tiling the 20 faces. Placed on the icosahedron's face
  // triangles so the packing reads as the real T = 25 lattice rather than as
  // random bumps.
  const hexGeo = new THREE.CylinderGeometry(U(4.2e-9), U(5.0e-9), U(5e-9), 6, 1);
  const hexMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xa9c0e8).convertSRGBToLinear(),
    roughness: 0.45,
  });
  const base = new THREE.IcosahedronGeometry(1, 0);
  const pos = base.attributes.position as THREE.BufferAttribute;
  const rows = Math.max(3, Math.round(8 * detailScale));
  const hexList: THREE.Matrix4[] = [];
  const d = new THREE.Object3D();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let f = 0; f < pos.count; f += 3) {
    a.fromBufferAttribute(pos, f);
    b.fromBufferAttribute(pos, f + 1);
    c.fromBufferAttribute(pos, f + 2);
    for (let i = 0; i <= rows; i++) {
      for (let j = 0; j <= rows - i; j++) {
        const k = rows - i - j;
        p.set(0, 0, 0)
          .addScaledVector(a, i / rows)
          .addScaledVector(b, j / rows)
          .addScaledVector(c, k / rows)
          .normalize();
        d.position.copy(p).multiplyScalar(U(ADENO_R));
        d.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p);
        d.scale.setScalar(1);
        d.updateMatrix();
        hexList.push(d.matrix.clone());
      }
    }
  }
  base.dispose();
  const hexons = new THREE.InstancedMesh(hexGeo, hexMat, hexList.length);
  for (let i = 0; i < hexList.length; i++) hexons.setMatrixAt(i, hexList[i]);
  hexons.instanceMatrix.needsUpdate = true;
  hexons.frustumCulled = false;
  group.add(hexons);

  // Pentons and fibres at the 12 vertices.
  const fibreMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xe8dcc0).convertSRGBToLinear(),
    roughness: 0.5,
  });
  const fibreGeo = new THREE.CylinderGeometry(U(1.4e-9), U(1.9e-9), U(FIBRE_LEN), 10);
  const knobGeo = new THREE.IcosahedronGeometry(U(3.6e-9), 2);
  const pentonGeo = new THREE.CylinderGeometry(U(5.5e-9), U(6.5e-9), U(6e-9), 5);

  const phi = (1 + Math.sqrt(5)) / 2;
  const verts: THREE.Vector3[] = [];
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      verts.push(new THREE.Vector3(0, s1, s2 * phi).normalize());
      verts.push(new THREE.Vector3(s1, s2 * phi, 0).normalize());
      verts.push(new THREE.Vector3(s1 * phi, 0, s2).normalize());
    }
  }
  const up = new THREE.Vector3(0, 1, 0);
  for (const v of verts) {
    const q = new THREE.Quaternion().setFromUnitVectors(up, v);
    const penton = new THREE.Mesh(pentonGeo, fibreMat);
    penton.position.copy(v).multiplyScalar(U(ADENO_R));
    penton.quaternion.copy(q);
    group.add(penton);

    const fibre = new THREE.Mesh(fibreGeo, fibreMat);
    fibre.position.copy(v).multiplyScalar(U(ADENO_R + FIBRE_LEN * 0.5));
    fibre.quaternion.copy(q);
    group.add(fibre);

    const knob = new THREE.Mesh(knobGeo, fibreMat);
    knob.position.copy(v).multiplyScalar(U(ADENO_R + FIBRE_LEN));
    group.add(knob);
  }

  return {
    group,
    dispose() {
      shellGeo.dispose();
      shellMat.dispose();
      hexGeo.dispose();
      hexMat.dispose();
      fibreGeo.dispose();
      knobGeo.dispose();
      pentonGeo.dispose();
      fibreMat.dispose();
    },
  };
}

/** Rhinovirus: a small, smooth icosahedral capsid with surface canyons. */
function makeRhinovirusGeometry(subdiv: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, subdiv);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.normalize();
    // A shallow depression around each fivefold axis: the receptor canyon.
    const bump = 1 + 0.07 * Math.cos(v.x * 6) * Math.cos(v.y * 6) * Math.cos(v.z * 6);
    pos.setXYZ(i, v.x * bump, v.y * bump, v.z * bump);
  }
  geo.computeVertexNormals();
  return geo;
}
