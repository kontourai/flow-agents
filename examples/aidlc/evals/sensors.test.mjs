import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runStageSensors, parseUnitEdges, SENSOR_IDS, SENSOR_MANIFESTS } from '../scripts/sensors.mjs';
import { readSnapshot, digest } from '../scripts/compile.mjs';

const snapshot = readSnapshot();
const shape = '## Summary\nReal content.\n\n## Evidence\n';
function fixture(t, slug = 'user-stories') {
  const workspace = mkdtempSync(join(tmpdir(), 'kontour-sensor-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const stage = snapshot.stages.find((s) => s.slug === slug);
  const put = (path, text) => { mkdirSync(dirname(join(workspace, path)), { recursive: true }); writeFileSync(join(workspace, path), typeof text === 'string' ? text : JSON.stringify(text)); return path; };
  const artifacts = [];
  const context = { projectType: 'greenfield', skippedStages: ['practices-discovery', 'contract-design', 'units-generation', 'domain-design'].filter((id) => id !== slug), upstreamArtifacts: {} };
  const output = (name, text = shape) => { const path = put(`out/${name}.${name === 'traceability' ? 'json' : 'md'}`, text); artifacts.push({ id: name, stage: slug, path }); return path; };
  const upstream = (name, text = shape) => context.upstreamArtifacts[name] = put(`in/${name}.md`, text);
  const run = (runner) => runStageSensors({ stage, workspace, artifacts, context, commandRunner: runner });
  return { workspace, stage, put, output, upstream, artifacts, context, run };
}
const check = (result, id) => result.checks.find((c) => c.id === id);
const trace = (stage, upstream_ids, coverage, reverse = []) => ({ stage, upstream_ids, coverage, reverse });

test('all six upstream sensor identities are implemented', () => {
  assert.deepEqual([...new Set(snapshot.stages.flatMap((s) => s.sensors))].sort(), [...SENSOR_IDS].sort());
});
test('real authored IDs and existing targets pass with byte-bound references', async (t) => {
  const f = fixture(t);
  f.upstream('requirements', '## Functional\nFR1\nFR2\n## Nonfunctional\nNFR1');
  f.output('stories', `${shape}requirements\nUS1.1 AC1.1.1\nUS1.2 AC1.2.1`);
  f.output('traceability', trace('user-stories', ['FR1', 'FR2', 'NFR1'], ['FR1', 'FR2', 'NFR1'].map((id) => ({ id, status: 'OK', target: 'US1.1' }))));
  const result = await f.run();
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.ok(result.checks.every((c) => c.evidence_refs.length && c.evidence_refs.every((r) => /^[a-f0-9]{64}$/.test(r.sha256))));
});
test('omitted and invented upstream IDs cannot pass', async (t) => {
  const f = fixture(t);
  f.upstream('requirements', `${shape}FR1 FR2`);
  f.output('stories', `${shape}requirements US1.1`);
  f.output('traceability', trace('user-stories', ['FR1', 'FR999'], ['FR1', 'FR999'].map((id) => ({ id, status: 'OK', target: 'US1.1' }))));
  const result = check(await f.run(), 'traceability');
  assert.equal(result.status, 'fail');
  assert.ok(result.findings.some((s) => s.includes('FR2: omitted')));
  assert.ok(result.findings.some((s) => s.includes('FR999: unknown')));
});
test('fabricated downstream IDs, duplicate rows, open status sets and absent tables fail closed', async (t) => {
  const f = fixture(t); f.upstream('requirements', `${shape}FR1`); f.output('stories', `${shape}requirements US1.1`);
  const path = f.output('traceability', trace('user-stories', ['FR1'], [{ id: 'FR1', status: 'OK', target: 'US9.9' }]));
  assert.equal(check(await f.run(), 'traceability').status, 'fail');
  f.put(path, trace('user-stories', ['FR1'], [{ id: 'FR1', status: 'APPROVED', target: 'US1.1' }, { id: 'FR1', status: 'OK', target: 'US1.1' }]));
  assert.equal(check(await f.run(), 'traceability').status, 'fail');
  f.put(path, trace('user-stories', ['FR1'], []));
  assert.equal(check(await f.run(), 'traceability').status, 'fail');
});
test('missing headings and code-only fake headings fail shape sensor', async (t) => {
  const f = fixture(t, 'market-research');
  f.output('market-analysis', '## Only one\n```md\n## Fabricated second\n```');
  assert.equal(check(await f.run(), 'required-sections').status, 'fail');
});
test('templates bind to real headings and take precedence; markers keep their rules', async (t) => {
  const f = fixture(t, 'market-research');
  f.output('competitive-analysis', '## Competitive landscape\nContent');
  f.context.templates = { 'competitive-analysis': f.put('templates/competitive-analysis.md', '## Competitive landscape\n') };
  assert.equal(check(await f.run(), 'required-sections').status, 'pass');
  f.put('templates/competitive-analysis.md', '## Competitive landscape\n## Missing\n');
  assert.equal(check(await f.run(), 'required-sections').status, 'fail');
  const g = fixture(t, 'practices-discovery'); g.output('practices-discovery-timestamp', 'Discovered: today');
  assert.equal(check(await g.run(), 'required-sections').status, 'pass');
});
test('unit edge parser rejects missing dependencies, unknown fields, duplicate names and cycles', () => {
  const dag = (s) => `## Units\n## Dependencies\n\`\`\`yaml\nunits:\n${s}\n\`\`\``;
  assert.deepEqual(parseUnitEdges(dag('  - name: api\n    depends_on: []\n  - name: ui\n    depends_on: [api]')).map((u) => u.name), ['api', 'ui']);
  for (const body of ['  - name: api', '  - name: api\n    unknown: []', '  - name: api\n    depends_on: [missing]', '  - name: api\n    depends_on: []\n  - name: API\n    depends_on: []', '  - name: a\n    depends_on: [b]\n  - name: b\n    depends_on: [a]']) assert.throws(() => parseUnitEdges(dag(body)));
});
test('upstream coverage uses standalone identities, not kebab-token substrings', async (t) => {
  const f = fixture(t, 'user-stories'); f.upstream('requirements', `${shape}FR1`);
  const p = f.output('stories', `${shape}nfr-requirements US1.1`);
  assert.equal(check(await f.run(), 'upstream-coverage').status, 'fail');
  f.put(p, `${shape}requirements-analysis/requirements.md US1.1`);
  assert.equal(check(await f.run(), 'upstream-coverage').status, 'pass');
});
test('stale supplied digests and escaping symlinks cannot verify', async (t) => {
  const f = fixture(t, 'market-research'); const path = f.output('market-analysis');
  f.artifacts[0].digest = digest('older bytes');
  assert.equal((await f.run()).status, 'not_verified');
  const g = fixture(t, 'market-research'); symlinkSync(join(f.workspace, path), join(g.workspace, 'outside.md')); g.artifacts.push('outside.md');
  assert.equal((await g.run()).status, 'not_verified');
});
test('unsupported, omitted or reordered pinned sensor contracts cannot verify', async (t) => {
  const f = fixture(t); f.output('stories');
  for (const sensors of [['unsupported'], [], [...f.stage.sensors].reverse()]) {
    const result = await runStageSensors({ ...f, stage: { ...f.stage, sensors } });
    assert.equal(result.status, 'not_verified');
  }
});

function claimFixture(t) {
  const f = fixture(t, 'intent-capture');
  f.context.claims = { statePath: f.put('record/aidlc-state.md', '# State\nProject: Build a calendar\nScope: feature\nProject Description Source: project-description.json'), descriptionPath: f.put('record/project-description.json', JSON.stringify('Build a calendar')), questionsPath: f.put('record/intent-capture-questions.md', '## Sources\n- [desc] Initial description: "Build a calendar"\n- [scope] Workflow-selected scope: `feature`.\n\n## Q1: Users\n[Answer]: Team members\n\n## Assumption Confirmation\n- [assumption] Users have an account.\n[Answer]: A. Accept assumptions') };
  f.output('intent-statement', '## Intent\nBuild a calendar. [desc]\n\n## Initial Scope Signal\nFeature workflow. [scope]\n\n## Assumptions & Open Questions\n- [assumption] Users have an account.');
  f.output('stakeholder-map', '## Stakeholders\nTeam members. [Q1]\n\n## Assumptions & Open Questions\nNo other uncertainties. [Q1]');
  return f;
}
test('confirmed sources, answers and exact accepted assumptions pass', async (t) => {
  const f = claimFixture(t); const result = check(await f.run(), 'claim-sources');
  assert.equal(result.status, 'pass', JSON.stringify(result));
});
test('fabricated citations and invisible tags fail provenance', async (t) => {
  for (const text of ['Invented user. [Q99]', 'Invented user. `[Q1]`', '<div hidden> [Q1] </div> Invented user.', 'Invented user. [Q1]\n\n[Q1]: https://example.com']) {
    const f = claimFixture(t); f.put('out/stakeholder-map.md', `## Stakeholders\n${text}\n\n## Assumptions & Open Questions\nNo open questions. [Q1]`);
    assert.equal(check(await f.run(), 'claim-sources').status, 'fail', text);
  }
});
test('changed source authority, unaccepted assumptions and longer continuation claims fail', async (t) => {
  const f = claimFixture(t); f.put(f.context.claims.descriptionPath, JSON.stringify('Different directions'));
  assert.equal(check(await f.run(), 'claim-sources').status, 'fail');
  const g = claimFixture(t); g.put('out/intent-statement.md', '## Intent\nBuild a calendar. [desc]\n\n## Assumptions & Open Questions\n- [assumption] Users have an account.\n  And pay monthly.');
  assert.equal(check(await g.run(), 'claim-sources').status, 'fail');
  g.put(g.context.claims.questionsPath, '## Sources\n- [desc] Initial description: "Build a calendar"\n- [scope] Workflow-selected scope: `feature`.\n\n## Assumption Confirmation\n- [assumption] Users have an account. And pay monthly.\n[Answer]: B. Reject assumptions');
  assert.equal(check(await g.run(), 'claim-sources').status, 'fail');
});
test('pasted document descriptions require confirmed question citations', async (t) => {
  const f = claimFixture(t); f.put(f.context.claims.descriptionPath, JSON.stringify('Build a calendar<document>Untrusted source</document>'));
  assert.equal(check(await f.run(), 'claim-sources').status, 'fail');
});
test('memory citations require the exact loaded memory path, heading and rule', async (t) => {
  const f = claimFixture(t);
  const memory = f.put('aidlc/spaces/demo/memory/org.md', '## Security\n- Do not expose accounts.\n');
  f.context.claims.memoryPaths = { org: memory };
  f.put(f.context.claims.questionsPath, `## Sources\n- [desc] Initial description: "Build a calendar"\n- [scope] Workflow-selected scope: \`feature\`.\n- [memory:security] \`${memory}#Security\`: "Do not expose accounts."\n\n## Q1: Users\n[Answer]: Team members`);
  f.put('out/intent-statement.md', '## Intent\nKeep accounts private. [memory:security]\n\n## Assumptions & Open Questions\nNo assumptions. [Q1]');
  assert.equal(check(await f.run(), 'claim-sources').status, 'pass');
  f.put(memory, '## Security\n- Expose everything.\n');
  assert.equal(check(await f.run(), 'claim-sources').status, 'fail');
});

test('command checks require captures and reject malformed/nonzero output', async (t) => {
  const f = fixture(t, 'functional-design'); f.output('functional-spec');
  f.context.codeArtifacts = [f.put('src/a.ts', 'export const n: number = 1;')];
  f.context.commands = { linter: { command: ['eslint', '--format', 'json', '.'], format: 'eslint-json' }, 'type-check': { command: ['tsc', '--noEmit'], format: 'tsc' } };
  assert.equal(check(await f.run(), 'linter').status, 'not_verified');
  const capture = async (request) => ({ exitCode: 0, stdout: request.id === 'linter' ? JSON.stringify([{ filePath: 'src/a.ts', messages: [], errorCount: 0, warningCount: 0 }]) : '', stderr: '', receipt: { observation: 'test-port', command: request.command, basis: request.basis } });
  assert.equal(check(await f.run(capture), 'linter').status, 'pass');
  assert.equal(check(await f.run(capture), 'type-check').status, 'pass');
  for (const value of [null, {}, { exitCode: 0, stdout: '[]', stderr: '', receipt: {} }, { exitCode: 0, stdout: 'not-json', stderr: '', receipt: {} }]) assert.equal(check(await f.run(async () => value), 'linter').status, 'not_verified');
  assert.equal(check(await f.run(async () => ({ exitCode: 2, stdout: '', stderr: 'Compile failed', receipt: {} })), 'type-check').status, 'fail');
});
test('a command that changes sensed bytes invalidates the gate basis', async (t) => {
  const f = fixture(t, 'functional-design'); const path = f.output('functional-spec');
  f.context.codeArtifacts = [f.put('src/a.js', 'export const n = 1;')];
  f.context.commands = { linter: { command: ['lint'], format: 'exit-code' } };
  const result = await f.run(async () => { f.put(path, 'Changed'); return { exitCode: 0, stdout: '', stderr: '', receipt: { observation: 'test-port' } }; });
  assert.notEqual(result.status, 'pass');
  assert.equal(check(result, 'basis-current').status, 'not_verified');
});
test('functional-design derives unreported rule orphans', async (t) => {
  const f = fixture(t, 'functional-design'); f.upstream('requirements', `${shape}FR1`);
  f.output('rules', `${shape}BR1.1 BR1.2`);
  f.output('traceability', trace('functional-design', ['FR1'], [{ id: 'FR1', status: 'OK', target: 'BR1.1' }]));
  assert.ok(check(await f.run(), 'traceability').findings.some((s) => s === 'BR1.2: derived orphan'));
});
test('heading decorations cannot widen the exact Review exemption or hide claims behind deeper headings', async (t) => {
  for (const section of ['### Nested heading\nUncited claim.', '## ℹ️ Review\nUncited claim.']) {
    const f = claimFixture(t);
    f.put('out/stakeholder-map.md', `## Stakeholders\nConfirmed users. [Q1]\n${section}\n\n## Assumptions & Open Questions\nNo assumptions. [Q1]`);
    assert.equal(check(await f.run(), 'claim-sources').status, 'fail');
  }
  const f = claimFixture(t);
  f.put('out/stakeholder-map.md', '## ℹ️ Stakeholders\nConfirmed users. [Q1]\n## ℹ️ Assumptions & Open Questions\nNo assumptions. [Q1]');
  assert.equal(check(await f.run(), 'claim-sources').status, 'pass');
});
test('domain-design uses stories when present and otherwise FR requirements', async (t) => {
  const f = fixture(t, 'domain-design'); f.upstream('requirements', `${shape}FR1`);
  const p = f.output('traceability', trace('domain-design', ['FR1'], [{ id: 'FR1', status: 'OK', target: 'Account component' }]));
  assert.equal(check(await f.run(), 'traceability').status, 'pass');
  f.upstream('stories', `${shape}US1.1`);
  assert.equal(check(await f.run(), 'traceability').status, 'fail');
  f.put(p, trace('domain-design', ['US1.1'], [{ id: 'US1.1', status: 'OK', target: 'Account component' }]));
  assert.equal(check(await f.run(), 'traceability').status, 'pass');
});
test('units-generation joins coverage to the authored DAG and story-to-unit mapping', async (t) => {
  const f = fixture(t, 'units-generation'); f.upstream('requirements', `${shape}FR1 FR2`);
  f.output('unit-of-work', `${shape}\n| ID | Unit |\n| -- | -- |\n| U1 | api |\n| U2 | ui |`);
  f.output('unit-of-work-dependency', `${shape}\n\`\`\`yaml\nunits:\n  - name: "api"\n    kind: 'service'\n    depends_on: []\n  - name: ui\n    depends_on: ['api'] # dependency\n\`\`\``);
  f.output('unit-of-work-story-map', `${shape}\n| Requirement | Unit |\n| -- | -- |\n| FR1 | U1 |\n| FR2 | ui |`);
  const p = f.output('traceability', trace('units-generation', ['FR1', 'FR2'], [{ id: 'FR1', status: 'OK', target: 'U1' }, { id: 'FR2', status: 'OK', target: 'ui' }]));
  assert.equal(check(await f.run(), 'traceability').status, 'pass');
  f.put(p, trace('units-generation', ['FR1', 'FR2'], [{ id: 'FR1', status: 'OK', target: 'ui' }, { id: 'FR2', status: 'OK', target: 'api' }]));
  assert.equal(check(await f.run(), 'traceability').status, 'fail');
});
test('functional-design and code-generation resolve per-unit acceptance criteria rather than all story IDs', async (t) => {
  for (const stage of ['functional-design', 'code-generation']) {
    const f = fixture(t, stage); f.context.unit = 'api';
    f.context.skippedStages = f.context.skippedStages.filter((id) => id !== 'units-generation');
    f.upstream('stories', `${shape}US1.1 AC1.1.1\nUS1.2 AC1.2.1`);
    f.upstream('unit-of-work-dependency', `${shape}\n\`\`\`yaml\nunits:\n  - name: api\n    depends_on: []\n  - name: ui\n    depends_on: [api]\n\`\`\``);
    f.upstream('unit-of-work-story-map', `${shape}\n| Story | Unit |\n| -- | -- |\n| US1.1 | api |\n| US1.2 | ui |`);
    if (stage === 'functional-design') f.output('rules', `${shape}BR1.1`);
    else f.put('src/api.mjs', 'export const actual = true;');
    const p = f.output('traceability', { ...trace(stage, ['AC1.1.1'], [{ id: 'AC1.1.1', status: 'OK', target: stage === 'functional-design' ? 'BR1.1' : 'src/api.mjs' }]), unit: 'api' });
    assert.equal(check(await f.run(), 'traceability').status, 'pass');
    f.put(p, { ...trace(stage, ['AC1.1.1', 'AC1.2.1'], [{ id: 'AC1.1.1', status: 'OK', target: stage === 'functional-design' ? 'BR1.1' : 'src/api.mjs' }, { id: 'AC1.2.1', status: 'OK', target: 'Invented' }]), unit: 'api' });
    assert.equal(check(await f.run(), 'traceability').status, 'fail');
  }
});
test('NFR traceability selects detailed source stage IDs and explicitly skipped fallback', async (t) => {
  const f = fixture(t, 'nfr-requirements'); f.upstream('requirements', `${shape}FR1 NFR1 NFR2`);
  f.output('traceability', trace('nfr-requirements', ['NFR1', 'NFR2'], [{ id: 'NFR1', status: 'OK', target: 'Latency target' }, { id: 'NFR2', status: 'Deferred', target: 'Accepted future scope' }]));
  assert.equal(check(await f.run(), 'traceability').status, 'pass');
  for (const stage of ['nfr-design', 'infrastructure-design']) {
    const g = fixture(t, stage); g.upstream('requirements', `${shape}NFR1`);
    g.upstream(stage === 'nfr-design' ? 'performance-requirements' : 'performance-design', `${shape}NFR1.1 NFR1.2`);
    const p = g.output('traceability', trace(stage, ['NFR1.1', 'NFR1.2'], [{ id: 'NFR1.1', status: 'OK', target: 'Service resources' }, { id: 'NFR1.2', status: 'N/A', target: 'Accepted exclusion' }]));
    assert.equal(check(await g.run(), 'traceability').status, 'pass');
    g.context.skippedStages.push('nfr-requirements', 'nfr-design');
    g.put(p, trace(stage, ['NFR1'], [{ id: 'NFR1', status: 'OK', target: 'Service resources' }]));
    assert.equal(check(await g.run(), 'traceability').status, 'pass');
  }
});
test('code targets must be real files inside the workspace', async (t) => {
  const f = fixture(t, 'code-generation'); f.upstream('requirements', `${shape}FR1`);
  const p = f.output('traceability', trace('code-generation', ['FR1'], [{ id: 'FR1', status: 'OK', target: 'src/actual.js' }]));
  assert.equal(check(await f.run(), 'traceability').status, 'fail');
  f.put('src/actual.js', 'export const implemented = true;');
  assert.equal(check(await f.run(), 'traceability').status, 'pass');
  f.put(p, trace('code-generation', ['FR1'], [{ id: 'FR1', status: 'OK', target: '../outside.js' }]));
  assert.equal(check(await f.run(), 'traceability').status, 'fail');
});
test('linter errors and dishonest diagnostic counts cannot pass with zero exit', async (t) => {
  const f = fixture(t, 'ci-pipeline'); f.output('ci-pipeline');
  f.context.codeArtifacts = [f.put('src/a.ts', 'export const n: number = 1;')];
  f.context.commands = { linter: { command: ['eslint', '--format', 'json', '.'], format: 'eslint-json' } };
  for (const diagnostics of [
    [{ filePath: 'src/a.ts', messages: [{ message: 'Forbidden variable', severity: 2, line: 1, ruleId: 'forbidden' }], errorCount: 1, warningCount: 0 }],
    [{ filePath: 'src/a.ts', messages: [], errorCount: 2, warningCount: 0 }],
  ]) {
    const result = await f.run(async () => ({ exitCode: 0, stdout: JSON.stringify(diagnostics), stderr: '', receipt: { observation: 'test-port' } }));
    assert.equal(check(result, 'linter').status, 'fail');
  }
});
test('pinned manifests retain gate/write scope and exact language extension matchers', () => {
  assert.equal(SENSOR_MANIFESTS['required-sections'].fire_on, 'gate');
  assert.equal(SENSOR_MANIFESTS['claim-sources'].fire_on, 'gate');
  assert.equal(SENSOR_MANIFESTS.traceability.matches, '**/traceability.json');
  assert.equal(SENSOR_MANIFESTS.linter.matches, '**/*.{ts,js}');
  assert.equal(SENSOR_MANIFESTS['type-check'].matches, '**/*.{ts,tsx}');
});
test('Markdown samples, YAML and unmatched source extensions do not fire code sensors', async (t) => {
  const f = fixture(t, 'ci-pipeline');
  f.output('ci-pipeline', `${shape}\n\`\`\`typescript\nconst bad: number = "wrong";\n\`\`\``);
  f.context.codeArtifacts = [f.put('ci/workflow.yaml', 'jobs: {}'), f.put('src/program.mjs', 'export const js = true;'), f.put('src/program.jsx', 'export const jsx = true;')];
  f.put('tsconfig.json', '{"compilerOptions":{"strict":true}}');
  let invoked = false;
  const result = await f.run(async () => { invoked = true; throw new Error('Must not invoke'); });
  assert.equal(check(result, 'linter').status, 'not_applicable');
  assert.equal(check(result, 'type-check').status, 'not_applicable');
  assert.equal(invoked, false);
});
test('JavaScript files fire linter but do not synthesize a type-check policy', async (t) => {
  const f = fixture(t, 'functional-design'); f.output('functional-spec');
  f.context.codeArtifacts = [f.put('src/app.js', 'export const n = 1;')];
  const result = await f.run();
  assert.equal(check(result, 'linter').status, 'not_verified');
  assert.equal(check(result, 'type-check').status, 'not_applicable');
});
test('TSX fires type-check but not the pinned ts/js linter matcher', async (t) => {
  const f = fixture(t, 'functional-design'); f.output('functional-spec');
  f.context.codeArtifacts = [f.put('src/app.tsx', 'export const n: number = 1;')];
  const result = await f.run();
  assert.equal(check(result, 'linter').status, 'not_applicable');
  assert.equal(check(result, 'type-check').status, 'not_verified');
});
test('real TypeScript output fails closed when capture or policy is unavailable, and syntax is not type proof', async (t) => {
  const f = fixture(t, 'build-and-test'); f.output('build-and-test-summary');
  f.context.codeArtifacts = [f.put('src/app.ts', 'export const n: number = "wrong";')];
  assert.equal(check(await f.run(), 'type-check').status, 'not_verified');
  f.context.commands = { 'type-check': { command: ['node', '--check', 'src/app.ts'], format: 'exit-code' } };
  let invoked = false;
  const result = await f.run(async () => { invoked = true; return { exitCode: 0, stdout: '', stderr: '', receipt: { observed: true } }; });
  assert.equal(check(result, 'type-check').status, 'not_verified');
  assert.equal(invoked, false);
});
test('warning-only lint receipts preserve upstream warning advisory behavior', async (t) => {
  const f = fixture(t, 'functional-design'); f.output('functional-spec');
  f.context.codeArtifacts = [f.put('src/app.js', 'export const n = 1;')];
  f.context.commands = { linter: { command: ['eslint', '--format', 'json', 'src/app.js'], format: 'eslint-json' } };
  const result = await f.run(async () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify([{ filePath: 'src/app.js', messages: [{ message: 'Unused', severity: 1 }], errorCount: 0, warningCount: 1 }]), receipt: { observed: true } }));
  assert.equal(check(result, 'linter').status, 'pass');
});
test('zero-unit bugfix and express trace directly to requirements without absent Units or Stories', async (t) => {
  for (const profile of ['bugfix', 'express']) {
    const f = fixture(t, 'code-generation');
    f.context.skippedStages = snapshot.stages.filter((s) => !snapshot.profiles[profile].stages.includes(s.slug)).map((s) => s.slug);
    f.upstream('requirements', `${shape}FR1 NFR1`);
    f.put('src/fix.js', 'export const fixed = true;');
    f.output('traceability', trace('code-generation', ['FR1', 'NFR1'], ['FR1', 'NFR1'].map((id) => ({ id, status: 'OK', target: 'src/fix.js' }))));
    assert.equal(check(await f.run(), 'traceability').status, 'pass');
  }
});
test('skipped Units cannot lend stale DAG or story assignments to zero-unit traceability', async (t) => {
  const f = fixture(t, 'functional-design');
  f.upstream('requirements', `${shape}FR1`);
  f.upstream('stories', `${shape}US1.1 AC1.1.1`);
  f.upstream('unit-of-work-dependency', 'Malformed stale DAG from a previous scope');
  f.upstream('unit-of-work-story-map', `${shape}\n| US1.1 | stale-unit |`);
  f.output('rules', `${shape}BR1.1`);
  f.output('traceability', trace('functional-design', ['FR1'], [{ id: 'FR1', status: 'OK', target: 'BR1.1' }]));
  assert.equal(check(await f.run(), 'traceability').status, 'pass');
});
test('bootstrap stages with no sensors and no markdown outputs pass their empty sensor set', async (t) => {
  for (const slug of ['workspace-scaffold', 'workspace-detection', 'state-init']) {
    const f = fixture(t, slug);
    const result = await f.run();
    assert.equal(result.status, 'pass');
    assert.deepEqual(result.checks, []);
  }
});
test('inapplicable code checks do not make otherwise valid gate sensor results unavailable', async (t) => {
  const f = fixture(t, 'build-and-test');
  for (const name of ['code-generation-plan', 'unit-test-instructions', 'code-summary']) f.upstream(name);
  f.output('build-and-test-summary', `${shape}code-generation-plan unit-test-instructions code-summary`);
  const result = await f.run();
  assert.equal(check(result, 'type-check').status, 'not_applicable');
  assert.equal(result.status, 'pass');
});
test('an explicit Kontour source-write policy requires lint capture for code-generation JavaScript', async (t) => {
  const f = fixture(t, 'code-generation'); f.upstream('requirements', `${shape}FR1`);
  const code = f.put('src/app.js', 'export const implemented = true;');
  f.output('code-summary');
  f.output('traceability', trace('code-generation', ['FR1'], [{ id: 'FR1', status: 'OK', target: code }]));
  f.context.codeArtifacts = [{ path: code, digest: digest('export const implemented = true;') }];
  const pinned = [...f.stage.sensors];
  const nativeDefault = await f.run();
  assert.equal(nativeDefault.status, 'pass');
  assert.equal(check(nativeDefault, 'linter'), undefined);
  assert.equal(check(nativeDefault, 'type-check'), undefined);
  f.context.writeSensorPolicy = 'all_actual_source_writes';
  const unavailable = await f.run();
  assert.equal(check(unavailable, 'linter').status, 'not_verified');
  assert.equal(check(unavailable, 'linter').trigger_origin, 'kontour-source-write-policy');
  assert.equal(check(unavailable, 'type-check').status, 'not_applicable');
  assert.equal(unavailable.status, 'not_verified');
  f.context.commands = { linter: { command: ['eslint', '--format', 'json', code], format: 'eslint-json' } };
  let captured = 0;
  const verified = await f.run(async (request) => {
    captured++; assert.equal(request.id, 'linter'); assert.ok(request.files.includes(code));
    assert.ok(request.basis.some(ref => ref.path === code && ref.sha256 === digest('export const implemented = true;')));
    return { exitCode: 0, stdout: JSON.stringify([{ filePath: code, messages: [], errorCount: 0, warningCount: 0 }]), stderr: '', receipt: { observation: 'isolated-test-port', command: request.command } };
  });
  assert.equal(verified.status, 'pass', JSON.stringify(verified));
  assert.equal(captured, 1);
  assert.deepEqual(f.stage.sensors, pinned);
});
test('an explicit source-write policy requires both distinct command-backed checks for code-generation TypeScript', async (t) => {
  const f = fixture(t, 'code-generation'); f.upstream('requirements', `${shape}FR1`);
  const code = f.put('src/app.ts', 'export const implemented: boolean = true;');
  f.output('traceability', trace('code-generation', ['FR1'], [{ id: 'FR1', status: 'OK', target: code }]));
  f.context.codeArtifacts = [code];
  const nativeDefault = await f.run();
  assert.equal(nativeDefault.status, 'pass');
  assert.equal(check(nativeDefault, 'linter'), undefined);
  assert.equal(check(nativeDefault, 'type-check'), undefined);
  f.context.writeSensorPolicy = 'all_actual_source_writes';
  const unavailable = await f.run();
  assert.equal(check(unavailable, 'linter').status, 'not_verified');
  assert.equal(check(unavailable, 'type-check').status, 'not_verified');
  f.context.commands = { linter: { command: ['eslint', '--format', 'json', code], format: 'eslint-json' }, 'type-check': { command: ['tsc', '--noEmit'], format: 'tsc' } };
  const calls = [];
  const verified = await f.run(async (request) => {
    calls.push(request.id);
    return { exitCode: 0, stdout: request.id === 'linter' ? JSON.stringify([{ filePath: code, messages: [], errorCount: 0, warningCount: 0 }]) : '', stderr: '', receipt: { observation: 'isolated-test-port', command: request.command } };
  });
  assert.equal(verified.status, 'pass');
  assert.deepEqual(calls, ['linter', 'type-check']);
  assert.equal(verified.checks.filter(c => c.id === 'linter').length, 1);
  const failed = await f.run(async (request) => ({ exitCode: request.id === 'type-check' ? 2 : 0, stdout: request.id === 'linter' ? JSON.stringify([{ filePath: code, messages: [], errorCount: 0, warningCount: 0 }]) : '', stderr: 'Actual checker failure fixture', receipt: { observation: 'isolated-test-port' } }));
  assert.equal(failed.status, 'fail');
  assert.equal(check(failed, 'type-check').status, 'fail');
});
test('code-generation mjs writes match neither pinned code matcher and do not execute a substitute checker', async (t) => {
  const f = fixture(t, 'code-generation'); f.upstream('requirements', `${shape}FR1`);
  const code = f.put('src/app.mjs', 'export const implemented = true;');
  f.output('traceability', trace('code-generation', ['FR1'], [{ id: 'FR1', status: 'OK', target: code }]));
  f.context.codeArtifacts = [code];
  f.context.writeSensorPolicy = 'all_actual_source_writes';
  let invoked = false;
  const result = await f.run(async () => { invoked = true; throw new Error('Unmatched extension must not execute'); });
  assert.equal(result.status, 'pass');
  assert.equal(check(result, 'linter').status, 'not_applicable');
  assert.equal(check(result, 'type-check').status, 'not_applicable');
  assert.equal(invoked, false);
});
test('actual source-write checks union with declared imports without duplicate execution', async (t) => {
  const f = fixture(t, 'ci-pipeline'); f.output('ci-pipeline');
  f.context.codeArtifacts = [f.put('src/app.ts', 'export const n: number = 1;')];
  f.context.writeSensorPolicy = 'all_actual_source_writes';
  const result = await f.run();
  assert.equal(result.checks.filter(c => c.id === 'linter').length, 1);
  assert.equal(result.checks.filter(c => c.id === 'type-check').length, 1);
  assert.equal(check(result, 'linter').trigger_origin, 'native-stage-contract');
});
