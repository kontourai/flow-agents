import * as fs from "node:fs";
import * as path from "node:path";
import type { GroundedExecutionNarrative } from "./envelope.js";
import type { UnavailableReason } from "./integrity.js";
import { resolveSource, verifyManifest, type ResolveSourceResult } from "./resolver.js";
import { parseSourceId } from "./source-ids.js";
import type { NarrativeSourceManifest } from "./snapshot.js";
import type { Statement } from "./statements.js";
import { buildTurnSpine } from "./turn-spine.js";

export type MaterialEventKind =
  | "command_failure"
  | "retry_group"
  | "timeout"
  | "no_op_turn"
  | "file_creation";

export type AssertionKind = "gate_status" | "observed_outcome" | "authority" | "hidden_alternative";

export type GroundingViolation =
  | {
      code: "unresolved_citation";
      statement_id: string;
      source_ref: string;
      reason: UnavailableReason;
      detail: string;
    }
  | {
      code: "uncovered_material_event";
      event_kind: MaterialEventKind;
      source_ref: string;
      detail: string;
    }
  | { code: "invalid_rule_binding"; statement_id: string; detail: string }
  | {
      code: "prohibited_assertion";
      statement_id: string;
      statement_class: string;
      assertion_kind: AssertionKind;
      detail: string;
    };

export type GroundingViolationCode = GroundingViolation["code"];

export interface GroundingKnownGap {
  code: "contradiction_detection_unavailable";
  detail: string;
}

export type GroundingVerdict =
  | { ok: true; known_gaps: GroundingKnownGap[] }
  | { ok: false; violations: GroundingViolation[]; known_gaps: GroundingKnownGap[] };

export interface EntailmentIdentity {
  model: string;
  provider: string;
  config_hash: string;
}

export interface EntailmentVerdict {
  statement_id: string;
  entailed: boolean;
  reason: string;
}

/**
 * Declared provenance contract for the future model-entailment executor. When
 * #614 ships that executor, this record will be anchored as a manifest source
 * stream so its bytes are content-addressed and resolvable like other evidence.
 */
export interface EntailmentProvenance extends EntailmentIdentity {
  prompt_version: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  wall_clock_ms: number;
  verdicts: EntailmentVerdict[];
}

export function entailmentIndependenceHolds(generator: EntailmentIdentity, validator: EntailmentIdentity): boolean {
  return generator.model !== validator.model || generator.config_hash !== validator.config_hash;
}

const PROHIBITED_ASSERTIONS: Readonly<Record<string, ReadonlySet<AssertionKind>>> = {
  // Declared-but-dormant until #614/#622 add these classes to StatementClass.
  summarizer_inferred: new Set(["gate_status", "observed_outcome", "authority", "hidden_alternative"]),
  agent_stated: new Set(["gate_status", "observed_outcome", "authority", "hidden_alternative"]),
};

/** Generic (statement class, assertion kind) policy seam for current and future classes. */
export function isAssertionProhibited(statementClass: string, assertionKind: AssertionKind): boolean {
  return PROHIBITED_ASSERTIONS[statementClass]?.has(assertionKind) ?? false;
}

export interface ValidateNarrativeGroundingOptions {
  /** Test seam; production always uses the frozen-manifest resolver. */
  resolver?: (narrativeDir: string, sourceId: string) => ResolveSourceResult;
}

export class NarrativeGroundingError extends Error {
  readonly name = "NarrativeGroundingError";
  readonly code = "grounding_failed" as const;

  constructor(readonly violations: GroundingViolation[]) {
    super(`narrative grounding gate failed: ${violations.map(describeViolation).join("; ")}`);
  }
}

interface ResolvedRecord {
  sourceId: string;
  sourceIndex: number;
  stream: string;
  record?: Record<string, unknown>;
}

interface MaterialEvent {
  kind: MaterialEventKind;
  sourceRef: string;
  sourceRefs: string[];
  expectedProposition?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined;
}

function nested(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return object(record[key]);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = string(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

function eventType(record: Record<string, unknown>): string | undefined {
  return firstString(record["event_type"], record["kind"]);
}

function sessionId(record: Record<string, unknown>): string | undefined {
  return firstString(record["session_id"], record["sessionId"]);
}

function toolName(record: Record<string, unknown>, event: string): string {
  return firstString(nested(record, "tool")?.["name"], record["tool_name"], record["toolName"])
    ?? (event.startsWith("session.") ? "session" : event === "turn.user" ? "turn" : "runtime");
}

// #623: the validator's material-event derivation must observe commands through the
// SAME extraction projection.ts uses, or a real command failure emitted by projection
// would have no derived event and could be omitted from a narrative undetected. This
// mirrors projection.ts:commandFrom(record, tool) exactly — including the tool-gated
// bare-input fallback — for telemetry-stream commands. Cmdlog commands use
// record["command"] directly, matching projection.ts's cmdlog reader.
function commandFrom(record: Record<string, unknown>, tool: string): string | undefined {
  const toolRecord = nested(record, "tool");
  const input = toolRecord?.["input"];
  return firstString(
    record["command"],
    toolRecord?.["command"],
    object(input)?.["command"],
    /(?:shell|bash|command|exec)/i.test(tool) ? input : undefined,
  );
}

function exitCodeFrom(record: Record<string, unknown>): number | null {
  const tool = nested(record, "tool");
  const result = nested(record, "result");
  return integer(record["exit_code"])
    ?? integer(record["exitCode"])
    ?? integer(tool?.["exit_code"])
    ?? integer(tool?.["exitCode"])
    ?? integer(result?.["exit_code"])
    ?? integer(result?.["exitCode"])
    ?? null;
}

// Mirrors projection.ts:observedResultFrom's fail determination (including the
// tool.status textual fallback) so the derived material event agrees with the
// observed statement projection would emit.
function isFailure(record: Record<string, unknown>): boolean {
  const exitCode = exitCodeFrom(record);
  if (exitCode !== null) return exitCode !== 0;
  return /^(?:fail|failed|failure|error)$/i.test(
    firstString(record["result"], record["status"], record["outcome"], nested(record, "tool")?.["status"]) ?? "",
  );
}

// Mirrors projection.ts:carriesTimeoutSignal exactly — including the tool.status textual
// fallback — so a tool.status-only timeout projection would emit a statement for cannot be
// omitted from a narrative undetected (parallel to the isFailure tool.status fallback above).
function carriesTimeout(record: Record<string, unknown>): boolean {
  if (record["timed_out"] === true || record["timedOut"] === true) return true;
  const status = firstString(record["status"], record["result"], record["outcome"], nested(record, "tool")?.["status"]);
  if (status && /^(?:timeout|timed_out|timed-out)$/i.test(status)) return true;
  const error = nested(record, "error");
  return /timeout/i.test(firstString(error?.["code"], error?.["name"]) ?? "");
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function parseRecord(bytes: Uint8Array): Record<string, unknown> | undefined {
  try { return object(JSON.parse(Buffer.from(bytes).toString("utf8"))); }
  catch { return undefined; }
}

function readVerifiedManifest(narrativeDir: string): NarrativeSourceManifest {
  const verification = verifyManifest(narrativeDir);
  if (verification.perSource.some((entry) => entry.sourceId === "manifest")) {
    throw new Error("narrative grounding validator could not verify the frozen source manifest");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(path.join(narrativeDir, "source-manifest.json"), "utf8")); }
  catch { throw new Error("narrative grounding validator could not read the frozen source manifest"); }
  return parsed as NarrativeSourceManifest;
}

function statementsFrom(envelope: GroundedExecutionNarrative): Statement[] {
  const runtime = envelope.sections.find((section) => section.authority === "flow-agents" && section.kind === "runtime-projection");
  if (!runtime || runtime.authority !== "flow-agents") throw new Error("narrative grounding validator requires one runtime projection section");
  return [...runtime.embedded.turns.flatMap((turn) => turn.statements), ...runtime.embedded.document_statements];
}

function citationViolations(
  statements: readonly Statement[],
  narrativeDir: string,
  resolver: (narrativeDir: string, sourceId: string) => ResolveSourceResult,
  declaredUnavailable: ReadonlyMap<string, UnavailableReason>,
): GroundingViolation[] {
  const violations: GroundingViolation[] = [];
  for (const statement of statements) {
    for (const sourceRef of statement.source_refs) {
      const resolved = resolver(narrativeDir, sourceRef);
      if (resolved.status === "unavailable") {
        // An unavailable-source statement is a typed disclosure of frozen
        // manifest status, not a claim about unavailable content. Preserve
        // that established completeness contract only when the exact ref is
        // manifest-declared unavailable; absent/fabricated refs still fail.
        const declaredReason = declaredUnavailable.get(sourceRef);
        const isExactDisclosure = declaredReason !== undefined
          && statement.class === "deterministic_derived"
          && statement.source_refs.length === 1
          && statement.rule?.id === "unavailable-source"
          && statement.rule.version === "v1"
          && statement.rule.inputs.length === 1
          && statement.rule.inputs[0] === sourceRef
          && statement.proposition === `Source ${sourceRef} was unavailable because ${declaredReason}`;
        if (isExactDisclosure) continue;
        violations.push({
          code: "unresolved_citation",
          statement_id: statement.id,
          source_ref: sourceRef,
          reason: resolved.reason,
          detail: resolved.detail,
        });
      }
    }
  }
  return violations;
}

// #623 (review MEDIUM): this keyword heuristic is a BEST-EFFORT deterministic backstop,
// not a security boundary. It reliably classifies the fixed-form propositions that today's
// two deterministic classes emit (observed/deterministic_derived constructors). It is NOT a
// robust check against free-form model prose — once summarizer_inferred prose ships, a
// paraphrase ("did not succeed", "broke") evades these patterns. The authoritative check for
// model prose is the model-entailment layer (R2/R3), which #614 activates; the prohibited-
// assertion engine here is the dormant-class scaffolding, and #614/#622 must not treat this
// regex as sufficient enforcement on its own.
function assertionKinds(proposition: string): AssertionKind[] {
  const kinds: AssertionKind[] = [];
  if (/\bgate\b.*\b(?:pass|fail|accept|reject)(?:ed)?\b/i.test(proposition)) kinds.push("gate_status");
  if (/\b(?:observed|passed|failed|succeeded|timed out|created)\b/i.test(proposition)) kinds.push("observed_outcome");
  if (/\b(?:authority|authoritative|approved|accepted)\b/i.test(proposition)) kinds.push("authority");
  if (/\b(?:no other|only possible|hidden alternative)\b/i.test(proposition)) kinds.push("hidden_alternative");
  return kinds;
}

function epistemicViolations(statements: readonly Statement[]): GroundingViolation[] {
  const violations: GroundingViolation[] = [];
  for (const statement of statements) {
    const statementClass = statement.class as string;
    if (statementClass === "observed" && statement.source_refs.length === 0) {
      violations.push({
        code: "prohibited_assertion",
        statement_id: statement.id,
        statement_class: statementClass,
        assertion_kind: "observed_outcome",
        detail: "observed statements require at least one resolvable source_ref",
      });
    }
    if (statementClass === "observed" && statement.rule) {
      violations.push({ code: "invalid_rule_binding", statement_id: statement.id, detail: "observed statements must not carry a derivation rule" });
    }
    if (statementClass === "deterministic_derived") {
      if (!statement.rule) {
        violations.push({ code: "invalid_rule_binding", statement_id: statement.id, detail: "deterministic_derived statements require a rule" });
      } else if (statement.rule.inputs.some((sourceRef) => !statement.source_refs.includes(sourceRef))) {
        violations.push({ code: "invalid_rule_binding", statement_id: statement.id, detail: "rule inputs must be a subset of source_refs" });
      }
    }
    for (const kind of assertionKinds(statement.proposition)) {
      if (isAssertionProhibited(statementClass, kind)) {
        violations.push({
          code: "prohibited_assertion",
          statement_id: statement.id,
          statement_class: statementClass,
          assertion_kind: kind,
          detail: `${statementClass} statements may not assert ${kind.replace(/_/g, " ")}`,
        });
      }
    }
  }
  return violations;
}

function deriveMaterialEvents(manifest: NarrativeSourceManifest, resolved: readonly ResolvedRecord[]): MaterialEvent[] {
  const events: MaterialEvent[] = [];
  const commandFailureEvent = (entry: ResolvedRecord, command: string): MaterialEvent => {
    const exitCode = exitCodeFrom(entry.record!);
    return {
      kind: "command_failure",
      sourceRef: entry.sourceId,
      sourceRefs: [entry.sourceId],
      expectedProposition: `Command \`${command}\` was observed to fail (exit ${exitCode === null ? "unknown" : String(exitCode)})`,
    };
  };

  // Cmdlog stream: projection.ts reads record["command"] directly for cmdlog entries.
  const cmdlog = resolved.filter((entry) => entry.stream === "cmdlog" && entry.record);
  for (const entry of cmdlog) {
    const command = string(entry.record!["command"]);
    if (command && isFailure(entry.record!)) events.push(commandFailureEvent(entry, command));
  }

  let run: ResolvedRecord[] = [];
  const flushRun = (): void => {
    if (run.length >= 2 && run[0]?.record && isFailure(run[0].record)) {
      events.push({ kind: "retry_group", sourceRef: run[0].sourceId, sourceRefs: run.map((entry) => entry.sourceId) });
    }
    run = [];
  };
  for (const entry of cmdlog) {
    const command = string(entry.record!["command"]);
    if (!command) { flushRun(); continue; }
    const firstCommand = run[0]?.record ? string(run[0].record["command"]) : undefined;
    if (firstCommand && normalizeCommand(firstCommand) !== normalizeCommand(command)) flushRun();
    run.push(entry);
    if (!isFailure(entry.record!) && run.length === 1) flushRun();
  }
  flushRun();

  const telemetry = resolved.filter((entry) => entry.stream === "telemetry" && entry.record);
  for (const entry of telemetry) {
    // #623 (review HIGH): projection.ts also emits an observed command statement for
    // commands captured via the telemetry stream (a tool.result event carrying a command
    // + non-zero exit). Derive the matching command_failure event through the SAME
    // tool-gated extraction so a telemetry-sourced failure cannot be omitted undetected.
    const record = entry.record!;
    const event = eventType(record);
    if (event) {
      const command = commandFrom(record, toolName(record, event));
      if (command && isFailure(record)) events.push(commandFailureEvent(entry, command));
    }
    if (carriesTimeout(record)) events.push({ kind: "timeout", sourceRef: entry.sourceId, sourceRefs: [entry.sourceId] });
  }

  for (const entry of resolved.filter((candidate) => candidate.stream === "file")) {
    const parsed = parseSourceId(entry.sourceId);
    if (parsed.stream === "file") events.push({
      kind: "file_creation",
      sourceRef: entry.sourceId,
      sourceRefs: [entry.sourceId],
      expectedProposition: `File \`${parsed.scope.repoRelativePath}\` was observed to be created`,
    });
  }

  // Normalize session_id/event_type aliases before building the turn spine, exactly as
  // projection.ts:normalizedTelemetry does, so the validator's independently-rebuilt spine
  // matches projection's turn assignment and cannot diverge on alias-keyed records.
  const spine = buildTurnSpine(telemetry.map((entry) => ({
    sourceId: entry.sourceId,
    record: {
      ...entry.record!,
      ...(sessionId(entry.record!) ? { session_id: sessionId(entry.record!) } : {}),
      ...(eventType(entry.record!) ? { event_type: eventType(entry.record!) } : {}),
    },
  })));
  const indexBySource = new Map(manifest.sources.map((entry, index) => [entry.source_id, index]));
  const activeTurns = new Set<number>();
  for (const entry of telemetry) {
    const event = eventType(entry.record!);
    if (!event || !commandFrom(entry.record!, toolName(entry.record!, event))) continue;
    const turn = spine.find((candidate) => candidate.sources.includes(entry.sourceId));
    if (turn) activeTurns.add(turn.ordinal);
  }
  const nearestTurn = (entry: ResolvedRecord): number | undefined => {
    const session = firstString(entry.record?.["session_id"], entry.record?.["sessionId"]);
    if (!session) return undefined;
    let best: { ordinal: number; distance: number } | undefined;
    for (const turn of spine) {
      if (turn.sessionId !== session) continue;
      for (const sourceId of turn.sources) {
        const distance = Math.abs(entry.sourceIndex - (indexBySource.get(sourceId) ?? entry.sourceIndex));
        if (!best || distance < best.distance || (distance === best.distance && turn.ordinal < best.ordinal)) best = { ordinal: turn.ordinal, distance };
      }
    }
    return best?.ordinal;
  };
  for (const entry of resolved.filter((candidate) => ["agent-event", "delegation", "file"].includes(candidate.stream))) {
    const ordinal = nearestTurn(entry);
    if (ordinal !== undefined) activeTurns.add(ordinal);
  }
  for (const turn of spine) {
    if (!activeTurns.has(turn.ordinal) && turn.sources.length > 0) {
      events.push({ kind: "no_op_turn", sourceRef: turn.sources[0]!, sourceRefs: [...turn.sources] });
    }
  }
  return events;
}

function eventIsCovered(event: MaterialEvent, statements: readonly Statement[]): boolean {
  return statements.some((statement) => {
    if (!event.sourceRefs.every((sourceRef) => statement.source_refs.includes(sourceRef))) return false;
    switch (event.kind) {
      // Observed statements cannot carry rules. These two match their typed
      // constructor output by class + atomic proposition + triggering source.
      case "command_failure":
      case "file_creation": return statement.class === "observed" && statement.proposition === event.expectedProposition;
      case "retry_group": return statement.rule?.id === "retry-detection";
      case "timeout": return statement.rule?.id === "timeout-detection";
      case "no_op_turn": return statement.rule?.id === "no-op-turn";
    }
  });
}

function materialViolations(events: readonly MaterialEvent[], statements: readonly Statement[]): GroundingViolation[] {
  return events.flatMap((event) => eventIsCovered(event, statements) ? [] : [{
    code: "uncovered_material_event" as const,
    event_kind: event.kind,
    source_ref: event.sourceRef,
    detail: `${event.kind} from ${event.sourceRef} has no matching grounded statement`,
  }]);
}

function describeViolation(violation: GroundingViolation): string {
  switch (violation.code) {
    case "unresolved_citation": return `${violation.code} ${violation.source_ref} (${violation.reason}: ${violation.detail})`;
    case "uncovered_material_event": return `${violation.code} ${violation.event_kind} ${violation.source_ref}`;
    case "invalid_rule_binding": return `${violation.code} ${violation.statement_id}: ${violation.detail}`;
    case "prohibited_assertion": return `${violation.code} ${violation.statement_id}/${violation.assertion_kind}: ${violation.detail}`;
  }
}

export function validateNarrativeGrounding(
  envelope: GroundedExecutionNarrative,
  narrativeDir: string,
  opts: ValidateNarrativeGroundingOptions = {},
): GroundingVerdict {
  const statements = statementsFrom(envelope);
  const manifest = readVerifiedManifest(narrativeDir);
  const resolver = opts.resolver ?? resolveSource;
  const resolved: ResolvedRecord[] = [];
  for (const [sourceIndex, entry] of manifest.sources.entries()) {
    const result = resolver(narrativeDir, entry.source_id);
    if (result.status !== "resolved") continue;
    const stream = parseSourceId(entry.source_id).stream;
    // Foreign sections are already byte/hash checked by the composer and are
    // deliberately not reinterpreted as runtime statement evidence here.
    if (stream === "flow-report" || stream === "surface-explanation") continue;
    resolved.push({ sourceId: entry.source_id, sourceIndex, stream, record: parseRecord(result.content) });
  }

  const violations: GroundingViolation[] = [];
  const declaredUnavailable = new Map(manifest.sources
    .filter((entry) => entry.status === "unavailable")
    .map((entry) => [entry.source_id, entry.unavailable_reason]));
  /* grounding-check:citation */
  violations.push(...citationViolations(statements, narrativeDir, resolver, declaredUnavailable));
  /* grounding-check:material */
  violations.push(...materialViolations(deriveMaterialEvents(manifest, resolved), statements));
  /* grounding-check:epistemic */
  violations.push(...epistemicViolations(statements));

  const known_gaps: GroundingKnownGap[] = [{
    code: "contradiction_detection_unavailable",
    detail: "the frozen source manifest has no raw contradiction signal; contradiction detection is sequenced to #568/#425",
  }];
  return violations.length === 0 ? { ok: true, known_gaps } : { ok: false, violations, known_gaps };
}
