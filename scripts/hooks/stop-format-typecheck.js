#!/usr/bin/env node
/**
 * Stop Hook: Batch format + typecheck all JS/TS files edited this response
 *
 * Reads the accumulator from post-edit-accumulator.js, groups files by
 * project root for formatter and by tsconfig dir for typecheck.
 * Budget is distributed evenly across batches.
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findProjectRoot, detectFormatter, resolveFormatterBin } = require('./lib/resolve-formatter');

const MAX_STDIN = 1024 * 1024;
const TOTAL_BUDGET_MS = 270_000;

function getAccumFile() {
  // Import from accumulator to share session ID logic
  try {
    return require('./post-edit-accumulator').getAccumFile();
  } catch {
    const crypto = require('crypto');
    const os = require('os');
    const id = crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12);
    return path.join(os.tmpdir(), `flow-agents-edited-${id}.txt`);
  }
}

function parseAccumulator(raw) {
  return [...new Set(raw.split('\n').map(l => l.trim()).filter(Boolean))];
}

function formatBatch(projectRoot, files, timeoutMs) {
  const formatter = detectFormatter(projectRoot);
  if (!formatter) return;
  const resolved = resolveFormatterBin(projectRoot, formatter);
  if (!resolved) return;
  const existing = files.filter(f => fs.existsSync(f));
  if (existing.length === 0) return;
  const args = formatter === 'biome'
    ? [...resolved.prefix, 'check', '--write', ...existing]
    : [...resolved.prefix, '--write', ...existing];
  try {
    execFileSync(resolved.bin, args, { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
  } catch { /* non-blocking */ }
}

function findTsConfigDir(filePath) {
  let dir = path.dirname(filePath);
  const root = path.parse(dir).root;
  let depth = 0;
  while (dir !== root && depth < 20) {
    if (fs.existsSync(path.join(dir, 'tsconfig.json'))) return dir;
    dir = path.dirname(dir);
    depth++;
  }
  return null;
}

function typecheckBatch(tsConfigDir, editedFiles, timeoutMs) {
  const args = ['tsc', '--noEmit', '--pretty', 'false'];
  const opts = { cwd: tsConfigDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs };
  let stdout = '', stderr = '', failed = false;
  try {
    execFileSync('npx', args, opts);
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    failed = true;
  }
  if (!failed) return;
  const lines = (stdout + stderr).split('\n');
  for (const filePath of editedFiles) {
    const relPath = path.relative(tsConfigDir, filePath);
    const relevant = lines
      .filter(line => line.includes(filePath) || line.includes(relPath))
      .slice(0, 10);
    if (relevant.length > 0) {
      process.stderr.write(`[Hook] TypeScript errors in ${path.basename(filePath)}:\n`);
      relevant.forEach(l => process.stderr.write(l + '\n'));
    }
  }
}

function main() {
  const accumFile = getAccumFile();
  let raw;
  try { raw = fs.readFileSync(accumFile, 'utf8'); } catch { return; }
  try { fs.unlinkSync(accumFile); } catch { /* best-effort */ }

  const files = parseAccumulator(raw);
  if (files.length === 0) return;

  const byRoot = new Map();
  const byTsConfig = new Map();
  for (const f of files) {
    if (!/\.(ts|tsx|js|jsx)$/.test(f)) continue;
    const resolved = path.resolve(f);
    if (!fs.existsSync(resolved)) continue;
    const root = findProjectRoot(path.dirname(resolved));
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(resolved);
    if (/\.(ts|tsx)$/.test(f)) {
      const tsDir = findTsConfigDir(resolved);
      if (tsDir) {
        if (!byTsConfig.has(tsDir)) byTsConfig.set(tsDir, []);
        byTsConfig.get(tsDir).push(resolved);
      }
    }
  }

  const totalBatches = byRoot.size + byTsConfig.size;
  const perBatch = totalBatches > 0 ? Math.floor(TOTAL_BUDGET_MS / totalBatches) : 60_000;

  for (const [root, batch] of byRoot) formatBatch(root, batch, perBatch);
  for (const [tsDir, batch] of byTsConfig) typecheckBatch(tsDir, batch, perBatch);
}

function run(rawInput) {
  try { main(); } catch (e) {
    process.stderr.write(`[Hook] stop-format-typecheck error: ${e.message}\n`);
  }
  return rawInput;
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) data += chunk.substring(0, MAX_STDIN - data.length);
  });
  process.stdin.on('end', () => {
    process.stdout.write(run(data));
    process.exit(0);
  });
}

module.exports = { run, parseAccumulator };
