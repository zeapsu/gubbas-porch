import type { ElementKind, PresetId, RakeId } from "../state/types.ts";
import type { MixChannel } from "./settingsActions.ts";

/**
 * Keyboard mapping (DESIGN.md 9.4). `mapKeyDown` and `mapKeyUp` are pure; the
 * same `UiCommand` values are also emitted by the DOM mirror's buttons, so the
 * keyboard, the screen-reader controls, and the HUD all share one vocabulary.
 */

export type UiCommand =
  | { type: "select_rake"; rake: RakeId }
  /** Key `0`: held to sweep. */
  | { type: "sweep"; held: boolean }
  /** A button press: run one whole sweep. */
  | { type: "sweep_once" }
  | { type: "basket" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "toggle_breath" }
  | { type: "next_breath_pattern" }
  | { type: "toggle_mute" }
  | { type: "next_mood" }
  | { type: "toggle_mood_auto" }
  | { type: "next_camera" }
  | { type: "toggle_density" }
  | { type: "next_talk_mode" }
  | { type: "next_gubba_variant" }
  | { type: "toggle_rain" }
  | { type: "toggle_flow" }
  | { type: "toggle_watch" }
  | { type: "place_element"; kind: ElementKind }
  | { type: "adjust_mix"; channel: MixChannel; delta: -1 | 1 }
  | { type: "apply_preset"; preset: PresetId }
  | { type: "export" }
  | { type: "menu" }
  /** Arrow keys: move the virtual rake. Shift moves faster. */
  | { type: "virtual_move"; dx: -1 | 0 | 1; dy: -1 | 0 | 1; fast: boolean }
  /** Enter: set the virtual rake down or lift it. */
  | { type: "virtual_toggle" }
  | { type: "orbit"; dir: -1 | 1 };

/** The slice of a KeyboardEvent the mapping needs. */
export interface KeyInfo {
  key: string;
  code?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  /** `tagName` of the event target, upper case, if any. */
  targetTag?: string;
}

/** Keys 1-9 pick these rakes; 0 is the broom (an action, not a mode). */
export const RAKE_KEY_ORDER: readonly RakeId[] = [
  "sugi",
  "onami",
  "kinu",
  "hisui",
  "mikazuki",
  "tetsu",
  "wa",
  "take",
  "nagi",
];

const TEXT_TARGETS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function digitOf(k: KeyInfo): string | null {
  const code = k.code ?? "";
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (m && m[1] !== undefined) return m[1];
  return /^[0-9]$/.test(k.key) ? k.key : null;
}

/** True when the keystroke belongs to the focused element, not to the garden. */
function belongsToTarget(k: KeyInfo): boolean {
  const tag = k.targetTag?.toUpperCase();
  if (tag === undefined) return false;
  if (TEXT_TARGETS.has(tag)) return true;
  // Focused buttons keep Enter and Space for activation.
  return tag === "BUTTON" && (k.key === "Enter" || k.key === " ");
}

export function mapKeyDown(k: KeyInfo): UiCommand | null {
  if (belongsToTarget(k) || k.altKey) return null;
  const mod = k.ctrlKey === true || k.metaKey === true;
  const shift = k.shiftKey === true;

  const arrow = arrowOf(k.key);
  if (arrow && !mod) return { type: "virtual_move", dx: arrow.dx, dy: arrow.dy, fast: shift };

  if (k.repeat) return null; // everything else fires once per press

  const digit = digitOf(k);
  if (digit !== null && !mod) {
    if (digit === "0") return { type: "sweep", held: true };
    const rake = RAKE_KEY_ORDER[Number(digit) - 1];
    return rake ? { type: "select_rake", rake } : null;
  }

  const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
  switch (key) {
    case "p":
      return mod ? null : { type: "basket" };
    case "z":
      return shift ? { type: "redo" } : { type: "undo" };
    case "y":
      return { type: "redo" };
    case "b":
      return mod ? null : { type: "toggle_breath" };
    case "m":
      return mod ? null : { type: "toggle_mute" };
    case "t":
      return mod ? null : { type: "next_mood" };
    case "c":
      return mod ? null : { type: "next_camera" };
    case "x":
      return mod ? null : { type: "toggle_density" };
    case "g":
      return mod ? null : { type: "next_talk_mode" };
    case "e":
      return mod ? null : { type: "export" };
    case "q":
      return mod ? null : { type: "orbit", dir: -1 };
    case "w":
      return mod ? null : { type: "orbit", dir: 1 };
    case "Escape":
      return { type: "menu" };
    case "Enter":
      return { type: "virtual_toggle" };
    default:
      return null;
  }
}

/** Only `0` cares about key release: letting go ends the sweep. */
export function mapKeyUp(k: KeyInfo): UiCommand | null {
  if (belongsToTarget(k)) return null;
  return digitOf(k) === "0" ? { type: "sweep", held: false } : null;
}

function arrowOf(key: string): { dx: -1 | 0 | 1; dy: -1 | 0 | 1 } | null {
  switch (key) {
    case "ArrowLeft":
      return { dx: -1, dy: 0 };
    case "ArrowRight":
      return { dx: 1, dy: 0 };
    case "ArrowUp":
      return { dx: 0, dy: -1 };
    case "ArrowDown":
      return { dx: 0, dy: 1 };
    default:
      return null;
  }
}

/** Minimal event-target shape so tests and callers need no real window. */
export interface KeyEventTarget {
  addEventListener(type: "keydown" | "keyup", listener: (e: KeyboardEvent) => void): void;
  removeEventListener(type: "keydown" | "keyup", listener: (e: KeyboardEvent) => void): void;
}

/**
 * Wires `mapKeyDown`/`mapKeyUp` to a target (usually `window`). Returns an
 * unsubscribe function. Handled keys have their default action prevented.
 */
export function bindKeyboard(target: KeyEventTarget, onCommand: (c: UiCommand) => void): () => void {
  const info = (e: KeyboardEvent): KeyInfo => {
    const t = e.target;
    const tag = t && "tagName" in t && typeof t.tagName === "string" ? t.tagName : undefined;
    return {
      key: e.key,
      code: e.code,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      repeat: e.repeat,
      ...(tag !== undefined ? { targetTag: tag } : {}),
    };
  };
  const down = (e: KeyboardEvent): void => {
    const c = mapKeyDown(info(e));
    if (c) {
      e.preventDefault();
      onCommand(c);
    }
  };
  const up = (e: KeyboardEvent): void => {
    const c = mapKeyUp(info(e));
    if (c) {
      e.preventDefault();
      onCommand(c);
    }
  };
  target.addEventListener("keydown", down);
  target.addEventListener("keyup", up);
  return () => {
    target.removeEventListener("keydown", down);
    target.removeEventListener("keyup", up);
  };
}
