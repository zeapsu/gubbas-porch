/// <reference types="vite/client" />
// Loads the 30 committed `.glb` models (DESIGN.md 8) and turns their meshes into G-buffer geometry.
//
// Models never carry colours: every material is named `rm_<ramp>`. Instead of one Three.js material per ramp,
// the ramp id is baked into a per-vertex attribute (`aInfo = ramp, part, flags, node`), so every mesh of a model
// shares the one G-buffer ShaderMaterial and a whole model is a single draw call. glTF `extras.part`,
// `extras.cast` and `extras.line` (Three's `userData`) set the part id, shadow casting and outlines.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Matrix3,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import type { Material, Object3D ,
  Matrix4} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import specJson from "../../../assets/models.spec.json";
import type { RampName } from "../../state/types.ts";
import { RAMPS } from "../palettes.ts";
import { VFLAG_NO_CAST, VFLAG_NO_OUTLINE } from "../pipeline/shaders.ts";

export interface ModelSpecEntry {
  id: string;
  file: string;
  requiredNodes: string[];
  materials: string[];
  bounds: { size: number[]; tolerance: number };
  origin: string;
}

export const MODEL_SPECS: readonly ModelSpecEntry[] = (specJson as { models: ModelSpecEntry[] }).models;

export function modelUrl(file: string, baseUrl: string = import.meta.env.BASE_URL): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}assets/models/${file}`;
}

export interface LoadedModels {
  /** Model roots by spec id (`rake_sugi`, `prop_engawa`, `gubba_moss`, …). */
  roots: Map<string, Object3D>;
  /** Spec ids that failed to load (replaced by procedural stand-ins). */
  failed: string[];
  /** Spec ids whose committed file is a box placeholder (replaced by procedural stand-ins). */
  standIns: string[];
}

/** The generator string `npm run assets:placeholders` writes into its box-only files. */
export const PLACEHOLDER_GENERATOR = "rake-me-placeholder";

/**
 * Loads every model in the spec in parallel. A file that fails to load, or that is still a box placeholder,
 * is replaced by a procedural stand-in built from the same lumps as the design mockup, so the garden always
 * renders as designed. Real Blender exports are used as soon as they are committed. Never rejects.
 */
export async function loadModels(
  baseUrl: string = import.meta.env.BASE_URL,
  onProgress?: (loaded: number, total: number) => void,
): Promise<LoadedModels> {
  const loader = new GLTFLoader();
  const roots = new Map<string, Object3D>();
  const failed: string[] = [];
  const standIns: string[] = [];
  let loaded = 0;
  await Promise.all(
    MODEL_SPECS.map(async (m) => {
      let root: Object3D | null = null;
      try {
        const gltf = await loader.loadAsync(modelUrl(m.file, baseUrl));
        const generator = (gltf.asset as { generator?: string } | undefined)?.generator ?? "";
        if (generator.startsWith(PLACEHOLDER_GENERATOR)) standIns.push(m.id);
        else root = gltf.scene;
      } catch {
        failed.push(m.id);
      }
      roots.set(m.id, root ?? standInModel(m.id));
      loaded++;
      onProgress?.(loaded, MODEL_SPECS.length);
    }),
  );
  return { roots, failed, standIns };
}

const RAMP_BY_NAME = RAMPS as Record<string, { id: number } | undefined>;

/** Ramp id for a `rm_<ramp>` material name (Blender may append `.001`); unknown names fall back to `stone`. */
export function rampIdForMaterial(name: string | undefined): number {
  const clean = (name ?? "").replace(/\.\d+$/, "");
  const ramp = clean.startsWith("rm_") ? clean.slice(3) : clean;
  return RAMP_BY_NAME[ramp]?.id ?? RAMPS.stone.id;
}

export function rampId(name: RampName): number {
  return RAMPS[name].id;
}

/** The glTF node name of an object (GLTFLoader keeps the original in `userData.name`). */
export function nodeName(o: Object3D): string {
  const n = (o.userData as { name?: unknown }).name;
  return typeof n === "string" ? n : o.name;
}

export interface MeshInfo {
  mesh: Mesh;
  ramp: number;
  /** Grouping key for part ids: `extras.part`, else the owning node's name (`tine_*` nodes share "tines"). */
  partKey: string;
  cast: boolean;
  line: boolean;
}

function inherited(o: Object3D, key: "part" | "cast" | "line", stop: Object3D): unknown {
  for (let p: Object3D | null = o; p; p = p.parent) {
    const v = (p.userData as Record<string, unknown>)[key];
    if (v !== undefined) return v;
    if (p === stop) break;
  }
  return undefined;
}

/** Every mesh under `root`, with world matrices updated relative to `root`'s own parent. */
export function collectMeshes(root: Object3D): MeshInfo[] {
  root.updateMatrixWorld(true);
  const out: MeshInfo[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as Material | undefined;
    let key: string;
    const part = inherited(mesh, "part", root);
    if (part !== undefined && part !== null && part !== "") key = String(part);
    else {
      let owner: Object3D = mesh;
      for (let p: Object3D | null = mesh; p; p = p.parent) {
        if (typeof (p.userData as { name?: unknown }).name === "string") {
          owner = p;
          break;
        }
        if (p === root) break;
      }
      key = nodeName(owner);
    }
    if (/^tine_\d+/.test(key)) key = "tines";
    out.push({
      mesh,
      ramp: rampIdForMaterial(mat?.name),
      partKey: key,
      cast: inherited(mesh, "cast", root) !== false,
      line: inherited(mesh, "line", root) !== false,
    });
  });
  return out;
}

const _v = new Vector3();
const _n = new Vector3();
const _nm = new Matrix3();

/** Accumulates meshes into one indexed geometry with `position`, `normal` and `aInfo` attributes. */
export class GeometryBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private info: number[] = [];
  private idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  /**
   * Appends `geometry` transformed by `matrix` (vertex → node space). `flags` are VFLAG_* bits; `cast`/`line`
   * false add NO_CAST / NO_OUTLINE.
   */
  add(
    geometry: BufferGeometry,
    matrix: Matrix4,
    ramp: number,
    part: number,
    flags: number,
    node: number,
  ): void {
    const p = geometry.getAttribute("position");
    if (!p) return;
    const n = geometry.getAttribute("normal");
    _nm.getNormalMatrix(matrix);
    const base = this.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      this.pos.push(_v.x, _v.y, _v.z);
      if (n) _n.fromBufferAttribute(n, i).applyMatrix3(_nm).normalize();
      else _n.set(0, 1, 0);
      this.nor.push(_n.x, _n.y, _n.z);
      this.info.push(ramp, part, flags, node);
    }
    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    } else {
      for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    }
    // geometry without normals would shade flat-black; compute face normals afterwards if needed
    if (!n) this.flatNormalsFrom(base);
  }

  addMeshInfo(m: MeshInfo, matrix: Matrix4, part: number, extraFlags: number, node: number): void {
    const flags = extraFlags | (m.cast ? 0 : VFLAG_NO_CAST) | (m.line ? 0 : VFLAG_NO_OUTLINE);
    this.add(m.mesh.geometry, matrix, m.ramp, part, flags, node);
  }

  private flatNormalsFrom(baseVertex: number): void {
    for (let t = 0; t < this.idx.length; t += 3) {
      const a = this.idx[t] ?? 0;
      if (a < baseVertex) continue;
      const b = this.idx[t + 1] ?? 0;
      const c = this.idx[t + 2] ?? 0;
      const ax = this.pos[a * 3] ?? 0, ay = this.pos[a * 3 + 1] ?? 0, az = this.pos[a * 3 + 2] ?? 0;
      const ux = (this.pos[b * 3] ?? 0) - ax, uy = (this.pos[b * 3 + 1] ?? 0) - ay, uz = (this.pos[b * 3 + 2] ?? 0) - az;
      const vx = (this.pos[c * 3] ?? 0) - ax, vy = (this.pos[c * 3 + 1] ?? 0) - ay, vz = (this.pos[c * 3 + 2] ?? 0) - az;
      _n.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
      for (const k of [a, b, c]) {
        this.nor[k * 3] = _n.x;
        this.nor[k * 3 + 1] = _n.y;
        this.nor[k * 3 + 2] = _n.z;
      }
    }
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("normal", new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute("aInfo", new BufferAttribute(new Float32Array(this.info), 4));
    const vc = this.pos.length / 3;
    g.setIndex(new BufferAttribute(vc > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** World-space bounding box of a model root, as [min, max]. */
export function modelBounds(root: Object3D): [Vector3, Vector3] {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of collectMeshes(root)) {
    const p = m.mesh.geometry.getAttribute("position");
    if (!p) continue;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m.mesh.matrixWorld);
      min.min(_v);
      max.max(_v);
    }
  }
  if (!Number.isFinite(min.x)) {
    min.set(0, 0, 0);
    max.set(0, 0, 0);
  }
  return [min, max];
}

// ---------------------------------------------------------------------------------------------------------------
// Rack layout (DESIGN.md 4.2): slot centre x and width, left to right in key order.

export const RACK_ORDER = ["sugi", "onami", "kinu", "hisui", "mikazuki", "tetsu", "wa", "take", "nagi", "hoki"] as const;
export const RACK_SLOTS: Readonly<Record<(typeof RACK_ORDER)[number], { x: number; w: number }>> = {
  sugi: { x: -98.8, w: 20 },
  onami: { x: -67.4, w: 36 },
  kinu: { x: -34.5, w: 23 },
  hisui: { x: -10.1, w: 19 },
  mikazuki: { x: 14.8, w: 24 },
  tetsu: { x: 38.7, w: 17 },
  wa: { x: 56.6, w: 12 },
  take: { x: 70.0, w: 8 },
  nagi: { x: 85.4, w: 16 },
  hoki: { x: 102.8, w: 12 },
};

/** World placement of the static props (DESIGN.md 2.3; origins at the footprint centre on the ground). */
export const WALL_Z = -74;
export const HANG_Y = 54;
export const HANG_Z = WALL_Z + 8.6;
export const PROP_ORIGINS = {
  frame: [0, 0, 0],
  rack: [20, 0, -74],
  bamboo: [31, 0, -92],
  shishi: [-122, 0, -38],
  basket: [116, 0, 44],
  shelfBonsai: [142, 41.1, WALL_Z + 5.5],
  gubba: [132, 0, 2],
} as const;
export const GUBBA_YAW = -0.5;

// ---------------------------------------------------------------------------------------------------------------
// Procedural stand-ins. They reproduce the low-poly lumps of docs/mockups/garden-layout.html with the node
// names, `rm_<ramp>` materials and `extras` the Blender build uses, so they flow through exactly the same
// merge, posing and shading path as real `.glb` files.

const standInMaterials = new Map<string, MeshBasicMaterial>();
function rampMaterial(ramp: RampName): MeshBasicMaterial {
  let m = standInMaterials.get(ramp);
  if (!m) {
    m = new MeshBasicMaterial();
    m.name = `rm_${ramp}`;
    standInMaterials.set(ramp, m);
  }
  return m;
}

function flat(g: BufferGeometry): BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  n.deleteAttribute("normal");
  n.computeVertexNormals();
  return n;
}

function boxG(sx: number, sy: number, sz: number): BufferGeometry {
  return new BoxGeometry(sx, sy, sz);
}

/** Frustum along +y from 0 to h with n faceted sides (the mockup's `mkPrism`). */
function prismG(r0: number, r1: number, h: number, n: number): BufferGeometry {
  const g = new CylinderGeometry(r1, r0, h, n, 1, false);
  g.translate(0, h / 2, 0);
  return flat(g);
}

/** Low-poly ellipsoid centred on the origin (the mockup's `mkEll`); smooth normals unless `smooth` is false. */
function ellG(rx: number, ry: number, rz: number, seg = 10, rings = 7, smooth = true): BufferGeometry {
  const g = new SphereGeometry(1, seg, rings);
  g.scale(rx, ry, rz);
  if (!smooth) return flat(g);
  g.computeVertexNormals();
  return g;
}

/** Jittered faceted rock (the mockup's `mkRock`); jitter is keyed on position so seams stay closed. */
function rockG(rx: number, ry: number, rz: number, seed: number): BufferGeometry {
  const g = new SphereGeometry(1, 7, 5);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const kx = Math.round(x * 1000), ky = Math.round(y * 1000), kz = Math.round(z * 1000);
    const k = 1 + ((hashInt(kx * 7 + kz * 13 + seed * 31, seed) % 100) / 100 - 0.5) * 0.3;
    const ky2 = 1 + ((hashInt(kx + kz * 3, seed + 9 + ky) % 100) / 100 - 0.5) * 0.2;
    p.setXYZ(i, x * rx * k, y * ry * ky2, z * rz * k);
  }
  return flat(g);
}

function hashInt(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

interface PartOpts {
  t?: readonly [number, number, number];
  rx?: number;
  ry?: number;
  rz?: number;
  cast?: boolean;
  line?: boolean;
  name?: string;
}

/** A mesh placed like the mockup's `place()`: scale, then rotate X, Z, Y, then translate. */
function part(parent: Object3D, geo: BufferGeometry, ramp: RampName, partKey: string, o: PartOpts = {}): Mesh {
  const m = new Mesh(geo, rampMaterial(ramp));
  m.rotation.order = "YZX";
  m.rotation.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
  if (o.t) m.position.set(o.t[0], o.t[1], o.t[2]);
  m.userData.part = partKey;
  if (o.cast === false) m.userData.cast = false;
  if (o.line === false) m.userData.line = false;
  if (o.name) {
    m.name = o.name;
    m.userData.name = o.name;
  }
  parent.add(m);
  return m;
}

/** An empty named node (a glTF node with no mesh of its own). */
function node(parent: Object3D, name: string, t: readonly [number, number, number] = [0, 0, 0]): Group {
  const g = new Group();
  g.name = name;
  g.userData.name = name;
  g.position.set(t[0], t[1], t[2]);
  parent.add(g);
  return g;
}

/** Re-expresses `t` (given in the model frame) relative to `parent` (whose rest transform is translation only). */
function rel(parent: Object3D, t: readonly [number, number, number]): [number, number, number] {
  let x = t[0], y = t[1], z = t[2];
  for (let p: Object3D | null = parent; p && p.parent; p = p.parent) {
    x -= p.position.x;
    y -= p.position.y;
    z -= p.position.z;
  }
  return [x, y, z];
}

// --- rakes: local frame has the head beam along x, tines down −y with tips near y = 0, handle back along +z
const RAKE_PROFILES: Record<string, readonly number[]> = (() => {
  const KEEP = 127;
  const prof = (tines: number, tw: number, gap: number, depth: number, ridge: number, berm: number, gapVal?: number) => {
    const p = [berm];
    for (let i = 0; i < tines; i++) {
      for (let k = 0; k < tw; k++) p.push(-depth);
      if (i < tines - 1) for (let k = 0; k < gap; k++) p.push(gapVal ?? ridge);
    }
    p.push(berm);
    return p;
  };
  return {
    sugi: prof(5, 2, 2, 2, 1, 1),
    onami: prof(9, 2, 2, 2, 1, 1),
    kinu: prof(11, 1, 1, 1, 1, 1),
    hisui: [1, -2, -2, 1, -1, 1, -2, -2, 1, -1, 1, -2, -2, 1, -1, 1, -2, -2, 1],
    mikazuki: prof(6, 2, 2, 2, 1, 1),
    tetsu: prof(3, 3, 3, 3, 2, 2),
    wa: prof(2, 2, 6, 2, 0, 1, KEEP),
    take: [1, -2, 1],
    nagi: new Array<number>(16).fill(0),
  };
})();

const RAKE_RAMPS: Record<string, [RampName, RampName]> = {
  sugi: ["wood", "wood_light"],
  onami: ["stone", "stone"],
  kinu: ["wood_light", "leaf"],
  hisui: ["stone", "leaf"],
  mikazuki: ["wood", "wood_light"],
  tetsu: ["stone", "stone"],
  wa: ["wood", "warm"],
  take: ["leaf", "wood_light"],
  nagi: ["wood_light", "wood_light"],
  hoki: ["wood", "leaf"],
};

function standInRake(id: string): Group {
  const root = new Group();
  root.name = `rake_${id}`;
  const [bodyRamp, tineRamp] = RAKE_RAMPS[id] ?? ["wood", "wood"];
  const head = node(root, "Head");
  const handle = node(root, "Handle");
  let tineIx = 0;
  const tine = (geo: BufferGeometry, o: PartOpts, ramp: RampName = tineRamp) =>
    part(root, geo, ramp, "tines", { ...o, name: `tine_${tineIx++}` });
  const HL = 46;
  const hw = 1.7;
  const handleBox = (len: number, w = hw) => part(handle, boxG(w, w, len), bodyRamp, "body", { t: [0, 5.2, len / 2] });
  if (id === "hoki") {
    handleBox(34, 1.5);
    tine(prismG(1.6, 5.6, 13, 7), { rx: -Math.PI / 2, t: [0, 5.2, 0] });
    part(head, boxG(4.4, 4.4, 2), bodyRamp, "body", { t: [0, 5.2, 0.5] });
    return root;
  }
  if (id === "take") {
    part(handle, boxG(1.5, 1.5, HL), bodyRamp, "body", { t: [0, 4.6, HL / 2 + 1.5] });
    part(head, boxG(1.4, 1.4, 1.4), bodyRamp, "body", { t: [0, 5.2, 0.9] });
    tine(boxG(1.3, 5.4, 1.3), { t: [0, 2.7, 1] });
    return root;
  }
  const p = RAKE_PROFILES[id] ?? [];
  const half = p.length / 2;
  if (id === "nagi") {
    handleBox(34);
    tine(boxG(16, 4.6, 1.6), { t: [0, 2.3, 0] });
    part(head, boxG(16, 1.4, 2.4), bodyRamp, "body", { t: [0, 5.2, 0] });
    return root;
  }
  handleBox(HL);
  if (id === "wa") {
    for (const sx of [-1, 1]) {
      part(head, boxG(1.6, 1.6, 9.5), bodyRamp, "body", { t: [sx * 2, 5.2, 4], ry: sx * 0.42 });
      tine(boxG(2, 6, 1.6), { t: [sx * 4, 3, 0] }, bodyRamp);
    }
    part(head, boxG(2.6, 2.6, 1.6), tineRamp, "tines", { t: [0, 5.2, 9] });
    return root;
  }
  const curved = id === "mikazuki";
  part(head, boxG(p.length - 1, 2.6, 2.4), bodyRamp, "body", { t: [0, 5.2, 0] });
  if (curved) {
    for (const sx of [-1, 1]) part(head, boxG(6, 2.6, 2.4), bodyRamp, "body", { t: [sx * (half - 2.5), 5.2, 1.4], ry: -sx * 0.5 });
  }
  for (let j = 0; j < p.length; ) {
    const v = p[j] ?? 0;
    if (v < 0) {
      let k = j;
      while (k < p.length && p[k] === v) k++;
      const w = k - j;
      const cx = (j + k) / 2 - half;
      const hgt = 3.4 - v * 0.5;
      tine(boxG(Math.max(1.1, w * 0.78), hgt, 1.5), { t: [cx, 4 - hgt / 2, curved ? Math.abs(cx) * 0.11 : 0] });
      j = k;
    } else j++;
  }
  return root;
}

// --- props
function standInProp(id: string): Group {
  const root = new Group();
  root.name = id;
  const o = (k: keyof typeof PROP_ORIGINS, x: number, y: number, z: number): [number, number, number] => {
    const b = PROP_ORIGINS[k];
    return [x - b[0], y - b[1], z - b[2]];
  };
  switch (id) {
    case "prop_engawa": {
      const n = node(root, "Engawa");
      part(n, boxG(380, 2, 250), "wood", "deck", { t: [0, -1, 0], cast: false, line: false });
      break;
    }
    case "prop_frame": {
      const n = node(root, "Frame");
      for (const sz of [-1, 1]) part(n, boxG(204, 6, 6), "wood", "frame", { t: [0, 3, sz * 59] });
      for (const sx of [-1, 1]) part(n, boxG(6, 6, 112), "wood", "frame", { t: [sx * 99, 3, 0] });
      for (let x = -80; x <= 80; x += 32) for (const sz of [-1, 1]) part(n, boxG(2.4, 6.8, 6.8), "leaf", "lashing", { t: [x, 3, sz * 59], cast: false });
      for (let z = -32; z <= 32; z += 32) for (const sx of [-1, 1]) part(n, boxG(6.8, 6.8, 2.4), "leaf", "lashing", { t: [sx * 99, 3, z], cast: false });
      break;
    }
    case "prop_rack": {
      const wall = node(root, "Wall");
      part(wall, boxG(300, 68, 4), "wood", "wall", { t: o("rack", 20, 34, WALL_Z - 2), line: false });
      part(root, boxG(306, 4, 9), "wood", "cap", { t: o("rack", 20, 70, WALL_Z - 2) });
      const up = node(root, "UpperRail");
      part(up, boxG(232, 4, 2.4), "wood", "rail", { t: o("rack", 0, HANG_Y - 4.4, WALL_Z + 1.2) });
      const lo = node(root, "LowerRail");
      part(lo, boxG(232, 3, 2), "wood", "rail", { t: o("rack", 0, 16, WALL_Z + 1) });
      const pegs = node(root, "Pegs");
      for (const r of RACK_ORDER) {
        const s = RACK_SLOTS[r];
        const w = Math.max(8, s.w);
        for (const sx of [-1, 1]) part(pegs, boxG(1.6, 1.6, 9), "wood_light", "peg", { t: o("rack", s.x + sx * Math.min(5, w * 0.3), HANG_Y - 2.3, WALL_Z + 4.5), cast: false });
      }
      const shelf = node(root, "Shelf");
      part(shelf, boxG(34, 2, 9), "wood", "shelf", { t: o("rack", 142, 40, WALL_Z + 4.5) });
      break;
    }
    case "prop_bamboo": {
      const n = node(root, "BambooCluster");
      for (const [x, h] of [[-96, 128], [-88, 112], [-20, 122], [64, 132], [72, 114], [158, 124]] as const) {
        const lx = x - PROP_ORIGINS.bamboo[0];
        part(n, prismG(1.5, 1.2, h, 5), "leaf", "bamboo", { t: [lx, 0, 0], line: false, cast: false });
        for (const dy of [0.72, 0.84, 0.95]) {
          part(n, boxG(9, 1.6, 1), "leaf", "bamboo", { t: [lx + (dy > 0.8 ? 4 : -4), h * dy, 0], rz: dy > 0.8 ? 0.5 : -0.5, line: false, cast: false });
        }
      }
      break;
    }
    case "prop_shishi_odoshi": {
      const basin = node(root, "Basin");
      part(basin, prismG(9, 10.5, 6, 7), "stone", "shishi_basin");
      part(basin, prismG(8, 8, 0.4, 7), "water", "shishi_water", { t: [0, 5.8, 0], cast: false, line: false });
      part(root, prismG(1.5, 1.5, 22, 5), "leaf", "shishi_post", { t: [-9, 0, -6] });
      const arm = node(root, "BambooArm", [-3, 15.5, -2]);
      part(arm, boxG(1.9, 1.9, 22), "leaf", "shishi_arm", { ry: 0.95, rx: 0.42 });
      const spout = node(root, "Spout", [-12, 20, -9]);
      part(spout, boxG(1.4, 1.4, 6), "leaf", "shishi_post", { ry: 0.6 });
      break;
    }
    case "prop_basket": {
      const n = node(root, "Basket");
      part(n, prismG(6, 8.4, 8, 8), "wood", "basket");
      for (const [dx, dz, r, s] of [[-2.6, 0.5, 3.4, 2], [2.4, -1, 3.6, 4], [0.4, 2.6, 3, 6]] as const) {
        part(n, rockG(r, r * 0.8, r, s), "stone", "basket", { t: [dx, 9.2, dz] });
      }
      break;
    }
    case "prop_stone_s":
      part(node(root, "Stone"), rockG(4.5, 3.5, 3.4, 11), "stone", "stone", { t: [0, 1.6, 0] });
      break;
    case "prop_stone_m":
      part(node(root, "Stone"), rockG(7.5, 5, 5.6, 5), "stone", "stone", { t: [0, 3.4, 0] });
      break;
    case "prop_stone_l":
      part(node(root, "Stone"), rockG(10.5, 8.5, 8.5, 3), "stone", "stone", { t: [0, 6.5, 0] });
      break;
    case "prop_stone_tall":
      part(node(root, "Stone"), rockG(5.2, 11, 4.4, 8), "stone", "stone", { t: [0, 8.5, 0], rz: 0.08 });
      break;
    case "prop_stone_flat":
      part(node(root, "Stone"), rockG(11.5, 3.2, 5.6, 14), "stone", "stone", { t: [0, 1.6, 0] });
      break;
    case "prop_moss_a":
      part(node(root, "Moss"), ellG(13, 2.2, 9, 9, 4, false), "leaf", "moss", { t: [0, 0.2, 0], line: false });
      break;
    case "prop_moss_b":
      part(node(root, "Moss"), ellG(9, 2.2, 6, 9, 4, false), "leaf", "moss", { t: [0, 0.2, 0], line: false });
      break;
    case "prop_lantern": {
      const l = node(root, "Lantern");
      part(l, prismG(5, 4.4, 2, 6), "stone", "lantern", { t: [0, 1.6, 0] });
      part(l, prismG(1.9, 1.9, 9, 6), "stone", "lantern", { t: [0, 3.6, 0] });
      part(l, prismG(4.6, 5, 1.6, 6), "stone", "lantern", { t: [0, 12.6, 0] });
      part(l, boxG(6, 5.4, 6), "stone", "lantern", { t: [0, 16.9, 0] });
      part(l, prismG(8.4, 1.4, 4.4, 4), "stone", "lantern", { t: [0, 19.6, 0], ry: Math.PI / 4 });
      part(l, boxG(1.8, 2.4, 1.8), "stone", "lantern", { t: [0, 24.6, 0] });
      const w = node(root, "Window");
      part(w, boxG(2.6, 3.4, 6.4), "glow", "window", { t: [0, 16.8, 0], cast: false, line: false });
      part(w, boxG(6.4, 3.4, 2.6), "glow", "window", { t: [0, 16.8, 0], cast: false, line: false });
      break;
    }
    case "prop_bonsai": {
      part(node(root, "Pot"), prismG(4.8, 5.9, 5.6, 6), "water", "pot");
      part(node(root, "Trunk"), boxG(1.8, 9.8, 1.8), "wood", "trunk", { t: [0.8, 9.8, 0], rz: -0.3 });
      const c = node(root, "Canopy");
      part(c, ellG(7, 4.5, 5.6, 6, 4, false), "leaf", "canopy", { t: [4.2, 16.8, 0] });
      part(c, ellG(4.8, 3.4, 4.2, 6, 4, false), "leaf", "canopy", { t: [-3.6, 13.4, 0.6] });
      break;
    }
    case "prop_basin": {
      part(node(root, "Basin"), prismG(8, 9, 5, 8), "stone", "basin");
      part(node(root, "Water"), prismG(6.8, 6.8, 0.3, 8), "water", "water", { t: [0, 5, 0], cast: false, line: false });
      break;
    }
    case "prop_pin":
      part(node(root, "Pin"), prismG(1, 0.8, 3, 6), "warm", "pin");
      break;
    default:
      break;
  }
  return root;
}

// --- Gubba: three concepts built from low-poly lumps, with the node hierarchy of DESIGN.md 5.5.
interface GubbaRig {
  root: Group;
  body: Group;
  head: Group;
}

function gubbaRig(name: string, headPivot: [number, number, number]): GubbaRig {
  const root = new Group();
  root.name = name;
  const rootNode = node(root, "Root");
  const body = node(rootNode, "Body");
  const head = node(body, "Head", headPivot);
  return { root, body, head };
}

/** White ball, ink pupil and a gubba-skinned lid, each on its own node pivoting at the eye centre. */
function gubEye(head: Group, side: "L" | "R", c: [number, number, number], r: number, droop: number, px: number): void {
  const at = rel(head, c);
  part(node(head, `Eye${side}`, at), ellG(r, r, r, 8, 6), "cloth", `eye${side}`);
  part(node(head, `Pupil${side}`, at), ellG(r * 0.5, r * 0.5, r * 0.3, 6, 4), "ink", `pupil${side}`, { t: [px * r, -0.12 * r, r * 0.84], cast: false, line: false });
  part(node(head, `Lid${side}`, at), ellG(r * 1.1, r * 1.04, r * 1.1, 8, 6), "gubba", `lid${side}`, { t: [0, droop * r, -r * 0.02] });
}

function warts(parent: Group, pts: readonly (readonly [number, number, number, number])[], ramp: RampName, key: string): void {
  for (const [x, y, z, r] of pts) part(parent, ellG(r, r, r, 5, 3, false), ramp, key, { t: rel(parent, [x, y, z]), cast: false });
}

function tail(body: Group, lumps: readonly (readonly [number, number, number, number])[], squash: number, zs = 1): void {
  let parent: Group = body;
  lumps.forEach(([x, y, z, r], i) => {
    const n = i < 3 ? node(parent, `Tail${i + 1}`, rel(parent, [x, y, z])) : parent;
    part(n, ellG(r, r * squash, r * zs, 8, 5), "gubba", "tail", { t: i < 3 ? [0, 0, 0] : rel(n, [x, y, z]) });
    parent = n;
  });
}

function gubbaMoss(): Group {
  const hy = 25.5;
  const { root, body, head } = gubbaRig("gubba_moss", [0, hy - 8, 0]);
  const base = root.children[0] as Group;
  part(base, boxG(30, 3, 25), "warm", "cushion", { t: [1, 1.5, 0], ry: 0.22 });
  part(base, ellG(1.2, 1.2, 1.2, 5, 3, false), "glow", "cushion", { t: [-15.5, 1.2, 14.5] });
  tail(body, [[20, 5, -3, 6.2], [25.5, 6.5, -6.5, 4.2], [27.5, 10, -9, 2.9], [26, 13.4, -10.5, 2]], 0.85);
  part(body, ellG(20, 11, 16, 12, 8), "gubba", "body", { t: [0, 9.5, 0] });
  part(body, ellG(17.5, 8, 14, 12, 7), "gubba", "body", { t: [0, 17, 0.5] });
  part(body, ellG(13.2, 9.5, 6), "belly", "belly", { t: [-1, 9, 11.2], cast: false });
  part(body, ellG(13.4, 0.5, 6.2, 12, 4), "gubba", "belly", { t: [-1, 9.6, 11.4], cast: false });
  warts(body, [[-16, 17, 6, 1.3], [17.5, 15, 4, 1.2], [-18.5, 10, 5, 1.1], [15, 21, 2, 1.1], [18, 8, 7, 1.2]], "leaf", "body");
  part(head, ellG(15.5, 10.2, 13, 12, 8), "gubba", "head", { t: rel(head, [0, hy, 1.5]) });
  const mouth = node(head, "Mouth", rel(head, [0, hy, 0]));
  part(mouth, ellG(16.2, 0.6, 12.5, 14, 4), "ink", "grin", { t: [0, -3, 2.5], cast: false, line: false });
  part(mouth, ellG(1.5, 1, 1.3, 6, 4), "blush", "tongue", { t: [8, -3.9, 13.4], cast: false });
  for (const sx of [-1, 1]) part(head, ellG(1.8, 1.1, 0.9, 6, 4), "blush", "head", { t: rel(head, [sx * 12.4, hy - 0.6, 8.6]), cast: false, line: false });
  for (const sx of [-1.5, 1.5]) part(head, ellG(0.6, 0.6, 0.5, 5, 3), "ink", "head", { t: rel(head, [sx, hy + 1.2, 14.3]), cast: false, line: false });
  gubEye(head, "L", [-8.6, hy + 5.2, 9.2], 3.7, 1.2, 0.12);
  gubEye(head, "R", [8.2, hy + 4.6, 9.8], 2.9, 0.72, -0.12);
  warts(head, [[-13, hy + 5, 3, 1.2], [13.5, hy + 4, 2, 1.1], [4, hy + 9.6, 3, 1.2], [-3, hy + 9, -5, 1.1], [11, hy + 7, -3, 1.2]], "leaf", "head");
  const prop = node(head, "Prop_Bonsai", rel(head, [-5.5, hy + 9, 0]));
  part(prop, boxG(1.3, 6, 1.3), "wood", "bonsai", { t: rel(prop, [-5.5, hy + 12, 0]), rz: 0.35 });
  part(prop, ellG(3.6, 2.6, 3.4, 6, 4, false), "leaf", "bonsai_leaf", { t: rel(prop, [-8.6, hy + 15.6, 0.5]) });
  part(prop, ellG(2.6, 2, 2.6, 6, 4, false), "leaf", "bonsai_leaf2", { t: rel(prop, [-3.4, hy + 14.4, -1]) });
  for (const sx of [-1, 1]) {
    const arm = node(body, sx < 0 ? "ArmL" : "ArmR", [sx * 8.6, 15.4, 14.6]);
    part(arm, ellG(2.9, 2.3, 2.9, 7, 5), "gubba", sx < 0 ? "armL" : "armR");
  }
  const cup = node(body, "Cup", [-5.4, 15.2, 16.2]);
  part(cup, prismG(1.5, 1.9, 2.8, 7), "wood", "cup");
  part(cup, prismG(1.7, 1.7, 0.5, 7), "warm", "cup", { t: [0, 2.8, 0] });
  node(cup, "Steam", [0, 4.5, 0]);
  return root;
}

function gubbaKasa(): Group {
  const hy = 26.5;
  const { root, body, head } = gubbaRig("gubba_kasa", [0, hy - 8, 0]);
  const base = root.children[0] as Group;
  part(base, boxG(26, 3, 22), "warm", "cushion", { t: [0, 1.5, 0], ry: -0.18 });
  tail(body, [[-16, 4.6, 8, 5.8], [-21.5, 5.6, 12, 3.8], [-22.5, 9, 14.5, 2.6], [-21, 12, 15.5, 1.8]], 0.85);
  part(body, ellG(16, 12, 14, 12, 8), "gubba", "body", { t: [0, 11.5, 0] });
  part(body, ellG(11, 8.6, 5), "belly", "belly", { t: [0, 9.2, 10.2], cast: false });
  part(body, ellG(16.6, 1.7, 14.6, 14, 4), "water", "sash", { t: [0, 10.4, 0.2] });
  part(body, boxG(3, 3, 2), "water", "sash_knot", { t: [8.5, 10.2, 13.2] });
  part(body, boxG(1.6, 4.5, 1), "water", "sash_knot", { t: [9.2, 6.6, 13.6] });
  warts(body, [[-14, 15, 5, 1.2], [14.5, 14, 4, 1.2], [13, 6, 8, 1.1], [-12, 5, 9, 1]], "gubba", "body");
  part(head, ellG(12.5, 11, 11.5, 12, 8), "gubba", "head", { t: rel(head, [0, hy, 1]) });
  for (const sx of [-1, 1]) part(head, ellG(5.8, 5.2, 5.6, 8, 6), "gubba", "head", { t: rel(head, [sx * 10, hy - 5, 3.6]), line: false });
  const mouth = node(head, "Mouth", rel(head, [0, hy, 0]));
  part(mouth, ellG(16.3, 0.6, 10.4, 14, 4), "ink", "grin", { t: [0, -5.2, 1.9], cast: false, line: false });
  for (const sx of [-1, 1]) part(head, ellG(1.7, 1.1, 0.9, 6, 4), "blush", "head", { t: rel(head, [sx * 13.2, hy - 2.8, 7.6]), cast: false, line: false });
  for (const sx of [-1.4, 1.4]) part(head, ellG(0.6, 0.6, 0.5, 5, 3), "ink", "head", { t: rel(head, [sx, hy - 1.2, 12.3]), cast: false, line: false });
  gubEye(head, "L", [-5.4, hy + 3.4, 9.2], 2.8, 0.7, 0.12);
  gubEye(head, "R", [5.4, hy + 4, 9], 3.5, 1.2, -0.12);
  for (const sx of [-1, 1]) {
    part(head, boxG(5, 0.8, 0.8), "ink", "whisker", { t: rel(head, [sx * 18, hy - 4.6, 6.5]), cast: false, line: false });
    part(head, boxG(0.8, 4, 0.8), "ink", "whisker", { t: rel(head, [sx * 20.4, hy - 2.6, 6.5]), cast: false, line: false });
  }
  part(head, boxG(7.5, 0.9, 0.9), "wood_light", "pipe", { t: rel(head, [11.5, hy - 6.6, 11]), ry: -0.5, rz: -0.35 });
  part(head, prismG(1.2, 1.4, 2, 6), "wood", "pipe", { t: rel(head, [14.4, hy - 8.8, 12.6]) });
  part(head, prismG(0.9, 0.9, 0.4, 6), "blush", "pipe", { t: rel(head, [14.4, hy - 6.8, 12.6]), cast: false });
  warts(head, [[-9, hy + 7, 3, 1.2], [9.5, hy + 7.5, 1, 1.1], [0, hy + 10.6, 2, 1], [-11, hy + 1, 5, 1.1]], "gubba", "head");
  const hat = node(head, "Prop_Hat", rel(head, [-2.4, hy + 10, 0.4]));
  part(hat, prismG(6.2, 0.4, 4.4, 9), "wood_light", "hat", { t: rel(hat, [-2.4, hy + 10.4, 0.4]), rz: 0.2 });
  part(hat, prismG(6.8, 6.8, 0.6, 9), "wood", "hat_brim", { t: rel(hat, [-2.3, hy + 10, 0.4]), rz: 0.2 });
  part(hat, boxG(0.7, 4, 0.7), "warm", "hat_cord", { t: rel(hat, [-8.6, hy + 7.6, 2.5]), rz: 0.25, cast: false });
  for (const sx of [-1, 1]) {
    const arm = node(body, sx < 0 ? "ArmL" : "ArmR", [sx * 5.4, 15.8, 12.6]);
    part(arm, ellG(2.9, 2.3, 2.9, 7, 5), "gubba", sx < 0 ? "armL" : "armR");
  }
  const cup = node(body, "Cup", [0, 16, 14.2]);
  part(cup, prismG(1.5, 1.9, 2.6, 7), "cloth", "cup");
  part(cup, prismG(1.7, 1.7, 0.5, 7), "warm", "cup", { t: [0, 2.6, 0] });
  node(cup, "Steam", [0, 4.3, 0]);
  return root;
}

function gubbaLantern(): Group {
  const hy = 20.5;
  const hx = -9;
  const { root, body, head } = gubbaRig("gubba_lantern", [hx, hy - 8, 0]);
  tail(body, [[19, 5.2, -1, 7.6], [26.5, 5.6, 1, 4.8], [30, 9, 2, 3.3], [29.4, 13, 2.6, 2.4], [27, 15.6, 2.6, 1.7]], 0.78, 0.92);
  part(body, ellG(14.5, 8.6, 11.5, 12, 7), "gubba", "hump", { t: [8, 7.8, -1] });
  part(body, ellG(13.5, 11, 12.2, 12, 8), "gubba", "body", { t: [-9, 10.2, 0] });
  part(body, ellG(12.6, 6.2, 5), "belly", "belly", { t: [-8, 5.8, 9.6], cast: false });
  for (const fx of [4.5, 10.5]) part(body, ellG(0.5, 8.2, 10.6, 3, 8), "gubba", "belly", { t: [fx, 8, 0], cast: false });
  warts(body, [[14, 13.6, 5, 1.2], [20, 9, 6, 1.1], [-20, 12, 5, 1.2], [2, 14.5, 7, 1]], "gubba", "body");
  const sy = 17.6;
  const shell = node(body, "Prop_Shell", [9, sy, -2]);
  ([[9, sy + 3.6, -2, 6.2, 0], [10.2, sy + 4.2, 1.4, 4.2, 1], [11, sy + 4.6, 3.8, 2.6, 2]] as const).forEach(([x, y, z, r, k]) =>
    part(shell, ellG(r, r, r * 0.9, 9, 6), "sand", `shell${k}`, { t: rel(shell, [x, y, z]) }),
  );
  part(shell, ellG(1.3, 1.5, 0.8, 6, 4), "glow", "shell_window", { t: rel(shell, [11.4, sy + 4.7, 6.1]), cast: false });
  part(head, ellG(12.6, 9.6, 11.6, 12, 8), "gubba", "head", { t: rel(head, [hx, hy, 1.5]) });
  const mouth = node(head, "Mouth", rel(head, [hx, hy, 0]));
  part(mouth, ellG(13.3, 0.6, 11, 14, 4), "ink", "grin", { t: [0, -2.6, 2.5], cast: false, line: false });
  part(mouth, ellG(1.5, 1, 1.3, 6, 4), "blush", "tongue", { t: [6.5, -3.5, 12], cast: false });
  for (const sx of [-1, 1]) part(head, ellG(1.7, 1.1, 0.9, 6, 4), "blush", "head", { t: rel(head, [hx + sx * 10.2, hy - 0.4, 7.6]), cast: false, line: false });
  for (const sx of [-1.4, 1.4]) part(head, ellG(0.6, 0.6, 0.5, 5, 3), "ink", "head", { t: rel(head, [hx + sx, hy + 1, 12.9]), cast: false, line: false });
  part(head, prismG(1.5, 1.2, 5.5, 6), "gubba", "head", { t: rel(head, [hx - 5, hy + 8, 4]) });
  part(head, prismG(1.5, 1.2, 8.5, 6), "gubba", "head", { t: rel(head, [hx + 5, hy + 8.4, 4]) });
  gubEye(head, "L", [hx - 5, hy + 15.4, 4.6], 3.1, 1.2, 0.12);
  gubEye(head, "R", [hx + 5, hy + 19, 4.6], 3.7, 0.7, -0.12);
  part(head, ellG(12.4, 1.4, 11.2, 14, 4), "cloth", "headband", { t: rel(head, [hx, hy + 4.4, 1.6]), rz: 0.12 });
  part(head, ellG(1.3, 1.3, 0.6, 6, 4), "warm", "headband", { t: rel(head, [hx - 1, hy + 4.2, 12.3]), cast: false, line: false });
  part(head, boxG(2.4, 2.4, 2), "cloth", "knot", { t: rel(head, [hx + 12.2, hy + 6, 2]) });
  part(head, boxG(1, 5, 1.2), "cloth", "knot", { t: rel(head, [hx + 13.6, hy + 3, 3]), rz: -0.3 });
  part(head, boxG(1, 4.4, 1.2), "cloth", "knot", { t: rel(head, [hx + 12, hy + 3, 0.6]), rz: 0.15 });
  const armL = node(body, "ArmL", [-19.5, 8, 9.6]);
  part(armL, ellG(2.9, 2.3, 2.9, 7, 5), "gubba", "armL");
  const armR = node(body, "ArmR", [-1.5, 7.4, 11.6]);
  part(armR, ellG(2.9, 2.3, 2.9, 7, 5), "gubba", "armR");
  const cup = node(body, "Cup", [-21.5, 7.5, 10.6]);
  part(cup, boxG(0.8, 11, 0.8), "wood", "incense", { t: [0, 5.5, 0], rz: 0.18 });
  part(cup, ellG(0.9, 0.9, 0.9, 5, 3), "blush", "incense", { t: [-1, 11.1, 0], cast: false });
  node(cup, "Steam", [-1, 13, 0]);
  return root;
}

/** A procedural stand-in for spec id `id`, shaped like the mockup's geometry. */
export function standInModel(id: string): Group {
  if (id.startsWith("rake_")) return standInRake(id.slice(5));
  if (id === "gubba_moss") return gubbaMoss();
  if (id === "gubba_kasa") return gubbaKasa();
  if (id === "gubba_lantern") return gubbaLantern();
  return standInProp(id);
}
