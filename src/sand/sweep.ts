import { includeRect } from "./grid.ts";
import { DIR_UNRAKED, SAND_H, SAND_W } from "./types.ts";
import type { SandGrid, SandRect } from "./types.ts";

export const SWEEP_DURATION_MS = 2400;

export function sweepFront(elapsedMs: number, y: number): number {
  const t = Math.max(0, Math.min(1, elapsedMs / SWEEP_DURATION_MS));
  const ease = t * t * (3 - 2 * t);
  return -8 + (SAND_W + 16) * ease + 4 * Math.sin(Math.PI * y / SAND_H);
}

/** `dirty` may be a rectangle to reuse, so a caller that sweeps every frame allocates nothing. */
export function applySweep(
  grid: SandGrid,
  prevMs: number,
  nextMs: number,
  dirty: SandRect = { x: 0, y: 0, w: 0, h: 0 },
): SandRect | null {
  if (nextMs <= prevMs) return null;

  dirty.x = dirty.y = dirty.w = dirty.h = 0;
  for (let y = 0; y < grid.h; y++) {
    const first = Math.max(0, Math.floor(sweepFront(prevMs, y + 0.5) + 0.5));
    const end = Math.min(grid.w, Math.floor(sweepFront(nextMs, y + 0.5) + 0.5));
    for (let x = first; x < end; x++) {
      const i = y * grid.w + x;
      if (grid.rock[i] || (grid.height[i] === 0 && grid.dir[i] === DIR_UNRAKED)) continue;
      grid.height[i] = 0;
      grid.dir[i] = DIR_UNRAKED;
      includeRect(dirty, x, y, 1, 1);
    }
  }
  return dirty.w ? dirty : null;
}
