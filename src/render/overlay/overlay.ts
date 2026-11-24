// Pass 4 content (DESIGN.md 2.7): the HUD, the speech scroll, and the quiet menu scroll (Settings) and stone
// basket tray, drawn as palette indices into a framebuffer-sized buffer so overlay pixels are scene-sized and
// every one of them is one of the mood's 32 colours. `draw` returns hit rectangles; the UI maps clicks to
// `OverlayAction`s with `hitTest` and applies them. Text is always ink on paper.

import { CAMERA_PRESET_LABELS, CAMERA_PRESET_ORDER } from "../camera/rig.ts";
import { ELEMENT_FOOTPRINTS } from "../../state/types.ts";
import type {
  AudioMix,
  BreathPatternId,
  ElementKind,
  GubbaVariant,
  MoodSetting,
  PixelDensity,
  PresetId,
  SettingsState,
  TalkMode,
} from "../../state/types.ts";
import { PixelLayer, drawText, measureText } from "./font.ts";
import { HUD_FROM_BOTTOM, HUD_ICON, HUD_LEFT, HUD_ORDER, S, drawPanel, drawScroll, makeHudIcons } from "./hud.ts";
import type { HudIcons, HudId } from "./hud.ts";

export type SettingsTab = "look" | "garden" | "sound" | "presets";
export type MixChannel = "master" | "music" | "foley" | "ambience";
export type SettingsPatch = Partial<Omit<SettingsState, "mix" | "v">> & { mix?: Partial<AudioMix> };

export type OverlayAction =
  | { type: "hud"; id: HudId }
  | { type: "tab"; tab: SettingsTab }
  | { type: "close" }
  | { type: "settings"; patch: SettingsPatch }
  | { type: "preset"; id: PresetId }
  | { type: "watch"; on: boolean }
  | { type: "export" }
  | { type: "place"; kind: ElementKind }
  /** A click on panel paper that hits no control: swallowed so it never rakes or orbits. */
  | { type: "none" };

export interface OverlayHit {
  x: number;
  y: number;
  w: number;
  h: number;
  action: OverlayAction;
}

export interface OverlayState {
  settings: SettingsState;
  breathAmplitude: number;
  /** Text in the speech scroll (a Gubba line or a rake's name tag), or null to hide it. */
  speech: string | null;
  panel: "none" | "settings" | "basket";
  tab: SettingsTab;
  watchGubbaRake: boolean;
  elementCount: number;
  maxElements: number;
  /** Pointer in framebuffer pixels, for hover underlines. */
  pointer: { x: number; y: number } | null;
}

export const PRESET_LABELS: Readonly<Record<PresetId, string>> = {
  still_sand: "Still Sand",
  three_islands: "Three Islands",
  ripple_pond: "Ripple Pond",
  old_sea: "Old Sea",
  river_bend: "River Bend",
  snails_thought: "Snail's Thought",
  checker_field: "Checker Field",
};
const PRESET_ORDER = Object.keys(PRESET_LABELS) as PresetId[];
const TABS: readonly { tab: SettingsTab; label: string }[] = [
  { tab: "look", label: "Look" },
  { tab: "garden", label: "Garden" },
  { tab: "sound", label: "Sound" },
  { tab: "presets", label: "Presets" },
];
const VARIANTS: readonly { value: GubbaVariant; label: string }[] = [
  { value: "moss", label: "Moss" },
  { value: "kasa", label: "Kasa" },
  { value: "lantern", label: "Lantern" },
];
const MOODS: readonly { value: MoodSetting; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
  { value: "dusk", label: "Dusk" },
  { value: "moonlit", label: "Moonlit" },
];
const DENSITIES: readonly { value: PixelDensity; label: string }[] = [
  { value: "crisp", label: "Crisp" },
  { value: "chunky", label: "Chunky" },
];
const PATTERNS: readonly { value: BreathPatternId; label: string }[] = [
  { value: "4-4-6", label: "4-4-6" },
  { value: "4-7-8", label: "4-7-8" },
  { value: "box", label: "Box" },
];
const TALK: readonly { value: TalkMode; label: string }[] = [
  { value: "quiet", label: "Quiet" },
  { value: "sometimes", label: "Sometimes" },
  { value: "companion", label: "Companion" },
];
const MIX: readonly { ch: MixChannel; label: string }[] = [
  { ch: "master", label: "Master" },
  { ch: "music", label: "Music" },
  { ch: "foley", label: "Foley" },
  { ch: "ambience", label: "Ambient" },
];
const ELEMENT_ORDER = Object.keys(ELEMENT_FOOTPRINTS) as ElementKind[];
const ELEMENT_LABEL_ITEMS: readonly { label: string }[] = ELEMENT_ORDER.map((k) => ({
  label: ELEMENT_FOOTPRINTS[k].label,
}));
const PRESET_LABEL_ITEMS: readonly { label: string }[] = PRESET_ORDER.map((id) => ({
  label: PRESET_LABELS[id],
}));
const CAMERA_ROW = CAMERA_PRESET_ORDER.map((c) => ({ value: c, label: CAMERA_PRESET_LABELS[c] }));
const ON_OFF: readonly { value: boolean; label: string }[] = [
  { value: true, label: "On" },
  { value: false, label: "Off" },
];
const WATCH_OPTIONS: readonly { value: boolean; label: string }[] = [
  { value: true, label: "Gubba rakes" },
  { value: false, label: "Instant" },
];

const GUBBA_ACTIONS: Record<GubbaVariant, OverlayAction> = {
  moss: { type: "settings", patch: { gubbaVariant: "moss" } },
  kasa: { type: "settings", patch: { gubbaVariant: "kasa" } },
  lantern: { type: "settings", patch: { gubbaVariant: "lantern" } },
};
const MOOD_ACTIONS: Record<MoodSetting, OverlayAction> = {
  auto: { type: "settings", patch: { moodSetting: "auto" } },
  morning: { type: "settings", patch: { moodSetting: "morning" } },
  afternoon: { type: "settings", patch: { moodSetting: "afternoon" } },
  dusk: { type: "settings", patch: { moodSetting: "dusk" } },
  moonlit: { type: "settings", patch: { moodSetting: "moonlit" } },
};
const CAM_ACTIONS: Record<(typeof CAMERA_PRESET_ORDER)[number], OverlayAction> = {
  cozy: { type: "settings", patch: { cameraPreset: "cozy" } },
  topdown: { type: "settings", patch: { cameraPreset: "topdown" } },
  porch: { type: "settings", patch: { cameraPreset: "porch" } },
};
const DENSITY_ACTIONS: Record<PixelDensity, OverlayAction> = {
  crisp: { type: "settings", patch: { density: "crisp" } },
  chunky: { type: "settings", patch: { density: "chunky" } },
};
const FLOW_ON: OverlayAction = { type: "settings", patch: { flow: true } };
const FLOW_OFF: OverlayAction = { type: "settings", patch: { flow: false } };
const RAIN_ON: OverlayAction = { type: "settings", patch: { rain: true } };
const RAIN_OFF: OverlayAction = { type: "settings", patch: { rain: false } };
const BREATH_ON: OverlayAction = { type: "settings", patch: { breathEnabled: true } };
const BREATH_OFF: OverlayAction = { type: "settings", patch: { breathEnabled: false } };
const MUTE_ON: OverlayAction = { type: "settings", patch: { mix: { muted: true } } };
const MUTE_OFF: OverlayAction = { type: "settings", patch: { mix: { muted: false } } };
const WATCH_ON: OverlayAction = { type: "watch", on: true };
const WATCH_OFF: OverlayAction = { type: "watch", on: false };
const PATTERN_ACTIONS: Record<BreathPatternId, OverlayAction> = {
  "4-4-6": { type: "settings", patch: { breathPattern: "4-4-6" } },
  "4-7-8": { type: "settings", patch: { breathPattern: "4-7-8" } },
  box: { type: "settings", patch: { breathPattern: "box" } },
};
const TALK_ACTIONS: Record<TalkMode, OverlayAction> = {
  quiet: { type: "settings", patch: { talkMode: "quiet" } },
  sometimes: { type: "settings", patch: { talkMode: "sometimes" } },
  companion: { type: "settings", patch: { talkMode: "companion" } },
};
const TAB_ACTIONS: Record<SettingsTab, OverlayAction> = {
  look: { type: "tab", tab: "look" },
  garden: { type: "tab", tab: "garden" },
  sound: { type: "tab", tab: "sound" },
  presets: { type: "tab", tab: "presets" },
};
const PRESET_ACTIONS: Record<PresetId, OverlayAction> = Object.fromEntries(
  PRESET_ORDER.map((id) => [id, { type: "preset", id } as OverlayAction]),
) as Record<PresetId, OverlayAction>;
const PLACE_ACTIONS: Record<ElementKind, OverlayAction> = Object.fromEntries(
  ELEMENT_ORDER.map((kind) => [kind, { type: "place", kind } as OverlayAction]),
) as Record<ElementKind, OverlayAction>;
const MIX_ACTIONS: Record<MixChannel, readonly OverlayAction[]> = {
  master: Array.from({ length: 8 }, (_, v) => ({ type: "settings", patch: { mix: { master: v } } })),
  music: Array.from({ length: 8 }, (_, v) => ({ type: "settings", patch: { mix: { music: v } } })),
  foley: Array.from({ length: 8 }, (_, v) => ({ type: "settings", patch: { mix: { foley: v } } })),
  ambience: Array.from({ length: 8 }, (_, v) => ({ type: "settings", patch: { mix: { ambience: v } } })),
};

const actGubba = (v: GubbaVariant): OverlayAction => GUBBA_ACTIONS[v];
const actMood = (v: MoodSetting): OverlayAction => MOOD_ACTIONS[v];
const actCam = (v: (typeof CAMERA_PRESET_ORDER)[number]): OverlayAction => CAM_ACTIONS[v];
const actDensity = (v: PixelDensity): OverlayAction => DENSITY_ACTIONS[v];
const actFlow = (v: boolean): OverlayAction => (v ? FLOW_ON : FLOW_OFF);
const actRain = (v: boolean): OverlayAction => (v ? RAIN_ON : RAIN_OFF);
const actBreath = (v: boolean): OverlayAction => (v ? BREATH_ON : BREATH_OFF);
const actPattern = (v: BreathPatternId): OverlayAction => PATTERN_ACTIONS[v];
const actTalk = (v: TalkMode): OverlayAction => TALK_ACTIONS[v];
const actMute = (v: boolean): OverlayAction => (v ? MUTE_ON : MUTE_OFF);
const actWatch = (v: boolean): OverlayAction => (v ? WATCH_ON : WATCH_OFF);
const actTab = (t: SettingsTab): OverlayAction => TAB_ACTIONS[t];
const actPreset = (id: PresetId): OverlayAction => PRESET_ACTIONS[id];
const actMix = (ch: MixChannel, v: number): OverlayAction => MIX_ACTIONS[ch][v]!;

/** Lines a wrapped row of chips takes in `width` pixels (the same flow `chipRow` uses). */
function wrapCount(options: readonly { label: string }[], width: number): number {
  let lines = 1;
  let px = 0;
  for (const o of options) {
    const w = measureText(o.label) + 5;
    if (px > 0 && px + w > width) {
      lines++;
      px = 0;
    }
    px += w + CHIP_GAP;
  }
  return lines;
}

const HUD_ACTIONS: Readonly<Record<HudId, OverlayAction>> = {
  undo: { type: "hud", id: "undo" },
  redo: { type: "hud", id: "redo" },
  breath: { type: "hud", id: "breath" },
  mood: { type: "hud", id: "mood" },
  sound: { type: "hud", id: "sound" },
  menu: { type: "hud", id: "menu" },
};
const NONE: OverlayAction = { type: "none" };
const CLOSE: OverlayAction = { type: "close" };
const EXPORT: OverlayAction = { type: "export" };

const PAD = 5;
const LABEL_W = 34;
const CHIP_GAP = 3;
const ROW_H = 11;

export class Overlay {
  readonly layer: PixelLayer;
  private readonly icons: HudIcons;
  private readonly hits: OverlayHit[] = [];
  private hitCount = 0;
  private pointer: { x: number; y: number } | null = null;
  /** Panel rectangle of the last frame (for `blocksScene`), w = 0 when closed. */
  private readonly panelRect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly panelLayout = { x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0, cw: 0 };

  constructor(fbW = 1, fbH = 1) {
    this.layer = new PixelLayer(fbW, fbH);
    this.icons = makeHudIcons();
  }

  /** Palette indices, fbW × fbH, top row first; 255 is transparent. Pass this to the pipeline. */
  get pixels(): Uint8Array {
    return this.layer.d;
  }

  resize(fbW: number, fbH: number): void {
    if (fbW === this.layer.w && fbH === this.layer.h) return;
    this.layer.w = fbW;
    this.layer.h = fbH;
    this.layer.d = new Uint8Array(fbW * fbH).fill(255);
  }

  private hit(x: number, y: number, w: number, h: number, action: OverlayAction): void {
    let o = this.hits[this.hitCount];
    if (!o) {
      o = { x, y, w, h, action };
      this.hits.push(o);
    } else {
      o.x = x;
      o.y = y;
      o.w = w;
      o.h = h;
      o.action = action;
    }
    this.hitCount++;
  }

  private hovered(x: number, y: number, w: number, h: number): boolean {
    const p = this.pointer;
    return !!p && p.x >= x && p.y >= y && p.x < x + w && p.y < y + h;
  }

  /** Redraws the overlay for this frame and returns its hit rectangles (topmost last). */
  draw(st: OverlayState): readonly OverlayHit[] {
    const L = this.layer.clear();
    const W = L.w;
    const H = L.h;
    this.hitCount = 0;
    this.pointer = st.pointer;
    this.panelRect.w = 0;

    // HUD (computed inline with zero per-frame allocations)
    for (let i = 0; i < HUD_ORDER.length; i++) {
      const id = HUD_ORDER[i] as HudId;
      const x = HUD_LEFT + (i % 3) * HUD_ICON;
      const y = H - HUD_FROM_BOTTOM + (i < 3 ? 0 : HUD_ICON + 1);
      const sprite =
        id === "breath"
          ? this.icons.lotus[st.settings.breathEnabled ? Math.max(0, Math.min(6, Math.floor(st.breathAmplitude * 6 + 1e-6))) : 0]
          : id === "sound"
            ? st.settings.mix.muted
              ? this.icons.soundMuted
              : this.icons.sound
            : this.icons[id];
      sprite?.blit(L, x, y);
      this.hit(x, y, HUD_ICON, HUD_ICON, HUD_ACTIONS[id]);
    }

    if (st.speech && st.panel === "none") drawScroll(L, st.speech, W, H);
    if (st.panel === "settings") this.drawSettings(st);
    if (st.panel === "basket") this.drawBasket(st);
    this.hits.length = this.hitCount;
    return this.hits;
  }

  /** The action under framebuffer point (x, y), topmost first; null when the overlay has nothing there. */
  hitTest(x: number, y: number): OverlayAction | null {
    for (let i = this.hitCount - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (h && x >= h.x && y >= h.y && x < h.x + h.w && y < h.y + h.h) return h.action;
    }
    return null;
  }

  /** True when (x, y) is on the HUD or an open panel, so the pointer must not rake or orbit there. */
  blocksScene(x: number, y: number): boolean {
    return this.hitTest(x, y) !== null;
  }

  // -------------------------------------------------------------------------------------------- layout helpers
  private panelWidth(): number {
    return Math.max(60, Math.min(this.layer.w - 6, 236));
  }

  private panel(title: string | null, contentRows: number): { x: number; y: number; w: number; h: number; cx: number; cy: number; cw: number } {
    const L = this.layer;
    const w = this.panelWidth();
    const maxH = Math.max(40, L.h - 40);
    const h = Math.min(maxH, PAD * 2 + 4 + (title ? ROW_H + 2 : 0) + contentRows * ROW_H);
    const x = 3;
    const y = 3;
    drawPanel(L, x, y, w, h);
    this.panelRect.x = x;
    this.panelRect.y = y;
    this.panelRect.w = w;
    this.panelRect.h = h;
    this.hit(x, y, w, h, NONE);
    // close button, top right
    const cx = x + w - 12;
    drawText(L, cx + 2, y + PAD - 1, "×", S.ink);
    if (this.hovered(cx, y + 2, 10, 10)) L.hline(cx + 2, cx + 6, y + PAD + 7, S.wood2);
    this.hit(cx, y + 2, 10, 10, CLOSE);
    let cy = y + PAD;
    if (title) {
      drawText(L, x + PAD + 2, cy, title, S.ink);
      cy += ROW_H + 2;
    }
    this.panelLayout.x = x;
    this.panelLayout.y = y;
    this.panelLayout.w = w;
    this.panelLayout.h = h;
    this.panelLayout.cx = x + PAD + 2;
    this.panelLayout.cy = cy;
    this.panelLayout.cw = w - PAD * 2 - 4;
    return this.panelLayout;
  }

  /** A clickable text chip; selected chips get an ink frame, hovered ones a wood underline. Returns its width. */
  private chip(x: number, y: number, label: string, selected: boolean, action: OverlayAction): number {
    const L = this.layer;
    const tw = measureText(label);
    const w = tw + 5;
    const h = ROW_H - 1;
    if (selected) L.frame(x, y - 1, w, h, S.ink);
    else if (this.hovered(x, y - 1, w, h)) L.hline(x + 2, x + w - 3, y + h - 2, S.wood2);
    drawText(L, x + 3, y + 1, label, S.ink);
    this.hit(x, y - 1, w, h, action);
    return w;
  }

  /** A labelled row of chips that wraps within the panel. Returns the y of the next row. */
  private chipRow<T>(
    x: number,
    y: number,
    cw: number,
    label: string,
    options: readonly { value: T; label: string }[],
    current: T,
    action: (v: T) => OverlayAction,
  ): number {
    const L = this.layer;
    drawText(L, x, y + 1, label, S.ink);
    const stacked = cw < LABEL_W + 28;
    const x0 = stacked ? x : x + LABEL_W;
    const right = x + cw;
    let px = x0;
    let py = stacked ? y + ROW_H : y;
    for (const o of options) {
      const w = measureText(o.label) + 5;
      if (px > x0 && px + w > right) {
        px = x0;
        py += ROW_H;
      }
      px += this.chip(px, py, o.label, o.value === current, action(o.value)) + CHIP_GAP;
    }
    return py + ROW_H;
  }

  // -------------------------------------------------------------------------------------------- settings
  private drawSettings(st: OverlayState): void {
    const s = st.settings;
    const cwGuess = this.panelWidth() - PAD * 2 - 4;
    const stacked = cwGuess < LABEL_W + 28;
    const chipMaxW = stacked ? cwGuess : cwGuess - LABEL_W;
    const tabMaxW = Math.max(24, cwGuess - 12);
    const tabRows = wrapCount(TABS, tabMaxW);
    const extra = stacked ? 1 : 0;
    const rows =
      st.tab === "look"
        ? extra * 4 + wrapCount(VARIANTS, chipMaxW) + wrapCount(MOODS, chipMaxW) + wrapCount(CAMERA_ROW, chipMaxW) + wrapCount(DENSITIES, chipMaxW)
        : st.tab === "garden"
          ? 3 * (stacked ? 2 : 1) + extra * 2 + wrapCount(PATTERNS, chipMaxW) + wrapCount(TALK, chipMaxW)
          : st.tab === "sound"
            ? MIX.length + 1
            : extra + wrapCount(PRESET_LABEL_ITEMS, chipMaxW) + 2;
    const p = this.panel(null, rows + tabRows);
    const L = this.layer;
    // tabs (wrapped within panel width minus close button so portrait viewports stay onscreen)
    let tx = p.cx;
    let ty = p.cy;
    const tabRight = p.cx + Math.max(24, p.cw - 12);
    for (const t of TABS) {
      const tw = measureText(t.label) + 5;
      if (tx > p.cx && tx + tw > tabRight) {
        tx = p.cx;
        ty += ROW_H;
      }
      tx += this.chip(tx, ty, t.label, t.tab === st.tab, actTab(t.tab)) + CHIP_GAP;
    }
    let y = ty + ROW_H + 2;
    L.hline(p.x + 3, p.x + p.w - 4, y - 2, S.wood2);
    const x = p.cx;
    const cw = p.cw;
    const bottom = p.y + p.h - PAD;
    switch (st.tab) {
      case "look":
        if (y + ROW_H <= bottom + 2) y = this.chipRow(x, y, cw, "Gubba", VARIANTS, s.gubbaVariant, actGubba);
        if (y + ROW_H <= bottom + 2) y = this.chipRow(x, y, cw, "Mood", MOODS, s.moodSetting, actMood);
        if (y + ROW_H <= bottom + 2) y = this.chipRow(x, y, cw, "Camera", CAMERA_ROW, s.cameraPreset, actCam);
        if (y + ROW_H <= bottom + 2) y = this.chipRow(x, y, cw, "Pixels", DENSITIES, s.density, actDensity);
        break;
      case "garden":
        if (y + ROW_H <= bottom + 2) y = this.chipRow(x, y, cw, "Flow", ON_OFF, s.flow, actFlow);
        if (y + ROW_H <= bottom + 2) y = this.chipRow(x, y, cw, "Rain", ON_OFF, s.rain, actRain);
        if (y + ROW_H <= bottom + 2) y = this.chipRow(x, y, cw, "Breath", ON_OFF, s.breathEnabled, actBreath);
        if (y + ROW_H <= bottom + 2) y = this.chipRow(x, y, cw, "Pattern", PATTERNS, s.breathPattern, actPattern);
        if (y + ROW_H <= bottom + 2) y = this.chipRow(x, y, cw, "Talk", TALK, s.talkMode, actTalk);
        break;
      case "sound":
        for (const m of MIX) {
          if (y + ROW_H <= bottom + 2) y = this.mixRow(x, y, m.ch, m.label, s.mix[m.ch]);
        }
        if (y + ROW_H <= bottom + 2) y = this.chipRow(x, y, cw, "Mute", ON_OFF, s.mix.muted, actMute);
        break;
      case "presets": {
        if (y + ROW_H <= bottom + 2) {
          drawText(L, x, y + 1, "Gardens", S.ink);
          const x0 = stacked ? x : x + LABEL_W;
          let px = x0;
          let py = stacked ? y + ROW_H : y;
          for (const id of PRESET_ORDER) {
            const label = PRESET_LABELS[id];
            const w = measureText(label) + 5;
            if (px > x0 && px + w > x + cw) {
              px = x0;
              py += ROW_H;
            }
            if (py + ROW_H > bottom + 2) break;
            px += this.chip(px, py, label, false, actPreset(id)) + CHIP_GAP;
          }
          y = py + ROW_H;
        }
        if (y + ROW_H <= bottom + 2) y = this.chipRow(x, y, cw, "Watch", WATCH_OPTIONS, st.watchGubbaRake, actWatch);
        if (y + ROW_H <= bottom + 2) {
          drawText(L, x, y + 1, "Picture", S.ink);
          this.chip(x + LABEL_W, y, "Export PNG", false, EXPORT);
          y += ROW_H;
        }
        break;
      }
    }
  }

  /** Eight pips 0…7 for one mix channel. */
  private mixRow(x: number, y: number, ch: MixChannel, label: string, value: number): number {
    const L = this.layer;
    drawText(L, x, y + 1, label, S.ink);
    let px = x + LABEL_W;
    for (let v = 0; v <= 7; v++) {
      const on = v <= value && value > 0 && v > 0;
      if (v === 0) {
        drawText(L, px + 1, y + 1, "0", S.ink);
        if (value === 0) L.frame(px - 1, y - 1, 7, ROW_H - 1, S.ink);
      } else if (on) L.rect(px, y + 1, 5, 7, S.ink);
      else L.frame(px, y + 1, 5, 7, this.hovered(px - 1, y - 1, 7, ROW_H - 1) ? S.ink : S.wood2);
      this.hit(px - 1, y - 1, 7, ROW_H - 1, actMix(ch, v));
      px += 7;
    }
    return y + ROW_H;
  }

  // -------------------------------------------------------------------------------------------- basket
  private drawBasket(st: OverlayState): void {
    const L = this.layer;
    const full = st.elementCount >= st.maxElements;
    const p = this.panel(
      `Stone basket  ${st.elementCount}/${st.maxElements}`,
      wrapCount(ELEMENT_LABEL_ITEMS, this.panelWidth() - PAD * 2 - 4),
    );
    const x0 = p.cx;
    let px = x0;
    let py = p.cy;
    const bottom = p.y + p.h - PAD;
    for (const kind of ELEMENT_ORDER) {
      const label = ELEMENT_FOOTPRINTS[kind].label;
      const w = measureText(label) + 5;
      if (px > x0 && px + w > x0 + p.cw) {
        px = x0;
        py += ROW_H;
      }
      if (py + ROW_H > bottom + 2) break;
      if (full) {
        drawText(L, px + 3, py + 1, label, S.ink);
        L.hline(px + 2, px + w - 3, py + 4, S.wood2); // resting: the basket is full
        px += w + CHIP_GAP;
      } else {
        px += this.chip(px, py, label, false, PLACE_ACTIONS[kind]) + CHIP_GAP;
      }
    }
  }
}
