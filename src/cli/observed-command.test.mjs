import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { runObservedCommand } from "../../build/src/lib/observed-command.js";
import { captureReviewWorkspaceSnapshot, MAX_UNTRACKED_FILE_BYTES, MAX_UNTRACKED_TOTAL_BYTES, setWorkspaceSnapshotTestHooksForTest } from "../../build/src/lib/review-workspace-snapshot.js";

function gitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-observed-command-"));
  fs.writeFileSync(path.join(root, "tracked.txt"), "clean\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "fixture"], { cwd: root });
  return root;
}

function captured(result) {
  assert.equal(result.observation.status, "captured");
  return result.observation;
}

test("observed command captures a clean canonical Git workspace at process completion", async () => {
  const root = gitFixture();
  const result = await runObservedCommand("printf observed", root);
  const observation = captured(result);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  assert.equal(result.exit_code, 0);
  assert.equal(observation.observed_at_commit, head);
  assert.equal(observation.worktree_clean, true);
  assert.equal(observation.verification_workspace_snapshot.head_sha, head);
  assert.equal(observation.verification_workspace_snapshot.worktree_clean, true);
});

test("observed command marks tracked and untracked workspace changes dirty from its snapshot inputs", async () => {
  const trackedRoot = gitFixture();
  const tracked = captured(await runObservedCommand("printf changed > tracked.txt", trackedRoot));
  assert.equal(tracked.worktree_clean, false);
  assert.equal(tracked.verification_workspace_snapshot.worktree_clean, false);

  const untrackedRoot = gitFixture();
  const untracked = captured(await runObservedCommand("printf new > untracked.txt", untrackedRoot));
  assert.equal(untracked.worktree_clean, false);
  assert.equal(untracked.verification_workspace_snapshot.worktree_clean, false);
});

test("observed command captures the post-command commit rather than the revision present at launch", async () => {
  const root = gitFixture();
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const result = await runObservedCommand("printf committed > tracked.txt && git add tracked.txt && git -c user.email=test@example.invalid -c user.name=Test commit -qm observed", root);
  const observation = captured(result);
  const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  assert.equal(result.exit_code, 0);
  assert.notEqual(after, before);
  assert.equal(observation.observed_at_commit, after);
  assert.equal(observation.verification_workspace_snapshot.head_sha, after);
  assert.equal(observation.worktree_clean, true);
});

test("non-Git and underivable Git state remain explicit, non-confirming observations", async () => {
  const nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-observed-command-non-git-"));
  const nonGit = await runObservedCommand("printf observed", nonGitRoot);
  assert.equal(nonGit.exit_code, 0);
  assert.deepEqual(nonGit.observation, { status: "unavailable", reason: "canonical Git workspace state is unavailable" });

  const brokenGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-observed-command-broken-git-"));
  fs.writeFileSync(path.join(brokenGitRoot, ".git"), "gitdir: missing-worktree\n");
  const brokenGit = await runObservedCommand("printf observed", brokenGitRoot);
  assert.equal(brokenGit.exit_code, 0);
  assert.deepEqual(brokenGit.observation, { status: "unavailable", reason: "canonical Git workspace state could not be captured" });
});

test("canonical snapshots reject index flags that can hide tracked bytes", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const root = gitFixture();
    execFileSync("git", ["update-index", flag, "tracked.txt"], { cwd: root });
    assert.throws(
      () => captureReviewWorkspaceSnapshot(root, []),
      /nonordinary ls-files tag/,
      `${flag} must not produce a confirming snapshot`,
    );
  }
});

test("canonical snapshots impose documented bounded reads for untracked files", () => {
  const root = gitFixture();
  const oversized = path.join(root, "oversized.bin");
  fs.writeFileSync(oversized, Buffer.alloc(MAX_UNTRACKED_FILE_BYTES + 1));
  assert.throws(
    () => captureReviewWorkspaceSnapshot(root, []),
    /per-file limit/,
    "an arbitrary untracked file cannot cause an unbounded synchronous read",
  );
});

test("canonical snapshots enforce the documented aggregate untracked-byte limit", () => {
  const root = gitFixture();
  const fileCount = (MAX_UNTRACKED_TOTAL_BYTES / MAX_UNTRACKED_FILE_BYTES) + 1;
  assert.equal(Number.isInteger(fileCount), true, "the test derives the 64 MiB aggregate limit from the 8 MiB per-file limit");
  for (let index = 0; index < fileCount; index += 1) {
    const descriptor = fs.openSync(path.join(root, `untracked-${String(index).padStart(2, "0")}.bin`), "w");
    try { fs.ftruncateSync(descriptor, MAX_UNTRACKED_FILE_BYTES); } finally { fs.closeSync(descriptor); }
  }
  assert.throws(
    () => captureReviewWorkspaceSnapshot(root, []),
    /total limit/,
    "the snapshot refuses more than the documented 64 MiB aggregate before reading an additional untracked file",
  );
});

test("canonical snapshots reject tracked and untracked mutations after their first input read", () => {
  for (const mutation of [
    { label: "tracked", apply(root) { fs.appendFileSync(path.join(root, "tracked.txt"), "changed\n"); } },
    { label: "untracked", apply(root) { fs.writeFileSync(path.join(root, "arrived.txt"), "new\n"); } },
  ]) {
    const root = gitFixture();
    try {
      setWorkspaceSnapshotTestHooksForTest({ afterInitialInputsRead: () => mutation.apply(root) });
      assert.throws(
        () => captureReviewWorkspaceSnapshot(root, []),
        /workspace inputs changed/,
        `${mutation.label} mutation after the first read must not produce a snapshot`,
      );
    } finally {
      setWorkspaceSnapshotTestHooksForTest(null);
    }
  }
});
