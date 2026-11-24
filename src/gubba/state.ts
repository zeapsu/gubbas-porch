import type {
  BreathPhase,
  GubbaEvent,
  GubbaState,
  GubbaVariant,
  RakeId,
  TalkMode,
} from "../state/types.ts";
import {
  BREATH_CUES,
  FIRST_VISIT_LINE,
  RAKE_IDS,
  RAKE_LINES,
  STORY_LENGTH,
  linesForTag,
  storyLine,
} from "./lines.ts";

/**
 * Gubba's state machine (DESIGN.md 5.2). Pure: time and randomness come in as
 * arguments (`nowMs`, and an xorshift32 stream kept in `g.rngState`).
 *
 * Conventions:
 * - `nowMs` is session time: pass milliseconds since `createGubbaState`
 *   (or set `opts.startMs` to the first clock reading).
 * - `speech.forced` is true for lines that bypass the talk-mode gap rules
 *   (taps, the one-off greeting, breath cues) and false for unsolicited lines.
 *   The 90 s rule applies to unsolicited lines only.
 * - `breathCyclesShown === -1` means the breath guide is off.
 * - `targetYaw` is the yaw the head wants; the renderer should damp it
 *   (see `dampYaw` in pose.ts).
 */

export const DOZE_AFTER_MS = 180_000;
export const SOMETIMES_GAP_MS = 90_000;
export const COMPANION_GAP_MS = 60_000;
/** In "Now and then", a reflection needs this long without input first. */
export const REFLECTION_QUIET_MS = 45_000;
export const BREATH_CUE_CYCLES = 3;
export const WATCH_YAW_MAX = 0.5;
export const WALL_YAW = 0.55;

const GRID_W = 192;
const REACT_CHANCE = 1 / 3;
const LATER_RAKE_LINE_CHANCE = 1 / 4;
const COMPANION_STORY_CHANCE = 1 / 3;
const CUE_MS = 1400;
/** Wake-up blink: start it half way through so the lids are shut now and open over 140 ms. */
const WAKE_BLINK_BACKDATE_MS = 140;
const IDLE_ANIM_START = -100_000;
/** Back on the cushion with a garden finished, the tea comes this soon. */
export const AUTO_SIP_DELAY_MS = 2500;

export interface CreateGubbaOptions {
  /** The clock reading at creation. Default 0. */
  startMs?: number;
  /** Start with the breath guide on. Default false. */
  breathOn?: boolean;
}

function seedToRngState(seed: number): number {
  let s = (Math.imul(seed | 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
  if (s === 0) s = 0x2545f491;
  return s;
}

function nextRand(g: GubbaState): number {
  let x = g.rngState >>> 0;
  if (x === 0) x = 0x2545f491;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  g.rngState = x;
  return x / 4294967296;
}

function range(g: GubbaState, lo: number, hi: number): number {
  return lo + nextRand(g) * (hi - lo);
}

export function createGubbaState(
  variant: GubbaVariant,
  talkMode: TalkMode,
  heardStories: Partial<Record<RakeId, number>>,
  seed: number,
  opts: CreateGubbaOptions = {},
): GubbaState {
  const start = opts.startMs ?? 0;
  const g: GubbaState = {
    variant,
    talkMode,
    dozing: false,
    rain: false,
    watchingRake: false,
    glancingWall: false,
    targetYaw: 0,
    lastInputMs: start,
    // "Now and then" may speak at once (the first rake pick); Companion waits a minute first.
    lastUnsolicitedSpeakMs: talkMode === "companion" ? start : start - SOMETIMES_GAP_MS,
    nextBlinkMs: 0,
    blinkStartMs: start + IDLE_ANIM_START,
    nextSipMs: 0,
    sipStartMs: start + IDLE_ANIM_START,
    nextTailFlickMs: 0,
    tailFlickStartMs: start + IDLE_ANIM_START,
    breathCyclesShown: opts.breathOn ? 0 : -1,
    lastBreathPhase: null,
    speech: null,
    heardStories: { ...heardStories },
    sessionIntroducedRakes: {},
    lineCursor: -1,
    rngState: seedToRngState(seed),
  };
  nextRand(g);
  nextRand(g);
  g.nextBlinkMs = start + range(g, 3000, 7000);
  g.nextSipMs = start + range(g, 40_000, 90_000);
  g.nextTailFlickMs = start + range(g, 20_000, 40_000);
  return g;
}

export function speechDurationMs(text: string): number {
  const ms = 1800 + text.length * 60;
  return ms < 2200 ? 2200 : ms > 7500 ? 7500 : ms;
}

export function isSpeaking(g: GubbaState, nowMs: number): boolean {
  const s = g.speech;
  return s !== null && nowMs < s.startedAtMs + s.durationMs;
}

function isCue(text: string): boolean {
  return text === "In." || text === "Hold." || text === "Out.";
}

function speak(g: GubbaState, text: string, nowMs: number, forced: boolean, durationMs?: number): void {
  g.speech = {
    text,
    startedAtMs: nowMs,
    durationMs: durationMs ?? speechDurationMs(text),
    forced,
  };
}

function gapFor(mode: TalkMode): number {
  return mode === "companion" ? COMPANION_GAP_MS : SOMETIMES_GAP_MS;
}

function canSpeakUnsolicited(g: GubbaState, nowMs: number): boolean {
  if (g.talkMode === "quiet" || g.dozing) return false;
  if (isSpeaking(g, nowMs)) return false;
  return nowMs - g.lastUnsolicitedSpeakMs >= gapFor(g.talkMode);
}

function speakUnsolicited(g: GubbaState, text: string, nowMs: number): void {
  speak(g, text, nowMs, false);
  g.lastUnsolicitedSpeakMs = nowMs;
}

function pick(g: GubbaState, pool: readonly string[]): string | undefined {
  if (pool.length === 0) return undefined;
  return pool[Math.min(pool.length - 1, Math.floor(nextRand(g) * pool.length))];
}

/**
 * A reflection from the idle pool plus the current variant's lines (and the
 * breath lines while the guide is on), never the same one twice running.
 */
function reflection(g: GubbaState): string {
  const idle = linesForTag("idle");
  const variant = linesForTag(`variant:${g.variant}`);
  const breath = g.breathCyclesShown >= 0 ? linesForTag("breath") : [];
  const total = idle.length + variant.length + breath.length;
  let i = Math.min(total - 1, Math.floor(nextRand(g) * total));
  if (i === g.lineCursor && total > 1) i = (i + 1) % total;
  g.lineCursor = i;
  const line =
    i < idle.length
      ? idle[i]
      : i < idle.length + variant.length
        ? variant[i - idle.length]
        : breath[i - idle.length - variant.length];
  return line ?? "Mm.";
}

function markInput(g: GubbaState, nowMs: number): void {
  if (g.dozing) {
    g.dozing = false;
    g.blinkStartMs = nowMs - WAKE_BLINK_BACKDATE_MS;
    if (g.nextBlinkMs < nowMs + 3000) g.nextBlinkMs = nowMs + range(g, 3000, 7000);
  }
  g.lastInputMs = nowMs;
}

/** Talk-mode gated reaction to an event. Draws one random number whatever happens. */
function react(g: GubbaState, pool: readonly string[], nowMs: number): void {
  const roll = nextRand(g);
  const chance = g.talkMode === "companion" ? 1 : REACT_CHANCE;
  if (roll >= chance || !canSpeakUnsolicited(g, nowMs)) return;
  const text = pick(g, pool);
  if (text !== undefined) speakUnsolicited(g, text, nowMs);
}

function yawForRake(x: number): number {
  const n = (x - GRID_W / 2) / (GRID_W / 2);
  const c = n < -1 ? -1 : n > 1 ? 1 : n;
  return c * WATCH_YAW_MAX;
}

function cueForPhase(phase: BreathPhase): string {
  return BREATH_CUES[phase];
}

function onTick(g: GubbaState, e: Extract<GubbaEvent, { type: "tick" }>, nowMs: number): void {
  g.rain = e.rain;
  // Up and raking himself, he is busy: awake, not sipping, and with no one else's rake to follow
  const working = e.working === true;
  if (e.raking || e.pointerOnWall || working) markInput(g, nowMs);
  g.watchingRake = e.raking && !working;
  g.glancingWall = e.pointerOnWall && !e.raking && !working;
  if (working) g.targetYaw = 0;
  else if (e.raking && e.rakeGridPos) g.targetYaw = yawForRake(e.rakeGridPos.x);
  else if (g.glancingWall) g.targetYaw = WALL_YAW;
  else g.targetYaw = 0;

  const s = g.speech;
  if (s !== null && nowMs >= s.startedAtMs + s.durationMs) g.speech = null;

  if (!g.dozing && nowMs - g.lastInputMs >= DOZE_AFTER_MS) g.dozing = true;

  if (nowMs >= g.nextBlinkMs) {
    if (!g.dozing) g.blinkStartMs = nowMs;
    g.nextBlinkMs = nowMs + range(g, 3000, 7000);
  }
  if (nowMs >= g.nextSipMs) {
    if (!g.dozing && !working) g.sipStartMs = nowMs;
    g.nextSipMs = nowMs + range(g, 40_000, 90_000);
  }
  if (nowMs >= g.nextTailFlickMs) {
    g.tailFlickStartMs = nowMs;
    g.nextTailFlickMs = nowMs + range(g, 20_000, 40_000);
  }

  // Breath cues: first three cycles after the guide is switched on.
  if (g.breathCyclesShown >= 0 && e.breathPhase !== g.lastBreathPhase) {
    if (e.breathPhase === "inhale" && g.lastBreathPhase !== null) g.breathCyclesShown++;
    g.lastBreathPhase = e.breathPhase;
    if (
      g.breathCyclesShown < BREATH_CUE_CYCLES &&
      g.talkMode !== "quiet" &&
      !g.dozing &&
      !(g.speech !== null && isSpeaking(g, nowMs) && g.speech.forced && !isCue(g.speech.text))
    ) {
      speak(g, cueForPhase(e.breathPhase), nowMs, true, CUE_MS);
    }
  }

  // Unsolicited speech from the clock alone.
  if (g.talkMode === "sometimes") {
    if (nowMs - g.lastInputMs >= REFLECTION_QUIET_MS && canSpeakUnsolicited(g, nowMs)) {
      speakUnsolicited(g, reflection(g), nowMs);
    }
  } else if (g.talkMode === "companion" && canSpeakUnsolicited(g, nowMs)) {
    speakUnsolicited(g, companionLine(g), nowMs);
  }
}

/** A story line for a rake used this session whose story is unfinished, else a reflection. */
function companionLine(g: GubbaState): string {
  const roll = nextRand(g);
  if (roll < COMPANION_STORY_CHANCE) {
    for (const id of RAKE_IDS) {
      const heard = g.heardStories[id] ?? 0;
      if (g.sessionIntroducedRakes[id] === true && heard < STORY_LENGTH) {
        g.heardStories[id] = heard + 1;
        return storyLine(id, heard);
      }
    }
  }
  return reflection(g);
}

function onTap(g: GubbaState, rake: RakeId, nowMs: number): void {
  markInput(g, nowMs);
  const heard = g.heardStories[rake] ?? 0;
  if (heard < STORY_LENGTH) {
    g.heardStories[rake] = heard + 1;
    speak(g, storyLine(rake, heard), nowMs, true);
  } else {
    speak(g, reflection(g), nowMs, true);
  }
}

/**
 * Advances `g` in place and returns it. For the per-frame path, so a quiet tick
 * allocates nothing. Use `stepGubba` for the pure, copying form.
 */
export function stepGubbaInPlace(g: GubbaState, e: GubbaEvent, nowMs: number): GubbaState {
  switch (e.type) {
    case "tick":
      onTick(g, e, nowMs);
      break;
    case "rake_selected": {
      markInput(g, nowMs);
      const first = g.sessionIntroducedRakes[e.rakeId] !== true;
      g.sessionIntroducedRakes[e.rakeId] = true;
      const roll = nextRand(g);
      if ((first || roll < LATER_RAKE_LINE_CHANCE) && canSpeakUnsolicited(g, nowMs)) {
        speakUnsolicited(g, RAKE_LINES[e.rakeId], nowMs);
      }
      break;
    }
    case "mood_changed":
      react(g, linesForTag(`mood:${e.mood}`), nowMs);
      break;
    case "gubba_tapped":
      onTap(g, e.activeRake, nowMs);
      break;
    case "sweep":
      markInput(g, nowMs);
      react(g, linesForTag("sweep"), nowMs);
      break;
    case "stone_placed":
      markInput(g, nowMs);
      react(g, [...linesForTag("stone"), ...linesForTag("basket")], nowMs);
      break;
    case "rain_toggled":
      markInput(g, nowMs);
      g.rain = e.on;
      if (e.on) react(g, linesForTag("rain"), nowMs);
      break;
    case "breath_toggled":
      markInput(g, nowMs);
      if (e.on) {
        g.breathCyclesShown = 0;
        g.lastBreathPhase = null;
      } else {
        g.breathCyclesShown = -1;
        g.lastBreathPhase = null;
      }
      break;
    case "talk_mode_changed":
      markInput(g, nowMs);
      g.talkMode = e.mode;
      break;
    case "first_visit":
      markInput(g, nowMs);
      if (g.talkMode !== "quiet") speak(g, FIRST_VISIT_LINE, nowMs, true);
      break;
    case "auto_start":
      markInput(g, nowMs);
      react(g, linesForTag("auto_start"), nowMs);
      break;
    case "auto_done":
      markInput(g, nowMs);
      react(g, linesForTag("auto_done"), nowMs);
      g.nextSipMs = nowMs + AUTO_SIP_DELAY_MS;
      break;
    case "auto_yield":
      markInput(g, nowMs);
      react(g, linesForTag("auto_yield"), nowMs);
      break;
  }
  return g;
}

/** Pure step: returns a new state and leaves `g` untouched. */
export function stepGubba(g: GubbaState, e: GubbaEvent, nowMs: number): GubbaState {
  return stepGubbaInPlace(
    {
      ...g,
      heardStories: { ...g.heardStories },
      sessionIntroducedRakes: { ...g.sessionIntroducedRakes },
    },
    e,
    nowMs,
  );
}
