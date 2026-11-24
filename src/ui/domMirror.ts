import { ELEMENT_FOOTPRINTS } from "../state/types.ts";
import type { ElementKind, GubbaSpeech, GubbaVariant, MoodId, PresetId, RakeId, SettingsState } from "../state/types.ts";
import type { UiCommand } from "./keys.ts";
import { RAKE_KEY_ORDER } from "./keys.ts";
import type { MixChannel } from "./settingsActions.ts";

/**
 * The visually hidden DOM twin of the canvas (DESIGN.md 9.4 and 2.7).
 *
 * - `#sr-controls` holds a labelled <button> for every control.
 * - `#sr-live` is an `aria-live="polite"` region that mirrors every line Gubba says.
 *
 * Built only with `createElement`, `textContent`, and `setAttribute`: never
 * `innerHTML`. The document is passed in so tests can supply a fake.
 */

export const CONTROLS_ID = "sr-controls";
export const LIVE_ID = "sr-live";

const RAKE_LABELS: Readonly<Record<RakeId, string>> = {
  sugi: "Sugi, classic five-tine cedar rake",
  onami: "Onami, wide nine-tine tide rake",
  kinu: "Kinu, fine eleven-tine silk rake",
  hisui: "Hisui, jade cadence rake",
  mikazuki: "Mikazuki, crescent wave sweep",
  tetsu: "Tetsu, three-tine iron furrow",
  wa: "Wa, twin-prong orbit rake",
  take: "Take, single bamboo stylus",
  nagi: "Nagi, flat sand smoother",
  hoki: "Hoki, bamboo broom",
};

const VARIANT_LABELS: Readonly<Record<GubbaVariant, string>> = {
  moss: "Moss Yabba",
  kasa: "Kasa Yabba",
  lantern: "Lantern Yabba",
};

const PRESETS: readonly { id: PresetId; label: string }[] = [
  { id: "still_sand", label: "Still sand" },
  { id: "three_islands", label: "Three islands" },
  { id: "ripple_pond", label: "Ripple pond" },
  { id: "old_sea", label: "Old sea" },
  { id: "river_bend", label: "River bend" },
  { id: "snails_thought", label: "Snail's thought" },
  { id: "checker_field", label: "Checker field" },
];

const CAMERA_LABELS = { cozy: "Cozy", topdown: "Top-down", porch: "Gubba porch" } as const;
const TALK_LABELS = { quiet: "Quiet", sometimes: "Now and then", companion: "Companion" } as const;

export interface MirrorView {
  settings: SettingsState;
  /** The mood actually on screen (the clock's choice when the setting is `auto`). */
  mood: MoodId;
  /** Whether animated preset playback ("Watch Gubba rake") is enabled. */
  watchGubbaRake?: boolean;
}

interface ControlDef {
  id: string;
  group: string;
  command: UiCommand;
  label: (v: MirrorView) => string;
  pressed?: (v: MirrorView) => boolean;
}

function onOff(b: boolean): string {
  return b ? "on" : "off";
}

function buildControls(): ControlDef[] {
  const defs: ControlDef[] = [];
  RAKE_KEY_ORDER.forEach((rake, i) => {
    defs.push({
      id: `rake-${rake}`,
      group: "Rakes",
      command: { type: "select_rake", rake },
      label: () => `Rake ${i + 1}: ${RAKE_LABELS[rake]}`,
      pressed: (v) => v.settings.rake === rake,
    });
  });
  defs.push(
    {
      id: "sweep",
      group: "Rakes",
      command: { type: "sweep_once" },
      label: () => `Sweep all sand with ${RAKE_LABELS.hoki}`,
    },
    { id: "basket", group: "Rakes", command: { type: "basket" }, label: () => "Open the stone basket" },

    { id: "hud-undo", group: "HUD", command: { type: "undo" }, label: () => "Undo the last stroke" },
    { id: "hud-redo", group: "HUD", command: { type: "redo" }, label: () => "Redo the stroke" },
    {
      id: "hud-breath",
      group: "HUD",
      command: { type: "toggle_breath" },
      label: (v) => `Breath guide, ${onOff(v.settings.breathEnabled)}`,
      pressed: (v) => v.settings.breathEnabled,
    },
    {
      id: "hud-mood",
      group: "HUD",
      command: { type: "next_mood" },
      label: (v) => `Next mood. Now ${v.settings.moodSetting === "auto" ? `auto, ${v.mood}` : v.mood}`,
    },
    {
      id: "hud-sound",
      group: "HUD",
      command: { type: "toggle_mute" },
      label: (v) => `Sound, ${v.settings.mix.muted ? "muted" : "on"}`,
      pressed: (v) => v.settings.mix.muted,
    },
    { id: "hud-menu", group: "HUD", command: { type: "menu" }, label: () => "Open or close the menu scroll" },

    {
      id: "gubba-variant",
      group: "Settings",
      command: { type: "next_gubba_variant" },
      label: (v) => `Gubba look: ${VARIANT_LABELS[v.settings.gubbaVariant]}. Swap to the next`,
    },
    {
      id: "mood-auto",
      group: "Settings",
      command: { type: "toggle_mood_auto" },
      label: (v) =>
        v.settings.moodSetting === "auto"
          ? `Mood follows the clock, now ${v.mood}. Switch to manual`
          : `Mood is manual, ${v.mood}. Switch to follow the clock`,
      pressed: (v) => v.settings.moodSetting === "auto",
    },
    {
      id: "camera",
      group: "Settings",
      command: { type: "next_camera" },
      label: (v) => `Camera: ${CAMERA_LABELS[v.settings.cameraPreset]}. Next preset`,
    },
    {
      id: "density",
      group: "Settings",
      command: { type: "toggle_density" },
      label: (v) => `Pixel density: ${v.settings.density}. Switch`,
    },
    {
      id: "breath-pattern",
      group: "Settings",
      command: { type: "next_breath_pattern" },
      label: (v) => `Breath pattern: ${v.settings.breathPattern}. Next pattern`,
    },
    {
      id: "rain",
      group: "Settings",
      command: { type: "toggle_rain" },
      label: (v) => `Rain, ${onOff(v.settings.rain)}`,
      pressed: (v) => v.settings.rain,
    },
    {
      id: "flow",
      group: "Settings",
      command: { type: "toggle_flow" },
      label: (v) => `Sand flow round stones, ${onOff(v.settings.flow)}`,
      pressed: (v) => v.settings.flow,
    },
    {
      id: "talk-mode",
      group: "Settings",
      command: { type: "next_talk_mode" },
      label: (v) => `Gubba talk mode: ${TALK_LABELS[v.settings.talkMode]}. Next mode`,
    },
  );
  for (const kind of Object.keys(ELEMENT_FOOTPRINTS) as ElementKind[]) {
    const info = ELEMENT_FOOTPRINTS[kind];
    defs.push({
      id: `basket-${kind}`,
      group: "Basket",
      command: { type: "place_element", kind },
      label: () => `Place ${info.label}`,
    });
  }
  const mixChannels: readonly { ch: MixChannel; label: string }[] = [
    { ch: "master", label: "Master" },
    { ch: "music", label: "Music" },
    { ch: "foley", label: "Foley" },
    { ch: "ambience", label: "Ambience" },
  ];
  for (const { ch, label } of mixChannels) {
    defs.push(
      {
        id: `mix-${ch}-down`,
        group: "Sound",
        command: { type: "adjust_mix", channel: ch, delta: -1 },
        label: (v) => `${label} volume down, currently ${v.settings.mix[ch]} of 7`,
      },
      {
        id: `mix-${ch}-up`,
        group: "Sound",
        command: { type: "adjust_mix", channel: ch, delta: 1 },
        label: (v) => `${label} volume up, currently ${v.settings.mix[ch]} of 7`,
      },
    );
  }
  defs.push({
    id: "watch-gubba-rake",
    group: "Presets",
    command: { type: "toggle_watch" },
    label: (v) => `Watch Gubba rake presets, ${onOff(Boolean(v.watchGubbaRake))}`,
    pressed: (v) => Boolean(v.watchGubbaRake),
  });
  for (const p of PRESETS) {
    defs.push({
      id: `preset-${p.id}`,
      group: "Presets",
      command: { type: "apply_preset", preset: p.id },
      label: () => `Preset garden: ${p.label}`,
    });
  }
  defs.push({
    id: "export",
    group: "Settings",
    command: { type: "export" },
    label: () => "Export the garden as a PNG",
  });
  return defs;
}

/** How many control buttons the mirror builds (for tests and sanity checks). */
export const CONTROL_COUNT = buildControls().length;

export interface DomMirror {
  readonly controls: HTMLElement;
  readonly live: HTMLElement;
  /** Refresh labels and pressed states. Cheap when nothing changed. */
  sync(view: MirrorView): void;
  /** Announce one line in the live region. */
  say(text: string): void;
  /** Call with `GubbaState.speech` every frame; announces each new line once. */
  mirrorSpeech(speech: GubbaSpeech | null): void;
  dispose(): void;
}

function hide(el: HTMLElement): void {
  const s = el.style;
  s.position = "absolute";
  s.width = "1px";
  s.height = "1px";
  s.margin = "-1px";
  s.padding = "0";
  s.overflow = "hidden";
  s.clip = "rect(0 0 0 0)";
  s.whiteSpace = "nowrap";
  s.border = "0";
}

function ensure(doc: Document, id: string, tag: string): HTMLElement {
  const existing = doc.getElementById(id);
  if (existing) return existing;
  const el = doc.createElement(tag);
  el.id = id;
  hide(el);
  doc.body.appendChild(el);
  return el;
}

export function createDomMirror(doc: Document, onCommand: (c: UiCommand) => void): DomMirror {
  const controls = ensure(doc, CONTROLS_ID, "div");
  const live = ensure(doc, LIVE_ID, "div");
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Garden controls");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");

  const defs = buildControls();
  const buttons = new Map<string, { el: HTMLElement; def: ControlDef; label: string; pressed: boolean | null }>();
  const listeners: Array<() => void> = [];

  let currentGroup = "";
  let groupEl: HTMLElement = controls;
  for (const def of defs) {
    if (def.group !== currentGroup) {
      currentGroup = def.group;
      groupEl = doc.createElement("div");
      groupEl.setAttribute("role", "group");
      groupEl.setAttribute("aria-label", def.group);
      controls.appendChild(groupEl);
    }
    const el = doc.createElement("button");
    el.setAttribute("type", "button");
    el.setAttribute("data-control", def.id);
    const handler = (): void => onCommand(def.command);
    el.addEventListener("click", handler);
    listeners.push(() => el.removeEventListener("click", handler));
    groupEl.appendChild(el);
    buttons.set(def.id, { el, def, label: "", pressed: null });
  }

  let lastSpeechKey = "";

  return {
    controls,
    live,
    sync(view) {
      for (const b of buttons.values()) {
        const label = b.def.label(view);
        if (label !== b.label) {
          b.label = label;
          b.el.setAttribute("aria-label", label);
          b.el.textContent = label;
        }
        if (b.def.pressed) {
          const pressed = b.def.pressed(view);
          if (pressed !== b.pressed) {
            b.pressed = pressed;
            b.el.setAttribute("aria-pressed", pressed ? "true" : "false");
          }
        }
      }
    },
    say(text) {
      // A fresh node each time, so a repeated line ("Mm.") is still announced.
      const p = doc.createElement("p");
      p.textContent = text;
      while (live.firstChild) live.removeChild(live.firstChild);
      live.appendChild(p);
    },
    mirrorSpeech(speech) {
      if (speech === null) return;
      const key = `${speech.startedAtMs}|${speech.text}`;
      if (key === lastSpeechKey) return;
      lastSpeechKey = key;
      this.say(speech.text);
    },
    dispose() {
      for (const off of listeners) off();
      listeners.length = 0;
      while (controls.firstChild) controls.removeChild(controls.firstChild);
      while (live.firstChild) live.removeChild(live.firstChild);
      buttons.clear();
    },
  };
}
