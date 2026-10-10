import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {executeInstalledKit,parseKitExecution} from '../../build/src/kit-execution.js';
const CLI=path.resolve('build/src/cli.js');
const descriptor={module:'entry.mjs',export:'execute',contract:'kontour.kit.execution_request@1.0'};
test('installed execution invokes declared generic entry and refuses drift or cross-kit requests',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'installed-entry-'));const source=path.join(root,'source'),dest=path.join(root,'dest'),requestFile=path.join(root,'request.json');fs.mkdirSync(source);fs.mkdirSync(dest);
 try{
  fs.writeFileSync(path.join(source,'kit.json'),JSON.stringify({schema_version:'1.0',id:'portable',name:'Portable',flows:[{id:'portable.check',path:'check.flow.json'}],execution:descriptor}));
  fs.writeFileSync(path.join(source,'check.flow.json'),JSON.stringify({id:'portable.check',version:'1',steps:[{id:'check',next:null}],gates:{}}));
  fs.writeFileSync(path.join(source,'entry.mjs'),'export async function execute({requestFile}){return {status:"completed",request:JSON.parse((await import("node:fs")).readFileSync(requestFile,"utf8"))};}');
  const install=spawnSync(process.execPath,[CLI,'kit','install',source,'--dest',dest],{encoding:'utf8'});assert.equal(install.status,0,install.stdout+install.stderr);
  fs.writeFileSync(requestFile,JSON.stringify({schema:'kontour.kit.execution_request',version:'1.0',kit_id:'portable'}));
  assert.equal((await executeInstalledKit({kitId:'portable',dest,requestFile,controllerRoot:path.join(root,'private')})).status,'completed');
  const cli=spawnSync(process.execPath,[CLI,'kit','run','portable','--dest',dest,'--request',requestFile,'--controller-root',path.join(root,'private')],{encoding:'utf8'});assert.equal(cli.status,0,cli.stderr);
  fs.writeFileSync(path.join(source,'helper.mjs'),'export const version=2;');
  fs.writeFileSync(path.join(source,'entry.mjs'),'import {version} from "./helper.mjs";export async function execute(){return {status:"completed",version};}');
  const update=spawnSync(process.execPath,[CLI,'kit','install',source,'--dest',dest,'--update'],{encoding:'utf8'});assert.equal(update.status,0,update.stderr);
  assert.equal((await executeInstalledKit({kitId:'portable',dest,requestFile,controllerRoot:root})).version,2);
  fs.writeFileSync(path.join(source,'helper.mjs'),'export const version=3;');
  const updateAgain=spawnSync(process.execPath,[CLI,'kit','install',source,'--dest',dest,'--update'],{encoding:'utf8'});assert.equal(updateAgain.status,0,updateAgain.stderr);
  assert.equal((await executeInstalledKit({kitId:'portable',dest,requestFile,controllerRoot:root})).version,3);
  fs.writeFileSync(path.join(source,'entry.mjs'),'export async function execute(){await new Promise(()=>{});}');
  const hangingUpdate=spawnSync(process.execPath,[CLI,'kit','install',source,'--dest',dest,'--update'],{encoding:'utf8'});assert.equal(hangingUpdate.status,0,hangingUpdate.stderr);
  fs.writeFileSync(requestFile,JSON.stringify({schema:'kontour.kit.execution_request',version:'1.0',kit_id:'portable',execution:{timeout_s:0.1}}));
  await assert.rejects(executeInstalledKit({kitId:'portable',dest,requestFile,controllerRoot:root}),/deadline exceeded/);
  fs.writeFileSync(requestFile,JSON.stringify({schema:'kontour.kit.execution_request',version:'1.0',kit_id:'other'}));await assert.rejects(executeInstalledKit({kitId:'portable',dest,requestFile,controllerRoot:root}),/Request must bind/);
  const unhashed=path.join(dest,'kits/local/repositories/portable/__pycache__');fs.mkdirSync(unhashed);fs.writeFileSync(path.join(unhashed,'helper.mjs'),'export const version=99');await assert.rejects(executeInstalledKit({kitId:'portable',dest,requestFile,controllerRoot:root}),/unhashed entries/);fs.rmSync(unhashed,{recursive:true});
  fs.appendFileSync(path.join(dest,'kits/local/repositories/portable/entry.mjs'),'\n// drift');await assert.rejects(executeInstalledKit({kitId:'portable',dest,requestFile,controllerRoot:root}),/integrity refused/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('descriptor excludes traversal and missing execution exports',()=>{
 for(const module of ['../entry.mjs','/tmp/entry.mjs','sub/../entry.mjs','sub\\entry.mjs','__pycache__/entry.mjs','.git/entry.mjs'])assert.throws(()=>parseKitExecution({execution:{...descriptor,module}}));
 assert.throws(()=>parseKitExecution({execution:{...descriptor,export:'bad-name'}}));
});
test('a returned result with disconnected IPC retains custody until observed process termination',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'entry-ipc-custody-')),source=path.join(root,'kit'),dest=path.join(root,'dest'),bin=path.join(root,'bin');
 for(const dir of [source,dest,bin])fs.mkdirSync(dir);
 const pidFile=path.join(root,'pid'),log=path.join(root,'cleanup'),requestFile=path.join(root,'request.json'),prior=process.env.PATH;
 let pid;
 try{
  fs.writeFileSync(path.join(source,'kit.json'),JSON.stringify({schema_version:'1.0',id:'ipc-custody',name:'IPC custody',flows:[{id:'ipc-custody.check',path:'check.flow.json'}],execution:descriptor}));
  fs.writeFileSync(path.join(source,'check.flow.json'),JSON.stringify({id:'ipc-custody.check',version:'1',steps:[{id:'check',next:null}],gates:{}}));
  // The ordinary child runner disconnects IPC after sending this result, but
  // this referenced handle keeps the actual installed entry process alive.
  fs.writeFileSync(path.join(source,'entry.mjs'),`import fs from 'node:fs';export async function execute(){fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);return {status:'completed'};}`);
  const install=spawnSync(process.execPath,[CLI,'kit','install',source,'--dest',dest],{encoding:'utf8'});assert.equal(install.status,0,install.stderr);
  // Owner cleanup must run only after the process that could create more
  // workers has exited, and it must run exactly once.
  fs.writeFileSync(path.join(bin,'docker'),`#!${process.execPath}\nconst fs=require('node:fs');const pid=Number(fs.readFileSync(${JSON.stringify(pidFile)},'utf8'));try{process.kill(pid,0);console.error('host still alive during cleanup');process.exit(1);}catch(error){if(error.code!=='ESRCH')throw error;}fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');\n`,{mode:0o755});
  process.env.PATH=bin+path.delimiter+prior;
  fs.writeFileSync(requestFile,JSON.stringify({schema:'kontour.kit.execution_request',version:'1.0',kit_id:'ipc-custody',engine_sandbox:{image:'mock-image'},execution:{timeout_s:0.5}}));
  const started=Date.now();
  await assert.rejects(executeInstalledKit({kitId:'ipc-custody',dest,requestFile,controllerRoot:root}),/deadline exceeded/);
  pid=Number(fs.readFileSync(pidFile,'utf8'));assert.ok(Number.isInteger(pid)&&pid>0);
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH','rejection must follow observed child exit');
  assert.ok(Date.now()-started<10000,'forced process termination must remain bounded');
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,2);assert.ok(calls.every(args=>args[0]==='ps'));
 }finally{
  process.env.PATH=prior;
  // Failure cleanup occurs only after the liveness assertion, never as proof.
  if(pid===undefined&&fs.existsSync(pidFile))pid=Number(fs.readFileSync(pidFile,'utf8'));
  if(pid)try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
  fs.rmSync(root,{recursive:true,force:true});
 }
});
test('a successful kit response cannot hide live invocation-owned workers',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'entry-custody-')),source=path.join(root,'kit'),dest=path.join(root,'dest'),bin=path.join(root,'bin');for(const dir of [source,dest,bin])fs.mkdirSync(dir);
 const prior=process.env.PATH;
 try{
  fs.writeFileSync(path.join(source,'kit.json'),JSON.stringify({schema_version:'1.0',id:'custody',name:'Custody',flows:[{id:'custody.check',path:'check.flow.json'}],execution:descriptor}));
  fs.writeFileSync(path.join(source,'check.flow.json'),JSON.stringify({id:'custody.check',version:'1',steps:[{id:'check',next:null}],gates:{}}));
  fs.writeFileSync(path.join(source,'entry.mjs'),'export async function execute(){return {status:"completed"};}');
  const install=spawnSync(process.execPath,[CLI,'kit','install',source,'--dest',dest],{encoding:'utf8'});assert.equal(install.status,0,install.stderr);
  const countFile=path.join(root,'count'),log=path.join(root,'calls');
  fs.writeFileSync(path.join(bin,'docker'),`#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args[0]==='ps'&&!fs.existsSync(${JSON.stringify(countFile)})){fs.writeFileSync(${JSON.stringify(countFile)},'1');console.log('${'a'.repeat(64)}');}\n`,{mode:0o755});
  process.env.PATH=bin+path.delimiter+prior;
  const requestFile=path.join(root,'request.json');fs.writeFileSync(requestFile,JSON.stringify({schema:'kontour.kit.execution_request',version:'1.0',kit_id:'custody',engine_sandbox:{image:'mock-image'},execution:{timeout_s:5}}));
  await assert.rejects(executeInstalledKit({kitId:'custody',dest,requestFile,controllerRoot:root}),/left owned workers running/);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.ok(calls[0].includes('--filter'));assert.match(calls[0].at(-1),/^label=kontour.worker.owner=/);assert.equal(calls[1][0],'rm');assert.equal(calls[2][0],'ps');
 }finally{process.env.PATH=prior;fs.rmSync(root,{recursive:true,force:true});}
});
test('public kit CLI maps ordinary failed and waiting results to the observed process exit',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'entry-exits-')),source=path.join(root,'kit'),dest=path.join(root,'dest');fs.mkdirSync(source);fs.mkdirSync(dest);
 try{
  fs.writeFileSync(path.join(source,'kit.json'),JSON.stringify({schema_version:'1.0',id:'outcomes',name:'Outcomes',flows:[{id:'outcomes.check',path:'check.flow.json'}],execution:descriptor}));
  fs.writeFileSync(path.join(source,'check.flow.json'),JSON.stringify({id:'outcomes.check',version:'1',steps:[{id:'check',next:null}],gates:{}}));
  const requestFile=path.join(root,'request.json');fs.writeFileSync(requestFile,JSON.stringify({schema:'kontour.kit.execution_request',version:'1.0',kit_id:'outcomes',execution:{timeout_s:5}}));
  for(const [status,expected]of [['failed',1],['cancelled',1],['budget_exhausted',1],['unknown',1],['waiting',0],['completed',0]]){
   fs.writeFileSync(path.join(source,'entry.mjs'),`export async function execute(){return ${JSON.stringify({schema:'kontour.kit.execution_result',version:'1.0',kit_id:'outcomes',status})};}`);
   const install=spawnSync(process.execPath,[CLI,'kit','install',source,'--dest',dest,'--update'],{encoding:'utf8'});assert.equal(install.status,0,install.stderr);
   const run=spawnSync(process.execPath,[CLI,'kit','run','outcomes','--dest',dest,'--request',requestFile,'--controller-root',path.join(root,'private')],{encoding:'utf8'});
   assert.equal(run.status,expected,`${status}: ${run.stderr}`);assert.equal(JSON.parse(run.stdout).status,status);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

async function transportFixture(t,entry){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'entry-result-transport-')),source=path.join(root,'kit'),dest=path.join(root,'dest'),requestFile=path.join(root,'request.json');fs.mkdirSync(source);fs.mkdirSync(dest);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(source,'kit.json'),JSON.stringify({schema_version:'1.0',id:'transport',name:'Transport',flows:[{id:'transport.check',path:'check.flow.json'}],execution:descriptor}));
 fs.writeFileSync(path.join(source,'check.flow.json'),JSON.stringify({id:'transport.check',version:'1',steps:[{id:'check',next:null}],gates:{}}));
 fs.writeFileSync(path.join(source,'entry.mjs'),entry);
 const install=spawnSync(process.execPath,[CLI,'kit','install',source,'--dest',dest],{encoding:'utf8'});assert.equal(install.status,0,install.stderr);
 fs.writeFileSync(requestFile,JSON.stringify({schema:'kontour.kit.execution_request',version:'1.0',kit_id:'transport',execution:{timeout_s:5}}));
 return {root,dest,requestFile,execute:()=>executeInstalledKit({kitId:'transport',dest,requestFile,controllerRoot:root}),run:()=>spawnSync(process.execPath,[CLI,'kit','run','transport','--dest',dest,'--request',requestFile,'--controller-root',root],{encoding:'utf8',timeout:15000,maxBuffer:16*1024*1024})};
}

test('ordinary installed API and CLI preserve multi-megabyte waiting results exactly',async t=>{
 const f=await transportFixture(t,`export async function execute(){return {status:'waiting',data:'0123456789abcdef'.repeat(512*1024),tail:'complete-terminal-result'};}`);
 const result=await f.execute();assert.equal(result.status,'waiting');assert.equal(result.data.length,8*1024*1024);assert.equal(result.data,'0123456789abcdef'.repeat(512*1024));assert.equal(result.tail,'complete-terminal-result');
 const cli=f.run();assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),result);
});

test('ordinary installed error transport preserves a large error before observed process failure',async t=>{
 const f=await transportFixture(t,`export async function execute(){throw new Error('large-error:'+ 'x'.repeat(2*1024*1024)+':terminal-error');}`);
 await assert.rejects(f.execute(),error=>error.message==='large-error:'+'x'.repeat(2*1024*1024)+':terminal-error');
 const cli=f.run();assert.equal(cli.status,70);assert.ok(cli.stderr.includes('large-error:'+'x'.repeat(2*1024*1024)+':terminal-error\n')); assert.equal(cli.stdout,'');
});

test('wrong invocation and duplicate terminal messages cannot replace a kit result',async t=>{
 for(const mode of ['wrong-invocation','duplicate']){
  const f=await transportFixture(t,`export async function execute(){process.send({kind:'result',deliveryId:${mode==='duplicate'?'process.argv[5]':"'foreign-invocation'"},result:{status:'completed'}});return {status:'waiting'};}`);
  await assert.rejects(f.execute(),/terminal envelope is invalid or duplicated/);
 }
});

test('an entry that disconnects before result delivery fails rather than synthesizing completion',async t=>{
 const f=await transportFixture(t,`export async function execute(){process.disconnect();return {status:'completed',data:'x'.repeat(1024*1024)};}`);
 await assert.rejects(f.execute(),/IPC is disconnected|IPC disconnected before acknowledgement/);
});

test('an unmatched acknowledgement never releases the child result handshake',async t=>{
 const {fork}=await import('node:child_process');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'child-result-ack-')),entry=path.join(root,'entry.mjs');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(entry,`export async function execute(){return {status:'waiting',data:'x'.repeat(192*1024)};}`);
 const child=fork(path.resolve('build/src/kit-execution-child.js'),[entry,'execute',JSON.stringify({executionOwner:'fixture-worker-custody'}),'expected-delivery'],{stdio:['ignore','ignore','pipe','ipc'],execArgv:[]});let exited=false;const closed=new Promise(resolve=>child.once('close',resolve));child.once('exit',()=>{exited=true;});
 try{
  const outcome=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});assert.equal(outcome.deliveryId,'expected-delivery');assert.equal(outcome.result.data.length,192*1024);
  await new Promise((resolve,reject)=>child.send({kind:'outcome-ack',deliveryId:'unmatched-delivery'},error=>error?reject(error):resolve()));
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(exited,false,'Only the matching parent acknowledgement may settle delivery');
  await new Promise((resolve,reject)=>child.send({kind:'outcome-ack',deliveryId:'expected-delivery'},error=>error?reject(error):resolve()));assert.equal(await closed,0);
 }finally{if(!exited)child.kill('SIGKILL');await closed;}
});

test('inherited descendant stderr does not postpone completion after the kit host exits',async t=>{
 const f=await transportFixture(t,`import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';export async function execute({controllerRoot}){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore',2]});fs.writeFileSync(path.join(controllerRoot,'descendant-pid'),String(child.pid));child.unref();return {status:'waiting'};}`);
 let descendant;
 try{const started=Date.now();assert.equal((await f.execute()).status,'waiting');assert.ok(Date.now()-started<4000,'Completion must not wait on a descendant stderr pipe after observed host exit');descendant=Number(fs.readFileSync(path.join(f.root,'descendant-pid'),'utf8'));assert.ok(Number.isSafeInteger(descendant)&&descendant>1);}
 finally{if(descendant===undefined&&fs.existsSync(path.join(f.root,'descendant-pid')))descendant=Number(fs.readFileSync(path.join(f.root,'descendant-pid'),'utf8'));if(descendant)try{process.kill(descendant,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
});

test('parent disconnection before acknowledgement makes the child fail without retrying IPC',async t=>{
 const {fork}=await import('node:child_process');const root=fs.mkdtempSync(path.join(os.tmpdir(),'child-result-disconnected-')),entry=path.join(root,'entry.mjs');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(entry,`export async function execute(){return {status:'waiting',data:'x'.repeat(1024*1024)};}`);
 const child=fork(path.resolve('build/src/kit-execution-child.js'),[entry,'execute','{}','disconnected-delivery'],{stdio:['ignore','ignore','pipe','ipc'],execArgv:[]});let stderr='',exited=false;child.stderr.on('data',chunk=>{stderr+=chunk;});child.once('exit',()=>{exited=true;});const closed=new Promise(resolve=>child.once('exit',resolve));
 try{await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});child.disconnect();assert.equal(await closed,1);assert.match(stderr,/IPC disconnected before acknowledgement/);}
 finally{if(!exited)child.kill('SIGKILL');await closed;}
});

test('an observed child exit cannot outrun the parent acknowledgement delivery callback',async t=>{
 const {default:childProcess}=await import('node:child_process'),{syncBuiltinESMExports}=await import('node:module'),original=childProcess.fork;
 for(const failure of [false,true]){
  const f=await transportFixture(t,`export async function execute(){return {status:'waiting'};}`);
  let callbackRan=false;
  childProcess.fork=(...args)=>{
   const child=original(...args),send=child.send.bind(child);
   child.send=(message,...sendArgs)=>{
    if(message?.kind!=='outcome-ack')return send(message,...sendArgs);
    const callback=sendArgs.pop();sendArgs.push(error=>setTimeout(()=>{callbackRan=true;callback(failure?new Error('Injected ACK delivery failure after observed exit'):error);},100));
    return send(message,...sendArgs);
   };
   return child;
  };
  syncBuiltinESMExports();
  try{const execution=f.execute();if(failure)await assert.rejects(execution,/Injected ACK delivery failure after observed exit/);else assert.equal((await execution).status,'waiting');assert.equal(callbackRan,true,'A result must wait for the parent delivery callback as well as actual process exit');}
  finally{childProcess.fork=original;syncBuiltinESMExports();}
 }
});
