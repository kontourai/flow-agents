import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createDockerExecutor} from '../scripts/executor.mjs';import {digest} from '../scripts/compile.mjs';
// Actual fork custody through a local trusted worker port; no provider proof.
test('pipeline successor receives prior chain bytes; mob observations retain actual objections',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aidlc-topology-port-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const workspace=path.join(root,'source'),controllerRoot=path.join(root,'controller');fs.mkdirSync(workspace);fs.mkdirSync(controllerRoot);fs.writeFileSync(path.join(workspace,'source.mjs'),'export const value=1;');
 const prior='.aidlc/artifacts/design/prior.md';fs.mkdirSync(path.dirname(path.join(workspace,prior)),{recursive:true});fs.writeFileSync(path.join(workspace,prior),'actual predecessor');
 const request={workspace,source_root:workspace,run_id:'topology-port',execution:{max_turns:4,timeout_s:60,model:'fixture'},engine_sandbox:{image:'sha256:'+'a'.repeat(64),artifact_root:path.join(root,'artifacts')}};
 const workerRunner=async input=>{const context=JSON.parse(fs.readFileSync(input.contextFile,'utf8'));const dispatch=context.dispatch;let output;
 if(dispatch.phase==='pipeline-link'){assert.equal(fs.readFileSync(path.join(input.workspace,prior),'utf8'),'actual predecessor');output=dispatch.context.artifact_targets[0].path;}
 else {assert.equal(fs.existsSync(path.join(input.workspace,prior)),false,'blind contributor does not receive unrelated predecessor');output=`.aidlc/contributions/design/stage/${dispatch.role}.md`;}
 fs.mkdirSync(path.dirname(path.join(input.workspace,output)),{recursive:true});fs.writeFileSync(path.join(input.workspace,output),'observed output');
 return {observed:{container_id:'local-port',context_digest:digest(fs.readFileSync(input.contextFile)),stdin_digest:'fixture',source_fork_digest:'fixture'},provider_thread_id:'fixture',terminal:{status:0,timeout:false,overflow:false},container_removed:true,usage:{complete:false},final:JSON.stringify({status:'completed',artifacts:[{path:output}],objections:[{kind:'judgment',reason:'actual unresolved tradeoff'}]})};};
 const executor=createDockerExecutor({request,controllerRoot,workerRunner});
 for(const phase of ['pipeline-link','contribute']){const dispatch={request_digest:digest(phase),stage:'design',role:'fixture-role',phase,unit:'stage',context:{stage:{workspace_requires:false},artifact_targets:[{path:'.aidlc/artifacts/design/new.md'}]},basis:await executor.snapshotBasis({}),...(phase==='pipeline-link'?{upstream:[{artifacts:[{path:prior}]}]}:{})};dispatch.expected_identity=await executor.admit(dispatch);const result=await executor.execute(dispatch);assert.equal(result.status,'completed');if(phase==='contribute')assert.deepEqual(result.objections,[{kind:'judgment',reason:'actual unresolved tradeoff'}]);}
});
