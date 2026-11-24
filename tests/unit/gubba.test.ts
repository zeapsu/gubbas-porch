import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AUTO_DONE_LINES,
  AUTO_SIP_DELAY_MS,
  AUTO_START_LINES,
  AUTO_YIELD_LINES,
  BREATH_CUES,
  DOZE_AFTER_MS,
  FIRST_VISIT_LINE,
  GUBBA_NODE_NAMES,
  HEAD_YAW_LIMIT,
  LINES,
  MAX_LINE_CHARS,
  MAX_LINE_PX,
  MAX_LINE_ROWS,
  RAKE_IDS,
  RAKE_LINES,
  SOMETIMES_GAP_MS,
  STORY_LENGTH,
  bitmapTextWidth,
  breath,
  breathPeriodMs,
  createGubbaState,
  createPose,
  linesForTag,
  poseGubba,
  stepGubba,
  storyLine,
  wrapBitmapLineCount,
  wrapBitmapLines,
} from "../../src/gubba/index.ts";
import {
  CONTROL_COUNT,
  adjustMix,
  createDomMirror,
  effectiveMood,
  hasStorySeal,
  mapKeyDown,
  mapKeyUp,
  moodFromHour,
  nextGubbaVariant,
  nextMoodSetting,
  setGubbaVariant,
  setMoodSetting,
  toggleDensity,
  toggleFlow,
  toggleBreath,
  toggleMoodAuto,
  toggleMute,
  toggleRain,
  withHeardStories,
} from "../../src/ui/index.ts";
import type { UiCommand } from "../../src/ui/index.ts";
import { DEFAULT_SETTINGS } from "../../src/state/types.ts";
import type {
  BreathPatternId,
  BreathPhase,
  GubbaEvent,
  GubbaState,
  GubbaVariant,
  MoodId,
  RakeId,
  TalkMode,
} from "../../src/state/types.ts";

const PATTERNS: readonly BreathPatternId[] = ["4-4-6", "4-7-8", "box"];
const VARIANTS: readonly GubbaVariant[] = ["moss", "kasa", "lantern"];
const MOODS: readonly MoodId[] = ["morning", "afternoon", "dusk", "moonlit"];
const MODES: readonly TalkMode[] = ["quiet", "sometimes", "companion"];

// ---------------------------------------------------------------------------
// Breath clock
// ---------------------------------------------------------------------------

describe("breath clock", () => {
  it("has the exact periods", () => {
    expect(breathPeriodMs("4-4-6")).toBe(14_000);
    expect(breathPeriodMs("4-7-8")).toBe(19_000);
    expect(breathPeriodMs("box")).toBe(16_000);
  });

  it("partitions each cycle into inhale, hold_in, exhale, hold_out with the pattern's lengths", () => {
    const expected: Record<BreathPatternId, Record<BreathPhase, number>> = {
      "4-4-6": { inhale: 4000, hold_in: 4000, exhale: 6000, hold_out: 0 },
      "4-7-8": { inhale: 4000, hold_in: 7000, exhale: 8000, hold_out: 0 },
      box: { inhale: 4000, hold_in: 4000, exhale: 4000, hold_out: 4000 },
    };
    for (const pattern of PATTERNS) {
      const counts: Record<BreathPhase, number> = { inhale: 0, hold_in: 0, exhale: 0, hold_out: 0 };
      const order: BreathPhase[] = [];
      const period = breathPeriodMs(pattern);
      for (let t = 0; t < period; t += 10) {
        const { phase } = breath(pattern, t);
        counts[phase] += 10;
        if (order[order.length - 1] !== phase) order.push(phase);
      }
      expect(counts).toEqual(expected[pattern]);
      const wanted: BreathPhase[] = ["inhale", "hold_in", "exhale", "hold_out"].filter(
        (p) => expected[pattern][p as BreathPhase] > 0,
      ) as BreathPhase[];
      expect(order).toEqual(wanted);
    }
  });

  it("starts empty, is full through the holds, and wraps to the next cycle", () => {
    const s0 = breath("4-4-6", 0);
    expect(s0).toEqual({ phase: "inhale", amplitude: 0, cycleIndex: 0 });
    expect(breath("4-4-6", 4000)).toMatchObject({ phase: "hold_in", amplitude: 1 });
    expect(breath("4-4-6", 7999)).toMatchObject({ phase: "hold_in", amplitude: 1 });
    expect(breath("4-4-6", 8000)).toMatchObject({ phase: "exhale", amplitude: 1 });
    expect(breath("box", 12_000)).toMatchObject({ phase: "hold_out", amplitude: 0 });
    expect(breath("4-4-6", 14_000)).toEqual({ phase: "inhale", amplitude: 0, cycleIndex: 1 });
    expect(breath("4-7-8", 19_000 * 3 + 1000).cycleIndex).toBe(3);
  });

  it("is continuous and within [0, 1]", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PATTERNS),
        fc.double({ min: 0, max: 200_000, noNaN: true }),
        (pattern, t) => {
          const a = breath(pattern, t).amplitude;
          const b = breath(pattern, t + 1).amplitude;
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThanOrEqual(1);
          // smoothstep slope is at most 1.5 / 4000 ms
          expect(Math.abs(b - a)).toBeLessThanOrEqual(1.5 / 4000 + 1e-9);
        },
      ),
    );
  });

  it("is continuous across every phase boundary and the cycle wrap", () => {
    for (const pattern of PATTERNS) {
      const period = breathPeriodMs(pattern);
      for (const boundary of [4000, 8000, 12_000, period, period * 2]) {
        const before = breath(pattern, boundary - 0.001).amplitude;
        const after = breath(pattern, boundary + 0.001).amplitude;
        expect(Math.abs(after - before)).toBeLessThan(1e-4);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

describe("Gubba lines", () => {
  it("has about 120 distinct lines", () => {
    expect(LINES.length).toBeGreaterThanOrEqual(115);
    expect(new Set(LINES.map((l) => l.text)).size).toBe(LINES.length);
  });

  it("keeps every line at 96 characters, plain ASCII, no exclamation marks", () => {
    for (const { tag, text } of LINES) {
      expect(text.length, `${tag}: ${text}`).toBeLessThanOrEqual(MAX_LINE_CHARS);
      expect(text, tag).not.toContain("!");
      expect(text, tag).toMatch(/^[\x20-\x7e]+$/);
      expect(text, tag).toBe(text.trim());
    }
  });

  it("wraps every line to at most 3 rows of 158 px", () => {
    for (const { tag, text } of LINES) {
      const rows = wrapBitmapLines(text, MAX_LINE_PX);
      expect(rows.length, `${tag}: ${text}`).toBeLessThanOrEqual(MAX_LINE_ROWS);
      for (const row of rows) expect(bitmapTextWidth(row)).toBeLessThanOrEqual(MAX_LINE_PX);
      expect(rows.join(" ")).toBe(text);
      expect(wrapBitmapLineCount(text)).toBe(rows.length);
    }
  });

  it("measures glyphs as the font defines them", () => {
    expect(bitmapTextWidth("a")).toBe(5);
    expect(bitmapTextWidth("m")).toBe(6);
    expect(bitmapTextWidth("w")).toBe(6);
    expect(bitmapTextWidth("i")).toBe(3);
    expect(bitmapTextWidth(".")).toBe(3);
    expect(bitmapTextWidth(" ")).toBe(4);
    expect(wrapBitmapLineCount("Mm.")).toBe(1);
    expect(wrapBitmapLineCount("a ".repeat(200).trim())).toBeGreaterThan(3);
    // a word longer than a row is split rather than overflowing
    for (const row of wrapBitmapLines("x".repeat(80))) expect(bitmapTextWidth(row)).toBeLessThanOrEqual(MAX_LINE_PX);
  });

  it("never grades, praises, or counts time", () => {
    const banned = /\b(great|well done|good job|nice work|beautiful|perfect|excellent|amazing|wonderful|welcome back|again|minutes|hours|visit)\b/i;
    for (const { tag, text } of LINES) expect(text, tag).not.toMatch(banned);
  });

  it("holds the exact rake lines from the design", () => {
    expect(RAKE_LINES.sugi).toBe("Five lines. Enough for most days.");
    expect(RAKE_LINES.hoki).toBe("Ah. A clean morning, at any hour you like.");
    expect(RAKE_LINES.nagi).toBe("Nothing is erased. The sand only rests.");
    for (const id of RAKE_IDS) {
      expect(linesForTag(`rake:${id}`)).toEqual([RAKE_LINES[id]]);
      for (let n = 0; n < STORY_LENGTH; n++) expect(linesForTag(`story:${id}:${n}`)).toHaveLength(1);
    }
    expect(FIRST_VISIT_LINE).toBe("Take a rake. Any rake.");
    expect(linesForTag("basket")).toContain("Set a stone down and the sand has something to talk about.");
  });

  it("covers every trigger tag", () => {
    const tags = ["first", "idle", "rain", "sweep", "stone", "breath", "basket", "auto_start", "auto_done", "auto_yield"];
    for (const m of MOODS) tags.push(`mood:${m}`);
    for (const v of VARIANTS) tags.push(`variant:${v}`);
    for (const t of tags) expect(linesForTag(t).length, t).toBeGreaterThan(0);
    expect(BREATH_CUES).toMatchObject({ inhale: "In.", hold_in: "Hold.", exhale: "Out." });
  });

  it("has four lines each for getting up to rake, finishing, and giving the garden back", () => {
    const pools = { auto_start: AUTO_START_LINES, auto_done: AUTO_DONE_LINES, auto_yield: AUTO_YIELD_LINES };
    const all: string[] = [];
    for (const [tag, pool] of Object.entries(pools)) {
      expect(pool, tag).toHaveLength(4);
      expect(linesForTag(tag), tag).toEqual(pool);
      for (const text of pool) {
        expect(text.length, text).toBeLessThanOrEqual(MAX_LINE_CHARS);
        expect(text, text).not.toContain("!");
        expect(wrapBitmapLineCount(text), text).toBeLessThanOrEqual(MAX_LINE_ROWS);
      }
      all.push(...pool);
    }
    expect(new Set(all).size).toBe(12);
    // no line of his own is borrowed from another pool
    for (const text of all) expect(LINES.filter((l) => l.text === text), text).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const tick = (over: Partial<Extract<GubbaEvent, { type: "tick" }>> = {}): GubbaEvent => ({
  type: "tick",
  pointerOnWall: false,
  raking: false,
  rakeGridPos: null,
  rain: false,
  breathPhase: "inhale",
  ...over,
});

function fresh(mode: TalkMode = "sometimes", variant: GubbaVariant = "moss", seed = 7): GubbaState {
  return createGubbaState(variant, mode, {}, seed);
}

type EventKind = "tick" | "rake" | "mood" | "sweep" | "stone" | "rain" | "breath" | "raking";

const eventArb = fc.record({
  dt: fc.integer({ min: 0, max: 40_000 }),
  kind: fc.constantFrom<EventKind>("tick", "tick", "tick", "rake", "mood", "sweep", "stone", "rain", "breath", "raking"),
  rake: fc.constantFrom(...RAKE_IDS),
  mood: fc.constantFrom(...MOODS),
  on: fc.boolean(),
});

function toEvent(a: { kind: EventKind; rake: RakeId; mood: MoodId; on: boolean }): GubbaEvent {
  switch (a.kind) {
    case "tick":
      return tick();
    case "raking":
      return tick({ raking: true, rakeGridPos: { x: 40, y: 50 } });
    case "rake":
      return { type: "rake_selected", rakeId: a.rake };
    case "mood":
      return { type: "mood_changed", mood: a.mood };
    case "sweep":
      return { type: "sweep" };
    case "stone":
      return { type: "stone_placed" };
    case "rain":
      return { type: "rain_toggled", on: a.on };
    case "breath":
      return { type: "breath_toggled", on: a.on };
  }
}

/** Runs events and returns every new speech (identified by object identity). */
function run(g0: GubbaState, steps: ReadonlyArray<{ dt: number; ev: GubbaEvent }>) {
  let g = g0;
  let now = 0;
  const spoken: Array<{ at: number; text: string; forced: boolean }> = [];
  let last = g.speech;
  for (const { dt, ev } of steps) {
    now += dt;
    g = stepGubba(g, ev, now);
    if (g.speech !== null && g.speech !== last) {
      spoken.push({ at: g.speech.startedAtMs, text: g.speech.text, forced: g.speech.forced });
    }
    last = g.speech;
  }
  return { g, spoken };
}

describe("Gubba state machine", () => {
  it("is deterministic and does not mutate its input", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 60 }), fc.integer(), (arr, seed) => {
        const steps = arr.map((a) => ({ dt: a.dt, ev: toEvent(a) }));
        const a = run(createGubbaState("kasa", "companion", {}, seed), steps);
        const b = run(createGubbaState("kasa", "companion", {}, seed), steps);
        expect(a).toEqual(b);
      }),
      { numRuns: 60 },
    );
    const g = fresh();
    const snapshot = JSON.stringify(g);
    stepGubba(g, { type: "gubba_tapped", activeRake: "sugi" }, 1000);
    stepGubba(g, tick({ raking: true, rakeGridPos: { x: 5, y: 5 } }), 2000);
    expect(JSON.stringify(g)).toBe(snapshot);
  });

  it("greets a first visit with one fixed line", () => {
    const g = stepGubba(fresh("sometimes"), { type: "first_visit" }, 100);
    expect(g.speech?.text).toBe("Take a rake. Any rake.");
    expect(stepGubba(fresh("quiet"), { type: "first_visit" }, 100).speech).toBeNull();
  });

  it('"quiet" never speaks unsolicited, whatever happens', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 80 }), (arr) => {
        const steps = arr.map((a) => ({ dt: a.dt, ev: toEvent(a) }));
        steps.push({ dt: 0, ev: { type: "first_visit" } });
        const { spoken } = run(fresh("quiet"), steps);
        expect(spoken).toEqual([]);
      }),
      { numRuns: 80 },
    );
  });

  it('"sometimes" keeps unsolicited lines at least 90 s apart', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 120 }), fc.integer(), (arr, seed) => {
        const steps = arr.map((a) => ({ dt: a.dt, ev: toEvent(a) }));
        const { spoken } = run(createGubbaState("moss", "sometimes", {}, seed), steps);
        const unsolicited = spoken.filter((s) => !s.forced);
        for (let i = 1; i < unsolicited.length; i++) {
          expect(unsolicited[i]!.at - unsolicited[i - 1]!.at).toBeGreaterThanOrEqual(SOMETIMES_GAP_MS);
        }
      }),
      { numRuns: 120 },
    );
  });

  it('"sometimes" speaks the first pick of each rake, then waits 90 s', () => {
    let g = fresh("sometimes");
    g = stepGubba(g, { type: "rake_selected", rakeId: "sugi" }, 1000);
    expect(g.speech).toMatchObject({ text: RAKE_LINES.sugi, forced: false });
    const first = g.speech;
    g = stepGubba(g, { type: "rake_selected", rakeId: "onami" }, 10_000);
    expect(g.speech).toBe(first); // too soon: nothing new
    // a first pick that lands inside the 90 s gap is simply not voiced
    g = stepGubba(g, { type: "rake_selected", rakeId: "kinu" }, 1000 + SOMETIMES_GAP_MS);
    expect(g.speech?.text).toBe(RAKE_LINES.kinu);
  });

  it('"sometimes" offers one reflection after a long pause, and not before', () => {
    let g = fresh("sometimes");
    const spoken: number[] = [];
    let last = g.speech;
    for (let t = 0; t <= 170_000; t += 1000) {
      g = stepGubba(g, tick(), t);
      if (g.speech !== null && g.speech !== last) spoken.push(t);
      last = g.speech;
    }
    // quiet for 45 s, then one reflection, then at least 90 s before the next
    expect(spoken).toHaveLength(2);
    expect(spoken[0]).toBeGreaterThanOrEqual(45_000);
    expect(spoken[1]! - spoken[0]!).toBeGreaterThanOrEqual(SOMETIMES_GAP_MS);
  });

  it('"companion" speaks about once a minute', () => {
    let g = fresh("companion");
    const spoken: number[] = [];
    let last = g.speech;
    for (let t = 0; t <= 300_000; t += 1000) {
      g = stepGubba(g, tick({ raking: true, rakeGridPos: { x: 96, y: 56 } }), t);
      if (g.speech !== null && g.speech !== last) spoken.push(t);
      last = g.speech;
    }
    expect(spoken.length).toBeGreaterThanOrEqual(4);
    expect(spoken.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < spoken.length; i++) expect(spoken[i]! - spoken[i - 1]!).toBeGreaterThanOrEqual(60_000);
  });

  it("always answers a tap, in every mode, and tells the story one line per tap", () => {
    for (const mode of MODES) {
      let g = fresh(mode);
      for (let n = 0; n < STORY_LENGTH; n++) {
        g = stepGubba(g, { type: "gubba_tapped", activeRake: "tetsu" }, 5000 + n * 100);
        expect(g.speech?.text).toBe(storyLine("tetsu", n));
        expect(g.speech?.forced).toBe(true);
        expect(g.heardStories.tetsu).toBe(n + 1);
      }
      expect(hasStorySeal(g, "tetsu")).toBe(true);
      // after the story, a tap still speaks (a reflection) and the count stays at 3
      g = stepGubba(g, { type: "gubba_tapped", activeRake: "tetsu" }, 9000);
      expect(g.speech).not.toBeNull();
      expect(g.speech?.text.length).toBeGreaterThan(0);
      expect(g.heardStories.tetsu).toBe(STORY_LENGTH);
      expect(hasStorySeal(g, "sugi")).toBe(false);
    }
  });

  it("keeps stories per rake and carries earlier progress in", () => {
    const g0 = createGubbaState("moss", "quiet", { take: 2 }, 3);
    const g1 = stepGubba(g0, { type: "gubba_tapped", activeRake: "take" }, 10);
    expect(g1.speech?.text).toBe(storyLine("take", 2));
    expect(g1.heardStories.take).toBe(3);
    expect(g0.heardStories.take).toBe(2); // input untouched
    const g2 = stepGubba(g1, { type: "gubba_tapped", activeRake: "wa" }, 20);
    expect(g2.speech?.text).toBe(storyLine("wa", 0));
  });

  it("taps never repeat the same reflection back to back", () => {
    let g = createGubbaState("lantern", "quiet", Object.fromEntries(RAKE_IDS.map((r) => [r, 3])), 11);
    let prev = "";
    for (let i = 0; i < 80; i++) {
      g = stepGubba(g, { type: "gubba_tapped", activeRake: "sugi" }, 1000 * i);
      expect(g.speech?.text).not.toBe(prev);
      prev = g.speech?.text ?? "";
    }
  });

  it("cues In, Hold, Out for the first three cycles only, and only with the guide on", () => {
    const collect = (on: boolean, mode: TalkMode) => {
      let g = fresh(mode);
      if (on) g = stepGubba(g, { type: "breath_toggled", on: true }, 0);
      const cues: string[] = [];
      let last = g.speech;
      const period = breathPeriodMs("4-4-6");
      for (let t = 0; t < period * 6; t += 50) {
        const phase = breath("4-4-6", t).phase;
        g = stepGubba(g, tick({ breathPhase: phase, raking: true, rakeGridPos: { x: 96, y: 56 } }), t + 1);
        if (g.speech !== null && g.speech !== last && ["In.", "Hold.", "Out."].includes(g.speech.text)) {
          cues.push(g.speech.text);
        }
        last = g.speech;
      }
      return cues;
    };
    expect(collect(true, "sometimes")).toEqual(Array(3).fill(["In.", "Hold.", "Out."]).flat());
    expect(collect(false, "sometimes")).toEqual([]);
    expect(collect(true, "quiet")).toEqual([]);
  });

  it("raises the head toward the rake (max 0.5 rad) or the rack (0.55 rad)", () => {
    let g = fresh();
    g = stepGubba(g, tick({ raking: true, rakeGridPos: { x: 191, y: 10 } }), 100);
    expect(g.targetYaw).toBeCloseTo(0.5 * (191 - 96) / 96, 6);
    expect(g.watchingRake).toBe(true);
    g = stepGubba(g, tick({ raking: true, rakeGridPos: { x: 0, y: 10 } }), 200);
    expect(g.targetYaw).toBeCloseTo(-0.5, 6);
    g = stepGubba(g, tick({ pointerOnWall: true }), 300);
    expect(g.targetYaw).toBe(0.55);
    expect(g.glancingWall).toBe(true);
    g = stepGubba(g, tick(), 400);
    expect(g.targetYaw).toBe(0);
    fc.assert(
      fc.property(fc.double({ min: -1000, max: 1000, noNaN: true }), (x) => {
        const s = stepGubba(fresh(), tick({ raking: true, rakeGridPos: { x, y: 0 } }), 10);
        expect(Math.abs(s.targetYaw)).toBeLessThanOrEqual(0.5);
      }),
    );
  });

  it("blinks every 3-7 s, sips every 40-90 s, flicks the tail every 20-40 s", () => {
    let g = fresh("quiet", "moss", 99);
    const blinks: number[] = [];
    const sips: number[] = [];
    const tails: number[] = [];
    let b = g.blinkStartMs;
    let s = g.sipStartMs;
    let t0 = g.tailFlickStartMs;
    for (let t = 0; t <= 1_200_000; t += 100) {
      g = stepGubba(g, tick({ raking: true, rakeGridPos: { x: 96, y: 56 } }), t);
      if (g.blinkStartMs !== b) {
        blinks.push(g.blinkStartMs);
        b = g.blinkStartMs;
      }
      if (g.sipStartMs !== s) {
        sips.push(g.sipStartMs);
        s = g.sipStartMs;
      }
      if (g.tailFlickStartMs !== t0) {
        tails.push(g.tailFlickStartMs);
        t0 = g.tailFlickStartMs;
      }
    }
    const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);
    expect(blinks.length).toBeGreaterThan(100);
    for (const d of gaps(blinks)) {
      expect(d).toBeGreaterThanOrEqual(3000);
      expect(d).toBeLessThanOrEqual(7100);
    }
    expect(sips.length).toBeGreaterThan(10);
    for (const d of gaps(sips)) {
      expect(d).toBeGreaterThanOrEqual(40_000);
      expect(d).toBeLessThanOrEqual(90_100);
    }
    expect(tails.length).toBeGreaterThan(20);
    for (const d of gaps(tails)) {
      expect(d).toBeGreaterThanOrEqual(20_000);
      expect(d).toBeLessThanOrEqual(40_100);
    }
  });

  it("dozes after 3 minutes without input and wakes on any input", () => {
    let g = fresh("quiet");
    g = stepGubba(g, tick(), DOZE_AFTER_MS - 1);
    expect(g.dozing).toBe(false);
    g = stepGubba(g, tick(), DOZE_AFTER_MS);
    expect(g.dozing).toBe(true);
    g = stepGubba(g, tick(), DOZE_AFTER_MS + 60_000);
    expect(g.dozing).toBe(true);
    const woke = stepGubba(g, { type: "sweep" }, DOZE_AFTER_MS + 61_000);
    expect(woke.dozing).toBe(false);
    expect(woke.lastInputMs).toBe(DOZE_AFTER_MS + 61_000);
    // raking counts as input too
    expect(stepGubba(g, tick({ raking: true, rakeGridPos: { x: 1, y: 1 } }), DOZE_AFTER_MS + 61_000).dozing).toBe(false);
    // and a dozing Gubba is silent unless tapped
    const talkative = stepGubba(fresh("companion"), tick(), 500_000);
    expect(talkative.speech).toBeNull();
    expect(stepGubba(talkative, { type: "gubba_tapped", activeRake: "sugi" }, 500_100).speech).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

describe("Gubba pose", () => {
  interface PoseCase {
    variant: GubbaVariant;
    dozing: boolean;
    rain: boolean;
    watching: boolean;
    yaw: number;
    lastInput: number;
    blink: number;
    sip: number;
    tail: number;
    speechAt: number | null;
  }
  const stateArb: fc.Arbitrary<PoseCase> = fc.record({
    variant: fc.constantFrom(...VARIANTS),
    dozing: fc.boolean(),
    rain: fc.boolean(),
    watching: fc.boolean(),
    yaw: fc.double({ min: -5, max: 5, noNaN: true }),
    lastInput: fc.integer({ min: 0, max: 400_000 }),
    blink: fc.integer({ min: 0, max: 400_000 }),
    sip: fc.integer({ min: 0, max: 400_000 }),
    tail: fc.integer({ min: 0, max: 400_000 }),
    speechAt: fc.option(fc.integer({ min: 0, max: 400_000 }), { nil: null }),
  });

  function build(s: PoseCase): GubbaState {
    const g = createGubbaState(s.variant, "sometimes", {}, 1);
    g.dozing = s.dozing;
    g.rain = s.rain;
    g.watchingRake = s.watching;
    g.targetYaw = s.yaw;
    g.lastInputMs = s.lastInput;
    g.blinkStartMs = s.blink;
    g.sipStartMs = s.sip;
    g.tailFlickStartMs = s.tail;
    if (s.speechAt !== null) g.speech = { text: "Mm.", startedAtMs: s.speechAt, durationMs: 2200, forced: false };
    return g;
  }

  it("keeps every scale within 4% of rest and the head yaw within +-0.55 rad", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.double({ min: -0.5, max: 1.5, noNaN: true }),
        fc.integer({ min: 0, max: 500_000 }),
        (s, amp, now) => {
          const pose = poseGubba(build(s), amp, now);
          for (const name of GUBBA_NODE_NAMES) {
            const t = pose[name];
            for (const v of [t.scale.x, t.scale.y, t.scale.z]) {
              expect(v).toBeGreaterThanOrEqual(0.96);
              expect(v).toBeLessThanOrEqual(1.04);
            }
            for (const v of [t.pos.x, t.pos.y, t.pos.z, t.rot.x, t.rot.y, t.rot.z]) expect(Number.isFinite(v)).toBe(true);
          }
          expect(Math.abs(pose.Head.rot.y)).toBeLessThanOrEqual(HEAD_YAW_LIMIT);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("gives the same pose for the same state and time, for all three variants", () => {
    fc.assert(
      fc.property(stateArb, fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 0, max: 500_000 }), (s, amp, now) => {
        const g = build(s);
        const a = poseGubba(g, amp, now);
        const b = poseGubba(g, amp, now);
        expect(a).toEqual(b);
        // reusing an out record gives the same answer too
        const out = createPose();
        poseGubba(build({ ...s, yaw: 0.3 }), 0.7, now + 1234, { out });
        expect(poseGubba(g, amp, now, { out })).toEqual(a);
      }),
      { numRuns: 100 },
    );
    for (const v of VARIANTS) {
      const g = fresh("sometimes", v);
      expect(Object.keys(poseGubba(g, 0.4, 12_345)).sort()).toEqual([...GUBBA_NODE_NAMES].sort());
    }
  });

  it("squashes and stretches the body on the breath: (1+0.02a, 1+0.035a, 1+0.02a)", () => {
    for (const v of VARIANTS) {
      const g = fresh("quiet", v);
      expect(poseGubba(g, 0, 1000).Body.scale).toEqual({ x: 1, y: 1, z: 1 });
      const full = poseGubba(g, 1, 1000).Body.scale;
      expect(full.x).toBeCloseTo(1.02, 9);
      expect(full.y).toBeCloseTo(1.035, 9);
      expect(full.z).toBeCloseTo(1.02, 9);
      expect(poseGubba(g, 1, 1000).Head.pos.y).toBeCloseTo(0.6, 9);
    }
  });

  it("turns the head by the target yaw and slides the pupils with it", () => {
    const g = fresh();
    g.targetYaw = 0.5;
    const pose = poseGubba(g, 0, 0);
    expect(pose.Head.rot.y).toBe(0.5);
    expect(pose.PupilL.pos.x).toBeGreaterThan(0);
    expect(pose.PupilL.pos.x).toBeLessThanOrEqual(0.2 * 4 + 1e-9);
    expect(Math.abs(pose.PupilR.pos.x)).toBeLessThan(Math.abs(pose.PupilL.pos.x)); // out of step
    g.targetYaw = 9;
    expect(poseGubba(g, 0, 0).Head.rot.y).toBe(0.55);
    expect(poseGubba(g, 0, 0, { headYaw: -0.2 }).Head.rot.y).toBe(-0.2);
  });

  it("blinks lopsidedly: the sleepy eye closes 80 ms after the wide one, 280 ms each", () => {
    const g = fresh();
    g.blinkStartMs = 10_000;
    const at = (dt: number) => poseGubba(g, 0, 10_000 + dt);
    expect(at(-1).LidL.pos.y).toBe(0);
    expect(at(40).LidL.pos.y).toBeLessThan(0);
    expect(at(40).LidR.pos.y).toBe(0); // still waiting
    expect(at(81).LidR.pos.y).toBeLessThan(0);
    expect(at(140).LidL.pos.y).toBeCloseTo(-4, 6); // fully closed at the midpoint
    expect(at(220).LidR.pos.y).toBeCloseTo(-3, 6);
    expect(at(280).LidL.pos.y).toBe(0); // wide eye open again after 280 ms
    expect(at(300).LidR.pos.y).toBeLessThan(0); // sleepy eye is still finishing
    expect(at(361).LidR.pos.y).toBe(0);
  });

  it("opens the mouth 1 unit for the first 400 ms of a line only", () => {
    const g = fresh();
    g.speech = { text: "Mm.", startedAtMs: 5000, durationMs: 2200, forced: true };
    expect(poseGubba(g, 0, 4999).Mouth.pos.y).toBe(0);
    expect(poseGubba(g, 0, 5200).Mouth.pos.y).toBeCloseTo(-1, 9);
    expect(poseGubba(g, 0, 5399).Mouth.pos.y).toBeGreaterThan(-1);
    expect(poseGubba(g, 0, 5400).Mouth.pos.y).toBe(0);
    expect(poseGubba(g, 0, 6500).Mouth.pos.y).toBe(0);
  });

  it("up and raking himself, he does not doze, sip, or turn to follow anyone else's rake", () => {
    let g = fresh();
    const neverSipped = g.sipStartMs;
    for (let t = 0; t <= DOZE_AFTER_MS + 200_000; t += 1000) {
      g = stepGubba(g, tick({ working: true, raking: true, rakeGridPos: { x: 10, y: 50 }, pointerOnWall: true }), t);
      expect(g.dozing).toBe(false);
      expect(g.watchingRake).toBe(false);
      expect(g.glancingWall).toBe(false);
      expect(g.targetYaw).toBe(0);
    }
    // more than one sip came due in that time; none was taken
    expect(g.sipStartMs).toBe(neverSipped);
    // seated and idle again, the usual life resumes
    let idle = g;
    for (let t = DOZE_AFTER_MS + 201_000; t <= 2 * DOZE_AFTER_MS + 300_000; t += 1000) idle = stepGubba(idle, tick(), t);
    expect(idle.dozing).toBe(true);
  });

  it("back on the cushion with a garden finished, the tea comes 2.5 s later", () => {
    let g = fresh();
    for (let t = 0; t <= 50_000; t += 1000) g = stepGubba(g, tick({ working: true }), t);
    const before = g.sipStartMs;
    g = stepGubba(g, { type: "auto_done" }, 50_500);
    expect(g.nextSipMs).toBe(50_500 + AUTO_SIP_DELAY_MS);
    g = stepGubba(g, tick(), 50_500 + AUTO_SIP_DELAY_MS - 1);
    expect(g.sipStartMs).toBe(before);
    g = stepGubba(g, tick(), 50_500 + AUTO_SIP_DELAY_MS);
    expect(g.sipStartMs).toBe(50_500 + AUTO_SIP_DELAY_MS);
    expect(AUTO_SIP_DELAY_MS).toBe(2500);
  });

  it("remarks on getting up, finishing and giving way from the matching pool, and never in Quiet", () => {
    const pools = { auto_start: AUTO_START_LINES, auto_done: AUTO_DONE_LINES, auto_yield: AUTO_YIELD_LINES } as const;
    for (const type of ["auto_start", "auto_done", "auto_yield"] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        const companion = stepGubba(fresh("companion", "moss", seed), { type }, 200_000);
        expect(pools[type], `${type} ${seed}`).toContain(companion.speech?.text);
        expect(companion.dozing).toBe(false);
        const quiet = stepGubba(fresh("quiet", "moss", seed), { type }, 200_000);
        expect(quiet.speech, `${type} ${seed}`).toBeNull();
        const sometimes = stepGubba(fresh("sometimes", "moss", seed), { type }, 200_000);
        if (sometimes.speech !== null) expect(pools[type]).toContain(sometimes.speech.text);
      }
    }
  });

  it("sips for 1.2 s: arm strains up, head dips, cup lifts", () => {
    const g = fresh();
    g.sipStartMs = 20_000;
    const rest = poseGubba(g, 0, 19_999);
    const mid = poseGubba(g, 0, 20_600);
    const after = poseGubba(g, 0, 21_200);
    expect(mid.ArmR.rot.x).toBeLessThan(rest.ArmR.rot.x);
    expect(mid.Head.rot.x).toBeGreaterThan(rest.Head.rot.x);
    expect(mid.Head.pos.y).toBeLessThan(rest.Head.pos.y);
    expect(mid.Cup.pos.y).toBeGreaterThan(rest.Cup.pos.y);
    expect(after.ArmR.rot.x).toBe(rest.ArmR.rot.x);
    // a strain, not a flail
    expect(Math.abs(mid.ArmR.rot.x)).toBeLessThan(0.6);
  });

  it("flicks the tail only around the flick time", () => {
    const g = fresh();
    g.tailFlickStartMs = 30_000;
    const swing = (t: number) => Math.abs(poseGubba(g, 0, t).Tail1.rot.y);
    expect(swing(30_300)).toBeGreaterThan(0.3);
    expect(swing(35_000)).toBeLessThan(0.06); // only the idle sway remains
    expect(Math.abs(poseGubba(g, 0, 30_400).Tail3.rot.y)).toBeGreaterThan(0.2);
  });

  it("dozes: lids shut, head sinks 1 unit, the prop slips askew", () => {
    for (const v of VARIANTS) {
      const awake = fresh("sometimes", v);
      awake.lastInputMs = 0;
      const asleep = { ...awake, dozing: true };
      const t = DOZE_AFTER_MS + 5000;
      const a = poseGubba(awake, 0, t);
      const z = poseGubba(asleep, 0, t);
      expect(z.Head.pos.y - a.Head.pos.y).toBeCloseTo(-1, 9);
      expect(z.LidL.pos.y).toBeCloseTo(-4, 9);
      expect(z.LidR.pos.y).toBeCloseTo(-3, 9);
      const propName = v === "moss" ? "Prop_Bonsai" : v === "kasa" ? "Prop_Hat" : "Prop_Shell";
      expect(Math.abs(z[propName].rot.z - a[propName].rot.z - 0.3)).toBeLessThan(1e-9);
      expect(z[propName].pos.x).toBeGreaterThan(0);
      // easing in: just after the doze begins the head has barely moved
      const early = poseGubba(asleep, 0, DOZE_AFTER_MS + 10);
      expect(early.Head.pos.y).toBeGreaterThan(-0.05);
    }
  });

  it("moves only the variant's own prop, and out of phase with the breath", () => {
    const moveOf = (v: GubbaVariant) => {
      const p = poseGubba(fresh("quiet", v), 0, 777);
      return (["Prop_Bonsai", "Prop_Hat", "Prop_Shell"] as const).filter(
        (n) => p[n].pos.y !== 0 || p[n].rot.z !== 0,
      );
    };
    expect(moveOf("moss")).toEqual(["Prop_Bonsai"]);
    expect(moveOf("kasa")).toEqual(["Prop_Hat"]);
    expect(moveOf("lantern")).toEqual(["Prop_Shell"]);
    // same breath amplitude, different time: the prop still bobs
    const g = fresh("quiet", "moss");
    expect(poseGubba(g, 0.5, 100).Prop_Bonsai.pos.y).not.toBe(poseGubba(g, 0.5, 1500).Prop_Bonsai.pos.y);
  });

  it("raises both arms for the rain leaf, and sags the lantern's eye stalks asleep", () => {
    const g = fresh("quiet", "lantern");
    g.rain = true;
    const p = poseGubba(g, 0, 0);
    expect(p.ArmL.rot.x).toBeLessThan(-1);
    expect(p.ArmR.rot.x).toBeLessThan(-1);
    g.dozing = true;
    g.lastInputMs = 0;
    expect(poseGubba(g, 0, DOZE_AFTER_MS + 5000).EyeL.rot.x).toBeGreaterThan(0.3);
    const moss = fresh("quiet", "moss");
    moss.dozing = true;
    expect(poseGubba(moss, 0, DOZE_AFTER_MS + 5000).EyeL.rot.x).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// UI: settings, keys, DOM mirror
// ---------------------------------------------------------------------------

describe("settings actions", () => {
  it("swaps the Gubba variant moss -> kasa -> lantern -> moss without mutating", () => {
    const s0 = DEFAULT_SETTINGS;
    const s1 = nextGubbaVariant(s0);
    const s2 = nextGubbaVariant(s1);
    const s3 = nextGubbaVariant(s2);
    expect([s0.gubbaVariant, s1.gubbaVariant, s2.gubbaVariant, s3.gubbaVariant]).toEqual(["moss", "kasa", "lantern", "moss"]);
    expect(DEFAULT_SETTINGS.gubbaVariant).toBe("moss");
    expect(setGubbaVariant(s0, "lantern").gubbaVariant).toBe("lantern");
    expect(setGubbaVariant(s0, "moss")).toBe(s0);
  });

  it("cycles the mood setting through auto and the four moods", () => {
    let s = DEFAULT_SETTINGS;
    const seen = [s.moodSetting];
    for (let i = 0; i < 5; i++) seen.push((s = nextMoodSetting(s)).moodSetting);
    expect(seen).toEqual(["auto", "morning", "afternoon", "dusk", "moonlit", "auto"]);
    expect(setMoodSetting(s, "dusk").moodSetting).toBe("dusk");
  });

  it("resolves the effective mood from the clock only when auto", () => {
    const expected: Array<[number, MoodId]> = [
      [0, "moonlit"], [4, "moonlit"], [5, "morning"], [10, "morning"], [11, "afternoon"],
      [16, "afternoon"], [17, "dusk"], [19, "dusk"], [20, "moonlit"], [23, "moonlit"],
    ];
    for (const [h, m] of expected) {
      expect(moodFromHour(h)).toBe(m);
      expect(effectiveMood("auto", h)).toBe(m);
      expect(effectiveMood("dusk", h)).toBe("dusk");
    }
    expect(moodFromHour(25)).toBe(moodFromHour(1));
    expect(moodFromHour(-1)).toBe("moonlit");
  });

  it("toggles auto and manual mood, keeping the mood on screen", () => {
    const manual = toggleMoodAuto(DEFAULT_SETTINGS, 13);
    expect(manual.moodSetting).toBe("afternoon");
    expect(toggleMoodAuto(manual, 13).moodSetting).toBe("auto");
  });

  it("toggles density, flow, rain, breath, mute", () => {
    expect(toggleDensity(DEFAULT_SETTINGS).density).toBe("chunky");
    expect(toggleDensity(toggleDensity(DEFAULT_SETTINGS)).density).toBe("crisp");
    expect(toggleFlow(DEFAULT_SETTINGS).flow).toBe(false);
    expect(toggleRain(DEFAULT_SETTINGS).rain).toBe(true);
    expect(toggleBreath(DEFAULT_SETTINGS).breathEnabled).toBe(true);
    const muted = toggleMute(DEFAULT_SETTINGS);
    expect(muted.mix.muted).toBe(true);
    expect(DEFAULT_SETTINGS.mix.muted).toBe(false);
  });

  it("clamps the audio mix to 0..7", () => {
    expect(adjustMix(DEFAULT_SETTINGS, "master", 100).mix.master).toBe(7);
    expect(adjustMix(DEFAULT_SETTINGS, "music", -100).mix.music).toBe(0);
    expect(adjustMix(DEFAULT_SETTINGS, "foley", 1).mix.foley).toBe(7);
    expect(adjustMix(DEFAULT_SETTINGS, "ambience", -1).mix.ambience).toBe(3);
    expect(adjustMix(DEFAULT_SETTINGS, "master", Number.NaN).mix.master).toBe(0);
    expect(DEFAULT_SETTINGS.mix.master).toBe(5);
  });

  it("copies heard stories into settings", () => {
    const s = withHeardStories(DEFAULT_SETTINGS, { sugi: 3, wa: 1 });
    expect(s.heardStories).toEqual({ sugi: 3, wa: 1 });
    expect(hasStorySeal(s, "sugi")).toBe(true);
    expect(hasStorySeal(s, "wa")).toBe(false);
    expect(withHeardStories(s, { sugi: 3, wa: 1 })).toBe(s);
  });
});

describe("keyboard mapping", () => {
  const down = (key: string, extra: Partial<Parameters<typeof mapKeyDown>[0]> = {}) => mapKeyDown({ key, ...extra });

  it("maps 1-9 to the rakes and 0 to a held sweep", () => {
    const rakes = ["sugi", "onami", "kinu", "hisui", "mikazuki", "tetsu", "wa", "take", "nagi"];
    rakes.forEach((r, i) => expect(down(String(i + 1))).toEqual({ type: "select_rake", rake: r }));
    expect(down("0")).toEqual({ type: "sweep", held: true });
    expect(mapKeyUp({ key: "0" })).toEqual({ type: "sweep", held: false });
    expect(mapKeyUp({ key: "1" })).toBeNull();
    expect(down("!", { code: "Digit1", shiftKey: true })).toEqual({ type: "select_rake", rake: "sugi" });
  });

  it("maps the letter keys", () => {
    const table: Array<[string, UiCommand["type"]]> = [
      ["p", "basket"], ["z", "undo"], ["y", "redo"], ["b", "toggle_breath"], ["m", "toggle_mute"],
      ["t", "next_mood"], ["c", "next_camera"], ["x", "toggle_density"], ["g", "next_talk_mode"],
      ["e", "export"], ["Escape", "menu"], ["Enter", "virtual_toggle"],
    ];
    for (const [key, type] of table) {
      expect(down(key)?.type, key).toBe(type);
      if (key.length === 1) expect(down(key.toUpperCase())?.type, key).toBe(type);
    }
    expect(down("Z", { shiftKey: true })).toEqual({ type: "redo" });
    expect(down("z", { ctrlKey: true })).toEqual({ type: "undo" });
    expect(down("q")).toEqual({ type: "orbit", dir: -1 });
    expect(down("w")).toEqual({ type: "orbit", dir: 1 });
  });

  it("maps R to Gubba mode, and leaves the browser its reload", () => {
    expect(down("r")).toEqual({ type: "toggle_gubba_mode" });
    expect(down("R")).toEqual({ type: "toggle_gubba_mode" });
    expect(down("R", { shiftKey: true })).toEqual({ type: "toggle_gubba_mode" });
    expect(down("r", { ctrlKey: true })).toBeNull();
    expect(down("r", { metaKey: true })).toBeNull();
    expect(down("r", { altKey: true })).toBeNull();
    expect(down("R", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(down("r", { repeat: true })).toBeNull();
    expect(down("r", { targetTag: "INPUT" })).toBeNull();
    expect(mapKeyUp({ key: "r" })).toBeNull();
  });

  it("maps the arrows to the virtual rake, repeating", () => {
    expect(down("ArrowLeft")).toEqual({ type: "virtual_move", dx: -1, dy: 0, fast: false });
    expect(down("ArrowDown", { shiftKey: true, repeat: true })).toEqual({ type: "virtual_move", dx: 0, dy: 1, fast: true });
    expect(down("b", { repeat: true })).toBeNull();
  });

  it("leaves keys alone for text fields, modifiers, and focused buttons", () => {
    expect(down("g", { targetTag: "INPUT" })).toBeNull();
    expect(down("Enter", { targetTag: "BUTTON" })).toBeNull();
    expect(down(" ", { targetTag: "BUTTON" })).toBeNull();
    expect(down("1", { targetTag: "BUTTON" })).toEqual({ type: "select_rake", rake: "sugi" });
    expect(down("m", { altKey: true })).toBeNull();
    expect(down("m", { ctrlKey: true })).toBeNull();
    expect(down("F5")).toBeNull();
  });
});

// A just-big-enough fake DOM. `innerHTML` and `outerHTML` throw, to prove the mirror never uses them.
class FakeEl {
  id = "";
  children: FakeEl[] = [];
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  listeners = new Map<string, Array<() => void>>();
  parent: FakeEl | null = null;
  private text = "";
  constructor(readonly tagName: string) {}
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this.text;
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  set innerHTML(_v: string) {
    throw new Error("innerHTML is forbidden");
  }
  set outerHTML(_v: string) {
    throw new Error("outerHTML is forbidden");
  }
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  removeChild(c: FakeEl): FakeEl {
    this.children = this.children.filter((x) => x !== c);
    return c;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(t: string, fn: () => void): void {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  removeEventListener(t: string, fn: () => void): void {
    this.listeners.set(t, (this.listeners.get(t) ?? []).filter((f) => f !== fn));
  }
  click(): void {
    for (const f of this.listeners.get("click") ?? []) f();
  }
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

function fakeDoc() {
  const body = new FakeEl("BODY");
  const doc = {
    body,
    createElement: (tag: string) => new FakeEl(tag.toUpperCase()),
    getElementById: (id: string) => body.all().find((e) => e.id === id) ?? null,
  };
  return { doc: doc as unknown as Document, body };
}

describe("DOM mirror", () => {
  it("creates #sr-controls and #sr-live with a labelled button for every control", () => {
    const { doc, body } = fakeDoc();
    const seen: UiCommand[] = [];
    const m = createDomMirror(doc, (c) => seen.push(c));
    expect(m.live.getAttribute("aria-live")).toBe("polite");
    expect(m.controls.id).toBe("sr-controls");
    expect(m.live.id).toBe("sr-live");
    m.sync({ settings: DEFAULT_SETTINGS, mood: "afternoon" });
    const buttons = body.all().filter((e) => e.tagName === "BUTTON");
    expect(buttons).toHaveLength(CONTROL_COUNT);
    for (const b of buttons) {
      expect(b.getAttribute("aria-label"), b.getAttribute("data-control") ?? "").toBeTruthy();
      expect(b.textContent).toBe(b.getAttribute("aria-label"));
      expect(b.getAttribute("type")).toBe("button");
    }
    const ids = buttons.map((b) => b.getAttribute("data-control"));
    for (const want of [
      ...RAKE_IDS.filter((r) => r !== "hoki").map((r) => `rake-${r}`),
      "sweep", "basket", "hud-undo", "hud-redo", "hud-breath", "hud-mood", "hud-sound", "hud-menu",
      "gubba-variant", "mood-auto", "camera", "density", "breath-pattern", "rain", "flow", "talk-mode", "export",
      "preset-still_sand", "preset-checker_field",
    ]) {
      expect(ids, want).toContain(want);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(buttons.map((b) => b.getAttribute("aria-label"))).size).toBe(buttons.length);
    // clicking dispatches the command
    buttons.find((b) => b.getAttribute("data-control") === "gubba-variant")!.click();
    buttons.find((b) => b.getAttribute("data-control") === "rake-take")!.click();
    expect(seen).toEqual([{ type: "next_gubba_variant" }, { type: "select_rake", rake: "take" }]);
  });

  it("reuses existing elements and keeps labels and pressed states in step with settings", () => {
    const { doc, body } = fakeDoc();
    const existing = new FakeEl("DIV");
    existing.id = "sr-controls";
    body.appendChild(existing);
    const m = createDomMirror(doc, () => undefined);
    expect(m.controls).toBe(existing as unknown as HTMLElement);
    const find = (id: string) => body.all().find((e) => e.getAttribute("data-control") === id)!;
    m.sync({ settings: DEFAULT_SETTINGS, mood: "afternoon" });
    expect(find("rake-sugi").getAttribute("aria-pressed")).toBe("true");
    expect(find("rake-wa").getAttribute("aria-pressed")).toBe("false");
    expect(find("gubba-variant").getAttribute("aria-label")).toContain("Moss Yabba");
    expect(find("mood-auto").getAttribute("aria-label")).toContain("follows the clock");
    const next = toggleRain(setGubbaVariant(setMoodSetting(DEFAULT_SETTINGS, "dusk"), "lantern"));
    m.sync({ settings: { ...next, rake: "wa" }, mood: "dusk" });
    expect(find("rake-wa").getAttribute("aria-pressed")).toBe("true");
    expect(find("gubba-variant").getAttribute("aria-label")).toContain("Lantern Yabba");
    expect(find("mood-auto").getAttribute("aria-label")).toContain("manual");
    expect(find("rain").getAttribute("aria-pressed")).toBe("true");
  });

  it("has a Gubba mode button under Presets that says and shows whether it is on", () => {
    const { doc, body } = fakeDoc();
    const seen: UiCommand[] = [];
    const m = createDomMirror(doc, (c) => seen.push(c));
    const find = (id: string) => body.all().find((e) => e.getAttribute("data-control") === id)!;
    m.sync({ settings: DEFAULT_SETTINGS, mood: "afternoon" });
    expect(find("gubba-mode").getAttribute("aria-pressed")).toBe("false");
    expect(find("gubba-mode").getAttribute("aria-label")).toBe("Gubba mode, off. Gubba rakes one garden after another");
    m.sync({ settings: DEFAULT_SETTINGS, mood: "afternoon", gubbaMode: true });
    expect(find("gubba-mode").getAttribute("aria-pressed")).toBe("true");
    expect(find("gubba-mode").getAttribute("aria-label")).toBe("Gubba mode, on. Gubba rakes one garden after another");
    expect(find("gubba-mode").textContent).toBe(find("gubba-mode").getAttribute("aria-label"));
    m.sync({ settings: DEFAULT_SETTINGS, mood: "afternoon", gubbaMode: false, watchGubbaRake: true });
    expect(find("gubba-mode").getAttribute("aria-pressed")).toBe("false");
    expect(find("watch-gubba-rake").getAttribute("aria-pressed")).toBe("true");
    // it sits with the presets, right after the Watch switch
    const ids = body.all().filter((e) => e.tagName === "BUTTON").map((b) => b.getAttribute("data-control"));
    expect(ids.indexOf("gubba-mode")).toBe(ids.indexOf("watch-gubba-rake") + 1);
    expect(find("gubba-mode").parent).toBe(find("watch-gubba-rake").parent);
    find("gubba-mode").click();
    expect(seen).toEqual([{ type: "toggle_gubba_mode" }]);
  });

  it("mirrors every Gubba line into the live region with textContent only", () => {
    const { doc } = fakeDoc();
    const m = createDomMirror(doc, () => undefined);
    const live = m.live as unknown as FakeEl;
    m.mirrorSpeech(null);
    expect(live.textContent).toBe("");
    const line = { text: "Mm.", startedAtMs: 100, durationMs: 2200, forced: false };
    m.mirrorSpeech(line);
    expect(live.textContent).toBe("Mm.");
    const node = live.firstChild;
    m.mirrorSpeech({ ...line }); // same line again: not re-announced
    expect(live.firstChild).toBe(node);
    m.mirrorSpeech({ ...line, startedAtMs: 9000 }); // same words, new utterance: announced again
    expect(live.firstChild).not.toBe(node);
    m.say("<b>not markup</b>");
    expect(live.textContent).toBe("<b>not markup</b>");
    expect(live.children).toHaveLength(1);
    m.dispose();
    expect(live.children).toHaveLength(0);
  });

  it("announces each line Gubba actually says, across a run", () => {
    const { doc } = fakeDoc();
    const m = createDomMirror(doc, () => undefined);
    let g = fresh("sometimes");
    g = stepGubba(g, { type: "first_visit" }, 0);
    m.mirrorSpeech(g.speech);
    expect((m.live as unknown as FakeEl).textContent).toBe("Take a rake. Any rake.");
    g = stepGubba(g, { type: "gubba_tapped", activeRake: "sugi" }, 5000);
    m.mirrorSpeech(g.speech);
    expect((m.live as unknown as FakeEl).textContent).toBe(storyLine("sugi", 0));
  });
});
