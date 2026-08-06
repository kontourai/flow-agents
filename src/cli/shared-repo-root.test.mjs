import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { resolveSharedRepoRoot } from "../../build/src/lib/local-artifact-root.js";

// #1055: `resolveSharedRepoRoot` used `path.dirname(--git-common-dir)`, which strips exactly one
// segment. Correct for `<repo>/.git`; wrong inside a submodule, where the common dir is
// `<super>/.git/modules/<name>` and one segment lands on `<super>/.git/modules` — git internals,
// no working tree, nothing that reads `.kontourai/`. Silently, because resolution *succeeded*, so
// the fail-open warning never fires.
//
// These build real git topologies rather than simulating paths: the bug is about what git actually
// reports, and a fixture that fakes the path shape would assert the assumption instead of the
// behaviour.

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function topology() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-shared-root-")));
  const inner = path.join(root, "inner");
  const superRepo = path.join(root, "super");
  for (const dir of [inner, superRepo]) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t.local");
    git(dir, "config", "user.name", "t");
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  }
  git(superRepo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub");
  git(superRepo, "commit", "-q", "-m", "add submodule");

  const superLinked = path.join(root, "super-linked");
  git(superRepo, "worktree", "add", "-q", superLinked, "-b", "superwt");
  const submodule = path.join(superRepo, "sub");
  const subLinked = path.join(root, "sub-linked");
  git(submodule, "worktree", "add", "-q", subLinked, "-b", "subwt");

  const subdir = path.join(superRepo, "deep", "nested");
  fs.mkdirSync(subdir, { recursive: true });
  return { root, superRepo, superLinked, submodule, subLinked, subdir };
}

test("#1055: a submodule anchors on its own working tree, not the superproject's git internals", (t) => {
  let topo;
  try { topo = topology(); } catch { return t.skip("git submodule fixture unavailable"); }
  const resolved = resolveSharedRepoRoot(topo.submodule);
  assert.equal(resolved, topo.submodule, "a submodule's shared root is the submodule working tree");
  assert.doesNotMatch(resolved ?? "", /\.git[/\\]modules/, "must never anchor inside .git/modules");
});

test("#1055: a linked worktree OF a submodule anchors on that submodule, not on itself", (t) => {
  let topo;
  try { topo = topology(); } catch { return t.skip("git submodule fixture unavailable"); }
  const resolved = resolveSharedRepoRoot(topo.subLinked);
  assert.equal(resolved, topo.submodule, "every worktree of a repo must agree on one shared root");
  assert.doesNotMatch(resolved ?? "", /\.git[/\\]modules/);
});

test("#1055: the pre-existing topologies are unchanged", (t) => {
  let topo;
  try { topo = topology(); } catch { return t.skip("git fixture unavailable"); }
  // These are what #357 established and what the anchoring eval covers. The submodule fix must not
  // move any of them.
  assert.equal(resolveSharedRepoRoot(topo.superRepo), topo.superRepo, "primary checkout");
  assert.equal(resolveSharedRepoRoot(topo.subdir), topo.superRepo, "subdirectory resolves to repo root");
  assert.equal(resolveSharedRepoRoot(topo.superLinked), topo.superRepo, "linked worktree resolves to the primary");
});

test("#1055: every worktree of one repository agrees on a single shared root", (t) => {
  let topo;
  try { topo = topology(); } catch { return t.skip("git fixture unavailable"); }
  // The property the whole resolver exists for, stated directly rather than as five separate
  // expected values: members of a repo agree, and the two repos do not collide.
  const superFamily = [topo.superRepo, topo.subdir, topo.superLinked].map(resolveSharedRepoRoot);
  const subFamily = [topo.submodule, topo.subLinked].map(resolveSharedRepoRoot);
  assert.equal(new Set(superFamily).size, 1, `superproject worktrees disagree: ${JSON.stringify(superFamily)}`);
  assert.equal(new Set(subFamily).size, 1, `submodule worktrees disagree: ${JSON.stringify(subFamily)}`);
  assert.notEqual(superFamily[0], subFamily[0], "a submodule must not share the superproject's store");
});

test("#1055: a non-git directory still resolves to null, so callers still fail open", (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-nongit-"));
  assert.equal(resolveSharedRepoRoot(scratch), null);
  assert.equal(resolveSharedRepoRoot("/definitely/does/not/exist"), null);
});
