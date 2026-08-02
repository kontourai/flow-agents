import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectEffectiveFlowAgentsConfig } from "../../build/src/lib/effective-flow-agents-config.js";

const git = process.platform === "win32" ? "git" : "/usr/bin/git";

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function commit(root, message) {
  execFileSync(git, ["-C", root, "add", "."]);
  execFileSync(git, ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message]);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-effective-config-"));
  execFileSync(git, ["init", "-q", "-b", "main", root]);
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  commit(root, "initial");
  return root;
}

function core(overrides = {}) {
  return {
    schema_version: "1.0",
    goal_fit: {
      mode: "warn",
      max_blocks: 3,
      recheck: false,
      backstop: "block",
      backstop_timeout_ms: 120000,
      require_sidecars: false,
      require_critique: false,
      ...overrides,
    },
  };
}

function activate(root, active_kit_ids) {
  writeJson(path.join(root, ".flow-agents/install.json"), { version: "5.6.0", runtime: "codex", active_kit_ids });
}

test("effective configuration reads only the immutable HEAD blob and reports ignored drift", () => {
  const root = fixture();
  try {
    writeJson(path.join(root, ".flow-agents/config/core.config.json"), core({ mode: "block", max_blocks: 5 }));
    commit(root, "config");
    writeJson(path.join(root, ".flow-agents/config/core.config.json"), core({ mode: "off", max_blocks: 1 }));

    const report = inspectEffectiveFlowAgentsConfig(root, { environment: { NODE_ENV: "production" } });
    assert.equal(report.core.state, "committed");
    assert.equal(report.effective.goal_fit.mode, "block");
    assert.equal(report.effective.goal_fit.max_blocks, 5);
    assert.equal(report.working_tree_drift.includes(".flow-agents/config/core.config.json"), true);
    assert.match(report.core.provenance.commit, /^[0-9a-f]{40,64}$/);
    assert.match(report.core.provenance.digest, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid committed configuration fails closed and absent configuration preserves defaults", () => {
  const empty = fixture();
  const invalid = fixture();
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-non-git-config-"));
  try {
    assert.equal(inspectEffectiveFlowAgentsConfig(empty).core.state, "default");
    assert.equal(inspectEffectiveFlowAgentsConfig(nonGit).core.state, "default");
    writeJson(path.join(invalid, ".flow-agents/config/core.config.json"), { schema_version: "1.0", goal_fit: { mode: "off" } });
    commit(invalid, "invalid config");
    const report = inspectEffectiveFlowAgentsConfig(invalid);
    assert.equal(report.core.state, "invalid");
    assert.equal(report.fail_closed, true);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(invalid, { recursive: true, force: true });
    fs.rmSync(nonGit, { recursive: true, force: true });
  }
});

test("CLI derives active Kits from the local install record and previews against committed Flow authority", () => {
  const root = fixture();
  try {
    writeJson(path.join(root, ".flow-agents/config/core.config.json"), core({ mode: "block", max_blocks: 4, backstop: "block", require_sidecars: true }));
    writeJson(path.join(root, ".flow-agents/config/builder.kit.config.json"), {
      schema_version: "1.0",
      kit_id: "builder",
      gate_overrides: {
        "verify-gate": { expectations: { "tests-evidence": { required: true } } },
      },
    });
    writeJson(path.join(root, ".flow/config.json"), {
      schema_version: "0.1",
      gate_overrides: { "verify-gate": { expectations: { "tests-evidence": { required: false } } } },
    });
    commit(root, "config");
    // The init-written local record is activation state, not committed policy.
    activate(root, ["builder"]);
    const report = inspectEffectiveFlowAgentsConfig(root, {
      environment: {
        NODE_ENV: "production",
        FLOW_AGENTS_GOAL_FIT_MODE: "off",
        FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS: "1",
        FLOW_AGENTS_GOAL_FIT_BACKSTOP: "skip",
        FLOW_AGENTS_GOAL_FIT_BACKSTOP_TIMEOUT_MS: "999999",
        FLOW_AGENTS_REQUIRE_SIDECARS: "false",
      },
    });
    assert.equal(report.effective.goal_fit.mode, "block");
    assert.equal(report.effective.goal_fit.max_blocks, 4);
    assert.equal(report.effective.goal_fit.recheck, false);
    assert.equal(report.effective.goal_fit.backstop, "block");
    assert.equal(report.effective.goal_fit.require_sidecars, true);
    assert.equal(report.rejected_environment_overrides.length, 5);
    assert.equal(report.kits[0].activation, "active-proposal-only");
    assert.equal(report.kits[0].flow_merge_preview.status, "conflicts");
    assert.equal(report.kits[0].flow_merge_preview.conflicts[0].path, "$.gate_overrides.verify-gate.expectations.tests-evidence.required");

    const cli = path.resolve("build/src/cli.js");
    const cliReport = JSON.parse(execFileSync(process.execPath, [cli, "effective-flow-agents-config", root], { encoding: "utf8" }));
    assert.equal(cliReport.kits[0].activation, "active-proposal-only");
    assert.equal(cliReport.kits[0].flow_merge_preview.status, "conflicts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inactive or mismatched Kit config never receives a merge preview", () => {
  const inactive = fixture();
  const mismatched = fixture();
  try {
    writeJson(path.join(inactive, ".flow-agents/config/builder.kit.config.json"), {
      schema_version: "1.0", kit_id: "builder", gate_overrides: { "verify-gate": { expectations: { tests: { required: true } } } },
    });
    commit(inactive, "inactive kit config");
    const inactiveReport = inspectEffectiveFlowAgentsConfig(inactive);
    assert.equal(inactiveReport.kits[0].activation, "not-active");
    assert.equal("flow_merge_preview" in inactiveReport.kits[0], false);

    writeJson(path.join(mismatched, ".flow-agents/config/other.kit.config.json"), {
      schema_version: "1.0", kit_id: "builder", gate_overrides: { "verify-gate": { expectations: { tests: { required: true } } } },
    });
    commit(mismatched, "mismatched kit config");
    activate(mismatched, ["builder"]);
    const mismatchedReport = inspectEffectiveFlowAgentsConfig(mismatched);
    assert.equal(mismatchedReport.fail_closed, true);
    assert.equal(mismatchedReport.kits[0].state, "invalid");
    assert.match(mismatchedReport.kits[0].diagnostics.join("\n"), /filename stem/);
  } finally {
    fs.rmSync(inactive, { recursive: true, force: true });
    fs.rmSync(mismatched, { recursive: true, force: true });
  }
});

test("production recheck cannot enable model-command execution and malformed policy keeps it disabled", () => {
  const configured = fixture();
  const malformed = fixture();
  try {
    writeJson(path.join(configured, ".flow-agents/config/core.config.json"), core({ recheck: false }));
    commit(configured, "safe config");
    const production = inspectEffectiveFlowAgentsConfig(configured, {
      environment: { NODE_ENV: "production", FLOW_AGENTS_GOAL_FIT_RECHECK: "true" },
    });
    assert.equal(production.effective.goal_fit.recheck, false);
    assert.deepEqual(production.rejected_environment_overrides, ["FLOW_AGENTS_GOAL_FIT_RECHECK"]);

    writeJson(path.join(malformed, ".flow-agents/config/core.config.json"), { schema_version: "1.0", goal_fit: { recheck: true } });
    commit(malformed, "malformed config");
    const failClosed = inspectEffectiveFlowAgentsConfig(malformed, {
      environment: { NODE_ENV: "production", FLOW_AGENTS_GOAL_FIT_RECHECK: "true" },
    });
    assert.equal(failClosed.fail_closed, true);
    assert.equal(failClosed.effective.goal_fit.recheck, false);
  } finally {
    fs.rmSync(configured, { recursive: true, force: true });
    fs.rmSync(malformed, { recursive: true, force: true });
  }
});

test("Kit proposals reject authority outside Flow gate expectation overrides", () => {
  const root = fixture();
  try {
    writeJson(path.join(root, ".flow-agents/config/builder.kit.config.json"), {
      schema_version: "1.0",
      kit_id: "builder",
      gate_overrides: { "verify-gate": { trusted_producers: { bypass: true } } },
    });
    commit(root, "invalid kit config");
    const report = inspectEffectiveFlowAgentsConfig(root);
    assert.equal(report.fail_closed, true);
    assert.equal(report.kits[0].state, "invalid");
    assert.match(report.kits[0].diagnostics.join("\n"), /trusted_producers is not allowed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
