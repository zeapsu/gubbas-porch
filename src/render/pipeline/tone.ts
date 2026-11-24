// Cel-step maths shared by the CPU (tests, export) and the GLSL generated in shaders.ts (DESIGN.md 2.1, 3.5).
// Pure: no browser globals, time, or randomness.

/** Bayer 4×4 ordered-dither matrix, indexed by (x & 3) + 4·(y & 3) in framebuffer pixels (y down). */
export const BAYER4: readonly number[] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Dither weight for ramp surfaces. Deliberately small: it softens band edges without turning surfaces to noise. */
export const RAMP_DITHER = 0.22;
/** Dither weight for the per-pixel sand tone. */
export const SAND_DITHER = 0.5;
/** Shadowed or back-facing surfaces are capped at this fraction of the ambient term. */
export const SHADOW_AMBIENT_CAP = 0.55;
/** N·L at or below which a surface counts as unlit. */
export const UNLIT_NDL = 0.04;
/** Sand tone: t = SAND_BASE + SAND_SLOPE · s + SAND_HEIGHT · h − (shadowed ? SAND_SHADOW : 0). */
export const SAND_BASE = 2;
export const SAND_SLOPE = 0.72;
export const SAND_HEIGHT = 0.32;
export const SAND_SHADOW = 1.35;
/** Outline: a neighbour must be nearer by more than this ratio in inverse depth. */
export const OUTLINE_DEPTH_RATIO = 1.012;
/** World-unit vertical lift per sand level in the sand mesh. */
export const SAND_LIFT_PER_LEVEL = 0.35;

/** Normalised Bayer threshold `(v + 0.5) / 16` for framebuffer pixel (x, y). */
export function bayerAt(x: number, y: number): number {
  return ((BAYER4[(x & 3) + 4 * (y & 3)] ?? 0) + 0.5) / 16;
}

/** Wrap lighting with the mood's ambient term; shadowed or unlit surfaces are capped (DESIGN.md 2.1). */
export function lightIntensity(ndl: number, ambient: number, shadowed: boolean): number {
  let i = ndl * (1 - ambient) + ambient;
  if (shadowed || ndl <= UNLIT_NDL) i = Math.min(i, SHADOW_AMBIENT_CAP * ambient);
  return i;
}

/** Ramp tone index in 0…n−1: `clamp(floor(I · n + (b − 0.5) · dither), 0, n − 1)`. */
export function toneFor(intensity: number, rampLength: number, bayer: number, dither: number = RAMP_DITHER): number {
  const n = Math.max(1, Math.floor(rampLength));
  const t = Math.floor(intensity * n + (bayer - 0.5) * dither);
  return t < 0 ? 0 : t > n - 1 ? n - 1 : t;
}

/**
 * Sand tone index into sand0…sand4 (DESIGN.md 3.5). `s` is how much the surface leans toward the light,
 * `h` the height in levels, `grain` −1/0/+1 for unraked speckle.
 */
export function sandToneFor(s: number, h: number, shadowed: boolean, bayer: number, grain = 0): number {
  let t = SAND_BASE + SAND_SLOPE * s + SAND_HEIGHT * h + grain;
  if (shadowed) t -= SAND_SHADOW;
  const k = Math.floor(t + 0.5 + (bayer - 0.5) * SAND_DITHER);
  return k < 0 ? 0 : k > 4 ? 4 : k;
}

/** Slope-scaled shadow bias in world units: `min(7, 1.5 / max(0.2, N·L))`. */
export function shadowBias(ndl: number): number {
  return Math.min(7, 1.5 / Math.max(0.2, ndl));
}

/**
 * Integer position hash (32-bit, wrapping). The same function is generated into GLSL with `uint` arithmetic,
 * so plank speckle and sand grain agree between CPU and GPU.
 */
export function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Static grain for unraked level cells: 1 in 32 one tone darker (−1), 1 in 32 one tone lighter (+1). */
export function grainAt(cx: number, cy: number): number {
  const g = hash2(cx, cy) & 31;
  return g === 0 ? -1 : g === 1 ? 1 : 0;
}

/** Ease used by the smoothing sweep (smoothstep). */
export function smoothstep01(u: number): number {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  return x * x * (3 - 2 * x);
}

/** Sweep front position in grid cells for row `gy` at eased progress `e` (DESIGN.md 3.7). */
export function sweepFront(e: number, gy: number, w = 192, h = 112): number {
  return -8 + (w + 16) * e + 4 * Math.sin((Math.PI * gy) / h);
}

/** Integer pixel scale: k = max(1, round(deviceH / targetRows)). */
export function pixelScaleFor(deviceH: number, density: "crisp" | "chunky"): number {
  return Math.max(1, Math.round(deviceH / (density === "chunky" ? 137 : 205)));
}

export const TARGET_ROWS = { crisp: 205, chunky: 137 } as const;
