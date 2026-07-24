#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_AGENT_EVENTS_BYTES = 4 * 1024 * 1024;

function incomplete(reason) {
  return {
    run_correlation: {
      status: 'incomplete',
      reason,
    },
  };
}

function packageRoot() {
  let candidate = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    if (
      fs.existsSync(path.join(candidate, 'build', 'src', 'run-correlation.js'))
      && fs.existsSync(path.join(candidate, 'scripts', 'hooks', 'lib', 'actor-identity.js'))
    ) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error('installed correlation contract is unavailable');
}

async function correlationContract() {
  const modulePath = path.join(ROOT, 'build', 'src', 'run-correlation.js');
  return import(pathToFileURL(modulePath).href);
}

async function builderProjectionContract() {
  const modulePath = path.join(ROOT, 'build', 'src', 'builder-flow-runtime.js');
  return import(pathToFileURL(modulePath).href);
}

const ROOT = packageRoot();
const actorIdentity = require(path.join(ROOT, 'scripts', 'hooks', 'lib', 'actor-identity.js'));
const currentPointer = require(path.join(ROOT, 'scripts', 'hooks', 'lib', 'current-pointer.js'));
const { flowAgentsArtifactRoot } = require(path.join(ROOT, 'scripts', 'hooks', 'lib', 'local-artifact-paths.js'));

function safeTaskDirectory(artifactRoot, relativeDir) {
  if (
    typeof relativeDir !== 'string'
    || !relativeDir
    || path.isAbsolute(relativeDir)
    || relativeDir.split(/[\\/]/).includes('..')
  ) {
    return null;
  }
  try {
    const realRoot = fs.realpathSync(artifactRoot);
    const candidate = path.resolve(realRoot, relativeDir);
    const realTask = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realTask);
    if (!relative || relative === '.' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return null;
    }
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realTask !== candidate) return null;
    return { path: realTask, dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function taskDirectoryUnchanged(task) {
  try {
    const stat = fs.lstatSync(task.path);
    return !stat.isSymbolicLink()
      && stat.isDirectory()
      && stat.dev === task.dev
      && stat.ino === task.ino;
  } catch {
    return false;
  }
}

function readStableText(file, directory, maxBytes = MAX_STATE_BYTES) {
  let descriptor;
  try {
    const resolved = path.resolve(file);
    if (path.dirname(resolved) !== directory.path || !taskDirectoryUnchanged(directory)) return null;
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes) return null;
    const raw = fs.readFileSync(descriptor, 'utf8');
    const named = fs.lstatSync(resolved);
    if (
      named.isSymbolicLink()
      || !named.isFile()
      || named.dev !== opened.dev
      || named.ino !== opened.ino
      || !taskDirectoryUnchanged(directory)
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readStableJson(file, directory) {
  const raw = readStableText(file, directory);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readStableAgentEvents(task) {
  const agentsDir = safeTaskDirectory(task.path, 'agents');
  if (!agentsDir) return [];
  const events = [];
  let totalBytes = 0;
  let names;
  try {
    names = fs.readdirSync(agentsDir.path);
  } catch {
    return [];
  }
  for (const name of names.sort()) {
    const agentDir = safeTaskDirectory(agentsDir.path, name);
    if (!agentDir) continue;
    const raw = readStableText(
      path.join(agentDir.path, 'events.jsonl'),
      agentDir,
      MAX_AGENT_EVENTS_BYTES - totalBytes,
    );
    if (raw === null) continue;
    totalBytes += Buffer.byteLength(raw);
    if (totalBytes > MAX_AGENT_EVENTS_BYTES) return [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed);
      } catch {
        return [];
      }
    }
    if (!taskDirectoryUnchanged(agentsDir) || !taskDirectoryUnchanged(task)) return [];
  }
  return events;
}

function pointerMatches(left, right) {
  return Boolean(
    left
    && right
    && left.source === 'per-actor'
    && right.source === 'per-actor'
    && left.payload
    && right.payload
    && JSON.stringify(left.payload) === JSON.stringify(right.payload)
  );
}

async function resolveTelemetryRunBinding({
  cwd,
  env = process.env,
  includeSidecars = false,
  terminalCapture = false,
} = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return incomplete('the runtime event did not provide a workspace');
  }

  let workspace;
  try {
    workspace = fs.realpathSync(cwd);
    if (!fs.lstatSync(workspace).isDirectory()) {
      return incomplete('the runtime event workspace is unavailable');
    }
  } catch {
    return incomplete('the runtime event workspace is unavailable');
  }

  const resolvedActor = actorIdentity.resolveActorIdentity(env);
  if (actorIdentity.isUnresolvedActor(resolvedActor.actor) || !resolvedActor.actorStruct) {
    return incomplete('the runtime actor identity is unavailable');
  }

  const artifactRoot = flowAgentsArtifactRoot(workspace);
  const readPointer = terminalCapture
    ? currentPointer.readOwnCurrentPointerRecord
    : currentPointer.readOwnCurrentPointer;
  const discovered = readPointer(artifactRoot, resolvedActor.actor);
  const discoveredPointer = discovered.payload;
  if (
    discovered.source !== 'per-actor'
    || !discoveredPointer
  ) {
    return incomplete('no authenticated Builder run is bound to this runtime session');
  }
  if (
    typeof discoveredPointer.binding_id !== 'string'
    || typeof discoveredPointer.active_slug !== 'string'
    || typeof discoveredPointer.artifact_dir !== 'string'
    || discoveredPointer.active_slug !== path.basename(discoveredPointer.artifact_dir)
  ) {
    return incomplete('the authenticated Builder binding is invalid');
  }

  const discoveredTaskDir = safeTaskDirectory(artifactRoot, discoveredPointer.artifact_dir);
  if (!discoveredTaskDir) return incomplete('the authenticated Builder binding is invalid');
  try {
    const { withBuilderFlowProjectionCurrent } = await builderProjectionContract();
    return await withBuilderFlowProjectionCurrent({ sessionDir: discoveredTaskDir.path }, async () => {
      const before = readPointer(artifactRoot, resolvedActor.actor);
      const pointer = before.payload;
      if (before.source !== 'per-actor' || !pointer) {
        return incomplete('no authenticated Builder run is bound to this runtime session');
      }
      const retiredTerminalCapture = pointer.binding_status === 'retired';
      if (retiredTerminalCapture && !terminalCapture) {
        return incomplete('no authenticated Builder run is bound to this runtime session');
      }
      if (
        typeof pointer.binding_id !== 'string'
        || typeof pointer.active_slug !== 'string'
        || typeof pointer.artifact_dir !== 'string'
        || pointer.active_slug !== path.basename(pointer.artifact_dir)
        || pointer.active_slug !== discoveredPointer.active_slug
      ) {
        return incomplete('the authenticated Builder binding changed during telemetry capture');
      }

      const taskDir = safeTaskDirectory(artifactRoot, pointer.artifact_dir);
      if (!taskDir || taskDir.path !== discoveredTaskDir.path) {
        return incomplete('the authenticated Builder binding changed during telemetry capture');
      }
      const state = readStableJson(path.join(taskDir.path, 'state.json'), taskDir);
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return incomplete('the bound Builder correlation could not be validated');
      }

      try {
        const { validateRunCorrelationPresence } = await correlationContract();
        const presence = validateRunCorrelationPresence(state.run_correlation);
        if (presence.status !== 'present') {
          return incomplete('the bound Builder run has incomplete correlation');
        }
        const envelope = presence.envelope;
        const identities = envelope.identities;
        const flowStatus = state.flow_run && typeof state.flow_run === 'object'
          ? state.flow_run.status
          : null;
        if (
          retiredTerminalCapture
          && (
            !['completed', 'canceled', 'failed', 'archived'].includes(flowStatus)
            || pointer.binding_reason !== `flow_${flowStatus}`
          )
        ) {
          return incomplete('the retired Builder binding is not a validated terminal handoff');
        }
        if (
          envelope.correlation_id !== pointer.binding_id
          || identities.flow_run.status !== 'present'
          || identities.flow_run.value !== pointer.active_slug
          || identities.agent.status !== 'present'
          || identities.agent.value !== resolvedActor.actor
          || typeof state.task_slug !== 'string'
          || state.task_slug !== pointer.active_slug
          || !state.flow_run
          || typeof state.flow_run !== 'object'
          || Array.isArray(state.flow_run)
          || state.flow_run.run_id !== pointer.active_slug
          || !Array.isArray(state.work_item_refs)
          || state.work_item_refs.length === 0
          || identities.work_item.status !== 'present'
          || !state.work_item_refs.includes(identities.work_item.value)
          || (
            identities.runtime_session.status === 'present'
            && identities.runtime_session.value !== resolvedActor.actorStruct.session_id
          )
        ) {
          return incomplete('the bound Builder correlation does not match its authenticated runtime binding');
        }

        const sidecars = includeSidecars
          ? {
              state,
              acceptance: readStableJson(path.join(taskDir.path, 'acceptance.json'), taskDir),
              critique: readStableJson(path.join(taskDir.path, 'critique.json'), taskDir),
              agent_events: readStableAgentEvents(taskDir).filter(
                (event) => event && JSON.stringify(event.run_correlation) === JSON.stringify(envelope),
              ),
            }
          : undefined;
        const after = readPointer(artifactRoot, resolvedActor.actor);
        if (!pointerMatches(before, after)) {
          return incomplete('the authenticated Builder binding changed during telemetry capture');
        }
        if (!taskDirectoryUnchanged(taskDir)) {
          return incomplete('the authenticated Builder binding changed during telemetry capture');
        }
        return {
          run_correlation: envelope,
          task_slug: pointer.active_slug,
          ...(sidecars ? { sidecars } : {}),
        };
      } catch {
        return incomplete('the bound Builder correlation could not be validated');
      }
    });
  } catch {
    return incomplete('the bound Builder projection is fenced or stale relative to canonical Flow');
  }
}

async function validateEventCorrelation(event) {
  try {
    const { readRunCorrelation } = await correlationContract();
    const presence = readRunCorrelation(event);
    return presence.status === 'present'
      ? { run_correlation: presence.envelope }
      : incomplete('the economics source event has invalid or incomplete correlation');
  } catch {
    return incomplete('the economics source event has invalid or incomplete correlation');
  }
}

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > MAX_STATE_BYTES) {
      process.stdout.write(`${JSON.stringify(incomplete('the runtime event payload is too large'))}\n`);
      return;
    }
  }
  let event;
  try {
    event = JSON.parse(raw || '{}');
  } catch {
    event = {};
  }
  if (process.argv.includes('--validate-correlation')) {
    process.stdout.write(`${JSON.stringify(await validateEventCorrelation(event))}\n`);
    return;
  }
  const result = await resolveTelemetryRunBinding({
    cwd: typeof event.cwd === 'string'
      ? event.cwd
      : (event.context && typeof event.context.cwd === 'string' ? event.context.cwd : ''),
    env: process.env,
    includeSidecars: process.argv.includes('--sidecar-snapshot'),
    terminalCapture: process.argv.includes('--terminal-capture'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  resolveTelemetryRunBinding,
  validateEventCorrelation,
};

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(incomplete('the telemetry correlation adapter is unavailable'))}\n`);
  });
}
