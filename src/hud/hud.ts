import './hud.css';
import { LADDER, LOG_MAX, LOG_MIN } from '../core/ladder.ts';
import { formatMetres } from '../core/units.ts';
import type { WorldStatus } from '../core/world.ts';

/**
 * Minimal HUD. Everything it shows is derived from `logScale`, so the numbers
 * cannot drift out of sync with what is on screen even though the geometry is
 * in arbitrary local units.
 */
export class Hud {
  private readonly root: HTMLElement;
  private readonly scaleEl: HTMLElement;
  private readonly stageEl: HTMLElement;
  private readonly captionEl: HTMLElement;
  private readonly readoutEl: HTMLElement;
  private readonly fillEl: HTMLElement;
  private readonly markerEl: HTMLElement;
  private readonly tickEls: HTMLElement[] = [];
  private readonly statsEl: HTMLElement;
  private readonly fpsEl: HTMLElement;
  private readonly infoEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly toastEl: HTMLElement;

  private toastTimer = 0;
  private lastCaption = '';
  private frames = 0;
  private fpsAccum = 0;
  private fps = 60;

  visible = true;
  showStats: boolean;

  constructor(root: HTMLElement, showStats: boolean) {
    this.root = root;
    this.showStats = showStats;

    root.innerHTML = `
      <div class="readout hud-fade">
        <div class="scale">—</div>
        <div class="stage"><span class="index"></span><span class="name"></span></div>
        <div class="caption"></div>
        <div class="beyond">Beyond visible light — structural model, not a photograph</div>
        <div class="speculative">Speculative visualisation</div>
      </div>
      <div class="depth hud-fade">
        <div class="ticks"></div>
        <div class="track"><div class="fill"></div><div class="marker"></div></div>
      </div>
      <div class="stats"><div class="fps">— fps</div><div class="info"></div></div>
      <div class="hint">scroll to descend · move mouse to look · 1-9 0 q w e jump · h hide</div>
      <div class="toast"></div>
    `;

    this.readoutEl = root.querySelector('.readout')!;
    this.scaleEl = root.querySelector('.readout .scale')!;
    this.stageEl = root.querySelector('.readout .stage')!;
    this.captionEl = root.querySelector('.readout .caption')!;
    this.fillEl = root.querySelector('.depth .fill')!;
    this.markerEl = root.querySelector('.depth .marker')!;
    this.statsEl = root.querySelector('.stats')!;
    this.fpsEl = root.querySelector('.stats .fps')!;
    this.infoEl = root.querySelector('.stats .info')!;
    this.hintEl = root.querySelector('.hint')!;
    this.toastEl = root.querySelector('.toast')!;

    const ticks = root.querySelector('.depth .ticks')!;
    for (const def of LADDER) {
      const el = document.createElement('div');
      el.className = 'tick';
      el.title = `${def.index} · ${def.name}`;
      el.style.top = `${this.logToPercent((def.logTop + def.logBot) * 0.5)}%`;
      ticks.appendChild(el);
      this.tickEls.push(el);
    }

    this.statsEl.style.display = showStats ? 'block' : 'none';
  }

  private logToPercent(log: number): number {
    return ((LOG_MAX - log) / (LOG_MAX - LOG_MIN)) * 100;
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    this.toastTimer = 1.4;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
  }

  toggleStats(): void {
    this.showStats = !this.showStats;
    this.statsEl.style.display = this.showStats ? 'block' : 'none';
  }

  update(status: WorldStatus, idleTime: number, dt: number, extra: string): void {
    // FPS, averaged over half-second windows.
    this.frames++;
    this.fpsAccum += dt;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.frames / this.fpsAccum;
      this.frames = 0;
      this.fpsAccum = 0;
      if (this.showStats) {
        this.fpsEl.textContent = `${this.fps.toFixed(0)} fps`;
        this.fpsEl.classList.toggle('warn', this.fps < 50);
      }
    }
    if (this.showStats) this.infoEl.textContent = extra;

    this.scaleEl.textContent = formatMetres(status.metresVisible);

    const def = status.primary;
    (this.stageEl.querySelector('.index') as HTMLElement).textContent = String(def.index).padStart(2, '0');
    (this.stageEl.querySelector('.name') as HTMLElement).textContent = def.name;

    if (def.caption !== this.lastCaption) {
      this.lastCaption = def.caption;
      this.captionEl.textContent = def.caption;
    }
    this.readoutEl.classList.toggle('is-speculative', def.speculative === true);
    // Visible light cannot resolve below roughly a quarter of a micron. From
    // there down nothing on screen is a photograph of anything — it is electron
    // microscopy and structural models, drawn in conventional colours. Driven
    // off the scale rather than tagged per band, so it can never disagree with
    // the readout beside it.
    this.readoutEl.classList.toggle('is-beyond', status.metresVisible < 250e-9);

    const pct = this.logToPercent(status.logScale);
    this.fillEl.style.height = `${pct}%`;
    this.markerEl.style.top = `${pct}%`;

    // The bar carries tick dashes and a position marker, nothing else. Naming
    // the band here as well was redundant — it is already set in large type in
    // the readout — and the bar is linear in log space, so bands 1-10 crowd into
    // its top third where no label is legible anyway.
    for (let i = 0; i < this.tickEls.length; i++) {
      this.tickEls[i].classList.toggle('active', LADDER[i] === def);
    }

    // Fade the whole HUD once the user stops scrolling.
    this.root.classList.toggle('idle', idleTime > 1.6);
    this.hintEl.style.opacity = idleTime > 3 ? '0' : '1';

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    }
  }
}
