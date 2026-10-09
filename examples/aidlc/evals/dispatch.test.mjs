import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { dispatchStage, validateUnits } from '../scripts/dispatch.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stage = extra => ({slug:'test-stage',mode:'subagent',lead_agent:'lead',support_agents:[],source_digest:digest('method'),...extra});

// The port owns process creation, observes pid/host identity and exit status,
// and stores byte-bound command receipts. Identity never comes from stdout.
function processPort(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aidlc-dispatch-test-'));
  t.after(() => rmSync(directory, { recursive:true, force:true }));
  const session = randomUUID(), source = new Map(), events = [], receipts = new Map();
  let active = 0, peak = 0;
  const port = {
    events, receipts, source, directory,
    get peak() { return peak; },
    snapshotBasis: async ({unit,artifacts}) => ({source_digest:digest(source.get(unit.id) ?? 'source'),artifacts:artifacts.map(artifact => ({path:artifact.path,digest:artifact.digest})).sort((a,b)=>a.path.localeCompare(b.path))}),
    async execute(request) {
      events.push({kind:'start',unit:request.unit,phase:request.phase,role:request.role,request:structuredClone({...request,signal:undefined})});
      active++; peak = Math.max(peak, active);
      const worker = spawn(process.execPath,['-e','setTimeout(()=>{process.stdout.write(JSON.stringify({ok:true}));process.exitCode=Number(process.argv[2]);},Number(process.argv[1]))',String(typeof options.delay==='function'?options.delay(request):(options.delay ?? 20)),String(options.exitCode?.(request) ?? 0)],{stdio:['ignore','pipe','pipe']});
      const output = []; worker.stdout.on('data',bytes=>output.push(bytes));
      const abort = () => worker.kill('SIGTERM');
      request.signal.addEventListener('abort',abort,{once:true});
      if (request.signal.aborted) abort();
      const observation = await new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',(code,signal)=>resolve({code,signal}));});
      request.signal.removeEventListener('abort',abort); active--;
      events.push({kind:'end',unit:request.unit,phase:request.phase,role:request.role});
      const identity = {actor:{runtime:'node',session_id:`${session}:${request.role === 'reviewer' ? 'reviewer' : request.role}`,host:hostname()},instance_id:String(worker.pid)};
      const commandReceipt = {command:[process.execPath,'-e','process-worker'],pid:worker.pid,exit_code:observation.code,signal:observation.signal,output:Buffer.concat(output).toString()};
      const receiptPath = join(directory,`${worker.pid}.json`); writeFileSync(receiptPath,JSON.stringify(commandReceipt));
      const result = {status:observation.code===0?'completed':request.signal.aborted?'cancelled':'failed',identity,identity_basis:'executor-observed',receipt:{id:receiptPath,digest:digest(commandReceipt),request_digest:request.request_digest},input_basis:request.basis,artifacts:request.phase==='contribute'?[{path:`${request.unit}/contributions/${request.role}.md`,digest:digest(request.role)}]:[{path:`${request.unit}/output.md`,digest:digest('output')}]};
      if(request.phase==='review') Object.assign(result,{basis:request.basis,verdict:'ready',findings:[]});
      await options.adjust?.(request,result,port);
      return result;
    },
    async loadReceipt(request) {
      const entry = receipts.get(request.request_digest); if (!entry) return null;
      assert.equal(digest(JSON.parse(readFileSync(entry.receipt.id,'utf8'))),entry.receipt.digest);
      return structuredClone(entry);
    },
    async saveReceipt(request,result) { receipts.set(request.request_digest,structuredClone(result)); },
  };
  return port;
}
const run = (port,extra={}) => dispatchStage({stage:stage(),executor:port,...extra});

test('validates unknown units, cycles and selected membership before execution',async t=>{
  assert.throws(()=>validateUnits([{id:'a',depends_on:['missing']}]),/Unknown dependency/);
  assert.throws(()=>validateUnits([{id:'a',depends_on:['b']},{id:'b',depends_on:['a']}]),/cycle/);
  const port=processPort(t); const outcome=await run(port,{units:[{id:'a'}],context:{unit:'missing'}});
  assert.equal(outcome.reason,'unknown_unit'); assert.equal(port.events.length,0);
});

test('dependency-ready disjoint units overlap; dependent waits for both receipts',async t=>{
  const port=processPort(t,{delay:35});
  const outcome=await run(port,{units:[{id:'a',mutable_resources:['a']},{id:'b',mutable_resources:['b']},{id:'c',depends_on:['a','b'],mutable_resources:['c']}],policy:{maxParallel:2}});
  assert.equal(outcome.status,'completed'); assert.equal(port.peak,2);
  const starts=port.events.filter(e=>e.kind==='start'); assert.deepEqual(starts.map(e=>e.unit),['a','b','c']);
  assert.ok(port.events.findIndex(e=>e.kind==='start'&&e.unit==='c')>port.events.findIndex(e=>e.kind==='end'&&e.unit==='b'));
  assert.equal(starts[2].request.context.dependencies.length,2);
});

test('overlapping and unspecified mutable resources exclude execution',async t=>{
  for(const units of [[{id:'a',mutable_resources:['shared']},{id:'b',mutable_resources:['shared']}],[{id:'a'},{id:'b',mutable_resources:['b']}]]){
    const port=processPort(t); assert.equal((await run(port,{units})).status,'completed');assert.equal(port.peak,1);
  }
});

test('subagent spokes are mutually blind, independently observed, then integrated',async t=>{
  const port=processPort(t);
  const result=await run(port,{stage:stage({support_agents:['architecture','quality']}),policy:{maxParallel:2}});
  assert.equal(result.status,'completed'); assert.equal(port.peak,2);
  const requests=port.events.filter(e=>e.kind==='start').map(e=>e.request);
  assert.deepEqual(requests.map(r=>r.phase),['draft','contribute','contribute','integrate']);
  assert.deepEqual(requests[1].draft,requests[2].draft); assert.equal(requests[1].contributions,undefined);
  assert.equal(requests[3].contributions.length,2); assert.match(requests[1].output_scope,/contributions/);
});

test('pipeline preserves ordered receipt chain and inline executes all voices once',async t=>{
  const pipeline=processPort(t);const result=await run(pipeline,{stage:stage({mode:'pipeline',support_agents:['architect','quality']})});
  assert.equal(result.status,'completed');const reqs=pipeline.events.filter(e=>e.kind==='start').map(e=>e.request);
  assert.deepEqual(reqs.map(r=>r.role),['lead','architect','quality']);assert.equal(reqs[2].upstream.length,2);assert.equal(pipeline.peak,1);
  const inline=processPort(t);assert.equal((await run(inline,{stage:stage({mode:'inline',support_agents:['quality']})})).status,'completed');
  assert.deepEqual(inline.events[0].request.voices,['quality']);assert.equal(inline.events.filter(e=>e.kind==='start').length,1);
});

test('independent adversarial reviewer verifies prior finding disposition after lead-only repair',async t=>{
  const port=processPort(t,{adjust(request,result){if(request.phase==='review'){result.findings=[{id:'F1',severity:'high',status:request.iteration===1?'open':'fixed',reason:'observed check'}];result.verdict=request.iteration===1?'not_ready':'ready';}}});
  const result=await run(port,{stage:stage({support_agents:['quality'],reviewer:'reviewer',review_class:'adversarial',reviewer_max_iterations:2})});
  assert.equal(result.status,'completed');assert.deepEqual(port.events.filter(e=>e.kind==='start').map(e=>e.phase),['draft','contribute','integrate','review','revise','review']);
  assert.equal(result.units[0].findings[0].status,'fixed');assert.equal(result.units[0].reviews.length,2);
});

test('advisory review records open concerns and awaits host decision after one pass',async t=>{
  const port=processPort(t,{adjust(request,result){if(request.phase==='review')Object.assign(result,{verdict:'not_ready',findings:[{id:'F1',severity:'medium',status:'open',reason:'tradeoff'}]});}});
  const result=await run(port,{stage:stage({reviewer:'reviewer',review_class:'advisory'})});
  assert.equal(result.status,'awaiting_decision');assert.equal(result.units[0].reviews.length,1);assert.equal(result.reason,'advisory_review');
});

test('review actor substitution, author reuse and current-source drift fail closed',async t=>{
  const shared=processPort(t,{adjust(request,result){if(request.phase==='review')result.identity.actor.session_id=result.identity.actor.session_id.replace(':reviewer',':lead');}});
  assert.equal((await run(shared,{stage:stage({reviewer:'reviewer'})})).reason,'reviewer_not_independent');
  const substitution=processPort(t); substitution.admit=async()=>({actor:{runtime:'node',session_id:'authorized',host:hostname()},instance_id:'authorized-instance'});
  assert.equal((await run(substitution)).reason,'actor_substitution');
  const stale=processPort(t,{adjust(request,result,port){if(request.phase==='review')port.source.set(request.unit,'changed during review');}});
  assert.equal((await run(stale,{stage:stage({reviewer:'reviewer'})})).reason,'stale_review');
});

test('review budget, missing dispositions and missing observed identities cannot pass',async t=>{
  const blocked=processPort(t,{adjust(request,result){if(request.phase==='review')Object.assign(result,{verdict:'not_ready',findings:[{id:'F1',severity:'high',status:'open',reason:'still broken'}]});}});
  assert.equal((await run(blocked,{stage:stage({reviewer:'reviewer',reviewer_max_iterations:1})})).reason,'review_budget');
  const dropped=processPort(t,{adjust(request,result){if(request.phase==='review'&&request.iteration===1)Object.assign(result,{verdict:'not_ready',findings:[{id:'F1',severity:'high',status:'open',reason:'broken'}]});}});
  assert.equal((await run(dropped,{stage:stage({reviewer:'reviewer'})})).reason,'missing_disposition');
  const configured=processPort(t,{adjust(request,result){result.identity_basis='configured-model';}});
  assert.equal((await run(configured)).reason,'unobserved_identity');
});

test('mob exposes peer positions only in bounded knowledge dialogue; judgment needs host',async t=>{
  const port=processPort(t,{adjust(request,result){if(request.phase==='contribute'&&request.role==='quality')result.objections=[{kind:'knowledge',reason:'missing invariant'}];}});
  assert.equal((await run(port,{stage:stage({mode:'mob',support_agents:['architecture','quality']})})).status,'completed');
  const dialogue=port.events.find(e=>e.phase==='dialogue');assert.equal(dialogue.request.positions.length,2);assert.equal(dialogue.request.iteration,1);
  const judgment=processPort(t,{adjust(request,result){if(request.phase==='contribute')result.objections=[{kind:'judgment',reason:'risk tolerance'}];}});
  assert.equal((await run(judgment,{stage:stage({mode:'mob',support_agents:['quality']})})).reason,'mob_judgment');
});

test('cancellation terminates subprocess, retains cancelled receipt and blocks dependent work',async t=>{
  const port=processPort(t,{delay:1000}),controller=new AbortController();
  const pending=run(port,{signal:controller.signal,units:[{id:'a'},{id:'b',depends_on:['a']}]});
  setTimeout(()=>controller.abort(),80);const result=await pending;
  assert.equal(result.status,'cancelled');assert.equal(result.units[0].receipts[0].status,'cancelled');assert.equal(port.events.filter(e=>e.kind==='start').length,1);
});

test('crash response fails closed; durable process receipt replay avoids duplicate subprocesses',async t=>{
  let crash=true;
  const port=processPort(t); const save=port.saveReceipt;
  port.saveReceipt=async(request,result)=>{await save(request,result);if(crash){crash=false;throw new Error('host crashed after durable write');}};
  const first=await run(port);assert.equal(first.status,'blocked');assert.equal(first.reason,'executor_error');
  const resumed=await run(port);assert.equal(resumed.status,'completed');assert.equal(resumed.units[0].receipts[0].replayed,true);
  assert.equal(port.events.filter(e=>e.kind==='start').length,1);
});

test('source-changing execution crash resumes from private frozen basis and stored receipt',async t=>{
  let crash=true;const bases=new Map();
  const port=processPort(t,{adjust(request,result,port){if(request.phase==='draft')port.source.set(request.unit,'implementation modified source');}});
  port.loadBasis=async key=>structuredClone(bases.get(key));port.saveBasis=async(key,basis)=>bases.set(key,structuredClone(basis));
  const save=port.saveReceipt;port.saveReceipt=async(request,result)=>{await save(request,result);if(crash){crash=false;throw new Error('crash after durable receipt');}};
  assert.equal((await run(port)).status,'blocked');
  const resumed=await run(port);assert.equal(resumed.status,'completed');assert.equal(resumed.units[0].receipts[0].replayed,true);
  assert.equal(port.events.filter(e=>e.kind==='start').length,1);
});

test('crashed execution without durable receipt cannot replay against changed source',async t=>{
  const bases=new Map();const port=processPort(t,{adjust(request,result,port){port.source.set(request.unit,'unreceipted mutation');throw new Error('crashed before receipt');}});
  port.loadBasis=async key=>structuredClone(bases.get(key));port.saveBasis=async(key,basis)=>bases.set(key,structuredClone(basis));
  assert.equal((await run(port)).reason,'executor_error');assert.equal((await run(port)).reason,'stale_execution');
  assert.equal(port.events.filter(e=>e.kind==='start').length,1);
});

test('invalid review iteration zero and total execution budget never imply completed',async t=>{
  const port=processPort(t);
  assert.equal((await run(port,{stage:stage({reviewer:'reviewer',reviewer_max_iterations:0})})).reason,'invalid_policy');
  assert.equal(port.events.length,0);
  const bounded=processPort(t);const result=await run(bounded,{stage:stage({support_agents:['architecture','quality']}),policy:{maxParallel:1,maxExecutions:2}});
  assert.equal(result.status,'blocked');assert.equal(result.executions,2);assert.equal(result.reason,'execution_budget');
});


test('observed subprocess nonzero exit retains command receipt and blocks dependent dispatch',async t=>{
  const port=processPort(t,{exitCode:()=>23});const outcome=await run(port,{units:[{id:'a'},{id:'b',depends_on:['a']}]});
  assert.equal(outcome.reason,'execution_failed');assert.equal(outcome.units[1].reason,'dependency_blocked');
  const receipt=JSON.parse(readFileSync(outcome.units[0].receipts[0].receipt.id,'utf8'));assert.equal(receipt.exit_code,23);
  assert.equal(port.events.filter(e=>e.kind==='start').length,1);
});


test('accepted finding requires a distinct host authorization bound to current review basis',async t=>{
  const port=processPort(t,{adjust(request,result){if(request.phase==='review')result.findings=[{id:'F1',severity:'medium',status:'accepted',reason:'known tradeoff'}];}});
  assert.equal((await run(port,{stage:stage({reviewer:'reviewer'})})).reason,'authority_required');
  port.authorizeFinding=async input=>{assert.equal(input.finding.id,'F1');assert.equal(input.basis.source_digest,digest('source'));return {authorized:true,reference:'test-host-approval-reference'};};
  const outcome=await run(port,{stage:stage({reviewer:'reviewer'})});assert.equal(outcome.status,'completed');assert.equal(outcome.units[0].findings[0].authority.reference,'test-host-approval-reference');
});


test('failed spoke waits for every live peer before shared unit resource release',async t=>{
  const port=processPort(t,{delay:request=>request.phase==='contribute'&&request.role==='architecture'?120:20,exitCode:request=>request.unit==='a'&&request.phase==='contribute'&&request.role==='quality'?23:0});
  const outcome=await run(port,{stage:stage({support_agents:['architecture','quality']}),units:[{id:'a',mutable_resources:['shared']},{id:'b',mutable_resources:['shared']}],policy:{maxParallel:3}});
  assert.equal(outcome.status,'blocked');assert.equal(outcome.units[0].reason,'execution_failed');assert.equal(outcome.units[1].status,'completed');
  assert.ok(port.events.findIndex(event=>event.kind==='start'&&event.unit==='b')>port.events.findIndex(event=>event.kind==='end'&&event.unit==='a'&&event.role==='architecture'));
});


test('trusted host advisory acceptance happens once before canonical lease release; denial stays awaiting',async t=>{
  for(const accepted of [true,false]){
    const port=processPort(t,{adjust(request,result){if(request.phase==='review')Object.assign(result,{verdict:'not_ready',findings:[{id:'F1',severity:'low',status:'open',reason:'human tradeoff'}]});}});
    let decisionCalls=0,releasedStatus;
    port.claim=async()=>({observedLease:'test-host-claim'});
    port.decide=async input=>{decisionCalls++;assert.equal(input.kind,'advisory_review');assert.equal(input.review_receipts.length,1);assert.equal(input.findings[0].status,'open');return accepted?{authorized:true,decision:'accept',reference:'test-host-advisory-grant'}:{authorized:false,decision:'decline'};};
    port.release=async(lease,record)=>{releasedStatus=record.status;};
    const result=await run(port,{stage:stage({reviewer:'reviewer',review_class:'advisory'})});
    assert.equal(result.status,accepted?'completed':'awaiting_decision');assert.equal(releasedStatus,result.status);assert.equal(decisionCalls,1);
    assert.equal(result.units[0].reviews.length,1);assert.equal(result.units[0].authority_reference,accepted?'test-host-advisory-grant':undefined);
  }
});

test('trusted host mob judgment acceptance retains dissent; missing reference cannot accept',async t=>{
  for(const reference of ['test-host-mob-grant',null]){
    const port=processPort(t,{adjust(request,result){if(request.phase==='contribute')result.objections=[{kind:'judgment',reason:'risk appetite'}];}});
    port.decide=async input=>{assert.equal(input.kind,'mob_judgment');assert.equal(input.dissent.length,1);return {authorized:true,decision:'accept',reference};};
    const result=await run(port,{stage:stage({mode:'mob',support_agents:['quality'],reviewer:'reviewer'})});
    if(reference)assert.equal(result.units[0].reviews.length,1);
    assert.equal(result.status,reference?'completed':'awaiting_decision');assert.equal(result.units[0].dissent[0].reason,'risk appetite');
  }
});

test('source changed during trusted host decision invalidates acceptance before lease release',async t=>{
  const port=processPort(t);let releasedStatus;
  port.claim=async()=>({observedLease:'test-host-claim'});port.release=async(lease,record)=>{releasedStatus=record.status;};
  port.decide=async input=>{port.source.set(input.unit,'changed during human decision');return {authorized:true,decision:'accept',reference:'test-host-stale-grant'};};
  const result=await run(port,{stage:stage({reviewer:'reviewer',review_class:'advisory'})});
  assert.equal(result.reason,'stale_decision');assert.equal(result.status,'blocked');assert.equal(releasedStatus,'blocked');assert.equal(result.units[0].authority_reference,undefined);
});
