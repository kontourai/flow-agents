import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {composeVerificationEvidenceCandidate,resealVerificationEvidenceTransition} from '../../packaging/lifecycle-authority/runtime-v1.mjs';
const raw=value=>Buffer.from(JSON.stringify(value));const digest=value=>createHash('sha256').update(Buffer.isBuffer(value)?value:raw(value)).digest('hex');
function fixture(){
 const snapshot={version:1,kind:'git-worktree',algorithm:'sha256',digest:'a'.repeat(64),head_sha:'b'.repeat(40),worktree_clean:true};
 const specification=Array.from({length:4},(_,i)=>({id:`criterion-${i}`,description:`Required behavior ${i}`}));
 const contract={version:1,algorithm:'sha256',criteria:specification,digest:digest(specification)};
 const old={claims:[{id:'plan',metadata:{acceptance_contract:contract},createdAt:'old',updatedAt:'old'},...specification.map(c=>({id:`pending-${c.id}`,subjectId:`run/${c.id}`,facet:'quality',impactLevel:'high',claimType:'workflow.acceptance.criterion',subjectType:'flow-step',value:'pending',status:'unknown',metadata:{origin:'acceptance',criterion:{...c,status:'pending'}}})),
 {id:'review',value:'pass',status:'verified',metadata:{origin:'critique',verdict:'pass',reviewer:'reviewer-b',critique_record_id:'review',critique_record_hash:'c'.repeat(64),critique_sequence:1,critique_predecessor_hash:'0'.repeat(64),lanes:[{id:'code',status:'pass'}],findings:[],review_target:{workspace_snapshot:snapshot}}}]};
 const command={command:'node --test test/actual.test.mjs',exit_code:0,source:'canonical-writer-execution',output_sha256:'d'.repeat(64),observed_at_commit:snapshot.head_sha,worktree_clean:true,verification_workspace_snapshot:snapshot,test_count:1,execution_proof:{kind:'local-process-exit',runner:'node --test',static_test_units:1}};
 const generated=structuredClone(old);generated.claims[0].createdAt='new';generated.claims[0].updatedAt='new';
 generated.claims=generated.claims.map(c=>c.metadata?.origin==='acceptance'?{...c,id:`verified-${c.metadata.criterion.id}`,value:'pass',status:'verified',fieldOrBehavior:c.metadata.criterion.description,metadata:{origin:'acceptance',workflow_subject_ref:'work-item:1',criterion:{...c.metadata.criterion,status:'pass',identity_version:2,verified_at:'2026-10-09T00:00:00Z',verified_by:'author',evidence_refs:[{kind:'command',excerpt:command.command}],observed_commands:[command]}}}:c);
 const target={id:'tests',claimType:'builder.verify.tests',subjectType:'flow-step',value:'pass',status:'verified',metadata:{origin:'check',workflow_subject_ref:'work-item:1',recorded_by:'author',expected_producer:'builder.verify-work',self_produced_trust_slices:['tests-evidence'],verification_workspace_snapshot:snapshot,observed_commands:[command],gate_claim:{expectation_id:'tests-evidence',claim_type:'builder.verify.tests',subject_type:'flow-step',step_id:'verify',flow_id:'builder.build',flow_run_head:'e'.repeat(64),identity_version:2}}};generated.claims.splice(1,0,target);
 const next=composeVerificationEvidenceCandidate(old,generated,'tests-evidence');
 const authorization={operation:'reseal-verification-evidence',claim_delta:'insert',target_expectation_id:'tests-evidence',assignment_actor_key:'author',writer_actor_key:'author',subject:'work-item:1',candidate_transaction_id:'f'.repeat(32),flow_definition_id:'builder.build',flow_step_id:'verify',flow_gate_id:'verify-gate',flow_run_head:'e'.repeat(64),predecessor_claim_id:null,predecessor_claim_status:null,predecessor_claim_sha256:null,predecessor_claim_index:null,current_claim_id:target.id,current_claim_status:target.status,current_claim_sha256:digest(target),current_claim_index:old.claims.length,related_criterion_deltas:old.claims.flatMap((c,i)=>c.metadata?.origin==='acceptance'?[{criterion_id:c.metadata.criterion.id,claim_index:i,preimage_claim_sha256:digest(c),candidate_claim_sha256:digest(next.claims[i])}]:[]),preimage_bundle_sha256:digest(old),candidate_bundle_sha256:digest(next),preimage_ledger_sha256:digest(raw({events:[]})),preimage_ledger_length:0,preimage_ledger_tail_hash:'0'.repeat(64)};
 const observation={assignment_actor_key:"author",workspace_snapshot:snapshot,command_log:[{source:command.source,command:command.command,observedResult:'pass',exitCode:0,observed_at_commit:command.observed_at_commit,worktree_clean:true,writer:{transaction_id:authorization.candidate_transaction_id,output_sha256:command.output_sha256,test_count:1,execution_proof:command.execution_proof,verification_workspace_snapshot:snapshot}}]};
 const flow={definition_id:'builder.build',step_id:'verify',gate_id:'verify-gate',requirements:[{id:'tests-evidence',required:true,bundle_claim:{claimType:'builder.verify.tests',subjectType:'flow-step'}}]};
 return {old,next,generated,authorization,observation,flow};
}
function run(f){return resealVerificationEvidenceTransition({current_bundle:f.old,candidate_bundle:f.next,authorization:f.authorization,resolution_events:[],current_bundle_bytes:raw(f.old),candidate_bundle_bytes:raw(f.next),ledger_bytes:raw({events:[]}),flow:f.flow,verification_observation:f.observation});}
test('first verification inserts one claim with four explicitly bound producer criterion renewals and exact historical claims',()=>{
 const f=fixture();const result=run(f);assert.deepEqual(result.bundle,f.next);assert.deepEqual(result.bundle.claims[0],f.old.claims[0]);assert.deepEqual(result.bundle.claims.at(-2),f.old.claims.at(-1));assert.equal(result.bundle.claims.length,f.old.claims.length+1);assert.equal(f.old.claims[1].value,'pending');
});
for(const [name,mutate]of [
 ['changed source',f=>f.observation.workspace_snapshot={...f.observation.workspace_snapshot,digest:'0'.repeat(64)}],
 ['wrong actor',f=>f.authorization.assignment_actor_key='other'],
 ['changed review graph',f=>f.next.claims.at(-2).metadata.reviewer='other'],
 ['two insertions',f=>f.next.claims.push({id:'forged'})],
 ['arbitrary expectation',f=>f.authorization.target_expectation_id='policy-compliance'],
 ['optional gate',f=>f.flow.requirements[0].required=false],
 ['forged receipt',f=>f.observation.command_log[0].writer.output_sha256='0'.repeat(64)],
 ['missing protocol',f=>delete f.next.claims.at(-1).metadata.observed_commands[0].execution_proof],
 ['unrelated criterion',f=>f.next.claims[1].metadata.criterion.id='other'],
 ['changed canonical contract',f=>f.old.claims[0].metadata.acceptance_contract.criteria[0].description='other'],
 ['concurrent baseline',f=>f.old.claims[0].createdAt='concurrent'],
 ['nonabsent predecessor',f=>f.authorization.predecessor_claim_index=0],
 ['unsigned criterion renewal',f=>f.authorization.related_criterion_deltas=[]],
 ['wrong writer transaction',f=>f.observation.command_log[0].writer.transaction_id='0'.repeat(32)],
 ['unrelated bundle event',f=>f.next.events=[{id:'forged',claimId:'plan'}]],
 ['unrelated bundle envelope',f=>f.next.source='forged'],
 ['criterion gate substitution',f=>f.next.claims[1].metadata.gate_claim={expectation_id:'merge-readiness'}],
 ['aborted writer transaction',f=>f.observation.command_log.push({source:'workflow-evidence-transaction',transaction:{id:f.authorization.candidate_transaction_id,outcome:'aborted'}})],
 ['duplicate command receipt',f=>f.observation.command_log.push(structuredClone(f.observation.command_log[0]))],
])test(`initial verification refuses ${name} without mutating the preimage`,()=>{const f=fixture();mutate(f);const before=raw(f.old);assert.throws(()=>run(f));assert.deepEqual(raw(f.old),before);});
test('candidate composition refuses unrelated substantive history changes or extra claims',()=>{const f=fixture();f.generated.claims[0].metadata.extra='changed';assert.throws(()=>composeVerificationEvidenceCandidate(f.old,f.generated,'tests-evidence'),/unrelated historical/);const g=fixture();g.generated.claims.push({id:'arbitrary'});assert.throws(()=>composeVerificationEvidenceCandidate(g.old,g.generated,'tests-evidence'),/unrelated claim/);});

test('first-admission authorization serializes exact absent predecessor and bounded criterion replacements',async()=>{
 const {buildUnsignedVerificationEvidenceResealAuthorization,validateVerificationEvidenceResealAuthorization}=await import('../../build/src/builder-lifecycle-authority.js');
 const f=fixture();const fields={...f.authorization,project_root:process.cwd(),run_id:'run',assignment_generation_sha256:'0'.repeat(64),assignment_actor:{runtime:'fixture',session_id:'session',host:'host',human:null},current_completion_sha256:'0'.repeat(64),current_completion_request_sha256:'0'.repeat(64),current_completion_result_core_sha256:'0'.repeat(64),flow_manifest_sha256:'0'.repeat(64),critique_projection_sha256:'0'.repeat(64),nonce:'once',requested_at:'2026-10-09T00:00:00Z',expires_at:'2026-10-10T00:00:00Z'};
 delete fields.operation;const built=buildUnsignedVerificationEvidenceResealAuthorization(fields);
 assert.equal(built.signingPayload,JSON.stringify(built.unsigned));assert.equal(built.unsigned.predecessor_claim_sha256,null);assert.equal(built.unsigned.related_criterion_deltas.length,4);
 const expected={projectRoot:fields.project_root,runId:'run',subject:fields.subject,now:'2026-10-09T00:01:00Z'};
 const signed={...built.unsigned,signature:{algorithm:'ed25519',key_id:'test-only',value:'AA=='}};
 assert.throws(()=>validateVerificationEvidenceResealAuthorization({...signed,predecessor_claim_index:0},expected),/absent predecessor/);
 const missing=structuredClone(signed);delete missing.related_criterion_deltas;assert.throws(()=>validateVerificationEvidenceResealAuthorization(missing,expected),/missing fields/);
});

test('initial verification rejects changed policy shared by an unrelated historical claim',()=>{
 const f=fixture();f.old.claims[0].verificationPolicyId='shared';f.next.claims[0].verificationPolicyId='shared';f.next.claims.at(-1).verificationPolicyId='shared';f.old.policies=[{id:'shared',requiredEvidence:[]}];f.next.policies=[{id:'shared',requiredEvidence:['forged']}];
 f.authorization.preimage_bundle_sha256=digest(f.old);f.authorization.candidate_bundle_sha256=digest(f.next);f.authorization.current_claim_sha256=digest(f.next.claims.at(-1));
 assert.throws(()=>run(f),/policy shared with an unrelated historical claim/);
});
