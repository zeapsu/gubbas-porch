import type { SandFootprint, SandRect, SandVec2 } from "../sand/types.ts";

export type RakeToolId =
  | "sugi"
  | "onami"
  | "kinu"
  | "hisui"
  | "mikazuki"
  | "tetsu"
  | "wa"
  | "take"
  | "nagi"
  | "hoki";

export interface RakeSpec {
  id: RakeToolId;
  key: string;
  name: string;
  title: string;
  shortDesc: string;
  tineCount: number;
  tineWidth: number;
  tineDepth: number;
  headWidth: number;
  profile: Int8Array;
  handle: number; // L in cells
  wave?: { amp: number; len: number };
  flat?: boolean;
  orbit?: boolean;
  action?: "sweep";
  rackX: number;
  rackSlotWidth: number;
  line: string;
}

export interface StrokeTelemetry {
  active: boolean;
  speed: number; // cells/s smoothed
  tineCount: number;
  tineWidth: number;
  tineDepth: number;
  changeRatio: number; // 0..1
  crossing: number; // 0..1
  head: SandVec2;
  tail: SandVec2;
  heading: number;
  hitStone: boolean;
  dirtyRect: SandRect | null;
}

export interface StrokePatch {
  rect: SandRect;
  beforeHeight: Int8Array;
  beforeDir: Uint8Array;
  afterHeight: Int8Array;
  afterDir: Uint8Array;
}

export interface StrokeStartContext {
  stones: readonly SandFootprint[];
  flow: boolean;
}
