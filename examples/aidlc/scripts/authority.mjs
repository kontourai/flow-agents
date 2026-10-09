import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { digest, readSnapshot } from './compile.mjs';
import { readArtifact } from './artifacts.mjs';

/** Host policy grants are not model statements or human signatures. */
export function createControllerAuthority({policy,requestDigest,controllerRoot}){
  if(!policy||typeof policy.reference!=='string'||!policy.reference||!Array.isArray(policy.purposes))throw new Error('Explicit registered operator policy required');
  const authorityRoot=path.join(controllerRoot,'authority');fs.mkdirSync(authorityRoot,{recursive:true,mode:0o700});
  const keyFile=path.join(authorityRoot,'host-private-key.pem');let privateKey,publicKey;
  if(fs.existsSync(keyFile)){privateKey=createPrivateKey(fs.readFileSync(keyFile));publicKey=createPublicKey(privateKey);}
  else{({privateKey,publicKey}=generateKeyPairSync('ed25519'));fs.writeFileSync(keyFile,privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});}
  const fingerprint=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
  const issued=new Map();
  for(const name of fs.readdirSync(authorityRoot).filter(name=>name.endsWith('.json'))){const receipt=JSON.parse(fs.readFileSync(path.join(authorityRoot,name),'utf8'));if(receipt.payload?.issuer===fingerprint&&receipt.payload.request_digest===requestDigest&&verify(null,Buffer.from(JSON.stringify(receipt.payload)),publicKey,Buffer.from(receipt.signature,'base64')))issued.set(receipt.payload.id,receipt);}
  return {kind:'trusted-host-policy',fingerprint,
    async authorize(input){
      if(input.request_digest!==requestDigest||!policy.purposes.includes(input.purpose)||input.purpose==='deployment'&&policy.deployment!==true)return {authorized:false,reason:'outside_registered_policy'};
      if(input.purpose==='input-confirmation'){
        const confirmation=policy.input_confirmations?.[input.stage];
        if(!confirmation?.reference||confirmation.source!=='operator-supplied'||!Array.isArray(confirmation.basis)||digest(confirmation.basis)!==digest(input.basis))return {authorized:false,reason:'exact_operator_input_confirmation_required'};
      }
      if(input.purpose==='review-disposition'){
        const allowed=policy.accepted_finding_severities??['low','info'];
        const findings=input.findings??input.decision?.units?.flatMap(unit=>unit.findings??[])??[];
        if(findings.some(finding=>finding.status==='open'&&!allowed.includes(finding.severity)))return {authorized:false,reason:'unaccepted_review_finding'};
      }
      const payload={version:'1.0',id:randomUUID(),kind:'controller-policy',issuer:fingerprint,reference:policy.reference,request_digest:requestDigest,purpose:input.purpose,stage:input.stage,input_digest:digest(input),issued_at:new Date().toISOString()};
      const bytes=Buffer.from(JSON.stringify(payload));const signature=sign(null,bytes,privateKey).toString('base64');
      const receipt={payload,signature};issued.set(payload.id,receipt);fs.writeFileSync(path.join(controllerRoot,'authority',`${payload.id}.json`),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
      return {authorized:true,reference:`controller-policy:${payload.id}`,decision_kind:'operator-policy',receipt};
    },
    verify(receipt,input){return !!receipt&&issued.has(receipt.payload?.id)&&receipt.payload.request_digest===requestDigest&&receipt.payload.input_digest===digest(input)&&verify(null,Buffer.from(JSON.stringify(receipt.payload)),publicKey,Buffer.from(receipt.signature,'base64'));},
    authorizeFinding:async()=>({authorized:false,reason:'finding_requires_specific_owner_disposition'})};
}

export function buildExecutionPrompt({dispatch,workspace,sourceDigest}){
  const context=dispatch.context??{};const stage=context.stage??{};
  const snapshot=readSnapshot();const persona=snapshot.agents.find(agent=>agent.slug===dispatch.role)?.procedure??'';
  const targets=context.artifact_targets??[];
  return {schema:'kontour.aidlc.stage_execution_request',version:'1.0',canonical_workspace:workspace,unit_scope:dispatch.unit,
    source_digest:sourceDigest,dispatch,inline_voice_knowledge:(dispatch.voices??[]).map(role=>({role,procedure:snapshot.agents.find(agent=>agent.slug===role)?.procedure??''})),
    instructions:[
      'Execute the substantive pinned AI-DLC procedure for this stage. The host owns canonical state, approvals, gate advancement and source publication; upstream aidlc engine commands and harness paths are reference data and must not be executed.',
      `Phase ${dispatch.phase}; role ${dispatch.role}. ${dispatch.phase==='review'?'Read-only independent review: write no files.':'Write only this stage output scope and authorized application source.'}`,
      context.planning_only?'Planning only. Write plan and test instructions; implementation source changes are forbidden.':context.plan_approval==='approved'?'The exact plan/test-instruction bytes were approved by registered host policy. Do not edit them; execute them.':'Follow the selected procedure; never forge host decisions.',
      'Return one JSON object as final response: {status:"completed"|"failed",artifacts:[{path}],verdict:"ready"|"not_ready" (review only),findings:[{id,severity:"critical"|"high"|"medium"|"low"|"info",status:"open"|"fixed",reason}],summary}. Do not supply execution identity, receipt, approval or gate status; those are observed by the trusted host.',
      'Reference prior findings by their unchanged ids. A review covers the frozen source and artifact basis. Do not weaken tests or declared quality targets to obtain a pass.',
      'For every Markdown artifact use the pinned required sections and source/requirement ids. Preserve real questions and assumptions. Questions awaiting operator policy are not answers supplied by the model.',
      `Task: ${context.task??''}`,`Actual required output paths: ${JSON.stringify(targets)}`,
      `Selected profile defaults: ${JSON.stringify(context.defaults??{})}`,`Pinned procedure: ${dispatch.procedure??stage.procedure??''}`,`Role knowledge: ${persona}`
    ]};
}

export function observeOutputs(workspace,targets){return targets.flatMap(target=>{try{const observation=readArtifact(workspace,target.path);return [{...target,digest:observation.digest}];}catch{return [];}});}
