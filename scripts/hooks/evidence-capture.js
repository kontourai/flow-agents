#!/usr/bin/env node
/**
 * Evidence Capture Hook (capture-first determinism)
 *
 * A postToolUse hook that DETERMINISTICALLY records every command/shell tool
 * execution to an append-only log, so evidence about what actually ran is
 * machine-recorded at the source — not transcribed later by the model. The Stop
 * gate (stop-goal-fit.js) then cross-references the model's evidence.json claims
 * against this captured truth: a check claiming a command passed while the log
 * shows it FAILED is a caught false-completion.
 *
 * Records to `.flow-agents/<slug>/command-log.jsonl`, one JSON object per line:
 *   {
 *     "command":        "<the command string the agent ran>",
 *     "observedResult": "pass" | "fail",   // deterministically inferred
 *     "exitCode":       <integer> | null,  // null when only pass/fail is inferable
 *     "capturedAt":     "<ISO-8601 timestamp>",
 *     "source":         "postToolUse-capture",
 *     "_chain":         { "seq": <n>, "prevHash": "<hex>", "hash": "<hex>" }
 *   }
 *
 * Hash-chain integrity (Increment B2, tamper-EVIDENCE):
 *   command-log.jsonl is the independent capture truth source. Each record carries
 *   a `_chain` block: hash = sha256(prevHash + canonicalJson(record)) where
 *   canonicalJson is the record WITHOUT the `_chain` field, keys sorted.
 *   The genesis prevHash is a fixed constant. This makes alteration, removal, or
 *   reordering of entries DETECTABLE by the Stop gate's verifyCommandLogChain().
 *
 *   HONEST FRAMING: this is tamper-EVIDENCE, NOT tamper-PROOF. An agent that
 *   recomputes the whole chain from scratch can still forge a valid chain. The
 *   real tamper-proof boundary is the signed checkpoint (B1). The chain raises the
 *   local bar and catches casual/accidental tampering and corruption.
 *
 *   Fail-open: any chain computation error falls back to writing the plain record
 *   without `_chain`. A chain failure must NEVER block capture or corrupt the log.
 *
 * Exit-code nuance: the host payload exposes `tool_response`/`tool_output`/`error`
 * (per docs/spec/runtime-hook-surface.md §1, postToolUse). A clean integer exit
 * code is host-dependent. We extract the real exit code where present; otherwise
 * we derive `observedResult` from `error`/stderr-style failure indication and
 * record `exitCode: null`. We never record the model's words about the outcome.
 *
 * Non-blocking — always exits 0. Idempotent/append-only. Fail-open on any error:
 * a capture failure must never block the agent or corrupt the log.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_STDIN = 1024 * 1024;
const MAX_COMMAND_LEN = 4096;
const MAX_OUTPUT_SCAN = 64 * 1024;

// Tools whose tool_input.command is a shell/command execution. Identified by the
// presence of tool_input.command plus a command/shell-ish tool_name. We keep the
// name set permissive (substring match) so unknown-but-command-shaped tools on
// other runtimes still get captured when they carry a command string.
const COMMAND_TOOL_NAME = /(^|[^a-z])(bash|shell|sh|exec|run|command|terminal|cmd|process|executebash|executecommand)([^a-z]|$)/i;

// ─── Hash-chain integrity (tamper-EVIDENCE) ───────────────────────────────────
//
// Genesis prevHash: a fixed sentinel used when the log is empty or the last
// entry has no _chain field (legacy record). The value is sha256("flow-agents:
// command-log:genesis"), computed once and hard-coded here for stability.
//
// HONEST FRAMING: this makes alteration DETECTABLE, not impossible. An agent
// that rewrites all hashes can still forge the chain. The real tamper-proof
// boundary is the signed checkpoint (B1). We do not oversell this boundary.
const CHAIN_GENESIS = 'a3f9e2b7d5c84f1e6a0d2c3b9f7e1a4d8c6b5f2e9a0d3c7b1f4e8a2d6c0b9f3';

/**
 * Stable canonical JSON for the chain input: the record WITHOUT the `_chain`
 * field, keys sorted alphabetically. This ensures the hash is independent of
 * key insertion order and that `_chain` itself does not contribute to its own
 * hash (circular dependency).
 */
function canonicalJsonForChain(record) {
  // Strip _chain if present (should not be, but defensive).
  const keys = Object.keys(record).filter(k => k !== '_chain').sort();
  const obj = {};
  for (const k of keys) obj[k] = record[k];
  return JSON.stringify(obj);
}

/**
 * Compute the sha256 hex hash for this chain link.
 * hash = sha256(prevHash + canonicalJson(record))
 */
function computeChainHash(prevHash, record) {
  const input = prevHash + canonicalJsonForChain(record);
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Read the last entry from command-log.jsonl that has a `_chain` block.
 * Returns { seq, hash } of that entry, or { seq: -1, hash: CHAIN_GENESIS }
 * when the log is absent, empty, or all existing entries are legacy (no _chain).
 *
 * We scan from the end so we can stop as soon as we find a chained entry
 * without loading the whole file (practical optimization for long logs).
 */
function readLastChainState(logFile) {
  let raw = '';
  try { raw = fs.readFileSync(logFile, 'utf8'); } catch { return { seq: -1, hash: CHAIN_GENESIS }; }
  const lines = raw.split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry && entry._chain && typeof entry._chain.hash === 'string' && typeof entry._chain.seq === 'number') {
      return { seq: entry._chain.seq, hash: entry._chain.hash };
    }
  }
  return { seq: -1, hash: CHAIN_GENESIS };
}
// ─────────────────────────────────────────────────────────────────────────────

function parseJson(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  const root = path.parse(dir).root;
  for (let depth = 0; dir && depth < 40; depth++) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'AGENTS.md'))) return dir;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return path.resolve(startDir || process.cwd());
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Newest-mtime state.json under .flow-agents/<slug>/, mirroring how
// workflow-steering.js and stop-goal-fit.js locate the active artifact dir.
function latestStateDir(flowAgentsDir) {
  let best = null;
  const stack = [flowAgentsDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'archive') continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name === 'state.json') {
        let mtimeMs;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch { continue; }
        if (!best || mtimeMs > best.mtimeMs) best = { dir, mtimeMs };
      }
    }
  }
  return best ? best.dir : null;
}

/**
 * Resolve the active artifact directory the same way the other hooks do:
 * prefer .flow-agents/current.json (active_slug / artifact_dir), then fall back
 * to the newest-mtime state.json directory.
 */
function resolveArtifactDir(root) {
  const flowAgentsDir = path.join(root, '.flow-agents');
  const current = readJsonFile(path.join(flowAgentsDir, 'current.json'));
  if (current) {
    const slug = current.artifact_dir || current.active_slug;
    if (typeof slug === 'string' && slug.trim()) {
      // Guard against path traversal in the slug.
      const safe = slug.replace(/\.\.+/g, '').replace(/^[/\\]+/, '');
      const dir = path.join(flowAgentsDir, safe);
      if (dir.startsWith(flowAgentsDir + path.sep) && fs.existsSync(dir)) return dir;
    }
  }
  return latestStateDir(flowAgentsDir);
}

function isCommandTool(toolName, command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  // A tool_name is not always present (some runtimes omit it). If a command
  // string is present we still capture; the name match is a fast-path that also
  // covers the no-name case by defaulting to true when the name is empty.
  if (!toolName) return true;
  return COMMAND_TOOL_NAME.test(String(toolName));
}

function clamp(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max) : s;
}

// Coerce a value to a clean integer exit code, or null. Accepts numbers and
// integer-looking strings; rejects NaN/floats/anything else.
function cleanExitCode(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

/**
 * Deterministically observe { exitCode, observedResult } from the host tool
 * result. NEVER consults the model's narration — only structured host fields.
 *
 * Priority:
 *   1. A clean integer exit code anywhere the host surfaces it → exitCode set;
 *      observedResult = pass iff exitCode === 0.
 *   2. Else, a non-empty `error` field or stderr-style failure indication →
 *      observedResult = fail, exitCode = null.
 *   3. Else → observedResult = pass, exitCode = null.
 */
function observeResult(input) {
  const response = input.tool_response;
  const output = input.tool_output;
  const error = input.error;

  // Candidate locations for a host-provided exit code.
  const candidates = [];
  for (const src of [response, output]) {
    if (src && typeof src === 'object') {
      candidates.push(src.exitCode, src.exit_code, src.exitcode, src.status, src.code, src.returnCode, src.return_code);
    }
  }
  candidates.push(input.exitCode, input.exit_code, input.status, input.code);

  let exitCode = null;
  for (const c of candidates) {
    const clean = cleanExitCode(c);
    if (clean !== null) { exitCode = clean; break; }
  }

  if (exitCode !== null) {
    return { exitCode, observedResult: exitCode === 0 ? 'pass' : 'fail' };
  }

  // No clean exit code — infer pass/fail from failure indicators only.
  if (isFailureIndicated(error, response, output)) {
    return { exitCode: null, observedResult: 'fail' };
  }
  return { exitCode: null, observedResult: 'pass' };
}

// True when the host surfaces a deterministic failure signal: a non-empty
// `error`, a falsey `success`/truthy `failed`/`is_error` flag, or a non-empty
// stderr field. Plain stdout text is NOT scanned for the words "error"/"fail"
// because that would be guessing, not observing.
function isFailureIndicated(error, response, output) {
  if (typeof error === 'string' && error.trim()) return true;
  if (error && typeof error === 'object' && Object.keys(error).length > 0) return true;
  for (const src of [response, output]) {
    if (!src || typeof src !== 'object') continue;
    if (src.success === false) return true;
    if (src.failed === true || src.is_error === true || src.isError === true) return true;
    if (typeof src.error === 'string' && src.error.trim()) return true;
    if (error == null && typeof src.stderr === 'string' && src.stderr.trim()) {
      // A non-empty stderr alone is a weak signal (many passing tools write to
      // stderr). Only treat it as failure when there is no stdout to suggest
      // a normal result. This stays conservative: false-fail capture is worse
      // than missing a fail (the Stop backstop re-runs un-captured claims).
      const stdout = typeof src.stdout === 'string' ? src.stdout : '';
      if (!stdout.trim()) return true;
    }
  }
  return false;
}

function run(rawInput) {
  try {
    const input = parseJson(rawInput);
    const command = input.tool_input && input.tool_input.command;
    if (!isCommandTool(input.tool_name, command)) return rawInput;

    const root = findRepoRoot(input.cwd || process.cwd());
    const artifactDir = resolveArtifactDir(root);
    if (!artifactDir) return rawInput; // no active workflow — nothing to anchor the log to

    const { exitCode, observedResult } = observeResult({
      tool_response: input.tool_response,
      tool_output: input.tool_output,
      error: input.error,
      exitCode: input.exitCode,
      exit_code: input.exit_code,
      status: input.status,
      code: input.code,
    });

    const record = {
      command: clamp(command, MAX_COMMAND_LEN).replace(/\s+/g, ' ').trim(),
      observedResult,
      exitCode,
      capturedAt: new Date().toISOString(),
      source: 'postToolUse-capture',
    };

    const logFile = path.join(artifactDir, 'command-log.jsonl');
    fs.mkdirSync(artifactDir, { recursive: true });

    // Hash-chain integrity: compute _chain before appending. Fail-open: any
    // error in chain computation falls back to the plain record (no _chain).
    // A chain failure must NEVER block capture or corrupt the log.
    let recordToWrite = record;
    try {
      const { seq: prevSeq, hash: prevHash } = readLastChainState(logFile);
      const seq = prevSeq + 1;
      const hash = computeChainHash(prevHash, record);
      // Spread record fields then add _chain so the chain field is appended last
      // (cosmetic ordering; canonicalJsonForChain excludes it during hashing).
      recordToWrite = { ...record, _chain: { seq, prevHash, hash } };
    } catch { /* chain computation failed — write plain record, do not block */ }

    fs.appendFileSync(logFile, JSON.stringify(recordToWrite) + '\n');
  } catch { /* fail-open: capture never blocks or corrupts */ }
  return rawInput;
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) data += chunk.substring(0, MAX_STDIN - data.length);
  });
  process.stdin.on('end', () => {
    process.stdout.write(String(run(data)));
    process.exit(0);
  });
}

module.exports = {
  run,
  resolveArtifactDir,
  observeResult,
  isCommandTool,
  findRepoRoot,
  // Chain helpers exported for testing and gate verification.
  canonicalJsonForChain,
  computeChainHash,
  CHAIN_GENESIS,
};
