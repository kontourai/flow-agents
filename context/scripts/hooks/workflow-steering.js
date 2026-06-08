#!/usr/bin/env node
/**
 * Workflow Steering Hook
 *
 * Injects phase-transition reminders after use_subagent calls complete.
 * Detects which agent was delegated to and returns the appropriate
 * next-step guidance as tool output the orchestrator sees immediately.
 *
 * Non-blocking — always exits 0.
 */

'use strict';

const STEERING = {
  'tool-planner': [
    '⚡ PLAN COMPLETE — Next: execute-plan (step 3).',
    'Present plan to user. Get approval before executing.',
  ].join(' '),

  'tool-worker': [
    '⚡ EXECUTION COMPLETE — Next: review (step 4) then verify (step 5).',
    'Delegate to review-work for critique (report only — it cannot fix code).',
    'Then delegate to verify-work for evidence (report only — it cannot fix code).',
    'Do NOT deliver until review + verify are both clean.',
    'If this was a VISUAL change (UI, CSS, HTML), you MUST delegate to tool-playwright for screenshot verification before delivering.',
  ].join(' '),

  'tool-code-reviewer': [
    '⚡ REVIEW COMPLETE — Next: verify (step 5).',
    'Reviewer reported findings only — it did NOT fix anything.',
    'If CRITICAL/HIGH findings: route back to execute-plan, then re-review + re-verify.',
    'If clean: proceed to verify-work. If findings exist, route back through execute-plan or a user decision.',
  ].join(' '),

  'tool-security-reviewer': [
    '⚡ SECURITY REVIEW COMPLETE — Check findings.',
    'If CRITICAL security findings: route back to execute-plan, then re-review + re-verify.',
    'If clean: proceed to next step.',
  ].join(' '),

  'tool-verifier': [
    '⚡ VERIFICATION COMPLETE — Route on verdict.',
    'All PASS + no review issues → deliver.',
    'Any FAIL or unfixed findings → route back to execute-plan, then re-review + re-verify.',
    'Loop exits ONLY when review + verify are BOTH clean in the same iteration.',
  ].join(' '),
};

function run(rawInput) {
  try {
    const input = JSON.parse(rawInput);
    const toolOutput = input.tool_response || input.tool_output || '';
    const toolInput = input.tool_input || {};

    // Only fire on use_subagent InvokeSubagents results
    if (toolInput.command !== 'InvokeSubagents') return rawInput;

    const subagents = toolInput.content?.subagents || [];
    const hints = subagents
      .map(s => STEERING[s.agent_name])
      .filter(Boolean);

    if (hints.length === 0) return rawInput;

    // Append steering to the tool output
    const steering = '\n\n---\n' + hints.join('\n') + '\n---';
    return rawInput + steering;
  } catch { /* pass through */ }
  return rawInput;
}

module.exports = { run };
