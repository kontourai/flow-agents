// Trusted host primitive. Never mounted inside a model worker. No grader imports.
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {DEFAULT_STORAGE,admitStorage,inspectStorage,watchStorage} from './storage-admission.mjs';
import { workspaceRevision } from './workspace-revision.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const must=(c,m)=>{if(!c)throw new Error(m);};
async function regular(file){const s=await lstat(file);must(s.isFile()&&!s.isSymbolicLink(),'regular file required');return realpath(file);}
function sync(argv){const r=spawnSync(argv[0],argv.slice(1),{encoding:'utf8'});must(r.status===0,r.stderr||'command failed');return r.stdout.trim();}
function exec(argv,{input,timeoutMs=30000,signal}={}){
 return new Promise(resolve=>{const child=spawn(argv[0],argv.slice(1),{stdio:['pipe','pipe','pipe'],detached:true});let stdout='',stderr='',timeout=false,overflow=false;
 const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};const abort=()=>kill();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)kill();
 const timer=setTimeout(()=>{timeout=true;kill();},timeoutMs);
 child.stdout.on('data',b=>{stdout+=b;if(Buffer.byteLength(stdout)>16*1024*1024){overflow=true;kill();}});child.stderr.on('data',b=>{stderr+=b;if(Buffer.byteLength(stderr)>16*1024*1024){overflow=true;kill();}});
 child.once('error',e=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({status:null,stdout,stderr:e.message,timeout,overflow});});child.once('close',(status,signalName)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({status,signal:signalName,stdout,stderr,timeout,overflow});});child.stdin.on('error',()=>{});child.stdin.end(input??'');});
}
export function parseCodexEvents(stdout){
 const lines=stdout.trim().split('\n').filter(Boolean);const events=lines.map(line=>JSON.parse(line));
 const starts=events.filter(e=>e.type==='thread.started');const turns=events.filter(e=>e.type==='turn.started');const completed=events.filter(e=>e.type==='turn.completed');
 must(starts.length===1&&typeof starts[0].thread_id==='string'&&starts[0].thread_id.length>0,'one observed provider thread required');
 must(turns.length===1&&completed.length===1,'one complete turn required');
 const usage=completed[0].usage;must(usage&&['input_tokens','output_tokens'].every(k=>Number.isSafeInteger(usage[k])&&usage[k]>=0),'terminal token usage missing');
 const final=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item?.text??null;
 return {events,provider_thread_id:starts[0].thread_id,usage:{complete:true,source:'codex-turn-completed',input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,cached_input_tokens:usage.cached_input_tokens??null},final};
}
export async function runCodexDockerWorker({image,workspace,sourceRoot,contextFile,providerProxy,model,timeoutMs,reasoningEffort='medium',network='bridge',readOnlyWorkspace=false,artifactRoot,signal,invocationId=randomUUID(),runId,workspaceSetup,storageBudget}){
 must(/^sha256:[a-f0-9]{64}$/.test(image),'immutable image ID required');must(typeof model==='string'&&model.length>0,'explicit model required');must(Number.isSafeInteger(timeoutMs)&&timeoutMs>0,'positive deadline required');must(['bridge','none'].includes(network),'network policy required');
 must(['minimal','low','medium','high','xhigh'].includes(reasoningEffort),'explicit supported reasoning effort required');
 workspace=await realpath(workspace);sourceRoot=await realpath(sourceRoot);contextFile=await regular(contextFile);artifactRoot=await realpath(artifactRoot);must(providerProxy&&/^http:\/\/host\.docker\.internal:[0-9]+$/.test(providerProxy.baseUrl)&&/^[a-f0-9]{64}$/.test(providerProxy.capability)&&providerProxy.model===model,'host-scoped provider capability required');
 const name=`kontour-worker-${invocationId}`;must(/^[a-z0-9-]+$/.test(name),'safe invocation ID required');
 const budget=storageBudget??{...DEFAULT_STORAGE,roots:[workspace,artifactRoot,path.dirname(contextFile)]};const admission=await admitStorage(budget);
 if(workspaceSetup?.prepare){await workspaceSetup.prepare({image,workspace,sourceRoot,runId,budget});await admitStorage(budget);}
 const extraMounts=[];
 for(const mount of workspaceSetup?.mounts??[]){must(path.isAbsolute(mount.source)&&/^\/workspace\/[a-zA-Z0-9._/-]+$/.test(mount.destination)&&!mount.destination.split('/').includes('..'),'safe workspace overlay mount required');extraMounts.push({source:await realpath(mount.source),destination:mount.destination});}
 must(new Set(extraMounts.map(m=>m.destination)).size===extraMounts.length,'unique workspace overlays required');
 const providerConfig=`model = ${JSON.stringify(model)}
model_provider = "kontour_proxy"
model_reasoning_effort = ${JSON.stringify(reasoningEffort)}
[model_providers.kontour_proxy]
name = "OpenAI via scoped host proxy"
base_url = ${JSON.stringify(providerProxy.baseUrl)}
env_key = "KONTOUR_PROVIDER_CAPABILITY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[projects."/workspace"]
trust_level = "trusted"
`;
 const hostBootstrap=workspaceSetup?.bootstrap??'';must(typeof hostBootstrap==='string','host bootstrap must be a string');
 const gitInit=readOnlyWorkspace?'':'git init -q && ';
 const gitSetup=readOnlyWorkspace?'':`git add -A && git -c user.name='Kontour Worker' -c user.email='worker@example.invalid' -c commit.gpgsign=false commit -q --allow-empty -m 'Immutable worker workspace seed' && `;
 const fileBlocks=Math.floor(budget.max_file_bytes/512);
 const bootstrap=`ulimit -f ${fileBlocks} && mkdir -p "$CODEX_HOME" && printf '%s' "$1" > "$CODEX_HOME/config.toml" && shift && ${gitInit}${hostBootstrap?hostBootstrap+' && ':''}${gitSetup}exec "$@"`;
 const argv=['docker','create','--name',name,'--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory','2g','--cpus','2','--tmpfs','/tmp:rw,nosuid,size=1g','--mount',`type=bind,source=${workspace},target=/workspace${readOnlyWorkspace?',readonly':''}`,'--mount',`type=bind,source=${sourceRoot},target=/treatment,readonly`,'--mount',`type=bind,source=${contextFile},target=/context/request.json,readonly`,'--env',`KONTOUR_PROVIDER_CAPABILITY=${providerProxy.capability}`,'--env','CODEX_HOME=/tmp/codex-home','--workdir','/workspace','-i',image,'sh','-c',bootstrap,'worker',providerConfig,'codex','exec','--json','--skip-git-repo-check','--dangerously-bypass-approvals-and-sandbox','--config','model_provider="kontour_proxy"','--config','model_providers.kontour_proxy.name="OpenAI via scoped host proxy"','--config',`model_providers.kontour_proxy.base_url=${JSON.stringify(providerProxy.baseUrl)}`,'--config','model_providers.kontour_proxy.env_key="KONTOUR_PROVIDER_CAPABILITY"','--config','model_providers.kontour_proxy.wire_api="responses"','--config','model_providers.kontour_proxy.requires_openai_auth=false','--config','model_providers.kontour_proxy.supports_websockets=false','--config',`model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,'--model',model,'-'];
 must(typeof runId==='string'&&/^[a-z0-9][a-z0-9._-]*$/.test(runId),'runId required for worker termination');argv.splice(4,0,'--label',`kontour.worker.run=${runId}`);
 for(const [key,value]of Object.entries(workspaceSetup?.environment??{})){must(/^[A-Z][A-Z0-9_]*$/.test(key)&&typeof value==='string'&&!value.includes('\0')&&!['CODEX_HOME','KONTOUR_PROVIDER_CAPABILITY','HOME','PATH','LD_PRELOAD','NODE_OPTIONS'].includes(key),'safe host environment required');argv.splice(4,0,'--env',`${key}=${value}`);}
 for(const mount of extraMounts)argv.splice(4,0,'--mount',`type=bind,source=${mount.source},target=${mount.destination},readonly`);
 const created=sync(argv);must(/^[a-f0-9]{64}$/.test(created),'observed container ID missing');
 let terminal,observed,parsed=null,storageViolation=null,storageTimer;
 try {
  const inspected=JSON.parse(sync(['docker','inspect',created]))[0];
  const expectedMounts=[['/workspace',workspace,!readOnlyWorkspace],['/treatment',sourceRoot,false],['/context/request.json',contextFile,false]];
  expectedMounts.push(...extraMounts.map(m=>[m.destination,m.source,false]));
  must(inspected.Image===image&&inspected.Mounts.length===expectedMounts.length,'worker image or mount count mismatch');
  for(const [destination,source,rw]of expectedMounts){const mount=inspected.Mounts.find(m=>m.Destination===destination);must(mount&&mount.Source===source&&mount.RW===rw,`worker mount mismatch: ${destination}`);}
  must(inspected.HostConfig.Privileged===false&&inspected.HostConfig.ReadonlyRootfs===true,'unsafe worker security configuration');
  const contextBytes=await readFile(contextFile);const context=JSON.parse(contextBytes);
  observed={storage_admission:admission,canonical_workspace:context.canonical_workspace??null,source_fork_digest:await workspaceRevision(workspace),unit_scope:context.unit_scope??null,read_only_workspace:readOnlyWorkspace,context_digest:`sha256:${hash(await readFile(contextFile))}`,container_id:created,invocation_id:invocationId,image,argv_model:model,reasoning_effort:reasoningEffort,reasoning_observation:'explicit CLI argv and private user config; actual upstream request observed by host proxy',model_observation:'effective-client-request-model; server physical model unverified',provider:'openai',provider_observation:'host-scoped OpenAI Responses proxy; upstream identity from proxy host observation; server model identity unverified',mounts:inspected.Mounts.map(m=>({destination:m.Destination,source:m.Source,rw:m.RW})),network:inspected.HostConfig.NetworkMode,read_only_root:true,controller_mounted:false,hidden_oracles_mounted:false};
  const prompt=workspaceSetup?.prompt??`Execute the following exact stage request. The frozen treatment files are available at /treatment. Work only within the permitted output scope and return the requested structured result.\n\n${contextBytes.toString()}`;
  if(typeof prompt!=='string'||!prompt)throw new Error('Worker prompt missing');
  observed.host_setup=workspaceSetup?.metadata??null;
  observed.initial_prompt_digest=`sha256:${hash(prompt)}`;observed.stdin_digest=observed.initial_prompt_digest;
  await writeFile(path.join(artifactRoot,`${invocationId}.context.json`),contextBytes,{flag:'wx',mode:0o400});
  await writeFile(path.join(artifactRoot,`${invocationId}.stdin.txt`),prompt,{flag:'wx',mode:0o400});
  storageTimer=watchStorage(budget,()=>exec(['docker','kill',created]));
  terminal=await exec(['docker','start','--attach','--interactive',created],{input:prompt,timeoutMs,signal});
  const version=sync(['docker','run','--rm','--network','none',image,'codex','--version']);
  const binary=sync(['docker','run','--rm','--network','none',image,'sh','-c','sha256sum "$(readlink -f "$(command -v codex)")"']);
  observed.harness='codex';observed.harness_version=version.replace(/^codex-cli\s+/,'');observed.cli_entrypoint_digest=`sha256:${binary.split(/\s+/)[0]}`;
  if(terminal.status===0&&!terminal.timeout&&!terminal.overflow)try{parsed=parseCodexEvents(terminal.stdout);}catch{}
 } finally {storageViolation=storageTimer?.violation??null;storageTimer?.close();const removed=await exec(['docker','rm','-f',created]);must(removed.status===0,'worker container termination unverified');}
 const finalStorage=await inspectStorage(budget);if(!finalStorage.allowed&&!storageViolation)storageViolation=finalStorage;
 if(storageViolation){terminal.stdout=terminal.stdout.slice(-65536);terminal.stderr=terminal.stderr.slice(-65536);parsed=null;}
 const receipt={schema:'kontour.flow-agents.docker_worker_receipt',version:'1.0',observed,storage_violation:storageViolation,terminal:{status:terminal.status,timeout:terminal.timeout,overflow:terminal.overflow,signal:terminal.signal??null},provider_thread_id:parsed?.provider_thread_id??null,usage:parsed?.usage??{complete:false,source:'unavailable'},final:parsed?.final?.split(providerProxy.capability).join('[redacted-capability]')??null,container_removed:true,stdout_digest:`sha256:${hash(terminal.stdout.split(providerProxy.capability).join('[redacted-capability]'))}`,stderr_digest:`sha256:${hash(terminal.stderr.split(providerProxy.capability).join('[redacted-capability]'))}`};
 await writeFile(path.join(artifactRoot,`${invocationId}.stdout.jsonl`),terminal.stdout.split(providerProxy.capability).join('[redacted-capability]'),{flag:'wx',mode:0o400});await writeFile(path.join(artifactRoot,`${invocationId}.stderr.log`),terminal.stderr.split(providerProxy.capability).join('[redacted-capability]'),{flag:'wx',mode:0o400});await writeFile(path.join(artifactRoot,`${invocationId}.receipt.json`),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o400});
 return receipt;
}
