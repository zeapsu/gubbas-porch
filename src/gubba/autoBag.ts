import type { PresetId } from "../state/types.ts";

/**
 * The bag Gubba draws his next garden from in Gubba mode. Pure: the only randomness is an xorshift32 stream
 * kept in the bag, seeded by the caller.
 *
 * Every patterned preset comes out once before any comes out twice, and the same one never comes out twice
 * running, across a refill too. Still Sand is not in the bag: an empty bed is something the player asks for.
 */

export const AUTO_BAG_PRESETS: readonly PresetId[] = [
  "three_islands",
  "ripple_pond",
  "old_sea",
  "river_bend",
  "snails_thought",
  "checker_field",
];

export interface AutoBag {
  /** The current shuffle; the next draw is `items[left - 1]`. */
  readonly items: PresetId[];
  left: number;
  last: PresetId | null;
  rng: number;
}

/** One xorshift32 step. Never returns 0. */
export function xorshift32(state: number): number {
  let x = state >>> 0;
  if (x === 0) x = 0x2545f491;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return x === 0 ? 0x2545f491 : x;
}

export function createAutoBag(seed: number): AutoBag {
  let rng = (Math.imul(seed | 0, 0x9e3779b1) ^ 0x7f4a7c15) >>> 0;
  rng = xorshift32(xorshift32(rng));
  return { items: [...AUTO_BAG_PRESETS], left: 0, last: null, rng };
}

function refill(bag: AutoBag): void {
  const items = bag.items;
  for (let i = items.length - 1; i > 0; i--) {
    bag.rng = xorshift32(bag.rng);
    const j = bag.rng % (i + 1);
    const t = items[i] as PresetId;
    items[i] = items[j] as PresetId;
    items[j] = t;
  }
  bag.left = items.length;
  // the first draw of a new shuffle is never the last draw of the old one
  const top = items.length - 1;
  if (top > 0 && items[top] === bag.last) {
    items[top] = items[0] as PresetId;
    items[0] = bag.last;
  }
}

/**
 * The next preset. `skip` names presets to pass over (the one the garden already shows); a skipped preset is
 * used up, so it comes round again with the next shuffle.
 */
export function drawAutoBag(bag: AutoBag, skip?: (id: PresetId) => boolean): PresetId {
  for (let tries = 0; tries < bag.items.length * 2; tries++) {
    if (bag.left === 0) refill(bag);
    const id = bag.items[--bag.left] as PresetId;
    if (id === bag.last || (skip !== undefined && skip(id))) continue;
    bag.last = id;
    return id;
  }
  // only reachable if `skip` refuses everything: fall back to any preset other than the last
  const fallback = bag.items.find((id) => id !== bag.last) ?? (bag.items[0] as PresetId);
  bag.last = fallback;
  return fallback;
}
