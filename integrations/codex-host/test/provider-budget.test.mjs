import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startProviderProxy} from '../provider-broker.mjs';
const binding='sha256:'+'a'.repeat(64);
async function fixture(fn){const dir=await mkdtemp(path.join(os.tmpdir(),'provider-budget-'));const authFile=path.join(dir,'auth.json');await writeFile(authFile,JSON.stringify({OPENAI_API_KEY:'host-secret-never-persist'}));let brokers=[];const options={authFile,ledgerFile:path.join(dir,'budget.json'),requestBindingDigest:binding,model:'model-a',reasoningEffort:'high',maxRequests:2,bindHost:'127.0.0.1',fetchImpl:async()=>new Response('{}')};const start=async(extra={})=>{const broker=await startProviderProxy({...options,...extra});brokers.push(broker);return broker;};try{await fn({dir,options,start});}finally{for(const b of brokers)await b.close();await rm(dir,{recursive:true,force:true});}}
async function send(broker,extra={}){const response=await fetch(broker.baseUrl.replace('host.docker.internal','127.0.0.1')+'/responses',{method:'POST',headers:{authorization:`Bearer ${broker.capability}`},body:JSON.stringify({model:'model-a',reasoning:{effort:'high'},...extra})});await response.text();return response.status;}

test('registered-run provider quota survives broker close and resume with separate session observations',async()=>fixture(async({start,options})=>{
 const first=await start({initializeLedger:true});assert.equal(await send(first,{model:'other'}),403);assert.equal(await send(first),200);assert.equal(first.counters.total_forwarded,1);await first.close();
 const resumed=await start();assert.equal(resumed.counters.forwarded,0);assert.equal(resumed.counters.total_forwarded,1);assert.equal(await send(resumed),200);assert.equal(await send(resumed),429);assert.equal(resumed.counters.forwarded,1);assert.equal(resumed.counters.total_forwarded,2);assert.equal(resumed.counters.refused,1);
 assert.equal((await readFile(options.ledgerFile,'utf8')).includes('host-secret'),false);assert.equal((await readFile(options.ledgerFile+'.reservations','utf8')).includes('host-secret'),false);
}));

test('binding mismatch and concurrent sessions refuse without releasing another owner lock',async()=>fixture(async({start})=>{
 const first=await start({initializeLedger:true});await assert.rejects(start(),/session already owned/);await assert.rejects(start(),/session already owned/);assert.equal(await send(first),200);await first.close();
 for(const change of [{model:'different'},{maxRequests:3},{reasoningEffort:'low'},{requestBindingDigest:'sha256:'+'b'.repeat(64)},{upstreamOrigin:'https://chatgpt.com/backend-api/codex'}])await assert.rejects(start(change),/binding|integrity/);
 const next=await start();assert.equal(next.counters.total_forwarded,1);
}));

test('failed upstream reservation is consumed across restart',async()=>fixture(async({start})=>{
 const failing=await start({initializeLedger:true,fetchImpl:async()=>{throw new Error('transport failure');}});assert.equal(await send(failing),502);assert.equal(failing.counters.total_forwarded,1);await failing.close();const next=await start();assert.equal(await send(next),200);assert.equal(await send(next),429);
}));

test('missing or altered persisted budget fails closed, including missing initial resume',async()=>fixture(async({start,options})=>{
 await assert.rejects(start(),/existing ledger required/);const first=await start({initializeLedger:true});assert.equal(await send(first),200);await first.close();
 const original=await readFile(options.ledgerFile,'utf8');const damaged=JSON.parse(original);damaged.reserved_requests=0;await writeFile(options.ledgerFile,JSON.stringify(damaged)+'\n');await assert.rejects(start(),/integrity/);
 await writeFile(options.ledgerFile,original);await rm(options.ledgerFile);await assert.rejects(start(),/unavailable/);await rm(options.ledgerFile+'.reservations');await assert.rejects(start(),/existing ledger required/);
}));

test('reservation persistence failure never forwards or regains admission',async()=>fixture(async({start,options})=>{
 let forwarded=0;const first=await start({initializeLedger:true,fetchImpl:async()=>{forwarded++;return new Response('{}');}});
 // A corrupted journal detected before reservation poisons the session and refuses upstream.
 await writeFile(options.ledgerFile+'.reservations','corrupt\n');assert.equal(await send(first),502);assert.equal(forwarded,0);assert.equal(await send(first),502);await first.close();await assert.rejects(start(),/binding|journal/);
}));

test('partial reservation write failure remains fail closed on restart',async()=>fixture(async({start,options})=>{
 let forwarded=0;const first=await start({initializeLedger:true,fetchImpl:async()=>{forwarded++;return new Response('{}');}});
 const token=await readFile(options.ledgerFile+'.lock','utf8');await writeFile(options.ledgerFile+'.'+token+'.tmp','occupied',{mode:0o600});
 assert.equal(await send(first),502);assert.equal(forwarded,0);assert.equal(first.counters.total_forwarded,1);assert.equal(await send(first),502);await first.close();await assert.rejects(start(),/integrity/);
}));

test('provider ledger requires private host-owned storage',async()=>fixture(async({start,dir})=>{
 await chmod(dir,0o755);await assert.rejects(start({initializeLedger:true}),/private host-owned directory/);
}));
