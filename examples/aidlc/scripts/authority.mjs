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
  const publicFile=path.join(authorityRoot,'host-public-key.pem');const publicPem=publicKey.export({type:'spki',format:'pem'});
  if(fs.existsSync(publicFile)){if(fs.readFileSync(publicFile,'utf8')!==publicPem)throw new Error('Host authority public key drifted');}
  else fs.writeFileSync(publicFile,publicPem,{flag:'wx',mode:0o444});
  const fingerprint=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
  const issued=new Map();
  for(const name of fs.readdirSync(authorityRoot).filter(name=>name.endsWith('.json')&&!name.endsWith('.input.json'))){const receipt=JSON.parse(fs.readFileSync(path.join(authorityRoot,name),'utf8'));if(receipt.payload?.issuer===fingerprint&&receipt.payload.request_digest===requestDigest&&verify(null,Buffer.from(JSON.stringify(receipt.payload)),publicKey,Buffer.from(receipt.signature,'base64')))issued.set(receipt.payload.id,receipt);}
  const port={kind:'trusted-host-policy',fingerprint,
    async authorize(input){
      if(input.request_digest!==requestDigest||!policy.purposes.includes(input.purpose)||input.purpose==='deployment'&&policy.deployment!==true)return {authorized:false,reason:'outside_registered_policy'};
      if(['input-confirmation','summary-confirmation'].includes(input.purpose)){
        const confirmation=(input.purpose==='summary-confirmation'?policy.summary_confirmations:policy.input_confirmations)?.[input.stage];
        if(!confirmation?.reference||confirmation.source!=='operator-supplied'||!Array.isArray(confirmation.basis)||digest(confirmation.basis)!==digest(input.basis))return {authorized:false,reason:'exact_operator_input_confirmation_required'};
      }
      // Judgment dissent is an unresolved objection to shipping. It never
      // resolves itself: only an explicit operator policy may accept it.
      // Both decision channels merge so neither can mask the other.
      const dissent=[...(input.dissent??[]),...(input.decision?.units?.flatMap(unit=>unit.dissent??[])??[])];
      const judgments=dissent.filter(objection=>objection?.kind==='judgment');
      if(input.purpose==='review-disposition'){
        const allowed=policy.accepted_finding_severities??['low','info'];
        const findings=input.findings??input.decision?.units?.flatMap(unit=>unit.findings??[])??[];
        if(findings.some(finding=>finding.status==='open'&&!allowed.includes(finding.severity)))return {authorized:false,reason:'unaccepted_review_finding'};
        if(judgments.length&&policy.review_disposition?.accept_judgment_dissent!==true)return {authorized:false,reason:'judgment_dissent_requires_operator_disposition',dissent:judgments};
      }
      const payload={version:'1.0',id:randomUUID(),kind:'controller-policy',issuer:fingerprint,reference:policy.reference,request_digest:requestDigest,purpose:input.purpose,stage:input.stage,input_digest:decisionBindingDigest(input),issued_at:new Date().toISOString(),...(input.purpose==='review-disposition'&&judgments.length&&policy.review_disposition?.accept_judgment_dissent===true?{judgment_dissent_accepted:true}:{})};
      const bytes=Buffer.from(JSON.stringify(payload));const signature=sign(null,bytes,privateKey).toString('base64');
      const receipt={payload,signature};issued.set(payload.id,receipt);
      // The approved input is durably stored beside its receipt: a signed
      // input_digest alone cannot reconstruct what the host actually decided.
      fs.writeFileSync(path.join(controllerRoot,'authority',`${payload.id}.input.json`),JSON.stringify(input,null,2)+'\n',{flag:'wx',mode:0o600});
      fs.writeFileSync(path.join(controllerRoot,'authority',`${payload.id}.json`),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
      return {authorized:true,reference:`controller-policy:${payload.id}`,decision_kind:'operator-policy',receipt};
    },
    verify(receipt,input){return !!receipt&&issued.has(receipt.payload?.id)&&receipt.payload.request_digest===requestDigest&&receipt.payload.input_digest===decisionBindingDigest(input)&&verify(null,Buffer.from(JSON.stringify(receipt.payload)),publicKey,Buffer.from(receipt.signature,'base64'));},
authorizeFinding:async()=>({authorized:false,reason:'finding_requires_specific_owner_disposition'})};
  const policyAuthorize=port.authorize;
  port.authorize=async input=>{
    if(input.request_digest!==requestDigest)return {authorized:false,reason:'request_binding_mismatch'};
    const accepted=[...issued.values()].find(receipt=>receipt.payload.kind==='controller-decision'&&receipt.payload.input_digest===decisionBindingDigest(input)&&receipt.payload.request_digest===requestDigest);
    if(accepted)return {authorized:true,reference:`controller-decision:${accepted.payload.id}`,decision_kind:'host-observed-operator-interaction',receipt:accepted};
    const response=await policyAuthorize(input);if(response.authorized)return response;
    if(!DECISION_PURPOSES.includes(input.purpose))return response;
    const pendingRoot=path.join(authorityRoot,'pending');fs.mkdirSync(pendingRoot,{recursive:true,mode:0o700});
    const id=decisionBindingDigest(input),pendingFile=path.join(pendingRoot,`${id}.json`);
    const payload={version:'1.0',id,kind:'decision-pending',issuer:fingerprint,request_digest:requestDigest,input_digest:id,input:structuredClone(input)};
    const pending={payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),privateKey).toString('base64')};
    if(!fs.existsSync(pendingFile))fs.writeFileSync(pendingFile,JSON.stringify(pending)+'\n',{flag:'wx',mode:0o600});
    return {...response,pending:{input_digest:id,file:pendingFile,purpose:input.purpose,stage:input.stage}};
  };
  return port;
}

// Durable replay changes observation bookkeeping, never approved execution facts.
export function decisionBindingDigest(input){
  const bound=structuredClone(input);
  function dispatch(value){for(const unit of value?.units??[])for(const receipt of unit.receipts??[]){delete receipt.replayed;delete receipt.persisted;}if(value?.final_verification?.dispatch)dispatch(value.final_verification.dispatch);}
  if(bound.decision)dispatch(bound.decision);
  return digest(bound);
}

const DECISION_PURPOSES=['stage-selection','source-change','summary-confirmation','input-confirmation','code-plan','skeleton-checkpoint','review-disposition','deployment','operation'];
/** Trusted CLI interaction. This observes an operator action, not a human signature. */
export function recordControllerDecision({controllerRoot,pendingFile,reference,decision='approve',disposition}) {
  if(typeof reference!=='string'||!reference.trim()||reference.length>2048||decision!=='approve')throw new Error('Explicit approval and reference required');
  const root=fs.realpathSync(controllerRoot),authorityRoot=path.join(root,'authority'),file=fs.realpathSync(pendingFile),pendingRoot=fs.realpathSync(path.join(authorityRoot,'pending'));
  if(path.dirname(file)!==pendingRoot)throw new Error('Decision input must be a retained private pending request');
  const privateKey=createPrivateKey(fs.readFileSync(path.join(authorityRoot,'host-private-key.pem'))),publicKey=createPublicKey(privateKey);
  const fingerprint=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex'),pending=JSON.parse(fs.readFileSync(file,'utf8')),input=pending.payload?.input;
  if(pending.payload?.kind!=='decision-pending'||pending.payload.issuer!==fingerprint||!input||pending.payload.input_digest!==decisionBindingDigest(input)||pending.payload.id!==decisionBindingDigest(input)||path.basename(file)!==`${decisionBindingDigest(input)}.json`||pending.payload.request_digest!==input.request_digest||!DECISION_PURPOSES.includes(input.purpose)||!verify(null,Buffer.from(JSON.stringify(pending.payload)),publicKey,Buffer.from(pending.signature??'','base64')))throw new Error('Pending decision signature or exact binding invalid');
  const bindingFile=path.join(root,'binding.json');if(fs.existsSync(bindingFile)&&JSON.parse(fs.readFileSync(bindingFile,'utf8')).request_digest!==input.request_digest)throw new Error('Pending decision request is stale');
  const dissent=[...(input.dissent??[]),...(input.decision?.units?.flatMap(unit=>unit.dissent??[])??[])];
  const findings=input.findings??input.decision?.units?.flatMap(unit=>unit.findings??[])??[];
  if(dissent.some(objection=>objection.kind==='judgment')&&disposition?.accept_judgment_dissent!==true)throw new Error('Judgment dissent requires explicit operator disposition');
  if(findings.some(finding=>finding.status==='open'&&!disposition?.accepted_finding_ids?.includes(finding.id)))throw new Error('Open findings require explicit operator disposition by id');
  const payload={version:'1.0',id:randomUUID(),kind:'controller-decision',issuer:fingerprint,reference,decision_kind:'host-observed-operator-interaction',request_digest:input.request_digest,purpose:input.purpose,stage:input.stage,input_digest:decisionBindingDigest(input),disposition:disposition??null,issued_at:new Date().toISOString()};
  const receipt={payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),privateKey).toString('base64')};
  fs.writeFileSync(path.join(authorityRoot,`${payload.id}.input.json`),JSON.stringify(input,null,2)+'\n',{flag:'wx',mode:0o600});fs.writeFileSync(path.join(authorityRoot,`${payload.id}.json`),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
  return {reference:`controller-decision:${payload.id}`,decision_kind:'host-observed-operator-interaction',receipt};
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
      context.summary_only?'Summary checkpoint only: read upstream inputs and write the questions with proposed assumptions for operator confirmation; do not produce substantive stage artifacts or edit source.':context.planning_only?'Planning only. Write plan and test instructions; implementation source changes are forbidden.':context.plan_approval==='approved'?'The exact plan/test-instruction bytes were approved by registered host policy. Do not edit them; execute them.':'Follow the selected procedure; never forge host decisions.',
      'Return one JSON object as final response: {status:"completed"|"failed",artifacts:[{path}],verdict:"ready"|"not_ready" (review only),findings:[{id,severity:"critical"|"high"|"medium"|"low"|"info",status:"open"|"fixed",reason}],summary}. Do not supply execution identity, receipt, approval or gate status; those are observed by the trusted host.',
      'Reference prior findings by their unchanged ids. A review covers the frozen source and artifact basis. Do not weaken tests or declared quality targets to obtain a pass.',
      'Native generated metadata is adapted to this controller. If traceability.json is a required output, supply a candidate mapping {stage, unit (only for a real unit), upstream_ids:[actual IDs], coverage:[{id,status:"OK"|"GAP"|"ORPHAN"|"Deferred"|"N/A",target}], reverse:[{id,status,target}]}. Read actual upstream IDs and existing implementation targets; never invent IDs or claim the mapping proves semantic correctness. The host sensor validates this candidate instead of running native engine commands.',
      context.approved_summary_basis?'Summary question bytes have current-basis operator confirmation; consume them and preserve those exact bytes.':'Do not claim unconfirmed summary assumptions are approved.',
      'For every Markdown artifact use the pinned required sections and source/requirement ids. Preserve real questions and assumptions. Questions awaiting operator policy are not answers supplied by the model.',
      context.learning_diary?`${context.learning_protocol} Diary: ${context.learning_diary}`:'Learning ritual is off or this is a revision.',
      `Task: ${context.task??''}`,`Actual required output paths: ${JSON.stringify(targets)}`,
      `Selected profile defaults: ${JSON.stringify(context.defaults??{})}`,`Pinned procedure: ${dispatch.procedure??stage.procedure??''}`,`Role knowledge: ${persona}`
    ]};
}

export function observeOutputs(workspace,targets){return targets.flatMap(target=>{try{const observation=readArtifact(workspace,target.path);return [{...target,digest:observation.digest}];}catch{return [];}});}
