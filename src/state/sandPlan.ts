import { createStrokeEngine, RAKE_BY_ID } from "../rakes/index.ts";
import { cloneSandGrid, createSandGrid, DIR_UNRAKED, rebuildRockMask, SAND_CELLS, SAND_H, SAND_W } from "../sand/index.ts";
import type { SandGrid } from "../sand/index.ts";
import { PRESETS } from "./presets.ts";
import type { PresetStroke } from "./presets.ts";
import type { PresetId } from "./types.ts";

/**
 * What Gubba has to do to the sand before he rakes a preset over whatever is there now (Gubba mode and
 * "Watch: Gubba rakes").
 *
 * A preset's strokes write absolute heights, so every cell they touch ends as the preset wants it whatever it
 * held before. Only the cells they never touch keep old marks: the residue. With none, he rakes straight over.
 * A little of it is smoothed with a few passes of Nagi; anything more gets one sweep of the Hōki broom.
 */

/** Nagi is used only for residue it clears in at most this many passes … */
export const NAGI_MAX_LANES = 6;
/** … over at most this many cells of travel in all … */
export const NAGI_MAX_TRAVEL = 400;
/** … and only if the residue covers at most this share of the bed. */
export const NAGI_MAX_FRACTION = 0.2;

/** A height no rake profile can write (stamps clamp to ±3). */
const SENTINEL = 100;
const NAGI_WIDTH = RAKE_BY_ID.nagi.headWidth;

export interface SandPlan {
  kind: "none" | "nagi" | "sweep";
  /** Cells holding marks the preset's strokes would leave behind. */
  residueCells: number;
  /** Nagi passes that clear the residue (`kind === "nagi"`), else empty. */
  strokes: PresetStroke[];
}

const untouchedCache = new Map<PresetId, Uint8Array>();

function replay(grid: SandGrid, presetId: PresetId, strokes: readonly PresetStroke[]): void {
  const { elements } = PRESETS[presetId];
  const engine = createStrokeEngine(grid);
  for (const { rake, points } of strokes) {
    const first = points[0];
    if (!first) continue;
    engine.begin(first, RAKE_BY_ID[rake], "mouse", { stones: elements, flow: true });
    engine.extend(points, 0);
    engine.end();
  }
}

/**
 * 1 for each cell the preset's own strokes never write and none of its stones covers. Found by replaying the
 * strokes onto a grid filled with a sentinel; computed once per preset.
 */
export function presetUntouched(presetId: PresetId): Uint8Array {
  let mask = untouchedCache.get(presetId);
  if (mask) return mask;
  const scratch = createSandGrid();
  scratch.height.fill(SENTINEL);
  rebuildRockMask(scratch, PRESETS[presetId].elements);
  replay(scratch, presetId, PRESETS[presetId].strokes);
  mask = new Uint8Array(SAND_CELLS);
  for (let i = 0; i < SAND_CELLS; i++) {
    mask[i] = scratch.height[i] === SENTINEL && scratch.rock[i] === 0 ? 1 : 0;
  }
  untouchedCache.set(presetId, mask);
  return mask;
}

function isResidue(sand: SandGrid, untouched: Uint8Array, i: number): boolean {
  return untouched[i] === 1 && (sand.height[i] !== 0 || sand.dir[i] !== DIR_UNRAKED);
}

/** How many cells of `sand` would still show old marks after the preset is raked over it. */
export function countResidue(sand: SandGrid, presetId: PresetId): number {
  const untouched = presetUntouched(presetId);
  let n = 0;
  for (let i = 0; i < SAND_CELLS; i++) if (isResidue(sand, untouched, i)) n++;
  return n;
}

/** East-going Nagi passes, each as wide as the board, that between them cover every row holding residue. */
function nagiLanes(sand: SandGrid, untouched: Uint8Array): PresetStroke[] {
  const lanes: PresetStroke[] = [];
  let row = 0;
  while (row < SAND_H) {
    let rowHasResidue = false;
    for (let x = 0; x < SAND_W && !rowHasResidue; x++) rowHasResidue = isResidue(sand, untouched, row * SAND_W + x);
    if (!rowHasResidue) {
      row++;
      continue;
    }
    const top = Math.min(row, SAND_H - NAGI_WIDTH);
    let x0: number = SAND_W;
    let x1 = -1;
    for (let y = top; y < top + NAGI_WIDTH; y++) {
      for (let x = 0; x < SAND_W; x++) {
        if (!isResidue(sand, untouched, y * SAND_W + x)) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
    const y = top + NAGI_WIDTH / 2;
    lanes.push({
      rake: "nagi",
      points: [{ x: Math.max(0, x0 - 1), y }, { x: Math.min(SAND_W, x1 + 2), y }],
    });
    row = top + NAGI_WIDTH;
  }
  return lanes;
}

/**
 * Plans the smoothing for raking `presetId` over `sand`. `sand` must already hold the preset's stones (its rock
 * mask), which is the state Gubba leaves after moving them.
 */
export function planSand(sand: SandGrid, presetId: PresetId): SandPlan {
  const untouched = presetUntouched(presetId);
  let residueCells = 0;
  for (let i = 0; i < SAND_CELLS; i++) if (isResidue(sand, untouched, i)) residueCells++;
  if (residueCells === 0) return { kind: "none", residueCells, strokes: [] };

  const sweep: SandPlan = { kind: "sweep", residueCells, strokes: [] };
  if (residueCells > NAGI_MAX_FRACTION * SAND_CELLS) return sweep;
  const lanes = nagiLanes(sand, untouched);
  if (lanes.length > NAGI_MAX_LANES) return sweep;
  let travel = 0;
  for (const lane of lanes) travel += (lane.points[1]?.x ?? 0) - (lane.points[0]?.x ?? 0);
  if (travel > NAGI_MAX_TRAVEL) return sweep;

  // Nagi goes round stones as any rake does, so prove the passes leave nothing behind before choosing them
  const scratch = cloneSandGrid(sand);
  rebuildRockMask(scratch, PRESETS[presetId].elements);
  replay(scratch, presetId, lanes);
  for (let i = 0; i < SAND_CELLS; i++) if (isResidue(scratch, untouched, i)) return sweep;
  return { kind: "nagi", residueCells, strokes: lanes };
}
