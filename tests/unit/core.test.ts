import fc from "fast-check";
import { describe, expect, it } from "vitest";
import models from "../../assets/models.spec.json";
import { createStrokeEngine, RAKE_BY_ID, RAKES, RACK_WIDTH } from "../../src/rakes/index.ts";
import type { RakeToolId, StrokeStartContext } from "../../src/rakes/index.ts";
import {
  applySweep, clearSandGrid, cloneSandGrid, createSandGrid, deflect, DIR_UNRAKED,
  KEEP, rebuildRockMask, SAND_CELLS, SAND_H, SAND_W, sandHash, stamp, sweepFront,
} from "../../src/sand/index.ts";
import type { SandGrid, SandVec2 } from "../../src/sand/index.ts";
import {
  applyPreset, cloneGarden, createGarden, createGardenStore, decodeGarden, decodeSettings, DEFAULT_SETTINGS,
  ELEMENT_FOOTPRINTS, encodeGarden, encodeSettings, MAX_GARDEN_BYTES, PRESET_GOLDEN_HASHES, PRESETS, UndoStack,
} from "../../src/state/index.ts";
import type { ElementInstance, GardenState, PresetId } from "../../src/state/index.ts";

const EMPTY_CONTEXT: StrokeStartContext = { stones: [], flow: false };
const STONE: ElementInstance = {
  id: "test-stone", kind: "stone_m", x: 90, y: 50, rx: 7, ry: 5, rotation: 0,
};

const point = fc.record({
  x: fc.integer({ min: 4, max: (SAND_W - 1) * 4 - 4 }).map(value => value / 4),
  y: fc.integer({ min: 4, max: (SAND_H - 1) * 4 - 4 }).map(value => value / 4),
});
const polyline = fc.array(point, { minLength: 2, maxLength: 6 });

function sameBytes(a: Int8Array | Uint8Array, b: Int8Array | Uint8Array): void {
  const bytes = (array: Int8Array | Uint8Array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  expect(Buffer.compare(bytes(a), bytes(b))).toBe(0);
}

function sameGrid(a: SandGrid, b: SandGrid): void {
  sameBytes(a.height, b.height);
  sameBytes(a.dir, b.dir);
  sameBytes(a.rock, b.rock);
}

function sameGarden(a: GardenState, b: GardenState): void {
  expect(a.elements).toEqual(b.elements);
  sameGrid(a.sand, b.sand);
}

function runStroke(grid: SandGrid, points: readonly SandVec2[], id: RakeToolId, ctx = EMPTY_CONTEXT) {
  const engine = createStrokeEngine(grid);
  engine.begin(points[0]!, RAKE_BY_ID[id], "mouse", ctx);
  const telemetry = engine.extend(points.slice(1), 16);
  return { telemetry, patch: engine.end() };
}

function distanceToSegment(x: number, y: number, a: SandVec2, b: SandVec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const squared = dx * dx + dy * dy;
  const fraction = squared ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / squared)) : 0;
  return Math.hypot(x - a.x - dx * fraction, y - a.y - dy * fraction);
}

describe("stroke geometry", () => {
  it("covers every centre within half a cell of the path and is 8-connected", () => {
    const paths = fc.oneof(polyline, fc.tuple(
      point,
      fc.integer({ min: -5000, max: 5000 }).map(value => value * Math.PI / 5000),
      fc.integer({ min: 1, max: 300 }),
    ).map(([start, angle, distance]) => [start, {
      x: start.x + Math.cos(angle) * distance,
      y: start.y + Math.sin(angle) * distance,
    }]));
    fc.assert(fc.property(paths, points => {
      const grid = createSandGrid();
      runStroke(grid, points, "take");
      const carved = new Set<number>();
      for (let y = 0; y < grid.h; y++) {
        for (let x = 0; x < grid.w; x++) {
          const i = y * grid.w + x;
          if (grid.dir[i] !== DIR_UNRAKED) carved.add(i);
          for (let j = 1; j < points.length; j++) {
            if (distanceToSegment(x + 0.5, y + 0.5, points[j - 1]!, points[j]!) <= 0.5) {
              if (!carved.has(i)) throw new Error(`Uncovered cell (${x}, ${y})`);
              break;
            }
          }
        }
      }
      const first = carved.values().next().value;
      expect(first).toBeDefined();
      const queue = [first!];
      carved.delete(first!);
      for (const index of queue) {
        const x = index % grid.w;
        const y = Math.floor(index / grid.w);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (x + dx < 0 || x + dx >= grid.w || y + dy < 0 || y + dy >= grid.h) continue;
            const neighbour = index + dy * grid.w + dx;
            if (carved.delete(neighbour)) queue.push(neighbour);
          }
        }
      }
      expect(carved.size).toBe(0);
    }), { numRuns: 180 });
  });

  it("keeps grids byte-identical across arbitrary Extend batches and repeated strokes", () => {
    const rakeId = fc.constantFrom(...RAKES.filter(rake => !rake.action).map(rake => rake.id));
    fc.assert(fc.property(polyline, rakeId, fc.nat(31), fc.boolean(), fc.boolean(),
      (points, id, splits, touch, flow) => {
        const ctx = { stones: [STONE], flow };
        const batch = createSandGrid();
        rebuildRockMask(batch, ctx.stones);
        const split = cloneSandGrid(batch);
        const a = createStrokeEngine(batch);
        const b = createStrokeEngine(split);
        const pointer = touch ? "touch" : "mouse";

        a.begin(points[0]!, RAKE_BY_ID[id], pointer, ctx);
        a.extend(points.slice(1), 100);
        a.end();
        b.begin(points[0]!, RAKE_BY_ID[id], pointer, ctx);
        let first = 1;
        for (let j = 1; j < points.length; j++) {
          if ((splits & (1 << j)) || j === points.length - 1) {
            b.extend(points.slice(first, j + 1), 17);
            first = j + 1;
          }
        }
        b.end();
        sameGrid(batch, split);
        a.begin(points[0]!, RAKE_BY_ID[id], pointer, ctx);
        a.extend(points.slice(1), 1);
        a.end();
        sameGrid(batch, split);
      },
    ), { numRuns: 55 });
  });

  it("waits three cells on touch, then carves from the press with a trailing handle", () => {
    const grid = createSandGrid();
    const engine = createStrokeEngine(grid);
    const start = { x: 20.5, y: 20.5 };
    engine.begin(start, RAKE_BY_ID.take, "touch", EMPTY_CONTEXT);
    const waiting = engine.extend([{ x: 21, y: 21 }, { x: 22, y: 21 }], 16);
    expect(waiting.active).toBe(false);
    expect(waiting.dirtyRect).toBeNull();
    sameGrid(grid, createSandGrid());

    const active = engine.extend([{ x: 24.5, y: 20.5 }], 16);
    expect(active.active).toBe(true);
    expect(active.speed).toBeGreaterThan(0);
    expect(Math.hypot(active.head.x - active.tail.x, active.head.y - active.tail.y)).toBeCloseTo(4);
    expect(grid.height[20 * grid.w + 20]).toBe(-2);
    engine.end();
    expect(engine.extend([], 0).active).toBe(false);

    engine.begin(start, RAKE_BY_ID.take, "touch", EMPTY_CONTEXT);
    engine.extend([{ x: 21.5, y: 20.5 }], 16);
    expect(engine.end().rect.w).toBe(0);
  });

  it("locks Wa to the press radius and reports the first stone contact", () => {
    const grid = createSandGrid();
    const ctx = { stones: [STONE], flow: true };
    rebuildRockMask(grid, ctx.stones);
    const engine = createStrokeEngine(grid);
    engine.begin({ x: 110, y: 50 }, RAKE_BY_ID.wa, "mouse", ctx);
    const orbit = engine.extend([{ x: 90, y: 10 }, { x: 53, y: 50 }], 80);
    expect(Math.hypot(orbit.head.x - STONE.x, orbit.head.y - STONE.y)).toBeCloseTo(20);
    engine.end();

    engine.begin({ x: 70, y: 46 }, RAKE_BY_ID.take, "mouse", ctx);
    const contact = engine.extend([{ x: 88, y: 46 }], 16);
    expect(contact.hitStone).toBe(true);
    expect(Math.hypot((contact.head.x - STONE.x) / 9.5, (contact.head.y - STONE.y) / 7.5))
      .toBeGreaterThanOrEqual(1);
    expect(engine.extend([{ x: 92, y: 46 }], 16).hitStone).toBe(false);
  });

  it("offsets Mikazuki by the sine of the travelled arc length", () => {
    const grid = createSandGrid();
    const rake = RAKE_BY_ID.mikazuki;
    runStroke(grid, [{ x: 10.5, y: 50 }, { x: 46.5, y: 50 }], rake.id);
    for (const [column, offset] of [[10, 0], [16, 3], [28, -3], [40, 3]] as const) {
      for (let row = 42; row < 58; row++) {
        const profileIndex = Math.floor(row + 0.5 - 50 + rake.headWidth / 2 - offset);
        expect(grid.height[row * grid.w + column]).toBe(rake.profile[profileIndex]);
      }
    }
  });

  it("clips strokes to the grid, bounds and rocks", () => {
    fc.assert(fc.property(point, point, (a, b) => {
      const grid = createSandGrid();
      grid.height.fill(2);
      grid.dir.fill(7);
      rebuildRockMask(grid, [STONE]);
      const { patch } = runStroke(grid, [a, b], "onami", { stones: [], flow: true });
      const { x, y, w, h } = patch.rect;
      expect(x >= 0 && y >= 0 && x + w <= grid.w && y + h <= grid.h).toBe(true);
      for (let i = 0; i < SAND_CELLS; i++) {
        const height = grid.height[i]!;
        const dir = grid.dir[i]!;
        if (height < -3 || height > 3) throw new Error(`Invalid height at ${i}`);
        if (height === 2 && dir === 7) continue;
        if (grid.rock[i]) throw new Error(`Rock cell changed at ${i}`);
        if (distanceToSegment(i % grid.w + 0.5, Math.floor(i / grid.w) + 0.5, a, b) > 19) {
          throw new Error(`Changed cell ${i} is out of reach`);
        }
      }
    }), { numRuns: 35 });
    const grid = createSandGrid();
    runStroke(grid, [{ x: -60, y: 40.5 }, { x: 240, y: 40.5 }], "take");
    expect(grid.height.slice(40 * grid.w, 41 * grid.w).every(value => value === -2)).toBe(true);
  });
});

describe("sand and rake contracts", () => {
  it("computes mask indices at cell centres, clones storage and keeps the mask when clearing", () => {
    const grid = createSandGrid();
    rebuildRockMask(grid, [STONE, { x: 2, y: 1, rx: 2, ry: 1 }]);
    expect(grid.rock[0]).toBe(2);
    expect(grid.rock[1 * grid.w + 3]).toBe(2);
    expect(grid.rock[2 * grid.w + 2]).toBe(0);
    expect(grid.rock[50 * grid.w + 90]).toBe(1);
    grid.height.fill(-2);
    grid.dir.fill(1);
    const clone = cloneSandGrid(grid);
    clearSandGrid(grid);
    sameBytes(grid.rock, clone.rock);
    expect(clone.height[0]).toBe(-2);
    expect(clone.dir[0]).toBe(1);
    expect(grid.height.every(value => value === 0)).toBe(true);
    expect(grid.dir.every(value => value === DIR_UNRAKED)).toBe(true);
  });

  it("stamps by overwrite, respecting KEEP, clamping, rock, dirt and direction crossings", () => {
    const grid = createSandGrid();
    const column = 18;
    const row = 23;
    const i = row * grid.w + column;
    grid.dir[i] = 4;
    grid.rock[i + grid.w] = 1;
    const rake = { profile: Int8Array.of(KEEP, 100, -100) };
    const first = stamp(grid, column + 0.5, row + 0.5, 0, rake, 0, [], false);
    expect(first).toEqual({ touched: 1, changed: 1, dirtyRect: { x: column, y: row, w: 1, h: 1 }, crossingSum: 1 });
    expect(grid.height[i]).toBe(3);
    expect(grid.height[i + grid.w]).toBe(0);
    expect(grid.dir[i - grid.w]).toBe(DIR_UNRAKED);
    const second = stamp(grid, column + 0.5, row + 0.5, Math.PI, rake, 0, [], false);
    expect(grid.height[i - grid.w]).toBe(-3);
    expect(second.crossingSum).toBeCloseTo(0);
    expect(stamp(grid, column + 0.5, row + 0.5, Math.PI, rake, 0, [], false).changed).toBe(0);
  });

  it("deflects radially, stays continuous off the ellipse centre, and excludes overlaps", () => {
    const angle = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true });
    const radialScale = fc.double({ min: 0.1, max: 4, noNaN: true });
    const at = (a: number, r: number) => ({ x: STONE.x + 9.5 * r * Math.cos(a), y: STONE.y + 7.5 * r * Math.sin(a) });
    const radius = (p: SandVec2) => Math.hypot((p.x - STONE.x) / 9.5, (p.y - STONE.y) / 7.5);
    fc.assert(fc.property(angle, radialScale, (a, r) => {
      const original = at(a, r);
      const out = deflect(original, [STONE]);
      if (r >= 1) expect(out).toEqual(original);
      expect(radius(out)).toBeGreaterThanOrEqual(1);
      expect(out.x).toBeCloseTo(at(a, Math.max(r, 1)).x, 8);
      expect(out.y).toBeCloseTo(at(a, Math.max(r, 1)).y, 8);
      const neighbour = deflect(at(a + 1e-5, r + 1e-5), [STONE]);
      expect(Math.hypot(out.x - neighbour.x, out.y - neighbour.y)).toBeLessThan(0.001);
    }));
    expect(radius(deflect(STONE, [STONE]))).toBeGreaterThanOrEqual(1);
    const overlap = { ...STONE, x: 101 };
    const out = deflect({ x: 96, y: 50 }, [STONE, overlap]);
    expect(radius(out)).toBeGreaterThanOrEqual(1);
    expect(Math.hypot((out.x - overlap.x) / 9.5, (out.y - overlap.y) / 7.5)).toBeGreaterThanOrEqual(1);
  });

  it("matches the rack layout, modelling spec and profile widths", () => {
    expect(RAKES).toHaveLength(10);
    expect(new Set(RAKES.map(rake => rake.id)).size).toBe(10);
    expect(new Set(RAKES.map(rake => rake.key)).size).toBe(10);
    expect(RAKES.map(rake => rake.rackX)).toEqual([-98.8, -67.4, -34.5, -10.1, 14.8, 38.7, 56.6, 70, 85.4, 102.8]);
    let right = -RACK_WIDTH / 2 - 3.4;
    for (const rake of RAKES) {
      expect(RAKE_BY_ID[rake.id]).toBe(rake);
      expect(rake.headWidth).toBe(rake.profile.length);
      expect(rake.headWidth / 2).toBeLessThanOrEqual(2 * rake.handle);
      expect(rake.rackX - rake.rackSlotWidth / 2 - right).toBeCloseTo(3.4);
      right = rake.rackX + rake.rackSlotWidth / 2;
      const runs = Array.from(rake.profile).filter((height, i) => height < 0 && (i === 0 || rake.profile[i - 1]! >= 0));
      const model = models.models.find(model => model.id === `rake_${rake.id}`);
      expect(model).toBeDefined();
      expect(runs.length).toBe(model?.nodeCounts?.tine_ ?? 0);
      expect(rake.tineCount).toBe(runs.length);
    }
    expect(right).toBeCloseTo(108.8);
    expect(right + RACK_WIDTH / 2).toBeCloseTo(217.6);
  });

  it("limits flow to within 3R and is identical without obstacles", () => {
    const rake = RAKE_BY_ID.onami;
    const stone = { x: 60.5, y: 50.5, rx: 7, ry: 5 };
    const off = createSandGrid();
    const on = createSandGrid();
    rebuildRockMask(off, [stone]);
    rebuildRockMask(on, [stone]);
    runStroke(off, [{ x: 30.5, y: 55.5 }, { x: 104.5, y: 55.5 }], rake.id, { stones: [stone], flow: false });
    runStroke(on, [{ x: 30.5, y: 55.5 }, { x: 104.5, y: 55.5 }], rake.id, { stones: [stone], flow: true });
    expect(sandHash(on)).not.toBe(sandHash(off));
    for (let i = 0; i < SAND_CELLS; i++) {
      const nx = (i % on.w + 0.5 - stone.x) / (stone.rx + 1);
      const ny = (Math.floor(i / on.w) + 0.5 - stone.y) / (stone.ry + 1);
      if (nx * nx + ny * ny >= 9 && (on.height[i] !== off.height[i] || on.dir[i] !== off.dir[i])) {
        throw new Error(`Flow affected distant cell ${i}`);
      }
    }

    const noStones = createSandGrid();
    const noFlow = createSandGrid();
    const points = [{ x: 15, y: 30 }, { x: 89, y: 56 }, { x: 104, y: 73 }];
    runStroke(noStones, points, rake.id, { stones: [], flow: true });
    runStroke(noFlow, points, rake.id);
    sameGrid(noStones, noFlow);
  });

  it("sweeps monotonically, levels newly crossed cells, and leaves rocks and later scratches alone", () => {
    const elapsed = fc.integer({ min: -500, max: 3000 });
    fc.assert(fc.property(elapsed, elapsed, fc.integer({ min: 0, max: SAND_H }), (a, b, y) => {
      expect(sweepFront(Math.min(a, b), y)).toBeLessThanOrEqual(sweepFront(Math.max(a, b), y));
    }));
    const full = createSandGrid();
    rebuildRockMask(full, [STONE]);
    full.height.fill(-3);
    full.dir.fill(6);
    const incremental = cloneSandGrid(full);
    applySweep(full, 0, 2400);
    applySweep(incremental, 0, 1200);
    for (let y = 0; y < incremental.h; y++) {
      for (let x = 0; x < incremental.w; x++) {
        const i = y * incremental.w + x;
        const expected = !incremental.rock[i] && x + 0.5 <= sweepFront(1200, y + 0.5);
        if (incremental.height[i] !== (expected ? 0 : -3)) throw new Error(`Wrong sweep front at (${x}, ${y})`);
      }
    }
    applySweep(incremental, 1200, 2400);
    sameGrid(incremental, full);
    for (let i = 0; i < SAND_CELLS; i++) {
      const rock = full.rock[i] !== 0;
      if (full.height[i] !== (rock ? -3 : 0) || full.dir[i] !== (rock ? 6 : DIR_UNRAKED)) {
        throw new Error(`Wrong final sweep state at ${i}`);
      }
    }
    incremental.height[0] = 2;
    expect(applySweep(incremental, 2400, 2500)).toBeNull();
    expect(incremental.height[0]).toBe(2);
  });
});

describe("garden state", () => {
  it("reverses mixed stroke and snapshot actions byte for byte, retaining only the last 32", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 34, maxLength: 40 }), actions => {
      const history = new UndoStack();
      const state = createGarden();
      const states = [cloneGarden(state)];
      for (const [i, action] of actions.entries()) {
        const before = states.at(-1)!;
        if (action === 0) {
          state.elements = state.elements.length ? [] : [{ ...STONE, x: 85 + i }];
          rebuildRockMask(state.sand, state.elements);
          history.pushSnapshot(before, state);
        } else {
          const y = 5 + i * 2.5;
          const { patch } = runStroke(state.sand, [{ x: 5.5, y }, { x: 70.5, y }], "take");
          history.pushStroke(patch);
        }
        states.push(cloneGarden(state));
        expect(history.undoCount).toBe(Math.min(i + 1, 32));
      }
      for (let i = actions.length - 1; i >= actions.length - 32; i--) {
        expect(history.undo(state)).toBe(true);
        sameGarden(state, states[i]!);
      }
      expect(history.undo(state)).toBe(false);
      expect(history.redoCount).toBe(32);
      for (let i = actions.length - 31; i <= actions.length; i++) {
        expect(history.redo(state)).toBe(true);
        sameGarden(state, states[i]!);
      }
      expect(history.redo(state)).toBe(false);

      history.undo(state);
      const prior = cloneGarden(state);
      state.sand.height[0] = 3;
      history.pushSnapshot(prior, state);
      expect(history.redoCount).toBe(0);
    }), { numRuns: 8 });
  });

  it("records placement, movement, removal, sweep and preset actions without replacing the live grid", () => {
    const store = createGardenStore(createGarden());
    const grid = store.garden.sand;
    const { patch } = runStroke(grid, [{ x: 75.5, y: 50.5 }, { x: 115.5, y: 50.5 }], "take");
    store.commitStroke(patch);
    const lined = store.snapshot();
    expect(store.placeElement(STONE)).toBe(true);
    expect(grid.height[50 * grid.w + 90]).toBe(0);
    expect(grid.rock[50 * grid.w + 90]).toBe(1);
    const placed = store.snapshot();
    expect(store.moveElement(STONE.id, 104.1, 47.8)).toBe(true);
    expect(store.garden.elements[0]).toMatchObject({ x: 104, y: 48 });
    expect(store.removeElement(STONE.id)).toBe(true);
    const removed = store.snapshot();
    expect(store.sweep()).toBe(true);
    store.loadPreset("three_islands");
    expect(store.garden.elements).toHaveLength(3);
    expect(store.garden.sand).toBe(grid);
    store.undo();
    expect(sandHash(grid)).toBe(PRESET_GOLDEN_HASHES.still_sand);
    store.undo();
    sameGarden(store.garden, removed);
    store.undo();
    store.undo();
    sameGarden(store.garden, placed);
    store.undo();
    sameGarden(store.garden, lined);
    store.undo();
    sameGarden(store.garden, createGarden());
  });

  it("round-trips both compressible and noisy gardens within 64 KB", () => {
    const dir = [0, 1, 2, 3, 4, 5, 6, 7, DIR_UNRAKED];
    const elements = fc.uniqueArray(fc.record({
      id: fc.uuid(),
      kind: fc.constantFrom(...Object.keys(ELEMENT_FOOTPRINTS) as ElementInstance["kind"][]),
      x: fc.integer({ min: 0, max: SAND_W - 1 }),
      y: fc.integer({ min: 0, max: SAND_H - 1 }),
      rotation: fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
    }), { selector: item => item.id, maxLength: 12 });
    fc.assert(fc.property(fc.integer(), elements, (seed, placed) => {
      const garden = createGarden();
      garden.elements = placed.map(element => ({
        ...element, rx: ELEMENT_FOOTPRINTS[element.kind].rx, ry: ELEMENT_FOOTPRINTS[element.kind].ry,
      }));
      rebuildRockMask(garden.sand, garden.elements);
      for (let i = 0; i < SAND_CELLS; i++) {
        // Deterministic, high-entropy changes exercise RLE's literal packets.
        seed = Math.imul(seed, 1664525) + 1013904223 | 0;
        garden.sand.height[i] = (seed >>> 16) % 7 - 3;
        garden.sand.dir[i] = dir[(seed >>> 24) % dir.length]!;
      }
      const encoded = encodeGarden(garden);
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_GARDEN_BYTES);
      sameGarden(decodeGarden(encoded), garden);
    }), { numRuns: 20 });

    const garden = createGarden();
    garden.elements = Array.from({ length: 12 }, (_, i) => ({ ...STONE, id: `stone-${i}` }));
    rebuildRockMask(garden.sand, garden.elements);
    for (let i = 0; i < SAND_CELLS; i++) {
      garden.sand.height[i] = i % 7 - 3;
      garden.sand.dir[i] = dir[i % dir.length]!;
    }
    const encoded = encodeGarden(garden);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_GARDEN_BYTES);
    sameGarden(decodeGarden(encoded), garden);
  });

  it("recovers to a fresh garden for arbitrary, malformed and truncated saves", () => {
    const fresh = createGarden();
    const garden = createGarden();
    garden.elements = applyPreset(garden.sand, "three_islands");
    const encoded = encodeGarden(garden);
    const data = JSON.parse(encoded);
    const malformed = fc.oneof(
      fc.fullUnicodeString(),
      fc.integer({ min: 0, max: encoded.length - 1 }).map(n => encoded.slice(0, n)),
      fc.integer({ min: 0, max: data.sand.length - 4 }).map(n => JSON.stringify({ ...data, sand: data.sand.slice(0, n) })),
      fc.constantFrom("null", "[]", "undefined", JSON.stringify({ ...data, v: 2 }), "x".repeat(MAX_GARDEN_BYTES + 1)),
    );
    fc.assert(fc.property(malformed, input => sameGarden(decodeGarden(input), fresh)));
    sameGarden(decodeGarden(JSON.stringify({ ...data, elements: [{ ...STONE, kind: "toString" }] })), fresh);
    const blank = encodeGarden(fresh);
    const payload = JSON.parse(blank);
    const bad = atob(payload.sand);
    // The first RLE packet must contain a sand height.
    payload.sand = btoa(bad[0]! + String.fromCharCode(4) + bad.slice(2));
    sameGarden(decodeGarden(JSON.stringify(payload)), fresh);
  });

  it("round-trips settings, validates fields and supplies independent defaults", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      rake: "mikazuki",
      moodSetting: "dusk",
      cameraPreset: "porch",
      gubbaVariant: "lantern",
      density: "chunky",
      breathEnabled: true,
      breathPattern: "box",
      mix: { master: 0, music: 7, foley: 4, ambience: 1, muted: true },
      talkMode: "quiet",
      rain: true,
      flow: false,
      heardStories: { mikazuki: 2, sugi: 3 },
    } as const;
    expect(decodeSettings(encodeSettings(settings))).toEqual(settings);
    expect(decodeSettings('{"v":1,"rake":"missing","flow":"off","mix":{"master":9,"muted":true}}')).toEqual({
      ...DEFAULT_SETTINGS, mix: { ...DEFAULT_SETTINGS.mix, muted: true },
    });
    const fallback = decodeSettings("[");
    expect(fallback).toEqual(DEFAULT_SETTINGS);
    fallback.mix.master = 0;
    expect(decodeSettings("null")).toEqual(DEFAULT_SETTINGS);
  });

  it("replays every preset within the bed and matches its saved golden hash", () => {
    for (const id of Object.keys(PRESETS) as PresetId[]) {
      const grid = createSandGrid();
      grid.height.fill(3);
      grid.dir.fill(7);
      grid.rock.fill(1);
      const elements = applyPreset(grid, id);
      expect(elements).toEqual(PRESETS[id].elements);
      expect(sandHash(grid)).toBe(PRESET_GOLDEN_HASHES[id]);
      const expectedMask = createSandGrid();
      rebuildRockMask(expectedMask, elements);
      sameBytes(grid.rock, expectedMask.rock);
      for (const { x, y } of PRESETS[id].strokes.flatMap(stroke => stroke.points)) {
        if (x < 0 || x > SAND_W || y < 0 || y > SAND_H) throw new Error(`Out-of-bounds point in ${id}`);
      }
      for (let i = 0; i < SAND_CELLS; i++) {
        if (grid.rock[i] && (grid.height[i] !== 0 || grid.dir[i] !== DIR_UNRAKED)) {
          throw new Error(`Preset ${id} raked rock at ${i}`);
        }
      }
    }
    expect(PRESETS.three_islands.elements.map(element => element.kind.startsWith("stone_"))).toEqual([true, true, true]);
  });
});
