import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const COORDINATOR_RUNTIME_VERSION = "1.0";
export const COORDINATOR_RUNTIME_ID = "kontourai.lifecycle-authority.runtime";
export const CRITIQUE_HISTORY_PROJECTION_VERSION = "1.0";
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : record(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
export const coordinatorRuntimeSha256 = () => crypto.createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex");
export const bundleDigest = (bundle) => crypto.createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
const jsonDigest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function critiqueResolutionResultCoreDigest(prior, resolving, edge) {
  return crypto.createHash("sha256").update(canonical({
    prior_record_id: prior.critique_record_id,
    prior_record_hash: prior.critique_record_hash,
    resolving_record_id: resolving.critique_record_id,
    resolving_record_hash: resolving.critique_record_hash,
    edge,
  })).digest("hex");
}
function exact(value, fields, label) {
  if (!record(value) || canonical(Object.keys(value).sort()) !== canonical([...fields].sort())) throw new Error(`${label} contains unexpected or missing fields`);
}
function oneClaim(claims, recordId, label) {
  const matches = claims.filter((claim) => claim?.metadata?.origin === "critique" && claim.metadata.critique_record_id === recordId);
  if (matches.length !== 1) throw new Error(`${label} critique record is missing or ambiguous`);
  return matches[0];
}
function failedLaneIds(metadata) { return (Array.isArray(metadata.lanes) ? metadata.lanes : []).filter((lane) => lane.status !== "pass").map((lane) => String(lane.id)).sort(); }
function openFindingIds(metadata) { return (Array.isArray(metadata.findings) ? metadata.findings : []).filter((finding) => finding.status === "open").map((finding) => String(finding.id)).sort(); }
function exactText(actual, expected, label) { if (typeof actual !== "string" || actual !== expected) throw new Error(`authorization does not bind ${label}`); }
function snapshot(metadata, field) {
  const value = metadata.review_target?.workspace_snapshot;
  if (!record(value)) throw new Error(`critique ${field} is missing from the immutable workspace snapshot`);
  if (field === "head_sha" && (value[field] === undefined || value[field] === null)) return "none";
  if (typeof value[field] !== "string" || !value[field]) throw new Error(`critique ${field} is missing from the immutable workspace snapshot`);
  return value[field];
}
function assertDescends(claims, prior, resolving) {
  const byHash = new Map(claims.filter((claim) => claim?.metadata?.origin === "critique").map((claim) => [claim.metadata.critique_record_hash, claim.metadata]));
  const visited = new Set(); let cursor = resolving;
  while (cursor && !visited.has(cursor.critique_record_hash)) {
    visited.add(cursor.critique_record_hash);
    if (cursor.critique_predecessor_hash === prior.critique_record_hash) return;
    cursor = byHash.get(cursor.critique_predecessor_hash);
  }
  throw new Error("resolving critique is not a descendant of the authorized prior critique");
}
function assertAuthorizationPreimage(authorization, prior, resolving, claims) {
  exactText(authorization.subject, prior.workflow_subject_ref, "the prior critique subject");
  exactText(resolving.workflow_subject_ref, prior.workflow_subject_ref, "one workflow subject");
  exactText(authorization.prior_record_hash, prior.critique_record_hash, "the prior record hash");
  exactText(authorization.resolving_record_hash, resolving.critique_record_hash, "the resolving record hash");
  exactText(authorization.expected_resolver, resolving.reviewer, "the resolving reviewer");
  exactText(authorization.prior_snapshot_sha256, snapshot(prior, "digest"), "the prior snapshot digest");
  exactText(authorization.resolving_snapshot_sha256, snapshot(resolving, "digest"), "the resolving snapshot digest");
  exactText(authorization.prior_head_sha, snapshot(prior, "head_sha"), "the prior snapshot head");
  exactText(authorization.resolving_head_sha, snapshot(resolving, "head_sha"), "the resolving snapshot head");
  if (resolving.critique_sequence <= prior.critique_sequence) throw new Error("resolving critique is not later than the prior critique");
  assertDescends(claims, prior, resolving);
}

function resolutionEventLedger(events) {
  return { schema_version: "1.0", events };
}

function critiqueRecordHash(record) {
  return crypto.createHash("sha256").update(canonical({
    sequence: record.critique_sequence,
    predecessor_hash: record.critique_predecessor_hash,
    reviewer: record.reviewer,
    reviewed_at: record.reviewed_at,
    verdict: record.verdict,
    summary: record.summary,
    lanes: record.lanes ?? [],
    review_target: record.review_target ?? { artifacts: [] },
    findings: record.findings ?? [],
    workflow_subject_ref: record.workflow_subject_ref,
  })).digest("hex");
}

function critiqueProjectionRecord(claim) {
  const metadata = record(claim?.metadata) ? claim.metadata : {};
  return {
    critique_record_id: metadata.critique_record_id,
    critique_record_hash: metadata.critique_record_hash,
    critique_predecessor_hash: metadata.critique_predecessor_hash,
    critique_sequence: metadata.critique_sequence,
    reviewer: metadata.reviewer,
    verdict: claim?.value,
    claim_status: claim?.status,
    summary: claim?.fieldOrBehavior ?? null,
    workflow_subject_ref: metadata.workflow_subject_ref,
    review_target: metadata.review_target ?? { artifacts: [] },
    findings: metadata.findings ?? [],
    lanes: metadata.lanes ?? [],
    reviewed_at: metadata.reviewed_at ?? null,
    created_at: claim?.createdAt ?? null,
    updated_at: claim?.updatedAt ?? null,
    superseded_by: metadata.superseded_by ?? null,
    critique_resolution: metadata.critique_resolution ?? null,
  };
}

export function critiqueHistoryProjection(claims) {
  const records = (Array.isArray(claims) ? claims : [])
    .filter((claim) => claim?.metadata?.origin === "critique")
    .map(critiqueProjectionRecord)
    .sort((left, right) => Number(left.critique_sequence) - Number(right.critique_sequence));
  return { schema_version: CRITIQUE_HISTORY_PROJECTION_VERSION, kind: "kontourai.critique-history", records };
}

export function critiqueHistoryProjectionSummary(claims) {
  const projection = critiqueHistoryProjection(claims);
  return {
    version: CRITIQUE_HISTORY_PROJECTION_VERSION,
    digest: crypto.createHash("sha256").update(canonical(projection)).digest("hex"),
    length: projection.records.length,
    tail_hash: projection.records.at(-1)?.critique_record_hash ?? "0".repeat(64),
    projection,
  };
}

export function critiqueResolutionEdgeProjection(claims) {
  const edges = critiqueHistoryProjection(claims).records
    .filter((entry) => entry.superseded_by !== null || entry.critique_resolution !== null)
    .map((entry) => ({
      critique_record_id: entry.critique_record_id,
      superseded_by: entry.superseded_by,
      critique_resolution: entry.critique_resolution,
    }));
  return { schema_version: CRITIQUE_HISTORY_PROJECTION_VERSION, kind: "kontourai.critique-resolution-edges", edges };
}

export function critiqueResolutionEdgeProjectionSummary(claims) {
  const projection = critiqueResolutionEdgeProjection(claims);
  return {
    version: CRITIQUE_HISTORY_PROJECTION_VERSION,
    digest: crypto.createHash("sha256").update(canonical(projection)).digest("hex"),
    count: projection.edges.length,
    projection,
  };
}

function gateExpectation(claim) {
  return record(claim?.metadata?.gate_claim) && typeof claim.metadata.gate_claim.expectation_id === "string"
    ? claim.metadata.gate_claim.expectation_id
    : null;
}

/** Compose a writer-produced verification slice without regenerating historical claim timestamps. */
export function composeVerificationEvidenceCandidate(currentBundle, generatedBundle, expectation) {
  const target = generatedBundle.claims.filter(claim => gateExpectation(claim) === expectation);
  const oldTarget = currentBundle.claims.filter(claim => gateExpectation(claim) === expectation);
  if (target.length !== 1 || oldTarget.length > 1) throw new Error("verification candidate must contain one exact target");
  const generatedById = new Map(generatedBundle.claims.map(claim => [claim.id, claim]));
  if (generatedById.size !== generatedBundle.claims.length) throw new Error("verification candidate contains duplicate claim identities");
  const criteria = generatedBundle.claims.filter(claim => claim.metadata?.origin === "acceptance");
  const used = new Set(target);
  const claims = currentBundle.claims.map(prior => {
    if (gateExpectation(prior) === expectation) return target[0];
    if (expectation === "tests-evidence" && prior.metadata?.origin === "acceptance") {
      const matches = criteria.filter(claim => claim.metadata?.criterion?.id === prior.metadata.criterion?.id);
      if (matches.length !== 1) throw new Error("verification candidate lost a canonical criterion");
      used.add(matches[0]);return matches[0];
    }
    const regenerated = generatedById.get(prior.id);
    const withoutFoldTime = claim => { const result = {...claim};delete result.createdAt;delete result.updatedAt;return result; };
    if (!regenerated || canonical(withoutFoldTime(prior)) !== canonical(withoutFoldTime(regenerated))) throw new Error("verification candidate changed an unrelated historical claim");
    used.add(regenerated);return structuredClone(prior);
  });
  if (oldTarget.length === 0) claims.push(target[0]);
  if (used.size !== generatedBundle.claims.length) throw new Error("verification candidate introduced an unrelated claim");
  const result={...structuredClone(currentBundle),claims};
  const changedPriorIds=new Set(currentBundle.claims.filter((claim,index)=>JSON.stringify(claim)!==JSON.stringify(claims[index])).map(claim=>claim.id));
  const changedNextIds=new Set(claims.filter((claim,index)=>index>=currentBundle.claims.length||JSON.stringify(claim)!==JSON.stringify(currentBundle.claims[index])).map(claim=>claim.id));
  for(const field of ["evidence","events"]){
    if (Array.isArray(currentBundle[field]) || Array.isArray(generatedBundle[field])) result[field]=[
      ...(currentBundle[field]??[]).filter(item=>!changedPriorIds.has(item.claimId)),
      ...(generatedBundle[field]??[]).filter(item=>changedNextIds.has(item.claimId)),
    ];
  }
  const changedPolicies=new Set(claims.filter(claim=>changedNextIds.has(claim.id)).map(claim=>claim.verificationPolicyId));
  if(Array.isArray(currentBundle.policies)||Array.isArray(generatedBundle.policies)) result.policies=[
    ...(currentBundle.policies??[]).filter(policy=>!changedPolicies.has(policy.id)),
    ...(generatedBundle.policies??[]).filter(policy=>changedPolicies.has(policy.id)),
  ];
  return result;
}

function canonicalCriterionContract(bundle) {
  const contracts = bundle.claims.filter(claim => record(claim.metadata?.acceptance_contract)).map(claim => claim.metadata.acceptance_contract);
  if (contracts.length !== 1 || contracts[0].version !== 1 || contracts[0].algorithm !== "sha256" || !Array.isArray(contracts[0].criteria) || contracts[0].criteria.length === 0) throw new Error("initial verification evidence requires an anchored canonical criterion contract");
  const contract = contracts[0];
  if (crypto.createHash("sha256").update(JSON.stringify(contract.criteria)).digest("hex") !== contract.digest) throw new Error("initial verification criterion contract digest is invalid");
  if (new Set(contract.criteria.map(criterion => criterion.id)).size !== contract.criteria.length) throw new Error("initial verification criterion contract has duplicate identities");
  return contract;
}

function assertRelatedCriterionDelta(currentBundle,candidateBundle,authorization,target) {
  const deltas = authorization.related_criterion_deltas;
  if (!Array.isArray(deltas) || deltas.length > 512) throw new Error("initial verification related criterion delta is invalid");
  const contract = canonicalCriterionContract(currentBundle);
  const changed = new Set();
  for(const delta of deltas) {
    if (!record(delta) || canonical(Object.keys(delta).sort()) !== canonical(["criterion_id","claim_index","preimage_claim_sha256","candidate_claim_sha256"].sort())
      || !Number.isSafeInteger(delta.claim_index) || delta.claim_index < 0 || changed.has(delta.claim_index)) throw new Error("initial verification related criterion delta is invalid");
    const prior=currentBundle.claims[delta.claim_index], next=candidateBundle.claims[delta.claim_index];
    const specification=contract.criteria.filter(criterion=>criterion.id===delta.criterion_id);
    const digest=claim=>crypto.createHash("sha256").update(JSON.stringify(claim)).digest("hex");
    if (authorization.target_expectation_id!=="tests-evidence" || specification.length!==1 || prior?.metadata?.origin!=="acceptance" || next?.metadata?.origin!=="acceptance"
      || prior.metadata.criterion?.id!==delta.criterion_id || next.metadata.criterion?.id!==delta.criterion_id
      || next.metadata.criterion.description!==specification[0].description || next.fieldOrBehavior!==specification[0].description
      || prior.subjectId!==next.subjectId || next.facet!==prior.facet || next.impactLevel!==prior.impactLevel || next.claimType!=="workflow.acceptance.criterion" || next.subjectType!=="flow-step"
      || digest(prior)!==delta.preimage_claim_sha256 || digest(next)!==delta.candidate_claim_sha256
      || canonical(Object.keys(next.metadata).sort())!==canonical(["origin","criterion","workflow_subject_ref"].sort())
      || next.value!=="pass" || next.status!=="verified" || next.metadata.workflow_subject_ref!==authorization.subject
      || next.metadata.criterion.verified_by!==authorization.writer_actor_key || next.metadata.criterion.identity_version!==2
      || !Number.isFinite(Date.parse(next.metadata.criterion.verified_at))) throw new Error("initial verification related claim is not an exact authorized canonical criterion renewal");
    const commands=next.metadata.criterion.observed_commands;
    if (!Array.isArray(commands)||!commands.length||commands.some(command=>!target.metadata.observed_commands.some(observed=>canonical(observed)===canonical(command)))) throw new Error("initial verification criterion requires the target's actual command receipts");
    const refs=next.metadata.criterion.evidence_refs;
    if (!Array.isArray(refs)||commands.some(command=>!refs.some(ref=>ref.kind==="command"&&ref.excerpt===command.command))) throw new Error("initial verification criterion omits its exact command references");
    changed.add(delta.claim_index);
  }
  const allCurrent=currentBundle.claims.filter(claim=>claim.metadata?.origin==="acceptance");
  const allNext=candidateBundle.claims.filter(claim=>claim.metadata?.origin==="acceptance");
  if (allCurrent.length!==contract.criteria.length || allNext.length!==contract.criteria.length || contract.criteria.some(criterion=>allNext.filter(claim=>claim.metadata.criterion?.id===criterion.id&&claim.metadata.criterion?.description===criterion.description).length!==1)) throw new Error("initial verification criterion set does not match the anchored contract");
  return changed;
}

function assertAuthorizedVerificationClaimDelta(currentBundle, candidateBundle, authorization, flow, observation) {
  if (!record(currentBundle) || !record(candidateBundle) || !Array.isArray(currentBundle.claims) || !Array.isArray(candidateBundle.claims)) {
    throw new Error("verification evidence reseal requires Trust Bundles with claims");
  }
  const inserting = authorization.claim_delta === "insert";
  if (!Number.isSafeInteger(authorization.current_claim_index) || authorization.current_claim_index < 0
      || (inserting ? ["predecessor_claim_id", "predecessor_claim_status", "predecessor_claim_sha256", "predecessor_claim_index"].some(field => authorization[field] !== null)
        || candidateBundle.claims.length !== currentBundle.claims.length + 1 || authorization.current_claim_index !== currentBundle.claims.length
        : authorization.claim_delta !== "replace" || !Number.isSafeInteger(authorization.predecessor_claim_index)
          || authorization.predecessor_claim_index !== authorization.current_claim_index || authorization.predecessor_claim_index < 0
          || currentBundle.claims.length !== candidateBundle.claims.length)) {
    throw new Error("verification evidence reseal authorization claim delta is invalid");
  }
  const index = authorization.current_claim_index;
  const predecessor = inserting ? null : currentBundle.claims[index];
  const current = candidateBundle.claims[index];
  const requirements = Array.isArray(flow.requirements) ? flow.requirements : [];
  const targetRequirements = requirements.filter((requirement) => record(requirement) && requirement.id === authorization.target_expectation_id);
  if ((!inserting && !predecessor) || !current
      || targetRequirements.length !== 1
      || (!inserting && gateExpectation(predecessor) !== authorization.target_expectation_id)
      || gateExpectation(current) !== authorization.target_expectation_id
      || currentBundle.claims.filter((claim) => gateExpectation(claim) === authorization.target_expectation_id).length !== (inserting ? 0 : 1)
      || candidateBundle.claims.filter((claim) => gateExpectation(claim) === authorization.target_expectation_id).length !== 1) {
    throw new Error("verification evidence reseal does not target exactly one authorized verify expectation");
  }
  const targetRequirement = targetRequirements[0];
  const bundleClaim = targetRequirement.bundle_claim;
  if (!record(bundleClaim) || typeof bundleClaim.claimType !== "string" || typeof bundleClaim.subjectType !== "string") {
    throw new Error("verification evidence reseal target has no canonical current gate-claim requirement");
  }
  for (const [label, claim] of [...(predecessor ? [["predecessor", predecessor]] : []), [inserting ? "initial" : "replacement", current]]) {
    const gateClaim = claim?.metadata?.gate_claim;
    if (!record(gateClaim)
        || gateClaim.expectation_id !== targetRequirement.id
        || gateClaim.step_id !== flow.step_id
        || gateClaim.claim_type !== bundleClaim.claimType
        || gateClaim.subject_type !== bundleClaim.subjectType) {
      throw new Error(`verification evidence reseal ${label} gate_claim metadata does not bind the canonical current ${flow.gate_id} requirement`);
    }
  }
  const claimDigest = (claim) => crypto.createHash("sha256").update(JSON.stringify(claim)).digest("hex");
  if ((!inserting && (predecessor.id !== authorization.predecessor_claim_id
      || predecessor.status !== authorization.predecessor_claim_status
      || claimDigest(predecessor) !== authorization.predecessor_claim_sha256))
      || current.id !== authorization.current_claim_id
      || current.status !== authorization.current_claim_status
      || claimDigest(current) !== authorization.current_claim_sha256) {
    throw new Error("verification evidence reseal claim identity, status, or digest does not match the authorized delta");
  }
  let related = new Set();
  if (inserting) {
    assertInitialVerificationObservation(current, targetRequirement, authorization, observation, currentBundle);
    related = assertRelatedCriterionDelta(currentBundle,candidateBundle,authorization,current);
    const oldIds=new Set([...related].map(index=>currentBundle.claims[index].id));
    const newIds=new Set([current.id,...[...related].map(index=>candidateBundle.claims[index].id)]);
    if(new Set(candidateBundle.claims.map(claim=>claim.id)).size!==candidateBundle.claims.length) throw new Error("initial verification candidate duplicates a claim identity");
    for(const field of ["evidence","events"]){
      if(canonical((currentBundle[field]??[]).filter(item=>!oldIds.has(item.claimId)))!==canonical((candidateBundle[field]??[]).filter(item=>!newIds.has(item.claimId)))) throw new Error("initial verification changed unrelated evidence or events");
    }
    const policies=new Set(candidateBundle.claims.filter(claim=>newIds.has(claim.id)).map(claim=>claim.verificationPolicyId));
    for(const claim of candidateBundle.claims.filter(item=>!newIds.has(item.id))){
      if(!policies.has(claim.verificationPolicyId)) continue;
      const before=(currentBundle.policies??[]).filter(policy=>policy.id===claim.verificationPolicyId);
      const after=(candidateBundle.policies??[]).filter(policy=>policy.id===claim.verificationPolicyId);
      if(canonical(before)!==canonical(after)) throw new Error("initial verification changed a policy shared with an unrelated historical claim");
    }
    if(canonical((currentBundle.policies??[]).filter(item=>!policies.has(item.id)))!==canonical((candidateBundle.policies??[]).filter(item=>!policies.has(item.id)))) throw new Error("initial verification changed unrelated policies");
    const envelope=bundle=>Object.fromEntries(Object.entries(bundle).filter(([key])=>!["claims","evidence","events","policies"].includes(key)));
    if(canonical(envelope(currentBundle))!==canonical(envelope(candidateBundle))) throw new Error("initial verification changed the unrelated bundle envelope");
  }
  currentBundle.claims.forEach((claim, claimIndex) => {
    if ((inserting ? !related.has(claimIndex) : claimIndex !== index) && JSON.stringify(claim) !== JSON.stringify(candidateBundle.claims[claimIndex])) {
      throw new Error("verification evidence reseal changed the complete ordered claim set outside the authorized expectation");
    }
  });
}

/** First admission consumes only canonical writer observations against this exact source. */
function assertInitialVerificationObservation(claim, requirement, authorization, observation, currentBundle) {
  const metadata = claim.metadata;
  const gate = metadata.gate_claim;
  const snapshot = metadata.verification_workspace_snapshot;
  if (requirement.required !== true || requirement.bundle_claim?.subjectType !== "flow-step"
      || claim.claimType !== requirement.bundle_claim.claimType || claim.subjectType !== requirement.bundle_claim.subjectType
      || claim.value !== "pass" || claim.status !== "verified" || metadata.origin !== "check"
      || typeof metadata.expected_producer !== "string" || !metadata.expected_producer
      || !Array.isArray(metadata.self_produced_trust_slices) || !metadata.self_produced_trust_slices.includes(requirement.id)
      || metadata.recorded_by !== authorization.writer_actor_key || !authorization.writer_actor_key || metadata.workflow_subject_ref !== authorization.subject
      || gate.flow_run_head !== authorization.flow_run_head || gate.flow_id !== authorization.flow_definition_id
      || gate.identity_version !== 2 || !record(observation) || observation.assignment_actor_key !== authorization.assignment_actor_key
      || !record(snapshot) || snapshot.kind !== "git-worktree" || snapshot.version !== 1 || snapshot.algorithm !== "sha256"
      || snapshot.worktree_clean !== true || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(snapshot.head_sha))
      || canonical(snapshot) !== canonical(observation.workspace_snapshot)) {
    throw new Error("initial verification evidence requires one required canonical producer observation bound to the active actor and current clean source");
  }
  const reviews=currentBundle.claims.filter(item=>item.metadata?.origin==="critique"&&!item.metadata.superseded_by);
  const latest=reviews.at(-1);
  if (reviews.some(item=>item.value!=="pass" || item.status!=="verified" || (item.metadata.findings??[]).some(finding=>finding.status==="open"))
    || !latest || latest.value!=="pass" || latest.status!=="verified"
    || typeof latest.metadata.reviewer!=="string" || (latest.metadata.reviewer===authorization.assignment_actor_key || latest.metadata.reviewer===authorization.writer_actor_key)
    || (latest.metadata.findings??[]).some(finding=>finding.status==="open")
    || !Array.isArray(latest.metadata.lanes)||!latest.metadata.lanes.length||latest.metadata.lanes.some(lane=>lane.status!=="pass")
    || canonical(latest.metadata.review_target?.workspace_snapshot)!==canonical(snapshot)) throw new Error("initial verification evidence requires an independent clean current-source review");
  const commands = metadata.observed_commands;
  const log = observation.command_log;
  if (!Array.isArray(commands) || commands.length === 0 || !Array.isArray(log)) throw new Error("initial verification evidence requires retained canonical command receipts");
  if(log.some(entry=>entry.source==="workflow-evidence-transaction"&&entry.transaction?.id===authorization.candidate_transaction_id&&entry.transaction.outcome==="aborted")) throw new Error("initial verification evidence cannot revive an aborted writer transaction");
  const seen = new Set();
  for (const command of commands) {
    const proof = command.execution_proof;
    const supported = proof?.kind === "local-process-exit" && proof.runner === "node --test" && Number.isSafeInteger(proof.static_test_units) && proof.static_test_units > 0
      || proof?.kind === "coordinated-command-receipt" && proof.protocol === "flow-agents.coordinated-command-receipt/v1";
    if (typeof command.command !== "string" || !command.command || seen.has(command.command)
        || command.source !== "canonical-writer-execution" || command.exit_code !== 0
        || !Number.isSafeInteger(command.test_count) || command.test_count <= 0 || !supported
        || !/^[a-f0-9]{64}$/.test(String(command.output_sha256)) || command.worktree_clean !== true
        || command.observed_at_commit !== snapshot.head_sha || canonical(command.verification_workspace_snapshot) !== canonical(snapshot)) {
      throw new Error("initial verification evidence command has no supported fresh successful execution protocol");
    }
    seen.add(command.command);
    if (log.filter(entry => entry.source === "canonical-writer-execution" && entry.command === command.command && entry.exitCode === 0
      && entry.observedResult === "pass" && entry.worktree_clean === true && entry.observed_at_commit === command.observed_at_commit
      && entry.writer?.transaction_id === authorization.candidate_transaction_id
      && entry.writer?.output_sha256 === command.output_sha256 && entry.writer?.test_count === command.test_count
      && canonical(entry.writer?.execution_proof) === canonical(proof)
      && canonical(entry.writer?.verification_workspace_snapshot) === canonical(snapshot)).length !== 1) {
      throw new Error("initial verification evidence command receipt does not match its canonical writer transaction");
    }
  }
}

/**
 * Pure package-side policy for the privileged evidence reseal. Filesystem,
 * signature, replay, Flow attachment, and completion concerns remain in the
 * coordinator; this transition accepts only the exact authorized bytes and a
 * gate-claim-only Trust Bundle change.
 */
export function resealVerificationEvidenceTransition(input) {
  const {
    current_bundle: currentBundle,
    candidate_bundle: candidateBundle,
    resolution_events: resolutionEvents,
    authorization,
    current_bundle_bytes: currentBundleBytes,
    candidate_bundle_bytes: candidateBundleBytes,
    ledger_bytes: ledgerBytes,
    flow,
    verification_observation: verificationObservation,
  } = input ?? {};
  if (!record(authorization) || authorization.operation !== "reseal-verification-evidence") throw new Error("verification evidence reseal authorization identity is invalid");
  if (!Buffer.isBuffer(currentBundleBytes) || !Buffer.isBuffer(candidateBundleBytes) || !Buffer.isBuffer(ledgerBytes)) throw new Error("verification evidence reseal requires exact byte preimages");
  if (!record(flow) || flow.definition_id !== "builder.build" || flow.step_id !== "verify"
      || typeof flow.gate_id !== "string" || !Array.isArray(flow.requirements)
      || authorization.flow_definition_id !== flow.definition_id || authorization.flow_step_id !== flow.step_id
      || authorization.flow_gate_id !== flow.gate_id) {
    throw new Error("verification evidence reseal is authorized only for the builder.build verify gate");
  }
  const currentCritique = critiqueHistoryProjectionSummary(currentBundle?.claims);
  const candidateCritique = critiqueHistoryProjectionSummary(candidateBundle?.claims);
  if (canonical(currentCritique.projection) !== canonical(candidateCritique.projection)) {
    throw new Error("verification evidence reseal candidate changed the byte-identical critique projection");
  }
  assertAuthorizedVerificationClaimDelta(currentBundle, candidateBundle, authorization, flow, verificationObservation);
  if (crypto.createHash("sha256").update(currentBundleBytes).digest("hex") !== authorization.preimage_bundle_sha256) throw new Error("verification evidence reseal current bundle preimage changed");
  if (crypto.createHash("sha256").update(candidateBundleBytes).digest("hex") !== authorization.candidate_bundle_sha256) throw new Error("verification evidence reseal candidate bundle preimage changed");
  if (crypto.createHash("sha256").update(ledgerBytes).digest("hex") !== authorization.preimage_ledger_sha256) throw new Error("verification evidence reseal resolution ledger preimage changed");
  if (!Array.isArray(resolutionEvents)
      || authorization.preimage_ledger_length !== resolutionEvents.length
      || authorization.preimage_ledger_tail_hash !== (resolutionEvents.at(-1)?.event_hash ?? "0".repeat(64))) {
    throw new Error("verification evidence reseal resolution ledger identity changed");
  }
  return { bundle: structuredClone(candidateBundle), resolution_events: structuredClone(resolutionEvents) };
}

/**
 * Pure policy for refreshing a stale, authenticated completion.  It is
 * deliberately not a claim or ledger transition: the coordinator owns the
 * byte-preserving I/O boundary and may only attach the already-current bundle
 * to Flow before minting a new completion.
 */
export function recoverExactCurrentCompletionTransition(input) {
  exact(input, ["bundle", "resolution_events", "authorization", "bundle_bytes", "ledger_bytes", "flow"], "exact-current completion recovery input");
  const { bundle, resolution_events: resolutionEvents, authorization, bundle_bytes: bundleBytes, ledger_bytes: ledgerBytes, flow } = input;
  if (!record(bundle) || !Array.isArray(bundle.claims) || Object.hasOwn(bundle, "critique_resolution_events")) throw new Error("exact-current completion recovery requires a stripped Trust Bundle with claims");
  if (!record(authorization) || authorization.schema_version !== "1.0" || authorization.operation !== "recover-exact-current-completion" || authorization.permitted_transition !== "exact-current-completion-only") {
    throw new Error("exact-current completion recovery authorization identity is invalid");
  }
  if (!Buffer.isBuffer(bundleBytes) || !Buffer.isBuffer(ledgerBytes)) throw new Error("exact-current completion recovery requires exact byte preimages");
  if (!record(flow) || flow.definition_id !== "builder.build" || flow.step_id !== "verify" || typeof flow.gate_id !== "string"
      || authorization.flow_definition_id !== flow.definition_id || authorization.flow_step_id !== flow.step_id || authorization.flow_gate_id !== flow.gate_id) {
    throw new Error("exact-current completion recovery is authorized only for the builder.build verify gate");
  }
  if (typeof flow.definition_sha256 !== "string" || typeof flow.gate_policy_sha256 !== "string"
      || authorization.flow_definition_sha256 !== flow.definition_sha256
      || authorization.flow_gate_policy_sha256 !== flow.gate_policy_sha256) {
    throw new Error("exact-current completion recovery Flow definition or ordered gate policy changed");
  }
  if (crypto.createHash("sha256").update(bundleBytes).digest("hex") !== authorization.current_bundle_sha256
      || crypto.createHash("sha256").update(ledgerBytes).digest("hex") !== authorization.current_ledger_sha256) {
    throw new Error("exact-current completion recovery preimage bytes changed");
  }
  const ledger = validateResolutionEventLedger(resolutionEvents, {
    run_id: authorization.run_id, subject: authorization.subject, project_root: authorization.project_root, bundle, strict_coverage: true,
  });
  if (authorization.current_ledger_length !== ledger.length || authorization.current_ledger_tail_hash !== ledger.tail_hash) {
    throw new Error("exact-current completion recovery ledger identity changed");
  }
  const critique = critiqueHistoryProjectionSummary(bundle.claims);
  const edges = critiqueResolutionEdgeProjectionSummary(bundle.claims);
  if (authorization.critique_projection_sha256 !== critique.digest
      || authorization.resolution_edge_projection_sha256 !== edges.digest
      || authorization.resolution_edge_projection_count !== edges.count) {
    throw new Error("exact-current completion recovery critique or resolution-edge projection changed");
  }
  // Return the current values directly. Serializing a semantically equivalent
  // copy would violate the protocol's exact-evidence promise at the I/O layer.
  return { bundle, resolution_events: resolutionEvents };
}

export function assertAppendOnlyCritiqueHistory(historicalClaims, currentClaims) {
  const historical = critiqueHistoryProjectionSummary(historicalClaims);
  const current = critiqueHistoryProjectionSummary(currentClaims);
  if (current.length < historical.length) throw new Error("current critique history deletes historical records");
  historical.projection.records.forEach((entry, index) => {
    if (canonical(current.projection.records[index]) !== canonical(entry)) throw new Error("current critique history is not an exact historical prefix");
  });
  current.projection.records.forEach((entry, index, entries) => {
    if (entry.critique_sequence !== index + 1) throw new Error("current critique history append is noncontiguous");
    const predecessor = index === 0 ? "0".repeat(64) : entries[index - 1].critique_record_hash;
    if (entry.critique_predecessor_hash !== predecessor) throw new Error("current critique history append predecessor is invalid");
    if (critiqueRecordHash(entry) !== entry.critique_record_hash) throw new Error("current critique history append record hash is invalid");
  });
  const historicalEdges = critiqueResolutionEdgeProjectionSummary(historicalClaims);
  const currentHistoricalEdges = critiqueResolutionEdgeProjectionSummary(
    currentClaims.filter((claim) => Number.isSafeInteger(claim?.metadata?.critique_sequence) && claim.metadata.critique_sequence <= historical.length),
  );
  if (historicalEdges.digest !== currentHistoricalEdges.digest || historicalEdges.count !== currentHistoricalEdges.count) throw new Error("historical critique resolution edges changed");
  return { historical, current, historical_edges: historicalEdges, current_historical_edges: currentHistoricalEdges };
}

function syntheticCompletionCore(bundle, events) {
  return crypto.createHash("sha256").update(canonical({ ...bundle, critique_resolution_events: events })).digest("hex");
}

export function selectUniqueHistoricalLedgerPrefix(storedBundle, currentEvents, historicalResultCoreSha256, digestCandidate = syntheticCompletionCore) {
  if (!Array.isArray(currentEvents) || !/^[a-f0-9]{64}$/.test(historicalResultCoreSha256)) throw new Error("historical ledger prefix inputs are invalid");
  const matches = Array.from({ length: currentEvents.length + 1 }, (_, length) => currentEvents.slice(0, length))
    .filter((events) => digestCandidate(storedBundle, events) === historicalResultCoreSha256);
  if (matches.length !== 1) throw new Error(`historical completion requires exactly one reproducing ledger prefix; found ${matches.length}`);
  const events = matches[0];
  return {
    length: events.length,
    raw_sha256: crypto.createHash("sha256").update(JSON.stringify({ schema_version: "1.0", events })).digest("hex"),
    canonical_sha256: crypto.createHash("sha256").update(canonical({ schema_version: "1.0", events })).digest("hex"),
    tail_hash: events.at(-1)?.event_hash ?? "0".repeat(64),
    events,
  };
}

const HISTORY_REPAIR_BRIDGE_FIELDS = [
  "historical_completion_sha256", "historical_completion_request_sha256", "historical_completion_action", "historical_completion_result_core_sha256",
  "historical_attachment_id", "historical_manifest_entry_sha256", "historical_stored_path", "historical_stored_raw_sha256", "historical_stored_bundle_sha256",
  "historical_durable_operation_id", "historical_durable_completion_record_sha256",
  "historical_ledger_prefix_length", "historical_ledger_prefix_raw_sha256", "historical_ledger_prefix_canonical_sha256", "historical_ledger_prefix_tail_hash",
  "historical_critique_projection_version", "historical_critique_projection_sha256", "historical_critique_projection_length", "historical_critique_projection_tail_hash",
  "current_critique_projection_version", "current_critique_projection_sha256", "current_critique_projection_length", "current_critique_projection_tail_hash",
  "historical_resolution_edge_projection_sha256", "historical_resolution_edge_projection_count",
  "current_resolution_edge_projection_sha256", "current_resolution_edge_projection_count",
  "current_bundle_sha256", "current_ledger_sha256", "current_ledger_length", "current_ledger_tail_hash",
];

export function critiqueResolutionHistoryBridgeDigest(value) {
  return jsonDigest(Object.fromEntries(HISTORY_REPAIR_BRIDGE_FIELDS.map((field) => [field, value[field]])));
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function resolutionEdgeKey(edge) {
  return canonical([edge.prior_record_id, edge.resolving_record_id, edge.resolver, edge.resolution_event_id, edge.authorization_sha256]);
}

function crossReviewerEdges(bundle) {
  if (!record(bundle) || !Array.isArray(bundle.claims)) return [];
  return bundle.claims
    .filter((claim) => claim?.metadata?.origin === "critique" && record(claim.metadata?.critique_resolution) && claim.metadata.critique_resolution.kind === "cross-reviewer")
    .map((claim) => ({ claim, edge: claim.metadata.critique_resolution }));
}

function assertStoredAuthorizationBinding(event, expected) {
  const authorization = event.signed_authorization;
  if (!record(authorization) || jsonDigest(authorization) !== event.authorization_sha256) throw new Error("resolution event ledger signed authorization digest is invalid");
  if (!record(authorization.signature) || authorization.signature.algorithm !== "ed25519" || authorization.signature.key_id !== event.authorization_key_id || authorization.nonce !== event.authorization_nonce) throw new Error("resolution event ledger signed authorization identity is invalid");
  if (authorization.operation !== event.operation || authorization.run_id !== event.run_id || authorization.subject !== event.subject) throw new Error("resolution event ledger signed authorization operation binding is invalid");
  if (expected.project_root && authorization.project_root !== expected.project_root) throw new Error("resolution event ledger signed authorization project binding is invalid");
  for (const field of ["prior_record_id", "prior_record_hash", "resolving_record_id", "resolving_record_hash"])
    if (authorization[field] !== event[field]) throw new Error("resolution event ledger signed authorization critique edge binding is invalid");
  if (authorization.expected_resolver !== event.resolver) throw new Error("resolution event ledger signed authorization resolver binding is invalid");
  if (!record(event.edge) || event.edge.prior_record_id !== event.prior_record_id || event.edge.resolving_record_id !== event.resolving_record_id || event.edge.resolver !== event.resolver) throw new Error("resolution event ledger edge binding is invalid");
  if (event.operation === "resolve-critique") {
    if (event.event_id !== `critique-resolution:${event.authorization_sha256}` || event.edge.resolution_event_id !== event.event_id || event.edge.authorization_sha256 !== event.authorization_sha256) throw new Error("resolution event ledger ordinary event binding is invalid");
  } else if (authorization.missing_resolution_event_id !== event.missing_resolution_event_id || authorization.missing_authorization_sha256 !== event.missing_authorization_sha256 || event.edge.resolution_event_id !== event.missing_resolution_event_id || event.edge.authorization_sha256 !== event.missing_authorization_sha256) {
    throw new Error("resolution event ledger repair event binding is invalid");
  } else if (
    !HISTORY_REPAIR_BRIDGE_FIELDS.every((field) => Object.hasOwn(authorization, field))
    || !Object.hasOwn(authorization, "historical_bridge_sha256")
    || !Object.hasOwn(event, "verified_bridge_sha256")
    || authorization.historical_bridge_sha256 !== critiqueResolutionHistoryBridgeDigest(authorization)
    || event.verified_bridge_sha256 !== authorization.historical_bridge_sha256
  ) {
    throw new Error("resolution event ledger repair event verified historical bridge binding is invalid");
  }
}

function assertLedgerMapsToBundle(events, bundle, strictCoverage) {
  const edges = crossReviewerEdges(bundle);
  const mapped = new Set();
  for (const event of events) {
    const candidates = edges.filter(({ edge }) => event.prior_record_id === edge.prior_record_id
      && event.resolving_record_id === edge.resolving_record_id
      && event.resolver === edge.resolver
      && canonical(event.edge) === canonical(edge));
    if (candidates.length !== 1) throw new Error("resolution event ledger event does not map one-to-one to a bundle cross-reviewer edge");
    const [candidate] = candidates;
    const key = resolutionEdgeKey(candidate.edge);
    if (mapped.has(key)) throw new Error("resolution event ledger contains duplicate or conflicting bundle edge mappings");
    mapped.add(key);
  }
  if (strictCoverage && edges.some(({ edge }) => !mapped.has(resolutionEdgeKey(edge)))) throw new Error("resolution event ledger leaves a pre-existing cross-reviewer edge uncovered; repair is required");
}

/** Validates the external append-only authority ledger before any transition. */
export function validateResolutionEventLedger(events, expected = {}) {
  if (!Array.isArray(events)) throw new Error("resolution event ledger events must be an array");
  const eventIds = new Set(); const authorizationDigests = new Set(); let predecessor = "0".repeat(64);
  for (const [index, event] of events.entries()) {
    if (!record(event) || event.schema_version !== "1.0") throw new Error("resolution event ledger entry is invalid");
    if (typeof event.event_id !== "string" || !event.event_id || eventIds.has(event.event_id)) throw new Error("resolution event ledger contains a duplicate event_id");
    if (event.sequence !== index + 1) throw new Error("resolution event ledger sequence is invalid");
    if (event.predecessor_hash !== predecessor) throw new Error("resolution event ledger predecessor is invalid");
    if (!["resolve-critique", "repair-critique-resolution-history"].includes(event.operation)) throw new Error("resolution event ledger operation is invalid");
    if (typeof event.run_id !== "string" || !event.run_id || typeof event.subject !== "string" || !event.subject) throw new Error("resolution event ledger binding is invalid");
    if (expected.run_id && event.run_id !== expected.run_id) throw new Error("resolution event ledger run binding is invalid");
    if (expected.subject && event.subject !== expected.subject) throw new Error("resolution event ledger subject binding is invalid");
    requireDigest(event.event_hash, "resolution event ledger event_hash");
    const { event_hash, ...unsigned } = event;
    if (jsonDigest(unsigned) !== event_hash) throw new Error("resolution event ledger event_hash is invalid");
    requireDigest(event.authorization_sha256, "resolution event ledger authorization_sha256");
    if (authorizationDigests.has(event.authorization_sha256)) throw new Error("resolution event ledger contains a duplicate authorization");
    assertStoredAuthorizationBinding(event, expected);
    eventIds.add(event.event_id); authorizationDigests.add(event.authorization_sha256); predecessor = event_hash;
  }
  if (expected.bundle) assertLedgerMapsToBundle(events, expected.bundle, Boolean(expected.strict_coverage));
  return Object.freeze({ length: events.length, tail_hash: predecessor, digest: jsonDigest(resolutionEventLedger(events)) });
}

function assertExternalLedgerInput(input, authorization, strictCoverage) {
  if (!Array.isArray(input.resolution_events)) throw new Error("resolution event ledger is required");
  return validateResolutionEventLedger(input.resolution_events, { run_id: authorization.run_id, subject: authorization.subject, project_root: authorization.project_root, bundle: input.bundle, strict_coverage: strictCoverage });
}

function appendEvent(events, unsigned) {
  const event = { ...unsigned, event_hash: jsonDigest(unsigned) };
  return [...events, event];
}

/** Pure deterministic critique-resolution transition. Performs no I/O. */
export function resolveCritiqueTransition(input) {
  exact(input, ["bundle", "resolution_events", "authorization", "prior_record_id", "resolving_record_id"], "critique transition input");
  if (!record(input.bundle) || !Array.isArray(input.bundle.claims)) throw new Error("trust bundle claims are required");
  if (Object.hasOwn(input.bundle, "critique_resolution_events")) throw new Error("trust bundle must not carry external resolution events");
  const authorization = input.authorization;
  if (!record(authorization) || authorization.schema_version !== "1.0" || authorization.operation !== "resolve-critique") throw new Error("critique resolution authorization identity is invalid");
  const ledger = assertExternalLedgerInput(input, authorization, true);
  if (authorization.prior_record_id !== input.prior_record_id || authorization.resolving_record_id !== input.resolving_record_id) throw new Error("authorization does not bind the selected critique edge");
  const prior = oneClaim(input.bundle.claims, input.prior_record_id, "prior");
  const resolving = oneClaim(input.bundle.claims, input.resolving_record_id, "resolving");
  const priorMetadata = prior.metadata;
  const resolvingMetadata = resolving.metadata;
  if (priorMetadata.superseded_by) throw new Error("prior critique is already superseded");
  if (!["fail", "not_verified"].includes(prior.value)) throw new Error("prior critique must be failing or not verified");
  if (resolving.value !== "pass" || resolving.status !== "verified") throw new Error("resolving critique must be a verified pass");
  if (!priorMetadata.reviewer || priorMetadata.reviewer === resolvingMetadata.reviewer || authorization.expected_resolver !== resolvingMetadata.reviewer) throw new Error("resolution requires the distinct signed resolving reviewer");
  assertAuthorizationPreimage(authorization, priorMetadata, resolvingMetadata, input.bundle.claims);
  const lanes = failedLaneIds(priorMetadata);
  const findings = openFindingIds(priorMetadata);
  if (canonical(authorization.resolved_lane_ids) !== canonical(lanes) || canonical(authorization.resolved_finding_ids) !== canonical(findings)) throw new Error("authorization does not cover the exact failing critique surface");
  const resolvingLanes = new Map((resolvingMetadata.lanes ?? []).map((lane) => [String(lane.id), lane.status]));
  if (lanes.some((id) => resolvingLanes.get(id) !== "pass")) throw new Error("resolving critique does not pass every failed lane");
  const resolvingFindings = new Map((resolvingMetadata.findings ?? []).map((finding) => [String(finding.id), finding.status]));
  if (findings.some((id) => !["fixed", "accepted", "deferred", "false_positive"].includes(resolvingFindings.get(id)))) throw new Error("resolving critique does not close every open finding");
  const authorizationSha256 = jsonDigest(authorization);
  const eventId = `critique-resolution:${authorizationSha256}`;
  const resolution = {
    schema_version: "1.0", kind: "cross-reviewer", prior_record_id: input.prior_record_id,
    resolving_record_id: input.resolving_record_id, resolver: resolvingMetadata.reviewer,
    resolved_lane_ids: lanes, resolved_finding_ids: findings, resolved_at: authorization.requested_at,
    authorization_sha256: authorizationSha256, resolution_event_id: eventId,
  };
  const claims = input.bundle.claims.map((claim) => claim === prior ? { ...claim, status: "superseded", metadata: { ...priorMetadata, superseded_by: input.resolving_record_id, critique_resolution: resolution } } : claim);
  const unsignedEvent = {
    schema_version: "1.0", event_id: eventId, sequence: ledger.length + 1,
    predecessor_hash: ledger.tail_hash, operation: "resolve-critique",
    run_id: authorization.run_id, subject: authorization.subject,
    preimage_bundle_sha256: authorization.prior_bundle_sha256,
    prior_record_id: input.prior_record_id, prior_record_hash: priorMetadata.critique_record_hash,
    resolving_record_id: input.resolving_record_id, resolving_record_hash: resolvingMetadata.critique_record_hash,
    resolver: resolvingMetadata.reviewer, authorization_sha256: authorizationSha256,
    authorization_key_id: authorization.signature.key_id, authorization_nonce: authorization.nonce,
    edge: resolution,
    resulting_core_sha256: critiqueResolutionResultCoreDigest(priorMetadata, resolvingMetadata, resolution),
    signed_authorization: authorization,
  };
  return { bundle: { ...input.bundle, claims }, resolution_events: appendEvent(input.resolution_events, unsignedEvent) };
}

/** Pure, append-only attestation for an unrecoverable historical authority event. */
export function repairCritiqueResolutionHistoryTransition(input) {
  exact(input, ["bundle", "resolution_events", "authorization", "prior_record_id", "resolving_record_id", "current_completion_sha256", "ledger_bytes_sha256"], "history repair transition input");
  if (!record(input.bundle) || !Array.isArray(input.bundle.claims) || Object.hasOwn(input.bundle, "critique_resolution_events")) throw new Error("history repair requires a stripped trust bundle");
  const authorization = input.authorization;
  if (!record(authorization) || authorization.schema_version !== "1.0" || authorization.operation !== "repair-critique-resolution-history") throw new Error("history repair authorization identity is invalid");
  const ledger = assertExternalLedgerInput(input, authorization, false);
  if (!HISTORY_REPAIR_BRIDGE_FIELDS.every((field) => Object.hasOwn(authorization, field)) || !Object.hasOwn(authorization, "historical_bridge_sha256")) {
    throw new Error("history repair authorization requires every historical bridge field");
  }
  requireDigest(authorization.historical_bridge_sha256, "history repair bridge");
  if (authorization.historical_bridge_sha256 !== critiqueResolutionHistoryBridgeDigest(authorization)) throw new Error("history repair authorization bridge digest is invalid");
  if (authorization.current_bundle_sha256 !== authorization.preimage_bundle_sha256
    || authorization.current_ledger_sha256 !== input.ledger_bytes_sha256
    || authorization.current_ledger_length !== ledger.length
    || authorization.current_ledger_tail_hash !== ledger.tail_hash) {
    throw new Error("history repair authorization does not bind the exact current preimages");
  }
  requireDigest(input.current_completion_sha256, "current completion");
  if (authorization.current_completion_sha256 !== input.current_completion_sha256) throw new Error("history repair authorization does not bind the current completion digest");
  // This is deliberately only structural here. The authorization binds the exact
  // protected trust.bundle *bytes*, which a parsed-object transition cannot
  // reproduce without silently changing the signed preimage contract.
  requireDigest(authorization.preimage_bundle_sha256, "history repair authorization bundle preimage");
  requireDigest(input.ledger_bytes_sha256, "history repair ledger bytes");
  if (authorization.preimage_ledger_sha256 !== input.ledger_bytes_sha256 || authorization.preimage_ledger_length !== ledger.length || authorization.preimage_ledger_tail_hash !== ledger.tail_hash) throw new Error("history repair authorization does not bind the exact resolution event ledger preimage");
  if (authorization.reason_code !== "coordinator-external-ledger-overwrite-v1") throw new Error("history repair authorization reason is invalid");
  if (authorization.prior_record_id !== input.prior_record_id || authorization.resolving_record_id !== input.resolving_record_id) throw new Error("history repair authorization does not bind the selected critique edge");
  const prior = oneClaim(input.bundle.claims, input.prior_record_id, "prior");
  const resolving = oneClaim(input.bundle.claims, input.resolving_record_id, "resolving");
  const priorMetadata = prior.metadata; const resolvingMetadata = resolving.metadata;
  if (prior.status !== "superseded" || priorMetadata.superseded_by !== input.resolving_record_id || !record(priorMetadata.critique_resolution) || priorMetadata.critique_resolution.kind !== "cross-reviewer" || priorMetadata.reviewer === resolvingMetadata.reviewer) throw new Error("history repair requires an already-superseded distinct cross-reviewer edge");
  assertAuthorizationPreimage(authorization, priorMetadata, resolvingMetadata, input.bundle.claims);
  const edge = priorMetadata.critique_resolution;
  if (jsonDigest(edge) !== authorization.preserved_resolution_sha256) throw new Error("history repair authorization does not bind the preserved resolution edge");
  if (authorization.missing_resolution_event_id !== edge.resolution_event_id || authorization.missing_authorization_sha256 !== edge.authorization_sha256) throw new Error("history repair authorization does not bind the missing original event");
  const original = input.resolution_events.find((event) => event.event_id === edge.resolution_event_id || event.authorization_sha256 === edge.authorization_sha256);
  if (original) throw new Error("history repair is invalid because the original event is already present");
  if (input.resolution_events.some((event) => event.operation === "repair-critique-resolution-history" && (event.missing_resolution_event_id === edge.resolution_event_id || event.missing_authorization_sha256 === edge.authorization_sha256))) throw new Error("history repair already exists for the missing original event");
  const authorizationSha256 = jsonDigest(authorization);
  const unsignedEvent = {
    schema_version: "1.0", event_id: `critique-resolution-history-repair:${authorizationSha256}`,
    sequence: ledger.length + 1, predecessor_hash: ledger.tail_hash, operation: "repair-critique-resolution-history",
    run_id: authorization.run_id, subject: authorization.subject, preimage_bundle_sha256: authorization.preimage_bundle_sha256,
    prior_record_id: input.prior_record_id, prior_record_hash: priorMetadata.critique_record_hash,
    resolving_record_id: input.resolving_record_id, resolving_record_hash: resolvingMetadata.critique_record_hash,
    resolver: resolvingMetadata.reviewer, authorization_sha256: authorizationSha256,
    authorization_key_id: authorization.signature?.key_id, authorization_nonce: authorization.nonce,
    edge, missing_resolution_event_id: edge.resolution_event_id, missing_authorization_sha256: edge.authorization_sha256,
    reason_code: authorization.reason_code, current_completion_sha256: input.current_completion_sha256,
    verified_bridge_sha256: authorization.historical_bridge_sha256,
    resulting_core_sha256: critiqueResolutionResultCoreDigest(priorMetadata, resolvingMetadata, edge), signed_authorization: authorization,
  };
  return { bundle: input.bundle, resolution_events: appendEvent(input.resolution_events, unsignedEvent) };
}
