import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPTS_DIR = fileURLToPath(new URL("../../.github/scripts/", import.meta.url));
const GATE = path.join(SCRIPTS_DIR, "review-gate.mjs");
const readRepoFile = (rel: string): string =>
  fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

interface CiJob {
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
}
interface DependabotUpdate {
  dependencyName: string;
  updateType: string;
  dependencyGroup: string | null;
}
interface PrCommit {
  sha: string;
  author: { login: string | null };
  committer: { login: string | null };
  commit: { message: string; verification: { verified: boolean } };
}
interface PullRequest {
  number: unknown;
  state: string;
  draft: boolean | undefined;
  commits: unknown;
  changed_files: unknown;
  user: { login: string };
  base: { ref: string };
  head: { sha: string; repo: { full_name: string } | null };
}
interface MergeInput {
  pr: PullRequest | undefined;
  commits: PrCommit[];
  files: { filename: string; previous_filename?: string }[];
  jobs: CiJob[];
  jobsTotalCount: unknown;
  repo: string;
  headSha: string;
}
interface MainDeps {
  runGh(args: string[]): string;
  log(line: string): void;
}
interface AutoMergeModule {
  REQUIRED_CI_CHECKS: string[];
  RUNTIME_DEPENDENCY_NAMES: string[];
  RUNTIME_DEPENDENCY_GROUPS: string[];
  ALLOWED_DEPENDABOT_FILES_TEXT: string;
  isAllowedDependabotFile(rel: unknown): boolean;
  parseDependabotUpdates(message: unknown): (DependabotUpdate | null)[];
  isMinorOrPatchOnly(updates: unknown): boolean;
  isRuntimeDependencyUpdate(update: unknown): boolean;
  allRequiredCiJobsPassed(jobs: unknown, headSha: unknown): boolean;
  isTrustedDependabotCommit(commit: unknown): boolean;
  findMergeBlockers(input: MergeInput): string[];
  main(env: Record<string, string | undefined>, deps: MainDeps): number;
}

// The scripts are plain .mjs (no type declarations), so load them through a typed dynamic import.
const autoMergeUrl = pathToFileURL(path.join(SCRIPTS_DIR, "dependabot-auto-merge.mjs")).href;
const autoMerge = (await import(/* @vite-ignore */ autoMergeUrl)) as AutoMergeModule;

const DEPENDABOT = "dependabot[bot]";

const MINOR = "version-update:semver-minor";
const PATCH = "version-update:semver-patch";
const MAJOR = "version-update:semver-major";

/** One metadata entry. `null` omits that key; `name: null` makes another key the entry's first. */
interface EntrySpec {
  name?: string | null;
  type?: string | null;
  group?: string | null;
}

function metadataEntry(spec: EntrySpec, index: number): string {
  const fields: [string, string | null][] = [
    ["dependency-name", spec.name === undefined ? `dep-${index}` : spec.name],
    ["dependency-version", "1.2.3"],
    ["dependency-type", "direct:development"],
    ["update-type", spec.type === undefined ? MINOR : spec.type],
    ["dependency-group", spec.group === undefined ? "dev-dependencies" : spec.group],
  ];
  return fields
    .filter(([, value]) => value !== null)
    .map(([key, value], i) => `${i === 0 ? "- " : "  "}${key}: ${value}`)
    .join("\n");
}

/** A real Dependabot commit message shape. A bare string (or null) is shorthand for `{ type }`. */
function dependabotMessage(...specs: (string | null | EntrySpec)[]): string {
  const entries = specs.map((spec, i) =>
    metadataEntry(typeof spec === "string" || spec === null ? { type: spec } : spec, i),
  );
  return [
    "chore(deps): bump the dev-dependencies group with some updates",
    "",
    "Bumps the dev-dependencies group.",
    "",
    "---",
    "updated-dependencies:",
    ...entries,
    "...",
    "",
    "Signed-off-by: dependabot[bot] <support@github.com>",
  ].join("\n");
}

const update = (overrides: Partial<DependabotUpdate> = {}): DependabotUpdate => ({
  dependencyName: "dep-0",
  updateType: MINOR,
  dependencyGroup: "dev-dependencies",
  ...overrides,
});

describe("dependabot-auto-merge helpers", () => {
  it("isAllowedDependabotFile allows only manifests and top-level workflow files", () => {
    for (const ok of [
      "package.json",
      "package-lock.json",
      ".github/workflows/ci.yml",
      ".github/workflows/deploy.yaml",
    ]) {
      expect(autoMerge.isAllowedDependabotFile(ok), ok).toBe(true);
    }
    for (const bad of [
      "src/main.ts",
      "packages/x/package.json",
      "./package.json",
      "package.json.bak",
      "package.json ",
      ".github/workflows/nested/ci.yml",
      ".github/workflows/ci.yml.sh",
      ".github/workflows/run.sh",
      ".github/scripts/review-gate.mjs",
      ".github/dependabot.yml",
      "REVIEW.md",
      "",
      undefined,
      null,
    ]) {
      expect(autoMerge.isAllowedDependabotFile(bad), String(bad)).toBe(false);
    }
  });

  it("parseDependabotUpdates returns one structured entry per dependency", () => {
    expect(autoMerge.parseDependabotUpdates(dependabotMessage(MINOR))).toEqual([update()]);
    expect(autoMerge.parseDependabotUpdates(dependabotMessage(MINOR, PATCH, MAJOR))).toEqual([
      update(),
      update({ dependencyName: "dep-1", updateType: PATCH }),
      update({ dependencyName: "dep-2", updateType: MAJOR }),
    ]);
    // CRLF line endings must not change the result.
    expect(
      autoMerge.parseDependabotUpdates(dependabotMessage(PATCH).replace(/\n/g, "\r\n")),
    ).toEqual([update({ updateType: PATCH })]);
    // An ungrouped update has no dependency-group key.
    expect(autoMerge.parseDependabotUpdates(dependabotMessage({ group: null }))).toEqual([
      update({ dependencyGroup: null }),
    ]);
    // Dependabot quotes scoped package names; the quotes are YAML syntax, not part of the name.
    expect(
      autoMerge.parseDependabotUpdates(dependabotMessage({ name: '"@types/node"' }, { name: "'three'" })),
    ).toEqual([update({ dependencyName: "@types/node" }), update({ dependencyName: "three" })]);
  });

  it("parseDependabotUpdates reports entries it cannot verify as null", () => {
    const parse = autoMerge.parseDependabotUpdates;
    // An entry with no update-type (Dependabot omits it when it cannot tell).
    expect(parse(dependabotMessage(MINOR, null))).toEqual([update(), null]);
    // An entry that states two update types is ambiguous.
    const doubled = dependabotMessage(MAJOR).replace(
      `  update-type: ${MAJOR}`,
      `  update-type: ${MAJOR}\n  update-type: ${MINOR}`,
    );
    expect(parse(doubled)).toEqual([null]);
    // Any other repeated key is ambiguous too.
    expect(
      parse(dependabotMessage(MINOR).replace("- dependency-name: dep-0", "- dependency-name: dep-0\n  dependency-name: three")),
    ).toEqual([null]);
    expect(
      parse(dependabotMessage(MINOR).replace("  dependency-group: dev-dependencies", "  dependency-group: dev-dependencies\n  dependency-group: prod-dependencies")),
    ).toEqual([null]);
    // Empty values.
    expect(parse(dependabotMessage({ name: "" }))).toEqual([null]);
    expect(parse(dependabotMessage({ type: "" }))).toEqual([null]);
    expect(parse(dependabotMessage({ group: "" }))).toEqual([null]);
    // A line inside an entry that is not `key: value`.
    expect(
      parse(dependabotMessage(MINOR).replace("  dependency-version: 1.2.3", "  not a key value line")),
    ).toEqual([null]);
  });

  it("parseDependabotUpdates starts an entry at every list item, whatever its first key", () => {
    const parse = autoMerge.parseDependabotUpdates;
    // An entry whose first key is not dependency-name must not end the block and hide the rest.
    expect(parse(dependabotMessage(MINOR, { name: null, type: MAJOR }, PATCH))).toEqual([
      update(),
      null,
      update({ dependencyName: "dep-2", updateType: PATCH }),
    ]);
    // Same keys in a different order still describe a complete entry.
    const reordered = dependabotMessage(MAJOR).replace(
      "- dependency-name: dep-0\n  dependency-version: 1.2.3",
      "- dependency-version: 1.2.3\n  dependency-name: dep-0",
    );
    expect(parse(reordered)).toEqual([update({ updateType: MAJOR })]);
    // Indented, bare, and malformed list items are entries too (and unverifiable).
    const odd = dependabotMessage(MINOR, PATCH).replace(
      "- dependency-name: dep-1",
      "-\n  - update-type: version-update:semver-major\n--\n- dependency-name: dep-1",
    );
    expect(parse(odd)).toEqual([
      update(),
      null,
      null,
      null,
      update({ dependencyName: "dep-1", updateType: PATCH }),
    ]);
    // A key that belongs to no list item cannot be attributed to a dependency.
    const orphan = dependabotMessage(MINOR).replace(
      "updated-dependencies:\n",
      `updated-dependencies:\n  update-type: ${MAJOR}\n`,
    );
    expect(parse(orphan)).toEqual([null, update()]);
  });

  it("parseDependabotUpdates ignores metadata-looking text outside the block", () => {
    const parse = autoMerge.parseDependabotUpdates;
    expect(parse("")).toEqual([]);
    expect(parse(undefined)).toEqual([]);
    expect(parse("chore: bump x\n\nno metadata here")).toEqual([]);
    expect(parse(`chore: bump\n\n- dependency-name: x\n  update-type: ${MINOR}\n`)).toEqual([]);
    // Text after the block's "..." terminator is not metadata.
    expect(parse(`${dependabotMessage(MAJOR)}\n- dependency-name: x\n  update-type: ${MINOR}\n`)).toEqual([
      update({ updateType: MAJOR }),
    ]);
    // A second block in the same message is read as well.
    expect(parse(`${dependabotMessage(MINOR)}\n${dependabotMessage(MAJOR)}`)).toEqual([
      update(),
      update({ updateType: MAJOR }),
    ]);
  });

  it("isMinorOrPatchOnly passes only non-empty lists of verifiable minor/patch updates", () => {
    const ofTypes = (...types: string[]): DependabotUpdate[] => types.map((updateType) => update({ updateType }));
    expect(autoMerge.isMinorOrPatchOnly(ofTypes(MINOR))).toBe(true);
    expect(autoMerge.isMinorOrPatchOnly(ofTypes(PATCH))).toBe(true);
    expect(autoMerge.isMinorOrPatchOnly(ofTypes(MINOR, PATCH, PATCH))).toBe(true);

    expect(autoMerge.isMinorOrPatchOnly(ofTypes(MAJOR))).toBe(false);
    expect(autoMerge.isMinorOrPatchOnly(ofTypes(MINOR, MAJOR))).toBe(false);
    expect(autoMerge.isMinorOrPatchOnly([])).toBe(false);
    expect(autoMerge.isMinorOrPatchOnly([update(), null])).toBe(false);
    expect(autoMerge.isMinorOrPatchOnly(ofTypes("semver-minor"))).toBe(false);
    expect(autoMerge.isMinorOrPatchOnly(ofTypes(`${MINOR} `))).toBe(false);
    expect(autoMerge.isMinorOrPatchOnly([MINOR])).toBe(false);
    expect(autoMerge.isMinorOrPatchOnly(undefined)).toBe(false);
    expect(autoMerge.isMinorOrPatchOnly(update())).toBe(false);
  });

  it("isMinorOrPatchOnly fails closed on parsed messages without usable metadata", () => {
    const check = (message: string): boolean =>
      autoMerge.isMinorOrPatchOnly(autoMerge.parseDependabotUpdates(message));
    expect(check(dependabotMessage(MINOR, PATCH))).toBe(true);
    expect(check(dependabotMessage(MAJOR))).toBe(false);
    expect(check(dependabotMessage(MINOR, MAJOR))).toBe(false);
    expect(check(dependabotMessage(MINOR, null))).toBe(false);
    expect(check(dependabotMessage(MINOR, { name: null, type: MINOR }))).toBe(false);
    expect(check(dependabotMessage())).toBe(false);
    expect(check("chore(deps): bump x from 1 to 2")).toBe(false);
  });

  it("isRuntimeDependencyUpdate flags three and the prod-dependencies group", () => {
    expect(autoMerge.isRuntimeDependencyUpdate(update({ dependencyName: "three", dependencyGroup: null }))).toBe(true);
    expect(autoMerge.isRuntimeDependencyUpdate(update({ dependencyGroup: "prod-dependencies" }))).toBe(true);
    const [quoted] = autoMerge.parseDependabotUpdates(dependabotMessage({ name: '"three"', group: null }));
    expect(autoMerge.isRuntimeDependencyUpdate(quoted)).toBe(true);

    expect(autoMerge.isRuntimeDependencyUpdate(update())).toBe(false);
    expect(autoMerge.isRuntimeDependencyUpdate(update({ dependencyName: "@types/three" }))).toBe(false);
    expect(autoMerge.isRuntimeDependencyUpdate(update({ dependencyName: "actions/checkout", dependencyGroup: null }))).toBe(false);
    expect(autoMerge.isRuntimeDependencyUpdate(null)).toBe(false);
  });

  it("the runtime exclusions match package.json dependencies and the dependabot.yml group", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { dependencies?: Record<string, string> };
    // A new runtime dependency must be added to RUNTIME_DEPENDENCY_NAMES before it can ship.
    expect([...autoMerge.RUNTIME_DEPENDENCY_NAMES].sort()).toEqual(Object.keys(pkg.dependencies ?? {}).sort());
    expect(autoMerge.RUNTIME_DEPENDENCY_NAMES).toContain("three");
    const dependabot = readRepoFile(".github/dependabot.yml");
    for (const group of autoMerge.RUNTIME_DEPENDENCY_GROUPS) {
      expect(dependabot, group).toMatch(new RegExp(`^ {6}${group}:\\n {8}dependency-type: "production"$`, "m"));
    }
  });

  const REPO = "owner/repo";
  const HEAD = "a".repeat(40);
  const OTHER_SHA = "b".repeat(40);
  const RUN_ID = "4242";

  const greenJobs = (): CiJob[] =>
    autoMerge.REQUIRED_CI_CHECKS.map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
      head_sha: HEAD,
    }));

  it("the required check names match the job names in ci.yml", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    expect(autoMerge.REQUIRED_CI_CHECKS).toHaveLength(3);
    for (const name of autoMerge.REQUIRED_CI_CHECKS) {
      expect(ci, name).toContain(`name: ${name}\n`);
    }
  });

  it("allRequiredCiJobsPassed needs all three CI jobs completed with success on the head commit", () => {
    expect(autoMerge.allRequiredCiJobsPassed(greenJobs(), HEAD)).toBe(true);
    // Other jobs of the run neither help nor hurt.
    expect(
      autoMerge.allRequiredCiJobsPassed(
        [...greenJobs(), { name: "Some Other Job", status: "completed", conclusion: "failure", head_sha: HEAD }],
        HEAD,
      ),
    ).toBe(true);

    expect(autoMerge.allRequiredCiJobsPassed([], HEAD)).toBe(false);
    expect(autoMerge.allRequiredCiJobsPassed(undefined, HEAD)).toBe(false);
    expect(autoMerge.allRequiredCiJobsPassed(greenJobs().slice(0, 2), HEAD)).toBe(false);
    for (const [status, conclusion] of [
      ["completed", "failure"],
      ["completed", "skipped"],
      ["completed", "neutral"],
      ["completed", "cancelled"],
      ["in_progress", null],
      ["queued", null],
    ] as const) {
      const jobs = greenJobs();
      jobs[2] = { ...jobs[2]!, status, conclusion };
      expect(autoMerge.allRequiredCiJobsPassed(jobs, HEAD), `${status}/${conclusion}`).toBe(false);
    }
    // A second, failed job of a required name is ambiguous, so it blocks.
    expect(
      autoMerge.allRequiredCiJobsPassed(
        [...greenJobs(), { ...greenJobs()[0]!, conclusion: "failure" }],
        HEAD,
      ),
    ).toBe(false);
    // Green jobs that ran on a different commit prove nothing about the head.
    const stale = greenJobs();
    stale[1] = { ...stale[1]!, head_sha: OTHER_SHA };
    expect(autoMerge.allRequiredCiJobsPassed(stale, HEAD)).toBe(false);
    expect(autoMerge.allRequiredCiJobsPassed(greenJobs(), OTHER_SHA)).toBe(false);
    expect(autoMerge.allRequiredCiJobsPassed(greenJobs().map(({ head_sha: _sha, ...job }) => job), HEAD)).toBe(false);
    expect(autoMerge.allRequiredCiJobsPassed(greenJobs(), undefined)).toBe(false);
  });

  const commit = (overrides: Partial<PrCommit> = {}): PrCommit => ({
    sha: HEAD,
    author: { login: DEPENDABOT },
    committer: { login: "web-flow" },
    commit: { message: dependabotMessage(MINOR), verification: { verified: true } },
    ...overrides,
  });
  const commitWith = (message: string, sha: string = HEAD): PrCommit =>
    commit({ sha, commit: { message, verification: { verified: true } } });
  const pullRequest = (): PullRequest => ({
    number: 7,
    state: "open",
    draft: false,
    commits: 1,
    changed_files: 2,
    user: { login: DEPENDABOT },
    base: { ref: "main" },
    head: { sha: HEAD, repo: { full_name: REPO } },
  });
  const mergeable = (): MergeInput => ({
    pr: pullRequest(),
    commits: [commit()],
    files: [{ filename: "package.json" }, { filename: "package-lock.json" }],
    jobs: greenJobs(),
    jobsTotalCount: 3,
    repo: REPO,
    headSha: HEAD,
  });

  it("isTrustedDependabotCommit requires bot author, GitHub committer, and a valid signature", () => {
    expect(autoMerge.isTrustedDependabotCommit(commit())).toBe(true);
    expect(autoMerge.isTrustedDependabotCommit(commit({ committer: { login: DEPENDABOT } }))).toBe(true);

    expect(autoMerge.isTrustedDependabotCommit(commit({ author: { login: "mallory" } }))).toBe(false);
    expect(autoMerge.isTrustedDependabotCommit(commit({ author: { login: null } }))).toBe(false);
    // Forged author e-mail: attributed to the bot, but committed and signed by someone else.
    expect(autoMerge.isTrustedDependabotCommit(commit({ committer: { login: "mallory" } }))).toBe(false);
    expect(
      autoMerge.isTrustedDependabotCommit(
        commit({ commit: { message: dependabotMessage(MINOR), verification: { verified: false } } }),
      ),
    ).toBe(false);
    expect(autoMerge.isTrustedDependabotCommit(undefined)).toBe(false);
  });

  it("findMergeBlockers returns nothing for a green minor/patch Dependabot PR", () => {
    expect(autoMerge.findMergeBlockers(mergeable())).toEqual([]);
    // Two commits, each with its own valid metadata, and a GitHub Actions bump.
    const twoCommits = mergeable();
    twoCommits.pr!.commits = 2;
    twoCommits.pr!.changed_files = 1;
    twoCommits.commits = [
      commitWith(dependabotMessage(PATCH), OTHER_SHA),
      commitWith(dependabotMessage({ name: "actions/checkout", group: null })),
    ];
    twoCommits.files = [{ filename: ".github/workflows/ci.yaml" }];
    expect(autoMerge.findMergeBlockers(twoCommits)).toEqual([]);
  });

  it("findMergeBlockers blocks every deviation from the merge contract", () => {
    const cases: [string, (input: MergeInput) => void][] = [
      ["closed PR", (i) => { i.pr!.state = "closed"; }],
      ["draft PR", (i) => { i.pr!.draft = true; }],
      ["unknown draft state", (i) => { i.pr!.draft = undefined; }],
      ["non-main base", (i) => { i.pr!.base = { ref: "release" }; }],
      ["fork head", (i) => { i.pr!.head = { sha: HEAD, repo: { full_name: "fork/repo" } }; }],
      ["deleted head repo", (i) => { i.pr!.head = { sha: HEAD, repo: null }; }],
      ["moved head", (i) => { i.pr!.head = { sha: OTHER_SHA, repo: { full_name: REPO } }; }],
      ["human author", (i) => { i.pr!.user = { login: "octocat" }; }],
      ["missing PR", (i) => { i.pr = undefined; }],
      ["no commits", (i) => { i.commits = []; i.pr!.commits = 0; }],
      ["injected commit", (i) => { i.commits = [commit({ sha: "c".repeat(40) }), commit({ author: { login: "mallory" } })]; i.pr!.commits = 2; }],
      ["commit list without the head", (i) => { i.commits = [commit({ sha: "c".repeat(40) })]; }],
      ["no files", (i) => { i.files = []; i.pr!.changed_files = 0; }],
      ["source file", (i) => { i.files.push({ filename: "src/main.ts" }); i.pr!.changed_files = 3; }],
      ["renamed away from source", (i) => { i.files = [{ filename: ".github/workflows/x.yml", previous_filename: "src/main.ts" }]; i.pr!.changed_files = 1; }],
      ["major update", (i) => { i.commits = [commitWith(dependabotMessage(MAJOR))]; }],
      ["mixed minor + major", (i) => { i.commits = [commitWith(dependabotMessage(MINOR, MAJOR))]; }],
      ["no metadata", (i) => { i.commits = [commitWith("chore: bump")]; }],
      ["failed job", (i) => { i.jobs[1] = { ...i.jobs[1]!, conclusion: "failure" }; }],
      ["missing job", (i) => { i.jobs.pop(); i.jobsTotalCount = 2; }],
      ["no jobs", (i) => { i.jobs = []; i.jobsTotalCount = 0; }],
    ];
    for (const [label, mutate] of cases) {
      const input = mergeable();
      mutate(input);
      expect(autoMerge.findMergeBlockers(input).length, label).toBeGreaterThan(0);
    }
  });

  /** Each case is otherwise mergeable, so the named rule is the only thing stopping the merge. */
  it("findMergeBlockers enforces each fail-closed rule on its own", () => {
    const perCommit = "not every commit lists only verifiable semver-minor/patch updates";
    const runtime = "PR updates a runtime dependency";
    const commitsCut = "PR commit list is incomplete";
    const filesCut = "PR file list is incomplete";
    const jobsCut = "CI job list is incomplete";
    const jobsRed = "not all required CI jobs of the triggering run completed successfully on the head commit";
    const cases: [string, string, (input: MergeInput) => void][] = [
      // A commit without usable metadata must not hide behind a valid one, in either order.
      ["second commit has no metadata", perCommit, (i) => { i.commits = [commitWith(dependabotMessage(MINOR), OTHER_SHA), commitWith("chore: bump")]; i.pr!.commits = 2; }],
      ["first commit has no metadata", perCommit, (i) => { i.commits = [commitWith("chore: bump", OTHER_SHA), commitWith(dependabotMessage(MINOR))]; i.pr!.commits = 2; }],
      ["second commit has an empty metadata block", perCommit, (i) => { i.commits = [commitWith(dependabotMessage(MINOR), OTHER_SHA), commitWith(dependabotMessage())]; i.pr!.commits = 2; }],
      ["second commit is a major bump", perCommit, (i) => { i.commits = [commitWith(dependabotMessage(MINOR), OTHER_SHA), commitWith(dependabotMessage(MAJOR))]; i.pr!.commits = 2; }],
      ["entry with a different first key", perCommit, (i) => { i.commits = [commitWith(dependabotMessage(MINOR, { name: null, type: MAJOR }))]; }],
      ["entry with a different first key hiding a major", perCommit, (i) => { i.commits = [commitWith(dependabotMessage(MINOR, { name: null }, MAJOR))]; }],
      ["entry without an update type", perCommit, (i) => { i.commits = [commitWith(dependabotMessage(MINOR, null))]; }],

      ["three minor bump", runtime, (i) => { i.commits = [commitWith(dependabotMessage({ name: "three", group: null }))]; }],
      ["three patch bump next to a dev bump", runtime, (i) => { i.commits = [commitWith(dependabotMessage(MINOR, { name: "three", type: PATCH }))]; }],
      ["prod-dependencies group", runtime, (i) => { i.commits = [commitWith(dependabotMessage({ name: "some-runtime-lib", group: "prod-dependencies" }))]; }],
      ["runtime bump in an earlier commit", runtime, (i) => { i.commits = [commitWith(dependabotMessage({ name: "three" }), OTHER_SHA), commitWith(dependabotMessage(MINOR))]; i.pr!.commits = 2; }],

      ["commit list shorter than the PR's commit count", commitsCut, (i) => { i.pr!.commits = 2; }],
      ["commit list longer than the PR's commit count", commitsCut, (i) => { i.commits = [commitWith(dependabotMessage(MINOR), OTHER_SHA), commit()]; }],
      ["unknown commit count", commitsCut, (i) => { i.pr!.commits = undefined; }],
      ["commit count as a string", commitsCut, (i) => { i.pr!.commits = "1"; }],
      ["file list shorter than the PR's file count", filesCut, (i) => { i.pr!.changed_files = 3; }],
      ["unknown file count", filesCut, (i) => { i.pr!.changed_files = undefined; }],
      ["job list shorter than the run's job count", jobsCut, (i) => { i.jobsTotalCount = 4; }],
      ["unknown job count", jobsCut, (i) => { i.jobsTotalCount = undefined; }],

      ["required job ran on another commit", jobsRed, (i) => { i.jobs[0] = { ...i.jobs[0]!, head_sha: OTHER_SHA }; }],
      ["required job failed", jobsRed, (i) => { i.jobs[1] = { ...i.jobs[1]!, conclusion: "failure" }; }],
      ["required job still running", jobsRed, (i) => { i.jobs[2] = { ...i.jobs[2]!, status: "in_progress", conclusion: null }; }],
      ["required job replaced by another job", jobsRed, (i) => { i.jobs[2] = { ...i.jobs[2]!, name: "Lint" }; }],
    ];
    for (const [label, expected, mutate] of cases) {
      const input = mergeable();
      mutate(input);
      const blockers = autoMerge.findMergeBlockers(input);
      expect(blockers, label).toHaveLength(1);
      expect(blockers[0], label).toContain(expected);
    }
  });

  // -------------------------------------------------------------------------------------------
  // main(), driven through an injected `gh` so nothing touches the network or merges anything.
  // -------------------------------------------------------------------------------------------

  const ENV = { GITHUB_REPOSITORY: REPO, WORKFLOW_RUN_HEAD_SHA: HEAD, WORKFLOW_RUN_ID: RUN_ID };
  const MERGE_ARGS = ["pr", "merge", "7", "--repo", REPO, "--squash", "--match-head-commit", HEAD];

  interface FakeGhState {
    /** What `GET /pulls?state=open&base=main` lists. */
    candidates: unknown[];
    input: MergeInput;
    /** One element per page of the run's jobs listing. */
    jobPages: unknown[] | undefined;
    mergeError: Error | undefined;
  }

  function runMain(configure: (state: FakeGhState) => void = () => {}, env: Record<string, string | undefined> = ENV) {
    const input = mergeable();
    const state: FakeGhState = {
      candidates: [{ number: 7, user: { login: DEPENDABOT }, head: { sha: HEAD } }],
      input,
      jobPages: undefined,
      mergeError: undefined,
    };
    configure(state);
    const lines = (values: unknown[]): string => values.map((value) => `${JSON.stringify(value)}\n`).join("");
    const api: Record<string, () => string> = {
      [`repos/${REPO}/pulls?state=open&base=main&per_page=100`]: () => lines(state.candidates),
      [`repos/${REPO}/pulls/7`]: () => `${JSON.stringify(state.input.pr)}\n`,
      [`repos/${REPO}/pulls/7/commits?per_page=100`]: () => lines(state.input.commits),
      [`repos/${REPO}/pulls/7/files?per_page=100`]: () => lines(state.input.files),
      [`repos/${REPO}/actions/runs/${RUN_ID}/jobs?per_page=100`]: () =>
        lines(state.jobPages ?? [{ total_count: state.input.jobsTotalCount, jobs: state.input.jobs }]),
    };
    const calls: string[][] = [];
    const logs: string[] = [];
    const deps: MainDeps = {
      runGh(args) {
        calls.push(args);
        if (args[0] === "api") {
          const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
          const respond = api[endpoint];
          // Any endpoint outside the contract (for example commit check-runs) fails the test.
          if (!respond) throw new Error(`unexpected gh api call: ${args.join(" ")}`);
          return respond();
        }
        if (args[0] === "pr" && args[1] === "merge") {
          if (state.mergeError) throw state.mergeError;
          return "";
        }
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
      log(line) {
        logs.push(line);
      },
    };
    const run = (): number => autoMerge.main(env, deps);
    const merges = (): string[][] => calls.filter((args) => args[0] === "pr");
    return { run, calls, logs, merges };
  }

  it("main merges a verified PR immediately, pinned to the head commit, without --auto", () => {
    const { run, calls, logs, merges } = runMain();
    expect(run()).toBe(0);
    expect(merges()).toEqual([MERGE_ARGS]);
    expect(calls.flat()).not.toContain("--auto");
    expect(calls.at(-1)).toEqual(MERGE_ARGS);
    // CI results come from the triggering run's jobs; list calls are paginated.
    expect(calls.map((args) => args.find((arg) => arg.startsWith("repos/")))).toEqual([
      `repos/${REPO}/pulls?state=open&base=main&per_page=100`,
      `repos/${REPO}/pulls/7`,
      `repos/${REPO}/pulls/7/commits?per_page=100`,
      `repos/${REPO}/pulls/7/files?per_page=100`,
      `repos/${REPO}/actions/runs/${RUN_ID}/jobs?per_page=100`,
      undefined,
    ]);
    for (const index of [0, 2, 3, 4]) expect(calls[index], String(index)).toContain("--paginate");
    expect(logs.join("\n")).toContain(`PR #7 squash-merged at ${HEAD}.`);
  });

  it("main never arms deferred auto-merge, even when the direct merge is refused", () => {
    // The old fallback keyed on these refusals; now there is one attempt and the error surfaces.
    for (const stderr of [
      "GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)",
      "Pull request #7 is not mergeable: the base branch policy prohibits the merge.",
      "Head branch was modified. Review and try the merge again.",
    ]) {
      const { run, calls, merges } = runMain((state) => {
        state.mergeError = Object.assign(new Error("gh pr merge failed"), { stderr });
      });
      expect(run, stderr).toThrow("gh pr merge failed");
      expect(merges(), stderr).toEqual([MERGE_ARGS]);
      expect(calls.flat(), stderr).not.toContain("--auto");
    }
    expect("isNothingBlockingAutoMergeError" in autoMerge).toBe(false);
    expect(readRepoFile(".github/scripts/dependabot-auto-merge.mjs")).not.toContain('"--auto"');
  });

  it("main validates its environment before calling gh", () => {
    const bad: [string, Record<string, string | undefined>, string][] = [
      ["no repository", { ...ENV, GITHUB_REPOSITORY: undefined }, "GITHUB_REPOSITORY is missing or malformed"],
      ["repository without owner", { ...ENV, GITHUB_REPOSITORY: "repo" }, "GITHUB_REPOSITORY is missing or malformed"],
      ["repository with a path", { ...ENV, GITHUB_REPOSITORY: "owner/repo/pulls" }, "GITHUB_REPOSITORY is missing or malformed"],
      ["repository with a query", { ...ENV, GITHUB_REPOSITORY: "owner/repo?x=1" }, "GITHUB_REPOSITORY is missing or malformed"],
      ["no head SHA", { ...ENV, WORKFLOW_RUN_HEAD_SHA: undefined }, "WORKFLOW_RUN_HEAD_SHA is missing or not a full commit SHA"],
      ["short head SHA", { ...ENV, WORKFLOW_RUN_HEAD_SHA: "abc1234" }, "WORKFLOW_RUN_HEAD_SHA is missing or not a full commit SHA"],
      ["upper-case head SHA", { ...ENV, WORKFLOW_RUN_HEAD_SHA: "A".repeat(40) }, "WORKFLOW_RUN_HEAD_SHA is missing or not a full commit SHA"],
      ["head SHA with a suffix", { ...ENV, WORKFLOW_RUN_HEAD_SHA: `${HEAD}\n` }, "WORKFLOW_RUN_HEAD_SHA is missing or not a full commit SHA"],
      ["no run id", { ...ENV, WORKFLOW_RUN_ID: undefined }, "WORKFLOW_RUN_ID is missing or not a positive integer"],
      ["empty run id", { ...ENV, WORKFLOW_RUN_ID: "" }, "WORKFLOW_RUN_ID is missing or not a positive integer"],
      ["zero run id", { ...ENV, WORKFLOW_RUN_ID: "0" }, "WORKFLOW_RUN_ID is missing or not a positive integer"],
      ["leading-zero run id", { ...ENV, WORKFLOW_RUN_ID: "042" }, "WORKFLOW_RUN_ID is missing or not a positive integer"],
      ["negative run id", { ...ENV, WORKFLOW_RUN_ID: "-1" }, "WORKFLOW_RUN_ID is missing or not a positive integer"],
      ["fractional run id", { ...ENV, WORKFLOW_RUN_ID: "1.5" }, "WORKFLOW_RUN_ID is missing or not a positive integer"],
      ["run id with a path", { ...ENV, WORKFLOW_RUN_ID: "1/../2" }, "WORKFLOW_RUN_ID is missing or not a positive integer"],
      ["run id with whitespace", { ...ENV, WORKFLOW_RUN_ID: "12\n" }, "WORKFLOW_RUN_ID is missing or not a positive integer"],
    ];
    for (const [label, env, message] of bad) {
      const { run, calls } = runMain(undefined, env);
      expect(run, label).toThrow(message);
      expect(calls, label).toEqual([]);
    }
  });

  it("main merges nothing unless exactly one open PR has the CI head commit", () => {
    const mine = { number: 7, user: { login: DEPENDABOT }, head: { sha: HEAD } };
    const sets: [string, unknown[], number][] = [
      ["no PR at the head", [{ ...mine, head: { sha: OTHER_SHA } }], 0],
      ["no open PRs", [], 0],
      ["two PRs at the head", [mine, { ...mine, number: 8 }], 2],
    ];
    for (const [label, candidates, found] of sets) {
      const { run, calls, logs, merges } = runMain((state) => { state.candidates = candidates; });
      expect(run(), label).toBe(0);
      expect(calls, label).toHaveLength(1); // only the PR listing; nothing else is read or merged
      expect(merges(), label).toEqual([]);
      expect(logs.join("\n"), label).toContain(`Found ${found} open PRs into main at ${HEAD}; exactly 1 is required. Nothing merged.`);
    }
  });

  it("main fails closed on a PR number that is not a positive integer", () => {
    for (const number of [0, -7, 7.5, "7", null, undefined]) {
      const { run, calls, merges } = runMain((state) => {
        state.candidates = [{ number, user: { login: DEPENDABOT }, head: { sha: HEAD } }];
      });
      expect(run, String(number)).toThrow("PR number is not a positive integer");
      expect(calls, String(number)).toHaveLength(1);
      expect(merges(), String(number)).toEqual([]);
    }
    // The detailed PR must be the PR that was resolved from the head commit.
    const mismatch = runMain((state) => { state.input.pr!.number = 8; });
    expect(mismatch.run).toThrow("PR details do not match the resolved PR number");
    expect(mismatch.merges()).toEqual([]);
  });

  it("main leaves a non-Dependabot PR alone without reading anything else", () => {
    const { run, calls, logs, merges } = runMain((state) => {
      state.candidates = [{ number: 7, user: { login: "octocat" }, head: { sha: HEAD } }];
    });
    expect(run()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(merges()).toEqual([]);
    expect(logs.join("\n")).toContain("PR #7 was not opened by dependabot[bot]. Nothing merged.");
  });

  it("main leaves a blocked PR for a human and reports why", () => {
    const blocked: [string, (state: FakeGhState) => void, string][] = [
      ["three bump", (s) => { s.input.commits = [commitWith(dependabotMessage({ name: "three", group: "prod-dependencies" }))]; }, "PR updates a runtime dependency"],
      ["second commit without metadata", (s) => { s.input.commits = [commitWith(dependabotMessage(MINOR), OTHER_SHA), commitWith("chore: bump")]; s.input.pr!.commits = 2; }, "not every commit lists only verifiable semver-minor/patch updates"],
      ["truncated commit list", (s) => { s.input.pr!.commits = 251; }, "PR commit list is incomplete"],
      ["truncated file list", (s) => { s.input.pr!.changed_files = 3001; }, "PR file list is incomplete"],
      ["truncated job list", (s) => { s.input.jobsTotalCount = 101; }, "CI job list is incomplete"],
      ["empty job listing", (s) => { s.jobPages = []; }, "CI job list is incomplete"],
      ["job on another commit", (s) => { s.input.jobs[2] = { ...s.input.jobs[2]!, head_sha: OTHER_SHA }; }, "not all required CI jobs of the triggering run"],
      ["head moved after the listing", (s) => { s.input.pr!.head = { sha: OTHER_SHA, repo: { full_name: REPO } }; }, "PR head moved since the CI run"],
    ];
    for (const [label, configure, reason] of blocked) {
      const { run, logs, merges } = runMain(configure);
      expect(run(), label).toBe(0);
      expect(merges(), label).toEqual([]);
      expect(logs.join("\n"), label).toContain("PR #7 left for human review. Not merged because:");
      expect(logs.join("\n"), label).toContain(reason);
    }
  });

  it("main reads every page of the run's jobs listing", () => {
    const jobs = greenJobs();
    const { run, merges } = runMain((state) => {
      state.jobPages = [
        { total_count: 3, jobs: jobs.slice(0, 2) },
        { total_count: 3, jobs: jobs.slice(2) },
      ];
    });
    expect(run()).toBe(0);
    expect(merges()).toEqual([MERGE_ARGS]);
  });
});

describe("Dependabot governance wiring and wording", () => {
  const workflow = readRepoFile(".github/workflows/dependabot-auto.yml");
  const review = readRepoFile("REVIEW.md");
  const agents = readRepoFile("AGENTS.md");

  it("dependabot-auto.yml passes the triggering run id and holds only the scopes it needs", () => {
    expect(workflow).toContain("WORKFLOW_RUN_ID: ${{ github.event.workflow_run.id }}");
    expect(workflow).toContain("WORKFLOW_RUN_HEAD_SHA: ${{ github.event.workflow_run.head_sha }}");
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    const scopes = [...workflow.matchAll(/^ {6}([a-z-]+): (read|write)\b/gm)].map((m) => `${m[1]}: ${m[2]}`);
    expect(scopes).toEqual(["contents: write", "pull-requests: write", "actions: read"]);
    // The PR ref is never checked out by the job that holds the write token.
    expect(workflow).not.toMatch(/^\s*ref:/m);
  });

  it("the workflow and REVIEW.md document the no-deploy GITHUB_TOKEN merge and the runtime exclusion", () => {
    for (const [name, text] of [["dependabot-auto.yml", workflow], ["REVIEW.md", review]] as const) {
      expect(text, name).toContain("GITHUB_TOKEN");
      expect(text, name).toContain("Deploy to GitHub Pages");
      expect(text, name).toContain("`three`");
      expect(text, name).toContain("`prod-dependencies`");
    }
    expect(review).toContain("--match-head-commit");
  });

  it("REVIEW.md Section 7 and AGENTS.md cross-reference the Section 8 Dependabot carve-out", () => {
    const section7 = review.slice(review.indexOf("## 7. Risk Tiers"), review.indexOf("## 8. CI Review Gate"));
    const tierIntro = section7.split("\n").find((line) => line.startsWith("The **change** sets the tier")) ?? "";
    const highRow = section7.split("\n").find((line) => line.startsWith("| **High**")) ?? "";
    for (const [name, line] of [["tier intro", tierIntro], ["High row", highRow]] as const) {
      expect(line, name).toContain("Section 8");
      expect(line, name).toMatch(/Dependabot carve-out/);
      expect(line, name).toMatch(/minor\/patch/);
      expect(line, name).toMatch(/non-runtime/);
    }
    const approvalRule = agents.split("\n").find((line) => line.includes("High-risk paths")) ?? "";
    expect(approvalRule).toContain("[REVIEW.md](./REVIEW.md) §8");
    expect(approvalRule).toMatch(/minor\/patch/);
    expect(approvalRule).toMatch(/non-runtime/);
    expect(approvalRule).not.toContain("always require explicit human approval");
  });

  it("every mention of the allowed workflow glob names both .yml and .yaml", () => {
    expect(autoMerge.ALLOWED_DEPENDABOT_FILES_TEXT).toBe(
      "package.json, package-lock.json, or .github/workflows/*.yml / .yaml",
    );
    for (const rel of [
      "REVIEW.md",
      "AGENTS.md",
      ".github/scripts/review-gate.mjs",
      ".github/scripts/dependabot-auto-merge.mjs",
      ".github/workflows/dependabot-auto.yml",
    ]) {
      const mentions = readRepoFile(rel).match(/\.github\/workflows\/\*\.yml.{0,12}/g) ?? [];
      for (const mention of mentions) {
        expect(mention, rel).toMatch(/^\.github\/workflows\/\*\.yml`? \/ `?\.yaml/);
      }
    }
    expect(review).toContain("`.github/workflows/*.yml` / `.yaml`");
    expect(agents).toContain("`.github/workflows/*.yml` / `.yaml`");
  });
});

// ---------------------------------------------------------------------------------------------
// review-gate.mjs, run as the real CLI against a throwaway git repository and a synthetic event.
// ---------------------------------------------------------------------------------------------

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const WORKFLOW = "name: CI\non: [push]\npermissions:\n  contents: read\njobs: {}\n";
const BASE_FILES: Record<string, string> = {
  "REVIEW.md":
    "# Review\nWhat Failure Looks Like\nFinding Classification\nSecurity Pass\nConvergence Rules\nRisk Tiers\n",
  "AGENTS.md": "# Agents\nRead REVIEW.md before changing anything.\n",
  "DESIGN.md": "# Design\n",
  "package.json": '{ "name": "fixture", "version": "1.0.0" }\n',
  "package-lock.json": '{ "name": "fixture", "lockfileVersion": 3 }\n',
  ".github/workflows/ci.yml": WORKFLOW,
  // Carries a `permissions:` line so that moving it into .github/workflows/ passes workflow hygiene.
  "src/notes.ts": "// permissions: none of this file is a workflow\nexport const notes = 'porch';\n",
};

const HUMAN_BODY = (tier: string): string =>
  [
    "## Summary",
    "Change things.",
    "## Risk Tier",
    `- [x] **${tier}** — as classified`,
    "## Testing",
    "- [x] `npm run verify`",
    "## How to Revert",
    "`git revert <merge-sha>`",
  ].join("\n");

const DEPENDABOT_BODY = "Bumps [vite](https://github.com/vitejs/vite) from 6.2.6 to 6.2.7.";

interface GateOptions {
  login: string;
  body: string;
  /** Path -> new content, or null to delete the file. */
  changes: Record<string, string | null>;
  baseSha?: string;
}

function runGate({ login, body, changes, baseSha }: GateOptions): { status: number | null; output: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-gate-"));
  tmpRoots.push(root);
  const repo = path.join(root, "repo");
  const write = (rel: string, content: string): void => {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();

  fs.mkdirSync(repo);
  git("init", "--quiet", "--initial-branch=main");
  for (const [rel, content] of Object.entries(BASE_FILES)) write(rel, content);
  git("add", "--all");
  git("commit", "--quiet", "--no-verify", "-m", "base");
  const realBase = git("rev-parse", "HEAD");

  if (Object.keys(changes).length > 0) {
    for (const [rel, content] of Object.entries(changes)) {
      if (content === null) fs.rmSync(path.join(repo, rel));
      else write(rel, content);
    }
    git("add", "--all");
    git("commit", "--quiet", "--no-verify", "-m", "change");
  }

  const eventPath = path.join(root, "event.json");
  fs.writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { user: { login }, body, base: { sha: baseSha ?? realBase } } }),
  );

  const result = spawnSync(process.execPath, [GATE], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const DEPENDENCY_BUMP = {
  "package.json": '{ "name": "fixture", "version": "1.0.1" }\n',
  "package-lock.json": '{ "name": "fixture", "lockfileVersion": 3, "bumped": true }\n',
};

describe("review-gate.mjs Dependabot PR-body exception", { timeout: 30_000 }, () => {
  it("passes a Dependabot dependency/workflow-only PR that has no template sections", () => {
    const { status, output } = runGate({
      login: DEPENDABOT,
      body: DEPENDABOT_BODY,
      changes: { ...DEPENDENCY_BUMP, ".github/workflows/ci.yml": `${WORKFLOW}# bumped action\n` },
    });
    expect(output).toContain("PR body check skipped");
    expect(output).toContain("Risk Tier: High");
    expect(output).toContain("Verdict: PASS");
    expect(status).toBe(0);
  });

  it("fails a Dependabot PR that also touches src/main.ts", () => {
    const { status, output } = runGate({
      login: DEPENDABOT,
      body: DEPENDABOT_BODY,
      changes: { ...DEPENDENCY_BUMP, "src/main.ts": "export const x = 1;\n" },
    });
    expect(output).not.toContain("PR body check skipped");
    expect(output).toContain('missing required "## Risk Tier" section');
    expect(status).toBe(1);
  });

  it("fails a Dependabot PR that moves a source file into the workflows directory", () => {
    const { status, output } = runGate({
      login: DEPENDABOT,
      body: DEPENDABOT_BODY,
      changes: { "src/notes.ts": null, ".github/workflows/notes.yml": BASE_FILES["src/notes.ts"]! },
    });
    expect(output).not.toContain("PR body check skipped");
    expect(status).toBe(1);
  });

  it("does not trim a changed path into an allowed one", () => {
    // "package.json " (trailing space) is a different file from package.json.
    const { status, output } = runGate({
      login: DEPENDABOT,
      body: DEPENDABOT_BODY,
      changes: { ...DEPENDENCY_BUMP, "package.json ": "{}\n" },
    });
    expect(output).not.toContain("PR body check skipped");
    expect(status).toBe(1);
  });

  it("classifies a changed path that git would quote without -z", () => {
    // Without -z, git prints this as "src/caf\303\251.ts" (quoted), which matched no tier rule.
    const { status, output } = runGate({
      login: "octocat",
      body: HUMAN_BODY("Low"),
      changes: { "src/café.ts": "export const x = 1;\n" },
    });
    expect(output).toContain("Risk Tier: Medium");
    expect(output).toContain('declared Risk Tier "Low" is below required "Medium"');
    expect(status).toBe(1);
  });

  it("fails closed for a Dependabot PR with an empty diff", () => {
    const { status, output } = runGate({ login: DEPENDABOT, body: DEPENDABOT_BODY, changes: {} });
    expect(output).not.toContain("PR body check skipped");
    expect(status).toBe(1);
  });

  it("fails closed for a Dependabot PR whose diff cannot be computed", () => {
    const { status, output } = runGate({
      login: DEPENDABOT,
      body: DEPENDABOT_BODY,
      changes: DEPENDENCY_BUMP,
      baseSha: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(output).not.toContain("PR body check skipped");
    expect(output).toContain("failing closed at High risk tier");
    expect(status).toBe(1);
  });

  it("still runs security hygiene checks on an exempted Dependabot PR", () => {
    const { status, output } = runGate({
      login: DEPENDABOT,
      body: DEPENDABOT_BODY,
      changes: { ".github/workflows/ci.yml": "name: CI\non: [push]\njobs: {}\n" },
    });
    expect(output).toContain("PR body check skipped");
    expect(output).toContain("workflow must declare explicit least-privilege permissions:");
    expect(status).toBe(1);
  });

  it("fails a non-Dependabot PR that has no template sections", () => {
    const { status, output } = runGate({ login: "octocat", body: DEPENDABOT_BODY, changes: DEPENDENCY_BUMP });
    expect(output).not.toContain("PR body check skipped");
    for (const section of ["Risk Tier", "Testing", "How to Revert"]) {
      expect(output).toContain(`missing required "## ${section}" section`);
    }
    expect(status).toBe(1);
  });

  it("does not treat a look-alike login as Dependabot", () => {
    const { status, output } = runGate({ login: "dependabot", body: DEPENDABOT_BODY, changes: DEPENDENCY_BUMP });
    expect(output).not.toContain("PR body check skipped");
    expect(status).toBe(1);
  });

  it("passes a non-Dependabot PR whose declared Risk Tier matches the changed paths", () => {
    const { status, output } = runGate({
      login: "octocat",
      body: HUMAN_BODY("Medium"),
      changes: { "src/main.ts": "export const x = 1;\n" },
    });
    expect(output).not.toContain("PR body check skipped");
    expect(output).toContain("Risk Tier: Medium");
    expect(output).toContain("Verdict: PASS");
    expect(status).toBe(0);
  });

  it("fails a non-Dependabot PR that under-declares its Risk Tier", () => {
    const { status, output } = runGate({ login: "octocat", body: HUMAN_BODY("Low"), changes: DEPENDENCY_BUMP });
    expect(output).toContain('declared Risk Tier "Low" is below required "High"');
    expect(status).toBe(1);
  });
});
