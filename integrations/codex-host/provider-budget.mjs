// Host-owned request quota shared by every broker session for one registered run.
// Reservations are durable before forwarding; ambiguous writes consume admission.
import {openSync,closeSync,readFileSync,writeFileSync,appendFileSync,fsyncSync,renameSync,unlinkSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
const exists=file=>{try{return lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
function checkedRead(file){const stat=exists(file);if(!stat||!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.uid!==process.getuid?.())throw new Error('provider budget private file unavailable');return readFileSync(file,'utf8');}
function syncWrite(file,text,flag='w'){const fd=openSync(file,flag,0o600);try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}}
function syncDirectory(dir){const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
export function openProviderBudget({ledgerFile,requestBindingDigest,model,reasoningEffort,upstreamOrigin,maxRequests,initializeLedger=false}){
 if(!path.isAbsolute(ledgerFile)||typeof requestBindingDigest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(requestBindingDigest))throw new Error('provider budget run binding required');
 const dir=path.dirname(ledgerFile),stat=lstatSync(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.uid!==process.getuid?.())throw new Error('provider budget requires a private host-owned directory');
 const binding=JSON.stringify({version:1,request_binding_digest:requestBindingDigest,model,reasoning_effort:reasoningEffort,upstream_origin:upstreamOrigin,max_requests:maxRequests});
 const journalFile=ledgerFile+'.reservations',lockFile=ledgerFile+'.lock',token=randomBytes(32).toString('hex');
 try{syncWrite(lockFile,token,'wx');}catch(error){if(error.code==='EEXIST')throw new Error('provider budget session already owned');throw error;}
 let ledgerText,journalText,count,closed=false,poisoned=false;
 const release=()=>{if(closed)return;closed=true;if(checkedRead(lockFile)===token){unlinkSync(lockFile);syncDirectory(dir);}};
 const ledger=()=>JSON.stringify({version:1,binding_digest:digest(binding),reserved_requests:count,journal_digest:digest(journalText)})+'\n';
 try{
  if(!exists(ledgerFile)&&!exists(journalFile)){
   if(!initializeLedger)throw new Error('provider budget existing ledger required');
   count=0;journalText=binding+'\n';syncWrite(journalFile,journalText,'wx');syncDirectory(dir);
   ledgerText=ledger();syncWrite(ledgerFile,ledgerText,'wx');syncDirectory(dir);
  }else{
   if(initializeLedger)throw new Error('provider budget already initialized');
   ledgerText=checkedRead(ledgerFile);journalText=checkedRead(journalFile);
   const lines=journalText.split('\n');if(lines.pop()!==''||lines.shift()!==binding)throw new Error('provider budget binding or journal invalid');
   count=0;let previous=digest(binding+'\n');
   for(const line of lines){const entry=JSON.parse(line);count++;if(entry.reservation!==count||entry.previous_digest!==previous||Object.keys(entry).length!==2)throw new Error('provider budget reservation journal invalid');previous=digest(previous+'\n'+line);}
   if(count>maxRequests||ledgerText!==ledger())throw new Error('provider budget ledger integrity mismatch');
  }
 }catch(error){release();throw error;}
 return {get reservedRequests(){return count;},reserve(){
  if(closed||poisoned)throw new Error('provider budget session unavailable');
  try{
   if(checkedRead(lockFile)!==token||checkedRead(ledgerFile)!==ledgerText||checkedRead(journalFile)!==journalText)throw new Error('provider budget changed during session');
   if(count>=maxRequests)return false;
   const lines=journalText.trimEnd().split('\n');let previous=digest(lines[0]+'\n');for(const line of lines.slice(1))previous=digest(previous+'\n'+line);
   const line=JSON.stringify({reservation:count+1,previous_digest:previous})+'\n';
   const fd=openSync(journalFile,'a');try{appendFileSync(fd,line);fsyncSync(fd);}finally{closeSync(fd);}
   journalText+=line;count++;const next=ledger(),temporary=ledgerFile+'.'+token+'.tmp';
   syncWrite(temporary,next,'wx');renameSync(temporary,ledgerFile);syncDirectory(dir);ledgerText=next;return true;
  }catch(error){poisoned=true;throw error;}
 },close:release};
}
