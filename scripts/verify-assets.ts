import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface SpecBounds {
  size: [number, number, number];
  tolerance: number;
}

interface ModelSpec {
  id: string;
  file: string;
  maxTriangles: number;
  maxBytes: number;
  requiredNodes: string[];
  nodeCounts: Record<string, number>;
  materials: string[];
  bounds: SpecBounds;
  origin: "tine-tips" | "ground-center";
  allowImages?: boolean;
}

interface ModelsSpecFile {
  version: number;
  budgets: {
    maxTotalTriangles: number;
    maxTotalBytes: number;
  };
  models: ModelSpec[];
}

interface ManifestEntry {
  id: string;
  file: string;
  bytes: number;
  sha256: string;
  triangles: number;
  vertices: number;
  nodes: string[];
  materials: string[];
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
}

interface ManifestFile {
  version: number;
  specSha256: string;
  models: ManifestEntry[];
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}

interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
}

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  matrix?: number[];
}

interface GltfJson {
  asset?: { version?: string };
  buffers?: Array<{ byteLength: number; uri?: string }>;
  bufferViews?: GltfBufferView[];
  accessors?: GltfAccessor[];
  meshes?: GltfMesh[];
  nodes?: GltfNode[];
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
  materials?: Array<{ name?: string }>;
  images?: Array<{ uri?: string; bufferView?: number }>;
}

const ROOT = process.cwd();
const MODELS_DIR = path.join(ROOT, "public", "assets", "models");
const SPEC_PATH = path.join(ROOT, "assets", "models.spec.json");
const RAMPS_PATH = path.join(ROOT, "assets", "ramps.json");
const MANIFEST_PATH = path.join(ROOT, "public", "assets", "manifest.json");

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function componentByteSize(componentType: number): number {
  switch (componentType) {
    case 5120:
    case 5121:
      return 1;
    case 5122:
    case 5123:
      return 2;
    case 5125:
    case 5126:
      return 4;
    default:
      return 0;
  }
}

function typeComponentCount(type: string): number {
  switch (type) {
    case "SCALAR":
      return 1;
    case "VEC2":
      return 2;
    case "VEC3":
      return 3;
    case "VEC4":
    case "MAT2":
      return 4;
    case "MAT3":
      return 9;
    case "MAT4":
      return 16;
    default:
      return 0;
  }
}

type Mat4 = number[];

function mat4Identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function mat4FromTRS(
  t: [number, number, number] = [0, 0, 0],
  q: [number, number, number, number] = [0, 0, 0, 1],
  s: [number, number, number] = [1, 1, 1],
): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}

function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ];
}

export interface ParsedGlb {
  bytes: number;
  sha256: string;
  triangles: number;
  vertices: number;
  nodes: string[];
  materials: string[];
  hasExternalUri: boolean;
  imageCount: number;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
}

export function parseGlb(filePath: string): ParsedGlb {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 20) {
    throw new Error("GLB file shorter than 20 bytes");
  }
  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  const totalLen = buf.readUInt32LE(8);
  if (magic !== 0x46546c67) {
    throw new Error(`Invalid GLB magic: 0x${magic.toString(16)}`);
  }
  if (version !== 2) {
    throw new Error(`Unsupported GLB version: ${version}`);
  }
  if (totalLen !== buf.length) {
    throw new Error(`GLB length mismatch: header=${totalLen}, actual=${buf.length}`);
  }

  let offset = 12;
  let jsonChunk: Buffer | null = null;
  let binChunk: Buffer | null = null;

  while (offset + 8 <= buf.length) {
    const chunkLen = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + chunkLen > buf.length) {
      throw new Error("GLB chunk extends past EOF");
    }
    const slice = buf.subarray(offset, offset + chunkLen);
    if (chunkType === 0x4e4f534a) {
      jsonChunk = slice;
    } else if (chunkType === 0x004e4942) {
      binChunk = slice;
    }
    offset += chunkLen;
  }

  if (!jsonChunk) {
    throw new Error("GLB missing JSON chunk");
  }
  if (!binChunk) {
    throw new Error("GLB missing BIN chunk");
  }

  const gltf = JSON.parse(jsonChunk.toString("utf8")) as GltfJson;
  const buffers = gltf.buffers ?? [];
  const bufferViews = gltf.bufferViews ?? [];
  const accessors = gltf.accessors ?? [];
  const meshes = gltf.meshes ?? [];
  const nodes = gltf.nodes ?? [];
  const materials = gltf.materials ?? [];
  const images = gltf.images ?? [];

  let hasExternalUri = false;
  for (const b of buffers) {
    if (b.uri) hasExternalUri = true;
    if (b.byteLength > binChunk.length) {
      throw new Error(`Buffer byteLength ${b.byteLength} exceeds BIN chunk ${binChunk.length}`);
    }
  }
  for (const img of images) {
    if (img.uri) hasExternalUri = true;
  }

  for (let i = 0; i < bufferViews.length; i++) {
    const bv = bufferViews[i]!;
    const bvOff = bv.byteOffset ?? 0;
    if (bvOff < 0 || bv.byteLength < 0 || bvOff + bv.byteLength > binChunk.length) {
      throw new Error(`bufferView[${i}] out of BIN bounds`);
    }
  }

  for (let i = 0; i < accessors.length; i++) {
    const acc = accessors[i]!;
    if (acc.bufferView === undefined) continue;
    const bv = bufferViews[acc.bufferView];
    if (!bv) {
      throw new Error(`accessor[${i}] references invalid bufferView ${acc.bufferView}`);
    }
    const elemSize = componentByteSize(acc.componentType) * typeComponentCount(acc.type);
    const stride = bv.byteStride ?? elemSize;
    const accOff = acc.byteOffset ?? 0;
    const needed = acc.count > 0 ? accOff + (acc.count - 1) * stride + elemSize : accOff;
    if (needed > bv.byteLength) {
      throw new Error(`accessor[${i}] exceeds bufferView[${acc.bufferView}] length`);
    }
  }

  // Traverse scene graph to compute world transforms & bounds
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  let vertices = 0;

  function visitNode(nodeIdx: number, parentMat: Mat4): void {
    const node = nodes[nodeIdx];
    if (!node) return;
    const local = node.matrix
      ? node.matrix
      : mat4FromTRS(node.translation, node.rotation, node.scale);
    const world = mat4Multiply(parentMat, local);

    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      if (mesh) {
        for (const prim of mesh.primitives) {
          const posIdx = prim.attributes.POSITION;
          if (posIdx === undefined) continue;
          const posAcc = accessors[posIdx];
          if (!posAcc || posAcc.bufferView === undefined) continue;
          vertices += posAcc.count;

          const mode = prim.mode ?? 4; // TRIANGLES
          if (mode === 4) {
            if (prim.indices !== undefined) {
              const idxAcc = accessors[prim.indices];
              if (idxAcc) triangles += Math.floor(idxAcc.count / 3);
            } else {
              triangles += Math.floor(posAcc.count / 3);
            }
          }

          const bv = bufferViews[posAcc.bufferView]!;
          const base = (bv.byteOffset ?? 0) + (posAcc.byteOffset ?? 0);
          const stride = bv.byteStride ?? 12;
          for (let v = 0; v < posAcc.count; v++) {
            const p = base + v * stride;
            const x = binChunk!.readFloatLE(p);
            const y = binChunk!.readFloatLE(p + 4);
            const z = binChunk!.readFloatLE(p + 8);
            const [wx, wy, wz] = transformPoint(world, x, y, z);
            if (wx < min[0]) min[0] = wx;
            if (wy < min[1]) min[1] = wy;
            if (wz < min[2]) min[2] = wz;
            if (wx > max[0]) max[0] = wx;
            if (wy > max[1]) max[1] = wy;
            if (wz > max[2]) max[2] = wz;
          }
        }
      }
    }

    for (const childIdx of node.children ?? []) {
      visitNode(childIdx, world);
    }
  }

  const sceneIdx = gltf.scene ?? 0;
  const rootNodes = gltf.scenes?.[sceneIdx]?.nodes ?? nodes.map((_, i) => i);
  for (const r of rootNodes) {
    visitNode(r, mat4Identity());
  }

  if (!Number.isFinite(min[0])) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  const round3 = (n: number): number => Math.round(n * 1000) / 1000;
  const bounds = {
    min: [round3(min[0]), round3(min[1]), round3(min[2])] as [number, number, number],
    max: [round3(max[0]), round3(max[1]), round3(max[2])] as [number, number, number],
    size: [
      round3(max[0] - min[0]),
      round3(max[1] - min[1]),
      round3(max[2] - min[2]),
    ] as [number, number, number],
  };

  return {
    bytes: buf.length,
    sha256: sha256(buf),
    triangles,
    vertices,
    nodes: nodes.map((n) => n.name ?? "").filter(Boolean),
    materials: materials.map((m) => m.name ?? "").filter(Boolean),
    hasExternalUri,
    imageCount: images.length,
    bounds,
  };
}

function walkGlbFiles(dir: string, base: string, acc: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkGlbFiles(full, rel, acc);
    } else if (entry.name.endsWith(".glb")) {
      acc.push(rel);
    }
  }
}

function main(): void {
  const errors: string[] = [];

  if (!fs.existsSync(SPEC_PATH)) {
    console.error("Missing assets/models.spec.json");
    process.exit(1);
  }
  if (!fs.existsSync(RAMPS_PATH)) {
    console.error("Missing assets/ramps.json");
    process.exit(1);
  }
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error("Missing public/assets/manifest.json");
    process.exit(1);
  }

  const specBuf = fs.readFileSync(SPEC_PATH);
  const specSha = sha256(specBuf);
  const spec = JSON.parse(specBuf.toString("utf8")) as ModelsSpecFile;
  const rampsJson = JSON.parse(fs.readFileSync(RAMPS_PATH, "utf8")) as {
    ramps: Record<string, unknown>;
  };
  const knownMaterials = new Set(Object.keys(rampsJson.ramps).map((k) => `rm_${k}`));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as ManifestFile;

  if (manifest.specSha256 !== specSha) {
    errors.push(
      `manifest.specSha256 mismatch: manifest=${manifest.specSha256}, spec=${specSha}`,
    );
  }

  const manifestById = new Map<string, ManifestEntry>();
  for (const m of manifest.models) {
    manifestById.set(m.id, m);
  }

  const expectedFiles = new Set(spec.models.map((m) => m.file));
  const actualFiles: string[] = [];
  walkGlbFiles(MODELS_DIR, "", actualFiles);

  for (const f of actualFiles) {
    if (!expectedFiles.has(f)) {
      errors.push(`Unlisted model file in public/assets/models/: ${f}`);
    }
  }

  let totalTriangles = 0;
  let totalBytes = 0;

  for (const modelSpec of spec.models) {
    const filePath = path.join(MODELS_DIR, modelSpec.file);
    const man = manifestById.get(modelSpec.id);
    if (!man) {
      errors.push(`${modelSpec.id}: missing from public/assets/manifest.json`);
    }
    if (!fs.existsSync(filePath)) {
      errors.push(`${modelSpec.id}: missing file public/assets/models/${modelSpec.file}`);
      continue;
    }

    let parsed: ParsedGlb;
    try {
      parsed = parseGlb(filePath);
    } catch (err) {
      errors.push(
        `${modelSpec.id} (${modelSpec.file}): invalid GLB — ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    totalTriangles += parsed.triangles;
    totalBytes += parsed.bytes;

    if (parsed.hasExternalUri) {
      errors.push(`${modelSpec.id}: contains external URI`);
    }
    if (parsed.imageCount > 0 && !modelSpec.allowImages) {
      errors.push(`${modelSpec.id}: contains ${parsed.imageCount} images not allowed by spec`);
    }
    if (parsed.triangles === 0) {
      errors.push(`${modelSpec.id}: has 0 triangles`);
    }
    if (parsed.triangles > modelSpec.maxTriangles) {
      errors.push(
        `${modelSpec.id}: triangles ${parsed.triangles} > maxTriangles ${modelSpec.maxTriangles}`,
      );
    }
    if (parsed.bytes > modelSpec.maxBytes) {
      errors.push(`${modelSpec.id}: bytes ${parsed.bytes} > maxBytes ${modelSpec.maxBytes}`);
    }

    const nodeSet = new Set(parsed.nodes);
    for (const req of modelSpec.requiredNodes) {
      if (!nodeSet.has(req)) {
        errors.push(`${modelSpec.id}: missing required node "${req}"`);
      }
    }

    for (const [prefix, expectedCount] of Object.entries(modelSpec.nodeCounts)) {
      const actualCount = parsed.nodes.filter((n) => n.startsWith(prefix)).length;
      if (actualCount !== expectedCount) {
        errors.push(
          `${modelSpec.id}: node prefix "${prefix}" count=${actualCount}, expected=${expectedCount}`,
        );
      }
    }

    const allowedMats = new Set(modelSpec.materials);
    for (const mat of parsed.materials) {
      if (!knownMaterials.has(mat)) {
        errors.push(`${modelSpec.id}: unknown ramp material "${mat}"`);
      }
      if (!allowedMats.has(mat)) {
        errors.push(`${modelSpec.id}: material "${mat}" not listed in spec`);
      }
    }

    const tol = modelSpec.bounds.tolerance;
    for (let axis = 0; axis < 3; axis++) {
      const actual = parsed.bounds.size[axis]!;
      const expected = modelSpec.bounds.size[axis]!;
      if (Math.abs(actual - expected) > tol) {
        errors.push(
          `${modelSpec.id}: bounds axis ${axis} size=${actual}, expected=${expected} ± ${tol}`,
        );
      }
    }

    // Origin check
    if (modelSpec.origin === "ground-center" || modelSpec.origin === "tine-tips") {
      if (Math.abs(parsed.bounds.min[1]) > tol) {
        errors.push(
          `${modelSpec.id}: origin rule "${modelSpec.origin}" violated (minY=${parsed.bounds.min[1]}, expected ~0 ± ${tol})`,
        );
      }
    }

    if (man) {
      if (man.sha256 !== parsed.sha256) {
        errors.push(`${modelSpec.id}: sha256 mismatch vs manifest`);
      }
      if (man.bytes !== parsed.bytes || man.triangles !== parsed.triangles) {
        errors.push(`${modelSpec.id}: manifest metrics mismatch vs GLB`);
      }
    }
  }

  if (totalTriangles > spec.budgets.maxTotalTriangles) {
    errors.push(
      `Total triangles ${totalTriangles} > budget ${spec.budgets.maxTotalTriangles}`,
    );
  }
  if (totalBytes > spec.budgets.maxTotalBytes) {
    errors.push(`Total bytes ${totalBytes} > budget ${spec.budgets.maxTotalBytes}`);
  }

  if (errors.length > 0) {
    console.error(`verify:assets FAILED (${errors.length} error(s)):`);
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  console.log(
    `verify:assets PASS — ${spec.models.length} models, ${totalTriangles} triangles (budget ${spec.budgets.maxTotalTriangles}), ${(totalBytes / 1024).toFixed(1)} KB (budget ${(spec.budgets.maxTotalBytes / 1024).toFixed(1)} KB)`,
  );
}

// Run only when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
