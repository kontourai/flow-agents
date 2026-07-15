import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NarrativeGroundingError,
  entailmentIndependenceHolds,
  isAssertionProhibited,
  validateNarrativeGrounding,
} from "../../build/src/narrative/grounding-validator.js";

const NOW = "2026-07-14T15:00:00.000Z";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha8 = (bytes) => sha256(bytes).slice(0, 8);

function sourceId(stream, index, bytes) {
  if (stream === "telemetry") return `fa1:telemetry:full/session:event-${index}/${sha8(bytes)}`;
  if (stream === "file") return `fa1:file:created-${index}.json:${sha256(bytes)}`;
  return `fa1:cmdlog:grounding:line-${index + 1}/${sha8(bytes)}`;
}

function narrativeDirFor(records = []) {
  const narrativeDir = fs.mkdtempSync(path.join(os.tmpdir(), "grounding-validator-"));
  const sourcesDir = path.join(narrativeDir, "sources");
  fs.mkdirSync(sourcesDir);
  const sources = records.map(({ stream, record }, index) => {
    const bytes = Buffer.from(JSON.stringify(record));
    const digest = sha256(bytes);
    fs.writeFileSync(path.join(sourcesDir, digest), bytes);
    return {
      source_id: sourceId(stream, index, bytes),
      integrity_class: stream === "telemetry" ? "rotatable" : stream === "cmdlog" ? "append_only_unhashed" : "overwritten_in_place",
      captured_at: NOW,
      origin: { store: stream, path_class: "fixture" },
      status: "snapshotted",
      sha256: digest,
      bytes: bytes.length,
      lineage: [{ at: NOW, event: "source_snapshotted" }],
    };
  });
  fs.writeFileSync(path.join(narrativeDir, "source-manifest.json"), JSON.stringify({
    schema_version: "1.0",
    narrative_id: "grounding-unit",
    captured_at: NOW,
    compiler: { name: "grounding-unit", version: "1", policy_hash: "fixture" },
    capture_completeness: { channels: { full: "active" }, known_gaps: [] },
    sources,
  }));
  return { narrativeDir, sources };
}

function statement(overrides = {}) {
  return {
    id: "statement-1",
    class: "observed",
    proposition: "Tool read emitted event tool.result",
    source_refs: [],
    ...overrides,
  };
}

function envelope(statements = []) {
  return {
    sections: [{
      authority: "flow-agents",
      kind: "runtime-projection",
      sha256: "0".repeat(64),
      embedded: { turns: [], document_statements: statements },
    }],
  };
}

function codes(verdict) {
  assert.equal(verdict.ok, false);
  return verdict.violations.map((violation) => violation.code);
}

test("AC1: an absent frozen source citation is rejected with resolver detail", () => {
  const { narrativeDir } = narrativeDirFor();
  const missing = "fa1:cmdlog:grounding:line-1/01234567";
  const verdict = validateNarrativeGrounding(envelope([statement({ source_refs: [missing] })]), narrativeDir);
  assert.deepEqual(codes(verdict), ["unresolved_citation"]);
  assert.deepEqual(verdict.violations[0], {
    code: "unresolved_citation",
    statement_id: "statement-1",
    source_ref: missing,
    reason: "not_captured",
    detail: "source id is not present in the manifest",
  });
  assert.equal(verdict.known_gaps[0].code, "contradiction_detection_unavailable");
});

test("manifest-declared unavailable-source disclosures are not treated as content citations", () => {
  const { narrativeDir } = narrativeDirFor();
  const sourceRef = "fa1:file:missing.json:" + "0".repeat(64);
  const manifestFile = path.join(narrativeDir, "source-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.sources.push({
    source_id: sourceRef,
    integrity_class: "overwritten_in_place",
    captured_at: NOW,
    origin: { store: "file", path_class: "fixture" },
    status: "unavailable",
    unavailable_reason: "not_captured",
    lineage: [],
  });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const verdict = validateNarrativeGrounding(envelope([statement({
    class: "deterministic_derived",
    proposition: `Source ${sourceRef} was unavailable because not_captured`,
    source_refs: [sourceRef],
    rule: { id: "unavailable-source", version: "v1", inputs: [sourceRef] },
  })]), narrativeDir);
  assert.equal(verdict.ok, true);

  const falsified = validateNarrativeGrounding(envelope([statement({
    class: "deterministic_derived",
    proposition: "Gate tests-evidence was accepted",
    source_refs: [sourceRef],
    rule: { id: "unavailable-source", version: "v1", inputs: [sourceRef] },
  })]), narrativeDir);
  assert.ok(codes(falsified).includes("unresolved_citation"));
});

const materialCases = [
  {
    name: "command_failure",
    records: [{ stream: "cmdlog", record: { command: "npm test", result: "fail", exitCode: 1 } }],
  },
  {
    // #623 (review HIGH): a command failure captured via the telemetry stream (a tool.result
    // event carrying a command + non-zero exit) must be derived and coverage-enforced, exactly
    // like a cmdlog failure — otherwise a telemetry-sourced failure can be omitted undetected.
    name: "telemetry_command_failure",
    eventKind: "command_failure",
    records: [{ stream: "telemetry", record: { session_id: "session", event_type: "tool.result", tool: { name: "execute_bash", input: { command: "false" } }, exit_code: 1 } }],
  },
  {
    name: "retry_group",
    records: [
      { stream: "cmdlog", record: { command: "npm test", result: "fail", exitCode: 1 } },
      { stream: "cmdlog", record: { command: "npm test", result: "pass", exitCode: 0 } },
    ],
  },
  {
    name: "timeout",
    records: [{ stream: "telemetry", record: { session_id: "session", event_type: "tool.result", timed_out: true, tool: { name: "shell" } } }],
  },
  {
    name: "no_op_turn",
    records: [{ stream: "telemetry", record: { session_id: "session", event_type: "tool.result", tool: { name: "read" } } }],
  },
  {
    name: "file_creation",
    records: [{ stream: "file", record: { kind: "created-file", path: "created.json" } }],
  },
];

for (const fixture of materialCases) {
  test(`AC2: uncovered ${fixture.name} material event is rejected`, () => {
    const { narrativeDir } = narrativeDirFor(fixture.records);
    const verdict = validateNarrativeGrounding(envelope(), narrativeDir);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.violations.some((violation) =>
      violation.code === "uncovered_material_event" && violation.event_kind === (fixture.eventKind ?? fixture.name)));
  });
}

test("AC2: observed material events use class/proposition matchers, never invented rules", () => {
  const { narrativeDir, sources } = narrativeDirFor([
    { stream: "cmdlog", record: { command: "npm test", result: "fail", exitCode: 1 } },
    { stream: "file", record: { kind: "created-file", path: "created.json" } },
  ]);
  const verdict = validateNarrativeGrounding(envelope([
    statement({ id: "failure", proposition: "Command `npm test` was observed to fail (exit 1)", source_refs: [sources[0].source_id] }),
    statement({ id: "file", proposition: "File `created-1.json` was observed to be created", source_refs: [sources[1].source_id] }),
  ]), narrativeDir);
  assert.equal(verdict.ok, true);
});

test("AC3: deterministic rule inputs outside source_refs are rejected", () => {
  const { narrativeDir } = narrativeDirFor();
  const cited = "fa1:cmdlog:grounding:line-1/01234567";
  const other = "fa1:cmdlog:grounding:line-2/89abcdef";
  const verdict = validateNarrativeGrounding(envelope([statement({
    class: "deterministic_derived",
    source_refs: [cited],
    rule: { id: "fixture", version: "v1", inputs: [other] },
  })]), narrativeDir);
  assert.ok(codes(verdict).includes("invalid_rule_binding"));
});

test("AC3: declared dormant summarizer rule rejects a synthetic observed outcome", () => {
  const { narrativeDir } = narrativeDirFor();
  const synthetic = statement({
    id: "synthetic-summary",
    class: "summarizer_inferred",
    proposition: "Command npm test was observed to fail",
  });
  const verdict = validateNarrativeGrounding(envelope([synthetic]), narrativeDir);
  assert.ok(codes(verdict).includes("prohibited_assertion"));
  assert.equal(isAssertionProhibited("summarizer_inferred", "observed_outcome"), true);
  assert.equal(isAssertionProhibited("observed", "observed_outcome"), false);
});

test("R3: entailment validator must differ by model or configuration", () => {
  const generator = { provider: "provider-a", model: "model-a", config_hash: "same" };
  assert.equal(entailmentIndependenceHolds(generator, { ...generator }), false);
  assert.equal(entailmentIndependenceHolds(generator, { ...generator, model: "model-b" }), true);
  assert.equal(entailmentIndependenceHolds(generator, { ...generator, config_hash: "different" }), true);
});

test("AC5 seam: validator-internal resolver exceptions propagate fail-closed", () => {
  const { narrativeDir, sources } = narrativeDirFor([{ stream: "cmdlog", record: { command: "true", exitCode: 0 } }]);
  assert.throws(
    () => validateNarrativeGrounding(envelope([statement({ source_refs: [sources[0].source_id] })]), narrativeDir, {
      resolver: () => { throw new Error("injected resolver failure"); },
    }),
    /injected resolver failure/,
  );
});

test("publication error is typed and lists violation evidence", () => {
  const violation = {
    code: "uncovered_material_event",
    event_kind: "timeout",
    source_ref: "fa1:telemetry:full/session:event/01234567",
    detail: "fixture",
  };
  const error = new NarrativeGroundingError([violation]);
  assert.equal(error.code, "grounding_failed");
  assert.match(error.message, /uncovered_material_event timeout/);
});
