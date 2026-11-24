// GLSL for the five-pass pipeline (DESIGN.md 2.1). Every constant that also exists on the CPU side is
// interpolated from tone.ts, so the shader and the unit-tested maths cannot drift apart.
//
// G-buffer layout (pass 2, two RGBA8 attachments, NearestFilter):
//   g0.r  ramp id (0…13, assets/ramps.json)          g0.g  N·L mapped from −1…1 to 0…1
//   g0.b  flags: 1 shadowed · 2 emissive · 4 no-outline · 8 direct slot (palette slot already decided in g1.r)
//   g0.a  part id 0…255 (0 = ground, never outlines, never picks)
//   g1.r  direct palette slot (sand tone, deck and wall planks, particles, unlit lantern glass)
//   g1.g  surface kind (0 ramp · 1 sand · 2 deck · 3 wall · 4 particle)   g1.a  1 where anything was drawn (0 = sky)

import {
  BAYER4,
  OUTLINE_DEPTH_RATIO,
  RAMP_DITHER,
  SAND_BASE,
  SAND_DITHER,
  SAND_HEIGHT,
  SAND_LIFT_PER_LEVEL,
  SAND_SHADOW,
  SAND_SLOPE,
  SHADOW_AMBIENT_CAP,
  UNLIT_NDL,
} from "./tone.ts";

/** Node matrices per merged model (rigid "skinning": one draw call per model, one matrix per posable node). */
export const MAX_NODES = 32;
export const RAMP_COUNT = 14;
export const RAMP_MAX_LEN = 5;

/** Per-vertex flag bits in `aInfo.z`. */
export const VFLAG_NO_CAST = 1;
export const VFLAG_NO_OUTLINE = 2;
export const VFLAG_FLOOR = 4;
export const VFLAG_WALL = 8;

/** G-buffer flag bits in g0.b. */
export const GFLAG_SHADOW = 1;
export const GFLAG_EMISSIVE = 2;
export const GFLAG_NO_OUTLINE = 4;
export const GFLAG_DIRECT = 8;

export const RAMP_ID_WATER = 5;
export const RAMP_ID_GLOW = 12;

export const SLOT = {
  sand0: 0,
  sand1: 1,
  sand4: 4,
  wood0: 9,
  sky0: 17,
  sky1: 18,
  sky2: 19,
  warm1: 24,
  warm2: 25,
  ink: 30,
  paper: 31,
} as const;

const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`);

const BAYER_GLSL = `const float BAYER[16] = float[16](${BAYER4.map(f).join(", ")});`;

/** Shared by every G-buffer fragment shader. */
const GBUFFER_COMMON = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
${BAYER_GLSL}
uniform vec2 uFbSize;
uniform vec3 uLightDir;
uniform sampler2D uShadowMap;
uniform mat4 uLightMatrix;
uniform float uLightDepthRange;
uniform float uShadowsOn;

layout(location = 0) out vec4 g0;
layout(location = 1) out vec4 g1;

// Framebuffer pixels are indexed top-down, as in the mockup, so dither cells line up with the overlay.
float bayerAt(vec2 fc) {
  int x = int(floor(fc.x));
  int y = int(uFbSize.y) - 1 - int(floor(fc.y));
  return (BAYER[(x & 3) + 4 * (y & 3)] + 0.5) / 16.0;
}

uint hash2(int x, int y) {
  uint h = uint(x) * 374761393u + uint(y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}

// Hard, unfiltered shadow lookup with slope-scaled bias min(7, 1.5 / max(0.2, N·L)) world units.
bool inShadow(vec3 world, float ndl) {
  if (uShadowsOn < 0.5) return false;
  vec4 lp = uLightMatrix * vec4(world, 1.0);
  vec3 ndc = lp.xyz / lp.w;
  vec2 uv = ndc.xy * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return false;
  float d = ndc.z * 0.5 + 0.5;
  float bias = min(7.0, 1.5 / max(0.2, ndl)) / uLightDepthRange;
  return d - bias > texture(uShadowMap, uv).r;
}

void writeDirect(int slot, int partId, float ndl, int extraFlags, float kind) {
  g0 = vec4(0.0, ndl * 0.5 + 0.5, float(${GFLAG_DIRECT} | extraFlags) / 255.0, float(partId) / 255.0);
  g1 = vec4(float(slot) / 255.0, kind / 255.0, 0.0, 1.0);
}
`;

/** Vertex shader for merged models (static props, rakes, Gubba, elements). */
export const MODEL_VERTEX = /* glsl */ `
precision highp float;
in vec4 aInfo;
uniform mat4 uNodes[${MAX_NODES}];
out vec3 vWorld;
out vec3 vNormal;
flat out vec4 vInfo;
flat out vec3 vNodeOrigin;
void main() {
  mat4 wm = modelMatrix * uNodes[int(aInfo.w + 0.5)];
  vec4 wp = wm * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = transpose(inverse(mat3(wm))) * normal;
  vInfo = aInfo;
  vNodeOrigin = (wm * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/** Fragment shader for merged models: writes ramp id, N·L, shadow and part id; decks and walls get plank seams. */
export const MODEL_FRAGMENT = /* glsl */ `
${GBUFFER_COMMON}
in vec3 vWorld;
in vec3 vNormal;
flat in vec4 vInfo;
flat in vec3 vNodeOrigin;
uniform float uGlowLit;
uniform float uRippleFrame;

int floorSlot(vec3 w, float b, bool sh) {
  float zz = w.z + 400.0;
  float board = floor(zz / 9.0);
  bool seam = mod(zz, 9.0) < 1.1 || mod(w.x + 800.0 + board * 37.0, 64.0) < 1.1;
  int t = seam ? 1 : ((hash2(int(floor((w.x + 800.0) / 5.0)), int(board)) % 29u) == 0u ? 3 : 2);
  if (sh) t = b < 0.6 ? 0 : 1;
  return ${SLOT.wood0} + t;
}

int wallSlot(vec3 w, float b, bool sh) {
  float xx = w.x + 400.0;
  int plank = int(floor(xx / 13.0));
  bool seam = mod(xx, 13.0) < 1.1;
  int t = seam ? 0 : ((hash2(plank, int(floor(w.y / 7.0))) % 11u) == 0u ? 2 : 1);
  if (sh && t > 0) t = b < 0.55 ? 0 : 1;
  return ${SLOT.wood0} + t;
}

void main() {
  int ramp = int(vInfo.x + 0.5);
  int partId = int(vInfo.y + 0.5);
  int vflags = int(vInfo.z + 0.5);
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  float ndl = dot(n, uLightDir);
  float b = bayerAt(gl_FragCoord.xy);
  int outline = (vflags & ${VFLAG_NO_OUTLINE}) != 0 ? ${GFLAG_NO_OUTLINE} : 0;

  if ((vflags & ${VFLAG_FLOOR}) != 0) {
    float nl = uLightDir.y;
    bool sh = nl <= ${f(UNLIT_NDL)} || inShadow(vWorld, nl);
    writeDirect(floorSlot(vWorld, b, sh), partId, ndl, outline | (sh ? ${GFLAG_SHADOW} : 0), 2.0);
    return;
  }
  if ((vflags & ${VFLAG_WALL}) != 0) {
    float nl = uLightDir.z;
    bool sh = nl <= ${f(UNLIT_NDL)} || inShadow(vWorld, nl);
    writeDirect(wallSlot(vWorld, b, sh), partId, ndl, outline | (sh ? ${GFLAG_SHADOW} : 0), 3.0);
    return;
  }
  if (ramp == ${RAMP_ID_GLOW} && uGlowLit < 0.5) {
    // the lantern window and the shell's firefly only glow at dusk and at night
    writeDirect(${SLOT.wood0}, partId, ndl, outline, 0.0);
    return;
  }
  if (ramp == ${RAMP_ID_WATER} && n.y > 0.8) {
    // a 4-frame ripple: rings walk outward from the water's node origin
    float r = length(vWorld.xz - vNodeOrigin.xz);
    float ring = fract(r / 4.0 - uRippleFrame / 4.0);
    if (ring < 0.22) ndl = min(1.0, ndl + 0.45);
  }
  bool sh = ndl <= ${f(UNLIT_NDL)} || inShadow(vWorld, ndl);
  int fl = outline | (sh ? ${GFLAG_SHADOW} : 0);
  g0 = vec4(float(ramp) / 255.0, clamp(ndl * 0.5 + 0.5, 0.0, 1.0), float(fl) / 255.0, float(partId) / 255.0);
  g1 = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

/** Depth-only pass from the light: same node maths, honours `cast = false`. */
export const MODEL_DEPTH_FRAGMENT = /* glsl */ `
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
flat in vec4 vInfo;
flat in vec3 vNodeOrigin;
layout(location = 0) out vec4 o;
void main() {
  if ((int(vInfo.z + 0.5) & ${VFLAG_NO_CAST}) != 0) discard;
  o = vec4(1.0);
}
`;

/** Sand vertex shader: a 192×112-segment plane at y = 3 lifted by 0.35 · height. */
export const SAND_VERTEX = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uHeight;
out vec3 vWorld;
void main() {
  vec3 p = position;
  vec2 g = p.xz + vec2(96.0, 56.0);
  float h = textureLod(uHeight, g / vec2(192.0, 112.0), 0.0).r * 255.0 - 3.0;
  p.y += ${f(SAND_LIFT_PER_LEVEL)} * h;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/** Sand fragment shader: per-pixel tone from the heightmap gradient (DESIGN.md 3.5, 3.7, 6, 2.8). */
export const SAND_FRAGMENT = /* glsl */ `
${GBUFFER_COMMON}
in vec3 vWorld;
uniform sampler2D uHeight;
uniform sampler2D uDir;
uniform float uSandE;
uniform float uSweepE;
uniform float uThread;
uniform vec4 uGlow[4];
uniform int uGlowCount;

float hAt(vec2 g) {
  return texture(uHeight, g / vec2(192.0, 112.0)).r * 255.0 - 3.0;
}

void main() {
  vec2 g = vWorld.xz + vec2(96.0, 56.0);
  float b = bayerAt(gl_FragCoord.xy);
  float nl = uLightDir.y;
  bool sh = nl <= ${f(UNLIT_NDL)} || inShadow(vWorld, nl);
  int shFlag = sh ? ${GFLAG_SHADOW} : 0;
  if (g.x < 0.0 || g.y < 0.0 || g.x >= 192.0 || g.y >= 112.0) {
    writeDirect(2, 0, nl, shFlag, 1.0);
    return;
  }
  float e = uSandE;
  float h = hAt(g);
  float dx = (hAt(g + vec2(e, 0.0)) - hAt(g - vec2(e, 0.0))) / (2.0 * e);
  float dz = (hAt(g + vec2(0.0, e)) - hAt(g - vec2(0.0, e))) / (2.0 * e);
  float hl = max(1e-4, length(uLightDir.xz));
  float s = -(dx * uLightDir.x + dz * uLightDir.z) / hl;
  float t = ${f(SAND_BASE)} + ${f(SAND_SLOPE)} * s + ${f(SAND_HEIGHT)} * h;
  ivec2 cell = ivec2(floor(g));
  float dir = texelFetch(uDir, cell, 0).r * 255.0;
  float hc = texelFetch(uHeight, cell, 0).r * 255.0 - 3.0;
  if (dir > 254.5 && abs(hc) < 0.5) {
    uint gr = hash2(cell.x, cell.y) & 31u;
    if (gr == 0u) t -= 1.0; else if (gr == 1u) t += 1.0;
  }
  if (sh) t -= ${f(SAND_SHADOW)};

  // the smoothing sweep's rolling crest: two cells of sand4, then one of sand1
  if (uSweepE >= 0.0) {
    float front = -8.0 + 208.0 * uSweepE + 4.0 * sin(3.14159265 * g.y / 112.0);
    if (g.x <= front && g.x > front - 2.2) { writeDirect(${SLOT.sand4}, 0, nl, shFlag, 1.0); return; }
    if (g.x <= front - 2.2 && g.x > front - 3.4) { writeDirect(${SLOT.sand1}, 0, nl, shFlag, 1.0); return; }
  }
  // the breath thread: clockwise from the front-left corner along the inner edge
  if (uThread > 0.0) {
    float m = min(min(g.x, g.y), min(192.0 - g.x, 112.0 - g.y));
    if (m < 1.3) {
      float pos;
      if (g.x < 1.3) pos = 112.0 - g.y;
      else if (g.y < 1.3) pos = 112.0 + g.x;
      else if (g.x > 192.0 - 1.3) pos = 304.0 + g.y;
      else pos = 416.0 + (192.0 - g.x);
      if (pos < uThread) { writeDirect(${SLOT.sand4}, 0, nl, shFlag, 1.0); return; }
    }
  }
  // dithered warm glow round lit lanterns
  for (int i = 0; i < 4; i++) {
    if (i >= uGlowCount) break;
    vec2 d = g - uGlow[i].xy;
    float q = dot(d, d);
    if (q < 190.0 && b > 0.25 + q / 260.0) {
      writeDirect(q < 70.0 ? ${SLOT.warm2} : ${SLOT.warm1}, 0, nl, shFlag, 1.0);
      return;
    }
  }
  int k = int(clamp(floor(t + 0.5 + (b - 0.5) * ${f(SAND_DITHER)}), 0.0, 4.0));
  writeDirect(k, 0, nl, shFlag, 1.0);
}
`;

/** Single-pixel world-space particles; each carries its own palette slot. */
export const PARTICLE_VERTEX = /* glsl */ `
precision highp float;
in float aSlot;
flat out int vSlot;
void main() {
  vSlot = int(aSlot + 0.5);
  gl_PointSize = 1.0;
  if (aSlot < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

export const PARTICLE_FRAGMENT = /* glsl */ `
precision highp float;
flat in int vSlot;
layout(location = 0) out vec4 g0;
layout(location = 1) out vec4 g1;
void main() {
  g0 = vec4(0.0, 0.5, float(${GFLAG_DIRECT} | ${GFLAG_NO_OUTLINE}) / 255.0, 0.0);
  g1 = vec4(float(vSlot) / 255.0, 4.0 / 255.0, 0.0, 1.0);
}
`;

/** Full-screen triangle-pair vertex shader for passes 3–5. */
export const FULLSCREEN_VERTEX = /* glsl */ `
precision highp float;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Pass 3, resolve: G-buffer → palette slot → colour. Cel step on the material's ramp with Bayer dither, shadow
 * cap, sky bands, sun or moon disc, and the 1-pixel ink outline on the farther pixel.
 */
export const RESOLVE_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
${BAYER_GLSL}
uniform sampler2D tG0;
uniform sampler2D tG1;
uniform sampler2D tDepth;
uniform sampler2D tPalette;
uniform vec2 uFbSize;
uniform float uAmbient;
uniform float uNear;
uniform float uFar;
uniform int uRampSlots[${RAMP_COUNT * RAMP_MAX_LEN}];
uniform int uRampLen[${RAMP_COUNT}];
uniform vec3 uSun;
layout(location = 0) out vec4 outColor;

float invDepth(ivec2 p) {
  float d = texelFetch(tDepth, p, 0).r;
  if (d >= 1.0) return 0.0;
  float viewZ = (uNear * uFar) / ((uFar - uNear) * d - uFar);
  return 1.0 / max(1e-6, -viewZ);
}

bool outlines(ivec2 q, int part0, float iz) {
  vec4 a = texelFetch(tG0, q, 0);
  int pj = int(a.a * 255.0 + 0.5);
  if (pj == 0 || pj == part0) return false;
  int fl = int(a.b * 255.0 + 0.5);
  if ((fl & ${GFLAG_NO_OUTLINE}) != 0) return false;
  return invDepth(q) > iz * ${f(OUTLINE_DEPTH_RATIO)};
}

void main() {
  ivec2 p = ivec2(floor(gl_FragCoord.xy));
  int W = int(uFbSize.x);
  int H = int(uFbSize.y);
  int py = H - 1 - p.y;
  float b = (BAYER[(p.x & 3) + 4 * (py & 3)] + 0.5) / 16.0;
  vec4 a = texelFetch(tG0, p, 0);
  vec4 c = texelFetch(tG1, p, 0);
  int slot;
  if (c.a < 0.5) {
    float v = float(py) / float(H) + (b - 0.5) * 0.12;
    slot = v < 0.1 ? ${SLOT.sky0} : (v < 0.2 ? ${SLOT.sky1} : ${SLOT.sky2});
    int sx = int(floor(float(W) * 0.78 + 0.5));
    int sy = int(floor(float(H) * 0.07 + 0.5));
    int dx = p.x - sx;
    int dy = py - sy;
    if (uSun.z >= 0.0 && dx * dx + dy * dy <= 14) slot = int(uSun.z);
  } else {
    int fl = int(a.b * 255.0 + 0.5);
    if ((fl & ${GFLAG_DIRECT}) != 0) {
      slot = int(c.r * 255.0 + 0.5);
    } else {
      int ramp = clamp(int(a.r * 255.0 + 0.5), 0, ${RAMP_COUNT - 1});
      int n = uRampLen[ramp];
      if (n <= 1) {
        slot = uRampSlots[ramp * ${RAMP_MAX_LEN}];
      } else {
        float ndl = a.g * 2.0 - 1.0;
        float I = ndl * (1.0 - uAmbient) + uAmbient;
        if ((fl & ${GFLAG_SHADOW}) != 0 || ndl <= ${f(UNLIT_NDL)}) I = min(I, ${f(SHADOW_AMBIENT_CAP)} * uAmbient);
        int t = int(floor(I * float(n) + (b - 0.5) * ${f(RAMP_DITHER)}));
        t = clamp(t, 0, n - 1);
        slot = uRampSlots[ramp * ${RAMP_MAX_LEN} + t];
      }
    }
  }
  int part0 = int(a.a * 255.0 + 0.5);
  float iz = c.a < 0.5 ? 0.0 : invDepth(p);
  if ((p.x > 0 && outlines(p - ivec2(1, 0), part0, iz)) ||
      (p.x < W - 1 && outlines(p + ivec2(1, 0), part0, iz)) ||
      (p.y > 0 && outlines(p - ivec2(0, 1), part0, iz)) ||
      (p.y < H - 1 && outlines(p + ivec2(0, 1), part0, iz))) {
    slot = ${SLOT.ink};
  }
  outColor = texelFetch(tPalette, ivec2(slot, 0), 0);
}
`;

/** Pass 4, overlay: palette-indexed 2D pixels (255 = transparent) over the resolved scene. */
export const OVERLAY_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D tScene;
uniform sampler2D tOverlay;
uniform sampler2D tPalette;
uniform vec2 uFbSize;
uniform float uOverlayOn;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(floor(gl_FragCoord.xy));
  vec4 col = texelFetch(tScene, p, 0);
  if (uOverlayOn > 0.5) {
    int idx = int(texelFetch(tOverlay, ivec2(p.x, int(uFbSize.y) - 1 - p.y), 0).r * 255.0 + 0.5);
    if (idx < 32) col = texelFetch(tPalette, ivec2(idx, 0), 0);
  }
  outColor = vec4(col.rgb, 1.0);
}
`;

/** Pass 5, present: nearest-neighbour blit at integer scale k. */
export const PRESENT_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D tFinal;
uniform float uScale;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(floor(gl_FragCoord.xy / uScale));
  outColor = vec4(texelFetch(tFinal, p, 0).rgb, 1.0);
}
`;
