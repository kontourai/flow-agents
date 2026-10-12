import { test } from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectEngine, listEngineProfiles, parseEngineOutput, prepareEngineInvocation, runEngine, runIsolatedEngine } from '../../build/src/engine-host.js';
const complete=[{type:'thread.started',thread_id:'thread-1'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'OK'}},{type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}].map(e=>JSON.stringify(e)).join('\n');
async function fixture(t,source,version='fake-engine 1') {
 const root=await mkdtemp(path.join(os.tmpdir(),'engine-host-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const executable=path.join(root,'engine');
 await writeFile(executable,`#!${process.execPath}\nif(process.argv.includes("--version")){console.log(${JSON.stringify(version)});process.exit(0);}
${source}`,{mode:0o700});
 return {root,executable};
}
const options=(f,extra={})=>({engine:'codex',workspace:f.root,executable:f.executable,prompt:'literal $(danger)',timeoutMs:1000,executionProfile:'host-native',hostAccessGranted:true,...extra});
test('seven explicit profiles preserve engine/model and prompt boundary',()=>{
 assert.equal(listEngineProfiles().length,7);
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
 const op=parseEngineOutput('opencode',openStream('OK'));
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

function openEvent(type,id,text) { return {type,sessionID:'s',part:{messageID:id,sessionID:'s',...(type==='text'?{text}:type==='step_finish'?{reason:text}:{})}}; }
function openStream(text) { return [openEvent('step_start','m'),openEvent('text','m',text),openEvent('step_finish','m','stop')].map(JSON.stringify).join('\n'); }
test('OpenCode returns exact terminal message and excludes earlier tool-step narration',()=>{
 const events=[openEvent('step_start','tool'),openEvent('text','tool','Working...'),openEvent('tool_use','tool'),openEvent('step_finish','tool','tool-calls')];
 const r=parseEngineOutput('opencode',events.map(JSON.stringify).join('\n')+'\n'+openStream('Prose remains. ```json {} ```'));
 assert.equal(r.complete,true);assert.equal(r.final,'Prose remains. ```json {} ```');
});
test('OpenCode partial, mismatched, repeated and post-terminal message streams refuse',()=>{
 const good=openStream('OK');
 for(const bad of [good.replace('"messageID":"m","sessionID":"s","text"','"messageID":"other","sessionID":"s","text"'),good.split('\n').slice(1).join('\n'),good+'\n'+JSON.stringify(openEvent('text','m','late')),good.replace('"reason":"stop"','"reason":"length"'),good.replaceAll('"sessionID":"s"','"sessionID":""'),good+'\n'+good]) assert.equal(parseEngineOutput('opencode',bad).complete,false);
 assert.equal(parseEngineOutput('opencode',good+'\n'+JSON.stringify({type:'error',sessionID:'s'})).failed,true);
});
function museEvent(sequence,type,payload) { return {schema_version:1,payload_schema_version:1,stream:{kind:'session',id:'session'},sequence,payload_type:type,causation_id:'run',payload}; }
const museStarted=museEvent(1,'run.lifecycle.started',{kind:'run_started',command_id:'run',run_stream:{kind:'run',id:'run'}});
const museTerminal=museEvent(2,'run.terminal.completed',{kind:'run_terminal',command_id:'run',run_stream:{kind:'run',id:'run'},terminal:'completed',reason:null,text:'echo: hello'});
const museStream=(events)=>events.map(JSON.stringify).join('\n');
test('Muse MSP envelope correlates one complete run without claiming provider identity',()=>{
 const r=parseEngineOutput('muse',museStream([museStarted,museTerminal]),{version:'Muse Code 1.4.4 (1.4.4-R5419.1)'});assert.equal(r.complete,true);assert.equal(r.final,'echo: hello');assert.equal(r.usage.complete,false);
 for(const version of ['Muse Code 1.5.0','Muse Code 1.4.6 (1.4.6-R6000.2)',null]) assert.throws(()=>parseEngineOutput('muse',museStream([museStarted,museTerminal]),{version}),/Unsupported Muse MSP protocol version/);
 const call=prepareEngineInvocation('muse','--literal',{workspace:'/root/work',allowTools:true,model:'requested'});assert.deepEqual(call.args,['exec','--json','--model','requested','--workspace','/root/work','--yolo','--','--literal']);
});
test('Muse partial, failed, duplicated and unbound MSP envelopes cannot complete',()=>{
 const copy=(value)=>JSON.parse(JSON.stringify(value));
 const cases=[[museStarted],[museTerminal],[museStarted,museTerminal,museTerminal]];
 for(const mutate of [e=>e.payload.command_id='other',e=>e.stream.id='other',e=>e.sequence=1,e=>e.schema_version=2,e=>e.payload.terminal='failed',e=>e.payload.run_stream.id='other',e=>e.causation_id='other',e=>e.payload_schema_version=2,e=>e.payload.reason='cancelled',e=>e.payload.text='' ]) {const t=copy(museTerminal);mutate(t);cases.push([museStarted,t]);}
 for(const version of ['Muse Code 1.4.4 (1.4.4-R5419.1)','Muse Code 1.4.6 (1.4.6-R6000.1)']) for(const events of cases) assert.equal(parseEngineOutput('muse',museStream(events),{version}).complete,false);
});

const largePrompt='é'.repeat(600000)+'\n--literal $(unchanged)';
const promptHash=value=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
test('OpenCode sends greater-than-1MiB exact UTF8 through stdin without argv prompt',async t=>{
 const stream=openStream('OK');
 const f=await fixture(t,`import {createHash} from 'node:crypto';let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.error(JSON.stringify({bytes:Buffer.byteLength(input),hash:'sha256:'+createHash('sha256').update(input).digest('hex'),argvMax:Math.max(...process.argv.map(a=>Buffer.byteLength(a)))}));console.log(${JSON.stringify(stream)});});`);
 const r=await runEngine(options(f,{engine:'opencode',prompt:largePrompt,timeoutMs:3000}));
 assert.equal(r.outcome,'completed');assert.equal(r.observed.prompt_digest,promptHash(largePrompt));const proof=JSON.parse(r.stderr);assert.equal(proof.hash,promptHash(largePrompt));assert.ok(proof.bytes>1024*1024);assert.ok(proof.argvMax<131072);
});
const museVersion='Muse Code 1.4.4 (1.4.4-R5419.1)';
const museFileReader=`import {readFileSync,statSync,writeFileSync} from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';const file=process.argv[process.argv.indexOf('--prompt-file')+1];const input=readFileSync(file);console.error(JSON.stringify({file,parent:path.dirname(file),fileMode:statSync(file).mode&0o777,dirMode:statSync(path.dirname(file)).mode&0o777,hash:'sha256:'+createHash('sha256').update(input).digest('hex'),bytes:input.length}));writeFileSync('started.marker','ready');`;
test('Muse stages greater-than-1MiB exact input privately outside read-only workspace and removes it',async t=>{
 const f=await fixture(t,museFileReader.replace("writeFileSync('started.marker','ready');",'')+`console.log(${JSON.stringify(museStream([museStarted,museTerminal]))});`,museVersion);
 const r=await runEngine(options(f,{engine:'muse',prompt:largePrompt,readOnlyWorkspace:true,timeoutMs:3000}));
 assert.equal(r.outcome,'completed');assert.equal(r.observed.prompt_digest,promptHash(largePrompt));assert.equal(r.observed.workspace_before,r.observed.workspace_after);
 const proof=JSON.parse(r.stderr);assert.equal(proof.hash,promptHash(largePrompt));assert.ok(proof.bytes>1024*1024);assert.equal(proof.fileMode,0o400);assert.equal(proof.dirMode,0o700);assert.ok(!proof.parent.startsWith(f.root+path.sep));await assert.rejects(access(proof.parent));
});
test('Muse owned prompt staging cleans timeout, cancellation, output bound, nonzero and invalid protocol outcomes',async t=>{
 for(const [outcome,source,extra] of [
  ['timeout','setInterval(()=>{},1000);',{timeoutMs:1500}],
  ['cancelled','setInterval(()=>{},1000);',{cancel:true,timeoutMs:3000}],
  ['engine_error','process.exitCode=7;',{}],
  ['protocol_error',"console.log('not json');",{}],
  ['output_limit',"process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000);",{maxOutputBytes:2048}],
 ]) {
  const f=await fixture(t,museFileReader+source,museVersion);const controller=new AbortController();let poll;if(extra.cancel){poll=setInterval(()=>access(path.join(f.root,'started.marker')).then(()=>controller.abort()).catch(()=>{}),20);t.after(()=>clearInterval(poll));}
  const r=await runEngine(options(f,{engine:'muse',prompt:largePrompt,timeoutMs:3000,...extra,signal:controller.signal}));if(poll)clearInterval(poll);assert.equal(r.outcome,outcome);const proof=JSON.parse(r.stderr);await assert.rejects(access(proof.parent));assert.equal(r.observed.prompt_digest,promptHash(largePrompt));
 }
});
test('native prompt admission is bounded without including prompt content in errors',()=>{
 const secret='sensitive-value';assert.throws(()=>prepareEngineInvocation('opencode',secret+'x'.repeat(16*1024*1024)),error=>/input bound/.test(error.message)&&!error.message.includes(secret));
});

test('Muse 1.4.6 observed schema-v1 run completes through the native host',async t=>{
 const version='Muse Code 1.4.6 (1.4.6-R6000.1)';
 const events=[museStarted,museTerminal];
 const parsed=parseEngineOutput('muse',museStream(events),{version});
 assert.equal(parsed.complete,true);assert.equal(parsed.failed,false);assert.equal(parsed.session_id,'session');assert.equal(parsed.final,'echo: hello');
 const f=await fixture(t,`console.log(${JSON.stringify(museStream(events))});`,version);
 const r=await runEngine(options(f,{engine:'muse',timeoutMs:3000}));
 assert.equal(r.outcome,'completed');assert.equal(r.protocol_error,null);assert.equal(r.terminal.status,0);assert.equal(r.observed.harness_version,version);assert.equal(r.final,'echo: hello');
});
test('unknown Muse build refuses before any native worker launch',async t=>{
 for(const version of ['Muse Code 1.5.0','Muse Code 1.4.6 (1.4.6-R6000.2)','']) {
  const f=await fixture(t,`import {writeFileSync} from 'node:fs';writeFileSync('worker.marker','started');console.log(${JSON.stringify(museStream([museStarted,museTerminal]))});`,version);
  await assert.rejects(runEngine(options(f,{engine:'muse'})),/Unsupported Muse MSP protocol version/);
  await assert.rejects(access(path.join(f.root,'worker.marker')));
 }
});

// Selected observed 1.4.6 envelopes: identifiers, timestamps, prompt and final redacted.
const observedMuse146=[{"schema_version":1,"id":"observed-5","stream":{"kind":"session","id":"observed-session"},"sequence":5,"recorded_at":0,"record_type":"event","durability":"durable","causation_id":"observed-run","payload_type":"run.lifecycle.started","payload_schema_version":1,"payload":{"kind":"run_started","command_id":"observed-run","run_stream":{"kind":"run","id":"observed-run"},"prompt":"[redacted prompt]"}},{"schema_version":1,"id":"observed-483","stream":{"kind":"session","id":"observed-session"},"sequence":483,"recorded_at":0,"record_type":"event","durability":"durable","causation_id":"observed-run","payload_type":"run.terminal.completed","payload_schema_version":1,"payload":{"kind":"run_terminal","command_id":"observed-run","run_stream":{"kind":"run","id":"observed-run"},"terminal":"completed","text":"[redacted final]","reason":null}}];
test('observed Muse 1.4.6 lifecycle envelope shape and sequence complete',()=>{
 const r=parseEngineOutput('muse',museStream(observedMuse146),{version:'Muse Code 1.4.6 (1.4.6-R6000.1)'});
 assert.equal(r.complete,true);assert.equal(r.failed,false);assert.equal(r.session_id,'observed-session');assert.equal(r.final,'[redacted final]');
});
