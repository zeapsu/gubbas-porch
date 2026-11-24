import {
  AUTO_CMD,
  autoBegin,
  autoEnableLoop,
  autoPlanRake,
  autoPoll,
  autoTick,
  autoYield,
  createAutoBag,
  createAutoState,
  drawAutoBag,
  planStones,
} from "../gubba/index.ts";
import type { AutoState, AutoStroke, AutoWorld, StoneOp } from "../gubba/index.ts";
import { createStrokeEngine, RAKE_BY_ID } from "../rakes/index.ts";
import type { StrokeTelemetry } from "../rakes/index.ts";
import { applySweep, SAND_CELLS, sandHash, SWEEP_DURATION_MS } from "../sand/index.ts";
import type { SandFootprint, SandRect } from "../sand/index.ts";
import { applyPreset, ELEMENT_FOOTPRINTS, planSand, PRESET_GOLDEN_HASHES, PRESETS } from "../state/index.ts";
import type { GardenStore, SandPlan } from "../state/index.ts";
import type { ElementInstance, GardenState, GubbaVariant, PresetId, RakeId, Vec2 } from "../state/types.ts";

/**
 * Carries out what the Gubba director asks for (Gubba mode and "Watch: Gubba rakes"): the director says where
 * Gubba is and what he does next, and this applies each step to the real garden with the same stroke engine,
 * sweep and stone edits the player uses.
 *
 * Undo and saving. Gubba's edits never reach the undo history one by one: strokes are not committed, stones
 * move through the store's silent path, and the sweep writes the grid. A run instead remembers the garden as
 * the player left it (`before`) and is committed as a single entry when it closes: when the player takes
 * over, or when a one-off "Watch" garden is finished. While a run is open, `before` is what should be saved.
 *
 * Everything outside the garden (sound, uploads, Gubba's lines) goes through the sink, so this runs the same in
 * the browser and in unit tests. The per-frame path allocates nothing.
 */

export interface AutoRunnerSink {
  /** Cells of sand changed. */
  sandDirty(rect: SandRect | null): void;
  /** The whole grid or the stones changed. */
  sandReset(): void;
  rakeClack(): void;
  stoneThud(): void;
  sweepWhoosh(seconds: number): void;
  /** Rake foley for Gubba's own stroke; null when the rake lifts. `screenX` is 0…1 across the bed. */
  foley(telemetry: StrokeTelemetry | null, screenX: number): void;
  /** A moment Gubba may remark on (his talk mode still decides whether he does). */
  line(pool: "auto_start" | "auto_done" | "auto_yield"): void;
  /** Gubba mode, the garden to save or the undo history changed. */
  changed(): void;
}

export interface AutoRunner {
  readonly state: AutoState;
  /** Gubba mode is on: he rakes one garden after another until the player edits. */
  readonly mode: boolean;
  /** The preset he is building, or null. */
  readonly target: PresetId | null;
  /** The garden as the player left it, while a run is open: this, not the live garden, is what to save. */
  readonly before: GardenState | null;
  /** How the last run cleared old marks, or null before the first plan. */
  readonly sandPlan: SandPlan["kind"] | null;
  /** Cells the last seal had to correct. */
  readonly lastSealDiffCells: number;
  readonly cyclesCompleted: number;
  /** Turns Gubba mode on or off. Turning it off sends him home, as a player edit does. */
  setMode(on: boolean, playerRake: RakeId, reducedMotion: boolean): void;
  /**
   * Asks for one preset: the next garden in Gubba mode, otherwise a single run that ends seated. Returns false
   * when the garden already is that preset and there is nothing to do.
   */
  request(preset: PresetId, reducedMotion: boolean): boolean;
  /**
   * The player is editing: closes the run as one undo entry, turns Gubba mode off and sends him home. A rake
   * he holds that the player has selected goes straight to their hand. Returns true if a run was open.
   */
  yield(playerRake: RakeId): boolean;
  tick(dtMs: number, variant: GubbaVariant, reducedMotion: boolean): void;
}

const NO_OPS: readonly StoneOp[] = [];
const NO_STROKES: readonly AutoStroke[] = [];

export function createAutoRunner(store: GardenStore, world: AutoWorld, sink: AutoRunnerSink, seed: number): AutoRunner {
  const state = createAutoState(world, seed);
  const bag = createAutoBag(seed);
  const engine = createStrokeEngine(store.garden.sand);
  const strokeCtx: { stones: readonly SandFootprint[]; flow: boolean } = { stones: store.garden.elements, flow: true };
  const pool: Vec2[] = Array.from({ length: state.cmdKind.length }, () => ({ x: 0, y: 0 }));
  const batch: Vec2[] = [];
  const sweepRect: SandRect = { x: 0, y: 0, w: 0, h: 0 };
  const sealHeight = new Int8Array(SAND_CELLS);
  const sealDir = new Uint8Array(SAND_CELLS);

  let mode = false;
  let target: PresetId | null = null;
  let run: { before: GardenState; dirty: boolean } | null = null;
  let stepped = false;
  let ops: readonly StoneOp[] = NO_OPS;
  let strokes: readonly AutoStroke[] = NO_STROKES;
  let strokeOpen = false;
  let used = 0;
  let sweepPrevMs = 0;
  let sandPlan: SandPlan["kind"] | null = null;
  let lastSealDiffCells = 0;
  let cyclesCompleted = 0;

  function touch(): void {
    if (run) run.dirty = true;
  }

  /** True when the garden already is this preset: the same stones and the golden sand. */
  function matches(id: PresetId): boolean {
    const want = PRESETS[id].elements;
    const have = store.garden.elements;
    return (
      have.length === want.length &&
      planStones(have, want, 0, 0).length === 0 &&
      sandHash(store.garden.sand) === PRESET_GOLDEN_HASHES[id]
    );
  }

  function closeStroke(): void {
    if (!strokeOpen) return;
    strokeOpen = false;
    batch.length = 0;
    const patch = engine.end();
    if (patch.rect.w > 0 && patch.rect.h > 0) {
      touch();
      sink.sandDirty(patch.rect);
    }
    sink.foley(null, 0.5);
  }

  function flush(dtMs: number): void {
    if (!strokeOpen || batch.length === 0) return;
    const tel = engine.extend(batch, dtMs);
    batch.length = 0;
    // the head goes round stones; the rake Gubba holds follows the real head, not the plan
    state.tipX = tel.head.x - 96;
    state.tipZ = tel.head.y - 56;
    if (tel.dirtyRect) {
      touch();
      sink.sandDirty(tel.dirtyRect);
    }
    sink.foley(tel, Math.max(0, Math.min(1, tel.head.x / 192)));
  }

  function wholeStroke(stroke: AutoStroke | undefined): void {
    const first = stroke?.points[0];
    if (!stroke || !first) return;
    strokeCtx.stones = store.garden.elements;
    engine.begin(first, RAKE_BY_ID[stroke.rake], "mouse", strokeCtx);
    engine.extend(stroke.points, 0);
    const patch = engine.end();
    if (patch.rect.w > 0 && patch.rect.h > 0) {
      touch();
      sink.sandDirty(patch.rect);
    }
  }

  function setStone(op: StoneOp, id: string): void {
    let free = id;
    for (let n = 1; store.garden.elements.some((e) => e.id === free); n++) free = `${id}-g${n}`;
    const { rx, ry } = ELEMENT_FOOTPRINTS[op.kind];
    if (store.silent.place({ id: free, kind: op.kind, x: op.toX, y: op.toY, rx, ry, rotation: 0 })) {
      touch();
      sink.sandReset();
    }
  }

  function liftStone(op: StoneOp): void {
    if (store.silent.remove(op.id)) {
      touch();
      sink.sandReset();
    }
  }

  /** Makes the sand exactly the preset. By now it all but is, so nothing is seen to change. */
  function seal(): void {
    if (target === null) return;
    const sand = store.garden.sand;
    const want = PRESETS[target].elements;
    const have: readonly ElementInstance[] = store.garden.elements;
    let stones = have.length === want.length;
    for (let i = 0; stones && i < want.length; i++) {
      const h = have[i];
      const w = want[i];
      stones = h !== undefined && w !== undefined && h.id === w.id && h.kind === w.kind && h.x === w.x && h.y === w.y;
    }
    sealHeight.set(sand.height);
    sealDir.set(sand.dir);
    store.garden.elements = applyPreset(sand, target);
    let diff = 0;
    for (let i = 0; i < SAND_CELLS; i++) {
      if (sealHeight[i] !== sand.height[i] || sealDir[i] !== sand.dir[i]) diff++;
    }
    lastSealDiffCells = diff;
    if (diff > 0 || !stones) {
      touch();
      sink.sandReset();
    }
  }

  function begin(id: PresetId, reducedMotion: boolean): void {
    closeStroke();
    target = id;
    stepped = reducedMotion;
    if (!run) run = { before: store.snapshot(), dirty: false };
    strokes = NO_STROKES;
    if (matches(id)) {
      ops = NO_OPS;
      autoBegin(state, ops, stepped, mode, true);
      return;
    }
    ops = planStones(store.garden.elements, PRESETS[id].elements, state.x + 96, state.z + 56);
    autoBegin(state, ops, stepped, mode);
  }

  function stop(playerRake: RakeId, remark: boolean): void {
    closeStroke();
    if (run?.dirty) store.commitSnapshot(run.before);
    run = null;
    mode = false;
    target = null;
    autoYield(state, state.rake !== null && state.rake === playerRake);
    if (remark) sink.line("auto_yield");
    sink.changed();
  }

  function handle(cmd: number, dtMs: number): void {
    const x = state.cmdX;
    switch (cmd) {
      case AUTO_CMD.STONE_LIFT: {
        const op = ops[x];
        if (op) liftStone(op);
        break;
      }
      case AUTO_CMD.STONE_SET: {
        const op = ops[x];
        if (op) {
          setStone(op, op.id);
          sink.stoneThud();
        }
        break;
      }
      case AUTO_CMD.STONE_BASKET:
        sink.stoneThud();
        break;
      case AUTO_CMD.STONE_WHOLE: {
        const op = ops[x];
        if (!op) break;
        if (op.type !== "place") liftStone(op);
        if (op.type !== "remove") setStone(op, op.id);
        sink.stoneThud();
        break;
      }
      case AUTO_CMD.PLAN_SAND: {
        if (target === null) break;
        const plan = planSand(store.garden.sand, target);
        sandPlan = plan.kind;
        const own = PRESETS[target].strokes;
        strokes = plan.strokes.length > 0 ? [...plan.strokes, ...own] : own;
        autoPlanRake(state, plan.kind, strokes, plan.strokes.length);
        break;
      }
      case AUTO_CMD.RAKE_TAKE:
      case AUTO_CMD.RAKE_HANG:
        sink.rakeClack();
        break;
      case AUTO_CMD.STROKE_BEGIN: {
        const stroke = strokes[x];
        const first = stroke?.points[0];
        if (!stroke || !first) break;
        strokeCtx.stones = store.garden.elements;
        // as `applyPreset` begins it, so the same cells are written
        engine.begin(first, RAKE_BY_ID[stroke.rake], "mouse", strokeCtx);
        strokeOpen = true;
        batch.length = 0;
        break;
      }
      case AUTO_CMD.STROKE_TO: {
        const p = pool[used++];
        if (!strokeOpen || !p) break;
        p.x = x;
        p.y = state.cmdY;
        batch.push(p);
        break;
      }
      case AUTO_CMD.STROKE_END:
        flush(dtMs);
        closeStroke();
        break;
      case AUTO_CMD.STROKE_WHOLE:
        wholeStroke(strokes[x]);
        break;
      case AUTO_CMD.SWEEP_BEGIN:
        sweepPrevMs = 0;
        sink.sweepWhoosh(9.5);
        break;
      case AUTO_CMD.SWEEP_TO: {
        const nextMs = x * SWEEP_DURATION_MS;
        const rect = applySweep(store.garden.sand, sweepPrevMs, nextMs, sweepRect);
        sweepPrevMs = nextMs;
        if (rect) {
          touch();
          sink.sandDirty(rect);
        }
        break;
      }
      case AUTO_CMD.SWEEP_WHOLE:
        if (applySweep(store.garden.sand, 0, SWEEP_DURATION_MS, sweepRect)) {
          touch();
          sink.sandReset();
        }
        sink.sweepWhoosh(0.4);
        break;
      case AUTO_CMD.SEAL:
        seal();
        break;
      case AUTO_CMD.DONE:
        cyclesCompleted++;
        sink.line("auto_done");
        if (!mode) {
          // a one-off "Watch" garden: one undo entry, and he stays seated
          if (run?.dirty) store.commitSnapshot(run.before);
          run = null;
          target = null;
          sink.changed();
        }
        break;
      case AUTO_CMD.NEXT:
        if (mode) begin(drawAutoBag(bag, matches), stepped);
        break;
      default:
        break;
    }
  }

  return {
    state,
    get mode() {
      return mode;
    },
    get target() {
      return target;
    },
    get before() {
      return run ? run.before : null;
    },
    get sandPlan() {
      return sandPlan;
    },
    get lastSealDiffCells() {
      return lastSealDiffCells;
    },
    get cyclesCompleted() {
      return cyclesCompleted;
    },
    setMode(on, playerRake, reducedMotion) {
      if (on === mode) return;
      if (!on) {
        stop(playerRake, false);
        return;
      }
      mode = true;
      sink.line("auto_start");
      // a one-off garden already under way carries on without restarting, and now leads into the next
      if (target !== null && run !== null && !state.yielding && state.working) {
        autoEnableLoop(state);
      } else {
        begin(target !== null && run !== null ? target : drawAutoBag(bag, matches), reducedMotion);
      }
      sink.changed();
    },
    request(preset, reducedMotion) {
      if (!mode) {
        if (!state.working && matches(preset)) return false;
        if (run === null) sink.line("auto_start");
      }
      begin(preset, reducedMotion);
      sink.changed();
      return true;
    },
    yield(playerRake) {
      if (!mode && run === null) {
        // already on his way home: a rake the player has just chosen leaves his hands at once
        if (state.yielding && state.rake !== null && state.rake === playerRake) autoYield(state, true);
        return false;
      }
      stop(playerRake, true);
      return true;
    },
    tick(dtMs, variant, reducedMotion) {
      state.variant = variant;
      autoTick(state, dtMs, store.garden.elements);
      used = 0;
      for (let cmd = autoPoll(state); cmd !== AUTO_CMD.NONE; cmd = autoPoll(state)) handle(cmd, dtMs);
      flush(dtMs);
      // reduced motion switched on mid-run takes effect with the next garden
      if (mode && state.phase === 5) stepped = reducedMotion;
    },
  };
}
