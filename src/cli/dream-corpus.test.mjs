// The dream run against the REAL Corpus store (the published @kontourai/corpus-store, pinned in package.json), not the
// in-test store the other suites use. Always on: the package is a dev dependency.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { KitDefaultStoreAdapter, standaloneFileMutationLock } from "@kontourai/corpus-store";
import { runDream } from "../../kits/knowledge/dream/run.js";
import { FakeCorpusStore, SCRIPT, hostFor, noApplyStore, runOptions, scriptedExtract, workspace } from "./dream-support.mjs";


async function realStore(ws) {
  fs.mkdirSync(ws.memoryRoot, { recursive: true });
  return new KitDefaultStoreAdapter({ storeRoot: ws.memoryRoot, coordinationDirectory: path.join(ws.root, "coordination"), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
}

test("real Corpus: the run proposes, a replay is a no-op, and only a distinct reviewer's apply reaches the brief", async (t) => {
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

  await assert.rejects(() => store.applyCreate(proposals[0].id, "knowledge.dream"), (error) => error.code === "SELF_APPROVAL", "Corpus itself refuses the distiller approving its own proposal");
  const recordId = await store.applyCreate(proposals[0].id, "a-human-reviewer");
  const report = await runDream(host, runOptions(ws));
  assert.equal(report.brief_excluded.self_approved, 0);
  const brief = JSON.parse(fs.readFileSync(ws.briefs(), "utf8"));
  assert.equal(brief.entries.length, 1);
  assert.match(brief.entries[0], /rounding mode = banker's rounding/);

  await store.retire(recordId, "retired", { agent: "a-human-reviewer", rationale: "no longer true" });
  await runDream(host, runOptions(ws));
  assert.deepEqual(JSON.parse(fs.readFileSync(ws.briefs(), "utf8")).entries, [], "a retired record leaves the brief");
});

test("real Corpus: a proposeCreate whose reply is lost leaves the proposal, and the retry reuses it", async (t) => {
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

test("real Corpus: two claims in ONE sitting, the first reply lost: the retry proposes the second under its own key and reuses the first", async (t) => {
  // Corpus keys a request by the sitting and the candidate's position in the batch (#1573). A retry that sent only the
  // claims not yet proposed gave the second claim the first one's key, and Corpus refused it for good (REQUEST_KEY_CONFLICT).
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
  const claimsOf = (content) => {
    if (!content.includes("banker's rounding")) return [];
    const [a] = SCRIPT[0].claims;
    // Both claims quote the same grounded sentence, so one sitting yields two claims.
    return [a, { ...a, property: "rounding scope", value: "the total" }];
  };
  const host = hostFor(ws, noApplyStore(lossy), await scriptedExtract({ claimsOf }));
  await assert.rejects(() => runDream(host, runOptions(ws, { maxSittingsPerRun: 1 })), (error) => error.cause?.code === "INJECTED");
  assert.equal((await store.listProposals()).length, 1, "the first proposal exists although its reply was lost");

  const retry = await runDream(host, runOptions(ws, { maxSittingsPerRun: 1 }));
  assert.equal(retry.status, "success");
  assert.equal(retry.claims.created, 1, "only the second claim is created; the first is reused");
  assert.equal(retry.claims.reused, 1);
  const proposals = await store.listProposals();
  assert.equal(proposals.length, 2, "reused, not duplicated");
  assert.equal(new Set(proposals.map((proposal) => proposal.id)).size, 2);
});

function lossyFirstReply(store) {
  let calls = 0;
  return new Proxy(store, {
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
}

test("real Corpus: a retry whose provenance differs (the transcript root widened) still completes a half-proposed sitting", async (t) => {
  // Real Corpus digests the candidate's provenance into the request, and the transcript reference is relative to the root.
  // A claim already proposed is never sent again, so a changed reference cannot conflict with it.
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = await realStore(ws);
  const claimsOf = (content) => content.includes("banker's rounding") ? [SCRIPT[0].claims[0], { ...SCRIPT[0].claims[0], property: "rounding scope", value: "the total" }] : [];
  const host = hostFor(ws, noApplyStore(lossyFirstReply(store)), await scriptedExtract({ claimsOf }));
  await assert.rejects(() => runDream(host, runOptions(ws, { maxSittingsPerRun: 1 })), (error) => error.cause?.code === "INJECTED");
  const retry = await runDream(host, runOptions(ws, { maxSittingsPerRun: 1, transcriptRoots: [path.dirname(ws.transcriptRoot)] }));
  assert.equal(retry.status, "success");
  assert.equal((await store.listProposals()).length, 2);
});

test("real Corpus: a changed plan for a half-proposed sitting proposes only what is new and never sends the known claim again", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = await realStore(ws);
  const [a] = SCRIPT[0].claims;
  const mk = (property, value) => ({ ...a, property, value });
  let plan = [a, mk("rounding scope", "the total")];
  const claimsOf = (content) => content.includes("banker's rounding") ? plan : [];
  const host = hostFor(ws, noApplyStore(lossyFirstReply(store)), await scriptedExtract({ claimsOf }));
  await assert.rejects(() => runDream(host, runOptions(ws, { maxSittingsPerRun: 1 })), (error) => error.cause?.code === "INJECTED");
  const [first] = await store.listProposals();
  await store.rejectCreate(first.id, "a-human-reviewer", "not wanted");

  // The sitting grows by a turn, so its stored plan is not resumed and the model is asked again, and now says three things.
  const rollout = path.join(ws.transcriptRoot, "codex-rollout.jsonl");
  fs.appendFileSync(rollout, `${JSON.stringify({ timestamp: "2026-10-31T14:00:40.000Z", type: "response_item", payload: { type: "message", id: "m-extra", role: "user", content: [{ type: "input_text", text: "One more thing: the rounding applies to refunds." }] }, ordinal: 99 })}\n`);
  plan = [a, mk("rounding scope", "the total"), mk("rounding applies to", "refunds")];
  await runDream(host, runOptions(ws, { maxSittingsPerRun: 1 }));

  const proposals = await store.listProposals();
  const states = Object.fromEntries(proposals.map((proposal) => [proposal.id, proposal.state]));
  assert.equal(states[first.id], "rejected", "the known claim stays rejected: it was not sent again");
  const claimIds = proposals.map((proposal) => JSON.parse(proposal.candidate.body).claim.id);
  assert.equal(new Set(claimIds).size, claimIds.length, "no claim has two proposals");
});

test("the in-test store has the proposal shape the real store writes", async (t) => {
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
  const realRecord = await real.get(await real.applyCreate(realId, "reviewer"));
  assert.deepEqual(shape((await fake.getProposal(fakeId))), shape(await real.getProposal(realId)).filter((key) => key !== "reviewer_id" && key !== "decided_at" && key !== "record_id"));
  assert.ok(realRecord.mutation_log.some((entryLog) => entryLog.op === "apply-create" && entryLog.evidence.proposal_id === realId));
});
