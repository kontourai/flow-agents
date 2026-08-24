// Output-token attribution on transition records — flow-agents#1320.
//
// THE FIXTURE IS REAL. `fixtures/transition-attribution/transitions.jsonl` is 700
// records lifted verbatim from a live `.flow-agents/telemetry/transitions.jsonl`
// (two windows of one builder run), with exactly two things changed: `cwd_repo`
// rewritten to `/repo` and `actor.session_id` remapped to `session-a`, because both
// are machine-private. Nothing else is touched — the commands, verbs, targets,
// flags, exit codes, gate verdicts, timestamps and durations are what the CLI wrote.
//
// `turns.jsonl` is DERIVED from the host transcript of that same run, carrying four
// fields per line and nothing else: `timestamp`, `sessionId`, `isSidechain` and
// `message.{id,usage.output_tokens}`. No prompt text, no tool payloads, no paths.
// Message ids are remapped through a stable counter, which preserves the property
// that matters most: one API response is logged as SEVERAL lines sharing a message
// id and identical usage totals (730 lines, 372 distinct responses), so a fixture
// that renumbered per line would silently stop exercising the de-duplication.
//
// WHAT THE REAL SLICE DOES AND DOES NOT EXERCISE, stated rather than assumed. It
// covers the two unattributable reasons that actually occur — a turn already
// consumed by an earlier transition (477) and a turn too old to be the invoking one
// (126) — and 50 records with no session id, which may match any session's turn. It
// does NOT contain `no-turn-before-transition` or a turn claimed by two SIMULTANEOUS
// transitions: the live corpus has five instants carrying two transitions each, and
// in none of them did either transition win the turn, so the ambiguity is latent
// there, not realized. Those two branches are covered by constructed cases below,
// because a guardrail whose rejection path has never executed is unproven.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Ajv from "ajv";

import { buildExpectationIndex, buildScorecard, discoverKitDirs } from "../../scripts/telemetry/gate-scorecard.mjs";
import { enrich, readLog } from "../../scripts/telemetry/enrich-transitions.mjs";
import {
  ATTRIBUTION_GRANULARITY,
  attributeTokens,
  attributionFromRecords,
  OUTPUT_TOKENS_FIELD,
  TOKEN_ATTRIBUTION_FIELD,
} from "../../scripts/telemetry/token-attribution.mjs";
import { buildTransitionRecord } from "../../build/src/transition-log.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURES = path.join(import.meta.dirname, "fixtures", "transition-attribution");
const CORPUS = path.join(FIXTURES, "transitions.jsonl");
const TURNS = path.join(FIXTURES, "turns.jsonl");
const ENRICHER = path.join(REPO_ROOT, "scripts", "telemetry", "enrich-transitions.mjs");
const SCHEMA = path.join(REPO_ROOT, "scripts", "telemetry", "transition-record.schema.json");

// Pinned so the corpus cannot be swapped for a friendlier one without the diff
// saying so. Every number below is the fixture's own, computed once and read off.
const EXPECTED = {
  transitions: 700,
  withTurn: 97,
  withoutTurn: 603,
  outputTokensFloor: 101_690,
  availableTurns: 372,
  transcriptTotal: 329_471,
  reasons: { "turn-consumed-by-earlier-transition": 477, "turn-outside-grace-window": 126 },
};

function readCorpus() {
  return fs.readFileSync(CORPUS, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function scratch(prefix = "transition-attribution-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Enrich a copy of the real corpus in memory, the way the CLI does. */
function enrichCorpus({ transcripts = [TURNS], reattribute = false } = {}) {
  const dir = scratch();
  const file = path.join(dir, "transitions.jsonl");
  fs.copyFileSync(CORPUS, file);
  const { lines, transitions } = readLog(file);
  const result = enrich({ lines, transitions, transcripts, reattribute });
  return { ...result, dir, file, transitions };
}

test("the enricher attributes the live corpus to exactly the numbers the transcript supports", () => {
  const { summary } = enrichCorpus();
  assert.equal(summary.transitions, EXPECTED.transitions);
  assert.equal(summary.transitions_with_turn, EXPECTED.withTurn);
  assert.equal(summary.transitions_without_turn, EXPECTED.withoutTurn);
  assert.equal(summary.output_tokens_floor, EXPECTED.outputTokensFloor);
  assert.equal(summary.available_turns, EXPECTED.availableTurns);
  // The whole point of the field: 97 of 700 invocations carry a number. A producer
  // that "improved" coverage to 700/700 would be inventing spend.
  assert.equal(summary.transitions_with_turn + summary.transitions_without_turn, EXPECTED.transitions);
  assert.equal(summary.granularity, ATTRIBUTION_GRANULARITY);
});

// Exact, not an upper bound. `<= total` survives both over-attribution and reach-back,
// so it proves nothing; the floor must be strictly under the transcript's own total
// because 275 of the 372 responses were never charged to any transition.
test("the attributed floor is a strict fraction of the transcript's own total", () => {
  const { summary } = enrichCorpus();
  assert.equal(summary.output_tokens_floor, EXPECTED.outputTokensFloor);
  assert.ok(
    summary.output_tokens_floor < EXPECTED.transcriptTotal,
    `the floor (${summary.output_tokens_floor}) must be under the transcript total (${EXPECTED.transcriptTotal})`,
  );
});

// THE ANTI-DRIFT TEST. The producer writes the numbers; the fold reads them back. If
// the two ever encoded the rule separately these would diverge inside a release with
// nothing to say which was right (#1300/#1302/#1307/#1312 are all that family). They
// cannot diverge here because one module computes both — and this is what proves it.
test("the producer's stamped attribution and the fold's own derivation agree exactly", () => {
  const kitDirs = discoverKitDirs(REPO_ROOT);
  const { index, gates, ambiguousExpectations } = buildExpectationIndex(kitDirs);
  assert.ok(gates.size > 0, "the repo's kits must declare gates for this comparison to mean anything");

  const raw = readCorpus();
  const fromTranscript = buildScorecard({
    transitions: raw,
    expectationIndex: index,
    gateIndex: gates,
    tokenAttribution: attributeTokens(raw, [TURNS]),
    ambiguousExpectations,
  });

  const { transitions: enriched } = enrichCorpus();
  const fromRecords = buildScorecard({
    transitions: enriched,
    expectationIndex: index,
    gateIndex: gates,
    tokenAttribution: attributionFromRecords(enriched),
    ambiguousExpectations,
  });

  const tokensByGate = (card) =>
    card.gates
      .filter((gate) => gate.output_tokens !== undefined)
      .map((gate) => [`${gate.flow}/${gate.gate}`, gate.output_tokens, gate.token_turns]);
  const tokensByVerb = (card) =>
    card.verbs.filter((verb) => verb.output_tokens !== undefined).map((verb) => [verb.verb, verb.output_tokens, verb.token_turns]);

  const gateTokens = tokensByGate(fromTranscript);
  assert.ok(gateTokens.length >= 5, `real gates must carry tokens for this to discriminate, got ${gateTokens.length}`);
  assert.deepEqual(tokensByGate(fromRecords), gateTokens);
  assert.deepEqual(tokensByVerb(fromRecords), tokensByVerb(fromTranscript));
  assert.equal(fromRecords.coverage.tokens.matched_turns, fromTranscript.coverage.tokens.matched_turns);
  assert.equal(fromRecords.coverage.tokens.transitions_without_turn, fromTranscript.coverage.tokens.transitions_without_turn);
  assert.equal(fromRecords.coverage.tokens.granularity, fromTranscript.coverage.tokens.granularity);
  // The two readings are labelled by where they came from, so a stale stored
  // derivation can never be mistaken for a fresh read of the source.
  assert.equal(fromTranscript.coverage.tokens.source, "transcript");
  assert.equal(fromRecords.coverage.tokens.source, "record");
  // And the summed per-gate + per-verb floor is the enricher's own figure.
  const total = [...gateTokens, ...tokensByVerb(fromTranscript)].reduce((sum, entry) => sum + entry[1], 0);
  assert.equal(total, EXPECTED.outputTokensFloor);
});

test("output_tokens is present if and only if the attribution claims one, in both directions", () => {
  const { transitions } = enrichCorpus();
  let attributedBlocks = 0;
  let unattributedBlocks = 0;
  for (const record of transitions) {
    const block = record[TOKEN_ATTRIBUTION_FIELD];
    assert.ok(block, "every examined record carries the attribution block");
    assert.equal(block.granularity, ATTRIBUTION_GRANULARITY, "the label travels with the number");
    const hasNumber = OUTPUT_TOKENS_FIELD in record;
    assert.equal(hasNumber, block.attributed === true, "the field and the claim must agree");
    if (block.attributed === true) {
      attributedBlocks += 1;
      assert.equal(typeof record[OUTPUT_TOKENS_FIELD], "number");
      assert.ok(Number.isInteger(record[OUTPUT_TOKENS_FIELD]) && record[OUTPUT_TOKENS_FIELD] >= 0);
      assert.match(block.turn_ref, /^sha256:[0-9a-f]{32}$/, "the turn handle carries no filesystem path");
    } else {
      unattributedBlocks += 1;
    }
  }
  assert.equal(attributedBlocks, EXPECTED.withTurn);
  assert.equal(unattributedBlocks, EXPECTED.withoutTurn);
});

// UNMEASURED IS NOT FREE. This is the defect Console's own review caught on the
// consumer side; recreating it on the producer side would be worse, because a
// fabricated zero on the wire cannot be un-fabricated downstream.
test("an unattributable transition carries no output_tokens key at all, never a zero", () => {
  const { transitions } = enrichCorpus();
  const unattributed = transitions.filter((record) => record[TOKEN_ATTRIBUTION_FIELD].attributed !== true);
  assert.equal(unattributed.length, EXPECTED.withoutTurn);
  for (const record of unattributed) {
    assert.equal(OUTPUT_TOKENS_FIELD in record, false, "an unmeasured transition must not claim zero tokens");
  }
  const zeros = transitions.filter((record) => record[OUTPUT_TOKENS_FIELD] === 0);
  assert.equal(zeros.length, 0, "no record in this corpus won a zero-token turn, so no zero may appear");
});

test("every unattributable transition says why, with the exact real-corpus counts", () => {
  const { transitions } = enrichCorpus();
  const reasons = {};
  for (const record of transitions) {
    const block = record[TOKEN_ATTRIBUTION_FIELD];
    if (block.attributed === true) continue;
    assert.equal(typeof block.reason, "string", "the reason is emitted, never left for the reader to infer");
    reasons[block.reason] = (reasons[block.reason] ?? 0) + 1;
  }
  assert.deepEqual(reasons, EXPECTED.reasons);
});

// One turn, one transition — asserted on the WIRE, not just inside the algorithm.
// A `turn_ref` appearing twice is over-attribution: spend that never happened.
test("no turn is charged to two transitions in the enriched log", () => {
  const { transitions } = enrichCorpus();
  const refs = transitions
    .filter((record) => record[TOKEN_ATTRIBUTION_FIELD].attributed === true)
    .map((record) => record[TOKEN_ATTRIBUTION_FIELD].turn_ref);
  assert.equal(refs.length, EXPECTED.withTurn);
  assert.equal(new Set(refs).size, refs.length, "a turn_ref must not be charged twice");
});

test("enrichment leaves every field the emitter wrote byte-identical", () => {
  const raw = readCorpus();
  const { transitions } = enrichCorpus();
  assert.equal(transitions.length, raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    const stripped = { ...transitions[index] };
    delete stripped[OUTPUT_TOKENS_FIELD];
    delete stripped[TOKEN_ATTRIBUTION_FIELD];
    assert.deepEqual(stripped, raw[index], `record ${index} was altered beyond the additive fields`);
    // Key ORDER too: the additions are appended, so an old consumer reading the
    // serialized line sees its own fields in the positions it has always seen them.
    assert.deepEqual(Object.keys(stripped), Object.keys(raw[index]));
  }
});

test("an enriched record still validates against the pre-#1320 consumer schema", () => {
  const current = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
  // Pinned literally: this change must add no REQUIRED field, or an old consumer
  // would start rejecting. Deriving it from `current` alone could not catch that.
  assert.deepEqual(current.required, [
    "schema",
    "version",
    "command",
    "verb",
    "targets",
    "flags",
    "exit_code",
    "outcome",
    "started_at",
    "duration_ms",
    "actor",
  ]);
  assert.equal(current.additionalProperties, true, "an old consumer must accept a producer's minor-version additions");

  // The pre-change schema IS the current one minus the two new properties, which is
  // what "additive" means. Reconstructed rather than vendored so it cannot drift.
  const old = JSON.parse(JSON.stringify(current));
  delete old.properties.output_tokens;
  delete old.properties.token_attribution;
  delete old.$id;
  // The installed ajv build does not carry the 2020-12 meta-schema; the dialect
  // declaration is irrelevant to what this test asserts (that the enriched record
  // still satisfies the pre-change property set), so drop it rather than pinning a
  // second ajv distribution into the corpus for one assertion.
  delete old.$schema;

  const ajv = new Ajv({ strict: false, allErrors: true });
  const validateOld = ajv.compile(old);
  const validateCurrent = ajv.compile({ ...current, $id: undefined, $schema: undefined });
  const { transitions } = enrichCorpus();
  for (const record of transitions) {
    assert.ok(validateOld(record), `old consumer rejected an enriched record: ${ajv.errorsText(validateOld.errors)}`);
    assert.ok(validateCurrent(record), `current schema rejected an enriched record: ${ajv.errorsText(validateCurrent.errors)}`);
  }

  // Console's own wire check, replicated: `output_tokens`, when present, must be a
  // non-negative integer, because it rejects a malformed cost claim rather than
  // absorbing it as "no turn" (which would convert a producer bug into permanently
  // understated cost that looks like an honest floor).
  for (const record of transitions) {
    if (!(OUTPUT_TOKENS_FIELD in record)) continue;
    const value = record[OUTPUT_TOKENS_FIELD];
    assert.ok(typeof value === "number" && Number.isInteger(value) && value >= 0);
  }
});

// A record nothing has looked at and a record examined and found unattributable are
// different facts. Folding the first into the second reports an un-enriched log as a
// fully measured one whose gates all happened to be free.
test("a record nothing enriched is not folded as an attributed zero", () => {
  const { transitions } = enrichCorpus();
  const stripped = transitions.map((record, index) => {
    if (index % 7 !== 0) return record;
    const copy = { ...record };
    delete copy[TOKEN_ATTRIBUTION_FIELD];
    delete copy[OUTPUT_TOKENS_FIELD];
    return copy;
  });
  const notEnriched = stripped.filter((record) => !(TOKEN_ATTRIBUTION_FIELD in record)).length;
  assert.ok(notEnriched > 0);

  const full = attributionFromRecords(transitions);
  const partial = attributionFromRecords(stripped);
  assert.equal(partial.transitionsNotEnriched, notEnriched);
  assert.equal(
    partial.transitionsWithoutTurn + notEnriched >= full.transitionsWithoutTurn,
    true,
    "stripping records must move them OUT of the measured populations, not into without-turn",
  );
  // The stripped records contribute nothing and are not counted as measured absences.
  const strippedAttributed = [...partial.attributed.values()].reduce((sum, turn) => sum + turn.output, 0);
  const fullAttributed = [...full.attributed.values()].reduce((sum, turn) => sum + turn.output, 0);
  assert.ok(strippedAttributed < fullAttributed, "removing attributions must lower the floor, not keep it");
  assert.equal(partial.transitionsNotEnriched + partial.transitionsWithoutTurn + partial.matchedTurns, EXPECTED.transitions);
});

test("a log nothing has enriched yields no token block at all, not a block of zeroes", () => {
  const raw = readCorpus();
  assert.equal(attributionFromRecords(raw), null, "absence is reported as absence, never as measured zero");

  const kitDirs = discoverKitDirs(REPO_ROOT);
  const { index, gates, ambiguousExpectations } = buildExpectationIndex(kitDirs);
  const card = buildScorecard({
    transitions: raw,
    expectationIndex: index,
    gateIndex: gates,
    tokenAttribution: attributionFromRecords(raw),
    ambiguousExpectations,
  });
  assert.equal(card.coverage.tokens, null);
  assert.ok(card.gates.every((gate) => gate.output_tokens === undefined));
});

test("re-running the enricher is idempotent and never charges a turn twice", () => {
  const dir = scratch();
  const file = path.join(dir, "transitions.jsonl");
  fs.copyFileSync(CORPUS, file);
  const run = () =>
    execFileSync(process.execPath, [ENRICHER, "--transitions", file, "--transcript", TURNS, "--json"], { encoding: "utf8" });

  const first = JSON.parse(run());
  const afterFirst = fs.readFileSync(file, "utf8");
  const second = JSON.parse(run());
  const afterSecond = fs.readFileSync(file, "utf8");

  assert.equal(afterFirst, afterSecond, "a second pass must not rewrite the log");
  assert.equal(second.already_attributed, EXPECTED.transitions, "every record was already examined");
  assert.equal(second.newly_examined, 0);
  assert.equal(second.transitions_with_turn, 0, "no turn may be charged a second time");
  assert.equal(second.output_tokens_floor, 0);
  assert.equal(first.transitions_with_turn, EXPECTED.withTurn);
});

// The rule must hold ACROSS runs, not merely within one. A second pass that ignored
// what the first had charged would double-count every turn in the overlap.
test("a second pass honours the turns the first pass already charged", () => {
  const dir = scratch();
  const half = path.join(dir, "half.jsonl");
  const whole = path.join(dir, "whole.jsonl");
  const raw = readCorpus();
  fs.writeFileSync(half, `${raw.slice(0, 350).map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const firstPass = JSON.parse(
    execFileSync(process.execPath, [ENRICHER, "--transitions", half, "--transcript", TURNS, "--json"], { encoding: "utf8" }),
  );
  // The enriched half, followed by the untouched remainder — the shape of a log that
  // grew after an earlier enrichment.
  const enrichedHalf = fs.readFileSync(half, "utf8").trimEnd().split("\n");
  fs.writeFileSync(whole, `${[...enrichedHalf, ...raw.slice(350).map((record) => JSON.stringify(record))].join("\n")}\n`, "utf8");
  const secondPass = JSON.parse(
    execFileSync(process.execPath, [ENRICHER, "--transitions", whole, "--transcript", TURNS, "--json"], { encoding: "utf8" }),
  );

  assert.equal(secondPass.already_attributed, 350);
  assert.equal(secondPass.newly_examined, 350);
  const combined = readLog(whole).transitions;
  const refs = combined
    .filter((record) => record[TOKEN_ATTRIBUTION_FIELD]?.attributed === true)
    .map((record) => record[TOKEN_ATTRIBUTION_FIELD].turn_ref);
  assert.equal(new Set(refs).size, refs.length, "no turn_ref may be charged in two passes");
  const floor = combined.reduce((sum, record) => sum + (record[OUTPUT_TOKENS_FIELD] ?? 0), 0);
  assert.ok(
    floor <= EXPECTED.outputTokensFloor,
    `a split enrichment must never exceed the single-pass floor (${floor} > ${EXPECTED.outputTokensFloor})`,
  );
  assert.ok(firstPass.transitions_with_turn > 0 && secondPass.transitions_with_turn > 0, "both passes must attribute something");
});

test("--reattribute recomputes from scratch and lands on the single-pass answer", () => {
  const dir = scratch();
  const file = path.join(dir, "transitions.jsonl");
  fs.copyFileSync(CORPUS, file);
  execFileSync(process.execPath, [ENRICHER, "--transitions", file, "--transcript", TURNS, "--json"], { encoding: "utf8" });
  const again = JSON.parse(
    execFileSync(process.execPath, [ENRICHER, "--transitions", file, "--transcript", TURNS, "--reattribute", "--json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(again.already_attributed, 0);
  assert.equal(again.transitions_with_turn, EXPECTED.withTurn);
  assert.equal(again.output_tokens_floor, EXPECTED.outputTokensFloor);
});

test("a figure this tool did not write is neither overwritten nor deleted", () => {
  const dir = scratch();
  const file = path.join(dir, "transitions.jsonl");
  const raw = readCorpus();
  // An unlabelled number: present, with no attribution block to say what it means.
  raw[0] = { ...raw[0], output_tokens: 4242 };
  fs.writeFileSync(file, `${raw.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const summary = JSON.parse(
    execFileSync(process.execPath, [ENRICHER, "--transitions", file, "--transcript", TURNS, "--json"], { encoding: "utf8" }),
  );
  assert.equal(summary.unlabelled_attributions, 1);
  const after = readLog(file).transitions;
  assert.equal(after[0][OUTPUT_TOKENS_FIELD], 4242, "another writer's figure must survive untouched");
  assert.equal(after[0][TOKEN_ATTRIBUTION_FIELD], undefined, "and must not be labelled by a tool that cannot vouch for it");
});

test("a foreign or half-written line survives the rewrite unchanged", () => {
  const dir = scratch();
  const file = path.join(dir, "transitions.jsonl");
  const raw = readCorpus().slice(0, 20).map((record) => JSON.stringify(record));
  const foreign = JSON.stringify({ schema: "kontour.flow-agents.economics", version: "1.0", note: "not mine" });
  const truncated = '{"schema":"kontour.flow-agents.transition","version":"1.0"';
  fs.writeFileSync(file, `${[foreign, ...raw, truncated].join("\n")}\n`, "utf8");
  const summary = JSON.parse(
    execFileSync(process.execPath, [ENRICHER, "--transitions", file, "--transcript", TURNS, "--json"], { encoding: "utf8" }),
  );
  assert.equal(summary.unparseable_lines, 1);
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  assert.equal(lines[0], foreign, "a record this tool does not own is replayed verbatim");
  assert.equal(lines.at(-1), truncated, "a half-written line is preserved, not discarded");
  assert.equal(summary.transitions, 20);
});

// A renamed field, a moved path or a typo'd --transcript all converge on "no turns".
// Stamping that would publish an authoritative-looking `attributed: false` on every
// record — the format-break-looks-like-a-quiet-run failure these tools exist to refuse.
test("a transcript yielding no turns stamps nothing and says so", () => {
  const dir = scratch();
  const file = path.join(dir, "transitions.jsonl");
  fs.copyFileSync(CORPUS, file);
  const empty = path.join(dir, "empty.jsonl");
  fs.writeFileSync(empty, `${JSON.stringify({ timestamp: "2026-08-21T04:00:00.000Z", message: { id: "x" } })}\n`, "utf8");
  const before = fs.readFileSync(file, "utf8");
  let status = 0;
  try {
    execFileSync(process.execPath, [ENRICHER, "--transitions", file, "--transcript", empty], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    status = error.status;
  }
  assert.equal(status, 3, "nothing measured is its own exit code, not success");
  assert.equal(fs.readFileSync(file, "utf8"), before, "the log is left exactly as it was");
});

test("the session binding is never inferred", () => {
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [ENRICHER, "--transitions", CORPUS], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    status = error.status;
    stderr = String(error.stderr);
  }
  assert.equal(status, 2);
  assert.match(stderr, /--transcript is required/);
});

// The emitter is provider-independent and wrapper-immune by construction, and would
// have to guess at a decision about a SET of transitions. It stamps nothing.
test("the emitter never writes an attribution", () => {
  const record = buildTransitionRecord({
    command: "workflow",
    argv: ["evidence", "--expectation", "tests-evidence"],
    exitCode: 0,
    startedAt: new Date("2026-08-21T04:00:00.000Z"),
    endedAt: new Date("2026-08-21T04:00:01.000Z"),
    repoRoot: "/repo",
    env: {},
  });
  assert.equal(OUTPUT_TOKENS_FIELD in record, false);
  assert.equal(TOKEN_ATTRIBUTION_FIELD in record, false);
});

// CONSTRUCTED, because the real corpus does not realize it — and asserted BOTH ways,
// so the detector is proven to fire rather than merely proven not to have fired.
test("a turn claimed by two simultaneous transitions is reported, not silently awarded", () => {
  const dir = scratch();
  const transcript = path.join(dir, "turns.jsonl");
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({ timestamp: "2026-08-21T04:00:00.000Z", sessionId: "session-a", message: { id: "m1", usage: { output_tokens: 700 } } })}\n`,
    "utf8",
  );
  const base = {
    schema: "kontour.flow-agents.transition",
    version: "1.0",
    verb: "status",
    targets: {},
    flags: [],
    exit_code: 0,
    outcome: "ok",
    started_at: "2026-08-21T04:00:05.000Z",
    duration_ms: 1,
    cwd_repo: "/repo",
    actor: { runtime: "claude-code", session_id: "session-a" },
  };
  const first = { ...base, command: "first" };
  const second = { ...base, command: "second" };
  const attribution = attributeTokens([first, second], [transcript]);

  assert.equal(attribution.matchedTurns, 1, "the award itself is preserved — one turn, one transition");
  assert.equal(attribution.ambiguousTurnClaims.length, 1, "and it is reported as order-dependent");
  assert.equal(attribution.ambiguousTurnClaims[0].transitions, 2);
  assert.equal(attribution.ambiguousTurnClaims[0].awarded_to, "first status");
  assert.equal(attribution.reasons.get(second).reason, "turn-claimed-by-simultaneous-transition");
  assert.equal(attribution.reasons.get(second).ambiguous, true);

  // And the marker reaches the wire on both sides of the tie.
  const lines = [{ record: first }, { record: second }];
  enrich({ lines, transitions: [first, second], transcripts: [transcript] });
  assert.equal(first[TOKEN_ATTRIBUTION_FIELD].ambiguous, true, "the charged record admits the tie");
  assert.equal(second[TOKEN_ATTRIBUTION_FIELD].ambiguous, true);
  assert.equal(first[OUTPUT_TOKENS_FIELD], 700);
  assert.equal(OUTPUT_TOKENS_FIELD in second, false);

  // The live corpus has five same-instant pairs and none of them realized this, so
  // the fixture reports zero — a fact, not a passing colour.
  const { summary } = enrichCorpus();
  assert.deepEqual(summary.ambiguous_turn_claims, []);
});

test("a transition with no preceding turn at all says exactly that", () => {
  const dir = scratch();
  const transcript = path.join(dir, "turns.jsonl");
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({ timestamp: "2026-08-21T05:00:00.000Z", sessionId: "session-a", message: { id: "m1", usage: { output_tokens: 10 } } })}\n`,
    "utf8",
  );
  const record = {
    schema: "kontour.flow-agents.transition",
    version: "1.0",
    command: "workflow",
    verb: "status",
    targets: {},
    flags: [],
    exit_code: 0,
    outcome: "ok",
    started_at: "2026-08-21T04:00:00.000Z",
    duration_ms: 1,
    cwd_repo: "/repo",
    actor: { runtime: "claude-code", session_id: "session-a" },
  };
  const attribution = attributeTokens([record], [transcript]);
  assert.equal(attribution.matchedTurns, 0);
  assert.equal(attribution.reasons.get(record).reason, "no-turn-before-transition");
  enrich({ lines: [{ record }], transitions: [record], transcripts: [transcript] });
  assert.equal(record[TOKEN_ATTRIBUTION_FIELD].reason, "no-turn-before-transition");
  assert.equal(OUTPUT_TOKENS_FIELD in record, false);
});

// A malformed claim is a producer bug. Absorbing it as "no turn" would convert that
// bug into permanently understated cost wearing the costume of an honest floor.
test("an attribution claiming a turn without a usable number is counted as malformed", () => {
  const { transitions } = enrichCorpus();
  const broken = transitions.map((record, index) => {
    if (index !== 0 || record[TOKEN_ATTRIBUTION_FIELD].attributed !== true) return record;
    const copy = { ...record };
    delete copy[OUTPUT_TOKENS_FIELD];
    return copy;
  });
  const attributed = transitions.findIndex((record) => record[TOKEN_ATTRIBUTION_FIELD].attributed === true);
  const target = broken[attributed] === transitions[attributed] ? attributed : 0;
  const copy = { ...transitions[attributed] };
  delete copy[OUTPUT_TOKENS_FIELD];
  const mixed = transitions.map((record, index) => (index === attributed ? copy : record));
  const result = attributionFromRecords(mixed);
  assert.equal(result.malformedAttributions, 1);
  assert.equal(result.matchedTurns, EXPECTED.withTurn - 1);
  assert.equal(result.transitionsWithoutTurn, EXPECTED.withoutTurn, "a malformed claim is NOT laundered into a measured absence");
  assert.ok(target >= 0);
});
