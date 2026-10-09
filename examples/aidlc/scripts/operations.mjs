import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {digest} from './compile.mjs';
import {readArtifact} from './artifacts.mjs';

/** Operator-configured command operations; argv and output proof are host-owned. */
export function createCommandOperationProvider({config,commandRunner,controllerRoot}) {
  if(!config?.stages||typeof commandRunner!=='function')throw new Error('Explicit stage command config and host command runner required');
  const root=path.join(controllerRoot,'operations');fs.mkdirSync(root,{recursive:true,mode:0o700});
  function plan(input){const selected=config.stages[input.stage.slug];if(!selected||!Array.isArray(selected.argv)||!selected.argv.length||selected.argv.some(arg=>typeof arg!=='string'||!arg||arg.includes('\0'))||!Array.isArray(selected.outputs)||!selected.outputs.length||selected.outputs.length>128)throw new Error('Operation requires operator argv and output files');if(selected.outputs.some(file=>typeof file!=='string'||!file||path.isAbsolute(file)||file.split(/[\\/]/).includes('..')))throw new Error('Operation outputs must stay in the authorized workspace');return selected;}
  return {
    async execute(input,{signal}={}){
      const selected=plan(input),timeoutMs=selected.timeout_ms??120000;if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new Error('Invalid operation timeout');
      const admission=path.join(root,`${digest({request:input.request_digest,stage:input.stage.slug})}.attempt.json`);
      if(fs.existsSync(admission))return {status:'failed',reason:'operation_reentry_requires_new_registration'};
      fs.writeFileSync(admission,JSON.stringify({input_digest:digest(input),plan_digest:digest(selected)})+'\n',{flag:'wx',mode:0o600});
      const result=await commandRunner({id:`operation-${input.stage.slug}`,command:structuredClone(selected.argv),cwd:input.workspace,timeoutMs,maxOutputBytes:1024*1024,basis:[{input_digest:digest(input)}],signal});
      if(result?.exitCode!==0||!result.receipt)return {status:'failed',command_result:result??null};
      const outputs=selected.outputs.map(file=>{const observed=readArtifact(input.workspace,file);return {path:file,digest:observed.digest};});
      const receipt={id:randomUUID(),status:'completed',input_digest:digest(input),plan_digest:digest(selected),command_receipt:result.receipt,outputs};
      fs.writeFileSync(path.join(root,`${receipt.id}.json`),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});return receipt;
    },
    async verify(receipt,input){
      if(!receipt||!/^[-a-zA-Z0-9]+$/.test(receipt.id??''))return false;
      try{const retained=JSON.parse(fs.readFileSync(path.join(root,`${receipt.id}.json`),'utf8'));return digest(retained)===digest(receipt)&&receipt.input_digest===digest(input)&&receipt.plan_digest===digest(plan(input))&&receipt.outputs.every(ref=>readArtifact(input.workspace,ref.path).digest===ref.digest);}catch{return false;}
    }
  };
}

/** Actual host operation execution; operator argv, fixed cwd, bounded group lifetime. */
export function createOperationCommandRunner({workspace,controllerRoot}) {
  const admitted=fs.realpathSync(workspace),root=path.join(controllerRoot,'operation-commands');fs.mkdirSync(root,{recursive:true,mode:0o700});
  return async input=>{
    if(fs.realpathSync(input.cwd)!==admitted||!Array.isArray(input.command)||!input.command.length||input.command.some(arg=>typeof arg!=='string'||!arg||arg.includes('\0')))throw new Error('Operation argv/cwd outside host admission');
    if(!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<1||input.timeoutMs>3600000||!Number.isSafeInteger(input.maxOutputBytes)||input.maxOutputBytes<1||input.maxOutputBytes>1024*1024)throw new Error('Operation process budget required');
    const id=randomUUID(),started=Date.now();let bytes=0,output=[],overflow=false,timedOut=false,cancelled=false;
    const child=spawn(input.command[0],input.command.slice(1),{cwd:admitted,env:process.env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    const kill=()=>{try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
    const capture=chunk=>{bytes+=chunk.length;if(bytes>input.maxOutputBytes){overflow=true;kill();return;}output.push(Buffer.from(chunk));};
    child.stdout.on('data',capture);child.stderr.on('data',capture);
    const abort=()=>{cancelled=true;kill();};input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)abort();
    const timer=setTimeout(()=>{timedOut=true;kill();},input.timeoutMs);
    let error=null,exitCode;
    try{exitCode=await new Promise(resolve=>{child.once('error',err=>{error=err.message;resolve(null);});child.once('close',resolve);});}
    finally{clearTimeout(timer);input.signal?.removeEventListener('abort',abort);}
    const receipt={id,command:input.command,cwd:admitted,basis:input.basis,exit_code:exitCode,timeout:timedOut,cancelled,overflow,error,output_digest:digest(Buffer.concat(output)),elapsed_ms:Date.now()-started};
    fs.writeFileSync(path.join(root,`${id}.json`),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
    return {exitCode:timedOut||cancelled||overflow||error?null:exitCode,receipt};
  };
}
