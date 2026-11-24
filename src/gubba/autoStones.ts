import type { ElementInstance, ElementKind } from "../state/types.ts";

/**
 * Plans how Gubba turns the stones of one garden into the stones of another, one stone per trip. Pure.
 *
 * - A stone already where the target wants one of its kind is left alone.
 * - The rest pair up within a kind, nearest pair first, and each pair is one `move`.
 * - Stones the target has no use for go back to the basket (`remove`); stones it lacks come out of it (`place`).
 *
 * Removes come first, then moves, then places, so the garden never holds more stones than the larger of the two
 * gardens (at most 12). The number of trips is the least possible: no stone is carried twice.
 */

export interface StoneOp {
  type: "remove" | "move" | "place";
  /** The stone to lift (`remove`, `move`), or the target stone's id (`place`). */
  id: string;
  kind: ElementKind;
  /** Where the stone is now, in grid cells. Unused by `place`. */
  x: number;
  y: number;
  /** Where it goes, in grid cells. Unused by `remove`. */
  toX: number;
  toY: number;
}

function nearest<T>(items: readonly T[], used: readonly boolean[], distance: (item: T) => number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    const d = distance(items[i] as T);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function planStones(
  current: readonly ElementInstance[],
  target: readonly ElementInstance[],
  fromX: number,
  fromY: number,
): StoneOp[] {
  const currentUsed = current.map(() => false);
  const targetUsed = target.map(() => false);

  // 1. exact matches stay
  target.forEach((t, ti) => {
    const ci = current.findIndex((c, i) => !currentUsed[i] && c.kind === t.kind && c.x === t.x && c.y === t.y);
    if (ci >= 0) {
      currentUsed[ci] = true;
      targetUsed[ti] = true;
    }
  });

  // 2. same-kind pairs, globally nearest first
  const moves: StoneOp[] = [];
  for (;;) {
    let bestC = -1;
    let bestT = -1;
    let bestD = Infinity;
    for (let ci = 0; ci < current.length; ci++) {
      if (currentUsed[ci]) continue;
      const c = current[ci] as ElementInstance;
      for (let ti = 0; ti < target.length; ti++) {
        if (targetUsed[ti]) continue;
        const t = target[ti] as ElementInstance;
        if (t.kind !== c.kind) continue;
        const d = Math.hypot(t.x - c.x, t.y - c.y);
        if (d < bestD) {
          bestD = d;
          bestC = ci;
          bestT = ti;
        }
      }
    }
    if (bestC < 0) break;
    const c = current[bestC] as ElementInstance;
    const t = target[bestT] as ElementInstance;
    currentUsed[bestC] = true;
    targetUsed[bestT] = true;
    moves.push({ type: "move", id: c.id, kind: c.kind, x: c.x, y: c.y, toX: t.x, toY: t.y });
  }

  // 3. what is left over goes to the basket or comes from it
  const removes: StoneOp[] = [];
  current.forEach((c, ci) => {
    if (!currentUsed[ci]) removes.push({ type: "remove", id: c.id, kind: c.kind, x: c.x, y: c.y, toX: c.x, toY: c.y });
  });
  const places: StoneOp[] = [];
  target.forEach((t, ti) => {
    if (!targetUsed[ti]) places.push({ type: "place", id: t.id, kind: t.kind, x: t.x, y: t.y, toX: t.x, toY: t.y });
  });

  // 4. order each group as a short walk: nearest to where Gubba stands, then nearest to where he ended up
  const ops: StoneOp[] = [];
  let px = fromX;
  let py = fromY;
  const taken = removes.map(() => false);
  for (let n = 0; n < removes.length; n++) {
    const i = nearest(removes, taken, (r) => Math.hypot(r.x - px, r.y - py));
    taken[i] = true;
    ops.push(removes[i] as StoneOp);
  }
  const moved = moves.map(() => false);
  for (let n = 0; n < moves.length; n++) {
    const i = nearest(moves, moved, (m) => Math.hypot(m.x - px, m.y - py));
    moved[i] = true;
    const m = moves[i] as StoneOp;
    ops.push(m);
    px = m.toX;
    py = m.toY;
  }
  const placed = places.map(() => false);
  for (let n = 0; n < places.length; n++) {
    const i = nearest(places, placed, (p) => Math.hypot(p.toX - px, p.toY - py));
    placed[i] = true;
    ops.push(places[i] as StoneOp);
  }
  return ops;
}
