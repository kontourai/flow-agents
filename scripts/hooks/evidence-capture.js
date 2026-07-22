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
 * Records to `.kontourai/flow-agents/<slug>/command-log.jsonl`, one JSON object per line:
 *   {
 *     "command":        "<the command string the agent ran>",
 *     "observedResult": "pass" | "fail" | "ambiguous", // deterministically inferred
 *                                       // ("ambiguous": a bare, non-self-asserting
 *                                       // grep/diff exited 1 — could mean zero
 *                                       // matches/no differences (PASS for an
 *                                       // absence check) or an unintended miss
 *                                       // (FAIL for a presence check); #362)
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
 * record `exitCode: null`. Absent positive success evidence (a clean integer
 * exit code of 0; no host currently surfaces a positive success flag), the
 * result is 'ambiguous', never 'pass'. We never record the model's words about
 * the outcome.
 *
 * Non-blocking — always exits 0. Idempotent/append-only. Fail-open on any error:
 * a capture failure must never block the agent or corrupt the log.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { flowAgentsArtifactRootsForRead } = require('./lib/local-artifact-paths');
const { resolveActor, isUnresolvedActor } = require('./lib/actor-identity.js');
const { readOwnCurrentPointer } = require('./lib/current-pointer.js');
const { isAmbiguousAbsenceCommand } = require('./lib/runnable-command.js');
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
// CHAIN_GENESIS is a fixed arbitrary sentinel — NOT the SHA256 of any specific
// input string (a previous comment incorrectly claimed sha256("…:genesis")). The
// writer here and the verifier in stop-goal-fit.js MUST canonicalize and seed
// identically, so the genesis constant and the canonicalJson/hash helpers live in
// ONE shared module that both import — divergence is structurally impossible.
const {
  CHAIN_GENESIS,
  canonicalJsonForChain,
  computeChainHash,
  verifyCommandLogRaw,
  acquireGenerationLock,
  releaseGenerationLock,
} = require('../lib/command-log-chain.js');

// ─── Concurrency-safe append (lockfile) ──────────────────────────────────────
//
// The chain link is a read-(last hash)→compute→append critical section. Without
// mutual exclusion, two capture processes writing to the SAME command-log
// concurrently (e.g. parallel agents in one workspace) can both read the same
// prevHash and append entries with an identical seq/prevHash — forking the chain
// and tripping the tamper-evidence verifier on a benign race. We serialize the
// section with append-only, create-exclusive lock generations.
//
// FAIL-OPEN, like the rest of this hook: if the lock cannot be acquired the hook
// returns without blocking the agent. Active, stale, malformed, or replaced
// generations are never stolen or deleted.
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

// Newest-mtime state.json under .kontourai/flow-agents/<slug>/, mirroring how
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
 * Resolve the active artifact directory the same way the other #440-migrated hooks do: prefer
 * the RESOLVED actor's own per-actor `current/<actor>.json` pointer (active_slug / artifact_dir)
 * via `readOwnCurrentPointer` — never the shared legacy `current.json`, and never the repo-wide
 * newest-mtime scan (D1: that would append this actor's OWN captured evidence into an unrelated
 * actor's session directory). Only for an empty/unresolved actor does this fall back to the
 * legacy global `current.json` and, failing that, the newest-mtime `state.json` directory scan —
 * the pre-#440/#291 behavior, unchanged for that case (D3 compat). See the D1/D2/D3 comment
 * inline below for the exact branching.
 */
function resolveArtifactDir(root) {
  const actorKey = resolveActor(process.env).actor;
  for (const flowAgentsDir of flowAgentsArtifactRootsForRead(root)) {
    const { payload: current } = readOwnCurrentPointer(flowAgentsDir, actorKey);
    if (current) {
      const slug = current.artifact_dir || current.active_slug;
      if (typeof slug === 'string' && slug.trim()) {
        // Guard against path traversal in the slug.
        const safe = slug.replace(/\.\.+/g, '').replace(/^[/\\]+/, '');
        const dir = path.join(flowAgentsDir, safe);
        if (dir.startsWith(flowAgentsDir + path.sep) && fs.existsSync(dir)) return dir;
      }
    }
  }
  // #440 D1: a resolved actor with no own per-actor pointer never falls back to the repo-wide
  // newest-mtime scan below — that would append this actor's OWN captured evidence into an
  // unrelated actor's session directory (write-side ownership conflation). D2 accepted gap:
  // captured evidence is simply dropped (existing `if (!artifactDir) return rawInput;` no-op in
  // run()) until this actor's next sidecar command establishes its own per-actor pointer. D3: an
  // unresolved actor keeps today's exact global-scan fallback, unchanged.
  if (!isUnresolvedActor(actorKey)) return null;
  for (const flowAgentsDir of flowAgentsArtifactRootsForRead(root)) {
    const latest = latestStateDir(flowAgentsDir);
    if (latest) return latest;
  }
  return null;
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
 *      observedResult = pass iff exitCode === 0, EXCEPT (#362) a bare,
 *      non-self-asserting `grep`/`diff` invocation (per
 *      `isAmbiguousAbsenceCommand`, ./lib/runnable-command.js) that exits
 *      EXACTLY 1 → observedResult = 'ambiguous' instead of 'fail'. Exit 1 for
 *      such a command could mean zero matches/no differences (PASS for an
 *      absence check) or an unintended miss (FAIL for a presence check) —
 *      this is never coerced to 'pass' (that would trade a false-block for a
 *      false-pass) nor silently left as 'fail' (that is the exact false
 *      caught-completion #362 reports). Exit codes >= 2 for these two
 *      binaries are real tool errors and remain 'fail', unchanged.
 *   2. Else, a non-empty `error` field or stderr-style failure indication →
 *      observedResult = fail, exitCode = null.
 *   3. Else → observedResult = ambiguous, exitCode = null. Absent positive
 *      success evidence (a clean integer exit code of 0; no host currently
 *      surfaces a positive success flag), the result is 'ambiguous', never
 *      'pass'.
 *
 * `input.command` (the raw command string, already in scope at the run()
 * call site) is required to evaluate the #362 carve-out; when absent, the
 * carve-out simply never fires and behavior is byte-identical to before #362.
 */
function observeResult(input) {
  const response = input.tool_response;
  const output = input.tool_output;
  const error = input.error;
  const command = typeof input.command === 'string' ? input.command : '';

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
    if (exitCode === 1 && command && isAmbiguousAbsenceCommand(command)) {
      return { exitCode, observedResult: 'ambiguous' };
    }
    return { exitCode, observedResult: exitCode === 0 ? 'pass' : 'fail' };
  }

  // No clean exit code — infer pass/fail from failure indicators only.
  if (isFailureIndicated(error, response, output)) {
    return { exitCode: null, observedResult: 'fail' };
  }
  return { exitCode: null, observedResult: 'ambiguous' };
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
      // #362: thread the raw command string through so observeResult can apply the
      // bare-grep/diff-exit-1 ambiguous carve-out. `command` is already in scope here
      // (extracted above from input.tool_input.command).
      command,
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

    // Serialize the read→compute→append critical section so concurrent captures
    // (parallel agents sharing this log) cannot fork the hash-chain. Fail-open:
    // a null capability means we could not establish safe append authority.
    // The hook fails open without modifying the log.
    const lockFile = logFile + '.lock';
    const lock = acquireGenerationLock(lockFile, { wait: true, attempts: 2000, retryMs: 5 });
    if (lock === null) return rawInput;
    try {
      // Hash-chain integrity: compute _chain before appending. Fail-open: any
      // error in chain computation falls back to the plain record (no _chain).
      // A chain failure must NEVER block capture or corrupt the log.
      let recordToWrite = record;
      try {
        let raw = '';
        try { raw = fs.readFileSync(logFile, 'utf8'); } catch {}
        const authority = verifyCommandLogRaw(raw).append;
        if (!authority) throw new Error('command-log has no safe append authority');
        const { seq: prevSeq, hash: prevHash } = authority;
        const seq = prevSeq + 1;
        const hash = computeChainHash(prevHash, record);
        // Spread record fields then add _chain so the chain field is appended last
        // (cosmetic ordering; canonicalJsonForChain excludes it during hashing).
        recordToWrite = { ...record, _chain: { seq, prevHash, hash } };
      } catch { /* chain computation failed — write plain record, do not block */ }

      fs.appendFileSync(logFile, JSON.stringify(recordToWrite) + '\n');
    } finally {
      releaseGenerationLock(lock);
    }
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
