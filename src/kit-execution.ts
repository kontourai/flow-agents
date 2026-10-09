import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {observeInstalledKitIntegrity} from './flow-kit/content-hash.js';

export type KitExecutionDescriptor = {contract: 'kontour.kit.execution_request@1.0'; module: string; export: string};
export function parseKitExecution(manifest: Record<string, unknown>): KitExecutionDescriptor | null {
 if(manifest.execution===undefined)return null;
 const value=manifest.execution as Record<string, unknown>;
 if(!value||typeof value!=='object'||Array.isArray(value)||value.contract!=='kontour.kit.execution_request@1.0'||typeof value.module!=='string'||!value.module.endsWith('.mjs')||path.isAbsolute(value.module)||value.module.includes('\\')||value.module.split('/').some(part=>!part||part==='.'||part==='..'||['.git','__pycache__','.pytest_cache'].includes(part))||typeof value.export!=='string'||!/^[$A-Z_a-z][$\w]*$/.test(value.export))throw new Error('execution must declare a relative .mjs module, exported function and kontour.kit.execution_request@1.0 contract');
 return value as KitExecutionDescriptor;
}

/** Resolve only an explicitly installed, integrity-bound kit host entry. */
export function verifyInstalledKit({kitId,dest}: {kitId:string;dest:string}):{kitRoot:string;modulePath:string;descriptor:KitExecutionDescriptor;hash:string}{
 if(!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(kitId))throw new Error('Invalid kit id');
 const registry=JSON.parse(fs.readFileSync(path.join(dest,'kits/local/installed-kits.json'),'utf8'));
 const entries=(registry.kits as Record<string, unknown>[]).filter(entry=>entry.id===kitId);
 if(entries.length!==1)throw new Error('Exactly one installed kit required');
 const integrity=observeInstalledKitIntegrity(entries[0]!,dest);
 if(integrity.state!=='installed')throw new Error(`Installed kit integrity refused: ${integrity.state}`);
 const kitRoot=path.join(path.resolve(dest),'kits/local/repositories',kitId);
 const inspectTree=(directory:string):void=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){if(['.git','__pycache__','.pytest_cache'].includes(entry.name))throw new Error('Installed execution tree contains unhashed entries');if(entry.isDirectory())inspectTree(path.join(directory,entry.name));}};
 inspectTree(kitRoot);
 const manifest=JSON.parse(fs.readFileSync(path.join(kitRoot,'kit.json'),'utf8'));
 const descriptor=parseKitExecution(manifest);if(!descriptor)throw new Error('Kit has no declared execution entry');
 let modulePath=kitRoot;
 for(const component of descriptor.module.split('/')){modulePath=path.join(modulePath,component);if(fs.lstatSync(modulePath).isSymbolicLink())throw new Error('Execution module may not traverse symlinks');}
 if(!fs.statSync(modulePath).isFile())throw new Error('Execution module must be a regular file');
 return {kitRoot,modulePath,descriptor,hash:integrity.observed_hash!};
}

export async function executeInstalledKit({kitId,dest,requestFile,controllerRoot,authFile}: {kitId:string;dest:string;requestFile:string;controllerRoot:string;authFile?:string}):Promise<unknown>{
 const {kitRoot,modulePath,descriptor}=verifyInstalledKit({kitId,dest});
 const request=JSON.parse(fs.readFileSync(requestFile,'utf8'));
 if(request.schema!=='kontour.kit.execution_request'||request.version!=='1.0'||request.kit_id!==kitId)throw new Error('Request must bind the declared kit execution contract and kit id');
 if(request.source_root!==undefined&&(typeof request.source_root!=='string'||fs.realpathSync(request.source_root)!==fs.realpathSync(kitRoot)))throw new Error('Request source_root must bind the installed kit');
 const args={requestFile:path.resolve(requestFile),controllerRoot:path.resolve(controllerRoot),authFile:authFile?path.resolve(authFile):undefined};
 return new Promise((resolve,reject)=>{
   const child=fork(fileURLToPath(new URL('./kit-execution-child.js',import.meta.url)),[modulePath,descriptor.export,JSON.stringify(args)],{stdio:['ignore','ignore','pipe','ipc'],detached:true});
   const seconds=request.execution?.timeout_s??300;if(!Number.isFinite(seconds)||seconds<=0||seconds>86400){child.kill();reject(new Error('Finite host execution deadline required'));return;}
   const timer=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}reject(new Error('Kit execution deadline exceeded'));},(seconds+30)*1000);
   let outcome:{kind:string;result?:unknown;message?:string}|null=null,stderr='';
   child.stderr?.on('data',chunk=>{stderr=(stderr+chunk).slice(-65536);});
   child.on('message',message=>{outcome=message as typeof outcome;});
   child.on('error',error=>{clearTimeout(timer);reject(error);});
   child.on('exit',code=>{clearTimeout(timer);if(code===0&&outcome?.kind==='result')resolve(outcome.result);else reject(new Error(outcome?.message??`Kit execution process failed (${code}): ${stderr}`));});
 });
}
