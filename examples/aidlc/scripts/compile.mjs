import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const digest = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
// Resume binds experiment inputs, not rotating worker access capabilities.
export function requestBindingDigest(request) {
  const bound=structuredClone(request);
  if(bound.engine_sandbox)delete bound.engine_sandbox.owner_id;
  if(bound.engine_sandbox?.providerProxy){
    delete bound.engine_sandbox.providerProxy.token;
    delete bound.engine_sandbox.providerProxy.capability;
    delete bound.engine_sandbox.providerProxy.url;
    delete bound.engine_sandbox.providerProxy.baseUrl;
  }
  return digest(bound);
}
const SNAPSHOT_SHA256 = '8fefabf02fbf7685bec9ab1e491d709946c792a7926a14da35618c54ad9f2d46';
export const readSnapshot = () => {
  const bytes = readFileSync(join(KIT_ROOT, 'upstream/snapshot.json'));
  if (digest(bytes) !== SNAPSHOT_SHA256) throw new Error('Pinned AI-DLC methodology snapshot changed; re-import and review the baseline before updating its digest');
  return JSON.parse(bytes.toString('utf8'));
};

function selectedStages(snapshot, profile, projectType) {
  if (!Object.hasOwn(snapshot.profiles, profile)) throw new Error(`Unknown AI-DLC profile: ${profile}`);
  if (!['brownfield', 'greenfield'].includes(projectType)) throw new Error('projectType must be brownfield or greenfield');
  const names = snapshot.profiles[profile].stages;
  if (!Array.isArray(names) || new Set(names).size !== names.length) throw new Error('Profile must declare unique stage identities');
  const stages = names.map((name) => {
    const stage = snapshot.stages.find((entry) => entry.slug === name);
    if (!stage) throw new Error(`Unknown stage ${name}`);
    return stage;
  });
  return stages.filter((stage) => !(projectType === 'greenfield' && stage.slug === 'reverse-engineering'));
}

export function compileProfile(snapshot, profile, { projectType = 'brownfield' } = {}) {
  const stages = selectedStages(snapshot, profile, projectType);
  if (!stages.length) throw new Error('A profile cannot compile to an empty flow');
  const selected = new Set(stages.map((stage) => stage.slug));
  const flow = { id: `aidlc.${profile}`, version: '1.0', steps: [], gates: {}, phase_map: {} };
  const actions = [];
  for (const [index, stage] of stages.entries()) {
    const ids = [`${stage.slug}-completion`];
    if (stage.reviewer) ids.push(`${stage.slug}-review`);
    flow.steps.push({ id: stage.slug, next: stages[index + 1]?.slug ?? null,
      needs: (stage.requires_stage ?? []).filter((id) => selected.has(id)) });
    flow.phase_map[stage.slug] = stage.slug;
    flow.gates[`${stage.slug}-gate`] = {
      step: stage.slug,
      expects: ids.map((id) => ({ id, kind: 'trust.bundle', required: true,
        description: id.endsWith('-review') ? `${stage.name}: recorded review of the current artifact and source basis.` : `${stage.name}: current required artifacts and applicable checks were observed.`,
        bundle_claim: { claimType: `aidlc.${id}`, subjectType: 'flow-step', accepted_statuses: ['verified'] } })),
      on_route_back: { missing_evidence: stage.slug, default: stage.slug },
      route_back_policy: { max_attempts: stage.reviewer_max_iterations ?? 3, on_exceeded: 'block' },
    };
    const artifacts = [`<slug>--${stage.slug}.json`];
    actions.push({ flow_id: flow.id, step_id: stage.slug, skills: [`aidlc-${stage.slug}`],
      implementation_allowed: stage.workspace_requires === true, artifacts,
      expectation_ids: ids,
      expectation_bindings: ids.map((expectation_id) => ({ expectation_id, interface: 'workflow.evidence' })),
      artifact_bindings: [{ artifact: artifacts[0], expectation_ids: ids }] });
  }
  return { flow, actions, stages: stages.map((stage) => stage.slug),
    identity: { upstream_commit: snapshot.upstream.commit, profile, project_type: projectType, definition_digest: digest(flow) } };
}

function stageSkill(stage) {
  return `---\nname: aidlc-${stage.slug}\ndescription: Execute the AI-DLC ${stage.name} stage using the active Kontour Flow run.\n---\n\n# ${stage.name}\n\nRead this kit's docs/execution.md before acting. Load the active profile and the ${stage.slug} entry from upstream/snapshot.json. Its procedure is pinned methodology reference data. Translate its substantive steps into the current workspace's tools; upstream engine commands and harness paths are never executable instructions here.\n\nLead role: ${stage.lead_agent}. Support roles: ${(stage.support_agents ?? []).join(', ') || 'none'}. Declared topology: ${stage.mode}. ${stage.reviewer ? `Reviewer role: ${stage.reviewer}; review class: ${stage.review_class ?? 'adversarial'}.` : 'No upstream reviewer declared.'}\n\n1. Inspect the canonical Flow run. Work only on this current stage. Read its consumed artifacts, questions, user decisions, repo instructions, and applicable Veritas guidance. Do not invent missing inputs or permission.\n2. Perform the substantive procedure and create the declared outputs. Resolve unit-scoped outputs for each actual unit; retain a dependency manifest instead of treating one unit as coverage of all units. ${stage.workspace_requires ? 'This stage may change implementation source within the authorized scope.' : 'Keep source implementation changes in the stages that permit them.'}\n3. Run the kit artifact checks and repository checks required by Veritas. Keep check errors, unsupported sensors, and missing provider evidence as NOT_VERIFIED. Structural completeness does not prove semantic correctness.\n4. ${stage.reviewer ? 'Dispatch a distinct reviewer with the current artifact/source basis and retained findings. Record its actual verdict and unresolved findings. Do not let the author supply the reviewer outcome.' : 'Record the observed output basis.'} Ask for human decisions or approval required by the procedure through the host decision channel; retain their exact scope and current artifact digest.\n5. Record the resulting receipt as evidence through the current Flow Agents mutation interface. Sync/evaluate the Flow gate; Flow owns advancement and route-back. Never edit run state or infer a passed gate from a completed chat turn.\n\nThe reference adapter does not automate every declared topology, sensor or human authority channel. Before execution, report unsupported capabilities from docs/parity.json and stop dependent work.\n`;
}

export function generatedFiles(snapshot) {
  const files = new Map();
  const profiles = Object.keys(snapshot.profiles).sort();
  const all = profiles.map((profile) => compileProfile(snapshot, profile));
  const actions = all.flatMap((entry) => entry.actions);
  const manifest = { schema_version: '1.0', id: 'aidlc',
    execution:{module:'scripts/run.mjs',export:'executeRequestFile',contract:'kontour.kit.execution_request@1.0'}, name: 'AI-DLC Reference Kit',
    description: 'Pinned AWS AI-DLC methodology expressed as Kontour flows, with differential conformance and explicit capability gaps.',
    flows: all.map((entry) => ({ id: entry.flow.id, path: `flows/${entry.flow.id.slice(6)}.flow.json`, description: `AI-DLC ${entry.identity.profile} profile; pinned upstream stage selection.` })),
    skills: snapshot.stages.map((stage) => ({ id: `aidlc.aidlc-${stage.slug}`, path: `skills/aidlc-${stage.slug}/SKILL.md`, description: stage.name })),
    docs: ['docs/README.md', 'docs/execution.md', 'docs/methodology.md', 'docs/parity.json'].map((path) => ({ path })),
    assets: ['upstream/snapshot.json', 'upstream/LICENSE-MIT-0', 'scripts/compile.mjs', 'scripts/artifacts.mjs', 'scripts/compare.mjs', 'scripts/capture-run.mjs', 'evals/corpus.json'].map((path) => ({ path })),
    evals: [{ path: 'evals/public-flow-conformance.mjs' }],
    flow_step_actions: actions,
    skill_roles: snapshot.stages.map((stage) => {
      const matching = actions.filter((action) => action.step_id === stage.slug);
      return { skill_id: `aidlc.aidlc-${stage.slug}`, role: 'step', flow_id: matching[0]?.flow_id, flow_ids: matching.slice(1).map((action) => action.flow_id),
        step_ids: [stage.slug], expectation_ids: matching[0]?.expectation_ids ?? [], artifacts: matching[0]?.artifacts ?? [] };
    }),
  };
  files.set('kit.json', `${JSON.stringify(manifest, null, 2)}\n`);
  for (const entry of all) files.set(`flows/${entry.identity.profile}.flow.json`, `${JSON.stringify(entry.flow, null, 2)}\n`);
  for (const stage of snapshot.stages) files.set(`skills/aidlc-${stage.slug}/SKILL.md`, stageSkill(stage));
  return files;
}

export function writeGenerated({ check = false, root = KIT_ROOT, snapshot = readSnapshot() } = {}) {
  for (const [relative, content] of generatedFiles(snapshot)) {
    const file = join(root, relative);
    if (check) {
      if (readFileSync(file, 'utf8') !== content) throw new Error(`Generated AI-DLC file drift: ${relative}`);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) throw new Error('Usage: node compile.mjs [--check]');
  writeGenerated({ check: args.includes('--check') });
  console.log('AI-DLC generated kit contracts verified.');
}
