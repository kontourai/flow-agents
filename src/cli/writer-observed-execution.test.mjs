import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { appendWriterObservedCommands, WRITER_OBSERVATION_SOURCE } from "../../build/src/cli/workflow-sidecar.js";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const { verifyCommandLogChain } = require(path.join(repoRoot, "scripts/hooks/stop-goal-fit.js"));
const chain = require(path.join(repoRoot, "scripts/lib/command-log-chain.js"));

const NOW = "2026-07-14T14:00:00.000Z";

function tempSession(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writer-observed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readEntries(dir) {
  return fs.readFileSync(path.join(dir, "command-log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function hookEntry(prevHash, seq, record) {
  const full = { ...record, source: "postToolUse-capture" };
  const hash = chain.computeChainHash(prevHash, full);
  return { entry: { ...full, _chain: { seq, prevHash, hash } }, hash };
}

test("appendWriterObservedCommands extends an existing hook chain with verifiable links", (t) => {
  const dir = tempSession(t);
  const { entry, hash } = hookEntry(chain.CHAIN_GENESIS, 0, { command: "echo hi", observedResult: "ambiguous", exitCode: null, capturedAt: NOW });
  fs.writeFileSync(path.join(dir, "command-log.jsonl"), `${JSON.stringify(entry)}\n`);

  appendWriterObservedCommands(dir, [
    { command: "npm run test:unit", exit_code: 0, output_sha256: "a".repeat(64), test_count: 5, execution_proof: { kind: "local-process-exit", pid: 123 } },
    { command: "npm run validate:source", exit_code: 0, output_sha256: "b".repeat(64) },
  ], NOW);

  const entries = readEntries(dir);
  assert.equal(entries.length, 3);
  assert.equal(entries[1].source, WRITER_OBSERVATION_SOURCE);
  assert.equal(entries[1].observedResult, "pass");
  assert.equal(entries[1].exitCode, 0);
  assert.equal(entries[1].writer.output_sha256, "a".repeat(64));
  assert.equal(entries[1].writer.test_count, 5);
  assert.equal(entries[1]._chain.prevHash, hash);
  assert.equal(entries[2]._chain.prevHash, entries[1]._chain.hash);

  const verdict = verifyCommandLogChain(dir);
  assert.equal(verdict.status, "ok");
});

test("a nonzero writer exit code records an observed fail", (t) => {
  const dir = tempSession(t);
  appendWriterObservedCommands(dir, [{ command: "npm run test:unit", exit_code: 1, output_sha256: "c".repeat(64) }], NOW);
  const entries = readEntries(dir);
  assert.equal(entries[0].observedResult, "fail");
  assert.equal(entries[0].exitCode, 1);
});

test("chain verification tolerates writer/hook fork siblings but rejects any third source", (t) => {
  const dir = tempSession(t);
  const { entry: base, hash: baseHash } = hookEntry(chain.CHAIN_GENESIS, 0, { command: "echo hi", observedResult: "ambiguous", exitCode: null, capturedAt: NOW });

  const hookSibling = { command: "npm test", observedResult: "ambiguous", exitCode: null, capturedAt: NOW, source: "postToolUse-capture" };
  hookSibling._chain = { seq: 1, prevHash: baseHash, hash: chain.computeChainHash(baseHash, { command: hookSibling.command, observedResult: hookSibling.observedResult, exitCode: hookSibling.exitCode, capturedAt: hookSibling.capturedAt, source: hookSibling.source }) };
  const writerSibling = { command: "npm test", observedResult: "pass", exitCode: 0, capturedAt: NOW, source: WRITER_OBSERVATION_SOURCE, writer: { output_sha256: "d".repeat(64) } };
  writerSibling._chain = { seq: 1, prevHash: baseHash, hash: chain.computeChainHash(baseHash, { command: writerSibling.command, observedResult: writerSibling.observedResult, exitCode: writerSibling.exitCode, capturedAt: writerSibling.capturedAt, source: writerSibling.source, writer: writerSibling.writer }) };

  const writeLog = (entries) => fs.writeFileSync(path.join(dir, "command-log.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeLog([base, hookSibling, writerSibling]);
  assert.equal(verifyCommandLogChain(dir).status, "forked");

  // The benign set is EXACTLY {postToolUse-capture, canonical-writer-execution}: any other
  // source on a shared parent is tamper, however plausible its name (review finding — a
  // single pinned name would not catch the set being widened further).
  for (const source of ["manual-injection", "canonical-writer-execution-v2", "postToolUse-capture2", "orchestrator-attest", ""]) {
    const forged = { command: "npm test", observedResult: "pass", exitCode: 0, capturedAt: NOW, source };
    forged._chain = { seq: 1, prevHash: baseHash, hash: chain.computeChainHash(baseHash, { command: forged.command, observedResult: forged.observedResult, exitCode: forged.exitCode, capturedAt: forged.capturedAt, source: forged.source }) };
    writeLog([base, hookSibling, forged]);
    assert.equal(verifyCommandLogChain(dir).status, "broken", `source "${source}" must poison the fork`);
  }
});

test("mutating writer metadata after the fact breaks the entry's self-hash", (t) => {
  const dir = tempSession(t);
  appendWriterObservedCommands(dir, [{ command: "npm run test:unit", exit_code: 0, output_sha256: "f".repeat(64) }], NOW);
  assert.equal(verifyCommandLogChain(dir).status, "ok");
  const entries = readEntries(dir);
  // An attacker upgrading the recorded observation (or its provenance) cannot keep the hash.
  entries[0].writer.output_sha256 = "0".repeat(64);
  fs.writeFileSync(path.join(dir, "command-log.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  assert.equal(verifyCommandLogChain(dir).status, "broken");
});

test("shared raw verification gives identical legacy-prefix and mid-chain gap semantics", (t) => {
  const dir = tempSession(t);
  const { entry } = hookEntry(chain.CHAIN_GENESIS, 0, { command: "echo hi", observedResult: "pass", exitCode: 0, capturedAt: NOW });
  const variants = ["not-json", "[]", "null", "42", JSON.stringify({ source: "legacy" })];
  for (const prefix of variants) {
    const raw = `${prefix}\n${JSON.stringify(entry)}\n`;
    fs.writeFileSync(path.join(dir, "command-log.jsonl"), raw);
    assert.equal(chain.verifyCommandLogRaw(raw).status, "ok", `${prefix} is a tolerated legacy prefix`);
    assert.equal(verifyCommandLogChain(dir).status, "ok");

    const gapRaw = `${JSON.stringify(entry)}\n${prefix}\n`;
    fs.writeFileSync(path.join(dir, "command-log.jsonl"), gapRaw);
    assert.equal(chain.verifyCommandLogRaw(gapRaw).status, "broken", `${prefix} is a mid-chain gap`);
    assert.equal(verifyCommandLogChain(dir).status, "broken");
  }
});

test("persistent generation locks fail closed on active malformed stale and replaced highest generations", (t) => {
  const dir = tempSession(t);
  const base = path.join(dir, "command-log.jsonl.lock");
  const first = chain.acquireGenerationLock(base);
  assert.ok(first);
  assert.equal(chain.acquireGenerationLock(base), null, "an active highest generation blocks the next generation");
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(first.file, stale, stale);
  assert.equal(chain.acquireGenerationLock(base), null, "a stale active generation is never stolen");
  assert.equal(chain.releaseGenerationLock(first), true);

  const second = chain.acquireGenerationLock(base);
  assert.equal(second.generation, 1);
  const parked = `${second.file}.parked`;
  fs.renameSync(second.file, parked);
  fs.writeFileSync(second.file, "foreign replacement\n");
  assert.equal(chain.releaseGenerationLock(second), false, "descriptor release detects pathname replacement");
  assert.equal(fs.readFileSync(second.file, "utf8"), "foreign replacement\n");
  assert.equal(chain.acquireGenerationLock(base), null, "a malformed replaced highest generation fails closed");
});

test("persistent generation locks serialize the next generation without unlinking history", (t) => {
  const dir = tempSession(t);
  const base = path.join(dir, "command-log.jsonl.lock");
  const zero = chain.acquireGenerationLock(base);
  assert.equal(chain.releaseGenerationLock(zero), true);
  const one = chain.acquireGenerationLock(base);
  assert.equal(one.generation, 1);
  assert.equal(chain.acquireGenerationLock(base), null);
  assert.equal(chain.releaseGenerationLock(one), true);
  const two = chain.acquireGenerationLock(base);
  assert.equal(two.generation, 2);
  assert.equal(chain.releaseGenerationLock(two), true);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".lock.")).sort(), [
    "command-log.jsonl.lock.0", "command-log.jsonl.lock.1", "command-log.jsonl.lock.2",
  ]);
});

test("append is fail-open: an unwritable session dir does not throw", () => {
  assert.doesNotThrow(() => appendWriterObservedCommands("/nonexistent/definitely-missing", [{ command: "x", exit_code: 0, output_sha256: "e".repeat(64) }], NOW));
});
