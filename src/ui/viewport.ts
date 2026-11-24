/**
 * Viewport rules that do not depend on the DOM (DESIGN.md 2.4, decision D8). Pure.
 *
 * The garden is a wide scene: bed, Wall of Rakes and Gubba span about 300 world units side by side. A phone held
 * upright would show it under a third of the screen's height with rakes a few pixels wide and HUD objects too
 * small to tap, and a browser cannot turn the screen itself (orientation lock needs fullscreen, and iOS Safari
 * has no lock at all). So an upright phone is asked to turn sideways and the garden waits until it does.
 * Tablets held upright and narrow desktop windows are wide enough to play and are left alone.
 */

/** Narrower than this in CSS pixels, an upright window is treated as a phone. */
export const PHONE_MAX_WIDTH = 600;
/** Taller than this multiple of its width, a window counts as upright. */
export const UPRIGHT_RATIO = 1.15;

/** Above this visual-viewport scale the page is pinch-zoomed, and the visual viewport no longer measures the window. */
export const VISUAL_VIEWPORT_MAX_SCALE = 1.01;

/**
 * One side (width or height) of the box the canvas may fill, in CSS pixels: the stage's own side, but never more
 * than the window or the visual viewport shows.
 *
 * iOS WebKit can leave a fixed-position box at its old size for a while after the screen turns, most often when
 * an installed web app comes back from the background in the other orientation. Sized from that box alone, the
 * canvas would be an upright phone's height on a screen lying on its side, and its lower half would be cut off.
 * A measure that is zero, negative or not a number is unknown and is skipped; `visualSide` only bounds a known
 * stage or window side, and when neither stage nor window is known the result is 0.
 */
export function boundedViewportSide(stageSide: number, windowSide: number, visualSide: number): number {
  let side = stageSide > 0 ? stageSide : windowSide > 0 ? windowSide : 0;
  if (windowSide > 0 && windowSide < side) side = windowSide;
  if (visualSide > 0 && visualSide < side) side = visualSide;
  return side;
}

/** True when a window of cssW × cssH CSS pixels should show the turn-sideways prompt instead of the garden. */
export function needsLandscape(cssW: number, cssH: number): boolean {
  return cssW < PHONE_MAX_WIDTH && cssH > cssW * UPRIGHT_RATIO;
}
