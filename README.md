# Microscopic Zoom

A continuous, on-rails descent from a standing man down to the Planck length —
about 35 orders of magnitude — with no visible cuts.

**Status: Phase 1 complete.** The engine, camera rail, zoom, mouse-look and HUD
are finished and verified. All thirteen bands currently draw *placeholder*
geometry (a tunnel of coloured rings), on purpose. Real art arrives in Phases
2–5.

---

## Running it

```bash
npm install
npm run dev
```

Then open **http://localhost:5173** in Chrome, Edge, Firefox or Safari.

To stop the server, press `Ctrl+C` in the terminal.

Other commands:

```bash
npm run build      # production build into dist/
npm run preview    # serve the production build
npm run typecheck  # type errors only, no output
```

Requires Node 20 or newer and a browser with WebGL2 (anything from the last
five years). Nothing is downloaded at runtime; there is no backend.

---

## Controls

| Input | What it does |
|---|---|
| **Scroll wheel down** | Descend (zoom in) |
| **Scroll wheel up** | Ascend (zoom out) |
| **Trackpad pinch** | Same, both directions |
| **Move the mouse** | Look around ±15°. Does not move the camera off the rail. |
| `1`–`9` | Jump to bands 1–9 |
| `0` | Jump to band 10 |
| `q` `w` `e` | Jump to bands 11, 12, 13 |
| `[` `]` | Step one band up / down |
| `b` | Jump to the nearest band boundary — parks you in the middle of a cross-fade |
| `k` | Seam debug: tints the two live bands red and cyan so you can see the hand-off |
| `h` | Hide / show the HUD |
| `f` | Toggle the FPS counter |
| `g` | Cycle quality: high → low → medium |
| `i` | Invert scroll direction |
| `r` | Return to the top |

---

## Architecture

The whole project turns on one idea: **the enormous dynamic range lives in a
single number and never touches a vertex buffer.**

- `logScale` is log₁₀ of the metres visible across the screen. It runs from
  `+0.48` (3 m) to `−34.8` (1.6×10⁻³⁵ m). The scroll wheel changes only this.
- The world is 13 **bands** (`src/core/ladder.ts`). Each is a separate
  `THREE.Scene` authored in local units of roughly 0.01–200 — never in real
  metres. Each declares its own real-world size range, which is what keeps the
  on-screen scale readout honest.
- Only two bands are ever live. Consecutive bands overlap by ~0.25 decades, and
  that overlap is a cross-fade.
- Each live band is rendered into its **own HDR render target** with its **own
  depth buffer**, and the two are dissolved in one fullscreen pass
  (`src/core/compositor.ts`). Nothing from band A can ever z-fight against band
  B, because they never share a depth range.
- The camera is placed by *inverting* the framing: given the scale we want, we
  compute how far the camera must sit from its look-target, then put it there
  along the rail. Framing is derived from scale, never the other way round.
- `camera.near` / `camera.far` are recomputed every frame from that distance, so
  the near/far ratio stays fixed at ~4×10⁵ whether you are looking at a man or a
  quark. This is the other half of why precision never degrades.
- Bands 11–13 span more decades than float32 geometry can hold, so they dolly
  one decade and then silently re-anchor on a global decade grid. Their content
  is self-similar, so the repeat is invisible.

### Layout

```
src/
  main.ts                 renderer setup, main loop, adaptive quality
  core/
    ladder.ts             the 13 bands: real-world ranges, names, captions
    world.ts              picks the live bands, sets fade weights, places cameras
    compositor.ts         two render targets + the dissolve pass
    rail.ts               the camera spline and the framing inversion
    input.ts              scroll, pinch, mouse-look, debug keys
    mathx.ts              critically damped spring
    units.ts              metres to SI string
    types.ts              the contract every band implements
    constants.ts          shared anchors
  bands/
    placeholder.ts        Phase 1 stand-in content for all 13 bands
  hud/
    hud.ts, hud.css       scale readout, stage name, caption, depth bar
```

Adding real content for a band means writing one new module that returns a
`BandInstance` and pointing that band's `build` at it. Nothing else changes.
