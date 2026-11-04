/**
 * Recall on a real store (kontourai/flow-agents#1595, #1596, #1597).
 *
 * The records are written by the Kit's own default store (create, supersede, retire), committed to a real Git repository, and
 * then the working tree is changed so a read that ignored the pinned revision would fail. Nothing here hand-writes a claims
 * manifest: the manifest is derived from the records.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DefaultKnowledgeStore } from "../adapters/default-store/index.js";
import { runLivingContext, validateLivingContextInput } from "./living-context.js";
import { answerLivingContext as answerWith, createLineSupportVerifier } from "./living-context-answer.js";
import { deriveStoreManifest, storeKnowledgeRoot, MAX_RECORD_BYTES } from "./living-context-store.js";
import { selectClaimsForQuestion, bestPassage, terms } from "./living-context-select.js";
import { askLivingContext } from "./living-context-ask.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOW = "2026-11-04T16:00:00Z";
const verifier = createLineSupportVerifier();
const ask = (args) => askLivingContext({ verifier, now: NOW, reader: "maintainer", ...args });

const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
class ClockStore extends DefaultKnowledgeStore {
  _now() { return this.at; }
}
const remove = (...dirs) => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); };

const CI_OLD = "# CI compute\n\nFlow Agents bounds CI compute with four repository-wide queue: max concurrency\ngroups. Every participating workflow joins one of them.\n";
const CI_NEW = "# CI compute\n\nFlow Agents has **no repository-wide job-level compute cap**. No participating\nworkflow sets a queue: max group, and the platform's own runner limit is the only\nceiling.\n\n- Heavy jobs take about 25 minutes.\n";

/** A store written by the Kit's writer, committed, then dirtied so only the commit is truthful. */
async function seeded() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "living-context-ask-")));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "fixture@example.test"]);
  git(repo, ["config", "user.name", "Fixture"]);
  const store = new ClockStore({ storeRoot: path.join(repo, "knowledge") });
  const make = async (at, input) => { store.at = at; return store.create({ provenance: { agent: "fixture" }, ...input }); };
  const ids = {};
  ids.ciOld = await make("2026-10-01T10:00:00.000Z", { type: "compiled", title: "CI compute policy: four queue max groups", category: "decision.ci", tags: ["ci", "compute"], body: CI_OLD });
  ids.ciNew = await make("2026-10-05T10:00:00.000Z", { type: "compiled", title: "CI compute policy: no repository-wide caps", category: "decision.ci", tags: ["ci", "compute"], body: CI_NEW });
  store.at = "2026-10-05T11:00:00.000Z";
  await store.supersede(ids.ciNew, [ids.ciOld], { agent: "fixture", rationale: "caps removed" });
  // A raw capture with no links at all, next to a compiled hub that many records link to.
  ids.hub = await make("2026-10-02T10:00:00.000Z", { type: "compiled", title: "Memory handling overview", category: "decision.memory", tags: ["memory"], body: "# Memory\n\nMemory notes. See [[x]].\n", links: [] });
  ids.raw = await make("2026-10-03T10:00:00.000Z", { type: "raw", title: "Learning: erasure of memory is a Corpus purge", category: "decision.memory", tags: ["erasure", "memory"], body: "# Erasure\n\nCorpus owns erasure of memory: a purge scrubs every sourced proposal and its dependent records.\nStation only calls it.\n" });
  ids.retired = await make("2026-10-04T10:00:00.000Z", { type: "raw", title: "Cron sweeps run the nightly refresh", category: "decision.workflow", tags: ["cron"], body: "# Cron\n\nA nightly cron sweep refreshes the desk digest.\n" });
  store.at = "2026-10-06T10:00:00.000Z";
  await store.retire(ids.retired, "retired", { agent: "fixture", rationale: "no standing loops" });
  ids.titled = await make("2026-10-07T09:00:00.000Z", { type: "raw", title: "Signing keys are rotated quarterly", category: "decision.security", tags: ["keys"], body: "# Signing keys are rotated quarterly\n\nNothing else is recorded here.\n" });
  ids.implemented = await make("2026-10-07T10:00:00.000Z", { type: "raw", title: "Rotate the signing key quarterly", category: "decision.security", tags: ["keys"], body: "# Keys\n\nRotate the signing key every quarter.\n" });
  store.at = "2026-10-08T10:00:00.000Z";
  await store.retire(ids.implemented, "implemented", { agent: "fixture", rationale: "done", implementedByRef: "x#1" });
  // Files the real store layout also holds (the ops store keeps records in topic folders): a record with an unrecognised status,
  // a duplicate id, a record with no title, an archived record, a symlink, an over-size record, and prose that is not a record.
  const frontmatter = (id, extra = "") => `---\nid: ${id}\ntype: raw\ntitle: "${id === "blank-title" ? " " : `Odd ${id}`}"\ncategory: decision.odd\ntags: []\nstatus: ${extra || "active"}\ncreated_at: "2026-10-09T10:00:00.000Z"\nupdated_at: "2026-10-09T10:00:00.000Z"\nprovenance:\n  agent: fixture\nlinks: []\nmutation_log: []\n---\n\nOdd body.\n`;
  const put = (relative, text) => { const file = path.join(repo, "knowledge", relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put("topic/odd-status.md", frontmatter("odd-status", "owner-authorized"));
  put("topic/dup-a.md", frontmatter("dup"));
  put("topic/dup-b.md", frontmatter("dup"));
  put("topic/blank.md", frontmatter("blank-title"));
  put("topic/bad id.md", frontmatter("bad id"));
  put("archive/old.md", frontmatter("archived"));
  put("topic/notes.md", "# Notes\n\nNo frontmatter here.\n");
  put("topic/big.md", `${frontmatter("big")}${"x".repeat(MAX_RECORD_BYTES)}\n`);
  fs.symlinkSync(path.join(repo, "knowledge/topic/odd-status.md"), path.join(repo, "knowledge/topic/link.md"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed"]);
  const revision = git(repo, ["rev-parse", "HEAD"]);
  // Dirty the working tree: a read of anything but the commit would see this instead.
  fs.rmSync(path.join(repo, "knowledge/records", `${ids.raw}.md`));
  fs.writeFileSync(path.join(repo, "knowledge/records", `${ids.ciNew}.md`), "---\nid: gone\n---\nchanged\n");
  return { repo, revision, ids };
}

// Every test only reads the seeded repository, so one is built and shared.
let shared;
const sharedSeed = async () => (shared ??= seeded());
after(() => { if (shared) shared.then((s) => remove(s.repo)); });

const derive = (s, extra = {}) => deriveStoreManifest({ repoRoot: s.repo, revision: s.revision, readers: ["maintainer"], ...extra });
const claimOf = (derived, id) => derived.manifest.claims.find((claim) => claim.id === id);

describe("#1595: the manifest is derived from the records at the pinned revision", () => {
  test("maps every record by the documented conservative rules and names what it excludes", async () => {
    const s = await sharedSeed();
    const derived = derive(s);
    const { ids } = s;
    assert.deepEqual(derived.excluded.map((entry) => [entry.reason, entry.id ?? entry.path.split("/").pop()]).sort(), [
      ["blank_title", "blank-title"], ["duplicate_id", "dup"], ["duplicate_id", "dup"], ["invalid_id", "bad id"], ["too_large", "big.md"],
    ]);
    assert.equal(derived.stats.skipped_not_record, 1, "prose without record frontmatter is counted, not excluded");
    assert.ok(!derived.manifest.claims.some((claim) => /archive|link\.md/.test(claim.authority.path)), "archive/ and symlinks are not records");

    const status = Object.fromEntries(derived.manifest.claims.map((claim) => [claim.id, claim.status]));
    assert.equal(status[ids.ciOld], "superseded");
    assert.equal(status[ids.ciNew], "current");
    assert.equal(status[ids.raw], "current", "a raw record is as current as a compiled one");
    assert.equal(status[ids.retired], "unverifiable", "retired without a successor is not claimed current");
    assert.equal(status[ids.implemented], "current");
    assert.equal(status["odd-status"], "unverifiable", "an unrecognised status is never current");
    assert.equal(derived.records.find((record) => record.claim_id === ids.retired).mapping, "retired_without_successor");

    const old = claimOf(derived, ids.ciOld), next = claimOf(derived, ids.ciNew);
    assert.equal(old.superseded_by, ids.ciNew);
    assert.equal(old.supersession_kind, "succession");
    assert.equal(old.supersession_recorded_at, "2026-10-05T11:00:00.000Z", "the edge is recorded when the supersede was logged");
    assert.equal(old.slot, next.slot, "a lineage shares a slot");
    assert.match(old.slot, /^lineage:/);
    assert.match(claimOf(derived, ids.raw).slot, /^record:/, "an unrelated record has a slot of its own");
    assert.equal(next.recorded_at, "2026-10-05T10:00:00.000Z");
    assert.deepEqual(next.valid_time, { from: "2026-10-05T10:00:00.000Z" });
    assert.deepEqual(next.visibility, { audiences: ["maintainer"] });
    assert.equal(next.authority.path, `knowledge/records/${ids.ciNew}.md`);
    assert.equal(next.claim, "CI compute policy: no repository-wide caps");
    assert.equal(next.review, undefined, "no record carries a per-claim human review");
  });

  test("reads the commit, not the working tree, and refuses a store with no declared readers", async () => {
    const s = await sharedSeed();
    const derived = derive(s);
    assert.ok(claimOf(derived, s.ids.raw), "a record deleted from the working tree after the commit is still in the pinned revision");
    assert.equal(claimOf(derived, s.ids.ciNew).claim, "CI compute policy: no repository-wide caps", "an edit made after the commit is not read");
    for (const readers of [undefined, [], [" "], ["a", "a"]]) {
      assert.throws(() => deriveStoreManifest({ repoRoot: s.repo, revision: s.revision, readers }), (cause) => cause.code === "READERS_REQUIRED", JSON.stringify(readers));
    }
    assert.throws(() => deriveStoreManifest({ repoRoot: s.repo, revision: "HEAD", readers: ["a"] }), (cause) => cause.code === "INVALID_CONTEXT_CHECK_INPUT");
  });

  test("recall accepts the derived manifest in place of a committed one and keeps its guarantees", async () => {
    const s = await sharedSeed();
    const derived = derive(s);
    const root = storeKnowledgeRoot();
    const input = (overrides = {}) => ({
      schema_version: "1.1", workspace: "w", repository: "r", revision: s.revision, target_audience: "maintainer", reader: "maintainer",
      as_of: { now: NOW }, budget: { max_tokens: 20000 }, claim_ids: [s.ids.ciOld, s.ids.ciNew, s.ids.retired], knowledge_roots: [root], ...overrides,
    });
    const result = runLivingContext({ repoRoot: s.repo, input: input(), derivedManifests: { [root.id]: derived.manifest }, write: false });
    const by = Object.fromEntries(result.recalls.map((recall) => [recall.claim_id, recall]));
    assert.equal(by[s.ids.ciOld].status, "superseded");
    assert.equal(by[s.ids.ciOld].superseded_by, s.ids.ciNew);
    assert.equal(by[s.ids.ciNew].status, "current");
    assert.equal(by[s.ids.retired].status, "unverifiable");
    assert.deepEqual(by[s.ids.retired].reasons, ["declared_unverifiable"]);
    // Time travel on the derived manifest: before the successor existed, the predecessor was current.
    const earlier = runLivingContext({ repoRoot: s.repo, input: input({ claim_ids: [s.ids.ciOld], as_of: { now: NOW, valid_at: "2026-10-02T00:00:00Z", known_at: "2026-10-02T00:00:00Z" } }), derivedManifests: { [root.id]: derived.manifest }, write: false });
    assert.equal(earlier.recalls[0].status, "current");
    // A reader the host did not declare is refused, exactly as for a committed manifest.
    assert.throws(() => runLivingContext({ repoRoot: s.repo, input: input({ reader: "stranger" }), derivedManifests: { [root.id]: derived.manifest }, write: false }), (cause) => cause.code === "UNKNOWN_READER_IDENTITY");
    // Without the manifest the root falls back to git show, and the store has no committed manifest: the derivation is what supplied it.
    assert.throws(() => runLivingContext({ repoRoot: s.repo, input: input(), write: false }), (cause) => cause.code === "REVISION_READ_FAILED");
  });
});

describe("#1595: question to claim", () => {
  const docs = [
    { id: "a", title: "Memory erasure is a Corpus purge", tags: ["erasure"], category: "decision.memory", body: "Corpus owns erasure of memory.\nStation only calls it." },
    { id: "b", title: "Station overview", tags: [], category: "product.station", body: "Station runs agents. Memory is a feature. Corpus stores records." },
    { id: "c", title: "Unrelated release notes", tags: [], category: "release", body: "Version 9 shipped on Tuesday." },
  ];

  test("nominates the record that covers the question, ranks by rarity, and declines a question nothing covers", () => {
    const hit = selectClaimsForQuestion({ question: "Who owns erasure of memory: Station or Corpus?", documents: docs });
    assert.equal(hit.selected[0].id, "a");
    assert.ok(hit.selected[0].coverage > 0.9);
    assert.match(hit.selected[0].passage, /Corpus owns erasure of memory\./);
    const miss = selectClaimsForQuestion({ question: "What is the retention period for audit logs?", documents: docs });
    assert.deepEqual(miss.selected, [], "no record covers it, so none is nominated");
    // Some words match, but the question's rarer words appear nowhere: the partial match is reported below the bar, never nominated.
    const partial = selectClaimsForQuestion({ question: "Station memory retention policy", documents: docs });
    assert.deepEqual(partial.selected, []);
    assert.ok(partial.below_threshold.length > 0 && partial.below_threshold.every((entry) => entry.coverage < 0.6));
    assert.ok(selectClaimsForQuestion({ question: "Station memory retention policy", documents: docs, minCoverage: 0 }).selected.length > 0, "the bar is what withholds them");
    assert.deepEqual(selectClaimsForQuestion({ question: "what is the?", documents: docs }).terms, [], "a question of stop words has no terms");
  });

  test("a term in every record decides nothing: the rare term picks the record", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, title: `Note ${i}`, tags: [], category: "x", body: "policy policy policy" }));
    const result = selectClaimsForQuestion({ question: "policy rotation", documents: [...many, { id: "r", title: "Rotation", tags: [], category: "x", body: "Keys rotate quarterly. rotation is automatic." }], minCoverage: 0.1 });
    assert.equal(result.selected[0].id, "r");
  });

  test("there is no type or link prior: a raw capture beats a compiled hub that only mentions the topic", () => {
    const result = selectClaimsForQuestion({
      question: "reviewer kind attestation",
      documents: [
        { id: "hub", title: "Compiled: ops hub", tags: ["hub"], category: "ops.hub", body: "reviewer notes, kind of, attest." },
        { id: "raw", title: "Reviewer kind attestation learning", tags: [], category: "decision.workflow", body: "Reviewer kind attestation is host-supplied." },
      ],
    });
    assert.equal(result.selected[0].id, "raw");
  });

  test("a passage is verbatim, bounded, never cut mid-sentence, and withheld when it is off the question", () => {
    const long = `${"Filler sentence about nothing. ".repeat(40)}Corpus owns erasure of memory. ${"More filler follows here. ".repeat(40)}`;
    const passage = bestPassage(long, terms("erasure of memory corpus"), 200);
    assert.ok(passage.length <= 200 && passage.includes("Corpus owns erasure of memory."), passage);
    assert.ok(passage.split(/(?<=\.) /).every((sentence) => long.includes(sentence)), "every sentence is the document's own");
    assert.equal(bestPassage("A giant single sentence " + "word ".repeat(300) + "about erasure.", ["erasure"], 100), "", "a single sentence over the bound is not quoted rather than cut");
    const offTopic = selectClaimsForQuestion({ question: "erasure memory corpus station", documents: [{ id: "x", title: "Erasure", tags: [], category: "c", body: `${"filler words ".repeat(80)}\n\nThe memory subsystem is large.` }, ...docs], minCoverage: 0.2, minPassageCoverage: 0.9 });
    assert.equal(offTopic.selected.find((entry) => entry.id === "x")?.passage, "", "nominated but not quoted");
  });
});

describe("#1595: ask a real store a question", () => {
  test("answers from the current record, cites it, and shows the passage the verifier found in it", async () => {
    const s = await sharedSeed();
    const result = await ask({ repoRoot: s.repo, revision: s.revision, question: "Who owns erasure of memory: Station or Corpus?" });
    assert.equal(result.outcome, "answered");
    const top = result.results[0];
    assert.equal(top.claim_id, s.ids.raw, "raw records are found");
    assert.equal(top.path, `knowledge/records/${s.ids.raw}.md`);
    assert.equal(top.status, "current");
    assert.equal(top.verification, "supported");
    assert.match(top.passage, /^Corpus owns erasure of memory: a purge scrubs every sourced proposal and its dependent records\./);
    assert.equal(result.revision, s.revision);
  });

  test("the compute-policy question finds the successor, and the superseded record is shown as superseded, not answered", async () => {
    const s = await sharedSeed();
    const result = await ask({ repoRoot: s.repo, revision: s.revision, question: "What is the CI compute policy?" });
    const by = Object.fromEntries(result.results.map((entry) => [entry.claim_id, entry]));
    assert.equal(by[s.ids.ciNew].outcome, "answered");
    assert.match(by[s.ids.ciNew].passage, /no repository-wide job-level compute cap/);
    assert.equal(by[s.ids.ciOld].status, "superseded");
    assert.equal(by[s.ids.ciOld].outcome, "abstained");
    assert.equal(by[s.ids.ciOld].reason, "not_current");
    assert.equal(by[s.ids.ciOld].superseded_by, s.ids.ciNew);
    // Asked as of before the successor existed, the old policy is the current one.
    const earlier = await askLivingContext({ repoRoot: s.repo, revision: s.revision, question: "What is the CI compute policy?", reader: "maintainer", now: "2026-10-03T00:00:00Z", verifier });
    const old = earlier.results.find((entry) => entry.claim_id === s.ids.ciOld);
    assert.equal(old.status, "current");
    assert.equal(old.outcome, "answered");
    assert.ok(!earlier.results.some((entry) => entry.claim_id === s.ids.ciNew && entry.status === "current"), "a record created after the as-of is not current in it");
  });

  test("a superseded record that was nominated alone comes with the record that replaced it", async () => {
    const s = await sharedSeed();
    const only = (id, passage) => () => ({ terms: ["ci"], weights: new Map([["ci", 1]]), selected: [{ id, score: 1, coverage: 1, matched: ["ci"], passage }], below_threshold: [] });
    const result = await ask({ repoRoot: s.repo, revision: s.revision, question: "ci", select: only(s.ids.ciOld, "") });
    assert.deepEqual(result.results.map((entry) => [entry.claim_id, entry.status, entry.outcome, entry.via]), [
      [s.ids.ciOld, "superseded", "abstained", undefined],
      [s.ids.ciNew, "current", "abstained", `successor_of:${s.ids.ciOld}`],
    ]);
    assert.equal(result.results[1].reason, "no_passage_on_question", "a successor with nothing on the question is shown, not answered from");
  });

  test("a question the store does not talk about is an abstention that recalls nothing", async () => {
    const s = await sharedSeed();
    let calls = 0;
    const counting = { ...verifier, verify: (input) => { calls++; return verifier.verify(input); } };
    const result = await askLivingContext({ repoRoot: s.repo, revision: s.revision, question: "What is the data retention period for audit logs?", reader: "maintainer", now: NOW, verifier: counting });
    assert.equal(result.outcome, "abstained");
    assert.equal(result.abstained, "no_record_covers_question");
    assert.deepEqual(result.results, []);
    assert.equal(calls, 0, "the verifier is never asked");
  });

  test("a retired record with no successor is found but never answered from", async () => {
    const s = await sharedSeed();
    const result = await ask({ repoRoot: s.repo, revision: s.revision, question: "Do cron sweeps run the nightly refresh?" });
    const entry = result.results.find((candidate) => candidate.claim_id === s.ids.retired);
    assert.equal(entry.status, "unverifiable");
    assert.equal(entry.outcome, "abstained");
    assert.equal(entry.reason, "not_current");
    assert.equal(result.outcome, "abstained");
  });

  test("only declared readers may ask, the budget drops whole results by name, and a verifier is required", async () => {
    const s = await sharedSeed();
    await assert.rejects(ask({ repoRoot: s.repo, revision: s.revision, question: "CI compute policy", reader: "stranger", readers: ["maintainer"] }), (cause) => cause.code === "UNKNOWN_READER_IDENTITY");
    await assert.rejects(ask({ repoRoot: s.repo, revision: s.revision, question: "CI compute policy", verifier: undefined }), (cause) => cause.code === "VERIFIER_REQUIRED");
    await assert.rejects(ask({ repoRoot: s.repo, revision: s.revision, question: " " }), (cause) => cause.code === "QUESTION_REQUIRED");
    const tight = await ask({ repoRoot: s.repo, revision: s.revision, question: "What is the CI compute policy?", budgetTokens: 1 });
    assert.equal(tight.outcome, "abstained");
    assert.ok(tight.results.length > 0 && tight.results.every((entry) => entry.reason === "dropped_by_budget"), JSON.stringify(tight.results.map((entry) => entry.reason)));
  });

  test("a host selector replaces the lexical one and still goes through recall and the answer step", async () => {
    const s = await sharedSeed();
    const result = await ask({
      repoRoot: s.repo, revision: s.revision, question: "anything at all",
      select: () => ({ terms: ["rotate", "key"], weights: new Map([["rotate", 1], ["key", 1]]), selected: [{ id: s.ids.implemented, score: 1, coverage: 1, matched: ["rotate", "key"], passage: "Rotate the signing key every quarter." }], below_threshold: [] }),
    });
    assert.equal(result.outcome, "answered");
    assert.equal(result.results[0].claim_id, s.ids.implemented);
    // A selector that nominates a passage the record does not contain gets no answer.
    const forged = await ask({
      repoRoot: s.repo, revision: s.revision, question: "anything",
      select: () => ({ terms: ["key"], weights: new Map([["key", 1]]), selected: [{ id: s.ids.implemented, score: 1, coverage: 1, matched: ["key"], passage: "Rotate the signing key every day." }], below_threshold: [] }),
    });
    assert.equal(forged.outcome, "abstained");
    assert.equal(forged.results[0].reason, "not_addressed");
  });

  test("a current record with no passage on the question is never answered from, even when its title is a line of the record", async () => {
    const s = await sharedSeed();
    const result = await ask({
      repoRoot: s.repo, revision: s.revision, question: "anything",
      select: () => ({ terms: ["keys"], weights: new Map([["keys", 1]]), selected: [{ id: s.ids.titled, score: 1, coverage: 1, matched: ["keys"], passage: "" }], below_threshold: [] }),
    });
    assert.equal(result.results[0].status, "current");
    assert.equal(result.results[0].outcome, "abstained");
    assert.equal(result.results[0].reason, "no_passage_on_question");
    assert.equal(result.outcome, "abstained");
  });

  test("the CLI is read-only, exits 0 on an answer, and exits non-zero without its required arguments", async () => {
    const s = await sharedSeed();
    const cli = path.join(__dirname, "ask-cli.js");
    const before = git(s.repo, ["status", "--porcelain"]);
    const base = ["--repo", s.repo, "--revision", s.revision, "--reader", "maintainer", "--now", NOW];
    const answered = spawnSync(process.execPath, [cli, ...base, "Who owns erasure of memory: Station or Corpus?"], { encoding: "utf8" });
    assert.equal(answered.status, 0, answered.stderr);
    assert.match(answered.stdout, /A: ANSWERED/);
    assert.match(answered.stdout, new RegExp(`knowledge/records/${s.ids.raw}\\.md`));
    assert.equal(git(s.repo, ["status", "--porcelain"]), before, "the CLI writes nothing");
    const manifest = spawnSync(process.execPath, [cli, ...base, "--manifest"], { encoding: "utf8" });
    assert.equal(manifest.status, 0, manifest.stderr);
    assert.ok(JSON.parse(manifest.stdout).manifest.claims.length > 5);
    assert.notEqual(spawnSync(process.execPath, [cli, "--repo", s.repo, "a question"], { encoding: "utf8" }).status, 0);
    const refused = spawnSync(process.execPath, [cli, ...base.slice(0, 2), "HEAD", ...base.slice(4), "q"], { encoding: "utf8" });
    assert.notEqual(refused.status, 0, "a non-SHA revision is refused");
  });
});

describe("#1596: claim_ids alone is a request", () => {
  const request = (revision, overrides = {}) => ({
    schema_version: "1.1", workspace: "w", repository: "r", revision, target_audience: "maintainer", reader: "maintainer",
    as_of: { now: NOW }, budget: { max_tokens: 4000 }, knowledge_roots: [storeKnowledgeRoot()], ...overrides,
  });

  test("claim_ids without changed_surfaces or diff is valid, recalls exactly those claims, and reconciles clean", async () => {
    const s = await sharedSeed();
    const derived = derive(s);
    const input = request(s.revision, { claim_ids: [s.ids.ciNew] });
    assert.deepEqual(validateLivingContextInput(input), []);
    const result = runLivingContext({ repoRoot: s.repo, input, derivedManifests: { [storeKnowledgeRoot().id]: derived.manifest }, write: false });
    assert.deepEqual(result.recalls.map((recall) => [recall.claim_id, recall.status]), [[s.ids.ciNew, "current"]]);
    assert.deepEqual(result.recalls[0].matched_signals, ["claim_id"]);
    assert.deepEqual(result.input.changed_surfaces, []);
    assert.deepEqual(result.reconciliation.map((item) => item.status), ["clean"]);
    assert.deepEqual(result.proposals, []);
  });

  test("a request that names nothing says what to add, in one message", () => {
    const errors = validateLivingContextInput(request("0".repeat(40)));
    assert.equal(errors.length, 1, errors.join("; "));
    assert.match(errors[0], /claim_ids/);
    assert.match(errors[0], /changed_surfaces/);
    assert.match(errors[0], /diff\.paths/);
    assert.doesNotMatch(errors[0], /does not satisfy any allowed schema/);
    // Other errors are not hidden by it.
    assert.ok(validateLivingContextInput({ ...request("0".repeat(40), { claim_ids: ["ok"] }), budget: {} }).length > 0);
    assert.ok(validateLivingContextInput(request("0".repeat(40), { claim_ids: [] })).length > 0, "an empty claim_ids list still names nothing");
  });
});

describe("#1597: the deterministic verifier reads prose the way it is written", () => {
  const verdict = async (value, excerpt) => (await verifier.verify({ candidateId: "c", value, evidence: [{ id: "e", excerpt, locator: "l" }] })).result;
  const DOC = "# Compute budget\n\nFlow Agents has **no repository-wide job-level compute cap**. No participating\nworkflow sets a queue: max group. Heavy jobs take about 25 minutes.\n\n- Use `pnpm install` and see [the guide](http://example.test/guide).\n> Quoted: the platform decides.\n";

  test("supports a natural sentence of a hard-wrapped, marked-up paragraph (the dogfood case)", async () => {
    assert.equal(await verdict("Flow Agents has no repository-wide job-level compute cap.", DOC), "supported");
    assert.equal(await verdict("No participating workflow sets a queue: max group.", DOC), "supported", "a sentence that is wrapped across two lines");
    assert.equal(await verdict("Flow Agents has no repository-wide job-level compute cap. No participating workflow sets a queue: max group.", DOC), "supported", "consecutive sentences");
    assert.equal(await verdict("Use pnpm install and see the guide.", DOC), "supported", "a list item, with code and link markup removed");
    assert.equal(await verdict("flow agents has NO repository-wide   job-level compute cap", DOC), "supported", "case, spacing and the full stop do not matter");
  });

  test("still abstains on everything the document does not say as written", async () => {
    assert.equal(await verdict("Flow Agents has a repository-wide job-level compute cap.", DOC), "not-addressed", "the opposite claim");
    assert.equal(await verdict("Flow Agents has no repository-wide cap.", DOC), "not-addressed", "a paraphrase");
    assert.equal(await verdict("no repository-wide job-level compute cap", DOC), "not-addressed", "a fragment of a sentence");
    assert.equal(await verdict("Flow Agents has no repository-wide job-level compute cap. Heavy jobs take about 25 minutes.", DOC), "not-addressed", "two sentences that are not consecutive");
    assert.equal(await verdict("Compute budget Flow Agents has no repository-wide job-level compute cap.", DOC), "not-addressed", "a heading is not part of the next paragraph");
    assert.equal(await verdict("The platform decides.", "Quoted: the platform decides."), "not-addressed", "a sentence inside a longer one");
    assert.equal(await verdict("The retry limit is five.", "REJECTED statement: The retry limit is five.\nThis statement is false.\n"), "not-addressed", "a rejected quotation is not the statement");
    assert.equal(await verdict("The retry limit is five.", "---\nnote: The retry limit is five.\n---\n\nUnrelated.\n"), "not-addressed", "front matter is not prose");
    assert.equal(await verdict("The retry limit is five.", "```\nThe retry limit is five.\n```\n"), "supported", "a whole physical line still counts, as in version 2");
    assert.equal(await verdict("  ", DOC), "abstain");
  });

  test("end to end: a natural-language claim over a hard-wrapped authority is answered, an unsupported one abstains", async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "living-context-wrap-")));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "fixture@example.test"]);
    git(repo, ["config", "user.name", "Fixture"]);
    fs.mkdirSync(path.join(repo, "docs"));
    fs.writeFileSync(path.join(repo, "docs/ci.md"), DOC);
    const claim = (id, text) => ({ id, claim: text, status: "current", authority: { path: "docs/ci.md", citation: "ci" }, owning_source: { owner: "o", path: "docs/ci.md" }, affected_surfaces: ["docs/ci.md"], visibility: { audiences: ["maintainer"] }, recorded_at: "2026-01-01T00:00:00Z", slot: id });
    fs.mkdirSync(path.join(repo, "knowledge"));
    fs.writeFileSync(path.join(repo, "knowledge/claims.json"), JSON.stringify({ readers: ["maintainer"], claims: [claim("natural", "Flow Agents has no repository-wide job-level compute cap."), claim("unsupported", "Flow Agents caps CI compute at four groups.")] }));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "seed"]);
    const revision = git(repo, ["rev-parse", "HEAD"]);
    const input = { schema_version: "1.1", workspace: "w", repository: "r", revision, target_audience: "maintainer", reader: "maintainer", as_of: { now: NOW }, budget: { max_tokens: 4000 }, claim_ids: ["natural", "unsupported"], knowledge_roots: [{ id: "k", provider: "git-repo", manifest_path: "knowledge/claims.json" }] };
    const answer = await answerWith({ repoRoot: repo, input, verifier });
    assert.deepEqual(answer.answers.map((item) => [item.claim_id, item.outcome, item.reason ?? item.verification.result]), [["natural", "answered", "supported"], ["unsupported", "abstained", "not_addressed"]]);
    assert.equal(answer.verdict, "not_verified");
    remove(repo);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Review round 1 on #1601 (every case below was reproduced against the first head before it was fixed).

async function mini(build) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "living-context-mini-")));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "fixture@example.test"]);
  git(repo, ["config", "user.name", "Fixture"]);
  const store = new ClockStore({ storeRoot: path.join(repo, "knowledge") });
  const make = async (at, input) => { store.at = at; return store.create({ provenance: { agent: "fixture" }, type: "raw", category: "decision.mini", tags: [], ...input }); };
  const put = (relative, content) => { const file = path.join(repo, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  const ids = await build({ store, make, put, repo });
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "seed"]); // a host-wide commit hook must not see the invalid bytes one case commits
  return { repo, revision: git(repo, ["rev-parse", "HEAD"]), ids };
}
const minis = [];
const track = async (build) => { const built = await mini(build); minis.push(built.repo); return built; };
after(() => { for (const repo of minis) remove(repo); });

describe("review: what ask returns respects the reader and the knowledge instant", () => {
  const CANARY = "Secret canary acquisition costs 43 million.";
  const memoryRecord = (id, audiences, recordedAt = "2026-10-01T00:00:00Z") => ({
    manifest: { readers: ["alice", "bob"], claims: [{ id, claim: "Canary acquisition cost", status: "current", authority: { path: "docs/secret.md", citation: "secret" }, owning_source: { owner: "o", path: "docs/secret.md" }, affected_surfaces: ["docs/secret.md"], visibility: { audiences }, recorded_at: recordedAt, slot: id }] },
    records: [{ claim_id: id, path: "docs/secret.md", title: "Canary acquisition cost", type: "memory-claim", category: "memory.claim", tags: [], record_status: "stated", created_at: recordedAt, updated_at: recordedAt, body: CANARY }],
  });
  const leaks = (result) => JSON.stringify({ results: result.results, below: result.below_threshold }).match(/canary|43 million|secret\.md|mem-secret/i);

  test("a claim restricted to another reader is neither answered nor named, and the owner still gets it", async () => {
    const m = await track(async ({ make, put }) => { put("docs/secret.md", `${CANARY}\n`); return { filler: await make("2026-10-01T00:00:00.000Z", { title: "Filler note", body: "Nothing relevant.\n" }) }; });
    const secret = memoryRecord("mem-secret", ["alice"]);
    const question = "Secret canary acquisition costs?";
    const bob = await askLivingContext({ repoRoot: m.repo, revision: m.revision, question, reader: "bob", readers: ["alice", "bob"], now: NOW, verifier, additional: [secret] });
    assert.equal(bob.outcome, "abstained");
    assert.equal(leaks(bob), null, JSON.stringify(bob.results));
    const alice = await askLivingContext({ repoRoot: m.repo, revision: m.revision, question, reader: "alice", readers: ["alice", "bob"], now: NOW, verifier, additional: [secret] });
    assert.equal(alice.outcome, "answered");
    assert.equal(alice.results[0].passage, CANARY);
  });

  test("a claim recorded after the as-of instant does not exist yet: nothing of it is returned", async () => {
    const m = await track(async ({ put }) => { put("docs/secret.md", `${CANARY}\n`); return {}; });
    const future = memoryRecord("mem-secret", ["alice", "bob"], "2026-12-01T00:00:00Z");
    const result = await askLivingContext({ repoRoot: m.repo, revision: m.revision, question: "Secret canary acquisition costs?", reader: "bob", readers: ["alice", "bob"], now: NOW, verifier, additional: [future] });
    assert.equal(leaks(result), null, JSON.stringify(result.results));
    assert.equal(result.outcome, "abstained");
  });

  test("a reader the host did not declare is refused before any selection", async () => {
    const m = await track(async ({ make }) => ({ a: await make("2026-10-01T00:00:00.000Z", { title: "Canary note", body: "Canary details.\n" }) }));
    await assert.rejects(askLivingContext({ repoRoot: m.repo, revision: m.revision, question: "canary details", reader: "stranger", readers: ["alice"], now: NOW, verifier }), (cause) => cause.code === "UNKNOWN_READER_IDENTITY");
  });
});

describe("review: the producer keeps what the store recorded", () => {
  const askOne = (m, question, extra = {}) => ask({ repoRoot: m.repo, revision: m.revision, question, ...extra });

  test("a date-only expires_at, which the store accepts, expires the record; an unreadable freshness makes it unverifiable", async () => {
    const m = await track(async ({ make }) => ({
      dated: await make("2026-09-01T00:00:00.000Z", { title: "Rotation window for tokens", body: "Tokens rotate in the autumn window.\n", expires_at: "2026-10-02" }),
      ttl: await make("2026-09-01T00:00:00.000Z", { title: "Rotation window for passwords", body: "Passwords rotate in the autumn window.\n", ttl_seconds: 3600 }),
    }));
    const derived = deriveStoreManifest({ repoRoot: m.repo, revision: m.revision, readers: ["maintainer"] });
    assert.equal(claimOf(derived, m.ids.dated).expires_at, "2026-10-02T00:00:00.000Z");
    const result = await askOne(m, "Rotation window autumn tokens passwords");
    const by = Object.fromEntries(result.results.map((entry) => [entry.claim_id, entry]));
    for (const id of [m.ids.dated, m.ids.ttl]) {
      assert.equal(by[id].status, "unverifiable", id);
      assert.deepEqual(by[id].reasons, ["stale_at_as_of"]);
      assert.equal(by[id].outcome, "abstained");
    }
    const bad = await track(async ({ put }) => { put("knowledge/topic/soon.md", "---\nid: soon\ntype: raw\ntitle: \"Expires someday\"\ncategory: decision.odd\nstatus: active\nexpires_at: someday\ncreated_at: \"2026-10-01T00:00:00.000Z\"\nupdated_at: \"2026-10-01T00:00:00.000Z\"\nlinks: []\nmutation_log: []\n---\n\nBody.\n"); return {}; });
    const unreadable = deriveStoreManifest({ repoRoot: bad.repo, revision: bad.revision, readers: ["maintainer"] });
    assert.equal(claimOf(unreadable, "soon").status, "unverifiable");
    assert.equal(unreadable.records[0].mapping, "unreadable_freshness");
  });

  test("each supersession edge is recorded when that edge was, not when the successor last superseded something", async () => {
    const m = await track(async ({ store, make }) => {
      const old = await make("2026-10-01T00:00:00.000Z", { title: "Alpha policy", body: "Alpha policy v1.\n" });
      const other = await make("2026-10-01T00:00:00.000Z", { title: "Beta policy", body: "Beta policy v1.\n" });
      const next = await make("2026-10-01T12:00:00.000Z", { title: "Gamma policy", body: "Gamma policy v2.\n" });
      store.at = "2026-10-02T00:00:00.000Z";
      await store.supersede(next, [old], { agent: "fixture", rationale: "first" });
      store.at = "2026-10-04T00:00:00.000Z";
      await store.supersede(next, [other], { agent: "fixture", rationale: "second" });
      return { old, other, next };
    });
    const derived = deriveStoreManifest({ repoRoot: m.repo, revision: m.revision, readers: ["maintainer"] });
    assert.equal(claimOf(derived, m.ids.old).supersession_recorded_at, "2026-10-02T00:00:00.000Z");
    assert.equal(claimOf(derived, m.ids.other).supersession_recorded_at, "2026-10-04T00:00:00.000Z");
    const midway = await ask({ repoRoot: m.repo, revision: m.revision, question: "Alpha policy", now: "2026-10-03T00:00:00Z" });
    assert.equal(midway.results.find((entry) => entry.claim_id === m.ids.old).status, "superseded", "the edge existed on October 3");
  });

  test("a record whose successor is not in the manifest is not current", async () => {
    const m = await track(async ({ store, make, repo }) => {
      const old = await make("2026-10-01T00:00:00.000Z", { title: "Delta policy", body: "Delta policy v1.\n" });
      const next = await make("2026-10-02T00:00:00.000Z", { title: "Epsilon policy", body: "Epsilon policy v2.\n" });
      store.at = "2026-10-03T00:00:00.000Z";
      await store.supersede(next, [old], { agent: "fixture", rationale: "replace" });
      fs.mkdirSync(path.join(repo, "knowledge/archive"), { recursive: true });
      fs.renameSync(path.join(repo, "knowledge/records", `${next}.md`), path.join(repo, "knowledge/archive", `${next}.md`));
      return { old, next };
    });
    const derived = deriveStoreManifest({ repoRoot: m.repo, revision: m.revision, readers: ["maintainer"] });
    assert.equal(claimOf(derived, m.ids.old).status, "unverifiable");
    assert.equal(derived.records.find((record) => record.claim_id === m.ids.old).mapping, "successor_unavailable");
    const result = await ask({ repoRoot: m.repo, revision: m.revision, question: "Delta policy" });
    assert.notEqual(result.results[0].outcome, "answered");
  });

  test("bytes that are not UTF-8 and paths that are not safe are named exclusions, not rewritten text or an abort", async () => {
    const m = await track(async ({ make, put, repo }) => {
      await make("2026-10-01T00:00:00.000Z", { title: "Fine record", body: "Fine body.\n" });
      fs.mkdirSync(path.join(repo, "knowledge/topic"), { recursive: true });
      const good = "---\nid: bytes\ntype: raw\ntitle: \"Bad bytes\"\ncategory: decision.odd\nstatus: active\ncreated_at: \"2026-10-01T00:00:00.000Z\"\nupdated_at: \"2026-10-01T00:00:00.000Z\"\nlinks: []\nmutation_log: []\n---\n\nGrant ";
      fs.writeFileSync(path.join(repo, "knowledge/topic/bytes.md"), Buffer.concat([Buffer.from(good), Buffer.from([0xff]), Buffer.from(" access.\n")]));
      put("knowledge/topic/line\nbreak.md", "---\nid: nl\ntype: raw\ntitle: \"N\"\ncategory: decision.odd\nstatus: active\n---\n\nBody.\n");
      return {};
    });
    const derived = deriveStoreManifest({ repoRoot: m.repo, revision: m.revision, readers: ["maintainer"] });
    assert.deepEqual(derived.excluded.map((entry) => entry.reason).sort(), ["invalid_utf8", "unsafe_path"]);
    assert.equal(derived.stats.claims, 1);
  });
});

describe("review: the verifier supports only what the document says", () => {
  const verdict = async (value, excerpt) => (await verifier.verify({ candidateId: "c", value, evidence: [{ id: "e", excerpt, locator: "l" }] })).result;

  test("literal code is compared as written: markers inside a code span are not emphasis", async () => {
    assert.equal(await verdict("Set `allow` to true.", "Set `_allow` to true."), "not-addressed");
    assert.equal(await verdict("Rotate api_key", "Rotate `api_key_`."), "not-addressed");
    assert.equal(await verdict("Use admin as the prefix.", "Use *admin as the prefix."), "not-addressed", "an unpaired marker is a character, not formatting");
    assert.equal(await verdict("Set `_allow` to true.", "Set `_allow` to true."), "supported");
    assert.equal(await verdict("Run `rm *`.", "Run `rm *`"), "supported", "a whole line supported in version 2 is still supported");
    assert.equal(await verdict("A bold word.", "A **bold** word."), "supported");
    assert.equal(await verdict("A bold word here.", "A **bold\nword** here."), "supported", "emphasis may span a hard wrap");
  });

  test("a heading is not joined to the paragraph under it, a sentence is not cut inside an initialism, and a longer fence stays open", async () => {
    assert.equal(await verdict("No access Production grants access.", "# No access\nProduction grants access.\n"), "not-addressed");
    assert.equal(await verdict("Production grants access.", "# No access\nProduction grants access.\n"), "supported");
    assert.equal(await verdict("Government may approve access.", "Only the U.S. Government may approve access.\n"), "not-addressed");
    assert.equal(await verdict("Only the U.S. Government may approve access.", "Only the U.S. Government may approve access.\n"), "supported");
    assert.equal(await verdict("Grant access.", "````\nGrant\n```\naccess.\n````\n"), "not-addressed", "prose inside a four-backtick fence is not a paragraph");
  });

  test("the cost of judging a statement is bounded by the document, not quadratic in it", async () => {
    const sentences = Array.from({ length: 800 }, (_, i) => `Item ${i} stays.`).join(" ");
    let started = Date.now();
    assert.equal(await verdict("Nothing here matches this at all.", sentences), "not-addressed");
    assert.ok(Date.now() - started < 2000, `800 sentences took ${Date.now() - started} ms`);
    started = Date.now();
    assert.equal(await verdict("No match.", `${"[a ".repeat(20000)}\n`), "not-addressed");
    assert.ok(Date.now() - started < 2000, `unmatched brackets took ${Date.now() - started} ms`);
    assert.equal(await verdict("Item 799 stays.", sentences), "supported");
    assert.equal(await verdict("Item 3 stays. Item 4 stays. Item 5 stays.", sentences), "supported");
    assert.equal(await verdict("Item 3 stays. Item 5 stays.", sentences), "not-addressed");
  });
});
