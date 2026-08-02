import type { BandDef } from './types.ts';
import { makePlaceholderBand } from '../bands/placeholder.ts';

/**
 * THE ZOOM LADDER
 *
 * `logTop` / `logBot` are log10(metres visible across the screen). The ladder is
 * strictly monotonic and every consecutive pair overlaps by ~0.25 decades; that
 * overlap is the cross-fade region.
 *
 * NOTE ON ORDERING — the brief's table asks for bacteria (down to 2 µm) and then
 * a whole-cell view (30 µm). A continuous zoom that only ever descends cannot do
 * that: 30 µm is wider than 2 µm, so showing the whole cell after the bacteria
 * would mean zooming back out, which is a cut. The nucleus (6 µm) after the
 * organelles has the same problem.
 *
 * The ladder below keeps every subject the brief asks for and keeps the descent
 * monotonic, by putting each subject at the scale where it actually reads:
 *   - the whole-cell landscape appears at the TOP of the microbiome band (89 µm),
 *     where a 30 µm keratinocyte genuinely fits on screen;
 *   - the bacteria close-up is the BOTTOM of that band (6.3 µm), where a 1 µm
 *     rod is a sixth of the screen width;
 *   - membrane crossing and the classic textbook organelle view is band 6
 *     (10 µm → 1 µm): the 6 µm nucleus fills 60% of the frame at the top;
 *   - fine organelle structure — cristae, ribosomes, microtubules, motor
 *     proteins — is band 7 (1.78 µm → 100 nm), where 25 nm objects are readable.
 *
 * Bands 11–13 span more decades than float32 geometry can hold, so they set
 * `wrapDecades`: the camera dollies one decade, the scene re-anchors invisibly
 * because its content is self-similar, and it repeats. That is how band 13
 * covers 17 decades without a single precision artefact.
 */

const M = Math.log10;

export const LADDER: BandDef[] = [
  {
    index: 1,
    id: 'room',
    name: 'The room',
    caption: 'A 1.8 m adult male, standing. The camera starts 1.5 m (5 ft) from his face.',
    logTop: M(3),
    logBot: M(0.1),
    localTopWidth: 60,
    localSpan: M(3) - M(0.1),
    build: makePlaceholderBand,
  },
  {
    index: 2,
    id: 'cheek',
    name: 'Cheek and beard',
    caption: 'Terminal beard hair is 60–120 µm thick; vellus hair is under 30 µm.',
    logTop: -0.75,
    logBot: -3.0,
    localTopWidth: 60,
    localSpan: 2.25,
    build: makePlaceholderBand,
  },
  {
    index: 3,
    id: 'pores',
    name: 'Pores and corneocytes',
    caption: 'Facial pores are follicular openings 50–100 µm wide. Corneocytes are flat dead keratinocytes ~35 µm across.',
    logTop: -2.75,
    logBot: -3.7,
    localTopWidth: 60,
    localSpan: 0.95,
    build: makePlaceholderBand,
  },
  {
    index: 4,
    id: 'demodex',
    name: 'Follicle mites',
    caption: 'Demodex folliculorum: 0.3–0.4 mm long, eight legs, lives head-down in the follicle. Present on most adult faces.',
    logTop: -3.45,
    logBot: -4.3,
    localTopWidth: 60,
    localSpan: 0.85,
    build: makePlaceholderBand,
  },
  {
    index: 5,
    id: 'microbiome',
    name: 'Skin microbiome',
    caption: 'Cutibacterium acnes (rods) and Staphylococcus epidermidis (cocci in clusters), about 1 µm — roughly a million per cm².',
    logTop: -4.05,
    logBot: -5.2,
    localTopWidth: 60,
    localSpan: 1.15,
    build: makePlaceholderBand,
  },
  {
    index: 6,
    id: 'cell',
    name: 'Inside a keratinocyte',
    caption: 'Through the plasma membrane. The cell is ~30 µm across; its nucleus ~6 µm, mitochondria 0.5–1 µm.',
    logTop: -5.0,
    logBot: -6.0,
    localTopWidth: 60,
    localSpan: 1.0,
    build: makePlaceholderBand,
  },
  {
    index: 7,
    id: 'cytoskeleton',
    name: 'Cytoskeleton and ribosomes',
    caption: 'Microtubules are 25 nm across; ribosomes ~25 nm. Kinesin walks cargo along them at about 800 nm/s.',
    logTop: -5.75,
    logBot: -7.0,
    localTopWidth: 60,
    localSpan: 1.25,
    build: makePlaceholderBand,
  },
  {
    index: 8,
    id: 'virus',
    name: 'Viral particles',
    caption: 'Adenovirus: ~90 nm icosahedral capsid with fibre projections. Rhinovirus: ~30 nm. Shown for scale contrast.',
    logTop: -6.75,
    logBot: -7.6,
    localTopWidth: 60,
    localSpan: 0.85,
    build: makePlaceholderBand,
  },
  {
    index: 9,
    id: 'dna',
    name: 'Chromatin and DNA',
    caption: '11 nm nucleosomes on a 2 nm duplex. One helical turn is 3.4 nm and 10.5 base pairs.',
    logTop: -7.35,
    logBot: -8.82,
    localTopWidth: 60,
    localSpan: 1.47,
    build: makePlaceholderBand,
  },
  {
    index: 10,
    id: 'atoms',
    name: 'Atoms of the backbone',
    caption: 'A C–C bond is 0.154 nm. Electrons are drawn as probability density, not orbits — they have no trajectory.',
    logTop: -8.57,
    logBot: -10.1,
    localTopWidth: 60,
    localSpan: 1.53,
    build: makePlaceholderBand,
  },
  {
    index: 11,
    id: 'void',
    name: 'The atomic void',
    caption: 'The nucleus holds over 99.9% of the atom’s mass in about 1/100,000 of its width. Nearly all of you is empty space.',
    logTop: -9.85,
    logBot: -14.0,
    localTopWidth: 60,
    localSpan: 1.0,
    wrapDecades: 1,
    build: makePlaceholderBand,
  },
  {
    index: 12,
    id: 'proton',
    name: 'Inside a proton',
    caption: 'A proton is ~1.7 fm across: three valence quarks in a churning sea of gluons and virtual quark–antiquark pairs.',
    logTop: -13.75,
    logBot: -18.0,
    localTopWidth: 60,
    localSpan: 1.0,
    wrapDecades: 1,
    build: makePlaceholderBand,
  },
  {
    index: 13,
    id: 'foam',
    name: 'Quantum field (speculative)',
    caption: 'Speculative visualisation — nothing has been directly observed at this scale. Ends at the Planck length, 1.6×10⁻³⁵ m.',
    logTop: -17.75,
    logBot: Math.log10(1.616e-35),
    localTopWidth: 60,
    localSpan: 1.0,
    wrapDecades: 1,
    speculative: true,
    build: makePlaceholderBand,
  },
];

export const LOG_MAX = LADDER[0].logTop;
export const LOG_MIN = LADDER[LADDER.length - 1].logBot;

/** Log scale at the visual centre of a band — used by the debug jump keys. */
export function bandCenterLog(def: BandDef): number {
  return (def.logTop + def.logBot) * 0.5;
}

/** The overlap (cross-fade) region between band i and band i+1, if any. */
export function overlapRange(a: BandDef, b: BandDef): [number, number] | null {
  const top = Math.min(a.logTop, b.logTop);
  const bot = Math.max(a.logBot, b.logBot);
  return top > bot ? [top, bot] : null;
}
