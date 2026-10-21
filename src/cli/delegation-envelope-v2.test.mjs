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
  const definition = definitionIdentity(JSON.parse(readFileSync(new URL("../../node_modules/@kontourai/flow/examples/agent-dev-flow.json", import.meta.url), "utf8")));
  root.execution_grants[1].flow_binding = { status: "bound", flow_run_id: "flow-run-a", definition, flow_step_id: "implement", gate_attempt: 2 };
  const parent = rootEnvelope(root), child = childOf(root, parent);
  assert.deepEqual(narrowDelegationEnvelopeV2(root, parent, child, NOW).execution_binding.flow_binding.definition, definition);
  for (const mutate of [
    f => { f.flow_run_id = "flow-run-b"; }, f => { f.flow_step_id = "other"; },
    f => { f.gate_attempt++; }, f => { f.definition.digest = "f".repeat(64); },
    f => { f.definition.version = "changed"; },
  ]) {
    const changed = structuredClone(child); mutate(changed.execution_binding.flow_binding);
    reject(() => narrowDelegationEnvelopeV2(root, parent, changed, NOW), "execution_grant_binding_mismatch");
  }
  assert.equal(schemaRoot(root), true, JSON.stringify(schemaRoot.errors));
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
  for (const path of ["/absolute", "../escape", "src/../escape", "src/./file", "src//file", "src/", "C:/file", "src\\file", "src/../", "..", ""]) {
    const root = rootAuthority(); root.execution_grants[0].authority_ceiling.readable_resources[0].path = path;
    reject(() => validateRootAuthorityV2(root), "invalid_resource_path");
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
