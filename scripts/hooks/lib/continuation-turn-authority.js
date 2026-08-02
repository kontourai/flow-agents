'use strict';

// A transient, driver-owned capability for one adapter turn. Ed25519 proves
// that the record was issued by the still-running driver's private key; it is
// not a filesystem isolation boundary against a hostile same-UID process.

const fs = require('fs');
const path = require('path');
const { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, verify } = require('crypto');
const { isDeepStrictEqual } = require('util');

const SCHEMA_VERSION = '3.0';
const FILE_NAME = 'active-turn.json';
const BOUNDARY_FILE_NAME = 'turn-boundary.json';
const MAX_ACTIVE_TURN_BYTES = 16 * 1024;
const MAX_DRIVER_RECORD_BYTES = 1024 * 1024;
const MAX_ASSIGNMENT_RECORD_BYTES = 1024 * 1024;
const MAX_LOCK_RECORD_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 86_400_000;

function activeTurnFile(sessionDir) {
  return path.join(path.resolve(sessionDir), 'continuation-driver', FILE_NAME);
}

function activeTurnBoundaryFile(sessionDir) {
  return path.join(path.resolve(sessionDir), 'continuation-driver', BOUNDARY_FILE_NAME);
}

function issueActiveTurnAuthority(input) {
  const sessionDir = path.resolve(input.sessionDir);
  const parents = captureParents(sessionDir, true);
  const issuedAt = input.now instanceof Date ? input.now : new Date();
  const timeoutMs = input.timeoutMs;
  assertPositiveInteger(timeoutMs, 'timeoutMs', 1, MAX_TIMEOUT_MS);
  const assignmentActor = requiredString(input.assignmentActor, 'assignmentActor');
  const assignmentActorStruct = requiredActorStruct(input.assignmentActorStruct, 'assignmentActorStruct');
  const assignment = readActiveAssignment(sessionDir, parents, assignmentActor, assignmentActorStruct);
  const keys = generateKeyPairSync('ed25519');
  const turnSecret = randomBytes(32).toString('base64url');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const publicKeyDigest = sha256(publicKey);
  const record = {
    schema_version: SCHEMA_VERSION,
    run_id: requiredSafeRunId(input.runId, 'runId'),
    definition_id: requiredString(input.definitionId, 'definitionId'),
    definition_version: requiredString(input.definitionVersion, 'definitionVersion'),
    definition_digest: requiredDigest(input.definitionDigest, 'definitionDigest'),
    issued_step: requiredString(input.currentStep, 'currentStep'),
    iteration: requiredInteger(input.iteration, 'iteration', 1, 100),
    max_turns: requiredInteger(input.maxTurns, 'maxTurns', 1, 100),
    adapter_command_identity: requiredString(input.adapterCommandIdentity, 'adapterCommandIdentity'),
    assignment_actor: assignmentActor,
    assignment_actor_struct: assignmentActorStruct,
    assignment_record_sha256: assignment.sha256,
    driver_lock: {
      pid: requiredInteger(input.lock.pid, 'lock.pid', 1, 2_147_483_647),
      token: requiredString(input.lock.token, 'lock.token'),
      created_at: requiredTimestamp(input.lock.created_at, 'lock.created_at'),
    },
    turn_secret_sha256: sha256(turnSecret),
    public_key_spki_b64: publicKey,
    public_key_digest: publicKeyDigest,
    timeout_ms: timeoutMs,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + timeoutMs).toISOString(),
  };
  if (record.run_id !== path.basename(sessionDir)) throw new Error('runId must match the session directory');
  record.signature_b64 = sign(null, canonicalBytes(record), keys.privateKey).toString('base64');
  writeRecord(sessionDir, parents, record);
  return {
    runId: record.run_id,
    turnSecret,
    publicKeyDigest,
    record,
    cleanup: () => removeActiveTurnAuthority(sessionDir, record.turn_secret_sha256, parents),
  };
}

function removeActiveTurnAuthority(sessionDir, turnSecretSha256, issuedParents) {
  try {
    const parents = captureParents(sessionDir, false);
    if (issuedParents && !sameParents(issuedParents, parents)) return false;
    const file = activeTurnFile(sessionDir);
    const loaded = readRegularJson(file, 'continuation active turn', parents, MAX_ACTIVE_TURN_BYTES);
    if (loaded.value.turn_secret_sha256 !== turnSecretSha256) return false;
    assertParentsStable(parents);
    const current = fileIdentity(file, 'continuation active turn');
    if (!sameIdentity(current, loaded.identity)) return false;
    fs.unlinkSync(file);
    removeActiveTurnBoundary(sessionDir, turnSecretSha256, parents);
    assertParentsStable(parents);
    return true;
  } catch {
    // Do not unlink through a changed parent. The signed record expires.
    return false;
  }
}

function recordActiveTurnBoundary(input) {
  const sessionDir = path.resolve(input.sessionDir);
  const turnSecret = requiredTurnSecret(input.turnSecret);
  const canonicalState = input.canonicalState;
  const authority = validateSignedActiveTurnAssignmentAuthority({
    sessionDir,
    runId: input.runId,
    turnSecret,
  });
  if (!authority.valid) throw new Error(`continuation boundary authority is invalid: ${authority.reason}`);
  const canonicalIdentity = validateCanonicalTurnIdentity(authority.record, canonicalState, false);
  if (!canonicalIdentity.valid) throw new Error(`continuation boundary canonical identity is invalid: ${canonicalIdentity.reason}`);
  if (canonicalState.status === 'active' && canonicalState.current_step === authority.record.issued_step) {
    throw new Error('continuation boundary requires canonical Flow to leave the issued step');
  }
  const parents = captureParents(sessionDir, false);
  const record = {
    schema_version: '1.0',
    run_id: authority.record.run_id,
    definition_id: authority.record.definition_id,
    definition_version: authority.record.definition_version,
    definition_digest: authority.record.definition_digest,
    issued_step: authority.record.issued_step,
    canonical_status: requiredString(canonicalState.status, 'canonical_status'),
    canonical_step: requiredString(canonicalState.current_step, 'canonical_step'),
    public_key_digest: authority.record.public_key_digest,
    turn_secret_sha256: authority.record.turn_secret_sha256,
    observed_at: new Date().toISOString(),
  };
  record.hmac_sha256 = boundaryHmac(record, turnSecret);
  writeBoundaryRecord(sessionDir, parents, record);
  return record;
}

function readActiveTurnBoundary(input) {
  try {
    const sessionDir = path.resolve(input.sessionDir);
    const turnSecret = requiredTurnSecret(input.turnSecret);
    const base = validateSignedActiveTurnAssignmentAuthority({
      sessionDir,
      runId: input.runId,
      turnSecret,
    });
    if (!base.valid) return base;
    const parents = captureParents(sessionDir, false);
    const loaded = readRegularJson(activeTurnBoundaryFile(sessionDir), 'continuation turn boundary', parents, MAX_ACTIVE_TURN_BYTES);
    const record = loaded.value;
    validateBoundaryRecord(record);
    if (!equalText(record.run_id, base.record.run_id)
      || !equalText(record.definition_id, base.record.definition_id)
      || !equalText(record.definition_version, base.record.definition_version)
      || !equalText(record.definition_digest, base.record.definition_digest)
      || !equalText(record.issued_step, base.record.issued_step)
      || !equalText(record.public_key_digest, base.record.public_key_digest)
      || !equalText(record.turn_secret_sha256, base.record.turn_secret_sha256)
      || !equalText(record.hmac_sha256, boundaryHmac(record, turnSecret))) return invalid('continuation boundary receipt does not match signed authority');
    return { valid: true, record };
  } catch (error) {
    return invalid(error && error.message ? error.message : 'continuation boundary receipt is malformed');
  }
}

function writeBoundaryRecord(sessionDir, parents, record) {
  assertParentsStable(parents);
  const file = activeTurnBoundaryFile(sessionDir);
  const temp = path.join(path.dirname(file), `.${BOUNDARY_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  let tempIdentity = null;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    tempIdentity = fileIdentity(temp, 'continuation turn boundary temporary file');
    assertParentsStable(parents);
    fs.renameSync(temp, file);
    assertParentsStable(parents);
  } finally {
    removeOwnedTemp(temp, tempIdentity, parents);
  }
}

function removeActiveTurnBoundary(sessionDir, turnSecretSha256, parents) {
  try {
    const file = activeTurnBoundaryFile(sessionDir);
    if (!fs.existsSync(file)) return;
    const loaded = readRegularJson(file, 'continuation turn boundary', parents, MAX_ACTIVE_TURN_BYTES);
    if (!equalText(loaded.value.turn_secret_sha256, turnSecretSha256)) return;
    fs.unlinkSync(file);
    assertParentsStable(parents);
  } catch {
    // The bounded receipt expires with its active-turn authority.
  }
}

function validateBoundaryRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schema_version !== '1.0') throw new Error('continuation boundary schema is unsupported');
  for (const field of ['run_id', 'definition_id', 'definition_version', 'definition_digest', 'issued_step', 'canonical_status', 'canonical_step', 'public_key_digest', 'turn_secret_sha256', 'observed_at', 'hmac_sha256']) requiredString(record[field], field);
  requiredSafeRunId(record.run_id, 'run_id');
  for (const field of ['definition_digest', 'public_key_digest', 'turn_secret_sha256', 'hmac_sha256']) requiredDigest(record[field], field);
  requiredTimestamp(record.observed_at, 'observed_at');
}

function boundaryHmac(record, turnSecret) {
  const unsigned = { ...record };
  delete unsigned.hmac_sha256;
  return createHmac('sha256', turnSecret).update(canonicalBytes(unsigned)).digest('hex');
}

// Validates the signed, live assignment capability without consulting Flow's
// current state. Public assignment-gated workflow commands use this narrow
// fallback after ordinary actor resolution fails; Stop adds canonical-state
// checks before treating its unfinished-gate warning as advisory.
function validateSignedActiveTurnAssignmentAuthority(input) {
  try {
    const runId = requiredSafeRunId(input.runId, 'runId');
    const turnSecret = requiredTurnSecret(input.turnSecret);
    const sessionDir = path.resolve(input.sessionDir);
    if (path.basename(sessionDir) !== runId) return invalid('run does not match session');
    const parents = captureParents(sessionDir, false);
    const record = readRegularJson(activeTurnFile(sessionDir), 'continuation active turn', parents, MAX_ACTIVE_TURN_BYTES).value;
    validateRecord(record);
    if (!equalText(record.run_id, runId)) return invalid('run does not match signed authority');
    if (input.definitionVersion !== undefined && !equalText(record.definition_version, requiredString(input.definitionVersion, 'definitionVersion'))) return invalid('effective definition version does not match signed authority');
    if (input.definitionDigest !== undefined && !equalText(record.definition_digest, requiredDigest(input.definitionDigest, 'definitionDigest'))) return invalid('effective definition digest does not match signed authority');
    if (!equalText(record.turn_secret_sha256, sha256(turnSecret))) return invalid('turn secret does not match');
    if (!validSignature(record)) return invalid('authority signature does not verify');
    const assignment = readActiveAssignment(sessionDir, parents, record.assignment_actor, record.assignment_actor_struct);
    if (!equalText(record.assignment_record_sha256, assignment.sha256)) return invalid('active assignment record changed');
    const mission = readRegularJson(path.join(sessionDir, 'continuation-driver', 'state.json'), 'continuation driver state', parents, MAX_DRIVER_RECORD_BYTES).value;
    if (!mission || mission.schema_version !== '1.0'
      || mission.run_id !== record.run_id
      || mission.definition_id !== record.definition_id
      || mission.active_turn_definition_version !== record.definition_version
      || mission.active_turn_definition_digest !== record.definition_digest
      || mission.adapter_command_identity !== record.adapter_command_identity
      || mission.max_turns !== record.max_turns
      || mission.turns_started !== record.iteration
      || mission.active_turn_step !== record.issued_step
      || mission.active_turn_public_key_digest !== record.public_key_digest
      || mission.status !== 'active') return invalid('driver mission does not match');
    const lockFile = path.join(sessionDir, 'continuation-driver', 'locks', `${record.driver_lock.pid}-${record.driver_lock.token}.lock`);
    const lock = readRegularJson(lockFile, 'continuation driver lock', parents, MAX_LOCK_RECORD_BYTES).value;
    if (!lock || lock.schema_version !== '1.0'
      || lock.pid !== record.driver_lock.pid
      || lock.token !== record.driver_lock.token
      || lock.created_at !== record.driver_lock.created_at
      || !processAlive(lock.pid)) return invalid('driver lock is not live');
    const now = input.now instanceof Date ? input.now : new Date();
    if (now.getTime() < Date.parse(record.issued_at) || now.getTime() > Date.parse(record.expires_at)) return invalid('authority is expired');
    assertParentsStable(parents);
    return { valid: true, record };
  } catch (error) {
    return invalid(error && error.message ? error.message : 'authority is malformed');
  }
}

function validateActiveTurnAuthority(input) {
  const base = validateSignedActiveTurnAssignmentAuthority(input);
  if (!base.valid) return base;
  try {
    const canonical = validateCanonicalTurnIdentity(base.record, input.canonicalState, true);
    return canonical.valid ? base : canonical;
  } catch (error) {
    return invalid(error && error.message ? error.message : 'canonical Flow state is malformed');
  }
}

function validateCanonicalTurnIdentity(record, canonical, requireActive) {
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)
    || (requireActive && canonical.status !== 'active')
    || typeof canonical.status !== 'string' || !canonical.status
    || canonical.run_id !== record.run_id
    || canonical.definition_id !== record.definition_id
    || canonical.definition_version !== record.definition_version
    || canonical.definition_digest !== record.definition_digest
    || typeof canonical.current_step !== 'string' || !canonical.current_step) return invalid('canonical Flow state does not match');
  return { valid: true };
}

function invalid(reason) {
  return { valid: false, reason };
}

function writeRecord(sessionDir, parents, record) {
  assertParentsStable(parents);
  const file = activeTurnFile(sessionDir);
  if (fs.existsSync(file)) fileIdentity(file, 'continuation active turn');
  const temp = path.join(path.dirname(file), `.${FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  let tempIdentity = null;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    tempIdentity = fileIdentity(temp, 'continuation active turn temporary file');
    assertParentsStable(parents);
    fs.renameSync(temp, file);
    assertParentsStable(parents);
  } finally {
    removeOwnedTemp(temp, tempIdentity, parents);
  }
}

function removeOwnedTemp(temp, expected, parents) {
  if (!expected) return;
  try {
    assertParentsStable(parents);
    if (!sameIdentity(fileIdentity(temp, 'continuation active turn temporary file'), expected)) return;
    fs.unlinkSync(temp);
    assertParentsStable(parents);
  } catch {
    // Parent or temp identity changed. Leave the bounded temporary record for
    // operator cleanup rather than unlinking through a replacement path.
  }
}

function captureParents(sessionDir, create) {
  const session = safeDirectory(path.resolve(sessionDir), 'session directory', create);
  const driver = safeDirectory(path.join(session.path, 'continuation-driver'), 'continuation driver directory', create);
  const locks = safeDirectory(path.join(driver.path, 'locks'), 'continuation driver locks directory', create);
  const assignment = safeDirectory(path.join(path.dirname(session.path), 'assignment'), 'workflow assignment directory', false);
  return { session, driver, locks, assignment };
}

function safeDirectory(target, label, create) {
  if (create) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a non-symlink directory`);
  const realpath = fs.realpathSync(target);
  return { path: path.resolve(target), realpath, dev: stat.dev, ino: stat.ino };
}

function assertParentsStable(parents) {
  for (const parent of [parents.session, parents.driver, parents.locks, parents.assignment]) {
    const current = safeDirectory(parent.path, 'continuation authority parent', false);
    if (!sameIdentity(parent, current) || current.realpath !== parent.realpath) throw new Error('continuation authority parent identity changed');
  }
}

function sameParents(left, right) {
  return ['session', 'driver', 'locks', 'assignment'].every((name) => sameIdentity(left[name], right[name]) && left[name].realpath === right[name].realpath);
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function readActiveAssignment(sessionDir, parents, actor, actorStruct) {
  assertParentsStable(parents);
  const artifactRoot = path.dirname(sessionDir);
  const assignmentFile = path.join(parents.assignment.path, `${path.basename(sessionDir)}.json`);
  const loaded = readRegularJson(assignmentFile, 'workflow assignment', parents, MAX_ASSIGNMENT_RECORD_BYTES);
  const assignment = loaded.value;
  if (!assignment || assignment.status !== 'claimed' || assignment.artifact_dir !== path.basename(sessionDir) || assignment.actor_key !== actor
    || !isDeepStrictEqual(normalizeActorStruct(assignment.actor), normalizeActorStruct(actorStruct))) {
    throw new Error('workflow assignment is not the active turn actor');
  }
  assertParentsStable(parents);
  return { sha256: sha256(loaded.bytes) };
}

function readRegularJson(file, label, parents, maxBytes) {
  if (parents) assertParentsStable(parents);
  const expected = fileIdentity(file, label);
  if (expected.size > maxBytes) throw new Error(`${label} exceeds maximum size`);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes || !sameIdentity(expected, opened)) throw new Error(`${label} identity changed while opening`);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!sameIdentity(expected, after)) throw new Error(`${label} identity changed while reading`);
    const final = fileIdentity(file, label);
    if (!sameIdentity(expected, final)) throw new Error(`${label} identity changed after reading`);
    const value = JSON.parse(bytes.toString('utf8'));
    if (parents) assertParentsStable(parents);
    return { value, bytes, identity: expected };
  } finally {
    fs.closeSync(fd);
  }
}

function fileIdentity(file, label) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a bounded non-symlink regular file`);
  return { dev: stat.dev, ino: stat.ino, size: stat.size };
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schema_version !== SCHEMA_VERSION) throw new Error('authority schema is unsupported');
  for (const field of ['run_id', 'definition_id', 'definition_version', 'definition_digest', 'issued_step', 'adapter_command_identity', 'assignment_actor', 'assignment_record_sha256', 'turn_secret_sha256', 'public_key_spki_b64', 'public_key_digest', 'signature_b64', 'issued_at', 'expires_at']) requiredString(record[field], field);
  requiredSafeRunId(record.run_id, 'run_id');
  requiredDigest(record.definition_digest, 'definition_digest');
  requiredActorStruct(record.assignment_actor_struct, 'assignment_actor_struct');
  if (!/^[0-9a-f]{64}$/i.test(record.assignment_record_sha256)
    || !/^[0-9a-f]{64}$/i.test(record.turn_secret_sha256)
    || !/^[0-9a-f]{64}$/i.test(record.public_key_digest)) throw new Error('authority digest is malformed');
  requiredInteger(record.iteration, 'iteration', 1, 100);
  requiredInteger(record.max_turns, 'max_turns', 1, 100);
  if (record.iteration > record.max_turns) throw new Error('authority iteration exceeds mission budget');
  assertPositiveInteger(record.timeout_ms, 'timeout_ms', 1, MAX_TIMEOUT_MS);
  const issued = Date.parse(requiredTimestamp(record.issued_at, 'issued_at'));
  const expires = Date.parse(requiredTimestamp(record.expires_at, 'expires_at'));
  if (expires !== issued + record.timeout_ms) throw new Error('authority expiry does not match timeout');
  if (!record.driver_lock || typeof record.driver_lock !== 'object' || Array.isArray(record.driver_lock)) throw new Error('authority lock is malformed');
  requiredInteger(record.driver_lock.pid, 'driver_lock.pid', 1, 2_147_483_647);
  requiredString(record.driver_lock.token, 'driver_lock.token');
  requiredTimestamp(record.driver_lock.created_at, 'driver_lock.created_at');
}

function validSignature(record) {
  const unsigned = { ...record };
  const signature = Buffer.from(unsigned.signature_b64, 'base64');
  delete unsigned.signature_b64;
  const publicKey = { key: Buffer.from(unsigned.public_key_spki_b64, 'base64'), format: 'der', type: 'spki' };
  return equalText(sha256(unsigned.public_key_spki_b64), unsigned.public_key_digest)
    && verify(null, canonicalBytes(unsigned), publicKey, signature);
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalize(value)), 'utf8');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function equalText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw new Error(`${label} must be a bounded non-empty string`);
  return value;
}

function requiredSafeRunId(value, label) {
  const text = requiredString(value, label);
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(text)) throw new Error(`${label} must be a safe Flow run id`);
  return text;
}

function requiredTurnSecret(value) {
  const text = requiredString(value, 'turnSecret');
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) throw new Error('turnSecret must be a 32-byte base64url secret');
  return text;
}

function requiredDigest(value, label) {
  const text = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return text;
}

function requiredActorStruct(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an actor object`);
  const keys = Object.keys(value);
  if (!keys.every((key) => key === 'runtime' || key === 'session_id' || key === 'host' || key === 'human')
    || !['runtime', 'session_id', 'host'].every((key) => Object.prototype.hasOwnProperty.call(value, key))) throw new Error(`${label} has unsupported fields`);
  for (const key of ['runtime', 'session_id', 'host']) requiredBoundedActorField(value[key], `${label}.${key}`);
  if (Object.prototype.hasOwnProperty.call(value, 'human') && value.human !== null) requiredBoundedActorField(value.human, `${label}.human`);
  return {
    runtime: value.runtime,
    session_id: value.session_id,
    host: value.host,
    ...(Object.prototype.hasOwnProperty.call(value, 'human') ? { human: value.human } : {}),
  };
}

function normalizeActorStruct(value) {
  try {
    const actor = requiredActorStruct(value, 'assignment actor');
    return { ...actor, human: actor.human ?? null };
  } catch {
    return null;
  }
}

function requiredBoundedActorField(value, label) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error(`${label} must be a bounded non-empty string`);
  return value;
}

function requiredInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} through ${max}`);
  return value;
}

function assertPositiveInteger(value, label, min, max) {
  requiredInteger(value, label, min, max);
}

function requiredTimestamp(value, label) {
  const text = requiredString(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp`);
  return text;
}

module.exports = {
  activeTurnFile,
  activeTurnBoundaryFile,
  issueActiveTurnAuthority,
  removeActiveTurnAuthority,
  recordActiveTurnBoundary,
  readActiveTurnBoundary,
  validateActiveTurnAuthority,
  validateSignedActiveTurnAssignmentAuthority,
};
