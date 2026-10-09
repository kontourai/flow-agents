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
  fs.writeFileSync(requestFile,JSON.stringify({schema:'kontour.kit.execution_request',version:'1.0',kit_id:'other'}));await assert.rejects(executeInstalledKit({kitId:'portable',dest,requestFile,controllerRoot:root}),/Request must bind/);
  fs.appendFileSync(path.join(dest,'kits/local/repositories/portable/entry.mjs'),'\n// drift');await assert.rejects(executeInstalledKit({kitId:'portable',dest,requestFile,controllerRoot:root}),/integrity refused/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('descriptor excludes traversal and missing execution exports',()=>{
 for(const module of ['../entry.mjs','/tmp/entry.mjs','sub/../entry.mjs','sub\\entry.mjs'])assert.throws(()=>parseKitExecution({execution:{...descriptor,module}}));
 assert.throws(()=>parseKitExecution({execution:{...descriptor,export:'bad-name'}}));
});
