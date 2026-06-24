#!/usr/bin/env node
/**
 * run-conformance.js — Flow Agents policy engine conformance test runner.
 *
 * Usage:
 *   node packaging/conformance/run-conformance.js --self
 *   node packaging/conformance/run-conformance.js --adapter-cmd "node my-adapter.js"
 *   node packaging/conformance/run-conformance.js --adapter-cmd "..." --level L1
 *
 * Options:
 *   --self              Run against the canonical engine (must reach L2).
 *   --adapter-cmd CMD   Shell command to test. Receives JSON payload on stdin,
 *                       must produce exit code 0 (allow) or 2 (block).
 *   --level L0|L1|L2    Minimum level to enforce. Default: L2 for --self, L0 otherwise.
 *   --fixtures DIR      Override fixture directory (default: same dir as this script).
 *   --verbose           Print per-fixture payloads.
 *
 * No external npm dependencies — pure Node.js stdlib.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CONFORMANCE_DIR = __dirname;
const FIXTURES_DIR = path.join(CONFORMANCE_DIR, 'fixtures');
const HOOKS_DIR = path.resolve(CONFORMANCE_DIR, '../../scripts/hooks');
const RUN_HOOK = path.join(HOOKS_DIR, 'run-hook.js');

// Conformance levels — ordered so that L2 implies L1 implies L0.
const LEVEL_ORDER = ['L0', 'L1', 'L2'];
const LEVEL_POLICY_CLASSES = {
  L0: new Set([]),               // L0: telemetry only — no policy fixtures required
  L1: new Set(['workflow-steering', 'stop-goal-fit']),
  L2: new Set(['workflow-steering', 'stop-goal-fit', 'quality-gate', 'config-protection', 'evidence-capture']),
};

// -----------------------------------------------------------------------
// CLI parsing
// -----------------------------------------------------------------------

function parseArgs(argv) {
  const args = { self: false, adapterCmd: null, level: null, fixturesDir: FIXTURES_DIR, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--self') { args.self = true; }
    else if (arg === '--adapter-cmd') { args.adapterCmd = argv[++i]; }
    else if (arg === '--level') { args.level = argv[++i]; }
    else if (arg === '--fixtures') { args.fixturesDir = argv[++i]; }
    else if (arg === '--verbose') { args.verbose = true; }
  }
  return args;
}

// -----------------------------------------------------------------------
// Workspace setup helpers
// -----------------------------------------------------------------------

function createTempWorkspace(setup) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-conformance-'));
  for (const [relPath, content] of Object.entries(setup)) {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    fs.writeFileSync(fullPath, text, 'utf8');
  }
  return tmpDir;
}

function cleanupWorkspace(tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// -----------------------------------------------------------------------
// Fixture loading
// -----------------------------------------------------------------------

function loadFixtures(fixturesDir) {
  if (!fs.existsSync(fixturesDir)) {
    throw new Error(`Fixtures directory not found: ${fixturesDir}`);
  }
  return fs.readdirSync(fixturesDir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => {
      const filePath = path.join(fixturesDir, name);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return { name, ...data };
      } catch (e) {
        throw new Error(`Failed to load fixture ${name}: ${e.message}`);
      }
    });
}

// -----------------------------------------------------------------------
// Self-invocation (canonical engine)
// -----------------------------------------------------------------------

function invokeSelf(fixture, tmpWorkspace) {
  const payload = JSON.parse(JSON.stringify(fixture.payload));
  if (tmpWorkspace && payload.cwd === '__TEMP_WORKSPACE__') {
    payload.cwd = tmpWorkspace;
  }
  const input = JSON.stringify(payload);
  const env = Object.assign({}, process.env, fixture.env || {});
  const result = spawnSync(
    process.execPath,
    [RUN_HOOK, fixture.hook_id, fixture.hook_script],
    { input, encoding: 'utf8', env, timeout: 15000, cwd: process.cwd() }
  );
  return {
    exit_code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    input,
  };
}

// -----------------------------------------------------------------------
// Adapter invocation (third-party command)
// -----------------------------------------------------------------------

function invokeAdapter(adapterCmd, fixture, tmpWorkspace) {
  const payload = JSON.parse(JSON.stringify(fixture.payload));
  if (tmpWorkspace && payload.cwd === '__TEMP_WORKSPACE__') {
    payload.cwd = tmpWorkspace;
  }
  const input = JSON.stringify(payload);
  const env = Object.assign({}, process.env, fixture.env || {});
  const result = spawnSync('sh', ['-c', adapterCmd], {
    input,
    encoding: 'utf8',
    env,
    timeout: 15000,
    cwd: process.cwd(),
  });
  return {
    exit_code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    input,
  };
}

// -----------------------------------------------------------------------
// Assertion evaluation
// -----------------------------------------------------------------------

function evaluate(fixture, actual) {
  const expected = fixture.expected;
  const failures = [];

  if (typeof expected.exit_code === 'number' && actual.exit_code !== expected.exit_code) {
    failures.push(`exit_code: expected ${expected.exit_code}, got ${actual.exit_code}`);
  }

  if (expected.stdout_echoes_input) {
    // stdout should start with (or equal) the input JSON
    const normalized = actual.stdout.trim();
    const inputNorm = actual.input.trim();
    if (!normalized.startsWith(inputNorm) && !normalized.includes(inputNorm.slice(0, 40))) {
      failures.push(`stdout_echoes_input: stdout did not echo input payload`);
    }
  }

  if (expected.stdout_is_empty && actual.stdout.trim()) {
    failures.push(`stdout_is_empty: expected empty stdout, got: ${actual.stdout.slice(0, 60)}`);
  }

  if (expected.stderr_is_empty && actual.stderr.trim()) {
    failures.push(`stderr_is_empty: expected empty stderr, got: ${actual.stderr.slice(0, 60)}`);
  }

  if (Array.isArray(expected.stdout_contains)) {
    for (const needle of expected.stdout_contains) {
      if (!actual.stdout.includes(needle)) {
        failures.push(`stdout_contains: missing "${needle}"`);
      }
    }
  }

  if (Array.isArray(expected.stderr_contains)) {
    for (const needle of expected.stderr_contains) {
      if (!actual.stderr.includes(needle)) {
        failures.push(`stderr_contains: missing "${needle}"`);
      }
    }
  }

  return failures;
}

// -----------------------------------------------------------------------
// Main runner
// -----------------------------------------------------------------------

function run(argv) {
  const args = parseArgs(argv);

  if (!args.self && !args.adapterCmd) {
    console.error('Usage: node run-conformance.js --self');
    console.error('       node run-conformance.js --adapter-cmd "<command>"');
    process.exit(2);
  }

  const targetLevel = args.level || (args.self ? 'L2' : 'L0');
  if (!LEVEL_ORDER.includes(targetLevel)) {
    console.error(`Unknown conformance level: ${targetLevel}. Use L0, L1, or L2.`);
    process.exit(2);
  }

  // Load fixtures
  const fixtures = loadFixtures(args.fixturesDir);
  console.log(`\nFlow Agents Conformance Test Runner`);
  console.log(`====================================`);
  console.log(`Mode:    ${args.self ? 'self (canonical engine)' : `adapter: ${args.adapterCmd}`}`);
  console.log(`Target:  ${targetLevel}`);
  console.log(`Fixtures: ${fixtures.length} loaded from ${args.fixturesDir}`);
  console.log('');

  const results = [];

  for (const fixture of fixtures) {
    let tmpWorkspace = null;

    // Set up workspace if fixture needs one
    if (fixture.workspace_setup) {
      tmpWorkspace = createTempWorkspace(fixture.workspace_setup);
    }

    let actual;
    try {
      actual = args.self
        ? invokeSelf(fixture, tmpWorkspace)
        : invokeAdapter(args.adapterCmd, fixture, tmpWorkspace);
    } finally {
      if (tmpWorkspace) cleanupWorkspace(tmpWorkspace);
    }

    const failures = evaluate(fixture, actual);
    const passed = failures.length === 0;

    results.push({ fixture, actual, failures, passed });

    const icon = passed ? '  PASS' : '  FAIL';
    console.log(`${icon}  [${fixture.conformance_level}] ${fixture.name}`);
    if (!passed || args.verbose) {
      console.log(`       ${fixture.description}`);
      if (!passed) {
        for (const f of failures) {
          console.log(`       * ${f}`);
        }
      }
      if (args.verbose) {
        console.log(`       exit_code: ${actual.exit_code}`);
        if (actual.stderr.trim()) console.log(`       stderr: ${actual.stderr.trim().slice(0, 120)}`);
      }
    }
  }

  console.log('');
  console.log('--- Per-level verdict ---');

  const levelPassed = {};
  for (const level of LEVEL_ORDER) {
    // Fixtures at this level or below
    const levelFixtures = results.filter(r => {
      const fLevel = r.fixture.conformance_level;
      return LEVEL_ORDER.indexOf(fLevel) <= LEVEL_ORDER.indexOf(level);
    });

    const requiredPolicies = LEVEL_POLICY_CLASSES[level];
    // For L0 there are no policy fixtures required — only check that no fixture at L0 level fails
    const requiredResults = level === 'L0'
      ? levelFixtures.filter(r => r.fixture.conformance_level === 'L0')
      : levelFixtures.filter(r => requiredPolicies.has(r.fixture.policy_class) || r.fixture.conformance_level === 'L0');

    const allPass = requiredResults.every(r => r.passed);
    levelPassed[level] = allPass;

    const passCount = requiredResults.filter(r => r.passed).length;
    const icon = allPass ? 'PASS' : 'FAIL';
    console.log(`  ${icon}  ${level}  (${passCount}/${requiredResults.length} required fixtures pass)`);

    if (!allPass) {
      const failing = requiredResults.filter(r => !r.passed);
      for (const r of failing.slice(0, 5)) {
        console.log(`         - ${r.fixture.name}: ${r.failures[0]}`);
      }
    }
  }

  console.log('');

  // Determine highest satisfied level
  let highestLevel = null;
  for (const level of LEVEL_ORDER) {
    if (levelPassed[level]) highestLevel = level;
    else break;
  }

  const totalPass = results.filter(r => r.passed).length;
  const totalFail = results.filter(r => !r.passed).length;
  console.log(`Total: ${totalPass} passed, ${totalFail} failed`);
  console.log(`Highest conformance level achieved: ${highestLevel || 'none'}`);

  // Exit code: 0 if target level reached, 1 otherwise
  const targetReached = highestLevel !== null && LEVEL_ORDER.indexOf(highestLevel) >= LEVEL_ORDER.indexOf(targetLevel);
  if (targetReached) {
    console.log(`\nSELF-TEST VERDICT: ${targetLevel} PASS — adapter satisfies ${targetLevel} conformance.`);
    process.exit(0);
  } else {
    console.log(`\nSELF-TEST VERDICT: ${targetLevel} FAIL — adapter does not satisfy ${targetLevel} conformance.`);
    process.exit(1);
  }
}

run(process.argv.slice(2));
