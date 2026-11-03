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

  fs.writeFileSync(path.join(ws.dreamDir, "dream.lock"), JSON.stringify({ pid: 2 ** 22 + 1, started_at: NOW_MS, token: "dead" }));
  assert.equal((await runDream(host, runOptions(ws))).status, "noop");
  assert.equal(fs.existsSync(path.join(ws.dreamDir, "dream.lock")), false, "the lock is released");
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

test("lock: no two owners, whatever interleaves creation; a half-written or unreadable lock is held, not stolen", (t) => {
  const dir = tempDir("dream-lock-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "dream.lock");

  // B arrives while A is between preparing its lock and installing it.
  const original = fs.linkSync;
  let b;
  let bError;
  let injected = false;
  fs.linkSync = (...args) => {
    if (!injected) {
      injected = true;
      try { b = acquireDreamLock(file); } catch (error) { bError = error; }
    }
    return original(...args);
  };
  syncBuiltinESMExports();
  let aError;
  try { acquireDreamLock(file); } catch (error) { aError = error; } finally { fs.linkSync = original; syncBuiltinESMExports(); }
  assert.equal(typeof b, "function", "B took the free lock");
  assert.equal(aError?.code, "DREAM_LOCKED", "A, losing the race for the file, did not also proceed");
  b();

  // A lock file nobody can read (empty, as a crashed create would leave) is held while fresh and debris once old.
  fs.writeFileSync(file, "");
  assert.throws(() => acquireDreamLock(file), (error) => error.code === "DREAM_LOCKED");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(file, old, old);
  acquireDreamLock(file)();

  // A live owner is never evicted for being old.
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started_at: 1, token: "ancient" }));
  assert.throws(() => acquireDreamLock(file), (error) => error.code === "DREAM_LOCKED");
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

test("lock: a takeover that loses to another takeover gives way, and never removes the winner's live lock", (t) => {
  const dir = tempDir("dream-lock-takeover-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "dream.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 1, started_at: 1, token: "dead-owner" }));

  // A has judged the dead owner stale and is about to take the takeover guard. B completes a whole takeover first.
  const original = fs.openSync;
  let b;
  let inside = false;
  fs.openSync = (target, ...rest) => {
    if (!inside && String(target).endsWith(".takeover")) {
      inside = true;
      try { b = acquireDreamLock(file); } finally { inside = false; }
    }
    return original(target, ...rest);
  };
  syncBuiltinESMExports();
  let aError;
  try { acquireDreamLock(file); } catch (error) { aError = error; } finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.equal(typeof b, "function", "B took over the dead owner's lock");
  assert.equal(aError?.code, "DREAM_LOCKED", "A saw that the lock had changed hands and gave way");
  const owner = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.notEqual(owner.token, "dead-owner");
  assert.equal(owner.pid, process.pid, "B's lock is still in place");
  assert.throws(() => acquireDreamLock(file), (error) => error.code === "DREAM_LOCKED", "and C cannot get in beside B");
  b();
  assert.equal(fs.existsSync(file), false);
});

test("lock: debris from a crashed takeover or install does not wedge it", (t) => {
  const dir = tempDir("dream-lock-debris-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "dream.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 1, started_at: 1, token: "dead" }));
  fs.writeFileSync(`${file}.takeover`, JSON.stringify({ pid: 2 ** 22 + 2, started_at: 1 }));
  fs.writeFileSync(`${file}.99.abc.tmp`, "{");
  fs.writeFileSync(`${file}.stale.xyz`, "{");
  const release = acquireDreamLock(file);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
  release();
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
  const original = fs.rmSync;
  fs.rmSync = (target, ...rest) => {
    if (String(target).endsWith("dream.lock")) throw Object.assign(new Error("EIO"), { code: "EIO" });
    return original(target, ...rest);
  };
  syncBuiltinESMExports();
  let report;
  try { report = await runDream(host, runOptions(ws)); } finally { fs.rmSync = original; syncBuiltinESMExports(); }
  assert.equal(report.status, "success");
  assert.equal(report.cursor.committed, true);
  assert.ok(fs.existsSync(ws.cursorFile));
  fs.rmSync(path.join(ws.dreamDir, "dream.lock"), { force: true });
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
  assert.equal(retry.review_items, 1);
  assert.equal(host.published.at(-1).reviewItems.length, 1, "and the reviewer is told");
  assert.equal(JSON.parse((await store.listProposals())[0].candidate.body).decision.outcome, "proposed", "the stored plan is untouched");
});

test("a plan is bounded in bytes as well as claims: oversize claims are left out and counted, not stored", async (t) => {
  const big = (content) => (content.includes("banker's rounding")
    ? ["a", "b", "c"].map((name) => ({ quote: "I switched to banker's rounding on the total.", subject: `svc ${name}`, subjectType: "service", property: "blob", value: `${name}${"x".repeat(100 * 1024)}`, posture: "stated" }))
    : []);
  const { ws, store, host } = await fixture({ workspace: { transcripts: ["codex-rollout.jsonl"] }, extract: { claimsOf: big } });
  t.after(ws.cleanup);
  const report = await runDream(host, runOptions(ws));
  const proposals = await store.listProposals();
  assert.ok(proposals.length < 3 && proposals.length >= 1);
  assert.equal(report.claims.truncated, 3 - proposals.length);
  for (const proposal of proposals) assert.ok(Buffer.byteLength(proposal.candidate.body) <= 512 * 1024);
});
