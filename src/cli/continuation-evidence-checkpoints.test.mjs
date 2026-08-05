import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import {
  createContinuationEvidenceCheckpointWriter,
  validateContinuationEvidenceCheckpointDirectory,
  verifyContinuationEvidenceCheckpoints,
} from "../../build/src/continuation-evidence-checkpoints.js";

const ADAPTER_IDENTITY = createHash("sha256").update("adapter").digest("hex");
const RUN_ID = "checkpoint-run";
const DEFINITION_ID = "builder";

function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-checkpoints-")));
  const keys = generateKeyPairSync("ed25519");
  const publicKeySpkiB64 = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const writer = createContinuationEvidenceCheckpointWriter({
    checkpointDir: directory,
    signer: { privateKey: keys.privateKey, publicKeySpkiB64 },
    adapterCommandIdentity: ADAPTER_IDENTITY,
    maxTurns: 4,
  });
  const verify = () => verifyContinuationEvidenceCheckpoints({
    checkpointDir: directory,
    expectedPublicKeySpkiB64: publicKeySpkiB64,
    expectedAdapterCommandIdentity: ADAPTER_IDENTITY,
    expectedMaxTurns: 4,
    expectedRunId: RUN_ID,
    expectedDefinitionId: DEFINITION_ID,
  });
  return { directory, keys, writer, verify };
}

function acceptedTurn(iteration, status = "completed") {
  const result = status === "wait"
    ? { status: "wait", barrier: { kind: "deadline", at: "2026-07-24T12:00:00.000Z" } }
    : { status: "completed", evidence: { usage: { input_tokens: 10, output_tokens: 2 } } };
  return {
    schema_version: "1.0",
    turn_id: `${RUN_ID}:${iteration}`,
    iteration,
    request: {
      schema_version: "1.0",
      run_id: RUN_ID,
      definition_id: DEFINITION_ID,
      current_step: "builder.design-probe",
      iteration,
      max_turns: 4,
      next_action: null,
    },
    result,
    progress: null,
    captured_at: "2026-07-24T12:00:00.000Z",
  };
}

function projection(status = "active") {
  return {
    schema: "kontour.flow-agents.canonical_gate_projection",
    version: "1.0",
    run_id: RUN_ID,
    definition_id: DEFINITION_ID,
    definition_version: "1.0",
    definition_digest: "a".repeat(64),
    status,
    current_step: "builder.design-probe",
    gates: [],
    accepted_exceptions: [],
  };
}

test("signed continuation checkpoints verify an exact ordered prefix", () => {
  const { directory, writer, verify } = fixture();
  writer.publish(acceptedTurn(1), projection());
  writer.publish(acceptedTurn(2, "wait"), projection("waiting"));

  const result = verify();
  assert.deepEqual(result.checkpoints.map((checkpoint) => checkpoint.checkpoint_sequence), [1, 2]);
  assert.equal(result.checkpoints[0].accepted_turn.result.status, "completed");
  assert.equal(result.checkpoints[1].accepted_turn.result.status, "wait");
  assert.equal(result.checkpoints[1].evidence_scope, "accepted_prefix");
  assert.equal(result.checkpoints[1].drive_completion, "not_attested");
  assert.match(result.checkpoints[1].previous_checkpoint_sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(path.join(directory, "checkpoint-000001.json")).mode & 0o777, 0o600);
});

test("interrupted temporary output does not invalidate published checkpoints", () => {
  const { directory, writer, verify } = fixture();
  writer.publish(acceptedTurn(1), projection());
  fs.writeFileSync(path.join(directory, `.checkpoint-${"a".repeat(32)}.tmp`), "{\"truncated\":");

  assert.equal(verify().checkpoints.length, 1);
});

test("tampering and final-name collisions fail closed without replacing prior evidence", () => {
  const { directory, writer, verify } = fixture();
  writer.publish(acceptedTurn(1), projection());
  const first = path.join(directory, "checkpoint-000001.json");
  const original = fs.readFileSync(first);
  fs.writeFileSync(first, Buffer.concat([original.subarray(0, original.length - 2), Buffer.from("x\n")]));
  assert.throws(verify, /JSON|signature|envelope/);
  fs.writeFileSync(first, original);

  const collision = path.join(directory, "checkpoint-000002.json");
  fs.writeFileSync(collision, "{}\n", { mode: 0o600 });
  assert.throws(() => writer.publish(acceptedTurn(2), projection()), /EEXIST/);
  fs.unlinkSync(collision);
  assert.equal(verify().checkpoints.length, 1);
});

test("checkpoint directory validation rejects prior finals before key consumption", () => {
  const { directory } = fixture();
  fs.writeFileSync(path.join(directory, "checkpoint-000001.json"), "{}\n");
  assert.throws(
    () => validateContinuationEvidenceCheckpointDirectory(directory),
    /must be empty/,
  );
});

test("verification rejects unsupported directory entries and malformed signed nested contracts", () => {
  const { directory, keys, writer, verify } = fixture();
  writer.publish(acceptedTurn(1), projection());
  fs.writeFileSync(path.join(directory, "checkpoint-malformed.json"), "{}\n");
  assert.throws(verify, /unsupported entry/);
  fs.unlinkSync(path.join(directory, "checkpoint-malformed.json"));

  const file = path.join(directory, "checkpoint-000001.json");
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  const payload = JSON.parse(Buffer.from(envelope.payload_b64, "base64"));
  payload.accepted_turn.unsupported = true;
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  envelope.payload_b64 = payloadBytes.toString("base64");
  envelope.signature_b64 = sign(null, payloadBytes, keys.privateKey).toString("base64");
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`);
  assert.throws(verify, /accepted-turn capture has unsupported fields/);
});

test("verification rejects signed captures without exact turn identity or canonical time", () => {
  for (const mutate of [
    (payload) => { payload.accepted_turn.turn_id = ""; },
    (payload) => { payload.accepted_turn.captured_at = "0"; },
  ]) {
    const { directory, keys, writer, verify } = fixture();
    writer.publish(acceptedTurn(1), projection());
    resignCheckpoint(directory, keys.privateKey, mutate);
    assert.throws(verify, /accepted-turn capture is malformed/);
  }
});

test("verification rejects malformed or cross-gate accepted exceptions", () => {
  for (const acceptedExceptions of [
    [{ garbage: true }],
    [{
      id: "exception-1",
      gate_id: "other-gate",
      reason: "fixture",
      authority: "test",
      accepted_at: "2026-07-24T12:00:00.000Z",
    }],
  ]) {
    const { directory, keys, writer, verify } = fixture();
    writer.publish(acceptedTurn(1), projection());
    resignCheckpoint(directory, keys.privateKey, (payload) => {
      payload.canonical_gate_projection.gates = [{
        gate_id: "builder-gate",
        status: "pass",
        evidence_refs: [],
        matched_expectations: [],
        accepted_exception_id: "exception-1",
        diagnostics: [],
      }];
      payload.canonical_gate_projection.accepted_exceptions = acceptedExceptions;
    });
    assert.throws(verify, /accepted exception/);
  }
});

test("checkpoint capacity admits a valid large accepted-turn request", () => {
  const { writer, verify } = fixture();
  const turn = acceptedTurn(1);
  turn.request.next_action = { guidance: "x".repeat(400_000) };
  writer.publish(turn, projection());
  assert.equal(verify().checkpoints.length, 1);
});

function resignCheckpoint(directory, privateKey, mutate) {
  const file = path.join(directory, "checkpoint-000001.json");
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  const payload = JSON.parse(Buffer.from(envelope.payload_b64, "base64"));
  mutate(payload);
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  envelope.payload_b64 = payloadBytes.toString("base64");
  envelope.signature_b64 = sign(null, payloadBytes, privateKey).toString("base64");
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`);
}
