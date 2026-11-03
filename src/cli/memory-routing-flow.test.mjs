import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadRun, runDir, startRun } from "@kontourai/flow";
import { memoryClaim } from "@kontourai/flow-agents/memory-claims";
import { deriveMemoryRunMetrics, recomputeMemoryRouting, routeMemoryChange } from "@kontourai/flow-agents/memory-routing";
import {
  MEMORY_METRICS_EVIDENCE_KIND, MEMORY_ROUTING_EVIDENCE_KIND, readMemoryMetricsEvidence, readMemoryRoutingDecisions, readMemoryRoutingEvidence,
  recomputeRecordedMemoryRouting, recordMemoryMetricsEvidence, recordMemoryRoutingEvidence,
} from "@kontourai/flow-agents/memory-routing-flow";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

// A host flow owns the gate. This probe flow is the smallest one that has one.
const HOST_FLOW = {
  id: "probe.memory-route", version: "1.0",
  steps: [{ id: "route", next: "done" }, { id: "done", next: null }],
  gates: { "route-gate": { step: "route", expects: [{ id: "bundle", kind: "trust.bundle", required: false, description: "Not required: memory routing evidence is recorded, not gated, under Flow 5.4.", bundle_claim: { claimType: "probe", subjectType: "artifact", accepted_statuses: ["trusted"] } }] } },
};

const base = {
  subject: { type: "service", id: "widget service", label: "widget service" }, property: "primary database", value: "PostgreSQL 15", speaker: "user", posture: "stated",
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
    routeMemoryChange({ type: "entity", proposalRef: "survey-entity-review:merge-1", operation: "merge", subjects: ["Maya Chen", "M. Chen"] }),
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

test("re-emitting metrics after review supersedes the earlier entry on its own; the routing record is untouched", async t => {
  const cwd = await workspace(t);
  const { decisions, metrics } = runOf();
  const routing = await recordMemoryRoutingEvidence({ ...where(cwd), decisions });
  const first = await recordMemoryMetricsEvidence({ ...where(cwd), metrics });
  const second = await recordMemoryMetricsEvidence({ ...where(cwd), metrics: { ...metrics, reviewer: { ...metrics.reviewer, pending: 0 } } });
  const stored = await readMemoryMetricsEvidence("run-1", cwd);
  assert.deepEqual(stored.map(entry => [entry.evidenceId, entry.superseded]), [[first.id, true], [second.id, false]]);
  assert.equal(stored[1].value.reviewer.pending, 0);
  assert.deepEqual((await readMemoryRoutingEvidence("run-1", cwd)).map(entry => [entry.evidenceId, entry.superseded]), [[routing.id, false]]);
});
