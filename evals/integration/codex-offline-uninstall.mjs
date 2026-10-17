// Packed regression for #1528. Called by the published Codex integration; accepts
// an immutable tarball so the same artifact can be checked under multiple Nodes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../..',import.meta.url));
const [tarball,label='fixed']=process.argv.slice(2);
assert(tarball,'tarball required');
const evidence=process.env.FLOW_AGENTS_PACK_EVIDENCE_DIR;
if(evidence)fs.mkdirSync(evidence,{recursive:true});
const fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codex-offline-')));
const home=path.join(fixture,'home');fs.mkdirSync(home);
const dest=path.join(home,'.codex'),skills=path.join(home,'skills');
const env={...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,HOME:home,CODEX_HOME:dest,CODEX_REAL_HOME:dest,FLOW_AGENTS_SKILLS_DIR:skills,NPM_CONFIG_CACHE:path.join(home,'cache'),NPM_CONFIG_OFFLINE:'true'};
delete env.NODE_OPTIONS;delete env.NODE_PATH;
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const hash=file=>digest(fs.readFileSync(file));
const run=(command,args)=>spawnSync(command,args,{cwd:fixture,env,encoding:'utf8',maxBuffer:32*1024*1024,timeout:120000});
const ok=r=>{assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return r;};
function tree(directory) {
  const records=[];
  function walk(dir) {for(const item of fs.readdirSync(dir).sort()) {
    const file=path.join(dir,item),stat=fs.lstatSync(file);
    records.push([path.relative(directory,file),stat.isSymbolicLink()?fs.readlinkSync(file):stat.isFile()?hash(file):stat.isDirectory()?'dir':'special']);
    if(stat.isDirectory())walk(file);
  }}
  walk(directory);return records;
}
const receipt={label,node:process.execPath,nodeVersion:process.version,tarball,tarballSha256:hash(tarball),fixture};
try {
  ok(run('tar',['-xzf',tarball,'-C',fixture]));
  const source=path.join(fixture,'package');
  fs.symlinkSync(path.join(root,'node_modules'),path.join(source,'node_modules'),'dir');
  fs.mkdirSync(dest);fs.mkdirSync(skills);
  const userConfig='user = true\n';fs.writeFileSync(path.join(dest,'config.toml'),userConfig);
  fs.writeFileSync(path.join(dest,'hooks.json'),JSON.stringify({user:true,hooks:{Stop:[{hooks:[{type:'command',command:'echo user-codex-hook'}]}]}}));
  fs.mkdirSync(path.join(dest,'agents'));fs.writeFileSync(path.join(dest,'agents/user.toml'),'name = "user"\n');
  fs.mkdirSync(path.join(skills,'user'));fs.writeFileSync(path.join(skills,'user/SKILL.md'),'user skill\n');
  ok(run(process.execPath,[path.join(source,'build/src/cli.js'),'init','--runtime','codex','--global','--activate-kits','--yes']));
  const installed=path.join(dest,'build/src/cli.js'), inventory=path.join(dest,'build/runtime-imports.json');
  const ownership=path.join(dest,'.flow-agents/codex-install-manifest.json');
  receipt.installedEntrySha256=hash(installed);receipt.inventorySha256=hash(inventory);receipt.ownershipSha256=hash(ownership);
  if(evidence)for(const [name,file] of [['inventory',inventory],['ownership',ownership]])fs.copyFileSync(file,path.join(evidence,`${label}-${name}.json`));
  fs.rmSync(source,{recursive:true});fs.rmSync(env.NPM_CONFIG_CACHE,{recursive:true,force:true});
  receipt.sourceAbsent=!fs.existsSync(source);receipt.cacheAbsent=!fs.existsSync(env.NPM_CONFIG_CACHE);
  const argv=[installed,'init','--uninstall','--runtime','codex','--global','--yes'];receipt.argv=[process.execPath,...argv];
  if(label.startsWith('baseline')||label.startsWith('reverted')) {
    const before=tree(home),r=run(process.execPath,argv);receipt.exit=r.status;receipt.stderr=r.stderr;
    assert.equal(r.status,2);assert.match(r.stderr,/tool-planner|bundle build failed/);assert.equal(hash(ownership),receipt.ownershipSha256);
    receipt.ownershipUnchanged=true;receipt.treeUnchanged=JSON.stringify(tree(home))===JSON.stringify(before);
  } else {
    // Dry run is a complete read-only plan, including the owned canonical seed.
    const before=tree(home),dry=ok(run(process.execPath,[...argv,'--dry-run']));
    assert.deepEqual(tree(home),before);assert.match(dry.stdout,/\.codex\/hooks.json/);
    const seed=path.join(dest,'.codex/hooks.json'),seedBytes=fs.readFileSync(seed),inventoryBytes=fs.readFileSync(inventory);
    const hooksBytes=fs.readFileSync(path.join(dest,'hooks.json'));
    const manifest=JSON.parse(fs.readFileSync(ownership));assert(manifest.files.some(f=>f.path==='.codex/hooks.json'&&f.sha256===hash(seed)));
    // Every fault must refuse before config, manifests, files or external skills mutate.
    receipt.faults=[];
    for(const fault of ['missing-seed','changed-seed','symlink-seed','missing-inventory','corrupt-inventory','seed-unlisted','missing-hooks-and-seed','fifo-seed']) {
      if(fault==='missing-seed'||fault==='missing-hooks-and-seed')fs.unlinkSync(seed);
      if(fault==='missing-hooks-and-seed')fs.unlinkSync(path.join(dest,'hooks.json'));
      if(fault==='changed-seed')fs.appendFileSync(seed,' ');
      if(fault==='symlink-seed'){fs.unlinkSync(seed);fs.symlinkSync(path.join(dest,'hooks.json'),seed);}
      if(fault==='fifo-seed'){fs.unlinkSync(seed);ok(run('mkfifo',[seed]));}
      if(fault==='missing-inventory')fs.unlinkSync(inventory);
      if(fault==='corrupt-inventory')fs.writeFileSync(inventory,'{');
      if(fault==='seed-unlisted'){const inv=JSON.parse(inventoryBytes);inv.files=inv.files.filter(f=>f.path!=='.codex/hooks.json');fs.writeFileSync(inventory,JSON.stringify(inv));}
      const faultBefore=tree(home),r=run(process.execPath,argv);
      // Missing inventory already refuses at eager package-metadata loading (exit 1).
      // Keep that existing loader contract separate from uninstall validation (exit 2).
      assert.equal(r.status,fault==='missing-inventory'?1:2,`${fault}: ${r.stdout}\n${r.stderr}`);assert.deepEqual(tree(home),faultBefore,fault);
      assert.doesNotMatch(r.stderr,/bundle build failed|tool-planner/);
      receipt.faults.push({fault,exit:r.status,stderr:r.stderr,unchanged:true});
      fs.writeFileSync(path.join(dest,'hooks.json'),hooksBytes);
      fs.rmSync(seed,{force:true});fs.writeFileSync(seed,seedBytes);fs.writeFileSync(inventory,inventoryBytes);
      assert.equal(hash(seed),digest(seedBytes));assert.equal(hash(inventory),digest(inventoryBytes));
    }
    fs.writeFileSync(path.join(dest,'package.json'),'{"name":"user-project","private":true}\n');
    // Edited owned files and mutable marker-matching hooks are user data. Without
    // lineage, only byte-identical recorded installed values may be removed.
    const recordFile=path.join(dest,'.flow-agents/install.json');const record=JSON.parse(fs.readFileSync(recordFile));
    delete record.config_premerge;fs.writeFileSync(recordFile,JSON.stringify(record));
    const hooksFile=path.join(dest,'hooks.json'),hooks=JSON.parse(fs.readFileSync(hooksFile));
    const managed=Object.values(hooks.hooks).flat().flatMap(group=>group.hooks??[]).find(h=>JSON.stringify(h).includes('flow-agents'));
    assert(managed);const custom={...managed,command:(managed.command??'')+' user-modified'};
    (hooks.hooks.Stop??=[]).push({hooks:[custom]});fs.writeFileSync(hooksFile,JSON.stringify(hooks));
    fs.appendFileSync(path.join(dest,'agents/tool-worker.toml'),'\n# user edit\n');
    const r=ok(run(process.execPath,argv));receipt.exit=r.status;receipt.stdout=r.stdout;receipt.stderr=r.stderr;
    assert(!fs.existsSync(installed));assert(!fs.existsSync(seed));assert(!fs.existsSync(ownership));
    assert.equal(fs.readFileSync(path.join(dest,'package.json'),'utf8'),'{"name":"user-project","private":true}\n');
    assert.equal(fs.readFileSync(path.join(dest,'config.toml'),'utf8'),userConfig);
    assert.equal(fs.readFileSync(path.join(dest,'agents/user.toml'),'utf8'),'name = "user"\n');
    assert.match(fs.readFileSync(path.join(dest,'agents/tool-worker.toml'),'utf8'),/user edit/);
    assert.equal(fs.readFileSync(path.join(skills,'user/SKILL.md'),'utf8'),'user skill\n');
    assert.deepEqual(tree(skills).filter(([,value])=>value!=='dir'),[['user/SKILL.md',digest(Buffer.from('user skill\n'))]]);
    const after=JSON.parse(fs.readFileSync(hooksFile));assert(after.user);assert(JSON.stringify(after).includes('user-codex-hook'));
    const remaining=Object.values(after.hooks).flat().flatMap(group=>group.hooks??[]);
    assert(remaining.some(h=>JSON.stringify(h)===JSON.stringify(custom)));
    assert(!remaining.some(h=>JSON.stringify(h)===JSON.stringify(managed)));
    receipt.userPreserved=true;
  }
  if(evidence)for(const stream of ['stdout','stderr'])if(receipt[stream]){fs.writeFileSync(path.join(evidence,`${label}-uninstall.${stream}`),receipt[stream]);delete receipt[stream];}
  receipt.result='PASS';console.log(JSON.stringify(receipt,null,2));
} finally {
  if(evidence)fs.writeFileSync(path.join(evidence,`${label}-receipt.json`),JSON.stringify(receipt,null,2)+'\n');
  // Retain failures for diagnosis; successful receipts include immutable digests.
  if(receipt.result==='PASS')fs.rmSync(fixture,{recursive:true,force:true});
}
