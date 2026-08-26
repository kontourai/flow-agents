import type { GroundedExecutionNarrative } from "./envelope.js";
import {
  decodeGroundedNarrativeRef,
  RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION,
  type GroundedNarrativeRef,
  type RetainedNarrativeProcessProjection,
} from "./retained-codecs.js";

/**
 * Pure, deliberately narrow browser-safe projection. The native reader validates the
 * envelope first; this module neither reaches the filesystem nor exposes foreign bytes,
 * source ids, paths, commands, session ids, or statements.
 */
export function projectRetainedNarrativeProcess(ref: GroundedNarrativeRef, envelope: GroundedExecutionNarrative): RetainedNarrativeProcessProjection | undefined {
  const decoded = decodeGroundedNarrativeRef(ref);
  if (!decoded || decoded.narrativeId !== envelope.narrative_id) return undefined;
  const runtime = envelope.sections.filter((section): section is Extract<GroundedExecutionNarrative["sections"][number], { authority: "flow-agents" }> => section.authority === "flow-agents");
  if (runtime.length !== 1) return undefined;
  const embedded = runtime[0].embedded;
  return {
    schemaVersion: RETAINED_NARRATIVE_PROCESS_PROJECTION_SCHEMA_VERSION,
    ref: decoded,
    narrativeId: envelope.narrative_id,
    provenance: { compiler: { ...envelope.provenance.compiler }, compiled_at: envelope.provenance.compiled_at, manifest_sha256: envelope.provenance.manifest_sha256 },
    capture: {
      channels: Object.values(envelope.capture_completeness.channels).reduce((counts, status) => ({ ...counts, [status]: counts[status] + 1 }), { active: 0, inactive: 0, unknown: 0 }),
      knownGapClasses: [...new Set(envelope.capture_completeness.known_gaps.map((gap) => gap.class))],
    },
    runtime: {
      coverage: { ...embedded.coverage },
      turns: embedded.turns.map((turn) => ({ ordinal: turn.ordinal, boundary: { ...turn.boundary } })),
    },
  };
}
