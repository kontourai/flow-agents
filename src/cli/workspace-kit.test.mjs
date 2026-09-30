import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";
import { inspectWorkspaceKits, resolveWorkspaceKits, parseWorkspaceKitDeclaration, parseWorkspaceKitLock } from "@kontourai/flow-agents/workspace-kits";
const fixtureRoots = new Set();
after(() => {
  function thaw(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    fs.chmodSync(file, stat.isDirectory() ? 0o755 : 0o644);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) thaw(path.join(file, name));
  }
  for (const root of fixtureRoots) { thaw(root); fs.rmSync(root, { recursive: true }); }
});
const CLI = path.resolve("build/src/cli.js");
const TEMPLATE = path.resolve("evals/fixtures/flow-kit-repository/valid-local-kit");
const declarationPath = scope => path.join(scope, ".flow-agents/workspace.kits.json");
const lockPath = scope => path.join(scope, ".flow-agents/workspace.kits.lock.json");
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); }
function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function kit(root, id, dependencies = []) {
  fs.cpSync(TEMPLATE, root, { recursive: true });
  const manifest = read(path.join(root, "kit.json"));
  manifest.id = id; manifest.dependencies = dependencies;
  write(path.join(root, "kit.json"), manifest);
}
function fixture() {
  const root = makeFixtureDir("workspace-kit-");
  fixtureRoots.add(root);
  const scope = path.join(root, "scope"); const cache = path.join(root, "cache");
  fs.mkdirSync(scope); fs.mkdirSync(cache);
  const alpha = path.join(root, "alpha"); const beta = path.join(root, "beta");
  kit(alpha, "alpha", [{ kit_id: "beta", reason: "Neutral fixture dependency" }]); kit(beta, "beta");
  const declaration = { schema_version: "1.0", selected: ["alpha"], sources: { alpha: { kind: "local", alias: "alpha-source" }, beta: { kind: "local", alias: "beta-source" } }, options: {}, provider_bindings: {}, contributions: "all" };
  write(declarationPath(scope), declaration);
  const bindings = { "alpha-source": alpha, "beta-source": beta };
  const bindingFile = path.join(root, "bindings.json"); write(bindingFile, bindings);
  return { root, scope, cache, alpha, beta, declaration, bindings, bindingFile };
}
function cli(f, command, extra = []) {
  const run = spawnSync(process.execPath, [CLI, "kit", "workspace", command, "--scope", f.scope, "--cache", f.cache, ...extra], { cwd: f.scope, encoding: "utf8", timeout: 20000 });
  assert.equal(run.signal, null, run.stderr); assert.equal(run.error, undefined);
  return { exit: run.status, ...JSON.parse(run.stdout) };
}
function resolve(f, extra = []) { return cli(f, "resolve", ["--bindings", f.bindingFile, ...extra]); }
function payload(f, artifact) { return path.join(f.cache, "artifacts/kit-tree-v1", artifact.digest.slice(7), "payload"); }
function snapshot(root) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map(item => [item.name, fs.lstatSync(path.join(root,item.name)).mode, item.isDirectory() ? snapshot(path.join(root,item.name)) : fs.readFileSync(path.join(root,item.name)).toString("base64")]);
}
test("public non-Git CLI resolves required external closure, shares cache, keeps portable lock and inspects offline without writes", async () => {
  const f = fixture();
  const first = resolve(f); assert.equal(first.exit, 0); assert.equal(first.status, "verified"); assert.equal(first.lock.artifacts.length, 2);
  assert.equal(fs.existsSync(path.join(f.scope, ".git")), false);
  assert.equal(fs.readFileSync(lockPath(f.scope), "utf8").includes(f.root), false);
  const other = path.join(f.root, "other"); fs.mkdirSync(other); write(declarationPath(other), f.declaration);
  const second = resolve({ ...f, scope: other }); assert.equal(second.status, "verified"); assert.deepEqual(second.lock, first.lock);
  const beforeLock = fs.readFileSync(lockPath(f.scope));
  fs.rmSync(f.alpha, { recursive: true }); fs.rmSync(f.beta, { recursive: true }); fs.rmSync(f.bindingFile);
  const before = [snapshot(f.scope), snapshot(f.cache)];
  assert.equal(cli(f,"inspect").status,"verified");
  assert.deepEqual([snapshot(f.scope), snapshot(f.cache)], before);
  assert.equal(cli(f,"resolve").status,"verified");
  assert.deepEqual(fs.readFileSync(lockPath(f.scope)),beforeLock);
  assert.equal((await inspectWorkspaceKits(f)).status,"verified");
});
test("explicit update permits coexisting versions; declaration drift retains previous lock identity", () => {
  const f = fixture(); const first = resolve(f); assert.equal(first.status,"verified");
  const before = fs.readFileSync(lockPath(f.scope));
  fs.appendFileSync(path.join(f.alpha,"docs/README.md"),"Version two\n");
  assert.deepEqual(resolve(f).lock,first.lock);
  const updated = resolve(f,["--update"]); assert.equal(updated.status,"verified"); assert.notDeepEqual(updated.lock,first.lock);
  assert.equal(fs.existsSync(payload(f,first.lock.artifacts[0])),true);
  assert.equal(fs.readdirSync(path.join(f.cache,"artifacts/kit-tree-v1")).length,3);
  f.declaration.selected=["beta"];write(declarationPath(f.scope),f.declaration);
  const changed=cli(f,"inspect");assert.equal(changed.status,"stale-declaration");assert.deepEqual(changed.lock,updated.lock);
  assert.equal(resolve(f).status,"stale-declaration");
  assert.notDeepEqual(fs.readFileSync(lockPath(f.scope)),before);
  assert.equal(resolve(f,["--update"]).status,"verified");
});
test("cache corruption is refused even with source available and update requested; prior lock preserved", () => {
  const f=fixture();const first=resolve(f);assert.equal(first.status,"verified");const before=fs.readFileSync(lockPath(f.scope));
  const file=path.join(payload(f,first.lock.artifacts[0]),"docs/README.md");fs.chmodSync(file,0o644);fs.appendFileSync(file,"corrupt");
  assert.equal(cli(f,"inspect").status,"corrupt");assert.equal(resolve(f).status,"corrupt");assert.equal(resolve(f,["--update"]).status,"corrupt");
  assert.deepEqual(fs.readFileSync(lockPath(f.scope)),before);
});
test("missing locked bytes reacquire only exact identity, with no bundled fallback", () => {
  const f=fixture();const first=resolve(f);assert.equal(first.status,"verified");const before=fs.readFileSync(lockPath(f.scope));
  const entry=path.dirname(payload(f,first.lock.artifacts[0]));
  function writable(dir){fs.chmodSync(dir,0o755);for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())writable(file);else fs.chmodSync(file,0o644);}}
  writable(entry);fs.rmSync(entry,{recursive:true});
  assert.equal(cli(f,"resolve").status,"missing");
  fs.appendFileSync(path.join(f.alpha,"docs/README.md"),"wrong bytes");
  assert.equal(resolve(f).status,"corrupt");assert.deepEqual(fs.readFileSync(lockPath(f.scope)),before);
});
test("strict unsupported declarations, required edges, conflicts and containers refuse before lock publication", async t => {
  const cases = [
    ["nonempty options", f=>{f.declaration.options={enabled:true};write(declarationPath(f.scope),f.declaration);},"unsupported"],
    ["provider binding", f=>{f.declaration.provider_bindings={github:{}};write(declarationPath(f.scope),f.declaration);},"unsupported"],
    ["unknown field", f=>{f.declaration.inherits=true;write(declarationPath(f.scope),f.declaration);},"unsupported"],
    ["missing dependency source", f=>{delete f.declaration.sources.beta;write(declarationPath(f.scope),f.declaration);},"missing"],
    ["unknown dependency semantics", f=>{const m=read(path.join(f.alpha,"kit.json"));m.dependencies[0].optional=true;write(path.join(f.alpha,"kit.json"),m);},"unsupported"],
    ["dependency cycle", f=>{const m=read(path.join(f.beta,"kit.json"));m.dependencies=[{kit_id:"alpha"}];write(path.join(f.beta,"kit.json"),m);},"corrupt"],
    ["manifest identity conflict", f=>{const m=read(path.join(f.beta,"kit.json"));m.id="alpha";write(path.join(f.beta,"kit.json"),m);},"corrupt"],
    ["pruned declared asset", f=>{const m=read(path.join(f.beta,"kit.json"));m.docs[0].path=".git/secret.md";write(path.join(f.beta,"kit.json"),m);fs.mkdirSync(path.join(f.beta,".git"));fs.writeFileSync(path.join(f.beta,".git/secret.md"),"private");},"corrupt"],
    ["source symlink", f=>fs.symlinkSync(f.beta,path.join(f.alpha,"linked")),"corrupt"],
    ["unsupported schema", f=>{const m=read(path.join(f.beta,"kit.json"));m.schema_version="2.0";write(path.join(f.beta,"kit.json"),m);},"unsupported"],
  ];
  for(const [name,change,status] of cases) await t.test(name,()=>{const f=fixture();change(f);const result=resolve(f);assert.equal(result.status,status,JSON.stringify(result));assert.equal(result.exit,2);assert.equal(fs.existsSync(lockPath(f.scope)),false);});
});
test("inspect validates closure rather than trusting tampered lock metadata", () => {
  const f=fixture();assert.equal(resolve(f).status,"verified");const lock=read(lockPath(f.scope));lock.artifacts[0].dependencies=[];lock.artifacts=lock.artifacts.slice(0,1);write(lockPath(f.scope),lock);
  assert.equal(cli(f,"inspect").status,"corrupt");
  assert.throws(()=>parseWorkspaceKitLock({...lock,artifacts:[...lock.artifacts,...lock.artifacts]}));
  assert.throws(()=>parseWorkspaceKitDeclaration({...f.declaration,selected:["alpha","alpha"]}));
});
test("explicit roots are mandatory; root and path symlinks cannot redirect reads or writes", async () => {
  const f=fixture();assert.equal((await inspectWorkspaceKits({...f,scope:"."})).status,"unsupported");
  assert.equal((await resolveWorkspaceKits({...f,cache:f.scope})).status,"corrupt");
  const link=path.join(f.root,"scope-link");fs.symlinkSync(f.scope,link);assert.equal(cli({...f,scope:link},"inspect").status,"corrupt");
  const config=path.join(f.scope,".flow-agents");fs.renameSync(config,path.join(f.root,"config"));fs.symlinkSync(path.join(f.root,"config"),config);
  assert.equal(resolve(f).status,"corrupt");
});
test("operation markers refuse without stale PID reclamation or inspection writes", () => {
  const f=fixture();assert.equal(resolve(f).status,"verified");fs.mkdirSync(path.join(f.scope,".kontourai/flow-agents/workspace-kit.lock"));
  const before=[snapshot(f.scope),snapshot(f.cache)];assert.equal(cli(f,"inspect").status,"busy");assert.equal(resolve(f).status,"busy");assert.deepEqual([snapshot(f.scope),snapshot(f.cache)],before);
});
function pausedChild(f, boundary) {
  const preload=path.join(f.root,`pause-${boundary}.cjs`);const resume=path.join(f.root,`resume-${boundary}`);
  fs.writeFileSync(preload,`const fs=require('node:fs');const {syncBuiltinESMExports}=require('node:module');const rename=fs.renameSync;let paused=false;fs.renameSync=function(from,to){const match=${JSON.stringify(boundary)}==='artifact'?String(to).includes('/artifacts/kit-tree-v1/'):String(to).endsWith('/workspace.kits.lock.json');if(match&&!paused){paused=true;if(${JSON.stringify(boundary)}==='artifact')rename.apply(this,arguments);fs.writeSync(1,'WORKSPACE_TEST_BOUNDARY\\n');while(!fs.existsSync(${JSON.stringify(resume)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);if(${JSON.stringify(boundary)}==='artifact')return;}return rename.apply(this,arguments);};syncBuiltinESMExports();`);
  const child=spawn(process.execPath,["--require",preload,CLI,"kit","workspace","resolve","--scope",f.scope,"--cache",f.cache,"--bindings",f.bindingFile,"--update"],{cwd:f.scope,stdio:["ignore","pipe","pipe"]});
  let output="";let errors="";child.stdout.on("data",chunk=>output+=chunk);child.stderr.on("data",chunk=>errors+=chunk);
  const reached=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error(`Boundary not reached: ${output} ${errors}`));},20000);
    child.stdout.on("data",()=>{if(output.includes("WORKSPACE_TEST_BOUNDARY\n")){clearTimeout(timer);resolve();}});
    child.once("exit",()=>{if(!output.includes("WORKSPACE_TEST_BOUNDARY\n")){clearTimeout(timer);reject(new Error(`Child exited before boundary: ${output} ${errors}`));}});
  });
  return {child,reached,resume:()=>fs.writeFileSync(resume,"continue"),output:()=>output,errors:()=>errors};
}
test("concurrent real callers refuse same-scope overlap while owner publishes complete lock", async () => {
  const f=fixture();const paused=pausedChild(f,"lock");
  try { await paused.reached;assert.equal(resolve(f).status,"busy");const exited=once(paused.child,"exit");paused.resume();const [code]=await exited;assert.equal(code,0,paused.errors());assert.equal(cli(f,"inspect").status,"verified"); }
  finally { if(paused.child.exitCode===null&&paused.child.signalCode===null){const exited=once(paused.child,"exit");paused.child.kill("SIGKILL");await exited;} }
});
test("concurrent scopes sharing an artifact do not replace the owner's entry", async () => {
  const f=fixture();const other=path.join(f.root,"other");fs.mkdirSync(other);write(declarationPath(other),f.declaration);
  const paused=pausedChild(f,"artifact");
  try {await paused.reached;assert.equal(resolve({...f,scope:other}).status,"busy");assert.equal(fs.existsSync(lockPath(other)),false);const exited=once(paused.child,"exit");paused.resume();assert.equal((await exited)[0],0,paused.errors());assert.equal(resolve({...f,scope:other}).status,"verified");assert.deepEqual(read(lockPath(other)),read(lockPath(f.scope)));}
  finally {if(paused.child.exitCode===null&&paused.child.signalCode===null){const exited=once(paused.child,"exit");paused.child.kill("SIGKILL");await exited;}}
});
for(const boundary of ["artifact","lock"]) test(`owned process interruption at ${boundary} boundary retains previous lock and shared entries`, async () => {
  const f=fixture();const first=resolve(f);assert.equal(first.status,"verified");const old=fs.readFileSync(lockPath(f.scope));
  const oldPayloads=first.lock.artifacts.map(a=>snapshot(payload(f,a)));
  fs.appendFileSync(path.join(f.alpha,"docs/README.md"),"new version\n");
  const paused=pausedChild(f,boundary);
  try {await paused.reached;const exited=once(paused.child,"exit");paused.child.kill("SIGKILL");assert.equal((await exited)[1],"SIGKILL");assert.deepEqual(fs.readFileSync(lockPath(f.scope)),old);assert.deepEqual(first.lock.artifacts.map(a=>snapshot(payload(f,a))),oldPayloads);assert.equal(cli(f,"inspect").status,"busy");
    // Recovery is an explicit fixture-owner action after proven child termination.
    fs.rmdirSync(path.join(f.scope,".kontourai/flow-agents/workspace-kit.lock"));
    assert.equal(cli(f,"inspect").status,"verified");
  } finally {if(paused.child.exitCode===null&&paused.child.signalCode===null){const exited=once(paused.child,"exit");paused.child.kill("SIGKILL");await exited;}}
});
test("inspect rechecks captured scope bytes and operation state after asynchronous manifest validation", async () => {
  const f=fixture();assert.equal(resolve(f).status,"verified");
  const original=fs.readFileSync(declarationPath(f.scope));
  const pending=inspectWorkspaceKits(f);fs.appendFileSync(declarationPath(f.scope)," ");
  const changed=await pending;assert.equal(changed.status,"corrupt");assert.equal(changed.diagnostics[0].code,"scope-changed");assert.ok(changed.lock_digest);
  fs.writeFileSync(declarationPath(f.scope),original);
  const busy=inspectWorkspaceKits(f);fs.mkdirSync(path.join(f.scope,".kontourai/flow-agents/workspace-kit.lock"));
  assert.equal((await busy).status,"busy");
});
test("resolve detects declaration and prior lock edits before publication without overwriting either", async () => {
  for(const which of ["declaration","lock"]){
    const f=fixture();assert.equal(resolve(f).status,"verified");
    fs.appendFileSync(path.join(f.alpha,"docs/README.md"),"update\n");
    const pending=resolveWorkspaceKits({...f,update:true});
    const file=which==="lock"?lockPath(f.scope):declarationPath(f.scope);fs.appendFileSync(file," ");const edited=fs.readFileSync(file);
    const result=await pending;assert.equal(result.status,"corrupt");assert.equal(result.diagnostics[0].code,"scope-changed");assert.deepEqual(fs.readFileSync(file),edited);
  }
});
test("post-publication cleanup failure remains a typed recovery result with the published lock identity", () => {
  const f=fixture();const preload=path.join(f.root,"cleanup-failure.cjs");
  fs.writeFileSync(preload,`const fs=require('node:fs');const {syncBuiltinESMExports}=require('node:module');const remove=fs.rmSync;fs.rmSync=function(file,...args){if(String(file).includes('/cache/staging/resolve-'))throw new Error('fixture cleanup refusal');return remove.call(this,file,...args);};syncBuiltinESMExports();`);
  const run=spawnSync(process.execPath,["--require",preload,CLI,"kit","workspace","resolve","--scope",f.scope,"--cache",f.cache,"--bindings",f.bindingFile],{cwd:f.scope,encoding:"utf8",timeout:20000});
  assert.equal(run.status,2,run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,"recovery-required");assert.equal(result.diagnostics[0].code,"cleanup-failed");assert.ok(result.lock_digest);assert.deepEqual(result.lock,read(lockPath(f.scope)));assert.equal(fs.existsSync(path.join(f.scope,".kontourai/flow-agents/workspace-kit.lock")),false);
});
test("fixed Kit limits are policy refusals and JSON schemas agree with public parsers", async () => {
  const {default:Ajv2020}=await import("ajv/dist/2020.js");const ajv=new Ajv2020({strict:false});
  const declarationSchema=ajv.compile(read(path.resolve("schemas/workspace-kits.schema.json")));const lockSchema=ajv.compile(read(path.resolve("schemas/workspace-kits-lock.schema.json")));
  const f=fixture();const result=resolve(f);assert.equal(result.status,"verified");assert.equal(declarationSchema(f.declaration),true);assert.equal(lockSchema(result.lock),true);
  const oversized={...f.declaration,selected:Array.from({length:33},(_,i)=>`kit-${i}`)};assert.equal(declarationSchema(oversized),false);write(declarationPath(f.scope),oversized);const refusal=resolve(f);assert.equal(refusal.status,"unsupported");assert.equal(refusal.diagnostics[0].code,"kit-limit");
  for(const bad of [{...f.declaration,options:{x:true}},{...f.declaration,unknown:1}]){assert.equal(declarationSchema(bad),false);assert.throws(()=>parseWorkspaceKitDeclaration(bad));}
});
test("failed final envelope sealing retains publication marker and prior lock", () => {
  const f=fixture();const first=resolve(f);assert.equal(first.status,"verified");const before=fs.readFileSync(lockPath(f.scope));
  fs.appendFileSync(path.join(f.alpha,"docs/README.md"),"new version\n");
  const preload=path.join(f.root,"seal-failure.cjs");
  fs.writeFileSync(preload,`const fs=require('node:fs');const {syncBuiltinESMExports}=require('node:module');const chmod=fs.chmodSync;fs.chmodSync=function(file,...args){if(String(file).includes('/artifacts/kit-tree-v1/'))throw new Error('fixture envelope sealing failure');return chmod.call(this,file,...args);};syncBuiltinESMExports();`);
  const run=spawnSync(process.execPath,["--require",preload,CLI,"kit","workspace","resolve","--scope",f.scope,"--cache",f.cache,"--bindings",f.bindingFile,"--update"],{cwd:f.scope,encoding:"utf8",timeout:20000});
  assert.equal(run.status,2,run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,"recovery-required");assert.equal(result.diagnostics[0].code,"publication-seal-failed");assert.deepEqual(fs.readFileSync(lockPath(f.scope)),before);
  assert.equal(fs.readdirSync(path.join(f.cache,"locks")).length,1);assert.equal(cli(f,"inspect").status,"verified");assert.equal(resolve(f,["--update"]).status,"busy");
});
test("unselected sources are not opened and retained Kit scripts never execute", () => {
  const f=fixture();f.declaration.sources.unselected={kind:"local",alias:"absent-source"};write(declarationPath(f.scope),f.declaration);
  f.bindings["absent-source"]=path.join(f.root,"does-not-exist");write(f.bindingFile,f.bindings);
  const sentinel=path.join(f.root,"must-not-exist");
  write(path.join(f.alpha,"package.json"),{name:"neutral-fixture",version:"1.0.0",scripts:{preinstall:"node execute.mjs"}});
  fs.writeFileSync(path.join(f.alpha,"execute.mjs"),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(sentinel)},'executed');`);
  assert.equal(resolve(f).status,"verified");assert.equal(cli(f,"inspect").status,"verified");assert.equal(fs.existsSync(sentinel),false);
  const control=spawnSync(process.execPath,[path.join(f.alpha,"execute.mjs")],{encoding:"utf8"});assert.equal(control.status,0,control.stderr);assert.equal(fs.readFileSync(sentinel,"utf8"),"executed");
});
test("bindings file failures retain missing versus malformed outcomes", () => {
  const f=fixture();fs.rmSync(f.bindingFile);assert.equal(resolve(f).status,"missing");
  fs.writeFileSync(f.bindingFile,"{");assert.equal(resolve(f).status,"corrupt");
  fs.truncateSync(f.bindingFile,1024*1024+1);assert.equal(resolve(f).status,"corrupt");
});
test("asynchronous cache mutation and root replacement refuse verified observations", async () => {
  for(const target of ["payload","scope","cache"]){
    const f=fixture();const first=resolve(f);assert.equal(first.status,"verified");
    const pending=inspectWorkspaceKits(f);
    if(target==="payload"){
      const file=path.join(payload(f,first.lock.artifacts[0]),"docs/README.md");fs.chmodSync(file,0o644);fs.appendFileSync(file,"changed during await");
    }else{const root=f[target];fs.renameSync(root,root+"-moved");fs.symlinkSync(root+"-moved",root);}
    const result=await pending;assert.equal(result.status,"corrupt");assert.match(result.diagnostics[0].code,/artifact-changed|root-changed/);
  }
});
test("bounded container warnings remain advisory on resolve and offline inspect", () => {
  const f=fixture();const manifest=read(path.join(f.alpha,"kit.json"));manifest.agent_spawn_triggers=[{id:"on-check-failure",description:"Neutral fixture trigger",spawns_agent_runs:true}];write(path.join(f.alpha,"kit.json"),manifest);
  for(const result of [resolve(f),cli(f,"inspect")]){assert.equal(result.status,"verified");assert.equal(result.diagnostics.length,1);assert.equal(result.diagnostics[0].code,"container-warning");assert.match(result.diagnostics[0].message,/without complete guard config/);}
});
test("public workspace API refuses unsupported filesystem platforms before touching roots", async () => {
  const descriptor=Object.getOwnPropertyDescriptor(process,"platform");
  try{Object.defineProperty(process,"platform",{value:"win32",configurable:true});const result=await inspectWorkspaceKits({scope:"/missing",cache:"/also-missing"});assert.equal(result.status,"unsupported");assert.equal(result.diagnostics[0].code,"artifact-platform");}
  finally{Object.defineProperty(process,"platform",descriptor);}
});
test("staged mutation during validation cannot publish bytes under their previous address", async () => {
  const f=fixture();const pending=resolveWorkspaceKits(f);
  const stage=fs.readdirSync(path.join(f.cache,"staging"))[0];const file=path.join(f.cache,"staging",stage,"alpha/payload/docs/README.md");
  fs.appendFileSync(file,"changed staged bytes");const result=await pending;assert.equal(result.status,"corrupt");assert.equal(result.diagnostics[0].code,"artifact-changed");assert.equal(fs.existsSync(lockPath(f.scope)),false);assert.equal(fs.existsSync(path.join(f.cache,"artifacts")),false);
});
test("resolve root substitution during validation never writes or seals the replacement tree", async () => {
  for(const target of ["scope","cache"]){
    const f=fixture();const pending=resolveWorkspaceKits(f);const root=f[target];const moved=root+"-owned";const replacement=root+"-replacement";
    fs.renameSync(root,moved);fs.cpSync(moved,replacement,{recursive:true});fs.symlinkSync(replacement,root);
    const before=snapshot(replacement);const result=await pending;assert.equal(result.status,"recovery-required");assert.equal(result.diagnostics[0].code,"root-changed");assert.deepEqual(snapshot(replacement),before);
    assert.equal(fs.existsSync(lockPath(target==="scope"?moved:f.scope)),false);
  }
});
test("staging ancestor substitution after validation cannot redirect metadata writes or sealing", async () => {
  const f=fixture();const pending=resolveWorkspaceKits(f);const stage=path.join(f.cache,"staging",fs.readdirSync(path.join(f.cache,"staging"))[0]);const entry=path.join(stage,"alpha");
  const moved=entry+"-owned";const replacement=path.join(f.root,"replacement");fs.renameSync(entry,moved);fs.cpSync(moved,replacement,{recursive:true});fs.symlinkSync(replacement,entry);const before=snapshot(replacement);
  const result=await pending;assert.equal(result.status,"corrupt");assert.equal(result.diagnostics[0].code,"unsafe-path");assert.deepEqual(snapshot(replacement),before);assert.equal(fs.existsSync(lockPath(f.scope)),false);
});
test("detected staging-parent substitution cannot redirect failure cleanup into the replacement", async () => {
  const f=fixture();const pending=resolveWorkspaceKits(f);const staging=path.join(f.cache,"staging");const moved=path.join(f.root,"owned-staging");const replacement=path.join(f.root,"external-staging");
  fs.renameSync(staging,moved);fs.cpSync(moved,replacement,{recursive:true});fs.symlinkSync(replacement,staging);const before=snapshot(replacement);
  const result=await pending;assert.equal(result.status,"recovery-required");assert.equal(result.diagnostics[0].code,"unsafe-path");assert.deepEqual(snapshot(replacement),before);assert.equal(fs.existsSync(lockPath(f.scope)),false);
});
test("scope lock cleanup refuses a replaced operation ancestor and preserves its replacement marker", async () => {
  const f=fixture();const pending=resolveWorkspaceKits(f);const original=path.join(f.scope,".kontourai");const moved=path.join(f.root,"owned-runtime");const replacement=path.join(f.root,"external-runtime");
  fs.renameSync(original,moved);fs.cpSync(moved,replacement,{recursive:true});fs.symlinkSync(replacement,original);const before=snapshot(replacement);
  const result=await pending;assert.equal(result.status,"recovery-required");assert.deepEqual(snapshot(replacement),before);assert.equal(fs.existsSync(path.join(replacement,"flow-agents/workspace-kit.lock")),true);
});
test("inspect refuses a redirected artifact ancestor even when the moved entry has unchanged bytes and inode", async () => {
  const f=fixture();assert.equal(resolve(f).status,"verified");const pending=inspectWorkspaceKits(f);const artifacts=path.join(f.cache,"artifacts");const moved=path.join(f.root,"moved-artifacts");fs.renameSync(artifacts,moved);fs.symlinkSync(moved,artifacts);
  const result=await pending;assert.equal(result.status,"corrupt");assert.equal(result.diagnostics[0].code,"unsafe-path");
});
test("empty explicit root flags cannot select the current directory by default", () => {
  const f=fixture();
  for(const roots of [["--scope=","--cache",f.cache],["--scope",f.scope,"--cache="]]){
    const run=spawnSync(process.execPath,[CLI,"kit","workspace","inspect",...roots],{cwd:f.scope,encoding:"utf8",timeout:20000});assert.equal(run.status,2,run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,"unsupported");assert.equal(result.diagnostics[0].code,"invalid-arguments");assert.equal(result.scope,undefined);
  }
});
