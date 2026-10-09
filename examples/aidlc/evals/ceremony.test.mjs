import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCeremony,effectiveStage,summaryTargets} from '../scripts/ceremony.mjs';
import {constructionOrder,constructionBlock} from '../scripts/construction.mjs';
import {readSnapshot} from '../scripts/compile.mjs';
test('effective review ceiling follows pinned executable semantics, never conjures or raises reviewers',()=>{
 const stage={slug:'fixture',mode:'mob',support_agents:['peer'],reviewer:'review',review_class:'adversarial',reviewer_max_iterations:3};
 assert.equal(effectiveStage(stage,resolveCeremony({review_cap:'advisory'})).reviewer_max_iterations,1);
 assert.equal(effectiveStage(stage,resolveCeremony({review_cap:'none'})).reviewer,undefined);
 assert.equal(effectiveStage({...stage,review_class:'advisory'},resolveCeremony({review_cap:'adversarial'})).review_class,'advisory');
 assert.equal(effectiveStage({...stage,reviewer:undefined},resolveCeremony({})).reviewer,undefined);
 assert.equal(effectiveStage(stage,resolveCeremony({collaborators:'off'})).mode,'inline');
});
test('ceremony override validation refuses unknown and malformed switches',()=>{
 assert.throws(()=>resolveCeremony({},{sensors:'typo'}));assert.throws(()=>resolveCeremony({},{bypass:true}));
 assert.equal(resolveCeremony({sensors:false}).sensors,'off');
});
test('summary declaration requires real question artifacts unless explicitly disabled',()=>{
 const stage={slug:'fixture',summary_confirmation:'required'};
 assert.throws(()=>summaryTargets(stage,[],resolveCeremony({})),/without questions/);
 assert.deepEqual(summaryTargets(stage,[],resolveCeremony({summary_confirmation:'off'})),[]);
});
test('construction walk honors dependencies and complete contiguous per-unit block',()=>{
 const units=[{id:'api',depends_on:['core']},{id:'core',depends_on:[]}];assert.deepEqual(constructionOrder(units).map(unit=>unit.id),['core','api']);
 assert.throws(()=>constructionOrder([{id:'api',depends_on:['missing']}]));
 const snapshot=readSnapshot();assert.deepEqual(constructionBlock(snapshot,snapshot.profiles.feature.stages,'functional-design'),['functional-design','nfr-requirements','nfr-design','infrastructure-design','code-generation']);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {runAidlc,snapshotWorkspace} from '../scripts/runtime.mjs';
import {digest,requestBindingDigest} from '../scripts/compile.mjs';
import {createControllerAuthority} from '../scripts/authority.mjs';
import {loadRun} from '@kontourai/flow';

test('two-unit skeleton executes entire Bolts in real child Flows and refuses the second before checkpoint authority',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aidlc-ceremony-')),workspace=path.join(root,'workspace'),controllerRoot=path.join(root,'controller');fs.mkdirSync(workspace);fs.mkdirSync(controllerRoot);
 try {
 const snapshot=readSnapshot(),keep=new Set(['workspace-scaffold','workspace-detection','state-init','units-generation','functional-design','nfr-requirements']);
 const request={run_id:'skeleton-walk',workspace,prompt:'Synthetic construction boundary fixture',parameters:{profile:'feature',project_type:'greenfield',ceremony:{review_cap:'none',sensors:'off',summary_confirmation:'off',plan_approval:'off',collaborators:'off',learnings:'off',skeleton:'on'},stage_decisions:snapshot.profiles.feature.stages.filter(id=>!keep.has(id)).map(stage=>({stage,execute:false,reason:'Synthetic boundary fixture'})),repair_checks:false}};
 const ids=new Map(),order=[];
 const executor={
  async admit(req){const id=randomUUID(),identity={actor:{runtime:'test',host:'localhost',session_id:id},instance_id:id};ids.set(req.request_digest,identity);return identity;},
  async snapshotBasis({artifacts=[]}){return {source_digest:snapshotWorkspace(workspace).source_digest,artifacts:artifacts.map(ref=>({path:ref.path,digest:digest(fs.readFileSync(path.join(workspace,ref.path)))}))};},
  async execute(req){if(req.phase==='review')return {status:'completed',identity:ids.get(req.request_digest),identity_basis:'executor-observed',receipt:{id:randomUUID(),digest:digest(req.request_digest),request_digest:req.request_digest},input_basis:req.basis,basis:{source_digest:req.basis.source_digest,artifacts:(req.reviewed_artifacts??[]).map(ref=>({path:ref.path,digest:ref.digest}))},artifacts:req.context.final_review_artifacts??[],verdict:'ready',findings:[]};order.push(`${req.unit}.${req.stage}`);for(const target of req.context.artifact_targets){const file=path.join(workspace,target.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,target.id==='unit-of-work-dependency'?'# Unit DAG\n\n```yaml\nunits:\n  - name: api\n    depends_on: [core]\n  - name: core\n    depends_on: []\n```\n':'# Actual fixture artifact\n\n## Basis\nFixture task.\n');}return {status:'completed',identity:ids.get(req.request_digest),identity_basis:'executor-observed',receipt:{id:randomUUID(),digest:digest(req.request_digest),request_digest:req.request_digest},input_basis:req.basis,artifacts:req.context.artifact_targets.map(target=>({path:target.path,digest:digest(fs.readFileSync(path.join(workspace,target.path)))}))};}
 };
 const authority=createControllerAuthority({policy:{reference:'test-policy',purposes:['stage-selection']},requestDigest:requestBindingDigest(request),controllerRoot});
 const held=await runAidlc({request,executor,authority,controllerRoot});assert.equal(held.status,'waiting',JSON.stringify(held.failure));
 assert.deepEqual(order.filter(item=>!item.startsWith('stage.')),['core.functional-design','core.nfr-requirements']);
 const children=fs.readdirSync(path.join(controllerRoot,'construction'));assert.equal(children.length,1);assert.equal((await loadRun(children[0],path.join(controllerRoot,'construction',children[0]))).state.status,'completed');
 // A separate registration demonstrates admission of the second whole Bolt.
 const secondRoot=path.join(root,'second');fs.mkdirSync(secondRoot);const reviewedRequest={...request,parameters:{...request.parameters,ceremony:{...request.parameters.ceremony,review_cap:'adversarial'}}};const accepted=createControllerAuthority({policy:{reference:'test-policy',purposes:['stage-selection','skeleton-checkpoint','review-disposition']},requestDigest:requestBindingDigest(reviewedRequest),controllerRoot:secondRoot});order.length=0;
 const completed=await runAidlc({request:reviewedRequest,executor,authority:accepted,controllerRoot:secondRoot});assert.equal(completed.status,'completed',JSON.stringify(completed.failure));
 assert.deepEqual(order.filter(item=>!item.startsWith('stage.')),['core.functional-design','core.nfr-requirements','api.functional-design','api.nfr-requirements']);
 assert.equal(completed.records.find(record=>record.stage==='functional-design').construction_children.length,2);
 assert.equal(completed.records.find(record=>record.stage==='functional-design').dispatch.final_verification.join.complete,true);
 assert.equal(completed.records.find(record=>record.stage==='functional-design').sensors.status,'disabled');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('summary policy authorizes exact operator bytes, refuses substituted bytes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aidlc-summary-'));
 try{const basis=[{id:'requirements-questions',path:'questions.md',digest:'b'.repeat(64)}];const authority=createControllerAuthority({policy:{reference:'fixture',purposes:['summary-confirmation'],summary_confirmations:{'requirements-analysis':{reference:'operator-answer',source:'operator-supplied',basis}}},requestDigest:'a'.repeat(64),controllerRoot:root});
 const input={purpose:'summary-confirmation',stage:'requirements-analysis',basis,source_digest:'c'.repeat(64),request_digest:'a'.repeat(64)};
 const grant=await authority.authorize(input);assert.equal(grant.authorized,true);assert.equal(authority.verify(grant.receipt,input),true);assert.equal(authority.verify(grant.receipt,{...input,source_digest:'d'.repeat(64)}),false);
 assert.equal((await authority.authorize({...input,basis:[]})).authorized,false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('operation cannot complete without a provider or with forged provider receipt; local authenticated target works',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aidlc-operation-')),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
 try{
 const snapshot=readSnapshot(),stage='environment-provisioning',request={run_id:'local-operation',workspace,prompt:'Provision a reversible local fixture environment only',parameters:{profile:'enterprise',project_type:'greenfield',ceremony:{summary_confirmation:'off',sensors:'off',review_cap:'none',learnings:'off',skeleton:'off',collaborators:'off'},stage_decisions:snapshot.profiles.enterprise.stages.filter(id=>id!==stage).map(stage=>({stage,execute:false,reason:'Authorized isolated local operation test'})),repair_checks:false}};
 const ids=new Map();let workers=0;
 const executor={async admit(req){const id=randomUUID(),identity={actor:{runtime:'local-test',host:'localhost',session_id:id},instance_id:id};ids.set(req.request_digest,identity);return identity;},async snapshotBasis({artifacts=[]}){return {source_digest:snapshotWorkspace(workspace).source_digest,artifacts:artifacts.map(ref=>({path:ref.path,digest:digest(fs.readFileSync(path.join(workspace,ref.path)))}))};},async execute(req){workers++;for(const target of req.context.artifact_targets){const file=path.join(workspace,target.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# Provisioning\n\n## Basis\nAuthenticated local fixture receipt.\n');}return {status:'completed',identity:ids.get(req.request_digest),identity_basis:'executor-observed',receipt:{id:randomUUID(),digest:digest(req.request_digest),request_digest:req.request_digest},input_basis:req.basis,artifacts:req.context.artifact_targets.map(target=>({path:target.path,digest:digest(fs.readFileSync(path.join(workspace,target.path)))}))};}};
 async function run(name,operationProvider){const controllerRoot=path.join(root,name);fs.mkdirSync(controllerRoot);const authority=createControllerAuthority({policy:{reference:'authorized-local-test',purposes:['stage-selection','deployment'],deployment:true},requestDigest:requestBindingDigest(request),controllerRoot});return runAidlc({request,executor,authority,controllerRoot,operationProvider});}
 const missing=await run('missing');assert.equal(missing.failure.reason,'operation_provider_required');assert.equal(workers,0);
 const forged=await run('forged',{execute:async()=>({status:'completed',id:'model-invented'}),verify:async()=>false});assert.equal(forged.failure.reason,'operation_not_verified');assert.equal(workers,0);
 const receipts=new Map(),target=path.join(workspace,'local-environment.json');
 const operationProvider={async execute(input){const id=randomUUID();fs.writeFileSync(target,JSON.stringify({environment:'local-fixture'}));const receipt={status:'completed',id,input_digest:digest(input),output_digest:digest(fs.readFileSync(target))};receipts.set(id,receipt);return receipt;},async verify(receipt,input){return receipts.get(receipt.id)===receipt&&receipt.input_digest===digest(input)&&receipt.output_digest===digest(fs.readFileSync(target));}};
 const success=await run('success',operationProvider);assert.equal(success.status,'completed',JSON.stringify(success.failure));assert.ok(success.records[0].operation_receipt.id);assert.ok(success.records[0].artifact_observation.source_digest);assert.equal(workers,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

import {createCommandOperationProvider} from '../scripts/operations.mjs';
import {spawnSync} from 'node:child_process';
test('operator command provider retains real process receipt and output bytes across restart',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aidlc-command-')),workspace=path.join(root,'source'),controllerRoot=path.join(root,'controller');fs.mkdirSync(workspace);fs.mkdirSync(controllerRoot);
 try{
 const config={stages:{'environment-provisioning':{argv:[process.execPath,'-e','require("node:fs").writeFileSync("env.json",JSON.stringify({target:"local"}))'],outputs:['env.json']}}};
 const commandRunner=async input=>{const child=spawnSync(input.command[0],input.command.slice(1),{cwd:input.cwd,encoding:'utf8'});return {exitCode:child.status,receipt:{id:randomUUID(),command:input.command,exitCode:child.status,stdout_digest:digest(child.stdout)}};};
 const input={stage:{slug:'environment-provisioning'},workspace,source_digest:snapshotWorkspace(workspace).source_digest,request_digest:'a'.repeat(64),authority:{reference:'authorized-local-test'}};
 const provider=createCommandOperationProvider({config,commandRunner,controllerRoot}),receipt=await provider.execute(input);assert.equal(await provider.verify(receipt,input),true);assert.equal(await provider.verify({...receipt,input_digest:'f'.repeat(64)},input),false);
 assert.equal(await createCommandOperationProvider({config,commandRunner,controllerRoot}).verify(receipt,input),true);
 fs.writeFileSync(path.join(workspace,'env.json'),'changed target');assert.equal(await provider.verify(receipt,input),false);
 assert.equal((await provider.execute(input)).reason,'operation_reentry_requires_new_registration');
 const failing=createCommandOperationProvider({config:{stages:{'environment-provisioning':{argv:[process.execPath,'-e','process.exit(3)'],outputs:['env.json']}}},commandRunner,controllerRoot});assert.equal((await failing.execute({...input,request_digest:'b'.repeat(64)})).status,'failed');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

import {createOperationCommandRunner} from '../scripts/operations.mjs';
test('default operation runner executes actual workspace and bounds child lifetime and output',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aidlc-host-operation-')),workspace=path.join(root,'source');fs.mkdirSync(workspace);
 try{const runner=createOperationCommandRunner({workspace,controllerRoot:root});const base={cwd:workspace,timeoutMs:1000,maxOutputBytes:1024,basis:[{operator:'test'}]};
 const pass=await runner({...base,command:[process.execPath,'-e','require("node:fs").writeFileSync("target.txt","actual environment")']});assert.equal(pass.exitCode,0);assert.equal(fs.readFileSync(path.join(workspace,'target.txt'),'utf8'),'actual environment');
 const timed=await runner({...base,timeoutMs:50,command:[process.execPath,'-e','setInterval(()=>{},1000)']});assert.equal(timed.exitCode,null);assert.equal(timed.receipt.timeout,true);
 const overflow=await runner({...base,command:[process.execPath,'-e','console.log("x".repeat(4096))']});assert.equal(overflow.exitCode,null);assert.equal(overflow.receipt.overflow,true);
 await assert.rejects(runner({...base,cwd:root,command:[process.execPath,'-e','process.exit(0)']}),/outside host admission/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

import {recordControllerDecision} from '../scripts/authority.mjs';
test('normal operator decision resumes a paused summary gate without changing registered request; tamper and source changes refuse',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aidlc-decision-')),workspace=path.join(root,'source'),controllerRoot=path.join(root,'controller');fs.mkdirSync(workspace);fs.mkdirSync(controllerRoot);
 try{
 const snapshot=readSnapshot(),keep=new Set(['workspace-scaffold','workspace-detection','state-init','market-research']);
 const request={run_id:'human-summary',workspace,prompt:'Synthetic ordinary summary checkpoint',parameters:{profile:'feature',project_type:'greenfield',ceremony:{sensors:'off',review_cap:'none',summary_confirmation:'on',learnings:'off',skeleton:'off',collaborators:'off'},stage_decisions:snapshot.profiles.feature.stages.filter(stage=>!keep.has(stage)).map(stage=>({stage,execute:false,reason:'Synthetic checkpoint boundary'})),repair_checks:false}};
 const policy={reference:'operator-policy',purposes:['stage-selection']},createAuthority=()=>createControllerAuthority({policy,requestDigest:requestBindingDigest(request),controllerRoot}),ids=new Map();let substantive=0;
 const executor={async admit(req){const id=randomUUID(),identity={actor:{runtime:'test-host',host:'localhost',session_id:id},instance_id:id};ids.set(req.request_digest,identity);return identity;},async snapshotBasis({artifacts=[]}){return {source_digest:snapshotWorkspace(workspace).source_digest,artifacts:artifacts.map(ref=>({path:ref.path,digest:digest(fs.readFileSync(path.join(workspace,ref.path)))}))};},async execute(req){if(!req.context.summary_only)substantive++;for(const target of req.context.artifact_targets){const file=path.join(workspace,target.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,target.id.endsWith('-questions')?'# Summary questions\n\n## Assumptions\nOperator must confirm scope.\n':'# Market\n\n## Findings\nActual fixture.\n');}return {status:'completed',identity:ids.get(req.request_digest),identity_basis:'executor-observed',receipt:{id:randomUUID(),digest:digest(req.request_digest),request_digest:req.request_digest},input_basis:req.basis,artifacts:req.context.artifact_targets.map(target=>({path:target.path,digest:digest(fs.readFileSync(path.join(workspace,target.path)))}))};}};
 const held=await runAidlc({request,executor,authority:createAuthority(),controllerRoot});assert.equal(held.status,'waiting');assert.equal(substantive,0);
 const pendingFile=held.failure.detail.pending.file,pending=JSON.parse(fs.readFileSync(pendingFile,'utf8')),original=fs.readFileSync(pendingFile,'utf8');
 fs.writeFileSync(pendingFile,JSON.stringify({...pending,payload:{...pending.payload,input:{...pending.payload.input,source_digest:'f'.repeat(64)}}}));assert.throws(()=>recordControllerDecision({controllerRoot,pendingFile,reference:'operator-approval'}),/signature or exact binding invalid/);fs.writeFileSync(pendingFile,original);
 const approval=recordControllerDecision({controllerRoot,pendingFile,reference:'operator explicitly confirmed retained questions'});assert.equal(approval.decision_kind,'host-observed-operator-interaction');
 const authority=createAuthority(),input=pending.payload.input;assert.equal((await authority.authorize(input)).authorized,true);assert.equal((await authority.authorize({...input,source_digest:'f'.repeat(64)})).authorized,false);assert.equal((await authority.authorize({...input,request_digest:'d'.repeat(64)})).authorized,false);
 const completed=await runAidlc({request,executor,authority,controllerRoot});assert.equal(completed.status,'completed',JSON.stringify(completed.failure));assert.equal(substantive,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('recorded advisory disposition survives durable replay bookkeeping but never changed receipt facts',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aidlc-replay-decision-'));
 try{const policy={reference:'default',purposes:[]},create=()=>createControllerAuthority({policy,requestDigest:'a'.repeat(64),controllerRoot:root}),input={purpose:'review-disposition',stage:'reviewed',request_digest:'a'.repeat(64),decision:{units:[{id:'u',receipts:[{receipt:{id:'observed',digest:'b'.repeat(64)},replayed:false,persisted:true}],findings:[],dissent:[]}]}};
 const pending=(await create().authorize(input)).pending;recordControllerDecision({controllerRoot:root,pendingFile:pending.file,reference:'operator accepted current observed review'});
 const replay=structuredClone(input);replay.decision.units[0].receipts[0].replayed=true;replay.decision.units[0].receipts[0].persisted=false;const authority=create(),grant=await authority.authorize(replay);assert.equal(grant.authorized,true);assert.equal(authority.verify(grant.receipt,replay),true);
 replay.decision.units[0].receipts[0].receipt.digest='c'.repeat(64);assert.equal((await authority.authorize(replay)).authorized,false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
