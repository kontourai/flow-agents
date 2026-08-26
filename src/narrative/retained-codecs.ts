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
export const MAX_RETAINED_PROCESS_VERSION_LENGTH = 128;
export const MAX_RETAINED_PROCESS_DATETIME_LENGTH = 64;

export type RetainedNarrativeProcessActionKind =
  | "recorded_observation"
  | "retry"
  | "timeout"
  | "no_op"
  | "source_unavailable"
  | "unsupported";

export type RetainedNarrativeProcessAction =
  | { kind: Exclude<RetainedNarrativeProcessActionKind, "unsupported"> }
  | { kind: "unsupported"; owner: "flow-agents"; category: "statement_class" | "deterministic_rule" };

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
const NARRATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Pure codec: it accepts only the versioned, path-free public reference shape. */
export function decodeGroundedNarrativeRef(value: unknown): GroundedNarrativeRef | undefined {
  const record = object(value);
  if (!record || Object.keys(record).length !== 3
    || record.schemaVersion !== GROUNDED_NARRATIVE_REF_SCHEMA_VERSION
    || typeof record.narrativeId !== "string" || !record.narrativeId || record.narrativeId.length > MAX_RETAINED_NARRATIVE_ID_LENGTH || !NARRATIVE_ID.test(record.narrativeId)
    || typeof record.envelopeSha256 !== "string" || !SHA256.test(record.envelopeSha256)) return undefined;
  return { schemaVersion: GROUNDED_NARRATIVE_REF_SCHEMA_VERSION, narrativeId: record.narrativeId, envelopeSha256: record.envelopeSha256 };
}

function exact(record: Record<string, unknown> | undefined, keys: readonly string[]): record is Record<string, unknown> {
  return !!record && Object.keys(record).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function safeVersion(value: unknown): value is string { return typeof value === "string" && value.length <= MAX_RETAINED_PROCESS_VERSION_LENGTH && SEMVER.test(value); }
function dateTime(value: unknown): value is string { return typeof value === "string" && value.length <= MAX_RETAINED_PROCESS_DATETIME_LENGTH && DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)); }
function action(value: unknown): RetainedNarrativeProcessAction | undefined {
  const record = object(value);
  if (!record || typeof record.kind !== "string") return undefined;
  if (["recorded_observation", "retry", "timeout", "no_op", "source_unavailable"].includes(record.kind)) {
    return exact(record, ["kind"]) ? { kind: record.kind as Exclude<RetainedNarrativeProcessActionKind, "unsupported"> } : undefined;
  }
  if (!exact(record, ["kind", "owner", "category"]) || record.kind !== "unsupported" || record.owner !== "flow-agents"
    || (record.category !== "statement_class" && record.category !== "deterministic_rule")) return undefined;
  return { kind: "unsupported", owner: "flow-agents", category: record.category };
}

/** Strict, bounded decoder for serialized browser-safe process projections. */
export function decodeRetainedNarrativeProcessProjection(value: unknown): RetainedNarrativeProcessProjection | undefined {
  const record = object(value);
  if (!exact(record, ["schemaVersion", "ref", "narrativeId", "provenance", "capture", "runtime"])
    || record.schemaVersion !== RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION
    || typeof record.narrativeId !== "string" || record.narrativeId.length > MAX_RETAINED_NARRATIVE_ID_LENGTH || !NARRATIVE_ID.test(record.narrativeId)) return undefined;
  const ref = decodeGroundedNarrativeRef(record.ref);
  const provenance = object(record.provenance);
  const compiler = object(provenance?.compiler);
  const capture = object(record.capture);
  const channels = object(capture?.channels);
  const runtime = object(record.runtime);
  const coverage = object(runtime?.coverage);
  if (!ref || ref.narrativeId !== record.narrativeId || !exact(provenance, ["compiler", "compiled_at", "manifest_sha256"])
    || !exact(compiler, ["name", "version"]) || compiler.name !== "flow-agents-narrative-composer" || !safeVersion(compiler.version)
    || !dateTime(provenance.compiled_at) || typeof provenance.manifest_sha256 !== "string" || !SHA256.test(provenance.manifest_sha256)
    || !exact(capture, ["channels", "knownGapClasses"]) || !exact(channels, ["active", "inactive", "unknown"])
    || !nonNegativeInteger(channels.active) || !nonNegativeInteger(channels.inactive) || !nonNegativeInteger(channels.unknown) || !Array.isArray(capture.knownGapClasses) || capture.knownGapClasses.length > 128
    || !runtime || !exact(runtime, ["coverage", "turns", "documentActions"]) || !exact(coverage, ["sources", "cited", "unavailable"])
    || !nonNegativeInteger(coverage.sources) || !nonNegativeInteger(coverage.cited) || !nonNegativeInteger(coverage.unavailable)
    || !Array.isArray(runtime.turns) || runtime.turns.length > MAX_RETAINED_PROCESS_TURNS
    || !Array.isArray(runtime.documentActions) || runtime.documentActions.length > MAX_RETAINED_PROCESS_ACTIONS) return undefined;
  const allowedGaps: KnownGapClass[] = ["mcp_non_native_tools", "actor_attribution_conflation", "cross_session_event_contamination"];
  if (capture.knownGapClasses.some((gap) => !allowedGaps.includes(gap as KnownGapClass))
    || new Set(capture.knownGapClasses).size !== capture.knownGapClasses.length) return undefined;
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
      || typeof boundary.derived !== "boolean" || (boundary.rule_id !== undefined && boundary.rule_id !== "turn-spine/v1") || !Array.isArray(turn.actions)
      || turn.actions.length > MAX_RETAINED_PROCESS_ACTIONS || actionCount + turn.actions.length > MAX_RETAINED_PROCESS_ACTIONS) return undefined;
    actionCount += turn.actions.length;
    const actions = turn.actions.map(action);
    if (actions.some((item) => !item)) return undefined;
    turns.push({ ordinal, boundary: boundary.rule_id === undefined ? { derived: boundary.derived } : { derived: boundary.derived, rule_id: "turn-spine/v1" }, actions: actions as RetainedNarrativeProcessAction[] });
  }
  if (actionCount > MAX_RETAINED_PROCESS_ACTIONS) return undefined;
  return {
    schemaVersion: RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION, ref, narrativeId: record.narrativeId,
    provenance: { compiler: { name: "flow-agents-narrative-composer", version: compiler.version }, compiled_at: provenance.compiled_at, manifest_sha256: provenance.manifest_sha256 },
    capture: { channels: { active: channels.active as number, inactive: channels.inactive as number, unknown: channels.unknown as number }, knownGapClasses: [...capture.knownGapClasses] as KnownGapClass[] },
    runtime: { coverage: { sources: coverage.sources, cited: coverage.cited, unavailable: coverage.unavailable }, turns, documentActions: documentActions as RetainedNarrativeProcessAction[] },
  };
}
