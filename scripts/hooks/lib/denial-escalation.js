'use strict';
// ---------------------------------------------------------------------------
// denial-escalation.js — per-flow-step denial counter (issue #1005, tier 2).
//
// Policy: a denied tool call ends THE CALL, not THE TURN — always, by default. The same
// denial three times inside one flow step is the signal that separates "didn't know" from
// "keeps pushing", and only then does the refusal escalate to a human.
//
// ── Why the counter keys on denial IDENTITY, never on raw command text ───────────────
//
// The legitimate route-around usually IS a different command. An agent told "writing to
// state.json is refused, use `workflow:sidecar -- advance-state`" complies by issuing a
// completely different command; an agent told "that temp filename contains a protected
// token" complies by renaming the file. Keying the counter on command text would count
// those compliant retries as strikes — penalising the exact behaviour the policy is
// trying to produce — while an agent that merely rephrases the SAME forbidden write
// would reset its counter every time. Text keying is therefore backwards on both sides.
//
// The counter instead keys on `<ruleId>::<resolvedTarget>`:
//   • ruleId          — WHICH policy rule refused (e.g. config-protection.interpreter-write).
//   • resolvedTarget  — the protected thing the rule resolved the call down to
//                       (e.g. `.claude/settings.json`), NOT the command that named it.
//
// So two different interpreter flags aimed at the same protected settings file are the SAME
// identity (same rule, same resolved file — that is hammering), while switching to the
// sanctioned writer produces no denial at all, and hitting a genuinely different rule
// starts its own independent count from one.
//
// Open design point, deliberately left at the narrower reading: the issue's maintainer
// comment leans toward treating a DIFFERENT file under the SAME rule as the same reason
// ("the agent failing to absorb the rule"). This implementation keys on rule + target, so
// two different protected files under one rule count separately. `ruleTotals` is persisted
// alongside the identity counts so that choice can be revisited against real data rather
// than argued; nothing reads `ruleTotals` for an escalation decision today.
//
// ── Scope and reset ──────────────────────────────────────────────────────────────────
//
// Counts are scoped to the current flow step and reset on step transition, so a long
// delivery never accumulates strikes across unrelated steps. The step identity comes from
// the existing per-actor current pointer (`active_flow_id` / `active_step_id`) — the same
// state `resolveActiveFlowStep` reads — with the artifact-dir + phase pair as the fallback
// for sessions that are not running a FlowDefinition.
//
// ── Storage ──────────────────────────────────────────────────────────────────────────
//
// State lives beside the existing goal-fit block streak, under the repo's
// `.kontourai/flow-agents` artifact root, one file per actor. This is the store the repo
// already uses for exactly this shape of state (a per-run escalation streak); no new store
// is introduced. Every read and write is best-effort: a counter that cannot be persisted
// degrades to "never escalates", which is the safe direction — the call is still refused,
// the turn still continues.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { flowAgentsArtifactRoot } = require('./local-artifact-paths');
const { sanitizeSegment } = require('./actor-identity');
const { readCurrentPointer } = require('./current-pointer');
const { shapeDenialMessage } = require('./denial-guidance');

/** Third occurrence of the same identity in one flow step escalates. */
const DEFAULT_MAX_REPEATS = 3;

/** Override for tests and operators; a non-positive/invalid value falls back to the default. */
function resolveMaxRepeats(env = process.env) {
  const raw = Number.parseInt(env.FLOW_AGENTS_DENIAL_MAX_REPEATS || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_REPEATS;
}

// ---------------------------------------------------------------------------
// Denial identity
// ---------------------------------------------------------------------------

/**
 * Rule catalogue: maps a hook's denial text onto a stable rule id.
 *
 * Matching is on the rule's OWN framing sentence (the part a policy author writes once
 * per detector), never on the offending command. `target` extracts whatever the detector
 * already resolved the call down to.
 *
 * Adding a rule here is optional: an unmatched denial still gets a stable identity from
 * `fallbackIdentity`. This table only makes the identity legible in escalation messages
 * and in the persisted record.
 */
const RULE_MATCHERS = [
  {
    ruleId: 'config-protection.protected-file',
    test: /^Modifying (.+?) is not allowed\./,
  },
  {
    ruleId: 'config-protection.protected-path',
    test: /^Writing to (.+?) is not allowed\./,
  },
  {
    ruleId: 'config-protection.git-verification-bypass',
    test: /^"(.+?)" bypasses git verification hooks\./,
  },
  {
    ruleId: 'config-protection.shell-redirect',
    test: /^Detected (.+?) targeting a protected gate kill-switch file\./,
  },
  {
    // Interpreter-write and copy/move share the "Detected <x> in a Bash command." opener,
    // so they are disambiguated on the sentence that follows.
    ruleId: 'config-protection.interpreter-write',
    test: /^Detected (.+?) in a Bash command\./,
    requires: /Interpreter invocations/,
  },
  {
    ruleId: 'config-protection.copy-move',
    test: /^Detected (.+?) in a Bash command\./,
    requires: /cp\/mv\/install/,
  },
  {
    ruleId: 'config-protection.input-truncated',
    test: /^Hook input exceeded/,
  },
  {
    ruleId: 'report-only-guard.write-refused',
    test: /^This agent is report-only/,
  },
];

/**
 * Reduce a detector's description down to the thing it actually resolved.
 *
 * Detector strings embed the resolved protected path in a small number of shapes:
 *   `<interpreter flag> with protected path token "<config file>"` → the quoted token
 *   `shell redirect (>) to /repo/.kontourai/.../state.json`     → after " to "
 *   `cp x into delivery (delivery-protected destination)`       → after " into "
 * Anything else is kept whole — it is still the detector's own resolution, not the command.
 *
 * The point of this narrowing is that it collapses interchangeable spellings of the same
 * offence (two interpreter flags against one file) onto ONE identity, so swapping
 * interpreters does not reset the strike count.
 */
function resolveTarget(detail) {
  const text = String(detail || '').trim();
  if (!text) return '';
  const quoted = text.match(/"([^"]+)"\s*$/);
  if (quoted) return quoted[1];
  const preposition = text.match(/\s(?:to|into)\s+(\S+)/);
  if (preposition) return preposition[1];
  return text;
}

/**
 * Stable identity for an unrecognised denial.
 *
 * Variable spans (quoted strings, path-shaped tokens, numbers) are replaced with
 * placeholders before hashing, so the id tracks the RULE's skeleton rather than the
 * particular call — a text-keyed counter by another name is exactly what this must not be.
 */
function fallbackIdentity(hookId, message) {
  const skeleton = String(message || '')
    .replace(/"[^"]*"/g, '"~"')
    .replace(/\S*[/\\]\S*/g, '~')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  const digest = crypto.createHash('sha256').update(skeleton).digest('hex').slice(0, 12);
  return { ruleId: `${hookId || 'hook'}.unclassified-${digest}`, target: '' };
}

/**
 * Derive `{ ruleId, target, key }` for a denial.
 *
 * @param {string} hookId  Canonical hook id (e.g. "config-protection").
 * @param {string} message The hook's raw stderr, incident register included.
 */
function denialIdentity(hookId, message) {
  // The rule catalogue matches post-`BLOCKED:` framing, so the opener is dropped first.
  const text = String(message || '').replace(/^\s*BLOCKED:\s*/i, '').trim();
  let identity = null;
  for (const rule of RULE_MATCHERS) {
    const match = text.match(rule.test);
    if (!match) continue;
    if (rule.requires && !rule.requires.test(text)) continue;
    identity = { ruleId: rule.ruleId, target: resolveTarget(match[1] || '') };
    break;
  }
  if (!identity) identity = fallbackIdentity(hookId, text);
  return { ...identity, key: `${identity.ruleId}::${identity.target}` };
}

// ---------------------------------------------------------------------------
// Flow-step scope
// ---------------------------------------------------------------------------

/**
 * Identity of the flow step the counter is scoped to.
 *
 * Reads the existing per-actor current pointer rather than introducing a second notion of
 * "where we are": `active_flow_id`/`active_step_id` when a FlowDefinition is running, else
 * the artifact dir + lifecycle phase, else a constant so counting still works outside any
 * flow (an agent hammering one rule in a bare session is still worth escalating).
 */
function resolveFlowStepKey(cwd, actorKey) {
  try {
    const flowAgentsDir = flowAgentsArtifactRoot(cwd);
    const pointer = readCurrentPointer(flowAgentsDir, actorKey);
    const payload = pointer && pointer.payload;
    if (payload) {
      if (typeof payload.active_flow_id === 'string' && typeof payload.active_step_id === 'string') {
        return `${payload.active_flow_id}/${payload.active_step_id}`;
      }
      const dir = typeof payload.artifact_dir === 'string' ? payload.artifact_dir : '';
      const phase = typeof payload.phase === 'string' ? payload.phase : '';
      if (dir || phase) return `${dir}#${phase}`;
    }
  } catch { /* fail-open: an unreadable pointer must never block a call */ }
  return 'no-active-step';
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Per-actor streak file, beside the existing `.goal-fit-block-streak.json`. */
function denialStreakFile(cwd, actorKey) {
  const root = flowAgentsArtifactRoot(cwd);
  const name = sanitizeSegment(String(actorKey || 'unresolved')).slice(0, 40) || 'unresolved';
  const digest = crypto.createHash('sha256').update(String(actorKey || 'unresolved')).digest('hex').slice(0, 16);
  return path.join(root, '.denial-streak', `${name}-${digest}.json`);
}

function readStreak(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Record one denial and return the escalation decision.
 *
 * Counts reset wholesale when the flow step changes — a fresh step starts every identity
 * at zero, which is the "reset on step transition" half of the policy.
 *
 * @returns {{ruleId,target,key,stepKey,count,threshold,escalate}}
 */
function recordDenial({ hookId, message, cwd = process.cwd(), actorKey = '', env = process.env } = {}) {
  const identity = denialIdentity(hookId, message);
  const stepKey = resolveFlowStepKey(cwd, actorKey);
  const threshold = resolveMaxRepeats(env);
  const file = denialStreakFile(cwd, actorKey);

  const prev = readStreak(file);
  const sameStep = prev && prev.step === stepKey;
  const counts = sameStep && prev.counts && typeof prev.counts === 'object' ? { ...prev.counts } : {};
  const ruleTotals = sameStep && prev.rule_totals && typeof prev.rule_totals === 'object' ? { ...prev.rule_totals } : {};

  const count = (Number(counts[identity.key]) || 0) + 1;
  counts[identity.key] = count;
  ruleTotals[identity.ruleId] = (Number(ruleTotals[identity.ruleId]) || 0) + 1;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      step: stepKey,
      counts,
      rule_totals: ruleTotals,
      updated_at: new Date().toISOString(),
    }));
  } catch { /* best effort: an unwritable counter degrades to never escalating */ }

  return { ...identity, stepKey, count, threshold, escalate: count >= threshold };
}

/**
 * One-call entry point for harness adapters: record the denial and shape the message.
 *
 * Returns the agent-facing `message` and the `escalate` flag. Only an escalating denial
 * may end the turn; every earlier denial is an ordinary refused call the agent reasons
 * past, exactly like a non-zero exit code or a 404.
 */
function buildDenialResponse({ hookId, message, cwd, actorKey, env } = {}) {
  let decision;
  try {
    decision = recordDenial({ hookId, message, cwd, actorKey, env });
  } catch {
    // Never let counter machinery change what is blocked or turn a refusal into a halt.
    decision = { escalate: false };
  }
  return { message: shapeDenialMessage(message, decision), escalate: Boolean(decision.escalate), decision };
}

module.exports = {
  DEFAULT_MAX_REPEATS,
  RULE_MATCHERS,
  resolveMaxRepeats,
  resolveTarget,
  denialIdentity,
  resolveFlowStepKey,
  denialStreakFile,
  recordDenial,
  buildDenialResponse,
};
