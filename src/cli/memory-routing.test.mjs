import test from "node:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { buildCandidateVerification } from "@kontourai/survey";
import {
  buildReviewDecisionsFromSession, buildReviewSessionEvents, initialReviewQueueSessionState,
} from "@kontourai/survey/review-workbench";
import { memoryClaim, readMemoryVisibility } from "@kontourai/flow-agents/memory-claims";
import { MAX_DECISION_DEPTH, MAX_DECISION_NODES, MAX_ENVELOPE_NODES, MAX_PEERS, MAX_POLICY_NODES, MAX_SNAPSHOT_DEPTH, MAX_SNAPSHOT_NODES, MAX_VERIFICATIONS, MAX_VERIFICATION_NODES, jsonSnapshot } from "@kontourai/flow-agents/memory-json";
import { memoryAccumulationQuery } from "@kontourai/flow-agents/memory-accumulation";
import {
  DEFAULT_MEMORY_ROUTING_POLICY, MEMORY_ROUTING_RULE_IDS, memoryVisibilityWithin, buildMemoryReviewItem, deriveMemoryRunMetrics, evaluateMemoryRouting, memoryProposedCandidateId,
  memoryReviewItemName, presentMemoryClaims, recomputeMemoryRouting, routeMemoryChange, routeMemoryChanges, verifyMemoryClaimAgainstCurrent,
} from "@kontourai/flow-agents/memory-routing";
import { SCHEMAS, distillFixtureSitting, loadEntityProposals, matchesFixture, readJson } from "./memory-claims-support.mjs";

const ajv = new Ajv({ strict: false, allErrors: true });
const validateDecision = ajv.compile(readJson(SCHEMAS, "memory-routing-decision.schema.json"));
const validateMetrics = ajv.compile(readJson(SCHEMAS, "memory-run-metrics.schema.json"));
const plain = value => JSON.parse(JSON.stringify(value));

const base = {
  subject: { type: "service", id: "widget service", label: "widget service" }, claimType: "knowledge.memory-claim", property: "primary database", value: "PostgreSQL 15", speaker: "user", posture: "stated",
  source: { ref: "claude-code:s:0", locator: "chars:0-40", excerpt: "The widget service uses PostgreSQL 15.", observedAt: "2026-10-28T09:00:00.000Z", role: "user" },
};
const make = (overrides = {}) => memoryClaim({ ...base, ...overrides });
const AGREED = { passes: 2, agreeing: 2 };
/** What Surface's projection says: one current value, or a contest among the named candidates. */
const CURRENT = { outcome: "current", candidateClaimIds: [], supportingClaimIds: [], gapCodes: [] };
const contested = (...args) => { const gaps = Array.isArray(args.at(-1)) ? args.pop() : ["contested-value"]; return { outcome: "contested", candidateClaimIds: [...args].sort(), supportingClaimIds: [], gapCodes: [...gaps].sort() }; };
/** The query the host ran for a claim's slot; routing reads a projection result only together with it. */
const queryFor = claim => memoryAccumulationQuery(claim, "2026-11-02T00:00:00Z");
const change = (claim, extra = {}) => {
  const out = { type: "claim", claim, agreement: AGREED, accumulation: claim.posture === "stated" ? CURRENT : null, ...extra };
  return out.accumulation && !out.accumulationQuery ? { ...out, accumulationQuery: queryFor(claim) } : out;
};
const verification = (claim, result, value = claim.value, verifierId = "stub") => buildCandidateVerification({
  input: { candidateId: memoryProposedCandidateId(claim.id), value, evidence: [{ id: "e1", excerpt: "evidence", locator: "chars:0-1" }] },
  verifier: { id: verifierId, version: "1", method: "deterministic" },
  verdict: result === "abstain" ? { result, abstainReason: "timeout" } : { result },
  createdAt: "2026-11-01T00:00:00.000Z",
});
/** A claim with `supporting` supporting records and one contradiction that sorts before them or after them (Survey orders applicable records by id). */
function contradictionAmong(supporting, position) {
  const claim = make();
  const supports = Array.from({ length: supporting }, (_, i) => verification(claim, "supported", claim.value, `support-${i}`));
  for (let i = 0; i < 500; i++) {
    const contradicting = verification(claim, "contradicted", claim.value, `check-${i}`);
    const placed = position === "last" ? supports.every(record => record.id < contradicting.id) : supports.every(record => contradicting.id < record.id);
    if (placed) return change(claim, { verifications: [...supports, verification(claim, "abstain", claim.value, "gave-up"), contradicting] });
  }
  throw new Error(`no contradicting record sorts ${position}; widen the search`);
}
const lateContradiction = supporting => contradictionAmong(supporting, "last");
const PUBLIC = { kind: "public" };
const only = (...audiences) => ({ kind: "restricted", audiences });
const rulesOf = decision => decision.reasons.map(reason => reason.rule);

// ---------------------------------------------------------------------------
// One isolated case per routing rule. `routes` triggers exactly that rule;
// `passes` are near misses that must stay proposed. Removing or weakening a rule
// breaks its `routes` case; adding a rule without a case breaks the coverage test.

const onCall = make({ property: "on-call owner", value: "Maya Chen" });
const newer = make({ value: "PostgreSQL 16", validTime: { from: "2026-10-30" } });
const replacing = make({ value: "PostgreSQL 16", validTime: { from: "2026-10-30" }, supersedes: [{ claimId: make().id, kind: "succession", reason: "replaces" }] });
const current = make();
const otherPeer = make({ value: "PostgreSQL 17", source: { ...base.source, ref: "other-peer" } });

const RULE_CASES = {
  "contradicted-by-verification": {
    routes: () => { const claim = make({ value: "PostgreSQL 14" }); return change(claim, { verifications: [verification(claim, "contradicted")] }); },
    alsoRoutes: [
      // Survey orders applicable records by id, so pick a contradicting record that sorts AFTER the supporting ones:
      // a rule that only looked at the first record would pass these.
      ["a supported record does not mask a contradiction recorded by another verifier", () => lateContradiction(1)],
      ["the contradiction sorts after several supporting records", () => lateContradiction(3)],
      ["the contradiction sorts before several supporting records", () => contradictionAmong(3, "first")],
    ],
    passes: [
      ["a supported verdict", () => { const claim = make(); return change(claim, { verifications: [verification(claim, "supported")] }); }],
      ["a verifier that abstained is neither a pass nor a fail", () => { const claim = make(); return change(claim, { verifications: [verification(claim, "abstain")] }); }],
      ["a contradiction recorded for a different value no longer applies", () => { const claim = make(); return change(claim, { verifications: [verification(claim, "contradicted", "PostgreSQL 9")] }); }],
      ["a malformed record is ignored, not trusted", () => change(make(), { verifications: [{ result: "contradicted" }] })],
    ],
  },
  "contested-by-accumulation": {
    routes: () => { const claim = make({ value: "PostgreSQL 16" }); return change(claim, { current: [current], accumulation: contested(claim.id, current.id) }); },
    alsoRoutes: [
      ["Surface could give no unique answer for the slot: an invalid projection, whoever its candidates are", () => change(make({ value: "PostgreSQL 16" }), { current: [current], accumulation: { outcome: "invalid", reason: "identity-unresolved", candidateClaimIds: [], supportingClaimIds: [], gapCodes: ["identity-unresolved"] } })],
      ["a replacement Surface has not yet accepted: both candidates stay until a reviewer verifies the successor", () => change(replacing, { current: [current], accumulation: contested(replacing.id, current.id, ["contested-value", "supersession-pending"]) })],
      ["no projection was run and there is another stated claim in the slot: nothing supports calling it uncontested", () => change(make({ value: "PostgreSQL 16" }), { current: [current], accumulation: null })],
    ],
    passes: [
      ["Surface projects one current value", () => change(make({ value: "PostgreSQL 16" }), { current: [current], accumulation: CURRENT })],
      ["Surface accepted the replacement: reviewed and admitted, the slot is current", () => change(replacing, { current: [current], accumulation: CURRENT })],
      ["Surface has no answer, for a reason that is not a contest", () => change(make(), { accumulation: { outcome: "none", reason: "withdrawn", candidateClaimIds: [], supportingClaimIds: [], gapCodes: [] } })],
      ["a contest the claim is not part of: it was excluded as superseded or withdrawn", () => change(make({ value: "PostgreSQL 16" }), { current: [current, otherPeer], accumulation: contested(current.id, otherPeer.id) })],
      ["a plan is never a candidate for the slot, so an unresolved projection of the slot is not its contest", () => { const plan = make({ posture: "proposed", value: "PostgreSQL 16" }); return change(plan, { current: [current], accumulation: { outcome: "invalid", reason: "identity-unresolved", candidateClaimIds: [], supportingClaimIds: [], gapCodes: [] } }); }],
      ["a what-if is never contested, projection or none", () => change(make({ posture: "hypothetical", value: "PostgreSQL 16" }), { current: [current], accumulation: null })],
      ["a property the host declares multi-valued is not projected: Surface has one value policy", () => change(make({ value: "PostgreSQL 16" }), { current: [current], accumulation: null }), { multiValued: ["primary database"] }],
      ["no projection, but nothing else is in the slot, so nothing can contest it", () => change(make(), { accumulation: null })],
      ["no projection and the only other claims are plans or other slots", () => change(make(), { current: [make({ posture: "hypothetical", value: "x" }), make({ property: "other", value: "y" })], accumulation: null })],
    ],
  },
  "consequential-supersession": {
    policy: { consequential: { properties: ["primary database"], subjectTypes: [] } },
    routes: () => change(replacing, { current: [current] }),
    passes: [
      ["a supersession of a property the policy does not mark", () => { const claim = make({ property: "color", value: "teal", supersedes: [{ claimId: make({ property: "color", value: "red" }).id, kind: "succession", reason: "r" }] }); return change(claim, { current: [make({ property: "color", value: "red" })] }); }],
      ["a consequential property with nothing superseded", () => change(make({ value: "PostgreSQL 16", posture: "hypothetical" }), { current: [] })],
    ],
    alsoRoutes: [
      ["a consequential subject type", () => change(replacing, { current: [current] }), { consequential: { properties: [], subjectTypes: ["Service"] } }],
      ["the wildcard", () => change(replacing, { current: [current] }), { consequential: { properties: ["*"], subjectTypes: [] } }],
    ],
  },
  "entity-identity-change": {
    routes: () => ({ type: "entity", proposal: loadEntityProposals().merge }),
    passes: [],
    alsoRoutes: [
      ...["split", "alias"].map(operation => [operation, () => ({ type: "entity", proposal: loadEntityProposals()[operation] })]),
      ["a proposal with several alternatives records every operation", () => ({ type: "entity", proposal: loadEntityProposals().multi })],
    ],
  },
  "low-extraction-agreement": {
    routes: () => change(make(), { agreement: { passes: 2, agreeing: 1 } }),
    passes: [
      ["every pass agreed", () => change(make())],
      ["a lower bar the share meets", () => change(make(), { agreement: { passes: 2, agreeing: 1 } }), { minAgreement: 0.5 }],
    ],
    alsoRoutes: [
      ["agreement that was never measured", () => change(make(), { agreement: null })],
      ["too few passes to measure it", () => change(make(), { agreement: { passes: 1, agreeing: 1 } })],
      ["three passes, two agreeing, against a bar of all", () => change(make(), { agreement: { passes: 3, agreeing: 2 } })],
    ],
  },
  "visibility-widening": {
    routes: () => change(make({ visibility: only("user:brian", "team:platform") }), { sourceVisibility: only("user:brian") }),
    passes: [
      ["no visibility declared: it reads as sealed, so omission can only narrow, never widen", () => change(make(), { sourceVisibility: PUBLIC })],
      ["a subset of the source's audiences", () => change(make({ visibility: only("user:brian") }), { sourceVisibility: only("user:brian", "team:platform") })],
      ["the same audiences as the source, in another order", () => change(make({ visibility: only("user:brian", "team:platform") }), { sourceVisibility: only("team:platform", "user:brian") })],
      ["public from a public source", () => change(make({ visibility: PUBLIC }), { sourceVisibility: PUBLIC })],
      ["restricted from a public source: narrower", () => change(make({ visibility: only("user:brian") }), { sourceVisibility: PUBLIC })],
      ["sealed is the narrowest and fits inside anything, even an undeclared bound", () => change(make({ visibility: only() }))],
      ["inside every current claim in the slot", () => change(make({ visibility: only("user:brian") }), { sourceVisibility: only("user:brian", "team:platform"), current: [make({ visibility: only("user:brian", "team:platform"), source: { ...base.source, ref: "s2" } })] })],
      ["nobody declares anything anywhere: all sealed, nothing wider than sealed", () => change(make({ source: { ...base.source, ref: "s2" } }), { current: [make({})] })],
    ],
    alsoRoutes: [
      ["public from a restricted source", () => change(make({ visibility: PUBLIC }), { sourceVisibility: only("user:brian") })],
      ["public from an undeclared source: undeclared is sealed", () => change(make({ visibility: PUBLIC }))],
      ["a declared visibility from an undeclared source: undeclared is sealed, not 'anything'", () => change(make({ visibility: only("user:brian") }))],
      ["one extra audience beyond the source's", () => change(make({ visibility: only("user:brian", "team:other") }), { sourceVisibility: only("user:brian", "team:platform") })],
      ["wider than a narrower current claim in the slot", () => change(make({ value: "PostgreSQL 15", visibility: only("user:brian", "team:platform") }), { sourceVisibility: only("user:brian", "team:platform"), current: [make({ visibility: only("user:brian"), source: { ...base.source, ref: "s2" } })] })],
      ["declared, against a current claim that declares none (sealed)", () => change(make({ value: "PostgreSQL 15", visibility: only("user:brian"), source: { ...base.source, ref: "s2" } }), { sourceVisibility: only("user:brian"), current: [make({})] })],
      ["a bound that is not a readable visibility is sealed, never wider", () => change(make({ visibility: only("user:brian") }), { sourceVisibility: { kind: "restricted", audiences: "user:brian" } })],
    ],
  },
};

test("coverage pin: every routing rule the code evaluates has a case here, and every case names a rule the code evaluates", () => {
  assert.deepEqual(Object.keys(RULE_CASES).sort(), [...MEMORY_ROUTING_RULE_IDS].sort());
  const evaluated = new Set([...routeMemoryChange(change(make())).evaluated, ...routeMemoryChange(RULE_CASES["entity-identity-change"].routes()).evaluated]);
  assert.deepEqual([...evaluated].sort(), [...MEMORY_ROUTING_RULE_IDS].sort(), "a rule listed but never run, or run but not listed");
});

for (const [rule, spec] of Object.entries(RULE_CASES)) {
  const policyFor = extra => ({ ...(spec.policy ?? {}), ...(extra ?? {}) });

  test(`rule ${rule}: routes exactly on its trigger, and only for that reason`, () => {
    const decision = routeMemoryChange(spec.routes(), policyFor());
    assert.equal(decision.outcome, "routed");
    assert.deepEqual(rulesOf(decision), [rule], "no other rule may be doing this rule's job");
    assert.ok(Object.keys(decision.reasons[0].detail).length > 0, "the reason says why");
    assert.deepEqual(recomputeMemoryRouting(decision), { ok: true, mismatches: [] });
    assert.equal(validateDecision(plain(decision)), true, JSON.stringify(validateDecision.errors));
    for (const [name, build, policy] of spec.alsoRoutes ?? []) {
      const other = routeMemoryChange(build(), policyFor(policy));
      assert.deepEqual(rulesOf(other), [rule], name);
    }
  });

  for (const [name, build, policy] of spec.passes) {
    test(`rule ${rule}: near miss stays proposed: ${name}`, () => {
      const decision = routeMemoryChange(build(), policyFor(policy));
      assert.equal(decision.outcome, "proposed", JSON.stringify(decision.reasons));
      assert.deepEqual(decision.reasons, []);
    });
  }
}

test("uncontested claims are recorded as proposed, and every claim rule is shown to have run", () => {
  const decision = routeMemoryChange(change(make()));
  assert.equal(decision.outcome, "proposed");
  assert.deepEqual(decision.evaluated, MEMORY_ROUTING_RULE_IDS.filter(id => id !== "entity-identity-change"));
  assert.equal(routeMemoryChange(RULE_CASES["entity-identity-change"].routes()).evaluated.join(), "entity-identity-change");
});

test("a change that trips several rules records every reason, in rule order", () => {
  const claim = make({ value: "PostgreSQL 16", visibility: only("user:brian", "team:platform") });
  const decision = routeMemoryChange(change(claim, { current: [current], agreement: { passes: 2, agreeing: 1 }, sourceVisibility: only("user:brian"), verifications: [verification(claim, "contradicted")], accumulation: contested(claim.id, current.id) }));
  assert.deepEqual(rulesOf(decision), ["contradicted-by-verification", "contested-by-accumulation", "low-extraction-agreement", "visibility-widening"]);
});

// ---------------------------------------------------------------------------
// Recomputation

test("recomputation detects an edited outcome, an edited input, a changed policy and a drifted rule list", () => {
  const routed = routeMemoryChange(RULE_CASES["contested-by-accumulation"].routes());
  assert.equal(recomputeMemoryRouting(routed).ok, true);

  const flipped = { ...routed, outcome: "proposed", reasons: [] };
  assert.match(recomputeMemoryRouting(flipped).mismatches.join(), /outcome: recorded proposed, recomputed routed/);

  // The projection fact is an input: editing it from "contested" to "current" changes what the rules read, and the outcome with it.
  const edited = plain(routed);
  edited.input.accumulation = { ...edited.input.accumulation, outcome: "current", candidateClaimIds: [], gapCodes: [] };
  const editedCheck = recomputeMemoryRouting(edited);
  assert.equal(editedCheck.ok, false);
  assert.match(editedCheck.mismatches.join("\n"), /outcome: recorded routed, recomputed proposed/);

  const repolicied = plain(routed);
  repolicied.policy.multiValued = ["primary database"]; // the host stopped projecting this property
  assert.match(recomputeMemoryRouting(repolicied).mismatches.join("\n"), /outcome|digest/);

  const drifted = plain(routed);
  drifted.evaluated = drifted.evaluated.slice(1);
  assert.match(recomputeMemoryRouting(drifted).mismatches.join("\n"), /evaluated rules differ/);

  const tampered = plain(routed);
  tampered.input.claim.value = "MySQL";
  assert.match(recomputeMemoryRouting(tampered).mismatches.join("\n"), /id is not the digest/);
});

test("a stored input may not drop a peer's visibility baseline to clear a widening", () => {
  const narrow = make({ visibility: only("user:brian") });
  const wide = routeMemoryChange(change(make({ value: "PostgreSQL 15", source: { ...base.source, ref: "s2" }, visibility: only("user:brian", "public") }), { current: [narrow], sourceVisibility: only("user:brian", "public") }));
  assert.deepEqual(rulesOf(wide), ["visibility-widening"]);
  const edited = plain(wide);
  edited.input.baselines = edited.input.baselines.filter(base => base.ref === "source");
  Object.assign(edited, evaluateMemoryRouting(edited.input, edited.policy));
  const check = recomputeMemoryRouting(edited);
  assert.equal(check.ok, false, "outcome and reasons were recomputed to match the edit; the dropped baseline still refuses it");
  assert.match(check.mismatches.join("\n"), /baselines do not match the embedded current claims/);
});

test("one claim has one decision id, however its audiences or edges were ordered", () => {
  const a = routeMemoryChange(change(make({ visibility: only("b", "a") }), { sourceVisibility: only("b", "a") }));
  const b = routeMemoryChange(change(make({ visibility: only("a", "b", "a") }), { sourceVisibility: only("a", "b") }));
  assert.equal(a.id, b.id);
  const edges = [{ claimId: make({ value: "x" }).id, kind: "succession", reason: "r" }, { claimId: make({ value: "y" }).id, kind: "correction", reason: "r" }];
  assert.equal(routeMemoryChange(change(make({ supersedes: edges }))).id, routeMemoryChange(change(make({ supersedes: [...edges].reverse() }))).id);
});

test("the Kit's visibility order is Surface's lattice (surface@6.3.0 meetVisibility): the pinned release answers Surface's own meet vectors", () => {
  const sealed = only();
  const vectors = [[PUBLIC, PUBLIC, true], [only("a"), PUBLIC, true], [PUBLIC, only("a"), false], [only("a"), only("a", "b"), true], [only("a", "b"), only("a"), false],
    [only("a"), only("b"), false], [sealed, only("a"), true], [sealed, sealed, true], [only("a"), sealed, false], [sealed, PUBLIC, true], [PUBLIC, sealed, false],
    // unreadable is sealed on either side, never wider
    [{ kind: "restricted", audiences: [1] }, only("a"), true], [only("a"), { kind: "restricted", audiences: [1] }, false], [undefined, only("a"), true], [only("a"), undefined, false], [undefined, undefined, true], [PUBLIC, undefined, false]];
  for (const [inner, outer, within] of vectors) assert.equal(memoryVisibilityWithin(inner, outer), within, `${JSON.stringify(inner)} within ${JSON.stringify(outer)}`);
});


test("routing is deterministic: the same inputs give the same decision id, whatever order current claims arrive in", () => {
  const a = make({ value: "PostgreSQL 16" }), b = make({ value: "PostgreSQL 17" });
  const first = routeMemoryChange(change(make({ value: "PostgreSQL 18" }), { current: [a, b] }));
  const second = routeMemoryChange(change(make({ value: "PostgreSQL 18" }), { current: [b, a] }));
  assert.equal(first.id, second.id);
  assert.notEqual(routeMemoryChange(change(make({ value: "PostgreSQL 18" }), { current: [a, b] }), { minAgreement: 0.5 }).id, first.id);
});

test("a slot with more current claims than the bound is refused rather than silently truncated", () => {
  const many = Array.from({ length: 65 }, (_, i) => make({ value: `PostgreSQL ${i}`, source: { ...base.source, ref: `s:${i}` } }));
  assert.throws(() => routeMemoryChange(change(make({ value: "x" }), { current: many })), /more than 64 current claims/);
});

test("policy is validated", () => {
  for (const bad of [{ minPasses: 0 }, { minAgreement: 1.5 }, { version: "2.0" }, { multiValued: [""] }]) assert.throws(() => routeMemoryChange(change(make()), bad));
  assert.deepEqual(DEFAULT_MEMORY_ROUTING_POLICY.consequential, { properties: [], subjectTypes: [] });
});

// ---------------------------------------------------------------------------
// Survey verification glue

test("verifyMemoryClaimAgainstCurrent runs a Survey verifier against the same-slot claims and its record binds to the review candidate", async () => {
  const claim = make({ value: "PostgreSQL 16" });
  const seen = [];
  const verifier = { id: "stub", version: "1", method: "deterministic", async verify(input) { seen.push(input); return { result: "contradicted" }; } };
  assert.equal(await verifyMemoryClaimAgainstCurrent(claim, [make({ property: "color", value: "red" })], verifier), undefined, "nothing in the slot to check against");
  const record = await verifyMemoryClaimAgainstCurrent(claim, [current], verifier);
  assert.equal(record.result, "contradicted");
  assert.equal(record.candidateId, memoryProposedCandidateId(claim.id));
  assert.equal(seen[0].evidence[0].excerpt, current.source.excerpt);
  const decision = routeMemoryChange(change(claim, { verifications: [record] }));
  assert.deepEqual(rulesOf(decision), ["contradicted-by-verification"]);
});

// ---------------------------------------------------------------------------
// Survey review items

function reviewSession(item, { decision, actorId = "person:reviewer", reviewedAt = "2026-11-02T10:00:00.000Z", editedValue }) {
  return { ...initialReviewQueueSessionState([item]), actorId, reviewedAt, decisionsByItemName: { [item.metadata.name]: decision }, ...(editedValue !== undefined ? { editedValuesByItemName: { [item.metadata.name]: editedValue } } : {}) };
}

test("a routed claim becomes a Survey current/proposed ReviewItem; verification records ride on the proposed candidate; unrouted and entity changes make none", () => {
  const claim = make({ value: "PostgreSQL 16" });
  const record = verification(claim, "contradicted");
  const decision = routeMemoryChange(change(claim, { current: [current], verifications: [record], accumulation: contested(claim.id, current.id) }));
  const item = buildMemoryReviewItem(decision);
  assert.equal(item.metadata.name, memoryReviewItemName(claim.id));
  assert.deepEqual(item.spec.candidates.map(candidate => candidate.role), ["current", "proposed"]);
  assert.equal(item.spec.candidates[0].value, "PostgreSQL 15");
  assert.equal(item.spec.candidates[1].value, "PostgreSQL 16");
  assert.deepEqual(item.spec.candidates[1].verifications, [record]);
  assert.equal(item.metadata.labels["memory.posture"], "stated");
  assert.match(item.spec.rationale, /contradicted-by-verification, contested-by-accumulation/);
  // Survey's own queue accepts and navigates it.
  assert.equal(initialReviewQueueSessionState([item]).activeItemName, item.metadata.name);

  const alone = buildMemoryReviewItem(routeMemoryChange(change(make(), { agreement: { passes: 2, agreeing: 1 } })));
  assert.deepEqual(alone.spec.candidates.map(candidate => candidate.role), ["proposed"]);
  assert.equal(buildMemoryReviewItem(routeMemoryChange(change(make()))), undefined);
  assert.equal(buildMemoryReviewItem(routeMemoryChange(RULE_CASES["entity-identity-change"].routes())), undefined);
});

// ---------------------------------------------------------------------------
// End to end over the real distill fixtures

const POLICY = { consequential: { properties: ["primary database"], subjectTypes: [] } };
const SOURCE_VISIBILITY = only("user:fixture");

async function endToEnd() {
  const earlier = await distillFixtureSitting(0);
  const later = await distillFixtureSitting(1, { current: earlier.result.claims });
  // What Surface's real projection said about each stated claim's slot at that point; see accumulation.json.
  const facts = readJson(import.meta.dirname, "fixtures", "memory-claims", "accumulation.json").scenarios;
  const factOf = (scenario, claim) => { const entry = facts[scenario].facts[claim.id]; return entry === undefined ? null : (entry.fact ?? entry); };
  const changesFor = (result, currentClaims, scenario) => result.claims.map(claim => change(claim, { current: currentClaims, agreement: result.agreement[claim.id], sourceVisibility: SOURCE_VISIBILITY, accumulation: factOf(scenario, claim) }));
  const first = routeMemoryChanges(changesFor(earlier.result, [], "sitting0"), POLICY);
  const second = routeMemoryChanges(changesFor(later.result, earlier.result.claims, "sitting1"), POLICY);
  return { earlier, later, first, second };
}
const byProperty = (decisions, property) => decisions.find(decision => decision.input.claim.property === property);

test("the fixture run routes exactly what the policy says, with the reason for each", async () => {
  const { first, second } = await endToEnd();
  assert.deepEqual(first.map(decision => [decision.input.claim.property, decision.outcome, rulesOf(decision)]), [
    ["primary database", "proposed", []],
    ["on-call owner", "proposed", []],
    ["retry budget", "routed", ["low-extraction-agreement"]],
  ]);
  assert.deepEqual(second.map(decision => [decision.input.claim.property, decision.input.claim.posture, decision.outcome, rulesOf(decision)]), [
    // Surface keeps both candidates until a reviewer verifies the successor, so the replacement is contested as well as consequential.
    ["primary database", "stated", "routed", ["contested-by-accumulation", "consequential-supersession"]],
    ["retry budget", "stated", "routed", ["contested-by-accumulation"]],
    ["on-call owner", "retracted", "proposed", []],
    ["sharding technology", "hypothetical", "proposed", []],
    ["lead", "stated", "routed", ["low-extraction-agreement"]],
  ]);
  for (const decision of [...first, ...second]) {
    assert.equal(validateDecision(plain(decision)), true, JSON.stringify(validateDecision.errors));
    assert.equal(recomputeMemoryRouting(decision).ok, true);
  }
  const { expected, actual } = matchesFixture("routing.json", { policy: POLICY, sitting0: first, sitting1: second });
  assert.equal(actual, expected, "routing.json drifted; rerun with UPDATE_MEMORY_FIXTURES=1 and review the diff");
});

test("metrics: proposed count, routed share, reviewer decisions and review time, recomputed as review happens", async () => {
  const { first, second } = await endToEnd();
  const decisions = [...first, ...second];
  const runId = "memory-run-1";

  const before = deriveMemoryRunMetrics({ runId, decisions });
  assert.equal(validateMetrics(plain(before)), true, JSON.stringify(validateMetrics.errors));
  assert.deepEqual(
    { decisions: before.decisions, claimsProposed: before.claimsProposed, uncontested: before.uncontested, routed: before.routed, routedShare: before.routedShare },
    { decisions: 8, claimsProposed: 8, uncontested: 4, routed: 4, routedShare: 0.5 },
  );
  assert.deepEqual(before.routedByRule, { "low-extraction-agreement": 2, "consequential-supersession": 1, "contested-by-accumulation": 2 });
  assert.deepEqual(before.reviewer, { decisions: 0, confirmed: 0, corrected: 0, rejected: 0, held: 0, pending: 4, unmatched: 0, defectsCaught: 0 });
  assert.equal(before.reviewSeconds, null, "no events, no review time: never estimated");
  assert.equal(before.reviewSecondsPerCaughtDefect, null);

  // Real Survey sessions, one per reviewed item, with the dwell set from the timestamps.
  const items = decisions.map(buildMemoryReviewItem).filter(Boolean);
  assert.equal(items.length, 4);
  const reviews = [
    { item: items.find(item => item.spec.candidates.at(-1).value === "PostgreSQL 16"), decision: "accept-proposed", seconds: 30 },
    { item: items.find(item => item.spec.candidates.at(-1).value === "8 attempts per request"), decision: "keep-current", seconds: 90 },
    { item: items.find(item => item.spec.candidates.at(-1).value === "Priya Rao"), decision: "accept-proposed", seconds: 60, editedValue: "Priya Rao (interim)" },
  ];
  assert.ok(reviews.every(review => review.item), `items: ${items.map(item => item.spec.target)}`);
  const reviewDecisions = [], reviewEvents = [];
  reviews.forEach((review, index) => {
    const session = reviewSession(review.item, review);
    const start = Date.parse("2026-11-02T10:00:00.000Z") + index * 3_600_000;
    reviewDecisions.push(...buildReviewDecisionsFromSession(session));
    reviewEvents.push(...buildReviewSessionEvents(session, `session-${index}`).map(event => {
      const at = event.spec.eventType === "decision-submitted" ? start + review.seconds * 1000 : start;
      return { ...event, spec: { ...event.spec, occurredAt: new Date(at).toISOString() } };
    }));
  });
  // A decision for something this run never routed is counted apart, not as a run decision.
  const stray = buildReviewDecisionsFromSession(reviewSession({ ...items[0], metadata: { ...items[0].metadata, name: "someone-elses-item" } }, { decision: "accept-proposed" }));

  const after = deriveMemoryRunMetrics({ runId, decisions, reviewDecisions: [...reviewDecisions, ...stray], reviewEvents });
  assert.equal(validateMetrics(plain(after)), true, JSON.stringify(validateMetrics.errors));
  assert.deepEqual(after.reviewer, { decisions: 3, confirmed: 1, corrected: 1, rejected: 1, held: 0, pending: 1, unmatched: 1, defectsCaught: 2 });
  assert.equal(after.reviewSeconds, 180);
  assert.equal(after.reviewTimedDecisions, 3);
  assert.equal(after.reviewSecondsPerCaughtDefect, 90);
  assert.equal(after.routed, 4, "review does not change what was routed");

  const { expected, actual } = matchesFixture("metrics.json", { before, after });
  assert.equal(actual, expected, "metrics.json drifted; rerun with UPDATE_MEMORY_FIXTURES=1 and review the diff");
});

test("a claim routed twice in one run is counted once, with its later decision; its one review is not double-counted", async () => {
  const { second } = await endToEnd();
  const first = byProperty(second, "retry budget");
  const again = routeMemoryChange(change(first.input.claim, { current: first.input.current, agreement: AGREED, sourceVisibility: SOURCE_VISIBILITY, accumulation: first.input.accumulation }), { minAgreement: 0.5 });
  assert.notEqual(again.id, first.id, "a different decision about the same claim");
  assert.equal(again.changeId, first.changeId);
  const item = buildMemoryReviewItem(first);
  const review = buildReviewDecisionsFromSession(reviewSession(item, { decision: "accept-proposed", editedValue: "9 attempts per request" }));
  const metrics = deriveMemoryRunMetrics({ runId: "r", decisions: [first, again], reviewDecisions: review });
  assert.deepEqual([metrics.decisions, metrics.claimsProposed], [1, 1]);
  assert.deepEqual([metrics.reviewer.decisions, metrics.reviewer.corrected, metrics.reviewer.defectsCaught, metrics.reviewer.pending], [1, 1, 1, 0]);
});

test("an entity change is matched to the Survey decision on its proposal, whose review item name is the proposal id", () => {
  const { merge } = loadEntityProposals();
  const decision = routeMemoryChange({ type: "entity", proposal: merge });
  const reviewed = [{ apiVersion: "survey.kontourai.io/v1alpha1", kind: "ReviewDecision", metadata: { name: "d1" }, spec: { reviewItemName: merge.id, candidateId: "c", status: "verified", reviewedAt: "2026-11-02T10:00:00.000Z" } }];
  const metrics = deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: reviewed });
  assert.deepEqual([metrics.claimsProposed, metrics.routed, metrics.reviewer.confirmed, metrics.reviewer.pending], [0, 1, 1, 0]);
  assert.equal(deriveMemoryRunMetrics({ runId: "r", decisions: [decision] }).reviewer.pending, 1);
});

test("when a reviewer changes their mind the later decision stands, whatever order the decisions arrive in", async () => {
  const { second } = await endToEnd();
  const decision = byProperty(second, "retry budget");
  const item = buildMemoryReviewItem(decision);
  const rejected = buildReviewDecisionsFromSession(reviewSession(item, { decision: "keep-current", reviewedAt: "2026-11-02T10:00:00.000Z" }));
  const confirmed = buildReviewDecisionsFromSession(reviewSession(item, { decision: "accept-proposed", reviewedAt: "2026-11-02T11:00:00.000Z" }));
  for (const order of [[...rejected, ...confirmed], [...confirmed, ...rejected]]) {
    const metrics = deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: order });
    assert.deepEqual([metrics.reviewer.confirmed, metrics.reviewer.rejected, metrics.reviewer.decisions, metrics.reviewer.pending], [1, 0, 1, 0]);
  }
});

test("a held decision is a reviewer decision with no resolution: not pending, not a defect caught", async () => {
  const { second } = await endToEnd();
  const decision = byProperty(second, "lead");
  const item = buildMemoryReviewItem(decision);
  const session = { ...reviewSession(item, { decision: "could-not-confirm" }), notesByItemName: { [item.metadata.name]: "Could not reach the source." } };
  const metrics = deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: buildReviewDecisionsFromSession(session) });
  assert.deepEqual(metrics.reviewer, { decisions: 1, confirmed: 0, corrected: 0, rejected: 0, held: 1, pending: 0, unmatched: 0, defectsCaught: 0 });
});

// ---------------------------------------------------------------------------
// Recall: no claim is presented without its posture

test("recall: every presented claim carries its posture and review label, in structure and in text", async () => {
  const { earlier, later, first, second } = await endToEnd();
  const claims = [...earlier.result.claims, ...later.result.claims];
  const { presented, withheld } = presentMemoryClaims(claims, { routing: [...first, ...second] });
  assert.equal(withheld.length, 0);
  assert.equal(presented.length, claims.length);
  for (const claim of presented) {
    assert.ok(["stated", "proposed", "hypothetical", "retracted"].includes(claim.posture));
    assert.ok(["unreviewed", "in-review", "confirmed", "corrected"].includes(claim.review.label));
    assert.ok(claim.text.startsWith(`[${claim.posture} · ${claim.review.label}]`), claim.text);
  }
  const citus = presented.find(claim => claim.value === "Citus");
  assert.equal(citus.posture, "hypothetical", "a what-if is never presented as a fact");
  assert.equal(citus.review.routing, "uncontested");
  const routed = presented.find(claim => claim.value === "8 attempts per request");
  assert.deepEqual([routed.review.label, routed.review.routing, routed.review.reasons], ["in-review", "routed", ["contested-by-accumulation"]]);
});

test("recall without routing information still labels the claim unreviewed and says it was never evaluated", async () => {
  const { earlier } = await endToEnd();
  const { presented } = presentMemoryClaims(earlier.result.claims);
  assert.ok(presented.every(claim => claim.review.label === "unreviewed" && claim.review.routing === "not-evaluated"));
});

test("recall shows what the reviewer decided: a corrected claim presents the reviewer's value, and a rejection applies even without the routing record", async () => {
  const { later, second } = await endToEnd();
  const retry = byProperty(second, "retry budget");
  const item = buildMemoryReviewItem(retry);
  const corrected = buildReviewDecisionsFromSession(reviewSession(item, { decision: "accept-proposed", editedValue: "9 attempts per request" }));
  const out = presentMemoryClaims(later.result.claims, { routing: second, reviewDecisions: corrected });
  const shown = out.presented.find(claim => claim.id === retry.changeId);
  assert.equal(shown.review.label, "corrected");
  assert.equal(shown.value, "9 attempts per request");
  assert.equal(shown.extractedValue, "8 attempts per request");
  assert.match(shown.text, /^\[stated · corrected\] .*= 9 attempts per request$/);
  // The decision is about the claim; the routing record need not travel with it.
  const withoutRouting = presentMemoryClaims(later.result.claims, { reviewDecisions: corrected });
  assert.equal(withoutRouting.presented.find(claim => claim.id === retry.changeId).value, "9 attempts per request");
  const rejected = buildReviewDecisionsFromSession(reviewSession(item, { decision: "reject-proposed" }));
  assert.deepEqual(presentMemoryClaims(later.result.claims, { reviewDecisions: rejected }).withheld, [{ id: retry.changeId, reason: "rejected-in-review" }]);
});

test("recall withholds, and reports, a claim with no posture, a tampered claim, and a claim review rejected; it never prints one bare", async () => {
  const { earlier, later, second } = await endToEnd();
  const good = earlier.result.claims[0];
  const { posture: _dropped, ...noPosture } = plain(good);
  const tampered = { ...plain(good), value: "MySQL" };
  const out = presentMemoryClaims([noPosture, tampered, null, good]);
  assert.deepEqual(out.withheld.map(entry => entry.reason), ["posture-missing", "invalid", "invalid"]);
  assert.deepEqual(out.presented.map(claim => claim.id), [good.id]);

  const retry = byProperty(second, "retry budget");
  const item = buildMemoryReviewItem(retry);
  const rejected = buildReviewDecisionsFromSession(reviewSession(item, { decision: "keep-current" }));
  const result = presentMemoryClaims(later.result.claims, { routing: second, reviewDecisions: rejected });
  assert.deepEqual(result.withheld, [{ id: retry.changeId, reason: "rejected-in-review" }]);
  assert.equal(result.presented.length, later.result.claims.length - 1);

  const confirmed = buildReviewDecisionsFromSession(reviewSession(item, { decision: "accept-proposed" }));
  const accepted = presentMemoryClaims(later.result.claims, { routing: second, reviewDecisions: confirmed });
  assert.equal(accepted.presented.find(claim => claim.id === retry.changeId).review.label, "confirmed");
});

// --- review round 3: which decision, and whose time ----------------------------------------------------------------

function twoDecisions(first, second) {
  const c = make({ value: "16", source: { ...base.source, ref: "s-order" } });
  const decision = routeMemoryChange(change(c, { current: [make()], accumulation: contested(c.id, make().id) }));
  const item = buildMemoryReviewItem(decision);
  const session = (verdict, at) => ({ ...initialReviewQueueSessionState([item]), actorId: "person:reviewer", reviewedAt: at, decisionsByItemName: { [item.metadata.name]: verdict } });
  return { c, decision, item, session, made: [first, second].map(([verdict, at]) => buildReviewDecisionsFromSession(session(verdict, at))[0]) };
}

test("the later decision stands by instant, not by how the timestamp is spelled", () => {
  // 11:00+02:00 is 09:00Z, which is BEFORE 10:00Z, though it sorts after as text.
  const { decision, made } = twoDecisions(["accept-proposed", "2026-11-02T11:00:00+02:00"], ["reject-proposed", "2026-11-02T10:00:00Z"]);
  for (const order of [made, [...made].reverse()]) {
    const metrics = deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: order });
    assert.deepEqual([metrics.reviewer.confirmed, metrics.reviewer.rejected], [0, 1]);
  }
  const { c } = twoDecisions(["accept-proposed", "2026-11-02T11:00:00+02:00"], ["reject-proposed", "2026-11-02T10:00:00Z"]);
  assert.deepEqual(presentMemoryClaims([c], { routing: [decision], reviewDecisions: made }).withheld, [{ id: c.id, reason: "rejected-in-review" }]);
});

test("two spellings of one instant are a tie, and a tie keeps the later entry", () => {
  const { decision, made } = twoDecisions(["accept-proposed", "2026-11-02T10:00:00Z"], ["reject-proposed", "2026-11-02T12:00:00+02:00"]);
  assert.deepEqual([deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: made }).reviewer.rejected, deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: [...made].reverse() }).reviewer.confirmed], [1, 1]);
});

test("review time comes from the session that submitted this decision, not the highest sequence number", () => {
  const { decision, item, session, made } = twoDecisions(["reject-proposed", "2026-11-01T10:00:00.000Z"], ["reject-proposed", "2026-11-02T10:00:00.000Z"]);
  const events = (name, verdict, selectedAt, submittedAt, shift) => buildReviewSessionEvents(session(verdict, selectedAt), name).map(event => ({ ...event, spec: { ...event.spec, sequence: event.spec.sequence + shift, occurredAt: event.spec.eventType === "decision-submitted" ? submittedAt : selectedAt } }));
  // Sequence numbers are per session, so either session may have the higher ones: neither highest nor lowest picks the right one.
  for (const [olderShift, newerShift] of [[3, 0], [0, 3]]) {
    const older = events("session-old", "reject-proposed", "2026-11-01T10:00:00.000Z", "2026-11-01T10:01:40.000Z", olderShift);
    const newer = events("session-new", "reject-proposed", "2026-11-02T10:00:00.000Z", "2026-11-02T10:00:10.000Z", newerShift);
    for (const order of [[...older, ...newer], [...newer, ...older]]) {
      const metrics = deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: made, reviewEvents: order });
      assert.equal(metrics.reviewSeconds, 10, `older shifted ${olderShift}, newer shifted ${newerShift}`);
    }
  }
  const older = events("session-old", "reject-proposed", "2026-11-01T10:00:00.000Z", "2026-11-01T10:01:40.000Z", 3);
  const newer = events("session-new", "reject-proposed", "2026-11-02T10:00:00.000Z", "2026-11-02T10:00:10.000Z", 0);
  assert.ok(item);
  // A submission that names a different decision is not this decision's time.
  const other = newer.map(event => event.spec.eventType === "decision-submitted" ? { ...event, spec: { ...event.spec, reviewDecisionName: "someone-elses" } } : event);
  assert.equal(deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: made, reviewEvents: other }).reviewSeconds, null);
});

test("a decision Survey defines as deciding counts; one it does not define is held, never a confirmation", () => {
  const { decision, made } = twoDecisions(["accept-proposed", "2026-11-02T10:00:00Z"], ["accept-proposed", "2026-11-02T10:00:00Z"]);
  const withStatus = status => [{ ...plain(made[0]), spec: { ...plain(made[0]).spec, status } }];
  assert.equal(deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: withStatus("assumed") }).reviewer.confirmed, 1);
  assert.equal(deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: withStatus("verified") }).reviewer.confirmed, 1);
  for (const status of ["BANANA", "proposed", undefined]) {
    const metrics = deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: withStatus(status) });
    assert.deepEqual([metrics.reviewer.confirmed, metrics.reviewer.held], [0, 1], String(status));
  }
});

// --- review round 4: Surface's reader, exactly -------------------------------------------------------------------------

test("a subject whose type or id holds a colon or a newline survives routing and recomputation unchanged", () => {
  const proposal = loadEntityProposals().merge;
  for (const subjects of [[{ subjectType: ":", subjectId: "x" }, { subjectType: "person", subjectId: "a:b" }], [{ subjectType: "person", subjectId: "\nx" }, { subjectType: "per\nson", subjectId: "y" }]]) {
    const odd = { ...proposal, spec: { ...proposal.spec, alternatives: [{ ...proposal.spec.alternatives[0], subjects }] } };
    const decision = routeMemoryChange({ type: "entity", proposal: odd });
    assert.deepEqual(decision.input.subjects.map(s => [s.subjectType, s.subjectId]).sort(), subjects.map(s => [s.subjectType, s.subjectId]).sort());
    assert.deepEqual(recomputeMemoryRouting(decision), { ok: true, mismatches: [] });
    assert.deepEqual(recomputeMemoryRouting(JSON.parse(JSON.stringify(decision))), { ok: true, mismatches: [] }, "and again after a round trip through JSON");
  }
  const twoOfOne = { ...proposal, spec: { ...proposal.spec, alternatives: [{ ...proposal.spec.alternatives[0], subjects: [{ subjectType: "a:b", subjectId: "c" }, { subjectType: "a", subjectId: "b:c" }] }] } };
  assert.equal(routeMemoryChange({ type: "entity", proposal: twoOfOne }).input.subjects.length, 2, "('a:b','c') and ('a','b:c') are different subjects");
});

test("the visibility order reads audience lists the way Surface does: by own index, never by iterator or inheritance", () => {
  const sealed = only();
  const sparse = new Array(2); sparse[0] = "staff";                     // a hole at index 1
  const proto = Object.getOwnPropertyDescriptor(Array.prototype, "1");
  try {
    Array.prototype[1] = "staff";                                       // the hole would INHERIT "staff" if read by iteration
    const inherited = { kind: "restricted", audiences: sparse };
    assert.equal(memoryVisibilityWithin(only("staff"), inherited), false, "a list with a hole is unreadable, so sealed, so nothing non-sealed fits inside it");
    assert.equal(memoryVisibilityWithin(inherited, only("staff")), true, "and a sealed claim fits anywhere");
    assert.equal(memoryVisibilityWithin(inherited, sealed), true);
    // The strict claim reading agrees: a claim cannot carry it.
    assert.equal(readMemoryVisibility(inherited), undefined);
  } finally {
    if (proto) Object.defineProperty(Array.prototype, "1", proto); else delete Array.prototype[1];
  }
  const iterated = [ "staff" ]; iterated[Symbol.iterator] = function* () { yield "nobody"; };
  assert.equal(memoryVisibilityWithin(only("staff"), { kind: "restricted", audiences: iterated }), true, "read by index, the list is [staff]; the iterator is ignored");
  assert.equal(memoryVisibilityWithin(only("nobody"), { kind: "restricted", audiences: iterated }), false);
  for (const [size, readable] of [[1024, true], [1025, false]]) {
    const many = Array.from({ length: size }, (_, i) => `a${i}`);
    assert.equal(readMemoryVisibility({ kind: "restricted", audiences: many }) !== undefined, readable, `${size} audiences`);
    assert.equal(memoryVisibilityWithin(only("a0"), { kind: "restricted", audiences: many }), readable, `${size} audiences as a bound`);
  }
});

test("a source whose audience list Surface reads as sealed cannot be mistaken for a restricted one by the Kit", () => {
  const sparse = new Array(2); sparse[0] = "staff";
  const proto = Object.getOwnPropertyDescriptor(Array.prototype, "1");
  try {
    Array.prototype[1] = "staff";
    const decision = routeMemoryChange(change(make({ visibility: only("staff") }), { sourceVisibility: { kind: "restricted", audiences: sparse } }));
    assert.deepEqual(rulesOf(decision), ["visibility-widening"], "a staff-visible claim from a sealed source widens");
    assert.deepEqual(decision.input.baselines[0], { ref: "source", visibility: null }, "the unreadable source is recorded as undeclared (sealed)");
    assert.deepEqual(recomputeMemoryRouting(JSON.parse(JSON.stringify(decision))), { ok: true, mismatches: [] });
  } finally {
    if (proto) Object.defineProperty(Array.prototype, "1", proto); else delete Array.prototype[1];
  }
});

test("an unreadable review timestamp never beats a readable one, and a held resolution is never a confirmation", () => {
  const { decision, made } = twoDecisions(["accept-proposed", "2026-11-02T10:00:00Z"], ["reject-proposed", "2026-11-02T11:00:00Z"]);
  const garbled = { ...plain(made[1]), spec: { ...plain(made[1]).spec, reviewedAt: "nonsense" } };
  for (const order of [[made[0], garbled], [garbled, made[0]]]) {
    const metrics = deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: order });
    assert.deepEqual([metrics.reviewer.confirmed, metrics.reviewer.rejected], [1, 0], "the readable decision stands");
  }
  const held = { ...plain(made[0]), spec: { ...plain(made[0]).spec, status: "verified", resolution: "could_not_confirm", resolutionReason: "no access" } };
  assert.deepEqual([deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: [held] }).reviewer.confirmed, deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: [held] }).reviewer.held], [0, 1]);
  const resolved = { ...held, spec: { ...held.spec, resolution: "held" } };
  assert.equal(deriveMemoryRunMetrics({ runId: "r", decisions: [decision], reviewDecisions: [resolved] }).reviewer.held, 1);
});

test("the Kit's visibility order agrees with Surface's meetVisibility on every pair of a grid of good and bad values", async () => {
  const { GRID } = await import("./memory-visibility-grid.mjs");
  const vectors = readJson(import.meta.dirname, "fixtures", "memory-claims", "visibility-grid.vectors.json");
  assert.deepEqual(vectors.names, GRID.map(([name]) => name), "the grid and the committed matrix are the same grid");
  assert.ok(GRID.length >= 30);
  const disagreements = [];
  GRID.forEach(([nameA, a], i) => GRID.forEach(([nameB, b], j) => {
    if (memoryVisibilityWithin(a(), b()) !== vectors.matrix[i][j]) disagreements.push(`${nameA} within ${nameB}: Surface says ${vectors.matrix[i][j]}`);
  }));
  assert.deepEqual(disagreements, []);
});

// --- the projection fact is an input like any other ---------------------------------------------------------------

test("the projection fact is validated and put in canonical form at the door, so one situation has one decision id", () => {
  const claim = make({ value: "PostgreSQL 16" });
  const a = routeMemoryChange(change(claim, { current: [current], accumulation: { outcome: "contested", candidateClaimIds: [current.id, claim.id], supportingClaimIds: [], gapCodes: ["contested-value", "supersession-pending"] } }));
  const b = routeMemoryChange(change(claim, { current: [current], accumulation: { outcome: "contested", candidateClaimIds: [claim.id, current.id], supportingClaimIds: [], gapCodes: ["supersession-pending", "contested-value"], extraneous: ["ignored"], pendingEventIds: [] } }));
  assert.equal(a.id, b.id);
  assert.deepEqual(a.input.accumulation.candidateClaimIds, [...a.input.accumulation.candidateClaimIds].sort());
  for (const bad of [{}, { outcome: "current" }, { outcome: "maybe", candidateClaimIds: [], supportingClaimIds: [], gapCodes: [] }, { outcome: "current", candidateClaimIds: [1], supportingClaimIds: [], gapCodes: [] }, "contested"]) {
    assert.throws(() => routeMemoryChange(change(claim, { accumulation: bad })), /accumulation projection result/, JSON.stringify(bad));
  }
});

test("a stored decision whose projection fact was edited or is not canonical is refused even when its digest was recomputed to match", () => {
  const claim = make({ value: "PostgreSQL 16" });
  const routed = routeMemoryChange(change(claim, { current: [current], accumulation: contested(claim.id, current.id) }));
  assert.equal(recomputeMemoryRouting(routed).ok, true);
  // Whoever edits a stored decision can recompute its id; only checks on the input itself stand after that.
  const rehash = d => { d.id = `sha256:${createHash("sha256").update(canonicalJson({ input: d.input, policy: d.policy })).digest("hex")}`; return d; };
  for (const [what, edit] of [["not an object", d => { d.input.accumulation = "contested"; }], ["an unknown outcome", d => { d.input.accumulation.outcome = "maybe"; }],
    ["candidates not a list", d => { d.input.accumulation.candidateClaimIds = "x"; }], ["unsorted candidates", d => { d.input.accumulation.candidateClaimIds.reverse(); }], ["missing", d => { delete d.input.accumulation; }],
    ["an extra field", d => { d.input.accumulation.extraneous = []; }], ["a missing slot", d => { delete d.input.accumulation.slot; }], ["a slot for another claim", d => { d.input.accumulation.slot.subjectId = "someone else"; }], ["a member that is not in the slot", d => { d.input.accumulation.supportingClaimIds = ["sha256:" + "e".repeat(64)]; }]]) {
    const d = rehash((() => { const copy = plain(routed); edit(copy); return copy; })());
    const check = recomputeMemoryRouting(d);
    assert.equal(check.ok, false, what);
    assert.match(check.mismatches.join("\n"), /stored routing input: accumulation|stored routing input/, what);
  }
});

// --- review round 7 ---------------------------------------------------------------------------------------------------------

test("the 64-claim bound holds at the door and in a stored decision, and is refused rather than truncated", () => {
  const claim = make({ value: "PostgreSQL 16" });
  const peers = n => Array.from({ length: n }, (_, i) => make({ value: `v${i}`, source: { ...base.source, ref: `peer-${i}` } }));
  assert.equal(routeMemoryChange(change(claim, { current: peers(64), accumulation: null })).input.current.length, 64);
  assert.throws(() => routeMemoryChange(change(claim, { current: peers(65), accumulation: null })), /more than 64 current claims/);
  // A stored decision with 65 peers, baselines to match and the digest recomputed, is refused too.
  const stored = plain(routeMemoryChange(change(claim, { current: peers(64), accumulation: null })));
  const extra = make({ value: "v64", source: { ...base.source, ref: "peer-64" } });
  stored.input.current.push(plain(extra)); stored.input.current.sort((x, y) => x.id.localeCompare(y.id));
  stored.input.baselines = [stored.input.baselines[0], ...stored.input.current.map(other => ({ ref: other.id, visibility: other.visibility ?? null }))];
  Object.assign(stored, evaluateMemoryRouting(stored.input, stored.policy));
  stored.id = `sha256:${createHash("sha256").update(canonicalJson({ input: stored.input, policy: stored.policy })).digest("hex")}`;
  const check = recomputeMemoryRouting(stored);
  assert.equal(check.ok, false);
  assert.match(check.mismatches.join("\n"), /more than 64 current claims/);
});

test("a routing change is read once, as plain data: a Proxy, a getter or an overridden map anywhere in it is refused, never routed on", () => {
  const claim = make({ value: "PostgreSQL 16" }), peer = make();
  const ok = () => change(claim, { current: [peer], accumulation: null });
  assert.doesNotThrow(() => routeMemoryChange(ok()));
  const getter = key => Object.defineProperty({ ...ok() }, key, { enumerable: true, get: () => ok()[key] });
  for (const key of ["claim", "current", "agreement"]) assert.throws(() => routeMemoryChange(getter(key)), /accessor/, `a getter for ${key}`);
  assert.throws(() => routeMemoryChange(new Proxy(ok(), {})), /Proxy/, "a Proxy change");
  assert.throws(() => routeMemoryChange({ ...ok(), claim: new Proxy(claim, {}) }), /Proxy/, "a Proxy claim");
  assert.throws(() => routeMemoryChange({ ...ok(), current: new Proxy([peer], {}) }), /Proxy/, "a Proxy list of current claims");
  assert.throws(() => routeMemoryChange({ ...ok(), current: [new Proxy(peer, {})] }), /Proxy/, "a Proxy current claim");
  const mapped = [peer]; mapped.map = () => [];
  assert.throws(() => routeMemoryChange({ ...ok(), current: mapped }), /extra keys/, "an own map on the current list");
  assert.throws(() => routeMemoryChange({ ...ok(), verifications: new Proxy([], {}) }), /Proxy/, "a Proxy list of verifications");
  assert.throws(() => routeMemoryChange({ ...ok(), agreement: new Proxy({ passes: 2, agreeing: 2 }, {}) }), /Proxy/, "a Proxy agreement");
  assert.throws(() => routeMemoryChange({ type: "entity", proposal: new Proxy(loadEntityProposals().merge, {}) }), /Proxy/, "a Proxy entity proposal");
  // What was routed is the copy: later changes to the objects handed in cannot change the recorded decision.
  const live = make({ value: "PostgreSQL 17" });
  const decision = routeMemoryChange(change(live, { current: [peer], accumulation: null }));
  assert.equal(decision.input.claim.value, "PostgreSQL 17");
  assert.notEqual(decision.input.claim, live);
});

test("recall shows the posture it checked: a claim that answers differently the second time is withheld, never printed bare", () => {
  const claim = make({ value: "PostgreSQL 16" });
  let reads = 0;
  const shifty = { ...claim };
  Object.defineProperty(shifty, "posture", { enumerable: true, get: () => (++reads === 1 ? "stated" : undefined) });
  const { presented, withheld } = presentMemoryClaims([shifty, claim]);
  assert.equal(reads, 0, "the getter never ran");
  assert.deepEqual(withheld.map(item => item.reason), ["invalid"]);
  assert.deepEqual(presented.map(item => item.id), [claim.id]);
  assert.ok(presented.every(item => /^\[stated · /.test(item.text) && item.posture === "stated"));
  assert.deepEqual(presentMemoryClaims([new Proxy(claim, {})]).withheld.map(item => item.reason), ["invalid"], "a Proxy claim");
  const list = [claim]; list.map = () => [];
  assert.throws(() => presentMemoryClaims(list), /extra keys/, "an own map on the list");
  assert.throws(() => presentMemoryClaims([claim], { routing: new Proxy([], {}) }), /Proxy/, "a Proxy routing list");
  assert.throws(() => presentMemoryClaims([claim], Object.defineProperty({}, "reviewDecisions", { enumerable: true, get: () => [] })), /accessor/, "a getter on the context");
});

test("the projection may not name the claim being routed as support or candidate unless it is a stated claim", async () => {
  const peer = make();
  for (const posture of ["proposed", "hypothetical", "retracted"]) {
    const incoming = make({ posture, value: "PostgreSQL 16", supersedes: undefined });
    const named = { outcome: "current", candidateClaimIds: [], supportingClaimIds: [incoming.id], gapCodes: [] };
    assert.throws(() => routeMemoryChange(change(incoming, { current: [peer], accumulation: named })), /not a stated claim/, `${posture} named as support`);
    const stored = plain(routeMemoryChange(change(incoming, { current: [peer], accumulation: null })));
    stored.input.accumulation = { ...named, slot: queryFor(make()).slot };
    stored.id = `sha256:${createHash("sha256").update(canonicalJson({ input: stored.input, policy: stored.policy })).digest("hex")}`;
    assert.equal(recomputeMemoryRouting(stored).ok, false, `${posture}, stored`);
  }
  assert.doesNotThrow(() => routeMemoryChange(change(make({ value: "PostgreSQL 16" }), { current: [peer], accumulation: { outcome: "current", candidateClaimIds: [], supportingClaimIds: [], gapCodes: [] } })));
});

test("a decision that no longer recomputes makes no review item: an edited claim value cannot reach a reviewer under the old id", () => {
  const routed = routeMemoryChange(RULE_CASES["contested-by-accumulation"].routes());
  assert.ok(buildMemoryReviewItem(routed));
  const edited = plain(routed);
  edited.input.claim.value = "MySQL 8";
  assert.equal(recomputeMemoryRouting(edited).ok, false);
  assert.throws(() => buildMemoryReviewItem(edited), /does not recompute/);
  const flipped = { ...plain(routed), outcome: "proposed" };
  assert.equal(buildMemoryReviewItem(flipped), undefined, "a proposed decision still makes none");
});

test("helpers that take lists read them without the caller's methods: an own map on changes or decisions is refused, not read as empty", () => {
  const changes = [change(make({ value: "PostgreSQL 16" }), { current: [make()], accumulation: null })]; changes.map = () => [];
  assert.throws(() => routeMemoryChanges(changes), /extra keys/);
  const { decisions } = (() => { const d = routeMemoryChange(change(make(), { accumulation: null })); return { decisions: [d] }; })();
  const listed = [...decisions]; listed.map = () => [];
  assert.throws(() => deriveMemoryRunMetrics({ runId: "r", decisions: listed }), /extra keys/);
  assert.throws(() => deriveMemoryRunMetrics({ runId: "r", decisions, reviewDecisions: new Proxy([], {}) }), /Proxy/);
  assert.equal(deriveMemoryRunMetrics({ runId: "r", decisions }).decisions, 1);
});

test("a source visibility that cannot be copied as plain data is sealed, not trusted and not refused; the traps never run", () => {
  const claim = make({ value: "PostgreSQL 16", visibility: { kind: "public" } });
  let traps = 0;
  const tricky = [
    new Proxy({ kind: "public" }, { get() { traps++; return "public"; }, getOwnPropertyDescriptor() { traps++; return undefined; } }),
    Object.defineProperty({ kind: "restricted" }, "audiences", { enumerable: true, get() { traps++; return ["staff"]; } }),
  ];
  for (const source of tricky) {
    const decision = routeMemoryChange(change(claim, { accumulation: null, sourceVisibility: source }));
    assert.deepEqual(decision.input.baselines[0], { ref: "source", visibility: null }, "recorded as undeclared");
    assert.deepEqual(rulesOf(decision), ["visibility-widening"], "a public claim from a sealed source widens");
  }
  assert.equal(traps, 0);
  assert.deepEqual(rulesOf(routeMemoryChange(change(make({ value: "x" }), { accumulation: null, sourceVisibility: tricky[0] }))), [], "a sealed claim from a sealed source widens nothing");
});

test("a routing change's type is read as data", () => {
  const ok = change(make(), { accumulation: null });
  const getter = Object.defineProperty({ ...ok }, "type", { enumerable: true, get: () => "claim" });
  assert.throws(() => routeMemoryChange(getter), /accessor/);
  assert.throws(() => routeMemoryChange(Object.defineProperty({ ...ok }, "sourceVisibility", { enumerable: true, get: () => null })), /accessor/);
});

// --- review round 10 -------------------------------------------------------------------------------------------------------

test("recall does not copy whole routing decisions: a decision the Kit produced for a large value with 64 peers still presents", () => {
  const big = make({ value: { list: Array.from({ length: 19000 }, (_, i) => i) } });
  const peers = Array.from({ length: 64 }, (_, i) => make({ value: `v${i}`, source: { ...base.source, ref: `peer-${i}` } }));
  const decision = routeMemoryChange(change(big, { current: peers, accumulation: null }));
  assert.equal(recomputeMemoryRouting(decision).ok, true, "the premise: it routes and recomputes");
  const { presented, withheld } = presentMemoryClaims([big], { routing: [decision] });
  assert.deepEqual(withheld, []);
  assert.deepEqual([presented[0].review.routing, presented[0].review.reasons], ["routed", rulesOf(decision)]);
  assert.ok(buildMemoryReviewItem(decision), "and so does its review item");
});

test("a review item is built from the decision that was checked: an input that answers differently the second time is not used", () => {
  const routed = routeMemoryChange(RULE_CASES["contested-by-accumulation"].routes());
  const genuine = plain(routed.input);
  const edited = plain(routed.input); edited.claim.value = "different value";
  let reads = 0;
  const shifty = { ...plain(routed) };
  Object.defineProperty(shifty, "input", { enumerable: true, get: () => (++reads === 1 ? genuine : edited) });
  assert.throws(() => buildMemoryReviewItem(shifty), /accessor/);
  assert.equal(reads, 0, "the getter never ran, so there is no second answer to build from");
  assert.equal(recomputeMemoryRouting(shifty).ok, false);
  assert.equal(reads, 0);
  assert.throws(() => buildMemoryReviewItem(new Proxy(plain(routed), {})), /Proxy/);
});

test("metrics read review events without the caller's methods: an overridden filter cannot change the measured time", () => {
  const decisions = [routeMemoryChange(RULE_CASES["contested-by-accumulation"].routes())];
  const events = [{ kind: "ReviewSessionEvent", spec: { sessionName: "s", sequence: 1, eventType: "item-selected", occurredAt: "2026-11-02T10:00:00.000Z", reviewItemName: "x" } }];
  events.filter = () => [];
  assert.throws(() => deriveMemoryRunMetrics({ runId: "r", decisions, reviewEvents: events }), /extra keys/);
  assert.throws(() => deriveMemoryRunMetrics({ runId: "r", decisions, reviewEvents: new Proxy([], {}) }), /Proxy/);
});

// --- review round 11 --------------------------------------------------------------------------------------------------------

const deepest = () => {
  const nest = n => { let v = "leaf"; for (let i = 0; i < n; i++) v = { a: v }; return v; };
  let n = 1;
  while (true) { try { jsonSnapshot(make({ value: nest(n + 1) }), "t"); n++; } catch { return make({ value: nest(n) }); } }
};

test("everything the Kit routes is something it can copy again: the deepest claim, its decision, its recomputation and its review item", () => {
  const claim = deepest();
  const peer = make({ value: nest30(), source: { ...base.source, ref: "other" } });
  const decision = routeMemoryChange(change(claim, { current: [peer], accumulation: contested(claim.id, peer.id) }));
  assert.equal(decision.outcome, "routed");
  assert.equal(recomputeMemoryRouting(decision).ok, true, "recomputation copies the decision");
  assert.ok(buildMemoryReviewItem(decision), "and so does the review item");
  assert.equal(presentMemoryClaims([claim], { routing: [decision] }).withheld.length, 0);
  assert.throws(() => jsonSnapshot(JSON.parse(JSON.stringify(decision)), "t"), /too deep/, "the premise: the ordinary claim bound is too small for the decision that embeds it");
});
function nest30() { let v = "leaf"; for (let i = 0; i < 20; i++) v = { a: v }; return v; }

test("a decision carries a bounded number of verification records", () => {
  const claim = make({ value: "PostgreSQL 16" });
  const records = n => Array.from({ length: n }, (_, i) => verification(claim, "supported", claim.value, `verifier-${i}`));
  const decision = routeMemoryChange(change(claim, { verifications: records(64), accumulation: null }));
  assert.equal(decision.input.verifications.length, 64);
  assert.equal(recomputeMemoryRouting(decision).ok, true);
  assert.throws(() => routeMemoryChange(change(claim, { verifications: records(65), accumulation: null })), /more than 64 verification records/);
  const stored = plain(decision);
  stored.input.verifications = [...stored.input.verifications, ...plain(records(1))];
  stored.id = `sha256:${createHash("sha256").update(canonicalJson({ input: stored.input, policy: stored.policy })).digest("hex")}`;
  assert.match(recomputeMemoryRouting(stored).mismatches.join("\n"), /more than 64 verification records/, "and a stored decision is held to the same bound");
});

test("recall reads each field of a routing decision as data: a getter, a Proxy or an overridden list is refused", () => {
  const claim = make({ value: "PostgreSQL 16" });
  const routed = routeMemoryChange(change(claim, { current: [make()], accumulation: contested(claim.id, make().id) }));
  const withGetter = (target, key) => Object.defineProperty({ ...target }, key, { enumerable: true, get: () => target[key] });
  for (const key of ["changeType", "changeId", "outcome", "reasons"]) {
    assert.throws(() => presentMemoryClaims([claim], { routing: [withGetter(routed, key)] }), /accessor/, `a getter for ${key}`);
  }
  assert.throws(() => presentMemoryClaims([claim], { routing: [{ ...routed, reasons: [withGetter(routed.reasons[0], "rule")] }] }), /accessor/, "a getter for a reason's rule");
  assert.throws(() => presentMemoryClaims([claim], { routing: [{ ...routed, reasons: new Proxy(routed.reasons, {}) }] }), /Proxy/, "a Proxy list of reasons");
  assert.throws(() => presentMemoryClaims([claim], { routing: [new Proxy(routed, {})] }), /Proxy/, "a Proxy decision");
  const shown = presentMemoryClaims([claim], { routing: [routed] }).presented[0];
  assert.deepEqual([shown.review.routing, shown.review.reasons], ["routed", rulesOf(routed)]);
});

const countNodes = value => (value === null || typeof value !== "object" ? 1 : 1 + Object.values(value).reduce((sum, item) => sum + countNodes(item), 0));

test("the largest decision the Kit can produce is one it can read: claims at the bound, 1,024-audience visibilities, 64 verification records, a full projection fact, a large policy", () => {
  const audiences = Array.from({ length: 1024 }, (_, i) => `audience-${i}`);
  const shaped = (n, offset, ref) => make({ value: { list: Array.from({ length: n }, (_, i) => i + offset) }, visibility: { kind: "restricted", audiences }, source: { ...base.source, ref } });
  // The largest value that still leaves the claim inside the claim bound, found rather than assumed.
  let low = 1, high = 20_000;
  while (low < high) { const mid = Math.ceil((low + high) / 2); try { jsonSnapshot(shaped(mid, 0, "r"), "t"); low = mid; } catch { high = mid - 1; } }
  const claim = shaped(low, 0, "claim");
  const peers = Array.from({ length: 64 }, (_, i) => shaped(low, 1 + i, `peer-${i}`));
  assert.ok(countNodes(claim) > 19_990 && countNodes(claim) <= 20_000, `the premise: each claim sits at the claim bound (${countNodes(claim)})`);
  const records = Array.from({ length: 64 }, (_, i) => verification(claim, "supported", claim.value, `verifier-${i}`));
  const everyone = [claim, ...peers].map(item => item.id).sort();
  const accumulation = { outcome: "contested", candidateClaimIds: everyone, supportingClaimIds: everyone, gapCodes: Array.from({ length: 1000 }, (_, i) => `gap-${i}`) };
  const names = prefix => Array.from({ length: 256 }, (_, i) => `${prefix}-${i}`);
  const policy = { multiValued: names("mv"), consequential: { properties: names("cp"), subjectTypes: names("cs") } };
  const decision = routeMemoryChange(change(claim, { current: peers, verifications: records, accumulation, accumulationQuery: queryFor(claim), sourceVisibility: { kind: "restricted", audiences } }), policy);
  assert.equal(decision.input.current.length, 64);
  const nodes = countNodes(decision);
  assert.ok(nodes > 1_300_000, `the premise: well over a million values (${nodes})`);
  assert.ok(nodes <= MAX_DECISION_NODES, `and inside the decision bound (${nodes} <= ${MAX_DECISION_NODES})`);
  assert.equal(MAX_DECISION_NODES, 1_628_000, "the bound is pinned: 65 claims x 20,000, 64 records x 2,000, 200,000 for the envelope");
  assert.equal(recomputeMemoryRouting(decision).ok, true);
  assert.ok(buildMemoryReviewItem(decision));
  assert.equal(presentMemoryClaims([claim], { routing: [decision] }).presented.length, 1);
});

test("a routing policy is bounded on its own, so no part of a decision can crowd out the rest", () => {
  const claim = make({ value: "PostgreSQL 16" });
  const near = { multiValued: new Array(19_900).fill("not-this-property") };
  assert.doesNotThrow(() => routeMemoryChange(change(claim, { accumulation: null }), near));
  assert.throws(() => routeMemoryChange(change(claim, { accumulation: null }), { multiValued: new Array(20_100).fill("x") }), /routing policy: too large/);
  assert.throws(() => routeMemoryChange(change(claim, { accumulation: null }), Object.defineProperty({}, "minPasses", { enumerable: true, get: () => 2 })), /accessor/, "a getter on the policy is refused, not run");
  assert.throws(() => routeMemoryChange(change(claim, { accumulation: null }), new Proxy({}, {})), /Proxy/);
  assert.throws(() => routeMemoryChange(change(claim, { accumulation: null }), { minAgreemnt: 1 }), /fields it does not define: minAgreemnt/, "a misspelt field is an error, not silently ignored");
  assert.throws(() => routeMemoryChange(change(claim, { accumulation: null }), { retained: { callerOwned: true } }), /fields it does not define/);
  const kept = { consequential: { properties: ["primary database"] } };
  const decision = routeMemoryChange(change(make({ value: "x", supersedes: [{ claimId: make().id, kind: "succession", reason: "r" }] }), { current: [make()], accumulation: null }), kept);
  assert.notEqual(decision.policy.consequential, kept.consequential, "the decision holds a copy, not the caller's object");
});
test("a verification record is bounded: a record padded past its allowance is refused at the door, one at the allowance is not", () => {
  const claim = make({ value: "PostgreSQL 16" });
  const genuine = verification(claim, "supported");
  assert.doesNotThrow(() => routeMemoryChange(change(claim, { verifications: [genuine], accumulation: null })));
  const padded = n => ({ ...genuine, padding: Array.from({ length: n }, (_, i) => i) });
  assert.doesNotThrow(() => routeMemoryChange(change(claim, { verifications: [padded(1_900)], accumulation: null })), "just inside 2,000 values");
  assert.throws(() => routeMemoryChange(change(claim, { verifications: [padded(2_100)], accumulation: null })), /routing change verifications\[0\].*too large/);
});

test("figures derive over a run's whole history, which may be longer than any one request list", () => {
  const decisions = Array.from({ length: 20_001 }, (_, i) => ({ changeId: `c${i}`, changeType: "claim", outcome: "proposed", reasons: [] }));
  assert.equal(deriveMemoryRunMetrics({ runId: "r", decisions }).decisions, 20_001);
  const reviewDecisions = Array.from({ length: 20_001 }, (_, i) => ({ kind: "ReviewDecision", metadata: { name: `d${i}` }, spec: { reviewItemName: `i${i}`, status: "rejected", reviewedAt: "2026-11-02T10:00:00.000Z" } }));
  assert.doesNotThrow(() => deriveMemoryRunMetrics({ runId: "r", decisions: [], reviewDecisions }));
  const reviewEvents = Array.from({ length: 20_001 }, (_, i) => ({ kind: "ReviewSessionEvent", metadata: { name: `e${i}` }, spec: { sessionName: "s", sequence: i, eventType: "item-selected", occurredAt: "2026-11-02T10:00:00.000Z" } }));
  assert.doesNotThrow(() => deriveMemoryRunMetrics({ runId: "r", decisions: [], reviewEvents }));
});

test("the decision bound covers the sum of its parts: each part is bounded where it is taken in, and the parts add up to less than the bound", () => {
  const claims = (MAX_PEERS + 1) * MAX_SNAPSHOT_NODES;
  const verifications = MAX_VERIFICATIONS * MAX_VERIFICATION_NODES;
  const baselines = (MAX_PEERS + 1) * (1024 + 6);            // one per claim, each visibility listing 1,024 audiences (ref, kind, a list)
  const fact = 3 * 1000 + 2 * (MAX_PEERS + 1) + MAX_SNAPSHOT_NODES; // three lists of at most 1,000, member ids, a slot of at most a claim's worth
  const policy = MAX_POLICY_NODES;
  const fixed = 2_000;                                       // reasons, evaluated, ids, schema, changeId, the input's own fields
  const total = claims + verifications + baselines + fact + policy + fixed;
  assert.ok(total <= MAX_DECISION_NODES, `${total} <= ${MAX_DECISION_NODES}`);
  assert.ok(MAX_DECISION_NODES - total > 10_000, "with room to spare, not by a margin of a few values");
  assert.deepEqual([MAX_PEERS, MAX_VERIFICATIONS, MAX_VERIFICATION_NODES, MAX_POLICY_NODES, MAX_SNAPSHOT_NODES, MAX_ENVELOPE_NODES, MAX_DECISION_DEPTH, MAX_SNAPSHOT_DEPTH], [64, 64, 2_000, 20_000, 20_000, 200_000, 40, 32], "the parts are pinned");
});
