import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { startRun, cancelRun, pauseRun } from '@kontourai/flow';
import { bindHostWorkflowSession, retireHostWorkflowSession } from '../../build/src/index.js';
import { performLocalClaim, performLocalRelease } from '../../build/src/cli/assignment-provider.js';
import { createRunCorrelationEnvelope } from '../../build/src/run-correlation.js';

const require = createRequire(import.meta.url);
const pointers = require('../../scripts/hooks/lib/current-pointer.js');
const packageRoot = path.resolve(import.meta.dirname, '../..');
const actor = 'hook-scope-actor';
const actorStruct = { runtime: 'codex', session_id: 'hook-scope-session', host: 'fixture', human: null };

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repository(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'source.txt'), 'tracked fixture\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.kontourai/\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-hook-scope-')));
  const primary = path.join(root, 'primary');
  const worktree = path.join(root, 'worktree');
  const startup = path.join(root, 'startup-clone');
  repository(primary);
  git(primary, 'worktree', 'add', '-qb', 'fixture-lane', worktree);
  git(root, 'clone', '-q', primary, startup);
  const before = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, FLOW_AGENTS_ACTOR: process.env.FLOW_AGENTS_ACTOR };
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'state'), FLOW_AGENTS_ACTOR: actor,
    FLOW_AGENTS_GOAL_FIT_MODE: 'block', SA_DISABLED_HOOKS: '', SA_HOOK_PROFILE: 'standard' };
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
  process.env.FLOW_AGENTS_ACTOR = actor;
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, primary, worktree, startup, env };
}

async function activeRun(projectRoot, actorKey = actor, slug = 'selected-run', bind = true) {
  const subject = `local:work-item/${slug}`;
  const absent = { status: 'not_applicable', reason: 'Not supplied by this fixture.' };
  const correlation = createRunCorrelationEnvelope({ identities: {
    runtime_session: { status: 'present', value: actorStruct.session_id }, runtime_turn: absent,
    flow_run: { status: 'present', value: slug }, flow_step: absent,
    work_item: { status: 'present', value: subject }, agent: { status: 'present', value: actorKey },
    delegation_trace: absent, delegation_span: absent, terminal_record: absent,
  } });
  const run = await startRun(path.join(packageRoot, 'kits/builder/flows/build.flow.json'), {
    cwd: projectRoot, runId: slug, params: { subject, run_correlation: JSON.stringify(correlation) },
  });
  const artifactRoot = path.join(projectRoot, '.kontourai', 'flow-agents');
  const artifactDir = path.join(artifactRoot, slug);
  writeJson(path.join(artifactDir, 'state.json'), {
    schema_version: '1.0', task_slug: slug, status: 'in_progress', phase: 'pickup',
    work_item_refs: [subject], run_correlation: correlation,
    flow_run: { run_id: slug, definition_id: run.state.definition_id, definition_version: run.state.definition_version,
      status: run.state.status, current_step: run.state.current_step },
    next_action: { status: 'continue', summary: 'Execute the selected primitive and record its evidence.' },
  });
  performLocalClaim(artifactRoot, slug, actorStruct, {
    actorKey, artifactDir: slug, branch: 'fixture-lane', ttlSeconds: 3600, workItemRef: subject,
  });
  const binding = { artifactRoot, artifactDir, actorKey, owner: 'fixture-host', source: 'selected-work',
    bindingId: correlation.correlation_id, activeFlowId: 'builder.build', activeStepId: run.state.current_step };
  if (bind) bindHostWorkflowSession(binding);
  else writeJson(pointers.perActorCurrentFile(artifactRoot, actorKey), {
    active_slug: slug, artifact_dir: slug, binding_id: correlation.correlation_id,
    active_flow_id: 'builder.build', active_step_id: run.state.current_step,
  });
  return { run, binding, correlation, artifactRoot, artifactDir };
}

function hook(f, name, cwd, payload = {}, env = f.env) {
  return spawnSync(process.execPath, [path.join(packageRoot, 'scripts/hooks/run-hook.js'), name, `${name}.js`, 'standard,strict'], {
    cwd, env, input: JSON.stringify({ cwd, hook_event_name: name === 'stop-goal-fit' ? 'Stop' : 'UserPromptSubmit', ...payload }),
    encoding: 'utf8', timeout: 30_000,
  });
}

async function waitFor(file) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`concurrent worker did not reach ${file}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('shipped hooks enforce a worktree-local run and discover its exact actor binding from a different clone', async t => {
  const f = fixture(t);
  const selected = await activeRun(f.worktree);
  const sameSlug = await activeRun(f.primary, 'other-actor');
  fs.writeFileSync(path.join(sameSlug.run.dir, 'state.json'), '{}');
  for (const cwd of [f.worktree, f.startup]) {
    const stop = hook(f, 'stop-goal-fit', cwd);
    assert.equal(stop.status, 2, stop.stderr);
    assert.match(stop.stderr, /canonical Flow run remains active at step pull-work/);
    assert.doesNotMatch(stop.stderr, /canonical Flow state is unsafe|workflow binding is invalid/);
    const steering = hook(f, 'workflow-steering', cwd, { hook_event_name: 'SessionStart' });
    assert.equal(steering.status, 0, steering.stderr);
    assert.match(steering.stdout, /Canonical Flow: builder\.build@.*\/selected-run status:active current_step:pull-work/);
    assert.doesNotMatch(steering.stdout, /GUIDANCE_CONFLICT/);
  }
  const otherActor = hook(f, 'stop-goal-fit', f.startup, {}, { ...f.env, FLOW_AGENTS_ACTOR: 'unrelated-actor' });
  assert.equal(otherActor.status, 0, otherActor.stderr);
  assert.equal(fs.existsSync(path.join(selected.artifactDir, 'command-log.jsonl')), false);
});

test('physical worktree scope remains visible without a locator and shared coordination reads keep their original store', async t => {
  const f = fixture(t);
  await activeRun(f.worktree, actor, 'selected-run', false);
  const stop = hook(f, 'stop-goal-fit', f.worktree);
  assert.equal(stop.status, 2, stop.stderr);
  assert.match(stop.stderr, /canonical Flow run remains active at step pull-work/);
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]).flowAgentsArtifactRoot(process.cwd()))',
    path.join(packageRoot, 'scripts/hooks/lib/local-artifact-paths.js')], { cwd: f.worktree, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, path.join(f.primary, '.kontourai', 'flow-agents'));
});

test('physical-root fallback rejects foreign actor correlations and reports competing actor bindings', async t => {
  const f = fixture(t);
  const foreign = await activeRun(f.worktree, 'foreign-actor', 'foreign-run', false);
  const ownFile = pointers.perActorCurrentFile(foreign.artifactRoot, actor);
  fs.copyFileSync(pointers.perActorCurrentFile(foreign.artifactRoot, 'foreign-actor'), ownFile);
  const wrongActor = hook(f, 'stop-goal-fit', f.worktree);
  assert.equal(wrongActor.status, 2, wrongActor.stderr);
  assert.match(wrongActor.stderr, /does not match the actor correlation generation/);
  fs.unlinkSync(ownFile);
  await activeRun(f.worktree, actor, 'worktree-run', false);
  await activeRun(f.primary, actor, 'primary-run', false);
  const ambiguous = hook(f, 'stop-goal-fit', f.worktree);
  assert.equal(ambiguous.status, 2, ambiguous.stderr);
  assert.match(ambiguous.stderr, /workflow binding is ambiguous/);
});

test('stale, malformed and symlinked discovery bindings remain visible and cannot silently release an active run', async t => {
  const f = fixture(t);
  const selected = await activeRun(f.worktree);
  const locator = pointers.perActorCurrentFile(path.join(f.env.XDG_STATE_HOME, 'flow-agents', 'workflow-scopes'), actor);
  const original = fs.readFileSync(locator, 'utf8');
  for (const corrupt of [value => { value.binding_id = 'wrong-generation'; }, value => { value.actor_key = 'another-actor'; }]) {
    const value = JSON.parse(original);
    corrupt(value);
    writeJson(locator, value);
    const stop = hook(f, 'stop-goal-fit', f.startup);
    assert.equal(stop.status, 2, stop.stderr);
    assert.match(stop.stderr, /workflow binding is invalid/);
    assert.match(hook(f, 'workflow-steering', f.startup).stdout, /WORKFLOW BINDING INVALID/);
  }
  fs.unlinkSync(locator);
  fs.symlinkSync(path.join(selected.artifactDir, 'state.json'), locator);
  const symlink = hook(f, 'stop-goal-fit', f.startup);
  assert.equal(symlink.status, 2, symlink.stderr);
  assert.match(symlink.stderr, /workflow scope file is unsafe/);
});

test('the public host binding refresh repairs a stale discovery generation for the same selected run', async t => {
  const f = fixture(t);
  const selected = await activeRun(f.worktree);
  const locator = pointers.perActorCurrentFile(path.join(f.env.XDG_STATE_HOME, 'flow-agents', 'workflow-scopes'), actor);
  const value = JSON.parse(fs.readFileSync(locator));
  value.binding_id = 'stale-generation';
  writeJson(locator, value);
  assert.match(hook(f, 'stop-goal-fit', f.startup).stderr, /workflow binding is invalid/);
  bindHostWorkflowSession(selected.binding);
  const stop = hook(f, 'stop-goal-fit', f.startup);
  assert.equal(stop.status, 2, stop.stderr);
  assert.match(stop.stderr, /canonical Flow run remains active at step pull-work/);
  assert.doesNotMatch(stop.stderr, /workflow binding is invalid/);
});

test('physical host-recovery scope uses the existing public ESM capability contract', async t => {
  const f = fixture(t);
  const selected = await activeRun(f.worktree);
  const locator = pointers.perActorCurrentFile(path.join(f.env.XDG_STATE_HOME, 'flow-agents', 'workflow-scopes'), actor);
  fs.unlinkSync(locator);
  bindHostWorkflowSession({ ...selected.binding, bindingId: 'host-recovery-generation', actor: actorStruct,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
  const stop = hook(f, 'stop-goal-fit', f.worktree);
  assert.equal(stop.status, 2, stop.stderr);
  assert.match(stop.stderr, /canonical Flow run remains active at step pull-work/);
  assert.doesNotMatch(stop.stderr, /workflow binding is invalid|ERR_REQUIRE_ESM/);
  const configured = hook(f, 'workflow-steering', f.startup, { hook_event_name: 'SessionStart' },
    { ...f.env, SA_PROTECTED_WORKSPACE_ROOTS: f.worktree });
  assert.match(configured.stdout, /selected-run status:active/);
  assert.doesNotMatch(configured.stdout, /WORKFLOW BINDING INVALID|GUIDANCE_CONFLICT/);
});

test('retiring an old run cannot replace a newer cross-workspace selection', async t => {
  const f = fixture(t);
  const first = await activeRun(f.worktree, actor, 'first-run');
  await activeRun(f.primary, actor, 'second-run');
  const canceled = await cancelRun('first-run', { cwd: f.worktree, reason: 'fixture complete',
    authority: { kind: 'operator_request', actor: 'fixture-owner', request_ref: 'fixture:cancel-first-run', requested_at: new Date().toISOString() } });
  const stateFile = path.join(first.artifactDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  state.flow_run.status = canceled.state.status;
  writeJson(stateFile, state);
  const result = pointers.retireOwnCurrentPointer(first.artifactRoot, actor, 'first-run', first.correlation.correlation_id,
    'flow_canceled', new Date().toISOString());
  assert.equal(result, 'retired');
  const steering = hook(f, 'workflow-steering', f.startup);
  assert.match(steering.stdout, /second-run status:active/);
  assert.doesNotMatch(steering.stdout, /first-run|WORKFLOW BINDING INVALID/);
});

test('assignment retirement requires the recorded release and preserves active canonical Flow', async t => {
  const f = fixture(t);
  const selected = await activeRun(f.worktree);
  const canonicalFile = path.join(selected.run.dir, 'state.json');
  const canonicalBefore = fs.readFileSync(canonicalFile, 'utf8');
  const retirement = { ...selected.binding, reason: 'assignment_released' };
  assert.throws(() => retireHostWorkflowSession(retirement), /does not match the released assignment/);
  assert.equal(hook(f, 'stop-goal-fit', f.startup).status, 2, 'a reason alone cannot release the active actor scope');
  performLocalRelease(selected.artifactRoot, 'selected-run', actorStruct, { actorKey: actor, reason: 'fixture assignment release' });
  assert.equal(retireHostWorkflowSession(retirement), 'retired', 'a retry completes discovery after the actual assignment release');
  assert.equal(hook(f, 'stop-goal-fit', f.startup).status, 0);
  assert.equal(fs.readFileSync(canonicalFile, 'utf8'), canonicalBefore, 'assignment release does not cancel or rewrite Flow');
});

test('paused retirement matches the actual canonical disposition', async t => {
  const f = fixture(t);
  const selected = await activeRun(f.worktree);
  const paused = await pauseRun('selected-run', { cwd: f.worktree, reason: 'fixture pause',
    authority: { kind: 'operator_request', actor: 'fixture-owner', request_ref: 'fixture:pause-scope', requested_at: new Date().toISOString() } });
  const stateFile = path.join(selected.artifactDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  state.flow_run.status = paused.state.status;
  writeJson(stateFile, state);
  const retirement = { ...selected.binding, reason: 'flow_paused' };
  assert.equal(retireHostWorkflowSession(retirement), 'retired');
  assert.equal(hook(f, 'stop-goal-fit', f.startup).status, 0);
  const canonicalFile = path.join(selected.run.dir, 'state.json');
  writeJson(canonicalFile, selected.run.state);
  writeJson(stateFile, { ...state, flow_run: { ...state.flow_run, status: 'active' } });
  const mismatch = hook(f, 'stop-goal-fit', f.startup);
  assert.equal(mismatch.status, 2, mismatch.stderr);
  assert.match(mismatch.stderr, /retirement does not match its canonical nonactive run/);
});

test('an old retirement waiting on the locator lock cannot overwrite a concurrent new selection', async t => {
  const f = fixture(t);
  const first = await activeRun(f.worktree, actor, 'first-run');
  const canceled = await cancelRun('first-run', { cwd: f.worktree, reason: 'fixture complete',
    authority: { kind: 'operator_request', actor: 'fixture-owner', request_ref: 'fixture:cancel-concurrent-run', requested_at: new Date().toISOString() } });
  const stateFile = path.join(first.artifactDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  state.flow_run.status = canceled.state.status;
  writeJson(stateFile, state);
  const locatorRoot = path.join(f.env.XDG_STATE_HOME, 'flow-agents', 'workflow-scopes');
  const marker = path.join(f.root, 'retirement-waits-on-locator');
  const locatorLock = path.join(locatorRoot, 'current', '.actor-pointers.lockdir');
  const worker = `
    const fs = require('node:fs');
    const path = require('node:path');
    const mkdir = fs.mkdirSync;
    // Observe the real lock attempt; no hook or workflow behavior is mocked.
    fs.mkdirSync = function(directory, ...args) {
      if (path.resolve(directory) === process.argv[2]) fs.writeFileSync(process.argv[3], 'waiting');
      return mkdir.call(this, directory, ...args);
    };
    const pointers = require(process.argv[1]);
    const result = pointers.retireOwnCurrentPointer(process.argv[4], process.argv[5], 'first-run', process.argv[6],
      'flow_canceled', new Date().toISOString());
    if (result !== 'retired') throw new Error('retirement failed: ' + result);
  `;
  let child;
  let completion;
  await pointers.withActorCurrentPointerLockAsync(locatorRoot, actor, async () => {
    child = spawn(process.execPath, ['-e', worker, path.join(packageRoot, 'scripts/hooks/lib/current-pointer.js'),
      locatorLock, marker, first.artifactRoot, actor, first.correlation.correlation_id], { cwd: f.startup, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    completion = new Promise((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr || `retirement exited ${code}`)));
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    await waitFor(marker);
    // This explicit selection runs under the already-held locator lock. The
    // waiting retirement must compare against B only after that lock releases.
    await activeRun(f.primary, actor, 'second-run');
  });
  await completion;
  const steering = hook(f, 'workflow-steering', f.startup, { hook_event_name: 'SessionStart' });
  assert.match(steering.stdout, /second-run status:active/);
  assert.doesNotMatch(steering.stdout, /first-run|WORKFLOW BINDING INVALID/);
  const stop = hook(f, 'stop-goal-fit', f.startup);
  assert.equal(stop.status, 2, stop.stderr);
  assert.match(stop.stderr, /canonical Flow run remains active/);
});

test('command evidence observes the host tool workdir and rejects a different bound workspace', async t => {
  const f = fixture(t);
  const selected = await activeRun(f.worktree);
  const payload = { hook_event_name: 'PostToolUse', tool_name: 'exec_command',
    tool_input: { command: 'git status --porcelain', workdir: f.worktree }, tool_response: { exit_code: 0, stdout: '' } };
  const captured = hook(f, 'evidence-capture', f.startup, payload);
  assert.equal(captured.status, 0, captured.stderr);
  const log = path.join(selected.artifactDir, 'command-log.jsonl');
  assert.equal(fs.existsSync(log), true, captured.stderr);
  const before = fs.readFileSync(log, 'utf8');
  const entry = JSON.parse(before.trim());
  assert.equal(entry.observed_at_commit, git(f.worktree, 'rev-parse', 'HEAD').trim());
  const mismatch = hook(f, 'evidence-capture', f.startup, { ...payload, tool_input: { ...payload.tool_input, workdir: f.primary } });
  assert.match(mismatch.stderr, /workspace differs from the bound workflow/);
  assert.equal(fs.readFileSync(log, 'utf8'), before);
});
