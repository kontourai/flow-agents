import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveDockerWorkerNetwork,verifyDockerWorkerNetwork} from '../docker-worker.mjs';
const id='a'.repeat(64), replacement='b'.repeat(64);
const record={Name:'private-workers',Id:id,Driver:'bridge',Scope:'local'};
test('bridge and none retain their existing mode without daemon resolution',()=>{
 for(const mode of ['bridge','none'])assert.deepEqual(resolveDockerWorkerNetwork(mode,{command:()=>{throw new Error('unexpected inspect');}}),{requested:mode,mode,id:null});
});
test('named bridge uses observed immutable ID, never the mutable name',()=>{
 const admission=resolveDockerWorkerNetwork('private-workers',{command:argv=>{assert.deepEqual(argv,['docker','network','inspect','private-workers']);return JSON.stringify([record]);}});
 assert.deepEqual(admission,{requested:'private-workers',mode:id,id});
 for(const NetworkID of [id,''])verifyDockerWorkerNetwork({HostConfig:{NetworkMode:id},NetworkSettings:{Networks:{'private-workers':{NetworkID}}}},admission);
});
test('network admission refuses special modes, malformed inputs and unsupported drivers',()=>{
 for(const name of ['host','default','container:abc','-flag','bad/name','',null])assert.throws(()=>resolveDockerWorkerNetwork(name,{command:()=>{throw new Error('inspect must not run');}}));
 for(const value of [[],[record,record],[{...record,Driver:'overlay'}],[{...record,Driver:'macvlan'}],[{...record,Driver:'host'}],[{...record,Scope:'swarm'}],[{...record,Id:'short'}],[{...record,Name:'replacement'}]])assert.throws(()=>resolveDockerWorkerNetwork('private-workers',{command:()=>JSON.stringify(value)}));
 assert.throws(()=>resolveDockerWorkerNetwork('missing',{command:()=>{throw new Error('No such network');}}),/No such network/);
});
test('created container must retain admitted mode and exactly one matching attachment',()=>{
 const admission={requested:'private-workers',mode:id,id};
 for(const inspected of [
  {HostConfig:{NetworkMode:'private-workers'},NetworkSettings:{Networks:{one:{NetworkID:id}}}},
  {HostConfig:{NetworkMode:id},NetworkSettings:{Networks:{'private-workers':{NetworkID:replacement}}}},
  {HostConfig:{NetworkMode:id},NetworkSettings:{Networks:{'private-workers':{NetworkID:id},two:{NetworkID:replacement}}}},
  {HostConfig:{NetworkMode:id}},
 ])assert.throws(()=>verifyDockerWorkerNetwork(inspected,admission),/network (mode|attachment) mismatch/);
 for(const mode of ['bridge','none'])assert.throws(()=>verifyDockerWorkerNetwork({HostConfig:{NetworkMode:'host'}},{mode,id:null}),/network mode mismatch/);
});

test('worker creates by ID and removes a replaced attachment without starting a model',async()=>{
 const {mkdtemp,mkdir,writeFile,readFile,chmod,rm,realpath}=await import('node:fs/promises');
 const {default:os}=await import('node:os');const {default:path}=await import('node:path');
 const {runCodexDockerWorker}=await import('../docker-worker.mjs');
 const {DEFAULT_STORAGE}=await import('../storage-admission.mjs');
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'named-worker-network-'))),originalPath=process.env.PATH;
 try{
  const workspace=path.join(root,'workspace'),sourceRoot=path.join(root,'source'),artifactRoot=path.join(root,'artifacts'),contextFile=path.join(root,'context.json');
  for(const dir of [workspace,sourceRoot,artifactRoot])await mkdir(dir);
  await writeFile(contextFile,'{}');
  const callsFile=path.join(root,'calls'),fake=path.join(root,'docker'),container='c'.repeat(64);
  await writeFile(fake,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(args)+'\\n');if(args[0]==='network')console.log(${JSON.stringify(JSON.stringify([record]))});else if(args[0]==='info')console.log('[]');else if(args[0]==='create')console.log('${container}');else if(args[0]==='inspect')console.log(JSON.stringify([{HostConfig:{NetworkMode:'${id}'},NetworkSettings:{Networks:{'private-workers':{NetworkID:'${replacement}'}}}}]));else if(args[0]==='start')process.exit(99);\n`);
  await chmod(fake,0o755);process.env.PATH=root+path.delimiter+originalPath;
  await assert.rejects(runCodexDockerWorker({image:'sha256:'+id,workspace,sourceRoot,artifactRoot,contextFile,network:'private-workers',model:'no-model',timeoutMs:1000,runId:'network-test',invocationId:'network-test',providerProxy:{baseUrl:'http://host.docker.internal:9999',capability:'d'.repeat(64),model:'no-model'},storageBudget:{...DEFAULT_STORAGE,roots:[workspace,artifactRoot],min_free_bytes:0}}),/attachment mismatch/);
  const calls=(await readFile(callsFile,'utf8')).trim().split('\n').map(JSON.parse),create=calls.find(args=>args[0]==='create');
  assert.equal(create[create.indexOf('--network')+1],id);
  assert.equal(calls.some(args=>args[0]==='start'),false);
  assert.deepEqual(calls.at(-1),['rm','-f',container]);
 }finally{process.env.PATH=originalPath;await rm(root,{recursive:true,force:true});}
});
