'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const { run, runAsync } = require(path.join(root, 'scripts/hooks/workflow-steering.js'));
const { writePerActorCurrent } = require(path.join(root, 'scripts/hooks/lib/current-pointer.js'));
const { profileMemoryContributor: profileMemoryRead, loadMemoryMarker, MAX_CONTEXT_BYTES } = require(path.join(root, 'scripts/hooks/lib/context-contributors/profile-memory.js'));
let markers;
let markerPromise;
function getMarker() { return markerPromise ||= import(require('node:url').pathToFileURL(path.join(root, 'kits/knowledge/memory-marker.js')).href); }
function profileMemoryContributor(event, payload, budget) { return profileMemoryRead(event, payload, budget, markers); }
const golden = require('./workflow-golden.json');

function setup(t) {
 const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'flow672-test-'));
 const previous = { ...process.env };
 Object.assign(process.env, { FLOW_AGENTS_ACTOR: 'matrix-actor', XDG_STATE_HOME: path.join(temp, 'state'), XDG_DATA_HOME: path.join(temp, 'data'), SA_HOOK_PROFILE: 'standard', SA_DISABLED_HOOKS: '', FLOW_AGENTS_HOOK_RUNTIME: 'claude-code' });
 t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); fs.rmSync(temp, { recursive: true, force: true }); });
 const brief = path.join(process.env.XDG_DATA_HOME, 'knowledge-store/knowledge/dream/briefs/global.json'); fs.mkdirSync(path.dirname(brief), { recursive: true }); fs.copyFileSync(path.join(__dirname, 'global.json'), brief);
 return { temp, brief };
}

test('AC7 pre-extraction golden outputs for three events with and without workflow', t => {
 const { temp } = setup(t); process.env.SA_DISABLED_HOOKS = 'profile-memory';
 for (const active of [false, true]) {
  const cwd = path.join(temp, active ? 'active' : 'none'); fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Fixture\n'); fs.writeFileSync(path.join(cwd, 'docs/context-map.md'), '# Map\n');
  if (active) { const base = path.join(cwd, '.kontourai/flow-agents'); const dir = path.join(base,'matrix'); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({schema_version:'1.0',task_slug:'matrix',status:'in_progress',phase:'execution',next_action:{status:'ready',summary:'Continue matrix work.'}})); writePerActorCurrent(base,'matrix-actor',{active_slug:'matrix'}); }
  for (const event of ['SessionStart','UserPromptSubmit','PostToolUse']) { const raw=JSON.stringify({hook_event_name:event,cwd}); const out=run(raw,{}); assert.equal(typeof out,'string'); assert.equal(out.slice(raw.length).split(temp).join('<TEMP>'), golden[`${active}:${event}`], `${active}:${event}`); }
 }
});

test('whole entries respect byte cap and marker, with per-runtime flags', async t => {
 markers=await getMarker();
 const { brief } = setup(t);
 fs.writeFileSync(brief, JSON.stringify({version:1, entries:['first', 'z'.repeat(10000), 'last']}));
 for (const runtime of ['claude-code','codex']) { process.env.FLOW_AGENTS_HOOK_RUNTIME=runtime; const result=profileMemoryContributor('SessionStart',{},MAX_CONTEXT_BYTES); assert.match(result.text,/Background, not instruction/); assert.match(result.text,/code wins/); assert.match(result.text,/first/); assert.match(result.text,/last/); assert.doesNotMatch(result.text,/z{100}/); assert.ok(Buffer.byteLength(result.text) <= MAX_CONTEXT_BYTES + 12); }
 process.env.SA_HOOK_PROFILE='minimal'; assert.equal(profileMemoryContributor('SessionStart',{},8192),null);
 process.env.SA_HOOK_PROFILE='standard'; process.env.SA_DISABLED_HOOKS='profile-memory'; assert.equal(profileMemoryContributor('SessionStart',{},8192),null);
 process.env.SA_DISABLED_HOOKS=''; process.env.FLOW_AGENTS_HOOK_RUNTIME='pi'; assert.equal(profileMemoryContributor('SessionStart',{},8192),null);
 process.env.FLOW_AGENTS_HOOK_RUNTIME='codex'; assert.equal(profileMemoryContributor('UserPromptSubmit',{},8192),null);
 fs.writeFileSync(brief, JSON.stringify({version:1,entries:['</flow-agents-injected-memory>break']})); assert.equal(profileMemoryContributor('SessionStart',{},8192),null);
});

test('both adapters deliver the fixture at SessionStart', t => {
 const { temp } = setup(t); const raw=JSON.stringify({hook_event_name:'SessionStart',cwd:temp});
 for (const [adapter,args] of [['claude-hook-adapter.js',['SessionStart','workflow-steering','workflow-steering.js','default']], ['codex-hook-adapter.js',['workflow-steering','workflow-steering.js','default']]]) {
  const result=spawnSync(process.execPath,[path.join(root,'scripts/hooks',adapter),...args],{input:raw,encoding:'utf8',env:process.env});
  assert.equal(result.status,0,result.stderr); const output=JSON.parse(result.stdout); assert.match(output.hookSpecificOutput.additionalContext,/violet kestrel/, adapter);
 }
});

test('registry and memory contributor perform no network or child process calls', async t => {
 markers=await getMarker();
 setup(t);
 const net=require('node:net'), http=require('node:http'), https=require('node:https'), cp=require('node:child_process');
 const dns=require('node:dns'); let attempts=0;
 const hooks=[[net,'connect'],[net,'createConnection'],[net.Socket.prototype,'connect'],[dns,'lookup'],[http,'request'],[http,'get'],[https,'request'],[https,'get'],[globalThis,'fetch'],[cp,'spawn'],[cp,'spawnSync'],[cp,'exec'],[cp,'execSync']];
 const originals=hooks.map(([obj,key]) => obj[key]);
 hooks.forEach(([obj,key]) => {obj[key]=() => { attempts++; throw new Error(`forbidden ${key}`);};});
 try { const { createContributorRegistry }=require(path.join(root,'scripts/hooks/lib/context-contributors')); const text=createContributorRegistry([profileMemoryContributor])('SessionStart',{},8192); assert.match(text,/violet kestrel/); assert.equal(attempts,0, 'no network or process calls attempted'); }
 finally { hooks.forEach(([obj,key],i) => {obj[key]=originals[i];}); }
});

 test('registry orders priorities, preserves ties, and isolates failures', () => {
 const { createContributorRegistry } = require(path.join(root,'scripts/hooks/lib/context-contributors'));
 const seen=[]; const result=createContributorRegistry([() => {throw Error('failure');}, (e,p,b) => {seen.push([e,p,b]); return {priority:1,text:'A'};}, () => ({priority:2,text:'B'}), () => ({priority:1,text:'C'})])('SessionStart',{x:1},123);
 assert.equal(result,'BAC'); assert.deepEqual(seen,[['SessionStart',{x:1},123]]);
});

test('marker resolves when the bundle root itself is named context', async t => {
 const { temp } = setup(t); const bundle=path.join(temp,'context');
 for (const file of ['scripts/package.json','scripts/hooks/lib/hook-flags.js','scripts/hooks/lib/context-contributors/profile-memory.js','kits/knowledge/memory-marker.js','kits/knowledge/package.json']) {
  const dest=path.join(bundle,file); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(path.join(root,file),dest);
 }
 let profile;
 assert.doesNotThrow(() => { profile=require(path.join(bundle,'scripts/hooks/lib/context-contributors/profile-memory.js')); }, 'marker must resolve inside the bundle');
 const marker=await profile.loadMemoryMarker(); assert.match(profile.profileMemoryContributor('SessionStart',{},8192,marker).text,/violet kestrel/);
});

test('invalid, oversized, symlinked and non-fitting briefs contribute nothing', async t => {
 markers=await getMarker();
 const { temp, brief } = setup(t);
 assert.equal(profileMemoryContributor('SessionStart',{},10),null, 'framing must fit');
 fs.unlinkSync(brief); assert.equal(profileMemoryContributor('SessionStart',{},8192),null, 'missing brief');
 fs.writeFileSync(brief,'{invalid'); assert.equal(profileMemoryContributor('SessionStart',{},8192),null, 'malformed JSON');
 fs.writeFileSync(brief,Buffer.from([0xff,0xfe])); assert.equal(profileMemoryContributor('SessionStart',{},8192),null, 'invalid UTF-8');
 fs.writeFileSync(brief,JSON.stringify({version:2,entries:['wrong version']})); assert.equal(profileMemoryContributor('SessionStart',{},8192),null, 'unknown version');
 fs.writeFileSync(brief,JSON.stringify({version:1,entries:['x'.repeat(33000)]})); assert.equal(profileMemoryContributor('SessionStart',{},8192),null, 'oversized file');
 const target=path.join(temp,'target.json'); fs.writeFileSync(target,JSON.stringify({version:1,entries:['symlink target']})); fs.unlinkSync(brief); try { fs.symlinkSync(target,brief); } catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.diagnostic('symlink creation unavailable'); return; } throw error; } assert.equal(profileMemoryContributor('SessionStart',{},8192),null, 'final symlink');
});

test('a FIFO brief fails open without waiting for a writer', { skip: process.platform === 'win32' }, t => {
 const { brief } = setup(t); fs.unlinkSync(brief);
 const created=spawnSync('mkfifo',[brief],{encoding:'utf8'}); assert.equal(created.status,0,created.stderr);
 const modulePath=path.join(root,'scripts/hooks/lib/context-contributors/profile-memory.js');
 const code=`(async()=>{const assert=require('node:assert/strict'); const p=require(${JSON.stringify(modulePath)}); const marker=await p.loadMemoryMarker(); assert.ok(marker,'marker must load before FIFO check'); assert.equal(p.profileMemoryContributor('SessionStart',{},8192,marker),null)})().catch(e=>{console.error(e);process.exitCode=1});`;
 const probe=spawnSync(process.execPath,['-e',code],{env:process.env,encoding:'utf8',timeout:5000});
 assert.equal(probe.error?.code,undefined,'profile reader must not block on FIFO'); assert.equal(probe.status,0,probe.stderr);
});

test('marker framing, control rejection, real priority and per-harness rollback', async t => {
 markers=await getMarker();
 const { brief }=setup(t); const { INJECTED_MEMORY_OPEN, INJECTED_MEMORY_CLOSE }=markers;
 assert.equal(MAX_CONTEXT_BYTES,8192);
 const value=profileMemoryContributor('SessionStart',{},8192); assert.ok(value.text.includes(INJECTED_MEMORY_OPEN)); assert.ok(value.text.includes(INJECTED_MEMORY_CLOSE));
 for (const bad of ['hello\u202eother', `before ${INJECTED_MEMORY_OPEN} after`]) { fs.writeFileSync(brief,JSON.stringify({version:1,entries:[bad]})); assert.equal(profileMemoryContributor('SessionStart',{},8192),null); }
 fs.writeFileSync(brief,Buffer.concat([Buffer.from('{"version":1,"entries":["'),Buffer.from([0xff]),Buffer.from('"]}') ])); assert.equal(profileMemoryContributor('SessionStart',{},8192),null,'invalid UTF-8 inside otherwise valid JSON');
 fs.copyFileSync(path.join(__dirname,'global.json'),brief); process.env.SA_DISABLED_HOOKS='profile-memory-codex'; process.env.FLOW_AGENTS_HOOK_RUNTIME='codex'; assert.equal(profileMemoryContributor('SessionStart',{},8192),null); process.env.FLOW_AGENTS_HOOK_RUNTIME='claude-code'; assert.ok(profileMemoryContributor('SessionStart',{},8192));
 const raw=JSON.stringify({hook_event_name:'SessionStart',cwd:tempDir(t)}); const out=await runAsync(raw); assert.ok(out.indexOf('CONTEXT MAP:') < out.indexOf(INJECTED_MEMORY_OPEN)); assert.ok(out.includes('CONTEXT MAP:') && out.includes(INJECTED_MEMORY_OPEN));
});

function tempDir(t) { const cwd=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'flow672-order-'));fs.mkdirSync(path.join(cwd,'docs'));fs.writeFileSync(path.join(cwd,'AGENTS.md'),'# Fixture\n');fs.writeFileSync(path.join(cwd,'docs/context-map.md'),'# Map\n');t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));return cwd; }

test('adapters support ESM markers without require(esm)', t => {
 const { temp }=setup(t); const preload=path.join(temp,'block-require-esm.cjs');
 fs.writeFileSync(preload,`const M=require('module'), old=M._load; M._load=function(id,...args){if(String(id).endsWith('memory-marker.js')){const e=new Error('simulated old Node require ESM');e.code='ERR_REQUIRE_ESM';throw e;}return old.call(this,id,...args)};`);
 const cwd=tempDir(t); const input=JSON.stringify({hook_event_name:'SessionStart',cwd});
 for(const adapter of ['codex','claude']) { const args=adapter==='codex'?['workflow-steering','workflow-steering.js','default']:['SessionStart','workflow-steering','workflow-steering.js','default'];const p=spawnSync(process.execPath,[path.join(root,'scripts/hooks',`${adapter}-hook-adapter.js`),...args],{input,encoding:'utf8',env:{...process.env,NODE_OPTIONS:`${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`}});assert.equal(p.status,0,p.stderr); const output=JSON.parse(p.stdout); assert.ok(output.hookSpecificOutput, 'workflow output survives marker loading');const context=output.hookSpecificOutput.additionalContext;assert.match(context,/CONTEXT MAP:/);assert.match(context,/violet kestrel/); }
});

test('missing marker preserves workflow and never loads a parent marker', t => {
 const {temp}=setup(t);const cwd=tempDir(t);const input=JSON.stringify({hook_event_name:'SessionStart',cwd});
 const parent=path.join(temp,'outside'); const install=path.join(parent,'context'); fs.mkdirSync(path.join(install,'scripts'),{recursive:true});fs.cpSync(path.join(root,'scripts/hooks'),path.join(install,'scripts/hooks'),{recursive:true});fs.cpSync(path.join(root,'scripts/lib'),path.join(install,'scripts/lib'),{recursive:true});fs.copyFileSync(path.join(root,'scripts/package.json'),path.join(install,'scripts/package.json')); const rogue=path.join(parent,'kits/knowledge/memory-marker.js');fs.mkdirSync(path.dirname(rogue),{recursive:true});fs.writeFileSync(rogue,`require('fs').writeFileSync(${JSON.stringify(path.join(parent,'witness'))},'bad');exports.INJECTED_MEMORY_OPEN='X';exports.INJECTED_MEMORY_CLOSE='Y';`);
 for (const disabled of ['', 'profile-memory']) { const p=spawnSync(process.execPath,[path.join(install,'scripts/hooks/workflow-steering.js')],{input,encoding:'utf8',env:{...process.env,SA_DISABLED_HOOKS:disabled}});assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/CONTEXT MAP:/);assert.equal(fs.existsSync(path.join(parent,'witness')),false,'parent marker must never execute');assert.doesNotMatch(p.stdout,/violet kestrel/); }
});

test('profile module load and read make no network or process calls', t => {
 const {temp}=setup(t);const probe=path.join(temp,'network-probe.cjs'); const file=path.join(root,'scripts/hooks/lib/context-contributors/profile-memory.js');
 fs.writeFileSync(probe,`(async()=>{let attempts=0;for(const [o,k] of [[require('net'),'connect'],[require('net').Socket.prototype,'connect'],[require('http'),'request'],[require('https'),'request'],[require('dns'),'lookup'],[require('child_process'),'spawn'],[globalThis,'fetch']])o[k]=()=>{attempts++;throw Error('network/process')}; const m=require(${JSON.stringify(file)});const marker=await m.loadMemoryMarker();const result=m.profileMemoryContributor('SessionStart',{},8192,marker);require('assert').match(result.text,/violet kestrel/);require('assert').equal(attempts,0)})().catch(e=>{console.error(e);process.exitCode=1});`);
 const p=spawnSync(process.execPath,[probe],{encoding:'utf8',env:process.env});assert.equal(p.status,0,p.stderr);
});

test('context mirror imports its package marker without parent search', async t => {
 setup(t); const mirror=require(path.join(root,'context/scripts/hooks/lib/context-contributors/profile-memory.js'));const marker=await mirror.loadMemoryMarker();assert.ok(marker);assert.match(mirror.profileMemoryContributor('SessionStart',{},8192,marker).text,/violet kestrel/);
});

test('bundled marker has an explicit ESM package boundary', t => {
 const {temp}=setup(t);const install=path.join(temp,'standalone');
 // A parent module scope could mask a missing package boundary in the bundle.
 for (let parent=path.dirname(fs.realpathSync(temp));;) { const file=path.join(parent,'package.json'); if (fs.existsSync(file)) assert.notEqual(JSON.parse(fs.readFileSync(file,'utf8')).type,'module',`unexpected parent module scope: ${file}`); const next=path.dirname(parent);if(next===parent) break;parent=next; }
 for (const dir of ['scripts/hooks','scripts/lib']) { const dest=path.join(install,dir);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.cpSync(path.join(root,dir),dest,{recursive:true}); }
 for (const file of ['scripts/package.json','kits/knowledge/package.json','kits/knowledge/memory-marker.js']) { const dest=path.join(install,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,file),dest); }
 assert.equal(JSON.parse(fs.readFileSync(path.join(install,'kits/knowledge/package.json'),'utf8')).type,'module');
 const cwd=tempDir(t); const raw=JSON.stringify({hook_event_name:'SessionStart',cwd});
 for (const adapter of ['claude','codex']) { const args=adapter==='codex'?['workflow-steering','workflow-steering.js','default']:['SessionStart','workflow-steering','workflow-steering.js','default'];const p=spawnSync(process.execPath,[path.join(install,'scripts/hooks',`${adapter}-hook-adapter.js`),...args],{input:raw,encoding:'utf8',env:{...process.env,NODE_OPTIONS:`${process.env.NODE_OPTIONS || ''} --no-experimental-detect-module`}});assert.equal(p.status,0,p.stderr);assert.match(JSON.parse(p.stdout).hookSpecificOutput.additionalContext,/violet kestrel/); }
});

test('non-atomic fallback rejects links and identity changes before reading', t => {
 const {temp,brief}=setup(t);const probe=path.join(temp,'fallback-probe.cjs');const file=path.join(root,'scripts/hooks/lib/context-contributors/profile-memory.js');const target=path.join(temp,'target.json');fs.copyFileSync(brief,target);fs.unlinkSync(brief);try { fs.symlinkSync(target,brief); } catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('symlink creation unavailable'); return; } throw error; }
 fs.writeFileSync(probe,`(async()=>{const M=require('module'),fs=require('fs'),assert=require('assert/strict'),old=M._load;let opens=0,swap=false;const fake={...fs,constants:{...fs.constants,O_NOFOLLOW:0,O_NONBLOCK:0},openSync(...args){opens++;return fs.openSync(...args)},fstatSync(fd){const s=fs.fstatSync(fd);return swap?new Proxy(s,{get(o,k){if(k==='ino')return o.ino+1;const v=Reflect.get(o,k,o);return typeof v==='function'?v.bind(o):v}}):s}};M._load=function(id,...args){return id==='node:fs'?fake:old.call(this,id,...args)};const p=require(${JSON.stringify(file)});const marker=await p.loadMemoryMarker();assert.ok(marker);assert.equal(p.profileMemoryContributor('SessionStart',{},8192,marker),null,'fallback rejects final link');assert.equal(opens,0,'link rejected before opening');fs.unlinkSync(${JSON.stringify(brief)});fs.copyFileSync(${JSON.stringify(target)},${JSON.stringify(brief)});swap=true;assert.equal(p.profileMemoryContributor('SessionStart',{},8192,marker),null,'fallback rejects changed file identity');swap=false;assert.match(p.profileMemoryContributor('SessionStart',{},8192,marker).text,/violet kestrel/,'control reads regular file')})().catch(e=>{console.error(e);process.exitCode=1});`);
 const p=spawnSync(process.execPath,[probe],{encoding:'utf8',env:process.env});assert.equal(p.status,0,p.stderr);
});
