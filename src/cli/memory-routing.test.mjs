import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { buildCandidateVerification } from "@kontourai/survey";
import {
  buildReviewDecisionsFromSession, buildReviewSessionEvents, initialReviewQueueSessionState,
} from "@kontourai/survey/review-workbench";
import { memoryClaim } from "@kontourai/flow-agents/memory-claims";
import {
  DEFAULT_MEMORY_ROUTING_POLICY, MEMORY_ROUTING_RULE_IDS, buildMemoryReviewItem, deriveMemoryRunMetrics, evaluateMemoryRouting, memoryProposedCandidateId,
  memoryReviewItemName, presentMemoryClaims, recomputeMemoryRouting, routeMemoryChange, routeMemoryChanges, verifyMemoryClaimAgainstCurrent,
} from "@kontourai/flow-agents/memory-routing";
import { SCHEMAS, distillFixtureSitting, matchesFixture, readJson } from "./memory-claims-support.mjs";

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
const change = (claim, extra = {}) => ({ type: "claim", claim, agreement: AGREED, ...extra });
const verification = (claim, result, value = claim.value) => buildCandidateVerification({
  input: { candidateId: memoryProposedCandidateId(claim.id), value, evidence: [{ id: "e1", excerpt: "evidence", locator: "chars:0-1" }] },
  verifier: { id: "stub", version: "1", method: "deterministic" },
  verdict: result === "abstain" ? { result, abstainReason: "timeout" } : { result },
  createdAt: "2026-11-01T00:00:00.000Z",
});
const rulesOf = decision => decision.reasons.map(reason => reason.rule);

// ---------------------------------------------------------------------------
// One isolated case per routing rule. `routes` triggers exactly that rule;
// `passes` are near misses that must stay proposed. Removing or weakening a rule
// breaks its `routes` case; adding a rule without a case breaks the coverage test.

const onCall = make({ property: "on-call owner", value: "Maya Chen" });
const newer = make({ value: "PostgreSQL 16", validTime: { from: "2026-10-30" } });
const replacing = make({ value: "PostgreSQL 16", validTime: { from: "2026-10-30" }, supersedes: [{ claimId: make().id, kind: "succession", reason: "replaces" }] });
const current = make();

const RULE_CASES = {
  "contradicted-by-verification": {
    routes: () => { const claim = make({ value: "PostgreSQL 14" }); return change(claim, { verifications: [verification(claim, "contradicted")] }); },
    passes: [
      ["a supported verdict", () => { const claim = make(); return change(claim, { verifications: [verification(claim, "supported")] }); }],
      ["a verifier that abstained is neither a pass nor a fail", () => { const claim = make(); return change(claim, { verifications: [verification(claim, "abstain")] }); }],
      ["a contradiction recorded for a different value no longer applies", () => { const claim = make(); return change(claim, { verifications: [verification(claim, "contradicted", "PostgreSQL 9")] }); }],
      ["a malformed record is ignored, not trusted", () => change(make(), { verifications: [{ result: "contradicted" }] })],
    ],
  },
  "conflicting-current-values": {
    routes: () => change(make({ value: "PostgreSQL 16" }), { current: [current] }),
    alsoRoutes: [
      ["values that differ only in case are different values: equality is structural JSON", () => change(make({ value: "postgresql 15" }), { current: [current] })],
      ["a field differing only in case is the same slot, because Surface lower-cases it", () => change(make({ property: "Primary Database", value: "PostgreSQL 16" }), { current: [current] })],
      ["an edge to a claim that is not in the slot replaces nothing", () => change(make({ value: "PostgreSQL 16", supersedes: [{ claimId: make({ value: "elsewhere" }).id, kind: "succession", reason: "r" }] }), { current: [current] })],
      ["a structured value is compared structurally", () => change(make({ value: { version: 16 } }), { current: [make({ value: { version: 15 } })] })],
    ],
    passes: [
      ["the same value", () => change(make({ value: "PostgreSQL 15" }), { current: [current] })],
      ["the same structured value, keys in another order", () => change(make({ value: { a: 1, b: 2 } }), { current: [make({ value: { b: 2, a: 1 } })] })],
      ["valid times that do not overlap", () => change(make({ value: "PostgreSQL 16", validTime: { from: "2026-12-01" } }), { current: [make({ validTime: { until: "2026-12-01" } })] })],
      ["a property declared multi-valued", () => change(make({ value: "PostgreSQL 16" }), { current: [current] }), { multiValued: ["primary database"] }],
      ["another slot", () => change(make({ property: "backup database", value: "PostgreSQL 16" }), { current: [current] })],
      ["another claimType: the slot includes it", () => change(make({ claimType: "other.claim", value: "PostgreSQL 16" }), { current: [current] })],
      ["another qualifier: the slot includes them", () => change(make({ qualifiers: { environment: "staging" }, value: "PostgreSQL 16" }), { current: [current] })],
      ["a current claim that was only hypothetical", () => change(make({ value: "PostgreSQL 16" }), { current: [make({ posture: "hypothetical" })] })],
      ["a new claim that is only hypothetical", () => change(make({ value: "PostgreSQL 16", posture: "hypothetical" }), { current: [current] })],
      ["a value the new claim explicitly replaces", () => change(replacing, { current: [current] })],
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
    routes: () => ({ type: "entity", proposalRef: "survey-entity-review:merge-1", operation: "merge", subjects: ["Maya Chen", "M. Chen"] }),
    passes: [],
    alsoRoutes: ["split", "alias"].map(operation => [operation, () => ({ type: "entity", proposalRef: `survey-entity-review:${operation}`, operation, subjects: ["Maya Chen"] })]),
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
    routes: () => change(make({ audience: ["user:brian", "team:platform"] }), { sourceAudience: ["user:brian"] }),
    passes: [
      ["no audience requested: inherits the source, omission never widens", () => change(make(), { sourceAudience: ["user:brian"] })],
      ["an audience within the source's", () => change(make({ audience: ["user:brian"] }), { sourceAudience: ["user:brian", "team:platform"] })],
      ["an audience equal to the source's", () => change(make({ audience: ["user:brian"] }), { sourceAudience: ["user:brian"] })],
    ],
    alsoRoutes: [
      ["an unknown source audience fails closed", () => change(make({ audience: ["user:brian"] }))],
      ["wider than a narrower current claim in the slot", () => change(make({ value: "PostgreSQL 15", audience: ["user:brian", "team:platform"] }), { sourceAudience: ["user:brian", "team:platform"], current: [make({ audience: ["user:brian"] })] })],
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
  const claim = make({ value: "PostgreSQL 16", audience: ["user:brian", "team:platform"] });
  const decision = routeMemoryChange(change(claim, { current: [current], agreement: { passes: 2, agreeing: 1 }, sourceAudience: ["user:brian"], verifications: [verification(claim, "contradicted")] }));
  assert.deepEqual(rulesOf(decision), ["contradicted-by-verification", "conflicting-current-values", "low-extraction-agreement", "visibility-widening"]);
});

test("a malformed interval cannot clear a conflict: the pure rules fail closed, and the entry points refuse such a claim outright", () => {
  const poisoned = { ...current, validTime: { from: "2026-12-01", until: "2026-01-01" } };
  const input = { type: "claim", claim: make({ value: "PostgreSQL 16" }), current: [poisoned], verifications: [], agreement: AGREED, baselines: [] };
  assert.deepEqual(evaluateMemoryRouting(input, DEFAULT_MEMORY_ROUTING_POLICY).reasons.map(reason => reason.rule), ["conflicting-current-values"]);
  assert.throws(() => routeMemoryChange(change(make({ value: "PostgreSQL 16" }), { current: [poisoned] })));
});

test("each layer defends itself: the entry point drops other-slot claims and stale records, and the pure rules ignore them if a stored input still carries them", () => {
  const claim = make({ value: "PostgreSQL 16" });
  const otherSlot = make({ property: "backup database", value: "MySQL" });
  const stale = verification(claim, "contradicted", "PostgreSQL 9");
  // Entry point: what it records is already filtered.
  const decision = routeMemoryChange(change(claim, { current: [otherSlot], verifications: [stale] }));
  assert.deepEqual([decision.input.current, decision.input.verifications], [[], []]);
  assert.equal(decision.outcome, "proposed");
  // Rules: handed a record that was edited to carry them anyway, they still do not route on them.
  const edited = { type: "claim", claim, current: [otherSlot], verifications: [stale], agreement: AGREED, baselines: [] };
  assert.deepEqual(evaluateMemoryRouting(edited, DEFAULT_MEMORY_ROUTING_POLICY).reasons, []);
  // A verification of the right value still routes through the pure rules.
  const bound = { ...edited, verifications: [verification(claim, "contradicted")] };
  assert.deepEqual(evaluateMemoryRouting(bound, DEFAULT_MEMORY_ROUTING_POLICY).reasons.map(reason => reason.rule), ["contradicted-by-verification"]);
});

// ---------------------------------------------------------------------------
// Recomputation

test("recomputation detects an edited outcome, an edited input, a changed policy and a drifted rule list", () => {
  const routed = routeMemoryChange(RULE_CASES["conflicting-current-values"].routes());
  assert.equal(recomputeMemoryRouting(routed).ok, true);

  const flipped = { ...routed, outcome: "proposed", reasons: [] };
  assert.match(recomputeMemoryRouting(flipped).mismatches.join(), /outcome: recorded proposed, recomputed routed/);

  const edited = plain(routed);
  edited.input.current = [];
  const editedCheck = recomputeMemoryRouting(edited);
  assert.equal(editedCheck.ok, false);
  assert.match(editedCheck.mismatches.join("\n"), /outcome: recorded routed, recomputed proposed/);

  const repolicied = plain(routed);
  repolicied.policy.multiValued = ["primary database"];
  assert.match(recomputeMemoryRouting(repolicied).mismatches.join("\n"), /outcome|digest/);

  const drifted = plain(routed);
  drifted.evaluated = drifted.evaluated.slice(1);
  assert.match(recomputeMemoryRouting(drifted).mismatches.join("\n"), /evaluated rules differ/);

  const tampered = plain(routed);
  tampered.input.claim.value = "MySQL";
  assert.match(recomputeMemoryRouting(tampered).mismatches.join("\n"), /id is not the digest/);
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
  const decision = routeMemoryChange(change(claim, { current: [current], verifications: [record] }));
  const item = buildMemoryReviewItem(decision);
  assert.equal(item.metadata.name, memoryReviewItemName(claim.id));
  assert.deepEqual(item.spec.candidates.map(candidate => candidate.role), ["current", "proposed"]);
  assert.equal(item.spec.candidates[0].value, "PostgreSQL 15");
  assert.equal(item.spec.candidates[1].value, "PostgreSQL 16");
  assert.deepEqual(item.spec.candidates[1].verifications, [record]);
  assert.equal(item.metadata.labels["memory.posture"], "stated");
  assert.match(item.spec.rationale, /contradicted-by-verification, conflicting-current-values/);
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
const SOURCE_AUDIENCE = ["user:fixture"];

async function endToEnd() {
  const earlier = await distillFixtureSitting(0);
  const later = await distillFixtureSitting(1, { current: earlier.result.claims });
  const changesFor = (result, currentClaims) => result.claims.map(claim => change(claim, { current: currentClaims, agreement: result.agreement[claim.id], sourceAudience: SOURCE_AUDIENCE }));
  const first = routeMemoryChanges(changesFor(earlier.result, []), POLICY);
  const second = routeMemoryChanges(changesFor(later.result, earlier.result.claims), POLICY);
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
    ["primary database", "stated", "routed", ["consequential-supersession"]],
    ["retry budget", "stated", "routed", ["conflicting-current-values"]],
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
  assert.deepEqual(before.routedByRule, { "low-extraction-agreement": 2, "consequential-supersession": 1, "conflicting-current-values": 1 });
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
  assert.deepEqual([routed.review.label, routed.review.routing, routed.review.reasons], ["in-review", "routed", ["conflicting-current-values"]]);
});

test("recall without routing information still labels the claim unreviewed and says it was never evaluated", async () => {
  const { earlier } = await endToEnd();
  const { presented } = presentMemoryClaims(earlier.result.claims);
  assert.ok(presented.every(claim => claim.review.label === "unreviewed" && claim.review.routing === "not-evaluated"));
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
