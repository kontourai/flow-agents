/**
 * TEMPORARY shims for facts Ferry/Thread do not yet put on the canonical Thread.
 *
 * Transcript parsing is `@kontourai/ferry`'s job (see runtime-transcript.js).
 * Each function below exists only because a specific Thread capability is
 * missing, links the upstream issue, and should be DELETED when that issue
 * ships (the call site then reads the Thread field instead). They read only
 * the single record-level fact named, never message content, and they
 * correlate to Ferry's output by message id or by timestamp and exact part text.
 *
 *   - kontourai/thread#76  Claude Code `origin.kind`, `isCompactSummary` and
 *                          `isVisibleInTranscriptOnly` are dropped.
 *   - kontourai/thread#77  Codex `session_meta` `git.branch` and the subagent
 *                          marker (`source.subagent`, `thread_source`) are dropped.
 *   - kontourai/thread#78  Codex `developer`-role items are imported as `user`
 *                          messages, and harness-injected context carries no marker.
 *
 * @module promote/runtime-ferry-shims
 */

function parseObject(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// kontourai/thread#76 — Claude Code record-level harness flags.
// ---------------------------------------------------------------------------

const CLAUDE_FLAG_PRECHECK = /"origin"|"isCompactSummary"|"isVisibleInTranscriptOnly"/;

/**
 * uuids of Claude Code `user` records that the harness, not the human, wrote:
 * a compact summary, a transcript-only entry, or an `origin` whose `kind` is
 * anything but `human` (observed: `task-notification`, `peer`,
 * `auto-continuation`). A record with no `origin` is an ordinary prompt.
 * Ferry keeps a user record's uuid as its message id.
 * @param {string[]} lines
 * @returns {Set<string>}
 */
export function claudeHarnessEntryIds(lines) {
  const ids = new Set();
  for (const line of lines) {
    if (!CLAUDE_FLAG_PRECHECK.test(line)) continue;
    const record = parseObject(line);
    if (!record || record.type !== "user" || typeof record.uuid !== "string") continue;
    const origin = record.origin;
    const nonHumanOrigin =
      origin !== undefined && origin !== null && !(typeof origin === "object" && origin.kind === "human");
    if (nonHumanOrigin || record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true) {
      ids.add(record.uuid);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// kontourai/thread#77 — Codex session_meta branch and subagent marker.
// ---------------------------------------------------------------------------

/**
 * `session_meta` of a Codex rollout (its first record), or null when the first
 * record is not a readable `session_meta` with an id.
 * @param {string[]} lines
 * @returns {{ id: string, sidechain: boolean, gitBranch: string | null } | null}
 */
export function codexSessionMeta(lines) {
  const first = lines.find((line) => line.trim() !== "");
  const record = first === undefined ? null : parseObject(first);
  const meta = record?.type === "session_meta" ? record.payload : null;
  if (!meta || typeof meta !== "object" || typeof meta.id !== "string" || meta.id === "") return null;
  const sidechain =
    meta.thread_source === "subagent" ||
    (meta.source !== null && typeof meta.source === "object" && "subagent" in meta.source);
  const gitBranch = meta.git && typeof meta.git.branch === "string" && meta.git.branch ? meta.git.branch : null;
  return { id: meta.id, sidechain, gitBranch };
}

// ---------------------------------------------------------------------------
// kontourai/thread#78 — Codex developer-role items arrive as `user` messages.
// ---------------------------------------------------------------------------

/** Key a text part by its record timestamp and exact text. */
export function partKey(timestampMs, text) {
  return `${timestampMs}\u0000${text}`;
}

/**
 * Keys of every text part Codex recorded with `role: "developer"`, so the
 * caller can drop the `user` messages Ferry made out of them.
 * @param {string[]} lines
 * @returns {Set<string>}
 */
export function codexDeveloperPartKeys(lines) {
  const keys = new Set();
  for (const line of lines) {
    if (!line.includes('"developer"')) continue;
    const record = parseObject(line);
    const payload = record?.payload;
    if (record?.type !== "response_item" || payload?.type !== "message" || payload.role !== "developer") continue;
    const at = Date.parse(record.timestamp);
    if (!Array.isArray(payload.content) || !Number.isFinite(at)) continue;
    for (const part of payload.content) {
      if (part && typeof part.text === "string") keys.add(partKey(at, part.text));
    }
  }
  return keys;
}
