/**
 * #669 — residue contract, runtime-session source, watermark cursor, scrub.
 *
 * Fixtures under fixtures/runtime/ are SYNTHETIC transcripts in the exact
 * record shapes Claude Code project JSONL and Codex rollout JSONL use. Secret-
 * shaped canaries are stored as `__CANARY_*__` placeholders and assembled from
 * fragments here, so no detector-shaped literal is committed.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  commitRuntimeCursor,
  emptyRuntimeCursor,
  ingestFromSource,
  ingestRuntimeSessions,
  ingestSession,
  INJECTED_MEMORY_CLOSE,
  INJECTED_MEMORY_OPEN,
  readRuntimeCursor,
  scrubResidueText,
  SESSION_SOURCE_IDS,
} from "./index.js";
import { createClaudeCodeImporter, createCodexImporter } from "@kontourai/ferry";
import { conversationFromThread, readConversation, stripInjectedContent, TranscriptFormatError } from "./runtime-transcript.js";
import { validate } from "../providers/lib/schema-validate.js";

// The CJS fs object: the one whose methods can be hooked (an ESM namespace is read-only).
const cjsFs = createRequire(import.meta.url)("node:fs");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, "..");
const SESSION_FIXTURE = path.join(HERE, "fixtures", "session");
const RUNTIME_FIXTURES = path.join(HERE, "fixtures", "runtime");
const RESIDUE_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(KIT, "schemas", "knowledge", "residue.schema.json"), "utf8"),
);
// sha256 of JSON.stringify(ingestSession(fixtures/session)) with sessionDir
// normalized, computed on main @ dca0f02d BEFORE this change.
const LEGACY_SIDECAR_RESIDUE_SHA256 = "e3a0c2177c84a363edab54dfdf950924977fa97398b7b66d635a87b4b96588ab";

const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const CLAUDE_SESSION = "5b1f2c3d-0000-4000-8000-00000000c1a0";
const CODEX_SESSION = "019a0000-0000-7000-8000-00000000c0de";

const CANARIES = {
  __CANARY_GITHUB__: ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join(""),
  __CANARY_OPENAI__: ["sk", "-proj-", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2"].join(""),
  __CANARY_AWS__: ["AK", "IA", "Q7FIXTURE0EXAMPL"].join(""),
  __CANARY_ASSIGN__: ["fixture", "Secret", "Value123"].join(""),
  __CANARY_TOOL_RESULT__: ["toolresult", "Canary987"].join(""),
};
const PLAIN_CANARIES = ["jane.fixture@example.com", "billing-owner@example.org", "/Users/fixture-user"];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function materialize(name, destination) {
  let text = fs.readFileSync(path.join(RUNTIME_FIXTURES, name), "utf8");
  for (const [placeholder, value] of Object.entries(CANARIES)) text = text.split(placeholder).join(value);
  fs.writeFileSync(destination, text);
  return destination;
}

function event(runtime, transcriptPath, extra = {}) {
  return {
    schema_version: "0.3.0",
    timestamp: "1793455200000",
    session_id: "telemetry-session",
    event_id: "event",
    event_type: "stop",
    agent: { name: "dev", runtime, version: "fixture" },
    install_identity: { package_version: "fixture", content_fingerprint: "fixture", source: "fixture" },
    hook: {
      event_name: "Stop",
      runtime_session_id: "runtime-session",
      turn_id: "",
      transcript_path: transcriptPath,
      model: "",
      source: "",
      stop_hook_active: false,
      last_assistant_message: "",
      raw_input: null,
    },
    ...extra,
  };
}

/** Temp layout: claude/ and codex/ transcript roots plus a telemetry file. */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-runtime-669-"));
  const claude = path.join(root, "claude", "projects", "-Users-fixture-user-dev-widget-service");
  const codex = path.join(root, "codex", "sessions", "2026", "10", "31");
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  const box = {
    root,
    roots: [path.join(root, "claude", "projects"), path.join(root, "codex", "sessions")],
    telemetryFile: path.join(root, "telemetry", "full.jsonl"),
    claudeTranscript: materialize("claude-project.jsonl", path.join(claude, `${CLAUDE_SESSION}.jsonl`)),
    claudeDrifted: materialize("claude-drifted.jsonl", path.join(claude, "drifted.jsonl")),
    codexRollout: materialize("codex-rollout.jsonl", path.join(codex, `rollout-2026-10-31T14-00-00-${CODEX_SESSION}.jsonl`)),
    codexSubagent: materialize("codex-subagent-rollout.jsonl", path.join(codex, "rollout-subagent.jsonl")),
  };
  fs.mkdirSync(path.dirname(box.telemetryFile), { recursive: true });
  fs.writeFileSync(box.telemetryFile, "");
  return box;
}

function appendTelemetry(box, ...lines) {
  const text = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
  fs.appendFileSync(box.telemetryFile, `${text}\n`);
}

function run(box, overrides = {}) {
  return ingestRuntimeSessions({ telemetryFile: box.telemetryFile, transcriptRoots: box.roots, now: NOW, ...overrides });
}

function lineOffsets(file) {
  const offsets = [];
  const bytes = fs.readFileSync(file);
  let position = 0;
  while (position < bytes.length) {
    offsets.push(position);
    const newline = bytes.indexOf(0x0a, position);
    position = newline === -1 ? bytes.length : newline + 1;
  }
  return offsets;
}

function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = sha256(fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

describe("AC1 residue contract and workflow-sidecar compatibility", () => {
  test("workflow-sidecar source returns the unchanged ingestSession residue", () => {
    const direct = ingestSession(SESSION_FIXTURE);
    const viaSource = ingestFromSource("workflow-sidecar", SESSION_FIXTURE);
    assert.deepEqual(Object.keys(viaSource), ["residues"]);
    assert.equal(viaSource.residues.length, 1);
    assert.equal(JSON.stringify(viaSource.residues[0]), JSON.stringify(direct));
    const normalized = JSON.stringify({ ...direct, sessionDir: "<SESSION>" });
    assert.equal(sha256(normalized), LEGACY_SIDECAR_RESIDUE_SHA256);
  });

  test("the residue schema accepts both sources and rejects hybrids", () => {
    assert.deepEqual(SESSION_SOURCE_IDS, ["workflow-sidecar", "runtime-session"]);
    const sidecar = ingestSession(SESSION_FIXTURE);
    assert.deepEqual(validate(sidecar, RESIDUE_SCHEMA).errors, []);

    const box = sandbox();
    appendTelemetry(box, event("claude-code", box.claudeTranscript), event("codex", box.codexRollout));
    const { residues } = ingestFromSource("runtime-session", { telemetryFile: box.telemetryFile, transcriptRoots: box.roots, now: NOW });
    assert.equal(residues.length, 4);
    for (const residue of residues) assert.deepEqual(validate(residue, RESIDUE_SCHEMA).errors, [], residue.sittingId);

    assert.equal(validate({ ...sidecar, source: "runtime-session" }, RESIDUE_SCHEMA).valid, false);
    const { provenance, ...noProvenance } = residues[0];
    assert.equal(validate(noProvenance, RESIDUE_SCHEMA).valid, false);
    assert.equal(validate({ ...residues[0], sittingId: "opencode:x:0" }, RESIDUE_SCHEMA).valid, false);
    assert.equal(
      validate({ ...residues[0], turns: [{ role: "tool", text: "x", at: "t" }] }, RESIDUE_SCHEMA).valid,
      false,
    );
    assert.throws(() => ingestFromSource("opencode", {}), /unknown residue source/);
  });
});

describe("AC2 runtime-session parsing, sittings and provenance", () => {
  test("dropped user turns are summed across the transcripts a run reads, not overwritten", () => {
    const box = sandbox();
    const other = "5b1f2c3d-0000-4000-8000-00000000c1a1";
    const copy = path.join(path.dirname(box.claudeTranscript), `${other}.jsonl`);
    fs.writeFileSync(copy, fs.readFileSync(box.claudeTranscript, "utf8").replaceAll(CLAUDE_SESSION, other));
    appendTelemetry(box, event("claude-code", box.claudeTranscript), event("claude-code", copy));
    const { report } = run(box);
    assert.equal(report.blocked.length, 0);
    assert.deepEqual(report.dropped_user_turns, { unknown: 4 }, "two transcripts with two each");
  });

  test("Claude Code project JSONL yields user/assistant text sittings with provenance", () => {
    const box = sandbox();
    appendTelemetry(box, event("claude-code", box.claudeTranscript));
    const { residues, report } = run(box);
    assert.equal(report.blocked.length, 0);
    // The peer message and the task notification carry a non-human raw origin: removed before import, counted unknown.
    assert.deepEqual(report.dropped_user_turns, { unknown: 2 });
    assert.deepEqual(residues.map((r) => r.sittingId), [`claude-code:${CLAUDE_SESSION}:0`, `claude-code:${CLAUDE_SESSION}:1`]);
    const [first, second] = residues;
    assert.deepEqual(first.provenance, {
      harness: "claude-code",
      sessionId: CLAUDE_SESSION,
      transcriptRef: `-Users-fixture-user-dev-widget-service/${CLAUDE_SESSION}.jsonl`,
      cwd: "~/dev/widget-service",
      gitBranch: "feat/retry-budget",
      startedAt: "2026-10-30T09:00:02.000Z",
      endedAt: "2026-10-30T09:06:00.000Z",
    });
    // Branch and cwd are session-level (Ferry's Thread metadata), the same on every sitting.
    assert.equal(second.provenance.gitBranch, "feat/retry-budget");
    assert.equal(second.provenance.startedAt, "2026-10-30T10:30:00.000Z");
    assert.deepEqual(first.turns.map((t) => t.role), ["user", "assistant", "user", "assistant"]);
    assert.match(first.turns[0].text, /^The retry budget in the widget service resets too early\./);
    assert.match(first.turns[2].text, /Ok, make it reset only after a successful call\.$/);
    assert.match(first.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first.complete, true);
    // `origin: {kind: "human"}` is a real prompt; only non-human origins are harness entries.
    assert.match(second.turns[0].text, /^Back again\./);

    const all = JSON.stringify(residues);
    for (const dropped of [
      "harness reminder text", // <system-reminder>
      "/clear", // meta command entry
      "private chain of thought", // thinking
      "TOOL_RESULT_ONLY_MARKER", // tool_result
      "cat config/.env", // tool_use input
      "SIDECHAIN_ONLY_MARKER", // isSidechain
      "<task-id>", // harness-originated task notification
      "COMPACT_SUMMARY_MARKER", // compact summary (thread#76 shim)
      "PEER_ORIGIN_MARKER", // origin.kind "peer" (thread#76 shim)
      "PRIOR MEMORY", // our injected-memory block
      "seeded queue text", // queue-operation
      "Fix retry budget reset", // ai-title
    ]) {
      assert.equal(all.includes(dropped), false, `residue leaked: ${dropped}`);
    }
  });

  test("Codex rollout yields user/assistant text sittings; subagent rollouts are skipped", () => {
    const box = sandbox();
    appendTelemetry(box, event("codex", box.codexRollout), event("codex", box.codexSubagent));
    const { residues, report, candidateCursor } = run(box);
    assert.deepEqual(report.dropped_user_turns, { agent: 1 }, "the inter-agent message");
    assert.deepEqual(residues.map((r) => r.sittingId), [`codex:${CODEX_SESSION}:0`, `codex:${CODEX_SESSION}:1`]);
    assert.deepEqual(residues[0].provenance, {
      harness: "codex",
      sessionId: CODEX_SESSION,
      transcriptRef: `2026/10/31/rollout-2026-10-31T14-00-00-${CODEX_SESSION}.jsonl`,
      cwd: "~/dev/ledger",
      gitBranch: "fix/ledger-rounding",
      startedAt: "2026-10-31T14:00:01.100Z",
      endedAt: "2026-10-31T14:00:06.000Z",
    });
    assert.deepEqual(residues[0].turns.map((t) => t.role), ["user", "assistant"]);
    const all = JSON.stringify(residues);
    for (const dropped of [
      "DEVELOPER_MARKER",
      "<cwd>",
      "REASONING_MARKER",
      "FUNCTION_OUTPUT_MARKER",
      "CUSTOM_OUTPUT_MARKER",
      "INTER_AGENT_MARKER",
      "BASE_INSTRUCTIONS_MARKER",
      "AGENTS_FILE_MARKER", // "# AGENTS.md instructions" user message
      "CODEX_INTERNAL_MARKER",
      "# AGENTS.md",
      "data:image",
      "SUBAGENT_ROLLOUT_MARKER",
    ]) {
      assert.equal(all.includes(dropped), false, `residue leaked: ${dropped}`);
    }
    assert.deepEqual(report.skipped.map((s) => s.reason), ["SIDECHAIN_TRANSCRIPT"]);
    assert.equal(report.cursor_held, false);
    assert.equal(candidateCursor.telemetry.offset, fs.statSync(box.telemetryFile).size);
  });

  test("the idle gap is configurable and sitting ids are stable", () => {
    const box = sandbox();
    appendTelemetry(box, event("claude-code", box.claudeTranscript));
    const merged = run(box, { idleGapMs: 2 * 60 * 60 * 1000 });
    assert.deepEqual(merged.residues.map((r) => r.sittingId), [`claude-code:${CLAUDE_SESSION}:0`]);
    const split = run(box, { idleGapMs: 60 * 1000 });
    assert.ok(split.residues.length > 2);
    assert.deepEqual(run(box).residues, run(box).residues);
    const open = run(box, { now: Date.parse("2026-10-30T10:40:00.000Z") });
    assert.deepEqual(open.residues.map((r) => r.complete), [true, false]);
  });

  test("telemetry naming the wrong runtime for a transcript is drift, not residue", () => {
    const box = sandbox();
    appendTelemetry(box, event("claude-code", box.codexRollout));
    const { residues, report, candidateCursor } = run(box);
    assert.equal(residues.length, 0);
    assert.equal(report.blocked[0].reason, "UNKNOWN_TRANSCRIPT_FORMAT");
    assert.equal(candidateCursor.telemetry.offset, 0);
  });

  test("a trailing partial transcript line is not ingested and holds the cursor until it is complete", () => {
    const box = sandbox();
    fs.appendFileSync(
      box.claudeTranscript,
      JSON.stringify({ type: "user", sessionId: CLAUDE_SESSION, timestamp: "2026-10-30T10:32:00.000Z", message: { role: "user", content: "PARTIAL_LINE" } }).slice(0, -6),
    );
    appendTelemetry(box, event("claude-code", box.claudeTranscript));
    const { residues, report, candidateCursor } = run(box);
    assert.deepEqual(report.blocked.map((b) => b.reason), ["TRANSCRIPT_PARTIAL_TAIL"]);
    assert.equal(candidateCursor.telemetry.offset, 0);
    assert.equal(JSON.stringify(residues).includes("PARTIAL_LINE"), false);
  });

  test("transcript drift and shape faults block with a reason instead of yielding residue", () => {
    const claudeLine = (extra = {}) =>
      JSON.stringify({
        parentUuid: null, isSidechain: false, type: "user", uuid: "u", timestamp: "2026-10-30T09:00:01.000Z", origin: { kind: "human" }, promptSource: "typed",
        cwd: "/w", sessionId: CLAUDE_SESSION, version: "9.0.0", gitBranch: "main",
        message: { role: "user", content: "hello there" }, ...extra,
      });
    const codexMeta = JSON.stringify({ timestamp: "2026-10-31T14:00:00.000Z", type: "session_meta", payload: { id: CODEX_SESSION, cwd: "/w" } });
    const codexUser = JSON.stringify({
      timestamp: "2026-10-31T14:00:01.000Z", type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    });
    const faults = {
      // a non-JSON line in the middle of a Claude transcript: Ferry skips and warns
      "claude malformed line": ["claude-code", [claudeLine(), "{not json", claudeLine({ uuid: "v" })].join("\n")],
      // conversation record Ferry cannot read
      "claude unreadable record": ["claude-code", claudeLine({ message: { role: "user", content: { blocks: [] } } })],
      // no record carries a sessionId, so Ferry would invent a shared thread id
      "claude without sessionId": ["claude-code", claudeLine({ sessionId: undefined, parentUuid: "p" })],
      "codex without session_meta first": ["codex", [codexUser, codexMeta].join("\n")],
      "codex malformed line": ["codex", [codexMeta, codexUser, "{not json", codexUser].join("\n")],
      "unrecognized format": ["claude-code", JSON.stringify({ hello: "world" })],
    };
    for (const [name, [runtime, body]] of Object.entries(faults)) {
      const box = sandbox();
      const file = path.join(box.roots[0], `${name.replace(/ /g, "-")}.jsonl`);
      fs.writeFileSync(file, `${body}\n`);
      appendTelemetry(box, event(runtime, file));
      const { residues, report, candidateCursor } = run(box);
      assert.equal(residues.length, 0, name);
      assert.equal(report.blocked.length, 1, name);
      assert.equal(report.blocked[0].reason, "UNKNOWN_TRANSCRIPT_FORMAT", name);
      assert.equal(candidateCursor.telemetry.offset, 0, `${name}: cursor must not pass the unread transcript`);
    }

    // The same bodies, well-formed, are readable: the faults above are what blocks them.
    const box = sandbox();
    const ok = path.join(box.roots[0], "ok.jsonl");
    fs.writeFileSync(ok, `${claudeLine()}\n`);
    appendTelemetry(box, event("claude-code", ok));
    assert.equal(run(box).residues.length, 1);
  });

  test("an empty or bookkeeping-only transcript is skipped, not blocked", () => {
    const box = sandbox();
    const empty = path.join(box.roots[0], "empty.jsonl");
    const bookkeeping = path.join(box.roots[0], "bookkeeping.jsonl");
    fs.writeFileSync(empty, "");
    fs.writeFileSync(
      bookkeeping,
      `${JSON.stringify({ type: "ai-title", aiTitle: "t", sessionId: CLAUDE_SESSION })}\n`,
    );
    appendTelemetry(box, event("claude-code", empty), event("claude-code", bookkeeping));
    const { residues, report, candidateCursor } = run(box);
    assert.equal(residues.length, 0);
    assert.equal(report.blocked.length, 0);
    assert.deepEqual(report.skipped.map((s) => s.reason), ["NO_CONVERSATION", "NO_CONVERSATION"]);
    assert.equal(candidateCursor.telemetry.offset, fs.statSync(box.telemetryFile).size);
  });

  test("other runtimes, missing refs, out-of-root and deleted transcripts are skipped and reported", () => {
    const box = sandbox();
    const outside = path.join(box.root, "elsewhere.jsonl");
    fs.copyFileSync(box.claudeTranscript, outside);
    appendTelemetry(
      box,
      event("kiro-cli", box.claudeTranscript),
      event("claude-code", ""),
      event("claude-code", outside),
      event("claude-code", path.join(box.roots[0], "gone.jsonl")),
    );
    const { residues, report, candidateCursor } = run(box);
    assert.equal(residues.length, 0);
    assert.deepEqual(report.skipped.map((s) => s.reason), [
      "UNSUPPORTED_RUNTIME",
      "NO_TRANSCRIPT_REF",
      "TRANSCRIPT_OUTSIDE_ROOTS",
      "TRANSCRIPT_MISSING",
    ]);
    assert.equal(candidateCursor.telemetry.offset, fs.statSync(box.telemetryFile).size);
  });
});

describe("AC2 watermark cursor", () => {
  test("cursor never advances past unread content", () => {
    const box = sandbox();
    appendTelemetry(
      box,
      event("codex", box.codexRollout),
      event("claude-code", box.claudeDrifted), // drifted transcript: unread
      event("claude-code", box.claudeTranscript),
    );
    fs.appendFileSync(box.telemetryFile, '{"schema_version":"0.3.0"'); // partial line: a write in progress
    const offsets = lineOffsets(box.telemetryFile);

    const first = run(box);
    assert.equal(first.report.cursor_held, true);
    assert.deepEqual(first.report.blocked.map((b) => [b.telemetry_offset, b.reason]), [[offsets[1], "UNKNOWN_TRANSCRIPT_FORMAT"]]);
    assert.equal(first.candidateCursor.telemetry.offset, offsets[1], "cursor must stop before the drifted transcript's line");
    // Later lines are still processed this run...
    assert.deepEqual(first.residues.map((r) => r.provenance.harness), ["codex", "codex", "claude-code", "claude-code"]);

    // ...and are not re-emitted when the owner re-runs from the held offset.
    const second = run(box, { cursor: first.candidateCursor });
    assert.equal(second.residues.length, 0);
    assert.equal(second.candidateCursor.telemetry.offset, offsets[1]);
    assert.equal(second.report.sittings_unchanged, 2);

    // Once the drift is resolved, the cursor moves to the end of the last
    // complete line — never into the partial one.
    fs.copyFileSync(box.claudeTranscript, box.claudeDrifted);
    const third = run(box, { cursor: second.candidateCursor });
    assert.equal(third.report.cursor_held, false);
    assert.equal(third.candidateCursor.telemetry.offset, offsets[3]);
  });

  test("malformed and unknown-version telemetry lines hold the cursor", () => {
    const box = sandbox();
    appendTelemetry(box, "{not json", event("codex", box.codexRollout));
    let result = run(box);
    assert.equal(result.report.blocked[0].reason, "TELEMETRY_MALFORMED");
    assert.equal(result.candidateCursor.telemetry.offset, 0);

    const other = sandbox();
    appendTelemetry(other, { ...event("codex", other.codexRollout), schema_version: "0.4.0" });
    result = run(other);
    assert.equal(result.report.blocked[0].reason, "TELEMETRY_UNKNOWN_VERSION");
    assert.equal(result.candidateCursor.telemetry.offset, 0);
    assert.equal(result.residues.length, 0);
  });

  test("ingest writes nothing; the owner commits the candidate cursor and re-runs skip unchanged sittings", () => {
    const box = sandbox();
    const cursorFile = path.join(box.root, "dream", "runtime-session.cursor.json");
    appendTelemetry(box, event("claude-code", box.claudeTranscript));
    const before = snapshot(box.root);
    const first = run(box, { cursor: readRuntimeCursor(cursorFile) });
    assert.deepEqual(snapshot(box.root), before, "ingest must not write");
    assert.equal(fs.existsSync(cursorFile), false);
    assert.equal(first.residues.length, 2);

    commitRuntimeCursor(cursorFile, first.candidateCursor);
    assert.deepEqual(readRuntimeCursor(cursorFile), first.candidateCursor);
    assert.deepEqual(fs.readdirSync(path.dirname(cursorFile)), ["runtime-session.cursor.json"]);

    const again = run(box, { cursor: readRuntimeCursor(cursorFile) });
    assert.equal(again.residues.length, 0);
    assert.equal(again.report.telemetry_lines_read, 0);

    // The session continues inside sitting 1: only that sitting is re-emitted.
    fs.appendFileSync(
      box.claudeTranscript,
      `${JSON.stringify({
        parentUuid: null, isSidechain: false, type: "user", uuid: "late", timestamp: "2026-10-30T10:35:00.000Z", origin: { kind: "human" }, promptSource: "typed",
        cwd: "/Users/fixture-user/dev/widget-service", sessionId: CLAUDE_SESSION, version: "2.1.316", gitBranch: "feat/retry-budget-test",
        message: { role: "user", content: "Also cover the jitter path." },
      })}\n`,
    );
    appendTelemetry(box, event("claude-code", box.claudeTranscript));
    const grown = run(box, { cursor: readRuntimeCursor(cursorFile) });
    assert.deepEqual(grown.residues.map((r) => r.sittingId), [`claude-code:${CLAUDE_SESSION}:1`]);
    assert.notEqual(grown.residues[0].contentHash, first.residues[1].contentHash);
    assert.equal(grown.report.sittings_unchanged, 1);
  });

  test("a truncated or rewritten telemetry file blocks without moving the cursor", () => {
    const box = sandbox();
    appendTelemetry(box, event("codex", box.codexRollout));
    const first = run(box);
    fs.writeFileSync(box.telemetryFile, `${JSON.stringify(event("claude-code", box.claudeTranscript))}\n`);
    const result = run(box, { cursor: first.candidateCursor });
    assert.equal(result.residues.length, 0);
    assert.equal(result.report.blocked[0].reason, "TELEMETRY_DISCONTINUITY");
    assert.deepEqual(result.candidateCursor, first.candidateCursor);
    assert.throws(() => run(box, { cursor: { ...emptyRuntimeCursor(), schema_version: "9" } }), /unsupported shape/);
  });
});

describe("AC3 deterministic redaction scrub", () => {
  test("seeded secrets, emails and home paths never reach residue, even when the transcript asks", () => {
    const box = sandbox();
    appendTelemetry(box, event("claude-code", box.claudeTranscript), event("codex", box.codexRollout));
    const output = JSON.stringify(run(box));
    // The canary the transcript tells the distiller to keep verbatim:
    assert.match(output, /keep this token verbatim: <SECRET>/);
    for (const canary of [...Object.values(CANARIES), ...PLAIN_CANARIES]) {
      assert.equal(output.includes(canary), false, `canary leaked: ${canary.slice(0, 6)}…`);
    }
    assert.match(output, /reach me at <EMAIL>/);
    assert.match(output, /Repo lives at ~\/dev\/widget-service/);
  });

  test("scrubResidueText covers each pattern family, deterministically and idempotently", () => {
    const cases = [
      [`token ${CANARIES.__CANARY_GITHUB__} here`, "token <SECRET> here"],
      [`key ${CANARIES.__CANARY_OPENAI__}`, "key <SECRET>"],
      [`id ${CANARIES.__CANARY_AWS__}`, "id <SECRET>"],
      [`DB_PASSWORD=${CANARIES.__CANARY_ASSIGN__} next`, "DB_PASSWORD=<SECRET> next"],
      [`{"api_key": "${CANARIES.__CANARY_ASSIGN__}"}`, '{"api_key": <SECRET>}'],
      [`Authorization: Bearer ${CANARIES.__CANARY_ASSIGN__}`, "Authorization: Bearer <SECRET>"],
      [`postgres://app:${CANARIES.__CANARY_ASSIGN__}@db:5432/x`, "postgres://app:<SECRET>@db:5432/x"],
      ["mail ops@example.com now", "mail <EMAIL> now"],
      ["/Users/someone/dev/x and /home/ci/y", "~/dev/x and ~/y"],
      ["C:\\Users\\someone\\dev", "~\\dev"],
      ["max_tokens: 4096 and /usr/local/bin", "max_tokens: 4096 and /usr/local/bin"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(scrubResidueText(input), expected);
      assert.equal(scrubResidueText(scrubResidueText(input)), expected);
    }
  });
});

describe("review round 1 regressions (PR #1575)", () => {
  const UID = "5b1f2c3d-0000-4000-8000-00000000f001";
  const STAMP = "2026-10-30T09:00:00.000Z";
  const claudeRec = (text, extra = {}) => ({
    parentUuid: null, isSidechain: false, type: "user", uuid: "u1", timestamp: STAMP, cwd: "/w", origin: { kind: "human" }, promptSource: "typed",
    sessionId: UID, version: "2.1.0", gitBranch: "main", message: { role: "user", content: text }, ...extra,
  });
  const codexMeta = (extra = {}) => ({
    timestamp: STAMP, type: "session_meta",
    payload: { id: "019a0000-0000-7000-8000-00000000f002", cwd: "/w", cli_version: "0.130.0", source: "cli", ...extra },
  });
  const codexMsg = (role, text, at = STAMP) => ({
    timestamp: at, type: "response_item",
    payload: { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] },
  });
  const ndjson = (records) => `${records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")}\n`;

  function single(runtime, body) {
    const box = sandbox();
    const file = path.join(box.roots[0], "case.jsonl");
    fs.writeFileSync(file, body);
    appendTelemetry(box, event(runtime, file));
    return { box, file };
  }

  test("F1: an unterminated transcript tail holds the cursor and is read once completed", () => {
    const full = JSON.stringify(claudeRec("TAIL_MUST_BE_READ", { uuid: "u2", timestamp: "2026-10-30T09:00:01.000Z" }));
    for (const tail of [Buffer.from(full.slice(0, -9)), Buffer.from("{"), Buffer.from([0x7b, 0x22, 0xf0, 0x9f])]) {
      const { box, file } = single("claude-code", ndjson([claudeRec("FIRST_LINE")]));
      fs.appendFileSync(file, tail);
      const first = run(box);
      assert.deepEqual(first.report.blocked.map((b) => b.reason), ["TRANSCRIPT_PARTIAL_TAIL"]);
      assert.equal(first.report.cursor_held, true);
      assert.equal(first.candidateCursor.telemetry.offset, 0);
      assert.match(JSON.stringify(first.residues), /FIRST_LINE/, "complete lines are still emitted");
    }
    const { box, file } = single("claude-code", ndjson([claudeRec("FIRST_LINE")]));
    fs.appendFileSync(file, full.slice(0, -9));
    const first = run(box);
    fs.appendFileSync(file, `${full.slice(-9)}\n`);
    const second = run(box, { cursor: first.candidateCursor });
    assert.match(JSON.stringify(second.residues), /TAIL_MUST_BE_READ/);
    assert.equal(second.report.cursor_held, false);
    assert.equal(second.candidateCursor.telemetry.offset, fs.statSync(box.telemetryFile).size);
  });

  test("a final record that is whole JSON but has no newline yet is complete, not a hold", () => {
    const { box } = single("claude-code", ndjson([claudeRec("FIRST_LINE")]).concat(JSON.stringify(claudeRec("LAST_NO_NEWLINE", { uuid: "u2", timestamp: "2026-10-30T09:00:01.000Z" }))));
    const result = run(box);
    assert.equal(result.report.blocked.length, 0);
    assert.match(JSON.stringify(result.residues), /LAST_NO_NEWLINE/);
    assert.equal(result.candidateCursor.telemetry.offset, fs.statSync(box.telemetryFile).size);
  });

  test("F1: a transcript that grows between two telemetry references is re-read, not served from the first snapshot", () => {
    const { box, file } = single("claude-code", ndjson([claudeRec("FIRST_LINE")]));
    appendTelemetry(box, event("claude-code", file));
    const real = fs.realpathSync(file);
    const { openSync, closeSync } = cjsFs;
    const transcriptFds = new Set();
    let grown = false;
    cjsFs.openSync = function (target, ...rest) {
      const fd = openSync.call(this, target, ...rest);
      if (String(target) === real) transcriptFds.add(fd);
      return fd;
    };
    cjsFs.closeSync = function (fd, ...rest) {
      const result = closeSync.call(this, fd, ...rest);
      if (transcriptFds.delete(fd) && !grown) {
        grown = true; // the first read of the transcript is over; now it grows
        fs.appendFileSync(real, ndjson([claudeRec("GROWTH_MUST_SURVIVE", { uuid: "u2", timestamp: "2026-10-30T09:00:05.000Z" })]));
      }
      return result;
    };
    syncBuiltinESMExports();
    let first;
    try {
      first = run(box);
    } finally {
      cjsFs.openSync = openSync;
      cjsFs.closeSync = closeSync;
      syncBuiltinESMExports();
    }
    assert.equal(grown, true, "the growth hook must have fired after the first transcript read");
    assert.equal(first.report.telemetry_lines_read, 2);
    assert.match(JSON.stringify(first.residues), /GROWTH_MUST_SURVIVE/);
  });

  test("F1: a transcript that grows while it is being read holds the cursor", () => {
    const { box, file } = single("claude-code", ndjson([claudeRec("FIRST_LINE")]));
    const real = fs.realpathSync(file);
    const readFileSync = cjsFs.readFileSync;
    let grown = false;
    cjsFs.readFileSync = function (target, ...rest) {
      const content = readFileSync.call(this, target, ...rest);
      if (typeof target === "number" && !grown) {
        grown = true;
        fs.appendFileSync(real, ndjson([claudeRec("GROWTH_MUST_BE_READ", { uuid: "u2", timestamp: "2026-10-30T09:00:05.000Z" })]));
      }
      return content;
    };
    syncBuiltinESMExports();
    let first;
    try {
      first = run(box);
    } finally {
      cjsFs.readFileSync = readFileSync;
      syncBuiltinESMExports();
    }
    assert.equal(grown, true, "the growth hook must have fired");
    assert.deepEqual(first.report.blocked.map((b) => b.reason), ["TRANSCRIPT_CHANGED_DURING_READ"]);
    assert.equal(first.candidateCursor.telemetry.offset, 0);
    const second = run(box, { cursor: first.candidateCursor });
    assert.match(JSON.stringify(second.residues), /GROWTH_MUST_BE_READ/);
  });

  test("F2: a transcript swapped for a symlink out of the authorized roots after the root check is not read", () => {
    const { box, file } = single("claude-code", ndjson([claudeRec("INSIDE_ROOT")]));
    const outside = path.join(box.root, "outside.jsonl");
    fs.writeFileSync(outside, ndjson([claudeRec("OUTSIDE_RACE")]));
    const real = fs.realpathSync(file);
    const { statSync, openSync } = cjsFs;
    let fired = false;
    const swap = () => {
      if (fired) return;
      fired = true;
      fs.unlinkSync(real);
      fs.symlinkSync(outside, real);
    };
    cjsFs.statSync = function (p, ...rest) {
      if (String(p) === real) swap();
      return statSync.call(this, p, ...rest);
    };
    cjsFs.openSync = function (p, ...rest) {
      if (String(p) === real) swap();
      return openSync.call(this, p, ...rest);
    };
    syncBuiltinESMExports();
    let result;
    try {
      result = run(box);
    } finally {
      cjsFs.statSync = statSync;
      cjsFs.openSync = openSync;
      syncBuiltinESMExports();
    }
    assert.equal(fired, true, "the swap must have fired");
    assert.equal(JSON.stringify(result.residues).includes("OUTSIDE_RACE"), false);
    assert.equal(result.candidateCursor.telemetry.offset, 0, "the unread transcript holds the cursor");
  });

  test("F3: nested, cross-message and upper-case wrappers cannot leak injected memory", () => {
    const O = INJECTED_MEMORY_OPEN;
    const C = INJECTED_MEMORY_CLOSE;
    assert.equal(stripInjectedContent(`a ${O}x ${O}y${C} LEAK_NESTED ${C} b`), "a  b");
    assert.equal(stripInjectedContent(`LEAK_STRAY_HEAD${C} kept`), "kept");
    assert.equal(stripInjectedContent("<SYSTEM-REMINDER>LEAK_CASE</SYSTEM-REMINDER>real"), "real");
    const { box } = single(
      "claude-code",
      ndjson([
        claudeRec(`${O}hidden LEAK_OPEN`, { uuid: "u1" }),
        claudeRec(`LEAK_CLOSE${C} real follow-up`, { uuid: "u3", timestamp: "2026-10-30T09:00:02.000Z" }),
      ]),
    );
    const result = run(box);
    const out = JSON.stringify(result.residues);
    for (const leak of ["LEAK_OPEN", "LEAK_CLOSE", "hidden"]) assert.equal(out.includes(leak), false, leak);
    assert.match(out, /real follow-up/);
    assert.deepEqual(result.report.notes.map((n) => n.reason), ["INJECTED_MEMORY_UNTERMINATED"]);
  });

  test("M5: a quoted opening marker hides the rest of its own message, not the session, and is reported", () => {
    const { box } = single(
      "claude-code",
      ndjson([
        claudeRec(`Please document the token ${INJECTED_MEMORY_OPEN} in the README. HIDDEN_REST_OF_MESSAGE`),
        claudeRec("LEGITIMATE_LATER_PROMPT", { uuid: "u2", timestamp: "2026-10-30T09:00:02.000Z" }),
      ]),
    );
    const result = run(box);
    const out = JSON.stringify(result.residues);
    assert.match(out, /LEGITIMATE_LATER_PROMPT/);
    assert.match(out, /Please document the token/);
    assert.equal(out.includes("HIDDEN_REST_OF_MESSAGE"), false);
    assert.deepEqual(result.report.notes.map((n) => n.reason), ["INJECTED_MEMORY_UNTERMINATED"]);
    assert.equal(result.report.cursor_held, false, "a note is not a hold");
    assert.equal(result.candidateCursor.telemetry.offset, fs.statSync(box.telemetryFile).size);

    // a message that is nothing but a hidden block still reports the note
    const hidden = single("claude-code", ndjson([claudeRec(`${INJECTED_MEMORY_OPEN}only hidden`)]));
    const hiddenResult = run(hidden.box);
    assert.deepEqual(hiddenResult.report.skipped.map((s) => s.reason), ["NO_CONVERSATION"]);
    assert.deepEqual(hiddenResult.report.notes.map((n) => n.reason), ["INJECTED_MEMORY_UNTERMINATED"]);

    // hidden text in an earlier part of a message whose later part closes the block
    const parts = single(
      "claude-code",
      ndjson([claudeRec([{ type: "text", text: "HIDDEN_FIRST_PART" }, { type: "text", text: `${INJECTED_MEMORY_CLOSE} KEPT_TAIL` }])]),
    );
    const partsOut = JSON.stringify(run(parts.box).residues);
    assert.equal(partsOut.includes("HIDDEN_FIRST_PART"), false);
    assert.match(partsOut, /KEPT_TAIL/);
  });

  test("M3: a harness tag opened in one text part and closed in the next is removed whole", () => {
    const { box } = single(
      "claude-code",
      ndjson([claudeRec([{ type: "text", text: "<system-reminder>HIDDEN_ONE" }, { type: "text", text: "HIDDEN_TWO</system-reminder>REAL_TEXT" }])]),
    );
    const out = JSON.stringify(run(box).residues);
    assert.match(out, /REAL_TEXT/);
    assert.equal(/HIDDEN_ONE|HIDDEN_TWO/.test(out), false);
  });

  test("F4: a session id that is not a UUID is drift and never reaches residue or cursor keys", () => {
    const secret = ["gh", "p_", "A".repeat(36)].join("");
    for (const [runtime, body] of [
      ["claude-code", ndjson([claudeRec("hello", { sessionId: secret })])],
      ["codex", ndjson([codexMeta({ id: secret }), codexMsg("user", "hello")])],
    ]) {
      const { box } = single(runtime, body);
      const result = run(box);
      assert.equal(result.residues.length, 0, runtime);
      assert.equal(result.report.blocked[0].reason, "UNKNOWN_TRANSCRIPT_FORMAT", runtime);
      assert.equal(JSON.stringify(result).includes(secret), false, runtime);
      assert.equal(result.candidateCursor.telemetry.offset, 0);
    }
  });

  test("F5: multi-line quoted and block-style secret assignments are scrubbed", () => {
    const first = ["multi", "Line", "First"].join("");
    const last = ["multi", "Line", "Last"].join("");
    for (const input of [
      `api_key="${first}\n${last}"`,
      `password='${first}\n${last}'`,
      `token: |\n  ${first}\n  ${last}\nnext: kept`,
    ]) {
      const out = scrubResidueText(input);
      assert.equal(out.includes(first) || out.includes(last), false, input);
      assert.equal(scrubResidueText(out), out, "idempotent");
    }
    assert.match(scrubResidueText(`token: |\n  ${first}\nnext: kept`), /next: kept$/);
  });

  test("M4/M6: block-scalar secrets in every YAML header form are scrubbed, siblings are kept", () => {
    const hidden = ["Secret", "First"].join("");
    const hidden2 = ["Secret", "Last"].join("");
    for (const input of [
      `"token": |\n  ${hidden}\n  ${hidden2}\nnext: kept`,
      `token: | # note\n  ${hidden}\n  ${hidden2}\nnext: kept`,
      `token: |2-\n  ${hidden}\n  ${hidden2}\nnext: kept`,
      `token: |\n  ${hidden}\n\n  ${hidden2}\nnext: kept`,
      `- token: >\n    ${hidden}\n    ${hidden2}\nnext: kept`,
    ]) {
      const out = scrubResidueText(input);
      assert.equal(out.includes(hidden) || out.includes(hidden2), false, input);
      assert.match(out, /next: kept$/, input);
      assert.equal(scrubResidueText(out), out, "idempotent");
    }
    // exact output: the body is replaced from the first body line, and nothing else moves
    assert.equal(scrubResidueText(`token: |\n  ${hidden}\n  ${hidden2}\nnext: kept`), "token: |\n  <SECRET>\nnext: kept");
    assert.equal(scrubResidueText(`a:\n  token: |\n    ${hidden}\n  b: 1`), "a:\n  token: |\n    <SECRET>\n  b: 1");
    // a value that is itself a blob is a secret first, a blob only if nothing names it
    assert.equal(scrubResidueText(`password: ${"A".repeat(250)}`), "password: <SECRET>");
    assert.equal(scrubResidueText(`note ${"A".repeat(250)} end`), "note <BLOB> end");
    const nested = scrubResidueText(`cfg:\n  token: |\n    ${hidden}\n  description: KEEP_SIBLING\n  retries: 4`);
    assert.equal(nested.includes(hidden), false);
    assert.match(nested, /description: KEEP_SIBLING\n  retries: 4$/);
    // an unmatched opening quote must not pair with a later assignment's quote and hide its key
    const canary = ["Review", "Canary", "81dx94"].join("");
    for (const input of [
      `Please document password: "${"ordinary prose ".repeat(300)}API_TOKEN="${canary}" after`,
      `password: "unterminated and then api_key='${canary}' tail`,
      `note "${"words ".repeat(20)} password = '${canary}'`,
      `Please document password: "${"ordinary prose ".repeat(300)}API_TOKEN="two words ${canary}" after`,
    ]) {
      const out = scrubResidueText(input);
      assert.equal(out.includes(canary), false, input.slice(0, 40));
      assert.equal(scrubResidueText(out), out, "idempotent");
    }
    // a long quoted secret is still a secret: the scrub fails toward over-redaction
    const long = ["Long", "Secret"].join("").repeat(400);
    assert.equal(scrubResidueText(`api_key="${long}"`).includes("LongSecret"), false);
  });

  test("M6: no mix of stray quotes, labels and prose lets a quoted assignment value survive, and the scrub stays idempotent", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const canary = ["zz", "canary", "zz"].join("");
    const labels = ["password", "API_TOKEN", "token", "api_key", "client_secret", "Authorization", "--password", "x-api-key", "my-api-key_2", "accessToken", "PASSWORD2"];
    const noise = ['password: "', "token='", 'api_key = "', '"', "'", "stray ", "prose words ", "\n", "`", ", ", "{", "}", "- ", "x=1 "];
    let checked = 0;
    for (let n = 0; n < 4000; n += 1) {
      let text = "";
      for (let i = 0, parts = 1 + Math.floor(rnd() * 6); i < parts; i += 1) {
        if (rnd() < 0.5) {
          const quote = pick(['"', "'", ""]);
          const inner = rnd() < 0.3 ? `prefix ${pick(labels)}=abcd ` : "";
          // an unquoted value ends at whitespace, so only a quoted one can hold several words
          const body = rnd() < 0.5 || !quote ? canary : `two words ${canary}`;
          text += `${pick(labels)}${pick(["=", ": ", " = ", ":"])}${quote}${quote ? inner : ""}${body}${quote} `;
        } else {
          text += pick(noise);
        }
      }
      if (!text.includes(canary)) continue;
      const out = scrubResidueText(text);
      assert.equal(out.includes(canary), false, JSON.stringify(text));
      assert.equal(scrubResidueText(out), out, `not idempotent: ${JSON.stringify(text)}`);
      checked += 1;
    }
    assert.ok(checked > 1000, `the generator must produce cases (${checked})`);
  });

  test("M6: a quoted secret that contains other secret-named keys is redacted whole, whatever the quoting", () => {
    const tail = ["R4", "Canary", "Tail987"].join("");
    for (const input of [
      `password="prefix token=abcd ${tail}"`,
      `password='prefix token="abcd ${tail}"'`,
      `{"password": "prefix token=abcd ${tail}", "x": 1}`,
      `password="prefix\r\ntoken=abcd ${tail}"\r\nnext=1`,
      `password: "stray ${"prose ".repeat(300)}api_key="two words ${tail}" after`,
    ]) {
      const out = scrubResidueText(input);
      assert.equal(out.includes(tail), false, input.slice(0, 50));
      assert.equal(scrubResidueText(out), out, "idempotent");
    }
    // a long chain of unmatched quotes cannot leave the final secret behind
    const chain = `${'password:"'.repeat(20000)}${tail}"`;
    const chained = scrubResidueText(chain);
    assert.equal(chained.includes(tail), false);
    assert.equal(scrubResidueText(chained), chained);
    assert.equal(scrubResidueText('x="1" password="ok" y="2"'), 'x="1" password=<SECRET> y="2"');
    // `Bearer <word>` must not eat a key name that follows it
    const bearerKey = ["hunter2", "hunter2"].join("");
    assert.equal(scrubResidueText(`Bearer password: "${bearerKey}"`).includes(bearerKey), false);
    // unterminated quote: the rest of the line is redacted, the next line is not
    assert.equal(scrubResidueText('password: "oops no close\nnext line stays'), 'password: <SECRET>\nnext line stays');
    // an escaped quote does not close the value
    assert.equal(scrubResidueText('{"password": "a\\"b secret tail", "k": 1}'), '{"password": <SECRET>, "k": 1}');
  });

  test("M6: every key spelling and value framing the scrub supports hides its value, and the scrub stays idempotent", () => {
    const canary = ["Ingest", "Delta", "Canary987"].join("");
    const keys = ["password", "API_TOKEN", "my-api-key_2", "x-api-key", "client_secret", "Authorization", "--password", "--api-key", "-token", "foo--password", "auth_token", "refresh-token", "accessToken", "secretKey", "PASSWORD2", "db.password"];
    const frames = [
      (k) => `${k}=${canary}`, (k) => `${k}: ${canary}`, (k) => `"${k}": "${canary}"`, (k) => `${k} = '${canary}'`,
      (k) => `export ${k}=${canary}`, (k) => `-H "${k}: Bearer ${canary}"`, (k) => `?${k}=${canary}&x=1`,
      (k) => `{"a":{"${k}":"${canary}"}}`, (k) => `${k}:\n  ${canary}`,
      (k) => `${k}: Basic${" ".repeat(8)}${canary}`, (k) => `${k}: Basic\t\t${canary}`,
      (k) => `${k}="${"a".repeat(300)} ${canary}"`, (k) => `${k} = "${"a".repeat(300)} ${canary}"`,
      (k) => `${k}: | #${"b".repeat(300)}\n  ${canary}\nnext: kept`,
      (k) => `${k}=<SECRET>${canary}`, (k) => `${k}=ghp_${"A".repeat(25)}:${canary}`,
    ];
    for (const frame of frames) {
      for (const key of keys) {
        const input = frame(key);
        const out = scrubResidueText(input);
        assert.equal(out.includes(canary), false, `${key} / ${input.slice(0, 40)}`);
        assert.equal(scrubResidueText(out), out, `idempotent: ${key} / ${input.slice(0, 40)}`);
      }
    }
    // a placeholder glued to the next key stays apart from it
    const glued = scrubResidueText('{password: ""password: "}');
    assert.equal(scrubResidueText(glued), glued);
    // not secret-named: left alone
    assert.equal(scrubResidueText("max_tokens: 4096 bypass=value tokenizer=fast"), "max_tokens: 4096 bypass=value tokenizer=fast");
  });

  test("M6: mixed-case key spellings, URL passwords that look like assignments, and trailing digits", () => {
    const canary = ["Minimal", "Own", "Canary7319"].join("");
    for (const key of ["passWord", "pAssword", "toKen", "aUthorization", "sEcret", "APIkEy", "client_sEcret", "AccessToken", "x-Api-Key"]) {
      const out = scrubResidueText(`${key}=${canary}`);
      assert.equal(out.includes(canary), false, key);
      assert.equal(scrubResidueText(out), out, key);
    }
    // the password of a URL is one password, even when it contains assignment syntax
    const url = scrubResidueText(`https://u:token='ok'${canary}@localhost/path and postgres://app:pw${canary}@db:5432/x`);
    assert.equal(url.includes(canary), false);
    assert.equal(url, "https://u:<SECRET>@localhost/path and postgres://app:<SECRET>@db:5432/x");
    // not secret-named: left alone, including near-misses and `max_tokens`
    for (const text of ["tokenizer2=fast", "Passwords=none", "compass=north", "spwd=1", "secretary=jane", "HTTP2=on", "max_tokens: 4096"]) {
      assert.equal(scrubResidueText(text), text);
    }
  });

  test("M6: long keys, invalid URL schemes, quoted values nested in unquoted ones, and exotic whitespace", () => {
    const canary = ["Review", "Seven", "Canary7319"].join("");
    const cases = {
      "secret word in the middle of a very long key": `${"a_".repeat(300)}password${"_b".repeat(300)} = ${canary}`,
      "1:// is not a URL": `1://u:token=abcd@h/${canary}`,
      "-:// is not a URL": `-://u:token=abcd@h/${canary}`,
      "digit-led scheme": `9http://u:token=abcd@h/${canary}`,
      "underscore-led scheme": `foo_https://u:token=abcd@h/${canary}`,
      "double-quoted URL password": `https://u:"${canary}"@localhost/path`,
      "single-quoted URL password": `https://u:'${canary}'@localhost/path`,
      "quoted value nested in an unquoted one": `token=prefix_password="${canary}"`,
      "quoted value nested in a quoted one": `password='token=prefix_password='${canary}''`,
      "an edit that unhides a URL password": `https://u:token=password='/'"@h/x`,
      "bearer after a doubled separator": `token==Bearer ${canary}`,
      "bearer after a blob": `${"A".repeat(250)}=Bearer ${canary}`,
      "assignment after a blob": `${"A".repeat(250)} api_key=${canary}`,
      "credential password with an invalid scheme": `1://u:${canary}@h/x`,
      "nbsp between URL parts": `https://u:ab\u00a0token="${canary}"@h/x`,
      "nbsp before a key": `x\u00a0password=${canary}`,
      "ideographic space before a key": `x\u3000token: "${canary}"`,
    };
    for (const [name, input] of Object.entries(cases)) {
      const out = scrubResidueText(input);
      assert.equal(out.includes(canary), false, name);
      assert.equal(scrubResidueText(out), out, `${name}: idempotent`);
    }
    // Unicode whitespace ends a URL password exactly as it did in the original regex: no "@" follows it
    // directly, so this is not a credential and the text is left as it was.
    assert.equal(scrubResidueText("https://u:ab\u00a0cd@h/x"), "https://u:ab\u00a0cd@h/x");
    assert.equal(scrubResidueText("https://us\u3000er:pw@h/x"), "https://us\u3000er:pw@h/x");
    // the host and path after a URL password are not secret, whatever else matches there
    for (const [input, expected] of [
      ["https://u:abcd@db.example.com/project", "https://u:<SECRET>@db.example.com/project"],
      ["https://u:token=abcd@localhost/path", "https://u:<SECRET>@localhost/path"],
      ["https://u:token='ok'x@db.example.com/path", "https://u:<SECRET>@db.example.com/path"],
      ["mail jane@example.com about https://x:pw1234@host.io/a?b=c", "mail <EMAIL> about https://x:<SECRET>@host.io/a?b=c"],
      ["user@host.example.com and https://a:b12345@c.example.org", "<EMAIL> and https://a:<SECRET>@c.example.org"],
      // a key AFTER the "@" is in the host/path/query, not the password: still found
      [`https://u:pw@h/x?token=x${["Zebra", "Canary7319"].join("")}`, "https://u:<SECRET>@h/x?token=<SECRET>"],
      // a nested UNQUOTED value stops at the password too
      ["https://u:token=password=abcd@localhost/path", "https://u:<SECRET>@localhost/path"],
      // an empty value in a password leaves the "@" alone
      ["https://u:token=@localhost/path", "https://u:<SECRET>@localhost/path"],
      // a quoted value is one string even when its closing quote comes after the "@"
      ['https://app:password="correct@Horse7319"@db.example.com/app', "https://app:<SECRET>@db.example.com/app"],
      ["https://app:password='correct@Horse7319'@db.example.com/app", "https://app:<SECRET>@db.example.com/app"],
    ]) {
      assert.equal(scrubResidueText(input), expected, input);
      assert.equal(scrubResidueText(expected), expected, `${input}: idempotent`);
    }
    // offsets survive a blob of astral characters (UTF-16 length, not code points), so prose after it is untouched
    assert.equal(scrubResidueText(`${"\u{1F600}".repeat(101)} then prose, mail a@b.example.com`), "<BLOB> then prose, mail <EMAIL>");
    assert.equal(scrubResidueText(`${"\u{1F600}".repeat(101)} keep this sentence intact. a@b.example.com`), "<BLOB> keep this sentence intact. <EMAIL>");
    // prose longer than the shift a wrong mask length would cause: it must come through byte for byte
    const prose = "this sentence is ordinary prose and must not be touched. ".repeat(6);
    assert.equal(scrubResidueText(`${"\u{1F600}".repeat(101)} ${prose}mail a@b.example.com`), `<BLOB> ${prose}mail <EMAIL>`);
    // a key past the "@" but inside a span a quoted value extended keeps its own value
    const witness = ["Zebra", "Mango", "7319"].join("");
    for (const q of ['"', "'"]) {
      const out = scrubResidueText(`curl https://app:token=password=${q}correct@db.example.com/app?api_key${q}=${witness}`);
      assert.equal(out.includes(witness), false, q);
      assert.equal(scrubResidueText(out), out, `${q}: idempotent`);
    }
    // a nested QUOTED value is one string, even when it holds the "@" that opens the host
    const nestedQuoted = scrubResidueText(`https://u:token=password="abc@host/path ${canary}"`);
    assert.equal(nestedQuoted.includes(canary), false);
    assert.equal(scrubResidueText(nestedQuoted), nestedQuoted);
    // a real URL password and a real scheme are still found
    assert.equal(scrubResidueText(`(ftp://u:p${canary}@h/x) and HTTPS://a:b@c`), "(ftp://u:<SECRET>@h/x) and HTTPS://a:<SECRET>@c");
  });

  test("the scrub is linear on pathological runs, and a data blob is replaced whole", () => {
    const REDACTION = path.join(HERE, "runtime-redaction.js");
    // Each input is built and scrubbed in a child process with a hard timeout, so a quadratic
    // regression fails in seconds instead of hanging the suite.
    const inputs = {
      "a-": '"a-".repeat(80000)',
      "a.": '"a.".repeat(80000)',
      "eyJ-": '"eyJ-".repeat(40000)',
      "sk-": '"sk-".repeat(60000)',
      "http-ish": '"a://b:".repeat(30000)',
      // assembled at run time so no private-key header is stored in the tree
      "BEGIN": '("-----BEGIN PRIV" + "ATE KEY-----\\n").repeat(8000)',
      "token_ in quotes": '`password="${"token_".repeat(30000)}"`',
      "stray quotes": "'password:\"'.repeat(30000)",
      "repeated key=": '"token=".repeat(60000)',
      "many keys in one quoted span": '`password="${"token=a ".repeat(40000)}"`',
      "url + quoted key chain": '\'https://u:token="p@h/x \'.repeat(60000) + \'end"\'',
      "url + unquoted key chain": "'https://u:token=p@h/x '.repeat(60000)",
      "span that would shrink": "'https://u:token=password=\"a@h/x '.repeat(40000) + 'token\"=TAILTAIL'",
      "alternating key chain": "'https://u:token=\"a@h/x password=b@h/x '.repeat(30000) + 'end\"'",
      "dense urls": "'https://u:p@h/ '.repeat(60000)",
      "trailing digits": '`${"1".repeat(2000000)}x`',
      "one huge identifier": '`${"a-".repeat(1000000)}token=${"S".repeat(10)}`',
      "camelCase identifier": '"camelCaseIdentifierSegment".repeat(40000)',
    };
    for (const [name, expression] of Object.entries(inputs)) {
      const code =
        `import { scrubResidueText } from ${JSON.stringify(`file://${REDACTION}`)};` +
        `const input = ${expression}; const started = Date.now(); const out = scrubResidueText(input);` +
        `console.log(JSON.stringify({ ms: Date.now() - started, idempotent: scrubResidueText(out) === out }));`;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 20000, maxBuffer: 1 << 20 });
      assert.equal(child.error, undefined, `${name}: did not finish in 20 s (${child.error?.code})`);
      assert.equal(child.status, 0, `${name}: ${child.stderr.slice(0, 200)}`);
      const result = JSON.parse(child.stdout);
      assert.ok(result.ms < 3000, `${name}: ${result.ms} ms`);
      assert.equal(result.idempotent, true, `${name}: idempotent`);
    }
    assert.equal(scrubResidueText(`before ${"A".repeat(2000)} after`), "before <BLOB> after");
    assert.equal(scrubResidueText(`k ${"A".repeat(200)} z`), `k ${"A".repeat(200)} z`);
    assert.equal(scrubResidueText(`k ${"A".repeat(201)} z`), "k <BLOB> z");
    const pem = ["-----BEGIN RSA ", "PRIVATE KEY-----\nMIIBOgIBAAJB\n-----END RSA ", "PRIVATE KEY-----"].join("");
    assert.equal(scrubResidueText(`a ${pem} b`), "a <SECRET> b");
  });

  test("F6: Claude harness entries are excluded per record, for every message the record produced", () => {
    const toolAndText = claudeRec(
      [{ type: "tool_result", tool_use_id: "t1", content: "x" }, { type: "text", text: "LEAK_PEER_MIXED" }],
      { uuid: "m1", origin: { kind: "peer", from: "w", body: "b" } },
    );
    const dupHuman = claudeRec("REAL_HUMAN_SAME_UUID", { uuid: "dup", timestamp: "2026-10-30T09:00:01.000Z", origin: { kind: "human" } });
    const dupPeer = claudeRec("PEER_SAME_UUID", { uuid: "dup", timestamp: "2026-10-30T09:00:02.000Z", origin: { kind: "peer" } });
    const { box } = single("claude-code", ndjson([claudeRec("HUMAN_ONE"), toolAndText, dupHuman, dupPeer]));
    const out = JSON.stringify(run(box).residues);
    assert.equal(out.includes("LEAK_PEER_MIXED"), false);
    assert.equal(out.includes("PEER_SAME_UUID"), false);
    assert.match(out, /REAL_HUMAN_SAME_UUID/);
    assert.match(out, /HUMAN_ONE/);
  });

  test("F7: Codex developer items are excluded per record, whatever their timestamp or text", () => {
    const numeric = { ...codexMsg("developer", "NUMERIC_DEVELOPER"), timestamp: Date.parse(STAMP) };
    const { box } = single(
      "codex",
      ndjson([
        codexMeta(),
        numeric,
        codexMsg("developer", "SAME_TEXT", "2026-10-30T09:00:03.000Z"),
        codexMsg("user", "SAME_TEXT", "2026-10-30T09:00:03.000Z"),
        codexMsg("assistant", "answer", "2026-10-30T09:00:04.000Z"),
      ]),
    );
    const result = run(box);
    assert.equal(result.report.blocked.length, 0);
    const out = JSON.stringify(result.residues);
    assert.equal(out.includes("NUMERIC_DEVELOPER"), false);
    assert.equal((out.match(/SAME_TEXT/g) || []).length, 1, "the genuine user turn survives, the developer one does not");
  });

  test("F8: a conversation record with no source timestamp is drift, so hashes never depend on the clock", () => {
    for (const [runtime, body] of [
      ["codex", ndjson([codexMeta(), { ...codexMsg("user", "NO_TIME"), timestamp: undefined }])],
      ["claude-code", ndjson([claudeRec("NO_TIME", { timestamp: undefined })])],
    ]) {
      const { box } = single(runtime, body);
      const result = run(box);
      assert.equal(result.residues.length, 0, runtime);
      assert.equal(result.report.blocked[0].reason, "UNKNOWN_TRANSCRIPT_FORMAT", runtime);
    }
  });

  test("F9: invalid UTF-8 in a complete line is drift, not silently replaced", () => {
    const line = Buffer.from(ndjson([claudeRec("PLACEHOLDER_TEXT")]));
    const at = line.indexOf("PLACEHOLDER_TEXT");
    line[at] = 0xff;
    const { box } = single("claude-code", line);
    const result = run(box);
    assert.equal(result.residues.length, 0);
    assert.equal(result.report.blocked[0].reason, "UNKNOWN_TRANSCRIPT_FORMAT");
  });

  test("M7: only records Ferry imports need a source time; excluded entries are never inspected", () => {
    const noTime = (rec) => ({ ...rec, timestamp: undefined });
    for (const [runtime, rows] of [
      ["codex", [codexMeta(), codexMsg("user", "REAL_ONE"), noTime({ type: "event_msg", payload: { type: "task_complete" } }), noTime({ type: "event_msg", payload: { type: "token_count", info: null } }), noTime(codexMsg("developer", "DEV_NO_TIME"))]],
      ["claude-code", [claudeRec("REAL_ONE"), noTime(claudeRec("PEER_NO_TIME", { uuid: "p", origin: { kind: "peer" } })), noTime({ type: "queue-operation", operation: "enqueue", sessionId: UID })]],
    ]) {
      const { box } = single(runtime, ndjson(rows));
      const result = run(box);
      assert.equal(result.report.blocked.length, 0, runtime);
      assert.match(JSON.stringify(result.residues), /REAL_ONE/, runtime);
    }
  });

  test("M8: a missing transcript for a recent event holds the cursor until it appears; an old event is skipped", () => {
    const box = sandbox();
    const gone = path.join(box.roots[0], "late.jsonl");
    appendTelemetry(box, { ...event("claude-code", gone), timestamp: String(NOW - 5 * 60 * 1000) });
    const first = run(box);
    assert.deepEqual(first.report.blocked.map((b) => b.reason), ["TRANSCRIPT_MISSING_RECENT"]);
    assert.equal(first.candidateCursor.telemetry.offset, 0);
    fs.writeFileSync(gone, ndjson([claudeRec("APPEARED_LATER")]));
    const second = run(box, { cursor: first.candidateCursor });
    assert.match(JSON.stringify(second.residues), /APPEARED_LATER/);
    assert.equal(second.report.cursor_held, false);

    const old = sandbox();
    appendTelemetry(old, { ...event("claude-code", path.join(old.roots[0], "gone.jsonl")), timestamp: String(NOW - 48 * 60 * 60 * 1000) });
    const result = run(old);
    assert.deepEqual(result.report.skipped.map((s) => s.reason), ["TRANSCRIPT_MISSING"]);
    assert.equal(result.candidateCursor.telemetry.offset, fs.statSync(old.telemetryFile).size);
  });

  test("M7: Claude isMeta and sidechain records Ferry skips never need a source time", () => {
    const noTime = (extra) => claudeRec("SKIPPED_BY_FERRY", { ...extra, timestamp: undefined });
    const { box } = single("claude-code", ndjson([claudeRec("REAL_ONE"), noTime({ isMeta: true, uuid: "m" }), noTime({ isSidechain: true, uuid: "s" })]));
    const result = run(box);
    assert.equal(result.report.blocked.length, 0);
    assert.match(JSON.stringify(result.residues), /REAL_ONE/);
    assert.equal(JSON.stringify(result.residues).includes("SKIPPED_BY_FERRY"), false);
  });

  test("M8: a missing transcript whose telemetry timestamp is unusable or in the future is a diagnosed hold, never a silent skip", () => {
    for (const timestamp of [undefined, null, "", "not-a-number", String(NOW + 24 * 60 * 60 * 1000), 0]) {
      const box = sandbox();
      appendTelemetry(box, { ...event("claude-code", path.join(box.roots[0], "gone.jsonl")), timestamp });
      const result = run(box);
      assert.deepEqual(result.report.blocked.map((b) => b.reason), ["TELEMETRY_BAD_TIMESTAMP"], String(timestamp));
      assert.equal(result.report.skipped.length, 0, String(timestamp));
      assert.equal(result.candidateCursor.telemetry.offset, 0, String(timestamp));
    }
  });

  test("M1: a touch that changes only the mtime during the read holds the cursor", () => {
    const { box, file } = single("claude-code", ndjson([claudeRec("FIRST_LINE")]));
    const real = fs.realpathSync.native(file);
    const { statSync } = cjsFs;
    let touched = false;
    cjsFs.statSync = function (target, ...rest) {
      if (String(target) === real && !touched) {
        touched = true;
        fs.utimesSync(real, new Date(), new Date(Date.now() + 5000));
      }
      return statSync.call(this, target, ...rest);
    };
    syncBuiltinESMExports();
    let first;
    try {
      first = run(box);
    } finally {
      cjsFs.statSync = statSync;
      syncBuiltinESMExports();
    }
    assert.equal(touched, true, "the touch hook must have fired");
    assert.deepEqual(first.report.blocked.map((b) => b.reason), ["TRANSCRIPT_CHANGED_DURING_READ"]);
  });

  test("M9: a conversation-shaped record of an unrecognized type is drift; known non-conversation types are not", () => {
    for (const [runtime, body] of [
      ["claude-code", ndjson([claudeRec("UNREAD_CONVERSATION", { type: "human-v2" })])],
      ["codex", ndjson([codexMeta(), { ...codexMsg("user", "UNREAD_CONVERSATION"), type: "response_item_v2" }])],
    ]) {
      const { box } = single(runtime, body);
      const result = run(box);
      assert.equal(result.residues.length, 0, runtime);
      assert.equal(result.report.blocked[0].reason, "UNKNOWN_TRANSCRIPT_FORMAT", runtime);
      assert.equal(result.candidateCursor.telemetry.offset, 0, runtime);
    }
    const { box } = single(
      "claude-code",
      ndjson([claudeRec("KNOWN_GOOD"), { type: "api-request-blob", sessionId: UID, timestamp: STAMP, message: { role: "user", content: "RAW_API_PAYLOAD" } }]),
    );
    const result = run(box);
    assert.equal(result.report.blocked.length, 0);
    assert.equal(JSON.stringify(result.residues).includes("RAW_API_PAYLOAD"), false);
  });

  test("M1: growth between the post-read fstat and the later stat holds the cursor", () => {
    const { box, file } = single("claude-code", ndjson([claudeRec("FIRST_LINE")]));
    const real = fs.realpathSync.native(file);
    const { statSync } = cjsFs;
    let grown = false;
    cjsFs.statSync = function (target, ...rest) {
      if (String(target) === real && !grown) {
        grown = true;
        fs.appendFileSync(real, ndjson([claudeRec("APPENDED_LATE", { uuid: "u2", timestamp: "2026-10-30T09:00:05.000Z" })]));
      }
      return statSync.call(this, target, ...rest);
    };
    syncBuiltinESMExports();
    let first;
    try {
      first = run(box);
    } finally {
      cjsFs.statSync = statSync;
      syncBuiltinESMExports();
    }
    assert.equal(grown, true, "the growth hook must have fired");
    assert.deepEqual(first.report.blocked.map((b) => b.reason), ["TRANSCRIPT_CHANGED_DURING_READ"]);
    assert.equal(first.candidateCursor.telemetry.offset, 0);
  });

  test("a transcript path spelled with different letter case on a case-insensitive filesystem stays inside its root", (t) => {
    const probe = path.join(os.tmpdir(), `case-probe-${process.pid}`);
    fs.writeFileSync(probe, "");
    const insensitive = fs.existsSync(probe.toUpperCase().replace(os.tmpdir().toUpperCase(), os.tmpdir()));
    fs.rmSync(probe);
    if (!insensitive) return t.skip("case-sensitive filesystem");
    const { box, file } = single("claude-code", ndjson([claudeRec("CASE_ALIAS")]));
    // The host spells its authorized root with different case than the telemetry path does.
    const aliasRoot = path.join(path.dirname(box.roots[0]), path.basename(box.roots[0]).toUpperCase());
    const result = run(box, { transcriptRoots: [aliasRoot, box.roots[1]] });
    assert.equal(result.report.skipped.some((s) => s.reason === "TRANSCRIPT_OUTSIDE_ROOTS"), false);
    assert.match(JSON.stringify(result.residues), /CASE_ALIAS/);
    assert.ok(file);
  });

  test("F10: a Codex rollout with a session_meta and no conversation is skipped, not blocked", () => {
    const { box } = single("codex", ndjson([codexMeta()]));
    const result = run(box);
    assert.equal(result.report.blocked.length, 0);
    assert.deepEqual(result.report.skipped.map((s) => s.reason), ["NO_CONVERSATION"]);
    assert.equal(result.candidateCursor.telemetry.offset, fs.statSync(box.telemetryFile).size);
  });
});

describe("kit manifest", () => {
  test("kit.json is unchanged by the Codex bundle's runtime-name rewrite", () => {
    // `flow-agents init --runtime codex` rewrites "Claude Code" to "Codex" in shipped text, and
    // `workflow doctor` hashes the installed kit.json against the packaged one. A manifest that
    // names the other runtime therefore reads as drifted on every Codex install.
    const manifest = fs.readFileSync(path.join(KIT, "kit.json"), "utf8");
    assert.equal(manifest.includes("Claude Code"), false);
  });
});

describe("injected-memory marker", () => {
  test("the marker module is dependency-free and its names and values are stable", () => {
    const markerFile = path.join(KIT, "memory-marker.js");
    const hooks = path.join(os.tmpdir(), `marker-hooks-${process.pid}.mjs`);
    fs.writeFileSync(
      hooks,
      "export async function resolve(s, c, n) { console.error('RESOLVE ' + s); return n(s, c); }\n",
    );
    const bootstrap = `import { register } from "node:module"; register(${JSON.stringify(`file://${hooks}`)});`;
    const child = spawnSync(
      process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`, "--input-type=module", "-e",
        `import(${JSON.stringify(`file://${markerFile}`)}).then((m) => console.log(JSON.stringify(m)))`],
      { encoding: "utf8" },
    );
    fs.rmSync(hooks);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      INJECTED_MEMORY_OPEN: "<flow-agents-injected-memory>",
      INJECTED_MEMORY_CLOSE: "</flow-agents-injected-memory>",
    });
    const resolved = child.stderr.split("\n").filter((l) => l.startsWith("RESOLVE "));
    assert.ok(resolved.length >= 1, "resolve hook must have observed the import");
    assert.deepEqual(resolved.filter((l) => !l.endsWith("memory-marker.js")), [], "marker module must import nothing");
    assert.equal(INJECTED_MEMORY_OPEN, "<flow-agents-injected-memory>");
  });

  test("closed and unterminated injected-memory blocks are removed before residue", () => {
    assert.equal(
      stripInjectedContent(`before ${INJECTED_MEMORY_OPEN}memory${INJECTED_MEMORY_CLOSE} after`),
      "before  after",
    );
    assert.equal(stripInjectedContent(`keep ${INJECTED_MEMORY_OPEN} memory with no close`), "keep");
    assert.equal(stripInjectedContent("<system-reminder>x</system-reminder>hi"), "hi");
  });
});

// Ferry 0.8 / Thread 0.7 record who wrote each user message in `origin.kind`. A kept user turn is the person speaking
// (it becomes a claim's speaker), so only `human` is kept. The records below are in the shapes Claude Code and Codex
// write (keys and enumerated values as in Ferry's own provenance fixtures; every text, id and time is synthetic), and
// each test first imports them with Ferry itself, so the Threads are exactly what Ferry 0.8 produces and each case is
// shown to reach the origin kind it is named for. The cases that matter most are those the line-level shims in
// runtime-ferry-shims.js do not remove, so only the origin filter can keep them out of a sitting.
describe("Thread origin: only human-authored user messages reach a sitting", () => {
  const CLAUDE_UID = "5b1f2c3d-0000-4000-8000-00000000e001";
  const CODEX_UID = "019a0000-0000-7000-8000-00000000e002";
  const at = (s) => `2026-11-01T09:00:${String(s).padStart(2, "0")}.000Z`;
  const claudeUser = (n, text, extra = {}) => ({
    parentUuid: null, isSidechain: false, type: "user", uuid: `00000000-0000-4000-8000-0000000e00${String(n).padStart(2, "0")}`,
    timestamp: at(n), cwd: "/w", sessionId: CLAUDE_UID, version: "2.1.321", gitBranch: "main", userType: "external",
    message: { role: "user", content: text }, ...extra,
  });
  const claudeAssistant = (n, text) => ({
    parentUuid: null, isSidechain: false, type: "assistant", uuid: `00000000-0000-4000-8000-0000000e00${String(n).padStart(2, "0")}`,
    timestamp: at(n), cwd: "/w", sessionId: CLAUDE_UID, version: "2.1.321", gitBranch: "main",
    message: { model: "claude-opus-5-5", id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    requestId: `req_${n}`,
  });
  const codexMeta = (source) => ({ timestamp: at(0), ordinal: 0, type: "session_meta", payload: { id: CODEX_UID, session_id: CODEX_UID, timestamp: at(0), cwd: "/w", originator: "codex-tui", cli_version: "0.164.0", source, thread_source: "user", model_provider: "openai" } });
  const codexUser = (n, text, passthrough) => ({
    timestamp: at(n), ordinal: n, type: "response_item",
    payload: { type: "message", id: `msg_e${n}`, role: "user", content: [{ type: "input_text", text }], ...(passthrough ? { internal_chat_message_metadata_passthrough: { turn_id: "t", ...passthrough } } : {}) },
  });
  const codexAgentMessage = (n, text) => ({
    timestamp: at(n), ordinal: n, type: "response_item",
    payload: { type: "agent_message", id: `am${n}`, author: "/root/worker", recipient: "/root", content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { turn_id: "t", content_item_metadata: [{ provenance: { type: "tool", namespace: "collaboration" } }] } },
  });
  const codexAssistant = (n, text) => ({
    timestamp: at(n), ordinal: n, type: "response_item",
    payload: { type: "message", status: "completed", id: `msg_e${n}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text, annotations: [] }] },
  });
  const lines = (records) => records.map((record) => JSON.stringify(record));
  const buffer = (records) => Buffer.from(`${lines(records).join("\n")}\n`);
  /** The Thread Ferry 0.8 imports from these records, unfiltered. */
  const ferryThread = (create, records) => {
    const importer = create({});
    importer.pushLines(lines(records));
    importer.finalize();
    return importer.thread();
  };
  /** Each user message's first text, mapped to the origin kind Ferry derived for it. */
  const userOrigins = (thread) => Object.fromEntries(thread.messages.filter((m) => m.role === "user").map((m) => [m.content.find((p) => p.type === "text")?.text, m.origin?.kind]));
  const kept = (conversation) => conversation.messages.map((m) => `${m.role}:${m.text}`);

  const CLAUDE = [
    claudeUser(1, "TYPED_HUMAN_PROMPT", { origin: { kind: "human" }, promptSource: "typed" }),
    claudeAssistant(2, "CLAUDE_REPLY_ONE"),
    // An SDK client submitted it: a person or an orchestrator. Claude Code stamps origin human on these too.
    claudeUser(3, "SDK_BRIEF_MARKER", { promptSource: "sdk" }),
    claudeUser(4, "SDK_HUMAN_LABEL_MARKER", { origin: { kind: "human" }, promptSource: "sdk" }),
    // The model wrote it and a person only accepted it.
    claudeUser(5, "ACCEPTED_SUGGESTION_MARKER", { origin: { kind: "human" }, promptSource: "suggestion_accepted" }),
    // A record with neither field, as Claude Code wrote before it recorded them.
    claudeUser(6, "NO_SIGNAL_MARKER"),
    claudeUser(7, "PEER_AGENT_MARKER", { origin: { kind: "peer", from: "fixture-id-1" }, promptSource: "system" }),
    claudeAssistant(8, "CLAUDE_REPLY_TWO"),
  ];

  test("Claude Code: a typed prompt is kept; SDK, accepted-suggestion and unsignalled prompts are unknown and dropped", () => {
    assert.deepEqual(userOrigins(ferryThread(createClaudeCodeImporter, CLAUDE)), {
      TYPED_HUMAN_PROMPT: "human",
      SDK_BRIEF_MARKER: "unknown",
      SDK_HUMAN_LABEL_MARKER: "unknown",
      ACCEPTED_SUGGESTION_MARKER: "unknown",
      NO_SIGNAL_MARKER: "unknown",
      PEER_AGENT_MARKER: "agent",
    });
    const conversation = readConversation("claude-code", buffer(CLAUDE));
    assert.equal(conversation.sessionId, CLAUDE_UID);
    assert.deepEqual(kept(conversation), ["user:TYPED_HUMAN_PROMPT", "assistant:CLAUDE_REPLY_ONE", "assistant:CLAUDE_REPLY_TWO"]);
    // The peer record's raw origin is not human, so the line shim removes it before import and it counts as unknown.
    assert.deepEqual(conversation.droppedUserTurns, { unknown: 5 }, "each dropped user turn is counted");
  });

  const CODEX = [
    codexMeta("cli"),
    codexUser(1, "CLI_HUMAN_PROMPT", { content_item_kinds: ["user.text"], content_item_metadata: [{ provenance: { type: "user" } }] }),
    codexAssistant(2, "CODEX_REPLY_ONE"),
    // An inter-agent message delivered to this session: Ferry 0.6 dropped it, Ferry 0.8 imports it as a user message.
    codexAgentMessage(3, "AGENT_BRIEF_MARKER"),
    // Harness provenance on plain text: no wrapper tag the tag list could strip.
    codexUser(4, "HARNESS_PROVENANCE_MARKER", { content_item_kinds: ["generic.turn_aborted"], content_item_metadata: [{ provenance: { type: "harness", hook: false } }] }),
    codexUser(5, "UNKNOWN_KIND_MARKER", { content_item_kinds: ["unknown"] }),
    codexAssistant(6, "CODEX_REPLY_TWO"),
  ];

  test("Codex: a cli prompt is kept; an agent_message, harness provenance and an unknown item are dropped", () => {
    assert.deepEqual(userOrigins(ferryThread(createCodexImporter, CODEX)), {
      CLI_HUMAN_PROMPT: "human",
      AGENT_BRIEF_MARKER: "agent",
      HARNESS_PROVENANCE_MARKER: "harness",
      UNKNOWN_KIND_MARKER: "unknown",
    });
    const conversation = readConversation("codex", buffer(CODEX));
    assert.deepEqual(kept(conversation), ["user:CLI_HUMAN_PROMPT", "assistant:CODEX_REPLY_ONE", "assistant:CODEX_REPLY_TWO"]);
    assert.deepEqual(conversation.droppedUserTurns, { agent: 1, harness: 1, unknown: 1 });
  });

  test("Codex: a session started by a client that relays people and orchestrators (exec) has no human turns", () => {
    const records = [codexMeta("exec"), codexUser(1, "EXEC_PROMPT_MARKER"), codexAssistant(2, "EXEC_REPLY")];
    assert.deepEqual(userOrigins(ferryThread(createCodexImporter, records)), { EXEC_PROMPT_MARKER: "unknown" });
    const conversation = readConversation("codex", buffer(records));
    assert.deepEqual(kept(conversation), ["assistant:EXEC_REPLY"]);
    assert.deepEqual(conversation.droppedUserTurns, { unknown: 1 });
  });

  // Ferry 0.8 reads Claude Code's own origin.kind first but trusts promptSource typed/queued over an origin it does not
  // map, so each record below would import as human. The line shim removes any record whose raw origin is not
  // { kind: "human" }, and the run counts it as unknown.
  for (const [name, extra] of [
    ["an unclassified origin.kind", { origin: { kind: "unclassified" }, promptSource: "typed" }],
    ["an origin.kind Ferry does not know yet", { origin: { kind: "observer" }, promptSource: "queued" }],
    ["a non-object origin", { origin: "peer", promptSource: "typed" }],
  ]) {
    test(`Claude Code: ${name} with a typed prompt source is not read as the person`, () => {
      const records = [claudeUser(1, "UNMAPPED_ORIGIN_MARKER", extra), claudeAssistant(2, "UNMAPPED_REPLY")];
      assert.deepEqual(userOrigins(ferryThread(createClaudeCodeImporter, records)), { UNMAPPED_ORIGIN_MARKER: "human" }, "Ferry alone reads it as human");
      const conversation = readConversation("claude-code", buffer(records));
      assert.deepEqual(kept(conversation), ["assistant:UNMAPPED_REPLY"]);
      assert.deepEqual(conversation.droppedUserTurns, { unknown: 1 });
    });
  }

  test("a user message with no origin is drift: the importer did not derive one, so nothing says a person wrote it", () => {
    const thread = ferryThread(createCodexImporter, CODEX);
    assert.deepEqual(kept(conversationFromThread(thread)), ["user:CLI_HUMAN_PROMPT", "assistant:CODEX_REPLY_ONE", "assistant:CODEX_REPLY_TWO"]);
    const human = thread.messages.find((m) => m.role === "user" && m.origin?.kind === "human");
    delete human.origin;
    assert.throws(() => conversationFromThread(thread), (error) => error instanceof TranscriptFormatError && error.reason === "UNKNOWN_TRANSCRIPT_FORMAT" && /no origin/.test(error.message));
  });

  test("a Claude Code subagent's own transcript is a sidechain, as a Codex subagent rollout is", () => {
    // As Claude Code writes a subagent's transcript: every record a sidechain carrying the agent id, and the brief a
    // user record with no origin or promptSource (the parent agent wrote it).
    const sub = (record) => ({ ...record, isSidechain: true, agentId: "a0e1" });
    const records = [sub(claudeUser(1, "SUBAGENT_BRIEF_MARKER")), sub(claudeAssistant(2, "SUBAGENT_REPLY_MARKER"))];
    const thread = ferryThread(createClaudeCodeImporter, records);
    assert.equal(thread.metadata.custom.claudeSubagent.parentSessionId, CLAUDE_UID, "Ferry 0.8 imports it as a subagent thread");
    assert.deepEqual(userOrigins(thread), { SUBAGENT_BRIEF_MARKER: "agent" });
    const conversation = readConversation("claude-code", buffer(records));
    assert.equal(conversation.sidechain, true);
    assert.equal(conversation.sessionId, CLAUDE_UID);
    assert.deepEqual(conversation.messages, []);
  });
});
