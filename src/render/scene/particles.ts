// Ambient motion (DESIGN.md 2.8): world-space points drawn as single framebuffer pixels, depth-tested against
// the scene through the G-buffer. Every position is a pure function of time and a position hash, so a frozen
// clock gives a frozen frame. Particles never alter the sand and are off with reduced motion or in test mode.

import { BufferAttribute, BufferGeometry, GLSL3, Points, ShaderMaterial } from "three";
import type { MoodId, Vec3 } from "../../state/types.ts";
import { DIR_UNRAKED, SAND_H, SAND_W } from "../../sand/types.ts";
import type { SandGrid } from "../../sand/types.ts";
import { PARTICLE_FRAGMENT, PARTICLE_VERTEX } from "../pipeline/shaders.ts";
import { hash2 } from "../pipeline/tone.ts";

export const MAX_PARTICLES = 256;

const PAPER = 31;
const SKY2 = 19;
const WARM1 = 24;
const WARM2 = 25;
const WATER2 = 22;

export interface ParticleFrame {
  timeMs: number;
  mood: MoodId;
  rain: boolean;
  enabled: boolean;
  /** Where Gubba's tea (or pipe, or incense) steams from, in world units; null hides the steam. */
  steam: Vec3 | null;
  sand: SandGrid | null;
}

const PETALS = 12;
const PETAL_REST_MS = 40000;

export class Particles {
  readonly points: Points;
  private readonly pos = new Float32Array(MAX_PARTICLES * 3);
  private readonly slot = new Float32Array(MAX_PARTICLES).fill(-1);
  private readonly posAttr: BufferAttribute;
  private readonly slotAttr: BufferAttribute;
  private n = 0;
  /** Resting petals: the cycle each landed in and the `dir` byte under it at landing. */
  private readonly petalCycle = new Int32Array(PETALS).fill(-1);
  private readonly petalDir = new Uint8Array(PETALS);
  private readonly petalGone = new Uint8Array(PETALS);

  constructor() {
    const g = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.pos, 3);
    this.slotAttr = new BufferAttribute(this.slot, 1);
    g.setAttribute("position", this.posAttr);
    g.setAttribute("aSlot", this.slotAttr);
    const m = new ShaderMaterial({ glslVersion: GLSL3, vertexShader: PARTICLE_VERTEX, fragmentShader: PARTICLE_FRAGMENT });
    this.points = new Points(g, m);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
  }

  get count(): number {
    return this.n;
  }

  private push(x: number, y: number, z: number, s: number): void {
    if (this.n >= MAX_PARTICLES) return;
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.slot[i] = s;
  }

  update(f: ParticleFrame): void {
    this.n = 0;
    if (f.enabled) {
      const ms = f.timeMs;
      const t = ms / 1000;
      if (f.steam) {
        const fr = Math.floor(ms / 420) % 3;
        for (let k = 0; k < 3; k++) {
          const dy = k * 2.2;
          this.push(f.steam.x + ((fr + dy) % 2 ? 0.7 : -0.5), f.steam.y + dy + fr * 0.5, f.steam.z, PAPER);
        }
      }
      if (f.mood === "morning") this.mist(t);
      if (f.mood === "afternoon") {
        for (let i = 0; i < 7; i++) {
          const hx = (hash2(i, 1) % 300) - 120;
          const hz = (hash2(i, 2) % 150) - 70;
          const ph = (hash2(i, 3) % 628) / 100;
          this.push(hx, ((ph * 10 + t * 4) % 60) + 6, hz, WARM2);
        }
      }
      if (f.mood === "dusk") this.petals(ms, f.sand);
      if (f.mood === "moonlit") {
        for (let i = 0; i < 8; i++) {
          const hx = (hash2(i, 1) % 300) - 120;
          const hz = (hash2(i, 2) % 150) - 70;
          const ph = (hash2(i, 3) % 628) / 100;
          // a 1.5 s blink
          if (Math.sin((t * 2 * Math.PI) / 1.5 + ph) > 0.1) {
            this.push(hx + Math.sin(t / 4 + ph) * 10, 14 + (i % 4) * 6 + Math.cos(t / 3 + ph) * 3, hz, WARM2);
          }
        }
      }
      if (f.rain) this.rain(t, f.sand);
    }
    for (let i = this.n; i < MAX_PARTICLES; i++) this.slot[i] = -1;
    this.points.geometry.setDrawRange(0, Math.max(1, this.n));
    this.posAttr.needsUpdate = true;
    this.slotAttr.needsUpdate = true;
  }

  /** Two thin dithered sheets drifting at 2 units/s above the deck, never over the bed. */
  private mist(t: number): void {
    for (let sheet = 0; sheet < 2; sheet++) {
      const y = 9 + sheet * 7;
      const drift = (t * 2 + sheet * 37) % 24;
      for (let row = 0; row < 6; row++) {
        const z = 64 + row * 9 + sheet * 4;
        for (let col = 0; col < 7; col++) {
          const x = -150 + col * 48 + drift + (row & 1) * 12;
          if (Math.abs(x) < 104 && Math.abs(z) < 64) continue;
          this.push(x, y + (row & 1), z, sheet ? SKY2 : PAPER);
        }
      }
    }
  }

  /** Twelve petals falling through the scene; twelve resting on the sand until raked over or 40 s pass. */
  private petals(ms: number, sand: SandGrid | null): void {
    const t = ms / 1000;
    for (let i = 0; i < PETALS; i++) {
      const hx = (hash2(i, 1) % 300) - 120;
      const hz = (hash2(i, 2) % 150) - 70;
      const ph = (hash2(i, 3) % 628) / 100;
      this.push(hx + Math.sin(t + ph) * 6 + ((t * 3) % 40), 70 - ((t * 7 + ph * 20) % 70), hz, i % 2 ? WARM1 : WARM2);
    }
    if (!sand) return;
    for (let i = 0; i < PETALS; i++) {
      const offset = (hash2(i, 7) % PETAL_REST_MS) | 0;
      const cycle = Math.floor((ms + offset) / PETAL_REST_MS);
      const gx = 4 + (hash2(i, cycle * 3 + 1) % (SAND_W - 8));
      const gy = 4 + (hash2(i, cycle * 3 + 2) % (SAND_H - 8));
      const cell = gy * SAND_W + gx;
      const dir = sand.dir[cell] ?? DIR_UNRAKED;
      if (this.petalCycle[i] !== cycle) {
        this.petalCycle[i] = cycle;
        this.petalDir[i] = dir;
        this.petalGone[i] = 0;
      } else if (dir !== this.petalDir[i]) {
        this.petalGone[i] = 1; // raked over
      }
      if (this.petalGone[i] || (sand.rock[cell] ?? 0) !== 0) continue;
      const h = sand.height[cell] ?? 0;
      this.push(gx + 0.5 - SAND_W / 2, 3 + 0.35 * h + 0.3, gy + 0.5 - SAND_H / 2, i % 2 ? WARM1 : WARM2);
    }
  }

  /** Streaks above, and 3-frame ripple rings on the sand. Cosmetic only. */
  private rain(t: number, sand: SandGrid | null): void {
    for (let i = 0; i < 24; i++) {
      const hx = (hash2(i, 11) % 320) - 130;
      const hz = (hash2(i, 12) % 170) - 75;
      const ph = (hash2(i, 13) % 100) / 100;
      const y = 90 - ((t * 110 + ph * 90) % 90);
      for (let k = 0; k < 3; k++) this.push(hx - k * 0.3, y + k * 2, hz, WATER2);
    }
    const frame = Math.floor(t / 0.12);
    const ring = frame % 3;
    for (let i = 0; i < 8; i++) {
      const cyc = Math.floor(frame / 3) * 8 + i;
      const gx = 4 + (hash2(cyc, 21) % (SAND_W - 8));
      const gy = 4 + (hash2(cyc, 22) % (SAND_H - 8));
      const h = sand ? (sand.height[gy * SAND_W + gx] ?? 0) : 0;
      const x = gx - SAND_W / 2;
      const z = gy - SAND_H / 2;
      const y = 3 + 0.35 * h + 0.2;
      const r = 1 + ring;
      this.push(x + r, y, z, WATER2);
      this.push(x - r, y, z, WATER2);
      this.push(x, y, z + r, WATER2);
      this.push(x, y, z - r, WATER2);
    }
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as ShaderMaterial).dispose();
  }
}
