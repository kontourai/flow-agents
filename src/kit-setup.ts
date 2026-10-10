/** Installed-kit first-run configuration. Secret resolution belongs to Datum;
 * native login/cache ownership belongs to each engine. No credential is persisted. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {parseAuthRef, materializeAuthRef, describeAuth, defaultSecretRunner, resolveRef, loadConfig, type AuthRef, type SecretRunner} from '@kontourai/datum';
import {verifyInstalledKit} from './kit-execution.js';

export const setupEngines = ['codex','claude','kiro','cursor','opencode','copilot'] as const;
export type SetupEngine = typeof setupEngines[number];
export type KitAuth = {mode:'native'} | {mode:'codex-file';file:string} | {mode:'secret-ref';ref:AuthRef};
export type HostSetup = {engine:SetupEngine;provider:string;model:string;auth:KitAuth;isolation:'trusted-host'|'docker';host_access_granted?:boolean};
export type Check = {id:string;status:'PASS'|'FAIL'|'NOT_VERIFIED';action?:string};
export type Probe = (binary:string,args:string[])=>boolean;
const probe:Probe=(binary,args)=>{try{return spawnSync(binary,args,{stdio:'ignore',timeout:10000}).status===0;}catch{return false;}};
const contained=(root:string,target:string)=>{const rel=path.relative(root,target);return !rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
function physical(file:string):string {let current=path.resolve(file),tail:string[]=[];while(!fs.existsSync(current)){tail.unshift(path.basename(current));const next=path.dirname(current);if(next===current)throw new Error('Path has no existing ancestor');current=next;}return path.join(fs.realpathSync(current),...tail);}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected JSON object');return value as Record<string,unknown>;}
function safeText(value:unknown,name:string):string {if(typeof value!=='string'||!value.trim()||/[\p{Cc}\p{Cf}]/u.test(value))throw new Error(`Valid ${name} required`);return value;}
export function parseHostSetup(value:unknown):HostSetup {
 const v=object(value);if(Object.keys(v).some(k=>!['engine','provider','model','auth','isolation','host_access_granted'].includes(k)))throw new Error('Unknown host setup field');
 if(!setupEngines.includes(v.engine as SetupEngine))throw new Error('Unsupported engine');
 const provider=safeText(v.provider,'provider'),model=safeText(v.model,'model'),a=object(v.auth);let auth:KitAuth;
 if(a.mode==='native'&&Object.keys(a).length===1)auth={mode:'native'};
 else if(a.mode==='codex-file'&&Object.keys(a).every(k=>['mode','file'].includes(k))&&v.engine==='codex'&&provider==='openai')auth={mode:'codex-file',file:path.resolve(safeText(a.file,'auth file'))};
 else if(a.mode==='secret-ref'&&Object.keys(a).every(k=>['mode','ref'].includes(k)))auth={mode:'secret-ref',ref:parseAuthRef(a.ref)};
 else throw new Error('Unsupported auth mode or engine/auth combination');
 if(v.isolation!=='trusted-host'&&v.isolation!=='docker')throw new Error('Explicit isolation required');
 if(v.isolation==='docker'&&(v.engine!=='codex'||auth.mode==='native'))throw new Error('Docker execution requires supported Codex broker auth; native caches are never mounted');
 if(v.host_access_granted!==undefined&&typeof v.host_access_granted!=='boolean')throw new Error('Host execution permission must be boolean');
 return {engine:v.engine as SetupEngine,provider,model,auth,isolation:v.isolation,...(v.host_access_granted!==undefined?{host_access_granted:v.host_access_granted as boolean}:{})};
}
/** Only an explicit trusted-host invocation materializes this value. Never log it. */
export function resolveKitAuth(auth:KitAuth,options:{env?:NodeJS.ProcessEnv;secretRunner?:SecretRunner}={}):string|null {return auth.mode==='secret-ref'?materializeAuthRef(auth.ref,options):null;}
export function resolveKitModel(ref:string,cwd:string):{model:string;provider:string;auth:KitAuth} {
 const resolved=resolveRef(ref,{cwd});
 return {model:resolved.model,provider:resolved.provider,auth:{mode:'secret-ref',ref:parseAuthRef(loadConfig({cwd}).config.providers?.[resolved.provider]?.auth)}};
}
function noSecrets(value:unknown):void {if(typeof value==='string'&&/^(?:(?:sk|pk|rk|ghp|gho|xox)[-_]|AKIA[0-9A-Z]{16}$|eyJ[A-Za-z0-9_-]+\.)/.test(value))throw new Error('Secret literal refused');if(Array.isArray(value)){value.forEach(noSecrets);return;}if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){if(/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret|credentials|tokens|token|bearer|capability|authorization|OPENAI_API_KEY)$/i.test(key))throw new Error('Secret-bearing request field refused');noSecrets(item);}}
export function createKitRequest(options:{kitId:string;dest:string;workspace:string;controllerRoot:string;host:HostSetup;prompt:string;runId?:string;parameters?:unknown;template?:unknown;image?:string;maxTurns?:number;maxProviderRequests?:number;timeoutS?:number}):Record<string,unknown> {
 const {kitRoot}=verifyInstalledKit({kitId:options.kitId,dest:options.dest});
 const workspace=fs.realpathSync(options.workspace),controller=physical(options.controllerRoot),host=parseHostSetup(options.host);
 if(host.isolation==='trusted-host'&&host.host_access_granted!==true)throw new Error('Native engine execution requires --allow-host-execution');
 if(!fs.statSync(workspace).isDirectory())throw new Error('Workspace must be a directory');
 if(contained(workspace,controller)||contained(controller,workspace)||contained(kitRoot,controller)||contained(controller,kitRoot))throw new Error('Controller must be private and disjoint from workspace and installed kit');
 if(host.auth.mode==='codex-file'){const file=physical(host.auth.file);if(contained(workspace,file)||contained(kitRoot,file))throw new Error('Host credential file must stay outside workspace and kit');host.auth.file=file;}
 const limit=(n:number,min:number,max:number,name:string)=>{if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`Bounded ${name} required`);return n;};
 if(fs.existsSync(controller)){const stat=fs.statSync(controller);if(!stat.isDirectory()||process.platform!=='win32'&&(stat.mode&0o077)!==0)throw new Error('Existing controller directory must be private (mode 0700)');}
 const request=options.template===undefined?{}:object(options.template);noSecrets(request);
 if(request.kit_id!==undefined&&request.kit_id!==options.kitId)throw new Error('Template kit identity mismatch');
 const parameters=options.parameters??request.parameters??{};noSecrets(parameters);object(parameters);
 const execution={...object(request.execution??{}),model:host.model,provider:host.provider,engine:host.engine,harness:host.engine,harness_version:null,provider_request_budget_enforcement:host.isolation==='docker'?'host-broker':'not-enforced',runtime:host.isolation==='docker'?'docker':'native',max_turns:limit(options.maxTurns??32,1,1024,'turn count'),max_provider_requests:limit(options.maxProviderRequests??128,1,8192,'provider request count'),timeout_s:limit(options.timeoutS??3600,1,86400,'deadline')};
 const sandbox={...object(request.engine_sandbox??{})};
 if(host.isolation==='docker'){const image=options.image??sandbox.image;if(typeof image!=='string'||!(/^sha256:[a-f0-9]{64}$/).test(image))throw new Error('Docker requires an immutable image digest');sandbox.image=image;}
 else if(sandbox.image!==undefined)throw new Error('Native execution cannot claim Docker sandbox identity');
 const output={...request,schema:'kontour.kit.execution_request',version:'1.0',kit_id:options.kitId,source_root:kitRoot,workspace,run_id:safeText(options.runId??randomUUID(),'run id'),prompt:safeText(options.prompt,'prompt'),parameters,execution,engine_sandbox:sandbox,host_setup:host};noSecrets(output);return output;
}
export function doctorKitSetup(host:HostSetup,options:{env?:NodeJS.ProcessEnv;secretRunner?:SecretRunner;probe?:Probe;image?:string}={}):Check[] {
 host=parseHostSetup(host);const run=options.probe??probe,checks:Check[]=[];
 const binary=host.engine==='claude'?'claude':host.engine==='kiro'?'kiro-cli':host.engine==='cursor'?'agent':host.engine;
 checks.push({id:'engine-installed',status:host.isolation==='docker'?'NOT_VERIFIED':run(binary,['--version'])?'PASS':'FAIL',action:`Install the ${host.engine} CLI on the trusted host`});
 if(host.isolation==='docker'){checks.push({id:'docker-daemon',status:run('docker',['info'])?'PASS':'FAIL',action:'Start Docker on the trusted host'});checks.push({id:'worker-image',status:options.image&&/^sha256:[a-f0-9]{64}$/.test(options.image)&&run('docker',['image','inspect',options.image])?'PASS':'FAIL',action:'Run kit prepare-worker and configure its observed local immutable image ID; engine contents are verified by worker execution'});}
 if(host.auth.mode==='native')checks.push({id:'native-auth',status:host.engine==='codex'?(run('codex',['login','status'])?'PASS':'FAIL'):'NOT_VERIFIED',action:host.engine==='codex'?'Run codex login (or codex login --device-auth on a headless host)':'Use the engine sign-in flow; native auth is engine-owned and is verified by execution'});
 else if(host.auth.mode==='secret-ref'){const status=describeAuth(host.auth.ref,options.env??process.env,options.secretRunner??defaultSecretRunner);checks.push({id:'auth-reference-backend',status:status.available?'PASS':'FAIL',action:'Configure the referenced Datum credential backend on this host'});checks.push({id:'provider-auth',status:'NOT_VERIFIED',action:'Authentication is verified by a bounded provider invocation; doctor never reads a secret'});}
 else {let available=false;try{const stat=fs.statSync(host.auth.file);available=stat.isFile()&&(process.platform==='win32'||(stat.mode&0o077)===0);if(available){const auth=object(JSON.parse(fs.readFileSync(host.auth.file,'utf8')));available=typeof auth.OPENAI_API_KEY==='string'&&!!auth.OPENAI_API_KEY||typeof (auth.tokens as {access_token?:unknown})?.access_token==='string'&&!!(auth.tokens as {access_token?:unknown})?.access_token;const token=(auth.tokens as {access_token?:unknown})?.access_token;if(typeof token==='string'&&token.split('.').length===3){try{const claims=JSON.parse(Buffer.from(token.split('.')[1]!,'base64url').toString('utf8'));if(typeof claims.exp==='number'&&claims.exp<=Date.now()/1000)available=false;}catch{available=false;}}}}catch{}checks.push({id:'codex-auth-file',status:available?'PASS':'FAIL',action:'Select a private existing Codex file cache outside the workspace; keyring login does not create auth.json. An expired JWT is refused; run the native login flow again. The broker does not refresh tokens.'});checks.push({id:'provider-auth',status:'NOT_VERIFIED',action:'File presence is not provider authorization or token freshness'});}
 return checks;
}
export function writeKitRequest(file:string,request:Record<string,unknown>):void {noSecrets(request);fs.writeFileSync(file,JSON.stringify(request,null,2)+'\n',{flag:'wx',mode:0o600});}
