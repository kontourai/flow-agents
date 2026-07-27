'use strict';
/**
 * policy-record.js — the `kontour.console.policy` record family (#1025).
 *
 * Policy-hook decisions are the highest-value realtime signal the kit produces — a
 * `config-protection` refusal, a `quality-gate` verdict, a `stop-goal-fit` block — and until now
 * they were the only major family with no record and no relay. A gate blocking a write reached
 * Console, if at all, only incidentally as whatever the generic `tool.invoke`/`tool.result`
 * telemetry payload happened to carry. The decision itself — which hook, allow or deny, why — was
 * not observable anywhere but a terminal.
 *
 * EMITTED FROM THE RUNTIME-NEUTRAL SEAM. `run-hook.js` is the one path every runtime's adapter
 * funnels through (claude, codex, opencode, pi), and it is where the decision actually exists as
 * an exit code. Emitting here means one implementation covers every runtime and every future one,
 * instead of four adapters each learning to report. Per #1024, a runtime that does not run a given
 * hook declares that gap in the policy-hook table rather than silently emitting nothing — so a
 * consumer can tell "no policy events" from "that hook does not run here".
 *
 * LOCAL-FIRST. The durable append happens first and always; the console mirror is a detached
 * best-effort afterthought through the shared `record-relay` primitive. Nothing here may block,
 * throw into, or change a hook's decision — a telemetry concern must never be able to turn an
 * allow into a deny.
 */

const fs = require('fs');
const path = require('path');
const { relayRecord } = require('./record-relay');

const SCHEMA = 'kontour.console.policy';
const SCHEMA_VERSION = '0.1';

/** Map a hook runner exit code to the canonical decision vocabulary. */
function decisionFromExitCode(exitCode) {
  if (exitCode === 0) return 'allow';
  if (exitCode === 2) return 'deny';
  return 'error';
}

/**
 * Build one policy record. Pure — no clock, no filesystem, no env reads — so callers and tests can
 * produce a byte-identical record from the same inputs.
 *
 * @param {object} input
 * @param {string} input.hookId       e.g. 'config-protection'
 * @param {string} input.event        the host-native event, e.g. 'PreToolUse' | 'tool_call'
 * @param {string} input.runtime      e.g. 'claude-code' | 'codex' | 'opencode' | 'pi'
 * @param {number} input.exitCode     the hook runner's exit code
 * @param {string} input.at           ISO-8601 timestamp
 * @param {string|null} [input.toolName]
 * @param {string|null} [input.sessionId]
 * @param {string|null} [input.cwd]
 * @returns {object}
 */
function buildPolicyRecord(input) {
  return {
    schema: SCHEMA,
    version: SCHEMA_VERSION,
    type: 'policy.decision',
    at: input.at,
    hook: { id: input.hookId, event: input.event },
    decision: decisionFromExitCode(input.exitCode),
    exit_code: input.exitCode,
    subject: {
      tool_name: input.toolName ?? null,
      cwd: input.cwd ?? null,
    },
    // The same honesty contract the economics records carry: a consumer must be able to tell an
    // unobserved signal from a measured absence. `runtime` names who produced this; a runtime that
    // does not run this hook produces no record at all, and #1024's table is what declares that.
    signals: { runtime: input.runtime ?? null, session_id: input.sessionId ?? null },
  };
}

/** Durable local stream for policy records, a sibling of the liveness stream. */
function policyRecordFile(artifactRoot) {
  return path.join(artifactRoot, 'policy', 'records.jsonl');
}

/**
 * Append a policy record durably, then mirror it best-effort. Never throws.
 *
 * @param {string} artifactRoot  e.g. `<repo>/.kontourai/flow-agents`
 * @param {object} record        from `buildPolicyRecord`
 * @returns {void}
 */
function writePolicyRecord(artifactRoot, record) {
  try {
    const file = policyRecordFile(artifactRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`); // local-first: durable write happens first
  } catch {
    return; // a failed durable write must not trigger a relay of something we did not record
  }
  // scripts/hooks/lib/ -> scripts/policy/relay.sh (same relative layout in dist/* bundles).
  relayRecord('policy', path.join(__dirname, '..', '..', 'policy', 'relay.sh'), record);
}

module.exports = { buildPolicyRecord, writePolicyRecord, policyRecordFile, decisionFromExitCode, SCHEMA, SCHEMA_VERSION };
