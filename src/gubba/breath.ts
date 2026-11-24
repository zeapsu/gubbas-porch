import type { BreathPatternId, BreathPhase } from "../state/types.ts";

/**
 * The breath clock (DESIGN.md section 6). A pure function of the pattern and
 * elapsed time. Gubba always breathes on this clock, whether the guide is on or
 * off, so the guide only reveals a rhythm that was already there.
 */

export interface BreathSample {
  phase: BreathPhase;
  /** 0 when the lungs are empty, 1 when full. Continuous in [0, 1]. */
  amplitude: number;
  /** Whole cycles completed before this one (0 for the first cycle). */
  cycleIndex: number;
}

/** Phase lengths in milliseconds: inhale, hold_in, exhale, hold_out. */
type Segments = readonly [number, number, number, number];

export const BREATH_SEGMENTS_MS: Readonly<Record<BreathPatternId, Segments>> = {
  "4-4-6": [4000, 4000, 6000, 0],
  "4-7-8": [4000, 7000, 8000, 0],
  box: [4000, 4000, 4000, 4000],
};

const PHASE_ORDER: readonly BreathPhase[] = ["inhale", "hold_in", "exhale", "hold_out"];

export function breathPeriodMs(pattern: BreathPatternId): number {
  const s = BREATH_SEGMENTS_MS[pattern];
  return s[0] + s[1] + s[2] + s[3];
}

function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Writes the sample for `elapsedMs` into `out` (no allocation) and returns it. */
export function breathInto(out: BreathSample, pattern: BreathPatternId, elapsedMs: number): BreathSample {
  const s = BREATH_SEGMENTS_MS[pattern];
  const period = breathPeriodMs(pattern);
  const safe = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  const cycle = Math.floor(safe / period);
  let t = safe - cycle * period;
  if (t < 0) t = 0;
  if (t >= period) t = period - 1e-9;
  out.cycleIndex = cycle < 0 ? 0 : cycle;

  let phaseIndex = 0;
  for (; phaseIndex < 3; phaseIndex++) {
    const len = s[phaseIndex] ?? 0;
    if (t < len) break;
    t -= len;
  }
  // Zero-length trailing phases (hold_out in 4-4-6) can never be selected above
  // because t < period guarantees an earlier phase still has room.
  const len = s[phaseIndex] ?? 1;
  const progress = len > 0 ? t / len : 0;
  out.phase = PHASE_ORDER[phaseIndex] ?? "inhale";
  switch (out.phase) {
    case "inhale":
      out.amplitude = smoothstep(progress);
      break;
    case "hold_in":
      out.amplitude = 1;
      break;
    case "exhale":
      out.amplitude = 1 - smoothstep(progress);
      break;
    case "hold_out":
      out.amplitude = 0;
      break;
  }
  return out;
}

export function breath(pattern: BreathPatternId, elapsedMs: number): BreathSample {
  return breathInto({ phase: "inhale", amplitude: 0, cycleIndex: 0 }, pattern, elapsedMs);
}
