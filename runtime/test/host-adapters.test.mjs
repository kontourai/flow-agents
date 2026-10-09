import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseCodexEvents} from '../docker-worker.mjs';
import {startProviderProxy} from '../provider-broker.mjs';
import {DEFAULT_STORAGE,inspectStorage,admitStorage} from '../storage-admission.mjs';

test('worker usage requires one observed complete turn with finite integral tokens',()=>{
 const events=[{type:'thread.started',thread_id:'actual'},{type:'turn.started'},{type:'turn.completed',usage:{input_tokens:2,output_tokens:3}},{type:'item.completed',item:{type:'agent_message',text:'result'}}];
 const lines=()=>events.map(e=>JSON.stringify(e)).join('\n');
 assert.equal(parseCodexEvents(lines()).final,'result');
 events[2].usage.output_tokens=-1;assert.throws(()=>parseCodexEvents(lines()),/terminal token usage/);
 events[2].usage.output_tokens=3;events.push(events[2]);assert.throws(()=>parseCodexEvents(lines()),/one complete turn/);
});

test('storage inspector refuses symlink traversal and actual byte excess',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'host-storage-'));
 try{
  const policy={...DEFAULT_STORAGE,roots:[root],min_free_bytes:0,max_bytes:4};
  await writeFile(path.join(root,'output'),'12345');assert.equal((await inspectStorage(policy)).reason,'writable_byte_budget');
  await assert.rejects(admitStorage(policy),/storage_admission_refused/);
  await rm(path.join(root,'output'));await symlink(os.tmpdir(),path.join(root,'escape'));assert.equal((await inspectStorage(policy)).reason,'unsupported_writable_entry');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('provider broker authenticates capability, bounds model and forwards canonical JSON',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'host-broker-'));let broker;let forwarded=null;
 try{
  const authFile=path.join(root,'auth.json');await writeFile(authFile,JSON.stringify({OPENAI_API_KEY:'host-test-secret'}));
  broker=await startProviderProxy({authFile,model:'model-a',bindHost:'127.0.0.1',fetchImpl:async(_url,request)=>{forwarded=JSON.parse(request.body);return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',{headers:{'content-type':'text/event-stream'}});}});
  const url=broker.baseUrl.replace('host.docker.internal','127.0.0.1')+'/responses';
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers:{authorization:`Bearer ${broker.capability}`},body:JSON.stringify({model:'other'})})).status,403);
  const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${broker.capability}`},body:'{"model":"other","model":"model-a","input":"hello"}'});await response.text();
  assert.equal(response.status,200);assert.equal(forwarded.model,'model-a');assert.equal(broker.evidence[0].transport_mode,'mocked-test-only');assert.equal(JSON.stringify(broker.evidence).includes('host-test-secret'),false);
 }finally{await broker?.close();await rm(root,{recursive:true,force:true});}
});
