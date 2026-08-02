import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ingestFromSource,
  ingestRuntimeSessions,
  ingestSession,
  SESSION_SOURCE_IDS,
} from "./index.js";
import { validate } from "../providers/lib/schema-validate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SESSION = "kits/knowledge/promote/fixtures/session";
const RUNTIME_FIXTURES = path.join(__dirname, "fixtures", "runtime");
const RESIDUE_SCHEMA = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, "schemas", "knowledge", "residue.schema.json"),
    "utf8",
  ),
);
const LEGACY_RESIDUE_SHA256 =
  "125472127a81379e2892d2e885b79e22bfd55349d7679df6e15d7dec4d130315";

function tempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-runtime-ingest-"));
  const transcripts = path.join(root, "transcripts");
  fs.mkdirSync(transcripts);
  for (const name of ["claude-project.jsonl", "codex-rollout.jsonl", "unknown.jsonl"]) {
    fs.copyFileSync(
      path.join(RUNTIME_FIXTURES, name),
      path.join(transcripts, name),
    );
  }
  return {
    root,
    transcripts,
    telemetryFile: path.join(root, "full.jsonl"),
    cursorFile: path.join(root, "dream", "runtime-session.cursor.json"),
  };
}

function telemetryRecord({ eventId, runtime, sessionId, transcriptPath }) {
  return {
    schema_version: "0.3.0",
    timestamp: "2026-07-19T01:00:00Z",
    session_id: `telemetry-${sessionId}`,
    event_id: eventId,
    event_type: "session.end",
    agent: { name: "dev", runtime, version: "fixture" },
    hook: {
      event_name: "Stop",
      runtime_session_id: sessionId,
      turn_id: "",
      transcript_path: transcriptPath,
      model: "",
      source: "fixture",
      stop_hook_active: null,
      last_assistant_message: "",
      raw_input: null,
    },
  };
}

function writeTelemetry(file, records) {
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function assertSchemaValid(residue) {
  const result = validate(residue, RESIDUE_SCHEMA);
  assert.equal(result.valid, true, result.errors.join("\n"));
}

function assertSchemaInvalid(residue) {
  assert.equal(validate(residue, RESIDUE_SCHEMA).valid, false);
}

describe("AC1: residue contract and workflow-sidecar compatibility", () => {
  test("keeps the legacy workflow-sidecar residue byte-identical", () => {
    const residue = ingestSession(SESSION);
    const digest = createHash("sha256")
      .update(JSON.stringify(residue))
      .digest("hex");

    assert.equal(digest, LEGACY_RESIDUE_SHA256);
    assertSchemaValid(residue);
    assert.deepEqual(SESSION_SOURCE_IDS, ["workflow-sidecar", "runtime-session"]);
  });

  test("normalizes the workflow-sidecar source through the pluggable dispatcher", () => {
    const result = ingestFromSource("workflow-sidecar", SESSION);
    assert.equal(result.residues.length, 1);
    assert.deepEqual(result.residues[0], ingestSession(SESSION));
    assert.equal(result.report.sessions_ingested, 1);
  });

  test("rejects partial or undiscriminated runtime residue variants", () => {
    const legacy = ingestSession(SESSION);
    assertSchemaInvalid({ ...legacy, source: "runtime-session" });
    assertSchemaInvalid({ ...legacy, runtime: "codex", transcriptEntries: [] });
    assertSchemaInvalid({
      ...legacy,
      source: "runtime-session",
      runtime: "codex",
      transcriptEntries: [],
    });
  });
});

describe("AC2: runtime telemetry, transcript formats, and watermark", () => {
  test("ingests Claude and Codex fixtures, then skips them at the cursor", () => {
    const fixture = tempRuntime();
    writeTelemetry(fixture.telemetryFile, [
      telemetryRecord({
        eventId: "evt-claude",
        runtime: "claude-code",
        sessionId: "claude-session",
        transcriptPath: path.join(fixture.transcripts, "claude-project.jsonl"),
      }),
      telemetryRecord({
        eventId: "evt-codex",
        runtime: "codex",
        sessionId: "codex-session",
        transcriptPath: path.join(fixture.transcripts, "codex-rollout.jsonl"),
      }),
    ]);

    const first = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile,
      cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts],
      now: () => "2026-07-19T02:00:00.000Z",
    });

    assert.equal(first.report.sessions_ingested, 2);
    assert.equal(first.report.blocked, false);
    assert.deepEqual(
      first.residues.map(({ runtime }) => runtime),
      ["claude-code", "codex"],
    );
    for (const residue of first.residues) {
      assert.deepEqual(
        [...new Set(residue.transcriptEntries.map(({ kind }) => kind))],
        ["message", "tool-call", "tool-result"],
        `${residue.runtime} fixture must exercise every supported entry kind`,
      );
      assert.deepEqual(
        residue.transcriptEntries.map(({ sequence }) => sequence),
        residue.transcriptEntries.map((_, sequence) => sequence),
      );
    }
    first.residues.forEach(assertSchemaValid);
    assert.equal(first.cursor.byte_offset, fs.statSync(fixture.telemetryFile).size);
    const claudeResidue = first.residues.find(({ runtime }) => runtime === "claude-code");
    const claudeToolResults = claudeResidue.transcriptEntries.filter(({ text }) =>
      text.includes("Tool result marker"));
    assert.equal(claudeToolResults.length, 1, "Claude tool results must not be duplicated");
    assert.equal(claudeToolResults[0].kind, "tool-result");

    const second = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile,
      cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts],
      now: () => "2026-07-19T03:00:00.000Z",
    });
    assert.equal(second.residues.length, 0);
    assert.equal(second.report.telemetry_records_scanned, 0);
    assert.equal(second.cursor.byte_offset, first.cursor.byte_offset);

    fs.appendFileSync(
      fixture.telemetryFile,
      `${JSON.stringify(
        telemetryRecord({
          eventId: "evt-claude-repeat",
          runtime: "claude-code",
          sessionId: "claude-session",
          transcriptPath: path.join(
            fixture.transcripts,
            "claude-project.jsonl",
          ),
        }),
      )}\n`,
    );
    const repeated = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile,
      cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts],
    });
    assert.equal(repeated.residues.length, 0);
    assert.equal(repeated.report.telemetry_records_scanned, 1);
    assert.equal(repeated.report.records_skipped, 1);
    assert.equal(
      repeated.cursor.byte_offset,
      fs.statSync(fixture.telemetryFile).size,
    );
  });

  test("stops before a drifted transcript and never advances past it", () => {
    const fixture = tempRuntime();
    const unknownPath = path.join(fixture.transcripts, "unknown.jsonl");
    const records = [
      telemetryRecord({
        eventId: "evt-good",
        runtime: "claude-code",
        sessionId: "good-session",
        transcriptPath: path.join(fixture.transcripts, "claude-project.jsonl"),
      }),
      telemetryRecord({
        eventId: "evt-drift",
        runtime: "claude-code",
        sessionId: "drift-session",
        transcriptPath: unknownPath,
      }),
      telemetryRecord({
        eventId: "evt-after",
        runtime: "codex",
        sessionId: "after-session",
        transcriptPath: path.join(fixture.transcripts, "codex-rollout.jsonl"),
      }),
    ];
    writeTelemetry(fixture.telemetryFile, records);

    const first = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile,
      cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts],
    });
    assert.equal(first.residues.length, 1);
    assert.equal(first.report.blocked, true);
    assert.equal(first.report.failures[0].code, "UNKNOWN_TRANSCRIPT_FORMAT");
    const blockedOffset = first.cursor.byte_offset;
    assert.ok(blockedOffset > 0);
    assert.ok(blockedOffset < fs.statSync(fixture.telemetryFile).size);

    const second = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile,
      cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts],
    });
    assert.equal(second.residues.length, 0);
    assert.match(second.report.failures[0].event_id, /^event-[a-f0-9]{24}$/);
    assert.equal(second.cursor.byte_offset, blockedOffset);

    fs.copyFileSync(
      path.join(RUNTIME_FIXTURES, "claude-project.jsonl"),
      unknownPath,
    );
    const recovered = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile,
      cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts],
    });
    assert.equal(recovered.residues.length, 2);
    assert.equal(recovered.report.blocked, false);
    assert.equal(recovered.cursor.byte_offset, fs.statSync(fixture.telemetryFile).size);
  });

  test("rejects a transcript outside the explicit roots without leaking its path", () => {
    const fixture = tempRuntime();
    const outside = path.join(fixture.root, "outside.jsonl");
    fs.copyFileSync(path.join(RUNTIME_FIXTURES, "claude-project.jsonl"), outside);
    writeTelemetry(fixture.telemetryFile, [
      telemetryRecord({
        eventId: "evt-outside",
        runtime: "claude-code",
        sessionId: "outside-session",
        transcriptPath: outside,
      }),
    ]);

    const result = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile,
      cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts],
    });
    assert.equal(result.report.failures[0].code, "TRANSCRIPT_OUTSIDE_ROOTS");
    assert.equal(fs.existsSync(fixture.cursorFile), false);
    assert.doesNotMatch(JSON.stringify(result.report), /outside\.jsonl|knowledge-runtime-ingest/);
  });

  test("blocks copy-truncate gaps and drains the native rotated predecessor", () => {
    const run = (fixture, eventId, runtime, sessionId, name) => telemetryRecord({
      eventId, runtime, sessionId, transcriptPath: path.join(fixture.transcripts, name),
    });
    const truncatedFixture = tempRuntime();
    writeTelemetry(truncatedFixture.telemetryFile, [
      run(truncatedFixture, "evt-first", "claude-code", "first", "claude-project.jsonl"),
    ]);
    const first = ingestRuntimeSessions({
      telemetryFile: truncatedFixture.telemetryFile,
      cursorFile: truncatedFixture.cursorFile,
      transcriptRoots: [truncatedFixture.transcripts],
    });
    writeTelemetry(truncatedFixture.telemetryFile, [
      run(truncatedFixture, "evt-copytruncate", "codex", "second", "codex-rollout.jsonl"),
    ]);
    const copyTruncated = ingestRuntimeSessions({
      telemetryFile: truncatedFixture.telemetryFile,
      cursorFile: truncatedFixture.cursorFile,
      transcriptRoots: [truncatedFixture.transcripts],
    });
    assert.equal(copyTruncated.report.failures[0].code, "TELEMETRY_CONTINUITY_GAP");
    assert.equal(copyTruncated.residues.length, 0);
    assert.equal(copyTruncated.cursor.byte_offset, 0);
    assert.equal(first.report.blocked, false);

    const rotatedFixture = tempRuntime();
    writeTelemetry(rotatedFixture.telemetryFile, [
      run(rotatedFixture, "evt-before", "claude-code", "before", "claude-project.jsonl"),
    ]);
    ingestRuntimeSessions({
      telemetryFile: rotatedFixture.telemetryFile,
      cursorFile: rotatedFixture.cursorFile,
      transcriptRoots: [rotatedFixture.transcripts],
    });
    fs.appendFileSync(rotatedFixture.telemetryFile, `${JSON.stringify(
      run(rotatedFixture, "evt-tail", "codex", "tail", "codex-rollout.jsonl"),
    )}\n`);
    const rotatedPath = rotatedFixture.telemetryFile.replace(/\.jsonl$/, ".1.jsonl");
    fs.renameSync(rotatedFixture.telemetryFile, rotatedPath);
    writeTelemetry(rotatedFixture.telemetryFile, [
      run(rotatedFixture, "evt-current", "claude-code", "current", "claude-project.jsonl"),
    ]);
    const rotated = ingestRuntimeSessions({
      telemetryFile: rotatedFixture.telemetryFile,
      cursorFile: rotatedFixture.cursorFile,
      transcriptRoots: [rotatedFixture.transcripts],
    });
    assert.equal(rotated.report.source_reset, true);
    assert.deepEqual(rotated.residues.map(({ runtime }) => runtime), ["codex", "claude-code"]);

    const blockedRotation = tempRuntime();
    writeTelemetry(blockedRotation.telemetryFile, [
      run(blockedRotation, "evt-before-block", "claude-code", "before-block", "claude-project.jsonl"),
    ]);
    ingestRuntimeSessions({
      telemetryFile: blockedRotation.telemetryFile,
      cursorFile: blockedRotation.cursorFile,
      transcriptRoots: [blockedRotation.transcripts],
    });
    fs.appendFileSync(blockedRotation.telemetryFile, `${JSON.stringify(
      run(blockedRotation, "evt-tail-block", "codex", "tail-block", "codex-rollout.jsonl"),
    )}\n`);
    fs.renameSync(
      blockedRotation.telemetryFile,
      blockedRotation.telemetryFile.replace(/\.jsonl$/, ".1.jsonl"),
    );
    writeTelemetry(blockedRotation.telemetryFile, [
      run(blockedRotation, "evt-current-block", "claude-code", "current-block", "unknown.jsonl"),
    ]);
    const blocked = ingestRuntimeSessions({
      telemetryFile: blockedRotation.telemetryFile,
      cursorFile: blockedRotation.cursorFile,
      transcriptRoots: [blockedRotation.transcripts],
    });
    assert.equal(blocked.report.blocked, true);
    assert.equal(blocked.report.failures[0].code, "UNKNOWN_TRANSCRIPT_FORMAT");
    assert.deepEqual(
      blocked.cursor,
      JSON.parse(fs.readFileSync(blockedRotation.cursorFile, "utf8")),
      "returned cursor must describe the durable predecessor commit",
    );
  });

  test("blocks mixed known and unknown records without advancing", () => {
    for (const item of [
      {
        runtime: "claude-code", file: "claude-project.jsonl",
        unknown: { type: "future_message", content: "must not disappear" },
      },
      {
        runtime: "codex", file: "codex-rollout.jsonl",
        unknown: {
          type: "response_item",
          payload: { type: "future_item", content: "must not disappear" },
        },
      },
    ]) {
      const fixture = tempRuntime();
      fs.appendFileSync(path.join(fixture.transcripts, item.file), `${JSON.stringify(item.unknown)}\n`);
      writeTelemetry(fixture.telemetryFile, [telemetryRecord({
        eventId: `evt-${item.runtime}`, runtime: item.runtime, sessionId: item.runtime,
        transcriptPath: path.join(fixture.transcripts, item.file),
      })]);
      const result = ingestRuntimeSessions({
        telemetryFile: fixture.telemetryFile, cursorFile: fixture.cursorFile,
        transcriptRoots: [fixture.transcripts],
      });
      assert.equal(result.report.failures[0].code, "UNKNOWN_TRANSCRIPT_FORMAT");
      assert.equal(result.residues.length, 0);
      assert.equal(fs.existsSync(fixture.cursorFile), false);
    }

    const nestedToolResult = tempRuntime();
    fs.appendFileSync(
      path.join(nestedToolResult.transcripts, "claude-project.jsonl"),
      `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "known content" },
            {
              type: "tool_result",
              content: [{ type: "future_tool_payload", data: "must not disappear" }],
            },
          ],
        },
      })}\n`,
    );
    writeTelemetry(nestedToolResult.telemetryFile, [telemetryRecord({
      eventId: "evt-nested-tool-result",
      runtime: "claude-code",
      sessionId: "nested-tool-result",
      transcriptPath: path.join(nestedToolResult.transcripts, "claude-project.jsonl"),
    })]);
    const nested = ingestRuntimeSessions({
      telemetryFile: nestedToolResult.telemetryFile,
      cursorFile: nestedToolResult.cursorFile,
      transcriptRoots: [nestedToolResult.transcripts],
    });
    assert.equal(nested.report.failures[0].code, "UNKNOWN_TRANSCRIPT_FORMAT");
    assert.equal(nested.residues.length, 0);
    assert.equal(fs.existsSync(nestedToolResult.cursorFile), false);

    for (const argumentsValue of [
      String.raw`{\"password\":\"escaped multi word canary\"`,
      '"string primitive"',
      "[]",
      "null",
    ]) {
      const malformedArguments = tempRuntime();
      fs.appendFileSync(
        path.join(malformedArguments.transcripts, "codex-rollout.jsonl"),
        `${JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: argumentsValue,
          },
        })}\n`,
      );
      writeTelemetry(malformedArguments.telemetryFile, [telemetryRecord({
        eventId: "evt-malformed-arguments",
        runtime: "codex",
        sessionId: "malformed-arguments",
        transcriptPath: path.join(malformedArguments.transcripts, "codex-rollout.jsonl"),
      })]);
      const malformed = ingestRuntimeSessions({
        telemetryFile: malformedArguments.telemetryFile,
        cursorFile: malformedArguments.cursorFile,
        transcriptRoots: [malformedArguments.transcripts],
      });
      assert.equal(malformed.report.failures[0].code, "UNKNOWN_TRANSCRIPT_FORMAT");
      assert.equal(malformed.residues.length, 0);
      assert.equal(JSON.stringify(malformed).includes("escaped multi word canary"), false);
      assert.equal(fs.existsSync(malformedArguments.cursorFile), false);
    }
  });

  test("fails closed when limits or cursor persistence prevent a complete commit", () => {
    const fixture = tempRuntime();
    writeTelemetry(fixture.telemetryFile, [telemetryRecord({
      eventId: "evt-limit", runtime: "codex", sessionId: "limit",
      transcriptPath: path.join(fixture.transcripts, "codex-rollout.jsonl"),
    })]);
    const limited = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile, cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts], maxTranscriptEntries: 1,
    });
    assert.equal(limited.report.failures[0].code, "TRANSCRIPT_ENTRY_LIMIT");
    assert.equal(fs.existsSync(fixture.cursorFile), false);

    const oversizedTelemetryLine = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile, cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts], maxTelemetryLineBytes: 8,
    });
    assert.equal(oversizedTelemetryLine.report.failures[0].code, "TELEMETRY_LINE_TOO_LARGE");
    assert.equal(fs.existsSync(fixture.cursorFile), false);

    for (const raised of [
      { maxTranscriptEntries: 2_001 },
      { maxEntryChars: 32_769 },
    ]) {
      const invalidOptions = ingestRuntimeSessions({
        telemetryFile: fixture.telemetryFile, cursorFile: fixture.cursorFile,
        transcriptRoots: [fixture.transcripts], ...raised,
      });
      assert.equal(invalidOptions.report.failures[0].code, "INGEST_OPTIONS_INVALID");
      assert.equal(invalidOptions.residues.length, 0);
    }

    const persistence = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile, cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts],
      persistCursor: () => { throw new Error("/Users/private/dream/cursor"); },
    });
    assert.equal(persistence.report.failures[0].code, "CURSOR_WRITE_FAILED");
    assert.equal(persistence.residues.length, 0);
    assert.doesNotMatch(JSON.stringify(persistence), /Users\/private/);
    assert.equal(fs.existsSync(fixture.cursorFile), false);

    const unconfirmed = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile, cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts], persistCursor: () => false,
    });
    assert.equal(unconfirmed.report.failures[0].code, "CURSOR_WRITE_FAILED");
    assert.equal(unconfirmed.residues.length, 0);
    assert.equal(fs.existsSync(fixture.cursorFile), false);

    fs.mkdirSync(path.dirname(fixture.cursorFile), { recursive: true });
    const cursorTarget = path.join(fixture.root, "cursor-target.json");
    fs.writeFileSync(cursorTarget, "{}\n");
    fs.symlinkSync(cursorTarget, fixture.cursorFile);
    const symlinked = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile, cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts],
    });
    assert.equal(symlinked.report.failures[0].code, "PATH_SYMLINK_REJECTED");
    assert.equal(fs.readFileSync(cursorTarget, "utf8"), "{}\n");
  });

  test("rejects cursor files with non-private permissions", () => {
    const fixture = tempRuntime();
    writeTelemetry(fixture.telemetryFile, [telemetryRecord({
      eventId: "evt-permissions", runtime: "codex", sessionId: "permissions",
      transcriptPath: path.join(fixture.transcripts, "codex-rollout.jsonl"),
    })]);
    ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile, cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts],
    });
    fs.chmodSync(fixture.cursorFile, 0o644);
    const result = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile, cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts],
    });
    assert.equal(result.report.failures[0].code, "CURSOR_OWNERSHIP_INVALID");
    assert.equal(result.residues.length, 0);
  });
});

describe("AC3: deterministic runtime residue redaction", () => {
  test("scrubs secrets, home paths, and emails even when transcript text asks not to", () => {
    const fixture = tempRuntime();
    const overlongSecret = `overlong-${"q".repeat(600)}`;
    const awsAccessCanary = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const authHeaderName = ["Author", "ization"].join("");
    const authTokenCanary = ["secret-token", "-value-123456"].join("");
    fs.appendFileSync(
      path.join(fixture.transcripts, "claude-project.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            name: "Bash",
            input: {
              cmd: `connect AccountKey=account-key-canary ADMIN_PASSWORD="${overlongSecret}"`,
              password: "claude structured multi word canary",
              Pwd: "connection-pwd-canary",
              SharedAccessSignature: "shared-access-signature-canary",
              privateKey: "private-key-field-canary",
            },
          }],
        },
      })}\n`,
    );
    fs.appendFileSync(
      path.join(fixture.transcripts, "claude-project.jsonl"),
      `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: `AWS key ${awsAccessCanary}` }],
        },
      })}\n`,
    );
    fs.appendFileSync(
      path.join(fixture.transcripts, "codex-rollout.jsonl"),
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ password: "codex structured multi word canary" }),
        },
      })}\n`,
    );
    fs.appendFileSync(
      path.join(fixture.transcripts, "codex-rollout.jsonl"),
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: `curl -H '${authHeaderName}: Bearer ${authTokenCanary}' https://example.test`,
          }),
        },
      })}\n`,
    );
    writeTelemetry(fixture.telemetryFile, [
      telemetryRecord({
        eventId: "evt-owner@example.com",
        runtime: "claude-code",
        sessionId: "metadata-owner@example.com",
        transcriptPath: path.join(fixture.transcripts, "claude-project.jsonl"),
      }),
      telemetryRecord({
        eventId: "evt-codex-redaction",
        runtime: "codex",
        sessionId: "codex-redaction",
        transcriptPath: path.join(fixture.transcripts, "codex-rollout.jsonl"),
      }),
    ]);

    const result = ingestRuntimeSessions({
      telemetryFile: fixture.telemetryFile,
      cursorFile: fixture.cursorFile,
      transcriptRoots: [fixture.transcripts],
    });
    const output = JSON.stringify(result);

    for (const canary of [
      "owner@example.com",
      "reviewer@example.net",
      "/Users/alice",
      "/home/alice",
      "C:\\Users\\reviewer",
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890AB",
      "sk-abcdefghijklmnopqrstuvwxyz123456",
      awsAccessCanary,
      authTokenCanary,
      "eyJabcdefghijk.eyJabcdefghijk.abcdefghijk",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "correcthorsebatterystaple",
      "correct horse battery staple",
      "multi word token value",
      "npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "connection-secret",
      "account-key-canary",
      "claude structured multi word canary",
      "codex structured multi word canary",
      "connection-pwd-canary",
      "shared-access-signature-canary",
      "private-key-field-canary",
      overlongSecret,
      "metadata-owner@example.com",
      "evt-owner@example.com",
    ]) {
      assert.equal(output.includes(canary), false, `redaction leaked ${canary}`);
    }
    assert.match(output, /<EMAIL>/);
    assert.match(output, /<HOME_PATH>/);
    assert.match(output, /<SECRET>/);
    assert.doesNotMatch(output, /codex-redaction|metadata-owner|evt-owner/);
  });
});
