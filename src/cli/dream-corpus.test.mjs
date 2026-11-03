// The dream run against the REAL Corpus store (kontourai/corpus#42), not the in-test store the other suites use.
// Opt-in until @kontourai/corpus-store is published: build Corpus at the #42 head and set CORPUS_STORE_ENTRY to the
// absolute path of packages/store/dist/index.js. Without it these tests report skipped; they claim nothing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runDream } from "../../kits/knowledge/dream/run.js";
import { FakeCorpusStore, hostFor, noApplyStore, runOptions, scriptedExtract, workspace } from "./dream-support.mjs";

const entry = process.env.CORPUS_STORE_ENTRY;
const skip = entry ? false : "set CORPUS_STORE_ENTRY to a built @kontourai/corpus-store (corpus#42) to run";

async function realStore(ws) {
  const { KitDefaultStoreAdapter, standaloneFileMutationLock } = await import(pathToFileURL(entry).href);
  fs.mkdirSync(ws.memoryRoot, { recursive: true });
  return new KitDefaultStoreAdapter({ storeRoot: ws.memoryRoot, coordinationDirectory: path.join(ws.root, "coordination"), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
}

test("real Corpus: the run proposes, a replay is a no-op, and only a distinct reviewer's apply reaches the brief", { skip }, async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = await realStore(ws);
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract());

  const first = await runDream(host, runOptions(ws));
  assert.equal(first.status, "success");
  const proposals = await store.listProposals();
  assert.equal(proposals.length, 2);
  assert.ok(proposals.every((proposal) => proposal.state === "pending" && proposal.proposer_id === "knowledge.dream"));
  assert.equal((await store.listByType("raw")).length, 0, "no record exists until a reviewer applies a proposal");

  assert.equal((await runDream(host, runOptions(ws))).status, "noop");
  assert.equal((await store.listProposals()).length, 2);

  await assert.rejects(() => store.apply(proposals[0].id, "knowledge.dream"), (error) => error.code === "SELF_APPROVAL", "Corpus itself refuses the distiller approving its own proposal");
  const recordId = await store.apply(proposals[0].id, "a-human-reviewer");
  const report = await runDream(host, runOptions(ws));
  assert.equal(report.brief_excluded.self_approved, 0);
  const brief = JSON.parse(fs.readFileSync(ws.briefs(), "utf8"));
  assert.equal(brief.entries.length, 1);
  assert.match(brief.entries[0], /rounding mode = banker's rounding/);

  await store.retire(recordId, "retired", { agent: "a-human-reviewer", rationale: "no longer true" });
  await runDream(host, runOptions(ws));
  assert.deepEqual(JSON.parse(fs.readFileSync(ws.briefs(), "utf8")).entries, [], "a retired record leaves the brief");
});

test("real Corpus: a proposeCreate whose reply is lost leaves the proposal, and the retry reuses it", { skip }, async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = await realStore(ws);
  let calls = 0;
  const lossy = new Proxy(store, {
    get(target, prop) {
      if (prop === "proposeCreate") {
        return async (...args) => {
          const id = await target.proposeCreate(...args);
          if (calls++ === 0) throw Object.assign(new Error("reply lost"), { code: "INJECTED" });
          return id;
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const host = hostFor(ws, noApplyStore(lossy), await scriptedExtract());
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.cause?.code === "INJECTED");
  assert.equal(fs.existsSync(ws.cursorFile), false);
  assert.equal((await store.listProposals()).length, 1, "the proposal exists although the caller never saw its id");

  const retry = await runDream(host, runOptions(ws));
  assert.equal(retry.status, "success");
  assert.equal((await store.listProposals()).length, 2, "reused, not duplicated");
});

test("the in-test store has the proposal shape the real store writes", { skip }, async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const real = await realStore(ws);
  const fakeWs = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(fakeWs.cleanup);
  const fake = new FakeCorpusStore(fakeWs.memoryRoot);
  const candidate = { type: "raw", title: "t", body: "b", category: "memory.claim", provenance: { agent: "knowledge.dream", session_id: "s", note: "{}" } };
  const evidence = { agent: "knowledge.dream", proposal: "Create distilled memory candidate" };
  const realId = await real.proposeCreate(candidate, "knowledge.dream", evidence);
  const fakeId = await fake.proposeCreate(candidate, "knowledge.dream", evidence);
  const shape = (proposal) => Object.keys(proposal).sort();
  assert.deepEqual(shape(await fake.getProposal(fakeId)), shape(await real.getProposal(realId)));
  const realRecord = await real.get(await real.apply(realId, "reviewer"));
  assert.deepEqual(shape((await fake.getProposal(fakeId))), shape(await real.getProposal(realId)).filter((key) => key !== "reviewer_id" && key !== "decided_at" && key !== "record_id"));
  assert.ok(realRecord.mutation_log.some((entryLog) => entryLog.op === "apply-create" && entryLog.evidence.proposal_id === realId));
});
