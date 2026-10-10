import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs,flagString,flagBool} from '../lib/args.js';
import {defaultCodexHome} from '../lib/local-artifact-root.js';
import {createKitRequest,doctorKitSetup,parseHostSetup,resolveKitModel,writeKitRequest,type KitAuth} from '../kit-setup.js';
const usage=`usage: flow-agents kit setup <kit-id> --workspace <dir> --controller-root <private-dir> --engine <codex|claude|kiro|cursor|opencode|copilot> --model <name> --prompt <text> --output <request.json> [--provider <Datum model@provider>] [--auth native | --auth-ref <reference.json> | --auth-file <private-codex-cache>] [--isolation trusted-host|docker] [--image <immutable-digest>] [--parameters-file <json>] [--allow-host-execution] [--request-template <json>] [--dest <install-root>] [--dry-run]\n       flow-agents kit doctor --request <request.json>\n       flow-agents kit prepare-worker --codex-version <exact-version> [--tag <local-name>]`;
export async function kitSetupMain(command:string,argv:string[]):Promise<number>{
 if(argv.includes('--help')){console.log(usage);return 0;}
 const args=parseArgs(argv),get=(key:string)=>flagString(args.flags,key),required=(key:string)=>{const v=get(key);if(!v)throw new Error(`--${key} required`);return v;},json=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'));
 try{
  if(command==='prepare-worker'){
   const version=required('codex-version');if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))throw new Error('Exact Codex version required');
   const tag=get('tag')??`kontour-codex-worker:${version}`;if(!/^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?$/.test(tag))throw new Error('Valid local image tag required');
   const context=fileURLToPath(new URL('../../../integrations/codex-host/worker/',import.meta.url));
   const built=spawnSync('docker',['build','--build-arg',`CODEX_VERSION=${version}`,'--tag',tag,context],{stdio:'inherit',timeout:900000});if(built.status!==0)throw new Error('Worker image build failed');
   const inspected=spawnSync('docker',['image','inspect','--format','{{.Id}}',tag],{encoding:'utf8',timeout:10000});const image=inspected.stdout?.trim();if(inspected.status!==0||!/^sha256:[a-f0-9]{64}$/.test(image??''))throw new Error('Immutable local image identity unavailable');
   console.log(JSON.stringify({image,requested_codex_version:version,toolchain:['node','git','python3','codex'],host_credentials_provided:false}));return 0;
  }
  if(command==='doctor'){const request=json(required('request'));const checks=doctorKitSetup(parseHostSetup(request.host_setup),{image:request.engine_sandbox?.image});console.log(JSON.stringify({checks},null,2));return checks.some(c=>c.status==='FAIL')?1:0;}
  const workspace=path.resolve(required('workspace')),providerRef=get('provider'),model=get('model');
  const resolved=providerRef?resolveKitModel(providerRef,workspace):null;
  if(resolved&&model&&resolved.model!==model)throw new Error('--model conflicts with Datum provider model');
  const authCount=[get('auth'),get('auth-file'),get('auth-ref')].filter(Boolean).length;
  if(authCount>1)throw new Error('Choose exactly one auth mode');
  let auth:KitAuth;
  if(get('auth-file'))auth={mode:'codex-file',file:required('auth-file')};
  else if(get('auth-ref'))auth={mode:'secret-ref',ref:json(required('auth-ref'))};
  else if(get('auth')==='native'||!resolved&&!get('auth'))auth={mode:'native'};
  else if(get('auth'))throw new Error('Only native is supported by --auth; use --auth-ref for Datum references');
  else auth=resolved!.auth;
  const host=parseHostSetup({engine:required('engine'),model:model??resolved?.model,provider:resolved?.provider??(auth.mode!=='native'?'openai':required('engine')),auth,isolation:get('isolation')??'trusted-host',host_access_granted:flagBool(args.flags,'allow-host-execution')});
  const request=createKitRequest({kitId:args.positionals[0]??'',dest:path.resolve(get('dest')??defaultCodexHome()),workspace,controllerRoot:required('controller-root'),host,prompt:required('prompt'),runId:get('run-id'),image:get('image'),parameters:get('parameters-file')?json(required('parameters-file')):get('parameters')?json(required('parameters')):undefined,template:get('request-template')?json(required('request-template')):undefined,maxTurns:get('max-turns')?Number(get('max-turns')):undefined,maxProviderRequests:get('max-provider-requests')?Number(get('max-provider-requests')):undefined,timeoutS:get('timeout-s')?Number(get('timeout-s')):undefined});
  const checks=doctorKitSetup(host,{image:(request.engine_sandbox as {image?:string}).image}),dry=flagBool(args.flags,'dry-run');
  if(!dry)writeKitRequest(required('output'),request);
  console.log(JSON.stringify({dry_run:dry,request,checks},null,2));return checks.some(c=>c.status==='FAIL')?1:0;
 }catch(error){const e=error as Error & {code?:string};const message=e.code?`Configuration or filesystem operation refused (${e.code})`:e instanceof SyntaxError?'Invalid JSON input (contents withheld)':e.message;console.error(`Setup refused: ${message}. Run --help for supported configuration.`);return 2;}
}
