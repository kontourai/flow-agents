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
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `init-guard-${label}-`));
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

// (b) --dry-run lists the plan and writes nothing at all.
test("init --dry-run lists created/preserved paths and leaves the destination byte-identical", () => {
  const dest = fixtureDest("dry-run");
  fs.mkdirSync(path.join(dest, "docs"));
  fs.writeFileSync(path.join(dest, "docs", "my-design-doc.md"), "not a bundle path\n");
  const before = snapshotTree(dest);
  const result = runInit(dest, ["--dry-run"]);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(snapshotTree(dest), before);
  assert.equal(fs.existsSync(path.join(dest, ".flow-agents")), false);
  assert.match(result.output, /Dry run: no files were written\./);
  assert.match(result.output, /create: install\.sh/);
  assert.match(result.output, /preserve \(existing content kept\): README\.md/);
  assert.match(result.output, /Install summary for /);
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
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "init-guard-upgrade-"));
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
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "init-guard-doctor-"));
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

// Guard rails around the flag surface: --yes alone must never authorize an overwrite,
// and the unsupported --global combination is refused loudly rather than ignored.
test("init --dry-run/--force with --global is refused with a clear error", () => {
  const result = spawnSync(
    process.execPath,
    [cli, "init", "--runtime", "claude-code", "--global", "--yes", "--dry-run"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, FLOW_AGENTS_USER_CLAUDE_SETTINGS: path.join(os.tmpdir(), "nonexistent-settings.json") } },
  );
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /--dry-run and --force are not supported with --global/);
});
