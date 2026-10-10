import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectEngine, listEngineProfiles, parseEngineOutput, prepareEngineInvocation, runEngine, runIsolatedEngine } from '../../build/src/engine-host.js';
const complete=[{type:'thread.started',thread_id:'thread-1'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'OK'}},{type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}].map(e=>JSON.stringify(e)).join('\n');
async function fixture(t,source) {
 const root=await mkdtemp(path.join(os.tmpdir(),'engine-host-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const executable=path.join(root,'engine');
 await writeFile(executable,`#!${process.execPath}\nif(process.argv.includes("--version")){console.log("fake-engine 1");process.exit(0);}
${source}`,{mode:0o700});
 return {root,executable};
}
const options=(f,extra={})=>({engine:'codex',workspace:f.root,executable:f.executable,prompt:'literal $(danger)',timeoutMs:1000,executionProfile:'host-native',hostAccessGranted:true,...extra});
test('six explicit profiles preserve engine/model and prompt boundary',()=>{
 assert.equal(listEngineProfiles().length,6);
 for(const {id} of listEngineProfiles()) {
  const call=prepareEngineInvocation(id,'--leading $(literal)',{model:'explicit-model'});
  assert.ok(call.args.includes('explicit-model'));
  assert.ok(call.stdin==='--leading $(literal)'||call.args.includes('--leading $(literal)'));
 }
 assert.throws(()=>prepareEngineInvocation('unknown','x'),/Unsupported/);
});
test('split UTF8/JSON output waits for close and binds identity',async t=>{
 const f=await fixture(t,`process.stdin.resume();process.stdin.on('end',()=>{const b=Buffer.from(${JSON.stringify(complete.replace('OK','héllo'))});process.stdout.write(b.subarray(0,71));setTimeout(()=>process.stdout.end(b.subarray(71)),10);});`);
 const r=await runEngine(options(f));
 assert.equal(r.outcome,'completed'); assert.equal(r.final,'héllo'); assert.equal(r.session_id,'thread-1'); assert.equal(r.usage.input_tokens,2);
 assert.match(r.observed.entrypoint_digest,/^sha256:/); assert.equal(r.observed.isolation,'none');assert.equal(r.observed.requested_model,null);
});
test('exit zero without terminal evidence fails closed; API errors are retained',async t=>{
 const f=await fixture(t,`console.log('{"type":"thread.started","thread_id":"incomplete"}');`);
 assert.equal((await runEngine(options(f))).outcome,'protocol_error');
 assert.equal(parseEngineOutput('claude','{"type":"result","subtype":"success","is_error":true,"result":"auth expired"}').failed,true);
});
test('nonzero exit remains engine error despite successful terminal',async t=>{
 const f=await fixture(t,`console.log(${JSON.stringify(complete)});process.exitCode=9;`);
 const r=await runEngine(options(f)); assert.equal(r.outcome,'engine_error');assert.equal(r.terminal.status,9);
});
test('deadline kills a spawned descendant and settles receipt',async t=>{
 const f=await fixture(t,`import {spawn} from 'node:child_process';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.error(c.pid);setInterval(()=>{},1000);`);
 const r=await runEngine(options(f,{timeoutMs:800})); assert.equal(r.outcome,'timeout');assert.ok(r.terminal.signal);
 const pid=Number(r.stderr.trim());assert.ok(pid>0);await new Promise(resolve=>setTimeout(resolve,40));assert.throws(()=>process.kill(pid,0));
});
test('cancellation before and during execution are explicit',async t=>{
 const f=await fixture(t,'setInterval(()=>{},1000);');
 const before=new AbortController();before.abort();assert.equal((await runEngine(options(f,{signal:before.signal}))).outcome,'cancelled');
 const during=new AbortController();setTimeout(()=>during.abort(),50);assert.equal((await runEngine(options(f,{signal:during.signal}))).outcome,'cancelled');
});
test('combined output bound retains bounded data and kills process',async t=>{
 const f=await fixture(t,`process.stdout.write('x'.repeat(10000));process.stderr.write('y'.repeat(10000));setInterval(()=>{},1000);`);
 const r=await runEngine(options(f,{maxOutputBytes:200}));assert.equal(r.outcome,'output_limit');assert.ok(Buffer.byteLength(r.stdout)+Buffer.byteLength(r.stderr)<=200);
});
test('credential environment values never appear in returned transcript',async t=>{
 const f=await fixture(t,`console.log(${JSON.stringify(complete)}.replace('OK',process.env.TEST_SECRET));console.error(process.env.TEST_SECRET);`);
 const r=await runEngine(options(f,{environment:{TEST_SECRET:'secret-runtime-value'}}));assert.equal(r.final,'[redacted]');assert.ok(!JSON.stringify(r).includes('secret-runtime-value'));
});
test('missing engine never falls back; host grant and IDE refusal enforced',async t=>{
 const f=await fixture(t,'');
 assert.equal((await detectEngine('kiro',{executable:path.join(f.root,'absent')})).installed,false);
 await assert.rejects(runEngine(options(f,{hostAccessGranted:false})),/grant/);await assert.rejects(runEngine(options(f,{surface:'ide'})),/IDE/);
});
test('OpenCode/Copilot require own terminals; token totals remain unknown',()=>{
 const op=parseEngineOutput('opencode','{"type":"text","sessionID":"s","part":{"text":"OK"}}\n{"type":"step_finish","part":{"reason":"stop","tokens":{"input":1,"output":1}}}');
 assert.equal(op.complete,true);assert.equal(op.usage.complete,false);
 const cp=parseEngineOutput('copilot','{"type":"assistant.message","data":{"content":"OK"}}\n{"type":"result","sessionId":"s","exitCode":0}');
 assert.equal(cp.complete,true);assert.equal(cp.session_id,'s');assert.equal(cp.usage.complete,false);
 assert.equal(parseEngineOutput('kiro','{"type":"runError","data":{"message":"limit"}}').failed,true);assert.throws(()=>parseEngineOutput('codex','not json'));
});
test('read-only tree observation rejects native modifications without claiming confinement',async t=>{
 const f=await fixture(t,`import {writeFileSync} from 'node:fs';writeFileSync('modified.txt','changed');console.log(${JSON.stringify(complete)});`);
 const r=await runEngine(options(f,{readOnlyWorkspace:true}));
 assert.equal(r.outcome,'workspace_modified');assert.notEqual(r.observed.workspace_before,r.observed.workspace_after);
 assert.equal(r.observed.credential_confinement,false);
});
test('isolated unsupported protocols refuse before worker execution',async()=>{
 await assert.rejects(runIsolatedEngine({engine:'claude'}),/Isolated broker protocol not supported/);
});

test('Kiro version-qualified ACP terminal schema admits only complete nontruncated turns',()=>{
 const stream=JSON.stringify({type:'runStarted',data:{payloadSchema:'acp',acpProtocolVersion:1,engine:'v2'}})+'\n'+JSON.stringify({type:'metadata',data:{sessionId:'kiro-session'}})+'\n'+JSON.stringify({type:'runFinished',data:{sessionId:'kiro-session',stopReason:'end_turn',finalText:'OK',finalTextTruncated:false}});
 assert.equal(parseEngineOutput('kiro',stream,{version:'kiro-cli 2.24.0'}).complete,true);
 assert.equal(parseEngineOutput('kiro',stream,{version:'kiro-cli 2.25.0'}).complete,false);
 assert.equal(parseEngineOutput('kiro',stream.replace('"finalTextTruncated":false','"finalTextTruncated":true'),{version:'kiro-cli 2.24.0'}).complete,false);
 assert.equal(parseEngineOutput('kiro',stream.replace('end_turn','cancelled'),{version:'kiro-cli 2.24.0'}).complete,false);
});

test('UTF8 truncation cannot exceed a byte output bound',async t=>{
 const f=await fixture(t,"process.stdout.write('é'.repeat(100));setInterval(()=>{},1000);");
 const r=await runEngine(options(f,{maxOutputBytes:1}));assert.equal(r.outcome,'output_limit');assert.ok(Buffer.byteLength(r.stdout)+Buffer.byteLength(r.stderr)<=1);
});

test('mixed provider session identities and duplicate terminal turns fail closed',()=>{
 assert.equal(parseEngineOutput('codex',complete+'\n'+JSON.stringify({type:'thread.started',thread_id:'thread-2'})).complete,false);
 assert.equal(parseEngineOutput('codex',complete+'\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})).complete,false);
});
