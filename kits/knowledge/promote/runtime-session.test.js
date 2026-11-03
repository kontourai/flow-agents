/**
 * #669 — residue contract, runtime-session source, watermark cursor, scrub.
 *
 * Fixtures under fixtures/runtime/ are SYNTHETIC transcripts in the exact
 * record shapes Claude Code project JSONL and Codex rollout JSONL use. Secret-
 * shaped canaries are stored as `__CANARY_*__` placeholders and assembled from
 * fragments here, so no detector-shaped literal is committed.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { stripInjectedContent } from "./runtime-transcript.js";
import { validate } from "../providers/lib/schema-validate.js";

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
  test("Claude Code project JSONL yields user/assistant text sittings with provenance", () => {
    const box = sandbox();
    appendTelemetry(box, event("claude-code", box.claudeTranscript));
    const { residues, report } = run(box);
    assert.equal(report.blocked.length, 0);
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
    assert.equal(second.provenance.gitBranch, "feat/retry-budget-test");
    assert.equal(second.provenance.startedAt, "2026-10-30T10:30:00.000Z");
    assert.deepEqual(first.turns.map((t) => t.role), ["user", "assistant", "user", "assistant"]);
    assert.match(first.turns[0].text, /^The retry budget in the widget service resets too early\./);
    assert.match(first.turns[2].text, /Ok, make it reset only after a successful call\.$/);
    assert.match(first.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first.complete, true);

    const all = JSON.stringify(residues);
    for (const dropped of [
      "harness reminder text", // <system-reminder>
      "/clear", // meta command entry
      "private chain of thought", // thinking
      "TOOL_RESULT_ONLY_MARKER", // tool_result
      "cat config/.env", // tool_use input
      "SIDECHAIN_ONLY_MARKER", // isSidechain
      "<task-id>", // harness-originated task notification
      "COMPACT_SUMMARY_MARKER", // compact summary
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

  test("a trailing partial transcript line is left for the next run", () => {
    const box = sandbox();
    fs.appendFileSync(
      box.claudeTranscript,
      JSON.stringify({ type: "user", sessionId: CLAUDE_SESSION, timestamp: "2026-10-30T10:32:00.000Z", message: { role: "user", content: "PARTIAL_LINE" } }),
    );
    appendTelemetry(box, event("claude-code", box.claudeTranscript));
    const { residues, report } = run(box);
    assert.equal(report.blocked.length, 0);
    assert.equal(JSON.stringify(residues).includes("PARTIAL_LINE"), false);
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
        parentUuid: null, isSidechain: false, type: "user", uuid: "late", timestamp: "2026-10-30T10:35:00.000Z",
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

describe("injected-memory marker", () => {
  test("closed and unterminated injected-memory blocks are removed before residue", () => {
    assert.equal(
      stripInjectedContent(`before ${INJECTED_MEMORY_OPEN}memory${INJECTED_MEMORY_CLOSE} after`),
      "before  after",
    );
    assert.equal(stripInjectedContent(`keep ${INJECTED_MEMORY_OPEN} memory with no close`), "keep");
    assert.equal(stripInjectedContent("<system-reminder>x</system-reminder>hi"), "hi");
  });
});
