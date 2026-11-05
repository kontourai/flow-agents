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
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== path.resolve(root)) throw new Error('source root must be a canonical directory without symlinks; resolve it with realpath');
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
export function planLegacyInstinct(value, sources, sourceNamespace, { visibility } = {}) {
  if (!value || !Array.isArray(sources) || !sources.length || typeof sourceNamespace !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(sourceNamespace)) throw new Error('invalid legacy instinct plan');
  for (const item of sources) {
    const p = item?.provenance; const id = p && hash(JSON.stringify([p.sourceId, p.ordinal]));
    if (item?.source !== 'tool-event' || p?.eventId !== id || item.sittingId !== `tool-event:${id}` || !Array.isArray(item.turns) || item.turns.length !== 1 || item.turns[0].role !== 'tool' || item.turns[0].at !== p.timestamp || item.contentHash !== `sha256:${hash(JSON.stringify({ sittingId: item.sittingId, provenance: p, turns: item.turns }))}`) throw new Error('invalid observation source');
  }
  const source = sources.slice().sort((a, b) => Date.parse(b.provenance.timestamp) - Date.parse(a.provenance.timestamp))[0];
  const text = value.resolution.trim(); const identity = hash(JSON.stringify([sourceNamespace, value.id])); const ref = `legacy-instinct-${identity}`;
  const claim = memoryClaim({ subject: { type: 'instinct', id: identity }, claimType: 'knowledge.memory-claim', property: 'learned pattern', qualifiers: { scope: value.scope, event: value.event, tool: value.tool, context: value.context }, value: text, speaker: 'legacy-import', source: { ref, locator: `chars:0-${text.length}`, excerpt: text, observedAt: new Date(value.observed_at).toISOString() }, posture: 'proposed', ...(visibility === undefined ? {} : { visibility }) });
  assertMemoryClaim(claim);
  const boundaries = [...new Set(sources.map((item) => item.provenance.eventId))];
  // Preserve the legacy value during preview; its baseline date is not established.
  const draft = planInstinctConsolidation({ claim, visibility: visibility ?? null, project: value.scope === 'global' ? null : value.scope.slice('project:'.length), confidence: { baseline: value.confidence, baselineSources: boundaries.length, sourceIds: boundaries, lastObservedAt: source.provenance.timestamp, now: source.provenance.timestamp } });
  const { decision } = draft;
  if (decision.changeId !== claim.id) throw new Error('routing did not bind the claim');
  const plan = [draft.entry];
  const sitting = { id: ref, contentHash: `sha256:${hash(JSON.stringify(value))}`, visibilityKey: visibilityKey(visibility) };
  const body = encodeEnvelope({ plan, index: 0, decision, sitting });
  if (!decodeEnvelope(body)) throw new Error('planned claim envelope is invalid');
  const uniqueSources = [...new Map(sources.map((item) => [item.provenance.eventId, item])).values()];
  const observationRaw = uniqueSources.map((item) => ({ id: `observation-${item.provenance.eventId}`, type: 'raw', title: 'Observed tool event', category: 'memory.observation', body: JSON.stringify({ provenance: item.provenance, turn: item.turns[0] }), provenance: { agent: 'knowledge.instinct-migration' } }));
  const sourceIds = [ref, ...new Set(observationRaw.map((item) => item.id))];
  const legacyRaw = { id: ref, type: 'raw', title: 'Legacy instinct source', category: 'memory.legacy-instinct', body: `${text}\n\n${JSON.stringify({ event: value.event, tool: value.tool, context: value.context, scope: value.scope, confidence: value.confidence, ...(value.confidence_at === undefined ? {} : { confidence_at: value.confidence_at }) })}`, provenance: { agent: 'knowledge.instinct-migration' } };
  if (legacyRaw.body.slice(0, text.length) !== claim.source.excerpt) throw new Error('legacy source does not match claim excerpt');
  const candidate = { id: `instinct-${identity}`, type: 'compiled', title: 'Imported instinct', category: 'memory.claim', confidence: draft.confidence, body, provenance: { agent: 'knowledge.instinct-migration', source_ids: sourceIds }, links: sourceIds.map((target_id) => ({ kind: 'source', target_id })) };
  return { legacyRaw, observationRaw, candidate, decision, requestKey: `knowledge.instinct-migration:${identity}` };
}

/** The caller supplies Ferry's importer and explicitly authorized source roots. */
export function previewMigration({ legacyRoot, instinctsRoot, sourceNamespace, sourceMap = [], sourceProjects = [], importer }) {
  if (typeof sourceNamespace !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(sourceNamespace)) throw new Error('source namespace must be a stable opaque identifier');
  if (!Array.isArray(sourceMap) || sourceMap.length > MAX_EVENTS) throw new Error('source map must be a bounded array');
  const mapped = new Map();
  for (const item of sourceMap) {
    if (!item || !SAFE_ID.test(item.legacyId ?? '') || typeof item.file !== 'string' || !item.file || path.isAbsolute(item.file) || item.file.includes('\\') || item.file.split('/').some((part) => !part || part === '.' || part === '..') || !Number.isSafeInteger(item.ordinal) || item.ordinal < 1 || mapped.has(item.legacyId)) throw new Error('invalid or duplicate source mapping');
    mapped.set(item.legacyId, item);
  }
  if (!Array.isArray(sourceProjects) || sourceProjects.length > MAX_FILES) throw new Error('source projects must be a bounded array');
  const projects = new Map();
  for (const item of sourceProjects) {
    if (!item || typeof item.file !== 'string' || !item.file || path.isAbsolute(item.file) || item.file.includes('\\') || item.file.split('/').some((part) => !part || part === '.' || part === '..') || !Object.hasOwn(item, 'project') || (item.project !== null && (typeof item.project !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(item.project))) || projects.has(item.file)) throw new Error('invalid or duplicate source project');
    projects.set(item.file, item.project);
  }
  const observations = []; const fileSources = new Map(); const unboundSources = new Set(); let observationFiles = 0; let partial = 0;
  for (const file of filesUnder(legacyRoot).filter((entry) => path.basename(entry) === 'observations.jsonl')) {
    const relative = path.relative(legacyRoot, file).split(path.sep).join('/');
    const sourceId = `legacy-${hash(`${sourceNamespace}\0${relative}`).slice(0, 48)}`;
    fileSources.set(relative, sourceId);
    if (!projects.has(relative)) unboundSources.add(sourceId);
    const project = projects.has(relative) ? projects.get(relative) : null;
    const { batches } = ingestObservationSources([{ sourceId, project, data: readStable(file), importer }], {}, {}, toolEventResidue);
    const [batch] = batches;
    observationFiles++; partial += batch.partial;
    if (observations.length + batch.residues.length > MAX_EVENTS) throw new Error('observation preview exceeds the event limit');
    observations.push(...batch.residues);
  }
  for (const file of projects.keys()) if (!fileSources.has(file)) throw new Error('source project names an unknown observation file');
  const byId = new Map(observations.map((record) => [record.provenance.eventId, record]));
  if (byId.size !== observations.length) throw new Error('duplicate observation event identity');
  const distribution = new Map(); const legacyIds = new Set(); let unsupported = 0; let missingSources = 0; let unbound = 0; let scopeMismatch = 0; let planned = 0; let routed = 0; let baselineUnverified = 0;
  if (instinctsRoot !== undefined) {
    const instinctFiles = filesUnder(instinctsRoot);
    if (instinctFiles.some((file) => ['observations.jsonl', 'projects.json', 'project.json'].includes(path.basename(file)))) throw new Error('instinct root contains observation or project files; select the instinct directory');
    for (const file of instinctFiles) {
      if (!/\.(?:md|json|jsonl)$/i.test(file)) { unsupported++; continue; }
      let values; try { values = parseInstinctFile(file); } catch { unsupported++; continue; }
      for (const value of values) {
        if (!value || typeof value !== 'object' || value.schema_version !== '1.0' || !SAFE_ID.test(value.id ?? '') || !['event', 'tool', 'context', 'resolution'].every((field) => typeof value[field] === 'string' && SAFE_TEXT.test(value[field]) && value[field].trim()) || typeof value.scope !== 'string' || !/^(?:global|project:[a-z0-9_-]{1,64})$/.test(value.scope) || typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at)) || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 || !Array.isArray(value.source_ids) || !value.source_ids.length || value.source_ids.some((id) => typeof id !== 'string' || !id)) { unsupported++; continue; }
        if (legacyIds.has(value.id)) throw new Error('duplicate legacy instinct identity');
        legacyIds.add(value.id);
        const sources = value.source_ids.map((id) => {
          const mapping = mapped.get(id);
          if (!mapping) return byId.get(id);
          const sourceId = fileSources.get(mapping.file);
          return sourceId ? byId.get(hash(JSON.stringify([sourceId, mapping.ordinal]))) : undefined;
        });
        if (sources.some((source) => !source)) { missingSources++; continue; }
        if (sources.some((source) => unboundSources.has(source.provenance.sourceId))) { unbound++; continue; }
        const expectedProject = value.scope === 'global' ? null : value.scope.slice('project:'.length);
        if (sources.some((source) => source.provenance.project !== expectedProject)) { scopeMismatch++; continue; }
        const { decision } = planLegacyInstinct(value, sources, sourceNamespace);
        if (decision.outcome === 'routed') routed++;
        if (typeof value.confidence_at !== 'string' || !Number.isFinite(Date.parse(value.confidence_at))) baselineUnverified++;
        planned++; distribution.set(value.confidence, (distribution.get(value.confidence) ?? 0) + 1);
      }
    }
  }
  return { schema_version: '1.0', mode: 'dry-run', writes: 0, observations: { files: observationFiles, events: observations.length, partial, unboundSources: unboundSources.size, minimumRunsAtDefaultCap: Math.ceil(observations.length / 10) }, instincts: { inventory: instinctsRoot === undefined ? 'not-supplied' : 'scanned', sourceMapping: sourceMap.length ? 'operator-supplied-unverified' : 'not-supplied', planned, unsupported, missingSources, unbound, scopeMismatch, routed, baselineUnverified, routing: 'preview', decay: 'not-verified', confidence: [...distribution].sort(([a], [b]) => a - b).map(([confidence, count]) => ({ confidence, count })) }, diff: { tool_event_inputs: observations.length, legacy_raw_candidates: planned, compiled_candidates: planned, writes: 0, note: 'Plans only. Raw sources need review before compiled records can be applied.' }, brief: { entries: [], status: 'not-verified', reason: 'no proposal was written or reviewed' } };
}

export async function main(argv = process.argv.slice(2)) {
  let legacyRoot, instinctsRoot, importerPath, sourceNamespace, sourceMapPath, sourceProjectsPath; let dryRun = false; const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (seen.has(argv[i])) throw new Error('duplicate option');
    seen.add(argv[i]);
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--source-namespace') { sourceNamespace = argv[++i]; if (!sourceNamespace || !/^[A-Za-z0-9._:-]{1,128}$/.test(sourceNamespace)) throw new Error('--source-namespace requires a stable opaque identifier'); }
    else if (['--legacy-root', '--instincts-root', '--importer', '--source-map', '--source-projects'].includes(argv[i])) { const flag = argv[i]; const value = argv[++i]; if (!value || !path.isAbsolute(value)) throw new Error(`${flag} requires an absolute path`); if (flag === '--legacy-root') legacyRoot = value; else if (flag === '--instincts-root') instinctsRoot = value; else if (flag === '--source-map') sourceMapPath = value; else if (flag === '--source-projects') sourceProjectsPath = value; else importerPath = value; }
    else throw new Error('usage: migrate --dry-run --legacy-root ABS --source-namespace ID --importer ABS [--instincts-root ABS] [--source-map ABS] [--source-projects ABS]');
  }
  if (!dryRun || !legacyRoot || !importerPath || !sourceNamespace) throw new Error('usage: migrate --dry-run --legacy-root ABS --source-namespace ID --importer ABS [--instincts-root ABS] [--source-map ABS] [--source-projects ABS]');
  const importer = (await import(pathToFileURL(importerPath).href)).importObservations;
  if (typeof importer !== 'function') throw new Error('importer must export importObservations');
  let sourceMap = [];
  if (sourceMapPath !== undefined) { try { sourceMap = JSON.parse(readStable(sourceMapPath)); } catch { throw new Error('source map cannot be read as JSON'); } }
  let sourceProjects = [];
  if (sourceProjectsPath !== undefined) { try { sourceProjects = JSON.parse(readStable(sourceProjectsPath)); } catch { throw new Error('source projects cannot be read as JSON'); } }
  return previewMigration({ legacyRoot, instinctsRoot, sourceNamespace, sourceMap, sourceProjects, importer });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Usage: node kits/knowledge/instincts/migrate.js --dry-run --legacy-root ABS --source-namespace ID --importer ABS [--instincts-root ABS] [--source-map ABS] [--source-projects ABS]\nChoose a stable source namespace for the original store and use it for its copies. The importer must be trusted code exporting importObservations. Preview counts and planned shapes only. No records are written.\n');
  } else main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`migration preview failed: ${error.message}\n`); process.exitCode = 1; });
}
