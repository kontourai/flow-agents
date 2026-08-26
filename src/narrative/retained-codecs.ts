import type { KnownGapClass } from "./integrity.js";

/** A content-addressed, path-free name for a retained narrative envelope. */
export interface GroundedNarrativeRef {
  schemaVersion: "grounded-narrative-ref/v1";
  narrativeId: string;
  envelopeSha256: string;
}

export const GROUNDED_NARRATIVE_REF_SCHEMA_VERSION = "grounded-narrative-ref/v1" as const;
export const RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION = "retained-narrative-process-projection/v1" as const;

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
    turns: Array<{ ordinal: number; boundary: { derived: boolean; rule_id?: "turn-spine/v1" } }>;
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
    || typeof record.narrativeId !== "string" || !record.narrativeId
    || typeof record.envelopeSha256 !== "string" || !SHA256.test(record.envelopeSha256)) return undefined;
  return { schemaVersion: GROUNDED_NARRATIVE_REF_SCHEMA_VERSION, narrativeId: record.narrativeId, envelopeSha256: record.envelopeSha256 };
}
