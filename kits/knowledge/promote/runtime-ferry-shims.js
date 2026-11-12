/**
 * TEMPORARY shims for facts Ferry/Thread do not yet put on the canonical Thread.
 *
 * Transcript parsing is `@kontourai/ferry`'s job (see runtime-transcript.js).
 * Each function below exists only because a specific Thread capability is
 * missing, links the upstream issue, and should be DELETED when that issue
 * ships. Each reads record-level flags from ONE raw line, never message
 * content, and never interprets timestamps beyond "is a source time present".
 * The caller removes flagged lines before Ferry imports the rest, so there is
 * no join on ids, text or time to get wrong.
 *
 * Thread 0.7 / Ferry 0.8 shipped most of #76 and #78: user messages carry
 * `origin.kind` (compact summaries read as `compaction`), Codex `developer`
 * items import as `system` messages, and runtime-transcript.js keeps only
 * `human` user messages, counting the rest by kind. So the #76 shim now removes
 * only transcript-only entries, which the Thread does not mark, and the #78
 * shim's `developerMessage` removal is redundant (a `system` message is never a
 * user turn) and kept until the shims are retired together.
 *
 * `unrecognizedConversation` is not a Ferry gap: it is the drift sentinel for a
 * record that looks like a conversation turn but that Ferry will not import.
 *
 *   - kontourai/thread#76  Claude Code `isVisibleInTranscriptOnly` is dropped
 *                          (`origin.kind` and `isCompactSummary` shipped in Thread 0.7).
 *   - kontourai/thread#77  Codex `session_meta` `git.branch` and the subagent
 *                          marker (`source.subagent`, `thread_source`) are dropped.
 *   - kontourai/thread#78  Shipped in Thread 0.7: Codex `developer` items import as
 *                          `system`, and harness-injected context carries `origin`.
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

// Claude records that carry a `message.role` but are raw API payloads, not
// conversation (17k+ in a local corpus). A new such type reads as drift until added.
const CLAUDE_NON_CONVERSATION_TYPES = new Set(["api-request-blob"]);

const CLAUDE_FLAG_PRECHECK = /"isVisibleInTranscriptOnly"/;

/**
 * Facts about one raw Claude Code line.
 *  - `harnessEntry` (thread#76): a transcript-only `user` record
 *    (`isVisibleInTranscriptOnly`), which the Thread does not mark. Records the
 *    Thread does mark (a non-human `origin`, a compact summary) are left for
 *    Ferry to import, so the user-turn filter in runtime-transcript.js drops
 *    them and counts them by kind.
 *  - `missingTime` (thread#79): a user/assistant record with no source time.
 *  - `unrecognizedConversation`: a record with a user/assistant `message.role`
 *    whose `type` is neither of those nor a known non-conversation type.
 * @param {string} line
 * @returns {{ harnessEntry: boolean, missingTime: boolean, unrecognizedConversation: boolean }}
 */
export function claudeLineFacts(line) {
  const facts = { harnessEntry: false, missingTime: false, unrecognizedConversation: false };
  const record = parseObject(line);
  if (!record) return facts;
  const conversation = record.type === "user" || record.type === "assistant";
  // Ferry skips `isMeta` and (by default) `isSidechain` records, so their time does not matter.
  const importedByFerry = conversation && record.isMeta !== true && record.isSidechain !== true;
  if (importedByFerry && !hasSourceTime(record.timestamp)) facts.missingTime = true;
  const role = record.message && typeof record.message === "object" ? record.message.role : undefined;
  if ((role === "user" || role === "assistant") && !conversation && !CLAUDE_NON_CONVERSATION_TYPES.has(record.type)) {
    facts.unrecognizedConversation = true;
  }
  // Removing a line changes which record Ferry sees first, and Ferry decides that a transcript is a subagent's own
  // from its first record (a sidechain record carrying `agentId`). Every record of a subagent transcript is such a
  // record, so removing the first leaves another to mark it; if none is left, Ferry skips sidechain records and the
  // transcript reads as empty (NO_CONVERSATION). Either way no subagent text reaches a sitting.
  if (record.type === "user" && CLAUDE_FLAG_PRECHECK.test(line)) facts.harnessEntry = record.isVisibleInTranscriptOnly === true;
  return facts;
}

/**
 * Facts about one raw Codex line.
 *  - `developerMessage` (thread#78): a `message` item with `role: "developer"`,
 *    which Ferry imports as a `user` message.
 *  - `missingTime` (thread#79): a record Ferry imports (every `response_item`,
 *    and the `agent_message` / `agent_reasoning` events) with no source time.
 *    Other events (`token_count`, `task_complete`, ...) are not imported, so
 *    their time does not matter.
 *  - `unrecognizedConversation`: a record with a user/assistant `payload.role`
 *    whose `type` is not `response_item`.
 * @param {string} line
 * @returns {{ developerMessage: boolean, missingTime: boolean, unrecognizedConversation: boolean }}
 */
export function codexLineFacts(line) {
  const facts = { developerMessage: false, missingTime: false, unrecognizedConversation: false };
  const record = parseObject(line);
  if (!record) return facts;
  const payloadType = record.payload && typeof record.payload === "object" ? record.payload.type : undefined;
  const imported =
    record.type === "response_item" ||
    (record.type === "event_msg" && (payloadType === "agent_message" || payloadType === "agent_reasoning"));
  if (imported && !hasSourceTime(record.timestamp)) facts.missingTime = true;
  const role = record.payload && typeof record.payload === "object" ? record.payload.role : undefined;
  if ((role === "user" || role === "assistant") && record.type !== "response_item") facts.unrecognizedConversation = true;
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
