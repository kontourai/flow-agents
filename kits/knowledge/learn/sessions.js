/**
 * Read a developer's existing coding-agent transcripts for the correction-recurrence
 * learning source. Zero setup: no Flow run, no telemetry file, no kit adoption. The
 * transcripts are found under the harnesses' own default directories (or the roots
 * the caller names) and read through the Knowledge kit's runtime-session reader
 * (`readRuntimeMessages`: Ferry's importer, the same drift checks and harness-tag
 * stripping the dream's residue path uses).
 *
 * Only a user message whose Thread `origin.kind` is `"human"` is kept (`humanTurns`).
 * Agent briefs, harness and hook injections, compaction summaries, task notifications,
 * `unknown`, and messages with no origin at all never count: an orchestrator repeating
 * its own rules to a delegate must not read as a person correcting an agent.
 *
 * Every kept string is scrubbed (`scrubResidueText`) here, before anything else sees it,
 * so no later stage (the model, the ledger) can receive unscrubbed transcript text.
 *
 * @module learn/sessions
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { detectFormat } from "@kontourai/ferry";

import { scrubResidueText } from "../promote/runtime-redaction.js";
import { TranscriptFormatError, completeLines, readRuntimeMessages } from "../promote/runtime-transcript.js";
import { truncateUtf8 } from "../dream/util.js";

export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
export const MAX_WALK_DEPTH = 8;
export const MAX_TURN_BYTES = 2000;
export const MAX_CONTEXT_BYTES = 400;
const SUPPORTED = new Set(["claude-code", "codex"]);

/** The harnesses' own transcript directories under `home`, those that exist. */
export function defaultTranscriptRoots(env = process.env) {
  const home = env.HOME || "";
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  return [path.join(claudeHome, "projects"), path.join(codexHome, "sessions")].filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * The one origin filter: a user message counts only when its importer says a person typed it, and it is not
 * wholly a harness envelope. Ferry marks `[Request interrupted by user]` (and a slash command's wrapper) as human
 * with an `origin.envelope`: a person caused it, but there is no sentence in it to learn from. Absent origin (an
 * importer that derives none) and `unknown` are not human.
 */
export function isHumanTurn(message) {
  return message?.role === "user" && message.origin?.kind === "human" && !message.origin.envelope && message.sidechain !== true;
}

/**
 * A turn the opt-in inference may look at: a user message whose importer looked and could not tell who wrote it
 * (`origin.kind === "unknown"`, typically a prompt submitted through an SDK or IDE host). Never an agent, harness,
 * hook, compaction or task-notification turn, never an absent origin, never an envelope, never a sidechain.
 */
export function isInferenceCandidate(message) {
  return message?.role === "user" && message.origin?.kind === "unknown" && !message.origin.envelope && message.sidechain !== true
    && !DELEGATED_CHANNEL.test(String(message.origin.evidence ?? ""));
}

/**
 * Codex sessions started by `codex exec` or through Codex's MCP server are, in practice, other programs and agents
 * delegating work: Ferry reports their prompts `unknown` (`codex:session_meta.source=exec|mcp`), but they are excluded
 * from inference rather than handed to the author classifier.
 */
export const DELEGATED_CHANNEL = /^codex:session_meta\.source=(exec|mcp)(?:,|$)/;

export function humanTurns(messages) {
  return messages.filter(isHumanTurn);
}

/** `*.jsonl` files under `root`, in sorted order, never following a symlink. */
export function listTranscripts(root) {
  const out = [];
  const visit = (dir, depth) => {
    let names;
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) visit(full, depth + 1);
      } else if (stat.isFile() && name.endsWith(".jsonl")) {
        out.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  visit(root, 0);
  return out;
}

function readBounded(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { skip: "NOT_REGULAR" };
    if (stat.size > MAX_TRANSCRIPT_BYTES) return { skip: "TOO_LARGE" };
    const content = fs.readFileSync(fd);
    if (content.length > MAX_TRANSCRIPT_BYTES) return { skip: "TOO_LARGE" };
    return { content };
  } finally {
    fs.closeSync(fd);
  }
}

function detectHarness(content) {
  const { lines } = completeLines(content);
  if (lines.length === 0) return null;
  const detected = detectFormat(lines.slice(0, 200).join("\n"));
  return SUPPORTED.has(detected) ? detected : null;
}

/** The last `bytes` UTF-8 bytes of `text`, without splitting a code point; a leading ellipsis when it cuts. */
export function tailUtf8(text, bytes) {
  const value = String(text);
  if (Buffer.byteLength(value) <= bytes) return value;
  const characters = [...value];
  let used = Buffer.byteLength("…");
  let start = characters.length;
  while (start > 0 && used + Buffer.byteLength(characters[start - 1]) <= bytes) {
    start -= 1;
    used += Buffer.byteLength(characters[start]);
  }
  return `…${characters.slice(start).join("")}`;
}

const bump = (counts, key, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

/**
 * Read every transcript under `roots` and return the human turns inside `[sinceMs, untilMs]`.
 *
 * Each turn carries its Thread locator (`threadId` = harness:sessionId, `messageId`), the scrubbed text, and the
 * scrubbed tail of the assistant message just before it (`context`), which the classifier needs to tell a correction
 * from a factual answer. A message copied into a second transcript (a resumed session) is counted once.
 *
 * `scope(cwd)` decides whether a session belongs to the repository being learned for (learn/scope.js); a session
 * outside it is counted in `sessions_out_of_scope` and contributes nothing. `scope: null` reads every project.
 *
 * `unknown`-origin turns (see `isInferenceCandidate`) are always counted (`unknown_turns_in_window`), and returned in
 * `unknownTurns`, with the same shape and scrub, only when `includeUnknown` is set. Nothing here decides they are human.
 *
 * @param {{ roots: string[], sinceMs?: number | null, untilMs?: number | null, scope?: ((cwd: string | null) => boolean) | null,
 *   includeUnknown?: boolean, readMessages?: typeof readRuntimeMessages }} options
 */
export function readHumanTurns({ roots, sinceMs = null, untilMs = null, scope = null, includeUnknown = false, readMessages = readRuntimeMessages }) {
  const report = {
    roots: roots.length,
    files_seen: 0,
    files_read: 0,
    files_skipped: {},
    sessions_read: 0,
    sessions_out_of_scope: 0,
    user_messages: 0,
    user_messages_by_origin: {},
    // Ferry's evidence string for each `unknown` origin (e.g. `claude-code:promptSource=sdk`): says which host
    // channel could not be attributed, never any message text.
    unknown_origin_by_evidence: {},
    human_turns_in_window: 0,
    human_turns_duplicate: 0,
    unknown_turns_in_window: 0,
    // User records the line shims removed before import (a raw origin that is not `{ kind: "human" }`, which Ferry 0.8
    // could otherwise derive as human). They are counted in `user_messages_by_origin` under the kind the shim names
    // (`unknown`), and are never candidates for anything: they have no text here.
    shim_dropped_user_turns: 0,
    // Shim-dropped records in a file with no importable conversation, which therefore has no session id or working
    // directory to scope by. Under repository scope they cannot be attributed to this repository, so they are counted
    // here only; under --all-projects they are counted like any other shim drop.
    shim_dropped_unattributed: 0,
  };
  const turns = [];
  const unknownTurns = [];
  const unknownSessions = new Set();
  const seen = new Set();
  const sessions = new Set();
  for (const root of roots) {
    for (const entry of listTranscripts(root)) {
      report.files_seen += 1;
      if (sinceMs !== null && entry.mtimeMs < sinceMs) {
        bump(report.files_skipped, "OLDER_THAN_WINDOW");
        continue;
      }
      let parsed;
      try {
        const read = readBounded(entry.file);
        if (read.skip) {
          bump(report.files_skipped, read.skip);
          continue;
        }
        const harness = detectHarness(read.content);
        if (!harness) {
          bump(report.files_skipped, "UNSUPPORTED_FORMAT");
          continue;
        }
        parsed = { harness, ...readMessages(harness, read.content) };
      } catch (error) {
        bump(report.files_skipped, error instanceof TranscriptFormatError ? "TRANSCRIPT_DRIFT" : "UNREADABLE");
        continue;
      }
      report.files_read += 1;
      const countShimDropped = () => {
        for (const [kind, count] of Object.entries(parsed.shimDropped ?? {})) {
          report.user_messages += count;
          report.shim_dropped_user_turns += count;
          bump(report.user_messages_by_origin, kind, count);
        }
      };
      if (!parsed.sessionId && !parsed.sidechain) {
        // Counted before the skip: a file whose every user record was removed before import is still a record of them.
        if (scope) report.shim_dropped_unattributed += Object.values(parsed.shimDropped ?? {}).reduce((a, b) => a + b, 0);
        else countShimDropped();
      }
      if (!parsed.sessionId || parsed.sidechain) {
        bump(report.files_skipped, parsed.sidechain ? "SIDECHAIN_TRANSCRIPT" : "NO_CONVERSATION");
        continue;
      }
      report.sessions_read += 1;
      if (scope && !scope(parsed.cwd)) {
        report.sessions_out_of_scope += 1;
        continue;
      }
      countShimDropped();
      const threadId = `${parsed.harness}:${parsed.sessionId}`;
      let lastAssistant = "";
      for (const message of parsed.messages) {
        if (message.role === "assistant") {
          if (message.text) lastAssistant = message.text;
          continue;
        }
        if (message.role !== "user") continue;
        report.user_messages += 1;
        bump(report.user_messages_by_origin, message.origin?.kind ?? "absent");
        if (message.origin?.kind === "unknown") bump(report.unknown_origin_by_evidence, typeof message.origin.evidence === "string" ? message.origin.evidence.slice(0, 80) : "unstated");
        const human = isHumanTurn(message);
        if ((!human && !isInferenceCandidate(message)) || !message.text) continue;
        if (sinceMs !== null && message.timestampMs < sinceMs) continue;
        if (untilMs !== null && message.timestampMs > untilMs) continue;
        if (!human) {
          report.unknown_turns_in_window += 1;
          if (!includeUnknown) continue;
        }
        const text = scrubResidueText(message.text);
        const key = `${parsed.harness}\u0000${message.timestampMs}\u0000${createHash("sha256").update(text).digest("hex")}`;
        if (seen.has(key)) {
          report.human_turns_duplicate += 1;
          continue;
        }
        seen.add(key);
        (human ? sessions : unknownSessions).add(threadId);
        (human ? turns : unknownTurns).push({
          key: `${threadId}#${message.id}`,
          threadId,
          harness: parsed.harness,
          sessionId: parsed.sessionId,
          messageId: message.id,
          atMs: message.timestampMs,
          at: new Date(message.timestampMs).toISOString(),
          text: truncateUtf8(text, MAX_TURN_BYTES),
          // Scrubbed whole, then cut: cutting first could split a secret so the scrub no longer recognises it.
          context: lastAssistant ? tailUtf8(scrubResidueText(lastAssistant), MAX_CONTEXT_BYTES) : "",
          authority: human ? "human" : "unknown",
        });
      }
    }
  }
  const order = (a, b) => a.atMs - b.atMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  turns.sort(order);
  unknownTurns.sort(order);
  report.human_turns_in_window = turns.length;
  report.human_sessions_in_window = sessions.size;
  report.unknown_sessions_in_window = unknownSessions.size;
  // Distinct sessions holding either: a session with both is one session, not two.
  report.human_or_unknown_sessions_in_window = new Set([...sessions, ...unknownSessions]).size;
  return { turns, unknownTurns, report };
}
