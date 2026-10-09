import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep the independently importable example tests in the ordinary CI route.
// They consume installed public packages and private fixture workspaces.
test('AI-DLC execution boundaries and public lifecycle regressions', { timeout: 120000 }, async () => {
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const directory=fileURLToPath(new URL('../../examples/aidlc/evals/',import.meta.url));
  const files=readdirSync(directory).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>`${directory}${name}`);
  assert.ok(files.length>=8,'Execution regression modules must be present');
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,['--test','--test-reporter=tap','--test-concurrency=2',...files],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{output+=bytes.toString();if(output.length>1024*1024)child.kill('SIGTERM');});
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  if(result.code!==0||result.signal){const file=path.join(mkdtempSync(path.join(os.tmpdir(),'aidlc-test-evidence-')),'output.log');writeFileSync(file,output);output+=`\nFull retained test output: ${file}\n`;}
  assert.equal(result.signal,null,output);assert.equal(result.code,0,output);
  const count=/^# tests (\d+)$/m.exec(output);assert.ok(count&&Number(count[1])>=80,`No complete execution test run observed: ${output}`);
});
