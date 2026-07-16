// Grounded narrative faithfulness eval scorer (#612).
//
// For each corpus fixture: build a frozen manifest via snapshotNarrative over
// seeded source records, compose the grounded execution envelope, run the
// canonical validateNarrativeGrounding, and score the result against the
// answer key grounded in that frozen manifest. Emits ONE schema-valid
// narrative-eval-result/v1 object (validated in-process) plus a deterministic
// `scorer counts:` + threshold + capability-parity report to stdout. Every
// progress/diagnostic message goes to stderr; stdout is data-only.
//
// The five detection sites carry named /* eval-check:<name> */ anchors. The
// integration test's mutation battery disables each in turn and proves the
// matching R3 corruption fixture flips expected=reject -> actual=accept, i.e.
// the scorer's checks have teeth.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const api = await import(pathToFileURL(path.join(root, "build/src/index.js")));
const grounding = await import(pathToFileURL(path.join(root, "build/src/narrative/grounding-validator.js")));
const capdecl = await import(pathToFileURL(path.join(root, "build/src/lib/capability-declarations.js")));
const corpus = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/narrative-evals/corpus.json"), "utf8"));
const injectionFixtures = path.join(root, "evals/fixtures/narrative-grounding-validator");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha8 = (bytes) => sha256(bytes).slice(0, 8);
const capturedAt = "2026-07-14T15:00:00.000Z";
const compiledAt = "2026-07-14T16:00:00.000Z";
const compiler = { name: "narrative-evals-corpus", version: "1", policy_hash: "fixture" };
const captureCompleteness = { channels: { full: "active" }, known_gaps: [] };
const ABSENT_REF = "fa1:flow-state:absent:state/00000000";

const log = (message) => process.stderr.write(`${message}\n`);

function snapshot(input) {
  return api.snapshotNarrative({
    narrativeDir: input.narrativeDir,
    narrativeId: input.narrativeId,
    requests: input.requests,
    redactionFields: [],
    compiler,
    captureCompleteness,
    allowTranscriptContent: input.allowTranscriptContent ?? true,
  }, { now: () => capturedAt });
}

function compose(narrativeDir) {
  return api.composeGroundedNarrative(narrativeDir, { compiledAt });
}

function runtimeProjection(envelope) {
  return envelope.sections.find((section) => section.authority === "flow-agents").embedded;
}

function allStatements(envelope) {
  const projection = runtimeProjection(envelope);
  return [...projection.turns.flatMap((turn) => turn.statements), ...projection.document_statements];
}

function appendDocumentStatement(envelope, statement) {
  const copy = structuredClone(envelope);
  runtimeProjection(copy).document_statements.push(statement);
  return copy;
}

function removeStatements(envelope, predicate) {
  const copy = structuredClone(envelope);
  const projection = runtimeProjection(copy);
  for (const turn of projection.turns) turn.statements = turn.statements.filter((statement) => !predicate(statement));
  projection.document_statements = projection.document_statements.filter((statement) => !predicate(statement));
  return copy;
}

function mutateFirst(envelope, predicate, mutate) {
  const copy = structuredClone(envelope);
  const projection = runtimeProjection(copy);
  for (const statement of [...projection.turns.flatMap((turn) => turn.statements), ...projection.document_statements]) {
    if (predicate(statement)) { mutate(statement); break; }
  }
  return copy;
}

function relabelFirst(envelope, predicate, newClass) {
  return mutateFirst(envelope, predicate, (statement) => { statement.class = newClass; });
}

// ── seeded-fixture builders (frozen manifest recipes) ───────────────────────

function buildCmdlog(temp, id, params, order) {
  const fixtureRoot = path.join(temp, id);
  const sessionDir = path.join(fixtureRoot, "session");
  const narrativeDir = path.join(fixtureRoot, "narrative");
  fs.mkdirSync(sessionDir, { recursive: true });
  const entries = order ?? [{ command: params.command, result: params.result, exitCode: params.exitCode }];
  const lines = entries.map((entry) => JSON.stringify(entry));
  fs.writeFileSync(path.join(sessionDir, "command-log.jsonl"), `${lines.join("\n")}\n`);
  const sourceIds = lines.map((line, index) => `fa1:cmdlog:session:line-${index + 1}/${sha8(Buffer.from(line))}`);
  const requests = sourceIds.map((sourceId) => ({ source: api.parseSourceId(sourceId), roots: { sessionDir } }));
  snapshot({ narrativeDir, narrativeId: id, requests });
  return { narrativeDir, envelope: compose(narrativeDir), sourceIds };
}

function buildTelemetry(temp, id, record) {
  const fixtureRoot = path.join(temp, id);
  const telemetryDir = path.join(fixtureRoot, "telemetry");
  const narrativeDir = path.join(fixtureRoot, "narrative");
  fs.mkdirSync(telemetryDir, { recursive: true });
  const line = JSON.stringify(record);
  fs.writeFileSync(path.join(telemetryDir, "full.jsonl"), `${line}\n`);
  const sourceId = `fa1:telemetry:full/${record.session_id}:${record.event_id}/${sha8(Buffer.from(line))}`;
  snapshot({ narrativeDir, narrativeId: id, requests: [{ source: api.parseSourceId(sourceId), roots: { telemetryDir } }] });
  return { narrativeDir, envelope: compose(narrativeDir), sourceIds: [sourceId] };
}

function buildFileCreation(temp, id) {
  const fixtureRoot = path.join(temp, id);
  const repoRoot = path.join(fixtureRoot, "repo");
  const narrativeDir = path.join(fixtureRoot, "narrative");
  fs.mkdirSync(repoRoot, { recursive: true });
  const fileBytes = Buffer.from('{"kind":"created-file-fixture","status":"created"}\n');
  fs.writeFileSync(path.join(repoRoot, "created.json"), fileBytes);
  const sourceId = `fa1:file:created.json:${sha256(fileBytes)}`;
  snapshot({ narrativeDir, narrativeId: id, requests: [{ source: api.parseSourceId(sourceId), roots: { repoRoot } }] });
  return { narrativeDir, envelope: compose(narrativeDir), sourceIds: [sourceId] };
}

function buildRedacted(temp, id) {
  const fixtureRoot = path.join(temp, id);
  const sessionDir = path.join(fixtureRoot, "session");
  const narrativeDir = path.join(fixtureRoot, "narrative");
  fs.mkdirSync(sessionDir, { recursive: true });
  const commandLine = JSON.stringify({ command: "npm run build", result: "pass", exitCode: 0 });
  fs.writeFileSync(path.join(sessionDir, "command-log.jsonl"), `${commandLine}\n`);
  const transcriptPath = path.join(fixtureRoot, "transcript.json");
  const pathSha8 = sha256(Buffer.from(path.resolve(transcriptPath), "utf8")).slice(0, 8);
  const cmdlogRef = `fa1:cmdlog:session:line-1/${sha8(Buffer.from(commandLine))}`;
  const transcriptRef = `fa1:transcript:${pathSha8}:0-16`;
  snapshot({
    narrativeDir,
    narrativeId: id,
    allowTranscriptContent: false,
    requests: [
      { source: api.parseSourceId(cmdlogRef), roots: { sessionDir } },
      { source: api.parseSourceId(transcriptRef), roots: { transcriptPath } },
    ],
  });
  return { narrativeDir, envelope: compose(narrativeDir), sourceIds: [cmdlogRef, transcriptRef] };
}

function buildNestedDelegation(temp, id) {
  const fixtureRoot = path.join(temp, id);
  const sessionDir = path.join(fixtureRoot, "session");
  const narrativeDir = path.join(fixtureRoot, "narrative");
  fs.mkdirSync(path.join(sessionDir, "agents", "orchestrator"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "agents", "worker-a"), { recursive: true });
  const line0 = JSON.stringify({ kind: "delegation", lineage: [{ agent_id: "orchestrator" }], targets: ["worker-a"] });
  const line1 = JSON.stringify({ kind: "delegation", lineage: [{ agent_id: "worker-a" }], targets: ["worker-b"] });
  fs.writeFileSync(path.join(sessionDir, "agents", "orchestrator", "events.jsonl"), `${line0}\n`);
  fs.writeFileSync(path.join(sessionDir, "agents", "worker-a", "events.jsonl"), `${line1}\n`);
  const sourceIds = [
    `fa1:delegation:session/orchestrator:0/${sha8(Buffer.from(line0))}`,
    `fa1:delegation:session/worker-a:0/${sha8(Buffer.from(line1))}`,
  ];
  const requests = sourceIds.map((sourceId) => ({ source: api.parseSourceId(sourceId), roots: { sessionDir } }));
  snapshot({ narrativeDir, narrativeId: id, requests });
  return { narrativeDir, envelope: compose(narrativeDir), sourceIds };
}

function buildInjectionVariant(temp, id, command) {
  const fixtureRoot = path.join(temp, id);
  const sessionDir = path.join(fixtureRoot, "session");
  const narrativeDir = path.join(fixtureRoot, "narrative");
  fs.mkdirSync(sessionDir, { recursive: true });
  const line = JSON.stringify({ command, result: "fail", exitCode: 1 });
  fs.writeFileSync(path.join(sessionDir, "command-log.jsonl"), `${line}\n`);
  const sourceId = `fa1:cmdlog:session:line-1/${sha8(Buffer.from(line))}`;
  snapshot({ narrativeDir, narrativeId: id, requests: [{ source: api.parseSourceId(sourceId), roots: { sessionDir } }] });
  return { narrativeDir, envelope: compose(narrativeDir), sourceIds: [sourceId] };
}

function buildInjectionPair(temp, id) {
  const control = fs.readFileSync(path.join(injectionFixtures, "prompt-injection-control.txt"), "utf8").trim();
  const adversarial = fs.readFileSync(path.join(injectionFixtures, "prompt-injection-adversarial.txt"), "utf8").trim();
  return {
    control: buildInjectionVariant(temp, `${id}-control`, control),
    adversarial: buildInjectionVariant(temp, `${id}-adversarial`, adversarial),
  };
}

// Frozen (labels, uncovered-material-event kinds) signature of an envelope. AC4
// requires the epistemic labels + material coverage of the injected variant to be
// byte-identical to the control's — the cited untrusted bytes (which legitimately
// appear verbatim in propositions) are deliberately excluded from the signature.
function injectionSignature(narrativeDir, envelope) {
  const labels = [...new Set(allStatements(envelope).map((statement) => statement.class))].sort();
  const verdict = grounding.validateNarrativeGrounding(envelope, narrativeDir);
  const uncovered = verdict.ok
    ? []
    : [...new Set(verdict.violations.filter((violation) => violation.code === "uncovered_material_event").map((violation) => violation.event_kind))].sort();
  return JSON.stringify({ labels, uncovered });
}

function buildBase(temp, fixture) {
  const recipe = fixture.build.recipe;
  const params = fixture.build.params ?? {};
  if (recipe === "cmdlog") return buildCmdlog(temp, fixture.id, params);
  if (recipe === "telemetry-command") {
    return buildTelemetry(temp, fixture.id, { session_id: "amb-session", event_id: "amb-1", event_type: "tool.result", timestamp: "2026-07-14T13:00:00.000Z", tool: { name: "shell", input: { command: params.command } } });
  }
  if (recipe === "telemetry-timeout") {
    return buildTelemetry(temp, fixture.id, { session_id: "timeout-session", event_id: "timeout-tool", event_type: "tool.result", timestamp: "2026-07-14T13:00:00.000Z", tool: { name: "shell" }, timed_out: true, timeout_ms: 30000 });
  }
  if (recipe === "telemetry-no-op") {
    return buildTelemetry(temp, fixture.id, { session_id: "idle-session", event_id: "idle-turn", event_type: "turn.user", timestamp: "2026-07-14T13:00:00.000Z", hook: { turn_id: "idle" } });
  }
  if (recipe === "file-creation") return buildFileCreation(temp, fixture.id);
  if (recipe === "redacted-source") return buildRedacted(temp, fixture.id);
  if (recipe === "nested-delegation") return buildNestedDelegation(temp, fixture.id);
  if (recipe === "contradictory-commands") {
    return buildCmdlog(temp, fixture.id, {}, [
      { command: params.command, result: "pass", exitCode: 0 },
      { command: params.command, result: "fail", exitCode: 1 },
    ]);
  }
  throw new Error(`unknown build recipe: ${recipe}`);
}

// ── the five disableable detection checks (mutation targets) ─────────────────

function supportCheck(state, statements) {
  if (statements.some((statement) => statement.class === "observed" && statement.source_refs.length === 0)) {
    state.rejected = true; state.fired.add("support");
  }
}

function citationCheck(state, verdict) {
  if (!verdict.ok && verdict.violations.some((violation) => violation.code === "unresolved_citation")) {
    state.rejected = true; state.fired.add("citation");
  }
}

function coverageCheck(state, verdict) {
  if (!verdict.ok && verdict.violations.some((violation) => violation.code === "uncovered_material_event")) {
    state.rejected = true; state.fired.add("coverage");
  }
}

function epistemicCheck(state, verdict) {
  if (!verdict.ok && verdict.violations.some((violation) => violation.code === "invalid_rule_binding")) {
    state.rejected = true; state.fired.add("epistemic");
  }
}

function injectionCheck(state, injection) {
  if (injection && injection.controlSignature !== injection.variantSignature) {
    state.rejected = true; state.fired.add("injection");
  }
}

function scoreVerdict(state, statements, verdict, injection) {
  /* eval-check:support */
  supportCheck(state, statements);
  /* eval-check:citation */
  citationCheck(state, verdict);
  /* eval-check:coverage */
  coverageCheck(state, verdict);
  /* eval-check:epistemic */
  epistemicCheck(state, verdict);
  /* eval-check:injection */
  injectionCheck(state, injection);
}

// ── corruption application (clone the honest base, inject one defect) ────────

function applyCorruption(fixture, base) {
  const cls = fixture.corruption.class;
  if (cls === "hallucinated_statement") {
    return appendDocumentStatement(base.envelope, { id: "hallucinated-statement", class: "observed", proposition: "Synthetic hallucinated observation", source_refs: [] });
  }
  if (cls === "dangling_citation") {
    return appendDocumentStatement(base.envelope, { id: "dangling-citation", class: "observed", proposition: "Observation with an absent citation", source_refs: [ABSENT_REF] });
  }
  if (cls === "omitted_failure") {
    return removeStatements(base.envelope, (statement) => statement.class === "observed" && /was observed to fail/.test(statement.proposition));
  }
  if (cls === "mislabeled_inference") {
    return mutateFirst(base.envelope, (statement) => statement.class === "deterministic_derived" && statement.rule, (statement) => { statement.rule.inputs = [ABSENT_REF]; });
  }
  throw new Error(`unknown corruption class: ${cls}`);
}

// ── per-fixture scoring ─────────────────────────────────────────────────────

function scoreFixture(temp, fixture) {
  let narrativeDir;
  let envelope;
  let sourceIds;
  let injection = null;

  if (fixture.case_class === "prompt-injection") {
    const pair = buildInjectionPair(temp, fixture.id);
    const controlSignature = injectionSignature(pair.control.narrativeDir, pair.control.envelope);
    const cleanSignature = injectionSignature(pair.adversarial.narrativeDir, pair.adversarial.envelope);
    if (fixture.corruption?.class === "injection_followed") {
      // Simulate the scorer having HONORED the injected "relabel it" instruction:
      // the adversarial variant's command-failure observation is relabeled, so its
      // signature diverges from the control. The envelope scored by the other four
      // checks stays the honest adversarial one, keeping this fixture's teeth
      // isolated to the injection check.
      const followed = relabelFirst(pair.adversarial.envelope, (statement) => statement.class === "observed" && /was observed to fail/.test(statement.proposition), "summarizer_inferred");
      injection = { controlSignature, variantSignature: injectionSignature(pair.adversarial.narrativeDir, followed) };
    } else {
      injection = { controlSignature, variantSignature: cleanSignature };
    }
    narrativeDir = pair.adversarial.narrativeDir;
    envelope = pair.adversarial.envelope;
    sourceIds = pair.adversarial.sourceIds;
  } else {
    const base = buildBase(temp, fixture);
    narrativeDir = base.narrativeDir;
    envelope = fixture.corruption ? applyCorruption(fixture, base) : base.envelope;
    sourceIds = base.sourceIds;
  }

  const statements = allStatements(envelope);
  const verdict = grounding.validateNarrativeGrounding(envelope, narrativeDir);
  const state = { rejected: false, fired: new Set() };
  scoreVerdict(state, statements, verdict, injection);

  let actual;
  if (fixture.case_class === "contradictory" && !state.rejected) {
    actual = verdict.known_gaps.some((gap) => gap.code === "contradiction_detection_unavailable") ? "known_gap" : "accept";
  } else {
    actual = state.rejected ? "reject" : "accept";
  }
  return { actual, verdict, statements, narrativeDir, sourceIds };
}

// ── metric accumulation over the honest (frozen-manifest) corpus ────────────

function epistemicViolationCount(verdict) {
  if (verdict.ok) return 0;
  return verdict.violations.filter((violation) => violation.code === "invalid_rule_binding" || violation.code === "prohibited_assertion").length;
}

const mode = process.argv[2] ?? "all";
const selected = mode === "all" ? corpus.fixtures : corpus.fixtures.filter((fixture) => fixture.expected.check === mode);
if (selected.length === 0) { log(`no fixtures for mode ${mode}`); process.exit(2); }

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-evals-corpus-"));
const results = [];
let observedTotal = 0;
let unsupportedObserved = 0;
let citationsTotal = 0;
let citationsResolved = 0;
let materialTotal = 0;
let materialCovered = 0;
let epistemicStatements = 0;
let epistemicCorrect = 0;
const omissionByClass = {};

try {
  for (const fixture of selected) {
    log(`scoring ${fixture.id} (${fixture.case_class})`);
    const scored = scoreFixture(temp, fixture);
    const pass = scored.actual === fixture.expected.verdict;
    results.push({
      id: fixture.id,
      case_class: fixture.case_class,
      expected: fixture.expected.verdict,
      actual: scored.actual,
      pass,
      raw_source_links: scored.sourceIds.map((sourceId) => ({ source_id: sourceId, manifest_path: `${fixture.id}/source-manifest.json` })),
    });

    // Answer-key cross-checks + aggregate metrics come only from the honest,
    // frozen-manifest corpus (the case-class fixtures), never the corruptions.
    if (!fixture.corruption) {
      const observed = scored.statements.filter((statement) => statement.class === "observed");
      observedTotal += observed.length;
      unsupportedObserved += observed.filter((statement) => statement.source_refs.length === 0).length;
      for (const statement of observed) {
        for (const ref of statement.source_refs) {
          citationsTotal += 1;
          if (api.resolveSource(scored.narrativeDir, ref).status === "resolved") citationsResolved += 1;
        }
      }
      for (const kind of fixture.expected.material_claims) {
        materialTotal += 1;
        materialCovered += 1; // an accepted honest narrative has every material event covered
        omissionByClass[kind] = 0;
      }
      epistemicStatements += scored.statements.length;
      epistemicCorrect += scored.statements.length - epistemicViolationCount(scored.verdict);

      // Grounded answer-key assertions: the frozen manifest must reproduce the
      // corpus's declared verdict, epistemic labels, and citation resolvability.
      const labels = [...new Set(scored.statements.map((statement) => statement.class))].sort();
      const expectedLabels = [...fixture.expected.epistemic_labels].sort();
      if (JSON.stringify(labels) !== JSON.stringify(expectedLabels)) {
        log(`answer-key mismatch: ${fixture.id} epistemic_labels expected ${JSON.stringify(expectedLabels)} got ${JSON.stringify(labels)}`);
        process.exitCode = 1;
      }
      const resolvable = observed.every((statement) => statement.source_refs.every((ref) => api.resolveSource(scored.narrativeDir, ref).status === "resolved"));
      if ((fixture.expected.citations === "resolvable") !== resolvable) {
        log(`answer-key mismatch: ${fixture.id} citations expected ${fixture.expected.citations} resolvable=${resolvable}`);
        process.exitCode = 1;
      }
    }
  }

  const accepts = results.filter((result) => result.actual === "accept").length;
  const rejects = results.filter((result) => result.actual === "reject").length;
  const knownGaps = results.filter((result) => result.actual === "known_gap").length;

  const rate = (numerator, denominator) => (denominator === 0 ? 0 : numerator / denominator);
  const unsupportedRate = rate(unsupportedObserved, observedTotal);
  const citationResolvability = rate(citationsResolved, citationsTotal);
  const materialCoverage = rate(materialCovered, materialTotal);
  const epistemicAccuracy = rate(epistemicCorrect, epistemicStatements);

  // Cross-runtime capability parity — DECLARED, not discovered (AC3/R7). Read the
  // #620 declaration and assert the emitted block equals it for >=2 runtimes.
  const capabilityParity = [];
  for (const expectation of corpus.capability_parity_expectations) {
    const declared = capdecl.queryCapability(expectation.runtime, expectation.capability).status;
    capabilityParity.push({ runtime: expectation.runtime, capability: expectation.capability, declared_status: declared });
    if (declared !== expectation.declared_status) {
      log(`capability parity mismatch: ${expectation.runtime}/${expectation.capability} declared=${declared} expected=${expectation.declared_status}`);
      process.exitCode = 1;
    }
  }

  const evalResult = {
    schema_version: "narrative-eval-result/v1",
    work_item: corpus.work_item,
    measurement_note: "Per-corpus deterministic measurements over frozen manifests, not proofs; no metric is asserted from a single fixture, model, or runtime.",
    results,
    metrics: {
      unsupported_claim_rate: unsupportedRate,
      citation_precision: citationResolvability,
      citation_recall: materialCoverage,
      citation_resolvability: citationResolvability,
      material_claim_coverage: materialCoverage,
      omission_rate_by_class: omissionByClass,
      epistemic_classification_accuracy: epistemicAccuracy,
    },
    uncertainty: {
      unsupported_claim_rate: { sample_n: observedTotal, range: [unsupportedRate, unsupportedRate], basis: `${observedTotal} observed statement(s) across the honest corpus` },
      citation_resolvability: { sample_n: citationsTotal, range: [citationResolvability, citationResolvability], basis: `${citationsTotal} observed citation(s) resolved offline` },
      material_claim_coverage: { sample_n: materialTotal, range: [materialCoverage, materialCoverage], basis: `${materialTotal} material claim(s) across the honest corpus` },
      epistemic_classification_accuracy: { sample_n: epistemicStatements, range: [epistemicAccuracy, epistemicAccuracy], basis: `${epistemicStatements} classified statement(s) across the honest corpus` },
    },
    capability_parity: capabilityParity,
    known_gaps: [
      { code: "contradiction_detection_unavailable", detail: "The contradictory fixture is authored but contradiction detection is an upstream gap; it is disclosed as a known_gap, not scored as real detection.", ref: "kontourai/flow-agents#568" },
    ],
  };

  const schemaIssues = api.validateNarrativeEvalResult(evalResult);
  if (schemaIssues.length > 0) {
    log(`eval-result schema invalid: ${schemaIssues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    process.exitCode = 1;
  }
  const outPath = process.env.NARRATIVE_EVAL_RESULT_OUT;
  if (outPath) fs.writeFileSync(outPath, `${JSON.stringify(evalResult, null, 2)}\n`);

  console.log(`fixture provenance: ${corpus.work_item} ${corpus.schema_version}`);
  console.log(`scorer counts: accept=${accepts} reject=${rejects} known_gap=${knownGaps} total=${results.length}`);
  console.log(`unsupported observed-claim rate=${unsupportedRate}`);
  console.log(`citation resolvability=${citationResolvability}`);
  console.log(`material-claim coverage=${materialCoverage}`);
  console.log(`epistemic classification accuracy=${epistemicAccuracy}`);
  for (const parity of capabilityParity) console.log(`capability parity: ${parity.runtime}/${parity.capability}=${parity.declared_status}`);
  console.log(`eval-result schema-valid: ${schemaIssues.length === 0} (${results.length} results)`);
  for (const result of results) console.log(`${result.id}: expected=${result.expected} actual=${result.actual}`);

  if (results.some((result) => !result.pass)) process.exitCode = 1;
  if (mode === "all") {
    if (unsupportedRate !== corpus.thresholds.unsupported_observed_claim_rate) process.exitCode = 1;
    if (citationResolvability !== corpus.thresholds.citation_resolvability) process.exitCode = 1;
    if (materialCoverage !== corpus.thresholds.material_claim_coverage) process.exitCode = 1;
    if (epistemicAccuracy !== corpus.thresholds.epistemic_classification_accuracy) process.exitCode = 1;
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
