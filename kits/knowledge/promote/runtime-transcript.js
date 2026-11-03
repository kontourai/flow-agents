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
 * Drift: a transcript that is not the format its telemetry runtime claims, is
 * not valid UTF-8, has no UUID session id, has a conversation record with no
 * source timestamp, or that Ferry reports skipping records from, throws
 * `TranscriptFormatError`. The caller reports it and holds its cursor. Only
 * newline-terminated lines are read: a trailing partial line is a write in
 * progress; `readConversation` reports it as `partialTail` so the caller holds
 * the cursor until the line is complete.
 *
 * @module promote/runtime-transcript
 */

import { createClaudeCodeImporter, createCodexImporter, detectFormat } from "@kontourai/ferry";

import { INJECTED_MEMORY_CLOSE, INJECTED_MEMORY_OPEN } from "../memory-marker.js";
import { claudeLineFacts, codexLineFacts, codexSessionMeta } from "./runtime-ferry-shims.js";

// The marker lives in a dependency-free module so #672's hook path can import
// it without this file's Ferry import; re-exported here for existing callers.
export { INJECTED_MEMORY_OPEN, INJECTED_MEMORY_CLOSE };

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
// What Ferry throws for a transcript with no conversation in it (both adapters).
const FERRY_EMPTY_THREAD = /no (?:Codex )?importable (?:messages|items)|no Claude Code conversation events/i;
// Real Claude Code and Codex session ids are UUIDs. Anything else is drift, so a
// transcript can never put free text (or a secret) into sitting ids and cursor keys.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Remove balanced `open … close` blocks from `input` with a depth counter, so
 * nesting cannot end a block early. `tokens` is a global regex matching either
 * token; `isOpen(match)` tells them apart. Fails closed: a block with no close
 * runs to the end of the input. A close with no open drops only the token,
 * unless `strayCloseWipesHead` (the text before it was inside a block whose
 * open was lost). Returns the kept text and the depth still open at the end.
 */
function removeBlocks(input, tokens, isOpen, depth, strayCloseWipesHead) {
  let out = "";
  let position = 0;
  for (const match of input.matchAll(tokens)) {
    if (depth === 0) {
      if (isOpen(match)) {
        out += input.slice(position, match.index);
        depth = 1;
      } else {
        out = strayCloseWipesHead ? "" : out + input.slice(position, match.index);
      }
    } else {
      depth += isOpen(match) ? 1 : -1;
    }
    position = match.index + match[0].length;
  }
  if (depth === 0) out += input.slice(position);
  return { out, depth };
}

const MEMORY_MARKERS = new RegExp(`${escapeRegExp(INJECTED_MEMORY_OPEN)}|${escapeRegExp(INJECTED_MEMORY_CLOSE)}`, "g");

// Attribute values may contain `>` inside quotes.
const TAG_TOKENS = HARNESS_TAGS.map((tag) => {
  const name = escapeRegExp(tag);
  return new RegExp(`(<${name}(?:\\s(?:[^>"']|"[^"]*"|'[^']*')*)?>)|(</${name}\\s*>)`, "gi");
});

/**
 * Injected-memory filter with state, so a block opened in one text part or
 * message and closed in a later one is removed whole. Blocks nest, an
 * unterminated block hides everything after it (until a later close), and a
 * close with no open removes what came before it. Cost of failing closed: an
 * unterminated marker the model merely quotes also hides what follows it;
 * injection (#672) always writes a closed pair. A marker spelled across two
 * text parts is not recognised: no writer splits a token.
 */
export function createInjectedMemoryFilter() {
  let depth = 0;
  return (text) => {
    const result = removeBlocks(String(text), MEMORY_MARKERS, (m) => m[0] === INJECTED_MEMORY_OPEN, depth, true);
    depth = result.depth;
    return result.out;
  };
}

function stripHarnessTags(text) {
  let out = text;
  for (const tokens of TAG_TOKENS) out = removeBlocks(out, tokens, (m) => m[1] !== undefined, 0, false).out;
  return out.replace(AGENTS_HEADER, "").trim();
}

/** Remove injected memory and harness tag blocks from one string; returns trimmed text. */
export function stripInjectedContent(text) {
  return stripHarnessTags(createInjectedMemoryFilter()(text));
}

/**
 * Split a transcript into newline-terminated lines. The bytes after the last
 * newline are a write in progress: they are not decoded and are reported as
 * `partialTail`, never silently dropped.
 * @param {Buffer} buffer
 * @returns {{ lines: string[], partialTail: boolean }}
 * @throws {TranscriptFormatError} when the complete lines are not valid UTF-8
 */
export function completeLines(buffer) {
  const end = buffer.lastIndexOf(0x0a);
  const tail = buffer.subarray(end + 1);
  const partialTail = tail.some((byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0d);
  if (end === -1) return { lines: [], partialTail };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
  } catch {
    throw drift("transcript is not valid UTF-8");
  }
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");
  return { lines, partialTail };
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

/** User/assistant text of one canonical message, with injected content removed. */
function messageText(message, memoryFilter) {
  if (!Array.isArray(message.content)) return "";
  const texts = [];
  for (const part of message.content) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    texts.push(stripHarnessTags(memoryFilter(part.text)));
  }
  return texts.filter((t) => t !== "").join("\n\n");
}

function conversationFromThread(thread) {
  const memoryFilter = createInjectedMemoryFilter();
  const messages = [];
  for (const message of thread.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.metadata?.sidechain === true) continue;
    const text = messageText(message, memoryFilter);
    if (text) messages.push({ role: message.role, text, timestampMs: message.timestamp });
  }
  return messages;
}

function requireSessionId(id) {
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw drift("session id is not a UUID");
  return id;
}

/**
 * Read a runtime transcript into canonical conversation messages.
 *
 * @param {"claude-code" | "codex"} harness  the runtime telemetry says wrote it
 * @param {Buffer} content  the whole transcript file
 * @returns {{ sessionId: string | null, sidechain: boolean, cwd: string | null,
 *   gitBranch: string | null, partialTail: boolean,
 *   messages: Array<{role: "user"|"assistant", text: string, timestampMs: number}> }}
 * @throws {TranscriptFormatError} when the transcript is not readable as `harness`
 */
export function readConversation(harness, content) {
  const { lines, partialTail } = completeLines(content);
  const empty = { sessionId: null, sidechain: false, cwd: null, gitBranch: null, partialTail, messages: [] };
  if (lines.length === 0) return empty;

  const detected = detectFormat(lines.slice(0, 200).join("\n"));
  if (detected !== harness) {
    throw drift(`telemetry says ${harness} but the transcript reads as ${detected ?? "an unrecognized format"}`);
  }

  if (harness === "claude-code") {
    const kept = [];
    for (const line of lines) {
      const facts = claudeLineFacts(line);
      if (facts.missingTime) throw drift("claude-code: a conversation record has no source timestamp");
      if (!facts.harnessEntry) kept.push(line);
    }
    const thread = importThread(createClaudeCodeImporter, kept);
    if (!thread) return empty;
    if (thread.id === FERRY_CLAUDE_FALLBACK_ID) throw drift("claude-code: no record carries a sessionId");
    return {
      sessionId: requireSessionId(thread.id),
      sidechain: false,
      cwd: thread.metadata?.cwd ?? null,
      gitBranch: thread.metadata?.git?.branch ?? null,
      partialTail,
      messages: conversationFromThread(thread),
    };
  }

  const meta = codexSessionMeta(lines);
  if (!meta) throw drift("codex: first record is not a session_meta with an id");
  const sessionId = requireSessionId(meta.id);
  if (meta.sidechain) return { ...empty, sessionId, sidechain: true };
  const kept = [];
  for (const line of lines) {
    const facts = codexLineFacts(line);
    if (facts.missingTime) throw drift("codex: a conversation record has no source timestamp");
    if (!facts.developerMessage) kept.push(line);
  }
  const thread = importThread(createCodexImporter, kept);
  if (!thread) return { ...empty, sessionId, gitBranch: meta.gitBranch };
  return {
    sessionId,
    sidechain: false,
    cwd: thread.metadata?.cwd ?? null,
    gitBranch: meta.gitBranch,
    partialTail,
    messages: conversationFromThread(thread),
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
