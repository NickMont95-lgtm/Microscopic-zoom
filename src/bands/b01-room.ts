import * as THREE from 'three';
import type { BandContext, BandFrame, BandInstance } from '../core/types.ts';
import { buildFigure, loadHeadModel, type Figure } from './figure.ts';
import { detail, disposeScene, makeRail, makeScaffold } from './common.ts';

/**
 * BAND 1 — The room (2.24 m → 100 mm across the screen)
 *
 * A man of about 35 standing in a plain room under soft studio light. The
 * camera opens 1.52 m (5 ft) from his face at a 16:9 window and drifts in to
 * land on his upper cheek, just lateral to the nose and above the beard line.
 *
 * Lighting here is fixed in the room rather than parented to the camera. That
 * is the physically honest choice for this band: moving closer to a lit face
 * does not change how the face is lit.
 */

const METRES_PER_UNIT = Math.pow(10, 0.35) / 60; // ≈ 0.0373 m per local unit
const S = 1 / METRES_PER_UNIT; // metres → local units

export function makeRoomBand(ctx: BandContext): BandInstance {
  const { quality } = ctx;

  // ---- the man -----------------------------------------------------------
  const figure: Figure = buildFigure(detail(quality, 6, 4));
  figure.root.scale.setScalar(S);

  // Look path, in local units. The camera opens on head-and-shoulders, rises to
  // the face, then settles onto the cheek. The target comes from the figure so
  // it cannot drift out of sync when the anatomy is adjusted.
  const cheek = figure.cheekPoint.clone().multiplyScalar(S);
  const rail = makeRail([
    { p: [0, 1.50 * S, 0] },
    { p: [-0.10 * S, 1.60 * S, 0.012 * S], roll: 0.01 },
    { p: [cheek.x * 0.65, 1.645 * S, cheek.z * 0.55], roll: 0.02 },
    { p: [cheek.x, cheek.y, cheek.z] },
  ]);

  const sc = makeScaffold({
    def: ctx.def,
    quality,
    rail,
    fov: 45,
    cameraLights: false,
    fogFactor: 0.05,
    hemiSky: 0x9fb2c8,
    hemiGround: 0x3a342e,
    hemiPower: 1.25,
  });
  const { scene } = sc;

  // ---- room -------------------------------------------------------------
  // 7 m × 3.2 m × 8 m, neutral warm grey, seen from inside.
  const roomMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x8a8681).convertSRGBToLinear(),
    roughness: 0.94,
    metalness: 0,
    side: THREE.BackSide,
  });
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(6 * S, 3.0 * S, 7 * S),
    roomMat,
  );
  room.position.set(0, 1.5 * S, -1.6 * S);
  scene.add(room);

  const floorMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x6d6a66).convertSRGBToLinear(),
    roughness: 0.86,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6 * S, 7 * S), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.001 * S, -1.6 * S);
  scene.add(floor);

  // Cheap contact shadow: a soft dark ellipse under the feet. A real shadow map
  // would cost more than it is worth for a figure that leaves frame in seconds.
  const shadowTex = makeRadialTexture();
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9 * S, 0.6 * S),
    new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      opacity: 0.55,
      color: 0x000000,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.004 * S, 0.02 * S);
  scene.add(shadow);

  // ---- studio lighting ---------------------------------------------------
  // Intensities are quoted in metre-units and converted, because a point light
  // with inverse-square falloff has to be restated whenever the unit of length
  // changes. `lamp(watts, x, y, z)` reads in metres and does the conversion.
  function lamp(color: number, power: number, x: number, y: number, z: number): THREE.PointLight {
    const l = new THREE.PointLight(color, power * S * S, 0, 2);
    l.position.set(x * S, y * S, z * S);
    scene.add(l);
    return l;
  }

  // Key through a large softbox, high and camera-left.
  lamp(0xfff1e0, 46, -1.4, 2.3, 1.7);
  // Broad bounce fill on the opposite side, cooler and much weaker.
  lamp(0xdfe9f6, 16, 1.9, 1.4, 1.5);
  // Cool rim from behind, to lift him off the wall.
  lamp(0xd2e2ff, 26, 1.2, 2.2, -1.9);
  // Floor bounce back into the underside of the jaw.
  lamp(0xffe4c6, 9, 0, 0.25, 1.3);
  // Two lamps washing the back wall so the room reads as a room rather than as
  // a void. Without these the figure floats in black.
  lamp(0xb9c6d8, 30, -2.2, 2.2, -3.4);
  lamp(0xb9c6d8, 30, 2.2, 2.2, -3.4);

  scene.add(figure.root);

  // If a real head model has been dropped into public/models/, swap it in.
  let swapped: THREE.Object3D | null = null;
  void loadHeadModel(`${import.meta.env.BASE_URL}models/head.glb`).then((obj) => {
    if (!obj) return;
    obj.scale.setScalar(S);
    obj.position.copy(figure.head.position).multiplyScalar(S);
    figure.head.visible = false;
    swapped = obj;
    scene.add(obj);
  });

  function update(frame: BandFrame): void {
    sc.updateCommon(frame);
    figure.update(frame.elapsed);
  }

  function dispose(): void {
    figure.dispose();
    if (swapped) scene.remove(swapped);
    shadowTex.dispose();
    disposeScene(scene);
  }

  return {
    scene,
    camera: sc.camera,
    rail,
    background: sc.background,
    fogFactor: 0.05,
    update,
    dispose,
  };
}

function makeRadialTexture(): THREE.Texture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.65)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
