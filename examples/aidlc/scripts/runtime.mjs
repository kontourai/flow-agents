import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { startRun, loadRun, attachEvidence, evaluateRun, validateDefinition } from '@kontourai/flow';
import { validateTrustBundle, buildTrustReport } from '@kontourai/surface';
import { readSnapshot, compileProfile, digest, requestBindingDigest } from './compile.mjs';
import { readArtifact, observeStage, projectInvalidation } from './artifacts.mjs';
import { runStageSensors, parseUnitEdges } from './sensors.mjs';
import { dispatchStage } from './dispatch.mjs';
import { createUnitFlow } from './unit-flow.mjs';
import { verifyFinalUnits } from './final-review.mjs';
import { plannedTestCommands } from './commands.mjs';
import { snapshotWorkspace } from './workspace.mjs';

const safeId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
const inside = (root, file) => { const rel=path.relative(root,file);return rel!== '..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel); };
const json = file => JSON.parse(fs.readFileSync(file,'utf8'));
const write = (file,value) => {fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${randomUUID()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(tmp,file);};

export { snapshotWorkspace } from './workspace.mjs';

export function artifactPaths(stage, unit=null) {
  const prefix=`.aidlc/artifacts/${stage.slug}${unit&&unit!=='stage'?`/${unit}`:''}`;
  return [...new Set([...(stage.produces??[]),...(stage.optional_produces??[])])].map(id=>({id,stage:stage.slug,unit:unit??null,path:`${prefix}/${id}.${id==='traceability'?'json':'md'}`}));
}

function currentRefs(workspace,refs){return refs.flatMap(ref=>{try{const value=readArtifact(workspace,ref.path);return [{...ref,digest:value.digest}];}catch{return [];}});}

function observationBundle({runId,stage,kind,status,record,now,invalid=false}){
  const claimId=`${stage}-${kind}`;const passing=status==='pass';
  const evidenceType=kind==='review'?'runtime_observation':'test_output';
  return {schemaVersion:5,source:'kontour/aidlc-runtime;statusFunctionVersion=3',
    claims:[{id:claimId,subjectType:'flow-step',subjectId:`${runId}/${stage}`,facet:'quality',claimType:`aidlc.${stage}-${kind}`,fieldOrBehavior:`Observed AI-DLC ${kind} for ${stage}`,value:passing,createdAt:now,updatedAt:now,verificationPolicyId:'observed-policy',metadata:{workflow_subject_ref:runId,record_digest:digest(record)}}],
    evidence:[{id:'observation',claimId,evidenceType,method:'validation',sourceRef:`sha256:${digest(record)}`,excerptOrSummary:'Runtime-observed bytes, checks and execution receipts; semantic correctness is independently graded.',observedAt:now,collectedBy:'aidlc-runtime',passing}],
    events:[{id:'observed',claimId,status:passing?'verified':'disputed',actor:'aidlc-runtime',method:'validation',evidenceIds:['observation'],createdAt:now,verifiedAt:now},...(invalid?[{id:'invalidated',claimId,type:'invalidation',status:'stale',actor:'aidlc-runtime',method:'validation',evidenceIds:[],createdAt:new Date(Date.parse(now)+1).toISOString()}]:[])],
    policies:[{id:'observed-policy',claimType:`aidlc.${stage}-${kind}`,requiredEvidence:[evidenceType],acceptanceCriteria:['Current runtime observations and their required checks pass.'],reviewAuthority:'system',validityRule:{kind:'manual'},stalenessTriggers:[],conflictRules:[],impactLevel:'low'}]};
}

/** Stage observations -> Surface -> actual persisted Flow evidence. No run-state edits. */
export async function attachObservation({controllerRoot,runId,stage,kind='completion',status,record,supersede,invalid=false}){
  const now=new Date().toISOString();const bundle=observationBundle({runId,stage,kind,status,record,now,invalid});
  validateTrustBundle(bundle);
  const observationId=randomUUID();const recordFile=path.join(controllerRoot,'observations',`${stage}-${kind}-${observationId}.record.json`);write(recordFile,record);
  const file=path.join(controllerRoot,'observations',`${stage}-${kind}-${observationId}.json`);write(file,bundle);
  const report=buildTrustReport(bundle,{now:new Date(Date.parse(now)+(invalid?2:0))});
  const evidence=await attachEvidence(runId,{cwd:controllerRoot,gate:`${stage}-gate`,file,kind:'trust.bundle',...(supersede?{supersede}:{}),producer:'aidlc-runtime'});
  return {evidence_id:evidence.id,file,record_file:recordFile,record_digest:digest(record),status:report.claims?.[0]?.status??null};
}

export async function refreshArtifactValidity({controllerRoot,runId,workspace,records}){
  const observations=records.filter(record=>record.artifact_observation);
  const projection=projectInvalidation(observations.map(record=>record.artifact_observation),workspace);
  const invalidated=[];
  for(const record of observations){if(projection[record.stage].status!=='stale'||record.invalidated)continue;
    const entry=await attachObservation({controllerRoot,runId,stage:record.stage,status:'fail',record:{prior:record.digest,validity:projection[record.stage]},invalid:true,supersede:record.evidence.completion.evidence_id});
    record.invalidated=true;record.invalidation=entry;invalidated.push(record.stage);}
  const deferred=[];
  for(const stage of invalidated){
    try{await evaluateRun(runId,{cwd:controllerRoot,gate:`${stage}-gate`});break;}
    catch(error){if(error.code!=='flow.evaluate.gate.reentry_pending')throw error;deferred.push(stage);}
  }
  return {projection,invalidated,deferred};
}

function boundDefinition(snapshot,profile,runId,projectType,omitted){
  const selected=structuredClone(snapshot);selected.profiles[profile].stages=selected.profiles[profile].stages.filter(id=>!omitted.has(id));
  const compiled=compileProfile(selected,profile,{projectType});
  for(const [i,step]of compiled.flow.steps.entries()){
    const source=selected.stages.find(s=>s.slug===step.id);const prior=compiled.flow.steps.slice(0,i).map(s=>s.id);
    const artifactDeps=(source.consumes??[]).flatMap(input=>selected.stages.filter(s=>prior.includes(s.slug)&&[...(s.produces??[]),...(s.optional_produces??[])].includes(input.artifact)).slice(-1).map(s=>s.slug));
    step.needs=[...new Set([...(step.needs??[]),...artifactDeps])];
    for(const expectation of compiled.flow.gates[`${step.id}-gate`].expects)expectation.bundle_claim.subjectId=`${runId}/${step.id}`;
  }
  return {flow:validateDefinition(compiled.flow),stageIds:compiled.stages,selectedSnapshot:selected};
}

export function stageContext(snapshot,profile,stage,workspace,allArtifacts,request){
  const upstreamArtifacts={};for(const entry of allArtifacts){try{readArtifact(workspace,entry.path);(upstreamArtifacts[entry.id]??=[]).push(entry.path);}catch{}}
  return {upstreamArtifacts,writeSensorPolicy:request.parameters?.write_sensor_policy,commands:request.parameters?.commands??{},claims:{statePath:'.aidlc/state.md',descriptionPath:'.aidlc/project-description.json',questionsPath:artifactPaths(stage).find(a=>a.id==='intent-capture-questions')?.path,memoryPaths:request.parameters?.memory_paths??{}},profile,projectType:request.parameters?.project_type??'brownfield'};
}

export function restoreUnits(workspace,records){
  const record=records.find(r=>r.stage==='units-generation'&&!r.invalidated&&r.sensors?.status==='pass');
  const dag=record?.artifacts?.find(a=>a.id==='unit-of-work-dependency');
  if(!dag)return null;
  const observed=readArtifact(workspace,dag.path);
  if(observed.digest!==dag.digest)throw new Error('Approved unit DAG bytes changed');
  return parseUnitEdges(observed.text).map(unit=>({id:unit.name,kind:unit.kind,depends_on:unit.depends_on,mutable_resources:['source/workspace']}));
}

/** Complete lifecycle conductor. Flow's persisted cursor remains the authority. */
export async function runAidlc({request,executor,commandRunner,authority,controllerRoot,signal}){
  const workspace=fs.realpathSync(request.workspace);controllerRoot=path.resolve(controllerRoot);
  fs.mkdirSync(controllerRoot,{recursive:true,mode:0o700});controllerRoot=fs.realpathSync(controllerRoot);
  if(inside(workspace,controllerRoot)||inside(controllerRoot,workspace))throw new Error('Controller state must be separate from model workspace');
  if(!safeId(request.run_id)||typeof request.prompt!=='string'||!request.prompt.trim())throw new Error('Bound run id and task prompt required');
  const snapshot=readSnapshot(),profile=request.parameters?.profile??'feature',defaults=snapshot.profiles[profile]?.defaults;
  if(!defaults)throw new Error('Unknown profile');
  const projectType=request.parameters?.project_type??'brownfield';const omitted=new Set();
  for(const decision of request.parameters?.stage_decisions??[]){if(!snapshot.profiles[profile].stages.includes(decision.stage)||decision.execute!==false||!decision.reason)throw new Error('Invalid scoped stage decision');
    const input={purpose:'stage-selection',stage:decision.stage,decision,request_digest:requestBindingDigest(request)};const grant=await authority?.authorize?.(input);
    if(!grant?.authorized||!grant.reference||authority.verify?.(grant.receipt,input)!==true)throw new Error('Stage selection needs verified host authority');omitted.add(decision.stage);}
  const {flow,stageIds,selectedSnapshot}=boundDefinition(snapshot,profile,request.run_id,projectType,omitted);
  const bindingFile=path.join(controllerRoot,'binding.json');const binding={request_digest:requestBindingDigest(request),definition_digest:digest(flow),profile,project_type:projectType,upstream_commit:snapshot.upstream.commit};
  if(fs.existsSync(bindingFile)){if(JSON.stringify(json(bindingFile))!==JSON.stringify(binding))throw new Error('Resume input or definition changed');}
  else{write(bindingFile,binding);const definitionFile=path.join(controllerRoot,'definition.json');write(definitionFile,flow);await startRun(definitionFile,{cwd:controllerRoot,runId:request.run_id,params:{subject:request.run_id}});}
  fs.mkdirSync(path.join(workspace,'.aidlc'),{recursive:true});fs.writeFileSync(path.join(workspace,'.aidlc/project-description.json'),JSON.stringify(request.prompt)+'\n');
  const recordsFile=path.join(controllerRoot,'stage-records.json');let records=fs.existsSync(recordsFile)?json(recordsFile):[];
  const executions=[];let failure=null,units=null;
  const refuse=async(stage,detail)=>{
    const prior=records.find(r=>r.stage===stage);const record={stage,profile,failure:detail,artifacts:[],sensors:{status:'fail',checks:[]},evidence:{},invalidated:false};record.digest=digest(record);
    record.evidence.completion=await attachObservation({controllerRoot,runId:request.run_id,stage,status:'fail',record,supersede:prior?.invalidation?.evidence_id??prior?.evidence?.completion?.evidence_id});
    if(snapshot.stages.find(s=>s.slug===stage)?.reviewer)record.evidence.review=await attachObservation({controllerRoot,runId:request.run_id,stage,kind:'review',status:'fail',record});
    records=records.filter(r=>r.stage!==stage);records.push(record);write(recordsFile,records);await evaluateRun(request.run_id,{cwd:controllerRoot});
  };
  const stageLimit=request.parameters?.max_gate_visits??128;let visits=0;
  while(!signal?.aborted&&visits++<stageLimit){
    await refreshArtifactValidity({controllerRoot,runId:request.run_id,workspace,records});write(recordsFile,records);
    units=restoreUnits(workspace,records);
    const run=await loadRun(request.run_id,controllerRoot);if(run.state.status==='completed'){failure=null;break;}
    const stageId=run.state.current_step;if(!stageIds.includes(stageId)){failure={reason:'invalid_cursor',stage:stageId};break;}
    const retained=records.find(record=>record.stage===stageId&&!record.invalidated&&record.sensors?.status==='pass');
    if(retained){await evaluateRun(request.run_id,{cwd:controllerRoot});continue;}
    const original=snapshot.stages.find(s=>s.slug===stageId);const stage=structuredClone(original);
    if(defaults.collaborators===false||defaults.collaborators==='off'){stage.support_agents=[];if(['pipeline','mob'].includes(stage.mode))stage.mode='inline';}
    if(stage.for_each&&!units){delete stage.for_each;}
    const allArtifacts=records.filter(record=>!record.invalidated).flatMap(record=>record.artifacts??[]);let artifacts=artifactPaths(stage);
    if(stage.for_each)artifacts=units.flatMap(unit=>artifactPaths(stage,unit.id));
    fs.writeFileSync(path.join(workspace,'.aidlc/state.md'),`# AI-DLC State\n\n## Project\n- **Project**: ${request.prompt.replace(/\n/g,' ')}\n- **Project Description Source**: project-description.json\n- **Scope**: ${defaults.scope??profile}\n- **Profile**: ${profile}\n- **Depth**: ${defaults.depth??'unspecified'}\n- **Current Stage**: ${stageId}\n`);
    const context={shared:{task:request.prompt,profile,defaults,workspace:'/workspace',stage,artifact_targets:artifacts,upstream_artifacts:allArtifacts,permissions:request.parameters?.permissions??{},plan_approval:'unapproved',prior_check_failures:records.find(record=>record.stage===stageId)?.sensors?.checks??[]},units:{}};
    if(stage.for_each)for(const unit of units)context.units[unit.id]={artifact_targets:artifacts.filter(a=>a.unit===unit.id),upstream_artifacts:allArtifacts.filter(a=>!a.unit||a.unit===unit.id)};
    if((request.parameters?.source_write_stages??[]).includes(stageId)){
      const input={purpose:'source-change',stage:stageId,basis:snapshotWorkspace(workspace).source_digest,request_digest:binding.request_digest};const grant=await authority?.authorize?.(input);
      if(!grant?.authorized||authority.verify?.(grant.receipt,input)!==true){failure={stage:stageId,reason:'authority_required',detail:grant};await refuse(stageId,failure);break;}
      context.shared.source_write_authority=grant.reference;
    }
    let dispatched;
    if(stage.phase==='initialization'){
      for(const id of stageIds)fs.mkdirSync(path.join(workspace,'.aidlc/artifacts',id),{recursive:true});
      dispatched={status:'completed',units:[],executions:0,bootstrap:{workspace_digest:snapshotWorkspace(workspace).source_digest,definition_digest:binding.definition_digest}};
    }else{
      if(stageId==='code-generation'&&defaults.plan_approval!==false&&defaults.plan_approval!=='off'){
        const planning={...stage,workspace_requires:false,reviewer:undefined,for_each:stage.for_each,produces:['code-generation-plan','unit-test-instructions'],optional_produces:[]};
        const planningContext=structuredClone(context);planningContext.shared.planning_only=true;planningContext.shared.artifact_targets=artifacts.filter(a=>['code-generation-plan','unit-test-instructions'].includes(a.id));
        for(const unitContext of Object.values(planningContext.units))unitContext.artifact_targets=unitContext.artifact_targets.filter(a=>['code-generation-plan','unit-test-instructions'].includes(a.id));
        const planned=await dispatchStage({stage:planning,units:stage.for_each?units:undefined,executor,context:planningContext,policy:request.parameters?.dispatch_policy??{},signal});executions.push(...planned.units.flatMap(u=>u.receipts??[]));
        if(planned.status!=='completed'){failure={stage:stageId,reason:'plan_failed',detail:planned};await refuse(stageId,failure);break;}
        const expected=artifacts.filter(a=>['code-generation-plan','unit-test-instructions'].includes(a.id));
        const basis=currentRefs(workspace,expected);
        if(basis.length!==expected.length||basis.some(ref=>!readArtifact(workspace,ref.path).text.trim())){failure={stage:stageId,reason:'approval_basis_incomplete'};await refuse(stageId,failure);break;}
        const input={purpose:'code-plan',stage:stageId,basis,source_digest:snapshotWorkspace(workspace).source_digest,request_digest:binding.request_digest};const grant=await authority?.authorize?.(input);
        if(!grant?.authorized||authority.verify?.(grant.receipt,input)!==true){failure={stage:stageId,reason:'authority_required',detail:grant};await refuse(stageId,failure);break;}
        context.shared.plan_approval='approved';context.shared.approved_plan_basis=basis;context.shared.authority_reference=grant.reference;
      }
      if(stage.phase==='operation'){
        const purpose=['environment-provisioning','deployment-execution'].includes(stageId)?'deployment':'operation';
        const input={purpose,stage:stageId,request_digest:binding.request_digest};const grant=await authority?.authorize?.(input);
        if(!grant?.authorized||authority.verify?.(grant.receipt,input)!==true){failure={stage:stageId,reason:'authority_required',detail:grant};await refuse(stageId,failure);break;}
      }
      let unitFlow;
      try{
        let stageExecutor=executor;
        if(stage.for_each){unitFlow=await createUnitFlow({controllerRoot,parentRunId:request.run_id,stage,units,snapshotBasis:executor.snapshotBasis});stageExecutor=unitFlow.bindExecutor(executor);}
        const historicalFile=unitFlow?path.join(controllerRoot,'unit-dispatch',`${unitFlow.runId}.json`):null;
        if(historicalFile&&fs.existsSync(historicalFile)){
          const saved=json(historicalFile);const canonical=await unitFlow.load();
          if(saved.unit_run_id!==unitFlow.runId||saved.stage_contract_digest!==digest(stage)||saved.dispatch_digest!==digest(saved.dispatched)||canonical.state.status!=='completed'||!units.every(unit=>canonical.state.gate_outcomes.some(gate=>gate.gate_id===`${unit.id}-gate`&&gate.status==='pass')))throw new Error('Historical unit dispatch is not canonically completed');
          dispatched=structuredClone(saved.dispatched);
        }else{
          dispatched=await dispatchStage({stage,units:stage.for_each?units:undefined,executor:stageExecutor,context,policy:{...request.parameters?.dispatch_policy,...(unitFlow?{requiresClaim:true}:{})},signal});
          if(historicalFile&&dispatched.status==='completed')write(historicalFile,{unit_run_id:unitFlow.runId,stage_contract_digest:digest(stage),dispatch_digest:digest(dispatched),dispatched});
        }
        if(dispatched.status==='completed'&&unitFlow){
          const historicalJoin=await unitFlow.join();
          if(!historicalJoin.complete&&historicalJoin.status==='completed'&&historicalJoin.units.every(unit=>unit.gate_status==='pass'&&unit.settled)&&stage.reviewer){
            const verification=await verifyFinalUnits({stage,units,dispatched,context,executor,controllerRoot,parentRunId:request.run_id,signal,policy:request.parameters?.dispatch_policy??{}});
            dispatched.final_verification=verification;dispatched.historical_join=historicalJoin;
            if(verification.status!=='completed')dispatched={...dispatched,status:'blocked',reason:verification.failure?.reason??'final_source_review_failed'};
          }else if(!historicalJoin.complete)dispatched={...dispatched,status:'blocked',reason:'canonical_unit_join_incomplete'};
        }
      }catch(error){failure={stage:stageId,reason:error.code==='execution_budget'||error.code==='storage_budget'?'budget_exhausted':'execution_failed',detail:{message:error.message,code:error.code??null}};await refuse(stageId,failure);break;}finally{await unitFlow?.close();}
      executions.push(...dispatched.units.flatMap(u=>u.receipts??[]),...(dispatched.final_verification?.dispatch?.units??[]).flatMap(u=>u.receipts??[]));
      if(dispatched.status==='awaiting_decision'){
        const input={purpose:'review-disposition',stage:stageId,decision:dispatched,request_digest:binding.request_digest};const grant=await authority?.authorize?.(input);
        if(grant?.authorized&&authority.verify?.(grant.receipt,input)===true&&!unitFlow)dispatched.status='completed';
      }
      if(dispatched.status!=='completed'){failure={stage:stageId,reason:dispatched.reason==='execution_budget'||dispatched.reason==='storage_budget'?'budget_exhausted':dispatched.reason??dispatched.status,detail:dispatched};await refuse(stageId,failure);break;}
      if(context.shared.approved_plan_basis?.some(ref=>readArtifact(workspace,ref.path).digest!==ref.digest)){failure={stage:stageId,reason:'approved_plan_changed'};await refuse(stageId,failure);break;}
    }
    const resolved=currentRefs(workspace,artifacts);
    if(stageId==='intent-capture'){
      const input={purpose:'input-confirmation',stage:stageId,basis:resolved,request_digest:binding.request_digest};const grant=await authority?.authorize?.(input);
      if(!grant?.authorized||authority.verify?.(grant.receipt,input)!==true){failure={stage:stageId,reason:'authority_required',detail:grant};await refuse(stageId,failure);break;}
    }
    let observation;
    if(stage.for_each){const perUnit=units.map(unit=>observeStage({snapshot:selectedSnapshot,profile,stage:stageId,root:workspace,artifacts:[...allArtifacts.filter(a=>!a.unit||a.unit===unit.id),...resolved.filter(a=>a.unit===unit.id)],projectType}));observation={...perUnit[0],inputs:perUnit.flatMap(o=>o.inputs),outputs:perUnit.flatMap(o=>o.outputs),findings:perUnit.flatMap(o=>o.findings),structural_status:perUnit.every(o=>o.structural_status==='pass')?'pass':'fail'};}
    else observation=observeStage({snapshot:selectedSnapshot,profile,stage:stageId,root:workspace,artifacts:[...allArtifacts,...resolved],projectType});
    const sensorContext=stageContext(snapshot,profile,stage,workspace,allArtifacts,request);
    sensorContext.skippedStages=snapshot.stages.map(stage=>stage.slug).filter(id=>!stageIds.includes(id));
    sensorContext.codeArtifacts=[...new Set(dispatched.units.flatMap(unit=>(unit.receipts??[]).flatMap(receipt=>receipt.changed_source??[])))].flatMap(file=>{try{return [{path:file,digest:readArtifact(workspace,file).digest}];}catch{return [];}});
    let sensors;
    if(stage.for_each){const results=await Promise.all(units.map(unit=>runStageSensors({stage:original,workspace,artifacts:resolved.filter(a=>a.unit===unit.id),context:{...stageContext(snapshot,profile,stage,workspace,allArtifacts.filter(a=>!a.unit||a.unit===unit.id),request),skippedStages:sensorContext.skippedStages,codeArtifacts:sensorContext.codeArtifacts,unit:unit.id},commandRunner})));sensors={status:results.every(r=>r.status==='pass')?'pass':results.some(r=>r.status==='fail')?'fail':'not_verified',checks:results.flatMap((r,i)=>r.checks.map(check=>({...check,unit:units[i].id})))};}
    else sensors=await runStageSensors({stage:original,workspace,artifacts:resolved,context:sensorContext,commandRunner});
    const tests=[];
    if(stageId==='build-and-test'){
      // A masked/unexecutable planned command fails this gate with the real
      // reason; it never aborts the adapter and never silently passes.
      let planned=null;
      try{planned=allArtifacts.filter(a=>a.id==='unit-test-instructions').map(instruction=>({instruction,commands:plannedTestCommands(readArtifact(workspace,instruction.path).text)}));}
      catch(error){planned=[];sensors={...sensors,status:'fail',checks:[...sensors.checks,{id:'planned-unit-tests',status:'fail',findings:[`Approved unit test instructions cannot be safely executed: ${error.message}`]}]};}
      for(const {instruction,commands} of planned)for(const command of commands){
        const result=await commandRunner?.({id:'planned-unit-test',command,cwd:workspace,timeoutMs:request.parameters?.check_timeout_ms??120000,maxOutputBytes:1024*1024,basis:[{path:instruction.path,sha256:readArtifact(workspace,instruction.path).digest}]});
        tests.push({command,unit:instruction.unit,passed:result?.exitCode===0&&!!result.receipt,receipt:result?.receipt??null});}
      if(sensors.status!=='fail'&&(!tests.length||tests.some(test=>!test.passed)))sensors={...sensors,status:tests.length?'fail':'not_verified',checks:[...sensors.checks,{id:'planned-unit-tests',status:tests.length?'fail':'not_verified',findings:tests.length?['Actual planned unit commands failed.']:['No executable unit test command in approved instructions.']}]};
    }
    if(stage.workspace_requires===true||context.shared.source_write_authority||dispatched.units.some(unit=>(unit.receipts??[]).some(receipt=>receipt.changed_source?.length)))observation.source_digest=snapshotWorkspace(workspace).source_digest;
    const passing=observation.structural_status==='pass'&&sensors.status==='pass';
    const record={stage:stageId,profile,artifacts:resolved,artifact_observation:observation,sensors,tests,dispatch:dispatched,evidence:{},invalidated:false};record.digest=digest(record);
    const prior=records.find(r=>r.stage===stageId);
    record.evidence.completion=await attachObservation({controllerRoot,runId:request.run_id,stage:stageId,status:passing?'pass':'fail',record,supersede:prior?.invalidation?.evidence_id??prior?.evidence.completion.evidence_id});
    if(stage.reviewer)record.evidence.review=await attachObservation({controllerRoot,runId:request.run_id,stage:stageId,kind:'review',status:passing?'pass':'fail',record:{reviews:dispatched.final_verification?.dispatch?.units?.flatMap(u=>u.receipts??[])??dispatched.units.flatMap(u=>u.reviews??[]),final_source_acceptance:dispatched.final_verification?.join??null},supersede:prior?.evidence.review?.evidence_id});
    records=records.filter(r=>r.stage!==stageId);records.push(record);write(recordsFile,records);
    const outcome=await evaluateRun(request.run_id,{cwd:controllerRoot});
    if(!passing){failure={stage:stageId,reason:'required_checks_failed',sensors,findings:observation.findings};if(request.parameters?.repair_checks===false)break;continue;}
    if(stageId==='units-generation'){
      const dag=resolved.find(a=>a.id==='unit-of-work-dependency');if(!dag){failure={stage:stageId,reason:'unit_manifest_missing'};break;}
      units=parseUnitEdges(readArtifact(workspace,dag.path).text).map(unit=>({id:unit.name,kind:unit.kind,depends_on:unit.depends_on,mutable_resources:['source/workspace']}));
    }
  }
  const run=await loadRun(request.run_id,controllerRoot);
  return {schema_version:'1.0',run_id:request.run_id,profile,definition_digest:binding.definition_digest,upstream_commit:snapshot.upstream.commit,
    status:signal?.aborted?'cancelled':run.state.status==='completed'?'completed':failure?.reason==='authority_required'||failure?.reason==='awaiting_decision'||failure?.reason==='mob_judgment'||failure?.reason==='advisory_review'?'waiting':failure?.reason==='budget_exhausted'||visits>stageLimit?'budget_exhausted':'failed',failure,records,executions,canonical_state:run.state,semantic_quality:'not_verified'};
}
