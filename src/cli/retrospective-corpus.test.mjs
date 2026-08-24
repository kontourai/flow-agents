import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { TrustBundleBuilder } from "@kontourai/surface";

import { compileRetrospectiveCorpus } from "../../build/src/retrospective-corpus.js";
import {
  assertPinnedFilePrefix,
  capturePinnedDirectoryChain,
  scanPinnedJsonl,
} from "../../build/src/retrospective-observation-filesystem.js";
import {
  RUN_CORRELATION_IDENTITY_KEYS,
  createRunCorrelationEnvelope,
} from "../../build/src/run-correlation.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

function fixture() {
  const root = fs.realpathSync(makeFixtureDir("retrospective-corpus-"));
  const telemetry = path.join(root, ".kontourai", "telemetry");
  const session = path.join(root, ".kontourai", "flow-agents", "corpus-run");
  const flow = path.join(root, ".kontourai", "flow", "runs", "flow-corpus-run");
  fs.mkdirSync(telemetry, { recursive: true });
  fs.mkdirSync(session, { recursive: true });
  fs.mkdirSync(path.join(flow, "evidence"), { recursive: true });
  const correlation = createRunCorrelationEnvelope({
    correlation_id: "corpus-fixture-run",
    identities: Object.fromEntries(RUN_CORRELATION_IDENTITY_KEYS.map((key) => [
      key,
      key === "flow_run"
        ? { status: "present", value: "flow-corpus-run" }
        : { status: "unavailable", reason: `${key} unavailable in corpus fixture` },
    ])),
  });
  fs.writeFileSync(path.join(telemetry, "fixture.full.jsonl"), [
    JSON.stringify({
      event_type: "session.usage",
      event_id: "usage-1",
      timestamp: "2026-07-25T01:00:00.000Z",
      usage: {
        scope: "run",
        semantics: "delta",
        baseline_status: "present",
        model: "fixture-model",
        duration_s: 2,
        delegations: 0,
        input_tokens: 10,
        output_tokens: 2,
        estimated_cost_usd: 0,
      },
      run_correlation: correlation,
    }),
    JSON.stringify({ event_type: "turn.user", event_id: "turn-1", run_correlation: correlation }),
    JSON.stringify({
      event_type: "tool.result",
      event_id: "tool-1",
      tool: { status: "completed", duration_ms: 1, exit_code: 0 },
      run_correlation: correlation,
    }),
    JSON.stringify({ event_type: "agent.delegate", event_id: "delegate-1", run_correlation: correlation }),
    JSON.stringify({ event_type: "session.start", event_id: "legacy-no-correlation" }),
    "{\"malformed\":",
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(session, "state.json"), `${JSON.stringify({
    run_correlation: correlation,
    workflow_outcome: {
      schema_version: "1.0",
      source: "canonical_flow_projection",
      flow_status: "completed",
      process_status: "completed",
      verification_status: "PASS",
      quality_status: "not_independently_evaluated",
    },
  })}\n`);
  fs.writeFileSync(path.join(session, "workflow-outcome.json"), `${JSON.stringify({
    schema: "kontour.flow-agents.workflow-outcome",
    version: "1.0",
    kind: "terminal",
    record_id: "terminal-1",
    run_correlation: correlation,
    process_status: "completed",
    workflow_outcome: {
      schema_version: "1.0",
      source: "canonical_flow_projection",
      flow_status: "completed",
      process_status: "completed",
      verification_status: "PASS",
      quality_status: "not_independently_evaluated",
    },
  })}\n`);
  const trust = new TrustBundleBuilder({ source: "retrospective-corpus-fixture" }).build();
  const trustBytes = `${JSON.stringify(trust)}\n`;
  fs.writeFileSync(path.join(session, "trust.bundle"), trustBytes);
  const trustSha256 = createHash("sha256").update(trustBytes).digest("hex");
  fs.writeFileSync(path.join(flow, "state.json"), `${JSON.stringify({
    run_id: "flow-corpus-run",
    status: "completed",
    gate_outcomes: [{ gate_id: "verify-gate", status: "pass" }],
    transitions: [{ from_step: "verify", to_step: null, status: "allowed" }],
  })}\n`);
  fs.writeFileSync(path.join(flow, "evidence", "manifest.json"), `${JSON.stringify({
    run_id: "flow-corpus-run",
    evidence: [{
      kind: "trust.bundle",
      sha256: trustSha256,
      bundle: trust,
      analytics: { run_correlation: correlation },
    }],
  })}\n`);
  fs.writeFileSync(path.join(telemetry, "fixture.economics.jsonl"), `${JSON.stringify({
    schema: "kontour.console.economics",
    version: "0.2",
    run_id: correlation.correlation_id,
    run_correlation: correlation,
    observation_semantics: "snapshot",
    producer_authority: "fixture_input",
    at: "2026-07-25T01:00:00.000Z",
    model: "fixture-model",
    cost: { input_tokens: 10, output_tokens: 2, estimated_cost_usd: 0 },
    time: { wall_clock_s: 2 },
    delegations: [],
  })}\n`);
  return { root, correlation };
}

test("configured corpus discovers all source kinds while keeping legacy coverage explicit", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = compileRetrospectiveCorpus([root]);
  const repeated = compileRetrospectiveCorpus([root]);

  assert.deepEqual(repeated, first);
  assert.equal(first.report.measurement.configured_roots, 1);
  assert.equal(first.report.measurement.source_files, 7);
  assert.equal(first.report.measurement.correlation_ids, 1);
  assert.equal(first.report.measurement.observations_compiled, 1);
  assert.equal(first.report.measurement.partial_observations, 1);
  assert.equal(first.report.measurement.records_without_present_correlation, 3);
  assert.equal(first.report.measurement.malformed_records, 1);
  assert.equal(first.report.interpretation.causal_effect, "NOT_VERIFIED");
  assert.equal(first.report.interpretation.quality_effect, "NOT_VERIFIED");
  assert.equal(first.manifests[0].observation.quality.status, "NOT_VERIFIED");
  assert.equal(first.manifests[0].observation.completeness.status, "partial");
  assert.deepEqual(first.manifests[0].observation.completeness.missing_dimensions, []);
  assert.deepEqual(first.report.runs[0].missing_sources, []);

  const output = JSON.stringify(first);
  assert.equal(output.includes(root), false);
  assert.equal(output.includes("legacy-no-correlation"), false);
  assert.equal(output.includes("unavailable in corpus fixture"), false);
});

test("correlations spanning configured roots remain ambiguous without path or time inference", (t) => {
  const left = fixture();
  const right = fixture();
  t.after(() => {
    fs.rmSync(left.root, { recursive: true, force: true });
    fs.rmSync(right.root, { recursive: true, force: true });
  });
  fs.rmSync(path.join(left.root, ".kontourai", "flow-agents"), { recursive: true, force: true });
  fs.rmSync(path.join(right.root, ".kontourai", "telemetry"), { recursive: true, force: true });

  const result = compileRetrospectiveCorpus([left.root, right.root]);
  assert.equal(result.report.measurement.correlation_ids, 1);
  assert.equal(result.report.measurement.observations_compiled, 0);
  assert.equal(result.report.measurement.ambiguous_runs, 1);
  assert.equal(result.report.runs[0].status, "ambiguous");
});

test("colliding secondary sources use a bounded ambiguity witness", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 100; index += 1) {
    const duplicate = path.join(root, ".kontourai", "flow", "runs", `duplicate-${index}`);
    fs.mkdirSync(duplicate, { recursive: true });
    fs.writeFileSync(path.join(duplicate, "state.json"), `${JSON.stringify({
      run_id: "flow-corpus-run",
      status: "completed",
      gate_outcomes: [],
      transitions: [],
    })}\n`);
  }

  const result = compileRetrospectiveCorpus([root]);
  assert.equal(result.report.measurement.correlation_ids, 1);
  assert.equal(result.report.measurement.ambiguous_runs, 1);
  assert.equal(result.report.measurement.observations_compiled, 0);
  assert.equal(result.report.runs[0].status, "ambiguous");
});

test("corpus compilation streams telemetry beyond the legacy whole-file limit", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const telemetry = path.join(root, ".kontourai", "telemetry", "fixture.full.jsonl");
  const unrelated = `${JSON.stringify({
    event_type: "session.start",
    event_id: "unrelated",
    padding: "x".repeat(1024),
  })}\n`;
  fs.appendFileSync(telemetry, unrelated.repeat(17_000));

  const result = compileRetrospectiveCorpus([root]);
  assert.equal(fs.statSync(telemetry).size > 16 * 1024 * 1024, true);
  assert.equal(result.report.measurement.observations_compiled, 1, JSON.stringify(result.report.runs));
  assert.equal(result.report.measurement.records_without_present_correlation, 17_003);
  assert.equal(JSON.stringify(result).includes("x".repeat(100)), false);
});

test("one shared telemetry source compiles many correlations from one retained snapshot", (t) => {
  const root = fs.realpathSync(makeFixtureDir("corpus-many-runs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const telemetry = path.join(root, ".kontourai", "telemetry");
  fs.mkdirSync(telemetry, { recursive: true });
  const records = [];
  for (let index = 0; index < 500; index += 1) {
    const correlation = createRunCorrelationEnvelope({
      correlation_id: `many-runs-${index}`,
      identities: Object.fromEntries(RUN_CORRELATION_IDENTITY_KEYS.map((key) => [
        key,
        { status: "unavailable", reason: `${key} unavailable in many-runs fixture` },
      ])),
    });
    records.push({
      event_type: "session.usage",
      event_id: `usage-${index}`,
      timestamp: "2026-07-25T01:00:00.000Z",
      usage: {
        scope: "run",
        semantics: "delta",
        baseline_status: "present",
        model: "fixture-model",
        duration_s: 1,
        delegations: 0,
        input_tokens: 1,
        output_tokens: 1,
        estimated_cost_usd: 0,
      },
      run_correlation: correlation,
    });
    records.push({ event_type: "turn.user", event_id: `turn-${index}`, run_correlation: correlation });
  }
  fs.writeFileSync(path.join(telemetry, "many.full.jsonl"), `${records.map(JSON.stringify).join("\n")}\n{"broken":\n`);

  const result = compileRetrospectiveCorpus([root]);
  assert.equal(result.report.measurement.correlation_ids, 500);
  assert.equal(result.report.measurement.observations_compiled, 500);
  assert.equal(result.report.measurement.malformed_records, 1);
  assert.equal(result.report.measurement.compile_failures, 0);
  assert.equal(result.manifests.every((entry) => entry.observation.activity.turn_count === 1), true);
  assert.equal(result.manifests.every((entry) => entry.observation.diagnostics.length === 0), true);
  assert.equal(result.manifests.every((entry) => entry.observation.source_refs[0].malformed_records === 1), true);
});

test("invalid correlations and oversized lines are quarantined without blocking valid runs", (t) => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const telemetry = path.join(root, ".kontourai", "telemetry", "fixture.full.jsonl");
  const incomplete = {
    event_type: "session.start",
    event_id: "explicitly-incomplete",
    run_correlation: {
      status: "incomplete",
      reason: "runtime adapter did not expose a stable session identity",
    },
  };
  fs.appendFileSync(telemetry, [
    JSON.stringify(incomplete),
    JSON.stringify({ event_type: "session.start", event_id: "invalid", run_correlation: {} }),
    JSON.stringify({ event_type: "session.start", padding: "x".repeat(3 * 1024 * 1024) }),
  ].join("\n") + "\n");

  const result = compileRetrospectiveCorpus([root]);
  assert.equal(result.report.measurement.observations_compiled, 1, JSON.stringify(result.report.runs));
  assert.equal(result.report.measurement.invalid_records, 1);
  assert.equal(result.report.measurement.malformed_records, 2);
  assert.equal(result.report.measurement.records_without_present_correlation, 4);
  assert.equal(result.report.measurement.compile_failures, 0);
});

test("UTF-8 split across scanner chunks preserves one exact envelope", (t) => {
  const root = fs.realpathSync(makeFixtureDir("corpus-utf8-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const telemetry = path.join(root, ".kontourai", "telemetry");
  fs.mkdirSync(telemetry, { recursive: true });
  const correlation = createRunCorrelationEnvelope({
    correlation_id: "utf8-corpus-run",
    identities: Object.fromEntries(RUN_CORRELATION_IDENTITY_KEYS.map((key) => [
      key,
      { status: "unavailable", reason: `${key} unavailable \u{1F642}` },
    ])),
  });
  const usage = {
    event_type: "session.usage",
    event_id: "utf8-usage",
    timestamp: "2026-07-25T01:00:00.000Z",
    usage: {
      scope: "run",
      semantics: "delta",
      baseline_status: "present",
      model: "fixture-model",
      duration_s: 1,
      delegations: 0,
      input_tokens: 1,
      output_tokens: 1,
      estimated_cost_usd: 0,
    },
    padding: "",
    run_correlation: correlation,
  };
  const initial = JSON.stringify(usage);
  const emojiOffset = Buffer.byteLength(initial.slice(0, initial.indexOf("\u{1F642}")), "utf8");
  usage.padding = "x".repeat((65_535 - emojiOffset + 65_536) % 65_536);
  fs.writeFileSync(path.join(telemetry, "utf8.full.jsonl"), [
    JSON.stringify(usage),
    JSON.stringify({ event_type: "turn.user", event_id: "utf8-turn", run_correlation: correlation }),
  ].join("\n") + "\n");

  const result = compileRetrospectiveCorpus([root]);
  assert.equal(result.report.measurement.correlation_ids, 1);
  assert.equal(result.report.measurement.ambiguous_runs, 0);
  assert.equal(result.report.measurement.observations_compiled, 1);
});

test("non-JSONL producer files quarantine invalid UTF-8", (t) => {
  const root = fs.realpathSync(makeFixtureDir("corpus-json-utf8-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = path.join(root, ".kontourai", "flow-agents", "invalid-utf8");
  fs.mkdirSync(session, { recursive: true });
  const bytes = Buffer.from('{"run_correlation":{"status":"incomplete","reason":"invalid x byte"}}\n');
  bytes[bytes.indexOf("x")] = 0xff;
  fs.writeFileSync(path.join(session, "state.json"), bytes);

  const result = compileRetrospectiveCorpus([root]);
  assert.equal(result.report.measurement.source_files, 1);
  assert.equal(result.report.measurement.malformed_records, 1);
  assert.equal(result.report.measurement.invalid_records, 0);
  assert.equal(result.report.measurement.correlation_ids, 0);
});

test("scanner accepts verified append-only growth but rejects accepted-prefix mutation", (t) => {
  const root = fs.realpathSync(makeFixtureDir("corpus-prefix-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "events.jsonl");
  const initial = `${JSON.stringify({ event_type: "session.start", event_id: "initial" })}\n`;
  fs.writeFileSync(file, initial);
  const lines = [];
  const scanned = scanPinnedJsonl(
    file,
    "prefix fixture",
    2 * 1024 * 1024,
    capturePinnedDirectoryChain(root),
    (line) => {
      if (line !== null) lines.push(line);
      fs.appendFileSync(file, `${JSON.stringify({ event_type: "session.start", event_id: "later" })}\n`);
    },
  );

  assert.equal(scanned.size, Buffer.byteLength(initial));
  assert.deepEqual(lines, [initial.trim()]);
  assert.doesNotThrow(() => assertPinnedFilePrefix(
    file,
    "prefix fixture",
    scanned.size,
    scanned.contentSha256,
    capturePinnedDirectoryChain(root),
  ));

  const descriptor = fs.openSync(file, "r+");
  try {
    fs.writeSync(descriptor, Buffer.from("X"), 0, 1, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  assert.throws(() => assertPinnedFilePrefix(
    file,
    "prefix fixture",
    scanned.size,
    scanned.contentSha256,
    capturePinnedDirectoryChain(root),
  ), /accepted prefix changed/);
});

test("stable root ids do not depend on the configured root set", (t) => {
  const fixtureRoot = fixture();
  const unrelated = fs.realpathSync(makeFixtureDir("aaa-corpus-root-"));
  t.after(() => {
    fs.rmSync(fixtureRoot.root, { recursive: true, force: true });
    fs.rmSync(unrelated, { recursive: true, force: true });
  });
  const alone = compileRetrospectiveCorpus([fixtureRoot.root]);
  const withUnrelated = compileRetrospectiveCorpus([fixtureRoot.root, unrelated]);
  assert.equal(withUnrelated.report.runs[0].root_id, alone.report.runs[0].root_id);
  assert.deepEqual(withUnrelated.manifests[0].manifest, alone.manifests[0].manifest);
});

test("CLI publishes complete generations and moves current away from stale runs", (t) => {
  const { root } = fixture();
  const output = fs.realpathSync(makeFixtureDir("corpus-output-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(output, { recursive: true, force: true });
  });
  const args = [
    "build/src/cli.js",
    "usage-feedback",
    "compile-corpus",
    "--record-root",
    root,
    "--output-dir",
    output,
    "--quiet",
  ];
  const first = spawnSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const corpus = path.join(output, "corpus");
  const firstGeneration = JSON.parse(fs.readFileSync(path.join(corpus, "current.json"), "utf8")).generation;
  assert.equal(fs.readdirSync(path.join(corpus, "generations", firstGeneration, "manifests")).length, 1);

  const repeated = spawnSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(repeated.status, 0, repeated.stderr);
  const repeatedGeneration = JSON.parse(fs.readFileSync(path.join(corpus, "current.json"), "utf8")).generation;
  assert.equal(repeatedGeneration, firstGeneration);
  assert.deepEqual(fs.readdirSync(path.join(corpus, "generations")), [firstGeneration]);

  const firstDirectory = path.join(corpus, "generations", firstGeneration);
  const report = fs.readFileSync(path.join(firstDirectory, "report.json"));
  fs.renameSync(path.join(firstDirectory, "report.json"), path.join(firstDirectory, "report.jso"));
  fs.writeFileSync(path.join(firstDirectory, "report.jso"), Buffer.concat([Buffer.from("n"), report]));
  const repaired = spawnSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(repaired.status, 0, repaired.stderr);
  const repairedGeneration = JSON.parse(fs.readFileSync(path.join(corpus, "current.json"), "utf8")).generation;
  assert.notEqual(repairedGeneration, firstGeneration);
  assert.equal(fs.existsSync(path.join(corpus, "generations", repairedGeneration, "report.json")), true);

  fs.rmSync(path.join(root, ".kontourai"), { recursive: true });
  const second = spawnSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  const secondGeneration = JSON.parse(fs.readFileSync(path.join(corpus, "current.json"), "utf8")).generation;
  assert.notEqual(secondGeneration, firstGeneration);
  assert.equal(fs.readdirSync(path.join(corpus, "generations", secondGeneration, "manifests")).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(corpus, "generations", secondGeneration, "report.json"),
    "utf8",
  )).measurement.observations_compiled, 0);
});

test("CLI rejects a group or world-writable corpus output boundary", (t) => {
  const { root } = fixture();
  const output = fs.realpathSync(makeFixtureDir("corpus-output-unsafe-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(output, { recursive: true, force: true });
  });
  fs.chmodSync(output, 0o777);
  const result = spawnSync(process.execPath, [
    "build/src/cli.js",
    "usage-feedback",
    "compile-corpus",
    "--record-root",
    root,
    "--output-dir",
    output,
    "--quiet",
  ], { cwd: path.resolve("."), encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /compile-corpus failed/);
});
