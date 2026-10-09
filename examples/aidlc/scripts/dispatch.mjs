import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonempty = value => typeof value === 'string' && value.length > 0;
class DispatchError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new DispatchError(code, message); };
const actorKey = identity => `${identity.actor.runtime}:${identity.actor.session_id}:${identity.actor.host}`;
const instanceKey = identity => `${actorKey(identity)}:${identity.instance_id}`;
// Wait for every participant to stop before releasing a unit's resource set.
async function settleParticipants(promises) {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map(result => result.value);
}

/** Validate the authoritative, bounded unit manifest before dispatching anything. */
export function validateUnits(units) {
  if (!Array.isArray(units) || !units.length || units.length > 128) fail('invalid_units', 'A bounded nonempty authoritative unit manifest is required');
  const ids = new Set();
  for (const unit of units) {
    if (!unit || !nonempty(unit.id) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(unit.id) || ids.has(unit.id)) fail('invalid_unit', 'Unit ids must be unique safe identifiers');
    ids.add(unit.id);
    for (const field of ['depends_on', 'mutable_resources']) {
      const values = unit[field] ?? [];
      if (!Array.isArray(values) || values.length > 128 || values.some(value => !nonempty(value)) || new Set(values).size !== values.length) fail('invalid_unit', `Invalid ${field} on ${unit.id}`);
    }
  }
  for (const unit of units) for (const dep of unit.depends_on ?? []) if (!ids.has(dep)) fail('unknown_unit', `Unknown dependency ${dep}`);
  const visited = new Set(), visiting = new Set(), byId = new Map(units.map(unit => [unit.id, unit]));
  function visit(id) {
    if (visiting.has(id)) fail('unit_cycle', `Unit dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id); for (const dep of byId.get(id).depends_on ?? []) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  for (const id of ids) visit(id);
  return structuredClone(units);
}

function basisValid(basis) {
  if (!basis || !/^[a-f0-9]{64}$/.test(basis.source_digest) || !Array.isArray(basis.artifacts) || basis.artifacts.length > 512) fail('invalid_basis', 'Executor must observe current source and artifact digests');
  const paths = new Set();
  for (const artifact of basis.artifacts) {
    if (!nonempty(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.digest) || paths.has(artifact.path)) fail('invalid_basis', 'Malformed or duplicate artifact basis');
    paths.add(artifact.path);
  }
  return structuredClone(basis);
}

function resultValid(result, request) {
  if (Buffer.byteLength(JSON.stringify(result) ?? '') > 1048576) fail('execution_budget', 'Execution response exceeds bounded receipt budget');
  if (!result || !['completed', 'failed', 'cancelled'].includes(result.status)) fail('invalid_execution', 'Executor returned no observed execution status');
  const identity = result.identity;
  if (!identity || !['runtime', 'session_id', 'host'].every(key => nonempty(identity.actor?.[key])) || !nonempty(identity.instance_id) || result.identity_basis !== 'executor-observed') fail('unobserved_identity', 'Execution identity must be observed by the host executor, using the public actor struct');
  if (!result.receipt || !nonempty(result.receipt.id) || result.receipt.request_digest !== request.request_digest || !/^[a-f0-9]{64}$/.test(result.receipt.digest)) fail('invalid_receipt', 'Execution receipt must bind the exact dispatch request');
  if (!isDeepStrictEqual(result.input_basis, request.basis)) fail('stale_execution', 'Execution did not consume its frozen input basis');
  if (request.expected_identity && !isDeepStrictEqual(identity, request.expected_identity)) fail('actor_substitution', 'Observed executor identity differs from host-admitted identity');
  if (!Array.isArray(result.artifacts) || result.artifacts.length > 512) fail('invalid_execution', 'Executor must report observed artifacts');
  basisValid({source_digest: request.basis.source_digest, artifacts: result.artifacts});
  return structuredClone(result);
}

async function reviewFindings(result, previous, authorize) {
  if (!['ready', 'not_ready'].includes(result.verdict) || !Array.isArray(result.findings) || result.findings.length > 256) fail('invalid_review', 'Reviewer must return a verdict and bounded findings');
  const ids = new Set();
  for (const finding of result.findings) {
    if (!nonempty(finding.id) || ids.has(finding.id) || !['open', 'fixed', 'accepted'].includes(finding.status) || !['critical', 'high', 'medium', 'low', 'info'].includes(finding.severity) || !nonempty(finding.reason)) fail('invalid_review', 'Finding identity, severity, disposition and reason are required');
    if (finding.status === 'accepted') {
      const authority = await authorize?.(structuredClone(finding));
      if (!authority?.authorized || !nonempty(authority.reference)) fail('authority_required', 'Accepted findings require current-basis host-authorized disposition');
      finding.authority = structuredClone(authority);
    }
    ids.add(finding.id);
  }
  for (const finding of previous) if (!ids.has(finding.id)) fail('missing_disposition', `Prior finding ${finding.id} disappeared without reviewer disposition`);
  if (result.verdict === 'ready' && result.findings.some(finding => finding.status === 'open')) fail('invalid_review', 'Ready review contains unresolved findings');
  return structuredClone(result.findings);
}

/**
 * Execute work *inside* a canonical Flow-admitted stage. This adapter never
 * evaluates/advances a gate, creates assignments, or treats configured personas
 * as authenticated principals. The trusted host port observes execution identity,
 * command/runtime receipts, current source/artifact basis, and access boundaries.
 * This is a trusted host port, not a model-response parser: identity_basis alone
 * authenticates nothing. The production port must derive/authenticate identity
 * and receipt outside the model-controlled workspace. No caller JSON, role
 * label, model name, or self-written receipt can serve as observed identity.
 *
 * executor: { execute(request), snapshotBasis({stage,unit,artifacts,context}),
 *   admit?(request)->observedIdentity, loadBasis?(key), saveBasis?(key,basis),
 *   loadReceipt?(request), saveReceipt?(request,result),
 *   claim?(request)->canonicalClaim, release?(claim,outcome), journal?(event),
 *   authorizeFinding?({stage,unit,finding,basis,review_receipt,reviewer_identity}),
 *   decide?({kind,stage,unit,basis,review_receipts,findings,dissent}) }
 * decide is a trusted host authority channel, never a model verdict. Only a
 * current-basis {authorized:true,decision:'accept',reference} admits completion.
 * authorizeFinding verifies a durable current-scope human approval through the
 * host authority channel; only that callback may return {authorized:true,reference}.
 * execute must honor signal and enforce output_scope. Its returned identity uses
 * Flow Agents' {runtime,session_id,host,human?} actor, plus observed instance_id.
 * Durable receipt replay is host-owned: loadReceipt must verify stored integrity
 * and saveReceipt must durably commit before returning. No automatic crash retry.
 */
export async function dispatchStage({ stage, units, executor, context = {}, policy = {}, signal }) {
  const outcome = { schema_version: '1.0', evidence_class: 'dispatch-observation', stage: stage?.slug, status: 'blocked', reason: null, units: [], executions: 0, canonical_advancement: 'host_owned' };
  let manifest;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const bounded = (value, fallback, maximum, field) => { const n = value ?? fallback; if (!Number.isSafeInteger(n) || n < 1 || n > maximum) fail('invalid_policy', `Invalid ${field}`); return n; };
  try {
    if (!stage || !nonempty(stage.slug) || !nonempty(stage.lead_agent) || !/^[a-f0-9]{64}$/.test(stage.source_digest) || !['inline', 'subagent', 'pipeline', 'mob'].includes(stage.mode)) fail('unsupported_topology', 'Stage requires an explicit supported topology and lead');
    if (!executor || typeof executor.execute !== 'function' || typeof executor.snapshotBasis !== 'function') fail('unsupported_executor', 'Explicit execution and observed-basis ports are required');
    const supports = stage.support_agents ?? [];
    if (!Array.isArray(supports) || supports.length > 16 || supports.some(role => !nonempty(role)) || new Set([stage.lead_agent, ...supports]).size !== supports.length + 1) fail('invalid_topology', 'Topology roles must be bounded and unique');
    if (['pipeline', 'mob'].includes(stage.mode) && !supports.length) fail('invalid_topology', 'Pipeline and mob require support participants');
    if ((executor.loadBasis && !executor.saveBasis) || (!executor.loadBasis && executor.saveBasis)) fail('invalid_executor', 'Initial frozen-basis load/save ports must be paired');
    if ((executor.loadReceipt && !executor.saveReceipt) || (!executor.loadReceipt && executor.saveReceipt)) fail('invalid_executor', 'Durable receipt load/save ports must be paired');
    const concurrency = bounded(policy.maxParallel, 4, 16, 'maxParallel');
    const executionBudget = bounded(policy.maxExecutions, 128, 2048, 'maxExecutions');
    const declaredReviewBudget = bounded(stage.reviewer_max_iterations, 2, 16, 'reviewer_max_iterations');
    const reviewBudget = bounded(policy.maxReviewIterations, declaredReviewBudget, 16, 'maxReviewIterations');
    if (stage.reviewer !== undefined && (!nonempty(stage.reviewer) || (stage.review_class !== undefined && !['advisory', 'adversarial'].includes(stage.review_class)))) fail('invalid_review', 'Invalid reviewer declaration');
    manifest = validateUnits(units ?? stage.units ?? (stage.for_each ? null : [{ id: 'stage', depends_on: [], mutable_resources: ['stage-artifacts'] }]));
    if (context.unit && !manifest.some(unit => unit.id === context.unit)) fail('unknown_unit', 'Selected unit is not in the authoritative manifest');
    if (policy.requiresClaim && !context.claim && !(executor.claim && executor.release)) fail('claim_required', 'Canonical Flow admission must be provided by the host');
    const selected = context.unit ? manifest.filter(unit => unit.id === context.unit) : manifest;
    if (context.unit && selected[0].depends_on?.some(id => !context.completedUnits?.includes(id))) fail('unit_not_ready', 'Selected unit has incomplete dependencies');
    outcome.units = selected.map(unit => ({ id: unit.id, status: 'pending', receipts: [], findings: [], reviews: [], basis: null, reason: null, dissent: [] }));
    const records = new Map(outcome.units.map(record => [record.id, record]));
    const globalSlots = new Set();
    async function execute(request, record) {
      if (controller.signal.aborted) fail('cancelled', 'Dispatch cancelled');
      if (outcome.executions >= executionBudget) fail('execution_budget', 'Stage execution budget exhausted');
      while (globalSlots.size >= concurrency) {
        await Promise.race(globalSlots);
        if (controller.signal.aborted) fail('cancelled', 'Dispatch cancelled');
      }
      if (outcome.executions >= executionBudget) fail('execution_budget', 'Stage execution budget exhausted');
      // Reserve before the first await, including admission/load: concurrent
      // supports cannot exceed the bound or all pass the budget check together.
      outcome.executions++;
      let releaseSlot;
      const slot = new Promise(resolve => { releaseSlot = resolve; });
      globalSlots.add(slot);
      try {
        const frozen = { schema_version: '1.0', stage: stage.slug, stage_source_digest: stage.source_digest, stage_source_path: stage.source_path ?? null, procedure: stage.procedure ?? null, declared_outputs: stage.produces ?? [], review_class: stage.review_class ?? null, unit: record.id, mutable_resources: structuredClone(manifest.find(entry => entry.id === record.id)?.mutable_resources ?? []), ...request };
        if (Buffer.byteLength(JSON.stringify(frozen)) > 262144) fail('context_budget', 'Execution request exceeds bounded context budget');
        frozen.request_digest = hash(frozen);
        if (executor.admit) frozen.expected_identity = await executor.admit(structuredClone(frozen));
        const wire = { ...structuredClone(frozen), signal: controller.signal };
        let result = await executor.loadReceipt?.(structuredClone(frozen));
        const replayed = Boolean(result);
        if (!result) {
          const fresh = basisValid(await executor.snapshotBasis({ stage: structuredClone(stage), unit: structuredClone(manifest.find(unit => unit.id === record.id)), artifacts: frozen.basis.artifacts, context: structuredClone(context) }));
          if (!isDeepStrictEqual(fresh, frozen.basis)) fail('stale_execution', 'Unreceipted execution input has changed; re-admission is required');
          result = await executor.execute(wire);
        }
        result = resultValid(result, frozen);
        const observed = { phase: frozen.phase, role: frozen.role, iteration: frozen.iteration, replayed, persisted: replayed, ...result };
        record.receipts.push(observed);
        if (!replayed && executor.saveReceipt) { await executor.saveReceipt(structuredClone(frozen), result); observed.persisted = true; }
        await executor.journal?.({ kind: 'execution_observed', stage: stage.slug, unit: record.id, request_digest: frozen.request_digest, receipt: result.receipt, replayed });
        if (controller.signal.aborted || result.status === 'cancelled') fail('cancelled', 'Execution was cancelled');
        if (result.status !== 'completed') fail('execution_failed', `Execution ${result.receipt.id} did not complete`);
        return result;
      } finally { globalSlots.delete(slot); releaseSlot(); }
    }
    const snapshot = async (unit, artifacts) => basisValid(await executor.snapshotBasis({ stage: structuredClone(stage), unit: structuredClone(unit), artifacts: structuredClone(artifacts), context: structuredClone(context) }));
    async function runUnit(unit, record) {
      let claim;
      record.status = 'running';
      try {
        if (executor.claim) claim = await executor.claim({ stage: stage.slug, unit: structuredClone(unit), signal: controller.signal, canonicalClaim: context.claim });
        if (policy.requiresClaim && !claim && !context.claim) fail('claim_required', 'Host did not observe canonical Flow claim admission');
        const dependencies = (unit.depends_on ?? []).map(id => ({ id, basis: records.get(id)?.basis ?? context.dependencyBasis?.[id], artifacts: records.get(id)?.artifacts ?? context.dependencyArtifacts?.[id] }));
        const unitContext = { ...(context.shared ?? {}), ...(context.units?.[unit.id] ?? {}), ...(unit.context ?? {}), dependencies };
        const basisKey = hash({stage, unit, context: unitContext});
        let initialBasis = await executor.loadBasis?.(basisKey);
        if (!initialBasis) { initialBasis = await snapshot(unit, []); await executor.saveBasis?.(basisKey, initialBasis); }
        let basis = basisValid(initialBasis), artifacts = [], authorIdentities = [];
        async function decide(kind) {
          if (!executor.decide) return;
          const frozen = structuredClone(basis);
          if (!isDeepStrictEqual(await snapshot(unit, artifacts), frozen)) fail('stale_decision', 'Unit source/artifact basis changed before host decision');
          const request = { kind, stage: stage.slug, unit: unit.id, basis: frozen, review_receipts: record.reviews.map(review => structuredClone(review.receipt)), findings: structuredClone(record.findings), dissent: structuredClone(record.dissent) };
          const decision = await executor.decide(request);
          if (controller.signal.aborted) fail('cancelled', 'Dispatch cancelled during host decision');
          if (!isDeepStrictEqual(await snapshot(unit, artifacts), frozen)) fail('stale_decision', 'Unit source/artifact basis changed during host decision');
          record.decision = { kind, basis: frozen, response: structuredClone(decision ?? null) };
          (record.decisions ??= []).push(structuredClone(record.decision));
          if (decision?.authorized === true && decision.decision === 'accept' && nonempty(decision.reference)) {
            record.authority_reference = decision.reference;
            record.status = 'completed'; record.reason = null;
          }
        }
        const request = (phase, role, extra = {}) => ({ phase, role, topology: stage.mode, iteration: 0, basis: structuredClone(basis), context: structuredClone(unitContext), prior_findings: structuredClone(record.findings), output_scope: phase === 'review' ? 'review-only' : 'stage-artifacts', ...extra });
        async function author(phase, role, extra) {
          const result = await execute(request(phase, role, extra), record);
          authorIdentities.push(result.identity); artifacts = result.artifacts;
          basis = await snapshot(unit, artifacts);
          for (const artifact of artifacts) if (!basis.artifacts.some(observed => observed.path === artifact.path && observed.digest === artifact.digest)) fail('artifact_mismatch', 'Reported author artifact differs from current observed bytes');
          return result;
        }
        let draft;
        if (stage.mode === 'pipeline') {
          let chain = [];
          for (const role of [stage.lead_agent, ...supports]) { const link = await author('pipeline-link', role, { upstream: chain }); chain.push(link); }
        } else {
          draft = await author(stage.mode === 'inline' ? 'inline' : 'draft', stage.lead_agent, { voices: stage.mode === 'inline' ? supports : [] });
          if (stage.mode !== 'inline' && supports.length) {
            const draftBasis = structuredClone(basis);
            const contributions = await settleParticipants(supports.map(role => execute(request('contribute', role, { basis: draftBasis, draft, output_scope: `contributions/${role}` }), record)));
            for (const result of contributions) {
              if (!result.artifacts.length) fail('missing_contribution', 'A dispatched collaborator produced no observed contribution artifact');
              const contributionBasis = await snapshot(unit, result.artifacts);
              for (const artifact of result.artifacts) if (!contributionBasis.artifacts.some(observed => observed.path === artifact.path && observed.digest === artifact.digest)) fail('artifact_mismatch', 'Collaborator contribution differs from observed bytes');
              authorIdentities.push(result.identity);
              if (authorIdentities.slice(0, -1).some(identity => instanceKey(identity) === instanceKey(result.identity))) fail('actor_substitution', 'Contributors must be separate observed execution instances');
            }
            if (!isDeepStrictEqual(await snapshot(unit, draft.artifacts), draftBasis)) fail('stale_contribution', 'Draft/source changed during mutually blind contributions');
            await author('integrate', stage.lead_agent, { contributions });
            if (stage.mode === 'mob') {
              const objections = contributions.flatMap(result => result.objections ?? []);
              record.dissent = structuredClone(objections);
              if (objections.some(objection => !['judgment', 'knowledge'].includes(objection.kind) || !nonempty(objection.reason))) fail('invalid_objection', 'Mob objection requires a kind and a reason');
              if (objections.some(objection => objection.kind === 'judgment')) { record.status = 'awaiting_decision'; record.reason = 'mob_judgment'; record.basis = basis; record.artifacts = artifacts; await decide('mob_judgment'); if (record.status === 'awaiting_decision') return; }
              const objectors = contributions.filter(result => result.objections?.some(objection => objection.kind === 'knowledge'));
              if (objectors.length) {
                const secondBasis = structuredClone(basis);
                const dialogue = await settleParticipants(objectors.map(result => execute(request('dialogue', result.role ?? record.receipts.find(entry => entry.receipt.id === result.receipt.id).role, { basis: secondBasis, iteration: 1, positions: contributions, revised_artifacts: artifacts, output_scope: 'contribution-only' }), record)));
                authorIdentities.push(...dialogue.map(result => result.identity));
                if (!isDeepStrictEqual(await snapshot(unit, artifacts), secondBasis)) fail('stale_contribution', 'Source/draft changed during mob dialogue');
                record.dissent = dialogue.flatMap(result => result.objections ?? []);
                if (record.dissent.some(objection => !['judgment', 'knowledge'].includes(objection.kind) || !nonempty(objection.reason))) fail('invalid_objection', 'Mob dialogue objection requires kind and reason');
                if (record.dissent.some(objection => objection.kind === 'judgment')) { record.status = 'awaiting_decision'; record.reason = 'mob_judgment'; record.basis = basis; record.artifacts = artifacts; await decide('mob_judgment'); if (record.status === 'awaiting_decision') return; }
                await author('integrate', stage.lead_agent, { iteration: 1, contributions: dialogue, maintained_dissent: record.dissent });
              }
            }
          }
        }
        if ((stage.produces?.length ?? 0) && !artifacts.length) fail('missing_artifacts', 'Stage produced no observed output artifacts');
        if (stage.reviewer) {
          const limit = stage.review_class === 'advisory' ? 1 : Math.min(reviewBudget, declaredReviewBudget);
          for (let iteration = 1; iteration <= limit; iteration++) {
            const frozen = structuredClone(basis);
            const review = await execute(request('review', stage.reviewer, { iteration, basis: frozen, reviewed_artifacts: artifacts, output_scope: 'review-only' }), record);
            if (authorIdentities.some(identity => actorKey(identity) === actorKey(review.identity) || identity.instance_id === review.identity.instance_id)) fail('reviewer_not_independent', 'Reviewer shares an author execution principal or instance');
            if (!isDeepStrictEqual(review.basis, frozen) || !isDeepStrictEqual(await snapshot(unit, artifacts), frozen)) fail('stale_review', 'Reviewed source/artifact basis changed during review');
            record.findings = await reviewFindings(review, record.findings, executor.authorizeFinding ? finding => executor.authorizeFinding({stage: stage.slug, unit: unit.id, finding, basis: frozen, review_receipt: review.receipt, reviewer_identity: review.identity}) : null);
            record.reviews.push({ iteration, verdict: review.verdict, identity: review.identity, receipt: review.receipt, basis: frozen, findings: structuredClone(record.findings) });
            if (stage.review_class === 'advisory') { record.status = 'awaiting_decision'; record.reason = 'advisory_review'; break; }
            if (review.verdict === 'ready') break;
            if (iteration === limit) fail('review_budget', 'Review remains not ready at the iteration limit');
            await author('revise', stage.lead_agent, { iteration, findings: record.findings });
          }
        }
        // Completion is an observed result awaiting the canonical host gate.
        if (!isDeepStrictEqual(await snapshot(unit, artifacts), basis)) fail('stale_basis', 'Unit basis changed before completion');
        record.basis = basis; record.artifacts = artifacts;
        if (record.status === 'completed' && record.authority_reference && !isDeepStrictEqual(record.decisions.findLast(decision => decision.response?.reference === record.authority_reference)?.basis, basis)) fail('stale_decision', 'Accepted host decision no longer binds the final unit basis');
        if (record.status === 'awaiting_decision') await decide(record.reason);
        if (record.status === 'running') record.status = 'completed';
      } catch (error) { record.status = error.code === 'cancelled' ? 'cancelled' : 'blocked'; record.reason = error.code ?? 'executor_error'; record.error = error.message; }
      finally {
        if (claim) { try { await executor.release?.(claim, structuredClone(record)); } catch (error) { record.status = 'blocked'; record.reason = 'claim_release_failed'; record.error = error.message; } }
      }
    }
    const active = new Map(), held = new Set();
    while (outcome.units.some(record => record.status === 'pending') || active.size) {
      let launched = false;
      for (const unit of selected) {
        const record = records.get(unit.id);
        if (record.status !== 'pending') continue;
        if (controller.signal.aborted) { record.status = 'cancelled'; record.reason = 'cancelled'; continue; }
        const dependencies = (unit.depends_on ?? []).map(id => records.get(id));
        if (dependencies.some(dep => dep && ['blocked', 'cancelled', 'awaiting_decision'].includes(dep.status))) { record.status = 'blocked'; record.reason = 'dependency_blocked'; continue; }
        if (dependencies.some(dep => dep && dep.status !== 'completed')) continue;
        // Unspecified write sets are conservatively exclusive; parallel writes
        // require explicit disjoint resources supplied by the authoritative plan.
        const resources = unit.mutable_resources ?? ['*'];
        if (active.size >= concurrency || held.has('*') || (resources.includes('*') && held.size) || resources.some(resource => held.has(resource))) continue;
        for (const resource of resources) held.add(resource);
        const work = runUnit(unit, record).finally(() => { active.delete(unit.id); for (const resource of resources) held.delete(resource); });
        active.set(unit.id, work); launched = true;
      }
      if (active.size) await Promise.race(active.values());
      else if (!launched && outcome.units.some(record => record.status === 'pending')) fail('unit_not_ready', 'No unit can be admitted');
    }
    outcome.status = outcome.units.every(record => record.status === 'completed') ? 'completed' : outcome.units.some(record => record.status === 'cancelled') ? 'cancelled' : outcome.units.some(record => record.status === 'blocked') ? 'blocked' : 'awaiting_decision';
    outcome.reason = outcome.units.find(record => record.status !== 'completed')?.reason ?? null;
  } catch (error) { outcome.status = error.code === 'cancelled' ? 'cancelled' : 'blocked'; outcome.reason = error.code ?? 'executor_error'; outcome.error = error.message; }
  finally { signal?.removeEventListener('abort', abort); }
  return outcome;
}
