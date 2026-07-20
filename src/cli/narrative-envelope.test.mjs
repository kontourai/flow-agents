import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  GroundedNarrativeError,
  SourceIdParseError,
  composeGroundedNarrative,
  formatSourceId,
  parseSourceId,
  renderGroundedNarrative,
  resolveSource,
  snapshotNarrative,
  stableStringify,
  validateGroundedNarrative,
  writeEnvelope,
} from "../../build/src/index.js";

const CAPTURED_AT = "2026-07-14T15:00:00.000Z";
const COMPILED_AT = "2026-07-14T16:00:00.000Z";
const compiler = { name: "envelope-test", version: "1", policy_hash: "policy" };
const captureCompleteness = {
  channels: { full: "active" },
  known_gaps: [{ class: "mcp_non_native_tools", ref: "flow-agents#492" }],
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha8 = (bytes) => sha256(bytes).slice(0, 8);

function constructedNarrative({ missingReport = false, reportBytes: suppliedReportBytes, redactionFields = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-envelope-"));
  const narrativeDir = path.join(root, "narrative");
  const flowRoot = path.join(root, "flow");
  const sessionDir = path.join(root, "session");
  const reportBytes = suppliedReportBytes ?? Buffer.from('{\n  "run_id": "run-envelope",\n  "status": "passed",\n  "steps": [],\n  "gate_summaries": [{"gate_id":"tests-evidence","status":"passed"}]\n}\n');
  if (!missingReport) {
    fs.mkdirSync(path.join(flowRoot, "runs", "run-envelope"), { recursive: true });
    fs.writeFileSync(path.join(flowRoot, "runs", "run-envelope", "report.json"), reportBytes);
  }

  fs.mkdirSync(sessionDir, { recursive: true });
  const fixtureBundle = fs.readFileSync(path.resolve("evals/fixtures/narrative-sources/session/trust.bundle"));
  fs.writeFileSync(path.join(sessionDir, "trust.bundle"), fixtureBundle);
  const requests = [
    {
      source: parseSourceId(`fa1:flow-report:run-envelope:report/${sha8(reportBytes)}`),
      roots: { flowRoot },
    },
  ];
  if (!missingReport) {
    requests.push({
      source: parseSourceId(`fa1:surface-explanation:session/${sha8(fixtureBundle)}:claim-fixture`),
      roots: { sessionDir },
    });
  }
  const { manifest } = snapshotNarrative({
    narrativeDir,
    narrativeId: "envelope-test",
    requests,
    redactionFields,
    compiler,
    captureCompleteness,
  }, { now: () => CAPTURED_AT });
  return { root, narrativeDir, reportBytes, fixtureBundle, manifest };
}

function correlationNarrativeDir(transitions, { overlapping = false, timezoneLess = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-correlation-"));
  const narrativeDir = path.join(root, "narrative");
  const telemetryDir = path.join(root, "telemetry");
  const flowRoot = path.join(root, "flow");
  const telemetry = overlapping
    ? [
        { session_id: "session", event_id: "turn-a", event_type: "turn.user", timestamp: "2026-07-14T13:00:00.000Z", hook: { turn_id: "a" } },
        { session_id: "session", event_id: "tool-a", event_type: "tool.result", timestamp: "2026-07-14T13:00:20.000Z", hook: { turn_id: "a" }, tool: { name: "read" } },
        { session_id: "session", event_id: "turn-b", event_type: "turn.user", timestamp: "2026-07-14T13:00:05.000Z", hook: { turn_id: "b" } },
        { session_id: "session", event_id: "tool-b", event_type: "tool.result", timestamp: "2026-07-14T13:00:15.000Z", hook: { turn_id: "b" }, tool: { name: "read" } },
      ]
    : [
        { session_id: "session", event_id: "turn-a", event_type: "turn.user", timestamp: "2026-07-14T13:00:00.000Z", hook: { turn_id: "a" } },
        { session_id: "session", event_id: "tool-a", event_type: "tool.result", timestamp: "2026-07-14T13:00:20.000Z", hook: { turn_id: "a" }, tool: { name: "read" } },
      ];
  if (timezoneLess) {
    for (const record of telemetry) record.timestamp = record.timestamp.replace(/Z$/, "");
  }
  fs.mkdirSync(telemetryDir, { recursive: true });
  const telemetryLines = telemetry.map((record) => JSON.stringify(record));
  fs.writeFileSync(path.join(telemetryDir, "full.jsonl"), `${telemetryLines.join("\n")}\n`);

  const stateBytes = Buffer.from(JSON.stringify({ run_id: "run-correlation", session_id: "session", transitions }));
  const reportBytes = Buffer.from(JSON.stringify({ run_id: "run-correlation", gate_summaries: [] }));
  fs.mkdirSync(path.join(flowRoot, "runs", "run-correlation"), { recursive: true });
  fs.writeFileSync(path.join(flowRoot, "runs", "run-correlation", "state.json"), stateBytes);
  fs.writeFileSync(path.join(flowRoot, "runs", "run-correlation", "report.json"), reportBytes);
  const requests = telemetry.map((record, index) => ({
    source: parseSourceId(`fa1:telemetry:full/session:${record.event_id}/${sha8(Buffer.from(telemetryLines[index]))}`),
    roots: { telemetryDir },
  }));
  requests.push(
    { source: parseSourceId(`fa1:flow-state:run-correlation:state/${sha8(stateBytes)}`), roots: { flowRoot } },
    { source: parseSourceId(`fa1:flow-report:run-correlation:report/${sha8(reportBytes)}`), roots: { flowRoot } },
  );
  snapshotNarrative({
    narrativeDir,
    narrativeId: "correlation-test",
    requests,
    redactionFields: [],
    compiler,
    captureCompleteness,
  }, { now: () => CAPTURED_AT });
  return narrativeDir;
}

function correlationNarrative(transitions, options = {}) {
  return composeGroundedNarrative(correlationNarrativeDir(transitions, options), { compiledAt: COMPILED_AT });
}

test("new source-id streams round-trip encoded components and reject invalid locators", () => {
  const report = parseSourceId("fa1:flow-report:run-one:report/0123abcd");
  assert.equal(report.stream, "flow-report");
  assert.equal(report.scope.runId, "run-one");
  assert.equal(formatSourceId(report), "fa1:flow-report:run-one:report/0123abcd");

  const surface = parseSourceId("fa1:surface-explanation:slug-one/89abcdef:claim%2Fone");
  assert.equal(surface.stream, "surface-explanation");
  assert.deepEqual(surface.scope, { slug: "slug-one", bundleSha8: "89abcdef" });
  assert.equal(surface.locator.claimId, "claim/one");
  assert.equal(formatSourceId(surface), "fa1:surface-explanation:slug-one/89abcdef:claim%2Fone");

  for (const unsafe of [
    "fa1:flow-report:run%2Fone:report/0123abcd",
    "fa1:flow-report:run%5Cone:report/0123abcd",
    "fa1:surface-explanation:slug%2Fone/89abcdef:claim",
    "fa1:surface-explanation:slug%5Cone/89abcdef:claim",
  ]) {
    assert.throws(() => parseSourceId(unsafe), (error) => error instanceof SourceIdParseError && error.code === "invalid_scope");
  }
  assert.throws(() => formatSourceId({ ...report, scope: { runId: "run/one" } }), (error) => error instanceof SourceIdParseError && error.code === "invalid_scope");
  assert.throws(() => formatSourceId({ ...surface, scope: { ...surface.scope, slug: "slug/one" } }), (error) => error instanceof SourceIdParseError && error.code === "invalid_scope");

  assert.throws(
    () => parseSourceId("fa1:flow-report:run:state/0123abcd"),
    (error) => error instanceof SourceIdParseError && error.code === "invalid_locator",
  );
  assert.throws(
    () => parseSourceId("fa1:surface-explanation:slug/not-a-sha:claim"),
    (error) => error instanceof SourceIdParseError && error.code === "invalid_locator",
  );
});

test("snapshot capture preserves Flow bytes and freezes a stable Surface explanation", () => {
  const { narrativeDir, reportBytes, manifest } = constructedNarrative();
  const flow = manifest.sources.find((entry) => entry.source_id.includes(":flow-report:"));
  const surface = manifest.sources.find((entry) => entry.source_id.includes(":surface-explanation:"));
  assert.equal(flow.status, "snapshotted");
  assert.equal(flow.integrity_class, "path_only");
  assert.deepEqual(Buffer.from(resolveSource(narrativeDir, flow.source_id).content), reportBytes);

  assert.equal(surface.status, "snapshotted");
  assert.equal(surface.integrity_class, "path_only");
  assert.deepEqual(surface.origin.package, { name: "@kontourai/surface", version: "2.13.0" });
  const resolvedSurface = resolveSource(narrativeDir, surface.source_id);
  assert.equal(resolvedSurface.status, "resolved");
  const explanation = JSON.parse(Buffer.from(resolvedSurface.content).toString("utf8"));
  assert.equal(explanation.found, true);
  assert.equal(Buffer.from(resolvedSurface.content).toString("utf8"), stableStringify(explanation));
});

test("foreign authority redaction is all-or-nothing for nested configured keys", () => {
  const reportBytes = Buffer.from('{"run_id":"run-envelope","nested":{"secret":"AC6_FOREIGN_CANARY"},"gate_summaries":[]}\n');
  const { narrativeDir, manifest } = constructedNarrative({ reportBytes, redactionFields: ["secret"] });
  const flow = manifest.sources.find((entry) => entry.source_id.includes(":flow-report:"));
  assert.equal(flow.status, "unavailable");
  assert.equal(flow.unavailable_reason, "redacted");
  assert.deepEqual(flow.redactions, ["secret"]);
  assert.equal("sha256" in flow, false);
  const envelope = composeGroundedNarrative(narrativeDir, { compiledAt: COMPILED_AT });
  const rendered = renderGroundedNarrative(envelope);
  assert.doesNotMatch(stableStringify(envelope), /AC6_FOREIGN_CANARY/);
  assert.doesNotMatch(rendered, /AC6_FOREIGN_CANARY/);
  assert.equal(envelope.unavailable_sources.some((source) => source.source_ref === flow.source_id && source.reason === "redacted"), true);
});

test("compiler emits byte-stable grounded sections with verbatim foreign hashes", () => {
  const { narrativeDir, manifest, reportBytes } = constructedNarrative();
  const config = { compiledAt: COMPILED_AT, renderTitle: "Fixture narrative" };
  const first = composeGroundedNarrative(narrativeDir, config);
  const second = composeGroundedNarrative(narrativeDir, config);
  assert.equal(stableStringify(first), stableStringify(second));
  assert.deepEqual(validateGroundedNarrative(first), []);
  assert.deepEqual(first.capture_completeness, manifest.capture_completeness);
  assert.deepEqual(first.correlation, { turns: [], unplaced: [] });
  assert.deepEqual(first.conclusions, [
    {
      proposition: "Gate tests-evidence was passed.",
      grounding: {
        kind: "flow_gate_derivation",
        source_ref: first.sections.find((section) => section.authority === "flow").source_refs[0],
        pointer: "/gate_summaries/0",
      },
    },
    {
      proposition: "Claim claim-fixture was unknown.",
      grounding: {
        kind: "surface_explanation",
        source_ref: first.sections.find((section) => section.authority === "surface").source_refs[0],
      },
    },
  ]);
  assert.deepEqual(first.coverage, { sources: 2, embedded: 2, unavailable: 0 });

  const flow = first.sections.find((section) => section.authority === "flow");
  const surface = first.sections.find((section) => section.authority === "surface");
  const runtime = first.sections.find((section) => section.authority === "flow-agents");
  assert.equal(flow.embedded_bytes, reportBytes.toString("utf8"));
  assert.deepEqual(Buffer.from(flow.embedded_bytes, "utf8"), reportBytes);
  assert.equal(flow.sha256, sha256(reportBytes));
  const resolvedSurface = resolveSource(narrativeDir, surface.source_refs[0]);
  assert.equal(resolvedSurface.status, "resolved");
  assert.deepEqual(Buffer.from(surface.embedded_bytes, "utf8"), Buffer.from(resolvedSurface.content));
  assert.equal(surface.sha256, sha256(Buffer.from(surface.embedded_bytes, "utf8")));
  assert.equal(runtime.sha256, sha256(Buffer.from(stableStringify(runtime.embedded))));
  assert.deepEqual(first.sections.map((section) => section.authority), ["flow", "surface", "flow-agents"]);
});

test("validator rejects missing sections/provenance and unknown keys", () => {
  const { narrativeDir } = constructedNarrative();
  const valid = composeGroundedNarrative(narrativeDir, { compiledAt: COMPILED_AT });
  const missingSections = structuredClone(valid);
  delete missingSections.sections;
  assert.ok(validateGroundedNarrative(missingSections).some((issue) => issue.path === "$.sections"));
  const missingProvenance = structuredClone(valid);
  delete missingProvenance.provenance;
  assert.ok(validateGroundedNarrative(missingProvenance).some((issue) => issue.path === "$.provenance"));
  const unknown = structuredClone(valid);
  unknown.unratified = true;
  assert.ok(validateGroundedNarrative(unknown).some((issue) => issue.path === "$.unratified" && issue.message === "is not allowed"));
  const ungrounded = structuredClone(valid);
  delete ungrounded.conclusions[0].grounding;
  assert.ok(validateGroundedNarrative(ungrounded).some((issue) => issue.path === "$.conclusions[0]"));
  const nonexistentSource = structuredClone(valid);
  nonexistentSource.conclusions[0].grounding.source_ref = "fa1:flow-report:missing:report/0123abcd";
  assert.ok(validateGroundedNarrative(nonexistentSource).some((issue) => issue.path === "$.conclusions[0].grounding.source_ref"));
  const nonexistentPointer = structuredClone(valid);
  nonexistentPointer.conclusions[0].grounding.pointer = "/gate_summaries/999";
  assert.ok(validateGroundedNarrative(nonexistentPointer).some((issue) => issue.path === "$.conclusions[0].grounding.pointer"));
  const wrongAuthority = structuredClone(valid);
  wrongAuthority.conclusions[1].grounding.source_ref = valid.sections.find((section) => section.authority === "flow").source_refs[0];
  assert.ok(validateGroundedNarrative(wrongAuthority).some((issue) => issue.path === "$.conclusions[1].grounding.source_ref"));
  const existingNonGatePointer = structuredClone(valid);
  existingNonGatePointer.conclusions[0].grounding.pointer = "/run_id";
  assert.ok(validateGroundedNarrative(existingNonGatePointer).some((issue) => issue.path === "$.conclusions[0].grounding.pointer"));
  const mismatchedGateProposition = structuredClone(valid);
  mismatchedGateProposition.conclusions[0].proposition = "Gate fabricated was failed.";
  assert.ok(validateGroundedNarrative(mismatchedGateProposition).some((issue) => issue.path === "$.conclusions[0].proposition"));
  const mismatchedSurfaceProposition = structuredClone(valid);
  mismatchedSurfaceProposition.conclusions[1].proposition = "Claim claim-fixture was accepted.";
  assert.ok(validateGroundedNarrative(mismatchedSurfaceProposition).some((issue) => issue.path === "$.conclusions[1].proposition"));
});

test("flow transitions correlate only strictly inside exactly one observed turn window", () => {
  const envelope = correlationNarrative([
    { from: "planned", to: "executing", at: "2026-07-14T13:00:10.000Z" },
    { from: "executing", to: "boundary", at: "2026-07-14T13:00:00.000Z" },
    { from: "boundary", to: "unknown-time" },
  ]);
  assert.equal(envelope.correlation.turns.length, 1);
  assert.deepEqual(envelope.correlation.turns[0].placed.map(({ from, to }) => ({ from, to })), [
    { from: "planned", to: "executing" },
  ]);
  const placed = envelope.correlation.turns[0].placed[0];
  assert.equal(placed.rule.id, "flow-turn-correlation/v1");
  assert.equal(placed.rule.version, "v1");
  assert.deepEqual(placed.source_refs, [placed.rule.inputs[0]]);
  assert.equal(placed.rule.inputs.filter((sourceRef) => sourceRef.startsWith("fa1:telemetry:")).length, 2);
  assert.equal(placed.rule.inputs.some((sourceRef) => sourceRef.startsWith("fa1:flow-report:")), false);
  const tooManySourceRefs = structuredClone(envelope);
  tooManySourceRefs.correlation.turns[0].placed[0].source_refs.push(placed.rule.inputs[1]);
  assert.ok(validateGroundedNarrative(tooManySourceRefs).some((issue) => issue.message.includes("at most 1")));
  assert.deepEqual(envelope.correlation.unplaced.map(({ to, reason }) => ({ to, reason })), [
    { to: "boundary", reason: "ambiguous_window" },
    { to: "unknown-time", reason: "no_timestamp" },
  ]);
});

test("a transition inside two observed turn windows is left ambiguous", () => {
  const envelope = correlationNarrative([
    { from: "planned", to: "executing", at: "2026-07-14T13:00:10.000Z" },
  ], { overlapping: true });
  assert.equal(envelope.correlation.turns.length, 2);
  assert.ok(envelope.correlation.turns.every((turn) => turn.placed.length === 0));
  assert.equal(envelope.correlation.unplaced[0].reason, "ambiguous_window");
});

test("timezone-less correlation is deterministic across process timezones", () => {
  const narrativeDir = correlationNarrativeDir([
    { from: "planned", to: "executing", at: "2026-07-14T13:00:10.000" },
  ], { timezoneLess: true });
  const moduleHref = pathToFileURL(path.resolve("build/src/index.js")).href;
  const script = `
    const api = await import(process.argv[3]);
    process.stdout.write(api.stableStringify(api.composeGroundedNarrative(process.argv[1], { compiledAt: process.argv[2] })));
  `;
  const compile = (timezone) => execFileSync(process.execPath, ["--input-type=module", "-e", script, narrativeDir, COMPILED_AT, moduleHref], {
    env: { ...process.env, TZ: timezone },
  });
  const denver = compile("America/Denver");
  const utc = compile("UTC");
  assert.deepEqual(denver, utc);
  const envelope = JSON.parse(utc.toString("utf8"));
  assert.equal(envelope.correlation.turns.every((turn) => turn.placed.length === 0), true);
  assert.deepEqual(envelope.correlation.unplaced.map((transition) => transition.reason), ["no_timezone"]);
  assert.equal(envelope.correlation.unplaced[0].rule.inputs.filter((sourceRef) => sourceRef.startsWith("fa1:telemetry:")).length, 2);
  assert.deepEqual(validateGroundedNarrative(envelope), []);
});

test("renderer is deterministic, prints typed unavailable reasons, and never invents a canary", () => {
  const { narrativeDir } = constructedNarrative({ missingReport: true });
  const envelope = composeGroundedNarrative(narrativeDir, { compiledAt: COMPILED_AT });
  const first = renderGroundedNarrative(envelope);
  const second = renderGroundedNarrative(envelope);
  assert.equal(first, second);
  assert.match(first, /not_captured/);
  assert.doesNotMatch(stableStringify(envelope), /AC6_CANARY/);
  assert.doesNotMatch(first, /AC6_CANARY/);
});

test("writer is content-addressed/idempotent and lineage remains append-only", () => {
  const { narrativeDir } = constructedNarrative();
  const envelope = composeGroundedNarrative(narrativeDir, { compiledAt: COMPILED_AT });
  const first = writeEnvelope(narrativeDir, envelope);
  const firstBytes = fs.readFileSync(first.envelopePath);
  const second = writeEnvelope(narrativeDir, envelope);
  assert.equal(second.envelopePath, first.envelopePath);
  assert.equal(second.envelopeSha256, first.envelopeSha256);
  assert.deepEqual(fs.readFileSync(second.envelopePath), firstBytes);
  assert.equal(first.envelopeSha256, sha256(Buffer.from(stableStringify(envelope))));
  const lineage = fs.readFileSync(first.lineagePath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lineage.length, 2);
  assert.deepEqual(lineage[0], lineage[1]);
  assert.equal(lineage[0].envelope_sha256, first.envelopeSha256);
});

test("declared unavailable source is propagated while mutated blobs fail typed verification", () => {
  const unavailableFixture = constructedNarrative({ missingReport: true });
  const envelope = composeGroundedNarrative(unavailableFixture.narrativeDir, { compiledAt: COMPILED_AT });
  assert.deepEqual(envelope.unavailable_sources, [{
    source_ref: unavailableFixture.manifest.sources[0].source_id,
    reason: "not_captured",
  }]);
  assert.deepEqual(envelope.coverage, { sources: 1, embedded: 0, unavailable: 1 });
  assert.deepEqual(validateGroundedNarrative(envelope), []);

  const corruptFixture = constructedNarrative();
  const entry = corruptFixture.manifest.sources.find((source) => source.status === "snapshotted");
  fs.writeFileSync(path.join(corruptFixture.narrativeDir, "sources", entry.sha256), "mutated");
  assert.throws(
    () => composeGroundedNarrative(corruptFixture.narrativeDir, { compiledAt: COMPILED_AT }),
    (error) => error instanceof GroundedNarrativeError
      && error.code === "source_integrity_failed"
      && error.sourceId === entry.source_id,
  );
});
