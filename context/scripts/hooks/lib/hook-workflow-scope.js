'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { resolveActor, isUnresolvedActor, sanitizeSegment } = require('./actor-identity.js');
const { resolveSharedRepoRoot } = require('./local-artifact-paths.js');

// This is discovery state, not assignment or evidence authority. The target's
// actor pointer, correlation generation, assignment and canonical run still
// have to agree. A runtime actor may select work outside its startup cwd.
function locatorRoot(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  if (!path.isAbsolute(stateHome)) throw new Error('XDG_STATE_HOME must be absolute for workflow discovery');
  return path.join(stateHome, 'flow-agents', 'workflow-scopes');
}

function pointers() { return require('./current-pointer.js'); }

const HOST_RECOVERY_READER = `
  import { readFileSync } from 'node:fs';
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const { recoverHostWorkflowSessionActor } = await import(process.argv[1]);
  const result = recoverHostWorkflowSessionActor(input);
  process.stdout.write(JSON.stringify(result === null ? null : { bindingId: result.bindingId }));
`;

function readHostRecovery(input) {
  const scriptsRoot = path.dirname(path.dirname(__dirname));
  const container = path.dirname(scriptsRoot);
  const packageRoot = path.basename(container) === 'context' ? path.dirname(container) : container;
  const moduleFile = path.join(packageRoot, 'build', 'src', 'lib', 'host-workflow-binding.js');
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', HOST_RECOVERY_READER, pathToFileURL(moduleFile).href], {
    input: JSON.stringify(input), encoding: 'utf8', env,
    timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) throw new Error('host workflow recovery binding could not be validated by the installed public contract');
  const recovery = JSON.parse(result.stdout);
  if (recovery !== null && (typeof recovery !== 'object' || typeof recovery.bindingId !== 'string')) throw new Error('host workflow recovery reader returned invalid metadata');
  return recovery;
}

function readJson(file) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (before.isSymbolicLink() || !before.isFile() || before.size > 1024 * 1024) throw new Error('workflow scope file is unsafe');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('workflow scope file changed while opening');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const after = fs.lstatSync(file);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('workflow scope file changed while reading');
    return value;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function assertDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('workflow scope directory is unsafe');
  return { dev: stat.dev, ino: stat.ino };
}

function projectRootFor(artifactRoot) {
  const root = path.resolve(artifactRoot);
  if (path.basename(root) !== 'flow-agents' || path.basename(path.dirname(root)) !== '.kontourai') {
    throw new Error('workflow scope must use a canonical .kontourai/flow-agents root');
  }
  const projectRoot = path.dirname(path.dirname(root));
  assertDirectory(projectRoot);
  assertDirectory(path.dirname(root));
  assertDirectory(root);
  return projectRoot;
}

function scopeForPointer(artifactRoot, actorKey, pointer, strict = false) {
  const projectRoot = projectRootFor(artifactRoot);
  const relativeDir = pointer.artifact_dir || pointer.active_slug;
  if (typeof relativeDir !== 'string' || !relativeDir || path.isAbsolute(relativeDir)
    || relativeDir.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('workflow scope pointer has an invalid artifact directory');
  const slug = path.basename(relativeDir);
  if ((pointer.active_slug !== undefined && pointer.active_slug !== slug)
    || (strict && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || relativeDir !== slug))) throw new Error('workflow scope pointer has an invalid run id');
  const artifactDir = path.join(artifactRoot, relativeDir);
  const identity = assertDirectory(artifactDir);
  const state = readJson(path.join(artifactDir, 'state.json'));
  const retired = pointer.binding_status === 'retired';
  const canonicalPointer = pointer.binding_id !== undefined && typeof pointer.active_flow_id === 'string'
    && pointer.active_flow_id.startsWith('builder.');
  if (strict || canonicalPointer || state.flow_run !== undefined || state.run_correlation !== undefined) {
    if (relativeDir !== slug) throw new Error('canonical workflow scope must name a direct run directory');
    let boundActorKey = actorKey;
    let recovery = null;
    let assignment = null;
    const releasedAssignment = retired && pointer.binding_reason === 'assignment_released';
    if (!retired || releasedAssignment) {
      const assignmentRoot = path.join(artifactRoot, 'assignment');
      assertDirectory(assignmentRoot);
      const assignmentFile = path.join(assignmentRoot, `${sanitizeSegment(slug)}.json`);
      assignment = readJson(assignmentFile);
      const hasRecoveryFields = pointer.actor_key !== undefined || pointer.actor !== undefined || pointer.expires_at !== undefined;
      if (hasRecoveryFields && !retired) {
        const stat = fs.lstatSync(assignmentFile);
        recovery = readHostRecovery({
          artifactRoot, artifactDir, actorKey, assignmentActor: assignment.actor,
          assignmentSnapshot: { file: assignmentFile, identity: { dev: stat.dev, ino: stat.ino },
            rawSha256: createHash('sha256').update(fs.readFileSync(assignmentFile)).digest('hex') },
        });
        if (!recovery) throw new Error('workflow scope host recovery binding is unavailable');
        boundActorKey = assignment.actor_key;
      }
    }
    const correlation = state.run_correlation;
    const identities = correlation && correlation.identities;
    if (typeof pointer.binding_id !== 'string' || !pointer.binding_id
      || (!recovery && correlation?.correlation_id !== pointer.binding_id)
      || identities?.agent?.status !== 'present' || identities.agent.value !== boundActorKey
      || identities?.flow_run?.status !== 'present' || identities.flow_run.value !== slug
      || state.task_slug !== slug || state.flow_run?.run_id !== slug) throw new Error('workflow scope does not match the actor correlation generation');
    const runRoot = path.join(projectRoot, '.kontourai', 'flow', 'runs', slug);
    for (const dir of [path.dirname(path.dirname(runRoot)), path.dirname(runRoot), runRoot]) assertDirectory(dir);
    const canonical = readJson(path.join(runRoot, 'state.json'));
    const canonicalCorrelation = typeof canonical.params?.run_correlation === 'string'
      ? JSON.parse(canonical.params.run_correlation) : canonical.params?.run_correlation;
    if (canonical.run_id !== slug || !isDeepStrictEqual(canonicalCorrelation, correlation)
      || canonical.status !== state.flow_run.status || canonical.current_step !== state.flow_run.current_step) {
      throw new Error('workflow scope projection is stale relative to its canonical run');
    }
    // Work Item selection belongs to the declaring flow's startup contract.
    // Kit flows that do not select work omit the provider work_item_ref, while
    // their recorded correlation subject still has to agree with canonical Flow.
    const workItem = identities?.work_item;
    if (workItem?.status === 'present') {
      if (canonical.subject !== workItem.value || !Array.isArray(state.work_item_refs)
        || !state.work_item_refs.includes(workItem.value)) throw new Error('workflow scope Work Item does not match its canonical subject');
    } else if (!workItem || !['unavailable', 'unsupported', 'not_applicable'].includes(workItem.status)) {
      throw new Error('workflow scope Work Item identity is malformed');
    }
    if (assignment) {
      const assignedDirectory = typeof assignment.artifact_dir === 'string'
        && (path.resolve(artifactRoot, assignment.artifact_dir) === artifactDir
          || path.resolve(projectRoot, assignment.artifact_dir) === artifactDir);
      if (assignment.status !== (releasedAssignment ? 'released' : 'claimed') || assignment.actor_key !== boundActorKey
        || !assignedDirectory || assignment.subject_id !== slug
        || (identities?.runtime_session?.status === 'present' && identities.runtime_session.value !== assignment.actor?.session_id)
        || (assignment.work_item_ref !== undefined && (workItem?.status !== 'present' || workItem.value !== assignment.work_item_ref))) {
        throw new Error(`workflow scope does not match the ${releasedAssignment ? 'released' : 'active'} assignment`);
      }
    }
    if (retired && !releasedAssignment
      && (!['blocked', 'needs_decision', 'paused', 'completed', 'canceled', 'failed', 'accepted_by_exception', 'archived'].includes(canonical.status)
        || pointer.binding_reason !== `flow_${canonical.status}`)) throw new Error('workflow scope retirement does not match its canonical nonactive run');
  }
  const after = assertDirectory(artifactDir);
  if (after.dev !== identity.dev || after.ino !== identity.ino) throw new Error('workflow scope directory changed while resolving');
  return { status: retired ? 'retired' : 'bound', projectRoot, artifactRoot, artifactDir, pointer, state };
}

function ownWorkingTree(cwd) {
  let dir = path.resolve(cwd);
  let fallback = null;
  for (let depth = 0; depth < 128; depth++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (!fallback && fs.existsSync(path.join(dir, 'AGENTS.md'))) fallback = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback || path.resolve(cwd);
}

function hookArtifactRoots(cwd, env = process.env) {
  const starts = [cwd, ...String(env.SA_PROTECTED_WORKSPACE_ROOTS || '').split(',').map(value => value.trim()).filter(Boolean)];
  const roots = [];
  for (const start of starts) {
    roots.push(path.join(ownWorkingTree(start), '.kontourai', 'flow-agents'));
    const shared = resolveSharedRepoRoot(start);
    if (shared) roots.push(path.join(shared, '.kontourai', 'flow-agents'));
  }
  return [...new Set(roots)];
}

function resolveHookWorkflowScope(cwd, env = process.env) {
  const actorKey = resolveActor(env).actor;
  if (isUnresolvedActor(actorKey)) return { status: 'none' };
  let discovery;
  try {
    const root = locatorRoot(env);
    const file = pointers().perActorCurrentFile(root, actorKey);
    let exists = false;
    try { fs.lstatSync(file); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) {
      assertDirectory(root);
      assertDirectory(path.join(root, 'current'));
      discovery = readJson(file);
      if (discovery.schema_version !== '1.0' || discovery.actor_key !== actorKey
        || typeof discovery.artifact_root !== 'string' || !path.isAbsolute(discovery.artifact_root)) throw new Error('workflow discovery locator is malformed');
      const own = pointers().readOwnCurrentPointerRecord(discovery.artifact_root, actorKey);
      if (!own.payload || own.payload.artifact_dir !== discovery.artifact_dir
        || own.payload.binding_id !== discovery.binding_id
        || (own.payload.binding_status === 'retired') !== (discovery.binding_status === 'retired')) throw new Error('workflow discovery locator is stale; retry flow-agents workflow start for the selected Work Item to activate its existing run');
      const scope = scopeForPointer(discovery.artifact_root, actorKey, own.payload, true);
      const after = readJson(file);
      if (!isDeepStrictEqual(discovery, after)
        || !isDeepStrictEqual(own.payload, pointers().readOwnCurrentPointerRecord(discovery.artifact_root, actorKey).payload)) throw new Error('workflow discovery binding changed while resolving');
      return scope;
    }
    const scopes = [];
    for (const root of hookArtifactRoots(cwd, env)) {
      const own = pointers().readOwnCurrentPointerRecord(root, actorKey);
      if (!own.payload || own.payload.binding_status === 'retired') continue;
      scopes.push(scopeForPointer(root, actorKey, own.payload));
    }
    if (scopes.length > 1) return { status: 'ambiguous', reason: 'actor has multiple workflow bindings; retry public workflow start for the intended Work Item to activate its existing run' };
    return scopes[0] || { status: 'none' };
  } catch (error) { return { status: 'invalid', reason: `${error.message}. Retry flow-agents workflow start for the selected Work Item to refresh its authenticated binding` }; }
}

function publishActorWorkflowScope(artifactRoot, actorKey, activate = false) {
  // Legacy sidecars retain their shared-store contract. Only a canonical Builder
  // correlation generation is eligible for cross-workspace discovery.
  const own = pointers().readOwnCurrentPointerRecord(artifactRoot, actorKey);
  if (!own.payload?.binding_id || !own.payload?.active_flow_id) return;
  const state = readJson(path.join(artifactRoot, own.payload.artifact_dir, 'state.json'));
  if (!state.run_correlation || state.run_correlation.status === 'incomplete') return;
  // Host recovery capabilities have their own binding generation and validated
  // authority contract. This locator only follows native Builder generations.
  if (state.run_correlation.correlation_id !== own.payload.binding_id
    || state.run_correlation.identities?.agent?.value !== actorKey) return;
  const scope = scopeForPointer(path.resolve(artifactRoot), actorKey, own.payload, true);
  const root = locatorRoot();
  const payload = {
    schema_version: '1.0', actor_key: actorKey, artifact_root: scope.artifactRoot,
    artifact_dir: own.payload.artifact_dir, binding_id: own.payload.binding_id,
    ...(scope.status === 'retired' ? { binding_status: 'retired' } : {}),
  };
  pointers().writePerActorCurrentConditionally(root, actorKey, payload, existing => {
    if (existing === undefined) return activate;
    return !existing || activate || (existing.artifact_root === scope.artifactRoot && existing.binding_id === own.payload.binding_id);
  }, () => {
    if (!isDeepStrictEqual(own.payload, pointers().readOwnCurrentPointerRecord(artifactRoot, actorKey).payload)) throw new Error('workflow binding changed before discovery publication');
  });
}

module.exports = { hookArtifactRoots, resolveHookWorkflowScope, publishActorWorkflowScope };
