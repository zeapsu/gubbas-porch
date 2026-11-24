#!/usr/bin/env node
/**
 * Deterministic CI review gate enforcing REVIEW.md.
 *
 * Checks:
 *  1. Governance integrity: REVIEW.md and AGENTS.md exist and AGENTS.md references REVIEW.md.
 *  2. Security hygiene across tracked source & workflow files:
 *     - No eval(), new Function(), innerHTML / outerHTML / document.write in src/ or scripts/
 *     - No secret/token patterns in tracked files
 *     - GitHub Actions workflows declare explicit `permissions:` and avoid unsafe
 *       `${{ github.event.* }}` direct shell interpolation
 *  3. Pull request contract (when running in GitHub Actions PR context):
 *     - PR body contains Risk Tier, Testing, and How to Revert sections
 *     - Computed risk tier from changed paths is not under-declared by the PR body
 *     - Prints a structured REVIEW.md summary header
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const errors = [];
const warnings = [];

function readText(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}

function listTrackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function getChangedFiles(baseRef) {
  if (!baseRef) return null;
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", `${baseRef}...HEAD`],
      { cwd: ROOT, encoding: "utf8" },
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

// 1. Governance files check
const reviewMd = readText("REVIEW.md");
const agentsMd = readText("AGENTS.md");
const designMd = readText("DESIGN.md");

if (!reviewMd) {
  errors.push("REVIEW.md:1 — missing required REVIEW.md");
} else {
  for (const requiredHeading of [
    "What Failure Looks Like",
    "Finding Classification",
    "Security Pass",
    "Convergence Rules",
    "Risk Tiers",
  ]) {
    if (!reviewMd.includes(requiredHeading)) {
      errors.push(`REVIEW.md:1 — missing required section "${requiredHeading}"`);
    }
  }
}

if (!agentsMd) {
  errors.push("AGENTS.md:1 — missing required AGENTS.md");
} else if (!agentsMd.includes("REVIEW.md")) {
  errors.push("AGENTS.md:1 — AGENTS.md must reference REVIEW.md");
}

if (!designMd) {
  warnings.push("DESIGN.md:1 — DESIGN.md not found");
}

// 2. Static security hygiene scan
const tracked = listTrackedFiles();
// Also scan untracked non-ignored files in src/, scripts/, .github/ for local pre-commit checks
function walkDir(relDir, acc) {
  const full = path.join(ROOT, relDir);
  if (!fs.existsSync(full)) return;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const childRel = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", ".git", "coverage"].includes(entry.name)) {
        continue;
      }
      walkDir(childRel, acc);
    } else {
      acc.add(childRel);
    }
  }
}

const filesToScan = new Set(tracked);
for (const dir of ["src", "scripts", ".github"]) {
  walkDir(dir, filesToScan);
}

const forbiddenRuntimePatterns = [
  { name: "eval()", regex: /\beval\s*\(/ },
  { name: "new Function()", regex: /\bnew\s+Function\s*\(/ },
  { name: "innerHTML assignment", regex: /\.innerHTML\s*=/ },
  { name: "outerHTML assignment", regex: /\.outerHTML\s*=/ },
  { name: "document.write()", regex: /\bdocument\.write\s*\(/ },
];

const secretPatterns = [
  { name: "GitHub PAT", regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { name: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "OpenAI API key", regex: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: "Private key block", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const unsafeWorkflowExpr =
  /\$\{\{\s*github\.event\.(?:issue|pull_request|comment|review|head_commit)\.(?:title|body|head\.ref|message)/;

for (const rel of filesToScan) {
  // Skip review-gate itself and binary assets
  if (rel === ".github/scripts/review-gate.mjs") continue;
  if (/\.(png|jpg|jpeg|gif|webp|glb|gltf|ico|woff2?|mp3|wav)$/i.test(rel)) continue;
  if (rel === "package-lock.json") continue;

  const content = readText(rel);
  if (content === null) continue;
  const lines = content.split("\n");

  // Runtime code security checks (src/** and scripts/** excluding tests)
  if (/^(src|scripts)\/.*\.(ts|tsx|js|mjs|cjs)$/.test(rel)) {
    lines.forEach((line, idx) => {
      for (const pat of forbiddenRuntimePatterns) {
        if (pat.regex.test(line)) {
          errors.push(`${rel}:${idx + 1} — forbidden security pattern: ${pat.name}`);
        }
      }
    });
  }

  // Secret scan across all text files
  lines.forEach((line, idx) => {
    for (const pat of secretPatterns) {
      if (pat.regex.test(line)) {
        errors.push(`${rel}:${idx + 1} — potential committed secret (${pat.name})`);
      }
    }
  });

  // Workflow hygiene checks
  if (/^\.github\/workflows\/.*\.ya?ml$/.test(rel)) {
    if (!/^\s*permissions\s*:/m.test(content)) {
      errors.push(`${rel}:1 — workflow must declare explicit least-privilege permissions:`);
    }
    lines.forEach((line, idx) => {
      if (unsafeWorkflowExpr.test(line)) {
        errors.push(
          `${rel}:${idx + 1} — unsafe direct interpolation of untrusted github.event field; pass via env: instead`,
        );
      }
    });
  }
}

// 3. Risk tier classification & PR metadata check
const TIER_ORDER = { Low: 1, Medium: 2, High: 3 };

function classifyPath(rel) {
  if (
    rel.startsWith(".github/workflows/") ||
    rel.startsWith(".github/scripts/") ||
    rel === ".github/dependabot.yml" ||
    rel === "REVIEW.md" ||
    rel === "AGENTS.md" ||
    rel === "vite.config.ts" ||
    rel === "eslint.config.js" ||
    rel === "tsconfig.json" ||
    rel === "vitest.config.ts" ||
    rel === "playwright.config.ts" ||
    rel === "package.json" ||
    rel === "package-lock.json"
  ) {
    return "High";
  }
  if (
    rel.startsWith("src/") ||
    rel.startsWith("scripts/") ||
    rel.startsWith("assets/") ||
    rel.startsWith("public/assets/")
  ) {
    return "Medium";
  }
  return "Low";
}

let computedTier = "Low";
const eventPath = process.env.GITHUB_EVENT_PATH;
const eventName = process.env.GITHUB_EVENT_NAME || "";

if (eventName === "pull_request" && eventPath && fs.existsSync(eventPath)) {
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const pr = event.pull_request;
  const body = (pr && pr.body) || "";
  const baseSha = pr && pr.base && pr.base.sha;
  const changed = getChangedFiles(baseSha);

  if (changed === null) {
    computedTier = "High";
    errors.push("git diff failed for PR base SHA; failing closed at High risk tier");
  } else {
    for (const rel of changed) {
      const t = classifyPath(rel);
      if (TIER_ORDER[t] > TIER_ORDER[computedTier]) {
        computedTier = t;
      }
    }
  }

  for (const section of ["Risk Tier", "Testing", "How to Revert"]) {
    if (!new RegExp(`^##\\s+${section}\\b`, "im").test(body)) {
      errors.push(
        `PR body — missing required "## ${section}" section (see .github/pull_request_template.md)`,
      );
    }
  }

  const checkedTiers = [];
  for (const tier of ["Low", "Medium", "High"]) {
    if (new RegExp(`-\\s*\\[x\\]\\s*\\*\\*${tier}\\*\\*`, "i").test(body)) {
      checkedTiers.push(tier);
    }
  }

  if (checkedTiers.length === 0) {
    errors.push(
      `PR body — select one Risk Tier checkbox (minimum required for changed paths: ${computedTier})`,
    );
  } else {
    const declared = checkedTiers.reduce((a, b) =>
      TIER_ORDER[a] >= TIER_ORDER[b] ? a : b,
    );
    if (TIER_ORDER[declared] < TIER_ORDER[computedTier]) {
      errors.push(
        `PR body — declared Risk Tier "${declared}" is below required "${computedTier}" for changed paths`,
      );
    }
  }
}

const importantCount = errors.length;
const nitCount = warnings.length;
const verdict = importantCount === 0 ? "PASS" : "CHANGES_REQUESTED";

console.log(`Review Summary — Important: ${importantCount} | Nit: ${nitCount} | Pre-existing: 0`);
console.log(`Risk Tier: ${computedTier}`);
console.log(`Verdict: ${verdict}`);

if (importantCount === 0 && nitCount === 0) {
  console.log("Nothing to fix.");
} else {
  for (const err of errors) {
    console.error(`[Important] ${err}`);
  }
  for (const warn of warnings) {
    console.warn(`[Nit] ${warn}`);
  }
}

process.exit(importantCount === 0 ? 0 : 1);
