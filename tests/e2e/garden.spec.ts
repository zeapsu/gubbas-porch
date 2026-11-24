import { expect, test } from "@playwright/test";

test.describe("Gubba's Porch — 3D 8-bit Zen Garden E2E", () => {
  test("smoke: loads under /gubbas-porch/, WebGL2 active, all 30 real Blender GLBs loaded, zero console/request errors", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });
    page.on("requestfailed", (req) => errors.push(`requestfailed: ${req.url()}`));

    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));

    const info = await page.evaluate(() => {
      const api = window.__rakeMe!;
      return {
        failed: api.failedModels(),
        standIns: api.standInModels(),
        drawCalls: api.drawCalls(),
        fb: api.fbSize(),
        frameHash: api.frameHash(),
      };
    });

    expect(errors).toEqual([]);
    expect(info.failed).toEqual([]);
    expect(info.standIns).toEqual([]);
    expect(info.drawCalls).toBeLessThanOrEqual(60);
    expect(info.fb.cssW).toBe(info.fb.fbW * info.fb.scale);
    expect(info.fb.cssH).toBe(info.fb.fbH * info.fb.scale);
    expect(info.frameHash).not.toBe(0);
  });

  test("pixel rules: paletteViolations() === 0 across all moods, all 3 Gubba variants, cameras, densities & Settings tabs", async ({
    page,
  }) => {
    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    await page.locator("#title-card").click();

    for (const mood of ["morning", "afternoon", "dusk", "moonlit"] as const) {
      await page.evaluate((m) => window.__rakeMe!.setMood(m), mood);
      expect(await page.evaluate(() => window.__rakeMe!.paletteViolations()), `mood=${mood}`).toBe(0);
    }

    await page.evaluate(() => window.__rakeMe!.setMood("afternoon"));
    for (const variant of ["moss", "kasa", "lantern"] as const) {
      await page.evaluate((gv) => window.__rakeMe!.setGubbaVariant(gv), variant);
      expect(await page.evaluate(() => window.__rakeMe!.paletteViolations()), `gubba=${variant}`).toBe(0);
    }

    for (const cam of ["cozy", "topdown", "porch"] as const) {
      await page.evaluate((c) => window.__rakeMe!.setCamera(c), cam);
      expect(await page.evaluate(() => window.__rakeMe!.paletteViolations()), `camera=${cam}`).toBe(0);
    }

    for (const d of ["crisp", "chunky"] as const) {
      await page.evaluate((den) => window.__rakeMe!.setDensity(den), d);
      const { v, fb } = await page.evaluate(() => ({
        v: window.__rakeMe!.paletteViolations(),
        fb: window.__rakeMe!.fbSize(),
      }));
      expect(v, `density=${d}`).toBe(0);
      expect(fb.cssW).toBe(fb.fbW * fb.scale);
      expect(fb.cssH).toBe(fb.fbH * fb.scale);
    }

    for (const tab of ["look", "garden", "sound", "presets"] as const) {
      await page.evaluate((t) => window.__rakeMe!.openPanel("settings", t), tab);
      expect(await page.evaluate(() => window.__rakeMe!.paletteViolations()), `tab=${tab}`).toBe(0);
    }
  });

  test("settings tab swaps Gubba variants (Moss/Kasa/Lantern) and Mood (Auto/manual) live and persists across reload", async ({
    page,
  }) => {
    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    await page.locator("#title-card").click();

    await page.evaluate(() => window.__rakeMe!.openPanel("settings", "look"));

    const kasa = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const hit = api.overlayHits().find(
        (h) => h.action.type === "settings" && h.action.patch.gubbaVariant === "kasa",
      );
      if (!hit) return null;
      api.clickOverlay(hit.x + hit.w / 2, hit.y + hit.h / 2);
      return api.state().settings.gubbaVariant;
    });
    expect(kasa).toBe("kasa");

    const dusk = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const hit = api.overlayHits().find(
        (h) => h.action.type === "settings" && h.action.patch.moodSetting === "dusk",
      );
      if (!hit) return null;
      api.clickOverlay(hit.x + hit.w / 2, hit.y + hit.h / 2);
      return { moodSetting: api.state().settings.moodSetting, mood: api.state().mood };
    });
    expect(dusk).toEqual({ moodSetting: "dusk", mood: "dusk" });

    // Verify persistence across reload
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    const persisted = await page.evaluate(() => ({
      variant: window.__rakeMe!.state().settings.gubbaVariant,
      moodSetting: window.__rakeMe!.state().settings.moodSetting,
      mood: window.__rakeMe!.state().mood,
    }));
    expect(persisted).toEqual({ variant: "kasa", moodSetting: "dusk", mood: "dusk" });

    // Switch back to Auto mood and Lantern variant
    await page.locator("#title-card").click();
    await page.evaluate(() => window.__rakeMe!.openPanel("settings", "look"));
    const swapped = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const autoHit = api.overlayHits().find(
        (h) => h.action.type === "settings" && h.action.patch.moodSetting === "auto",
      );
      if (autoHit) api.clickOverlay(autoHit.x + autoHit.w / 2, autoHit.y + autoHit.h / 2);
      const lanternHit = api.overlayHits().find(
        (h) => h.action.type === "settings" && h.action.patch.gubbaVariant === "lantern",
      );
      if (lanternHit) api.clickOverlay(lanternHit.x + lanternHit.w / 2, lanternHit.y + lanternHit.h / 2);
      return {
        moodSetting: api.state().settings.moodSetting,
        variant: api.state().settings.gubbaVariant,
      };
    });
    expect(swapped).toEqual({ moodSetting: "auto", variant: "lantern" });
  });

  test("portrait phone (390x844): the turn-sideways prompt covers the garden; turned to 844x390 all 4 Settings tabs are onscreen in Crisp and Chunky", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));

    // Upright, the garden waits behind the prompt (DESIGN.md D8); tests/e2e/viewports.spec.ts covers it in depth
    await expect(page.locator("#rotate-prompt")).toBeVisible();
    expect(await page.evaluate(() => window.__rakeMe!.state().rotateBlocked)).toBe(true);

    const tabsOnscreen = async (density: "crisp" | "chunky") => {
      await page.evaluate((d) => {
        window.__rakeMe!.setDensity(d);
        window.__rakeMe!.openPanel("settings", "look");
      }, density);
      return page.evaluate(() => {
        const api = window.__rakeMe!;
        const { fbW, fbH } = api.fbSize();
        const tabs = api.overlayHits().filter((h) => h.action.type === "tab");
        return {
          count: tabs.length,
          allOnscreen: tabs.every((t) => t.x >= 0 && t.y >= 0 && t.x + t.w <= fbW && t.y + t.h <= fbH),
        };
      });
    };

    // The overlay behind the prompt still lays out inside the framebuffer
    for (const density of ["crisp", "chunky"] as const) {
      expect(await tabsOnscreen(density), `upright density=${density}`).toEqual({ count: 4, allOnscreen: true });
    }

    // Turned sideways the prompt leaves and the garden plays
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator("#rotate-prompt")).toBeHidden();
    await page.locator("#title-card").click();
    for (const density of ["crisp", "chunky"] as const) {
      expect(await tabsOnscreen(density), `landscape density=${density}`).toEqual({ count: 4, allOnscreen: true });
    }
  });

  test("real pointer raking, camera freeze during stroke, deck orbit, Wall of Rakes click, stones move/remove, Watch Gubba Rake, audio & accessibility", async ({
    page,
  }) => {
    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));

    // Audio locked before gesture
    expect((await page.evaluate(() => window.__rakeMe!.audio)).state).toBe("locked");

    // Click title card to unlock audio
    await page.locator("#title-card").click();
    await page.waitForTimeout(120);
    expect((await page.evaluate(() => window.__rakeMe!.audio)).state).toBe("running");

    // Mute sets masterGain to 0 after ramp
    await page.keyboard.press("m");
    await page.waitForTimeout(200);
    expect((await page.evaluate(() => window.__rakeMe!.audio)).masterGain).toBeLessThan(0.001);
    await page.keyboard.press("m");

    // Start an in-flight camera preset ease, then press down on sand: camera damping MUST freeze while raking!
    const box = (await page.locator("#garden-canvas").boundingBox())!;
    const hashBefore = await page.evaluate(() => window.__rakeMe!.sandHash());

    await page.keyboard.press("c"); // queues camera transition toward topdown
    await page.evaluate(() => window.__rakeMe!.advance(50)); // partial ease in progress
    const camAtDown = await page.evaluate(() => window.__rakeMe!.state().camera);

    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.52);
    await page.mouse.down();
    await page.evaluate(() => window.__rakeMe!.advance(300)); // would keep easing if freeze were broken!
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.56, { steps: 6 });
    const camMidDrag = await page.evaluate(() => window.__rakeMe!.state().camera);
    expect(camMidDrag.az).toBeCloseTo(camAtDown.az, 5);
    expect(camMidDrag.el).toBeCloseTo(camAtDown.el, 5);
    await page.mouse.up();
    await page.evaluate(() => window.__rakeMe!.setCamera("cozy"));
    const camBefore = await page.evaluate(() => window.__rakeMe!.state().camera);

    const hashAfterDrag = await page.evaluate(() => window.__rakeMe!.sandHash());
    expect(hashAfterDrag).not.toBe(hashBefore);

    // Undo restores exact pre-drag hash; redo reapplies
    expect(await page.evaluate(() => { window.__rakeMe!.undo(); return window.__rakeMe!.sandHash(); })).toBe(hashBefore);
    expect(await page.evaluate(() => { window.__rakeMe!.redo(); return window.__rakeMe!.sandHash(); })).toBe(hashAfterDrag);

    // Real pointer drag on the sky/deck orbits camera
    await page.mouse.move(box.x + box.width * 0.92, box.y + box.height * 0.12);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.80, box.y + box.height * 0.16, { steps: 4 });
    await page.mouse.up();
    await page.evaluate(() => window.__rakeMe!.advance(600));
    const camOrbited = await page.evaluate(() => window.__rakeMe!.state().camera);
    expect(Math.abs(camOrbited.az - camBefore.az)).toBeGreaterThan(0.05);

    // Reset camera to cozy and click a hanging rake on the Wall of Rakes via real canvas click
    await page.evaluate(() => window.__rakeMe!.setCamera("cozy"));
    const tetsuClient = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      for (let y = 10; y < fbH * 0.45; y += 2) {
        for (let x = 10; x < fbW - 10; x += 2) {
          const p = api.pick(x, y);
          if (p.kind === "rake" && p.id === "tetsu") {
            return { cx: rect.left + (x / fbW) * rect.width, cy: rect.top + (y / fbH) * rect.height };
          }
        }
      }
      return null;
    });
    expect(tetsuClient).not.toBeNull();
    await page.mouse.click(tetsuClient!.cx, tetsuClient!.cy);
    expect(await page.evaluate(() => window.__rakeMe!.state().settings.rake)).toBe("tetsu");

    // Place a stone, drag it on canvas to move it, then drag it off-bed to remove it
    const count0 = await page.evaluate(() => window.__rakeMe!.state().elementCount);
    expect(await page.evaluate(() => window.__rakeMe!.placeElement("stone_s", 96, 56))).toBe(true);
    const addedBefore = await page.evaluate(() => window.__rakeMe!.state().elements.at(-1)!);
    const stoneClient = await page.evaluate((targetId) => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let y = Math.floor(fbH * 0.3); y < Math.floor(fbH * 0.85); y += 1) {
        for (let x = Math.floor(fbW * 0.2); x < Math.floor(fbW * 0.8); x += 1) {
          const p = api.pick(x, y);
          if (p.kind === "element" && p.id === targetId) {
            sx += x + 0.5;
            sy += y + 0.5;
            n++;
          }
        }
      }
      if (n === 0) return null;
      return { cx: rect.left + (sx / n / fbW) * rect.width, cy: rect.top + (sy / n / fbH) * rect.height };
    }, addedBefore.id);
    expect(stoneClient).not.toBeNull();
    await page.mouse.move(stoneClient!.cx, stoneClient!.cy);
    await page.mouse.down();
    await page.mouse.move(stoneClient!.cx + 55, stoneClient!.cy + 12, { steps: 4 });
    await page.mouse.up();
    await page.evaluate(() => window.__rakeMe!.advance(50));
    const movedStone = await page.evaluate((id) => window.__rakeMe!.state().elements.find((e) => e.id === id)!, addedBefore.id);
    expect(movedStone.x).not.toBe(addedBefore.x);
    const movedClient = await page.evaluate((targetId) => {
      const api = window.__rakeMe!;
      const { fbW, fbH } = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let y = Math.floor(fbH * 0.3); y < Math.floor(fbH * 0.85); y += 1) {
        for (let x = Math.floor(fbW * 0.2); x < Math.floor(fbW * 0.8); x += 1) {
          const p = api.pick(x, y);
          if (p.kind === "element" && p.id === targetId) {
            sx += x + 0.5;
            sy += y + 0.5;
            n++;
          }
        }
      }
      if (n === 0) return null;
      return { cx: rect.left + (sx / n / fbW) * rect.width, cy: rect.top + (sy / n / fbH) * rect.height };
    }, addedBefore.id);
    expect(movedClient).not.toBeNull();
    await page.mouse.move(movedClient!.cx, movedClient!.cy);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.92, box.y + box.height * 0.85, { steps: 4 });
    await page.mouse.up();
    await page.evaluate(() => window.__rakeMe!.advance(50));
    expect(await page.evaluate(() => window.__rakeMe!.state().elementCount)).toBe(count0);

    // Verify collision-free stone ID generation across undo + reload + place
    expect(await page.evaluate(() => window.__rakeMe!.placeElement("stone_s", 80, 40))).toBe(true);
    await page.evaluate(() => window.__rakeMe!.undo());
    expect(await page.evaluate(() => window.__rakeMe!.placeElement("stone_s", 84, 44))).toBe(true);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    await page.locator("#title-card").click();
    expect(await page.evaluate(() => window.__rakeMe!.placeElement("stone_s", 90, 48))).toBe(true);
    expect(await page.evaluate(() => window.__rakeMe!.state().elementCount)).toBe(count0 + 2);

    // Verify accessible keyboard stone placement (focus Basket button -> Enter -> ArrowRight -> Enter)
    const beforeKbCount = await page.evaluate(() => window.__rakeMe!.state().elementCount);
    await page.locator('#sr-controls button[data-control="basket-pin"]').focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.__rakeMe!.state().elementCount)).toBe(beforeKbCount + 1);

    // Watch Gubba rake on three_islands matches exact golden hash 0x5759828d and single Undo restores prior garden
    const beforeWatchHash = await page.evaluate(() => window.__rakeMe!.sandHash());
    await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.setFlow(false);
      api.setWatchGubbaRake(true);
      api.loadPreset("three_islands");
      api.advance(90_000);
    });
    expect(await page.evaluate(() => window.__rakeMe!.sandHash())).toBe(0x5759828d);
    await page.evaluate(() => window.__rakeMe!.undo());
    expect(await page.evaluate(() => window.__rakeMe!.sandHash())).toBe(beforeWatchHash);

    // Export PNG matches framebuffer * scale
    const exp = await page.evaluate(async () => {
      const fb = window.__rakeMe!.fbSize();
      const png = await window.__rakeMe!.exportPng(4, true);
      return { fb, png };
    });
    expect(exp.png.width).toBe(exp.fb.fbW * 4);
    expect(exp.png.height).toBe(exp.fb.fbH * 4);

    // Accessible DOM mirror covers rakes, HUD, Settings, Basket items, Watch toggle & 4 mix channels
    const srButtons = await page.locator("#sr-controls button").count();
    expect(srButtons).toBeGreaterThanOrEqual(45);
    expect(((await page.locator("#sr-live").textContent()) ?? "").trim().length).toBeGreaterThan(0);
  });

  test("visual parity snapshots: Afternoon Cozy Moss, Dusk Porch Lantern, Moonlit Settings Kasa", async ({
    page,
  }) => {
    await page.goto("?test=1");
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    await page.locator("#title-card").click();

    await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.loadPreset("three_islands");
      api.setGubbaVariant("moss");
      api.setMood("afternoon");
      api.setCamera("cozy");
      api.setDensity("crisp");
    });
    const hash1 = await page.evaluate(() => window.__rakeMe!.frameHash());
    await page.screenshot({ path: "test-results/verify-cozy-afternoon-moss.png" });
    await page.evaluate(() => window.__rakeMe!.advance(0));
    const hash2 = await page.evaluate(() => window.__rakeMe!.frameHash());
    expect(hash1).not.toBe(0);
    expect(hash2).toBe(hash1);

    await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.setGubbaVariant("lantern");
      api.setMood("dusk");
      api.setCamera("porch");
    });
    const hashDusk = await page.evaluate(() => window.__rakeMe!.frameHash());
    expect(hashDusk).not.toBe(hash1);
    await page.screenshot({ path: "test-results/verify-porch-dusk-lantern.png" });

    await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.setGubbaVariant("kasa");
      api.setMood("moonlit");
      api.setCamera("cozy");
      api.openPanel("settings", "look");
    });
    const hashMoon = await page.evaluate(() => window.__rakeMe!.frameHash());
    expect(hashMoon).not.toBe(hashDusk);
    await page.screenshot({ path: "test-results/verify-settings-moonlit-kasa.png" });

    expect(await page.evaluate(() => window.__rakeMe!.paletteViolations())).toBe(0);
  });
});
