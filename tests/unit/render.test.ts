import fs from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import rampsJson from "../../assets/ramps.json";
import {
  BED_CORNERS,
  CAMERA_FAR,
  CAMERA_PRESETS,
  CAMERA_PRESET_ORDER,
  FRAME_MARGIN_PX,
  HERO_HULLS,
  HUD_CLEAR_H,
  HUD_CLEAR_W,
  MAX_CAMERA_DIST,
  ORBIT_AZ_LIMIT,
  ORBIT_EL_MAX,
  ORBIT_EL_MIN,
  PRESET_FRAMING,
  ZOOM_MAX,
  ZOOM_MIN,
  bedCornersInView,
  cameraPosition,
  clampOrbit,
  cloneRig,
  framedRig,
  hudClearHeight,
  hudClearWidth,
  pointsInView,
  presetRig,
  projectPoint,
  sandPointFromRay,
  stepCamera,
  stepCameraInto,
  viewportRigInto,
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
import { HUD_FROM_BOTTOM, HUD_ICON, HUD_LEFT, scrollRect } from "../../src/render/overlay/hud.ts";
import { Overlay, uiPixelFor } from "../../src/render/overlay/overlay.ts";
import type { OverlayAction, OverlayHit, OverlayState } from "../../src/render/overlay/overlay.ts";
import { GUBBA_YAW, HANG_Y, HANG_Z, PROP_ORIGINS, RACK_ORDER, RACK_SLOTS } from "../../src/render/scene/assets.ts";
import { DEFAULT_SETTINGS } from "../../src/state/types.ts";
import type { CameraPresetId, CameraRig, GubbaVariant, PixelDensity, Vec3 } from "../../src/state/types.ts";
import { needsLandscape } from "../../src/ui/viewport.ts";

const BASE_OVERLAY: OverlayState = {
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

const VARIANTS: readonly GubbaVariant[] = ["moss", "kasa", "lantern"];
const RAMPS = (rampsJson as { ramps: Record<string, { id: number; slots: number[] }> }).ramps;

/** Popular window sizes in CSS pixels (the same list tests/e2e/viewports.spec.ts drives in Chromium). */
const VIEWPORTS: readonly (readonly [number, number, string])[] = [
  [1920, 1080, "desktop FHD"],
  [1456, 820, "reference"],
  [1440, 900, "laptop 16:10"],
  [1366, 768, "laptop 16:9"],
  [1280, 720, "desktop HD"],
  [1024, 768, "4:3 / tablet landscape"],
  [768, 1024, "tablet portrait"],
  [640, 720, "split screen"],
  [844, 390, "phone landscape"],
  [667, 375, "small phone landscape"],
  [568, 320, "smallest phone landscape"],
  [390, 844, "phone portrait"],
  [360, 800, "phone portrait"],
];
const DENSITIES: readonly PixelDensity[] = ["crisp", "chunky"];

/** The framebuffer `framebufferFor` gives a window (pipeline.ts needs WebGL to import, so the rule is restated). */
function fbFor(cssW: number, cssH: number, density: PixelDensity, dpr = 1): { fbW: number; fbH: number; scale: number } {
  const scale = pixelScaleFor(cssH * dpr, density, cssW * dpr);
  return { fbW: Math.floor((cssW * dpr) / scale), fbH: Math.floor((cssH * dpr) / scale), scale };
}

interface Fb {
  fbW: number;
  fbH: number;
  /** Device pixels per scene pixel. */
  scale: number;
  density: PixelDensity;
  /** Scene pixels per overlay pixel (`uiPixelFor` over `scale`). */
  uiScale: number;
  /** One HUD object's side as a share of the window's shorter side. */
  iconShare: number;
  label: string;
}

/** Every framebuffer the popular windows produce, in both densities at device pixel ratios 1–3. */
function framebuffers(playableOnly = false): Fb[] {
  const out: Fb[] = [];
  for (const [w, h, name] of VIEWPORTS) {
    if (playableOnly && needsLandscape(w, h)) continue;
    for (const density of DENSITIES) {
      for (const dpr of [1, 2, 3]) {
        const fb = fbFor(w, h, density, dpr);
        const uiK = uiPixelFor(fb.fbW, fb.fbH, fb.scale, density);
        out.push({
          fbW: fb.fbW,
          fbH: fb.fbH,
          scale: fb.scale,
          density,
          uiScale: uiK / fb.scale,
          iconShare: (HUD_ICON * uiK) / (Math.min(w, h) * dpr),
          label: `${name} ${w}×${h} ${density} @${dpr}x → ${fb.fbW}×${fb.fbH}, overlay ×${uiK / fb.scale}`,
        });
      }
    }
  }
  return out;
}

/** Positions of every vertex in a `.glb`, with node transforms applied (the models carry no skins). */
function glbVertices(file: string): Vec3[] {
  const buf = fs.readFileSync(file);
  let json: {
    scene?: number;
    scenes: { nodes: number[] }[];
    nodes: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
    meshes: { primitives: { attributes: { POSITION: number } }[] }[];
    accessors: { bufferView: number; byteOffset?: number; count: number }[];
    bufferViews: { byteOffset?: number; byteStride?: number }[];
  } | null = null;
  let bin: Buffer | null = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error(`${file}: not a binary glTF`);
  const gltf = json;
  const data = bin;
  const mul = (a: number[], b: number[]): number[] => {
    const o = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
    return o;
  };
  const trs = (t = [0, 0, 0], q = [0, 0, 0, 1], sc = [1, 1, 1]): number[] => {
    const [x, y, z, w] = q as [number, number, number, number];
    const [sx, sy, sz] = sc as [number, number, number];
    return [
      (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
      t[0]!, t[1]!, t[2]!, 1,
    ];
  };
  const out: Vec3[] = [];
  const visit = (index: number, parent: number[]): void => {
    const node = gltf.nodes[index]!;
    const m = mul(parent, node.matrix ?? trs(node.translation, node.rotation, node.scale));
    if (node.mesh !== undefined) {
      for (const prim of gltf.meshes[node.mesh]!.primitives) {
        const acc = gltf.accessors[prim.attributes.POSITION]!;
        const view = gltf.bufferViews[acc.bufferView]!;
        const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        const stride = view.byteStride ?? 12;
        for (let v = 0; v < acc.count; v++) {
          const x = data.readFloatLE(base + v * stride);
          const y = data.readFloatLE(base + v * stride + 4);
          const z = data.readFloatLE(base + v * stride + 8);
          out.push({
            x: m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
            y: m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
            z: m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
          });
        }
      }
    }
    for (const c of node.children ?? []) visit(c, m);
  };
  for (const r of gltf.scenes[gltf.scene ?? 0]!.nodes) visit(r, trs());
  return out;
}

/** A model's vertices placed in the world as the scene places them: turned about y, scaled, then moved. */
function placed(file: string, origin: readonly number[], yaw = 0, scale = 1): Vec3[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return glbVertices(`public/assets/models/${file}`).map((p) => ({
    x: origin[0]! + (p.x * c + p.z * s) * scale,
    y: origin[1]! + p.y * scale,
    z: origin[2]! + (-p.x * s + p.z * c) * scale,
  }));
}

/** True when `p` is inside the upright convex prism whose corners are `piece` (HERO_HULLS pieces are all prisms). */
function insidePrism(p: Vec3, piece: readonly Vec3[]): boolean {
  const ys = piece.map((c) => c.y);
  if (p.y < Math.min(...ys) - 1e-6 || p.y > Math.max(...ys) + 1e-6) return false;
  // footprint: p must be on the inner side of every edge between footprint corners that is a hull edge
  const foot = piece.filter((c) => c.y === ys[0]);
  for (const a of foot) {
    for (const b of foot) {
      if (a === b) continue;
      const ex = b.x - a.x;
      const ez = b.z - a.z;
      if (Math.hypot(ex, ez) < 1e-9) continue;
      const sides = foot.map((c) => ex * (c.z - a.z) - ez * (c.x - a.x));
      const allLeft = sides.every((v) => v >= -1e-6);
      if (!allLeft) continue; // not a hull edge with the footprint on its left
      if (ex * (p.z - a.z) - ez * (p.x - a.x) < -1e-6) return false;
    }
  }
  return true;
}

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

  it("the 16:9 reference views are exactly the presets: nothing is pulled back or panned", () => {
    const pan = (rig: CameraRig, id: CameraPresetId): number =>
      Math.hypot(rig.target.x - CAMERA_PRESETS[id].target.x, rig.target.y - CAMERA_PRESETS[id].target.y, rig.target.z - CAMERA_PRESETS[id].target.z);
    // 1456×820 at Crisp, then 1920×1080, 1366×768, 1280×720 and two phones on their side
    for (const [w, h] of [[364, 205], [384, 216], [341, 192], [320, 180], [422, 195], [333, 187]] as const) {
      expect(framedRig("cozy", w, h), `cozy ${w}×${h}`).toEqual(cloneRig(CAMERA_PRESETS.cozy));
      expect(framedRig("porch", w, h), `porch ${w}×${h}`).toEqual(cloneRig(CAMERA_PRESETS.porch));
      // Top-Down may slide aside for the HUD (next tests) but is never pulled back at 16:9
      expect(framedRig("topdown", w, h).dist, `topdown ${w}×${h}`).toBe(CAMERA_PRESETS.topdown.dist);
    }
    expect(framedRig("topdown", 364, 205)).toEqual(cloneRig(CAMERA_PRESETS.topdown));
    // the same windows at Chunky: Cozy is still the preset; Porch is never pulled back and pans under half a unit
    for (const [w, h] of [[242, 136], [240, 135], [227, 128], [256, 144], [281, 130], [222, 125]] as const) {
      expect(framedRig("cozy", w, h), `cozy ${w}×${h}`).toEqual(cloneRig(CAMERA_PRESETS.cozy));
      const porch = framedRig("porch", w, h);
      expect(porch.dist, `porch ${w}×${h}`).toBe(CAMERA_PRESETS.porch.dist);
      expect(pan(porch, "porch"), `porch ${w}×${h}`).toBeLessThan(0.5);
    }
    for (const id of ["cozy", "topdown"] as const) expect(bedCornersInView(CAMERA_PRESETS[id], 364, 205), id).toBe(true);
  });

  /** Margins of a point set from the four framebuffer edges under `rig`. */
  function margins(rig: CameraRig, points: readonly Vec3[], w: number, h: number): { l: number; r: number; t: number; b: number } {
    const m = { l: Infinity, r: Infinity, t: Infinity, b: Infinity };
    for (const c of points) {
      const p = projectPoint(rig, c, w, h);
      if (!p) return { l: -Infinity, r: -Infinity, t: -Infinity, b: -Infinity };
      m.l = Math.min(m.l, p.x);
      m.r = Math.min(m.r, w - p.x);
      m.t = Math.min(m.t, p.y);
      m.b = Math.min(m.b, h - p.y);
    }
    return m;
  }
  const allPoints = (id: CameraPresetId): Vec3[] => [...PRESET_FRAMING[id].points, ...PRESET_FRAMING[id].clear];
  /** True when the points are all right of the HUD block or all above it, at the overlay's scale. */
  function clearOfHud(rig: CameraRig, points: readonly Vec3[], w: number, h: number, uiScale = 1): boolean {
    const m = margins(rig, points, w, h);
    return m.l >= hudClearWidth(uiScale) - 1e-6 || m.b >= hudClearHeight(uiScale) - 1e-6;
  }

  it("the HUD clearance matches the HUD block the overlay draws, at any overlay scale", () => {
    expect(HUD_CLEAR_W).toBe(HUD_LEFT + 3 * HUD_ICON + 1);
    expect(HUD_CLEAR_H).toBe(HUD_FROM_BOTTOM + 1);
    for (const [w, h, k] of [[364, 205, 4], [384, 512, 2], [320, 360, 2], [341, 256, 3]] as const) {
      const o = new Overlay(w, h, k, "crisp");
      const hud = o.draw(BASE_OVERLAY).filter((x) => x.action.type === "hud");
      expect(Math.max(...hud.map((x) => x.x + x.w)) + 1, `${w}×${h}`).toBeCloseTo(hudClearWidth(o.scale), 9);
      expect(h - Math.min(...hud.map((x) => x.y)) + 1, `${w}×${h}`).toBeCloseTo(hudClearHeight(o.scale), 9);
    }
  });

  it("Cozy keeps the bed, all ten hanging rakes, Gubba, the basket, the shishi-odoshi and the bonsai in every popular window", () => {
    for (const fb of framebuffers()) {
      const rig = framedRig("cozy", fb.fbW, fb.fbH, fb.uiScale);
      for (const [name, pieces] of Object.entries(HERO_HULLS)) {
        const m = margins(rig, pieces.flat(), fb.fbW, fb.fbH);
        for (const side of ["l", "r", "t", "b"] as const) {
          expect(m[side], `${fb.label}: ${name} ${side}`).toBeGreaterThanOrEqual(FRAME_MARGIN_PX - 1e-6);
        }
      }
      expect(bedCornersInView(rig, fb.fbW, fb.fbH), fb.label).toBe(true);
      expect(rig.dist, fb.label).toBeGreaterThanOrEqual(CAMERA_PRESETS.cozy.dist);
      expect(rig.dist * ZOOM_MAX, fb.label).toBeLessThanOrEqual(MAX_CAMERA_DIST);
    }
  });

  it("Gubba Porch keeps Gubba whole and clear of the HUD in every popular window", () => {
    for (const fb of framebuffers()) {
      const rig = framedRig("porch", fb.fbW, fb.fbH, fb.uiScale);
      const hull = HERO_HULLS.gubba.flat();
      expect(pointsInView(rig, hull, fb.fbW, fb.fbH, FRAME_MARGIN_PX - 1e-6), fb.label).toBe(true);
      expect(clearOfHud(rig, hull, fb.fbW, fb.fbH, fb.uiScale), fb.label).toBe(true);
    }
  });

  it("Top-Down keeps the bed and its frame in view and the sand clear of the HUD in every popular window", () => {
    for (const fb of framebuffers()) {
      const rig = framedRig("topdown", fb.fbW, fb.fbH, fb.uiScale);
      expect(pointsInView(rig, HERO_HULLS.frame.flat(), fb.fbW, fb.fbH, FRAME_MARGIN_PX - 1e-6), fb.label).toBe(true);
      expect(bedCornersInView(rig, fb.fbW, fb.fbH), fb.label).toBe(true);
      expect(clearOfHud(rig, [BED_CORNERS[3]!], fb.fbW, fb.fbH, fb.uiScale), fb.label).toBe(true);
    }
  });

  it("framing is tight: a view that had to pull back touches the margin on two opposite sides", () => {
    for (const fb of framebuffers()) {
      for (const id of CAMERA_PRESET_ORDER) {
        const rig = framedRig(id, fb.fbW, fb.fbH, fb.uiScale);
        if (rig.dist <= CAMERA_PRESETS[id].dist * 1.001) continue;
        const m = margins(rig, allPoints(id), fb.fbW, fb.fbH);
        // the hair of slack (0.05 %) is under a pixel at these sizes; the HUD option may hold the left or bottom edge off
        const near = (v: number): boolean => v < FRAME_MARGIN_PX + 1;
        const horizontal = near(m.r) && (near(m.l) || PRESET_FRAMING[id].clear.length > 0);
        const vertical = near(m.t) && (near(m.b) || PRESET_FRAMING[id].clear.length > 0);
        expect(horizontal || vertical, `${fb.label} ${id}: ${JSON.stringify(m)}`).toBe(true);
      }
    }
  });

  it("an orbited view stays framed at any angle and window shape, and zoom scales the framed distance", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CAMERA_PRESET_ORDER),
        fc.double({ min: -ORBIT_AZ_LIMIT, max: ORBIT_AZ_LIMIT, noNaN: true }),
        fc.double({ min: ORBIT_EL_MIN, max: ORBIT_EL_MAX, noNaN: true }),
        fc.integer({ min: 180, max: 520 }),
        fc.integer({ min: 110, max: 560 }),
        fc.double({ min: ZOOM_MIN, max: ZOOM_MAX, noNaN: true }),
        (id, az, el, w, h, zoom) => {
          const preset = CAMERA_PRESETS[id];
          const orbit = clampOrbit({ ...presetRig(id), az, el }, preset.dist);
          const framed = viewportRigInto(presetRig(id), orbit, id, w, h);
          if (framed.az !== orbit.az || framed.el !== orbit.el) return false;
          if (framed.dist < preset.dist) return false;
          if (framed.dist < MAX_CAMERA_DIST && !pointsInView(framed, allPoints(id), w, h, FRAME_MARGIN_PX - 1e-6)) return false;
          // zoom: same pan, distance scaled, never past the far-plane guard
          const zoomed = viewportRigInto(presetRig(id), clampOrbit({ ...orbit, dist: preset.dist * zoom }, preset.dist), id, w, h);
          if (Math.abs(zoomed.dist - Math.min(MAX_CAMERA_DIST, framed.dist * zoom)) > 1e-6) return false;
          return zoomed.target.x === framed.target.x && zoomed.target.y === framed.target.y && zoomed.target.z === framed.target.z;
        },
      ),
      { numRuns: 300 },
    );
  });

  it("zoom limits follow the window: a narrow view that pulled far back is not snapped inward by a wheel tick", () => {
    const framed = framedRig("cozy", 320, 360); // 640×720 split screen
    expect(framed.dist).toBeGreaterThan(CAMERA_PRESETS.cozy.dist * ZOOM_MAX);
    const orbit = clampOrbit({ ...presetRig("cozy"), dist: CAMERA_PRESETS.cozy.dist * 1.06 }, CAMERA_PRESETS.cozy.dist);
    const zoomed = viewportRigInto(presetRig("cozy"), orbit, "cozy", 320, 360);
    expect(zoomed.dist).toBeCloseTo(framed.dist * 1.06, 6);
  });

  it("damping orbit angles and refitting every intermediate frame keeps Gubba inside margin throughout a 768×1024 Porch drag", () => {
    const fbW = 384;
    const fbH = 512;
    const uiScale = 2;
    const startOrbit = presetRig("porch");
    const goalOrbit = clampOrbit(
      { ...startOrbit, az: startOrbit.az + 1.2, el: startOrbit.el - 0.072 },
      CAMERA_PRESETS.porch.dist,
    );
    const cur = cloneRig(startOrbit);
    const fitted = cloneRig(startOrbit);
    const gubbaHull = HERO_HULLS.gubba.flat();
    for (let f = 0; f < 80; f++) {
      stepCameraInto(cur, cur, goalOrbit, false, 1000 / 60);
      viewportRigInto(fitted, cur, "porch", fbW, fbH, uiScale);
      expect(pointsInView(fitted, gubbaHull, fbW, fbH, FRAME_MARGIN_PX - 1e-6), `frame ${f}`).toBe(true);
      expect(clearOfHud(fitted, gubbaHull, fbW, fbH, uiScale), `frame ${f} hud`).toBe(true);
    }
  });

  it("the far plane leaves room behind the farthest framed camera", () => {
    expect(MAX_CAMERA_DIST).toBeLessThanOrEqual(CAMERA_FAR - 400);
    // a window five times taller than wide still fits the garden without hitting the guard
    expect(framedRig("cozy", 200, 1000).dist).toBeLessThan(MAX_CAMERA_DIST);
    // and a degenerate sliver never yields NaN or a camera beyond the guard
    for (const [w, h] of [[1, 1], [13, 400], [400, 13], [60, 2000]] as const) {
      for (const id of CAMERA_PRESET_ORDER) {
        const rig = framedRig(id, w, h);
        expect(Number.isFinite(rig.dist) && Number.isFinite(rig.target.x) && Number.isFinite(rig.target.y), `${id} ${w}×${h}`).toBe(true);
        expect(rig.dist).toBeLessThanOrEqual(Math.max(MAX_CAMERA_DIST, CAMERA_PRESETS[id].dist));
      }
    }
  });

  it("the hero hulls contain every vertex of the committed models as the scene places them", () => {
    const clouds: Record<keyof typeof HERO_HULLS, Vec3[]> = {
      frame: placed("props/frame.glb", PROP_ORIGINS.frame),
      basket: placed("props/basket.glb", PROP_ORIGINS.basket),
      shishi: placed("props/shishi_odoshi.glb", PROP_ORIGINS.shishi),
      bonsai: placed("props/bonsai.glb", PROP_ORIGINS.shelfBonsai, 0, 0.55),
      gubba: VARIANTS.flatMap((v) => placed(`gubba_${v}.glb`, PROP_ORIGINS.gubba, GUBBA_YAW)),
      // on the rack a rake hangs head-up: model (x, y, z) lands at (slot.x − x, HANG_Y − z, HANG_Z − y)
      rakes: RACK_ORDER.flatMap((id) =>
        glbVertices(`public/assets/models/rakes/${id}.glb`).map((p) => ({ x: RACK_SLOTS[id].x - p.x, y: HANG_Y - p.z, z: HANG_Z - p.y })),
      ),
    };
    for (const [name, cloud] of Object.entries(clouds) as [keyof typeof HERO_HULLS, Vec3[]][]) {
      expect(cloud.length, name).toBeGreaterThan(20);
      const outside = cloud.filter((p) => !HERO_HULLS[name].some((piece) => insidePrism(p, piece)));
      expect(outside.length, `${name}: ${JSON.stringify(outside.slice(0, 3))}`).toBe(0);
    }
  });

  it("sandPointFromRay inverts the projection of points on the sand plane", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 192, noNaN: true }), fc.double({ min: 0, max: 112, noNaN: true }), fc.constantFrom(...CAMERA_PRESET_ORDER), (gx, gy, id) => {
        const rig = framedRig(id, 364, 205);
        const p = projectPoint(rig, { x: gx - 96, y: 3, z: gy - 56 }, 364, 205);
        if (!p) return true;
        const s = sandPointFromRay(rig, p.x, p.y, 364, 205);
        return !!s && Math.abs(s.x - gx) < 1e-6 && Math.abs(s.y - gy) < 1e-6;
      }),
    );
  });
});

describe("pixel density", () => {
  it("uses an integer scale k = max(1, round(min(deviceH / targetRows, deviceW / targetCols)))", () => {
    expect(pixelScaleFor(820, "crisp")).toBe(4);
    expect(pixelScaleFor(820, "chunky")).toBe(6);
    expect(pixelScaleFor(50, "crisp")).toBe(1);
    // the reference window, and any landscape window, is bound by its height
    expect(fbFor(1456, 820, "crisp")).toEqual({ fbW: 364, fbH: 205, scale: 4 });
    expect(fbFor(1456, 820, "chunky")).toEqual({ fbW: 242, fbH: 136, scale: 6 });
    expect(fbFor(1280, 720, "crisp")).toEqual({ fbW: 320, fbH: 180, scale: 4 });
    expect(fbFor(844, 390, "crisp")).toEqual({ fbW: 422, fbH: 195, scale: 2 });
    // a window narrower than the reference shape is bound by its width, so the garden keeps its pixels
    expect(fbFor(768, 1024, "crisp")).toEqual({ fbW: 384, fbH: 512, scale: 2 });
    expect(fbFor(640, 720, "crisp")).toEqual({ fbW: 320, fbH: 360, scale: 2 });
    expect(fbFor(768, 1024, "chunky")).toEqual({ fbW: 256, fbH: 341, scale: 3 });
  });

  it("rounds the framebuffer down so the canvas never exceeds the window and no pixel is cropped", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4000 }), fc.integer({ min: 1, max: 4000 }), fc.constantFrom(...DENSITIES), (w, h, density) => {
        const fb = fbFor(w, h, density);
        if (!Number.isInteger(fb.scale) || fb.scale < 1) return false;
        const cw = Math.max(1, fb.fbW) * fb.scale;
        const ch = Math.max(1, fb.fbH) * fb.scale;
        // inside the window, and the leftover border is under one scene pixel per axis
        const fits = (c: number, d: number): boolean => (d < fb.scale ? true : c <= d && d - c < fb.scale);
        return fits(cw, w) && fits(ch, h);
      }),
    );
  });

  it("gives every playable popular window at least 180 columns and 110 rows", () => {
    for (const fb of framebuffers(true)) {
      expect(fb.fbW, fb.label).toBeGreaterThanOrEqual(180);
      expect(fb.fbH, fb.label).toBeGreaterThanOrEqual(110);
    }
  });
});

describe("viewport rules", () => {
  it("asks only upright phones to turn sideways", () => {
    for (const [w, h] of [[390, 844], [360, 800], [375, 667], [414, 896], [599, 700]] as const) expect(needsLandscape(w, h), `${w}×${h}`).toBe(true);
    // tablets, split-screen desktops, landscape phones and desktops play as they are
    for (const [w, h] of [[768, 1024], [640, 720], [600, 900], [844, 390], [667, 375], [800, 360], [568, 320], [1280, 720], [500, 560]] as const) {
      expect(needsLandscape(w, h), `${w}×${h}`).toBe(false);
    }
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
  const base = BASE_OVERLAY;

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

  const TABS = ["look", "garden", "sound", "presets"] as const;
  type Rect = { x: number; y: number; w: number; h: number };
  /** The HUD block as drawn: the bounding box of its six hit rectangles, in framebuffer pixels. */
  const hudRect = (hits: readonly OverlayHit[]): Rect => {
    const hud = hits.filter((x) => x.action.type === "hud");
    const x = Math.min(...hud.map((r) => r.x));
    const y = Math.min(...hud.map((r) => r.y));
    return { x, y, w: Math.max(...hud.map((r) => r.x + r.w)) - x, h: Math.max(...hud.map((r) => r.y + r.h)) - y };
  };
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  /** Every hit rectangle inside the framebuffer; every panel control clear of the HUD block. */
  function expectTidy(hits: readonly OverlayHit[], w: number, h: number, label: string): void {
    for (const hit of hits) {
      expect(hit.x, label).toBeGreaterThanOrEqual(0);
      expect(hit.y, label).toBeGreaterThanOrEqual(0);
      expect(hit.w, label).toBeGreaterThan(0);
      expect(hit.h, label).toBeGreaterThan(0);
      expect(hit.x + hit.w, label).toBeLessThanOrEqual(w + 1e-9);
      expect(hit.y + hit.h, label).toBeLessThanOrEqual(h + 1e-9);
      if (hit.action.type !== "hud") expect(overlaps(hit, hudRect(hits)), `${label}: ${JSON.stringify(hit)} over the HUD`).toBe(false);
    }
  }

  /** The number of controls each Settings tab must offer. */
  const TAB_CONTROLS: Readonly<Record<(typeof TABS)[number], number>> = {
    look: 3 + 5 + 3 + 2, // Gubba, mood, camera, pixels
    garden: 2 + 2 + 2 + 3 + 3, // flow, rain, breath, pattern, talk
    sound: 4 * 8 + 2, // four channels of eight pips, mute
    presets: 7 + 2 + 1, // gardens, watch, export
  };

  it("keeps the HUD, speech scroll, every Settings control and every basket item inside every popular window", () => {
    for (const fb of framebuffers(true)) {
      const { fbW: w, fbH: h, label } = fb;
      const o = new Overlay(w, h, fb.scale, fb.density);
      expect(o.scale, label).toBe(fb.uiScale);
      // HUD and speech scroll
      const hud = o.draw(base);
      expect(hud.filter((x) => x.action.type === "hud"), label).toHaveLength(6);
      expectTidy(hud, w, h, label);
      const scroll = o.speechRect();
      expect(scroll.x, label).toBeGreaterThanOrEqual(0);
      expect(scroll.y, label).toBeGreaterThanOrEqual(0);
      expect(scroll.x + scroll.w, label).toBeLessThanOrEqual(w + 1e-9);
      expect(scroll.y + scroll.h, label).toBeLessThanOrEqual(h + 1e-9);
      expect(overlaps(scroll, hudRect(hud)), `${label}: scroll over the HUD`).toBe(false);
      // Settings: all four tabs, nothing dropped for lack of room
      for (const tab of TABS) {
        const hits = o.draw({ ...base, panel: "settings", tab });
        expectTidy(hits, w, h, `${label} ${tab}`);
        expect(hits.filter((x) => x.action.type === "tab"), `${label} ${tab}`).toHaveLength(4);
        expect(hits.filter((x) => x.action.type === "close"), `${label} ${tab}`).toHaveLength(1);
        const controls = hits.filter((x) => ["settings", "preset", "watch", "export"].includes(x.action.type));
        expect(controls, `${label} ${tab}`).toHaveLength(TAB_CONTROLS[tab]);
        expect(o.pixels.filter((v) => v >= 32 && v !== 255).length, `${label} ${tab}`).toBe(0);
      }
      // Stone basket: all eleven items
      const basket = o.draw({ ...base, panel: "basket" });
      expectTidy(basket, w, h, `${label} basket`);
      expect(basket.filter((x) => x.action.type === "place"), `${label} basket`).toHaveLength(11);
    }
  });

  it("never draws or reports a control outside a framebuffer of any size, down to a sliver", () => {
    // upright phones (hidden behind the turn-sideways prompt) and absurd windows must still not crash or spill
    const sizes: (readonly [number, number])[] = [[390, 844], [195, 422], [130, 281], [98, 211], [65, 141], [109, 146], [90, 160], [60, 100], [40, 90], [20, 20], [1, 1]];
    for (const [w, h] of sizes) {
      const o = new Overlay(w, h);
      for (const st of [base, ...TABS.map((tab) => ({ ...base, panel: "settings" as const, tab })), { ...base, panel: "basket" as const }]) {
        const hits = o.draw(st);
        for (const hit of hits) {
          expect(hit.x >= 0 && hit.y >= 0 && hit.x + hit.w <= w && hit.y + hit.h <= h, `${w}×${h} ${JSON.stringify(hit)}`).toBe(true);
          // from 80 rows up there is room for a panel above the HUD, so they never overlap
          if (o.layer.h >= 80 && hit.action.type !== "hud") expect(overlaps(hit, hudRect(hits)), `${w}×${h} ${JSON.stringify(hit)}`).toBe(false);
        }
        expect(o.pixels.length).toBe(o.layer.w * o.layer.h);
        expect(o.pixels.filter((v) => v >= 32 && v !== 255).length).toBe(0);
      }
    }
  });

  it("stacks a mix row's pips under its label when the panel is too narrow for both", () => {
    // 109 columns leaves 89 px of content: one short of label + pips side by side
    const o = new Overlay(109, 200);
    const hits = o.draw({ ...base, panel: "settings", tab: "sound" });
    const pips = hits.filter((x) => x.action.type === "settings" && x.action.patch.mix && x.action.patch.mix.muted === undefined);
    expect(pips).toHaveLength(32);
    const panel = hits.find((x) => x.action.type === "none")!;
    for (const pip of pips) {
      expect(pip.x).toBeGreaterThanOrEqual(panel.x + 2);
      expect(pip.x + pip.w).toBeLessThanOrEqual(panel.x + panel.w - 2);
    }
    // the Export chip follows the same rule on the Presets tab
    const narrow = new Overlay(70, 260);
    const exp = narrow.draw({ ...base, panel: "settings", tab: "presets" }).find((x) => x.action.type === "export")!;
    const box = narrow.draw({ ...base, panel: "settings", tab: "presets" }).find((x) => x.action.type === "none")!;
    expect(exp.x + exp.w).toBeLessThanOrEqual(box.x + box.w - 2);
  });
  it("draws the overlay at the scene's pixel size in every landscape reference window", () => {
    // 1456×820, 1920×1080, 1440×900, 1366×768, 1280×720 and phones on their side, in both densities
    for (const [w, h] of [[1456, 820], [1920, 1080], [1440, 900], [1366, 768], [1280, 720], [844, 390], [667, 375], [568, 320]] as const) {
      for (const density of DENSITIES) {
        for (const dpr of [1, 2, 3]) {
          const fb = fbFor(w, h, density, dpr);
          expect(uiPixelFor(fb.fbW, fb.fbH, fb.scale, density), `${w}×${h} ${density} @${dpr}x`).toBe(fb.scale);
        }
      }
    }
  });

  it("gives the overlay larger pixels where the window is narrower than the reference shape", () => {
    // [window, density, scene scale → overlay pixel]: the scene keeps its detail, the controls keep their size
    expect(uiPixelFor(384, 512, 2, "crisp")).toBe(4); // 768×1024 tablet upright
    expect(uiPixelFor(320, 360, 2, "crisp")).toBe(3); // 640×720 split screen
    expect(uiPixelFor(341, 256, 3, "crisp")).toBe(4); // 1024×768
    expect(uiPixelFor(341, 455, 3, "crisp")).toBe(5); // 1024×1366 large tablet upright
    expect(uiPixelFor(256, 341, 3, "chunky")).toBe(4); // 768×1024 Chunky
    // never finer than the scene, and never so coarse that the layout loses anything
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 4000 }), fc.integer({ min: 200, max: 4000 }), fc.constantFrom(...DENSITIES), (w, h, density) => {
        const fb = fbFor(w, h, density);
        const uiK = uiPixelFor(fb.fbW, fb.fbH, fb.scale, density);
        if (!Number.isInteger(uiK) || uiK < fb.scale) return false;
        if (uiK === fb.scale) return true;
        const cw = Math.floor((fb.fbW * fb.scale) / uiK);
        const ch = Math.floor((fb.fbH * fb.scale) / uiK);
        return scrollRect(cw, ch).w === 172 && cw >= 178;
      }),
      { numRuns: 300 },
    );
  });

  it("keeps a HUD object between 6 % and 14 % of the window's shorter side in every playable popular window", () => {
    for (const fb of framebuffers(true)) {
      expect(fb.iconShare, fb.label).toBeGreaterThanOrEqual(0.06);
      expect(fb.iconShare, fb.label).toBeLessThanOrEqual(0.14);
    }
  });

  it("lays a scaled overlay out exactly as the same canvas at its own size, with hit rectangles in framebuffer pixels", () => {
    // a 768×1024 window: scene 384×512 at 2 device pixels, overlay 192×256 at 4
    const scaled = new Overlay(384, 512, 2, "crisp");
    const plain = new Overlay(192, 256, 4, "crisp");
    expect(scaled.uiK).toBe(4);
    expect(scaled.scale).toBe(2);
    expect([scaled.layer.w, scaled.layer.h]).toEqual([192, 256]);
    expect(plain.scale).toBe(1);
    for (const st of [base, ...TABS.map((tab) => ({ ...base, panel: "settings" as const, tab })), { ...base, panel: "basket" as const }]) {
      const a = scaled.draw(st).map((x) => ({ ...x }));
      const b = plain.draw(st).map((x) => ({ ...x, x: x.x * 2, y: x.y * 2, w: x.w * 2, h: x.h * 2 }));
      expect(a).toEqual(b);
      expect(Array.from(scaled.pixels)).toEqual(Array.from(plain.pixels));
    }
    // a click in framebuffer pixels lands on the control drawn there, and hover follows the pointer
    const menu = scaled.draw(base).find((x) => x.action.type === "hud" && x.action.id === "menu")!;
    expect(menu.w).toBe(32);
    expect(scaled.hitTest(menu.x + menu.w / 2, menu.y + menu.h / 2)).toEqual({ type: "hud", id: "menu" });
    expect(scaled.hitTest(380, 4)).toBeNull();
    // an overlay size that is not a multiple of the scene's (3 over 2) still maps exactly
    const odd = new Overlay(320, 360, 2, "crisp");
    expect(odd.uiK).toBe(3);
    const undo = odd.draw(base).find((x) => x.action.type === "hud" && x.action.id === "undo")!;
    expect(undo.w).toBeCloseTo(24, 9);
    expect(undo.x).toBeCloseTo(4.5, 9);
    expect(odd.hitTest(undo.x + 1, undo.y + 1)).toEqual({ type: "hud", id: "undo" });
  });

  it("puts the speech scroll above the HUD at full width where a tall canvas would squeeze it beside", () => {
    expect(scrollRect(364, 205)).toEqual({ x: 55, y: 171, w: 172, h: 32 }); // reference: beside
    expect(scrollRect(222, 125)).toEqual({ x: 55, y: 91, w: 162, h: 32 }); // short and wide: still beside
    expect(scrollRect(192, 256)).toEqual({ x: 3, y: 187, w: 172, h: 32 }); // tablet upright: above, full width
    expect(scrollRect(98, 211).w).toBe(92); // too narrow for either: above, as wide as fits
  });
});
