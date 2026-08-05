import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CaptureCompleteness } from "./integrity.js";
import { resolveSource, verifyManifest } from "./resolver.js";
import { parseSourceId, type NarrativeSourceStream } from "./source-ids.js";
import {
  derivedNoOpTurn,
  derivedRetry,
  derivedTimeout,
  derivedUnavailableSource,
  observedCommand,
  observedDelegation,
  observedFileCreation,
  observedToolAction,
  type ObservedResult,
  type Statement,
} from "./statements.js";
import type { NarrativeSourceManifest } from "./snapshot.js";
import { buildTurnSpine, type TurnBoundary } from "./turn-spine.js";

export const NARRATIVE_RUNTIME_PROJECTION_SCHEMA_VERSION = "grounded-runtime-projection/v1" as const;
export const NARRATIVE_RUNTIME_PROJECTOR = { name: "flow-agents-runtime-projector", version: "1.0.0" } as const;

export type NarrativeProjectionErrorCode = "manifest_invalid" | "malformed_snapshot" | "coverage_gap";

export class NarrativeProjectionError extends Error {
  readonly name = "NarrativeProjectionError";

  constructor(
    readonly code: NarrativeProjectionErrorCode,
    message: string,
    readonly sourceId?: string,
  ) {
    super(message);
  }
}

export interface RuntimePurpose { step: string; gate: string }

export interface RuntimeProjectionTurn {
  ordinal: number;
  sessionId: string;
  turnId?: string;
  boundary: TurnBoundary;
  purpose?: RuntimePurpose;
  known_gap_refs: string[];
  statements: Statement[];
}

export interface NarrativeRuntimeProjection {
  schema_version: typeof NARRATIVE_RUNTIME_PROJECTION_SCHEMA_VERSION;
  narrative_id: string;
  provenance: {
    projector: typeof NARRATIVE_RUNTIME_PROJECTOR;
    projected_at: string;
    manifest_sha256: string;
  };
  capture_completeness: CaptureCompleteness;
  turns: RuntimeProjectionTurn[];
  document_statements: Statement[];
  coverage: { sources: number; cited: number; unavailable: number };
}

export interface ProjectRuntimeNarrativeOptions { projectedAt: string }

interface ResolvedRecord {
  sourceId: string;
  sourceIndex: number;
  stream: NarrativeSourceStream;
  record: Record<string, unknown>;
}

interface OrderedStatement { statement: Statement; sourceIndex: number; emissionIndex: number }

type SchemaIssue = { path: string; message: string };
type JsonSchema = Record<string, any>;
const dateTimeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function projectionError(code: NarrativeProjectionErrorCode, message: string, sourceId?: string): never {
  throw new NarrativeProjectionError(code, message, sourceId);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

function commandFrom(record: Record<string, unknown>, tool: string): string | undefined {
  const toolRecord = nested(record, "tool");
  const input = toolRecord?.["input"];
  const inputCommand = object(input)?.["command"];
  return firstString(
    record["command"],
    toolRecord?.["command"],
    inputCommand,
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

function observedResultFrom(record: Record<string, unknown>, exitCode: number | null): ObservedResult {
  if (exitCode !== null) return exitCode === 0 ? "pass" : "fail";
  const raw = firstString(record["result"], record["status"], record["outcome"], nested(record, "tool")?.["status"]);
  if (raw && /^(?:fail|failed|failure|error)$/i.test(raw)) return "fail";
  // A textual pass without a captured exit code is not enough to invent exit 0.
  return "ambiguous";
}

function timeoutMsFrom(record: Record<string, unknown>): number | undefined {
  const tool = nested(record, "tool");
  return integer(record["timeout_ms"])
    ?? integer(record["timeoutMs"])
    ?? integer(tool?.["timeout_ms"])
    ?? integer(tool?.["timeoutMs"]);
}

function carriesTimeoutSignal(record: Record<string, unknown>): boolean {
  if (record["timed_out"] === true || record["timedOut"] === true) return true;
  const status = firstString(record["status"], record["result"], record["outcome"], nested(record, "tool")?.["status"]);
  if (status && /^(?:timeout|timed_out|timed-out)$/i.test(status)) return true;
  const error = nested(record, "error");
  return /timeout/i.test(firstString(error?.["code"], error?.["name"]) ?? "");
}

function valuesAsStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => string(item) ? [item as string] : []);
}

function lineageActor(record: Record<string, unknown>): string | undefined {
  const lineage = record["lineage"];
  const candidates = Array.isArray(lineage) ? [...lineage].reverse().map(object) : [object(lineage)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const actor = firstString(candidate["actor"], candidate["agent_id"], candidate["agentId"], candidate["parent_agent_id"], candidate["parentAgentId"]);
    if (actor) return actor;
  }
  return undefined;
}

function delegationTargets(record: Record<string, unknown>): string[] {
  const delegation = nested(record, "delegation");
  const plural = valuesAsStrings(record["targets"]);
  if (plural.length > 0) return plural;
  const nestedPlural = valuesAsStrings(delegation?.["targets"]);
  if (nestedPlural.length > 0) return nestedPlural;
  const one = firstString(record["target"], delegation?.["target"]);
  return one ? [one] : [];
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function purposeFrom(record: Record<string, unknown>): RuntimePurpose | undefined {
  const step = firstString(record["step"], record["current_step"]);
  const gate = string(record["gate"]);
  return step && gate ? { step, gate } : undefined;
}

function parseSnapshot(sourceId: string, bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { return projectionError("malformed_snapshot", `snapshot for ${sourceId} is not valid JSON`, sourceId); }
  const record = object(value);
  if (!record) return projectionError("malformed_snapshot", `snapshot for ${sourceId} must contain a JSON object`, sourceId);
  return record;
}

function readManifestAfterVerification(narrativeDir: string): { manifest: NarrativeSourceManifest; bytes: Buffer } {
  const file = path.join(narrativeDir, "source-manifest.json");
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = fs.readFileSync(file);
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return projectionError("manifest_invalid", "narrative source manifest could not be read after verification");
  }
  return { manifest: parsed as NarrativeSourceManifest, bytes };
}

function addTurnRef(statement: Statement, ordinal: number): Statement {
  return statement.turn_ref === ordinal ? statement : { ...statement, turn_ref: ordinal };
}

function nearestTurnOrdinal(
  record: ResolvedRecord,
  turns: readonly RuntimeProjectionTurn[],
  turnSourceIndexes: ReadonlyMap<number, number[]>,
): number | undefined {
  const session = sessionId(record.record);
  if (!session) return undefined;
  let best: { ordinal: number; distance: number } | undefined;
  for (const turn of turns) {
    if (turn.sessionId !== session) continue;
    for (const index of turnSourceIndexes.get(turn.ordinal) ?? []) {
      const distance = Math.abs(index - record.sourceIndex);
      if (!best || distance < best.distance || (distance === best.distance && turn.ordinal < best.ordinal)) {
        best = { ordinal: turn.ordinal, distance };
      }
    }
  }
  return best?.ordinal;
}

function resolveSchemaRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  if (!ref.startsWith("#/$defs/")) return undefined;
  return root.$defs?.[ref.slice("#/$defs/".length)];
}

function schemaMatches(value: unknown, schema: JsonSchema, root: JsonSchema): boolean {
  const issues: SchemaIssue[] = [];
  validateSchemaValue(value, schema, "$", issues, root);
  return issues.length === 0;
}

function validateSchemaValue(value: unknown, schema: JsonSchema, loc: string, issues: SchemaIssue[], root = schema): void {
  if (schema.$ref) {
    const resolved = resolveSchemaRef(schema.$ref, root);
    if (!resolved) issues.push({ path: loc, message: `unsupported schema ref ${schema.$ref}` });
    else validateSchemaValue(value, resolved, loc, issues, root);
    return;
  }
  if (schema.anyOf && !schema.anyOf.some((sub: JsonSchema) => schemaMatches(value, sub, root))) issues.push({ path: loc, message: "must match at least one allowed schema" });
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub: JsonSchema) => schemaMatches(value, sub, root)).length;
    if (matches !== 1) issues.push({ path: loc, message: "must match exactly one allowed schema" });
  }
  if (schema.not && schemaMatches(value, schema.not, root)) issues.push({ path: loc, message: "must not match forbidden schema" });
  for (const sub of schema.allOf ?? []) validateSchemaValue(value, sub, loc, issues, root);
  if (schema.const !== undefined && value !== schema.const) issues.push({ path: loc, message: `must equal ${String(schema.const)}` });
  if (schema.enum && !schema.enum.includes(value)) issues.push({ path: loc, message: `must be one of ${schema.enum.join(", ")}` });
  if (schema.type === "string") {
    if (typeof value !== "string") { issues.push({ path: loc, message: "must be string" }); return; }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) issues.push({ path: loc, message: "must not be empty" });
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) issues.push({ path: loc, message: "has invalid format" });
    if (schema.format === "date-time" && (!dateTimeRe.test(value) || Number.isNaN(Date.parse(value)))) issues.push({ path: loc, message: "must be date-time" });
    return;
  }
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) { issues.push({ path: loc, message: "must be integer" }); return; }
    if (typeof schema.minimum === "number" && (value as number) < schema.minimum) issues.push({ path: loc, message: `must be at least ${schema.minimum}` });
    return;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") issues.push({ path: loc, message: "must be boolean" });
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) { issues.push({ path: loc, message: "must be array" }); return; }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push({ path: loc, message: `must contain at least ${schema.minItems} item(s)` });
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) issues.push({ path: loc, message: "must contain unique items" });
    if (schema.items) value.forEach((item, index) => validateSchemaValue(item, schema.items, `${loc}[${index}]`, issues, root));
    return;
  }
  if (schema.type === "object" || schema.required || schema.properties) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { issues.push({ path: loc, message: "must be object" }); return; }
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) issues.push({ path: `${loc}.${key}`, message: "is required" });
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) if (!(key in properties)) issues.push({ path: `${loc}.${key}`, message: "is not allowed" });
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const key of Object.keys(obj)) if (!(key in properties)) validateSchemaValue(obj[key], schema.additionalProperties, `${loc}.${key}`, issues, root);
    }
    for (const [key, child] of Object.entries<JsonSchema>(properties)) if (key in obj) validateSchemaValue(obj[key], child, `${loc}.${key}`, issues, root);
  }
}

function schemaPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../schemas/narrative-runtime-projection.schema.json");
}

export function validateNarrativeRuntimeProjection(value: unknown): SchemaIssue[] {
  let schema: JsonSchema;
  try { schema = JSON.parse(fs.readFileSync(schemaPath(), "utf8")) as JsonSchema; }
  catch { return [{ path: "$", message: "narrative runtime projection schema is unavailable" }]; }
  const issues: SchemaIssue[] = [];
  validateSchemaValue(value, schema, "$", issues, schema);
  return issues;
}

/** JSON with lexicographically sorted object keys; array order is preserved. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  }, 2);
}

/** Compile only from the frozen narrative manifest and its snapshot blobs. */
export function projectRuntimeNarrative(narrativeDir: string, opts: ProjectRuntimeNarrativeOptions): NarrativeRuntimeProjection {
  const verification = verifyManifest(narrativeDir);
  if (verification.perSource.some((entry) => entry.sourceId === "manifest")) {
    return projectionError("manifest_invalid", "narrative source manifest verification failed");
  }
  const { manifest, bytes: manifestBytes } = readManifestAfterVerification(narrativeDir);
  const resolved: ResolvedRecord[] = [];
  const unavailable: OrderedStatement[] = [];
  const sourceIndex = new Map<string, number>();
  for (const [index, entry] of manifest.sources.entries()) {
    sourceIndex.set(entry.source_id, index);
    const result = resolveSource(narrativeDir, entry.source_id);
    if (result.status === "unavailable") {
      unavailable.push({ statement: derivedUnavailableSource({ sourceId: entry.source_id, reason: result.reason }), sourceIndex: index, emissionIndex: 0 });
      continue;
    }
    const parsed = parseSourceId(entry.source_id);
    resolved.push({ sourceId: entry.source_id, sourceIndex: index, stream: parsed.stream, record: parseSnapshot(entry.source_id, result.content) });
  }

  const telemetry = resolved.filter((entry) => entry.stream === "telemetry");
  const normalizedTelemetry = telemetry.map((entry) => ({
    sourceId: entry.sourceId,
    record: {
      ...entry.record,
      ...(sessionId(entry.record) ? { session_id: sessionId(entry.record) } : {}),
      ...(eventType(entry.record) ? { event_type: eventType(entry.record) } : {}),
    },
  }));
  const spine = buildTurnSpine(normalizedTelemetry);
  const knownGapRefs = manifest.capture_completeness.known_gaps.map((gap) => gap.ref);
  const turns: RuntimeProjectionTurn[] = spine.map((turn) => ({
    ordinal: turn.ordinal,
    sessionId: turn.sessionId,
    ...(turn.turnId ? { turnId: turn.turnId } : {}),
    boundary: turn.boundary,
    known_gap_refs: [...knownGapRefs],
    statements: [],
  }));
  const turnByOrdinal = new Map(turns.map((turn) => [turn.ordinal, turn]));
  const turnBySource = new Map<string, number>();
  const turnSourceIndexes = new Map<number, number[]>();
  for (const turn of spine) {
    const indexes: number[] = [];
    for (const sourceId of turn.sources) {
      turnBySource.set(sourceId, turn.ordinal);
      const index = sourceIndex.get(sourceId);
      if (index !== undefined) indexes.push(index);
    }
    turnSourceIndexes.set(turn.ordinal, indexes);
  }

  const turnStatements = new Map<number, OrderedStatement[]>();
  const documentStatements: OrderedStatement[] = [...unavailable];
  const actualActivity = new Set<number>();
  // Review H2a: material facts are tracked per source and re-checked by the
  // coverage gate — a cited source whose material signal produced no material
  // statement is a coverage gap, not a pass.
  const materialFacts = new Map<string, "timeout">();
  const append = (ordered: OrderedStatement, turnOrdinal?: number): void => {
    if (turnOrdinal === undefined) { documentStatements.push(ordered); return; }
    const bucket = turnStatements.get(turnOrdinal) ?? [];
    bucket.push({ ...ordered, statement: addTurnRef(ordered.statement, turnOrdinal) });
    turnStatements.set(turnOrdinal, bucket);
  };

  for (const entry of telemetry) {
    const event = eventType(entry.record);
    if (!event) continue;
    const turnOrdinal = turnBySource.get(entry.sourceId);
    let emissionIndex = 0;
    if (event.startsWith("tool.") || event === "turn.user" || event.startsWith("session.")) {
      append({ statement: observedToolAction({ sourceId: entry.sourceId, toolName: toolName(entry.record, event), eventType: event }), sourceIndex: entry.sourceIndex, emissionIndex: emissionIndex++ }, turnOrdinal);
      // Review H2b: a bare tool event is not "activity" for no-op purposes —
      // the plan defines a no-op turn as zero commands/writes. Activity is
      // marked below only for commands, writes, and delegations.
    }
    const tool = toolName(entry.record, event);
    const command = commandFrom(entry.record, tool);
    if (command) {
      const exitCode = exitCodeFrom(entry.record);
      append({ statement: observedCommand({ sourceId: entry.sourceId, command, observedResult: observedResultFrom(entry.record, exitCode), exitCode }), sourceIndex: entry.sourceIndex, emissionIndex: emissionIndex++ }, turnOrdinal);
      if (turnOrdinal !== undefined) actualActivity.add(turnOrdinal);
    }
    // Review H2a: a timeout SIGNAL is material by itself — the statement must
    // not be conditional on a duration also being present. Duration, when
    // absent, renders as unknown; the material fact still enters the record,
    // and the material-coverage gate below enforces it.
    if (carriesTimeoutSignal(entry.record)) {
      const timeoutMs = timeoutMsFrom(entry.record);
      append({ statement: derivedTimeout({ sourceId: entry.sourceId, operation: command ?? tool, timeoutMs }), sourceIndex: entry.sourceIndex, emissionIndex: emissionIndex++ }, turnOrdinal);
      materialFacts.set(entry.sourceId, "timeout");
    }
  }

  const commandRun: Array<{ sourceId: string; sourceIndex: number; command: string; result: ObservedResult }> = [];
  const flushCommandRun = (): void => {
    if (commandRun.length >= 2 && commandRun[0]?.result === "fail") {
      const last = commandRun.at(-1)!;
      documentStatements.push({
        statement: derivedRetry({ sourceIds: commandRun.map((item) => item.sourceId), command: commandRun[0]!.command, attempts: commandRun.length, ruleInputs: commandRun.map((item) => item.sourceId) }),
        sourceIndex: last.sourceIndex,
        emissionIndex: 1,
      });
    }
    commandRun.length = 0;
  };
  for (const entry of resolved.filter((candidate) => candidate.stream === "cmdlog")) {
    const command = string(entry.record["command"]);
    if (!command) { flushCommandRun(); continue; }
    const exitCode = exitCodeFrom(entry.record);
    const result = observedResultFrom(entry.record, exitCode);
    documentStatements.push({ statement: observedCommand({ sourceId: entry.sourceId, command, observedResult: result, exitCode }), sourceIndex: entry.sourceIndex, emissionIndex: 0 });
    if (commandRun.length > 0 && normalizeCommand(commandRun[0]!.command) !== normalizeCommand(command)) flushCommandRun();
    commandRun.push({ sourceId: entry.sourceId, sourceIndex: entry.sourceIndex, command, result });
    if (result !== "fail" && commandRun.length === 1) flushCommandRun();
  }
  flushCommandRun();

  for (const entry of resolved.filter((candidate) => candidate.stream === "agent-event" || candidate.stream === "delegation")) {
    const ordinal = nearestTurnOrdinal(entry, turns, turnSourceIndexes);
    append({
      statement: observedDelegation({ sourceId: entry.sourceId, agentId: lineageActor(entry.record), targets: delegationTargets(entry.record) }),
      sourceIndex: entry.sourceIndex,
      emissionIndex: 0,
    }, ordinal);
    // Re-review H2b: a delegation IS activity — a turn cannot simultaneously
    // delegate work and be a no-op.
    if (ordinal !== undefined) actualActivity.add(ordinal);
  }

  for (const entry of resolved.filter((candidate) => candidate.stream === "flow-state" || candidate.stream === "flow-transition")) {
    const ordinal = nearestTurnOrdinal(entry, turns, turnSourceIndexes);
    append({ statement: observedToolAction({ sourceId: entry.sourceId, toolName: "workflow", eventType: entry.stream }), sourceIndex: entry.sourceIndex, emissionIndex: 0 }, ordinal);
    const purpose = purposeFrom(entry.record);
    if (purpose && ordinal !== undefined) turnByOrdinal.get(ordinal)!.purpose = purpose;
  }

  for (const entry of resolved.filter((candidate) => candidate.stream === "file")) {
    const parsed = parseSourceId(entry.sourceId);
    if (parsed.stream !== "file") continue;
    const ordinal = nearestTurnOrdinal(entry, turns, turnSourceIndexes);
    append({ statement: observedFileCreation({ sourceId: entry.sourceId, path: parsed.scope.repoRelativePath }), sourceIndex: entry.sourceIndex, emissionIndex: 0 }, ordinal);
    // Re-review H2b: a created file IS a write — never no-op alongside it.
    if (ordinal !== undefined) actualActivity.add(ordinal);
  }

  for (const turn of turns) {
    if (actualActivity.has(turn.ordinal)) continue;
    const ids = spine.find((candidate) => candidate.ordinal === turn.ordinal)?.sources ?? [];
    if (ids.length === 0) continue;
    const index = Math.max(...ids.map((id) => sourceIndex.get(id) ?? 0));
    append({ statement: derivedNoOpTurn({ turnRef: turn.ordinal, sourceIds: ids }), sourceIndex: index, emissionIndex: Number.MAX_SAFE_INTEGER }, turn.ordinal);
  }

  const compare = (left: OrderedStatement, right: OrderedStatement): number =>
    left.sourceIndex - right.sourceIndex || left.emissionIndex - right.emissionIndex;
  for (const turn of turns) turn.statements = (turnStatements.get(turn.ordinal) ?? []).sort(compare).map((item) => item.statement);
  const orderedDocumentStatements = documentStatements.sort(compare).map((item) => item.statement);

  const allStatements = [...turns.flatMap((turn) => turn.statements), ...orderedDocumentStatements];
  const cited = new Set(allStatements.flatMap((statement) => statement.source_refs));
  // Flow reports and Surface explanations are foreign-authority projections.
  // The execution envelope embeds them directly; this runtime projection must
  // neither reinterpret them into statements nor fail its statement-coverage
  // gate merely because their frozen source refs are cited by another section.
  const missing = manifest.sources.map((entry) => entry.source_id).filter((sourceId) => {
    const stream = parseSourceId(sourceId).stream;
    return stream !== "flow-report" && stream !== "surface-explanation" && !cited.has(sourceId);
  });
  if (missing.length > 0) return projectionError("coverage_gap", `projection omitted ${missing.length} manifest source(s): ${missing.join(", ")}`, missing[0]);
  // Review H2a: fact-level coverage — a source carrying a material signal must
  // have produced its material statement (rule id match), not merely a citation.
  for (const [sourceId, fact] of materialFacts) {
    const ruleId = fact === "timeout" ? "timeout-detection" : fact;
    const covered = allStatements.some((statement) => statement.rule?.id === ruleId && statement.source_refs.includes(sourceId));
    if (!covered) return projectionError("coverage_gap", `material ${fact} signal on ${sourceId} produced no ${ruleId} statement`, sourceId);
  }

  return {
    schema_version: NARRATIVE_RUNTIME_PROJECTION_SCHEMA_VERSION,
    narrative_id: manifest.narrative_id,
    provenance: {
      projector: NARRATIVE_RUNTIME_PROJECTOR,
      projected_at: opts.projectedAt,
      manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    },
    capture_completeness: manifest.capture_completeness,
    turns,
    document_statements: orderedDocumentStatements,
    coverage: { sources: manifest.sources.length, cited: cited.size, unavailable: unavailable.length },
  };
}
