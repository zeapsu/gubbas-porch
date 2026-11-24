import fc from "fast-check";
import { describe, expect, it } from "vitest";
import rampsJson from "../../assets/ramps.json";
import {
  BED_CORNERS,
  CAMERA_PRESETS,
  CAMERA_PRESET_ORDER,
  FRAME_MARGIN_PX,
  ORBIT_AZ_LIMIT,
  ORBIT_EL_MAX,
  ORBIT_EL_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  bedCornersInView,
  cameraPosition,
  clampOrbit,
  cloneRig,
  frameBedDistance,
  framedRig,
  projectPoint,
  sandPointFromRay,
  stepCamera,
} from "../../src/render/camera/rig.ts";
import { MOOD_ORDER, contrastRatio, getPaletteHex, relativeLuminance } from "../../src/render/palettes.ts";
import { RESOLVE_FRAGMENT, SAND_FRAGMENT } from "../../src/render/pipeline/shaders.ts";
import {
  BAYER4,
  RAMP_DITHER,
  SAND_DITHER,
  bayerAt,
  lightIntensity,
  pixelScaleFor,
  sandToneFor,
  shadowBias,
  toneFor,
} from "../../src/render/pipeline/tone.ts";
import { measureText, wrapText } from "../../src/render/overlay/font.ts";
import { Overlay } from "../../src/render/overlay/overlay.ts";
import type { OverlayAction, OverlayState } from "../../src/render/overlay/overlay.ts";
import { DEFAULT_SETTINGS } from "../../src/state/types.ts";
import type { CameraRig, GubbaVariant } from "../../src/state/types.ts";

const VARIANTS: readonly GubbaVariant[] = ["moss", "kasa", "lantern"];
const RAMPS = (rampsJson as { ramps: Record<string, { id: number; slots: number[] }> }).ramps;

describe("cel step (toneFor)", () => {
  it("is always a valid ramp index", () => {
    fc.assert(
      fc.property(fc.double({ min: -2, max: 3, noNaN: true }), fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 15 }), (I, n, b) => {
        const t = toneFor(I, n, (b + 0.5) / 16);
        return Number.isInteger(t) && t >= 0 && t <= n - 1;
      }),
    );
  });

  it("is non-decreasing in intensity for a fixed Bayer value", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 2, noNaN: true }),
        fc.double({ min: -1, max: 2, noNaN: true }),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 15 }),
        (a, b, n, k) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const bay = (k + 0.5) / 16;
          return toneFor(lo, n, bay) <= toneFor(hi, n, bay);
        },
      ),
    );
  });

  it("matches a hand-computed table", () => {
    // floor(I·n + (b − 0.5)·0.22)
    expect(toneFor(0.5, 4, 0.5)).toBe(2);
    expect(toneFor(0.49, 4, 0.03125)).toBe(1);
    expect(toneFor(0.26, 4, 0.96875)).toBe(1);
    expect(toneFor(1, 3, 0.96875)).toBe(2);
    expect(toneFor(0, 5, 0.03125)).toBe(0);
    expect(toneFor(0.7, 1, 0.5)).toBe(0);
  });

  it("caps shadowed and unlit surfaces below the ambient term", () => {
    expect(lightIntensity(1, 0.32, true)).toBeCloseTo(0.55 * 0.32);
    expect(lightIntensity(0.02, 0.4, false)).toBeLessThanOrEqual(0.55 * 0.4);
    expect(lightIntensity(1, 0.32, false)).toBeCloseTo(1);
  });

  it("uses a slope-scaled shadow bias of min(7, 1.5 / max(0.2, N·L))", () => {
    expect(shadowBias(1)).toBeCloseTo(1.5);
    expect(shadowBias(0.1)).toBe(7);
    expect(shadowBias(0.5)).toBeCloseTo(3);
  });

  it("keeps the sand tone inside sand0…sand4", () => {
    fc.assert(
      fc.property(fc.double({ min: -6, max: 6, noNaN: true }), fc.integer({ min: -3, max: 3 }), fc.boolean(), fc.integer({ min: 0, max: 15 }), (s, h, sh, k) => {
        const t = sandToneFor(s, h, sh, (k + 0.5) / 16);
        return t >= 0 && t <= 4;
      }),
    );
  });

  it("has a 4×4 Bayer matrix of 16 distinct thresholds matching DESIGN.md 2.1", () => {
    expect(BAYER4).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
    const seen = new Set<number>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) seen.add(bayerAt(x, y));
    expect(seen.size).toBe(16);
    expect(bayerAt(4, 4)).toBe(bayerAt(0, 0));
    expect(bayerAt(1, 0)).toBeCloseTo(8.5 / 16);
  });

  it("generates GLSL from the same constants", () => {
    expect(RESOLVE_FRAGMENT).toContain(`float[16](${BAYER4.map((v) => `${v}.0`).join(", ")})`);
    expect(RESOLVE_FRAGMENT).toContain(`(b - 0.5) * ${RAMP_DITHER}`);
    expect(SAND_FRAGMENT).toContain(`(b - 0.5) * ${SAND_DITHER}`);
    expect(SAND_FRAGMENT).toContain("2.0 + 0.72 * s + 0.32 * h");
    expect(SAND_FRAGMENT).toContain("t -= 1.35");
  });
});

describe("palettes and ramps", () => {
  for (const mood of MOOD_ORDER) {
    for (const variant of VARIANTS) {
      it(`${mood} × ${variant}: 32 distinct colours, ordered ramps, legible ink on paper`, () => {
        const pal = getPaletteHex(mood, variant);
        expect(pal).toHaveLength(32);
        expect(new Set(pal.map((h) => h.toLowerCase())).size).toBe(32);
        for (const [name, ramp] of Object.entries(RAMPS)) {
          for (const s of ramp.slots) expect(pal[s], `${name} slot ${s}`).toBeDefined();
          for (let i = 1; i < ramp.slots.length; i++) {
            const a = relativeLuminance(pal[ramp.slots[i - 1] ?? 0] ?? "#000");
            const b = relativeLuminance(pal[ramp.slots[i] ?? 0] ?? "#000");
            expect(b, `${name} ${mood} ${variant} step ${i}`).toBeGreaterThanOrEqual(a);
          }
        }
        expect(contrastRatio(pal[30] ?? "#000", pal[31] ?? "#fff")).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("camera rig", () => {
  const rigArb = fc.record({
    target: fc.record({ x: fc.double({ min: -150, max: 150, noNaN: true }), y: fc.double({ min: 0, max: 30, noNaN: true }), z: fc.double({ min: -80, max: 80, noNaN: true }) }),
    az: fc.double({ min: -0.7, max: 0.7, noNaN: true }),
    el: fc.double({ min: 0.25, max: 1.555, noNaN: true }),
    dist: fc.double({ min: 100, max: 600, noNaN: true }),
  });

  it("places the camera at target + dist · (sin az cos el, sin el, cos az cos el)", () => {
    const p = cameraPosition(CAMERA_PRESETS.topdown);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(3 + 330 * Math.sin(1.555));
    expect(p.z).toBeCloseTo(2 + 330 * Math.cos(1.555));
  });

  it("stepCamera converges to the goal without overshoot", () => {
    fc.assert(
      fc.property(rigArb, rigArb, (start, goal) => {
        let rig: CameraRig = cloneRig(start);
        const comps = (r: CameraRig) => [r.az, r.el, r.dist, r.target.x, r.target.y, r.target.z];
        const g = comps(goal);
        for (let f = 0; f < 400; f++) {
          const before = comps(rig);
          rig = stepCamera(rig, goal, false);
          const after = comps(rig);
          for (let i = 0; i < 6; i++) {
            const b = before[i] ?? 0;
            const a = after[i] ?? 0;
            const t = g[i] ?? 0;
            // never moves away from the goal and never passes it
            if (Math.abs(t - a) > Math.abs(t - b) + 1e-9) return false;
            if ((t - b) * (t - a) < -1e-12) return false;
          }
        }
        return comps(rig).every((v, i) => Math.abs(v - (g[i] ?? 0)) < 1e-3);
      }),
      { numRuns: 60 },
    );
  });

  it("stepCamera moves by the 0.12 damping factor per 60 Hz frame and is instant with reduced motion", () => {
    const start = cloneRig(CAMERA_PRESETS.cozy);
    const goal = cloneRig(CAMERA_PRESETS.topdown);
    const one = stepCamera(start, goal, false);
    expect(one.el).toBeCloseTo(start.el + (goal.el - start.el) * 0.12);
    expect(stepCamera(start, goal, true)).toEqual(goal);
  });

  it("clampOrbit holds azimuth, elevation and zoom limits", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5, max: 5, noNaN: true }),
        fc.double({ min: -2, max: 3, noNaN: true }),
        fc.double({ min: 1, max: 3000, noNaN: true }),
        fc.constantFrom(...CAMERA_PRESET_ORDER),
        (az, el, dist, id) => {
          const preset = CAMERA_PRESETS[id];
          const c = clampOrbit({ target: { ...preset.target }, az, el, dist }, preset.dist);
          return (
            Math.abs(c.az) <= ORBIT_AZ_LIMIT &&
            c.el >= ORBIT_EL_MIN &&
            c.el <= ORBIT_EL_MAX &&
            c.dist >= preset.dist * ZOOM_MIN - 1e-9 &&
            c.dist <= preset.dist * ZOOM_MAX + 1e-9
          );
        },
      ),
    );
  });

  it("every preset is inside the orbit limits", () => {
    for (const id of CAMERA_PRESET_ORDER) {
      const p = CAMERA_PRESETS[id];
      expect(clampOrbit(p, p.dist)).toEqual(cloneRig(p));
    }
  });

  it("Cozy and Top-Down frame all four bed corners in 364×205 at their preset distance", () => {
    for (const id of ["cozy", "topdown"] as const) {
      expect(bedCornersInView(CAMERA_PRESETS[id], 364, 205), id).toBe(true);
      expect(frameBedDistance(CAMERA_PRESETS[id], 364 / 205, 364, 205)).toBe(CAMERA_PRESETS[id].dist);
    }
  });

  it("framing pulls every preset back until the four corners sit inside 364×205 with an 8 px margin", () => {
    for (const id of CAMERA_PRESET_ORDER) {
      const rig = framedRig(CAMERA_PRESETS[id], 364, 205);
      expect(rig.dist).toBeGreaterThanOrEqual(CAMERA_PRESETS[id].dist);
      for (const c of BED_CORNERS) {
        const p = projectPoint(rig, c, 364, 205);
        expect(p, `${id} corner`).not.toBeNull();
        expect(p!.x).toBeGreaterThanOrEqual(FRAME_MARGIN_PX - 1e-6);
        expect(p!.x).toBeLessThanOrEqual(364 - FRAME_MARGIN_PX + 1e-6);
        expect(p!.y).toBeGreaterThanOrEqual(FRAME_MARGIN_PX - 1e-6);
        expect(p!.y).toBeLessThanOrEqual(205 - FRAME_MARGIN_PX + 1e-6);
      }
    }
  });

  it("framing also holds on portrait phones and orbited rigs, and is tight", () => {
    fc.assert(
      fc.property(rigArb, fc.integer({ min: 60, max: 420 }), fc.integer({ min: 120, max: 260 }), (rig, w, h) => {
        const framed = framedRig(rig, w, h);
        if (!bedCornersInView(framed, w, h)) return false;
        // tight: if it had to move, a little closer would no longer fit
        if (framed.dist > rig.dist * 1.001) {
          const closer = { ...cloneRig(framed), dist: framed.dist * 0.98 };
          if (closer.dist > rig.dist && bedCornersInView(closer, w, h)) return false;
        }
        return true;
      }),
      { numRuns: 150 },
    );
  });

  it("sandPointFromRay inverts the projection of points on the sand plane", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 192, noNaN: true }), fc.double({ min: 0, max: 112, noNaN: true }), fc.constantFrom(...CAMERA_PRESET_ORDER), (gx, gy, id) => {
        const rig = framedRig(CAMERA_PRESETS[id], 364, 205);
        const p = projectPoint(rig, { x: gx - 96, y: 3, z: gy - 56 }, 364, 205);
        if (!p) return true;
        const s = sandPointFromRay(rig, p.x, p.y, 364, 205);
        return !!s && Math.abs(s.x - gx) < 1e-6 && Math.abs(s.y - gy) < 1e-6;
      }),
    );
  });
});

describe("pixel density", () => {
  it("uses an integer scale k = max(1, round(deviceH / targetRows))", () => {
    expect(pixelScaleFor(820, "crisp")).toBe(4);
    expect(pixelScaleFor(820, "chunky")).toBe(6);
    expect(Math.ceil(1456 / 4)).toBe(364);
    expect(Math.ceil(1456 / 6)).toBe(243);
    expect(pixelScaleFor(50, "crisp")).toBe(1);
  });
});

describe("bitmap font", () => {
  it("measures glyphs with one pixel between them", () => {
    expect(measureText("")).toBe(0);
    expect(measureText("A")).toBe(4);
    expect(measureText("AA")).toBe(9);
    expect(measureText("m")).toBe(5);
    expect(measureText("a b")).toBe(4 + 1 + 3 + 4);
  });

  it("wraps within the width and keeps every word", () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 20 }), fc.integer({ min: 40, max: 200 }), (words, max) => {
        const lines = wrapText(words.join(" "), max);
        if (lines.join(" ") !== words.join(" ")) return false;
        return lines.every((l) => measureText(l) <= max || !l.includes(" "));
      }),
    );
  });

  it("fits a 96-character line of dialogue into three lines of 158 pixels", () => {
    const line = "The tide does not hurry, and the whole shore is combed. The tide does not hurry, and the whol";
    expect(line.length).toBeLessThanOrEqual(96);
    expect(wrapText(line, 158).length).toBeLessThanOrEqual(3);
  });
});

describe("overlay", () => {
  const base: OverlayState = {
    settings: DEFAULT_SETTINGS,
    breathAmplitude: 0.5,
    speech: "Take a rake. Any rake.",
    panel: "none",
    tab: "look",
    watchGubbaRake: false,
    elementCount: 3,
    maxElements: 12,
    pointer: null,
  };

  function actions(o: Overlay, st: OverlayState): OverlayAction[] {
    return o.draw(st).map((h) => h.action);
  }

  it("draws only palette indices or transparency, with the six HUD objects", () => {
    const o = new Overlay(364, 205);
    const hud = actions(o, base).filter((a) => a.type === "hud");
    expect(hud.map((a) => (a.type === "hud" ? a.id : ""))).toEqual(["undo", "redo", "breath", "mood", "sound", "menu"]);
    expect(o.pixels.filter((v) => v >= 32 && v !== 255).length).toBe(0);
    // HUD sits in the bottom-left 3×2 block
    expect(o.hitTest(4, 205 - 34)).toEqual({ type: "hud", id: "undo" });
    expect(o.hitTest(36, 205 - 17)).toEqual({ type: "hud", id: "menu" });
    expect(o.hitTest(300, 20)).toBeNull();
  });

  it("offers every Settings control across its tabs", () => {
    const o = new Overlay(364, 205);
    const all: OverlayAction[] = [];
    for (const tab of ["look", "garden", "sound", "presets"] as const) {
      all.push(...actions(o, { ...base, panel: "settings", tab }));
      expect(o.pixels.filter((v) => v >= 32 && v !== 255).length).toBe(0);
    }
    const patches = all.flatMap((a) => (a.type === "settings" ? [a.patch] : []));
    const has = (pred: (p: (typeof patches)[number]) => boolean) => patches.some(pred);
    for (const v of ["moss", "kasa", "lantern"]) expect(has((p) => p.gubbaVariant === v), v).toBe(true);
    for (const m of ["auto", "morning", "afternoon", "dusk", "moonlit"]) expect(has((p) => p.moodSetting === m), m).toBe(true);
    for (const c of ["cozy", "topdown", "porch"]) expect(has((p) => p.cameraPreset === c), c).toBe(true);
    for (const d of ["crisp", "chunky"]) expect(has((p) => p.density === d), d).toBe(true);
    for (const b of [true, false]) {
      expect(has((p) => p.flow === b)).toBe(true);
      expect(has((p) => p.rain === b)).toBe(true);
      expect(has((p) => p.breathEnabled === b)).toBe(true);
      expect(has((p) => p.mix?.muted === b)).toBe(true);
    }
    for (const bp of ["4-4-6", "4-7-8", "box"]) expect(has((p) => p.breathPattern === bp), bp).toBe(true);
    for (const t of ["quiet", "sometimes", "companion"]) expect(has((p) => p.talkMode === t), t).toBe(true);
    for (const ch of ["master", "music", "foley", "ambience"] as const) {
      for (let v = 0; v <= 7; v++) expect(has((p) => p.mix?.[ch] === v), `${ch} ${v}`).toBe(true);
    }
    const presets = all.flatMap((a) => (a.type === "preset" ? [a.id] : []));
    expect(new Set(presets)).toEqual(new Set(["still_sand", "three_islands", "ripple_pond", "old_sea", "river_bend", "snails_thought", "checker_field"]));
    expect(all.some((a) => a.type === "watch" && a.on)).toBe(true);
    expect(all.some((a) => a.type === "export")).toBe(true);
    expect(all.some((a) => a.type === "close")).toBe(true);
  });

  it("lists every basket element and stays inside the framebuffer at Chunky and portrait sizes", () => {
    for (const [w, h] of [[364, 205], [243, 137], [98, 211]] as const) {
      const o = new Overlay(w, h);
      const hits = o.draw({ ...base, panel: "basket" });
      for (const hit of hits) {
        expect(hit.x).toBeGreaterThanOrEqual(0);
        expect(hit.y).toBeGreaterThanOrEqual(0);
        expect(hit.x + hit.w).toBeLessThanOrEqual(w);
        expect(hit.y + hit.h).toBeLessThanOrEqual(h);
      }
      if (w >= 243) expect(hits.filter((x) => x.action.type === "place")).toHaveLength(11);
    }
  });
});
