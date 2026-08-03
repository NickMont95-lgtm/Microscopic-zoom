# Microscopic Zoom

A continuous, on-rails descent from a standing man down to the Planck length —
about 35 orders of magnitude — with no visible cuts.

**Status: complete.** All thirteen bands are built, from a standing man down to
the Planck length.

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
| `g` | Cycle quality: high → low → medium |
| `h` | Hide / show the HUD |
| `f` | Toggle the FPS counter |
| `i` | Invert scroll direction |
| `r` | Return to the top |

There are two URL flags, both for testing:

- `?q=low` / `?q=medium` / `?q=high` — force a quality preset instead of
  detecting one.
- `?placeholder=1` — swap every band back to the Phase 1 stand-in geometry: a
  self-similar tunnel of rings built specifically to make any flaw in a band
  hand-off obvious. Useful for re-checking the engine after changing art.

---

## The ladder

| # | Band | Across the screen | What is there |
|---|---|---|---|
| 1 | The room | 2.24 m → 100 mm | A standing man, ~35, full beard, plain room, studio light |
| 2 | Cheek and beard | 178 mm → 1 mm | Skin microrelief, terminal beard hair (60–120 µm), vellus hair |
| 3 | Pores and corneocytes | 1.78 mm → 200 µm | Follicular openings, sebum, corneocytes (~35 µm) shedding |
| 4 | Follicle mites | 355 µm → 50 µm | *Demodex folliculorum*, head-down in the infundibulum |
| 5 | Skin microbiome | 89 µm → 6.3 µm | *C. acnes* rods, *S. epidermidis* cocci, biofilm, one cell dividing |
| 6 | Inside a keratinocyte | 10 µm → 1 µm | Nucleus, mitochondria, rough ER, Golgi, keratin filaments |
| 7 | Cytoskeleton and ribosomes | 1.78 µm → 100 nm | Microtubules, kinesin walking cargo, actin, ribosomes, cristae |
| 8 | Viral particles | 178 nm → 25 nm | Adenovirus (~90 nm) docking a nuclear pore, rhinovirus (~30 nm) |
| 9 | Chromatin and DNA | 45 nm → 1.5 nm | Nucleosomes, then B-DNA with real groove asymmetry |
| 10 | Atoms of the backbone | 2.7 nm → 79 pm | C, N, O, P as probability density — not orbiting balls |
| 11 | The atomic void | 141 pm → 10 fm | Four decades of emptiness, then a phosphorus-31 nucleus |
| 12 | Inside a proton | 17.8 fm → 1 am | Three valence quarks in a churning gluon sea |
| 13 | Quantum field | 17.8 am → 1.6×10⁻³⁵ m | Speculative. Ends at the Planck length. |

---

## Architecture

The whole project turns on one idea: **the enormous dynamic range lives in a
single number and never touches a vertex buffer.**

- `logScale` is log₁₀ of the metres visible across the screen. It runs from
  `+0.35` (2.24 m) to `−34.8` (1.6×10⁻³⁵ m). The scroll wheel changes only this.
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
    common.ts             scaffolding, rails, scale-invariant lighting, GPU motion
    b01-room.ts … b13-foam.ts   one module per band
    figure.ts             the procedural man, plus the GLTF hook
    skin.ts               the continuous skin field shared by bands 2-4
    demodex.ts            the mite
    field.ts              scale-invariant volumetric noise for bands 11-13
    placeholder.ts        the Phase 1 seam-test rig (?placeholder=1)
  hud/
    hud.ts, hud.css       scale readout, stage name, caption, depth bar
```

Each band is one module returning a `BandInstance`; the engine knows nothing
about what any of them contain.

## Dropping in a real head

The man in band 1 is procedural — a convincing human head cannot be written in
code, it has to be scanned or sculpted. The loader is already wired: export a
head as `head.glb`, put it at `public/models/head.glb`, and it replaces the
placeholder on next load. Nothing is bundled and the fetch fails silently if
the file is absent.

The model wants to be roughly 0.23 m tall, Y-up, facing +Z, origin at the
centre of the skull. Sources worth trying, in order:

- **MakeHuman** (makehumancommunity.org) — free, and the models it generates
  are CC0. It can produce a bearded 35-year-old male directly and export glTF.
  This is the closest fit to what the scene needs.
- **Blender Studio Human Base Meshes** (studio.blender.org) — CC0, clean
  topology, no likeness, but a proper anatomical base to sculpt on.
- **Sketchfab** filtered to CC0 head scans — quality varies enormously, and the
  licence needs checking per model rather than trusting the search filter.
