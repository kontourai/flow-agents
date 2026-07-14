import { createHash } from "node:crypto";
import type { UnavailableReason } from "./integrity.js";
import { parseSourceId } from "./source-ids.js";

export type StatementClass = "observed" | "deterministic_derived";
export type ObservedResult = "pass" | "fail" | "ambiguous";

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
  if (/[\r\n]/.test(value) || value.includes("; ")) return fail("non_atomic_proposition", `${label} must not contain clause separators`);
  return value;
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
  if (/[\r\n]/.test(proposition) || proposition.includes("; ") || /\sand\s/i.test(proposition)) {
    return fail("non_atomic_proposition", "statement proposition must contain exactly one clause");
  }
  return proposition;
}

function statementId(statementClass: StatementClass, proposition: string, refs: readonly string[]): string {
  const identity = JSON.stringify([statementClass, proposition, [...refs].sort()]);
  return createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 8);
}

function construct(input: {
  class: StatementClass;
  proposition: string;
  sourceRefs: readonly string[];
  turnRef?: number;
  actor?: string;
  rule?: StatementRule;
}): Statement {
  const refs = sourceRefs(input.sourceRefs);
  const proposition = atomic(input.proposition);
  if (input.class === "observed" && input.rule) return fail("invalid_rule", "observed statements must not carry a rule");
  if (input.class === "deterministic_derived" && !input.rule) return fail("invalid_rule", "deterministic_derived statements require a rule");
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
  return {
    id: statementId(input.class, proposition, refs),
    class: input.class,
    proposition,
    source_refs: refs,
    ...(input.turnRef !== undefined ? { turn_ref: input.turnRef } : {}),
    ...(actor !== undefined ? { actor } : {}),
    ...(rule ? { rule } : {}),
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
    proposition: `Command ${command} was observed to ${result} (exit ${exit})`,
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
    proposition: `Tool ${text(input.toolName, "toolName")} emitted event ${text(input.eventType, "eventType")}`,
    sourceRefs: [input.sourceId],
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
  });
}

export function observedDelegation(input: {
  sourceId: string;
  agentId?: string | null;
  targets?: string[];
}): Statement {
  const actor = input.agentId == null || input.agentId === "" ? "unattributed" : text(input.agentId, "agentId");
  const targets = input.targets?.map((target) => text(target, "target")) ?? [];
  const proposition = targets.length > 0
    ? `Agent ${actor} delegated work to ${targets.join(", ")}`
    : `Agent ${actor} delegated work`;
  return construct({ class: "observed", proposition, sourceRefs: [input.sourceId], actor });
}

export function observedFileCreation(input: { sourceId: string; path: string }): Statement {
  return construct({
    class: "observed",
    proposition: `File ${text(input.path, "path")} was observed to be created`,
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
  return construct({
    class: "deterministic_derived",
    proposition: `Command ${text(input.command, "command")} was retried across ${input.attempts} attempts`,
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

export function derivedTimeout(input: { sourceId: string; operation: string; timeoutMs: number }): Statement {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0) return fail("invalid_input", "timeoutMs must be a non-negative safe integer");
  return construct({
    class: "deterministic_derived",
    proposition: `Operation ${text(input.operation, "operation")} exceeded its ${input.timeoutMs} ms timeout`,
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
