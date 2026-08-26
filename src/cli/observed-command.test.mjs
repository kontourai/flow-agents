import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

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
// successful command against a process group whose leader has just died. EPERM used to rethrow
// there, rejecting the whole observation of a command that ran fine.
//
// TWO CLAIMS THAT STOOD HERE WERE WRONG AND ARE CORRECTED RATHER THAN QUIETLY DROPPED:
//   - "macOS returns EPERM (not ESRCH)" — measured, ESRCH is overwhelmingly what comes back;
//     EPERM is the rare case (see the measurement table in observed-command.ts).
//   - "between the liveness check and the signal" — there is no liveness check; the only guard
//     is `child.pid` being truthy.
// Both were corrected in the source comment in an earlier round and the correction did not reach
// this file, which is its own small lesson about fixing a claim in one place only.
//
// A THIRD claim here was FALSE and is now retired: this header used to say a real EPERM "needs a
// process group owned by another uid, which is not available here". It does not. Real EPERM is
// reproducible at the same uid with no privilege change — 2 in 800 teardowns (2 of 8 concurrent
// workers) once the process group has more than one member. It is simply too rare to assert on
// deterministically, which is the actual reason these cases inject the errno rather than race for
// it. To stop the stub silently not firing (a test that passes for the wrong reason), each case
// asserts the stub was invoked, only ever with a negative pid, and that the thrown value carried
// the errno under test.
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

test("a command that exits cleanly is NOT failed because something outside its group holds the pipe", async () => {
  // ROUND-3 BLOCKER, as a regression test. The bounded settle added in round 2 fired from BOTH
  // beginCleanup entry paths, so a command that exited 0 immediately while an out-of-group
  // process kept its inherited stdout was REJECTED at killGraceMs — blaming a timeout that never
  // happened. Measured against origin/main on this exact shape: main RESOLVED exit_code=0 at
  // 8168ms; round 2 REJECTED at 5074ms.
  //
  // Real ESRCH, no stubs. `os.setsid()` is used because macOS ships no `setsid(1)` — the first
  // version of this probe silently did nothing for that reason and "passed".
  const python = spawnSync("python3", ["-c", "import os; print(os.getpid())"], { encoding: "utf8" });
  assert.equal(python.status, 0, "python3 is required to create an out-of-group stream holder; without it this test proves nothing");

  const root = gitFixture();
  const previousGrace = process.env.FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS;
  process.env.FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS = "300";
  const holdSeconds = 2;
  const command = [
    "python3 -c '",
    "import os,sys,time",
    "pid = os.fork()",
    "if pid == 0:",
    "    os.setsid()",
    `    time.sleep(${holdSeconds})`,
    "    os._exit(0)",
    'print("started"); sys.stdout.flush()',
    "'",
    "exit 0",
  ].join("\n");
  try {
    const started = Date.now();
    const result = await runObservedCommand(command, root);
    const elapsed = Date.now() - started;
    assert.equal(result.exit_code, 0, "the command exited 0 and must be observed as such");
    // It must have WAITED for the holder rather than settling at the grace budget: proof the
    // bounded settle did not fire on this path.
    assert.ok(elapsed > holdSeconds * 1000 * 0.8, `resolved in ${elapsed}ms, before the out-of-group holder released the pipe — the exit path was bounded when it must not be`);
  } finally {
    if (previousGrace) process.env.FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS = previousGrace;
    else delete process.env.FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS;
  }
});
