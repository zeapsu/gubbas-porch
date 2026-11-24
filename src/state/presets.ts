import { createStrokeEngine, RAKE_BY_ID } from "../rakes/index.ts";
import { clearSandGrid, rebuildRockMask, SAND_H, SAND_W } from "../sand/index.ts";
import type { SandGrid } from "../sand/index.ts";
import { ELEMENT_FOOTPRINTS } from "./types.ts";
import type { ElementInstance, ElementKind, PresetId, RakeId, Vec2 } from "./types.ts";

export interface PresetStroke {
  rake: RakeId;
  points: readonly Vec2[];
}

export interface GardenPreset {
  elements: readonly ElementInstance[];
  strokes: readonly PresetStroke[];
}

function element(id: string, kind: ElementKind, x: number, y: number): ElementInstance {
  const { rx, ry } = ELEMENT_FOOTPRINTS[kind];
  return { id, kind, x, y, rx, ry, rotation: 0 };
}

function rows(rake: RakeId, spacing: number, start: number): PresetStroke[] {
  const strokes: PresetStroke[] = [];
  for (let y = start; y < SAND_H; y += spacing) {
    strokes.push({ rake, points: [{ x: 0, y }, { x: SAND_W, y }] });
  }
  return strokes;
}

function ring(rake: RakeId, x: number, y: number, radius: number): PresetStroke {
  const count = Math.ceil(2 * Math.PI * radius);
  const points = Array.from({ length: count + 1 }, (_, i) => {
    const angle = i / count * 2 * Math.PI;
    return { x: x + radius * Math.cos(angle), y: y + radius * Math.sin(angle) };
  });
  return { rake, points };
}

function river(): PresetStroke[] {
  const strokes: PresetStroke[] = [];
  for (const offset of [14, 42, 70, 98]) {
    const points = Array.from({ length: SAND_W + 1 }, (_, x) => ({
      x,
      y: offset + 13 * Math.sin(x * 2 * Math.PI / SAND_W),
    }));
    strokes.push({ rake: "onami", points });
  }
  return strokes;
}

function spiral(): PresetStroke {
  const points = Array.from({ length: 900 }, (_, i) => {
    const progress = i / 899;
    const angle = progress * 12 * Math.PI;
    return {
      x: SAND_W / 2 + 48 * progress * Math.cos(angle),
      y: SAND_H / 2 + 48 * progress * Math.sin(angle),
    };
  });
  return { rake: "take", points };
}

function checker(): PresetStroke[] {
  const strokes: PresetStroke[] = [];
  const tileWidth = 24;
  const tileHeight = 28;
  for (let row = 0; row < SAND_H / tileHeight; row++) {
    for (let col = 0; col < SAND_W / tileWidth; col++) {
      const x = col * tileWidth;
      const y = row * tileHeight;
      if ((row + col) % 2 === 0) {
        for (const offset of [10, 18]) {
          strokes.push({ rake: "sugi", points: [{ x: x + 0.5, y: y + offset }, { x: x + 23.5, y: y + offset }] });
        }
      } else {
        for (const offset of [10, 14]) {
          strokes.push({ rake: "sugi", points: [{ x: x + offset, y: y + 0.5 }, { x: x + offset, y: y + 27.5 }] });
        }
      }
    }
  }
  return strokes;
}

export const PRESETS: Readonly<Record<PresetId, GardenPreset>> = {
  still_sand: { elements: [], strokes: [] },
  three_islands: {
    elements: [
      element("island-west", "stone_l", 52, 54),
      element("island-north", "stone_tall", 166, 32),
      element("island-south", "stone_m", 132, 80),
    ],
    strokes: [
      ...rows("sugi", 20, 8.5),
      ring("sugi", 52, 54, 24),
      ring("sugi", 166, 32, 20),
      ring("sugi", 132, 80, 18),
    ],
  },
  ripple_pond: {
    elements: [element("pond", "stone_m", 96, 56)],
    strokes: [14, 26, 38].map(radius => ring("wa", 96, 56, radius))
      .concat(ring("sugi", 96, 56, 50)),
  },
  old_sea: { elements: [], strokes: rows("mikazuki", 19, 5.5) },
  river_bend: {
    elements: [element("river-west", "stone_m", 54, 52), element("river-east", "stone_flat", 136, 58)],
    strokes: river(),
  },
  snails_thought: { elements: [], strokes: [spiral()] },
  checker_field: { elements: [], strokes: checker() },
};

export function applyPreset(grid: SandGrid, presetId: PresetId): ElementInstance[] {
  const { elements, strokes } = PRESETS[presetId];
  clearSandGrid(grid);
  rebuildRockMask(grid, elements);
  const engine = createStrokeEngine(grid);
  for (const { rake, points } of strokes) {
    const first = points[0];
    if (!first) continue;
    engine.begin(first, RAKE_BY_ID[rake], "mouse", { stones: elements, flow: true });
    engine.extend(points, 0);
    engine.end();
  }
  return elements.map(placed => ({ ...placed }));
}

export const PRESET_GOLDEN_HASHES: Readonly<Record<PresetId, number>> = {
  still_sand: 0xb23a71c5,
  three_islands: 0x5759828d,
  ripple_pond: 0xa597d0e9,
  old_sea: 0xf9198db1,
  river_bend: 0xdf6dd12c,
  snails_thought: 0x5fb27ec9,
  checker_field: 0x4468d9c5,
};
