import type { NarrativeSourceId, NarrativeSourceStream } from "./source-ids.js";

export type IntegrityClass = "hash_chained" | "append_only_unhashed" | "rotatable" | "overwritten_in_place" | "path_only";
export type UnavailableReason = "expired" | "redacted" | "unauthorized" | "not_captured" | "corrupt";
export type CaptureChannelStatus = "active" | "inactive" | "unknown";
export type KnownGapClass = "mcp_non_native_tools" | "actor_attribution_conflation" | "cross_session_event_contamination";

export interface CaptureCompleteness {
  channels: Record<string, CaptureChannelStatus>;
  known_gaps: Array<{ class: KnownGapClass; ref: string; note?: string }>;
}

export const DEFAULT_INTEGRITY_CLASS: Readonly<Record<Exclude<NarrativeSourceStream, "file">, IntegrityClass>> = {
  telemetry: "rotatable",
  cmdlog: "hash_chained",
  "agent-event": "append_only_unhashed",
  delegation: "append_only_unhashed",
  "trust-claim": "overwritten_in_place",
  "trust-evidence": "overwritten_in_place",
  "flow-state": "overwritten_in_place",
  "flow-transition": "overwritten_in_place",
  transcript: "path_only",
};

export const KNOWN_CAPTURE_GAPS: CaptureCompleteness["known_gaps"] = [
  { class: "mcp_non_native_tools", ref: "flow-agents#492" },
  { class: "actor_attribution_conflation", ref: "flow-agents#423" },
  { class: "cross_session_event_contamination", ref: "flow-agents#271" },
];

export function integrityClassForSource(source: NarrativeSourceId): IntegrityClass {
  if (source.stream === "cmdlog" && source.locator.kind === "legacy") return "append_only_unhashed";
  if (source.stream === "file") return source.locator.hashKind === "git-blob" ? "hash_chained" : "overwritten_in_place";
  return DEFAULT_INTEGRITY_CLASS[source.stream];
}

export function buildCaptureCompleteness(
  telemetryConf: Record<string, unknown> | null | undefined,
  channelNames: readonly string[] = ["full", "analytics"],
  additionalGaps: CaptureCompleteness["known_gaps"] = [],
): CaptureCompleteness {
  const channels: Record<string, CaptureChannelStatus> = {};
  for (const channel of channelNames) {
    if (telemetryConf === undefined || telemetryConf === null) channels[channel] = "unknown";
    else if (!Object.prototype.hasOwnProperty.call(telemetryConf, channel)) channels[channel] = "unknown";
    else channels[channel] = telemetryConf[channel] === false || telemetryConf[channel] === null ? "inactive" : "active";
  }
  return { channels, known_gaps: [...KNOWN_CAPTURE_GAPS, ...additionalGaps] };
}
