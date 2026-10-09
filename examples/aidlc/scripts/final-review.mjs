import { isDeepStrictEqual } from 'node:util';
import { dispatchStage, validateUnits } from './dispatch.mjs';
import { createUnitFlow } from './unit-flow.mjs';
import { digest } from './compile.mjs';

const validIdentity = identity => identity && ['runtime', 'session_id', 'host'].every(key => typeof identity.actor?.[key] === 'string' && identity.actor[key]) && typeof identity.instance_id === 'string' && identity.instance_id;
const samePrincipal = (left, right) => left.instance_id === right.instance_id || left.actor.session_id === right.actor.session_id || isDeepStrictEqual(left.actor, right.actor);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/**
 * Earlier source-authoring unit completions remain historical when a later
 * unit changes whole-source bytes. Final acceptance requires new independent
 * read-only reviews in a fresh canonical child Flow bound to final source.
 * No original completion or review receipt is relabelled as current evidence.
 */
export async function verifyFinalUnits({ stage, units, dispatched, context = {}, executor, controllerRoot, parentRunId, signal, policy = {} }) {
  const historical = structuredClone(dispatched);
  let flow, freshDispatch = null, join = null;
  try {
    const manifest = validateUnits(units);
    if (!stage?.reviewer || !executor?.execute || !executor.snapshotBasis || dispatched?.status !== 'completed' || !Array.isArray(dispatched.units) || dispatched.units.length !== manifest.length) fail('invalid_final_review', 'Final verification requires completed historical units and an independent reviewer port');
    const records = new Map();
    const principals = [];
    for (const record of dispatched.units) {
      if (!manifest.some(unit => unit.id === record.id) || records.has(record.id) || record.status !== 'completed' || !Array.isArray(record.artifacts) || !record.artifacts.length || !Array.isArray(record.receipts) || !record.receipts.length) fail('invalid_historical_unit', 'Historical unit identity, artifacts and execution receipts must be complete');
      for (const receipt of record.receipts) {
        if (receipt.status !== 'completed' || receipt.identity_basis !== 'executor-observed' || !validIdentity(receipt.identity) || !receipt.receipt?.id || !/^[a-f0-9]{64}$/.test(receipt.receipt.digest)) fail('invalid_historical_identity', 'Historical execution identity and receipt must be host-observed');
        principals.push(receipt.identity);
      }
      for (const review of record.reviews ?? []) {
        if (!validIdentity(review.identity)) fail('invalid_historical_identity', 'Historical review identity must be host-observed');
        principals.push(review.identity);
      }
      if (new Set(record.artifacts.map(ref => ref.path)).size !== record.artifacts.length || record.artifacts.some(ref => typeof ref.path !== 'string' || !/^[a-f0-9]{64}$/.test(ref.digest))) fail('invalid_historical_artifacts', 'Historical artifact identities must be unique and byte-bound');
      records.set(record.id, record);
    }
    let finalSourceDigest;
    const snapshots = new Map();
    for (const unit of manifest) {
      const record = records.get(unit.id);
      const observed = await executor.snapshotBasis({ stage, unit, artifacts: record.artifacts, context });
      if (!/^[a-f0-9]{64}$/.test(observed?.source_digest) || !isDeepStrictEqual(observed.artifacts, record.artifacts.map(({ path, digest }) => ({ path, digest })))) fail('historical_artifact_changed', `Historical artifacts changed for ${unit.id}`);
      finalSourceDigest ??= observed.source_digest;
      if (finalSourceDigest !== observed.source_digest) fail('stale_final_source', 'Source changed while admitting final verification');
      snapshots.set(unit.id, observed);
    }
    const verificationStage = { ...structuredClone(stage), acceptance_phase: 'final-source', final_source_digest: finalSourceDigest, mode: 'inline', lead_agent: stage.reviewer, support_agents: [], reviewer: undefined, workspace_requires: false,
      procedure: `Independently review the complete final source and this unit's unchanged historical artifacts. Return ready only when the final integration meets the pinned stage contract. Do not write source or artifacts. Prior reviews are historical, not current approval.\n\nPinned stage assessment criteria:\n${stage.procedure ?? ''}` };
    const finalContext = structuredClone(context);
    // Replay flags and scheduler counters are not historical evidence identity.
    // Bind immutable original receipt/artifact/actor facts so resumption may
    // restore canonical records without turning their bookkeeping into new work.
    const historicalBasis = { stage: stage.slug, stage_source_digest: stage.source_digest, units: manifest.map(unit => {
      const record = records.get(unit.id);
      return { id: unit.id, artifacts: record.artifacts, receipts: record.receipts.map(receipt => ({ receipt: receipt.receipt, identity: receipt.identity, input_basis: receipt.input_basis })), reviews: record.reviews ?? [] };
    }) };
    finalContext.shared = { ...(finalContext.shared ?? {}), stage: verificationStage, artifact_targets: [], acceptance_phase: 'final-source', final_source_digest: finalSourceDigest, final_review_historical_digest: digest(historicalBasis) };
    finalContext.units = { ...(finalContext.units ?? {}) };
    for (const unit of manifest) finalContext.units[unit.id] = { ...(finalContext.units[unit.id] ?? {}), final_review_artifacts: records.get(unit.id).artifacts };
    const observeCurrent = async (input) => {
      const observed = await executor.snapshotBasis(input);
      if (observed.source_digest !== finalSourceDigest) fail('stale_final_source', 'The final source basis changed during verification');
      return observed;
    };
    const verifyResult = async (result, request) => {
      const record = records.get(request.unit), expected = snapshots.get(request.unit);
      const current = await observeCurrent({ stage: verificationStage, unit: manifest.find(unit => unit.id === request.unit), artifacts: record.artifacts, context: finalContext });
      if (!isDeepStrictEqual(current, expected)) fail('historical_artifact_changed', 'Reviewed unit artifacts changed during final verification');
      const findingsValid = Array.isArray(result.findings) && result.findings.length <= 256 && result.findings.every(finding => finding && typeof finding.id === 'string' && finding.id && ['critical', 'high', 'medium', 'low', 'info'].includes(finding.severity) && ['fixed', 'open', 'accepted'].includes(finding.status) && typeof finding.reason === 'string' && finding.reason) && new Set(result.findings.map(finding => finding.id)).size === result.findings.length;
      const independent = validIdentity(result.identity) && !principals.some(prior => samePrincipal(prior, result.identity));
      const ready = result.status === 'completed' && result.identity_basis === 'executor-observed' && independent && result.verdict === 'ready' && findingsValid && !result.findings.some(finding => finding.status !== 'fixed') && isDeepStrictEqual(result.basis, current) && isDeepStrictEqual(result.artifacts, record.artifacts.map(({ path, digest }) => ({ path, digest }))) && isDeepStrictEqual(result.input_basis, request.basis);
      return { ...result, phase: 'review', status: ready ? 'completed' : 'failed', final_review: { acceptance_phase: 'final-source', source_digest: finalSourceDigest, independent, ready }, ...(ready ? {} : { failure: { reason: independent ? 'final_review_not_ready' : 'reviewer_not_independent' } }) };
    };
    const reviewingExecutor = { ...executor, snapshotBasis: observeCurrent,
      async execute(request) {
        // The host preserves dispatch identity, admission and frozen request
        // digest. Its context already binds the exact final artifact list.
        const current = await observeCurrent({ stage: verificationStage, unit: manifest.find(unit => unit.id === request.unit), artifacts: records.get(request.unit).artifacts, context: finalContext });
        if (!isDeepStrictEqual(current, snapshots.get(request.unit))) fail('historical_artifact_changed', 'Historical artifacts changed before review execution');
        const reviewRequest = { ...request, phase: 'review', reviewed_artifacts: records.get(request.unit).artifacts, output_scope: 'review-only' };
        return verifyResult(await executor.execute(reviewRequest), request);
      },
      async loadReceipt(request) { const result = await executor.loadReceipt?.(request); return result ? verifyResult(result, request) : null; },
    };
    // Keep load/save ports paired even for a port without durable replay.
    if (!executor.loadReceipt) { delete reviewingExecutor.loadReceipt; delete reviewingExecutor.saveReceipt; }
    flow = await createUnitFlow({ controllerRoot, parentRunId, stage: verificationStage, units: manifest, snapshotBasis: observeCurrent });
    freshDispatch = await dispatchStage({ stage: verificationStage, units: manifest, executor: flow.bindExecutor(reviewingExecutor), context: finalContext, policy: { ...policy, requiresClaim: true }, signal });
    join = await flow.join();
    return { status: freshDispatch.status === 'completed' && join.complete ? 'completed' : freshDispatch.status === 'cancelled' ? 'cancelled' : 'blocked', dispatch: freshDispatch, join, historical };
  } catch (error) {
    return { status: error.code === 'cancelled' || signal?.aborted ? 'cancelled' : 'blocked', dispatch: freshDispatch, join, historical, failure: { reason: error.code ?? 'final_review_failed', detail: error.message } };
  } finally { await flow?.close(); }
}
