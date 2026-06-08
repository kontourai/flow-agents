// verify-after-fix.js — Assert that any code change during review/verify is followed by a clean verification pass
const { getNewEvents, filterByType, getToolInvocations, getSubagentCalls } = require('./telemetry-utils');

const WRITE_TOOLS = new Set(['write files', 'write', 'apply_patch', 'edit']);
const REVIEW_AGENTS = new Set(['tool-code-reviewer', 'tool-security-reviewer']);
const VERIFY_AGENTS = new Set(['tool-verifier', 'tool-playwright']);
const REPORTER_AGENTS = new Set([...REVIEW_AGENTS, ...VERIFY_AGENTS]);

module.exports = (output, { config }) => {
  const events = getNewEvents();
  const toolEvents = getToolInvocations(events);
  const subagentCalls = getSubagentCalls(events);
  const violations = [];

  // Check 1: Reviewers/verifiers must never invoke write tools
  const reporterWrites = toolEvents.filter(e => {
    const agent = e.agent && e.agent.name;
    const tool = e.tool && e.tool.name && String(e.tool.name).toLowerCase();
    return agent && REPORTER_AGENTS.has(agent) && WRITE_TOOLS.has(tool);
  });

  if (reporterWrites.length > 0) {
    violations.push(
      `Reporter agents wrote code: ${reporterWrites.map(e => `${e.agent.name} → ${e.tool.name}`).join('; ')}`
    );
  }

  // Check 2: After any write tool call, there must be a subsequent tool-verifier delegation
  const allEvents = events;
  let lastWriteIdx = -1;
  let lastVerifyIdx = -1;

  for (let i = 0; i < allEvents.length; i++) {
    const e = allEvents[i];
    const toolName = e.tool && e.tool.name && String(e.tool.name).toLowerCase();
    if (e.event_type === 'tool.invoke' && e.tool && WRITE_TOOLS.has(toolName)) {
      lastWriteIdx = i;
    }
    if (e.event_type === 'tool.invoke' && e.tool && toolName === 'delegate to a specialist agent' &&
        e.tool.input && e.tool.input.command === 'InvokeSubagents') {
      const subs = e.tool.input.content && e.tool.input.content.subagents;
      if (subs && subs.some(s => s.agent_name === 'tool-verifier')) {
        lastVerifyIdx = i;
      }
    }
    if (e.event_type === 'tool.invoke' && e.tool && toolName === 'spawn_agent' &&
        e.tool.input && e.tool.input.agent_type === 'tool-verifier') {
      lastVerifyIdx = i;
    }
  }

  if (lastWriteIdx > lastVerifyIdx) {
    violations.push('Code was written after the last verification pass — missing re-verify');
  }

  if (violations.length === 0) {
    return { pass: true, score: 1, reason: 'No code changes without subsequent verification' };
  }

  return { pass: false, score: 0, reason: `Re-verify violations: ${violations.join('; ')}` };
};
