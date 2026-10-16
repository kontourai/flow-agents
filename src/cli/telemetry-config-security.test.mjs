// #1511: real bash/jq, isolated HOME and data, no production/network inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const baseline = process.env.TELEMETRY_SECURITY_BASELINE;
const evidence = process.env.TELEMETRY_SECURITY_EVIDENCE;
const shells = [...new Set(['/bin/bash', spawnSync('which', ['bash'], { encoding: 'utf8' }).stdout.trim()])];
const canary = ['isolated', '1511', 'canary'].join('-');
let seq = 0;
function fixture(shell, config, source = 'installed') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-security-1511-'));
  const dir = path.join(home, 'ws/scripts/telemetry');
  fs.cpSync(path.join(root, 'scripts/telemetry'), dir, { recursive: true });
  if (process.env.TELEMETRY_SECURITY_SOURCE) {
    for (const file of ['config', 'redact', 'transport']) fs.copyFileSync(path.join(process.env.TELEMETRY_SECURITY_SOURCE, `${file}.sh`), path.join(dir, `lib/${file}.sh`));
  }
  if (baseline) {
    for (const file of ['config', 'redact', 'transport']) fs.copyFileSync(path.join(baseline, `baseline-${file}.sh`), path.join(dir, `lib/${file}.sh`));
  }
  const audit = path.join(home, 'audit-transport.sh');
  fs.copyFileSync(baseline ? path.join(baseline, 'baseline-audit-transport.sh') : path.join(root, 'scripts/hooks/lib/audit-transport.sh'), audit);
  const data = path.join(home, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'full.jsonl'), '{}\n');
  fs.writeFileSync(path.join(data, 'audit.jsonl'), '{}\n');
  const outside = path.join(home, 'outside');
  fs.writeFileSync(outside, '# untouched fixture\n');
  const conf = source === 'installed' ? path.join(dir, 'telemetry.conf') : source === 'workspace' ? path.join(home, 'ws/.kontourai/telemetry-console.conf') : source === 'global' ? path.join(home, '.flow-agents/telemetry-console.conf') : path.join(home, 'explicit.conf');
  fs.mkdirSync(path.dirname(conf), { recursive: true });
  fs.writeFileSync(conf, 'channels=full\nchannel.full.endpoint_url=\nmax_log_size_mb=0\ngovernance_audit_max_size_mb=0\n' + config({ home, data, outside }) + '\n', { mode: 0o600 });
  if (source !== 'installed') fs.writeFileSync(path.join(dir, 'telemetry.conf'), 'enabled=false\n');
  const env = { HOME: home, PATH: process.env.PATH, TELEMETRY_DIR: dir, TELEMETRY_DATA_DIR: data, CANARY_SECRET: canary };
  if (source === 'explicit') env.TELEMETRY_CONFIG_FILE = conf;
  function run(script) {
    const r = spawnSync(shell, ['-c', 'source "$TELEMETRY_DIR/lib/config.sh"; source "$TELEMETRY_DIR/lib/transport.sh"; source "$1"; ' + script, '_', audit], { env, encoding: 'utf8', timeout: 10000 });
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, `probe-${++seq}.log`), JSON.stringify({ shell, source, script, status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message }, null, 2));
    }
    return r;
  }
  return { home, data, outside, run, cleanup() { fs.rmSync(home, { recursive: true, force: true }); } };
}
for (const shell of shells) {
  test(`${shell}: arithmetic canary ${baseline ? 'baseline executes' : 'all sources reject'}`, () => {
    for (const source of baseline ? ['installed'] : ['installed', 'workspace', 'global', 'explicit']) {
      for (const key of ['max_log_files', 'max_log_size_mb', 'governance_audit_max_files', 'governance_audit_max_size_mb']) {
        const f = fixture(shell, ({ home }) => `${key}=a[$(touch ${home}/marker)]`, source);
        try {
          const r = f.run('transport_maybe_rotate; audit_maybe_rotate; true');
          assert.equal(fs.existsSync(path.join(f.home, 'marker')), !!baseline, `${source} ${key}: ${r.stderr}`);
          if (!baseline) { assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /rejected invalid setting/); }
        } finally { f.cleanup(); }
      }
    }
  });
  test(`${shell}: arbitrary append canary`, () => {
    const f = fixture(shell, ({ outside }) => `channel.full.log_file=${outside}\nchannel.full.redact=none`);
    try {
      const r = f.run('transport_emit \'{"tool":{"output":"$(harmless-unexecuted-text)"}}\'; true');
      assert.equal(r.status, 0, r.stderr);
      const bytes = fs.readFileSync(f.outside, 'utf8');
      if (baseline) assert.match(bytes, /harmless-unexecuted-text/);
      else { assert.equal(bytes, '# untouched fixture\n'); assert.match(r.stderr, /rejected invalid setting/); assert.match(fs.readFileSync(path.join(f.data, 'full.jsonl'), 'utf8'), /harmless-unexecuted-text/); }
    } finally { f.cleanup(); }
  });
  test(`${shell}: jq environment extraction canary`, () => {
    const f = fixture(shell, () => 'channel.full.redact=x = env.CANARY_SECRET | .y\nconsole_telemetry_redact=x = env.CANARY_SECRET | .y');
    try {
      const r = f.run('transport_emit \'{"tool":{"output":"ordinary"}}\'; true');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.readFileSync(path.join(f.data, 'full.jsonl'), 'utf8').includes(canary), !!baseline);
      if (!baseline) assert.match(r.stderr, /rejected invalid setting/);
    } finally { f.cleanup(); }
  });
  if (baseline) continue;
  test(`${shell}: path containment, traversal, symlink and device rejection`, () => {
    for (const value of ['/dev/tcp/127.0.0.1/9', '/dev/null', 'relative.jsonl', 'traversal', 'prefix', 'symlink', 'symlink-dir', 'missing-dir', 'directory', 'fifo']) {
      const f = fixture(shell, ({ data, outside }) => {
        fs.symlinkSync(outside, path.join(data, 'link'));
        fs.symlinkSync(path.dirname(outside), path.join(data, 'linked-dir'));
        spawnSync('mkfifo', [path.join(data, 'pipe')]);
        const paths = { traversal: `${data}/../outside`, prefix: `${data}-other/log`, symlink: `${data}/link`, "symlink-dir": `${data}/linked-dir/escape`, "missing-dir": `${data}/missing/log.jsonl`, directory: data, fifo: `${data}/pipe` };
        return `channel.full.log_file=${paths[value] ?? value}`;
      });
      try { const r = f.run('transport_emit \'{"event":"retained"}\'; true'); assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /rejected invalid setting/, value); assert.equal(fs.readFileSync(f.outside, 'utf8'), '# untouched fixture\n'); }
      finally { f.cleanup(); }
    }
  });
  test(`${shell}: ordinary operator settings retain precedence, decimal rotation and field redaction work`, () => {
    const f = fixture(shell, ({ data }) => `max_log_size_mb=000\nmax_log_files=003\ngovernance_audit_max_size_mb=000\ngovernance_audit_max_files=003\nchannel.full.log_file=${data}/custom.jsonl\nchannel.full.redact=tool.output, turn.prompt_text\nenabled=true`, 'workspace');
    try {
      const r = f.run('transport_emit \'{"tool":{"output":"private"},"turn":{"prompt_text":"private"},"event":"retained"}\'; transport_maybe_rotate; audit_maybe_rotate; printf "%s\\n" "$TELEMETRY_ENABLED"');
      assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, ''); assert.match(r.stdout, /true/);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.data, 'custom.1.jsonl'), 'utf8')), { tool: { output: null }, turn: { prompt_text: null }, event: 'retained' });
      assert.equal(fs.readFileSync(path.join(f.data, 'audit.1.jsonl'), 'utf8'), '{}\n');
    } finally { f.cleanup(); }
  });
  test(`${shell}: unsafe first channel does not drop a safe later channel`, () => {
    const f = fixture(shell, () => 'channels=full,analytics\nchannel.analytics.redact=none');
    try {
      fs.rmSync(path.join(f.data, 'full.jsonl')); fs.symlinkSync(f.outside, path.join(f.data, 'full.jsonl'));
      const r = f.run('transport_emit \'{"event":"retained"}\'');
      assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /unsafe log destination/);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.data, 'analytics.jsonl'), 'utf8')), { event: 'retained' });
    } finally { f.cleanup(); }
  });
  test(`${shell}: background hook reports unsafe destinations in foreground`, () => {
    const f = fixture(shell, () => '');
    try {
      fs.rmSync(path.join(f.data, 'full.jsonl')); fs.symlinkSync(f.outside, path.join(f.data, 'full.jsonl'));
      const r = spawnSync(shell, [path.join(f.home, 'ws/scripts/telemetry/telemetry.sh'), 'postToolUse', 'claude-code'], {
        input: JSON.stringify({ session_id: 'isolated-1511', tool_name: 'Bash', tool_input: { command: 'echo' }, tool_response: 'ordinary' }),
        env: { HOME: f.home, PATH: process.env.PATH, TELEMETRY_DATA_DIR: f.data }, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /unsafe log destination/);
      assert.equal(fs.readFileSync(f.outside, 'utf8'), '# untouched fixture\n');
    } finally { f.cleanup(); }
  });
  test(`${shell}: detached hook returns before a slow channel transport`, () => {
    const f = fixture(shell, () => 'channel.full.endpoint_url=http://example.invalid');
    try {
      const bin = path.join(f.home, 'bin'); fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash\nsleep 3\ntouch '${f.home}/curl-finished'\n`, { mode: 0o700 });
      const start = Date.now();
      const r = spawnSync(shell, [path.join(f.home, 'ws/scripts/telemetry/telemetry.sh'), 'postToolUse', 'claude-code'], {
        input: JSON.stringify({ session_id: 'isolated-1511', tool_name: 'Bash', tool_input: { command: 'echo' }, tool_response: 'ordinary' }),
        env: { HOME: f.home, PATH: `${bin}:${process.env.PATH}`, TELEMETRY_DATA_DIR: f.data }, encoding: 'utf8', timeout: 2000,
      });
      assert.equal(r.status, 0, r.stderr); assert.ok(Date.now() - start < 2000, 'hook waited for background curl');
      for (let i = 0; i < 150 && !fs.existsSync(path.join(f.home, 'curl-finished')); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      assert.ok(fs.existsSync(path.join(f.home, 'curl-finished')), 'isolated fake curl did not finish');
    } finally { if (fs.existsSync(path.join(f.home, 'curl-finished'))) f.cleanup(); }
  });
  test(`${shell}: relative environment log paths still rotate`, () => {
    const f = fixture(shell, () => 'channel.full.redact=none');
    try {
      const r = f.run('cd "$TELEMETRY_DATA_DIR"; TELEMETRY_CHANNEL_FULL_LOG_FILE=relative.jsonl; transport_emit \'{"event":"retained"}\'; transport_maybe_rotate');
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.data, 'relative.1.jsonl'), 'utf8')), { event: 'retained' });
    } finally { f.cleanup(); }
  });
  test(`${shell}: background Stop hook reports unsafe rotation targets`, () => {
    const f = fixture(shell, () => '');
    try {
      fs.symlinkSync(f.outside, path.join(f.data, 'full.1.jsonl'));
      const r = spawnSync(shell, [path.join(f.home, 'ws/scripts/telemetry/telemetry.sh'), 'stop', 'claude-code'], {
        input: JSON.stringify({ session_id: 'isolated-1511' }),
        env: { HOME: f.home, PATH: process.env.PATH, TELEMETRY_DATA_DIR: f.data }, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /unsafe log destination/);
      assert.equal(fs.readFileSync(f.outside, 'utf8'), '# untouched fixture\n');
    } finally { f.cleanup(); }
  });
  test(`${shell}: extensionless log rotation stays inside the data directory`, () => {
    const f = fixture(shell, ({ data }) => `channel.full.log_file=${data}/extensionless\nchannel.full.redact=none`);
    try {
      const r = f.run('transport_emit \'{"event":"retained"}\'; transport_maybe_rotate');
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.data, 'extensionless.1.extensionless'), 'utf8')), { event: 'retained' });
    } finally { f.cleanup(); }
  });
  test(`${shell}: mixed-case operator relay opt-outs remain off`, () => {
    for (const value of ['False', 'Off', 'nO', 'TrUe']) {
      const f = fixture(shell, () => `console_url=https://example.invalid\nconsole_economics_relay=${value}\nconsole_liveness_relay=${value}`);
      try { const r = f.run('printf "%s/%s" "$FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY" "$FLOW_AGENTS_CONSOLE_LIVENESS_RELAY"'); assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, ''); assert.equal(r.stdout, value === 'TrUe' ? '1/1' : '0/0'); }
      finally { f.cleanup(); }
    }
  });
  test(`${shell}: unsafe effective defaults fail visibly without outside writes`, () => {
    for (const kind of ['symlink', 'fifo', 'directory', 'rotation']) {
      const f = fixture(shell, () => 'channel.full.log_file=/dev/null');
      try {
        const target = path.join(f.data, kind === 'rotation' ? 'full.1.jsonl' : 'full.jsonl');
        fs.rmSync(target, { force: true });
        if (kind === 'fifo') spawnSync('mkfifo', [target]);
        else if (kind === 'directory') fs.mkdirSync(target);
        else fs.symlinkSync(f.outside, target);
        const r = f.run(kind === 'rotation' ? 'transport_maybe_rotate' : 'transport_emit \'{"event":"retained"}\'');
        assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /unsafe log destination/);
        assert.equal(fs.readFileSync(f.outside, 'utf8'), '# untouched fixture\n');
      } finally { f.cleanup(); }
    }
    const f = fixture(shell, () => '');
    try { fs.rmSync(path.join(f.data, 'audit.jsonl')); fs.symlinkSync(f.outside, path.join(f.data, 'audit.jsonl')); const r = f.run('audit_emit \'{"event":"retained"}\''); assert.equal(r.status, 1); assert.match(r.stderr, /unsafe log destination/); assert.equal(fs.readFileSync(f.outside, 'utf8'), '# untouched fixture\n'); }
    finally { f.cleanup(); }
  });
  test(`${shell}: non-digits and overflow leave rotation defaults intact`, () => {
    for (const value of ['-1', '1+2', 'nan', '999999999999999999999999999999', '١']) {
      const f = fixture(shell, () => `max_log_files=${value}\nmax_log_size_mb=${value}\ngovernance_audit_max_files=${value}\ngovernance_audit_max_size_mb=${value}`);
      try {
        const r = f.run('printf "%s/%s/%s/%s" "$TELEMETRY_MAX_LOG_FILES" "$TELEMETRY_MAX_LOG_SIZE_MB" "$TELEMETRY_GOVERNANCE_AUDIT_MAX_FILES" "$TELEMETRY_GOVERNANCE_AUDIT_MAX_SIZE_MB"');
        assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '3/0/5/0');
        assert.equal((r.stderr.match(/rejected invalid setting/g) ?? []).length, 4);
      } finally { f.cleanup(); }
    }
  });
  test(`${shell}: scalar field parents retain ordinary events`, () => {
    const f = fixture(shell, () => 'channel.full.redact=tool.output,turn.prompt_text');
    try {
      const r = f.run('transport_emit \'{"tool":"scalar","turn":{"prompt_text":"private"},"event":"retained"}\'; true');
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.data, 'full.jsonl'), 'utf8').trim().split('\n').at(-1)), { tool: 'scalar', turn: { prompt_text: null }, event: 'retained' });
    } finally { f.cleanup(); }
  });
  test(`${shell}: direct redaction treats jq-like override as literal data`, () => {
    const f = fixture(shell, () => '');
    try { const r = f.run('redact_event \'{"event":"retained"}\' \'x = env.CANARY_SECRET | .y\''); assert.equal(r.status, 0, r.stderr); assert.ok(!r.stdout.includes(canary)); assert.equal(JSON.parse(r.stdout).event, 'retained'); }
    finally { f.cleanup(); }
  });
}
