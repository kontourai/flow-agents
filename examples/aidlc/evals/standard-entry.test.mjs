import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeKit,executeRequestFile} from '../scripts/run.mjs';
import {KIT_ROOT} from '../scripts/compile.mjs';

test('standard kit entry rejects experiment requests and executes without benchmark identities or helper paths',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aidlc-standard-entry-'));
 try{
  const workspace=path.join(root,'workspace'),controllerRoot=path.join(root,'controller');fs.mkdirSync(workspace);fs.mkdirSync(controllerRoot);
  const request={schema:'kontour.kit.execution_request',version:'1.0',kit_id:'aidlc',run_id:'standard-entry',workspace,source_root:KIT_ROOT,prompt:'Inspect this empty project using the declared lifecycle.',parameters:{profile:'bugfix',project_type:'brownfield',repair_checks:false,authority_policy:{reference:'synthetic-standard-entry-policy',purposes:['code-plan','review-disposition']}},execution:{model:'fixture',provider:'fixture',harness:'codex',harness_version:'fixture',runtime:'isolated-worker',reasoning_effort:'medium',max_turns:2,timeout_s:30,max_provider_requests:4},engine_sandbox:{image:'sha256:'+'a'.repeat(64)}};
  await assert.rejects(executeKit({request:{...request,schema:'kontour.evals.named_treatment_request'},controllerRoot,workerRunner:()=>{throw new Error('must not execute');}}),/Unsupported kit execution request/);
  const exposed=path.join(workspace,'controller');await assert.rejects(executeKit({request,controllerRoot:exposed,workerRunner:()=>{throw new Error('must not execute');}}),/Controller state must be separate/);assert.equal(fs.existsSync(exposed),false);
  const alias=path.join(root,'workspace-alias');fs.symlinkSync(workspace,alias);await assert.rejects(executeKit({request,controllerRoot:path.join(alias,'controller'),workerRunner:()=>{throw new Error('must not execute');}}),/Controller state must be separate/);assert.equal(fs.existsSync(exposed),false);
  fs.writeFileSync(path.join(workspace,'auth.json'),'{}');const badFile=path.join(root,'bad-request.json');fs.writeFileSync(badFile,JSON.stringify(request));await assert.rejects(executeRequestFile({requestFile:badFile,controllerRoot:path.join(root,'bad-controller'),authFile:path.join(workspace,'auth.json'),workerRunner:()=>{throw new Error('must not execute');}}),/Host credentials must stay outside/);assert.equal(fs.existsSync(path.join(root,'bad-controller')),false);
  fs.writeFileSync(path.join(root,'host-auth.json'),'{}');const file=path.join(root,'request.json');fs.writeFileSync(file,JSON.stringify(request));let started=0,closed=0;
  const result=await executeRequestFile({requestFile:file,controllerRoot,authFile:path.join(root,'host-auth.json'),brokerFactory:async()=>({baseUrl:'http://fixture.invalid',capability:'fixture',model:'fixture',evidence:[],close:async()=>{closed++;}}),workerRunner:async()=>{started++;throw new Error('synthetic provider refusal');}});
  assert.equal(result.schema,'kontour.kit.execution_result');assert.equal(result.kit_id,'aidlc');assert.equal(result.status,'failed');assert.equal(result.turns_started,1);assert.equal(result.identity.observed,false);assert.equal(started,1);assert.equal(closed,1);
  assert.ok(!Object.hasOwn(result,'arm_id'));assert.ok(!Object.hasOwn(result,'case_id'));assert.equal(fs.readFileSync(file,'utf8').includes('worker_helper'),false);
  assert.equal(fs.existsSync(path.join(controllerRoot,'runtime-result.json')),true);assert.equal(fs.readdirSync(controllerRoot).some(file=>file.startsWith('provider-observations-')),true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
