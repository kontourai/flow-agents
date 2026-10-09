import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startRun, loadRun, runDir } from '@kontourai/flow';
import { readArtifact } from './artifacts.mjs';
import { digest } from './compile.mjs';

// Reuse Flow's public capture CLI and persisted command receipts. This adapter
// owns input/output packaging, never process supervision or semantic grading.
export async function captureRun({ caseSpec, config, cwd }) {
  if (!config || !Array.isArray(config.argv) || !config.argv.length || config.argv.length > 32 || !config.argv.every((item) => typeof item === 'string' && item.length < 8192)) throw new Error('Run adapter needs bounded explicit argv');
  if (config.argv.filter((item) => item === '{case_file}').length !== 1) throw new Error('Adapter argv must receive exactly one {case_file} input');
  for (const key of ['revision', 'model', 'harness']) if (typeof config.identity?.[key] !== 'string' || !config.identity[key]) throw new Error(`Missing configured ${key}`);
  if (!Number.isSafeInteger(config.budget?.max_tokens) || config.budget.max_tokens <= 0) throw new Error('Run adapter requires a positive token budget');
  if (!Array.isArray(caseSpec.artifact_checks) || caseSpec.artifact_checks.length > 128) throw new Error('Case needs a bounded artifact rubric');
  const targets = new Set();
  for (const check of caseSpec.artifact_checks) {
    if (typeof check.path !== 'string' || !check.path || isAbsolute(check.path)) throw new Error('Output targets must be relative');
    const target = resolve(cwd, check.path);
    const rel = relative(resolve(cwd), target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || targets.has(target)) throw new Error('Output targets must be unique and inside the workspace');
    targets.add(target);
    try { lstatSync(target); throw new Error(`Benchmark output already exists: ${check.path}; use a fresh output workspace`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const timeout = config.timeout_ms ?? 300000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000) throw new Error('Invalid adapter timeout');
  const scratch = mkdtempSync(join(tmpdir(), 'aidlc-case-input-'));
  const runId = `aidlc-capture-${randomUUID()}`;
  const definition = { id: 'aidlc.output-capture', version: '1.0', steps: [{id:'capture',next:null}], gates: {'capture-gate':{step:'capture',expects:[]}} };
  try {
    const input = join(scratch, 'case.json');
    const definitionPath = join(scratch, 'capture.flow.json');
    writeFileSync(input, JSON.stringify({schema_version:'1.0',case:caseSpec,budget:config.budget}) + '\n');
    writeFileSync(definitionPath, JSON.stringify(definition));
    await startRun(definitionPath, {cwd,runId,params:{subject:`benchmark:${caseSpec.id}`}});
    let packageRoot = dirname(fileURLToPath(import.meta.resolve('@kontourai/flow')));
    let manifest;
    for (let i=0; i<6; i++) {
      try { const candidate=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8')); if(candidate.name==='@kontourai/flow'){manifest=candidate;break;} } catch(error){if(error.code!=='ENOENT')throw error;}
      packageRoot=dirname(packageRoot);
    }
    if(!manifest?.bin?.flow) throw new Error('Installed Flow does not expose its public capture CLI');
    const argv=config.argv.map(arg=>arg==='{case_file}'?input:arg);
    const command=spawnSync(process.execPath,[join(packageRoot,manifest.bin.flow),'capture',runId,'--gate','capture-gate','--kind','command','--cwd',cwd,'--timeout',String(timeout),'--',...argv],{encoding:'utf8',timeout:timeout+15000,maxBuffer:1024*1024});
    if(command.error) throw new Error(`Flow command capture failed: ${command.error.message}`);
    const run=await loadRun(runId,cwd);
    const entry=run.manifest.evidence.at(-1);
    if(!entry?.stored_path) throw new Error(`Flow capture produced no persisted command receipt: ${command.stderr}`);
    const receiptBytes=readFileSync(join(runDir(runId,cwd),entry.stored_path));
    if(digest(receiptBytes)!==entry.sha256) throw new Error('Persisted command receipt integrity mismatch');
    const receipt=JSON.parse(receiptBytes.toString('utf8'));
    if(JSON.stringify(receipt.command)!==JSON.stringify(argv)) throw new Error('Flow command receipt does not match the requested adapter');
    const artifacts={};const artifact_errors=[];
    for(const check of caseSpec.artifact_checks){try{artifacts[check.path]=readArtifact(cwd,check.path).text;}catch(error){artifact_errors.push({path:check.path,reason:error.message});}}
    return {schema_version:'1.0',status:receipt.exit_code===0&&!receipt.timed_out?'completed':'failed',
      identity:config.identity,identity_basis:'configured-adapter; revision/model require external verification',input_digest:digest(caseSpec.input),budget:config.budget,artifacts,artifact_errors,
      execution:{flow_run_id:runId,receipt_sha256:entry.sha256,command:receipt.command,exit_code:receipt.exit_code,signal:receipt.signal,timed_out:receipt.timed_out,output_sha256:receipt.output_sha256,elapsed_ms:receipt.duration_ms},
      economics:null,semantic_quality:'not_verified'};
  } finally {rmSync(scratch,{recursive:true,force:true});}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.length!==4)throw new Error('Usage: capture-run.mjs <case.json> <adapter.json> <workspace> <result.json>');
  const [caseFile,adapterFile,cwd,output]=args;
  const result=await captureRun({caseSpec:JSON.parse(readFileSync(caseFile,'utf8')),config:JSON.parse(readFileSync(adapterFile,'utf8')),cwd:resolve(cwd)});
  writeFileSync(output,JSON.stringify(result,null,2)+'\n');process.exitCode=result.status==='completed'?0:1;
}
