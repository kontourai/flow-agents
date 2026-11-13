import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadRun, runDir, startRun } from "@kontourai/flow";
import { memoryClaim } from "@kontourai/flow-agents/memory-claims";
import { buildMemoryReviewItem, deriveMemoryRunMetrics, evaluateMemoryRouting, memoryProposedCandidateId, presentMemoryClaims, recomputeMemoryRouting, routeMemoryChange } from "@kontourai/flow-agents/memory-routing";
import { buildCandidateVerification } from "@kontourai/survey";
import { createHash } from "node:crypto";
import { jsonSnapshot } from "@kontourai/flow-agents/memory-json";
import {
  MEMORY_METRICS_EVIDENCE_KIND, MEMORY_REVIEW_EVIDENCE_KIND, MEMORY_ROUTING_EVIDENCE_KIND, readMemoryMetricsEvidence, readMemoryRoutingDecisions, readMemoryRoutingEvidence,
  canonicalRunPath, memoryHistoryLimit, readLatestMemoryMetrics, readMemoryReviewRecords, recomputeRecordedMemoryRouting, recordMemoryMetricsEvidence, recordMemoryRoutingEvidence, refreshMemoryRunMetrics, runMemoryRouting, supersedeMemoryRoutingEvidence,
} from "@kontourai/flow-agents/memory-routing-flow";
import { attachEvidence } from "@kontourai/flow";
import { canonicalJson } from "@kontourai/relay";
import { buildReviewDecisionsFromSession as surveyDecisionsFromSession, buildReviewSessionEvents, initialReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";
import { loadEntityProposals } from "./memory-claims-support.mjs";

/**
 * The host that authenticated the reviewer attests `reviewerKind` on the session snapshot (Survey 8.4.0), and Survey stamps it on the
 * decisions and events it builds. The tests below are about human reviewers unless one names another kind.
 */
const buildReviewDecisionsFromSession = (session, reviewerKind = "human") => surveyDecisionsFromSession({ ...session, reviewerKind });

// A host flow owns the gate. This probe flow is the smallest one that has one.
const HOST_FLOW = {
  id: "probe.memory-route", version: "1.0",
  steps: [{ id: "route", next: "done" }, { id: "done", next: null }],
  gates: { "route-gate": { step: "route", expects: [{ id: "bundle", kind: "trust.bundle", required: false, description: "Not required: memory routing evidence is recorded, not gated, under Flow 6.0.", bundle_claim: { claimType: "probe", subjectType: "artifact", accepted_statuses: ["trusted"] } }] } },
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
function rejection(item, seconds, reviewerKind = "human") {
  const start = Date.parse("2026-11-02T10:00:00.000Z");
  // Survey stamps the decision and its submission with the same instant.
  const session = { ...initialReviewQueueSessionState([item]), actorId: "person:reviewer", reviewedAt: new Date(start + seconds * 1000).toISOString(), reviewerKind, decisionsByItemName: { [item.metadata.name]: "reject-proposed" } };
  const reviewEvents = buildReviewSessionEvents(session, "session-1").map(event => ({ ...event, spec: { ...event.spec, occurredAt: new Date(event.spec.eventType === "decision-submitted" ? start + seconds * 1000 : start).toISOString() } }));
  return { reviewDecisions: buildReviewDecisionsFromSession(session, reviewerKind), reviewEvents };
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

// --- review round 10 -------------------------------------------------------------------------------------------------------

test("a stored routing record that disagrees with its own rules is never a source of figures", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  const file = path.join(cwd, "routing-record.json");
  const flipped = { ...decisions[1], outcome: "proposed", reasons: [] };
  assert.equal(recomputeMemoryRouting(flipped).ok, false);
  fs.writeFileSync(file, JSON.stringify({ schema_version: "1.0", runId: "run-1", decisions: [decisions[0], flipped] }));
  await attachEvidence("run-1", { cwd, gate: "route-gate", file, kind: MEMORY_ROUTING_EVIDENCE_KIND });
  const derived = deriveMemoryRunMetrics({ runId: "run-1", decisions: [decisions[0], flipped] });
  await assert.rejects(recordMemoryMetricsEvidence({ ...where(cwd), metrics: derived }), /does not recompute/, "figures derived from it are refused");
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd) }), /does not recompute/);
  const report = await recomputeRecordedMemoryRouting("run-1", cwd);
  assert.equal(report.mismatches.length, 1, "while the recomputation report still names the bad decision");
  // And a record that belongs to another run, or a version we do not know.
  const other = await workspace(t);
  fs.writeFileSync(path.join(other, "r.json"), JSON.stringify({ schema_version: "9.9", runId: "run-1", decisions: [decisions[0]] }));
  await attachEvidence("run-1", { cwd: other, gate: "route-gate", file: path.join(other, "r.json"), kind: MEMORY_ROUTING_EVIDENCE_KIND });
  await assert.rejects(refreshMemoryRunMetrics({ ...where(other) }), /another run or an unsupported version/);
});

test("a stored review event must be one of Survey's event types", async t => {
  const cwd = await workspace(t);
  const event = { kind: "ReviewSessionEvent", metadata: { name: "e" }, spec: { sessionName: "s", sequence: 1, eventType: "not-a-survey-event", occurredAt: "2026-11-02T10:00:00.000Z" } };
  const file = path.join(cwd, "review-record.json");
  fs.writeFileSync(file, JSON.stringify({ schema_version: "1.0", runId: "run-1", decisions: [], events: [event] }));
  await attachEvidence("run-1", { cwd, gate: "route-gate", file, kind: MEMORY_REVIEW_EVIDENCE_KIND });
  await assert.rejects(readMemoryReviewRecords("run-1", cwd), /Survey event type/);
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: [{ ...event, spec: { ...event.spec, eventType: "also-not" } }] }), /Survey event type/, "and the same at the door");
});

test("retrying metrics that were recorded before newer review state arrived returns the entry that holds them, and writes nothing", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const before = await readLatestMemoryMetrics("run-1", cwd);
  await refreshMemoryRunMetrics({ ...where(cwd), ...rejection(buildMemoryReviewItem(decisions[1]), 4) });
  const after = await readLatestMemoryMetrics("run-1", cwd);
  assert.notEqual(after.evidenceId, before.evidenceId);
  const count = async () => (await loadRun("run-1", cwd)).manifest.evidence.filter(entry => entry.requested_kind === MEMORY_METRICS_EVIDENCE_KIND).length;
  const entries = await count();
  const retried = await recordMemoryMetricsEvidence({ ...where(cwd), metrics: before.value });
  assert.equal(retried.id, before.evidenceId, "the earlier entry is the answer to the retry");
  assert.equal(await count(), entries, "nothing was written");
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).evidenceId, after.evidenceId, "and the live figures are still the newer ones");
  await assert.rejects(recordMemoryMetricsEvidence({ ...where(cwd), metrics: { ...before.value, decisions: 99 } }), /not what the evidence/, "figures that were never recorded are still refused");
});

test("a large batch of decisions is recorded: the bound is per decision, not for the whole batch", async t => {
  const cwd = await workspace(t);
  const many = Array.from({ length: 800 }, (_, i) => routeMemoryChange({ type: "claim", claim: make({ value: `value ${i}`, source: { ...base.source, ref: `s-${i}` }, property: `p${i}` }), agreement: { passes: 2, agreeing: 2 } }));
  const entry = await recordMemoryRoutingEvidence({ ...where(cwd), decisions: many });
  assert.ok(entry.id);
  assert.equal((await readMemoryRoutingDecisions("run-1", cwd)).length, 800);
  assert.ok(JSON.stringify(many).length > 400_000, "the premise: far past what one claim may hold");
});

test("one decision larger than a single claim's bound is recorded and read back: it embeds a large value and 64 peers", async t => {
  const cwd = await workspace(t);
  const big = make({ value: { list: Array.from({ length: 19000 }, (_, i) => i) } });
  const peers = Array.from({ length: 64 }, (_, i) => make({ value: `v${i}`, source: { ...base.source, ref: `peer-${i}` } }));
  const decision = routeMemoryChange({ type: "claim", claim: big, current: peers, agreement: { passes: 2, agreeing: 2 } });
  assert.ok(JSON.stringify(decision).length > 60_000, "the premise: well over 20,000 JSON values");
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions: [decision] });
  assert.deepEqual((await readMemoryRoutingDecisions("run-1", cwd)).map(d => d.id), [decision.id]);
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, 1);
});

// --- review round 11 --------------------------------------------------------------------------------------------------------

async function twoGateWorkspace(t) {
  const cwd = makeFixtureDir("memory-routing-flow-two-");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const gate = HOST_FLOW.gates["route-gate"];
  const flow = { ...HOST_FLOW, gates: { "route-gate": gate, "other-gate": { ...gate } } };
  const definition = path.join(cwd, "host.flow.json");
  fs.writeFileSync(definition, JSON.stringify(flow));
  await startRun(definition, { cwd, runId: "run-1" });
  return cwd;
}
const rawAttach = async (cwd, gate, kind, body, name = "raw.json") => { const file = path.join(cwd, name); fs.writeFileSync(file, JSON.stringify(body)); return attachEvidence("run-1", { cwd, gate, file, kind }); };
const syntheticEvents = (from, count) => Array.from({ length: count }, (_, i) => ({ kind: "ReviewSessionEvent", apiVersion: "v1", metadata: { name: `event-${from + i}` }, spec: { sessionName: "s", sequence: from + i, eventType: "item-selected", occurredAt: "2026-11-02T10:00:00.000Z", reviewItemName: "x" } }));

test("review history accumulates across requests past a single request's list bound, and the next request still works", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  await refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: syntheticEvents(0, 10000) });
  await refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: syntheticEvents(10000, 10001) });
  assert.equal((await readMemoryReviewRecords("run-1", cwd)).events.length, 20001, "the premise: more than any one request could carry");
  await refreshMemoryRunMetrics({ ...where(cwd) });
  const run = await runMemoryRouting({ ...where(cwd), changes: MORE() });
  assert.equal(run.metrics.id, (await readLatestMemoryMetrics("run-1", cwd)).evidenceId);
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, 4, "and the new decision is in the live figures");
});

test("a request that would take a run past its history limit is refused before anything is written", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  const count = async kind => (await loadRun("run-1", cwd)).manifest.evidence.filter(entry => entry.requested_kind === kind).length;
  await assert.rejects(recordMemoryRoutingEvidence({ ...where(cwd), decisions, maxHistoryEntries: 2 }), /would hold 3 routing decisions, over its limit of 2/);
  assert.equal(await count(MEMORY_ROUTING_EVIDENCE_KIND), 0, "nothing recorded");
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions, maxHistoryEntries: 3 });
  await refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: syntheticEvents(0, 3), maxHistoryEntries: 3 });
  const before = await count(MEMORY_REVIEW_EVIDENCE_KIND);
  await refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: syntheticEvents(0, 3), maxHistoryEntries: 3 }); // what is already held is not new
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions, maxHistoryEntries: 3 });
  assert.equal(await count(MEMORY_REVIEW_EVIDENCE_KIND), before, "and sending it again records nothing");
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: syntheticEvents(3, 1), maxHistoryEntries: 3 }), /more than 3 review events/);
  await assert.rejects(runMemoryRouting({ ...where(cwd), changes: MORE(), reviewEvents: syntheticEvents(3, 1), maxHistoryEntries: 3 }), /more than 3 review events|would hold 4 routing decisions/);
  assert.equal(await count(MEMORY_REVIEW_EVIDENCE_KIND), before, "no review state recorded");
  assert.equal((await readMemoryRoutingDecisions("run-1", cwd)).length, 3, "and no decision recorded behind the refusal");
  const decision = { kind: "ReviewDecision", metadata: { name: "d" }, spec: { reviewItemName: "i", status: "rejected", reviewedAt: "2026-11-02T10:00:00.000Z" } };
  await refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [1, 2, 3].map(n => ({ ...decision, metadata: { name: `d${n}` } })), maxHistoryEntries: 3 });
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [{ ...decision, metadata: { name: "d4" } }], maxHistoryEntries: 3 }), /more than 3 review decisions/);
  for (const bad of [0, -1, 1.5, "x", 2_000_000]) await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), maxHistoryEntries: bad }), /maxHistoryEntries must be an integer/, String(bad));
});

test("a second record that reuses a decision's id with a wrong outcome is checked, not collapsed away unread", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const wrong = { ...decisions[1], outcome: "proposed", reasons: [] };
  await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-1", decisions: [wrong] });
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd) }), /does not recompute/);
  await assert.rejects(runMemoryRouting({ ...where(cwd), changes: MORE() }), /does not recompute/, "and nothing more is recorded on top of it");
  // New review state sent alongside is not recorded either: the request is refused before it writes, not after.
  const reviewCount = async () => (await loadRun("run-1", cwd)).manifest.evidence.filter(entry => entry.requested_kind === MEMORY_REVIEW_EVIDENCE_KIND).length;
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: syntheticEvents(0, 2) }), /does not recompute/);
  assert.equal(await reviewCount(), 0, "no review record was left behind a refused refresh");
  assert.equal((await readMemoryRoutingDecisions("run-1", cwd)).length, 3, "and no decision either");
  const report = await recomputeRecordedMemoryRouting("run-1", cwd);
  assert.deepEqual(report.mismatches.map(item => item.decisionId), [decisions[1].id], "the report names the bad payload even though its id was seen");
  assert.equal(report.decisions, 3);
});

test("a stored routing record of another run is refused before figures are derived", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-2", decisions: [decisions[0]] });
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd) }), /another run or an unsupported version/);
});

test("the decisions a recall reads come only from records that name this run and a known version (review 16)", async t => {
  for (const [label, envelope] of [["another run", { schema_version: "1.0", runId: "run-2" }], ["an unknown version", { schema_version: "9.9", runId: "run-1" }]]) {
    const cwd = await workspace(t);
    const { decisions } = runOf();
    const unflagged = decisions.find(decision => decision.outcome === "proposed");
    assert.ok(unflagged, "the premise: the run has an unflagged decision, the kind whose record waives the human requirement");
    await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { ...envelope, decisions: [unflagged] });
    await assert.rejects(readMemoryRoutingDecisions("run-1", cwd), /another run or an unsupported version/, label);
  }
});

test("a run with bad stored routing evidence is recovered by superseding it, and the original stays as the audit trail", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  const first = await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const bad = await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-1", decisions: [{ ...decisions[1], outcome: "proposed", reasons: [] }] });
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd) }), /does not recompute/);
  await assert.rejects(supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: ["no-such-record"], decisions }), /not live routing records/);
  await assert.rejects(supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [bad.id], decisions: [{ ...decisions[1], outcome: "proposed", reasons: [] }] }), /does not recompute/, "the replacement is held to the same rule");
  await assert.rejects(supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [], decisions }), /name the live routing records/);
  // A record of another run is bad evidence too, and is recovered the same way; a superseded one no longer blocks.
  const foreign = await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-2", decisions: [decisions[0]] }, "foreign.json");
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd) }), /does not recompute|another run/);
  const fixed = await supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [bad.id, foreign.id], decisions: [] });
  assert.ok(fixed.id);
  const stored = await readMemoryRoutingEvidence("run-1", cwd);
  assert.deepEqual(stored.map(entry => [entry.evidenceId, entry.superseded]), [[first.id, false], [bad.id, true], [foreign.id, true], [fixed.id, false]], "the bad records are still there, superseded");
  assert.deepEqual((await recomputeRecordedMemoryRouting("run-1", cwd)).mismatches, [], "the report reads the live records");
  await refreshMemoryRunMetrics({ ...where(cwd) });
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, 3);
  await runMemoryRouting({ ...where(cwd), changes: MORE() });
});

test("one gate holds a run's metrics: another gate is refused before anything is written, whatever it is asked to record", async t => {
  const cwd = await twoGateWorkspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const other = { ...where(cwd), gate: "other-gate" };
  const kinds = async () => (await loadRun("run-1", cwd)).manifest.evidence.filter(entry => entry.gate_id === "other-gate").length;
  await assert.rejects(refreshMemoryRunMetrics(other), /metrics are recorded on gate route-gate/);
  await assert.rejects(recordMemoryRoutingEvidence({ ...other, decisions: [routeMemoryChange({ type: "claim", claim: make({ property: "x" }), agreement: { passes: 2, agreeing: 2 } })] }), /metrics are recorded on gate route-gate/);
  await assert.rejects(runMemoryRouting({ ...other, changes: MORE(), reviewEvents: syntheticEvents(0, 2) }), /metrics are recorded on gate route-gate/);
  await assert.rejects(refreshMemoryRunMetrics({ ...other, reviewEvents: syntheticEvents(0, 2) }), /metrics are recorded on gate route-gate/);
  assert.equal(await kinds(), 0, "nothing at all was attached to the other gate");
  assert.equal((await readMemoryRoutingDecisions("run-1", cwd)).length, 3, "no decision was recorded behind a metrics refusal");
  assert.equal((await readMemoryReviewRecords("run-1", cwd)).events.length, 0, "and no review event");
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, 3, "so the figures still describe every decision");
  // Metrics sitting on another gate (attached out of band) are refused too, and never offered as the answer to a retry.
  const stale = deriveMemoryRunMetrics({ runId: "run-1", decisions: [] });
  await rawAttach(cwd, "other-gate", MEMORY_METRICS_EVIDENCE_KIND, stale);
  await assert.rejects(recordMemoryMetricsEvidence({ ...where(cwd), metrics: stale }), /metrics are recorded on gate other-gate/);
});

test("review state is copied per item: a long list of small items is not over a whole-list budget", async t => {
  const cwd = await workspace(t);
  const decision = n => ({ kind: "ReviewDecision", apiVersion: "v1", metadata: { name: `d${n}` }, spec: { reviewItemName: `i${n}`, status: "rejected", reviewedAt: "2026-11-02T10:00:00.000Z", candidateId: `c${n}`, note: "n" } });
  const decisionsList = Array.from({ length: 2500 }, (_, n) => decision(n));
  assert.ok(JSON.stringify(decisionsList).length / 11 > 20000 * 1, "the premise: far more than 20,000 JSON values in one list");
  await refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: decisionsList, reviewEvents: syntheticEvents(0, 2500) });
  const stored = await readMemoryReviewRecords("run-1", cwd);
  assert.deepEqual([stored.decisions.length, stored.events.length], [2500, 2500]);
});

// --- review round 12 --------------------------------------------------------------------------------------------------------

const attachedCount = async cwd => (await loadRun("run-1", cwd)).manifest.evidence.length;

test("recovery is whole or nothing: with two bad records, superseding one is refused and attaches nothing", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const wrong = { ...decisions[1], outcome: "proposed", reasons: [] };
  const badA = await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-1", decisions: [wrong] }, "a.json");
  const badB = await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-2", decisions: [decisions[0]] }, "b.json");
  const before = await attachedCount(cwd);
  await assert.rejects(supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [badA.id], decisions: [] }), /another run or an unsupported version/, "the other bad record still blocks");
  assert.equal(await attachedCount(cwd), before, "so the replacement was not attached");
  assert.deepEqual((await readMemoryRoutingEvidence("run-1", cwd)).map(entry => entry.superseded), [false, false, false]);
  await supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [badA.id, badB.id], decisions: [] });
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, 3, "and with both, the live figures are right straight away");
});

test("a recovery that already happened is replayable: the same request returns the record it made and writes nothing", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const bad = await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-1", decisions: [{ ...decisions[1], outcome: "proposed", reasons: [] }] });
  const request = { ...where(cwd), supersedes: [bad.id], decisions: [] };
  const first = await supersedeMemoryRoutingEvidence(request);
  const count = await attachedCount(cwd);
  const again = await supersedeMemoryRoutingEvidence(request);
  assert.equal(again.id, first.id);
  assert.equal(await attachedCount(cwd), count, "the lost-reply retry attached nothing");
  await assert.rejects(supersedeMemoryRoutingEvidence({ ...request, decisions: [decisions[0]] }), /not live routing records/, "a different request naming records that are no longer live is still refused");
  // A replay reports on the state as it is now: if a record has gone bad since, it is refused rather than reported as done.
  await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-1", decisions: [{ ...decisions[1], outcome: "proposed", reasons: [] }] }, "later-bad.json");
  await assert.rejects(supersedeMemoryRoutingEvidence(request), /does not recompute/);
  await assert.rejects(supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [first.id, first.id], decisions: [] }), /name the live routing records/);
  const batch = [decisions[2], decisions[2]];
  await assert.rejects(supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: ["x"], decisions: batch }), /names the same routing decision twice/);
});

test("recovery holds the history limit, and what recall reads after it is the corrected routing", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  const claim = decisions[1].input.claim;
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const wrong = { ...decisions[1], outcome: "proposed", reasons: [] };
  const bad = await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-1", decisions: [wrong] });
  const count = await attachedCount(cwd);
  await assert.rejects(supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [bad.id], decisions: [decisions[0], decisions[1]], maxHistoryEntries: 1 }), /would hold 3 routing decisions, over its limit of 1/);
  assert.equal(await attachedCount(cwd), count);
  await supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [bad.id], decisions: [] });
  const read = await readMemoryRoutingDecisions("run-1", cwd);
  assert.equal(read.find(decision => decision.id === decisions[1].id).outcome, decisions[1].outcome, "the public reader returns the live decision, not the superseded payload");
  const shown = presentMemoryClaims([claim], { routing: read }).presented[0];
  assert.equal(shown.review.routing, decisions[1].outcome === "routed" ? "routed" : "uncontested", "and recall labels the claim from it");
  assert.equal((await readMemoryRoutingEvidence("run-1", cwd)).find(entry => entry.evidenceId === bad.id).superseded, true, "the original is still there for audit");
  // A quarantine is not a block-list: recording a quarantined batch again records it again.
  const quarantined = await recordMemoryRoutingEvidence({ ...where(cwd), decisions: [wrong.outcome === "proposed" ? decisions[0] : decisions[1]] });
  assert.ok(quarantined.id);
});

test("recovery request shapes: ids must be non-empty strings, once each", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  const first = await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  for (const supersedes of [[1], [""], [first.id, first.id], [null]]) await assert.rejects(supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes, decisions: [] }), /name the live routing records/, JSON.stringify(supersedes));
});

test("a stored review record that is bad blocks every write that depends on it, before it writes", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  await rawAttach(cwd, "route-gate", MEMORY_REVIEW_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-1", decisions: [{ kind: "ReviewDecision", metadata: { name: "d" }, spec: { reviewItemName: "i", status: "weird", reviewedAt: "2026-11-02T10:00:00.000Z" } }], events: [] });
  const before = await attachedCount(cwd);
  const more = routeMemoryChange({ type: "claim", claim: make({ property: "x" }), agreement: { passes: 2, agreeing: 2 } });
  await assert.rejects(recordMemoryRoutingEvidence({ ...where(cwd), decisions: [more] }), /status Survey does not define/);
  await assert.rejects(runMemoryRouting({ ...where(cwd), changes: MORE() }), /status Survey does not define/);
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: syntheticEvents(0, 1) }), /status Survey does not define/);
  assert.equal(await attachedCount(cwd), before, "none of them wrote anything");
});

test("the deepest claim a claim may be is recorded, recovered with, and read back", async t => {
  const cwd = await workspace(t);
  let value = "leaf", depth = 0;
  const nest = n => { let v = "leaf"; for (let i = 0; i < n; i++) v = { a: v }; return v; };
  for (let n = 1; n < 40; n++) { try { jsonSnapshot(make({ value: nest(n) }), "t"); depth = n; } catch { break; } }
  value = nest(depth);
  const decision = routeMemoryChange({ type: "claim", claim: make({ value }), agreement: { passes: 2, agreeing: 2 } });
  const entry = await recordMemoryRoutingEvidence({ ...where(cwd), decisions: [decision] });
  assert.deepEqual((await readMemoryRoutingDecisions("run-1", cwd)).map(d => d.id), [decision.id]);
  const other = routeMemoryChange({ type: "claim", claim: make({ value, property: "other" }), agreement: { passes: 2, agreeing: 2 } });
  const replaced = await supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [entry.id], decisions: [other] });
  assert.deepEqual((await readMemoryRoutingDecisions("run-1", cwd)).map(d => d.id), [other.id]);
  assert.ok(replaced.id);
});

test("the history limit: its default is the most the Kit derives from, a host may lower it, and nothing else is accepted", () => {
  assert.equal(memoryHistoryLimit({}), 1_000_000);
  assert.equal(memoryHistoryLimit({ maxHistoryEntries: 7 }), 7);
  for (const bad of [0, -1, 1.5, "7", null, 1_000_001]) assert.throws(() => memoryHistoryLimit({ maxHistoryEntries: bad }), /maxHistoryEntries must be an integer/, String(bad));
});

test("a routing decision count past the stored limit is refused by name: held decisions count, repeats do not", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions, maxHistoryEntries: 3 });
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions: [decisions[0]], maxHistoryEntries: 3 });
  await assert.rejects(runMemoryRouting({ ...where(cwd), changes: MORE(), maxHistoryEntries: 3 }), /would hold 4 routing decisions, over its limit of 3/);
});

test("a recovery that changes what the run holds brings the live figures up to date in the same request", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  const first = await recordMemoryRoutingEvidence({ ...where(cwd), decisions: [decisions[0]] });
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, 1);
  await supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [first.id], decisions: [decisions[1], decisions[2]] });
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, 2, "replaced one decision with two, and the figures say so now");
  assert.deepEqual((await readMemoryRoutingDecisions("run-1", cwd)).map(d => d.id), [decisions[1].id, decisions[2].id]);
});

// --- review round 13 --------------------------------------------------------------------------------------------------------

const decisionFixture = n => ({ kind: "ReviewDecision", metadata: { name: `d${n}` }, spec: { reviewItemName: `i${n}`, status: "rejected", reviewedAt: "2026-11-02T10:00:00.000Z" } });
const bytesOfRecord = record => `${canonicalJson(record)}\n`;

test("review history already held counts against the limit on every write, whether or not the request adds review state", async t => {
  for (const kind of ["decisions", "events"]) {
    const cwd = await workspace(t);
    const { decisions } = runOf();
    await recordMemoryRoutingEvidence({ ...where(cwd), decisions: [decisions[0]] });
    await refreshMemoryRunMetrics({ ...where(cwd), ...(kind === "decisions" ? { reviewDecisions: [decisionFixture(1), decisionFixture(2)] } : { reviewEvents: syntheticEvents(0, 2) }) });
    const before = await attachedCount(cwd);
    const lowered = { maxHistoryEntries: 1 };
    await assert.rejects(recordMemoryRoutingEvidence({ ...where(cwd), decisions: [], ...lowered }), /more than 1 review/, `${kind}: routing`);
    await assert.rejects(recordMemoryMetricsEvidence({ ...where(cwd), metrics: (await readLatestMemoryMetrics("run-1", cwd)).value, ...lowered }), /more than 1 review/, `${kind}: metrics`);
    await assert.rejects(supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: ["x"], decisions: [], ...lowered }), /not live routing records|more than 1 review/, `${kind}: supersede`);
    await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), ...lowered }), /more than 1 review/, `${kind}: refresh`);
    await assert.rejects(runMemoryRouting({ ...where(cwd), changes: [], ...lowered }), /more than 1 review/, `${kind}: run`);
    assert.equal(await attachedCount(cwd), before, `${kind}: nothing written`);
  }
});

test("a hand-built decision the Kit could not have produced is not recomputable: embedded claims and verification records keep their budgets", () => {
  const rehash = decision => { decision.id = `sha256:${createHash("sha256").update(canonicalJson({ input: decision.input, policy: decision.policy })).digest("hex")}`; return decision; };
  const claim = make({ value: { list: Array.from({ length: 21_000 }, (_, i) => i) } });
  const handBuilt = rehash({ schema_version: "1.0", id: "", changeId: claim.id, changeType: "claim", outcome: "proposed", reasons: [], evaluated: [], input: { type: "claim", claim, current: [], verifications: [], agreement: { passes: 2, agreeing: 2 }, accumulation: null, baselines: [{ ref: "source", visibility: null }] }, policy: routeMemoryChange({ type: "claim", claim: make(), agreement: { passes: 2, agreeing: 2 } }).policy });
  handBuilt.evaluated = routeMemoryChange({ type: "claim", claim: make(), agreement: { passes: 2, agreeing: 2 } }).evaluated;
  Object.assign(handBuilt, evaluateMemoryRoutingFor(handBuilt));
  const check = recomputeMemoryRouting(handBuilt);
  assert.equal(check.ok, false);
  assert.match(check.mismatches.join("\n"), /embedded claim.*too large/);
  // A peer is held to the claim budget too, not only the claim being routed.
  const peerOversize = make({ value: { list: Array.from({ length: 21_000 }, (_, i) => i) }, source: { ...base.source, ref: "peer" } });
  const peerCase = routeMemoryChange({ type: "claim", claim: make({ value: "PostgreSQL 16" }), current: [make({ property: "primary database", value: "other", source: { ...base.source, ref: "peer" } })], agreement: { passes: 2, agreeing: 2 } });
  const withPeer = JSON.parse(JSON.stringify(peerCase));
  withPeer.input.current = [JSON.parse(JSON.stringify(peerOversize))];
  withPeer.input.baselines = [withPeer.input.baselines[0], { ref: peerOversize.id, visibility: peerOversize.visibility ?? null }];
  Object.assign(withPeer, evaluateMemoryRoutingFor(rehash(withPeer)));
  rehash(withPeer);
  assert.match(recomputeMemoryRouting(withPeer).mismatches.join("\n"), /embedded claim.*too large/, "an oversize peer");
  const small = make({ value: "PostgreSQL 16" });
  const ordinary = routeMemoryChange({ type: "claim", claim: small, agreement: { passes: 2, agreeing: 2 } });
  const evidence = Array.from({ length: 2_100 }, (_, i) => ({ id: `e${i}`, excerpt: "evidence", locator: "chars:0-1" }));
  const heavy = buildCandidateVerificationFor(small, evidence);
  const withHeavy = JSON.parse(JSON.stringify(ordinary));
  withHeavy.input.verifications = [heavy];
  Object.assign(withHeavy, evaluateMemoryRoutingFor(rehash(withHeavy)));
  rehash(withHeavy);
  assert.match(recomputeMemoryRouting(withHeavy).mismatches.join("\n"), /embedded verification record.*too large/);
});
function evaluateMemoryRoutingFor(decision) { return evaluateMemoryRouting(decision.input, decision.policy); }
function buildCandidateVerificationFor(claim, evidence) {
  return buildCandidateVerification({
    input: { candidateId: memoryProposedCandidateId(claim.id), value: claim.value, evidence },
    verifier: { id: "heavy", version: "1", method: "deterministic" }, verdict: { result: "supported" }, createdAt: "2026-11-01T00:00:00.000Z",
  });
}

test("everything live derives from live records only: a damaged superseded file blocks neither the live paths nor the way out", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const bad = await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-1", decisions: [{ ...decisions[1], outcome: "proposed", reasons: [] }] });
  await supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [bad.id], decisions: [] });
  const run = await loadRun("run-1", cwd);
  const file = path.join(run.dir, run.manifest.evidence.find(entry => entry.id === bad.id).stored_path);
  fs.writeFileSync(file, "damaged");
  assert.deepEqual((await readMemoryRoutingDecisions("run-1", cwd)).length, 3, "the live reader does not depend on it");
  await refreshMemoryRunMetrics({ ...where(cwd) });
  await runMemoryRouting({ ...where(cwd), changes: MORE() });
  assert.deepEqual((await recomputeRecordedMemoryRouting("run-1", cwd)).mismatches, []);
  await assert.rejects(readMemoryRoutingEvidence("run-1", cwd), /no longer matches its recorded digest/, "while the audit reader still verifies every file");
});

test("a recovery interrupted after the replacement was attached is completed by the identical request, metrics included", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions: [decisions[0]] });
  const bad = await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-1", decisions: [{ ...decisions[1], outcome: "proposed", reasons: [] }] });
  // Do the first half of a recovery by hand: the replacement is attached and supersedes the bad record; the metrics are not refreshed.
  const file = path.join(cwd, "replacement.json");
  fs.writeFileSync(file, bytesOfRecord({ schema_version: "1.0", runId: "run-1", decisions: [decisions[1]] }));
  const replacement = await attachEvidence("run-1", { cwd, gate: "route-gate", file, kind: MEMORY_ROUTING_EVIDENCE_KIND, supersede: [bad.id] });
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, 1, "the premise: the figures are stale");
  const done = await supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [bad.id], decisions: [decisions[1]] });
  assert.equal(done.id, replacement.id, "the request recognises the replacement as its own");
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).value.decisions, 2, "and brings the figures up to date");
});

test("a recovery replay is recognised by the links it made, not by its content: equal replacements for different records are different recoveries", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const badOne = await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-1", decisions: [{ ...decisions[1], outcome: "proposed", reasons: [] }] }, "one.json");
  const first = await supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [badOne.id], decisions: [] });
  const badTwo = await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-1", decisions: [{ ...decisions[2], outcome: "proposed", reasons: [] }] }, "two.json");
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd) }), /does not recompute/, "the second bad record is not repaired by the first recovery");
  const second = await supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [badTwo.id], decisions: [] });
  assert.notEqual(second.id, first.id, "a second recovery with identical content is its own record");
  assert.equal((await readMemoryRoutingEvidence("run-1", cwd)).find(entry => entry.evidenceId === badTwo.id).superseded, true);
  await refreshMemoryRunMetrics({ ...where(cwd) });
  // The documented boundary: once a replacement is itself superseded, the same request is no longer a replay.
  await supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [first.id, second.id], decisions: [] });
  await assert.rejects(supersedeMemoryRoutingEvidence({ ...where(cwd), supersedes: [badOne.id], decisions: [] }), /not live routing records/);
});

test("the history limit is read as data: a getter or a Proxy request is refused, an inherited value is not the object's own", async t => {
  const cwd = await workspace(t);
  const getter = Object.defineProperty({ ...where(cwd) }, "maxHistoryEntries", { enumerable: true, get: () => 5 });
  await assert.rejects(refreshMemoryRunMetrics(getter), /accessor/);
  await assert.rejects(refreshMemoryRunMetrics(new Proxy({ ...where(cwd), maxHistoryEntries: 5 }, {})), /Proxy/);
  assert.equal(memoryHistoryLimit(Object.create({ maxHistoryEntries: 3 })), 1_000_000, "an inherited value is ignored");
  assert.throws(() => memoryHistoryLimit(getter), /accessor/);
});

test("the recomputation report names a record that belongs to another run or an unsupported version, not only bad payloads", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  const foreign = await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "9.9", runId: "run-1", decisions: [decisions[0]] }, "v.json");
  const other = await rawAttach(cwd, "route-gate", MEMORY_ROUTING_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-2", decisions: [decisions[1]] }, "r.json");
  const report = await recomputeRecordedMemoryRouting("run-1", cwd);
  assert.deepEqual(report.mismatches.map(item => item.decisionId).sort(), [`(record ${foreign.id})`, `(record ${other.id})`].sort());
  assert.match(report.mismatches[0].mismatches[0], /another run or an unsupported version/);
});

// --- review round 14 --------------------------------------------------------------------------------------------------------

const storedFile = async (cwd, id) => { const run = await loadRun("run-1", cwd); return path.join(run.dir, run.manifest.evidence.find(entry => entry.id === id).stored_path); };

test("a claim whose optional text is not text is refused before anything is written, not after its evidence is recorded", async t => {
  const cwd = await workspace(t);
  const bad = memoryClaim({ ...base, subject: { ...base.subject, label: { toString: null, valueOf: null } }, value: "x" });
  const before = await attachedCount(cwd);
  await assert.rejects(runMemoryRouting({ ...where(cwd), changes: [{ type: "claim", claim: bad, agreement: { passes: 2, agreeing: 2 } }] }), /subject label must be text/);
  assert.equal(await attachedCount(cwd), before, "nothing was recorded");
});

test("the metrics readers open only live files, and a retry opens only the one it matches", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const first = await readLatestMemoryMetrics("run-1", cwd);
  await refreshMemoryRunMetrics({ ...where(cwd), ...rejection(buildMemoryReviewItem(decisions[1]), 4) });
  const second = await readLatestMemoryMetrics("run-1", cwd);
  await refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [decisionFixture(9)] });
  const third = await readLatestMemoryMetrics("run-1", cwd);
  assert.deepEqual(new Set([first.evidenceId, second.evidenceId, third.evidenceId]).size, 3);
  fs.writeFileSync(await storedFile(cwd, first.evidenceId), "damaged");
  assert.equal((await readLatestMemoryMetrics("run-1", cwd)).evidenceId, third.evidenceId, "the latest reader does not open the damaged old file");
  assert.equal((await recordMemoryMetricsEvidence({ ...where(cwd), metrics: second.value })).id, second.evidenceId, "a retry of other figures does not open it either");
  await assert.rejects(recordMemoryMetricsEvidence({ ...where(cwd), metrics: first.value }), /no longer matches its recorded digest/, "while the retry that is answered by the damaged file says so");
});

test("review records are read live-only too: a superseded record no longer counts and a damaged one blocks nothing", async t => {
  const cwd = await workspace(t);
  const { decisions } = runOf();
  await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  await refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: syntheticEvents(0, 3) });
  const [record] = (await loadRun("run-1", cwd)).manifest.evidence.filter(entry => entry.requested_kind === MEMORY_REVIEW_EVIDENCE_KIND);
  // Direct Flow use (the Kit's review API is append-only): replace the record with an empty one.
  const file = path.join(cwd, "empty-review.json");
  fs.writeFileSync(file, bytesOfRecord({ schema_version: "1.0", runId: "run-1", decisions: [], events: [] }));
  await attachEvidence("run-1", { cwd, gate: "route-gate", file, kind: MEMORY_REVIEW_EVIDENCE_KIND, supersede: [record.id] });
  fs.writeFileSync(await storedFile(cwd, record.id), "damaged");
  assert.equal((await readMemoryReviewRecords("run-1", cwd)).events.length, 0, "the superseded record is not read, so not counted");
  await refreshMemoryRunMetrics({ ...where(cwd) });
});

// --- routed review needs a human reviewer (owner decision 2026-11-03) -------------------------------------------------------------

test("an agent's decision on a routed item is recorded as an annotation and the item stays pending, through the evidence layer", async t => {
  const cwd = await workspace(t);
  const first = await runMemoryRouting({ ...where(cwd), changes: CHANGES() });
  const item = first.items[0];
  const agent = rejection(item, 10, "agent");
  await refreshMemoryRunMetrics({ ...where(cwd), ...agent });
  const afterAgent = (await readLatestMemoryMetrics("run-1", cwd)).value;
  assert.deepEqual([afterAgent.reviewer.rejected, afterAgent.reviewer.pending, afterAgent.reviewer.annotated, afterAgent.reviewer.defectsCaught], [0, first.decisions.filter(d => d.outcome === "routed").length, 1, 0]);
  assert.equal(afterAgent.reviewSeconds, null, "an annotation's dwell is not review time");
  // The agent's record is evidence like any other (recorded once, read back with its kind), and a human decision then stands.
  assert.equal((await readMemoryReviewRecords("run-1", cwd)).decisions[0].spec.reviewerKind, "agent");
  await refreshMemoryRunMetrics({ ...where(cwd), ...rejection(item, 20, "human") });
  const afterHuman = (await readLatestMemoryMetrics("run-1", cwd)).value;
  assert.deepEqual([afterHuman.reviewer.rejected, afterHuman.reviewer.annotated, afterHuman.reviewer.defectsCaught, afterHuman.reviewSeconds], [1, 1, 1, 20]);
  assert.equal(afterHuman.reviewer.pending, afterAgent.reviewer.pending - 1);
});

test("a stored decision's reviewer kind is validated the way Survey will: human, agent or rule, or absent", async t => {
  const cwd = await workspace(t);
  const decision = kind => ({ ...decisionFixture(1), spec: { ...decisionFixture(1).spec, ...(kind === undefined ? {} : { reviewerKind: kind }) } });
  for (const kind of ["human", "agent", "rule", undefined]) assert.doesNotThrow(() => { /* shape only; see the refresh below */ decision(kind); });
  for (const bad of ["Human", "operator", "", 1, null, ["human"]]) {
    await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [decision(bad)] }), /reviewerKind is human, agent or rule/, JSON.stringify(bad));
  }
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: [{ ...syntheticEvents(0, 1)[0], spec: { ...syntheticEvents(0, 1)[0].spec, reviewerKind: "robot" } }] }), /reviewerKind is human, agent or rule/, "an event carries the kind too");
  for (const ok of ["human", "agent", "rule", undefined]) await refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [{ ...decision(ok), metadata: { name: `d-${ok}` } }] });
  assert.equal((await readMemoryReviewRecords("run-1", cwd)).decisions.length, 4);
  // And a stored record with a bad kind is refused when read, however it got there.
  const other = await workspace(t);
  await rawAttach(other, "route-gate", MEMORY_REVIEW_EVIDENCE_KIND, { schema_version: "1.0", runId: "run-1", decisions: [decision("robot")], events: [] });
  await assert.rejects(readMemoryReviewRecords("run-1", other), /reviewerKind is human, agent or rule/);
});

test("a stored decision's inferred flag is Survey's boolean: anything else is refused, and either boolean is accepted as data", async t => {
  const cwd = await workspace(t);
  const decision = inferred => ({ ...decisionFixture(1), metadata: { name: `d-${String(inferred)}` }, spec: { ...decisionFixture(1).spec, reviewerKind: "human", reviewerKindInferred: inferred } });
  for (const bad of ["true", 1, 0, null, [], {}]) await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [decision(bad)] }), /reviewerKindInferred is true or false/, JSON.stringify(bad));
  for (const ok of [true, false]) await refreshMemoryRunMetrics({ ...where(cwd), reviewDecisions: [decision(ok)] });
  assert.equal((await readMemoryReviewRecords("run-1", cwd)).decisions.length, 2);
});

test("a stored event's reviewer kind and inferred flag are held to the same rules as a decision's (review 16)", async t => {
  const cwd = await workspace(t);
  const event = (name, extra) => ({ kind: "ReviewSessionEvent", metadata: { name }, spec: { sessionName: "s", sequence: 1, eventType: "item-selected", occurredAt: "2026-11-02T10:00:00.000Z", ...extra } });
  for (const bad of ["true", 1, 0, null, [], {}]) await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: [event("e", { reviewerKind: "agent", reviewerKindInferred: bad })] }), /reviewerKindInferred is true or false/, JSON.stringify(bad));
  await assert.rejects(refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: [event("e", { reviewerKind: "robot" })] }), /reviewerKind is human, agent or rule/);
  for (const ok of [true, false]) await refreshMemoryRunMetrics({ ...where(cwd), reviewEvents: [event(`e-${ok}`, { reviewerKind: "agent", reviewerKindInferred: ok })] });
  assert.equal((await readMemoryReviewRecords("run-1", cwd)).events.length, 2);
});
