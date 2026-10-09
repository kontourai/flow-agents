import { basename, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { readArtifact } from './artifacts.mjs';
import { digest, readSnapshot } from './compile.mjs';

export const SENSOR_IDS = Object.freeze(['required-sections', 'upstream-coverage', 'traceability', 'claim-sources', 'linter', 'type-check']);
// Manifest dispatch contract at AWS 2.11.0 / 2a555f7. Document gate sensors
// operate on the current stage record (including Kontour's relocated record);
// write sensors require a matching real file, never fenced examples in prose.
export const SENSOR_MANIFESTS = Object.freeze({
  'required-sections': { fire_on: 'gate', matches: '**/{aidlc-docs,intents,codekb}/**', timeout_seconds: 300 },
  'upstream-coverage': { fire_on: 'gate', matches: '**/{aidlc-docs,intents,codekb}/**', timeout_seconds: 300 },
  'claim-sources': { fire_on: 'gate', matches: '**/{aidlc-docs,intents}/**', timeout_seconds: 300 },
  traceability: { fire_on: 'write', matches: '**/traceability.json', timeout_seconds: 300 },
  linter: { fire_on: 'write', matches: '**/*.{ts,js}', timeout_seconds: 1200 },
  'type-check': { fire_on: 'write', matches: '**/*.{ts,tsx}', timeout_seconds: 1200 },
});
const LIMIT = 512;
const scaffold = (name) => /(?:-questions|-timestamp)$/.test(name) || name === 'memory';
const stem = (path) => basename(path).replace(/\.(md|json)$/i, '');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ids = (text, pattern) => new Set(text.match(pattern) ?? []);
const patterns = {
  FR: /\bFR\d+(?:\.\d+)?\b/g, NFR: /\bNFR\d+\b(?!\.\d)/g,
  detail: /\bNFR\d+\.\d+\b/g, US: /\bUS\d+\.\d+\b/g,
  AC: /\bAC\d+\.\d+\.\d+\b/g, BR: /\bBR\d+\.\d+\b/g,
};

// Conservative Markdown projection. Code/comments cannot supply headings,
// source tags or identifiers. HTML and reference links are rejected by the
// provenance check below: unsupported rendering can only cause false failure.
function markdown(text, preserveSpans = false) {
  const lines = text.replace(/<!--[^]*?(?:-->|$)/g, '').split(/\r?\n/);
  let fence;
  return lines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return preserveSpans ? line : line.replace(/(`+)(?!`)([^]*?)\1(?!`)/g, '');
  });
}
function headings(text) {
  return [...new Set(markdown(text).flatMap((line) => /^ {0,3}##\s+(.+?)(?:\s+#+)?\s*$/.exec(line)?.[1] ?? []))];
}
function headingKey(value) {
  return value.replace(/^(?:(?:\p{Extended_Pictographic}\uFE0F?|\p{Emoji_Presentation})(?:\u200D(?:\p{Extended_Pictographic}\uFE0F?|\p{Emoji_Presentation}))*\s*)+\s/u, '').trim();
}
function sections(text, exact = false) {
  const out = []; let current = { name: '', lines: [] }; out.push(current);
  for (const line of markdown(text, true)) {
    const h = /^ {0,3}##\s+(.+?)\s*$/.exec(line);
    if (h) { current = { name: exact ? h[1] : headingKey(h[1]), rawName: h[1], lines: [] }; out.push(current); }
    else current.lines.push(line);
  }
  return out;
}
function section(text, name, exact = false) {
  const found = sections(text, exact).filter((s) => s.name === name);
  if (found.length !== 1) throw new Error(`Expected exactly one ## ${name} section`);
  return found[0].lines;
}
function cells(line) {
  if (!/^\s*\|/.test(line) || /^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return [];
  return line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`(.*)`$/, '$1'));
}

// The documented units edge contract is deliberately a small YAML subset;
// aliases, tags, flow objects, duplicate keys and unknown fields fail closed.
export function parseUnitEdges(text) {
  const blocks = [...text.matchAll(/^ {0,3}```ya?ml\s*\n([^]*?)^ {0,3}```\s*$/gm)].map((m) => m[1]).filter((s) => /^units:\s*$/m.test(s));
  if (blocks.length !== 1) throw new Error('Expected one fenced yaml units: block');
  const lines = blocks[0].split(/\r?\n/).filter((s) => s.trim() && !/^\s*#/.test(s));
  if (lines.shift()?.trim() !== 'units:') throw new Error('units: must open the edge block');
  const units = []; let item;
  for (const line of lines) {
    const scalar = (s) => {
      const value = s.trim().replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, double, single) => double ?? single);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error('Invalid unit identifier');
      return value;
    };
    const name = /^\s+- name:\s*(.+?)\s*$/.exec(line);
    if (name) { item = { name: scalar(name[1]) }; units.push(item); continue; }
    const deps = /^\s+depends_on:\s*\[([^\]]*)\]\s*(?:#.*)?$/.exec(line);
    if (deps && item && !item.depends_on) {
      item.depends_on = deps[1].trim() ? deps[1].split(',').map(scalar) : [];
      continue;
    }
    const kind = /^\s+kind:\s*(.+?)\s*$/.exec(line);
    if (kind && item && !item.kind) {
      item.kind = scalar(kind[1]);
      if (!['service', 'spec', 'ui', 'packaging', 'library'].includes(item.kind)) throw new Error('Unknown unit kind');
      continue;
    }
    throw new Error(`Unsupported or malformed unit field: ${line.trim()}`);
  }
  if (!units.length || units.some((u) => !u.depends_on)) throw new Error('Every unit requires a name and depends_on array');
  const names = new Set(units.map((u) => u.name));
  if (new Set(units.map((u) => u.name.toLowerCase())).size !== units.length) throw new Error('Duplicate unit name');
  for (const u of units) if (new Set(u.depends_on).size !== u.depends_on.length || u.depends_on.some((d) => !names.has(d) || d === u.name)) throw new Error('Unknown, duplicate or self dependency');
  const done = new Set();
  while (done.size < units.length) {
    const ready = units.filter((u) => !done.has(u.name) && u.depends_on.every((d) => done.has(d)));
    if (!ready.length) throw new Error('Cyclic unit dependencies');
    for (const u of ready) done.add(u.name);
  }
  return units;
}

function requiredSections(stage, outputs, context, read) {
  const findings = [];
  const declared = new Set([...(stage.produces ?? []), ...(stage.optional_produces ?? [])]);
  for (const file of outputs.filter((a) => /\.md$/i.test(a.path))) {
    const name = stem(file.path), present = headings(file.text);
    const template = context.templates?.[name];
    if (template && declared.has(name) && !scaffold(name)) {
      for (const h of headings(read(template).text)) if (!present.includes(h)) findings.push(`${file.path}: missing ## ${h}`);
    } else if (!name.endsWith('-timestamp') && present.length < 2) findings.push(`${file.path}: requires at least two distinct H2 headings`);
    if (name === 'unit-of-work-dependency') {
      try { parseUnitEdges(file.text); } catch (error) { findings.push(`${file.path}: ${error.message}`); }
    }
  }
  return findings;
}
function upstreamCoverage(stage, outputs, context, read, snapshot) {
  const findings = [];
  const text = outputs.filter((a) => !scaffold(stem(a.path))).map((a) => a.text).join('\n');
  for (const input of stage.consumes ?? []) {
    const name = typeof input === 'string' ? input : input.artifact;
    if (scaffold(name) || (input.conditional_on && input.conditional_on !== context.projectType)) continue;
    const source = context.upstreamArtifacts?.[name];
    const producer = snapshot.stages.find((s) => [...s.produces, ...(s.optional_produces ?? [])].includes(name));
    if (!source && context.skippedStages?.includes(producer?.slug)) continue;
    if (!source) { findings.push(`${name}: upstream artifact unavailable`); continue; }
    for (const path of [source].flat()) read(path);
    const token = new RegExp(`(?<![\\w-])${escape(name)}(?:\\.md)?(?![\\w-])`);
    const directory = producer && new RegExp(`(?:^|[\\s/\\x60])${escape(producer.slug)}/`);
    if (!token.test(text) && !directory?.test(text)) findings.push(`${name}: absent upstream reference`);
  }
  return findings;
}

function traceability(stage, outputs, context, read) {
  const findings = [], maps = outputs.filter((a) => basename(a.path) === 'traceability.json');
  if (maps.length !== 1) return ['Expected exactly one traceability.json'];
  const get = (name, optional = false) => {
    const own = outputs.find((a) => stem(a.path) === name);
    if (own) return own;
    const paths = [context.upstreamArtifacts?.[name] ?? []].flat();
    if (!paths.length) { if (optional) return undefined; throw new Error(`Missing upstream ${name}`); }
    return { text: paths.map((p) => read(p).text).join('\n') };
  };
  const raw = JSON.parse(maps[0].text);
  if (!raw || Array.isArray(raw) || raw.stage !== stage.slug || (context.unit && raw.unit !== context.unit) || !Array.isArray(raw.upstream_ids) || !raw.upstream_ids.every((id) => typeof id === 'string' && id) || !Array.isArray(raw.coverage) || (raw.reverse !== undefined && !Array.isArray(raw.reverse))) return ['Malformed traceability identity or shape'];
  const declared = new Set(raw.upstream_ids), table = new Map(), reverse = raw.reverse ?? [];
  if (declared.size !== raw.upstream_ids.length || !declared.size) findings.push('Empty or duplicate upstream_ids');
  for (const [kind, entries] of [['coverage', raw.coverage], ['reverse', reverse]]) {
    const seen = new Set();
    for (const row of entries) {
      if (!row || typeof row.id !== 'string' || !row.id || !['OK', 'GAP', 'ORPHAN', 'Deferred', 'N/A'].includes(row.status) || seen.has(row.id)) { findings.push(`Invalid or duplicate ${kind} entry`); continue; }
      seen.add(row.id);
      if (['GAP', 'ORPHAN'].includes(row.status)) findings.push(`${row.id}: ${row.status}`);
      if (['OK', 'Deferred', 'N/A'].includes(row.status) && (typeof row.target !== 'string' || !row.target.trim())) findings.push(`${row.id}: status requires target`);
      if (kind === 'coverage') { table.set(row.id, row); if (!declared.has(row.id)) findings.push(`${row.id}: undeclared coverage ID`); }
    }
  }
  for (const id of declared) if (!table.has(id)) findings.push(`${id}: missing coverage row`);
  const stories = get('stories', true), requirements = () => get('requirements');
  let expected;
  const assignments = new Map();
  const unitsSkipped = context.skippedStages?.includes('units-generation');
  const storyMap = unitsSkipped ? undefined : get('unit-of-work-story-map', true);
  const dagFile = unitsSkipped ? undefined : get('unit-of-work-dependency', true);
  const units = dagFile ? parseUnitEdges(dagFile.text).map((u) => u.name) : [];
  const unitIds = new Map();
  const unitFile = unitsSkipped ? undefined : get('unit-of-work', true);
  for (const line of unitFile?.text.split('\n') ?? []) {
    const row = cells(line), id = row.join(' ').match(/\bU\d+\b/)?.[0];
    const unit = units.find((u) => row.some((v) => v === u || v.replace(/^u\d+-/, '') === u));
    if (id && unit) unitIds.set(id, unit);
  }
  for (const line of storyMap?.text.split('\n') ?? []) {
    const row = cells(line), linked = ids(row.join(' '), stories ? patterns.US : /\b(?:FR\d+(?:\.\d+)?|NFR\d+)\b/g);
    const targets = units.filter((u) => row.some((v) => v.split(/[\s,;/]+/).some((t) => t === u || unitIds.get(t) === u || t.replace(/^u\d+-/, '') === u)));
    for (const id of linked) assignments.set(id, new Set([...(assignments.get(id) ?? []), ...targets]));
  }
  if (stage.slug === 'user-stories') expected = ids(requirements().text, /\b(?:FR\d+(?:\.\d+)?|NFR\d+)\b(?!\.\d)/g);
  else if (['domain-design', 'units-generation'].includes(stage.slug)) expected = ids(stories?.text ?? requirements().text, stories ? patterns.US : patterns.FR);
  else if (['functional-design', 'code-generation'].includes(stage.slug)) {
    const sourceStories = stage.slug === 'functional-design' && !storyMap ? undefined : stories;
    expected = ids(sourceStories?.text ?? requirements().text, sourceStories ? patterns.AC : (stage.slug === 'functional-design' ? patterns.FR : /\b(?:FR\d+(?:\.\d+)?|NFR\d+)\b/g));
    if (sourceStories && context.unit) {
      if (!storyMap || !units.includes(context.unit)) throw new Error('Cannot resolve unit story assignment');
      expected = new Set([...expected].filter((ac) => assignments.get(`US${ac.slice(2).split('.').slice(0, 2).join('.')}`)?.has(context.unit)));
    }
  } else if (stage.slug === 'nfr-requirements') expected = ids(requirements().text, patterns.NFR);
  else if (['nfr-design', 'infrastructure-design'].includes(stage.slug)) {
    const sourceStage = stage.slug === 'nfr-design' || context.skippedStages?.includes('nfr-design') ? 'nfr-requirements' : 'nfr-design';
    const names = sourceStage === 'nfr-requirements' ? ['performance-requirements', 'security-requirements', 'scalability-requirements', 'reliability-requirements'] : ['performance-design', 'security-design', 'scalability-design', 'reliability-design', 'logical-components'];
    if (context.skippedStages?.includes(sourceStage)) expected = ids(requirements().text, patterns.NFR);
    else expected = ids(names.map((n) => get(n, true)?.text ?? '').join('\n'), patterns.detail);
  } else throw new Error(`Unsupported traceability stage ${stage.slug}`);
  if (!expected.size) findings.push('Authoritative upstream artifacts contain no applicable IDs');
  for (const id of expected) if (!declared.has(id)) findings.push(`${id}: omitted upstream ID`);
  for (const id of declared) if (!expected.has(id)) findings.push(`${id}: unknown upstream ID`);
  const targetIds = stage.slug === 'user-stories' ? ids(get('stories').text, patterns.US) : stage.slug === 'functional-design' ? ids(get('rules').text, patterns.BR) : undefined;
  const used = new Set();
  for (const row of table.values()) {
    if (row.status !== 'OK' || typeof row.target !== 'string') continue;
    if (targetIds) {
      const targets = ids(row.target, stage.slug === 'user-stories' ? patterns.US : patterns.BR);
      if (!targets.size) findings.push(`${row.id}: target requires authored identifier`);
      for (const target of targets) { used.add(target); if (!targetIds.has(target)) findings.push(`${row.id}: fabricated target ${target}`); }
    } else if (stage.slug === 'units-generation') {
      const target = unitIds.get(row.target) ?? row.target.replace(/^u\d+-/, '');
      if (!units.includes(target) || !assignments.get(row.id)?.has(target)) findings.push(`${row.id}: target not mapped to declared unit`);
    } else if (stage.slug === 'code-generation') {
      try { read(row.target); } catch (e) { findings.push(`${row.id}: invalid code target: ${e.message}`); }
    }
  }
  if (stage.slug === 'functional-design') for (const id of targetIds) if (!used.has(id) && !reverse.some((r) => r.id === id && ['Deferred', 'N/A'].includes(r.status) && r.target?.trim())) findings.push(`${id}: derived orphan`);
  for (const row of reverse) if (targetIds && !targetIds.has(row.id)) findings.push(`${row.id}: unknown reverse identifier`);
  return findings;
}

function field(state, name) {
  return state.split('\n').map((line) => new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escape(name)}(?:\\*\\*)?:\\s*(.*)$`).exec(line)?.[1]).find((s) => s !== undefined)?.trim() ?? '';
}
function claims(stage, outputs, context, read) {
  if (stage.slug !== 'intent-capture') throw new Error('claim-sources only supports intent-capture');
  const cfg = context.claims ?? {};
  const q = read(cfg.questionsPath ?? outputs.find((a) => stem(a.path) === 'intent-capture-questions')?.path).text;
  const state = read(cfg.statePath).text;
  let description = field(state, 'Project');
  const sourceMarker = field(state, 'Project Description Source');
  if (sourceMarker && sourceMarker !== 'project-description.json') throw new Error('Unsupported project description authority');
  if (cfg.descriptionPath || sourceMarker) {
    description = JSON.parse(read(cfg.descriptionPath ?? `${dirname(cfg.statePath)}/project-description.json`).text);
    if (typeof description !== 'string') throw new Error('Project description JSON must be one string');
  }
  const pasted = /<\/?document>/.test(description);
  if (pasted) description = description.replace(/<document>[^]*(?:<\/document>|$)/, '').trim();
  const scope = field(state, 'Scope');
  if (!description || !scope) throw new Error('Missing description or scope authority');
  const findings = [], register = new Set(), answered = new Set();
  // Reject syntax whose rendering this port cannot prove. This deliberately
  // errs toward requesting a visible citation rather than accepting hidden text.
  const ambiguous = (text) => /<[^>]*>|^\s*\[(?!Answer\])[^\]]+\]:|\[[^\]]+\]\s*(?:\(|\[)|\\\[|&#?\w+;/m.test(text.replace(/<!--[^]*?(?:-->|$)/g, ''));
  if (ambiguous(q)) findings.push('Questions contain unsupported HTML or reference-link syntax');
  for (const line of section(q, 'Sources')) {
    const match = /^\s*[-*+]\s+\[(desc|scope|memory:[\w.-]+)\]\s+(.+)$/.exec(line);
    if (!match) continue;
    const [, id, value] = match;
    if (register.has(id)) findings.push(`Duplicate source ${id}`);
    let valid = false;
    if (id === 'desc') {
      try { valid = JSON.parse(value.replace(/^Initial description:\s*/, '')) === description.trim(); } catch { valid = false; }
    } else if (id === 'scope') valid = value === `Workflow-selected scope: \`${scope}\`.` || value === `Workflow-selected scope: \`${scope}\``;
    else {
      const m = /^`([^`#]+)#([^`#]+)`:\s*("[^]*")$/.exec(value);
      if (m && Object.values(cfg.memoryPaths ?? {}).includes(m[1]) && /\/(org|team|project)\.md$/.test(m[1])) {
        const memory = read(m[1]).text;
        try { valid = section(memory, m[2], true).map((s) => s.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim()).includes(JSON.parse(m[3])); } catch { valid = false; }
      }
    }
    if (valid) register.add(id); else findings.push(`${id}: source does not match authority`);
  }
  for (const id of ['desc', 'scope']) if (!register.has(id)) findings.push(`Missing verified source ${id}`);
  const all = sections(q), seen = new Set();
  for (const s of all) {
    const id = /^Q\d+\b/.exec(s.name)?.[0];
    if (!id) continue;
    if (seen.has(id)) findings.push(`Duplicate question ${id}`); seen.add(id);
    const answers = s.lines.flatMap((line) => /^\[Answer\]:\s*(.*)$/.exec(line)?.[1] ?? []);
    if (answers.length !== 1) findings.push(`${id}: requires one answer`);
    if (answers.length === 1 && answers[0].trim() && !/^_+$/.test(answers[0].trim())) answered.add(id);
  }
  const confirmation = all.filter((s) => s.name === 'Assumption Confirmation');
  if (confirmation.length > 1) findings.push('Duplicate Assumption Confirmation');
  const accepted = new Set();
  const assumptionBody = confirmation[0]?.lines ?? [];
  const acceptance = assumptionBody.filter((s) => /^\[Answer\]:/.test(s));
  const acceptedAnswer = acceptance.length === 1 && acceptance[0] === '[Answer]: A. Accept assumptions';
  const normalize = (s) => s.replace(/^\s*[-*+]\s+/, '').replace(/\[assumption\]/g, '').replace(/\s+/g, ' ').trim();
  const blocks = (lines) => {
    const result = []; let block = '';
    for (const line of [...lines, '']) {
      if (/^ {0,3}#{1,6}\s/.test(line)) { if (block.trim()) result.push(block); block = ''; continue; }
      if (!line.trim() || /^\s*[-*+]\s+/.test(line) || /^\s*\|/.test(line)) { if (block.trim()) result.push(block); block = ''; }
      if (line.trim()) block += `${block ? ' ' : ''}${line.trim()}`;
    }
    return result;
  };
  for (const b of blocks(assumptionBody.filter((line) => !/^\[Answer\]:|^[AB]\.\s/.test(line)))) if (/^[-*+]\s/.test(b) && b.includes('[assumption]')) accepted.add(normalize(b));
  const deliverables = outputs.filter((a) => /\.md$/i.test(a.path) && !scaffold(stem(a.path)));
  if (!deliverables.length) findings.push('No claim deliverables');
  for (const doc of deliverables) {
    if (ambiguous(doc.text)) findings.push(`${doc.path}: unsupported HTML or link rendering`);
    if (!sections(doc.text).some((s) => s.name === 'Assumptions & Open Questions')) findings.push(`${doc.path}: missing Assumptions & Open Questions`);
    for (const s of sections(doc.text)) {
      if (s.rawName === 'Review') continue;
      for (const block of blocks(s.lines)) {
        if (/^\s*#|^\s*\|?[\s:|-]+\|?\s*$/.test(block)) continue;
        if (s.name === 'Sources' && block === `- [scope] Workflow-selected scope: \`${scope}\`.` && register.has('scope')) continue;
        const visible = block.replace(/(`+)(?!`)([^]*?)\1(?!`)/g, '');
        const tags = [...visible.matchAll(/(?<!\\)\[(desc|scope|Q\d+|memory:[\w.-]+|assumption)\]/g)].map((m) => m[1]);
        if (!tags.length) findings.push(`${doc.path}: uncited claim ${block.slice(0, 120)}`);
        for (const tag of tags) {
          if (tag === 'assumption') {
            if (s.name !== 'Assumptions & Open Questions' || !acceptedAnswer || !accepted.has(normalize(block))) findings.push(`${doc.path}: unaccepted or misplaced assumption`);
          } else if (/^Q\d+$/.test(tag)) {
            if (!answered.has(tag)) findings.push(`${doc.path}: unresolved ${tag}`);
          } else if (!register.has(tag) || (tag === 'desc' && pasted)) findings.push(`${doc.path}: invalid source ${tag}`);
          else if (tag === 'scope' && s.name !== 'Initial Scope Signal') findings.push(`${doc.path}: scope citation outside Initial Scope Signal`);
        }
      }
    }
  }
  return findings;
}

export function sensorApplicability(id, artifacts) {
  if (!SENSOR_MANIFESTS[id]) return { status: 'not_verified', reason: `Unsupported sensor ${id}` };
  const matches = id === 'linter' ? /\.(ts|js)$/ : id === 'type-check' ? /\.(ts|tsx)$/ : id === 'traceability' ? /(?:^|\/)traceability\.json$/ : undefined;
  if (!matches) return { status: 'applicable', files: artifacts.map((a) => a.path) };
  const files = artifacts.filter((a) => matches.test(a.path)).map((a) => a.path);
  return files.length ? { status: 'applicable', files } : { status: 'not_applicable', reason: `No observed files match ${SENSOR_MANIFESTS[id].matches}`, files: [] };
}

async function commandCheck(id, context, workspace, basis, runner, applicableFiles) {
  const cfg = context.commands?.[id];
  if (!cfg || typeof runner !== 'function') return { status: 'not_verified', findings: ['Configured command capture is unavailable'] };
  if ((!Array.isArray(cfg.command) || !cfg.command.length || cfg.command.some((s) => typeof s !== 'string' || !s || s.includes('\0'))) && typeof cfg.command !== 'string') throw new Error('Command must be an argument array or configured command string');
  if (id === 'type-check' && /(?:^|\s)(?:--check|-c)(?:\s|$)/.test([cfg.command].flat().join(' ')) && /(?:^|[\s/])node(?:\s|$)/.test([cfg.command].flat().join(' '))) return { status: 'not_verified', findings: ['Node syntax checking does not establish TypeScript type correctness'] };
  const base = realpathSync(workspace), cwd = realpathSync(resolve(base, cfg.cwd ?? '.'));
  const rel = relative(base, cwd);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Command cwd escapes workspace');
  const request = { id, command: cfg.command, cwd, timeoutMs: Math.min(Math.max(cfg.timeoutMs ?? 120000, 1), SENSOR_MANIFESTS[id].timeout_seconds * 1000), maxOutputBytes: 1024 * 1024, basis, files: applicableFiles };
  const result = await runner(request);
  if (!result || !Number.isInteger(result.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || !result.receipt || Buffer.byteLength(result.stdout + result.stderr) > request.maxOutputBytes) return { status: 'not_verified', findings: ['Command capture result is missing, malformed or unbounded'] };
  if (result.exitCode !== 0) return { status: 'fail', findings: [`Command exited ${result.exitCode}`, result.stderr.slice(0, 4096)], receipt: result.receipt, evidence_refs: result.evidence_refs ?? [] };
  const findings = [], advisories = [];
  if (cfg.format === 'eslint-json') {
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { return { status: 'not_verified', findings: ['Malformed linter JSON'], receipt: result.receipt }; }
    if (!Array.isArray(parsed) || !parsed.length || !parsed.every((r) => r && typeof r.filePath === 'string' && Array.isArray(r.messages) && Number.isInteger(r.errorCount) && Number.isInteger(r.warningCount) && r.messages.every((m) => m && typeof m.message === 'string' && Number.isInteger(m.severity) && [1, 2].includes(m.severity)))) return { status: 'not_verified', findings: ['Invalid or empty linter result schema'], receipt: result.receipt };
    for (const row of parsed) {
      if (row.errorCount !== row.messages.filter((m) => m.severity === 2).length || row.warningCount !== row.messages.filter((m) => m.severity === 1).length) findings.push(`${row.filePath}: inconsistent diagnostic counts`);
      for (const m of row.messages) (m.severity === 2 ? findings : advisories).push(`${row.filePath}:${m.line ?? '?'}:${m.ruleId ?? 'unknown'}: ${m.message}`);
    }
  } else if (cfg.format === 'tsc') {
    if (result.stdout.trim() || result.stderr.trim()) findings.push('Type checker emitted diagnostics despite successful exit');
  } else if (cfg.format !== 'exit-code') return { status: 'not_verified', findings: ['Unsupported command output format'], receipt: result.receipt };
  return { status: findings.length ? 'fail' : 'pass', findings, advisories, receipt: result.receipt, evidence_refs: result.evidence_refs ?? [] };
}

/** Read actual workspace artifacts and invoke the caller's Kontour command
 * capture port. No sensor result is accepted as caller-supplied evidence.
 * artifacts: paths or {path, digest?/sha256?, id?, stage?} descriptors.
 * context: upstreamArtifacts, codeArtifacts (actual files written by the stage),
 * skippedStages, unit, projectType, templates, writeSensorPolicy (optional
 * 'all_actual_source_writes'; defaults to the pinned stage-scoped contract),
 * claims {questionsPath,statePath,descriptionPath,memoryPaths}, commands.
 */
export async function runStageSensors({ stage, workspace, artifacts, context = {}, commandRunner }) {
  const checks = [], observed = new Map(); let totalBytes = 0;
  const read = (entry) => {
    const path = typeof entry === 'string' ? entry : entry?.path;
    const value = readArtifact(workspace, path);
    const expected = typeof entry === 'object' && (entry.sha256 ?? entry.digest);
    if (expected && expected !== value.digest) throw new Error(`Stale artifact basis: ${path}`);
    if (observed.has(path) && observed.get(path).digest !== value.digest) throw new Error(`Artifact changed while sensing: ${path}`);
    if (observed.size >= LIMIT && !observed.has(path)) throw new Error('Sensor artifact budget exceeded');
    if (!observed.has(path)) totalBytes += value.bytes;
    if (totalBytes > 16 * 1024 * 1024) throw new Error('Sensor total byte budget exceeded');
    observed.set(path, value);
    return value;
  };
  if (!stage || !Array.isArray(stage.sensors) || !Array.isArray(artifacts) || artifacts.length > LIMIT) return { status: 'not_verified', checks: [{ id: 'sensor-input', status: 'not_verified', findings: ['Malformed or unbounded sensor input'], evidence_refs: [] }] };
  let outputs, codeOutputs, snapshot;
  try {
    snapshot = readSnapshot();
    const pinned = snapshot.stages.find((s) => s.slug === stage.slug);
    if (!pinned || digest(pinned.sensors) !== digest(stage.sensors) || pinned.source_digest !== stage.source_digest) throw new Error('Stage sensor contract is not the pinned snapshot contract');
    stage = pinned;
    outputs = artifacts.filter((a) => typeof a === 'string' || !a.stage || a.stage === stage.slug).map(read);
    if (context.codeArtifacts !== undefined && (!Array.isArray(context.codeArtifacts) || context.codeArtifacts.length > LIMIT)) throw new Error('codeArtifacts must be a bounded array');
    if (context.writeSensorPolicy !== undefined && context.writeSensorPolicy !== 'all_actual_source_writes') throw new Error('Unsupported source-write sensor policy');
    codeOutputs = (context.codeArtifacts ?? []).filter((a) => typeof a === 'string' || !a.stage || a.stage === stage.slug).map(read);
    if (stage.sensors.length && !outputs.length) throw new Error('No output artifacts supplied');
  } catch (error) {
    return { status: 'not_verified', checks: (stage.sensors.length ? stage.sensors : ['sensor-contract']).map((id) => ({ id, status: 'not_verified', findings: [error.message], evidence_refs: [...observed.values()].map(({ path, digest }) => ({ path, sha256: digest })) })) };
  }
  const operations = {
    'required-sections': () => requiredSections(stage, outputs, context, read),
    'upstream-coverage': () => upstreamCoverage(stage, outputs, context, read, snapshot),
    traceability: () => traceability(stage, outputs, context, read),
    'claim-sources': () => claims(stage, outputs, context, read),
  };
  // At pinned 2a555f7, aidlc-graph.ts:1286 resolves only stage.sensors and
  // aidlc-run-sensors.ts Step10/11 dispatches only that active-stage result.
  // code-generation.md:560 describes obsolete every-write behavior in past
  // tense, not a global native hook. Preserve actual engine scope by default.
  // An explicit Kontour variant may additionally check observed source writes
  // using the same matchers, without modifying the pinned stage contract.
  const extraWriteSensors = context.writeSensorPolicy === 'all_actual_source_writes' && codeOutputs.length ? ['linter', 'type-check'] : [];
  const effectiveSensors = [...new Set([...stage.sensors, ...extraWriteSensors])];
  for (const id of effectiveSensors) {
    let check;
    try {
      const applicability = sensorApplicability(id, [...outputs, ...codeOutputs]);
      if (applicability.status === 'not_applicable' && ['linter', 'type-check'].includes(id)) check = { status: 'not_applicable', findings: [], applicability };
      else if (['linter', 'type-check'].includes(id)) check = { ...await commandCheck(id, context, workspace, [...observed.values()].map(({ path, digest }) => ({ path, sha256: digest })), commandRunner, applicability.files), applicability };
      else if (operations[id]) { const findings = operations[id](); check = { status: findings.length ? 'fail' : 'pass', findings }; }
      else check = { status: 'not_verified', findings: [`Unsupported sensor ${id}`] };
    } catch (error) { check = { status: 'not_verified', findings: [error.message] }; }
    checks.push({ id, ...check, trigger_origin: stage.sensors.includes(id) ? 'native-stage-contract' : 'kontour-source-write-policy', evidence_refs: [...observed.values()].map(({ path, digest }) => ({ path, sha256: digest })).concat(check.evidence_refs ?? []), ...(check.receipt ? { receipt: check.receipt } : {}) });
  }
  // Commands and asynchronous ports can mutate the workspace. A result that
  // describes bytes no longer present cannot admit an approval gate.
  const stale = [];
  for (const value of observed.values()) {
    try { if (readArtifact(workspace, value.path).digest !== value.digest) stale.push(value.path); } catch { stale.push(value.path); }
  }
  if (stale.length) checks.push({ id: 'basis-current', status: 'not_verified', findings: stale.map((path) => `Stale sensor basis: ${path}`), evidence_refs: [] });
  return { status: checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'not_verified') ? 'not_verified' : 'pass', checks };
}
