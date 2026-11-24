import type { StrokePatch } from "../rakes/types.ts";
import { applySweep, DIR_UNRAKED, rebuildRockMask, SWEEP_DURATION_MS } from "../sand/index.ts";
import { applyPreset } from "./presets.ts";
import { createGarden, isGardenElement, MAX_GARDEN_ELEMENTS } from "./serialize.ts";
import { DEFAULT_SETTINGS, ELEMENT_FOOTPRINTS } from "./types.ts";
import type { ElementInstance, GardenState, PresetId, SettingsState } from "./types.ts";
import { cloneGarden, UndoStack } from "./undo.ts";

export type GardenStore = ReturnType<typeof createGardenStore>;

export function createGardenStore(
  garden: GardenState = createOpeningGarden(),
  settings: SettingsState = DEFAULT_SETTINGS,
) {
  const history = new UndoStack();
  const state = cloneGarden(garden);
  const preferences = { ...settings, mix: { ...settings.mix }, heardStories: { ...settings.heardStories } };

  function levelFootprint(element: ElementInstance): void {
    const grid = state.sand;
    const rx = element.rx + 1;
    const ry = element.ry + 1;
    const minX = Math.max(0, Math.ceil(element.x - rx - 0.5));
    const maxX = Math.min(grid.w - 1, Math.floor(element.x + rx - 0.5));
    const minY = Math.max(0, Math.ceil(element.y - ry - 0.5));
    const maxY = Math.min(grid.h - 1, Math.floor(element.y + ry - 0.5));
    for (let y = minY; y <= maxY; y++) {
      const dy = (y + 0.5 - element.y) / ry;
      for (let x = minX; x <= maxX; x++) {
        const dx = (x + 0.5 - element.x) / rx;
        const i = y * grid.w + x;
        if (dx * dx + dy * dy <= 1 && !grid.rock[i]) {
          grid.height[i] = 0;
          grid.dir[i] = DIR_UNRAKED;
        }
      }
    }
  }

  /** `record` false leaves the undo history alone: Gubba's own edits are committed once, by the caller. */
  function editElement(id: string, replacement?: ElementInstance, record = true): boolean {
    const index = state.elements.findIndex(element => element.id === id);
    const previous = state.elements[index];
    if (replacement) {
      if (!isGardenElement(replacement) || (!previous && state.elements.length >= MAX_GARDEN_ELEMENTS)) return false;
    } else if (!previous) {
      return false;
    }

    const before = record ? cloneGarden(state) : null;
    // Level the old and new impressions before marking the new footprint.
    if (previous) {
      state.elements.splice(index, 1);
      rebuildRockMask(state.sand, state.elements);
      levelFootprint(previous);
    }
    if (replacement) {
      levelFootprint(replacement);
      state.elements.splice(previous ? index : state.elements.length, 0, replacement);
    }
    rebuildRockMask(state.sand, state.elements);
    if (before) history.pushSnapshot(before, state);
    return true;
  }

  function normalized(element: ElementInstance): ElementInstance | null {
    if (state.elements.some(placed => placed.id === element.id)
      || !Object.hasOwn(ELEMENT_FOOTPRINTS, element.kind)) return null;
    const { rx, ry } = ELEMENT_FOOTPRINTS[element.kind];
    return { ...element, x: Math.round(element.x), y: Math.round(element.y), rx, ry };
  }

  return {
    garden: state,
    settings: preferences,
    history,
    snapshot: () => cloneGarden(state),
    commitStroke: (patch: StrokePatch) => history.pushStroke(patch),
    commitSnapshot: (before: GardenState) => history.pushSnapshot(before, state),
    undo: () => history.undo(state),
    redo: () => history.redo(state),
    loadPreset(preset: PresetId): void {
      const before = cloneGarden(state);
      state.elements = applyPreset(state.sand, preset);
      history.pushSnapshot(before, state);
    },
    sweep(): boolean {
      const before = cloneGarden(state);
      if (!applySweep(state.sand, 0, SWEEP_DURATION_MS)) return false;
      history.pushSnapshot(before, state);
      return true;
    },
    placeElement(element: ElementInstance): boolean {
      const next = normalized(element);
      return next !== null && editElement(element.id, next);
    },
    moveElement(id: string, x: number, y: number): boolean {
      const previous = state.elements.find(element => element.id === id);
      if (!previous) return false;
      const next = { ...previous, x: Math.round(x), y: Math.round(y) };
      if (next.x === previous.x && next.y === previous.y) return false;
      return editElement(id, next);
    },
    removeElement: (id: string) => editElement(id),
    /** The same edits without an undo entry each (Gubba mode): the caller commits one snapshot for the run. */
    silent: {
      place(element: ElementInstance): boolean {
        const next = normalized(element);
        return next !== null && editElement(element.id, next, false);
      },
      remove: (id: string) => editElement(id, undefined, false),
    },
  };
}

function createOpeningGarden(): GardenState {
  const state = createGarden();
  state.elements = applyPreset(state.sand, "three_islands");
  return state;
}
