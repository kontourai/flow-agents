import type { GroundedExecutionNarrative } from "./envelope.js";
import {
  decodeGroundedNarrativeRef,
  decodeRetainedNarrativeProcessProjection,
  MAX_RETAINED_PROCESS_ACTIONS,
  MAX_RETAINED_PROCESS_DATETIME_LENGTH,
  MAX_RETAINED_PROCESS_TURNS,
  MAX_RETAINED_PROCESS_VERSION_LENGTH,
  RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION,
  type GroundedNarrativeRef,
  type RetainedNarrativeProcessAction,
  type RetainedNarrativeProcessProjection,
} from "./retained-codecs.js";

const MAX_SAFE_TEXT = 512;
const MAX_STATEMENT_TEXT = 16 * 1024;
const MAX_ENVELOPE_SECTIONS = 512;
const MAX_TURN_GAP_REFS = 128;
const GAP_CLASSES = ["mcp_non_native_tools", "actor_attribution_conflation", "cross_session_event_contamination"] as const;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function exact(value: Record<string, unknown> | undefined, keys: readonly string[]): value is Record<string, unknown> { return !!value && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function denseArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  return true;
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= MAX_SAFE_TEXT; }
function statementText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= MAX_STATEMENT_TEXT; }
function version(value: unknown): value is string { return typeof value === "string" && value.length <= MAX_RETAINED_PROCESS_VERSION_LENGTH && SEMVER.test(value); }
function dateTime(value: unknown): value is string { return typeof value === "string" && value.length <= MAX_RETAINED_PROCESS_DATETIME_LENGTH && DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)); }
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function sourceRefs(value: unknown): boolean {
  if (!denseArray(value, MAX_RETAINED_PROCESS_ACTIONS) || value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) if (!text(value[index])) return false;
  return true;
}
function statementWithinBound(value: unknown): boolean { const item = record(value); return !!item && statementText(item.proposition); }
function boundary(value: unknown): { derived: boolean; rule_id?: "turn-spine/v1" } | undefined {
  const item = record(value);
  if (!item || typeof item.derived !== "boolean") return undefined;
  if (item.rule_id === undefined) return exact(item, ["derived"]) ? { derived: item.derived } : undefined;
  return exact(item, ["derived", "rule_id"]) && item.rule_id === "turn-spine/v1" ? { derived: item.derived, rule_id: "turn-spine/v1" } : undefined;
}

/** Maps only typed statement/rule metadata; proposition text never crosses this seam. */
function actionForStatement(value: unknown): RetainedNarrativeProcessAction | undefined {
  const statement = record(value);
  if (!statement || !text(statement.id) || !text(statement.class) || !statementText(statement.proposition) || !sourceRefs(statement.source_refs)) return undefined;
  if (Object.keys(statement).some((key) => !["id", "class", "proposition", "source_refs", "turn_ref", "actor", "rule", "self_report"].includes(key))) return undefined;
  const turnRef = statement.turn_ref;
  if (turnRef !== undefined && (typeof turnRef !== "number" || !Number.isSafeInteger(turnRef) || turnRef < -1)) return undefined;
  if (statement.actor !== undefined && !text(statement.actor)) return undefined;
  const rule = record(statement.rule);
  if (statement.rule !== undefined && (!exact(rule, ["id", "version", "inputs"]) || !text(rule.id) || !text(rule.version) || !sourceRefs(rule.inputs))) return undefined;
  if (statement.self_report !== undefined && statement.self_report !== true) return undefined;
  if (statement.class === "observed") {
    return statement.rule === undefined && statement.self_report === undefined ? { kind: "recorded_observation" } : undefined;
  }
  if (statement.class !== "deterministic_derived") return { kind: "unsupported", owner: "flow-agents", category: "statement_class" };
  if (!rule || statement.self_report !== undefined) return undefined;
  const ruleId = rule.id;
  const ruleVersion = rule.version;
  if (!text(ruleId) || !text(ruleVersion)) return undefined;
  const byRule: Record<string, Exclude<RetainedNarrativeProcessAction["kind"], "unsupported">> = { "retry-detection": "retry", "timeout-detection": "timeout", "no-op-turn": "no_op", "unavailable-source": "source_unavailable" };
  return ruleVersion === "v1" && Object.hasOwn(byRule, ruleId)
    ? { kind: byRule[ruleId] }
    : { kind: "unsupported", owner: "flow-agents", category: "deterministic_rule" };
}
function actionsFor(values: unknown): RetainedNarrativeProcessAction[] | undefined {
  if (!denseArray(values, MAX_RETAINED_PROCESS_ACTIONS)) return undefined;
  const actions: RetainedNarrativeProcessAction[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const action = actionForStatement(values[index]);
    if (!action) return undefined;
    actions.push(action);
  }
  return actions;
}
function capture(value: unknown): { channels: { active: number; inactive: number; unknown: number }; knownGapClasses: RetainedNarrativeProcessProjection["capture"]["knownGapClasses"] } | undefined {
  const item = record(value); const channels = record(item?.channels);
  if (!exact(item, ["channels", "known_gaps"]) || !channels || Object.keys(channels).length > 128 || !denseArray(item.known_gaps, 128)) return undefined;
  const counts = { active: 0, inactive: 0, unknown: 0 };
  for (const status of Object.values(channels)) { if (status !== "active" && status !== "inactive" && status !== "unknown") return undefined; counts[status] += 1; }
  const knownGapClasses: RetainedNarrativeProcessProjection["capture"]["knownGapClasses"] = [];
  for (let index = 0; index < item.known_gaps.length; index += 1) {
    const gap = record(item.known_gaps[index]);
    const gapClass = gap?.class;
    if (!gap || Object.keys(gap).some((key) => !["class", "ref", "note"].includes(key)) || typeof gapClass !== "string" || !GAP_CLASSES.includes(gapClass as typeof GAP_CLASSES[number]) || !text(gap.ref) || (gap.note !== undefined && !text(gap.note))) return undefined;
    const typedGap = gapClass as RetainedNarrativeProcessProjection["capture"]["knownGapClasses"][number];
    if (!knownGapClasses.includes(typedGap)) knownGapClasses.push(typedGap);
  }
  return { channels: counts, knownGapClasses };
}

/**
 * Pure, strict browser-safe projection. It validates selected runtime fields and emits only
 * owner-defined categories; it never reads storage or forwards foreign/private payloads.
 */
export function projectRetainedNarrativeProcess(ref: GroundedNarrativeRef, envelope: GroundedExecutionNarrative): RetainedNarrativeProcessProjection | undefined {
  try { return projectRetainedNarrativeProcessInner(ref, envelope); }
  catch { return undefined; }
}

function projectRetainedNarrativeProcessInner(ref: GroundedNarrativeRef, envelope: GroundedExecutionNarrative): RetainedNarrativeProcessProjection | undefined {
  const decoded = decodeGroundedNarrativeRef(ref); const input = record(envelope);
  if (!decoded || !input || input.schema_version !== "grounded-execution-narrative/v1" || !text(input.narrative_id) || input.narrative_id !== decoded.narrativeId) return undefined;
  const provenance = record(input.provenance); const compiler = record(provenance?.compiler); const captureProjection = capture(input.capture_completeness);
  if (!exact(provenance, ["compiler", "compiled_at", "manifest_sha256", "schema_sha256", "config_sha256", "compiler_sha256"]) || !exact(compiler, ["name", "version"]) || compiler.name !== "flow-agents-narrative-composer" || !version(compiler.version) || !dateTime(provenance.compiled_at) || !text(provenance.manifest_sha256) || !captureProjection || !denseArray(input.sections, MAX_ENVELOPE_SECTIONS)) return undefined;
  const runtime: Record<string, unknown>[] = [];
  for (let index = 0; index < input.sections.length; index += 1) {
    const section = record(input.sections[index]);
    if (section?.authority === "flow-agents") runtime.push(section);
  }
  if (runtime.length !== 1 || !exact(runtime[0], ["authority", "kind", "sha256", "embedded"]) || runtime[0].kind !== "runtime-projection") return undefined;
  const embedded = record(runtime[0].embedded); const coverage = record(embedded?.coverage);
  if (!exact(embedded, ["schema_version", "narrative_id", "provenance", "capture_completeness", "turns", "document_statements", "coverage"]) || embedded.schema_version !== "grounded-runtime-projection/v1" || embedded.narrative_id !== decoded.narrativeId || !denseArray(embedded.turns, MAX_RETAINED_PROCESS_TURNS) || !denseArray(embedded.document_statements, MAX_RETAINED_PROCESS_ACTIONS) || !exact(coverage, ["sources", "cited", "unavailable"]) || !nonNegativeInteger(coverage.sources) || !nonNegativeInteger(coverage.cited) || !nonNegativeInteger(coverage.unavailable)) return undefined;
  for (let index = 0; index < embedded.document_statements.length; index += 1) if (!statementWithinBound(embedded.document_statements[index])) return undefined;
  const documentActions = actionsFor(embedded.document_statements);
  if (!documentActions) return undefined;
  const turns: RetainedNarrativeProcessProjection["runtime"]["turns"] = []; let inputActionCount = embedded.document_statements.length;
  for (let index = 0; index < embedded.turns.length; index += 1) {
    const turn = record(embedded.turns[index]); const turnBoundary = boundary(turn?.boundary);
    const keys = turn ? Object.keys(turn) : [];
    const ordinal = turn?.ordinal;
    if (!turn || ![5, 6, 7].includes(keys.length) || keys.some((key) => !["ordinal", "sessionId", "turnId", "boundary", "purpose", "known_gap_refs", "statements"].includes(key)) || typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < -1 || !text(turn.sessionId) || !turnBoundary || !denseArray(turn.known_gap_refs, MAX_TURN_GAP_REFS) || !denseArray(turn.statements, MAX_RETAINED_PROCESS_ACTIONS) || inputActionCount + turn.statements.length > MAX_RETAINED_PROCESS_ACTIONS) return undefined;
    for (let gapIndex = 0; gapIndex < turn.known_gap_refs.length; gapIndex += 1) if (!text(turn.known_gap_refs[gapIndex])) return undefined;
    for (let statementIndex = 0; statementIndex < turn.statements.length; statementIndex += 1) if (!statementWithinBound(turn.statements[statementIndex])) return undefined;
    inputActionCount += turn.statements.length;
    const actions = actionsFor(turn.statements);
    if (!actions) return undefined;
    turns.push({ ordinal, boundary: turnBoundary, actions });
  }
  return decodeRetainedNarrativeProcessProjection({ schemaVersion: RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION, ref: decoded, narrativeId: decoded.narrativeId, provenance: { compiler: { name: "flow-agents-narrative-composer", version: compiler.version }, compiled_at: provenance.compiled_at, manifest_sha256: provenance.manifest_sha256 }, capture: captureProjection, runtime: { coverage: { sources: coverage.sources, cited: coverage.cited, unavailable: coverage.unavailable }, turns, documentActions } });
}
