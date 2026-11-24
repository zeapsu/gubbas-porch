import type { GubbaNodeName, GubbaVariant, NodeTransform } from "../state/types.ts";
import type { AutoState } from "./autoRake.ts";

/**
 * The pose layer for a Gubba who is up and about (Gubba mode, "Watch: Gubba rakes"). Pure, and it allocates
 * nothing: it is applied over the record `poseGubba` has just filled, every frame he is off his cushion.
 *
 * - `Root` is moved to where the director has him. The model is placed on the porch by the scene, so the offset
 *   is expressed in that placement's frame; his cushion is a sibling of `Root` and stays behind.
 * - The gait is locked to distance walked, not to time, so his waddle never slides against the ground: the
 *   body rolls and bobs, the head rolls back against it, the tail lags behind and whatever is on his head wobbles.
 * - His arms hold a rake, hug a stone or reach out, in place of the idle pose (the rain leaf included).
 * - The tea stays on the porch: the cup shrinks away as he leaves and is back when he sits.
 */

/** World units walked per radian of gait. */
export const GAIT_STRIDE = 9;
export const GAIT_BODY_ROLL = 0.07;
export const GAIT_BODY_BOB = 0.9;
export const GAIT_HEAD_ROLL = 0.05;
export const GAIT_TAIL_WAG = 0.22;
export const GAIT_PROP_WOBBLE = 0.06;
/** The cup is gone this far from the cushion. */
export const CUP_FADE_UNITS = 4;

const TAIL: readonly GubbaNodeName[] = ["Tail1", "Tail2", "Tail3"];
const PROP: Readonly<Record<GubbaVariant, GubbaNodeName>> = {
  moss: "Prop_Bonsai",
  kasa: "Prop_Hat",
  lantern: "Prop_Shell",
};

export function applyAutoGait(pose: Record<GubbaNodeName, NodeTransform>, a: AutoState): void {
  if (a.seated) return;
  const w = a.world;
  const dx = a.x - w.home[0];
  const dz = a.z - w.home[2];
  // the porch placement is T(home) · R_y(homeYaw); Root's offset is the world offset turned back by that yaw
  const c = Math.cos(w.homeYaw);
  const s = Math.sin(w.homeYaw);
  const root = pose.Root;
  root.pos.x = dx * c - dz * s;
  root.pos.y = a.y - w.home[1];
  root.pos.z = dx * s + dz * c;
  let turn = a.yaw - w.homeYaw;
  while (turn > Math.PI) turn -= 2 * Math.PI;
  while (turn < -Math.PI) turn += 2 * Math.PI;
  root.rot.y = turn;

  const phase = a.dist / GAIT_STRIDE;
  const amp = a.gaitAmp;
  const sway = Math.sin(phase) * amp;
  pose.Body.rot.z += GAIT_BODY_ROLL * sway;
  pose.Body.pos.y += GAIT_BODY_BOB * Math.abs(sway);
  pose.Head.rot.z -= GAIT_HEAD_ROLL * sway;
  for (let i = 0; i < 3; i++) {
    pose[TAIL[i] as GubbaNodeName].rot.y += GAIT_TAIL_WAG * Math.sin(phase - 0.7 * (i + 1)) * amp;
  }
  pose[PROP[a.variant]].rot.z += GAIT_PROP_WOBBLE * Math.sin(phase + 1) * amp;

  if (a.armOn) {
    pose.ArmL.rot.x = a.armX;
    pose.ArmR.rot.x = a.armX;
    pose.ArmL.rot.z = 0;
    pose.ArmR.rot.z = 0;
  }

  const t = Math.min(1, Math.hypot(dx, dz) / CUP_FADE_UNITS);
  const cup = 1 - t * t * (3 - 2 * t);
  pose.Cup.scale.x = cup;
  pose.Cup.scale.y = cup;
  pose.Cup.scale.z = cup;
}
