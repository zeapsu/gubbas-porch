export type MoodId = "morning" | "afternoon" | "dusk" | "moonlit";
export type MoodSetting = MoodId | "auto";
export type GubbaVariant = "moss" | "kasa" | "lantern";

export type RakeId =
  | "sugi"
  | "onami"
  | "kinu"
  | "hisui"
  | "mikazuki"
  | "tetsu"
  | "wa"
  | "take"
  | "nagi"
  | "hoki";

export type ElementKind =
  | "stone_s"
  | "stone_m"
  | "stone_l"
  | "stone_tall"
  | "stone_flat"
  | "lantern"
  | "bonsai"
  | "moss_a"
  | "moss_b"
  | "basin"
  | "pin";

export type CameraPresetId = "cozy" | "topdown" | "porch";
export type PixelDensity = "crisp" | "chunky";
export type BreathPatternId = "4-4-6" | "4-7-8" | "box";
export type BreathPhase = "inhale" | "hold_in" | "exhale" | "hold_out";
export type TalkMode = "quiet" | "sometimes" | "companion";

export type PresetId =
  | "still_sand"
  | "three_islands"
  | "ripple_pond"
  | "old_sea"
  | "river_bend"
  | "snails_thought"
  | "checker_field";

export type RampName =
  | "sand"
  | "stone"
  | "wood"
  | "wood_light"
  | "leaf"
  | "water"
  | "warm"
  | "gubba"
  | "belly"
  | "cloth"
  | "ink"
  | "paper"
  | "glow"
  | "blush";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Footprint {
  x: number;
  y: number;
  rx: number;
  ry: number;
  kind: ElementKind;
}

export interface ElementInstance {
  id: string;
  kind: ElementKind;
  x: number;
  y: number;
  rx: number;
  ry: number;
  rotation: number;
}

export interface SandGridSnapshot {
  readonly w: 192;
  readonly h: 112;
  height: Int8Array;
  dir: Uint8Array;
  rock: Uint8Array;
}

export interface GardenState {
  v: 1;
  sand: SandGridSnapshot;
  elements: ElementInstance[];
}

export interface AudioMix {
  master: number; // 0..7
  music: number; // 0..7
  foley: number; // 0..7
  ambience: number; // 0..7
  muted: boolean;
}

export interface SettingsState {
  v: 1;
  rake: RakeId;
  moodSetting: MoodSetting;
  gubbaVariant: GubbaVariant;
  cameraPreset: CameraPresetId;
  density: PixelDensity;
  breathEnabled: boolean;
  breathPattern: BreathPatternId;
  talkMode: TalkMode;
  rain: boolean;
  flow: boolean;
  mix: AudioMix;
  heardStories: Partial<Record<RakeId, number>>;
}

export interface CameraRig {
  target: Vec3;
  az: number;
  el: number;
  dist: number;
}

export type PickKind = "rake" | "gubba" | "basket" | "element" | "hud" | "none";

export interface PickResult {
  kind: PickKind;
  id?: string;
}

export type GubbaNodeName =
  | "Root"
  | "Body"
  | "Head"
  | "EyeL"
  | "EyeR"
  | "PupilL"
  | "PupilR"
  | "LidL"
  | "LidR"
  | "Mouth"
  | "ArmL"
  | "ArmR"
  | "Cup"
  | "Tail1"
  | "Tail2"
  | "Tail3"
  | "Prop_Bonsai"
  | "Prop_Hat"
  | "Prop_Shell";

export interface NodeTransform {
  pos: Vec3;
  rot: Vec3;
  scale: Vec3;
}

export interface GubbaSpeech {
  text: string;
  startedAtMs: number;
  durationMs: number;
  forced: boolean;
}

export type GubbaEvent =
  | { type: "tick"; pointerOnWall: boolean; raking: boolean; rakeGridPos: Vec2 | null; rain: boolean; breathPhase: BreathPhase }
  | { type: "rake_selected"; rakeId: RakeId }
  | { type: "mood_changed"; mood: MoodId }
  | { type: "gubba_tapped"; activeRake: RakeId }
  | { type: "sweep" }
  | { type: "stone_placed" }
  | { type: "rain_toggled"; on: boolean }
  | { type: "breath_toggled"; on: boolean }
  | { type: "talk_mode_changed"; mode: TalkMode }
  | { type: "first_visit" };

export interface GubbaState {
  variant: GubbaVariant;
  talkMode: TalkMode;
  dozing: boolean;
  rain: boolean;
  watchingRake: boolean;
  glancingWall: boolean;
  targetYaw: number;
  lastInputMs: number;
  lastUnsolicitedSpeakMs: number;
  nextBlinkMs: number;
  blinkStartMs: number;
  nextSipMs: number;
  sipStartMs: number;
  nextTailFlickMs: number;
  tailFlickStartMs: number;
  breathCyclesShown: number;
  lastBreathPhase: BreathPhase | null;
  speech: GubbaSpeech | null;
  heardStories: Partial<Record<RakeId, number>>;
  sessionIntroducedRakes: Partial<Record<RakeId, boolean>>;
  lineCursor: number;
  rngState: number;
}

export interface NoteEvent {
  beat: number;
  durationBeats: number;
  midi: number;
  voice: "pulseA" | "pulseB" | "triangle" | "bell";
  velocity: number;
}

export const DEFAULT_SETTINGS: SettingsState = {
  v: 1,
  rake: "sugi",
  moodSetting: "auto",
  gubbaVariant: "moss",
  cameraPreset: "cozy",
  density: "crisp",
  breathEnabled: false,
  breathPattern: "4-4-6",
  talkMode: "sometimes",
  rain: false,
  flow: true,
  mix: {
    master: 5,
    music: 4,
    foley: 6,
    ambience: 4,
    muted: false,
  },
  heardStories: {},
};

export const ELEMENT_FOOTPRINTS: Record<
  ElementKind,
  { rx: number; ry: number; height: number; label: string }
> = {
  stone_s: { rx: 4, ry: 3, height: 5, label: "Small Stone" },
  stone_m: { rx: 7, ry: 5, height: 8, label: "Medium Stone" },
  stone_l: { rx: 10, ry: 7, height: 15, label: "Large Stone" },
  stone_tall: { rx: 5, ry: 4, height: 20, label: "Standing Stone" },
  stone_flat: { rx: 11, ry: 5, height: 5, label: "Flat Stone" },
  lantern: { rx: 5, ry: 4, height: 27, label: "Stone Lantern" },
  bonsai: { rx: 6, ry: 4, height: 22, label: "Bonsai" },
  moss_a: { rx: 13, ry: 9, height: 2, label: "Wide Moss" },
  moss_b: { rx: 9, ry: 6, height: 2, label: "Small Moss" },
  basin: { rx: 8, ry: 6, height: 6, label: "Water Basin" },
  pin: { rx: 1, ry: 1, height: 3, label: "Brass Pin" },
};
