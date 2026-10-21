import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { definitionIdentity } from "@kontourai/flow";
import {
  DELEGATION_AUTHORITY_DIGEST_DOMAIN, DelegationContractV2Error,
  rootAuthorityDigestV2, serializeRootAuthorityV2, validateRootAuthorityV2,
} from "../../build/src/delegation-authority-contract.js";
import {
  delegationEnvelopeDigestV2, delegationParentReferenceV2, narrowDelegationEnvelopeV2,
  rootAuthorityReferenceV2, serializeDelegationEnvelopeV2, validateDelegationAncestryV2,
  validateDelegationEnvelopeV2,
} from "../../build/src/delegation-envelope-v2.js";
import { narrowDelegationEnvelope } from "../../build/src/delegation-envelope.js";

const NOW = "2026-10-21T12:00:00.000Z";
const EXPIRY = "2026-10-22T12:00:00.000Z";
const sha = character => `sha256:${character.repeat(64)}`;
const ref = (id, domain = "test-receipt") => ({ id, domain, digest: sha("a") });
const resource = (worktree, path = "src/task.ts") => ({ repository_id: "kontourai/flow-agents", execution_worktree_id: worktree, path });
function authority(worktree, writer = true) {
  return {
    allowed_tools: writer ? ["read", "edit"] : ["read"],
    allowed_effects: writer ? ["read", "write"] : ["read"],
    readable_resources: [resource(worktree)],
    mutable_resources: writer ? [resource(worktree)] : [],
    posture: writer ? "writer" : "report-only",
    approval: "requires_approval", escalation: "deny",
  };
}
function budget() {
  return { remaining_depth: 3, max_total_children: 4, max_total_envelopes: 20,
    max_concurrent_children: 2, max_runtime_ms: 60000, max_input_tokens: 10000,
    max_output_tokens: 4000, max_cost_micros: 1000000, max_attempts: 3, expires_at: EXPIRY };
}
function rootAuthority() {
  const grants = ["a", "b"].map(letter => ({
    grant_id: `grant-${letter}`,
    runtime: { runtime_receipt_ref: ref(`runtime-${letter}`, "runtime-selection"),
      model_receipt_ref: ref(`model-${letter}`, "model-selection"), required_capabilities: ["tool-use"] },
    source: { repository_id: "kontourai/flow-agents", source_state_id: "commit-97ebd42d",
      dirty_state_fingerprint: null, execution_worktree_id: `worktree-${letter}`,
      source_admission_receipt: ref(`source-admission-${letter}`, "source-admission") },
    flow_binding: { status: "unbound", reason: "Independent host assignment" },
    authority_ceiling: authority(`worktree-${letter}`),
  }));
  return { schema_version: "2.0", authority_id: "authority-root", authority_epoch: 3,
    issuer_host_id: "host-a", authenticated_principal_ref: ref("principal", "principal"),
    authenticated_subject_ref: ref("subject", "subject"),
    source_origin: { repository_id: "kontourai/flow-agents", worktree_id: "worktree-a",
      source_state_id: "commit-97ebd42d", dirty_state_fingerprint: null },
    execution_worktree_ids: ["worktree-a", "worktree-b"], execution_grants: grants,
    delegation_ceiling: { ...authority("worktree-a"), readable_resources: grants.flatMap(g => g.authority_ceiling.readable_resources), mutable_resources: grants.flatMap(g => g.authority_ceiling.mutable_resources) },
    budget: budget(), revisions: { policy: ref("policy-r1"), prompt: ref("prompt-r1"), rubric: ref("rubric-r1") },
    root_trace: { trace_id: "trace-root", span_id: "span-root" }, root_cancellation_ref: ref("cancel-root") };
}
function binding(grant) { return structuredClone({ runtime: grant.runtime, source: grant.source, flow_binding: grant.flow_binding }); }
function rootEnvelope(root) {
  return { schema_version: "2.0", envelope_id: "envelope-0", generation: 0, parent: null,
    root_authority_ref: rootAuthorityReferenceV2(root), execution_id: "execution-0",
    actor: structuredClone(root.authenticated_principal_ref), assignment_subject: structuredClone(root.authenticated_subject_ref),
    trace_id: root.root_trace.trace_id, span_id: root.root_trace.span_id, parent_span_id: null,
    selected_grant_id: "grant-a", remaining_allowed_grant_ids: ["grant-a", "grant-b"],
    execution_binding: binding(root.execution_grants[0]), delegation_ceiling: structuredClone(root.delegation_ceiling),
    execution_authority: authority("worktree-a", false), budget: structuredClone(root.budget),
    continuation_ref: ref("continuation-root"), cancellation_ref: structuredClone(root.root_cancellation_ref) };
}
function childOf(root, parent, selected = "grant-b") {
  const generation = parent.generation + 1;
  const grant = root.execution_grants.find(g => g.grant_id === selected);
  return { ...structuredClone(parent), envelope_id: `envelope-${generation}`, execution_id: `execution-${generation}`,
    generation, parent: delegationParentReferenceV2(parent), parent_span_id: parent.span_id,
    span_id: `span-${generation}`, selected_grant_id: selected, execution_binding: binding(grant),
    execution_authority: structuredClone(grant.authority_ceiling),
    budget: { ...parent.budget, remaining_depth: parent.budget.remaining_depth - 1, max_total_envelopes: parent.budget.max_total_envelopes - 1 } };
}
const reject = (action, code) => assert.throws(action, error => error instanceof DelegationContractV2Error && (code ? error.code === code : true));
function edgeFixture() {
  const root = rootAuthority(), parent = rootEnvelope(root), child = childOf(root, parent);
  return { root, parent, child };
}

const loadSchema = name => JSON.parse(readFileSync(new URL(`../../schemas/${name}`, import.meta.url), "utf8"));
const authoritySchema = loadSchema("delegation-authority.schema.json");
const envelopeSchema = loadSchema("delegation-envelope-v2.schema.json");
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(authoritySchema);
const schemaRoot = ajv.getSchema(authoritySchema.$id), schemaEnvelope = ajv.compile(envelopeSchema);

test("v2 root -> child -> grandchild changes only to preauthorized whole execution tuples", () => {
  const { root, parent, child } = edgeFixture();
  const grandchild = childOf(root, child, "grant-a");
  grandchild.execution_authority = authority("worktree-a", false);
  const chain = validateDelegationAncestryV2(root, [parent, child, grandchild], NOW);
  assert.equal(chain.length, 3);
  assert.equal(chain[0].execution_authority.posture, "report-only");
  assert.equal(chain[1].execution_authority.posture, "writer");
  assert.deepEqual(chain.map(e => e.execution_binding.source.execution_worktree_id), ["worktree-a", "worktree-b", "worktree-a"]);
  assert.deepEqual(chain.map(e => e.execution_binding.runtime.model_receipt_ref.id), ["model-a", "model-b", "model-a"]);
  assert.equal(schemaRoot(root), true, JSON.stringify(schemaRoot.errors));
  for (const envelope of chain) assert.equal(schemaEnvelope(envelope), true, JSON.stringify(schemaEnvelope.errors));
  child.execution_binding.runtime.required_capabilities.push("mutated");
  assert.deepEqual(chain[1].execution_binding.runtime.required_capabilities, ["tool-use"]);
  const copy = validateRootAuthorityV2(root);
  root.execution_grants[0].runtime.required_capabilities.push("mutated");
  assert.deepEqual(copy.execution_grants[0].runtime.required_capabilities, ["tool-use"]);
});

test("writer delegation uses coordinator ceiling, while execution narrows selected grant and own ceiling", () => {
  const { root, parent, child } = edgeFixture();
  assert.equal(narrowDelegationEnvelopeV2(root, parent, child, NOW).execution_authority.posture, "writer");
  const restricted = structuredClone(parent);
  restricted.delegation_ceiling = { ...structuredClone(root.delegation_ceiling), posture: "report-only", mutable_resources: [] };
  const forbidden = childOf(root, restricted);
  forbidden.delegation_ceiling = structuredClone(root.delegation_ceiling);
  reject(() => narrowDelegationEnvelopeV2(root, restricted, forbidden, NOW), "authority_widening:mutable_resources");
  const readRoot = rootAuthority();
  readRoot.execution_grants[0].authority_ceiling = authority("worktree-a", false);
  const reader = rootEnvelope(readRoot);
  const tooMuch = childOf(readRoot, reader, "grant-a");
  tooMuch.execution_authority = authority("worktree-a");
  reject(() => narrowDelegationEnvelopeV2(readRoot, reader, tooMuch, NOW), "authority_widening:allowed_tools");
  const ownCeiling = structuredClone(child);
  ownCeiling.delegation_ceiling = { ...ownCeiling.delegation_ceiling, allowed_tools: ["read"] };
  reject(() => validateDelegationEnvelopeV2(ownCeiling), "authority_widening:allowed_tools");
  const readOnlyRoot = rootAuthority();
  readOnlyRoot.delegation_ceiling = { ...readOnlyRoot.delegation_ceiling, posture: "report-only", mutable_resources: [], allowed_tools: ["read"], allowed_effects: ["read"] };
  readOnlyRoot.execution_grants.forEach(g => { g.authority_ceiling = authority(g.source.execution_worktree_id, false); });
  const readOnlyParent = rootEnvelope(readOnlyRoot);
  const attemptedWriter = childOf(readOnlyRoot, readOnlyParent);
  attemptedWriter.execution_authority.posture = "writer";
  reject(() => narrowDelegationEnvelopeV2(readOnlyRoot, readOnlyParent, attemptedWriter, NOW), "authority_widening:posture");
  const invalidRoot = rootAuthority();
  invalidRoot.delegation_ceiling.posture = "report-only";
  invalidRoot.delegation_ceiling.mutable_resources = [];
  reject(() => validateRootAuthorityV2(invalidRoot), "authority_widening:mutable_resources");
});

test("grant catalogue rejects new grant, receipt substitution, Cartesian selection and uncatalogued/source drift", () => {
  for (const [code, mutate] of [
    ["unknown_execution_grant", c => { c.selected_grant_id = "new-grant"; }],
    ["unknown_remaining_grant", c => { c.remaining_allowed_grant_ids.push("new-grant"); }],
    ["execution_grant_binding_mismatch", c => { c.execution_binding.runtime.runtime_receipt_ref.digest = sha("b"); }],
    ["execution_grant_binding_mismatch", c => { c.execution_binding.runtime.model_receipt_ref.id = "model-a"; }],
    ["execution_grant_binding_mismatch", c => { c.execution_binding.source.execution_worktree_id = "worktree-a"; }],
    ["execution_grant_binding_mismatch", c => { c.execution_binding.source.source_admission_receipt = ref("other"); }],
    ["execution_grant_binding_mismatch", c => { c.execution_binding.source.source_state_id = "other-source"; }],
    ["execution_grant_binding_mismatch", c => { c.execution_binding.runtime.required_capabilities = []; }],
  ]) {
    const { root, parent, child } = edgeFixture(); mutate(child);
    reject(() => narrowDelegationEnvelopeV2(root, parent, child, NOW), code);
  }
  for (const [code, mutate] of [
    ["grant_source_origin_mismatch", r => { r.execution_grants[1].source.repository_id = "other"; }],
    ["grant_source_origin_mismatch", r => { r.execution_grants[1].source.source_state_id = "other"; }],
    ["grant_source_origin_mismatch", r => { r.execution_grants[1].source.dirty_state_fingerprint = sha("b"); }],
    ["uncatalogued_execution_worktree", r => { r.execution_grants[1].source.execution_worktree_id = "uncatalogued"; }],
    ["invalid_grant_ids", r => { r.execution_grants[1].grant_id = "grant-a"; }],
  ]) {
    const root = rootAuthority(); mutate(root); reject(() => validateRootAuthorityV2(root), code);
  }
});

test("root digest/epoch and exact parent/schema/generation/span references cannot be rebound", () => {
  for (const [code, mutate] of [
    ["root_authority_reference_mismatch", c => { c.root_authority_ref.authority_epoch++; }],
    ["root_authority_reference_mismatch", c => { c.root_authority_ref.digest = sha("c"); }],
    ["parent_reference_mismatch", c => { c.parent.digest = sha("b"); }],
    ["parent_reference_mismatch", c => { c.parent.id = "other-parent"; }],
    ["unsupported_parent_schema", c => { c.parent.schema_version = "1.0"; }],
    ["invalid_parent_lineage", c => { c.generation++; }],
    ["parent_span_mismatch", c => { c.parent_span_id = "wrong-span"; }],
    ["root_trace_mismatch", c => { c.trace_id = "wrong-trace"; }],
    ["principal_reference_mismatch", c => { c.actor.digest = sha("b"); }],
    ["subject_reference_mismatch", c => { c.assignment_subject.id = "wrong-subject"; }],
    ["root_cancellation_mismatch", c => { c.cancellation_ref.id = "wrong-cancellation"; }],
    ["continuation_reference_mismatch", c => { c.continuation_ref.id = "wrong-continuation"; }],
  ]) {
    const { root, parent, child } = edgeFixture(); mutate(child);
    reject(() => narrowDelegationEnvelopeV2(root, parent, child, NOW), code);
  }
  const { root, parent, child } = edgeFixture();
  root.authority_epoch++;
  reject(() => narrowDelegationEnvelopeV2(root, parent, child, NOW), "root_authority_reference_mismatch");
});

test("allowed grants and authority sets/approval/escalation narrow monotonically with exact resource identity", () => {
  for (const [code, mutate] of [
    ["authority_widening:allowed_tools", c => { c.delegation_ceiling.allowed_tools.push("network"); }],
    ["authority_widening:allowed_effects", c => { c.delegation_ceiling.allowed_effects.push("network"); }],
    ["authority_widening:readable_resources", c => { c.delegation_ceiling.readable_resources.push(resource("worktree-b", "src")); }],
    ["authority_widening:mutable_resources", c => { c.delegation_ceiling.mutable_resources.push(resource("worktree-b", "src/task.ts/child")); }],
    ["authority_widening:mutable_resources", c => { c.execution_authority.mutable_resources.push({ ...resource("worktree-b"), repository_id: "other" }); }],
    ["authority_widening:approval", c => { c.execution_authority.approval = "automatic"; }],
    ["authority_widening:escalation", c => { c.execution_authority.escalation = "request"; }],
  ]) {
    const { root, parent, child } = edgeFixture(); mutate(child);
    reject(() => narrowDelegationEnvelopeV2(root, parent, child, NOW), code);
  }
  for (const path of ["src", "src/task.ts/child", "."]) {
    const { root, parent, child } = edgeFixture();
    child.execution_authority.readable_resources = [resource("worktree-b", path)];
    reject(() => narrowDelegationEnvelopeV2(root, parent, child, NOW), "authority_widening:readable_resources");
  }
  const { root, parent } = edgeFixture();
  parent.remaining_allowed_grant_ids = ["grant-a"];
  const child = childOf(root, parent);
  reject(() => narrowDelegationEnvelopeV2(root, parent, child, NOW), "selected_grant_not_allowed");
  child.selected_grant_id = "grant-a"; child.execution_binding = binding(root.execution_grants[0]); child.execution_authority = authority("worktree-a");
  child.remaining_allowed_grant_ids = ["grant-a", "grant-b"];
  reject(() => narrowDelegationEnvelopeV2(root, parent, child, NOW), "remaining_grant_widening");
});

test("bound Flow grants preserve the published definition identity/run/step/gate attempt exactly", () => {
  const root = rootAuthority();
  const flow = JSON.parse(readFileSync(new URL("../../node_modules/@kontourai/flow/examples/agent-dev-flow.json", import.meta.url), "utf8"));
  flow.id = " Définition 日本語 + [review] ";
  flow.version = "1.0.0+build.1";
  const definition = definitionIdentity(flow);
  assert.equal(definition.id, flow.id);
  assert.equal(definition.version, flow.version);
  root.execution_grants[1].flow_binding = { status: "bound", flow_run_id: "flow-run-a", definition, flow_step_id: "implement", gate_attempt: 2 };
  assert.equal(schemaRoot(root), true, JSON.stringify(schemaRoot.errors));
  const parent = rootEnvelope(root), child = childOf(root, parent);
  assert.equal(schemaEnvelope(child), true, JSON.stringify(schemaEnvelope.errors));
  assert.deepEqual(narrowDelegationEnvelopeV2(root, parent, child, NOW).execution_binding.flow_binding.definition, definition);
  for (const mutate of [
    f => { f.flow_run_id = "flow-run-b"; }, f => { f.flow_step_id = "other"; },
    f => { f.gate_attempt++; }, f => { f.definition.digest = "f".repeat(64); },
    f => { f.definition.version = "changed"; },
  ]) {
    const changed = structuredClone(child); mutate(changed.execution_binding.flow_binding);
    reject(() => narrowDelegationEnvelopeV2(root, parent, changed, NOW), "execution_grant_binding_mismatch");
  }
  for (const field of ["id", "version"]) {
    for (const [value, accepted] of [[" ", true], ["😀".repeat(128), true], ["a".repeat(128), true], ["a".repeat(129), false], ["😀".repeat(129), false], ["bad\u0085", false]]) {
      const candidate = rootAuthority();
      const identity = definitionIdentity({ ...flow, [field]: value });
      candidate.execution_grants[1].flow_binding = { ...root.execution_grants[1].flow_binding, definition: identity };
      assert.equal(schemaRoot(candidate), accepted, `${field}: ${JSON.stringify(value)}`);
      // The public envelope validator must enforce the same identity text bounds independently of root validation.
      const { child: envelope } = edgeFixture();
      envelope.execution_binding.flow_binding = structuredClone(candidate.execution_grants[1].flow_binding);
      assert.equal(schemaEnvelope(envelope), accepted);
      if (accepted) {
        const coordinator = rootEnvelope(candidate), child = childOf(candidate, coordinator);
        assert.deepEqual(narrowDelegationEnvelopeV2(candidate, coordinator, child, NOW).execution_binding.flow_binding.definition, identity);
      } else {
        reject(() => validateRootAuthorityV2(candidate), "invalid_flow_definition_text");
        reject(() => validateDelegationEnvelopeV2(envelope), "invalid_flow_definition_text");
      }
    }
  }
});

test("canonical POSIX filenames remain literal exact resources through schema and child admission", () => {
  for (const path of ["src/routes/[id].tsx", "docs/design notes.md", "src/日本語.ts", "src/a+b.ts", "src/\u2028/file.ts", "src/\u2029/file.ts"]) {
    const root = rootAuthority();
    const resources = [resource("worktree-b", path)];
    root.execution_grants[1].authority_ceiling.readable_resources = structuredClone(resources);
    root.execution_grants[1].authority_ceiling.mutable_resources = structuredClone(resources);
    root.delegation_ceiling.readable_resources.push(...structuredClone(resources));
    root.delegation_ceiling.mutable_resources.push(...structuredClone(resources));
    assert.equal(schemaRoot(root), true, JSON.stringify(schemaRoot.errors));
    const parent = rootEnvelope(root), child = childOf(root, parent);
    assert.equal(schemaEnvelope(child), true, JSON.stringify(schemaEnvelope.errors));
    assert.equal(narrowDelegationEnvelopeV2(root, parent, child, NOW).execution_authority.mutable_resources[0].path, path);
    for (const other of [path.split("/")[0], `${path}/child`, `${path}x`, path.replace("[id]", "123"), path.replace(/[\u2028\u2029]/u, " ")].filter(other => other !== path)) {
      const changed = structuredClone(child);
      changed.execution_authority.mutable_resources = [resource("worktree-b", other)];
      reject(() => narrowDelegationEnvelopeV2(root, parent, changed, NOW), "authority_widening:mutable_resources");
    }
  }
});

test("dot segments after Unicode line separators are refused by schemas and child admission", async t => {
  for (const separator of ["\u2028", "\u2029"]) {
    for (const path of [`src/${separator}/../../../escape`, `src/${separator}/./file`, `src/${separator}/.`, `src/${separator}/..`]) {
      await t.test(`root schema refuses ${JSON.stringify(path)}`, () => {
        const root = rootAuthority();
        root.execution_grants[1].authority_ceiling.mutable_resources[0].path = path;
        assert.equal(schemaRoot(root), false, JSON.stringify(schemaRoot.errors));
      });
      await t.test(`envelope schema refuses ${JSON.stringify(path)}`, () => {
        const { child } = edgeFixture();
        child.execution_authority.mutable_resources[0].path = path;
        assert.equal(schemaEnvelope(child), false, JSON.stringify(schemaEnvelope.errors));
      });
      await t.test(`root runtime refuses ${JSON.stringify(path)}`, () => {
        const root = rootAuthority();
        root.execution_grants[1].authority_ceiling.mutable_resources[0].path = path;
        reject(() => validateRootAuthorityV2(root), "invalid_resource_path");
      });
      await t.test(`child admission refuses ${JSON.stringify(path)}`, () => {
        const { root, parent, child } = edgeFixture();
        child.execution_authority.mutable_resources[0].path = path;
        reject(() => narrowDelegationEnvelopeV2(root, parent, child, NOW), "invalid_resource_path");
      });
    }
  }
});

test("unbound reasons share schema code-point boundaries at root and envelope admission", () => {
  for (const [reason, accepted] of [
    ["", false], ["a", true], ["a".repeat(512), true], ["a".repeat(513), false],
    ["😀".repeat(257), true], ["😀".repeat(512), true], ["😀".repeat(513), false],
    [`${"😀".repeat(256)}${"a".repeat(256)}`, true], [`${"😀".repeat(256)}${"a".repeat(257)}`, false],
  ]) {
    const root = rootAuthority();
    root.execution_grants[1].flow_binding.reason = reason;
    assert.equal(schemaRoot(root), accepted, `root reason code points: ${[...reason].length}`);
    // Construct the envelope before replacing its binding, so a rejected root does not mask its validator.
    const base = rootAuthority(), parent = rootEnvelope(base), child = childOf(base, parent);
    child.execution_binding.flow_binding.reason = reason;
    assert.equal(schemaEnvelope(child), accepted, `envelope reason code points: ${[...reason].length}`);
    if (accepted) {
      assert.equal(validateRootAuthorityV2(root).execution_grants[1].flow_binding.reason, reason);
      assert.equal(validateDelegationEnvelopeV2(child).execution_binding.flow_binding.reason, reason);
      const boundParent = rootEnvelope(root), boundChild = childOf(root, boundParent);
      assert.equal(narrowDelegationEnvelopeV2(root, boundParent, boundChild, NOW).execution_binding.flow_binding.reason, reason);
    } else {
      reject(() => validateRootAuthorityV2(root), "invalid_unbound_reason");
      reject(() => validateDelegationEnvelopeV2(child), "invalid_unbound_reason");
    }
  }
});

test("budgets consume depth and one envelope; all active expiries and lifetime fanout bounds hold", () => {
  for (const key of ["remaining_depth", "max_total_envelopes", "max_total_children", "max_concurrent_children", "max_runtime_ms", "max_input_tokens", "max_output_tokens", "max_cost_micros", "max_attempts", "expires_at"]) {
    const { root, parent, child } = edgeFixture();
    if (key === "expires_at") child.budget[key] = "2026-10-23T12:00:00.000Z";
    else child.budget[key] = parent.budget[key] + (key === "remaining_depth" || key === "max_total_envelopes" ? 0 : 1);
    reject(() => narrowDelegationEnvelopeV2(root, parent, child, NOW), key === "remaining_depth" ? "root_depth_limit" : key === "max_total_envelopes" ? "root_envelope_limit" : `budget_widening:${key}`);
  }
  for (const [key, limit] of [["remaining_depth", 32], ["max_total_children", 64], ["max_concurrent_children", 64], ["max_total_envelopes", 4096]]) {
    const root = rootAuthority(); root.budget[key] = limit + 1;
    reject(() => validateRootAuthorityV2(root), "invalid_integer");
  }
  const { root, parent, child } = edgeFixture();
  reject(() => narrowDelegationEnvelopeV2(root, parent, child, EXPIRY), "root_authority_expired");
  parent.budget.expires_at = NOW;
  child.parent = delegationParentReferenceV2(parent);
  reject(() => narrowDelegationEnvelopeV2(root, parent, child, NOW), "envelope_expired");
  const leaf = rootEnvelope(root); leaf.budget.remaining_depth = 0;
  const impossible = childOf(root, leaf); impossible.budget.remaining_depth = 0;
  reject(() => narrowDelegationEnvelopeV2(root, leaf, impossible, NOW), "budget_widening:remaining_depth");
  const noChildren = rootEnvelope(root); noChildren.budget.max_total_children = 0; noChildren.budget.max_concurrent_children = 0;
  const noChild = childOf(root, noChildren);
  reject(() => narrowDelegationEnvelopeV2(root, noChildren, noChild, NOW), "parent_cannot_delegate");
  const oneEnvelope = rootEnvelope(root); oneEnvelope.budget.max_total_envelopes = 1;
  const noEnvelope = childOf(root, oneEnvelope); noEnvelope.budget.max_total_envelopes = 1;
  reject(() => narrowDelegationEnvelopeV2(root, oneEnvelope, noEnvelope, NOW), "budget_widening:max_total_envelopes");
  reject(() => narrowDelegationEnvelopeV2(root, null, rootEnvelope(root), "2026-02-30T00:00:00.000Z"), "invalid_timestamp");
});

test("complete ancestry refuses absent ancestors, wrong roots, repeated ids/spans/executions and depth >32", () => {
  const { root, parent, child } = edgeFixture();
  const grandchild = childOf(root, child, "grant-a");
  reject(() => validateDelegationAncestryV2(root, [child, grandchild], NOW), "missing_parent");
  reject(() => validateDelegationAncestryV2(root, [parent, grandchild], NOW), "parent_reference_mismatch");
  reject(() => validateDelegationAncestryV2(root, [parent, child, parent], NOW));
  for (const key of ["envelope_id", "span_id", "execution_id"]) {
    const changed = structuredClone(grandchild); changed[key] = parent[key];
    reject(() => validateDelegationAncestryV2(root, [parent, child, changed], NOW));
  }
  const other = rootAuthority(); other.authority_id = "other-root";
  reject(() => validateDelegationAncestryV2(other, [parent, child], NOW), "root_authority_reference_mismatch");
  reject(() => validateDelegationAncestryV2(root, new Array(2), NOW), "invalid_ancestry_bound");
  reject(() => validateDelegationAncestryV2(root, Array(34).fill(parent), NOW), "invalid_ancestry_bound");
  // Upper bound exercised with a complete, explicitly linked 32-edge chain.
  root.budget.remaining_depth = 32;
  root.budget.max_total_envelopes = 40;
  const chain = [rootEnvelope(root)];
  for (let i = 0; i < 32; i++) chain.push(childOf(root, chain.at(-1), i % 2 ? "grant-a" : "grant-b"));
  assert.equal(validateDelegationAncestryV2(root, chain, NOW).at(-1).generation, 32);
});

test("hostile JSON, unknown fields, credentials, ambiguous paths, duplicates and unsafe bounds are refused", () => {
  const cyclic = rootAuthority(); cyclic.revisions.policy = cyclic;
  reject(() => validateRootAuthorityV2(cyclic), "json_cycle");
  const getter = rootAuthority(); Object.defineProperty(getter, "authority_id", { enumerable: true, get() { throw Error("getter must not run"); } });
  reject(() => validateRootAuthorityV2(getter), "invalid_json_property");
  for (const mutate of [
    r => { r.extra = true; }, r => { r.execution_grants[0].runtime.actual_model = "configured-echo"; },
    r => { r.budget.max_cost_micros = NaN; }, r => { r.budget.max_runtime_ms = Infinity; },
    r => { r.budget.max_attempts = Number.MAX_SAFE_INTEGER + 1; }, r => { r.budget.max_attempts = -0; },
    r => { r.authority_id = "bad\uD800"; }, r => { r.authority_id = "trailing\n"; }, r => { r.authority_id = "bad\uDC00"; },
    r => { r.execution_grants = new Array(2); }, r => { r.execution_grants.length = 65; },
    r => { r.execution_grants[0].runtime.required_capabilities = ["a", "a"]; },
    r => { r.execution_grants[0].runtime.required_capabilities[Symbol("extra")] = true; },
    r => { r.issuer_host_id = undefined; }, r => { r.budget.expires_at = "2026-02-30T00:00:00.000Z"; },
    r => { r.source_origin.dirty_state_fingerprint = "dirty"; },
    r => { r.execution_grants[0].authority_ceiling.readable_resources.push(resource("worktree-a")); },
    r => { Object.defineProperty(r, "hidden", { value: true }); }, r => { r[Symbol("hidden")] = true; },
    r => { Object.setPrototypeOf(r, { hidden: true }); },
  ]) { const root = rootAuthority(); mutate(root); reject(() => validateRootAuthorityV2(root)); }
  const credentials = ["Bearer credential", "TOKEN=credential", "https://user:password@example.com/path", "sk_abcdefgh", "github_pat_123456789012", "xoxb-abcdefgh", "glpat-abcdefgh", "AKIAABCDEFGHIJKL", "AIza12345678901234567890", "ya29.abcdefgh", "SG.abcdefgh.ijklmnop", "whsec_abcdefgh", "sk-proj-abcdefgh", "sq0atp-abcdefgh", "eyJabcdefgh.ijklmnop."];
  for (const value of credentials) {
    const root = rootAuthority(); root.execution_grants[0].flow_binding.reason = value;
    reject(() => validateRootAuthorityV2(root), "sensitive_credential");
    assert.equal(schemaRoot(root), false);
  }
  for (const path of ["/absolute", "//server/file", "../escape", "src/../escape", "src/./file", "src//file", "src/", "C:/file", "C:file", "src\\file", "src/../", "..", "", "src/\u0085file", "a".repeat(513), "😀".repeat(513)]) {
    const root = rootAuthority(); root.execution_grants[0].authority_ceiling.readable_resources[0].path = path;
    assert.equal(schemaRoot(root), false, path);
    reject(() => validateRootAuthorityV2(root), "invalid_resource_path");
    const { child } = edgeFixture(); child.execution_authority.readable_resources[0].path = path;
    assert.equal(schemaEnvelope(child), false, path);
    reject(() => validateDelegationEnvelopeV2(child), "invalid_resource_path");
  }
  for (const path of ["src/\u0000file", "src/\nfile", "src/\u007ffile"]) {
    const root = rootAuthority(); root.execution_grants[0].authority_ceiling.readable_resources[0].path = path;
    assert.equal(schemaRoot(root), false);
    reject(() => validateRootAuthorityV2(root), "invalid_json_text");
  }
  for (const path of ["a".repeat(512), "😀".repeat(512)]) {
    const root = rootAuthority(); root.delegation_ceiling.readable_resources.push(resource("worktree-a", path));
    assert.equal(schemaRoot(root), true, JSON.stringify(schemaRoot.errors));
    const envelope = rootEnvelope(root);
    assert.equal(schemaEnvelope(envelope), true, JSON.stringify(schemaEnvelope.errors));
    assert.equal(narrowDelegationEnvelopeV2(root, null, envelope, NOW).delegation_ceiling.readable_resources.at(-1).path, path);
  }
  const { root, parent } = edgeFixture();
  for (const field of ["prompts", "credentials", "provider_diagnostics", "runtime_session", "terminal_record"]) {
    const changed = structuredClone(parent); changed[field] = "forbidden";
    reject(() => validateDelegationEnvelopeV2(changed), "unknown_or_missing_property");
  }
  const huge = rootAuthority();
  huge.execution_grants = Array.from({ length: 64 }, (_, i) => {
    const g = structuredClone(huge.execution_grants[0]); g.grant_id = `grant-${i}`;
    g.authority_ceiling.readable_resources = Array.from({ length: 64 }, (_, j) => resource("worktree-a", `a${j}${"b".repeat(500)}`)); return g;
  });
  reject(() => validateRootAuthorityV2(huge), "json_byte_bound");
  assert.equal(validateRootAuthorityV2(root).execution_grants.length, 2);
});

test("normalized serialization/digests survive key-order changes and JSON roundtrip, without authenticating claims", () => {
  const { root, parent, child } = edgeFixture();
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])) : value;
  assert.equal(rootAuthorityDigestV2(root), rootAuthorityDigestV2(reverseKeys(root)));
  assert.equal(delegationEnvelopeDigestV2(child), delegationEnvelopeDigestV2(reverseKeys(child)));
  assert.deepEqual(narrowDelegationEnvelopeV2(reverseKeys(root), reverseKeys(parent), reverseKeys(child), NOW), child);
  assert.deepEqual(validateRootAuthorityV2(JSON.parse(serializeRootAuthorityV2(root))), root);
  assert.deepEqual(validateDelegationEnvelopeV2(JSON.parse(serializeDelegationEnvelopeV2(child))), child);
  const expected = `sha256:${createHash("sha256").update(`${DELEGATION_AUTHORITY_DIGEST_DOMAIN}\0`).update(serializeRootAuthorityV2(root)).digest("hex")}`;
  assert.equal(rootAuthorityDigestV2(root), expected);
  assert.notEqual(expected, `sha256:${createHash("sha256").update(serializeRootAuthorityV2(root)).digest("hex")}`);
  const claim = rootAuthority(); claim.issuer_host_id = "untrusted-host";
  assert.equal(validateRootAuthorityV2(claim).issuer_host_id, "untrusted-host");
  const emptyResources = rootAuthority();
  emptyResources.delegation_ceiling.readable_resources.push(resource("worktree-a", "."));
  assert.equal(validateRootAuthorityV2(emptyResources).delegation_ceiling.readable_resources.at(-1).path, ".");
});

test("existing v1 equality still rejects changed source/runtime/correlation", () => {
  const v1 = { schema_version: "1.0", envelope_id: "11111111-1111-4111-8111-111111111111", generation: 0,
    correlation: { status: "incomplete", reason: "Not observed by host" }, flow_binding: { status: "unbound", reason: "Independent" },
    actor_id: "actor", subject_id: "subject", source: { repository_id: "repo", worktree_id: "tree", source_state_id: "state" },
    authority: { allowed_tools: ["read"], allowed_effects: ["read"], mutable_resources: [], posture: "report-only", approval: "requires_approval", escalation: "deny" },
    budget: { max_attempts: 2, max_depth: 2, max_concurrent_children: 2, max_input_tokens: 2, max_output_tokens: 2, max_cost_micros: 2, expires_at: EXPIRY },
    runtime: { required_capabilities: [], runtime_receipt_ref: "runtime", model_receipt_ref: "model" },
    continuation_id: "continue", cancellation_id: "cancel", revisions: { prompt_revision: "p1", rubric_revision: "r1", policy_revision: "p1" } };
  const child = { ...structuredClone(v1), envelope_id: "22222222-2222-4222-8222-222222222222", generation: 1,
    parent_envelope_id: v1.envelope_id, budget: { ...v1.budget, max_depth: 1 } };
  assert.equal(narrowDelegationEnvelope(v1, child, NOW).generation, 1);
  for (const [key, mutate] of [
    ["source", c => { c.source.worktree_id = "other"; }],
    ["runtime", c => { c.runtime.model_receipt_ref = "other"; }],
    ["correlation", c => { c.correlation.reason = "different observation"; }],
  ]) {
    const changed = structuredClone(child); mutate(changed);
    assert.throws(() => narrowDelegationEnvelope(v1, changed, NOW), error => error.issues.includes(`child ${key} must equal parent ${key}`));
  }
});

test("authority service registers exact ancestry and partitions sibling allocations before effects", async () => {
  const { createDelegationAuthorityService } = await import('../../build/src/delegation-authority-service.js');
  const { createLocalFileDelegationAuthorityStore } = await import('../../build/src/delegation-authority-local-file.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-authority-service-'));
  let allowed = true;
  const host = { now: () => NOW, authorize: async () => allowed, confirmExecution: async () => allowed, confirmReconciliation: async () => allowed };
  const open = () => createDelegationAuthorityService(createLocalFileDelegationAuthorityStore(rootPath), host);
  const service = open();
  try {
  const { root, parent, child } = edgeFixture();
  child.budget.max_concurrent_children = 1;
  await service.issue(root);
  await service.derive(root.authority_id, parent);
  await service.derive(root.authority_id, child);
  assert.equal((await service.admitEffect(root.authority_id, child.envelope_id, 'write')).envelope.envelope_id, child.envelope_id);
  const sibling = { ...structuredClone(child), envelope_id: 'sibling', execution_id: 'sibling-execution', span_id: 'sibling-span' };
  await assert.rejects(service.derive(root.authority_id, sibling), /aggregate_allocation_exhausted/);
  assert.equal((await service.inspect(root.authority_id)).envelopes.length, 2);
  await open().derive(root.authority_id, child);
  assert.equal((await open().inspect(root.authority_id)).envelopes.length, 2);
  const allocation = { inputTokens: 5, outputTokens: 5, costMicros: 10 };
  await service.reserveInvocation(root.authority_id, child.envelope_id, 'invoke-one', allocation);
  await assert.rejects(open().reserveInvocation(root.authority_id, child.envelope_id, 'invoke-one', allocation), /invocation_already_reserved/);
  await assert.rejects(open().reserveInvocation(root.authority_id, child.envelope_id, 'invoke-two', allocation), /active_slot_exhausted/);
  await open().reconcileInvocation(root.authority_id, 'invoke-one', null, true);
  await assert.rejects(open().reserveInvocation(root.authority_id, child.envelope_id, 'invoke-two', allocation), /active_slot_exhausted/);
  await open().reconcileInvocation(root.authority_id, 'invoke-one', { inputTokens: 2, outputTokens: 3, costMicros: 4 }, true);
  await open().reserveInvocation(root.authority_id, child.envelope_id, 'invoke-two', allocation);
  await open().reconcileInvocation(root.authority_id, 'invoke-two', { inputTokens: 6, outputTokens: 3, costMicros: 12 }, true);
  assert.equal((await open().inspect(root.authority_id)).invocations[1].usage.costMicros, 12);
  await assert.rejects(open().reserveInvocation(root.authority_id, child.envelope_id, 'invoke-three', allocation), /accounting_overrun/);
  allowed = false;
  await assert.rejects(service.derive(root.authority_id, child), /host_authorization_refused/);
  await assert.rejects(service.inspect(root.authority_id), /host_authorization_refused/);
  allowed = true;
  await service.cancel(root.authority_id);
  await assert.rejects(open().admitEffect(root.authority_id, child.envelope_id, 'write'), /effect_refused/);
  } finally { fs.rmSync(rootPath, { recursive: true, force: true }); }
});


test("authorized execution binds selected runtime, reserves before launch and retains/reconciles the result", async () => {
  const { createDelegationAuthorityService } = await import('../../build/src/delegation-authority-service.js');
  const { createLocalFileDelegationAuthorityStore } = await import('../../build/src/delegation-authority-local-file.js');
  const { executeAuthorizedDelegation } = await import('../../build/src/delegation-execution.js');
  const { FileAuthorizationLedger } = await import('@kontourai/dispatch');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-authorized-execution-'));
  try {
    const service = createDelegationAuthorityService(createLocalFileDelegationAuthorityStore(rootPath), {
      now: () => NOW, authorize: async () => true, confirmExecution: async () => true, confirmReconciliation: async () => true,
    });
    const { root, parent, child } = edgeFixture();
    await service.issue(root); await service.derive(root.authority_id, parent); await service.derive(root.authority_id, child);
    let calls = 0, retained = null, fail = false, overrun = false, failureRetained = false;
    const runtime = { id: 'selected-runtime', capabilities: () => ({ structuredTools: true, outputTokenLimitFidelity: 'native', streaming: false, abort: true, usage: true }),
      async invoke() { calls++; if (fail) throw new Error('native failure'); return { provider: 'fixture', model: 'configured', outputText: 'child report', toolCalls: [], usage: { inputTokens: overrun ? 8 : 2, outputTokens: 3, costUsd: 0.000004 }, latencyMs: 1 }; } };
    const host = {
      resolveRuntime: async () => ({ runtime, runtimeReceipt: child.execution_binding.runtime.runtime_receipt_ref, modelReceipt: child.execution_binding.runtime.model_receipt_ref }),
      async invokeFenced(_envelope, id, launch) {
        const state = await service.inspect(root.authority_id);
        assert.equal(state.invocations.find((i) => i.invocationId === id).terminal, false);
        return launch();
      },
      async retainResult(result) { retained = result.outputText; },
      async retainFailure(error) { assert.equal(error.message, "native failure"); failureRetained = true; },
    };
    const input = { service, host, dispatchLedger: new FileAuthorizationLedger({ root: path.join(rootPath, 'dispatch') }), authorityId: root.authority_id,
      envelopeId: child.envelope_id, invocationId: 'first', effect: 'write', request: { maxOutputTokens: 5, messages: [{ role: 'user', content: 'work' }] },
      allocation: { inputTokens: 5, outputTokens: 5, costMicros: 10 } };
    const mismatchHost = { ...host, resolveRuntime: async () => ({ runtime, runtimeReceipt: ref('wrong-runtime'), modelReceipt: child.execution_binding.runtime.model_receipt_ref }) };
    await assert.rejects(executeAuthorizedDelegation({ ...input, host: mismatchHost }), /runtime_receipt_mismatch/);
    assert.equal(calls, 0);
    assert.equal((await service.inspect(root.authority_id)).invocations.length, 0);
    await assert.rejects(executeAuthorizedDelegation({ ...input, request: { ...input.request, maxOutputTokens: 6 } }), /runtime_bounds_unsupported/);
    await assert.rejects(executeAuthorizedDelegation({ ...input, request: { ...input.request, tools: [{ name: 'undeclared', inputSchema: {} }] } }), /runtime_authority_unsupported/);
    assert.equal(calls, 0);
    assert.equal((await service.inspect(root.authority_id)).invocations.length, 0);
    await assert.rejects(executeAuthorizedDelegation({ ...input, allocation: { ...input.allocation, costMicros: 0 } }));
    await assert.rejects(executeAuthorizedDelegation({ ...input, signal: AbortSignal.abort() }));
    assert.equal((await service.inspect(root.authority_id)).invocations.length, 0);
    assert.equal((await executeAuthorizedDelegation(input)).outcome, 'succeeded');
    assert.equal(retained, 'child report');
    assert.deepEqual((await service.inspect(root.authority_id)).invocations[0].usage, { inputTokens: 2, outputTokens: 3, costMicros: 4 });
    await assert.rejects(executeAuthorizedDelegation(input), /invocation_already_reserved/);
    assert.equal(calls, 1);
    fail = true;
    await executeAuthorizedDelegation({ ...input, invocationId: 'attempt#failure' });
    assert.equal(failureRetained, true);
    fail = false; overrun = true;
    await assert.rejects(executeAuthorizedDelegation({ ...input, invocationId: 'x'.repeat(240) }), /settlement failed/);
    await assert.rejects(executeAuthorizedDelegation({ ...input, invocationId: 'after-overrun' }), /accounting_overrun/);
    assert.equal((await service.inspect(root.authority_id)).invocations.at(-1).usage.inputTokens, 8);
  } finally { fs.rmSync(rootPath, { recursive: true, force: true }); }
});

for (const scenario of ['undefined-usage', 'array-allocation', 'expired-sibling']) {
  test(`authority admission preserves ledger and holds for ${scenario}`, async () => {
    const { createDelegationAuthorityService } = await import('../../build/src/delegation-authority-service.js');
    const { createLocalFileDelegationAuthorityStore } = await import('../../build/src/delegation-authority-local-file.js');
    const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-admission-boundary-'));
    try {
      let now = NOW;
      const service = createDelegationAuthorityService(createLocalFileDelegationAuthorityStore(rootPath), {
        now: () => now, authorize: async () => true, confirmExecution: async () => true, confirmReconciliation: async () => true,
      });
      const { root, parent, child } = edgeFixture();
      Object.assign(child.budget, { max_attempts: 1, max_input_tokens: 100, max_output_tokens: 100, max_cost_micros: 100,
        max_total_envelopes: 2, max_concurrent_children: 1, expires_at: '2026-10-21T13:00:00.000Z' });
      const sibling = { ...structuredClone(child), envelope_id: 'sibling', execution_id: 'sibling-execution', span_id: 'sibling-span', budget: { ...child.budget, expires_at: EXPIRY } };
      await service.issue(root); await service.derive(root.authority_id, parent); await service.derive(root.authority_id, child); await service.derive(root.authority_id, sibling);
      const allocation = { inputTokens: 1, outputTokens: 1, costMicros: 1 };
      if (scenario === 'array-allocation') {
        await assert.rejects(service.reserveInvocation(root.authority_id, child.envelope_id, 'malformed', Object.assign([], allocation)));
        assert.equal((await service.inspect(root.authority_id)).invocations.length, 0);
      } else {
        await service.reserveInvocation(root.authority_id, child.envelope_id, 'first', allocation);
        if (scenario === 'undefined-usage') {
          await assert.rejects(service.reconcileInvocation(root.authority_id, 'first', undefined, true), /invalid_invocation_usage/);
          assert.equal((await service.inspect(root.authority_id)).invocations[0].usage, null);
          await assert.rejects(service.reserveInvocation(root.authority_id, child.envelope_id, 'second', allocation), /active_slot_exhausted/);
        } else {
          now = '2026-10-21T14:00:00.000Z';
          await service.reserveInvocation(root.authority_id, sibling.envelope_id, 'second', allocation);
          assert.equal((await service.inspect(root.authority_id)).invocations.length, 2);
        }
      }
    } finally { fs.rmSync(rootPath, { recursive: true, force: true }); }
  });
}

test('Flow execution composes real claims with registered authority and controlled runtime', async () => {
  const { startRun, loadRun } = await import('@kontourai/flow');
  const { FileAuthorizationLedger } = await import('@kontourai/dispatch');
  const { createDelegationAuthorityService } = await import('../../build/src/delegation-authority-service.js');
  const { createLocalFileDelegationAuthorityStore } = await import('../../build/src/delegation-authority-local-file.js');
  const { orchestrateDelegationFlow } = await import('../../build/src/delegation-flow-execution.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-flow-execution-'));
  try {
    const definition = { id: 'delegation-fixture', version: '1', execution: { mode: 'multi-cursor', claim_contract_version: '1' },
      steps: [{ id: 'reader', next: null, mutable_resources: [] }], gates: { observation: { step: 'reader', expects: [{ id: 'optional', kind: 'trust.bundle', required: false, description: 'Optional fixture observation', bundle_claim: { claimType: 'fixture.optional' } }] } } };
    const file = path.join(cwd, 'fixture.flow.json'); fs.writeFileSync(file, JSON.stringify(definition));
    const runId = 'delegation-flow'; await startRun(file, { cwd, runId, params: { subject: 'flow-agents#1113' } });
    const root = rootAuthority();
    for (const grant of root.execution_grants) grant.flow_binding = { status: 'bound', flow_run_id: runId, definition: definitionIdentity(definition), flow_step_id: 'reader', gate_attempt: 1 };
    const parent = rootEnvelope(root), child = childOf(root, parent);
    const service = createDelegationAuthorityService(createLocalFileDelegationAuthorityStore(cwd), {
      now: () => NOW, authorize: async () => true, confirmExecution: async () => true, confirmReconciliation: async () => true,
    });
    await service.issue(root); await service.derive(root.authority_id, parent); await service.derive(root.authority_id, child);
    const events = []; let calls = 0, recorded = 0;
    const runtime = { id: 'selected', capabilities: () => ({ structuredTools: true, outputTokenLimitFidelity: 'native', streaming: false, abort: true, usage: true }),
      async invoke() { calls++; assert.ok(events.includes('started')); return { provider: 'fixture', model: 'fixture', outputText: 'observation', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.000001 }, latencyMs: 1 }; } };
    const host = {
      recordScheduleEvent: async (event) => { events.push(event.kind); }, confirmClaim: async (claim, envelope) => claim.step_id === envelope.execution_binding.flow_binding.flow_step_id,
      prepareRequest: async () => ({ messages: [{ role: 'user', content: 'observe' }], maxOutputTokens: 5 }),
      resolveRuntime: async () => ({ runtime, runtimeReceipt: child.execution_binding.runtime.runtime_receipt_ref, modelReceipt: child.execution_binding.runtime.model_receipt_ref }),
      invokeFenced: async (_envelope, _id, invoke) => invoke(), retainResult: async () => {}, retainFailure: async () => {},
      recordMemberOutcome: async (_claim, _envelope, outcome) => { assert.equal(outcome.outcome, 'succeeded'); recorded++; },
    };
    const input = { authorityId: root.authority_id, service, host, dispatchLedger: new FileAuthorizationLedger({ root: path.join(cwd, 'dispatch') }),
      runId, actor: { key: 'fixture-host', kind: 'test' }, seats: [{ stepId: 'reader', envelopeId: child.envelope_id, effect: 'write', allocation: { inputTokens: 5, outputTokens: 5, costMicros: 10 } }], cwd, maxConcurrent: 1 };
    await assert.rejects(orchestrateDelegationFlow({ ...input, host: { ...host, confirmClaim: async () => false } }));
    assert.equal(calls, 0);
    assert.equal((await service.inspect(root.authority_id)).invocations.length, 0);
    await orchestrateDelegationFlow(input);
    assert.equal(calls, 1); assert.equal(recorded, 1);
    assert.equal((await loadRun(runId, cwd)).state.status, 'completed');
    assert.equal((await service.inspect(root.authority_id)).invocations[0].terminal, true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('context sync requires no tools and retains exact ACK/hash with one bounded retry', async () => {
  const { syncDelegationContext } = await import('../../build/src/delegation-context-sync.js');
  const { FileAuthorizationLedger } = await import('@kontourai/dispatch');
  const { createDelegationAuthorityService } = await import('../../build/src/delegation-authority-service.js');
  const { createLocalFileDelegationAuthorityStore } = await import('../../build/src/delegation-authority-local-file.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-sync-'));
  try {
    const root = rootAuthority(); root.delegation_ceiling.allowed_tools = [];
    root.delegation_ceiling.allowed_effects.push('context-sync');
    for (const grant of root.execution_grants) { grant.authority_ceiling.allowed_tools = []; grant.authority_ceiling.allowed_effects.push('context-sync'); }
    const parent = rootEnvelope(root); parent.execution_authority.allowed_tools = [];
    const child = childOf(root, parent);
    const service = createDelegationAuthorityService(createLocalFileDelegationAuthorityStore(cwd), { now: () => NOW, authorize: async () => true, confirmExecution: async () => true, confirmReconciliation: async () => true });
    await service.issue(root); await service.derive(root.authority_id, parent); await service.derive(root.authority_id, child);
    let calls = 0; const receipts = [];
    const runtime = { id: 'sync-runtime', capabilities: () => ({ structuredTools: true, outputTokenLimitFidelity: 'native', streaming: false, abort: true, usage: true }),
      async invoke(request) { assert.deepEqual(request.tools, []); calls++; return { provider: 'fixture', model: 'fixture', outputText: calls === 1 ? 'received' : 'ACK SYNC run-1', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.000001 }, latencyMs: 1 }; } };
    const host = { resolveRuntime: async () => ({ runtime, runtimeReceipt: child.execution_binding.runtime.runtime_receipt_ref, modelReceipt: child.execution_binding.runtime.model_receipt_ref }),
      invokeFenced: async (_e, _id, invoke) => invoke(), retainResult: async () => {}, retainFailure: async () => {}, retainSyncReceipt: async (receipt) => { receipts.push(receipt); } };
    const input = { authorityId: root.authority_id, envelopeId: child.envelope_id, service, host, dispatchLedger: new FileAuthorizationLedger({ root: path.join(cwd, 'dispatch') }), runId: 'run-1', text: 'folded context', maxOutputTokens: 5, allocation: { inputTokens: 5, outputTokens: 5, costMicros: 10 } };
    const receipt = await syncDelegationContext(input);
    assert.equal(receipt.status, 'acknowledged'); assert.equal(receipt.attempts, 2); assert.equal(calls, 2);
    assert.equal(receipt.contentDigest, `sha256:${createHash('sha256').update('folded context').digest('hex')}`);
    assert.deepEqual(receipts, [receipt]);
    await assert.rejects(syncDelegationContext(input), /invocation_already_reserved/);
    assert.equal(calls, 2);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
