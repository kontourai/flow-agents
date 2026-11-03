// The dream run (#671): idempotent replay, cursor committed last, injected failures at every stage,
// partial create and created-before-receipt reuse, reconciled reports, pure dry-run, no self-approval.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runDream } from "../../kits/knowledge/dream/run.js";
import { FakeCorpusStore, NOW_MS, SCRIPT, hostFor, listFilesDeep, noApplyStore, runOptions, scriptedExtract, workspace } from "./dream-support.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(options = {}) {
  const ws = workspace(options.workspace);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const extract = await scriptedExtract(options.extract);
  return { ws, store, extract, host: hostFor(ws, noApplyStore(store), extract, options.host) };
}

test("AC5: run 1 produces proposals, run 2 is a no-op, and the cursor is committed", async (t) => {
  const { ws, store, extract, host } = await fixture();
  t.after(ws.cleanup);
  const first = await runDream(host, runOptions(ws));
  assert.equal(first.status, "success");
  assert.equal(first.sittings.distilled, 4);
  assert.equal((await store.listProposals()).length, 4);
  assert.ok(fs.existsSync(ws.cursorFile));
  assert.equal(first.cursor.committed, true);

  const modelCalls = extract.calls.length;
  const cursorBefore = fs.readFileSync(ws.cursorFile, "utf8");
  const second = await runDream(host, runOptions(ws));
  assert.equal(second.status, "noop");
  assert.equal(second.sittings.distilled, 0);
  assert.equal(extract.calls.length, modelCalls, "a no-op run makes no model call");
  assert.equal((await store.listProposals()).length, 4, "a no-op run proposes nothing");
  assert.equal(fs.readFileSync(ws.cursorFile, "utf8"), cursorBefore, "a no-op run does not rewrite the cursor");
});

test("proposals are pending Corpus create proposals made by the dream proposer, never applied", async (t) => {
  const { ws, store, host } = await fixture();
  t.after(ws.cleanup);
  await runDream(host, runOptions(ws));
  const proposals = await store.listProposals();
  assert.ok(proposals.length > 0);
  for (const proposal of proposals) {
    assert.equal(proposal.state, "pending");
    assert.equal(proposal.proposer_id, "knowledge.dream");
    assert.equal(proposal.candidate.category, "memory.claim");
  }
  assert.equal(store.records.size, 0, "no record exists until a reviewer applies a proposal");
  assert.deepEqual(host.registered.map(([name]) => name), Array(host.registered.length).fill("memory"));
});

for (const stage of ["ingest", "distill", "route", "propose", "receipt", "publish", "brief", "report", "cursor"]) {
  test(`a failure at ${stage} leaves the cursor unadvanced and the retry is idempotent`, async (t) => {
    const { ws, store, extract, host } = await fixture({ host: { publish: () => {} } });
    t.after(ws.cleanup);
    const clean = await fixture({ host: { publish: () => {} } });
    t.after(clean.ws.cleanup);
    await runDream(clean.host, runOptions(clean.ws));
    const expected = (await clean.store.listProposals()).length;

    await assert.rejects(() => runDream(host, runOptions(ws, { onStage: (name) => { if (name === stage) throw Object.assign(new Error(`injected ${stage} failure`), { code: "INJECTED" }); } })), /injected/);
    assert.equal(fs.existsSync(ws.cursorFile), false, "the cursor is committed after every other stage, so a failure leaves none");
    const failure = ws.reports().at(-1);
    assert.equal(failure.status, "failed");
    assert.equal(failure.cursor.committed, false);

    const callsBeforeRetry = extract.calls.length;
    const retry = await runDream(host, runOptions(ws));
    assert.equal(retry.status, "success");
    assert.equal((await store.listProposals()).length, expected, "a retry cannot duplicate a proposal");
    // Four sittings, two extraction passes each. A sitting already fully proposed is not distilled again:
    // "receipt" fails after the first sitting only, and every later stage fails after all four.
    const perSitting = 2;
    const expectedRetryCalls = { receipt: 3 * perSitting, publish: 0, brief: 0, report: 0, cursor: 0 }[stage];
    if (expectedRetryCalls !== undefined) assert.equal(extract.calls.length - callsBeforeRetry, expectedRetryCalls, "sittings already fully proposed are not distilled again");
  });
}

test("a real cursor-commit failure after the report is written marks that run's report failed", async (t) => {
  const { ws, host } = await fixture();
  t.after(ws.cleanup);
  if (process.getuid?.() === 0) return t.skip("a root user can write into a read-only directory");
  fs.mkdirSync(path.dirname(ws.cursorFile), { recursive: true });
  fs.chmodSync(path.dirname(ws.cursorFile), 0o500); // the real commit cannot create its temp file
  try {
    await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.code === "EACCES");
  } finally {
    fs.chmodSync(path.dirname(ws.cursorFile), 0o700);
  }
  const [report] = ws.reports();
  assert.equal(report.status, "failed");
  assert.equal(report.cursor.committed, false);
  assert.ok(report.receipts.length > 0, "the failed report still lists what was proposed");
});

test("partial create: a proposeCreate failure mid-sitting is reconciled on retry without duplicates", async (t) => {
  const claimsOf = () => ["alpha", "beta", "gamma"].map((name) => ({ quote: "I switched to banker's rounding on the total.", subject: `svc ${name}`, subjectType: "service", property: "mode", value: name, posture: "stated" }));
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: (content) => (content.includes("banker's rounding") ? claimsOf() : []) } });
  t.after(ws.cleanup);
  store.failProposeCreate(1);
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.cause?.code === "INJECTED");
  const failed = ws.reports().at(-1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.receipts.filter((r) => r.disposition === "created").length, 1, "the proposal that landed is in the failed report");
  assert.equal((await store.listProposals()).length, 1);

  const retry = await runDream(host, runOptions(ws));
  assert.equal(retry.status, "success");
  const proposals = await store.listProposals();
  assert.equal(proposals.length, 3, "one reused, two created: exactly the claims, once each");
  assert.equal(retry.claims.reused, 1);
  assert.equal(retry.claims.created, 2);
});

test("created-before-receipt: the store keeps a proposal whose reply was lost, and the retry reuses it", async (t) => {
  const { ws, store, extract, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  store.failProposeCreate(0, { after: true });
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.cause?.code === "INJECTED");
  const failed = ws.reports().at(-1);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.receipts.map((r) => r.disposition), ["created"], "the failed report reconciles the proposal that the lost reply hid");
  assert.equal((await store.listProposals()).length, 1);

  const callsBefore = extract.calls.length;
  const retry = await runDream(host, runOptions(ws));
  assert.equal(retry.status, "success");
  assert.equal(retry.claims.reused >= 1, true);
  assert.equal((await store.listProposals()).length, 2, "two sittings, one proposal each: nothing duplicated");
  assert.ok(extract.calls.length > callsBefore, "the unproposed second sitting is still distilled");
});

test("a proposal that holds this claim but was made by someone else is refused, not reused", async (t) => {
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  await runDream(host, runOptions(ws));
  fs.rmSync(ws.cursorFile); // replay the same telemetry
  const [first] = await store.listProposals();
  const file = path.join(store.dir, `${first.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...first, proposer_id: "someone-else" }));
  // The sitting is no longer "fully proposed by us", so the run distils again and meets the foreign claim id.
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.code === "DREAM_SEMANTIC_COLLISION");
  assert.equal(fs.existsSync(ws.cursorFile), false);
  assert.equal(ws.reports().at(-1).status, "failed");
});

test("a malformed or tampered proposal is counted, not trusted and not fatal", async (t) => {
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  await store.proposeCreate({ title: "x", body: "not json", category: "memory.claim" }, "knowledge.dream", { agent: "knowledge.dream", proposal: "x" });
  const report = await runDream(host, runOptions(ws));
  assert.equal(report.unreadable_proposals, 1);
  assert.equal(report.status, "success");
});

test("AC10: the report reconciles with what the store gained, the briefs and the cursor", async (t) => {
  const { ws, store, host } = await fixture();
  t.after(ws.cleanup);
  const before = (await store.listProposals()).length;
  const report = await runDream(host, runOptions(ws));
  const after = await store.listProposals();

  assert.equal(report.claims.created + report.claims.reused, report.receipts.length);
  assert.equal(report.claims.created, after.length - before);
  assert.equal(report.claims.routed + report.claims.uncontested, report.receipts.length);
  assert.deepEqual(report.receipts.map((r) => r.proposal_id).sort(), after.map((p) => p.id).sort());
  assert.equal(report.sittings.seen, report.ingest.sittings_emitted);
  for (const brief of report.briefs) {
    assert.equal(brief.digest, sha256(fs.readFileSync(ws.briefs(brief.name))));
    assert.ok(brief.bytes <= brief.budget);
  }
  assert.equal(report.cursor.digest, sha256(fs.readFileSync(ws.cursorFile)));
  assert.ok(report.redaction_hits > 0, "the report counts the scrub markers the residue carries");
  const onDisk = ws.reports().at(-1);
  assert.equal(onDisk.run_id, report.run_id);
  assert.equal(onDisk.cursor.committed, true);
  assert.equal(report.metrics.claimsProposed, report.receipts.length);
});

test("reconciled reports for a no-op and for a skipped-only run", async (t) => {
  const { ws, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  fs.writeFileSync(ws.telemetryFile, fs.readFileSync(ws.telemetryFile, "utf8").replace('"runtime":"codex"', '"runtime":"opencode"'));
  const skipped = await runDream(host, runOptions(ws));
  assert.equal(skipped.status, "success", "skipped-only telemetry still advances the cursor");
  assert.equal(skipped.ingest.skipped[0].reason, "UNSUPPORTED_RUNTIME");
  assert.equal(skipped.sittings.distilled, 0);
  assert.ok(skipped.cursor.committed);
  const noop = await runDream(host, runOptions(ws));
  assert.equal(noop.status, "noop");
  assert.equal(ws.reports().length, 2, "every non-dry run leaves a report");
});

test("pure dry-run: no model call, no store write, no file written, and the disabled default does not block it", async (t) => {
  const { ws, store, extract, host } = await fixture();
  t.after(ws.cleanup);
  await runDream(host, runOptions(ws, { maxSittingsPerRun: 1 }));
  const proposalsBefore = await store.listProposals();
  const filesBefore = { dream: listFilesDeep(ws.dreamDir), memory: listFilesDeep(ws.memoryRoot), telemetry: fs.readFileSync(ws.telemetryFile, "utf8") };
  const callsBefore = { ...store.calls };
  const modelCalls = extract.calls.length;

  const report = await runDream(host, runOptions(ws, { enabled: false, dryRun: true }));
  assert.equal(report.status, "dry-run");
  assert.equal(report.dry_run, true);
  assert.equal(report.would_distill.length, 3, "three sittings were left undone by the capped real run");
  assert.equal(extract.calls.length, modelCalls);
  assert.equal(store.calls.proposeCreate, callsBefore.proposeCreate);
  assert.equal(host.registered.length, 1, "a dry run registers no root");
  assert.deepEqual({ dream: listFilesDeep(ws.dreamDir), memory: listFilesDeep(ws.memoryRoot), telemetry: fs.readFileSync(ws.telemetryFile, "utf8") }, filesBefore);
  assert.equal((await store.listProposals()).length, proposalsBefore.length);
});

test("disabled by default: a real run refuses unless enabled", async (t) => {
  const { ws, host } = await fixture();
  t.after(ws.cleanup);
  await assert.rejects(() => runDream(host, runOptions(ws, { enabled: undefined })), (error) => error.code === "DREAM_DISABLED");
  assert.equal(fs.existsSync(ws.dreamDir), false);
});

test("no self-approval: the run never applies or rejects, even when the store offers the verbs", async (t) => {
  const { ws, store, host } = await fixture();
  t.after(ws.cleanup);
  await runDream(host, runOptions(ws)); // host.store is noApplyStore(store): apply/reject throw if touched
  assert.equal(store.calls.applyCreate, 0);
  assert.equal(store.calls.rejectCreate, 0);
  assert.equal(store.records.size, 0);
  // The store the run hands to everything else is narrowed to propose/list/get as well.
  const seen = [];
  const spy = new Proxy(store, { get: (target, prop) => { seen.push(String(prop)); const value = target[prop]; return typeof value === "function" ? value.bind(target) : value; } });
  fs.rmSync(ws.cursorFile);
  await runDream({ ...host, store: spy }, runOptions(ws));
  assert.ok(!seen.some((n) => ["apply", "reject", "applyCreate", "rejectCreate"].includes(n)), `the run reached for ${seen.filter((n) => ["apply", "reject", "applyCreate", "rejectCreate"].includes(n))}`);
});

test("cap and deferral: sittings over the per-run cap are left for the next run, each distilled once", async (t) => {
  const { ws, store, extract, host } = await fixture();
  t.after(ws.cleanup);
  const one = await runDream(host, runOptions(ws, { maxSittingsPerRun: 1 }));
  assert.equal(one.sittings.distilled, 1);
  assert.equal(one.sittings.deferred_over_cap, 3);
  const cursor = JSON.parse(fs.readFileSync(ws.cursorFile, "utf8"));
  assert.equal(cursor.telemetry.offset, 0, "the telemetry offset does not pass lines whose sittings are still undone");
  assert.equal(Object.keys(cursor.sittings).length, 1);
  for (let i = 0; i < 3; i += 1) await runDream(host, runOptions(ws, { maxSittingsPerRun: 1 }));
  assert.equal((await store.listProposals()).length, 4);
  assert.equal(extract.calls.length, 4 * 2, "4 sittings x 2 passes: nothing distilled twice");
  const done = await runDream(host, runOptions(ws, { maxSittingsPerRun: 1 }));
  assert.equal(done.status, "noop");
  const final = JSON.parse(fs.readFileSync(ws.cursorFile, "utf8"));
  assert.ok(final.telemetry.offset > 0, "once nothing is undone the offset moves to the end");
});

test("an incomplete sitting is held back, then distilled once its idle gap has passed", async (t) => {
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  const lastTurn = Date.parse("2026-10-31T15:11:00.000Z");
  const early = await runDream(host, runOptions(ws, { nowMs: lastTurn + 60_000 }));
  assert.equal(early.sittings.deferred_incomplete, 1);
  assert.equal(early.sittings.distilled, 1, "the finished first sitting is distilled");
  const cursor = JSON.parse(fs.readFileSync(ws.cursorFile, "utf8"));
  assert.equal(cursor.telemetry.offset, 0);
  const later = await runDream(host, runOptions(ws, { nowMs: lastTurn + 2 * 60 * 60 * 1000 }));
  assert.equal(later.sittings.seen, 1, "the finished sitting is in the cursor, so only the held one is read again");
  assert.equal(later.sittings.distilled, 1);
  assert.equal((await store.listProposals()).length, 2);
  assert.ok(JSON.parse(fs.readFileSync(ws.cursorFile, "utf8")).telemetry.offset > 0);
});

test("every extraction pass failing is a model outage: the run fails and the cursor stays", async (t) => {
  const { ws, host } = await fixture({ extract: { fail: () => true } });
  t.after(ws.cleanup);
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.code === "DREAM_DISTILL_FAILED");
  assert.equal(fs.existsSync(ws.cursorFile), false);
});

test("a blocked telemetry file holds the cursor and reports blocked", async (t) => {
  const { ws, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  await runDream(host, runOptions(ws));
  fs.writeFileSync(ws.telemetryFile, "{}\n"); // rotated: the committed prefix digest no longer matches
  const cursorBefore = fs.readFileSync(ws.cursorFile, "utf8");
  const report = await runDream(host, runOptions(ws));
  assert.equal(report.status, "blocked");
  assert.equal(report.ingest.blocked[0].reason, "TELEMETRY_DISCONTINUITY");
  assert.equal(fs.readFileSync(ws.cursorFile, "utf8"), cursorBefore);
});

test("a second run while one holds the lock is refused, and a dead owner's lock is taken over", async (t) => {
  const { ws, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = runDream(host, runOptions(ws, { onStage: async (name) => { if (name === "ingest") await gate; } }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.code === "DREAM_LOCKED");
  release();
  assert.equal((await first).status, "success");

  fs.writeFileSync(path.join(ws.dreamDir, "dream.lock"), JSON.stringify({ pid: 2 ** 22 + 1, started_at: NOW_MS, token: "dead" }));
  assert.equal((await runDream(host, runOptions(ws))).status, "noop");
  assert.equal(fs.existsSync(path.join(ws.dreamDir, "dream.lock")), false, "the lock is released");
});

test("the script covers every sitting in the fixtures", () => {
  assert.equal(SCRIPT.length, 4);
});
