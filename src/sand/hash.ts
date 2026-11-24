import type { SandGrid } from "./types.ts";

export function sandHash(grid: SandGrid): number {
  let hash = 0x811c9dc5;
  for (const byte of grid.height) hash = Math.imul(hash ^ (byte & 0xff), 0x01000193);
  for (const byte of grid.dir) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
}
