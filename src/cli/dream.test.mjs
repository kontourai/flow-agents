// The dream run (#671): idempotent replay, cursor committed last, injected failures at every stage,
// partial create and created-before-receipt reuse, reconciled reports, pure dry-run, no self-approval.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runDream } from "../../kits/knowledge/dream/run.js";
import { FakeCorpusStore, NOW_MS, tempDir, SCRIPT, hostFor, listFilesDeep, noApplyStore, runOptions, scriptedExtract, workspace } from "./dream-support.mjs";

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

test("a claim a reviewer rejected is not proposed again when the sitting is retried part-way", async (t) => {
  const claimsOf = (content) => (content.includes("banker's rounding")
    ? ["alpha", "beta"].map((name) => ({ quote: "I switched to banker's rounding on the total.", subject: `svc ${name}`, subjectType: "service", property: "mode", value: name, posture: "stated" }))
    : []);
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf } });
  t.after(ws.cleanup);
  store.failProposeCreate(1);
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.cause?.code === "INJECTED");
  const [landed] = await store.listProposals();
  await store.rejectCreate(landed.id, "a-human-reviewer", "wrong");
  const retry = await runDream(host, runOptions(ws));
  const proposals = await store.listProposals();
  assert.equal(proposals.length, 2, "the rejected claim is reused as rejected; only the missing one is created");
  assert.equal(proposals.filter((p) => p.state === "rejected").length, 1);
  assert.equal(retry.claims.reused, 1);
  assert.equal(retry.claims.created, 1);
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

test("a proposal that is this run's but does not verify stops the run; another proposer's is only counted", async (t) => {
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  const evidence = { agent: "x", proposal: "x" };
  await store.proposeCreate({ title: "x", body: "not json", category: "memory.claim" }, "someone-else", evidence);
  const counted = await runDream(host, runOptions(ws));
  assert.equal(counted.unreadable_proposals, 1);
  assert.equal(counted.status, "success");

  const ours = await store.proposeCreate({ title: "y", body: "not json", category: "memory.claim" }, "knowledge.dream", evidence);
  fs.rmSync(ws.cursorFile);
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.code === "DREAM_RECEIPT_CORRUPT" && error.proposalId === ours);
  assert.equal(fs.existsSync(ws.cursorFile), false);
  await store.rejectCreate(ours, "a-human-reviewer", "corrupt");
  assert.equal((await runDream(host, runOptions(ws))).status, "success");
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

  const epoch = path.join(ws.dreamDir, "dream.lock", "9");
  fs.mkdirSync(epoch, { recursive: true });
  fs.writeFileSync(path.join(epoch, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 1, started_at: NOW_MS, token: "dead" }));
  assert.equal((await runDream(host, runOptions(ws))).status, "noop");
  assert.deepEqual(fs.readdirSync(path.join(ws.dreamDir, "dream.lock")), ["10"], "the dead owner's epoch is gone and this run's is the highest");
  assert.ok(fs.existsSync(path.join(ws.dreamDir, "dream.lock", "10", "released")), "and it is released");
});

test("the script covers every sitting in the fixtures", () => {
  assert.equal(SCRIPT.length, 4);
});

test("the host's visibility is stamped on every claim and its routing baseline; absent reads as sealed; malformed is refused up front", async (t) => {
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  await assert.rejects(() => runDream(host, runOptions(ws, { visibility: { kind: "restricted" } })), (error) => error.name === "MemoryClaimError");
  assert.equal(fs.existsSync(ws.cursorFile), false);

  const visibility = { kind: "restricted", audiences: ["user:owner"] };
  await runDream(host, runOptions(ws, { visibility }));
  const claims = (await store.listProposals()).map((proposal) => JSON.parse(proposal.candidate.body));
  assert.ok(claims.length > 0);
  for (const envelope of claims) {
    assert.deepEqual(envelope.claim.visibility, visibility);
    assert.deepEqual(envelope.decision.input.baselines[0].visibility, visibility, "routing saw the source visibility");
  }

  const bare = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(bare.ws.cleanup);
  await runDream(bare.host, runOptions(bare.ws, { visibility: undefined }));
  for (const proposal of await bare.store.listProposals()) assert.equal(JSON.parse(proposal.candidate.body).claim.visibility, undefined, "no visibility given: the claim carries none, which the claim contract reads as sealed");
});

// ── review round 1 ───────────────────────────────────────────────────────────────────────────────────────────

import { acquireDreamLock } from "../../kits/knowledge/dream/lock.js";
import { syncBuiltinESMExports } from "node:module";

test("a response with no extraction tool call, or a truncated one, fails the run: the sitting is not consumed", async (t) => {
  const { FakeModelRuntime } = await import("@kontourai/relay");
  const { extractForRuntime } = await import("../../kits/knowledge/dream/model.js");
  for (const stopReason of ["end_turn", "max_tokens"]) {
    const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
    t.after(ws.cleanup);
    const empty = () => ({ provider: "fake", model: "m", outputText: "", toolCalls: stopReason === "max_tokens" ? [{ id: "1", name: "submit_extraction_proposals", input: { proposals: [] } }] : [], usage: {}, latencyMs: 1, stopReason });
    const runtime = new FakeModelRuntime(Array.from({ length: 8 }, empty));
    const store = new FakeCorpusStore(ws.memoryRoot);
    const host = hostFor(ws, noApplyStore(store), await extractForRuntime(runtime));
    await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.code === "DREAM_DISTILL_FAILED", stopReason);
    assert.equal(fs.existsSync(ws.cursorFile), false, `${stopReason}: the cursor did not move`);
  }
});

test("a valid empty extraction is a sitting with nothing in it, and is consumed", async (t) => {
  const { FakeModelRuntime } = await import("@kontourai/relay");
  const { extractForRuntime } = await import("../../kits/knowledge/dream/model.js");
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const none = () => ({ provider: "fake", model: "m", outputText: "", toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: { proposals: [] } }], usage: {}, latencyMs: 1, stopReason: "tool_use" });
  const host = hostFor(ws, noApplyStore(new FakeCorpusStore(ws.memoryRoot)), await extractForRuntime(new FakeModelRuntime(Array.from({ length: 8 }, none))));
  const report = await runDream(host, runOptions(ws));
  assert.equal(report.status, "success");
  assert.equal(report.claims.created, 0);
  assert.ok(report.cursor.committed);
});

test("partial replay under changed model output: the stored plan is resumed, with no new model call and no extras", async (t) => {
  const first = (content) => (content.includes("banker's rounding")
    ? ["alpha", "beta"].map((name) => ({ quote: "I switched to banker's rounding on the total.", subject: `svc ${name}`, subjectType: "service", property: "mode", value: name, posture: "stated" }))
    : []);
  const { ws, store, extract, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: first } });
  t.after(ws.cleanup);
  store.failProposeCreate(1);
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.cause?.code === "INJECTED");
  assert.equal((await store.listProposals()).length, 1);
  const callsBefore = extract.calls.length;

  // On the retry the model would word everything differently. It must not be asked.
  const reworded = await scriptedExtract({ claimsOf: () => [{ quote: "I switched to banker's rounding on the total.", subject: "svc gamma", subjectType: "service", property: "other", value: "gamma", posture: "stated" }] });
  const retry = await runDream({ ...host, extract: reworded }, runOptions(ws));
  assert.equal(retry.status, "success");
  // Only the second sitting, which the failed run never reached, goes to the model (two passes). The half-proposed
  // first sitting does not: its claims come from the store.
  assert.equal(reworded.calls.length, 2);
  assert.ok(reworded.calls.every((call) => !call.content.includes("banker's rounding")), "the half-proposed sitting was not extracted again");
  assert.equal(extract.calls.length, callsBefore);
  const proposals = await store.listProposals();
  assert.deepEqual(proposals.map((p) => JSON.parse(p.candidate.body).claim.value).sort(), ["alpha", "beta"], "exactly the first run's plan, once each");
  assert.equal(retry.sittings.resumed, 1);
  assert.equal(retry.claims.reused, 1);
  assert.equal(retry.claims.created, 1);
});

test("a stored plan that does not verify, or that proposals disagree on, is refused rather than worked around", async (t) => {
  const two = (content) => (content.includes("banker's rounding")
    ? ["alpha", "beta"].map((name) => ({ quote: "I switched to banker's rounding on the total.", subject: `svc ${name}`, subjectType: "service", property: "mode", value: name, posture: "stated" }))
    : []);
  const make = async () => {
    const f = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: two } });
    t.after(f.ws.cleanup);
    await runDream(f.host, runOptions(f.ws));
    fs.rmSync(f.ws.cursorFile);
    return f;
  };
  const edit = (store, proposal, change) => {
    const body = JSON.parse(proposal.candidate.body);
    change(body);
    fs.writeFileSync(`${store.dir}/${proposal.id}.json`, JSON.stringify({ ...proposal, candidate: { ...proposal.candidate, body: JSON.stringify(body) } }));
  };
  // The count a forged envelope claims can no longer make a half-proposed sitting look whole.
  const a = await make();
  const [p1] = await a.store.listProposals();
  edit(a.store, p1, (body) => { body.plan = body.plan.slice(0, 1); });
  await assert.rejects(() => runDream(a.host, runOptions(a.ws)), (error) => error.code === "DREAM_RECEIPT_CORRUPT");
  // Two envelopes of one sitting with different plans (each internally consistent) disagree.
  const b = await make();
  const [q1] = await b.store.listProposals();
  const { planDigest } = await import("../../kits/knowledge/dream/envelope.js");
  edit(b.store, q1, (body) => { body.plan = [body.plan[0]]; body.sitting.index = 0; body.sitting.planDigest = planDigest(body.plan); });
  await assert.rejects(() => runDream(b.host, runOptions(b.ws)), (error) => error.code === "DREAM_RECEIPT_MISMATCH");
});

test("the cursor is the last thing that can fail: a report that cannot be rewritten after the commit does not fail the run", async (t) => {
  const { ws, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  if (process.getuid?.() === 0) return t.skip("a root user can write into a read-only directory");
  const reportsDir = path.join(ws.dreamDir, "reports");
  const report = await runDream(host, runOptions(ws, { onStage: (name) => { if (name === "cursor") fs.chmodSync(reportsDir, 0o500); } }));
  fs.chmodSync(reportsDir, 0o700);
  assert.equal(report.status, "success");
  assert.equal(report.cursor.committed, true, "the returned report is truthful: the cursor moved");
  const onDisk = ws.reports().at(-1);
  assert.equal(onDisk.cursor.commit_intent, true);
  assert.equal(onDisk.cursor.digest, sha256(fs.readFileSync(ws.cursorFile)), "the report already on disk names the cursor that was committed");
  assert.equal((await runDream(host, runOptions(ws))).status, "noop");
});

test("a failure at the receipt boundary still reports what the store gained", async (t) => {
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  await assert.rejects(() => runDream(host, runOptions(ws, { onStage: (name) => { if (name === "receipt") throw new Error("boom"); } })), /boom/);
  const failed = ws.reports().at(-1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.claims.created, (await store.listProposals()).length);
  assert.equal(failed.receipts.length, failed.claims.created);
});

test("another proposer's plan for the same sitting is not this run's plan: it is ignored, and the sitting is still extracted", async (t) => {
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: (c) => (c.includes("banker's rounding") ? [{ quote: "I switched to banker's rounding on the total.", subject: "svc theirs", subjectType: "service", property: "mode", value: "theirs", posture: "stated" }] : []) } });
  t.after(ws.cleanup);
  await runDream(host, runOptions(ws, { proposerId: "the-other-dreamer" }));
  fs.rmSync(ws.cursorFile);
  const ours = await scriptedExtract({ claimsOf: (c) => (c.includes("banker's rounding") ? [{ quote: "I switched to banker's rounding on the total.", subject: "svc ours", subjectType: "service", property: "mode", value: "ours", posture: "stated" }] : []) });
  const report = await runDream({ ...host, extract: ours }, runOptions(ws));
  assert.equal(report.status, "success");
  assert.ok(ours.calls.length > 0, "this proposer had no plan for the sitting, so it asked the model");
  const mine = (await store.listProposals()).filter((p) => p.proposer_id === "knowledge.dream").map((p) => JSON.parse(p.candidate.body).claim.value);
  assert.deepEqual(mine, ["ours"], "it proposed its own claim, not the other proposer's plan");
});

test("a stored routing decision that was edited and re-sealed is still refused: the decision must follow from its own input", async (t) => {
  const { planDigest } = await import("../../kits/knowledge/dream/envelope.js");
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  await runDream(host, runOptions(ws));
  fs.rmSync(ws.cursorFile);
  const [first] = await store.listProposals();
  const body = JSON.parse(first.candidate.body);
  // The decision sits outside the plan digest, so an attacker only has to change the outcome.
  body.decision = { ...body.decision, outcome: "routed" };
  fs.writeFileSync(`${store.dir}/${first.id}.json`, JSON.stringify({ ...first, candidate: { ...first.candidate, body: JSON.stringify(body) } }));
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.code === "DREAM_RECEIPT_CORRUPT" && error.proposalId === first.id);
});

test("a sitting that yields more than 32 claims proposes 32 and counts the rest", async (t) => {
  const many = (content) => (content.includes("banker's rounding")
    ? Array.from({ length: 40 }, (_, i) => ({ quote: "I switched to banker's rounding on the total.", subject: `svc ${String(i).padStart(2, "0")}`, subjectType: "service", property: "mode", value: `v${i}`, posture: "stated" }))
    : []);
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: many } });
  t.after(ws.cleanup);
  const report = await runDream(host, runOptions(ws));
  assert.equal((await store.listProposals()).length, 32);
  assert.equal(report.claims.truncated, 8);
  assert.equal(report.claims.distilled, 32);
});

test("a delivered extraction whose every item is malformed fails the pass: it is not an empty sitting", async (t) => {
  const { FakeModelRuntime } = await import("@kontourai/relay");
  const { extractForRuntime } = await import("../../kits/knowledge/dream/model.js");
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const bad = () => ({ provider: "fake", model: "m", outputText: "", toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: { proposals: [{ foo: "bar" }] } }], usage: {}, latencyMs: 1, stopReason: "tool_use" });
  const host = hostFor(ws, noApplyStore(new FakeCorpusStore(ws.memoryRoot)), await extractForRuntime(new FakeModelRuntime(Array.from({ length: 8 }, bad))));
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.code === "DREAM_DISTILL_FAILED");
  assert.equal(fs.existsSync(ws.cursorFile), false);
});

test("a lock that cannot be removed after the cursor commits does not turn a finished run into a failed one", async (t) => {
  const { ws, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] } });
  t.after(ws.cleanup);
  const original = fs.writeFileSync;
  fs.writeFileSync = (target, ...rest) => {
    if (String(target).endsWith("released")) throw Object.assign(new Error("EIO"), { code: "EIO" });
    return original(target, ...rest);
  };
  syncBuiltinESMExports();
  let report;
  try { report = await runDream(host, runOptions(ws)); } finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
  assert.equal(report.status, "success");
  assert.equal(report.cursor.committed, true);
  assert.ok(fs.existsSync(ws.cursorFile));
  // The epoch was never marked released. It names this process, so it goes stale when the process exits; here the
  // process is still alive, so the lock correctly stays held.
  assert.ok(!fs.existsSync(path.join(ws.dreamDir, "dream.lock", "1", "released")));
});

test("a resumed plan is routed against the claims, policy and visibility in force now, not when it was drafted", async (t) => {
  const two = (content) => (content.includes("banker's rounding")
    ? ["alpha", "beta"].map((name) => ({ quote: "I switched to banker's rounding on the total.", subject: "svc shared", subjectType: "service", property: `mode ${name}`, value: name, posture: "stated" }))
    : []);
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: two } });
  t.after(ws.cleanup);
  store.failProposeCreate(1);
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.cause?.code === "INJECTED");
  const [landed] = await store.listProposals();
  assert.equal(JSON.parse(landed.candidate.body).decision.outcome, "proposed", "when it was drafted nothing conflicted");

  // Meanwhile another claim lands in the same slot with a different value.
  const rival = JSON.parse(landed.candidate.body).claim;
  const { memoryClaim } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const { id: _id, schema_version: _v, ...fields } = rival;
  const other = memoryClaim({ ...fields, value: "a different value", source: { ...rival.source, locator: "chars:0-1", excerpt: "x" } });
  const { encodeEnvelope } = await import("../../kits/knowledge/dream/envelope.js");
  const { routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const entry = { claim: other, agreement: { passes: 2, agreeing: 2 }, project: null };
  const decision = routeMemoryChange({ type: "claim", claim: other, current: [], agreement: { passes: 2, agreeing: 2 }, sourceVisibility: { kind: "restricted", audiences: ["user:owner"] } });
  await store.proposeCreate({ title: "rival", category: "memory.claim", body: encodeEnvelope({ plan: [entry], index: 0, decision, sitting: { id: "elsewhere:1", contentHash: "sha256:x", visibilityKey: "k" } }) }, "knowledge.dream", { agent: "x", proposal: "x" });

  host.published.length = 0;
  const retry = await runDream(host, runOptions(ws));
  assert.equal(retry.sittings.resumed, 1);
  assert.equal(retry.claims.rerouted, 1, "the landed claim now conflicts with the rival");
  assert.equal(retry.claims.routed, 2, "the landed claim is routed on resume; the rival is a pending claim the brief now holds back, routed too");
  assert.equal(retry.review_items, 2);
  assert.equal(host.published.at(-1).reviewItems.length, 2, "and the reviewer is told about both");
  assert.equal(JSON.parse((await store.listProposals())[0].candidate.body).decision.outcome, "proposed", "the stored plan is untouched");
});

test("a claim over the size bound is left out and counted; the rest of the sitting still goes through", async (t) => {
  const mixed = (content) => (content.includes("banker's rounding")
    ? [
      { quote: "I switched to banker's rounding on the total.", subject: "svc big", subjectType: "service", property: "blob", value: `big${"x".repeat(100 * 1024)}`, posture: "stated" },
      { quote: "I switched to banker's rounding on the total.", subject: "svc small", subjectType: "service", property: "mode", value: "small", posture: "stated" },
    ]
    : []);
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: mixed } });
  t.after(ws.cleanup);
  const report = await runDream(host, runOptions(ws));
  const values = (await store.listProposals()).map((p) => JSON.parse(p.candidate.body).claim.value);
  assert.deepEqual(values, ["small"]);
  assert.equal(report.claims.truncated, 1);
  assert.ok(report.cursor.committed, "an honest oversize claim does not stall the sitting");
});

test("every envelope fits its bound by construction, in the worst case the bounds allow", async () => {
  const { encodeEnvelope, fitPlan, MAX_ENVELOPE_BYTES, MAX_CLAIM_BYTES } = await import("../../kits/knowledge/dream/envelope.js");
  const { memoryClaim, routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const make = (n) => memoryClaim({
    subject: { type: "service", id: `s${n % 3}`, label: `s${n % 3}` }, claimType: "knowledge.memory-claim", property: "p", value: `v${n}${"x".repeat(MAX_CLAIM_BYTES - 1500)}`,
    speaker: "user", source: { ref: "sitting:w", locator: `chars:0-${n}`, excerpt: "e", observedAt: "2026-11-02T00:00:00.000Z" }, posture: "stated", visibility: { kind: "public" },
  });
  const claims = Array.from({ length: 200 }, (_, n) => make(n)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const peers = claims.slice(100, 164).filter((c) => c.subject.id === "s0").concat(claims.slice(100, 164)).slice(0, 64);
  const entries = claims.slice(0, 60).map((claim) => ({ claim, agreement: { passes: 2, agreeing: 2 }, project: null }));
  const { plan } = fitPlan(entries);
  assert.ok(plan.length > 0 && plan.length <= 32);
  let worst = 0;
  for (const [index, entry] of plan.entries()) {
    const sameSlot = [...new Map(peers.map((c) => [c.id, c])).values()].filter((c) => c.subject.id === entry.claim.subject.id && c.id !== entry.claim.id).slice(0, 64);
    const decision = routeMemoryChange({ type: "claim", claim: entry.claim, current: sameSlot, agreement: entry.agreement, sourceVisibility: { kind: "public" } });
    worst = Math.max(worst, Buffer.byteLength(encodeEnvelope({ plan, index, decision, sitting: { id: "s", contentHash: "h", visibilityKey: "k" } })));
  }
  assert.ok(worst <= MAX_ENVELOPE_BYTES, `${worst} > ${MAX_ENVELOPE_BYTES}`);
});

test("an over-size stored body is refused without being parsed", async () => {
  const { decodeEnvelope, MAX_ENVELOPE_BYTES } = await import("../../kits/knowledge/dream/envelope.js");
  const original = JSON.parse;
  let parsed = 0;
  JSON.parse = (...args) => { parsed += 1; return original(...args); };
  try {
    assert.equal(decodeEnvelope(`{"dream":"1.2","pad":"${"x".repeat(MAX_ENVELOPE_BYTES)}"}`), null);
  } finally { JSON.parse = original; }
  assert.equal(parsed, 0);
});

test("visibility compares as a set: reordering the audiences resumes the plan instead of extracting again", async (t) => {
  const two = (content) => (content.includes("banker's rounding")
    ? ["alpha", "beta"].map((name) => ({ quote: "I switched to banker's rounding on the total.", subject: `svc ${name}`, subjectType: "service", property: "mode", value: name, posture: "stated" }))
    : []);
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: two } });
  t.after(ws.cleanup);
  store.failProposeCreate(1);
  await assert.rejects(() => runDream(host, runOptions(ws, { visibility: { kind: "restricted", audiences: ["user:a", "user:b"] } })), (error) => error.cause?.code === "INJECTED");
  const reworded = await scriptedExtract({ claimsOf: () => [{ quote: "I switched to banker's rounding on the total.", subject: "svc other", subjectType: "service", property: "x", value: "other", posture: "stated" }] });
  const retry = await runDream({ ...host, extract: reworded }, runOptions(ws, { visibility: { kind: "restricted", audiences: ["user:b", "user:a", "user:b"] } }));
  assert.equal(retry.sittings.resumed, 1);
  assert.ok(reworded.calls.every((call) => !call.content.includes("banker's rounding")), "the half-proposed sitting was not extracted again");
  assert.deepEqual((await store.listProposals()).map((p) => JSON.parse(p.candidate.body).claim.value).sort(), ["alpha", "beta"]);
});

test("two claims from one sitting that disagree are routed to review against each other", async (t) => {
  const clash = (content) => (content.includes("banker's rounding")
    ? ["half up", "half even"].map((value) => ({ quote: "I switched to banker's rounding on the total.", subject: "ledger", subjectType: "service", property: "rounding", value, posture: "stated" }))
    : []);
  const { ws, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: clash } });
  t.after(ws.cleanup);
  const report = await runDream(host, runOptions(ws));
  assert.equal(report.claims.routed, 2, "neither saw the other in the store, but they are peers in one plan");
  assert.equal(report.review_items, 2);
  assert.equal(host.published.at(-1).reviewItems.length, 2);
});

test("a resumed plan passes the route stage, so a host gate there can stop it", async (t) => {
  const two = (content) => (content.includes("banker's rounding")
    ? ["alpha", "beta"].map((name) => ({ quote: "I switched to banker's rounding on the total.", subject: `svc ${name}`, subjectType: "service", property: "mode", value: name, posture: "stated" }))
    : []);
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: two } });
  t.after(ws.cleanup);
  store.failProposeCreate(1);
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.cause?.code === "INJECTED");
  await assert.rejects(() => runDream(host, runOptions(ws, { onStage: (name) => { if (name === "route") throw new Error("gate closed"); } })), /gate closed/);
  assert.equal((await store.listProposals()).length, 1, "the gate stopped the run before it proposed the missing claim");
});

test("changing the visibility starts a new plan: a half-proposed sitting is not resumed under another visibility", async (t) => {
  const two = (content) => (content.includes("banker's rounding")
    ? ["alpha", "beta"].map((name) => ({ quote: "I switched to banker's rounding on the total.", subject: `svc ${name}`, subjectType: "service", property: "mode", value: name, posture: "stated" }))
    : []);
  const { ws, store, extract, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: two } });
  t.after(ws.cleanup);
  store.failProposeCreate(1);
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.cause?.code === "INJECTED");
  const before = extract.calls.length;
  const wider = { kind: "restricted", audiences: ["user:owner", "user:other"] };
  await runDream(host, runOptions(ws, { visibility: wider }));
  assert.ok(extract.calls.length > before, "claims made under the old visibility are different claims, so the sitting was extracted again");
  const visibilities = (await store.listProposals()).map((p) => JSON.stringify(JSON.parse(p.candidate.body).claim.visibility));
  assert.ok(visibilities.some((v) => v.includes("user:other")));
});

// ── the lock: epochs made whole by a rename, so nothing is ever removed from under a live owner ───────────────

const DEAD = 2 ** 22 + 1;
function epochDir(lock, n, owner, extra = {}) {
  const dir = path.join(lock, String(n));
  fs.mkdirSync(dir, { recursive: true });
  if (owner) fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner));
  if (extra.released) fs.writeFileSync(path.join(dir, "released"), "\n");
  return dir;
}
/** Run `fn` while `hook` runs once, just before the first renameSync whose destination ends with `suffix`. */
function beforeRename(suffix, hook, fn) {
  const original = fs.renameSync;
  let fired = false;
  fs.renameSync = (from, to, ...rest) => {
    if (!fired && String(to).endsWith(suffix)) {
      fired = true;
      hook();
    }
    return original(from, to, ...rest);
  };
  syncBuiltinESMExports();
  try { return fn(); } finally { fs.renameSync = original; syncBuiltinESMExports(); }
}

test("lock: a live owner holds it, a released or dead one does not, and the epoch only grows", (t) => {
  const dir = tempDir("dream-lock-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "dream.lock");
  const release = acquireDreamLock(lock);
  assert.throws(() => acquireDreamLock(lock), (error) => error.code === "DREAM_LOCKED");
  release();
  const again = acquireDreamLock(lock);
  assert.deepEqual(fs.readdirSync(lock), ["2"], "released epoch 1 was removed only because epoch 2 now exists");
  again();
  assert.deepEqual(fs.readdirSync(lock), ["2"], "the highest epoch stays so a slow caller can never reuse a number");

  fs.rmSync(lock, { recursive: true });
  epochDir(lock, 3, { pid: DEAD, started_at: 1, token: "dead" });
  acquireDreamLock(lock)();
  // An epoch with no owner cannot be made by this protocol (it appears whole), so it is corruption, not a caller mid-way.
  fs.rmSync(lock, { recursive: true });
  epochDir(lock, 3, null);
  acquireDreamLock(lock)();
  // A live owner is never evicted for being old.
  fs.rmSync(lock, { recursive: true });
  epochDir(lock, 3, { pid: process.pid, started_at: 1, token: "ancient" });
  assert.throws(() => acquireDreamLock(lock), (error) => error.code === "DREAM_LOCKED");
});

test("lock: an owner that paused for longer than any grace period is not mistaken for debris, because it was never half-made", (t) => {
  const dir = tempDir("dream-lock-pause-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "dream.lock");
  // A has staged epoch 1 and is about to rename it into place. The pause is long (the clock is not consulted at all).
  let b;
  let aRelease;
  beforeRename(`${path.sep}1`, () => {
    // While A is paused, B looks: there is no epoch 1 yet, so B makes it.
    b = acquireDreamLock(lock);
  }, () => {
    try { aRelease = acquireDreamLock(lock); } catch (error) { assert.equal(error.code, "DREAM_LOCKED"); }
  });
  assert.equal(typeof b, "function", "B owns epoch 1");
  assert.equal(aRelease, undefined, "A found epoch 1 taken (its rename onto a non-empty directory failed) and saw B's live owner");
  assert.deepEqual(fs.readdirSync(lock).sort(), ["1"], "A's staging directory is gone");
  assert.throws(() => acquireDreamLock(lock), (error) => error.code === "DREAM_LOCKED");
  b();
});

test("lock: two callers that both found the owner dead cannot both own it", (t) => {
  const dir = tempDir("dream-lock-race-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "dream.lock");
  epochDir(lock, 3, { pid: DEAD, started_at: 1, token: "dead" });
  let b;
  let aError;
  beforeRename(`${path.sep}4`, () => { b = acquireDreamLock(lock); }, () => {
    try { acquireDreamLock(lock); } catch (error) { aError = error; }
  });
  assert.equal(typeof b, "function", "B took epoch 4");
  assert.equal(aError?.code, "DREAM_LOCKED", "A found epoch 4 taken, looked again, and saw a live owner");
  assert.throws(() => acquireDreamLock(lock), (error) => error.code === "DREAM_LOCKED", "and C cannot get in beside B");
  b();
});

test("lock: a caller that was slow enough to be passed by two others backs out and removes nothing of theirs", (t) => {
  const dir = tempDir("dream-lock-slow-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "dream.lock");
  epochDir(lock, 3, { pid: DEAD, started_at: 1, token: "dead" });
  let c;
  let aError;
  beforeRename(`${path.sep}4`, () => {
    acquireDreamLock(lock)();
    c = acquireDreamLock(lock);
    assert.deepEqual(fs.readdirSync(lock).filter((name) => !name.startsWith(".stage-")), ["5"], "epoch 4 is gone, so A's rename will succeed");
  }, () => {
    try { acquireDreamLock(lock); } catch (error) { aError = error; }
  });
  assert.equal(typeof c, "function");
  assert.equal(aError?.code, "DREAM_LOCKED", "A made epoch 4, saw epoch 5 above it, and gave way");
  assert.deepEqual(fs.readdirSync(lock), ["5"], "A removed its own epoch and left C's");
  assert.throws(() => acquireDreamLock(lock), (error) => error.code === "DREAM_LOCKED", "C still holds it");
  c();
});

test("lock: failing to remove an older epoch never costs the lock that was won", (t) => {
  const dir = tempDir("dream-lock-clean-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "dream.lock");
  epochDir(lock, 3, { pid: DEAD, started_at: 1, token: "dead" });
  const original = fs.rmSync;
  fs.rmSync = (target, ...rest) => {
    if (String(target).endsWith(`${path.sep}3`)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    return original(target, ...rest);
  };
  syncBuiltinESMExports();
  let release;
  try { release = acquireDreamLock(lock); } finally { fs.rmSync = original; syncBuiltinESMExports(); }
  assert.equal(typeof release, "function");
  assert.throws(() => acquireDreamLock(lock), (error) => error.code === "DREAM_LOCKED", "the winner holds it, with debris below");
  release();
  acquireDreamLock(lock)();
});

test("lock: debris beside the epochs, and epoch names that are not epochs, do not wedge it", (t) => {
  const dir = tempDir("dream-lock-debris-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "dream.lock");
  epochDir(lock, 1, { pid: DEAD, started_at: 1, token: "dead" });
  fs.writeFileSync(path.join(lock, "stray.tmp"), "{");
  fs.mkdirSync(path.join(lock, ".stage-crashed-0"));
  fs.mkdirSync(path.join(lock, "not-an-epoch"));
  fs.mkdirSync(path.join(lock, "0"));
  fs.mkdirSync(path.join(lock, "9007199254740993")); // sixteen digits: not read as an epoch
  acquireDreamLock(lock)();
  assert.ok(fs.existsSync(path.join(lock, "2")));
});

test("lock: an exhausted epoch counter is refused by name instead of wrapping", (t) => {
  const dir = tempDir("dream-lock-max-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "dream.lock");
  epochDir(lock, 999999999999999, { pid: DEAD, started_at: 1, token: "dead" });
  assert.throws(() => acquireDreamLock(lock), (error) => error.code === "DREAM_LOCK_EXHAUSTED");
});

test("the 64-peer limit cannot hide the one rival: a slot with many agreeing claims and one that disagrees still routes", async (t) => {
  const { encodeEnvelope, visibilityKey } = await import("../../kits/knowledge/dream/envelope.js");
  const { memoryClaim, routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const vis = { kind: "restricted", audiences: ["user:owner"] };
  const claimOf = (value, n) => memoryClaim({ subject: { type: "service", id: "ledger", label: "ledger" }, claimType: "knowledge.memory-claim", property: "rounding mode", value, speaker: "user", source: { ref: "sitting:seed", locator: `chars:0-${n}`, excerpt: `e${n}`, observedAt: "2026-10-01T00:00:00.000Z" }, posture: "stated", visibility: vis });
  // 80 earlier-sorting claims that agree with the new one, and one that does not.
  const seed = [...Array.from({ length: 80 }, (_, i) => claimOf("banker's rounding", i)), claimOf("half up", 999)];
  for (const [i, claim] of seed.entries()) {
    const entry = { claim, agreement: { passes: 2, agreeing: 2 }, project: null };
    const decision = routeMemoryChange({ type: "claim", claim, current: [], agreement: entry.agreement, sourceVisibility: vis });
    await store.proposeCreate({ title: `seed ${i}`, category: "memory.claim", body: encodeEnvelope({ plan: [entry], index: 0, decision, sitting: { id: `seed:${i}`, contentHash: "h", visibilityKey: visibilityKey(vis) } }) }, "knowledge.dream", { agent: "x", proposal: "x" });
  }
  const one = (content) => (content.includes("banker's rounding") ? [{ quote: "I switched to banker's rounding on the total.", subject: "ledger", subjectType: "service", property: "rounding mode", value: "banker's rounding", posture: "stated" }] : []);
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract({ claimsOf: one }));
  const report = await runDream(host, runOptions(ws));
  assert.equal(report.status, "success");
  const published = host.published.at(-1).decisions.find((d) => d.changeType === "claim" && d.input.claim.value === "banker's rounding" && d.input.claim.source.ref.startsWith("codex:"));
  assert.equal(published.outcome, "routed", "the lone rival was found among 80 agreeing claims");
  assert.ok(published.input.current.some((peer) => peer.value === "half up"));
  assert.ok(published.input.current.length <= 16, "and the decision embeds only the peers that matter");
  assert.ok(report.claims.created >= 1);
});

test("a foreign writer's contest of an applied claim reaches the review queue, though no sitting produced it", async (t) => {
  const { encodeEnvelope, visibilityKey } = await import("../../kits/knowledge/dream/envelope.js");
  const { memoryClaim, routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract());
  await runDream(host, runOptions(ws));
  const [first] = await store.listProposals();
  await store.applyCreate(first.id, "a-human-reviewer");
  const mine = JSON.parse(first.candidate.body).claim;
  const { id: _id, schema_version: _v, ...fields } = mine;
  const rival = memoryClaim({ ...fields, value: "something else", source: { ...fields.source, locator: "chars:0-1", excerpt: "x" } });
  const entry = { claim: rival, agreement: { passes: 2, agreeing: 2 }, project: null };
  const decision = routeMemoryChange({ type: "claim", claim: rival, current: [], agreement: entry.agreement, sourceVisibility: mine.visibility });
  await store.proposeCreate({ title: "foreign", category: "memory.claim", body: encodeEnvelope({ plan: [entry], index: 0, decision, sitting: { id: "elsewhere:1", contentHash: "h", visibilityKey: visibilityKey(mine.visibility) } }) }, "another-writer", { agent: "x", proposal: "x" });
  host.published.length = 0;
  const report = await runDream(host, runOptions(ws));
  assert.equal(report.status, "noop", "no new telemetry");
  assert.equal(report.claims.contested_routed, 1);
  assert.equal(host.published.length, 1, "and the no-op run still hands the contest to review");
  assert.equal(host.published[0].reviewItems.length, 1);
  assert.equal(host.published[0].decisions[0].reasons[0].rule, "contested-by-accumulation");
});

test("an envelope over its byte bound is refused to encode, and a stored claim over the claim bound is unverifiable", async () => {
  const { encodeEnvelope, decodeEnvelope, MAX_ENVELOPE_BYTES, MAX_CLAIM_BYTES } = await import("../../kits/knowledge/dream/envelope.js");
  const { memoryClaim, routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const make = (size) => memoryClaim({ subject: { type: "s", id: "s", label: "s" }, claimType: "knowledge.memory-claim", property: "p", value: "v".repeat(size), speaker: "user", source: { ref: "r", locator: "chars:0-1", excerpt: "e", observedAt: "2026-11-02T00:00:00.000Z" }, posture: "stated", visibility: { kind: "public" } });
  const entry = (claim) => ({ claim, agreement: null, project: null });
  const decide = (claim) => routeMemoryChange({ type: "claim", claim, current: [], agreement: null, sourceVisibility: { kind: "public" } });
  const sitting = { id: "s", contentHash: "h", visibilityKey: "k" };

  const big = make(MAX_CLAIM_BYTES + 100);
  const body = encodeEnvelope({ plan: [entry(big)], index: 0, decision: decide(big), sitting });
  assert.equal(decodeEnvelope(body), null, "a claim over the bound is unverifiable even when the rest of the envelope is sound");
  const ok = make(100);
  assert.notEqual(decodeEnvelope(encodeEnvelope({ plan: [entry(ok)], index: 0, decision: decide(ok), sitting })), null);

  const huge = { ...decide(ok), pad: "x".repeat(MAX_ENVELOPE_BYTES) };
  assert.throws(() => encodeEnvelope({ plan: [entry(ok)], index: 0, decision: huge, sitting }), (error) => error.code === "DREAM_PLAN_TOO_LARGE");
});

test("an over-size body of this run's own is refused without being parsed, even to name its format", async () => {
  const { indexProposals, MAX_ENVELOPE_BYTES } = await import("../../kits/knowledge/dream/envelope.js");
  const proposal = { id: "p1", state: "pending", proposer_id: "knowledge.dream", candidate: { category: "memory.claim", body: `{"dream":"1.1","pad":"${"x".repeat(MAX_ENVELOPE_BYTES)}"}` } };
  const original = JSON.parse;
  let parsed = 0;
  JSON.parse = (...args) => { parsed += 1; return original(...args); };
  try {
    assert.throws(() => indexProposals([proposal], "knowledge.dream"), (error) => error.code === "DREAM_RECEIPT_CORRUPT" && !/format/.test(error.message));
  } finally { JSON.parse = original; }
  assert.equal(parsed, 0);
});

// ── review round 4 ────────────────────────────────────────────────────────────────────────────────────────────

import { boundFact, MAX_FACT_IDS, MAX_FACT_GAPS } from "../../kits/knowledge/dream/envelope.js";

test("a projection fact is bounded before it is stored: thousands of candidates keep the claim and its rivals, and say so", () => {
  const ids = Array.from({ length: 30000 }, (_, i) => `sha256:${String(i).padStart(64, "0")}`);
  const mine = ids[12345];
  const rival = ids[29999];
  const { fact, cut } = boundFact({ outcome: "contested", candidateClaimIds: ids, gapCodes: Array.from({ length: 40 }, (_, i) => `gap-${i}`) }, mine, [rival]);
  assert.equal(fact.candidateClaimIds.length, MAX_FACT_IDS);
  assert.ok(fact.candidateClaimIds.includes(mine) && fact.candidateClaimIds.includes(rival));
  assert.ok(fact.gapCodes.length <= MAX_FACT_GAPS);
  assert.ok(fact.gapCodes.some((code) => code.startsWith("truncated:")), "the cut is recorded in the fact itself");
  assert.equal(fact.gapCodes.length, MAX_FACT_GAPS);
  const dropped = 40 - (MAX_FACT_GAPS - 1);
  assert.ok(fact.gapCodes.includes(`truncated:${30000 - MAX_FACT_IDS}ids:${dropped}gaps`), "the code states exactly what was dropped");
  assert.equal(cut, (30000 - MAX_FACT_IDS) + dropped);
  const exact = boundFact({ outcome: "contested", candidateClaimIds: [mine], gapCodes: Array.from({ length: 17 }, (_, i) => `g${String(i).padStart(2, "0")}`) }, mine);
  assert.deepEqual(exact.fact.gapCodes.filter((code) => code.startsWith("truncated:")), ["truncated:0ids:2gaps"], "17 codes into 16 slots with one for the note drops two originals");
  assert.equal(exact.cut, 2);
  const edge = boundFact({ outcome: "invalid", reason: "r".repeat(121), candidateClaimIds: [mine], gapCodes: ["g".repeat(120), "h".repeat(121)] }, mine);
  assert.equal(edge.fact.reason.length, 120, "the string bound is exactly MAX_FACT_STRING characters");
  assert.deepEqual(edge.fact.gapCodes.map((code) => code.length).sort((a, b) => a - b), [120, 120], "a 120-character code is kept whole; a 121-character one is cut to 120");
  const long = boundFact({ outcome: "invalid", reason: "r".repeat(5 * 1024 * 1024), candidateClaimIds: [mine], gapCodes: ["g".repeat(5 * 1024 * 1024)] }, mine);
  assert.ok(Buffer.byteLength(JSON.stringify(long.fact)) < 2048, "strings are bounded as well as counts");
  assert.ok(Buffer.byteLength(JSON.stringify(fact)) < 4096);
  const started = Date.now();
  boundFact({ outcome: "contested", candidateClaimIds: ids, gapCodes: [] }, mine, [rival]);
  assert.ok(Date.now() - started < 500, "bounding is linear in the candidates");
  const small = boundFact({ outcome: "current", candidateClaimIds: [mine], gapCodes: [] }, mine);
  assert.equal(small.cut, 0);
  assert.deepEqual(small.fact.gapCodes, []);
});

test("a slot with many candidates still produces a small, storable decision, through the whole run", async (t) => {
  const { encodeEnvelope, visibilityKey, MAX_FACT_IDS } = await import("../../kits/knowledge/dream/envelope.js");
  const { memoryClaim, routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const vis = { kind: "restricted", audiences: ["user:owner"] };
  for (let n = 0; n < 120; n += 1) {
    const claim = memoryClaim({ subject: { type: "service", id: "ledger", label: "ledger" }, claimType: "knowledge.memory-claim", property: "rounding", value: `rival ${n}`, speaker: "user", source: { ref: `sitting:r${n}`, locator: `chars:0-${n}`, excerpt: `e${n}`, observedAt: "2026-10-01T00:00:00.000Z" }, posture: "stated", visibility: vis });
    const entry = { claim, agreement: { passes: 2, agreeing: 2 }, project: null };
    const decision = routeMemoryChange({ type: "claim", claim, current: [], agreement: entry.agreement, sourceVisibility: vis });
    await store.proposeCreate({ title: `rival ${n}`, category: "memory.claim", body: encodeEnvelope({ plan: [entry], index: 0, decision, sitting: { id: `rival:${n}`, contentHash: "h", visibilityKey: visibilityKey(vis) } }) }, "knowledge.dream", { agent: "x", proposal: "x" });
  }
  const one = (content) => (content.includes("banker's rounding") ? [{ quote: "I switched to banker's rounding on the total.", subject: "ledger", subjectType: "service", property: "rounding", value: "banker's", posture: "stated" }] : []);
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract({ claimsOf: one }));
  const report = await runDream(host, runOptions(ws, { visibility: vis }));
  assert.equal(report.status, "success");
  assert.ok(report.claims.facts_truncated >= 1, "121 candidates were cut to what a decision stores");
  const mine = (await store.listProposals()).map((p) => JSON.parse(p.candidate.body)).find((e) => e.sitting.id.startsWith("codex:"));
  assert.equal(mine.decision.outcome, "routed");
  assert.ok(mine.decision.input.accumulation.candidateClaimIds.length <= MAX_FACT_IDS);
  assert.ok(mine.decision.input.current.length <= 16);
  assert.ok(Buffer.byteLength(JSON.stringify(mine.decision)) < 256 * 1024);
});

test("a contest that a Survey edit created reaches the review queue: the verdict the brief used is the one routing is given", async (t) => {
  const { buildReviewDecisionsFromSession, initialReviewQueueSessionState } = await import("@kontourai/survey/review-workbench");
  const { buildMemoryReviewItem, memoryClaim, routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const { encodeEnvelope, visibilityKey } = await import("../../kits/knowledge/dream/envelope.js");
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const vis = { kind: "restricted", audiences: ["user:owner"] };
  const claimOf = (n) => memoryClaim({ subject: { type: "service", id: "ledger", label: "ledger" }, claimType: "knowledge.memory-claim", property: "rounding mode", value: "banker's rounding", speaker: "user", source: { ref: `sitting:seed${n}`, locator: `chars:0-${n}`, excerpt: `e${n}`, observedAt: "2026-10-01T00:00:00.000Z" }, posture: "stated", visibility: vis });
  const [a, b] = [claimOf(1), claimOf(2)]; // they agree
  const ids = [];
  for (const [i, claim] of [a, b].entries()) {
    const entry = { claim, agreement: { passes: 2, agreeing: 2 }, project: null };
    const decision = routeMemoryChange({ type: "claim", claim, current: [], agreement: entry.agreement, sourceVisibility: vis });
    ids.push(await store.proposeCreate({ title: `seed ${i}`, category: "memory.claim", body: encodeEnvelope({ plan: [entry], index: 0, decision, sitting: { id: `seed:${i}`, contentHash: "h", visibilityKey: visibilityKey(vis) } }) }, "knowledge.dream", { agent: "x", proposal: "x" }));
  }
  await store.applyCreate(ids[0], "a-human-reviewer"); // a is applied; b stays pending
  // Survey's reviewer corrects b to a different value: they now disagree, though no stored value says so.
  const item = buildMemoryReviewItem(routeMemoryChange({ type: "claim", claim: b, agreement: { passes: 2, agreeing: 1 }, sourceVisibility: vis }));
  const reviewDecisions = buildReviewDecisionsFromSession({ ...initialReviewQueueSessionState([item]), actorId: "person:reviewer", reviewerKind: "human", reviewedAt: "2026-11-02T10:00:00.000Z", decisionsByItemName: { [item.metadata.name]: "accept-proposed" }, editedValuesByItemName: { [item.metadata.name]: "half up" } });
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract({ claimsOf: () => [] }), { reviewDecisions: () => reviewDecisions });
  for (let i = 0; i < 3; i += 1) {
    host.published.length = 0;
    const report = await runDream(host, runOptions(ws));
    assert.equal(report.brief_excluded.contested, 2, `run ${i}: the brief holds both back`);
    assert.equal(report.claims.contested_routed, 1, `run ${i}: and the pending one is in the review queue`);
    assert.equal(host.published.at(-1).reviewItems.length, 1);
  }
});

test("report counters are per claim: every proposed claim has exactly one outcome and one published decision", async (t) => {
  const clash = (content) => (content.includes("banker's rounding")
    ? ["half up", "half even"].map((value) => ({ quote: "I switched to banker's rounding on the total.", subject: "ledger", subjectType: "service", property: "rounding", value, posture: "stated" }))
    : []);
  const { ws, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: clash } });
  t.after(ws.cleanup);
  const report = await runDream(host, runOptions(ws));
  assert.equal(report.claims.contested_routed, 0, "both were routed when proposed, so the backfill leaves them alone instead of routing them a second time");
  assert.equal(report.claims.routed + report.claims.uncontested, report.claims.created, "one outcome per proposed claim");
  assert.equal(host.published.at(-1).decisions.length, report.claims.created, "and one decision per claim goes to publish");
});

test("a decision embeds only the peers that matter: agreeing peers that are no narrower are left out", async (t) => {
  const { encodeEnvelope, visibilityKey } = await import("../../kits/knowledge/dream/envelope.js");
  const { memoryClaim, routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const vis = { kind: "restricted", audiences: ["user:owner"] };
  for (let n = 0; n < 3; n += 1) {
    const claim = memoryClaim({ subject: { type: "service", id: "ledger service", label: "ledger service" }, claimType: "knowledge.memory-claim", property: "rounding mode", value: "banker's rounding", speaker: "user", source: { ref: `sitting:seed${n}`, locator: `chars:0-${n}`, excerpt: `e${n}`, observedAt: "2026-10-01T00:00:00.000Z" }, posture: "stated", visibility: vis });
    const entry = { claim, agreement: { passes: 2, agreeing: 2 }, project: null };
    const decision = routeMemoryChange({ type: "claim", claim, current: [], agreement: entry.agreement, sourceVisibility: vis });
    await store.proposeCreate({ title: `seed ${n}`, category: "memory.claim", body: encodeEnvelope({ plan: [entry], index: 0, decision, sitting: { id: `seed:${n}`, contentHash: "h", visibilityKey: visibilityKey(vis) } }) }, "knowledge.dream", { agent: "x", proposal: "x" });
  }
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract());
  await runDream(host, runOptions(ws, { visibility: vis }));
  const mine = (await store.listProposals()).map((p) => JSON.parse(p.candidate.body)).find((e) => e.sitting.id.startsWith("codex:") && e.claim.property === "rounding mode");
  assert.ok(mine, "this run proposed a claim in the same slot as the three seeds");
  assert.deepEqual(mine.decision.input.current, [], "three peers that agree and are no narrower add nothing to the decision");
  assert.equal(mine.decision.outcome, "proposed");
});

test("a peer the claim would be wider than is embedded and routes it, though it agrees on the value", async (t) => {
  const { encodeEnvelope, visibilityKey } = await import("../../kits/knowledge/dream/envelope.js");
  const { memoryClaim, routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const narrower = { kind: "restricted", audiences: ["user:someone-else"] };
  const mine = { kind: "restricted", audiences: ["user:owner"] };
  const peer = memoryClaim({ subject: { type: "service", id: "ledger service", label: "ledger service" }, claimType: "knowledge.memory-claim", property: "rounding mode", value: "banker's rounding", speaker: "user", source: { ref: "sitting:seed", locator: "chars:0-1", excerpt: "e", observedAt: "2026-10-01T00:00:00.000Z" }, posture: "stated", visibility: narrower });
  const entry = { claim: peer, agreement: { passes: 2, agreeing: 2 }, project: null };
  const decision = routeMemoryChange({ type: "claim", claim: peer, current: [], agreement: entry.agreement, sourceVisibility: narrower });
  await store.proposeCreate({ title: "narrow", category: "memory.claim", body: encodeEnvelope({ plan: [entry], index: 0, decision, sitting: { id: "seed:1", contentHash: "h", visibilityKey: visibilityKey(narrower) } }) }, "knowledge.dream", { agent: "x", proposal: "x" });
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract());
  await runDream(host, runOptions(ws, { visibility: mine }));
  const stored = (await store.listProposals()).map((p) => JSON.parse(p.candidate.body)).find((e) => e.sitting.id.startsWith("codex:") && e.claim.property === "rounding mode");
  assert.equal(stored.decision.outcome, "routed");
  assert.deepEqual(stored.decision.reasons.map((r) => r.rule), ["visibility-widening"]);
  assert.deepEqual(stored.decision.input.current.map((c) => c.id), [peer.id], "the narrower peer is the bound that routes it, so it is embedded");
});

// ── review round 5 ─────────────────────────────────────────────────────────────────────────────────────────────

test("an honest retry of a big contested sitting does not wedge: a plan's claims are peers once, however they got into the store", async (t) => {
  for (const count of [16, 17, 32]) {
    const many = (content) => (content.includes("banker's rounding")
      ? Array.from({ length: count }, (_, i) => ({ quote: "I switched to banker's rounding on the total.", subject: "ledger", subjectType: "service", property: "rounding", value: `value ${i}`, posture: "stated" }))
      : []);
    const { ws, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: many } });
    t.after(ws.cleanup);
    let fail = true;
    host.publish = (batch) => { if (fail) throw new Error("review queue down"); host.published.push(batch); };
    for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(() => runDream(host, runOptions(ws)), /review queue down/, `${count} claims, attempt ${attempt}`);
    fail = false;
    const report = await runDream(host, runOptions(ws));
    assert.equal(report.status, "success", `${count} claims recover once the queue is back`);
    assert.equal(report.claims.routed + report.claims.uncontested >= count, true);
  }
});

test("peers_capped counts every cut: more outcome-changing peers than a decision holds are counted, not silent", async (t) => {
  const { encodeEnvelope, visibilityKey } = await import("../../kits/knowledge/dream/envelope.js");
  const { memoryClaim, routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const narrow = (n) => ({ kind: "restricted", audiences: [`user:other${n}`] });
  for (let n = 0; n < 25; n += 1) {
    const claim = memoryClaim({ subject: { type: "service", id: "ledger service", label: "ledger service" }, claimType: "knowledge.memory-claim", property: "rounding mode", value: "banker's rounding", speaker: "user", source: { ref: `sitting:n${n}`, locator: `chars:0-${n}`, excerpt: `e${n}`, observedAt: "2026-10-01T00:00:00.000Z" }, posture: "stated", visibility: narrow(n) });
    const entry = { claim, agreement: { passes: 2, agreeing: 2 }, project: null };
    const decision = routeMemoryChange({ type: "claim", claim, current: [], agreement: entry.agreement, sourceVisibility: narrow(n) });
    await store.proposeCreate({ title: `n${n}`, category: "memory.claim", body: encodeEnvelope({ plan: [entry], index: 0, decision, sitting: { id: `n:${n}`, contentHash: "h", visibilityKey: visibilityKey(narrow(n)) } }) }, "knowledge.dream", { agent: "x", proposal: "x" });
  }
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract());
  const report = await runDream(host, runOptions(ws, { visibility: { kind: "restricted", audiences: ["user:owner"] } }));
  assert.ok(report.claims.peers_capped >= 1, "25 peers the claim is wider than do not fit in 16, and the report says so");
});


test("review's rejection and correction are seen when routing: a rival the reviewer rejected does not contest, and a peer corrected into disagreement does", async (t) => {
  const { buildReviewDecisionsFromSession, initialReviewQueueSessionState } = await import("@kontourai/survey/review-workbench");
  const { buildMemoryReviewItem, memoryClaim, routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const { encodeEnvelope, visibilityKey } = await import("../../kits/knowledge/dream/envelope.js");
  const vis = { kind: "restricted", audiences: ["user:owner"] };
  const scenario = async (peerValue, decision, editedValue) => {
    const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
    t.after(ws.cleanup);
    const store = new FakeCorpusStore(ws.memoryRoot);
    const peer = memoryClaim({ subject: { type: "service", id: "ledger service", label: "ledger service" }, claimType: "knowledge.memory-claim", property: "rounding mode", value: peerValue, speaker: "user", source: { ref: "sitting:peer", locator: "chars:0-1", excerpt: "e", observedAt: "2026-10-01T00:00:00.000Z" }, posture: "stated", visibility: vis });
    const entry = { claim: peer, agreement: { passes: 2, agreeing: 2 }, project: null };
    await store.proposeCreate({ title: "peer", category: "memory.claim", body: encodeEnvelope({ plan: [entry], index: 0, decision: routeMemoryChange({ type: "claim", claim: peer, current: [], agreement: entry.agreement, sourceVisibility: vis }), sitting: { id: "peer:1", contentHash: "h", visibilityKey: visibilityKey(vis) } }) }, "knowledge.dream", { agent: "x", proposal: "x" });
    const item = buildMemoryReviewItem(routeMemoryChange({ type: "claim", claim: peer, agreement: { passes: 2, agreeing: 1 }, sourceVisibility: vis }));
    const reviewDecisions = buildReviewDecisionsFromSession({ ...initialReviewQueueSessionState([item]), actorId: "person:reviewer", reviewerKind: "human", reviewedAt: "2026-11-02T10:00:00.000Z", decisionsByItemName: { [item.metadata.name]: decision }, ...(editedValue ? { editedValuesByItemName: { [item.metadata.name]: editedValue } } : {}) });
    const mine = (content) => (content.includes("banker's rounding") ? [{ quote: "I switched to banker's rounding on the total.", subject: "ledger service", subjectType: "service", property: "rounding mode", value: "banker's rounding", posture: "stated" }] : []);
    const host = hostFor(ws, noApplyStore(store), await scriptedExtract({ claimsOf: mine }), { reviewDecisions: () => reviewDecisions });
    const report = await runDream(host, runOptions(ws, { visibility: vis }));
    const stored = (await store.listProposals()).map((p) => JSON.parse(p.candidate.body)).find((e) => e.sitting.id.startsWith("codex:") && e.claim.property === "rounding mode");
    return { report, outcome: stored.decision.outcome };
  };
  assert.equal((await scenario("half up", "reject-proposed")).outcome, "proposed", "the reviewer rejected the rival, so it contests nothing");
  assert.equal((await scenario("half up", "accept-proposed")).outcome, "routed", "an accepted rival that disagrees contests");
  assert.equal((await scenario("banker's rounding", "accept-proposed", "half up")).outcome, "routed", "a peer that agreed until the reviewer corrected it now disagrees");
  assert.equal((await scenario("banker's rounding", "accept-proposed")).outcome, "proposed", "and an agreeing peer, uncorrected, contests nothing");
});

test("a contest the brief verified reaches the review queue though routing saw an applied replacement the brief cannot trust", async (t) => {
  const { encodeEnvelope, visibilityKey } = await import("../../kits/knowledge/dream/envelope.js");
  const { memoryClaim, routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const vis = { kind: "restricted", audiences: ["user:owner"] };
  const base = { subject: { type: "service", id: "ledger service", label: "ledger service" }, claimType: "knowledge.memory-claim", property: "rounding mode", speaker: "user", posture: "stated", visibility: vis };
  const source = (n) => ({ ref: `sitting:s${n}`, locator: `chars:0-${n}`, excerpt: `e${n}`, observedAt: "2026-10-01T00:00:00.000Z" });
  const scenario = async (breakSettlement) => {
    const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
    t.after(ws.cleanup);
    const store = new FakeCorpusStore(ws.memoryRoot);
    const a = memoryClaim({ ...base, value: "A", source: source(1) });
    const b = memoryClaim({ ...base, value: "B", source: source(2), supersedes: [{ claimId: a.id, kind: "succession", reason: "the speaker said it replaces the earlier value" }], validTime: { from: "2026-10-02T00:00:00Z" } });
    const c = memoryClaim({ ...base, value: "B", source: source(3) });
    const ids = {};
    for (const [name, claim] of [["a", a], ["b", b], ["c", c]]) {
      const entry = { claim, agreement: { passes: 2, agreeing: 2 }, project: null };
      const decision = routeMemoryChange({ type: "claim", claim, current: [], agreement: entry.agreement, sourceVisibility: vis });
      ids[name] = await store.proposeCreate({ title: name, category: "memory.claim", body: encodeEnvelope({ plan: [entry], index: 0, decision, sitting: { id: `seed:${name}`, contentHash: "h", visibilityKey: visibilityKey(vis) } }) }, "knowledge.dream", { agent: "x", proposal: "x" });
    }
    const recordId = await store.applyCreate(ids.b, "a-human-reviewer");
    if (breakSettlement === "retired") store.retire(recordId);
    if (breakSettlement === "unbound") store.records.set(recordId, { ...store.records.get(recordId), mutation_log: [] });
    const host = hostFor(ws, noApplyStore(store), await scriptedExtract({ claimsOf: () => [] }));
    host.published.length = 0;
    const report = await runDream(host, runOptions(ws, { visibility: vis }));
    return { report, published: host.published };
  };
  // Control: B is a verified, applied replacement of A, so A is superseded and B and C agree: nothing is contested.
  const fine = await scenario(null);
  assert.equal(fine.report.brief_excluded.contested, 0);
  for (const broken of ["retired", "unbound"]) {
    const out = await scenario(broken);
    assert.equal(out.report.brief_excluded.contested, 2, `${broken}: the brief cannot trust B, so A and C contest`);
    assert.equal(out.report.claims.contested_routed, 2, `${broken}: and both reach the review queue`);
    assert.equal(out.published.at(-1).reviewItems.length, 2);
  }
});

test("the review backfill and the brief judge one snapshot: a rival another writer adds between the two reads does not break the run", async (t) => {
  const { encodeEnvelope, visibilityKey } = await import("../../kits/knowledge/dream/envelope.js");
  const { memoryClaim, routeMemoryChange } = await import("../../kits/knowledge/adapters/memory-claims/index.mjs");
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const first = hostFor(ws, noApplyStore(store), await scriptedExtract());
  await runDream(first, runOptions(ws));
  const [mine] = await store.listProposals();
  const claim = JSON.parse(mine.candidate.body).claim;
  const { id: _id, schema_version: _v, ...fields } = claim;
  const rival = memoryClaim({ ...fields, value: "a rival another writer added", source: { ...fields.source, locator: "chars:0-1", excerpt: "x" } });
  const entry = { claim: rival, agreement: { passes: 2, agreeing: 2 }, project: null };
  const decision = routeMemoryChange({ type: "claim", claim: rival, current: [], agreement: entry.agreement, sourceVisibility: claim.visibility });
  let calls = 0; // across every read of the property, not per read
  const racing = new Proxy(store, {
    get(target, prop) {
      if (prop !== "listProposals") { const value = target[prop]; return typeof value === "function" ? value.bind(target) : value; }
      return async (...args) => {
        calls += 1;
        // A no-op run reads the proposals twice: once to index them, once to build the brief. The rival lands between.
        if (calls === 2) await target.proposeCreate({ title: "rival", category: "memory.claim", body: encodeEnvelope({ plan: [entry], index: 0, decision, sitting: { id: "elsewhere:1", contentHash: "h", visibilityKey: visibilityKey(claim.visibility) } }) }, "another-writer", { agent: "x", proposal: "x" });
        return target.listProposals(...args);
      };
    },
  });
  const host = hostFor(ws, noApplyStore(racing), await scriptedExtract());
  host.published.length = 0;
  const report = await runDream(host, runOptions(ws));
  assert.equal(report.status, "noop");
  assert.equal(report.claims.contested_routed >= 1, true, "the claim the rival contests reached the review queue on the run that found it");
  assert.equal(host.published.at(-1).reviewItems.length >= 1, true);
});
