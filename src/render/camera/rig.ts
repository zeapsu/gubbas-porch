// Camera maths (DESIGN.md 2.4). Pure: no window, document, wall-clock time, or Math.random.
// Position is `target + dist · (sin az · cos el, sin el, cos az · cos el)`, looking at the target with +y up.
// The basis below matches Three.js `Object3D.lookAt` for a camera, so the CPU projection used for framing,
// picking rays and tests agrees with what the GPU draws.

import type { CameraPresetId, CameraRig, Vec2, Vec3 } from "../../state/types.ts";

export const FOV_DEG = 26;
export const CAMERA_NEAR = 4;
export const CAMERA_FAR = 2400;
/** Per-60 Hz-frame approach factor for azimuth, elevation, distance and target (time constant ≈ 130 ms). */
export const CAMERA_DAMPING = 0.12;
export const ORBIT_AZ_LIMIT = 0.7;
export const ORBIT_EL_MIN = 0.25;
export const ORBIT_EL_MAX = 1.555;
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.3;
/** Pixels of margin the bed's corners keep from the framebuffer edge (DESIGN.md 2.4, framing check). */
export const FRAME_MARGIN_PX = 8;

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

/**
 * The smallest distance ≥ `rig.dist` at which all four sand-bed corners project inside the framebuffer with an
 * 8-pixel margin (portrait windows included). Moving the camera back along its view axis shrinks every
 * corner's offset from the target monotonically, so the bound per corner is closed-form:
 *   d ≥ q·w + |q·right| · fx / (fbW/2 − m)   and   d ≥ q·w + |q·up| · fy / (fbH/2 − m)
 * where q is the corner relative to the target and w points from the target to the camera.
 */
export function frameBedDistance(rig: Readonly<CameraRig>, aspect: number, fbW: number, fbH: number): number {
  const b = cameraBasis(rig);
  const halfW = fbW / 2 - FRAME_MARGIN_PX;
  const halfH = fbH / 2 - FRAME_MARGIN_PX;
  if (halfW <= 0 || halfH <= 0) return rig.dist;
  const tanHalf = Math.tan((FOV_DEG * Math.PI) / 360);
  const fy = fbH / 2 / tanHalf;
  const fx = fbW / 2 / (tanHalf * (aspect > 0 ? aspect : fbW / fbH));
  let need = rig.dist;
  for (const c of BED_CORNERS) {
    const qx = c.x - rig.target.x;
    const qy = c.y - rig.target.y;
    const qz = c.z - rig.target.z;
    const back = -(qx * b.forward.x + qy * b.forward.y + qz * b.forward.z); // q·w
    const side = Math.abs(qx * b.right.x + qy * b.right.y + qz * b.right.z);
    const vert = Math.abs(qx * b.up.x + qy * b.up.y + qz * b.up.z);
    const d = back + Math.max((side * fx) / halfW, (vert * fy) / halfH, CAMERA_NEAR + 1);
    if (d > need) need = d;
  }
  // a hair of slack so float error never leaves a corner a fraction of a pixel inside the margin
  return need > rig.dist ? need * 1.0005 : need;
}

/** True when every bed corner projects inside the framebuffer with the 8-pixel margin. */
export function bedCornersInView(rig: Readonly<CameraRig>, fbW: number, fbH: number, aspect: number = fbW / fbH): boolean {
  for (const c of BED_CORNERS) {
    const p = projectPoint(rig, c, fbW, fbH, aspect);
    if (!p) return false;
    if (p.x < FRAME_MARGIN_PX || p.x > fbW - FRAME_MARGIN_PX) return false;
    if (p.y < FRAME_MARGIN_PX || p.y > fbH - FRAME_MARGIN_PX) return false;
  }
  return true;
}

/** A rig with its distance raised just enough for the bed to fit (never lowered). */
export function framedRig(rig: Readonly<CameraRig>, fbW: number, fbH: number): CameraRig {
  const out = cloneRig(rig);
  out.dist = frameBedDistance(rig, fbW / fbH, fbW, fbH);
  return out;
}

/** World units covered by one framebuffer pixel at the target distance. */
export function worldUnitsPerPixel(rig: Readonly<CameraRig>, fbH: number): number {
  return rig.dist / focalPixels(fbH);
}
