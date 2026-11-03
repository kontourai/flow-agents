import test from "node:test";
import assert from "node:assert/strict";
import { memoryEntityProposalInput } from "@kontourai/flow-agents/memory-entity";
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

test("when the installed Survey exports createEntityProposal it accepts the emitter's input and yields the committed ids", async t => {
  const survey = await import("@kontourai/survey");
  if (typeof survey.createEntityProposal !== "function") { t.skip("survey#358 is merged but unreleased; the committed proposals were made by its createEntityProposal"); return; }
  assert.equal(survey.createEntityProposal(memoryEntityProposalInput(await request())).id, loadEntityProposals().merge.id);
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
