import { AudioEngine } from "./audio/index.ts";
import {
  applyAutoGait,
  autoPhase,
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
  GUBBA_YAW,
  HANG_Z,
  MAX_ELEMENTS,
  PROP_ORIGINS,
  RACK_SLOTS,
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
  GardenAutoFrame,
  GardenFrame,
  OverlayAction,
  OverlayState,
  SettingsPatch,
  SettingsTab,
} from "./render/index.ts";
import { SWEEP_DURATION_MS, applySweep, deflect, includeRect, sandHash } from "./sand/index.ts";
import type { SandRect } from "./sand/index.ts";
import {
  DEFAULT_SETTINGS,
  ELEMENT_FOOTPRINTS,
  GARDEN_STORAGE_KEY,
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
  PickResult,
  PixelDensity,
  PresetId,
  RakeId,
  SettingsState,
  Vec2,
} from "./state/types.ts";
import {
  TOUCH_BRUSH_RADIUS_PX,
  TOUCH_OVERLAY_SLOP_PX,
  TOUCH_PICK_RADIUS_PX,
  TOUCH_SLOP_PX,
  VISUAL_VIEWPORT_MAX_SCALE,
  adjustMix,
  bindKeyboard,
  boundedViewportSide,
  createAutoRunner,
  createDomMirror,
  createHaptics,
  createTouchBrush,
  discOffsets,
  effectiveMood,
  hapticSource,
  needsLandscape,
  nextBreathPattern,
  nextCameraPreset,
  nextGubbaVariant,
  nextMoodSetting,
  nextTalkMode,
  pullTouchBrush,
  resetTouchBrush,
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
import type { HapticKind, HapticSource, UiCommand } from "./ui/index.ts";

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
    /** The hanging rake currently lifted off the wall by a hover or a thumb, if any. */
    hoverRake: RakeId | null;
    watchGubbaRake: boolean;
    gubbaMode: boolean;
    undoCount: number;
    redoCount: number;
    /** True while the turn-sideways prompt covers the garden (an upright phone). */
    rotateBlocked: boolean;
  };
  /** Where Gubba is and what he is doing while he rakes the garden himself. */
  auto(): {
    mode: boolean;
    watch: boolean;
    phase: string;
    target: PresetId | null;
    rootPos: { x: number; y: number; z: number };
    yaw: number;
    seated: boolean;
    working: boolean;
    heldRake: RakeId | null;
    /** True while his rake is on the sand in a stroke, or the broom is sweeping. */
    raking: boolean;
    carriedKind: ElementKind | null;
    sandPlan: "none" | "nagi" | "sweep" | null;
    lastSealDiffCells: number;
    cyclesCompleted: number;
  };
  setGubbaMode(on: boolean): void;
  /** Asks Gubba for one preset: the next garden in Gubba mode, otherwise a single "Watch" run. */
  autoRequest(id: PresetId): boolean;
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
  /** How many haptics have played since boot, and the last kind. */
  haptics(): { count: number; last: HapticKind | null };
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
/** A second finger landing this soon after the first means a pinch was meant, not a stroke. */
const PINCH_GRACE_MS = 150;
/** A stroke shorter than this when a second finger lands was the pinch's first finger settling. */
const PINCH_TRAVEL_PX = 24;
/** A touch that lands this close outside the bed (on its frame) still starts a stroke instead of an orbit. */
const TOUCH_BED_MARGIN_CELLS = 8;
/** The held rake follows a touch stroke no further than this outside the bed, so it never passes through the wall. */
const TOUCH_RAKE_VISUAL_MARGIN_CELLS = 8;
/** How far outside the bed a touch stroke's path is followed; the widest rake reaches 18 cells. */
const TOUCH_STROKE_REACH_CELLS = 192;
/** A mouse has to move this far with a stone held before the stone starts to follow. */
const MOUSE_DRAG_SLOP_PX = 3;
/** Largest touch search radius in framebuffer pixels, whatever the pixel density. */
const TOUCH_SEARCH_MAX_FB = 8;
const TOUCH_SEARCH_OFFSETS = discOffsets(TOUCH_SEARCH_MAX_FB);
const STATIONARY_FOLEY_TIMEOUT_MS = 80;
/** After a resume or a turn of the screen the canvas is fitted again this long later, and once more after that. */
const RESUME_SETTLE_SOON_MS = 150;
const RESUME_SETTLE_LATE_MS = 400;

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

// Shown while a stone picked from the basket by touch waits to be placed: a finger has no ghost to follow
const PLACE_HINTS = Object.fromEntries(
  Object.entries(ELEMENT_FOOTPRINTS).map(([kind, fp]) => [kind, `${fp.label} · touch the sand to place`]),
) as Record<ElementKind, string>;

const NOTHING_PICKED: PickResult = { kind: "none" };

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
      // preventScroll: moving focus must never slide the page under the stage (iOS scrolls a focused element
      // into view even on a page with nothing to scroll)
      if (blocked) {
        rotatePrompt.focus({ preventScroll: true });
      } else {
        const target =
          rotatePrevFocus && rotatePrevFocus.isConnected && !rotatePrevFocus.closest("[inert]")
            ? rotatePrevFocus
            : titleCard && !titleCard.hidden
              ? titleCard
              : canvas;
        rotatePrevFocus = null;
        if (target instanceof HTMLElement) target.focus({ preventScroll: true });
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
  // True once the player has brought their rake over the sand (pointer hover, arrow keys). While Gubba is at
  // work and it is false, their rake waits on the wall instead of lying on the bed where he walks.
  let playerRakeOut = false;
  let rakeHeading = 0;
  const hoverTailBuf: Vec2 = { x: 88, y: 84 };
  let activePointerId: number | null = null;
  let activePointerType: "mouse" | "touch" | "pen" = "mouse";
  let raking = false;
  let virtualDown = false;
  let lastFoleyMoveMs = -Infinity;
  let lastFoleyScreenX = 0.5;
  let foleyStationarySilenced = true;
  // Orbit drags apply each move's own delta, so reversing at an orbit limit responds at once instead of first
  // unwinding the overshoot. `engaged` stays false while a touch is still inside the tap slop.
  let orbitDrag: { pointerId: number; lastX: number; lastY: number; engaged: boolean; twoFinger?: boolean } | null = null;
  let pinchDist: number | null = null;
  // Touch stroke bookkeeping: the string brush that steadies the finger, and what decides whether a stroke was
  // really the first finger of a pinch (see `endStrokeForSecondFinger`).
  const touchBrush = createTouchBrush();
  const strokePressSand: Vec2 = { x: 0, y: 0 };
  const strokePts: Vec2[] = [];
  let strokeDownTs = 0;
  let strokeTravelPx = 0;
  let strokeLastClientX = 0;
  let strokeLastClientY = 0;
  let strokeCarving = false;
  let strokeEngineBegun = false;
  let strokeSawSweep = false;
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
  let placingByTouch = false;
  let lastPointerTouch = false;
  let lastSpeechText: string | null = null;

  // Touch-only feedback: every call names its source, and anything but a finger is silent (see ui/haptics.ts).
  // iOS plays its tick only from inside a pointer handler, so those calls stay synchronous in the handlers below.
  const haptics = createHaptics({
    navigator,
    document,
    matchMedia: typeof window.matchMedia === "function" ? (q) => window.matchMedia(q) : undefined,
    now: () => performance.now(),
  });

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
  // A held stone keeps the offset between its centre and the grab point, and follows only once the pointer has
  // left the tap slop, so pressing a stone never makes it jump.
  let movingElement: {
    id: string;
    kind: ElementKind;
    pointerId: number;
    x: number;
    y: number;
    offX: number;
    offY: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null = null;
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

  const virtualPtBuf: Vec2 = { x: 0, y: 0 };
  const virtualBatchBuf: Vec2[] = [virtualPtBuf];

  // Dirty upload tracking
  const dirtyRect: SandRect = { x: 0, y: 0, w: 0, h: 0 };
  let sandDirty = false;
  let sandReset = true;

  // Gubba mode and "Watch: Gubba rakes": the director says what Gubba does, the runner does it to the garden.
  // Nothing here is a touch, so no haptic ever fires for it.
  let announcedGubbaMode = false;
  const runner = createAutoRunner(
    store,
    {
      home: PROP_ORIGINS.gubba,
      homeYaw: GUBBA_YAW,
      basket: PROP_ORIGINS.basket,
      shishi: PROP_ORIGINS.shishi,
      rackSlots: RACK_SLOTS,
      hangZ: HANG_Z,
      footprints: ELEMENT_FOOTPRINTS,
    },
    {
      sandDirty: markDirty,
      sandReset: () => {
        sandReset = true;
      },
      rakeClack: () => audio.playRakeClack(),
      stoneThud: () => audio.playStoneThud(),
      sweepWhoosh: (seconds) => audio.playSweepWhoosh(seconds),
      foley: (telemetry, screenX) => audio.updateFoley(telemetry, screenX),
      line: (pool) => {
        stepGubbaInPlace(gubba, { type: pool }, clockMs);
      },
      changed: () => {
        syncMirror();
        if (runner.mode !== announcedGubbaMode) {
          announcedGubbaMode = runner.mode;
          mirror.say(announcedGubbaMode ? "Gubba mode on. Gubba is raking the garden." : "Gubba mode off.");
        }
        scheduleSave();
      },
    },
    testMode ? 42 : Math.floor(Date.now() % 1_000_000),
  );
  const autoFrame: GardenAutoFrame = {
    rake: null,
    tip: { x: 0, y: 0, z: 0 },
    grip: { x: 0, y: 0, z: 0 },
    carried: null,
    carriedPos: { x: 0, y: 0, z: 0 },
    carriedYaw: 0,
  };

  // Debounced persistence
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function flushSave(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      // while Gubba is at work the garden worth keeping is the one the player left, not his half-raked one
      writeStorage(GARDEN_STORAGE_KEY, encodeGarden(runner.before ?? store.garden));
    } catch {
      // Skip if over 64KB
    }
    writeStorage(SETTINGS_STORAGE_KEY, encodeSettings(settings));
  }
  function scheduleSave(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }
  // Leaving the foreground ends whatever a hand was doing first, so a stroke in progress is in what gets saved
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearActiveInteractions();
      flushSave();
    } else {
      resumeViewport();
    }
  });
  window.addEventListener("pagehide", () => {
    clearActiveInteractions();
    flushSave();
  });
  // Control Center, the app switcher or a system sheet takes the fingers away without lifting them for the page
  window.addEventListener("blur", clearActiveInteractions);

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

  function syncMirror(): void {
    mirror.sync({ settings, mood: currentMood, watchGubbaRake, gubbaMode: runner.mode });
  }

  /**
   * The player is editing the garden: Gubba gives way. Gubba mode turns off, whatever he has done so far becomes
   * one undo entry, and he walks his rake home. Called before every edit the player makes.
   */
  function yieldToPlayer(): void {
    runner.yield(settings.rake);
  }

  /** Runs a sweep the player started to its end at once, as its one undo entry. */
  function finishPlayerSweep(): void {
    if (!sweepActive) return;
    if (applySweep(store.garden.sand, sweepActive.prevElapsedMs, SWEEP_DURATION_MS)) sandReset = true;
    store.commitSnapshot(sweepActive.before);
    sweepActive = null;
    deferredSweepBefore = null;
    strokeStartedDuringSweep = false;
    scheduleSave();
  }

  /** Finishes whatever the player has in hand, so Gubba starts from a settled garden. */
  function settleForGubba(): void {
    if (raking) finishStroke();
    finishPlayerSweep();
    playerRakeOut = false;
    placingKind = null;
    touchPlacingPointerId = null;
    movingElement = null;
  }

  function setGubbaMode(on: boolean): void {
    if (on === runner.mode) return;
    if (on) {
      settleForGubba();
      // out of the way, so there is something to watch
      panel = "none";
    }
    runner.setMode(on, settings.rake, reducedMotion);
  }

  /** Has Gubba build a preset: the next garden in Gubba mode, or one "Watch" run. False if there is nothing to do. */
  function requestGubbaPreset(presetId: PresetId): boolean {
    settleForGubba();
    return runner.request(presetId, reducedMotion);
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

  /**
   * Lets go of everything a pointer was in the middle of: pointer captures are released, a stroke under way is
   * finished and kept, foley stops, and every gesture in progress is forgotten. Called when the garden stops
   * receiving input without being told the fingers lifted: the turn-sideways prompt covers it, the page is hidden
   * or unloaded, or the window loses focus. On iOS, swiping up to the home screen or pulling Control Center down
   * often delivers no pointerup or pointercancel at all; a finger left in `activeTouches` would make the next
   * one-finger touch the second finger of a pinch.
   */
  function clearActiveInteractions(): void {
    releaseAllCaptures();
    if (raking) finishStroke();
    audio.updateFoley(null);
    foleyStationarySilenced = true;
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

  /** Shows the turn-sideways prompt on an upright phone and hands the garden back once it is turned. */
  function updateRotatePrompt(): void {
    const blocked = rotatePrompt !== null && needsLandscape(window.innerWidth, window.innerHeight);
    if (blocked === rotateBlocked) return;
    // nothing fires or leaks foley under the prompt
    if (blocked) clearActiveInteractions();
    applyRotateDom(blocked);
  }

  // What the renderer was last sized for. Mobile browsers send resize events that change nothing (the address
  // bar sliding, a visual-viewport update); those must not end a stroke or snap the camera.
  let sizedW = 0;
  let sizedH = 0;
  let sizedDpr = 0;
  let sizedDensity: PixelDensity | null = null;

  // The canvas fills the stage, but never more than the window and the visual viewport show: a stage still at
  // an upright phone's height after the screen has turned must not size a canvas taller than the screen
  // (`boundedViewportSide`). Both are read every frame by `viewportDrifted`, so they allocate nothing.
  function liveDeviceW(dpr: number): number {
    const vv = window.visualViewport;
    const cssW = boundedViewportSide(
      stage ? stage.clientWidth : 0,
      window.innerWidth,
      vv && vv.scale <= VISUAL_VIEWPORT_MAX_SCALE ? vv.width : 0,
    );
    return Math.max(1, Math.round(cssW * dpr));
  }

  function liveDeviceH(dpr: number): number {
    const vv = window.visualViewport;
    const cssH = boundedViewportSide(
      stage ? stage.clientHeight : 0,
      window.innerHeight,
      vv && vv.scale <= VISUAL_VIEWPORT_MAX_SCALE ? vv.height : 0,
    );
    return Math.max(1, Math.round(cssH * dpr));
  }

  function updateViewportSize(): void {
    const dpr = window.devicePixelRatio || 1;
    const deviceW = liveDeviceW(dpr);
    const deviceH = liveDeviceH(dpr);
    if (deviceW === sizedW && deviceH === sizedH && dpr === sizedDpr && settings.density === sizedDensity) {
      updateRotatePrompt();
      return;
    }
    sizedW = deviceW;
    sizedH = deviceH;
    sizedDpr = dpr;
    sizedDensity = settings.density;
    if (raking) finishStroke();
    renderer.resize(deviceW, deviceH, settings.density, dpr);
    applyFramingForCurrentViewport(true);
    updateRotatePrompt();
  }

  /** True when the page is scrolled, or the visual viewport has slid inside it without the page being zoomed. */
  function pageScrolled(): boolean {
    if (window.scrollX !== 0 || window.scrollY !== 0) return true;
    const vv = window.visualViewport;
    return vv != null && vv.scale <= VISUAL_VIEWPORT_MAX_SCALE && (vv.offsetLeft !== 0 || vv.offsetTop !== 0);
  }

  /** True when the renderer or the turn-sideways prompt no longer matches the window. Zero-allocation. */
  function viewportDrifted(): boolean {
    const dpr = window.devicePixelRatio || 1;
    return (
      dpr !== sizedDpr ||
      liveDeviceW(dpr) !== sizedW ||
      liveDeviceH(dpr) !== sizedH ||
      (rotatePrompt !== null && needsLandscape(window.innerWidth, window.innerHeight)) !== rotateBlocked
    );
  }

  /** Puts the page back at its origin and fits the canvas to the window as it is now. */
  function resyncViewport(): void {
    if (pageScrolled()) window.scrollTo(0, 0);
    updateViewportSize();
  }

  // After the app returns to the foreground or the screen turns, iOS goes on settling its layout (the rotation
  // animation, late `env(safe-area-inset-*)` values) and often sends no final resize. So a resume is followed by
  // three more looks: the next frame, then about 150 ms and 400 ms later. A new resume restarts the two delays.
  let settleFrame = 0;
  let settleSoon: ReturnType<typeof setTimeout> | null = null;
  let settleLate: ReturnType<typeof setTimeout> | null = null;
  const onSettleFrame = (): void => {
    settleFrame = 0;
    resyncViewport();
  };
  const onSettleSoon = (): void => {
    settleSoon = null;
    resyncViewport();
  };
  const onSettleLate = (): void => {
    settleLate = null;
    resyncViewport();
  };

  /** The garden is in front again, or the screen turned: fit it now and again once the layout has settled. */
  function resumeViewport(): void {
    resyncViewport();
    if (settleFrame === 0) settleFrame = requestAnimationFrame(onSettleFrame);
    if (settleSoon !== null) clearTimeout(settleSoon);
    settleSoon = setTimeout(onSettleSoon, RESUME_SETTLE_SOON_MS);
    if (settleLate !== null) clearTimeout(settleLate);
    settleLate = setTimeout(onSettleLate, RESUME_SETTLE_LATE_MS);
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

    syncMirror();
    scheduleSave();
  }

  function startSweep(source: HapticSource = "other"): void {
    if (sweepActive) return;
    yieldToPlayer();
    if (raking) strokeSawSweep = true;
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
    haptics.trigger("sweep", source);
    audio.playSweepWhoosh(SWEEP_DURATION_MS / 1000);
    stepGubbaInPlace(gubba, { type: "sweep" }, clockMs);
  }

  function triggerPreset(presetId: PresetId): void {
    if (raking) finishStroke();
    panel = "none";
    if (runner.mode || watchGubbaRake) {
      // Gubba gets up and builds it. In Gubba mode he then carries on to gardens of his own choosing.
      requestGubbaPreset(presetId);
      return;
    }
    // An instant preset is the player's own edit
    yieldToPlayer();
    const before = sweepActive ? sweepActive.before : store.snapshot();
    sweepActive = null;
    deferredSweepBefore = null;
    strokeStartedDuringSweep = false;
    store.garden.elements = applyPreset(store.garden.sand, presetId);
    store.commitSnapshot(before);
    sandReset = true;
    scheduleSave();
  }

  function selectRakeTool(id: RakeId, source: HapticSource = "other"): void {
    if (id === "hoki") {
      startSweep(source);
      return;
    }
    placingKind = null;
    touchPlacingPointerId = null;
    movingElement = null;
    touchPreviewTag = null;
    if (settings.rake !== id) {
      syncSettings(setRake(settings, id));
    }
    // after the selection, so a rake Gubba is holding comes straight to the player's hand
    yieldToPlayer();
    haptics.trigger("select", source);
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

  function handleOverlayAction(action: OverlayAction, source: HapticSource = "other"): void {
    if (action.type !== "none") haptics.trigger("tap", source);
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
        syncMirror();
        return;
      case "gubba_mode":
        setGubbaMode(action.on);
        return;
      case "export":
        void triggerExport();
        return;
      case "place":
        yieldToPlayer();
        placingKind = action.kind;
        placingByTouch = lastPointerTouch;
        if (placingByTouch) mirror.say(PLACE_HINTS[action.kind]);
        movingElement = null;
        panel = "none";
        return;
      case "hud":
        switch (action.id) {
          case "undo":
            undoGarden();
            return;
          case "redo":
            redoGarden();
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

  /** Undo and redo are edits: Gubba gives way first, so one undo takes back everything he did. */
  function undoGarden(): boolean {
    if (raking) return false;
    yieldToPlayer();
    if (!store.undo()) return false;
    sandReset = true;
    scheduleSave();
    return true;
  }

  function redoGarden(): boolean {
    if (raking) return false;
    yieldToPlayer();
    if (!store.redo()) return false;
    sandReset = true;
    scheduleSave();
    return true;
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
        yieldToPlayer();
        placingKind = cmd.kind;
        placingByTouch = false;
        movingElement = null;
        panel = "none";
        // Move focus off the hidden DOM mirror button so Arrow/Enter keys control stone placement cleanly
        renderer.pipeline.canvas.focus({ preventScroll: true });
        return;
      case "toggle_watch":
        watchGubbaRake = !watchGubbaRake;
        syncMirror();
        return;
      case "toggle_gubba_mode":
        setGubbaMode(!runner.mode);
        return;
      case "adjust_mix":
        syncSettings(adjustMix(settings, cmd.channel, cmd.delta));
        return;
      case "undo":
        undoGarden();
        return;
      case "redo":
        redoGarden();
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
          yieldToPlayer();
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
          yieldToPlayer();
          virtualDown = true;
          raking = true;
          strokeEngineBegun = true;
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
        playerRakeOut = true;
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
  syncMirror();
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

  /** True within `margin` cells of the bed, which covers its wooden frame. */
  function isNearBed(p: Vec2 | null, margin: number): p is Vec2 {
    return p !== null && p.x >= -margin && p.x < 192 + margin && p.y >= -margin && p.y < 112 + margin;
  }

  function finishStroke(): void {
    if (!raking) return;
    raking = false;
    virtualDown = false;
    activePointerId = null;
    const hadSweepOverlap = strokeStartedDuringSweep;
    strokeStartedDuringSweep = false;
    if (!strokeEngineBegun) {
      audio.updateFoley(null);
      foleyStationarySilenced = true;
      return;
    }
    strokeEngineBegun = false;
    const patch = strokeEngine.end();

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

  /**
   * Ends the stroke that a second finger interrupts. Two fingers never land together: the first arrives a few
   * frames early and, on the sand, begins a stroke. If that stroke is only moments old or has barely moved it
   * was the start of a pinch, so its marks are rolled back and nothing reaches the undo history. A stroke that
   * was clearly under way is kept and committed as usual.
   */
  function endStrokeForSecondFinger(nowTs: number): void {
    if (!strokeEngineBegun) {
      raking = false;
      activePointerId = null;
      strokeStartedDuringSweep = false;
      audio.updateFoley(null);
      foleyStationarySilenced = true;
      return;
    }
    const pinchStart =
      activePointerType === "touch" &&
      !virtualDown &&
      !strokeSawSweep &&
      deferredSweepBefore === null &&
      (nowTs - strokeDownTs < PINCH_GRACE_MS || strokeTravelPx < PINCH_TRAVEL_PX);
    if (!pinchStart) {
      finishStroke();
      return;
    }
    raking = false;
    strokeEngineBegun = false;
    activePointerId = null;
    strokeStartedDuringSweep = false;
    const patch = strokeEngine.end();
    const { x, y, w, h } = patch.rect;
    if (w > 0 && h > 0) {
      const sand = store.garden.sand;
      for (let row = 0; row < h; row++) {
        const target = (y + row) * sand.w + x;
        sand.height.set(patch.beforeHeight.subarray(row * w, (row + 1) * w), target);
        sand.dir.set(patch.beforeDir.subarray(row * w, (row + 1) * w), target);
      }
      markDirty(patch.rect);
    }
    audio.updateFoley(null);
    foleyStationarySilenced = true;
  }

  /** Shows the held rake where the stroke engine has it. */
  function showStroke(tel: StrokeTelemetry): void {
    if (activePointerType === "touch" && !virtualDown) {
      // A finger can slide far past the bed (the wall and sky map to sand points hundreds of cells away); the
      // stroke keeps those points, but the rake itself waits at the rim.
      const m = TOUCH_RAKE_VISUAL_MARGIN_CELLS;
      rakeHeadBuf.x = Math.max(-m, Math.min(192 + m, tel.head.x));
      rakeHeadBuf.y = Math.max(-m, Math.min(112 + m, tel.head.y));
    } else {
      rakeHeadBuf.x = tel.head.x;
      rakeHeadBuf.y = tel.head.y;
    }
    rakeHeading = tel.heading;
    // Keep the hover handle where the stroke left it, so the next hover continues from this heading
    hoverTailBuf.x = tel.tail.x;
    hoverTailBuf.y = tel.tail.y;
  }

  /** CSS pixels on the canvas as framebuffer pixels, capped so a touch search stays small at any density. */
  function touchRadiusFb(cssPx: number): number {
    const r = canvasEl.getBoundingClientRect();
    return Math.min(TOUCH_SEARCH_MAX_FB, (cssPx * renderer.fbW) / Math.max(1, r.width));
  }

  /** The HUD or menu control nearest a touch that landed just outside every control, or null. */
  function touchOverlayHit(fbX: number, fbY: number, hudOnly = false): OverlayAction | null {
    const radius = touchRadiusFb(TOUCH_OVERLAY_SLOP_PX);
    const r2 = radius * radius;
    for (let i = 2; i < TOUCH_SEARCH_OFFSETS.length; i += 2) {
      const dx = TOUCH_SEARCH_OFFSETS[i]!;
      const dy = TOUCH_SEARCH_OFFSETS[i + 1]!;
      if (dx * dx + dy * dy > r2) break;
      const action = renderer.overlayHit(fbX + dx, fbY + dy);
      if (action !== null && action.type !== "none" && (!hudOnly || action.type === "hud")) return action;
    }
    return null;
  }

  /**
   * The pickable object nearest a touch that landed on none: a hanging rake's handle is one or two framebuffer
   * pixels wide, far thinner than a thumb. Each probe reads one G-buffer pixel, so only every other row is
   * sampled; every column is, which still finds an upright handle a single pixel wide.
   */
  function touchPick(fbX: number, fbY: number): PickResult {
    const radius = touchRadiusFb(TOUCH_PICK_RADIUS_PX);
    const r2 = radius * radius;
    for (let i = 2; i < TOUCH_SEARCH_OFFSETS.length; i += 2) {
      const dx = TOUCH_SEARCH_OFFSETS[i]!;
      const dy = TOUCH_SEARCH_OFFSETS[i + 1]!;
      if (dx * dx + dy * dy > r2) break;
      if (dy & 1) continue;
      // Stones are wide enough to press directly, and a near miss beside one is usually a stroke around it
      const picked = renderer.pick(fbX + dx, fbY + dy);
      if (picked.kind !== "none" && picked.kind !== "element") return picked;
    }
    return NOTHING_PICKED;
  }

  /** Forgets every touch gesture in progress; a stroke under way is kept. */
  function resetTouchGestures(): void {
    if (raking && !virtualDown && activePointerType === "touch") finishStroke();
    if (touchRakeHold && hoverRake === touchRakeHold.id) hoverRake = null;
    if (hokiTouchHold && hoverRake === "hoki") hoverRake = null;
    if (hokiTouchHold) hokiHoldStartMs = null;
    activeTouches.clear();
    orbitDrag = null;
    pinchDist = null;
    touchRakeHold = null;
    hokiTouchHold = null;
    movingElement = null;
    touchPlacingPointerId = null;
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
    const touch = ev.pointerType === "touch";
    const source = hapticSource(ev.pointerType);
    lastPointerTouch = touch;
    if (touch) {
      // A primary touch is by definition the only finger down. Anything still tracked is a lift that never
      // reached the page, and would otherwise turn every later touch into the second finger of a pinch.
      if (ev.isPrimary && activeTouches.size > 0) resetTouchGestures();
      // Touch browsers apply implicit pointer capture on pointerdown; track every finger so rotate can release it.
      capturedPointers.add(ev.pointerId);
      activeTouches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      // A third finger never starts a gesture of its own under a pinch
      if (activeTouches.size > 2) return;
      if (activeTouches.size === 2) {
        if (raking) endStrokeForSecondFinger(ev.timeStamp);
        if (touchRakeHold && hoverRake === touchRakeHold.id) hoverRake = null;
        if (hokiTouchHold && hoverRake === "hoki") hoverRake = null;
        touchRakeHold = null;
        touchPreviewTag = null;
        hokiHoldStartMs = null;
        hokiTouchHold = null;
        movingElement = null;
        touchPlacingPointerId = null;
        let cx = 0;
        let cy = 0;
        let first: { x: number; y: number } | null = null;
        for (const pt of activeTouches.values()) {
          cx += pt.x * 0.5;
          cy += pt.y * 0.5;
          if (first === null) first = pt;
          else pinchDist = Math.hypot(pt.x - first.x, pt.y - first.y);
        }
        orbitDrag = { pointerId: ev.pointerId, lastX: cx, lastY: cy, engaged: true, twoFinger: true };
        return;
      }
    }

    const fb = renderer.clientToFramebuffer(ev.clientX, ev.clientY);
    pointerFbBuf.x = fb.x;
    pointerFbBuf.y = fb.y;
    hasPointerFb = true;

    // 1. Check pixel overlay (HUD / Settings / Basket tray) first; a thumb just off a control still presses it.
    //    Inside an open panel, empty paper returns { type: "none" } so snap to a nearby chip/tab/pip; outside
    //    an open panel, only allow HUD slop so tapping outside to dismiss never snags an edge panel chip.
    let ovAction = renderer.overlayHit(fb.x, fb.y);
    if (touch) {
      if (ovAction !== null && ovAction.type === "none") {
        const snapped = touchOverlayHit(fb.x, fb.y);
        if (snapped !== null) ovAction = snapped;
      } else if (ovAction === null) {
        const snapped = touchOverlayHit(fb.x, fb.y, panel !== "none");
        if (snapped !== null) ovAction = snapped;
      }
    }
    if (ovAction !== null) {
      touchPreviewTag = null;
      handleOverlayAction(ovAction, source);
      return;
    }

    const wasBasket = panel === "basket";
    if (panel !== "none") {
      panel = "none";
    }

    const sp = renderer.sandPoint(fb.x, fb.y);

    // 2. Active stone placement mode (touch supports drag-to-aim and release-to-drop; mouse drops on click)
    if (placingKind !== null) {
      if (touch) {
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
        yieldToPlayer();
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
          audio.playStoneThud();
          stepGubbaInPlace(gubba, { type: "stone_placed" }, clockMs);
          scheduleSave();
        }
      }
      placingKind = null;
      return;
    }

    // 3. Pick 3D object via G-buffer part-id. A touch that lands on nothing, off the sand, takes the nearest
    //    object within a thumb's reach instead of orbiting; on the sand a touch always rakes.
    let picked = renderer.pick(fb.x, fb.y);
    if (touch && picked.kind === "none" && !isInsideBed(sp)) picked = touchPick(fb.x, fb.y);
    if (picked.kind === "rake" && picked.id) {
      const rid = picked.id as RakeId;
      if (rid === "hoki") {
        // DESIGN.md 3.7: Hōki requires a 0.8 s hold to sweep; show its description immediately on touch
        hokiHoldStartMs = clockMs;
        if (touch) {
          hokiTouchHold = { pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY };
          hoverRake = "hoki";
          touchPreviewTag = { id: "hoki", untilMs: clockMs + TOUCH_PREVIEW_LINGER_MS };
          mirror.say(HOVER_TAGS.hoki);
        }
        capturePointer(ev.pointerId);
      } else if (touch) {
        // Touch: the rake lifts under the thumb at once; a quick tap selects it, and holding >= 350 ms previews
        // its description without switching
        touchPreviewTag = null;
        hoverRake = rid;
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
      haptics.trigger("tap", source);
      stepGubbaInPlace(gubba, { type: "gubba_tapped", activeRake: settings.rake }, clockMs);
      const updated = withHeardStories(settings, gubba.heardStories);
      if (updated !== settings) syncSettings(updated);
      return;
    }
    if (picked.kind === "basket") {
      haptics.trigger("tap", source);
      panel = wasBasket ? "none" : "basket";
      return;
    }
    // 4. Drag an existing placed element to move it (or drop on the basket / off-bed to remove it)
    if (picked.kind === "element" && picked.id) {
      const existing = store.garden.elements.find((e) => e.id === picked.id);
      if (existing) {
        // taking hold of a stone is the player's edit, even before it moves
        yieldToPlayer();
        movingElement = {
          id: existing.id,
          kind: existing.kind,
          pointerId: ev.pointerId,
          x: existing.x,
          y: existing.y,
          offX: sp ? existing.x - sp.x : 0,
          offY: sp ? existing.y - sp.y : 0,
          startX: ev.clientX,
          startY: ev.clientY,
          dragging: false,
        };
        capturePointer(ev.pointerId);
        return;
      }
    }

    // 5. Pressing on the sand bed starts a rake stroke. A thumb aiming at the edge of the bed often lands on
    //    its frame, so a touch there starts the stroke too; points outside the grid are kept and clipped.
    //    For touch, defer yielding Gubba and starting the stroke engine until the finger clears TOUCH_SLOP_PX,
    //    so accidental taps and two-finger pinches over the sand never interrupt Gubba mode or Watch playback.
    if (isInsideBed(sp) || (touch && isNearBed(sp, TOUCH_BED_MARGIN_CELLS))) {
      if (virtualDown) finishStroke();
      activePointerId = ev.pointerId;
      activePointerType = touch ? "touch" : ev.pointerType === "pen" ? "pen" : "mouse";
      raking = true;
      strokeStartedDuringSweep = sweepActive !== null;
      strokeSawSweep = sweepActive !== null;
      strokeCarving = false;
      strokeDownTs = ev.timeStamp;
      strokeTravelPx = 0;
      strokeLastClientX = ev.clientX;
      strokeLastClientY = ev.clientY;
      strokePressSand.x = sp.x;
      strokePressSand.y = sp.y;
      resetTouchBrush(touchBrush, ev.clientX, ev.clientY);
      capturePointer(ev.pointerId);
      if (touch) {
        strokeEngineBegun = false;
        if (!runner.mode && runner.before === null) {
          rakeHeadBuf.x = sp.x;
          rakeHeadBuf.y = sp.y;
          hasRakeHead = true;
        }
        return;
      }
      yieldToPlayer();
      strokeEngineBegun = true;
      const rakeSpec = RAKE_BY_ID[settings.rake];
      hasRakeHead = true;
      strokeEngine.begin(sp, rakeSpec, activePointerType, {
        stones: store.garden.elements,
        flow: settings.flow,
        heading: rakeHeading,
      });
      strokePts.length = 0;
      strokePts.push(sp);
      const tel = strokeEngine.extend(strokePts, 16.67);
      strokeCarving = tel.active;
      showStroke(tel);
      markDirty(tel.dirtyRect);
      if (tel.hitStone) audio.playStoneThud();
      lastFoleyMoveMs = clockMs;
      lastFoleyScreenX = fb.x / Math.max(1, renderer.fbW);
      foleyStationarySilenced = false;
      audio.updateFoley(tel, lastFoleyScreenX);
      return;
    }

    // 6. Dragging anywhere else (deck, wall, sky) orbits the camera; a touch has to leave the tap slop first
    orbitDrag = { pointerId: ev.pointerId, lastX: ev.clientX, lastY: ev.clientY, engaged: !touch };
    capturePointer(ev.pointerId);
  });

  canvas.addEventListener("pointermove", (ev) => {
    if (rotateBlocked) return;
    const tracked = ev.pointerType === "touch" ? activeTouches.get(ev.pointerId) : undefined;
    if (tracked) {
      tracked.x = ev.clientX;
      tracked.y = ev.clientY;
      if (activeTouches.size === 2 && orbitDrag?.twoFinger) {
        let cx = 0;
        let cy = 0;
        let d = 0;
        let first: { x: number; y: number } | null = null;
        for (const pt of activeTouches.values()) {
          cx += pt.x * 0.5;
          cy += pt.y * 0.5;
          if (first === null) first = pt;
          else d = Math.hypot(pt.x - first.x, pt.y - first.y);
        }
        const nextDist = pinchDist ? orbitRig.dist * (pinchDist / Math.max(10, d)) : orbitRig.dist;
        pinchDist = d;
        orbitTo({
          ...orbitRig,
          az: orbitRig.az - (cx - orbitDrag.lastX) * 0.005,
          el: orbitRig.el + (cy - orbitDrag.lastY) * 0.005,
          dist: nextDist,
        });
        orbitDrag.lastX = cx;
        orbitDrag.lastY = cy;
        return;
      }
      // Under a pinch or with extra fingers down, a finger that owns no gesture does nothing
      if (activeTouches.size > 1 && ev.pointerId !== activePointerId) return;
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
      if (!movingElement.dragging) {
        const slop = ev.pointerType === "touch" ? TOUCH_SLOP_PX : MOUSE_DRAG_SLOP_PX;
        if (Math.hypot(ev.clientX - movingElement.startX, ev.clientY - movingElement.startY) < slop) return;
        movingElement.dragging = true;
        haptics.trigger("tap", hapticSource(ev.pointerType));
      }
      const sp = renderer.sandPoint(fb.x, fb.y);
      if (sp) {
        movingElement.x = Math.max(0, Math.min(191, Math.round(sp.x + movingElement.offX)));
        movingElement.y = Math.max(0, Math.min(111, Math.round(sp.y + movingElement.offY)));
      }
      return;
    }

    // Active rake stroke: raking NEVER moves the camera
    if (raking && !virtualDown && (activePointerId === null || ev.pointerId === activePointerId)) {
      const coalesced = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
      const events = coalesced.length > 0 ? coalesced : [ev];
      const touchStroke = activePointerType === "touch";
      strokePts.length = 0;
      for (const ce of events) {
        let cx = ce.clientX;
        let cy = ce.clientY;
        if (touchStroke) {
          // A finger is steadied before it reaches the sand: nothing inside the tap slop, then a short string
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
          strokeTravelPx += Math.hypot(cx - strokeLastClientX, cy - strokeLastClientY);
          strokeLastClientX = cx;
          strokeLastClientY = cy;
          if (!pullTouchBrush(touchBrush, cx, cy, TOUCH_SLOP_PX, TOUCH_BRUSH_RADIUS_PX)) continue;
          cx = touchBrush.x;
          cy = touchBrush.y;
        }
        const cfb = renderer.clientToFramebuffer(cx, cy);
        const sp = renderer.sandPoint(cfb.x, cfb.y);
        if (!sp) continue;
        if (touchStroke) {
          // A finger sliding up the wall toward the sky maps to sand points thousands of cells away, and each
          // cell of that path is a stamp. Nothing beyond the reach can touch the bed, so stop there.
          sp.x = Math.max(-TOUCH_STROKE_REACH_CELLS, Math.min(192 + TOUCH_STROKE_REACH_CELLS, sp.x));
          sp.y = Math.max(-TOUCH_STROKE_REACH_CELLS, Math.min(112 + TOUCH_STROKE_REACH_CELLS, sp.y));
        }
        strokePts.push(sp);
      }
      if (touchStroke && !strokeCarving && strokePts.length === 0) {
        // Before a touch stroke starts to carve, turn the waiting rake the way the finger is heading, so it does
        // not whip round on the first carved cell
        const sp = renderer.sandPoint(fb.x, fb.y);
        const moved = Math.hypot(ev.clientX - touchBrush.pressX, ev.clientY - touchBrush.pressY);
        if (sp && moved >= TOUCH_BRUSH_RADIUS_PX) {
          rakeHeading = Math.atan2(sp.y - strokePressSand.y, sp.x - strokePressSand.x);
        }
      }
      if (strokePts.length > 0) {
        if (!strokeEngineBegun) {
          yieldToPlayer();
          strokeEngineBegun = true;
          strokeStartedDuringSweep = sweepActive !== null;
          strokeSawSweep = sweepActive !== null;
          hasRakeHead = true;
          strokeEngine.begin(strokePressSand, RAKE_BY_ID[settings.rake], activePointerType, {
            stones: store.garden.elements,
            flow: settings.flow,
            heading: rakeHeading,
          });
        }
        const wasCarving = strokeCarving;
        const tel = strokeEngine.extend(strokePts, 16.67);
        strokeCarving = tel.active;
        showStroke(tel);
        markDirty(tel.dirtyRect);
        // The finger has left the tap slop and the rake bites: once per stroke, and only for a finger
        if (touchStroke && !wasCarving && strokeCarving) haptics.trigger("strokeStart", "touch");
        if (tel.hitStone) {
          audio.playStoneThud();
          if (touchStroke) haptics.trigger("stoneBrush", "touch");
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
      if (!orbitDrag.engaged) {
        // A tap on the deck or wall leaves the camera alone; the orbit picks up from where the slop ends
        if (Math.hypot(ev.clientX - orbitDrag.lastX, ev.clientY - orbitDrag.lastY) < TOUCH_SLOP_PX) return;
        orbitDrag.engaged = true;
      } else {
        orbitTo({
          ...orbitRig,
          az: orbitRig.az - (ev.clientX - orbitDrag.lastX) * 0.006,
          el: orbitRig.el + (ev.clientY - orbitDrag.lastY) * 0.006,
        });
      }
      orbitDrag.lastX = ev.clientX;
      orbitDrag.lastY = ev.clientY;
      return;
    }

    // A finger has no hover: everything below is for a mouse or pen moving with no button held
    if (ev.pointerType === "touch") return;

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
        playerRakeOut = true;
        canvas.style.cursor = "none";
      } else {
        playerRakeOut = false;
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
      playerRakeOut = false;
      canvas.style.cursor = "pointer";
    }
  });
  canvas.addEventListener("pointerleave", (ev) => {
    if (ev.pointerType !== "touch") playerRakeOut = false;
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
      if (hoverRake === hold.id) hoverRake = null;
      if (!heldLong) {
        selectRakeTool(hold.id, "touch");
      } else {
        if (!hold.previewed) {
          mirror.say(HOVER_TAGS[hold.id]);
          haptics.trigger("preview", "touch");
        }
        touchPreviewTag = { id: hold.id, untilMs: clockMs + TOUCH_PREVIEW_LINGER_MS };
      }
      return;
    }

    if (touchPlacingPointerId === ev.pointerId && placingKind !== null) {
      const fb = renderer.clientToFramebuffer(ev.clientX, ev.clientY);
      const sp = renderer.sandPoint(fb.x, fb.y);
      if (isInsideBed(sp)) {
        yieldToPlayer();
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
          haptics.trigger("thud", "touch");
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
      const moving = movingElement;
      movingElement = null;
      // A press that never left the tap slop was not a drag: the stone stays exactly where it is
      if (!moving.dragging) return;
      yieldToPlayer();
      const fb = renderer.clientToFramebuffer(ev.clientX, ev.clientY);
      let picked = renderer.pick(fb.x, fb.y);
      if (ev.pointerType === "touch" && picked.kind !== "basket") {
        const near = touchPick(fb.x, fb.y);
        if (near.kind === "basket") picked = near;
      }
      const sp = renderer.sandPoint(fb.x, fb.y);
      // The stone lands where it was carried to, which is the release point less the original grab offset
      const tx = sp ? Math.round(sp.x + moving.offX) : -1;
      const ty = sp ? Math.round(sp.y + moving.offY) : -1;
      if (picked.kind === "basket" || tx < 0 || tx >= 192 || ty < 0 || ty >= 112) {
        if (store.removeElement(moving.id)) {
          sandReset = true;
          haptics.trigger("thud", hapticSource(ev.pointerType));
          audio.playStoneThud();
          scheduleSave();
        }
      } else {
        if (store.moveElement(moving.id, tx, ty)) {
          sandReset = true;
          haptics.trigger("thud", hapticSource(ev.pointerType));
          audio.playStoneThud();
          scheduleSave();
        }
      }
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

  /** True while pointer `id` is in the middle of something: a tracked finger, a stroke, an orbit, a hold, a stone. */
  function pointerHasGesture(id: number): boolean {
    return (
      activeTouches.has(id) ||
      (raking && !virtualDown && activePointerId === id) ||
      orbitDrag?.pointerId === id ||
      movingElement?.pointerId === id ||
      touchRakeHold?.pointerId === id ||
      hokiTouchHold?.pointerId === id ||
      touchPlacingPointerId === id
    );
  }
  // A pointer's capture ends after its pointerup or pointercancel, which have already tidied up, so this then
  // finds nothing to do. iOS can also take a gesture for itself (the home indicator, an edge swipe) and end the
  // capture with neither event; that finger is cancelled here instead of being left down for good.
  canvas.addEventListener("lostpointercapture", (ev) => {
    if (pointerHasGesture(ev.pointerId)) onPointerCancel(ev);
  });

  // iOS drops the GPU context of an app left in the background. Asking to keep the canvas lets the browser hand
  // one back; the renderer then rebuilds its targets and the whole sand surface is uploaded again.
  canvas.addEventListener("webglcontextlost", (ev) => {
    ev.preventDefault();
  });
  canvas.addEventListener("webglcontextrestored", () => {
    sizedW = 0;
    sandReset = true;
    updateViewportSize();
  });

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
    auto: autoFrame,
  };

  const overlayState: OverlayState = {
    settings,
    breathAmplitude: 0,
    speech: null,
    panel: "none",
    tab: "look",
    watchGubbaRake: false,
    gubbaMode: false,
    elementCount: store.garden.elements.length,
    maxElements: MAX_ELEMENTS,
    pointer: null,
  };

  const placingBuf = { kind: "stone_m" as ElementKind, x: 96, y: 56, rotation: 0 };

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
        syncMirror();
      }
    }

    // Hold `0` or Hōki for 0.8 s to trigger smooth-all sweep
    if (hokiHoldStartMs !== null && clockMs - hokiHoldStartMs >= HOKI_HOLD_MS) {
      // The hold matures here, outside any pointer handler: a thumb still on the broom is a "hold" source
      const source: HapticSource = hokiTouchHold !== null ? "hold" : "other";
      hokiHoldStartMs = null;
      hokiTouchHold = null;
      if (hoverRake === "hoki") hoverRake = null;
      touchPreviewTag = null;
      startSweep(source);
    }

    // Hold a hanging rake on touch for 350 ms to lift it and preview its description without switching
    if (touchRakeHold !== null && !touchRakeHold.previewed && clockMs - touchRakeHold.startMs >= TOUCH_RAKE_HOLD_MS) {
      touchRakeHold.previewed = true;
      hoverRake = touchRakeHold.id;
      touchPreviewTag = { id: touchRakeHold.id, untilMs: clockMs + TOUCH_PREVIEW_LINGER_MS };
      mirror.say(HOVER_TAGS[touchRakeHold.id]);
      haptics.trigger("preview", "hold");
    }
    if (touchPreviewTag !== null && touchRakeHold === null && hokiHoldStartMs === null && clockMs >= touchPreviewTag.untilMs) {
      touchPreviewTag = null;
    }

    // Decay stationary rake foley smoothly to silence when hand rests
    if (raking && !foleyStationarySilenced && clockMs - lastFoleyMoveMs > STATIONARY_FOLEY_TIMEOUT_MS) {
      foleyStationarySilenced = true;
      audio.updateFoley(zeroSpeedTelemetry, lastFoleyScreenX);
    }

    // Active Hōki sweep progression (frozen behind the portrait rotate prompt)
    let sweepProgress: number | null = null;
    if (sweepActive) {
      if (rotateBlocked) {
        sweepActive.startedAtMs += dtMs;
        const t = Math.max(0, Math.min(1, sweepActive.prevElapsedMs / SWEEP_DURATION_MS));
        sweepProgress = t * t * (3 - 2 * t);
      } else {
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
    }

    // Gubba at work (Gubba mode, "Watch: Gubba rakes"): pause cleanly while the portrait rotate prompt covers the garden
    if (!rotateBlocked) {
      runner.tick(dtMs, settings.gubbaVariant, reducedMotion);
    }
    const auto = runner.state;
    if (sweepProgress === null && auto.sweepProgress >= 0) sweepProgress = auto.sweepProgress;

    // Breath clock (zero-allocation)
    breathInto(breathBuf, settings.breathPattern, clockMs);
    audio.setBreathAmplitude(breathBuf.amplitude);

    // Gubba tick & pose (zero-allocation in-place)
    gubbaTickEvent.pointerOnWall = hoverRake !== null;
    gubbaTickEvent.raking = raking && strokeEngineBegun;
    gubbaTickEvent.working = auto.working;
    gubbaTickEvent.rakeGridPos = hasRakeHead ? rakeHeadBuf : null;
    gubbaTickEvent.rain = settings.rain;
    gubbaTickEvent.breathPhase = breathBuf.phase;
    stepGubbaInPlace(gubba, gubbaTickEvent, clockMs);

    gubbaHeadYaw = dampYaw(gubbaHeadYaw, gubba.targetYaw, dtMs);
    gubbaPoseOpts.headYaw = gubbaHeadYaw;
    poseGubba(gubba, breathBuf.amplitude, clockMs, gubbaPoseOpts);
    applyAutoGait(gubbaPoseBuf, auto);
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
      placingKind !== null && placingByTouch
        ? PLACE_HINTS[placingKind]
        : touchPreviewTag !== null
          ? HOVER_TAGS[touchPreviewTag.id]
          : (gubba.speech?.text ?? null);
    // A rake lifted by a thumb that is still deciding between tap and hold keeps its name tag for the hold
    if (speechText === null && hoverRake !== null && touchRakeHold === null) {
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
    // While Gubba is at work the player's rake hangs on the wall until they reach for the sand, so he never
    // walks through it. "hoki" here means an empty hand: the broom is an action and never leaves the rack.
    frame.heldRake =
      (runner.mode || runner.before !== null) && !playerRakeOut && !(raking && strokeEngineBegun)
        ? "hoki"
        : settings.rake;
    frame.hoverRake = hoverRake;
    frame.rakeHead = hasRakeHead ? rakeHeadBuf : null;
    frame.rakeHeading = rakeHeading;
    frame.raking = raking && strokeEngineBegun;
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
    autoFrame.rake = auto.rake;
    autoFrame.tip.x = auto.tipX;
    autoFrame.tip.y = auto.tipY;
    autoFrame.tip.z = auto.tipZ;
    autoFrame.grip.x = auto.gripX;
    autoFrame.grip.y = auto.gripY;
    autoFrame.grip.z = auto.gripZ;
    autoFrame.carried = auto.carried;
    autoFrame.carriedPos.x = auto.carryX;
    autoFrame.carriedPos.y = auto.carryY;
    autoFrame.carriedPos.z = auto.carryZ;
    autoFrame.carriedYaw = auto.carryYaw;

    overlayState.settings = settings;
    overlayState.breathAmplitude = breathBuf.amplitude;
    overlayState.speech = speechText;
    overlayState.panel = panel;
    overlayState.tab = tab;
    overlayState.watchGubbaRake = watchGubbaRake;
    overlayState.gubbaMode = runner.mode;
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
  // iOS browsers resize the visual viewport when the address bar hides or shows, often without a window resize
  window.visualViewport?.addEventListener("resize", updateViewportSize);
  window.visualViewport?.addEventListener("scroll", resyncViewport);
  // The stage is what the canvas fills, so its own box changing is the most direct signal there is
  if (stage && typeof ResizeObserver === "function") new ResizeObserver(updateViewportSize).observe(stage);
  // Turning the screen and coming back to the foreground (see also `visibilitychange` above)
  window.addEventListener("orientationchange", resumeViewport);
  window.addEventListener("pageshow", resumeViewport);
  window.addEventListener("focus", resumeViewport);

  // Render initial frame immediately
  stepFrame(0);

  if (!testMode) {
    const rafLoop = (now: number): void => {
      const dt = Math.min(50, Math.max(0, now - lastWallMs));
      lastWallMs = now;
      // Self-healing: iOS sometimes sends no resize, orientation or visibility event at all, so every frame looks
      // for a window the renderer was not sized for (a few property reads, nothing allocated)
      if (viewportDrifted() || pageScrolled()) resyncViewport();
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
        hoverRake,
        watchGubbaRake,
        gubbaMode: runner.mode,
        undoCount: store.history.undoCount,
        redoCount: store.history.redoCount,
        rotateBlocked,
      }),
      auto: () => {
        const a = runner.state;
        return {
          mode: runner.mode,
          watch: watchGubbaRake,
          phase: autoPhase(a),
          target: runner.target,
          rootPos: { x: a.x, y: a.y, z: a.z },
          yaw: a.yaw,
          seated: a.seated,
          working: a.working,
          heldRake: a.rake,
          raking: a.rakeLive,
          carriedKind: a.carried,
          sandPlan: runner.sandPlan,
          lastSealDiffCells: runner.lastSealDiffCells,
          cyclesCompleted: runner.cyclesCompleted,
        };
      },
      setGubbaMode: (on) => {
        setGubbaMode(on);
        stepFrame(0);
      },
      autoRequest: (id) => {
        const started = requestGubbaPreset(id);
        stepFrame(0);
        return started;
      },
      stroke: (points, rakeId) => {
        if (points.length === 0) return sandHash(store.garden.sand);
        yieldToPlayer();
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
        syncMirror();
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
        yieldToPlayer();
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
        yieldToPlayer();
        const ok = store.moveElement(id, Math.round(x), Math.round(y));
        if (ok) {
          sandReset = true;
          flushSave();
          stepFrame(0);
        }
        return ok;
      },
      removeElement: (id) => {
        yieldToPlayer();
        const ok = store.removeElement(id);
        if (ok) {
          sandReset = true;
          flushSave();
          stepFrame(0);
        }
        return ok;
      },
      undo: () => {
        const ok = undoGarden();
        if (ok) {
          flushSave();
          stepFrame(0);
        }
        return ok;
      },
      redo: () => {
        const ok = redoGarden();
        if (ok) {
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
      haptics: () => ({ count: haptics.count, last: haptics.last }),
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
