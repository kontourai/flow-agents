import { loadRun } from '@kontourai/flow';
import { digest, requestBindingDigest } from './compile.mjs';
import { validateUnits } from './dispatch.mjs';

/** Deterministic dependency-first order; source custody is exclusive per Bolt. */
export function constructionOrder(units) {
  const manifest=validateUnits(units),ordered=[],seen=new Set();
  function visit(unit){if(seen.has(unit.id))return;for(const id of unit.depends_on??[])visit(manifest.find(entry=>entry.id===id));seen.add(unit.id);ordered.push(unit);}
  for(const unit of manifest)visit(unit);
  return ordered;
}
export function constructionBlock(snapshot,stageIds,firstStage) {
  const start=stageIds.indexOf(firstStage),block=[];
  for(const id of stageIds.slice(start)){const stage=snapshot.stages.find(stage=>stage.slug===id);if(stage.phase!=='construction'||!stage.for_each)break;block.push(id);}
  return block;
}

/**
 * A reusable serial child-workflow composition port. Each admitted child runs
 * the entire block for one unit using the same conductor, checks and authority.
 * Parent advancement remains separate. No child completion is a parent gate.
 */
export async function executeConstruction({request,controllerRoot,stageIds,units,runSlice,authority,signal,snapshotBasis}) {
  const ordered=constructionOrder(units),parent=await loadRun(request.run_id,controllerRoot);
  if(parent.state.current_step!==stageIds[0]||['completed','cancelled'].includes(parent.state.status))throw new Error('Construction parent admission changed');
  const children=[];
  for(const [index,unit] of ordered.entries()){
    if(signal?.aborted)return {status:'cancelled',children};
    const before=await loadRun(request.run_id,controllerRoot);if(before.state.current_step!==stageIds[0]||before.state.status!==parent.state.status)throw new Error('Construction parent admission changed during walk');
    const childRequest={...structuredClone(request),run_id:`${request.run_id.slice(0,65)}-bolt-${digest({unit,stageIds,parentAdmission:parent.state.transitions}).slice(0,24)}`};
    const childDigest=requestBindingDigest(childRequest),parentDigest=requestBindingDigest(request);
    const translate=input=>{if(input.request_digest!==childDigest)throw new Error('Child authority request substituted');return {...input,request_digest:parentDigest,construction_child:{run_id:childRequest.run_id,unit:unit.id,stage_ids:stageIds}};};
    const childAuthority={authorize:input=>authority?.authorize?.(translate(input)),verify:(receipt,input)=>authority?.verify?.(receipt,translate(input)),authorizeFinding:authority?.authorizeFinding};
    const child=await runSlice({request:childRequest,authority:childAuthority,unit:{...unit,depends_on:[],context:{dependency_units:unit.depends_on??[]}},children});
    children.push({unit:unit.id,result:child});
    if(child.status!=='completed')return {status:child.status,children,failure:child.failure};
    const canonical=await loadRun(childRequest.run_id,child.controller_root);
    if(canonical.state.status!=='completed'||stageIds.some(id=>!canonical.state.gate_outcomes.some(outcome=>outcome.gate_id===`${id}-gate`&&outcome.status==='pass')))throw new Error('Construction child is not canonically completed');
    if(index===0){
      const basis=child.records.filter(record=>stageIds.includes(record.stage)).flatMap(record=>record.artifacts??[]);
      const current=await snapshotBasis?.(basis);if(!current||!current.source_digest)throw new Error('Skeleton checkpoint requires observed source and artifact basis');
      const input={purpose:'skeleton-checkpoint',stage:stageIds[0],basis,source_digest:current.source_digest,child_run_id:childRequest.run_id,unit:unit.id,request_digest:parentDigest};
      const grant=await authority?.authorize?.(input);
      if(!grant?.authorized||authority.verify?.(grant.receipt,input)!==true)return {status:'waiting',children,failure:{stage:stageIds[0],reason:'authority_required',detail:grant}};
      if(digest(await snapshotBasis(basis))!==digest(current))throw new Error('Skeleton checkpoint basis changed during authority decision');
      children.at(-1).checkpoint=grant;
    }
  }
  return {status:'completed',children};
}
