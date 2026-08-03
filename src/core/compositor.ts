import * as THREE from 'three';

/**
 * Two-band compositor.
 *
 * Each active band is rendered into its own HDR render target, then the two are
 * dissolved together in a single fullscreen pass. Doing it this way rather than
 * by animating material opacity matters a lot:
 *
 *  - Each band keeps its own correct depth buffer, so nothing from band A can
 *    z-fight or sort incorrectly against band B. They never share a depth range,
 *    which is the exact failure the scale-band architecture exists to avoid.
 *  - Transparency inside a band still works normally, because the band itself is
 *    rendered opaque into its target.
 *  - The dissolve happens in linear light before tone mapping, so a cross-fade
 *    between two differently-lit bands doesn't dip or bloom in the middle.
 *
 * three.js disables tone mapping and output encoding when rendering into a
 * render target, so the band passes stay linear and this final pass applies
 * ACES + sRGB exactly once.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D tA;
uniform sampler2D tB;
uniform float wA;
uniform float wB;
uniform vec3 tintA;
uniform vec3 tintB;
uniform float vignette;
varying vec2 vUv;

void main() {
  vec3 a = texture2D(tA, vUv).rgb * tintA;
  vec3 b = texture2D(tB, vUv).rgb * tintB;
  vec3 c = a * wA + b * wB;

  // Gentle vignette. Sells the "looking down a tunnel" feeling and hides the
  // screen edges, where the two bands disagree most during a dissolve.
  vec2 q = vUv - 0.5;
  float v = 1.0 - vignette * dot(q, q) * 1.6;
  c *= clamp(v, 0.0, 1.0);

  gl_FragColor = vec4(c, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Compositor {
  readonly targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly quadScene: THREE.Scene;
  private readonly quadCamera: THREE.OrthographicCamera;
  private readonly material: THREE.ShaderMaterial;
  private width = 1;
  private height = 1;
  private samples: number;

  constructor(private readonly renderer: THREE.WebGLRenderer, samples: number) {
    this.samples = samples;
    this.targets = [this.makeTarget(), this.makeTarget()];

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tA: { value: null },
        tB: { value: null },
        wA: { value: 1 },
        wB: { value: 0 },
        tintA: { value: new THREE.Color(1, 1, 1) },
        tintB: { value: new THREE.Color(1, 1, 1) },
        vignette: { value: 0.55 },
      },
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(quad);
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  private makeTarget(): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      // Linear on both, so a supersampled target resolves smoothly when the
      // final blit scales it down to canvas size.
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      samples: this.samples,
    });
    return rt;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(width * pixelRatio));
    this.height = Math.max(1, Math.floor(height * pixelRatio));
    for (const t of this.targets) t.setSize(this.width, this.height);
    this.clearTargets();
  }

  /**
   * Freshly allocated half-float targets can contain anything, including NaN.
   * Slot B is sampled every frame even when its weight is zero, and NaN * 0 is
   * still NaN, so both targets must start life cleared.
   */
  private clearTargets(): void {
    const prev = this.renderer.getRenderTarget();
    for (const t of this.targets) {
      this.renderer.setRenderTarget(t);
      this.renderer.clear(true, true, true);
    }
    this.renderer.setRenderTarget(prev);
  }

  setSamples(samples: number): void {
    if (samples === this.samples) return;
    this.samples = samples;
    for (const t of this.targets) {
      t.samples = samples;
      t.dispose();
      t.setSize(this.width, this.height);
    }
  }

  /** Renders one band into slot 0 or 1. */
  renderBand(slot: 0 | 1, scene: THREE.Scene, camera: THREE.Camera): void {
    const rt = this.targets[slot];
    this.renderer.setRenderTarget(rt);
    this.renderer.clear(true, true, true);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
  }

  /** Dissolves the two slots to the canvas. */
  present(wA: number, wB: number, tintA: THREE.Color, tintB: THREE.Color): void {
    const u = this.material.uniforms;
    u.tA.value = this.targets[0].texture;
    u.tB.value = this.targets[1].texture;
    u.wA.value = wA;
    u.wB.value = wB;
    (u.tintA.value as THREE.Color).copy(tintA);
    (u.tintB.value as THREE.Color).copy(tintB);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  setVignette(amount: number): void {
    this.material.uniforms.vignette.value = amount;
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    this.material.dispose();
  }
}
