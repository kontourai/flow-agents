import type { GroundedExecutionNarrative } from "./envelope.js";
import {
  decodeGroundedNarrativeRef,
  decodeRetainedNarrativeProcessProjection,
  MAX_RETAINED_PROCESS_ACTIONS,
  MAX_RETAINED_PROCESS_TURNS,
  RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION,
  type GroundedNarrativeRef,
  type RetainedNarrativeProcessAction,
  type RetainedNarrativeProcessProjection,
} from "./retained-codecs.js";

const MAX_SAFE_TEXT = 512;
const GAP_CLASSES = ["mcp_non_native_tools", "actor_attribution_conflation", "cross_session_event_contamination"] as const;
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function exact(value: Record<string, unknown> | undefined, keys: readonly string[]): value is Record<string, unknown> { return !!value && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= MAX_SAFE_TEXT; }
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function sourceRefs(value: unknown): boolean { return Array.isArray(value) && value.length > 0 && value.length <= MAX_RETAINED_PROCESS_ACTIONS && value.every(text); }
function boundary(value: unknown): { derived: boolean; rule_id?: "turn-spine/v1" } | undefined {
  const item = record(value);
  if (!item || typeof item.derived !== "boolean") return undefined;
  if (item.rule_id === undefined) return exact(item, ["derived"]) ? { derived: item.derived } : undefined;
  return exact(item, ["derived", "rule_id"]) && item.rule_id === "turn-spine/v1" ? { derived: item.derived, rule_id: "turn-spine/v1" } : undefined;
}

/** Maps only structured runtime templates to safe categories; raw statement values never cross this seam. */
function actionForStatement(value: unknown): RetainedNarrativeProcessAction | undefined {
  const statement = record(value);
  if (!statement || !text(statement.id) || !text(statement.class) || !text(statement.proposition) || !sourceRefs(statement.source_refs)) return undefined;
  if (Object.keys(statement).some((key) => !["id", "class", "proposition", "source_refs", "turn_ref", "actor", "rule"].includes(key))) return undefined;
  const turnRef = statement.turn_ref;
  if (turnRef !== undefined && (typeof turnRef !== "number" || !Number.isSafeInteger(turnRef) || turnRef < -1)) return undefined;
  if (statement.actor !== undefined && !text(statement.actor)) return undefined;
  const rule = record(statement.rule);
  if (statement.class === "observed") {
    if (statement.rule !== undefined) return undefined;
    if (statement.proposition.startsWith("Tool ")) return { kind: "tool_event" };
    const command = /^Command `[^`]*` was observed to (pass|fail|complete ambiguously) \(exit (?:-?[0-9]+|unknown)\)$/.exec(statement.proposition);
    if (command) return { kind: "command", outcome: command[1] === "complete ambiguously" ? "ambiguous" : command[1] as "pass" | "fail" };
    if (statement.proposition.startsWith("Agent ")) return { kind: "delegation" };
    if (statement.proposition.startsWith("File `")) return { kind: "file_created" };
    return undefined;
  }
  if (statement.class !== "deterministic_derived" || !exact(rule, ["id", "version", "inputs"]) || !text(rule.id) || !text(rule.version) || !sourceRefs(rule.inputs)) return undefined;
  const byRule: Record<string, RetainedNarrativeProcessAction["kind"]> = { "retry-detection": "retry", "timeout-detection": "timeout", "no-op-turn": "no_op", "unavailable-source": "source_unavailable" };
  return byRule[rule.id] ? { kind: byRule[rule.id] } : undefined;
}
function capture(value: unknown): { channels: { active: number; inactive: number; unknown: number }; knownGapClasses: RetainedNarrativeProcessProjection["capture"]["knownGapClasses"] } | undefined {
  const item = record(value); const channels = record(item?.channels);
  if (!exact(item, ["channels", "known_gaps"]) || !channels || Object.keys(channels).length > 128 || !Array.isArray(item.known_gaps) || item.known_gaps.length > 128) return undefined;
  const counts = { active: 0, inactive: 0, unknown: 0 };
  for (const status of Object.values(channels)) { if (status !== "active" && status !== "inactive" && status !== "unknown") return undefined; counts[status] += 1; }
  const knownGapClasses: RetainedNarrativeProcessProjection["capture"]["knownGapClasses"] = [];
  for (const gapValue of item.known_gaps) {
    const gap = record(gapValue);
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
  const decoded = decodeGroundedNarrativeRef(ref); const input = record(envelope);
  if (!decoded || !input || input.schema_version !== "grounded-execution-narrative/v1" || !text(input.narrative_id) || input.narrative_id !== decoded.narrativeId) return undefined;
  const provenance = record(input.provenance); const compiler = record(provenance?.compiler); const captureProjection = capture(input.capture_completeness);
  if (!exact(provenance, ["compiler", "compiled_at", "manifest_sha256", "schema_sha256", "config_sha256", "compiler_sha256"]) || !exact(compiler, ["name", "version"]) || compiler.name !== "flow-agents-narrative-composer" || !text(compiler.version) || !text(provenance.compiled_at) || !text(provenance.manifest_sha256) || !captureProjection || !Array.isArray(input.sections)) return undefined;
  const runtime = input.sections.filter((section): section is Record<string, unknown> => record(section)?.authority === "flow-agents");
  if (runtime.length !== 1 || !exact(runtime[0], ["authority", "kind", "sha256", "embedded"]) || runtime[0].kind !== "runtime-projection") return undefined;
  const embedded = record(runtime[0].embedded); const coverage = record(embedded?.coverage);
  if (!exact(embedded, ["schema_version", "narrative_id", "provenance", "capture_completeness", "turns", "document_statements", "coverage"]) || embedded.schema_version !== "grounded-runtime-projection/v1" || embedded.narrative_id !== decoded.narrativeId || !Array.isArray(embedded.turns) || embedded.turns.length > MAX_RETAINED_PROCESS_TURNS || !Array.isArray(embedded.document_statements) || !exact(coverage, ["sources", "cited", "unavailable"]) || !nonNegativeInteger(coverage.sources) || !nonNegativeInteger(coverage.cited) || !nonNegativeInteger(coverage.unavailable)) return undefined;
  const documentActions = embedded.document_statements.map(actionForStatement).filter((item): item is RetainedNarrativeProcessAction => item !== undefined);
  const turns: RetainedNarrativeProcessProjection["runtime"]["turns"] = []; let actionCount = documentActions.length;
  for (const turnValue of embedded.turns) {
    const turn = record(turnValue); const turnBoundary = boundary(turn?.boundary);
    const keys = turn ? Object.keys(turn) : [];
    const ordinal = turn?.ordinal;
    if (!turn || ![5, 6, 7].includes(keys.length) || keys.some((key) => !["ordinal", "sessionId", "turnId", "boundary", "purpose", "known_gap_refs", "statements"].includes(key)) || typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < -1 || !text(turn.sessionId) || !turnBoundary || !Array.isArray(turn.known_gap_refs) || !turn.known_gap_refs.every(text) || !Array.isArray(turn.statements)) return undefined;
    const actions = turn.statements.map(actionForStatement).filter((item): item is RetainedNarrativeProcessAction => item !== undefined); actionCount += actions.length;
    turns.push({ ordinal, boundary: turnBoundary, actions });
  }
  if (actionCount > MAX_RETAINED_PROCESS_ACTIONS) return undefined;
  return decodeRetainedNarrativeProcessProjection({ schemaVersion: RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION, ref: decoded, narrativeId: decoded.narrativeId, provenance: { compiler: { name: "flow-agents-narrative-composer", version: compiler.version }, compiled_at: provenance.compiled_at, manifest_sha256: provenance.manifest_sha256 }, capture: captureProjection, runtime: { coverage: { sources: coverage.sources, cited: coverage.cited, unavailable: coverage.unavailable }, turns, documentActions } });
}
