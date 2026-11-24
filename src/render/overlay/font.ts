// The original 4×7 bitmap font from docs/mockups/garden-layout.html (DESIGN.md 2.7): cap height 7, x-height 5,
// glyphs 4 wide (5 for m and w, 1–3 for narrow letters), two descender rows, line pitch 9. A glyph definition is
// rows of `#`/`.` joined by `/`, optionally prefixed `N:` for its top offset in rows. `/ ( ) +` are additions in
// the same style for the menu. Also home to `PixelLayer`, the palette-indexed buffer the overlay draws into.

/** Transparent index in overlay buffers. */
export const CLEAR = 255;
export const LINE_PITCH = 9;
export const CAP_HEIGHT = 7;

const FONT: Readonly<Record<string, string>> = {
  A: ".##./#..#/#..#/####/#..#/#..#/#..#", B: "###./#..#/#..#/###./#..#/#..#/###.", C: ".###/#.../#.../#.../#.../#.../.###",
  D: "###./#..#/#..#/#..#/#..#/#..#/###.", E: "####/#.../#.../###./#.../#.../####", F: "####/#.../#.../###./#.../#.../#...",
  G: ".###/#.../#.../#.##/#..#/#..#/.###", H: "#..#/#..#/#..#/####/#..#/#..#/#..#", I: "###/.#./.#./.#./.#./.#./###",
  J: "..##/...#/...#/...#/...#/#..#/.##.", K: "#..#/#..#/#.#./##../#.#./#..#/#..#", L: "#.../#.../#.../#.../#.../#.../####",
  M: "#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#", N: "#..#/##.#/##.#/#.##/#.##/#..#/#..#", O: ".##./#..#/#..#/#..#/#..#/#..#/.##.",
  P: "###./#..#/#..#/###./#.../#.../#...", Q: ".##./#..#/#..#/#..#/#..#/#.#./.#.#", R: "###./#..#/#..#/###./#.#./#..#/#..#",
  S: ".###/#.../#.../.##./...#/...#/###.", T: "###/.#./.#./.#./.#./.#./.#.", U: "#..#/#..#/#..#/#..#/#..#/#..#/.##.",
  V: "#...#/#...#/#...#/.#.#./.#.#./..#../..#..", W: "#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#", X: "#..#/#..#/.##./.##./.##./#..#/#..#",
  Y: "#...#/#...#/.#.#./..#../..#../..#../..#..", Z: "####/...#/..#./..#./.#../#.../####",
  a: "2:.##./...#/.###/#..#/.###", b: "#.../#.../###./#..#/#..#/#..#/###.", c: "2:.##/#../#../#../.##",
  d: "...#/...#/.###/#..#/#..#/#..#/.###", e: "2:.##./#..#/####/#.../.###", f: ".##/#../###/#../#../#../#..",
  g: "2:.###/#..#/#..#/#..#/.###/...#/.##.", h: "#.../#.../###./#..#/#..#/#..#/#..#", i: "#/./#/#/#/#/#",
  j: ".#/../.#/.#/.#/.#/.#/.#/#.", k: "#.../#.../#..#/#.#./##../#.#./#..#", l: "#/#/#/#/#/#/#",
  m: "2:##.#./#.#.#/#.#.#/#.#.#/#.#.#", n: "2:###./#..#/#..#/#..#/#..#", o: "2:.##./#..#/#..#/#..#/.##.",
  p: "2:###./#..#/#..#/#..#/###./#.../#...", q: "2:.###/#..#/#..#/#..#/.###/...#/...#", r: "2:#.#/##./#../#../#..",
  s: "2:.###/#.../.##./...#/###.", t: ".#./.#./###/.#./.#./.#./..#", u: "2:#..#/#..#/#..#/#..#/.###",
  v: "2:#.#/#.#/#.#/#.#/.#.", w: "2:#...#/#.#.#/#.#.#/#.#.#/.#.#.", x: "2:#.#/#.#/.#./#.#/#.#",
  y: "2:#..#/#..#/#..#/#..#/.###/...#/.##.", z: "2:####/..#./.#../#.../####",
  0: ".##./#..#/#.##/##.#/#..#/#..#/.##.", 1: ".#./##./.#./.#./.#./.#./###", 2: ".##./#..#/...#/..#./.#../#.../####",
  3: "###./...#/...#/.##./...#/...#/###.", 4: "#..#/#..#/#..#/####/...#/...#/...#", 5: "####/#.../###./...#/...#/#..#/.##.",
  6: ".##./#.../#.../###./#..#/#..#/.##.", 7: "####/...#/...#/..#./..#./.#../.#..", 8: ".##./#..#/#..#/.##./#..#/#..#/.##.",
  9: ".##./#..#/#..#/.###/...#/...#/.##.",
  ".": "6:#", ",": "6:.#/#.", "'": "0:#/#", "-": "4:###", "·": "4:#", ":": "3:#/././#", "!": "#/#/#/#/#/./#",
  "?": ".##./#..#/...#/..#./.#../..../.#..", "×": "3:#.#/.#./#.#",
  "/": "...#/...#/..#./..#./.#../.#../#...", "(": ".#/#./#./#./#./#./.#", ")": "#./.#/.#/.#/.#/.#/#.",
  "+": "2:.#./.#./###/.#./.#.",
};

export interface Glyph {
  y0: number;
  rows: readonly string[];
  w: number;
}

const GLYPHS = new Map<string, Glyph>();
for (const [ch, def] of Object.entries(FONT)) {
  let rows = def;
  let y0 = 0;
  const m = /^(\d):(.*)$/.exec(def);
  if (m) {
    y0 = Number(m[1]);
    rows = m[2] ?? "";
  }
  const split = rows.split("/");
  GLYPHS.set(ch, { y0, rows: split, w: Math.max(...split.map((r) => r.length)) });
}

const MACRON: Readonly<Record<string, string>> = { Ō: "O", ō: "o" };
const SPACE = 3;

export function glyphOf(ch: string): Glyph | undefined {
  return GLYPHS.get(MACRON[ch] ?? ch);
}

/** Width in pixels of `text` drawn in one line (no trailing gap). */
export function measureText(text: string): number {
  let w = 0;
  for (const ch of text) {
    const g = glyphOf(ch);
    w += g ? g.w + 1 : SPACE;
  }
  return Math.max(0, w - 1);
}

/** Greedy word wrap to `maxPx`. A single word wider than the line keeps its own line. */
export function wrapText(text: string, maxPx: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const t = line ? `${line} ${word}` : word;
    if (measureText(t) <= maxPx || !line) line = t;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** A palette-indexed pixel buffer (values 0…31, `CLEAR` = transparent), row-major, top row first. */
export class PixelLayer {
  w: number;
  h: number;
  d: Uint8Array;

  constructor(w: number, h: number, data?: Uint8Array) {
    this.w = w;
    this.h = h;
    this.d = data ?? new Uint8Array(w * h).fill(CLEAR);
  }

  clear(): this {
    this.d.fill(CLEAR);
    return this;
  }

  get(x: number, y: number): number {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? CLEAR : (this.d[y * this.w + x] ?? CLEAR);
  }

  px(x: number, y: number, c: number): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi >= 0 && yi >= 0 && xi < this.w && yi < this.h) this.d[yi * this.w + xi] = c;
  }

  rect(x: number, y: number, w: number, h: number, c: number): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.w, x + w);
    const y1 = Math.min(this.h, y + h);
    for (let j = y0; j < y1; j++) this.d.fill(c, j * this.w + x0, j * this.w + Math.max(x0, x1));
  }

  hline(x0: number, x1: number, y: number, c: number): void {
    for (let x = x0; x <= x1; x++) this.px(x, y, c);
  }

  vline(x: number, y0: number, y1: number, c: number): void {
    for (let y = y0; y <= y1; y++) this.px(x, y, c);
  }

  /** 1-pixel rectangle outline. */
  frame(x: number, y: number, w: number, h: number, c: number): void {
    this.hline(x, x + w - 1, y, c);
    this.hline(x, x + w - 1, y + h - 1, c);
    this.vline(x, y, y + h - 1, c);
    this.vline(x + w - 1, y, y + h - 1, c);
  }

  line(ax: number, ay: number, bx: number, by: number, c: number): void {
    let x0 = Math.round(ax);
    let y0 = Math.round(ay);
    const x1 = Math.round(bx);
    const y1 = Math.round(by);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (;;) {
      this.px(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) {
        e += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        e += dx;
        y0 += sy;
      }
    }
  }

  /** String art: characters 0–9a–v are palette slots 0–31 (base 32); anything else is transparent. */
  art(x: number, y: number, rows: readonly string[], flip = false): void {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const v = Number.parseInt(row[flip ? row.length - 1 - i : i] ?? ".", 32);
        if (!Number.isNaN(v) && v < 32) this.px(x + i, y + j, v);
      }
    });
  }

  /** Transparent pixels touching an opaque one take colour `c` (an outer outline). */
  outline(c: number): this {
    const src = this.d.slice();
    const { w, h } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (src[y * w + x] !== CLEAR) continue;
        if (
          (x > 0 && src[y * w + x - 1] !== CLEAR) ||
          (x < w - 1 && src[y * w + x + 1] !== CLEAR) ||
          (y > 0 && src[(y - 1) * w + x] !== CLEAR) ||
          (y < h - 1 && src[(y + 1) * w + x] !== CLEAR)
        ) {
          this.d[y * w + x] = c;
        }
      }
    }
    return this;
  }

  /** Copies opaque pixels onto `dst` at (ox, oy). */
  blit(dst: PixelLayer, ox: number, oy: number): void {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const v = this.d[y * this.w + x] ?? CLEAR;
        if (v !== CLEAR) dst.px(ox + x, oy + y, v);
      }
    }
  }
}

/** Draws `text` with its top-left at (x, y) in palette slot `c`; returns the pen x after the last glyph. */
export function drawText(layer: PixelLayer, x: number, y: number, text: string, c: number): number {
  let pen = x;
  for (const ch of text) {
    const g = glyphOf(ch);
    if (!g) {
      pen += SPACE;
      continue;
    }
    for (let j = 0; j < g.rows.length; j++) {
      const row = g.rows[j] ?? "";
      for (let i = 0; i < row.length; i++) if (row[i] === "#") layer.px(pen + i, y + g.y0 + j, c);
    }
    if (MACRON[ch]) layer.hline(pen, pen + g.w - 1, y + (ch === "Ō" ? -2 : 0), c);
    pen += g.w + 1;
  }
  return pen;
}
