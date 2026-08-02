import * as THREE from 'three';
import { LADDER, LOG_MAX, LOG_MIN } from './ladder.ts';
import { Compositor } from './compositor.ts';
import { distanceForWidth } from './rail.ts';
import { clamp, smootherstep } from './mathx.ts';
import { wrapOrigin } from './constants.ts';
import type { BandDef, BandFrame, BandInstance, QualitySettings } from './types.ts';

const UP = new THREE.Vector3(0, 1, 0);
const MAX_LOOK = THREE.MathUtils.degToRad(15);

export interface ActiveSlot {
  def: BandDef;
  instance: BandInstance;
  weight: number;
  u: number;
}

export interface WorldStatus {
  logScale: number;
  metresVisible: number;
  /** The band currently contributing most of the image. */
  primary: BandDef;
  /** The shallower of the two live bands. */
  upper: BandDef;
  /** The deeper live band during a dissolve, else null. */
  lower: BandDef | null;
  /** How much of the image the deeper band is contributing, 0..1. */
  blend: number;
  builtCount: number;
}

/**
 * Owns the band instances, decides which two are live, places their cameras and
 * drives the compositor.
 *
 * The invariant that makes 35 orders of magnitude possible: no band ever knows
 * about any other band, and no band ever holds a coordinate outside roughly
 * 0.01 .. 200 local units. All the enormous dynamic range lives in one Number —
 * `logScale` — and never touches a vertex buffer.
 */
export class World {
  private readonly instances = new Map<number, BandInstance>();
  private readonly compositor: Compositor;
  private readonly slots: ActiveSlot[] = [];

  private readonly _look = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();
  private readonly _mat = new THREE.Matrix4();
  private readonly _qBase = new THREE.Quaternion();
  private readonly _qOff = new THREE.Quaternion();
  private readonly _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _tintA = new THREE.Color(1, 1, 1);
  private readonly _tintB = new THREE.Color(1, 1, 1);

  private aspect = 16 / 9;
  private elapsed = 0;

  /** Debug: tint the two active bands so the overlap region is visible. */
  seamDebug = false;
  /** Debug: 0 freezes all in-band animation while leaving the camera live. */
  timeScale = 1;
  /** Most recent status, for the dev test hooks. */
  lastStatus: WorldStatus | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private quality: QualitySettings,
  ) {
    this.compositor = new Compositor(renderer, quality.level === 'low' ? 0 : 4);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.aspect = width / Math.max(1, height);
    this.compositor.setSize(width, height, pixelRatio);
  }

  setQuality(q: QualitySettings): void {
    this.quality = q;
    this.compositor.setSamples(q.level === 'low' ? 0 : 4);
    // Rebuild everything so instance counts and geometry detail take effect.
    for (const [i, inst] of this.instances) {
      inst.dispose();
      this.instances.delete(i);
    }
  }

  /** Which ladder entries contain this log scale. At most two by construction. */
  private resolve(logScale: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < LADDER.length; i++) {
      const b = LADDER[i];
      if (logScale <= b.logTop + 1e-9 && logScale >= b.logBot - 1e-9) out.push(i);
      if (out.length === 2) break;
    }
    if (out.length === 0) {
      // Only reachable if the ladder has a gap; fall back to the nearest band.
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < LADDER.length; i++) {
        const b = LADDER[i];
        const d = Math.min(Math.abs(logScale - b.logTop), Math.abs(logScale - b.logBot));
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      out.push(best);
    }
    return out;
  }

  private instanceFor(i: number): BandInstance {
    let inst = this.instances.get(i);
    if (!inst) {
      const def = LADDER[i];
      inst = def.build({ renderer: this.renderer, quality: this.quality, def });
      this.instances.set(i, inst);
    }
    return inst;
  }

  /** Builds the active bands plus one either side; frees everything else. */
  private manageResidency(activeIdx: number[]): void {
    const keep = new Set<number>();
    for (const i of activeIdx) {
      keep.add(i);
      if (i > 0) keep.add(i - 1);
      if (i < LADDER.length - 1) keep.add(i + 1);
    }
    for (const [i, inst] of [...this.instances]) {
      if (!keep.has(i)) {
        inst.dispose();
        this.instances.delete(i);
      }
    }
    for (const i of keep) this.instanceFor(i);
  }

  update(logScale: number, lookX: number, lookY: number, rawDt: number): WorldStatus {
    const dt = rawDt * this.timeScale;
    this.elapsed += dt;
    const L = clamp(logScale, LOG_MIN, LOG_MAX);
    const activeIdx = this.resolve(L);
    this.manageResidency(activeIdx);

    // --- cross-fade weights ---------------------------------------------
    this.slots.length = 0;
    if (activeIdx.length === 1) {
      this.slots.push({
        def: LADDER[activeIdx[0]],
        instance: this.instanceFor(activeIdx[0]),
        weight: 1,
        u: 0,
      });
    } else {
      const a = LADDER[activeIdx[0]];
      const b = LADDER[activeIdx[1]];
      // The overlap runs from b.logTop (where b appears) down to a.logBot
      // (where a is gone). Weights always sum to 1, so the dissolve never
      // brightens or darkens through the middle.
      const oTop = b.logTop;
      const oBot = a.logBot;
      const t = oTop === oBot ? 1 : (oTop - L) / (oTop - oBot);
      const s = smootherstep(0, 1, t);
      this.slots.push({ def: a, instance: this.instanceFor(activeIdx[0]), weight: 1 - s, u: 0 });
      this.slots.push({ def: b, instance: this.instanceFor(activeIdx[1]), weight: s, u: 0 });
    }

    // --- drive each live band -------------------------------------------
    for (const slot of this.slots) {
      const def = slot.def;
      const realSpan = def.logTop - def.logBot;
      const descended = def.logTop - L;
      slot.u = clamp(descended / realSpan, 0, 1);

      const dollySpan = def.wrapDecades ?? def.localSpan;
      let uLocal: number;
      let wrapIndex = 0;
      if (def.wrapDecades) {
        // Anchored to the global decade grid, not to this band's logTop, so
        // that two overlapping wrapping bands are always at the same phase.
        const w = (wrapOrigin(def.logTop, def.wrapDecades) - L) / def.wrapDecades;
        wrapIndex = Math.floor(w);
        uLocal = w - wrapIndex;
      } else {
        uLocal = clamp(descended / def.localSpan, 0, 1);
      }

      const localWidth = def.localTopWidth * Math.pow(10, -dollySpan * uLocal);

      const cam = slot.instance.camera;
      if (cam.aspect !== this.aspect) {
        cam.aspect = this.aspect;
      }
      const focus = distanceForWidth(localWidth, cam);

      // Camera placement: derived from scale, never authored directly.
      const roll = slot.instance.rail.sample(uLocal, this._look, this._dir);
      cam.position.copy(this._look).addScaledVector(this._dir, focus);

      this._mat.lookAt(cam.position, this._look, UP);
      this._qBase.setFromRotationMatrix(this._mat);
      this._euler.set(-lookY * MAX_LOOK, -lookX * MAX_LOOK, roll);
      this._qOff.setFromEuler(this._euler);
      cam.quaternion.copy(this._qBase).multiply(this._qOff);

      // Depth range is re-derived from the focus distance every frame. This is
      // the second half of why precision never fails: the near/far ratio stays
      // fixed at ~4e5 regardless of whether we are looking at a man or a quark.
      cam.near = focus * 0.004;
      cam.far = focus * 1600;
      cam.updateProjectionMatrix();

      const frame: BandFrame = {
        u: slot.u,
        uLocal,
        wrapIndex,
        logScale: L,
        metresVisible: Math.pow(10, L),
        localWidth,
        focusDistance: focus,
        weight: slot.weight,
        dt,
        elapsed: this.elapsed,
      };
      slot.instance.update(frame);
    }

    const upper = this.slots[0];
    const lower = this.slots.length > 1 ? this.slots[1] : null;
    this.lastStatus = {
      logScale: L,
      metresVisible: Math.pow(10, L),
      // `primary` is whichever band is currently doing most of the picture —
      // that is the one the HUD should name. `upper`/`lower` are always in
      // ladder order so the debug line can report the pair honestly.
      primary: lower && lower.weight > upper.weight ? lower.def : upper.def,
      upper: upper.def,
      lower: lower ? lower.def : null,
      blend: lower ? lower.weight : 0,
      builtCount: this.instances.size,
    };
    return this.lastStatus;
  }

  render(): void {
    if (this.seamDebug) {
      this._tintA.setRGB(1.0, 0.35, 0.35);
      this._tintB.setRGB(0.35, 0.85, 1.0);
    } else {
      this._tintA.setRGB(1, 1, 1);
      this._tintB.setRGB(1, 1, 1);
    }

    const a = this.slots[0];
    this.compositor.renderBand(0, a.instance.scene, a.instance.camera);

    const b = this.slots[1];
    if (b && b.weight > 0.0005) {
      this.compositor.renderBand(1, b.instance.scene, b.instance.camera);
      this.compositor.present(a.weight, b.weight, this._tintA, this._tintB);
    } else {
      this.compositor.present(1, 0, this._tintA, this._tintB);
    }
  }

  dispose(): void {
    for (const inst of this.instances.values()) inst.dispose();
    this.instances.clear();
    this.compositor.dispose();
  }
}
