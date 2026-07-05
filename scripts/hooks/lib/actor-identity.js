'use strict';
/**
 * actor-identity.js — shared pure-CJS runtime-agnostic actor identity resolver
 *
 * Zero external dependencies (only Node core: fs, os, crypto, child_process).
 * Consumed by:
 *   - scripts/hooks/workflow-steering.js  (CJS, direct require)
 *   - build/src/cli/workflow-sidecar.js   (ESM compiled, via createRequire)
 *
 * Purpose (issue #287): retire the shared literal `"local"` liveness-actor
 * default. A fresh Bash-tool subshell cannot inherit env exported by a
 * sibling hook subprocess, so this module recomputes the same actor on
 * every invocation from a priority chain, rather than relying on any
 * hook-writes-env or last-writer-wins persisted file:
 *
 *   1. `FLOW_AGENTS_ACTOR` env override, explicit, always wins (unless it is
 *      the literal `"local"`, case-insensitive, or it strips to empty under
 *      the allowed `[A-Za-z0-9_.-]` charset — neither value can round trip
 *      back in via the override seam; either rejection emits one stderr
 *      warning line, never silently substituting the shared `"unknown"`
 *      sentinel). A deliberate literal `"unknown"` override still passes
 *      through (it sanitizes to itself). The accepted override value is
 *      passed through `sanitizeSegment` (64-char cap; strips `:`) before use
 *      — it is never returned verbatim.
 *   2. A runtime-native session-id env var already ambient in the current
 *      process's own environment (confirmed for Claude Code:
 *      `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID`; Codex/opencode/pi candidate
 *      var names below are UNVERIFIED in this planning pass — accepted gap,
 *      see plan artifact — layer 3 is the correctness backstop for them).
 *   3. A process-ancestry fallback: `process.ppid` plus that parent
 *      process's exact start timestamp (an absolute timestamp, not an
 *      elapsed-time subtraction, to avoid clock-drift flicker across
 *      repeated invocations seconds/minutes apart within one session),
 *      hashed into a short opaque token. Works identically for a Bash-tool
 *      shell or a hook subprocess, since both are children of the same
 *      long-lived runtime process for that session.
 *
 * Accepted gap: sandboxed/containerized environments without a working
 * `ps`/`/proc` degrade the ancestry fallback to a PID-only seed (no
 * start-time component), which is collision-prone under PID reuse on a
 * long-uptime host. This is documented, not silently absorbed as "solved".
 *
 * Exports:
 *   detectRuntime(env)       → "claude-code" | "codex" | "opencode" | "pi" | "unknown"
 *   runtimeSessionId(env)    → first non-empty runtime-native session id, else ""
 *   ancestorActorSeed()      → short opaque token from parent PID + start time, else ""
 *   sanitizeSegment(value)   → value restricted to [A-Za-z0-9_.-], capped 64 chars
 *   serializeActor(actor)    → actor struct serialized to a single grouping-key-safe string
 *   resolveActor(env)        → { actor: string, source: string }
 *   isUnresolvedActor(actor) → boolean (true when actor is empty or the retired literal
 *                              "local", case-insensitive — single-sourced predicate shared by
 *                              the lifecycle auto-emit path, the direct CLI liveness path, and
 *                              (#288) the tool-activity heartbeat path, so all three can never
 *                              disagree on what counts as "no usable actor")
 */

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/** Candidate env var names for each runtime's native session id. */
const RUNTIME_SESSION_ID_VARS = {
  'claude-code': 'CLAUDE_CODE_SESSION_ID',
  // Codex/opencode/pi candidate names are UNVERIFIED (no confirmed spike this
  // planning pass) — accepted gap. Detection failure never blocks resolution;
  // the process-ancestry fallback (layer 3) covers these runtimes either way.
  codex: 'CODEX_SESSION_ID',
  opencode: 'OPENCODE_SESSION_ID',
  pi: 'PI_SESSION_ID',
};

/**
 * Detect which coding-agent runtime the current process is running under.
 * Detection failure must never block actor resolution — always falls back
 * to "unknown" rather than throwing.
 *
 * @param {NodeJS.ProcessEnv} [env]  Environment to inspect (default process.env)
 * @returns {"claude-code"|"codex"|"opencode"|"pi"|"unknown"}
 */
function detectRuntime(env = process.env) {
  env = env || {};
  if (env.CLAUDECODE === '1' || String(env.CLAUDE_CODE_SESSION_ID || '').trim()) {
    return 'claude-code';
  }
  if (String(env.CODEX_SESSION_ID || '').trim()) return 'codex';
  if (String(env.OPENCODE_SESSION_ID || '').trim()) return 'opencode';
  if (String(env.PI_SESSION_ID || '').trim()) return 'pi';
  return 'unknown';
}

/**
 * Return the first non-empty runtime-native session id candidate present in
 * the given environment, checked in a fixed order across all known
 * runtimes (not just the detected one, so a misdetected/ambiguous env still
 * resolves a usable id).
 *
 * @param {NodeJS.ProcessEnv} [env]  Environment to inspect (default process.env)
 * @returns {string}  Non-empty session id, or "" if none present
 */
function runtimeSessionId(env = process.env) {
  env = env || {};
  for (const varName of Object.values(RUNTIME_SESSION_ID_VARS)) {
    const candidate = String(env[varName] || '').trim();
    if (candidate) return candidate;
  }
  return '';
}

/**
 * Read the parent process's absolute start timestamp on BSD/macOS via
 * `ps -o lstart= -p <ppid>` (parsed with Date.parse — an absolute wall-clock
 * timestamp, not an elapsed-time subtraction).
 *
 * @param {number} ppid
 * @returns {string}  Epoch-ms string, or "" if unobtainable
 */
function getBsdAncestorStartTimeMs(ppid) {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(ppid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const trimmed = String(out || '').trim();
    if (!trimmed) return '';
    const parsedMs = Date.parse(trimmed);
    return Number.isNaN(parsedMs) ? '' : String(parsedMs);
  } catch {
    return '';
  }
}

/**
 * Read the parent process's absolute start timestamp on Linux via
 * `/proc/<ppid>/stat` field 22 (starttime, in clock ticks since boot)
 * converted through `/proc/stat`'s `btime` (boot time, seconds since epoch)
 * plus the clock-tick rate (via `getconf CLK_TCK`, falling back to the
 * standard USER_HZ default of 100 if unavailable). This yields an absolute
 * epoch timestamp, not an elapsed-time subtraction.
 *
 * @param {number} ppid
 * @returns {string}  Epoch-ms string, or "" if unobtainable
 */
function getLinuxAncestorStartTimeMs(ppid) {
  try {
    const statRaw = fs.readFileSync(`/proc/${ppid}/stat`, 'utf8');
    // The comm field (2nd field) is parenthesized and may itself contain
    // spaces/parens, so split on the *last* ")" rather than whitespace.
    const closeParen = statRaw.lastIndexOf(')');
    if (closeParen === -1) return '';
    const rest = statRaw.slice(closeParen + 2).trim().split(/\s+/);
    // Fields after ")" start at field 3 (state); field 22 (starttime) is
    // therefore index 22 - 3 = 19 in this zero-indexed remainder array.
    const startTicks = Number(rest[19]);
    if (!Number.isFinite(startTicks)) return '';

    const procStat = fs.readFileSync('/proc/stat', 'utf8');
    const btimeMatch = procStat.match(/^btime\s+(\d+)/m);
    if (!btimeMatch) return '';
    const btimeSeconds = Number(btimeMatch[1]);
    if (!Number.isFinite(btimeSeconds)) return '';

    let clockTicksPerSec = 100; // USER_HZ default; accepted approximation if getconf fails.
    try {
      const getconfOut = execFileSync('getconf', ['CLK_TCK'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
      const parsedTicks = Number(getconfOut);
      if (Number.isFinite(parsedTicks) && parsedTicks > 0) clockTicksPerSec = parsedTicks;
    } catch {
      /* fall back to the USER_HZ default above */
    }

    const startSeconds = btimeSeconds + startTicks / clockTicksPerSec;
    return String(Math.round(startSeconds * 1000));
  } catch {
    return '';
  }
}

/**
 * Compute a runtime-agnostic process-ancestry seed: the current process's
 * parent PID plus that parent's exact (absolute) start timestamp, hashed
 * into a short opaque token. Stable across repeated invocations within the
 * same session (same parent PID, same start time), distinct across
 * concurrent sessions on one host (different parent process per session).
 *
 * Degrades to a PID-only seed (documented accepted gap — collision-prone
 * under PID reuse on a long-uptime host) when the start timestamp cannot be
 * obtained (no working `ps`/`/proc`, e.g. some sandboxes). Returns "" only
 * in the near-impossible case that `process.ppid` itself is unavailable.
 *
 * @returns {string}  Short opaque hex token, or ""
 */
function ancestorActorSeed() {
  try {
    const ppid = process.ppid;
    if (!ppid || ppid <= 0) return '';

    const startTimeMs =
      process.platform === 'linux'
        ? getLinuxAncestorStartTimeMs(ppid)
        : getBsdAncestorStartTimeMs(ppid);

    const seedInput = startTimeMs ? `${ppid}:${startTimeMs}` : `pid-only:${ppid}`;
    return crypto.createHash('sha1').update(seedInput).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

/**
 * Restrict a value to a grouping-key-safe segment: strip everything outside
 * `[A-Za-z0-9_.-]`, cap at 64 chars, and fall back to `"unknown"` if empty
 * after stripping. Guarantees the result never contains `:` (so it can
 * never collide with the `::` grouping delimiter used elsewhere) and is
 * never an empty string (so joined segments never produce doubled `:`).
 *
 * @param {*} value
 * @returns {string}
 */
function sanitizeSegment(value) {
  const cleaned = String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .slice(0, 64);
  return cleaned || 'unknown';
}

/**
 * #398: detect a CI-triggered session and derive a STABLE actor identity from the CI provider's
 * published identifiers. The right granularity is the JOB/RUN (a CI job ≈ one agent session), NOT
 * the runner machine (hostname can be shared/reused across jobs). Detection is order-independent
 * (each provider gates on its own canonical marker env var). Returns `{ runtime, session_id }` on a
 * recognized provider WITH a non-blank stable id, else `null` (caller falls through to
 * process-ancestry, where #293's advisory verify-hold net still protects).
 *
 * Deliberately conservative: a generic/unrecognized `CI=true` returns null rather than fabricating
 * a "stable" id from something that might shift between subprocesses — a wrong stable classification
 * would let the #293 hard gate ENFORCE against a shifting identity, which is worse than advisory.
 * All segments are sanitized by serializeActor at the call site (allowed charset, length-capped),
 * so a hostile env var value cannot inject.
 *
 * ACCEPTED GRANULARITY GAP (matrix / parallelism): the id is job/run-granular. GitLab (`CI_JOB_ID`),
 * Azure (`SYSTEM_JOBID`), and Buildkite (`BUILDKITE_JOB_ID`) expose a per-job-INSTANCE id that is
 * already unique across matrix/parallel legs. CircleCI parallelism is disambiguated below via
 * `CIRCLE_NODE_INDEX`. But GitHub Actions and Jenkins declarative-`matrix{}` cells share
 * `GITHUB_JOB` / `BUILD_TAG` across all legs of one run+attempt — matrix values live only in the
 * `${{ matrix }}` / axis context, not in any env var this can read — so two concurrent legs collapse
 * to the SAME CI actor. This degrades SAFELY: worst case is idempotent self-recognition (one leg
 * treats another's claim as its own); it never false-blocks and never injects. The coordination-
 * relevant CI jobs (trust-reconcile / publish) run as single, non-matrix jobs today. Filed as a
 * fast-follow to add a GitHub-matrix disambiguator if a coordination path ever runs under a matrix.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{runtime: string, session_id: string} | null}
 */
function detectCiActor(env = process.env) {
  env = env || {};
  const s = (v) => String(v == null ? '' : v).trim();
  const compose = (...parts) => parts.map(s).filter(Boolean).join('-');

  // GitHub Actions — run id + attempt + job is unique and stable across the whole job.
  if (s(env.GITHUB_ACTIONS) === 'true') {
    const id = compose(env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, env.GITHUB_JOB);
    return id ? { runtime: 'github-actions', session_id: id } : null;
  }
  // GitLab CI — CI_JOB_ID is stable per job.
  if (s(env.GITLAB_CI) === 'true') {
    const id = s(env.CI_JOB_ID);
    return id ? { runtime: 'gitlab-ci', session_id: id } : null;
  }
  // CircleCI — workflow id + job name + node index (CIRCLE_NODE_INDEX disambiguates the containers
  // of a `parallelism: N` job; "0" for a single-container job, so it is always present and stable).
  if (s(env.CIRCLECI) === 'true') {
    const id = compose(env.CIRCLE_WORKFLOW_ID, env.CIRCLE_JOB, env.CIRCLE_NODE_INDEX) || s(env.CIRCLE_BUILD_NUM);
    return id ? { runtime: 'circleci', session_id: id } : null;
  }
  // Jenkins — BUILD_TAG is the stable per-build identifier; fall back to job + build id.
  if (s(env.JENKINS_URL)) {
    const id = s(env.BUILD_TAG) || compose(env.JOB_NAME, env.BUILD_ID);
    return id ? { runtime: 'jenkins', session_id: id } : null;
  }
  // Azure Pipelines — build id + system job id (SYSTEM_JOBID is a per-job-instance GUID, unique
  // across matrix/strategy legs).
  if (s(env.TF_BUILD) === 'true') {
    const id = compose(env.BUILD_BUILDID, env.SYSTEM_JOBID);
    return id ? { runtime: 'azure-pipelines', session_id: id } : null;
  }
  // Buildkite — job id is a stable UUID per job.
  if (s(env.BUILDKITE) === 'true') {
    const id = s(env.BUILDKITE_JOB_ID);
    return id ? { runtime: 'buildkite', session_id: id } : null;
  }
  // Generic/unrecognized CI: do NOT fabricate stability — fall through to process-ancestry.
  return null;
}

/**
 * Serialize a runtime-agnostic actor struct into a single string safe for
 * the existing `${subjectId}::${actor}` grouping key: each field is passed
 * through sanitizeSegment (so no raw `:` can appear inside any segment),
 * then joined with a single `:` delimiter (never doubled).
 *
 * @param {{runtime?: string, session_id?: string, host?: string, human?: string}} actor
 * @returns {string}
 */
function serializeActor(actor) {
  actor = actor || {};
  const parts = [
    sanitizeSegment(actor.runtime),
    sanitizeSegment(actor.session_id),
    sanitizeSegment(actor.host),
  ];
  if (actor.human != null && String(actor.human).trim() !== '') {
    parts.push(sanitizeSegment(actor.human));
  }
  return parts.join(':');
}

/**
 * Resolve the current process's actor identity via the priority chain:
 *   1. `env.FLOW_AGENTS_ACTOR` (trimmed, non-empty, not literal "local"
 *      case-insensitive, and not stripping to empty under the allowed
 *      `[A-Za-z0-9_.-]` charset) — wins outright, but is passed through
 *      `sanitizeSegment` before being returned (64-char cap; strips `:`) so
 *      it is always grouping-key-safe and display-safe. Callers must NOT
 *      assume this value is returned verbatim — it never is. A deliberate
 *      literal `"unknown"` override is honored as-is (it sanitizes to
 *      itself) — only a value that strips to empty is rejected.
 *   2. Runtime-native session id (via runtimeSessionId), serialized with
 *      detectRuntime() and os.hostname().
 *   3. Process-ancestry fallback (via ancestorActorSeed), serialized the
 *      same way.
 *
 * `actor` is `""` only if every layer failed (near-impossible in practice,
 * since layer 3 has no external dependency).
 *
 * When `FLOW_AGENTS_ACTOR` is set but rejected — either because it is the
 * literal `"local"` (case-insensitive) or because it strips to empty under
 * the allowed charset (e.g. `":::"`) — a single diagnostic line is written
 * to `process.stderr` (never stdout, never thrown) so the substitution is
 * never silent, and resolution falls through to the runtime/ancestry
 * derivation below rather than adopting the shared `"unknown"` sentinel:
 *   - literal "local": `[actor-identity] ignoring FLOW_AGENTS_ACTOR=local
 *     (reserved legacy value); using derived actor`.
 *   - strips to empty: `[actor-identity] ignoring FLOW_AGENTS_ACTOR override
 *     (strips to empty under allowed charset [A-Za-z0-9_.-]); using derived
 *     actor`.
 *
 * Test-only escape hatch: requires BOTH
 * `env.FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED === "1"` AND
 * `env.NODE_ENV === "test"` — short-circuits to `{ actor: "", source:
 * "test-forced-unresolved" }` before any real detection runs. This lets
 * tests prove the fail-loud path deterministically without sabotaging
 * `ps`/`/proc`, while the `NODE_ENV === "test"` requirement prevents the
 * hatch from being tripped by an accidental/malicious env var outside a
 * test harness.
 *
 * @param {NodeJS.ProcessEnv} [env]  Environment to resolve from (default process.env)
 * @returns {{actor: string, source: string}}
 */
function resolveActor(env = process.env) {
  env = env || {};

  if (env.FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED === '1' && env.NODE_ENV === 'test') {
    return { actor: '', source: 'test-forced-unresolved' };
  }

  const explicit = String(env.FLOW_AGENTS_ACTOR || '').trim();
  if (explicit) {
    if (explicit.toLowerCase() === 'local') {
      // Rejected literal "local" override: never silent — one stderr warning line, never stdout,
      // never thrown (hooks parse stdout; this diagnostic must not break that contract).
      try {
        process.stderr.write(
          '[actor-identity] ignoring FLOW_AGENTS_ACTOR=local (reserved legacy value); using derived actor\n'
        );
      } catch { /* best-effort diagnostic only */ }
    } else if (!/[A-Za-z0-9_.-]/.test(explicit)) {
      // F7 (#287 fix iteration 2): the override strips to empty under sanitizeSegment's allowed
      // charset — falling through to sanitizeSegment here would silently adopt its "unknown"
      // fallback sentinel as if it were a deliberate value. Reject instead, with the same
      // never-silent / never-stdout / never-thrown contract as the "local" rejection above. A
      // literal "unknown" override is unaffected by this branch (it contains allowed chars, so it
      // sanitizes to itself and returns via the branch below).
      try {
        process.stderr.write(
          '[actor-identity] ignoring FLOW_AGENTS_ACTOR override (strips to empty under allowed charset [A-Za-z0-9_.-]); using derived actor\n'
        );
      } catch { /* best-effort diagnostic only */ }
    } else {
      return { actor: sanitizeSegment(explicit), source: 'explicit-override' };
    }
  }

  const runtime = detectRuntime(env);
  const sessionId = runtimeSessionId(env);
  if (sessionId) {
    const actor = serializeActor({ runtime, session_id: sessionId, host: os.hostname() });
    return { actor, source: `runtime-session-id:${runtime}` };
  }

  // #398: CI-runtime tier — sits ABOVE process-ancestry (stable across every subprocess in a CI
  // job) and BELOW an explicit override / native runtime session id (those are more specific and
  // already returned above). A CI-triggered agent session otherwise falls to process-ancestry,
  // whose seed differs across subprocesses within one job (a subject claimed in `ensure-session`
  // isn't recognized as self at `publish`) — the exact instability #293 had to degrade the
  // verify-hold gate to advisory for. A stable CI identity lets that gate ENFORCE instead.
  const ci = detectCiActor(env);
  if (ci && ci.session_id) {
    const actor = serializeActor({ runtime: ci.runtime, session_id: ci.session_id, host: os.hostname() });
    return { actor, source: `ci-runtime:${ci.runtime}` };
  }

  const seed = ancestorActorSeed();
  if (seed) {
    const actor = serializeActor({ runtime, session_id: `anc-${seed}`, host: os.hostname() });
    return { actor, source: 'process-ancestry' };
  }

  return { actor: '', source: 'unresolved' };
}

/**
 * True when an actor is empty or the retired literal "local" (case-insensitive) — the one
 * shared definition of "unresolved" (#287 fix iteration 1, F6; single-sourced here per #288's
 * Wave 1 Task 1.1 so the lifecycle auto-emit path, the direct CLI liveness path, and the
 * tool-activity heartbeat path all consume the same predicate rather than each forking their
 * own copy).
 *
 * @param {string} actor
 * @returns {boolean}
 */
function isUnresolvedActor(actor) {
  return !actor || String(actor).toLowerCase() === 'local';
}

module.exports = {
  detectRuntime,
  runtimeSessionId,
  detectCiActor,
  ancestorActorSeed,
  sanitizeSegment,
  serializeActor,
  resolveActor,
  isUnresolvedActor,
};
