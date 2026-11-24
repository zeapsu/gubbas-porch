#!/usr/bin/env node
/**
 * Merges Dependabot minor/patch PRs for non-runtime dependencies once CI has succeeded.
 *
 * Runs from `.github/workflows/dependabot-auto.yml` on `workflow_run` of "CI", always from the
 * trusted default branch (never the PR ref). Every condition in `findMergeBlockers` must hold
 * for the PR whose head is WORKFLOW_RUN_HEAD_SHA; anything missing, unrecognised, truncated, or
 * ambiguous leaves the PR for a human (fail closed). Major upgrades and runtime dependency
 * (`three` / `prod-dependencies`) bumps are never merged here.
 *
 * CI has already finished when this runs, so the merge is immediate and pinned to the verified
 * head commit. GitHub's deferred auto-merge is never armed: it would stay enabled across later
 * commits that this script has not verified.
 *
 * Env: GH_TOKEN (used by `gh`), GITHUB_REPOSITORY, WORKFLOW_RUN_HEAD_SHA, WORKFLOW_RUN_ID.
 * `gh` is only ever invoked through execFileSync with argument arrays (no shell).
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEPENDABOT_LOGIN = "dependabot[bot]";

/** Job names from .github/workflows/ci.yml; all three must be green on the PR head. */
export const REQUIRED_CI_CHECKS = [
  "Review Gate (REVIEW.md)",
  "Static Checks, Assets, Unit Tests & Build",
  "Browser E2E & 8-Bit Visual Verification",
];

/** Human-readable form of `isAllowedDependabotFile`, shared with review-gate.mjs and REVIEW.md. */
export const ALLOWED_DEPENDABOT_FILES_TEXT =
  "package.json, package-lock.json, or .github/workflows/*.yml / .yaml";

/**
 * Runtime (shipped) dependencies and the Dependabot group that carries them. A merge made with
 * GITHUB_TOKEN triggers neither push CI nor the Pages deploy, so these always go to a human.
 * `three` is 0.x, where minor releases carry breaking changes.
 */
export const RUNTIME_DEPENDENCY_NAMES = ["three"];
export const RUNTIME_DEPENDENCY_GROUPS = ["prod-dependencies"];

const AUTO_MERGE_UPDATE_TYPES = new Set([
  "version-update:semver-minor",
  "version-update:semver-patch",
]);

// Dependabot commits are authored by the bot, committed by GitHub (web-flow), and signed by GitHub.
const TRUSTED_COMMITTER_LOGINS = new Set([DEPENDABOT_LOGIN, "web-flow"]);

/** The only paths a dependency/workflow-only Dependabot PR may touch (shared with review-gate.mjs). */
export function isAllowedDependabotFile(rel) {
  return (
    rel === "package.json" ||
    rel === "package-lock.json" ||
    (typeof rel === "string" && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel))
  );
}

const METADATA_FIELD = /^([A-Za-z][A-Za-z0-9-]*):(?:\s+(.*))?$/;

function unquote(value) {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

/**
 * Reads the `updated-dependencies:` metadata block(s) Dependabot appends to a commit message.
 * Returns one element per list item in the block: `{ dependencyName, updateType, dependencyGroup }`
 * (`dependencyGroup` is `null` for an ungrouped update), or `null` for an entry that cannot be
 * verified: no `dependency-name`, no `update-type`, a repeated key, an empty `dependency-group`,
 * or a line that is not `key: value`.
 *
 * Every list item starts an entry whatever its first key is, so an unexpected entry shape yields
 * a `null` instead of silently ending the block and hiding the entries after it.
 */
export function parseDependabotUpdates(message) {
  const entries = [];
  let inBlock = false;
  let current = null;

  const startEntry = (verifiable) => {
    current = { fields: new Map(), verifiable };
    entries.push(current);
  };
  const addField = (text) => {
    const match = METADATA_FIELD.exec(text);
    if (!match || current.fields.has(match[1])) {
      current.verifiable = false;
      return;
    }
    current.fields.set(match[1], unquote((match[2] ?? "").trim()));
  };

  for (const raw of String(message ?? "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!inBlock) {
      inBlock = line === "updated-dependencies:";
      continue;
    }
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) {
      startEntry(true);
      addField(item[1]);
      continue;
    }
    if (/^\s+\S/.test(line)) {
      if (current === null) startEntry(false); // a key that belongs to no list item
      addField(line.trim());
      continue;
    }
    // "...", a blank line, or anything else ends the block.
    inBlock = line === "updated-dependencies:";
    current = null;
  }

  return entries.map(({ fields, verifiable }) => {
    const dependencyName = fields.get("dependency-name");
    const updateType = fields.get("update-type");
    const dependencyGroup = fields.get("dependency-group");
    if (!verifiable || !dependencyName || !updateType || dependencyGroup === "") return null;
    return { dependencyName, updateType, dependencyGroup: dependencyGroup ?? null };
  });
}

/** True only for a non-empty list in which every entry is a verifiable semver-minor/patch update. */
export function isMinorOrPatchOnly(updates) {
  return (
    Array.isArray(updates) &&
    updates.length > 0 &&
    updates.every((update) => update != null && AUTO_MERGE_UPDATE_TYPES.has(update.updateType))
  );
}

/** True when the entry updates a shipped runtime dependency (by name or by Dependabot group). */
export function isRuntimeDependencyUpdate(update) {
  return (
    RUNTIME_DEPENDENCY_NAMES.includes(update?.dependencyName) ||
    RUNTIME_DEPENDENCY_GROUPS.includes(update?.dependencyGroup)
  );
}

/**
 * `jobs` are the jobs of the CI run that triggered this workflow. True only when each required
 * job is present and every job of that name ran on `headSha` and completed with success.
 */
export function allRequiredCiJobsPassed(jobs, headSha) {
  if (!Array.isArray(jobs) || typeof headSha !== "string" || headSha === "") return false;
  return REQUIRED_CI_CHECKS.every((name) => {
    const named = jobs.filter((job) => job?.name === name);
    return (
      named.length > 0 &&
      named.every(
        (job) =>
          job.head_sha === headSha && job.status === "completed" && job.conclusion === "success",
      )
    );
  });
}

/**
 * A commit as returned by `GET /pulls/{n}/commits`. `author.login` alone follows the author
 * e-mail, which anyone with push access can forge, so the GitHub signature and committer are
 * required too.
 */
export function isTrustedDependabotCommit(commit) {
  return (
    commit?.author?.login === DEPENDABOT_LOGIN &&
    TRUSTED_COMMITTER_LOGINS.has(commit?.committer?.login) &&
    commit?.commit?.verification?.verified === true
  );
}

/**
 * Returns every reason the PR must NOT be merged; an empty array means all checks hold.
 * `pr` is the full `GET /pulls/{n}` object: its `commits` and `changed_files` counts prove the
 * paginated `commits` and `files` listings were not truncated by the API. `jobs` and
 * `jobsTotalCount` come from the triggering CI run's jobs listing.
 */
export function findMergeBlockers({ pr, commits, files, jobs, jobsTotalCount, repo, headSha }) {
  const blockers = [];

  if (pr?.state !== "open") blockers.push("PR is not open");
  if (pr?.draft !== false) blockers.push("PR is a draft (or draft state is unknown)");
  if (pr?.base?.ref !== "main") blockers.push("PR base is not main");
  if (pr?.head?.repo?.full_name !== repo) blockers.push("PR head is not in this repository");
  if (pr?.head?.sha !== headSha) blockers.push("PR head moved since the CI run");
  if (pr?.user?.login !== DEPENDABOT_LOGIN) blockers.push("PR was not opened by dependabot[bot]");

  if (!Array.isArray(commits) || commits.length === 0) {
    blockers.push("PR has no commits to verify");
  } else {
    if (commits.length !== pr?.commits) {
      blockers.push("PR commit list is incomplete (does not match the PR's commit count)");
    }
    if (!commits.every(isTrustedDependabotCommit)) {
      blockers.push("PR has a commit that is not a GitHub-signed dependabot[bot] commit");
    }
    if (!commits.some((commit) => commit?.sha === headSha)) {
      blockers.push("PR commit list does not contain the CI head commit");
    }

    // Judged per commit: a commit without usable metadata must not hide behind a valid one.
    const updatesPerCommit = commits.map((commit) => parseDependabotUpdates(commit?.commit?.message));
    if (!updatesPerCommit.every(isMinorOrPatchOnly)) {
      blockers.push(
        "not every commit lists only verifiable semver-minor/patch updates " +
          `(found: ${JSON.stringify(updatesPerCommit)})`,
      );
    }
    if (updatesPerCommit.flat().some(isRuntimeDependencyUpdate)) {
      blockers.push(
        "PR updates a runtime dependency (three / prod-dependencies), which needs human review " +
          "and a Pages deploy",
      );
    }
  }

  if (!Array.isArray(files) || files.length === 0) {
    blockers.push("PR has no changed files to verify");
  } else {
    if (files.length !== pr?.changed_files) {
      blockers.push("PR file list is incomplete (does not match the PR's changed-file count)");
    }
    if (
      !files.every(
        (file) =>
          isAllowedDependabotFile(file?.filename) &&
          (file.previous_filename == null || isAllowedDependabotFile(file.previous_filename)),
      )
    ) {
      blockers.push(`PR touches files other than ${ALLOWED_DEPENDABOT_FILES_TEXT}`);
    }
  }

  if (!Array.isArray(jobs) || jobsTotalCount !== jobs.length) {
    blockers.push("CI job list is incomplete (does not match the run's job count)");
  }
  if (!allRequiredCiJobsPassed(jobs, headSha)) {
    blockers.push(
      "not all required CI jobs of the triggering run completed successfully on the head commit",
    );
  }

  return blockers;
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Paginated `gh api` call; `jq` must emit one compact JSON value per line. */
function ghApiLines(runGh, endpoint, jq) {
  return runGh(["api", "--paginate", endpoint, "--jq", jq])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * `deps.runGh(args)` runs `gh` and returns its stdout; `deps.log(line)` reports the outcome.
 * Both are injectable so tests can drive this without a network or a real merge.
 */
export function main(env = process.env, { runGh = gh, log = console.log } = {}) {
  const repo = env.GITHUB_REPOSITORY ?? "";
  const headSha = env.WORKFLOW_RUN_HEAD_SHA ?? "";
  const workflowRunId = env.WORKFLOW_RUN_ID ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("GITHUB_REPOSITORY is missing or malformed");
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("WORKFLOW_RUN_HEAD_SHA is missing or not a full commit SHA");
  }
  if (!/^[1-9][0-9]*$/.test(workflowRunId)) {
    throw new Error("WORKFLOW_RUN_ID is missing or not a positive integer");
  }

  // workflow_run.pull_requests can be empty, so always resolve the PR from the head SHA.
  const candidates = ghApiLines(
    runGh,
    `repos/${repo}/pulls?state=open&base=main&per_page=100`,
    ".[] | {number, user: {login: .user.login}, head: {sha: .head.sha}}",
  ).filter((candidate) => candidate?.head?.sha === headSha);

  if (candidates.length !== 1) {
    log(
      `Found ${candidates.length} open PRs into main at ${headSha}; exactly 1 is required. Nothing merged.`,
    );
    return 0;
  }
  const { number } = candidates[0];
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("PR number is not a positive integer");
  }

  if (candidates[0].user?.login !== DEPENDABOT_LOGIN) {
    log(`PR #${number} was not opened by dependabot[bot]. Nothing merged.`);
    return 0;
  }

  // The full PR object carries the commit and file counts used to detect truncated listings.
  const pr = JSON.parse(
    runGh([
      "api",
      `repos/${repo}/pulls/${number}`,
      "--jq",
      "{number, state, draft, commits, changed_files, user: {login: .user.login}," +
        " base: {ref: .base.ref}, head: {sha: .head.sha, repo: {full_name: .head.repo.full_name}}}",
    ]),
  );
  if (pr?.number !== number) throw new Error("PR details do not match the resolved PR number");

  const commits = ghApiLines(
    runGh,
    `repos/${repo}/pulls/${number}/commits?per_page=100`,
    ".[] | {sha, author: {login: .author.login}, committer: {login: .committer.login}," +
      " commit: {message: .commit.message, verification: {verified: .commit.verification.verified}}}",
  );
  const files = ghApiLines(
    runGh,
    `repos/${repo}/pulls/${number}/files?per_page=100`,
    ".[] | {filename, previous_filename}",
  );
  // Only the jobs of the CI run that triggered this workflow count, not any check on the commit.
  const jobPages = ghApiLines(
    runGh,
    `repos/${repo}/actions/runs/${workflowRunId}/jobs?per_page=100`,
    "{total_count, jobs: [.jobs[] | {name, status, conclusion, head_sha}]}",
  );
  const jobs = jobPages.flatMap((page) => page?.jobs ?? []);
  const jobsTotalCount = jobPages[0]?.total_count;

  const blockers = findMergeBlockers({ pr, commits, files, jobs, jobsTotalCount, repo, headSha });
  if (blockers.length > 0) {
    log(`PR #${number} left for human review. Not merged because:`);
    for (const blocker of blockers) log(`  - ${blocker}`);
    return 0;
  }

  // Immediate merge, refused by GitHub if the head is no longer the verified commit.
  runGh([
    "pr", "merge", String(number),
    "--repo", repo,
    "--squash",
    "--match-head-commit", headSha,
  ]);
  log(`PR #${number} squash-merged at ${headSha}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`dependabot-auto-merge failed closed: ${error?.message ?? error}`);
    if (error?.stderr) console.error(String(error.stderr));
    process.exit(1);
  }
}
