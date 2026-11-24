import type { SandFootprint, SandVec2 } from "./types.ts";

const MARGIN = 2.5;
const OUTSIDE = 1 + 1e-12;

export function deflect(
  p: SandVec2,
  stones: readonly SandFootprint[],
  out: SandVec2 = { x: p.x, y: p.y },
): SandVec2 {
  out.x = p.x;
  out.y = p.y;

  for (const stone of stones) {
    const rx = stone.rx + MARGIN;
    const ry = stone.ry + MARGIN;
    const dx = p.x - stone.x;
    const dy = p.y - stone.y;
    const scale = Math.hypot(dx / rx, dy / ry);
    if (scale >= 1) continue;

    // Travel radially to the boundary. If that edge lies in an overlapping
    // ellipse, follow the same ray until it leaves the connected obstacles.
    const vx = scale === 0 ? rx : dx / scale;
    const vy = scale === 0 ? 0 : dy / scale;
    let distance = OUTSIDE;
    for (let pass = 0; pass < stones.length; pass++) {
      const previous = distance;
      for (const other of stones) {
        if (other === stone) continue;
        const nx = (stone.x - other.x) / (other.rx + MARGIN);
        const ny = (stone.y - other.y) / (other.ry + MARGIN);
        const ux = vx / (other.rx + MARGIN);
        const uy = vy / (other.ry + MARGIN);
        const x = nx + ux * distance;
        const y = ny + uy * distance;
        const c = x * x + y * y - 1;
        if (c >= 0) continue;

        const a = ux * ux + uy * uy;
        const b = x * ux + y * uy;
        const exit = (Math.sqrt(b * b - a * c) - b) / a;
        distance += exit + (OUTSIDE - 1);
      }
      if (distance === previous) break;
    }
    out.x = stone.x + vx * distance;
    out.y = stone.y + vy * distance;
    break;
  }
  return out;
}
