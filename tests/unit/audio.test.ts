import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { MoodId } from "../../src/state/types.ts";
import { events, isDrone, midiToHz, MOODS } from "../../src/audio/composer.ts";
import { AudioEngine, mixGain } from "../../src/audio/engine.ts";
import { computeFoleyParams } from "../../src/audio/foley.ts";

const moods = ["morning", "afternoon", "dusk", "moonlit"] as const;
const seedAndMood = [fc.integer(), fc.constantFrom(...moods)] as const;

describe("composer", () => {
  it("is deterministic and additive over arbitrary adjacent half-open windows", () => {
    fc.assert(fc.property(...seedAndMood, fc.integer({ min: -40, max: 2048 }),
      fc.nat(256), fc.nat(256), (seed, mood, start, first, second) => {
        const a = start / 4;
        const b = a + first / 4;
        const c = b + second / 4;
        const full = events(seed, mood, a, c);
        expect(full).toEqual(events(seed, mood, a, b).concat(events(seed, mood, b, c)));
        events(seed ^ 1, mood, 0, 16);
        expect(events(seed, mood, a, c)).toEqual(full);
        expect(full.every(({ beat }, i) => beat >= a && beat < c && (i === 0 || beat >= full[i - 1]!.beat))).toBe(true);
      }));
  });

  it("varies the lead with the seed", () => {
    expect(events(1, "morning", 0, 16)).not.toEqual(events(2, "morning", 0, 16));
    expect(midiToHz(69)).toBe(440);
  });

  it("uses the mood pitches and tempos, with a root or fifth landing in the final bar", () => {
    const expected: Record<MoodId, { root: number; bpm: number; scale: number[] }> = {
      morning: { root: 62, bpm: 56, scale: [0, 2, 5, 7, 9] },
      afternoon: { root: 55, bpm: 63, scale: [0, 2, 5, 7, 9] },
      dusk: { root: 57, bpm: 54, scale: [0, 2, 3, 7, 8] },
      moonlit: { root: 52, bpm: 48, scale: [0, 1, 5, 7, 8] },
    };
    fc.assert(fc.property(...seedAndMood, (seed, mood) => {
      const { root, scale, bpm } = expected[mood];
      const degree = (midi: number) => ((midi - root) % 12 + 12) % 12;
      expect(MOODS[mood]).toMatchObject({ root, scale, bpm });
      const score = events(seed, mood, 0, 64);
      expect(score.every(({ midi }) => scale.includes(degree(midi)))).toBe(true);
      for (const start of [0, 16, 32]) {
        const landing = score.filter((note) => note.beat >= start && note.beat < start + 16 &&
          !isDrone(note) && note.voice !== "bell").at(-1)!;
        expect(landing.beat).toBeGreaterThanOrEqual(start + 12);
        expect([0, 7]).toContain(degree(landing.midi));
      }
    }));
  });

  it("has at most five music voices, counting both bell oscillators, and rests each fourth phrase", () => {
    fc.assert(fc.property(...seedAndMood, (seed, mood) => {
      const score = events(seed, mood, 0, 192);
      const edges = score.flatMap((note) => {
        const voices = note.voice === "bell" ? 2 : 1;
        return [[note.beat, voices] as const, [note.beat + note.durationBeats, -voices] as const];
      }).sort(([a, deltaA], [b, deltaB]) => a - b || deltaA - deltaB);
      let voices = 0;
      for (const [, delta] of edges) {
        voices += delta;
        expect(voices).toBeLessThanOrEqual(5);
      }
      for (const start of [48, 112, 176]) {
        const rest = score.filter((note) => note.beat < start + 16 && note.beat + note.durationBeats > start);
        expect(rest.length).toBeGreaterThan(0);
        expect(rest.every(isDrone)).toBe(true);
      }
    }));
  });
});

describe("rake foley", () => {
  it("is silent at rest and bounds gain and filter center as speed increases", () => {
    const finite = (min: number, max: number) => fc.double({ min, max, noNaN: true });
    fc.assert(fc.property(fc.record({
      tineCount: fc.integer({ min: 0, max: 64 }),
      tineWidth: finite(0, 32),
      tineDepth: finite(0, 3),
      changeRatio: finite(0, 1),
      crossing: finite(0, 1),
    }), finite(0, 400), finite(0, 400), (rake, a, b) => {
      const rest = computeFoleyParams({ ...rake, speed: 0 });
      const slower = computeFoleyParams({ ...rake, speed: Math.min(a, b) });
      const faster = computeFoleyParams({ ...rake, speed: Math.max(a, b) });
      expect(rest.gain).toBe(0);
      expect(rest.weightGain).toBe(0);
      expect(slower.gain).toBeGreaterThanOrEqual(0);
      expect(faster.gain).toBeGreaterThanOrEqual(slower.gain);
      expect(faster.gain).toBeLessThanOrEqual(1);
      for (const { bandpassHz } of [rest, slower, faster]) {
        expect(bandpassHz).toBeGreaterThanOrEqual(400);
        expect(bandpassHz).toBeLessThanOrEqual(6000);
      }
    }));
  });
});

describe("mix", () => {
  it("maps the eight steps quadratically and mutes each step to zero", () => {
    for (let step = 0; step <= 7; step++) {
      expect(mixGain(step)).toBeCloseTo(step ** 2 / 49);
      expect(mixGain(step, true)).toBe(0);
    }
  });

  it("keeps the master silent before the first gesture, including when muted", async () => {
    const engine = new AudioEngine();
    expect(engine.getDebugState()).toEqual({ state: "locked", masterGain: 0 });
    engine.setMute(true);
    expect(engine.getDebugState().masterGain).toBe(0);
    await engine.dispose();
    expect(engine.getDebugState()).toEqual({ state: "closed", masterGain: 0 });
  });
});
