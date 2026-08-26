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

test('configured narrative root cannot be rebound during canonicalization', async t => {
  const f = fixture(t);
  const input = f.persist();
  const original = fs.realpathSync;
  let swapped = false;
  try {
    fs.realpathSync = function(file,...args) {
      if (!swapped && file === f.narrativeDir) {
        swapped = true;
        const outside = path.join(f.root,'out-of-scope-narrative');
        fs.renameSync(f.narrativeDir,outside);
        fs.symlinkSync(outside,f.narrativeDir);
      }
      return original.call(this,file,...args);
    };
    syncBuiltinESMExports();
    const result = await api.readGroundedNarrative(input);
    assert.equal(swapped,true);
    assert.deepEqual(result,{status:'unavailable',reason:'corrupt'});
  } finally {fs.realpathSync=original;syncBuiltinESMExports();}
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

test('unsupported versions remain distinguishable from malformed references and corrupt bytes', async t => {
  const f = fixture(t);
  const input = f.persist();
  const unsupportedRef = await api.readGroundedNarrative({...input,ref:{...input.ref,schemaVersion:'grounded-narrative-ref/v2'}});
  f.envelope.schema_version = 'grounded-execution-narrative/v2';
  const unsupportedEnvelope = await api.readGroundedNarrative(f.persist());
  assert.notEqual(unsupportedRef.reason,'invalid_reference','an unsupported reference version is not a malformed v1 reference');
  assert.notEqual(unsupportedEnvelope.reason,'corrupt','an unsupported retained envelope version is not corrupt bytes');
});

test('browser process codec is strict and exposes only typed runtime action outcomes', t => {
  const f = fixture(t);
  const sourceRef = f.manifest.sources[0].source_id;
  f.runtime.embedded.document_statements = [{
    id: 'b'.repeat(16), class: 'observed', proposition: 'Command `PRIVATE_COMMAND_CANARY` was observed to fail (exit 1)', source_refs: [sourceRef],
  }];
  f.runtime.embedded.coverage.cited = 1;
  const projected = api.projectRetainedNarrativeProcess({schemaVersion:'grounded-narrative-ref/v1',narrativeId:'probe',envelopeSha256:'a'.repeat(64)},f.envelope);
  assert.deepEqual(projected?.runtime.documentActions,[{kind:'command',outcome:'fail'}]);
  assert.equal(api.decodeRetainedNarrativeProcessProjection({...projected,private_path:'/private/CODEC_LEAK'}),undefined);
  assert.doesNotMatch(JSON.stringify(projected),/PRIVATE_COMMAND_CANARY|source_refs|statements/);
});

test('browser codecs bound serialized provenance and preserve safe long command outcomes', t => {
  const f = fixture(t);
  const sourceRef = f.manifest.sources[0].source_id;
  const projection = api.projectRetainedNarrativeProcess({schemaVersion:'grounded-narrative-ref/v1',narrativeId:'probe',envelopeSha256:'a'.repeat(64)},f.envelope);
  assert.ok(projection);
  assert.equal(api.decodeRetainedNarrativeProcessProjection({...projection,provenance:{...projection.provenance,compiler:{name:'flow-agents-narrative-composer',version:'x'.repeat(1024*1024)}}}),undefined);
  assert.equal(api.decodeRetainedNarrativeProcessProjection({...projection,capture:{...projection.capture,knownGapClasses:Array(129).fill('mcp_non_native_tools')}}),undefined);
  f.runtime.embedded.document_statements = [
    {id:'c'.repeat(16),class:'observed',proposition:'Command `npm test` was observed to fail (exit 1)',source_refs:[sourceRef]},
    {id:'d'.repeat(16),class:'observed',proposition:`Command \`${'x'.repeat(605)}\` was observed to fail (exit 1)`,source_refs:[sourceRef]},
  ];
  f.runtime.embedded.coverage.cited = 1;
  const longProjection = api.projectRetainedNarrativeProcess({schemaVersion:'grounded-narrative-ref/v1',narrativeId:'probe',envelopeSha256:'a'.repeat(64)},f.envelope);
  assert.deepEqual(longProjection?.runtime.documentActions,[{kind:'command',outcome:'fail'},{kind:'command',outcome:'fail'}]);
});

test('unsafe retained compiler provenance remains available natively but is withheld from browser projection', async t => {
  const f = fixture(t);
  f.envelope.provenance.compiler.version = '/private/COMPILER_VERSION_CANARY';
  const read = await api.readGroundedNarrative(f.persist());
  assert.equal(read.status,'available');
  assert.equal(api.projectRetainedNarrativeProcess(read.ref,read.envelope),undefined);
});

test('browser projection rejects over-limit process input instead of silently omitting it', t => {
  const f = fixture(t);
  const ref = {schemaVersion:'grounded-narrative-ref/v1',narrativeId:'probe',envelopeSha256:'a'.repeat(64)};
  const sourceRef = f.manifest.sources[0].source_id;
  f.runtime.embedded.document_statements = [{id:'e'.repeat(16),class:'observed',proposition:`Command \`${'x'.repeat(17_005)}\` was observed to fail (exit 1)`,source_refs:[sourceRef]}];
  assert.equal(api.projectRetainedNarrativeProcess(ref,f.envelope),undefined);
  const sections = structuredClone(f.envelope);
  sections.sections = Array(513).fill({authority:'foreign'});
  assert.equal(api.projectRetainedNarrativeProcess(ref,sections),undefined);
  f.runtime.embedded.document_statements = [];
  f.runtime.embedded.turns = [{ordinal:0,sessionId:'fixture',boundary:{derived:false},known_gap_refs:Array(129).fill('gap'),statements:[]}];
  assert.equal(api.projectRetainedNarrativeProcess(ref,f.envelope),undefined);
});
