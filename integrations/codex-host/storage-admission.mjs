// Trusted-host admission/observation for model-writable bind mounts; no peer cleanup.
import {realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import path from 'node:path';

export const DEFAULT_STORAGE={max_bytes:128*1024*1024,max_entries:10000,max_file_bytes:16*1024*1024,min_free_bytes:4*1024*1024*1024};
export async function inspectStorage(budget){
 const roots=[];for(const root of budget.roots){const resolved=await realpath(root);if(!roots.some(parent=>resolved===parent||resolved.startsWith(parent+path.sep)))roots.push(resolved);}
 const script=path.join(import.meta.dirname,'storage-inspect.py');
 const result=await new Promise((resolve,reject)=>execFile('python3',[script,JSON.stringify({...budget,roots})],{timeout:10000,maxBuffer:65536},(error,stdout)=>error?reject(new Error('descriptor-relative storage inspector unavailable')):resolve(stdout)));
 return JSON.parse(result);
}
export async function admitStorage(budget){const observation=await inspectStorage(budget);if(!observation.allowed)throw new Error(`storage_admission_refused:${observation.reason}`);return observation;}

export function watchStorage(budget,terminate,{intervalMs=250}={}){
 let scanning=false,violation=null,closed=false;
 const timer=setInterval(async()=>{if(scanning||closed)return;scanning=true;try{const state=await inspectStorage(budget);if(!state.allowed&&!violation){violation=state;await terminate(state);}}catch{if(!violation){violation={allowed:false,reason:'writable_scope_inspection_failed'};await terminate(violation);}}finally{scanning=false;}},intervalMs);
 return {get violation(){return violation;},close(){closed=true;clearInterval(timer);}};
}
