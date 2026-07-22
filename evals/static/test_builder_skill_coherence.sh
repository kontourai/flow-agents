#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

node - "$ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const kit = JSON.parse(fs.readFileSync(path.join(root, 'kits/builder/kit.json'), 'utf8'));
const buildFlow = JSON.parse(fs.readFileSync(path.join(root, 'kits/builder/flows/build.flow.json'), 'utf8'));
const executeGate = buildFlow.gates?.['execute-gate'];
if (JSON.stringify(executeGate?.on_route_back) !== JSON.stringify({ plan_gap: 'plan' })) {
  throw new Error('execute-gate must declare exactly plan_gap -> plan');
}
if (JSON.stringify(executeGate?.route_back_policy) !== JSON.stringify({ max_attempts: 3, on_exceeded: 'block' })) {
  throw new Error('execute-gate must bound plan_gap with the Flow-owned 3-attempt block policy');
}

const expected = {
  'builder-shape': ['entrypoint', 'builder.shape', []],
  deliver: ['entrypoint', 'builder.build', []],
  'fix-bug': ['profile', 'builder.build', []],
  'tdd-workflow': ['profile', 'builder.build', []],
  'idea-to-backlog': ['step', 'builder.shape', ['shape', 'breakdown', 'file-issues']],
  'pull-work': ['step', 'builder.build', ['pull-work']],
  'pickup-probe': ['step', 'builder.build', ['design-probe']],
  'plan-work': ['step', 'builder.build', ['plan']],
  'execute-plan': ['step', 'builder.build', ['execute']],
  'review-work': ['step', 'builder.build', ['verify']],
  'verify-work': ['step', 'builder.build', ['verify']],
  'evidence-gate': ['step', 'builder.build', ['merge-ready']],
  'release-readiness': ['step', 'builder.publish-learn', ['merge-ready-ci']],
  'learning-review': ['step', 'builder.publish-learn', ['learn']],
  'design-probe': ['shared-primitive', null, []],
  'continue-work': ['extension', null, []],
  'gate-review': ['extension', null, []],
};
const expectedExpectations = {
  'idea-to-backlog': ['shaped-problem', 'shaped-outcome', 'shaped-constraints', 'shaped-non-goals', 'shaped-success', 'shaped-risk', 'open-decisions', 'slices-defined', 'work-items-filed'],
  'pull-work': ['selected-work'],
  'pickup-probe': ['pickup-probe-readiness', 'probe-decisions-or-accepted-gaps'],
  'plan-work': ['implementation-plan'],
  'execute-plan': ['implementation-scope'],
  'review-work': ['clean-critique'],
  'verify-work': ['acceptance-criteria', 'tests-evidence', 'policy-compliance'],
  'evidence-gate': ['merge-readiness'],
  'release-readiness': ['ci-merge-readiness'],
  'learning-review': ['decision-evidence', 'learning-evidence'],
};
const expectedArtifacts = {
  'idea-to-backlog': ['<slug>--idea-to-backlog.md', 'trust.bundle#builder.shape'],
  'pull-work': ['<slug>--pull-work.md', 'trust.bundle#selected-work'],
  'pickup-probe': ['<slug>--pull-work.md', 'trust.bundle#pickup-probe'],
  'plan-work': ['<slug>--plan-work.md', 'acceptance.json', 'handoff.json', 'trust.bundle#implementation-plan'],
  'execute-plan': ['<slug>--deliver.md', 'state.json', 'trust.bundle#implementation-scope'],
  'review-work': ['trust.bundle#critique'],
  'verify-work': ['trust.bundle#acceptance-criteria', 'trust.bundle#tests-evidence', 'trust.bundle#policy-compliance'],
  'evidence-gate': ['<slug>--evidence-gate.md', 'trust.bundle#merge-readiness'],
  'release-readiness': ['release.json', 'trust.bundle#ci-merge-readiness'],
  'learning-review': ['learning.json', 'trust.bundle#decision-evidence', 'trust.bundle#learning-evidence'],
  'gate-review': ['<slug>--gate-review.md', 'gate-review.inquiries.json'],
};
const expectedActions = {
  'builder.build/pull-work': { skills: ['pull-work'], expectation_ids: ['selected-work'] },
  'builder.build/design-probe': { skills: ['pickup-probe'], expectation_ids: ['pickup-probe-readiness', 'probe-decisions-or-accepted-gaps'] },
  'builder.build/plan': { skills: ['plan-work'], expectation_ids: ['implementation-plan'] },
  'builder.build/execute': { skills: ['execute-plan'], expectation_ids: ['implementation-scope'] },
  'builder.build/verify': { skills: ['review-work', 'verify-work'], expectation_ids: ['clean-critique', 'acceptance-criteria', 'tests-evidence', 'policy-compliance'] },
  'builder.build/merge-ready': { skills: ['evidence-gate'], expectation_ids: ['merge-readiness'] },
  'builder.build/pr-open': { skills: [], operations: ['publish-change'], expectation_ids: ['pull-request-opened'] },
  'builder.build/merge-ready-ci': { skills: ['release-readiness'], expectation_ids: ['ci-merge-readiness'] },
  'builder.build/learn': { skills: ['learning-review'], expectation_ids: ['decision-evidence', 'learning-evidence'] },
  'builder.build/done': { skills: [], expectation_ids: [] },
  'builder.shape/shape': { skills: ['idea-to-backlog'], expectation_ids: ['shaped-problem', 'shaped-outcome', 'shaped-constraints', 'shaped-non-goals', 'shaped-success', 'shaped-risk', 'open-decisions'] },
  'builder.shape/breakdown': { skills: ['idea-to-backlog'], expectation_ids: ['slices-defined'] },
  'builder.shape/file-issues': { skills: ['idea-to-backlog'], expectation_ids: ['work-items-filed'] },
  'builder.shape/shape-done': { skills: [], expectation_ids: [] },
};

const failures = [];
const rows = Array.isArray(kit.skill_roles) ? kit.skill_roles : [];
const declared = (kit.skills || []).map((entry) => entry.id.replace(/^builder\./, '')).sort();
const classified = rows.map((entry) => entry.skill_id.replace(/^builder\./, '')).sort();
if (JSON.stringify(declared) !== JSON.stringify(classified)) failures.push('skill_roles must classify every declared Builder skill exactly once');
if (rows.length !== 17) failures.push(`skill_roles must contain 17 rows, found ${rows.length}`);

for (const [skill, [role, flow, steps]] of Object.entries(expected)) {
  const row = rows.find((entry) => entry.skill_id === `builder.${skill}`);
  if (!row) {
    failures.push(`${skill}: missing role row`);
    continue;
  }
  if (row.role !== role || (row.flow_id ?? null) !== flow || JSON.stringify(row.step_ids) !== JSON.stringify(steps)) {
    failures.push(`${skill}: expected ${role}/${flow ?? 'standalone'}/${steps.join(',') || 'no-steps'}`);
  }
  if (Object.hasOwn(expectedExpectations, skill) && JSON.stringify(row.expectation_ids) !== JSON.stringify(expectedExpectations[skill])) {
    failures.push(`${skill}: expectation ownership differs from the exact producer matrix`);
  }
  if (Object.hasOwn(expectedArtifacts, skill) && JSON.stringify(row.artifacts) !== JSON.stringify(expectedArtifacts[skill])) {
    failures.push(`${skill}: durable artifact ownership differs from the exact producer matrix`);
  }
  const file = path.join(root, 'kits/builder/skills', skill, 'SKILL.md');
  const text = fs.readFileSync(file, 'utf8');
  const rolePattern = role === 'shared-primitive' ? /shared.{0,30}primitive/i : new RegExp(role, 'i');
  if (!rolePattern.test(text)) failures.push(`${skill}: skill contract does not state role ${role}`);
  if (!/artifact|produces|output/i.test(text)) failures.push(`${skill}: skill contract does not state artifact/output responsibility`);
  for (const expectation of row.expectation_ids || []) {
    if (!text.includes(expectation)) failures.push(`${skill}: missing owned expectation ${expectation}`);
  }
  const forbidden = [
    ['private workflow writer', /npm run workflow:sidecar|flow-agents-workflow-sidecar|flow-agents builder-run|\bworkflow-sidecar\b/],
    ['Flow Agents-only dogfood operation', /\bdogfood-pass\b/],
    ['template context placeholder', /\{context\?\}/],
    ['direct ad-hoc Builder entry', /--ad-hoc-reason|\bad_hoc_entry\b|Ad-hoc Direct Entry/i],
    ['fixed worker count', /\bx4\b|tool-worker\s*\(x4\)/i],
    ['fixed 80 percent coverage policy', /(?:coverage.{0,30}(?:>=|<|of)\s*80%|80%\s+(?:test\s+)?coverage)/i],
    ['obsolete Phase-1 dependency', /ADR 0010 Phase 1|Phase-1 dependency/i],
    ['direct GitHub CLI contract', /(^|[\s`])gh\s+(?:api|issue|pr|project|repo|run|workflow)\b/m],
    ['shell interpolation placeholder', /--(?:summary|source-request)\s+"</],
    ['retired critique sidecar', /critique\.json/i],
    ['retired verification sidecar', /evidence\.json/i],
  ];
  for (const [label, pattern] of forbidden) if (pattern.test(text)) failures.push(`${skill}: contains ${label}`);
  for (const match of text.matchAll(/--evidence-ref-json\s+'([^']+)'/g)) {
    try {
      const ref = JSON.parse(match[1]);
      if (ref.kind === 'artifact' && (typeof ref.file !== 'string' || (!ref.summary && !ref.excerpt))) {
        failures.push(`${skill}: artifact evidence JSON must include file and summary or excerpt`);
      }
    } catch {
      failures.push(`${skill}: --evidence-ref-json example is not valid JSON`);
    }
  }
  const mayAttach = new Set(['idea-to-backlog', 'pickup-probe', 'plan-work', 'execute-plan', 'verify-work', 'evidence-gate', 'release-readiness', 'learning-review']);
  if (mayAttach.has(skill) && !text.includes('flow-agents workflow evidence')) failures.push(`${skill}: active Flow evidence must use the public CLI`);
  if ((role === 'entrypoint' || role === 'profile' || role === 'shared-primitive' || role === 'extension') && text.includes('flow-agents workflow evidence')) {
    failures.push(`${skill}: role must not claim a Flow expectation`);
  }
}

for (const row of rows) {
  if (row.role === 'step' && (row.artifacts || []).some((artifact) => artifact === 'evidence.json' || artifact === 'critique.json')) {
    failures.push(`${row.skill_id}: retired verification or critique sidecar must remain absent`);
  }
}

const skillText = (skill) => fs.readFileSync(path.join(root, 'kits/builder/skills', skill, 'SKILL.md'), 'utf8');
for (const [key, expectedAction] of Object.entries(expectedActions)) {
  const action = (kit.flow_step_actions || []).find((entry) => `${entry.flow_id}/${entry.step_id}` === key);
  if (!action) {
    failures.push(`${key}: missing flow_step_actions row`);
    continue;
  }
  for (const field of ['skills', 'expectation_ids']) {
    if (JSON.stringify(action[field] || []) !== JSON.stringify(expectedAction[field] || [])) {
      failures.push(`${key}: ${field} differs from the canonical producer matrix`);
    }
  }
  if (expectedAction.operations && JSON.stringify(action.operations || []) !== JSON.stringify(expectedAction.operations)) {
    failures.push(`${key}: operations differ from the canonical producer matrix`);
  }
}
if ((kit.flow_step_actions || []).length !== Object.keys(expectedActions).length) failures.push('flow_step_actions must declare every builder.build and builder.shape step exactly once');
const publishAction = (kit.flow_step_actions || []).find((entry) => entry.flow_id === 'builder.build' && entry.step_id === 'pr-open');
if (!publishAction || JSON.stringify(publishAction.operations) !== JSON.stringify(['publish-change']) || JSON.stringify(publishAction.expectation_ids) !== JSON.stringify(['pull-request-opened'])) failures.push('publish-change must explicitly own pull-request-opened');

const review = skillText('review-work');
if (!review.includes('flow-agents workflow critique')) failures.push('review-work: active critique must use the public workflow critique operation');
if (!/delegated reviewer must invoke this operation under its own runtime actor\s+identity/i.test(review) || !/rejects the assigned implementation actor/i.test(review) || /--reviewer/.test(review)) failures.push('review-work: critique must use a distinct delegated reviewer identity without a caller-selected reviewer flag');
const verify = skillText('verify-work');
const verifyCommandRefs = verify.match(/"kind":"command","excerpt":"npm test"/g) || [];
if (verifyCommandRefs.length < 2 || !/--command\s+"npm test"/.test(verify) || !/Repeat `--command`/.test(verify) || !/--criterion-json/.test(verify) || !/tests-evidence/.test(verify)) failures.push('verify-work: tests-evidence must include matching top-level and criterion command refs and support repeatable commands');
const reviewRole = rows.find((entry) => entry.skill_id === 'builder.review-work');
const verifyRole = rows.find((entry) => entry.skill_id === 'builder.verify-work');
if (JSON.stringify(reviewRole?.expectation_ids) !== JSON.stringify(['clean-critique']) || !/clean-critique/.test(review)) failures.push('review-work: must exclusively own clean-critique through the critique contract');
if (JSON.stringify(verifyRole?.expectation_ids) !== JSON.stringify(['acceptance-criteria', 'tests-evidence', 'policy-compliance']) || !/acceptance-criteria/.test(verify) || !/tests-evidence/.test(verify) || !/policy-compliance/.test(verify)) failures.push('verify-work: must own acceptance-criteria, tests-evidence, and policy-compliance');
const shapeEntrypoint = skillText('builder-shape');
if (!/workflow start --flow builder\.shape/.test(shapeEntrypoint) || !/safe explicit slug/i.test(shapeEntrypoint)) failures.push('builder-shape: must document public shape start with a safe explicit slug');
const deliver = skillText('deliver');
if (!/--work-item <provider-ref>/.test(deliver) || !/human-readable provider reference/i.test(deliver)) failures.push('deliver: start must accept a human-readable provider reference');
if (/owner\/(?:repository|repo)#(?:<numeric-id>|\d+)/i.test(deliver)) failures.push('deliver: must not restrict Work Item references to GitHub owner/repository numeric syntax');
if (!/workflow status --session-dir <session-dir> --json/.test(deliver) || !/exact idempotent command/i.test(deliver)) failures.push('deliver: interrupted runs must use public status and the projected recovery command');
if (/flow-agents workflow resume --session-dir <session-dir>(?! --reason)/.test(deliver)) failures.push('deliver: resume must require --reason');
const continuation = rows.find((entry) => entry.skill_id === 'builder.continue-work');
if (!continuation || continuation.artifacts.length !== 0 || !/ephemeral/i.test(skillText('continue-work'))) failures.push('continue-work: artifact metadata and handoff contract must be empty/ephemeral');

const runtimeSpec = fs.readFileSync(path.join(root, 'docs/spec/builder-flow-runtime.md'), 'utf8');
if (!/workflow status --session-dir \.kontourai\/flow-agents\/<slug> --json/.test(runtimeSpec) || !/workflow resume --session-dir \.kontourai\/flow-agents\/<slug> --reason <text>/.test(runtimeSpec)) failures.push('builder runtime spec: recovery must use the public status and paused-run resume contract');
if (/builder-run (?:sync|recover)/.test(runtimeSpec) || /Use `sync`, not `recover`/.test(runtimeSpec)) failures.push('builder runtime spec: must not teach retired external sync or recover commands');

for (const file of ['docs/public-workflow-cli.md', 'docs/skills-map.md', 'docs/workflow-usage-guide.md']) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (/critique\.json|evidence\.json/i.test(text)) failures.push(`${file}: must not teach retired review or verification sidecars`);
  if (/--reviewer/.test(text)) failures.push(`${file}: public critique must not accept a caller-selected reviewer flag`);
}
const publicCli = fs.readFileSync(path.join(root, 'docs/public-workflow-cli.md'), 'utf8');
const usageGuide = fs.readFileSync(path.join(root, 'docs/workflow-usage-guide.md'), 'utf8');
for (const [name, text] of [['public CLI', publicCli], ['usage guide', usageGuide]]) {
  if (!/--criterion-json/.test(text) || !/--command\s+"npm test"/.test(text)) failures.push(`${name}: tests-evidence must include criterion JSON and a substantive project command`);
  if (/--command\s+"(?:true|node --version)"/.test(text)) failures.push(`${name}: public evidence examples must not use no-op commands`);
}

const pullWork = skillText('pull-work');
const skillsMap = fs.readFileSync(path.join(root, 'docs/skills-map.md'), 'utf8');
const providerNeutralDocs = [['pull-work', pullWork], ['skills map', skillsMap], ['usage guide', usageGuide]];
for (const [name, text] of providerNeutralDocs) {
  if (!/provider:id/.test(text) || !/owner\/repo#numeric-id/.test(text)) failures.push(`${name}: must document exactly the supported provider:id and owner/repo#numeric-id Work Item reference forms`);
  if (!/GitHub.{0,80}optional adapter|optional adapter.{0,80}GitHub|optional GitHub adapter/is.test(text)) failures.push(`${name}: must retain GitHub only as an optional adapter example`);
}
if (/only the first concrete adapter shape|other provider references stop as unsupported|executable GitHub issue backlog|Select ready GitHub issues/i.test(`${pullWork}\n${skillsMap}\n${JSON.stringify(kit)}`)) failures.push('Builder kit and docs: must not regress to GitHub-only work-item wording');
if (!/`review-work` owns `clean-critique`/.test(skillsMap) || !/`verify-work` owns\s+`acceptance-criteria`, `tests-evidence`, and applicable `policy-compliance`/s.test(skillsMap)) failures.push('skills map: must assign clean-critique to review-work and acceptance/tests/policy to verify-work');
if (!/`review-work` owns `clean-critique`/.test(usageGuide) || !/`verify-work` owns\s+`acceptance-criteria`, `tests-evidence`, and applicable `policy-compliance`/s.test(usageGuide)) failures.push('usage guide: must assign clean-critique to review-work and acceptance/tests/policy to verify-work');
const ideaMetadata = (kit.skills || []).find((entry) => entry.id === 'builder.idea-to-backlog')?.description ?? '';
const pullMetadata = (kit.skills || []).find((entry) => entry.id === 'builder.pull-work')?.description ?? '';
if (!/provider-backed work items/i.test(ideaMetadata) || !/GitHub is an optional adapter/i.test(ideaMetadata) || !/provider-backed work items/i.test(pullMetadata) || !/GitHub is an optional adapter/i.test(pullMetadata)) failures.push('kit metadata: backlog and pull-work descriptions must be provider-neutral with GitHub as optional adapter');

const actionSkills = new Set((kit.flow_step_actions || []).flatMap((entry) => entry.skills || []));
for (const skill of actionSkills) {
  const row = rows.find((entry) => entry.skill_id === `builder.${skill}`);
  if (row?.role !== 'step') failures.push(`${skill}: automatic step action must reference a step role`);
}
for (const forbidden of ['continue-work', 'gate-review', 'design-probe', 'fix-bug']) {
  if (actionSkills.has(forbidden)) failures.push(`${forbidden}: non-step/explicit role must stay outside automatic step actions`);
}
const trigger = (kit.workflow_triggers || []).find((entry) => entry.id === 'builder-build-work');
if (trigger?.default_skill !== 'deliver') failures.push('builder-build-work must select the deliver entrypoint');
if (JSON.stringify(trigger?.conditional_skills) !== JSON.stringify([{ when: 'user-requested-tdd', skill: 'tdd-workflow' }])) failures.push('builder-build-work must expose only the tdd-workflow profile override');

const durableContracts = {
  'pull-work': [/planned_base_sha/, /fresh.*drifted.*stale/is, /scope_drift/, /contract_drift/, /Complete selection and ownership preflight before creating a run/i, /do not attempt to attach `selected-work`\s+again/i, /NOT_VERIFIED/],
  'pickup-probe': [/planned_base_sha/, /fresh.*drifted.*stale/is, /resolution hints/i, /decision.*provenance/is, /NOT_VERIFIED/],
  'plan-work': [/Definition Of Done/, /Stop-short risks/, /Acceptance Evidence/, /structured evidence ref/i, /NOT_VERIFIED/],
  'execute-plan': [/changed files/i, /acceptance mapping/i, /structured.*evidence reference/is, /NOT_VERIFIED/],
  'review-work': [/report-only/i, /tool-security-reviewer/, /dependency-manifest/i, /scanner/i, /NOT_VERIFIED/],
  'verify-work': [/Goal Fit/, /Acceptance\s+Evidence/, /prose-only/i, /structured|identify a command result/i, /NOT_VERIFIED/],
  'evidence-gate': [/report-only/i, /actual diff/i, /evidence by strength/i, /prose-only/i, /degraded to\s+`NOT_VERIFIED`/is],
  'release-readiness': [/parent definition as `builder\.build`/i, /explicit authorization/i, /rollback/i, /observab/i, /post-release|post-deploy/i, /HOLD/],
  'learning-review': [/parent definition as `builder\.build`/i, /stable identifier/i, /owner or ownership gap/i, /backlog/i, /knowledge system/i, /independent verdicts/i],
  deliver: [/completed `pull-work` artifact/i, /Final Acceptance/, /earliest primitive/i, /already-bound local session/i, /human-readable provider reference/i, /learning/i],
};
for (const [skill, patterns] of Object.entries(durableContracts)) {
  const contents = skillText(skill);
  for (const pattern of patterns) {
    if (!pattern.test(contents)) failures.push(`${skill}: missing durable contract ${pattern}`);
  }
}

if (failures.length) {
  console.error('Builder skill coherence failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Builder skill coherence passed: 17 roles, producer boundaries, durable safeguards, public commands, and retired-pattern guards.');
NODE
