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
// the eval to make the active/active_abandoned case deterministic.
//
// Prints one JSON object to stdout and exits 0 always (best-effort, matches economics-record.sh's
// fail-open philosophy — the caller decides whether {ok:false} means "no record" or "explicit
// incomplete record"). Never throws past main().
'use strict';

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- terminal taxonomy (#925: honest completed/canceled/failed/blocked/active_abandoned) ---------
// Flow's own `status` enum is the single source of truth (schemas/flow-run.schema.json). A run that
// is still active/blocked/needs_decision/paused when THIS record is taken is NOT complete — it is
// "active_abandoned": the record is an honest snapshot of a run that had not reached a terminal
// state as of `at`, never mislabeled as success or failure.
const TERMINAL_STATUS_VALUES = [
  'completed',
  'canceled',
  'failed',
  'accepted_by_exception',
  'active_abandoned',
];

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
      return 'active_abandoned';
    default:
      // Unknown/unrecognized flow status: never guess toward "completed" — label honestly.
      return 'active_abandoned';
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

function mergePhaseWindowsIntoPhases(windows) {
  const order = [];
  const byPhase = new Map();
  for (const w of windows) {
    if (!byPhase.has(w.phase)) {
      byPhase.set(w.phase, 0);
      order.push(w.phase);
    }
    byPhase.set(w.phase, byPhase.get(w.phase) + w.wall_clock_s);
  }
  return order.map((phase) => ({
    phase,
    input_tokens: null,
    output_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    estimated_cost_usd: null,
    wall_clock_s: byPhase.get(phase),
    source: 'flow-run-record',
  }));
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
// whether the run ever reached a terminal state. A block that is still open on an active_abandoned
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
    const runEnded = terminalStatus !== 'active_abandoned';
    return runEnded ? 'FAIL' : 'NOT_VERIFIED';
  }
  return 'NOT_VERIFIED';
}

// --- time.human_wait_s: real pause/resume (and pause/cancel) intervals from the lifecycle ledger.
// Never estimated — a pause with no matching resume/cancel contributes nothing (still-paused tail
// is covered by the active_abandoned phase-window tail above, not double-counted here).
function deriveHumanWaitSeconds(lifecycle, nowIso) {
  const events = [...lifecycle]
    .filter((e) => e && typeof e.at === 'string' && typeof e.action === 'string')
    .sort((a, b) => (toMillis(a.at) ?? 0) - (toMillis(b.at) ?? 0));
  let total = 0;
  let pendingPauseAt = null;
  for (const e of events) {
    if (e.action === 'pause') {
      pendingPauseAt = e.at;
    } else if (e.action === 'resume' && pendingPauseAt) {
      const s = toMillis(pendingPauseAt);
      const en = toMillis(e.at);
      if (s !== null && en !== null && en > s) total += (en - s) / 1000;
      pendingPauseAt = null;
    } else if (e.action === 'cancel' && pendingPauseAt) {
      const s = toMillis(pendingPauseAt);
      const en = toMillis(e.at);
      if (s !== null && en !== null && en > s) total += (en - s) / 1000;
      pendingPauseAt = null;
    }
  }
  // Still-open pause with no resume/cancel recorded yet: count up to `now`.
  if (pendingPauseAt) {
    const s = toMillis(pendingPauseAt);
    const en = toMillis(nowIso);
    if (s !== null && en !== null && en > s) total += (en - s) / 1000;
  }
  return total;
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

  const transitions = state.transitions;
  const lifecycle = Array.isArray(state.lifecycle) ? state.lifecycle : [];
  const terminalStatus = deriveTerminalStatus(state.status);
  const windows = derivePhaseWindows(transitions, state.status, state.updated_at ?? null, nowIso);
  const phases = mergePhaseWindowsIntoPhases(windows);
  const iterations = deriveIterations(transitions);
  const gateFires = deriveGateFires(state, transitions);
  const verificationVerdict = deriveVerificationVerdict(transitions, terminalStatus);
  const humanWaitS = deriveHumanWaitSeconds(lifecycle, nowIso);
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
