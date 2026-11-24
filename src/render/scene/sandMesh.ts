// The sand bed in 3D (DESIGN.md 3.5): a 192×112-segment plane at y = 3 whose vertex shader lifts each vertex by
// 0.35 · height, lit per pixel in the fragment shader from the height gradient. `height` (+3, so 0…6) and `dir`
// live in two 192×112 R8 textures; after each batch of stamps only the dirty rectangle is re-uploaded.

import {
  Box2,
  DataTexture,
  LinearFilter,
  Mesh,
  NearestFilter,
  PlaneGeometry,
  RedFormat,
  ShaderMaterial,
  GLSL3,
  UnsignedByteType,
  Vector2,
  Vector4,
  ClampToEdgeWrapping,
} from "three";
import type { IUniform, WebGLRenderer } from "three";
import { DIR_UNRAKED, SAND_H, SAND_W } from "../../sand/types.ts";
import type { SandGrid, SandRect } from "../../sand/types.ts";
import { SAND_FRAGMENT, SAND_VERTEX } from "../pipeline/shaders.ts";

function makeR8(data: Uint8Array, linear: boolean): DataTexture {
  const t = new DataTexture(data, SAND_W, SAND_H, RedFormat, UnsignedByteType);
  t.minFilter = linear ? LinearFilter : NearestFilter;
  t.magFilter = linear ? LinearFilter : NearestFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export class SandMesh {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  /** CPU staging copies (height + 3, dir) that dirty rectangles are copied out of. */
  private readonly heightBytes = new Uint8Array(SAND_W * SAND_H).fill(3);
  private readonly dirBytes = new Uint8Array(SAND_W * SAND_H).fill(DIR_UNRAKED);
  private readonly heightStage: DataTexture;
  private readonly dirStage: DataTexture;
  readonly heightTex: DataTexture;
  readonly dirTex: DataTexture;
  private readonly region = new Box2();
  private readonly dst = new Vector2();
  private pendingFull = true;
  private hasDirty = false;
  private readonly dirty = { x0: 0, y0: 0, x1: 0, y1: 0 };
  readonly glow: Vector4[] = [new Vector4(), new Vector4(), new Vector4(), new Vector4()];

  constructor(shared: Record<string, IUniform>) {
    const geo = new PlaneGeometry(SAND_W, SAND_H, SAND_W, SAND_H);
    geo.rotateX(-Math.PI / 2); // into the xz plane, normal +y; local y = 0
    geo.translate(0, 3, 0);
    this.heightStage = makeR8(this.heightBytes, true);
    this.dirStage = makeR8(this.dirBytes, false);
    // the GPU textures start as full copies; later frames patch them from the staging textures
    this.heightTex = makeR8(new Uint8Array(this.heightBytes), true);
    this.dirTex = makeR8(new Uint8Array(this.dirBytes), false);
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: SAND_VERTEX,
      fragmentShader: SAND_FRAGMENT,
      uniforms: {
        ...shared,
        uHeight: { value: this.heightTex },
        uDir: { value: this.dirTex },
        uSandE: { value: 0.75 },
        uSweepE: { value: -1 },
        uThread: { value: 0 },
        uGlow: { value: this.glow },
        uGlowCount: { value: 0 },
      },
    });
    this.mesh = new Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  /** Marks the whole grid for upload (after load, preset or sweep). */
  markAll(): void {
    this.pendingFull = true;
  }

  /** Copies the grid cells inside `rect` into the staging bytes and queues them for upload. */
  markDirty(grid: SandGrid, rect: SandRect | null): void {
    if (!rect) return;
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(SAND_W, Math.ceil(rect.x + rect.w));
    const y1 = Math.min(SAND_H, Math.ceil(rect.y + rect.h));
    if (x1 <= x0 || y1 <= y0) return;
    this.copyCells(grid, x0, y0, x1, y1);
    const d = this.dirty;
    if (this.hasDirty) {
      d.x0 = Math.min(d.x0, x0);
      d.y0 = Math.min(d.y0, y0);
      d.x1 = Math.max(d.x1, x1);
      d.y1 = Math.max(d.y1, y1);
    } else {
      d.x0 = x0;
      d.y0 = y0;
      d.x1 = x1;
      d.y1 = y1;
      this.hasDirty = true;
    }
  }

  private copyCells(grid: SandGrid, x0: number, y0: number, x1: number, y1: number): void {
    const hb = this.heightBytes;
    const db = this.dirBytes;
    const h = grid.height;
    const d = grid.dir;
    for (let y = y0; y < y1; y++) {
      let i = y * SAND_W + x0;
      for (let x = x0; x < x1; x++, i++) {
        const v = h[i] ?? 0;
        hb[i] = (v < -3 ? -3 : v > 3 ? 3 : v) + 3;
        db[i] = d[i] ?? DIR_UNRAKED;
      }
    }
  }

  /** Uploads whatever changed since the last frame. `grid` is read in full when a full upload is pending. */
  upload(renderer: WebGLRenderer, grid: SandGrid | null): void {
    if (this.pendingFull) {
      if (grid) this.copyCells(grid, 0, 0, SAND_W, SAND_H);
      (this.heightTex.image.data as Uint8Array).set(this.heightBytes);
      (this.dirTex.image.data as Uint8Array).set(this.dirBytes);
      this.heightTex.needsUpdate = true;
      this.dirTex.needsUpdate = true;
      this.pendingFull = false;
      this.hasDirty = false;
      return;
    }
    if (!this.hasDirty) return;
    const r = this.dirty;
    this.region.min.set(r.x0, r.y0);
    this.region.max.set(r.x1, r.y1);
    this.dst.set(r.x0, r.y0);
    renderer.copyTextureToTexture(this.heightStage, this.heightTex, this.region, this.dst);
    renderer.copyTextureToTexture(this.dirStage, this.dirTex, this.region, this.dst);
    this.hasDirty = false;
  }

  /** Frame uniforms: gradient spacing, sweep progress (−1 = none), breath thread length, lantern glows. */
  setFrame(e: number, sweepE: number, threadCells: number, glowCount: number): void {
    const u = this.material.uniforms;
    (u.uSandE as IUniform<number>).value = e;
    (u.uSweepE as IUniform<number>).value = sweepE;
    (u.uThread as IUniform<number>).value = threadCells;
    (u.uGlowCount as IUniform<number>).value = Math.min(4, glowCount);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.heightTex.dispose();
    this.dirTex.dispose();
    this.heightStage.dispose();
    this.dirStage.dispose();
  }
}
