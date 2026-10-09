import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './compile.mjs';
import { readArtifact } from './artifacts.mjs';
import { snapshotWorkspace } from './runtime.mjs';
import { buildExecutionPrompt, observeOutputs } from './authority.mjs';

const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const put=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});};
const replace=(file,value)=>{const temp=`${file}.${randomUUID()}.tmp`;put(temp,value);fs.renameSync(temp,file);};
const normalizedResult=text=>{const raw=text?.trim().replace(/^```(?:json)?\s*\n/,'').replace(/\n```$/,'');const value=JSON.parse(raw);if(!value||!['completed','failed'].includes(value.status)||!Array.isArray(value.artifacts))throw new Error('Worker final response violates execution schema');for(const forbidden of ['receipt','identity','authorized','gate_status'])if(Object.hasOwn(value,forbidden))throw new Error(`Model cannot supply ${forbidden}`);return value;};
const safeRel=(file)=>typeof file==='string'&&file.length>0&&!path.isAbsolute(file)&&!file.split(/[\\/]/).some(p=>p==='..');
const inside=(root,file)=>{const rel=path.relative(root,file);return rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);};

/** Host-owned executor. Model messages never become identity or evidence receipts. */
export function createDockerExecutor({request,controllerRoot,workerRunner,signal}){
  const workspace=fs.realpathSync(request.workspace),config=request.engine_sandbox;
  if(!config||typeof workerRunner!=='function')throw new Error('Pinned worker sandbox port required');
  if(!Number.isSafeInteger(request.execution?.max_turns)||request.execution.max_turns<1||request.execution.max_turns>10000||!Number.isFinite(request.execution.timeout_s)||request.execution.timeout_s<=0||request.execution.timeout_s>86400)throw new Error('Finite execution turn and time budgets required');
  const workerRoot=path.resolve(config.worker_root??path.join(controllerRoot,'workers'));
  fs.mkdirSync(workerRoot,{recursive:true,mode:0o700});fs.mkdirSync(config.artifact_root,{recursive:true,mode:0o700});
  const historyFile=path.join(controllerRoot,'executor-history.json'),binding=digest({run_id:request.run_id,execution:request.execution,image:config.image,workspace});
  let history;
  if(fs.existsSync(historyFile)){
    const saved=json(historyFile);if(saved.digest!==digest(saved.history)||saved.history?.binding!==binding||!Array.isArray(saved.history.starts)||saved.history.starts.length>10000||!Number.isFinite(saved.history.started_at))throw new Error('Durable executor history drifted');history=saved.history;
  }else{history={binding,started_at:Date.now(),starts:[]};replace(historyFile,{history,digest:digest(history)});}
  const persistHistory=()=>replace(historyFile,{history,digest:digest(history)});
  if(!history.storage)history.storage={bytes:0,entries:0};
  // The shared storage budget is enforced by this host ledger, not by worker
  // self-reporting: shape follows the registered named-treatment request.
  const storage=config.storage_budget;
  if(storage!==undefined){
    if(!storage||typeof storage!=='object'||Array.isArray(storage))throw new Error('Storage budget must be an object');
    for(const key of ['max_bytes','max_entries','max_file_bytes','min_free_bytes'])if(!Number.isSafeInteger(storage[key])||storage[key]<0)throw new Error(`Storage budget ${key} must be a nonnegative integer`);
    if(storage.roots!==undefined&&(!Array.isArray(storage.roots)||!storage.roots.length||storage.roots.some(root=>typeof root!=='string'||!path.isAbsolute(root))))throw new Error('Storage budget roots must be nonempty absolute paths');
  }
  const admitted=new Map();const observed=history.starts.filter(start=>start.worker).map(start=>start.worker);let turns=history.starts.length;const start=history.started_at;let merge=Promise.resolve();
  const budget=()=>{if(signal?.aborted)throw Object.assign(new Error('Execution cancelled'),{code:'cancelled'});if(turns>=request.execution.max_turns||Date.now()-start>=request.execution.timeout_s*1000)throw Object.assign(new Error('Run execution budget exhausted'),{code:'execution_budget'});};
  const executor={
    get observed(){return observed;},get turnsStarted(){return turns;},get hasUnobservedStarts(){return history.starts.some(attempt=>!attempt.worker);},
    async admit(dispatch){
      const file=path.join(controllerRoot,'admissions',`${dispatch.request_digest}.json`);
      let identity;
      if(fs.existsSync(file))identity=json(file);
      else{const id=randomUUID();identity={actor:{runtime:'codex',session_id:id,host:`docker-${config.image.slice(-12)}`},instance_id:id};put(file,identity);}
      admitted.set(dispatch.request_digest,identity);return identity;
    },
    async snapshotBasis({artifacts=[]}){return {source_digest:snapshotWorkspace(workspace).source_digest,artifacts:artifacts.map(ref=>({path:ref.path,digest:readArtifact(workspace,ref.path).digest}))};},
    async loadBasis(key){const file=path.join(controllerRoot,'bases',`${key}.json`);return fs.existsSync(file)?json(file):null;},
    async saveBasis(key,basis){put(path.join(controllerRoot,'bases',`${key}.json`),basis);},
    async loadReceipt(dispatch){const file=path.join(controllerRoot,'executions',`${dispatch.request_digest}.json`);if(!fs.existsSync(file))return null;const saved=json(file),value=saved.result;if(saved.digest!==digest(value)||value?.receipt?.request_digest!==dispatch.request_digest||value.receipt.digest!==digest(value.observation))throw new Error('Stored execution receipt drifted');return value;},
    async saveReceipt(dispatch,result){put(path.join(controllerRoot,'executions',`${dispatch.request_digest}.json`),{result,digest:digest(result)});},
    async execute(dispatch){
      budget();const identity=admitted.get(dispatch.request_digest);if(!identity||JSON.stringify(identity)!==JSON.stringify(dispatch.expected_identity))throw new Error('Worker lacks host admission');
      if(history.starts.some(attempt=>attempt.request_digest===dispatch.request_digest))throw new Error('Prior worker execution requires durable receipt replay; automatic retry is forbidden');
      const attempt={request_digest:dispatch.request_digest,invocation_id:identity.instance_id,started_at:Date.now(),status:'started'};history.starts.push(attempt);turns++;persistHistory();
      const fork=path.join(workerRoot,identity.instance_id);fs.mkdirSync(fork,{recursive:false,mode:0o700});
      // Source files and authorized input artifacts only. No sibling raw contributions,
      // controller state, grader, source credentials, or canonical Flow state is copied.
      const before=snapshotWorkspace(workspace);
      for(const file of before.files){const dest=path.join(fork,file.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(workspace,file.path),dest);}
      const contribution=['contribute','dialogue'].includes(dispatch.phase);
      const targets=contribution?[{id:`contribution-${dispatch.role}`,stage:dispatch.stage,unit:dispatch.unit,path:`.aidlc/contributions/${dispatch.stage}/${dispatch.unit}/${dispatch.role}.md`}]:dispatch.context.artifact_targets??[];
      const priorArtifacts=[...(dispatch.context.upstream_artifacts??[]),...(dispatch.context.approved_plan_basis??[]),...(dispatch.context.approved_summary_basis??[]),...(dispatch.reviewed_artifacts??[]),...(dispatch.revised_artifacts??[]),...(dispatch.upstream??[]).flatMap(value=>value.artifacts??[]),...(dispatch.draft?.artifacts??[]),...(dispatch.contributions??dispatch.positions??[]).flatMap(value=>value.artifacts??[])];
      for(const ref of priorArtifacts){if(!safeRel(ref.path))throw new Error('Invalid artifact input path');try{readArtifact(workspace,ref.path);const dest=path.join(fork,ref.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(workspace,ref.path),dest);}catch(error){if(error.code!=='ENOENT')throw error;}}
      for(const diary of dispatch.context.learning_diaries??[]){const source=path.join(workspace,diary.path);if(fs.existsSync(source)){fs.mkdirSync(path.dirname(path.join(fork,diary.path)),{recursive:true});fs.copyFileSync(source,path.join(fork,diary.path));}}
      for(const local of ['.aidlc/state.md','.aidlc/project-description.json']){const source=path.join(workspace,local);if(fs.existsSync(source)){fs.mkdirSync(path.dirname(path.join(fork,local)),{recursive:true});fs.copyFileSync(source,path.join(fork,local));}}
      const prompt=buildExecutionPrompt({dispatch,workspace,sourceDigest:before.source_digest});
      prompt.instructions.push(`This invocation's exact output targets: ${JSON.stringify(targets)}. ${contribution?'Create only your own contribution file; other contributors are intentionally absent.':''}`);
      prompt.allowed_source_changes=dispatch.phase!=='review'&&!contribution&&!dispatch.context.planning_only&&(dispatch.context.stage?.workspace_requires===true||typeof dispatch.context.source_write_authority==='string');
      const contextFile=path.join(controllerRoot,'contexts',`${identity.instance_id}.json`);put(contextFile,prompt);
      let worker;
      try{worker=await workerRunner({image:config.image,workspace:fork,sourceRoot:request.source_root,contextFile,providerProxy:config.providerProxy,model:request.execution.model,reasoningEffort:request.execution.reasoning_effort,
        timeoutMs:Math.max(1,request.execution.timeout_s*1000-(Date.now()-start)),network:config.network??'bridge',readOnlyWorkspace:dispatch.phase==='review',artifactRoot:config.artifact_root,storageBudget:config.storage_budget,signal:dispatch.signal??signal,invocationId:identity.instance_id,runId:request.run_id});}
      catch(error){attempt.status='port-failed';attempt.error=error.message;persistHistory();throw error;}
      if(Buffer.byteLength(JSON.stringify(worker))>16*1024*1024)throw new Error('Worker capture exceeds durable receipt budget');
      attempt.worker=worker;attempt.status='observed';persistHistory();
      observed.push(worker);
      const observation={worker:identity.instance_id,container_id:worker.observed.container_id,provider_thread_id:worker.provider_thread_id,context_digest:worker.observed.context_digest,stdin_digest:worker.observed.stdin_digest,source_fork_digest:worker.observed.source_fork_digest,input_basis:dispatch.basis,terminal:worker.terminal,usage:worker.usage};
      const receipt={id:identity.instance_id,digest:digest(observation),request_digest:dispatch.request_digest};
      if(worker.terminal.status!==0||worker.terminal.timeout||worker.terminal.overflow||!worker.provider_thread_id||!worker.container_removed)return {status:'failed',identity,identity_basis:'executor-observed',receipt,input_basis:dispatch.basis,artifacts:[],observation};
      const response=normalizedResult(worker.final);
      // A successful provider process is not successful work. Preserve the
      // private fork for host diagnostics, but publish none of a worker's
      // known-failed source or artifact bytes to the canonical workspace.
      if(response.status!=='completed')return {status:'failed',identity,identity_basis:'executor-observed',receipt,input_basis:dispatch.basis,artifacts:[],observation};
      const after=snapshotWorkspace(fork);const prior=new Map(before.files.map(file=>[file.path,file]));const next=new Map(after.files.map(file=>[file.path,file]));
      const changed=[...new Set([...prior.keys(),...next.keys()])].filter(file=>prior.get(file)?.digest!==next.get(file)?.digest);
      if(changed.length&&!prompt.allowed_source_changes)throw new Error('Worker changed source outside stage authority');
      // Real units that declare explicit resource scopes are confined to them;
      // 'source/workspace'/'*' retain scheduler-serialized workspace custody,
      // and the 'stage' pseudo-unit is governed by stage-level write authority.
      const resources=dispatch.mutable_resources;
      if(dispatch.unit&&dispatch.unit!=='stage'&&changed.length&&Array.isArray(resources)&&resources.length&&!resources.includes('source/workspace')&&!resources.includes('*'))
        for(const file of changed)if(!resources.some(scope=>file===scope||file.startsWith(`${scope}/`)))throw Object.assign(new Error(`Source change outside declared unit resources: ${file}`),{code:'unit_scope'});
      if(dispatch.phase==='review'){
        if(changed.length)throw new Error('Read-only reviewer changed source');
        const basis=await executor.snapshotBasis({artifacts:dispatch.reviewed_artifacts??[]});
        return {status:response.status,identity,identity_basis:'executor-observed',receipt,input_basis:dispatch.basis,artifacts:dispatch.reviewed_artifacts??[],basis,verdict:response.verdict,findings:response.findings??[],observation};
      }
      const ownTargets=targets.filter(ref=>!dispatch.unit||dispatch.unit==='stage'||ref.unit===dispatch.unit);
      const returned=observeOutputs(fork,ownTargets);
      for(const approved of [...(dispatch.context.approved_plan_basis??[]),...(dispatch.context.approved_summary_basis??[])]){const present=returned.find(ref=>ref.path===approved.path);if(present&&present.digest!==approved.digest)throw new Error('Worker changed approved plan/test instructions');}
      if(response.artifacts.some(ref=>!safeRel(ref.path)||!ownTargets.some(target=>target.path===ref.path)))throw new Error('Worker returned artifacts outside assigned scope');
      const apply=async()=>{
        await dispatch.beforePublication?.();
        // Host-side shared storage ledger, enforced before any canonical byte
        // is written. Fail-closed: a later merge conflict still counts the
        // attempted writes against the budget.
        if(storage){
          for(const file of changed)if(next.has(file)&&next.get(file).bytes>storage.max_file_bytes)throw Object.assign(new Error(`Published file exceeds per-file storage budget: ${file}`),{code:'storage_budget'});
          let writeBytes=changed.reduce((sum,file)=>sum+(next.has(file)?next.get(file).bytes:0),0);let writeEntries=changed.length;
          for(const ref of returned){const size=fs.statSync(path.join(fork,ref.path)).size;if(size>storage.max_file_bytes)throw Object.assign(new Error(`Published artifact exceeds per-file storage budget: ${ref.path}`),{code:'storage_budget'});writeBytes+=size;writeEntries++;}
          if(history.storage.bytes+writeBytes>storage.max_bytes)throw Object.assign(new Error('Shared storage byte budget exhausted'),{code:'storage_budget'});
          if(history.storage.entries+writeEntries>storage.max_entries)throw Object.assign(new Error('Shared storage entry budget exhausted'),{code:'storage_budget'});
          const free=fs.statfsSync(workspace);
          if(BigInt(free.bavail)*BigInt(free.bsize)<BigInt(storage.min_free_bytes))throw Object.assign(new Error('Workspace free-space floor breached'),{code:'storage_budget'});
          if(storage.roots)for(const file of [...changed,...returned.map(ref=>ref.path)])if(!storage.roots.some(root=>{try{return inside(fs.realpathSync(root),path.join(workspace,file));}catch{return false;}}))throw Object.assign(new Error(`Published path outside declared storage roots: ${file}`),{code:'storage_budget'});
          history.storage.bytes+=writeBytes;history.storage.entries+=writeEntries;persistHistory();
        }
        for(const file of changed){let actual;try{actual=readArtifact(workspace,file).digest;}catch(error){if(error.code!=='ENOENT')throw error;}
          if(actual!==prior.get(file)?.digest)throw new Error(`Concurrent source merge conflict: ${file}`);}
        for(const file of changed){const target=path.join(workspace,file);if(!next.has(file)){fs.unlinkSync(target);continue;}fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(fork,file),target);}
        for(const ref of returned){const target=path.join(workspace,ref.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(fork,ref.path),target);}
      };
      const applied=merge.then(apply);merge=applied.catch(()=>{});await applied;
      return {status:response.status,identity,identity_basis:'executor-observed',receipt,input_basis:dispatch.basis,artifacts:returned.map(ref=>({path:ref.path,digest:ref.digest})),observation,changed_source:changed,...(contribution?{objections:response.objections??[],role:dispatch.role}:{})};
    }
  };
  return executor;
}
