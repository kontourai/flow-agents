#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;
const numericFields = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'estimated_cost_usd',
  'duration_s',
];

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function correlation(event) {
  const value = event && event.run_correlation;
  return value
    && value.schema_version === '1.0'
    && typeof value.correlation_id === 'string'
    && value.correlation_id.length > 0
    ? value
    : null;
}

function baselineFile(root, envelope) {
  const digest = crypto.createHash('sha256').update(envelope.correlation_id).digest('hex');
  return path.join(path.resolve(root), 'run-usage-baselines', `${digest}.json`);
}

function ensureStore(root) {
  const resolved = path.resolve(root);
  const rootIdentity = fs.lstatSync(resolved);
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw new Error('usage baseline root must be a regular directory');
  const store = path.join(resolved, 'run-usage-baselines');
  try {
    fs.mkdirSync(store, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const identity = fs.lstatSync(store);
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('usage baseline store must be a regular directory');
  return store;
}

function readBaseline(file, envelope) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    const named = fs.lstatSync(file);
    if (named.dev !== opened.dev || named.ino !== opened.ino) return null;
    return JSON.stringify(value.run_correlation) === JSON.stringify(envelope) ? value : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageDelta(current, baseline) {
  const output = { ...current };
  for (const field of numericFields) {
    if (field === 'estimated_cost_usd' && (current[field] == null || baseline[field] == null)) {
      output[field] = null;
    } else {
      output[field] = Math.max(0, validNumber(current[field]) - validNumber(baseline[field]));
    }
  }
  const before = new Map((Array.isArray(baseline.by_model) ? baseline.by_model : []).map((entry) => [entry.model, entry]));
  output.by_model = (Array.isArray(current.by_model) ? current.by_model : []).map((entry) => {
    const prior = before.get(entry.model);
    const delta = { ...entry };
    for (const field of numericFields) {
      if (field === 'estimated_cost_usd' && (entry[field] == null || (prior && prior[field] == null))) {
        delta[field] = null;
      } else {
        delta[field] = Math.max(0, validNumber(entry[field]) - validNumber(prior && prior[field]));
      }
    }
    return delta;
  });
  return {
    ...output,
    semantics: 'delta',
    scope: 'run',
    baseline_status: 'present',
  };
}

function main() {
  const action = process.argv[2];
  const root = process.argv[3];
  if (!root) process.exit(2);
  const event = readInput();
  const envelope = correlation(event);
  if (!envelope) {
    process.stdout.write(action === '--needs-capture' ? 'false\n' : `${JSON.stringify(event)}\n`);
    return;
  }
  const store = ensureStore(root);
  const file = baselineFile(root, envelope);
  if (action === '--needs-capture') {
    process.stdout.write(`${readBaseline(file, envelope) === null}\n`);
    return;
  }
  if (action === '--capture') {
    if (readBaseline(file, envelope)) return;
    const temporary = path.join(store, `.${path.basename(file)}.${process.pid}.tmp`);
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify({ run_correlation: envelope, usage: event.usage || {} })}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return;
  }
  if (action === '--delta') {
    const baseline = readBaseline(file, envelope);
    event.usage = baseline
      ? usageDelta(event.usage || {}, baseline.usage || {})
      : {
          ...(event.usage || {}),
          semantics: 'snapshot',
          scope: 'session',
          baseline_status: 'unavailable',
        };
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  process.exit(2);
}

try {
  main();
} catch {
  process.exit(1);
}
