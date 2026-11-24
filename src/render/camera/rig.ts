// Camera maths (DESIGN.md 2.4). Pure: no window, document, wall-clock time, or Math.random.
// Position is `target + dist · (sin az · cos el, sin el, cos az · cos el)`, looking at the target with +y up.
// The basis below matches Three.js `Object3D.lookAt` for a camera, so the CPU projection used for framing,
// picking rays and tests agrees with what the GPU draws.

import type { CameraPresetId, CameraRig, Vec2, Vec3 } from "../../state/types.ts";
import { HUD_FROM_BOTTOM, HUD_ICON, HUD_LEFT } from "../overlay/hud.ts";

export const FOV_DEG = 26;
export const CAMERA_NEAR = 4;
/** Far enough for a window five times taller than wide, where fitting the garden's width needs a long pull-back. */
export const CAMERA_FAR = 4800;
/** The camera never backs off farther than this, so the deck behind the target stays inside the far plane. */
export const MAX_CAMERA_DIST = CAMERA_FAR - 600;
/** Per-60 Hz-frame approach factor for azimuth, elevation, distance and target (time constant ≈ 130 ms). */
export const CAMERA_DAMPING = 0.12;
export const ORBIT_AZ_LIMIT = 0.7;
export const ORBIT_EL_MIN = 0.25;
export const ORBIT_EL_MAX = 1.555;
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.3;
/** Pixels of margin a preset's hero volumes keep from the framebuffer edge (DESIGN.md 2.4, framing check). */
export const FRAME_MARGIN_PX = 6;

/** Surface height of the sand bed and its four corners in world units (192 × 112 cells centred on the origin). */
export const SAND_Y = 3;
export const BED_HALF_W = 96;
export const BED_HALF_D = 56;
export const BED_CORNERS: readonly Vec3[] = [
  { x: -BED_HALF_W, y: SAND_Y, z: -BED_HALF_D },
  { x: BED_HALF_W, y: SAND_Y, z: -BED_HALF_D },
  { x: BED_HALF_W, y: SAND_Y, z: BED_HALF_D },
  { x: -BED_HALF_W, y: SAND_Y, z: BED_HALF_D },
];

export const CAMERA_PRESETS: Readonly<Record<CameraPresetId, Readonly<CameraRig>>> = {
  cozy: { target: { x: 18, y: 12, z: -16 }, az: -0.09, el: 0.78, dist: 408 },
  topdown: { target: { x: 0, y: 3, z: 2 }, az: 0, el: 1.555, dist: 330 },
  porch: { target: { x: 126, y: 19, z: 6 }, az: -0.5, el: 0.32, dist: 150 },
};

export const CAMERA_PRESET_ORDER: readonly CameraPresetId[] = ["cozy", "topdown", "porch"];

export const CAMERA_PRESET_LABELS: Readonly<Record<CameraPresetId, string>> = {
  cozy: "Cozy 3/4",
  topdown: "Top-Down",
  porch: "Gubba Porch",
};

export function cloneRig(rig: Readonly<CameraRig>): CameraRig {
  return { target: { x: rig.target.x, y: rig.target.y, z: rig.target.z }, az: rig.az, el: rig.el, dist: rig.dist };
}

export function copyRig(out: CameraRig, rig: Readonly<CameraRig>): CameraRig {
  out.target.x = rig.target.x;
  out.target.y = rig.target.y;
  out.target.z = rig.target.z;
  out.az = rig.az;
  out.el = rig.el;
  out.dist = rig.dist;
  return out;
}

export function presetRig(id: CameraPresetId): CameraRig {
  return cloneRig(CAMERA_PRESETS[id]);
}

export function cameraPositionInto(out: Vec3, rig: Readonly<CameraRig>): Vec3 {
  const ce = Math.cos(rig.el);
  out.x = rig.target.x + rig.dist * Math.sin(rig.az) * ce;
  out.y = rig.target.y + rig.dist * Math.sin(rig.el);
  out.z = rig.target.z + rig.dist * Math.cos(rig.az) * ce;
  return out;
}

export function cameraPosition(rig: Readonly<CameraRig>): Vec3 {
  return cameraPositionInto({ x: 0, y: 0, z: 0 }, rig);
}

export interface CameraBasis {
  /** Unit vector from the camera toward the target. */
  forward: Vec3;
  /** Screen right. */
  right: Vec3;
  /** Screen up. */
  up: Vec3;
}

/** Orthonormal view basis, identical to Three.js `lookAt` with world up (0, 1, 0). */
export function cameraBasis(rig: Readonly<CameraRig>): CameraBasis {
  const ce = Math.cos(rig.el);
  // w points from the target back toward the camera
  const wx = Math.sin(rig.az) * ce;
  const wy = Math.sin(rig.el);
  const wz = Math.cos(rig.az) * ce;
  // right = normalize(cross(worldUp, w)) = normalize((wz, 0, -wx))
  const rl = Math.hypot(wz, wx) || 1;
  const rx = wz / rl;
  const rz = -wx / rl;
  // up = cross(w, right)
  const ux = wy * rz;
  const uy = wz * rx - wx * rz;
  const uz = -wy * rx;
  return { forward: { x: -wx, y: -wy, z: -wz }, right: { x: rx, y: 0, z: rz }, up: { x: ux, y: uy, z: uz } };
}

/** Focal length in framebuffer pixels for the vertical field of view. */
export function focalPixels(fbH: number, fovDeg: number = FOV_DEG): number {
  return fbH / 2 / Math.tan((fovDeg * Math.PI) / 360);
}

export interface ProjectedPoint {
  x: number;
  y: number;
  /** Distance along the view axis (positive in front of the camera). */
  depth: number;
}

/**
 * Projects a world point into framebuffer pixels (origin top-left, +y down).
 * `aspect` defaults to fbW / fbH; when given, the horizontal focal length follows it as Three.js does.
 */
export function projectPoint(
  rig: Readonly<CameraRig>,
  p: Readonly<Vec3>,
  fbW: number,
  fbH: number,
  aspect: number = fbW / fbH,
): ProjectedPoint | null {
  const c = cameraPosition(rig);
  const b = cameraBasis(rig);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const dz = p.z - c.z;
  const depth = dx * b.forward.x + dy * b.forward.y + dz * b.forward.z;
  if (depth <= CAMERA_NEAR) return null;
  const fy = focalPixels(fbH);
  const fx = (fbW / 2) / (Math.tan((FOV_DEG * Math.PI) / 360) * aspect);
  return {
    x: fbW / 2 + ((dx * b.right.x + dy * b.right.y + dz * b.right.z) * fx) / depth,
    y: fbH / 2 - ((dx * b.up.x + dy * b.up.y + dz * b.up.z) * fy) / depth,
    depth,
  };
}

/** Unit ray direction through framebuffer point (fbX, fbY), where pixel centres sit at +0.5. */
export function screenRay(rig: Readonly<CameraRig>, fbX: number, fbY: number, fbW: number, fbH: number): Vec3 {
  const b = cameraBasis(rig);
  const f = focalPixels(fbH);
  const a = (fbX - fbW / 2) / f;
  const v = (fbY - fbH / 2) / f;
  const x = b.forward.x + b.right.x * a - b.up.x * v;
  const y = b.forward.y + b.right.y * a - b.up.y * v;
  const z = b.forward.z + b.right.z * a - b.up.z * v;
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

/**
 * Intersects the pointer ray with the sand plane y = 3 and returns float grid coordinates
 * (x 0…192 left to right, y 0…112 back to front). Points outside the grid are returned as-is; null when the
 * ray does not travel downward.
 */
export function sandPointFromRay(
  rig: Readonly<CameraRig>,
  fbX: number,
  fbY: number,
  fbW: number,
  fbH: number,
): Vec2 | null {
  const c = cameraPosition(rig);
  const d = screenRay(rig, fbX, fbY, fbW, fbH);
  if (d.y >= -1e-5) return null;
  const t = (SAND_Y - c.y) / d.y;
  if (t <= 0) return null;
  return { x: c.x + d.x * t + BED_HALF_W, y: c.z + d.z * t + BED_HALF_D };
}

function approach(cur: number, goal: number, k: number): number {
  const next = cur + (goal - cur) * k;
  // snap once we are well under a framebuffer pixel away, so the rig settles exactly on the goal
  return Math.abs(goal - next) < 1e-4 ? goal : next;
}

/**
 * Moves `rig` toward `goal` and writes the result into `out` (which may be `rig`). Allocation-free.
 * Each component approaches by `CAMERA_DAMPING` per 60 Hz frame, scaled for `dtMs`, so it never overshoots.
 * With reduced motion the goal is reached at once.
 */
export function stepCameraInto(
  out: CameraRig,
  rig: Readonly<CameraRig>,
  goal: Readonly<CameraRig>,
  reducedMotion: boolean,
  dtMs: number = 1000 / 60,
): CameraRig {
  if (reducedMotion) return copyRig(out, goal);
  const frames = Math.max(0, Math.min(10, dtMs / (1000 / 60)));
  const k = 1 - Math.pow(1 - CAMERA_DAMPING, frames);
  out.az = approach(rig.az, goal.az, k);
  out.el = approach(rig.el, goal.el, k);
  out.dist = approach(rig.dist, goal.dist, k);
  out.target.x = approach(rig.target.x, goal.target.x, k);
  out.target.y = approach(rig.target.y, goal.target.y, k);
  out.target.z = approach(rig.target.z, goal.target.z, k);
  return out;
}

/** Pure damped step: returns a new rig. See `stepCameraInto`. */
export function stepCamera(
  rig: Readonly<CameraRig>,
  goal: Readonly<CameraRig>,
  reducedMotion = false,
  dtMs: number = 1000 / 60,
): CameraRig {
  return stepCameraInto(cloneRig(rig), rig, goal, reducedMotion, dtMs);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Orbit and zoom limits: azimuth ±0.7 rad, elevation 0.25–1.555 rad, distance 0.7×–1.3× of the preset. */
export function clampOrbit(rig: Readonly<CameraRig>, presetDist: number): CameraRig {
  const out = cloneRig(rig);
  out.az = clamp(rig.az, -ORBIT_AZ_LIMIT, ORBIT_AZ_LIMIT);
  out.el = clamp(rig.el, ORBIT_EL_MIN, ORBIT_EL_MAX);
  out.dist = clamp(rig.dist, presetDist * ZOOM_MIN, presetDist * ZOOM_MAX);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Responsive framing (DESIGN.md 2.4). Each preset names the world-space volumes it must keep on screen; a
// viewport's rig is the preset pulled back, and panned in the screen plane, by the least that fits them all.

/** The eight corners of an axis-aligned world box. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) out.push({ x, y, z });
  return out;
}

/**
 * The sixteen corners of an upright prism whose footprint is the box x0…x1 × z0…z1 with its corners cut off by
 * the diagonals s0 ≤ x + z ≤ s1 and t0 ≤ x − z ≤ t1. A box corner where nothing stands sits far from the
 * model yet close to a low camera, so cutting it keeps the Porch framing honest.
 */
function prism(
  [x0, x1]: readonly [number, number],
  [z0, z1]: readonly [number, number],
  [s0, s1]: readonly [number, number],
  [t0, t1]: readonly [number, number],
  [y0, y1]: readonly [number, number],
): Vec3[] {
  const cz = (z: number): number => clamp(z, z0, z1);
  const cx = (x: number): number => clamp(x, x0, x1);
  const foot: [number, number][] = [
    [x1, cz(x1 - t1)],
    [x1, cz(s1 - x1)],
    [cx(s1 - z1), z1],
    [cx(t0 + z1), z1],
    [x0, cz(x0 - t0)],
    [x0, cz(s0 - x0)],
    [cx(s0 - z0), z0],
    [cx(t1 + z0), z0],
  ];
  const out: Vec3[] = [];
  for (const y of [y0, y1]) for (const [x, z] of foot) out.push({ x, y, z });
  return out;
}

/**
 * World-space hulls of the hero objects (DESIGN.md 2.3) as convex pieces, each a list of corner points. They
 * are a little larger than the committed models, so Gubba's breathing and head turns and a rake's hover lift
 * stay inside. `tests/unit/render.test.ts` checks that every vertex of every committed model, placed as the
 * scene places it, lies inside its hull.
 */
export const HERO_HULLS = {
  /** The bed's wooden frame, outer edge to outer edge. */
  frame: [box(-102.5, 102.5, -0.2, 6.5, -62.5, 62.5)],
  /** All ten rakes hanging on the wall (sugi on the left, hōki on the right), hover lift included. */
  rakes: [box(-109.5, 109.5, 5, 60, -74, -62)],
  /** Gubba in all three variants: body, tail and cushion; then the head; then hat, eye stalks and bonsai. */
  gubba: [
    prism([100.7, 165.3], [-16.8, 23.7], [100.1, 182.8], [95, 160.1], [-2, 19.5]),
    prism([103.4, 149.8], [-15.8, 24.2], [100.5, 168.4], [99.3, 150.4], [17, 31.5]),
    prism([111.3, 146.8], [-10.3, 20.5], [108, 158.4], [104.1, 146.5], [29, 48]),
  ],
  basket: [box(106, 126, -0.2, 11.5, 33.5, 54.5)],
  shishi: [box(-134.5, -110.5, -0.2, 23, -46, -26)],
  /** The bonsai on the wall shelf above Gubba's corner. */
  bonsai: [box(138, 146, 41, 53.5, -72, -65)],
} as const satisfies Record<string, readonly (readonly Vec3[])[]>;

export interface FramingSpec {
  /** Points that must project inside the view with `FRAME_MARGIN_PX` to spare. */
  points: readonly Vec3[];
  /**
   * Points that must also stay clear of the HUD block in the bottom-left corner: all of them to its right, or
   * all of them above it, whichever needs the smaller camera move. They obey the plain margin as well.
   */
  clear: readonly Vec3[];
}

/** What each preset keeps on screen in every viewport. */
export const PRESET_FRAMING: Readonly<Record<CameraPresetId, FramingSpec>> = {
  // the whole garden: bed, Wall of Rakes, Gubba, stone basket, shishi-odoshi and the shelf bonsai
  cozy: {
    points: [
      ...HERO_HULLS.frame.flat(),
      ...HERO_HULLS.rakes.flat(),
      ...HERO_HULLS.gubba.flat(),
      ...HERO_HULLS.basket.flat(),
      ...HERO_HULLS.shishi.flat(),
      ...HERO_HULLS.bonsai.flat(),
    ],
    clear: [],
  },
  // the bed and its frame; the sand's front-left corner must not hide under the HUD
  topdown: { points: HERO_HULLS.frame.flat(), clear: [BED_CORNERS[3] as Vec3] },
  // Gubba, never under the HUD
  porch: { points: [], clear: HERO_HULLS.gubba.flat() },
};

/**
 * Width and height of the corner the HUD block occupies, with one pixel of air (bottom-left of the frame), when
 * the overlay is drawn `uiScale` scene pixels per overlay pixel (`Overlay.scale`, from `uiPixelFor` in overlay.ts).
 */
export function hudClearWidth(uiScale = 1): number {
  return (HUD_LEFT + 3 * HUD_ICON) * uiScale + 1;
}
export function hudClearHeight(uiScale = 1): number {
  return HUD_FROM_BOTTOM * uiScale + 1;
}
export const HUD_CLEAR_W = hudClearWidth();
export const HUD_CLEAR_H = hudClearHeight();

const TAN_HALF_FOV = Math.tan((FOV_DEG * Math.PI) / 360);

/**
 * Fits `spec` into an fbW × fbH view and writes the result into `out` (which may be `rig`). Allocation-free.
 *
 * The result keeps `rig`'s azimuth and elevation. Its distance is the smallest value ≥ `rig.dist` for which the
 * points can fit at all, and its target is `rig.target` moved within the screen plane (a pan, never a turn) by
 * the least that then fits them, so a view that already fits is returned unchanged.
 *
 * With q a point relative to the target, w the unit vector from target to camera, and (σ, τ) the pan along
 * screen right and up, a point is inside the right edge when  d ≥ q·w + (q·right − σ) · f / (fbW/2 − m)  and
 * likewise for the other three edges. Every bound is linear in σ or τ, so per axis the two opposing edges give
 * a closed-form smallest distance and, at any distance, an interval of pans that fit.
 */
export function fitRigInto(
  out: CameraRig,
  rig: Readonly<CameraRig>,
  spec: Readonly<FramingSpec>,
  fbW: number,
  fbH: number,
  margin: number = FRAME_MARGIN_PX,
  hudW: number = HUD_CLEAR_W,
  hudH: number = HUD_CLEAR_H,
): CameraRig {
  const halfW = fbW / 2 - margin;
  const halfH = fbH / 2 - margin;
  if (!(halfW > 0) || !(halfH > 0)) return copyRig(out, rig);

  const ce = Math.cos(rig.el);
  // w points from the target back toward the camera; right and up as in `cameraBasis`
  const wx = Math.sin(rig.az) * ce;
  const wy = Math.sin(rig.el);
  const wz = Math.cos(rig.az) * ce;
  const rl = Math.hypot(wz, wx) || 1;
  const rx = wz / rl;
  const rz = -wx / rl;
  const ux = wy * rz;
  const uy = wz * rx - wx * rz;
  const uz = -wy * rx;

  const f = fbH / 2 / TAN_HALF_FOV;
  const k = f / halfW; // left and right edges
  const kv = f / halfH; // top and bottom edges
  // the HUD-clear points may instead need a wider left edge (option A) or a taller bottom edge (option B)
  const clearHalfW = fbW / 2 - Math.max(margin, hudW);
  const clearHalfH = fbH / 2 - Math.max(margin, hudH);
  const kClearL = clearHalfW > 1 ? f / clearHalfW : Infinity;
  const kClearB = clearHalfH > 1 ? f / clearHalfH : Infinity;

  let aRight = -Infinity;
  let aLeft = -Infinity;
  let aTop = -Infinity;
  let aBottom = -Infinity;
  let aClearL = -Infinity;
  let aClearB = -Infinity;
  let backMax = -Infinity;
  const nPoints = spec.points.length;
  const n = nPoints + spec.clear.length;
  for (let i = 0; i < n; i++) {
    const p = (i < nPoints ? spec.points[i] : spec.clear[i - nPoints]) as Vec3;
    const qx = p.x - rig.target.x;
    const qy = p.y - rig.target.y;
    const qz = p.z - rig.target.z;
    const back = qx * wx + qy * wy + qz * wz;
    const side = qx * rx + qz * rz;
    const vert = qx * ux + qy * uy + qz * uz;
    if (back > backMax) backMax = back;
    if (back + k * side > aRight) aRight = back + k * side;
    if (back - k * side > aLeft) aLeft = back - k * side;
    if (back + kv * vert > aTop) aTop = back + kv * vert;
    if (back - kv * vert > aBottom) aBottom = back - kv * vert;
    if (i >= nPoints) {
      if (back - kClearL * side > aClearL) aClearL = back - kClearL * side;
      if (back - kClearB * vert > aClearB) aClearB = back - kClearB * vert;
    }
  }
  if (n === 0) return copyRig(out, rig);

  // smallest distance at which an axis fits: where the falling bound of one edge meets the rising bound of the other
  const dH = (aRight + aLeft) / 2;
  const dV = (aTop + aBottom) / 2;
  const hasClear = n > nPoints;
  const dClearL = hasClear && kClearL < Infinity ? (aRight * kClearL + aClearL * k) / (k + kClearL) : Infinity;
  const dClearB = hasClear && kClearB < Infinity ? (aTop * kClearB + aClearB * kv) / (kv + kClearB) : Infinity;
  const floor = Math.max(rig.dist, backMax + CAMERA_NEAR + 1, dH, dV);
  let useClearL = false;
  let useClearB = false;
  let need = floor;
  if (hasClear && (dClearL < Infinity || dClearB < Infinity)) {
    // option A keeps the points right of the HUD, option B above it; take the one that pulls back less, and on a
    // tie the one that pans less
    const dA = Math.max(floor, dClearL);
    const dB = Math.max(floor, dClearB);
    if (dA < dB) useClearL = true;
    else if (dB < dA) useClearB = true;
    else {
      const sigA = clamp(0, (aRight - dA) / k, Math.min((dA - aLeft) / k, (dA - aClearL) / kClearL));
      const tauB = clamp(0, (aTop - dB) / kv, Math.min((dB - aBottom) / kv, (dB - aClearB) / kClearB));
      if (Math.abs(sigA) <= Math.abs(tauB)) useClearL = true;
      else useClearB = true;
    }
    need = useClearL ? dA : dB;
  }
  // a hair of slack so float error never leaves a point a fraction of a pixel inside the margin
  let dist = need > rig.dist ? need * 1.0005 : need;
  if (dist > MAX_CAMERA_DIST) dist = Math.max(rig.dist, MAX_CAMERA_DIST);

  // the pans that fit at this distance, nearest to none
  const sLo = (aRight - dist) / k;
  let sHi = (dist - aLeft) / k;
  if (useClearL) sHi = Math.min(sHi, (dist - aClearL) / kClearL);
  const tLo = (aTop - dist) / kv;
  let tHi = (dist - aBottom) / kv;
  if (useClearB) tHi = Math.min(tHi, (dist - aClearB) / kClearB);
  const sigma = sLo <= sHi ? clamp(0, sLo, sHi) : (sLo + sHi) / 2;
  const tau = tLo <= tHi ? clamp(0, tLo, tHi) : (tLo + tHi) / 2;

  const tx = rig.target.x + sigma * rx + tau * ux;
  const ty = rig.target.y + tau * uy;
  const tz = rig.target.z + sigma * rz + tau * uz;
  out.az = rig.az;
  out.el = rig.el;
  out.dist = dist;
  out.target.x = tx;
  out.target.y = ty;
  out.target.z = tz;
  return out;
}

/**
 * The rig to show for a viewport. `orbit` is the preset with the player's azimuth, elevation and zoom applied
 * (as `clampOrbit` leaves it: its distance is 0.7×–1.3× of the preset's). The preset's volumes are fitted at
 * that angle with no zoom, then the zoom is applied to the fitted distance, so the wheel and a pinch scale what
 * this viewport shows rather than what a 16:9 desktop would. `uiScale` is the overlay's scale in this
 * framebuffer, which sets how large the HUD block to keep clear of is. Allocation-free; `out` may be `orbit`.
 */
export function viewportRigInto(
  out: CameraRig,
  orbit: Readonly<CameraRig>,
  preset: CameraPresetId,
  fbW: number,
  fbH: number,
  uiScale = 1,
): CameraRig {
  const base = CAMERA_PRESETS[preset].dist;
  const zoom = base > 0 ? orbit.dist / base : 1;
  copyRig(out, orbit);
  out.dist = base;
  fitRigInto(out, out, PRESET_FRAMING[preset], fbW, fbH, FRAME_MARGIN_PX, hudClearWidth(uiScale), hudClearHeight(uiScale));
  out.dist = Math.min(MAX_CAMERA_DIST, out.dist * zoom);
  return out;
}

/** The preset as this viewport frames it, with no orbit or zoom. Returns a new rig. */
export function framedRig(preset: CameraPresetId, fbW: number, fbH: number, uiScale = 1): CameraRig {
  const out = presetRig(preset);
  return viewportRigInto(out, out, preset, fbW, fbH, uiScale);
}

/** True when every point projects inside the framebuffer with `margin` pixels to spare. */
export function pointsInView(
  rig: Readonly<CameraRig>,
  points: readonly Vec3[],
  fbW: number,
  fbH: number,
  margin: number = FRAME_MARGIN_PX,
): boolean {
  for (const c of points) {
    const p = projectPoint(rig, c, fbW, fbH);
    if (!p) return false;
    if (p.x < margin || p.x > fbW - margin) return false;
    if (p.y < margin || p.y > fbH - margin) return false;
  }
  return true;
}

/** True when every bed corner projects inside the framebuffer with the frame margin. */
export function bedCornersInView(rig: Readonly<CameraRig>, fbW: number, fbH: number): boolean {
  return pointsInView(rig, BED_CORNERS, fbW, fbH);
}

/** World units covered by one framebuffer pixel at the target distance. */
export function worldUnitsPerPixel(rig: Readonly<CameraRig>, fbH: number): number {
  return rig.dist / focalPixels(fbH);
}
