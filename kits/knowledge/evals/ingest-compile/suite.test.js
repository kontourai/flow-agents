/**
 * Knowledge Kit — Ingest + Compile Eval Suite
 *
 * Covers:
 *   AC1: kit validates (command evidence from validate:source)
 *   AC2: ingest+compile against default store yields a compiled note whose
 *        provenance refs resolve (all ref.id values retrievable from store)
 *   AC3: canonical telemetry emitted at each gate (schema v0.3.0 events
 *        appear in .kontourai/telemetry/full.jsonl)
 *
 * Also covers:
 *   - ingest produces classified raw (category + type="raw")
 *   - compile rejects when provenance missing
 *   - compile succeeds and provenance refs resolve
 *   - telemetry events emitted at gates
 *
 * Run:
 *   node --test kits/knowledge/evals/ingest-compile/suite.test.js
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "../..");

// Adapter and runner imports
const adapterPath = path.join(KIT_ROOT, "adapters/default-store/index.js");
const runnerPath = path.join(KIT_ROOT, "adapters/flow-runner/index.js");
const telemetryPath = path.join(KIT_ROOT, "adapters/flow-runner/telemetry.js");

const { DefaultKnowledgeStore } = await import(adapterPath);
const { KnowledgeFlowRunner } = await import(runnerPath);
const { KnowledgeTelemetry } = await import(telemetryPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-ingest-compile-"));
}

function makeStore(dir) {
  return new DefaultKnowledgeStore({ storeRoot: dir });
}

function makeRunner(store, storeDir) {
  // Telemetry sink lives in storeDir/.kontourai/telemetry/full.jsonl for test isolation
  return new KnowledgeFlowRunner({
    store,
    workspace: storeDir,
    agent: "test-runner",
    sessionId: "test-session-001",
  });
}

function readTelemetryEvents(dir) {
  const sinkPath = path.join(dir, ".kontourai", "telemetry", "full.jsonl");
  if (!fs.existsSync(sinkPath)) return [];
  return fs.readFileSync(sinkPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// AC2 + ingest: produces classified raw record
// ---------------------------------------------------------------------------

describe("ingest flow — classified raw capture (AC2 pre-condition)", () => {
  let dir, store, runner;

  before(() => {
    dir = makeTempDir();
    store = makeStore(dir);
    runner = makeRunner(store, dir);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("capture produces a raw record with non-empty category", async () => {
    const result = await runner.capture(
      "How to design a REST API with versioning",
      { agent: "test-runner" }
    );

    assert.ok(result.id, "capture returns an id");
    assert.ok(result.record, "capture returns the record");
    assert.equal(result.record.type, "raw", "record type is raw");
    assert.ok(result.record.category, "record has a non-empty category");
    assert.match(
      result.record.category,
      /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/,
      "category is a valid dot-separated string"
    );
  });

  test("capture infers category from text when not provided", async () => {
    const result = await runner.capture("Fix: NullPointerException in auth middleware");
    assert.equal(result.record.type, "raw");
    assert.ok(result.record.category, "category inferred");
  });

  test("capture accepts explicit category via meta", async () => {
    const result = await runner.capture(
      "Some raw text about anything",
      { category: "research.notes", title: "Manual categorization test" }
    );
    assert.equal(result.record.category, "research.notes");
    assert.equal(result.record.title, "Manual categorization test");
  });

  test("capture stores record retrievable by id", async () => {
    const result = await runner.capture("Retrievability test content");
    const fetched = await store.get(result.id);
    assert.ok(fetched, "record is retrievable from store by id");
    assert.equal(fetched.id, result.id);
    assert.equal(fetched.type, "raw");
  });

  test("capture rejects empty rawText", async () => {
    await assert.rejects(
      () => runner.capture(""),
      (err) => {
        assert.equal(err.code, "MISSING_EVIDENCE", `Expected MISSING_EVIDENCE, got: ${err.code}`);
        return true;
      }
    );
  });

  test("capture rejects whitespace-only rawText", async () => {
    await assert.rejects(
      () => runner.capture("   \n  "),
      (err) => {
        assert.equal(err.code, "MISSING_EVIDENCE");
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// compile: rejects when provenance missing
// ---------------------------------------------------------------------------

describe("compile flow — provenance gate rejection", () => {
  let dir, store, runner;

  before(() => {
    dir = makeTempDir();
    store = makeStore(dir);
    runner = makeRunner(store, dir);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("compile rejects empty rawIds array", async () => {
    await assert.rejects(
      () => runner.compile([]),
      (err) => {
        assert.equal(err.code, "MISSING_EVIDENCE");
        assert.match(err.message, /rawIds must be a non-empty array/);
        return true;
      }
    );
  });

  test("compile rejects non-array rawIds", async () => {
    await assert.rejects(
      () => runner.compile(null),
      (err) => {
        assert.equal(err.code, "MISSING_EVIDENCE");
        return true;
      }
    );
  });

  test("compile rejects rawId that does not exist in store", async () => {
    await assert.rejects(
      () => runner.compile(["nonexistent-id-xyz"]),
      (err) => {
        assert.equal(err.code, "MISSING_EVIDENCE");
        assert.match(err.message, /not found/);
        return true;
      }
    );
  });

  test("compile rejects record that is not type=raw", async () => {
    // Create a concept record and try to compile it
    const conceptId = await store.create({
      type: "concept",
      title: "Some concept",
      body: "A concept body",
      category: "engineering",
      provenance: { agent: "test-runner" },
    });

    await assert.rejects(
      () => runner.compile([conceptId]),
      (err) => {
        assert.equal(err.code, "MISSING_EVIDENCE");
        assert.match(err.message, /expected "raw"/);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// AC2: compile succeeds and provenance refs resolve
// ---------------------------------------------------------------------------

describe("compile flow — provenance refs resolve (AC2)", () => {
  let dir, store, runner;
  let rawId1, rawId2;

  before(async () => {
    dir = makeTempDir();
    store = makeStore(dir);
    runner = makeRunner(store, dir);

    // Pre-create two raw records to compile
    rawId1 = await store.create({
      type: "raw",
      title: "Research Note A",
      body: "First raw capture about API design patterns.",
      category: "research.notes",
      provenance: { agent: "test-runner" },
    });

    rawId2 = await store.create({
      type: "raw",
      title: "Research Note B",
      body: "Second raw capture about REST versioning strategies.",
      category: "research.notes",
      provenance: { agent: "test-runner" },
    });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("compile returns a compiled record id and record", async () => {
    const result = await runner.compile([rawId1, rawId2], {
      title: "API Design Synthesis",
      category: "research.notes",
    });

    assert.ok(result.id, "compile returns an id");
    assert.ok(result.record, "compile returns the record object");
    assert.equal(result.record.type, "compiled");
  });

  test("compiled record has provenance.source_ids listing all consumed raws", async () => {
    const result = await runner.compile([rawId1, rawId2], {
      title: "Provenance Check Compilation",
    });

    const record = result.record;
    assert.ok(record.provenance, "record has provenance");
    assert.ok(Array.isArray(record.provenance.source_ids), "provenance.source_ids is an array");
    assert.ok(
      record.provenance.source_ids.includes(rawId1),
      "provenance.source_ids includes rawId1"
    );
    assert.ok(
      record.provenance.source_ids.includes(rawId2),
      "provenance.source_ids includes rawId2"
    );
    assert.equal(
      record.provenance.source_ids.length,
      2,
      "provenance.source_ids covers all consumed raws"
    );
  });

  test("compiled record has source links to every consumed raw", async () => {
    const result = await runner.compile([rawId1, rawId2], {
      title: "Source Links Check",
    });

    const links = result.record.links || [];
    const sourceLinks = links.filter((l) => l.kind === "source");
    const linkedIds = sourceLinks.map((l) => l.target_id);

    assert.ok(linkedIds.includes(rawId1), "source link to rawId1 present");
    assert.ok(linkedIds.includes(rawId2), "source link to rawId2 present");
  });

  test("all provenance refs resolve via store.get()", async () => {
    const result = await runner.compile([rawId1, rawId2], {
      title: "Ref Resolution Check",
    });

    const sourceIds = result.record.provenance.source_ids;
    for (const srcId of sourceIds) {
      const ref = await store.get(srcId);
      assert.ok(ref, `provenance ref ${srcId} resolves to a record`);
      assert.equal(ref.type, "raw", `provenance ref ${srcId} is type=raw`);
    }
  });

  test("graph index reflects source links for compiled record", async () => {
    const result = await runner.compile([rawId1, rawId2], {
      title: "Graph Index Check",
    });

    const { forward } = await store.getLinks(result.id);
    const sourceLinks = forward.filter((l) => l.kind === "source");

    assert.ok(
      sourceLinks.some((l) => l.target_id === rawId1),
      "graph index has forward source link to rawId1"
    );
    assert.ok(
      sourceLinks.some((l) => l.target_id === rawId2),
      "graph index has forward source link to rawId2"
    );
  });

  test("ingest → compile end-to-end: captured raws compile with provenance", async () => {
    const r1 = await runner.capture("End-to-end test: capture one about databases");
    const r2 = await runner.capture("End-to-end test: capture two about caching");

    const compiled = await runner.compile([r1.id, r2.id], {
      title: "End-to-End Compiled Note",
    });

    assert.equal(compiled.record.type, "compiled");
    assert.ok(compiled.record.provenance.source_ids.includes(r1.id));
    assert.ok(compiled.record.provenance.source_ids.includes(r2.id));

    // All refs resolve
    for (const srcId of compiled.record.provenance.source_ids) {
      const ref = await store.get(srcId);
      assert.ok(ref, `ref ${srcId} resolves`);
    }
  });

  test("single-raw compile works and provenance covers the one raw", async () => {
    const result = await runner.compile([rawId1], {
      title: "Single Source Compile",
    });

    assert.equal(result.record.type, "compiled");
    assert.deepEqual(result.record.provenance.source_ids, [rawId1]);
    const sourceLinks = (result.record.links || []).filter((l) => l.kind === "source");
    assert.ok(sourceLinks.some((l) => l.target_id === rawId1));
  });
});

// ---------------------------------------------------------------------------
// AC3: canonical telemetry events emitted at gates
// ---------------------------------------------------------------------------

describe("telemetry — canonical events at gates (AC3)", () => {
  let dir, store, runner;

  before(() => {
    dir = makeTempDir();
    store = makeStore(dir);
    runner = makeRunner(store, dir);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("ingest emits telemetry events at classify-gate and route-gate", async () => {
    await runner.capture("Telemetry test: capture for ingest gates");

    const events = readTelemetryEvents(dir);
    assert.ok(events.length > 0, "telemetry events were emitted");

    // Check that events have correct schema_version
    for (const ev of events) {
      assert.equal(ev.schema_version, "0.3.0", "event has schema_version 0.3.0");
      assert.ok(ev.timestamp, "event has timestamp");
      assert.ok(ev.session_id, "event has session_id");
      assert.ok(ev.event_id, "event has event_id");
      assert.ok(ev.event_type, "event has event_type");
      assert.ok(ev.agent, "event has agent block");
      assert.ok(ev.hook, "event has hook block");
    }
  });

  test("ingest events include classify-gate entry and exit", async () => {
    // Use a fresh dir for this test to get isolated events
    const testDir = makeTempDir();
    const testStore = makeStore(testDir);
    const testRunner = makeRunner(testStore, testDir);

    try {
      await testRunner.capture("Classify gate telemetry test");

      const events = readTelemetryEvents(testDir);
      const gateEvents = events.filter(
        (ev) => ev.tool?.name?.includes("classify-gate")
      );

      assert.ok(gateEvents.length >= 2, "at least 2 classify-gate events (entry + exit)");

      const entryEvent = gateEvents.find((ev) => ev.event_type === "tool.invoke");
      const exitEvent = gateEvents.find((ev) => ev.event_type === "tool.result");

      assert.ok(entryEvent, "classify-gate entry event (tool.invoke) emitted");
      assert.ok(exitEvent, "classify-gate exit event (tool.result) emitted");
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("compile events include compile-gate entry and exit", async () => {
    const testDir = makeTempDir();
    const testStore = makeStore(testDir);
    const testRunner = makeRunner(testStore, testDir);

    try {
      const rawId = await testStore.create({
        type: "raw",
        title: "Compile gate tel test raw",
        body: "raw content for telemetry test",
        category: "test",
        provenance: { agent: "test-runner" },
      });

      await testRunner.compile([rawId], { title: "Compile Gate Telemetry Test" });

      const events = readTelemetryEvents(testDir);
      const compileGateEvents = events.filter(
        (ev) => ev.tool?.name?.includes("compile-gate")
      );

      assert.ok(compileGateEvents.length >= 2, "at least 2 compile-gate events (entry + exit)");

      const entryEvent = compileGateEvents.find((ev) => ev.event_type === "tool.invoke");
      const exitEvent = compileGateEvents.find((ev) => ev.event_type === "tool.result");

      assert.ok(entryEvent, "compile-gate entry event (tool.invoke) emitted");
      assert.ok(exitEvent, "compile-gate exit event (tool.result) emitted");
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("compile events include link-gate entry and exit", async () => {
    const testDir = makeTempDir();
    const testStore = makeStore(testDir);
    const testRunner = makeRunner(testStore, testDir);

    try {
      const rawId = await testStore.create({
        type: "raw",
        title: "Link gate tel test raw",
        body: "raw content",
        category: "test",
        provenance: { agent: "test-runner" },
      });

      await testRunner.compile([rawId], { title: "Link Gate Telemetry Test" });

      const events = readTelemetryEvents(testDir);
      const linkGateEvents = events.filter(
        (ev) => ev.tool?.name?.includes("link-gate")
      );

      assert.ok(linkGateEvents.length >= 2, "at least 2 link-gate events (entry + exit)");
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("telemetry events have correct agent block shape", async () => {
    const testDir = makeTempDir();
    const testStore = makeStore(testDir);
    const testRunner = new KnowledgeFlowRunner({
      store: testStore,
      workspace: testDir,
      agent: "specific-test-agent",
      sessionId: "specific-session-123",
    });

    try {
      await testRunner.capture("Agent block shape test");
      const events = readTelemetryEvents(testDir);

      assert.ok(events.length > 0, "events were emitted");
      for (const ev of events) {
        assert.equal(ev.agent.name, "specific-test-agent", "agent.name matches constructor arg");
        assert.equal(ev.agent.runtime, "knowledge-kit", "agent.runtime is knowledge-kit");
        assert.equal(ev.session_id, "specific-session-123", "session_id matches constructor arg");
      }
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("telemetry sink file is JSONL (one JSON object per line)", async () => {
    const testDir = makeTempDir();
    const testStore = makeStore(testDir);
    const testRunner = makeRunner(testStore, testDir);

    try {
      await testRunner.capture("JSONL format test");

      const sinkPath = path.join(testDir, ".kontourai", "telemetry", "full.jsonl");
      assert.ok(fs.existsSync(sinkPath), "telemetry sink file exists");

      const lines = fs.readFileSync(sinkPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);

      assert.ok(lines.length > 0, "at least one line in JSONL file");
      for (const line of lines) {
        const parsed = JSON.parse(line); // throws if invalid JSON
        assert.ok(typeof parsed === "object" && parsed !== null, "each line is a JSON object");
      }
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Telemetry helper unit tests
// ---------------------------------------------------------------------------

describe("KnowledgeTelemetry — helper unit tests", () => {
  let dir;

  before(() => { dir = makeTempDir(); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("emit writes a line to the JSONL sink", () => {
    const tel = new KnowledgeTelemetry({ workspace: dir, agentName: "tel-test" });
    const ev = tel.emit("preToolUse", { tool: { name: "test-tool", input: null } });

    assert.ok(ev, "emit returns the event");
    assert.equal(ev.event_type, "tool.invoke");
    assert.equal(ev.schema_version, "0.3.0");

    const sinkPath = path.join(dir, ".kontourai", "telemetry", "full.jsonl");
    assert.ok(fs.existsSync(sinkPath), "JSONL file was created");
  });

  test("emitGate produces a tool.invoke event", () => {
    const tel = new KnowledgeTelemetry({ workspace: dir, agentName: "tel-test" });
    const ev = tel.emitGate("test.flow", "my-gate", { key: "value" });

    assert.equal(ev.event_type, "tool.invoke");
    assert.equal(ev.tool.name, "test.flow.my-gate");
    assert.equal(ev.tool.normalized_name, "flow.gate");
    assert.deepEqual(ev.tool.input, { key: "value" });
  });

  test("emitGateResult produces a tool.result event", () => {
    const tel = new KnowledgeTelemetry({ workspace: dir, agentName: "tel-test" });
    const ev = tel.emitGateResult("test.flow", "my-gate", { status: "pass" });

    assert.equal(ev.event_type, "tool.result");
    assert.deepEqual(ev.tool.output, { status: "pass" });
  });

  test("emit fails open on bad sink path (no throw)", () => {
    const tel = new KnowledgeTelemetry({
      workspace: "/nonexistent/path/that/cannot/be/created/xyz123",
      agentName: "fail-open-test",
    });
    // Should not throw even if directory creation fails
    const ev = tel.emit("preToolUse", {});
    assert.ok(ev, "emit returns event even on sink write failure");
  });
});
