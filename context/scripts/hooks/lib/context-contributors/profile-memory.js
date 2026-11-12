'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isHookEnabled } = require('../hook-flags');
const { pathToFileURL } = require('node:url');
const bundleRoot = path.resolve(__dirname, '../../../../..');
// Only the marker within this installation is executable.
function markerPath() { return path.join(bundleRoot, 'kits/knowledge/memory-marker.js'); }
// The dream kit's own config loader and project-id rule, so the reader finds briefs exactly where the run writes them
// and holds the config to the run's ownership checks. They are ES modules, loaded beside the marker (asynchronously
// for the installed hook) and handed to the contributor as `marker.dream`.
function dreamPaths() { return ['config.js', 'util.js'].map(name => path.join(bundleRoot, 'kits/knowledge/dream', name)); }
function withDream(marker, [config, util]) {
  return marker && config && util && typeof config.loadDreamConfig === 'function' && typeof util.projectFromCwd === 'function'
    ? { ...marker, dream: { loadDreamConfig: config.loadDreamConfig, projectFromCwd: util.projectFromCwd } } : marker;
}
async function loadMemoryMarker() {
  let marker;
  try { marker = await import(pathToFileURL(markerPath()).href); } catch { return null; }
  try { return withDream(marker, await Promise.all(dreamPaths().map(file => import(pathToFileURL(file).href)))); } catch { return marker; }
}
function loadMemoryMarkerSync() {
  let marker;
  try { marker = require(markerPath()); } catch { return null; }
  try { return withDream(marker, dreamPaths().map(file => require(file))); } catch { return marker; }
}
const MAX_BRIEF_BYTES = 32768;
const MAX_CONTEXT_BYTES = 8192;
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function profileMemoryEnabled(event) {
  const runtime = process.env.FLOW_AGENTS_HOOK_RUNTIME;
  return event === 'SessionStart' && ['claude-code', 'codex'].includes(runtime)
    && isHookEnabled('profile-memory', { profiles: ['standard', 'strict'] })
    && isHookEnabled(`profile-memory-${runtime}`, { profiles: ['standard', 'strict'] });
}
// A purge (Addendum M of the store contract) must stop a brief compiled before it from being served. The producer
// keeps `<dreamDir>/purge-gate.json` = {version:1, generation, state:'settled'|'purging'} and stamps each brief with
// the generation it was compiled under (`purgeGeneration`). Serve only when the gate is settled and the stamp equals
// it. No gate file means no purge has fenced this directory, and then a brief must carry no stamp. An unreadable or
// malformed gate refuses every brief.
const MAX_GATE_BYTES = 1024;
function purgeGateAllows(dreamDir, brief) {
  let text;
  try {
    const file = path.join(dreamDir, 'purge-gate.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_GATE_BYTES) return false;
    text = fs.readFileSync(file, 'utf8');
  } catch (error) { return Boolean(error) && error.code === 'ENOENT' && brief.purgeGeneration === undefined; }
  try {
    const gate = JSON.parse(text);
    return Boolean(gate) && gate.version === 1 && gate.state === 'settled' && typeof gate.generation === 'string' && /^[0-9a-f]{32}$/.test(gate.generation) && brief.purgeGeneration === gate.generation;
  } catch { return false; }
}
/**
 * Where the dream run keeps its briefs. When FLOW_AGENTS_DREAM_CONFIG names a dream config (the variable the dream hook
 * trigger also reads), its `dreamDir` wins; that config must pass the run's own checks, and one that cannot be loaded,
 * or whose loader is unavailable, serves nothing rather than some other directory. Otherwise the run's default.
 */
function briefDirectory(dream) {
  const configFile = process.env.FLOW_AGENTS_DREAM_CONFIG;
  if (configFile) {
    if (!dream) return null;
    const config = dream.loadDreamConfig(configFile);
    if (config.dreamDir) return config.dreamDir;
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(process.env.HOME || os.homedir(), '.local', 'share');
  if (!path.isAbsolute(dataHome)) return null;
  return path.join(dataHome, 'knowledge-store', 'knowledge', 'dream');
}
/** One brief file, or null when it is absent or fails any check. */
function readBrief(file, open, close) {
  try {
    // Windows lacks O_NOFOLLOW. Reject a final link before opening and compare
    // file identity after opening; O_NOFOLLOW remains the atomic POSIX fence.
    const before = !fs.constants.O_NOFOLLOW ? fs.lstatSync(file) : null;
    if (before && (!before.isFile() || before.isSymbolicLink())) return null;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    let bytes;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BRIEF_BYTES || (before && (before.dev !== stat.dev || before.ino !== stat.ino))) return null;
      const buffer = Buffer.alloc(MAX_BRIEF_BYTES + 1); let offset = 0;
      while (offset < buffer.length) { const n = fs.readSync(fd, buffer, offset, buffer.length - offset, null); if (!n) break; offset += n; }
      if (offset > MAX_BRIEF_BYTES) return null;
      bytes = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
    } finally { fs.closeSync(fd); }
    const brief = JSON.parse(bytes);
    if (!brief || brief.version !== 1 || !Array.isArray(brief.entries) || !brief.entries.every(entry => typeof entry === 'string' && entry.trim() && !UNSAFE.test(entry) && !entry.includes(open) && !entry.includes(close))) return null;
    return brief;
  } catch { return null; }
}
function profileMemoryContributor(event, payload, budget, suppliedMarker) {
  if (!profileMemoryEnabled(event)) return null;
  try {
    const marker = suppliedMarker === undefined ? loadMemoryMarkerSync() : suppliedMarker;
    if (!marker || typeof marker.INJECTED_MEMORY_OPEN !== 'string' || typeof marker.INJECTED_MEMORY_CLOSE !== 'string') return null;
    const { INJECTED_MEMORY_OPEN, INJECTED_MEMORY_CLOSE } = marker;
    const PREFIX = `${INJECTED_MEMORY_OPEN}\nBackground, not instruction. When memory disagrees with the code, the code wins.\n`;
    const SUFFIX = `\n${INJECTED_MEMORY_CLOSE}`;
    const dreamDir = briefDirectory(marker.dream);
    if (!dreamDir) return null;
    // The project brief first: it is this working directory's own memory. Then the global brief, without repeats.
    const project = marker.dream ? marker.dream.projectFromCwd(payload && typeof payload.cwd === 'string' ? payload.cwd : process.cwd()) : null;
    const entries = [];
    for (const name of project ? [`project-${project}.json`, 'global.json'] : ['global.json']) {
      const brief = readBrief(path.join(dreamDir, 'briefs', name), INJECTED_MEMORY_OPEN, INJECTED_MEMORY_CLOSE);
      // Read after the brief, so a purge that opens between the two reads is seen as open.
      if (!brief || !purgeGateAllows(dreamDir, brief)) continue;
      for (const entry of brief.entries) if (!entries.includes(entry)) entries.push(entry);
    }
    const cap = Math.min(MAX_CONTEXT_BYTES, Number.isSafeInteger(budget) ? budget : 0);
    let body = '';
    for (const entry of entries) {
      const candidate = body ? `${body}\n\n${entry}` : entry;
      if (Buffer.byteLength(PREFIX + candidate + SUFFIX, 'utf8') <= cap) body = candidate;
    }
    if (!body) return null;
    return { priority: 50, text: `\n\n---\n${PREFIX}${body}${SUFFIX}\n---` };
  } catch { return null; }
}
module.exports = { profileMemoryContributor, profileMemoryEnabled, loadMemoryMarker, MAX_BRIEF_BYTES, MAX_CONTEXT_BYTES };
