import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Popular real-world windows, driven in real Chromium WebGL2 (DESIGN.md 2.4, 10.3). Every playable window must
// show the whole garden — bed, Wall of Rakes, Gubba, stone basket — with nothing touching the frame edge, keep
// every HUD and panel control inside the framebuffer, and scale by a whole number. An upright phone gets the
// turn-sideways prompt instead and plays once it is turned. A phone on its side, at its real pixel ratio and with
// the browser's bars and the notch taken out of the window, must have controls a thumb can hit.

interface Viewport {
  width: number;
  height: number;
  name: string;
  /** Name its screenshots are kept under in test-results/, when not just width x height. */
  shot?: string;
}

const PLAYABLE: readonly Viewport[] = [
  { width: 1920, height: 1080, name: "desktop FHD 16:9" },
  { width: 1440, height: 900, name: "laptop 16:10" },
  { width: 1366, height: 768, name: "laptop 16:9" },
  { width: 1280, height: 720, name: "desktop HD 16:9" },
  { width: 1024, height: 768, name: "4:3 / tablet landscape" },
  { width: 768, height: 1024, name: "tablet portrait" },
  { width: 640, height: 720, name: "narrow / split-screen desktop" },
  { width: 844, height: 390, name: "phone landscape" },
  { width: 667, height: 375, name: "small phone landscape" },
];

interface Phone extends Viewport {
  dpr: number;
  /** Where Settings and the basket open: above the HUD as on a desktop, or beside it in a window too short for that. */
  panels: "above" | "beside";
}

/**
 * Phones on their side at their real device pixel ratio: one full screen, then two as a mobile browser really gives
 * them to the page, where the address bar, tab strip and safe-area insets leave a window far shorter than the screen.
 */
const PHONES: readonly Phone[] = [
  { width: 844, height: 390, dpr: 3, panels: "above", name: "phone landscape, full screen", shot: "844x390@3x" },
  { width: 726, height: 275, dpr: 3, panels: "beside", name: "phone landscape inside browser chrome" },
  { width: 667, height: 260, dpr: 2, panels: "beside", name: "small phone landscape inside browser chrome" },
];
/** The side a HUD object has at least on a phone, in CSS pixels (`TOUCH_MIN_CSS` in the overlay). */
const THUMB_CSS = 40;

const PORTRAIT_PHONES: readonly Viewport[] = [
  { width: 390, height: 844, name: "phone portrait" },
  { width: 360, height: 800, name: "Android portrait" },
];

/** Sizes whose screenshots are kept in test-results/ for a human to look at. */
const SCREENSHOTS = new Set(["1440x900", "1024x768", "768x1024", "640x720", "844x390", "390x844", "844x390@3x", "726x275", "667x260"]);

const VARIANTS = ["moss", "kasa", "lantern"] as const;
const RAKES = ["sugi", "onami", "kinu", "hisui", "mikazuki", "tetsu", "wa", "take", "nagi", "hoki"] as const;
const TABS = ["look", "garden", "sound", "presets"] as const;
/** Controls each Settings tab offers (Gubba + mood + camera + pixels, and so on). */
const TAB_CONTROLS: Readonly<Record<(typeof TABS)[number], number>> = { look: 13, garden: 12, sound: 34, presets: 12 };
/** Pixels the bed's corners must keep from the frame edge (the framing margin is 6 for the frame around them). */
const BED_MARGIN = 6;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("requestfailed", (req) => errors.push(`requestfailed: ${req.url()}`));
  return errors;
}

async function open(page: Page, vp: Viewport): Promise<void> {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto("?test=1");
  await page.waitForFunction(() => Boolean(window.__rakeMe));
}

/**
 * The canvas is a whole multiple of the framebuffer in device pixels, sits wholly inside the window, and wastes
 * under one scene pixel. Rectangles are read in CSS pixels and compared in device pixels, so the same rule holds at
 * any device pixel ratio. Chromium lays out in 1/64ths of a CSS pixel, so where the canvas's CSS size is not a whole
 * number (2176 device pixels at ratio 3) a rectangle edge reads up to that much off.
 */
async function expectIntegerScale(page: Page, label: string): Promise<void> {
  const s = await page.evaluate(() => {
    const api = window.__rakeMe!;
    const canvas = document.getElementById("garden-canvas") as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return {
      fb: api.fbSize(),
      backing: { w: canvas.width, h: canvas.height },
      rect: { left: r.left * dpr, top: r.top * dpr, right: r.right * dpr, bottom: r.bottom * dpr, width: r.width * dpr, height: r.height * dpr },
      win: { w: window.innerWidth * dpr, h: window.innerHeight * dpr },
      // one layout unit, in device pixels; nothing at ratio 1, where every edge is a whole CSS pixel
      slack: dpr === 1 ? 1e-9 : dpr / 64 + 1e-9,
    };
  });
  const whole = (v: number): boolean => Math.abs(v - Math.round(v)) <= s.slack;
  expect(Number.isInteger(s.fb.scale) && s.fb.scale >= 1, label).toBe(true);
  expect(s.backing, label).toEqual({ w: s.fb.fbW * s.fb.scale, h: s.fb.fbH * s.fb.scale });
  expect(Math.abs(s.rect.width - s.fb.fbW * s.fb.scale), `${label}: canvas width ${s.rect.width}`).toBeLessThanOrEqual(s.slack);
  expect(Math.abs(s.rect.height - s.fb.fbH * s.fb.scale), `${label}: canvas height ${s.rect.height}`).toBeLessThanOrEqual(s.slack);
  // nothing is cropped: the canvas lies inside the window on whole device pixels
  expect(whole(s.rect.left) && whole(s.rect.top), label).toBe(true);
  expect(s.rect.left, label).toBeGreaterThanOrEqual(-s.slack);
  expect(s.rect.top, label).toBeGreaterThanOrEqual(-s.slack);
  expect(s.rect.right, label).toBeLessThanOrEqual(s.win.w + s.slack);
  expect(s.rect.bottom, label).toBeLessThanOrEqual(s.win.h + s.slack);
  // and the border left over is thinner than one scene pixel
  expect(s.win.w - s.rect.width, label).toBeLessThan(s.fb.scale);
  expect(s.win.h - s.rect.height, label).toBeLessThan(s.fb.scale);
}

/**
 * What reaches the screen is on the device grid: a screenshot at the device's pixel ratio holds the window at
 * exactly its device size, and an open panel (opaque from edge to edge) is made of flat uiK × uiK squares that
 * line up with the canvas's bottom-left corner, in a handful of palette colours.
 *
 * Only for a canvas whose CSS box is whole CSS pixels. Chromium's emulated pixel ratio snaps a canvas to whole CSS
 * pixels when it paints, so a canvas 2176 device pixels wide at ratio 3 (725.33 CSS pixels) is stretched to 2178
 * in a screenshot here; a phone's own browser snaps to device pixels and has no such stretch to test for.
 */
async function expectDeviceGrid(page: Page, label: string): Promise<void> {
  const g = await page.evaluate(() => {
    const api = window.__rakeMe!;
    api.openPanel("settings", "look");
    const fb = api.fbSize();
    const canvas = document.getElementById("garden-canvas") as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    const box = api.overlayHits().find((h) => h.action.type === "none")!;
    return {
      dpr,
      uiK: Math.round(fb.uiScale * fb.scale),
      left: Math.round(r.left * dpr),
      top: Math.round(r.top * dpr),
      height: canvas.height,
      // the panel in device pixels, relative to the canvas (hit rectangles are fractional framebuffer pixels)
      panel: { x: Math.round(box.x * fb.scale), y: Math.round(box.y * fb.scale), w: Math.round(box.w * fb.scale), h: Math.round(box.h * fb.scale) },
    };
  });
  const png = await page.screenshot({ scale: "device" });
  const grid = await page.evaluate(
    async ({ b64, g }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const { x, y, w, h } = g.panel;
      const px = ctx.getImageData(g.left + x, g.top + y, w, h).data;
      const at = (i: number, j: number): number => (px[(j * w + i) * 4]! << 16) | (px[(j * w + i) * 4 + 1]! << 8) | px[(j * w + i) * 4 + 2]!;
      let bad = 0;
      const seen = new Set<number>();
      for (let j = 0; j < h; j++) {
        // rows are counted from the canvas's bottom edge, where the overlay is anchored
        const fromBottom = g.height - 1 - (y + j);
        const cellTop = j - (g.uiK - 1 - (fromBottom % g.uiK));
        for (let i = 0; i < w; i++) {
          const cellLeft = i - ((x + i) % g.uiK);
          if (at(i, j) !== at(Math.max(0, cellLeft), Math.max(0, cellTop))) bad++;
          seen.add(at(i, j));
        }
      }
      return { bad, colours: seen.size, shot: [img.width, img.height] };
    },
    { b64: png.toString("base64"), g },
  );
  await page.evaluate(() => window.__rakeMe!.openPanel("none"));
  const vp = page.viewportSize()!;
  expect(grid.shot, `${label}: screenshot in device pixels`).toEqual([Math.round(vp.width * g.dpr), Math.round(vp.height * g.dpr)]);
  expect(g.panel.x % g.uiK, `${label}: panel on the overlay's grid`).toBe(0);
  expect((g.height - g.panel.y - g.panel.h) % g.uiK, `${label}: panel on the overlay's grid`).toBe(0);
  // paper, ink and the three woods of the rails
  expect(grid.colours, `${label}: panel colours`).toBeGreaterThanOrEqual(4);
  expect(grid.colours, `${label}: panel colours`).toBeLessThanOrEqual(6);
  expect(grid.bad, `${label}: panel pixels off the ${g.uiK}-device-pixel grid`).toBe(0);
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
}

/** Rendered, and no pixel of it on the outermost row or column of the framebuffer. */
function expectInsideFrame(b: Bounds | undefined, fb: { fbW: number; fbH: number }, label: string): void {
  expect(b, `${label}: not rendered`).toBeDefined();
  expect(b!.count, `${label}: pixels`).toBeGreaterThan(0);
  expect(b!.minX, `${label}: left edge`).toBeGreaterThanOrEqual(1);
  expect(b!.minY, `${label}: top edge`).toBeGreaterThanOrEqual(1);
  expect(b!.maxX, `${label}: right edge`).toBeLessThanOrEqual(fb.fbW - 2);
  expect(b!.maxY, `${label}: bottom edge`).toBeLessThanOrEqual(fb.fbH - 2);
}

/** What `pick()` finds inside a bounding box: scans it for the first pixel of `kind` (and `id`). */
async function pickInside(page: Page, b: Bounds, kind: string, id?: string): Promise<boolean> {
  return page.evaluate(
    ({ b, kind, id }) => {
      const api = window.__rakeMe!;
      const stepX = Math.max(1, Math.floor((b.maxX - b.minX) / 24));
      const stepY = Math.max(1, Math.floor((b.maxY - b.minY) / 24));
      for (let y = b.minY; y <= b.maxY; y += stepY) {
        for (let x = b.minX; x <= b.maxX; x += stepX) {
          const p = api.pick(x + 0.5, y + 0.5);
          if (p.kind === kind && (id === undefined || p.id === id)) return true;
        }
      }
      return false;
    },
    { b, kind, id },
  );
}

/** HUD, speech scroll, all four Settings tabs and the stone basket: inside the framebuffer, clear of the HUD. */
async function expectOverlayTidy(page: Page, label: string): Promise<void> {
  const report = await page.evaluate((tabs) => {
    const api = window.__rakeMe!;
    const { fbW, fbH } = api.fbSize();
    type Hit = { x: number; y: number; w: number; h: number; action: { type: string } };
    const problems: string[] = [];
    const counts: Record<string, number> = {};
    const check = (where: string): Hit[] => {
      const hits = api.overlayHits() as unknown as Hit[];
      const hud = hits.filter((h) => h.action.type === "hud");
      for (const h of hits) {
        if (h.x < 0 || h.y < 0 || h.w <= 0 || h.h <= 0 || h.x + h.w > fbW || h.y + h.h > fbH) {
          problems.push(`${where}: ${h.action.type} at ${h.x},${h.y} ${h.w}x${h.h} leaves ${fbW}x${fbH}`);
        }
        if (h.action.type === "hud") continue;
        for (const icon of hud) {
          if (h.x < icon.x + icon.w && icon.x < h.x + h.w && h.y < icon.y + icon.h && icon.y < h.y + h.h) {
            problems.push(`${where}: ${h.action.type} at ${h.x},${h.y} ${h.w}x${h.h} overlaps the HUD`);
          }
        }
      }
      if (api.paletteViolations() !== 0) problems.push(`${where}: off-palette pixels`);
      return hits;
    };
    api.openPanel("none");
    counts.hud = check("hud").filter((h) => h.action.type === "hud").length;
    const scroll = api.speechRect();
    if (scroll.x < 0 || scroll.y < 0 || scroll.x + scroll.w > fbW || scroll.y + scroll.h > fbH) {
      problems.push(`speech scroll at ${scroll.x},${scroll.y} ${scroll.w}x${scroll.h} leaves ${fbW}x${fbH}`);
    }
    for (const tab of tabs) {
      api.openPanel("settings", tab);
      const hits = check(`settings/${tab}`);
      counts[`tabs:${tab}`] = hits.filter((h) => h.action.type === "tab").length;
      counts[tab] = hits.filter((h) => ["settings", "preset", "watch", "gubba_mode", "export"].includes(h.action.type)).length;
    }
    api.openPanel("basket");
    counts.basket = check("basket").filter((h) => h.action.type === "place").length;
    api.openPanel("none");
    return { problems, counts };
  }, TABS);
  expect(report.problems, label).toEqual([]);
  expect(report.counts.hud, `${label}: HUD objects`).toBe(6);
  for (const tab of TABS) {
    expect(report.counts[`tabs:${tab}`], `${label}: tabs on ${tab}`).toBe(4);
    expect(report.counts[tab], `${label}: controls on ${tab}`).toBe(TAB_CONTROLS[tab]);
  }
  expect(report.counts.basket, `${label}: basket items`).toBe(11);
}

/**
 * The controls are sized for the window, not for the scene's pixels (DESIGN.md 2.7): a HUD object is 6–14 % of the
 * window's shorter side, or a thumb's width where that is larger; the overlay's pixels are whole device pixels no
 * finer than the scene's; and what the present pass draws is what a real click hits.
 */
async function expectControlsSized(page: Page, label: string): Promise<void> {
  const m = await page.evaluate(() => {
    const api = window.__rakeMe!;
    api.openPanel("none");
    const fb = api.fbSize();
    const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
    const css = rect.width / fb.fbW; // CSS pixels per framebuffer pixel
    const hud = api.overlayHits().filter((h) => h.action.type === "hud");
    const menu = hud.find((h) => (h.action as { id?: string }).id === "menu")!;
    return {
      fb,
      dpr: window.devicePixelRatio,
      short: Math.min(window.innerWidth, window.innerHeight),
      sides: hud.map((h) => [h.w * css, h.h * css]),
      menu: { x: rect.left + menu.x * css, y: rect.top + menu.y * css, w: menu.w * css, h: menu.h * css },
    };
  });
  const overlayPixel = m.fb.uiScale * m.fb.scale;
  expect(m.fb.uiScale, `${label}: overlay scale`).toBeGreaterThanOrEqual(1);
  expect(Math.abs(overlayPixel - Math.round(overlayPixel)), `${label}: overlay pixel ${overlayPixel}`).toBeLessThan(1e-9);
  for (const [w, h] of m.sides) {
    expect(w, `${label}: HUD object is square`).toBeCloseTo(h!, 6);
    expect(w! / m.short, `${label}: HUD object ${w} CSS px of ${m.short}`).toBeGreaterThanOrEqual(0.06);
    // the thumb size is the smallest whole overlay pixel that reaches THUMB_CSS: under one device pixel per pixel more
    expect(w!, `${label}: HUD object ${w} CSS px of ${m.short}`).toBeLessThanOrEqual(Math.max(0.14 * m.short, THUMB_CSS + 16 / m.dpr) + 1e-6);
  }

  // a real click on the menu object, where its hit rectangle says it is, opens the menu scroll
  await page.mouse.click(m.menu.x + m.menu.w / 2, m.menu.y + m.menu.h / 2);
  const opened = await page.evaluate(() => {
    const api = window.__rakeMe!;
    api.advance(16);
    return { panel: api.state().panel, violations: api.paletteViolations() };
  });
  expect(opened.panel, `${label}: click on the menu object`).toBe("settings");
  expect(opened.violations, `${label}: menu open`).toBe(0);
  // and the scroll reaches the screen: with the clock held still, the window changes with it and only with it
  const shot = async (panel: "none" | "settings"): Promise<Buffer> => {
    await page.evaluate((p) => window.__rakeMe!.openPanel(p), panel);
    return page.screenshot();
  };
  const open = await shot("settings");
  const closed = await shot("none");
  expect(closed.equals(open), `${label}: the menu scroll is drawn`).toBe(false);
  expect((await shot("settings")).equals(open), `${label}: the same frame draws the same pixels`).toBe(true);
  await page.evaluate(() => window.__rakeMe!.openPanel("none"));
}

/** The whole playable contract for the window the page is currently in. */
async function expectPlayable(page: Page, vp: Viewport): Promise<void> {
  const tag = `${vp.width}x${vp.height}`;
  const shot = vp.shot ?? tag;
  expect(await page.locator("#rotate-prompt").isHidden(), `${tag}: rotate prompt`).toBe(true);
  expect((await page.evaluate(() => window.__rakeMe!.state())).rotateBlocked, tag).toBe(false);

  await page.evaluate(() => {
    const api = window.__rakeMe!;
    api.setMood("afternoon");
    api.setDensity("crisp");
    api.setCamera("cozy");
  });
  await expectIntegerScale(page, `${tag} crisp`);
  const fb = await page.evaluate(() => window.__rakeMe!.fbSize());

  // ---- Cozy 3/4: Gubba (all three variants), basket, the bed, and every rake on the wall
  for (const variant of VARIANTS) {
    const b = await page.evaluate((v) => {
      const api = window.__rakeMe!;
      api.setGubbaVariant(v);
      return { bounds: api.pickBounds(), violations: api.paletteViolations(), drawCalls: api.drawCalls() };
    }, variant);
    expect(b.violations, `${tag} cozy ${variant}`).toBe(0);
    expect(b.drawCalls, `${tag} cozy ${variant}`).toBeLessThanOrEqual(60);
    expectInsideFrame(b.bounds.gubba, fb, `${tag} cozy Gubba (${variant})`);
    expect(await pickInside(page, b.bounds.gubba!, "gubba"), `${tag} cozy pick Gubba (${variant})`).toBe(true);
    expectInsideFrame(b.bounds.basket, fb, `${tag} cozy basket`);
    expect(await pickInside(page, b.bounds.basket!, "basket"), `${tag} cozy pick basket`).toBe(true);
  }
  await page.evaluate(() => window.__rakeMe!.setGubbaVariant("moss"));

  // the held rake leaves its pegs, so look at the wall holding tetsu, then holding sugi
  for (const held of ["6", "1"] as const) {
    await page.keyboard.press(held);
    const bounds = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(1500); // let the rake fly to the hand and the vacated pegs settle
      return api.pickBounds();
    });
    const inHand = held === "6" ? "tetsu" : "sugi";
    for (const id of RAKES) {
      if (id === inHand) continue;
      expectInsideFrame(bounds[`rake:${id}`], fb, `${tag} cozy rake ${id}`);
    }
    for (const id of held === "6" ? (["sugi", "hoki"] as const) : (["tetsu"] as const)) {
      expect(await pickInside(page, bounds[`rake:${id}`]!, "rake", id), `${tag} cozy pick rake ${id}`).toBe(true);
    }
  }

  const bed = await page.evaluate(() => {
    const api = window.__rakeMe!;
    const corners = [[-96, -56], [96, -56], [96, 56], [-96, 56]].map(([x, z]) => api.project(x!, 3, z!));
    const mid = api.project(0, 3, 0);
    return { corners, mid, sand: mid ? api.sandPoint(mid.x, mid.y) : null };
  });
  for (const c of bed.corners) {
    expect(c, `${tag} cozy bed corner`).not.toBeNull();
    expect(c!.x, `${tag} cozy bed corner x`).toBeGreaterThanOrEqual(BED_MARGIN);
    expect(c!.x, `${tag} cozy bed corner x`).toBeLessThanOrEqual(fb.fbW - BED_MARGIN);
    expect(c!.y, `${tag} cozy bed corner y`).toBeGreaterThanOrEqual(BED_MARGIN);
    expect(c!.y, `${tag} cozy bed corner y`).toBeLessThanOrEqual(fb.fbH - BED_MARGIN);
  }
  expect(bed.sand!.x, `${tag} cozy sand centre`).toBeCloseTo(96, 3);
  expect(bed.sand!.y, `${tag} cozy sand centre`).toBeCloseTo(56, 3);

  // the centre of the bed rakes under a real pointer
  const drag = await page.evaluate(() => {
    const api = window.__rakeMe!;
    const { fbW, fbH } = api.fbSize();
    const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
    const toClient = (x: number, z: number): { x: number; y: number } => {
      const p = api.project(x, 3, z)!;
      return { x: rect.left + (p.x / fbW) * rect.width, y: rect.top + (p.y / fbH) * rect.height };
    };
    return { from: toClient(-30, -6), to: toClient(34, 4), hash: api.sandHash() };
  });
  await page.mouse.move(drag.from.x, drag.from.y);
  await page.mouse.down();
  await page.mouse.move(drag.to.x, drag.to.y, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.__rakeMe!.sandHash()), `${tag} cozy raking`).not.toBe(drag.hash);

  if (SCREENSHOTS.has(shot)) await page.screenshot({ path: `test-results/viewport-${shot}.png` });

  // ---- Gubba Porch: Gubba whole, in every variant
  for (const variant of VARIANTS) {
    const b = await page.evaluate((v) => {
      const api = window.__rakeMe!;
      api.setCamera("porch");
      api.setGubbaVariant(v);
      return { bounds: api.pickBounds(), violations: api.paletteViolations() };
    }, variant);
    expect(b.violations, `${tag} porch ${variant}`).toBe(0);
    expectInsideFrame(b.bounds.gubba, fb, `${tag} porch Gubba (${variant})`);
    expect(await pickInside(page, b.bounds.gubba!, "gubba"), `${tag} porch pick Gubba (${variant})`).toBe(true);
  }
  if (SCREENSHOTS.has(shot)) await page.screenshot({ path: `test-results/viewport-${shot}-porch.png` });
  await page.evaluate(() => window.__rakeMe!.setGubbaVariant("moss"));

  // ---- Top-Down: the whole bed, and its front-left corner not under the HUD
  const top = await page.evaluate(() => {
    const api = window.__rakeMe!;
    api.setCamera("topdown");
    return {
      corners: [[-96, -56], [96, -56], [96, 56], [-96, 56]].map(([x, z]) => api.project(x!, 3, z!)),
      hud: api.overlayHits().filter((h) => h.action.type === "hud").map((h) => ({ x: h.x, y: h.y, w: h.w, h: h.h })),
      violations: api.paletteViolations(),
    };
  });
  expect(top.violations, `${tag} topdown`).toBe(0);
  for (const c of top.corners) {
    expect(c, `${tag} topdown bed corner`).not.toBeNull();
    expect(c!.x, `${tag} topdown bed corner x`).toBeGreaterThanOrEqual(BED_MARGIN);
    expect(c!.x, `${tag} topdown bed corner x`).toBeLessThanOrEqual(fb.fbW - BED_MARGIN);
    expect(c!.y, `${tag} topdown bed corner y`).toBeGreaterThanOrEqual(BED_MARGIN);
    expect(c!.y, `${tag} topdown bed corner y`).toBeLessThanOrEqual(fb.fbH - BED_MARGIN);
  }
  const hudRight = Math.max(...top.hud.map((h) => h.x + h.w));
  const hudTop = Math.min(...top.hud.map((h) => h.y));
  const frontLeft = top.corners[3]!;
  expect(frontLeft.x >= hudRight || frontLeft.y <= hudTop, `${tag} topdown: sand corner ${JSON.stringify(frontLeft)} under the HUD`).toBe(true);
  if (SCREENSHOTS.has(shot)) await page.screenshot({ path: `test-results/viewport-${shot}-topdown.png` });

  // ---- Overlay in both densities, from the default camera
  await page.evaluate(() => window.__rakeMe!.setCamera("cozy"));
  for (const density of ["crisp", "chunky"] as const) {
    await page.evaluate((d) => window.__rakeMe!.setDensity(d), density);
    await expectIntegerScale(page, `${tag} ${density}`);
    await expectOverlayTidy(page, `${tag} ${density}`);
    await expectControlsSized(page, `${tag} ${density}`);
    if (density === "chunky") {
      // the coarser framebuffer frames the same garden
      const chunky = await page.evaluate(() => ({ fb: window.__rakeMe!.fbSize(), bounds: window.__rakeMe!.pickBounds() }));
      expectInsideFrame(chunky.bounds.gubba, chunky.fb, `${tag} chunky Gubba`);
      expectInsideFrame(chunky.bounds.basket, chunky.fb, `${tag} chunky basket`);
      expectInsideFrame(chunky.bounds["rake:hoki"], chunky.fb, `${tag} chunky rake hoki`);
      expectInsideFrame(chunky.bounds["rake:onami"], chunky.fb, `${tag} chunky rake onami`);
      if (SCREENSHOTS.has(shot)) {
        await page.evaluate(() => window.__rakeMe!.openPanel("settings", "look"));
        await page.screenshot({ path: `test-results/viewport-${shot}-chunky-settings.png` });
        await page.evaluate(() => window.__rakeMe!.openPanel("none"));
      }
    }
  }
  await page.evaluate(() => window.__rakeMe!.setDensity("crisp"));
}

test.describe("a real phone: touch input at device pixel ratio 3", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });

  test("390x844 @3x: the prompt takes taps upright; on its side the garden is whole and a tapped rake is picked up", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));

    const prompt = page.locator("#rotate-prompt");
    await expect(prompt).toBeVisible();
    await page.touchscreen.tap(195, 420);
    await page.touchscreen.tap(60, 800);
    const upright = await page.evaluate(() => ({ state: window.__rakeMe!.state(), audio: window.__rakeMe!.audio.state }));
    expect(upright.state.rotateBlocked).toBe(true);
    expect(upright.state.panel).toBe("none");
    expect(upright.audio).toBe("locked");

    await page.setViewportSize({ width: 844, height: 390 });
    await expect(prompt).toBeHidden();
    await page.touchscreen.tap(422, 195);
    await expect(page.locator("#title-card")).toBeHidden();

    // every scene pixel is exactly k × k device pixels, and the canvas sits inside the window
    const scale = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.setMood("afternoon");
      api.advance(16);
      const canvas = document.getElementById("garden-canvas") as HTMLCanvasElement;
      const r = canvas.getBoundingClientRect();
      return { fb: api.fbSize(), dpr: window.devicePixelRatio, backing: canvas.width, cssW: r.width, right: r.right, bottom: r.bottom, win: [window.innerWidth, window.innerHeight] };
    });
    expect(scale.dpr).toBe(3);
    expect(scale.fb).toMatchObject({ fbW: 422, fbH: 195, scale: 6 });
    expect(scale.backing).toBe(scale.fb.fbW * scale.fb.scale);
    expect(scale.cssW * scale.dpr).toBeCloseTo(scale.backing, 3);
    expect(scale.right).toBeLessThanOrEqual(scale.win[0]! + 1e-6);
    expect(scale.bottom).toBeLessThanOrEqual(scale.win[1]! + 1e-6);

    const bounds = await page.evaluate(() => window.__rakeMe!.pickBounds());
    expectInsideFrame(bounds.gubba, scale.fb, "844x390 @3x Gubba");
    expectInsideFrame(bounds.basket, scale.fb, "844x390 @3x basket");
    expectInsideFrame(bounds["rake:hoki"], scale.fb, "844x390 @3x rake hoki");

    // a finger on a hanging rake picks it up: touch points map to the right framebuffer pixel at 3x
    const tap = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      const b = api.pickBounds()["rake:tetsu"]!;
      for (let y = b.minY; y <= b.maxY; y++) {
        for (let x = b.minX; x <= b.maxX; x++) {
          const p = api.pick(x + 0.5, y + 0.5);
          if (p.kind === "rake" && p.id === "tetsu") {
            return { x: rect.left + ((x + 0.5) / fbW) * rect.width, y: rect.top + ((y + 0.5) / fbH) * rect.height };
          }
        }
      }
      return null;
    });
    expect(tap).not.toBeNull();
    await page.touchscreen.tap(tap!.x, tap!.y);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe("tetsu");
    expect(await page.evaluate(() => window.__rakeMe!.paletteViolations())).toBe(0);
    expect(errors).toEqual([]);
  });
});

for (const vp of PHONES) {
  test.describe(`a phone on its side at its own pixel ratio: ${vp.width}x${vp.height} @${vp.dpr}x (${vp.name})`, () => {
    test.describe.configure({ timeout: 120_000 });
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr });

    test(`${vp.width}x${vp.height} @${vp.dpr}x: the controls are thumb-sized, panels open whole ${vp.panels} the HUD, and the garden stays framed`, async ({ page }) => {
      const errors = watchErrors(page);
      const tag = `${vp.width}x${vp.height}`;
      const shot = vp.shot ?? tag;
      await open(page, vp);
      await page.locator("#title-card").click();
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(vp.dpr);

      // the whole playable contract: framing in all three cameras, overlay complete in both densities
      await expectPlayable(page, vp);

      // every HUD object is a thumb's width, and the speech scroll keeps its 172 overlay pixels beside the block
      const m = await page.evaluate(() => {
        const api = window.__rakeMe!;
        api.setDensity("crisp");
        api.setCamera("cozy");
        api.openPanel("none");
        const fb = api.fbSize();
        const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
        const css = rect.width / fb.fbW;
        const hud = api.overlayHits().filter((h) => h.action.type === "hud");
        return {
          fb,
          wholeCss: [rect.left, rect.top, rect.width, rect.height].every((v) => Number.isInteger(v)),
          sides: hud.map((h) => h.w * css),
          hudRight: Math.max(...hud.map((h) => h.x + h.w)),
          hudTop: Math.min(...hud.map((h) => h.y)),
          scroll: api.speechRect(),
        };
      });
      for (const side of m.sides) expect(side, `${tag}: HUD object in CSS pixels`).toBeGreaterThanOrEqual(THUMB_CSS - 1e-6);
      expect(m.fb.uiScale, `${tag}: overlay scale`).toBeGreaterThan(1);
      expect(m.scroll.w / m.fb.uiScale, `${tag}: speech scroll width`).toBeCloseTo(172, 6);
      expect(m.scroll.x, `${tag}: speech scroll beside the HUD`).toBeGreaterThanOrEqual(m.hudRight);

      // each panel opens whole: above the HUD where there is room, to its right from the top of the window where not
      for (const [panel, tab] of [["settings", "look"], ["settings", "garden"], ["settings", "sound"], ["settings", "presets"], ["basket", "look"]] as const) {
        const p = await page.evaluate(
          ({ panel, tab }) => {
            const api = window.__rakeMe!;
            api.openPanel(panel, tab);
            const box = api.overlayHits().find((h) => h.action.type === "none")!;
            return { x: box.x, y: box.y, w: box.w, h: box.h, violations: api.paletteViolations() };
          },
          { panel, tab },
        );
        const where = `${tag} ${panel}/${tab}`;
        expect(p.violations, where).toBe(0);
        expect(p.y, where).toBeCloseTo(3 * m.fb.uiScale + ((m.fb.fbH * m.fb.scale) % Math.round(m.fb.uiScale * m.fb.scale)) / m.fb.scale, 6);
        if (vp.panels === "beside") {
          expect(p.x, `${where}: right of the HUD`).toBeCloseTo(m.hudRight + 3 * m.fb.uiScale, 6);
          expect(p.x + p.w, where).toBeLessThanOrEqual(m.fb.fbW - 3 * m.fb.uiScale + 1e-6);
          expect(p.y + p.h, where).toBeLessThanOrEqual(m.fb.fbH - 3 * m.fb.uiScale + 1e-6);
        } else {
          expect(p.x, `${where}: from the left margin`).toBeCloseTo(3 * m.fb.uiScale, 6);
          expect(p.y + p.h, `${where}: above the HUD`).toBeLessThanOrEqual(m.hudTop + 1e-6);
        }
        const suffix = panel === "basket" ? "basket" : tab === "look" ? "settings" : `settings-${tab}`;
        await page.screenshot({ path: `test-results/viewport-${shot}-${suffix}.png` });
      }

      // a real click on a chip in the panel lands on it: Top-Down on the Look tab
      const chip = await page.evaluate(() => {
        const api = window.__rakeMe!;
        api.openPanel("settings", "look");
        const { fbW } = api.fbSize();
        const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
        const css = rect.width / fbW;
        const h = api.overlayHits().find((x) => x.action.type === "settings" && (x.action as { patch: { cameraPreset?: string } }).patch.cameraPreset === "topdown")!;
        return { x: rect.left + (h.x + h.w / 2) * css, y: rect.top + (h.y + h.h / 2) * css, h: h.h * css };
      });
      expect(chip.h, `${tag}: a chip's height in CSS pixels`).toBeGreaterThanOrEqual(24);
      await page.mouse.click(chip.x, chip.y);
      expect(await page.evaluate(() => window.__rakeMe!.state().settings.cameraPreset), `${tag}: click on the Top-Down chip`).toBe("topdown");
      await page.evaluate(() => {
        window.__rakeMe!.setCamera("cozy");
        window.__rakeMe!.openPanel("none");
      });

      // on screen, an overlay pixel is one flat square of whole device pixels (where the emulation can show it)
      expect(m.wholeCss, `${tag}: canvas CSS box is whole pixels`).toBe(vp.dpr === 1 || (vp.width === 844 && vp.height === 390));
      if (m.wholeCss) await expectDeviceGrid(page, tag);
      expect(errors).toEqual([]);
    });
  });
}

test.describe("popular viewports: the whole garden stays on screen", () => {
  test.describe.configure({ timeout: 120_000 });

  for (const vp of PLAYABLE) {
    test(`${vp.width}x${vp.height} (${vp.name}): Gubba, basket, Wall of Rakes, bed and overlay inside the frame`, async ({ page }) => {
      const errors = watchErrors(page);
      await open(page, vp);

      // the title card sits inside the window with room to spare
      const card = (await page.locator("#title-card .card-box").boundingBox())!;
      expect(card.x).toBeGreaterThanOrEqual(16);
      expect(card.y).toBeGreaterThanOrEqual(16);
      expect(card.x + card.width).toBeLessThanOrEqual(vp.width - 16);
      expect(card.y + card.height).toBeLessThanOrEqual(vp.height - 16);
      expect(Math.abs(card.x + card.width / 2 - vp.width / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(card.y + card.height / 2 - vp.height / 2)).toBeLessThanOrEqual(1);
      await page.locator("#title-card").click();

      await expectPlayable(page, vp);
      expect(errors).toEqual([]);
    });
  }

  for (const vp of PORTRAIT_PHONES) {
    const turned: Viewport = { width: vp.height, height: vp.width, name: `${vp.name}, turned` };

    test(`${vp.width}x${vp.height} (${vp.name}): asks to turn sideways, then plays at ${turned.width}x${turned.height}`, async ({ page }) => {
      const errors = watchErrors(page);
      await open(page, vp);
      const tag = `${vp.width}x${vp.height}`;

      // ---- upright: a calm parchment dialog covers the garden
      const prompt = page.locator("#rotate-prompt");
      await expect(prompt).toBeVisible();
      await expect(prompt).toHaveAttribute("role", "dialog");
      await expect(prompt).toHaveAttribute("aria-modal", "true");
      await expect(prompt).toBeFocused();
      await expect(page.locator("#rotate-title")).toHaveText("TURN SIDEWAYS");
      await expect(page.locator("#rotate-text")).toContainText("Turn your screen on its side");
      const scrim = (await prompt.boundingBox())!;
      expect(scrim).toEqual({ x: 0, y: 0, width: vp.width, height: vp.height });
      const card = (await prompt.locator(".card-box").boundingBox())!;
      expect(card.x).toBeGreaterThanOrEqual(16);
      expect(card.y).toBeGreaterThanOrEqual(16);
      expect(card.x + card.width).toBeLessThanOrEqual(vp.width - 16);
      expect(card.y + card.height).toBeLessThanOrEqual(vp.height - 16);
      const art = (await prompt.locator(".rotate-art").boundingBox())!;
      expect(art.width).toBe(144);
      expect(art.height).toBe(96);
      expect(art.x).toBeGreaterThanOrEqual(card.x);
      expect(art.x + art.width).toBeLessThanOrEqual(card.x + card.width);
      const style = await prompt.locator(".card-box").evaluate((el) => {
        const cs = getComputedStyle(el);
        return { background: cs.backgroundColor, border: cs.borderTopColor, color: cs.color, shadow: cs.boxShadow };
      });
      expect(style.background).toBe("rgb(244, 234, 208)"); // paper #f4ead0
      expect(style.border).toBe("rgb(42, 29, 26)"); // ink #2a1d1a
      expect(style.color).toBe("rgb(42, 29, 26)");
      expect(style.shadow).toContain("rgb(42, 29, 26) 4px 4px 0px");
      // no external assets: the art is inline SVG rectangles
      expect(await prompt.locator("svg rect").count()).toBeGreaterThan(20);
      expect(await prompt.locator("img, image, use").count()).toBe(0);

      // the garden underneath is inert and takes no input
      await expect(page.locator("#stage")).toHaveAttribute("inert", "");
      await expect(page.locator("#title-card")).toHaveAttribute("inert", "");
      const before = await page.evaluate(() => ({
        hash: window.__rakeMe!.sandHash(),
        state: window.__rakeMe!.state(),
        audio: window.__rakeMe!.audio.state,
      }));
      expect(before.state.rotateBlocked).toBe(true);
      await page.mouse.move(vp.width * 0.3, vp.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(vp.width * 0.7, vp.height * 0.52, { steps: 6 });
      await page.mouse.up();
      await page.mouse.click(vp.width / 2, vp.height / 2);
      for (const key of ["Enter", "ArrowRight", "ArrowRight", "ArrowDown", "Enter", "c", "x", "p", "0"]) await page.keyboard.press(key);
      const after = await page.evaluate(() => ({
        hash: window.__rakeMe!.sandHash(),
        state: window.__rakeMe!.state(),
        audio: window.__rakeMe!.audio.state,
      }));
      expect(after.hash, "raking is blocked while upright").toBe(before.hash);
      expect(after.state.settings.cameraPreset).toBe(before.state.settings.cameraPreset);
      expect(after.state.settings.density).toBe(before.state.settings.density);
      expect(after.state.panel).toBe("none");
      expect(after.audio, "no audio unlock through the prompt").toBe("locked");
      await expect(prompt).toBeVisible();

      // the renderer keeps running cleanly behind it, in both densities
      for (const density of ["crisp", "chunky"] as const) {
        await page.evaluate((d) => window.__rakeMe!.setDensity(d), density);
        await expectIntegerScale(page, `${tag} ${density} (behind the prompt)`);
        const under = await page.evaluate(() => {
          const api = window.__rakeMe!;
          const { fbW, fbH } = api.fbSize();
          const out = { violations: 0, outside: 0 };
          for (const tab of ["look", "garden", "sound", "presets"] as const) {
            api.openPanel("settings", tab);
            out.violations += api.paletteViolations();
            out.outside += api.overlayHits().filter((h) => h.x < 0 || h.y < 0 || h.x + h.w > fbW || h.y + h.h > fbH).length;
          }
          api.openPanel("none");
          for (const cam of ["cozy", "topdown", "porch"] as const) {
            api.setCamera(cam);
            out.violations += api.paletteViolations();
          }
          api.setCamera("cozy");
          return out;
        });
        expect(under, `${tag} ${density}`).toEqual({ violations: 0, outside: 0 });
      }
      await page.evaluate(() => window.__rakeMe!.setDensity("crisp"));

      // the arrow's nudge stops for people who ask for less motion
      expect(await prompt.locator(".rotate-arrow").evaluate((el) => getComputedStyle(el).animationName)).toBe("rotate-nudge");
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await prompt.locator(".rotate-arrow").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
      await page.emulateMedia({ reducedMotion: "no-preference" });

      if (SCREENSHOTS.has(tag)) await page.screenshot({ path: `test-results/viewport-${tag}.png` });

      // ---- turned sideways: the prompt leaves on its own and the garden plays
      await page.setViewportSize({ width: turned.width, height: turned.height });
      await expect(prompt).toBeHidden();
      await expect(page.locator("#stage")).not.toHaveAttribute("inert", "");
      await expect(page.locator("#title-card")).toBeVisible();
      await page.locator("#title-card").click();
      await expect(page.locator("#title-card")).toBeHidden();
      await expectPlayable(page, turned);

      // ---- and upright again mid-session: the prompt returns, a held stroke is let go, nothing breaks
      const mid = await page.evaluate(() => {
        const api = window.__rakeMe!;
        const { fbW, fbH } = api.fbSize();
        const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
        const p = api.project(-20, 3, 10)!;
        return { x: rect.left + (p.x / fbW) * rect.width, y: rect.top + (p.y / fbH) * rect.height };
      });
      await page.mouse.move(mid.x, mid.y);
      await page.mouse.down();
      await page.mouse.move(mid.x + 40, mid.y + 6, { steps: 3 });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await expect(prompt).toBeVisible();
      await page.mouse.up();
      const again = await page.evaluate(() => {
        const api = window.__rakeMe!;
        api.advance(16); // the test clock is frozen, so draw one frame at the new size before reading it back
        return { state: api.state(), violations: api.paletteViolations() };
      });
      expect(again.state.rotateBlocked).toBe(true);
      expect(again.violations).toBe(0);

      expect(errors).toEqual([]);
    });
  }

  test("rotating sideways during model loading dismisses the prompt, and mid-drag rotation releases capture without unlocking audio", async ({
    page,
  }) => {
    // 1. Start upright with one GLB request delayed; rotate to landscape BEFORE models finish loading.
    await page.setViewportSize({ width: 390, height: 844 });
    let releaseGlb!: () => void;
    const glbGate = new Promise<void>((resolve) => {
      releaseGlb = resolve;
    });
    let intercepted = false;
    await page.route("**/assets/models/gubba_moss.glb", async (route) => {
      if (!intercepted) {
        intercepted = true;
        await glbGate;
      }
      await route.continue();
    });

    const nav = page.goto("?test=1");
    await expect(page.locator("#rotate-prompt")).toBeVisible();
    await expect(page.locator("#title-card")).toHaveAttribute("inert", "");
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator("#rotate-prompt")).toBeHidden();
    releaseGlb();
    await nav;
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    await expect(page.locator("#rotate-prompt")).toBeHidden();
    await expect(page.locator("#stage")).not.toHaveAttribute("inert", "");
    await expect(page.locator("#title-card")).not.toHaveAttribute("inert", "");
    await expect(page.locator("#title-card")).toBeFocused();

    // 2. Start an orbit drag at 768x1024 Porch and verify Gubba never clips across intermediate damped frames.
    await page.locator("#title-card").click();
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.setCamera("porch");
      api.setGubbaVariant("moss");
      api.advance(0);
    });
    await page.mouse.move(700, 300);
    await page.mouse.down();
    await page.mouse.move(500, 288, { steps: 3 });
    await page.mouse.up();
    const minGubbaMargin = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      let worst = Infinity;
      for (let i = 0; i < 25; i++) {
        api.advance(16);
        const g = api.pickBounds()["gubba"];
        if (!g) return -1;
        worst = Math.min(worst, g.minX, fbW - 1 - g.maxX, g.minY, fbH - 1 - g.maxY);
      }
      return worst;
    });
    expect(minGubbaMargin).toBeGreaterThanOrEqual(1);

    // 3. Mid-drag rotation releases explicit & implicit pointer captures and blocks subsequent move/up handling.
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(() => page.evaluate(() => {
      const f = window.__rakeMe!.fbSize();
      return f.cssW <= 844 && f.cssH <= 390 && f.fbW > f.fbH;
    })).toBe(true);
    await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.setCamera("cozy");
      api.advance(0);
    });
    const dragStart = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      const p = api.project(0, 3, 0)!;
      return { x: rect.left + (p.x / fbW) * rect.width, y: rect.top + (p.y / fbH) * rect.height };
    });
    await page.evaluate(() => {
      const c = document.getElementById("garden-canvas")!;
      const win = window as unknown as { __seenIds?: number[]; __lostIds?: number[] };
      win.__seenIds = [];
      win.__lostIds = [];
      c.addEventListener("pointerdown", (e) => win.__seenIds!.push(e.pointerId));
      c.addEventListener("lostpointercapture", (e) => win.__lostIds!.push(e.pointerId));
    });
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragStart.x + 6, dragStart.y);
    const capturedBefore = await page.evaluate(() => {
      const c = document.getElementById("garden-canvas")!;
      const id = (window as unknown as { __seenIds: number[] }).__seenIds.at(-1)!;
      return { id, has: c.hasPointerCapture(id) };
    });
    expect(capturedBefore.has).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#rotate-prompt")).toBeVisible();
    const capturedAfter = await page.evaluate((id) => {
      const c = document.getElementById("garden-canvas")!;
      return c.hasPointerCapture(id);
    }, capturedBefore.id);
    expect(capturedAfter).toBe(false);
    const hashAtRotate = await page.evaluate(() => window.__rakeMe!.sandHash());
    await page.mouse.move(dragStart.x + 60, dragStart.y + 10, { steps: 3 });
    await page.mouse.up();
    const afterBlocked = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(16); // test clock is frozen, so render one frame at the resized target before reading back
      return {
        rotateBlocked: api.state().rotateBlocked,
        sandHash: api.sandHash(),
        violations: api.paletteViolations(),
      };
    });
    expect(afterBlocked.rotateBlocked).toBe(true);
    expect(afterBlocked.sandHash).toBe(hashAtRotate);
    expect(afterBlocked.violations).toBe(0);

    // 4. Two-finger touch pinch: rotating upright releases BOTH implicit touch captures before either finger lifts.
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator("#rotate-prompt")).toBeHidden();
    await page.evaluate(() => {
      (window as unknown as { __seenIds: number[] }).__seenIds = [];
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 350, y: 180, id: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: 350, y: 180, id: 1 },
        { x: 480, y: 210, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: 355, y: 182, id: 1 },
        { x: 485, y: 212, id: 2 },
      ],
    });
    const touchCapturesBefore = await page.evaluate(() => {
      const c = document.getElementById("garden-canvas")!;
      const ids = (window as unknown as { __seenIds: number[] }).__seenIds.slice(-2);
      return { ids, captured: ids.map((id) => c.hasPointerCapture(id)) };
    });
    expect(touchCapturesBefore.ids).toHaveLength(2);
    expect(touchCapturesBefore.captured).toEqual([true, true]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#rotate-prompt")).toBeVisible();
    const touchCapturesAfter = await page.evaluate((ids) => {
      const c = document.getElementById("garden-canvas")!;
      return ids.map((id) => c.hasPointerCapture(id));
    }, touchCapturesBefore.ids);
    expect(touchCapturesAfter).toEqual([false, false]);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  });
});

// ---- An installed web app on a phone (iOS "Add to Home Screen"): background, foreground and a turning screen ----

/** Tells the page it went to the background or came back, the way a phone does (`document.hidden`, `visibilitychange`). */
async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

/** How far the canvas sticks out of the stage or the window, in CSS pixels; 0 when it lies wholly inside both. */
function canvasOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.getElementById("garden-canvas")!.getBoundingClientRect();
    const s = document.getElementById("stage")!.getBoundingClientRect();
    const right = Math.min(s.right, window.innerWidth);
    const bottom = Math.min(s.bottom, window.innerHeight);
    const out = Math.max(s.left - c.left, s.top - c.top, c.right - right, c.bottom - bottom, 0);
    // one layout unit of rounding at a fractional device pixel ratio, and a canvas that has not been sized at all
    return c.width > 0 && c.height > 0 ? (out <= 1 / 64 + 1e-6 ? 0 : out) : Infinity;
  });
}

test.describe("an installed phone app: back from the background with the screen turned", () => {
  test.use({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });

  test("on its side, to the background, upright, to the foreground, on its side again: the whole garden is back even while the stage is stale", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    await page.touchscreen.tap(422, 195);
    await expect(page.locator("#title-card")).toBeHidden();
    const prompt = page.locator("#rotate-prompt");
    const home = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.setMood("afternoon");
      api.setCamera("cozy");
      api.advance(16);
      return { fb: api.fbSize(), camera: api.state().camera, hash: api.sandHash() };
    });
    expect(home.fb).toMatchObject({ fbW: 422, fbH: 195, scale: 6 });

    // the page is pinned: there is nothing to scroll or rubber-band behind the stage
    const pinned = await page.evaluate(() => {
      window.scrollTo(0, 200);
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      return { scroll: [window.scrollX, window.scrollY], root: root.position, body: body.position, rootH: root.height, bodyH: body.height };
    });
    expect(pinned).toEqual({ scroll: [0, 0], root: "fixed", body: "fixed", rootH: "390px", bodyH: "390px" });

    // 1. To the background on its side; the phone is turned upright while the app is away, then it comes back.
    await setPageHidden(page, true);
    await page.setViewportSize({ width: 390, height: 844 });
    await setPageHidden(page, false);
    await expect(prompt).toBeVisible();
    expect(await canvasOverflow(page), "upright, behind the prompt").toBe(0);

    // 2. Turned on its side again. iOS leaves the fixed stage at its upright height for a while: here it stays.
    await page.evaluate(() => {
      const s = document.getElementById("stage")!.style;
      s.bottom = "auto";
      s.height = `${window.innerHeight}px`;
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(prompt).toBeHidden();
    const stale = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(16); // the test clock is frozen, so draw one frame at the new size before reading it back
      const stage = document.getElementById("stage")!;
      const { fbW, fbH } = api.fbSize();
      return {
        stage: [stage.clientWidth, stage.clientHeight],
        win: [window.innerWidth, window.innerHeight],
        fb: api.fbSize(),
        state: api.state(),
        bounds: api.pickBounds(),
        hud: api.overlayHits().filter((h) => h.action.type === "hud"),
        outside: api.overlayHits().filter((h) => h.x < 0 || h.y < 0 || h.x + h.w > fbW || h.y + h.h > fbH).length,
        violations: api.paletteViolations(),
      };
    });
    expect(stale.stage, "the stage really is stale: an upright phone's height on a screen lying on its side").toEqual([844, 844]);
    expect(stale.win).toEqual([844, 390]);
    expect(await canvasOverflow(page), "canvas inside the stage and the window").toBe(0);
    expect(stale.fb, "the same framebuffer as before the app went away").toEqual(home.fb);
    expect(stale.state.rotateBlocked).toBe(false);
    expect(stale.state.camera).toEqual(home.camera);
    expect(stale.violations).toBe(0);
    expect(stale.hud).toHaveLength(6);
    expect(stale.outside, "overlay controls outside the framebuffer").toBe(0);
    expectInsideFrame(stale.bounds.gubba, stale.fb, "stale stage: Gubba");
    expectInsideFrame(stale.bounds.basket, stale.fb, "stale stage: basket");
    for (const id of RAKES) {
      if (id !== stale.state.settings.rake) expectInsideFrame(stale.bounds[`rake:${id}`], stale.fb, `stale stage: rake ${id}`);
    }
    await expectIntegerScale(page, "stale stage");
    await page.screenshot({ path: "test-results/viewport-resume-stale-stage.png" });

    // 3. The stage settles late, with no window event at all: nothing moves, and the garden plays under a finger.
    await page.evaluate(() => {
      const s = document.getElementById("stage")!.style;
      s.bottom = "";
      s.height = "";
    });
    await expect.poll(() => page.evaluate(() => document.getElementById("stage")!.clientHeight)).toBe(390);
    await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 450))); // past the last settle look
    expect(await canvasOverflow(page), "settled").toBe(0);
    const settled = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(16);
      return { fb: api.fbSize(), state: api.state(), violations: api.paletteViolations(), hash: api.sandHash() };
    });
    expect(settled.fb).toEqual(home.fb);
    expect(settled.state.rotateBlocked).toBe(false);
    expect(settled.state.camera).toEqual(home.camera);
    expect(settled.violations).toBe(0);
    expect(settled.hash, "nothing was raked along the way").toBe(home.hash);
    await expectOverlayTidy(page, "after the resume");

    const stroke = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      const at = (x: number, z: number): { x: number; y: number } => {
        const p = api.project(x, 3, z)!;
        return { x: rect.left + (p.x / fbW) * rect.width, y: rect.top + (p.y / fbH) * rect.height };
      };
      return { from: at(-40, 0), to: at(40, 6) };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...stroke.from, id: 1 }] });
    for (let i = 1; i <= 6; i++) {
      const t = i / 6;
      const p = { x: stroke.from.x + (stroke.to.x - stroke.from.x) * t, y: stroke.from.y + (stroke.to.y - stroke.from.y) * t };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...p, id: 1 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const raked = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(16);
      return { hash: api.sandHash(), camera: api.state().camera, violations: api.paletteViolations() };
    });
    expect(raked.hash, "a finger rakes the sand after the resume").not.toBe(home.hash);
    expect(raked.camera).toEqual(home.camera);
    expect(raked.violations).toBe(0);
    expect(errors).toEqual([]);
  });

  test("every way back to the foreground looks again after the layout settles, without ResizeObserver or a resize event", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.addInitScript(() => {
      delete (window as { ResizeObserver?: unknown }).ResizeObserver;
    });
    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    await page.touchscreen.tap(422, 195);
    expect(await page.evaluate(() => typeof ResizeObserver)).toBe("undefined");

    // The safe-area insets arrive just after the app is told it is back; nothing announces them.
    const WAKES = [
      { type: "visibilitychange", inset: 47 },
      { type: "pageshow", inset: 0 },
      { type: "focus", inset: 59 },
      { type: "orientationchange", inset: 21 },
    ] as const;
    for (const wake of WAKES) {
      const staleRightAfter = await page.evaluate(({ type, inset }) => {
        const stage = document.getElementById("stage")!;
        (type === "visibilitychange" ? document : window).dispatchEvent(new Event(type));
        stage.style.left = stage.style.right = `${inset}px`;
        const c = document.getElementById("garden-canvas")!.getBoundingClientRect();
        const s = stage.getBoundingClientRect();
        return Math.abs(c.width - s.width) > 8;
      }, wake);
      expect(staleRightAfter, `${wake.type}: the canvas is not yet fitted to the new stage`).toBe(true);
      await expect
        .poll(() => page.evaluate(() => {
          const stage = document.getElementById("stage")!;
          const fb = window.__rakeMe!.fbSize();
          // fitted: inside the stage, and using all of it but less than one scene pixel
          return fb.cssW <= stage.clientWidth && stage.clientWidth - fb.cssW < fb.scale / window.devicePixelRatio + 1;
        }), { message: `${wake.type}: fitted once the layout settled`, timeout: 2000 })
        .toBe(true);
      expect(await canvasOverflow(page), wake.type).toBe(0);
      const drawn = await page.evaluate(() => {
        const api = window.__rakeMe!;
        api.advance(16);
        return { violations: api.paletteViolations(), blocked: api.state().rotateBlocked, gubba: api.pickBounds().gubba, fb: api.fbSize() };
      });
      expect(drawn.violations, wake.type).toBe(0);
      expect(drawn.blocked, wake.type).toBe(false);
      expectInsideFrame(drawn.gubba, drawn.fb, `${wake.type}: Gubba`);
    }
    expect(errors).toEqual([]);
  });

  test("a GPU context dropped in the background is handed back and the garden draws the same frame", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    await page.touchscreen.tap(422, 195);
    const before = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.setMood("afternoon");
      api.loadPreset("three_islands");
      // Carve an incremental dirty-rect stroke so heightTex.image.data is stale before context loss,
      // verifying webglcontextrestored forces a full sand upload (`sandReset = true`).
      api.stroke([
        { x: 24, y: 24 },
        { x: 64, y: 24 },
        { x: 96, y: 40 },
      ]);
      api.advance(16);
      return { frame: api.frameHash(), sand: api.sandHash(), fb: api.fbSize(), violations: api.paletteViolations() };
    });
    expect(before.violations).toBe(0);

    const after = await page.evaluate(async () => {
      const api = window.__rakeMe!;
      const canvas = document.getElementById("garden-canvas") as HTMLCanvasElement;
      const gl = canvas.getContext("webgl2")!;
      const ext = gl.getExtension("WEBGL_lose_context")!;
      const once = (type: string): Promise<Event> => new Promise((done) => canvas.addEventListener(type, done, { once: true }));
      const lost = once("webglcontextlost");
      ext.loseContext();
      const lostEvent = await lost;
      api.advance(0); // a frame asked for while the context is gone must not throw
      // the browser allows a restore only once the lost event has been delivered to every listener
      await new Promise((done) => setTimeout(done, 0));
      const restored = once("webglcontextrestored");
      ext.restoreContext();
      await restored;
      api.advance(0); // the clock has not moved, so the frame must be the one drawn before the loss
      return {
        kept: lostEvent.defaultPrevented,
        lost: gl.isContextLost(),
        frame: api.frameHash(),
        sand: api.sandHash(),
        fb: api.fbSize(),
        violations: api.paletteViolations(),
        failed: api.failedModels().length,
      };
    });
    expect(after.kept, "the canvas asks to be given its context back").toBe(true);
    expect(after.lost).toBe(false);
    expect(after.fb).toEqual(before.fb);
    expect(after.sand).toBe(before.sand);
    expect(after.violations).toBe(0);
    expect(after.failed).toBe(0);
    expect(after.frame, "the restored context draws the same frame").toBe(before.frame);
    expect(await canvasOverflow(page)).toBe(0);
    expect(errors).toEqual([]);
  });
});

test.describe("the running garden, outside test mode", () => {
  test("with every resize and orientation event swallowed, the frame loop alone shows the prompt, hides it and keeps the canvas on screen", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    // iOS WebKit sometimes sends nothing at all when an installed app turns: swallow every signal but the frames
    await page.addInitScript(() => {
      delete (window as { ResizeObserver?: unknown }).ResizeObserver;
      const swallow = (ev: Event): void => ev.stopImmediatePropagation();
      for (const type of ["resize", "orientationchange", "pageshow", "focus"]) window.addEventListener(type, swallow, true);
      window.visualViewport?.addEventListener("resize", swallow, true);
      window.visualViewport?.addEventListener("scroll", swallow, true);
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto("./");
    const canvas = page.locator("#garden-canvas");
    const sized = (): Promise<{ w: number; h: number; backing: number[] }> =>
      canvas.evaluate((c: HTMLCanvasElement) => {
        const r = c.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), backing: [c.width, c.height] };
      });
    await expect.poll(async () => (await sized()).w, { timeout: 20_000 }).toBeGreaterThan(800);
    expect(await page.evaluate(() => "__rakeMe" in window), "a production page without ?test=1 has no test hooks").toBe(false);
    await page.locator("#title-card").click();
    const prompt = page.locator("#rotate-prompt");
    await expect(prompt).toBeHidden();
    const landscape = await sized();

    // upright: no event reaches the page, yet the prompt comes up and the canvas follows the window
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(prompt).toBeVisible();
    await expect.poll(async () => (await sized()).w).toBeLessThanOrEqual(390);
    expect(await canvasOverflow(page), "upright").toBe(0);

    // on its side again with the stage stuck at its upright height: the prompt leaves and nothing is cut off
    await page.evaluate(() => {
      const s = document.getElementById("stage")!.style;
      s.bottom = "auto";
      s.height = `${window.innerHeight}px`;
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(prompt).toBeHidden();
    await expect.poll(sized).toEqual(landscape);
    expect(await page.evaluate(() => document.getElementById("stage")!.clientHeight)).toBe(844);
    expect(await canvasOverflow(page), "on its side, stage stale").toBe(0);

    // a late inset with nothing to announce it
    await page.evaluate(() => {
      const s = document.getElementById("stage")!.style;
      s.bottom = "";
      s.height = "";
      s.left = s.right = "47px";
    });
    await expect.poll(async () => (await sized()).w).toBeLessThanOrEqual(750);
    expect(await canvasOverflow(page), "inset").toBe(0);
    expect(errors).toEqual([]);
  });
});
