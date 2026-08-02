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
  const dpr = window.devicePixelRatio || 1;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (cores <= 4 && dpr > 1.5) return 'medium';
  if (cores <= 2) return 'low';
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
  const order: QualityLevel[] = ['low', 'medium', 'high'];
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
// Degrade instance counts and resolution before we degrade frame rate, exactly
// once in each direction, and never while the user is actively scrolling.
let perfWindow = 0;
let perfFrames = 0;
let autoDegradedTo: QualityLevel | null = null;

function trackPerformance(dt: number): void {
  perfWindow += dt;
  perfFrames++;
  if (perfWindow < 4) return;
  const fps = perfFrames / perfWindow;
  perfWindow = 0;
  perfFrames = 0;
  if (fps > 45 || autoDegradedTo !== null) return;
  if (qualityLevel === 'high') {
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
  // Clamp dt so an alt-tab, a slow band build or a backgrounded tab cannot
  // fling the zoom spring across ten decades in a single step.
  const dt = Math.min(timer.getDelta(), 1 / 20);

  input.update(dt);
  const [lookX, lookY] = input.look;
  const status = world.update(input.logScale, lookX, lookY, dt);
  world.render();

  const info =
    `band ${status.upper.index}` +
    (status.lower ? ` → ${status.lower.index}  ${(status.blend * 100).toFixed(0)}%` : '') +
    `\nlog ${status.logScale.toFixed(3)} · live ${status.builtCount}`;
  hud.update(status, input.idleTime, dt, info);

  trackPerformance(dt);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Test hooks. Dev builds only — these are how the seam-quality harness drives
// the zoom to an exact log scale with animation frozen, so that consecutive
// frames differ only because of the band hand-off.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__zoom = {
    snap: (log: number) => input.snapTo(log),
    freeze: (on: boolean) => {
      world.timeScale = on ? 0 : 1;
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
