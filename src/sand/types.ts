export const SAND_W = 192 as const;
export const SAND_H = 112 as const;
export const SAND_CELLS = 192 * 112;
export const KEEP = 127 as const;
export const DIR_UNRAKED = 255 as const;

export interface SandVec2 {
  x: number;
  y: number;
}

export interface SandRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SandFootprint {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

export interface SandGrid {
  readonly w: 192;
  readonly h: 112;
  height: Int8Array;
  dir: Uint8Array;
  rock: Uint8Array;
}

export interface RakeStampProfile {
  profile: Int8Array;
  flat?: boolean;
}
