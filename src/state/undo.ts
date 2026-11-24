import { cloneSandGrid } from "../sand/index.ts";
import type { StrokePatch } from "../rakes/types.ts";
import type { GardenState } from "./types.ts";

export const UNDO_DEPTH = 32;

type Entry = { kind: "stroke"; patch: StrokePatch } | { kind: "snapshot"; before: GardenState; after: GardenState };

export function cloneGarden(state: GardenState): GardenState {
  return {
    v: 1,
    sand: cloneSandGrid(state.sand),
    elements: state.elements.map(element => ({ ...element })),
  };
}

export class UndoStack {
  private past: Entry[] = [];
  private future: Entry[] = [];

  get undoCount(): number {
    return this.past.length;
  }

  get redoCount(): number {
    return this.future.length;
  }

  pushStroke(patch: StrokePatch): void {
    if (patch.rect.w && patch.rect.h) this.push({ kind: "stroke", patch });
  }

  pushSnapshot(before: GardenState, after: GardenState): void {
    this.push({ kind: "snapshot", before: cloneGarden(before), after: cloneGarden(after) });
  }

  undo(state: GardenState): boolean {
    const entry = this.past.pop();
    if (!entry) return false;
    this.apply(state, entry, false);
    this.future.push(entry);
    return true;
  }

  redo(state: GardenState): boolean {
    const entry = this.future.pop();
    if (!entry) return false;
    this.apply(state, entry, true);
    this.past.push(entry);
    return true;
  }

  private push(entry: Entry): void {
    this.past.push(entry);
    if (this.past.length > UNDO_DEPTH) this.past.shift();
    this.future.length = 0;
  }

  private apply(state: GardenState, entry: Entry, redo: boolean): void {
    const grid = state.sand;
    if (entry.kind === "snapshot") {
      const snapshot = redo ? entry.after : entry.before;
      grid.height.set(snapshot.sand.height);
      grid.dir.set(snapshot.sand.dir);
      grid.rock.set(snapshot.sand.rock);
      state.elements = snapshot.elements.map(element => ({ ...element }));
      return;
    }

    const patch = entry.patch;
    const { x, y, w, h } = patch.rect;
    const height = redo ? patch.afterHeight : patch.beforeHeight;
    const dir = redo ? patch.afterDir : patch.beforeDir;
    for (let row = 0; row < h; row++) {
      const target = (y + row) * grid.w + x;
      grid.height.set(height.subarray(row * w, (row + 1) * w), target);
      grid.dir.set(dir.subarray(row * w, (row + 1) * w), target);
    }
  }
}
