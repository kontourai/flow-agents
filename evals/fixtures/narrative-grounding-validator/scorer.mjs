import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const api = await import(pathToFileURL(path.join(root, "build/src/index.js")));
const grounding = await import(pathToFileURL(path.join(root, "build/src/narrative/grounding-validator.js")));
const corpus = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/narrative-grounding-validator/corpus.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha8 = (bytes) => sha256(bytes).slice(0, 8);
const capturedAt = "2026-07-14T15:00:00.000Z";
const compiledAt = "2026-07-14T16:00:00.000Z";
const compiler = { name: "grounding-validator-corpus", version: "1", policy_hash: "fixture" };
const captureCompleteness = { channels: { full: "active" }, known_gaps: [] };

function snapshot(input) {
  return api.snapshotNarrative({
    narrativeDir: input.narrativeDir,
    narrativeId: input.narrativeId,
    requests: input.requests,
    redactionFields: [],
    compiler,
    captureCompleteness,
    allowTranscriptContent: true,
  }, { now: () => capturedAt });
}

function allStatements(envelope) {
  const projection = envelope.sections.find((section) => section.authority === "flow-agents").embedded;
  return [...projection.turns.flatMap((turn) => turn.statements), ...projection.document_statements];
}

function removeStatements(envelope, predicate) {
  const copy = structuredClone(envelope);
  const projection = copy.sections.find((section) => section.authority === "flow-agents").embedded;
  for (const turn of projection.turns) turn.statements = turn.statements.filter((statement) => !predicate(statement));
  projection.document_statements = projection.document_statements.filter((statement) => !predicate(statement));
  return copy;
}

function buildMaterialFixture(temp) {
  const sessionDir = path.join(temp, "session");
  const telemetryDir = path.join(temp, "telemetry");
  const repoRoot = path.join(temp, "repo");
  const narrativeDir = path.join(temp, "material-narrative");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(telemetryDir, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });

  const commandLines = [
    JSON.stringify({ command: "npm test", result: "fail", exitCode: 1 }),
    JSON.stringify({ command: "npm test", result: "pass", exitCode: 0 }),
  ];
  fs.writeFileSync(path.join(sessionDir, "command-log.jsonl"), `${commandLines.join("\n")}\n`);
  const telemetryRecords = [
    { session_id: "idle-session", event_id: "idle-turn", event_type: "turn.user", timestamp: "2026-07-14T13:00:00.000Z", hook: { turn_id: "idle" } },
    { session_id: "timeout-session", event_id: "timeout-tool", event_type: "tool.result", timestamp: "2026-07-14T13:01:00.000Z", tool: { name: "shell" }, timed_out: true, timeout_ms: 30000 },
    // #623 (review HIGH): a command failure captured via the telemetry stream must be
    // coverage-enforced exactly like a cmdlog failure. Its omission is scored below.
    { session_id: "cmd-session", event_id: "cmd-fail", event_type: "tool.result", timestamp: "2026-07-14T13:02:00.000Z", tool: { name: "execute_bash", input: { command: "false" } }, exit_code: 1 },
  ];
  const telemetryLines = telemetryRecords.map(JSON.stringify);
  fs.writeFileSync(path.join(telemetryDir, "full.jsonl"), `${telemetryLines.join("\n")}\n`);
  const fileBytes = Buffer.from('{"kind":"created-file-fixture","status":"created"}\n');
  fs.writeFileSync(path.join(repoRoot, "created.json"), fileBytes);

  const requests = [
    ...commandLines.map((line, index) => ({
      source: api.parseSourceId(`fa1:cmdlog:session:line-${index + 1}/${sha8(Buffer.from(line))}`),
      roots: { sessionDir },
    })),
    ...telemetryRecords.map((record, index) => ({
      source: api.parseSourceId(`fa1:telemetry:full/${record.session_id}:${record.event_id}/${sha8(Buffer.from(telemetryLines[index]))}`),
      roots: { telemetryDir },
    })),
    {
      source: api.parseSourceId(`fa1:file:created.json:${sha256(fileBytes)}`),
      roots: { repoRoot },
    },
  ];
  snapshot({ narrativeDir, narrativeId: "material-corpus", requests });
  return { narrativeDir, envelope: api.composeGroundedNarrative(narrativeDir, { compiledAt }) };
}

function syntheticEnvelope(sourceRef, statement) {
  return {
    sections: [{
      authority: "flow-agents",
      kind: "runtime-projection",
      sha256: "0".repeat(64),
      embedded: { turns: [], document_statements: [{ id: "synthetic", class: "observed", proposition: "Synthetic observation", source_refs: [sourceRef], ...statement }] },
    }],
  };
}

function buildInjectionPair(temp) {
  const transcript = path.join(temp, "injection-source.json");
  const fixtureDir = path.join(root, "evals/fixtures/narrative-grounding-validator");
  const controlMessage = fs.readFileSync(path.join(fixtureDir, "prompt-injection-control.txt"), "utf8").trim();
  const adversarialMessage = fs.readFileSync(path.join(fixtureDir, "prompt-injection-adversarial.txt"), "utf8").trim();
  const encode = (message) => Buffer.from(`${JSON.stringify({ message: message.padEnd(128, " ") })}\n`);
  const controlBytes = encode(controlMessage);
  const adversarialBytes = encode(adversarialMessage);
  if (controlBytes.length !== adversarialBytes.length) throw new Error("injection fixtures must be byte-length matched");
  const pathHash = createHash("sha256").update(path.resolve(transcript)).digest("hex").slice(0, 8);
  const sourceRef = `fa1:transcript:${pathHash}:0-${controlBytes.length}`;
  const request = () => ({ source: api.parseSourceId(sourceRef), roots: { transcriptPath: transcript } });

  fs.writeFileSync(transcript, controlBytes);
  const controlDir = path.join(temp, "injection-control");
  snapshot({ narrativeDir: controlDir, narrativeId: "injection-control", requests: [request()] });
  fs.writeFileSync(transcript, adversarialBytes);
  const adversarialDir = path.join(temp, "injection-adversarial");
  snapshot({ narrativeDir: adversarialDir, narrativeId: "injection-adversarial", requests: [request()] });
  const envelope = syntheticEnvelope(sourceRef);
  return { sourceRef, envelope, controlDir, adversarialDir };
}

function hasCode(verdict, code, eventKind) {
  return !verdict.ok && verdict.violations.some((violation) => violation.code === code && (!eventKind || violation.event_kind === eventKind));
}

const mode = process.argv[2] ?? "all";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-grounding-corpus-"));
const results = [];
let publishedObserved = 0;
let unsupportedPublishedObserved = 0;
let publishedObservedResolverFailures = 0;
try {
  const { narrativeDir, envelope } = buildMaterialFixture(temp);
  const valid = grounding.validateNarrativeGrounding(envelope, narrativeDir);
  results.push({ id: "valid-control", expected: "accept", actual: valid.ok ? "accept" : "reject" });
  if (valid.ok) {
    for (const statement of allStatements(envelope).filter((item) => item.class === "observed")) {
      publishedObserved += 1;
      if (statement.source_refs.length === 0) unsupportedPublishedObserved += 1;
      for (const ref of statement.source_refs) if (api.resolveSource(narrativeDir, ref).status !== "resolved") publishedObservedResolverFailures += 1;
    }
  }

  if (mode === "all" || mode === "citation") {
    const fabricated = structuredClone(envelope);
    const statement = allStatements(fabricated)[0];
    statement.source_refs = ["fa1:flow-state:absent:state/00000000"];
    const verdict = grounding.validateNarrativeGrounding(fabricated, narrativeDir);
    results.push({ id: "fabricated-citation", expected: "reject", actual: hasCode(verdict, "unresolved_citation") ? "reject" : "accept" });
  }

  if (mode === "all" || mode === "material") {
    const omissions = [
      ["omitted-command-failure", "command_failure", (statement) => statement.class === "observed" && /`npm test` was observed to fail/.test(statement.proposition)],
      ["omitted-telemetry-command-failure", "command_failure", (statement) => statement.class === "observed" && /`false` was observed to fail/.test(statement.proposition)],
      ["omitted-retry", "retry_group", (statement) => statement.rule?.id === "retry-detection"],
      ["omitted-timeout", "timeout", (statement) => statement.rule?.id === "timeout-detection"],
      ["omitted-no-op", "no_op_turn", (statement) => statement.rule?.id === "no-op-turn"],
      ["omitted-file-creation", "file_creation", (statement) => statement.class === "observed" && /observed to be created/.test(statement.proposition)],
    ];
    for (const [id, eventKind, predicate] of omissions) {
      const verdict = grounding.validateNarrativeGrounding(removeStatements(envelope, predicate), narrativeDir);
      results.push({ id, expected: "reject", actual: hasCode(verdict, "uncovered_material_event", eventKind) ? "reject" : "accept" });
    }
  }

  if (mode === "all" || mode === "epistemic") {
    const invalid = structuredClone(envelope);
    const derived = allStatements(invalid).find((statement) => statement.class === "deterministic_derived");
    derived.rule.inputs = ["fa1:flow-state:absent:state/00000000"];
    const verdict = grounding.validateNarrativeGrounding(invalid, narrativeDir);
    results.push({ id: "invalid-rule-binding", expected: "reject", actual: hasCode(verdict, "invalid_rule_binding") ? "reject" : "accept" });
  }

  if (mode === "all" || mode === "injection") {
    const injection = buildInjectionPair(temp);
    const before = JSON.stringify(allStatements(injection.envelope).map(({ class: statementClass, source_refs }) => ({ class: statementClass, source_refs })));
    const controlVerdict = grounding.validateNarrativeGrounding(injection.envelope, injection.controlDir);
    const adversarialVerdict = grounding.validateNarrativeGrounding(injection.envelope, injection.adversarialDir);
    const after = JSON.stringify(allStatements(injection.envelope).map(({ class: statementClass, source_refs }) => ({ class: statementClass, source_refs })));
    const canaryLeaked = JSON.stringify([controlVerdict, adversarialVerdict, injection.envelope]).includes("NGV_CANARY_623");
    results.push({
      id: "prompt-injection-inert",
      expected: "accept",
      actual: controlVerdict.ok && adversarialVerdict.ok && JSON.stringify(controlVerdict) === JSON.stringify(adversarialVerdict) && before === after && !canaryLeaked ? "accept" : "reject",
    });
  }

  const accepts = results.filter((result) => result.actual === "accept").length;
  const rejects = results.filter((result) => result.actual === "reject").length;
  const unsupportedRate = publishedObserved === 0 ? 0 : unsupportedPublishedObserved / publishedObserved;
  console.log(`fixture provenance: ${corpus.work_item} ${corpus.schema_version}`);
  console.log(`scorer counts: accept=${accepts} reject=${rejects} total=${results.length}`);
  console.log(`unsupported observed-claim rate=${unsupportedRate}`);
  console.log(`citation-resolver failures for published observed statements=${publishedObservedResolverFailures}`);
  for (const result of results) console.log(`${result.id}: expected=${result.expected} actual=${result.actual}`);
  if (results.some((result) => result.actual !== result.expected)) process.exitCode = 1;
  if (unsupportedRate !== corpus.thresholds.unsupported_observed_claim_rate) process.exitCode = 1;
  if (publishedObservedResolverFailures !== corpus.thresholds.citation_resolver_failures_for_published_observed_statements) process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
