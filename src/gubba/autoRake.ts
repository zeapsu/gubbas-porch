import type { ElementInstance, ElementKind, GubbaVariant, RakeId, Vec2 } from "../state/types.ts";
import type { StoneOp } from "./autoStones.ts";

/**
 * The director for Gubba mode and "Watch: Gubba rakes": where Gubba is, what he holds, and what he does next
 * while he turns one garden into another. Pure: no clock, no randomness beyond its own xorshift32 stream, and
 * nothing here touches the sand. The caller owns the garden; the director asks for each change with a command
 * (`autoPoll`) and the caller carries it out.
 *
 * A run is a short program of high-level steps (carry a stone, fetch a rake, pull a stroke, sweep, go home)
 * compiled by `autoBegin` and `autoPlanRake`. `autoTick` runs it and allocates nothing: the state is created
 * once, and commands go into a fixed ring of typed arrays.
 *
 * World units are sand cells: x = gridX − 96, z = gridY − 56, and the sand lies at y = 3. A yaw of ψ faces
 * `(sin ψ, cos ψ)` in (x, z), as a Three.js rotation about y does.
 */

export const AUTO_WALK_SPEED = 28;
export const AUTO_CARRY_SPEED = 22;
/** Fastest Gubba's feet move while he works a rake. */
export const AUTO_STANCE_SPEED = 34;
/** Fastest the rake head travels, in cells per second. */
export const AUTO_RAKE_SPEED = 36;
/** Slowest it travels, so the centre of a spiral does not stall. */
export const AUTO_RAKE_MIN_SPEED = 6;
export const AUTO_TURN_RATE = 2.4;
export const AUTO_SWEEP_MS = 9500;
/** Reduced motion: one whole step every this often, with Gubba seated. */
export const AUTO_STEP_MS = 1600;
export const AUTO_ADMIRE_MIN_MS = 20_000;
export const AUTO_ADMIRE_MAX_MS = 32_000;
export const AUTO_WALK_BOX = { minX: -150, maxX: 196, minZ: -58, maxZ: 112 } as const;
/** Elements at least this tall are walked round; lower ones are stepped over. */
export const AUTO_TALL_HEIGHT = 15;
export const AUTO_BASKET_RADIUS = 28;
export const AUTO_SHISHI_RADIUS = 30;
/** Clear ground kept between Gubba's centre and the edge of a tall element's footprint. */
export const AUTO_BODY_CLEARANCE = 16;
/** Where the rake handle is held, in Root space, and how far along the handle from the tines. */
export const AUTO_GRIPS: Readonly<Record<GubbaVariant, { x: number; y: number; z: number; l: number; lift: number }>> = {
  moss: { x: 0, y: 16.4, z: 16.5, l: 28, lift: 1.5 },
  kasa: { x: 0, y: 16.8, z: 14.5, l: 28, lift: 0.5 },
  lantern: { x: -10.5, y: 8.5, z: 11.5, l: 30, lift: 0 },
};
/** Where a carried stone rests against the belly, in Root space. */
export const AUTO_BELLY: Readonly<Record<GubbaVariant, { x: number; y: number; z: number }>> = {
  moss: { x: 0, y: 4, z: 21 },
  kasa: { x: 0, y: 4, z: 19 },
  lantern: { x: -9, y: 3, z: 17 },
};

export const AUTO_RAKE_ORDER: readonly RakeId[] = [
  "sugi",
  "onami",
  "kinu",
  "hisui",
  "mikazuki",
  "tetsu",
  "wa",
  "take",
  "nagi",
  "hoki",
];

export const AUTO_PHASES = ["idle", "stones", "smoothing", "raking", "returning", "admiring", "yielding"] as const;
export type AutoPhase = (typeof AUTO_PHASES)[number];

/** What `autoPoll` returns. `x` and `y` are the command's two numbers (`a.cmdX`, `a.cmdY`). */
export const AUTO_CMD = {
  NONE: 0,
  /** Take stone op `x`'s stone out of the garden: Gubba has lifted it. */
  STONE_LIFT: 1,
  /** Stone op `x`'s stone has come out of the basket. The garden does not change. */
  STONE_TAKE: 2,
  /** Put stone op `x`'s stone into the garden at its target. */
  STONE_SET: 3,
  /** The carried stone has gone into the basket. The garden does not change. */
  STONE_BASKET: 4,
  /** Reduced motion: carry out stone op `x` whole. */
  STONE_WHOLE: 5,
  /** The stones are done: plan the sand and call `autoPlanRake`. */
  PLAN_SAND: 6,
  /** Rake `AUTO_RAKE_ORDER[x]` has left its pegs / is back on them. */
  RAKE_TAKE: 7,
  RAKE_HANG: 8,
  /** Stroke `x` begins at its first point; then the head moves to grid point (`x`, `y`); then it lifts. */
  STROKE_BEGIN: 9,
  STROKE_TO: 10,
  STROKE_END: 11,
  /** Reduced motion: stroke `x` whole. */
  STROKE_WHOLE: 12,
  /** The broom's sweep: begins; has covered the share `x` of its time, eased to `y`; ends. */
  SWEEP_BEGIN: 13,
  SWEEP_TO: 14,
  SWEEP_END: 15,
  SWEEP_WHOLE: 16,
  /** Every stroke is down: make the sand exactly the preset. */
  SEAL: 17,
  /** Gubba is back on his cushion with the garden finished. */
  DONE: 18,
  /** He has looked at it long enough: choose the next garden. */
  NEXT: 19,
  /** He is back on his cushion after giving way to the player. */
  YIELDED: 20,
} as const;

/** A stroke to pull: structurally a preset stroke. */
export interface AutoStroke {
  rake: RakeId;
  points: readonly Vec2[];
}

/** The fixed things Gubba walks among. Handed in by the caller, which is allowed to know the scene. */
export interface AutoWorld {
  /** Gubba's cushion (world x, y, z) and the yaw he sits at. */
  home: readonly [number, number, number];
  homeYaw: number;
  basket: readonly [number, number, number];
  shishi: readonly [number, number, number];
  /** Where each rake hangs along the wall, and how far off the wall. */
  rackSlots: Readonly<Record<RakeId, { readonly x: number }>>;
  hangZ: number;
  footprints: Readonly<Record<ElementKind, { readonly rx: number; readonly ry: number; readonly height: number }>>;
}

const OP_PHASE = 1;
const OP_STONE = 2;
const OP_RAKE = 3;
const OP_STROKE = 4;
const OP_SWEEP = 5;
const OP_CMD = 6;
const OP_HOME = 7;
const OP_ADMIRE = 8;
const OP_WAIT = 9;
const OP_DROP = 10;

const PROGRAM_CAP = 1024;
const RING = 64;
const NO_RAKE = -1;
const LIFT_MS = 520;
const RAKE_SWAP_MS = 420;
const SETTLE_MS = 180;
/** How far in front of the pegs Gubba stands to reach a rake. */
const RACK_REACH = 19;
/** A walk that gets no nearer for this long is taken as arrived (a target hemmed in by stones). */
const STALL_MS = 1500;
const TIP_SPEED = 80;
const SAND_Y = 3;
const NO_OPS: readonly StoneOp[] = [];
const NO_STROKES: readonly AutoStroke[] = [];
const NO_POINTS: readonly Vec2[] = [];

export interface AutoState {
  readonly world: AutoWorld;
  /** The Gubba on screen; the caller keeps it current. It sets the grip, the lift and the stance distance. */
  variant: GubbaVariant;

  // where he is
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  /** Distance walked, which drives the gait. */
  dist: number;
  /** 0…1: how much of the gait shows (eases out when he stops). */
  gaitAmp: number;
  /** True only while he sits on the cushion in his rest pose. */
  seated: boolean;
  /** True from the start of a run until he is seated again. */
  working: boolean;
  yielding: boolean;
  /** Index into `AUTO_PHASES`. */
  phase: number;

  // what he holds
  rake: RakeId | null;
  /** The tines are on the sand (or on their way down). */
  rakeDown: boolean;
  /** A stroke or the sweep is under way. */
  rakeLive: boolean;
  tipX: number;
  tipY: number;
  tipZ: number;
  gripX: number;
  gripY: number;
  gripZ: number;
  carried: ElementKind | null;
  carryX: number;
  carryY: number;
  carryZ: number;
  carryYaw: number;
  /** Current arm pitch, and whether it overrides the idle arm pose. */
  armX: number;
  armOn: boolean;
  /** Eased progress of the broom's sweep, or −1. */
  sweepProgress: number;

  // the run
  stepped: boolean;
  loop: boolean;
  stoneOps: readonly StoneOp[];
  strokes: readonly AutoStroke[];
  /** How many of `strokes` are smoothing passes rather than the preset's own. */
  smoothCount: number;

  // the program
  readonly opKind: Int32Array;
  readonly opA: Float64Array;
  readonly opB: Float64Array;
  pc: number;
  len: number;
  sub: number;
  opMs: number;

  // commands out
  readonly cmdKind: Int32Array;
  readonly cmdA: Float64Array;
  readonly cmdB: Float64Array;
  cmdHead: number;
  cmdTail: number;
  cmdX: number;
  cmdY: number;

  rng: number;

  // scratch for the step in hand
  spent: boolean;
  reach: boolean;
  moved: number;
  /** Walk target and the point he turns to face on arrival. */
  tx: number;
  tz: number;
  fx: number;
  fz: number;
  bestD: number;
  stallMs: number;
  /** Rake head on the grid, stroke progress, and the stance that follows it. */
  hx: number;
  hy: number;
  ptIx: number;
  segOff: number;
  kappa: number;
  stanceYaw: number;
  /** The direction the stance wants: along the path ahead of the head, or behind it. */
  pathYaw: number;
  stanceSign: number;
  sx: number;
  sz: number;
  sweepMs: number;
  admireMs: number;
  /** Where a carried stone is lifted from or set down to, and how far along the lift it is (1 = at the belly). */
  srcX: number;
  srcY: number;
  srcZ: number;
  carryT: number;
  carryGoal: number;
  // obstacle and target scratch
  ox: number;
  oz: number;
  or: number;
  nx: number;
  nz: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

function wrap(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

/** Height of the ground Gubba walks on: the sand inside the bed, the deck outside it, a short ramp between. */
export function autoGroundY(x: number, z: number): number {
  const d = Math.max(Math.abs(x) - 96, Math.abs(z) - 56);
  return SAND_Y * (1 - smooth01(d / 7));
}

/** How far ahead of the rake head Gubba's centre stands so that his hands hold the handle `l` from the tines. */
export function autoStanceDistance(variant: GubbaVariant): number {
  const g = AUTO_GRIPS[variant];
  const dy = g.y + g.lift;
  const dh = Math.sqrt(Math.max(1, g.l * g.l - dy * dy));
  return g.z + Math.sqrt(Math.max(1, dh * dh - g.x * g.x));
}

export function createAutoState(world: AutoWorld, seed: number): AutoState {
  let rng = (Math.imul(seed | 0, 0x9e3779b1) ^ 0x3c6ef372) >>> 0;
  if (rng === 0) rng = 0x2545f491;
  return {
    world,
    variant: "moss",
    x: world.home[0],
    y: world.home[1],
    z: world.home[2],
    yaw: world.homeYaw,
    speed: 0,
    dist: 0,
    gaitAmp: 0,
    seated: true,
    working: false,
    yielding: false,
    phase: 0,
    rake: null,
    rakeDown: false,
    rakeLive: false,
    tipX: 0,
    tipY: 0,
    tipZ: 0,
    gripX: 0,
    gripY: 0,
    gripZ: 0,
    carried: null,
    carryX: 0,
    carryY: 0,
    carryZ: 0,
    carryYaw: 0,
    armX: 0,
    armOn: false,
    sweepProgress: -1,
    stepped: false,
    loop: false,
    stoneOps: NO_OPS,
    strokes: NO_STROKES,
    smoothCount: 0,
    opKind: new Int32Array(PROGRAM_CAP),
    opA: new Float64Array(PROGRAM_CAP),
    opB: new Float64Array(PROGRAM_CAP),
    pc: 0,
    len: 0,
    sub: 0,
    opMs: 0,
    cmdKind: new Int32Array(RING),
    cmdA: new Float64Array(RING),
    cmdB: new Float64Array(RING),
    cmdHead: 0,
    cmdTail: 0,
    cmdX: 0,
    cmdY: 0,
    rng,
    spent: false,
    reach: false,
    moved: 0,
    tx: 0,
    tz: 0,
    fx: 0,
    fz: 0,
    bestD: Infinity,
    stallMs: 0,
    hx: 0,
    hy: 0,
    ptIx: 0,
    segOff: 0,
    kappa: 0,
    stanceYaw: 0,
    pathYaw: 0,
    stanceSign: 1,
    sx: 0,
    sz: 0,
    sweepMs: 0,
    admireMs: 0,
    srcX: 0,
    srcY: 0,
    srcZ: 0,
    carryT: 1,
    carryGoal: 1,
    ox: 0,
    oz: 0,
    or: 0,
    nx: 0,
    nz: 0,
  };
}

export function autoPhase(a: AutoState): AutoPhase {
  return AUTO_PHASES[a.phase] ?? "idle";
}

// --------------------------------------------------------------------------------------------- commands

function ringFree(a: AutoState): number {
  return RING - 1 - ((a.cmdTail - a.cmdHead + RING) % RING);
}

function emit(a: AutoState, kind: number, x: number, y: number): void {
  const next = (a.cmdTail + 1) % RING;
  if (next === a.cmdHead) return;
  a.cmdKind[a.cmdTail] = kind;
  a.cmdA[a.cmdTail] = x;
  a.cmdB[a.cmdTail] = y;
  a.cmdTail = next;
}

/** Takes the next command, leaving its numbers in `a.cmdX` and `a.cmdY`. Returns `AUTO_CMD.NONE` when empty. */
export function autoPoll(a: AutoState): number {
  if (a.cmdHead === a.cmdTail) return AUTO_CMD.NONE;
  const kind = a.cmdKind[a.cmdHead] ?? 0;
  a.cmdX = a.cmdA[a.cmdHead] ?? 0;
  a.cmdY = a.cmdB[a.cmdHead] ?? 0;
  a.cmdHead = (a.cmdHead + 1) % RING;
  return kind;
}

// --------------------------------------------------------------------------------------------- compiling

function push(a: AutoState, kind: number, x = 0, y = 0): void {
  if (a.len >= PROGRAM_CAP) return;
  a.opKind[a.len] = kind;
  a.opA[a.len] = x;
  a.opB[a.len] = y;
  a.len++;
}

/** Drops whatever step is in hand. What he holds and where he stands carry over into the next program. */
function abort(a: AutoState): void {
  a.pc = 0;
  a.len = 0;
  a.sub = 0;
  a.opMs = 0;
  a.rakeDown = false;
  a.rakeLive = false;
  a.sweepProgress = -1;
  a.carryGoal = 1;
  a.cmdHead = a.cmdTail;
}

/**
 * Starts a run toward a garden from wherever Gubba is and whatever he holds. `stoneOps` is the stone plan;
 * when the stones are done the director asks for the sand plan (`AUTO_CMD.PLAN_SAND`). With `trivial` the
 * garden already is the target: he only goes home. `stepped` is the reduced-motion form; `loop` makes him look
 * the finished garden over and then ask for another.
 */
export function autoBegin(a: AutoState, stoneOps: readonly StoneOp[], stepped: boolean, loop: boolean, trivial = false): void {
  abort(a);
  a.stoneOps = stoneOps;
  a.strokes = NO_STROKES;
  a.smoothCount = 0;
  a.stepped = stepped;
  a.loop = loop;
  a.yielding = false;
  a.working = true;
  if (!stepped) a.seated = false;
  if (a.carried !== null) push(a, OP_DROP);
  if (trivial) {
    finish(a);
    return;
  }
  push(a, OP_PHASE, 1);
  if (stepped) {
    if (a.rake !== null) push(a, OP_RAKE, NO_RAKE);
    if (!a.seated) push(a, OP_HOME, 1);
    for (let i = 0; i < stoneOps.length; i++) {
      push(a, OP_WAIT, AUTO_STEP_MS);
      push(a, OP_CMD, AUTO_CMD.STONE_WHOLE, i);
    }
  } else {
    if (stoneOps.length > 0 && a.rake !== null) push(a, OP_RAKE, NO_RAKE);
    for (let i = 0; i < stoneOps.length; i++) push(a, OP_STONE, i);
  }
  push(a, OP_CMD, AUTO_CMD.PLAN_SAND);
}

/** Promotes an in-flight one-shot garden run to loop continuously without restarting progress. */
export function autoEnableLoop(a: AutoState): void {
  if (a.loop) return;
  a.loop = true;
  if (a.len > 0 && a.opKind[a.len - 1] === OP_CMD && a.opA[a.len - 1] === AUTO_CMD.DONE) {
    push(a, OP_ADMIRE);
    push(a, OP_CMD, AUTO_CMD.NEXT);
  }
}

function finish(a: AutoState): void {
  push(a, OP_PHASE, 4);
  if (a.rake !== null || !a.stepped) push(a, OP_RAKE, NO_RAKE);
  push(a, OP_HOME);
  push(a, OP_CMD, AUTO_CMD.DONE);
  if (a.loop) {
    push(a, OP_ADMIRE);
    push(a, OP_CMD, AUTO_CMD.NEXT);
  }
}

/**
 * Appends the rest of the run once the caller has planned the sand: `smooth` says how old marks are cleared,
 * and `strokes` is every stroke to pull, the first `smoothCount` of them smoothing passes.
 */
export function autoPlanRake(
  a: AutoState,
  smooth: "none" | "nagi" | "sweep",
  strokes: readonly AutoStroke[],
  smoothCount: number,
): void {
  a.strokes = strokes;
  a.smoothCount = smoothCount;
  if (a.stepped) {
    if (smooth !== "none") push(a, OP_PHASE, 2);
    if (smooth === "sweep") {
      push(a, OP_WAIT, AUTO_STEP_MS);
      push(a, OP_CMD, AUTO_CMD.SWEEP_WHOLE);
    }
    for (let i = 0; i < strokes.length; i++) {
      if (i === smoothCount) push(a, OP_PHASE, 3);
      push(a, OP_WAIT, AUTO_STEP_MS);
      push(a, OP_CMD, AUTO_CMD.STROKE_WHOLE, i);
    }
  } else {
    let held = a.rake === null ? NO_RAKE : AUTO_RAKE_ORDER.indexOf(a.rake);
    if (smooth !== "none") push(a, OP_PHASE, 2);
    if (smooth === "sweep") {
      const hoki = AUTO_RAKE_ORDER.indexOf("hoki");
      if (held !== hoki) push(a, OP_RAKE, hoki);
      held = hoki;
      push(a, OP_SWEEP);
    }
    for (let i = 0; i < strokes.length; i++) {
      const stroke = strokes[i];
      if (!stroke || stroke.points.length < 2) continue;
      if (i === smoothCount) push(a, OP_PHASE, 3);
      const want = AUTO_RAKE_ORDER.indexOf(stroke.rake);
      if (want !== held) push(a, OP_RAKE, want);
      held = want;
      push(a, OP_STROKE, i);
    }
  }
  push(a, OP_CMD, AUTO_CMD.SEAL);
  finish(a);
}

/**
 * Gives way to the player: whatever is in hand is put away and he walks home. `handOver` drops the rake at once
 * because the player has it selected, so it goes to their hand instead of its pegs. The caller ends any stroke
 * or sweep in the sand itself; nothing in this program changes the garden.
 */
export function autoYield(a: AutoState, handOver: boolean): void {
  abort(a);
  a.stoneOps = NO_OPS;
  a.strokes = NO_STROKES;
  a.loop = false;
  a.yielding = true;
  if (handOver) a.rake = null;
  if (a.seated && a.rake === null && a.carried === null) {
    a.working = false;
    a.yielding = false;
    a.phase = 0;
    return;
  }
  a.working = true;
  // reported at once, not from the next tick: the yield is already under way
  a.phase = 6;
  push(a, OP_PHASE, 6);
  if (a.carried !== null) push(a, OP_DROP);
  if (a.rake !== null) push(a, OP_RAKE, NO_RAKE);
  push(a, OP_HOME);
  push(a, OP_CMD, AUTO_CMD.YIELDED);
}

// --------------------------------------------------------------------------------------------- walking

/** Loads obstacle `i` (the basket, the shishi-odoshi, then each tall element) into `a.ox/oz/or`. */
function obstacle(a: AutoState, i: number, elements: readonly ElementInstance[]): boolean {
  const w = a.world;
  if (i === 0) {
    a.ox = w.basket[0];
    a.oz = w.basket[2];
    a.or = AUTO_BASKET_RADIUS;
    return true;
  }
  if (i === 1) {
    a.ox = w.shishi[0];
    a.oz = w.shishi[2];
    a.or = AUTO_SHISHI_RADIUS;
    return true;
  }
  const e = elements[i - 2];
  if (!e) return false;
  const fp = w.footprints[e.kind];
  if (fp.height < AUTO_TALL_HEIGHT) return false;
  a.ox = e.x - 96;
  a.oz = e.y - 56;
  a.or = Math.max(fp.rx, fp.ry) + AUTO_BODY_CLEARANCE;
  return true;
}

/** Moves the scratch point `a.nx, a.nz` out of every obstacle and into the walkable box. */
function settlePoint(a: AutoState, elements: readonly ElementInstance[], passes: number): void {
  const count = 2 + elements.length;
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < count; i++) {
      if (!obstacle(a, i, elements)) continue;
      let dx = a.nx - a.ox;
      let dz = a.nz - a.oz;
      let d = Math.hypot(dx, dz);
      if (d >= a.or) continue;
      if (d < 1e-6) {
        dx = 0;
        dz = 1;
        d = 1;
      }
      a.nx = a.ox + (dx / d) * a.or;
      a.nz = a.oz + (dz / d) * a.or;
    }
    a.nx = clamp(a.nx, AUTO_WALK_BOX.minX, AUTO_WALK_BOX.maxX);
    a.nz = clamp(a.nz, AUTO_WALK_BOX.minZ, AUTO_WALK_BOX.maxZ);
  }
}

/** Sets the walk target to the nearest reachable point to (x, z). */
function walkTo(a: AutoState, x: number, z: number, elements: readonly ElementInstance[]): void {
  a.nx = x;
  a.nz = z;
  settlePoint(a, elements, 3);
  a.tx = a.nx;
  a.tz = a.nz;
  a.bestD = Infinity;
  a.stallMs = 0;
}

/** Sets the walk target to the point `r` from (cx, cz) on Gubba's side of it, and faces (cx, cz) on arrival. */
function standBy(a: AutoState, cx: number, cz: number, r: number, elements: readonly ElementInstance[]): void {
  let dx = a.x - cx;
  let dz = a.z - cz;
  let d = Math.hypot(dx, dz);
  if (d < 1e-6) {
    dx = 0;
    dz = 1;
    d = 1;
  }
  a.fx = cx;
  a.fz = cz;
  walkTo(a, cx + (dx / d) * r, cz + (dz / d) * r, elements);
}

function commitMove(a: AutoState, dt: number, elements: readonly ElementInstance[]): void {
  settlePoint(a, elements, 1);
  let mx = a.nx - a.x;
  let mz = a.nz - a.z;
  let moved = Math.hypot(mx, mz);
  // being nudged clear of a stone is still walking: never further in a tick than his fastest step
  const cap = AUTO_STANCE_SPEED * dt;
  if (moved > cap) {
    mx *= cap / moved;
    mz *= cap / moved;
    moved = cap;
  }
  a.dist += moved;
  a.moved += moved;
  a.x += mx;
  a.z += mz;
}

/** One step of a walk toward the target, steering round whatever stands in the way. True on arrival. */
function walkStep(a: AutoState, vmax: number, dt: number, elements: readonly ElementInstance[]): boolean {
  let dx = a.tx - a.x;
  let dz = a.tz - a.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.05) {
    a.x = a.tx;
    a.z = a.tz;
    a.speed = 0;
    return true;
  }
  if (d < a.bestD - 0.01) {
    a.bestD = d;
    a.stallMs = 0;
  } else {
    a.stallMs += dt * 1000;
    if (a.stallMs > STALL_MS) {
      a.speed = 0;
      return true;
    }
  }
  dx /= d;
  dz /= d;
  const direct = Math.atan2(dx, dz);
  let steer = direct;
  let nearest = Infinity;
  const count = 2 + elements.length;
  for (let i = 0; i < count; i++) {
    if (!obstacle(a, i, elements)) continue;
    const cx = a.ox - a.x;
    const cz = a.oz - a.z;
    const along = cx * dx + cz * dz;
    if (along <= 0 || along >= d || along >= nearest) continue;
    const r = a.or + 1;
    if (Math.abs(cx * dz - cz * dx) >= r) continue;
    const toCentre = Math.atan2(cx, cz);
    const off = Math.asin(Math.min(1, r / Math.max(Math.hypot(cx, cz), r)));
    steer = toCentre - (wrap(toCentre - direct) >= 0 ? off : -off);
    nearest = along;
  }
  const err = wrap(steer - a.yaw);
  const maxTurn = AUTO_TURN_RATE * dt;
  a.yaw = wrap(a.yaw + clamp(err, -maxTurn, maxTurn));
  const off = Math.abs(err);
  const want = off > 1 ? 0 : vmax * (1 - 0.5 * off);
  a.speed += clamp(want - a.speed, -120 * dt, 70 * dt);
  const step = Math.min(a.speed * dt, d);
  // the last few units go straight at the target, so a slow turn can never circle it
  const close = d < 6;
  a.nx = a.x + (close ? dx : Math.sin(a.yaw)) * step;
  a.nz = a.z + (close ? dz : Math.cos(a.yaw)) * step;
  commitMove(a, dt, elements);
  return false;
}

/** Turns toward (px, pz) without moving. True once he faces it. */
function faceStep(a: AutoState, px: number, pz: number, dt: number): boolean {
  a.speed = 0;
  const dx = px - a.x;
  const dz = pz - a.z;
  if (Math.hypot(dx, dz) < 1e-6) return true;
  const err = wrap(Math.atan2(dx, dz) - a.yaw);
  const maxTurn = AUTO_TURN_RATE * dt;
  a.yaw = wrap(a.yaw + clamp(err, -maxTurn, maxTurn));
  return Math.abs(err) <= maxTurn + 0.1;
}

/** Follows the stance point `a.sx, a.sz` at the stance speed while facing the rake head. */
function stanceStep(a: AutoState, dt: number, elements: readonly ElementInstance[]): void {
  const dx = a.sx - a.x;
  const dz = a.sz - a.z;
  const d = Math.hypot(dx, dz);
  const step = Math.min(d, AUTO_STANCE_SPEED * dt);
  a.nx = d > 1e-9 ? a.x + (dx / d) * step : a.x;
  a.nz = d > 1e-9 ? a.z + (dz / d) * step : a.z;
  commitMove(a, dt, elements);
  a.speed = dt > 0 ? step / dt : 0;
  const hx = a.hx - 96 - a.x;
  const hz = a.hy - 56 - a.z;
  if (Math.hypot(hx, hz) > 1e-6) {
    const err = wrap(Math.atan2(hx, hz) - a.yaw);
    const maxTurn = AUTO_TURN_RATE * dt;
    a.yaw = wrap(a.yaw + clamp(err, -maxTurn, maxTurn));
  }
}

/** Puts the stance point `D` from the rake head along the stance direction. */
function setStance(a: AutoState, D: number): void {
  a.sx = a.hx - 96 + D * Math.sin(a.stanceYaw);
  a.sz = a.hy - 56 + D * Math.cos(a.stanceYaw);
}

/** True if Gubba can stand `D` from the rake head in direction `yaw`: inside the box and clear of everything tall. */
function stanceFree(a: AutoState, yaw: number, D: number, elements: readonly ElementInstance[]): boolean {
  const x = a.hx - 96 + D * Math.sin(yaw);
  const z = a.hy - 56 + D * Math.cos(yaw);
  if (x < AUTO_WALK_BOX.minX || x > AUTO_WALK_BOX.maxX || z < AUTO_WALK_BOX.minZ || z > AUTO_WALK_BOX.maxZ) return false;
  const count = 2 + elements.length;
  for (let i = 0; i < count; i++) {
    if (obstacle(a, i, elements) && Math.hypot(x - a.ox, z - a.oz) < a.or) return false;
  }
  return true;
}

/**
 * Turns the stance direction toward `want`, or toward the nearest direction beside it where he has room to
 * stand. Swinging round the head keeps his hands the same distance along the handle, where being pushed off
 * the stance would not. The side he is already on is kept unless the other is clearly nearer.
 */
function turnStance(a: AutoState, want: number, D: number, dt: number, elements: readonly ElementInstance[]): void {
  const STEP = 0.16;
  const side = wrap(a.stanceYaw - want) < 0 ? -1 : 1;
  let goal = want;
  for (let k = 0; k * STEP <= Math.PI; k++) {
    if (stanceFree(a, want + side * k * STEP, D, elements)) {
      goal = want + side * k * STEP;
      break;
    }
    if (k >= 2 && stanceFree(a, want - side * (k - 2) * STEP, D, elements)) {
      goal = want - side * (k - 2) * STEP;
      break;
    }
  }
  const rate = Math.min(AUTO_TURN_RATE, (0.9 * AUTO_STANCE_SPEED) / D) * dt;
  a.stanceYaw = wrap(a.stanceYaw + clamp(wrap(goal - a.stanceYaw), -rate, rate));
}

/** How far the feet have fallen behind the stance: 1 when in place, down to 0.1 when well behind. */
function keepUp(a: AutoState): number {
  const lag = Math.hypot(a.sx - a.x, a.sz - a.z);
  return lag > 3 ? Math.max(0.1, 1 - (lag - 3) / 6) : 1;
}

// --------------------------------------------------------------------------------------------- strokes

function pointAt(points: readonly Vec2[], i: number): Vec2 | undefined {
  return points[i];
}

/** Unsigned turn per cell of travel around vertex `i` of a polyline. */
function curvature(points: readonly Vec2[], i: number): number {
  const p0 = pointAt(points, i - 1);
  const p1 = pointAt(points, i);
  const p2 = pointAt(points, i + 1);
  if (!p0 || !p1 || !p2) return 0;
  const ax = p1.x - p0.x;
  const ay = p1.y - p0.y;
  const bx = p2.x - p1.x;
  const by = p2.y - p1.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
  return turn / (0.5 * (la + lb));
}

/** Total distance the stance would be pushed off course (out of the box, into the basket) over a stroke. */
function stancePenalty(a: AutoState, points: readonly Vec2[], sign: number, D: number): number {
  const w = a.world;
  const n = points.length;
  const steps = Math.min(24, n - 1);
  let penalty = 0;
  for (let s = 0; s <= steps; s++) {
    const i = Math.min(n - 2, Math.floor((s * (n - 1)) / Math.max(1, steps)));
    const p = pointAt(points, i);
    const q = pointAt(points, i + 1);
    if (!p || !q) continue;
    const tx = q.x - p.x;
    const tz = q.y - p.y;
    const l = Math.hypot(tx, tz);
    if (l < 1e-9) continue;
    const x = p.x - 96 + (sign * D * tx) / l;
    const z = p.y - 56 + (sign * D * tz) / l;
    penalty += Math.max(0, AUTO_WALK_BOX.minX - x) + Math.max(0, x - AUTO_WALK_BOX.maxX);
    penalty += Math.max(0, AUTO_WALK_BOX.minZ - z) + Math.max(0, z - AUTO_WALK_BOX.maxZ);
    penalty += Math.max(0, AUTO_BASKET_RADIUS - Math.hypot(x - w.basket[0], z - w.basket[2]));
    penalty += Math.max(0, AUTO_SHISHI_RADIUS - Math.hypot(x - w.shishi[0], z - w.shishi[2]));
  }
  return penalty;
}

function opStroke(a: AutoState, ix: number, dtMs: number, dt: number, elements: readonly ElementInstance[]): boolean {
  const stroke = a.strokes[ix];
  const points = stroke ? stroke.points : NO_POINTS;
  const first = pointAt(points, 0);
  if (!first || points.length < 2) return true;
  a.spent = true;
  const D = autoStanceDistance(a.variant);
  switch (a.sub) {
    case 0: {
      // Lead the rake, walking backward ahead of it, so the fresh grooves are never underfoot; follow it
      // instead where leading would have him pushed off course further (a stroke that runs at the wall).
      let ti = 1;
      let second = pointAt(points, ti);
      while (second && second.x === first.x && second.y === first.y) second = pointAt(points, ++ti);
      const tx = second ? second.x - first.x : 1;
      const tz = second ? second.y - first.y : 0;
      a.stanceSign = stancePenalty(a, points, 1, D) <= stancePenalty(a, points, -1, D) ? 1 : -1;
      a.pathYaw = Math.atan2(a.stanceSign * tx, a.stanceSign * tz);
      a.stanceYaw = a.pathYaw;
      a.hx = first.x;
      a.hy = first.y;
      a.kappa = 0;
      // start beside the path if the place ahead of it is taken
      turnStance(a, a.pathYaw, D, 1e3, elements);
      setStance(a, D);
      walkTo(a, a.sx, a.sz, elements);
      a.sub = 1;
      return false;
    }
    case 1:
      if (walkStep(a, AUTO_WALK_SPEED, dt, elements)) a.sub = 2;
      return false;
    case 2: {
      // turn to the head first, then set the tines down: lowered mid-turn they would swing past his hands
      if (!a.rakeDown && !faceStep(a, a.hx - 96, a.hy - 56, dt)) return false;
      a.rakeDown = true;
      if (Math.hypot(a.tipX - (a.hx - 96), a.tipY - SAND_Y, a.tipZ - (a.hy - 56)) < 0.6) {
        a.ptIx = 0;
        a.segOff = 0;
        a.rakeLive = true;
        emit(a, AUTO_CMD.STROKE_BEGIN, ix, 0);
        a.sub = 3;
      }
      return false;
    }
    case 3: {
      // slow for tight turns, so his feet (D out from the head) keep inside their own speed, and for lagging feet
      const k = Math.max(curvature(points, a.ptIx), curvature(points, a.ptIx + 1));
      a.kappa += (k - a.kappa) * Math.min(1, dt * 6);
      const turn = D * a.kappa;
      let v = Math.min(AUTO_RAKE_SPEED, (0.9 * AUTO_STANCE_SPEED) / Math.sqrt(1 + turn * turn));
      if (v < AUTO_RAKE_MIN_SPEED) v = AUTO_RAKE_MIN_SPEED;
      let budget = v * keepUp(a) * dt;
      let done = false;
      let tx = 0;
      let tz = 0;
      while (budget > 0 && ringFree(a) > 3) {
        const p = pointAt(points, a.ptIx);
        const q = pointAt(points, a.ptIx + 1);
        if (!p || !q) {
          done = true;
          break;
        }
        const seg = Math.hypot(q.x - p.x, q.y - p.y);
        if (seg > 1e-9) {
          tx = (q.x - p.x) / seg;
          tz = (q.y - p.y) / seg;
        }
        const rem = seg - a.segOff;
        if (budget >= rem) {
          budget -= rem;
          a.ptIx++;
          a.segOff = 0;
          a.hx = q.x;
          a.hy = q.y;
          emit(a, AUTO_CMD.STROKE_TO, q.x, q.y);
        } else {
          a.segOff += budget;
          const t = a.segOff / seg;
          a.hx = p.x + (q.x - p.x) * t;
          a.hy = p.y + (q.y - p.y) * t;
          emit(a, AUTO_CMD.STROKE_TO, a.hx, a.hy);
          budget = 0;
        }
      }
      if (!done && !pointAt(points, a.ptIx + 1)) done = true;
      if (tx !== 0 || tz !== 0) a.pathYaw = Math.atan2(a.stanceSign * tx, a.stanceSign * tz);
      turnStance(a, a.pathYaw, D, dt, elements);
      setStance(a, D);
      stanceStep(a, dt, elements);
      if (done) {
        emit(a, AUTO_CMD.STROKE_END, ix, 0);
        a.rakeDown = false;
        a.rakeLive = false;
        a.opMs = 0;
        a.sub = 4;
      }
      return false;
    }
    default:
      a.speed = 0;
      a.opMs += dtMs;
      return a.opMs >= SETTLE_MS;
  }
}

/** The broom is pushed, not pulled: Gubba follows it west to east along the middle of the bed. */
function opSweep(a: AutoState, dtMs: number, dt: number, elements: readonly ElementInstance[]): boolean {
  a.spent = true;
  const D = autoStanceDistance(a.variant);
  switch (a.sub) {
    case 0:
      a.stanceSign = -1;
      a.pathYaw = -Math.PI / 2;
      a.stanceYaw = a.pathYaw;
      a.hx = 0;
      a.hy = 56;
      turnStance(a, a.pathYaw, D, 1e3, elements);
      setStance(a, D);
      walkTo(a, a.sx, a.sz, elements);
      a.sub = 1;
      return false;
    case 1:
      if (walkStep(a, AUTO_WALK_SPEED, dt, elements)) a.sub = 2;
      return false;
    case 2: {
      if (!a.rakeDown && !faceStep(a, a.hx - 96, a.hy - 56, dt)) return false;
      a.rakeDown = true;
      if (Math.hypot(a.tipX - (a.hx - 96), a.tipY - SAND_Y, a.tipZ - (a.hy - 56)) < 0.6) {
        a.sweepMs = 0;
        a.sweepProgress = 0;
        a.rakeLive = true;
        emit(a, AUTO_CMD.SWEEP_BEGIN, 0, 0);
        a.sub = 3;
      }
      return false;
    }
    case 3: {
      a.sweepMs += dtMs * keepUp(a);
      const p = Math.min(1, a.sweepMs / AUTO_SWEEP_MS);
      const e = smooth01(p);
      // the broom follows the middle of the sweep's front, and stops at the frame while the front runs out
      a.hx = clamp(-4 + 208 * e, 0, 192);
      a.sweepProgress = e;
      emit(a, AUTO_CMD.SWEEP_TO, p, e);
      turnStance(a, a.pathYaw, D, dt, elements);
      setStance(a, D);
      stanceStep(a, dt, elements);
      if (p >= 1) {
        emit(a, AUTO_CMD.SWEEP_END, 0, 0);
        a.sweepProgress = -1;
        a.rakeDown = false;
        a.rakeLive = false;
        a.opMs = 0;
        a.sub = 4;
      }
      return false;
    }
    default:
      a.speed = 0;
      a.opMs += dtMs;
      return a.opMs >= SETTLE_MS;
  }
}

// --------------------------------------------------------------------------------------------- stones and rakes

function reachOf(a: AutoState, kind: ElementKind): number {
  const fp = a.world.footprints[kind];
  return Math.max(fp.rx, fp.ry) + AUTO_BODY_CLEARANCE;
}

function basketTop(a: AutoState): void {
  a.srcX = a.world.basket[0];
  a.srcY = a.world.basket[1] + 9;
  a.srcZ = a.world.basket[2];
}

function opStone(a: AutoState, ix: number, dtMs: number, dt: number, elements: readonly ElementInstance[]): boolean {
  const op = a.stoneOps[ix];
  if (!op) return true;
  const w = a.world;
  a.spent = true;
  switch (a.sub) {
    case 0:
      if (op.type === "place") standBy(a, w.basket[0], w.basket[2], AUTO_BASKET_RADIUS + 1, elements);
      else standBy(a, op.x - 96, op.y - 56, reachOf(a, op.kind), elements);
      a.sub = 1;
      return false;
    case 1:
      if (walkStep(a, AUTO_WALK_SPEED, dt, elements)) a.sub = 2;
      return false;
    case 2:
      a.reach = true;
      if (faceStep(a, a.fx, a.fz, dt)) {
        if (op.type === "place") basketTop(a);
        else {
          a.srcX = op.x - 96;
          a.srcY = SAND_Y;
          a.srcZ = op.y - 56;
        }
        a.carried = op.kind;
        a.carryT = 0;
        a.carryGoal = 1;
        emit(a, op.type === "place" ? AUTO_CMD.STONE_TAKE : AUTO_CMD.STONE_LIFT, ix, 0);
        a.sub = 3;
      }
      return false;
    case 3:
      a.reach = true;
      if (a.carryT >= 1) a.sub = 4;
      return false;
    case 4:
      if (op.type === "remove") standBy(a, w.basket[0], w.basket[2], AUTO_BASKET_RADIUS + 1, elements);
      else standBy(a, op.toX - 96, op.toY - 56, reachOf(a, op.kind), elements);
      a.sub = 5;
      return false;
    case 5:
      if (walkStep(a, AUTO_CARRY_SPEED, dt, elements)) a.sub = 6;
      return false;
    case 6:
      a.reach = true;
      if (faceStep(a, a.fx, a.fz, dt)) {
        if (op.type === "remove") basketTop(a);
        else {
          a.srcX = op.toX - 96;
          a.srcY = SAND_Y;
          a.srcZ = op.toY - 56;
        }
        a.carryGoal = 0;
        a.sub = 7;
      }
      return false;
    case 7:
      a.reach = true;
      if (a.carryT <= 0) {
        emit(a, op.type === "remove" ? AUTO_CMD.STONE_BASKET : AUTO_CMD.STONE_SET, ix, 0);
        a.carried = null;
        a.carryGoal = 1;
        a.opMs = 0;
        a.sub = 8;
      }
      return false;
    default:
      a.opMs += dtMs;
      return a.opMs >= SETTLE_MS;
  }
}

/** Takes whatever he carries to the basket (a run cut short with a stone in his arms). */
function opDrop(a: AutoState, dtMs: number, dt: number, elements: readonly ElementInstance[]): boolean {
  if (a.carried === null && a.sub < 4) return true;
  const w = a.world;
  a.spent = true;
  switch (a.sub) {
    case 0:
      standBy(a, w.basket[0], w.basket[2], AUTO_BASKET_RADIUS + 1, elements);
      a.sub = 1;
      return false;
    case 1:
      if (walkStep(a, AUTO_CARRY_SPEED, dt, elements)) a.sub = 2;
      return false;
    case 2:
      a.reach = true;
      if (faceStep(a, a.fx, a.fz, dt) && a.carryT >= 1) {
        basketTop(a);
        a.carryGoal = 0;
        a.sub = 3;
      }
      return false;
    case 3:
      a.reach = true;
      if (a.carryT <= 0) {
        emit(a, AUTO_CMD.STONE_BASKET, -1, 0);
        a.carried = null;
        a.carryGoal = 1;
        a.opMs = 0;
        a.sub = 4;
      }
      return false;
    default:
      a.opMs += dtMs;
      return a.opMs >= SETTLE_MS;
  }
}

function pegStand(a: AutoState, id: RakeId, elements: readonly ElementInstance[]): void {
  const w = a.world;
  const x = w.rackSlots[id].x;
  a.fx = x;
  a.fz = w.hangZ;
  walkTo(a, x, Math.max(AUTO_WALK_BOX.minZ, w.hangZ + RACK_REACH), elements);
}

/** Leaves him holding rake `want` (an index into `AUTO_RAKE_ORDER`, or `NO_RAKE` for empty hands). */
function opRake(a: AutoState, want: number, dtMs: number, dt: number, elements: readonly ElementInstance[]): boolean {
  const target = want < 0 ? null : (AUTO_RAKE_ORDER[want] ?? null);
  switch (a.sub) {
    case 0:
      if (a.rake === target) return true;
      a.spent = true;
      if (a.rake !== null) {
        pegStand(a, a.rake, elements);
        a.sub = 1;
      } else a.sub = 4;
      return false;
    case 1:
      a.spent = true;
      if (walkStep(a, AUTO_WALK_SPEED, dt, elements)) a.sub = 2;
      return false;
    case 2:
      a.spent = true;
      a.reach = true;
      if (faceStep(a, a.fx, a.fz, dt)) {
        emit(a, AUTO_CMD.RAKE_HANG, a.rake === null ? NO_RAKE : AUTO_RAKE_ORDER.indexOf(a.rake), 0);
        a.rake = null;
        a.opMs = 0;
        a.sub = 3;
      }
      return false;
    case 3:
      a.spent = true;
      a.reach = true;
      a.opMs += dtMs;
      if (a.opMs >= RAKE_SWAP_MS) a.sub = 4;
      return false;
    case 4:
      if (target === null) return true;
      a.spent = true;
      pegStand(a, target, elements);
      a.sub = 5;
      return false;
    case 5:
      a.spent = true;
      if (walkStep(a, AUTO_WALK_SPEED, dt, elements)) a.sub = 6;
      return false;
    case 6:
      a.spent = true;
      a.reach = true;
      if (faceStep(a, a.fx, a.fz, dt)) {
        a.rake = target;
        carryTip(a);
        a.tipX = a.nx;
        a.tipY = a.or;
        a.tipZ = a.nz;
        emit(a, AUTO_CMD.RAKE_TAKE, want, 0);
        a.opMs = 0;
        a.sub = 7;
      }
      return false;
    default:
      a.spent = true;
      a.reach = true;
      a.opMs += dtMs;
      return a.opMs >= RAKE_SWAP_MS;
  }
}

function opHome(a: AutoState, keepWorking: boolean, dt: number, elements: readonly ElementInstance[]): boolean {
  const w = a.world;
  if (!a.seated) {
    a.spent = true;
    if (a.sub === 0) {
      a.tx = w.home[0];
      a.tz = w.home[2];
      a.bestD = Infinity;
      a.stallMs = 0;
      a.sub = 1;
      return false;
    }
    if (a.sub === 1) {
      // a walk the stall guard cut short still has to end on the cushion: sub 2 finishes it in a straight line
      if (walkStep(a, AUTO_WALK_SPEED, dt, elements)) a.sub = a.x === w.home[0] && a.z === w.home[2] ? 3 : 2;
      return false;
    }
    if (a.sub === 2) {
      const dx = w.home[0] - a.x;
      const dz = w.home[2] - a.z;
      const d = Math.hypot(dx, dz);
      const step = Math.min(d, AUTO_WALK_SPEED * dt);
      if (d <= step) {
        a.x = w.home[0];
        a.z = w.home[2];
        a.sub = 3;
      } else {
        a.x += (dx / d) * step;
        a.z += (dz / d) * step;
      }
      a.dist += step;
      a.moved += step;
      return false;
    }
    a.speed = 0;
    const err = wrap(w.homeYaw - a.yaw);
    const maxTurn = AUTO_TURN_RATE * dt;
    if (Math.abs(err) > maxTurn) {
      a.yaw = wrap(a.yaw + (err > 0 ? maxTurn : -maxTurn));
      return false;
    }
    a.yaw = w.homeYaw;
    a.seated = true;
    a.gaitAmp = 0;
  }
  if (!keepWorking) {
    a.working = false;
    a.yielding = false;
    a.phase = 0;
  }
  return true;
}

function opAdmire(a: AutoState, dtMs: number): boolean {
  a.spent = true;
  if (a.sub === 0) {
    let x = a.rng >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    a.rng = x === 0 ? 0x2545f491 : x;
    a.admireMs = AUTO_ADMIRE_MIN_MS + (a.rng / 4294967296) * (AUTO_ADMIRE_MAX_MS - AUTO_ADMIRE_MIN_MS);
    a.phase = 5;
    a.opMs = 0;
    a.sub = 1;
    return false;
  }
  a.opMs += dtMs;
  if (a.opMs < a.admireMs) return false;
  a.phase = 0;
  return true;
}

// --------------------------------------------------------------------------------------------- the tick

/** Where the rake head floats while he walks with it: leaves the point in `a.nx, a.or (height), a.nz`. */
function carryTip(a: AutoState): void {
  const g = AUTO_GRIPS[a.variant];
  const s = Math.sin(a.yaw);
  const c = Math.cos(a.yaw);
  const fwd = g.z + 16;
  const side = g.x * 0.5;
  a.nx = a.x + s * fwd + c * side;
  a.nz = a.z + c * fwd - s * side;
  a.or = autoGroundY(a.x, a.z) + 8;
}

/** Height added where he walks over a low element: a gentle rise, not a climb. */
function lowLift(a: AutoState, elements: readonly ElementInstance[]): number {
  let lift = 0;
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    if (!e) continue;
    const fp = a.world.footprints[e.kind];
    if (fp.height >= AUTO_TALL_HEIGHT) continue;
    const q = Math.hypot((a.x - (e.x - 96)) / (fp.rx + 10), (a.z - (e.y - 56)) / (fp.ry + 10));
    if (q >= 1) continue;
    const h = 0.8 * fp.height * (1 - smooth01(q));
    if (h > lift) lift = h;
  }
  return lift;
}

/** Derives everything the pose and the scene read from where he now stands. */
function settle(a: AutoState, dt: number, elements: readonly ElementInstance[]): void {
  const w = a.world;
  const g = AUTO_GRIPS[a.variant];
  const fromHome = Math.hypot(a.x - w.home[0], a.z - w.home[2]);
  a.y = a.seated ? w.home[1] : autoGroundY(a.x, a.z) + lowLift(a, elements) + g.lift * smooth01(fromHome / 8);

  const pace = dt > 0 ? a.moved / dt : 0;
  a.gaitAmp += (clamp(pace / 12, 0, 1) - a.gaitAmp) * Math.min(1, dt * 5);

  const s = Math.sin(a.yaw);
  const c = Math.cos(a.yaw);
  a.gripX = a.x + s * g.z + c * g.x;
  a.gripY = a.y + g.y;
  a.gripZ = a.z + c * g.z - s * g.x;

  if (a.rake !== null) {
    if (a.rakeLive) {
      a.tipX = a.hx - 96;
      a.tipY = SAND_Y;
      a.tipZ = a.hy - 56;
    } else {
      let tx: number;
      let ty: number;
      let tz: number;
      if (a.rakeDown) {
        tx = a.hx - 96;
        ty = SAND_Y;
        tz = a.hy - 56;
      } else {
        carryTip(a);
        tx = a.nx;
        ty = a.or;
        tz = a.nz;
      }
      const dx = tx - a.tipX;
      const dy = ty - a.tipY;
      const dz = tz - a.tipZ;
      const d = Math.hypot(dx, dy, dz);
      const step = TIP_SPEED * dt;
      if (d <= step || d < 1e-9) {
        a.tipX = tx;
        a.tipY = ty;
        a.tipZ = tz;
      } else {
        a.tipX += (dx / d) * step;
        a.tipY += (dy / d) * step;
        a.tipZ += (dz / d) * step;
      }
    }
  }

  if (a.carried !== null) {
    const rate = (dt * 1000) / LIFT_MS;
    a.carryT = clamp(a.carryT + clamp(a.carryGoal - a.carryT, -rate, rate), 0, 1);
    const b = AUTO_BELLY[a.variant];
    const k = smooth01(a.carryT);
    const bx = a.x + s * b.z + c * b.x;
    const by = a.y + b.y;
    const bz = a.z + c * b.z - s * b.x;
    a.carryX = a.srcX + (bx - a.srcX) * k;
    a.carryY = a.srcY + (by - a.srcY) * k + 5 * Math.sin(Math.PI * k);
    a.carryZ = a.srcZ + (bz - a.srcZ) * k;
    a.carryYaw = a.yaw * k;
  }

  const want = a.reach ? -1.1 : a.carried !== null ? -0.9 : a.rake !== null ? -0.55 : 0;
  a.armX += clamp(want - a.armX, -5 * dt, 5 * dt);
  a.armOn = want !== 0 || Math.abs(a.armX) > 0.01;
}

/**
 * Advances the run by `dtMs`. `elements` is the garden's stones as they are now: tall ones are walked round,
 * low ones stepped over. Allocates nothing.
 */
export function autoTick(a: AutoState, dtMs: number, elements: readonly ElementInstance[]): void {
  if (!(dtMs > 0)) return;
  const dt = dtMs / 1000;
  a.spent = false;
  a.reach = false;
  a.moved = 0;
  for (let guard = 0; a.pc < a.len && guard < 24; guard++) {
    const kind = a.opKind[a.pc] ?? 0;
    const arg = a.opA[a.pc] ?? 0;
    const timed = kind !== OP_PHASE && kind !== OP_CMD;
    // one timed step per tick, so a step that ends does not hand the same time to the next
    if (timed && a.spent) break;
    let done: boolean;
    switch (kind) {
      case OP_PHASE:
        a.phase = arg;
        done = true;
        break;
      case OP_CMD:
        done = ringFree(a) > 0;
        if (done) emit(a, arg, a.opB[a.pc] ?? 0, 0);
        break;
      case OP_WAIT:
        a.spent = true;
        a.opMs += dtMs;
        done = a.opMs >= arg;
        break;
      case OP_STONE:
        done = opStone(a, arg, dtMs, dt, elements);
        break;
      case OP_DROP:
        done = opDrop(a, dtMs, dt, elements);
        break;
      case OP_RAKE:
        done = opRake(a, arg, dtMs, dt, elements);
        break;
      case OP_STROKE:
        done = opStroke(a, arg, dtMs, dt, elements);
        break;
      case OP_SWEEP:
        done = opSweep(a, dtMs, dt, elements);
        break;
      case OP_HOME:
        done = opHome(a, arg !== 0, dt, elements);
        break;
      case OP_ADMIRE:
        done = opAdmire(a, dtMs);
        break;
      default:
        done = true;
    }
    if (!done) break;
    a.pc++;
    a.sub = 0;
    a.opMs = 0;
  }
  settle(a, dt, elements);
}
