import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Gubba mode and "Watch: Gubba rakes": Gubba gets up, turns the garden into a preset with real stone moves,
// smoothing and strokes, and goes back to his cushion. Everything runs on the injected test clock (`advance`).

type Api = NonNullable<Window["__rakeMe"]>;
type Auto = ReturnType<Api["auto"]>;
type PresetId = NonNullable<Auto["target"]>;

const GOLDEN: Readonly<Record<PresetId, number>> = {
  still_sand: 0xb23a71c5,
  three_islands: 0x5759828d,
  ripple_pond: 0xa597d0e9,
  old_sea: 0xf9198db1,
  river_bend: 0xdf6dd12c,
  snails_thought: 0x5fb27ec9,
  checker_field: 0x4468d9c5,
};
const TARGET_STONES: Readonly<Record<PresetId, readonly string[]>> = {
  still_sand: [],
  three_islands: ["stone_l@52,54", "stone_m@132,80", "stone_tall@166,32"],
  ripple_pond: ["stone_m@96,56"],
  old_sea: [],
  river_bend: ["stone_flat@136,58", "stone_m@54,52"],
  snails_thought: [],
  checker_field: [],
};
const HOME = { x: 132, z: 2 };
const GARDEN_KEY = "rake-me:garden:v1";

/** Conditions on `auto()`; every one given has to hold. */
interface Until {
  phase?: Auto["phase"];
  raking?: boolean;
  heldRake?: string | null;
  carrying?: boolean;
  seated?: boolean;
  working?: boolean;
  /** Standing on the sand. */
  onBed?: boolean;
  /** At least this many gardens finished. */
  cycles?: number;
  minX?: number;
  targetNot?: PresetId;
}

async function open(page: Page): Promise<void> {
  await page.goto("?test=1");
  await page.waitForFunction(() => Boolean(window.__rakeMe));
  await page.locator("#title-card").click();
}

const auto = (page: Page): Promise<Auto> => page.evaluate(() => window.__rakeMe!.auto());
const hash = (page: Page): Promise<number> => page.evaluate(() => window.__rakeMe!.sandHash());
const undoCount = (page: Page): Promise<number> => page.evaluate(() => window.__rakeMe!.state().undoCount);
const violations = (page: Page): Promise<number> => page.evaluate(() => window.__rakeMe!.paletteViolations());
const stones = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__rakeMe!.state().elements.map((e) => `${e.kind}@${e.x},${e.y}`).sort());
const fromHome = (a: Auto): number => Math.hypot(a.rootPos.x - HOME.x, a.rootPos.z - HOME.z);

/** The garden as it is saved right now (a `pagehide` flushes the debounced save). */
async function savedGarden(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    window.dispatchEvent(new Event("pagehide"));
    return window.localStorage.getItem(key);
  }, GARDEN_KEY);
}

/** Advances the test clock in steps until `until` holds or `maxMs` has passed. Returns the state it stopped in. */
async function advanceUntil(page: Page, until: Until, maxMs = 600_000, stepMs = 250): Promise<Auto> {
  const reached = await page.evaluate(
    ([u, max, step]) => {
      const api = window.__rakeMe!;
      const holds = (): boolean => {
        const a = api.auto();
        return (
          (u.phase === undefined || a.phase === u.phase) &&
          (u.raking === undefined || a.raking === u.raking) &&
          (u.heldRake === undefined || a.heldRake === u.heldRake) &&
          (u.carrying === undefined || (a.carriedKind !== null) === u.carrying) &&
          (u.seated === undefined || a.seated === u.seated) &&
          (u.working === undefined || a.working === u.working) &&
          (u.onBed === undefined || (Math.abs(a.rootPos.x) < 96 && Math.abs(a.rootPos.z) < 56) === u.onBed) &&
          (u.cycles === undefined || a.cyclesCompleted >= u.cycles) &&
          (u.minX === undefined || a.rootPos.x >= u.minX) &&
          (u.targetNot === undefined || (a.target !== null && a.target !== u.targetNot))
        );
      };
      let t = 0;
      for (; t < max && !holds(); t += step) api.advance(step);
      return { ok: holds(), a: api.auto() };
    },
    [until, maxMs, stepMs] as const,
  );
  expect(reached.ok, `never reached ${JSON.stringify(until)}; stopped at ${JSON.stringify(reached.a)}`).toBe(true);
  return reached.a;
}

/** A world point as CSS pixels on the page, under the current camera. */
async function toClient(page: Page, x: number, y: number, z: number): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(
    ([wx, wy, wz]) => {
      const api = window.__rakeMe!;
      const fb = api.project(wx, wy, wz);
      const size = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      return fb ? { x: rect.left + (fb.x / size.fbW) * rect.width, y: rect.top + (fb.y / size.fbH) * rect.height } : null;
    },
    [x, y, z] as const,
  );
  expect(p).not.toBeNull();
  return p!;
}

/** Clicks an overlay control (found by its action) with the real mouse. */
async function clickOverlay(page: Page, type: string, match: Record<string, unknown>): Promise<void> {
  const p = await page.evaluate(
    ([t, m]) => {
      const api = window.__rakeMe!;
      const hit = api
        .overlayHits()
        .find((h) => h.action.type === t && Object.entries(m).every(([k, v]) => (h.action as unknown as Record<string, unknown>)[k] === v));
      if (!hit) return null;
      const size = api.fbSize();
      const rect = document.getElementById("garden-canvas")!.getBoundingClientRect();
      return {
        x: rect.left + ((hit.x + hit.w / 2) / size.fbW) * rect.width,
        y: rect.top + ((hit.y + hit.h / 2) / size.fbH) * rect.height,
      };
    },
    [type, match] as const,
  );
  expect(p, `no overlay control ${type} ${JSON.stringify(match)}`).not.toBeNull();
  await page.mouse.click(p!.x, p!.y);
  await page.evaluate(() => window.__rakeMe!.advance(0));
}

test.describe("Gubba mode and Watch: Gubba rakes", () => {
  test("R turns Gubba mode on: he leaves his cushion, which stays on the porch, and nothing reaches the undo history", async ({
    page,
  }) => {
    await open(page);
    const undo0 = await undoCount(page);
    expect((await auto(page)).seated).toBe(true);

    // Ctrl+R is the browser's, not ours
    expect(await page.evaluate(() => window.__rakeMe!.state().gubbaMode)).toBe(false);

    await page.keyboard.press("r");
    let a = await auto(page);
    expect(a.mode).toBe(true);
    expect(a.working).toBe(true);
    // the opening garden is Three Islands, so that is never the first thing he chooses
    expect(a.target).not.toBeNull();
    expect(a.target).not.toBe("three_islands");
    expect(await page.evaluate(() => window.__rakeMe!.state().gubbaMode)).toBe(true);
    expect(await page.locator('#sr-controls button[data-control="gubba-mode"]').getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator("#sr-live").textContent()).toContain("Gubba mode on");

    // he walks: never a jump, and soon well away from the cushion
    let prev = a.rootPos;
    for (let i = 0; i < 40; i++) {
      a = await page.evaluate(() => {
        window.__rakeMe!.advance(50);
        return window.__rakeMe!.auto();
      });
      expect(Math.hypot(a.rootPos.x - prev.x, a.rootPos.z - prev.z)).toBeLessThanOrEqual(34 * 0.05 + 0.01);
      prev = a.rootPos;
    }
    a = await advanceUntil(page, { onBed: true });
    expect(fromHome(a)).toBeGreaterThan(20);
    expect(a.seated).toBe(false);
    expect(a.rootPos.y).toBeGreaterThan(2.9);

    // on the bed: still a clean 32-colour frame, and no more draw calls than the budget
    expect(await violations(page)).toBe(0);
    expect(await page.evaluate(() => window.__rakeMe!.drawCalls())).toBeLessThanOrEqual(60);
    expect(await undoCount(page)).toBe(undo0);

    // the cushion is where it was, and still part of Gubba to the pointer; Gubba himself is elsewhere
    const picks = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const a2 = api.auto();
      const cushion = api.project(132, 2.5, 2)!;
      const body = api.project(a2.rootPos.x, a2.rootPos.y + 14, a2.rootPos.z)!;
      return { cushion: api.pick(cushion.x, cushion.y).kind, body: api.pick(body.x, body.y).kind };
    });
    expect(picks.cushion).toBe("gubba");
    expect(picks.body).toBe("gubba");

    // R again sends him home without an edit; whatever he did so far is one undo entry at most
    await page.keyboard.press("r");
    expect((await auto(page)).mode).toBe(false);
    expect(await page.locator("#sr-live").textContent()).toContain("Gubba mode off");
    a = await advanceUntil(page, { seated: true, working: false });
    expect(a.heldRake).toBeNull();
    expect(a.carriedKind).toBeNull();
    expect(fromHome(a)).toBe(0);
    expect(await undoCount(page)).toBeLessThanOrEqual(undo0 + 1);
  });

  test("the Gubba mode chip on Settings → Presets turns it on and off", async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__rakeMe!.openPanel("settings", "presets"));
    const rows = await page.evaluate(() =>
      window.__rakeMe!
        .overlayHits()
        .filter((h) => h.action.type === "watch" || h.action.type === "gubba_mode" || h.action.type === "export")
        .map((h) => ({ type: h.action.type, y: h.y })),
    );
    const yOf = (type: string): number => rows.find((r) => r.type === type)!.y;
    // right below Watch, above Export
    expect(yOf("gubba_mode")).toBeGreaterThan(yOf("watch"));
    expect(yOf("export")).toBeGreaterThan(yOf("gubba_mode"));
    expect(rows.filter((r) => r.type === "gubba_mode")).toHaveLength(2);

    await clickOverlay(page, "gubba_mode", { on: true });
    let a = await auto(page);
    expect(a.mode).toBe(true);
    expect(a.working).toBe(true);
    // the panel steps aside so there is something to watch
    expect(await page.evaluate(() => window.__rakeMe!.state().panel)).toBe("none");

    a = await advanceUntil(page, { onBed: true });
    expect(fromHome(a)).toBeGreaterThan(20);

    // opening and switching panels is not an edit
    await page.evaluate(() => {
      window.__rakeMe!.openPanel("settings", "look");
      window.__rakeMe!.openPanel("basket");
      window.__rakeMe!.openPanel("settings", "presets");
    });
    expect((await auto(page)).mode).toBe(true);
    expect(await violations(page)).toBe(0);

    await clickOverlay(page, "gubba_mode", { on: false });
    expect((await auto(page)).mode).toBe(false);
    expect(await page.evaluate(() => window.__rakeMe!.state().panel)).toBe("settings");
  });

  test("a whole garden, then on into the next: golden sand, no undo entries, and the saved garden is still the player's", async ({
    page,
  }) => {
    await open(page);
    const before = await savedGarden(page);
    expect(before).not.toBeNull();
    const undo0 = await undoCount(page);
    const haptics0 = await page.evaluate(() => window.__rakeMe!.haptics().count);

    await page.evaluate(() => window.__rakeMe!.setGubbaMode(true));
    const first = (await auto(page)).target!;
    let a = await advanceUntil(page, { cycles: 1, seated: true }, 600_000, 500);
    expect(a.working).toBe(false);
    expect(a.phase).toBe("admiring");
    expect(a.heldRake).toBeNull();
    expect(a.carriedKind).toBeNull();
    expect(fromHome(a)).toBe(0);
    expect(a.lastSealDiffCells).toBeLessThanOrEqual(64);
    expect(await hash(page)).toBe(GOLDEN[first]);
    expect(await stones(page)).toEqual(TARGET_STONES[first]);
    expect(await violations(page)).toBe(0);
    expect(await undoCount(page)).toBe(undo0);
    expect(await savedGarden(page)).toBe(before);

    // he looks it over for 20–32 s, then gets up again for a different garden
    await page.evaluate(() => window.__rakeMe!.advance(19_000));
    expect((await auto(page)).phase).toBe("admiring");
    a = await advanceUntil(page, { working: true }, 14_000, 250);
    expect(a.mode).toBe(true);
    expect(a.target).not.toBeNull();
    expect(a.target).not.toBe(first);
    const second = a.target!;
    a = await advanceUntil(page, { cycles: 2, seated: true }, 600_000, 500);
    expect(await hash(page)).toBe(GOLDEN[second]);
    expect(await stones(page)).toEqual(TARGET_STONES[second]);
    expect(a.lastSealDiffCells).toBeLessThanOrEqual(64);

    // two gardens later: still nothing in the undo history, the save untouched, and never a haptic
    expect(await undoCount(page)).toBe(undo0);
    expect(await savedGarden(page)).toBe(before);
    expect(await page.evaluate(() => window.__rakeMe!.haptics().count)).toBe(haptics0);

    // a reload mid-run comes back to the player's garden, with Gubba seated and the mode off
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__rakeMe));
    expect(await hash(page)).toBe(GOLDEN.three_islands);
    expect((await auto(page)).mode).toBe(false);
  });

  test("a real drag on the sand mid-stroke: Gubba mode turns off, he walks his rake home, and two undos restore the garden byte for byte", async ({
    page,
  }) => {
    await open(page);
    const before = await savedGarden(page);
    const hash0 = await hash(page);
    const stones0 = await stones(page);
    const undo0 = await undoCount(page);

    await page.evaluate(() => {
      window.__rakeMe!.setGubbaMode(true);
      window.__rakeMe!.autoRequest("old_sea");
    });
    await advanceUntil(page, { phase: "raking", raking: true });
    await page.evaluate(() => window.__rakeMe!.advance(2000));
    let a = await advanceUntil(page, { phase: "raking", raking: true });
    expect(a.heldRake).toBe("mikazuki");
    expect(await undoCount(page)).toBe(undo0);
    const at = a.rootPos;

    // press on the sand, well away from him
    const z = a.rootPos.z < 0 ? 36 : -36;
    const from = await toClient(page, -50, 3, z);
    const to = await toClient(page, 10, 3, z);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    a = await auto(page);
    expect(a.mode).toBe(false);
    expect(a.raking).toBe(false);
    // no teleport: he is where he was, with his rake still in his hands
    expect(Math.hypot(a.rootPos.x - at.x, a.rootPos.z - at.z)).toBeLessThan(2);
    expect(a.heldRake).toBe("mikazuki");
    expect(a.phase).toBe("yielding");
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await page.evaluate(() => window.__rakeMe!.advance(50));
    // his work is one entry, the player's stroke another
    expect(await undoCount(page)).toBe(undo0 + 2);
    expect(await page.locator('#sr-controls button[data-control="gubba-mode"]').getAttribute("aria-pressed")).toBe("false");

    // he walks home: every step small, the rake hung on the way
    let prev = (await auto(page)).rootPos;
    for (let i = 0; i < 30; i++) {
      a = await page.evaluate(() => {
        window.__rakeMe!.advance(100);
        return window.__rakeMe!.auto();
      });
      expect(Math.hypot(a.rootPos.x - prev.x, a.rootPos.z - prev.z)).toBeLessThanOrEqual(34 * 0.1 + 0.01);
      prev = a.rootPos;
    }
    a = await advanceUntil(page, { seated: true, working: false });
    expect(a.heldRake).toBeNull();
    expect(fromHome(a)).toBe(0);
    expect(a.phase).toBe("idle");
    expect(await undoCount(page)).toBe(undo0 + 2);

    expect(await page.evaluate(() => window.__rakeMe!.undo())).toBe(true);
    expect(await page.evaluate(() => window.__rakeMe!.undo())).toBe(true);
    expect(await hash(page)).toBe(hash0);
    expect(await stones(page)).toEqual(stones0);
    expect(await savedGarden(page)).toBe(before);
  });

  test("tapping Gubba mid-rake gets a line and leaves Gubba mode on", async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      window.__rakeMe!.setGubbaMode(true);
      window.__rakeMe!.autoRequest("checker_field");
    });
    await advanceUntil(page, { phase: "raking", raking: true });
    // well into the garden, and with the rake down (not walking between two strokes)
    await page.evaluate(() => window.__rakeMe!.advance(8000));
    let a = await advanceUntil(page, { phase: "raking", raking: true });
    expect(await page.evaluate(() => window.__rakeMe!.state().speech)).toBeNull();

    const body = await toClient(page, a.rootPos.x, a.rootPos.y + 14, a.rootPos.z);
    await page.mouse.click(body.x, body.y);
    await page.evaluate(() => window.__rakeMe!.advance(50));
    const speech = await page.evaluate(() => window.__rakeMe!.state().speech);
    expect(speech).not.toBeNull();
    expect(await page.locator("#sr-live").textContent()).toBe(speech);
    a = await auto(page);
    expect(a.mode).toBe(true);
    expect(a.working).toBe(true);
    expect(a.phase).toBe("raking");

    // his rake is him too: the pointer finds Gubba on it, not a rake to select
    const onRake = await page.evaluate(() => {
      const api = window.__rakeMe!;
      const b = api.pickBounds();
      return { rakeListed: Object.keys(b).includes("rake:sugi"), gubba: b.gubba !== undefined };
    });
    expect(onRake.rakeListed).toBe(false);
    expect(onRake.gubba).toBe(true);

    // camera, mood, variant, sound, rain and breath are not edits either
    await page.keyboard.press("c");
    await page.keyboard.press("t");
    await page.keyboard.press("m");
    await page.keyboard.press("b");
    await page.evaluate(() => {
      window.__rakeMe!.setRain(true);
      window.__rakeMe!.setGubbaVariant("kasa");
      window.__rakeMe!.advance(500);
    });
    expect((await auto(page)).mode).toBe(true);
  });

  test("Z mid-run takes back everything Gubba did; redo brings his partial work back", async ({ page }) => {
    await open(page);
    const hash0 = await hash(page);
    const stones0 = await stones(page);
    const undo0 = await undoCount(page);

    await page.evaluate(() => {
      window.__rakeMe!.setGubbaMode(true);
      window.__rakeMe!.autoRequest("river_bend");
    });
    await advanceUntil(page, { phase: "raking", raking: true });
    // between two strokes, so the sand he has left is exactly what gets committed
    await advanceUntil(page, { phase: "raking", raking: false });
    const partial = await hash(page);
    const partialStones = await stones(page);
    expect(partial).not.toBe(hash0);
    expect(partial).not.toBe(GOLDEN.river_bend);
    expect(await undoCount(page)).toBe(undo0);

    await page.keyboard.press("z");
    await page.evaluate(() => window.__rakeMe!.advance(0));
    expect((await auto(page)).mode).toBe(false);
    expect(await hash(page)).toBe(hash0);
    expect(await stones(page)).toEqual(stones0);
    expect(await undoCount(page)).toBe(undo0);
    expect(await page.evaluate(() => window.__rakeMe!.state().redoCount)).toBe(1);

    await page.keyboard.press("Shift+Z");
    await page.evaluate(() => window.__rakeMe!.advance(0));
    expect(await hash(page)).toBe(partial);
    expect(await stones(page)).toEqual(partialStones);
    expect(await undoCount(page)).toBe(undo0 + 1);

    const a = await advanceUntil(page, { seated: true, working: false });
    expect(a.heldRake).toBeNull();
    // walking home changed nothing
    expect(await hash(page)).toBe(partial);
  });

  test("a preset chip in Gubba mode re-plans toward that garden without snapping to it, then the loop goes on", async ({
    page,
  }) => {
    await open(page);
    const undo0 = await undoCount(page);
    await page.evaluate(() => window.__rakeMe!.setGubbaMode(true));
    const drawn = (await auto(page)).target!;
    const chosen: PresetId = drawn === "snails_thought" ? "old_sea" : "snails_thought";
    await advanceUntil(page, { onBed: true });
    await page.evaluate(() => window.__rakeMe!.advance(4000));
    const stonesAtClick = await stones(page);

    await page.evaluate(() => window.__rakeMe!.openPanel("settings", "presets"));
    await clickOverlay(page, "preset", { id: chosen });
    let a = await auto(page);
    expect(a.mode).toBe(true);
    expect(a.working).toBe(true);
    expect(a.target).toBe(chosen);
    expect(a.seated).toBe(false);
    // nothing snapped: the sand and the stones are as they were a moment ago
    expect(await hash(page)).not.toBe(GOLDEN[chosen]);
    expect(await stones(page)).toEqual(stonesAtClick);
    expect(await undoCount(page)).toBe(undo0);

    a = await advanceUntil(page, { cycles: 1, seated: true }, 600_000, 500);
    expect(await hash(page)).toBe(GOLDEN[chosen]);
    expect(await stones(page)).toEqual(TARGET_STONES[chosen]);
    expect(a.lastSealDiffCells).toBeLessThanOrEqual(64);
    expect(await undoCount(page)).toBe(undo0);

    // and after looking it over he chooses for himself again
    a = await advanceUntil(page, { working: true, targetNot: chosen }, 40_000, 250);
    expect(a.mode).toBe(true);
  });

  test("Watch: Gubba rakes with Gubba mode off: one garden, one undo entry, and he stays seated", async ({ page }) => {
    await open(page);
    const hash0 = await hash(page);
    const stones0 = await stones(page);
    const undo0 = await undoCount(page);

    await page.locator('#sr-controls button[data-control="watch-gubba-rake"]').focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.__rakeMe!.state().watchGubbaRake)).toBe(true);
    await page.locator('#sr-controls button[data-control="preset-ripple_pond"]').focus();
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.__rakeMe!.advance(0));

    let a = await auto(page);
    expect(a.mode).toBe(false);
    expect(a.watch).toBe(true);
    expect(a.working).toBe(true);
    expect(a.target).toBe("ripple_pond");
    expect(await hash(page)).toBe(hash0);

    a = await advanceUntil(page, { onBed: true });
    expect(fromHome(a)).toBeGreaterThan(20);
    a = await advanceUntil(page, { carrying: true });
    expect(a.phase).toBe("stones");
    expect(await undoCount(page)).toBe(undo0);

    a = await advanceUntil(page, { seated: true, working: false }, 600_000, 500);
    expect(a.cyclesCompleted).toBe(1);
    expect(a.sandPlan).toBe("sweep");
    expect(a.lastSealDiffCells).toBeLessThanOrEqual(64);
    expect(a.heldRake).toBeNull();
    expect(fromHome(a)).toBe(0);
    expect(await hash(page)).toBe(GOLDEN.ripple_pond);
    expect(await stones(page)).toEqual(TARGET_STONES.ripple_pond);
    expect(await undoCount(page)).toBe(undo0 + 1);

    // no second garden: a minute later he is still sitting there
    await page.evaluate(() => window.__rakeMe!.advance(60_000));
    a = await auto(page);
    expect(a.seated).toBe(true);
    expect(a.working).toBe(false);
    expect(a.target).toBeNull();
    expect(a.cyclesCompleted).toBe(1);
    expect(await hash(page)).toBe(GOLDEN.ripple_pond);

    expect(await page.evaluate(() => window.__rakeMe!.undo())).toBe(true);
    expect(await hash(page)).toBe(hash0);
    expect(await stones(page)).toEqual(stones0);

    // asking for the garden that is already there is nothing to watch
    expect(await page.evaluate(() => window.__rakeMe!.autoRequest("three_islands"))).toBe(false);
    expect((await auto(page)).working).toBe(false);
  });

  test("reduced motion: Gubba stays on his cushion, the rakes stay on the wall, and the sand still reaches the preset", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    const undo0 = await undoCount(page);
    await page.keyboard.press("r");
    let a = await auto(page);
    expect(a.mode).toBe(true);
    const target = a.target!;

    let changed = false;
    const hash0 = await hash(page);
    for (let i = 0; i < 12; i++) {
      a = await page.evaluate(() => {
        window.__rakeMe!.advance(1700);
        return window.__rakeMe!.auto();
      });
      expect(a.seated).toBe(true);
      expect(a.heldRake).toBeNull();
      expect(a.carriedKind).toBeNull();
      expect(fromHome(a)).toBe(0);
      if ((await hash(page)) !== hash0 || (await stones(page)).length !== 3) changed = true;
    }
    // whole steps, one at a time
    expect(changed).toBe(true);
    expect(await page.evaluate(() => Object.keys(window.__rakeMe!.pickBounds()).filter((k) => k.startsWith("rake:")).length)).toBe(10);

    a = await advanceUntil(page, { cycles: 1 }, 600_000, 1600);
    expect(a.seated).toBe(true);
    expect(await hash(page)).toBe(GOLDEN[target]);
    expect(await stones(page)).toEqual(TARGET_STONES[target]);
    expect(a.lastSealDiffCells).toBe(0);
    expect(await undoCount(page)).toBe(undo0);
    expect(await violations(page)).toBe(0);
  });

  test("mid-rake in all three variants: a clean palette, and the camera never moves by itself in any preset", async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(() => {
      window.__rakeMe!.setGubbaMode(true);
      window.__rakeMe!.autoRequest("checker_field");
    });
    await advanceUntil(page, { phase: "raking", raking: true });
    for (const variant of ["moss", "kasa", "lantern"] as const) {
      await page.evaluate((v) => window.__rakeMe!.setGubbaVariant(v), variant);
      for (const camera of ["cozy", "topdown", "porch"] as const) {
        const cam0 = await page.evaluate((c) => {
          window.__rakeMe!.setCamera(c);
          return window.__rakeMe!.state().camera;
        }, camera);
        const moved = await page.evaluate(() => {
          const api = window.__rakeMe!;
          const p0 = api.auto().rootPos;
          api.advance(3000);
          const p1 = api.auto().rootPos;
          return Math.hypot(p1.x - p0.x, p1.z - p0.z);
        });
        // Gubba went somewhere; the camera did not follow
        expect(moved, `${variant} ${camera}`).toBeGreaterThan(1);
        expect(await page.evaluate(() => window.__rakeMe!.state().camera), `${variant} ${camera}`).toEqual(cam0);
        expect(await violations(page), `${variant} ${camera}`).toBe(0);
        expect(await page.evaluate(() => window.__rakeMe!.drawCalls()), `${variant} ${camera}`).toBeLessThanOrEqual(60);
      }
    }
    const a = await auto(page);
    expect(a.mode).toBe(true);
    expect(a.phase).toBe("raking");
  });

  test("screenshots for inspection: leaving, carrying, sweeping, raking in all three variants, top-down", async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const api = window.__rakeMe!;
      api.setMood("afternoon");
      api.setGubbaVariant("moss");
      api.setCamera("cozy");
    });
    // Three Islands to Ripple Pond: two stones to the basket, one to the middle, a sweep, then rings
    expect(await page.evaluate(() => window.__rakeMe!.autoRequest("ripple_pond"))).toBe(true);
    await page.evaluate(() => window.__rakeMe!.advance(1400));
    expect(await violations(page)).toBe(0);
    await page.screenshot({ path: "test-results/auto-leaving-moss.png" });

    let a = await advanceUntil(page, { carrying: true, onBed: true });
    await page.evaluate(() => window.__rakeMe!.advance(900));
    expect((await auto(page)).carriedKind).not.toBeNull();
    expect(await violations(page)).toBe(0);
    await page.screenshot({ path: "test-results/auto-carrying-moss.png" });

    a = await advanceUntil(page, { phase: "smoothing", heldRake: "hoki", raking: true, minX: -70 });
    expect(a.sandPlan).toBe("sweep");
    expect(await violations(page)).toBe(0);
    await page.screenshot({ path: "test-results/auto-sweeping-moss.png" });

    await advanceUntil(page, { phase: "raking", heldRake: "sugi", raking: true });
    await page.evaluate(() => window.__rakeMe!.advance(5000));
    expect(await violations(page)).toBe(0);
    await page.screenshot({ path: "test-results/auto-raking-moss.png" });

    for (const variant of ["kasa", "lantern"] as const) {
      await page.evaluate((v) => {
        window.__rakeMe!.setGubbaVariant(v);
        window.__rakeMe!.advance(2500);
      }, variant);
      a = await auto(page);
      expect(a.phase).toBe("raking");
      expect(await violations(page)).toBe(0);
      await page.screenshot({ path: `test-results/auto-raking-${variant}.png` });
    }

    await page.evaluate(() => {
      window.__rakeMe!.setGubbaVariant("moss");
      window.__rakeMe!.setCamera("topdown");
      window.__rakeMe!.advance(1500);
    });
    expect(await violations(page)).toBe(0);
    await page.screenshot({ path: "test-results/auto-topdown.png" });

    await page.evaluate(() => {
      window.__rakeMe!.setCamera("porch");
      window.__rakeMe!.advance(0);
    });
    expect(await violations(page)).toBe(0);
    await page.screenshot({ path: "test-results/auto-porch-empty-cushion.png" });
  });

  test("rotating a phone upright pauses Gubba behind the turn-sideways prompt, then resumes on landscape", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await open(page);
    await page.keyboard.press("r");
    await advanceUntil(page, { onBed: true });
    await page.evaluate(() => window.__rakeMe!.advance(1500));
    const before = await auto(page);
    const hashBefore = await hash(page);
    expect(before.mode).toBe(true);
    expect(before.working).toBe(true);

    // Rotate upright: prompt covers the garden and Gubba pauses in place
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForSelector("#rotate-prompt:not([hidden])");
    await page.evaluate(() => window.__rakeMe!.advance(5000));
    const paused = await auto(page);
    expect(paused.rootPos).toEqual(before.rootPos);
    expect(await hash(page)).toBe(hashBefore);

    // Rotate back sideways: Gubba resumes working smoothly
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator("#rotate-prompt")).toBeHidden();
    await page.evaluate(() => window.__rakeMe!.advance(2000));
    const resumed = await auto(page);
    expect(resumed.mode).toBe(true);
    expect(Math.hypot(resumed.rootPos.x - before.rootPos.x, resumed.rootPos.z - before.rootPos.z)).toBeGreaterThan(5);
  });
});
