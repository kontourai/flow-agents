// max-tool-calls.js — Assert total tool invocations don't exceed a threshold
// config.max: number — maximum allowed tool calls
// config.exclude: string[] (optional) — tool names to exclude from count (e.g. ['thinking'])
const { getNewEvents, getToolInvocations } = require('./telemetry-utils');

module.exports = (output, { config }) => {
  const exclude = new Set(config.exclude || []);
  const tools = getToolInvocations(getNewEvents())
    .map(e => e.tool && e.tool.name)
    .filter(name => name && !exclude.has(name));
  if (tools.length <= config.max) {
    return { pass: true, score: 1, reason: `${tools.length} tool calls (max ${config.max}). Sequence: ${tools.join(' → ')}` };
  }
  return { pass: false, score: 0, reason: `${tools.length} tool calls exceeded max ${config.max}. Sequence: ${tools.join(' → ')}` };
};
