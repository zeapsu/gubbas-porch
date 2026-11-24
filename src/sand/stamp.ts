import { includeRect } from "./grid.ts";
import { DIR_UNRAKED, KEEP } from "./types.ts";
import type { RakeStampProfile, SandFootprint, SandGrid, SandRect } from "./types.ts";

export interface StampResult {
  dirtyRect: SandRect | null;
  touched: number;
  changed: number; // touched cells whose height changed
  crossingSum: number;
}

const CROSSING = Array.from({ length: 8 }, (_, bin) => Math.abs(Math.sin(bin * Math.PI / 8)));

export function stamp(
  grid: SandGrid,
  x: number,
  y: number,
  heading: number,
  rake: RakeStampProfile,
  waveOffset: number,
  stones: readonly SandFootprint[],
  flow: boolean,
  result: StampResult = { dirtyRect: null, touched: 0, changed: 0, crossingSum: 0 },
  bounds: SandRect = { x: 0, y: 0, w: 0, h: 0 },
): StampResult {
  bounds.w = bounds.h = 0;
  result.dirtyRect = null;
  result.touched = result.changed = result.crossingSum = 0;

  const halfWidth = rake.profile.length / 2;
  const dx = Math.cos(heading);
  const dy = Math.sin(heading);
  const reachX = Math.abs(dx) * 0.75 + Math.abs(dy) * halfWidth;
  const reachY = Math.abs(dy) * 0.75 + Math.abs(dx) * halfWidth;
  const minX = Math.max(0, Math.ceil(x - reachX - 0.5));
  const maxX = Math.min(grid.w - 1, Math.floor(x + reachX - 0.5));
  const minY = Math.max(0, Math.ceil(y - reachY - 0.5));
  const maxY = Math.min(grid.h - 1, Math.floor(y + reachY - 0.5));
  const bin = (Math.round(heading * 8 / Math.PI) % 8 + 8) % 8;
  const dir = rake.flat ? DIR_UNRAKED : bin;

  for (let row = minY; row <= maxY; row++) {
    const py = row + 0.5;
    for (let col = minX; col <= maxX; col++) {
      const i = row * grid.w + col;
      if (grid.rock[i] !== 0) continue;

      const px = col + 0.5;
      const v = (px - x) * dx + (py - y) * dy;
      if (Math.abs(v) > 0.75) continue;

      let u = -(px - x) * dy + (py - y) * dx;
      if (Math.abs(u) > halfWidth) continue;

      if (flow) {
        for (const stone of stones) {
          const nx = (px - stone.x) / (stone.rx + 1);
          const ny = (py - stone.y) / (stone.ry + 1);
          const radiusSquared = nx * nx + ny * ny;
          if (radiusSquared === 0 || radiusSquared >= 9) continue;
          const radius = (stone.rx + stone.ry) / 2 + 1;
          const t = Math.max(0, (Math.sqrt(radiusSquared) - 1) / 2);
          const weight = 1 - t * t * (3 - 2 * t);
          u -= (-nx * dy + ny * dx) * radius / radiusSquared * weight;
        }
      }

      const value = rake.profile[Math.floor(u + halfWidth - waveOffset)];
      if (value === undefined || value === KEEP) continue;
      const height = Math.max(-3, Math.min(3, value));
      const previousDir = grid.dir[i]!;
      result.touched++;
      if (previousDir < 8) result.crossingSum += CROSSING[Math.abs(previousDir - bin)]!;
      const heightChanged = grid.height[i] !== height;
      if (!heightChanged && previousDir === dir) continue;

      grid.height[i] = height;
      grid.dir[i] = dir;
      includeRect(bounds, col, row, 1, 1);
      if (heightChanged) result.changed++;
    }
  }
  if (bounds.w) result.dirtyRect = bounds;
  return result;
}
