import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readSnapshot, compileProfile } from './compile.mjs';

export function compareMethod(snapshot, profile, candidateFlow) {
  const expected = snapshot.profiles[profile]?.stages;
  if (!expected) throw new Error('Unknown baseline profile');
  const observed = candidateFlow.steps?.map((step) => step.id);
  return { profile, baseline_commit: snapshot.upstream.commit, expected, observed,
    outcome: JSON.stringify(expected) === JSON.stringify(observed) ? 'pass' : 'fail' };
}

function observation(caseSpec, result) {
  if (!result || result.status !== 'completed') return { status: 'not_verified', findings: ['run-not-completed'] };
  if (!result.identity || !result.identity.revision || !result.identity.model || !result.identity.harness || !result.input_digest || result.input_digest !== digest(caseSpec.input)) {
    return { status: 'not_verified', findings: ['missing-or-wrong-run-identity'] };
  }
  const artifacts = result.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) return { status: 'fail', findings: ['missing-artifact-map'] };
  const findings = [];
  for (const rule of caseSpec.artifact_checks) {
    const content = artifacts[rule.path];
    if (typeof content !== 'string' || !content.trim()) { findings.push(`missing:${rule.path}`); continue; }
    for (const required of rule.required_literals ?? []) if (!content.includes(required)) findings.push(`missing-literal:${rule.path}:${required}`);
    for (const forbidden of rule.forbidden_literals ?? []) if (content.includes(forbidden)) findings.push(`forbidden-literal:${rule.path}:${forbidden}`);
  }
  return { status: findings.length ? 'fail' : 'pass', findings };
}

export function compareOutputs(caseSpec, baseline, candidate) {
  const aws = observation(caseSpec, baseline);
  const kontour = observation(caseSpec, candidate);
  const comparable = baseline?.identity?.model === candidate?.identity?.model && baseline?.identity?.harness === candidate?.identity?.harness
    && JSON.stringify(baseline?.budget) === JSON.stringify(candidate?.budget) && baseline?.budget?.max_tokens > 0;
  return { schema_version: '1.0', case_id: caseSpec.id, input_digest: digest(caseSpec.input),
    grading: 'frozen-artifact-structure-rubric', baseline: aws, candidate: kontour,
    comparison_status: comparable && aws.status !== 'not_verified' && kontour.status !== 'not_verified' ? 'comparable' : 'not_verified',
    semantic_quality: 'not_verified', improvement_claim: 'not_verified',
    economics: { baseline: baseline?.economics ?? null, candidate: candidate?.economics ?? null },
    limitation: 'Artifact checks do not establish semantic quality or causal improvement. Evals owns independent semantic grading and effectiveness.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'method') {
    const snapshot = readSnapshot();
    const report = Object.keys(snapshot.profiles).sort().map((profile) => compareMethod(snapshot, profile, compileProfile(snapshot, profile).flow));
    console.log(JSON.stringify({ schema_version: '1.0', cases: report }, null, 2));
    process.exitCode = report.every((item) => item.outcome === 'pass') ? 0 : 1;
  } else if (command === 'outputs' && args.length === 3) {
    const [spec, baseline, candidate] = args.map((file) => JSON.parse(readFileSync(file, 'utf8')));
    const report = compareOutputs(spec, baseline, candidate);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.comparison_status === 'comparable' && report.candidate.status === 'pass' ? 0 : 1;
  } else throw new Error('Usage: compare.mjs method | outputs <case.json> <aws-result.json> <kontour-result.json>');
}
