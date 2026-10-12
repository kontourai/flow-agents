import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {bindReviewQueue,buildReviewSessionEvents} from '@kontourai/survey/review-workbench';
import {openInstalledKitReview,parseKitReview,serveSurveyReview} from '../../build/src/kit-review.js';
const descriptor={contract:'kontour.kit.review_request@1.0',module:'review.mjs',export:'prepareKitReview'};
function session(root){
  const item = {
    apiVersion: "survey.kontourai.io/v1alpha1",
    kind: "ReviewItem",
    metadata: { name: "gate-review-item" },
    spec: {
      target: "quality.review",
      candidateSetStatus: "conflict",
      candidates: [{
        id: "candidate.accepted",
        role: "proposed",
        value: "accepted",
        source: {
          sourceId: "source.review",
          sourceRef: "review://server/gate-review-item",
          kind: "manual-entry",
          observedAt: '2026-10-12T00:00:00Z',
          locatorScheme: "structured-field",
        },
        extraction: {
          extractionId: "extraction.review",
          target: "quality.review",
          extractor: "survey-gate-test",
          extractedAt: '2026-10-12T00:00:00Z',
        },
        locator: {
          scheme: "structured-field",
        },
        claimTarget: {
          claimId: "claim.review",
          subjectType: "work-item",
          subjectId: 'fixture',
          facet: "quality",
          claimType: "quality.review",
          fieldOrBehavior: "review acceptance",
          impactLevel: "high",
          collectedBy: "survey-gate-test",
        },
        projection: {
          rawSourceId: "source.review",
          extractionId: "extraction.review",
          candidateSetId: "candidate-set.review",
          candidateId: "candidate.accepted",
          reviewOutcomeId: "review.accepted",
          claimId: "claim.review",
        },
      }],
    },
  };
 const snapshot={items:[item],activeItemName:item.metadata.name,decisionsByItemName:{[item.metadata.name]:'accept-proposed'},notesByItemName:{},actorId:'host-observed:fixture',reviewedAt:'2026-10-12T00:00:00Z'};
 const events=buildReviewSessionEvents(snapshot,'fixture');const sessionPath=path.join(root,'session.json');
 fs.writeFileSync(sessionPath,JSON.stringify({sessionName:'fixture',snapshot,events}));
 return {sessionPath,binding:bindReviewQueue(snapshot,{sessionName:'fixture'})};
}
async function apply(server){const s=await (await fetch(server.url+'api/session')).json();return fetch(server.url+'api/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseRevision:s.revision})});}
function fixture(execution=false){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-kit-review-'));const source=path.join(root,'source'),dest=path.join(root,'dest');fs.mkdirSync(source);fs.mkdirSync(dest);
 fs.writeFileSync(path.join(source,'kit.json'),JSON.stringify({schema_version:'1.0',id:'review-fixture',name:'Review fixture',flows:[{id:'review-fixture.review',path:'review.flow.json'}],review:descriptor,...(execution?{execution:{contract:'kontour.kit.execution_request@1.0',module:'review.mjs',export:'execute'}}:{})}));
 fs.writeFileSync(path.join(source,'review.flow.json'),JSON.stringify({id:'review-fixture.review',version:'1',steps:[{id:'review',next:null}],gates:{}}));
 fs.writeFileSync(path.join(source,'review.mjs'),`import fs from 'node:fs';export async function prepareKitReview({input,host}){if(input.requireAuthority&&!host?.resolveAuthority)throw new Error('Trusted authority resolver required');return {sessionPath:input.sessionPath,binding:input.binding,apply:async()=>{fs.writeFileSync(input.marker,'applied');return {reference:'fixture:decision'}}};}export async function execute(){return {status:'waiting'}}`);
 const installed=spawnSync(process.execPath,['build/src/cli.js','kit','install',source,'--dest',dest],{encoding:'utf8'});assert.equal(installed.status,0,installed.stdout+installed.stderr);
 const review=session(root),requestFile=path.join(root,'request.json'),marker=path.join(root,'applied');
 const request={schema:'kontour.kit.review_request',version:'1.0',kit_id:'review-fixture',input:{...review,marker}};fs.writeFileSync(requestFile,JSON.stringify(request));
 return {root,dest,requestFile,request,marker,options:{kitId:'review-fixture',dest,requestFile},modulePath:path.join(dest,'kits/local/repositories/review-fixture/review.mjs')};
}
for(const execution of [false,true])test(`native review serves and applies ${execution?'execution':'review-only'} installed kit`,async()=>{
 const f=fixture(execution);let server;try{server=await openInstalledKitReview(f.options);assert.equal((await fetch(server.url+'health')).status,200);const result=await apply(server);assert.equal(result.status,200,await result.text());assert.equal(fs.readFileSync(f.marker,'utf8'),'applied');assert.equal((await apply(server)).status,409);}finally{await server?.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
test('installed source drift while review is open refuses producer application',async()=>{
 const f=fixture();let server;try{server=await openInstalledKitReview(f.options);fs.appendFileSync(f.modulePath,'\n// drift');const refused=await apply(server);assert.equal(refused.status,409);assert.match((await refused.json()).error,/integrity refused/);assert.equal(fs.existsSync(f.marker),false);}finally{await server?.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
test('serialized capabilities and cross-kit requests are rejected before producer execution',async()=>{
 const f=fixture();try{await assert.rejects(openInstalledKitReview({...f.options,host:{resolveAuthority:'fake'}}),/trusted function/);for(const patch of [{host:{resolveAuthority:'fake'}},{kit_id:'other'}]){fs.writeFileSync(f.requestFile,JSON.stringify({...f.request,...patch}));await assert.rejects(openInstalledKitReview(f.options),/Request must bind/);}fs.writeFileSync(f.requestFile,JSON.stringify({...f.request,input:{...f.request.input,requireAuthority:true}}));await assert.rejects(openInstalledKitReview(f.options),/Trusted authority/);const server=await openInstalledKitReview({...f.options,host:{resolveAuthority:()=>({})}});await server.close();}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('review descriptor jail refuses traversal, symlinks, malformed exports and invalid ports',async()=>{
 for(const module of ['../x.mjs','/x.mjs','x/../y.mjs','x\\y.mjs','.git/x.mjs'])assert.throws(()=>parseKitReview({review:{...descriptor,module}}));assert.throws(()=>parseKitReview({review:{...descriptor,export:'bad-name'}}));assert.throws(()=>parseKitReview({review:{...descriptor,extra:true}}));
 const f=fixture();try{fs.writeFileSync(f.requestFile,' '.repeat(1048577));await assert.rejects(openInstalledKitReview(f.options),/1 MiB/);fs.unlinkSync(f.modulePath);fs.symlinkSync(path.join(f.root,'request.json'),f.modulePath);await assert.rejects(openInstalledKitReview(f.options));await assert.rejects(serveSurveyReview({...session(f.root),port:65536,apply:async()=>({reference:'x'})}),/port/);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('shared presentation refuses changed binding and retains callback failure without consumption',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-review-failure-'));let server;try{const prepared=session(root);server=await serveSurveyReview({...prepared,apply:async()=>{throw new Error('Domain admission refused')}});const refused=await apply(server);assert.equal(refused.status,409);assert.match((await refused.json()).error,/Domain admission refused/);assert.equal(JSON.parse(fs.readFileSync(prepared.sessionPath)).producerApplication,undefined);await server.close();server=await serveSurveyReview({...prepared,binding:{...prepared.binding,spec:{...prepared.binding.spec,snapshotHash:'forged'}},apply:async()=>({reference:'x'})});assert.equal((await apply(server)).status,409);}finally{await server?.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('registry provenance changes invalidate an open review even with identical source bytes',async()=>{
 const f=fixture();let server;try{server=await openInstalledKitReview(f.options);const file=path.join(f.dest,'kits/local/installed-kits.json');const registry=JSON.parse(fs.readFileSync(file));registry.kits[0].source='replacement://same-bytes';fs.writeFileSync(file,JSON.stringify(registry));const response=await apply(server);assert.equal(response.status,409);assert.match((await response.json()).error,/changed while review/);assert.equal(fs.existsSync(f.marker),false);}finally{await server?.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
test('long-lived SDK host refuses changed module caches after a supported kit update',async()=>{
 const f=fixture();let server;try{server=await openInstalledKitReview(f.options);await server.close();server=undefined;const source=path.join(f.root,'source');fs.appendFileSync(path.join(source,'review.mjs'),'\n// updated dependency identity');const updated=spawnSync(process.execPath,['build/src/cli.js','kit','install',source,'--dest',f.dest,'--update'],{encoding:'utf8'});assert.equal(updated.status,0,updated.stderr);await assert.rejects(openInstalledKitReview(f.options),/restart the review host/);}finally{await server?.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('native CLI prints only presentation coordinates and releases its own listener on SIGTERM',async()=>{
 const f=fixture();const child=spawn(process.execPath,['build/src/cli.js','kit','review','review-fixture','--dest',f.dest,'--request',f.requestFile,'--port','0'],{stdio:['ignore','pipe','pipe']});
 let url;const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try{const printed=await new Promise((resolve,reject)=>{let output='',error='';const timer=setTimeout(()=>reject(new Error('CLI startup timed out: '+error)),15000);child.stderr.on('data',chunk=>{error+=chunk});child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.split('\n')[0]));}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('CLI exited before startup: '+error));});});url=printed.url;assert.deepEqual(Object.keys(printed).sort(),['kitId','sessionPath','sourceHash','url']);assert.equal((await fetch(url+'health')).status,200);child.kill('SIGTERM');assert.deepEqual(await exited,{code:0,signal:null});await assert.rejects(fetch(url+'health'));}finally{if(child.exitCode===null)child.kill('SIGTERM');await exited;fs.rmSync(f.root,{recursive:true,force:true});}
});
