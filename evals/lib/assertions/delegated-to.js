// delegated-to.js — Assert agent delegated to expected subagent(s)
// config.expected: string | string[] — expected agent names
// Checks telemetry for delegation events first, falls back to output text matching

const { getDelegationTargets, getNewEvents } = require('./telemetry-utils');

module.exports = (output, { config }) => {
  const expected = Array.isArray(config.expected) ? config.expected : [config.expected];

  // Try telemetry first
  const events = getNewEvents();
  const telemetryTargets = getDelegationTargets(events);

  if (telemetryTargets.length > 0) {
    const found = expected.filter(e => telemetryTargets.some(t => t.toLowerCase().includes(e.toLowerCase())));
    const missing = expected.filter(e => !telemetryTargets.some(t => t.toLowerCase().includes(e.toLowerCase())));
    if (missing.length === 0) {
      return { pass: true, score: 1, reason: `Telemetry confirms delegation to: ${found.join(', ')}` };
    }
    return {
      pass: false,
      score: found.length / expected.length,
      reason: `Missing delegation to: ${missing.join(', ')}. Telemetry targets: ${telemetryTargets.join(', ')}`,
    };
  }

  // Fall back to text matching
  const text = (output || '').toLowerCase();
  const found = expected.filter(e => text.includes(e.toLowerCase()));
  const missing = expected.filter(e => !text.includes(e.toLowerCase()));

  if (missing.length === 0) {
    return { pass: true, score: 1, reason: `Delegation evidence in output for: ${found.join(', ')}` };
  }
  return {
    pass: false,
    score: found.length / expected.length,
    reason: `Missing delegation to: ${missing.join(', ')}. Found in output: ${found.join(', ') || '(none)'}. No telemetry events found.`,
  };
};
