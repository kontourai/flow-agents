/**
 * Runtime-session source for the Knowledge promote pipeline.
 *
 * Orchestrates bounded transcript projection and durable telemetry progress.
 * Raw transcript parsing, redaction, and cursor/source safety live in focused
 * sibling modules; this module owns only the ingest state machine.
 *
 * @module promote/runtime-session
 */

import {
  emptyCursor,
  loadSource,
  writeCursor,
} from "./runtime-session-cursor.js";
import {
  opaqueIdentifier,
  runtimeError,
  sha256,
} from "./runtime-session-core.js";
import {
  buildRuntimeResidue,
  readTranscriptSafely,
} from "./runtime-session-transcript.js";

export { scrubRuntimeResidueText } from "./runtime-session-redaction.js";

const CURSOR_SCHEMA_VERSION = "1.0";
const TELEMETRY_SCHEMA_VERSION = "0.3.0";
const DEFAULT_MAX_TELEMETRY_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TRANSCRIPT_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TELEMETRY_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TRANSCRIPT_RECORDS = 10_000;
const DEFAULT_MAX_TRANSCRIPT_ENTRIES = 2_000;
const DEFAULT_MAX_ENTRY_CHARS = 32_768;

function failure(eventId, error) {
  const code = typeof error?.code === "string"
    ? error.code
    : "RUNTIME_SESSION_INGEST_FAILED";
  return {
    event_id: eventId || null,
    code,
    message: `runtime-session ingest blocked (${code})`,
  };
}

function securityLimit(name, value, ceiling) {
  const resolved = value ?? ceiling;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > ceiling) {
    throw runtimeError("INGEST_OPTIONS_INVALID", `${name} is outside its supported range`);
  }
  return resolved;
}

function normalizeOptions(options) {
  if (!options.telemetryFile || !options.cursorFile) {
    throw new Error("ingestRuntimeSessions requires telemetryFile and cursorFile");
  }
  return {
    ...options,
    now: options.now ?? (() => new Date().toISOString()),
    maxTelemetryBytes: securityLimit(
      "maxTelemetryBytes",
      options.maxTelemetryBytes,
      DEFAULT_MAX_TELEMETRY_BYTES,
    ),
    maxTelemetryLineBytes: securityLimit(
      "maxTelemetryLineBytes",
      options.maxTelemetryLineBytes,
      DEFAULT_MAX_TELEMETRY_LINE_BYTES,
    ),
    maxTranscriptBytes: securityLimit(
      "maxTranscriptBytes",
      options.maxTranscriptBytes,
      DEFAULT_MAX_TRANSCRIPT_BYTES,
    ),
    maxTranscriptLineBytes: securityLimit(
      "maxTranscriptLineBytes",
      options.maxTranscriptLineBytes,
      DEFAULT_MAX_TRANSCRIPT_LINE_BYTES,
    ),
    maxTranscriptRecords: securityLimit(
      "maxTranscriptRecords",
      options.maxTranscriptRecords,
      DEFAULT_MAX_TRANSCRIPT_RECORDS,
    ),
    maxTranscriptEntries: securityLimit(
      "maxTranscriptEntries",
      options.maxTranscriptEntries,
      DEFAULT_MAX_TRANSCRIPT_ENTRIES,
    ),
    maxEntryChars: securityLimit(
      "maxEntryChars",
      options.maxEntryChars,
      DEFAULT_MAX_ENTRY_CHARS,
    ),
    persistCursor: typeof options.persistCursor === "function"
      ? options.persistCursor
      : writeCursor,
  };
}

function initialScanState(source) {
  const startOffset = source.reset ? 0 : (source.priorCursor?.byte_offset ?? 0);
  return {
    residues: [],
    failures: [],
    processedSessions: new Set(),
    seenSessions: new Map((source.priorCursor?.seen_sessions ?? []).map((entry) =>
      [entry.key_sha256, entry.transcript_sha256])),
    position: startOffset,
    startOffset,
    safeOffset: startOffset,
    lastEventId: source.reset ? null : (source.priorCursor?.last_event_id ?? null),
    scanned: 0,
    skipped: 0,
  };
}

function readTelemetryLine(telemetry, position, maxLineBytes) {
  const newline = telemetry.indexOf(0x0a, position);
  if (newline === -1) {
    throw runtimeError(
      "TELEMETRY_INCOMPLETE_LINE",
      "telemetry ends with an incomplete record",
    );
  }
  const bytes = telemetry.subarray(position, newline);
  if (bytes.length > maxLineBytes) {
    throw runtimeError(
      "TELEMETRY_LINE_TOO_LARGE",
      "telemetry record exceeds the byte limit",
    );
  }
  return {
    raw: bytes.toString("utf8").replace(/\r$/, ""),
    nextOffset: newline + 1,
  };
}

function markHandled(state, nextOffset, eventId, skipped = false) {
  state.safeOffset = nextOffset;
  state.lastEventId = eventId;
  if (skipped) state.skipped += 1;
}

function ingestTelemetryRecord(record, eventId, nextOffset, state, options) {
  if (record.schema_version !== TELEMETRY_SCHEMA_VERSION) {
    throw runtimeError(
      "TELEMETRY_SCHEMA_UNSUPPORTED",
      "telemetry record schema is unsupported",
    );
  }
  const transcriptPath = record.hook?.transcript_path;
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    markHandled(state, nextOffset, eventId, true);
    return;
  }
  const sessionKey =
    `${record.hook?.runtime_session_id || record.session_id || "unknown"}\u0000${transcriptPath}`;
  if (state.processedSessions.has(sessionKey)) {
    markHandled(state, nextOffset, eventId, true);
    return;
  }
  const content = readTranscriptSafely(
    transcriptPath,
    options.transcriptRoots,
    options.maxTranscriptBytes,
  );
  const keyHash = sha256(sessionKey);
  const transcriptHash = sha256(content);
  if (state.seenSessions.get(keyHash) === transcriptHash) {
    state.processedSessions.add(sessionKey);
    markHandled(state, nextOffset, eventId, true);
    return;
  }
  state.residues.push(buildRuntimeResidue(record, content, options));
  state.processedSessions.add(sessionKey);
  state.seenSessions.delete(keyHash);
  state.seenSessions.set(keyHash, transcriptHash);
  while (state.seenSessions.size > 2_000) {
    state.seenSessions.delete(state.seenSessions.keys().next().value);
  }
  markHandled(state, nextOffset, eventId);
}

function scanTelemetry(source, options) {
  const state = initialScanState(source);
  while (state.failures.length === 0 && state.position < source.telemetry.length) {
    let line;
    try {
      line = readTelemetryLine(
        source.telemetry,
        state.position,
        options.maxTelemetryLineBytes,
      );
    } catch (error) {
      state.failures.push(failure(null, error));
      break;
    }
    state.position = line.nextOffset;
    if (!line.raw) {
      markHandled(state, line.nextOffset, null, true);
      continue;
    }
    state.scanned += 1;
    let record;
    try {
      record = JSON.parse(line.raw);
    } catch {
      state.failures.push(
        failure(null, runtimeError("TELEMETRY_MALFORMED", "telemetry record is invalid")),
      );
      break;
    }
    const eventId = typeof record.event_id === "string"
      ? opaqueIdentifier("event", record.event_id)
      : null;
    try {
      ingestTelemetryRecord(record, eventId, line.nextOffset, state, options);
    } catch (error) {
      state.failures.push(failure(eventId, error));
    }
  }
  return state;
}

function candidateCursor(source, state, options) {
  return {
    schema_version: CURSOR_SCHEMA_VERSION,
    source_sha256: source.identity,
    prefix_sha256: sha256(source.telemetry.subarray(0, state.safeOffset)),
    byte_offset: state.safeOffset,
    last_event_id: state.lastEventId,
    seen_sessions: [...state.seenSessions].map(([key_sha256, transcript_sha256]) =>
      ({ key_sha256, transcript_sha256 })),
    updated_at: state.safeOffset === state.startOffset && !source.reset
      ? (source.priorCursor?.updated_at ?? null)
      : options.now(),
  };
}

function formatResult(state, cursor, sourceReset, residues = state.residues) {
  return {
    residues,
    report: {
      schema_version: "1.0",
      telemetry_records_scanned: state.scanned,
      sessions_ingested: residues.length,
      records_skipped: state.skipped,
      source_reset: sourceReset,
      blocked: state.failures.length > 0,
      failures: state.failures,
    },
    cursor,
  };
}

function persistResult(source, state, options) {
  const cursor = candidateCursor(source, state, options);
  if (state.safeOffset === state.startOffset &&
      (!source.reset || state.failures.length > 0)) {
    return formatResult(
      state,
      source.priorCursor ?? emptyCursor(source.identity),
      source.reset,
    );
  }
  try {
    if (options.persistCursor(source.cursorFile, cursor) !== true) {
      throw runtimeError("CURSOR_WRITE_FAILED", "cursor writer did not confirm commit");
    }
    return formatResult(state, cursor, source.reset);
  } catch {
    state.failures.push(
      failure(null, runtimeError("CURSOR_WRITE_FAILED", "cursor commit failed")),
    );
    return formatResult(
      state,
      source.priorCursor ?? emptyCursor(source.identity),
      source.reset,
      [],
    );
  }
}

function combineResults(first, second) {
  const residues = [...first.residues, ...second.residues];
  return {
    residues,
    report: {
      schema_version: "1.0",
      telemetry_records_scanned:
        first.report.telemetry_records_scanned + second.report.telemetry_records_scanned,
      sessions_ingested: residues.length,
      records_skipped: first.report.records_skipped + second.report.records_skipped,
      source_reset: second.report.source_reset,
      blocked: first.report.blocked || second.report.blocked,
      failures: [...first.report.failures, ...second.report.failures],
    },
    cursor: second.cursor,
  };
}

/**
 * Ingest runtime sessions referenced by canonical telemetry records.
 *
 * @param {object} options
 * @param {string} options.telemetryFile canonical v0.3.0 JSONL file.
 * @param {string} options.cursorFile dream-owned watermark file.
 * @param {string[]} options.transcriptRoots explicit allowed transcript roots.
 * @returns {{residues: object[], report: object, cursor: object}}
 */
export function ingestRuntimeSessions(rawOptions = {}) {
  let options;
  let source;
  try {
    options = normalizeOptions(rawOptions);
    source = loadSource(options);
  } catch (error) {
    const state = {
      residues: [],
      failures: [failure(null, error)],
      scanned: 0,
      skipped: 0,
    };
    return formatResult(state, emptyCursor(), false, []);
  }
  if (!source.predecessor) {
    return persistResult(source, scanTelemetry(source, options), options);
  }
  const predecessor = persistResult(
    source.predecessor,
    scanTelemetry(source.predecessor, options),
    options,
  );
  if (predecessor.report.blocked) return predecessor;
  const current = { ...source, priorCursor: predecessor.cursor, reset: true };
  delete current.predecessor;
  return combineResults(
    predecessor,
    persistResult(current, scanTelemetry(current, options), options),
  );
}
