import fs from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startRun, loadRun, validateDefinition, definitionIdentity, claimReadyStep, renewStepClaim, releaseStepClaim, evaluateClaimedStep, attachEvidence, recoverExpiredStepClaims } from '@kontourai/flow';
import { validateTrustBundle, buildTrustReport } from '@kontourai/surface';
import { validateUnits } from './dispatch.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const write = (file,value) => {fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=`${file}.${randomUUID()}.tmp`;fs.writeFileSync(temp,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,file);};
const safe = value => typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);

/** Host observation vocabulary; Surface derives the status, Flow evaluates it. */
export function unitObservationBundle({runId,parentRunId,stage,unitId,record,passing,invalid=false,now=new Date().toISOString()}) {
  const claimId=`${unitId}-completion`,type='test_output';
  return {schemaVersion:5,source:'kontour/aidlc-unit-flow;statusFunctionVersion=3',
    claims:[{id:claimId,subjectType:'flow-step',subjectId:`${runId}/${unitId}`,facet:'quality',claimType:'aidlc.unit-completion',fieldOrBehavior:`Observed unit execution ${stage}/${unitId}`,value:passing,createdAt:now,updatedAt:now,verificationPolicyId:'observed-unit-policy',metadata:{workflow_subject_ref:runId,parent_run_id:parentRunId,stage,record_digest:digest(record)}}],
    evidence:[{id:'unit-observation',claimId,evidenceType:type,method:'validation',sourceRef:`sha256:${digest(record)}`,excerptOrSummary:'Host-observed current unit basis and independently captured execution receipts. Parent stage sensors remain separate.',observedAt:now,collectedBy:'aidlc-unit-controller',passing}],
    events:[{id:'unit-observed',claimId,status:passing?'verified':'disputed',actor:'aidlc-unit-controller',method:'validation',evidenceIds:['unit-observation'],createdAt:now,verifiedAt:now},...(invalid?[{id:'unit-invalidated',claimId,type:'invalidation',status:'stale',actor:'aidlc-unit-controller',method:'validation',evidenceIds:[],createdAt:new Date(Date.parse(now)+1).toISOString()}]:[])],
    policies:[{id:'observed-unit-policy',claimType:'aidlc.unit-completion',requiredEvidence:[type],acceptanceCriteria:['Host observed completed execution and current byte basis'],reviewAuthority:'aidlc-unit-controller',validityRule:{kind:'manual'},stalenessTriggers:['source-or-artifact-basis-change'],conflictRules:[],impactLevel:'medium'}]};
}

/**
 * Public Flow owns child cursor, readiness, claims, exclusions and settlement.
 * Host-private completion records are trusted dispatch observations, never
 * model-supplied JSON; they retain basis/receipt provenance for current checks.
 * `join().complete` is required before the host may appraise the parent stage.
 * Parent sensor/semantic/human evidence remains a separate obligation.
 */
export async function createUnitFlow({controllerRoot,parentRunId,stage,units,actor,leaseSeconds=300,renewalIntervalMs=Math.max(250,Math.floor(leaseSeconds*500)),snapshotBasis,parentAdmissionStage}) {
  if(!safe(parentRunId)||!safe(stage?.slug)||!/^[a-f0-9]{64}$/.test(stage?.source_digest)||!Number.isInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>3600||!Number.isInteger(renewalIntervalMs)||renewalIntervalMs<10||renewalIntervalMs>=leaseSeconds*1000)throw new Error('Invalid bounded unit Flow configuration');
  controllerRoot=path.resolve(controllerRoot);const manifest=validateUnits(units),parent=await loadRun(parentRunId,controllerRoot);
  const admissionStage=parentAdmissionStage??stage.slug;
  if(!safe(admissionStage)||!parent.definition.steps.some(step=>step.id===admissionStage))throw new Error('Parent run does not own this stage');
  const parentAdmission=parent.state.transitions.filter(entry=>entry.to_step===admissionStage||entry.from_step===admissionStage).at(-1)??{initial_stage:admissionStage};
  const binding={parentRunId,parentAdmission,parent_admission_stage:admissionStage,stage:stage.slug,stage_source_digest:stage.source_digest,stage_contract_digest:digest(stage),units:manifest};
  const runId=`${parentRunId.slice(0,45)}-units-${digest(binding).slice(0,24)}`;
  const definition=validateDefinition({id:'aidlc.unit-dispatch',version:'1.0',execution:{mode:'multi-cursor',claim_contract_version:'1'},
    steps:manifest.map(unit=>({id:unit.id,next:null,needs:unit.depends_on??[],mutable_resources:unit.mutable_resources??['aidlc.shared-workspace']})),
    gates:Object.fromEntries(manifest.map(unit=>[`${unit.id}-gate`,{step:unit.id,expects:[{id:`${unit.id}-completion`,kind:'trust.bundle',required:true,description:'Current child-run and unit-bound host-observed completion.',bundle_claim:{claimType:'aidlc.unit-completion',subjectType:'flow-step',subjectId:`${runId}/${unit.id}`,accepted_statuses:['verified']}}]}]))});
  const files=path.join(controllerRoot,'unit-flows',runId),definitionFile=path.join(files,'definition.json'),recordsFile=path.join(files,'records.json');
  if(fs.existsSync(definitionFile)) {
    if(!isDeepStrictEqual(JSON.parse(fs.readFileSync(definitionFile,'utf8')),definition))throw new Error('Unit definition binding changed on resume');
    const existing=await loadRun(runId,controllerRoot);if(!isDeepStrictEqual(definitionIdentity(existing.definition),definitionIdentity(definition)))throw new Error('Canonical unit Flow definition changed');
  } else {
    if(parent.state.current_step!==admissionStage||['completed','cancelled'].includes(parent.state.status))throw new Error('Parent stage is not currently admitted');
    write(definitionFile,definition);await startRun(definitionFile,{cwd:controllerRoot,runId,params:{subject:runId,parent_run_id:parentRunId,parent_stage:stage.slug}});
  }
  await recoverExpiredStepClaims(runId,{cwd:controllerRoot});
  actor??={key:`aidlc-controller-${digest({host:hostname(),pid:process.pid,instance:randomUUID()}).slice(0,32)}`,kind:'runtime'};
  const active=new Map();let basisObserver=snapshotBasis;
  const readRecords=()=>fs.existsSync(recordsFile)?JSON.parse(fs.readFileSync(recordsFile,'utf8')):{};
  async function current(record,unitId) {
    if(!basisObserver||!record?.basis)return false;
    const observed=await basisObserver({stage,unit:manifest.find(unit=>unit.id===unitId),artifacts:record.artifacts??[],context:record.context??{}});
    return isDeepStrictEqual(observed,record.basis);
  }
  const leaseOptions=lease=>({claim_id:lease.claim_id,liveness_id:lease.liveness_id,actor:lease.actor,cwd:controllerRoot});
  function owned(lease, ignoreFailure=false) {
    const state=active.get(lease?.claim_id);
    if(!state||!isDeepStrictEqual(lease,state.lease))throw new Error('Unit claim is unknown or substituted');
    if(state.failure&&!ignoreFailure)throw state.failure;
    return state;
  }
  async function stop(state) {
    if(state.reuse)return;
    state.heartbeatStop.abort();await state.heartbeat;state.externalSignal?.removeEventListener('abort',state.externalAbort);
  }
  async function attach(unitId,record,passing,{invalid=false,supersede}={}) {
    const bundle=unitObservationBundle({runId,parentRunId,stage:stage.slug,unitId,record,passing,invalid});
    const valid=validateTrustBundle(bundle);
    const report=buildTrustReport(bundle,{now:invalid?new Date(Date.now()+5):new Date()});
    const file=path.join(files,'observations',`${unitId}-${randomUUID()}.json`);write(file,valid);
    const entry=await attachEvidence(runId,{cwd:controllerRoot,gate:`${unitId}-gate`,file,kind:'trust.bundle',producer:'aidlc-unit-controller',...(supersede?{supersede}: {})});
    return {id:entry.id,file,status:report.claims[0].status,record_digest:digest(record)};
  }
  async function claim({unit,signal}) {
    const unitId=typeof unit==='string'?unit:unit?.id;if(!manifest.some(entry=>entry.id===unitId))throw new Error('Unknown authoritative unit');
    if(signal?.aborted)throw new Error('Unit dispatch cancelled before canonical admission');
    const parentNow=await loadRun(parentRunId,controllerRoot);if(parentNow.state.current_step!==admissionStage||['completed','cancelled'].includes(parentNow.state.status))throw new Error('Parent stage admission changed');
    const existing=await loadRun(runId,controllerRoot),completed=readRecords()[unitId];
    if(existing.state.gate_outcomes.some(gate=>gate.gate_id===`${unitId}-gate`&&gate.status==='pass')) {
      if(!completed?.passed||!await current(completed.record,unitId))throw new Error('Previously passed canonical unit has stale basis; a new parent admission is required');
      // Explicit completion reuse bookkeeping, NEVER a Flow lease or execution authority.
      const lease={kind:'completed-unit-reuse',claim_id:`completed-unit-${randomUUID()}`,run_id:runId,step_id:unitId,evidence_id:completed.evidence.id,record_digest:digest(completed.record)};
      active.set(lease.claim_id,{lease,reuse:true,completed});return structuredClone(lease);
    }
    const admitted=await claimReadyStep(runId,{cwd:controllerRoot,claim_id:`unit-claim-${randomUUID()}`,liveness_id:`unit-live-${randomUUID()}`,step_id:unitId,actor,lease_seconds:leaseSeconds});
    const lease=structuredClone(admitted.claim),heartbeatStop=new AbortController(),executionStop=new AbortController();
    const state={lease,heartbeatStop,executionStop,failure:null,externalSignal:signal};
    state.externalAbort=()=>executionStop.abort(signal?.reason);signal?.addEventListener('abort',state.externalAbort,{once:true});
    state.heartbeat=(async()=>{try{while(!heartbeatStop.signal.aborted){try{await delay(renewalIntervalMs,undefined,{signal:heartbeatStop.signal});}catch(error){if(heartbeatStop.signal.aborted)return;throw error;}if(!heartbeatStop.signal.aborted)await renewStepClaim(runId,{...leaseOptions(lease),lease_seconds:leaseSeconds});}}catch(error){state.failure=error;executionStop.abort(error);}})();
    active.set(lease.claim_id,state);return lease;
  }
  async function renew(lease) {const state=owned(lease);if(state.reuse)throw new Error('Completed-unit reuse is not a renewable lease');return renewStepClaim(runId,{...leaseOptions(lease),lease_seconds:leaseSeconds});}
  async function settle(lease,record) {
    const state=owned(lease);
    if(state.reuse) {
      const before=state.completed.record,core=value=>({basis:value.basis,artifacts:value.artifacts,receipts:value.receipts.map(receipt=>({status:receipt.status,identity:receipt.identity,receipt:receipt.receipt})),findings:value.findings??[],reviews:value.reviews??[]});
      if(record?.status!=='completed'||!isDeepStrictEqual(core(record),core(before))||!await current(before,lease.step_id))throw new Error('Completed-unit replay differs from canonical observed completion');
      const canonical=await loadRun(runId,controllerRoot);if(!canonical.state.gate_outcomes.some(gate=>gate.gate_id===`${lease.step_id}-gate`&&gate.status==='pass'))throw new Error('Canonical completed-unit gate was invalidated');
      active.delete(lease.claim_id);return {run_id:runId,unit:lease.step_id,settled:true,passed:true,reused:true,evidence:state.completed.evidence};
    }
    if(state.failure||state.executionStop.signal.aborted)throw state.failure??new Error('Unit execution was cancelled');
    await renewStepClaim(runId,{...leaseOptions(lease),lease_seconds:leaseSeconds});
    const passing=record?.id===lease.step_id&&record.status==='completed'&&record.receipts?.length>0&&record.receipts.every(receipt=>receipt.status==='completed'&&receipt.identity_basis==='executor-observed')&&await current(record,lease.step_id);
    const prior=readRecords()[lease.step_id];const observation=await attach(lease.step_id,record,Boolean(passing),{supersede:prior?.evidence?.id});
    await renewStepClaim(runId,{...leaseOptions(lease),lease_seconds:leaseSeconds});
    const evaluated=await evaluateClaimedStep(runId,leaseOptions(lease));
    await stop(state);
    const passed=evaluated.settled&&evaluated.outcomes.length>0&&evaluated.outcomes.every(outcome=>outcome.status==='pass');
    const records=readRecords();records[lease.step_id]={record:structuredClone(record),evidence:observation,settled:evaluated.settled,passed};write(recordsFile,records);
    if(evaluated.settled)active.delete(lease.claim_id);
    return {run_id:runId,unit:lease.step_id,settled:evaluated.settled,passed,evidence:observation,outcomes:evaluated.outcomes};
  }
  async function release(lease,record) {
    const state=owned(lease,true);let failure;
    try {
      if(record?.status==='completed') {const result=await settle(lease,record);if(result.passed)return result;throw new Error('Canonical unit gate did not settle');}
      await stop(state);const observation=await attach(lease.step_id,record??{status:'failed'},false,{supersede:readRecords()[lease.step_id]?.evidence?.id});const records=readRecords();records[lease.step_id]={record:structuredClone(record??{status:'failed'}),evidence:observation,settled:false,passed:false};write(recordsFile,records);
    } catch(error) {failure=error;}
    await stop(state);
    try {if(active.has(lease.claim_id)&&!state.reuse)await releaseStepClaim(runId,{...leaseOptions(lease),reason:record?.reason??'unit-not-settled'});}catch(error){active.delete(lease.claim_id);throw new AggregateError([failure,error].filter(Boolean),'Unit failure cleanup could not release canonical claim');}
    active.delete(lease.claim_id);if(failure)throw failure;
    return {run_id:runId,unit:lease.step_id,settled:false};
  }
  async function join() {
    const run=await loadRun(runId,controllerRoot),records=readRecords(),units=[];
    for(const unit of manifest){const gate=run.state.gate_outcomes.find(entry=>entry.gate_id===`${unit.id}-gate`);const record=records[unit.id];units.push({id:unit.id,gate_status:gate?.status??'not_evaluated',settled:record?.settled===true,current:record?await current(record.record,unit.id):false,evidence:record?.evidence??null});}
    return {run_id:runId,parent_run_id:parentRunId,stage:stage.slug,status:run.state.status,complete:run.state.status==='completed'&&units.every(unit=>unit.gate_status==='pass'&&unit.settled&&unit.current),units,definition:definitionIdentity(run.definition)};
  }
  function bindExecutor(executor) {
    basisObserver=executor.snapshotBasis;
    return {...executor,claim,release,async execute(request){const state=[...active.values()].find(entry=>entry.lease.step_id===request.unit);if(!state)throw new Error('No canonical claim admits this unit execution');owned(state.lease);if(state.reuse)throw new Error('Canonical completed-unit reuse permits durable receipt replay only, never live execution');const assertAuthority=async()=>{try{owned(state.lease);await renewStepClaim(runId,{...leaseOptions(state.lease),lease_seconds:leaseSeconds});if(state.executionStop.signal.aborted)throw state.executionStop.signal.reason;}catch(error){state.failure=error;state.executionStop.abort(error);throw Object.assign(new Error('Execution aborted: canonical unit claim authority revoked',{cause:error}),{name:'AbortError'});}};await assertAuthority();const result=await executor.execute({...request,signal:AbortSignal.any([request.signal,state.executionStop.signal]),beforePublication:assertAuthority});await assertAuthority();return result;}};
  }
  async function close() {
    for(const state of [...active.values()]) {await stop(state);const run=await loadRun(runId,controllerRoot);if(!state.reuse&&run.state.multi_cursor.active_claims.some(claim=>claim.claim_id===state.lease.claim_id))await releaseStepClaim(runId,{...leaseOptions(state.lease),reason:'controller-close'});active.delete(state.lease.claim_id);}
  }
  return {runId,definition,claim,renew,settle,release,join,bindExecutor,close,load:()=>loadRun(runId,controllerRoot),signalFor:unitId=>[...active.values()].find(entry=>entry.lease.step_id===unitId)?.executionStop.signal};
}
