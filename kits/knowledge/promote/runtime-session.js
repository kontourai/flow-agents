/**
 * `runtime-session` residue source (#669, Unified Agentic Memory WI-1).
 *
 * Walks canonical telemetry (schema 0.3.0, full channel) from a watermark
 * cursor, resolves each Claude Code / Codex `hook.transcript_path` inside
 * host-authorized roots, splits the conversation into sittings, scrubs it, and
 * returns one residue per new or changed sitting plus a CANDIDATE cursor.
 *
 * Ownership boundaries (see the #669 rework notes in kits/knowledge/docs/README.md):
 *   - The host supplies the telemetry file and the authorized transcript roots;
 *     nothing here discovers paths on its own.
 *   - `ingestRuntimeSessions` writes nothing. The transaction owner (the dream
 *     job, #671) commits the candidate cursor with `commitRuntimeCursor` only
 *     after its own work with the residue succeeds.
 *   - No store writes (#670), no scheduling (#671), no injection (#672).
 *
 * Cursor rule: the candidate telemetry offset never passes a telemetry line
 * whose content was not fully read — a malformed or unknown-version telemetry
 * line, or a transcript that is drifted, unreadable or over a limit. Later
 * lines are still processed in the same run; their sittings are recorded by
 * content hash so a re-run from the held offset does not emit them twice.
 *
 * @module promote/runtime-session
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { scrubResidueText } from "./runtime-redaction.js";
import { TranscriptFormatError, readConversation, splitSittings } from "./runtime-transcript.js";

export const RUNTIME_CURSOR_SCHEMA_VERSION = "1.0";
export const TELEMETRY_SCHEMA_VERSION = "0.3.0";
export const DEFAULT_IDLE_GAP_MS = 30 * 60 * 1000;
/** A transcript missing for a telemetry event younger than this holds the cursor; older ones are skipped. */
export const DEFAULT_MISSING_TRANSCRIPT_GRACE_MS = 60 * 60 * 1000;
export const SUPPORTED_RUNTIMES = Object.freeze(["claude-code", "codex"]);

const DEFAULT_LIMITS = Object.freeze({
  maxTelemetryBytes: 256 * 1024 * 1024,
  maxTranscriptBytes: 64 * 1024 * 1024,
});

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** A fresh cursor: nothing read, no sittings seen. */
export function emptyRuntimeCursor() {
  return {
    schema_version: RUNTIME_CURSOR_SCHEMA_VERSION,
    telemetry: { offset: 0, prefix_sha256: sha256("") },
    sittings: {},
  };
}

function assertCursorShape(cursor) {
  const ok =
    cursor &&
    typeof cursor === "object" &&
    cursor.schema_version === RUNTIME_CURSOR_SCHEMA_VERSION &&
    cursor.telemetry &&
    Number.isInteger(cursor.telemetry.offset) &&
    cursor.telemetry.offset >= 0 &&
    typeof cursor.telemetry.prefix_sha256 === "string" &&
    cursor.sittings &&
    typeof cursor.sittings === "object" &&
    !Array.isArray(cursor.sittings) &&
    Object.values(cursor.sittings).every((hash) => typeof hash === "string");
  if (!ok) throw new Error("runtime-session cursor has an unsupported shape");
}

/** Read a committed cursor file; a missing file is an empty cursor. */
export function readRuntimeCursor(cursorFile) {
  let raw;
  try {
    raw = fs.readFileSync(cursorFile, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyRuntimeCursor();
    throw error;
  }
  const cursor = JSON.parse(raw);
  assertCursorShape(cursor);
  return cursor;
}

/**
 * Atomically commit a cursor (temp file + rename). Called by the transaction
 * owner after its work succeeds — never by ingest itself.
 */
export function commitRuntimeCursor(cursorFile, cursor) {
  assertCursorShape(cursor);
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  const temp = `${cursorFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(cursor, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temp, cursorFile);
}

function realRoots(transcriptRoots) {
  if (!Array.isArray(transcriptRoots) || transcriptRoots.length === 0) {
    throw new Error("runtime-session ingest requires at least one authorized transcript root");
  }
  return transcriptRoots.map((root) => fs.realpathSync.native(root));
}

class Blocked extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

class Skipped extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/** True when the file at `transcriptPath` still looks like the one that was read (or was never readable). */
function sameFileStamp(stamp, transcriptPath) {
  if (!stamp) return true;
  try {
    const now = fs.statSync(transcriptPath);
    return now.size === stamp.size && now.mtimeMs === stamp.mtimeMs && now.ino === stamp.ino;
  } catch {
    return false;
  }
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Resolve and read a transcript inside the authorized roots.
 *
 * The path is resolved to a real path inside a root, opened without following a
 * final symlink, and read through that one descriptor. Afterwards the path must
 * still resolve to the same inode and the file must not have grown, otherwise
 * the read is not trusted: a swap between the root check and the read, or an
 * append during it, holds the cursor instead of leaking or losing content.
 * Content appended after this function returns is newer than the telemetry
 * reference being served; the next reference re-reads the transcript.
 * Limit: Node has no openat2(RESOLVE_BENEATH), so a swap of a parent directory
 * by someone who can already write inside the authorized roots is not defeated.
 */
function readTranscript(transcriptPath, roots, maxBytes) {
  let real;
  try {
    real = fs.realpathSync.native(transcriptPath);
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Skipped("TRANSCRIPT_MISSING");
    throw new Blocked("TRANSCRIPT_UNREADABLE", "transcript path could not be resolved");
  }
  const root = roots.find((r) => real === r || real.startsWith(`${r}${path.sep}`));
  if (!root) throw new Skipped("TRANSCRIPT_OUTSIDE_ROOTS");
  let fd;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Skipped("TRANSCRIPT_MISSING");
    throw new Blocked("TRANSCRIPT_UNREADABLE", "transcript could not be opened");
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Blocked("TRANSCRIPT_NOT_REGULAR", "transcript is not a regular file");
    if (before.size > maxBytes) throw new Blocked("TRANSCRIPT_TOO_LARGE", "transcript exceeds the byte limit");
    const content = fs.readFileSync(fd);
    if (content.length > maxBytes) throw new Blocked("TRANSCRIPT_TOO_LARGE", "transcript exceeds the byte limit");
    const after = fs.fstatSync(fd);
    let current;
    try {
      current = { real: fs.realpathSync.native(transcriptPath), stat: fs.statSync(real) };
    } catch {
      throw new Blocked("TRANSCRIPT_CHANGED_DURING_READ", "transcript path changed while it was read");
    }
    if (
      after.size !== content.length ||
      current.stat.size !== after.size ||
      current.stat.mtimeMs !== after.mtimeMs ||
      current.real !== real ||
      current.stat.ino !== before.ino ||
      current.stat.dev !== before.dev
    ) {
      throw new Blocked("TRANSCRIPT_CHANGED_DURING_READ", "transcript changed while it was read");
    }
    return {
      content,
      ref: path.relative(root, real).split(path.sep).join("/"),
      stamp: { size: after.size, mtimeMs: after.mtimeMs, ino: after.ino },
    };
  } catch (error) {
    if (error instanceof Blocked) throw error;
    throw new Blocked("TRANSCRIPT_UNREADABLE", "transcript could not be read");
  } finally {
    fs.closeSync(fd);
  }
}

// cwd and branch are session-level (Ferry's Thread metadata), not per sitting.
function buildSittingResidues(harness, parsed, transcriptRef, idleGapMs, now) {
  return splitSittings(parsed.messages, idleGapMs).map((sitting, n) => {
    const sittingId = `${harness}:${parsed.sessionId}:${n}`;
    const turns = sitting.turns.map((turn) => ({
      role: turn.role,
      text: scrubResidueText(turn.text),
      at: new Date(turn.timestampMs).toISOString(),
    }));
    const first = sitting.turns[0];
    const endMs = sitting.turns[sitting.turns.length - 1].endMs;
    const contentHash = `sha256:${sha256(JSON.stringify({ sittingId, turns }))}`;
    return {
      source: "runtime-session",
      sittingId,
      contentHash,
      complete: now - endMs >= idleGapMs,
      provenance: {
        harness,
        sessionId: parsed.sessionId,
        transcriptRef: scrubResidueText(transcriptRef),
        cwd: parsed.cwd === null ? null : scrubResidueText(parsed.cwd),
        gitBranch: parsed.gitBranch === null ? null : scrubResidueText(parsed.gitBranch),
        startedAt: new Date(first.timestampMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
      },
      turns,
    };
  });
}

/**
 * Ingest runtime sessions referenced by telemetry newer than `cursor`.
 *
 * @param {object} options
 * @param {string} options.telemetryFile  canonical telemetry JSONL (full channel).
 * @param {string[]} options.transcriptRoots  host-authorized transcript roots.
 * @param {object} [options.cursor]  last committed cursor (default: empty).
 * @param {number} [options.idleGapMs]  sitting split gap (default 30 min).
 * @param {number} [options.now]  clock for `complete` and the missing-transcript grace (default Date.now()).
 * @param {number} [options.missingTranscriptGraceMs]  hold the cursor for a missing transcript whose
 *   telemetry event is younger than this (default 1 h); older ones are skipped (retention cleanup).
 * @param {object} [options.limits]  { maxTelemetryBytes, maxTranscriptBytes }.
 * @returns {{ residues: object[], report: object, candidateCursor: object }}
 */
export function ingestRuntimeSessions(options = {}) {
  const {
    telemetryFile,
    transcriptRoots,
    cursor = emptyRuntimeCursor(),
    idleGapMs = DEFAULT_IDLE_GAP_MS,
    now = Date.now(),
    missingTranscriptGraceMs = DEFAULT_MISSING_TRANSCRIPT_GRACE_MS,
  } = options;
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  if (!Number.isFinite(idleGapMs) || idleGapMs <= 0) throw new Error("idleGapMs must be a positive number");
  assertCursorShape(cursor);
  const roots = realRoots(transcriptRoots);

  const report = {
    schema_version: "1.0",
    telemetry_lines_read: 0,
    sittings_emitted: 0,
    sittings_unchanged: 0,
    skipped: [],
    blocked: [],
    notes: [],
    cursor_held: false,
  };
  const unchangedCursor = () => ({ residues: [], report: { ...report, cursor_held: true }, candidateCursor: cursor });

  const stat = fs.statSync(telemetryFile);
  if (!stat.isFile() || stat.size > limits.maxTelemetryBytes) {
    report.blocked.push({ telemetry_offset: cursor.telemetry.offset, reason: "TELEMETRY_UNREADABLE" });
    return unchangedCursor();
  }
  const telemetry = fs.readFileSync(telemetryFile);
  const startOffset = cursor.telemetry.offset;
  if (
    telemetry.length < startOffset ||
    sha256(telemetry.subarray(0, startOffset)) !== cursor.telemetry.prefix_sha256
  ) {
    // Truncated, rotated or rewritten: the cursor no longer describes this file.
    report.blocked.push({ telemetry_offset: startOffset, reason: "TELEMETRY_DISCONTINUITY" });
    return unchangedCursor();
  }

  const sittings = { ...cursor.sittings };
  const residues = [];
  const transcriptOutcomes = new Map();
  let heldAt = null;
  let position = startOffset;

  while (position < telemetry.length) {
    const newline = telemetry.indexOf(0x0a, position);
    if (newline === -1) break; // partial line: a write in progress, left unread
    const lineStart = position;
    const line = telemetry.subarray(position, newline).toString("utf8");
    position = newline + 1;
    if (line.trim() === "") continue;
    report.telemetry_lines_read += 1;

    const block = (reason, detail) => {
      // Details can echo transcript-derived text (Ferry warnings), so they are scrubbed too.
      report.blocked.push({ telemetry_offset: lineStart, reason, ...(detail ? { detail: scrubResidueText(detail) } : {}) });
      if (heldAt === null) heldAt = lineStart;
    };
    const skip = (reason) => report.skipped.push({ telemetry_offset: lineStart, reason });

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      block("TELEMETRY_MALFORMED");
      continue;
    }
    if (!event || typeof event !== "object" || event.schema_version !== TELEMETRY_SCHEMA_VERSION) {
      block("TELEMETRY_UNKNOWN_VERSION");
      continue;
    }
    const harness = event.agent?.runtime;
    if (!SUPPORTED_RUNTIMES.includes(harness)) {
      skip("UNSUPPORTED_RUNTIME");
      continue;
    }
    const transcriptPath = event.hook?.transcript_path;
    if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) {
      skip("NO_TRANSCRIPT_REF");
      continue;
    }

    const key = `${harness}\u0000${transcriptPath}`;
    let outcome = transcriptOutcomes.get(key);
    // A second reference to a transcript that has since grown (or been replaced)
    // must not be answered from the first snapshot.
    if (outcome && !sameFileStamp(outcome.stamp, transcriptPath)) outcome = undefined;
    if (!outcome) {
      let stampOf;
      try {
        const { content, ref, stamp } = readTranscript(transcriptPath, roots, limits.maxTranscriptBytes);
        stampOf = stamp;
        const parsed = readConversation(harness, content);
        if (parsed.sidechain) {
          outcome = { kind: "skip", reason: "SIDECHAIN_TRANSCRIPT" };
        } else if (parsed.messages.length === 0 && !parsed.partialTail) {
          outcome = { kind: "skip", reason: "NO_CONVERSATION" };
        } else {
          outcome = {
            kind: "ok",
            residues: buildSittingResidues(harness, parsed, ref, idleGapMs, now),
            // A write in progress: emit what is complete, but do not move past the line.
            hold: parsed.partialTail,
            unterminatedMemory: parsed.unterminatedMemory,
          };
        }
      } catch (error) {
        if (error instanceof Skipped) outcome = { kind: "skip", reason: error.reason };
        else if (error instanceof Blocked || error instanceof TranscriptFormatError) {
          outcome = { kind: "block", reason: error.reason, detail: error.message };
        } else {
          outcome = { kind: "block", reason: "TRANSCRIPT_UNREADABLE", detail: "unexpected read failure" };
        }
      }
      outcome.stamp = stampOf;
      transcriptOutcomes.set(key, outcome);
      if (outcome.kind === "ok") {
        for (const residue of outcome.residues) {
          if (sittings[residue.sittingId] === residue.contentHash) {
            report.sittings_unchanged += 1;
            continue;
          }
          sittings[residue.sittingId] = residue.contentHash;
          residues.push(residue);
          report.sittings_emitted += 1;
        }
      }
    }
    if (outcome.kind === "ok" && outcome.hold) block("TRANSCRIPT_PARTIAL_TAIL", "transcript ends in an unterminated line");
    if (outcome.kind === "ok" && outcome.unterminatedMemory) {
      report.notes.push({ telemetry_offset: lineStart, reason: "INJECTED_MEMORY_UNTERMINATED" });
    }
    if (outcome.kind === "skip" && outcome.reason === "TRANSCRIPT_MISSING") {
      // An event this young may be ahead of its transcript becoming visible.
      const at = Number(event.timestamp);
      if (!Number.isFinite(at) || now - at < missingTranscriptGraceMs) {
        block("TRANSCRIPT_MISSING_RECENT", "transcript for a recent event is not visible yet");
        continue;
      }
    }
    if (outcome.kind === "skip") skip(outcome.reason);
    if (outcome.kind === "block") block(outcome.reason, outcome.detail);
  }

  const offset = heldAt === null ? position : heldAt;
  report.cursor_held = heldAt !== null;
  return {
    residues,
    report,
    candidateCursor: {
      schema_version: RUNTIME_CURSOR_SCHEMA_VERSION,
      telemetry: { offset, prefix_sha256: sha256(telemetry.subarray(0, offset)) },
      sittings,
    },
  };
}
