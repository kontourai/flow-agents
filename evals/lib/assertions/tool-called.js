// tool-called.js — Assert a specific tool was invoked
// config.tool: string — expected tool name
// Checks telemetry for tool invocations first, falls back to output text matching

const { getToolInvocations, getNewEvents } = require('./telemetry-utils');

const ALIASES = {
  'delegate to a specialist agent': ['delegate to a specialist agent', 'spawn_agent', 'subagent', 'invokesubagents', 'invoke subagents', 'delegate', 'delegat'],
  'run shell commands': ['run shell commands', 'bash', 'shell', 'command', 'running'],
  'todo tool': ['todo tool', 'update_plan', 'todo list', 'todo', 'plan'],
  'write files': ['write files', 'apply_patch', 'edit', 'write', 'create', 'creating file'],
  'read files': ['read files', 'read', 'open', 'reading'],
  'thinking': ['thinking', 'reasoning'],
};

function matchesToolName(actual, expected) {
  const normalized = String(actual || '').toLowerCase();
  const variants = ALIASES[expected] || [expected, expected.replace(/_/g, ' ')];
  return variants.some(v => normalized === v || normalized.includes(v));
}

module.exports = (output, { config }) => {
  const tool = (config.tool || '').toLowerCase();

  // Try telemetry first
  const events = getNewEvents();
  const invocations = getToolInvocations(events);
  if (invocations.some(e => e.tool && e.tool.name && matchesToolName(e.tool.name, tool))) {
    return { pass: true, score: 1, reason: `Telemetry confirms tool '${config.tool}' was invoked` };
  }

  // Fall back to text matching
  const text = (output || '').toLowerCase();
  const variants = ALIASES[tool] || [tool, tool.replace(/_/g, ' ')];
  if (variants.some(v => text.includes(v))) {
    return { pass: true, score: 1, reason: `Tool '${config.tool}' evidence found in output` };
  }
  return { pass: false, score: 0, reason: `Tool '${config.tool}' not found in output or telemetry` };
};
