/**
 * TEMPORARY shims for facts Ferry/Thread do not yet put on the canonical Thread.
 *
 * Transcript parsing is `@kontourai/ferry`'s job (see runtime-transcript.js).
 * Each function below exists only because a specific Thread capability is
 * missing, links the upstream issue, and should be DELETED when that issue
 * ships. Every shim reads ONE record-level fact from ONE raw line, never
 * message content, and never interprets timestamps beyond "is a source time
 * present". The caller removes flagged lines before Ferry imports the rest,
 * so there is no join on ids, text or time to get wrong.
 *
 *   - kontourai/thread#76  Claude Code `origin.kind`, `isCompactSummary` and
 *                          `isVisibleInTranscriptOnly` are dropped.
 *   - kontourai/thread#77  Codex `session_meta` `git.branch` and the subagent
 *                          marker (`source.subagent`, `thread_source`) are dropped.
 *   - kontourai/thread#78  Codex `developer`-role items are imported as `user`
 *                          messages, and harness-injected context carries no marker.
 *   - kontourai/thread#79  A record with no source timestamp is stamped with
 *                          `Date.now()`, so identical input imports differently.
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

// kontourai/thread#79 — the forms Ferry accepts as a source time (a positive
// epoch-ms number or a parseable date string); anything else gets Date.now().
function hasSourceTime(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string") return Date.parse(value) > 0;
  return false;
}

const CLAUDE_FLAG_PRECHECK = /"origin"|"isCompactSummary"|"isVisibleInTranscriptOnly"/;

/**
 * Facts about one raw Claude Code line.
 *  - `harnessEntry` (thread#76): a `user` record the harness, not the human,
 *    wrote: a compact summary, a transcript-only entry, or an `origin` whose
 *    `kind` is anything but `human` (observed: `task-notification`, `peer`,
 *    `auto-continuation`). A record with no `origin` is an ordinary prompt.
 *  - `missingTime` (thread#79): a user/assistant record with no source time.
 * @param {string} line
 * @returns {{ harnessEntry: boolean, missingTime: boolean }}
 */
export function claudeLineFacts(line) {
  const facts = { harnessEntry: false, missingTime: false };
  const record = parseObject(line);
  if (!record) return facts;
  const conversation = record.type === "user" || record.type === "assistant";
  if (conversation && !hasSourceTime(record.timestamp)) facts.missingTime = true;
  if (record.type === "user" && CLAUDE_FLAG_PRECHECK.test(line)) {
    const origin = record.origin;
    const nonHumanOrigin =
      origin !== undefined && origin !== null && !(typeof origin === "object" && origin.kind === "human");
    facts.harnessEntry =
      nonHumanOrigin || record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true;
  }
  return facts;
}

/**
 * Facts about one raw Codex line.
 *  - `developerMessage` (thread#78): a `message` item with `role: "developer"`,
 *    which Ferry imports as a `user` message.
 *  - `missingTime` (thread#79): a conversation record with no source time.
 * @param {string} line
 * @returns {{ developerMessage: boolean, missingTime: boolean }}
 */
export function codexLineFacts(line) {
  const facts = { developerMessage: false, missingTime: false };
  const record = parseObject(line);
  if (!record) return facts;
  if ((record.type === "response_item" || record.type === "event_msg") && !hasSourceTime(record.timestamp)) {
    facts.missingTime = true;
  }
  facts.developerMessage =
    record.type === "response_item" && record.payload?.type === "message" && record.payload.role === "developer";
  return facts;
}

/**
 * `session_meta` of a Codex rollout (its first record), or null when the first
 * record is not a readable `session_meta` with an id. (thread#77)
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
