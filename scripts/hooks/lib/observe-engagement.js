'use strict';
/**
 * observe-engagement.js — the observe-mode engagement check (docs/decisions/observe-mode.md).
 *
 * Observe mode only works where a Stop hook both runs and can hold the agent. This module answers
 * two questions loudly at session start (workflow-steering) and in `flow-agents observe status`:
 * is the current run in observe mode, and can THIS host block Stop. The host table mirrors the
 * decision record's per-host table; it states what Flow Agents wires today, not what a host could
 * do if wired.
 */

const fs = require('fs');
const path = require('path');
const { detectRuntime } = require('./actor-identity.js');

const HOST_STOP = Object.freeze({
  'claude-code': { blocks: true, note: 'Stop blocks; the reminder reaches the model' },
  codex: { blocks: true, note: 'Stop blocks; no adapter turn-ending path, so the reminder cap is the bound' },
  kiro: { blocks: true, note: 'Stop blocks but its hook timeout is 5 s: run checks with `flow-agents observe verify`' },
  opencode: { blocks: false, note: 'session.idle is advisory: reminders are shown, nothing holds the agent' },
  pi: { blocks: false, note: 'no stop hook: observe mode is unavailable' },
});

/** The host this hook runs under. Adapters stamp FLOW_AGENTS_HOOK_RUNTIME; otherwise detect. */
function hostRuntime(env = process.env) {
  const stamped = String(env.FLOW_AGENTS_HOOK_RUNTIME || '').trim();
  if (stamped) return stamped;
  return detectRuntime(env);
}

function hostStopCapability(runtime) {
  return HOST_STOP[runtime] || { blocks: null, note: 'unknown host: Flow Agents does not know whether a Stop hook runs here' };
}

/** True when the canonical run for `slug` pins a definition that declares observe semantics. */
function runIsObserved(projectRoot, slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug || ''))) return false;
  try {
    const definition = JSON.parse(fs.readFileSync(path.join(projectRoot, '.kontourai', 'flow', 'runs', slug, 'definition.json'), 'utf8'));
    return Boolean(definition && definition.evidence_mode === 'observed');
  } catch {
    return false;
  }
}

/** The one-line engagement report. Loud by design: a silent observe mode is a broken one. */
function engagementReport(runtime, observed) {
  const capability = hostStopCapability(runtime);
  if (!observed) return null;
  const status = capability.blocks === true ? 'ENFORCED' : capability.blocks === false ? 'ADVISORY ONLY' : 'UNVERIFIED';
  return `OBSERVE MODE: active (${status} on ${runtime}: ${capability.note}). Write the plan and acceptance.json, work freely, commit; the Stop hook reminds you of anything unmet. Record only the distinct-reviewer critique.`;
}

module.exports = { HOST_STOP, hostRuntime, hostStopCapability, runIsObserved, engagementReport };
