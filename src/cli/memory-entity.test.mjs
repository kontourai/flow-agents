import test from "node:test";
import assert from "node:assert/strict";
import { memoryEntityProposalInput } from "@kontourai/flow-agents/memory-entity";
import { MemoryClaimError } from "@kontourai/flow-agents/memory-claims";
import { routeMemoryChange } from "@kontourai/flow-agents/memory-routing";
import { distillFixtureSitting, loadEntityProposals, loadSittings } from "./memory-claims-support.mjs";

const checksums = () => Object.fromEntries(loadSittings().map(sitting => [sitting.sittingId, sitting.contentHash]));
const SUBJECTS = [{ type: "person", id: "maya chen" }, { type: "person", id: "m. chen" }];
async function claims() {
  const { result } = await distillFixtureSitting(0);
  return { owner: result.claims.find(claim => claim.property === "on-call owner"), budget: result.claims.find(claim => claim.property === "retry budget") };
}
const request = async (over = {}) => {
  const { owner } = await claims();
  return { revision: "1", proposer: { id: "knowledge.memory-claims", rule: "spelling-variant" }, policy: { id: "entity-review", revision: "1" }, checksums: checksums(),
    candidates: [{ operation: "merge", subjects: SUBJECTS, claims: [{ claim: owner, stance: "supports" }], confidenceComponents: { name: 0.8 } }], ...over };
};

test("the Kit emits Survey's EntityProposalInput from real claims: exact spans, checksums, subjects, operation", async () => {
  const { owner } = await claims();
  const input = memoryEntityProposalInput(await request());
  assert.deepEqual(Object.keys(input).sort(), ["alternatives", "policy", "proposer", "revision"]);
  const [alternative] = input.alternatives;
  assert.deepEqual(alternative.subjects, [{ subjectType: "person", subjectId: "maya chen" }, { subjectType: "person", subjectId: "m. chen" }]);
  assert.equal(alternative.operation, "merge");
  assert.deepEqual(alternative.confidenceComponents, { name: 0.8 });
  assert.deepEqual(alternative.evidence, [{
    id: owner.id, sourceRef: owner.source.ref, sourceId: owner.source.ref, checksum: checksums()[owner.source.ref], observedAt: owner.source.observedAt,
    locatorScheme: "text-span", locator: owner.source.locator, excerpt: owner.source.excerpt, stance: "supports",
  }]);
});

test("the emitter hands Survey exactly the revision, proposer and policy it was given", async () => {
  const input = memoryEntityProposalInput(await request({ revision: "rev-7", proposer: { id: "proposer-9", model: "m-1", rule: "r-2" }, policy: { id: "pol-3", revision: "pol-rev-4" } }));
  assert.equal(input.revision, "rev-7");
  assert.deepEqual(input.proposer, { id: "proposer-9", model: "m-1", rule: "r-2" });
  assert.deepEqual(input.policy, { id: "pol-3", revision: "pol-rev-4" });
});

test("the emitter refuses what Survey's createEntityProposal would: blank identity fields, scores outside 0..1, bad times, unknown operations", async () => {
  const { owner } = await claims();
  const await_request = await request();
  const ok = [{ claim: owner, stance: "supports" }];
  const cand = over => ({ operation: "merge", subjects: SUBJECTS, claims: ok, confidenceComponents: { name: 0.5 }, ...over });
  const cases = {
    "blank revision": { revision: " " }, "no proposer id": { proposer: { id: "" } }, "blank policy id": { policy: { id: " ", revision: "1" } }, "blank policy revision": { policy: { id: "p", revision: "" } },
    "a score of 2": { candidates: [cand({ confidenceComponents: { name: 2 } })] }, "a negative score": { candidates: [cand({ confidenceComponents: { name: -0.1 } })] },
    "a NaN score": { candidates: [cand({ confidenceComponents: { name: NaN } })] }, "a blank score name": { candidates: [cand({ confidenceComponents: { " ": 0.5 } })] },
    "an unknown operation": { candidates: [cand({ operation: "erase" })] }, "a bad stance": { candidates: [cand({ claims: [{ claim: owner, stance: "maybe" }] })] },
    "an evidence time that is not a date-time": { candidates: [cand({ claims: [{ claim: { ...owner, source: { ...owner.source, observedAt: "later" } }, stance: "supports" }] })] },
  };
  for (const [name, over] of Object.entries(cases)) assert.throws(() => memoryEntityProposalInput({ ...(await_request ?? {}), ...over }), /entity|needs|score|stance|evidence|confidence|operation/, name);
  for (const operation of ["merge", "split", "alias", "same-as", "related-to", "domain:billing"]) assert.doesNotThrow(() => memoryEntityProposalInput({ ...(await_request ?? {}), candidates: [cand({ operation })] }), operation);
});

test("the emitter refuses what Survey\'s createEntityProposal would also refuse: blank ids and checksums, lossy JSON, anything but two subjects", async () => {
  const { owner } = await claims();
  const ok = await request();
  const cand = over => ({ ...ok.candidates[0], ...over });
  const cases = {
    "a blank subject id": { candidates: [cand({ subjects: [{ type: "person", id: " " }, SUBJECTS[1]] })] }, "a blank subject type": { candidates: [cand({ subjects: [{ type: "", id: "a" }, SUBJECTS[1]] })] },
    "one subject": { candidates: [cand({ subjects: [SUBJECTS[0]] })] }, "three subjects": { candidates: [cand({ subjects: [...SUBJECTS, { type: "person", id: "c" }] })] }, "no subjects": { candidates: [cand({ subjects: [] })] },
    "a whitespace checksum": { checksums: { [owner.source.ref]: "   " } }, "a numeric checksum": { checksums: { [owner.source.ref]: 7 } },
    "NaN in the proposer": { proposer: { id: "p", model: NaN } }, "undefined list entry": { candidates: [cand({ claims: [{ claim: owner, stance: "supports" }, undefined] })] },
    "a getter": { proposer: Object.defineProperty({ id: "p" }, "rule", { enumerable: true, get() { return "r"; } }) }, "a __proto__ key": { proposer: JSON.parse('{"id":"p","__proto__":{"x":1}}') },
  };
  for (const [name, over] of Object.entries(cases)) assert.throws(() => memoryEntityProposalInput({ ...ok, ...over }), MemoryClaimError, name);
  assert.doesNotThrow(() => memoryEntityProposalInput(ok));
  assert.equal(memoryEntityProposalInput({ ...ok, proposer: { id: "p", model: undefined } }).proposer.model, undefined, "an absent optional field is just absent");
});

test("each claim's stance toward the proposal is carried to Survey as given", async () => {
  const { owner, budget } = await claims();
  const input = memoryEntityProposalInput(await request({ candidates: [{ operation: "alias", subjects: SUBJECTS, claims: [{ claim: owner, stance: "contradicts" }, { claim: budget, stance: "context" }], confidenceComponents: {} }] }));
  assert.deepEqual(input.alternatives[0].evidence.map(item => [item.id, item.stance]), [[owner.id, "contradicts"], [budget.id, "context"]]);
});

test("the committed proposals are what the Kit's emitter produces, made by Survey's createEntityProposal", async () => {
  const { owner, budget } = await claims();
  const fixtures = loadEntityProposals();
  const expected = {
    merge: await request(), split: await request({ candidates: [{ operation: "split", subjects: SUBJECTS, claims: [{ claim: owner, stance: "supports" }], confidenceComponents: { name: 0.8 } }] }),
  };
  for (const [name, req] of Object.entries(expected)) {
    const built = memoryEntityProposalInput(req).alternatives[0];
    const stored = fixtures[name].spec.alternatives[0];
    assert.equal(stored.operation, built.operation, name);
    assert.deepEqual(stored.evidence, built.evidence, `${name}: evidence is what the emitter builds`);
    assert.deepEqual(stored.subjects.map(s => `${s.subjectType}:${s.subjectId}`).sort(), built.subjects.map(s => `${s.subjectType}:${s.subjectId}`).sort(), name);
  }
  assert.deepEqual(fixtures.multi.spec.alternatives.map(a => a.operation).sort(), ["merge", "same-as"]);
  assert.deepEqual(fixtures.multi.spec.alternatives.flatMap(a => a.evidence.map(e => e.id)).sort(), [owner.id, owner.id, budget.id].sort());
  for (const proposal of Object.values(fixtures)) assert.match(proposal.id, /^sha256:[0-9a-f]{64}$/);
});

test("the pinned Survey (survey@8.3.0) accepts the emitter's input and yields the committed proposals, ids and review items", async () => {
  const survey = await import("@kontourai/survey");
  assert.equal(typeof survey.createEntityProposal, "function", "the pinned Survey exports entity review");
  const { owner } = await claims();
  const fixtures = loadEntityProposals();
  const requests = {
    merge: await request(),
    split: await request({ candidates: [{ operation: "split", subjects: SUBJECTS, claims: [{ claim: owner, stance: "supports" }], confidenceComponents: { name: 0.8 } }] }),
  };
  for (const [name, req] of Object.entries(requests)) {
    const proposal = survey.createEntityProposal(memoryEntityProposalInput(req));
    assert.deepEqual(proposal, fixtures[name], `${name}: the emitter's input produces the committed proposal`);
    assert.equal(survey.entityProposalToReviewItem(proposal).kind, "ReviewItem", `${name}: Survey turns it into a review item`);
  }
});

test("routing takes the proposal the emitter built and records it; every entity change goes to review whatever its scores", async () => {
  const proposal = loadEntityProposals().merge;
  for (const score of [0, 0.5, 1]) {
    const withScore = { ...proposal, spec: { ...proposal.spec, alternatives: proposal.spec.alternatives.map(a => ({ ...a, confidenceComponents: { name: score } })) } };
    const decision = routeMemoryChange({ type: "entity", proposal: withScore });
    assert.equal(decision.outcome, "routed", `score ${score}`);
    assert.equal(decision.changeId, proposal.id);
  }
});

test("the emitter refuses what Survey would: no evidence, no checksum, one subject twice, an empty proposal", async () => {
  const { owner } = await claims();
  const bad = async over => assert.throws(() => memoryEntityProposalInput(over), /entity|checksum|claim/);
  await bad(await request({ candidates: [] }));
  await bad(await request({ checksums: {} }));
  await bad(await request({ candidates: [{ operation: "merge", subjects: [SUBJECTS[0], SUBJECTS[0]], claims: [{ claim: owner, stance: "supports" }], confidenceComponents: {} }] }));
  await bad(await request({ candidates: [{ operation: "merge", subjects: SUBJECTS, claims: [], confidenceComponents: {} }] }));
  await bad(await request({ candidates: [{ operation: "merge", subjects: SUBJECTS, claims: [{ claim: owner, stance: "supports" }, { claim: owner, stance: "context" }], confidenceComponents: {} }] }));
});

// --- review round 6 ---------------------------------------------------------------------------------------------------

test("the emitter needs each evidence field Survey needs, and refuses blank ones", async () => {
  const { owner } = await claims();
  const ok = await request();
  const withClaim = claim => ({ ...ok, candidates: [{ ...ok.candidates[0], claims: [{ claim, stance: "supports" }] }] });
  for (const [what, claim] of [
    ["a blank claim id", { ...owner, id: "  " }], ["a blank source ref", { ...owner, source: { ...owner.source, ref: " " } }],
    ["a blank locator", { ...owner, source: { ...owner.source, locator: "\n" } }], ["a blank excerpt", { ...owner, source: { ...owner.source, excerpt: " " } }],
    ["a missing observedAt", { ...owner, source: { ...owner.source, observedAt: undefined } }],
  ]) assert.throws(() => memoryEntityProposalInput(withClaim(claim)), MemoryClaimError, what);
});

test("a claim's own value is not part of the proposal, so whatever it holds cannot make the emitter refuse a request Survey would accept", async () => {
  const { owner } = await claims();
  const ok = await request();
  const hostileValues = [JSON.parse('{"__proto__":{"x":1}}'), { deep: deepValue(40) }, -0, [undefined], { a: NaN }, Object.create(null)];
  for (const value of hostileValues) {
    const claim = { ...owner, value };
    const input = memoryEntityProposalInput({ ...ok, candidates: [{ ...ok.candidates[0], claims: [{ claim, stance: "supports" }] }] });
    assert.equal(input.alternatives[0].evidence[0].id, owner.id);
    assert.equal(JSON.stringify(input).includes("__proto__"), false, "and the value never reaches the proposal");
  }
});
function deepValue(n) { let v = 1; for (let i = 0; i < n; i++) v = { a: v }; return v; }
