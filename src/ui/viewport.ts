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

/** True when a window of cssW × cssH CSS pixels should show the turn-sideways prompt instead of the garden. */
export function needsLandscape(cssW: number, cssH: number): boolean {
  return cssW < PHONE_MAX_WIDTH && cssH > cssW * UPRIGHT_RATIO;
}
