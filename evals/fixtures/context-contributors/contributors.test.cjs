'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const { run } = require(path.join(root, 'scripts/hooks/workflow-steering.js'));
const { writePerActorCurrent } = require(path.join(root, 'scripts/hooks/lib/current-pointer.js'));
const { profileMemoryContributor, MAX_CONTEXT_BYTES } = require(path.join(root, 'scripts/hooks/lib/context-contributors/profile-memory.js'));
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
  for (const event of ['SessionStart','UserPromptSubmit','PostToolUse']) { const raw=JSON.stringify({hook_event_name:event,cwd}); const out=run(raw); assert.equal(out.slice(raw.length).split(temp).join('<TEMP>'), golden[`${active}:${event}`], `${active}:${event}`); }
 }
});

test('whole entries respect byte cap and marker, with per-runtime flags', t => {
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

test('registry and memory contributor perform no network or child process calls', t => {
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

test('marker resolves when the bundle root itself is named context', t => {
 const { temp } = setup(t); const bundle=path.join(temp,'context');
 for (const file of ['scripts/package.json','scripts/hooks/lib/hook-flags.js','scripts/hooks/lib/context-contributors/profile-memory.js','kits/knowledge/memory-marker.js']) {
  const dest=path.join(bundle,file); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(path.join(root,file),dest);
 }
 let profile;
 assert.doesNotThrow(() => { profile=require(path.join(bundle,'scripts/hooks/lib/context-contributors/profile-memory.js')); }, 'marker must resolve inside the bundle');
 assert.match(profile.profileMemoryContributor('SessionStart',{},8192).text,/violet kestrel/);
});

test('invalid, oversized, symlinked and non-fitting briefs contribute nothing', t => {
 const { temp, brief } = setup(t);
 assert.equal(profileMemoryContributor('SessionStart',{},10),null, 'framing must fit');
 fs.unlinkSync(brief); assert.equal(profileMemoryContributor('SessionStart',{},8192),null, 'missing brief');
 fs.writeFileSync(brief,'{invalid'); assert.equal(profileMemoryContributor('SessionStart',{},8192),null, 'malformed JSON');
 fs.writeFileSync(brief,Buffer.from([0xff,0xfe])); assert.equal(profileMemoryContributor('SessionStart',{},8192),null, 'invalid UTF-8');
 fs.writeFileSync(brief,JSON.stringify({version:2,entries:['wrong version']})); assert.equal(profileMemoryContributor('SessionStart',{},8192),null, 'unknown version');
 fs.writeFileSync(brief,JSON.stringify({version:1,entries:['x'.repeat(33000)]})); assert.equal(profileMemoryContributor('SessionStart',{},8192),null, 'oversized file');
 const target=path.join(temp,'target.json'); fs.writeFileSync(target,JSON.stringify({version:1,entries:['symlink target']})); fs.unlinkSync(brief); fs.symlinkSync(target,brief); assert.equal(profileMemoryContributor('SessionStart',{},8192),null, 'final symlink');
});

test('a FIFO brief fails open without waiting for a writer', { skip: process.platform === 'win32' }, t => {
 const { brief } = setup(t); fs.unlinkSync(brief);
 const created=spawnSync('mkfifo',[brief],{encoding:'utf8'}); assert.equal(created.status,0,created.stderr);
 const modulePath=path.join(root,'scripts/hooks/lib/context-contributors/profile-memory.js');
 const code=`const assert=require('node:assert/strict'); const p=require(${JSON.stringify(modulePath)}); assert.equal(p.profileMemoryContributor('SessionStart',{},8192),null);`;
 const probe=spawnSync(process.execPath,['-e',code],{env:process.env,encoding:'utf8',timeout:5000});
 assert.equal(probe.error?.code,undefined,'profile reader must not block on FIFO'); assert.equal(probe.status,0,probe.stderr);
});
