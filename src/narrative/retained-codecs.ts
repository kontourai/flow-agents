import type { KnownGapClass } from "./integrity.js";

/** A content-addressed, path-free name for a retained narrative envelope. */
export interface GroundedNarrativeRef {
  schemaVersion: "grounded-narrative-ref/v1";
  narrativeId: string;
  envelopeSha256: string;
}

export const GROUNDED_NARRATIVE_REF_SCHEMA_VERSION = "grounded-narrative-ref/v1" as const;
export const RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION = "retained-narrative-process-projection/v1" as const;
export const MAX_RETAINED_NARRATIVE_ID_LENGTH = 256;
export const MAX_RETAINED_PROCESS_TURNS = 256;
export const MAX_RETAINED_PROCESS_ACTIONS = 1024;

export type RetainedNarrativeProcessActionKind =
  | "tool_event"
  | "command"
  | "delegation"
  | "file_created"
  | "retry"
  | "timeout"
  | "no_op"
  | "source_unavailable";

export interface RetainedNarrativeProcessAction {
  kind: RetainedNarrativeProcessActionKind;
  outcome?: "pass" | "fail" | "ambiguous";
}

export interface RetainedNarrativeProcessProjection {
  schemaVersion: typeof RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION;
  ref: GroundedNarrativeRef;
  narrativeId: string;
  provenance: { compiler: { name: "flow-agents-narrative-composer"; version: string }; compiled_at: string; manifest_sha256: string };
  capture: {
    channels: { active: number; inactive: number; unknown: number };
    knownGapClasses: KnownGapClass[];
  };
  runtime: {
    coverage: { sources: number; cited: number; unavailable: number };
    turns: Array<{
      ordinal: number;
      boundary: { derived: boolean; rule_id?: "turn-spine/v1" };
      actions: RetainedNarrativeProcessAction[];
    }>;
    documentActions: RetainedNarrativeProcessAction[];
  };
}

const SHA256 = /^[0-9a-f]{64}$/;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Pure codec: it accepts only the versioned, path-free public reference shape. */
export function decodeGroundedNarrativeRef(value: unknown): GroundedNarrativeRef | undefined {
  const record = object(value);
  if (!record || Object.keys(record).length !== 3
    || record.schemaVersion !== GROUNDED_NARRATIVE_REF_SCHEMA_VERSION
    || typeof record.narrativeId !== "string" || !record.narrativeId || record.narrativeId.length > MAX_RETAINED_NARRATIVE_ID_LENGTH
    || typeof record.envelopeSha256 !== "string" || !SHA256.test(record.envelopeSha256)) return undefined;
  return { schemaVersion: GROUNDED_NARRATIVE_REF_SCHEMA_VERSION, narrativeId: record.narrativeId, envelopeSha256: record.envelopeSha256 };
}

function exact(record: Record<string, unknown> | undefined, keys: readonly string[]): record is Record<string, unknown> {
  return !!record && Object.keys(record).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function action(value: unknown): RetainedNarrativeProcessAction | undefined {
  const record = object(value);
  if (!record || typeof record.kind !== "string"
    || !["tool_event", "command", "delegation", "file_created", "retry", "timeout", "no_op", "source_unavailable"].includes(record.kind)) return undefined;
  if (record.outcome === undefined) return exact(record, ["kind"]) ? { kind: record.kind as RetainedNarrativeProcessActionKind } : undefined;
  if (!exact(record, ["kind", "outcome"]) || !["pass", "fail", "ambiguous"].includes(String(record.outcome))) return undefined;
  return { kind: record.kind as RetainedNarrativeProcessActionKind, outcome: record.outcome as "pass" | "fail" | "ambiguous" };
}

/** Strict, bounded decoder for serialized browser-safe process projections. */
export function decodeRetainedNarrativeProcessProjection(value: unknown): RetainedNarrativeProcessProjection | undefined {
  const record = object(value);
  if (!exact(record, ["schemaVersion", "ref", "narrativeId", "provenance", "capture", "runtime"])
    || record.schemaVersion !== RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION
    || typeof record.narrativeId !== "string" || record.narrativeId.length > MAX_RETAINED_NARRATIVE_ID_LENGTH) return undefined;
  const ref = decodeGroundedNarrativeRef(record.ref);
  const provenance = object(record.provenance);
  const compiler = object(provenance?.compiler);
  const capture = object(record.capture);
  const channels = object(capture?.channels);
  const runtime = object(record.runtime);
  const coverage = object(runtime?.coverage);
  if (!ref || ref.narrativeId !== record.narrativeId || !exact(provenance, ["compiler", "compiled_at", "manifest_sha256"])
    || !exact(compiler, ["name", "version"]) || compiler.name !== "flow-agents-narrative-composer" || typeof compiler.version !== "string" || !compiler.version
    || typeof provenance.compiled_at !== "string" || !provenance.compiled_at || typeof provenance.manifest_sha256 !== "string" || !SHA256.test(provenance.manifest_sha256)
    || !exact(capture, ["channels", "knownGapClasses"]) || !exact(channels, ["active", "inactive", "unknown"])
    || !nonNegativeInteger(channels.active) || !nonNegativeInteger(channels.inactive) || !nonNegativeInteger(channels.unknown) || !Array.isArray(capture.knownGapClasses)
    || !runtime || !exact(runtime, ["coverage", "turns", "documentActions"]) || !exact(coverage, ["sources", "cited", "unavailable"])
    || !nonNegativeInteger(coverage.sources) || !nonNegativeInteger(coverage.cited) || !nonNegativeInteger(coverage.unavailable)
    || !Array.isArray(runtime.turns) || runtime.turns.length > MAX_RETAINED_PROCESS_TURNS
    || !Array.isArray(runtime.documentActions)) return undefined;
  const allowedGaps: KnownGapClass[] = ["mcp_non_native_tools", "actor_attribution_conflation", "cross_session_event_contamination"];
  if (capture.knownGapClasses.some((gap) => !allowedGaps.includes(gap as KnownGapClass))) return undefined;
  let actionCount = runtime.documentActions.length;
  const documentActions = runtime.documentActions.map(action);
  if (documentActions.some((item) => !item)) return undefined;
  const turns: RetainedNarrativeProcessProjection["runtime"]["turns"] = [];
  for (const turnValue of runtime.turns) {
    const turn = object(turnValue);
    const boundary = object(turn?.boundary);
    const ordinal = turn?.ordinal;
    if (!exact(turn, ["ordinal", "boundary", "actions"]) || typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < -1
      || !exact(boundary, boundary?.rule_id === undefined ? ["derived"] : ["derived", "rule_id"])
      || typeof boundary.derived !== "boolean" || (boundary.rule_id !== undefined && boundary.rule_id !== "turn-spine/v1") || !Array.isArray(turn.actions)) return undefined;
    actionCount += turn.actions.length;
    const actions = turn.actions.map(action);
    if (actions.some((item) => !item)) return undefined;
    turns.push({ ordinal, boundary: boundary.rule_id === undefined ? { derived: boundary.derived } : { derived: boundary.derived, rule_id: "turn-spine/v1" }, actions: actions as RetainedNarrativeProcessAction[] });
  }
  if (actionCount > MAX_RETAINED_PROCESS_ACTIONS) return undefined;
  return {
    schemaVersion: RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION, ref, narrativeId: record.narrativeId,
    provenance: { compiler: { name: "flow-agents-narrative-composer", version: compiler.version }, compiled_at: provenance.compiled_at, manifest_sha256: provenance.manifest_sha256 },
    capture: { channels: { active: channels.active as number, inactive: channels.inactive as number, unknown: channels.unknown as number }, knownGapClasses: capture.knownGapClasses as KnownGapClass[] },
    runtime: { coverage: { sources: coverage.sources, cited: coverage.cited, unavailable: coverage.unavailable }, turns, documentActions: documentActions as RetainedNarrativeProcessAction[] },
  };
}
