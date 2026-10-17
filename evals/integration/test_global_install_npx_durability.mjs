// #945/#980: packed Claude runtime survives eviction, using owned bundle assets.
// Build bundles first. Keep the tested tarball when FLOW_AGENTS_PACK_EVIDENCE_DIR is set.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-durable-')));
const pack = process.env.FLOW_AGENTS_PACK_EVIDENCE_DIR || path.join(temp, 'pack');
fs.mkdirSync(pack, {recursive:true});
const home = path.join(temp, 'home'); fs.mkdirSync(home);
const python = spawnSync('python3', ['-c', 'import sys;print(sys.executable)'], {encoding:'utf8'});
assert.equal(python.status, 0, python.stderr);
const env = {...process.env, PATH:[path.dirname(process.execPath),path.dirname(python.stdout.trim()),process.env.PATH].join(path.delimiter), HOME:home, XDG_STATE_HOME:path.join(home,'state'), FLOW_AGENTS_SKILLS_DIR:path.join(home,'skills'), NPM_CONFIG_CACHE:path.join(home,'cache'), FLOW_AGENTS_CLAUDE_TELEMETRY_FOREGROUND:'true'};
// Actual Node/Python must already be on PATH, resolved before isolating HOME.
delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.CLAUDE_PROJECT_DIR;
const run = (command,args,options={}) => spawnSync(command,args,{cwd:temp,env,encoding:'utf8',maxBuffer:32*1024*1024,timeout:120000,...options});
const ok = r => {assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);return r;};
const cli = (source,dest,extra=[]) => run(process.execPath,[path.join(source,'build/src/cli.js'),'init','--runtime','claude-code','--global','--dest',dest,'--yes',...extra],{env:{...env,FLOW_AGENTS_USER_CLAUDE_SETTINGS:path.join(dest,'settings.json')}});
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function tree(dir) {
  const entries=[];
  function visit(relative='') {
    for(const name of fs.readdirSync(path.join(dir,relative)).sort()) {
      const rel=path.join(relative,name),file=path.join(dir,rel),stat=fs.lstatSync(file);
      entries.push([rel,stat.isSymbolicLink()?fs.readlinkSync(file):stat.isFile()?digest(file):'dir']);
      if(stat.isDirectory())visit(rel);
    }
  }
  visit();return entries;
}
try {
  // Read the bundle under its normal build lock: npm pack itself does not take
  // that lock, and other static tests legitimately rebuild dist/.
  const { acquireBundleBuildLock, releaseBundleBuildLock } = await import('../../build/src/tools/build-universal-bundles.js');
  const lock = acquireBundleBuildLock();
  try { ok(run('npm',['pack','--ignore-scripts','--json','--pack-destination',pack],{cwd:root})); }
  finally { releaseBundleBuildLock(lock); }
  const tarball=path.join(pack,fs.readdirSync(pack).find(n=>n.endsWith('.tgz')));
  fs.writeFileSync(path.join(pack,'SHA256SUMS'),`${digest(tarball)}  ${path.basename(tarball)}\n`);
  ok(run('tar',['-xzf',tarball,'-C',temp]));
  console.log('packed artifact extracted');
  const source=path.join(temp,'package');assert(!fs.existsSync(path.join(source,'dist/.build-lock')));
  // Initial CLI may consume its normal npm dependencies. After eviction no module
  // from that tree is available; installed runtime is exercised offline below.
  fs.symlinkSync(path.join(root,'node_modules'),path.join(source,'node_modules'),'dir');
  const dest=path.join(home,`o'brien "$dollar\`tick\` $(touch INJECTED) destination`);
  fs.mkdirSync(dest);fs.writeFileSync(path.join(dest,'settings.json'),JSON.stringify({sentinel:'keep',hooks:{SessionStart:[{hooks:[{type:'command',command:'echo user-hook'}]}]}}));
  const before=tree(dest);
  const dry=ok(cli(source,dest,['--dry-run']));assert.deepEqual(tree(dest),before);
  assert.match(dry.stdout,/\.flow-agents\/runtime\/scripts/);
  const invalid=path.join(home,'invalid');fs.mkdirSync(invalid);fs.writeFileSync(path.join(invalid,'settings.json'),'{broken');
  const invalidBefore=tree(invalid);const refused=cli(source,invalid,['--force']);assert.notEqual(refused.status,0);assert.match(refused.stderr,/not valid JSON/);assert.deepEqual(tree(invalid),invalidBefore);
  const installer=path.join(source,'dist/claude-code/install.sh');fs.renameSync(installer,installer+'-saved');
  const missingDest=path.join(home,'missing-bundle');const missing=cli(source,missingDest);assert.notEqual(missing.status,0);assert.match(missing.stderr,/required prebuilt Claude Code bundle/);assert(!fs.existsSync(missingDest));fs.renameSync(installer+'-saved',installer);
  const sourceBefore=tree(source);
  ok(cli(source,dest));console.log('initial global install completed');assert.deepEqual(tree(source),sourceBefore);const settingsFile=path.join(dest,'settings.json');const settingsBytes=fs.readFileSync(settingsFile);const settings=JSON.parse(settingsBytes);assert.equal(settings.sentinel,'keep');
  ok(cli(source,dest));assert.deepEqual(fs.readFileSync(settingsFile),settingsBytes);
  const runtime=path.join(dest,'.flow-agents/runtime');
  // Simulate a new bundle revision: a hash-matching owned runtime file updates,
  // user hook/config and unrelated content survive, then repeat is idempotent.
  const upgradeRel='scripts/hooks/claude-telemetry-hook.js';
  fs.appendFileSync(path.join(source,'dist/claude-code',upgradeRel),'\n// bundle upgrade fixture\n');
  fs.writeFileSync(path.join(runtime,'user-note.txt'),'user-owned');
  ok(cli(source,dest));assert.equal(digest(path.join(runtime,upgradeRel)),digest(path.join(source,'dist/claude-code',upgradeRel)));
  ok(cli(source,dest));assert.deepEqual(fs.readFileSync(settingsFile),settingsBytes);assert.equal(fs.readFileSync(path.join(runtime,'user-note.txt'),'utf8'),'user-owned');
  const manifest=JSON.parse(fs.readFileSync(path.join(dest,'.flow-agents/owned-files.json')));
  assert(manifest.files.some(f=>f.path==='.flow-agents/runtime/build/runtime-imports.json'));
  // An unowned or edited runtime cannot be adopted by --force, nor change settings.
  const hook=path.join(runtime,'scripts/hooks/claude-telemetry-hook.js');const original=fs.readFileSync(hook);fs.appendFileSync(hook,'\n// user edit\n');
  const collision=cli(source,dest,['--force']);assert.notEqual(collision.status,0);assert.match(collision.stderr,/modified or unowned Claude runtime/);assert.deepEqual(fs.readFileSync(settingsFile),settingsBytes);fs.writeFileSync(hook,original);
  // Missing, changed and extra runtime imports must fail before destination writes.
  const bundle=path.join(source,'dist/claude-code');const vendor=path.join(bundle,'build/src/vendor/flow/index.mjs');const vendorBytes=fs.readFileSync(vendor);
  for(const fault of ['missing','changed','extra']) {
    const faultDest=path.join(home,`corrupt-${fault}`);const extra=path.join(bundle,'build/src/vendor/extra.mjs');
    if(fault==='missing')fs.unlinkSync(vendor);if(fault==='changed')fs.appendFileSync(vendor,'\n');if(fault==='extra')fs.writeFileSync(extra,'export {};');
    const result=cli(source,faultDest);assert.notEqual(result.status,0);assert(!fs.existsSync(faultDest));
    fs.writeFileSync(vendor,vendorBytes);if(fs.existsSync(extra))fs.unlinkSync(extra);assert.deepEqual(fs.readFileSync(vendor),vendorBytes);
  }
  for (const relative of ['scripts/hooks/claude-hook-adapter.js', 'scripts/hooks']) {
    const target=path.join(bundle,relative), backup=target+'-saved';fs.renameSync(target,backup);
    for(const linked of [backup,path.join(temp,'missing-target')]) {
      fs.symlinkSync(linked,target);
      const rejected=path.join(home,'symlink-rejected');const result=cli(source,rejected);
      assert.notEqual(result.status,0);assert.match(result.stderr,/symlink/);assert(!fs.existsSync(rejected));fs.unlinkSync(target);
    }
    fs.renameSync(backup,target);
  }
  console.log('upgrade and corruption refusals verified; evicting source');
  fs.rmSync(source,{recursive:true,force:true});fs.rmSync(env.NPM_CONFIG_CACHE,{recursive:true,force:true});
  env.NPM_CONFIG_OFFLINE='true';
  // Block ambient resolution into the publisher's dependencies after source eviction.
  const boundary=path.join(temp,'boundary.mjs');fs.writeFileSync(boundary,`import {registerHooks} from 'node:module';import {realpathSync} from 'node:fs';import {fileURLToPath} from 'node:url';registerHooks({resolve(s,c,next){const r=next(s,c);if(r.url.startsWith('file:')&&!realpathSync(fileURLToPath(r.url)).startsWith(${JSON.stringify(temp+path.sep)}))throw new Error('escaped isolated runtime: '+r.url);return r;}});`);
  env.NODE_OPTIONS=`--import=${boundary}`;
  let hooks=0;
  for(const [event,groups] of Object.entries(settings.hooks))for(const group of groups)for(const h of group.hooks||[]) {
    if(!h.args?.some(a=>/claude-(telemetry-hook|hook-adapter)\.js/.test(a)))continue;
    const r=ok(run(h.command,h.args,{input:JSON.stringify({hook_event_name:event,cwd:temp})}));
    assert(fs.existsSync(h.args[0]),h.args[0]);assert(!h.args[0].includes(source));
    assert.doesNotMatch(r.stderr,/MODULE_NOT_FOUND|Cannot find module/);
    if(event==='SessionStart'&&h.args[0].includes('telemetry')) {const output=JSON.parse(r.stdout);assert.equal(output.continue,true);assert.equal(output.suppressOutput,true);}
    hooks++;
  }
  assert(hooks>=13,`only ${hooks} hooks exercised`);
  console.log(`exercised ${hooks} argv hooks after eviction`);
  const status=ok(run('/bin/sh',['-c',settings.statusLine.command],{input:'{}'}));assert(status.stdout.trim());assert(!fs.existsSync(path.join(temp,'INJECTED')));
  ok(run(process.execPath,[path.join(runtime,'build/src/cli.js'),'--help']));
  ok(run(process.execPath,[path.join(runtime,'build/src/cli.js'),'workflow','--help']));
  // A populated high-impact trust bundle forces the actual Stop hook's Surface
  // branch; empty-project smoke alone can silently miss that dynamic dependency.
  const artifacts=path.join(temp,'trust-artifacts');fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts,'trust.bundle'),JSON.stringify({claims:[{subjectId:'durability-probe',claimType:'workflow.test',impactLevel:'high',status:'accepted'}]}));
  const probe=path.join(temp,'surface-probe.cjs');fs.writeFileSync(probe,`const {bundleEnforcement}=require(${JSON.stringify(path.join(runtime,'scripts/hooks/stop-goal-fit.js'))});bundleEnforcement(${JSON.stringify(artifacts)},null).then(w=>{if(w.some(x=>x.includes('surface unavailable')))throw new Error(w.join('\\n'));console.log(JSON.stringify(w));});`);
  ok(run(process.execPath,[probe]));
  // Uninstall uses the same manifest, preserves an edited runtime file and user hook.
  fs.appendFileSync(hook,'\n// preserve on uninstall\n');
  ok(run(process.execPath,[path.join(runtime,'build/src/cli.js'),'init','--uninstall','--runtime','claude-code','--global','--yes'],{env:{...env,FLOW_AGENTS_USER_CLAUDE_SETTINGS:settingsFile}}));
  assert(fs.existsSync(hook));assert(!fs.existsSync(path.join(runtime,'build/src/cli.js')));
  const left=JSON.parse(fs.readFileSync(settingsFile));assert.equal(left.sentinel,'keep');assert(JSON.stringify(left).includes('echo user-hook'));
  console.log(`PASS: ${hooks} argv hooks, statusLine, standalone CLI, collision/corruption refusal, idempotence, dry-run, invalid settings, uninstall. Tarball sha256:${digest(tarball)}`);
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
