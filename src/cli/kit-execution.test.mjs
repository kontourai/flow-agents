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
