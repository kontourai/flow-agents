#!/usr/bin/env node
// Development-time data importer. Never execute upstream workflow code or prose.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = '2a555f7a4387cd1b8254029cccb9fd1e99974574';
const VERSION = '2.11.0';
const REPOSITORY = 'https://github.com/awslabs/aidlc-workflows';
const COMPILED = {
  'stage-graph.json': 'c2d00a0e04a1fe2cf994d26a98ab6f35511c08b99e201a3cb145befc9b7f1eef',
  'scope-grid.json': '1dbf101c33783ff386a83101da75fbc376459f6b5cb11f097a5501ccd94a2b5d',
};
const FIELDS = [
  'slug', 'name', 'phase', 'execution', 'condition', 'lead_agent', 'support_agents',
  'mode', 'produces', 'optional_produces', 'produces_kinds', 'consumes',
  'requires_stage', 'sensors', 'scopes', 'reviewer', 'review_artifact',
  'reviewer_max_iterations', 'review_class', 'summary_confirmation', 'for_each',
  'workspace_requires', 'inputs', 'outputs',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function committedFile(checkout, path) {
  const actual = readFileSync(resolve(checkout, path));
  const committed = execFileSync('git', ['-C', checkout, 'show', `${COMMIT}:${path}`]);
  if (!actual.equals(committed)) throw new Error(`Modified upstream input: ${path}`);
  return actual;
}

function frontmatter(text, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`Missing frontmatter: ${path}`);
  return { header: match[1], body: text.slice(match[0].length) };
}

// Deliberately restricted to the flat scalar/string-list scope schema at this pin.
// Reject unknown YAML syntax rather than quietly changing a policy value.
function parseScope(header, path) {
  const result = {};
  let listKey;
  for (const line of header.split(/\r?\n/)) {
    const item = /^  - ([^\r\n]+)$/.exec(line);
    if (item && listKey) { result[listKey].push(item[1]); continue; }
    const entry = /^([A-Za-z_][A-Za-z_0-9]*):(?: (.*))?$/.exec(line);
    if (!entry || Object.hasOwn(result, entry[1])) throw new Error(`Unsupported scope frontmatter: ${path}: ${line}`);
    const [, key, value] = entry;
    listKey = undefined;
    if (value === undefined) { result[key] = []; listKey = key; }
    else if (value === 'true' || value === 'false') result[key] = value === 'true';
    else if (value === '[]') result[key] = [];
    else if (value.startsWith('"')) result[key] = JSON.parse(value);
    else if (/^[A-Za-z0-9][A-Za-z0-9 _.,/()\-]*$/.test(value)) result[key] = value;
    else throw new Error(`Unsupported scope scalar: ${path}: ${line}`);
  }
  return result;
}

export function importUpstream(checkout, outputDirectory) {
  checkout = resolve(checkout);
  const head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== COMMIT) throw new Error(`Expected upstream HEAD ${COMMIT}; found ${head}`);
  const versionText = committedFile(checkout, 'core/tools/aidlc-version.ts').toString('utf8');
  if (!versionText.includes(`AIDLC_VERSION = "${VERSION}"`)) throw new Error('Unexpected upstream version');
  const compiled = {};
  for (const [name, expectedDigest] of Object.entries(COMPILED)) {
    const bytes = readFileSync(resolve(checkout, 'dist/claude/.claude/tools/data', name));
    if (sha256(bytes) !== expectedDigest) throw new Error(`Compiled input differs from pinned research data: ${name}`);
    compiled[name] = JSON.parse(bytes.toString('utf8'));
  }
  const graph = compiled['stage-graph.json'];
  const grid = compiled['scope-grid.json'];
  if (graph.length !== 33 || Object.keys(grid).length !== 11) throw new Error('Unexpected methodology size');
  const stages = graph.map((stage) => {
    if (!/^[a-z][a-z0-9-]*$/.test(stage.slug) || !/^[a-z]+$/.test(stage.phase)) throw new Error('Invalid stage path');
    const source_path = `core/aidlc-common/stages/${stage.phase}/${stage.slug}.md`;
    const source = committedFile(checkout, source_path);
    const record = Object.fromEntries(FIELDS.filter((key) => Object.hasOwn(stage, key)).map((key) => [key, stage[key]]));
    return { ...record, source_path, source_digest: sha256(source), procedure: frontmatter(source.toString('utf8'), source_path).body };
  });
  const profiles = Object.fromEntries(Object.keys(grid).sort().map((name) => {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid profile path');
    const path = `core/scopes/aidlc-${name}.md`;
    const source = committedFile(checkout, path).toString('utf8');
    const values = parseScope(frontmatter(source, path).header, path);
    if (values.name !== name) throw new Error(`Profile name mismatch: ${path}`);
    const defaults = Object.fromEntries(Object.entries(values).filter(([key]) => !['name', 'keywords', 'description'].includes(key)));
    const membership = grid[name].stages;
    for (const stage of stages) {
      if (!['EXECUTE', 'SKIP'].includes(membership[stage.slug])) throw new Error(`Unknown profile membership: ${name}/${stage.slug}`);
    }
    return [name, { stages: stages.filter((stage) => membership[stage.slug] === 'EXECUTE').map((stage) => stage.slug), defaults }];
  }));
  const agentPaths = execFileSync('git', ['-C', checkout, 'ls-tree', '-r', '--name-only', COMMIT, '--', 'core/agents'], { encoding: 'utf8' })
    .trim().split('\n').filter((path) => path.endsWith('.md')).sort();
  if (agentPaths.length !== 14) throw new Error('Unexpected agent count');
  const agents = agentPaths.map((source_path) => {
    const source = committedFile(checkout, source_path);
    const { header, body } = frontmatter(source.toString('utf8'), source_path);
    const slug = source_path.slice('core/agents/'.length, -'.md'.length);
    if (!/^[a-z][a-z0-9-]*$/.test(slug)) throw new Error('Invalid agent path');
    return { slug, source_path, source_digest: sha256(source), source_frontmatter: header, procedure: body };
  });
  const snapshot = { schema_version: '1.0', upstream: { repository: REPOSITORY, commit: COMMIT, version: VERSION }, stages, agents, profiles };
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(resolve(outputDirectory, 'LICENSE-MIT-0'), committedFile(checkout, 'LICENSE').toString('utf8').trimEnd() + '\n');
  return snapshot;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [checkout, output] = process.argv.slice(2);
  if (!checkout || process.argv.length > 4) throw new Error('Usage: node kits/aidlc/scripts/import-upstream.mjs <pinned-upstream-checkout> [output-directory]');
  const destination = output ? resolve(output) : resolve(dirname(fileURLToPath(import.meta.url)), '../upstream');
  const snapshot = importUpstream(checkout, destination);
  console.log(`Imported ${snapshot.stages.length} stages and ${Object.keys(snapshot.profiles).length} profiles from ${COMMIT}`);
}
