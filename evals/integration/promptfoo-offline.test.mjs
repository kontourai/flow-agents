import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));

test('installed promptfoo loads repository assertions and rejects negative controls offline', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fa-pf-'));
  try {
    // Fail closed on accidental provider, update-check, or telemetry connections.
    writeFileSync(path.join(dir, 'offline.cjs'), `
const net = require('node:net');
net.Socket.prototype.connect = function () { throw new Error('offline eval forbids network'); };
globalThis.fetch = async () => { throw new Error('offline eval forbids fetch'); };
`);
    writeFileSync(path.join(dir, 'provider.cjs'), `
if (process.env.PROMPTFOO_DISABLE_TELEMETRY !== 'true') throw new Error('telemetry must be disabled');
process.stdout.write(process.argv[2]);
`);
    const telemetry = path.join(dir, 'events.jsonl');
    const snapshot = path.join(dir, 'snapshot');
    writeFileSync(snapshot, '0');
    const assertion = (name, config = {}) => ({ type: 'javascript', value: `file://${path.join(root, 'evals/lib/assertions', name + '.js')}`, config });
    const run = (name, events, output, assertions, success) => {
      writeFileSync(telemetry, events.map(e => JSON.stringify(e)).join('\n'));
      const config = path.join(dir, name + '.json');
      const result = path.join(dir, name + '-result.json');
      writeFileSync(config, JSON.stringify({
        prompts: ['{{prompt}}'], providers: [`exec: ${process.execPath} ${path.join(dir, 'provider.cjs')}`],
        tests: [{ vars: { prompt: output }, assert: assertions }], sharing: false,
      }));
      const child = spawnSync(path.join(root, 'node_modules/.bin/promptfoo'),
        ['eval', '-c', config, '--no-cache', '--no-write', '--no-share', '--no-progress-bar', '--no-table', '-o', result], {
          cwd: dir, encoding: 'utf8', timeout: 60000,
          env: {
            PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NO_COLOR: '1',
            NODE_OPTIONS: `--require=${path.join(dir, 'offline.cjs')}`,
            PROMPTFOO_CONFIG_DIR: path.join(dir, 'config'), PROMPTFOO_DISABLE_TELEMETRY: 'true',
            PROMPTFOO_DISABLE_WAL_MODE: 'true', PROMPTFOO_DISABLE_UPDATE: 'true',
            FLOW_AGENTS_EVAL_TELEMETRY_FILE: telemetry, FLOW_AGENTS_EVAL_TELEMETRY_SNAPSHOT: snapshot,
          },
        });
      assert.ifError(child.error);
      assert.equal(child.signal, null, child.stderr);
      const json = JSON.parse(readFileSync(result, 'utf8'));
      assert.equal(json.results.stats.errors, 0, child.stdout + child.stderr);
      assert.equal(json.results.stats.successes, success ? 1 : 0, JSON.stringify(json.results));
      assert.equal(json.results.stats.failures, success ? 0 : 1, JSON.stringify(json.results));
      assert.equal(child.status === 0, success, child.stdout + child.stderr);
    };
    const delegation = { event_type: 'agent.delegate', agent: { target: 'tool-explore-entry' } };
    const read = { event_type: 'tool.invoke', agent: { name: 'tool-explore-entry' }, tool: { name: 'read files' } };
    run('telemetry-pass', [delegation, read], 'fixture', [assertion('delegated-to', { expected: 'tool-explore-entry' }), assertion('tool-called', { tool: 'read files' }), assertion('no-write-tools')], true);
    run('text-fallback', [], 'tool-explore-entry read files', [assertion('delegated-to', { expected: 'tool-explore-entry' }), assertion('tool-called', { tool: 'read files' })], true);
    run('missing-delegation', [], 'fixture', [assertion('delegated-to', { expected: 'tool-explore-entry' })], false);
    run('missing-tool', [], 'fixture', [assertion('tool-called', { tool: 'read files' })], false);
    run('forbidden-write', [{ ...read, tool: { name: 'apply_patch' } }], 'fixture', [assertion('no-write-tools')], false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installed metadata clients retain headers, bigint decoding, and refusal against loopback fixtures', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, flavor: req.headers['metadata-flavor'] });
    if (req.url.endsWith('/missing')) { res.writeHead(404); res.end('missing'); return; }
    if (!req.url.endsWith('/no-flavor')) res.setHeader('Metadata-Flavor', 'Google');
    res.setHeader('Content-Type', 'application/json');
    res.end('{"id":12345678901234567890}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // GCE_METADATA_IP takes precedence over HOST. Pin both, and prevent inherited
  // proxy settings from redirecting a fixture request outside this process.
  const envKeys = ['GCE_METADATA_HOST', 'GCE_METADATA_IP', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  process.env.GCE_METADATA_HOST = process.env.GCE_METADATA_IP = `127.0.0.1:${server.address().port}`;
  for (const key of envKeys.filter(key => /proxy/i.test(key))) delete process.env[key];
  process.env.NO_PROXY = process.env.no_proxy = '*';
  try {
    const promptfooRequire = createRequire(require.resolve('promptfoo'));
    for (const metadata of [require('gcp-metadata'), promptfooRequire('gcp-metadata')]) {
      const value = await metadata.instance('id');
      assert.equal(value.id.toString(), '12345678901234567890');
      await assert.rejects(metadata.instance('missing'));
      await assert.rejects(metadata.instance('no-flavor'), /Metadata-Flavor/);
    }
    assert.equal(requests.length, 6);
    assert.ok(requests.every(r => r.flavor === 'Google' && r.url.startsWith('/computeMetadata/v1/instance/')));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
});
