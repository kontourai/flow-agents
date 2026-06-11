/**
 * test-telemetry.ts — Tests for telemetry module.
 *
 * Covers: event mapping, JSONL emission shape, normalizeToolName.
 * Uses node:test only — no additional dependencies.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetrySink, STRANDS_TO_CANONICAL, normalizeToolName, SCHEMA_VERSION } from "../src/telemetry.js";

// ---------------------------------------------------------------------------
// STRANDS_TO_CANONICAL mapping table
// ---------------------------------------------------------------------------

describe("STRANDS_TO_CANONICAL mapping", () => {
  test("contains all expected Strands TS event class names", () => {
    const expected = new Set([
      "BeforeInvocationEvent",
      "AfterInvocationEvent",
      "BeforeToolCallEvent",
      "AfterToolCallEvent",
      "AgentInitializedEvent",
      "AfterModelCallEvent",
      "MessageAddedEvent",
    ]);
    assert.deepStrictEqual(new Set(Object.keys(STRANDS_TO_CANONICAL)), expected);
  });

  test("BeforeInvocationEvent → userPromptSubmit", () => {
    assert.strictEqual(STRANDS_TO_CANONICAL.BeforeInvocationEvent, "userPromptSubmit");
  });

  test("AfterInvocationEvent → stop", () => {
    assert.strictEqual(STRANDS_TO_CANONICAL.AfterInvocationEvent, "stop");
  });

  test("BeforeToolCallEvent → preToolUse", () => {
    assert.strictEqual(STRANDS_TO_CANONICAL.BeforeToolCallEvent, "preToolUse");
  });

  test("AfterToolCallEvent → postToolUse", () => {
    assert.strictEqual(STRANDS_TO_CANONICAL.AfterToolCallEvent, "postToolUse");
  });

  test("AgentInitializedEvent → agentSpawn", () => {
    assert.strictEqual(STRANDS_TO_CANONICAL.AgentInitializedEvent, "agentSpawn");
  });

  test("all values are non-empty strings", () => {
    for (const [key, value] of Object.entries(STRANDS_TO_CANONICAL)) {
      assert.strictEqual(typeof value, "string", `${key} value must be a string`);
      assert.ok(value.length > 0, `${key} value must be non-empty`);
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeToolName
// ---------------------------------------------------------------------------

describe("normalizeToolName", () => {
  test("bash → execute_bash", () => {
    assert.strictEqual(normalizeToolName("bash"), "execute_bash");
  });

  test("edit → fs_write", () => {
    assert.strictEqual(normalizeToolName("edit"), "fs_write");
  });

  test("write → fs_write", () => {
    assert.strictEqual(normalizeToolName("write"), "fs_write");
  });

  test("read → fs_read", () => {
    assert.strictEqual(normalizeToolName("read"), "fs_read");
  });

  test("task → use_subagent", () => {
    assert.strictEqual(normalizeToolName("task"), "use_subagent");
  });

  test("unknown passthrough", () => {
    assert.strictEqual(normalizeToolName("my_custom_tool"), "my_custom_tool");
  });
});

// ---------------------------------------------------------------------------
// TelemetrySink emission shape
// ---------------------------------------------------------------------------

function makeTempSink(agentName = "test-agent", runtime = "strands-test"): { sink: TelemetrySink; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-ts-telemetry-"));
  const sink = new TelemetrySink({ sinkPath: dir, agentName, runtime });
  return { sink, dir };
}

function readEvents(dir: string): Record<string, unknown>[] {
  const logFile = path.join(dir, "full.jsonl");
  if (!fs.existsSync(logFile)) return [];
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  return lines.filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("TelemetrySink emission shape", () => {
  test("session start event has correct schema_version and event_type", () => {
    const { sink, dir } = makeTempSink();
    const evt = sink.emitSessionStart();
    assert.strictEqual(evt.schema_version, SCHEMA_VERSION);
    assert.strictEqual(evt.event_type, "session.start");
    // cleanup
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("session start written to JSONL", () => {
    const { sink, dir } = makeTempSink();
    sink.emitSessionStart();
    const events = readEvents(dir);
    assert.strictEqual(events.length, 1);
    assert.strictEqual((events[0] as Record<string, unknown>).event_type, "session.start");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("event has required top-level fields (timestamp, session_id, event_id)", () => {
    const { sink, dir } = makeTempSink();
    const evt = sink.emitSessionStart();
    assert.ok("timestamp" in evt, "missing timestamp");
    assert.ok("session_id" in evt, "missing session_id");
    assert.ok("event_id" in evt, "missing event_id");
    assert.ok("agent" in evt, "missing agent");
    assert.ok("hook" in evt, "missing hook");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("agent sub-object has name and runtime", () => {
    const { sink, dir } = makeTempSink("my-agent", "strands-ts");
    const evt = sink.emitSessionStart();
    const agent = evt.agent as Record<string, unknown>;
    assert.strictEqual(agent.name, "my-agent");
    assert.strictEqual(agent.runtime, "strands-ts");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("hook sub-object has event_name and source fields", () => {
    const { sink, dir } = makeTempSink();
    const evt = sink.emitSessionStart();
    const hook = evt.hook as Record<string, unknown>;
    assert.ok("event_name" in hook, "hook.event_name missing");
    assert.ok("source" in hook, "hook.source missing");
    assert.strictEqual(hook.source, "strands-ts");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("tool invoke event has correct event_type and tool fields", () => {
    const { sink, dir } = makeTempSink();
    const evt = sink.emitToolInvoke("edit", { path: "foo.py" });
    assert.strictEqual(evt.event_type, "tool.invoke");
    const tool = evt.tool as Record<string, unknown>;
    assert.strictEqual(tool.name, "edit");
    assert.strictEqual(tool.normalized_name, "fs_write");
    assert.deepStrictEqual(tool.input, { path: "foo.py" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("tool result event has correct event_type", () => {
    const { sink, dir } = makeTempSink();
    const evt = sink.emitToolResult("read", "file contents");
    assert.strictEqual(evt.event_type, "tool.result");
    const tool = evt.tool as Record<string, unknown>;
    assert.strictEqual(tool.name, "read");
    assert.strictEqual(tool.normalized_name, "fs_read");
    assert.strictEqual(tool.output, "file contents");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("session end has event_type session.end", () => {
    const { sink, dir } = makeTempSink();
    const evt = sink.emitSessionEnd(1000);
    assert.strictEqual(evt.event_type, "session.end");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("user prompt submit has event_type turn.user", () => {
    const { sink, dir } = makeTempSink();
    const evt = sink.emitUserPromptSubmit();
    assert.strictEqual(evt.event_type, "turn.user");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("multiple events share the same session_id", () => {
    const { sink, dir } = makeTempSink();
    sink.emitSessionStart();
    sink.emitToolInvoke("read", {});
    sink.emitSessionEnd();
    const events = readEvents(dir);
    const sessionIds = new Set(events.map((e) => (e as Record<string, unknown>).session_id));
    assert.strictEqual(sessionIds.size, 1, "All events must share one session_id");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("each JSONL line is valid JSON", () => {
    const { sink, dir } = makeTempSink();
    sink.emitSessionStart();
    sink.emitToolInvoke("bash", { command: "ls" });
    sink.emitSessionEnd(500);
    const logFile = path.join(dir, "full.jsonl");
    const lines = fs.readFileSync(logFile, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line); // throws on invalid JSON
      assert.strictEqual(typeof parsed, "object");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("sinkPath directory creates full.jsonl", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-ts-sink-dir-"));
    const sink = new TelemetrySink({ sinkPath: dir });
    sink.emitSessionStart();
    assert.ok(fs.existsSync(path.join(dir, "full.jsonl")));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
