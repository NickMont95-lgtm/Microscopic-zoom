/**
 * Small math helpers shared across the engine.
 *
 * The important one here is `smoothDamp` — an unconditionally stable
 * critically-damped spring. We use it for the zoom value and the mouse-look
 * offset so nothing ever snaps, and so a huge scroll flick doesn't overshoot
 * and bounce. It is the standard Game Programming Gems 4 formulation (the same
 * one Unity ships as Mathf.SmoothDamp).
 */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Maps v from [a,b] to [0,1], clamped. */
export function invLerp(a: number, b: number, v: number): number {
  if (a === b) return 0;
  return clamp((v - a) / (b - a), 0, 1);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

/** Cubic ease used for the band cross-fade weight curve. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export interface DampState {
  value: number;
  velocity: number;
}

/**
 * Critically damped approach toward `target`.
 *
 * @param state      mutable {value, velocity}
 * @param target     where we want to end up
 * @param smoothTime roughly the time in seconds to cover most of the distance
 * @param dt         frame delta in seconds
 * @param maxSpeed   optional clamp on |velocity| (units per second)
 */
export function smoothDamp(
  state: DampState,
  target: number,
  smoothTime: number,
  dt: number,
  maxSpeed = Infinity,
): number {
  const st = Math.max(0.0001, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  // Pade approximation of exp(-x); cheap and stable.
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  let change = state.value - target;
  const maxChange = maxSpeed * st;
  change = clamp(change, -maxChange, maxChange);
  const goal = state.value - change;

  const temp = (state.velocity + omega * change) * dt;
  state.velocity = (state.velocity - omega * temp) * exp;
  let output = goal + (change + temp) * exp;

  // Prevent overshoot past the target.
  if (target - state.value > 0 === output > target) {
    output = target;
    state.velocity = (output - target) / dt;
  }

  state.value = output;
  return output;
}

/** Frame-rate independent exponential approach (for non-critical smoothing). */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}
