import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { composeGateVerdict, externalCritiqueAuthorityForGate, inferExecutedTestCount, isMeaningfulTestCommand, liveCritiqueFreshnessSatisfied, observedExecutedTestCount, testExecutionProof } from "../../build/src/cli/workflow-sidecar.js";
import * as workflowSidecar from "../../build/src/cli/workflow-sidecar.js";
import { lifecycleAuthorityCompletionBindsExactState, lifecycleAuthorityResultDigest } from "../../build/src/external-lifecycle-authority.js";

const commandLogChain = createRequire(import.meta.url)("../../scripts/lib/command-log-chain.js");

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-test-proof-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

function writerAbortCapabilityForTest(directory) {
  assert.equal(typeof workflowSidecar.createWriterTransactionAbortCapability, "function", "the abort journal must receive a pinned writer capability");
  return workflowSidecar.createWriterTransactionAbortCapability(directory);
}

function appendTransactionAbortForTest(capability, transactionId = "transaction-test") {
  assert.equal(typeof workflowSidecar.appendWriterTransactionAbort, "function");
  return workflowSidecar.appendWriterTransactionAbort(capability, transactionId, "2026-07-22T19:00:00.000Z");
}

test("transaction abort journal safely appends to present and absent regular logs", () => {
  for (const present of [false, true]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `flow-agents-abort-${present ? "present" : "absent"}-`));
    const logFile = path.join(directory, "command-log.jsonl");
    if (present) fs.writeFileSync(logFile, '{"source":"foreign"}\n');

    assert.equal(appendTransactionAbortForTest(writerAbortCapabilityForTest(directory), `transaction-${present}`), true);
    const records = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const record = records.at(-1);
    assert.deepEqual(record.transaction, { id: `transaction-${present}`, outcome: "aborted" });
    assert.equal(record._chain.seq, 0);
    if (!present) assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
  }
});

test("transaction abort journal refuses non-regular log targets without modifying them", () => {
  for (const kind of ["symlink", "fifo", "directory"]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `flow-agents-abort-${kind}-`));
    const logFile = path.join(directory, "command-log.jsonl");
    const outside = path.join(directory, "outside.log");
    if (kind === "symlink") {
      fs.writeFileSync(outside, "outside sentinel\n");
      fs.symlinkSync(outside, logFile);
    } else if (kind === "fifo") {
      execFileSync("mkfifo", [logFile]);
    } else {
      fs.mkdirSync(logFile);
    }

    assert.equal(appendTransactionAbortForTest(writerAbortCapabilityForTest(directory), `transaction-${kind}`), false);
    if (kind === "symlink") assert.equal(fs.readFileSync(outside, "utf8"), "outside sentinel\n");
    else if (kind === "fifo") assert.equal(fs.lstatSync(logFile).isFIFO(), true);
    else assert.equal(fs.lstatSync(logFile).isDirectory(), true);
  }
});

test("transaction abort journal refuses create races and replaced session identities", () => {
  const racedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-abort-create-race-"));
  const racedLog = path.join(racedDirectory, "command-log.jsonl");
  assert.equal(typeof workflowSidecar.setWriterTransactionAbortTestHooksForTest, "function", "the abort journal exposes a deterministic create-race test hook");
  workflowSidecar.setWriterTransactionAbortTestHooksForTest({ beforeExclusiveCreate: () => fs.writeFileSync(racedLog, "foreign race\n") });
  try {
    assert.equal(appendTransactionAbortForTest(writerAbortCapabilityForTest(racedDirectory), "transaction-race"), false);
  } finally {
    workflowSidecar.setWriterTransactionAbortTestHooksForTest(undefined);
  }
  assert.equal(fs.readFileSync(racedLog, "utf8"), "foreign race\n");

  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-abort-replaced-root-"));
  const sessionDir = path.join(artifactRoot, "session");
  fs.mkdirSync(sessionDir);
  const capability = writerAbortCapabilityForTest(sessionDir);
  const parked = `${sessionDir}-parked`;
  fs.renameSync(sessionDir, parked);
  fs.mkdirSync(sessionDir);
  const replacementLog = path.join(sessionDir, "command-log.jsonl");
  fs.writeFileSync(replacementLog, "replacement sentinel\n");
  assert.equal(appendTransactionAbortForTest(capability, "transaction-replaced"), false);
  assert.equal(fs.readFileSync(replacementLog, "utf8"), "replacement sentinel\n");
});

test("transaction abort journal refuses to extend a broken execution-proof chain", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-abort-broken-chain-"));
  const logFile = path.join(directory, "command-log.jsonl");
  const broken = `${JSON.stringify({
    source: "canonical-writer-execution",
    command: "true",
    _chain: { seq: 0, prevHash: "f".repeat(64), hash: "e".repeat(64) },
  })}\n`;
  fs.writeFileSync(logFile, broken);

  assert.equal(appendTransactionAbortForTest(writerAbortCapabilityForTest(directory), "transaction-broken"), false);
  assert.equal(fs.readFileSync(logFile, "utf8"), broken, "a broken chain remains untouched for explicit recovery");
});

test("transaction abort denial preserves malformed and gap command-log bytes exactly", () => {
  const chained = { source: "postToolUse-capture", command: "true" };
  chained._chain = {
    seq: 0,
    prevHash: commandLogChain.CHAIN_GENESIS,
    hash: commandLogChain.computeChainHash(commandLogChain.CHAIN_GENESIS, chained),
  };
  for (const [name, raw] of [
    ["malformed", `${JSON.stringify(chained)}\nnot json\n`],
    ["mid-chain-gap", `${JSON.stringify(chained)}\n[]\n`],
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `flow-agents-abort-denied-${name}-`));
    const logFile = path.join(directory, "command-log.jsonl");
    fs.writeFileSync(logFile, raw);
    assert.equal(appendTransactionAbortForTest(writerAbortCapabilityForTest(directory), `transaction-denied-${name}`), false, `${name}: denied authority is fail closed`);
    assert.equal(fs.readFileSync(logFile, "utf8"), raw, `${name}: denied authority leaves log bytes untouched`);
  }
});

test("transaction abort journal refuses to extend a valid-hash non-benign fork", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-abort-non-benign-fork-"));
  const logFile = path.join(directory, "command-log.jsonl");
  const makeSibling = (source) => {
    const record = {
      source,
      command: "true",
      _chain: { seq: 0, prevHash: commandLogChain.CHAIN_GENESIS, hash: "" },
    };
    record._chain.hash = commandLogChain.computeChainHash(record._chain.prevHash, record);
    return record;
  };
  const fork = `${JSON.stringify(makeSibling("postToolUse-capture"))}\n${JSON.stringify(makeSibling("foreign-non-capture"))}\n`;
  fs.writeFileSync(logFile, fork);

  assert.equal(appendTransactionAbortForTest(writerAbortCapabilityForTest(directory), "transaction-non-benign-fork"), false);
  assert.equal(fs.readFileSync(logFile, "utf8"), fork, "a non-benign fork remains untouched for explicit recovery");
});

test("transaction abort journal never deletes a stale foreign lock", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-abort-stale-lock-"));
  const lockFile = path.join(directory, "command-log.jsonl.lock.0");
  const contents = `${JSON.stringify({ generation: 0, nonce: "foreign", state: "active" })}\n`;
  fs.writeFileSync(lockFile, contents);
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, stale, stale);

  assert.equal(appendTransactionAbortForTest(writerAbortCapabilityForTest(directory), "transaction-stale-lock"), false);
  assert.equal(fs.readFileSync(lockFile, "utf8"), contents);
  assert.equal(fs.existsSync(path.join(directory, "command-log.jsonl")), false);
});

test("transaction abort journal loops partial writes and rejects zero writes", () => {
  const partialDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-abort-partial-write-"));
  workflowSidecar.setWriterTransactionAbortTestHooksForTest({
    write: (fd, buffer, offset, length, position) => fs.writeSync(fd, buffer, offset, Math.min(length, 3), position),
  });
  try {
    assert.equal(appendTransactionAbortForTest(writerAbortCapabilityForTest(partialDirectory), "transaction-partial"), true);
  } finally {
    workflowSidecar.setWriterTransactionAbortTestHooksForTest(undefined);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(partialDirectory, "command-log.jsonl"), "utf8")).transaction.id, "transaction-partial");

  const zeroDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-abort-zero-write-"));
  workflowSidecar.setWriterTransactionAbortTestHooksForTest({ write: () => 0 });
  try {
    assert.equal(appendTransactionAbortForTest(writerAbortCapabilityForTest(zeroDirectory), "transaction-zero"), false);
  } finally {
    workflowSidecar.setWriterTransactionAbortTestHooksForTest(undefined);
  }
});

test("transaction abort journal rereads and rejects post-fsync corruption", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-abort-reread-corruption-"));
  workflowSidecar.setWriterTransactionAbortTestHooksForTest({
    beforeReread: (descriptor) => { fs.writeSync(descriptor, Buffer.from("!"), 0, 1, 0); },
  });
  try {
    assert.equal(appendTransactionAbortForTest(writerAbortCapabilityForTest(directory), "transaction-corrupt"), false);
  } finally {
    workflowSidecar.setWriterTransactionAbortTestHooksForTest(undefined);
  }
});

test("transaction abort journal rejects lock replacement during descriptor release", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-abort-lock-replacement-"));
  let replacement = "";
  let stderr = "";
  const writeStderr = process.stderr.write;
  workflowSidecar.setWriterTransactionAbortTestHooksForTest({
    beforeLockRelease: (lockFile) => {
      fs.renameSync(lockFile, `${lockFile}.parked`);
      replacement = `${JSON.stringify({ generation: 0, nonce: "foreign", state: "active" })}\n`;
      fs.writeFileSync(lockFile, replacement);
    },
  });
  try {
    process.stderr.write = ((chunk) => { stderr += String(chunk); return true; });
    assert.equal(appendTransactionAbortForTest(writerAbortCapabilityForTest(directory), "transaction-lock-replaced"), false);
  } finally {
    process.stderr.write = writeStderr;
    workflowSidecar.setWriterTransactionAbortTestHooksForTest(undefined);
  }
  assert.equal(fs.readFileSync(path.join(directory, "command-log.jsonl.lock.0"), "utf8"), replacement);
  assert.match(stderr, /generation release uncertain.*operator recovery/i, "a false abort-journal release result must be visible immediately");
  assert.doesNotMatch(stderr, /foreign|transaction-lock-replaced|command-log\.jsonl\.lock\.0/i, "release uncertainty diagnostics must stay redacted");
});

test("explicit gate verdicts remain authoritative over successful and failing command observations", () => {
  const cases = [
    ["pass", "pass", "pass"],
    ["pass", "fail", "fail"],
    ["fail", "pass", "fail"],
    ["fail", "fail", "fail"],
    ["not_verified", "pass", "not_verified"],
    ["not_verified", "fail", "not_verified"],
  ];
  for (const [requested, observed, expected] of cases) {
    assert.equal(composeGateVerdict(requested, observed), expected, `${requested} with ${observed}`);
  }
  assert.equal(composeGateVerdict("pass", "ambiguous"), "not_verified");
});

test("critique authority gates ignore embedded ledger events and require a protected external ledger", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-critique-authority-"));
  const bundle = {
    claims: [{ metadata: { origin: "critique", critique_resolution: { kind: "cross-reviewer" } } }],
    critique_resolution_events: [{ event_id: "embedded-forgery" }],
  };
  assert.deepEqual(externalCritiqueAuthorityForGate(dir, bundle), { events: [], completionVerified: false }, "bundle-embedded authority events are never consumed");
  const ledger = path.join(dir, "lifecycle-authority.resolution-events.json");
  fs.writeFileSync(ledger, `${JSON.stringify({ schema_version: "1.0", events: [{ event_id: "external-event" }] })}\n`, { mode: 0o644 });
  assert.deepEqual(externalCritiqueAuthorityForGate(dir, bundle), { events: [{ event_id: "external-event" }], completionVerified: false }, "an external ledger still needs a verified completion");
  fs.chmodSync(ledger, 0o666);
  assert.deepEqual(externalCritiqueAuthorityForGate(dir, bundle), { events: [], completionVerified: false }, "group/world-writable external ledgers fail closed");
});

test("sidecar and gate authority remain exact-current across the historical repair bridge", () => {
  const bundle = { schema_version: "1.0", claims: [{ id: "later-public-review", metadata: { origin: "critique" } }] };
  const historicalEvents = [{ event_id: "historical-resolution" }];
  const currentEvents = [...historicalEvents, { event_id: "history-repair" }];
  const staleCompletion = {
    action: "resolve-critique", run_id: "repair-run",
    result_core_sha256: lifecycleAuthorityResultDigest({ schema_version: "1.0", claims: [], critique_resolution_events: historicalEvents }),
  };
  assert.equal(lifecycleAuthorityCompletionBindsExactState(staleCompletion, "repair-run", bundle, currentEvents), false, "a valid bridge does not make a stale completion gate authority");
  const exactCompletion = {
    action: "repair-critique-resolution-history", run_id: "repair-run", operation_status: "applied",
    result_core_sha256: lifecycleAuthorityResultDigest({ ...bundle, critique_resolution_events: currentEvents }),
  };
  assert.equal(lifecycleAuthorityCompletionBindsExactState(exactCompletion, "repair-run", bundle, currentEvents), true, "only the new post-repair completion satisfies the exact-current gate contract");
  assert.equal(
    lifecycleAuthorityCompletionBindsExactState({ ...exactCompletion, operation_status: "replayed" }, "repair-run", bundle, currentEvents),
    false,
    "a replayed receipt cannot satisfy sidecar or final-gate current authority even with the exact current digest",
  );
});

test("critique gate freshness permits stale passing anchors but requires one current substantive PASS", () => {
  const substantive = (id) => ({ critique_record_id: id, verdict: "pass", claim_status: "verified", lanes: [{ id: "code", status: "pass" }], findings: [], review_target: { artifacts: [{ file: "reviewed.md", sha256: "a".repeat(64) }] } });
  const stale = substantive("stale"), current = substantive("current");
  const byId = new Map([[stale.critique_record_id, stale], [current.critique_record_id, current]]);
  assert.equal(liveCritiqueFreshnessSatisfied([{ critique_record_id: "stale" }, { critique_record_id: "current" }], byId, (critique) => critique.critique_record_id === "current"), true);
  assert.equal(liveCritiqueFreshnessSatisfied([{ critique_record_id: "stale" }, { critique_record_id: "current" }], byId, () => false), false, "all-stale live PASS anchors do not satisfy freshness");
  byId.set("current", { ...current, verdict: "not_verified" });
  assert.equal(liveCritiqueFreshnessSatisfied([{ critique_record_id: "stale" }, { critique_record_id: "current" }], byId, (critique) => critique.critique_record_id === "stale"), false, "a live non-PASS blocks even when another review is current");
});

test("fake Vitest-looking stdout is not test execution proof", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { test: "node fake-vitest.mjs" } }),
    "fake-vitest.mjs": 'console.log("Tests 999 passed");\n',
  });

  assert.equal(isMeaningfulTestCommand("npm test", root), false);
  assert.equal(testExecutionProof("npm test", root), null);
  assert.equal(inferExecutedTestCount("npm test", root, "Tests 999 passed\n"), 0);
});

test("package-script output cannot manufacture a positive test count", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { test: 'echo "# tests 999"' } }),
  });

  assert.equal(isMeaningfulTestCommand("npm test", root), false);
  assert.equal(inferExecutedTestCount("npm test", root, "# tests 999\n"), 0);
});

test("#1048: a committed host-declared ordinary CI lane is substantive tests evidence", () => {
  const root = fixture({
    "package.json": JSON.stringify({
      scripts: {
        "verify:static": "node --check checks/static-check.mjs",
        "test:full": "node --test test/contract.test.mjs",
        "ci:fast": "npm run verify:static && npm run test:full",
      },
      "trust-reconcile-manifest": [{ id: "ci-fast", command: "npm run ci:fast" }],
    }),
    "checks/static-check.mjs": "export {};\n",
    "test/contract.test.mjs": 'import test from "node:test";\ntest("contract", () => {});\n',
  });

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "fixture"], { cwd: root });

  assert.equal(isMeaningfulTestCommand("npm run ci:fast", root), true);
  assert.deepEqual(testExecutionProof("npm run ci:fast", root), {
    kind: "local-process-exit",
    runner: "node --test",
    static_test_units: 1,
  });
  assert.equal(isMeaningfulTestCommand("npm run ci:fast -- --verbose", root), false, "manifest matching is exact, not prefix-based");
  assert.equal(isMeaningfulTestCommand(" npm run ci:fast", root), false, "manifest matching preserves leading whitespace verbatim");
  assert.equal(isMeaningfulTestCommand("npm run ci:fast ", root), false, "manifest matching preserves trailing whitespace verbatim");

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      "verify:static": "node --check checks/static-check.mjs",
      "test:full": "echo forged",
      "ci:fast": "npm run verify:static && npm run test:full",
    },
    "trust-reconcile-manifest": [{ id: "ci-fast", command: "npm run ci:fast" }],
  }));
  assert.equal(testExecutionProof("npm run ci:fast", root)?.runner, "node --test", "a declared lane and every delegated script body come from its committed HEAD manifest");

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    scripts: { "ci:uncommitted": "node --test test/contract.test.mjs" },
    "trust-reconcile-manifest": [{ id: "ci-uncommitted", command: "npm run ci:uncommitted" }],
  }));
  assert.equal(isMeaningfulTestCommand("npm run ci:uncommitted", root), false, "an uncommitted manifest cannot authorize a command");

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    scripts: { "ci:empty": "echo ok", "ci:true": "true", "ci:blank": "" },
    "trust-reconcile-manifest": [
      { id: "ci-empty", command: "npm run ci:empty" },
      { id: "ci-true", command: "npm run ci:true" },
      { id: "ci-blank", command: "npm run ci:blank" },
    ],
  }));
  execFileSync("git", ["add", "package.json"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "vacuous lanes"], { cwd: root });
  for (const command of ["npm run ci:empty", "npm run ci:true", "npm run ci:blank"]) {
    assert.equal(isMeaningfulTestCommand(command, root), false, `${command} remains vacuous despite manifest membership`);
    assert.equal(testExecutionProof(command, root), null);
  }
});

test("#1048: a tracked PATH shim cannot gain membership from a declared CI lane", () => {
  const root = fixture({
    "package.json": JSON.stringify({
      scripts: { "ci:fast": "node --test test/contract.test.mjs" },
      "trust-reconcile-manifest": [{ id: "ci-fast", command: "PATH=./shim npm run ci:fast" }],
    }),
    "shim/npm": "#!/bin/sh\nprintf '1..1\\nok 1 - forged\\n'\nexit 0\n",
    "test/contract.test.mjs": 'import test from "node:test";\ntest("contract", () => {});\n',
  });
  fs.chmodSync(path.join(root, "shim/npm"), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "fixture"], { cwd: root });

  const forged = execFileSync("bash", ["-lc", "PATH=./shim npm run ci:fast"], { cwd: root, encoding: "utf8" });
  assert.match(forged, /ok 1 - forged/);
  assert.equal(isMeaningfulTestCommand("PATH=./shim npm run ci:fast", root), false);
  assert.equal(testExecutionProof("PATH=./shim npm run ci:fast", root), null);
});

test("supported node test workflows produce source-derived local proof", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { test: "node --test test/contract.test.mjs" } }),
    "test/contract.test.mjs": 'import test from "node:test";\ntest("contract", () => {});\n',
  });

  const proof = testExecutionProof("npm test", root);
  assert.deepEqual(proof, { kind: "local-process-exit", runner: "node --test", static_test_units: 1 });
  assert.equal(inferExecutedTestCount("npm test", root, "# tests 0\n"), 0);
  assert.equal(inferExecutedTestCount("npm test", root, "# tests 1\n"), 0, "test plans are declarations, not executed passes");
  assert.equal(inferExecutedTestCount("npm test", root, "# pass 1\n"), 0, "a detached summary line is not runner-owned proof");
  assert.equal(inferExecutedTestCount("npm test", root, "ℹ tests 1\n"), 0);
  assert.equal(observedExecutedTestCount("ok example.test/package\n"), 0, "a passing package is not an executed test count");
  assert.equal(observedExecutedTestCount("1..2\nok 1 - ran\nok 2 - deferred # SKIP later\n"), 1, "TAP plans and skipped records do not count");
  assert.equal(observedExecutedTestCount("# Subtest: skipped suite\n    ok 1 - deferred # SKIP later\n    1..1\nok 1 - skipped suite\n1..1\n"), 0, "an all-skipped TAP subtest does not make its outer suite marker a pass");
});

test("#1048: a name-filtered, skipped-only Node suite with printed pass-shaped stdout is null proof", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { test: "node --test --test-name-pattern=contract test/contract.test.mjs" } }),
    "test/contract.test.mjs": 'import { describe, it } from "node:test";\nconsole.log("1 passed");\ndescribe("suite", () => { it("contract", { skip: true }, () => {}); });\n',
  });
  const command = "node --test --test-name-pattern=contract test/contract.test.mjs";
  const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=contract", "test/contract.test.mjs"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /1 passed/);
  assert.match(output, /(?:#|ℹ)\s*pass 0/);
  assert.equal(testExecutionProof(command, root)?.static_test_units, 1, "static declarations alone cannot establish execution");
  assert.equal(inferExecutedTestCount(command, root, output), 0, "zero executed-and-passed tests is null proof");
});

test("#1048: Go PASS records count real cases but never package success or zero Rust summaries", () => {
  const root = fixture({
    "contract_test.go": "package contract\nimport \"testing\"\nfunc TestContract(t *testing.T) {}\n",
  });
  assert.equal(inferExecutedTestCount("go test ./...", root, "=== RUN   TestContract\n--- PASS: TestContract (0.00s)\nPASS\nok   example/contract 0.003s\n"), 1);
  assert.equal(inferExecutedTestCount("go test ./...", root, "ok   example/contract 0.003s\n"), 0, "a successful package is not a test count");
  assert.equal(observedExecutedTestCount("test result: ok. 0 passed; 0 failed; 0 ignored\n", "cargo test"), 0);
});

test("empty suite declarations are not counted as executed test cases", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { test: "node --test test/empty.test.mjs" } }),
    "test/empty.test.mjs": 'import { describe } from "node:test";\ndescribe("empty", () => {});\n',
  });

  assert.equal(testExecutionProof("npm test", root), null);
  assert.equal(inferExecutedTestCount("npm test", root, "# tests 0\n"), 0);
});

test("runner-shaped executable names require explicit files with test cases", () => {
  const root = fixture({
    "pytest": "#!/bin/sh\nexit 0\n",
    "test/contract_test.py": "def test_contract():\n    assert True\n",
  });

  assert.equal(testExecutionProof("./pytest", root), null);
  assert.equal(testExecutionProof("./pytest test/contract_test.py", root), null);
  assert.deepEqual(testExecutionProof("pytest test/contract_test.py", root), {
    kind: "local-process-exit",
    runner: "pytest",
    static_test_units: 1,
  });
});

test("playwright test resolves config-discovered specs as local proof (#826)", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { build: "echo build", "test:rendered": "npm run build && playwright test" } }),
    "playwright.config.mjs": "export default {};\n",
    "tests/rendered-site.spec.mjs": 'import { test } from "@playwright/test";\ntest("page renders", () => {});\n',
  });

  // The kontourai.io shape: compound npm-script body whose second segment is bare playwright.
  assert.deepEqual(testExecutionProof("npm run test:rendered", root), {
    kind: "local-process-exit",
    runner: "playwright test",
    static_test_units: 1,
  });
  assert.equal(isMeaningfulTestCommand("playwright test", root), true);
  assert.deepEqual(testExecutionProof("npx playwright test", root), {
    kind: "local-process-exit",
    runner: "npx playwright test",
    static_test_units: 1,
  });
  // Explicit target narrows the proof to the named spec.
  assert.equal(testExecutionProof("playwright test tests/rendered-site.spec.mjs", root)?.static_test_units, 1);
});

test("playwright without a config, without specs, or shadowed is not proof (#826)", () => {
  const noConfig = fixture({
    "tests/x.spec.mjs": 'import { test } from "@playwright/test";\ntest("x", () => {});\n',
  });
  assert.equal(testExecutionProof("playwright test", noConfig), null);

  const noSpecs = fixture({ "playwright.config.ts": "export default {};\n" });
  assert.equal(testExecutionProof("playwright test", noSpecs), null);

  const covered = fixture({
    "playwright.config.ts": "export default {};\n",
    "tests/x.spec.ts": 'import { test } from "@playwright/test";\ntest("x", () => {});\n',
  });
  assert.equal(testExecutionProof("playwright test --pass-with-no-tests", covered), null);
  assert.equal(testExecutionProof("npx playwright test --pass-with-no-tests", covered), null);
  assert.equal(testExecutionProof("./playwright test", covered), null);
  // H1 refusal: a path-qualified npx spec is the same binary-substitution channel as ./playwright.
  assert.equal(testExecutionProof("npx ./fake/playwright test", covered), null);
  assert.equal(testExecutionProof("npx /tmp/evil/playwright test", covered), null);
});

test("cargo and go require substantive local test sources", () => {
  const empty = fixture({ "Cargo.toml": "[package]\nname='empty'\nversion='0.1.0'\n", "go.mod": "module example.test/empty\n" });
  assert.equal(testExecutionProof("cargo test", empty), null);
  assert.equal(testExecutionProof("go test ./...", empty), null);

  const covered = fixture({
    "Cargo.toml": "[package]\nname='covered'\nversion='0.1.0'\n",
    "src/lib.rs": "#[cfg(test)]\nmod tests { #[test] fn contract() { assert!(true); } }\n",
    "go.mod": "module example.test/covered\n",
    "contract_test.go": "package covered\nimport \"testing\"\nfunc TestContract(t *testing.T) {}\n",
  });
  assert.equal(testExecutionProof("cargo test", covered)?.static_test_units, 1);
  assert.equal(testExecutionProof("go test ./...", covered)?.static_test_units, 1);
});
