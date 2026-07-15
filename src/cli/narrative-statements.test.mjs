import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_STATED_ACTOR_MAX_LENGTH,
  AGENT_STATED_PURPOSE_MAX_LENGTH,
  NarrativeStatementError,
  agentStatedIntent,
  derivedNoOpTurn,
  derivedRetry,
  derivedTimeout,
  derivedUnavailableSource,
  observedCommand,
  observedDelegation,
  observedFileCreation,
  observedToolAction,
  summarizerInferredConnective,
  workflowDerivedPurpose,
} from "../../build/src/index.js";

const source = (suffix) => `fa1:telemetry:full/session:event-${suffix}/0123abcd`;
const fileSource = `fa1:file:created.txt:${"a".repeat(64)}`;

test("observed constructors render one grounded proposition", () => {
  assert.equal(observedCommand({ sourceId: source("command"), command: "npm test", observedResult: "pass", exitCode: 0, actor: "codex" }).proposition,
    "Command `npm test` was observed to pass (exit 0)");
  assert.equal(observedCommand({ sourceId: source("ambiguous"), command: "grep needle", observedResult: "ambiguous", exitCode: null }).proposition,
    "Command `grep needle` was observed to complete ambiguously (exit unknown)");
  assert.equal(observedToolAction({ sourceId: source("tool"), toolName: "execute_bash", eventType: "tool.invoke" }).proposition,
    "Tool execute_bash emitted event tool.invoke");
  assert.equal(observedDelegation({ sourceId: source("delegation"), agentId: "agent-1", targets: ["worker-1", "worker-2"] }).proposition,
    "Agent agent-1 delegated work to worker-1, worker-2");
  assert.equal(observedFileCreation({ sourceId: fileSource, path: "created.txt" }).proposition,
    "File `created.txt` was observed to be created");
});

test("derived constructors render rules with grounded inputs", () => {
  const first = source("retry-1");
  const second = source("retry-2");
  assert.deepEqual(derivedRetry({ sourceIds: [first, second], command: "npm test", attempts: 2, ruleInputs: [first, second] }), {
    id: derivedRetry({ sourceIds: [first, second], command: "npm test", attempts: 2, ruleInputs: [first, second] }).id,
    class: "deterministic_derived",
    proposition: "Command `npm test` was retried across 2 attempts",
    source_refs: [first, second],
    rule: { id: "retry-detection", version: "v1", inputs: [first, second] },
  });
  assert.equal(derivedNoOpTurn({ turnRef: 3, sourceIds: [first] }).proposition, "Turn 3 was classified as a no-op");
  assert.equal(derivedNoOpTurn({ turnRef: -1, sourceIds: [first] }).turn_ref, -1);
  assert.equal(derivedTimeout({ sourceId: first, operation: "delegate worker", timeoutMs: 30000 }).proposition,
    "Operation `delegate worker` exceeded its 30000 ms timeout");
  assert.equal(derivedUnavailableSource({ sourceId: first, reason: "not_captured" }).proposition,
    `Source ${first} was unavailable because not_captured`);
});

test("delegation attribution defaults honestly", () => {
  const statement = observedDelegation({ sourceId: source("unattributed"), agentId: null });
  assert.equal(statement.actor, "unattributed");
  assert.equal(statement.proposition, "Agent unattributed delegated work");
});

test("observed and deterministic-derived constructors expose their class invariants", () => {
  const observed = observedFileCreation({ sourceId: fileSource, path: "created.txt" });
  const derived = derivedNoOpTurn({ turnRef: 0, sourceIds: [source("no-op")] });
  assert.equal(observed.class, "observed");
  assert.equal("rule" in observed, false);
  assert.equal(derived.class, "deterministic_derived");
  assert.deepEqual(derived.rule, { id: "no-op-turn", version: "v1", inputs: derived.source_refs });
});

test("statement IDs are deterministic, source-order insensitive, and input-sensitive", () => {
  const first = source("id-1");
  const second = source("id-2");
  const a = derivedRetry({ sourceIds: [first, second], command: "npm test", attempts: 2, ruleInputs: [first] });
  const b = derivedRetry({ sourceIds: [second, first], command: "npm test", attempts: 2, ruleInputs: [first] });
  const c = derivedRetry({ sourceIds: [first, second], command: "npm test", attempts: 3, ruleInputs: [first] });
  assert.match(a.id, /^[0-9a-f]{16}$/);
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
});

test("constructors reject invariant violations with typed errors", () => {
  const first = source("valid");
  const other = source("other");
  for (const invoke of [
    () => observedCommand({ sourceId: "not-fa1", command: "npm test", observedResult: "pass", exitCode: 0 }),
    () => observedCommand({ sourceId: first, command: "npm test", observedResult: "pass", exitCode: 1 }),
    () => observedCommand({ sourceId: first, command: "npm test; npm publish", observedResult: "pass", exitCode: 0 }),
    () => observedToolAction({ sourceId: first, toolName: "read\nand write", eventType: "tool.invoke" }),
    () => observedToolAction({ sourceId: first, toolName: "read and write", eventType: "tool.invoke" }),
    () => derivedRetry({ sourceIds: [first], command: "npm test", attempts: 1, ruleInputs: [first] }),
    () => derivedRetry({ sourceIds: [first], command: "npm test", attempts: 2, ruleInputs: [other] }),
    () => derivedNoOpTurn({ turnRef: 1, sourceIds: [] }),
  ]) {
    assert.throws(invoke, (error) => error instanceof NarrativeStatementError && typeof error.code === "string");
  }
});

// ── Review-round regressions (#618 verify findings) ──────────────────────────
import { buildTurnSpine } from "../../build/src/narrative/turn-spine.js";

test("H1: an explicit turn closes the session's derived spine — no merge across the boundary", () => {
  const src = (n) => `fa1:telemetry:full/s1:evt-${n}/01234567`;
  const spine = buildTurnSpine([
    { sourceId: src("pre"), record: { session_id: "s1", event_type: "tool.invoke" } },
    { sourceId: src("user"), record: { session_id: "s1", event_type: "tool.invoke", hook: { turn_id: "t-explicit" } } },
    { sourceId: src("post"), record: { session_id: "s1", event_type: "tool.invoke" } },
  ]);
  const derived = spine.filter((turn) => turn.boundary.derived && turn.ordinal !== -1);
  assert.equal(derived.length, 2, "pre and post must land in SEPARATE derived turns");
  assert.deepEqual(derived[0].sources, [src("pre")]);
  assert.deepEqual(derived[1].sources, [src("post")]);
});

test("H3: identifier-shaped fields reject prose injection; quoted commands tolerate conjunctions", () => {
  assert.throws(
    () => observedToolAction({ sourceId: source("tool"), toolName: "alpha emitted event first but tool beta", eventType: "second" }),
    (error) => error.code === "invalid_input",
  );
  assert.throws(
    () => observedDelegation({ sourceId: source("tool"), agentId: "worker one but really two" }),
    (error) => error.code === "invalid_input",
  );
  // A genuine command containing a conjunction is quoted free text, not a second clause.
  const ok = observedCommand({ sourceId: source("tool"), command: "grep -E 'this or that' file.txt", observedResult: "fail", exitCode: 1 });
  assert.match(ok.proposition, /^Command `.*` was observed to fail \(exit 1\)$/);
});

test("H2a: derivedTimeout is material without a duration", () => {
  const out = derivedTimeout({ sourceId: source("tool"), operation: "delegate worker" });
  assert.equal(out.proposition, "Operation `delegate worker` exceeded its timeout (duration unknown)");
  assert.equal(out.rule.id, "timeout-detection");
});

// ── #614: summarizer_inferred connective constructor ────────────────────────

test("#614: summarizerInferredConnective mirrors the atomicity/charset/sourceRefs discipline", () => {
  const first = source("summary-1");
  const second = source("summary-2");
  const statement = summarizerInferredConnective({
    proposition: "The retried command `npm test` is summarized from the underlying attempts",
    source_refs: [first, second],
    turn_ref: 2,
    actor: "prose-renderer",
  });
  assert.equal(statement.class, "summarizer_inferred");
  assert.equal("rule" in statement, false);
  assert.deepEqual(statement.source_refs, [first, second]);
  assert.equal(statement.turn_ref, 2);
  assert.equal(statement.actor, "prose-renderer");
  assert.match(statement.id, /^[0-9a-f]{16}$/);
});

test("#614: summarizerInferredConnective accepts an explicit identifier-shaped id", () => {
  const statement = summarizerInferredConnective({
    id: "prose-sentence-1",
    proposition: "The run completed",
    source_refs: [source("summary-explicit-id")],
  });
  assert.equal(statement.id, "prose-sentence-1");
});

test("#614: summarizerInferredConnective rejects invariant violations with typed errors", () => {
  const first = source("summary-invalid");
  for (const invoke of [
    () => summarizerInferredConnective({ proposition: "", source_refs: [first] }),
    () => summarizerInferredConnective({ proposition: "one thing and then another", source_refs: [first] }),
    () => summarizerInferredConnective({ proposition: "valid sentence", source_refs: [] }),
    () => summarizerInferredConnective({ proposition: "valid sentence", source_refs: ["not-fa1"] }),
    () => summarizerInferredConnective({ proposition: "valid sentence\nwith a newline", source_refs: [first] }),
  ]) {
    assert.throws(invoke, (error) => error instanceof NarrativeStatementError && typeof error.code === "string");
  }
});

// ── #622: agent_stated intent + deterministic fallback constructors ──────────

test("#622: agentStatedIntent builds a bounded typed self-report", () => {
  const action = source("intent-action");
  const statement = agentStatedIntent({ sourceId: action, purpose: "prepare the release notes", actor: "codex" });
  assert.equal(statement.class, "agent_stated");
  assert.equal(statement.self_report, true);
  assert.equal(statement.actor, "codex");
  assert.equal("rule" in statement, false);
  assert.deepEqual(statement.source_refs, [action]);
  assert.equal(statement.proposition, "Agent stated the purpose of this action is to prepare the release notes");
  assert.match(statement.id, /^[0-9a-f]{16}$/);
});

test("#622: agentStatedIntent enforces the chain-of-thought / length bound at construct", () => {
  const action = source("intent-bound");
  for (const invoke of [
    // multi-clause reasoning dump (conjunction) — rejected by atomic()
    () => agentStatedIntent({ sourceId: action, purpose: "ship the fix and explain my reasoning", actor: "codex" }),
    // clause separator — rejected by text()
    () => agentStatedIntent({ sourceId: action, purpose: "do a thing; then another", actor: "codex" }),
    // over the hard length cap — rejected by the cap
    () => agentStatedIntent({ sourceId: action, purpose: "x".repeat(AGENT_STATED_PURPOSE_MAX_LENGTH + 1), actor: "codex" }),
    // empty purpose
    () => agentStatedIntent({ sourceId: action, purpose: "", actor: "codex" }),
    // backtick — rejected by strict text()
    () => agentStatedIntent({ sourceId: action, purpose: "run `deploy`", actor: "codex" }),
  ]) {
    assert.throws(invoke, (error) => error instanceof NarrativeStatementError && typeof error.code === "string");
  }
});

test("#622 (review HIGH R2): multi-clause purposes chained by period / comma / U+2028 are rejected at construct", () => {
  const action = source("intent-multiclause");
  for (const invoke of [
    // period-chained probe: a sentence terminator that starts a new clause.
    () => agentStatedIntent({ sourceId: action, actor: "codex", purpose: "delete the audit trail. cover tracks" }),
    // comma-chained probe: two-or-more comma-separated segments (a clause list).
    () => agentStatedIntent({ sourceId: action, actor: "codex", purpose: "cover tracks, avoid detection, minimize the paper trail" }),
    // Unicode line separator (U+2028) probe.
    () => agentStatedIntent({ sourceId: action, actor: "codex", purpose: "cover tracks\u2028avoid detection" }),
    // Unicode paragraph separator (U+2029) probe.
    () => agentStatedIntent({ sourceId: action, actor: "codex", purpose: "cover tracks\u2029avoid detection" }),
    // "! " and "? " sub-clause chaining are rejected too.
    () => agentStatedIntent({ sourceId: action, actor: "codex", purpose: "do the thing! then do more" }),
  ]) {
    assert.throws(invoke, (error) => error instanceof NarrativeStatementError && error.code === "non_atomic_proposition");
  }
  // A single short clause with a trailing terminator (or one subordinate comma) is still allowed.
  assert.equal(
    agentStatedIntent({ sourceId: action, actor: "codex", purpose: "ship the fix." }).class,
    "agent_stated",
  );
  assert.equal(
    agentStatedIntent({ sourceId: action, actor: "codex", purpose: "prepare the release notes, carefully" }).class,
    "agent_stated",
  );
});

test("#622 (re-review HIGH-2): the single-clause guard closes the residual separator bypasses", () => {
  const action = source("intent-bypass");
  // Every vector below is a two-clause purpose smuggled past the earlier (period/comma/U+2028
  // -only) guard. The re-review enumerated these classes as still-open; each must now throw
  // non_atomic_proposition at construct time.
  const rejected = [
    "ship the fix: cover tracks",                 // colon clause separator
    "delete the logs - hide - remove",            // spaced-hyphen dash separator
    "ship the fix;cover tracks",                  // semicolon without a following space
    "ship the fix。 delete the trail",        // U+3002 ideographic full stop
    "ship the fix！ delete the trail",        // U+FF01 fullwidth exclamation
    "ship the fix؟ delete the trail",        // U+061F arabic question mark
    "ship the fix also delete the trail",         // coordinator "also"
    "ship the fix however delete the trail",      // coordinator "however"
    "ship the fixdelete the trail",         // U+000B vertical tab
    "ship the fixdelete the trail",         // U+000C form feed
    "ship the fix delete the trail",         // U+00A0 non-breaking space
    "ship the fix​delete the trail",         // U+200B zero-width space
    "ship the fix﻿delete the trail",         // U+FEFF zero-width no-break space
    "ship the fix… delete the trail",        // U+2026 ellipsis
    "ship the fix—delete the trail",         // U+2014 em dash
  ];
  for (const purpose of rejected) {
    assert.throws(
      () => agentStatedIntent({ sourceId: action, actor: "codex", purpose }),
      (error) => error instanceof NarrativeStatementError && error.code === "non_atomic_proposition",
      `expected rejection for: ${JSON.stringify(purpose)}`,
    );
  }
  // The guard must not over-reject legitimate single clauses that merely contain
  // punctuation-shaped characters (decimals, versions, intra-word hyphens, one subordinate comma).
  for (const purpose of [
    "re-run the failing test-suite",
    "ship the fix at 3.5x speed",
    "ship the v1.2 fix",
    "ship the fix, as agreed",
    "verify the deployment before closing the ticket",
  ]) {
    assert.equal(
      agentStatedIntent({ sourceId: action, actor: "codex", purpose }).class,
      "agent_stated",
      `expected acceptance for: ${JSON.stringify(purpose)}`,
    );
  }
});

test("#622 (2nd adversarial pass HIGH-2): the whole invisible / format-control class is rejected, not an explicit blocklist", () => {
  const action = source("intent-invisible");
  // A 2nd adversarial probe found the earlier explicit-range HIDDEN_FORMAT_CHARS blocklist
  // missed the bidi-isolate block, ALM, NEL, soft hyphen, CGJ, Khmer invisibles, and the
  // deprecated-format block. The guard now rejects the whole Unicode \p{C} category plus the
  // non-\p{C} invisible marks/fillers. Each code point below joins two clauses invisibly and
  // must throw non_atomic_proposition at construct time.
  const invisible = [
    0x2066, 0x2067, 0x2068, 0x2069, // LRI / RLI / FSI / PDI bidi isolates
    0x061C,                         // Arabic letter mark
    0x00AD,                         // soft hyphen
    0x0085,                         // NEL (a control char that is NOT matched by \s)
    0x206A,                         // deprecated "inhibit symmetric swapping" format control
    0x034F,                         // combining grapheme joiner
    0x17B4, 0x17B5,                 // Khmer invisible inherent vowels
    0x200B, 0xFEFF, 0x180E,         // zero-width space / BOM / Mongolian vowel separator
    0x115F, 0x1160, 0x3164, 0xFFA0, // Hangul fillers (invisible, not \p{C})
  ];
  for (const cp of invisible) {
    const purpose = `patch the config file${String.fromCodePoint(cp)}secretly disable the limiter`;
    assert.throws(
      () => agentStatedIntent({ sourceId: action, actor: "codex", purpose }),
      (error) => error instanceof NarrativeStatementError && error.code === "non_atomic_proposition",
      `expected rejection for invisible U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
    );
  }
});

test("#622 (HIGH-2 disclosed residual): a punctuation-free, coordinator-free ASCII run-on is NOT structurally caught", () => {
  // HONEST-DISCLOSURE PIN. The single-clause guard rejects every separator/punctuation/
  // format-control/coordinator multi-clause form and hard-caps length, but a bare run-on of
  // imperatives joined only by ordinary spaces ("ship the fix hide the audit trail avoid
  // detection") has NO lexical separator and is not distinguishable from a legitimate long
  // single clause without a natural-language parser. This is a DISCLOSED structural residual
  // (deliver.md accepted gaps): agent_stated is a non-authoritative typed self-report, barred
  // by construction from being gate evidence (isolation) and from post-hoc reconstruction
  // (write-once), and the dump is still bounded by AGENT_STATED_PURPOSE_MAX_LENGTH — so the
  // residual carries no gate/security consequence. This test PINS the current behavior: if a
  // future change adds clause-level NLP, this assertion will flip and force a re-evaluation of
  // the disclosure rather than letting the behavior change silently.
  const action = source("intent-runon");
  const runOn = "ship the fix hide the audit trail avoid detection";
  assert.ok(runOn.length <= AGENT_STATED_PURPOSE_MAX_LENGTH);
  assert.equal(agentStatedIntent({ sourceId: action, actor: "codex", purpose: runOn }).class, "agent_stated");
  // The hard length cap is the active bound on dump size for this residual.
  assert.throws(
    () => agentStatedIntent({ sourceId: action, actor: "codex", purpose: "word ".repeat(60).trim() }),
    (error) => error instanceof NarrativeStatementError,
    "an over-length run-on is still rejected by the length cap",
  );
});

test("#622 (review HIGH R2): the agent_stated actor is a bounded identifier, never a prose/keyword smuggle channel", () => {
  const action = source("intent-actor");
  for (const invoke of [
    // over the hard actor length cap — rejected even though the charset is valid.
    () => agentStatedIntent({ sourceId: action, actor: "a".repeat(AGENT_STATED_ACTOR_MAX_LENGTH + 1), purpose: "ship the fix" }),
    // prohibited-assertion keywords smuggled as prose (spaces) — rejected by identifier().
    () => agentStatedIntent({ sourceId: action, actor: "the observed authoritative approved actor", purpose: "ship the fix" }),
    // empty actor.
    () => agentStatedIntent({ sourceId: action, actor: "", purpose: "ship the fix" }),
  ]) {
    assert.throws(invoke, (error) => error instanceof NarrativeStatementError && typeof error.code === "string");
  }
  // A legitimate identifier-shaped actor is still accepted.
  assert.equal(agentStatedIntent({ sourceId: action, actor: "claude-code", purpose: "ship the fix" }).actor, "claude-code");
});

test("#622: workflowDerivedPurpose is a deterministic_derived fallback, never a self-report", () => {
  const gate = source("gate-ref");
  const statement = workflowDerivedPurpose({ activeGateRef: gate });
  assert.equal(statement.class, "deterministic_derived");
  assert.equal("self_report" in statement, false);
  assert.deepEqual(statement.rule, { id: "workflow-derived-purpose", version: "v1", inputs: [gate] });
  assert.deepEqual(statement.source_refs, [gate]);
  assert.equal(statement.proposition, `Intent for this action was derived from active gate reference ${gate}`);
});
