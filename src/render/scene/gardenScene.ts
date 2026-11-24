// The garden as Three.js objects (DESIGN.md 2.3, 3.3, 4.2, 4.3, 5.5). Every model is merged into one geometry
// per role and drawn with the shared G-buffer shader, so the scene pass is six draw calls:
//   static props (deck, frame, rack, bamboo, basket, shelf bonsai, shishi-odoshi with its tipping arm),
//   the ten rakes (on the rack, travelling, or in the hand), the active Gubba, placed elements, sand, particles.
// Moving parts are posed through per-node matrices (`uNodes`) instead of separate meshes.

import {
  Euler,
  GLSL3,
  Matrix4,
  Mesh,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector3,
} from "three";
import type { BufferGeometry, IUniform, Object3D, WebGLRenderer } from "three";
import type {
  ElementInstance,
  ElementKind,
  GubbaNodeName,
  GubbaVariant,
  MoodId,
  NodeTransform,
  PickResult,
  RakeId,
  Vec2,
  Vec3,
} from "../../state/types.ts";
import type { SandGrid, SandRect } from "../../sand/types.ts";
import { MAX_NODES, MODEL_DEPTH_FRAGMENT, MODEL_FRAGMENT, MODEL_VERTEX, VFLAG_FLOOR, VFLAG_NO_CAST, VFLAG_NO_OUTLINE, VFLAG_WALL } from "../pipeline/shaders.ts";
import { smoothstep01 } from "../pipeline/tone.ts";
import {
  GUBBA_YAW,
  GeometryBuilder,
  HANG_Y,
  HANG_Z,
  PROP_ORIGINS,
  RACK_ORDER,
  RACK_SLOTS,
  collectMeshes,
  modelBounds,
  nodeName,
} from "./assets.ts";
import type { LoadedModels, MeshInfo } from "./assets.ts";
import { Particles } from "./particles.ts";
import { SandMesh } from "./sandMesh.ts";

export const MAX_ELEMENTS = 12;
const GHOST_SLOT = MAX_ELEMENTS;
const RAKE_TRAVEL_MS = 350;
const RAKE_BOUNCE_MS = 200;
const SHISHI_PERIOD_MS = 9000;

/** Everything the scene needs from the rest of the game for one frame. */
export interface GardenFrame {
  /** Monotonic injected clock (frozen in tests). */
  timeMs: number;
  dtMs: number;
  mood: MoodId;
  gubbaVariant: GubbaVariant;
  reducedMotion: boolean;
  /** Ambient particles (off in test mode). */
  particles: boolean;
  sand: SandGrid | null;
  /** Cells changed since the last frame, or null. */
  sandDirty: SandRect | null;
  /** Re-upload the whole grid (load, preset, undo of a sweep). */
  sandReset: boolean;
  elements: readonly ElementInstance[];
  /** The rake in the hand. `hoki` is an action, so it never leaves the rack. */
  heldRake: RakeId;
  hoverRake: RakeId | null;
  /** Head point in grid coordinates; the held rake stays where it was last seen when null. */
  rakeHead: Vec2 | null;
  rakeHeading: number;
  raking: boolean;
  /** Pose deltas from `gubba.pose()`, applied on top of each node's rest transform (see `applyPose`). */
  gubbaPose: Partial<Record<GubbaNodeName | string, NodeTransform>> | null;
  breathAmplitude: number;
  breathGuide: boolean;
  /** Eased sweep progress 0…1 while the Hōki sweep runs, else null. */
  sweepProgress: number | null;
  rain: boolean;
  /** The element being placed from the basket, following the pointer (grid coordinates). */
  placing: { kind: ElementKind; x: number; y: number; rotation: number } | null;
}

type PickInfo =
  | { kind: "none" }
  | { kind: "gubba" }
  | { kind: "basket" }
  | { kind: "rake"; id: RakeId }
  | { kind: "element"; slot: number };

/** Assigns part ids 1…255 to part keys; id 0 is the ground (never outlines, never picks). */
class PartRegistry {
  private readonly ids = new Map<string, number>();
  readonly info: PickInfo[] = [{ kind: "none" }];

  id(key: string, pick: PickInfo): number {
    const have = this.ids.get(key);
    if (have !== undefined) return have;
    const id = Math.min(255, this.info.length);
    if (id < 255) this.info.push(pick);
    this.ids.set(key, id);
    return id;
  }
}

/** One merged model: one mesh, one G-buffer material, one depth material, up to MAX_NODES node matrices. */
class RigidModel {
  readonly mesh: Mesh;
  readonly gMat: ShaderMaterial;
  readonly dMat: ShaderMaterial;
  readonly nodes: Matrix4[];

  constructor(geometry: BufferGeometry, shared: Record<string, IUniform>) {
    this.nodes = Array.from({ length: MAX_NODES }, () => new Matrix4());
    const uNodes = { value: this.nodes };
    this.gMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: MODEL_VERTEX,
      fragmentShader: MODEL_FRAGMENT,
      uniforms: { ...shared, uNodes },
    });
    this.dMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: MODEL_VERTEX,
      fragmentShader: MODEL_DEPTH_FRAGMENT,
      uniforms: { uNodes },
    });
    this.mesh = new Mesh(geometry, this.gMat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  setGeometry(g: BufferGeometry): void {
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  depthMode(on: boolean): void {
    this.mesh.material = on ? this.dMat : this.gMat;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.gMat.dispose();
    this.dMat.dispose();
  }
}

/** A posable node: its object in the loaded hierarchy, its rest transform, and its slot in `uNodes`. */
interface PoseNode {
  obj: Object3D;
  name: string;
  slot: number;
  restPos: Vector3;
  restQuat: Quaternion;
  restScale: Vector3;
}

const GUBBA_POSABLE = /^(Root|Body|Head|Eye[LR]|Pupil[LR]|Lid[LR]|Mouth|Arm[LR]|Cup|Tail\d+|Prop_\w+)$/;

interface GubbaModel {
  variant: GubbaVariant;
  root: Object3D;
  model: RigidModel;
  nodes: PoseNode[];
  byName: Map<string, PoseNode>;
  steam: Object3D | null;
  steamOffset: Vector3;
}

interface RakeAnim {
  id: RakeId;
  index: number;
  lift: number;
  inHand: boolean;
  t0: number;
  fromPos: Vector3;
  fromQuat: Quaternion;
  pos: Vector3;
  quat: Quaternion;
  travelling: boolean;
}

const _e = new Euler(0, 0, 0, "YZX");
const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _v2 = new Vector3();
const _m = new Matrix4();
const _one = new Vector3(1, 1, 1);

function placement(x: number, y: number, z: number, ry = 0, s = 1): Matrix4 {
  _e.set(0, ry, 0, "YZX");
  return new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(_e), new Vector3(s, s, s));
}

function isWallMesh(m: MeshInfo): boolean {
  for (let p: Object3D | null = m.mesh; p; p = p.parent) if (nodeName(p) === "Wall") return m.ramp === 2; // wood planks, not the cap
  return false;
}

export class GardenScene {
  readonly scene = new Scene();
  readonly sand: SandMesh;
  readonly particles: Particles;
  private readonly parts = new PartRegistry();
  private readonly shared: Record<string, IUniform>;
  private readonly models: LoadedModels;

  private readonly staticModel: RigidModel;
  private shishiArm: PoseNode | null = null;
  private readonly shishiPlace: Matrix4;

  private readonly rakeModel: RigidModel;
  private readonly rakes: RakeAnim[] = [];
  private heldRake: RakeId | null = null;
  private readonly headGrid = { x: 96, y: 86 };

  private readonly gubbas: GubbaModel[] = [];
  private readonly gubbaPlace: Matrix4;
  private readonly steamWorld = { x: 0, y: 0, z: 0 };
  private steamValid = false;

  private readonly elementModel: RigidModel;
  private elementKinds: (ElementKind | null)[] = [];
  private elements: readonly ElementInstance[] = [];
  private readonly elementGeoCache = new Map<ElementKind, MeshInfo[]>();

  constructor(models: LoadedModels, shared: Record<string, IUniform>) {
    this.models = models;
    this.shared = shared;
    this.sand = new SandMesh(shared);
    this.particles = new Particles();
    this.shishiPlace = placement(...PROP_ORIGINS.shishi);
    this.gubbaPlace = placement(PROP_ORIGINS.gubba[0], PROP_ORIGINS.gubba[1], PROP_ORIGINS.gubba[2], GUBBA_YAW);

    this.staticModel = new RigidModel(this.buildStatic(), shared);
    this.rakeModel = new RigidModel(this.buildRakes(), shared);
    for (const v of ["moss", "kasa", "lantern"] as const) this.gubbas.push(this.buildGubba(v));
    this.elementModel = new RigidModel(new GeometryBuilder().build(), shared);

    this.scene.add(this.staticModel.mesh, this.rakeModel.mesh, this.elementModel.mesh, this.sand.mesh, this.particles.points);
    for (const g of this.gubbas) {
      g.model.mesh.matrix.copy(this.gubbaPlace);
      g.model.mesh.matrixWorldNeedsUpdate = true;
      this.scene.add(g.model.mesh);
    }
    this.scene.matrixAutoUpdate = false;
  }

  private root(id: string): Object3D | null {
    return this.models.roots.get(id) ?? null;
  }

  // ------------------------------------------------------------------------------------------------ static
  private buildStatic(): BufferGeometry {
    const b = new GeometryBuilder();
    const add = (id: string, place: Matrix4, opts: { pick?: PickInfo; flags?: number; forcePart0?: boolean } = {}) => {
      const root = this.root(id);
      if (!root) return;
      for (const m of collectMeshes(root)) {
        if (id === "prop_shishi_odoshi" && this.shishiArm && isUnder(m.mesh, this.shishiArm.obj)) {
          _m.copy(this.shishiArm.obj.matrixWorld).invert().multiply(m.mesh.matrixWorld);
          b.addMeshInfo(m, _m, this.parts.id(`${id}:${m.partKey}`, { kind: "none" }), 0, 1);
          continue;
        }
        let flags = opts.flags ?? 0;
        let part: number;
        if (id === "prop_engawa") flags |= VFLAG_FLOOR | VFLAG_NO_OUTLINE;
        if (id === "prop_rack" && isWallMesh(m)) flags |= VFLAG_WALL | VFLAG_NO_OUTLINE;
        if ((flags & (VFLAG_FLOOR | VFLAG_WALL)) !== 0 || opts.forcePart0) part = 0;
        else part = this.parts.id(`${id}:${m.partKey}`, opts.pick ?? { kind: "none" });
        _m.multiplyMatrices(place, m.mesh.matrixWorld);
        b.addMeshInfo(m, _m, part, flags, 0);
      }
    };
    const engawa = this.root("prop_engawa");
    const engawaTop = engawa ? modelBounds(engawa)[1].y : 0;
    add("prop_engawa", placement(25, -engawaTop, 10));
    add("prop_frame", placement(...PROP_ORIGINS.frame));
    add("prop_rack", placement(...PROP_ORIGINS.rack));
    add("prop_bamboo", placement(...PROP_ORIGINS.bamboo), { flags: VFLAG_NO_CAST | VFLAG_NO_OUTLINE, forcePart0: true });
    add("prop_basket", placement(...PROP_ORIGINS.basket), { pick: { kind: "basket" } });
    add("prop_bonsai", placement(PROP_ORIGINS.shelfBonsai[0], PROP_ORIGINS.shelfBonsai[1], PROP_ORIGINS.shelfBonsai[2], 0, 0.55));
    const shishi = this.root("prop_shishi_odoshi");
    if (shishi) {
      shishi.updateMatrixWorld(true);
      shishi.traverse((o) => {
        if (!this.shishiArm && nodeName(o) === "BambooArm") {
          this.shishiArm = { obj: o, name: "BambooArm", slot: 1, restPos: o.position.clone(), restQuat: o.quaternion.clone(), restScale: o.scale.clone() };
        }
      });
    }
    add("prop_shishi_odoshi", this.shishiPlace);
    return b.build();
  }

  // ------------------------------------------------------------------------------------------------ rakes
  private buildRakes(): BufferGeometry {
    const b = new GeometryBuilder();
    RACK_ORDER.forEach((id, index) => {
      const root = this.root(`rake_${id}`);
      if (root) {
        for (const m of collectMeshes(root)) {
          const tine = /^tine_/.test(nodeName(m.mesh)) || m.partKey === "tines";
          const part = this.parts.id(`rake_${id}:${tine ? "tines" : "body"}`, { kind: "rake", id });
          b.addMeshInfo(m, m.mesh.matrixWorld, part, 0, index);
        }
      }
      const anim: RakeAnim = {
        id,
        index,
        lift: 0,
        inHand: false,
        t0: -1e9,
        fromPos: new Vector3(),
        fromQuat: new Quaternion(),
        pos: new Vector3(),
        quat: new Quaternion(),
        travelling: false,
      };
      this.rackPose(anim, anim.pos, anim.quat);
      this.rakes.push(anim);
    });
    return b.build();
  }

  /** Head-up on two pegs, handle hanging, tines toward the room: the in-use pose turned π/2 about x and π about y. */
  private rackPose(a: RakeAnim, pos: Vector3, quat: Quaternion): void {
    const slot = RACK_SLOTS[a.id];
    pos.set(slot.x, HANG_Y + a.lift * 1.92, HANG_Z + a.lift * 2.4);
    quat.setFromEuler(_e.set(Math.PI / 2, Math.PI, 0, "YZX"));
  }

  /** Tips at the head point; pitched back 0.62 rad along the pull while raking, floating 3.2 up at 0.5 rad otherwise. */
  private handPose(f: GardenFrame, pos: Vector3, quat: Quaternion): void {
    const h = f.rakeHeading;
    pos.set(this.headGrid.x - 96, 3 + (f.raking ? 0 : 3.2), this.headGrid.y - 56);
    quat.setFromEuler(_e.set(-(f.raking ? 0.62 : 0.5), Math.atan2(-Math.cos(h), -Math.sin(h)), 0, "YZX"));
  }

  private updateRakes(f: GardenFrame): void {
    if (f.rakeHead) {
      this.headGrid.x = f.rakeHead.x;
      this.headGrid.y = f.rakeHead.y;
    }
    const held = f.heldRake === "hoki" ? null : f.heldRake;
    if (held !== this.heldRake) {
      for (const a of this.rakes) {
        const want = a.id === held;
        if (want !== a.inHand) {
          a.inHand = want;
          a.t0 = f.timeMs;
          a.fromPos.copy(a.pos);
          a.fromQuat.copy(a.quat);
          a.travelling = !f.reducedMotion;
        }
      }
      this.heldRake = held;
    }
    const k = f.reducedMotion ? 1 : 1 - Math.pow(0.72, Math.max(0, f.dtMs) / (1000 / 60));
    for (const a of this.rakes) {
      const hoverTarget = !a.inHand && f.hoverRake === a.id ? 1 : 0;
      a.lift += (hoverTarget - a.lift) * k;
      if (Math.abs(a.lift - hoverTarget) < 1e-3) a.lift = hoverTarget;
      if (a.inHand) this.handPose(f, _v, _q);
      else this.rackPose(a, _v, _q);
      const el = f.timeMs - a.t0;
      if (a.travelling && el < RAKE_TRAVEL_MS) {
        const e = smoothstep01(el / RAKE_TRAVEL_MS);
        a.pos.lerpVectors(a.fromPos, _v, e);
        a.pos.y += Math.sin(Math.PI * e) * 14; // an eased arc
        a.quat.slerpQuaternions(a.fromQuat, _q, e);
      } else {
        a.pos.copy(_v);
        a.quat.copy(_q);
        if (a.travelling && !a.inHand && el < RAKE_TRAVEL_MS + RAKE_BOUNCE_MS) {
          const v = (el - RAKE_TRAVEL_MS) / RAKE_BOUNCE_MS;
          a.pos.y += 0.9 * Math.sin(Math.PI * v) * (1 - v); // settles on its pegs with a small bounce
        } else if (el >= RAKE_TRAVEL_MS + RAKE_BOUNCE_MS) a.travelling = false;
      }
      this.rakeModel.nodes[a.index]?.compose(a.pos, a.quat, _one);
    }
  }

  // ------------------------------------------------------------------------------------------------ Gubba
  private buildGubba(variant: GubbaVariant): GubbaModel {
    const root = this.root(`gubba_${variant}`);
    const nodes: PoseNode[] = [];
    const byName = new Map<string, PoseNode>();
    let steam: Object3D | null = null;
    let cup: Object3D | null = null;
    const b = new GeometryBuilder();
    if (root) {
      root.updateMatrixWorld(true);
      // slot 0 is the model root (identity); posable nodes take slots 1…31 in traversal order
      root.traverse((o) => {
        const name = nodeName(o);
        if (name === "Steam" && !steam) steam = o;
        if (name === "Cup" && !cup) cup = o;
        if (!GUBBA_POSABLE.test(name) || byName.has(name) || nodes.length >= MAX_NODES - 1) return;
        const n: PoseNode = { obj: o, name, slot: nodes.length + 1, restPos: o.position.clone(), restQuat: o.quaternion.clone(), restScale: o.scale.clone() };
        nodes.push(n);
        byName.set(name, n);
      });
      for (const m of collectMeshes(root)) {
        let owner: PoseNode | null = null;
        for (let p: Object3D | null = m.mesh; p && !owner; p = p.parent) owner = byName.get(nodeName(p)) ?? null;
        const slot = owner ? owner.slot : 0;
        if (owner) _m.copy(owner.obj.matrixWorld).invert().multiply(m.mesh.matrixWorld);
        else _m.copy(m.mesh.matrixWorld);
        b.addMeshInfo(m, _m, this.parts.id(`gubba:${m.partKey}`, { kind: "gubba" }), 0, slot);
      }
    }
    const model = new RigidModel(b.build(), this.shared);
    for (const n of nodes) model.nodes[n.slot]?.copy(n.obj.matrixWorld);
    const anchor: Object3D | null = steam ?? cup;
    return { variant, root: root ?? new Scene(), model, nodes, byName, steam: anchor, steamOffset: new Vector3(0, steam ? 0 : 4.5, 0) };
  }

  /**
   * Applies `pose` on top of each node's rest transform: `pos` is added (parent space), `rot` (Euler XYZ,
   * radians) is applied after the rest rotation, `scale` multiplies the rest scale. Nodes without an entry rest.
   */
  private applyPose(g: GubbaModel, pose: GardenFrame["gubbaPose"]): void {
    for (const n of g.nodes) {
      const t = pose ? pose[n.name] : undefined;
      n.obj.position.copy(n.restPos);
      n.obj.quaternion.copy(n.restQuat);
      n.obj.scale.copy(n.restScale);
      if (t) {
        n.obj.position.x += t.pos.x;
        n.obj.position.y += t.pos.y;
        n.obj.position.z += t.pos.z;
        _q2.setFromEuler(_e.set(t.rot.x, t.rot.y, t.rot.z, "XYZ"));
        n.obj.quaternion.multiply(_q2);
        n.obj.scale.x *= t.scale.x;
        n.obj.scale.y *= t.scale.y;
        n.obj.scale.z *= t.scale.z;
      }
    }
    g.root.updateMatrixWorld(true);
    for (const n of g.nodes) g.model.nodes[n.slot]?.copy(n.obj.matrixWorld);
    if (g.steam) {
      _v2.copy(g.steamOffset).applyMatrix4(g.steam.matrixWorld).applyMatrix4(this.gubbaPlace);
      this.steamWorld.x = _v2.x;
      this.steamWorld.y = _v2.y;
      this.steamWorld.z = _v2.z;
      this.steamValid = true;
    } else this.steamValid = false;
  }

  // ------------------------------------------------------------------------------------------------ elements
  private meshesFor(kind: ElementKind): MeshInfo[] {
    let list = this.elementGeoCache.get(kind);
    if (!list) {
      const root = this.root(`prop_${kind}`);
      list = root ? collectMeshes(root) : [];
      this.elementGeoCache.set(kind, list);
    }
    return list;
  }

  private updateElements(f: GardenFrame): void {
    this.elements = f.elements;
    const count = Math.min(MAX_ELEMENTS, f.elements.length);
    let changed = this.elementKinds.length !== MAX_ELEMENTS + 1;
    if (!changed) {
      for (let i = 0; i < MAX_ELEMENTS; i++) if (this.elementKinds[i] !== (i < count ? f.elements[i]?.kind ?? null : null)) changed = true;
      if (this.elementKinds[GHOST_SLOT] !== (f.placing ? f.placing.kind : null)) changed = true;
    }
    if (changed) {
      this.elementKinds = [];
      const b = new GeometryBuilder();
      for (let i = 0; i <= MAX_ELEMENTS; i++) {
        const kind = i === GHOST_SLOT ? f.placing?.kind ?? null : i < count ? f.elements[i]?.kind ?? null : null;
        this.elementKinds.push(kind);
        if (!kind) continue;
        for (const m of this.meshesFor(kind)) {
          const part = i === GHOST_SLOT ? this.parts.id(`ghost:${m.partKey}`, { kind: "none" }) : this.parts.id(`el${i}:${m.partKey}`, { kind: "element", slot: i });
          b.addMeshInfo(m, m.mesh.matrixWorld, part, 0, i);
        }
      }
      this.elementModel.setGeometry(b.build());
    }
    for (let i = 0; i <= MAX_ELEMENTS; i++) {
      const e = i === GHOST_SLOT ? f.placing : i < count ? f.elements[i] : null;
      const node = this.elementModel.nodes[i];
      if (!node) continue;
      if (!e) {
        node.makeScale(0, 0, 0);
        continue;
      }
      _q.setFromEuler(_e.set(0, e.rotation, 0, "YZX"));
      _v.set(e.x - 96, 3, e.y - 56);
      node.compose(_v, _q, _one);
    }
  }

  // ------------------------------------------------------------------------------------------------ frame
  /** Updates every moving part for this frame. `sandE` is the gradient spacing the pipeline derives from the camera. */
  update(f: GardenFrame, renderer: WebGLRenderer, sandE: number): void {
    // sand
    if (f.sandReset) this.sand.markAll();
    else if (f.sand && f.sandDirty) this.sand.markDirty(f.sand, f.sandDirty);
    this.sand.upload(renderer, f.sand);
    const lit = f.mood === "dusk" || f.mood === "moonlit";
    let glows = 0;
    if (lit) {
      for (const e of f.elements) {
        if (e.kind !== "lantern" || glows >= 4) continue;
        this.sand.glow[glows++]?.set(e.x, e.y, 0, 0);
      }
    }
    const sweepE = f.sweepProgress === null ? -1 : Math.max(0, Math.min(1, f.sweepProgress));
    this.sand.setFrame(sandE, f.reducedMotion && sweepE >= 0 ? -1 : sweepE, f.breathGuide ? Math.max(0, Math.min(1, f.breathAmplitude)) * 608 : 0, glows);
    (this.shared.uGlowLit as IUniform<number>).value = lit ? 1 : 0;
    (this.shared.uRippleFrame as IUniform<number>).value = f.reducedMotion ? 0 : Math.floor(f.timeMs / 250) % 4;

    // shishi-odoshi: fills slowly, tips, empties, swings back
    if (this.shishiArm) {
      const a = this.shishiArm;
      const u = f.reducedMotion ? 0 : (f.timeMs % SHISHI_PERIOD_MS) / SHISHI_PERIOD_MS;
      let ang: number;
      if (u < 0.84) ang = 0.12 * (u / 0.84);
      else if (u < 0.88) ang = 0.12 + 0.5 * smoothstep01((u - 0.84) / 0.04);
      else if (u < 0.96) ang = 0.62 * (1 - smoothstep01((u - 0.88) / 0.08));
      else ang = 0;
      a.obj.position.copy(a.restPos);
      a.obj.quaternion.copy(a.restQuat).multiply(_q2.setFromEuler(_e.set(0, 0, -ang, "XYZ")));
      a.obj.updateMatrixWorld(true);
      this.staticModel.nodes[1]?.multiplyMatrices(this.shishiPlace, a.obj.matrixWorld);
    }

    this.updateRakes(f);

    for (const g of this.gubbas) {
      const on = g.variant === f.gubbaVariant;
      g.model.mesh.visible = on;
      if (on) this.applyPose(g, f.gubbaPose);
    }

    this.updateElements(f);

    this.particles.update({
      timeMs: f.timeMs,
      mood: f.mood,
      rain: f.rain,
      enabled: f.particles && !f.reducedMotion,
      steam: this.steamValid ? this.steamWorld : null,
      sand: f.sand,
    });
  }

  /** Swaps every model to its depth-only material (and hides non-casters) for the shadow pass. */
  shadowMode(on: boolean): void {
    this.staticModel.depthMode(on);
    this.rakeModel.depthMode(on);
    this.elementModel.depthMode(on);
    for (const g of this.gubbas) g.model.depthMode(on);
    this.sand.mesh.visible = !on;
    this.particles.points.visible = !on;
  }

  /** Maps a G-buffer part id to what the pointer is over. The rake in the hand does not pick. */
  pickResult(part: number): PickResult {
    const info = this.parts.info[part];
    if (!info) return { kind: "none" };
    switch (info.kind) {
      case "rake":
        return info.id === this.heldRake ? { kind: "none" } : { kind: "rake", id: info.id };
      case "gubba":
        return { kind: "gubba" };
      case "basket":
        return { kind: "basket" };
      case "element": {
        const e = this.elements[info.slot];
        return e ? { kind: "element", id: e.id } : { kind: "none" };
      }
      default:
        return { kind: "none" };
    }
  }

  /** World position of Gubba's steam (tea, pipe or incense), if the active model has one. */
  steamPoint(): Vec3 | null {
    return this.steamValid ? this.steamWorld : null;
  }

  dispose(): void {
    this.staticModel.dispose();
    this.rakeModel.dispose();
    this.elementModel.dispose();
    for (const g of this.gubbas) g.model.dispose();
    this.sand.dispose();
    this.particles.dispose();
  }
}

function isUnder(o: Object3D, ancestor: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) if (p === ancestor) return true;
  return false;
}
