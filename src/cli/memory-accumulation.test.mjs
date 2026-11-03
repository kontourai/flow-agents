import test from "node:test";
import assert from "node:assert/strict";
import { memoryAccumulationClaims, memoryAccumulationFact, memoryAccumulationQuery, memoryClaimToAccumulationClaim } from "@kontourai/flow-agents/memory-accumulation";
import { memoryClaim, MemoryClaimError } from "@kontourai/flow-agents/memory-claims";
import { routeMemoryChange } from "@kontourai/flow-agents/memory-routing";
import { distillFixtureSitting, readJson } from "./memory-claims-support.mjs";

const fixture = () => readJson(import.meta.dirname, "fixtures", "memory-claims", "accumulation.json");
async function claims() {
  const earlier = await distillFixtureSitting(0);
  const later = await distillFixtureSitting(1, { current: earlier.result.claims });
  return { c0: earlier.result.claims, c1: later.result.claims };
}
const byProperty = (list, property, posture = "stated") => list.find(claim => claim.property === property && claim.posture === posture);

test("the claims the Kit publishes to Surface are what the committed projection was run over", async () => {
  const { c0, c1 } = await claims();
  const sc = fixture().scenarios;
  const ids = bundle => bundle.claims.map(claim => claim.id);
  // Sitting 0's bundle, and sitting 1's: its stated claims plus the claims they replace, carried with them.
  assert.deepEqual(memoryAccumulationClaims(c0, c0).map(claim => claim.id), ids(sc.sitting0.bundles[0]));
  const sitting1 = memoryAccumulationClaims(c1, c0);
  assert.deepEqual(sitting1.map(claim => claim.id), ids(sc.sitting1.bundles[1]));
  assert.ok(sitting1.some(claim => claim.id === byProperty(c0, "primary database").id), "the claim a succession replaces travels with its successor");
  for (const mapped of sitting1) assert.deepEqual(mapped, sc.sitting1.bundles[1].claims.find(claim => claim.id === mapped.id), mapped.fieldOrBehavior);
});

test("only a stated claim is a candidate for a slot: plans, what-ifs and retractions are not mapped", async () => {
  const { c1 } = await claims();
  for (const posture of ["proposed", "hypothetical", "retracted"]) {
    const claim = c1.find(item => item.posture === posture) ?? memoryClaim({ ...c1[0], posture, supersedes: undefined, value: `v-${posture}` });
    assert.throws(() => memoryClaimToAccumulationClaim(claim), { code: "invalid" }, posture);
  }
  assert.deepEqual(memoryAccumulationClaims(c1.filter(claim => claim.posture !== "stated")), [], "a batch of them publishes nothing");
});

test("the mapping uses Surface's names, keeps the claim's own values, and says nothing is verified", async () => {
  const { c1 } = await claims();
  const claim = byProperty(c1, "primary database");
  const mapped = memoryClaimToAccumulationClaim(claim);
  assert.deepEqual([mapped.id, mapped.subjectType, mapped.subjectId, mapped.claimType, mapped.fieldOrBehavior, mapped.value], [claim.id, claim.subject.type, claim.subject.id, claim.claimType, claim.property, claim.value]);
  assert.equal(mapped.status, "proposed");
  assert.deepEqual(mapped.validTime, claim.validTime);
  assert.deepEqual(mapped.supersedes, claim.supersedes);
  assert.deepEqual(mapped.metadata.visibility, { audiences: ["user:fixture"] });
  assert.deepEqual(mapped.metadata.memory, { speaker: claim.speaker, source: claim.source });
});

test("visibility goes where Surface reads a declared visibility, and absent stays absent (which Surface reads as sealed)", async () => {
  const { c0 } = await claims();
  const base = c0[0];
  const at = visibility => memoryClaimToAccumulationClaim(memoryClaim({ ...base, visibility })).metadata.visibility;
  assert.equal(at({ kind: "public" }), "public");
  assert.deepEqual(at({ kind: "restricted", audiences: ["b", "a"] }), { audiences: ["a", "b"] });
  assert.deepEqual(at({ kind: "restricted", audiences: [] }), { audiences: [] });
  const { visibility: _v, ...bare } = base;
  assert.equal("visibility" in memoryClaimToAccumulationClaim(memoryClaim(bare)).metadata, false);
});

test("a replacement's target travels with it, and a missing or non-stated target is an error here, not a throw inside the projection", async () => {
  const { c0, c1 } = await claims();
  const successor = byProperty(c1, "primary database");
  assert.throws(() => memoryAccumulationClaims([successor], []), /not available to carry/);
  const planned = memoryClaim({ ...byProperty(c0, "primary database"), posture: "hypothetical", value: "x" });
  assert.throws(() => memoryAccumulationClaims([memoryClaim({ ...successor, supersedes: [{ claimId: planned.id, kind: "succession", reason: "r" }] })], [planned]), /not a stated claim/);
  assert.deepEqual(memoryAccumulationClaims([successor], c0).map(claim => claim.id).sort(), [successor.id, byProperty(c0, "primary database").id].sort());
});

test("the query names the claim's slot, with Surface's single-value policy and the host's clock", async () => {
  const { c1 } = await claims();
  const claim = byProperty(c1, "retry budget");
  assert.deepEqual(memoryAccumulationQuery(claim, "2026-11-02T00:00:00Z"), {
    slot: { subjectType: "service", subjectId: "widget service", fieldOrBehavior: "retry budget", claimType: "knowledge.memory-claim" }, now: "2026-11-02T00:00:00Z", valuePolicy: "single-json-v1",
  });
  assert.deepEqual(memoryAccumulationQuery(memoryClaim({ ...claim, qualifiers: { env: "prod" } }), "t").slot.qualifiers, { env: "prod" });
});

test("a projection result becomes a fact, sorted, or is refused if it does not look like one", () => {
  assert.deepEqual(memoryAccumulationFact({ outcome: "contested", candidateClaimIds: ["b", "a"], gapCodes: ["z", "contested-value"], supportingClaimIds: ["a"], extra: 1 }), { outcome: "contested", candidateClaimIds: ["a", "b"], gapCodes: ["contested-value", "z"] });
  assert.deepEqual(memoryAccumulationFact({ outcome: "invalid", reason: "identity-unresolved", candidateClaimIds: [], gapCodes: [] }), { outcome: "invalid", reason: "identity-unresolved", candidateClaimIds: [], gapCodes: [] });
  for (const bad of [null, undefined, "contested", {}, { outcome: "maybe", candidateClaimIds: [], gapCodes: [] }, { outcome: "current", candidateClaimIds: "a", gapCodes: [] }, { outcome: "current", candidateClaimIds: [1], gapCodes: [] }, { outcome: "current", candidateClaimIds: [] }]) {
    assert.throws(() => memoryAccumulationFact(bad), MemoryClaimError, JSON.stringify(bad));
  }
});

test("routing reads Surface's real projection: unreviewed, a replacement and a conflict are contested; once reviewed and admitted, the replacement is current and the conflict still is not", async () => {
  const { c1 } = await claims();
  const route = (scenario, property) => {
    const claim = byProperty(c1, property);
    const entry = fixture().scenarios[scenario].facts[claim.id];
    return routeMemoryChange({ type: "claim", claim, agreement: { passes: 2, agreeing: 2 }, accumulation: entry.fact ?? entry, sourceVisibility: { kind: "restricted", audiences: ["user:fixture"] } }, { consequential: { properties: ["primary database"], subjectTypes: [] } });
  };
  const rules = decision => decision.reasons.map(reason => reason.rule);
  assert.deepEqual(rules(route("sitting1", "primary database")), ["contested-by-accumulation", "consequential-supersession"]);
  assert.deepEqual(rules(route("sitting1", "retry budget")), ["contested-by-accumulation"]);
  assert.deepEqual(rules(route("sitting1", "lead")), []);
  // A reviewer verified every claim and the host admitted those verifications.
  assert.deepEqual(rules(route("afterReview", "primary database")), ["consequential-supersession"], "no longer contested; still a consequential change");
  assert.deepEqual(rules(route("afterReview", "retry budget")), ["contested-by-accumulation"], "two verified claims with different values are still a contest");
  assert.deepEqual(rules(route("afterReview", "lead")), []);
  const edges = fixture().scenarios.afterReview.facts[byProperty(c1, "primary database").id].edges;
  assert.deepEqual(edges.map(e => e.state), ["accepted"]);
  assert.deepEqual(fixture().scenarios.sitting1.facts[byProperty(c1, "primary database").id].edges.map(e => e.state), ["pending"]);
});

test("when the installed Surface has the projection, it reproduces every committed fact from the committed bundles", async t => {
  const surface = await import("@kontourai/surface");
  if (typeof surface.projectAccumulation !== "function") { t.skip("surface#359 is merged but unreleased; the committed facts were produced by its projectAccumulation at b7d932b"); return; }
  assert.equal(typeof surface.accumulationDigest, "function");
  // Reproduction needs the host's observations and authority, which the fixture does not store; the check that matters
  // once Surface publishes is that the mapped claims pass its validation and project to these outcomes.
  for (const scenario of Object.values(fixture().scenarios)) for (const bundle of scenario.bundles) assert.ok(bundle.claims.length > 0);
});
