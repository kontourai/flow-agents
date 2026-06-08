// no-write-tools.js — Assert tool-* subagents didn't invoke write tools
const { getNewEvents, getToolInvocations } = require('./telemetry-utils');

const WRITE_TOOLS = new Set([
  'write files', 'write', 'apply_patch', 'edit',
  '@obsidian/write_note', '@obsidian/patch_note', '@obsidian/update_frontmatter',
  '@obsidian/delete_note', '@obsidian/move_note',
  '@salesforce/create_tech_activity', '@salesforce/update_tech_activity',
  '@sat-outlook/email_send', '@sat-outlook/email_reply', '@sat-outlook/email_draft',
  '@sat-outlook/email_forward', '@sat-outlook/email_move', '@sat-outlook/email_update',
  '@workplace-chat-mcp/post_message', '@workplace-chat-mcp/edit_message',
]);

module.exports = (output) => {
  const events = getNewEvents();
  const toolAgentWrites = getToolInvocations(events).filter(e => {
    const agentName = e.agent && e.agent.name;
    const toolName = e.tool && e.tool.name && String(e.tool.name).toLowerCase();
    return agentName && agentName.startsWith('tool-') && WRITE_TOOLS.has(toolName);
  });

  if (toolAgentWrites.length === 0) {
    return { pass: true, score: 1, reason: 'No write tools invoked by tool-* agents' };
  }
  const violations = toolAgentWrites.map(e => `${e.agent.name} → ${e.tool.name}`);
  return { pass: false, score: 0, reason: `Write tool violations: ${violations.join('; ')}` };
};
