/**
 * Runtime transcript parsers for the `runtime-session` residue source (#669).
 *
 * Reads Claude Code project JSONL and Codex rollout JSONL and keeps only the
 * conversation: user and assistant TEXT. Everything else is dropped by design —
 * tool calls and tool results, thinking/reasoning, images, subagent sidechains,
 * meta/compact-summary entries, harness-originated user entries (task
 * notifications), harness-injected tags such as `<system-reminder>`, and any
 * block wrapped in the injected-memory marker (so #672's injected memory can
 * never be re-ingested as new conversation).
 *
 * Unknown record TYPES are ignored (both runtimes add metadata record types
 * often). Drift is detected on the records this parser depends on: a
 * conversation record whose shape it cannot read, a non-JSON line, or a file
 * that is not the format its telemetry runtime claims. Drift throws
 * `TranscriptFormatError`; the caller reports it and holds its cursor.
 *
 * Only newline-terminated lines are read: a trailing partial line is a write in
 * progress and is left for the next run.
 *
 * @module promote/runtime-transcript
 */

/**
 * Wrapper the injection slice (#672) must place around any memory it injects
 * into a session. Ingest strips every block between these markers (and, for an
 * unterminated block, everything after the opening marker in that text block).
 */
export const INJECTED_MEMORY_OPEN = "<flow-agents-injected-memory>";
export const INJECTED_MEMORY_CLOSE = "</flow-agents-injected-memory>";

/** Harness-injected tags removed (with their content) from user/assistant text. */
export const HARNESS_TAGS = Object.freeze([
  // Claude Code
  "system-reminder",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "task-notification",
  "user-prompt-submit-hook",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  // Codex
  "environment_context",
  "user_instructions",
  "turn_aborted",
  "user_shell_command",
]);

export class TranscriptFormatError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "TranscriptFormatError";
    this.reason = reason;
  }
}

function drift(message) {
  return new TranscriptFormatError("UNKNOWN_TRANSCRIPT_FORMAT", message);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TAG_BLOCKS = HARNESS_TAGS.map(
  (tag) => new RegExp(`<${escapeRegExp(tag)}(?:\\s[^>]*)?>[\\s\\S]*?</${escapeRegExp(tag)}>`, "g"),
);
const MEMORY_BLOCK = new RegExp(
  `${escapeRegExp(INJECTED_MEMORY_OPEN)}[\\s\\S]*?(?:${escapeRegExp(INJECTED_MEMORY_CLOSE)}|$)`,
  "g",
);

/** Remove injected memory and harness tag blocks; returns trimmed text. */
export function stripInjectedContent(text) {
  let out = String(text).replace(MEMORY_BLOCK, "");
  for (const pattern of TAG_BLOCKS) out = out.replace(pattern, "");
  return out.trim();
}

/**
 * Split a Buffer into parsed JSON objects for each newline-terminated line.
 * A trailing line with no newline is ignored (write in progress).
 */
export function parseCompleteJsonLines(buffer) {
  const records = [];
  let position = 0;
  let lineNumber = 0;
  while (position < buffer.length) {
    const newline = buffer.indexOf(0x0a, position);
    if (newline === -1) break;
    const raw = buffer.subarray(position, newline).toString("utf8").replace(/\r$/, "");
    position = newline + 1;
    lineNumber += 1;
    if (raw.trim() === "") continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new TranscriptFormatError("TRANSCRIPT_MALFORMED", `line ${lineNumber} is not valid JSON`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw drift(`line ${lineNumber} is not a JSON object`);
    }
    records.push(value);
  }
  return records;
}

function parseTimestamp(value, where) {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw drift(`${where} has no readable timestamp`);
  return ms;
}

function textParts(content, textType, where) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) throw drift(`${where} content is neither a string nor an array`);
  const texts = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || typeof part.type !== "string") {
      throw drift(`${where} has a content part without a type`);
    }
    if (part.type !== textType) continue;
    if (typeof part.text !== "string") throw drift(`${where} ${textType} part has no text`);
    texts.push(part.text);
  }
  return texts;
}

/**
 * Claude Code project JSONL (`~/.claude/projects/<project>/<session>.jsonl`).
 * @returns {{ sessionId: string, turns: Array<{role, text, timestampMs, cwd, gitBranch}> }}
 */
export function parseClaudeProjectTranscript(records) {
  let sessionId = null;
  const turns = [];
  records.forEach((record, index) => {
    if (record.type !== "user" && record.type !== "assistant") return;
    const where = `record ${index + 1} (${record.type})`;
    if (typeof record.sessionId !== "string" || record.sessionId === "") {
      throw drift(`${where} has no sessionId`);
    }
    sessionId = sessionId || record.sessionId;
    const message = record.message;
    if (!message || typeof message !== "object" || message.role !== record.type) {
      throw drift(`${where} has no message with a matching role`);
    }
    const timestampMs = parseTimestamp(record.timestamp, where);
    // Sidechains are subagent conversations; meta, compact summaries and
    // transcript-only entries are harness-authored; a non-null `origin` marks a
    // harness-originated user entry (e.g. a task notification).
    if (record.isSidechain === true || record.isMeta === true) return;
    if (record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true) return;
    if (record.origin !== undefined && record.origin !== null) return;
    const text = stripInjectedContent(textParts(message.content, "text", where).join("\n\n"));
    if (!text) return;
    turns.push({
      role: record.type,
      text,
      timestampMs,
      cwd: typeof record.cwd === "string" ? record.cwd : null,
      gitBranch: typeof record.gitBranch === "string" && record.gitBranch ? record.gitBranch : null,
    });
  });
  if (records.length > 0 && !records.some((r) => typeof r.sessionId === "string")) {
    throw drift("no record carries a Claude Code sessionId");
  }
  if (!sessionId) {
    sessionId = records.find((r) => typeof r.sessionId === "string")?.sessionId ?? null;
  }
  return { sessionId, sidechain: false, turns };
}

/**
 * Codex rollout JSONL (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 * The first record must be `session_meta`. Subagent rollouts are sidechains.
 */
export function parseCodexRollout(records) {
  const first = records[0];
  if (!first || first.type !== "session_meta" || !first.payload || typeof first.payload !== "object") {
    throw drift("first record is not a Codex session_meta");
  }
  const meta = first.payload;
  if (typeof meta.id !== "string" || meta.id === "") throw drift("session_meta has no id");
  const sidechain =
    meta.thread_source === "subagent" ||
    (meta.source !== null && typeof meta.source === "object" && "subagent" in meta.source);
  const cwd = typeof meta.cwd === "string" ? meta.cwd : null;
  const gitBranch = meta.git && typeof meta.git.branch === "string" && meta.git.branch ? meta.git.branch : null;
  const turns = [];
  if (sidechain) return { sessionId: meta.id, sidechain, turns };
  records.forEach((record, index) => {
    if (record.type !== "response_item") return;
    const payload = record.payload;
    if (!payload || typeof payload !== "object") throw drift(`record ${index + 1} response_item has no payload`);
    if (payload.type !== "message") return;
    if (payload.role !== "user" && payload.role !== "assistant") return;
    const where = `record ${index + 1} (${payload.role} message)`;
    const timestampMs = parseTimestamp(record.timestamp, where);
    if (!Array.isArray(payload.content)) throw drift(`${where} content is not an array`);
    const textType = payload.role === "user" ? "input_text" : "output_text";
    const text = stripInjectedContent(textParts(payload.content, textType, where).join("\n\n"));
    if (!text) return;
    turns.push({ role: payload.role, text, timestampMs, cwd, gitBranch });
  });
  return { sessionId: meta.id, sidechain, turns };
}

/**
 * Split ordered turns into sittings: a new sitting starts when the gap since
 * the previous kept turn exceeds `idleGapMs`. Consecutive same-role turns in a
 * sitting are merged (Claude writes one record per content block).
 */
export function splitSittings(turns, idleGapMs) {
  const sittings = [];
  let current = null;
  let previousMs = null;
  for (const turn of turns) {
    if (!current || turn.timestampMs - previousMs > idleGapMs) {
      current = { turns: [] };
      sittings.push(current);
    }
    previousMs = turn.timestampMs;
    const last = current.turns[current.turns.length - 1];
    if (last && last.role === turn.role) {
      last.text = `${last.text}\n\n${turn.text}`;
      last.endMs = turn.timestampMs;
      continue;
    }
    current.turns.push({ ...turn, endMs: turn.timestampMs });
  }
  return sittings;
}
