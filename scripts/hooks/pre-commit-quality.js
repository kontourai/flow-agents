#!/usr/bin/env node
/**
 * Pre-Commit Quality Gate
 *
 * Intercepts git commit commands and runs quality checks:
 * - Staged file content scanning (secrets, debugger, console.log, TODO)
 * - Commit message validation (conventional commits)
 * - Linter execution (ESLint, Pylint, golint)
 *
 * Exit codes: 0 = allow (warnings only), 2 = block (errors found)
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const MAX_STDIN = 1024 * 1024;
const CHECKABLE_EXT = ['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs'];

const SECRET_PATTERNS = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/, name: 'OpenAI API key' },
  { pattern: /ghp_[a-zA-Z0-9]{36}/, name: 'GitHub PAT' },
  { pattern: /AKIA[A-Z0-9]{16}/, name: 'AWS Access Key' },
  { pattern: /api[_-]?key\s*[=:]\s*['"][^'"]+['"]/i, name: 'API key' },
];

function getStagedFiles() {
  const r = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
}

function getStagedContent(filePath) {
  const r = spawnSync('git', ['show', `:${filePath}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return r.status === 0 ? r.stdout : null;
}

function findFileIssues(filePath) {
  const issues = [];
  const content = getStagedContent(filePath);
  if (!content) return issues;

  content.split('\n').forEach((line, i) => {
    const lineNum = i + 1;
    if (line.includes('console.log') && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
      issues.push({ severity: 'warning', message: `console.log at line ${lineNum}` });
    }
    if (/\bdebugger\b/.test(line) && !line.trim().startsWith('//')) {
      issues.push({ severity: 'error', message: `debugger statement at line ${lineNum}` });
    }
    const todo = line.match(/\/\/\s*(TODO|FIXME):?\s*(.+)/);
    if (todo && !todo[2].match(/#\d+|issue/i)) {
      issues.push({ severity: 'info', message: `${todo[1]} without issue ref at line ${lineNum}` });
    }
    for (const { pattern, name } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        issues.push({ severity: 'error', message: `Potential ${name} at line ${lineNum}` });
      }
    }
  });
  return issues;
}

function validateCommitMessage(command) {
  const m = command.match(/(?:-m|--message)[=\s]+["']?([^"']+)["']?/);
  if (!m) return null;
  const msg = m[1];
  const issues = [];
  const conventional = /^(feat|fix|docs|style|refactor|test|chore|build|ci|perf|revert)(\(.+\))?!?:\s*.+/;
  if (!conventional.test(msg)) {
    issues.push({ message: 'Not conventional commit format', suggestion: 'type(scope): description' });
  }
  if (msg.length > 72) issues.push({ message: `Too long (${msg.length}/72 chars)` });
  if (conventional.test(msg)) {
    const after = msg.split(':')[1];
    if (after && /^\s*[A-Z]/.test(after)) issues.push({ message: 'Lowercase after colon' });
  }
  if (msg.endsWith('.')) issues.push({ message: 'No trailing period' });
  return { message: msg, issues };
}

function runLinter(files) {
  const results = {};
  const jsFiles = files.filter(f => /\.(js|jsx|ts|tsx)$/.test(f));
  if (jsFiles.length > 0) {
    const eslintPath = path.join(process.cwd(), 'node_modules', '.bin', 'eslint');
    if (fs.existsSync(eslintPath)) {
      const r = spawnSync(eslintPath, ['--format', 'compact', ...jsFiles], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
      results.eslint = { success: r.status === 0, output: r.stdout || r.stderr };
    }
  }
  const pyFiles = files.filter(f => f.endsWith('.py'));
  if (pyFiles.length > 0) {
    try {
      const r = spawnSync('pylint', ['--output-format=text', ...pyFiles], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
      if (!r.error || r.error.code !== 'ENOENT') results.pylint = { success: r.status === 0, output: r.stdout || r.stderr };
    } catch { /* not available */ }
  }
  const goFiles = files.filter(f => f.endsWith('.go'));
  if (goFiles.length > 0) {
    try {
      const r = spawnSync('golint', goFiles, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
      if (!r.error || r.error.code !== 'ENOENT') results.golint = { success: !r.stdout || !r.stdout.trim(), output: r.stdout };
    } catch { /* not available */ }
  }
  return results;
}

function evaluate(rawInput) {
  try {
    const input = JSON.parse(rawInput);
    const command = input.tool_input?.command || '';
    if (!command.includes('git commit') || command.includes('--amend')) {
      return { output: rawInput, exitCode: 0 };
    }

    const staged = getStagedFiles();
    if (staged.length === 0) {
      process.stderr.write('[Hook] No staged files found.\n');
      return { output: rawInput, exitCode: 0 };
    }

    process.stderr.write(`[Hook] Checking ${staged.length} staged file(s)...\n`);
    const checkable = staged.filter(f => CHECKABLE_EXT.some(ext => f.endsWith(ext)));
    let errors = 0, warnings = 0, infos = 0;

    for (const file of checkable) {
      const issues = findFileIssues(file);
      if (issues.length > 0) {
        process.stderr.write(`\n[FILE] ${file}\n`);
        for (const issue of issues) {
          const label = issue.severity === 'error' ? 'ERROR' : issue.severity === 'warning' ? 'WARNING' : 'INFO';
          process.stderr.write(`  ${label} ${issue.message}\n`);
          if (issue.severity === 'error') errors++;
          else if (issue.severity === 'warning') warnings++;
          else infos++;
        }
      }
    }

    const msgResult = validateCommitMessage(command);
    if (msgResult && msgResult.issues.length > 0) {
      process.stderr.write('\nCommit Message Issues:\n');
      for (const issue of msgResult.issues) {
        process.stderr.write(`  WARNING ${issue.message}\n`);
        if (issue.suggestion) process.stderr.write(`     TIP ${issue.suggestion}\n`);
        warnings++;
      }
    }

    const lintResults = runLinter(checkable);
    for (const [name, result] of Object.entries(lintResults)) {
      if (result && !result.success) {
        process.stderr.write(`\n${name} Issues:\n${result.output}\n`);
        errors++;
      }
    }

    const total = errors + warnings + infos;
    if (total > 0) {
      process.stderr.write(`\nSummary: ${total} issue(s) (${errors} error, ${warnings} warning, ${infos} info)\n`);
      if (errors > 0) {
        process.stderr.write('[Hook] ERROR: Commit blocked. Fix critical issues first.\n');
        return { output: rawInput, exitCode: 2 };
      }
      process.stderr.write('[Hook] WARNING: Warnings found but commit allowed.\n');
    } else {
      process.stderr.write('[Hook] PASS: All checks passed!\n');
    }
  } catch (e) {
    process.stderr.write(`[Hook] Error: ${e.message}\n`);
  }
  return { output: rawInput, exitCode: 0 };
}

function run(rawInput) {
  return evaluate(rawInput).output;
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) data += chunk.substring(0, MAX_STDIN - data.length);
  });
  process.stdin.on('end', () => {
    const result = evaluate(data);
    process.stdout.write(result.output);
    process.exit(result.exitCode);
  });
}

module.exports = { run, evaluate };
