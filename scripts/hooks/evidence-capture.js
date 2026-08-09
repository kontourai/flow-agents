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
 *     "observed_at_commit": "<immutable Git commit SHA at observation time>",
 *     "worktree_clean": true | false,
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
 *   Fail-open: a chain or append-authority failure leaves the log unchanged; this
 *   hook never writes an unchained fallback record. A capture failure must NEVER
 *   block the agent or corrupt the log.
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
const { spawnSync } = require('child_process');
const { flowAgentsArtifactRootsForRead } = require('./lib/local-artifact-paths');
const { resolveActor, isUnresolvedActor } = require('./lib/actor-identity.js');
const { readOwnCurrentPointer } = require('./lib/current-pointer.js');
const { isAmbiguousAbsenceCommand } = require('./lib/runnable-command.js');
const crypto = require('crypto');

const MAX_STDIN = 1024 * 1024;
const MAX_COMMAND_LEN = 4096;
const MAX_OUTPUT_SCAN = 64 * 1024;
// Each fixed Git command receives the same finite cap as its canonical
// snapshot counterpart. A single 64 KiB cap rejects ordinary repositories
// whose tracked-index listing exceeds that size.
const MAX_GIT_HEAD_OUTPUT = 256;
const MAX_GIT_TRACKED_DIFF_OUTPUT = 16 * 1024 * 1024;
const MAX_GIT_TRACKED_INDEX_OUTPUT = 4 * 1024 * 1024;
const MAX_GIT_UNTRACKED_LIST_OUTPUT = 4 * 1024 * 1024;
const MAX_GIT_UNTRACKED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_GIT_UNTRACKED_TOTAL_BYTES = 64 * 1024 * 1024;
const GIT_HASH_READ_CHUNK_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 3000;
const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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

function resolveCanonicalGitRoot(startDir) {
  try {
    const start = fs.realpathSync(path.resolve(startDir || process.cwd()));
    const output = runTrustedGit(start, ['rev-parse', '--show-toplevel'], MAX_GIT_HEAD_OUTPUT);
    const reported = output ? output.toString('utf8').trim() : '';
    if (!reported || !path.isAbsolute(reported)) return null;
    const root = fs.realpathSync(reported);
    const confirmed = runTrustedGit(root, ['rev-parse', '--show-toplevel'], MAX_GIT_HEAD_OUTPUT);
    if (!confirmed || fs.realpathSync(confirmed.toString('utf8').trim()) !== root) return null;
    return root;
  } catch {
    return null;
  }
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

// Hook-side Git calls use a fixed executable, a bounded argv, and no ambient
// system/global configuration. This mirrors the existing trusted hook pattern:
// the command capture must not load repository-configured hooks or fsmonitor
// helpers merely to observe the worktree that produced a host result.
function trustedGitEnvironment() {
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Windows' : '/run/current-system/sw/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  };
}

function trustedGitCandidates() {
  if (process.platform === 'darwin') return ['/usr/bin/git', '/run/current-system/sw/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];
  if (process.platform === 'win32') return ['C:\\Program Files\\Git\\cmd\\git.exe'];
  return ['/usr/bin/git', '/run/current-system/sw/bin/git', '/usr/local/bin/git'];
}

function trustedGitIdentity(candidate) {
  const resolved = fs.realpathSync(candidate);
  const stat = fs.statSync(resolved);
  if (!path.isAbsolute(resolved) || !stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o111) === 0)) throw new Error('untrusted Git executable');
  if (process.platform !== 'win32') {
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error('untrusted Git executable ownership');
    for (let cursor = path.dirname(resolved);;) {
      const parent = fs.statSync(cursor);
      if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) throw new Error('untrusted Git executable parent');
      const next = path.dirname(cursor);
      if (next === cursor) break;
      cursor = next;
    }
  }
  return { candidate, path: resolved, device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode };
}

function resolveTrustedGitExecutable() {
  for (const candidate of trustedGitCandidates()) {
    try { return trustedGitIdentity(candidate); } catch {}
  }
  return null;
}

function revalidateTrustedGit(identity) {
  const current = trustedGitIdentity(identity.candidate);
  return current.device === identity.device && current.inode === identity.inode && current.size === identity.size
    && current.mtimeMs === identity.mtimeMs && current.mode === identity.mode;
}

function runTrustedGit(root, args, maxOutput) {
  try {
    const executable = resolveTrustedGitExecutable();
    if (!executable) return null;
    const hardenedArgs = args[0] === 'diff'
      ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)]
      : args;
    const result = spawnSync(executable.path, [
      '--no-replace-objects',
      '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      '-c', 'diff.external=',
      '-C', root,
      ...hardenedArgs,
    ], {
      encoding: 'buffer',
      env: trustedGitEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: maxOutput + 1,
    });
    if (!result || result.error || result.signal || result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length > maxOutput || !revalidateTrustedGit(executable)) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

/**
 * Capture the repository state after the host has reported its result but
 * before this hook adds the command-log entry. Any Git uncertainty yields no
 * record: provenance cannot be represented safely, so an unconfirmed command
 * is preferable to an optimistic or unchained record.
 */
function observeGitWorktree(root, hooks = {}) {
  const head = runTrustedGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'], MAX_GIT_HEAD_OUTPUT);
  if (!head) return null;
  const observed_at_commit = head.toString('utf8').trim().toLowerCase();
  if (!COMMIT_SHA_RE.test(observed_at_commit)) return null;

  if (!ordinaryTrackedIndex(root)) return null;
  // Match the canonical Git-worktree snapshot inputs instead of status
  // porcelain. Index flags can suppress tracked changes from status, while
  // explicit ls-files tag inspection rejects those states.
  const trackedDiff = runTrustedGit(root, ['diff', '--binary', 'HEAD', '--', '.'], MAX_GIT_TRACKED_DIFF_OUTPUT);
  const untracked = runTrustedGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], MAX_GIT_UNTRACKED_LIST_OUTPUT);
  if (!trackedDiff || !untracked) return null;
  if (!hashUntrackedFiles(root, untracked)) return null;
  hooks.afterInitialInputsRead?.();
  const settledTrackedDiff = runTrustedGit(root, ['diff', '--binary', 'HEAD', '--', '.'], MAX_GIT_TRACKED_DIFF_OUTPUT);
  const settledUntracked = runTrustedGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], MAX_GIT_UNTRACKED_LIST_OUTPUT);
  if (!settledTrackedDiff || !settledUntracked || !settledTrackedDiff.equals(trackedDiff) || !settledUntracked.equals(untracked) || !ordinaryTrackedIndex(root)) return null;
  // A concurrent checkout or commit can otherwise pair worktree bytes with a
  // different revision. Refuse that uncertain boundary without appending a
  // confirming record; capture remains deliberately process-nonblocking.
  const settledHead = runTrustedGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'], MAX_GIT_HEAD_OUTPUT);
  if (!settledHead || settledHead.toString('utf8').trim().toLowerCase() !== observed_at_commit) return null;
  return { observed_at_commit, worktree_clean: trackedDiff.length === 0 && untracked.length === 0 };
}

// The hook does not retain this digest, but it reads the same bounded
// untracked-file bytes as the canonical snapshot before settling the list.
// This keeps a clean observation from crossing a change that appears while
// the initial inputs are being collected.
function hashUntrackedFiles(root, untrackedBytes) {
  try {
    const files = untrackedBytes.toString('utf8').split('\0').filter(Boolean).sort();
    const hash = crypto.createHash('sha256');
    let totalBytes = 0;
    for (const file of files) {
      const absolute = path.resolve(root, file);
      if (!pathIsWithin(absolute, root)) return false;
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
      try {
        const before = fs.fstatSync(descriptor);
        if (!before.isFile() || before.size > MAX_GIT_UNTRACKED_FILE_BYTES || totalBytes + before.size > MAX_GIT_UNTRACKED_TOTAL_BYTES) return false;
        hash.update(file).update('\0');
        const buffer = Buffer.allocUnsafe(GIT_HASH_READ_CHUNK_BYTES);
        let remaining = before.size;
        let position = 0;
        while (remaining > 0) {
          const bytesRead = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), position);
          if (bytesRead <= 0) return false;
          hash.update(buffer.subarray(0, bytesRead));
          remaining -= bytesRead;
          position += bytesRead;
        }
        const after = fs.fstatSync(descriptor);
        if (!sameFileIdentity(before, after)) return false;
        hash.update('\0');
        totalBytes += before.size;
      } finally { fs.closeSync(descriptor); }
    }
    hash.digest();
    return true;
  } catch {
    return false;
  }
}

function sameFileIdentity(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function ordinaryTrackedIndex(root, trustedGit = runTrustedGit) {
  const entries = trustedGit(root, ['ls-files', '-v', '-z'], MAX_GIT_TRACKED_INDEX_OUTPUT);
  if (!entries) return false;
  for (const entry of entries.toString('utf8').split('\0')) {
    if (entry && !entry.startsWith('H ')) return false;
  }
  return true;
}

function run(rawInput) {
  try {
    const input = parseJson(rawInput);
    const command = input.tool_input && input.tool_input.command;
    if (!isCommandTool(input.tool_name, command)) return rawInput;

    const root = resolveCanonicalGitRoot(input.cwd || process.cwd());
    if (!root) {
      process.stderr.write('[evidence-capture] Git observation uncertain; command-log left unchanged\n');
      return rawInput;
    }
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

    const gitObservation = observeGitWorktree(root);
    if (!gitObservation) {
      process.stderr.write('[evidence-capture] Git observation uncertain; command-log left unchanged\n');
      return rawInput;
    }

    const record = {
      command: clamp(command, MAX_COMMAND_LEN).replace(/\s+/g, ' ').trim(),
      observedResult,
      exitCode,
      ...gitObservation,
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
    if (lock === null) {
      process.stderr.write('[evidence-capture] command-log append authority unavailable; log left unchanged\n');
      return rawInput;
    }
    try {
      let raw = '';
      try { raw = fs.readFileSync(logFile, 'utf8'); } catch {}
      const authority = verifyCommandLogRaw(raw).append;
      if (!authority) {
        process.stderr.write('[evidence-capture] command-log append authority unavailable; log left unchanged\n');
        return rawInput;
      }
      const { seq: prevSeq, hash: prevHash } = authority;
      const seq = prevSeq + 1;
      const hash = computeChainHash(prevHash, record);
      // Spread record fields then add _chain so the chain field is appended last
      // (cosmetic ordering; canonicalJsonForChain excludes it during hashing).
      const recordToWrite = { ...record, _chain: { seq, prevHash, hash } };
      fs.appendFileSync(logFile, JSON.stringify(recordToWrite) + '\n');
    } finally {
      if (!releaseGenerationLock(lock)) {
        process.stderr.write('[evidence-capture] command-log generation release uncertain; later capture may require operator recovery\n');
      }
    }
  } catch {
    // Deliberately omit exception data: hook stderr can be surfaced outside the
    // repository and must not disclose file paths or host details. The command
    // result remains non-confirming because no new record was appended.
    process.stderr.write('[evidence-capture] capture failed; command-log left unchanged\n');
  }
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
  observeGitWorktree,
  ordinaryTrackedIndex,
  hashUntrackedFiles,
  isCommandTool,
  findRepoRoot,
  resolveCanonicalGitRoot,
  resolveTrustedGitExecutable,
  // Chain helpers exported for testing and gate verification.
  canonicalJsonForChain,
  computeChainHash,
  CHAIN_GENESIS,
};
