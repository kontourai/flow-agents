import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {startRun,evaluateRun,loadRun} from '@kontourai/flow';
import {runAidlc,attachObservation,refreshArtifactValidity,snapshotWorkspace} from '../scripts/runtime.mjs';
import {createControllerAuthority} from '../scripts/authority.mjs';
import {readSnapshot,digest} from '../scripts/compile.mjs';
import {observeStage} from '../scripts/artifacts.mjs';
const fixture=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'aidlc-runtime-test-'));const workspace=path.join(root,'source'),controllerRoot=path.join(root,'controller');fs.mkdirSync(workspace);fs.mkdirSync(controllerRoot);return {root,workspace,controllerRoot};};

test('host policy authenticates exact decision basis; labels/altered bytes never approve',async()=>{const f=fixture();try{const authority=createControllerAuthority({policy:{reference:'synthetic-operator-policy',purposes:['code-plan','review-disposition']},requestDigest:'a'.repeat(64),controllerRoot:f.controllerRoot});const input={purpose:'code-plan',stage:'code-generation',request_digest:'a'.repeat(64),basis:[{digest:'b'.repeat(64)}]};const result=await authority.authorize(input);assert.equal(result.authorized,true);assert.equal(authority.verify(result.receipt,input),true);assert.equal(authority.verify(result.receipt,{...input,basis:[]}),false);assert.equal((await authority.authorize({...input,purpose:'deployment'})).authorized,false);assert.equal((await authority.authorize({...input,purpose:'review-disposition',findings:[{severity:'critical',status:'open'}]})).authorized,false);}finally{fs.rmSync(f.root,{recursive:true,force:true});}});

test('actual canonical Flow invalidates artifact consumers after completion, with unchanged branch preserved',async()=>{
 const f=fixture();try{const snapshot={upstream:{commit:'fixture'},profiles:{fixture:{stages:['a','b','unrelated']}},stages:[{slug:'a',source_digest:'a'.repeat(64),produces:['requirement'],consumes:[]},{slug:'b',source_digest:'b'.repeat(64),produces:['plan'],consumes:[{artifact:'requirement',required:true}]},{slug:'unrelated',source_digest:'c'.repeat(64),produces:['note'],consumes:[]}]};
 const artifacts=snapshot.stages.map((s,i)=>({id:s.produces[0],stage:s.slug,path:`${s.slug}.md`}));for(const a of artifacts)fs.writeFileSync(path.join(f.workspace,a.path),'Observed fixture artifact\n');
 const def={id:'fixture',version:'1',steps:[{id:'a',next:'b',needs:[]},{id:'b',next:'unrelated',needs:['a']},{id:'unrelated',next:null,needs:[]}],gates:Object.fromEntries(snapshot.stages.map(s=>[`${s.slug}-gate`,{step:s.slug,on_route_back:{default:'a'},expects:[{id:'completion',kind:'trust.bundle',required:true,description:'observed artifact',bundle_claim:{claimType:`aidlc.${s.slug}-completion`,subjectType:'flow-step',subjectId:`runtime-fixture/${s.slug}`,accepted_statuses:['verified']}}]}]))};
 const file=path.join(f.controllerRoot,'definition.json');fs.writeFileSync(file,JSON.stringify(def));await startRun(file,{cwd:f.controllerRoot,runId:'runtime-fixture'});const records=[];
 for(const s of snapshot.stages){const observation=observeStage({snapshot,profile:'fixture',stage:s.slug,root:f.workspace,artifacts});const evidence=await attachObservation({controllerRoot:f.controllerRoot,runId:'runtime-fixture',stage:s.slug,status:'pass',record:observation});records.push({stage:s.slug,digest:digest(observation),artifact_observation:observation,evidence:{completion:evidence}});await evaluateRun('runtime-fixture',{cwd:f.controllerRoot});}
 assert.equal((await loadRun('runtime-fixture',f.controllerRoot)).state.status,'completed');fs.writeFileSync(path.join(f.workspace,'a.md'),'Requirement changed\n');const changed=await refreshArtifactValidity({controllerRoot:f.controllerRoot,runId:'runtime-fixture',workspace:f.workspace,records});assert.deepEqual(changed.invalidated,['a','b']);assert.equal(changed.projection.unrelated.status,'current');assert.equal((await loadRun('runtime-fixture',f.controllerRoot)).state.current_step,'a');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('native controller executes selected substantive stage through an actual subprocess and genuine Flow gates',async()=>{
 const f=fixture();try{const snap=readSnapshot(),keep=new Set(['workspace-scaffold','workspace-detection','state-init','market-research']);const request={run_id:'runtime-process-fixture',workspace:f.workspace,prompt:'Synthetic process fixture: document a market investigation.',parameters:{profile:'feature',project_type:'greenfield',repair_checks:false,stage_decisions:snap.profiles.feature.stages.filter(s=>!keep.has(s)).map(stage=>({stage,execute:false,reason:'Synthetic boundary test profile'}))}};
 const authority=createControllerAuthority({policy:{reference:'synthetic-test-only',purposes:['stage-selection']},requestDigest:digest(request),controllerRoot:f.controllerRoot});const identities=new Map();let calls=0;
 const executor={async admit(req){const id=randomUUID(),identity={actor:{runtime:'node-fixture',session_id:id,host:'isolated-test-host'},instance_id:id};identities.set(req.request_digest,identity);return identity;},async snapshotBasis({artifacts=[]}){return {source_digest:snapshotWorkspace(f.workspace).source_digest,artifacts:artifacts.map(a=>({path:a.path,digest:digest(fs.readFileSync(path.join(f.workspace,a.path)))}))};},async execute(req){calls++;const targets=req.context.artifact_targets;const child=spawnSync(process.execPath,['-e','const fs=require("node:fs"),path=require("node:path");for(const p of JSON.parse(process.argv[1])){fs.mkdirSync(path.dirname(p.path),{recursive:true});fs.writeFileSync(p.path,"# Observed investigation\\n\\n## Findings\\nActual subprocess output.\\n\\n## Sources\\nSynthetic test fixture.\\n")}',''+JSON.stringify(targets)],{cwd:f.workspace,encoding:'utf8'});assert.equal(child.status,0,child.stderr);return {status:'completed',identity:identities.get(req.request_digest),identity_basis:'executor-observed',receipt:{id:'subprocess-'+calls,digest:digest({status:child.status,stderr:child.stderr}),request_digest:req.request_digest},input_basis:req.basis,artifacts:targets.map(a=>({path:a.path,digest:digest(fs.readFileSync(path.join(f.workspace,a.path)))}))};}};
 const result=await runAidlc({request,executor,authority,controllerRoot:f.controllerRoot});assert.equal(result.status,'completed',JSON.stringify(result.failure));assert.ok(calls>0);assert.equal(result.canonical_state.status,'completed');assert.equal(result.records.length,4);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('restart reconstructs the exact approved unit DAG and rejects mutated bytes',async()=>{
 const {restoreUnits}=await import('../scripts/runtime.mjs');const f=fixture();try{
 const body='```yaml\nunits:\n  - name: api\n    kind: service\n    depends_on: []\n  - name: ui\n    kind: service\n    depends_on: [api]\n```\n';fs.writeFileSync(path.join(f.workspace,'units.md'),body);
 const records=[{stage:'units-generation',sensors:{status:'pass'},artifacts:[{id:'unit-of-work-dependency',path:'units.md',digest:digest(body)}]}];
 assert.deepEqual(restoreUnits(f.workspace,JSON.parse(JSON.stringify(records))).map(u=>({id:u.id,depends_on:u.depends_on})),[{id:'api',depends_on:[]},{id:'ui',depends_on:['api']}]);
 fs.appendFileSync(path.join(f.workspace,'units.md'),'changed');assert.throws(()=>restoreUnits(f.workspace,records),/bytes changed/);
 assert.equal(restoreUnits(f.workspace,[{...records[0],invalidated:true}]),null);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('stage-wide consumer observes every distinct unit rather than borrowing the final unit',()=>{
 const f=fixture();try{for(const unit of ['api','ui'])fs.writeFileSync(path.join(f.workspace,unit+'.md'),unit+' requirement');
 const snapshot={upstream:{commit:'fixture'},profiles:{fixture:{stages:['requirements','integration']}},stages:[{slug:'requirements',produces:['nfr'],consumes:[]},{slug:'integration',source_digest:'x',produces:[],consumes:[{artifact:'nfr',required:true}]}]};
 const artifacts=['api','ui'].map(unit=>({id:'nfr',stage:'requirements',unit,path:unit+'.md'}));
 const observed=observeStage({snapshot,profile:'fixture',stage:'integration',root:f.workspace,artifacts});assert.equal(observed.structural_status,'pass');assert.deepEqual(observed.inputs.map(i=>i.path),['api.md','ui.md']);
 assert.throws(()=>observeStage({snapshot,profile:'fixture',stage:'integration',root:f.workspace,artifacts:[...artifacts,artifacts[0]]}),/Ambiguous/);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('input confirmation requires operator-supplied exact bytes and host receipts survive restart',async()=>{
 const f=fixture();try{const basis=[{id:'intent-capture-questions',path:'questions.md',digest:'b'.repeat(64)}];const input={purpose:'input-confirmation',stage:'intent-capture',request_digest:'a'.repeat(64),basis};
 const policy={reference:'fixture',purposes:['input-confirmation'],input_confirmations:{'intent-capture':{source:'operator-supplied',reference:'fixture-owner-confirmation',basis}}};
 const authority=createControllerAuthority({policy,requestDigest:input.request_digest,controllerRoot:f.controllerRoot});const grant=await authority.authorize(input);assert.equal(grant.authorized,true);
 assert.equal((await authority.authorize({...input,basis:[{...basis[0],digest:'c'.repeat(64)}]})).authorized,false);
 const restarted=createControllerAuthority({policy,requestDigest:input.request_digest,controllerRoot:f.controllerRoot});assert.equal(restarted.verify(grant.receipt,input),true);
 const unbound=createControllerAuthority({policy:{reference:'fixture',purposes:['input-confirmation']},requestDigest:input.request_digest,controllerRoot:f.controllerRoot});assert.equal((await unbound.authorize(input)).authorized,false);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('failed substantive work persists a refusing canonical Flow gate',async()=>{
 const f=fixture();try{const snap=readSnapshot(),keep=new Set(['workspace-scaffold','workspace-detection','state-init','market-research']);const request={run_id:'runtime-failure-fixture',workspace:f.workspace,prompt:'Investigate fixture market.',parameters:{profile:'feature',project_type:'greenfield',repair_checks:false,stage_decisions:snap.profiles.feature.stages.filter(s=>!keep.has(s)).map(stage=>({stage,execute:false,reason:'Synthetic boundary fixture'}))}};
 const authority=createControllerAuthority({policy:{reference:'synthetic-test-only',purposes:['stage-selection']},requestDigest:digest(request),controllerRoot:f.controllerRoot});const identities=new Map();
 const executor={async admit(req){const id=randomUUID();const identity={actor:{runtime:'fixture',session_id:id,host:'test'},instance_id:id};identities.set(req.request_digest,identity);return identity;},async snapshotBasis(){return {source_digest:snapshotWorkspace(f.workspace).source_digest,artifacts:[]};},async execute(req){return {status:'failed',identity:identities.get(req.request_digest),identity_basis:'executor-observed',receipt:{id:'failed-fixture',digest:digest('failed'),request_digest:req.request_digest},input_basis:req.basis,artifacts:[]};}};
 const result=await runAidlc({request,executor,authority,controllerRoot:f.controllerRoot});assert.equal(result.status,'failed');const record=result.records.find(r=>r.stage==='market-research');assert.equal(record.sensors.status,'fail');assert.ok(record.evidence.completion.evidence_id);
 const canonical=await loadRun(request.run_id,f.controllerRoot);const outcome=canonical.state.gate_outcomes.find(g=>g.gate_id==='market-research-gate');assert.ok(outcome);assert.notEqual(outcome.status,'pass');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('partial planning output cannot approve or execute implementation',async()=>{
 const f=fixture();try{const snap=readSnapshot(),keep=new Set(['workspace-scaffold','workspace-detection','state-init','code-generation']);const request={run_id:'runtime-plan-fixture',workspace:f.workspace,prompt:'Plan fixture change.',parameters:{profile:'bugfix',repair_checks:false,stage_decisions:snap.profiles.bugfix.stages.filter(s=>!keep.has(s)).map(stage=>({stage,execute:false,reason:'Synthetic planning boundary fixture'}))}};
 const authority=createControllerAuthority({policy:{reference:'fixture',purposes:['stage-selection','code-plan']},requestDigest:digest(request),controllerRoot:f.controllerRoot});const identities=new Map();let implementationCalls=0;
 const executor={async admit(req){const id=randomUUID();const identity={actor:{runtime:'fixture',session_id:id,host:'test'},instance_id:id};identities.set(req.request_digest,identity);return identity;},async snapshotBasis({artifacts=[]}){return {source_digest:snapshotWorkspace(f.workspace).source_digest,artifacts:artifacts.map(a=>({path:a.path,digest:digest(fs.readFileSync(path.join(f.workspace,a.path)))}))};},async execute(req){if(!req.context.planning_only)implementationCalls++;const target=req.context.artifact_targets[0];fs.mkdirSync(path.dirname(path.join(f.workspace,target.path)),{recursive:true});fs.writeFileSync(path.join(f.workspace,target.path),'# Plan\n\n## Change\nFixture.\n\n## Basis\nTask.\n');return {status:'completed',identity:identities.get(req.request_digest),identity_basis:'executor-observed',receipt:{id:'partial-plan-fixture',digest:digest('partial-plan'),request_digest:req.request_digest},input_basis:req.basis,artifacts:[{path:target.path,digest:digest(fs.readFileSync(path.join(f.workspace,target.path)))}]};}};
 const result=await runAidlc({request,executor,authority,controllerRoot:f.controllerRoot});assert.equal(result.failure.reason,'approval_basis_incomplete');assert.equal(implementationCalls,0);assert.equal(result.status,'failed');
 const receipts=fs.readdirSync(path.join(f.controllerRoot,'authority')).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(f.controllerRoot,'authority',name),'utf8')));assert.equal(receipts.some(r=>r.payload.purpose==='code-plan'),false);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('source-changing completion becomes stale on added implementation bytes without artifact edits',async()=>{
 const {inspectBasis}=await import('../scripts/artifacts.mjs');const f=fixture();try{fs.writeFileSync(path.join(f.workspace,'app.mjs'),'export const answer=1;');const receipt={stage:'code-generation',inputs:[],outputs:[],source_digest:snapshotWorkspace(f.workspace).source_digest};assert.equal(inspectBasis(receipt,f.workspace).status,'current');fs.writeFileSync(path.join(f.workspace,'added.mjs'),'export const extra=2;');assert.deepEqual(inspectBasis(receipt,f.workspace),{status:'stale',changes:['code-generation/source']});}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
