// HUD pixel art and the speech scroll (DESIGN.md 2.7), ported from docs/mockups/garden-layout.html.
// Six 16×16 objects in a 3×2 block at the bottom left: undo, redo, breath lotus / mood lantern, sound bell,
// menu scroll. They are string art in code (base-32 digits are palette slots), never image files.

import { CLEAR, PixelLayer, drawText, wrapText } from "./font.ts";

export const S = {
  stone1: 6,
  stone2: 7,
  stone3: 8,
  wood1: 10,
  wood2: 11,
  wood3: 12,
  leaf2: 15,
  water1: 21,
  warm0: 23,
  warm1: 24,
  warm2: 25,
  ink: 30,
  paper: 31,
} as const;

export type HudId = "undo" | "redo" | "breath" | "mood" | "sound" | "menu";
export const HUD_ORDER: readonly HudId[] = ["undo", "redo", "breath", "mood", "sound", "menu"];
export const HUD_ICON = 16;
export const HUD_LEFT = 3;
/** Rows from the bottom of the framebuffer to the top of the HUD block. */
export const HUD_FROM_BOTTOM = 35;
export const SCROLL_X = 55;
export const SCROLL_MAX_W = 172;
export const SCROLL_H = 32;
export const SCROLL_LINES = 3;

const ART: Readonly<Record<string, readonly string[]>> = {
  undo: ["", "", "", ".....g", "....gg", "...ggggggff", "..gggggggfff", "...ggg....fff", "....gg.....ff", ".....g.....ff", "..........fff", ".......fffff"],
  lantern: ["", ".......aa", "......aaaa", ".....abbbba", ".....apppoa", ".....appooa", ".....appooa", ".....apoooa", ".....abbbba", "......aaaa", "......a..a"],
  bell: [".......v", ".......v", "......mmm", ".....mmmll", ".....mmmll", "....mmmmlll", "....lllllll", ".......v", "......vvv", "......vnv", "......vvv", "......vvv"],
  scroll: ["", "", "...cc......cc", "...cvvvvvvvvc", "...cvuuvuuuvc", "...cvvvvvvvvc", "...cvuuuvuvvc", "...cvvvvvvvvc", "...cvuvuuuvvc", "...cvvvvvvvvc", "...cc......cc"],
};

function icon(name: string, flip = false): PixelLayer {
  const L = new PixelLayer(HUD_ICON, HUD_ICON);
  const rows = ART[name] ?? [];
  L.art(0, 1, flip ? rows.map((r) => r.padEnd(HUD_ICON, ".").split("").reverse().join("")) : rows);
  return L.outline(S.ink);
}

/** The breath lotus, opening over six steps as amplitude rises from 0 to 1. */
export function lotusIcon(amplitude: number): PixelLayer {
  const L = new PixelLayer(HUD_ICON, HUD_ICON);
  const step = Math.max(0, Math.min(6, Math.floor(amplitude * 6 + 1e-6)));
  L.hline(3, 12, 10, S.stone3);
  L.hline(4, 11, 10, S.water1);
  L.hline(4, 11, 11, S.stone2);
  L.hline(4, 11, 12, S.stone2);
  L.hline(5, 10, 13, S.stone1);
  L.px(4, 11, S.stone3);
  L.hline(5, 10, 9, S.leaf2);
  L.rect(7, 7, 2, 2, S.warm1);
  L.hline(7, 8, 6, S.warm2);
  if (step >= 1) { L.px(6, 8, S.warm2); L.px(9, 8, S.warm2); }
  if (step >= 2) { L.px(5, 8, S.warm2); L.px(10, 8, S.warm2); }
  if (step >= 3) { L.px(6, 7, S.warm1); L.px(9, 7, S.warm1); }
  if (step >= 4) { L.px(4, 8, S.warm2); L.px(11, 8, S.warm2); }
  if (step >= 5) { L.px(5, 7, S.warm2); L.px(10, 7, S.warm2); }
  if (step >= 6) L.hline(7, 8, 5, S.warm2);
  return L.outline(S.ink);
}

export interface HudIcons {
  undo: PixelLayer;
  redo: PixelLayer;
  mood: PixelLayer;
  sound: PixelLayer;
  soundMuted: PixelLayer;
  menu: PixelLayer;
  /** Lotus frames for steps 0…6. */
  lotus: PixelLayer[];
}

/** Builds every HUD sprite once. */
export function makeHudIcons(): HudIcons {
  const soundMuted = icon("bell");
  // a small ink cross by the bell when muted
  for (let k = 0; k < 4; k++) {
    soundMuted.px(11 + k, 11 + k, S.ink);
    soundMuted.px(14 - k, 11 + k, S.ink);
  }
  return {
    undo: icon("undo"),
    redo: icon("undo", true),
    mood: icon("lantern"),
    sound: icon("bell"),
    soundMuted,
    menu: icon("scroll"),
    lotus: [0, 1, 2, 3, 4, 5, 6].map((s) => lotusIcon(s / 6)),
  };
}

/** Top-left of HUD slot `i` (0–5) for a framebuffer of height fbH: undo, redo, breath on top; mood, sound, menu below. */
export function hudSlot(i: number, fbH: number): { x: number; y: number } {
  const row = i < 3 ? 0 : 1;
  const col = i % 3;
  return { x: HUD_LEFT + col * HUD_ICON, y: fbH - HUD_FROM_BOTTOM + row * (HUD_ICON + 1) };
}

/** Narrow framebuffers (portrait phones) put the scroll above the HUD instead of beside it. */
const SCROLL_BESIDE_MIN = 100;

/** Rectangle of the speech scroll for a framebuffer of fbW × fbH. */
export function scrollRect(fbW: number, fbH: number): { x: number; y: number; w: number; h: number } {
  const beside = fbW - 60;
  if (beside >= SCROLL_BESIDE_MIN) return { x: SCROLL_X, y: fbH - 34, w: Math.min(SCROLL_MAX_W, beside), h: SCROLL_H };
  return { x: HUD_LEFT, y: fbH - HUD_FROM_BOTTOM - SCROLL_H - 2, w: Math.max(24, Math.min(SCROLL_MAX_W, fbW - 6)), h: SCROLL_H };
}

/** Draws the speech scroll with up to three lines of ink-on-paper text. Returns its rectangle. */
export function drawScroll(L: PixelLayer, text: string, fbW: number, fbH: number): { x: number; y: number; w: number; h: number } {
  const r = scrollRect(fbW, fbH);
  const sw = r.w;
  const x0 = r.x;
  const y0 = r.y;
  const lines = wrapText(text, sw - 14).slice(0, SCROLL_LINES);
  L.rect(x0 + 2, y0 + 1, sw - 4, 30, S.paper);
  L.hline(x0 + 2, x0 + sw - 3, y0 + 1, S.wood1);
  L.hline(x0 + 2, x0 + sw - 3, y0 + 30, S.wood1);
  for (const x of [x0, x0 + sw - 2]) {
    L.rect(x, y0, 2, SCROLL_H, S.wood3);
    L.vline(x + 1, y0, y0 + 31, S.wood2);
    L.hline(x, x + 1, y0, S.ink);
    L.hline(x, x + 1, y0 + 31, S.ink);
  }
  const ty = y0 + 3 + Math.floor((SCROLL_LINES - lines.length) * 4.5);
  lines.forEach((ln, i) => drawText(L, x0 + 6, ty + 1 + i * 9, ln, S.ink));
  return r;
}

/** A paper panel with wooden rails and ink corners, in the scroll's style. */
export function drawPanel(L: PixelLayer, x: number, y: number, w: number, h: number): void {
  L.rect(x + 2, y + 2, w - 4, h - 4, S.paper);
  L.hline(x + 2, x + w - 3, y + 1, S.wood1);
  L.hline(x + 2, x + w - 3, y + h - 2, S.wood1);
  for (const xx of [x, x + w - 2]) {
    L.rect(xx, y, 2, h, S.wood3);
    L.vline(xx + 1, y, y + h - 1, S.wood2);
    L.hline(xx, xx + 1, y, S.ink);
    L.hline(xx, xx + 1, y + h - 1, S.ink);
  }
  L.hline(x + 2, x + w - 3, y, S.wood3);
  L.hline(x + 2, x + w - 3, y + h - 1, S.wood3);
}

export { CLEAR };
