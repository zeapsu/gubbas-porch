/**
 * Touch-input rules that do not depend on the DOM. Pure.
 *
 * A fingertip is a wide, soft pointer: the contact patch shifts a few pixels as it lands and again as it rolls
 * off the glass, and it cannot aim at a rake handle two pixels wide. These helpers turn raw touch positions into
 * something the garden can treat like a steady hand. Distances are CSS pixels, so they match the physical size
 * of a finger on any screen; mouse and pen input never pass through here.
 */

/** A touch has to travel this far from where it landed before it counts as a drag rather than a tap. */
export const TOUCH_SLOP_PX = 8;
/** The rake head trails the fingertip on a string this long, which swallows jitter and the lift-off roll. */
export const TOUCH_BRUSH_RADIUS_PX = 3;
/** A touch that misses every pickable object takes the nearest one within this distance. */
export const TOUCH_PICK_RADIUS_PX = 12;
/** A touch that misses every HUD or menu control takes the nearest one within this distance. */
export const TOUCH_OVERLAY_SLOP_PX = 8;

export interface TouchBrush {
  pressX: number;
  pressY: number;
  /** Where the brush is now: the point a stroke should be fed. */
  x: number;
  y: number;
  /** False until the touch has left the tap slop around the press. */
  engaged: boolean;
}

export function createTouchBrush(): TouchBrush {
  return { pressX: 0, pressY: 0, x: 0, y: 0, engaged: false };
}

/** Puts the brush down at a new press. */
export function resetTouchBrush(brush: TouchBrush, x: number, y: number): void {
  brush.pressX = brush.x = x;
  brush.pressY = brush.y = y;
  brush.engaged = false;
}

/**
 * Pulls the brush toward the fingertip at (x, y) and returns true if it moved.
 *
 * Nothing moves while the finger stays inside `slop` of the press, so a tap or a finger settling on the glass
 * draws nothing. After that the brush follows on a string of length `radius`: it moves only as far as needed to
 * stay within `radius` of the finger. Movement shorter than the string is ignored, so a resting thumb's jitter
 * and the sideways roll of a lifting finger leave no hook at the end of a stroke. The brush starts at the press
 * point, so a stroke still begins exactly where the finger landed.
 */
export function pullTouchBrush(brush: TouchBrush, x: number, y: number, slop: number, radius: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (!brush.engaged) {
    if (Math.hypot(x - brush.pressX, y - brush.pressY) < slop) return false;
    brush.engaged = true;
  }
  const dx = x - brush.x;
  const dy = y - brush.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= radius) return false;
  const pull = (distance - radius) / distance;
  brush.x += dx * pull;
  brush.y += dy * pull;
  return true;
}

/**
 * Every integer offset within `maxRadius` of the origin as flat (dx, dy) pairs, nearest first, starting with
 * (0, 0). A caller searching for the closest hit walks the pairs in order and stops at the first match or at the
 * first pair beyond its own radius.
 */
export function discOffsets(maxRadius: number): Int8Array {
  const r = Math.max(0, Math.min(127, Math.floor(maxRadius)));
  const pairs: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) pairs.push([dx, dy]);
    }
  }
  // Ties break by row then column, so the order is the same on every engine.
  pairs.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
  const out = new Int8Array(pairs.length * 2);
  pairs.forEach(([dx, dy], i) => {
    out[i * 2] = dx;
    out[i * 2 + 1] = dy;
  });
  return out;
}
