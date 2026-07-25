import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { TrustBundleBuilder } from "@kontourai/surface";
import {
  assertPinnedDirectoryChain,
  capturePinnedDirectoryChain,
  compileRetrospectiveObservation,
  readRetrospectiveObservationManifest,
  validateRetrospectiveObservation,
} from "../../build/src/retrospective-observation.js";
import {
  RUN_CORRELATION_IDENTITY_KEYS,
  createRunCorrelationEnvelope,
} from "../../build/src/run-correlation.js";

const timestamp = "2026-07-24T12:00:00.000Z";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retrospective-observation-"));
  const correlation = createRunCorrelationEnvelope({
    correlation_id: "compiler-fixture-run",
    identities: Object.fromEntries(RUN_CORRELATION_IDENTITY_KEYS.map((key) => [
      key,
      key === "flow_run"
        ? { status: "present", value: "flow-fixture-run" }
        : { status: "unavailable", reason: `${key} is unavailable in the compiler fixture` },
    ])),
  });
  const writeJson = (name, value) => {
    const bytes = `${JSON.stringify(value)}\n`;
    fs.writeFileSync(path.join(root, name), bytes);
    return createHash("sha256").update(bytes).digest("hex");
  };
  const runtime = [
    {
      event_type: "session.usage",
      event_id: "usage-1",
      timestamp,
      usage: {
        scope: "run",
        semantics: "delta",
        baseline_status: "present",
        model: "fixture-model",
        duration_s: 12,
        delegations: 0,
        input_tokens: 100,
        output_tokens: 25,
        estimated_cost_usd: 0.01,
      },
      run_correlation: correlation,
    },
    { event_type: "turn.user", event_id: "turn-1", run_correlation: correlation },
    {
      event_type: "tool.result",
      event_id: "tool-1",
      tool: { status: "completed", duration_ms: 1, exit_code: 0 },
      run_correlation: correlation,
    },
    { event_type: "agent.delegate", event_id: "delegation-1", run_correlation: correlation },
  ];
  fs.writeFileSync(path.join(root, "runtime.jsonl"), `${runtime.map(JSON.stringify).join("\n")}\n`);
  writeJson("builder-state.json", {
    run_correlation: correlation,
    workflow_outcome: {
      schema_version: "1.0",
      source: "canonical_flow_projection",
      flow_status: "completed",
      process_status: "completed",
      verification_status: "PASS",
      quality_status: "not_independently_evaluated",
    },
  });
  const trust = new TrustBundleBuilder({ source: "retrospective-fixture" }).build();
  const trustSha256 = writeJson("trust.bundle", trust);
  writeJson("flow-state.json", {
    run_id: "flow-fixture-run",
    status: "completed",
    gate_outcomes: [{ gate_id: "verify-gate", status: "pass" }],
    transitions: [
      { from_step: "plan", to_step: "build", status: "allowed" },
      { type: "route_back", from_step: "build", to_step: "plan", status: "route-back" },
      { from_step: "plan", to_step: null, status: "allowed" },
    ],
  });
  writeJson("evidence-manifest.json", {
    run_id: "flow-fixture-run",
    evidence: [{
      kind: "trust.bundle",
      sha256: trustSha256,
      bundle: trust,
      analytics: { run_correlation: correlation },
    }],
  });
  fs.writeFileSync(path.join(root, "economics.jsonl"), `${JSON.stringify({
    schema: "kontour.console.economics",
    version: "0.2",
    run_id: correlation.correlation_id,
    run_correlation: correlation,
    observation_semantics: "snapshot",
    producer_authority: "fixture_input",
    at: timestamp,
    model: "fixture-model",
    cost: { input_tokens: 100, output_tokens: 25, estimated_cost_usd: 0.01 },
    time: { wall_clock_s: 12 },
    delegations: [],
  })}\n`);
  writeJson("terminal.json", {
    schema: "kontour.flow-agents.workflow-outcome",
    version: "1.0",
    kind: "terminal",
    record_id: "terminal-fixture",
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
  });
  writeJson("observation-manifest.json", {
    schema_version: "1.0",
    correlation_id: correlation.correlation_id,
    sources: {
      runtime_events: { source_id: "runtime", file: "runtime.jsonl" },
      builder_state: { source_id: "builder-state", file: "builder-state.json" },
      trust_bundle: { source_id: "trust", file: "trust.bundle" },
      flow_state: { source_id: "flow-state", file: "flow-state.json" },
      flow_evidence_manifest: { source_id: "flow-evidence", file: "evidence-manifest.json" },
      economics: { source_id: "economics", file: "economics.jsonl" },
      terminal_outcome: { source_id: "terminal", file: "terminal.json" },
    },
  });
  return { root, correlation, manifest: path.join(root, "observation-manifest.json") };
}

function compile(root, manifest) {
  return compileRetrospectiveObservation(readRetrospectiveObservationManifest(manifest), root);
}

test("compiler emits a deterministic complete privacy-safe observation", (t) => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compiled = compile(root, manifest);
  const repeated = compile(root, manifest);

  assert.deepEqual(repeated, compiled);
  assert.equal(compiled.completeness.status, "complete");
  assert.deepEqual(compiled.completeness.missing_dimensions, []);
  assert.equal(compiled.process.status, "completed");
  assert.equal(compiled.process.verification_status, "PASS");
  assert.deepEqual(compiled.workflow, {
    flow_status: "completed",
    gate_outcome_count: 1,
    transition_count: 3,
    route_back_count: 1,
  });
  assert.deepEqual(compiled.activity, {
    turn_count: 1,
    tool_result_count: 1,
    delegation_event_count: 1,
  });
  assert.deepEqual(compiled.quality, {
    status: "NOT_VERIFIED",
    reason: "not_independently_evaluated",
  });
  assert.deepEqual(compiled.usage, {
    status: "NOT_VERIFIED",
    authority: "fixture_input",
    semantics: "run_delta",
    model: "fixture-model",
    input_tokens: 100,
    output_tokens: 25,
    estimated_cost_usd: 0.01,
    wall_clock_s: 12,
    delegation_count: 0,
  });
  assert.equal(compiled.diagnostics.length, 0);
  const serialized = JSON.stringify(compiled);
  assert(!serialized.includes(root));
  assert(!serialized.includes("prompt"));
  assert(!serialized.includes("tool_input"));
  validateRetrospectiveObservation(compiled);
  const { snapshot_sha256, ...core } = compiled;
  assert.equal(snapshot_sha256, createHash("sha256").update(stableStringify(core)).digest("hex"));
  validateSchemas(manifest, compiled);
});

test("compiler reports absent producer dimensions without inference", (t) => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const value = JSON.parse(fs.readFileSync(manifest, "utf8"));
  delete value.sources.economics;
  delete value.sources.runtime_events;
  fs.writeFileSync(manifest, `${JSON.stringify(value)}\n`);

  const compiled = compile(root, manifest);
  assert.equal(compiled.completeness.status, "partial");
  assert.deepEqual(compiled.completeness.missing_sources, ["runtime_events", "economics"]);
  assert(compiled.completeness.missing_dimensions.includes("runtime_session"));
  assert(compiled.completeness.missing_dimensions.includes("economics"));
  assert.equal(compiled.usage.input_tokens, null);
  assert.equal(compiled.quality.status, "NOT_VERIFIED");
});

test("same correlation id with a different envelope is quarantined instead of joined", (t) => {
  const { root, correlation, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeFile = path.join(root, "runtime.jsonl");
  const runtime = fs.readFileSync(runtimeFile, "utf8").trim().split("\n").map(JSON.parse);
  const conflicting = structuredClone(correlation);
  conflicting.identities.runtime_session = { status: "present", value: "other-session" };
  runtime.forEach((record) => { record.run_correlation = conflicting; });
  fs.writeFileSync(runtimeFile, `${runtime.map(JSON.stringify).join("\n")}\n`);

  const compiled = compile(root, manifest);
  assert.equal(compiled.completeness.status, "partial");
  assert(compiled.completeness.missing_dimensions.includes("runtime_session"));
  assert.equal(compiled.activity.turn_count, null);
  assert.equal(compiled.completeness.invalid_records, runtime.length);
});

test("usage attribution downgrades when runtime and economics metadata disagree", (t) => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const economicsFile = path.join(root, "economics.jsonl");
  const economics = JSON.parse(fs.readFileSync(economicsFile, "utf8"));
  economics.model = "different-model";
  economics.time.wall_clock_s = 999;
  fs.writeFileSync(economicsFile, `${JSON.stringify(economics)}\n`);

  const compiled = compile(root, manifest);
  assert.deepEqual(compiled.usage, {
    status: "NOT_VERIFIED",
    authority: "fixture_input",
    semantics: "run_delta",
    model: null,
    input_tokens: 100,
    output_tokens: 25,
    estimated_cost_usd: 0.01,
    wall_clock_s: null,
    delegation_count: 0,
  });
});

test("terminal outcomes that contradict Builder and Flow are quarantined", (t) => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const builderFile = path.join(root, "builder-state.json");
  const builder = JSON.parse(fs.readFileSync(builderFile, "utf8"));
  builder.workflow_outcome.verification_status = "FAIL";
  fs.writeFileSync(builderFile, `${JSON.stringify(builder)}\n`);

  const compiled = compile(root, manifest);
  assert.equal(compiled.process.status, null);
  assert.equal(compiled.process.verification_status, "NOT_VERIFIED");
  assert(compiled.completeness.missing_dimensions.includes("terminal"));
  assert.equal(compiled.diagnostics.some((entry) => entry.source_id === "terminal"), true);
});

test("compiler quarantines malformed JSONL without exposing its content", (t) => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sentinel = "SECRET_SENTINEL_NEVER_EMIT";
  fs.appendFileSync(path.join(root, "runtime.jsonl"), `{\"broken\":\"${sentinel}\"\n`);

  const compiled = compile(root, manifest);
  assert.equal(compiled.completeness.status, "partial");
  assert.equal(compiled.completeness.malformed_records, 1);
  assert.equal(compiled.diagnostics.at(-1).error, "SyntaxError");
  assert(!JSON.stringify(compiled).includes(sentinel));
});

test("compiler bounds emitted diagnostics while preserving malformed counts", (t) => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.appendFileSync(path.join(root, "runtime.jsonl"), `${Array.from(
    { length: 1002 },
    (_, index) => `{"broken":${index}`,
  ).join("\n")}\n`);

  const compiled = compile(root, manifest);
  assert.equal(compiled.completeness.malformed_records, 1002);
  assert.equal(compiled.diagnostics.length, 1000);
  const runtimeRef = compiled.source_refs.find((entry) => entry.kind === "runtime_events");
  assert.equal(runtimeRef.malformed_records, 1002);
  assert.equal(runtimeRef.total_records, runtimeRef.valid_records + 1002);
});

test("compiler rejects traversal, symbolic links, and credential-shaped source ids", (t) => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const value = JSON.parse(fs.readFileSync(manifest, "utf8"));
  value.sources.runtime_events.file = "../runtime.jsonl";
  fs.writeFileSync(manifest, `${JSON.stringify(value)}\n`);
  assert.throws(() => readRetrospectiveObservationManifest(manifest), /relative path without traversal/);

  value.sources.runtime_events.file = "runtime-link.jsonl";
  fs.symlinkSync(path.join(root, "runtime.jsonl"), path.join(root, "runtime-link.jsonl"));
  fs.writeFileSync(manifest, `${JSON.stringify(value)}\n`);
  assert.throws(() => compile(root, manifest), /must not contain symbolic links/);

  value.sources.runtime_events.file = "runtime.jsonl";
  value.sources.runtime_events.source_id = ["token", ["sk", "proj", "1234567890"].join("-")].join(":");
  fs.writeFileSync(manifest, `${JSON.stringify(value)}\n`);
  assert.throws(() => readRetrospectiveObservationManifest(manifest), /non-sensitive opaque identifier/);
});

test("compiler refuses a manifest with no exact correlated producer", (t) => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const value = JSON.parse(fs.readFileSync(manifest, "utf8"));
  value.sources = {
    trust_bundle: value.sources.trust_bundle,
    flow_state: value.sources.flow_state,
  };
  fs.writeFileSync(manifest, `${JSON.stringify(value)}\n`);
  assert.throws(() => compile(root, manifest), /no producer record carries the manifest correlation_id/);
});

test("manifest parse failures do not echo source content", (t) => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sentinel = "SECRET_SENTINEL_NEVER_ECHO";
  fs.writeFileSync(manifest, `{\"secret\":\"${sentinel}\"`);
  assert.throws(
    () => readRetrospectiveObservationManifest(manifest),
    (error) => error.message === "observation manifest is malformed (SyntaxError)"
      && !error.message.includes(sentinel),
  );
});

test("CLI atomically replaces its observation and refuses a symlink destination", (t) => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "feedback");
  const args = [
    "build/src/cli.js",
    "usage-feedback",
    "compile-observation",
    "--manifest",
    manifest,
    "--record-root",
    root,
    "--output-dir",
    outputDir,
    "--quiet",
  ];
  const first = spawnSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const observationsDir = path.join(outputDir, "observations");
  const [observationFile] = fs.readdirSync(observationsDir);
  assert(observationFile);
  const outputFile = path.join(observationsDir, observationFile);
  const firstBytes = fs.readFileSync(outputFile);
  const repeated = spawnSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert(fs.readFileSync(outputFile).equals(firstBytes));

  const victim = path.join(root, "victim.json");
  fs.writeFileSync(victim, "unchanged\n");
  fs.unlinkSync(outputFile);
  fs.symlinkSync(victim, outputFile);
  const attacked = spawnSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8" });
  assert.notEqual(attacked.status, 0);
  assert.equal(fs.readFileSync(victim, "utf8"), "unchanged\n");
});

test("runtime observation validation rejects nested schema drift", (t) => {
  const { root, manifest } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compiled = compile(root, manifest);
  const invalid = structuredClone(compiled);
  invalid.usage.unpublished_field = "not-in-schema";
  const { snapshot_sha256: _old, ...core } = invalid;
  invalid.snapshot_sha256 = createHash("sha256").update(stableStringify(core)).digest("hex");

  assert.throws(() => validateRetrospectiveObservation(invalid), /unsupported field/);
  const schema = JSON.parse(fs.readFileSync(
    new URL("../../schemas/retrospective-observation.schema.json", import.meta.url),
    "utf8",
  ));
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  assert.equal(validate(invalid), false);

  for (const mutate of [
    (value) => { value.usage = { ...value.usage, authority: "unavailable", input_tokens: 1 }; },
    (value) => { value.usage = { ...value.usage, status: "CONFIRMED", authority: "fixture_input" }; },
    (value) => {
      value.completeness = {
        ...value.completeness,
        status: "complete",
        present_dimensions: value.completeness.present_dimensions.filter((kind) => kind !== "terminal"),
        missing_dimensions: ["terminal"],
        missing_sources: ["terminal_outcome"],
      };
    },
    (value) => { value.process.status = ""; },
    (value) => { value.process.status = "xoxb-abcdefgh"; },
    (value) => { value.completeness.status = "partial"; },
    (value) => { value.source_refs = []; },
  ]) {
    const candidate = structuredClone(compiled);
    mutate(candidate);
    const { snapshot_sha256: _snapshot, ...candidateCore } = candidate;
    candidate.snapshot_sha256 = createHash("sha256").update(stableStringify(candidateCore)).digest("hex");
    assert.throws(() => validateRetrospectiveObservation(candidate), /retrospective|usage/);
    assert.equal(validate(candidate), false);
  }

  for (const credential of [
    "Bearer abcdefgh",
    "API_KEY:abcdefgh",
    "SK_abcdefgh",
    "Github_Pat_abcdefghijkl",
    "XOXB-abcdefgh",
    "GLPAT-abcdefgh",
    "YA29.abcdefgh",
    "WHSEC_abcdefgh",
    "SK-PROJ-abcdefgh",
    "SQ0ATP-abcdefgh",
  ]) {
    const candidate = structuredClone(compiled);
    candidate.process.status = credential;
    const { snapshot_sha256: _snapshot, ...candidateCore } = candidate;
    candidate.snapshot_sha256 = createHash("sha256").update(stableStringify(candidateCore)).digest("hex");
    assert.throws(
      () => validateRetrospectiveObservation(candidate),
      /retrospective observation process is invalid|sensitive credential material/,
    );
    assert.equal(validate(candidate), false, `schema accepted credential-shaped metadata: ${credential}`);
  }

  const contradictoryComplete = structuredClone(compiled);
  contradictoryComplete.source_refs[0].valid_records -= 1;
  contradictoryComplete.source_refs[0].invalid_records = 1;
  contradictoryComplete.diagnostics = [{
    source_id: contradictoryComplete.source_refs[0].source_id,
    line: 1,
    content_sha256: "0".repeat(64),
    error: "ProducerValidationError",
  }];
  const { snapshot_sha256: _complete, ...completeCore } = contradictoryComplete;
  contradictoryComplete.snapshot_sha256 = createHash("sha256").update(stableStringify(completeCore)).digest("hex");
  assert.throws(
    () => validateRetrospectiveObservation(contradictoryComplete),
    /aggregate record counts are inconsistent/,
  );
  assert.equal(validate(contradictoryComplete), false);

  const wrongSource = structuredClone(compiled);
  wrongSource.completeness.status = "partial";
  wrongSource.completeness.invalid_records = 1;
  wrongSource.source_refs[0].valid_records -= 1;
  wrongSource.source_refs[0].invalid_records = 1;
  wrongSource.diagnostics = [{
    source_id: wrongSource.source_refs[1].source_id,
    line: 1,
    content_sha256: "0".repeat(64),
    error: "ProducerValidationError",
  }];
  const { snapshot_sha256: _wrong, ...wrongCore } = wrongSource;
  wrongSource.snapshot_sha256 = createHash("sha256").update(stableStringify(wrongCore)).digest("hex");
  assert.throws(() => validateRetrospectiveObservation(wrongSource), /diagnostics exceed their source counts/);
});

test("pinned directory chains detect an ancestor replacement", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retrospective-directory-chain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, "parent");
  const leaf = path.join(parent, "leaf");
  fs.mkdirSync(leaf, { recursive: true });
  const realLeaf = fs.realpathSync(leaf);
  const realParent = path.dirname(realLeaf);
  const chain = capturePinnedDirectoryChain(realLeaf);
  fs.renameSync(realParent, path.join(path.dirname(realParent), "original-parent"));
  fs.mkdirSync(realLeaf, { recursive: true });
  assert.throws(() => assertPinnedDirectoryChain(chain), /directory chain changed/);
});

function validateSchemas(manifest, compiled) {
  const observationSchema = JSON.parse(fs.readFileSync(
    new URL("../../schemas/retrospective-observation.schema.json", import.meta.url),
    "utf8",
  ));
  const manifestSchema = JSON.parse(fs.readFileSync(
    new URL("../../schemas/retrospective-observation-manifest.schema.json", import.meta.url),
    "utf8",
  ));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validateManifest = ajv.compile(manifestSchema);
  assert.equal(validateManifest(JSON.parse(fs.readFileSync(manifest, "utf8"))), true, JSON.stringify(validateManifest.errors));
  const validateObservation = ajv.compile(observationSchema);
  assert.equal(validateObservation(compiled), true, JSON.stringify(validateObservation.errors));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
