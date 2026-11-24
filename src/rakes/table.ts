import { KEEP } from "../sand/types.ts";
import type { RakeSpec, RakeToolId } from "./types.ts";

function comb(count: number, width: number, gap: number, depth: number, berm: number, ridge = berm): Int8Array {
  const values = [berm];
  for (let tine = 0; tine < count; tine++) {
    if (tine) values.push(...Array<number>(gap).fill(ridge));
    values.push(...Array<number>(width).fill(-depth));
  }
  values.push(berm);
  return Int8Array.from(values);
}

const tools: Omit<RakeSpec, "rackX" | "headWidth">[] = [
  {
    id: "sugi", key: "1", name: "Sugi", title: "Classic 5-Tine Cedar", shortDesc: "Everyday lines.",
    tineCount: 5, tineWidth: 2, tineDepth: 2,
    profile: comb(5, 2, 2, 2, 1), handle: 8, rackSlotWidth: 20,
    line: "Five lines. Enough for most days.",
  },
  {
    id: "onami", key: "2", name: "Ōnami", title: "Wide 9-Tine Tide", shortDesc: "Broad calm sweeps.",
    tineCount: 9, tineWidth: 2, tineDepth: 2,
    profile: comb(9, 2, 2, 2, 1), handle: 12, rackSlotWidth: 36,
    line: "The tide does not hurry, and the whole shore is combed.",
  },
  {
    id: "kinu", key: "3", name: "Kinu", title: "Fine 11-Tine Silk", shortDesc: "Fine texture, slow detail.",
    tineCount: 11, tineWidth: 1, tineDepth: 1,
    profile: comb(11, 1, 1, 1, 1), handle: 8, rackSlotWidth: 23,
    line: "Fine as rain on silk. It likes a slow hand.",
  },
  {
    id: "hisui", key: "4", name: "Hisui", title: "Jade Cadence", shortDesc: "A long-short rhythm in every pass.",
    tineCount: 7, tineWidth: 11 / 7, tineDepth: 11 / 7,
    profile: Int8Array.of(1, -2, -2, 1, -1, 1, -2, -2, 1, -1, 1, -2, -2, 1, -1, 1, -2, -2, 1),
    handle: 8, rackSlotWidth: 19,
    line: "Long, short. Long, short. Even stone keeps time.",
  },
  {
    id: "mikazuki", key: "5", name: "Mikazuki", title: "Crescent Wave Sweep", shortDesc: "Draws waves by itself.",
    tineCount: 6, tineWidth: 2, tineDepth: 2,
    profile: comb(6, 2, 2, 2, 1), handle: 10, wave: { amp: 3, len: 24 }, rackSlotWidth: 24,
    line: "This one remembers the sea.",
  },
  {
    id: "tetsu", key: "6", name: "Tetsu", title: "Three-Tine Iron Furrow", shortDesc: "Deep furrows and dark shadows.",
    tineCount: 3, tineWidth: 3, tineDepth: 3,
    profile: comb(3, 3, 3, 3, 2), handle: 14, rackSlotWidth: 17,
    line: "Heavy things leave honest marks.",
  },
  {
    id: "wa", key: "7", name: "Wa", title: "Twin-Prong Orbit", shortDesc: "Rings around a stone or pin.",
    tineCount: 2, tineWidth: 2, tineDepth: 2,
    profile: comb(2, 2, 6, 2, 1, KEEP), handle: 6, orbit: true, rackSlotWidth: 12,
    line: "One foot stays, one foot wanders. That is a circle.",
  },
  {
    id: "take", key: "8", name: "Take", title: "Single Bamboo Stylus", shortDesc: "Drawing, writing, spirals.",
    tineCount: 1, tineWidth: 1, tineDepth: 2,
    profile: Int8Array.of(1, -2, 1), handle: 4, rackSlotWidth: 8,
    line: "One line is also a garden.",
  },
  {
    id: "nagi", key: "9", name: "Nagi", title: "Flat Sand Smoother", shortDesc: "Rests a patch of sand.",
    tineCount: 0, tineWidth: 0, tineDepth: 0,
    profile: new Int8Array(16), handle: 10, flat: true, rackSlotWidth: 16,
    line: "Nothing is erased. The sand only rests.",
  },
  {
    id: "hoki", key: "0", name: "Hōki", title: "Bamboo broom", shortDesc: "Hold to smooth all sand.",
    tineCount: 0, tineWidth: 0, tineDepth: 0,
    profile: new Int8Array(0), handle: 0, action: "sweep", rackSlotWidth: 12,
    line: "Ah. A clean morning, at any hour you like.",
  },
];

export const RACK_WIDTH = 217.6;
let rackLeft = -RACK_WIDTH / 2;
export const RAKES: readonly RakeSpec[] = tools.map(tool => {
  const rake = {
    ...tool,
    headWidth: tool.profile.length,
    rackX: Math.round((rackLeft + tool.rackSlotWidth / 2) * 10) / 10,
  };
  rackLeft += tool.rackSlotWidth + 3.4;
  return rake;
});

export const RAKE_BY_ID = Object.fromEntries(RAKES.map(rake => [rake.id, rake])) as Readonly<Record<RakeToolId, RakeSpec>>;
