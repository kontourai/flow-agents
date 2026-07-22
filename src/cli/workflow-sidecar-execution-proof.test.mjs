import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { composeGateVerdict, inferExecutedTestCount, isMeaningfulTestCommand, testExecutionProof } from "../../build/src/cli/workflow-sidecar.js";

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-test-proof-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

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
