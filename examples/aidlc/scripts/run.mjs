import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { createDockerExecutor } from './executor.mjs';
import { createControllerAuthority } from './authority.mjs';
import { createCommandRunner } from './commands.mjs';
import { runAidlc } from './runtime.mjs';
import { digest, requestBindingDigest } from './compile.mjs';

export {runAidlc};

export async function executeNamedTreatment({request,controllerRoot,workerRunner}){
  if(request.schema!=='kontour.evals.named_treatment_request'||request.version!=='1.0')throw new Error('Unsupported named treatment request');
  if(request.treatment_kind!=='kontour-aidlc')throw new Error('This adapter executes Kontour only; AWS must use its pinned native engine adapter');
  const executor=createDockerExecutor({request,controllerRoot,workerRunner});
  const authority=createControllerAuthority({policy:request.parameters?.authority_policy,requestDigest:requestBindingDigest(request),controllerRoot});
  executor.decide=async input=>{const proposal={...input,purpose:'review-disposition',request_digest:requestBindingDigest(request)};const grant=await authority.authorize(proposal);const verified=grant.authorized&&authority.verify(grant.receipt,proposal);return {authorized:verified,decision:verified?'accept':'defer',reference:grant.reference,receipt:grant.receipt};};
  const commandRunner=createCommandRunner({workspace:request.workspace,controllerRoot,runId:request.run_id,image:request.engine_sandbox.image});
  let result;
  try{result=await runAidlc({request,executor,commandRunner,authority,controllerRoot});}
  catch(error){result={status:'failed',failure:{reason:error.message},records:[],executions:[]};}
  fs.writeFileSync(path.join(controllerRoot,'runtime-result.json'),JSON.stringify(result,null,2)+'\n');
  const workers=executor.observed;
  const first=workers[0];const completeUsage=workers.length>0&&!executor.hasUnobservedStarts&&workers.every(worker=>worker.usage.complete);
  const completion=result.status==='completed'?'completed':result.status==='waiting'?'waiting':result.status==='budget_exhausted'?'budget_exhausted':'failed';
  return {schema:'kontour.evals.named_treatment_capture',version:'1.0',run_id:request.run_id,attempt_id:request.attempt_id,arm_id:request.arm_id,case_id:request.case_id,
    seed_digest:request.seed_digest,source_digest:request.source_digest,
    identity:{observed:!!first,source:'trusted-runner-capture',model:first?.observed.argv_model??null,provider:first?.observed.provider??null,harness:first?.observed.harness??null,harness_version:first?.observed.harness_version??null,runtime:request.execution.runtime,evidence:workers.map(worker=>worker.observed.container_id).join(',')},
    turns_started:executor.turnsStarted,completion,
    engagement:{authenticated_by:'trusted_runner',source:'runtime_observation',evidence:JSON.stringify({flow_definition:result.definition_digest,stage_observations:result.records.map(record=>({stage:record.stage,record_digest:record.digest})),worker_contexts:workers.map(worker=>worker.observed.context_digest)}),source_digest:request.source_digest,engaged:workers.length>0&&result.records.length>3},
    usage:{complete:completeUsage,source:completeUsage?'codex-turn-completed':'unavailable',input_tokens:completeUsage?workers.reduce((sum,w)=>sum+w.usage.input_tokens,0):null,output_tokens:completeUsage?workers.reduce((sum,w)=>sum+w.usage.output_tokens,0):null},
    workflow:{definition_digest:result.definition_digest,canonical_status:result.canonical_state?.status,failure:result.failure,authority_kind:'operator-policy',semantic_quality:'not_verified'}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);const get=name=>{const at=args.indexOf(name);return at<0?null:args[at+1];};
  const file=get('--request'),controllerRoot=get('--controller-root');if(!file||!controllerRoot)throw new Error('Usage: run.mjs --request <named-request.json> --controller-root <private-root>');
  const request=JSON.parse(fs.readFileSync(file,'utf8'));const helper=request.engine_sandbox?.worker_helper;if(!helper||!path.isAbsolute(helper))throw new Error('Trusted worker helper required');
  const {runCodexDockerWorker}=await import(pathToFileURL(helper).href);
  const capture=await executeNamedTreatment({request,controllerRoot:path.resolve(controllerRoot),workerRunner:runCodexDockerWorker});
  console.log(JSON.stringify(capture));
}
