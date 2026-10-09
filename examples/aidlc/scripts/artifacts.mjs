import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { digest } from './compile.mjs';

const MAX_BYTES = 1024 * 1024;
const MAX_ARTIFACTS = 512;

export function readArtifact(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error('Artifact path must be relative');
  const base = realpathSync(root);
  const file = realpathSync(resolve(base, path));
  const rel = relative(base, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Artifact escapes the workspace');
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Artifact must be a bounded ordinary file');
  const bytes = readFileSync(file);
  if (bytes.length > MAX_BYTES) throw new Error('Artifact exceeded read budget');
  return { path, digest: digest(bytes), bytes: bytes.length, text: bytes.toString('utf8') };
}

function instance(entries, stage, artifact) {
  const matches = entries.filter((entry) => entry.stage === stage && entry.id === artifact);
  if (matches.length > 1) throw new Error(`Ambiguous artifact identity ${stage}/${artifact}`);
  return matches[0];
}

export function observeStage({ snapshot, profile, stage: stageId, root, artifacts, projectType = 'brownfield' }) {
  if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS) throw new Error('Artifacts must be a bounded array');
  const selected = snapshot.profiles[profile]?.stages;
  if (!selected?.includes(stageId)) throw new Error('Stage is not selected by this profile');
  const stage = snapshot.stages.find((entry) => entry.slug === stageId);
  if (!stage) throw new Error('Unknown stage');
  const findings = [];
  const inputs = [];
  const outputs = [];
  const observe = (entry, required, target, identity) => {
    if (!entry) { if (required) findings.push(`missing:${identity}`); return; }
    try {
      const observed = readArtifact(root, entry.path);
      if (!observed.text.trim()) findings.push(`empty:${identity}`);
      target.push({ id: entry.id, stage: entry.stage, path: entry.path, digest: observed.digest, bytes: observed.bytes });
    } catch (error) { findings.push(`unreadable:${identity}:${error.message}`); }
  };
  const optional = new Set(stage.optional_produces ?? []);
  for (const id of new Set([...(stage.produces ?? []), ...optional])) observe(instance(artifacts, stageId, id), !optional.has(id), outputs, `${stageId}/${id}`);
  for (const input of stage.consumes ?? []) {
    if (input.conditional_on && input.conditional_on !== projectType) continue;
    const producers = snapshot.stages.filter((entry) => selected.includes(entry.slug) && selected.indexOf(entry.slug) < selected.indexOf(stageId) && [...(entry.produces ?? []), ...(entry.optional_produces ?? [])].includes(input.artifact));
    const producer = producers.at(-1);
    // A skipped upstream stage supplies no invented document. Consumers must
    // take their scope from the selected profile, as the upstream method does.
    if (!producer) continue;
    observe(instance(artifacts, producer.slug, input.artifact), input.required, inputs, `${producer.slug}/${input.artifact}`);
  }
  return { schema_version: '1.0', evidence_class: 'artifact-structure-observation',
    upstream_commit: snapshot.upstream.commit, profile, project_type: projectType, stage: stageId,
    structural_status: findings.length ? 'fail' : 'pass', findings, inputs, outputs,
    semantic_status: 'not_verified', sensor_status: (stage.sensors ?? []).map((id) => ({ id, status: 'not_verified' })),
    basis_digest: digest({ contract: stage.source_digest, inputs, outputs }) };
}

export function inspectBasis(receipt, root) {
  const changes = [];
  for (const entry of [...receipt.inputs, ...receipt.outputs]) {
    try { if (readArtifact(root, entry.path).digest !== entry.digest) changes.push(`${entry.stage}/${entry.id}`); }
    catch { changes.push(`${entry.stage}/${entry.id}`); }
  }
  return { status: changes.length ? 'stale' : 'current', changes };
}

export function projectInvalidation(receipts, root) {
  if (new Set(receipts.map((receipt) => receipt.stage)).size !== receipts.length) throw new Error('Invalidation projection requires one current receipt per stage');
  const states = new Map(receipts.map((receipt) => [receipt.stage, { ...inspectBasis(receipt, root), direct: true }]));
  let changed;
  do {
    changed = false;
    for (const receipt of receipts) {
      if (states.get(receipt.stage).status === 'stale') continue;
      const staleInput = receipt.inputs.find((input) => states.get(input.stage)?.status === 'stale');
      if (staleInput) { states.set(receipt.stage, { status: 'stale', changes: [staleInput.stage], direct: false }); changed = true; }
    }
  } while (changed);
  return Object.fromEntries(states);
}
