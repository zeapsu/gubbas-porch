import type { MoodId, NoteEvent } from "../state/types.ts";

const YO = [0, 2, 5, 7, 9] as const;
export const MOODS = {
  morning: { scale: YO, root: 62, bpm: 56, lead: "triangle", duty: 0.5 },
  afternoon: { scale: YO, root: 55, bpm: 63, lead: "pulseA", duty: 0.25 },
  dusk: { scale: [0, 2, 3, 7, 8], root: 57, bpm: 54, lead: "pulseA", duty: 0.125 },
  moonlit: { scale: [0, 1, 5, 7, 8], root: 52, bpm: 48, lead: "triangle", duty: 0.5 },
} as const;

const PHRASE_BEATS = 16;

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function hash(seed: number, mood: MoodId, phraseIndex: number): number {
  let value = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ phraseIndex;
  for (const char of mood) value = Math.imul(value ^ char.charCodeAt(0), 0x01000193);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

export function isDrone(note: NoteEvent): boolean {
  return note.voice === "triangle" && note.durationBeats === PHRASE_BEATS;
}

function addIfRoom(score: NoteEvent[], note: NoteEvent): void {
  // Peak occupancy can only increase at an onset. The bell uses two oscillators.
  const fits = [note.beat, ...score.map((event) => event.beat)].every((at) =>
    at < note.beat || at >= note.beat + note.durationBeats || score.reduce((count, event) =>
      event.beat <= at && at < event.beat + event.durationBeats
        ? count + (event.voice === "bell" ? 2 : 1)
        : count, 0) < 5);
  if (fits) score.push(note);
}

function phrase(seed: number, mood: MoodId, index: number): NoteEvent[] {
  const { scale, root, bpm, lead } = MOODS[mood];
  const start = index * PHRASE_BEATS;
  const secondsPerBeat = 60 / bpm;
  let randomState = hash(seed, mood, index);
  const random = () => {
    randomState = (randomState + 0x6d2b79f5) | 0;
    let value = Math.imul(randomState ^ (randomState >>> 15), randomState | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
  const result: NoteEvent[] = [
    { beat: start, durationBeats: PHRASE_BEATS, midi: root - 12, voice: "triangle", velocity: 0.16 },
  ];
  const addFifth = random() < 0.3;
  const fifth: NoteEvent = { beat: start, durationBeats: PHRASE_BEATS, midi: root - 5, voice: "triangle", velocity: 0.07 };
  if (index % 4 === 3) {
    if (addFifth) result.push(fifth);
    return result;
  }

  if (random() < 0.16) {
    result.push({ beat: start, durationBeats: 3 / secondsPerBeat, midi: root + 24, voice: "bell", velocity: 0.1 });
  }

  const leads: NoteEvent[] = [];
  let degree = 2;
  for (let slot = 0; slot < 32; slot++) {
    const probability = slot % 2 === 0 ? 0.30 : 0.12;
    if (random() >= probability * (mood === "moonlit" ? 0.5 : 1)) continue;
    degree = Math.max(0, Math.min(9, degree + Math.floor(random() * 5) - 2));
    const midi = root + scale[degree % 5]! + 12 * (Math.floor(degree / 5) - Number(mood === "moonlit"));
    const seconds = lead === "pulseA" ? 0.6 + 0.3 * random() : 0.85;
    const offset = slot / 2;
    leads.push({
      beat: start + offset, durationBeats: Math.min(seconds / secondsPerBeat, PHRASE_BEATS - offset),
      midi, voice: lead, velocity: 0.18 + 0.08 * random(),
    });
  }
  if ((leads.at(-1)?.beat ?? -Infinity) < start + 12) {
    leads.push({ beat: start + 14, durationBeats: 0.75, midi: root, voice: lead, velocity: 0.18 });
  }
  const landing = leads.at(-1)!;
  landing.midi = root + (random() < 0.5 ? 0 : 7) - (mood === "moonlit" ? 12 : 0);
  result.push(...leads);

  if (lead === "pulseA") {
    for (const note of leads) {
      const beat = note.beat + 0.75;
      if (beat >= start + PHRASE_BEATS || (beat > landing.beat && note !== landing)) continue;
      const durationBeats = Math.min(note.durationBeats, start + PHRASE_BEATS - beat);
      addIfRoom(result, { ...note, beat, durationBeats, voice: "pulseB" });
    }
  }
  if (addFifth) addIfRoom(result, fifth);
  return result.sort((a, b) => a.beat - b.beat);
}

/** Return note onsets in the half-open beat range [fromBeat, toBeat). */
export function events(seed: number, mood: MoodId, fromBeat: number, toBeat: number): NoteEvent[] {
  const result: NoteEvent[] = [];
  if (!Number.isFinite(fromBeat) || !Number.isFinite(toBeat) || toBeat <= fromBeat) return result;
  const first = Math.max(0, Math.floor(fromBeat / PHRASE_BEATS));
  const end = Math.ceil(toBeat / PHRASE_BEATS);
  for (let index = first; index < end; index++) {
    for (const note of phrase(seed, mood, index)) {
      if (note.beat >= fromBeat && note.beat < toBeat) result.push(note);
    }
  }
  return result;
}
