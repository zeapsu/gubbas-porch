import rampsData from "../../assets/ramps.json";
import type { GubbaVariant, MoodId, RampName } from "../state/types.ts";

export interface MoodLight {
  dir: readonly [number, number, number];
  ambient: number;
  label: string;
}

export const MOOD_ORDER: readonly MoodId[] = [
  "morning",
  "afternoon",
  "dusk",
  "moonlit",
];

export const MOOD_LIGHTS: Record<MoodId, MoodLight> = {
  morning: { dir: [-0.62, 0.55, 0.45], ambient: 0.44, label: "Morning Mist" },
  afternoon: { dir: [-0.5, 0.78, 0.42], ambient: 0.32, label: "Warm Cedar Afternoon" },
  dusk: { dir: [0.66, 0.42, 0.4], ambient: 0.36, label: "Sakura Dusk" },
  moonlit: { dir: [-0.4, 0.72, -0.34], ambient: 0.46, label: "Moonlit Koi Pond" },
};

// Base 32-slot palettes from DESIGN.md Section 2.6 (slots 26-29 default to Moss Yabba)
const BASE_PALETTES: Record<MoodId, readonly string[]> = {
  morning: [
    "#8d8a80", "#b3b0a2", "#d6d3c2", "#e8e6d8", "#f6f5ec",
    "#454b52", "#6a7278", "#949c9e", "#c3c9c6",
    "#40332e", "#6c5647", "#96806a", "#bfae94",
    "#35504a", "#56796a", "#83a48a", "#b8ceae",
    "#aebfc6", "#cfdad9", "#eef0e6",
    "#4a6f80", "#7ba3ad", "#d5ebe8",
    "#b0705a", "#e0a184", "#f6dcb8",
    "#45604f", "#6f8f74", "#a3b998", "#ece8d0",
    "#2c3238", "#f3f3ea",
  ],
  afternoon: [
    "#8a7350", "#b39a6b", "#d9c492", "#ecdcae", "#f7edcb",
    "#3b3a40", "#5f5d63", "#8b8a8a", "#b9b6ac",
    "#3a2218", "#6b3f26", "#9a6238", "#c98f54",
    "#2f4a2a", "#4f7436", "#7fa04a", "#b4c96a",
    "#6fa3b5", "#a9cdbf", "#e6e2b8",
    "#2f5d74", "#4f8ea0", "#bfe3dc",
    "#a8432a", "#e2783a", "#f8c860",
    "#3f5a36", "#6a8a4a", "#9db46a", "#e8dcae",
    "#2a1d1a", "#f4ead0",
  ],
  dusk: [
    "#7a5a66", "#a8808a", "#d4aaa6", "#ecc9b8", "#f9e6d0",
    "#3a3046", "#5c4f68", "#8a7a8e", "#bba9b4",
    "#33202c", "#5e3540", "#8c5252", "#bf7f6c",
    "#2e3f3c", "#4a6450", "#7a8f62", "#b3b77e",
    "#5b4a80", "#b4688e", "#f4a688",
    "#3f4878", "#6c78a8", "#d6c6e6",
    "#c2456e", "#f089a2", "#ffd3d6",
    "#44503e", "#6d7d52", "#a0a874", "#f0dcc0",
    "#24182a", "#f8e9dc",
  ],
  moonlit: [
    "#2c3558", "#505c86", "#6a7aa2", "#8799bb", "#c6d6e6",
    "#161a2e", "#2a3150", "#4a5578", "#7886a8",
    "#14131f", "#2a2438", "#453a52", "#6a5a70",
    "#12282e", "#1f4444", "#3a6a5c", "#6a9a7c",
    "#0c1026", "#1a2248", "#34407a",
    "#10244c", "#1f4a80", "#8fd0e0",
    "#c06030", "#f0a040", "#fff0a0",
    "#1f3838", "#36585a", "#5a8478", "#b8ccc0",
    "#080a18", "#dfe8f0",
  ],
};

// Variant-specific slots 26..29 per mood (monotonically increasing in luminance & distinct from slots 0..25, 30..31)
const GUBBA_VARIANT_SLOTS: Record<
  GubbaVariant,
  Record<MoodId, readonly [string, string, string, string]>
> = {
  moss: {
    morning: ["#45604f", "#6f8f74", "#a3b998", "#ece8d0"],
    afternoon: ["#3f5a36", "#6a8a4a", "#9db46a", "#e8dcae"],
    dusk: ["#44503e", "#6d7d52", "#a0a874", "#f0dcc0"],
    moonlit: ["#1f3838", "#36585a", "#5a8478", "#b8ccc0"],
  },
  kasa: {
    morning: ["#6e5840", "#9e7c58", "#c8ab80", "#f0e6cc"],
    afternoon: ["#6b4a2e", "#a8743c", "#d4a45c", "#f0dcae"],
    dusk: ["#6a4448", "#a46a5a", "#d29a78", "#f4d8bc"],
    moonlit: ["#2c283c", "#4c425e", "#766886", "#c4bcc8"],
  },
  lantern: {
    morning: ["#484a62", "#727494", "#a4a6c2", "#e8e6ea"],
    afternoon: ["#3d3a55", "#67648a", "#9a98b8", "#e4dcd0"],
    dusk: ["#463864", "#725c92", "#a68eb8", "#ebd6e4"],
    moonlit: ["#1d2040", "#383e6e", "#626ca0", "#bcd0e8"],
  },
};

export interface RampDefinition {
  id: number;
  slots: readonly number[];
  emissive: boolean;
}

export const RAMPS: Record<RampName, RampDefinition> = rampsData.ramps as Record<
  RampName,
  RampDefinition
>;

export const RAMP_NAMES: readonly RampName[] = [
  "sand",
  "stone",
  "wood",
  "wood_light",
  "leaf",
  "water",
  "warm",
  "gubba",
  "belly",
  "cloth",
  "ink",
  "paper",
  "glow",
  "blush",
];

export function moodForHour(hour: number): MoodId {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 17) return "afternoon";
  if (h >= 17 && h < 20) return "dusk";
  return "moonlit";
}

export function getPaletteHex(
  mood: MoodId,
  variant: GubbaVariant = "moss",
): readonly string[] {
  const base = [...BASE_PALETTES[mood]];
  const gSlots = GUBBA_VARIANT_SLOTS[variant][mood];
  base[26] = gSlots[0];
  base[27] = gSlots[1];
  base[28] = gSlots[2];
  base[29] = gSlots[3];
  return base;
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  const n = Number.parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function getPaletteRgba(
  mood: MoodId,
  variant: GubbaVariant = "moss",
): Uint8Array {
  const hexes = getPaletteHex(mood, variant);
  const out = new Uint8Array(32 * 4);
  for (let i = 0; i < 32; i++) {
    const [r, g, b] = hexToRgb(hexes[i] ?? "#000000");
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function interpolatePaletteRgba(
  from: Uint8Array,
  to: Uint8Array,
  step: number, // 0..4
): Uint8Array {
  const t = Math.max(0, Math.min(4, Math.round(step))) / 4;
  const out = new Uint8Array(32 * 4);
  for (let i = 0; i < 32 * 4; i += 4) {
    out[i] = Math.round((from[i] ?? 0) * (1 - t) + (to[i] ?? 0) * t);
    out[i + 1] = Math.round((from[i + 1] ?? 0) * (1 - t) + (to[i + 1] ?? 0) * t);
    out[i + 2] = Math.round((from[i + 2] ?? 0) * (1 - t) + (to[i + 2] ?? 0) * t);
    out[i + 3] = 255;
  }
  return out;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
