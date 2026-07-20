import * as fs from "node:fs";
import * as path from "node:path";

import {
  assertNoSymlinkAncestry,
  opaqueIdentifier,
  runtimeError,
  sameFile,
  sha256,
} from "./runtime-session-core.js";
import {
  formatToolPayload,
  scrubRuntimeResidueText,
} from "./runtime-session-redaction.js";

const CLAUDE_IGNORED_RECORD_TYPES = new Set([
  "file-history-snapshot",
  "progress",
  "queue-operation",
  "summary",
  "system",
]);
const CLAUDE_IGNORED_CONTENT_TYPES = new Set([
  "document",
  "image",
  "redacted_thinking",
  "thinking",
]);
const CODEX_IGNORED_RECORD_TYPES = new Set([
  "event_msg",
  "session_meta",
  "turn_context",
]);
const CODEX_IGNORED_PAYLOAD_TYPES = new Set(["reasoning"]);
const CODEX_IGNORED_CONTENT_TYPES = new Set(["input_image"]);

function resolveTranscriptAccess(transcriptPath, transcriptRoots) {
  if (!Array.isArray(transcriptRoots) || transcriptRoots.length === 0) {
    throw runtimeError(
      "TRANSCRIPT_ROOTS_REQUIRED",
      "runtime-session ingest requires at least one transcript root",
    );
  }
  try {
    const realCandidate = fs.realpathSync(transcriptPath);
    const realRoots = transcriptRoots.map((root) => fs.realpathSync(root));
    assertNoSymlinkAncestry(realCandidate);
    realRoots.forEach(assertNoSymlinkAncestry);
    if (!realRoots.some((root) =>
      realCandidate === root || realCandidate.startsWith(`${root}${path.sep}`))) {
      throw runtimeError(
        "TRANSCRIPT_OUTSIDE_ROOTS",
        "transcript is outside the allowed runtime roots",
      );
    }
    return realCandidate;
  } catch (error) {
    if (error?.code && String(error.code).startsWith("TRANSCRIPT_")) throw error;
    throw runtimeError("TRANSCRIPT_UNREADABLE", "transcript could not be resolved");
  }
}

export function readTranscriptSafely(transcriptPath, transcriptRoots, maxBytes) {
  const realCandidate = resolveTranscriptAccess(transcriptPath, transcriptRoots);
  let descriptor;
  try {
    descriptor = fs.openSync(
      realCandidate,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(descriptor);
    const pathStat = fs.statSync(realCandidate);
    if (!stat.isFile() || !sameFile(stat, pathStat)) {
      throw runtimeError("TRANSCRIPT_NOT_REGULAR", "transcript is not a regular file");
    }
    if (stat.size > maxBytes) {
      throw runtimeError("TRANSCRIPT_TOO_LARGE", "transcript exceeds the byte limit");
    }
    const content = fs.readFileSync(descriptor);
    if (content.length > maxBytes) {
      throw runtimeError("TRANSCRIPT_TOO_LARGE", "transcript exceeds the byte limit");
    }
    if (fs.realpathSync(transcriptPath) !== realCandidate) {
      throw runtimeError("TRANSCRIPT_CHANGED", "transcript changed while it was being read");
    }
    return content;
  } catch (error) {
    if (error?.code && String(error.code).startsWith("TRANSCRIPT_")) throw error;
    throw runtimeError("TRANSCRIPT_UNREADABLE", "transcript could not be read");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseJsonLines(content, maxLineBytes, maxRecords) {
  const records = [];
  let position = 0;
  let lineNumber = 0;
  while (position < content.length) {
    const newline = content.indexOf(0x0a, position);
    const end = newline === -1 ? content.length : newline;
    const rawBuffer = content.subarray(position, end);
    position = newline === -1 ? content.length : newline + 1;
    lineNumber += 1;
    if (rawBuffer.length === 0) continue;
    if (rawBuffer.length > maxLineBytes) {
      throw runtimeError(
        "TRANSCRIPT_LINE_TOO_LARGE",
        `transcript line ${lineNumber} exceeds the byte limit`,
      );
    }
    if (records.length >= maxRecords) {
      throw runtimeError("TRANSCRIPT_RECORD_LIMIT", "transcript exceeds the record limit");
    }
    const raw = rawBuffer.toString("utf8").replace(/\r$/, "");
    try {
      records.push(JSON.parse(raw));
    } catch {
      throw runtimeError(
        "TRANSCRIPT_MALFORMED",
        `transcript line ${lineNumber} is not valid JSON`,
      );
    }
  }
  return records;
}

function assertKnownContentParts(content, accepted, ignored) {
  if (typeof content === "string") return;
  if (!Array.isArray(content)) {
    throw runtimeError("UNKNOWN_TRANSCRIPT_FORMAT", "message content has an unsupported shape");
  }
  for (const part of content) {
    if (typeof part === "string") continue;
    const type = part && typeof part === "object" ? part.type : null;
    if (!accepted.has(type) && !ignored.has(type)) {
      throw runtimeError("UNKNOWN_TRANSCRIPT_FORMAT", "message content type is unsupported");
    }
  }
}

function textFromValidatedContent(content, textTypes) {
  if (typeof content === "string") return content;
  return content
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      if (!textTypes.has(part.type)) return [];
      if (typeof part.text !== "string") {
        throw runtimeError("UNKNOWN_TRANSCRIPT_FORMAT", "text content has an unsupported shape");
      }
      return [part.text];
    })
    .join("\n");
}

function claudeToolResultText(content) {
  const accepted = new Set(["text"]);
  assertKnownContentParts(content, accepted, CLAUDE_IGNORED_CONTENT_TYPES);
  return textFromValidatedContent(content, accepted);
}

function claudeEntries(records) {
  const entries = [];
  let recognized = false;
  for (const record of records) {
    if (record && CLAUDE_IGNORED_RECORD_TYPES.has(record.type)) continue;
    if (!record || !["user", "assistant"].includes(record.type)) {
      throw runtimeError("UNKNOWN_TRANSCRIPT_FORMAT", "Claude transcript record type is unsupported");
    }
    recognized = true;
    const role = record.type;
    const content = record.message?.content;
    assertKnownContentParts(
      content,
      new Set(["text", "tool_result", "tool_use"]),
      CLAUDE_IGNORED_CONTENT_TYPES,
    );
    const message = textFromValidatedContent(content, new Set(["text"]));
    if (message) entries.push({ kind: "message", role, text: message });
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "tool_use") {
        if (typeof part.name !== "string") {
          throw runtimeError("UNKNOWN_TRANSCRIPT_FORMAT", "Claude tool call has an unsupported shape");
        }
        entries.push({
          kind: "tool-call",
          role: "assistant",
          text: `${part.name} ${formatToolPayload(part.input)}`,
        });
      }
      if (part?.type === "tool_result") {
        const text = claudeToolResultText(part.content);
        if (text) entries.push({ kind: "tool-result", role: "tool", text });
      }
    }
  }
  return { recognized, entries };
}

function codexEntries(records) {
  const entries = [];
  let recognized = false;
  for (const record of records) {
    if (record && CODEX_IGNORED_RECORD_TYPES.has(record.type)) continue;
    if (record?.type !== "response_item" || !record.payload) {
      throw runtimeError("UNKNOWN_TRANSCRIPT_FORMAT", "Codex transcript record type is unsupported");
    }
    const payload = record.payload;
    if (CODEX_IGNORED_PAYLOAD_TYPES.has(payload.type)) continue;
    if (payload.type === "message") {
      recognized = true;
      const role = payload.role === "user" ? "user" : "assistant";
      const textTypes = new Set(["input_text", "output_text", "text"]);
      assertKnownContentParts(payload.content, textTypes, CODEX_IGNORED_CONTENT_TYPES);
      const text = textFromValidatedContent(payload.content, textTypes);
      if (text) entries.push({ kind: "message", role, text });
      continue;
    }
    if (payload.type === "function_call" && typeof payload.name === "string") {
      recognized = true;
      entries.push({
        kind: "tool-call",
        role: "assistant",
        text: `${payload.name} ${formatToolPayload(String(payload.arguments ?? ""))}`,
      });
      continue;
    }
    if (payload.type === "function_call_output" && typeof payload.output === "string") {
      recognized = true;
      entries.push({ kind: "tool-result", role: "tool", text: payload.output });
      continue;
    }
    throw runtimeError("UNKNOWN_TRANSCRIPT_FORMAT", "Codex response item type is unsupported");
  }
  return { recognized, entries };
}

function normalizeRuntime(value) {
  const runtime = String(value ?? "").toLowerCase();
  if (runtime === "claude" || runtime === "claude-code") return "claude-code";
  if (runtime === "codex" || runtime === "codex-cli") return "codex";
  return null;
}

function boundedEntries(entries, options) {
  if (entries.length > options.maxTranscriptEntries) {
    throw runtimeError("TRANSCRIPT_ENTRY_LIMIT", "transcript exceeds the entry limit");
  }
  return entries
    .map((entry) => {
      const text = scrubRuntimeResidueText(entry.text);
      if (text.length > options.maxEntryChars) {
        throw runtimeError(
          "TRANSCRIPT_ENTRY_TOO_LARGE",
          "transcript entry exceeds the character limit",
        );
      }
      return { ...entry, text };
    })
    .filter((entry) => entry.text.trim())
    .map((entry, sequence) => ({ sequence, ...entry }));
}

export function buildRuntimeResidue(record, content, options) {
  const runtime = normalizeRuntime(record.agent?.runtime);
  if (!runtime) {
    throw runtimeError("UNSUPPORTED_RUNTIME", "runtime has no supported transcript reader");
  }
  const parsed = parseJsonLines(
    content,
    options.maxTranscriptLineBytes,
    options.maxTranscriptRecords,
  );
  const projection =
    runtime === "claude-code" ? claudeEntries(parsed) : codexEntries(parsed);
  const entries = boundedEntries(projection.entries, options);
  if (!projection.recognized || entries.length === 0) {
    throw runtimeError(
      "UNKNOWN_TRANSCRIPT_FORMAT",
      "runtime transcript did not match its supported JSONL contract",
    );
  }

  const sessionId = String(
    record.hook?.runtime_session_id || record.session_id || record.event_id,
  );
  const safeSessionId = opaqueIdentifier(runtime, sessionId);
  const residueHash = sha256(JSON.stringify(entries));
  return {
    sessionDir: `runtime-session:${safeSessionId}`,
    sessionMarkdown: null,
    slug: safeSessionId,
    repo: null,
    status: "captured",
    phase: null,
    planSummary: "",
    definitionOfDone: "",
    decisions: [],
    learnings: [],
    evidence: null,
    critiqueSummary: null,
    transcriptRefs: [`runtime-session:${safeSessionId}:sha256:${residueHash}`],
    touchedFiles: [],
    source: "runtime-session",
    runtime,
    transcriptEntries: entries,
  };
}
