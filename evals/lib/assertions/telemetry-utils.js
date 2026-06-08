// telemetry-utils.js — Read telemetry JSONL and extract events for the current eval run
const fs = require('fs');
const path = require('path');

const SNAPSHOT_FILE = process.env.FLOW_AGENTS_EVAL_TELEMETRY_SNAPSHOT || '/tmp/promptfoo-eval-telemetry-snapshot.txt';

const TELEMETRY_FILE = (() => {
  if (process.env.FLOW_AGENTS_EVAL_TELEMETRY_FILE) {
    return process.env.FLOW_AGENTS_EVAL_TELEMETRY_FILE;
  }

  const marker = process.env.FLOW_AGENTS_EVAL_TELEMETRY_FILE_MARKER || '/tmp/promptfoo-eval-telemetry-file.txt';
  try {
    const markedPath = fs.readFileSync(marker, 'utf8').trim();
    if (markedPath) return markedPath;
  } catch {}

  const agent = process.env.FLOW_AGENTS_EVAL_AGENT || process.env.KIRO_EVAL_AGENT || 'dev';
  const agentsDir = path.join(process.env.HOME, '.kiro/agents');
  try {
    const files = fs.readdirSync(agentsDir).filter(f => f.endsWith(`-${agent}.json`));
    for (const f of files) {
      const content = fs.readFileSync(path.join(agentsDir, f), 'utf8');
      const match = content.match(new RegExp(`${process.env.HOME}/.flow-agents/[^"]+`));
      if (match) {
        const pkgPath = match[0].replace(/\/context\/.*/, '');
        const telPath = path.join(pkgPath, '.telemetry/full.jsonl');
        if (fs.existsSync(telPath)) return telPath;
      }
    }
  } catch {}
  return path.join(process.env.HOME, '.flow-agents/.telemetry/full.jsonl');
})();

function currentAgent() {
  return process.env.FLOW_AGENTS_EVAL_AGENT || process.env.KIRO_EVAL_AGENT;
}

function getNewEvents() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return [];
  if (!fs.existsSync(TELEMETRY_FILE)) return [];

  const snapshotLine = parseInt(fs.readFileSync(SNAPSHOT_FILE, 'utf8').trim(), 10);
  if (isNaN(snapshotLine) || snapshotLine < 0) return [];

  const raw = fs.readFileSync(TELEMETRY_FILE, 'utf8').trim();
  if (!raw) return [];
  const lines = raw.split('\n');
  return lines.slice(snapshotLine).reduce((acc, line) => {
    try { acc.push(JSON.parse(line)); } catch {}
    return acc;
  }, []);
}

function filterByType(events, type) {
  return events.filter(e => e.event_type === type);
}

function getToolInvocations(events) {
  const agent = currentAgent();
  return filterByType(events, 'tool.invoke').filter(
    e => !agent || (e.agent && e.agent.name === agent)
  );
}

function isDelegationTool(tool) {
  if (!tool || !tool.name) return false;
  const name = String(tool.name).toLowerCase();
  if (name === 'spawn_agent') return true;
  return name === 'delegate to a specialist agent' && tool.input && tool.input.command === 'InvokeSubagents';
}

function getSubagentCalls(events) {
  const agent = currentAgent();
  return getToolInvocations(events).filter(
    e => e.tool && isDelegationTool(e.tool)
      && (!agent || (e.agent && e.agent.name === agent))
  );
}

function getDelegationTargets(events) {
  const explicitDelegations = filterByType(events, 'agent.delegate').flatMap(e => {
    const targets = [];
    if (e.agent && e.agent.target) targets.push(e.agent.target);
    if (e.agent && e.agent.delegate_to) targets.push(e.agent.delegate_to);
    if (e.delegate && e.delegate.target) targets.push(e.delegate.target);
    if (e.subagent && e.subagent.name) targets.push(e.subagent.name);
    return targets.filter(Boolean);
  });

  const toolDelegations = getSubagentCalls(events).flatMap(e => {
    const input = e.tool.input || {};
    const content = input.content || {};
    const subs = content.subagents || [];
    const targets = subs.map(s => s.agent_name || s.name).filter(Boolean);
    for (const key of ['agent_type', 'target', 'agent', 'name']) {
      if (input[key]) targets.push(input[key]);
    }
    return targets;
  });

  return [...explicitDelegations, ...toolDelegations];
}

module.exports = { getNewEvents, filterByType, getToolInvocations, getSubagentCalls, getDelegationTargets };
