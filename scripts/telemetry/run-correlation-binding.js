#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const MAX_STATE_BYTES = 1024 * 1024;

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

function readStableJson(file, task) {
  let descriptor;
  try {
    const resolved = path.resolve(file);
    if (path.dirname(resolved) !== task.path || !taskDirectoryUnchanged(task)) return null;
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_STATE_BYTES) return null;
    const raw = fs.readFileSync(descriptor, 'utf8');
    const named = fs.lstatSync(resolved);
    if (
      named.isSymbolicLink()
      || !named.isFile()
      || named.dev !== opened.dev
      || named.ino !== opened.ino
      || !taskDirectoryUnchanged(task)
    ) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
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

async function resolveTelemetryRunBinding({ cwd, env = process.env } = {}) {
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
  const before = currentPointer.readOwnCurrentPointer(artifactRoot, resolvedActor.actor);
  const pointer = before.payload;
  if (
    before.source !== 'per-actor'
    || !pointer
    || pointer.binding_status === 'retired'
  ) {
    return incomplete('no authenticated Builder run is bound to this runtime session');
  }
  if (
    typeof pointer.binding_id !== 'string'
    || typeof pointer.active_slug !== 'string'
    || typeof pointer.artifact_dir !== 'string'
    || pointer.active_slug !== path.basename(pointer.artifact_dir)
  ) {
    return incomplete('the authenticated Builder binding is invalid');
  }

  const taskDir = safeTaskDirectory(artifactRoot, pointer.artifact_dir);
  if (!taskDir) return incomplete('the authenticated Builder binding is invalid');
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

    const after = currentPointer.readOwnCurrentPointer(artifactRoot, resolvedActor.actor);
    if (!pointerMatches(before, after)) {
      return incomplete('the authenticated Builder binding changed during telemetry capture');
    }
    return {
      run_correlation: envelope,
      task_slug: pointer.active_slug,
    };
  } catch {
    return incomplete('the bound Builder correlation could not be validated');
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
  const result = await resolveTelemetryRunBinding({
    cwd: typeof event.cwd === 'string' ? event.cwd : '',
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  resolveTelemetryRunBinding,
};

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(incomplete('the telemetry correlation adapter is unavailable'))}\n`);
  });
}
