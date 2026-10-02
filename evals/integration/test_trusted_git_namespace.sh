#!/usr/bin/env bash
set -euo pipefail

# Real public committed-policy inspection; no ownership predicates or source scans.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$(uname -s)" != Linux ]]; then
  echo "SKIP: real trusted Git namespace integration requires Linux" >&2
  exit 77
fi
for tool in node git systemd-run unshare mount; do
  command -v "$tool" >/dev/null || { echo "SKIP: required tool $tool unavailable" >&2; exit 77; }
done
CLI="${FLOW_AGENTS_NAMESPACE_CLI:-$ROOT/build/src/cli.js}"
[[ -f "$CLI" ]] || { echo "FAIL: build the candidate public CLI first" >&2; exit 1; }
NODE="$(command -v node)"
CLI="$(realpath "$CLI")"
SCRATCH="$(mktemp -d "${HOME}/.flow-agents-git-namespace.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
REPO="$SCRATCH/repository"
mkdir -p "$REPO/.flow-agents/config"
cp "$ROOT/.flow-agents/config/core.config.json" "$REPO/.flow-agents/config/core.config.json"
mkdir -p "$REPO/src" "$REPO/kits/builder"
printf 'export const value = 1;\n' > "$REPO/src/index.ts"
printf '{"name":"@kontourai/flow-agents","version":"6.5.0"}\n' > "$REPO/package.json"
printf '{"schema_version":"1.0","kits":[{"id":"builder","name":"Builder Kit","path":"kits/builder"}]}\n' > "$REPO/kits/catalog.json"
cp "$ROOT/kits/builder/kit.json" "$REPO/kits/builder/kit.json"
printf '.kontourai/\n' > "$REPO/.gitignore"
git init -q -b main "$REPO"
git -C "$REPO" add .gitignore .flow-agents/config/core.config.json src package.json kits
git -C "$REPO" -c user.name=Fixture -c user.email=fixture@example.invalid commit -q -m 'namespace policy fixture'
SHA="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" update-ref refs/remotes/origin/main "$SHA"
TREE="$(git -C "$REPO" rev-parse 'HEAD^{tree}')"
DIVERGENT="$(git -C "$REPO" -c user.name=Fixture -c user.email=fixture@example.invalid commit-tree "$TREE" -m 'independent ancestry fixture')"
DIGEST="$(sha256sum "$REPO/.flow-agents/config/core.config.json" | cut -d ' ' -f 1)"
export FLOW_AGENTS_NAMESPACE_NODE="$NODE" FLOW_AGENTS_NAMESPACE_CLI="$CLI"
export FLOW_AGENTS_NAMESPACE_REPO="$REPO" FLOW_AGENTS_NAMESPACE_SHA="$SHA" FLOW_AGENTS_NAMESPACE_DIGEST="$DIGEST"
export FLOW_AGENTS_NAMESPACE_DIVERGENT="$DIVERGENT"
export FLOW_AGENTS_ACTOR="namespace-hook-$$" XDG_STATE_HOME="$SCRATCH/state" FLOW_AGENTS_GOAL_FIT_MODE=block
cat > "$SCRATCH/setup-hooks.mjs" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const packageRoot = path.resolve(path.dirname(process.env.FLOW_AGENTS_NAMESPACE_CLI), '../..');
const require = createRequire(pathToFileURL(process.env.FLOW_AGENTS_NAMESPACE_CLI));
const { startRun } = await import(pathToFileURL(require.resolve('@kontourai/flow')));
const { bindHostWorkflowSession, createRunCorrelationEnvelope } = await import(pathToFileURL(path.join(packageRoot, 'build', 'src', 'index.js')));
const { performLocalClaim } = await import(pathToFileURL(path.join(packageRoot, 'build', 'src', 'cli', 'assignment-provider.js')));
const root = process.env.FLOW_AGENTS_NAMESPACE_REPO, slug = 'namespace-run', subject = 'local:work-item/namespace-run';
const actorKey = process.env.FLOW_AGENTS_ACTOR;
const actor = { runtime: 'codex', session_id: actorKey, host: 'namespace-fixture', human: null };
const absent = { status: 'not_applicable', reason: 'Not supplied by this fixture.' };
const correlation = createRunCorrelationEnvelope({ identities: {
  runtime_session: { status: 'present', value: actorKey }, runtime_turn: absent,
  flow_run: { status: 'present', value: slug }, flow_step: absent,
  work_item: { status: 'present', value: subject }, agent: { status: 'present', value: actorKey },
  delegation_trace: absent, delegation_span: absent, terminal_record: absent,
} });
const run = await startRun(path.join(packageRoot, 'kits/builder/flows/build.flow.json'), {
  cwd: root, runId: slug, params: { subject, run_correlation: JSON.stringify(correlation) },
});
const artifactRoot = path.join(root, '.kontourai/flow-agents'), artifactDir = path.join(artifactRoot, slug);
fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(path.join(artifactDir, 'state.json'), JSON.stringify({
  schema_version: '1.0', task_slug: slug, status: 'in_progress', phase: 'pickup',
  work_item_refs: [subject], run_correlation: correlation,
  flow_run: { run_id: slug, definition_id: run.state.definition_id, definition_version: run.state.definition_version,
    status: run.state.status, current_step: run.state.current_step },
  next_action: { status: 'continue', summary: 'Execute the selected primitive and record its evidence.' },
}));
performLocalClaim(artifactRoot, slug, actor, { actorKey, artifactDir: slug, branch: 'main', ttlSeconds: 3600, workItemRef: subject });
bindHostWorkflowSession({ artifactRoot, artifactDir, actorKey, owner: 'namespace-fixture', source: 'selected-work',
  bindingId: correlation.correlation_id, activeFlowId: 'builder.build', activeStepId: run.state.current_step });
const stop = require(path.join(packageRoot, 'scripts/hooks/stop-goal-fit.js'));
const snapshot = stop.currentCanonicalWorkspaceSnapshot(root);
if (!snapshot || snapshot.worktree_clean !== true) throw new Error('fixture lacks a genuine clean host snapshot');
const timestamp = new Date().toISOString();
fs.writeFileSync(path.join(artifactDir, 'trust.bundle'), JSON.stringify({
  schemaVersion: 5, source: 'flow-agents/workflow-sidecar',
  claims: [{ id: 'namespace.command', subjectId: 'namespace-run/command', claimType: 'workflow.check.command',
    fieldOrBehavior: 'node --version', value: 'pass', impactLevel: 'high', status: 'verified',
    createdAt: timestamp, updatedAt: timestamp, metadata: { verification_workspace_snapshot: snapshot } }],
  evidence: [{ id: 'ev:namespace.command', claimId: 'namespace.command', evidenceType: 'command_output', method: 'capture',
    sourceRef: 'command-log.jsonl', excerptOrSummary: 'node --version', observedAt: timestamp,
    collectedBy: 'flow-agents/workflow-sidecar', passing: true, execution: { label: 'node --version', exitCode: 0 } }],
  policies: [], events: [],
}));
JS
"$NODE" "$SCRATCH/setup-hooks.mjs"
cat > "$SCRATCH/check.mjs" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const report = JSON.parse(execFileSync(process.env.FLOW_AGENTS_NAMESPACE_NODE,
  [process.env.FLOW_AGENTS_NAMESPACE_CLI, 'effective-flow-agents-config', process.env.FLOW_AGENTS_NAMESPACE_REPO], { encoding: 'utf8' }));
assert.equal(report.fail_closed, false);
assert.equal(report.core.state, 'committed');
assert.equal(report.core.provenance.commit, process.env.FLOW_AGENTS_NAMESPACE_SHA);
assert.equal(report.core.provenance.digest, process.env.FLOW_AGENTS_NAMESPACE_DIGEST);
const require = createRequire(pathToFileURL(process.env.FLOW_AGENTS_NAMESPACE_CLI));
const hookPaths = require(path.resolve(path.dirname(process.env.FLOW_AGENTS_NAMESPACE_CLI), '../../scripts/hooks/lib/local-artifact-paths.js'));
assert.equal(hookPaths.resolveSharedRepoRoot(process.env.FLOW_AGENTS_NAMESPACE_REPO), process.env.FLOW_AGENTS_NAMESPACE_REPO);
const packageRoot = path.resolve(path.dirname(process.env.FLOW_AGENTS_NAMESPACE_CLI), '../..');
const root = process.env.FLOW_AGENTS_NAMESPACE_REPO;
const runner = path.join(packageRoot, 'scripts/hooks/run-hook.js');
const observed = execFileSync(process.env.FLOW_AGENTS_NAMESPACE_NODE, ['--version'], { cwd: root, encoding: 'utf8' });
const logFile = path.join(root, '.kontourai/flow-agents/namespace-run/command-log.jsonl');
const beforeRecords = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').length : 0;
execFileSync(process.env.FLOW_AGENTS_NAMESPACE_NODE, [runner, 'evidence-capture', 'evidence-capture.js', 'standard,strict'], {
  cwd: root, input: JSON.stringify({ cwd: root, hook_event_name: 'PostToolUse', tool_name: 'exec_command',
    tool_input: { command: 'node --version', workdir: root }, tool_response: { exit_code: 0, stdout: observed } }),
  encoding: 'utf8',
});
const log = fs.readFileSync(logFile, 'utf8').trim().split('\n');
assert.equal(log.length, beforeRecords + 1, 'this namespace invocation must append its own genuine capture');
const entry = JSON.parse(log.at(-1));
assert.equal(entry.observed_at_commit, process.env.FLOW_AGENTS_NAMESPACE_SHA);
assert.equal(entry.worktree_clean, true);
assert.equal(entry.observedResult, 'pass');
const stop = require(path.join(packageRoot, 'scripts/hooks/stop-goal-fit.js'));
const snapshot = stop.currentCanonicalWorkspaceSnapshot(root);
assert.equal(snapshot?.head_sha, process.env.FLOW_AGENTS_NAMESPACE_SHA);
assert.equal(snapshot?.worktree_clean, true);
const result = await stop.analyze(root);
assert.equal(result.activeFlowRun, true);
assert.equal(result.activeFlowCurrentStep, 'pull-work', JSON.stringify(result));
assert.equal(result.stopGateSummary?.claims_confirmed_from_capture, 1, JSON.stringify(result));
assert.doesNotMatch(result.warnings.join('\n'), /current canonical workspace snapshot is unavailable|canonical Flow state is unsafe/);
let stopped;
try { execFileSync(process.env.FLOW_AGENTS_NAMESPACE_NODE, [runner, 'stop-goal-fit', 'stop-goal-fit.js', 'standard,strict'], {
  cwd: root, input: JSON.stringify({ cwd: root, hook_event_name: 'Stop' }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}); } catch (error) { stopped = error; }
assert.equal(stopped?.status, 2, 'shipped Stop must enforce the still-active actual canonical run');
assert.match(String(stopped.stderr), /canonical Flow run remains active at step pull-work/);
const freshness = require(path.join(packageRoot, 'scripts/hooks/lib/install-freshness.js'));
assert.deepEqual(freshness.checkoutStaleness(root, { gitSha: process.env.FLOW_AGENTS_NAMESPACE_SHA }), { determinable: true, stale: false });
assert.deepEqual(freshness.checkoutStaleness(root, { gitSha: process.env.FLOW_AGENTS_NAMESPACE_DIVERGENT }), { determinable: true, stale: false });
assert.deepEqual(freshness.checkoutStaleness(root, { gitSha: '0'.repeat(40) }), { determinable: false });
const source = path.join(root, 'src/index.ts'), original = fs.readFileSync(source);
const trusted = require(path.join(packageRoot, 'scripts/hooks/lib/trusted-git.js'));
try {
  fs.writeFileSync(source, 'export const value = 2;\n');
  const advisory = spawnSync(process.env.FLOW_AGENTS_NAMESPACE_NODE, [runner, 'stop-goal-fit', 'stop-goal-fit.js', 'standard,strict'], {
    cwd: root, env: { ...process.env, FLOW_AGENTS_ACTOR: `unstarted-${process.env.FLOW_AGENTS_ACTOR}` },
    input: JSON.stringify({ cwd: root, hook_event_name: 'Stop' }), encoding: 'utf8',
  });
  assert.equal(advisory.status, 0, advisory.stderr);
  assert.match(advisory.stderr, /delivery not started/);
  fs.writeFileSync(source, 'debugger;\n');
  trusted.execTrustedGitSync(root, ['add', 'src/index.ts']);
  const quality = spawnSync(process.env.FLOW_AGENTS_NAMESPACE_NODE,
    [path.join(packageRoot, 'scripts/hooks/pre-commit-quality.js')], {
      cwd: root, input: JSON.stringify({ tool_input: { command: 'git commit -m "fix: namespace fixture"' } }), encoding: 'utf8',
    });
  assert.equal(quality.status, 2, quality.stderr);
  assert.match(quality.stderr, /debugger statement/);
} finally {
  fs.writeFileSync(source, original);
  trusted.execTrustedGitSync(root, ['add', 'src/index.ts']);
}
console.log(JSON.stringify({ uid_map: fs.readFileSync('/proc/self/uid_map', 'utf8').trim(), git_owner: fs.statSync('/usr/bin/git').uid, commit: report.core.provenance.commit, digest: report.core.provenance.digest }));
JS
"$NODE" "$SCRATCH/check.mjs"
for private in no yes; do
  systemd-run --user --quiet --wait --pipe --collect --service-type=exec \
    --unit="flow-agents-git-namespace-${private}-$$" -p "PrivateTmp=$private" \
    --setenv="FLOW_AGENTS_NAMESPACE_NODE=$NODE" --setenv="FLOW_AGENTS_NAMESPACE_CLI=$CLI" \
    --setenv="FLOW_AGENTS_NAMESPACE_REPO=$REPO" --setenv="FLOW_AGENTS_NAMESPACE_SHA=$SHA" \
    --setenv="FLOW_AGENTS_NAMESPACE_DIGEST=$DIGEST" --setenv="FLOW_AGENTS_ACTOR=$FLOW_AGENTS_ACTOR" \
    --setenv="FLOW_AGENTS_NAMESPACE_DIVERGENT=$DIVERGENT" \
    --setenv="XDG_STATE_HOME=$XDG_STATE_HOME" --setenv="FLOW_AGENTS_GOAL_FIT_MODE=block" "$NODE" "$SCRATCH/check.mjs"
done
unshare --user --map-root-user "$NODE" "$SCRATCH/check.mjs"
unshare --user --map-root-user bash -c \
  'unshare --user --map-user="$1" --map-group="$2" "$3" "$4"' \
  sh "$(id -u)" "$(id -g)" "$NODE" "$SCRATCH/check.mjs"

# Bind caller-owned objects at all existing fixed candidates in a disposable
# mount namespace, so fallback to another healthy system Git cannot mask denial.
mkdir "$SCRATCH/lookup"
printf '#!/bin/sh\nprintf substituted > "%s"\nexit 91\n' "$SCRATCH/substituted" > "$SCRATCH/git"
chmod 755 "$SCRATCH/git"
ln -s /usr/bin/git "$SCRATCH/lookup/git"
cat > "$SCRATCH/negative.mjs" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
let result;
try {
  execFileSync(process.env.FLOW_AGENTS_NAMESPACE_NODE,
    [process.env.FLOW_AGENTS_NAMESPACE_CLI, 'effective-flow-agents-config', process.env.FLOW_AGENTS_NAMESPACE_REPO], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) { result = error; }
assert.equal(result?.status, 1, 'public inspection must reject substituted system Git');
const report = JSON.parse(result.stdout);
assert.equal(report.fail_closed, true);
assert.equal(report.core.state, 'invalid');
assert.match(report.core.diagnostics.join('\n'), /trusted Git/);
assert.match(report.core.diagnostics.join('\n'), /path ownership or permissions/);
const require = createRequire(pathToFileURL(process.env.FLOW_AGENTS_NAMESPACE_CLI));
const hookPaths = require(path.resolve(path.dirname(process.env.FLOW_AGENTS_NAMESPACE_CLI), '../../scripts/hooks/lib/local-artifact-paths.js'));
assert.equal(hookPaths.resolveSharedRepoRoot(process.env.FLOW_AGENTS_NAMESPACE_REPO), null);
const packageRoot = path.resolve(path.dirname(process.env.FLOW_AGENTS_NAMESPACE_CLI), '../..');
const root = process.env.FLOW_AGENTS_NAMESPACE_REPO;
const logFile = path.join(root, '.kontourai/flow-agents/namespace-run/command-log.jsonl');
const before = fs.readFileSync(logFile, 'utf8');
execFileSync(process.env.FLOW_AGENTS_NAMESPACE_NODE,
  [path.join(packageRoot, 'scripts/hooks/run-hook.js'), 'evidence-capture', 'evidence-capture.js', 'standard,strict'], {
    cwd: root, input: JSON.stringify({ cwd: root, hook_event_name: 'PostToolUse', tool_name: 'exec_command',
      tool_input: { command: 'node --version', workdir: root }, tool_response: { exit_code: 0, stdout: '' } }),
    encoding: 'utf8',
  });
assert.equal(fs.readFileSync(logFile, 'utf8'), before, 'unsafe Git must not add a confirming capture');
const stop = require(path.join(packageRoot, 'scripts/hooks/stop-goal-fit.js'));
assert.equal(stop.currentCanonicalWorkspaceSnapshot(root), null);
const stopped = await stop.analyze(root);
assert.equal(stopped.stopGateSummary?.claims_confirmed_from_capture, 0);
assert.match(stopped.warnings.join('\n'), /current canonical workspace snapshot is unavailable or dirty/);
const freshness = require(path.join(packageRoot, 'scripts/hooks/lib/install-freshness.js'));
assert.deepEqual(freshness.checkoutStaleness(root, { gitSha: process.env.FLOW_AGENTS_NAMESPACE_SHA }), { determinable: false });
const unstarted = require(path.join(packageRoot, 'scripts/hooks/lib/unstarted-delivery.js'));
assert.equal(unstarted.unstartedDeliveryWarning({ root, cwd: root }), null);
execFileSync(process.env.FLOW_AGENTS_NAMESPACE_NODE, [path.join(packageRoot, 'scripts/hooks/pre-commit-quality.js')], {
  cwd: root, input: JSON.stringify({ tool_input: { command: 'git commit -m "fix: namespace fixture"' } }), encoding: 'utf8',
});
assert.equal(fs.existsSync(process.env.FLOW_AGENTS_NAMESPACE_MARKER), false, 'substituted executable must never run');
JS
export FLOW_AGENTS_NAMESPACE_MARKER="$SCRATCH/substituted"
unshare --user --map-root-user --mount bash -s -- "$SCRATCH/git" "$SCRATCH/negative.mjs" <<'SH'
set -euo pipefail
mount --make-rprivate /
for candidate in /usr/bin/git /run/current-system/sw/bin/git /usr/local/bin/git; do
  if [[ -e "$candidate" ]]; then mount --bind "$1" "$candidate"; fi
done
"$FLOW_AGENTS_NAMESPACE_NODE" "$2"
SH

# Reject a caller-owned lookup directory and the route through a saved namespace
# alias to the real executable, not only a directly substituted executable.
unshare --user --map-root-user --mount bash -s -- "$SCRATCH" <<'SH'
set -euo pipefail
mount --make-rprivate /
mkdir "$1/system-bin"
mount --bind /usr/bin "$1/system-bin"
ln -sf "$1/system-bin/git" "$1/lookup/git"
for candidate in /run/current-system/sw/bin/git /usr/local/bin/git; do
  if [[ -e "$candidate" ]]; then mount --bind "$1/git" "$candidate"; fi
done
mount --bind "$1/lookup" /usr/bin
"$FLOW_AGENTS_NAMESPACE_NODE" "$1/negative.mjs"
SH
echo "PASS: host/systemd/nested committed-policy identity and caller-owned executable/lookup rejection"
