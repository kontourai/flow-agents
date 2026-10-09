import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadRun, runDir } from '@kontourai/flow';
import { digest } from './compile.mjs';
import { readArtifact } from './artifacts.mjs';
import { snapshotWorkspace } from './runtime.mjs';

function invoke(argv,options={}){const result=spawnSync(argv[0],argv.slice(1),{encoding:'utf8',timeout:options.timeout??30000,maxBuffer:2*1024*1024});if(result.error||result.status!==0)throw new Error(result.error?.message??result.stderr??'Command failed');return result.stdout.trim();}
function flowCli(){let root=path.dirname(fileURLToPath(import.meta.resolve('@kontourai/flow')));for(let i=0;i<6;i++){try{const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));if(manifest.name==='@kontourai/flow')return path.join(root,manifest.bin.flow);}catch(error){if(error.code!=='ENOENT')throw error;}root=path.dirname(root);}throw new Error('Public Flow CLI unavailable');}

/** Checks get a byte-bound private copy. Writable build/test outputs never
 * grant source publication or a writable mount of the canonical workspace. */
export function prepareCheckWorkspace({workspace,controllerRoot,basis=[]}){
  workspace=fs.realpathSync(workspace);controllerRoot=fs.realpathSync(controllerRoot);
  const rel=path.relative(workspace,controllerRoot);if(!rel||rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel))throw new Error('Check controller must be outside canonical source');
  if(!Array.isArray(basis)||basis.length>512)throw new Error('Check basis must be bounded');
  const observe=()=>{
    const source=snapshotWorkspace(workspace),files=new Map(source.files.map(file=>[file.path,file]));
    const artifactRoot=path.join(workspace,'.aidlc/artifacts');let artifactBytes=0;
    const visit=(file)=>{
      const stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw new Error('Check artifacts cannot contain symlinks');
      if(stat.isDirectory()){for(const name of fs.readdirSync(file).sort())visit(path.join(file,name));return;}
      const value=readArtifact(workspace,path.relative(workspace,file));artifactBytes+=value.bytes;
      if(files.size>=10512||artifactBytes>16*1024*1024)throw new Error('Check artifacts exceed finite budget');
      files.set(value.path,{path:value.path,digest:value.digest,bytes:value.bytes});
    };
    if(fs.existsSync(artifactRoot))visit(artifactRoot);
    for(const local of ['.aidlc/state.md','.aidlc/project-description.json'])if(fs.existsSync(path.join(workspace,local)))visit(path.join(workspace,local));
    for(const ref of basis){const value=readArtifact(workspace,ref.path);const expected=ref.sha256??ref.digest;if(!expected||expected!==value.digest)throw new Error(`Stale command basis: ${ref.path}`);files.set(value.path,{path:value.path,digest:value.digest,bytes:value.bytes});}
    return {source_digest:source.source_digest,files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path))};
  };
  const before=observe(),base=path.join(controllerRoot,'check-workspaces');fs.mkdirSync(base,{recursive:true,mode:0o700});
  const fork=fs.mkdtempSync(path.join(base,'check-'));
  const assertCurrent=()=>{if(digest(observe())!==digest(before))throw new Error('Canonical source/artifact basis changed during check');};
  try{
    for(const file of before.files){const source=path.join(workspace,file.path),bytes=fs.readFileSync(source);if(digest(bytes)!==file.digest)throw new Error('Source changed while check fork copied');const dest=path.join(fork,file.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes,{flag:'wx',mode:fs.statSync(source).mode&0o777});}
    assertCurrent();
  }catch(error){fs.rmSync(fork,{recursive:true,force:true});throw error;}
  return {workspace:fork,before,basis_digest:digest(before),assertCurrent,close:()=>fs.rmSync(fork,{recursive:true,force:true})};
}

/** Public Flow capture + isolated source command; no model or grader authority. */
export function createCommandRunner({workspace,controllerRoot,runId,image,currentStage}){
  return async function commandRunner({id,command,cwd=workspace,timeoutMs=120000,maxOutputBytes=1024*1024,basis=[]}){
    const actual=fs.realpathSync(cwd);const relative=path.relative(fs.realpathSync(workspace),actual);if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error('Check cwd escapes source workspace');
    if(!/^sha256:[a-f0-9]{64}$/.test(image))throw new Error('Immutable check image required');
    const argv=Array.isArray(command)?command:['sh','-lc',command];if(!argv.length||argv.length>128||!argv.every(arg=>typeof arg==='string'&&arg.length<8192))throw new Error('Invalid check argv');
    const name=`aidlc-check-${randomUUID()}`;let container,check;
    try{
      check=prepareCheckWorkspace({workspace,controllerRoot,basis});
      container=invoke(['docker','create','--name',name,'--label',`kontour.evals.run=${runId}`,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory','2g','--cpus','2','--tmpfs','/tmp:rw,nosuid,size=1g','--mount',`type=bind,source=${check.workspace},target=/workspace`,'--workdir',path.posix.join('/workspace',relative.split(path.sep).join('/')),image,...argv]);
      const inspected=JSON.parse(invoke(['docker','inspect',container]))[0];if(inspected.Image!==image||inspected.Mounts.length!==1||inspected.Mounts[0].Destination!=='/workspace'||fs.realpathSync(inspected.Mounts[0].Source)!==check.workspace)throw new Error('Check container boundary mismatch');
      const run=await loadRun(runId,controllerRoot);
      const captured=spawnSync(process.execPath,[flowCli(),'capture',runId,'--gate',`${currentStage?.()??run.state.current_step}-gate`,'--kind','command','--cwd',controllerRoot,'--timeout',String(timeoutMs),'--','docker','start','--attach',container],{encoding:'utf8',timeout:timeoutMs+15000,maxBuffer:1024*1024});if(captured.error)throw captured.error;
      const observedId=/^attached evidence: (\S+)$/m.exec(captured.stdout)?.[1];const updated=await loadRun(runId,controllerRoot);const entry=updated.manifest.evidence.find(value=>value.id===observedId);if(!entry?.stored_path)throw new Error(`No command capture: ${captured.stderr}`);
      const bytes=fs.readFileSync(path.join(runDir(runId,controllerRoot),entry.stored_path));if(digest(bytes)!==entry.sha256)throw new Error('Captured check receipt drift');const receipt=JSON.parse(bytes.toString('utf8'));if(JSON.stringify(receipt.command)!==JSON.stringify(['docker','start','--attach',container]))throw new Error('Check receipt belongs to another process');
      const stdout=receipt.stdout.content,stderr=receipt.stderr.content;if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>maxOutputBytes)throw new Error('Check output exceeds sensor budget');
      check.assertCurrent();
      return {exitCode:receipt.timed_out?null:receipt.exit_code,stdout,stderr,receipt:{...receipt,id:entry.id,digest:entry.sha256,image,command:argv,source_cwd:actual,canonical_source_digest:check.before.source_digest,check_input_digest:check.basis_digest,basis},evidence_refs:[{path:entry.stored_path,sha256:entry.sha256}]};
    }finally{try{if(container)invoke(['docker','rm','-f',container]);}finally{check?.close();}}
  };
}

/** Only explicit test instructions become host-run commands; arbitrary prose is not code. */
function assertSingleTestCommand(command){
  let quote=null,escaped=false;
  for(let i=0;i<command.length;i++){
    const char=command[i];
    if(escaped){escaped=false;continue;}
    if(quote==="'"){if(char==="'")quote=null;continue;}
    if(char==='\\'){escaped=true;continue;}
    if(quote==='"'){
      if(char==='"'){quote=null;continue;}
      if(char==='$'||char==='`')throw new Error('Planned test command cannot contain shell expansion');
      continue;
    }
    if(char==='"'||char==="'"){quote=char;continue;}
    if('|&;<>()$`'.includes(char))throw new Error('Planned tests require one test command, without shell control operators or expansion');
    if(char==='#'&&(i===0||/\s/.test(command[i-1])))break;
  }
  if(quote||escaped)throw new Error('Planned test command has an unfinished quote or continuation');
}

export function plannedTestCommands(text){
  const commands=[];
  for(const match of text.matchAll(/^```(?:bash|sh|shell)\s*\n([^]*?)^```\s*$/gm))for(const line of match[1].split('\n')){
    const trimmed=line.trim();if(/^(?:node\s+--test\b|npm\s+(?:test\b|run\s+test[\w:-]*\b)|python(?:3)?\s+-m\s+pytest\b|pytest\b|cargo\s+test\b|go\s+test\b|dotnet\s+test\b|mvn\s+test\b)/.test(trimmed)){assertSingleTestCommand(trimmed);commands.push(trimmed);}
  }
  return [...new Set(commands)];
}
