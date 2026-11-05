#!/usr/bin/env node
/** Preview a legacy import. This command reads only; it never opens a store for writing. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseMarkdown } from '../adapters/shared/codec.js';
import { assertMemoryClaim, memoryClaim } from '../adapters/memory-claims/index.mjs';
import { planInstinctConsolidation } from './consolidate.js';
import { ingestObservationSources } from './observation-source.js';
import { toolEventResidue } from './tool-event-residue.js';
import { encodeEnvelope, decodeEnvelope, visibilityKey } from '../dream/envelope.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const MAX_FILES = 2000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_EVENTS = 100000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f]{1,512}$/u;

function filesUnder(root) {
  if (!path.isAbsolute(root || '')) throw new Error('source root must be absolute');
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== path.resolve(root)) throw new Error('source root must be a canonical directory without symlinks');
  const files = []; let entries = 0; let totalBytes = 0;
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (++entries > MAX_FILES) throw new Error('source tree exceeds the entry limit');
      const file = path.join(dir, name); const item = fs.lstatSync(file);
      if (item.isSymbolicLink()) throw new Error('source tree contains a symlink');
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) { totalBytes += item.size; if (item.size > MAX_BYTES || totalBytes > MAX_TOTAL_BYTES) throw new Error('source files exceed the size limit'); files.push(file); }
      else throw new Error('source tree contains an unsupported entry');
    }
  }
  walk(root); return files;
}

function readStable(file) {
  const expected = fs.lstatSync(file);
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size > MAX_BYTES) throw new Error('source file is unsafe or too large');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || before.size > MAX_BYTES) throw new Error('source file changed before reading');
    const data = fs.readFileSync(fd); const after = fs.fstatSync(fd); const current = fs.lstatSync(file);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.dev !== before.dev || current.ino !== before.ino || data.length > MAX_BYTES) throw new Error('source file changed while reading');
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } finally { fs.closeSync(fd); }
}

function parseInstinctFile(file) {
  const text = readStable(file);
  if (file.endsWith('.md')) return [parseMarkdown(text).meta];
  if (file.endsWith('.jsonl')) return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  if (file.endsWith('.json')) { const value = JSON.parse(text); return Array.isArray(value) ? value : [value]; }
  throw new Error('unsupported instinct file');
}

/** Build private proposal shapes for a source-backed legacy instinct. No writes. */
export function planLegacyInstinct(value, sources, sourceNamespace) {
  if (!value || !Array.isArray(sources) || !sources.length || typeof sourceNamespace !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(sourceNamespace)) throw new Error('invalid legacy instinct plan');
  for (const item of sources) {
    const p = item?.provenance; const id = p && hash(JSON.stringify([p.sourceId, p.ordinal]));
    if (item?.source !== 'tool-event' || p?.eventId !== id || item.sittingId !== `tool-event:${id}` || !Array.isArray(item.turns) || item.turns.length !== 1 || item.turns[0].role !== 'tool' || item.turns[0].at !== p.timestamp || item.contentHash !== `sha256:${hash(JSON.stringify({ sittingId: item.sittingId, provenance: p, turns: item.turns }))}`) throw new Error('invalid observation source');
  }
  const source = sources.slice().sort((a, b) => Date.parse(b.provenance.timestamp) - Date.parse(a.provenance.timestamp))[0];
  const text = value.resolution.trim(); const identity = hash(JSON.stringify([sourceNamespace, value.id])); const ref = `legacy-instinct-${identity}`;
  const claim = memoryClaim({ subject: { type: 'instinct', id: identity }, claimType: 'knowledge.memory-claim', property: 'learned pattern', qualifiers: { scope: value.scope, event: value.event, tool: value.tool, context: value.context }, value: text, speaker: 'legacy-import', source: { ref, locator: `chars:0-${text.length}`, excerpt: text, observedAt: new Date(value.observed_at).toISOString() }, posture: 'proposed' });
  assertMemoryClaim(claim);
  const boundaries = [...new Set(sources.map((item) => item.provenance.eventId))];
  // Preserve the legacy value during preview; its baseline date is not established.
  const draft = planInstinctConsolidation({ claim, project: value.scope === 'global' ? null : value.scope.slice('project:'.length), confidence: { baseline: value.confidence, baselineSources: boundaries.length, sourceIds: boundaries, lastObservedAt: source.provenance.timestamp, now: source.provenance.timestamp } });
  const { decision } = draft;
  if (decision.changeId !== claim.id) throw new Error('routing did not bind the claim');
  const plan = [draft.entry];
  const sitting = { id: ref, contentHash: `sha256:${hash(JSON.stringify(value))}`, visibilityKey: visibilityKey(undefined) };
  const body = encodeEnvelope({ plan, index: 0, decision, sitting });
  if (!decodeEnvelope(body)) throw new Error('planned claim envelope is invalid');
  const uniqueSources = [...new Map(sources.map((item) => [item.provenance.eventId, item])).values()];
  const observationRaw = uniqueSources.map((item) => ({ id: `observation-${item.provenance.eventId}`, type: 'raw', title: 'Observed tool event', category: 'memory.observation', body: JSON.stringify({ provenance: item.provenance, turn: item.turns[0] }), provenance: { agent: 'knowledge.instinct-migration' } }));
  const sourceIds = [ref, ...new Set(observationRaw.map((item) => item.id))];
  const legacyRaw = { id: ref, type: 'raw', title: 'Legacy instinct source', category: 'memory.legacy-instinct', body: `${text}\n\n${JSON.stringify({ event: value.event, tool: value.tool, context: value.context, scope: value.scope })}`, provenance: { agent: 'knowledge.instinct-migration' } };
  if (legacyRaw.body.slice(0, text.length) !== claim.source.excerpt) throw new Error('legacy source does not match claim excerpt');
  const candidate = { id: `instinct-${identity}`, type: 'compiled', title: 'Imported instinct', category: 'memory.claim', body, provenance: { agent: 'knowledge.instinct-migration', source_ids: sourceIds }, links: sourceIds.map((target_id) => ({ kind: 'source', target_id })) };
  return { legacyRaw, observationRaw, candidate, decision, requestKey: `knowledge.instinct-migration:${identity}` };
}

/** The caller supplies Ferry's importer and explicitly authorized source roots. */
export function previewMigration({ legacyRoot, instinctsRoot, sourceNamespace, importer }) {
  if (typeof sourceNamespace !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(sourceNamespace)) throw new Error('source namespace must be a stable opaque identifier');
  const observations = []; let observationFiles = 0; let partial = 0;
  for (const file of filesUnder(legacyRoot).filter((entry) => path.basename(entry) === 'observations.jsonl')) {
    const sourceId = `legacy-${hash(`${sourceNamespace}\0${path.relative(legacyRoot, file)}`).slice(0, 48)}`;
    const { batches } = ingestObservationSources([{ sourceId, data: readStable(file), importer }], {}, {}, toolEventResidue);
    const [batch] = batches;
    observationFiles++; partial += batch.partial;
    if (observations.length + batch.residues.length > MAX_EVENTS) throw new Error('observation preview exceeds the event limit');
    observations.push(...batch.residues);
  }
  const byId = new Map(observations.map((record) => [record.provenance.eventId, record]));
  if (byId.size !== observations.length) throw new Error('duplicate observation event identity');
  const distribution = new Map(); const legacyIds = new Set(); let unsupported = 0; let missingSources = 0; let planned = 0; let routed = 0;
  if (instinctsRoot !== undefined) {
    for (const file of filesUnder(instinctsRoot)) {
      if (!/\.(?:md|json|jsonl)$/i.test(file)) { unsupported++; continue; }
      let values; try { values = parseInstinctFile(file); } catch { unsupported++; continue; }
      for (const value of values) {
        if (!value || typeof value !== 'object' || value.schema_version !== '1.0' || !SAFE_ID.test(value.id ?? '') || !['event', 'tool', 'context', 'resolution'].every((field) => typeof value[field] === 'string' && SAFE_TEXT.test(value[field]) && value[field].trim()) || typeof value.scope !== 'string' || !/^(?:global|project:[a-z0-9_-]{1,64})$/.test(value.scope) || typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at)) || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 || !Array.isArray(value.source_ids) || !value.source_ids.length || value.source_ids.some((id) => typeof id !== 'string' || !id)) { unsupported++; continue; }
        if (legacyIds.has(value.id)) throw new Error('duplicate legacy instinct identity');
        legacyIds.add(value.id);
        const sources = value.source_ids.map((id) => byId.get(id));
        if (sources.some((source) => !source)) { missingSources++; continue; }
        const { decision } = planLegacyInstinct(value, sources, sourceNamespace);
        if (decision.outcome === 'routed') routed++;
        planned++; distribution.set(value.confidence, (distribution.get(value.confidence) ?? 0) + 1);
      }
    }
  }
  return { schema_version: '1.0', mode: 'dry-run', writes: 0, observations: { files: observationFiles, events: observations.length, partial }, instincts: { inventory: instinctsRoot === undefined ? 'not-supplied' : 'scanned', planned, unsupported, missingSources, routed, routing: 'preview-without-store-peers', decay: 'not-evaluated-baseline-date-unverified', confidence: [...distribution].sort(([a], [b]) => a - b).map(([confidence, count]) => ({ confidence, count })) }, diff: { tool_event_inputs: observations.length, legacy_raw_candidates: planned, compiled_candidates: planned, writes: 0, note: 'planned shapes only; raw source review and confidence-frontmatter support are required' }, brief: { entries: [], status: 'not-verified', reason: 'no proposal was written or reviewed' } };
}

export async function main(argv = process.argv.slice(2)) {
  let legacyRoot, instinctsRoot, importerPath, sourceNamespace; let dryRun = false; const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (seen.has(argv[i])) throw new Error('duplicate option');
    seen.add(argv[i]);
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--source-namespace') { sourceNamespace = argv[++i]; if (!sourceNamespace || !/^[A-Za-z0-9._:-]{1,128}$/.test(sourceNamespace)) throw new Error('--source-namespace requires a stable opaque identifier'); }
    else if (['--legacy-root', '--instincts-root', '--importer'].includes(argv[i])) { const flag = argv[i]; const value = argv[++i]; if (!value || !path.isAbsolute(value)) throw new Error(`${flag} requires an absolute path`); if (flag === '--legacy-root') legacyRoot = value; else if (flag === '--instincts-root') instinctsRoot = value; else importerPath = value; }
    else throw new Error('usage: migrate --dry-run --legacy-root ABS --source-namespace ID --importer ABS [--instincts-root ABS]');
  }
  if (!dryRun || !legacyRoot || !importerPath || !sourceNamespace) throw new Error('usage: migrate --dry-run --legacy-root ABS --source-namespace ID --importer ABS [--instincts-root ABS]');
  const importer = (await import(pathToFileURL(importerPath).href)).importObservations;
  if (typeof importer !== 'function') throw new Error('importer must export importObservations');
  return previewMigration({ legacyRoot, instinctsRoot, sourceNamespace, importer });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Usage: node kits/knowledge/instincts/migrate.js --dry-run --legacy-root ABS --source-namespace ID --importer ABS [--instincts-root ABS]\nPreview counts and planned shapes only. The trusted importer runs in this process. No records are written.\n');
  } else main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`migration preview failed: ${error.message}\n`); process.exitCode = 1; });
}
