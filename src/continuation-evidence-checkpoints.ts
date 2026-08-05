import * as fs from "node:fs";
import * as path from "node:path";
import {
  createHash,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import type { ContinuationAcceptedTurn } from "./continuation-driver.js";
import { validateAcceptedTurn } from "./continuation-validation.js";
import {
  validateCanonicalGateProjection,
  type CanonicalGateProjection,
} from "./canonical-gate-projection.js";

const PAYLOAD_SCHEMA = "kontour.flow-agents.continuation_evidence_checkpoint";
const ENVELOPE_SCHEMA = "kontour.flow-agents.continuation_evidence_checkpoint_attestation";
const VERSION = "1.0";
const MAX_CHECKPOINTS = 100;
const MAX_ACCEPTED_TURN_BYTES = 1_048_576;
const MAX_CANONICAL_GATE_PROJECTION_BYTES = 1_048_576;
const MAX_CHECKPOINT_PAYLOAD_BYTES = MAX_ACCEPTED_TURN_BYTES + MAX_CANONICAL_GATE_PROJECTION_BYTES + 4_096;
const MAX_CHECKPOINT_BYTES = 4 * Math.ceil(MAX_CHECKPOINT_PAYLOAD_BYTES / 3) + 4_096;
const DIGEST = /^[a-f0-9]{64}$/;

type EvidenceSigner = {
  privateKey: KeyObject;
  publicKeySpkiB64: string;
};

export type ContinuationEvidenceCheckpoint = {
  schema: typeof PAYLOAD_SCHEMA;
  version: typeof VERSION;
  checkpoint_sequence: number;
  previous_checkpoint_sha256: string | null;
  evidence_scope: "accepted_prefix";
  drive_completion: "not_attested";
  adapter_command_identity: string;
  max_turns: number;
  accepted_turn: ContinuationAcceptedTurn;
  canonical_gate_projection: CanonicalGateProjection;
};

type CheckpointEnvelope = {
  schema: typeof ENVELOPE_SCHEMA;
  version: typeof VERSION;
  public_key_spki_b64: string;
  payload_b64: string;
  signature_b64: string;
};

export type VerifiedContinuationEvidenceCheckpoints = {
  schema: "kontour.flow-agents.verified_continuation_evidence_checkpoints";
  version: typeof VERSION;
  public_key_spki_b64: string;
  adapter_command_identity: string;
  max_turns: number;
  run_id: string;
  definition_id: string;
  checkpoints: ContinuationEvidenceCheckpoint[];
};

export function validateContinuationEvidenceCheckpointDirectory(checkpointDir: string): void {
  const directory = pinnedDirectory(checkpointDir, "continuation evidence checkpoint");
  if (fs.readdirSync(directory.path).length > 0) {
    throw new Error("continuation evidence checkpoint directory must be empty");
  }
}

export function createContinuationEvidenceCheckpointWriter(input: {
  checkpointDir: string;
  signer: EvidenceSigner;
  adapterCommandIdentity: string;
  maxTurns: number;
}): { publish(turn: ContinuationAcceptedTurn, canonicalGateProjection: CanonicalGateProjection): void } {
  const directory = pinnedDirectory(input.checkpointDir, "continuation evidence checkpoint");
  assertSigner(input.signer);
  assertMissionConfig(input.adapterCommandIdentity, input.maxTurns);
  validateContinuationEvidenceCheckpointDirectory(input.checkpointDir);
  let sequence = 0;
  let previousDigest: string | null = null;
  return {
    publish(turn, canonicalGateProjection): void {
      sequence += 1;
      const payload = checkpointPayload({
        sequence,
        previousDigest,
        adapterCommandIdentity: input.adapterCommandIdentity,
        maxTurns: input.maxTurns,
        turn,
        canonicalGateProjection,
      });
      const envelope = signCheckpoint(payload, input.signer);
      const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
      if (bytes.length > MAX_CHECKPOINT_BYTES) throw new Error(`continuation evidence checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
      publishAtomic(directory, sequence, bytes);
      previousDigest = sha256(bytes);
    },
  };
}

export function verifyContinuationEvidenceCheckpoints(input: {
  checkpointDir: string;
  expectedPublicKeySpkiB64: string;
  expectedAdapterCommandIdentity: string;
  expectedMaxTurns: number;
  expectedRunId: string;
  expectedDefinitionId: string;
}): VerifiedContinuationEvidenceCheckpoints {
  const directory = pinnedDirectory(input.checkpointDir, "continuation evidence checkpoint");
  assertMissionConfig(input.expectedAdapterCommandIdentity, input.expectedMaxTurns);
  const publicKey = strictPublicKey(input.expectedPublicKeySpkiB64);
  const files = checkpointFiles(directory.path);
  if (files.length > input.expectedMaxTurns) {
    throw new Error("continuation evidence checkpoint count exceeds the expected mission budget");
  }
  let previousDigest: string | null = null;
  const checkpoints = files.map((file, index) => {
    const sequence = index + 1;
    if (file.sequence !== sequence) throw new Error("continuation evidence checkpoints are not contiguous");
    const bytes = readPinnedFile(directory, file.path);
    const envelope = parseEnvelope(bytes, input.expectedPublicKeySpkiB64);
    const payloadBytes = strictBase64(envelope.payload_b64, "continuation evidence checkpoint payload");
    const signature = strictBase64(envelope.signature_b64, "continuation evidence checkpoint signature");
    if (!verify(null, payloadBytes, publicKey, signature)) throw new Error("continuation evidence checkpoint signature is invalid");
    const payload = parsePayload(payloadBytes);
    validatePayload(payload, {
      sequence,
      previousDigest,
      adapterCommandIdentity: input.expectedAdapterCommandIdentity,
      maxTurns: input.expectedMaxTurns,
      runId: input.expectedRunId,
      definitionId: input.expectedDefinitionId,
    });
    previousDigest = sha256(bytes);
    return payload;
  });
  return {
    schema: "kontour.flow-agents.verified_continuation_evidence_checkpoints",
    version: VERSION,
    public_key_spki_b64: input.expectedPublicKeySpkiB64,
    adapter_command_identity: input.expectedAdapterCommandIdentity,
    max_turns: input.expectedMaxTurns,
    run_id: input.expectedRunId,
    definition_id: input.expectedDefinitionId,
    checkpoints,
  };
}

function checkpointPayload(input: {
  sequence: number;
  previousDigest: string | null;
  adapterCommandIdentity: string;
  maxTurns: number;
  turn: ContinuationAcceptedTurn;
  canonicalGateProjection: CanonicalGateProjection;
}): ContinuationEvidenceCheckpoint {
  validateCheckpointAcceptedTurn(input.turn);
  validateCanonicalGateProjection(input.canonicalGateProjection);
  assertJsonSize(input.turn, MAX_ACCEPTED_TURN_BYTES, "continuation accepted-turn capture");
  assertJsonSize(input.canonicalGateProjection, MAX_CANONICAL_GATE_PROJECTION_BYTES, "canonical gate projection");
  return {
    schema: PAYLOAD_SCHEMA,
    version: VERSION,
    checkpoint_sequence: input.sequence,
    previous_checkpoint_sha256: input.previousDigest,
    evidence_scope: "accepted_prefix",
    drive_completion: "not_attested",
    adapter_command_identity: input.adapterCommandIdentity,
    max_turns: input.maxTurns,
    accepted_turn: structuredClone(input.turn),
    canonical_gate_projection: structuredClone(input.canonicalGateProjection),
  };
}

function signCheckpoint(payload: ContinuationEvidenceCheckpoint, signer: EvidenceSigner): CheckpointEnvelope {
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (payloadBytes.length > MAX_CHECKPOINT_PAYLOAD_BYTES) {
    throw new Error(`continuation evidence checkpoint payload exceeds ${MAX_CHECKPOINT_PAYLOAD_BYTES} bytes`);
  }
  return {
    schema: ENVELOPE_SCHEMA,
    version: VERSION,
    public_key_spki_b64: signer.publicKeySpkiB64,
    payload_b64: payloadBytes.toString("base64"),
    signature_b64: sign(null, payloadBytes, signer.privateKey).toString("base64"),
  };
}

function parseEnvelope(bytes: Buffer, expectedPublicKey: string): CheckpointEnvelope {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("continuation evidence checkpoint is not valid JSON"); }
  if (!isRecord(value)
    || value.schema !== ENVELOPE_SCHEMA
    || value.version !== VERSION
    || value.public_key_spki_b64 !== expectedPublicKey
    || typeof value.payload_b64 !== "string"
    || typeof value.signature_b64 !== "string") {
    throw new Error("continuation evidence checkpoint envelope is invalid");
  }
  exactKeys(value, ["schema", "version", "public_key_spki_b64", "payload_b64", "signature_b64"]);
  return value as CheckpointEnvelope;
}

function parsePayload(bytes: Buffer): ContinuationEvidenceCheckpoint {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("continuation evidence checkpoint payload is not valid JSON"); }
  if (!isRecord(value)) throw new Error("continuation evidence checkpoint payload is invalid");
  return value as unknown as ContinuationEvidenceCheckpoint;
}

function validatePayload(value: ContinuationEvidenceCheckpoint, expected: {
  sequence: number;
  previousDigest: string | null;
  adapterCommandIdentity: string;
  maxTurns: number;
  runId: string;
  definitionId: string;
}): void {
  if (value.schema !== PAYLOAD_SCHEMA
    || value.version !== VERSION
    || value.checkpoint_sequence !== expected.sequence
    || value.previous_checkpoint_sha256 !== expected.previousDigest
    || value.evidence_scope !== "accepted_prefix"
    || value.drive_completion !== "not_attested"
    || value.adapter_command_identity !== expected.adapterCommandIdentity
    || value.max_turns !== expected.maxTurns
    || !isRecord(value.accepted_turn)
    || value.accepted_turn.request?.run_id !== expected.runId
    || value.accepted_turn.request?.definition_id !== expected.definitionId
    || value.accepted_turn.request?.max_turns !== expected.maxTurns) {
    throw new Error("continuation evidence checkpoint payload identity is invalid");
  }
  validateCheckpointAcceptedTurn(value.accepted_turn);
  const projection = validateCanonicalGateProjection(value.canonical_gate_projection);
  if (projection.run_id !== expected.runId || projection.definition_id !== expected.definitionId) {
    throw new Error("continuation evidence checkpoint projection identity is invalid");
  }
  if (expected.previousDigest !== null && !DIGEST.test(expected.previousDigest)) {
    throw new Error("continuation evidence checkpoint chain digest is invalid");
  }
  exactKeys(value, [
    "schema", "version", "checkpoint_sequence", "previous_checkpoint_sha256", "evidence_scope", "drive_completion",
    "adapter_command_identity", "max_turns", "accepted_turn", "canonical_gate_projection",
  ]);
}

function validateCheckpointAcceptedTurn(value: ContinuationAcceptedTurn): void {
  validateAcceptedTurn(value);
  const resultKeys = ["status"];
  if (value.result.summary !== undefined) resultKeys.push("summary");
  if (value.result.status === "completed" && value.result.evidence !== undefined) resultKeys.push("evidence");
  if (value.result.status === "wait") resultKeys.push("barrier");
  exactKeys(value.result as unknown as Record<string, unknown>, resultKeys);
}

function assertSigner(signer: EvidenceSigner): void {
  if (signer.privateKey.asymmetricKeyType !== "ed25519") throw new Error("continuation evidence checkpoint signer must be Ed25519");
  const actual = createPublicKey(signer.privateKey as unknown as Parameters<typeof createPublicKey>[0])
    .export({ type: "spki", format: "der" }).toString("base64");
  if (actual !== signer.publicKeySpkiB64) throw new Error("continuation evidence checkpoint signer keypair does not match");
}

function assertMissionConfig(adapterCommandIdentity: string, maxTurns: number): void {
  if (!DIGEST.test(adapterCommandIdentity)) throw new Error("continuation evidence checkpoint adapter identity is invalid");
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_CHECKPOINTS) {
    throw new Error("continuation evidence checkpoint max turns is invalid");
  }
}

type PinnedDirectory = { path: string; stat: fs.Stats };

function pinnedDirectory(input: string, label: string): PinnedDirectory {
  if (!path.isAbsolute(input) || path.normalize(input) !== input) throw new Error(`${label} directory must be an absolute canonical path`);
  const lexical = fs.lstatSync(input);
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new Error(`${label} directory must be a non-symlink directory`);
  const real = fs.realpathSync(input);
  const stat = fs.statSync(real);
  if (real !== input || !stat.isDirectory() || !sameIdentity(lexical, stat)) throw new Error(`${label} directory identity is invalid`);
  return { path: real, stat };
}

function checkpointFiles(directory: string): Array<{ path: string; sequence: number }> {
  const files = fs.readdirSync(directory).flatMap((name) => {
    const match = /^checkpoint-([0-9]{6})\.json$/.exec(name);
    if (match) return [{ path: path.join(directory, name), sequence: Number(match[1]) }];
    if (/^\.checkpoint-[a-f0-9]{32}\.tmp$/.test(name)) return [];
    throw new Error(`continuation evidence checkpoint directory contains unsupported entry: ${name}`);
  });
  if (files.length > MAX_CHECKPOINTS) throw new Error("continuation evidence checkpoint count exceeds its limit");
  return files.sort((left, right) => left.sequence - right.sequence);
}

function publishAtomic(directory: PinnedDirectory, sequence: number, bytes: Buffer): void {
  assertDirectoryIdentity(directory);
  const finalFile = path.join(directory.path, `checkpoint-${String(sequence).padStart(6, "0")}.json`);
  const temporary = path.join(directory.path, `.checkpoint-${randomBytes(16).toString("hex")}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow(), 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    assertDirectoryIdentity(directory);
    fs.linkSync(temporary, finalFile);
    fsyncDirectory(directory.path);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  fsyncDirectory(directory.path);
}

function readPinnedFile(directory: PinnedDirectory, file: string): Buffer {
  assertDirectoryIdentity(directory);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow());
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_CHECKPOINT_BYTES) throw new Error("continuation evidence checkpoint file is invalid");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error("continuation evidence checkpoint changed while reading");
      offset += read;
    }
    const after = fs.fstatSync(fd);
    const lexical = fs.lstatSync(file);
    if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || !sameIdentity(after, lexical) || lexical.isSymbolicLink()) {
      throw new Error("continuation evidence checkpoint changed while reading");
    }
    assertDirectoryIdentity(directory);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function assertDirectoryIdentity(directory: PinnedDirectory): void {
  const lexical = fs.lstatSync(directory.path);
  if (lexical.isSymbolicLink() || !lexical.isDirectory() || !sameIdentity(lexical, directory.stat)) {
    throw new Error("continuation evidence checkpoint directory changed identity");
  }
}

function strictPublicKey(value: string): KeyObject {
  try {
    const bytes = strictBase64(value, "continuation evidence checkpoint public key");
    const key = createPublicKey({ key: bytes, type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key;
  } catch {
    throw new Error("continuation evidence checkpoint public key is invalid");
  }
}

function strictBase64(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${label} is not canonical base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${label} is not canonical base64`);
  return bytes;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("continuation evidence checkpoint contains unsupported fields");
  }
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function noFollow(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertJsonSize(value: unknown, maximum: number, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) {
    throw new Error(`${label} exceeds ${maximum} bytes`);
  }
}
