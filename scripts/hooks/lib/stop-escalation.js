'use strict';
// ---------------------------------------------------------------------------
// stop-escalation.js — the Stop gate's turn-ending contract (issue #1172).
//
// #1005 established that a denied TOOL CALL must end the call, not the turn. #1172 measured
// that Stop had the same defect and worse consequences: the adapter emitted `decision:"block"`
// + `reason` AND `continue:false` + `stopReason`, `continue` takes precedence, and `stopReason`
// is shown to the user and explicitly not to Claude — so the one gate whose message is written
// as model-facing remediation was the one gate structurally unable to deliver it.
//
// Removing `continue:false` outright is not safe on its own, because Stop blocks are not one
// kind of thing:
//
//   SOFT block — an ordinary evidence gap. stop-goal-fit.js already owns termination for this
//     class: after FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS identical refusals its release valve fires,
//     clears the streak and returns exit 0 ("released — ... needs your decision"). Nothing in
//     the adapter may pre-empt that, or the gate's own promise to the operator ("after N
//     identical blocks I stop blocking and hand this to you") becomes a lie and the valve is
//     truncated to fewer refusals than it advertises.
//
//   HARD block — caught false-completion, capture contradiction, tamper signal, integrity
//     failure, or a canonical Flow run that is still active. This class is deliberately
//     NON-RELEASABLE: goal-fit's `isHardBlock` branch keeps returning exit 2 forever, by
//     design, because "requires a real fix or operator override". It therefore has no
//     termination of its own, and the adapter must supply one.
//
// The adapter cannot tell those apart by reading prose — that would couple every harness
// adapter to one hook's message wording. So goal-fit declares it, on a structured control
// line this module parses and strips before the message ever reaches a model or a human.
//
// ── The control-line contract ────────────────────────────────────────────────────────
//
//   [flow-agents:stop-control] {"v":1,"terminal":true,"code":"non-releasable-hard-block"}
//
// A blocking Stop hook MAY emit one or more such lines anywhere in its stderr. `terminal:true`
// means "this hook will never release this block on its own; it needs a human". Adapters MUST
// strip every control line from the agent-facing and user-facing text. An unparseable or
// absent line degrades to `terminal:false` — the SOFT reading — because wrongly treating a
// soft block as terminal would truncate the valve above, while wrongly treating a hard block
// as soft is still bounded by the consecutive-block backstop below.
//
// ── Why there is a backstop as well as a marker ──────────────────────────────────────
//
// The marker only ends the turn in combination with `stop_hook_active`, the runtime's own
// "this Stop is a continuation of a blocked Stop" signal. That signal is observed in real
// Claude Code payloads but is no longer listed in the published hooks reference, so it cannot
// be the SOLE termination path for the non-releasable class: if a runtime ever stops sending
// it, a hard block would re-prompt the model indefinitely with no human ever seeing it.
//
// `recordStopBlock` is the runtime-agnostic floor under both failure modes. It counts
// CONSECUTIVE blocking Stops per actor per repo and forces the turn to end at
// DEFAULT_MAX_STOP_BLOCKS, whatever the marker or the runtime signal say. The threshold sits
// deliberately ABOVE goal-fit's soft valve (5 > 3) so that on the normal soft path the gate's
// own release always fires first and the backstop is never observable.
//
// Every persistence path is best-effort. A counter that cannot be read or written degrades to
// "never escalates" — the call is still blocked, the reason still reaches the model. Storage
// failure must never suppress a block, only the decision to stop asking.
//
// ── Unresolved actors share one bucket, and that is the right trade HERE ─────────────
//
// An actor that cannot be resolved has no identity to file under, so every unresolved session
// in a repo shares the `unresolved-<digest>` record. Note that workflow-steering.js's
// last-emitted-hash guard deliberately does the OPPOSITE and skips its store entirely for an
// unresolved actor. The two are not inconsistent, because their failure directions are
// opposite: a shared SUPPRESSION bucket silently withholds a directive another session needed
// (information lost, invisibly), whereas a shared ESCALATION bucket can only end a turn sooner
// and put a refusal in front of a human (information surfaced, visibly). Escalating early is
// the safe direction for a last-resort bound, and refusing to count at all would leave the
// unresolved case with no bound whatsoever — which is the failure mode this exists to close.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { flowAgentsArtifactRoot } = require('./local-artifact-paths');
const { sanitizeSegment } = require('./actor-identity');

/**
 * Control-line prefix. stop-goal-fit.js emits this literal (it declares its own copy rather
 * than requiring this module, because that hook ships a byte-identical `context/` mirror whose
 * lib set is a fixed subset). test_goal_fit_hook.sh asserts the two literals match, so a
 * rename here that is not mirrored there fails the suite rather than silently unlatching the
 * hard-block escalation.
 */
const STOP_CONTROL_PREFIX = '[flow-agents:stop-control]';

/** Consecutive blocking Stops after which the adapter ends the turn regardless of any signal. */
const DEFAULT_MAX_STOP_BLOCKS = 5;

/** Operator/test override; a non-positive or invalid value falls back to the default. */
function resolveMaxStopBlocks(env = process.env) {
  const raw = Number.parseInt(env.FLOW_AGENTS_STOP_MAX_BLOCKS || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_STOP_BLOCKS;
}

/**
 * Read every control line out of a hook message.
 *
 * @param {string} message Raw hook stderr.
 * @returns {{terminal: boolean, codes: string[]}} `terminal` is true when ANY control line
 *   declares it. Malformed payloads are ignored (soft reading) rather than throwing.
 */
function parseStopControl(message) {
  const codes = [];
  let terminal = false;
  for (const line of String(message || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(STOP_CONTROL_PREFIX)) continue;
    let payload;
    try {
      payload = JSON.parse(trimmed.slice(STOP_CONTROL_PREFIX.length).trim());
    } catch {
      continue;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    if (payload.terminal === true) terminal = true;
    if (typeof payload.code === 'string' && payload.code) codes.push(payload.code);
  }
  return { terminal, codes };
}

/**
 * Remove every control line. Control lines are machine-to-machine and must never reach the
 * model (`reason`) or the operator (`stopReason`).
 */
function stripStopControl(message) {
  return String(message || '')
    .split('\n')
    .filter(line => !line.trim().startsWith(STOP_CONTROL_PREFIX))
    .join('\n')
    .trim();
}

/** Per-actor consecutive-Stop-block counter, a sibling of `.steering-emission`/`.denial-streak`. */
function stopEscalationFile(cwd, actorKey) {
  const root = flowAgentsArtifactRoot(cwd);
  const name = sanitizeSegment(String(actorKey || 'unresolved')).slice(0, 40) || 'unresolved';
  const digest = crypto.createHash('sha256').update(String(actorKey || 'unresolved')).digest('hex').slice(0, 16);
  return path.join(root, '.stop-escalation', `${name}-${digest}.json`);
}

/**
 * Count one blocking Stop.
 *
 * @returns {{count: number, threshold: number, exhausted: boolean}} `exhausted` is the
 *   backstop verdict. Any storage failure yields `{count: 1, exhausted: false}` — never a
 *   thrown error, and never a changed block decision.
 */
function recordStopBlock({ cwd = process.cwd(), actorKey = '', env = process.env } = {}) {
  const threshold = resolveMaxStopBlocks(env);
  const file = stopEscalationFile(cwd, actorKey);
  let previous = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && Number.isFinite(Number(parsed.count))) previous = Number(parsed.count);
  } catch { /* no record, or unreadable -> start the streak over */ }
  const count = previous + 1;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ count, updated_at: new Date().toISOString() }));
  } catch { /* best effort: an unwritable counter degrades to never escalating */ }
  return { count, threshold, exhausted: count >= threshold };
}

/**
 * Reset the streak. Called when a Stop does NOT block (the obligation cleared) and at every
 * SessionStart (a new session must not inherit the previous one's strikes).
 */
function clearStopBlocks({ cwd = process.cwd(), actorKey = '' } = {}) {
  try {
    fs.rmSync(stopEscalationFile(cwd, actorKey), { force: true });
  } catch { /* best effort */ }
}

/**
 * The whole turn-ending decision for one blocking Stop, as a pure function so both the
 * behaviour and its rationale are testable without a runtime.
 *
 * @param {{terminal: boolean}} control      Parsed control lines.
 * @param {boolean} stopHookActive           Runtime continuation signal.
 * @param {{count: number, threshold: number, exhausted: boolean}} streak Backstop state.
 * @returns {{endTurn: boolean, cause: string|null, note: string|null}}
 */
function stopTurnDecision({ control, stopHookActive, streak }) {
  // Hard block, second contact: the model has had the remediation once and the gate that will
  // never release it still refuses. One retry, then a human.
  if (control && control.terminal && stopHookActive === true) {
    return {
      endTurn: true,
      cause: 'terminal-continuation',
      note: null,
    };
  }
  // Backstop: bounded regardless of marker or runtime signal. Only reachable when a gate's own
  // release valve did not fire — either because the block is non-releasable and the runtime
  // withheld its continuation signal, or because the hook has no valve at all.
  if (streak && streak.exhausted) {
    return {
      endTurn: true,
      cause: 'consecutive-blocks-exhausted',
      note: `[stop-adapter] ending the turn: this Stop gate has blocked ${streak.count} times in a row `
        + `(limit ${streak.threshold}) without releasing. Needs your decision.`,
    };
  }
  // Everything else — every soft block, and a hard block's first contact — hands the reason to
  // the model and lets the turn continue.
  return { endTurn: false, cause: null, note: null };
}

module.exports = {
  STOP_CONTROL_PREFIX,
  DEFAULT_MAX_STOP_BLOCKS,
  resolveMaxStopBlocks,
  parseStopControl,
  stripStopControl,
  stopEscalationFile,
  recordStopBlock,
  clearStopBlocks,
  stopTurnDecision,
};
