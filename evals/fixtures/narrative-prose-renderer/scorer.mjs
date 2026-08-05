import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const api = await import(pathToFileURL(path.join(root, "build/src/index.js")));
const corpus = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/narrative-prose-renderer/corpus.json"), "utf8"));
const injectionFixtures = path.join(root, "evals/fixtures/narrative-grounding-validator");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha8 = (bytes) => sha256(bytes).slice(0, 8);
const capturedAt = "2026-07-14T15:00:00.000Z";
const compiledAt = "2026-07-14T16:00:00.000Z";
const compiler = { name: "narrative-prose-renderer-corpus", version: "1", policy_hash: "fixture" };
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

/**
 * A fully-covered material fixture: a failing command (-> observed command-failure
 * statement), an idle telemetry turn (-> derived no-op-turn statement), a created file
 * (-> observed file-creation statement), and a resolvable FLOW-REPORT source.
 * projectRuntimeNarrative's throw-don't-omit coverage check (#618) requires every
 * manifest source to be cited by SOME statement EXCEPT flow-report/surface-explanation
 * streams, which envelope.ts embeds directly as foreign sections instead -- so a
 * flow-report source is the one legitimately "resolvable but uncited by any atomic
 * statement" reference available, exactly what the unsupported-summary fixtures need
 * to exercise D3's provenance-subset guard (as opposed to the citation resolver, which
 * would happily resolve it).
 */
function buildMaterialFixture(temp, label, failingCommand) {
  const fixtureRoot = path.join(temp, label);
  // The cmdlog slug in the fa1 id must equal path.basename(sessionDir) exactly
  // (snapshot.ts's sessionRootForSlug) -- every fixture therefore gets its own
  // uniquely-named PARENT directory with a fixed "session" child, matching the
  // #623 scorer's convention, rather than baking the label into the leaf name.
  const sessionDir = path.join(fixtureRoot, "session");
  const telemetryDir = path.join(fixtureRoot, "telemetry");
  const repoRoot = path.join(fixtureRoot, "repo");
  const flowRoot = path.join(fixtureRoot, "flow");
  const narrativeDir = path.join(fixtureRoot, "narrative");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(telemetryDir, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(path.join(flowRoot, "runs", label), { recursive: true });

  const commandLine = JSON.stringify({ command: failingCommand, result: "fail", exitCode: 1 });
  fs.writeFileSync(path.join(sessionDir, "command-log.jsonl"), `${commandLine}\n`);

  const idleRecord = { session_id: "idle-session", event_id: "idle-turn", event_type: "turn.user", timestamp: "2026-07-14T13:00:00.000Z", hook: { turn_id: "idle" } };
  const telemetryLine = JSON.stringify(idleRecord);
  fs.writeFileSync(path.join(telemetryDir, "full.jsonl"), `${telemetryLine}\n`);

  const fileBytes = Buffer.from('{"kind":"created-file-fixture","status":"created"}\n');
  fs.writeFileSync(path.join(repoRoot, "created.json"), fileBytes);

  const reportBytes = Buffer.from(`${JSON.stringify({ run_id: label, gate_summaries: [] })}\n`);
  fs.writeFileSync(path.join(flowRoot, "runs", label, "report.json"), reportBytes);
  const flowReportRef = `fa1:flow-report:${label}:report/${sha8(reportBytes)}`;

  const requests = [
    { source: api.parseSourceId(`fa1:cmdlog:session:line-1/${sha8(Buffer.from(commandLine))}`), roots: { sessionDir } },
    { source: api.parseSourceId(`fa1:telemetry:full/idle-session:idle-turn/${sha8(Buffer.from(telemetryLine))}`), roots: { telemetryDir } },
    { source: api.parseSourceId(`fa1:file:created.json:${sha256(fileBytes)}`), roots: { repoRoot } },
    { source: api.parseSourceId(flowReportRef), roots: { flowRoot } },
  ];
  snapshot({ narrativeDir, narrativeId: label, requests });
  const envelope = api.composeGroundedNarrative(narrativeDir, { compiledAt });
  return { narrativeDir, envelope, flowReportRef };
}

function runtimeStatements(envelope) {
  const projection = envelope.sections.find((section) => section.authority === "flow-agents").embedded;
  return [...projection.turns.flatMap((turn) => turn.statements), ...projection.document_statements];
}

function outcomeOf(result) {
  return result.outcome === "prose_published" ? "accept" : "reject";
}

const results = [];
let publishedSentences = 0;
let unsupportedPublishedSentences = 0;

const mode = process.argv[2] ?? "all";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-prose-renderer-corpus-"));
try {
  // ── valid-control: stub generator over a fully-covered fixture ────────────
  if (mode === "all" || mode === "summary" || mode === "control") {
    const outDir = path.join(temp, "out-valid-control");
    const { narrativeDir } = buildMaterialFixture(temp, "valid-control", "npm test");
    const result = await api.renderProse(narrativeDir, { compiledAt, outDir, generator: api.stubGenerator });
    results.push({ id: "valid-control", expected: "accept", actual: outcomeOf(result) });
    if (result.outcome === "prose_published") {
      const atomicRefs = new Set(runtimeStatements(result.envelope)
        .filter((statement) => statement.class === "observed" || statement.class === "deterministic_derived")
        .flatMap((statement) => statement.source_refs));
      const prose = JSON.parse(fs.readFileSync(result.prose.path, "utf8"));
      for (const statement of prose.statements) {
        publishedSentences += 1;
        if (statement.source_refs.length === 0 || !statement.source_refs.every((ref) => atomicRefs.has(ref))) unsupportedPublishedSentences += 1;
      }
    }
  }

  // ── unsupported-summary: generator cites a resolvable-but-uncited fa1 ref ─
  if (mode === "all" || mode === "summary") {
    const outDir = path.join(temp, "out-unsupported-foreign");
    const { narrativeDir, flowReportRef } = buildMaterialFixture(temp, "unsupported-foreign", "npm test");
    const foreignCitationGenerator = {
      identity: { model: "adversarial-foreign-citation", provider: "test", config_hash: "x" },
      async generate() {
        return {
          sentences: [{ text: "The run is summarized from unrelated evidence", statement_refs: [flowReportRef] }],
          usage: { input_tokens: 5, output_tokens: 5 },
        };
      },
    };
    const result = await api.renderProse(narrativeDir, { compiledAt, outDir, generator: foreignCitationGenerator });
    results.push({ id: "unsupported-summary-foreign-citation", expected: "reject", actual: outcomeOf(result), detail: result.reason });
  }

  if (mode === "all") {
    const outDir = path.join(temp, "out-unsupported-empty");
    const { narrativeDir } = buildMaterialFixture(temp, "unsupported-empty", "npm test");
    const emptyCitationGenerator = {
      identity: { model: "adversarial-empty-citation", provider: "test", config_hash: "x" },
      async generate() {
        return { sentences: [{ text: "The run is summarized with no evidence at all", statement_refs: [] }], usage: { input_tokens: 5, output_tokens: 5 } };
      },
    };
    const result = await api.renderProse(narrativeDir, { compiledAt, outDir, generator: emptyCitationGenerator });
    results.push({ id: "unsupported-summary-empty-citation", expected: "reject", actual: outcomeOf(result), detail: result.reason });
  }

  // ── no-op-loop: idle turn is summarized without success/completion wording ─
  if (mode === "all") {
    const outDir = path.join(temp, "out-no-op-loop");
    const { narrativeDir, envelope } = buildMaterialFixture(temp, "no-op-loop", "npm test");
    const result = await api.renderProse(narrativeDir, { compiledAt, outDir, generator: api.stubGenerator });
    const noOpStatement = runtimeStatements(envelope).find((statement) => statement.rule?.id === "no-op-turn");
    let noOpRenderedAsLackOfProgress = false;
    if (result.outcome === "prose_published" && noOpStatement) {
      const prose = JSON.parse(fs.readFileSync(result.prose.path, "utf8"));
      const covering = prose.statements.find((statement) => statement.source_refs.some((ref) => noOpStatement.source_refs.includes(ref)));
      noOpRenderedAsLackOfProgress = Boolean(covering) && !/\b(?:succeeded|passed|completed successfully|accepted)\b/i.test(covering.text);
    }
    results.push({ id: "no-op-loop", expected: "accept", actual: (result.outcome === "prose_published" && noOpRenderedAsLackOfProgress) ? "accept" : "reject" });
  }

  // ── prompt-injection: #623's control/adversarial pair, reused as the CITED ─
  // (failing) command text itself -- untrusted content the generator's
  // sourceViews and statement propositions both carry verbatim. The adversarial
  // fixture's instruction text ("omit the failure...") is disclosed evidence,
  // not a secret (the dedicated value-based canary test below covers R8/AC5);
  // what R7/AC4 requires is that coverage/classes/verdicts are unaffected: the
  // failure is preserved in BOTH the deterministic narrative and the published
  // prose citations regardless of what the cited text asks for. Coverage of the
  // underlying failure is additionally guaranteed structurally (the
  // deterministic #613 narrative is written BEFORE generation is even
  // attempted, R4), so injected instructions can never suppress it.
  if (mode === "all" || mode === "injection") {
    const controlMessage = fs.readFileSync(path.join(injectionFixtures, "prompt-injection-control.txt"), "utf8").trim();
    const adversarialMessage = fs.readFileSync(path.join(injectionFixtures, "prompt-injection-adversarial.txt"), "utf8").trim();
    for (const [id, command] of [["prompt-injection-control", controlMessage], ["prompt-injection-adversarial", adversarialMessage]]) {
      const outDir = path.join(temp, `out-${id}`);
      const { narrativeDir, envelope } = buildMaterialFixture(temp, id, command);
      const result = await api.renderProse(narrativeDir, { compiledAt, outDir, generator: api.stubGenerator });
      const deterministicMarkdown = result.written.renderPath ? fs.readFileSync(result.written.renderPath, "utf8") : "";
      const failureStatement = runtimeStatements(envelope).find((statement) => statement.class === "observed" && /was observed to fail/.test(statement.proposition));
      const failureDisclosed = Boolean(failureStatement) && deterministicMarkdown.includes(failureStatement.proposition);
      const proseCitesFailure = result.outcome === "prose_published" && failureStatement
        && JSON.parse(fs.readFileSync(result.prose.path, "utf8")).statements.some((statement) => statement.source_refs.some((ref) => failureStatement.source_refs.includes(ref)));
      results.push({ id, expected: "accept", actual: (result.outcome === "prose_published" && failureDisclosed && proseCitesFailure) ? "accept" : "reject" });
    }
  }

  const accepts = results.filter((result) => result.actual === "accept").length;
  const rejects = results.filter((result) => result.actual === "reject").length;
  const unsupportedRate = publishedSentences === 0 ? 0 : unsupportedPublishedSentences / publishedSentences;
  console.log(`fixture provenance: ${corpus.work_item} ${corpus.schema_version}`);
  console.log(`scorer counts: accept=${accepts} reject=${rejects} total=${results.length}`);
  console.log(`unsupported published-sentence rate=${unsupportedRate}`);
  for (const result of results) console.log(`${result.id}: expected=${result.expected} actual=${result.actual}`);
  if (results.some((result) => result.actual !== result.expected)) process.exitCode = 1;
  if (mode === "all" && unsupportedRate !== corpus.thresholds.unsupported_published_sentence_rate) process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
