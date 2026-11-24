import type {
  AudioMix,
  BreathPatternId,
  CameraPresetId,
  GubbaVariant,
  MoodId,
  MoodSetting,
  RakeId,
  SettingsState,
  TalkMode,
} from "../state/types.ts";

/**
 * Pure helpers over `SettingsState`. Each returns a new object and never
 * mutates its input, so the store can compare by reference.
 */

export const GUBBA_VARIANTS: readonly GubbaVariant[] = ["moss", "kasa", "lantern"];
export const MOOD_SETTINGS: readonly MoodSetting[] = ["auto", "morning", "afternoon", "dusk", "moonlit"];
export const MOODS: readonly MoodId[] = ["morning", "afternoon", "dusk", "moonlit"];
export const CAMERA_PRESETS: readonly CameraPresetId[] = ["cozy", "topdown", "porch"];
export const TALK_MODES: readonly TalkMode[] = ["quiet", "sometimes", "companion"];
export const BREATH_PATTERNS: readonly BreathPatternId[] = ["4-4-6", "4-7-8", "box"];
export const MIX_MAX = 7;

export type MixChannel = "master" | "music" | "foley" | "ambience";

/** The item after `current` in `list` (wrapping), or before it with `dir = -1`. */
export function cycle<T>(list: readonly T[], current: T, dir: 1 | -1 = 1): T {
  const i = list.indexOf(current);
  const n = list.length;
  const next = i < 0 ? 0 : (i + dir + n) % n;
  return list[next] as T;
}

export function setRake(s: SettingsState, rake: RakeId): SettingsState {
  return s.rake === rake ? s : { ...s, rake };
}

// -- Gubba variant ----------------------------------------------------------

export function isGubbaVariant(v: unknown): v is GubbaVariant {
  return v === "moss" || v === "kasa" || v === "lantern";
}

export function setGubbaVariant(s: SettingsState, variant: GubbaVariant): SettingsState {
  return s.gubbaVariant === variant ? s : { ...s, gubbaVariant: variant };
}

/** moss -> kasa -> lantern -> moss. */
export function nextGubbaVariant(s: SettingsState): SettingsState {
  return setGubbaVariant(s, cycle(GUBBA_VARIANTS, s.gubbaVariant));
}

// -- Mood -------------------------------------------------------------------

export function isMoodSetting(v: unknown): v is MoodSetting {
  return typeof v === "string" && (MOOD_SETTINGS as readonly string[]).includes(v);
}

/** The mood the local clock asks for: morning 05-10, afternoon 11-16, dusk 17-19, moonlit 20-04. */
export function moodFromHour(hour: number): MoodId {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 17) return "afternoon";
  if (h >= 17 && h < 20) return "dusk";
  return "moonlit";
}

/** The mood actually shown: the setting itself, or the clock's choice when `auto`. */
export function effectiveMood(setting: MoodSetting, hour: number): MoodId {
  return setting === "auto" ? moodFromHour(hour) : setting;
}

export function setMoodSetting(s: SettingsState, mood: MoodSetting): SettingsState {
  return s.moodSetting === mood ? s : { ...s, moodSetting: mood };
}

/** auto -> morning -> afternoon -> dusk -> moonlit -> auto (key `T`, the HUD lantern). */
export function nextMoodSetting(s: SettingsState): SettingsState {
  return setMoodSetting(s, cycle(MOOD_SETTINGS, s.moodSetting));
}

/** Auto to manual keeps the mood currently on screen; manual to auto follows the clock again. */
export function toggleMoodAuto(s: SettingsState, hour: number): SettingsState {
  return setMoodSetting(s, s.moodSetting === "auto" ? moodFromHour(hour) : "auto");
}

// -- Plain settings ---------------------------------------------------------

export function nextCameraPreset(s: SettingsState): SettingsState {
  return { ...s, cameraPreset: cycle(CAMERA_PRESETS, s.cameraPreset) };
}

export function toggleDensity(s: SettingsState): SettingsState {
  return { ...s, density: s.density === "crisp" ? "chunky" : "crisp" };
}

export function toggleFlow(s: SettingsState): SettingsState {
  return { ...s, flow: !s.flow };
}

export function toggleRain(s: SettingsState): SettingsState {
  return { ...s, rain: !s.rain };
}

export function toggleBreath(s: SettingsState): SettingsState {
  return { ...s, breathEnabled: !s.breathEnabled };
}

export function nextBreathPattern(s: SettingsState): SettingsState {
  return { ...s, breathPattern: cycle(BREATH_PATTERNS, s.breathPattern) };
}

export function nextTalkMode(s: SettingsState): SettingsState {
  return { ...s, talkMode: cycle(TALK_MODES, s.talkMode) };
}

// -- Audio mix --------------------------------------------------------------

function clampLevel(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(MIX_MAX, Math.max(0, Math.round(v)));
}

export function toggleMute(s: SettingsState): SettingsState {
  return { ...s, mix: { ...s.mix, muted: !s.mix.muted } };
}

export function setMixLevel(s: SettingsState, channel: MixChannel, level: number): SettingsState {
  const mix: AudioMix = { ...s.mix, [channel]: clampLevel(level) };
  return { ...s, mix };
}

/** Adjust a channel by `delta` steps, clamped to 0..7. */
export function adjustMix(s: SettingsState, channel: MixChannel, delta: number): SettingsState {
  return setMixLevel(s, channel, s.mix[channel] + delta);
}

// -- Stories ----------------------------------------------------------------

/** A story seal is stamped once all three lines of a rake's story have been heard. */
export function hasStorySeal(s: Pick<SettingsState, "heardStories">, rake: RakeId): boolean {
  return (s.heardStories[rake] ?? 0) >= 3;
}

/** Copies the heard-story counts (e.g. from `GubbaState`) into settings, only if they changed. */
export function withHeardStories(
  s: SettingsState,
  heard: Partial<Record<RakeId, number>>,
): SettingsState {
  const keys = Object.keys(heard) as RakeId[];
  const same =
    keys.length === Object.keys(s.heardStories).length &&
    keys.every((k) => s.heardStories[k] === heard[k]);
  return same ? s : { ...s, heardStories: { ...heard } };
}
