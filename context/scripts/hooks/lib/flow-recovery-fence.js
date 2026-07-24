'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FLOW_RUN_RECOVERY_FENCE_FILE = 'recovery-fence.json';
const FLOW_RUN_RECOVERY_FENCE_PROTOCOL = 'flow.run-recovery-fence.v1';

function exactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function ancestryIdentity(projectRoot, runRoot) {
  let missing = false;
  for (const fixed of [
    path.join(projectRoot, '.kontourai'),
    path.join(projectRoot, '.kontourai', 'flow'),
    path.join(projectRoot, '.kontourai', 'flow', 'runs'),
    runRoot,
  ]) {
    try {
      const stat = fs.lstatSync(fixed);
      if (missing || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Flow recovery fence ancestry is unsafe');
    } catch (error) {
      if (error && error.code === 'ENOENT') { missing = true; continue; }
      throw error;
    }
  }
  try {
    const stat = fs.lstatSync(runRoot);
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (error && error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

function inspectFlowRecoveryFence(projectRoot, runId) {
  if (!runId || runId.includes('/') || runId.includes('\\')) throw new Error('Flow recovery fence run id is invalid');
  const resolvedRoot = path.resolve(projectRoot);
  const runRoot = path.join(resolvedRoot, '.kontourai', 'flow', 'runs', runId);
  const directory = ancestryIdentity(resolvedRoot, runRoot);
  const file = path.join(runRoot, FLOW_RUN_RECOVERY_FENCE_FILE);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      if (ancestryIdentity(resolvedRoot, runRoot) !== directory) throw new Error('Flow run directory changed during recovery fence read');
      return { fingerprint: 'absent', generation: 'absent', directory };
    }
    throw new Error('Flow recovery fence could not be opened safely');
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 || stat.size === 0 || stat.size > 64 * 1024) throw new Error('Flow recovery fence is malformed');
    const bytes = fs.readFileSync(descriptor);
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('Flow recovery fence is malformed');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !exactKeys(parsed, ['protocol', 'run_id', 'recovery_id', 'status', 'updated_at', 'generation'])
        || parsed.protocol !== FLOW_RUN_RECOVERY_FENCE_PROTOCOL
        || parsed.run_id !== runId
        || !/^[a-f0-9]{64}$/.test(String(parsed.recovery_id))
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(parsed.generation))
        || !['active', 'open'].includes(String(parsed.status))
        || typeof parsed.updated_at !== 'string'
        || !Number.isFinite(Date.parse(parsed.updated_at))) {
      throw new Error('Flow recovery fence is malformed or unsupported');
    }
    if (parsed.status === 'active') throw new Error(`Flow run ${runId} is fenced for recovery ${String(parsed.recovery_id)}`);
    if (ancestryIdentity(resolvedRoot, runRoot) !== directory) throw new Error('Flow run directory changed during recovery fence read');
    return { fingerprint: crypto.createHash('sha256').update(bytes).digest('hex'), generation: parsed.generation, directory };
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertFlowRecoveryFenceOpen(projectRoot, runId) {
  inspectFlowRecoveryFence(projectRoot, runId);
}

function withFlowRecoveryFenceRead(projectRoot, runId, operation) {
  const before = inspectFlowRecoveryFence(projectRoot, runId);
  let result;
  let operationError;
  let operationFailed = false;
  try {
    result = operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const after = inspectFlowRecoveryFence(projectRoot, runId);
  if (before.fingerprint !== after.fingerprint || before.generation !== after.generation || before.directory !== after.directory) {
    throw new Error(`Flow run ${runId} recovery fence changed during read`);
  }
  if (operationFailed) throw operationError;
  return result;
}

async function withFlowRecoveryFenceReadAsync(projectRoot, runId, operation) {
  const before = inspectFlowRecoveryFence(projectRoot, runId);
  let result;
  let operationError;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const after = inspectFlowRecoveryFence(projectRoot, runId);
  if (before.fingerprint !== after.fingerprint || before.generation !== after.generation || before.directory !== after.directory) {
    throw new Error(`Flow run ${runId} recovery fence changed during read`);
  }
  if (operationFailed) throw operationError;
  return result;
}

module.exports = {
  FLOW_RUN_RECOVERY_FENCE_FILE,
  FLOW_RUN_RECOVERY_FENCE_PROTOCOL,
  assertFlowRecoveryFenceOpen,
  withFlowRecoveryFenceRead,
  withFlowRecoveryFenceReadAsync,
};
