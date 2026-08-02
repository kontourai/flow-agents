/* Committed-only goal-fit configuration for hook runtimes. Keep mirrored verbatim. */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE_PATH = '.flow-agents/config/core.config.json';
const MAX_BYTES = 64 * 1024;
const DEFAULT = Object.freeze({ mode: 'warn', max_blocks: 3, recheck: false, backstop: 'block', backstop_timeout_ms: 120000, require_sidecars: false, require_critique: false });
const STRICT = Object.freeze({ mode: 'block', max_blocks: Number.MAX_SAFE_INTEGER, recheck: false, backstop: 'block', backstop_timeout_ms: 1, require_sidecars: true, require_critique: true });

function trustedEnvironment() {
  return { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', LANG: 'C', LC_ALL: 'C', PATH: process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32' : '/usr/bin:/bin' };
}

function git(root, args) {
  const executable = process.platform === 'win32' ? 'git' : '/usr/bin/git';
  return execFileSync(executable, ['--no-replace-objects', '-C', root, ...args], { encoding: 'buffer', env: trustedEnvironment(), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_BYTES + 1 });
}

// Do not ask ambient Git whether this is a repository: hostile environment and
// config are precisely what this helper must ignore. A bounded lstat walk marks
// a root as repository-shaped when it or an ancestor has a .git directory,
// file, or symlink. Any unreadable marker path is fail-closed as well.
function hasGitMarkerOrAncestor(root) {
  let cursor = path.resolve(root);
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      fs.lstatSync(path.join(cursor, '.git'));
      return true;
    } catch (error) {
      if (error && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return true;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  return true;
}

function valid(value) {
  const goal = value && typeof value === 'object' && !Array.isArray(value) ? value.goal_fit : null;
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2
    && value.schema_version === '1.0' && goal && typeof goal === 'object' && !Array.isArray(goal)
    && Object.keys(goal).sort().join(',') === 'backstop,backstop_timeout_ms,max_blocks,mode,recheck,require_critique,require_sidecars'
    && ['off', 'warn', 'block'].includes(goal.mode) && Number.isInteger(goal.max_blocks) && goal.max_blocks >= 1
    && typeof goal.recheck === 'boolean' && ['skip', 'off', 'block'].includes(goal.backstop)
    && Number.isInteger(goal.backstop_timeout_ms) && goal.backstop_timeout_ms >= 1
    && typeof goal.require_sidecars === 'boolean' && typeof goal.require_critique === 'boolean';
}

function committedCore(root) {
  let commit;
  try {
    commit = String(git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('HEAD is not an immutable commit');
  } catch (error) {
    if (!hasGitMarkerOrAncestor(root)) return { state: 'default', value: DEFAULT, provenance: {} };
    return { state: 'invalid', value: STRICT, provenance: {}, diagnostic: error.message || 'could not resolve immutable HEAD with trusted Git' };
  }
  try {
    // Defaults are allowed only after trusted Git successfully proves this path
    // absent from a valid immutable commit. A failed ls-tree/cat-file is policy
    // corruption, not an invitation to fall back to warn-mode defaults.
    const listed = String(git(root, ['ls-tree', '--name-only', commit, '--', CORE_PATH])).trim();
    if (!listed) return { state: 'default', value: DEFAULT, provenance: { commit, path: CORE_PATH } };
    if (listed !== CORE_PATH) throw new Error('unexpected committed core config path');
    const bytes = git(root, ['cat-file', 'blob', `${commit}:${CORE_PATH}`]);
    if (bytes.length > MAX_BYTES) throw new Error('committed core config exceeds size limit');
    const value = JSON.parse(bytes.toString('utf8'));
    if (!valid(value)) throw new Error('committed core config violates strict schema');
    return { state: 'committed', value: value.goal_fit, provenance: { commit, path: CORE_PATH, digest: crypto.createHash('sha256').update(bytes).digest('hex') } };
  } catch (error) {
    return { state: 'invalid', value: STRICT, provenance: { commit, path: CORE_PATH }, diagnostic: error.message || 'invalid committed core config' };
  }
}

function bool(value) { return /^true$/i.test(String(value)) ? true : /^false$/i.test(String(value)) ? false : undefined; }
function production(env) { return ['production', 'prod'].includes(String(env.NODE_ENV || '').toLowerCase()); }

function applyEnvironment(base, env) {
  const proposed = {
    mode: ['off', 'warn', 'block'].includes(String(env.FLOW_AGENTS_GOAL_FIT_MODE || '').toLowerCase()) ? String(env.FLOW_AGENTS_GOAL_FIT_MODE).toLowerCase() : (bool(env.FLOW_AGENTS_GOAL_FIT_STRICT) ? 'block' : base.mode),
    max_blocks: Number.parseInt(env.FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS || '', 10) || base.max_blocks,
    recheck: bool(env.FLOW_AGENTS_GOAL_FIT_RECHECK) ?? base.recheck,
    backstop: ({ skip: 'skip', off: 'off', warn: 'off', block: 'block' })[String(env.FLOW_AGENTS_GOAL_FIT_BACKSTOP || '').toLowerCase()] || base.backstop,
    backstop_timeout_ms: Number.parseInt(env.FLOW_AGENTS_GOAL_FIT_BACKSTOP_TIMEOUT_MS || '', 10) || base.backstop_timeout_ms,
    require_sidecars: bool(env.FLOW_AGENTS_REQUIRE_SIDECARS) ?? base.require_sidecars,
    require_critique: bool(env.FLOW_AGENTS_REQUIRE_CRITIQUE) ?? base.require_critique,
  };
  if (!production(env)) return { value: proposed, rejected: [] };
  const rejected = [];
  const modeRank = { off: 0, warn: 1, block: 2 };
  const backstopRank = { skip: 0, off: 1, block: 2 };
  const take = (name, candidate, current, allowed) => allowed ? candidate : (rejected.push(name), current);
  return { value: {
    mode: take('FLOW_AGENTS_GOAL_FIT_MODE', proposed.mode, base.mode, modeRank[proposed.mode] >= modeRank[base.mode]),
    max_blocks: take('FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS', proposed.max_blocks, base.max_blocks, proposed.max_blocks >= base.max_blocks),
    // Recheck runs model-supplied shell text. It is a dangerous execution
    // opt-in, not a policy tightening: production may not turn it on.
    recheck: take('FLOW_AGENTS_GOAL_FIT_RECHECK', proposed.recheck, base.recheck, base.recheck || !proposed.recheck),
    backstop: take('FLOW_AGENTS_GOAL_FIT_BACKSTOP', proposed.backstop, base.backstop, backstopRank[proposed.backstop] >= backstopRank[base.backstop]),
    backstop_timeout_ms: take('FLOW_AGENTS_GOAL_FIT_BACKSTOP_TIMEOUT_MS', proposed.backstop_timeout_ms, base.backstop_timeout_ms, proposed.backstop_timeout_ms <= base.backstop_timeout_ms),
    require_sidecars: take('FLOW_AGENTS_REQUIRE_SIDECARS', proposed.require_sidecars, base.require_sidecars, proposed.require_sidecars || !base.require_sidecars),
    require_critique: take('FLOW_AGENTS_REQUIRE_CRITIQUE', proposed.require_critique, base.require_critique, proposed.require_critique || !base.require_critique),
  }, rejected };
}

function resolveGoalFitConfig(root, env = process.env) {
  const core = committedCore(path.resolve(root));
  if (core.state === 'invalid') {
    return { goal_fit: STRICT, state: core.state, provenance: core.provenance || {}, diagnostic: core.diagnostic || 'invalid committed core config', rejected_environment_overrides: [] };
  }
  const environment = applyEnvironment(core.value, env);
  return { goal_fit: environment.value, state: core.state, provenance: core.provenance || {}, diagnostic: core.diagnostic || null, rejected_environment_overrides: environment.rejected };
}

module.exports = { resolveGoalFitConfig };
