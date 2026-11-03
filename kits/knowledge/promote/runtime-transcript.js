/**
 * Runtime transcript reading for the `runtime-session` residue source (#669).
 *
 * Parsing is `@kontourai/ferry`'s: its Claude Code and Codex importers turn a
 * runtime transcript into a canonical `@kontourai/thread` Thread. This module
 * only works over those canonical messages: it keeps user and assistant TEXT,
 * drops harness-injected tags and any block wrapped in the injected-memory
 * marker, and splits the result into sittings.
 *
 * Ferry already drops tool results/calls (separate `tool` messages and
 * non-text parts), thinking, Claude `isMeta` entries and Claude sidechains.
 * What it does not yet expose is handled by the marked shims in
 * runtime-ferry-shims.js (kontourai/thread#76, #77, #78) and by the tag list
 * below (#78).
 *
 * Drift: a transcript that is not the format its telemetry runtime claims, or
 * one that Ferry reports skipping records from, throws `TranscriptFormatError`.
 * The caller reports it and holds its cursor. Only newline-terminated lines are
 * read: a trailing partial line is a write in progress and is left for the next
 * run.
 *
 * @module promote/runtime-transcript
 */

import { createClaudeCodeImporter, createCodexImporter, detectFormat } from "@kontourai/ferry";

import { claudeHarnessEntryIds, codexDeveloperPartKeys, codexSessionMeta, partKey } from "./runtime-ferry-shims.js";

/**
 * Wrapper the injection slice (#672) must place around any memory it injects
 * into a session. Ingest strips every block between these markers (and, for an
 * unterminated block, everything after the opening marker in that text block).
 */
export const INJECTED_MEMORY_OPEN = "<flow-agents-injected-memory>";
export const INJECTED_MEMORY_CLOSE = "</flow-agents-injected-memory>";

/**
 * Harness-injected tags removed (with their content) from user/assistant text.
 * Names observed in real transcripts. SHIM until kontourai/thread#78 marks
 * harness-injected messages on the Thread.
 */
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
  "codex_internal_context",
  "subagent_notification",
  "user_instructions",
  "INSTRUCTIONS",
  "turn_aborted",
  "user_shell_command",
]);

// Codex's AGENTS.md message: a one-line header followed by an <INSTRUCTIONS> block.
const AGENTS_HEADER = /^# AGENTS\.md instructions for [^\n]*\n?/;

// Ferry's thread id when a Claude Code transcript carries no sessionId.
const FERRY_CLAUDE_FALLBACK_ID = "claude-code-session";
const FERRY_EMPTY_THREAD = /no (?:importable messages|Claude Code conversation events)/i;

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
  return out.replace(AGENTS_HEADER, "").trim();
}

/**
 * Newline-terminated lines of a transcript. A trailing line with no newline is
 * a write in progress and is ignored. This splits; it does not parse.
 * @param {Buffer} buffer
 * @returns {string[]}
 */
export function completeLines(buffer) {
  const text = buffer.toString("utf8");
  const end = text.lastIndexOf("\n");
  if (end === -1) return [];
  return text
    .slice(0, end)
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");
}

/** Run a Ferry incremental importer over complete lines; any Ferry warning is drift. */
function importThread(createImporter, lines) {
  const warnings = [];
  const importer = createImporter({ onWarn: (message) => warnings.push(message) });
  importer.pushLines(lines);
  importer.finalize();
  let thread = null;
  try {
    thread = importer.thread();
  } catch (error) {
    if (!(error instanceof Error) || !FERRY_EMPTY_THREAD.test(error.message)) throw error;
  }
  // Ferry's warnings name the format already ("claude-code: skipped 1 …").
  if (warnings.length > 0) throw drift(warnings.join("; "));
  return thread;
}

/** User/assistant text parts of one canonical message that survive `dropPart`. */
function messageText(message, dropPart) {
  if (!Array.isArray(message.content)) return "";
  const texts = [];
  for (const part of message.content) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    if (dropPart(part.text, message)) continue;
    texts.push(part.text);
  }
  return stripInjectedContent(texts.join("\n\n"));
}

function conversationFromThread(thread, dropMessage, dropPart) {
  const messages = [];
  for (const message of thread.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.metadata?.sidechain === true || dropMessage(message)) continue;
    const text = messageText(message, dropPart);
    if (text) messages.push({ role: message.role, text, timestampMs: message.timestamp });
  }
  return messages;
}

/**
 * Read a runtime transcript into canonical conversation messages.
 *
 * @param {"claude-code" | "codex"} harness  the runtime telemetry says wrote it
 * @param {Buffer} content  the whole transcript file
 * @returns {{ sessionId: string | null, sidechain: boolean, cwd: string | null,
 *   gitBranch: string | null, messages: Array<{role: "user"|"assistant", text: string, timestampMs: number}> }}
 * @throws {TranscriptFormatError} when the transcript is not readable as `harness`
 */
export function readConversation(harness, content) {
  const lines = completeLines(content);
  const empty = { sessionId: null, sidechain: false, cwd: null, gitBranch: null, messages: [] };
  if (lines.length === 0) return empty;

  const detected = detectFormat(lines.slice(0, 200).join("\n"));
  if (detected !== harness) {
    throw drift(`telemetry says ${harness} but the transcript reads as ${detected ?? "an unrecognized format"}`);
  }

  if (harness === "claude-code") {
    const thread = importThread(createClaudeCodeImporter, lines);
    if (!thread) return empty;
    if (thread.id === FERRY_CLAUDE_FALLBACK_ID) throw drift("claude-code: no record carries a sessionId");
    const harnessEntries = claudeHarnessEntryIds(lines);
    return {
      sessionId: thread.id,
      sidechain: false,
      cwd: thread.metadata?.cwd ?? null,
      gitBranch: thread.metadata?.git?.branch ?? null,
      messages: conversationFromThread(thread, (message) => harnessEntries.has(message.id), () => false),
    };
  }

  const meta = codexSessionMeta(lines);
  if (!meta) throw drift("codex: first record is not a session_meta with an id");
  if (meta.sidechain) return { ...empty, sessionId: meta.id, sidechain: true };
  const thread = importThread(createCodexImporter, lines);
  if (!thread) return { ...empty, sessionId: meta.id, gitBranch: meta.gitBranch };
  const developerParts = codexDeveloperPartKeys(lines);
  return {
    sessionId: meta.id,
    sidechain: false,
    cwd: thread.metadata?.cwd ?? null,
    gitBranch: meta.gitBranch,
    messages: conversationFromThread(
      thread,
      () => false,
      (text, message) => developerParts.has(partKey(message.timestamp, text)),
    ),
  };
}

/**
 * Split ordered messages into sittings: a new sitting starts when the gap since
 * the previous kept message exceeds `idleGapMs`. Consecutive same-role messages
 * in a sitting are merged.
 */
export function splitSittings(messages, idleGapMs) {
  const sittings = [];
  let current = null;
  let previousMs = null;
  for (const message of messages) {
    if (!current || message.timestampMs - previousMs > idleGapMs) {
      current = { turns: [] };
      sittings.push(current);
    }
    previousMs = message.timestampMs;
    const last = current.turns[current.turns.length - 1];
    if (last && last.role === message.role) {
      last.text = `${last.text}\n\n${message.text}`;
      last.endMs = message.timestampMs;
      continue;
    }
    current.turns.push({ ...message, endMs: message.timestampMs });
  }
  return sittings;
}
