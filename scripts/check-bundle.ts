import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, "dist");
const PKG_PATH = path.join(ROOT, "package.json");

const MAX_JS_GZIP_BYTES = 300 * 1024;
const MAX_MODELS_BYTES = 550 * 1024;
const MAX_TOTAL_FIRST_LOAD_BYTES = 950 * 1024;

function walk(dir: string, acc: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else {
      acc.push(full);
    }
  }
}

function main(): void {
  const errors: string[] = [];

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const depKeys = Object.keys(pkg.dependencies ?? {});
  if (depKeys.length !== 1 || depKeys[0] !== "three") {
    errors.push(`dependencies must be ["three"] only, got ${JSON.stringify(depKeys)}`);
  }

  if (!fs.existsSync(DIST_DIR)) {
    errors.push("dist/ does not exist; run npm run build first");
  } else {
    const files: string[] = [];
    walk(DIST_DIR, files);

    let jsGzipBytes = 0;
    let modelBytes = 0;
    let totalGzipOrBin = 0;

    for (const f of files) {
      const buf = fs.readFileSync(f);
      if (f.endsWith(".js")) {
        const gz = zlib.gzipSync(buf).length;
        jsGzipBytes += gz;
        totalGzipOrBin += gz;
      } else if (f.endsWith(".glb")) {
        modelBytes += buf.length;
        totalGzipOrBin += buf.length;
      } else {
        totalGzipOrBin += zlib.gzipSync(buf).length;
      }
    }

    if (jsGzipBytes > MAX_JS_GZIP_BYTES) {
      errors.push(
        `JS gzipped ${(jsGzipBytes / 1024).toFixed(1)} KB > budget ${(MAX_JS_GZIP_BYTES / 1024).toFixed(0)} KB`,
      );
    }
    if (modelBytes > MAX_MODELS_BYTES) {
      errors.push(
        `Models ${(modelBytes / 1024).toFixed(1)} KB > budget ${(MAX_MODELS_BYTES / 1024).toFixed(0)} KB`,
      );
    }
    if (totalGzipOrBin > MAX_TOTAL_FIRST_LOAD_BYTES) {
      errors.push(
        `Total first load ${(totalGzipOrBin / 1024).toFixed(1)} KB > budget ${(MAX_TOTAL_FIRST_LOAD_BYTES / 1024).toFixed(0)} KB`,
      );
    }

    if (errors.length === 0) {
      console.log(
        `check:bundle PASS — JS gzip: ${(jsGzipBytes / 1024).toFixed(1)} KB / 300 KB, models: ${(modelBytes / 1024).toFixed(1)} KB / 550 KB, total: ${(totalGzipOrBin / 1024).toFixed(1)} KB / 950 KB`,
      );
    }
  }

  if (errors.length > 0) {
    console.error("check:bundle FAILED:");
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }
}

main();
