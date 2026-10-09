import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dispatchStage } from '../scripts/dispatch.mjs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startRun, claimReadyStep, renewStepClaim, releaseStepClaim, evaluateClaimedStep, attachEvidence, evaluateRun, loadRun } from '@kontourai/flow';
import { createUnitFlow, unitObservationBundle } from '../scripts/unit-flow.mjs';
const sha='a'.repeat(64),stage={slug:'code-generation',source_digest:sha,mode:'subagent',lead_agent:'lead',support_agents:[]};
const basis={source_digest:sha,artifacts:[{path:'unit/output.md',digest:sha}]};
const record=id=>({id,status:'completed',basis,artifacts:basis.artifacts,receipts:[{status:'completed',identity_basis:'executor-observed',receipt:{id:'host-command',digest:sha}}]});
async function fixture(t,units=[{id:'a',mutable_resources:['a']}],options={}){
  const controllerRoot=fs.mkdtempSync(path.join(tmpdir(),'aidlc-unit-flow-'));
  const definition=path.join(controllerRoot,'parent.json');fs.writeFileSync(definition,JSON.stringify({id:'parent',version:'1',steps:[{id:stage.slug,next:null}],gates:{'parent-gate':{step:stage.slug,expects:[]}}}));
  await startRun(definition,{cwd:controllerRoot,runId:'parent-run',params:{subject:'parent-run'}});
  const adapter=await createUnitFlow({controllerRoot,parentRunId:'parent-run',stage,units,snapshotBasis:async()=>basis,...options});
  t.after(async()=>{await adapter.close();fs.rmSync(controllerRoot,{recursive:true,force:true});});
  return {adapter,controllerRoot};
}

test('fresh canonical claim, actual renewal, Surface evidence and canonical join',async t=>{
  const {adapter}=await fixture(t,undefined,{leaseSeconds:2,renewalIntervalMs:30});
  const lease=await adapter.claim({unit:'a'});await adapter.renew(lease);
  const active=await adapter.load();assert.ok(active.state.multi_cursor.claim_history.some(event=>event.action==='renewed'));
  assert.equal((await adapter.release(lease,record('a'))).settled,true);
  const joined=await adapter.join();assert.equal(joined.complete,true);assert.equal(joined.units[0].evidence.status,'verified');
  assert.equal((await adapter.load()).state.multi_cursor.active_claims.length,0);
});

test('Flow owns dependency readiness and sibling mutable resource contention',async t=>{
  const {adapter}=await fixture(t,[{id:'a',mutable_resources:['shared']},{id:'b',mutable_resources:['shared']},{id:'c',depends_on:['a','b'],mutable_resources:['c']}]);
  const a=await adapter.claim({unit:'a'});
  await assert.rejects(adapter.claim({unit:'b'}),error=>error.code==='flow.multi_cursor.claim.resource_conflict');
  await assert.rejects(adapter.claim({unit:'c'}));
  await adapter.release(a,record('a'));const b=await adapter.claim({unit:'b'});await adapter.release(b,record('b'));
  const c=await adapter.claim({unit:'c'});await adapter.release(c,record('c'));assert.equal((await adapter.join()).complete,true);
});

test('failed execution attaches disputed evidence, releases lease, leaves canonical unit incomplete',async t=>{
  const {adapter}=await fixture(t);const lease=await adapter.claim({unit:'a'});
  await adapter.release(lease,{id:'a',status:'blocked',reason:'execution_failed',receipts:[]});
  const run=await adapter.load();assert.equal(run.state.multi_cursor.active_claims.length,0);assert.notEqual(run.state.status,'completed');
  assert.equal(run.manifest.evidence[0].bundle_report.claims[0].status,'disputed');assert.equal((await adapter.join()).complete,false);
});

test('substituted and expired public claims cannot settle or renew',async t=>{
  const {adapter,controllerRoot}=await fixture(t);const lease=await adapter.claim({unit:'a'});
  await assert.rejects(adapter.settle({...lease,actor:{key:'substituted'}},record('a')),/substituted/);
  await assert.rejects(renewStepClaim(adapter.runId,{cwd:controllerRoot,claim_id:lease.claim_id,liveness_id:lease.liveness_id,actor:{key:'substituted'}}));
  await assert.rejects(evaluateClaimedStep(adapter.runId,{cwd:controllerRoot,claim_id:lease.claim_id,liveness_id:lease.liveness_id,actor:lease.actor,now:new Date(Date.parse(lease.expires_at)+1).toISOString()}));
  await adapter.release(lease,{id:'a',status:'blocked',reason:'cancelled'});
});

test('incorrect child subject and stale Surface observation never satisfy unit gate',async t=>{
  for(const kind of ['subject','stale']){
    const {adapter,controllerRoot}=await fixture(t);const lease=await adapter.claim({unit:'a'});
    const bundle=unitObservationBundle({runId:adapter.runId,parentRunId:'parent-run',stage:stage.slug,unitId:'a',record:record('a'),passing:true,invalid:kind==='stale'});
    if(kind==='subject')bundle.claims[0].subjectId='wrong-run/a';
    const file=path.join(controllerRoot,`${kind}.json`);fs.writeFileSync(file,JSON.stringify(bundle));
    await attachEvidence(adapter.runId,{cwd:controllerRoot,gate:'a-gate',file,kind:'trust.bundle'});
    const evaluated=await evaluateClaimedStep(adapter.runId,{cwd:controllerRoot,claim_id:lease.claim_id,liveness_id:lease.liveness_id,actor:lease.actor,now:new Date(Date.now()+10).toISOString()});assert.ok(evaluated.outcomes.every(outcome=>outcome.status!=='pass'),kind);
    await adapter.close();
  }
});

test('current source basis is required both at settlement and canonical join',async t=>{
  let observed=basis;const {adapter}=await fixture(t,undefined,{snapshotBasis:async()=>observed});
  const lease=await adapter.claim({unit:'a'});await adapter.release(lease,record('a'));assert.equal((await adapter.join()).complete,true);
  observed={...basis,source_digest:'b'.repeat(64)};assert.equal((await adapter.join()).complete,false);
});

test('completed single-cursor Flow routes back after superseding prior gate with stale observation',async t=>{
  const {adapter,controllerRoot}=await fixture(t);
  const bundle=unitObservationBundle({runId:'parent-run',parentRunId:'parent-run',stage:stage.slug,unitId:stage.slug,record:record('a'),passing:true});
  const definitionFile=path.join(controllerRoot,'probe.json');fs.writeFileSync(definitionFile,JSON.stringify({id:'probe',version:'1',steps:[{id:'a',next:null}],gates:{'a-gate':{step:'a',expects:[{id:'completion',kind:'trust.bundle',required:true,description:'probe',bundle_claim:{claimType:'aidlc.unit-completion',subjectId:'probe-run/a',accepted_statuses:['verified']}}],on_route_back:{default:'a'},route_back_policy:{max_attempts:2,on_exceeded:'block'}}}}));
  await startRun(definitionFile,{cwd:controllerRoot,runId:'probe-run',params:{subject:'probe-run'}});
  const first=unitObservationBundle({runId:'probe-run',parentRunId:'parent-run',stage:'a',unitId:'a',record:record('a'),passing:true});const firstFile=path.join(controllerRoot,'first.json');fs.writeFileSync(firstFile,JSON.stringify(first));
  const old=await attachEvidence('probe-run',{cwd:controllerRoot,gate:'a-gate',file:firstFile,kind:'trust.bundle'});
  await evaluateRun('probe-run',{cwd:controllerRoot});assert.equal((await loadRun('probe-run',controllerRoot)).state.status,'completed');
  const stale=unitObservationBundle({runId:'probe-run',parentRunId:'parent-run',stage:'a',unitId:'a',record:record('a'),passing:false,invalid:true});const staleFile=path.join(controllerRoot,'stale-parent.json');fs.writeFileSync(staleFile,JSON.stringify(stale));
  await attachEvidence('probe-run',{cwd:controllerRoot,gate:'a-gate',file:staleFile,kind:'trust.bundle',supersede:old.id});
  const evaluated=await evaluateRun('probe-run',{cwd:controllerRoot,gate:'a-gate',now:new Date(Date.now()+10).toISOString()});
  assert.notEqual(evaluated.state.status,'completed');assert.equal(evaluated.state.current_step,'a');
  void adapter;void bundle;
});


test('actual subprocess dispatch binds canonical claims, drains renewals and resumes completed units by receipt replay',async t=>{
  const {adapter,controllerRoot}=await fixture(t,undefined,{leaseSeconds:2,renewalIntervalMs:30});
  const workspace=path.join(controllerRoot,'work');fs.mkdirSync(workspace);const receipts=new Map(),bases=new Map();let executions=0;
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const executor={
    snapshotBasis:async({artifacts})=>({source_digest:sha,artifacts:artifacts.map(artifact=>({path:artifact.path,digest:hash(fs.readFileSync(path.join(workspace,artifact.path)))}))}),
    loadBasis:async key=>bases.get(key),saveBasis:async(key,value)=>bases.set(key,value),
    loadReceipt:async request=>receipts.get(request.request_digest),saveReceipt:async(request,result)=>receipts.set(request.request_digest,result),
    async execute(request){
      executions++;const child=spawn(process.execPath,['-e','setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"actual subprocess output"),250)',path.join(workspace,'unit.md')]);
      const abort=()=>child.kill('SIGTERM');request.signal.addEventListener('abort',abort,{once:true});
      const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});request.signal.removeEventListener('abort',abort);
      return {status:exit.code===0?'completed':'failed',identity:{actor:{runtime:'node',session_id:`pid-${child.pid}`,host:hostname()},instance_id:String(child.pid)},identity_basis:'executor-observed',input_basis:request.basis,artifacts:[{path:'unit.md',digest:hash(fs.readFileSync(path.join(workspace,'unit.md')))}],receipt:{id:`pid-${child.pid}`,digest:hash(JSON.stringify(exit)),request_digest:request.request_digest}};
    }
  };
  const bound=adapter.bindExecutor(executor),first=await dispatchStage({stage,units:[{id:'a',mutable_resources:['a']}],executor:bound,policy:{requiresClaim:true}});
  assert.equal(first.status,'completed');assert.equal((await adapter.join()).complete,true);assert.ok((await adapter.load()).state.multi_cursor.claim_history.some(event=>event.action==='renewed'));
  const replay=await dispatchStage({stage,units:[{id:'a',mutable_resources:['a']}],executor:bound,policy:{requiresClaim:true}});
  assert.equal(replay.status,'completed');assert.equal(replay.units[0].receipts[0].replayed,true);assert.equal(executions,1);assert.equal((await adapter.load()).state.multi_cursor.active_claims.length,0);
});

test('public claim revocation aborts bound execution when heartbeat renewal fails',async t=>{
  const {adapter,controllerRoot}=await fixture(t,undefined,{leaseSeconds:2,renewalIntervalMs:20});
  const lease=await adapter.claim({unit:'a'}),bound=adapter.bindExecutor({snapshotBasis:async()=>basis,execute:async request=>{await delay(1000,undefined,{signal:request.signal});return {};}});
  const pending=bound.execute({unit:'a',signal:new AbortController().signal});
  await releaseStepClaim(adapter.runId,{cwd:controllerRoot,claim_id:lease.claim_id,liveness_id:lease.liveness_id,actor:lease.actor,reason:'host-revoked'});
  await assert.rejects(pending,/abort/i);assert.equal(adapter.signalFor('a').aborted,true);await adapter.close();
});

test('disjoint public claims settle concurrently without invalidating sibling claim bases',async t=>{
  const {adapter}=await fixture(t,[{id:'a',mutable_resources:['a']},{id:'b',mutable_resources:['b']}]);
  const [a,b]=await Promise.all([adapter.claim({unit:'a'}),adapter.claim({unit:'b'})]);
  const results=await Promise.all([adapter.release(a,record('a')),adapter.release(b,record('b'))]);
  assert.ok(results.every(result=>result.passed));assert.equal((await adapter.join()).complete,true);
});

test('trusted advisory decision precedes actual canonical unit settlement; denied units stay incomplete',async t=>{
  for(const accepted of [true,false]){
    const advisory={...stage,reviewer:'reviewer',review_class:'advisory'};
    const {adapter,controllerRoot}=await fixture(t,undefined,{stage:advisory});
    const workspace=path.join(controllerRoot,'advisory-work');fs.mkdirSync(workspace);
    const hash=value=>createHash('sha256').update(value).digest('hex');let calls=0;
    const executor={
      snapshotBasis:async({artifacts})=>({source_digest:sha,artifacts:artifacts.map(artifact=>({path:artifact.path,digest:hash(fs.readFileSync(path.join(workspace,artifact.path)))}))}),
      decide:async input=>{calls++;assert.equal(input.kind,'advisory_review');assert.equal(input.review_receipts.length,1);return accepted?{authorized:true,decision:'accept',reference:'test-host-current-basis-advisory-policy'}:{authorized:false,decision:'decline'};},
      async execute(request){
        const script=request.phase==='review'?'process.stdout.write(JSON.stringify({verdict:"not_ready",findings:[{id:"tradeoff",severity:"low",status:"open",reason:"human judgment"}]}))':'require("node:fs").writeFileSync(process.argv[1],"actual authored artifact")';
        const child=spawn(process.execPath,['-e',script,path.join(workspace,'output.md')]);const output=[];child.stdout.on('data',bytes=>output.push(bytes));
        const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
        const result={status:exit===0?'completed':'failed',identity:{actor:{runtime:'node',session_id:`pid-${child.pid}`,host:hostname()},instance_id:String(child.pid)},identity_basis:'executor-observed',input_basis:request.basis,artifacts:[{path:'output.md',digest:hash(fs.readFileSync(path.join(workspace,'output.md')))}],receipt:{id:`pid-${child.pid}`,digest:hash(JSON.stringify({exit,output:Buffer.concat(output).toString()})),request_digest:request.request_digest}};
        if(request.phase==='review')Object.assign(result,JSON.parse(Buffer.concat(output).toString()),{basis:request.basis});return result;
      }
    };
    const outcome=await dispatchStage({stage:advisory,units:[{id:'a',mutable_resources:['a']}],executor:adapter.bindExecutor(executor),policy:{requiresClaim:true}});
    assert.equal(outcome.status,accepted?'completed':'awaiting_decision');assert.equal((await adapter.join()).complete,accepted);assert.equal(calls,1);
    assert.equal(outcome.units[0].reviews.length,1);assert.equal((await adapter.load()).state.multi_cursor.active_claims.length,0);
  }
});

test('claim revoked between periodic heartbeats refuses publication and completion even if worker ignores cancellation',async t=>{
 const {adapter,controllerRoot}=await fixture(t,undefined,{leaseSeconds:3,renewalIntervalMs:2000});
 const lease=await adapter.claim({unit:'a'});let started,finish,published=false;
 const startedSignal=new Promise(resolve=>{started=resolve;}),finishSignal=new Promise(resolve=>{finish=resolve;});
 const bound=adapter.bindExecutor({snapshotBasis:async()=>basis,execute:async request=>{started();await finishSignal;await request.beforePublication();published=true;return {};}});
 const pending=bound.execute({unit:'a',signal:new AbortController().signal});await startedSignal;
 await releaseStepClaim(adapter.runId,{cwd:controllerRoot,claim_id:lease.claim_id,liveness_id:lease.liveness_id,actor:lease.actor,reason:'host-revoked'});finish();
 await assert.rejects(pending,/aborted.*claim authority revoked/);assert.equal(published,false);assert.equal(adapter.signalFor('a').aborted,true);await adapter.close();
});

test('lease renewals continue through slow source observation until canonical settlement',async t=>{
 const {adapter}=await fixture(t,undefined,{leaseSeconds:3,renewalIntervalMs:100,snapshotBasis:async()=>{await delay(3500);return basis;}});
 const lease=await adapter.claim({unit:'a'}),settled=await adapter.release(lease,record('a'));
 assert.equal(settled.passed,true);assert.equal((await adapter.load()).state.multi_cursor.active_claims.length,0);
 assert.ok((await adapter.load()).state.multi_cursor.claim_history.filter(event=>event.action==='renewed').length>1);
});
