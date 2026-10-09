import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { createDockerExecutor } from './executor.mjs';
import { createControllerAuthority } from './authority.mjs';
import { createCommandRunner } from './commands.mjs';
import {createCommandOperationProvider,createOperationCommandRunner} from './operations.mjs';
import {createLearningCapture} from './learnings.mjs';
import { runAidlc } from './runtime.mjs';
import { KIT_ROOT, requestBindingDigest } from './compile.mjs';

export {runAidlc};

function privateController(workspace,controllerRoot){
  workspace=fs.realpathSync(workspace);controllerRoot=path.resolve(controllerRoot);
  // Resolve every existing parent before admission, so aliases cannot place
  // host authority or credentials inside a model-visible workspace.
  const missing=[];let ancestor=controllerRoot;
  while(!fs.existsSync(ancestor)){missing.unshift(path.basename(ancestor));const next=path.dirname(ancestor);if(next===ancestor)throw new Error('Controller ancestor unavailable');ancestor=next;}
  const resolved=path.join(fs.realpathSync(ancestor),...missing);
  const overlaps=(a,b)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
  if(overlaps(workspace,resolved))throw new Error('Controller state must be separate from model workspace');
  fs.mkdirSync(resolved,{recursive:true,mode:0o700});
  const stat=fs.lstatSync(resolved);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Controller must be a private regular directory');
  fs.chmodSync(resolved,0o700);return resolved;
}

export async function executeKit({request,controllerRoot,workerRunner,signal,operationProvider,knowledge}){
  if(request.schema!=='kontour.kit.execution_request'||request.version!=='1.0')throw new Error('Unsupported kit execution request');
  if(request.kit_id!=='aidlc')throw new Error('This entry executes the aidlc kit');
  controllerRoot=privateController(request.workspace,controllerRoot);
  const executor=createDockerExecutor({request,controllerRoot,workerRunner,signal});
  const authority=createControllerAuthority({policy:request.parameters?.authority_policy,requestDigest:requestBindingDigest(request),controllerRoot});
  executor.decide=async input=>{const proposal={...input,purpose:'review-disposition',request_digest:requestBindingDigest(request)};const grant=await authority.authorize(proposal);const verified=grant.authorized&&authority.verify(grant.receipt,proposal);return {authorized:verified,decision:verified?'accept':'defer',reference:grant.reference,receipt:grant.receipt,pending:grant.pending};};
  const commandRunner=createCommandRunner({workspace:request.workspace,controllerRoot,runId:request.run_id,image:request.engine_sandbox.image,ownerId:request.engine_sandbox.owner_id});
  operationProvider??=request.parameters?.operations?createCommandOperationProvider({config:request.parameters.operations,commandRunner:createOperationCommandRunner({workspace:request.workspace,controllerRoot}),controllerRoot}):undefined;
  knowledge??=createLearningCapture({controllerRoot});
  let result;
  try{result=await runAidlc({request,executor,commandRunner,authority,controllerRoot,signal,operationProvider,knowledge});}
  catch(error){result={status:'failed',failure:{reason:error.message},records:[],executions:[]};}
  fs.writeFileSync(path.join(controllerRoot,'runtime-result.json'),JSON.stringify(result,null,2)+'\n');
  const workers=executor.observed;
  const first=workers[0];const completeUsage=workers.length>0&&!executor.hasUnobservedStarts&&workers.every(worker=>worker.usage.complete);
  const completion=result.status==='completed'?'completed':result.status==='waiting'?'waiting':result.status==='budget_exhausted'?'budget_exhausted':'failed';
  return {schema:'kontour.kit.execution_result',version:'1.0',kit_id:'aidlc',run_id:request.run_id,
    status:completion,result,
    identity:{observed:!!first,source:'trusted-runtime-capture',model:first?.observed.argv_model??null,provider:first?.observed.provider??null,harness:first?.observed.harness??null,harness_version:first?.observed.harness_version??null,runtime:request.execution.runtime,evidence:workers.map(worker=>worker.observed.container_id).join(',')},
    turns_started:executor.turnsStarted,
    observations:{definition_digest:result.definition_digest,stages:result.records.map(record=>({stage:record.stage,record_digest:record.digest})),worker_contexts:workers.map(worker=>worker.observed.context_digest)},
    usage:{complete:completeUsage,source:completeUsage?'codex-turn-completed':'unavailable',input_tokens:completeUsage?workers.reduce((sum,w)=>sum+w.usage.input_tokens,0):null,output_tokens:completeUsage?workers.reduce((sum,w)=>sum+w.usage.output_tokens,0):null},
    workflow:{definition_digest:result.definition_digest,canonical_status:result.canonical_state?.status,failure:result.failure,authority_kind:'operator-policy',semantic_quality:'not_verified'}};

}

export async function executeRequestFile({requestFile,controllerRoot,authFile,workerRunner,brokerFactory,executionOwner=randomUUID(),signal}){
  const request=JSON.parse(fs.readFileSync(requestFile,'utf8'));
  if(request.schema!=='kontour.kit.execution_request'||request.version!=='1.0'||request.kit_id!=='aidlc')throw new Error('Unsupported kit execution request');
  request.workspace=fs.realpathSync(request.workspace);
  request.source_root=fs.realpathSync(request.source_root??KIT_ROOT);
  if(authFile){const credential=fs.realpathSync(authFile);for(const root of [request.workspace,request.source_root]){const relative=path.relative(root,credential);if(!relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw new Error('Host credentials must stay outside model workspace and kit source');}}
  controllerRoot=privateController(request.workspace,controllerRoot);
  const config=request.engine_sandbox;
  if(!config?.image)throw new Error('Explicit immutable worker image required');
  const limit=request.execution?.max_provider_requests;
  if(!Number.isSafeInteger(limit)||limit<1||limit>8192)throw new Error('Bounded provider request count required');
  config.owner_id=executionOwner;
  config.worker_root=path.resolve(config.worker_root??path.join(path.dirname(controllerRoot),path.basename(controllerRoot)+'-workers'));
  const workerRelative=path.relative(controllerRoot,config.worker_root);
  if(!workerRelative||workerRelative!=='..'&&!workerRelative.startsWith('..'+path.sep)&&!path.isAbsolute(workerRelative))throw new Error('Worker forks must stay outside private controller state');
  fs.mkdirSync(config.worker_root,{recursive:true,mode:0o700});
  config.forbidden_mount_roots=[...(config.forbidden_mount_roots??[]),{kind:'controller',path:controllerRoot},...(authFile?[{kind:'credentials',path:fs.realpathSync(authFile)}]:[])];
  if(!workerRunner)({runCodexDockerWorker:workerRunner}=await import('@kontourai/flow-agents/docker-worker'));
  config.artifact_root=path.resolve(config.artifact_root??path.join(controllerRoot,'worker-receipts'));
  const lockFile=path.join(controllerRoot,'execution.lock');
  fs.writeFileSync(lockFile,executionOwner,{flag:'wx',mode:0o600});
  let broker;
  try{
    if(!config.providerProxy){
      if(!authFile)throw new Error('Host auth file required; credentials are never mounted into workers');
      if(!brokerFactory)({startProviderProxy:brokerFactory}=await import('@kontourai/flow-agents/provider-broker'));
      config.providerProxy={model:request.execution.model};
      const requestDigest='sha256:'+requestBindingDigest(request),admissionFile=path.join(controllerRoot,'provider-admission.json');
      const initializeLedger=!fs.existsSync(admissionFile);
      if(initializeLedger)fs.writeFileSync(admissionFile,JSON.stringify({request_digest:requestDigest})+'\n',{flag:'wx',mode:0o600});
      else if(JSON.parse(fs.readFileSync(admissionFile,'utf8')).request_digest!==requestDigest)throw new Error('Provider admission binding changed');
      broker=await brokerFactory({authFile,model:request.execution.model,reasoningEffort:request.execution.reasoning_effort,maxRequests:request.execution.max_provider_requests,ledgerFile:path.join(controllerRoot,'provider-budget.json'),requestBindingDigest:requestDigest,initializeLedger});
      config.providerProxy={baseUrl:broker.baseUrl,capability:broker.capability,model:broker.model};
    }
    return await executeKit({request,controllerRoot,workerRunner,signal});
  }finally{
    try{if(broker){
      try{fs.writeFileSync(path.join(controllerRoot,`provider-observations-${executionOwner}.json`),JSON.stringify(broker.evidence,null,2)+'\n',{flag:'wx',mode:0o600});}
      finally{await broker.close();}
    }}finally{if(fs.readFileSync(lockFile,'utf8')!==executionOwner)throw new Error('Execution lock custody changed');fs.unlinkSync(lockFile);}
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);const get=name=>{const at=args.indexOf(name);return at<0?null:args[at+1];};
  const requestFile=get('--request'),controllerRoot=get('--controller-root');
  if(!requestFile||!controllerRoot)throw new Error('Usage: aidlc run --request <kit-execution-request.json> --controller-root <private-root> [--auth-file <host-auth.json>]');
  const result=await executeRequestFile({requestFile,controllerRoot,authFile:get('--auth-file')});
  console.log(JSON.stringify(result));
}
