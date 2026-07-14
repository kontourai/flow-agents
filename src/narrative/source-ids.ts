export const NARRATIVE_SOURCE_ID_VERSION = "fa1" as const;

export type NarrativeSourceStream =
  | "telemetry"
  | "cmdlog"
  | "agent-event"
  | "delegation"
  | "trust-claim"
  | "trust-evidence"
  | "flow-state"
  | "flow-report"
  | "flow-transition"
  | "surface-explanation"
  | "transcript"
  | "file";

interface SourceIdBase<S extends NarrativeSourceStream> {
  version: typeof NARRATIVE_SOURCE_ID_VERSION;
  stream: S;
}

export interface TelemetrySourceId extends SourceIdBase<"telemetry"> {
  scope: { channel: string; sessionId: string };
  // sha8 pins the exact record content: duplicate event_ids cannot silently
  // rebind to a different record when the log is reordered or rewritten.
  locator: { eventId: string; sha8: string };
  ordinal?: number;
}

export interface ChainedCommandLogSourceId extends SourceIdBase<"cmdlog"> {
  scope: { slug: string };
  locator: { kind: "chained"; seq: number; hash8: string };
}

export interface LegacyCommandLogSourceId extends SourceIdBase<"cmdlog"> {
  scope: { slug: string };
  locator: { kind: "legacy"; line: number; sha8: string };
}

export type CommandLogSourceId = ChainedCommandLogSourceId | LegacyCommandLogSourceId;

export interface AgentEventSourceId extends SourceIdBase<"agent-event" | "delegation"> {
  scope: { slug: string; agentId: string };
  locator: { lineIndex: number; sha8: string };
}

export interface TrustSourceId extends SourceIdBase<"trust-claim" | "trust-evidence"> {
  scope: { slug: string; bundleSha8: string };
  locator: { id: string };
}

export interface FlowStateSourceId extends SourceIdBase<"flow-state"> {
  scope: { runId: string };
  locator: { sha8: string };
}

export interface FlowReportSourceId extends SourceIdBase<"flow-report"> {
  scope: { runId: string };
  locator: { sha8: string };
}

export interface FlowTransitionSourceId extends SourceIdBase<"flow-transition"> {
  scope: { runId: string };
  locator: { index: number; sha8: string };
}

export interface SurfaceExplanationSourceId extends SourceIdBase<"surface-explanation"> {
  scope: { slug: string; bundleSha8: string };
  locator: { claimId: string };
}

export interface TranscriptSourceId extends SourceIdBase<"transcript"> {
  scope: { pathSha8: string };
  locator: { byteStart: number; byteEnd: number };
}

export interface FileSourceId extends SourceIdBase<"file"> {
  scope: { repoRelativePath: string };
  locator: { hash: string; hashKind: "sha256" | "git-blob" };
}

export type NarrativeSourceId =
  | TelemetrySourceId
  | CommandLogSourceId
  | AgentEventSourceId
  | TrustSourceId
  | FlowStateSourceId
  | FlowReportSourceId
  | FlowTransitionSourceId
  | SurfaceExplanationSourceId
  | TranscriptSourceId
  | FileSourceId;

export type SourceIdErrorCode =
  | "invalid_syntax"
  | "unsupported_version"
  | "unsupported_stream"
  | "invalid_encoding"
  | "invalid_scope"
  | "invalid_locator"
  | "invalid_ordinal";

export class SourceIdParseError extends Error {
  readonly name = "SourceIdParseError";

  constructor(
    readonly code: SourceIdErrorCode,
    readonly sourceId: string,
    message: string,
  ) {
    super(message);
  }
}

const STREAMS = new Set<NarrativeSourceStream>([
  "telemetry", "cmdlog", "agent-event", "delegation", "trust-claim",
  "trust-evidence", "flow-state", "flow-transition", "transcript", "file",
  "flow-report", "surface-explanation",
]);
const ENCODED_COMPONENT = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/;
const SHA8 = /^[0-9a-f]{8}$/;
const CONTENT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function fail(code: SourceIdErrorCode, sourceId: string, message: string): never {
  throw new SourceIdParseError(code, sourceId, message);
}

function encodeComponent(value: string): string {
  if (!value) throw new TypeError("source ID components must not be empty");
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeComponent(value: string, sourceId: string): string {
  if (!ENCODED_COMPONENT.test(value)) fail("invalid_encoding", sourceId, "source ID component is not percent-encoded");
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) fail("invalid_encoding", sourceId, "source ID component must not be empty");
    return decoded;
  } catch {
    return fail("invalid_encoding", sourceId, "source ID component contains invalid percent encoding");
  }
}

function splitComponents(value: string, count: number, sourceId: string, part: "scope" | "locator"): string[] {
  const pieces = value.split("/");
  if (pieces.length !== count) fail(part === "scope" ? "invalid_scope" : "invalid_locator", sourceId, `${part} must have ${count} component(s)`);
  return pieces.map((piece) => decodeComponent(piece, sourceId));
}

function integer(value: string, sourceId: string, label: string, minimum = 0): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail("invalid_locator", sourceId, `${label} must be a canonical integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) fail("invalid_locator", sourceId, `${label} is out of range`);
  return parsed;
}

function sha8(value: string, sourceId: string, label: string): string {
  if (!SHA8.test(value)) fail("invalid_locator", sourceId, `${label} must be eight lowercase hexadecimal characters`);
  return value;
}

export function parseSourceId(sourceId: string): NarrativeSourceId {
  const ordinalParts = sourceId.split("#");
  if (ordinalParts.length > 2) fail("invalid_syntax", sourceId, "source ID has more than one ordinal delimiter");
  const [body = "", ordinalText] = ordinalParts;
  const parts = body.split(":");
  if (parts.length !== 4) fail("invalid_syntax", sourceId, "source ID must have version, stream, scope, and locator");
  const [version, streamText, rawScope, rawLocator] = parts as [string, string, string, string];
  if (version !== NARRATIVE_SOURCE_ID_VERSION) fail("unsupported_version", sourceId, `unsupported source ID version: ${version || "(empty)"}`);
  if (!STREAMS.has(streamText as NarrativeSourceStream)) fail("unsupported_stream", sourceId, `unsupported source stream: ${streamText || "(empty)"}`);
  const stream = streamText as NarrativeSourceStream;
  let ordinal: number | undefined;
  if (ordinalText !== undefined) {
    if (stream !== "telemetry" || !/^(?:0|[1-9][0-9]*)$/.test(ordinalText)) fail("invalid_ordinal", sourceId, "ordinal is only valid for telemetry and must be a canonical non-negative integer");
    ordinal = Number(ordinalText);
    if (!Number.isSafeInteger(ordinal)) fail("invalid_ordinal", sourceId, "ordinal is out of range");
  }

  switch (stream) {
    case "telemetry": {
      const [channel, sessionId] = splitComponents(rawScope, 2, sourceId, "scope") as [string, string];
      const [eventId, hash] = splitComponents(rawLocator, 2, sourceId, "locator") as [string, string];
      return { version, stream, scope: { channel, sessionId }, locator: { eventId, sha8: sha8(hash, sourceId, "telemetry content pin") }, ...(ordinal === undefined ? {} : { ordinal }) };
    }
    case "cmdlog": {
      const [slug] = splitComponents(rawScope, 1, sourceId, "scope") as [string];
      const [first, hash] = splitComponents(rawLocator, 2, sourceId, "locator") as [string, string];
      const hashPin = sha8(hash, sourceId, "command-log hash pin");
      if (first.startsWith("line-")) return { version, stream, scope: { slug }, locator: { kind: "legacy", line: integer(first.slice(5), sourceId, "legacy line", 1), sha8: hashPin } };
      return { version, stream, scope: { slug }, locator: { kind: "chained", seq: integer(first, sourceId, "chain sequence"), hash8: hashPin } };
    }
    case "agent-event":
    case "delegation": {
      const [slug, agentId] = splitComponents(rawScope, 2, sourceId, "scope") as [string, string];
      const [index, hash] = splitComponents(rawLocator, 2, sourceId, "locator") as [string, string];
      return { version, stream, scope: { slug, agentId }, locator: { lineIndex: integer(index, sourceId, "line index"), sha8: sha8(hash, sourceId, "line hash pin") } };
    }
    case "trust-claim":
    case "trust-evidence": {
      const [slug, bundleHash] = splitComponents(rawScope, 2, sourceId, "scope") as [string, string];
      const [id] = splitComponents(rawLocator, 1, sourceId, "locator") as [string];
      return { version, stream, scope: { slug, bundleSha8: sha8(bundleHash, sourceId, "bundle hash pin") }, locator: { id } };
    }
    case "flow-state": {
      const [runId] = splitComponents(rawScope, 1, sourceId, "scope") as [string];
      const [state, hash] = splitComponents(rawLocator, 2, sourceId, "locator") as [string, string];
      if (state !== "state") fail("invalid_locator", sourceId, "flow-state locator must begin with state");
      return { version, stream, scope: { runId }, locator: { sha8: sha8(hash, sourceId, "state hash pin") } };
    }
    case "flow-report": {
      const [runId] = splitComponents(rawScope, 1, sourceId, "scope") as [string];
      const [report, hash] = splitComponents(rawLocator, 2, sourceId, "locator") as [string, string];
      if (report !== "report") fail("invalid_locator", sourceId, "flow-report locator must begin with report");
      return { version, stream, scope: { runId }, locator: { sha8: sha8(hash, sourceId, "report hash pin") } };
    }
    case "flow-transition": {
      const [runId] = splitComponents(rawScope, 1, sourceId, "scope") as [string];
      const [index, hash] = splitComponents(rawLocator, 2, sourceId, "locator") as [string, string];
      return { version, stream, scope: { runId }, locator: { index: integer(index, sourceId, "transition index"), sha8: sha8(hash, sourceId, "transition hash pin") } };
    }
    case "surface-explanation": {
      const [slug, bundleHash] = splitComponents(rawScope, 2, sourceId, "scope") as [string, string];
      const [claimId] = splitComponents(rawLocator, 1, sourceId, "locator") as [string];
      return { version, stream, scope: { slug, bundleSha8: sha8(bundleHash, sourceId, "bundle hash pin") }, locator: { claimId } };
    }
    case "transcript": {
      const [pathHash] = splitComponents(rawScope, 1, sourceId, "scope") as [string];
      const [range] = splitComponents(rawLocator, 1, sourceId, "locator") as [string];
      const match = /^(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/.exec(range);
      if (!match) fail("invalid_locator", sourceId, "transcript locator must be a canonical byte range");
      const byteStart = integer(match[1], sourceId, "byte start");
      const byteEnd = integer(match[2], sourceId, "byte end");
      if (byteEnd < byteStart) fail("invalid_locator", sourceId, "transcript byte end must not precede byte start");
      return { version, stream, scope: { pathSha8: sha8(pathHash, sourceId, "path hash pin") }, locator: { byteStart, byteEnd } };
    }
    case "file": {
      const [repoRelativePath] = splitComponents(rawScope, 1, sourceId, "scope") as [string];
      const [hash] = splitComponents(rawLocator, 1, sourceId, "locator") as [string];
      if (!CONTENT_HASH.test(hash)) fail("invalid_locator", sourceId, "file hash pin must be a lowercase SHA-1 or SHA-256 digest");
      return { version, stream, scope: { repoRelativePath }, locator: { hash, hashKind: hash.length === 64 ? "sha256" : "git-blob" } };
    }
  }
}

export function formatSourceId(source: NarrativeSourceId): string {
  const prefix = `${NARRATIVE_SOURCE_ID_VERSION}:${source.stream}:`;
  switch (source.stream) {
    case "telemetry":
      return `${prefix}${encodeComponent(source.scope.channel)}/${encodeComponent(source.scope.sessionId)}:${encodeComponent(source.locator.eventId)}/${source.locator.sha8}${source.ordinal === undefined ? "" : `#${source.ordinal}`}`;
    case "cmdlog":
      return source.locator.kind === "legacy"
        ? `${prefix}${encodeComponent(source.scope.slug)}:line-${source.locator.line}/${source.locator.sha8}`
        : `${prefix}${encodeComponent(source.scope.slug)}:${source.locator.seq}/${source.locator.hash8}`;
    case "agent-event":
    case "delegation":
      return `${prefix}${encodeComponent(source.scope.slug)}/${encodeComponent(source.scope.agentId)}:${source.locator.lineIndex}/${source.locator.sha8}`;
    case "trust-claim":
    case "trust-evidence":
      return `${prefix}${encodeComponent(source.scope.slug)}/${source.scope.bundleSha8}:${encodeComponent(source.locator.id)}`;
    case "flow-state":
      return `${prefix}${encodeComponent(source.scope.runId)}:state/${source.locator.sha8}`;
    case "flow-report":
      return `${prefix}${encodeComponent(source.scope.runId)}:report/${source.locator.sha8}`;
    case "flow-transition":
      return `${prefix}${encodeComponent(source.scope.runId)}:${source.locator.index}/${source.locator.sha8}`;
    case "surface-explanation":
      return `${prefix}${encodeComponent(source.scope.slug)}/${source.scope.bundleSha8}:${encodeComponent(source.locator.claimId)}`;
    case "transcript":
      return `${prefix}${source.scope.pathSha8}:${source.locator.byteStart}-${source.locator.byteEnd}`;
    case "file":
      return `${prefix}${encodeComponent(source.scope.repoRelativePath)}:${source.locator.hash}`;
  }
}

export function compareSourceIds(left: NarrativeSourceId | string, right: NarrativeSourceId | string): number {
  const leftText = typeof left === "string" ? formatSourceId(parseSourceId(left)) : formatSourceId(left);
  const rightText = typeof right === "string" ? formatSourceId(parseSourceId(right)) : formatSourceId(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}
