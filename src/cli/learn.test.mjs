// Correction-recurrence learning source (kits/knowledge/learn). Synthetic fixtures only: see learn-support.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { toolInvoker } from "../../kits/knowledge/learn/model.js";
import { modelJudge, parseJudgement, readRulesFile } from "../../kits/knowledge/learn/judge.js";
import { DEFAULT_THRESHOLDS, ENFORCEMENT_LADDER, qualifies, readLedger } from "../../kits/knowledge/learn/propose.js";
import { runLearn } from "../../kits/knowledge/learn/run.js";
import { main as learnMain, parseSince } from "../../kits/knowledge/learn/cli.js";
import { isContinuationPing, parseClassification } from "../../kits/knowledge/learn/classify.js";
import { scorePredictions } from "../../kits/knowledge/learn/evaluate.js";
import { readHumanTurns } from "../../kits/knowledge/learn/sessions.js";
import {
  CANARIES, DAY_MS, NOW_MS, THEME_RULES, claudeSession, ferryDerivesOrigin, fix, readMessagesWithFixtureOrigin, recordingRuntime,
  sessionId, sessionsWith, testReader, transcriptRoot, workspace,
} from "./learn-support.mjs";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const require = createRequire(import.meta.url);
const SCHEMA = path.resolve(import.meta.dirname, "..", "..", "scripts", "telemetry", "learning-review-proposals.schema.json");

async function learn(sessions, { runtime = recordingRuntime(), ws = workspace(), rulesFile = null, judge, ...extra } = {}) {
  const root = transcriptRoot(sessions);
  const invoke = toolInvoker(runtime);
  const document = await runLearn({
    roots: [root], ledgerPath: ws.ledger, nowMs: NOW_MS, sinceMs: NOW_MS - 60 * DAY_MS, invoke,
    rulesFile, judge: judge ?? (rulesFile ? modelJudge(invoke) : undefined), readMessages: testReader(), ...extra,
  });
  return { document, runtime, ws, root };
}

const sentText = (runtime) => runtime.requests.map((request) => request.messages[0].content).join("\n");
const ledgerLines = (ws) => (fs.existsSync(ws.ledger) ? fs.readFileSync(ws.ledger, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

// Five sessions; "fetch-main" is corrected once in each (5 occurrences / 5 sessions), "batch-prs" once in two.
const RECURRING = () => sessionsWith([
  [fix("fetch-main"), "add a test for the parser"],
  [fix("fetch-main"), fix("batch-prs")],
  [fix("fetch-main"), "looks good"],
  [fix("fetch-main"), fix("batch-prs")],
  [fix("fetch-main")],
]);

// ── origin: only a person's turns count ─────────────────────────────────────────────────────────────────────────

test("only origin.kind human counts: agent briefs, SDK prompts, harness, compaction and sidechain turns never reach the classifier or a proposal", async () => {
  const echo = fix("fetch-main", 3, "correction", "ORCHESTRATOR BRIEF: remember the rules");
  // The orchestrator repeats the rule to delegates in every session: 5 sessions x 4 non-human turns carrying the tag.
  const nonHuman = [
    { text: echo, origin: { kind: "coordinator" } },                 // agent (peer/coordinator)
    { text: echo, origin: { kind: "human" }, promptSource: "sdk" },   // SDK-submitted brief: Claude stamps human, Ferry says unknown
    { text: `<system-reminder>${echo}</system-reminder>`, bare: true }, // harness envelope (no origin, no promptSource)
    { text: echo, isCompactSummary: true, promptSource: "system" },   // compaction summary
  ];
  const sessions = sessionsWith(Array.from({ length: 5 }, (_, n) => [...nonHuman, n < 2 ? fix("pin-sha") : "thanks for the summary"]));
  const { document, runtime } = await learn(sessions);
  assert.equal(document.outcome, "ok");
  // The pre-import shim (runtime-ferry-shims.js) already drops coordinator and compaction lines before Ferry, so
  // the reader may see 15 or 25 user messages depending on the Ferry version; exactly 5 are human either way.
  assert.ok(document.report.user_messages >= 15, String(document.report.user_messages));
  assert.equal(document.report.user_messages_by_origin.human, 5, JSON.stringify(document.report.user_messages_by_origin));
  assert.ok(!sentText(runtime).includes("ORCHESTRATOR BRIEF"), "no non-human turn was sent to the classifier");
  assert.equal(document.report.occurrences, 2, "only the two typed pin-sha corrections count");
  assert.deepEqual(document.proposals, [], "20 echoed briefs make no proposal; 2 human corrections are under threshold");
});

test("a user message with no origin at all is never human, and a run that sees only those refuses rather than reporting nothing", async () => {
  const ws = workspace();
  const root = transcriptRoot(RECURRING());
  const stripOrigin = (harness, content) => {
    const parsed = readMessagesWithFixtureOrigin(harness, content);
    return { ...parsed, messages: parsed.messages.map(({ origin, ...message }) => message) };
  };
  const common = { roots: [root], ledgerPath: ws.ledger, nowMs: NOW_MS, sinceMs: NOW_MS - 60 * DAY_MS, readMessages: stripOrigin };
  await assert.rejects(runLearn({ ...common, invoke: toolInvoker(recordingRuntime()) }), { code: "LEARN_ORIGIN_UNAVAILABLE" });
  const dry = await runLearn({ ...common, dryRun: true });
  assert.equal(dry.outcome, "origin-unavailable");
  assert.equal(dry.report.human_turns_in_window, 0);
  assert.equal(fs.existsSync(ws.ledger), false);
});

test("real Ferry derives the origins these fixtures rely on", (t) => {
  if (!ferryDerivesOrigin()) {
    t.skip("installed @kontourai/ferry predates Message.origin (< 0.8.0); the stand-in reader covers the pipeline until the bump lands");
    return;
  }
  const content = Buffer.from(claudeSession(sessionId(7), NOW_MS - DAY_MS, [
    { text: "typed by a person" },
    { text: "a brief", origin: { kind: "human" }, promptSource: "sdk" },
    { text: "a coordinator", origin: { kind: "coordinator" } },
  ]));
  const { turns, report } = readHumanTurns({ roots: [path.dirname(writeTemp(content))], sinceMs: null, untilMs: null });
  assert.deepEqual(turns.map((turn) => turn.text), ["typed by a person"]);
  assert.deepEqual(report.user_messages_by_origin, { agent: 1, human: 1, unknown: 1 });
});

function writeTemp(content) {
  const dir = makeFixtureDir("learn-one-");
  const file = path.join(dir, `${sessionId(7)}.jsonl`);
  fs.writeFileSync(file, content);
  return file;
}

// ── noise classes ─────────────────────────────────────────────────────────────────────────────────────────────────

test("continuation pings are dropped before any model call", async () => {
  for (const ping of ["continue", "Still moving?", "keep going!", "ok", "status?", "  thanks  "]) assert.equal(isContinuationPing(ping), true, ping);
  for (const real of ["continue, but fetch main first", "why did you stop?", "no"]) assert.equal(isContinuationPing(real), false, real);
  const sessions = sessionsWith([["continue", "still moving?", fix("fetch-main")], ["keep going"], ["status?"]]);
  const { document, runtime } = await learn(sessions);
  assert.equal(document.report.continuation_pings_excluded, 4);
  assert.equal(document.report.candidates, 1);
  assert.ok(!/<message i="\d+">\s*(continue|still moving\?|keep going|status\?)\s*<\/message>/.test(sentText(runtime)));
});

test("one-off corrections and classifier items that break the rule bound do not count", async () => {
  const batch = [{ text: "a" }, { text: "b" }];
  const { results } = parseClassification({ items: [
    { i: 0, kind: "correction", pain: 1, rule: Array.from({ length: 16 }, () => "word").join(" "), general: true },
    { i: 1, kind: "nudge", pain: 4, rule: "fine", general: true },
  ] }, batch);
  assert.deepEqual(results, [null, null], "a 16-word rule and pain 4 are refused, not truncated or clamped");
  assert.throws(() => parseClassification({ items: [{ i: 0, kind: "correction", pain: 1, rule: "x", general: true }] }, batch), { code: "LEARN_MODEL_FAILED" });
  const sessions = sessionsWith([[`[oneoff:fetch-main] fix just this file`], [`[oneoff:fetch-main] and this one`], ["hello"]]);
  const { document } = await learn(sessions);
  assert.equal(document.report.occurrences, 0);
});

// ── thresholds ───────────────────────────────────────────────────────────────────────────────────────────────────

test("threshold defaults are 5 occurrences in 3 sessions, or 2 high-pain (pain 3)", () => {
  assert.deepEqual({ ...DEFAULT_THRESHOLDS }, { minOccurrences: 5, minSessions: 3, minHighPain: 2, highPainLevel: 3 });
  const row = (occurrences, sessions, pains) => ({ occurrences, sessions, pain_levels: pains ?? Array(occurrences).fill(1) });
  assert.equal(qualifies(row(5, 3)), true, "5 in 3: at both bounds");
  assert.equal(qualifies(row(4, 3)), false, "one occurrence short");
  assert.equal(qualifies(row(5, 2)), false, "one session short");
  assert.equal(qualifies(row(2, 1, [3, 3])), true, "two high-pain in one session");
  assert.equal(qualifies(row(2, 1, [3, 2])), false, "pain 2 is not high pain");
});

test("pipeline threshold boundary: 5 occurrences in 3 sessions proposes, 4 does not", async () => {
  const five = sessionsWith([[fix("fetch-main"), fix("fetch-main")], [fix("fetch-main"), fix("fetch-main")], [fix("fetch-main")]]);
  const four = sessionsWith([[fix("fetch-main"), fix("fetch-main")], [fix("fetch-main")], [fix("fetch-main")]]);
  const yes = await learn(five);
  const no = await learn(four);
  assert.deepEqual(yes.document.proposals.map((proposal) => proposal.theme.label), [THEME_RULES["fetch-main"]]);
  assert.equal(yes.document.proposals[0].evidence.cost.occurrences, 5);
  assert.equal(yes.document.proposals[0].evidence.cost.sessions, 3);
  assert.deepEqual(no.document.proposals, []);
  const highPain = sessionsWith([[fix("act-on-recommendation", 3), fix("act-on-recommendation", 3)], ["hi"], ["hi"]]);
  assert.equal((await learn(highPain)).document.proposals.length, 1, "two pain-3 episodes in one session propose");
});

// ── proposals, citations, ledger ─────────────────────────────────────────────────────────────────────────────────

test("a proposal cites Thread message locators with short scrubbed excerpts, starts as a prose rule, and is advisory", async () => {
  const { document, ws } = await learn(RECURRING());
  const [proposal] = document.proposals;
  assert.equal(proposal.proposal_id, "correction-recurrence-agents-md-fetch-latest-main-before-starting-any-work");
  assert.equal(proposal.severity, "advisory");
  assert.equal(proposal.enforcement.recommended, "agents-md");
  assert.deepEqual(proposal.enforcement.ladder, ["agents-md", "skill", "hook", "veritas-check"]);
  assert.equal(proposal.decision.status, "proposed");
  assert.equal(proposal.evidence.defect.citations.length, 5);
  for (const citation of proposal.evidence.defect.citations) {
    assert.match(citation.thread_id, /^claude-code:[0-9a-f-]{36}$/);
    assert.match(citation.message_id, /^[0-9a-f-]{36}$/);
    assert.ok(Buffer.byteLength(citation.excerpt) <= 200);
  }
  assert.equal(proposal.conflict, null);
  assert.deepEqual(proposal.conflict_check, { status: "skipped", file: null });
  assert.equal(ledgerLines(ws).length, 1);
});

test("ledger idempotence: a second identical run appends nothing, rewrites nothing, and marks proposals already proposed", async () => {
  const ws = workspace();
  fs.mkdirSync(path.dirname(ws.ledger), { recursive: true });
  const v01 = '{"proposal_id":"all_all_kit-builder_kit-review-cost-inflation","target":{"kind":"kit","id":"builder"},"pattern":"kit-review-cost-inflation","decision":{"status":"proposed"}}';
  fs.writeFileSync(ws.ledger, `${v01}\n`);
  const sessions = RECURRING();
  const first = await learn(sessions, { ws });
  const afterFirst = fs.readFileSync(ws.ledger, "utf8");
  const queueFirst = fs.readFileSync(ws.reviewItems, "utf8");
  const second = await learn(sessions, { ws });
  assert.equal(fs.readFileSync(ws.ledger, "utf8"), afterFirst, "the ledger is byte-identical after the second run");
  assert.equal(fs.readFileSync(ws.reviewItems, "utf8"), queueFirst);
  assert.equal(afterFirst.split("\n")[0], v01, "a v0.1 line from another producer keeps its exact bytes");
  assert.deepEqual(first.document.proposals.map((p) => p.already_proposed), [false]);
  assert.deepEqual(second.document.proposals.map((p) => p.already_proposed), [true]);
  const ids = ledgerLines(ws).map((entry) => entry.proposal_id);
  assert.equal(new Set(ids).size, ids.length);
});

test("dry run makes no model call and writes nothing, through the CLI", async () => {
  const ws = workspace();
  const root = transcriptRoot(RECURRING());
  let runtimeBuilt = 0;
  const out = [];
  const err = [];
  const code = await learnMain(["--dry-run", "--json", "--transcripts", root, "--ledger", ws.ledger, "--since", "60d"], {
    stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env: {}, cwd: ws.root, nowMs: NOW_MS,
    createRuntime: async () => { runtimeBuilt += 1; return recordingRuntime(); },
  });
  assert.equal(code, 0, err.join(""));
  assert.equal(runtimeBuilt, 0, "no model runtime is even built");
  assert.deepEqual(fs.readdirSync(ws.root), [], "nothing was created under the workspace");
  const document = JSON.parse(out.join(""));
  assert.equal(document.dry_run, true);
  assert.equal(document.report.model_calls, 0);
  assert.deepEqual(document.proposals, []);
  // On an installed Ferry without origin the dry run says so instead of counting turns it cannot attribute.
  if (ferryDerivesOrigin()) assert.equal(document.report.candidates, 7);
  else assert.equal(document.outcome, "origin-unavailable");
});

test("insufficient history is reported, not turned into proposals, and spends no model call", async () => {
  const { document, runtime, ws } = await learn(sessionsWith([[fix("fetch-main", 3), fix("fetch-main", 3)], [fix("fetch-main", 3)]]));
  assert.equal(document.outcome, "insufficient-data");
  assert.equal(runtime.requests.length, 0);
  assert.equal(fs.existsSync(ws.ledger), false);
});

// ── privacy ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("redaction happens before the model: no secret reaches any request, the scrub markers do, and the ledger holds none", async () => {
  const leak = `my token is ${CANARIES.github} and key ${CANARIES.openai}; password=${CANARIES.assign}`;
  const sessions = sessionsWith(Array.from({ length: 5 }, () => [
    { role: "assistant", text: `I used ${CANARIES.openai} to call the API.` },
    fix("fetch-main", 2, "correction", leak),
  ]));
  const { runtime, ws } = await learn(sessions);
  const sent = JSON.stringify(runtime.requests);
  for (const value of Object.values(CANARIES)) assert.ok(!sent.includes(value), "a canary reached the model");
  assert.match(sent, /<SECRET>/);
  const ledger = fs.readFileSync(ws.ledger, "utf8");
  for (const value of Object.values(CANARIES)) assert.ok(!ledger.includes(value), "a canary reached the ledger");
  assert.match(ledger, /<SECRET>/, "the excerpt is the scrubbed text");
});

// ── conflict judge ───────────────────────────────────────────────────────────────────────────────────────────────

function rulesFile(lines) {
  const file = path.join(makeFixtureDir("learn-rules-"), "AGENTS.md");
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

test("conflict plumbing: the judge's cited line becomes the proposal's conflict and a current/proposed review item", async () => {
  const file = rulesFile(["# Rules", "", "- Ask before acting on any recommendation you make.", "- Keep PRs small."]);
  const runtime = recordingRuntime({ judgements: { [THEME_RULES["fetch-main"]]: { relation: "conflicts", needle: "Ask before acting" } } });
  const { document, ws } = await learn(RECURRING(), { runtime, rulesFile: file });
  const [proposal] = document.proposals;
  assert.deepEqual(proposal.conflict_check, { status: "checked", file: "AGENTS.md" });
  assert.deepEqual({ ...proposal.conflict, explanation: undefined }, { file: "AGENTS.md", line: 3, text: "- Ask before acting on any recommendation you make.", explanation: undefined, judge: "model" });
  const queue = JSON.parse(fs.readFileSync(ws.reviewItems, "utf8"));
  const item = queue.items.find((candidate) => candidate.metadata.name === `learn-${proposal.proposal_id}`);
  assert.deepEqual(item.spec.candidates.map((candidate) => [candidate.role, candidate.value]), [["current", "- Ask before acting on any recommendation you make."], ["proposed", THEME_RULES["fetch-main"]]]);
});

test("a rule the file already covers still recurring is escalated to a skill", async () => {
  const file = rulesFile(["- Always fetch latest main before you start."]);
  const runtime = recordingRuntime({ judgements: { [THEME_RULES["fetch-main"]]: { relation: "covers", needle: "fetch latest main" } } });
  const { document } = await learn(RECURRING(), { runtime, rulesFile: file });
  const [proposal] = document.proposals;
  assert.equal(proposal.enforcement.recommended, "skill");
  assert.equal(proposal.target.kind, "skill");
  assert.equal(proposal.covered_by.line, 1);
  assert.equal(proposal.conflict, null);
});

test("a judge answer citing a line that does not exist is refused, and the run writes nothing", async () => {
  const file = rulesFile(["- one rule", "", "- another"]);
  const rules = readRulesFile(file);
  assert.throws(() => parseJudgement({ relation: "conflicts", line: 2, explanation: "x" }, rules), { code: "LEARN_MODEL_FAILED" }, "a blank line");
  assert.throws(() => parseJudgement({ relation: "covers", line: 99, explanation: "x" }, rules), { code: "LEARN_MODEL_FAILED" });
  const runtime = recordingRuntime({ judgements: { [THEME_RULES["fetch-main"]]: { relation: "conflicts", needle: "nothing", line: 99 } } });
  const ws = workspace();
  await assert.rejects(learn(RECURRING(), { runtime, rulesFile: file, ws }), { code: "LEARN_MODEL_FAILED" });
  assert.equal(fs.existsSync(ws.ledger), false);
});

test("a model call without its tool call fails the run before any write", async () => {
  const ws = workspace();
  await assert.rejects(learn(RECURRING(), { runtime: recordingRuntime({ failOn: "assign_rule_themes" }), ws }), { code: "LEARN_MODEL_FAILED" });
  assert.equal(fs.existsSync(ws.ledger), false);
});

// ── effect-fill and escalation ───────────────────────────────────────────────────────────────────────────────────

function ratifiedEntry(kind, decidedDaysAgo, ratePerWeek) {
  const label = THEME_RULES["fetch-main"];
  return {
    proposal_id: `correction-recurrence-${kind}-fetch-latest-main-before-starting-any-work`,
    source: { family: "correction-recurrence", producer: "knowledge.learn", contract_version: "0.2", classifier_version: "1" },
    target: { kind, id: "AGENTS.md" }, pattern: "correction-recurrence", theme: { id: "fetch-latest-main-before-starting-any-work", label }, rule: label,
    proposed_change: "x", severity: "advisory",
    evidence: { cost: { occurrences: 6, sessions: 4, rate_per_week: ratePerWeek }, defect: { rule: label, general: true, citations: [], citations_total: 6 } },
    enforcement: { recommended: kind }, conflict: null, expected_effect: { metric: "recurrence_per_week", direction: "decrease", description: "x" },
    decision: { status: "ratified", decided_by: "tester", decided_at: new Date(NOW_MS - decidedDaysAgo * DAY_MS).toISOString(), rationale: null },
    follow_on_ref: null, effect_observed: null, window: { since: 0, until: 1 },
  };
}

test("effect-fill measures recurrence after ratification, and a ratified rule that did not stop it escalates one rung", async () => {
  const ws = workspace();
  fs.mkdirSync(path.dirname(ws.ledger), { recursive: true });
  fs.writeFileSync(ws.ledger, `${JSON.stringify(ratifiedEntry("agents-md", 21, 0.5))}\n`);
  // Ratified 21 days ago; the RECURRING sessions fall 20..16 days ago, so all 5 occurrences are after it.
  const { document } = await learn(RECURRING(), { ws });
  const [filled] = ledgerLines(ws);
  assert.equal(filled.effect_observed.metric, "recurrence_per_week");
  assert.equal(filled.effect_observed.after_occurrences, 5);
  assert.equal(filled.effect_observed.before, 0.5);
  assert.equal(filled.effect_observed.after, Math.round((5 * 7 / 21) * 10000) / 10000);
  assert.equal(filled.effect_observed.moved, "worsened");
  assert.equal(filled.decision.status, "ratified", "the human decision is kept");
  // The theme id was reused from the ledger, and the next proposal climbs the ladder.
  const [proposal] = document.proposals;
  assert.equal(proposal.theme.id, "fetch-latest-main-before-starting-any-work");
  assert.equal(proposal.enforcement.recommended, ENFORCEMENT_LADDER[1]);
  assert.match(proposal.enforcement.reason, /did not reduce the recurrence \(worsened\)/);
});

test("effect-fill counts zero recurrence as improvement, and waits when the window or the elapsed time cannot measure it", async () => {
  const quiet = sessionsWith([["add a parser test"], ["looks good"], ["ship it"]]);
  const ws = workspace();
  fs.mkdirSync(path.dirname(ws.ledger), { recursive: true });
  fs.writeFileSync(ws.ledger, `${JSON.stringify(ratifiedEntry("agents-md", 30, 1.5))}\n${JSON.stringify({ ...ratifiedEntry("skill", 5, 1.5), proposal_id: "too-recent" })}\n`);
  await learn(quiet, { ws });
  const [measured, recent] = ledgerLines(ws);
  assert.deepEqual([measured.effect_observed.after, measured.effect_observed.moved], [0, "improved"]);
  assert.equal(recent.effect_observed, null, "5 days is under the 14-day minimum");
  const ws2 = workspace();
  fs.mkdirSync(path.dirname(ws2.ledger), { recursive: true });
  fs.writeFileSync(ws2.ledger, `${JSON.stringify(ratifiedEntry("agents-md", 50, 1.5))}\n`);
  await learn(quiet, { ws: ws2, sinceMs: NOW_MS - 40 * DAY_MS });
  assert.equal(ledgerLines(ws2)[0].effect_observed, null, "a window starting after the decision cannot see what came between");
});

test("a corrupt ledger line stops the run before anything is written", async () => {
  const ws = workspace();
  fs.mkdirSync(path.dirname(ws.ledger), { recursive: true });
  fs.writeFileSync(ws.ledger, '{"proposal_id":"ok"}\nnot json\n');
  const before = fs.readFileSync(ws.ledger, "utf8");
  await assert.rejects(learn(RECURRING(), { ws }), { code: "LEARN_LEDGER_CORRUPT" });
  assert.equal(fs.readFileSync(ws.ledger, "utf8"), before);
  assert.throws(() => readLedger(ws.ledger), { code: "LEARN_LEDGER_CORRUPT" });
});

// ── contract ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("the v0.2 schema accepts the learn document and ledger lines, still accepts v0.1, and refuses a correction proposal without citations", async () => {
  const Ajv = require("ajv");
  const validate = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(fs.readFileSync(SCHEMA, "utf8")));
  const file = rulesFile(["- Ask before acting on any recommendation you make."]);
  const runtime = recordingRuntime({ judgements: { [THEME_RULES["fetch-main"]]: { relation: "conflicts", needle: "Ask before" } } });
  const { document, ws } = await learn(RECURRING(), { runtime, rulesFile: file });
  assert.equal(validate(document), true, JSON.stringify(validate.errors));
  const wrap = (proposals, version = "0.2") => ({ schema: "kontour.learning-review-proposals", version, window: { since: null, until: null }, outcome: "ok", aggregates: { by_kit: [], by_gate: [], partial: false }, proposals });
  assert.equal(validate(wrap(ledgerLines(ws))), true, JSON.stringify(validate.errors));
  const bare = structuredClone(document.proposals[0]);
  bare.evidence.defect.citations = [];
  assert.equal(validate(wrap([bare])), false, "a correction-recurrence proposal must cite at least one message");
  const noEnforcement = structuredClone(document.proposals[0]);
  delete noEnforcement.enforcement;
  assert.equal(validate(wrap([noEnforcement])), false);
  const v01 = { proposal_id: "x", target: { kind: "gate", id: "g" }, pattern: "gate-false-block-review", proposed_change: "x", evidence: { cost: {}, defect: {} }, expected_effect: { metric: "false_block_rate", direction: "decrease", description: "x" }, decision: { status: "proposed", decided_by: null, decided_at: null, rationale: null } };
  assert.equal(validate(wrap([v01], "0.1")), true, JSON.stringify(validate.errors));
});

test("--since accepts Nd, a date and an ISO timestamp, and refuses anything else", () => {
  assert.equal(parseSince("30d", NOW_MS), NOW_MS - 30 * DAY_MS);
  assert.equal(parseSince("2026-10-01", NOW_MS), Date.parse("2026-10-01T00:00:00Z"));
  assert.equal(parseSince("2026-10-01T12:00:00Z", NOW_MS), Date.parse("2026-10-01T12:00:00Z"));
  for (const bad of ["yesterday", "30", "0d", "2026-13-45", "2026-10-01 12:00"]) assert.throws(() => parseSince(bad, NOW_MS), { code: "LEARN_USAGE" }, bad);
});

// ── evaluation harness scoring ───────────────────────────────────────────────────────────────────────────────────

test("evaluation scoring: precision and recall of 'counts as a correction' against labels", () => {
  const labels = [
    { key: "a", label: "correction", general: true },
    { key: "b", label: "nudge", general: true },
    { key: "c", label: "none" },
    { key: "d", label: "correction", general: false },
    { key: "e", label: "frustration", general: true },
  ];
  const predictions = [
    { key: "a", kind: "correction", general: true },  // TP
    { key: "b", kind: "none", general: false },       // FN
    { key: "c", kind: "nudge", general: true },       // FP
    { key: "d", kind: "correction", general: true },  // FP (labelled one-off)
    // e: no prediction -> unscored, reported as missing
  ];
  const score = scorePredictions(labels, predictions);
  assert.deepEqual(score.confusion, { tp: 1, fp: 2, fn: 1, tn: 0 });
  assert.equal(score.precision, 0.3333);
  assert.equal(score.recall, 0.5);
  assert.deepEqual(score.missing, ["e"]);
});
