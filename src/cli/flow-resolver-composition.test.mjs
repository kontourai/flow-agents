import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evaluateGate, initialState, validateDefinition } from "@kontourai/flow";

import { resolveEffectiveFlowDefinition, resolveFlowFilePath, resolveFlowStep } from "../../build/src/lib/flow-resolver.js";
import { validateActionRepositoryMetadata } from "../../build/src/flow-kit/action-repository-validation.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test("effective Builder definition materializes uses_flow and Flow-native completion", () => {
  const definition = resolveEffectiveFlowDefinition("builder.build", REPO_ROOT);
  assert.ok(definition);
  assert.equal(definition.version, "1.4");
  assert.ok(definition.steps.every((step) => !("uses_flow" in step)));
  assert.ok(!definition.steps.some((step) => step.id === "done"));
  assert.equal(definition.steps.find((step) => step.id === "learn")?.next, null);
  assert.deepEqual(
    definition.gates["builder.publish-learn:pr-open-gate"].expects[0].bundle_claim.accepted_statuses,
    ["verified", "trusted", "accepted"],
  );
});

test("effective definitions compile named ungated terminal sentinels to Flow-native completion", () => {
  const definition = resolveEffectiveFlowDefinition("builder.shape", REPO_ROOT);
  assert.ok(definition);
  assert.ok(!definition.steps.some((step) => step.id === "shape-done"));
  assert.equal(definition.steps.find((step) => step.id === "file-issues")?.next, null);
  assert.doesNotThrow(() => validateDefinition(definition));
});

test("composed pr-open-gate declares the missing_evidence repair route to verify (#695 item a)", () => {
  const definition = resolveEffectiveFlowDefinition("builder.build", REPO_ROOT);
  assert.ok(definition);
  const gate = definition.gates["builder.publish-learn:pr-open-gate"];
  assert.deepEqual(gate.on_route_back, { missing_evidence: "verify", default: "verify" });
  assert.deepEqual(gate.route_back_policy, { max_attempts: 3, on_exceeded: "block" });
  // Every declared route-back target must exist in the EFFECTIVE step set — the
  // composed definition (where `verify` lives) must stay a valid Flow definition.
  assert.doesNotThrow(() => validateDefinition(definition));
  // The live resolver surfaces the declared reasons at the composed step, which is
  // what record-gate-claim's --route-reason validation reads.
  const step = resolveFlowStep("builder.build", "pr-open", REPO_ROOT);
  assert.ok(step);
  assert.equal(step.gateId, "builder.publish-learn:pr-open-gate");
  assert.deepEqual([...step.routeBackReasons].sort(), ["default", "missing_evidence"]);
});

test("composed merge-ready-ci gate can refresh evidence after the reviewed diff is committed", () => {
  const definition = resolveEffectiveFlowDefinition("builder.build", REPO_ROOT);
  assert.ok(definition);
  const gate = definition.gates["builder.publish-learn:merge-ready-ci-gate"];
  assert.deepEqual(gate.on_route_back, { implementation_defect: "execute", missing_evidence: "verify", default: "verify" });
  assert.deepEqual(gate.route_back_policy, { max_attempts: 3, on_exceeded: "block" });
  assert.doesNotThrow(() => validateDefinition(definition));
  const step = resolveFlowStep("builder.build", "merge-ready-ci", REPO_ROOT);
  assert.ok(step);
  assert.equal(step.gateId, "builder.publish-learn:merge-ready-ci-gate");
  assert.deepEqual([...step.routeBackReasons].sort(), ["default", "implementation_defect", "missing_evidence"]);
});

test("composed merge-ready-ci gate carries the #1302 freshness turnstile and learn-gate its escape route", () => {
  // Both instrumented dogfood runs stranded terminal because merge-ready-ci accepted stale
  // verification and learn had no route back. The declaration must SURVIVE scalar uses_flow
  // composition into the effective definition the runtime consults — a resolver that drops the
  // field silently disarms the guard while the kit JSON still reads as protected.
  const definition = resolveEffectiveFlowDefinition("builder.build", REPO_ROOT);
  assert.ok(definition);
  assert.equal(definition.gates["builder.publish-learn:merge-ready-ci-gate"].requires_current_verification, true);
  const learnGate = definition.gates["builder.publish-learn:learn-gate"];
  assert.ok(learnGate, "composed learn-gate must exist");
  assert.equal(learnGate.requires_current_verification, undefined, "learn-gate itself must NOT arm the turnstile: it is the repair entrance, and arming it would refuse the very route-back cycle that repairs staleness");
  assert.deepEqual(learnGate.on_route_back, { missing_evidence: "verify", default: "verify" });
  assert.deepEqual(learnGate.route_back_policy, { max_attempts: 3, on_exceeded: "block" });
  assert.doesNotThrow(() => validateDefinition(definition));
  const step = resolveFlowStep("builder.build", "learn", REPO_ROOT);
  assert.ok(step);
  assert.deepEqual([...step.routeBackReasons].sort(), ["default", "missing_evidence"]);
});

test("aggregate (uses_flows) composition propagates requires_current_verification from any contributor", () => {
  // The scalar path preserves the field by spreading the child gate; the aggregate path builds a
  // fresh gate object and must propagate it explicitly, or list-composed kits silently lose the
  // guard. Kit-neutral fixture flows (boundary rule: no builder content in core tests).
  const defs = makeFixtureDir("flowdefs-turnstile-");
  try {
    writeJson(path.join(defs, "acme.child-a.flow.json"), {
      id: "acme.child-a", version: "1.0",
      steps: [{ id: "closeout", next: null }],
      exports: ["acme.closeout.readiness"],
      gates: { "closeout-a": { step: "closeout", requires_current_verification: true, on_route_back: { missing_evidence: "closeout" }, route_back_policy: { max_attempts: 3, on_exceeded: "block" }, expects: [{ id: "readiness-a", kind: "trust.bundle", required: true, description: "a", bundle_claim: { claimType: "acme.closeout.readiness", subjectType: "flow-step", accepted_statuses: ["verified"] } }] } },
    });
    writeJson(path.join(defs, "acme.child-b.flow.json"), {
      id: "acme.child-b", version: "1.0",
      steps: [{ id: "closeout", next: null }],
      exports: ["acme.closeout.readiness"],
      gates: { "closeout-b": { step: "closeout", on_route_back: { missing_evidence: "closeout" }, route_back_policy: { max_attempts: 3, on_exceeded: "block" }, expects: [{ id: "readiness-b", kind: "trust.bundle", required: true, description: "b", bundle_claim: { claimType: "acme.closeout.readiness", subjectType: "flow-step", accepted_statuses: ["verified"] } }] } },
    });
    writeJson(path.join(defs, "acme.parent.flow.json"), {
      id: "acme.parent", version: "1.0",
      steps: [{ id: "closeout", next: null, uses_flows: ["acme.child-a", "acme.child-b"] }],
      gates: {},
    });
    const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    process.env.FLOW_AGENTS_FLOW_DEFS_DIR = defs;
    try {
      const definition = resolveEffectiveFlowDefinition("acme.parent", REPO_ROOT);
      assert.ok(definition);
      const aggregate = definition.gates["flow-agents.aggregate.closeout"];
      assert.ok(aggregate, "aggregate gate must exist");
      assert.equal(aggregate.requires_current_verification, true, "one declaring contributor must arm the whole aggregate");

      // and with NO declaring contributor, the field must be ABSENT, not false — a gate that
      // never declared the turnstile must stay byte-compatible with pre-#1302 definitions.
      writeJson(path.join(defs, "acme.child-a.flow.json"), {
        id: "acme.child-a", version: "1.0",
        steps: [{ id: "closeout", next: null }],
        exports: ["acme.closeout.readiness"],
        gates: { "closeout-a": { step: "closeout", on_route_back: { missing_evidence: "closeout" }, route_back_policy: { max_attempts: 3, on_exceeded: "block" }, expects: [{ id: "readiness-a", kind: "trust.bundle", required: true, description: "a", bundle_claim: { claimType: "acme.closeout.readiness", subjectType: "flow-step", accepted_statuses: ["verified"] } }] } },
      });
      const undeclared = resolveEffectiveFlowDefinition("acme.parent", REPO_ROOT);
      assert.ok(undeclared);
      assert.ok(!("requires_current_verification" in undeclared.gates["flow-agents.aggregate.closeout"]));
    } finally {
      if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
      else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
    }
  } finally {
    fs.rmSync(defs, { recursive: true, force: true });
  }
});

test("installed package definitions resolve when a consumer repo has no kits directory", () => {
  const consumer = makeFixtureDir("flow-agents-consumer-");
  const resolved = resolveFlowFilePath("builder", "build", "builder.build", consumer, false);
  assert.ok(resolved);
  assert.equal(fs.realpathSync(resolved), fs.realpathSync(path.join(REPO_ROOT, "kits", "builder", "flows", "build.flow.json")));
  assert.equal(resolveEffectiveFlowDefinition("builder.build", consumer, { allowOverride: false })?.version, "1.4");
});

test("consumer-vendored definitions remain authoritative over package fallback", () => {
  const consumer = makeFixtureDir("flow-agents-consumer-vendored-");
  const vendored = path.join(consumer, "kits", "builder", "flows", "build.flow.json");
  writeJson(vendored, { id: "builder.build", version: "consumer", steps: [{ id: "local", next: null }], gates: {} });
  assert.equal(resolveFlowFilePath("builder", "build", "builder.build", consumer, false), fs.realpathSync(vendored));
});

test("unsafe explicit overrides fail closed instead of using package fallback", () => {
  const consumer = makeFixtureDir("flow-agents-consumer-unsafe-");
  const unsafeDefinitions = path.join(consumer, ".kontourai", "flow-agents", "definitions");
  fs.mkdirSync(unsafeDefinitions, { recursive: true });
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = unsafeDefinitions;
  try {
    assert.equal(resolveFlowFilePath("builder", "build", "builder.build", consumer), null);
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("effective definition compilation rejects uses_flow cycles", () => {
  const definitions = makeFixtureDir("flow-agents-composition-cycle-");
  writeJson(path.join(definitions, "loop.one.flow.json"), {
    id: "loop.one",
    version: "1.0",
    steps: [{ id: "shared", next: null, uses_flow: "loop.two" }],
    gates: {},
    exports: ["loop.one.claim"],
  });
  writeJson(path.join(definitions, "loop.two.flow.json"), {
    id: "loop.two",
    version: "1.0",
    steps: [{ id: "shared", next: null, uses_flow: "loop.one" }],
    gates: {},
    exports: ["loop.two.claim"],
  });
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = definitions;
  try {
    assert.equal(resolveEffectiveFlowDefinition("loop.one", definitions), null);
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("canonical compilation ignores Flow definition overrides", () => {
  const definitions = makeFixtureDir("flow-agents-composition-override-");
  writeJson(path.join(definitions, "builder.build.flow.json"), {
    id: "builder.build",
    version: "999.0",
    steps: [{ id: "hostile", next: null }],
    gates: {},
  });
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = definitions;
  try {
    assert.equal(resolveEffectiveFlowDefinition("builder.build", REPO_ROOT)?.version, "999.0");
    assert.equal(resolveEffectiveFlowDefinition("builder.build", REPO_ROOT, { allowOverride: false })?.version, "1.4");
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("legacy scalar uses_flow rejects an array fan-in while uses_flows compiles the same contributors", () => {
  const definitions = makeFixtureDir("flow-agents-legacy-scalar-fan-in-");
  const children = ["one.verify", "two.verify"];
  for (const [index, id] of children.entries()) writeJson(path.join(definitions, `${id}.flow.json`), {
    id, version: "1.0", steps: [{ id: "verify", next: null }],
    gates: { gate: { step: "verify", expects: [{ id: `proof.${index}`, kind: "trust.bundle", required: true, description: "proof", bundle_claim: { claimType: `proof.${index}`, subjectType: "artifact", accepted_statuses: ["verified"] } }] } }, exports: [`proof.${index}`],
  });
  writeJson(path.join(definitions, "legacy.build.flow.json"), { id: "legacy.build", version: "1.0", steps: [{ id: "verify", next: null, uses_flow: children }], gates: {} });
  writeJson(path.join(definitions, "aggregate.build.flow.json"), { id: "aggregate.build", version: "1.0", steps: [{ id: "verify", next: null, uses_flows: children }], gates: {} });
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = definitions;
  try {
    assert.equal(resolveEffectiveFlowDefinition("legacy.build", definitions), null);
    assert.equal(resolveFlowStep("legacy.build", "verify", definitions), null);
    const aggregate = resolveEffectiveFlowDefinition("aggregate.build", definitions);
    assert.ok(aggregate);
    assert.deepEqual(Object.keys(aggregate.gates), ["flow-agents.aggregate.verify"]);
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("action-repository validation rejects the route-back incompatibility previously missed by review", () => {
  const kitDir = makeFixtureDir("flow-agents-action-route-back-");
  const children = ["one.verify", "two.verify"];
  const child = (id, target) => ({ id, version: "1.0", steps: [{ id: "verify", next: null }], gates: { gate: { step: "verify", expects: [], on_route_back: { missing_evidence: target }, route_back_policy: { max_attempts: 2, on_exceeded: "block" } } }, exports: [] });
  writeJson(path.join(kitDir, "flows/one.verify.flow.json"), child(children[0], "execute"));
  writeJson(path.join(kitDir, "flows/two.verify.flow.json"), child(children[1], "plan"));
  writeJson(path.join(kitDir, "flows/parent.build.flow.json"), { id: "parent.build", version: "1.0", steps: [{ id: "verify", next: null, uses_flows: children }], gates: {} });
  const manifest = { id: "route-back-fixture", flows: [
    { id: "parent.build", path: "flows/parent.build.flow.json" },
    { id: children[0], path: "flows/one.verify.flow.json" }, { id: children[1], path: "flows/two.verify.flow.json" },
  ] };
  const errors = validateActionRepositoryMetadata({ kitDir, manifestPath: "kit.json", manifest, actions: [], skillRoles: [] });
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = path.join(kitDir, "flows");
  try {
    const effective = resolveEffectiveFlowDefinition("parent.build", process.env.FLOW_AGENTS_FLOW_DEFS_DIR);
    const live = resolveFlowStep("parent.build", "verify", process.env.FLOW_AGENTS_FLOW_DEFS_DIR);
    assert.deepEqual({
      action_repository_accepted_conflicting_route_back: errors.length === 0,
      effective,
      live,
      validation_errors: errors,
    }, {
      action_repository_accepted_conflicting_route_back: false,
      effective: null,
      live: null,
      validation_errors: ["kit.json: flow 'parent.build/verify' has incompatible composed route-back or gate metadata"],
    });
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("action-repository validation fails closed for every aggregate incompatibility", () => {
  const gate = (claim, metadata = {}) => ({ step: "verify", expects: claim === undefined ? [] : [{ id: claim, kind: "trust.bundle", required: true, description: claim, bundle_claim: { claimType: claim, subjectType: "artifact", accepted_statuses: ["verified"] } }], ...metadata });
  const child = (id, metadata = {}, claim) => ({ id, version: "1.0", steps: [{ id: "verify", next: null }], gates: { gate: gate(claim, metadata) }, exports: claim === undefined ? [] : [claim] });
  const cases = {
    mixed_policy_presence: { children: [child("one.verify", { on_route_back: { missing_evidence: "execute" }, route_back_policy: { max_attempts: 2, on_exceeded: "block" } }), child("two.verify", { on_route_back: { missing_evidence: "execute" } })] },
    malformed_route_map: { children: [child("one.verify", { on_route_back: ["missing_evidence"] }), child("two.verify")] },
    malformed_policy: { children: [child("one.verify", { on_route_back: { missing_evidence: "execute" }, route_back_policy: { max_attempts: 0, on_exceeded: "block" } }), child("two.verify", { on_route_back: { missing_evidence: "execute" }, route_back_policy: { max_attempts: 0, on_exceeded: "block" } })] },
    aggregate_id_collision: { children: [child("one.verify")], parentGates: { "flow-agents.aggregate.verify": gate() } },
    multiple_child_gates: { children: [{ ...child("one.verify"), gates: { one: gate(), two: gate() } }] },
    duplicate_expectations: { children: [child("one.verify", {}, "same.proof"), child("two.verify", {}, "same.proof")] },
    cycle: { children: [{ id: "one.verify", version: "1.0", steps: [{ id: "verify", next: null, uses_flows: ["parent.build"] }], gates: {}, exports: [] }] },
    ambiguous_scalar_and_list: { children: [child("one.verify")], parentStep: { id: "verify", next: null, uses_flow: "one.verify", uses_flows: ["one.verify"] } },
  };
  for (const [name, scenario] of Object.entries(cases)) {
    const kitDir = makeFixtureDir(`flow-agents-action-${name}-`);
    const parent = { id: "parent.build", version: "1.0", steps: [scenario.parentStep ?? { id: "verify", next: null, uses_flows: scenario.children.map((entry) => entry.id) }], gates: scenario.parentGates ?? {} };
    writeJson(path.join(kitDir, "flows/parent.json"), parent);
    for (const entry of scenario.children) writeJson(path.join(kitDir, `flows/${entry.id}.json`), entry);
    const manifest = { id: "aggregate-fixture", flows: [{ id: "parent.build", path: "flows/parent.json" }, ...scenario.children.map((entry) => ({ id: entry.id, path: `flows/${entry.id}.json` }))] };
    const errors = validateActionRepositoryMetadata({ kitDir, manifestPath: "kit.json", manifest, actions: [], skillRoles: [] });
    assert.ok(errors.some((entry) => entry.includes("incompatible composed route-back or gate metadata")), name);
  }
});

test("a parent composes ordered contributions from three Kit-neutral child flows", () => {
  const definitions = makeFixtureDir("flow-agents-multi-composition-");
  const children = [
    ["verification.verify", "verification-gate", "verification.proof"],
    ["veritas.verify", "veritas-gate", "veritas.attestation"],
    ["third-party.verify", "third-party-gate", "third-party.review"],
  ];
  writeJson(path.join(definitions, "parent.build.flow.json"), {
    id: "parent.build",
    version: "1.0",
    steps: [{ id: "verify", next: null, uses_flows: children.map(([flowId]) => flowId) }],
    gates: {},
  });
  for (const [flowId, gateId, claimType] of children) {
    writeJson(path.join(definitions, `${flowId}.flow.json`), {
      id: flowId,
      version: "1.0",
      steps: [{ id: "verify", next: null }],
      gates: {
        [gateId]: {
          step: "verify",
          expects: [{
            id: claimType,
            kind: "trust.bundle",
            required: true,
            description: `${flowId} contribution`,
            bundle_claim: { claimType, subjectType: "artifact", accepted_statuses: ["verified"] },
          }],
        },
      },
      exports: [claimType],
    });
  }
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = definitions;
  try {
    const definition = resolveEffectiveFlowDefinition("parent.build", definitions);
    assert.ok(definition);
    // RED regression assertion: the pre-repair compiler emitted one gate per
    // child. The effective Flow definition must expose exactly one real gate.
    assert.notDeepEqual(Object.keys(definition.gates), children.map(([flowId, gateId]) => `${flowId}:${gateId}`));
    assert.deepEqual(Object.keys(definition.gates), ["flow-agents.aggregate.verify"]);
    assert.deepEqual(definition.gates["flow-agents.aggregate.verify"].expects.map((expectation) => expectation.id), children.map(([, , claimType]) => claimType));
    assert.deepEqual(
      definition.flow_agents_contributions,
      children.map(([flowId, gateId, claimType]) => ({ flow_id: flowId, gate_id: gateId, step_id: "verify", expectation_ids: [claimType] })),
    );
    assert.doesNotThrow(() => validateDefinition(definition));

    const step = resolveFlowStep("parent.build", "verify", definitions);
    assert.ok(step);
    assert.equal(step.gateId, "flow-agents.aggregate.verify");
    assert.deepEqual(step.gateExpects.map((expectation) => expectation.id), children.map(([, , claimType]) => claimType));
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("multi-child composition rejects duplicate, ambiguous, colliding, and cyclic declarations", () => {
  const definitions = makeFixtureDir("flow-agents-multi-composition-invalid-");
  const child = {
    id: "child.verify",
    version: "1.0",
    steps: [{ id: "verify", next: null }],
    gates: {
      "verify-gate": {
        step: "verify",
        expects: [{
          id: "child.verify.proof",
          kind: "trust.bundle",
          required: true,
          description: "child contribution",
          bundle_claim: { claimType: "child.verify.proof", subjectType: "artifact", accepted_statuses: ["verified"] },
        }],
      },
    },
    exports: ["child.verify.proof"],
  };
  writeJson(path.join(definitions, "child.verify.flow.json"), child);
  writeJson(path.join(definitions, "cycle.one.flow.json"), { id: "cycle.one", version: "1.0", steps: [{ id: "verify", next: null, uses_flows: ["cycle.two"] }], gates: {}, exports: [] });
  writeJson(path.join(definitions, "cycle.two.flow.json"), { id: "cycle.two", version: "1.0", steps: [{ id: "verify", next: null, uses_flows: ["cycle.one"] }], gates: {}, exports: [] });
  const invalidParents = {
    duplicate: { steps: [{ id: "verify", next: null, uses_flows: ["child.verify", "child.verify"] }], gates: {} },
    ambiguous: { steps: [{ id: "verify", next: null, uses_flow: "child.verify", uses_flows: ["child.verify"] }], gates: {} },
    collision: { steps: [{ id: "verify", next: null, uses_flows: ["child.verify"] }], gates: child.gates },
    cycle: { steps: [{ id: "verify", next: null, uses_flows: ["cycle.one"] }], gates: {} },
  };
  for (const [name, parent] of Object.entries(invalidParents)) {
    writeJson(path.join(definitions, `parent.${name}.flow.json`), { id: `parent.${name}`, version: "1.0", ...parent });
  }
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = definitions;
  try {
    for (const name of Object.keys(invalidParents)) {
      assert.equal(resolveEffectiveFlowDefinition(`parent.${name}`, definitions), null, name);
      assert.equal(resolveFlowStep(`parent.${name}`, "verify", definitions), null, name);
    }
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("effective and live resolution reject duplicate imported expectation ids before importing child gates", () => {
  const definitions = makeFixtureDir("flow-agents-duplicate-expectation-");
  const child = (id, gate) => ({
    id,
    version: "1.0",
    steps: [{ id: "verify", next: null }],
    gates: {
      [gate]: {
        step: "verify",
        expects: [{
          id: "same.expectation",
          kind: "trust.bundle",
          required: true,
          description: "duplicate imported expectation",
          bundle_claim: { claimType: "same.expectation", subjectType: "artifact", accepted_statuses: ["verified"] },
        }],
      },
    },
    exports: ["same.expectation"],
  });
  writeJson(path.join(definitions, "one.verify.flow.json"), child("one.verify", "one-gate"));
  writeJson(path.join(definitions, "two.verify.flow.json"), child("two.verify", "two-gate"));
  writeJson(path.join(definitions, "parent.build.flow.json"), {
    id: "parent.build",
    version: "1.0",
    steps: [{ id: "verify", next: null, uses_flows: ["one.verify", "two.verify"] }],
    gates: {},
  });
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = definitions;
  try {
    assert.equal(resolveEffectiveFlowDefinition("parent.build", definitions), null);
    assert.equal(resolveFlowStep("parent.build", "verify", definitions), null);
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("list aggregate rejects colliding and incompatible route-back metadata before emitting a gate", () => {
  const definitions = makeFixtureDir("flow-agents-list-route-back-");
  const child = (id, claimType, routeBack = {}) => ({
    id,
    version: "1.0",
    steps: [{ id: "verify", next: null }],
    gates: {
      gate: {
        step: "verify",
        expects: [{ id: claimType, kind: "trust.bundle", required: true, description: `${id} proof`, bundle_claim: { claimType, subjectType: "artifact", accepted_statuses: ["verified"] } }],
        ...routeBack,
      },
    },
    exports: [claimType],
  });
  const cases = {
    aggregate_collision: {
      children: [child("one.verify", "one.proof")],
      parent: { steps: [{ id: "verify", next: "audit", uses_flows: ["one.verify"] }, { id: "audit", next: null }], gates: { "flow-agents.aggregate.verify": { step: "audit", expects: [] } } },
    },
    same_reason_different_targets: {
      children: [
        child("one.verify", "one.proof", { on_route_back: { missing_evidence: "execute" }, route_back_policy: { max_attempts: 2, on_exceeded: "block" } }),
        child("two.verify", "two.proof", { on_route_back: { missing_evidence: "plan" }, route_back_policy: { max_attempts: 2, on_exceeded: "block" } }),
      ],
    },
    retry_mismatch: {
      children: [
        child("one.verify", "one.proof", { on_route_back: { missing_evidence: "execute" }, route_back_policy: { max_attempts: 2, on_exceeded: "block" } }),
        child("two.verify", "two.proof", { on_route_back: { missing_evidence: "execute" }, route_back_policy: { max_attempts: 3, on_exceeded: "block" } }),
      ],
    },
    ambiguous_metadata: {
      children: [
        child("one.verify", "one.proof", { on_route_back: ["missing_evidence"] }),
        child("two.verify", "two.proof"),
      ],
    },
  };
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = definitions;
  try {
    for (const [name, scenario] of Object.entries(cases)) {
      for (const flow of scenario.children) writeJson(path.join(definitions, `${flow.id}.flow.json`), flow);
      writeJson(path.join(definitions, `parent.${name}.flow.json`), {
        id: `parent.${name}`,
        version: "1.0",
        ...(scenario.parent ?? { steps: [{ id: "verify", next: null, uses_flows: scenario.children.map((flow) => flow.id) }], gates: {} }),
      });
      assert.equal(resolveEffectiveFlowDefinition(`parent.${name}`, definitions), null, name);
      assert.equal(resolveFlowStep(`parent.${name}`, "verify", definitions), null, name);
    }
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("list aggregate merges compatible route-back metadata into the one live gate", () => {
  const definitions = makeFixtureDir("flow-agents-list-route-back-compatible-");
  const child = (id, claimType, on_route_back) => ({
    id,
    version: "1.0",
    steps: [{ id: "verify", next: null }],
    gates: { gate: { step: "verify", expects: [{ id: claimType, kind: "trust.bundle", required: true, description: `${id} proof`, bundle_claim: { claimType, subjectType: "artifact", accepted_statuses: ["verified"] } }], on_route_back, route_back_policy: { max_attempts: 2, on_exceeded: "block" } } },
    exports: [claimType],
  });
  writeJson(path.join(definitions, "one.verify.flow.json"), child("one.verify", "one.proof", { missing_evidence: "execute" }));
  writeJson(path.join(definitions, "two.verify.flow.json"), child("two.verify", "two.proof", { implementation_defect: "execute" }));
  writeJson(path.join(definitions, "parent.build.flow.json"), { id: "parent.build", version: "1.0", steps: [{ id: "verify", next: null, uses_flows: ["one.verify", "two.verify"] }], gates: {} });
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = definitions;
  try {
    const effective = resolveEffectiveFlowDefinition("parent.build", definitions);
    assert.ok(effective);
    assert.deepEqual(effective.gates["flow-agents.aggregate.verify"].on_route_back, { missing_evidence: "execute", implementation_defect: "execute" });
    assert.deepEqual(effective.gates["flow-agents.aggregate.verify"].route_back_policy, { max_attempts: 2, on_exceeded: "block" });
    const live = resolveFlowStep("parent.build", "verify", definitions);
    assert.ok(live);
    assert.equal(live.gateId, "flow-agents.aggregate.verify");
    assert.deepEqual(live.routeBackReasons, ["missing_evidence", "implementation_defect"]);
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});

test("required list contributions block the aggregate parent for missing, failed, disputed, stale, and not_verified evidence", () => {
  const definitions = makeFixtureDir("flow-agents-composition-status-matrix-");
  const children = ["one.verify", "two.verify", "three.verify"];
  for (const [index, flowId] of children.entries()) {
    const claimType = `matrix.child.${index + 1}`;
    writeJson(path.join(definitions, `${flowId}.flow.json`), {
      id: flowId,
      version: "1.0",
      steps: [{ id: "verify", next: null }],
      gates: { [`gate-${index + 1}`]: { step: "verify", expects: [{ id: claimType, kind: "trust.bundle", required: true, description: `${flowId} required evidence`, bundle_claim: { claimType, subjectType: "flow-step", accepted_statuses: ["verified"] } }] } },
      exports: [claimType],
    });
  }
  writeJson(path.join(definitions, "parent.build.flow.json"), { id: "parent.build", version: "1.0", steps: [{ id: "verify", next: null, uses_flows: children }], gates: {} });
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  process.env.FLOW_AGENTS_FLOW_DEFS_DIR = definitions;
  try {
    const effective = resolveEffectiveFlowDefinition("parent.build", definitions);
    assert.ok(effective);
    assert.doesNotThrow(() => validateDefinition(effective));
    const [gateId] = Object.keys(effective.gates);
    assert.equal(gateId, "flow-agents.aggregate.verify");
    const replaceClaimType = (entry, claimType) => {
      const clone = structuredClone(entry);
      const claim = clone.bundle.claims[0];
      const policy = clone.bundle.policies[0];
      claim.claimType = claimType;
      policy.claimType = claimType;
      return clone;
    };
    const fixture = (name) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules/@kontourai/flow/examples/scenarios/surface-claims/evidence", name), "utf8")).evidence[0];
    const passing = fixture("pass-trust-report.json");
    const rejected = fixture("fail-rejected-claim.json");
    const stale = fixture("fail-stale-claim.json");
    const notVerified = structuredClone(passing);
    notVerified.bundle.events = [];
    const cases = [
      ["missing", null],
      ["failed", { ...replaceClaimType(passing, "matrix.child.2"), status: "failed" }],
      ["disputed", replaceClaimType(rejected, "matrix.child.2")],
      ["stale", replaceClaimType(stale, "matrix.child.2")],
      ["not_verified", replaceClaimType(notVerified, "matrix.child.2")],
    ];
    for (const [name, badEntry] of cases) {
      const evidence = [replaceClaimType(passing, "matrix.child.1"), replaceClaimType(passing, "matrix.child.3")];
      if (badEntry) evidence.splice(1, 0, badEntry);
      const manifest = { schema_version: "0.1", evidence: evidence.map((entry) => ({ ...entry, gate_id: gateId })) };
      const outcome = evaluateGate(effective, initialState(effective, `matrix-${name}`), manifest, gateId);
      // Failed evidence uses Flow's normal route-back result; the other
      // unsatisfied states block. None may satisfy the one aggregate gate.
      assert.notEqual(outcome.status, "pass", name);
      assert.ok(outcome.missing?.includes("matrix.child.2") || name === "failed", name);
    }
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
});
