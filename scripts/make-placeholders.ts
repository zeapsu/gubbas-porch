import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseGlb } from "./verify-assets.ts";

interface ModelSpec {
  id: string;
  file: string;
  maxTriangles: number;
  maxBytes: number;
  requiredNodes: string[];
  nodeCounts: Record<string, number>;
  materials: string[];
  bounds: { size: [number, number, number]; tolerance: number };
  origin: "tine-tips" | "ground-center";
}

interface ModelsSpecFile {
  version: number;
  budgets: { maxTotalTriangles: number; maxTotalBytes: number };
  models: ModelSpec[];
}

const ROOT = process.cwd();
const SPEC_PATH = path.join(ROOT, "assets", "models.spec.json");
const MODELS_DIR = path.join(ROOT, "public", "assets", "models");
const MANIFEST_PATH = path.join(ROOT, "public", "assets", "manifest.json");

function makeBoxData(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): { positions: Float32Array; normals: Float32Array; indices: Uint16Array } {
  const p = [
    // +Z
    [minX, minY, maxZ], [maxX, minY, maxZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
    // -Z
    [maxX, minY, minZ], [minX, minY, minZ], [minX, maxY, minZ], [maxX, maxY, minZ],
    // +Y
    [minX, maxY, maxZ], [maxX, maxY, maxZ], [maxX, maxY, minZ], [minX, maxY, minZ],
    // -Y
    [minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ],
    // +X
    [maxX, minY, maxZ], [maxX, minY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ],
    // -X
    [minX, minY, minZ], [minX, minY, maxZ], [minX, maxY, maxZ], [minX, maxY, minZ],
  ];
  const n = [
    [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0],
  ];
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const indices = new Uint16Array(36);

  for (let i = 0; i < 24; i++) {
    const v = p[i]!;
    const norm = n[Math.floor(i / 4)]!;
    positions[i * 3] = v[0]!;
    positions[i * 3 + 1] = v[1]!;
    positions[i * 3 + 2] = v[2]!;
    normals[i * 3] = norm[0]!;
    normals[i * 3 + 1] = norm[1]!;
    normals[i * 3 + 2] = norm[2]!;
  }
  for (let f = 0; f < 6; f++) {
    const o = f * 4;
    const i = f * 6;
    indices[i] = o;
    indices[i + 1] = o + 1;
    indices[i + 2] = o + 2;
    indices[i + 3] = o;
    indices[i + 4] = o + 2;
    indices[i + 5] = o + 3;
  }
  return { positions, normals, indices };
}

function buildPlaceholderGlb(spec: ModelSpec): Buffer {
  const [sx, sy, sz] = spec.bounds.size;
  const minX = -sx / 2;
  const maxX = sx / 2;
  const minY = 0;
  const maxY = sy;
  const minZ = spec.origin === "tine-tips" ? -1 : -sz / 2;
  const maxZ = spec.origin === "tine-tips" ? sz - 1 : sz / 2;

  const box = makeBoxData(minX, minY, minZ, maxX, maxY, maxZ);

  const posBytes = Buffer.from(box.positions.buffer);
  const normBytes = Buffer.from(box.normals.buffer);
  const idxBytes = Buffer.from(box.indices.buffer);
  const binRaw = Buffer.concat([posBytes, normBytes, idxBytes]);
  const binPad = (4 - (binRaw.length % 4)) % 4;
  const binBuf = Buffer.concat([binRaw, Buffer.alloc(binPad)]);

  const materials = spec.materials.map((name) => ({
    name,
    pbrMetallicRoughness: {
      baseColorFactor: [0.6, 0.55, 0.45, 1],
      metallicFactor: 0,
      roughnessFactor: 0.9,
    },
  }));

  const nodes: Array<{
    name: string;
    mesh?: number;
    children?: number[];
    extras?: Record<string, unknown>;
  }> = [];

  const rootChildren: number[] = [];

  // Primary mesh node
  const primaryName = spec.requiredNodes[0] ?? "Mesh";
  nodes.push({
    name: primaryName,
    mesh: 0,
    extras: { part: spec.id },
  });
  rootChildren.push(0);

  // Additional required nodes
  for (let i = 1; i < spec.requiredNodes.length; i++) {
    nodes.push({ name: spec.requiredNodes[i]! });
    rootChildren.push(nodes.length - 1);
  }

  // Prefixed nodes (e.g. tine_0..tine_N)
  for (const [prefix, count] of Object.entries(spec.nodeCounts)) {
    for (let i = 0; i < count; i++) {
      nodes.push({ name: `${prefix}${i}` });
      rootChildren.push(nodes.length - 1);
    }
  }

  const gltf = {
    asset: { version: "2.0", generator: "rake-me-placeholder" },
    scene: 0,
    scenes: [{ nodes: rootChildren }],
    nodes,
    materials,
    meshes: [
      {
        name: spec.id,
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1 },
            indices: 2,
            material: 0,
          },
        ],
      },
    ],
    buffers: [{ byteLength: binBuf.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
      { buffer: 0, byteOffset: posBytes.length, byteLength: normBytes.length, target: 34962 },
      {
        buffer: 0,
        byteOffset: posBytes.length + normBytes.length,
        byteLength: idxBytes.length,
        target: 34963,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 24,
        type: "VEC3",
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
      },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
    ],
  };

  const jsonRaw = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPad = (4 - (jsonRaw.length % 4)) % 4;
  const jsonBuf = Buffer.concat([jsonRaw, Buffer.alloc(jsonPad, 0x20)]);

  const totalLength = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binBuf.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);

  return Buffer.concat([header, jsonHeader, jsonBuf, binHeader, binBuf]);
}

function main(): void {
  const specBuf = fs.readFileSync(SPEC_PATH);
  const specSha256 = crypto.createHash("sha256").update(specBuf).digest("hex");
  const spec = JSON.parse(specBuf.toString("utf8")) as ModelsSpecFile;

  const manifestEntries = [];

  for (const model of spec.models) {
    const outPath = path.join(MODELS_DIR, model.file);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const glb = buildPlaceholderGlb(model);
    fs.writeFileSync(outPath, glb);
    const parsed = parseGlb(outPath);
    manifestEntries.push({
      id: model.id,
      file: model.file,
      bytes: parsed.bytes,
      sha256: parsed.sha256,
      triangles: parsed.triangles,
      vertices: parsed.vertices,
      nodes: parsed.nodes,
      materials: parsed.materials,
      bounds: parsed.bounds,
    });
  }

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(
    MANIFEST_PATH,
    JSON.stringify({ version: 1, specSha256, models: manifestEntries }, null, 2) + "\n",
  );
  console.log(`Generated ${manifestEntries.length} placeholder GLBs and manifest.`);
}

main();
