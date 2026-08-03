import { clamp, smoothDamp, type DampState } from './mathx.ts';
import { LADDER, LOG_MAX, LOG_MIN, bandCenterLog } from './ladder.ts';

/**
 * All user input. There are exactly two things the user can do: change the
 * target scale, and look around a little.
 *
 * The zoom is smoothed with a critically damped spring in LOG space. That is
 * what makes the descent feel like a constant rate: going from 1 m to 10 cm
 * takes the same time as going from 1 nm to 0.1 nm, because both are one
 * decade. Easing in linear space would crawl at the top and blur at the bottom.
 */

// Decades per pixel of wheel travel. At a typical 100 px wheel notch this is
// about a third of a decade per click, so the full 35-decade descent is roughly
// a hundred notches — long enough to feel like a journey, short enough that
// getting to the bottom is not a chore.
const WHEEL_SENS = 0.0035;
const PINCH_SENS = 0.010; // decades per pixel of ctrl+wheel (trackpad pinch)
const TOUCH_GAIN = 1.6; // decades per decade of finger separation
const SMOOTH_TIME = 0.42; // seconds for the spring to mostly arrive
const MAX_RATE = 3.0; // hard cap, decades per second

export interface InputActions {
  onToggleHud(): void;
  onToggleSeamDebug(): void;
  onToggleFps(): void;
  onCycleQuality(): void;
  onJump(label: string): void;
}

export class Input {
  targetLog = LOG_MAX;
  private zoom: DampState = { value: LOG_MAX, velocity: 0 };

  private lookTargetX = 0;
  private lookTargetY = 0;
  private lookX: DampState = { value: 0, velocity: 0 };
  private lookY: DampState = { value: 0, velocity: 0 };

  /** Seconds since the scale last changed meaningfully — drives the HUD fade. */
  idleTime = 0;
  invertScroll = false;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchStart = 0;
  private pinchStartLog = 0;

  constructor(
    private readonly element: HTMLElement,
    private readonly actions: InputActions,
  ) {
    element.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    // Stop the browser's own pinch-zoom from fighting us.
    element.addEventListener('gesturestart', preventDefault as EventListener);
    element.addEventListener('gesturechange', preventDefault as EventListener);
  }

  get logScale(): number {
    return this.zoom.value;
  }

  get look(): [number, number] {
    return [this.lookX.value, this.lookY.value];
  }

  /** Normalized 0..1 position of the current target within the whole ladder. */
  get progress(): number {
    return clamp((LOG_MAX - this.zoom.value) / (LOG_MAX - LOG_MIN), 0, 1);
  }

  jumpTo(log: number): void {
    this.targetLog = clamp(log, LOG_MIN, LOG_MAX);
    this.idleTime = 0;
  }

  /** Teleports the zoom with no easing. Test harness only. */
  snapTo(log: number): void {
    const v = clamp(log, LOG_MIN, LOG_MAX);
    this.targetLog = v;
    this.zoom.value = v;
    this.zoom.velocity = 0;
  }

  private nudge(decades: number): void {
    this.targetLog = clamp(this.targetLog + decades, LOG_MIN, LOG_MAX);
    this.idleTime = 0;
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // deltaMode: 0 = pixels, 1 = lines, 2 = pages.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = e.deltaY * unit;

    if (e.ctrlKey) {
      // Trackpad pinch arrives as ctrl+wheel. Pinching apart (negative deltaY)
      // must zoom IN, i.e. decrease logScale.
      this.nudge(dy * PINCH_SENS);
    } else {
      const sign = this.invertScroll ? -1 : 1;
      // Default: scrolling down descends, matching the vertical depth bar.
      this.nudge(-dy * WHEEL_SENS * sign);
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      this.pinchStart = this.pinchDistance();
      this.pinchStartLog = this.targetLog;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchStart = 0;
  };

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      if (this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (this.pointers.size === 2 && this.pinchStart > 0) {
        const d = this.pinchDistance();
        if (d > 1) {
          // Fingers apart => zoom in => logScale down.
          this.targetLog = clamp(
            this.pinchStartLog - Math.log10(d / this.pinchStart) * TOUCH_GAIN,
            LOG_MIN,
            LOG_MAX,
          );
          this.idleTime = 0;
        }
      }
      return;
    }
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = (e.clientY / window.innerHeight) * 2 - 1;
    this.lookTargetX = clamp(nx, -1, 1);
    this.lookTargetY = clamp(ny, -1, 1);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();

    // Band jump keys, for testing. 1-9 => bands 1-9, 0 => band 10,
    // q/w/e => bands 11/12/13.
    const digit = '123456789'.indexOf(e.key);
    if (digit >= 0) return this.jumpToBand(digit);
    if (e.key === '0') return this.jumpToBand(9);
    if (k === 'q') return this.jumpToBand(10);
    if (k === 'w') return this.jumpToBand(11);
    if (k === 'e') return this.jumpToBand(12);

    switch (k) {
      case '[':
        return this.stepBand(-1);
      case ']':
        return this.stepBand(1);
      case 'b':
        return this.jumpToNearestSeam();
      case 'k':
        return this.actions.onToggleSeamDebug();
      case 'h':
        return this.actions.onToggleHud();
      case 'f':
        return this.actions.onToggleFps();
      case 'g':
        return this.actions.onCycleQuality();
      case 'i':
        this.invertScroll = !this.invertScroll;
        this.actions.onJump(`scroll ${this.invertScroll ? 'inverted' : 'normal'}`);
        return;
      case 'r':
      case 'home':
        this.jumpTo(LOG_MAX);
        return this.actions.onJump('top');
      case 'end':
        this.jumpTo(LOG_MIN);
        return this.actions.onJump('Planck length');
      default:
        return;
    }
  };

  private currentBandIndex(): number {
    for (let i = 0; i < LADDER.length; i++) {
      if (this.targetLog <= LADDER[i].logTop && this.targetLog >= LADDER[i].logBot) return i;
    }
    return 0;
  }

  private jumpToBand(i: number): void {
    const def = LADDER[Math.min(LADDER.length - 1, Math.max(0, i))];
    this.jumpTo(bandCenterLog(def));
    this.actions.onJump(`${def.index}. ${def.name}`);
  }

  private stepBand(dir: number): void {
    this.jumpToBand(clamp(this.currentBandIndex() + dir, 0, LADDER.length - 1));
  }

  /** Parks the target exactly on a band boundary, for inspecting the dissolve. */
  private jumpToNearestSeam(): void {
    let best = LADDER[0].logBot;
    let bestD = Infinity;
    let name = '';
    for (let i = 0; i < LADDER.length - 1; i++) {
      // Middle of the overlap between band i and band i+1.
      const mid = (LADDER[i].logBot + LADDER[i + 1].logTop) * 0.5;
      const d = Math.abs(mid - this.zoom.value);
      if (d < bestD) {
        bestD = d;
        best = mid;
        name = `${LADDER[i].index}→${LADDER[i + 1].index}`;
      }
    }
    this.jumpTo(best);
    this.actions.onJump(`seam ${name}`);
  }

  update(dt: number): void {
    const before = this.zoom.value;
    smoothDamp(this.zoom, this.targetLog, SMOOTH_TIME, dt, MAX_RATE);
    smoothDamp(this.lookX, this.lookTargetX, 0.35, dt);
    smoothDamp(this.lookY, this.lookTargetY, 0.35, dt);

    if (Math.abs(this.zoom.value - before) > 1e-4) this.idleTime = 0;
    else this.idleTime += dt;
  }

  dispose(): void {
    this.element.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
  }
}

function preventDefault(e: Event): void {
  e.preventDefault();
}
