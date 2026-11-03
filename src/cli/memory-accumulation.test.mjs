import test from "node:test";
import assert from "node:assert/strict";
import { memoryAccumulationClaims, memoryAccumulationFact, memoryAccumulationQuery, memoryClaimToAccumulationClaim, readMemoryAccumulationFact } from "@kontourai/flow-agents/memory-accumulation";
import { memoryClaim, MemoryClaimError } from "@kontourai/flow-agents/memory-claims";
import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import { buildMemoryReviewItem, memorySlotPeers, recomputeMemoryRouting, routeMemoryChange, verifyMemoryClaimAgainstCurrent } from "@kontourai/flow-agents/memory-routing";
import { distillFixtureSitting, readJson } from "./memory-claims-support.mjs";

const QUERY = { slot: { subjectType: "service", subjectId: "widget service", fieldOrBehavior: "primary database", claimType: "knowledge.memory-claim" }, now: "2026-11-02T00:00:00Z", valuePolicy: "single-json-v1" };
const readFact = result => memoryAccumulationFact(result, QUERY);
const readReadFact = fact => readMemoryAccumulationFact(fact);
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
  assert.deepEqual(readFact({ outcome: "contested", candidateClaimIds: ["b", "a"], gapCodes: ["z", "contested-value"], supportingClaimIds: ["a"], extra: 1 }), { outcome: "contested", slot: QUERY.slot, candidateClaimIds: ["a", "b"], supportingClaimIds: ["a"], gapCodes: ["contested-value", "z"] });
  assert.deepEqual(readFact({ outcome: "invalid", reason: "identity-unresolved", candidateClaimIds: [], supportingClaimIds: [], gapCodes: [] }), { outcome: "invalid", reason: "identity-unresolved", slot: QUERY.slot, candidateClaimIds: [], supportingClaimIds: [], gapCodes: [] });
  for (const bad of [null, undefined, "contested", {}, { outcome: "maybe", candidateClaimIds: [], supportingClaimIds: [], gapCodes: [] }, { outcome: "current", candidateClaimIds: "a", gapCodes: [] }, { outcome: "current", candidateClaimIds: [1], supportingClaimIds: [], gapCodes: [] }, { outcome: "current", candidateClaimIds: [] }]) {
    assert.throws(() => readFact(bad), MemoryClaimError, JSON.stringify(bad));
  }
});

test("routing reads Surface's real projection: unreviewed, a replacement and a conflict are contested; once reviewed and admitted, the replacement is current and the conflict still is not", async () => {
  const { c0, c1 } = await claims();
  const route = (scenario, property) => {
    const claim = byProperty(c1, property);
    const entry = fixture().scenarios[scenario].facts[claim.id];
    return routeMemoryChange({ type: "claim", claim, current: c0, agreement: { passes: 2, agreeing: 2 }, accumulation: entry.fact, accumulationQuery: entry.query, sourceVisibility: { kind: "restricted", audiences: ["user:fixture"] } }, { consequential: { properties: ["primary database"], subjectTypes: [] } });
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

test("a replacement chain carries every claim it reaches, not only the direct targets", () => {
  const base = { subject: { type: "service", id: "w" }, claimType: "knowledge.memory-claim", property: "db", speaker: "user", posture: "stated", source: { ref: "s", locator: "chars:0-1", excerpt: "x", observedAt: "2026-10-28T09:00:00.000Z" } };
  const A = memoryClaim({ ...base, value: "a" });
  const B = memoryClaim({ ...base, value: "b", supersedes: [{ claimId: A.id, kind: "succession", reason: "r" }] });
  const C = memoryClaim({ ...base, value: "c", supersedes: [{ claimId: B.id, kind: "succession", reason: "r" }] });
  assert.deepEqual(memoryAccumulationClaims([C], [A, B]).map(claim => claim.value).sort(), ["a", "b", "c"]);
  assert.deepEqual(memoryAccumulationClaims([C, B, A]).map(claim => claim.value).sort(), ["a", "b", "c"], "and each is carried once");
  assert.throws(() => memoryAccumulationClaims([C], [B]), /not available to carry/, "A is reached through B and is missing");
  const loopA = memoryClaim({ ...base, value: "x", supersedes: [{ claimId: "sha256:" + "0".repeat(64), kind: "succession", reason: "r" }] });
  assert.throws(() => memoryAccumulationClaims([loopA], []), /not available/);
});

test("one claim maps to one Surface claim, however its edges were ordered", () => {
  const base = { subject: { type: "service", id: "w" }, claimType: "knowledge.memory-claim", property: "db", value: "z", speaker: "user", posture: "stated", source: { ref: "s", locator: "chars:0-1", excerpt: "x", observedAt: "2026-10-28T09:00:00.000Z" } };
  const edges = [{ claimId: memoryClaim({ ...base, value: "a" }).id, kind: "succession", reason: "r1" }, { claimId: memoryClaim({ ...base, value: "b" }).id, kind: "correction", reason: "r2" }];
  const x = memoryClaim({ ...base, supersedes: edges }), y = memoryClaim({ ...base, supersedes: [...edges].reverse() });
  assert.equal(x.id, y.id);
  assert.deepEqual(memoryClaimToAccumulationClaim(x), memoryClaimToAccumulationClaim(y), "same Kit id, same Surface content digest");
});

test("instants reach Surface as the UTC date-times it parses, and an unparseable one is an error here", () => {
  const base = { subject: { type: "service", id: "w" }, claimType: "knowledge.memory-claim", property: "db", value: "z", speaker: "user", posture: "stated", source: { ref: "s", locator: "chars:0-1", excerpt: "x", observedAt: "2026-10-28T09:00:00.000Z" } };
  const mapped = memoryClaimToAccumulationClaim(memoryClaim({ ...base, validTime: { from: "2026-10-01", until: "2026-12-01T10:00:00+02:00" }, source: { ...base.source, observedAt: "2026-10-28" } }));
  assert.deepEqual(mapped.validTime, { from: "2026-10-01T00:00:00.000Z", until: "2026-12-01T08:00:00.000Z" });
  assert.equal(mapped.createdAt, "2026-10-28T00:00:00.000Z");
  assert.equal(mapped.updatedAt, "2026-10-28T00:00:00.000Z");
  for (const bad of [{ validTime: { from: "soon" } }, { validTime: { until: "2026-02-30" } }, { source: { ...base.source, observedAt: "yesterday" } }]) {
    assert.throws(() => memoryClaimToAccumulationClaim(memoryClaim({ ...base, ...bad })), { code: "invalid" }, JSON.stringify(bad));
  }
});

test("qualifiers reach Surface, as a copy, so a qualified slot is a different slot there too", () => {
  const base = { subject: { type: "service", id: "w" }, claimType: "knowledge.memory-claim", property: "db", value: "z", speaker: "user", posture: "stated", source: { ref: "s", locator: "chars:0-1", excerpt: "x", observedAt: "2026-10-28T09:00:00.000Z" } };
  const claim = memoryClaim({ ...base, qualifiers: { env: "prod" } });
  const mapped = memoryClaimToAccumulationClaim(claim);
  assert.deepEqual(mapped.qualifiers, { env: "prod" });
  mapped.qualifiers.env = "changed";
  assert.deepEqual(claim.qualifiers, { env: "prod" }, "the claim is not shared with the mapping");
  assert.equal("qualifiers" in memoryClaimToAccumulationClaim(memoryClaim(base)), false);
});

test("a contest is between at least two candidates, and lists are read by index", () => {
  assert.throws(() => readFact({ outcome: "contested", candidateClaimIds: [], supportingClaimIds: [], gapCodes: [] }), /at least two/);
  assert.throws(() => readFact({ outcome: "contested", candidateClaimIds: ["a"], supportingClaimIds: [], gapCodes: [] }), /at least two/);
  assert.throws(() => readFact({ outcome: "contested", candidateClaimIds: ["a", "a"], supportingClaimIds: [], gapCodes: [] }), /at least two/, "the same candidate twice is one candidate");
  assert.deepEqual(readFact({ outcome: "contested", candidateClaimIds: ["b", "a", "a"], supportingClaimIds: [], gapCodes: ["x", "x"] }), { outcome: "contested", slot: QUERY.slot, candidateClaimIds: ["a", "b"], supportingClaimIds: [], gapCodes: ["x"] });
  const sparse = new Array(2); sparse[0] = "a";
  const proto = Object.getOwnPropertyDescriptor(Array.prototype, "1");
  try {
    Array.prototype[1] = "inherited";
    assert.throws(() => readFact({ outcome: "current", candidateClaimIds: sparse, supportingClaimIds: [], gapCodes: [] }), MemoryClaimError, "a hole is refused, not skipped and not filled from the prototype");
  } finally { if (proto) Object.defineProperty(Array.prototype, "1", proto); else delete Array.prototype[1]; }
  for (const bad of [[""], [1], [null], [undefined]]) assert.throws(() => readFact({ outcome: "current", candidateClaimIds: bad, supportingClaimIds: [], gapCodes: [] }), MemoryClaimError, JSON.stringify(bad));
  assert.throws(() => readFact({ outcome: "invalid", candidateClaimIds: new Array(10_001).fill("a"), supportingClaimIds: [], gapCodes: [] }), MemoryClaimError, "an unbounded list is refused");
});

test("a projection that names a rival the Kit was not given is refused: every bound and item is built from the slot's claims", async () => {
  const { c1 } = await claims();
  const claim = byProperty(c1, "retry budget");
  const rivalId = "sha256:" + "d".repeat(64);
  const fact = { outcome: "contested", candidateClaimIds: [claim.id, rivalId].sort(), supportingClaimIds: [], gapCodes: ["contested-value"] };
  const accumulationQuery = memoryAccumulationQuery(claim, "2026-11-02T00:00:00Z");
  assert.throws(() => routeMemoryChange({ type: "claim", claim, current: [], agreement: { passes: 2, agreeing: 2 }, accumulation: fact, accumulationQuery }), /not among the slot's current claims/);
  assert.throws(() => routeMemoryChange({ type: "claim", claim, current: [memoryClaim({ ...claim, property: "elsewhere", value: "x" })], agreement: { passes: 2, agreeing: 2 }, accumulation: fact, accumulationQuery }), /not among the slot's current claims|not a stated claim of this claim type/, "a claim from another slot does not stand in for it");
  const rival = memoryClaim({ ...claim, value: "9 attempts per request", source: { ...claim.source, ref: "elsewhere" } });
  const ok = routeMemoryChange({ type: "claim", claim, current: [rival], agreement: { passes: 2, agreeing: 2 }, accumulation: { outcome: "contested", candidateClaimIds: [claim.id, rival.id].sort(), supportingClaimIds: [], gapCodes: ["contested-value"] }, accumulationQuery });
  assert.equal(ok.outcome, "routed");
  // And the stored form is held to the same rule, even with the digest recomputed.
  const edited = JSON.parse(JSON.stringify(ok));
  edited.input.current = [];
  edited.input.baselines = edited.input.baselines.filter(base => base.ref === "source");
  edited.id = `sha256:${createHash("sha256").update(canonicalJson({ input: edited.input, policy: edited.policy })).digest("hex")}`;
  const check = recomputeMemoryRouting(edited);
  assert.equal(check.ok, false);
  assert.match(check.mismatches.join("\n"), /not among the slot's current claims|not in the claim's slot/);
});

test("with the real Surface projection (surface@6.3.0), every committed fact is reproduced and the mapped claims are the ones it accepted", async () => {
  // The committed facts were produced by Surface's projectAccumulation; the pinned release must still reproduce them.
  const surface = await import("@kontourai/surface");
  assert.equal(typeof surface.projectAccumulation, "function", "the pinned Surface exports the projection");
  const { c0, c1 } = await claims();
  let checked = 0;
  for (const [name, scenario] of Object.entries(fixture().scenarios)) {
    for (const observation of scenario.observations) assert.equal(observation.contentDigest, surface.accumulationDigest(observation.bundle), `${name}: observation digest`);
    const { integrityRef, ...policy } = scenario.authority;
    assert.equal(integrityRef, surface.accumulationDigest(policy), `${name}: authority digest`);
    for (const [claimId, recorded] of Object.entries(scenario.facts)) {
      const result = surface.projectAccumulation(scenario.observations, scenario.authority, recorded.query);
      assert.deepEqual(memoryAccumulationFact(result, recorded.query), recorded.fact, `${name}: ${claimId}`);
      assert.deepEqual(result.supersessions.map(e => ({ claimId: e.claimId, byClaimId: e.byClaimId, state: e.state })), recorded.edges, `${name}: ${claimId} edges`);
      checked++;
    }
    // The committed bundles hold exactly what the Kit's mapper makes of the claims.
    const expected = name === "sitting0" ? memoryAccumulationClaims(c0, c0) : memoryAccumulationClaims(c1, c0);
    const bundle = scenario.bundles.at(-1);
    assert.deepEqual(bundle.claims.map(claim => claim.id).sort(), expected.map(claim => claim.id).sort(), name);
  }
  assert.equal(checked, 9);
});

// --- review round 6 ---------------------------------------------------------------------------------------------------

test("a rival Surface joined through an admitted identity mapping is part of the slot even though its raw subject differs", async () => {
  const { c0 } = await claims();
  const claim = byProperty(c0, "primary database");
  // Surface joins subjects an admitted identity mapping declares equivalent, so a rival it names can carry another raw subject.
  const rival = memoryClaim({ ...claim, subject: { type: "company", id: "widget-service-gmbh" }, value: "MySQL 8", source: { ...claim.source, ref: "elsewhere" }, visibility: { kind: "restricted", audiences: ["user:other"] } });
  const fact = { outcome: "contested", candidateClaimIds: [claim.id, rival.id].sort(), supportingClaimIds: [], gapCodes: ["contested-value"] };
  const accumulationQuery = memoryAccumulationQuery(claim, "2026-11-02T00:00:00Z");
  const decision = routeMemoryChange({ type: "claim", claim, current: [rival], agreement: { passes: 2, agreeing: 2 }, accumulation: fact, accumulationQuery, sourceVisibility: claim.visibility });
  assert.deepEqual(decision.reasons.map(reason => reason.rule), ["contested-by-accumulation", "visibility-widening"], "contested, and the rival's narrower visibility bounds the claim");
  assert.deepEqual(decision.input.current.map(other => other.id), [rival.id]);
  assert.equal(recomputeMemoryRouting(decision).ok, true);
  assert.equal(buildMemoryReviewItem(decision).spec.candidates.length, 2, "the rival is the item's current candidate");
  // A claim the projection does NOT name is still dropped when it is not in the slot.
  const stranger = memoryClaim({ ...claim, subject: { type: "company", id: "someone-else" }, value: "x", source: { ...claim.source, ref: "stranger" } });
  const quiet = routeMemoryChange({ type: "claim", claim, current: [rival, stranger], agreement: { passes: 2, agreeing: 2 }, accumulation: fact, accumulationQuery, sourceVisibility: claim.visibility });
  assert.deepEqual(quiet.input.current.map(other => other.id), [rival.id]);
});

test("an undefined field and an absent one are the same claim and map to the same Surface claim", async () => {
  const { c0 } = await claims();
  const a = c0[0];
  const withUndefined = memoryClaim({ ...a, source: { ...a.source, role: undefined } });
  const without = memoryClaim({ ...a, source: Object.fromEntries(Object.entries(a.source).filter(([key]) => key !== "role")) });
  assert.equal(withUndefined.id, without.id, "the premise: one Kit id");
  const x = memoryClaimToAccumulationClaim(withUndefined), y = memoryClaimToAccumulationClaim(without);
  assert.deepEqual(x, y);
  assert.equal(JSON.stringify(x), JSON.stringify(y));
  assert.equal(Object.hasOwn(x.metadata.memory.source, "role"), false);
  const holey = memoryClaim({ ...a, value: { k: undefined, n: 1 } });
  assert.deepEqual(memoryClaimToAccumulationClaim(holey).value, { n: 1 });
  assert.throws(() => memoryClaimToAccumulationClaim(memoryClaim({ ...a, value: [undefined] })), MemoryClaimError, "an undefined list entry has no JSON form to map");
});

test("a slot Surface would refuse is refused here: blank or padded subject ids, claim types and fields", async () => {
  const { c0 } = await claims();
  const a = c0[0];
  for (const [what, over] of [["padded subject id", { subject: { ...a.subject, id: " x " } }], ["padded claim type", { claimType: " knowledge.memory-claim" }], ["blank claim type", { claimType: " " }], ["blank subject type", { subject: { ...a.subject, type: "" } }]]) {
    const bad = memoryClaim({ ...a, ...over });
    assert.throws(() => memoryClaimToAccumulationClaim(bad), MemoryClaimError, what);
    assert.throws(() => memoryAccumulationQuery(bad, "2026-11-02T00:00:00Z"), MemoryClaimError, what);
  }
});

test("a very long replacement chain is carried without exhausting the stack", () => {
  const base = { subject: { type: "service", id: "w" }, claimType: "knowledge.memory-claim", property: "db", speaker: "user", posture: "stated", source: { ref: "s", locator: "chars:0-1", excerpt: "x", observedAt: "2026-10-28T09:00:00.000Z" } };
  let previous = memoryClaim({ ...base, value: "v0" });
  const chain = [previous];
  for (let i = 1; i < 6000; i++) { previous = memoryClaim({ ...base, value: `v${i}`, supersedes: [{ claimId: previous.id, kind: "succession", reason: "r" }] }); chain.push(previous); }
  assert.equal(memoryAccumulationClaims([previous], chain).length, 6000);
});

test("a result is read once, as data: a getter that changes its answer is refused, and a real-shaped result with extra fields is read", () => {
  let reads = 0;
  const flipping = { candidateClaimIds: ["a"], supportingClaimIds: [], gapCodes: [] };
  Object.defineProperty(flipping, "outcome", { enumerable: true, get() { return ++reads <= 3 ? "current" : "contested"; } });
  assert.throws(() => readFact(flipping), MemoryClaimError);
  assert.equal(reads, 0, "never called");
  const real = { outcome: "contested", reason: undefined, candidateClaimIds: ["b", "a"], supportingClaimIds: [], gapCodes: ["contested-value"], visibilityByClaimId: new Map(), supersessions: [], inputTrace: [{ any: "thing" }], statusByClaimId: Object.create(null) };
  assert.deepEqual(readFact(real), { outcome: "contested", slot: QUERY.slot, candidateClaimIds: ["a", "b"], supportingClaimIds: [], gapCodes: ["contested-value"] });
  const lying = { outcome: "contested", supportingClaimIds: [], gapCodes: [] };
  Object.defineProperty(lying, "candidateClaimIds", { enumerable: true, get() { return ["a", "b"]; } });
  assert.throws(() => readFact(lying), MemoryClaimError, "an accessor is refused even when it answers well");
  let length = 0;
  const shifting = new Proxy(["a", "b"], { get(t, key, r) { if (key === "length") return ++length === 1 ? 2 : 1; return Reflect.get(t, key, r); } });
  assert.throws(() => readFact({ outcome: "contested", candidateClaimIds: shifting, supportingClaimIds: [], gapCodes: [] }), MemoryClaimError, "a list that changes length while read");
});

test("an instant that leaves the years 0000-9999 once converted to UTC is not an instant", async () => {
  const { c0 } = await claims();
  const a = c0[0];
  const { memoryInstant } = await import("@kontourai/flow-agents/memory-claims");
  for (const [text, ok] of [["0000-01-01T00:00:00Z", true], ["9999-12-31T23:59:59.999Z", true], ["0000-01-01T00:00:00+02:00", false], ["9999-12-31T23:59:59-02:00", false], ["0000-01-01T02:00:00+02:00", true], ["9999-12-31T21:59:59-02:00", true]]) {
    assert.equal(memoryInstant(text) !== undefined, ok, text);
  }
  assert.throws(() => memoryClaimToAccumulationClaim(memoryClaim({ ...a, validTime: { from: "0000-01-01T00:00:00+02:00" } })), MemoryClaimError);
});

// --- review round 7: slot membership comes from the projection, bound to its query ------------------------------------------

const identity = () => readJson(import.meta.dirname, "fixtures", "memory-claims", "identity.json");
const stubVerifier = calls => ({ id: "probe", version: "1", method: "deterministic", verify: async input => { calls.push(input.evidence.map(item => item.id)); return { result: "contradicted" }; } });
const identityCase = name => {
  const { claims: [a, b], facts, observations, authority } = identity().scenarios[name];
  const [{ query, fact }] = Object.values(facts);
  return { a, b, query, fact, observations, authority };
};
const routeWith = (a, current, extra) => routeMemoryChange({ type: "claim", claim: a, current, agreement: { passes: 2, agreeing: 2 }, sourceVisibility: { kind: "public" }, ...extra });

test("identity-joined claims are replayed through the released Surface: contested with different values, current with equal ones", () => {
  return import("@kontourai/surface").then(surface => {
    for (const name of ["differentValues", "equalValues"]) {
      const { a, query, fact, observations, authority } = identityCase(name);
      for (const observation of observations) assert.equal(observation.contentDigest, surface.accumulationDigest(observation.bundle), `${name}: observation digest`);
      const result = surface.projectAccumulation(observations, authority, query);
      assert.deepEqual(memoryAccumulationFact(result, query), fact, name);
      assert.deepEqual(result.identityLinkIds, ["identity-desk.link.acme"], `${name}: the mapping was admitted, so the subjects are joined`);
      assert.ok(fact.slot.subjectId === "acme" && a.subject.id === "acme");
    }
  });
});

test("equal values across an admitted identity mapping: Surface names the joined claim only as support, and it still bounds the claim", async () => {
  const { a, b, query, fact } = identityCase("equalValues");
  assert.deepEqual([fact.outcome, fact.candidateClaimIds], ["current", []], "the premise: nobody is a candidate");
  assert.deepEqual(fact.supportingClaimIds, [a.id, b.id].sort(), "the joined claim is named as support");
  const decision = routeWith(a, [b], { accumulation: fact, accumulationQuery: query });
  assert.deepEqual(decision.input.current.map(other => other.id), [b.id], "the joined claim is a peer although its raw subject differs");
  assert.deepEqual(decision.reasons.map(reason => reason.rule), ["visibility-widening"], "a public claim joined to a restricted one would widen it");
  assert.equal(recomputeMemoryRouting(decision).ok, true);
  assert.deepEqual(decision.reasons[0].detail.widerThan, [b.id], "the reason names the joined claim it would widen");
  assert.ok(buildMemoryReviewItem(decision), "and the change is routed to review");
  // Without the projection the Kit cannot know the subjects are joined, and says nothing about the restricted claim.
  assert.deepEqual(routeWith(a, [b]).input.current, [], "no projection, no identity: the premise of the finding");
});

test("the verifier checks a claim against the claim an identity mapping joins to it, and against nothing it merely sits near", async () => {
  const { a, b, fact } = identityCase("differentValues");
  const calls = [];
  const record = await verifyMemoryClaimAgainstCurrent(a, [b], stubVerifier(calls), undefined, fact);
  assert.equal(calls.length, 1, "called once against the joined rival");
  assert.deepEqual(calls[0], [b.id]);
  assert.equal(record?.result, "contradicted");
  const quiet = [];
  assert.equal(await verifyMemoryClaimAgainstCurrent(a, [b], stubVerifier(quiet)), undefined, "without the projection the rival is not in the slot");
  assert.equal(quiet.length, 0);
});

test("a projection result is read together with its query, and a query for another slot than the claim's is refused", () => {
  const { a, b, query, fact } = identityCase("differentValues");
  const other = memoryClaim({ ...a, property: "founded", value: "1999" });
  assert.throws(() => routeWith(other, [b], { accumulation: fact, accumulationQuery: query }), /another slot/, "a result for headquarters cannot answer for founded");
  assert.throws(() => routeWith(a, [b], { accumulation: fact }), /query is needed/, "a result with no query");
  assert.throws(() => routeWith(a, [b], { accumulation: fact, accumulationQuery: { ...query, valuePolicy: "multi" } }), /query is needed/, "a value policy the Kit does not know");
  assert.throws(() => memoryAccumulationFact(fact, { slot: { ...query.slot, claimType: " " }, valuePolicy: "single-json-v1" }), MemoryClaimError, "a blank slot name");
  // The stored form is held to it too, whatever its digest.
  const decision = routeWith(a, [b], { accumulation: fact, accumulationQuery: query });
  const edited = JSON.parse(JSON.stringify(decision));
  edited.input.accumulation.slot.fieldOrBehavior = "founded";
  edited.id = `sha256:${createHash("sha256").update(canonicalJson({ input: edited.input, policy: edited.policy })).digest("hex")}`;
  const check = recomputeMemoryRouting(edited);
  assert.equal(check.ok, false);
  assert.match(check.mismatches.join("\n"), /another slot/);
});

test("a projection may name only stated claims of the claim's own claim type, property and qualifiers", () => {
  const { a, query, fact } = identityCase("differentValues");
  const rival = identityCase("differentValues").b;
  const forged = other => ({ ...fact, candidateClaimIds: [a.id, other.id].sort() });
  for (const [what, over] of [["claim type", { claimType: "preference" }], ["property", { property: "founded" }], ["qualifier slot", { qualifiers: { env: "prod" } }], ["posture", { posture: "hypothetical" }]]) {
    const alien = memoryClaim({ ...rival, ...over, supersedes: undefined });
    assert.throws(() => routeWith(a, [alien], { accumulation: forged(alien), accumulationQuery: query }), /not a stated claim of this claim type, property and qualifiers/, what);
    assert.throws(() => memorySlotPeers(a, [alien], forged(alien)), MemoryClaimError, `${what}, directly`);
  }
  // And the stored form: an alien claim smuggled into `current` with a recomputed digest is refused.
  const ok = routeWith(a, [rival], { accumulation: fact, accumulationQuery: query });
  const alien = memoryClaim({ ...rival, property: "founded", value: "x", visibility: { kind: "restricted", audiences: [] } });
  const smuggled = JSON.parse(JSON.stringify(ok));
  smuggled.input.current.push(JSON.parse(JSON.stringify(alien))); smuggled.input.current.sort((x, y) => x.id.localeCompare(y.id));
  smuggled.input.baselines.push({ ref: alien.id, visibility: alien.visibility });
  smuggled.id = `sha256:${createHash("sha256").update(canonicalJson({ input: smuggled.input, policy: smuggled.policy })).digest("hex")}`;
  const check = recomputeMemoryRouting(smuggled);
  assert.equal(check.ok, false);
  assert.match(check.mismatches.join("\n"), /not in the claim's slot/);
});

test("a claim type is compared exactly, as Surface does: fact and FACT are two slots", () => {
  const { a, b } = identityCase("differentValues");
  const upper = memoryClaim({ ...a, claimType: "FACT", value: "x", visibility: { kind: "restricted", audiences: ["only"] } });
  assert.notEqual(memorySlotPeers(a, [a], null).length, 1);
  assert.deepEqual(memorySlotPeers(a, [upper], null), [], "FACT is not a peer of fact");
  const decision = routeWith(a, [upper, b], {});
  assert.deepEqual(decision.input.current, [], "neither a differently typed claim nor a differently subjected one is in the slot without the projection");
  assert.equal(decision.reasons.some(reason => reason.rule === "visibility-widening"), false);
});

// --- review round 8 -------------------------------------------------------------------------------------------------------

test("the query's slot is compared as Surface compares slots: spelling of the field and an empty qualifier set do not make another slot", () => {
  const { a, b, query, fact } = identityCase("equalValues");
  const respelled = { ...query, slot: { ...query.slot, fieldOrBehavior: "HEADQUARTERS", qualifiers: {} } };
  const decision = routeWith(a, [b], { accumulation: fact, accumulationQuery: respelled });
  assert.equal(decision.input.accumulation.outcome, "current");
  assert.equal(recomputeMemoryRouting(decision).ok, true);
  // The claim type is the exception: Surface compares it exactly.
  assert.throws(() => routeWith(a, [b], { accumulation: fact, accumulationQuery: { ...query, slot: { ...query.slot, claimType: "FACT" } } }), /another slot/);
  assert.throws(() => routeWith(a, [b], { accumulation: fact, accumulationQuery: { ...query, slot: { ...query.slot, subjectId: "other" } } }), /another slot/);
});

test("every claim a projection names must be a stated claim of the property, including one in the claim's own raw slot", () => {
  const { a, query, fact } = identityCase("equalValues");
  const samesSlot = posture => memoryClaim({ ...a, posture, value: "Hamburg", source: { ...a.source, ref: `elsewhere-${posture}` }, supersedes: undefined });
  for (const posture of ["hypothetical", "proposed", "retracted"]) {
    const peer = samesSlot(posture);
    const forged = { ...fact, supportingClaimIds: [a.id, peer.id].sort() };
    assert.throws(() => routeWith(a, [peer], { accumulation: forged, accumulationQuery: query }), /not a stated claim/, `${posture}, named as support`);
    assert.throws(() => memorySlotPeers(a, [peer], memoryAccumulationFact(forged, query)), MemoryClaimError, `${posture}, directly`);
    // Unnamed, the same claim is simply a (conservative) peer in the raw slot, as before.
    assert.deepEqual(routeWith(a, [peer], {}).input.current.map(c => c.id), [peer.id], `${posture}, unnamed`);
  }
  // A stored decision cannot add one and recompute.
  const ok = routeWith(a, [identityCase("equalValues").b], { accumulation: fact, accumulationQuery: query });
  const peer = samesSlot("hypothetical");
  const stored = JSON.parse(JSON.stringify(ok));
  stored.input.current.push(JSON.parse(JSON.stringify(peer))); stored.input.current.sort((x, y) => x.id.localeCompare(y.id));
  stored.input.baselines = [stored.input.baselines[0], ...stored.input.current.map(other => ({ ref: other.id, visibility: other.visibility ?? null }))];
  stored.input.accumulation.supportingClaimIds = [...stored.input.accumulation.supportingClaimIds, peer.id].sort();
  stored.id = `sha256:${createHash("sha256").update(canonicalJson({ input: stored.input, policy: stored.policy })).digest("hex")}`;
  const check = recomputeMemoryRouting(stored);
  assert.equal(check.ok, false);
  assert.match(check.mismatches.join("\n"), /not a stated claim/);
});

test("a projection result, its query and its lists are plain data: a Proxy is refused wherever it is", () => {
  const { a, query, fact } = identityCase("differentValues");
  const result = { outcome: "contested", candidateClaimIds: [...fact.candidateClaimIds], supportingClaimIds: [], gapCodes: ["contested-value"] };
  assert.doesNotThrow(() => memoryAccumulationFact(result, query));
  const lies = new Proxy(result, { getOwnPropertyDescriptor: (target, key) => key === "outcome" ? { value: "current", enumerable: true, configurable: true, writable: true } : Reflect.getOwnPropertyDescriptor(target, key) });
  assert.throws(() => memoryAccumulationFact(lies, query), MemoryClaimError, "a result whose descriptor trap turns a contest into current");
  assert.throws(() => memoryAccumulationFact(new Proxy(result, {}), query), MemoryClaimError, "a pass-through result Proxy");
  assert.throws(() => memoryAccumulationFact({ ...result, candidateClaimIds: new Proxy([...result.candidateClaimIds], {}) }, query), MemoryClaimError, "a Proxy list");
  assert.throws(() => memoryAccumulationFact(result, new Proxy(query, {})), MemoryClaimError, "a Proxy query");
  assert.throws(() => memoryAccumulationFact(result, { ...query, slot: new Proxy(query.slot, {}) }), MemoryClaimError, "a Proxy slot");
  assert.throws(() => routeWith(a, [], { accumulation: lies, accumulationQuery: query }), MemoryClaimError, "and routing refuses it, rather than omitting the contest");
});

test("the mapper copies the claim once: a source that answers differently the second time is refused, and a Proxy claim is refused", async () => {
  const { c0 } = await claims();
  const a = c0[0];
  let reads = 0;
  const flipping = { ...a };
  Object.defineProperty(flipping, "source", { enumerable: true, get() { reads++; return reads % 2 ? a.source : { ...a.source, observedAt: "2030-01-01T00:00:00Z" }; } });
  assert.throws(() => memoryClaimToAccumulationClaim(flipping), MemoryClaimError);
  assert.equal(reads, 0, "the getter never ran");
  assert.throws(() => memoryClaimToAccumulationClaim(new Proxy(a, {})), MemoryClaimError);
  assert.throws(() => memoryAccumulationClaims([new Proxy(a, {})]), MemoryClaimError);
  assert.throws(() => memoryAccumulationClaims(new Proxy([a], {})), MemoryClaimError);
  const mapped = memoryClaimToAccumulationClaim(a);
  assert.equal(mapped.metadata.memory.source.observedAt, a.source.observedAt, "the source in the mapped claim is the one its createdAt came from");
  assert.equal(new Date(mapped.createdAt).toISOString(), new Date(a.source.observedAt).toISOString());
});

test("the fact reader and the query reader refuse what is not a projection result or a query", () => {
  const ok = { outcome: "current", candidateClaimIds: [], supportingClaimIds: ["b", "a", "b"], gapCodes: [] };
  assert.deepEqual(readFact(ok).supportingClaimIds, ["a", "b"], "support is sorted and de-duplicated, like candidates");
  const { supportingClaimIds, ...without } = ok;
  assert.throws(() => readFact(without), MemoryClaimError, "a result without supportingClaimIds is not one Surface produced");
  for (const bad of [null, undefined, "x", 7]) assert.throws(() => readReadFact(bad), MemoryClaimError, `a stored fact that is ${bad}`);
  const storedUnsorted = { ...readFact(ok), supportingClaimIds: ["b", "a"] };
  assert.notDeepEqual(readReadFact(storedUnsorted), storedUnsorted, "reading puts a stored fact in canonical form; the caller compares to detect an edit");
  for (const slot of ["x", null, 7, { ...QUERY.slot, qualifiers: ["a"] }, { ...QUERY.slot, qualifiers: { env: 1 } }, { ...QUERY.slot, qualifiers: null }, { ...QUERY.slot, subjectId: "" }, Object.defineProperty({ ...QUERY.slot }, "subjectId", { enumerable: true, get: () => "x" })]) {
    assert.throws(() => memoryAccumulationFact(ok, { slot, valuePolicy: "single-json-v1" }), MemoryClaimError, JSON.stringify(slot));
  }
  assert.deepEqual(memoryAccumulationFact(ok, { slot: { ...QUERY.slot, qualifiers: { env: "prod" } }, valuePolicy: "single-json-v1" }).slot.qualifiers, { env: "prod" });
});

test("a claim passed as current is checked as a claim: an edited one is refused at the door and in a stored decision", () => {
  const { a, b, query, fact } = identityCase("differentValues");
  const edited = { ...b, value: "Cologne" };
  assert.throws(() => routeWith(a, [edited], { accumulation: fact, accumulationQuery: query }), MemoryClaimError, "its id no longer matches its content");
  assert.throws(() => routeWith(a, [{ ...edited, id: "sha256:" + "0".repeat(64) }], {}), MemoryClaimError);
  const ok = routeWith(a, [b], { accumulation: fact, accumulationQuery: query });
  const stored = JSON.parse(JSON.stringify(ok));
  stored.input.current[0].value = "Cologne";
  stored.id = `sha256:${createHash("sha256").update(canonicalJson({ input: stored.input, policy: stored.policy })).digest("hex")}`;
  assert.equal(recomputeMemoryRouting(stored).ok, false);
});

test("a named member's claim type is compared exactly: fact and FACT are not the same property of a slot", () => {
  const { a, b, query, fact } = identityCase("differentValues");
  const upper = memoryClaim({ ...b, claimType: "FACT", supersedes: undefined });
  const forged = { ...fact, candidateClaimIds: [a.id, upper.id].sort() };
  assert.throws(() => routeWith(a, [upper], { accumulation: forged, accumulationQuery: query }), /not a stated claim of this claim type/);
});

test("the verifier reads its claims as plain data: a Proxy claim or list is refused and the verifier is never called", async () => {
  const { a, b, fact } = identityCase("differentValues");
  const calls = [];
  await assert.rejects(verifyMemoryClaimAgainstCurrent(new Proxy(a, {}), [b], stubVerifier(calls), undefined, fact), MemoryClaimError);
  await assert.rejects(verifyMemoryClaimAgainstCurrent(a, new Proxy([b], {}), stubVerifier(calls), undefined, fact), MemoryClaimError);
  await assert.rejects(verifyMemoryClaimAgainstCurrent(a, [new Proxy(b, {})], stubVerifier(calls), undefined, fact), MemoryClaimError);
  assert.equal(calls.length, 0);
  assert.equal((await verifyMemoryClaimAgainstCurrent(a, [b], stubVerifier(calls), undefined, fact))?.result, "contradicted");
  assert.equal(calls.length, 1);
});
