import type { BreathPhase, GubbaVariant, MoodId, RakeId } from "../state/types.ts";

/**
 * Gubba's lines (DESIGN.md sections 4.4 and 5.1). Data only.
 *
 * Voice rules: at most 96 characters, plain words, no exclamation marks,
 * deadpan, no praise or grading, no mention of time spent. Imperatives only for
 * the breath cues. Every line must wrap to at most 3 rows of 158 pixels in the
 * bitmap font (see `wrapBitmapLines`); the unit tests check all of them.
 */

export const MAX_LINE_CHARS = 96;
export const MAX_LINE_PX = 158;
export const MAX_LINE_ROWS = 3;
/** Each rake has a three-line story, told one line per tap on Gubba. */
export const STORY_LENGTH = 3;

export const FIRST_VISIT_LINE = "Take a rake. Any rake.";

export const RAKE_IDS: readonly RakeId[] = [
  "sugi",
  "onami",
  "kinu",
  "hisui",
  "mikazuki",
  "tetsu",
  "wa",
  "take",
  "nagi",
  "hoki",
];

/** One-word cues for the breath guide (first three cycles only). */
export const BREATH_CUES: Readonly<Record<BreathPhase, string>> = {
  inhale: "In.",
  hold_in: "Hold.",
  exhale: "Out.",
  hold_out: "Hold.",
};

/** DESIGN.md 4.4, verbatim. */
export const RAKE_LINES: Readonly<Record<RakeId, string>> = {
  sugi: "Five lines. Enough for most days.",
  onami: "The tide does not hurry, and the whole shore is combed.",
  kinu: "Fine as rain on silk. It likes a slow hand.",
  hisui: "Long, short. Long, short. Even stone keeps time.",
  mikazuki: "This one remembers the sea.",
  tetsu: "Heavy things leave honest marks.",
  wa: "One foot stays, one foot wanders. That is a circle.",
  take: "One line is also a garden.",
  nagi: "Nothing is erased. The sand only rests.",
  hoki: "Ah. A clean morning, at any hour you like.",
};

export const BASKET_LINES: readonly string[] = [
  "Set a stone down and the sand has something to talk about.",
  "Pick a stone the way you pick a chair. By how it sits.",
  "The basket holds three stones and has never asked for a fourth.",
];

export const STORIES: Readonly<Record<RakeId, readonly [string, string, string]>> = {
  sugi: [
    "Cedar grows slowly so that it can be patient later.",
    "Five tines. One for each thing I have decided not to worry about.",
    "This rake was a tree that agreed to stay in one place. It still does.",
  ],
  onami: [
    "Driftwood has already been everywhere. It is content to be here.",
    "Nine tines carry the sea in small pieces.",
    "The shore is in no hurry. It has arranged to be combed.",
  ],
  kinu: [
    "Hinoki smells like a quiet room. The bamboo teeth keep it that way.",
    "Eleven fine lines. The sand does not complain about any of them.",
    "Silk is only patience that someone wound up.",
  ],
  hisui: [
    "Jade is stone that learned to hum.",
    "Long tooth, short tooth. The sand hears a drum and does not say so.",
    "The gold cord holds nothing. It has been asked not to let go.",
  ],
  mikazuki: [
    "Maple bends because nobody told it to be straight.",
    "The crescent leans, and the sand leans after it.",
    "Indigo cord, from a dye that spent a summer deciding on blue.",
  ],
  tetsu: [
    "Iron was in the mountain first. It has opinions about depth.",
    "Three furrows is all anyone needs to show that a hand was here.",
    "The oak handle is charred on purpose. It remembers a small fire fondly.",
  ],
  wa: [
    "Walnut forked in two directions and chose both.",
    "Set one prong beside a stone and walk. The circle does the rest.",
    "The brass ring is for luck. It has not been asked for any yet.",
  ],
  take: [
    "Bamboo is hollow and still stands. I think about it often.",
    "A slanted tip writes what the hand was about to say anyway.",
    "One stroke has a beginning, a middle, and an end. That is plenty of plot.",
  ],
  nagi: [
    "Paulownia is light, which is why it can be so firm.",
    "Smoothing is a way of listening to the sand.",
    "A flat board, a flat patch, and nothing at all to correct.",
  ],
  hoki: [
    "Bamboo twigs, tied by someone who was thinking about something else.",
    "A broom does not undo. It offers a different beginning.",
    "Everything is swept eventually. The sand merely goes first.",
  ],
};

export const MOOD_LINES: Readonly<Record<MoodId, readonly string[]>> = {
  morning: [
    "Mist is the sky checking whether the garden is ready.",
    "Morning keeps its voice down. So do I.",
  ],
  afternoon: [
    "The cedar light is the warm kind. It does not ask for anything.",
    "Afternoon is the long middle of the day, and it is comfortable there.",
  ],
  dusk: [
    "Petals fall without being asked. It is a talent.",
    "Dusk is when the lanterns remember what they are for.",
  ],
  moonlit: [
    "The koi are asleep. The pond is only pretending to be awake.",
    "The moon does a little raking of its own, on the water.",
  ],
};

export const RAIN_LINES: readonly string[] = [
  "I am holding a leaf. It covers very little. The thought is what counts.",
  "Rain is the sky practising its handwriting on the sand.",
  "Each drop arrives knowing exactly where it is going. It is a small calm.",
  "The sand takes the rain the way it takes everything. Slowly, and without comment.",
  "Rain, then tea. The order matters.",
];

export const SWEEP_LINES: readonly string[] = [
  "The slate is clean. The slate was never dirty.",
  "Everything is level now. This is not better. It is only level.",
  "The broom has gone through and nobody has been hurt.",
  "A fresh start looks a lot like an old one that stopped talking.",
];

export const STONE_LINES: readonly string[] = [
  "A stone is a decision that nobody has to revisit.",
  "The sand is arranging itself around the new arrival. It is being polite.",
  "Stones are only mountains that have stopped explaining themselves.",
  "Place it anywhere. It will say it was always there.",
  "A rake will go around a stone. A stone is not impressed.",
];

export const BREATH_LINES: readonly string[] = [
  "Breathe out a little longer than you breathe in. The tea taught me that.",
  "A breath is a small tide. It asks nothing of the shore.",
  "There is no right number of breaths. That is the first rule and the last.",
  "The tea is not going anywhere, so there is no reason to hurry.",
  "A long breath out is a very small holiday.",
];

export const VARIANT_LINES: Readonly<Record<GubbaVariant, readonly string[]>> = {
  moss: [
    "This cushion and I have an understanding. It has agreed to try.",
    "The bonsai and I have settled the matter of light. It leans, and I allow it.",
  ],
  kasa: [
    "The hat belongs to a smaller person. I am keeping it for them.",
    "The pipe is for thinking. Nothing in it has ever been lit.",
  ],
  lantern: [
    "The shell is not a hat. It has been told, and wears it anyway.",
    "A firefly lives in the shell. We do not discuss rent.",
  ],
};

/** Gubba mode and "Watch: Gubba rakes": getting up to rake, sitting back down, and giving way to the player. */
export const AUTO_START_LINES: readonly string[] = [
  "The cushion can manage without me. It has said so.",
  "I have decided to supervise from closer up.",
  "Short arms, long rake. It evens out.",
  "The sand has been patient. I will go and see what it wanted.",
];

export const AUTO_DONE_LINES: readonly string[] = [
  "There. The sand and I have come to an arrangement.",
  "The rake is back on its pegs. The tea was waiting.",
  "That is one way the sand can lie. There are others.",
  "I put the stones where the stones said.",
];

export const AUTO_YIELD_LINES: readonly string[] = [
  "The sand is yours. I was only keeping it company.",
  "Ah. A hand. I will go and sit.",
  "Two rakes is one too many. Mine can rest.",
  "I had not finished. Nothing here ever is.",
];

/** Reflections: the general pool for taps, quiet pauses, and Companion mode. */
export const IDLE_LINES: readonly string[] = [
  "Mm.",
  "The garden is finished whenever you stop.",
  "I have raked this corner for two hundred years. It is going well.",
  "I do not rake. I supervise. It is harder than it looks.",
  "My arms are short so that the tea stays close.",
  "A crooked line is still a line the hand enjoyed.",
  "The stones are not in the way. The stones are the way around.",
  "Tea is only warm water that has been listening.",
  "The sand keeps no records. I find this restful.",
  "A line is a very small journey.",
  "Somewhere a bird is deciding on a branch. I will let it take its time.",
  "Nothing here needs fixing. Some things need looking at.",
  "The wind is only the garden turning a page.",
  "A rake is a comb for the ground. The ground does not mind.",
  "Moss does everything slowly and gets it all done.",
  "Every stone has a favourite side. It will not say which.",
  "A groove is a yes that the sand can hold.",
  "If a line wanders, let it. It knows the way.",
  "I used to count the grains. I stopped at a very large number.",
  "Stillness is not empty. It is only very full and very quiet.",
  "The cushion is warm. This is all the news I have.",
  "Wood remembers being a tree. Sand remembers being a mountain.",
  "Nobody has ever finished a garden. They only put the rake down.",
  "The lantern is not for seeing. The lantern is for company.",
  "A loose hand makes a kind line. The sand can tell.",
  "Some mornings the sand is flat. Some mornings it has plans.",
  "This silence has been left here for anyone who wants it.",
  "It is possible to be busy and calm. I have seen a river do it.",
  "A curve does not hurry to its end.",
  "A single grain is not asked to be a beach.",
  "A pattern is only a habit the sand was given.",
  "The tea is cold. This was also the plan.",
  "Pebbles think of themselves as boulders at rest.",
  "I once watched a snail cross the whole bed. It did not rush. Neither did I.",
  "The air smells of cedar and of nothing in particular. Both are welcome.",
  "No need to mind me. I am only here to be here.",
  "Raking is mostly deciding where to stop.",
  "The moss has no plan, and it is ahead of schedule.",
  "There is room in every line for one more thought. Or none.",
  "Sand is only slow water.",
  "Any direction will do on sand. No one is waiting at the other end.",
  "Quiet is a thing you can hold, as long as you do not squeeze.",
  "The wall of rakes does not mind being chosen, or being passed over.",
  "Even the shadows here have been combed.",
  "I could say something wise, but the garden is already doing it.",
  "Bamboo in the wind sounds like a crowd that agreed to whisper.",
  "What the sand wants is very little. It gets exactly that.",
  "Water finds the low places. Sand merely lies in them.",
  "A pause between two strokes is also part of the stroke.",
  "Every ridge has a valley beside it. It is a fair arrangement.",
  "I take my tea in small sips so that it lasts through the weather.",
  "There is a kind of tired that only tea can fix. I have it handled.",
];

export interface LineDef {
  tag: string;
  text: string;
}

function buildLines(): LineDef[] {
  const out: LineDef[] = [{ tag: "first", text: FIRST_VISIT_LINE }];
  for (const id of RAKE_IDS) {
    out.push({ tag: `rake:${id}`, text: RAKE_LINES[id] });
    STORIES[id].forEach((text, n) => out.push({ tag: `story:${id}:${n}`, text }));
  }
  for (const mood of Object.keys(MOOD_LINES) as MoodId[]) {
    for (const text of MOOD_LINES[mood]) out.push({ tag: `mood:${mood}`, text });
  }
  for (const text of RAIN_LINES) out.push({ tag: "rain", text });
  for (const text of SWEEP_LINES) out.push({ tag: "sweep", text });
  for (const text of STONE_LINES) out.push({ tag: "stone", text });
  for (const text of BREATH_LINES) out.push({ tag: "breath", text });
  for (const text of BASKET_LINES) out.push({ tag: "basket", text });
  for (const v of Object.keys(VARIANT_LINES) as GubbaVariant[]) {
    for (const text of VARIANT_LINES[v]) out.push({ tag: `variant:${v}`, text });
  }
  for (const text of AUTO_START_LINES) out.push({ tag: "auto_start", text });
  for (const text of AUTO_DONE_LINES) out.push({ tag: "auto_done", text });
  for (const text of AUTO_YIELD_LINES) out.push({ tag: "auto_yield", text });
  for (const text of IDLE_LINES) out.push({ tag: "idle", text });
  return out;
}

/** Every line with its trigger tag. About 130 lines. */
export const LINES: readonly LineDef[] = buildLines();

const POOLS: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const { tag, text } of LINES) {
    const list = m.get(tag);
    if (list) list.push(text);
    else m.set(tag, [text]);
  }
  return m;
})();

const EMPTY: readonly string[] = [];

/** All lines for a trigger tag (`rake:sugi`, `mood:dusk`, `idle`, `variant:kasa`, ...). */
export function linesForTag(tag: string): readonly string[] {
  return POOLS.get(tag) ?? EMPTY;
}

export function storyLine(rake: RakeId, n: number): string {
  const i = n < 0 ? 0 : n >= STORY_LENGTH ? STORY_LENGTH - 1 : Math.floor(n);
  return STORIES[rake][i] ?? RAKE_LINES[rake];
}

// ---------------------------------------------------------------------------
// Bitmap font metrics (DESIGN.md 2.7)
// ---------------------------------------------------------------------------

const NARROW = "il!.,:'|";

/** Pixel advance of one glyph: its width plus a 1 px gap. */
export function glyphAdvance(ch: string): number {
  if (ch === " ") return 3 + 1;
  if (ch === "m" || ch === "w") return 5 + 1;
  if (NARROW.includes(ch)) return 2 + 1;
  return 4 + 1;
}

/** Width of `text` on one row, counting the trailing gap (slightly conservative). */
export function bitmapTextWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += glyphAdvance(ch);
  return w;
}

/** Greedy word wrap into rows of at most `maxPx` pixels. Over-long words are split. */
export function wrapBitmapLines(text: string, maxPx: number = MAX_LINE_PX): string[] {
  const rows: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if (word === "") continue;
    const candidate = cur === "" ? word : `${cur} ${word}`;
    if (bitmapTextWidth(candidate) <= maxPx) {
      cur = candidate;
      continue;
    }
    if (cur !== "") {
      rows.push(cur);
      cur = "";
    }
    let rest = word;
    while (bitmapTextWidth(rest) > maxPx) {
      let n = rest.length - 1;
      while (n > 1 && bitmapTextWidth(rest.slice(0, n)) > maxPx) n--;
      rows.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    cur = rest;
  }
  if (cur !== "") rows.push(cur);
  return rows;
}

export function wrapBitmapLineCount(text: string, maxPx: number = MAX_LINE_PX): number {
  return wrapBitmapLines(text, maxPx).length;
}
