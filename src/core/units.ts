/**
 * Turns a raw length in metres into an honest, readable SI string.
 *
 * The HUD readout is driven directly by `logScale`, which is defined as
 * log10(metres visible across the width of the screen). Nothing here knows or
 * cares about the local units the geometry is authored in — that separation is
 * the whole point of the band system.
 */

interface Prefix {
  exp: number;
  symbol: string;
}

// Full SI prefix set down to quecto (1e-30), which is the smallest one that
// exists. Below that we fall back to scientific notation, because inventing a
// prefix would be lying.
const PREFIXES: Prefix[] = [
  { exp: 3, symbol: 'km' },
  { exp: 0, symbol: 'm' },
  { exp: -2, symbol: 'cm' },
  { exp: -3, symbol: 'mm' },
  { exp: -6, symbol: 'µm' },
  { exp: -9, symbol: 'nm' },
  { exp: -12, symbol: 'pm' },
  { exp: -15, symbol: 'fm' },
  { exp: -18, symbol: 'am' },
  { exp: -21, symbol: 'zm' },
  { exp: -24, symbol: 'ym' },
  { exp: -27, symbol: 'rm' },
  { exp: -30, symbol: 'qm' },
];

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
};

function superscript(n: number): string {
  return String(n)
    .split('')
    .map((c) => SUPERSCRIPT[c] ?? c)
    .join('');
}

/** Formats a length in metres, e.g. 2.4e-6 -> "2.4 µm". */
export function formatMetres(metres: number): string {
  if (!isFinite(metres) || metres <= 0) return '—';

  const log = Math.log10(metres);

  // Below quecto there is no prefix; use scientific notation.
  if (log < -30.5) {
    const exp = Math.floor(log);
    const mant = metres / Math.pow(10, exp);
    return `${mant.toFixed(1)} × 10${superscript(exp)} m`;
  }

  // Pick the largest prefix whose value is <= the number.
  let chosen = PREFIXES[PREFIXES.length - 1];
  for (const p of PREFIXES) {
    if (log >= p.exp - 0.0001) {
      chosen = p;
      break;
    }
  }

  const scaled = metres / Math.pow(10, chosen.exp);
  let digits: number;
  if (scaled >= 100) digits = 0;
  else if (scaled >= 10) digits = 1;
  else digits = 2;

  return `${scaled.toFixed(digits)} ${chosen.symbol}`;
}

/** Formats log10(metres) directly — convenience wrapper. */
export function formatLogMetres(logMetres: number): string {
  return formatMetres(Math.pow(10, logMetres));
}
