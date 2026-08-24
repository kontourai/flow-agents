// Regression tests for kontourai/flow-agents#1288: `flow-agents init` silently
// overwrote existing destination files whose paths collided with bundle paths
// (README.md being the near-universal casualty), and `workflow doctor`
// recommended exactly that destructive command as a remedy.
//
// End-to-end through the built CLI (mirrors kit-provisioning.test.mjs), asserting
// the issue's proposed contract:
//   (a) a user-authored README.md survives `init` byte-identical and is reported preserved;
//   (b) --dry-run writes nothing (byte-identical tree snapshot before/after);
//   (c) --force overwrites and says so;
//   (d) a file matching a PREVIOUS bundle's owned hash (stale bundle-owned) is
//       updated WITHOUT --force -- the upgrade path;
//   (e) doctor's remediation includes --dry-run, never the bare destructive command.
//
// Run after `npm run build`:
//   node --test src/cli/init-overwrite-guard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "build", "src", "cli.js");

const USER_README = "# MY PROJECT README\n\nUser content that must not be destroyed.\n";

function runInit(dest, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [cli, "init", "--runtime", "base", "--dest", dest, "--telemetry-sink", "local-files", "--yes", ...extraArgs],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

function fixtureDest(label) {
  const dest = makeFixtureDir(`init-guard-${label}-`);
  fs.writeFileSync(path.join(dest, "README.md"), USER_README);
  return dest;
}

/** Map of every rel path (files hashed, symlinks by target, dirs marked) under root. */
function snapshotTree(root) {
  const snapshot = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full);
      if (entry.isSymbolicLink()) snapshot.set(rel, `link:${fs.readlinkSync(full)}`);
      else if (entry.isDirectory()) {
        snapshot.set(rel, "dir");
        walk(full);
      } else snapshot.set(rel, `file:${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
    }
  };
  walk(root);
  return snapshot;
}

function bundleReadme() {
  return fs.readFileSync(path.join(repoRoot, "dist", "base", "README.md"), "utf8");
}

// (a) The issue's Reproduction 1: an ordinary repo must not lose its README.
test("init without --force preserves a user-authored README.md byte-identical and names it in the summary", () => {
  const dest = fixtureDest("preserve");
  const result = runInit(dest);
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(path.join(dest, "README.md"), "utf8"), USER_README);
  assert.match(result.output, /Install summary for /);
  assert.match(result.output, /1 preserved/);
  assert.match(result.output, /preserved: README\.md/);
  // The preserved file must NOT be claimed by the ownership manifest: recording the
  // user's hash as bundle-owned would authorize the NEXT init to overwrite it.
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, ".flow-agents", "owned-files.json"), "utf8"));
  assert.equal(manifest.files.some((entry) => entry.path === "README.md"), false);

  // Second run stays preserved: the guard's decision is stable, not first-run-only.
  const again = runInit(dest);
  assert.equal(again.status, 0, again.output);
  assert.equal(fs.readFileSync(path.join(dest, "README.md"), "utf8"), USER_README);
  assert.match(again.output, /preserved: README\.md/);
});

// (b) --dry-run lists the plan and writes nothing at all in the destination. When dist/ IS
// stale, the one write a dry-run performs (regenerating the package's own dist/) is
// disclosed with an explicit "rebuilt the ... bundle" note (#1288 review MEDIUM-2); the
// note's ABSENCE is asserted here as the process-owned proof that this dry-run did not
// rebuild. dist/ itself is deliberately NOT snapshotted: it is shared mutable state that a
// sibling corpus test legitimately rebuilds in parallel (provider-bootstrap.test.mjs runs
// `build-bundles` unconditionally), so mtime/listing assertions on it encode a
// no-concurrent-builder assumption this corpus does not provide -- the exact class that
// broke CI (PR #1309): the planner used to read dist/ unlocked and walked a half-built
// tree; init now holds the bundle build lock across its whole bundle-reading span, which
// is what `create: install.sh` below actually pins (a mid-rebuild walk enumerated the
// alphabetically-early entries only, without install.sh).
test("init --dry-run lists created/preserved paths and leaves the destination byte-identical", () => {
  const dest = fixtureDest("dry-run");
  fs.mkdirSync(path.join(dest, "docs"));
  fs.writeFileSync(path.join(dest, "docs", "my-design-doc.md"), "not a bundle path\n");
  // First dry-run may legitimately rebuild a stale dist/ (disclosed via the note).
  const warmup = runInit(dest, ["--dry-run"]);
  assert.equal(warmup.status, 0, warmup.output);
  const before = snapshotTree(dest);
  const result = runInit(dest, ["--dry-run"]);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(snapshotTree(dest), before);
  assert.equal(fs.existsSync(path.join(dest, ".flow-agents")), false);
  assert.match(result.output, /Dry run: no files were written\./);
  assert.match(result.output, /create: install\.sh/);
  assert.match(result.output, /preserve \(existing content kept\): README\.md/);
  assert.match(result.output, /Install summary for /);
  // No rebuilt note: this dry-run performed no dist/ write of its own.
  assert.doesNotMatch(result.output, /rebuilt the .* bundle in the package dist\//);
});

// (c) --force overwrites the collision and says so.
test("init --force overwrites a user-authored README.md and reports the overwrite", () => {
  const dest = fixtureDest("force");
  const result = runInit(dest, ["--force"]);
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(path.join(dest, "README.md"), "utf8"), bundleReadme());
  assert.match(result.output, /1 overwritten \(--force\)/);
  assert.match(result.output, /overwrote \(--force\): README\.md/);
});

// (d) Stale bundle-owned content (hash recorded by a previous install's ownership
// manifest) is updated WITHOUT --force: the normal upgrade path must keep working.
test("init updates a stale bundle-owned file without --force (upgrade path)", () => {
  const dest = makeFixtureDir("init-guard-upgrade-");
  const first = runInit(dest);
  assert.equal(first.status, 0, first.output);
  // Simulate a previous bundle version: on-disk content and manifest hash agree with
  // each other but not with the incoming bundle.
  const staleContent = "# Base Bundle\n\ncontent shipped by a previous bundle version\n";
  fs.writeFileSync(path.join(dest, "README.md"), staleContent);
  const manifestPath = path.join(dest, ".flow-agents", "owned-files.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entry = manifest.files.find((candidate) => candidate.path === "README.md");
  assert.ok(entry, "first install must record README.md as bundle-owned");
  entry.sha256 = crypto.createHash("sha256").update(staleContent).digest("hex");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const second = runInit(dest);
  assert.equal(second.status, 0, second.output);
  assert.equal(fs.readFileSync(path.join(dest, "README.md"), "utf8"), bundleReadme());
  assert.match(second.output, /1 replaced \(bundle-owned, stale\)/);
  assert.doesNotMatch(second.output, /preserved: README\.md/);
});

// (e) doctor must not recommend the destructive command bare.
test("workflow doctor's init remediation includes --dry-run", () => {
  const dest = makeFixtureDir("init-guard-doctor-");
  const result = spawnSync(
    process.execPath,
    [cli, "workflow", "doctor", "--project-root", dest, "--artifact-root", path.join(dest, ".kontourai", "flow-agents"), "--json"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const report = JSON.parse(result.stdout);
  assert.match(report.remediation, /'init'/);
  assert.match(report.remediation, /'--dry-run'/);
  const installWarning = report.warnings.find((warning) => warning.includes("No installed hook/bundle version"));
  assert.ok(installWarning, result.stdout);
  assert.match(installWarning, /'--dry-run'/);
});

// Guard rails around the flag surface: --yes alone must never authorize an overwrite, and
// the runtimes whose --global installers already fail closed (codex/opencode) refuse the
// flags loudly rather than ignore them. --global claude-code accepts them (see the
// dedicated global tests below).
test("init --dry-run/--force with --global codex/opencode is refused with a clear error", () => {
  const result = spawnSync(
    process.execPath,
    [cli, "init", "--runtime", "codex", "--global", "--yes", "--dry-run"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /--dry-run and --force are not supported with --global for codex/);
});

// ---------------------------------------------------------------------------
// #1288 review fix round: kiro deletion, global sync, token substitution,
// console-config, TOCTOU, symlinked parents, semantic installer detection,
// special-character excludes.
// ---------------------------------------------------------------------------

function runKiroInit(dest, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [cli, "init", "--runtime", "kiro", "--dest", dest, "--telemetry-sink", "local-files", "--yes", ...extraArgs],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

// BLOCKING-1 + HIGH-1: kiro must not delete unclassified destination files (the old
// `rsync --delete`), and its token substitution must not mutate preserved or non-bundle
// files that merely match a substituted extension.
test("kiro init never deletes unclassified destination files and never token-substitutes preserved/user files", () => {
  const dest = makeFixtureDir("init-guard-kiro-");
  const userApp = "user app with __KIRO_PACKAGE_ROOT__ token inside\n";
  const userReadme = "# user kiro readme with __KIRO_PACKAGE_ROOT__\n";
  fs.mkdirSync(path.join(dest, "src"));
  fs.writeFileSync(path.join(dest, "src", "app.ts"), userApp);
  fs.writeFileSync(path.join(dest, "README.md"), userReadme);
  const result = runKiroInit(dest);
  assert.equal(result.status, 0, result.output);
  // Not deleted (old --delete would have removed src/app.ts) and not token-substituted.
  assert.equal(fs.readFileSync(path.join(dest, "src", "app.ts"), "utf8"), userApp);
  // Preserved collision keeps its token content too (HIGH-1: substitution scoped to
  // bundle-shipped, non-excluded files only).
  assert.equal(fs.readFileSync(path.join(dest, "README.md"), "utf8"), userReadme);
  assert.match(result.output, /preserved: README\.md/);
  // The generated kiro installer must not carry a blanket --delete on its rsync line.
  const installSh = fs.readFileSync(path.join(repoRoot, "dist", "kiro", "install.sh"), "utf8");
  const rsyncLine = installSh.split("\n").find((line) => line.startsWith("rsync "));
  assert.ok(rsyncLine, "kiro install.sh must have an rsync line");
  assert.doesNotMatch(rsyncLine, /--delete/);
});

// Round-3 BLOCKING-1: stale-owned handling is REPORT-ONLY. The writable ownership manifest
// is never deletion authority -- a previously-owned file absent from the bundle is named in
// the summary with a removal suggestion, and NOTHING is deleted (a poisoned or stale
// manifest entry, or a deliberately-restored file with old bytes, must not disappear).
test("kiro init reports stale bundle-owned files without deleting anything", () => {
  const dest = makeFixtureDir("init-guard-kiro-rm-");
  const first = runKiroInit(dest);
  assert.equal(first.status, 0, first.output);
  fs.mkdirSync(path.join(dest, "obsolete"));
  fs.writeFileSync(path.join(dest, "obsolete", "gone.md"), "old bundle file\n");
  fs.writeFileSync(path.join(dest, "obsolete", "edited.md"), "old but user modified\n");
  const manifestPath = path.join(dest, ".flow-agents", "owned-files.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.files.push({
    path: "obsolete/gone.md",
    sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(dest, "obsolete", "gone.md"))).digest("hex"),
  });
  manifest.files.push({ path: "obsolete/edited.md", sha256: "0".repeat(64) });
  // A poisoned traversal entry must be ignored, not honored and not fatal.
  manifest.files.push({ path: "../outside-victim.txt", sha256: "0".repeat(64) });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const second = runKiroInit(dest);
  assert.equal(second.status, 0, second.output);
  // Nothing deleted: the hash-matching stale file is still on disk, only reported.
  assert.equal(fs.readFileSync(path.join(dest, "obsolete", "gone.md"), "utf8"), "old bundle file\n");
  assert.equal(fs.readFileSync(path.join(dest, "obsolete", "edited.md"), "utf8"), "old but user modified\n");
  assert.match(second.output, /stale bundle-owned \(from a previous install; NOT removed\): obsolete\/gone\.md/);
  assert.match(second.output, /1 stale bundle-owned file\(s\) remain from a previous install; remove them with `flow-agents init --uninstall` or manually\./);
  // The modified formerly-owned file is just a user file now: not stale, not touched.
  assert.doesNotMatch(second.output, /obsolete\/edited\.md/);
  assert.doesNotMatch(second.output, /outside-victim/);
});

// BLOCKING-2: --global claude-code sync preserves unowned differing files, reports them,
// keeps them out of the ownership manifest, supports --dry-run (writes nothing) and --force.
test("global claude-code sync preserves a user-authored agents file; --dry-run writes nothing; --force overwrites", () => {
  const dest = makeFixtureDir("init-guard-global-");
  fs.mkdirSync(path.join(dest, "agents"));
  const userAgent = "MY CUSTOM DEV AGENT\n";
  fs.writeFileSync(path.join(dest, "agents", "dev.md"), userAgent);
  const env = { ...process.env, FLOW_AGENTS_USER_CLAUDE_SETTINGS: path.join(dest, "settings.json") };
  const globalArgs = (extra) => [cli, "init", "--runtime", "claude-code", "--global", "--dest", dest, "--yes", ...extra];

  // Dry run first: nothing written at all.
  const before = snapshotTree(dest);
  const dry = spawnSync(process.execPath, globalArgs(["--dry-run"]), { cwd: repoRoot, encoding: "utf8", env });
  assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
  assert.deepEqual(snapshotTree(dest), before);
  assert.match(dry.stdout, /preserve \(existing content kept\): agents\/dev\.md/);
  assert.match(dry.stdout, /settings\.json is merge-owned/);

  // Real run: user agent preserved byte-identical, reported, and NOT claimed by the manifest.
  const run = spawnSync(process.execPath, globalArgs([]), { cwd: repoRoot, encoding: "utf8", env });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(fs.readFileSync(path.join(dest, "agents", "dev.md"), "utf8"), userAgent);
  assert.match(run.stdout, /preserved: agents\/dev\.md/);
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, ".flow-agents", "owned-files.json"), "utf8"));
  assert.equal(manifest.files.some((entry) => entry.path === "agents/dev.md"), false);
  // A bundle-shipped skill landed (the sync still installs non-colliding content).
  assert.equal(manifest.files.some((entry) => entry.path.startsWith("skills/")), true);

  // --force overwrites and says so.
  const forced = spawnSync(process.execPath, globalArgs(["--force"]), { cwd: repoRoot, encoding: "utf8", env });
  assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
  assert.notEqual(fs.readFileSync(path.join(dest, "agents", "dev.md"), "utf8"), userAgent);
  assert.match(forced.stdout, /overwrote \(--force\): agents\/dev\.md/);
});

// HIGH-2: a preserved (user-modified) telemetry.conf must not be rewritten by
// install-console-config.sh, and the skip is disclosed.
test("preserved telemetry.conf is not rewritten by console config and the skip is disclosed", () => {
  const dest = makeFixtureDir("init-guard-conf-");
  fs.mkdirSync(path.join(dest, "scripts", "telemetry"), { recursive: true });
  const userConf = "# user-managed telemetry conf\n";
  fs.writeFileSync(path.join(dest, "scripts", "telemetry", "telemetry.conf"), userConf);
  const result = runInit(dest);
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(path.join(dest, "scripts", "telemetry", "telemetry.conf"), "utf8"), userConf);
  assert.match(result.output, /skipping Console telemetry configuration/);
  assert.match(result.output, /preserved: scripts\/telemetry\/telemetry\.conf/);
});

// HIGH-4: a bundle path whose destination parent directory is a symlink refuses the whole
// install before any write -- children classified through the link are not what rsync
// would actually touch.
test("init refuses when a destination parent directory is a symlink, before any write", () => {
  const dest = makeFixtureDir("init-guard-symlink-");
  const outside = makeFixtureDir("init-guard-symlink-outside-");
  fs.symlinkSync(outside, path.join(dest, "docs"), "dir");
  const before = snapshotTree(dest);
  const result = runInit(dest);
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /refusing to install through symlinked destination directories: docs/);
  assert.deepEqual(snapshotTree(dest), before);
  assert.deepEqual(fs.readdirSync(outside), []);
});

// HIGH-3: the plan is revalidated against the disk immediately before install; any
// classification drift refuses with the drifted paths named.
test("verifyInstallPlanMatchesDisk refuses when a planned file changes after classification", async () => {
  const { computeInstallPlan, verifyInstallPlanMatchesDisk, InstallPlanDriftError } =
    await import("../../build/src/cli/install-plan.js");
  const bundleDir = makeFixtureDir("init-guard-toctou-src-");
  const dest = makeFixtureDir("init-guard-toctou-dest-");
  fs.writeFileSync(path.join(bundleDir, "a.md"), "bundle a\n");
  fs.writeFileSync(path.join(bundleDir, "b.md"), "bundle b\n");
  const params = {
    mappings: [{ sourceDir: bundleDir, destDir: dest, prefix: "" }],
    manifestDest: dest,
    excludeRel: new Set(),
    force: false,
    reportStaleOwned: true,
    refuseSymlinkParents: true,
  };
  const plan = computeInstallPlan(params);
  assert.deepEqual(plan.created.sort(), ["a.md", "b.md"]);
  // Race simulation: a user file appears at a planned "create" path after classification.
  fs.writeFileSync(path.join(dest, "a.md"), "user content that arrived in the window\n");
  assert.throws(
    () => verifyInstallPlanMatchesDisk(plan, params),
    (error) => error instanceof InstallPlanDriftError && /a\.md/.test(error.message),
  );
  // An unchanged disk revalidates cleanly.
  fs.rmSync(path.join(dest, "a.md"));
  verifyInstallPlanMatchesDisk(plan, params);
});

// MEDIUM-1: stale-installer detection is semantic. An installer that parses
// --exclude-path but drops the exclude-args expansion from its rsync line -- or still
// carries the pre-guard --delete -- must be treated as stale and rebuilt.
test("installerSupportsPreserveExcludes requires the rsync line to enforce excludes (and no --delete)", async () => {
  const { installerSupportsPreserveExcludes } = await import("../../build/src/cli/install-plan.js");
  const real = fs.readFileSync(path.join(repoRoot, "dist", "base", "install.sh"), "utf8");
  assert.equal(installerSupportsPreserveExcludes(real), true, "generated installer must satisfy its own detector");
  // The reviewer's exact scenario: '--exclude-path' substring present (parser kept),
  // expansion dropped from the rsync invocation.
  const droppedExpansion = real
    .split("\n")
    .map((line) => (line.startsWith("rsync ") ? line.replace(' ${EXCLUDE_ARGS[@]+"${EXCLUDE_ARGS[@]}"}', "") : line))
    .join("\n");
  assert.notEqual(droppedExpansion, real, "fixture must actually strip the expansion");
  assert.ok(droppedExpansion.includes("--exclude-path"), "fixture keeps the parsed option");
  assert.equal(installerSupportsPreserveExcludes(droppedExpansion), false);
  // A pre-BLOCKING-1 kiro-style installer with --delete on the rsync line is stale too.
  const withDelete = real
    .split("\n")
    .map((line) => (line.startsWith("rsync ") ? line.replace("rsync -a ", "rsync -a --delete ") : line))
    .join("\n");
  assert.equal(installerSupportsPreserveExcludes(withDelete), false);
  // An installer without the --only-absent (--ignore-existing) expansion predates the
  // never-overwrite copy layer and is stale.
  const droppedIgnoreExisting = real
    .split("\n")
    .map((line) => (line.startsWith("rsync ") ? line.replace(' ${IGNORE_EXISTING_ARGS[@]+"${IGNORE_EXISTING_ARGS[@]}"}', "") : line))
    .join("\n");
  assert.notEqual(droppedIgnoreExisting, real, "fixture must actually strip the ignore-existing expansion");
  assert.equal(installerSupportsPreserveExcludes(droppedIgnoreExisting), false);
});

// Special-character exclude paths: install.sh escapes rsync wildcard characters itself, so
// a literal bracketed filename round-trips as an exclusion (driven end-to-end through the
// real generated installer against a minimal fixture bundle).
test("install.sh --exclude-path treats rsync wildcard characters literally", () => {
  const fixtureBundle = makeFixtureDir("init-guard-esc-bundle-");
  const dest = makeFixtureDir("init-guard-esc-dest-");
  fs.copyFileSync(path.join(repoRoot, "dist", "base", "install.sh"), path.join(fixtureBundle, "install.sh"));
  fs.writeFileSync(path.join(fixtureBundle, "AGENTS.md"), "agents\n");
  fs.writeFileSync(path.join(fixtureBundle, "CLAUDE.md"), "claude\n");
  fs.writeFileSync(path.join(fixtureBundle, "sp[1].md"), "special bundle file\n");
  fs.writeFileSync(path.join(fixtureBundle, "plain.md"), "plain bundle file\n");
  fs.writeFileSync(path.join(dest, "sp[1].md"), "user special file\n");
  const result = spawnSync("bash", ["install.sh", dest, "--exclude-path", "sp[1].md"], {
    cwd: fixtureBundle,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(path.join(dest, "sp[1].md"), "utf8"), "user special file\n");
  assert.equal(fs.readFileSync(path.join(dest, "plain.md"), "utf8"), "plain bundle file\n");
});

// Round-3 HIGH-2: an unparseable existing settings.json refuses the --global install
// (merging over it would replace possibly-recoverable user content with managed-only
// settings). --force does not override a parse failure, and nothing is written.
test("global claude-code refuses over invalid existing settings JSON, even with --force", () => {
  const dest = makeFixtureDir("init-guard-badjson-");
  fs.writeFileSync(path.join(dest, "settings.json"), "{ this is not json\n");
  const before = snapshotTree(dest);
  for (const extra of [[], ["--force"]]) {
    const result = spawnSync(
      process.execPath,
      [cli, "init", "--runtime", "claude-code", "--global", "--dest", dest, "--yes", ...extra],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, FLOW_AGENTS_USER_CLAUDE_SETTINGS: path.join(dest, "settings.json") } },
    );
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /not valid JSON/);
    assert.match(result.stderr, /--force does not override a parse failure/);
    assert.ok(result.stderr.includes(path.join(dest, "settings.json")), result.stderr);
  }
  assert.deepEqual(snapshotTree(dest), before);
});

// Round-3 HIGH-1: write-time enforcement in the Node executor. A planned "create" that
// loses the exclusive-create race is left as found and reported; a planned "replace" whose
// destination bytes changed after planning aborts naming the path.
test("executePlanCopies enforces exclusive creates and re-hash-before-rename replaces", async () => {
  const { computeInstallPlan, executePlanCopies, InstallPlanDriftError } =
    await import("../../build/src/cli/install-plan.js");
  const bundleDir = makeFixtureDir("init-guard-exec-src-");
  const dest = makeFixtureDir("init-guard-exec-dest-");
  fs.writeFileSync(path.join(bundleDir, "new.md"), "bundle new\n");
  fs.writeFileSync(path.join(bundleDir, "owned.md"), "bundle owned v2\n");
  // Seed a stale bundle-owned file recorded by a previous install's manifest.
  fs.writeFileSync(path.join(dest, "owned.md"), "bundle owned v1\n");
  fs.mkdirSync(path.join(dest, ".flow-agents"), { recursive: true });
  fs.writeFileSync(path.join(dest, ".flow-agents", "owned-files.json"), JSON.stringify({
    schema_version: "1.0",
    files: [{ path: "owned.md", sha256: crypto.createHash("sha256").update("bundle owned v1\n").digest("hex") }],
  }));
  const params = {
    mappings: [{ sourceDir: bundleDir, destDir: dest, prefix: "" }],
    manifestDest: dest,
    excludeRel: new Set(),
    force: false,
    reportStaleOwned: false,
    refuseSymlinkParents: true,
  };
  const plan = computeInstallPlan(params);
  assert.deepEqual(plan.created, ["new.md"]);
  assert.deepEqual(plan.replaced, ["owned.md"]);

  // Race 1: a file appears at the planned create path -> left as found, reported.
  fs.writeFileSync(path.join(dest, "new.md"), "raced user content\n");
  // Race 2: the replace target's bytes change after planning -> abort naming the path.
  fs.writeFileSync(path.join(dest, "owned.md"), "user edited in the window\n");
  assert.throws(
    () => executePlanCopies(plan),
    (error) => error instanceof InstallPlanDriftError && /owned\.md/.test(error.message),
  );
  assert.equal(fs.readFileSync(path.join(dest, "owned.md"), "utf8"), "user edited in the window\n");
  assert.equal(fs.readFileSync(path.join(dest, "new.md"), "utf8"), "raced user content\n");

  // With the replace target restored to its planned bytes, the create race alone is
  // absorbed: reported in racedPaths, file untouched, replace applied.
  fs.writeFileSync(path.join(dest, "owned.md"), "bundle owned v1\n");
  const executed = executePlanCopies(plan);
  assert.deepEqual(executed.racedPaths, ["new.md"]);
  assert.equal(fs.readFileSync(path.join(dest, "new.md"), "utf8"), "raced user content\n");
  assert.equal(fs.readFileSync(path.join(dest, "owned.md"), "utf8"), "bundle owned v2\n");
});

// Round-3 HIGH-1 (rsync leg): under --only-absent the generated installer's rsync runs with
// --ignore-existing, so the copy layer cannot overwrite ANY existing destination file --
// including one that appeared after planning (planned as "create").
test("install.sh --only-absent never overwrites an existing destination file", () => {
  const fixtureBundle = makeFixtureDir("init-guard-oa-bundle-");
  const dest = makeFixtureDir("init-guard-oa-dest-");
  fs.copyFileSync(path.join(repoRoot, "dist", "base", "install.sh"), path.join(fixtureBundle, "install.sh"));
  fs.writeFileSync(path.join(fixtureBundle, "AGENTS.md"), "agents\n");
  fs.writeFileSync(path.join(fixtureBundle, "CLAUDE.md"), "claude\n");
  fs.writeFileSync(path.join(fixtureBundle, "appeared.md"), "bundle content\n");
  fs.writeFileSync(path.join(fixtureBundle, "fresh.md"), "bundle fresh\n");
  // Simulates the post-revalidation window: the file exists by the time rsync runs.
  fs.writeFileSync(path.join(dest, "appeared.md"), "raced user content\n");
  const result = spawnSync("bash", ["install.sh", dest, "--only-absent"], {
    cwd: fixtureBundle,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(path.join(dest, "appeared.md"), "utf8"), "raced user content\n");
  assert.equal(fs.readFileSync(path.join(dest, "fresh.md"), "utf8"), "bundle fresh\n");
});

// Round-4 FIX-5: the rsync leg is guarded redundantly (--only-absent AND the preserve
// excludes), so an end-to-end test cannot see one layer vanish while the other holds.
// These two argv-level tests each pin ONE layer independently.
test("installBundleArgs always carries --only-absent (never-overwrite layer, independent of excludes)", async () => {
  const { installBundleArgs } = await import("../../build/src/cli/init.js");
  const args = installBundleArgs({ dest: "/tmp/x", telemetrySinks: ["local-files"] }, []);
  assert.ok(args.includes("--only-absent"), `argv must carry --only-absent: ${JSON.stringify(args)}`);
});

test("installBundleArgs passes each preserved path as --exclude-path (independent of --only-absent)", async () => {
  const { installBundleArgs } = await import("../../build/src/cli/init.js");
  const args = installBundleArgs({ dest: "/tmp/x", telemetrySinks: ["local-files"] }, ["README.md", "docs/user file.md"]);
  const pairs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--exclude-path") pairs.push(args[index + 1]);
  }
  assert.deepEqual(pairs, ["README.md", "docs/user file.md"]);
});

// Round-4 FIX-3: manifest entries are OVERWRITE authority ("replace" without --force), so
// admission filters shape and containment. A valid-shaped but traversal-styled or
// out-of-tree entry must never grant authority over a colliding user file. (Today a
// non-normalized key also fails the exact-match lookup, so this test additionally pins the
// contract against any future path normalization at the lookup site.)
test("poisoned valid-shaped manifest entries never make a user file replaceable", async () => {
  const { computeInstallPlan } = await import("../../build/src/cli/install-plan.js");
  const bundleDir = makeFixtureDir("init-guard-poison-src-");
  const dest = makeFixtureDir("init-guard-poison-dest-");
  fs.writeFileSync(path.join(bundleDir, "README.md"), "bundle readme\n");
  const userReadme = "user readme that must stay preserved\n";
  fs.writeFileSync(path.join(dest, "README.md"), userReadme);
  const userHash = crypto.createHash("sha256").update(userReadme).digest("hex");
  fs.mkdirSync(path.join(dest, ".flow-agents"), { recursive: true });
  fs.writeFileSync(path.join(dest, ".flow-agents", "owned-files.json"), JSON.stringify({
    schema_version: "1.0",
    files: [
      // Valid-shaped, traversal-styled entries carrying the USER file's hash.
      { path: "docs/../README.md", sha256: userHash },
      { path: "./README.md", sha256: userHash },
      { path: "/etc/README.md", sha256: userHash },
      { path: "..\\README.md", sha256: userHash },
    ],
  }));
  const plan = computeInstallPlan({
    mappings: [{ sourceDir: bundleDir, destDir: dest, prefix: "" }],
    manifestDest: dest,
    excludeRel: new Set(),
    force: false,
    reportStaleOwned: true,
    refuseSymlinkParents: true,
  });
  assert.deepEqual(plan.replaced, [], "no poisoned entry may grant replace authority");
  assert.deepEqual(plan.preserved, ["README.md"]);
  assert.deepEqual(plan.staleOwned, [], "poisoned entries must not surface as stale either");
});
