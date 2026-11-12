/**
 * Operator configuration for the dream run (#671). Everything is off until the
 * file says `"enabled": true`; an unknown key is an error, never ignored.
 *
 * @module dream/config
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { assertAbsolute, dreamError } from "./util.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const KEYS = new Set([
  "enabled", "telemetryFile", "transcriptRoots", "dreamDir", "host", "role", "passes", "maxSittingsPerRun",
  "globalBudget", "projectBudget", "maxEntryBytes", "includeUnreviewed", "routingPolicy", "idleGapMs",
  "triggerMinIntervalMs", "proposerId", "visibility", "runtime",
]);
const RUNTIME_KEYS = new Set(["kind", "model", "executable"]);
const POSITIVE_INTEGERS = ["passes", "maxSittingsPerRun", "globalBudget", "projectBudget", "maxEntryBytes", "idleGapMs", "triggerMinIntervalMs"];

export const DEFAULT_ROLE = "extraction-default";
export const DEFAULT_TRIGGER_MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Read and validate a config file. The config decides whether the run is enabled and which code it loads, so it
 * is held to the same bar as that code: a real file, owned by the current user, in a directory chain that no other
 * user can write. Returns plain data; nothing is run.
 */
export function loadDreamConfig(file) {
  assertOwnerControlledFile(file, "config");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let text;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw dreamError("DREAM_CONFIG_INVALID", "config must be a regular file under 64 KiB");
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw dreamError("DREAM_CONFIG_INVALID", "config is not valid JSON");
  }
  return validateDreamConfig(config);
}

export function validateDreamConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw dreamError("DREAM_CONFIG_INVALID", "config must be an object");
  for (const key of Object.keys(config)) {
    if (!KEYS.has(key)) throw dreamError("DREAM_CONFIG_INVALID", `unknown config key: ${key}`);
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw dreamError("DREAM_CONFIG_INVALID", "enabled must be a boolean");
  assertAbsolute(config.telemetryFile, "telemetryFile");
  assertAbsolute(config.host, "host");
  if (!Array.isArray(config.transcriptRoots) || config.transcriptRoots.length === 0) throw dreamError("DREAM_CONFIG_INVALID", "transcriptRoots must list at least one root");
  config.transcriptRoots.forEach((root, i) => assertAbsolute(root, `transcriptRoots[${i}]`));
  if (config.dreamDir !== undefined) assertAbsolute(config.dreamDir, "dreamDir");
  for (const key of POSITIVE_INTEGERS) {
    if (config[key] !== undefined && !(Number.isSafeInteger(config[key]) && config[key] > 0)) throw dreamError("DREAM_CONFIG_INVALID", `${key} must be a positive integer`);
  }
  if (config.role !== undefined && (typeof config.role !== "string" || !config.role.trim())) throw dreamError("DREAM_CONFIG_INVALID", "role must be a Datum role name");
  if (config.runtime !== undefined) validateRuntime(config.runtime, config.role);
  return { ...config, enabled: config.enabled === true };
}

/**
 * `runtime` names a model runtime the run builds itself instead of resolving a Datum role. The only kind is
 * `claude-code`: the Claude Code CLI, reached through Relay and Dispatch (model.js).
 */
function validateRuntime(runtime, role) {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) throw dreamError("DREAM_CONFIG_INVALID", "runtime must be an object");
  for (const key of Object.keys(runtime)) {
    if (!RUNTIME_KEYS.has(key)) throw dreamError("DREAM_CONFIG_INVALID", `unknown runtime key: ${key}`);
  }
  if (runtime.kind !== "claude-code") throw dreamError("DREAM_CONFIG_INVALID", 'runtime.kind must be "claude-code"');
  if (typeof runtime.model !== "string" || !runtime.model.trim()) throw dreamError("DREAM_CONFIG_INVALID", "runtime.model must name a model the claude command accepts, such as sonnet");
  if (runtime.executable !== undefined) assertAbsolute(runtime.executable, "runtime.executable");
  // Two sources for one model would leave the reader of the config guessing which one ran.
  if (role !== undefined) throw dreamError("DREAM_CONFIG_INVALID", "set role or runtime, not both");
}

const trustedOwner = (stat, uid) => uid === null || stat.uid === uid || stat.uid === 0;

/**
 * Refuse a directory the run keeps private state in (`dreamDir`, its `briefs/`) unless only this user can change it:
 * no symlink anywhere on the path, the directory itself owned by the current user and not group or world writable
 * (sticky or not: anyone could create the files inside it), and every directory above it held to the same rule as
 * `assertOwnerControlledFile` (owned by this user or root; group or world writable only when sticky, as /tmp is). A
 * directory that does not exist yet is allowed when its existing ancestors pass, because the run creates it 0700.
 * The SessionStart reader applies the same rule (context-contributors/profile-memory.js).
 */
export function assertOwnerControlledDir(dir, label) {
  assertAbsolute(dir, label);
  const resolved = path.resolve(dir);
  // lstat, not existsSync: existsSync follows a link, so a dangling symlink would read as "not created yet".
  let existing = resolved;
  for (;;) {
    let stat = null;
    try {
      stat = fs.lstatSync(existing);
    } catch (error) {
      if (error?.code !== "ENOENT") throw dreamError("DREAM_CONFIG_INVALID", `${label} cannot be inspected (${error?.code ?? "error"}): ${existing}`);
    }
    if (stat?.isSymbolicLink()) throw dreamError("DREAM_CONFIG_INVALID", `${label} path must not contain a symlink: ${existing} is a symlink`);
    if (stat) break;
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let real;
  try {
    real = fs.realpathSync(existing);
  } catch {
    throw dreamError("DREAM_CONFIG_INVALID", `${label} cannot be resolved: ${resolved}`);
  }
  if (real !== existing) throw dreamError("DREAM_CONFIG_INVALID", `${label} path must not contain a symlink: ${existing} resolves to ${real}`);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (existing === resolved) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory()) throw dreamError("DREAM_CONFIG_INVALID", `${label} must be a directory: ${resolved}`);
    if (uid !== null && stat.uid !== uid) throw dreamError("DREAM_CONFIG_INVALID", `${label} must be owned by the current user: ${resolved}`);
    if ((stat.mode & 0o022) !== 0) throw dreamError("DREAM_CONFIG_INVALID", `${label} must not be group or world writable: ${resolved}`);
  }
  for (let current = existing === resolved ? path.dirname(resolved) : existing; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!trustedOwner(stat, uid)) throw dreamError("DREAM_CONFIG_INVALID", `${label} is under a directory owned by another user: ${current}`);
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) throw dreamError("DREAM_CONFIG_INVALID", `${label} is under a group or world writable directory: ${current}`);
    if (path.dirname(current) === current) break;
  }
  return resolved;
}

/**
 * Refuse a file, or a directory above it, that another user could have changed: any symlink on the path, an owner
 * other than the current user (or root), or a group- or world-writable mode (a sticky directory is exempt, as for
 * /tmp). Imported code and the config that enables the run must both pass.
 *
 * Residual: the check and the later read are two steps, so a process running as the same user can still swap the
 * file between them. That attacker already owns the account the run uses.
 */
export function assertOwnerControlledFile(file, label) {
  assertAbsolute(file, label);
  const resolved = path.resolve(file);
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw dreamError("DREAM_CONFIG_INVALID", `${label} cannot be read: no such file`);
  }
  // Name the real path: on macOS /tmp and /var are themselves symlinks, so the refusal must say what to pass instead.
  if (real !== resolved) throw dreamError("DREAM_CONFIG_INVALID", `${label} path must not contain a symlink: ${resolved} resolves to ${real}; pass that path instead`);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile()) throw dreamError("DREAM_CONFIG_INVALID", `${label} must be a regular file`);
  if (uid !== null && stat.uid !== uid) throw dreamError("DREAM_CONFIG_INVALID", `${label} must be owned by the current user`);
  if ((stat.mode & 0o022) !== 0) throw dreamError("DREAM_CONFIG_INVALID", `${label} must not be group or world writable`);
  for (let dir = path.dirname(resolved); ; dir = path.dirname(dir)) {
    const dirStat = fs.lstatSync(dir);
    if (!trustedOwner(dirStat, uid)) throw dreamError("DREAM_CONFIG_INVALID", `${label} is under a directory owned by another user: ${dir}`);
    if ((dirStat.mode & 0o022) !== 0 && (dirStat.mode & 0o1000) === 0) throw dreamError("DREAM_CONFIG_INVALID", `${label} is under a group or world writable directory: ${dir}`);
    if (path.dirname(dir) === dir) break;
  }
  return resolved;
}
