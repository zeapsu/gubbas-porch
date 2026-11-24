// The five-pass WebGL2 pixel pipeline (DESIGN.md 2.1, 2.2):
//   1 shadow   1024² orthographic depth from the mood's light, fitted to radius 215 round (24, 10, 0)
//   2 scene    low-res two-attachment G-buffer + depth texture, NearestFilter, no MSAA
//   3 resolve  G-buffer → 32-colour palette: cel steps, Bayer 4×4 dither, shadow cap, sky bands, ink outlines
//   4 overlay  palette-indexed HUD and text pixels over the resolved frame (same pixel size as the scene)
//   5 present  nearest-neighbour blit to the canvas at integer scale k
// The shadow pass is an unfiltered single-sample depth compare, i.e. Three's BasicShadowMap semantics, done with
// our own depth material so the G-buffer shader can test shadows per pixel with the slope-scaled bias.

import {
  DataTexture,
  DepthTexture,
  FloatType,
  GLSL3,
  Matrix4,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  RedFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from "three";
import type { IUniform } from "three";
import type { CameraRig, GubbaVariant, MoodId, PickResult, PixelDensity, Vec2 } from "../../state/types.ts";
import { CAMERA_FAR, CAMERA_NEAR, FOV_DEG, cameraPositionInto, sandPointFromRay, worldUnitsPerPixel } from "../camera/rig.ts";
import { MOOD_LIGHTS, RAMPS, getPaletteRgba, interpolatePaletteRgba } from "../palettes.ts";
import type { GardenFrame, GardenScene } from "../scene/gardenScene.ts";
import {
  FULLSCREEN_VERTEX,
  OVERLAY_FRAGMENT,
  PRESENT_FRAGMENT,
  RAMP_COUNT,
  RAMP_MAX_LEN,
  RESOLVE_FRAGMENT,
  SLOT,
} from "./shaders.ts";
import { TARGET_ROWS, pixelScaleFor } from "./tone.ts";

export const SHADOW_MAP_SIZE = 1024;
export const SHADOW_CENTER = new Vector3(24, 10, 0);
export const SHADOW_RADIUS = 215;
const SHADOW_DISTANCE = SHADOW_RADIUS * 2;
const PALETTE_STEP_MS = 500;

export interface FramebufferSize {
  fbW: number;
  fbH: number;
  /** Integer device pixels per framebuffer pixel. */
  scale: number;
}

/** Framebuffer size for a device-pixel window: k = max(1, round(deviceH / targetRows)), fb = ceil(device / k). */
export function framebufferFor(deviceW: number, deviceH: number, density: PixelDensity): FramebufferSize {
  const scale = pixelScaleFor(Math.max(1, deviceH), density);
  return { fbW: Math.max(1, Math.ceil(deviceW / scale)), fbH: Math.max(1, Math.ceil(deviceH / scale)), scale };
}

function rampUniforms(): { slots: number[]; lens: number[] } {
  const slots = new Array<number>(RAMP_COUNT * RAMP_MAX_LEN).fill(SLOT.ink);
  const lens = new Array<number>(RAMP_COUNT).fill(1);
  for (const def of Object.values(RAMPS)) {
    if (def.id < 0 || def.id >= RAMP_COUNT) continue;
    lens[def.id] = Math.min(RAMP_MAX_LEN, def.slots.length);
    def.slots.slice(0, RAMP_MAX_LEN).forEach((s, i) => {
      slots[def.id * RAMP_MAX_LEN + i] = s;
    });
  }
  return { slots, lens };
}

function fullscreen(material: ShaderMaterial): Scene {
  const s = new Scene();
  const m = new Mesh(new PlaneGeometry(2, 2), material);
  m.frustumCulled = false;
  s.add(m);
  return s;
}

function makeTarget(w: number, h: number): WebGLRenderTarget {
  return new WebGLRenderTarget(w, h, {
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    generateMipmaps: false,
    samples: 0,
  });
}

export class RenderPipeline {
  readonly renderer: WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  /** Uniforms shared by every G-buffer material (light, shadow map, framebuffer size, mood toggles). */
  readonly shared: Record<string, IUniform>;
  fbW = 1;
  fbH = 1;
  scale = 1;
  density: PixelDensity = "crisp";
  /** Draw calls in the last frame (all five passes). */
  drawCalls = 0;

  private gbuffer: WebGLRenderTarget;
  private resolveRT: WebGLRenderTarget;
  private finalRT: WebGLRenderTarget;
  private readonly shadowRT: WebGLRenderTarget;
  private readonly camera = new PerspectiveCamera(FOV_DEG, 1, CAMERA_NEAR, CAMERA_FAR);
  private readonly lightCamera = new OrthographicCamera(-SHADOW_RADIUS, SHADOW_RADIUS, SHADOW_RADIUS, -SHADOW_RADIUS, 1, SHADOW_DISTANCE * 2);
  private readonly fsCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly resolveMat: ShaderMaterial;
  private readonly overlayMat: ShaderMaterial;
  private readonly presentMat: ShaderMaterial;
  private readonly resolveScene: Scene;
  private readonly overlayScene: Scene;
  private readonly presentScene: Scene;
  private readonly paletteTex: DataTexture;
  private overlayTex: DataTexture;
  private readonly lightMatrix = new Matrix4();
  private readonly lastRig: CameraRig = { target: { x: 0, y: 0, z: 0 }, az: 0, el: 0, dist: 1 };
  private readonly camPosBuf = { x: 0, y: 0, z: 0 };
  private garden: GardenScene | null = null;
  private readBuf = new Uint8Array(4);
  private readonly pickBuf = new Uint8Array(4);

  // palette fade state
  private paletteMood: MoodId | null = null;
  private paletteVariant: GubbaVariant | null = null;
  private readonly displayed = new Uint8Array(32 * 4);
  private fadeFrom: Uint8Array = new Uint8Array(32 * 4);
  private fadeTo: Uint8Array = new Uint8Array(32 * 4);
  private fadeT0 = 0;
  private fadeStep = 4;
  private readonly paletteSet = new Set<number>();
  private sunSlot: number = SLOT.warm2;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "default",
    });
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = false;

    this.shadowRT = new WebGLRenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: true,
      depthTexture: new DepthTexture(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, FloatType),
      generateMipmaps: false,
      samples: 0,
    });

    this.paletteTex = new DataTexture(this.displayed, 32, 1, RGBAFormat, UnsignedByteType);
    this.paletteTex.minFilter = NearestFilter;
    this.paletteTex.magFilter = NearestFilter;
    this.paletteTex.generateMipmaps = false;
    this.paletteTex.needsUpdate = true;

    this.shared = {
      uFbSize: { value: new Vector2(1, 1) },
      uLightDir: { value: new Vector3(0, 1, 0) },
      uShadowMap: { value: this.shadowRT.depthTexture },
      uLightMatrix: { value: this.lightMatrix },
      uLightDepthRange: { value: SHADOW_DISTANCE * 2 - 1 },
      uShadowsOn: { value: 1 },
      uGlowLit: { value: 0 },
      uRippleFrame: { value: 0 },
    };

    this.gbuffer = this.makeGBuffer(1, 1);
    this.resolveRT = makeTarget(1, 1);
    this.finalRT = makeTarget(1, 1);
    this.overlayTex = this.makeOverlayTex(new Uint8Array(1).fill(255), 1, 1);

    const ramps = rampUniforms();
    this.resolveMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: RESOLVE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tG0: { value: this.gbuffer.textures[0] },
        tG1: { value: this.gbuffer.textures[1] },
        tDepth: { value: this.gbuffer.depthTexture },
        tPalette: { value: this.paletteTex },
        uFbSize: this.shared.uFbSize as IUniform,
        uAmbient: { value: 0.32 },
        uNear: { value: CAMERA_NEAR },
        uFar: { value: CAMERA_FAR },
        uRampSlots: { value: ramps.slots },
        uRampLen: { value: ramps.lens },
        uSun: { value: new Vector3(0, 0, SLOT.warm2) },
      },
    });
    this.overlayMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: OVERLAY_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: this.resolveRT.texture },
        tOverlay: { value: this.overlayTex },
        tPalette: { value: this.paletteTex },
        uFbSize: this.shared.uFbSize as IUniform,
        uOverlayOn: { value: 1 },
      },
    });
    this.presentMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: PRESENT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: { tFinal: { value: this.finalRT.texture }, uScale: { value: 1 } },
    });
    this.resolveScene = fullscreen(this.resolveMat);
    this.overlayScene = fullscreen(this.overlayMat);
    this.presentScene = fullscreen(this.presentMat);
    this.setPalette("afternoon", "moss", 0, true);
  }

  private makeGBuffer(w: number, h: number): WebGLRenderTarget {
    return new WebGLRenderTarget(w, h, {
      count: 2,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      format: RGBAFormat,
      type: UnsignedByteType,
      depthBuffer: true,
      depthTexture: new DepthTexture(w, h, FloatType),
      generateMipmaps: false,
      samples: 0,
    });
  }

  private makeOverlayTex(data: Uint8Array, w: number, h: number): DataTexture {
    const t = new DataTexture(data, w, h, RedFormat, UnsignedByteType);
    t.minFilter = NearestFilter;
    t.magFilter = NearestFilter;
    t.generateMipmaps = false;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
  }

  /** Attaches the scene whose parts `pick` resolves. */
  setGarden(garden: GardenScene): void {
    this.garden = garden;
  }

  /**
   * Sizes the framebuffer for a window of deviceW × deviceH device pixels. The canvas backing store becomes
   * exactly fb · k device pixels and its CSS size that divided by `devicePixelRatio`, so every scene pixel is
   * k × k device pixels.
   */
  resize(deviceW: number, deviceH: number, density: PixelDensity, devicePixelRatio = 1): FramebufferSize {
    const size = framebufferFor(deviceW, deviceH, density);
    this.density = density;
    this.scale = size.scale;
    const cw = size.fbW * size.scale;
    const ch = size.fbH * size.scale;
    this.renderer.setSize(cw, ch, false);
    const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
    this.canvas.style.width = `${cw / dpr}px`;
    this.canvas.style.height = `${ch / dpr}px`;
    (this.presentMat.uniforms.uScale as IUniform<number>).value = size.scale;
    if (size.fbW !== this.fbW || size.fbH !== this.fbH) {
      this.fbW = size.fbW;
      this.fbH = size.fbH;
      this.gbuffer.depthTexture?.dispose();
      this.gbuffer.dispose();
      this.resolveRT.dispose();
      this.finalRT.dispose();
      this.overlayTex.dispose();
      this.gbuffer = this.makeGBuffer(this.fbW, this.fbH);
      this.resolveRT = makeTarget(this.fbW, this.fbH);
      this.finalRT = makeTarget(this.fbW, this.fbH);
      this.overlayTex = this.makeOverlayTex(new Uint8Array(this.fbW * this.fbH).fill(255), this.fbW, this.fbH);
      const ru = this.resolveMat.uniforms;
      (ru.tG0 as IUniform).value = this.gbuffer.textures[0];
      (ru.tG1 as IUniform).value = this.gbuffer.textures[1];
      (ru.tDepth as IUniform).value = this.gbuffer.depthTexture;
      (this.overlayMat.uniforms.tScene as IUniform).value = this.resolveRT.texture;
      (this.overlayMat.uniforms.tOverlay as IUniform).value = this.overlayTex;
      (this.presentMat.uniforms.tFinal as IUniform).value = this.finalRT.texture;
      (this.shared.uFbSize as IUniform<Vector2>).value.set(this.fbW, this.fbH);
      this.readBuf = new Uint8Array(this.fbW * this.fbH * 4);
    }
    return { fbW: this.fbW, fbH: this.fbH, scale: this.scale };
  }

  /**
   * Selects the mood palette (with Gubba variant slots 26–29). A change fades through four steps over 2 s, or
   * switches at once with reduced motion.
   */
  setPalette(mood: MoodId, variant: GubbaVariant, timeMs: number, reducedMotion: boolean): void {
    if (mood !== this.paletteMood || variant !== this.paletteVariant) {
      const first = this.paletteMood === null;
      this.paletteMood = mood;
      this.paletteVariant = variant;
      this.fadeFrom = new Uint8Array(this.displayed);
      this.fadeTo = getPaletteRgba(mood, variant);
      this.fadeT0 = timeMs;
      this.fadeStep = first || reducedMotion ? 4 : 0;
      this.sunSlot = mood === "moonlit" || mood === "morning" ? SLOT.paper : SLOT.warm2;
      this.uploadPalette(this.fadeStep >= 4 ? this.fadeTo : interpolatePaletteRgba(this.fadeFrom, this.fadeTo, 0));
      if (this.fadeStep >= 4) return;
    }
    if (this.fadeStep < 4) {
      const step = Math.min(4, 1 + Math.floor((timeMs - this.fadeT0) / PALETTE_STEP_MS));
      if (step !== this.fadeStep) {
        this.fadeStep = step;
        this.uploadPalette(step >= 4 ? this.fadeTo : interpolatePaletteRgba(this.fadeFrom, this.fadeTo, step));
      }
    }
  }

  private uploadPalette(rgba: Uint8Array): void {
    this.displayed.set(rgba);
    this.paletteTex.needsUpdate = true;
    this.paletteSet.clear();
    for (let i = 0; i < 32; i++) this.paletteSet.add(((rgba[i * 4] ?? 0) << 16) | ((rgba[i * 4 + 1] ?? 0) << 8) | (rgba[i * 4 + 2] ?? 0));
  }

  /** The 32 colours currently on screen (RGBA), mid-fade included. */
  activePalette(): Uint8Array {
    return new Uint8Array(this.displayed);
  }

  /** Renders one frame through all five passes. `overlay` is fbW × fbH palette indices (255 = transparent). */
  render(garden: GardenScene, frame: GardenFrame, rig: CameraRig, overlay: Uint8Array | null): void {
    const r = this.renderer;
    this.garden = garden;
    r.info.reset();
    this.setPalette(frame.mood, frame.gubbaVariant, frame.timeMs, frame.reducedMotion);

    // light
    const light = MOOD_LIGHTS[frame.mood];
    const L = (this.shared.uLightDir as IUniform<Vector3>).value.set(light.dir[0], light.dir[1], light.dir[2]).normalize();
    const lc = this.lightCamera;
    lc.position.copy(SHADOW_CENTER).addScaledVector(L, SHADOW_DISTANCE);
    lc.up.set(0, Math.abs(L.y) > 0.95 ? 0 : 1, Math.abs(L.y) > 0.95 ? 1 : 0);
    lc.lookAt(SHADOW_CENTER);
    lc.updateMatrixWorld(true);
    lc.updateProjectionMatrix();
    this.lightMatrix.multiplyMatrices(lc.projectionMatrix, lc.matrixWorldInverse);
    (this.resolveMat.uniforms.uAmbient as IUniform<number>).value = light.ambient;

    // camera
    this.lastRig.target.x = rig.target.x;
    this.lastRig.target.y = rig.target.y;
    this.lastRig.target.z = rig.target.z;
    this.lastRig.az = rig.az;
    this.lastRig.el = rig.el;
    this.lastRig.dist = rig.dist;
    const cam = this.camera;
    const p = cameraPositionInto(this.camPosBuf, rig);
    cam.aspect = this.fbW / this.fbH;
    cam.updateProjectionMatrix();
    cam.position.set(p.x, p.y, p.z);
    cam.up.set(0, 1, 0);
    cam.lookAt(rig.target.x, rig.target.y, rig.target.z);
    cam.updateMatrixWorld(true);

    const sandE = Math.max(0.75, (0.55 * worldUnitsPerPixel(rig, this.fbH)) / Math.max(0.35, Math.sin(rig.el)));
    garden.update(frame, r, sandE);

    // pass 1: shadow depth
    garden.shadowMode(true);
    r.setRenderTarget(this.shadowRT);
    r.setClearColor(0xffffff, 1);
    r.clear(true, true, false);
    r.render(garden.scene, lc);
    garden.shadowMode(false);

    // pass 2: G-buffer
    r.setRenderTarget(this.gbuffer);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(garden.scene, cam);

    // pass 3: resolve
    (this.resolveMat.uniforms.uSun as IUniform<Vector3>).value.set(0, 0, this.sunSlot);
    r.setRenderTarget(this.resolveRT);
    r.render(this.resolveScene, this.fsCamera);

    // pass 4: overlay
    const on = overlay !== null && overlay.length === this.fbW * this.fbH;
    if (on) {
      this.overlayTex.image.data = overlay;
      this.overlayTex.needsUpdate = true;
    }
    (this.overlayMat.uniforms.uOverlayOn as IUniform<number>).value = on ? 1 : 0;
    r.setRenderTarget(this.finalRT);
    r.render(this.overlayScene, this.fsCamera);

    // pass 5: present
    r.setRenderTarget(null);
    r.render(this.presentScene, this.fsCamera);
    this.drawCalls = r.info.render.calls;
  }

  /** Raw G-buffer part id under framebuffer pixel (fbX, fbY), origin top-left. */
  pickPart(fbX: number, fbY: number): number {
    const x = Math.floor(fbX);
    const y = Math.floor(fbY);
    if (x < 0 || y < 0 || x >= this.fbW || y >= this.fbH) return 0;
    this.renderer.readRenderTargetPixels(this.gbuffer, x, this.fbH - 1 - y, 1, 1, this.pickBuf);
    return this.pickBuf[3] ?? 0;
  }

  /** What the pointer is over: reads the part-id channel of the last G-buffer. */
  pick(fbX: number, fbY: number): PickResult {
    const part = this.pickPart(fbX, fbY);
    return this.garden ? this.garden.pickResult(part) : { kind: "none" };
  }

  /** The pointer ray against the sand plane y = 3, in float grid coordinates; null if it misses the plane. */
  sandPoint(fbX: number, fbY: number): Vec2 | null {
    return sandPointFromRay(this.lastRig, fbX, fbY, this.fbW, this.fbH);
  }

  /** The resolved low-res frame as RGBA rows, top row first. `includeOverlay` false omits pass 4. */
  readPixels(includeOverlay = true): Uint8Array {
    const w = this.fbW;
    const h = this.fbH;
    this.renderer.readRenderTargetPixels(includeOverlay ? this.finalRT : this.resolveRT, 0, 0, w, h, this.readBuf);
    const out = new Uint8Array(w * h * 4);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.set(this.readBuf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  }

  /** Pixels of the resolved frame (overlay included) that are not one of the 32 colours on screen. */
  paletteViolations(): number {
    const px = this.readPixels(true);
    let bad = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (!this.paletteSet.has(((px[i] ?? 0) << 16) | ((px[i + 1] ?? 0) << 8) | (px[i + 2] ?? 0))) bad++;
    }
    return bad;
  }

  /** A nearest-neighbour PNG of the resolved frame at an integer scale (4, 6, 8 or 12 in the menu). */
  async exportPng(scale = 4, includeOverlay = true): Promise<Blob> {
    const k = Math.max(1, Math.floor(scale));
    const src = this.readPixels(includeOverlay);
    const w = this.fbW;
    const h = this.fbH;
    const W = w * k;
    const H = h * k;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const sy = Math.floor(y / k);
      for (let x = 0; x < W; x++) {
        const s = (sy * w + Math.floor(x / k)) * 4;
        const d = (y * W + x) * 4;
        data[d] = src[s] ?? 0;
        data[d + 1] = src[s + 1] ?? 0;
        data[d + 2] = src[s + 2] ?? 0;
        data[d + 3] = 255;
      }
    }
    const image = new ImageData(data, W, H);
    if (typeof OffscreenCanvas !== "undefined") {
      const oc = new OffscreenCanvas(W, H);
      const ctx = oc.getContext("2d");
      if (ctx) {
        ctx.putImageData(image, 0, 0);
        return oc.convertToBlob({ type: "image/png" });
      }
    }
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    c.getContext("2d")?.putImageData(image, 0, 0);
    return new Promise<Blob>((resolve, reject) => {
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png");
    });
  }

  /** Target rows for a density (205 Crisp, 137 Chunky). */
  static targetRows(density: PixelDensity): number {
    return TARGET_ROWS[density];
  }

  dispose(): void {
    this.gbuffer.depthTexture?.dispose();
    this.gbuffer.dispose();
    this.resolveRT.dispose();
    this.finalRT.dispose();
    this.shadowRT.depthTexture?.dispose();
    this.shadowRT.dispose();
    this.overlayTex.dispose();
    this.paletteTex.dispose();
    for (const s of [this.resolveScene, this.overlayScene, this.presentScene]) {
      s.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
    }
    this.resolveMat.dispose();
    this.overlayMat.dispose();
    this.presentMat.dispose();
    this.renderer.dispose();
  }
}
