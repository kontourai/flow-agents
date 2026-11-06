// The wire shape of an entity proposal in a memory root (kontourai/flow-agents#1618): `memory.entity-proposal`, one JSON envelope
// `{ version, proposal }` whose `proposal` is Survey's `EntityProposal` verbatim. These tests prove the codec round-trips what the
// Kit's own emitter and Survey produce, hands the result to Survey's review item unchanged, refuses anything edited or
// over a bound, and leaves the claim envelope reader alone.
import assert from "node:assert/strict";
import test from "node:test";
import { createEntityProposal, entityProposalToReviewItem } from "@kontourai/survey";
import { memoryEntityProposalInput } from "@kontourai/flow-agents/memory-entity";
import * as entity from "@kontourai/flow-agents/memory-entity-envelope";
import * as claimEnvelope from "@kontourai/flow-agents/memory-envelope";
import * as kitEntity from "../../kits/knowledge/dream/entity-envelope.js";
import { distillFixtureSitting, loadSittings } from "./memory-claims-support.mjs";

const SUBJECTS = [{ type: "person", id: "maya chen" }, { type: "person", id: "m. chen" }];

async function kitProposal() {
  const { result } = await distillFixtureSitting(0);
  const owner = result.claims.find((claim) => claim.property === "on-call owner");
  const checksums = Object.fromEntries(loadSittings().map((sitting) => [sitting.sittingId, sitting.contentHash]));
  return createEntityProposal(memoryEntityProposalInput({
    revision: "1", proposer: { id: "knowledge.memory-claims", rule: "spelling-variant" }, policy: { id: "entity-review", revision: "1" }, checksums,
    candidates: [{ operation: "merge", subjects: SUBJECTS, claims: [{ claim: owner, stance: "supports" }], confidenceComponents: { name: 0.8 } }],
  }));
}

/** A proposal built straight from Survey with `alternatives` relationships, each with `evidence` pieces of `excerptBytes` bytes. */
function synthetic({ alternatives = 1, evidence = 1, excerptBytes = 20 } = {}) {
  return createEntityProposal({
    revision: "1", proposer: { id: "test" }, policy: { id: "p", revision: "1" },
    alternatives: Array.from({ length: alternatives }, (_, a) => ({
      subjects: [{ subjectType: "person", subjectId: `a-${a}` }, { subjectType: "person", subjectId: `b-${a}` }],
      operation: "merge", confidenceComponents: {},
      evidence: Array.from({ length: evidence }, (__, e) => ({
        id: `ev-${a}-${e}`, sourceRef: "s", sourceId: "s", checksum: "c", observedAt: "2026-01-01T00:00:00Z", locatorScheme: "text-span", locator: "0-1", excerpt: "x".repeat(excerptBytes), stance: "supports",
      })),
    })),
  });
}

test("the subpath is the kit's own module and its declarations name exactly its exports", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  assert.deepEqual(Object.keys(entity).sort(), [...readFileSync(join(import.meta.dirname, "..", "..", "kits/knowledge/dream/entity-envelope.d.ts"), "utf8").matchAll(/^export (?:const|function) (\w+)/gm)].map((match) => match[1]).sort());
  for (const name of Object.keys(kitEntity)) assert.equal(entity[name], kitEntity[name], name);
  assert.equal(entity.ENTITY_PROPOSAL_CATEGORY, "memory.entity-proposal");
  assert.notEqual(entity.ENTITY_PROPOSAL_CATEGORY, claimEnvelope.MEMORY_CATEGORY);
});

test("a proposal the Kit and Survey made round-trips, re-encodes to the same bytes, and goes to Survey's review item unchanged", async () => {
  const proposal = await kitProposal();
  const body = entity.encodeEntityEnvelope(proposal);
  const decoded = entity.decodeEntityEnvelope(body);
  assert.ok(decoded);
  assert.equal(decoded.version, entity.ENTITY_ENVELOPE_VERSION);
  assert.deepEqual(decoded.proposal, proposal, "Survey's proposal, verbatim: no Kit copy of its fields");
  assert.equal(entity.encodeEntityEnvelope(decoded.proposal), body, "the codec writes what it reads");
  assert.equal(entityProposalToReviewItem(decoded.proposal).metadata.name, proposal.id, "Survey builds its own review item from what was read");
  assert.equal(entity.entityProposalKey(proposal), `memory.entity-proposal:${proposal.id}`);
  assert.equal(entity.entityProposalKey(await kitProposal()), entity.entityProposalKey(proposal), "the key is the same on a retry");
  const title = entity.entityProposalTitle(proposal);
  assert.match(title, /\bmerge\b/);
  assert.match(title, /\bmaya chen\b/);
  assert.match(title, /\bm\. chen\b/);
  assert.ok(decoded.proposal.spec.alternatives[0].evidence.every((item) => item.excerpt && item.checksum && item.locator), "evidence spans are kept");
});

test("a body edited after it was written, or not in Survey's normal form, does not decode", async () => {
  const proposal = await kitProposal();
  const edit = (change) => { const copy = JSON.parse(entity.encodeEntityEnvelope(proposal)); change(copy); return JSON.stringify(copy); };
  const refused = {
    "excerpt edited": edit((v) => { v.proposal.spec.alternatives[0].evidence[0].excerpt += "!"; }),
    "id edited": edit((v) => { v.proposal.id = `${v.proposal.id.slice(0, -1)}0`; }),
    "name edited": edit((v) => { v.proposal.metadata.name = "other"; }),
    "operation edited": edit((v) => { v.proposal.spec.alternatives[0].operation = "split"; }),
    "stance edited": edit((v) => { v.proposal.spec.alternatives[0].evidence[0].stance = "contradicts"; }),
    "extra field on the proposal": edit((v) => { v.proposal.extra = true; }),
    "extra field on the envelope": edit((v) => { v.reviewed = true; }),
    "other version": edit((v) => { v.version = "2.0"; }),
    "no proposal": JSON.stringify({ version: "1.0" }),
    "proposal is a list": JSON.stringify({ version: "1.0", proposal: [] }),
    "not json": "not json",
    "empty": "",
  };
  for (const [label, body] of Object.entries(refused)) assert.equal(entity.decodeEntityEnvelope(body), null, label);
  for (const notString of [undefined, null, 7, {}, []]) assert.equal(entity.decodeEntityEnvelope(notString), null);
  // Survey's normal form orders alternatives by content id and evidence by id; the same facts in another order are a different body.
  const two = synthetic({ alternatives: 2, evidence: 2 });
  const reordered = JSON.parse(entity.encodeEntityEnvelope(two));
  reordered.proposal.spec.alternatives.reverse();
  assert.equal(entity.decodeEntityEnvelope(JSON.stringify(reordered)), null);
});

test("encode refuses anything that is not exactly what Survey returned", async () => {
  const proposal = await kitProposal();
  for (const [label, value] of Object.entries({
    "the spec alone": proposal.spec,
    "a hand-made lookalike": { id: proposal.id, apiVersion: proposal.apiVersion, metadata: proposal.metadata, kind: "EntityProposal", spec: { ...proposal.spec, revision: "2" } },
    "an edited copy": { ...proposal, spec: { ...proposal.spec, policy: { id: "x", revision: "9" } } },
    "null": null,
    "a string": "proposal",
  })) {
    assert.throws(() => entity.encodeEntityEnvelope(value), { code: "DREAM_ENTITY_PROPOSAL_INVALID" }, label);
  }
  assert.throws(() => entity.entityProposalKey({ ...proposal, id: "x" }), { code: "DREAM_ENTITY_PROPOSAL_INVALID" });
  assert.throws(() => entity.entityProposalTitle(null), { code: "DREAM_ENTITY_PROPOSAL_INVALID" });
});

test("every bound is accepted at max and refused at max + 1, never truncated", () => {
  const atMax = [
    synthetic({ alternatives: entity.MAX_ENTITY_ALTERNATIVES }),
    synthetic({ evidence: entity.MAX_ENTITY_EVIDENCE }),
    synthetic({ excerptBytes: entity.MAX_ENTITY_EXCERPT_BYTES }),
  ];
  for (const proposal of atMax) assert.ok(entity.decodeEntityEnvelope(entity.encodeEntityEnvelope(proposal)));
  // The worst honest proposal stays under the envelope bound.
  const worst = entity.encodeEntityEnvelope(synthetic({ alternatives: entity.MAX_ENTITY_ALTERNATIVES, evidence: entity.MAX_ENTITY_EVIDENCE, excerptBytes: entity.MAX_ENTITY_EXCERPT_BYTES }));
  assert.ok(Buffer.byteLength(worst) <= entity.MAX_ENTITY_ENVELOPE_BYTES, `${Buffer.byteLength(worst)} > ${entity.MAX_ENTITY_ENVELOPE_BYTES}`);
  const over = [
    synthetic({ alternatives: entity.MAX_ENTITY_ALTERNATIVES + 1 }),
    synthetic({ evidence: entity.MAX_ENTITY_EVIDENCE + 1 }),
    synthetic({ excerptBytes: entity.MAX_ENTITY_EXCERPT_BYTES + 1 }),
  ];
  for (const proposal of over) {
    assert.throws(() => entity.encodeEntityEnvelope(proposal), { code: "DREAM_ENTITY_PROPOSAL_TOO_LARGE" });
    // A body written by something else is refused on read as well.
    assert.equal(entity.decodeEntityEnvelope(JSON.stringify({ version: "1.0", proposal })), null);
  }
  assert.equal(entity.decodeEntityEnvelope(`{"version":"1.0","pad":"${"x".repeat(entity.MAX_ENTITY_ENVELOPE_BYTES)}"}`), null, "an over-size body is refused unread");
});

test("indexing reads the entity category only, counts what does not verify, and does not disturb the claim reader", async () => {
  const proposal = await kitProposal();
  const good = { id: "p1", proposer_id: "knowledge.dream", state: "pending", candidate: { category: entity.ENTITY_PROPOSAL_CATEGORY, body: entity.encodeEntityEnvelope(proposal) } };
  const bad = { id: "p2", proposer_id: "knowledge.dream", state: "pending", candidate: { category: entity.ENTITY_PROPOSAL_CATEGORY, body: JSON.stringify({ version: "1.0", proposal: { ...proposal, id: "tampered" } }) } };
  const other = { id: "p3", proposer_id: "x", state: "pending", candidate: { category: "memory.claim", body: "{}" } };
  const indexed = entity.indexEntityProposals([good, bad, other]);
  assert.deepEqual([...indexed.byId.keys()], [proposal.id]);
  assert.equal(indexed.byId.get(proposal.id).proposal, good);
  assert.equal(indexed.unreadable, 1, "a proposal that does not verify is counted and never returned");
  // The claim reader ignores the entity category entirely: it is neither indexed nor reported as this run's corrupt proposal.
  const claims = claimEnvelope.indexProposals([good, bad], "knowledge.dream");
  assert.equal(claims.byClaim.size, 0);
  assert.equal(claims.unreadable, 0);
});
