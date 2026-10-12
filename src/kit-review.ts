import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {startReviewConsoleServer} from '@kontourai/survey/review-console';
import {bindReviewQueue,deriveReviewSessionApplyResultForSnapshot,type ReviewQueueBinding} from '@kontourai/survey/review-workbench';
import {verifyInstalledKitEntry} from './kit-execution.js';

const loadedKitHashes=new Map<string,string>();

export interface KitReviewDescriptor {contract:'kontour.kit.review_request@1.0';module:string;export:string}
export interface KitReviewHost {resolveAuthority?: (...args:unknown[])=>unknown|Promise<unknown>}
export interface KitReviewServices {readonly survey:{readonly bindReviewQueue:typeof bindReviewQueue;readonly deriveReviewSessionApplyResultForSnapshot:typeof deriveReviewSessionApplyResultForSnapshot}}
const reviewServices:KitReviewServices=Object.freeze({survey:Object.freeze({bindReviewQueue,deriveReviewSessionApplyResultForSnapshot})});

export interface PreparedKitReview {
 sessionPath:string;
 binding:ReviewQueueBinding;
 apply:()=>Promise<{reference:string;summary?:string}>;
}
export function parseKitReview(manifest:Record<string,unknown>):KitReviewDescriptor|null {
 if(manifest.review===undefined)return null;
 const v=manifest.review as Record<string,unknown>;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['contract','module','export'].includes(k))||v.contract!=='kontour.kit.review_request@1.0'||typeof v.module!=='string'||!v.module.endsWith('.mjs')||path.isAbsolute(v.module)||v.module.includes('\\')||v.module.split('/').some(p=>!p||p==='.'||p==='..'||['.git','__pycache__','.pytest_cache'].includes(p))||typeof v.export!=='string'||!/^[$A-Z_a-z][$\w]*$/.test(v.export))throw new Error('review must declare a relative .mjs module, exported function and kontour.kit.review_request@1.0 contract');
 return v as unknown as KitReviewDescriptor;
}
/** Loopback presentation only. The producer retains subject, authentication and admission authority. */
export async function serveSurveyReview(options:PreparedKitReview&{port?:number}) {
 if(!path.isAbsolute(options.sessionPath)||typeof options.apply!=='function')throw new Error('Review requires an absolute sessionPath and trusted application callback');
 if(options.port!==undefined&&(!Number.isInteger(options.port)||options.port<0||options.port>65535))throw new Error('Invalid review port');
 return startReviewConsoleServer({sessionPath:options.sessionPath,port:options.port,producerApply:{binding:options.binding,apply:async()=>{
  const result=await options.apply();
  return {reference:result.reference,summary:result.summary??'Review applied by the kit producer'};
 }}});
}
/** Resolve an integrity-bound installed producer; request JSON cannot supply host capabilities. */
export async function openInstalledKitReview(options:{kitId:string;dest:string;requestFile:string;port?:number;host?:KitReviewHost}) {
 const installed=()=>verifyInstalledKitEntry({...options,parseDescriptor:parseKitReview,kind:'review'});
 const initial=installed();
 const file=fs.lstatSync(options.requestFile);
 if(!file.isFile()||file.isSymbolicLink()||file.size>1048576)throw new Error('Review request must be a regular file no larger than 1 MiB');
 if(options.host!==undefined&&(!options.host||typeof options.host!=='object'||Array.isArray(options.host)||Object.keys(options.host).some(key=>key!=='resolveAuthority')||options.host.resolveAuthority!==undefined&&typeof options.host.resolveAuthority!=='function'))throw new Error('Review host requires only trusted function capabilities');
 const request=JSON.parse(fs.readFileSync(options.requestFile,'utf8'));
 if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!['schema','version','kit_id','input'].includes(k))||request.schema!=='kontour.kit.review_request'||request.version!=='1.0'||request.kit_id!==options.kitId||!request.input||typeof request.input!=='object'||Array.isArray(request.input))throw new Error('Request must bind the declared kit review contract and kit id; host capabilities cannot be serialized');
 const loaded=loadedKitHashes.get(initial.kitRoot);
 if(loaded!==undefined&&loaded!==initial.hash)throw new Error('Installed kit changed since loading; restart the review host to discard module caches');
 loadedKitHashes.set(initial.kitRoot,initial.hash);
 const entry=await import(pathToFileURL(initial.modulePath).href+`?kitIntegrity=${initial.hash}`);
 if(typeof entry[initial.descriptor.export]!=='function')throw new Error('Declared review export must be a function');
 const prepared=await entry[initial.descriptor.export]({input:structuredClone(request.input),host:options.host,services:reviewServices}) as PreparedKitReview;
 if(!prepared||typeof prepared.sessionPath!=='string'||typeof prepared.apply!=='function'||!prepared.binding)throw new Error('Kit review producer returned an invalid session binding');
 const current=installed();if(current.hash!==initial.hash||current.registryBasis!==initial.registryBasis)throw new Error('Installed kit changed while preparing review');
 const server=await serveSurveyReview({...prepared,port:options.port,apply:async()=>{
  const current=installed();if(current.hash!==initial.hash||current.registryBasis!==initial.registryBasis||current.modulePath!==initial.modulePath||JSON.stringify(current.descriptor)!==JSON.stringify(initial.descriptor))throw new Error('Installed kit changed while review was open');
  return prepared.apply();
 }});
 return {...server,kitId:options.kitId,sessionPath:prepared.sessionPath,sourceHash:initial.hash};
}
