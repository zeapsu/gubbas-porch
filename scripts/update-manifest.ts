import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseGlb } from "./verify-assets.ts";

interface ModelSpec {
  id: string;
  file: string;
}

interface ModelsSpecFile {
  version: number;
  models: ModelSpec[];
}

const ROOT = process.cwd();
const SPEC_PATH = path.join(ROOT, "assets", "models.spec.json");
const MODELS_DIR = path.join(ROOT, "public", "assets", "models");
const MANIFEST_PATH = path.join(ROOT, "public", "assets", "manifest.json");

function main(): void {
  const specBuf = fs.readFileSync(SPEC_PATH);
  const specSha256 = crypto.createHash("sha256").update(specBuf).digest("hex");
  const spec = JSON.parse(specBuf.toString("utf8")) as ModelsSpecFile;

  const entries = spec.models.map((m) => {
    const filePath = path.join(MODELS_DIR, m.file);
    const parsed = parseGlb(filePath);
    return {
      id: m.id,
      file: m.file,
      bytes: parsed.bytes,
      sha256: parsed.sha256,
      triangles: parsed.triangles,
      vertices: parsed.vertices,
      nodes: parsed.nodes,
      materials: parsed.materials,
      bounds: parsed.bounds,
    };
  });

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(
    MANIFEST_PATH,
    JSON.stringify({ version: 1, specSha256, models: entries }, null, 2) + "\n",
  );
  console.log(`Updated manifest.json for ${entries.length} models.`);
}

main();
