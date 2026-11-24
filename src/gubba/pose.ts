import type { GubbaNodeName, GubbaState, GubbaVariant, NodeTransform } from "../state/types.ts";
import { DOZE_AFTER_MS } from "./state.ts";

/**
 * Gubba's pose (DESIGN.md 5.2 and 5.5): a pure function of the state, the breath
 * amplitude, and the clock. All three variants (moss, kasa, lantern) share it;
 * a variant only changes which prop node moves and a few flourishes.
 *
 * Every transform is a DELTA from the node's rest pose in the .glb:
 * - `pos` is an offset in model units (y up),
 * - `rot` is an additive Euler rotation in radians,
 * - `scale` is a multiplier (1 = rest).
 * Nodes a variant does not have, and props of other variants, stay at identity,
 * so the renderer can apply the whole record and skip names the model lacks.
 *
 * The only discrete state is `dozing`, `rain`, and `targetYaw`, which jump when
 * the state changes. The renderer may damp them: pass a damped yaw as
 * `opts.headYaw` (see `dampYaw`) and low-pass the rest if it wants more softness.
 */

export const HEAD_YAW_LIMIT = 0.55;
export const BLINK_MS = 280;
export const SLEEPY_EYE_LAG_MS = 80;
export const SIP_MS = 1200;
export const TAIL_FLICK_MS = 800;
export const MOUTH_OPEN_MS = 400;
export const DOZE_EASE_MS = 1500;
/** Pupils slide up to this many eye radii. */
export const PUPIL_SLIDE_RADII = 0.2;
export const EYE_RADIUS_UNITS = 4;
/** How far a closed lid drops: the wide eye (left) and the sleepy eye (right). */
export const LID_DROP_WIDE = 4;
export const LID_DROP_SLEEPY = 3;

export const GUBBA_NODE_NAMES: readonly GubbaNodeName[] = [
  "Root",
  "Body",
  "Head",
  "EyeL",
  "EyeR",
  "PupilL",
  "PupilR",
  "LidL",
  "LidR",
  "Mouth",
  "ArmL",
  "ArmR",
  "Cup",
  "Tail1",
  "Tail2",
  "Tail3",
  "Prop_Bonsai",
  "Prop_Hat",
  "Prop_Shell",
];

export type GubbaPose = Record<GubbaNodeName, NodeTransform>;

export interface PoseOptions {
  /** Reuse a record from `createPose()` so the frame loop allocates nothing. */
  out?: GubbaPose;
  /** Damped head yaw to use instead of `g.targetYaw`. Still clamped to +-0.55. */
  headYaw?: number;
}

function identity(): NodeTransform {
  return { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
}

export function createPose(): GubbaPose {
  const pose = {} as GubbaPose;
  for (const name of GUBBA_NODE_NAMES) pose[name] = identity();
  return pose;
}

function reset(t: NodeTransform): NodeTransform {
  t.pos.x = t.pos.y = t.pos.z = 0;
  t.rot.x = t.rot.y = t.rot.z = 0;
  t.scale.x = t.scale.y = t.scale.z = 1;
  return t;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

/** Frame-rate independent exponential approach for the head yaw. */
export function dampYaw(current: number, target: number, dtMs: number, halfLifeMs = 120): number {
  const k = 1 - Math.pow(0.5, Math.max(0, dtMs) / halfLifeMs);
  return clamp(current + (target - current) * k, -HEAD_YAW_LIMIT, HEAD_YAW_LIMIT);
}

/** 0 -> 1 -> 0 over `durationMs`, starting at `startMs`; 0 outside. */
function bump(nowMs: number, startMs: number, durationMs: number): number {
  const t = nowMs - startMs;
  if (t < 0 || t >= durationMs) return 0;
  return Math.sin((Math.PI * t) / durationMs);
}

function propFor(variant: GubbaVariant): GubbaNodeName {
  return variant === "moss" ? "Prop_Bonsai" : variant === "kasa" ? "Prop_Hat" : "Prop_Shell";
}

export function poseGubba(
  g: GubbaState,
  amplitude: number,
  nowMs: number,
  opts: PoseOptions = {},
): GubbaPose {
  const p = opts.out ?? createPose();
  for (const name of GUBBA_NODE_NAMES) reset(p[name]);

  const a = clamp(Number.isFinite(amplitude) ? amplitude : 0, 0, 1);
  const yaw = clamp(opts.headYaw ?? g.targetYaw, -HEAD_YAW_LIMIT, HEAD_YAW_LIMIT);
  const yawN = yaw / HEAD_YAW_LIMIT; // -1..1

  // Doze eases in over 1.5 s from the moment it began (3 minutes after the last input).
  let doze = 0;
  if (g.dozing) {
    const since = nowMs - g.lastInputMs - DOZE_AFTER_MS;
    doze = since < 0 ? 1 : smoothstep(since / DOZE_EASE_MS);
  }

  const sip = g.dozing ? 0 : sipEnvelope(nowMs - g.sipStartMs);

  // Body: breath squash and stretch (within 4% of rest).
  const body = p.Body;
  body.scale.x = 1 + 0.02 * a;
  body.scale.y = 1 + 0.035 * a;
  body.scale.z = 1 + 0.02 * a;

  // Head: yaw, a 0.6-unit breath bob, sinks 1 unit when dozing, dips for the sip.
  const head = p.Head;
  head.rot.y = yaw;
  head.rot.x = 0.28 * sip + 0.12 * doze;
  head.pos.y = 0.6 * a - 1 * doze - 0.8 * sip;

  // Eyes. Lantern's eye stalks lean toward the target and sag when dozing.
  if (g.variant === "lantern") {
    p.EyeL.rot.z = 0 - 0.12 * yawN;
    p.EyeR.rot.z = 0 - 0.09 * yawN;
    p.EyeL.rot.x = 0.5 * doze;
    p.EyeR.rot.x = 0.35 * doze;
  }

  // Pupils slide up to 0.2 radii toward the target; the sleepy (right) eye is out of step.
  const slide = PUPIL_SLIDE_RADII * EYE_RADIUS_UNITS;
  p.PupilL.pos.x = slide * yawN;
  p.PupilR.pos.x = slide * 0.8 * yawN;
  p.PupilR.pos.y = g.watchingRake ? 0 - 0.15 * slide : 0;
  p.PupilL.pos.y = g.watchingRake ? 0.1 * slide : 0;

  // Lopsided blink: the sleepy eye closes 80 ms after the wide one, 280 ms each.
  const blinkWide = g.dozing ? 0 : bump(nowMs, g.blinkStartMs, BLINK_MS);
  const blinkSleepy = g.dozing ? 0 : bump(nowMs, g.blinkStartMs + SLEEPY_EYE_LAG_MS, BLINK_MS);
  p.LidL.pos.y = 0 - LID_DROP_WIDE * Math.max(blinkWide, doze);
  p.LidR.pos.y = 0 - LID_DROP_SLEEPY * Math.max(blinkSleepy, doze);

  // Mouth opens 1 unit for the first 400 ms of a line.
  const s = g.speech;
  if (s !== null) {
    const t = nowMs - s.startedAtMs;
    if (t >= 0 && t < MOUTH_OPEN_MS) {
      p.Mouth.pos.y = 0 - Math.min(1, t / 60, (MOUTH_OPEN_MS - t) / 60);
    }
  }

  // Sip: the tiny arm strains upward and the cup follows. Rain: both arms hold a leaf up.
  const rain = g.rain ? 1 : 0;
  p.ArmR.rot.x = 0 - 0.45 * sip - 1.3 * rain;
  p.ArmL.rot.x = 0 - 0.2 * sip - 1.3 * rain;
  p.ArmL.rot.z = 0.25 * rain;
  p.ArmR.rot.z = 0 - 0.25 * rain;
  p.Cup.pos.y = 0.6 * sip;
  p.Cup.rot.x = 0 - 0.2 * sip;

  // Tail: a gentle sway, and one flick every 20-40 s that travels down the segments.
  const tail: readonly GubbaNodeName[] = ["Tail1", "Tail2", "Tail3"];
  for (let i = 0; i < 3; i++) {
    const seg = p[tail[i] as GubbaNodeName];
    const flick = bump(nowMs, g.tailFlickStartMs + i * 110, TAIL_FLICK_MS);
    seg.rot.y = 0.05 * Math.sin(nowMs / 2100 + i * 0.9) + 0.45 * (1 + 0.2 * i) * flick;
  }

  // The variant's prop bobs a little out of phase with the breath, and slides askew when dozing.
  const prop = p[propFor(g.variant)];
  prop.pos.y = 0.4 * a + 0.3 * Math.sin(nowMs / 1900 + 1.3);
  prop.rot.z = 0.04 * Math.sin(nowMs / 2300 + 0.4) + 0.3 * doze;
  prop.pos.x = 0.7 * doze;

  return p;
}

/** Smooth in, hold, smooth out over the 1.2 s sip; 0 outside it. */
function sipEnvelope(sinceStartMs: number): number {
  if (sinceStartMs < 0 || sinceStartMs >= SIP_MS) return 0;
  const up = smoothstep(sinceStartMs / (SIP_MS * 0.3));
  const down = smoothstep((SIP_MS - sinceStartMs) / (SIP_MS * 0.3));
  return Math.min(up, down);
}
