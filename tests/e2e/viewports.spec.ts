import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Popular real-world windows, driven in real Chromium WebGL2 (DESIGN.md 2.4, 10.3). Every playable window must
// show the whole garden — bed, Wall of Rakes, Gubba, stone basket — with nothing touching the frame edge, keep
// every HUD and panel control inside the framebuffer, and scale by a whole number. An upright phone gets the
// turn-sideways prompt instead and plays once it is turned.

interface Viewport {
  width: number;
  height: number;
  name: string;
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

const PORTRAIT_PHONES: readonly Viewport[] = [
  { width: 390, height: 844, name: "phone portrait" },
  { width: 360, height: 800, name: "Android portrait" },
];

/** Sizes whose screenshots are kept in test-results/ for a human to look at. */
const SCREENSHOTS = new Set(["1440x900", "1024x768", "768x1024", "640x720", "844x390", "390x844"]);

const VARIANTS = ["moss", "kasa", "lantern"] as const;
const RAKES = ["sugi", "onami", "kinu", "hisui", "mikazuki", "tetsu", "wa", "take", "nagi", "hoki"] as const;
const TABS = ["look", "garden", "sound", "presets"] as const;
/** Controls each Settings tab offers (Gubba + mood + camera + pixels, and so on). */
const TAB_CONTROLS: Readonly<Record<(typeof TABS)[number], number>> = { look: 13, garden: 12, sound: 34, presets: 10 };
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

/** The canvas is a whole multiple of the framebuffer, sits wholly inside the window, and wastes under one pixel. */
async function expectIntegerScale(page: Page, label: string): Promise<void> {
  const s = await page.evaluate(() => {
    const api = window.__rakeMe!;
    const canvas = document.getElementById("garden-canvas") as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    return {
      fb: api.fbSize(),
      backing: { w: canvas.width, h: canvas.height },
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      win: { w: window.innerWidth, h: window.innerHeight },
    };
  });
  expect(Number.isInteger(s.fb.scale) && s.fb.scale >= 1, label).toBe(true);
  expect(s.backing, label).toEqual({ w: s.fb.fbW * s.fb.scale, h: s.fb.fbH * s.fb.scale });
  expect(s.rect.width, label).toBe(s.fb.fbW * s.fb.scale);
  expect(s.rect.height, label).toBe(s.fb.fbH * s.fb.scale);
  // nothing is cropped: the canvas lies inside the window on whole pixels
  expect(Number.isInteger(s.rect.left) && Number.isInteger(s.rect.top), label).toBe(true);
  expect(s.rect.left, label).toBeGreaterThanOrEqual(0);
  expect(s.rect.top, label).toBeGreaterThanOrEqual(0);
  expect(s.rect.right, label).toBeLessThanOrEqual(s.win.w);
  expect(s.rect.bottom, label).toBeLessThanOrEqual(s.win.h);
  // and the border left over is thinner than one scene pixel
  expect(s.win.w - s.rect.width, label).toBeLessThan(s.fb.scale);
  expect(s.win.h - s.rect.height, label).toBeLessThan(s.fb.scale);
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
      counts[tab] = hits.filter((h) => ["settings", "preset", "watch", "export"].includes(h.action.type)).length;
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
 * window's shorter side, the overlay's pixels are whole device pixels no finer than the scene's, and what the
 * present pass draws is what a real click hits.
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
    expect(w! / m.short, `${label}: HUD object ${w} CSS px of ${m.short}`).toBeLessThanOrEqual(0.14);
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

  if (SCREENSHOTS.has(tag)) await page.screenshot({ path: `test-results/viewport-${tag}.png` });

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
  if (SCREENSHOTS.has(tag)) await page.screenshot({ path: `test-results/viewport-${tag}-porch.png` });
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
  if (SCREENSHOTS.has(tag)) await page.screenshot({ path: `test-results/viewport-${tag}-topdown.png` });

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
      if (SCREENSHOTS.has(tag)) {
        await page.evaluate(() => window.__rakeMe!.openPanel("settings", "look"));
        await page.screenshot({ path: `test-results/viewport-${tag}-chunky-settings.png` });
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
