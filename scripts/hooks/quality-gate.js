#!/usr/bin/env node
/**
 * Quality Gate Hook (strict profile only)
 *
 * Runs per-file quality checks immediately after edits.
 * Skips JS/TS when Biome is configured (handled by stop batch).
 *
 * Non-blocking — always exits 0, logs warnings to stderr.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { findProjectRoot, detectFormatter, resolveFormatterBin } = require('./lib/resolve-formatter');

const MAX_STDIN = 1024 * 1024;

function exec(cmd, args, cwd = process.cwd()) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', env: process.env, timeout: 15000 });
}

function log(msg) { process.stderr.write(`${msg}\n`); }

function checkFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  filePath = path.resolve(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const fix = String(process.env.SA_QUALITY_GATE_FIX || '').toLowerCase() === 'true';
  const strict = String(process.env.SA_QUALITY_GATE_STRICT || '').toLowerCase() === 'true';

  if (['.ts', '.tsx', '.js', '.jsx', '.json', '.md'].includes(ext)) {
    const root = findProjectRoot(path.dirname(filePath));
    const formatter = detectFormatter(root);
    if (formatter === 'biome') {
      if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return; // handled by stop batch
      const resolved = resolveFormatterBin(root, 'biome');
      if (!resolved) return;
      const args = [...resolved.prefix, 'check', filePath];
      if (fix) args.push('--write');
      const r = exec(resolved.bin, args, root);
      if (r.status !== 0 && strict) log(`[QualityGate] Biome check failed for ${filePath}`);
      return;
    }
    if (formatter === 'prettier') {
      const resolved = resolveFormatterBin(root, 'prettier');
      if (!resolved) return;
      const r = exec(resolved.bin, [...resolved.prefix, fix ? '--write' : '--check', filePath], root);
      if (r.status !== 0 && strict) log(`[QualityGate] Prettier check failed for ${filePath}`);
      return;
    }
    return;
  }

  if (ext === '.go') {
    if (fix) {
      const r = exec('gofmt', ['-w', filePath]);
      if (r.status !== 0 && strict) log(`[QualityGate] gofmt failed for ${filePath}`);
    } else if (strict) {
      const r = exec('gofmt', ['-l', filePath]);
      if (r.stdout && r.stdout.trim()) log(`[QualityGate] gofmt check failed for ${filePath}`);
    }
    return;
  }

  if (ext === '.py') {
    const args = ['format'];
    if (!fix) args.push('--check');
    args.push(filePath);
    const r = exec('ruff', args);
    if (r.status !== 0 && strict) log(`[QualityGate] Ruff check failed for ${filePath}`);
  }
}

function run(rawInput) {
  try {
    const input = JSON.parse(rawInput);
    checkFile(input.tool_input?.path || input.tool_input?.file_path || '');
  } catch { /* ignore */ }
  return rawInput;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
  });
  process.stdin.on('end', () => process.stdout.write(run(raw)));
}

module.exports = { run };
