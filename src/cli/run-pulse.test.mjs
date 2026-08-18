// Unit tests for scripts/telemetry/run-pulse.mjs.
//
// Run: `npm run test:unit`, or directly:
//   node --test src/cli/run-pulse.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  activityStrip,
  buildPulse,
  detectChurn,
  detectRetryStorms,
  detectStall,
  renderPulse,
  subjectOf,
} from "../../scripts/telemetry/run-pulse.mjs";

const BASE = Date.parse("2026-08-17T12:00:00.000Z");

function transition(offsetSeconds, overrides = {}) {
  return {
    kind: "kontour.flow-agents.transition",
    command: "workflow",
    verb: "evidence",
    targets: {},
    exit_code: 0,
    outcome: "ok",
    started_at: new Date(BASE + offsetSeconds * 1000).toISOString(),
    duration_ms: 500,
    ...overrides,
  };
}

const refused = (offsetSeconds, overrides = {}) =>
  transition(offsetSeconds, { outcome: "unhandled-error", exit_code: 70, ...overrides });

test("a subject is the command, verb and what it targeted", () => {
  assert.equal(
    subjectOf(transition(0, { targets: { expectation: "tests-evidence" } })),
    "workflow evidence tests-evidence",
  );
  assert.equal(subjectOf(transition(0, { command: "assignment-provider", verb: "render-claim" })), "assignment-provider render-claim");
});

test("consecutive refusals of one subject are a retry storm", () => {
  const storms = detectRetryStorms([
    refused(0, { verb: "render-claim" }),
    refused(30, { verb: "render-claim" }),
    refused(60, { verb: "render-claim" }),
  ]);
  assert.equal(storms.length, 1);
  assert.equal(storms[0].count, 3);
  assert.equal(storms[0].subject, "workflow render-claim");
  assert.equal(storms[0].severity, "warn");
});

// Refusals scattered across different subjects are ordinary discovery, not a storm.
test("refusals of different subjects are not a storm", () => {
  const storms = detectRetryStorms([
    refused(0, { verb: "render-claim" }),
    refused(30, { verb: "start" }),
    refused(60, { verb: "critique" }),
  ]);
  assert.deepEqual(storms, []);
});

test("a success breaks a storm rather than extending it", () => {
  const storms = detectRetryStorms([
    refused(0, { verb: "render-claim" }),
    refused(30, { verb: "render-claim" }),
    transition(60, { verb: "render-claim" }),
    refused(90, { verb: "render-claim" }),
  ]);
  assert.deepEqual(storms, [], "two-then-one does not reach the threshold");
});

test("re-recording something already accepted is churn", () => {
  const churn = detectChurn([
    transition(0, { verb: "critique" }),
    transition(30, { verb: "critique" }),
    transition(60, { verb: "critique" }),
  ]);
  assert.equal(churn.length, 1);
  assert.equal(churn[0].count, 2);
  assert.equal(churn[0].severity, "info");
});

test("attempts before the first success are not churn", () => {
  const churn = detectChurn([refused(0), refused(30), transition(60)]);
  assert.deepEqual(churn, []);
});

test("a stall is reported only past its threshold", () => {
  const records = [transition(0)];
  assert.equal(detectStall(records, BASE + 60_000, 8), null);
  const stall = detectStall(records, BASE + 20 * 60_000, 8);
  assert.equal(stall.kind, "stall");
  assert.equal(stall.idle_ms, 20 * 60_000);
});

test("an empty log has no stall to report", () => {
  assert.equal(detectStall([], BASE, 8), null);
});

// The strip measures activity, not wall clock. A run idle overnight would otherwise
// render as a few cells of work and a long tail of nothing, hiding its shape.
test("the strip spans activity, not the gap since the run went quiet", () => {
  const records = [transition(0), transition(600)];
  const strip = activityStrip(records, BASE + 12 * 3600 * 1000, 40);
  assert.equal(strip.to, records[1].started_at);
  assert.equal(strip.cells.filter((cell) => cell !== "idle").length >= 2, true);
  assert.ok(strip.bucket_ms <= 600_000, "buckets divide the activity window");
});

test("warnings sort ahead of informational anomalies", () => {
  const pulse = buildPulse(
    [
      transition(0, { verb: "critique" }),
      transition(30, { verb: "critique" }),
      transition(60, { verb: "critique" }),
      refused(90, { verb: "render-claim" }),
      refused(120, { verb: "render-claim" }),
      refused(150, { verb: "render-claim" }),
    ],
    { now: BASE + 200_000 },
  );
  assert.equal(pulse.anomalies[0].severity, "warn");
  assert.ok(pulse.anomalies.some((anomaly) => anomaly.kind === "churn"));
  assert.equal(pulse.totals.transitions, 6);
  assert.equal(pulse.totals.refused_or_error, 3);
  assert.equal(pulse.totals.refusal_rate, 0.5);
});

// "Nothing to report" and "nothing examined" must never look alike.
test("a flowing run says so rather than rendering an empty panel", () => {
  const pulse = buildPulse([transition(0), transition(30)], { now: BASE + 40_000 });
  assert.deepEqual(pulse.anomalies, []);
  assert.match(renderPulse(pulse), /flowing/);
});

test("a usage-error exit is not counted as a refusal", () => {
  const pulse = buildPulse([transition(0, { outcome: "usage", exit_code: 64 })], { now: BASE + 1000 });
  assert.equal(pulse.totals.refused_or_error, 0);
});

test("the rendered pulse names the pathology, not just a count", () => {
  const pulse = buildPulse(
    [refused(0, { verb: "render-claim" }), refused(30, { verb: "render-claim" }), refused(60, { verb: "render-claim" })],
    { now: BASE + 90_000 },
  );
  const rendered = renderPulse(pulse);
  assert.match(rendered, /RETRY STORM/);
  assert.match(rendered, /render-claim refused 3x in a row/);
});

test("transitions are ordered before analysis, whatever order the log holds", () => {
  const pulse = buildPulse([refused(120, { verb: "x" }), refused(0, { verb: "x" }), refused(60, { verb: "x" })], {
    now: BASE + 200_000,
  });
  const storm = pulse.anomalies.find((anomaly) => anomaly.kind === "retry-storm");
  assert.equal(storm.count, 3);
  assert.equal(storm.from, new Date(BASE).toISOString());
});

// A usage error (exit 64) is a malformed invocation, not a contract refusal. The
// headline count excludes it, so the storm detector must too — otherwise one panel
// reads "0 refused (0%)" beside "refused 3x in a row" about the same transitions.
test("repeated usage errors are not a retry storm", () => {
  const usage = (offset) => transition(offset, { outcome: "usage", exit_code: 64, verb: "bogus" });
  assert.deepEqual(detectRetryStorms([usage(0), usage(30), usage(60)]), []);
  const pulse = buildPulse([usage(0), usage(30), usage(60)], { now: BASE + 90_000 });
  assert.equal(pulse.totals.refused_or_error, 0);
  assert.deepEqual(pulse.anomalies, [], "the header and the anomalies must agree");
});

test("a usage error breaks a storm rather than extending it", () => {
  const storms = detectRetryStorms([
    refused(0, { verb: "render-claim" }),
    transition(30, { outcome: "usage", exit_code: 64, verb: "render-claim" }),
    refused(60, { verb: "render-claim" }),
  ]);
  assert.deepEqual(storms, []);
});

// Expectation ids are not globally unique — the shipped kits share one across two
// flows — so two unrelated gates must not merge into one fabricated storm.
test("the same expectation id in two flows is two subjects, not one", () => {
  const a = refused(0, { targets: { expectation: "proposal-carries-source-refs", flow: "knowledge.synthesize" } });
  const b = refused(30, { targets: { expectation: "proposal-carries-source-refs", flow: "knowledge.consolidate" } });
  assert.notEqual(subjectOf(a), subjectOf(b));
  assert.deepEqual(detectRetryStorms([a, a, b]), [], "two flows' gates do not form one storm");
});

test("a shared expectation id within one flow is still one subject", () => {
  const one = refused(0, { targets: { expectation: "tests-evidence", flow: "builder.build" } });
  assert.equal(detectRetryStorms([one, one, one]).length, 1);
});
