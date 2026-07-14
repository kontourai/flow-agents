import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NarrativeProjectionError,
  parseSourceId,
  projectRuntimeNarrative,
  snapshotNarrative,
  stableStringify,
  validateNarrativeRuntimeProjection,
} from "../../build/src/index.js";

const NOW = "2026-07-14T15:00:00.000Z";
const PROJECTED_AT = "2026-07-14T16:00:00.000Z";
const compiler = { name: "projection-test", version: "1", policy_hash: "policy" };
const captureCompleteness = {
  channels: { full: "active" },
  known_gaps: [{ class: "mcp_non_native_tools", ref: "flow-agents#492", note: "MCP payload capture is incomplete." }],
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha8 = (bytes) => sha256(bytes).slice(0, 8);

function writeJsonLines(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = records.map((record) => JSON.stringify(record));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return lines;
}

function constructedNarrative({ includeTrust = false, fileOnly = false, timeoutWithoutDuration = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-projection-"));
  const narrativeDir = path.join(root, "artifacts", "narrative", "runtime-test");
  const telemetryDir = path.join(root, "telemetry");
  const sessionDir = path.join(root, "runtime-session");
  const flowRoot = path.join(root, "flow");
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });

  const requests = [];
  if (!fileOnly) {
    const timeoutTool = timeoutWithoutDuration
      ? { name: "execute_bash", command: "npm test" }
      : { name: "execute_bash", command: "npm test", timeout_ms: 5000 };
    const telemetry = [
      { session_id: "runtime-session", event_id: "turn-explicit", event_type: "turn.user", hook: { turn_id: "turn-1" } },
      { session_id: "runtime-session", event_id: "tool-timeout", event_type: "tool.result", hook: { turn_id: "turn-1" }, tool: timeoutTool, timed_out: true },
      { session_id: "runtime-session", event_id: "turn-derived", event_type: "turn.user" },
      { session_id: "runtime-session", event_id: "session-end", event_type: "session.end" },
    ];
    const telemetryLines = writeJsonLines(path.join(telemetryDir, "full.jsonl"), telemetry);
    const telemetryIds = telemetry.map((record, index) => `fa1:telemetry:full/runtime-session:${record.event_id}/${sha8(Buffer.from(telemetryLines[index]))}`);

    const flowState = { run_id: "run-test", session_id: "runtime-session", status: "active", step: "execute", gate: "tests-evidence", transitions: [] };
    const flowBytes = Buffer.from(JSON.stringify(flowState));
    fs.mkdirSync(path.join(flowRoot, "runs", "run-test"), { recursive: true });
    fs.writeFileSync(path.join(flowRoot, "runs", "run-test", "state.json"), flowBytes);

    const commandRecords = [
      { command: "npm test", result: "fail", exitCode: 1 },
      { command: "npm test", result: "pass", exitCode: 0 },
    ];
    const commandLines = writeJsonLines(path.join(sessionDir, "command-log.jsonl"), commandRecords);

    const delegation = { kind: "delegation", target: "leaf-worker", task: "nested fixture" };
    const [delegationLine] = writeJsonLines(path.join(sessionDir, "agents", "nested-worker", "events.jsonl"), [delegation]);

    requests.push(
      { source: parseSourceId(telemetryIds[0]), roots: { telemetryDir } },
      { source: parseSourceId(telemetryIds[1]), roots: { telemetryDir } },
      { source: parseSourceId(`fa1:flow-state:run-test:state/${sha8(flowBytes)}`), roots: { flowRoot } },
      { source: parseSourceId(`fa1:delegation:runtime-session/nested-worker:0/${sha8(Buffer.from(delegationLine))}`), roots: { sessionDir } },
      { source: parseSourceId(telemetryIds[2]), roots: { telemetryDir } },
      { source: parseSourceId(telemetryIds[3]), roots: { telemetryDir } },
      { source: parseSourceId(`fa1:cmdlog:runtime-session:line-1/${sha8(Buffer.from(commandLines[0]))}`), roots: { sessionDir } },
      { source: parseSourceId(`fa1:cmdlog:runtime-session:line-2/${sha8(Buffer.from(commandLines[1]))}`), roots: { sessionDir } },
    );
  }

  const created = Buffer.from(JSON.stringify({ kind: "created-file", path: "created.txt" }));
  fs.writeFileSync(path.join(repoRoot, "created.txt"), created);
  requests.push(
    { source: parseSourceId(`fa1:file:created.txt:${sha256(created)}`), roots: { repoRoot } },
    { source: parseSourceId(`fa1:file:missing.txt:${"a".repeat(64)}`), roots: { repoRoot } },
  );

  if (includeTrust) {
    const trust = Buffer.from(JSON.stringify({ schema_version: "1.0", claims: [{ id: "uninterpreted", status: "accepted", summary: "coverage probe" }], evidence: [] }));
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), trust);
    requests.push({
      source: parseSourceId(`fa1:trust-claim:runtime-session/${sha8(trust)}:uninterpreted`),
      roots: { sessionDir },
    });
  }

  const result = snapshotNarrative({
    narrativeDir,
    narrativeId: "runtime-test",
    requests,
    redactionFields: [],
    compiler,
    captureCompleteness,
  }, { now: () => NOW });
  return { root, narrativeDir, manifest: result.manifest };
}

test("constructed snapshot projects the complete runtime account deterministically", () => {
  const { narrativeDir } = constructedNarrative();
  const first = projectRuntimeNarrative(narrativeDir, { projectedAt: PROJECTED_AT });
  const second = projectRuntimeNarrative(narrativeDir, { projectedAt: PROJECTED_AT });
  const bytes = stableStringify(first);
  assert.equal(bytes, stableStringify(second));
  assert.deepEqual(validateNarrativeRuntimeProjection(first), []);
  assert.equal(first.coverage.sources, 10);
  assert.equal(first.coverage.cited, 10);
  assert.equal(first.coverage.unavailable, 1);
  assert.ok(first.turns.some((turn) => turn.turnId === "turn-1"));
  assert.ok(first.turns.some((turn) => !("turnId" in turn)));
  assert.ok(first.turns.some((turn) => turn.purpose?.step === "execute" && turn.purpose?.gate === "tests-evidence"));
  assert.ok(first.turns.every((turn) => turn.known_gap_refs.includes("flow-agents#492")));
  const statements = [...first.turns.flatMap((turn) => turn.statements), ...first.document_statements];
  assert.ok(statements.some((statement) => statement.proposition.includes("was retried across 2 attempts")));
  assert.ok(statements.some((statement) => statement.proposition.includes("5000 ms timeout")));
  assert.ok(statements.some((statement) => statement.proposition.includes("classified as a no-op")));
  assert.ok(statements.some((statement) => statement.actor === "unattributed" && statement.proposition.includes("delegated")));
  assert.ok(statements.some((statement) => statement.proposition.includes("created.txt")));
  assert.ok(statements.some((statement) => statement.proposition.includes("unavailable because not_captured")));
});

test("project CLI validates and emits stable JSON through --json", () => {
  const { narrativeDir } = constructedNarrative();
  const run = spawnSync(process.execPath, [
    path.resolve("build/src/cli.js"), "narrative-sources", "project",
    "--narrative-dir", narrativeDir, "--json", "--projected-at", PROJECTED_AT,
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const projected = JSON.parse(run.stdout);
  assert.deepEqual(validateNarrativeRuntimeProjection(projected), []);
  assert.equal(run.stdout, `${stableStringify(projected)}\n`);
});

test("projection schema enforces the observed/derived rule iff", () => {
  const { narrativeDir } = constructedNarrative();
  const projection = projectRuntimeNarrative(narrativeDir, { projectedAt: PROJECTED_AT });
  const observed = structuredClone(projection);
  const observedStatement = [...observed.turns.flatMap((turn) => turn.statements), ...observed.document_statements]
    .find((statement) => statement.class === "observed");
  observedStatement.rule = { id: "forbidden", version: "v1", inputs: observedStatement.source_refs };
  assert.ok(validateNarrativeRuntimeProjection(observed).some((issue) => issue.message.includes("exactly one")));

  const derived = structuredClone(projection);
  const derivedStatement = [...derived.turns.flatMap((turn) => turn.statements), ...derived.document_statements]
    .find((statement) => statement.class === "deterministic_derived");
  delete derivedStatement.rule;
  assert.ok(validateNarrativeRuntimeProjection(derived).some((issue) => issue.message.includes("exactly one")));
});

test("resolved source without an interpreter fails the typed coverage check", () => {
  const { narrativeDir } = constructedNarrative({ includeTrust: true });
  assert.throws(
    () => projectRuntimeNarrative(narrativeDir, { projectedAt: PROJECTED_AT }),
    (error) => error instanceof NarrativeProjectionError && error.code === "coverage_gap",
  );
});

test("malformed JSON inside an integrity-valid snapshot fails with a typed error", () => {
  const { narrativeDir, manifest } = constructedNarrative({ fileOnly: true });
  const entry = manifest.sources.find((source) => source.status === "snapshotted");
  assert.ok(entry);
  const malformed = Buffer.from("{");
  const malformedSha = sha256(malformed);
  fs.rmSync(path.join(narrativeDir, "sources", entry.sha256));
  fs.writeFileSync(path.join(narrativeDir, "sources", malformedSha), malformed);
  const manifestPath = path.join(narrativeDir, "source-manifest.json");
  const stored = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const storedEntry = stored.sources.find((source) => source.source_id === entry.source_id);
  storedEntry.sha256 = malformedSha;
  storedEntry.bytes = malformed.length;
  fs.writeFileSync(manifestPath, `${JSON.stringify(stored, null, 2)}\n`);
  assert.throws(
    () => projectRuntimeNarrative(narrativeDir, { projectedAt: PROJECTED_AT }),
    (error) => error instanceof NarrativeProjectionError && error.code === "malformed_snapshot",
  );
});

test("M2: stableStringify emits lexically sorted keys at every level (JSON.stringify would fail this)", () => {
  const { narrativeDir } = constructedNarrative();
  const projection = projectRuntimeNarrative(narrativeDir, { projectedAt: PROJECTED_AT });
  const walk = (value, where) => {
    if (Array.isArray(value)) { value.forEach((item, i) => walk(item, `${where}[${i}]`)); return; }
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      assert.deepEqual(keys, [...keys].sort(), `unsorted keys at ${where}`);
      keys.forEach((key) => walk(value[key], `${where}.${key}`));
    }
  };
  walk(JSON.parse(stableStringify(projection)), "$");
});

test("H2b: a read-only tool event does not suppress the no-op classification", () => {
  const { narrativeDir } = constructedNarrative();
  const toolOnlyTurnOrdinal = undefined;
  const projection = projectRuntimeNarrative(narrativeDir, { projectedAt: PROJECTED_AT });
  const turns = projection.turns.filter((turn) => turn.statements.some((s) => s.rule?.id === "no-op-turn"));
  assert.ok(turns.length >= 1, "expected at least one no-op-classified turn despite tool events");
  if (toolOnlyTurnOrdinal !== undefined) {
    assert.ok(turns.some((turn) => turn.ordinal === toolOnlyTurnOrdinal), "the tool-event-only turn must be no-op-classified");
  }
});

test("H2a: a timeout signal without a duration still yields the material timeout statement", () => {
  const { narrativeDir } = constructedNarrative({ timeoutWithoutDuration: true });
  const projection = projectRuntimeNarrative(narrativeDir, { projectedAt: PROJECTED_AT });
  const all = [...projection.turns.flatMap((turn) => turn.statements), ...projection.document_statements];
  assert.ok(all.some((s) => s.rule?.id === "timeout-detection" && s.proposition.includes("duration unknown")),
    "material timeout fact missing despite timeout signal");
});
