import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateDefinition } from '@kontourai/flow';
import { compileProfile, digest, generatedFiles, readSnapshot, writeGenerated } from '../../examples/aidlc/scripts/compile.mjs';
import { compareMethod, compareOutputs } from '../../examples/aidlc/scripts/compare.mjs';
import { captureRun } from '../../examples/aidlc/scripts/capture-run.mjs';
import { observeStage, projectInvalidation, inspectBasis } from '../../examples/aidlc/scripts/artifacts.mjs';
import { runPublicFlowConformance } from '../../examples/aidlc/evals/public-flow-conformance.mjs';
import { parseKitFlowStepActions, validateKitRepository } from '../../build/src/flow-kit/validate.js';
import { canonicalRunFlowIds, canonicalRunFlowRefusal } from '../../build/src/builder-flow-run-adapter.js';
import { startBuilderFlowSession } from '../../build/src/builder-flow-runtime.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const KIT = join(ROOT, 'examples/aidlc');
const snapshot = readSnapshot();
const fixture = () => mkdtempSync(join(tmpdir(), 'kontour-aidlc-'));

test('pinned upstream profiles compile to valid Flow contracts and retain exact membership', () => {
  assert.equal(snapshot.stages.length, 33);
  assert.equal(Object.keys(snapshot.profiles).length, 11);
  assert.equal(snapshot.agents.length, 14);
  for (const profile of Object.keys(snapshot.profiles)) {
    const { flow } = compileProfile(snapshot, profile);
    assert.doesNotThrow(() => validateDefinition(flow), profile);
    assert.equal(compareMethod(snapshot, profile, flow).outcome, 'pass');
    const shortened = structuredClone(flow);
    shortened.steps.pop();
    assert.equal(compareMethod(snapshot, profile, shortened).outcome, 'fail', 'omitted work must fail parity');
  }
  assert.throws(() => compileProfile(snapshot, 'unknown'), /Unknown/);
  assert.equal(compileProfile(snapshot, 'feature', { projectType: 'greenfield' }).stages.includes('reverse-engineering'), false);
  writeGenerated({ check: true });
});

test('all 193 profile action bindings validate, while excessive declarations remain refused', () => {
  const manifest = JSON.parse(readFileSync(join(KIT, 'kit.json'), 'utf8'));
  assert.equal(manifest.flow_step_actions.length, 193);
  assert.deepEqual(parseKitFlowStepActions(manifest, 'aidlc/kit.json').errors, []);
  const action = manifest.flow_step_actions[0];
  const many = Array.from({ length: 513 }, (_, i) => ({ ...action, step_id: `step-${i}` }));
  assert.match(parseKitFlowStepActions({ flow_step_actions: many }, 'large/kit.json').errors.join('\n'), /exceeds 512/);
  const boundary = many.slice(0, 512);
  assert.deepEqual(parseKitFlowStepActions({ flow_step_actions: boundary }, 'large/kit.json').errors, []);
});

test('external AI-DLC kit validates and each profile binds without privileged core registration', async () => {
  const diagnostics = await validateKitRepository(KIT, { validateFlowDefinition: validateDefinition });
  assert.deepEqual(diagnostics, []);
  const root = fixture();
  try {
    cpSync(KIT, join(root, 'kits/aidlc'), { recursive: true });
    const ids = canonicalRunFlowIds(root);
    for (const profile of Object.keys(snapshot.profiles)) {
      assert.ok(ids.includes(`aidlc.${profile}`), profile);
      assert.equal(canonicalRunFlowRefusal(`aidlc.${profile}`, root), null);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('artifact changes invalidate observed dependents and preserve an unrelated branch', () => {
  const root = fixture();
  const local = { upstream: snapshot.upstream, profiles: { demo: { stages: ['requirements', 'design', 'build', 'unrelated'] } }, stages: [
    { slug: 'requirements', source_digest: 'r', produces: ['requirements'], consumes: [] },
    { slug: 'design', source_digest: 'd', produces: ['plan'], consumes: [{ artifact: 'requirements', required: true }] },
    { slug: 'build', source_digest: 'b', produces: ['tests'], consumes: [{ artifact: 'plan', required: true }] },
    { slug: 'unrelated', source_digest: 'u', produces: ['note'], consumes: [] },
  ] };
  const artifacts = ['requirements', 'plan', 'tests', 'note'].map((id, i) => ({ id, stage: local.stages[i].slug, path: `${id}.md` }));
  try {
    for (const entry of artifacts) writeFileSync(join(root, entry.path), `Observed ${entry.id}\n`);
    const receipts = local.profiles.demo.stages.map((stage) => observeStage({ snapshot: local, profile: 'demo', stage, root, artifacts }));
    assert.ok(receipts.every((entry) => entry.structural_status === 'pass' && entry.semantic_status === 'not_verified'));
    writeFileSync(join(root, 'requirements.md'), 'Changed requirement\n');
    const projection = projectInvalidation(receipts, root);
    assert.equal(projection.requirements.status, 'stale');
    assert.equal(projection.design.status, 'stale');
    assert.equal(projection.build.status, 'stale');
    assert.equal(projection.build.direct, false);
    assert.equal(projection.unrelated.status, 'current');
    const missing = observeStage({ snapshot: local, profile: 'demo', stage: 'design', root, artifacts: [] });
    assert.equal(missing.structural_status, 'fail');
    assert.ok(missing.findings.includes('missing:requirements/requirements'));
    assert.throws(() => observeStage({ snapshot: local, profile: 'demo', stage: 'design', root, artifacts: [artifacts[1], artifacts[1]] }), /Ambiguous/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('comparison refuses absent/unbound runs and detects missing outputs without inventing superiority', () => {
  const spec = JSON.parse(readFileSync(join(KIT, 'evals/corpus.json'), 'utf8')).cases[0];
  const result = { status: 'completed', identity: { revision: 'fixture-sha', model: 'same-model', harness: 'same-harness' },
    budget: { max_tokens: 1000 }, input_digest: digest(spec.input), artifacts: {
      'requirements.md': 'FR1 FR2 FR3', 'test-plan.md': 'duplicate quantity',
    } };
  assert.equal(compareOutputs(spec, null, result).comparison_status, 'not_verified');
  const pass = compareOutputs(spec, result, result);
  assert.equal(pass.comparison_status, 'comparable');
  assert.equal(pass.candidate.status, 'pass');
  assert.equal(pass.improvement_claim, 'not_verified');
  const missing = structuredClone(result);
  missing.artifacts['requirements.md'] = 'FR1 FR2';
  assert.equal(compareOutputs(spec, result, missing).candidate.status, 'fail');
  const wrong = structuredClone(result);
  wrong.identity.model = 'different-model';
  assert.equal(compareOutputs(spec, result, wrong).comparison_status, 'not_verified');
  wrong.identity = {};
  assert.equal(compareOutputs(spec, result, wrong).candidate.status, 'not_verified');
});

test('present optional outputs participate in validity while absent ones remain optional', () => {
  const root = fixture();
  const local = { upstream: snapshot.upstream, profiles: { demo: { stages: ['design'] } }, stages: [{ slug: 'design', source_digest: 'd', produces: [], optional_produces: ['frontend'], consumes: [] }] };
  try {
    assert.equal(observeStage({ snapshot: local, profile: 'demo', stage: 'design', root, artifacts: [] }).structural_status, 'pass');
    writeFileSync(join(root, 'frontend.md'), 'original component');
    const receipt = observeStage({ snapshot: local, profile: 'demo', stage: 'design', root, artifacts: [{ id: 'frontend', stage: 'design', path: 'frontend.md' }] });
    assert.equal(receipt.outputs.length, 1);
    writeFileSync(join(root, 'frontend.md'), 'changed component');
    assert.equal(inspectBasis(receipt, root).status, 'stale');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real installed Flow/Surface runtime rejects five failure classes and permits successful evidence', async () => {
  const report = await runPublicFlowConformance();
  assert.equal(report.outcome, 'pass');
  assert.equal(report.cases.length, 6);
  assert.equal(report.evidence_class, 'synthetic-public-contract-fixtures');
});

test('output collection uses a real persisted Flow command receipt and preserves failure', async () => {
  const root = fixture();
  const spec = { id: 'capture-fixture', input: 'Fixture input', artifact_checks: [{ path: 'output.md' }] };
  const config = { identity: { revision: 'synthetic-fixture', model: 'none-fixture', harness: 'node-fixture' },
    budget: { max_tokens: 1 }, timeout_ms: 2000,
    argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("output.md", "observed output")', '{case_file}'] };
  try {
    const result = await captureRun({ caseSpec: spec, config, cwd: root });
    assert.equal(result.status, 'completed');
    assert.equal(result.artifacts['output.md'], 'observed output');
    assert.equal(result.execution.exit_code, 0);
    assert.match(result.execution.flow_run_id, /^aidlc-capture-/);
    await assert.rejects(captureRun({ caseSpec: spec, config: { ...config, argv: [process.execPath, '-e', 'process.exit(0)', '{case_file}'] }, cwd: root }), /already exists/);
    rmSync(join(root, 'output.md'));
    const failed = await captureRun({ caseSpec: spec, config: { ...config, argv: [process.execPath, '-e', 'process.exit(7)', '{case_file}'] }, cwd: root });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.execution.exit_code, 7);
    assert.equal(failed.economics, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
