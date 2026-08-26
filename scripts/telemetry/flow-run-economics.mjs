#!/usr/bin/env node
// flow-run-economics.mjs — derives economics-record truths directly from the canonical Flow run
// store (.kontourai/flow/runs/<run-id>/state.json + evidence/manifest.json), NOT from the
// session.usage event or the Builder workflow sidecar (`state.json` at a task-slug directory,
// which economics-record.sh already consumes via --state/--sidecar-snapshot).
//
// Repairs flow-agents#922/#925 phase A: today's economics records carry run_id "unknown" /
// producer_authority "unavailable" and every phase is "unattributed" because nothing reads the
// Flow run's own transitions/lifecycle/status. This tool reads that store directly — the ONE
// place a Flow run's real step-by-step history and terminal status live — and emits ONLY what it
// can observe. It NEVER fabricates tokens/cost (those stay null/0, tagged
// `source: "flow-run-record"`; token attribution is a separate, explicit tool — see
// economics-enrich-tokens.mjs) and it NEVER reports a still-active run as "completed" (terminal
// taxonomy below).
//
// Usage:
//   node flow-run-economics.mjs --flow-run-dir <path/to/.kontourai/flow/runs/RUN_ID> [--now <iso>]
//
// --now overrides "current time" for the tail phase window (defaults to the real clock) — used by
// the eval to make the active-run case deterministic.
//
// Prints one JSON object to stdout and exits 0 always (best-effort, matches economics-record.sh's
// fail-open philosophy — the caller decides whether {ok:false} means "no record" or "explicit
// incomplete record"). Never throws past main().
'use strict';

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- status projection -----------------------------------------------------------------------------
// Flow's own `status` enum is the single source of truth (schemas/flow-run.schema.json). This
// producer observes state, not intent: an active run is active, and it cannot call that run
// abandoned merely because it is emitting a snapshot. `active_abandoned` is deliberately absent
// until an explicit, declared staleness-at-close derivation exists.
const TERMINAL_STATUS_VALUES = [
  'completed',
  'canceled',
  'failed',
  'accepted_by_exception',
  'active',
  'blocked',
  'needs_decision',
  'paused',
];

// Review finding 5 (MEDIUM): every Flow `status` value this tool knows how to map. A value
// outside this set is REFUSED (deriveFlowRunEconomics returns ok:false) rather than silently
// folded into a guessed status — the installed Flow schema's status enum has already grown once
// (paused/canceled/lifecycle/gate_outcome_history/multi_cursor are all new since an earlier
// working copy), so a future new status value must surface loudly, not vanish into a bucket
// indistinguishable from a genuinely-observed status.
const KNOWN_FLOW_STATUSES = new Set([
  'active', 'blocked', 'needs_decision', 'paused',
  'canceled', 'completed', 'failed', 'accepted_by_exception',
]);

function deriveTerminalStatus(flowStatus) {
  switch (flowStatus) {
    case 'completed':
      return 'completed';
    case 'canceled':
      return 'canceled';
    case 'failed':
      return 'failed';
    case 'accepted_by_exception':
      return 'accepted_by_exception';
    case 'active':
    case 'blocked':
    case 'needs_decision':
    case 'paused':
      return flowStatus;
    default:
      // Unknown/unrecognized Flow status is refused by deriveFlowRunEconomics.
      return null;
  }
}

function isTerminalFlowStatus(flowStatus) {
  return flowStatus === 'completed' || flowStatus === 'canceled'
    || flowStatus === 'failed' || flowStatus === 'accepted_by_exception';
}

function toMillis(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// --- phase windows: walk transitions chronologically, attributing each inter-transition interval
// to the step that was active during it. Route-back re-entries into a step accumulate onto the
// SAME phase bucket (a Map, not a fresh entry). The step active BEFORE the first transition is
// never attributed a duration — we have no observed entry timestamp for it, and this tool never
// fabricates one (see docs/specs/economics-record-contract.md for this documented limitation).
function derivePhaseWindows(transitions, flowStatus, updatedAtIso, nowIso) {
  const sorted = [...transitions]
    .filter((t) => t && typeof t === 'object' && typeof t.at === 'string')
    .sort((a, b) => (toMillis(a.at) ?? 0) - (toMillis(b.at) ?? 0));

  const windows = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const activeStep = prev.to_step ?? prev.from_step ?? null;
    const startMs = toMillis(prev.at);
    const endMs = toMillis(cur.at);
    if (activeStep && startMs !== null && endMs !== null && endMs > startMs) {
      windows.push({ phase: activeStep, start: prev.at, end: cur.at, wall_clock_s: (endMs - startMs) / 1000 });
    }
  }

  // Tail interval: from the last transition to the record's effective end. Terminal runs end at
  // updated_at (the last real state mutation); a still-active run's tail is open, so it is bounded
  // by `now` (the moment THIS record is being produced) rather than fabricating a future endpoint.
  if (sorted.length > 0) {
    const last = sorted[sorted.length - 1];
    const activeStep = last.to_step ?? last.from_step ?? null;
    const startMs = toMillis(last.at);
    const tailEndIso = isTerminalFlowStatus(flowStatus) ? (updatedAtIso ?? last.at) : nowIso;
    const endMs = toMillis(tailEndIso);
    if (activeStep && startMs !== null && endMs !== null && endMs > startMs) {
      windows.push({ phase: activeStep, start: last.at, end: tailEndIso, wall_clock_s: (endMs - startMs) / 1000 });
    }
  }

  return windows;
}

// --- pause intervals: real pause->resume (or pause->cancel, or a still-open pause->now)
// windows from the lifecycle ledger. Shared by both the top-level time.human_wait_s total
// (deriveHumanWaitSeconds) and the per-phase active/pause split below (review finding 2) — one
// computation, two consumers, so they can never drift against each other.
function derivePauseIntervals(lifecycle, nowIso) {
  const events = [...lifecycle]
    .filter((e) => e && typeof e.at === 'string' && typeof e.action === 'string')
    .sort((a, b) => (toMillis(a.at) ?? 0) - (toMillis(b.at) ?? 0));
  const intervals = [];
  let pendingPauseAt = null;
  for (const e of events) {
    if (e.action === 'pause') {
      pendingPauseAt = e.at;
    } else if ((e.action === 'resume' || e.action === 'cancel') && pendingPauseAt) {
      const s = toMillis(pendingPauseAt);
      const en = toMillis(e.at);
      if (s !== null && en !== null && en > s) intervals.push({ startMs: s, endMs: en });
      pendingPauseAt = null;
    }
  }
  // Still-open pause with no resume/cancel recorded yet: count up to `now`.
  if (pendingPauseAt) {
    const s = toMillis(pendingPauseAt);
    const en = toMillis(nowIso);
    if (s !== null && en !== null && en > s) intervals.push({ startMs: s, endMs: en });
  }
  return intervals;
}

function overlapSeconds(startMs, endMs, pauseIntervals) {
  let total = 0;
  for (const iv of pauseIntervals) {
    const s = Math.max(startMs, iv.startMs);
    const e = Math.min(endMs, iv.endMs);
    if (e > s) total += (e - s) / 1000;
  }
  return total;
}

// Review finding 2 (HIGH, confirmed against real 14.5-day-paused production data): a raw
// inter-transition window's calendar duration is NOT "how long that phase took to work" when a
// lifecycle pause falls inside it — it can be almost entirely idle time. Subtract each window's
// overlap with the real pause intervals before attributing wall_clock_s (now genuinely ACTIVE
// time), and surface the subtracted portion as that phase's own human_wait_s so a consumer can
// see exactly which phase absorbed how much pause without needing to correlate against the
// top-level aggregate by hand.
function mergePhaseWindowsIntoPhases(windows, pauseIntervals) {
  const order = [];
  const byPhase = new Map();
  for (const w of windows) {
    if (!byPhase.has(w.phase)) {
      byPhase.set(w.phase, { activeS: 0, pauseS: 0 });
      order.push(w.phase);
    }
    const startMs = toMillis(w.start);
    const endMs = toMillis(w.end);
    const pauseS = (startMs !== null && endMs !== null) ? overlapSeconds(startMs, endMs, pauseIntervals) : 0;
    const activeS = Math.max(0, w.wall_clock_s - pauseS);
    const bucket = byPhase.get(w.phase);
    bucket.activeS += activeS;
    bucket.pauseS += pauseS;
  }
  return order.map((phase) => {
    const b = byPhase.get(phase);
    return {
      phase,
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      estimated_cost_usd: null,
      wall_clock_s: b.activeS,
      human_wait_s: b.pauseS,
      source: 'flow-run-record',
    };
  });
}

// --- iterations / route-backs: transitions of type "route_back" are the canonical route-back
// ledger entries (flow-run.schema.json #/$defs/transition). iterations.count follows the contract
// doc's "deliver-loop passes" definition: the first pass plus one additional pass per route-back.
function deriveIterations(transitions) {
  const routeBacks = transitions.filter((t) => t && t.type === 'route_back').length;
  return { count: routeBacks + 1, route_backs: routeBacks };
}

// --- defects.gate_fires: prefer the append-only gate_outcome_history ledger (status
// block|route-back) when the run has one; legacy runs that predate it fall back to counting
// blocked transitions (every route-back or in-place block is itself a gate firing against the run).
function deriveGateFires(state, transitions) {
  const history = Array.isArray(state.gate_outcome_history) ? state.gate_outcome_history : [];
  if (history.length > 0) {
    return history.filter((g) => g && (g.status === 'block' || g.status === 'route-back')).length;
  }
  return transitions.filter((t) => t && t.status === 'blocked').length;
}

// --- defects.verification_verdict: the LAST transition departing the "verify" step, bounded by
// whether the run ever reached a terminal state. A block that is still open on a non-terminal
// run is NOT a FAIL — the run has not finished attempting verification. A block that is still open
// when the run terminated (failed/canceled/accepted_by_exception without a later "verify" pass) IS
// a genuine FAIL. No "verify" transition observed at all -> NOT_VERIFIED (never guessed as PASS).
function deriveVerificationVerdict(transitions, terminalStatus) {
  const verifyTransitions = transitions
    .filter((t) => t && t.from_step === 'verify' && typeof t.at === 'string')
    .sort((a, b) => (toMillis(a.at) ?? 0) - (toMillis(b.at) ?? 0));
  if (verifyTransitions.length === 0) return 'NOT_VERIFIED';
  const last = verifyTransitions[verifyTransitions.length - 1];
  if (last.status === 'allowed' || last.status === 'skipped' || last.status === 'accepted_by_exception') {
    return 'PASS';
  }
  if (last.status === 'blocked') {
    const runEnded = isTerminalFlowStatus(terminalStatus);
    return runEnded ? 'FAIL' : 'NOT_VERIFIED';
  }
  return 'NOT_VERIFIED';
}

// --- time.human_wait_s: the TRUE total of real pause/resume (and pause/cancel, and a still-open
// pause) intervals from the lifecycle ledger — independent of phase-window attribution, so it
// stays correct even when a pause falls in the undropped pre-first-transition gap (see
// derivePhaseWindows) where no phase window exists to attribute it to. phases[].human_wait_s
// (mergePhaseWindowsIntoPhases) is the best-effort PER-PHASE breakdown of this same total and may
// sum to slightly less than it in that one disclosed edge case.
function deriveHumanWaitSeconds(pauseIntervals) {
  return pauseIntervals.reduce((sum, iv) => sum + (iv.endMs - iv.startMs) / 1000, 0);
}

// --- multi_cursor (review finding 5, MEDIUM->refusal): the installed Flow schema supports
// durable concurrent step claims (active_claims/claim_history). This tool's single-cursor,
// one-phase-active-between-any-two-transitions model has no awareness of concurrent claims — if
// one is genuinely active, the phase-window derivation above would silently attribute wrong,
// overlapping windows. Refuse rather than guess: every real run inspected today has an empty,
// inert multi_cursor ledger, so this never fires in practice yet.
function multiCursorActive(state) {
  const mc = state.multi_cursor;
  if (!mc || typeof mc !== 'object') return false;
  const activeClaims = Array.isArray(mc.active_claims) ? mc.active_claims.length : 0;
  const claimHistory = Array.isArray(mc.claim_history) ? mc.claim_history.length : 0;
  return activeClaims > 0 || claimHistory > 0;
}

export function deriveFlowRunEconomics(state, { nowIso = new Date().toISOString() } = {}) {
  if (!state || typeof state !== 'object') {
    return { ok: false, reason: 'flow run state.json is missing or not an object' };
  }
  const requiredKeys = ['schema_version', 'run_id', 'status', 'current_step', 'transitions'];
  for (const k of requiredKeys) {
    if (!(k in state)) {
      return { ok: false, reason: `flow run state.json is missing required field "${k}"` };
    }
  }
  if (!Array.isArray(state.transitions)) {
    return { ok: false, reason: 'flow run state.json "transitions" is not an array' };
  }
  if (!KNOWN_FLOW_STATUSES.has(state.status)) {
    return {
      ok: false,
      reason: `flow run state.json has an unrecognized status "${state.status}" — refusing rather than guessing a status (flow-agents#925)`,
    };
  }
  if (multiCursorActive(state)) {
    return {
      ok: false,
      reason: 'flow run state.json carries active multi_cursor concurrent step claims; single-cursor phase-window derivation is not supported for this run (flow-agents#922 follow-up)',
    };
  }

  const transitions = state.transitions;
  const lifecycle = Array.isArray(state.lifecycle) ? state.lifecycle : [];
  const terminalStatus = deriveTerminalStatus(state.status);
  const pauseIntervals = derivePauseIntervals(lifecycle, nowIso);
  const windows = derivePhaseWindows(transitions, state.status, state.updated_at ?? null, nowIso);
  const phases = mergePhaseWindowsIntoPhases(windows, pauseIntervals);
  const iterations = deriveIterations(transitions);
  const gateFires = deriveGateFires(state, transitions);
  const verificationVerdict = deriveVerificationVerdict(transitions, terminalStatus);
  const humanWaitS = deriveHumanWaitSeconds(pauseIntervals);
  // ACTIVE total: sum of phases[].wall_clock_s, which is now pause-EXCLUDED per phase (finding 2).
  const wallClockS = phases.reduce((sum, p) => sum + (p.wall_clock_s || 0), 0);
  // The record's own "as-of" timestamp: for a terminal run this is the last real state mutation
  // (state.updated_at); for a still-active run it is the moment THIS record is produced (nowIso) —
  // never a fabricated completion time.
  const recordAtIso = isTerminalFlowStatus(state.status) ? (state.updated_at ?? nowIso) : nowIso;

  return {
    ok: true,
    run_id: state.run_id,
    terminal_status: terminalStatus,
    record_at_iso: recordAtIso,
    time: { wall_clock_s: wallClockS, human_wait_s: humanWaitS },
    phases,
    phase_windows: windows,
    iterations,
    defects: { gate_fires: gateFires, verification_verdict: verificationVerdict },
  };
}

export function loadFlowRunDir(dir) {
  const statePath = join(dir, 'state.json');
  if (!existsSync(statePath)) {
    return { ok: false, reason: `no state.json under ${dir}` };
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `state.json is not valid JSON: ${err.message}` };
  }
  const manifestPath = join(dir, 'evidence', 'manifest.json');
  const evidenceManifestPresent = existsSync(manifestPath);
  return { ok: true, state, evidenceManifestPresent };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--flow-run-dir') { out.flowRunDir = argv[i + 1]; i += 1; }
    else if (a === '--now') { out.now = argv[i + 1]; i += 1; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.flowRunDir) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'usage: flow-run-economics.mjs --flow-run-dir <path> [--now <iso>]' })}\n`);
    process.exitCode = 0;
    return;
  }
  const loaded = loadFlowRunDir(args.flowRunDir);
  if (!loaded.ok) {
    process.stdout.write(`${JSON.stringify(loaded)}\n`);
    process.exitCode = 0;
    return;
  }
  const nowIso = args.now || new Date().toISOString();
  const derived = deriveFlowRunEconomics(loaded.state, { nowIso });
  const result = derived.ok
    ? { ...derived, evidence_manifest_present: loaded.evidenceManifestPresent }
    : derived;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}

// Robust "am I the CLI entry point" check: a naive `import.meta.url === file://${argv[1]}`
// string compare breaks whenever the invocation path traverses a symlink (e.g. macOS's
// /tmp -> /private/tmp) because import.meta.url resolves to the real path while argv[1] keeps
// the given one — realpath-normalize both sides before comparing.
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}

export { TERMINAL_STATUS_VALUES, deriveTerminalStatus, isTerminalFlowStatus };
