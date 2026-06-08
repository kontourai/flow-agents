#!/usr/bin/env node
/**
 * Post-Edit Accumulator
 *
 * Records edited JS/TS file paths to a session-scoped temp file.
 * stop-format-typecheck.js reads this list at stop time for batch processing.
 *
 * Uses telemetry session ID when available, falls back to CWD hash.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_STDIN = 1024 * 1024;
const JS_TS_EXT = /\.(ts|tsx|js|jsx)$/;

function getSessionId() {
  // Try telemetry session file first
  const hooksDir = __dirname;
  const sessionDir = path.resolve(hooksDir, '..', 'telemetry', '..', '..', '.telemetry', 'sessions');
  try {
    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.session'));
    if (files.length > 0) {
      // Most recent by mtime
      const sorted = files
        .map(f => ({ name: f, mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const data = JSON.parse(fs.readFileSync(path.join(sessionDir, sorted[0].name), 'utf8'));
      if (data.session_id) return data.session_id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    }
  } catch { /* fall through */ }
  return crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12);
}

function getAccumFile() {
  return path.join(os.tmpdir(), `flow-agents-edited-${getSessionId()}.txt`);
}

function run(rawInput) {
  try {
    const input = JSON.parse(rawInput);
    const filePath = input.tool_input?.path || input.tool_input?.file_path || '';
    if (filePath && JS_TS_EXT.test(filePath)) {
      fs.appendFileSync(getAccumFile(), filePath + '\n', 'utf8');
    }
  } catch { /* pass through */ }
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

module.exports = { run, getAccumFile };
