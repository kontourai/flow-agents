import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseCodexEvents,dockerHostGatewayArgs} from '../docker-worker.mjs';
import {startProviderProxy} from '../provider-broker.mjs';
import {DEFAULT_STORAGE,inspectStorage,admitStorage} from '../storage-admission.mjs';

test('Docker host gateway mapping is Linux-only and defaults to the host platform',()=>{
 assert.deepEqual(dockerHostGatewayArgs('linux'),['--add-host','host.docker.internal:host-gateway']);
 for(const platform of ['darwin','win32'])assert.deepEqual(dockerHostGatewayArgs(platform),[]);
 assert.deepEqual(dockerHostGatewayArgs(),dockerHostGatewayArgs(process.platform));
});

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

test('mock Docker observations bind explicit mount boundaries and owner labels',async()=>{
 const {chmod,mkdir,readFile,realpath}=await import('node:fs/promises');
 const {runCodexDockerWorker}=await import('../docker-worker.mjs');
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'mock-host-worker-')));const original=process.env.PATH;
 try{
  const workspace=path.join(root,'workspace'),sourceRoot=path.join(root,'kit'),artifactRoot=path.join(root,'receipts'),controller=path.join(root,'controller'),oracle=path.join(root,'oracle');
  for(const dir of [workspace,sourceRoot,artifactRoot,controller,oracle])await mkdir(dir);
  const contextFile=path.join(root,'context.json');await writeFile(contextFile,'{}');
  const image='sha256:'+'a'.repeat(64),container='b'.repeat(64),owner='11111111-2222-3333-4444-555555555555';
  const mounts=[{Destination:'/workspace',Source:workspace,RW:true},{Destination:'/treatment',Source:sourceRoot,RW:false},{Destination:'/context/request.json',Source:contextFile,RW:false}];
  const extraHostsFile=path.join(root,'extra-hosts.json');
  const nativeExtraHosts=process.platform==='linux'?['host.docker.internal:host-gateway']:null;
  await writeFile(extraHostsFile,JSON.stringify(nativeExtraHosts));
  const fake=path.join(root,'docker');await writeFile(fake,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(root,'calls'))},JSON.stringify(args)+'\\n');if(args[0]==='create')console.log('${container}');else if(args[0]==='inspect')console.log(JSON.stringify([{Image:'${image}',Mounts:${JSON.stringify(mounts)},HostConfig:{Privileged:false,ReadonlyRootfs:true,NetworkMode:'bridge',ExtraHosts:JSON.parse(fs.readFileSync(${JSON.stringify(extraHostsFile)},'utf8'))}}]));else if(args[0]==='start')console.log(${JSON.stringify([{type:'thread.started',thread_id:'mock-thread'},{type:'turn.started'},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}].map(x=>JSON.stringify(x)).join('\n'))});else if(args[0]==='run')console.log(args.includes('--version')?'codex-cli mocked':'${'c'.repeat(64)} mocked');\n`);await chmod(fake,0o755);process.env.PATH=root+path.delimiter+original;
  const options={image,workspace,sourceRoot,contextFile,artifactRoot,model:'mock',timeoutMs:1000,runId:'mock-run',ownerId:owner,providerProxy:{baseUrl:'http://host.docker.internal:9999',capability:'d'.repeat(64),model:'mock'},storageBudget:{...DEFAULT_STORAGE,roots:[workspace,artifactRoot],min_free_bytes:0}};
  const unknown=await runCodexDockerWorker({...options,invocationId:'unknown'});assert.equal(unknown.observed.controller_mounted,null);assert.equal(unknown.observed.hidden_oracles_mounted,null);assert.deepEqual(unknown.observed.extra_hosts,nativeExtraHosts);
  const checked=await runCodexDockerWorker({...options,invocationId:'checked',forbiddenMountRoots:[{kind:'controller',path:controller},{kind:'hidden-oracle',path:oracle}]});assert.equal(checked.observed.controller_mounted,false);assert.equal(checked.observed.execution_owner,owner);
  await assert.rejects(runCodexDockerWorker({...options,invocationId:'overlap',forbiddenMountRoots:[{kind:'hidden-oracle',path:sourceRoot}]}),/forbidden root/);
  await writeFile(extraHostsFile,JSON.stringify(['host.docker.internal:host-gateway']));
  const linux=await runCodexDockerWorker({...options,invocationId:'linux',platform:'linux'});
  assert.deepEqual(linux.observed.extra_hosts,['host.docker.internal:host-gateway']);
  for(const [invocationId,extraHosts]of [['missing-gateway',null],['wrong-gateway',['other.internal:host-gateway']]]){
   await writeFile(extraHostsFile,JSON.stringify(extraHosts));
   await assert.rejects(runCodexDockerWorker({...options,invocationId,platform:'linux'}),/host gateway mapping missing/);
  }
  await writeFile(extraHostsFile,'null');
  const mac=await runCodexDockerWorker({...options,invocationId:'mac',platform:'darwin'});
  assert.equal(mac.observed.extra_hosts,null);
  const calls=(await readFile(path.join(root,'calls'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const creates=calls.filter(args=>args[0]==='create');
  for(const name of ['linux','missing-gateway','wrong-gateway']){
   const args=creates.find(args=>args.includes('kontour-worker-'+name));
   assert.equal(args[args.indexOf('--add-host')+1],'host.docker.internal:host-gateway');
  }
  assert.equal(creates.find(args=>args.includes('kontour-worker-mac')).includes('--add-host'),false);
  assert.equal(creates[0].includes('--add-host'),process.platform==='linux');
  // Rejected inspection must remove the container without starting a model turn.
  assert.equal(calls.filter(args=>args[0]==='start').length,4);
  assert.equal(calls.filter(args=>args[0]==='rm').length,7);
  assert.ok(creates.every(args=>args.includes('kontour.worker.owner='+owner)));
 }finally{process.env.PATH=original;await rm(root,{recursive:true,force:true});}
});
