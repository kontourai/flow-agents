import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {observeInstalledKitIntegrity} from './flow-kit/content-hash.js';

export type KitExecutionDescriptor = {contract: 'kontour.kit.execution_request@1.0'; module: string; export: string};
export function parseKitExecution(manifest: Record<string, unknown>): KitExecutionDescriptor | null {
 if(manifest.execution===undefined)return null;
 const value=manifest.execution as Record<string, unknown>;
 if(!value||typeof value!=='object'||Array.isArray(value)||value.contract!=='kontour.kit.execution_request@1.0'||typeof value.module!=='string'||!value.module.endsWith('.mjs')||path.isAbsolute(value.module)||value.module.includes('\\')||value.module.split('/').some(part=>!part||part==='.'||part==='..')||typeof value.export!=='string'||!/^[$A-Z_a-z][$\w]*$/.test(value.export))throw new Error('execution must declare a relative .mjs module, exported function and kontour.kit.execution_request@1.0 contract');
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
 const entry=await import(pathToFileURL(modulePath).href);
 if(typeof entry[descriptor.export]!=='function')throw new Error('Declared execution export must be a function');
 return entry[descriptor.export]({requestFile:path.resolve(requestFile),controllerRoot:path.resolve(controllerRoot),authFile:authFile?path.resolve(authFile):undefined});
}
