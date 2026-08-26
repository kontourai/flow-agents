import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import * as api from '../../build/src/index.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sol-1384-review-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const narrativeDir = path.join(root, 'narrative');
  const flowRoot = path.join(root, 'flow');
  const bytes = Buffer.from(JSON.stringify({ run_id: 'probe', gate_summaries: [], note: 'retained source material' }));
  fs.mkdirSync(path.join(flowRoot, 'runs/probe'), { recursive: true });
  fs.writeFileSync(path.join(flowRoot, 'runs/probe/report.json'), bytes);
  api.snapshotNarrative({ narrativeDir, narrativeId: 'probe', requests: [{ source: api.parseSourceId(`fa1:flow-report:probe:report/${hash(bytes).slice(0,8)}`), roots: {flowRoot} }], redactionFields: [], compiler: {name:'fixture',version:'1',policy_hash:'fixture'}, captureCompleteness: {channels:{full:'active'},known_gaps:[]} }, {now:()=>'2026-08-26T00:00:00.000Z'});
  const envelope = api.composeGroundedNarrative(narrativeDir,{compiledAt:'2026-08-26T00:01:00.000Z'});
  const manifestPath = path.join(narrativeDir,'source-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const runtime = envelope.sections.find(section => section.authority === 'flow-agents');
  function persist() {
    runtime.sha256 = hash(api.stableStringify(runtime.embedded));
    const written = api.writeEnvelope(narrativeDir,envelope);
    return {scope:{narrativeDir},ref:{schemaVersion:'grounded-narrative-ref/v1',narrativeId:'probe',envelopeSha256:written.envelopeSha256},authorize:()=>true};
  }
  return {root,narrativeDir,envelope,manifestPath,manifest,runtime,persist};
}

test('runtime section must bind to the retained manifest and narrative, not only its own digest', async t => {
  const f = fixture(t);
  f.runtime.embedded.narrative_id = 'another-project';
  f.runtime.embedded.provenance.manifest_sha256 = '0'.repeat(64);
  f.runtime.embedded.coverage.sources = 9000;
  f.runtime.embedded.document_statements = [{id:'a'.repeat(16),class:'observed',proposition:'unrelated process observation',source_refs:['fa1:telemetry:unrelated:1'],turn_ref:-1}];
  assert.deepEqual(api.validateNarrativeRuntimeProjection(f.runtime.embedded),[],'probe must be schema-valid');
  const result = await api.readGroundedNarrative(f.persist());
  assert.equal(result.status,'unavailable',`accepted runtime from another narrative with fabricated coverage: ${result.status}`);
  assert.equal(result.reason,'corrupt');
});

test('source-directory replacement by an out-of-scope symlink must be rejected', async t => {
  const f = fixture(t);
  const input = f.persist();
  const source = path.join(f.narrativeDir,'sources',f.manifest.sources[0].sha256);
  const original = fs.lstatSync;
  let swapped = false;
  try {
    fs.lstatSync = function(file,...args) {
      if (!swapped && file === source) {
        swapped = true;
        fs.renameSync(path.join(f.narrativeDir,'sources'), path.join(f.root,'out-of-scope-sources'));
        fs.symlinkSync(path.join(f.root,'out-of-scope-sources'),path.join(f.narrativeDir,'sources'));
      }
      return original.call(this,file,...args);
    };
    syncBuiltinESMExports();
    const result = await api.readGroundedNarrative(input);
    assert.equal(swapped,true);
    assert.equal(result.status,'unavailable',`returned ${result.status} after out-of-scope parent symlink swap`);
    assert.equal(result.reason,'corrupt');
  } finally {fs.lstatSync=original;syncBuiltinESMExports();}
});

test('actual source reads respect the remaining aggregate cap even if manifest size lies', async t => {
  const f = fixture(t);
  f.manifest.sources[0].bytes = 1;
  const manifestBytes = Buffer.from(JSON.stringify(f.manifest));
  fs.writeFileSync(f.manifestPath,manifestBytes);
  f.envelope.provenance.manifest_sha256 = hash(manifestBytes);
  const input = {...f.persist(),limits:{maxAggregateSourceBytes:1}};
  const source = path.join(f.narrativeDir,'sources',f.manifest.sources[0].sha256);
  const open = fs.openSync,read = fs.readSync;
  let sourceFd,sourceBytesRead=0;
  try {
    fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(file===source)sourceFd=fd;return fd;};
    fs.readSync=function(fd,...args){const n=read.call(this,fd,...args);if(fd===sourceFd)sourceBytesRead+=n;return n;};
    syncBuiltinESMExports();
    const result = await api.readGroundedNarrative(input);
    assert.ok(sourceBytesRead <= 2,`read ${sourceBytesRead} source bytes under a 1-byte aggregate cap`);
    assert.deepEqual(result,{status:'unavailable',reason:'limits_exceeded'});
  } finally {fs.openSync=open;fs.readSync=read;syncBuiltinESMExports();}
});

test('browser projection rejects malformed inputs instead of forwarding private unknown members', t => {
  const f = fixture(t);
  const input = f.persist();
  f.runtime.embedded.turns = [{ordinal:0,boundary:{derived:false,private_path:'/private/PROJECTION_LEAK'},sessionId:'fixture',known_gap_refs:[],statements:[]}];
  const output = api.projectRetainedNarrativeProcess(input.ref,f.envelope);
  assert.ok(output===undefined,'projector accepted and copied /private/PROJECTION_LEAK from unknown boundary property');
});

test('reference codec is bounded and total for malformed public inputs', () => {
  assert.ok(api.decodeGroundedNarrativeRef({schemaVersion:'grounded-narrative-ref/v1',narrativeId:'x'.repeat(1024*1024),envelopeSha256:'a'.repeat(64)})===undefined,'accepted an unbounded 1 MiB reference identifier');
});
