import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { runObservedCommand } from "../../build/src/lib/observed-command.js";
import { captureReviewWorkspaceSnapshot, MAX_UNTRACKED_FILE_BYTES, MAX_UNTRACKED_TOTAL_BYTES, setWorkspaceSnapshotTestHooksForTest } from "../../build/src/lib/review-workspace-snapshot.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

function gitFixture() {
  const root = makeFixtureDir("flow-agents-observed-command-");
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
  const nonGitRoot = makeFixtureDir("flow-agents-observed-command-non-git-");
  const nonGit = await runObservedCommand("printf observed", nonGitRoot);
  assert.equal(nonGit.exit_code, 0);
  assert.deepEqual(nonGit.observation, { status: "unavailable", reason: "canonical Git workspace state is unavailable" });

  const brokenGitRoot = makeFixtureDir("flow-agents-observed-command-broken-git-");
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

// ── #1369: teardown-race errnos must not abandon a completed observation ──────────────────────
//
// beginCleanup runs from the child's OWN `exit` event, so terminateProcessGroup fires on every
// successful command against a process group whose leader has just died. macOS returns EPERM
// (not ESRCH) for `kill(-pid, sig)` when the leader exits between the liveness check and the
// signal, and EPERM used to rethrow — rejecting the whole observation of a command that ran fine.
//
// The errno is injected by stubbing process.kill, and that is DISCLOSED as the limit of this
// test: a real EPERM needs a process group owned by another uid, which is not available here. To
// stop the stub silently not firing (a test that passes for the wrong reason), each case asserts
// the stub was actually invoked with the negative pid AND that the value thrown carried the errno
// under test.
function withKillErrno(code, body) {
  const realKill = process.kill.bind(process);
  const calls = [];
  process.kill = (pid, signal) => {
    if (typeof pid === "number" && pid < 0) {
      calls.push({ pid, signal });
      const error = new Error(`kill ${code}`);
      error.errno = -1;
      error.code = code;
      error.syscall = "kill";
      throw error;
    }
    return realKill(pid, signal);
  };
  return body().finally(() => { process.kill = realKill; }).then((value) => ({ value, calls }));
}

for (const code of ["EPERM", "ESRCH"]) {
  test(`observed command survives a ${code} process-group teardown race and still reports the command's real result`, async () => {
    const root = gitFixture();
    const { value: result, calls } = await withKillErrno(code, () => runObservedCommand("printf observed-1369", root));

    // The stub must have fired on the GROUP kill, or this test proves nothing about the catch.
    assert.ok(calls.length > 0, `process.kill was never called with a negative pid — the ${code} injection did not reach terminateProcessGroup`);
    assert.ok(calls.every((call) => call.pid < 0), "the injection must target the process group, not a bare pid");
    // PINS false-vs-true, LOGICALLY rather than by timing. Round-2 review showed that returning
    // `true` here is 11/11 green: the only observable difference was the test taking killGraceMs
    // (230ms -> 5231ms) and nothing asserted on it. `false` means "already gone, finish now" and
    // must skip the SIGKILL escalation, so exactly one signal is attempted; `true` arms the grace
    // timer and produces a second call.
    assert.equal(calls.length, 1, `a ${code} teardown must not escalate to SIGKILL — got ${calls.map((call) => call.signal).join(", ")}`);

    // The observation is completed, not abandoned: real exit code and real captured output.
    assert.equal(result.exit_code, 0, `a ${code} teardown race must not change the observed exit code`);
    const observation = captured(result);
    assert.equal(observation.worktree_clean, true);
    assert.match(result.output ?? observation.output ?? "", /observed-1369/, "the command's captured output must survive the teardown race");
  });
}

test("an errno the teardown does not understand still fails loudly", async () => {
  // The fix must not become a blanket catch. EINVAL is not a teardown race and must still reject.
  const root = gitFixture();
  await assert.rejects(
    withKillErrno("EINVAL", () => runObservedCommand("printf observed-1369", root)),
    (error) => /EINVAL/.test(String(error?.message ?? error)),
    "an unrecognised kill errno must still surface rather than be swallowed",
  );
});

test("a timeout against an unsignalable process group settles instead of hanging forever", async () => {
  // Round-2 review: widening the errno list without this converts a loud 400ms rejection into a
  // SILENT UNBOUNDED WAIT on the timeout path — the one mechanism bounding a runaway evidence
  // command. `complete()` requires streamsClosed, which is false while the child still runs, so
  // `cleanupComplete = true` can never settle the promise and nothing else was armed.
  //
  // Asserted for BOTH errnos: the hang already existed for ESRCH pre-fix, so this closes that too
  // rather than only restoring parity for EPERM.
  for (const code of ["EPERM", "ESRCH"]) {
    const root = gitFixture();
    const previousTimeout = process.env.FLOW_AGENTS_EVIDENCE_COMMAND_TIMEOUT_MS;
    const previousGrace = process.env.FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS;
    process.env.FLOW_AGENTS_EVIDENCE_COMMAND_TIMEOUT_MS = "300";
    process.env.FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS = "300";
    try {
      const started = Date.now();
      await assert.rejects(
        withKillErrno(code, () => runObservedCommand("sleep 25", root)),
        (error) => /could not be signalled/.test(String(error?.message ?? error)),
        `a ${code} timeout must settle with a typed refusal, not hang`,
      );
      // Bounded, and bounded by the CONFIGURED budget rather than by luck.
      assert.ok(Date.now() - started < 5000, `settling took ${Date.now() - started}ms — the bound is not the configured timeout + grace`);
    } finally {
      process.env.FLOW_AGENTS_EVIDENCE_COMMAND_TIMEOUT_MS = previousTimeout ?? "";
      process.env.FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS = previousGrace ?? "";
      if (!previousTimeout) delete process.env.FLOW_AGENTS_EVIDENCE_COMMAND_TIMEOUT_MS;
      if (!previousGrace) delete process.env.FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS;
    }
  }
});
