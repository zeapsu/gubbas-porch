import { expect, test } from "@playwright/test";
import type { CDPSession, Page } from "@playwright/test";
import { HAPTIC_PATTERNS, HAPTIC_SWITCH_ID, STONE_BRUSH_COOLDOWN_MS } from "../../src/ui/haptics.ts";

test.use({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

async function pickCenterClient(page: Page, key: string): Promise<{ x: number; y: number }> {
  const pt = await page.evaluate((k) => {
    const api = window.__rakeMe!;
    const b = api.pickBounds()[k];
    if (!b) return null;
    const { fbW, fbH } = api.fbSize();
    const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
    const [wantKind, wantId] = k.includes(":") ? k.split(":") : [k, undefined];
    const matches = (x: number, y: number): boolean => {
      const p = api.pick(x, y);
      return p.kind === wantKind && (wantId === undefined || p.id === wantId);
    };
    // Find the pixel of the target closest to its bounding-box center so T-shaped rakes never miss on the wall
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    let bestX = -1;
    let bestY = -1;
    let bestD = Infinity;
    for (let y = b.minY; y <= b.maxY; y++) {
      for (let x = b.minX; x <= b.maxX; x++) {
        if (!matches(x, y)) continue;
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d < bestD) {
          bestD = d;
          bestX = x;
          bestY = y;
        }
      }
    }
    if (bestX < 0) return null;
    return {
      x: rect.left + ((bestX + 0.5) / fbW) * rect.width,
      y: rect.top + ((bestY + 0.5) / fbH) * rect.height,
    };
  }, key);
  expect(pt, `pick target ${key} must be visible`).not.toBeNull();
  return pt!;
}

type Pt = { x: number; y: number };

/** Client (CSS pixel) position of a sand grid cell under the current camera. */
async function sandClient(page: Page, gx: number, gy: number): Promise<Pt> {
  return page.evaluate(
    ([x, y]) => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      const p = api.project(x! - 96, 3, y! - 56)!;
      return { x: rect.left + (p.x / fbW) * rect.width, y: rect.top + (p.y / fbH) * rect.height };
    },
    [gx, gy],
  );
}

/** Puts one finger down at the first point and slides it through the rest; the finger stays down. */
async function touchSlide(cdp: CDPSession, id: number, pts: readonly Pt[]): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...pts[0]!, id }] });
  for (const p of pts.slice(1)) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...p, id }] });
  }
}

/**
 * Chrome holds a touch move back until the next animation frame, so state read straight after a move can miss
 * it. Waiting two frames lets every move sent so far reach the page while the finger is still down.
 */
async function flushMoves(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function touchLift(cdp: CDPSession): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

function lerp(a: Pt, b: Pt, steps: number): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / steps,
    y: a.y + ((b.y - a.y) * i) / steps,
  }));
}

const sandHash = (page: Page): Promise<number> => page.evaluate(() => window.__rakeMe!.sandHash());
const cameraOf = (page: Page) => page.evaluate(() => window.__rakeMe!.state().camera);

/**
 * A point on the wall with nothing pickable within `clearFb` framebuffer pixels and well away from the bed and
 * the HUD: a touch there can only orbit.
 */
async function emptyWallClient(page: Page, clearFb: number): Promise<Pt> {
  const pt = await page.evaluate((clear) => {
    const api = window.__rakeMe!;
    const { fbW, fbH } = api.fbSize();
    const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
    const bounds = Object.values(api.pickBounds());
    const hits = api.overlayHits();
    for (let y = Math.floor(fbH * 0.12); y < Math.floor(fbH * 0.4); y += 3) {
      for (let x = Math.floor(fbW * 0.12); x < Math.floor(fbW * 0.88); x += 3) {
        if (bounds.some((b) => x >= b.minX - clear && x <= b.maxX + clear && y >= b.minY - clear && y <= b.maxY + clear)) continue;
        if (hits.some((h) => x >= h.x - clear && x < h.x + h.w + clear && y >= h.y - clear && y < h.y + h.h + clear)) continue;
        const sp = api.sandPoint(x, y);
        if (sp && sp.x > -30 && sp.x < 222 && sp.y > -30 && sp.y < 142) continue;
        return { x: rect.left + ((x + 0.5) / fbW) * rect.width, y: rect.top + ((y + 0.5) / fbH) * rect.height };
      }
    }
    return null;
  }, clearFb);
  expect(pt, "an empty stretch of wall must exist").not.toBeNull();
  return pt!;
}

async function touchTap(cdp: CDPSession, x: number, y: number, id = 1): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Every pattern the stubbed `navigator.vibrate` was asked to play, in order and unflattened. */
type Vibes = (number | number[])[];
type VibeWindow = { __vibes: Vibes; __vibeTimes: number[] };

const vibesOf = (page: Page): Promise<Vibes> =>
  page.evaluate(() => [...(window as unknown as VibeWindow).__vibes]);

async function clearVibes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as VibeWindow;
    w.__vibes.length = 0;
    w.__vibeTimes.length = 0;
  });
}

type OverlayTarget = { type: "hud"; id: string } | { type: "place"; kind: string };

/** Client (CSS pixel) centre of a HUD icon or a basket chip. */
async function overlayClient(page: Page, target: OverlayTarget): Promise<Pt> {
  const pt = await page.evaluate((want) => {
    const api = window.__rakeMe!;
    const hit = api.overlayHits().find((h) => {
      const a = h.action;
      if (want.type === "hud") return a.type === "hud" && a.id === want.id;
      return a.type === "place" && a.kind === want.kind;
    });
    if (!hit) return null;
    const { fbW, fbH } = api.fbSize();
    const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
    return {
      x: rect.left + ((hit.x + hit.w / 2) / fbW) * rect.width,
      y: rect.top + ((hit.y + hit.h / 2) / fbH) * rect.height,
    };
  }, target);
  expect(pt, `overlay control ${JSON.stringify(target)} must be on screen`).not.toBeNull();
  return pt!;
}

async function enterGarden(page: Page): Promise<CDPSession> {
  await page.goto("?test=1");
  await page.waitForFunction(() => Boolean(window.__rakeMe));
  await page.locator("#title-card").tap();
  await page.evaluate(() => {
    const api = window.__rakeMe!;
    api.loadPreset("still_sand");
    api.setCamera("cozy");
    api.advance(0);
  });
  return page.context().newCDPSession(page);
}

/** Opens the basket, picks the small stone and drags a thumb across the sand to set it down. */
async function touchPlaceStone(page: Page, cdp: CDPSession, gx: number, gy: number, id: number): Promise<void> {
  const basket = await pickCenterClient(page, "basket");
  await touchTap(cdp, basket.x, basket.y, id);
  await page.evaluate(() => window.__rakeMe!.advance(0));
  const chip = await overlayClient(page, { type: "place", kind: "stone_s" });
  await touchTap(cdp, chip.x, chip.y, id + 1);
  await page.evaluate(() => window.__rakeMe!.advance(0));
  await touchSlide(cdp, id + 2, [await sandClient(page, gx - 20, gy - 6), await sandClient(page, gx, gy)]);
  await touchLift(cdp);
  await page.evaluate(() => window.__rakeMe!.advance(0));
}

test.describe("Gubba's Porch — mobile & touch controls", () => {
  test.beforeEach(async ({ page }) => {
    // An Android-like browser: `navigator.vibrate` exists and records each pattern it is asked to play
    await page.addInitScript(() => {
      const w = window as unknown as VibeWindow;
      w.__vibes = [];
      w.__vibeTimes = [];
      Object.defineProperty(navigator, "vibrate", {
        configurable: true,
        value: (pattern: number | number[]) => {
          w.__vibes.push(Array.isArray(pattern) ? [...pattern] : pattern);
          w.__vibeTimes.push(performance.now());
          return true;
        },
      });
    });
  });

  test("Wall of Rakes: touch tap selects, hold previews description with haptics, swipe cancels, Hoki hold sweeps, contextmenu blocked", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    await page.locator("#title-card").tap();
    await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.setCamera("cozy");
      api.advance(30_000);
      (window as unknown as VibeWindow).__vibes.length = 0;
    });

    const cdp = await page.context().newCDPSession(page);

    // 1. Quick touch tap on Tetsu selects it immediately with the "select" haptic.
    const tetsu = await pickCenterClient(page, "rake:tetsu");
    await touchTap(cdp, tetsu.x, tetsu.y, 1);
    const afterTap = await page.evaluate(() => ({
      rake: window.__rakeMe!.state().settings.rake,
      vibes: [...(window as unknown as VibeWindow).__vibes],
    }));
    expect(afterTap.rake).toBe("tetsu");
    expect(afterTap.vibes).toEqual([HAPTIC_PATTERNS.select]);

    // 2. Touch hold (>= 350 ms) on Onami previews its description in the speech scroll & sr-live with the "preview" haptic,
    //    and releasing does NOT replace the active rake (tetsu remains active).
    await page.evaluate(() => {
      (window as unknown as VibeWindow).__vibes.length = 0;
    });
    const onami = await pickCenterClient(page, "rake:onami");
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: onami.x, y: onami.y, id: 2 }],
    });
    const duringHold = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(400);
      return {
        rake: api.state().settings.rake,
        speech: api.state().speech,
        live: (document.getElementById("sr-live")?.textContent ?? "").trim(),
        vibes: [...(window as unknown as VibeWindow).__vibes],
        violations: api.paletteViolations(),
      };
    });
    expect(duringHold.rake).toBe("tetsu");
    expect(duringHold.speech).toMatch(/Ōnami/);
    expect(duringHold.live).toMatch(/Ōnami/);
    expect(duringHold.vibes).toEqual([HAPTIC_PATTERNS.preview]);
    expect(duringHold.violations).toBe(0);

    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // After lifting thumb, active rake stays tetsu and description lingers briefly, then expires.
    const afterRelease = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(500);
      const lingered = api.state().speech;
      api.advance(3000);
      return {
        rake: api.state().settings.rake,
        lingered,
        afterExpire: api.state().speech,
      };
    });
    expect(afterRelease.rake).toBe("tetsu");
    expect(afterRelease.lingered).toMatch(/Ōnami/);
    expect(afterRelease.afterExpire ?? "").not.toMatch(/Ōnami/);

    // 3. Sliding thumb > 16 px during touch hold cancels cleanly (and clears an already-open preview too).
    const hisui = await pickCenterClient(page, "rake:hisui");
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: hisui.x, y: hisui.y, id: 3 }],
    });
    await page.evaluate(() => window.__rakeMe!.advance(400));
    expect(await page.evaluate(() => window.__rakeMe!.state().speech)).toMatch(/Hisui/);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: hisui.x + 30, y: hisui.y + 10, id: 3 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.evaluate(() => window.__rakeMe!.advance(16));
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe("tetsu");
    expect(await page.evaluate(() => window.__rakeMe!.state().speech ?? "")).not.toMatch(/Hisui/);

    // 3b. A real-time hold > 350 ms that releases BEFORE any render frame runs still previews instead of selecting.
    await page.evaluate(() => {
      (window as unknown as VibeWindow).__vibes.length = 0;
    });
    const kinu = await pickCenterClient(page, "rake:kinu");
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: kinu.x, y: kinu.y, id: 31 }],
    });
    await page.waitForTimeout(380);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.evaluate(() => window.__rakeMe!.advance(0));
    const betweenFrames = await page.evaluate(() => ({
      rake: window.__rakeMe!.state().settings.rake,
      speech: window.__rakeMe!.state().speech,
      vibes: [...(window as unknown as VibeWindow).__vibes],
    }));
    expect(betweenFrames.rake).toBe("tetsu");
    expect(betweenFrames.speech).toMatch(/Kinu/);
    expect(betweenFrames.vibes).toEqual([HAPTIC_PATTERNS.preview]);

    // 4. Touch hold on Hoki: shows description; sliding away or touchCancel cancels sweep & clears preview; >= 800 ms sweeps with the "sweep" haptic.
    const hashBeforeSweep = await page.evaluate(() => window.__rakeMe!.sandHash());
    const hoki = await pickCenterClient(page, "rake:hoki");
    // 4a. Slide away cancels Hoki sweep and clears preview
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: hoki.x, y: hoki.y, id: 4 }],
    });
    await page.evaluate(() => window.__rakeMe!.advance(200));
    expect(await page.evaluate(() => window.__rakeMe!.state().speech)).toMatch(/Hōki.*hold to sweep/);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: hoki.x - 32, y: hoki.y + 12, id: 4 }],
    });
    await page.evaluate(() => window.__rakeMe!.advance(1000));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.evaluate(() => window.__rakeMe!.advance(3000));
    expect(await page.evaluate(() => window.__rakeMe!.sandHash())).toBe(hashBeforeSweep);
    expect(await page.evaluate(() => window.__rakeMe!.state().speech ?? "")).not.toMatch(/Hōki/);

    // 4b. touchCancel on Hoki clears preview cleanly
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: hoki.x, y: hoki.y, id: 41 }],
    });
    await page.evaluate(() => window.__rakeMe!.advance(100));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await page.evaluate(() => window.__rakeMe!.advance(16));
    expect(await page.evaluate(() => window.__rakeMe!.state().speech ?? "")).not.toMatch(/Hōki/);

    // 4c. Steady >= 800 ms hold triggers smooth-all sweep + the "sweep" double beat
    await page.evaluate(() => {
      (window as unknown as VibeWindow).__vibes.length = 0;
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: hoki.x, y: hoki.y, id: 5 }],
    });
    const afterHokiSweep = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(900);
      const vibes = [...(window as unknown as VibeWindow).__vibes];
      api.advance(3000);
      return { vibes, sandHash: api.sandHash() };
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(afterHokiSweep.vibes).toEqual([HAPTIC_PATTERNS.sweep]);
    expect(afterHokiSweep.sandHash).not.toBe(hashBeforeSweep);

    // 5. Long-press browser contextmenu is suppressed on the canvas.
    const ctxPrevented = await page.evaluate(() => {
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.getElementById("garden-canvas")!.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(ctxPrevented).toBe(true);
    expect(errors).toEqual([]);
  });

  test("Touch raking, two-finger pinch/orbit (no jump on lift), touch drag-to-place/move/remove stones, and reduced-motion haptics", async ({
    page,
  }) => {
    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    await page.locator("#title-card").tap();
    await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.loadPreset("still_sand");
      api.setCamera("cozy");
      api.advance(0);
    });

    const cdp = await page.context().newCDPSession(page);

    // 1. Touch drag across sand carves grooves while holding the camera completely still; Undo restores exact hash.
    const sandPts = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      const toClient = (wx: number, wz: number) => {
        const p = api.project(wx, 3, wz)!;
        return { x: rect.left + (p.x / fbW) * rect.width, y: rect.top + (p.y / fbH) * rect.height };
      };
      return { start: toClient(-40, 10), end: toClient(40, 15) };
    });
    const hashBefore = await page.evaluate(() => window.__rakeMe!.sandHash());
    const camBeforeRake = await page.evaluate(() => window.__rakeMe!.state().camera);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: sandPts.start.x, y: sandPts.start.y, id: 10 }],
    });
    for (let i = 1; i <= 6; i++) {
      const t = i / 6;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: sandPts.start.x + (sandPts.end.x - sandPts.start.x) * t,
            y: sandPts.start.y + (sandPts.end.y - sandPts.start.y) * t,
            id: 10,
          },
        ],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const afterRake = await page.evaluate(() => ({
      hash: window.__rakeMe!.sandHash(),
      cam: window.__rakeMe!.state().camera,
    }));
    expect(afterRake.hash).not.toBe(hashBefore);
    expect(afterRake.cam.az).toBeCloseTo(camBeforeRake.az, 5);
    expect(afterRake.cam.el).toBeCloseTo(camBeforeRake.el, 5);
    expect(await page.evaluate(() => { window.__rakeMe!.undo(); return window.__rakeMe!.sandHash(); })).toBe(hashBefore);

    // 2. Two-finger pinch + orbit moves camera smoothly, and lifting the first finger while the second finger
    //    (orbitDrag.pointerId) stays down and moves stops orbit cleanly with zero camera jump.
    await page.evaluate(() => {
      const c = document.getElementById("garden-canvas")!;
      const ids: number[] = [];
      (window as unknown as { __touchIds: number[] }).__touchIds = ids;
      c.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "touch") ids.push(e.pointerId);
      });
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 320, y: 180, id: 20 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: 320, y: 180, id: 20 },
        { x: 520, y: 200, id: 21 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: 280, y: 165, id: 20 },
        { x: 560, y: 215, id: 21 },
      ],
    });
    await page.evaluate(() => window.__rakeMe!.advance(600));
    const camAfterPinch = await page.evaluate(() => window.__rakeMe!.state().camera);
    expect(Math.abs(camAfterPinch.dist - camBeforeRake.dist)).toBeGreaterThan(8);

    // Lift the first touch contact while the second contact (which owns orbitDrag.pointerId) stays down and moves:
    // verify pointerup + pointermove (no new pointerdown) and zero camera jump.
    const pinchTrace = await page.evaluate(() => {
      const c = document.getElementById("garden-canvas")!;
      const ids = (window as unknown as { __touchIds: number[] }).__touchIds.slice(-2);
      const firstId = ids[0]!;
      const secondId = ids[1]!;
      const log: string[] = [];
      const onDown = () => log.push("down");
      const onUp = () => log.push("up");
      const onMove = () => log.push("move");
      c.addEventListener("pointerdown", onDown);
      c.addEventListener("pointerup", onUp);
      c.addEventListener("pointermove", onMove);
      c.dispatchEvent(new PointerEvent("pointerup", { pointerId: firstId, pointerType: "touch", clientX: 280, clientY: 165, bubbles: true }));
      c.dispatchEvent(new PointerEvent("pointermove", { pointerId: secondId, pointerType: "touch", clientX: 420, clientY: 120, bubbles: true }));
      c.dispatchEvent(new PointerEvent("pointerup", { pointerId: secondId, pointerType: "touch", clientX: 420, clientY: 120, bubbles: true }));
      c.removeEventListener("pointerdown", onDown);
      c.removeEventListener("pointerup", onUp);
      c.removeEventListener("pointermove", onMove);
      return log;
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(pinchTrace).toEqual(["up", "move", "up"]);
    await page.evaluate(() => window.__rakeMe!.advance(400));
    const camAfterSingleLift = await page.evaluate(() => window.__rakeMe!.state().camera);
    expect(camAfterSingleLift.az).toBeCloseTo(camAfterPinch.az, 2);

    // 3. Touch stone basket -> drag-to-aim placement -> touch move -> touch off-bed removal with haptics.
    await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.setCamera("cozy");
      api.advance(0);
      (window as unknown as VibeWindow).__vibes.length = 0;
    });
    const basket = await pickCenterClient(page, "basket");
    await touchTap(cdp, basket.x, basket.y, 30);
    await page.evaluate(() => window.__rakeMe!.advance(0));
    expect(await page.evaluate(() => window.__rakeMe!.state().panel)).toBe("basket");

    const stoneChip = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const hit = api.overlayHits().find((h) => h.action.type === "place" && h.action.kind === "stone_s");
      if (!hit) return null;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      return {
        x: rect.left + ((hit.x + hit.w / 2) / fbW) * rect.width,
        y: rect.top + ((hit.y + hit.h / 2) / fbH) * rect.height,
      };
    });
    expect(stoneChip).not.toBeNull();
    await touchTap(cdp, stoneChip!.x, stoneChip!.y, 31);
    await page.evaluate(() => window.__rakeMe!.advance(0));

    // Touch down on sand, drag thumb slightly to aim, release to place stone
    const placeTarget = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      const p1 = api.project(-15, 3, 5)!;
      const p2 = api.project(10, 3, 12)!;
      return {
        a: { x: rect.left + (p1.x / fbW) * rect.width, y: rect.top + (p1.y / fbH) * rect.height },
        b: { x: rect.left + (p2.x / fbW) * rect.width, y: rect.top + (p2.y / fbH) * rect.height },
      };
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: placeTarget.a.x, y: placeTarget.a.y, id: 32 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: placeTarget.b.x, y: placeTarget.b.y, id: 32 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.evaluate(() => window.__rakeMe!.advance(0));

    const placed = await page.evaluate(() => ({
      count: window.__rakeMe!.state().elementCount,
      el: window.__rakeMe!.state().elements[0],
      vibes: [...(window as unknown as VibeWindow).__vibes],
    }));
    expect(placed.count).toBe(1);
    expect(placed.el?.kind).toBe("stone_s");
    // Placed at drag destination b (world x=+10, z=+12 -> grid x=106, y=68), NOT initial touchdown a (grid x=81, y=61)
    expect(Math.abs((placed.el?.x ?? 0) - 106)).toBeLessThanOrEqual(2);
    expect(Math.abs((placed.el?.y ?? 0) - 68)).toBeLessThanOrEqual(2);
    expect(placed.vibes).toContainEqual(HAPTIC_PATTERNS.thud);

    // Drag the stone off-bed by touch to remove it
    const stonePt = await pickCenterClient(page, `element:${placed.el!.id}`);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: stonePt.x, y: stonePt.y, id: 33 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 800, y: 340, id: 33 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.evaluate(() => window.__rakeMe!.advance(0));
    expect(await page.evaluate(() => window.__rakeMe!.state().elementCount)).toBe(0);

    // 4. Reduced motion suppresses haptics when tapping Gubba or switching rakes.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      (window as unknown as VibeWindow).__vibes.length = 0;
    });
    const gubbaPt = await pickCenterClient(page, "gubba");
    await touchTap(cdp, gubbaPt.x, gubbaPt.y, 40);
    await page.evaluate(() => window.__rakeMe!.advance(0));
    expect(await page.evaluate(() => (window as unknown as VibeWindow).__vibes)).toEqual([]);
    expect(await page.evaluate(() => window.__rakeMe!.paletteViolations())).toBe(0);

    // 5. Safe-area inset on #stage keeps the canvas & Undo HUD button strictly outside a 44 px left notch cutout.
    await page.evaluate(() => {
      const stage = document.getElementById("stage")!;
      stage.style.left = "44px";
      stage.style.right = "44px";
      window.dispatchEvent(new Event("resize"));
      window.__rakeMe!.advance(0);
    });
    const undoLeftCss = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const undo = api.overlayHits().find((h) => h.action.type === "hud" && h.action.id === "undo")!;
      const { fbW } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      return rect.left + (undo.x / fbW) * rect.width;
    });
    expect(undoLeftCss).toBeGreaterThanOrEqual(44);
  });

  test("Thumb precision: sand taps draw nothing, a pinch on the sand leaves no dab or undo entry, near misses on rakes and the HUD still land", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    await page.locator("#title-card").tap();
    await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.loadPreset("still_sand");
      api.setCamera("cozy");
      api.advance(0);
    });
    const cdp = await page.context().newCDPSession(page);
    const h0 = await sandHash(page);

    // 0. One ordinary committed stroke, so the undo history has exactly one entry above the preset.
    await touchSlide(cdp, 100, lerp(await sandClient(page, 40, 80), await sandClient(page, 120, 86), 6));
    await touchLift(cdp);
    const h1 = await sandHash(page);
    expect(h1).not.toBe(h0);

    // 1. A tap whose contact patch wobbles 6-7 CSS px (more than three sand cells here) carves nothing.
    const tapAt = await sandClient(page, 96, 40);
    await touchSlide(cdp, 101, [tapAt, { x: tapAt.x + 6, y: tapAt.y + 3 }, { x: tapAt.x - 2, y: tapAt.y + 6 }]);
    await touchLift(cdp);
    expect(await sandHash(page)).toBe(h1);

    // 2. Pinching on the sand: the first finger lands, drifts far enough to start carving, then the second lands.
    //    The dab is rolled back, the pinch still zooms, and nothing is added to the undo history.
    const camBeforePinch = await cameraOf(page);
    const a0 = await sandClient(page, 70, 50);
    const a1 = { x: a0.x + 18, y: a0.y + 4 };
    await touchSlide(cdp, 102, [a0, { x: a0.x + 9, y: a0.y + 2 }, a1]);
    await flushMoves(page);
    expect(await sandHash(page), "the first finger was really carving").not.toBe(h1);
    const b0 = { x: a0.x + 170, y: a0.y + 30 };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...a1, id: 102 }, { ...b0, id: 103 }],
    });
    expect(await sandHash(page), "the dab is gone the moment the second finger lands").toBe(h1);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: a1.x - 40, y: a1.y - 10, id: 102 }, { x: b0.x + 40, y: b0.y + 10, id: 103 }],
    });
    await touchLift(cdp);
    await page.evaluate(() => window.__rakeMe!.advance(600));
    expect(await sandHash(page)).toBe(h1);
    expect(Math.abs((await cameraOf(page)).dist - camBeforePinch.dist)).toBeGreaterThan(8);
    expect(await page.evaluate(() => { window.__rakeMe!.undo(); return window.__rakeMe!.sandHash(); })).toBe(h0);
    expect(await page.evaluate(() => { window.__rakeMe!.redo(); return window.__rakeMe!.sandHash(); })).toBe(h1);

    // 3. A stroke that was clearly under way (long, and older than the pinch grace) is kept when a second finger lands.
    await page.evaluate(() => { window.__rakeMe!.setCamera("cozy"); window.__rakeMe!.advance(0); });
    const c0 = await sandClient(page, 40, 30);
    const c1 = await sandClient(page, 110, 34);
    await touchSlide(cdp, 104, lerp(c0, c1, 5));
    await flushMoves(page);
    await page.waitForTimeout(220);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...c1, id: 104 }, { x: c1.x + 150, y: c1.y + 40, id: 105 }],
    });
    await touchLift(cdp);
    const h2 = await sandHash(page);
    expect(h2).not.toBe(h1);
    expect(await page.evaluate(() => { window.__rakeMe!.undo(); return window.__rakeMe!.sandHash(); })).toBe(h1);

    // 4. A third finger under a pinch starts nothing of its own.
    await page.evaluate(() => { window.__rakeMe!.setCamera("cozy"); window.__rakeMe!.advance(0); });
    const wall = await emptyWallClient(page, 12);
    const third = await sandClient(page, 60, 70);
    const two = [{ ...wall, id: 106 }, { x: wall.x + 60, y: wall.y + 5, id: 107 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [two[0]!] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: two });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [...two, { ...third, id: 108 }] });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [...two, { x: third.x + 70, y: third.y + 8, id: 108 }],
    });
    await touchLift(cdp);
    expect(await sandHash(page)).toBe(h1);

    // 5. A hanging rake's handle is one or two framebuffer pixels wide. A thumb landing 6 CSS px beside it,
    //    on bare wall, still takes that rake and does not orbit the camera.
    await page.evaluate(() => { window.__rakeMe!.setCamera("cozy"); window.__rakeMe!.advance(0); });
    const nearMiss = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      const b = api.pickBounds()["rake:kinu"]!;
      for (let y = b.maxY - 2; y > b.minY; y--) {
        let last = -1;
        let count = 0;
        for (let x = b.minX; x <= b.maxX; x++) {
          const p = api.pick(x, y);
          if (p.kind === "rake" && p.id === "kinu") {
            last = x;
            count++;
          }
        }
        if (count < 1 || count > 2) continue;
        const x = last + 3;
        if (api.pick(x, y).kind !== "none" || api.pick(x - 1, y).kind !== "none") continue;
        return {
          x: rect.left + ((x + 0.5) / fbW) * rect.width,
          y: rect.top + ((y + 0.5) / fbH) * rect.height,
          handleWidthCss: (count / fbW) * rect.width,
        };
      }
      return null;
    });
    expect(nearMiss, "a bare-wall point beside Kinu's handle").not.toBeNull();
    expect(nearMiss!.handleWidthCss).toBeLessThanOrEqual(5);
    const camBeforeMiss = await cameraOf(page);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).not.toBe("kinu");
    await touchTap(cdp, nearMiss!.x, nearMiss!.y, 109);
    await page.evaluate(() => window.__rakeMe!.advance(400));
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe("kinu");
    expect((await cameraOf(page)).az).toBeCloseTo(camBeforeMiss.az, 5);

    // 6. Far from anything, a tap (with a little wobble) leaves both the rake and the camera alone...
    const empty = await emptyWallClient(page, 12);
    await touchSlide(cdp, 110, [empty, { x: empty.x + 5, y: empty.y + 3 }]);
    await touchLift(cdp);
    await page.evaluate(() => window.__rakeMe!.advance(400));
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe("kinu");
    expect((await cameraOf(page)).az).toBeCloseTo(camBeforeMiss.az, 5);
    expect((await cameraOf(page)).el).toBeCloseTo(camBeforeMiss.el, 5);

    // ...and a real drag orbits. Dragged far past the azimuth limit and then reversed, the camera answers the
    // reversal at once instead of first unwinding the overshoot.
    const dir = empty.x < 422 ? 1 : -1; // drag toward whichever side has room, staying on screen
    await touchSlide(cdp, 111, lerp(empty, { x: empty.x + dir * 320, y: empty.y }, 8));
    await flushMoves(page);
    await page.evaluate(() => window.__rakeMe!.advance(2500));
    const azAtLimit = (await cameraOf(page)).az;
    expect(Math.abs(azAtLimit - camBeforeMiss.az)).toBeGreaterThan(0.3);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: empty.x + dir * 300, y: empty.y, id: 111 }],
    });
    await flushMoves(page);
    await page.evaluate(() => window.__rakeMe!.advance(2500));
    const azAfterReverse = (await cameraOf(page)).az;
    await touchLift(cdp);
    expect(Math.abs(azAtLimit - azAfterReverse)).toBeGreaterThan(0.08);
    expect(Math.abs(azAtLimit - azAfterReverse)).toBeLessThan(0.16);

    // 7. A thumb 3 CSS px outside a HUD button still presses it.
    await page.evaluate(() => { window.__rakeMe!.setCamera("cozy"); window.__rakeMe!.advance(0); });
    const hudMiss = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      const hits = api.overlayHits();
      const hit = hits.find((h) => h.action.type === "hud" && h.action.id === "breath");
      if (!hit) return null;
      const off = (3 / rect.width) * fbW;
      const candidates = [
        { x: hit.x + hit.w / 2, y: hit.y - off },
        { x: hit.x + hit.w / 2, y: hit.y + hit.h + off },
        { x: hit.x - off, y: hit.y + hit.h / 2 },
        { x: hit.x + hit.w + off, y: hit.y + hit.h / 2 },
      ];
      const free = candidates.find(
        (c) => c.x >= 0 && c.y >= 0 && c.x < fbW && c.y < fbH && !hits.some((h) => c.x >= h.x && c.y >= h.y && c.x < h.x + h.w && c.y < h.y + h.h),
      );
      if (!free) return null;
      return { x: rect.left + (free.x / fbW) * rect.width, y: rect.top + (free.y / fbH) * rect.height };
    });
    expect(hudMiss, "a point just outside the breath button and outside every other control").not.toBeNull();
    const breathBefore = await page.evaluate(() => window.__rakeMe!.state().settings.breathEnabled);
    await touchTap(cdp, hudMiss!.x, hudMiss!.y, 112);
    await page.evaluate(() => window.__rakeMe!.advance(0));
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.breathEnabled)).toBe(!breathBefore);
    expect(await sandHash(page)).toBe(h1);
    expect(errors).toEqual([]);
  });

  test("Touch feel: frame-edge strokes, rake lift under the thumb, stones that never jump, a placement prompt, stale touches and mobile viewport events", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    await page.locator("#title-card").tap();
    await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.loadPreset("still_sand");
      api.setCamera("cozy");
      api.advance(0);
    });
    const cdp = await page.context().newCDPSession(page);
    const h0 = await sandHash(page);
    const cam0 = await cameraOf(page);

    // 1. A thumb aiming at the edge of the bed lands on its wooden frame: that starts a stroke, not an orbit.
    const onFrame = await sandClient(page, -4, 60);
    expect(await page.evaluate(([x, y]) => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      return api.pick(((x! - rect.left) / rect.width) * fbW, ((y! - rect.top) / rect.height) * fbH).kind;
    }, [onFrame.x, onFrame.y])).toBe("none");
    await touchSlide(cdp, 200, lerp(onFrame, await sandClient(page, 50, 64), 6));
    await touchLift(cdp);
    await page.evaluate(() => window.__rakeMe!.advance(400));
    const h1 = await sandHash(page);
    expect(h1).not.toBe(h0);
    expect((await cameraOf(page)).az).toBeCloseTo(cam0.az, 5);
    expect((await cameraOf(page)).el).toBeCloseTo(cam0.el, 5);

    // 2. A hanging rake lifts the moment a thumb lands on it, before the 350 ms hold shows its name, and
    //    settles back when the touch is cancelled, released, or slides away over another rake.
    const hover = () => page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(0);
      return { rake: api.state().hoverRake, speech: api.state().speech ?? "" };
    });
    const wall = await emptyWallClient(page, 12);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...wall, id: 201 }] });
    expect((await hover()).rake, "a touch on bare wall lifts nothing").toBeNull();
    await touchLift(cdp);
    const onami = await pickCenterClient(page, "rake:onami");
    const kinu = await pickCenterClient(page, "rake:kinu");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...onami, id: 202 }] });
    const lifted = await hover();
    expect(lifted.rake).toBe("onami");
    expect(lifted.speech).not.toMatch(/Ōnami/);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    expect((await hover()).rake).toBeNull();

    const rakeBefore = await page.evaluate(() => window.__rakeMe!.state().settings.rake);
    await touchSlide(cdp, 2021, [onami, { x: (onami.x + kinu.x) / 2, y: kinu.y }, kinu, { x: kinu.x + 1, y: kinu.y }]);
    await flushMoves(page);
    expect((await hover()).rake, "a finger has no hover: sliding onto another rake lifts nothing").toBeNull();
    await touchLift(cdp);
    expect((await hover()).rake).toBeNull();
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe(rakeBefore);

    await touchTap(cdp, onami.x, onami.y, 2022);
    expect((await hover()).rake, "a selected rake is in the hand, not lifted on the wall").toBeNull();
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe("onami");

    // 3. Pressing a stone does not move it; dragging carries it by exactly as far as the finger travels.
    expect(await page.evaluate(() => window.__rakeMe!.placeElement("stone_tall", 120, 40))).toBe(true);
    const stone = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(0);
      const el = api.state().elements[0]!;
      const b = api.pickBounds()[`element:${el.id}`]!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      // the highest pixel of the stone: its sand point lies well behind the stone's centre
      for (let y = b.minY; y <= b.maxY; y++) {
        for (let x = b.minX; x <= b.maxX; x++) {
          const p = api.pick(x, y);
          if (p.kind !== "element" || p.id !== el.id) continue;
          const sp = api.sandPoint(x + 0.5, y + 0.5)!;
          return {
            el,
            top: { x: rect.left + ((x + 0.5) / fbW) * rect.width, y: rect.top + ((y + 0.5) / fbH) * rect.height },
            grabOffset: Math.hypot(sp.x - el.x, sp.y - el.y),
          };
        }
      }
      return null;
    });
    expect(stone).not.toBeNull();
    expect(stone!.grabOffset, "the top of a standing stone is several cells from its footprint").toBeGreaterThan(4);
    const hStone = await sandHash(page);
    await touchSlide(cdp, 203, [stone!.top, { x: stone!.top.x + 3, y: stone!.top.y + 2 }]);
    await touchLift(cdp);
    await page.evaluate(() => window.__rakeMe!.advance(0));
    const afterPress = await page.evaluate(() => window.__rakeMe!.state().elements[0]!);
    expect([afterPress.x, afterPress.y]).toEqual([stone!.el.x, stone!.el.y]);
    expect(await sandHash(page)).toBe(hStone);

    const dragTo = { x: stone!.top.x - 60, y: stone!.top.y + 30 };
    const expected = await page.evaluate(([from, to, el]) => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      const sand = (p: { x: number; y: number }) => api.sandPoint(((p.x - rect.left) / rect.width) * fbW, ((p.y - rect.top) / rect.height) * fbH)!;
      const a = sand(from as { x: number; y: number });
      const b = sand(to as { x: number; y: number });
      const e = el as { x: number; y: number };
      return { x: e.x + (b.x - a.x), y: e.y + (b.y - a.y) };
    }, [stone!.top, dragTo, stone!.el] as const);
    await touchSlide(cdp, 204, lerp(stone!.top, dragTo, 4));
    await touchLift(cdp);
    await page.evaluate(() => window.__rakeMe!.advance(0));
    const afterDrag = await page.evaluate(() => window.__rakeMe!.state().elements[0]!);
    expect(Math.abs(afterDrag.x - expected.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(afterDrag.y - expected.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(afterDrag.x - stone!.el.x)).toBeGreaterThan(10);

    // 4. Picking a stone from the basket by touch says what to do next, in the speech scroll and to screen
    //    readers, until the stone is placed.
    const basket = await pickCenterClient(page, "basket");
    await touchTap(cdp, basket.x, basket.y, 205);
    await page.evaluate(() => window.__rakeMe!.advance(0));
    const chip = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const hit = api.overlayHits().find((h) => h.action.type === "place" && h.action.kind === "stone_s")!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      return { x: rect.left + ((hit.x + hit.w / 2) / fbW) * rect.width, y: rect.top + ((hit.y + hit.h / 2) / fbH) * rect.height };
    });
    await touchTap(cdp, chip.x, chip.y, 206);
    const prompted = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(0);
      return {
        speech: api.state().speech ?? "",
        live: (document.getElementById("sr-live")?.textContent ?? "").trim(),
        violations: api.paletteViolations(),
      };
    });
    expect(prompted.speech).toMatch(/Small Stone · touch the sand to place/);
    expect(prompted.live).toMatch(/Small Stone · touch the sand to place/);
    expect(prompted.violations).toBe(0);
    const dropAt = await sandClient(page, 60, 30);
    await touchTap(cdp, dropAt.x, dropAt.y, 207);
    const dropped = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(0);
      return { count: api.state().elementCount, speech: api.state().speech ?? "" };
    });
    expect(dropped.count).toBe(2);
    expect(dropped.speech).not.toMatch(/touch the sand to place/);

    // 5. A finger whose lift never reached the page must not turn every later touch into a pinch.
    const hBeforeGhost = await sandHash(page);
    await page.evaluate(({ x, y }) => {
      document.getElementById("garden-canvas")!.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 7777, pointerType: "touch", clientX: x, clientY: y, bubbles: true }),
      );
    }, wall);
    await touchSlide(cdp, 208, lerp(await sandClient(page, 30, 96), await sandClient(page, 100, 100), 6));
    await touchLift(cdp);
    const hAfterGhost = await sandHash(page);
    expect(hAfterGhost).not.toBe(hBeforeGhost);

    // 6. Mobile browsers fire resize events that change nothing (address bar, visual viewport). Mid-stroke they
    //    must not end the stroke: the whole drag stays one stroke and one undo step.
    const s0 = await sandClient(page, 30, 16);
    const s1 = await sandClient(page, 80, 18);
    const s2 = await sandClient(page, 150, 14);
    await touchSlide(cdp, 209, lerp(s0, s1, 4));
    await flushMoves(page);
    const hMid = await sandHash(page);
    expect(hMid).not.toBe(hAfterGhost);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("resize"));
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    for (const p of lerp(s1, s2, 4).slice(1)) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...p, id: 209 }] });
    }
    await touchLift(cdp);
    expect(await sandHash(page)).not.toBe(hMid);
    expect(await page.evaluate(() => { window.__rakeMe!.undo(); return window.__rakeMe!.sandHash(); })).toBe(hAfterGhost);

    // 7. A visual-viewport resize alone (iOS address bar hiding or showing) re-fits the canvas.
    const widthBefore = await page.evaluate(() => window.__rakeMe!.fbSize().cssW);
    const widthAfter = await page.evaluate(() => {
      document.getElementById("stage")!.style.right = "120px";
      window.visualViewport!.dispatchEvent(new Event("resize"));
      window.__rakeMe!.advance(0);
      return window.__rakeMe!.fbSize().cssW;
    });
    expect(widthAfter).toBeLessThan(widthBefore - 60);
    expect(await page.evaluate(() => window.__rakeMe!.paletteViolations())).toBe(0);

    // 8. The page never rubber-bands or pulls to refresh under a dragging finger.
    const css = await page.evaluate(() => ({
      overscrollBody: getComputedStyle(document.body).overscrollBehaviorY,
      overscrollRoot: getComputedStyle(document.documentElement).overscrollBehaviorY,
      canvasTouch: getComputedStyle(document.getElementById("garden-canvas")!).touchAction,
    }));
    expect(css).toEqual({ overscrollBody: "none", overscrollRoot: "none", canvasTouch: "none" });
    expect(errors).toEqual([]);
  });

  test("Interrupted touches: a finger still down when the app loses focus, is hidden, unloads or has its capture taken never becomes the second finger of a pinch", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    const cdp = await enterGarden(page);
    await page.evaluate(() => {
      const w = window as unknown as { __downIds: number[] };
      w.__downIds = [];
      document.getElementById("garden-canvas")!.addEventListener("pointerdown", (e) => w.__downIds.push(e.pointerId));
    });
    const lastDownId = (): Promise<number> => page.evaluate(() => (window as unknown as { __downIds: number[] }).__downIds.at(-1)!);
    const hasCapture = (id: number): Promise<boolean> =>
      page.evaluate((pid) => document.getElementById("garden-canvas")!.hasPointerCapture(pid), id);
    const undoCount = (): Promise<number> => page.evaluate(() => window.__rakeMe!.state().undoCount);
    const setHidden = (hidden: boolean): Promise<void> =>
      page.evaluate((h) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
    const cam0 = await cameraOf(page);

    // On iOS, swiping up to the home screen, pulling Control Center down or an edge gesture takes the fingers away
    // without a pointerup or pointercancel. Each way the page can learn of it must let go of the finger, keep the
    // stroke it had drawn, and leave the next finger to rake alone.
    const INTERRUPTS = [
      { how: "blur", carving: true },
      { how: "hidden", carving: false },
      { how: "pagehide", carving: true },
      { how: "lostcapture", carving: true },
    ] as const;
    let row = 16;
    let fingerA = 300;
    for (const { how, carving } of INTERRUPTS) {
      const a0 = await sandClient(page, 24, row);
      const a1 = await sandClient(page, 64, row + 2);
      const a2 = await sandClient(page, 84, row + 2);
      const b0 = await sandClient(page, 110, row + 4);
      const b1 = await sandClient(page, 168, row + 6);
      const hStart = await sandHash(page);
      const undoStart = await undoCount();
      // What finger A's stroke leaves when it is lifted where the interruption will find it: lifting closes the
      // stroke's last step, so this, not the sand mid-stroke, is what an interrupted stroke must equal.
      let hEnded = hStart;
      if (carving) {
        await touchSlide(cdp, fingerA + 5, lerp(a0, a1, 4));
        await touchLift(cdp);
        hEnded = await sandHash(page);
        expect(hEnded).not.toBe(hStart);
        expect(await page.evaluate(() => { window.__rakeMe!.undo(); return window.__rakeMe!.sandHash(); })).toBe(hStart);
      }

      // 1. Finger A lands on the sand: a stroke under way, or a press that has not left the tap slop yet.
      await touchSlide(cdp, fingerA, carving ? lerp(a0, a1, 4) : [a0]);
      await flushMoves(page);
      const idA = await lastDownId();
      const hCarved = await sandHash(page);
      expect(hCarved !== hStart, `${how}: finger A ${carving ? "is carving" : "has drawn nothing yet"}`).toBe(carving);
      expect(await hasCapture(idA), `${how}: finger A is captured`).toBe(true);

      // 2. The interruption. No pointerup, no pointercancel.
      if (how === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      else if (how === "hidden") await setHidden(true);
      else if (how === "pagehide") await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
      else await page.evaluate((pid) => document.getElementById("garden-canvas")!.releasePointerCapture(pid), idA);
      if (how === "hidden") await setHidden(false);

      // 3. As far as the browser knows finger A is still down, and it drags on: that must draw nothing more.
      const here = carving ? a1 : a0;
      for (const p of lerp(here, a2, 3).slice(1)) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...p, id: fingerA }] });
      }
      await flushMoves(page);
      expect(await hasCapture(idA), `${how}: finger A's capture is released`).toBe(false);
      expect(await sandHash(page), `${how}: the stroke ends where it was interrupted and draws no further`).toBe(hEnded);
      expect(await undoCount(), `${how}: the stroke it had drawn is kept as one undo step`).toBe(undoStart + (carving ? 1 : 0));
      expect(await page.evaluate(() => window.__rakeMe!.state().hoverRake), how).toBeNull();

      // 4. A new finger rakes on its own while the old one is still "down": no pinch, no orbit, a clean stroke.
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...a2, id: fingerA }, { ...b0, id: fingerA + 1 }] });
      for (const p of lerp(b0, b1, 6).slice(1)) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...a2, id: fingerA }, { ...p, id: fingerA + 1 }] });
      }
      await flushMoves(page);
      const hRaking = await sandHash(page);
      expect(hRaking, `${how}: the next finger carves`).not.toBe(hEnded);
      await touchLift(cdp);
      const after = await page.evaluate(() => {
        const api = window.__rakeMe!;
        api.advance(400); // long enough for any orbit or zoom to show in the damped camera
        return { camera: api.state().camera, undo: api.state().undoCount, hash: api.sandHash(), violations: api.paletteViolations() };
      });
      expect(after.camera, `${how}: the camera did not orbit or zoom`).toEqual(cam0);
      expect(after.undo, `${how}: the new stroke is its own undo step`).toBe(undoStart + (carving ? 2 : 1));
      expect(after.violations, how).toBe(0);
      // and that one undo takes back exactly the new stroke
      const hLifted = after.hash;
      expect(await page.evaluate(() => { window.__rakeMe!.undo(); return window.__rakeMe!.sandHash(); }), how).toBe(hEnded);
      expect(await page.evaluate(() => { window.__rakeMe!.redo(); return window.__rakeMe!.sandHash(); }), how).toBe(hLifted);

      row += 22;
      fingerA += 10;
    }

    // A thumb resting on a hanging rake when the app loses focus: the rake settles back, and the lift that
    // arrives afterwards is not a tap that picks it up.
    const rakeBefore = await page.evaluate(() => window.__rakeMe!.state().settings.rake);
    const kinu = await pickCenterClient(page, "rake:kinu");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...kinu, id: 390 }] });
    expect(await page.evaluate(() => { window.__rakeMe!.advance(0); return window.__rakeMe!.state().hoverRake; })).toBe("kinu");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    expect(await page.evaluate(() => { window.__rakeMe!.advance(0); return window.__rakeMe!.state().hoverRake; })).toBeNull();
    await touchLift(cdp);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe(rakeBefore);

    // An ordinary tap still selects: the capture that ends after a normal lift cancels nothing.
    await touchTap(cdp, kinu.x, kinu.y, 391);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe("kinu");
    expect(errors).toEqual([]);
  });

  test("Haptics, Android path: every touch gesture plays its own pattern; mouse, pinch rollback and reduced motion stay silent", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    const cdp = await enterGarden(page);
    const H = HAPTIC_PATTERNS;
    const rakeNow = () => page.evaluate(() => window.__rakeMe!.state().settings.rake);
    expect(await vibesOf(page), "entering the garden is not a haptic").toEqual([]);

    // 1. Rake tap: select.
    const tetsu = await pickCenterClient(page, "rake:tetsu");
    await touchTap(cdp, tetsu.x, tetsu.y, 300);
    expect(await rakeNow()).toBe("tetsu");
    expect(await vibesOf(page)).toEqual([H.select]);

    // 2. Hold to preview: one soft pulse when the description appears, nothing more on release.
    await clearVibes(page);
    const onami = await pickCenterClient(page, "rake:onami");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...onami, id: 301 }] });
    expect(await vibesOf(page), "landing on a rake is silent until it is a tap or a hold").toEqual([]);
    await page.evaluate(() => window.__rakeMe!.advance(400));
    expect(await vibesOf(page)).toEqual([H.preview]);
    await touchLift(cdp);
    await page.evaluate(() => window.__rakeMe!.advance(3000));
    expect(await vibesOf(page)).toEqual([H.preview]);
    expect(await rakeNow()).toBe("tetsu");

    // 3. HUD icon: tap.
    await clearVibes(page);
    const breath = await overlayClient(page, { type: "hud", id: "breath" });
    const breathBefore = await page.evaluate(() => window.__rakeMe!.state().settings.breathEnabled);
    await touchTap(cdp, breath.x, breath.y, 302);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.breathEnabled)).toBe(!breathBefore);
    expect(await vibesOf(page)).toEqual([H.tap]);

    // 4. Stroke start: nothing for a tap inside the slop, one light catch when the rake bites, nothing after.
    await clearVibes(page);
    const h0 = await sandHash(page);
    const tapAt = await sandClient(page, 96, 40);
    await touchSlide(cdp, 303, [tapAt, { x: tapAt.x + 5, y: tapAt.y + 3 }]);
    await touchLift(cdp);
    expect(await sandHash(page)).toBe(h0);
    expect(await vibesOf(page)).toEqual([]);
    await touchSlide(cdp, 304, lerp(await sandClient(page, 40, 80), await sandClient(page, 120, 86), 6));
    await flushMoves(page);
    expect(await sandHash(page)).not.toBe(h0);
    expect(await vibesOf(page)).toEqual([H.strokeStart]);
    await touchLift(cdp);
    expect(await vibesOf(page)).toEqual([H.strokeStart]);

    // 5. Stone drop: the basket and its chip tap, the stone lands with a thud.
    await clearVibes(page);
    await touchPlaceStone(page, cdp, 100, 50, 310);
    expect(await page.evaluate(() => window.__rakeMe!.state().elementCount)).toBe(1);
    expect(await vibesOf(page)).toEqual([H.tap, H.tap, H.thud]);

    // 6. Pressing a stone is silent; lifting it past the slop taps, setting it down thuds.
    await clearVibes(page);
    const stoneId = await page.evaluate(() => window.__rakeMe!.state().elements[0]!.id);
    const stone = await pickCenterClient(page, `element:${stoneId}`);
    await touchSlide(cdp, 320, [stone, { x: stone.x + 3, y: stone.y + 2 }]);
    await touchLift(cdp);
    expect(await vibesOf(page)).toEqual([]);
    await touchSlide(cdp, 321, lerp(stone, { x: stone.x + 50, y: stone.y + 20 }, 3));
    await flushMoves(page);
    expect(await vibesOf(page)).toEqual([H.tap]);
    await touchLift(cdp);
    expect(await vibesOf(page)).toEqual([H.tap, H.thud]);

    // 7. A stroke that runs into a stone nudges, at most once per cooldown however long it grinds.
    await page.evaluate(() => {
      const api = window.__rakeMe!;
      for (const el of api.state().elements) api.removeElement(el.id);
      api.placeElement("stone_m", 96, 56);
      api.advance(0);
    });
    await clearVibes(page);
    await touchSlide(cdp, 330, lerp(await sandClient(page, 40, 56), await sandClient(page, 70, 56), 3));
    await flushMoves(page);
    expect(await vibesOf(page)).toEqual([H.strokeStart]);
    await page.waitForTimeout(STONE_BRUSH_COOLDOWN_MS + 50);
    for (const p of lerp(await sandClient(page, 70, 56), await sandClient(page, 150, 56), 12).slice(1)) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...p, id: 330 }] });
    }
    await flushMoves(page);
    await touchLift(cdp);
    const brushed = await page.evaluate(() => {
      const w = window as unknown as VibeWindow;
      return { vibes: [...w.__vibes], times: [...w.__vibeTimes] };
    });
    expect(brushed.vibes[0]).toEqual(H.strokeStart);
    expect(brushed.vibes.length).toBeGreaterThanOrEqual(2);
    expect(brushed.vibes.slice(1).every((v) => v === H.stoneBrush)).toBe(true);
    for (let i = 1; i < brushed.times.length; i++) {
      // the stub stamps each call a moment after the engine read its own clock: allow 1 ms
      expect(brushed.times[i]! - brushed.times[i - 1]!).toBeGreaterThanOrEqual(STONE_BRUSH_COOLDOWN_MS - 1);
    }
    await page.evaluate(() => {
      const api = window.__rakeMe!;
      for (const el of api.state().elements) api.removeElement(el.id);
      api.advance(0);
    });

    // 8. Hoki: held on the wall for 0.8 s, the sweep starts with a calm double beat.
    await clearVibes(page);
    const hoki = await pickCenterClient(page, "rake:hoki");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...hoki, id: 340 }] });
    await page.evaluate(() => window.__rakeMe!.advance(700));
    expect(await vibesOf(page)).toEqual([]);
    await page.evaluate(() => window.__rakeMe!.advance(200));
    expect(await vibesOf(page)).toEqual([H.sweep]);
    await touchLift(cdp);
    await page.evaluate(() => window.__rakeMe!.advance(3000));
    expect(await vibesOf(page)).toEqual([H.sweep]);

    // 9. A young stroke rolled back by a second finger adds nothing, and neither does the pinch.
    await clearVibes(page);
    const hPinch = await sandHash(page);
    const a0 = await sandClient(page, 70, 50);
    const a1 = { x: a0.x + 18, y: a0.y + 4 };
    await touchSlide(cdp, 350, [a0, { x: a0.x + 9, y: a0.y + 2 }, a1]);
    await flushMoves(page);
    const beforeSecondFinger = await vibesOf(page);
    expect(beforeSecondFinger.length).toBeLessThanOrEqual(1);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...a1, id: 350 }, { x: a0.x + 170, y: a0.y + 30, id: 351 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: a1.x - 40, y: a1.y - 10, id: 350 }, { x: a0.x + 210, y: a0.y + 40, id: 351 }],
    });
    await touchLift(cdp);
    await page.evaluate(() => { window.__rakeMe!.setCamera("cozy"); window.__rakeMe!.advance(0); });
    expect(await sandHash(page)).toBe(hPinch);
    expect(await vibesOf(page)).toEqual(beforeSecondFinger);

    // 10. A mouse does all of the same things in silence.
    await clearVibes(page);
    const countBeforeMouse = await page.evaluate(() => window.__rakeMe!.haptics().count);
    await page.evaluate(() => {
      const types: string[] = [];
      (window as unknown as { __pointerTypes: string[] }).__pointerTypes = types;
      document.getElementById("garden-canvas")!.addEventListener("pointerdown", (e) => types.push(e.pointerType));
    });
    const kinu = await pickCenterClient(page, "rake:kinu");
    await page.mouse.click(kinu.x, kinu.y);
    expect(await rakeNow()).toBe("kinu");
    const breathMid = await page.evaluate(() => window.__rakeMe!.state().settings.breathEnabled);
    await page.mouse.click(breath.x, breath.y);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.breathEnabled)).toBe(!breathMid);
    const gubba = await pickCenterClient(page, "gubba");
    await page.mouse.click(gubba.x, gubba.y);
    const hMouse = await sandHash(page);
    const m0 = await sandClient(page, 40, 30);
    const m1 = await sandClient(page, 120, 34);
    await page.mouse.move(m0.x, m0.y);
    await page.mouse.down();
    await page.mouse.move(m1.x, m1.y, { steps: 6 });
    await page.mouse.up();
    expect(await sandHash(page)).not.toBe(hMouse);
    expect(await page.evaluate(() => (window as unknown as { __pointerTypes: string[] }).__pointerTypes)).toEqual([
      "mouse", "mouse", "mouse", "mouse",
    ]);
    expect(await vibesOf(page)).toEqual([]);
    expect(await page.evaluate(() => window.__rakeMe!.haptics().count)).toBe(countBeforeMouse);

    // 11. prefers-reduced-motion silences every touch haptic, live, and lifting it brings them back.
    //     (Picking reads the last rendered frame, so render the wall as it now hangs before aiming at it.)
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => window.__rakeMe!.advance(0));
    const wa = await pickCenterClient(page, "rake:wa");
    await touchTap(cdp, wa.x, wa.y, 360);
    expect(await rakeNow()).toBe("wa");
    await touchTap(cdp, breath.x, breath.y, 361);
    await touchSlide(cdp, 362, lerp(await sandClient(page, 40, 90), await sandClient(page, 120, 96), 6));
    await flushMoves(page);
    await touchLift(cdp);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...onami, id: 363 }] });
    await page.evaluate(() => window.__rakeMe!.advance(400));
    await touchLift(cdp);
    expect(await vibesOf(page)).toEqual([]);
    expect(await page.evaluate(() => window.__rakeMe!.paletteViolations())).toBe(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => window.__rakeMe!.advance(0));
    const take = await pickCenterClient(page, "rake:take");
    await touchTap(cdp, take.x, take.y, 364);
    expect(await rakeNow()).toBe("take");
    expect(await vibesOf(page)).toEqual([H.select]);

    // The Vibration API is the only backend used here: the iOS switch is never built
    expect(await page.locator(`#${HAPTIC_SWITCH_ID}`).count()).toBe(0);
    expect(errors).toEqual([]);
  });
});

type SwitchWindow = { __switch: { clicks: number; leaks: string[] } };

test.describe("Gubba's Porch — haptics on iOS WebKit (no navigator.vibrate)", () => {
  test.beforeEach(async ({ page }) => {
    // An iOS-like browser: `navigator.vibrate` does not exist, so the hidden switch is the only backend.
    // Chromium ignores the `switch` attribute, which makes this the "plain checkbox" path too.
    await page.addInitScript((switchId) => {
      Object.defineProperty(navigator, "vibrate", { configurable: true, value: undefined });
      const seen = { clicks: 0, leaks: [] as string[] };
      (window as unknown as SwitchWindow).__switch = seen;
      const fromSwitch = (e: Event): boolean => e.target instanceof Element && e.target.closest(`#${switchId}`) !== null;
      // Capture phase sees the scripted click on its way down to the label: one per haptic
      document.addEventListener("click", (e) => {
        if (e.target instanceof Element && e.target.id === switchId) seen.clicks++;
      }, true);
      // Bubble phase is where the page's own handlers listen: nothing from the switch may arrive
      for (const type of ["click", "input", "change"]) {
        document.addEventListener(type, (e) => { if (fromSwitch(e)) seen.leaks.push(`document:${type}`); });
        window.addEventListener(type, (e) => { if (fromSwitch(e)) seen.leaks.push(`window:${type}`); });
      }
    }, HAPTIC_SWITCH_ID);
  });

  const switchClicks = (page: Page): Promise<number> =>
    page.evaluate(() => (window as unknown as SwitchWindow).__switch.clicks);
  const lastHaptic = (page: Page) => page.evaluate(() => window.__rakeMe!.haptics());

  test("the hidden switch ticks on synchronous touch gestures only, out of sight, focus and the accessibility tree", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });
    const cdp = await enterGarden(page);
    expect(await page.evaluate(() => typeof navigator.vibrate)).toBe("undefined");
    expect(await page.locator(`#${HAPTIC_SWITCH_ID}`).count(), "nothing is built before a finger needs it").toBe(0);

    await page.evaluate(() => document.getElementById("garden-canvas")!.focus());
    const page0 = await page.evaluate(() => ({
      focus: document.activeElement?.id ?? "",
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      bodyChildren: document.body.children.length,
    }));
    expect(page0.focus).toBe("garden-canvas");

    // 1. Rake tap (pointerup): one click, and the switch is built exactly as specified.
    const tetsu = await pickCenterClient(page, "rake:tetsu");
    await touchTap(cdp, tetsu.x, tetsu.y, 400);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe("tetsu");
    expect(await switchClicks(page)).toBe(1);
    expect(await lastHaptic(page)).toEqual({ count: 1, last: "select" });
    const built = await page.evaluate((id) => {
      const label = document.getElementById(id)!;
      const input = label.querySelector("input")!;
      const style = getComputedStyle(label);
      const rect = label.getBoundingClientRect();
      return {
        labelTag: label.tagName,
        labelParent: label.parentElement?.tagName,
        labelHidden: label.getAttribute("aria-hidden"),
        inputs: label.querySelectorAll("input").length,
        type: input.type,
        switchAttr: input.getAttribute("switch"),
        inputHidden: input.getAttribute("aria-hidden"),
        tabIndex: input.tabIndex,
        labelled: input.labels?.[0] === label,
        style: {
          position: style.position, opacity: style.opacity, pointerEvents: style.pointerEvents, overflow: style.overflow,
        },
        size: [rect.width, rect.height],
      };
    }, HAPTIC_SWITCH_ID);
    expect(built).toEqual({
      labelTag: "LABEL",
      labelParent: "BODY",
      labelHidden: "true",
      inputs: 1,
      type: "checkbox",
      switchAttr: "",
      inputHidden: "true",
      tabIndex: -1,
      labelled: true,
      style: { position: "fixed", opacity: "0", pointerEvents: "none", overflow: "hidden" },
      size: [0, 0],
    });
    const snapshot = await page.locator("body").ariaSnapshot();
    expect(snapshot, "no checkbox or switch role is exposed").not.toMatch(/^\s*- (checkbox|switch)\b/m);

    // 2. HUD icon (pointerdown): one more.
    const breath = await overlayClient(page, { type: "hud", id: "breath" });
    const breathBefore = await page.evaluate(() => window.__rakeMe!.state().settings.breathEnabled);
    await touchTap(cdp, breath.x, breath.y, 401);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.breathEnabled)).toBe(!breathBefore);
    expect(await switchClicks(page)).toBe(2);
    expect(await lastHaptic(page)).toEqual({ count: 2, last: "tap" });

    // 3. Stroke start (pointermove): none inside the tap slop, one as the rake bites, none while it carves on.
    const h0 = await sandHash(page);
    const tapAt = await sandClient(page, 96, 40);
    await touchSlide(cdp, 402, [tapAt, { x: tapAt.x + 5, y: tapAt.y + 3 }]);
    await touchLift(cdp);
    expect(await switchClicks(page)).toBe(2);
    await touchSlide(cdp, 403, lerp(await sandClient(page, 40, 80), await sandClient(page, 120, 86), 6));
    await flushMoves(page);
    expect(await sandHash(page)).not.toBe(h0);
    expect(await switchClicks(page)).toBe(3);
    expect(await lastHaptic(page)).toEqual({ count: 3, last: "strokeStart" });
    await touchLift(cdp);
    expect(await switchClicks(page)).toBe(3);

    // 4. Stone drop (pointerup): the basket and its chip tap, the stone lands with one more.
    await touchPlaceStone(page, cdp, 100, 50, 410);
    expect(await page.evaluate(() => window.__rakeMe!.state().elementCount)).toBe(1);
    expect(await switchClicks(page)).toBe(6);
    expect(await lastHaptic(page)).toEqual({ count: 6, last: "thud" });

    // 5. Holds mature in the frame loop, outside any gesture: iOS would ignore a click there, so none is made.
    //    The preview and the sweep themselves still happen.
    const onami = await pickCenterClient(page, "rake:onami");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...onami, id: 420 }] });
    await page.evaluate(() => window.__rakeMe!.advance(400));
    expect(await page.evaluate(() => window.__rakeMe!.state().speech)).toMatch(/Ōnami/);
    await touchLift(cdp);
    const hBeforeSweep = await sandHash(page);
    const hoki = await pickCenterClient(page, "rake:hoki");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...hoki, id: 421 }] });
    await page.evaluate(() => window.__rakeMe!.advance(900));
    await touchLift(cdp);
    await page.evaluate(() => window.__rakeMe!.advance(3000));
    expect(await sandHash(page)).not.toBe(hBeforeSweep);
    expect(await switchClicks(page)).toBe(6);
    //    A hold released before any frame ran is recognised in pointerup, inside the gesture: that one ticks.
    const kinu = await pickCenterClient(page, "rake:kinu");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...kinu, id: 422 }] });
    await page.waitForTimeout(380);
    await touchLift(cdp);
    await page.evaluate(() => window.__rakeMe!.advance(0));
    expect(await page.evaluate(() => window.__rakeMe!.state().speech)).toMatch(/Kinu/);
    expect(await switchClicks(page)).toBe(7);
    expect(await lastHaptic(page)).toEqual({ count: 7, last: "preview" });

    // 6. A mouse never reaches the switch.
    await page.mouse.click(kinu.x, kinu.y);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe("kinu");
    await page.mouse.click(breath.x, breath.y);
    expect(await switchClicks(page)).toBe(7);

    // 7. prefers-reduced-motion: silent, live.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => window.__rakeMe!.advance(0));
    const wa = await pickCenterClient(page, "rake:wa");
    await touchTap(cdp, wa.x, wa.y, 430);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe("wa");
    await touchTap(cdp, breath.x, breath.y, 431);
    await touchSlide(cdp, 432, lerp(await sandClient(page, 40, 90), await sandClient(page, 120, 96), 6));
    await flushMoves(page);
    await touchLift(cdp);
    expect(await switchClicks(page)).toBe(7);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => window.__rakeMe!.advance(0));
    const take = await pickCenterClient(page, "rake:take");
    await touchTap(cdp, take.x, take.y, 433);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe("take");
    expect(await switchClicks(page)).toBe(8);

    // 8. After all of it: one switch, nothing leaked to the page, focus and layout untouched, palette intact.
    const after = await page.evaluate((id) => ({
      switches: document.querySelectorAll(`#${id}, input[switch]`).length,
      leaks: (window as unknown as SwitchWindow).__switch.leaks,
      focus: document.activeElement?.id ?? "",
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      scroll: [window.scrollX, window.scrollY],
      bodyChildren: document.body.children.length,
      haptics: window.__rakeMe!.haptics().count,
      violations: (window.__rakeMe!.advance(0), window.__rakeMe!.paletteViolations()),
    }), HAPTIC_SWITCH_ID);
    expect(after).toEqual({
      switches: 2, // the label and its one input
      leaks: [],
      focus: page0.focus,
      scrollW: page0.scrollW,
      scrollH: page0.scrollH,
      scroll: [0, 0],
      bodyChildren: page0.bodyChildren + 1,
      haptics: 8,
      violations: 0,
    });
    expect(errors).toEqual([]);
  });

  test("under prefers-reduced-motion from the start, the switch is never built", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await page.emulateMedia({ reducedMotion: "reduce" });
    const cdp = await enterGarden(page);
    const h0 = await sandHash(page);

    const tetsu = await pickCenterClient(page, "rake:tetsu");
    await touchTap(cdp, tetsu.x, tetsu.y, 500);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe("tetsu");
    const breath = await overlayClient(page, { type: "hud", id: "breath" });
    await touchTap(cdp, breath.x, breath.y, 501);
    await touchSlide(cdp, 502, lerp(await sandClient(page, 40, 80), await sandClient(page, 120, 86), 6));
    await flushMoves(page);
    await touchLift(cdp);
    expect(await sandHash(page)).not.toBe(h0);
    await touchPlaceStone(page, cdp, 100, 50, 510);
    expect(await page.evaluate(() => window.__rakeMe!.state().elementCount)).toBe(1);

    expect(await switchClicks(page)).toBe(0);
    expect(await lastHaptic(page)).toEqual({ count: 0, last: null });
    expect(await page.locator(`#${HAPTIC_SWITCH_ID}`).count()).toBe(0);
    expect(await page.evaluate(() => { window.__rakeMe!.advance(0); return window.__rakeMe!.paletteViolations(); })).toBe(0);
    expect(errors).toEqual([]);
  });

  test("panel touch slop snaps inside open panels, never snags from outside, and pinch/tap on sand keeps Gubba mode on", async ({
    page,
  }) => {
    const cdp = await enterGarden(page);

    // 1. Inside an open Settings panel: tapping 3 CSS px off a tab chip on panel paper still switches tabs.
    await page.evaluate(() => {
      window.__rakeMe!.openPanel("settings", "look");
      window.__rakeMe!.advance(0);
    });
    const probe = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const hits = api.overlayHits();
      const presets = hits.find((h) => h.action.type === "tab" && h.action.tab === "presets")!;
      const panelBg = hits.find((h) => h.action.type === "none")!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      const toClient = (fx: number, fy: number) => ({
        x: rect.left + (fx / fbW) * rect.width,
        y: rect.top + (fy / fbH) * rect.height,
      });
      // Just below the Presets tab chip (on panel paper where exact overlayHit is { type: "none" })
      const nearPaper = toClient(presets.x + presets.w / 2, presets.y + presets.h + 1);
      // Just outside the right border of the panel, level with the close button
      const close = hits.find((h) => h.action.type === "close")!;
      const outsideEdge = toClient(panelBg.x + panelBg.w + 2, close.y + close.h / 2);
      return { nearPaper, outsideEdge };
    });
    await touchTap(cdp, probe.nearPaper.x, probe.nearPaper.y, 600);
    await page.evaluate(() => window.__rakeMe!.advance(0));
    expect(await page.evaluate(() => window.__rakeMe!.state().tab)).toBe("presets");

    // Tapping just outside the panel border dismisses the panel rather than snagging an edge chip inside it
    await touchTap(cdp, probe.outsideEdge.x, probe.outsideEdge.y, 601);
    await page.evaluate(() => window.__rakeMe!.advance(0));
    expect(await page.evaluate(() => window.__rakeMe!.state().panel)).toBe("none");

    // 2. While Gubba mode is on, an accidental tap or two-finger pinch on the sand does NOT cancel Gubba mode.
    await page.evaluate(() => {
      window.__rakeMe!.setGubbaMode(true);
      window.__rakeMe!.advance(3000);
    });
    const p1 = await sandClient(page, 60, 56);
    const p2 = await sandClient(page, 130, 56);
    // Accidental tap inside slop on sand
    await touchTap(cdp, p1.x, p1.y, 602);
    expect(await page.evaluate(() => window.__rakeMe!.auto().mode)).toBe(true);

    // Two-finger pinch over sand zooms the camera while keeping Gubba mode running
    const distBefore = await page.evaluate(() => window.__rakeMe!.state().camera.dist);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p1.x, y: p1.y, id: 603 }] });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: p1.x, y: p1.y, id: 603 },
        { x: p2.x, y: p2.y, id: 604 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: p1.x - 25, y: p1.y, id: 603 },
        { x: p2.x + 25, y: p2.y, id: 604 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.evaluate(() => window.__rakeMe!.advance(600));
    const afterPinch = await page.evaluate(() => ({
      mode: window.__rakeMe!.auto().mode,
      working: window.__rakeMe!.auto().working,
      dist: window.__rakeMe!.state().camera.dist,
    }));
    expect(afterPinch.mode).toBe(true);
    expect(afterPinch.working).toBe(true);
    expect(afterPinch.dist).toBeLessThan(distBefore);
  });
});
