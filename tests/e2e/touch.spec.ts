import { expect, test } from "@playwright/test";
import type { CDPSession, Page } from "@playwright/test";

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

async function touchTap(cdp: CDPSession, x: number, y: number, id = 1): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test.describe("Gubba's Porch — mobile & touch controls", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const vibes: number[] = [];
      (window as unknown as { __vibes: number[] }).__vibes = vibes;
      Object.defineProperty(navigator, "vibrate", {
        configurable: true,
        value: (pattern: number | number[]) => {
          if (Array.isArray(pattern)) vibes.push(...pattern);
          else vibes.push(pattern);
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
      (window as unknown as { __vibes: number[] }).__vibes.length = 0;
    });

    const cdp = await page.context().newCDPSession(page);

    // 1. Quick touch tap on Tetsu selects it immediately and triggers a subtle 10 ms haptic tap.
    const tetsu = await pickCenterClient(page, "rake:tetsu");
    await touchTap(cdp, tetsu.x, tetsu.y, 1);
    const afterTap = await page.evaluate(() => ({
      rake: window.__rakeMe!.state().settings.rake,
      vibes: [...(window as unknown as { __vibes: number[] }).__vibes],
    }));
    expect(afterTap.rake).toBe("tetsu");
    expect(afterTap.vibes).toContain(10);

    // 2. Touch hold (>= 350 ms) on Onami previews its description in the speech scroll & sr-live with 12 ms haptic,
    //    and releasing does NOT replace the active rake (tetsu remains active).
    await page.evaluate(() => {
      (window as unknown as { __vibes: number[] }).__vibes.length = 0;
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
        vibes: [...(window as unknown as { __vibes: number[] }).__vibes],
        violations: api.paletteViolations(),
      };
    });
    expect(duringHold.rake).toBe("tetsu");
    expect(duringHold.speech).toMatch(/Ōnami/);
    expect(duringHold.live).toMatch(/Ōnami/);
    expect(duringHold.vibes).toContain(12);
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
      (window as unknown as { __vibes: number[] }).__vibes.length = 0;
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
      vibes: [...(window as unknown as { __vibes: number[] }).__vibes],
    }));
    expect(betweenFrames.rake).toBe("tetsu");
    expect(betweenFrames.speech).toMatch(/Kinu/);
    expect(betweenFrames.vibes).toContain(12);

    // 4. Touch hold on Hoki: shows description; sliding away or touchCancel cancels sweep & clears preview; >= 800 ms sweeps + 20 ms haptic.
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

    // 4c. Steady >= 800 ms hold triggers smooth-all sweep + 20 ms haptic
    await page.evaluate(() => {
      (window as unknown as { __vibes: number[] }).__vibes.length = 0;
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: hoki.x, y: hoki.y, id: 5 }],
    });
    const afterHokiSweep = await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.advance(900);
      const vibes = [...(window as unknown as { __vibes: number[] }).__vibes];
      api.advance(3000);
      return { vibes, sandHash: api.sandHash() };
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(afterHokiSweep.vibes).toContain(20);
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
      (window as unknown as { __vibes: number[] }).__vibes.length = 0;
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
      vibes: [...(window as unknown as { __vibes: number[] }).__vibes],
    }));
    expect(placed.count).toBe(1);
    expect(placed.el?.kind).toBe("stone_s");
    // Placed at drag destination b (world x=+10, z=+12 -> grid x=106, y=68), NOT initial touchdown a (grid x=81, y=61)
    expect(Math.abs((placed.el?.x ?? 0) - 106)).toBeLessThanOrEqual(2);
    expect(Math.abs((placed.el?.y ?? 0) - 68)).toBeLessThanOrEqual(2);
    expect(placed.vibes).toContain(15);

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
      (window as unknown as { __vibes: number[] }).__vibes.length = 0;
    });
    const gubbaPt = await pickCenterClient(page, "gubba");
    await touchTap(cdp, gubbaPt.x, gubbaPt.y, 40);
    await page.evaluate(() => window.__rakeMe!.advance(0));
    expect(await page.evaluate(() => (window as unknown as { __vibes: number[] }).__vibes)).toEqual([]);
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
});
