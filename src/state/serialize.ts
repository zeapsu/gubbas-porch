import { RAKES } from "../rakes/index.ts";
import { createSandGrid, rebuildRockMask, SAND_CELLS, SAND_H, SAND_W } from "../sand/index.ts";
import { DEFAULT_SETTINGS, ELEMENT_FOOTPRINTS } from "./types.ts";
import type { ElementInstance, GardenState, SettingsState } from "./types.ts";

export const GARDEN_STORAGE_KEY = "rake-me:garden:v1";
export const SETTINGS_STORAGE_KEY = "rake-me:settings:v1";
export const MAX_GARDEN_BYTES = 64 * 1024;
export const MAX_GARDEN_ELEMENTS = 12;

const HEIGHT_AND_DIR_BYTES = 2 * SAND_CELLS;
const LITERAL_LIMIT = 128;
const RUN_LIMIT = 130;

export function createGarden(): GardenState {
  return { v: 1, sand: createSandGrid(), elements: [] };
}

export function isGardenElement(value: unknown): value is ElementInstance {
  if (typeof value !== "object" || value === null) return false;
  const element = value as Partial<ElementInstance>;
  const { id, kind, x, y, rx, ry, rotation } = element;
  return typeof id === "string" && id.length > 0
    && typeof kind === "string" && Object.hasOwn(ELEMENT_FOOTPRINTS, kind)
    && typeof x === "number" && x >= 0 && x < SAND_W
    && typeof y === "number" && y >= 0 && y < SAND_H
    && typeof rx === "number" && Number.isFinite(rx) && rx > 0
    && typeof ry === "number" && Number.isFinite(ry) && ry > 0
    && typeof rotation === "number" && Number.isFinite(rotation);
}

// High-bit headers repeat the next byte 3–130 times. Other headers copy
// 1–128 literal bytes so even sand with no repeated values fits the budget.
function pack(input: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let start = 0; start < input.length;) {
    let run = 1;
    while (run < RUN_LIMIT && start + run < input.length && input[start + run] === input[start]) run++;
    if (run >= 3) {
      output.push(0x80 | (run - 3), input[start]!);
      start += run;
      continue;
    }

    let end = start + 1;
    while (end < input.length && end - start < LITERAL_LIMIT) {
      if (end + 2 < input.length && input[end] === input[end + 1] && input[end] === input[end + 2]) break;
      end++;
    }
    output.push(end - start - 1);
    for (; start < end; start++) output.push(input[start]!);
  }
  return Uint8Array.from(output);
}

function unpack(encoded: string): Uint8Array | null {
  const input = atob(encoded);
  const output = new Uint8Array(HEIGHT_AND_DIR_BYTES);
  let offset = 0;
  for (let index = 0; index < input.length;) {
    const header = input.charCodeAt(index++);
    const repeated = (header & 0x80) !== 0;
    const count = (header & 0x7f) + (repeated ? 3 : 1);
    if (offset + count > output.length || index + (repeated ? 1 : count) > input.length) return null;
    if (repeated) {
      output.fill(input.charCodeAt(index++), offset, offset + count);
      offset += count;
    } else {
      for (let copied = 0; copied < count; copied++) output[offset++] = input.charCodeAt(index++);
    }
  }
  return offset === output.length ? output : null;
}

export function encodeGarden(state: GardenState): string {
  const bytes = new Uint8Array(HEIGHT_AND_DIR_BYTES);
  bytes.set(state.sand.height);
  bytes.set(state.sand.dir, SAND_CELLS);
  const binary = String.fromCharCode(...pack(bytes));
  const elements = state.elements.map(({ id, kind, x, y, rx, ry, rotation }) => ({ id, kind, x, y, rx, ry, rotation }));
  const text = JSON.stringify({ v: 1, elements, sand: btoa(binary) });
  if (new TextEncoder().encode(text).length > MAX_GARDEN_BYTES) {
    throw new RangeError("Garden save exceeds 64 KB");
  }
  return text;
}

export function decodeGarden(text: string): GardenState {
  const garden = createGarden();
  try {
    if (text.length > MAX_GARDEN_BYTES || new TextEncoder().encode(text).length > MAX_GARDEN_BYTES) return garden;
    const payload = JSON.parse(text);
    if (payload?.v !== 1 || typeof payload.sand !== "string" || !Array.isArray(payload.elements)
      || payload.elements.length > MAX_GARDEN_ELEMENTS || !payload.elements.every(isGardenElement)) return garden;
    const elements: ElementInstance[] = payload.elements;
    if (new Set(elements.map(element => element.id)).size !== elements.length) return garden;
    const bytes = unpack(payload.sand);
    if (!bytes) return garden;

    for (let index = 0; index < SAND_CELLS; index++) {
      const height = bytes[index]!;
      const dir = bytes[SAND_CELLS + index]!;
      if ((height > 3 && height < 253) || (dir > 7 && dir !== 255)) return garden;
    }
    garden.sand.height.set(bytes.subarray(0, SAND_CELLS));
    garden.sand.dir.set(bytes.subarray(SAND_CELLS));
    garden.elements = elements.map(({ id, kind, x, y, rx, ry, rotation }) => ({ id, kind, x, y, rx, ry, rotation }));
    rebuildRockMask(garden.sand, garden.elements);
  } catch {
    return createGarden();
  }
  return garden;
}

export function encodeSettings(settings: SettingsState): string {
  return JSON.stringify(settings);
}

export function decodeSettings(text: string): SettingsState {
  const defaults = { ...DEFAULT_SETTINGS, mix: { ...DEFAULT_SETTINGS.mix }, heardStories: {} };
  try {
    const data = JSON.parse(text);
    if (data?.v !== 1) return defaults;
    const choose = <T extends string>(value: unknown, choices: readonly T[], fallback: T): T =>
      choices.find(choice => choice === value) ?? fallback;
    const toggle = (value: unknown, fallback: boolean): boolean => typeof value === "boolean" ? value : fallback;
    const level = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 7 ? value : fallback;

    const heardStories: SettingsState["heardStories"] = {};
    for (const { id } of RAKES) {
      const count = data.heardStories?.[id];
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) heardStories[id] = count;
    }
    return {
      v: 1,
      rake: choose(data.rake, RAKES.map(rake => rake.id), defaults.rake),
      moodSetting: choose(data.moodSetting, ["auto", "morning", "afternoon", "dusk", "moonlit"], defaults.moodSetting),
      gubbaVariant: choose(data.gubbaVariant, ["moss", "kasa", "lantern"], defaults.gubbaVariant),
      cameraPreset: choose(data.cameraPreset, ["cozy", "topdown", "porch"], defaults.cameraPreset),
      density: choose(data.density, ["crisp", "chunky"], defaults.density),
      breathEnabled: toggle(data.breathEnabled, defaults.breathEnabled),
      breathPattern: choose(data.breathPattern, ["4-4-6", "4-7-8", "box"], defaults.breathPattern),
      talkMode: choose(data.talkMode, ["quiet", "sometimes", "companion"], defaults.talkMode),
      rain: toggle(data.rain, defaults.rain),
      flow: toggle(data.flow, defaults.flow),
      mix: {
        master: level(data.mix?.master, defaults.mix.master),
        music: level(data.mix?.music, defaults.mix.music),
        foley: level(data.mix?.foley, defaults.mix.foley),
        ambience: level(data.mix?.ambience, defaults.mix.ambience),
        muted: toggle(data.mix?.muted, defaults.mix.muted),
      },
      heardStories,
    };
  } catch {
    return defaults;
  }
}
