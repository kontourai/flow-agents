import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseHostSetup,doctorKitSetup,resolveKitAuth,resolveKitConnection,resolveKitNativeEnvironment,resolveKitModel,createKitRequest,writeKitRequest} from '../../build/src/kit-setup.js';
import {listEngineProfiles} from '../../build/src/engine-host.js';
const native={engine:'codex',provider:'codex',model:'example-model',auth:{mode:'native'},isolation:'trusted-host',host_access_granted:true};
test('setup doctor probes the same executable admitted by every native engine profile',()=>{
 for(const profile of listEngineProfiles()){
  const calls=[];const checks=doctorKitSetup({...native,engine:profile.id},{probe:(binary,args)=>{calls.push([binary,args]);return binary===profile.executable;}});
  assert.equal(checks.find(check=>check.id==='engine-installed').status,'PASS');assert.deepEqual(calls[0],[profile.executable,['--version']]);
 }
});
test('native auth checks engine status without reading assumed auth file or emitting native output',()=>{
 const calls=[];const checks=doctorKitSetup(native,{probe:(b,a)=>{calls.push([b,a]);return true;}});
 assert.equal(checks.find(c=>c.id==='native-auth').status,'PASS');assert.deepEqual(calls,[['codex',['--version']],['codex',['login','status']]]);
 const absent=doctorKitSetup(native,{probe:()=>false});assert.equal(absent[1].status,'FAIL');assert.match(absent[1].action,/device-auth/);
 assert.equal(doctorKitSetup({...native,engine:'kiro'},{probe:()=>true})[1].status,'NOT_VERIFIED');
});
test('Datum reference availability never materializes a secret; host resolution selects only referenced backend',()=>{
 let reads=0;const runner={keychainAvailable:()=>false,opAvailable:()=>true,readKeychain:()=>{reads++;return 'private-key';},readOp:()=>{reads++;return 'private-key';}};
 const host=parseHostSetup({...native,auth:{mode:'secret-ref',ref:{op:'op://Private/provider/key'}}});
 const checks=doctorKitSetup(host,{probe:()=>true,secretRunner:runner});assert.equal(reads,0);assert.equal(checks[1].status,'PASS');assert.equal(checks[2].status,'NOT_VERIFIED');assert.ok(!JSON.stringify(checks).includes('private-key'));
 assert.equal(resolveKitAuth(host.auth,{secretRunner:runner}),'private-key');assert.equal(reads,1);
 const env=doctorKitSetup({...native,auth:{mode:'secret-ref',ref:{env:'TEST_PROVIDER_KEY'}}},{probe:()=>true,env:{TEST_PROVIDER_KEY:'private-key'}});assert.equal(env[1].status,'PASS');assert.ok(!JSON.stringify(env).includes('private-key'));
 assert.equal(doctorKitSetup({...native,auth:{mode:'secret-ref',ref:{keychain:{service:'test'}}}},{probe:()=>true,secretRunner:runner})[1].status,'FAIL');
});
test('Datum provider model selection preserves original secret reference without materialization',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'setup-datum-'));try{fs.mkdirSync(path.join(root,'.datum'));fs.writeFileSync(path.join(root,'.datum/config.json'),JSON.stringify({providers:{setup_fixture:{kind:'openai-compatible',models:['example-model'],auth:{env:'SETUP_TEST_KEY'}}}}));assert.deepEqual(resolveKitModel('example-model@setup_fixture',root),{model:'example-model',provider:'setup_fixture',auth:{mode:'secret-ref',ref:{env:'SETUP_TEST_KEY'}}});assert.throws(()=>resolveKitModel('example-model@missing_setup_fixture',root));}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('configured host connection preserves endpoint/auth authority and native environment uses Datum Claude adapter',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'setup-connection-'));try{fs.mkdirSync(path.join(root,'.datum'));const file=path.join(root,'.datum/config.json'),config={providers:{test_anthropic:{kind:'anthropic-compatible',baseUrl:'https://provider.example.test',models:['example-model'],auth:{env:'TEST_ANTHROPIC_KEY'}}}};fs.writeFileSync(file,JSON.stringify(config));const host={...native,engine:'claude',provider:'test_anthropic',auth:{mode:'secret-ref',ref:{env:'TEST_ANTHROPIC_KEY'}}};const env={TEST_ANTHROPIC_KEY:'private-value'};const connection=resolveKitConnection(host,{cwd:root,env});assert.equal(connection.kind,'anthropic-compatible');assert.equal(connection.baseUrl,'https://provider.example.test');assert.ok(!JSON.stringify(connection).includes('private-value'));assert.deepEqual(resolveKitNativeEnvironment(host,{cwd:root,env}),{ANTHROPIC_MODEL:'example-model',ANTHROPIC_BASE_URL:'https://provider.example.test',ANTHROPIC_API_KEY:'private-value'});assert.throws(()=>resolveKitNativeEnvironment({...host,engine:'kiro'},{cwd:root,env}),/unavailable/);config.providers.test_anthropic.auth={env:'CHANGED_TEST_KEY'};fs.writeFileSync(file,JSON.stringify(config));assert.throws(()=>resolveKitConnection(host,{cwd:root,env}),/changed/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('unsupported auth and Docker/native combinations fail closed',()=>{
 for(const value of [{...native,engine:'unknown'},{...native,isolation:'docker'},{...native,engine:'claude',auth:{mode:'codex-file',file:'/tmp/auth'}},{...native,auth:{mode:'secret-ref',ref:{env:'TEST_KEY',password:'secret'}}},{...native,auth:{mode:'native',token:'secret'}}])assert.throws(()=>parseHostSetup(value));
});
test('Docker preflight checks daemon and local image without requiring a native host binary',()=>{
 const calls=[],image='sha256:'+'a'.repeat(64),host={...native,provider:'openai',isolation:'docker',auth:{mode:'secret-ref',ref:{env:'TEST_PROVIDER_KEY'}}};const checks=doctorKitSetup(host,{env:{TEST_PROVIDER_KEY:'private'},image,probe:(b,a)=>{calls.push([b,a]);return true;}});assert.equal(checks[0].status,'NOT_VERIFIED');assert.equal(checks.find(c=>c.id==='worker-image').status,'PASS');assert.deepEqual(calls,[['docker',['info']],['docker',['image','inspect',image]]]);assert.equal(doctorKitSetup(host,{env:{},probe:()=>true}).find(c=>c.id==='worker-image').status,'FAIL');
});
test('Codex private file cache readiness is distinct from provider authorization',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'setup-auth-'));try{const file=path.join(root,'auth.json'),host={...native,provider:'openai',auth:{mode:'codex-file',file}};assert.equal(doctorKitSetup(host,{probe:()=>true})[1].status,'FAIL');fs.writeFileSync(file,JSON.stringify({tokens:{access_token:'private-token'}}),{mode:0o600});const checks=doctorKitSetup(host,{probe:()=>true});assert.equal(checks[1].status,'PASS');assert.equal(checks[2].status,'NOT_VERIFIED');assert.ok(!JSON.stringify(checks).includes('private-token'));const expired='eyJhbGciOiJub25lIn0.'+Buffer.from(JSON.stringify({exp:1})).toString('base64url')+'.signature';fs.writeFileSync(file,JSON.stringify({tokens:{access_token:expired}}));assert.equal(doctorKitSetup(host,{probe:()=>true})[1].status,'FAIL');fs.writeFileSync(file,JSON.stringify({tokens:{access_token:'private-token'}}));if(process.platform!=='win32'){fs.chmodSync(file,0o644);assert.equal(doctorKitSetup(host,{probe:()=>true})[1].status,'FAIL');}}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('first run creates bound secret-free request, refuses cross-identity, symlink-private escape, budgets and drift',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kit-setup-'));try{
 const source=path.join(root,'source'),dest=path.join(root,'dest'),workspace=path.join(root,'workspace');for(const p of [source,dest,workspace])fs.mkdirSync(p);
 fs.writeFileSync(path.join(source,'kit.json'),JSON.stringify({schema_version:'1.0',id:'portable',name:'Portable',flows:[{id:'portable.check',path:'check.flow.json'}],execution:{module:'entry.mjs',export:'execute',contract:'kontour.kit.execution_request@1.0'}}));
 fs.writeFileSync(path.join(source,'check.flow.json'),JSON.stringify({id:'portable.check',version:'1',steps:[{id:'check',next:null}],gates:{}}));fs.writeFileSync(path.join(source,'entry.mjs'),'export async function execute(){return {status:"completed"}}');
 const install=spawnSync(process.execPath,['build/src/cli.js','kit','install',source,'--dest',dest],{encoding:'utf8'});assert.equal(install.status,0,install.stderr);
 const options={kitId:'portable',dest,workspace,controllerRoot:path.join(root,'private'),host:native,prompt:'Build a portable project'};
 assert.throws(()=>createKitRequest({...options,host:{...native,host_access_granted:false}}),/allow-host-execution/);
 const dry=spawnSync(process.execPath,['build/src/cli.js','kit','setup','portable','--dest',dest,'--workspace',workspace,'--controller-root',path.join(root,'private'),'--engine','codex','--model','example-model','--auth','native','--allow-host-execution','--prompt','Build a portable project','--dry-run'],{encoding:'utf8'});assert.ok([0,1].includes(dry.status),dry.stderr);const preview=JSON.parse(dry.stdout);assert.equal(preview.dry_run,true);assert.equal(preview.request.host_setup.host_access_granted,true);
 const request=createKitRequest(options);assert.equal(request.kit_id,'portable');assert.equal(request.execution.engine,'codex');assert.equal(request.host_setup.auth.mode,'native');assert.equal(request.parameters.constructor,Object);
 const multiline='Build an offline inventory library.\nRequirements:\r\n\t- Preserve Unicode: café and 🧭.\n';
 assert.equal(createKitRequest({...options,prompt:multiline}).prompt,multiline);
 assert.equal(createKitRequest({...options,prompt:'x'.repeat(1_048_576)}).prompt.length,1_048_576);
 for(const prompt of [null,42,'',' \t\r\n','x'.repeat(1_048_577),'é'.repeat(524_289),'bad\0text','bad\u001btext','bad\u000btext','bad\u007ftext','bad\u0085text','bad\u202etext','bad\u200btext'])assert.throws(()=>createKitRequest({...options,prompt}),/Valid prompt required/);
 assert.throws(()=>createKitRequest({...options,runId:'bad\nidentifier'}),/Valid run id required/);
 const setupArgs=['build/src/cli.js','kit','setup','portable','--dest',dest,'--workspace',workspace,'--controller-root',path.join(root,'private'),'--engine','codex','--model','example-model','--auth','native','--allow-host-execution'];
 const multilineOutput=path.join(root,'multiline-request.json');
 const created=spawnSync(process.execPath,[...setupArgs,'--prompt',multiline,'--output',multilineOutput],{encoding:'utf8'});
 assert.equal(created.status,0,created.stderr);assert.equal(JSON.parse(fs.readFileSync(multilineOutput,'utf8')).prompt,multiline);
 const rejectedOutput=path.join(root,'rejected-request.json');
 const rejected=spawnSync(process.execPath,[...setupArgs,'--prompt','bad\u001btext','--output',rejectedOutput],{encoding:'utf8'});
 assert.equal(rejected.status,2,rejected.stderr);assert.match(rejected.stderr,/Valid prompt required/);assert.equal(fs.existsSync(rejectedOutput),false);
 const output=path.join(root,'request.json');writeKitRequest(output,request);assert.throws(()=>writeKitRequest(output,request));
 if(process.platform!=='win32')assert.equal(fs.statSync(output).mode&0o777,0o600);
 for(const change of [{template:{kit_id:'other'}},{parameters:{api_key:'private'}},{maxProviderRequests:Infinity},{controllerRoot:path.join(workspace,'controller')}])assert.throws(()=>createKitRequest({...options,...change}));
 const link=path.join(root,'private-link');fs.symlinkSync(workspace,link);assert.throws(()=>createKitRequest({...options,controllerRoot:path.join(link,'nested')}));
 fs.appendFileSync(path.join(dest,'kits/local/repositories/portable/entry.mjs'),'\n// drift');assert.throws(()=>createKitRequest(options),/integrity/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('worker image preparation uses packaged generic context and records observed immutable image',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'setup-image-'));try{const bin=path.join(root,'docker'),log=path.join(root,'argv.jsonl');fs.writeFileSync(bin,`#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='image')console.log('sha256:'+'a'.repeat(64));`,{mode:0o755});const result=spawnSync(process.execPath,['build/src/cli.js','kit','prepare-worker','--codex-version','1.2.3'],{encoding:'utf8',env:{...process.env,PATH:root+path.delimiter+process.env.PATH}});assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.image,'sha256:'+'a'.repeat(64));const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls[0][0],'build');assert.ok(calls[0].includes('CODEX_VERSION=1.2.3'));assert.ok(calls[0].at(-1).endsWith('integrations/codex-host/worker/'));assert.deepEqual(calls[1],['image','inspect','--format','{{.Id}}','kontour-codex-worker:1.2.3']);assert.equal(spawnSync(process.execPath,['build/src/cli.js','kit','prepare-worker','--codex-version','latest'],{encoding:'utf8'}).status,2);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
