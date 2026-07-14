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

  const forged = { command: "npm test", observedResult: "pass", exitCode: 0, capturedAt: NOW, source: "manual-injection" };
  forged._chain = { seq: 1, prevHash: baseHash, hash: chain.computeChainHash(baseHash, { command: forged.command, observedResult: forged.observedResult, exitCode: forged.exitCode, capturedAt: forged.capturedAt, source: forged.source }) };

  const writeLog = (entries) => fs.writeFileSync(path.join(dir, "command-log.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeLog([base, hookSibling, writerSibling]);
  assert.equal(verifyCommandLogChain(dir).status, "forked");
  writeLog([base, hookSibling, forged]);
  assert.equal(verifyCommandLogChain(dir).status, "broken");
});

test("append is fail-open: an unwritable session dir does not throw", () => {
  assert.doesNotThrow(() => appendWriterObservedCommands("/nonexistent/definitely-missing", [{ command: "x", exit_code: 0, output_sha256: "e".repeat(64) }], NOW));
});
