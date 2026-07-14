import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import {
  NarrativeReaderError,
  readAgentEventCandidate,
  readCommandLogCandidate,
  readFileCandidate,
  readFlowStateCandidate,
  readFlowTransitionCandidate,
  readTelemetryCandidates,
  readTranscriptCandidate,
  readTrustCandidate,
} from "../../build/src/narrative/readers.js";

const require = createRequire(import.meta.url);
const { CHAIN_GENESIS, computeChainHash } = require("../../scripts/lib/command-log-chain.js");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-readers-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha8(bytes) {
  return sha256(bytes).slice(0, 8);
}

test("telemetry duplicate event ids are selected by deterministic file-order ordinal", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "full.jsonl"), [
    JSON.stringify({ session_id: "s1", event_id: "duplicate", value: "current" }),
    JSON.stringify({ session_id: "other", event_id: "duplicate", value: "ignore" }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "full.1.jsonl"), JSON.stringify({ session_id: "s1", event_id: "duplicate", value: "rotated" }) + "\n");

  const all = readTelemetryCandidates({ telemetryDir: dir, channel: "full", sessionId: "s1", eventId: "duplicate" });
  assert.deepEqual(all.map((candidate) => candidate.record.value), ["current", "rotated"]);
  const second = readTelemetryCandidates({ telemetryDir: dir, channel: "full", sessionId: "s1", eventId: "duplicate", ordinal: 1 });
  assert.equal(second[0].record.value, "rotated");
});

test("command-log reader verifies links with the normative command-log-chain module", (t) => {
  const sessionDir = tempDir(t);
  const first = { command: "npm test", source: "postToolUse-capture" };
  const firstHash = computeChainHash(CHAIN_GENESIS, first);
  const firstLinked = { ...first, _chain: { seq: 0, prevHash: CHAIN_GENESIS, hash: firstHash } };
  const second = { command: "npm run build", source: "postToolUse-capture" };
  const secondHash = computeChainHash(firstHash, second);
  const secondLinked = { ...second, _chain: { seq: 1, prevHash: firstHash, hash: secondHash } };
  const file = path.join(sessionDir, "command-log.jsonl");
  fs.writeFileSync(file, `${JSON.stringify(firstLinked)}\n${JSON.stringify(secondLinked)}\n`);

  const found = readCommandLogCandidate({ sessionDir, locator: { kind: "chained", seq: 1, hash8: secondHash.slice(0, 8) } });
  assert.equal(found.record.command, "npm run build");

  secondLinked.command = "tampered";
  fs.writeFileSync(file, `${JSON.stringify(firstLinked)}\n${JSON.stringify(secondLinked)}\n`);
  assert.throws(
    () => readCommandLogCandidate({ sessionDir, locator: { kind: "chained", seq: 1, hash8: secondHash.slice(0, 8) } }),
    (error) => error instanceof NarrativeReaderError && error.reason === "corrupt",
  );
});

test("legacy command-log and agent-event readers enforce raw line pins", (t) => {
  const sessionDir = tempDir(t);
  const legacy = Buffer.from(JSON.stringify({ command: "legacy" }));
  fs.writeFileSync(path.join(sessionDir, "command-log.jsonl"), Buffer.concat([legacy, Buffer.from("\n")]));
  assert.equal(readCommandLogCandidate({ sessionDir, locator: { kind: "legacy", line: 1, sha8: sha8(legacy) } }).record.command, "legacy");

  const agentDir = path.join(sessionDir, "agents", "agent-1");
  fs.mkdirSync(agentDir, { recursive: true });
  const event = Buffer.from(JSON.stringify({ kind: "delegation", summary: "work" }));
  fs.writeFileSync(path.join(agentDir, "events.jsonl"), Buffer.concat([event, Buffer.from("\n")]));
  assert.equal(readAgentEventCandidate({ sessionDir, agentId: "agent-1", lineIndex: 0, sha8: sha8(event), delegation: true }).record.summary, "work");
  assert.throws(
    () => readAgentEventCandidate({ sessionDir, agentId: "agent-1", lineIndex: 0, sha8: "00000000" }),
    (error) => error instanceof NarrativeReaderError && error.reason === "corrupt",
  );
});

test("trust, Flow state, transitions, transcripts, and repository files return pinned bytes", (t) => {
  const root = tempDir(t);
  const sessionDir = path.join(root, "session");
  fs.mkdirSync(sessionDir);
  const bundle = Buffer.from(JSON.stringify({ claims: [{ id: "c1", value: "pass" }], evidence: [{ id: "e1", passing: true }] }));
  fs.writeFileSync(path.join(sessionDir, "trust.bundle"), bundle);
  assert.equal(readTrustCandidate({ sessionDir, bundleSha8: sha8(bundle), id: "e1", kind: "evidence" }).record.passing, true);

  const flowRoot = path.join(root, "flow");
  const runDir = path.join(flowRoot, "runs", "run-1");
  fs.mkdirSync(runDir, { recursive: true });
  const transition = { from_step: "a", to_step: "b" };
  const state = Buffer.from(JSON.stringify({ run_id: "run-1", transitions: [transition] }));
  fs.writeFileSync(path.join(runDir, "state.json"), state);
  assert.equal(readFlowStateCandidate({ flowRoot, runId: "run-1", sha8: sha8(state) }).record.run_id, "run-1");
  assert.equal(readFlowTransitionCandidate({ flowRoot, runId: "run-1", index: 0, sha8: sha8(Buffer.from(JSON.stringify(transition))) }).record.to_step, "b");

  const transcript = path.join(root, "transcript.jsonl");
  fs.writeFileSync(transcript, "0123456789");
  assert.equal(readTranscriptCandidate({ absolutePath: transcript, byteStart: 2, byteEnd: 6 }).toString(), "2345");

  const repoFile = path.join(root, "source.txt");
  const fileBytes = Buffer.from("source bytes\n");
  fs.writeFileSync(repoFile, fileBytes);
  assert.deepEqual(readFileCandidate({ repoRoot: root, repoRelativePath: "source.txt", hash: sha256(fileBytes) }).raw, fileBytes);
  const gitHash = createHash("sha1").update(`blob ${fileBytes.length}\0`).update(fileBytes).digest("hex");
  assert.deepEqual(readFileCandidate({ repoRoot: root, repoRelativePath: "source.txt", hash: gitHash }).raw, fileBytes);
});

test("all file-opening readers reject final-component symlinks", (t) => {
  const root = tempDir(t);
  const outside = path.join(root, "outside.jsonl");
  fs.writeFileSync(outside, JSON.stringify({ session_id: "s", event_id: "e" }) + "\n");
  const telemetry = path.join(root, "telemetry");
  fs.mkdirSync(telemetry);
  fs.symlinkSync(outside, path.join(telemetry, "full.jsonl"));
  assert.throws(
    () => readTelemetryCandidates({ telemetryDir: telemetry, channel: "full", sessionId: "s", eventId: "e" }),
    (error) => error instanceof NarrativeReaderError && error.reason === "corrupt",
  );

  const realDir = path.join(root, "real-dir");
  fs.mkdirSync(realDir);
  const bytes = Buffer.from("pinned\n");
  fs.writeFileSync(path.join(realDir, "source.txt"), bytes);
  fs.symlinkSync(realDir, path.join(root, "linked-dir"));
  assert.throws(
    () => readFileCandidate({ repoRoot: root, repoRelativePath: "linked-dir/source.txt", hash: sha256(bytes) }),
    (error) => error instanceof NarrativeReaderError && error.reason === "corrupt",
  );
});
