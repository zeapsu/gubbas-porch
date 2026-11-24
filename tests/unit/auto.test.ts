import fs from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AUTO_ADMIRE_MAX_MS,
  AUTO_ADMIRE_MIN_MS,
  AUTO_BAG_PRESETS,
  AUTO_GRIPS,
  AUTO_STANCE_SPEED,
  AUTO_STEP_MS,
  AUTO_WALK_BOX,
  CUP_FADE_UNITS,
  applyAutoGait,
  autoGroundY,
  autoPhase,
  autoStanceDistance,
  createAutoBag,
  createAutoState,
  createGubbaState,
  drawAutoBag,
  planStones,
  poseGubba,
  xorshift32,
} from "../../src/gubba/index.ts";
import type { AutoPhase, AutoState, AutoWorld, StoneOp } from "../../src/gubba/index.ts";
import { createStrokeEngine, RAKE_BY_ID } from "../../src/rakes/index.ts";
import { GUBBA_YAW, HANG_Z, PROP_ORIGINS, RACK_SLOTS } from "../../src/render/scene/assets.ts";
import { SAND_CELLS, SAND_H, SAND_W, sandHash } from "../../src/sand/index.ts";
import {
  ELEMENT_FOOTPRINTS,
  NAGI_MAX_LANES,
  NAGI_MAX_TRAVEL,
  PRESET_GOLDEN_HASHES,
  PRESETS,
  applyPreset,
  countResidue,
  createGarden,
  createGardenStore,
  planSand,
  presetUntouched,
} from "../../src/state/index.ts";
import type { GardenStore } from "../../src/state/index.ts";
import type { ElementInstance, ElementKind, GardenState, GubbaVariant, PresetId, RakeId } from "../../src/state/types.ts";
import { createAutoRunner } from "../../src/ui/index.ts";
import type { AutoRunner } from "../../src/ui/index.ts";

// Gubba mode and "Watch: Gubba rakes", headless: the director, the planners and the runner that applies
// them to a real garden store, driven tick by tick with nothing but numbers for a clock.

const WORLD: AutoWorld = {
  home: PROP_ORIGINS.gubba,
  homeYaw: GUBBA_YAW,
  basket: PROP_ORIGINS.basket,
  shishi: PROP_ORIGINS.shishi,
  rackSlots: RACK_SLOTS,
  hangZ: HANG_Z,
  footprints: ELEMENT_FOOTPRINTS,
};
const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
const KINDS = Object.keys(ELEMENT_FOOTPRINTS) as ElementKind[];
const VARIANTS: readonly GubbaVariant[] = ["moss", "kasa", "lantern"];
/** The shortest rake handle, tines to tip: a grip further than this from the tines is off the handle. */
const SHORTEST_HANDLE = 40;

function gardenOf(id: PresetId): GardenState {
  const g = createGarden();
  g.elements = applyPreset(g.sand, id);
  return g;
}

interface Bytes {
  height: Int8Array;
  dir: Uint8Array;
  rock: Uint8Array;
  elements: string;
}

function bytesOf(g: GardenState): Bytes {
  return {
    height: g.sand.height.slice(),
    dir: g.sand.dir.slice(),
    rock: g.sand.rock.slice(),
    elements: JSON.stringify(g.elements),
  };
}

function sameBytes(a: Bytes, b: Bytes): boolean {
  if (a.elements !== b.elements) return false;
  for (let i = 0; i < SAND_CELLS; i++) {
    if (a.height[i] !== b.height[i] || a.dir[i] !== b.dir[i] || a.rock[i] !== b.rock[i]) return false;
  }
  return true;
}

const stonesOf = (elements: readonly ElementInstance[]): string[] => elements.map((e) => `${e.kind}@${e.x},${e.y}`).sort();

/** What a run is watched for, tick by tick; asserted once at the end (an `expect` per tick would crawl). */
interface Seen {
  /** Fastest he ever moved, in units per second. */
  maxSpeed: number;
  /** Furthest he ever strayed outside the walkable box. */
  outside: number;
  /** Furthest below, and above, the ground his feet ever were. */
  sunk: number;
  raised: number;
  /** Grip-to-tines distance while the rake was working the sand. */
  gripMin: number;
  gripMax: number;
  /** Most stones the garden ever held, counting one in his arms. */
  maxStones: number;
  /** Most entries the undo history ever held. */
  maxUndo: number;
  /** Ticks on which he was seated yet away from the cushion, or held something while seated. */
  seatedWrong: number;
  nonFinite: number;
}

interface Rig {
  store: GardenStore;
  runner: AutoRunner;
  calls: Record<"sandDirty" | "sandReset" | "rakeClack" | "stoneThud" | "sweepWhoosh" | "foley" | "changed", number>;
  lines: string[];
  seen: Seen;
}

function rig(from: PresetId | GardenState = "three_islands", seed = 42): Rig {
  const store = createGardenStore(typeof from === "string" ? gardenOf(from) : from);
  const calls = { sandDirty: 0, sandReset: 0, rakeClack: 0, stoneThud: 0, sweepWhoosh: 0, foley: 0, changed: 0 };
  const lines: string[] = [];
  const runner = createAutoRunner(
    store,
    WORLD,
    {
      sandDirty: () => void calls.sandDirty++,
      sandReset: () => void calls.sandReset++,
      rakeClack: () => void calls.rakeClack++,
      stoneThud: () => void calls.stoneThud++,
      sweepWhoosh: () => void calls.sweepWhoosh++,
      foley: () => void calls.foley++,
      line: (pool) => void lines.push(pool),
      changed: () => void calls.changed++,
    },
    seed,
  );
  const seen: Seen = {
    maxSpeed: 0,
    outside: 0,
    sunk: 0,
    raised: 0,
    gripMin: Infinity,
    gripMax: 0,
    maxStones: 0,
    maxUndo: 0,
    seatedWrong: 0,
    nonFinite: 0,
  };
  return { store, runner, calls, lines, seen };
}

function tick(r: Rig, dtMs: number, variant: GubbaVariant = "moss", reduced = false): void {
  const a = r.runner.state;
  const x0 = a.x;
  const z0 = a.z;
  r.runner.tick(dtMs, variant, reduced);
  const s = r.seen;
  if (dtMs > 0) s.maxSpeed = Math.max(s.maxSpeed, (Math.hypot(a.x - x0, a.z - z0) / dtMs) * 1000);
  const b = AUTO_WALK_BOX;
  s.outside = Math.max(s.outside, b.minX - a.x, a.x - b.maxX, b.minZ - a.z, a.z - b.maxZ);
  if (!Number.isFinite(a.x + a.y + a.z + a.yaw + a.gripX + a.gripY + a.gripZ + a.tipX + a.tipY + a.tipZ)) s.nonFinite++;
  if (a.seated) {
    if (a.x !== WORLD.home[0] || a.z !== WORLD.home[2] || a.y !== WORLD.home[1] || a.rake !== null || a.carried !== null) {
      s.seatedWrong++;
    }
  } else {
    const ground = autoGroundY(a.x, a.z);
    s.sunk = Math.max(s.sunk, ground - a.y);
    s.raised = Math.max(s.raised, a.y - ground);
  }
  if (a.rake !== null && a.rakeLive) {
    const d = Math.hypot(a.gripX - a.tipX, a.gripY - a.tipY, a.gripZ - a.tipZ);
    s.gripMin = Math.min(s.gripMin, d);
    s.gripMax = Math.max(s.gripMax, d);
  }
  s.maxStones = Math.max(s.maxStones, r.store.garden.elements.length + (a.carried !== null ? 1 : 0));
  s.maxUndo = Math.max(s.maxUndo, r.store.history.undoCount);
}

/** Ticks until `done` holds. Returns the time it took. */
function runUntil(
  r: Rig,
  done: () => boolean,
  opts: { dt?: number; maxMs?: number; variant?: GubbaVariant; reduced?: boolean } = {},
): number {
  const dt = opts.dt ?? 50;
  const maxMs = opts.maxMs ?? 900_000;
  let t = 0;
  while (!done() && t < maxMs) {
    tick(r, dt, opts.variant, opts.reduced);
    t += dt;
  }
  if (!done()) {
    const a = r.runner.state;
    throw new Error(
      `not reached after ${maxMs} ms: phase ${autoPhase(a)}, target ${r.runner.target}, at ${a.x.toFixed(1)},${a.z.toFixed(1)}, rake ${a.rake}, carried ${a.carried}`,
    );
  }
  return t;
}

const settled = (r: Rig) => (): boolean => !r.runner.state.working;

/** The things that must hold of any stretch of his walking about, whatever he was doing. */
function expectWellBehaved(r: Rig, label: string): void {
  const s = r.seen;
  expect(s.nonFinite, `${label}: finite`).toBe(0);
  // never a jump: the fastest he goes is the stance cap
  expect(s.maxSpeed, `${label}: speed`).toBeLessThanOrEqual(AUTO_STANCE_SPEED + 1e-6);
  expect(s.outside, `${label}: walkable box`).toBeLessThanOrEqual(1e-9);
  // feet on the ground: never under it, and over it only by his own lift plus a low stone's rise
  expect(s.sunk, `${label}: under the ground`).toBeLessThanOrEqual(1e-9);
  expect(s.raised, `${label}: over the ground`).toBeLessThanOrEqual(1.5 + 0.8 * 8 + 1e-9);
  expect(s.seatedWrong, `${label}: seated only at home, empty-handed`).toBe(0);
  expect(s.maxStones, `${label}: stones`).toBeLessThanOrEqual(12);
  if (s.gripMax > 0) {
    // his hands are on the handle whenever the tines are working
    expect(s.gripMax, `${label}: grip`).toBeLessThanOrEqual(SHORTEST_HANDLE);
    expect(s.gripMin, `${label}: grip`).toBeGreaterThan(4);
  }
}

function expectHome(r: Rig, label: string): void {
  const a = r.runner.state;
  expect(a.seated, label).toBe(true);
  expect(a.working, label).toBe(false);
  expect(a.rake, label).toBeNull();
  expect(a.carried, label).toBeNull();
  expect([a.x, a.y, a.z, a.yaw], label).toEqual([WORLD.home[0], WORLD.home[1], WORLD.home[2], WORLD.homeYaw]);
}

function expectPreset(r: Rig, id: PresetId, label: string): void {
  expect(sandHash(r.store.garden.sand) >>> 0, `${label}: sand`).toBe(PRESET_GOLDEN_HASHES[id]);
  expect(r.store.garden.elements, `${label}: stones`).toEqual(PRESETS[id].elements);
  expect(r.runner.lastSealDiffCells, `${label}: seal`).toBeLessThanOrEqual(64);
}

// ---------------------------------------------------------------------------
// The shuffle bag
// ---------------------------------------------------------------------------

describe("auto bag", () => {
  it("holds the six patterned presets and never Still Sand", () => {
    expect([...AUTO_BAG_PRESETS].sort()).toEqual(PRESET_IDS.filter((id) => id !== "still_sand").sort());
  });

  it("steps xorshift32 as a non-zero uint32 stream", () => {
    expect(xorshift32(1)).toBe(270369);
    expect(xorshift32(0)).not.toBe(0);
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        let x = seed;
        for (let i = 0; i < 50; i++) {
          x = xorshift32(x);
          if (x === 0 || x !== x >>> 0) return false;
        }
        return true;
      }),
    );
  });

  it("deals every preset once per shuffle and never the same one twice running", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const bag = createAutoBag(seed);
        const drawn: PresetId[] = [];
        for (let i = 0; i < 60; i++) drawn.push(drawAutoBag(bag));
        for (let i = 0; i < drawn.length; i += 6) {
          expect([...drawn.slice(i, i + 6)].sort()).toEqual([...AUTO_BAG_PRESETS].sort());
        }
        for (let i = 1; i < drawn.length; i++) expect(drawn[i]).not.toBe(drawn[i - 1]);
      }),
      { numRuns: 200 },
    );
  });

  it("is decided by its seed alone", () => {
    const deal = (seed: number): string => {
      const bag = createAutoBag(seed);
      return Array.from({ length: 24 }, () => drawAutoBag(bag)).join(",");
    };
    expect(deal(42)).toBe(deal(42));
    expect(deal(0)).toBe(deal(0));
    const distinct = new Set(Array.from({ length: 40 }, (_, seed) => deal(seed)));
    expect(distinct.size).toBeGreaterThan(30);
  });

  it("passes over a skipped preset without repeating, and still deals when everything is refused", () => {
    fc.assert(
      fc.property(fc.integer(), fc.constantFrom(...AUTO_BAG_PRESETS), (seed, skipped) => {
        const bag = createAutoBag(seed);
        let last: PresetId | null = null;
        for (let i = 0; i < 40; i++) {
          const id = drawAutoBag(bag, (p) => p === skipped);
          expect(id).not.toBe(skipped);
          expect(id).not.toBe(last);
          last = id;
        }
      }),
      { numRuns: 100 },
    );
    const bag = createAutoBag(7);
    const a = drawAutoBag(bag, () => true);
    const b = drawAutoBag(bag, () => true);
    expect(AUTO_BAG_PRESETS).toContain(a);
    expect(b).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// The stone planner
// ---------------------------------------------------------------------------

const stoneArb = fc.record({
  kind: fc.constantFrom(...KINDS),
  x: fc.integer({ min: 8, max: SAND_W - 8 }),
  y: fc.integer({ min: 8, max: SAND_H - 8 }),
});

function asElements(prefix: string, list: ReadonlyArray<{ kind: ElementKind; x: number; y: number }>): ElementInstance[] {
  return list.map((s, i) => ({ id: `${prefix}${i}`, kind: s.kind, x: s.x, y: s.y, ...pick(ELEMENT_FOOTPRINTS[s.kind]), rotation: 0 }));
}

function pick(fp: { rx: number; ry: number }): { rx: number; ry: number } {
  return { rx: fp.rx, ry: fp.ry };
}

describe("stone planner", () => {
  it("plans the fewest trips, never carries a stone twice, and never holds more than the larger garden", () => {
    fc.assert(
      fc.property(
        fc.array(stoneArb, { maxLength: 12 }),
        fc.array(stoneArb, { maxLength: 12 }),
        // some of the target stones stand exactly where a current one does
        fc.array(fc.nat(11), { maxLength: 6 }),
        fc.integer({ min: 0, max: SAND_W }),
        fc.integer({ min: 0, max: SAND_H }),
        (cur, tgtRaw, shared, fromX, fromY) => {
          const tgt = tgtRaw.map((t, i) => {
            const c = shared.includes(i) ? cur[i] : undefined;
            return c ? { ...c } : t;
          });
          const current = asElements("c", cur);
          const target = asElements("t", tgt);
          const ops = planStones(current, target, fromX, fromY);

          // the fewest trips there can be: per kind, the larger of what is left over on either side
          const key = (e: ElementInstance): string => `${e.kind}@${e.x},${e.y}`;
          const left = new Map<string, number>();
          for (const c of current) left.set(key(c), (left.get(key(c)) ?? 0) + 1);
          const want = new Map<ElementKind, number>();
          for (const t of target) {
            const n = left.get(key(t)) ?? 0;
            if (n > 0) left.set(key(t), n - 1);
            else want.set(t.kind, (want.get(t.kind) ?? 0) + 1);
          }
          const have = new Map<ElementKind, number>();
          for (const [k, n] of left) {
            const kind = k.slice(0, k.indexOf("@")) as ElementKind;
            have.set(kind, (have.get(kind) ?? 0) + n);
          }
          let fewest = 0;
          for (const kind of KINDS) fewest += Math.max(have.get(kind) ?? 0, want.get(kind) ?? 0);
          expect(ops.length).toBe(fewest);

          // removes, then moves, then places
          const rank = { remove: 0, move: 1, place: 2 } as const;
          for (let i = 1; i < ops.length; i++) {
            expect(rank[(ops[i] as StoneOp).type]).toBeGreaterThanOrEqual(rank[(ops[i - 1] as StoneOp).type]);
          }

          // carried out one trip at a time, the garden ends as the target and never overfills
          const garden = current.map((e) => ({ ...e }));
          const touched = new Set<string>();
          let most = garden.length;
          for (const op of ops) {
            expect(touched.has(op.id), "carried twice").toBe(false);
            touched.add(op.id);
            if (op.type !== "place") {
              const at = garden.findIndex((e) => e.id === op.id);
              expect(at).toBeGreaterThanOrEqual(0);
              expect(garden[at]).toMatchObject({ kind: op.kind, x: op.x, y: op.y });
              garden.splice(at, 1);
            }
            if (op.type !== "remove") garden.push({ ...(garden[0] ?? current[0] ?? target[0])!, id: `n-${op.id}`, kind: op.kind, x: op.toX, y: op.toY });
            most = Math.max(most, garden.length);
          }
          expect(stonesOf(garden)).toEqual(stonesOf(target));
          expect(most).toBeLessThanOrEqual(Math.max(current.length, target.length));
          expect(most).toBeLessThanOrEqual(12);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("leaves a stone alone that already stands where the target wants its kind", () => {
    const three = PRESETS.three_islands.elements;
    expect(planStones(three, three, 0, 0)).toEqual([]);
    const renamed = three.map((e, i) => ({ ...e, id: `mine-${i}` }));
    expect(planStones(renamed, three, 0, 0)).toEqual([]);
    expect(planStones([], [], 0, 0)).toEqual([]);
  });

  it("pairs each stone with the nearest place of its kind, and walks the nearest first", () => {
    const cur = asElements("c", [
      { kind: "stone_m", x: 20, y: 20 },
      { kind: "stone_m", x: 170, y: 90 },
      { kind: "stone_l", x: 100, y: 50 },
    ]);
    const tgt = asElements("t", [
      { kind: "stone_m", x: 160, y: 90 },
      { kind: "stone_m", x: 30, y: 20 },
      { kind: "pin", x: 96, y: 56 },
    ]);
    const ops = planStones(cur, tgt, 180, 100);
    expect(ops.map((o) => o.type)).toEqual(["remove", "move", "move", "place"]);
    expect(ops[0]).toMatchObject({ id: "c2", kind: "stone_l" });
    // he stands by the far corner, so that stone goes first
    expect(ops[1]).toMatchObject({ id: "c1", toX: 160, toY: 90 });
    expect(ops[2]).toMatchObject({ id: "c0", toX: 30, toY: 20 });
    expect(ops[3]).toMatchObject({ id: "t2", kind: "pin", toX: 96, toY: 56 });
  });

  it("plans the preset gardens as expected", () => {
    const types = (from: PresetId, to: PresetId): string =>
      planStones(PRESETS[from].elements, PRESETS[to].elements, 228, 58)
        .map((o) => o.type)
        .join(",");
    expect(types("three_islands", "ripple_pond")).toBe("remove,remove,move");
    expect(types("three_islands", "old_sea")).toBe("remove,remove,remove");
    expect(types("old_sea", "three_islands")).toBe("place,place,place");
    expect(types("ripple_pond", "river_bend")).toBe("move,place");
  });
});

// ---------------------------------------------------------------------------
// Smoothing plan
// ---------------------------------------------------------------------------

describe("sand plan", () => {
  it("finds nothing to smooth on level sand, or once the preset is there", () => {
    for (const id of PRESET_IDS) {
      const level = gardenOf("still_sand");
      expect(planSand(level.sand, id), id).toEqual({ kind: "none", residueCells: 0, strokes: [] });
      expect(countResidue(gardenOf(id).sand, id), id).toBe(0);
    }
    expect(presetUntouched("old_sea")).toBe(presetUntouched("old_sea"));
    // Still Sand has no strokes: every cell is one its strokes never write
    expect(presetUntouched("still_sand").reduce((n, v) => n + v, 0)).toBe(SAND_CELLS);
  });

  /** The sand Gubba faces: the old garden's marks, with the new garden's stones already set. */
  function facing(from: PresetId, to: PresetId): GardenState {
    const store = createGardenStore(gardenOf(from));
    for (const op of planStones(store.garden.elements, PRESETS[to].elements, 0, 0)) {
      if (op.type !== "place") store.silent.remove(op.id);
      if (op.type !== "remove") {
        store.silent.place({ id: `x-${op.id}`, kind: op.kind, x: op.toX, y: op.toY, ...pick(ELEMENT_FOOTPRINTS[op.kind]), rotation: 0 });
      }
    }
    return store.garden;
  }

  it("rakes straight over when the new strokes cover everything", () => {
    for (const from of PRESET_IDS) {
      if (from === "checker_field") continue;
      expect(planSand(facing(from, "checker_field").sand, "checker_field").kind, from).toBe("none");
    }
  });

  it("uses a few passes of Nagi for a little residue, and proves they clear it", () => {
    const g = facing("three_islands", "old_sea");
    const plan = planSand(g.sand, "old_sea");
    expect(plan.kind).toBe("nagi");
    expect(plan.residueCells).toBeGreaterThan(0);
    expect(plan.strokes.length).toBeGreaterThan(0);
    expect(plan.strokes.length).toBeLessThanOrEqual(NAGI_MAX_LANES);
    let travel = 0;
    for (const s of plan.strokes) {
      expect(s.rake).toBe("nagi");
      expect(s.points).toHaveLength(2);
      // east-going, level
      expect(s.points[1]!.x).toBeGreaterThan(s.points[0]!.x);
      expect(s.points[1]!.y).toBe(s.points[0]!.y);
      travel += s.points[1]!.x - s.points[0]!.x;
    }
    expect(travel).toBeLessThanOrEqual(NAGI_MAX_TRAVEL);
    const engine = createStrokeEngine(g.sand);
    for (const s of plan.strokes) {
      engine.begin(s.points[0]!, RAKE_BY_ID[s.rake], "mouse", { stones: g.elements, flow: true });
      engine.extend(s.points, 0);
      engine.end();
    }
    expect(countResidue(g.sand, "old_sea")).toBe(0);
  });

  it("calls for the broom when old marks would show through", () => {
    for (const [from, to] of [
      ["three_islands", "ripple_pond"],
      ["old_sea", "three_islands"],
      ["checker_field", "snails_thought"],
      ["river_bend", "still_sand"],
    ] as const) {
      const plan = planSand(facing(from, to).sand, to);
      expect(plan.kind, `${from} to ${to}`).toBe("sweep");
      expect(plan.strokes).toEqual([]);
      expect(plan.residueCells).toBe(countResidue(facing(from, to).sand, to));
    }
  });
});

// ---------------------------------------------------------------------------
// Ground, stance and gait
// ---------------------------------------------------------------------------

describe("ground, stance and gait", () => {
  it("puts the sand 3 up, the deck at 0, and a short ramp between", () => {
    expect(autoGroundY(0, 0)).toBe(3);
    expect(autoGroundY(96, 56)).toBe(3);
    expect(autoGroundY(-96, 0)).toBe(3);
    expect(autoGroundY(103, 0)).toBe(0);
    expect(autoGroundY(0, -63)).toBe(0);
    expect(autoGroundY(132, 2)).toBe(0);
    let prev = 3;
    for (let x = 96; x <= 104; x += 0.25) {
      const y = autoGroundY(x, 0);
      expect(y).toBeLessThanOrEqual(prev);
      expect(prev - y).toBeLessThan(0.35);
      prev = y;
    }
  });

  it("stands each variant so that its hands close on the handle at the grip length", () => {
    for (const v of VARIANTS) {
      const g = AUTO_GRIPS[v];
      const D = autoStanceDistance(v);
      // standing D ahead of the tines on level sand, facing back at them: grip to tines is exactly l
      const grip = Math.hypot(D - g.z, g.x, g.y + g.lift);
      expect(grip, v).toBeCloseTo(g.l, 9);
      expect(g.l, v).toBeLessThan(SHORTEST_HANDLE);
      // far enough that the head is clear of his belly
      expect(D, v).toBeGreaterThan(g.z + 12);
    }
  });

  const awayState = (x: number, z: number): AutoState => {
    const a = createAutoState(WORLD, 1);
    a.seated = false;
    a.working = true;
    a.x = x;
    a.z = z;
    a.y = autoGroundY(x, z);
    return a;
  };

  it("leaves the pose alone while he sits", () => {
    const g = createGubbaState("moss", "sometimes", {}, 3);
    const rest = poseGubba(g, 0.5, 4000);
    const pose = poseGubba(g, 0.5, 4000);
    applyAutoGait(pose, createAutoState(WORLD, 1));
    expect(pose).toEqual(rest);
    expect(pose.Cup.scale).toEqual({ x: 1, y: 1, z: 1 });
  });

  it("moves Root, not the cushion's frame: the offset is turned back by the porch yaw", () => {
    const g = createGubbaState("moss", "sometimes", {}, 3);
    const a = awayState(-20, 30);
    a.yaw = 1.1;
    const pose = poseGubba(g, 0, 4000);
    applyAutoGait(pose, a);
    // the scene places Root's parent at home, turned by homeYaw: undo that and he is where the director says
    const c = Math.cos(WORLD.homeYaw);
    const s = Math.sin(WORLD.homeYaw);
    const wx = WORLD.home[0] + pose.Root.pos.x * c + pose.Root.pos.z * s;
    const wz = WORLD.home[2] - pose.Root.pos.x * s + pose.Root.pos.z * c;
    expect(wx).toBeCloseTo(-20, 9);
    expect(wz).toBeCloseTo(30, 9);
    expect(WORLD.home[1] + pose.Root.pos.y).toBeCloseTo(3, 9);
    expect(pose.Root.rot.y + WORLD.homeYaw).toBeCloseTo(1.1, 9);
    // the turn is the short way round
    a.yaw = WORLD.homeYaw + Math.PI + 0.2;
    applyAutoGait(pose, a);
    expect(pose.Root.rot.y).toBeCloseTo(-Math.PI + 0.2, 9);
  });

  it("leaves the tea on the porch: the cup is gone a few steps from the cushion and whole at it", () => {
    const g = createGubbaState("kasa", "sometimes", {}, 3);
    const at = (dx: number): number => {
      const a = awayState(WORLD.home[0] - dx, WORLD.home[2]);
      a.variant = "kasa";
      const pose = poseGubba(g, 0, 4000);
      applyAutoGait(pose, a);
      expect(pose.Cup.scale.y).toBe(pose.Cup.scale.x);
      expect(pose.Cup.scale.z).toBe(pose.Cup.scale.x);
      return pose.Cup.scale.x;
    };
    expect(at(0)).toBe(1);
    expect(at(CUP_FADE_UNITS)).toBe(0);
    expect(at(60)).toBe(0);
    expect(at(CUP_FADE_UNITS / 2)).toBeCloseTo(0.5, 9);
    expect(at(1)).toBeGreaterThan(at(3));
  });

  it("locks the waddle to distance walked, and holds the arms in place of the idle pose", () => {
    const g = createGubbaState("moss", "sometimes", {}, 3);
    g.rain = true;
    const rest = poseGubba(g, 0, 4000);
    const a = awayState(0, 0);
    a.gaitAmp = 1;
    a.dist = (Math.PI / 2) * 9;
    a.armOn = true;
    a.armX = -0.55;
    const pose = poseGubba(g, 0, 4000);
    applyAutoGait(pose, a);
    expect(pose.Body.rot.z - rest.Body.rot.z).toBeCloseTo(0.07, 9);
    expect(pose.Body.pos.y - rest.Body.pos.y).toBeCloseTo(0.9, 9);
    expect(pose.Head.rot.z - rest.Head.rot.z).toBeCloseTo(-0.05, 9);
    expect(pose.Tail1.rot.y).not.toBe(rest.Tail1.rot.y);
    expect(pose.Prop_Bonsai.rot.z).not.toBe(rest.Prop_Bonsai.rot.z);
    // both arms hold the rake, whatever the rain pose had them doing
    expect([pose.ArmL.rot.x, pose.ArmR.rot.x, pose.ArmL.rot.z, pose.ArmR.rot.z]).toEqual([-0.55, -0.55, 0, 0]);
    // the same distance on is the same pose: nothing here reads a clock
    const again = poseGubba(g, 0, 4000);
    applyAutoGait(again, a);
    expect(again).toEqual(pose);
    // standing still, the gait is gone
    a.gaitAmp = 0;
    const still = poseGubba(g, 0, 4000);
    applyAutoGait(still, a);
    expect(still.Body.rot.z).toBe(rest.Body.rot.z);
    expect(still.Body.pos.y).toBe(rest.Body.pos.y);
  });
});

// ---------------------------------------------------------------------------
// Whole runs
// ---------------------------------------------------------------------------

describe("Watch: Gubba rakes (one garden)", () => {
  it("turns every preset into every other: 42 pairs, golden sand, one undo entry, home again", () => {
    let pair = 0;
    const plans = new Set<string>();
    for (const from of PRESET_IDS) {
      for (const to of PRESET_IDS) {
        if (from === to) continue;
        const label = `${from} to ${to}`;
        const variant = VARIANTS[pair++ % 3] as GubbaVariant;
        const r = rig(from, pair);
        const before = bytesOf(r.store.garden);
        expect(r.runner.request(to, false), label).toBe(true);
        expect(r.runner.target, label).toBe(to);
        expect(r.runner.state.working, label).toBe(true);
        runUntil(r, settled(r), { variant });
        expectPreset(r, to, label);
        expectHome(r, label);
        expectWellBehaved(r, label);
        expect(r.runner.mode, label).toBe(false);
        expect(r.runner.target, label).toBeNull();
        expect(r.runner.before, label).toBeNull();
        expect(r.runner.cyclesCompleted, label).toBe(1);
        expect(r.seen.maxUndo, label).toBe(1);
        expect(r.store.history.undoCount, label).toBe(1);
        expect(r.lines, label).toEqual(["auto_start", "auto_done"]);
        plans.add(r.runner.sandPlan ?? "");
        // one undo is the garden he started from, byte for byte; redo is his again
        expect(r.store.undo(), label).toBe(true);
        expect(sameBytes(bytesOf(r.store.garden), before), label).toBe(true);
        expect(r.store.redo(), label).toBe(true);
        expect(sandHash(r.store.garden.sand) >>> 0, label).toBe(PRESET_GOLDEN_HASHES[to]);
      }
    }
    expect(pair).toBe(42);
    expect([...plans].sort()).toEqual(["nagi", "none", "sweep"]);
  }, 120_000);

  it("has nothing to do when the garden already is the preset", () => {
    for (const id of PRESET_IDS) {
      const r = rig(id);
      expect(r.runner.request(id, false), id).toBe(false);
      expect(r.runner.state.working, id).toBe(false);
      expect(r.runner.before, id).toBeNull();
      expect(r.lines, id).toEqual([]);
      expect(r.store.history.undoCount, id).toBe(0);
    }
  });

  const scribbleArb = fc.record({
    strokes: fc.array(
      fc.record({
        rake: fc.constantFrom<RakeId>("sugi", "onami", "kinu", "hisui", "mikazuki", "tetsu", "wa", "take", "nagi"),
        points: fc.array(fc.record({ x: fc.double({ min: 0, max: SAND_W, noNaN: true }), y: fc.double({ min: 0, max: SAND_H, noNaN: true }) }), {
          minLength: 2,
          maxLength: 6,
        }),
      }),
      { minLength: 1, maxLength: 6 },
    ),
    stones: fc.array(stoneArb, { maxLength: 12 }),
    from: fc.constantFrom(...PRESET_IDS),
    to: fc.constantFrom(...PRESET_IDS),
    variant: fc.constantFrom(...VARIANTS),
    seed: fc.integer(),
  });

  it("turns any scribbled garden into any preset, and one undo gives the scribble back", () => {
    fc.assert(
      fc.property(scribbleArb, (s) => {
        const store0 = createGardenStore(gardenOf(s.from));
        s.stones.forEach((st, i) => store0.placeElement({ id: `s${i}`, kind: st.kind, x: st.x, y: st.y, ...pick(ELEMENT_FOOTPRINTS[st.kind]), rotation: 0 }));
        const engine = createStrokeEngine(store0.garden.sand);
        for (const stroke of s.strokes) {
          engine.begin(stroke.points[0]!, RAKE_BY_ID[stroke.rake], "mouse", { stones: store0.garden.elements, flow: true });
          engine.extend(stroke.points, 16);
          engine.end();
        }
        const r = rig(store0.snapshot(), s.seed);
        const before = bytesOf(r.store.garden);
        expect(r.runner.request(s.to, false)).toBe(true);
        runUntil(r, settled(r), { variant: s.variant });
        expectPreset(r, s.to, "scribble");
        expectHome(r, "scribble");
        expectWellBehaved(r, "scribble");
        expect(r.store.history.undoCount).toBe(1);
        expect(r.store.undo()).toBe(true);
        expect(sameBytes(bytesOf(r.store.garden), before)).toBe(true);
      }),
      { numRuns: 12 },
    );
  }, 120_000);

  it("ends at the same garden whatever the frame time, and the same way for the same frame times", () => {
    const run = (dt: number | "ragged"): { r: Rig; trace: number[] } => {
      const r = rig("three_islands", 9);
      const trace: number[] = [];
      expect(r.runner.request("river_bend", false)).toBe(true);
      let noise = 12345;
      for (let i = 0; r.runner.state.working && i < 400_000; i++) {
        noise = xorshift32(noise);
        tick(r, dt === "ragged" ? 4 + (noise % 90) : dt, "moss");
        if (i % 64 === 0) trace.push(r.runner.state.x, r.runner.state.z, r.runner.state.yaw, r.runner.state.tipX);
      }
      return { r, trace };
    };
    for (const dt of [4, 8, 1000 / 60, 33.4, 50, 100, 250, "ragged"] as const) {
      const { r } = run(dt);
      expectPreset(r, "river_bend", `dt ${dt}`);
      expectHome(r, `dt ${dt}`);
      expectWellBehaved(r, `dt ${dt}`);
      expect(r.store.history.undoCount, `dt ${dt}`).toBe(1);
      expect(r.runner.sandPlan, `dt ${dt}`).toBe("sweep");
    }
    const a = run(1000 / 60);
    const b = run(1000 / 60);
    expect(a.trace.length).toBeGreaterThan(400);
    expect(b.trace).toEqual(a.trace);
    expect(sameBytes(bytesOf(a.r.store.garden), bytesOf(b.r.store.garden))).toBe(true);
    const c = run("ragged");
    const d = run("ragged");
    expect(d.trace).toEqual(c.trace);
  }, 120_000);

  it("holds the rake by its handle in all three variants, and the carried stone at the belly", () => {
    for (const variant of VARIANTS) {
      const r = rig("three_islands", 5);
      expect(r.runner.request("ripple_pond", false)).toBe(true);
      const a = r.runner.state;
      const g = AUTO_GRIPS[variant];
      let liveTicks = 0;
      let carriedTicks = 0;
      const rakes = new Set<RakeId>();
      while (a.working) {
        tick(r, 1000 / 60, variant);
        if (a.seated) continue;
        // the grip is the variant's hand point, carried by where he stands and which way he faces
        const s = Math.sin(a.yaw);
        const c = Math.cos(a.yaw);
        expect(a.gripX).toBeCloseTo(a.x + s * g.z + c * g.x, 9);
        expect(a.gripZ).toBeCloseTo(a.z + c * g.z - s * g.x, 9);
        expect(a.gripY).toBeCloseTo(a.y + g.y, 9);
        if (a.rake !== null && a.rakeLive) {
          liveTicks++;
          rakes.add(a.rake);
          // tines on the sand, inside the bed
          expect(a.tipY).toBe(3);
          expect(Math.abs(a.tipX)).toBeLessThanOrEqual(96 + 1e-9);
          expect(Math.abs(a.tipZ)).toBeLessThanOrEqual(56 + 1e-9);
        }
        if (a.carried !== null) {
          carriedTicks++;
          expect(Math.hypot(a.carryX - a.x, a.carryZ - a.z)).toBeLessThan(40);
        }
      }
      expect(liveTicks, variant).toBeGreaterThan(500);
      expect(carriedTicks, variant).toBeGreaterThan(100);
      // the broom for the old marks, then each rake the preset's strokes call for, in their order
      const own = PRESETS.ripple_pond.strokes.map((st) => st.rake).filter((id, i, all) => id !== all[i - 1]);
      expect([...rakes], variant).toEqual(["hoki", ...own]);
      expectWellBehaved(r, variant);
      expect(r.seen.gripMin, variant).toBeGreaterThan(g.l - 12);
      expectPreset(r, "ripple_pond", variant);
      // one thud per stone set down, a clack for each rake taken and each hung, one whoosh for the sweep
      expect(r.calls.stoneThud, variant).toBe(3);
      expect(r.calls.rakeClack, variant).toBe(2 * (1 + own.length));
      expect(r.calls.sweepWhoosh, variant).toBe(1);
    }
  }, 60_000);

  it("reduced motion: he never leaves the cushion, and the garden changes a whole step at a time", () => {
    for (const to of ["ripple_pond", "old_sea", "still_sand"] as const) {
      const r = rig("three_islands", 3);
      const a = r.runner.state;
      expect(r.runner.request(to, true)).toBe(true);
      const changes: number[] = [];
      let last = `${sandHash(r.store.garden.sand)}|${stonesOf(r.store.garden.elements).join()}`;
      let t = 0;
      while (a.working && t < 600_000) {
        tick(r, 100, "moss", true);
        t += 100;
        expect(a.seated).toBe(true);
        expect(a.rake).toBeNull();
        expect(a.carried).toBeNull();
        const now = `${sandHash(r.store.garden.sand)}|${stonesOf(r.store.garden.elements).join()}`;
        if (now !== last) changes.push(t);
        last = now;
      }
      expect(a.working, to).toBe(false);
      expect(changes.length, to).toBeGreaterThan(2);
      for (let i = 1; i < changes.length; i++) expect(changes[i]! - changes[i - 1]!, to).toBeGreaterThanOrEqual(AUTO_STEP_MS);
      expectPreset(r, to, to);
      expect(r.runner.lastSealDiffCells, to).toBe(0);
      expect(r.seen.maxSpeed, to).toBe(0);
      expect(r.store.history.undoCount, to).toBe(1);
      expect(r.calls.foley, to).toBe(0);
    }
  });
});

describe("Gubba mode (one garden after another)", () => {
  it("loops: a new garden each time, 20 to 32 s of looking between, and nothing in the undo history", () => {
    const r = rig("three_islands", 11);
    const before = bytesOf(r.store.garden);
    r.runner.setMode(true, "sugi", false);
    expect(r.runner.mode).toBe(true);
    expect(r.runner.before).not.toBeNull();
    expect(r.lines).toEqual(["auto_start"]);
    const targets: PresetId[] = [];
    const rests: number[] = [];
    for (let cycle = 1; cycle <= 7; cycle++) {
      const target = r.runner.target!;
      targets.push(target);
      runUntil(r, () => r.runner.cyclesCompleted === cycle && autoPhase(r.runner.state) === "admiring", { dt: 50 });
      expectPreset(r, target, `cycle ${cycle}`);
      expect(r.runner.state.seated).toBe(true);
      expect(r.runner.state.working).toBe(false);
      // still the player's garden that would be saved
      expect(sameBytes(bytesOf(r.runner.before!), before), `cycle ${cycle}`).toBe(true);
      rests.push(runUntil(r, () => r.runner.state.working, { dt: 50, maxMs: 40_000 }));
    }
    expect(r.store.history.undoCount).toBe(0);
    expect(r.seen.maxUndo).toBe(0);
    expectWellBehaved(r, "loop");
    // never the garden that is already there, never the same twice running, never Still Sand
    expect(targets[0]).not.toBe("three_islands");
    for (let i = 1; i < targets.length; i++) expect(targets[i]).not.toBe(targets[i - 1]);
    expect(targets).not.toContain("still_sand");
    expect(new Set(targets.slice(0, 6)).size).toBeGreaterThanOrEqual(5);
    for (const rest of rests) {
      expect(rest).toBeGreaterThanOrEqual(AUTO_ADMIRE_MIN_MS);
      expect(rest).toBeLessThanOrEqual(AUTO_ADMIRE_MAX_MS + 100);
    }
    expect(new Set(rests).size).toBeGreaterThan(3);
    expect(r.lines.filter((l) => l === "auto_done")).toHaveLength(7);

    // the player takes over: everything he did is one entry, and one undo is the garden from before the mode
    const partial = bytesOf(r.store.garden);
    expect(r.runner.yield("sugi")).toBe(true);
    expect(r.runner.mode).toBe(false);
    expect(r.runner.before).toBeNull();
    expect(r.store.history.undoCount).toBe(1);
    runUntil(r, settled(r));
    expectHome(r, "after yield");
    expect(sameBytes(bytesOf(r.store.garden), partial)).toBe(true);
    expect(r.store.undo()).toBe(true);
    expect(sameBytes(bytesOf(r.store.garden), before)).toBe(true);
    expect(r.store.history.undoCount).toBe(0);
    expect(r.store.redo()).toBe(true);
    expect(sameBytes(bytesOf(r.store.garden), partial)).toBe(true);
  }, 120_000);

  it("deals the same gardens for the same seed", () => {
    const deal = (seed: number): PresetId[] => {
      const r = rig("three_islands", seed);
      r.runner.setMode(true, "sugi", true);
      const out: PresetId[] = [];
      for (let cycle = 1; cycle <= 13; cycle++) {
        out.push(r.runner.target!);
        runUntil(r, () => r.runner.cyclesCompleted === cycle, { dt: 400, reduced: true });
        runUntil(r, () => r.runner.state.working, { dt: 400, reduced: true, maxMs: 40_000 });
      }
      expect(r.store.history.undoCount).toBe(0);
      return out;
    };
    const a = deal(42);
    expect(deal(42)).toEqual(a);
    for (let i = 1; i < a.length; i++) expect(a[i]).not.toBe(a[i - 1]);
    // every patterned preset comes round
    expect(new Set(a).size).toBe(6);
    expect(deal(43)).not.toEqual(a);
  }, 60_000);

  it("re-plans toward a requested preset without snapping, then carries on by itself", () => {
    const r = rig("three_islands", 4);
    r.runner.setMode(true, "sugi", false);
    const drawn = r.runner.target!;
    const chosen: PresetId = drawn === "snails_thought" ? "river_bend" : "snails_thought";
    runUntil(r, () => autoPhase(r.runner.state) === "raking" && r.runner.state.rakeLive);
    const at = { x: r.runner.state.x, z: r.runner.state.z };
    const mid = bytesOf(r.store.garden);
    expect(r.runner.request(chosen, false)).toBe(true);
    expect(r.runner.mode).toBe(true);
    expect(r.runner.target).toBe(chosen);
    // nothing snapped at the click: the stroke in hand is closed where it had got to, and he is where he was
    const now = bytesOf(r.store.garden);
    let closed = 0;
    for (let i = 0; i < SAND_CELLS; i++) if (now.height[i] !== mid.height[i] || now.dir[i] !== mid.dir[i]) closed++;
    expect(closed).toBeLessThanOrEqual(64);
    expect(now.elements).toBe(mid.elements);
    expect(sandHash(r.store.garden.sand) >>> 0).not.toBe(PRESET_GOLDEN_HASHES[chosen]);
    expect([r.runner.state.x, r.runner.state.z]).toEqual([at.x, at.z]);
    expect(r.lines).toEqual(["auto_start"]);
    runUntil(r, () => r.runner.cyclesCompleted === 1 && r.runner.state.seated);
    expectPreset(r, chosen, "requested");
    runUntil(r, () => r.runner.state.working, { maxMs: 40_000 });
    expect(r.runner.target).not.toBe(chosen);
    expect(r.store.history.undoCount).toBe(0);
    expectWellBehaved(r, "re-plan");

    // asking for the garden that is already there, mid-admire, is a look and a new draw, not a snap
    const r2 = rig("old_sea", 4);
    r2.runner.setMode(true, "sugi", false);
    expect(r2.runner.request("old_sea", false)).toBe(true);
    runUntil(r2, () => r2.runner.cyclesCompleted === 1);
    expect(sandHash(r2.store.garden.sand) >>> 0).toBe(PRESET_GOLDEN_HASHES.old_sea);
    expect(r2.seen.maxSpeed).toBe(0);
  }, 60_000);

  it("a one-off garden that Gubba mode is turned on over carries on, and leads into the next", () => {
    const r = rig("three_islands", 8);
    expect(r.runner.request("checker_field", false)).toBe(true);
    runUntil(r, () => autoPhase(r.runner.state) === "raking");
    r.runner.setMode(true, "sugi", false);
    expect(r.runner.target).toBe("checker_field");
    runUntil(r, () => r.runner.cyclesCompleted === 1 && r.runner.state.seated);
    expectPreset(r, "checker_field", "carried on");
    expect(r.store.history.undoCount).toBe(0);
    expect(r.runner.before).not.toBeNull();
    runUntil(r, () => r.runner.state.working, { maxMs: 40_000 });
    expect(r.runner.target).not.toBe("checker_field");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Yielding to the player
// ---------------------------------------------------------------------------

interface Moment {
  name: string;
  to: PresetId;
  /** The phase he is in at that moment. */
  phase: AutoPhase;
  when: (a: AutoState, r: Rig) => boolean;
  /** Whether he has changed the garden by then. */
  dirty: boolean;
}

const MOMENTS: readonly Moment[] = [
  { name: "getting up", to: "ripple_pond", phase: "stones", when: (a) => !a.seated && Math.hypot(a.x - 132, a.z - 2) > 6, dirty: false },
  { name: "walking to a stone", to: "ripple_pond", phase: "stones", when: (a) => Math.abs(a.x) < 90 && a.carried === null, dirty: false },
  { name: "carrying a stone", to: "ripple_pond", phase: "stones", when: (a) => a.carried !== null && a.carryT >= 1, dirty: true },
  { name: "fetching the broom", to: "ripple_pond", phase: "smoothing", when: (a) => a.rake === null, dirty: true },
  { name: "sweeping", to: "ripple_pond", phase: "smoothing", when: (a) => a.rake === "hoki" && a.rakeLive && a.sweepProgress > 0.4, dirty: true },
  { name: "smoothing with Nagi", to: "old_sea", phase: "smoothing", when: (a) => a.rake === "nagi" && a.rakeLive, dirty: true },
  { name: "walking to the wall for a rake", to: "ripple_pond", phase: "raking", when: (a) => a.rake === "hoki" || a.rake === null, dirty: true },
  { name: "mid-stroke", to: "ripple_pond", phase: "raking", when: (a) => a.rake === "sugi" && a.rakeLive, dirty: true },
  { name: "between two strokes", to: "river_bend", phase: "raking", when: (a, r) => a.rake !== null && !a.rakeLive && r.calls.foley > 200, dirty: true },
  { name: "walking home", to: "ripple_pond", phase: "returning", when: (a) => a.rake === null && !a.seated, dirty: true },
  { name: "looking it over", to: "ripple_pond", phase: "admiring", when: (a) => a.seated, dirty: true },
];

describe("yielding to the player", () => {
  for (const variant of VARIANTS) {
    it(`from every moment of a run (${variant}): mode off, no teleport, one undo entry, and he walks home empty-handed`, () => {
      for (const m of MOMENTS) {
        const label = `${variant}, ${m.name}`;
        const r = rig("three_islands", 21);
        const a = r.runner.state;
        const before = bytesOf(r.store.garden);
        r.runner.setMode(true, "tetsu", false);
        r.runner.request(m.to, false);
        runUntil(r, () => autoPhase(a) === m.phase && m.when(a, r), { variant, dt: 1000 / 60 });
        const at = [a.x, a.y, a.z, a.yaw];
        const held = a.rake;
        const carried = a.carried;
        const clacks = r.calls.rakeClack;
        const thuds = r.calls.stoneThud;

        expect(r.store.history.undoCount, label).toBe(0);
        expect(r.runner.yield("tetsu"), label).toBe(true);
        expect(r.runner.mode, label).toBe(false);
        expect(r.runner.target, label).toBeNull();
        expect(r.runner.before, label).toBeNull();
        expect(r.lines.at(-1), label).toBe("auto_yield");
        // not a step taken, nothing dropped, at the moment of the yield
        expect([a.x, a.y, a.z, a.yaw], label).toEqual(at);
        expect(a.rake, label).toBe(held);
        expect(a.carried, label).toBe(carried);
        expect(a.rakeLive, label).toBe(false);
        expect(autoPhase(a), label).toBe(a.seated ? "idle" : "yielding");
        expect(r.store.history.undoCount, label).toBe(m.dirty ? 1 : 0);
        const left = bytesOf(r.store.garden);

        // a second edit while he walks home is no second entry
        tick(r, 1000 / 60, variant);
        expect(r.runner.yield("tetsu"), label).toBe(false);
        runUntil(r, settled(r), { variant, dt: 1000 / 60, maxMs: 60_000 });
        expectHome(r, label);
        expect(autoPhase(a), label).toBe("idle");
        expectWellBehaved(r, label);
        // the rake went back on its pegs and the stone into the basket, each with its sound; the sand he left
        // is as he left it
        expect(r.calls.rakeClack - clacks, label).toBe(held === null ? 0 : 1);
        expect(r.calls.stoneThud - thuds, label).toBe(carried === null ? 0 : 1);
        expect(sameBytes(bytesOf(r.store.garden), left), label).toBe(true);
        expect(r.store.history.undoCount, label).toBe(m.dirty ? 1 : 0);
        expect(r.runner.cyclesCompleted, label).toBe(m.phase === "admiring" ? 1 : 0);
        if (m.dirty) expect(r.store.undo(), label).toBe(true);
        expect(sameBytes(bytesOf(r.store.garden), before), label).toBe(true);

        // and he stays put: no garden follows
        for (let i = 0; i < 200; i++) tick(r, 250, variant);
        expectHome(r, label);
      }
    }, 120_000);
  }

  it("hands the rake straight over when it is the one the player has chosen", () => {
    const r = rig("three_islands", 2);
    const a = r.runner.state;
    r.runner.setMode(true, "sugi", false);
    r.runner.request("ripple_pond", false);
    runUntil(r, () => a.rake === "sugi" && a.rakeLive);
    const clacks = r.calls.rakeClack;
    expect(r.runner.yield("sugi")).toBe(true);
    expect(a.rake).toBeNull();
    runUntil(r, settled(r));
    expectHome(r, "handed over");
    // nothing to hang
    expect(r.calls.rakeClack).toBe(clacks);

    // chosen a moment later, while he is already carrying it to the wall: it leaves his hands then
    const r2 = rig("three_islands", 2);
    const a2 = r2.runner.state;
    r2.runner.request("ripple_pond", false);
    runUntil(r2, () => a2.rake === "sugi" && a2.rakeLive);
    expect(r2.runner.yield("wa")).toBe(true);
    expect(a2.rake).toBe("sugi");
    for (let i = 0; i < 20; i++) tick(r2, 50);
    expect(a2.rake).toBe("sugi");
    expect(r2.runner.yield("sugi")).toBe(false);
    expect(a2.rake).toBeNull();
    runUntil(r2, settled(r2));
    expectHome(r2, "handed over late");
    expect(r2.store.history.undoCount).toBe(1);
  });

  it("turning the mode off is a yield without a remark; turning it on and off at once leaves no trace", () => {
    const r = rig("three_islands", 6);
    const before = bytesOf(r.store.garden);
    r.runner.setMode(true, "sugi", false);
    r.runner.setMode(true, "sugi", false);
    r.runner.setMode(false, "sugi", false);
    expect(r.lines).toEqual(["auto_start"]);
    expect(r.runner.mode).toBe(false);
    expect(r.store.history.undoCount).toBe(0);
    // he had only begun to stand: he settles back without having gone anywhere
    runUntil(r, settled(r), { maxMs: 5000 });
    expectHome(r, "never got up");
    expect(r.runner.state.dist).toBe(0);
    expect(sameBytes(bytesOf(r.store.garden), before)).toBe(true);
    expect(r.runner.yield("sugi")).toBe(false);
    r.runner.setMode(false, "sugi", false);
    expect(r.calls.changed).toBe(2);
  });

  it("an undo in the middle of a run takes back all of it; redo brings the partial work back", () => {
    const r = rig("three_islands", 6);
    const before = bytesOf(r.store.garden);
    r.runner.setMode(true, "sugi", false);
    r.runner.request("river_bend", false);
    runUntil(r, () => autoPhase(r.runner.state) === "raking" && r.runner.state.rakeLive);
    for (let i = 0; i < 100; i++) tick(r, 50);
    // what the game does for Z: the run closes as one entry, then that entry is undone
    r.runner.yield("sugi");
    const partial = bytesOf(r.store.garden);
    expect(sameBytes(partial, before)).toBe(false);
    expect(r.store.undo()).toBe(true);
    expect(sameBytes(bytesOf(r.store.garden), before)).toBe(true);
    expect(r.store.history.undoCount).toBe(0);
    expect(r.store.history.redoCount).toBe(1);
    runUntil(r, settled(r));
    expect(sameBytes(bytesOf(r.store.garden), before)).toBe(true);
    expect(r.store.redo()).toBe(true);
    expect(sameBytes(bytesOf(r.store.garden), partial)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The frame budget
// ---------------------------------------------------------------------------

describe("zero per-frame allocation", () => {
  it("keeps every buffer and field it started with across 100,000 ticks of Gubba mode", () => {
    const r = rig("three_islands", 42);
    const a = r.runner.state;
    const buffers = [a.opKind, a.opA, a.opB, a.cmdKind, a.cmdA, a.cmdB];
    const lengths = buffers.map((b) => b.length);
    const keys = Object.keys(a).join();
    const types = Object.entries(a).map(([k, v]) => `${k}:${v === null ? "null" : typeof v}`);
    r.runner.setMode(true, "sugi", false);
    for (let i = 0; i < 100_000; i++) tick(r, 1000 / 60, VARIANTS[(i >> 14) % 3]);
    expect(r.runner.state).toBe(a);
    expect([a.opKind, a.opA, a.opB, a.cmdKind, a.cmdA, a.cmdB].every((b, i) => b === buffers[i])).toBe(true);
    expect([a.opKind, a.opA, a.opB, a.cmdKind, a.cmdA, a.cmdB].map((b) => b.length)).toEqual(lengths);
    expect(a.world).toBe(WORLD);
    // no field added, and none changed its kind (a number never became an object)
    expect(Object.keys(a).join()).toBe(keys);
    const nullable = new Set(["rake", "carried"]);
    for (const [k, v] of Object.entries(a)) {
      if (nullable.has(k)) continue;
      expect(types, k).toContain(`${k}:${v === null ? "null" : typeof v}`);
    }
    // 100,000 frames is some 28 minutes: several gardens, none of them in the undo history
    expect(r.runner.cyclesCompleted).toBeGreaterThanOrEqual(5);
    expect(r.store.history.undoCount).toBe(0);
    expect(r.seen.maxUndo).toBe(0);
    expectWellBehaved(r, "100k ticks");
    // the command ring never overflowed into a lost stroke: every garden finished was the preset
    expect(r.runner.lastSealDiffCells).toBeLessThanOrEqual(64);
  }, 120_000);

  const read = (path: string): string => fs.readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  /** Code only: comments say what they like. */
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("has nothing in the per-frame source that could allocate", () => {
    const director = code(read("src/gubba/autoRake.ts"));
    // everything from the walking code to the end of the file runs inside `autoTick`
    const hot = director.slice(director.indexOf("function obstacle("));
    expect(hot).toContain("export function autoTick(");
    expect(hot.length).toBeGreaterThan(20_000);
    const allocating = [
      /\bnew\b/,
      /=>/,
      /\bfunction\s*\(/,
      /\.(map|filter|slice|concat|flatMap|reduce|forEach|split|join|push|splice|sort|entries|keys|values)\(/,
      /\bArray\b|\bObject\b|\bJSON\b|\bString\(/,
      /\[\s*\.\.\.|\{\s*\.\.\./,
      /(=|return|\(|,)\s*\[/,
      /(=|return|\(|,)\s*\{/,
      /`/,
    ];
    for (const re of allocating) expect(hot.match(re)?.[0] ?? null, String(re)).toBeNull();

    const gait = code(read("src/gubba/autoGait.ts"));
    const body = gait.slice(gait.indexOf("export function applyAutoGait("));
    for (const re of allocating) expect(body.match(re)?.[0] ?? null, `gait ${re}`).toBeNull();

    // the runner's tick: commands are handled in place, points come from a pool
    const runner = code(read("src/ui/autoRunner.ts"));
    const tickBody = runner.slice(runner.indexOf("tick(dtMs, variant, reducedMotion) {"));
    for (const re of [/\bnew\b/, /=>/, /\.(map|filter|slice|concat)\(/, /\[\s*\.\.\./]) {
      expect(tickBody.match(re)?.[0] ?? null, `runner ${re}`).toBeNull();
    }
  });

  it("keeps Gubba's own modules pure, and haptics out of everything he does", () => {
    for (const file of ["autoBag.ts", "autoStones.ts", "autoRake.ts", "autoGait.ts"]) {
      const src = code(read(`src/gubba/${file}`));
      expect(src, file).not.toMatch(/\bwindow\b|\bdocument\b|\bperformance\b|\bDate\b|Math\.random|\bsetTimeout\b|\bnavigator\b/);
      // types only from the state module, and nothing from further up
      for (const line of src.split("\n").filter((l) => /^import /.test(l))) {
        if (/from "\.\.\//.test(line)) expect(line, file).toMatch(/^import type .* from "\.\.\/state\//);
        else expect(line, file).toMatch(/from "\.\/[A-Za-z]+\.ts"/);
      }
      expect(src.toLowerCase(), file).not.toContain("haptic");
    }
    const runner = code(read("src/ui/autoRunner.ts"));
    expect(runner.toLowerCase()).not.toContain("haptic");
    expect(runner).not.toMatch(/\bwindow\b|\bdocument\b|\bperformance\b|\bDate\b|Math\.random|\bnavigator\b/);
    expect(code(read("src/state/sandPlan.ts"))).not.toMatch(/\bwindow\b|\bdocument\b|\bDate\b|Math\.random/);
  });

  it("keeps working=true through an intermediate sit-down when switching to reduced motion mid-run", () => {
    const r = rig("three_islands", 11);
    expect(r.runner.request("ripple_pond", false)).toBe(true);
    // walk Gubba off his cushion first
    runUntil(r, () => !r.runner.state.seated && Math.hypot(r.runner.state.x - WORLD.home[0], r.runner.state.z - WORLD.home[2]) > 20);
    // switch to a reduced-motion request while away from home
    expect(r.runner.request("old_sea", true)).toBe(true);
    // advance until the intermediate OP_HOME sits him down on the cushion
    runUntil(r, () => r.runner.state.seated);
    // he still has the entire stepped preset ahead: working must stay true and phase must not drop to idle
    expect(r.runner.state.working).toBe(true);
    expect(autoPhase(r.runner.state)).not.toBe("idle");
    // finish the stepped run cleanly to golden
    runUntil(r, () => !r.runner.state.working);
    expect(sandHash(r.store.garden.sand)).toBe(PRESET_GOLDEN_HASHES.old_sea);
  });

  it("continues an in-flight one-shot Watch garden into the Gubba mode loop without restarting", () => {
    const r = rig("three_islands", 19);
    expect(r.runner.request("river_bend", false)).toBe(true);
    // advance into mid-raking of River Bend
    runUntil(r, () => autoPhase(r.runner.state) === "raking" && r.runner.state.rakeLive);
    for (let i = 0; i < 24; i++) tick(r, 50);
    const pcBefore = r.runner.state.pc;
    const xBefore = r.runner.state.x;
    const hashBefore = sandHash(r.store.garden.sand);

    r.runner.setMode(true, "sugi", false);
    expect(r.runner.mode).toBe(true);
    expect(r.runner.target).toBe("river_bend");
    // did not abort or reset pc/position
    expect(r.runner.state.pc).toBe(pcBefore);
    expect(r.runner.state.x).toBe(xBefore);
    expect(sandHash(r.store.garden.sand)).toBe(hashBefore);

    // finishes River Bend and then automatically moves on to a second preset
    runUntil(r, () => r.runner.cyclesCompleted === 1 && r.runner.state.seated);
    expect(sandHash(r.store.garden.sand)).toBe(PRESET_GOLDEN_HASHES.river_bend);
    runUntil(r, () => r.runner.target !== "river_bend" && r.runner.state.working, { maxMs: 60_000 });
    expect(r.runner.mode).toBe(true);
  });
});
