import * as THREE from 'three';
import { World } from './core/world.ts';
import { Input } from './core/input.ts';
import { Hud } from './hud/hud.ts';
import { QUALITY_PRESETS, type QualityLevel } from './core/types.ts';
import { LOG_MAX } from './core/ladder.ts';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud') as HTMLElement;

// WebGL2 only. WebGPU is deliberately not used here: three's WebGPU backend is
// still behind on a few things this project leans on (render-target sample
// counts, some material features) and Safari support is inconsistent. Nothing
// in this design needs compute shaders, so WebGL2 costs us nothing.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false, // MSAA is done on the band render targets instead
  powerPreference: 'high-performance',
  stencil: false,
  depth: false, // the canvas only ever receives a fullscreen quad
});

if (!renderer.capabilities.isWebGL2) {
  hudRoot.innerHTML =
    '<div style="position:absolute;inset:0;display:grid;place-items:center;font:300 15px system-ui;color:#ccd">' +
    'This experience needs WebGL2, which this browser does not appear to support.</div>';
  throw new Error('WebGL2 required');
}

// Tone mapping and sRGB output are applied once, in the compositor's final
// pass. three skips both when rendering into a render target, so the bands stay
// in linear light right up to the dissolve.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false;

/** Set when the viewer picks a quality level explicitly, which disables the
 *  automatic degrade for the rest of the session. Declared here because
 *  pickInitialQuality() assigns it during module initialisation, and a `let`
 *  further down the file would still be in its temporal dead zone. */
let userChoseQuality = false;

let qualityLevel: QualityLevel = pickInitialQuality();
let quality = QUALITY_PRESETS[qualityLevel];

const world = new World(renderer, quality);
const hud = new Hud(hudRoot, import.meta.env.DEV);

const input = new Input(canvas, {
  onToggleHud: () => hud.toggle(),
  onToggleSeamDebug: () => {
    world.seamDebug = !world.seamDebug;
    hud.toast(`seam debug ${world.seamDebug ? 'on' : 'off'}`);
  },
  onToggleFps: () => hud.toggleStats(),
  onCycleQuality: () => cycleQuality(),
  onJump: (label) => hud.toast(label),
});

input.targetLog = LOG_MAX;

function pickInitialQuality(): QualityLevel {
  const forced = new URLSearchParams(location.search).get('q');
  if (forced === 'low' || forced === 'medium' || forced === 'high' || forced === 'ultra') {
    userChoseQuality = true;
    return forced;
  }
  const cores = navigator.hardwareConcurrency ?? 4;
  if (cores <= 2) return 'low';
  if (cores <= 4) return 'medium';
  return 'high';
}

function applyQuality(level: QualityLevel): void {
  qualityLevel = level;
  quality = QUALITY_PRESETS[level];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));
  world.setQuality(quality);
  resize();
  hud.toast(`quality: ${level}`);
}

function cycleQuality(): void {
  // Choosing by hand switches off the automatic degrade for the session.
  userChoseQuality = true;
  const order: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
  applyQuality(order[(order.indexOf(qualityLevel) + 1) % order.length]);
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  world.setSize(w, h, dpr);
}

window.addEventListener('resize', resize);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));
resize();

// --- adaptive quality ------------------------------------------------------
/**
 * Degrade only on sustained, serious trouble.
 *
 * The previous threshold — any four-second window averaging 45 fps or less —
 * was far too eager. A machine holding a steady 60 and dipping to 45 during a
 * band hand-off would be permanently downgraded to medium on its first dip,
 * and the user would then be looking at reduced geometry and a 1.5x pixel-ratio
 * cap for the rest of the session with no indication anything had happened.
 *
 * A dip is not distress. This now needs TWO consecutive five-second windows
 * below 30 fps, ignores the first eight seconds while shaders compile and the
 * opening bands build, and never fires if the user has chosen a level by hand.
 */
const DEGRADE_BELOW_FPS = 30;
const DEGRADE_WINDOW_S = 5;
const DEGRADE_GRACE_S = 8;

let perfWindow = 0;
let perfFrames = 0;
let elapsedTotal = 0;
let badWindows = 0;
let autoDegradedTo: QualityLevel | null = null;

function trackPerformance(dt: number): void {
  elapsedTotal += dt;
  perfWindow += dt;
  perfFrames++;
  if (perfWindow < DEGRADE_WINDOW_S) return;

  const fps = perfFrames / perfWindow;
  perfWindow = 0;
  perfFrames = 0;

  if (elapsedTotal < DEGRADE_GRACE_S || userChoseQuality || autoDegradedTo !== null) return;

  if (fps >= DEGRADE_BELOW_FPS) {
    badWindows = 0;
    return;
  }
  if (++badWindows < 2) return;

  if (qualityLevel === 'ultra') {
    autoDegradedTo = 'high';
    applyQuality('high');
  } else if (qualityLevel === 'high') {
    autoDegradedTo = 'medium';
    applyQuality('medium');
  } else if (qualityLevel === 'medium') {
    autoDegradedTo = 'low';
    applyQuality('low');
  }
}

// --- main loop -------------------------------------------------------------
const timer = new THREE.Timer();

function frame(): void {
  timer.update();
  // `rawDt` is wall-clock; `dt` is clamped so that an alt-tab, a slow band
  // build or a backgrounded tab cannot fling the zoom spring across ten decades
  // in a single step.
  //
  // These must not be confused. Simulation uses the clamped value; the frame
  // rate readout and the adaptive-quality check use the real one. Measuring
  // frame rate from the clamped dt makes it frames-per-SIMULATED-second, which
  // saturates at 20 and cheerfully reports 20 fps on a machine actually
  // managing two — exactly when you most need to be told otherwise.
  const rawDt = timer.getDelta();
  const dt = Math.min(rawDt, 1 / 20);

  input.update(dt);
  const [lookX, lookY] = input.look;
  const status = world.update(input.logScale, lookX, lookY, dt);
  world.render();


  const info =
    `band ${status.upper.index}` +
    (status.lower ? ` → ${status.lower.index}  ${(status.blend * 100).toFixed(0)}%` : '') +
    `\nlog ${status.logScale.toFixed(3)} · live ${status.builtCount}`;
  hud.update(status, input.idleTime, dt, info, rawDt);

  trackPerformance(rawDt);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Test hooks. Dev builds only — these are how the seam-quality harness drives
// the zoom to an exact log scale with animation frozen, so that consecutive
// frames differ only because of the band hand-off.
if (import.meta.env.DEV) {
  // Exposed for the diagnostic harness: renderer.info gives per-frame draw
  // calls and triangle counts, which diagnose cost far better than an fps
  // sample does on a slow software rasteriser.
  (window as unknown as Record<string, unknown>).__renderer = renderer;
  (window as unknown as Record<string, unknown>).__zoom = {
    snap: (log: number) => input.snapTo(log),
    freeze: (on: boolean) => {
      world.timeScale = on ? 0 : 1;
    },
    // Static geometry load of the live bands: triangles actually submitted and
    // how many separate draws they take. A far better diagnostic than an fps
    // sample when the rasteriser is the bottleneck.
    load: () => {
      let tris = 0;
      let draws = 0;
      for (const inst of world.liveInstances()) {
        inst.scene.traverse((o: THREE.Object3D) => {
          const m = o as THREE.Mesh & { count?: number; isInstancedMesh?: boolean };
          const g = m.geometry as THREE.BufferGeometry | undefined;
          if (!g || !m.visible) return;
          const idx = g.getIndex();
          const n = idx ? idx.count / 3 : (g.getAttribute('position')?.count ?? 0) / 3;
          tris += n * (m.isInstancedMesh ? (m.count ?? 1) : 1);
          draws++;
        });
      }
      return { triangles: Math.round(tris), draws };
    },
    state: () => ({
      log: input.logScale,
      upper: world.lastStatus?.upper.index,
      lower: world.lastStatus?.lower?.index ?? null,
      blend: world.lastStatus?.blend ?? 0,
    }),
  };
}

window.addEventListener('beforeunload', () => {
  input.dispose();
  world.dispose();
  renderer.dispose();
});
