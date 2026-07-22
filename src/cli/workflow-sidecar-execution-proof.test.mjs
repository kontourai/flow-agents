import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { composeGateVerdict, inferExecutedTestCount, isMeaningfulTestCommand, testExecutionProof } from "../../build/src/cli/workflow-sidecar.js";
import * as workflowSidecar from "../../build/src/cli/workflow-sidecar.js";

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

test("supported node test workflows produce source-derived local proof", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { test: "node --test test/contract.test.mjs" } }),
    "test/contract.test.mjs": 'import test from "node:test";\ntest("contract", () => {});\n',
  });

  const proof = testExecutionProof("npm test", root);
  assert.deepEqual(proof, { kind: "local-process-exit", runner: "node --test", static_test_units: 1 });
  assert.equal(inferExecutedTestCount("npm test", root, "# tests 0\n"), 0);
  assert.equal(inferExecutedTestCount("npm test", root, "# tests 1\n"), 1);
  assert.equal(inferExecutedTestCount("npm test", root, "ℹ tests 1\n"), 1);
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
