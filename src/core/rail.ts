import * as THREE from 'three';
import { clamp } from './mathx.ts';

/**
 * The camera rail.
 *
 * A band's camera is never placed directly. Instead we author two things:
 *
 *   look(u)  — the point in local space we are flying toward
 *   dir(u)   — the direction from that point back toward the camera
 *
 * and then the camera is placed at  look(u) + normalize(dir(u)) * distance,
 * where `distance` is whatever it takes to make the requested number of local
 * units span the screen. That inversion is what keeps the scale readout honest:
 * framing is derived from scale, not the other way round.
 *
 * Because `distance` shrinks exponentially with u, the camera plunges toward a
 * target that is itself drifting along a curve — which is what produces the
 * "falling into a pore" feel rather than a flat dolly.
 */

export interface RailKey {
  /** Point being flown toward, in local units. */
  look: THREE.Vector3Tuple;
  /** Direction from `look` back toward the camera. Normalized internally. */
  dir: THREE.Vector3Tuple;
  /** Camera roll in radians. Optional, defaults to 0. */
  roll?: number;
}

export class Rail {
  private readonly lookCurve: THREE.CatmullRomCurve3;
  private readonly dirCurve: THREE.CatmullRomCurve3;
  private readonly rolls: number[];

  constructor(keys: RailKey[]) {
    if (keys.length < 2) {
      throw new Error('Rail needs at least two keys');
    }
    const lookPts = keys.map((k) => new THREE.Vector3().fromArray(k.look));
    const dirPts = keys.map((k) => new THREE.Vector3().fromArray(k.dir).normalize());

    // 'centripetal' avoids the cusps and overshoot that uniform Catmull-Rom
    // produces when control points are unevenly spaced.
    this.lookCurve = new THREE.CatmullRomCurve3(lookPts, false, 'centripetal', 0.5);
    this.dirCurve = new THREE.CatmullRomCurve3(dirPts, false, 'catmullrom', 0.5);
    this.rolls = keys.map((k) => k.roll ?? 0);
  }

  /** Writes look point and unit direction for progress u in [0,1]. */
  sample(u: number, outLook: THREE.Vector3, outDir: THREE.Vector3): number {
    const t = clamp(u, 0, 1);
    this.lookCurve.getPoint(t, outLook);
    this.dirCurve.getPoint(t, outDir);
    if (outDir.lengthSq() < 1e-12) outDir.set(0, 0, 1);
    outDir.normalize();
    return this.sampleRoll(t);
  }

  private sampleRoll(t: number): number {
    const n = this.rolls.length - 1;
    const f = clamp(t, 0, 1) * n;
    const i = Math.min(n - 1, Math.floor(f));
    const frac = f - i;
    return this.rolls[i] * (1 - frac) + this.rolls[i + 1] * frac;
  }

  /** Debug helper: a polyline of the look path. */
  buildDebugLine(color = 0x44ff88): THREE.Line {
    const pts = this.lookCurve.getPoints(160);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
  }
}

/**
 * How far the camera must sit from a plane for `width` local units to span the
 * screen horizontally.
 */
export function distanceForWidth(width: number, camera: THREE.PerspectiveCamera): number {
  const vFovHalf = THREE.MathUtils.degToRad(camera.fov) * 0.5;
  const hHalfTan = Math.tan(vFovHalf) * camera.aspect;
  return width * 0.5 / Math.max(1e-9, hHalfTan);
}

/** Inverse of the above: local units spanned at a given camera distance. */
export function widthAtDistance(distance: number, camera: THREE.PerspectiveCamera): number {
  const vFovHalf = THREE.MathUtils.degToRad(camera.fov) * 0.5;
  return distance * Math.tan(vFovHalf) * camera.aspect * 2;
}
