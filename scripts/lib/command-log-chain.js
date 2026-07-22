'use strict';
//
// Single normative source for the command-log hash-chain primitives and the
// exit-code-laundering heuristic.
//
// These were previously copy-pasted across the writer (hooks/evidence-capture.js),
// the verifier (hooks/stop-goal-fit.js), the repair tool (repair-command-log.js),
// and CI reconcile (ci/trust-reconcile.js) under "keep byte-identical" comments —
// the most security-sensitive path in the bundle, since the chain's integrity
// claim rests on writer and verifier canonicalizing identically. The copies had
// ALREADY drifted (ci/trust-reconcile's hasLaunderingOperator was missing the
// trailing `/bin/true` check), which is exactly the failure mode duplication
// invites. Importing from one module makes that divergence structurally impossible.
//
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The genesis prevHash is a FIXED ARBITRARY SENTINEL — NOT the SHA256 of any
// specific input string. (An earlier comment incorrectly claimed it was
// sha256("flow-agents:command-log:genesis"); that is wrong.) Writer and verifier
// MUST share this exact value — existing chained logs depend on it.
//
// HONEST FRAMING: this makes alteration DETECTABLE, not impossible. An agent that
// rewrites all hashes can still forge the chain. The real tamper-proof boundary is
// the signed checkpoint (B1). We do not oversell this boundary.
const CHAIN_GENESIS = 'a3f9e2b7d5c84f1e6a0d2c3b9f7e1a4d8c6b5f2e9a0d3c7b1f4e8a2d6c0b9f3';

/**
 * Stable canonical JSON for a chain link: the record WITHOUT its `_chain` field,
 * keys sorted alphabetically. This makes the hash independent of key insertion
 * order and keeps `_chain` from contributing to its own hash.
 */
function canonicalJsonForChain(record) {
  const keys = Object.keys(record).filter((k) => k !== '_chain').sort();
  const obj = {};
  for (const k of keys) obj[k] = record[k];
  return JSON.stringify(obj);
}

/** Chain link hash: sha256(prevHash + canonicalJsonForChain(record)), hex. */
function computeChainHash(prevHash, record) {
  return crypto
    .createHash('sha256')
    .update(prevHash + canonicalJsonForChain(record), 'utf8')
    .digest('hex');
}

const BENIGN_FORK_SOURCES = new Set(['postToolUse-capture', 'canonical-writer-execution']);

/** Parse every non-blank physical line, retaining invalid JSON and non-record JSON as gaps. */
function parseCommandLog(raw) {
  return String(raw || '').split('\n').filter((line) => line.trim()).map((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { kind: 'record', value }
        : { kind: 'gap' };
    } catch {
      return { kind: 'gap' };
    }
  });
}

/** Normative raw verifier and append authority for every command-log writer/reader. */
function verifyCommandLogRaw(raw) {
  const parsed = parseCommandLog(raw);
  const hasAnyChain = parsed.some((item) => item.kind === 'record'
    && item.value._chain && typeof item.value._chain.hash === 'string');
  if (!hasAnyChain) return { status: 'legacy', brokenAt: null, forkAt: null, append: { seq: -1, hash: CHAIN_GENESIS } };

  const reachable = new Set([CHAIN_GENESIS]);
  const parentSources = new Map();
  let previousWasChained = false;
  let forked = false;
  let firstForkAt = null;
  let tip = null;
  for (let index = 0; index < parsed.length; index++) {
    const item = parsed[index];
    const entry = item.kind === 'record' ? item.value : null;
    const link = entry && entry._chain;
    if (!link || typeof link.hash !== 'string') {
      if (previousWasChained) return { status: 'broken', brokenAt: index, forkAt: null, append: null };
      continue;
    }
    if (typeof link.prevHash !== 'string' || !Number.isSafeInteger(link.seq) || link.seq < 0
      || link.hash !== computeChainHash(link.prevHash, entry) || !reachable.has(link.prevHash)) {
      return { status: 'broken', brokenAt: index, forkAt: null, append: null };
    }
    const sources = parentSources.get(link.prevHash) || [];
    sources.push(entry.source);
    parentSources.set(link.prevHash, sources);
    if (sources.length > 1) {
      if (!sources.every((source) => BENIGN_FORK_SOURCES.has(source))) {
        return { status: 'broken', brokenAt: index, forkAt: null, append: null };
      }
      if (firstForkAt === null) firstForkAt = index;
      forked = true;
    }
    reachable.add(link.hash);
    previousWasChained = true;
    tip = { seq: link.seq, hash: link.hash };
  }
  return { status: forked ? 'forked' : 'ok', brokenAt: null, forkAt: firstForkAt, append: tip };
}

function readDescriptorFully(fd) {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size > Number.MAX_SAFE_INTEGER) throw new Error('command-log descriptor is not a readable regular file');
  const buffer = Buffer.alloc(Number(stat.size));
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (count === 0) throw new Error('command-log descriptor returned a short read');
    offset += count;
  }
  return buffer.toString('utf8');
}

function writeDescriptorFully(fd, buffer, position, write = fs.writeSync) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = write(fd, buffer, offset, buffer.length - offset, position === null ? null : position + offset);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('command-log descriptor returned a zero or invalid write');
    offset += count;
  }
}

function lockGenerationFiles(lockBase) {
  const directory = path.dirname(lockBase);
  const prefix = `${path.basename(lockBase)}.`;
  let names;
  try { names = fs.readdirSync(directory); } catch { return []; }
  return names.map((name) => {
    if (!name.startsWith(prefix)) return null;
    const suffix = name.slice(prefix.length);
    if (!/^(0|[1-9][0-9]*)$/.test(suffix)) return null;
    const generation = Number(suffix);
    return Number.isSafeInteger(generation) ? { generation, file: path.join(directory, name) } : null;
  }).filter(Boolean).sort((left, right) => left.generation - right.generation);
}

function readGeneration(file, generation) {
  let prior;
  try { prior = fs.lstatSync(file); } catch { return null; }
  if (prior.isSymbolicLink() || !prior.isFile()) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== prior.dev || opened.ino !== prior.ino) return null;
    const record = JSON.parse(readDescriptorFully(fd));
    const current = fs.lstatSync(file);
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
      || record.generation !== generation || typeof record.nonce !== 'string'
      || !['active', 'released'].includes(record.state)) return null;
    return { record, identity: { dev: opened.dev, ino: opened.ino } };
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

/**
 * Acquire an immutable generation name. No generation is stolen or removed.
 * `wait` is suitable for fail-open ordinary capture; fail-closed abort uses false.
 */
function acquireGenerationLock(lockBase, options = {}) {
  const attempts = options.wait ? (options.attempts || 200) : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // A pre-generation writer may still own the legacy pathname. Never steal
    // or delete it; bounded ordinary writers may wait for that owner to unlink.
    try {
      fs.lstatSync(lockBase);
      if (options.wait) {
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.retryMs || 5); } catch {}
        continue;
      }
      return null;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return null;
    }
    const generations = lockGenerationFiles(lockBase);
    const highest = generations.at(-1);
    if (highest) {
      const prior = readGeneration(highest.file, highest.generation);
      if (!prior || prior.record.state !== 'released') {
        // A concurrently-created generation is briefly empty before its active
        // record is fsynced. Ordinary writers may wait through that window;
        // fail-closed callers never treat malformed/active state as authority.
        if (options.wait && (!prior || prior.record.state === 'active')) {
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.retryMs || 5); } catch {}
          continue;
        }
        return null;
      }
    }
    const generation = highest ? highest.generation + 1 : 0;
    const file = `${lockBase}.${generation}`;
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      const nonce = crypto.randomBytes(16).toString('hex');
      const active = Buffer.from(`${JSON.stringify({ generation, nonce, state: 'active' })}\n`);
      writeDescriptorFully(fd, active, 0);
      fs.ftruncateSync(fd, active.length);
      fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd);
      const current = fs.lstatSync(file);
      if (!stat.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino
        || readDescriptorFully(fd) !== active.toString('utf8')) throw new Error('generation lock identity or durability check failed');
      const directoryFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      return { fd, file, generation, nonce, identity: { dev: stat.dev, ino: stat.ino } };
    } catch (error) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      if (error && error.code === 'EEXIST' && options.wait) continue;
      return null;
    }
  }
  return null;
}

function releaseGenerationLock(lock) {
  try {
    const before = fs.lstatSync(lock.file);
    const opened = fs.fstatSync(lock.fd);
    if (before.isSymbolicLink() || !before.isFile() || before.dev !== opened.dev || before.ino !== opened.ino
      || opened.dev !== lock.identity.dev || opened.ino !== lock.identity.ino) return false;
    const released = Buffer.from(`${JSON.stringify({ generation: lock.generation, nonce: lock.nonce, state: 'released' })}\n`);
    writeDescriptorFully(lock.fd, released, 0);
    fs.ftruncateSync(lock.fd, released.length);
    fs.fsyncSync(lock.fd);
    if (readDescriptorFully(lock.fd) !== released.toString('utf8')) return false;
    const after = fs.lstatSync(lock.file);
    return !after.isSymbolicLink() && after.isFile() && after.dev === opened.dev && after.ino === opened.ino;
  } catch { return false; }
  finally { try { fs.closeSync(lock.fd); } catch {} }
}

/**
 * True when a claimed verification command contains an exit-code-laundering
 * operator. Legitimate verification commands never need these — their only
 * purpose is to suppress a real non-zero exit:
 *   - ANY `||`             (e.g. `npm test || exit 0`, `|| echo ok`, `|| /bin/true`)
 *   - `| true`             (pipe into true — the pipeline absorbs the exit code)
 *   - trailing `; true` / `; :` / `; exit 0` / `; /bin/true` (and `\n` variants)
 *
 * FROZEN bar-raiser (ADR 0018). Do NOT add new evasion-pattern rules here; route new
 * laundering shapes to the external CI anchor (trust-reconcile + the anti-gaming suite).
 * Accepted limitation: the blanket `||` rule over-blocks legitimate control-flow `||`
 * (e.g. `test -d node_modules || npm ci`) — it fails toward blocking by design.
 */
function hasLaunderingOperator(cmd) {
  // ANY || in a claimed verification command is an exit-code mask.
  if (/\|\|/.test(cmd)) return true;
  // | true — single-pipe into true always exits 0 regardless of the left side.
  if (/\|\s*true\b/.test(cmd)) return true;
  // Trailing ; or \n followed by an exit-neutralizing command:
  if (/[;\n]\s*true\b/.test(cmd)) return true;
  if (/[;\n]\s*:\s*(?:$|\s|;)/.test(cmd)) return true;
  if (/[;\n]\s*exit\s+0\b/.test(cmd)) return true;
  if (/[;\n]\s*\/bin\/true\b/.test(cmd)) return true;
  return false;
}

module.exports = {
  CHAIN_GENESIS,
  BENIGN_FORK_SOURCES,
  canonicalJsonForChain,
  computeChainHash,
  parseCommandLog,
  verifyCommandLogRaw,
  readDescriptorFully,
  writeDescriptorFully,
  acquireGenerationLock,
  releaseGenerationLock,
  hasLaunderingOperator,
};
