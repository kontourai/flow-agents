import { createHash } from "node:crypto";
import type { UnavailableReason } from "./integrity.js";
import { parseSourceId } from "./source-ids.js";

export type StatementClass = "observed" | "deterministic_derived" | "summarizer_inferred" | "agent_stated";
export type ObservedResult = "pass" | "fail" | "ambiguous";

// #622: hard length cap on a stated-intent purpose. A bounded single-clause
// purpose (enforced by the strict text()+atomic() guards below) may never grow
// into a free-form reasoning dump, so the cap is deliberately small.
export const AGENT_STATED_PURPOSE_MAX_LENGTH = 200;

// #622 (review HIGH R2): a hard length cap on a stated-intent actor. An actor is
// an identifier-shaped attribution key (see identifier() below), never a place to
// smuggle prose or prohibited-assertion keywords past the proposition scan.
export const AGENT_STATED_ACTOR_MAX_LENGTH = 120;

// #622 (review HIGH R2): the FULL Unicode line/paragraph separator class. `\r`/`\n`
// alone let a caller chain clauses with U+2028 (LINE SEPARATOR) / U+2029 (PARAGRAPH
// SEPARATOR) or any other `\p{Zl}`/`\p{Zp}` code point. Every clause-separator guard
// below rejects this whole class, not just the ASCII line breaks.
const UNICODE_LINE_SEPARATORS = /[\r\n\u2028\u2029\p{Zl}\p{Zp}]/u;

// #622 (review HIGH R2, second pass): the single-clause guard below must reject clause
// separators STRUCTURALLY, not via a blocklist of the few code points named in the first
// finding. A single clause may only contain letters/digits/ordinary punctuation joined by a
// single ASCII space; every other whitespace, zero-width/format control, and clause-joining
// punctuation or terminator is a separator.
//   - NON_SPACE_WHITESPACE: any whitespace that is NOT a plain U+0020 space (tab, VT U+000B,
//     FF U+000C, CR, LF, NBSP U+00A0, U+2028/9, every other \p{Zs}/\p{Zl}/\p{Zp}).
//   - HIDDEN_FORMAT_CHARS: zero-width, bidi, and BOM/format controls that are not \s and could
//     hide a clause break (U+200B\u2013200F, U+202A\u2013202E, U+2060\u20132064, U+FEFF, U+180E).
//   - CLAUSE_PUNCTUATION: colon, semicolon, ellipsis (U+2026/U+22EF), any Unicode dash
//     (U+2012\u20132015), and a spaced ASCII hyphen " - " used as a clause dash (intra-word
//     hyphens like `test-suite` have no surrounding spaces and are allowed).
//   - NON_ASCII_TERMINATOR: any non-ASCII Sentence_Terminal (ideographic U+3002, fullwidth
//     U+FF01/FF1F, Arabic U+061F/06D4, Devanagari danda, \u2026) \u2014 these never appear intra-word in
//     a short English purpose, so they are rejected anywhere. ASCII . ! ? are handled by the
//     "terminator + whitespace + more text" rule so a trailing period / `v1.2` still pass.
//   - CLAUSE_COORDINATORS: clause-joining adverbs NOT already caught by atomic()'s
//     and|but|then|while|or|so list (also/however/additionally/furthermore/afterward(s)/
//     meanwhile/thereafter). "next"/"plus"/"finally" are deliberately EXCLUDED \u2014 they are
//     plausible intra-clause object words and would over-reject legitimate purposes.
const NON_SPACE_WHITESPACE = /[^\S ]/u;
const HIDDEN_FORMAT_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u180e]/u;
const CLAUSE_PUNCTUATION = /[;:\u2026\u22ef\u2012-\u2015]| - /u;
const NON_ASCII_TERMINATOR = /(?=\P{ASCII})\p{Sentence_Terminal}/u;
const CLAUSE_COORDINATORS = /\s(also|however|additionally|furthermore|afterwards?|meanwhile|thereafter)\s/i;

export interface StatementRule {
  id: string;
  version: string;
  inputs: string[];
}

export interface Statement {
  id: string;
  class: StatementClass;
  proposition: string;
  source_refs: string[];
  turn_ref?: number;
  actor?: string;
  rule?: StatementRule;
  // #622: only ever the literal `true`, and only on an `agent_stated` statement.
  // A typed self-report flag — NOT prose — that marks the proposition as the
  // agent's own stated purpose (self-report, never proof).
  self_report?: true;
}

export type NarrativeStatementErrorCode =
  | "invalid_input"
  | "invalid_source_ref"
  | "invalid_rule"
  | "non_atomic_proposition";

export class NarrativeStatementError extends Error {
  readonly name = "NarrativeStatementError";

  constructor(
    readonly code: NarrativeStatementErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: NarrativeStatementErrorCode, message: string): never {
  throw new NarrativeStatementError(code, message);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) return fail("invalid_input", `${label} must be a non-empty string`);
  if (/`/.test(value) || UNICODE_LINE_SEPARATORS.test(value) || value.includes("; ")) return fail("non_atomic_proposition", `${label} must not contain clause separators or backticks`);
  return value;
}

// The summarizer connective's proposition is a fully-formed sentence supplied by the
// caller (the orchestrator, from generated prose) that MAY legitimately contain
// backtick-quoted spans (quoting an underlying atomic proposition verbatim, per R2's
// inherited-never-upgraded discipline). It is therefore only non-empty-checked here;
// the shared `atomic()` scan (below, backtick-stripped skeleton) still enforces the
// single-clause/no-clause-separator discipline exactly like every other constructor.
function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) return fail("invalid_input", `${label} must be a non-empty string`);
  if (UNICODE_LINE_SEPARATORS.test(value)) return fail("non_atomic_proposition", `${label} must not contain line breaks`);
  return value;
}

// #622 (review HIGH R2): the strict single-clause bound for a stated purpose.
// text()/atomic() reject the conjunction / "; " / backtick / line-break classes,
// but a purpose could still chain clauses with SENTENCE TERMINATORS ("delete the
// audit trail. cover tracks"), COMMA LISTS ("cover tracks, avoid detection, ..."),
// or Unicode line/paragraph separators. This guard closes that class at construct.
// Rule (documented, defensible): a sentence terminator (. ! ?) that is FOLLOWED by
// more text starts a second clause and is rejected; a single trailing terminator on
// one short clause (e.g. "ship the fix.") is allowed. At most one comma is tolerated
// (a single subordinate aside) — two or more comma-separated segments is a list /
// clause chain and is rejected. The full Unicode separator class is rejected too.
function singleClause(value: string, label: string): void {
  if (NON_SPACE_WHITESPACE.test(value)) return fail("non_atomic_proposition", `${label} must be a single clause (no whitespace other than single spaces)`);
  if (HIDDEN_FORMAT_CHARS.test(value)) return fail("non_atomic_proposition", `${label} must be a single clause (no zero-width or format-control characters)`);
  if (CLAUSE_PUNCTUATION.test(value)) return fail("non_atomic_proposition", `${label} must be a single clause (no colon/semicolon/dash/ellipsis clause separators)`);
  if (NON_ASCII_TERMINATOR.test(value)) return fail("non_atomic_proposition", `${label} must be a single clause (no non-ASCII sentence terminators)`);
  if (/[.!?]\s+\S/u.test(value)) return fail("non_atomic_proposition", `${label} must be a single clause (no sentence-terminated sub-clauses)`);
  if ((value.match(/,/gu)?.length ?? 0) >= 2) return fail("non_atomic_proposition", `${label} must be a single clause (no comma-chained sub-clauses)`);
  if (CLAUSE_COORDINATORS.test(value)) return fail("non_atomic_proposition", `${label} must be a single clause (no clause-joining coordinators)`);
}

// Review H3: identifier-shaped inputs (tool names, event types, agent ids,
// paths) must not be able to smuggle prose into a proposition — a charset
// constraint kills the injection class wholesale instead of chasing
// conjunction blacklists. Free text (commands) is backtick-quoted by the
// templates and excluded from the atomicity scan instead.
const IDENTIFIER = /^[A-Za-z0-9._:@#/\\-]+$/;
function identifier(value: unknown, label: string): string {
  const checked = text(value, label);
  if (!IDENTIFIER.test(checked)) return fail("invalid_input", `${label} must be identifier-shaped (no spaces or prose): ${checked}`);
  return checked;
}

function sourceRefs(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length === 0) return fail("invalid_source_ref", "source_refs must contain at least one fa1 source ID");
  return values.map((value) => {
    try {
      parseSourceId(value);
      return value;
    } catch {
      return fail("invalid_source_ref", `invalid narrative source reference: ${String(value)}`);
    }
  });
}

function atomic(proposition: string): string {
  // Review H3: the atomicity scan runs over the template SKELETON — backtick-
  // quoted free-text spans (commands) are excluded, so a command containing
  // English conjunctions cannot trip it, while nothing outside quotes may
  // introduce a second clause via any common conjunction.
  const skeleton = proposition.replace(/`[^`]*`/g, "`_`");
  if (UNICODE_LINE_SEPARATORS.test(skeleton) || skeleton.includes("; ") || /\s(and|but|then|while|or|so)\s/i.test(skeleton)) {
    return fail("non_atomic_proposition", "statement proposition must contain exactly one clause");
  }
  return proposition;
}

function statementId(statementClass: StatementClass, proposition: string, refs: readonly string[]): string {
  const identity = JSON.stringify([statementClass, proposition, [...refs].sort()]);
  // Review M1: 16 hex chars (64 bits) — 8 was collision-plausible at realistic
  // statement volumes (~1% at 9.3k statements).
  return createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16);
}

function construct(input: {
  class: StatementClass;
  proposition: string;
  sourceRefs: readonly string[];
  turnRef?: number;
  actor?: string;
  rule?: StatementRule;
  selfReport?: true;
  id?: string;
}): Statement {
  const refs = sourceRefs(input.sourceRefs);
  const proposition = atomic(input.proposition);
  if ((input.class === "observed" || input.class === "summarizer_inferred" || input.class === "agent_stated") && input.rule) {
    return fail("invalid_rule", `${input.class} statements must not carry a rule`);
  }
  if (input.class === "deterministic_derived" && !input.rule) return fail("invalid_rule", "deterministic_derived statements require a rule");
  // #622: an agent_stated annotation is a typed self-report. It MUST carry an
  // attributed actor and the required literal self_report:true, and ONLY the
  // agent_stated class may carry that flag — no other class can masquerade as a
  // self-report, and a self-report can never be anonymous.
  if (input.class === "agent_stated") {
    if (input.actor === undefined) return fail("invalid_input", "agent_stated statements require an actor");
    if (input.selfReport !== true) return fail("invalid_input", "agent_stated statements require self_report: true");
  } else if (input.selfReport !== undefined) {
    return fail("invalid_input", "self_report is only valid on agent_stated statements");
  }
  if (input.turnRef !== undefined && (!Number.isSafeInteger(input.turnRef) || input.turnRef < -1)) {
    return fail("invalid_input", "turn_ref must be a safe turn ordinal");
  }

  let rule: StatementRule | undefined;
  if (input.rule) {
    const inputs = sourceRefs(input.rule.inputs);
    if (inputs.some((sourceId) => !refs.includes(sourceId))) return fail("invalid_rule", "rule inputs must be a subset of source_refs");
    rule = { id: text(input.rule.id, "rule.id"), version: text(input.rule.version, "rule.version"), inputs };
  }

  const actor = input.actor === undefined ? undefined : text(input.actor, "actor");
  const id = input.id !== undefined ? identifier(input.id, "id") : statementId(input.class, proposition, refs);
  return {
    id,
    class: input.class,
    proposition,
    source_refs: refs,
    ...(input.turnRef !== undefined ? { turn_ref: input.turnRef } : {}),
    ...(actor !== undefined ? { actor } : {}),
    ...(rule ? { rule } : {}),
    ...(input.selfReport === true ? { self_report: true as const } : {}),
  };
}

export function observedCommand(input: {
  sourceId: string;
  command: string;
  observedResult: ObservedResult;
  exitCode: number | null;
  actor?: string;
}): Statement {
  const command = text(input.command, "command");
  if (!["pass", "fail", "ambiguous"].includes(input.observedResult)) return fail("invalid_input", "observedResult is invalid");
  if (input.exitCode !== null && !Number.isSafeInteger(input.exitCode)) return fail("invalid_input", "exitCode must be an integer or null");
  if (input.observedResult === "pass" && input.exitCode !== 0) return fail("invalid_input", "a passing observation requires exitCode 0");
  if (input.observedResult !== "pass" && input.exitCode === 0) return fail("invalid_input", "exitCode 0 requires a passing observation");
  const result = input.observedResult === "ambiguous" ? "complete ambiguously" : input.observedResult;
  const exit = input.exitCode === null ? "unknown" : String(input.exitCode);
  return construct({
    class: "observed",
    proposition: `Command \`${command}\` was observed to ${result} (exit ${exit})`,
    sourceRefs: [input.sourceId],
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
  });
}

export function observedToolAction(input: {
  sourceId: string;
  toolName: string;
  eventType: string;
  actor?: string;
}): Statement {
  return construct({
    class: "observed",
    proposition: `Tool ${identifier(input.toolName, "toolName")} emitted event ${identifier(input.eventType, "eventType")}`,
    sourceRefs: [input.sourceId],
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
  });
}

export function observedDelegation(input: {
  sourceId: string;
  agentId?: string | null;
  targets?: string[];
}): Statement {
  const actor = input.agentId == null || input.agentId === "" ? "unattributed" : identifier(input.agentId, "agentId");
  const targets = input.targets?.map((target) => identifier(target, "target")) ?? [];
  const proposition = targets.length > 0
    ? `Agent ${actor} delegated work to ${targets.join(", ")}`
    : `Agent ${actor} delegated work`;
  return construct({ class: "observed", proposition, sourceRefs: [input.sourceId], actor });
}

export function observedFileCreation(input: { sourceId: string; path: string }): Statement {
  // Re-review H3 regression fix: paths are legitimately space-bearing free
  // text (the fa1 file scope is percent-encoded), so they quote like commands
  // rather than passing the identifier charset — injection stays impossible
  // because the atomicity scan runs over the backtick-stripped skeleton.
  return construct({
    class: "observed",
    proposition: `File \`${text(input.path, "path")}\` was observed to be created`,
    sourceRefs: [input.sourceId],
  });
}

export function derivedRetry(input: {
  sourceIds: string[];
  command: string;
  attempts: number;
  ruleInputs: string[];
}): Statement {
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 2) return fail("invalid_input", "attempts must be an integer of at least two");
  const command = text(input.command, "command");
  return construct({
    class: "deterministic_derived",
    proposition: `Command \`${command}\` was retried across ${input.attempts} attempts`,
    sourceRefs: input.sourceIds,
    rule: { id: "retry-detection", version: "v1", inputs: input.ruleInputs },
  });
}

export function derivedNoOpTurn(input: { turnRef: number; sourceIds: string[] }): Statement {
  if (!Number.isSafeInteger(input.turnRef) || input.turnRef < -1) return fail("invalid_input", "turnRef must be a safe turn ordinal");
  return construct({
    class: "deterministic_derived",
    proposition: `Turn ${input.turnRef} was classified as a no-op`,
    sourceRefs: input.sourceIds,
    turnRef: input.turnRef,
    rule: { id: "no-op-turn", version: "v1", inputs: input.sourceIds },
  });
}

export function derivedTimeout(input: { sourceId: string; operation: string; timeoutMs?: number }): Statement {
  // Review H2a: the timeout fact is material with or without a recorded duration.
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0)) return fail("invalid_input", "timeoutMs must be a non-negative safe integer when present");
  const budget = input.timeoutMs === undefined ? "its timeout (duration unknown)" : `its ${input.timeoutMs} ms timeout`;
  return construct({
    class: "deterministic_derived",
    proposition: `Operation \`${text(input.operation, "operation")}\` exceeded ${budget}`,
    sourceRefs: [input.sourceId],
    rule: { id: "timeout-detection", version: "v1", inputs: [input.sourceId] },
  });
}

export function derivedUnavailableSource(input: { sourceId: string; reason: UnavailableReason }): Statement {
  if (!["expired", "redacted", "unauthorized", "not_captured", "corrupt"].includes(input.reason)) {
    return fail("invalid_input", "reason is not a supported unavailable-source reason");
  }
  return construct({
    class: "deterministic_derived",
    proposition: `Source ${input.sourceId} was unavailable because ${text(input.reason, "reason")}`,
    sourceRefs: [input.sourceId],
    rule: { id: "unavailable-source", version: "v1", inputs: [input.sourceId] },
  });
}

// #614: the model-assisted prose renderer's connective class. A summarizer_inferred
// statement carries generated connective text (never a raw model claim standing alone —
// the dormant PROHIBITED_ASSERTIONS/grounding-check:summary checks in grounding-validator.ts
// are the enforcement layer) and MUST cite the real fa1 source_refs of the atomic
// (observed/deterministic_derived) statements it summarizes -- never a fabricated or
// statement-id-shaped reference. No `rule`: that field is deterministic_derived-only.
export function summarizerInferredConnective(input: {
  id?: string;
  proposition: string;
  source_refs: string[];
  turn_ref?: number;
  actor?: string;
}): Statement {
  return construct({
    class: "summarizer_inferred",
    proposition: nonEmptyText(input.proposition, "proposition"),
    sourceRefs: input.source_refs,
    ...(input.turn_ref !== undefined ? { turnRef: input.turn_ref } : {}),
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
    ...(input.id !== undefined ? { id: input.id } : {}),
  });
}

// #622: the agent's STATED purpose for a material action — a typed self-report
// (never proof, never gate evidence). Modeled on summarizerInferredConnective
// but deliberately using the STRICT text()+atomic() guards (NOT the relaxed
// nonEmptyText path) plus a hard length cap AND a single-clause bound: a
// multi-clause / reasoning-dump / sentence-chained / comma-listed / over-length
// purpose is rejected AT CONSTRUCT TIME (review HIGH R2). There is no
// reasoning/alternatives/hidden_alternative field — the field allowlist forbids
// free-form chain-of-thought (R2). The purpose cites exactly the material
// action's fa1 source (sourceId); self_report:true and an attributed actor are
// REQUIRED (enforced in construct()). The `actor` is constrained to the strict
// identifier charset + a hard length cap (review HIGH R2): it is an attribution
// KEY, never a place to smuggle prose or prohibited-assertion keywords past the
// proposition scan (grounding-validator additionally scans the actor).
export function agentStatedIntent(input: {
  sourceId: string;
  purpose: string;
  actor: string;
  turnRef?: number;
}): Statement {
  const purpose = text(input.purpose, "purpose");
  if (purpose.length > AGENT_STATED_PURPOSE_MAX_LENGTH) {
    return fail("invalid_input", `purpose must be at most ${AGENT_STATED_PURPOSE_MAX_LENGTH} characters`);
  }
  singleClause(purpose, "purpose");
  const actor = identifier(input.actor, "actor");
  if (actor.length > AGENT_STATED_ACTOR_MAX_LENGTH) {
    return fail("invalid_input", `actor must be at most ${AGENT_STATED_ACTOR_MAX_LENGTH} characters`);
  }
  return construct({
    class: "agent_stated",
    proposition: `Agent stated the purpose of this action is to ${purpose}`,
    sourceRefs: [input.sourceId],
    actor,
    selfReport: true,
    ...(input.turnRef !== undefined ? { turnRef: input.turnRef } : {}),
  });
}

// #622: the deterministic fallback emitted where at-action intent capture is not
// supported (or no purpose survives the policy filter). A deterministic_derived
// statement whose proposition is derived ONLY from the active gate reference —
// NEVER a fabricated agent rationale. Structurally distinct from agent_stated
// (a different class carrying a rule and NO self_report flag), so the fallback
// can never be mistaken for a self-report the agent did not make (R4).
export function workflowDerivedPurpose(input: {
  activeGateRef: string;
  objectiveRef?: string;
}): Statement {
  const refs = input.objectiveRef ? [input.activeGateRef, input.objectiveRef] : [input.activeGateRef];
  return construct({
    class: "deterministic_derived",
    proposition: `Intent for this action was derived from active gate reference ${input.activeGateRef}`,
    sourceRefs: refs,
    rule: { id: "workflow-derived-purpose", version: "v1", inputs: [input.activeGateRef] },
  });
}
