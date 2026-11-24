// Public face of the renderer: one object that owns the WebGL2 pipeline, the garden scene and the overlay.
//
//   const r = await RakeRenderer.create(canvas);          // loads the 30 models
//   r.resize(innerWidth * dpr, innerHeight * dpr, "crisp", dpr);
//   r.render(frame, cameraRig, overlayState);              // every animation frame
//   r.overlayHit(fbX, fbY) ?? r.pick(fbX, fbY);            // pointer: HUD/menu first, then the 3D scene
//   r.sandPoint(fbX, fbY);                                 // pointer ray on the sand plane, grid coordinates

import type { CameraRig, PickResult, PixelDensity, Vec2 } from "../state/types.ts";
import { Overlay } from "./overlay/overlay.ts";
import type { OverlayAction, OverlayHit, OverlayState } from "./overlay/overlay.ts";
import { RenderPipeline } from "./pipeline/pipeline.ts";
import type { FramebufferSize } from "./pipeline/pipeline.ts";
import { loadModels } from "./scene/assets.ts";
import { GardenScene } from "./scene/gardenScene.ts";
import type { GardenFrame } from "./scene/gardenScene.ts";

export * from "./camera/index.ts";
export * from "./pipeline/tone.ts";
export { RenderPipeline, framebufferFor, SHADOW_MAP_SIZE, SHADOW_RADIUS } from "./pipeline/pipeline.ts";
export type { FramebufferSize } from "./pipeline/pipeline.ts";
export { GardenScene, MAX_ELEMENTS } from "./scene/gardenScene.ts";
export type { GardenFrame } from "./scene/gardenScene.ts";
export { RACK_ORDER, RACK_SLOTS, MODEL_SPECS } from "./scene/assets.ts";
export { Overlay, PRESET_LABELS } from "./overlay/overlay.ts";
export type { OverlayAction, OverlayHit, OverlayState, SettingsPatch, SettingsTab, MixChannel } from "./overlay/overlay.ts";
export type { HudId } from "./overlay/hud.ts";
export { measureText, wrapText } from "./overlay/font.ts";

/** True when the browser can create a WebGL2 context (the two-attachment G-buffer needs it). */
export function webgl2Available(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

export interface RakeRendererOptions {
  /** Defaults to `import.meta.env.BASE_URL`. */
  baseUrl?: string;
  onProgress?: (loaded: number, total: number) => void;
}

export class RakeRenderer {
  readonly pipeline: RenderPipeline;
  readonly garden: GardenScene;
  readonly overlay: Overlay;
  /** Spec ids whose files failed to load or are still placeholders; they render as procedural stand-ins. */
  readonly failedModels: readonly string[];
  readonly standInModels: readonly string[];
  private hits: readonly OverlayHit[] = [];

  private constructor(pipeline: RenderPipeline, garden: GardenScene, failed: string[], standIns: string[]) {
    this.pipeline = pipeline;
    this.garden = garden;
    this.overlay = new Overlay(pipeline.fbW, pipeline.fbH);
    this.failedModels = failed;
    this.standInModels = standIns;
    pipeline.setGarden(garden);
  }

  /** Creates the WebGL2 pipeline and loads every model. Throws only if WebGL2 itself is unavailable. */
  static async create(canvas: HTMLCanvasElement, opts: RakeRendererOptions = {}): Promise<RakeRenderer> {
    const pipeline = new RenderPipeline(canvas);
    const models = await loadModels(opts.baseUrl, opts.onProgress);
    const garden = new GardenScene(models, pipeline.shared);
    return new RakeRenderer(pipeline, garden, models.failed, models.standIns);
  }

  get fbW(): number {
    return this.pipeline.fbW;
  }

  get fbH(): number {
    return this.pipeline.fbH;
  }

  get scale(): number {
    return this.pipeline.scale;
  }

  get drawCalls(): number {
    return this.pipeline.drawCalls;
  }

  resize(deviceW: number, deviceH: number, density: PixelDensity, devicePixelRatio = 1): FramebufferSize {
    const size = this.pipeline.resize(deviceW, deviceH, density, devicePixelRatio);
    this.overlay.resize(size.fbW, size.fbH);
    return size;
  }

  /** Draws one frame. With `overlay` null the HUD is hidden (e.g. a clean export from the current camera). */
  render(frame: GardenFrame, camera: CameraRig, overlay: OverlayState | null): void {
    this.hits = overlay ? this.overlay.draw(overlay) : [];
    this.pipeline.render(this.garden, frame, camera, overlay ? this.overlay.pixels : null);
  }

  /** Hit rectangles of the last drawn overlay. */
  overlayHits(): readonly OverlayHit[] {
    return this.hits;
  }

  /** The HUD or menu control under framebuffer point (fbX, fbY), or null if the overlay is clear there. */
  overlayHit(fbX: number, fbY: number): OverlayAction | null {
    return this.hits.length ? this.overlay.hitTest(fbX, fbY) : null;
  }

  /** What 3D object is under framebuffer point (fbX, fbY), from the G-buffer's part-id channel. */
  pick(fbX: number, fbY: number): PickResult {
    return this.pipeline.pick(fbX, fbY);
  }

  sandPoint(fbX: number, fbY: number): Vec2 | null {
    return this.pipeline.sandPoint(fbX, fbY);
  }

  /** Converts a client (CSS pixel) position on the canvas into framebuffer pixels. */
  clientToFramebuffer(clientX: number, clientY: number): Vec2 {
    const r = this.pipeline.canvas.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / Math.max(1, r.width)) * this.pipeline.fbW,
      y: ((clientY - r.top) / Math.max(1, r.height)) * this.pipeline.fbH,
    };
  }

  readPixels(includeOverlay = true): Uint8Array {
    return this.pipeline.readPixels(includeOverlay);
  }

  paletteViolations(): number {
    return this.pipeline.paletteViolations();
  }

  /** FNV-1a over the resolved frame, for golden-frame tests. */
  frameHash(): number {
    const px = this.pipeline.readPixels(true);
    let h = 0x811c9dc5;
    for (let i = 0; i < px.length; i++) h = Math.imul(h ^ (px[i] ?? 0), 0x01000193);
    return h >>> 0;
  }

  exportPng(scale = 4, includeOverlay = true): Promise<Blob> {
    return this.pipeline.exportPng(scale, includeOverlay);
  }

  dispose(): void {
    this.garden.dispose();
    this.pipeline.dispose();
  }
}
