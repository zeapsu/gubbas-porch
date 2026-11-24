/**
 * Calm touch haptics with two backends.
 *
 * 1. `navigator.vibrate` (Android browsers). Short patterns, one per kind of touch.
 * 2. A hidden `<input type="checkbox" switch>` inside a `<label>` (iOS WebKit, which has no `navigator.vibrate`:
 *    Safari, Brave, Chrome and every other iOS browser). WebKit plays one Taptic Engine tick when a switch is
 *    toggled, and `label.click()` toggles it. Every kind is the same single tick here; WebKit offers no patterns.
 *
 * What the switch backend can and cannot do, by iOS version (from WebKit bug 285120 and library reports; not
 * verified on a device from this repository):
 * - iOS 17.4 to 18.3: a programmatic toggle ticks.
 * - iOS 18.4 to 26.4: it ticks only with user activation, so it is clicked only from inside a pointer event
 *   handler (`source: "touch"`) and never from a timer (`source: "hold"`).
 * - iOS 26.5 and later: reported to ignore programmatic toggles altogether. The click is then a silent no-op.
 *
 * Only touch ever produces feedback: mouse, pen, keyboard and screen-reader input pass `source: "other"` and are
 * ignored, and nothing fires under `prefers-reduced-motion: reduce`. Everything the engine touches is passed in,
 * so it does nothing (and never throws) where a piece is missing: Node, a browser without either backend, or a
 * browser that treats the switch as a plain checkbox.
 */

export type HapticKind = "tap" | "select" | "preview" | "thud" | "sweep" | "strokeStart" | "stoneBrush";

/**
 * Where a request comes from.
 * - `touch`: synchronously inside a touch pointer event handler. Both backends may fire.
 * - `hold`: a hold maturing in the frame loop while a finger is still down. Only `navigator.vibrate` fires; a
 *   switch click outside a gesture is wasted on iOS, so it is skipped.
 * - `other`: mouse, pen, keyboard, screen reader or a test hook. Never fires.
 */
export type HapticSource = "touch" | "hold" | "other";

/** `navigator.vibrate` patterns in milliseconds: on, off, on. All short enough to read as a tick, not a buzz. */
export const HAPTIC_PATTERNS: Readonly<Record<HapticKind, number | number[]>> = {
  /** HUD icon, menu chip, Gubba, the basket, a stone leaving the sand. */
  tap: 8,
  /** A rake taken from the wall. */
  select: 12,
  /** A held rake showing its description. */
  preview: 16,
  /** A stone set down: a firm beat and a softer echo. */
  thud: [18, 45, 10],
  /** The broom starting its sweep: two even beats. */
  sweep: [12, 80, 12],
  /** A touch stroke biting into the sand. */
  strokeStart: 5,
  /** The rake glancing off a stone. */
  stoneBrush: 7,
};

/** A stone nudge waits this long after any other haptic, so a stroke along a stone never buzzes. */
export const STONE_BRUSH_COOLDOWN_MS = 250;

const COOLDOWN_MS: Readonly<Record<HapticKind, number>> = {
  tap: 0,
  select: 0,
  preview: 0,
  thud: 0,
  sweep: 0,
  strokeStart: 0,
  stoneBrush: STONE_BRUSH_COOLDOWN_MS,
};

export const HAPTIC_SWITCH_ID = "haptic-switch";

/** Out of sight, out of layout and out of reach of a finger; `label.click()` still toggles the switch. */
const SWITCH_STYLE =
  "position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;opacity:0;overflow:hidden;pointer-events:none";

const SWITCH_EVENTS = ["click", "input", "change"] as const;

interface ReducedMotionQuery {
  readonly matches: boolean;
  addEventListener?: (type: "change", listener: (ev: { matches: boolean }) => void) => void;
  removeEventListener?: (type: "change", listener: (ev: { matches: boolean }) => void) => void;
}

/** The pieces of a browser the engine uses. Each may be missing. */
export interface HapticsEnv {
  navigator?: { vibrate?: ((pattern: number | number[]) => boolean) | undefined } | undefined;
  document?: Document | undefined;
  matchMedia?: ((query: string) => ReducedMotionQuery) | undefined;
  /** A millisecond clock for the cooldown. */
  now?: (() => number) | undefined;
}

export interface Haptics {
  /** Plays `kind` if the source, the cooldown and the user's motion preference allow it. True if a backend ran. */
  trigger(kind: HapticKind, source: HapticSource): boolean;
  /** How many haptics a backend has played, and the last kind. For tests. */
  readonly count: number;
  readonly last: HapticKind | null;
  /** Removes the hidden switch and every listener. The engine is silent afterwards. */
  dispose(): void;
}

/** The haptic source of a pointer event. */
export function hapticSource(pointerType: string): HapticSource {
  return pointerType === "touch" ? "touch" : "other";
}

function stopEvent(ev: Event): void {
  ev.stopPropagation();
}

export function createHaptics(env: HapticsEnv): Haptics {
  const now = env.now ?? Date.now;
  let disposed = false;
  let lastMs = -Infinity;
  let count = 0;
  let last: HapticKind | null = null;
  let label: HTMLLabelElement | null = null;
  let input: HTMLInputElement | null = null;

  let reduced = false;
  let query: ReducedMotionQuery | null = null;
  const onMotionChange = (ev: { matches: boolean }): void => {
    reduced = ev.matches;
  };
  try {
    query = env.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    reduced = query?.matches ?? false;
    query?.addEventListener?.("change", onMotionChange);
  } catch {
    query = null;
  }

  /** Builds the hidden switch on first use, so only a browser that needs it ever gets one. */
  function mountSwitch(doc: Document): boolean {
    if (label) return true;
    if (!doc.body) return false;
    const box = doc.createElement("input");
    box.setAttribute("type", "checkbox");
    box.setAttribute("switch", "");
    box.setAttribute("aria-hidden", "true");
    box.setAttribute("tabindex", "-1");
    const wrap = doc.createElement("label");
    wrap.id = HAPTIC_SWITCH_ID;
    wrap.setAttribute("aria-hidden", "true");
    wrap.style.cssText = SWITCH_STYLE;
    // The toggle is nobody else's business: its events stop here and never reach the page's own handlers
    for (const type of SWITCH_EVENTS) wrap.addEventListener(type, stopEvent);
    wrap.appendChild(box);
    doc.body.appendChild(wrap);
    label = wrap;
    input = box;
    return true;
  }

  function clickSwitch(): boolean {
    const doc = env.document;
    if (!doc || !mountSwitch(doc) || !label) return false;
    const focused = doc.activeElement as HTMLElement | null;
    label.click();
    // A scripted click moves focus in no current browser; if one ever does, hand it straight back
    if (input && doc.activeElement === input) {
      input.blur();
      focused?.focus?.({ preventScroll: true });
    }
    return true;
  }

  return {
    trigger(kind, source) {
      if (disposed || reduced || source === "other") return false;
      const t = now();
      if (t - lastMs < COOLDOWN_MS[kind]) return false;
      let fired = false;
      try {
        const nav = env.navigator;
        if (nav && typeof nav.vibrate === "function") {
          fired = nav.vibrate(HAPTIC_PATTERNS[kind]) !== false;
        } else if (source === "touch") {
          fired = clickSwitch();
        }
      } catch {
        fired = false;
      }
      if (fired) {
        lastMs = t;
        count++;
        last = kind;
      }
      return fired;
    },
    get count() {
      return count;
    },
    get last() {
      return last;
    },
    dispose() {
      disposed = true;
      try {
        query?.removeEventListener?.("change", onMotionChange);
        if (label) {
          for (const type of SWITCH_EVENTS) label.removeEventListener(type, stopEvent);
          label.remove();
        }
      } catch {
        // A detached or foreign node: nothing left to clean up
      }
      query = null;
      label = null;
      input = null;
    },
  };
}
