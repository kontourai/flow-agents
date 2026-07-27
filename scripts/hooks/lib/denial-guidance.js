'use strict';
// ---------------------------------------------------------------------------
// denial-guidance.js — agent-facing denial MESSAGE shaping (issue #1005, tier 1).
//
// A PreToolUse denial is, in the overwhelming majority of cases, an agent that did not
// know it was not supposed to touch that. The correct response is: refuse the call, name
// the supported form, and let the agent carry on. The message must therefore read as
// RECOVERABLE GUIDANCE ("this call was refused, here is the supported form"), not as an
// INCIDENT REPORT ("a gate was violated").
//
// This module is a pure text transform with NO I/O and NO policy authority. It never
// changes WHAT is blocked, only how the refusal reads. It is applied by the harness
// adapters to every canonical hook denial, so it is deliberately decoupled from any one
// hook's internals: a policy hook keeps owning its own remediation text, and this module
// only strips the incident register that wraps it.
//
// What it removes, and why each is noise rather than guidance:
//
//   1. The `BLOCKED:` opener. It frames an ordinary refusal as a security event. The
//      refusal is already unambiguous from the reason text.
//   2. "Do not disable this hook." / "Never disable this hook to make the write."
//      Repeated once per remedy AND once per detector, so a single denial can carry the
//      warning twice. An agent reading "here is the supported form" does not need to be
//      told twice not to disable a hook; the duplication is what makes the message read
//      as an incident register.
//   3. Advice to disable the hook. `config-protection.js`'s protected-file branch still
//      tells the agent to "disable the config-protection hook temporarily", which
//      directly contradicts that hook's own AC7 ("MUST NEVER advise disabling the
//      config-protection hook"). Stripping it here enforces AC7 centrally, for every
//      hook, instead of relying on each message author to remember it.
//   4. Self-disclosed incomplete-coverage notes ("NOTE: This check has INCOMPLETE
//      COVERAGE — runtime path construction evades it"). That honesty belongs in the
//      code comments where it already lives — it is a note to maintainers about the
//      gate's limits. Shipping it to the agent tells the agent how to evade the gate
//      and tells it nothing about how to do the thing it was actually trying to do.
//
// What it KEEPS, always: every remediation path. The `npm run workflow:sidecar -- ...`
// sanctioned-writer forms, the fixture-authoring affordance, and the read escapes (the
// JSON pretty-print idiom, `render-trust-panel`) are the genuinely useful part of the
// current messages and are preserved verbatim.
// ---------------------------------------------------------------------------

/**
 * Sentences removed from agent-facing denial text. Each entry is anchored on wording that
 * only ever appears in the incident register, never inside a remediation instruction.
 *
 * These are matched against the hook's raw stderr. A pattern that stops matching (because
 * a hook reworded its message) degrades to "the sentence survives" — never to a dropped
 * remediation or a wrongly-allowed call.
 */
const INCIDENT_REGISTER_PATTERNS = [
  // 2. Doubled "never disable this hook" warnings.
  /\s*(?:Do not|Don't|Never)\s+disable\s+th(?:is|e)\s+[a-z-]*\s*hook[^.]*\.\s*/gi,
  // 3. Advice to disable the hook (contradicts config-protection AC7).
  /\s*If this is a legitimate config change,\s*disable the [a-z-]+ hook temporarily\.\s*/gi,
  // 4. Self-disclosed incomplete-coverage notes.
  /\s*NOTE:\s*This check (?:has|covers)[^.]*\.\s*/gi,
];

/** The `BLOCKED:` opener, stripped so the refusal does not read as a security event. */
const BLOCKED_OPENER = /^\s*BLOCKED:\s*/i;

/**
 * Strip the incident register from a raw hook denial message, preserving every
 * remediation path. Whitespace is re-normalised so removed sentences leave no gaps.
 */
function stripIncidentRegister(raw) {
  let text = String(raw || '');
  text = text.replace(BLOCKED_OPENER, '');
  for (const pattern of INCIDENT_REGISTER_PATTERNS) text = text.replace(pattern, ' ');
  return text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

/**
 * The closing line of a first- or second-contact refusal. States plainly that the call —
 * not the turn — ended, which is the whole behavioural contract of issue #1005.
 */
const CONTINUE_LINE =
  'This refused the tool call, not your turn. Use a supported form above (or a different approach) and keep going.';

/**
 * The closing line of an escalated refusal (tier 2 third strike). At this point the agent
 * has been told the same thing three times inside one flow step, so continuing is no
 * longer ignorance and a human should see it.
 */
function escalationLine(decision) {
  const { count, threshold, ruleId, target } = decision || {};
  const where = target ? ` on ${target}` : '';
  return `Escalating: the same refusal (${ruleId}${where}) has now happened ${count} times in this flow step ` +
    `(limit ${threshold}). Stopping so a human can decide, rather than refusing a fourth time.`;
}

/**
 * Shape a raw hook denial message into the agent-facing text.
 *
 * @param {string} raw        The hook's own stderr (its remediation text plus incident register).
 * @param {object} [decision] Escalation decision from denial-escalation.js. When
 *                            `decision.escalate` is true the closing line reports the
 *                            escalation instead of inviting the agent to continue.
 * @returns {string} Agent-facing refusal text.
 */
function shapeDenialMessage(raw, decision) {
  const body = stripIncidentRegister(raw);
  const lead = body ? `Refused: ${body}` : 'Refused by Flow Agents hook policy.';
  const closing = decision && decision.escalate ? escalationLine(decision) : CONTINUE_LINE;
  return `${lead}\n${closing}`;
}

module.exports = {
  INCIDENT_REGISTER_PATTERNS,
  CONTINUE_LINE,
  stripIncidentRegister,
  shapeDenialMessage,
};
