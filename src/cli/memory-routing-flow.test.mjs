import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadRun, runDir, startRun } from "@kontourai/flow";
import { memoryClaim } from "@kontourai/flow-agents/memory-claims";
import { buildMemoryReviewItem, deriveMemoryRunMetrics, recomputeMemoryRouting, routeMemoryChange } from "@kontourai/flow-agents/memory-routing";
import {
  MEMORY_METRICS_EVIDENCE_KIND, MEMORY_REVIEW_EVIDENCE_KIND, MEMORY_ROUTING_EVIDENCE_KIND, readMemoryMetricsEvidence, readMemoryRoutingDecisions, readMemoryRoutingEvidence,
  canonicalRunPath, readLatestMemoryMetrics, readMemoryReviewRecords, recomputeRecordedMemoryRouting, recordMemoryMetricsEvidence, recordMemoryRoutingEvidence, refreshMemoryRunMetrics, runMemoryRouting,
} from "@kontourai/flow-agents/memory-routing-flow";
import { attachEvidence } from "@kontourai/flow";
import { canonicalJson } from "@kontourai/relay";
import { buildReviewDecisionsFromSession, buildReviewSessionEvents, initialReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";
import { loadEntityProposals } from "./memory-claims-support.mjs";

// A host flow owns the gate. This probe flow is the smallest one that has one.
const HOST_FLOW = {
  id: "probe.memory-route", version: "1.0",
  steps: [{ id: "route", next: "done" }, { id: "done", next: null }],
  gates: { "route-gate": { step: "route", expects: [{ id: "bundle", kind: "trust.bundle", required: false, description: "Not required: memory routing evidence is recorded, not gated, under Flow 5.4.", bundle_claim: { claimType: "probe", subjectType: "artifact", accepted_statuses: ["trusted"] } }] } },
};

const base = {
  subject: { type: "service", id: "widget service", label: "widget service" }, claimType: "knowledge.memory-claim", property: "primary database", value: "PostgreSQL 15", speaker: "user", posture: "stated",
  source: { ref: "claude-code:s:0", locator: "chars:0-40", excerpt: "The widget service uses PostgreSQL 15.", observedAt: "2026-10-28T09:00:00.000Z" },
};
const make = overrides => memoryClaim({ ...base, ...overrides });

async function workspace(t) {
  const cwd = makeFixtureDir("memory-routing-flow-");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const definition = path.join(cwd, "host.flow.json");
  fs.writeFileSync(definition, JSON.stringify(HOST_FLOW));
  await startRun(definition, { cwd, runId: "run-1" });
  return cwd;
}

function runOf() {
  const decisions = [
    routeMemoryChange({ type: "claim", claim: make(), agreement: { passes: 2, agreeing: 2 } }),
    routeMemoryChange({ type: "claim", claim: make({ value: "PostgreSQL 16" }), current: [make()], agreement: { passes: 2, agreeing: 2 } }),
    routeMemoryChange({ type: "entity", proposal: loadEntityProposals().merge }),
  ];
  return { decisions, metrics: deriveMemoryRunMetrics({ runId: "run-1", decisions }) };
}

const where = cwd => ({ runId: "run-1", gate: "route-gate", cwd });

test("routing decisions and metrics are attached to the host's gate as Flow evidence and read back identical", async t => {
  const cwd = await workspace(t);
  const { decisions, metrics } = runOf();
  const routing = await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const metricsEntry = await recordMemoryMetricsEvidence({ ...where(cwd), metrics });
  assert.equal(routing.gate_id, "route-gate");
  assert.equal(routing.requested_kind, MEMORY_ROUTING_EVIDENCE_KIND);
  assert.equal(metricsEntry.requested_kind, MEMORY_METRICS_EVIDENCE_KIND);
  assert.equal(routing.producer, "knowledge.memory-routing");
  assert.match(routing.sha256, /^[0-9a-f]{64}$/);

  const [stored] = await readMemoryRoutingEvidence("run-1", cwd);
  assert.equal(stored.evidenceId, routing.id);
  assert.deepEqual(stored.value.decisions.map(decision => decision.outcome), ["proposed", "routed", "routed"]);
  assert.deepEqual(stored.value.decisions, JSON.parse(JSON.stringify(decisions)));
  assert.deepEqual((await readMemoryMetricsEvidence("run-1", cwd))[0].value, JSON.parse(JSON.stringify(metrics)));
});

test("recomputing from the run's own evidence reproduces every decision, across batches", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions: decisions.slice(0, 2) });
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions: decisions.slice(1) });
  assert.deepEqual((await readMemoryRoutingDecisions("run-1", cwd)).map(decision => decision.id), decisions.map(decision => decision.id), "a decision in two batches is read once");
  assert.deepEqual(await recomputeRecordedMemoryRouting("run-1", cwd), { decisions: 3, mismatches: [] });
});

test("a stored evidence file edited after the fact is refused by its digest, not read", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  const routing = await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const stored = path.join(runDir("run-1", cwd), routing.stored_path);
  const edited = fs.readFileSync(stored, "utf8").replace('"outcome":"routed"', '"outcome":"proposed"');
  assert.notEqual(edited, fs.readFileSync(stored, "utf8"), "the probe must actually edit the file");
  fs.writeFileSync(stored, edited);
  await assert.rejects(readMemoryRoutingEvidence("run-1", cwd), /no longer matches its recorded digest/);
  await assert.rejects(recomputeRecordedMemoryRouting("run-1", cwd), /no longer matches its recorded digest/);
});

test("a decision that does not follow from its own input is refused before anything is attached", async t => {
  const cwd = await workspace(t);
  const { decisions, metrics } = runOf();
  const flipped = { ...decisions[1], outcome: "proposed", reasons: [] };
  assert.equal(recomputeMemoryRouting(flipped).ok, false);
  await assert.rejects(recordMemoryRoutingEvidence({ ...where(cwd), decisions: [decisions[0], flipped] }), /does not recompute/);
  await assert.rejects(recordMemoryRoutingEvidence({ ...where(cwd), decisions: [decisions[0], decisions[0]] }), /same routing decision twice/);
  await assert.rejects(recordMemoryMetricsEvidence({ ...where(cwd), metrics: { ...metrics, runId: "another-run" } }), /different run/);
  assert.equal((await loadRun("run-1", cwd)).manifest.evidence.length, 0, "no partial evidence");
});

test("a retry after a lost reply does not double-record", async t => {
  const cwd = await workspace(t);
  const { decisions, metrics } = runOf();
  const first = await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const again = await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  assert.equal(again.id, first.id);
  const m1 = await recordMemoryMetricsEvidence({ ...where(cwd), metrics });
  assert.equal((await recordMemoryMetricsEvidence({ ...where(cwd), metrics })).id, m1.id);
  assert.equal((await loadRun("run-1", cwd)).manifest.evidence.length, 2);
});

test("new review state supersedes the earlier metrics entry on its own; the routing record is untouched", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  const routing = await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const first = (await readLatestMemoryMetrics("run-1", cwd)).evidenceId;
  await refreshMemoryRunMetrics({ ...where(cwd), ...rejection(buildMemoryReviewItem(decisions[1]), 7) });
  const stored = await readMemoryMetricsEvidence("run-1", cwd);
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map(entry => entry.superseded), [true, false]);
  assert.equal(stored[0].evidenceId, first);
  assert.equal(stored[1].value.reviewer.rejected, 1);
  assert.deepEqual((await readMemoryRoutingEvidence("run-1", cwd)).map(entry => [entry.evidenceId, entry.superseded]), [[routing.id, false]]);
});

test("figures that are not what the recorded evidence derives are refused: a stale snapshot cannot supersede the correct ones", async t => {
  const cwd = await workspace(t);
  const { decisions, metrics } = runOf();
  const stale = deriveMemoryRunMetrics({ runId: "run-1", decisions: [] });
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const live = (await readLatestMemoryMetrics("run-1", cwd)).evidenceId;
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, 3);
  await assert.rejects(recordMemoryMetricsEvidence({ ...where(cwd), metrics: stale }), /not what the evidence/, "a complete snapshot taken before the decisions were recorded");
  await assert.rejects(recordMemoryMetricsEvidence({ ...where(cwd), metrics: { ...metrics, reviewer: { ...metrics.reviewer, pending: 0 } } }), /not what the evidence/, "figures the evidence does not support");
  await assert.rejects(recordMemoryMetricsEvidence({ ...where(cwd), metrics: { runId: "run-1" } }), /not what the evidence/, "a document that is not metrics at all");
  const latest = await readLatestMemoryMetrics("run-1", cwd);
  assert.equal(latest.evidenceId, live, "the live figures are unchanged");
  assert.equal(latest.value.decisions, 3);
  assert.equal((await recordMemoryMetricsEvidence({ ...where(cwd), metrics })).id, live, "the figures it does derive are accepted, and are the entry already there");
});

test("concurrent identical recordings in one process make one entry; concurrent metrics leave one live answer", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  const entries = await Promise.all(Array.from({ length: 4 }, () => recordMemoryRoutingEvidence({ ...where(cwd), decisions })));
  assert.equal(new Set(entries.map(entry => entry.id)).size, 1, "every caller got the same entry");
  // Different review states arriving together: each is a real change to what the run derives.
  const item = buildMemoryReviewItem(decisions[1]);
  await Promise.all([3, 6, 9].map(seconds => refreshMemoryRunMetrics({ ...where(cwd), ...rejection(item, seconds) })));
  const run = await loadRun("run-1", cwd);
  const live = run.manifest.evidence.filter(entry => entry.requested_kind === MEMORY_METRICS_EVIDENCE_KIND && !entry.superseded_by);
  assert.equal(live.length, 1, "exactly one live metrics entry");
  assert.equal(run.manifest.evidence.filter(entry => entry.requested_kind === MEMORY_ROUTING_EVIDENCE_KIND).length, 1);
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).evidenceId, live[0].id);
});

const CHANGES = () => {
  const { decisions } = runOf();
  return decisions.map(decision => decision.input.type === "claim"
    ? { type: "claim", claim: decision.input.claim, current: decision.input.current, agreement: decision.input.agreement }
    : { type: "entity", proposal: loadEntityProposals().merge });
};

test("one run, end to end: decisions are recorded before anything is queued, items reach the queue once, metrics are emitted", async t => {
  const cwd = await workspace(t);
  const published = [];
  const queue = { async publish(item, key) { published.push([item.metadata.name, key]); } };
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES(), queue });
  assert.deepEqual(run.decisions.map(decision => decision.outcome), ["proposed", "routed", "routed"]);
  assert.equal(run.items.length, 1, "the routed claim");
  assert.deepEqual(run.entityProposals, [loadEntityProposals().merge], "Survey owns the entity item; the host gets the proposal itself to pass to it");
  assert.deepEqual(published, [[run.items[0].metadata.name, run.decisions[1].id]]);
  assert.deepEqual(run.published, [run.items[0].metadata.name]);
  const metrics = (await readLatestMemoryMetrics("run-1", cwd)).value;
  assert.deepEqual([metrics.decisions, metrics.claimsProposed, metrics.routed, metrics.reviewer.pending], [3, 2, 2, 2]);
  assert.equal(published.length, 1);

  // A retry changes nothing: the same evidence entries, no extra metrics entry, and the queue is told with the same key.
  const again = await runMemoryRouting({ ...where(cwd), changes: CHANGES(), queue });
  assert.equal(again.routing.id, run.routing.id);
  assert.equal(again.metrics.id, run.metrics.id);
  assert.deepEqual(published[1], published[0], "the key a queue dedupes on is stable");
  assert.equal((await loadRun("run-1", cwd)).manifest.evidence.length, 2);
});

test("a queue failure leaves the decisions recorded, so the failure is recoverable rather than lost", async t => {
  const cwd = await workspace(t);
  const queue = { async publish() { throw new Error("queue unavailable"); } };
  await assert.rejects(runMemoryRouting({ ...where(cwd), changes: CHANGES(), queue }), /queue unavailable/);
  assert.equal((await readMemoryRoutingDecisions("run-1", cwd)).length, 3);
});

test("without a queue nothing is claimed as published", async t => {
  const cwd = await workspace(t);
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  assert.deepEqual(run.published, []);
  assert.equal(run.items.length, 1);
});

test("refreshing metrics after review supersedes the earlier figures and reads the recorded decisions, not caller-supplied ones", async t => {
  const cwd = await workspace(t);
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const before = (await readLatestMemoryMetrics("run-1", cwd)).value;
  assert.equal(before.reviewer.decisions, 0);
  const second = await refreshMemoryRunMetrics({ ...where(cwd) });
  assert.equal(second.id, run.metrics.id, "nothing changed, so nothing new is recorded");
});

// --- review round: the orchestration around the evidence --------------------------------------------------------

const MORE = () => {
  const claim = make({ property: "retry budget", value: "5 attempts per request", source: { ...base.source, ref: "claude-code:s:2" } });
  return [{ type: "claim", claim, agreement: { passes: 2, agreeing: 1 } }];
};

/** A real Survey rejection of the first routed item, with its dwell: selected, then submitted `seconds` later. */
function rejection(item, seconds) {
  const session = { ...initialReviewQueueSessionState([item]), actorId: "person:reviewer", reviewedAt: "2026-11-02T10:00:00.000Z", decisionsByItemName: { [item.metadata.name]: "reject-proposed" } };
  const start = Date.parse("2026-11-02T10:00:00.000Z");
  const reviewEvents = buildReviewSessionEvents(session, "session-1").map(event => ({ ...event, spec: { ...event.spec, occurredAt: new Date(event.spec.eventType === "decision-submitted" ? start + seconds * 1000 : start).toISOString() } }));
  return { reviewDecisions: buildReviewDecisionsFromSession(session), reviewEvents };
}

test("a refresh racing a new batch never leaves metrics describing fewer decisions than are recorded", async t => {
  const cwd = await workspace(t);
  await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  await Promise.all([refreshMemoryRunMetrics({ ...where(cwd) }), runMemoryRouting({ ...where(cwd), changes: MORE() }), refreshMemoryRunMetrics({ ...where(cwd) })]);
  const recorded = (await readMemoryRoutingDecisions("run-1", cwd)).length;
  assert.equal(recorded, 4);
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, recorded);
});

test("retrying a run that already completed review does not erase the review figures", async t => {
  const cwd = await workspace(t);
  const first = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const review = rejection(first.items[0], 10);
  await refreshMemoryRunMetrics({ ...where(cwd), ...review });
  const reviewed = (await readLatestMemoryMetrics("run-1", cwd)).value;
  assert.deepEqual([reviewed.reviewer.rejected, reviewed.reviewer.defectsCaught, reviewed.reviewSeconds], [1, 1, 10]);

  const retried = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const after = (await readLatestMemoryMetrics("run-1", cwd)).value;
  assert.deepEqual(after, reviewed, "an identical retry leaves the review figures alone");
  assert.equal(retried.metrics.id, (await readLatestMemoryMetrics("run-1", cwd)).evidenceId);
  // A host that passes the review state to date gets figures that include it.
  await runMemoryRouting({ ...where(cwd), changes: MORE(), ...review });
  const withMore = (await readLatestMemoryMetrics("run-1", cwd)).value;
  assert.deepEqual([withMore.decisions, withMore.reviewer.rejected, withMore.reviewSeconds], [4, 1, 10]);
});

test("review state is recorded once: passing what is already recorded adds no evidence", async t => {
  const cwd = await workspace(t);
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const review = rejection(run.items[0], 5);
  const count = async () => (await loadRun("run-1", cwd)).manifest.evidence.filter(entry => entry.requested_kind === "memory.review-record").length;
  await refreshMemoryRunMetrics({ ...where(cwd), ...review });
  await refreshMemoryRunMetrics({ ...where(cwd), ...review });
  await runMemoryRouting({ ...where(cwd), changes: CHANGES(), ...review });
  assert.equal(await count(), 1);
  assert.deepEqual((await readMemoryReviewRecords("run-1", cwd)).decisions.length, review.reviewDecisions.length);
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [{ kind: "Something" }] }), /not a Survey ReviewDecision/);
});

test("refreshing metrics uses the review state it is given", async t => {
  const cwd = await workspace(t);
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  await refreshMemoryRunMetrics({ ...where(cwd), ...rejection(run.items[0], 25) });
  const metrics = (await readLatestMemoryMetrics("run-1", cwd)).value;
  assert.deepEqual([metrics.reviewer.decisions, metrics.reviewer.rejected, metrics.reviewer.pending, metrics.reviewSeconds, metrics.reviewSecondsPerCaughtDefect], [1, 1, 1, 25, 25]);
});

test("the latest metrics are the last live entry, even when a cross-process race left two", async t => {
  const cwd = await workspace(t);
  const { metrics } = runOf();
  const dir = fs.mkdtempSync(path.join(cwd, "raw-"));
  const rawAttach = async (body, name) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(body)); return attachEvidence("run-1", { cwd, gate: "route-gate", file, kind: MEMORY_METRICS_EVIDENCE_KIND }); };
  const a = await rawAttach({ ...metrics, decisions: 1 }, "a.json");
  const b = await rawAttach({ ...metrics, decisions: 2 }, "b.json");
  assert.equal((await readMemoryMetricsEvidence("run-1", cwd)).filter(entry => !entry.superseded).length, 2, "the race is real: two live entries");
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).evidenceId, b.id);
  assert.notEqual(a.id, b.id);
});

test("two spellings of one directory are one run: concurrent recordings through an ancestor alias make one entry", async t => {
  const cwd = await workspace(t);
  const alias = fs.realpathSync(cwd);
  if (alias === cwd) { t.skip("this temp directory has no alias (on macOS /var is /private/var)"); return; }
  const { decisions } = runOf();
  const viaBoth = i => where(i % 2 ? alias : cwd);
  const entries = await Promise.all([0, 1, 2, 3].map(i => recordMemoryRoutingEvidence({ ...viaBoth(i), decisions })));
  assert.equal(new Set(entries.map(entry => entry.id)).size, 1);
  const item = buildMemoryReviewItem(decisions[1]);
  await Promise.all([0, 1, 2, 3].map(i => refreshMemoryRunMetrics({ ...viaBoth(i), ...rejection(item, 2 + i) })));
  assert.equal((await readMemoryMetricsEvidence("run-1", cwd)).filter(entry => !entry.superseded).length, 1);
  assert.equal((await loadRun("run-1", cwd)).manifest.evidence.filter(entry => entry.requested_kind === MEMORY_ROUTING_EVIDENCE_KIND).length, 1);
});

// --- review round 3: what the evidence layer must refuse, and keep -----------------------------------------------

const reviewEvidence = async cwd => (await loadRun("run-1", cwd)).manifest.evidence.filter(entry => entry.requested_kind === MEMORY_REVIEW_EVIDENCE_KIND);

test("malformed review input is refused before anything is attached, so it cannot poison later refreshes", async t => {
  const cwd = await workspace(t);
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const good = rejection(run.items[0], 5);
  const decision = good.reviewDecisions[0], event = good.reviewEvents[0];
  const withSpec = (value, spec) => ({ ...JSON.parse(JSON.stringify(value)), spec: { ...JSON.parse(JSON.stringify(value)).spec, ...spec } });
  const refused = [
    ["a bare kind", { reviewDecisions: [{ kind: "ReviewDecision" }] }],
    ["a status Survey does not define", { reviewDecisions: [withSpec(decision, { status: "BANANA" })] }],
    ["a reviewedAt that is not a date-time", { reviewDecisions: [withSpec(decision, { reviewedAt: "nonsense" })] }],
    ["a decision with no item", { reviewDecisions: [withSpec(decision, { reviewItemName: "" })] }],
    ["an event with no session", { reviewEvents: [withSpec(event, { sessionName: undefined })] }],
    ["an event with a fractional sequence", { reviewEvents: [withSpec(event, { sequence: 1.5 })] }],
    ["an event whose time is nonsense", { reviewEvents: [withSpec(event, { occurredAt: "soon" })] }],
    ["a valid decision next to a bad one", { reviewDecisions: [decision, { kind: "ReviewDecision" }] }],
  ];
  for (const [name, review] of refused) {
    await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), ...review }), /review input/, name);
    assert.equal((await reviewEvidence(cwd)).length, 0, `${name}: nothing was attached`);
  }
  await refreshMemoryRunMetrics({ ...where(cwd) }); // an empty refresh still works afterwards
  await refreshMemoryRunMetrics({ ...where(cwd), ...good });
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.reviewer.rejected, 1);
});

test("a repeat inside one review batch is recorded once", async t => {
  const cwd = await workspace(t);
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const { reviewDecisions, reviewEvents } = rejection(run.items[0], 5);
  await refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [...reviewDecisions, ...reviewDecisions], reviewEvents: [...reviewEvents, ...reviewEvents, ...reviewEvents] });
  const [record] = await reviewEvidence(cwd);
  const stored = JSON.parse(fs.readFileSync(path.join(runDir("run-1", cwd), record.stored_path), "utf8"));
  assert.deepEqual([stored.decisions.length, stored.events.length], [reviewDecisions.length, reviewEvents.length]);
});

test("review evidence is read back only if it is this run's, in a version we know, and unedited", async t => {
  const cwd = await workspace(t);
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  await refreshMemoryRunMetrics({ ...where(cwd), ...rejection(run.items[0], 5) });
  const [record] = await reviewEvidence(cwd);
  const file = path.join(runDir("run-1", cwd), record.stored_path);
  const original = fs.readFileSync(file, "utf8");
  // The same bytes edited on disk are refused by the digest Flow recorded.
  fs.writeFileSync(file, original.replace('"runId":"run-1"', '"runId":"run-2"'));
  await assert.rejects(readMemoryReviewRecords("run-1", cwd), /no longer matches its recorded digest/);
  fs.writeFileSync(file, original);
  // A record attached as another run's, or in a version we do not know, is refused even though its digest is right.
  // (Each poisons the run's review evidence for good, so each gets its own run.)
  for (const [what, edit] of [["another run", body => ({ ...body, runId: "run-2" })], ["another version", body => ({ ...body, schema_version: "9.9" })]]) {
    const poisoned = await workspace(t);
    const tmp = path.join(poisoned, "record.json");
    fs.writeFileSync(tmp, JSON.stringify(edit(JSON.parse(original))));
    await attachEvidence("run-1", { cwd: poisoned, gate: "route-gate", file: tmp, kind: MEMORY_REVIEW_EVIDENCE_KIND });
    await assert.rejects(readMemoryReviewRecords("run-1", poisoned), /belongs to another run or an unsupported version/, what);
  }
});

test("recording routing directly keeps the metrics current: they can never describe fewer decisions than the run holds", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions: decisions.slice(0, 1) });
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, 1);
  await Promise.all([refreshMemoryRunMetrics({ ...where(cwd) }), recordMemoryRoutingEvidence({ ...where(cwd), decisions: decisions.slice(1) }), refreshMemoryRunMetrics({ ...where(cwd) })]);
  const recorded = (await readMemoryRoutingDecisions("run-1", cwd)).length;
  assert.equal(recorded, 3);
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, recorded);
  const before = (await loadRun("run-1", cwd)).manifest.evidence.length;
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions: decisions.slice(1) }); // the same batch again
  assert.equal((await loadRun("run-1", cwd)).manifest.evidence.length, before, "a repeat adds nothing, not even metrics");
});

test("a directory that does not exist yet is keyed through its nearest existing ancestor, so a later alias maps to the same chain", async t => {
  const cwd = await workspace(t);
  const alias = fs.realpathSync(cwd);
  if (alias === cwd) { t.skip("this temp directory has no alias (on macOS /var is /private/var)"); return; }
  const missing = path.join(cwd, "runs", "not-yet", "r1");
  assert.equal(canonicalRunPath(missing), path.join(alias, "runs", "not-yet", "r1"));
  assert.equal(canonicalRunPath(path.join(alias, "runs", "not-yet", "r1")), canonicalRunPath(missing));
  assert.equal(canonicalRunPath(cwd), alias);
  assert.equal(canonicalRunPath("/"), "/");
});

// --- review round 4: what is validated is what is attached ----------------------------------------------------------

test("review input is taken as plain data once: a getter that changes between reads cannot pass validation and then poison the run", async t => {
  for (const validReads of [1, 2, 3, 4, 6]) {
    const cwd = await workspace(t);
    const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
    const good = rejection(run.items[0], 5).reviewDecisions[0];
    let reads = 0;
    const evil = JSON.parse(JSON.stringify(good));
    Object.defineProperty(evil, "spec", { enumerable: true, get() { reads++; return reads <= validReads ? good.spec : null; } });
    await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [evil] }), /accessor|review input/, `valid for ${validReads} reads`);
    assert.equal((await reviewEvidence(cwd)).length, 0, "nothing was attached");
    await refreshMemoryRunMetrics({ ...where(cwd) }); // and the run still refreshes
  }
});

test("review input that JSON would change is refused, not changed: NaN, Infinity, symbols, class instances, cycles, holes, accessors", async t => {
  const cwd = await workspace(t);
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const good = rejection(run.items[0], 5).reviewDecisions[0];
  const withSpec = extra => ({ ...JSON.parse(JSON.stringify(good)), spec: { ...JSON.parse(JSON.stringify(good)).spec, ...extra } });
  const cyclic = withSpec({}); cyclic.spec.self = cyclic;
  class Odd { constructor() { this.a = 1; } }
  const sym = withSpec({}); sym.spec[Symbol("s")] = 1;
  const holey = withSpec({ list: new Array(2) });
  const refused = { "NaN": withSpec({ editedValue: NaN }), "Infinity": withSpec({ editedValue: Infinity }), "a function": withSpec({ editedValue: () => 1 }), "a bigint": withSpec({ editedValue: 1n }),
    "a class instance": withSpec({ editedValue: new Odd() }), "a Date": withSpec({ editedValue: new Date() }), "a symbol key": sym, "a cycle": cyclic, "a list with a hole": holey,
    "a Map": withSpec({ editedValue: new Map() }) };
  for (const [name, item] of Object.entries(refused)) {
    await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [item] }), /review input/, name);
  }
  assert.equal((await reviewEvidence(cwd)).length, 0);
  // Plain data with a null prototype and an undefined-valued key is fine; the undefined key is simply absent.
  const plainNull = Object.assign(Object.create(null), JSON.parse(JSON.stringify(good)), { note: undefined });
  await refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [plainNull] });
  const [stored] = (await readMemoryReviewRecords("run-1", cwd)).decisions;
  assert.equal("note" in stored, false);
  const edited = withSpec({ editedValue: { nested: [1, 2, { ok: true }], text: "x" } });
  await refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [edited] });
  assert.ok((await readMemoryReviewRecords("run-1", cwd)).decisions.some(d => d.spec.editedValue?.nested?.[2]?.ok === true), "ordinary structured data is recorded as is");
});

test("a malformed review passed to runMemoryRouting is refused before the routing is recorded, so the refusal leaves nothing behind", async t => {
  const cwd = await workspace(t);
  await assert.rejects(runMemoryRouting({ ...where(cwd), changes: CHANGES(), reviewDecisions: [{ kind: "ReviewDecision" }] }), /review input/);
  assert.equal((await loadRun("run-1", cwd)).manifest.evidence.length, 0, "no routing, no metrics");
  await assert.rejects(runMemoryRouting({ ...where(cwd), changes: CHANGES(), reviewEvents: [{ kind: "ReviewSessionEvent" }] }), /review input/);
  assert.equal((await loadRun("run-1", cwd)).manifest.evidence.length, 0);
});

test("a retry after a failure between recording the routing and recording the metrics repairs the metrics", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  // The state a crashed process leaves: the routing batch is in the run, the metrics never made it.
  const file = path.join(cwd, "crashed-batch.json");
  fs.writeFileSync(file, `${canonicalJson({ schema_version: "1.0", runId: "run-1", decisions })}\n`);
  await attachEvidence("run-1", { cwd, gate: "route-gate", file, kind: MEMORY_ROUTING_EVIDENCE_KIND });
  assert.equal(await readLatestMemoryMetrics("run-1", cwd), undefined);
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, decisions.length, "the direct writer repaired them");
  assert.equal((await loadRun("run-1", cwd)).manifest.evidence.filter(entry => entry.requested_kind === MEMORY_ROUTING_EVIDENCE_KIND).length, 1, "and did not record the batch twice");

  // The same through runMemoryRouting, starting from the same crashed state.
  const second = await workspace(t);
  const file2 = path.join(second, "crashed-batch.json");
  const changes = CHANGES();
  const redo = routeMemoryChange(changes[0]);
  fs.writeFileSync(file2, `${canonicalJson({ schema_version: "1.0", runId: "run-1", decisions: [redo] })}\n`);
  await attachEvidence("run-1", { cwd: second, gate: "route-gate", file: file2, kind: MEMORY_ROUTING_EVIDENCE_KIND });
  await runMemoryRouting({ ...where(second), changes });
  assert.equal((await readLatestMemoryMetrics("run-1", second)).value.decisions, (await readMemoryRoutingDecisions("run-1", second)).length);
});

// --- review round 5: the blocking counterexample, exactly -------------------------------------------------------------

test("plain JSON with a __proto__ key cannot pass validation through an inherited spec and then poison the run", async t => {
  const cwd = await workspace(t);
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const good = JSON.parse(JSON.stringify(rejection(run.items[0], 5).reviewDecisions[0]));
  const hostile = JSON.parse(`{"kind":"ReviewDecision","apiVersion":${JSON.stringify(good.apiVersion)},"metadata":${JSON.stringify(good.metadata)},"__proto__":{"spec":${JSON.stringify(good.spec)}}}`);
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [hostile] }), /__proto__/);
  await assert.rejects(runMemoryRouting({ ...where(cwd), changes: CHANGES(), reviewDecisions: [hostile] }), /__proto__/);
  assert.equal((await reviewEvidence(cwd)).length, 0, "nothing was attached");
  await refreshMemoryRunMetrics({ ...where(cwd) }); // the run still refreshes
  await refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [good] });
});

test("the list itself is read by index: a custom .map, holes and -0 cannot change what is recorded", async t => {
  const cwd = await workspace(t);
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const { reviewDecisions: [good] } = rejection(run.items[0], 5);
  const mapped = [good]; mapped.map = () => [{ kind: "ReviewDecision", spec: { reviewItemName: "x", status: "verified", reviewedAt: "2026-11-02T10:00:00Z" }, metadata: { name: "n" }, apiVersion: good.apiVersion, extra: NaN }];
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: mapped }), /review input/);
  await refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [good] });
  assert.equal((await readMemoryReviewRecords("run-1", cwd)).decisions.length, 1);
  const copy = JSON.parse(JSON.stringify(good));
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [{ ...copy, spec: { ...copy.spec, editedValue: -0 } }] }), /negative zero/);
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [copy, , copy] }), /review input/);
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: "not a list" }), /expected a list/);
});

// --- review round 6 ---------------------------------------------------------------------------------------------------

test("a review list whose length changes while it is read cannot silently drop a supplied decision", async t => {
  const cwd = await workspace(t);
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const { reviewDecisions } = rejection(run.items[0], 5);
  let reads = 0;
  const shrinking = new Proxy([...reviewDecisions], { get(target, key, receiver) { if (key === "length") return ++reads === 1 ? target.length : 0; return Reflect.get(target, key, receiver); } });
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: shrinking }), /review input/);
  await assert.rejects(runMemoryRouting({ ...where(cwd), changes: CHANGES(), reviewDecisions: shrinking }), /review input/);
  assert.equal((await reviewEvidence(cwd)).length, 0);
});

test("null is not an empty review list, and review events are snapshotted like decisions", async t => {
  const cwd = await workspace(t);
  const run = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const { reviewEvents } = rejection(run.items[0], 5);
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: null }), /expected a list/);
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: null }), /expected a list/);
  const event = JSON.parse(JSON.stringify(reviewEvents[0]));
  let reads = 0;
  Object.defineProperty(event, "spec", { enumerable: true, get() { reads++; return reads <= 2 ? reviewEvents[0].spec : null; } });
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: [event] }), /accessor/);
  const hostile = JSON.parse(`{"kind":"ReviewSessionEvent","__proto__":{"spec":{}}}`);
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: [hostile] }), /__proto__/);
  assert.equal((await reviewEvidence(cwd)).length, 0);
});

// --- review round 8: the request itself is read without running anything the caller defined -------------------------------------

test("a request that is a Proxy, has a getter, or lists its changes through an overridden map is refused before anything is recorded", async t => {
  const cwd = await workspace(t);
  const first = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const review = rejection(first.items[0], 10);
  const hide = new Proxy({ ...where(cwd), ...review }, { get: (target, key) => key === "reviewDecisions" ? [] : target[key] });
  await assert.rejects(refreshMemoryRunMetrics(hide), /Proxy/, "a request Proxy that answers [] for the supplied rejection");
  await assert.rejects(runMemoryRouting(hide), /Proxy/);
  const getter = { ...where(cwd), reviewEvents: review.reviewEvents };
  Object.defineProperty(getter, "reviewDecisions", { enumerable: true, get: () => [] });
  await assert.rejects(refreshMemoryRunMetrics(getter), /accessor/, "a getter on the request");
  const changes = [...CHANGES()]; changes.map = () => [];
  await assert.rejects(runMemoryRouting({ ...where(cwd), changes }), /extra keys/, "an own map on the changes list");
  await assert.rejects(recordMemoryRoutingEvidence({ ...where(cwd), decisions: new Proxy(runOf().decisions, {}) }), /Proxy/);
  await assert.rejects(recordMemoryMetricsEvidence({ ...where(cwd), metrics: new Proxy(runOf().metrics, {}) }), /Proxy/);
  assert.equal((await readMemoryReviewRecords("run-1", cwd)).decisions.length, 0, "no refused request left a review decision behind");
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.reviewer.decisions, 0);
  // The honest request still works and counts the rejection.
  await refreshMemoryRunMetrics({ ...where(cwd), ...review });
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.reviewer.rejected, 1);
});

test("decisions are copied once: a decision that answers differently the second time is refused, not recorded as the checked one", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  let reads = 0;
  const shifty = { ...decisions[0] };
  Object.defineProperty(shifty, "changeId", { enumerable: true, get: () => (++reads === 1 ? decisions[0].changeId : "someone else") });
  await assert.rejects(recordMemoryRoutingEvidence({ ...where(cwd), decisions: [shifty, decisions[1]] }), /accessor/);
  assert.deepEqual(await readMemoryRoutingDecisions("run-1", cwd), []);
});

test("each field of a run request is read without running a getter: run, gate, directory and both review lists", async t => {
  const cwd = await workspace(t);
  const first = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const review = rejection(first.items[0], 10);
  const withGetter = (base, key, value) => Object.defineProperty({ ...base }, key, { enumerable: true, get: () => value });
  for (const key of ["runId", "gate", "cwd"]) await assert.rejects(refreshMemoryRunMetrics(withGetter({ ...where(cwd) }, key, where(cwd)[key])), /accessor/, `a getter for ${key}`);
  await assert.rejects(refreshMemoryRunMetrics(withGetter({ ...where(cwd), reviewDecisions: review.reviewDecisions }, "reviewEvents", review.reviewEvents)), /accessor/, "a getter for the review events");
  await assert.rejects(refreshMemoryRunMetrics(withGetter({ ...where(cwd), reviewEvents: review.reviewEvents }, "reviewDecisions", review.reviewDecisions)), /accessor/, "a getter for the review decisions");
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), runId: "  " }), /needs a runId/);
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.reviewer.decisions, 0, "none of them recorded anything");
});

// --- review round 9 ---------------------------------------------------------------------------------------------------------

test("the entity proposal handed back is the one that was routed, even if the caller changes theirs while the evidence is written", async t => {
  const cwd = await workspace(t);
  const proposal = structuredClone(loadEntityProposals().merge);
  const original = structuredClone(proposal);
  const pending = runMemoryRouting({ ...where(cwd), changes: [{ type: "entity", proposal }] });
  proposal.spec.alternatives = []; proposal.id = "tampered";
  const run = await pending;
  assert.deepEqual(run.entityProposals, [original]);
  assert.equal(run.decisions[0].changeId, original.id);
  assert.notEqual(run.entityProposals[0], proposal, "a copy, not the caller's object");
});

test("every field of a run request is read as data, not just the run and the review lists", async t => {
  const cwd = await workspace(t);
  const withGetter = (key, value) => Object.defineProperty({ ...where(cwd), changes: CHANGES() }, key, { enumerable: true, get: () => value });
  for (const [key, value] of [["changes", CHANGES()], ["policy", {}], ["queue", { publish: async () => {} }]]) {
    await assert.rejects(runMemoryRouting(withGetter(key, value)), /accessor/, `a getter for ${key}`);
  }
  const { decisions, metrics } = runOf();
  await assert.rejects(recordMemoryRoutingEvidence(Object.defineProperty({ ...where(cwd) }, "decisions", { enumerable: true, get: () => decisions })), /accessor/, "a getter for the decisions");
  await assert.rejects(recordMemoryMetricsEvidence(Object.defineProperty({ ...where(cwd) }, "metrics", { enumerable: true, get: () => metrics })), /accessor/, "a getter for the metrics");
  await assert.rejects(runMemoryRouting({ ...where(cwd), changes: CHANGES(), policy: new Proxy({}, {}) }), /Proxy/, "a Proxy policy");
  assert.deepEqual(await readMemoryRoutingDecisions("run-1", cwd), [], "none of them recorded anything");
});

test("a stored review record is validated when read: a digest-valid record with a status Survey does not define is refused", async t => {
  const cwd = await workspace(t);
  const good = { kind: "ReviewDecision", metadata: { name: "d1" }, spec: { reviewItemName: "i1", status: "rejected", reviewedAt: "2026-11-02T10:00:00.000Z" } };
  const attach = async body => { const file = path.join(cwd, "review-record.json"); fs.writeFileSync(file, JSON.stringify(body)); return attachEvidence("run-1", { cwd, gate: "route-gate", file, kind: MEMORY_REVIEW_EVIDENCE_KIND }); };
  await attach({ schema_version: "1.0", runId: "run-1", decisions: [{ ...good, spec: { ...good.spec, status: "weird" } }], events: [] });
  await assert.rejects(readMemoryReviewRecords("run-1", cwd), /status Survey does not define/);
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd) }), /status Survey does not define/, "and metrics are not derived from it");
  // The same for a stored event (each poisons its run's review evidence, so it gets its own run).
  const other = await workspace(t);
  const file = path.join(other, "review-record.json");
  fs.writeFileSync(file, JSON.stringify({ schema_version: "1.0", runId: "run-1", decisions: [], events: [{ kind: "Something" }] }));
  await attachEvidence("run-1", { cwd: other, gate: "route-gate", file, kind: MEMORY_REVIEW_EVIDENCE_KIND });
  await assert.rejects(readMemoryReviewRecords("run-1", other), /not a Survey ReviewSessionEvent/);
});
