import { AudioEngine } from "./audio/index.ts";
import {
  breathInto,
  createGubbaState,
  createPose,
  dampYaw,
  poseGubba,
  stepGubbaInPlace,
} from "./gubba/index.ts";
import { createStrokeEngine, RAKE_BY_ID } from "./rakes/index.ts";
import type { StrokeTelemetry } from "./rakes/index.ts";
import {
  CAMERA_PRESETS,
  MAX_ELEMENTS,
  RakeRenderer,
  clampOrbit,
  cloneRig,
  copyRig,
  presetRig,
  projectPoint,
  stepCameraInto,
  viewportRigInto,
  webgl2Available,
} from "./render/index.ts";
import type {
  GardenFrame,
  OverlayAction,
  OverlayState,
  SettingsPatch,
  SettingsTab,
} from "./render/index.ts";
import {
  SWEEP_DURATION_MS,
  applySweep,
  clearSandGrid,
  deflect,
  includeRect,
  rebuildRockMask,
  sandHash,
} from "./sand/index.ts";
import type { SandRect } from "./sand/index.ts";
import {
  DEFAULT_SETTINGS,
  ELEMENT_FOOTPRINTS,
  GARDEN_STORAGE_KEY,
  PRESETS,
  SETTINGS_STORAGE_KEY,
  applyPreset,
  createGardenStore,
  decodeGarden,
  decodeSettings,
  encodeGarden,
  encodeSettings,
} from "./state/index.ts";
import type {
  BreathPhase,
  CameraPresetId,
  CameraRig,
  ElementInstance,
  ElementKind,
  GardenState,
  GubbaEvent,
  GubbaVariant,
  MoodId,
  MoodSetting,
  PixelDensity,
  PresetId,
  RakeId,
  SettingsState,
  Vec2,
} from "./state/types.ts";
import {
  adjustMix,
  bindKeyboard,
  createDomMirror,
  effectiveMood,
  needsLandscape,
  nextBreathPattern,
  nextCameraPreset,
  nextGubbaVariant,
  nextMoodSetting,
  nextTalkMode,
  setGubbaVariant,
  setMoodSetting,
  setRake,
  toggleBreath,
  toggleDensity,
  toggleFlow,
  toggleMoodAuto,
  toggleMute,
  toggleRain,
  withHeardStories,
} from "./ui/index.ts";
import type { UiCommand } from "./ui/index.ts";

interface RakeMeTestApi {
  sandHash(): number;
  state(): {
    settings: SettingsState;
    mood: MoodId;
    camera: CameraRig;
    elementCount: number;
    elements: readonly ElementInstance[];
    panel: OverlayState["panel"];
    tab: SettingsTab;
    speech: string | null;
    watchGubbaRake: boolean;
    /** True while the turn-sideways prompt covers the garden (an upright phone). */
    rotateBlocked: boolean;
  };
  stroke(points: readonly Vec2[], rakeId?: RakeId): number;
  advance(ms: number): void;
  setMood(id: MoodId): void;
  setMoodSetting(setting: MoodSetting): void;
  setGubbaVariant(variant: GubbaVariant): void;
  setCamera(name: CameraPresetId): void;
  setDensity(density: PixelDensity): void;
  setBreath(on: boolean): void;
  setRain(on: boolean): void;
  setFlow(on: boolean): void;
  setWatchGubbaRake(on: boolean): void;
  openPanel(panel: OverlayState["panel"], tab?: SettingsTab): void;
  clickOverlay(fbX: number, fbY: number): OverlayAction | null;
  placeElement(kind: ElementKind, x: number, y: number): boolean;
  moveElement(id: string, x: number, y: number): boolean;
  removeElement(id: string): boolean;
  undo(): boolean;
  redo(): boolean;
  sweep(): void;
  loadPreset(id: PresetId): void;
  pick(fbX: number, fbY: number): ReturnType<RakeRenderer["pick"]>;
  sandPoint(fbX: number, fbY: number): Vec2 | null;
  /** A world point in framebuffer pixels under the current camera, or null if it is behind the camera. */
  project(x: number, y: number, z: number): { x: number; y: number } | null;
  /** Framebuffer bounding boxes of Gubba, the basket, each hanging rake and each placed element. */
  pickBounds(): ReturnType<RakeRenderer["pickBounds"]>;
  /** Where the speech scroll is drawn in this framebuffer. */
  speechRect(): { x: number; y: number; w: number; h: number };
  overlayHits(): ReturnType<RakeRenderer["overlayHits"]>;
  /** `scale` is device pixels per scene pixel; `uiScale` is scene pixels per overlay pixel. */
  fbSize(): { fbW: number; fbH: number; scale: number; uiScale: number; cssW: number; cssH: number };
  drawCalls(): number;
  failedModels(): readonly string[];
  standInModels(): readonly string[];
  frameHash(): number;
  paletteViolations(): number;
  particleCount(): number;
  exportPng(scale?: number, includeOverlay?: boolean): Promise<{ width: number; height: number; bytes: number }>;
  readonly audio: { state: AudioContextState | "locked"; masterGain: number };
}

declare global {
  interface Window {
    __rakeMe?: RakeMeTestApi;
  }
}

const SAVE_DEBOUNCE_MS = 1000;
const CLOCK_RECHECK_MS = 10 * 60 * 1000;
const HOKI_HOLD_MS = 800;
const TOUCH_RAKE_HOLD_MS = 350;
const TOUCH_PREVIEW_LINGER_MS = 2600;
const TOUCH_HOLD_MOVE_SLOP_PX = 16;
const HAPTIC_STONE_COOLDOWN_MS = 120;
const WATCH_SPEED_CELLS_PER_SEC = 40;
const STATIONARY_FOLEY_TIMEOUT_MS = 80;

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage quota or private browsing mode: ignore quietly.
  }
}

function loadInitialSettings(): SettingsState {
  const raw = readStorage(SETTINGS_STORAGE_KEY);
  return raw ? decodeSettings(raw) : {
    ...DEFAULT_SETTINGS,
    mix: { ...DEFAULT_SETTINGS.mix },
    heardStories: {},
  };
}

function loadInitialGarden(): GardenState | undefined {
  const raw = readStorage(GARDEN_STORAGE_KEY);
  if (!raw) return undefined;
  return decodeGarden(raw);
}

function formatExportFilename(now: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `gubbas-porch-${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}.png`;
}

// Precompute hover tag strings once so hover never allocates per frame
const HOVER_TAGS: Record<RakeId, string> = {
  sugi: `${RAKE_BY_ID.sugi.name} · ${RAKE_BY_ID.sugi.shortDesc}`,
  onami: `${RAKE_BY_ID.onami.name} · ${RAKE_BY_ID.onami.shortDesc}`,
  kinu: `${RAKE_BY_ID.kinu.name} · ${RAKE_BY_ID.kinu.shortDesc}`,
  hisui: `${RAKE_BY_ID.hisui.name} · ${RAKE_BY_ID.hisui.shortDesc}`,
  mikazuki: `${RAKE_BY_ID.mikazuki.name} · ${RAKE_BY_ID.mikazuki.shortDesc}`,
  tetsu: `${RAKE_BY_ID.tetsu.name} · ${RAKE_BY_ID.tetsu.shortDesc}`,
  wa: `${RAKE_BY_ID.wa.name} · ${RAKE_BY_ID.wa.shortDesc}`,
  take: `${RAKE_BY_ID.take.name} · ${RAKE_BY_ID.take.shortDesc}`,
  nagi: `${RAKE_BY_ID.nagi.name} · ${RAKE_BY_ID.nagi.shortDesc}`,
  hoki: `${RAKE_BY_ID.hoki.name} · hold to sweep`,
};

async function boot(): Promise<void> {
  const canvas = document.getElementById("garden-canvas");
  const fallback = document.getElementById("webgl2-fallback");
  const titleCard = document.getElementById("title-card");
  const rotatePrompt = document.getElementById("rotate-prompt");
  const stage = document.getElementById("stage");
  const srControls = document.getElementById("sr-controls");

  if (!(canvas instanceof HTMLCanvasElement)) return;
  const canvasEl: HTMLCanvasElement = canvas;
  if (!webgl2Available()) {
    if (fallback) fallback.hidden = false;
    if (titleCard) titleCard.hidden = true;
    return;
  }

  // An upright phone sees the turn-sideways prompt straight away, with the stage/title card inert and focus inside
  // the dialog even while models are loading; rotating during boot clears the prompt cleanly without getting stuck.
  let rotateBlocked = false;
  let rotatePrevFocus: HTMLElement | null = null;
  function applyRotateDom(blocked: boolean): void {
    if (blocked && !rotateBlocked) {
      const active = document.activeElement;
      rotatePrevFocus =
        active instanceof HTMLElement && active !== document.body && active !== document.documentElement
          ? active
          : null;
    }
    rotateBlocked = blocked;
    for (const el of [stage, titleCard, srControls]) {
      if (el) el.inert = blocked;
    }
    if (rotatePrompt) {
      rotatePrompt.hidden = !blocked;
      if (blocked) {
        rotatePrompt.focus();
      } else {
        const target =
          rotatePrevFocus && rotatePrevFocus.isConnected && !rotatePrevFocus.closest("[inert]")
            ? rotatePrevFocus
            : titleCard && !titleCard.hidden
              ? titleCard
              : canvas;
        rotatePrevFocus = null;
        if (target instanceof HTMLElement) target.focus();
      }
    }
  }
  if (rotatePrompt && needsLandscape(window.innerWidth, window.innerHeight)) {
    applyRotateDom(true);
  }
  const onBootResize = (): void => {
    const blocked = rotatePrompt !== null && needsLandscape(window.innerWidth, window.innerHeight);
    if (blocked !== rotateBlocked) applyRotateDom(blocked);
  };
  window.addEventListener("resize", onBootResize);

  const params = new URLSearchParams(window.location.search);
  const testMode = params.get("test") === "1";

  const initialSettings = loadInitialSettings();
  const initialGarden = loadInitialGarden();
  const store = createGardenStore(initialGarden, initialSettings);
  let settings: SettingsState = store.settings;

  const renderer = await RakeRenderer.create(canvas);
  window.removeEventListener("resize", onBootResize);
  const strokeEngine = createStrokeEngine(store.garden.sand);
  const watchEngine = createStrokeEngine(store.garden.sand);

  const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let reducedMotion = reducedMotionQuery?.matches ?? false;
  reducedMotionQuery?.addEventListener?.("change", (ev) => {
    reducedMotion = ev.matches;
  });

  // Clock state (frozen & manually stepped in ?test=1)
  let clockMs = 0;
  let lastWallMs = performance.now();
  let lastClockCheckMs = 0;
  let currentHour = new Date().getHours();
  let currentMood: MoodId = effectiveMood(settings.moodSetting, currentHour);

  const gubba = createGubbaState(
    settings.gubbaVariant,
    settings.talkMode,
    settings.heardStories,
    testMode ? 42 : Math.floor(Date.now() % 1_000_000),
    { startMs: 0, breathOn: settings.breathEnabled },
  );
  const gubbaPoseBuf = createPose();
  const gubbaPoseOpts = { out: gubbaPoseBuf, headYaw: 0 };
  const breathBuf: { phase: BreathPhase; amplitude: number; cycleIndex: number } = {
    phase: "inhale",
    amplitude: 0,
    cycleIndex: 0,
  };
  const gubbaTickEvent: Extract<GubbaEvent, { type: "tick" }> = {
    type: "tick",
    pointerOnWall: false,
    raking: false,
    rakeGridPos: null,
    rain: false,
    breathPhase: "inhale",
  };
  let gubbaHeadYaw = 0;

  const audio = new AudioEngine({
    seed: testMode ? 1 : 77,
    mood: currentMood,
    mix: settings.mix,
    rain: settings.rain,
  });

  // Camera state. `orbitRig` is the target preset+orbit+zoom; `orbitCurrent` eases toward it and is fitted at
  // every intermediate frame via `viewportRigInto` so damping never clips hero objects. `easingPreset` eases
  // `cameraRig` directly toward `cameraGoal` only during cross-preset transitions.
  let cameraPreset: CameraPresetId = settings.cameraPreset;
  let orbitRig: CameraRig = presetRig(cameraPreset);
  const orbitCurrent: CameraRig = cloneRig(orbitRig);
  const cameraGoal: CameraRig = presetRig(cameraPreset);
  const cameraRig: CameraRig = cloneRig(cameraGoal);
  let easingPreset = false;
  const capturedPointers = new Set<number>();

  function capturePointer(id: number): void {
    try {
      canvasEl.setPointerCapture(id);
      capturedPointers.add(id);
    } catch {
      // Synthetic event fallback
    }
  }

  function releasePointer(id: number): void {
    capturedPointers.delete(id);
    try {
      if (canvasEl.hasPointerCapture(id)) canvasEl.releasePointerCapture(id);
    } catch {
      // Ignore if already released
    }
  }

  function releaseAllCaptures(): void {
    for (const id of activeTouches.keys()) {
      capturedPointers.add(id);
    }
    for (const id of capturedPointers) {
      try {
        if (canvasEl.hasPointerCapture(id)) canvasEl.releasePointerCapture(id);
      } catch {
        // Ignore if already released
      }
    }
    capturedPointers.clear();
  }

  // Overlay & panel state
  let panel: OverlayState["panel"] = "none";
  let tab: SettingsTab = "look";
  let watchGubbaRake = false;
  const pointerFbBuf: Vec2 = { x: 0, y: 0 };
  let hasPointerFb = false;

  // Raking / hover / interaction state
  let hoverRake: RakeId | null = null;
  const rakeHeadBuf: Vec2 = { x: 96, y: 84 };
  let hasRakeHead = true;
  let rakeHeading = 0;
  const hoverTailBuf: Vec2 = { x: 88, y: 84 };
  let activePointerId: number | null = null;
  let activePointerType: "mouse" | "touch" | "pen" = "mouse";
  let raking = false;
  let virtualDown = false;
  let lastFoleyMoveMs = -Infinity;
  let lastFoleyScreenX = 0.5;
  let foleyStationarySilenced = true;
  let orbitDrag: { pointerId: number; startX: number; startY: number; az: number; el: number; twoFinger?: boolean } | null = null;
  let pinchDist: number | null = null;
  const activeTouches = new Map<number, { x: number; y: number }>();
  let touchRakeHold: {
    id: RakeId;
    pointerId: number;
    startMs: number;
    startEventTs: number;
    startX: number;
    startY: number;
    previewed: boolean;
  } | null = null;
  let hokiTouchHold: { pointerId: number; startX: number; startY: number } | null = null;
  let touchPreviewTag: { id: RakeId; untilMs: number } | null = null;
  let touchPlacingPointerId: number | null = null;
  let lastStoneHapticMs = -Infinity;
  let lastSpeechText: string | null = null;

  function haptic(ms: number): void {
    if (reducedMotion) return;
    try {
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(ms);
      }
    } catch {
      // Ignore blocked or unsupported Web Vibration API
    }
  }

  const zeroSpeedTelemetry: StrokeTelemetry = {
    active: true,
    speed: 0,
    tineCount: 1,
    tineWidth: 1,
    tineDepth: 1,
    changeRatio: 0,
    crossing: 0,
    head: { x: 0, y: 0 },
    tail: { x: 0, y: 0 },
    heading: 0,
    hitStone: false,
    dirtyRect: null,
  };

  // Element placement & move/remove state
  let placingKind: ElementKind | null = null;
  const placingPos: Vec2 = { x: 96, y: 56 };
  let movingElement: { id: string; kind: ElementKind; pointerId: number; x: number; y: number } | null = null;
  let nextElementSeq = 1;

  function uniqueElementId(kind: ElementKind): string {
    const used = new Set(store.garden.elements.map((e) => e.id));
    let id = `${kind}-${nextElementSeq++}`;
    while (used.has(id)) {
      id = `${kind}-${nextElementSeq++}`;
    }
    return id;
  }

  // Sweep state
  let sweepActive: { startedAtMs: number; prevElapsedMs: number; before: GardenState } | null = null;
  let strokeStartedDuringSweep = false;
  let deferredSweepBefore: GardenState | null = null;
  let hokiHoldStartMs: number | null = null;

  // Watch-Gubba-rake animated preset playback (uses dedicated watchEngine to never collide with hand strokeEngine)
  let watchPlayback: {
    presetId: PresetId;
    strokeIndex: number;
    pointIndex: number;
    segOffset: number;
    startedStroke: boolean;
    before: GardenState;
  } | null = null;
  const watchPointBuf: Vec2 = { x: 0, y: 0 };
  const watchBatchBuf: Vec2[] = [watchPointBuf];
  const virtualPtBuf: Vec2 = { x: 0, y: 0 };
  const virtualBatchBuf: Vec2[] = [virtualPtBuf];

  // Dirty upload tracking
  const dirtyRect: SandRect = { x: 0, y: 0, w: 0, h: 0 };
  let sandDirty = false;
  let sandReset = true;

  // Debounced persistence
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function flushSave(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      writeStorage(GARDEN_STORAGE_KEY, encodeGarden(store.garden));
    } catch {
      // Skip if over 64KB
    }
    writeStorage(SETTINGS_STORAGE_KEY, encodeSettings(settings));
  }
  function scheduleSave(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }
  window.addEventListener("visibilitychange", () => {
    if (document.hidden) flushSave();
  });
  window.addEventListener("pagehide", flushSave);

  function markDirty(r: SandRect | null): void {
    if (!r || r.w <= 0 || r.h <= 0) return;
    if (!sandDirty) {
      dirtyRect.x = r.x;
      dirtyRect.y = r.y;
      dirtyRect.w = r.w;
      dirtyRect.h = r.h;
      sandDirty = true;
    } else {
      includeRect(dirtyRect, r.x, r.y, r.w, r.h);
    }
  }

  function stopWatchPlayback(commit: boolean, snapToGolden = false): void {
    if (!watchPlayback) return;
    const { presetId, before } = watchPlayback;
    if (watchPlayback.startedStroke) {
      watchEngine.end();
      watchPlayback.startedStroke = false;
    }
    if (snapToGolden) {
      store.garden.elements = applyPreset(store.garden.sand, presetId);
      sandReset = true;
    }
    if (commit) {
      store.commitSnapshot(before);
      scheduleSave();
    }
    watchPlayback = null;
  }

  function applyFramingForCurrentViewport(instant = false, presetChanged = false): void {
    viewportRigInto(cameraGoal, orbitRig, cameraPreset, renderer.fbW, renderer.fbH, renderer.uiScale);
    if (instant || reducedMotion) {
      copyRig(orbitCurrent, orbitRig);
      copyRig(cameraRig, cameraGoal);
      easingPreset = false;
    } else if (presetChanged) {
      easingPreset = true;
    }
  }

  /** Applies an orbit or zoom: limits it against the preset, then refits the view so the garden stays framed. */
  function orbitTo(next: CameraRig): void {
    orbitRig = clampOrbit(next, CAMERA_PRESETS[cameraPreset].dist);
    applyFramingForCurrentViewport(false, false);
  }

  /** Shows the turn-sideways prompt on an upright phone and hands the garden back once it is turned. */
  function updateRotatePrompt(): void {
    const blocked = rotatePrompt !== null && needsLandscape(window.innerWidth, window.innerHeight);
    if (blocked === rotateBlocked) return;
    if (blocked) {
      // release pointer captures and clear anything in progress so nothing fires under the prompt
      releaseAllCaptures();
      activePointerId = null;
      hoverRake = null;
      hasPointerFb = false;
      orbitDrag = null;
      pinchDist = null;
      activeTouches.clear();
      hokiHoldStartMs = null;
      hokiTouchHold = null;
      touchRakeHold = null;
      touchPreviewTag = null;
      touchPlacingPointerId = null;
      movingElement = null;
      placingKind = null;
    }
    applyRotateDom(blocked);
  }

  function updateViewportSize(): void {
    if (raking) finishStroke();
    const dpr = window.devicePixelRatio || 1;
    const cssW = stage && stage.clientWidth > 0 ? stage.clientWidth : window.innerWidth;
    const cssH = stage && stage.clientHeight > 0 ? stage.clientHeight : window.innerHeight;
    const deviceW = Math.max(1, Math.round(cssW * dpr));
    const deviceH = Math.max(1, Math.round(cssH * dpr));
    renderer.resize(deviceW, deviceH, settings.density, dpr);
    applyFramingForCurrentViewport(true);
    updateRotatePrompt();
  }

  function syncSettings(next: SettingsState): void {
    const prev = settings;
    settings = next;
    store.settings = next;

    if (prev.gubbaVariant !== next.gubbaVariant) {
      gubba.variant = next.gubbaVariant;
    }
    if (prev.talkMode !== next.talkMode) {
      stepGubbaInPlace(gubba, { type: "talk_mode_changed", mode: next.talkMode }, clockMs);
    }
    if (prev.breathEnabled !== next.breathEnabled) {
      stepGubbaInPlace(gubba, { type: "breath_toggled", on: next.breathEnabled }, clockMs);
    }
    if (prev.rain !== next.rain) {
      audio.setRain(next.rain);
      stepGubbaInPlace(gubba, { type: "rain_toggled", on: next.rain }, clockMs);
    }
    if (prev.moodSetting !== next.moodSetting) {
      currentHour = new Date().getHours();
      const resolved = effectiveMood(next.moodSetting, currentHour);
      if (resolved !== currentMood) {
        currentMood = resolved;
        audio.setMood(currentMood);
        stepGubbaInPlace(gubba, { type: "mood_changed", mood: currentMood }, clockMs);
      }
    }
    if (prev.cameraPreset !== next.cameraPreset) {
      cameraPreset = next.cameraPreset;
      orbitRig = presetRig(cameraPreset);
      applyFramingForCurrentViewport(false, true);
    }
    if (prev.density !== next.density) {
      updateViewportSize();
    }
    if (
      prev.mix.master !== next.mix.master ||
      prev.mix.music !== next.mix.music ||
      prev.mix.foley !== next.mix.foley ||
      prev.mix.ambience !== next.mix.ambience ||
      prev.mix.muted !== next.mix.muted
    ) {
      audio.setMix(next.mix);
    }

    mirror.sync({ settings, mood: currentMood, watchGubbaRake });
    scheduleSave();
  }

  function startSweep(): void {
    if (sweepActive) return;
    stopWatchPlayback(true);
    if (reducedMotion) {
      if (store.sweep()) {
        sandReset = true;
        audio.playSweepWhoosh(0.4);
        stepGubbaInPlace(gubba, { type: "sweep" }, clockMs);
        scheduleSave();
      }
      return;
    }
    sweepActive = {
      startedAtMs: clockMs,
      prevElapsedMs: 0,
      before: store.snapshot(),
    };
    haptic(20);
    audio.playSweepWhoosh(SWEEP_DURATION_MS / 1000);
    stepGubbaInPlace(gubba, { type: "sweep" }, clockMs);
  }

  function triggerPreset(presetId: PresetId): void {
    if (raking) finishStroke();
    const originalBefore = sweepActive
      ? sweepActive.before
      : watchPlayback
        ? watchPlayback.before
        : store.snapshot();
    sweepActive = null;
    deferredSweepBefore = null;
    strokeStartedDuringSweep = false;
    stopWatchPlayback(false, false);

    if (watchGubbaRake && PRESETS[presetId].strokes.length > 0) {
      const preset = PRESETS[presetId];
      clearSandGrid(store.garden.sand);
      store.garden.elements = preset.elements.map((e) => ({ ...e }));
      rebuildRockMask(store.garden.sand, store.garden.elements);
      sandReset = true;
      watchPlayback = {
        presetId,
        strokeIndex: 0,
        pointIndex: 0,
        segOffset: 0,
        startedStroke: false,
        before: originalBefore,
      };
      panel = "none";
      return;
    }
    store.garden.elements = applyPreset(store.garden.sand, presetId);
    store.commitSnapshot(originalBefore);
    sandReset = true;
    panel = "none";
    scheduleSave();
  }

  function selectRakeTool(id: RakeId): void {
    if (id === "hoki") {
      startSweep();
      return;
    }
    placingKind = null;
    touchPlacingPointerId = null;
    movingElement = null;
    touchPreviewTag = null;
    if (settings.rake !== id) {
      syncSettings(setRake(settings, id));
    }
    haptic(10);
    audio.playRakeClack();
    stepGubbaInPlace(gubba, { type: "rake_selected", rakeId: id }, clockMs);
  }

  async function triggerExport(): Promise<void> {
    const blob = await renderer.exportPng(4, false);
    const filename = formatExportFilename(new Date());
    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
      share?: (data: { files: File[]; title: string }) => Promise<void>;
    };
    const file = new File([blob], filename, { type: "image/png" });
    if (nav.canShare?.({ files: [file] }) && nav.share) {
      try {
        await nav.share({ files: [file], title: "Gubba's Porch" });
        return;
      } catch {
        // User cancelled share; fall through quietly.
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function applySettingsPatch(patch: SettingsPatch): void {
    const next: SettingsState = {
      ...settings,
      ...patch,
      mix: patch.mix ? { ...settings.mix, ...patch.mix } : settings.mix,
    };
    syncSettings(next);
  }

  function handleOverlayAction(action: OverlayAction): void {
    if (action.type !== "none") haptic(8);
    switch (action.type) {
      case "none":
        return;
      case "close":
        panel = "none";
        return;
      case "tab":
        tab = action.tab;
        return;
      case "settings":
        applySettingsPatch(action.patch);
        return;
      case "preset":
        triggerPreset(action.id);
        return;
      case "watch":
        watchGubbaRake = action.on;
        mirror.sync({ settings, mood: currentMood, watchGubbaRake });
        return;
      case "export":
        void triggerExport();
        return;
      case "place":
        placingKind = action.kind;
        movingElement = null;
        panel = "none";
        return;
      case "hud":
        switch (action.id) {
          case "undo":
            if (!raking && store.undo()) {
              sandReset = true;
              scheduleSave();
            }
            return;
          case "redo":
            if (!raking && store.redo()) {
              sandReset = true;
              scheduleSave();
            }
            return;
          case "breath":
            syncSettings(toggleBreath(settings));
            return;
          case "mood":
            syncSettings(nextMoodSetting(settings));
            return;
          case "sound":
            syncSettings(toggleMute(settings));
            return;
          case "menu":
            panel = panel === "settings" ? "none" : "settings";
            return;
        }
    }
  }

  function handleUiCommand(cmd: UiCommand): void {
    if (rotateBlocked) return;
    unlockAudioIfNeeded();
    switch (cmd.type) {
      case "select_rake":
        if (!raking) selectRakeTool(cmd.rake);
        return;
      case "sweep":
        if (cmd.held) {
          if (hokiHoldStartMs === null) hokiHoldStartMs = clockMs;
        } else {
          hokiHoldStartMs = null;
        }
        return;
      case "sweep_once":
        startSweep();
        return;
      case "basket":
        placingKind = null;
        movingElement = null;
        panel = panel === "basket" ? "none" : "basket";
        return;
      case "place_element":
        placingKind = cmd.kind;
        movingElement = null;
        panel = "none";
        // Move focus off the hidden DOM mirror button so Arrow/Enter keys control stone placement cleanly
        renderer.pipeline.canvas.focus();
        return;
      case "toggle_watch":
        watchGubbaRake = !watchGubbaRake;
        mirror.sync({ settings, mood: currentMood, watchGubbaRake });
        return;
      case "adjust_mix":
        syncSettings(adjustMix(settings, cmd.channel, cmd.delta));
        return;
      case "undo":
        if (!raking && store.undo()) {
          sandReset = true;
          scheduleSave();
        }
        return;
      case "redo":
        if (!raking && store.redo()) {
          sandReset = true;
          scheduleSave();
        }
        return;
      case "toggle_breath":
        syncSettings(toggleBreath(settings));
        return;
      case "next_breath_pattern":
        syncSettings(nextBreathPattern(settings));
        return;
      case "toggle_mute":
        syncSettings(toggleMute(settings));
        return;
      case "next_mood":
        syncSettings(nextMoodSetting(settings));
        return;
      case "toggle_mood_auto":
        syncSettings(toggleMoodAuto(settings, currentHour));
        return;
      case "next_camera":
        if (!raking) syncSettings(nextCameraPreset(settings));
        return;
      case "toggle_density":
        if (!raking) syncSettings(toggleDensity(settings));
        return;
      case "next_talk_mode":
        syncSettings(nextTalkMode(settings));
        return;
      case "next_gubba_variant":
        syncSettings(nextGubbaVariant(settings));
        return;
      case "toggle_rain":
        syncSettings(toggleRain(settings));
        return;
      case "toggle_flow":
        syncSettings(toggleFlow(settings));
        return;
      case "apply_preset":
        triggerPreset(cmd.preset);
        return;
      case "export":
        void triggerExport();
        return;
      case "menu":
        if (placingKind !== null) {
          placingKind = null;
          return;
        }
        panel = panel === "none" ? "settings" : "none";
        return;
      case "orbit": {
        if (raking) return;
        orbitTo({ ...orbitRig, az: orbitRig.az + cmd.dir * 0.14 });
        return;
      }
      case "virtual_toggle": {
        // Accessible keyboard placement confirmation when a basket item is selected
        if (placingKind !== null) {
          const id = uniqueElementId(placingKind);
          const fp = ELEMENT_FOOTPRINTS[placingKind];
          const ok = store.placeElement({
            id,
            kind: placingKind,
            x: Math.round(placingPos.x),
            y: Math.round(placingPos.y),
            rx: fp.rx,
            ry: fp.ry,
            rotation: 0,
          });
          if (ok) {
            sandReset = true;
            audio.playStoneThud();
            stepGubbaInPlace(gubba, { type: "stone_placed" }, clockMs);
            scheduleSave();
          }
          placingKind = null;
          return;
        }
        // Ignore Enter if a pointer drag stroke is currently active
        if (raking && !virtualDown) return;
        if (!virtualDown) {
          stopWatchPlayback(true);
          virtualDown = true;
          raking = true;
          strokeStartedDuringSweep = sweepActive !== null;
          hasRakeHead = true;
          strokeEngine.begin(rakeHeadBuf, RAKE_BY_ID[settings.rake], "mouse", {
            stones: store.garden.elements,
            flow: settings.flow,
            heading: rakeHeading,
          });
        } else {
          finishStroke();
        }
        return;
      }
      case "virtual_move": {
        const step = cmd.fast ? 6 : 2;
        if (placingKind !== null) {
          placingPos.x = Math.max(0, Math.min(191, Math.round(placingPos.x + cmd.dx * step)));
          placingPos.y = Math.max(0, Math.min(111, Math.round(placingPos.y + cmd.dy * step)));
          return;
        }
        if (raking && !virtualDown) return;
        virtualPtBuf.x = Math.max(0, Math.min(191, rakeHeadBuf.x + cmd.dx * step));
        virtualPtBuf.y = Math.max(0, Math.min(111, rakeHeadBuf.y + cmd.dy * step));
        hasRakeHead = true;
        if (virtualDown) {
          const tel = strokeEngine.extend(virtualBatchBuf, 16.67);
          rakeHeadBuf.x = tel.head.x;
          rakeHeadBuf.y = tel.head.y;
          rakeHeading = tel.heading;
          markDirty(tel.dirtyRect);
          lastFoleyMoveMs = clockMs;
          lastFoleyScreenX = tel.head.x / 192;
          foleyStationarySilenced = false;
          audio.updateFoley(tel, lastFoleyScreenX);
        } else {
          rakeHeadBuf.x = virtualPtBuf.x;
          rakeHeadBuf.y = virtualPtBuf.y;
          if (cmd.dx !== 0 || cmd.dy !== 0) rakeHeading = Math.atan2(cmd.dy, cmd.dx);
        }
        return;
      }
    }
  }

  const mirror = createDomMirror(document, handleUiCommand);
  mirror.sync({ settings, mood: currentMood });
  bindKeyboard(window, handleUiCommand);

  let firstVisitDone = false;
  function unlockAudioIfNeeded(): void {
    // Retry audio unlock on user-activating gestures until AudioContext is running (handles mobile touch pointerup/click)
    if (audio.getDebugState().state !== "running") {
      void audio.unlock();
    }
    if (titleCard && !titleCard.hidden) {
      titleCard.hidden = true;
    }
    if (!firstVisitDone) {
      firstVisitDone = true;
      stepGubbaInPlace(gubba, { type: "first_visit" }, clockMs);
    }
  }

  if (titleCard) {
    const enterGarden = (): void => {
      unlockAudioIfNeeded();
    };
    titleCard.addEventListener("pointerdown", enterGarden);
    titleCard.addEventListener("pointerup", enterGarden);
    titleCard.addEventListener("click", enterGarden);
    titleCard.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        enterGarden();
      }
    });
  }

  function isInsideBed(p: Vec2 | null): p is Vec2 {
    return p !== null && p.x >= 0 && p.x < 192 && p.y >= 0 && p.y < 112;
  }

  function finishStroke(): void {
    if (!raking) return;
    raking = false;
    virtualDown = false;
    activePointerId = null;
    const patch = strokeEngine.end();
    const hadSweepOverlap = strokeStartedDuringSweep;
    strokeStartedDuringSweep = false;

    if (deferredSweepBefore !== null) {
      // Sweep finished while this stroke was still held: commit one unified snapshot from pre-sweep state
      store.commitSnapshot(deferredSweepBefore);
      deferredSweepBefore = null;
      if (patch.rect.w > 0 && patch.rect.h > 0) markDirty(patch.rect);
      scheduleSave();
    } else if (patch.rect.w > 0 && patch.rect.h > 0) {
      // While a sweep is still running, edits are absorbed into the sweep's single undo snapshot
      if (!sweepActive && !hadSweepOverlap) {
        store.commitStroke(patch);
        scheduleSave();
      }
      markDirty(patch.rect);
    }
    audio.updateFoley(null);
    foleyStationarySilenced = true;
  }

  canvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
  });

  canvas.addEventListener("click", () => {
    if (rotateBlocked) return;
    unlockAudioIfNeeded();
  });

  canvas.addEventListener("pointerdown", (ev) => {
    if (rotateBlocked) return;
    unlockAudioIfNeeded();
    if (ev.pointerType === "touch") {
      // Touch browsers apply implicit pointer capture on pointerdown; track every finger so rotate can release it.
      capturedPointers.add(ev.pointerId);
      activeTouches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (activeTouches.size === 2) {
        if (raking) finishStroke();
        touchRakeHold = null;
        touchPreviewTag = null;
        hokiHoldStartMs = null;
        hokiTouchHold = null;
        movingElement = null;
        touchPlacingPointerId = null;
        const pts = [...activeTouches.values()];
        pinchDist = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
        const cx = (pts[0]!.x + pts[1]!.x) * 0.5;
        const cy = (pts[0]!.y + pts[1]!.y) * 0.5;
        orbitDrag = { pointerId: ev.pointerId, startX: cx, startY: cy, az: orbitRig.az, el: orbitRig.el, twoFinger: true };
        return;
      }
    }

    const fb = renderer.clientToFramebuffer(ev.clientX, ev.clientY);
    pointerFbBuf.x = fb.x;
    pointerFbBuf.y = fb.y;
    hasPointerFb = true;

    // 1. Check pixel overlay (HUD / Settings / Basket tray) first
    const ovAction = renderer.overlayHit(fb.x, fb.y);
    if (ovAction !== null) {
      touchPreviewTag = null;
      handleOverlayAction(ovAction);
      return;
    }

    const wasBasket = panel === "basket";
    if (panel !== "none") {
      panel = "none";
    }

    // 2. Active stone placement mode (touch supports drag-to-aim and release-to-drop; mouse drops on click)
    if (placingKind !== null) {
      const sp = renderer.sandPoint(fb.x, fb.y);
      if (ev.pointerType === "touch") {
        if (isInsideBed(sp)) {
          placingPos.x = Math.max(0, Math.min(191, Math.round(sp.x)));
          placingPos.y = Math.max(0, Math.min(111, Math.round(sp.y)));
          touchPlacingPointerId = ev.pointerId;
          capturePointer(ev.pointerId);
        } else {
          placingKind = null;
          touchPlacingPointerId = null;
        }
        return;
      }
      if (isInsideBed(sp)) {
        const id = uniqueElementId(placingKind);
        const fp = ELEMENT_FOOTPRINTS[placingKind];
        const ok = store.placeElement({
          id,
          kind: placingKind,
          x: Math.round(sp.x),
          y: Math.round(sp.y),
          rx: fp.rx,
          ry: fp.ry,
          rotation: 0,
        });
        if (ok) {
          sandReset = true;
          haptic(15);
          audio.playStoneThud();
          stepGubbaInPlace(gubba, { type: "stone_placed" }, clockMs);
          scheduleSave();
        }
      }
      placingKind = null;
      return;
    }

    // 3. Pick 3D object via G-buffer part-id
    const picked = renderer.pick(fb.x, fb.y);
    if (picked.kind === "rake" && picked.id) {
      const rid = picked.id as RakeId;
      if (rid === "hoki") {
        // DESIGN.md 3.7: Hōki requires a 0.8 s hold to sweep; show its description immediately on touch
        hokiHoldStartMs = clockMs;
        if (ev.pointerType === "touch") {
          hokiTouchHold = { pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY };
          hoverRake = "hoki";
          touchPreviewTag = { id: "hoki", untilMs: clockMs + TOUCH_PREVIEW_LINGER_MS };
          mirror.say(HOVER_TAGS.hoki);
        }
        capturePointer(ev.pointerId);
      } else if (ev.pointerType === "touch") {
        // Touch: quick tap selects the rake; holding >= 350 ms previews its description without switching
        touchPreviewTag = null;
        touchRakeHold = {
          id: rid,
          pointerId: ev.pointerId,
          startMs: clockMs,
          startEventTs: ev.timeStamp,
          startX: ev.clientX,
          startY: ev.clientY,
          previewed: false,
        };
        capturePointer(ev.pointerId);
      } else {
        selectRakeTool(rid);
      }
      return;
    }
    touchPreviewTag = null;
    if (picked.kind === "gubba") {
      haptic(10);
      stepGubbaInPlace(gubba, { type: "gubba_tapped", activeRake: settings.rake }, clockMs);
      const updated = withHeardStories(settings, gubba.heardStories);
      if (updated !== settings) syncSettings(updated);
      return;
    }
    if (picked.kind === "basket") {
      panel = wasBasket ? "none" : "basket";
      return;
    }
    // 4. Drag an existing placed element to move it (or drop on the basket / off-bed to remove it)
    if (picked.kind === "element" && picked.id) {
      const existing = store.garden.elements.find((e) => e.id === picked.id);
      if (existing) {
        movingElement = {
          id: existing.id,
          kind: existing.kind,
          pointerId: ev.pointerId,
          x: existing.x,
          y: existing.y,
        };
        capturePointer(ev.pointerId);
        return;
      }
    }

    // 5. Clicking on the sand bed starts a rake stroke
    const sp = renderer.sandPoint(fb.x, fb.y);
    if (isInsideBed(sp)) {
      if (virtualDown) finishStroke();
      stopWatchPlayback(true);
      activePointerId = ev.pointerId;
      activePointerType = ev.pointerType === "touch" ? "touch" : ev.pointerType === "pen" ? "pen" : "mouse";
      raking = true;
      strokeStartedDuringSweep = sweepActive !== null;
      capturePointer(ev.pointerId);
      const rakeSpec = RAKE_BY_ID[settings.rake];
      const deflected = deflect(sp, store.garden.elements);
      rakeHeadBuf.x = deflected.x;
      rakeHeadBuf.y = deflected.y;
      hasRakeHead = true;
      strokeEngine.begin(sp, rakeSpec, activePointerType, {
        stones: store.garden.elements,
        flow: settings.flow,
        heading: rakeHeading,
      });
      const tel = strokeEngine.extend([sp], 16.67);
      rakeHeadBuf.x = tel.head.x;
      rakeHeadBuf.y = tel.head.y;
      rakeHeading = tel.heading;
      markDirty(tel.dirtyRect);
      if (tel.hitStone) audio.playStoneThud();
      lastFoleyMoveMs = clockMs;
      lastFoleyScreenX = fb.x / Math.max(1, renderer.fbW);
      foleyStationarySilenced = false;
      audio.updateFoley(tel, lastFoleyScreenX);
      return;
    }

    // 6. Dragging anywhere else (deck, wall, sky) orbits the camera
    orbitDrag = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      az: orbitRig.az,
      el: orbitRig.el,
    };
    capturePointer(ev.pointerId);
  });

  canvas.addEventListener("pointermove", (ev) => {
    if (rotateBlocked) return;
    if (ev.pointerType === "touch" && activeTouches.has(ev.pointerId)) {
      activeTouches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (activeTouches.size === 2 && orbitDrag) {
        const pts = [...activeTouches.values()];
        const d = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
        const cx = (pts[0]!.x + pts[1]!.x) * 0.5;
        const cy = (pts[0]!.y + pts[1]!.y) * 0.5;
        const nextDist = pinchDist ? orbitRig.dist * (pinchDist / Math.max(10, d)) : orbitRig.dist;
        pinchDist = d;
        orbitTo({
          ...orbitRig,
          az: orbitDrag.az - (cx - orbitDrag.startX) * 0.005,
          el: orbitDrag.el + (cy - orbitDrag.startY) * 0.005,
          dist: nextDist,
        });
        return;
      }
    }

    const fb = renderer.clientToFramebuffer(ev.clientX, ev.clientY);
    pointerFbBuf.x = fb.x;
    pointerFbBuf.y = fb.y;
    hasPointerFb = true;

    // Cancel a pending Hōki touch sweep hold if the thumb slides off the broom
    if (hokiTouchHold && ev.pointerId === hokiTouchHold.pointerId) {
      if (Math.hypot(ev.clientX - hokiTouchHold.startX, ev.clientY - hokiTouchHold.startY) > TOUCH_HOLD_MOVE_SLOP_PX) {
        hokiHoldStartMs = null;
        hokiTouchHold = null;
        if (hoverRake === "hoki") hoverRake = null;
        if (touchPreviewTag?.id === "hoki") touchPreviewTag = null;
      }
      return;
    }

    // Cancel a pending touch rake hold if the thumb slides off the rake
    if (touchRakeHold && ev.pointerId === touchRakeHold.pointerId) {
      if (Math.hypot(ev.clientX - touchRakeHold.startX, ev.clientY - touchRakeHold.startY) > TOUCH_HOLD_MOVE_SLOP_PX) {
        if (hoverRake === touchRakeHold.id) hoverRake = null;
        if (touchPreviewTag?.id === touchRakeHold.id) touchPreviewTag = null;
        touchRakeHold = null;
      }
      return;
    }

    // Touch drag-to-aim stone placement
    if (touchPlacingPointerId === ev.pointerId && placingKind !== null) {
      const sp = renderer.sandPoint(fb.x, fb.y);
      if (sp) {
        placingPos.x = Math.max(0, Math.min(191, Math.round(sp.x)));
        placingPos.y = Math.max(0, Math.min(111, Math.round(sp.y)));
      }
      return;
    }

    // Moving an existing placed element
    if (movingElement && ev.pointerId === movingElement.pointerId) {
      const sp = renderer.sandPoint(fb.x, fb.y);
      if (sp) {
        movingElement.x = Math.max(0, Math.min(191, Math.round(sp.x)));
        movingElement.y = Math.max(0, Math.min(111, Math.round(sp.y)));
      }
      return;
    }

    // Active rake stroke: raking NEVER moves the camera
    if (raking && !virtualDown && (activePointerId === null || ev.pointerId === activePointerId)) {
      const coalesced = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
      const events = coalesced.length > 0 ? coalesced : [ev];
      const pts: Vec2[] = [];
      for (const ce of events) {
        const cfb = renderer.clientToFramebuffer(ce.clientX, ce.clientY);
        const sp = renderer.sandPoint(cfb.x, cfb.y);
        if (sp) pts.push(sp);
      }
      if (pts.length > 0) {
        const tel = strokeEngine.extend(pts, 16.67);
        rakeHeadBuf.x = tel.head.x;
        rakeHeadBuf.y = tel.head.y;
        rakeHeading = tel.heading;
        markDirty(tel.dirtyRect);
        if (tel.hitStone) {
          audio.playStoneThud();
          if (clockMs - lastStoneHapticMs >= HAPTIC_STONE_COOLDOWN_MS) {
            lastStoneHapticMs = clockMs;
            haptic(14);
          }
        }
        lastFoleyMoveMs = clockMs;
        lastFoleyScreenX = fb.x / Math.max(1, renderer.fbW);
        foleyStationarySilenced = false;
        audio.updateFoley(tel, lastFoleyScreenX);
      }
      return;
    }

    // Active orbit drag
    if (orbitDrag && ev.pointerId === orbitDrag.pointerId) {
      orbitTo({
        ...orbitRig,
        az: orbitDrag.az - (ev.clientX - orbitDrag.startX) * 0.006,
        el: orbitDrag.el + (ev.clientY - orbitDrag.startY) * 0.006,
      });
      return;
    }

    // Placement ghost
    if (placingKind !== null) {
      const sp = renderer.sandPoint(fb.x, fb.y);
      if (sp) {
        placingPos.x = Math.max(0, Math.min(191, Math.round(sp.x)));
        placingPos.y = Math.max(0, Math.min(111, Math.round(sp.y)));
      }
      return;
    }

    // Hover feedback (only pick when overlay is clear)
    if (panel === "none" && renderer.overlayHit(fb.x, fb.y) === null) {
      const picked = renderer.pick(fb.x, fb.y);
      hoverRake = picked.kind === "rake" && picked.id ? (picked.id as RakeId) : null;
      const sp = renderer.sandPoint(fb.x, fb.y);
      if (
        isInsideBed(sp) &&
        hoverRake === null &&
        picked.kind !== "gubba" &&
        picked.kind !== "basket" &&
        picked.kind !== "element"
      ) {
        const def = deflect(sp, store.garden.elements);
        const L = RAKE_BY_ID[settings.rake].handle;
        const dx = def.x - hoverTailBuf.x;
        const dy = def.y - hoverTailBuf.y;
        const dl = Math.hypot(dx, dy);
        if (dl > 1e-4) {
          hoverTailBuf.x = def.x - (dx / dl) * L;
          hoverTailBuf.y = def.y - (dy / dl) * L;
          rakeHeading = Math.atan2(dy, dx);
        }
        rakeHeadBuf.x = def.x;
        rakeHeadBuf.y = def.y;
        hasRakeHead = true;
        canvas.style.cursor = "none";
      } else {
        canvas.style.cursor =
          hoverRake !== null ||
          picked.kind === "gubba" ||
          picked.kind === "basket" ||
          picked.kind === "element"
            ? "pointer"
            : "grab";
      }
    } else {
      hoverRake = null;
      canvas.style.cursor = "pointer";
    }
  });

  function onPointerUp(ev: PointerEvent): void {
    releasePointer(ev.pointerId);
    if (rotateBlocked) return;
    unlockAudioIfNeeded();
    activeTouches.delete(ev.pointerId);
    if (activeTouches.size < 2) {
      pinchDist = null;
      // Stop two-finger pinch/orbit immediately when either finger lifts so the remaining finger never snaps the view
      if (orbitDrag?.twoFinger) orbitDrag = null;
    }
    if (hokiHoldStartMs !== null) {
      hokiHoldStartMs = null;
      if (hokiTouchHold && ev.pointerId === hokiTouchHold.pointerId) hokiTouchHold = null;
      if (ev.pointerType === "touch" && hoverRake === "hoki") hoverRake = null;
    }

    if (touchRakeHold && ev.pointerId === touchRakeHold.pointerId) {
      const hold = touchRakeHold;
      touchRakeHold = null;
      const heldLong =
        hold.previewed ||
        clockMs - hold.startMs >= TOUCH_RAKE_HOLD_MS ||
        ev.timeStamp - hold.startEventTs >= TOUCH_RAKE_HOLD_MS;
      if (!heldLong) {
        selectRakeTool(hold.id);
      } else {
        if (!hold.previewed) {
          mirror.say(HOVER_TAGS[hold.id]);
          haptic(12);
        }
        touchPreviewTag = { id: hold.id, untilMs: clockMs + TOUCH_PREVIEW_LINGER_MS };
        if (hoverRake === hold.id) hoverRake = null;
      }
      return;
    }

    if (touchPlacingPointerId === ev.pointerId && placingKind !== null) {
      const fb = renderer.clientToFramebuffer(ev.clientX, ev.clientY);
      const sp = renderer.sandPoint(fb.x, fb.y);
      if (isInsideBed(sp)) {
        const id = uniqueElementId(placingKind);
        const fp = ELEMENT_FOOTPRINTS[placingKind];
        const ok = store.placeElement({
          id,
          kind: placingKind,
          x: Math.round(sp.x),
          y: Math.round(sp.y),
          rx: fp.rx,
          ry: fp.ry,
          rotation: 0,
        });
        if (ok) {
          sandReset = true;
          haptic(15);
          audio.playStoneThud();
          stepGubbaInPlace(gubba, { type: "stone_placed" }, clockMs);
          scheduleSave();
        }
      }
      touchPlacingPointerId = null;
      placingKind = null;
      return;
    }

    if (movingElement && ev.pointerId === movingElement.pointerId) {
      const fb = renderer.clientToFramebuffer(ev.clientX, ev.clientY);
      const picked = renderer.pick(fb.x, fb.y);
      const sp = renderer.sandPoint(fb.x, fb.y);
      if (picked.kind === "basket" || !isInsideBed(sp)) {
        if (store.removeElement(movingElement.id)) {
          sandReset = true;
          haptic(15);
          audio.playStoneThud();
          scheduleSave();
        }
      } else {
        if (store.moveElement(movingElement.id, Math.round(sp.x), Math.round(sp.y))) {
          sandReset = true;
          haptic(15);
          audio.playStoneThud();
          scheduleSave();
        }
      }
      movingElement = null;
      return;
    }

    if (raking && !virtualDown && (activePointerId === null || ev.pointerId === activePointerId)) {
      finishStroke();
    }
    if (orbitDrag && ev.pointerId === orbitDrag.pointerId) {
      orbitDrag = null;
    }
  }
  function onPointerCancel(ev: PointerEvent): void {
    releasePointer(ev.pointerId);
    activeTouches.delete(ev.pointerId);
    if (activeTouches.size < 2) {
      pinchDist = null;
      if (orbitDrag?.twoFinger) orbitDrag = null;
    }
    hokiHoldStartMs = null;
    if (hokiTouchHold && ev.pointerId === hokiTouchHold.pointerId) {
      hokiTouchHold = null;
      if (hoverRake === "hoki") hoverRake = null;
      if (touchPreviewTag?.id === "hoki") touchPreviewTag = null;
    }
    if (touchRakeHold && ev.pointerId === touchRakeHold.pointerId) {
      if (hoverRake === touchRakeHold.id) hoverRake = null;
      if (touchPreviewTag?.id === touchRakeHold.id) touchPreviewTag = null;
      touchRakeHold = null;
    }
    if (touchPlacingPointerId === ev.pointerId) {
      touchPlacingPointerId = null;
      placingKind = null;
    }
    if (rotateBlocked) return;
    if (movingElement && ev.pointerId === movingElement.pointerId) {
      // Cancel stone drag without moving or deleting the stone
      movingElement = null;
    }
    if (raking && !virtualDown && (activePointerId === null || ev.pointerId === activePointerId)) {
      finishStroke();
    }
    if (orbitDrag && ev.pointerId === orbitDrag.pointerId) {
      orbitDrag = null;
    }
  }
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);

  canvas.addEventListener(
    "wheel",
    (ev) => {
      if (rotateBlocked || raking || panel !== "none") return;
      ev.preventDefault();
      const scale = ev.deltaY > 0 ? 1.06 : 0.94;
      orbitTo({ ...orbitRig, dist: orbitRig.dist * scale });
    },
    { passive: false },
  );

  // Reusable frame & overlay objects (zero per-frame allocations)
  const frame: GardenFrame = {
    timeMs: 0,
    dtMs: 16.67,
    mood: currentMood,
    gubbaVariant: settings.gubbaVariant,
    reducedMotion,
    particles: !testMode && !reducedMotion,
    sand: store.garden.sand,
    sandDirty: null,
    sandReset: true,
    elements: store.garden.elements,
    heldRake: settings.rake,
    hoverRake: null,
    rakeHead: rakeHeadBuf,
    rakeHeading,
    raking: false,
    gubbaPose: gubbaPoseBuf,
    breathAmplitude: 0,
    breathGuide: settings.breathEnabled,
    sweepProgress: null,
    rain: settings.rain,
    placing: null,
  };

  const overlayState: OverlayState = {
    settings,
    breathAmplitude: 0,
    speech: null,
    panel: "none",
    tab: "look",
    watchGubbaRake: false,
    elementCount: store.garden.elements.length,
    maxElements: MAX_ELEMENTS,
    pointer: null,
  };

  const placingBuf = { kind: "stone_m" as ElementKind, x: 96, y: 56, rotation: 0 };

  function stepWatchPlayback(dtMs: number): void {
    if (!watchPlayback) return;
    const preset = PRESETS[watchPlayback.presetId];
    let budget = (WATCH_SPEED_CELLS_PER_SEC * dtMs) / 1000;
    while (budget > 0 && watchPlayback) {
      const strokeDef = preset.strokes[watchPlayback.strokeIndex];
      if (!strokeDef || strokeDef.points.length < 2) {
        stopWatchPlayback(true, true);
        return;
      }
      const rakeSpec = RAKE_BY_ID[strokeDef.rake];
      if (!watchPlayback.startedStroke) {
        const p0 = strokeDef.points[0]!;
        watchEngine.begin(p0, rakeSpec, "mouse", {
          stones: store.garden.elements,
          flow: true, // Always match applyPreset() golden replay
        });
        watchPlayback.startedStroke = true;
        watchPlayback.pointIndex = 0;
        watchPlayback.segOffset = 0;
      }
      const a = strokeDef.points[watchPlayback.pointIndex]!;
      const b = strokeDef.points[watchPlayback.pointIndex + 1];
      if (!b) {
        watchEngine.end();
        watchPlayback.startedStroke = false;
        watchPlayback.strokeIndex++;
        watchPlayback.pointIndex = 0;
        watchPlayback.segOffset = 0;
        continue;
      }
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      const rem = segLen - watchPlayback.segOffset;
      if (budget >= rem) {
        budget -= rem;
        watchPointBuf.x = b.x;
        watchPointBuf.y = b.y;
        const tel = watchEngine.extend(watchBatchBuf, dtMs);
        rakeHeadBuf.x = tel.head.x;
        rakeHeadBuf.y = tel.head.y;
        hasRakeHead = true;
        rakeHeading = tel.heading;
        markDirty(tel.dirtyRect);
        watchPlayback.pointIndex++;
        watchPlayback.segOffset = 0;
      } else {
        watchPlayback.segOffset += budget;
        const t = segLen > 0 ? watchPlayback.segOffset / segLen : 1;
        watchPointBuf.x = a.x + (b.x - a.x) * t;
        watchPointBuf.y = a.y + (b.y - a.y) * t;
        const tel = watchEngine.extend(watchBatchBuf, dtMs);
        rakeHeadBuf.x = tel.head.x;
        rakeHeadBuf.y = tel.head.y;
        hasRakeHead = true;
        rakeHeading = tel.heading;
        markDirty(tel.dirtyRect);
        budget = 0;
      }
    }
  }

  function stepFrame(dtMs: number, doRender = true): void {
    clockMs += dtMs;

    // Periodic auto-mood clock re-check every 10 minutes
    if (settings.moodSetting === "auto" && clockMs - lastClockCheckMs >= CLOCK_RECHECK_MS) {
      lastClockCheckMs = clockMs;
      currentHour = new Date().getHours();
      const resolved = effectiveMood("auto", currentHour);
      if (resolved !== currentMood) {
        currentMood = resolved;
        audio.setMood(currentMood);
        stepGubbaInPlace(gubba, { type: "mood_changed", mood: currentMood }, clockMs);
        mirror.sync({ settings, mood: currentMood, watchGubbaRake });
      }
    }

    // Hold `0` or Hōki for 0.8 s to trigger smooth-all sweep
    if (hokiHoldStartMs !== null && clockMs - hokiHoldStartMs >= HOKI_HOLD_MS) {
      hokiHoldStartMs = null;
      hokiTouchHold = null;
      if (hoverRake === "hoki") hoverRake = null;
      touchPreviewTag = null;
      startSweep();
    }

    // Hold a hanging rake on touch for 350 ms to lift it and preview its description without switching
    if (touchRakeHold !== null && !touchRakeHold.previewed && clockMs - touchRakeHold.startMs >= TOUCH_RAKE_HOLD_MS) {
      touchRakeHold.previewed = true;
      hoverRake = touchRakeHold.id;
      touchPreviewTag = { id: touchRakeHold.id, untilMs: clockMs + TOUCH_PREVIEW_LINGER_MS };
      mirror.say(HOVER_TAGS[touchRakeHold.id]);
      haptic(12);
    }
    if (touchPreviewTag !== null && touchRakeHold === null && hokiHoldStartMs === null && clockMs >= touchPreviewTag.untilMs) {
      touchPreviewTag = null;
    }

    // Decay stationary rake foley smoothly to silence when hand rests
    if (raking && !foleyStationarySilenced && clockMs - lastFoleyMoveMs > STATIONARY_FOLEY_TIMEOUT_MS) {
      foleyStationarySilenced = true;
      audio.updateFoley(zeroSpeedTelemetry, lastFoleyScreenX);
    }

    // Active Hōki sweep progression
    let sweepProgress: number | null = null;
    if (sweepActive) {
      const elapsed = clockMs - sweepActive.startedAtMs;
      const changed = applySweep(store.garden.sand, sweepActive.prevElapsedMs, Math.min(elapsed, SWEEP_DURATION_MS));
      sweepActive.prevElapsedMs = elapsed;
      if (changed) sandReset = true;
      if (elapsed >= SWEEP_DURATION_MS) {
        if (raking && strokeStartedDuringSweep) {
          if (deferredSweepBefore === null) {
            deferredSweepBefore = sweepActive.before;
          }
        } else {
          store.commitSnapshot(sweepActive.before);
          scheduleSave();
        }
        sweepActive = null;
      } else {
        const t = Math.max(0, Math.min(1, elapsed / SWEEP_DURATION_MS));
        sweepProgress = t * t * (3 - 2 * t);
      }
    }

    // Animated preset playback ("Watch Gubba rake")
    stepWatchPlayback(dtMs);

    // Breath clock (zero-allocation)
    breathInto(breathBuf, settings.breathPattern, clockMs);
    audio.setBreathAmplitude(breathBuf.amplitude);

    // Gubba tick & pose (zero-allocation in-place)
    gubbaTickEvent.pointerOnWall = hoverRake !== null;
    gubbaTickEvent.raking = raking || watchPlayback !== null;
    gubbaTickEvent.rakeGridPos = hasRakeHead ? rakeHeadBuf : null;
    gubbaTickEvent.rain = settings.rain;
    gubbaTickEvent.breathPhase = breathBuf.phase;
    stepGubbaInPlace(gubba, gubbaTickEvent, clockMs);

    gubbaHeadYaw = dampYaw(gubbaHeadYaw, gubba.targetYaw, dtMs);
    gubbaPoseOpts.headYaw = gubbaHeadYaw;
    poseGubba(gubba, breathBuf.amplitude, clockMs, gubbaPoseOpts);
    mirror.mirrorSpeech(gubba.speech);

    // Camera damping: frozen while actively raking so pointer->sand mapping never shifts mid-stroke.
    // Within a preset, damp `orbitCurrent` and fit every intermediate step via `viewportRigInto` so hero objects
    // never clip during an orbit drag; across preset switches, ease directly to the target preset's fitted rig.
    if (!raking) {
      if (easingPreset) {
        stepCameraInto(cameraRig, cameraRig, cameraGoal, reducedMotion, dtMs);
        if (
          cameraRig.az === cameraGoal.az &&
          cameraRig.el === cameraGoal.el &&
          cameraRig.dist === cameraGoal.dist &&
          cameraRig.target.x === cameraGoal.target.x &&
          cameraRig.target.y === cameraGoal.target.y &&
          cameraRig.target.z === cameraGoal.target.z
        ) {
          copyRig(orbitCurrent, orbitRig);
          easingPreset = false;
        }
      } else {
        stepCameraInto(orbitCurrent, orbitCurrent, orbitRig, reducedMotion, dtMs);
        viewportRigInto(cameraRig, orbitCurrent, cameraPreset, renderer.fbW, renderer.fbH, renderer.uiScale);
      }
    }

    // Build speech text (active touch rake preview takes priority, then Gubba speech, then mouse hover tag)
    let speechText: string | null =
      touchPreviewTag !== null ? HOVER_TAGS[touchPreviewTag.id] : (gubba.speech?.text ?? null);
    if (speechText === null && hoverRake !== null) {
      speechText = HOVER_TAGS[hoverRake];
    }
    lastSpeechText = speechText;

    // Fill reusable GardenFrame
    frame.timeMs = clockMs;
    frame.dtMs = dtMs;
    frame.mood = currentMood;
    frame.gubbaVariant = settings.gubbaVariant;
    frame.reducedMotion = reducedMotion;
    frame.particles = !testMode && !reducedMotion;
    frame.sand = store.garden.sand;
    frame.sandDirty = sandDirty ? dirtyRect : null;
    frame.sandReset = sandReset;
    frame.elements = store.garden.elements;
    frame.heldRake = watchPlayback
      ? (PRESETS[watchPlayback.presetId].strokes[watchPlayback.strokeIndex]?.rake ?? settings.rake)
      : settings.rake;
    frame.hoverRake = hoverRake;
    frame.rakeHead = hasRakeHead ? rakeHeadBuf : null;
    frame.rakeHeading = rakeHeading;
    frame.raking = raking || watchPlayback !== null;
    frame.gubbaPose = gubbaPoseBuf;
    frame.breathAmplitude = breathBuf.amplitude;
    frame.breathGuide = settings.breathEnabled;
    frame.sweepProgress = sweepProgress;
    frame.rain = settings.rain;
    if (placingKind !== null) {
      placingBuf.kind = placingKind;
      placingBuf.x = placingPos.x;
      placingBuf.y = placingPos.y;
      placingBuf.rotation = 0;
      frame.placing = placingBuf;
    } else if (movingElement !== null) {
      placingBuf.kind = movingElement.kind;
      placingBuf.x = movingElement.x;
      placingBuf.y = movingElement.y;
      placingBuf.rotation = 0;
      frame.placing = placingBuf;
    } else {
      frame.placing = null;
    }

    overlayState.settings = settings;
    overlayState.breathAmplitude = breathBuf.amplitude;
    overlayState.speech = speechText;
    overlayState.panel = panel;
    overlayState.tab = tab;
    overlayState.watchGubbaRake = watchGubbaRake;
    overlayState.elementCount = store.garden.elements.length;
    overlayState.maxElements = MAX_ELEMENTS;
    overlayState.pointer = hasPointerFb ? pointerFbBuf : null;

    if (doRender) {
      renderer.render(frame, cameraRig, overlayState);
      sandDirty = false;
      sandReset = false;
    }
  }

  updateViewportSize();
  window.addEventListener("resize", updateViewportSize);

  // Render initial frame immediately
  stepFrame(0);

  if (!testMode) {
    const rafLoop = (now: number): void => {
      const dt = Math.min(50, Math.max(0, now - lastWallMs));
      lastWallMs = now;
      stepFrame(dt);
      requestAnimationFrame(rafLoop);
    };
    requestAnimationFrame(rafLoop);
  }

  // Expose deterministic test hooks in ?test=1 or dev builds (DESIGN.md 9.5)
  if (testMode || import.meta.env.DEV) {
    window.__rakeMe = {
      sandHash: () => sandHash(store.garden.sand),
      state: () => ({
        settings: { ...settings, mix: { ...settings.mix }, heardStories: { ...settings.heardStories } },
        mood: currentMood,
        camera: cloneRig(cameraRig),
        elementCount: store.garden.elements.length,
        elements: store.garden.elements.map((e) => ({ ...e })),
        panel,
        tab,
        speech: lastSpeechText,
        watchGubbaRake,
        rotateBlocked,
      }),
      stroke: (points, rakeId) => {
        if (points.length === 0) return sandHash(store.garden.sand);
        const tool = RAKE_BY_ID[rakeId ?? settings.rake];
        const first = points[0]!;
        const second = points[1];
        const heading = second ? Math.atan2(second.y - first.y, second.x - first.x) : 0;
        strokeEngine.begin(first, tool, "mouse", {
          stones: store.garden.elements,
          flow: settings.flow,
          heading,
        });
        const tel = strokeEngine.extend(points, 16.67);
        const patch = strokeEngine.end();
        if (patch.rect.w > 0 && patch.rect.h > 0) {
          store.commitStroke(patch);
          markDirty(patch.rect);
          flushSave();
        }
        rakeHeadBuf.x = tel.head.x;
        rakeHeadBuf.y = tel.head.y;
        hasRakeHead = true;
        rakeHeading = tel.heading;
        stepFrame(0);
        return sandHash(store.garden.sand);
      },
      advance: (ms) => {
        const steps = Math.max(1, Math.ceil(ms / 16.67));
        const stepMs = ms / steps;
        for (let i = 0; i < steps; i++) {
          stepFrame(stepMs, i === steps - 1);
        }
      },
      setMood: (id) => {
        syncSettings(setMoodSetting(settings, id));
        currentMood = id;
        flushSave();
        stepFrame(0);
        stepFrame(2500);
      },
      setMoodSetting: (setting) => {
        syncSettings(setMoodSetting(settings, setting));
        flushSave();
        stepFrame(0);
        stepFrame(2500);
      },
      setGubbaVariant: (variant) => {
        syncSettings(setGubbaVariant(settings, variant));
        flushSave();
        stepFrame(0);
      },
      setCamera: (name) => {
        cameraPreset = name;
        settings = { ...settings, cameraPreset: name };
        orbitRig = presetRig(cameraPreset);
        applyFramingForCurrentViewport(true);
        flushSave();
        stepFrame(0);
      },
      setDensity: (density) => {
        syncSettings({ ...settings, density });
        flushSave();
        stepFrame(0);
      },
      setBreath: (on) => {
        syncSettings({ ...settings, breathEnabled: on });
        flushSave();
        stepFrame(0);
      },
      setRain: (on) => {
        syncSettings({ ...settings, rain: on });
        flushSave();
        stepFrame(0);
      },
      setFlow: (on) => {
        syncSettings({ ...settings, flow: on });
        flushSave();
        stepFrame(0);
      },
      setWatchGubbaRake: (on) => {
        watchGubbaRake = on;
        stepFrame(0);
      },
      openPanel: (p, t) => {
        panel = p;
        if (t) tab = t;
        stepFrame(0);
      },
      clickOverlay: (fbX, fbY) => {
        const act = renderer.overlayHit(fbX, fbY);
        if (act) {
          handleOverlayAction(act);
          flushSave();
          stepFrame(0);
        }
        return act;
      },
      placeElement: (kind, x, y) => {
        const fp = ELEMENT_FOOTPRINTS[kind];
        const ok = store.placeElement({
          id: uniqueElementId(kind),
          kind,
          x: Math.round(x),
          y: Math.round(y),
          rx: fp.rx,
          ry: fp.ry,
          rotation: 0,
        });
        if (ok) {
          sandReset = true;
          flushSave();
          stepFrame(0);
        }
        return ok;
      },
      moveElement: (id, x, y) => {
        const ok = store.moveElement(id, Math.round(x), Math.round(y));
        if (ok) {
          sandReset = true;
          flushSave();
          stepFrame(0);
        }
        return ok;
      },
      removeElement: (id) => {
        const ok = store.removeElement(id);
        if (ok) {
          sandReset = true;
          flushSave();
          stepFrame(0);
        }
        return ok;
      },
      undo: () => {
        const ok = store.undo();
        if (ok) {
          sandReset = true;
          flushSave();
          stepFrame(0);
        }
        return ok;
      },
      redo: () => {
        const ok = store.redo();
        if (ok) {
          sandReset = true;
          flushSave();
          stepFrame(0);
        }
        return ok;
      },
      sweep: () => {
        startSweep();
        stepFrame(0);
      },
      loadPreset: (id) => {
        triggerPreset(id);
        flushSave();
        stepFrame(0);
      },
      pick: (fbX, fbY) => renderer.pick(fbX, fbY),
      sandPoint: (fbX, fbY) => renderer.sandPoint(fbX, fbY),
      project: (x, y, z) => {
        const p = projectPoint(cameraRig, { x, y, z }, renderer.fbW, renderer.fbH);
        return p ? { x: p.x, y: p.y } : null;
      },
      pickBounds: () => renderer.pickBounds(),
      speechRect: () => renderer.overlay.speechRect(),
      overlayHits: () => renderer.overlayHits(),
      fbSize: () => {
        const r = canvas.getBoundingClientRect();
        return {
          fbW: renderer.fbW,
          fbH: renderer.fbH,
          scale: renderer.scale,
          uiScale: renderer.uiScale,
          cssW: Math.round(r.width),
          cssH: Math.round(r.height),
        };
      },
      drawCalls: () => renderer.drawCalls,
      failedModels: () => renderer.failedModels,
      standInModels: () => renderer.standInModels,
      frameHash: () => renderer.frameHash(),
      paletteViolations: () => renderer.paletteViolations(),
      particleCount: () => renderer.garden.particles.count,
      exportPng: async (scale = 4, includeOverlay = true) => {
        const blob = await renderer.exportPng(scale, includeOverlay);
        const bmp = await createImageBitmap(blob);
        const res = { width: bmp.width, height: bmp.height, bytes: blob.size };
        bmp.close();
        return res;
      },
      get audio() {
        return audio.getDebugState();
      },
    };
  }
}

void boot();
