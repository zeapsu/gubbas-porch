import { DIR_UNRAKED, SAND_CELLS, SAND_H, SAND_W } from "./types.ts";
import type { SandFootprint, SandGrid, SandRect } from "./types.ts";

export function createSandGrid(): SandGrid {
  return {
    w: SAND_W,
    h: SAND_H,
    height: new Int8Array(SAND_CELLS),
    dir: new Uint8Array(SAND_CELLS).fill(DIR_UNRAKED),
    rock: new Uint8Array(SAND_CELLS),
  };
}

export function cloneSandGrid(grid: SandGrid): SandGrid {
  return {
    w: grid.w,
    h: grid.h,
    height: grid.height.slice(),
    dir: grid.dir.slice(),
    rock: grid.rock.slice(),
  };
}

export function clearSandGrid(grid: SandGrid): void {
  grid.height.fill(0);
  grid.dir.fill(DIR_UNRAKED);
}

export function rebuildRockMask(grid: SandGrid, elements: readonly SandFootprint[]): void {
  grid.rock.fill(0);
  elements.forEach(({ x, y, rx, ry }, index) => {
    const x0 = Math.max(0, Math.ceil(x - rx - 0.5));
    const x1 = Math.min(grid.w - 1, Math.floor(x + rx - 0.5));
    const y0 = Math.max(0, Math.ceil(y - ry - 0.5));
    const y1 = Math.min(grid.h - 1, Math.floor(y + ry - 0.5));
    for (let row = y0; row <= y1; row++) {
      const dy = (row + 0.5 - y) / ry;
      for (let col = x0; col <= x1; col++) {
        const dx = (col + 0.5 - x) / rx;
        if (dx * dx + dy * dy <= 1) grid.rock[row * grid.w + col] = index + 1;
      }
    }
  });
}

export function includeRect(target: SandRect, x: number, y: number, w: number, h: number): void {
  const right = target.w ? Math.max(target.x + target.w, x + w) : x + w;
  const bottom = target.h ? Math.max(target.y + target.h, y + h) : y + h;
  target.x = target.w ? Math.min(target.x, x) : x;
  target.y = target.h ? Math.min(target.y, y) : y;
  target.w = right - target.x;
  target.h = bottom - target.y;
}
