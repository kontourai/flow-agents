// #1280: core must not enumerate Kit flow identifiers on the `workflow start` path. The startable
// set is DERIVED from what the installed kits declare (kit.json flow lists / flows/ directories,
// FLOW_AGENTS_FLOW_DEFS_DIR override) plus the flow resolver's conformance machinery; an unknown
// flow fails closed naming the derived list.
//
// Canonical-path constraint, documented honestly: only flows the Builder run adapter supports get
// a canonical Flow run (the adapter resolves definitions with allowOverride:false against the
// shipped package). A kit-declared non-Builder flow therefore starts a sidecar session — with
// active_flow_id/active_step_id resolved from the kit's own declaration — without a canonical run.
// Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { declaredKitFlowIds } from "../../build/src/lib/flow-resolver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI = path.resolve(REPO_ROOT, "build/src/cli.js");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A minimal kit-neutral FlowDefinition accepted by @kontourai/flow's validateDefinition. */
function fixtureFlow(id) {
  return {
    id,
    version: "1.0",
    steps: [{ id: "probe", next: "closeout" }, { id: "closeout", next: null }],
    gates: {
      "closeout-gate": {
        step: "closeout",
        on_route_back: { missing_evidence: "closeout" },
        route_back_policy: { max_attempts: 3, on_exceeded: "block" },
        expects: [{
          id: "readiness", kind: "trust.bundle", required: true, description: "closeout readiness",
          bundle_claim: { claimType: "acme.closeout.readiness", subjectType: "flow-step", accepted_statuses: ["verified"] },
        }],
      },
    },
  };
}

function runStart(args, cwd, env = {}) {
  return spawnSync(process.execPath, [CLI, "workflow", "start", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CODEX_SESSION_ID: "kit-declared-flow-test", FLOW_AGENTS_FLOW_DEFS_DIR: undefined, ...env },
  });
}

test("declaredKitFlowIds derives from kit.json flow lists, flows/ directories, and the package fallback", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-"));
  try {
    // Kit with a kit.json flows list — the list is the declaration surface, so an extra
    // undeclared file in flows/ must NOT appear.
    writeJson(path.join(repoRoot, "kits/acme/kit.json"), {
      id: "acme",
      flows: [
        { id: "acme.alpha", path: "flows/alpha.flow.json" },
        { id: "acme.beta", path: "flows/beta.flow.json" },
        // An id the resolver can never resolve (no `<kit>.<flow>` shape) must be excluded —
        // recommending it in a refusal would recommend an impossible input.
        { id: "unresolvable", path: "flows/unresolvable.flow.json" },
      ],
    });
    writeJson(path.join(repoRoot, "kits/acme/flows/alpha.flow.json"), fixtureFlow("acme.alpha"));
    writeJson(path.join(repoRoot, "kits/acme/flows/beta.flow.json"), fixtureFlow("acme.beta"));
    writeJson(path.join(repoRoot, "kits/acme/flows/undeclared.flow.json"), fixtureFlow("acme.undeclared"));
    // Kit without a kit.json flow list — the flows/ directory is the declaration surface.
    writeJson(path.join(repoRoot, "kits/nolist/flows/gamma.flow.json"), fixtureFlow("nolist.gamma"));

    const declared = declaredKitFlowIds(repoRoot);
    assert.ok(declared.includes("acme.alpha"));
    assert.ok(declared.includes("acme.beta"));
    assert.ok(declared.includes("nolist.gamma"));
    assert.ok(!declared.includes("acme.undeclared"), "kit.json flow list is authoritative when present");
    assert.ok(!declared.includes("unresolvable"), "ids without the <kit>.<flow> shape are excluded");
    // Package fallback parity with resolveFlowFilePath: the executing package's own kits stay
    // declared even when the consumer repo has its own kits/ directory.
    assert.ok(declared.includes("builder.build"));
    assert.ok(declared.includes("builder.shape"));
    assert.deepEqual(declared, [...declared].sort(), "list is sorted");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("declaredKitFlowIds honors the FLOW_AGENTS_FLOW_DEFS_DIR override wholesale and fails closed on agent-writable overrides", () => {
  const defs = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-defs-"));
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  try {
    writeJson(path.join(defs, "acme.custom.flow.json"), fixtureFlow("acme.custom"));
    writeJson(path.join(defs, "not-a-flow.json"), {});
    fs.writeFileSync(path.join(defs, "release-evidence.flow.json"), "{}\n"); // no `<kit>.<flow>` shape
    process.env.FLOW_AGENTS_FLOW_DEFS_DIR = defs;
    assert.deepEqual(declaredKitFlowIds(REPO_ROOT), ["acme.custom"], "override replaces canonical discovery wholesale");

    const agentWritable = path.join(defs, ".kontourai", "flow-agents", "defs");
    fs.mkdirSync(agentWritable, { recursive: true });
    writeJson(path.join(agentWritable, "acme.sneaky.flow.json"), fixtureFlow("acme.sneaky"));
    process.env.FLOW_AGENTS_FLOW_DEFS_DIR = agentWritable;
    assert.deepEqual(declaredKitFlowIds(REPO_ROOT), [], "agent-writable override yields nothing, matching resolveFlowFilePath");
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
    fs.rmSync(defs, { recursive: true, force: true });
  }
});

test("an unknown flow fails closed naming the flows the installed kits actually declare", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flow-start-"));
  try {
    const result = runStart(["--flow", "acme.custom"], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /workflow start --flow "acme\.custom" is not a flow declared by the installed kits; declared flows: /);
    // Derived, not hardcoded: the refusal names kit-declared flows the old enumeration never knew.
    assert.match(result.stderr, /builder\.build/);
    assert.match(result.stderr, /builder\.shape/);
    assert.match(result.stderr, /builder\.publish-learn/);
    assert.match(result.stderr, /knowledge\.ingest/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("under a defs override the derived refusal lists the override's declared flows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flow-start-"));
  const defs = path.join(dir, "defs");
  try {
    writeJson(path.join(defs, "acme.custom.flow.json"), fixtureFlow("acme.custom"));
    const result = runStart(["--flow", "acme.missing"], dir, { FLOW_AGENTS_FLOW_DEFS_DIR: defs });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is not a flow declared by the installed kits; declared flows: acme\.custom/);
    assert.ok(!result.stderr.includes("builder.build"), "the override replaces canonical discovery in the refusal too");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a kit-declared fixture flow starts through the public path as a sidecar session", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flow-start-"));
  const defs = path.join(dir, "defs");
  const consumer = path.join(dir, "consumer");
  const artifactRoot = path.join(consumer, ".kontourai", "flow-agents");
  try {
    writeJson(path.join(defs, "acme.custom.flow.json"), fixtureFlow("acme.custom"));
    fs.mkdirSync(consumer, { recursive: true });
    const result = runStart([
      "--artifact-root", artifactRoot,
      "--flow", "acme.custom",
      "--work-item", "acme/widgets#7",
      "--assignment-provider", "local-file",
      "--summary", "Custom kit flow fixture",
    ], consumer, { FLOW_AGENTS_FLOW_DEFS_DIR: defs });
    assert.equal(result.status, 0, `start failed: ${result.stderr}`);
    const current = JSON.parse(fs.readFileSync(path.join(artifactRoot, "current.json"), "utf8"));
    assert.equal(current.active_flow_id, "acme.custom");
    assert.equal(current.active_step_id, "probe", "first step derived from the kit's own declaration");
    assert.ok(fs.existsSync(path.join(artifactRoot, "acme-widgets-7", "state.json")));
    // Canonical-path constraint (documented, not hidden): the Builder run adapter owns canonical
    // runs and resolves with allowOverride:false, so no canonical Flow run exists for this flow.
    const state = JSON.parse(fs.readFileSync(path.join(artifactRoot, "acme-widgets-7", "state.json"), "utf8"));
    assert.equal(state.flow_run, undefined, "no canonical run is fabricated for a non-Builder flow");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a declared flow that does not conform fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flow-start-"));
  const defs = path.join(dir, "defs");
  try {
    // Declared (file exists in the defs dir) but no steps — the resolver cannot compile it.
    writeJson(path.join(defs, "acme.broken.flow.json"), { id: "acme.broken", version: "1.0" });
    // Declared under one id, definition claims another — the declaration and definition must agree.
    writeJson(path.join(defs, "acme.mismatch.flow.json"), fixtureFlow("acme.other"));

    const broken = runStart(["--flow", "acme.broken"], dir, { FLOW_AGENTS_FLOW_DEFS_DIR: defs });
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /is declared by an installed kit but does not resolve to a conforming flow composition/);

    const mismatch = runStart(["--flow", "acme.mismatch"], dir, { FLOW_AGENTS_FLOW_DEFS_DIR: defs });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /resolved a definition declaring id "acme\.other"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("builder.build and builder.shape pass flow validation and keep their byte-stable contract refusals (regression)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flow-start-"));
  try {
    // Reaching the contract-issue stage proves the derived validation accepted the flow; the
    // pinned strings prove the pre-existing consumer-matched refusals are untouched.
    const build = runStart(["--flow", "builder.build"], dir);
    assert.notEqual(build.status, 0);
    assert.match(build.stderr, /workflow start requires --work-item <provider-ref>/);
    assert.ok(!build.stderr.includes("is not a flow declared"), `builder.build must stay startable: ${build.stderr}`);

    const shape = runStart(["--flow", "builder.shape"], dir);
    assert.notEqual(shape.status, 0);
    assert.match(shape.stderr, /workflow start --flow builder\.shape requires an explicit safe --task-slug/);
    assert.ok(!shape.stderr.includes("is not a flow declared"), `builder.shape must stay startable: ${shape.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the start path carries no Kit flow identifier enumeration (grep-level)", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "src/cli/workflow.ts"), "utf8");
  assert.ok(!source.includes("workflow start supports only"), "the identifier-enumeration refusal is gone");
  assert.ok(!/flow !== "builder\.build" && flow !== "builder\.shape"/.test(source), "the start-path enumeration predicate is gone");
});
