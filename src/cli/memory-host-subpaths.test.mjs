// The package entries a host uses to read and brief from memory it keeps itself (kontourai/flow-agents#1611):
// `memory-envelope`, `memory-marker`, `memory-brief` and `memory-recall`. They are subpath exports of the canonical kit
// modules, not copies, so these tests (1) import them through the package exports map and prove they ARE the kit's modules,
// (2) prove the declarations name exactly what the modules export, and (3) run them over what a real dream run wrote.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { KitDefaultStoreAdapter, standaloneFileMutationLock } from "@kontourai/corpus-store";
import { memoryClaim } from "@kontourai/flow-agents/memory-claims";
import * as envelope from "@kontourai/flow-agents/memory-envelope";
import * as marker from "@kontourai/flow-agents/memory-marker";
import * as brief from "@kontourai/flow-agents/memory-brief";
import * as recall from "@kontourai/flow-agents/memory-recall";
import * as kitEnvelope from "../../kits/knowledge/dream/envelope.js";
import * as kitMarker from "../../kits/knowledge/memory-marker.js";
import * as kitBrief from "../../kits/knowledge/dream/brief.js";
import * as kitRecall from "../../kits/knowledge/context-check/memory-recall.js";
import { runDream } from "../../kits/knowledge/dream/run.js";
import { hostFor, noApplyStore, runOptions, scriptedExtract, workspace } from "./dream-support.mjs";

const here = import.meta.dirname;
const declared = (file) => [...fs.readFileSync(path.join(here, "..", "..", file), "utf8").matchAll(/^export (?:const|function) (\w+)/gm)].map((match) => match[1]).sort();

test("each subpath is the canonical kit module, not a copy, and its declarations name exactly its exports", () => {
  for (const [published, kit, declarations] of [
    [envelope, kitEnvelope, "kits/knowledge/dream/envelope.d.ts"],
    [marker, kitMarker, "kits/knowledge/memory-marker.d.ts"],
    [brief, kitBrief, "kits/knowledge/dream/brief.d.ts"],
    [recall, kitRecall, "kits/knowledge/context-check/memory-recall.d.ts"],
  ]) {
    assert.deepEqual(Object.keys(published).sort(), declared(declarations), declarations);
    for (const name of Object.keys(kit)) assert.equal(published[name], kit[name], `${name} is the kit's own export`);
  }
  assert.equal(marker.INJECTED_MEMORY_OPEN, "<flow-agents-injected-memory>");
  assert.equal(marker.INJECTED_MEMORY_CLOSE, "</flow-agents-injected-memory>");
});

async function dreamed(t, { transcripts = ["codex-rollout.jsonl"] } = {}) {
  const ws = workspace({ transcripts });
  t.after(ws.cleanup);
  fs.mkdirSync(ws.memoryRoot, { recursive: true });
  const store = new KitDefaultStoreAdapter({ storeRoot: ws.memoryRoot, coordinationDirectory: path.join(ws.root, "coordination"), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
  assert.equal((await runDream(hostFor(ws, noApplyStore(store), await scriptedExtract()), runOptions(ws))).status, "success");
  return { ws, store, proposals: await store.listProposals() };
}

const itemOf = (proposal, state = "pending") => {
  const decoded = envelope.decodeEnvelope(proposal.candidate.body);
  return { claim: decoded.claim, project: decoded.project, agreement: decoded.agreement, state, routing: { outcome: decoded.decision.outcome } };
};

test("a host reads what dream wrote through the codec: decode, index, and encode back to the same bytes", async (t) => {
  const { proposals } = await dreamed(t);
  const decoded = proposals.map((proposal) => envelope.decodeEnvelope(proposal.candidate.body));
  assert.ok(decoded.length >= 2 && decoded.every(Boolean));
  assert.equal(proposals[0].candidate.category, envelope.MEMORY_CATEGORY);
  for (const [index, proposal] of proposals.entries()) {
    const value = decoded[index];
    assert.equal(value.dream, envelope.ENVELOPE_VERSION);
    assert.equal(envelope.encodeEnvelope({ plan: value.plan, index: value.sitting.index, decision: value.decision, sitting: { id: value.sitting.id, contentHash: value.sitting.contentHash, visibilityKey: value.sitting.visibilityKey } }), proposal.candidate.body, "the codec writes what it reads");
  }
  const indexed = envelope.indexProposals(proposals, "knowledge.dream");
  assert.equal(indexed.byClaim.size, decoded.length);
  assert.equal(indexed.unreadable, 0);
  // A body that was edited after the fact does not decode.
  const tampered = JSON.parse(proposals[0].candidate.body);
  tampered.claim.value = "something else";
  assert.equal(envelope.decodeEnvelope(JSON.stringify(tampered)), null);
  assert.equal(envelope.decodeEnvelope("not json"), null);
});

test("a host compiles the session brief from the same claims, every entry says its posture and review label, and no marker survives", async (t) => {
  const { proposals } = await dreamed(t);
  const items = proposals.map((proposal) => itemOf(proposal, "applied"));
  const ranked = brief.rankItems(items, { now: "2026-11-02T00:00:00.000Z", includeUnreviewed: true });
  assert.ok(ranked.length > 0);
  const compiled = brief.compileBrief(ranked, { budget: 4096 });
  assert.ok(compiled.entries.length > 0);
  for (const entry of compiled.entries) {
    assert.match(entry, /^\[(stated|proposed) · (unreviewed|confirmed|corrected|in-review)\] /);
    assert.ok(!entry.includes(marker.INJECTED_MEMORY_OPEN) && !entry.includes(marker.INJECTED_MEMORY_CLOSE));
  }
  assert.deepEqual(JSON.parse(compiled.content), { version: brief.BRIEF_VERSION, entries: compiled.entries });
  // The byte budget is a hard bound.
  assert.ok(brief.compileBrief(ranked, { budget: 40 }).bytes <= 40);
  // A pending claim waits for review unless the host asks for unreviewed ones.
  const pending = proposals.map((proposal) => itemOf(proposal, "pending"));
  assert.deepEqual(brief.rankItems(pending, { now: "2026-11-02T00:00:00.000Z" }), []);
});

test("a host asks a question of the claims it holds: answered from the claim's own excerpt, labelled, and never from a sealed claim", async (t) => {
  const { proposals } = await dreamed(t);
  const items = proposals.map((proposal) => itemOf(proposal));
  const answer = recall.recallMemoryClaims({ items, question: "What is the rounding mode?", now: "2026-11-02T12:00:00.000Z" });
  assert.equal(answer.outcome, "answered", JSON.stringify(answer.results.map((r) => [r.text, r.outcome, r.reason])));
  const top = answer.results.find((result) => result.outcome === "answered");
  assert.match(top.text, /^\[stated · unreviewed\] /, "posture and review label stay on the claim");
  assert.equal(top.status, "current");
  assert.equal(top.evidence ?? answer.evidence, "source_excerpt");
  assert.ok(top.excerpt.includes(top.passage), "the quoted sentence is in the excerpt");
  assert.deepEqual(top.missing_terms, ["mode"].filter((term) => !`${top.text} ${top.passage}`.toLowerCase().includes(term)));

  const unrelated = recall.recallMemoryClaims({ items, question: "Who owns the quarterly invoicing process?", now: "2026-11-02T12:00:00.000Z" });
  assert.equal(unrelated.outcome, "abstained");
  assert.equal(unrelated.abstained, "no_claim_covers_question");

  const sealed = { ...items[0], claim: memoryClaim({ ...items[0].claim, visibility: undefined }) };
  const hidden = recall.recallMemoryClaims({ items: [sealed], question: "What is the rounding mode?", now: "2026-11-02T12:00:00.000Z" });
  assert.equal(hidden.excluded.sealed, 1);
  assert.deepEqual(hidden.results, []);
});

test("recall judges currency by the brief's rules: a rival contests, a successor replaces, an ended interval is not in effect", async (t) => {
  const { proposals } = await dreamed(t);
  const template = itemOf(proposals[0]).claim;
  const { id, schema_version, supersedes, ...base } = template;
  const make = (fields) => memoryClaim({ ...base, subject: { id: "cache layer", label: "cache layer", type: "service" }, property: "eviction policy", posture: "stated", speaker: "user", ...fields });
  const lru = make({ value: "LRU eviction", source: { ...base.source, excerpt: "The cache layer uses LRU eviction." } });
  const fifo = make({ value: "FIFO eviction", source: { ...base.source, excerpt: "The cache layer uses FIFO eviction." } });
  const ask = (items, now = "2026-11-02T12:00:00.000Z") => recall.recallMemoryClaims({ items, question: "What eviction policy does the cache layer use?", now });
  const item = (claim, state = "applied") => ({ claim, project: null, agreement: { passes: 2, agreeing: 2 }, state, routing: { outcome: "proposed" } });

  const contested = ask([item(lru), item(fifo)]);
  assert.equal(contested.outcome, "abstained");
  assert.deepEqual(contested.results.map((result) => [result.status, result.reason]).sort(), [["contested", "contested"], ["contested", "contested"]]);

  const newer = make({ value: "FIFO eviction", source: { ...base.source, excerpt: "We switched the cache layer to FIFO eviction." }, supersedes: [{ claimId: lru.id, kind: "succession", reason: "replaced" }] });
  const replaced = ask([item(lru), item(newer)]);
  assert.equal(replaced.outcome, "answered");
  const byId = Object.fromEntries(replaced.results.map((result) => [result.claim_id, result]));
  assert.equal(byId[lru.id].status, "superseded");
  assert.equal(byId[lru.id].reason, "replaced");
  assert.deepEqual(byId[lru.id].history.replaced_by, [newer.id]);
  assert.deepEqual(byId[newer.id].history.supersedes, [lru.id]);
  assert.equal(byId[newer.id].outcome, "answered");

  const ended = make({ value: "LRU eviction", validTime: { until: "2026-10-01T00:00:00.000Z" }, source: { ...base.source, excerpt: "The cache layer uses LRU eviction." } });
  const expired = ask([item(ended)]);
  assert.equal(expired.outcome, "abstained");
  assert.equal(expired.results[0].reason, "not_in_effect");
  assert.equal(ask([item(ended)], "2026-09-01T00:00:00.000Z").outcome, "answered", "the same claim is current inside its interval");

  // Input errors name what is missing.
  assert.throws(() => recall.recallMemoryClaims({ items: [], question: " ", now: "2026-11-02T00:00:00Z" }), /needs a question/);
  assert.throws(() => recall.recallMemoryClaims({ items: [], question: "q", now: "yesterday" }), /ISO instant/);
  assert.throws(() => recall.recallMemoryClaims({ question: "q", now: "2026-11-02T00:00:00Z" }), /needs `items`/);
});
