import * as THREE from 'three';
import type { Rail } from './rail.ts';

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  level: QualityLevel;
  /** Multiplier applied to every instanced-object count in the scene. */
  instanceScale: number;
  /** Hard cap on device pixel ratio. */
  maxPixelRatio: number;
  /** Subdivision multiplier for procedural geometry. */
  detailScale: number;
}

/**
 * `detailScale` multiplies LINEAR segment counts (see `detail()`), and shifts
 * subdivision LEVELS by whole steps (see `subdiv()`). The two must not be
 * confused: an icosahedron's face count grows as 4^level, so multiplying a
 * subdivision level by 1.6 turns 80k triangles into 21 million.
 */
export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: { level: 'low', instanceScale: 0.35, maxPixelRatio: 1, detailScale: 0.55 },
  medium: { level: 'medium', instanceScale: 0.7, maxPixelRatio: 1.5, detailScale: 0.85 },
  high: { level: 'high', instanceScale: 1.25, maxPixelRatio: 2, detailScale: 1.3 },
  ultra: { level: 'ultra', instanceScale: 1.9, maxPixelRatio: 2, detailScale: 1.9 },
};

/** Everything a band needs at construction time. */
export interface BandContext {
  renderer: THREE.WebGLRenderer;
  quality: QualitySettings;
  def: BandDef;
}

/** Per-frame information handed to a band's update(). */
export interface BandFrame {
  /** 0 at the top (widest) edge of this band, 1 at the bottom (deepest). */
  u: number;
  /**
   * Progress through the current dolly window, 0..1. Identical to `u` unless
   * the band sets `wrapDecades`, in which case it sawtooths once per window.
   */
  uLocal: number;
  /** Which dolly window we are in. Always 0 for non-wrapping bands. */
  wrapIndex: number;
  /** Global log10(metres visible across the screen). */
  logScale: number;
  /** Metres visible across the screen right now. */
  metresVisible: number;
  /** Local-space units visible across the screen right now. */
  localWidth: number;
  /** Distance from camera to the rail's look target, in local units. */
  focusDistance: number;
  /** Composite weight 0..1 — useful for skipping work on a nearly-invisible band. */
  weight: number;
  dt: number;
  elapsed: number;
}

/** A live, built band. */
export interface BandInstance {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  rail: Rail;
  /** Solid backdrop colour. Cross-fades between bands dissolve between these. */
  background: THREE.Color;
  /** Fog density is expressed per unit of focus distance; 0 disables fog. */
  fogFactor: number;
  update(frame: BandFrame): void;
  dispose(): void;
}

/**
 * Static description of one rung of the zoom ladder.
 *
 * `logTop` / `logBot` are real-world: log10 of the metres visible across the
 * screen at the top and bottom of the band. Consecutive bands deliberately
 * overlap — that overlap region is where the cross-fade happens.
 *
 * `localSpan` is how many decades of *local* camera dolly the band performs.
 * It is capped (default 3) because float32 geometry cannot survive more than
 * that. A band whose real span is wider than its local span simply dollies
 * more slowly than the readout descends; such bands must be built from
 * scale-free procedural content (noise fields), not modelled geometry.
 */
export interface BandDef {
  /** 1-based, matching the ladder in the design brief. */
  index: number;
  id: string;
  name: string;
  caption: string;
  logTop: number;
  logBot: number;
  /** Local units visible across the screen at the top of the band. */
  localTopWidth: number;
  /** Decades of local dolly performed across the band. Capped at ~3.5. */
  localSpan: number;
  /**
   * Set on bands whose real span exceeds what float32 geometry can hold.
   * The camera dollies this many decades, then the scene silently re-anchors
   * and repeats. Only valid for self-similar (procedural/noise) content, where
   * a one-decade jump is genuinely invisible.
   */
  wrapDecades?: number;
  /** Marks a band as representational rather than observed. Flagged in the HUD. */
  speculative?: boolean;
  build(ctx: BandContext): BandInstance;
}

export function bandRealSpan(def: BandDef): number {
  return def.logTop - def.logBot;
}
