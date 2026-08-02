/**
 * Values shared between the ladder and the band builders, kept in their own
 * module so the two do not have to import each other.
 */

/** log10(metres) at the very top of the descent — the widest shot of the room. */
export const SURFACE_LOG = 0.35;

/**
 * Where a wrapping band's dolly window starts.
 *
 * Bands 11-13 cover more decades than float32 geometry can hold, so they dolly
 * one decade and then silently re-anchor. The phase of that repeat MUST be
 * snapped to a global grid rather than to the band's own logTop: two wrapping
 * bands whose tops are a fractional number of decades apart would otherwise be
 * at different points in their tunnels while overlapping, and the dissolve
 * would show a visible double image.
 *
 * Snapping to whole decades makes every wrapping band's window start at the
 * same phase, so overlapping bands are pixel-for-pixel the same picture.
 */
export function wrapOrigin(logTop: number, wrapDecades: number): number {
  return Math.ceil(logTop / wrapDecades) * wrapDecades;
}
