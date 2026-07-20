/**
 * Global personal-store bootstrap and MCP-compatible roots registry.
 *
 * The global store is deliberately a single, explicit root:
 * `$XDG_DATA_HOME/knowledge-store/knowledge` (or HOME's XDG fallback).  This
 * module does not select layered stores and never treats a failed registry
 * write as optional.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { emptyAliasIndex, emptyGraph } from "./codec.js";

export const PERSONAL_ROOT_NAME = "personal";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exists(file, io = fs) {
  try {
    io.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function lstatOrNull(file, io = fs) {
  try {
    return io.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isContained(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertAbsoluteDirectory(dir, label) {
  if (typeof dir !== "string" || !dir.trim() || !path.isAbsolute(dir)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(dir);
}

function assertNoSymlinkAtOrBelow(base, target, io = fs) {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  if (!isContained(resolvedTarget, resolvedBase)) {
    throw new Error(`containment refusal: ${resolvedTarget} is outside ${resolvedBase}`);
  }
  let current = path.parse(resolvedBase).root;
  for (const segment of path.relative(current, resolvedBase).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    const stat = lstatOrNull(current, io);
    if (stat?.isSymbolicLink()) throw new Error(`symlink ancestry refusal: ${current}`);
  }

  for (const segment of path.relative(resolvedBase, resolvedTarget).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    const stat = lstatOrNull(current, io);
    if (stat?.isSymbolicLink()) throw new Error(`symlink refusal: ${current}`);
  }
}

function ensurePrivateDirectory(directory, io = fs) {
  const existing = lstatOrNull(directory, io);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new Error(`private directory must be a real directory: ${directory}`);
  }
  io.mkdirSync(directory, { recursive: true, mode: 0o700 });
  io.chmodSync(directory, 0o700);
}

function dataHome(env = process.env) {
  const xdg = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim()
    ? env.XDG_DATA_HOME.trim()
    : path.join(env.HOME || os.homedir(), ".local", "share");
  return assertAbsoluteDirectory(xdg, "XDG_DATA_HOME");
}

function registryError(message, cause) {
  const error = new Error(`roots registry ${message}`);
  if (cause) error.cause = cause;
  return error;
}

function normalizeRegistry(value) {
  if (!isPlainObject(value) || !isPlainObject(value.roots)) {
    throw registryError("must be an object with a roots object");
  }
  const roots = {};
  for (const name of Object.keys(value.roots).sort()) {
    const root = value.roots[name];
    if (typeof name !== "string" || !name.trim() || typeof root !== "string" || !root.trim() || !path.isAbsolute(root)) {
      throw registryError("contains a non-absolute named root");
    }
    roots[name] = path.resolve(root);
  }
  if (value.default_write !== undefined && (typeof value.default_write !== "string" || !Object.hasOwn(roots, value.default_write))) {
    throw registryError("has a default_write that does not name a registered root");
  }
  return value.default_write === undefined ? { roots } : { roots, default_write: value.default_write };
}

function assertRegistryFileSafe(file, io = fs) {
  const stat = lstatOrNull(file, io);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) throw registryError("file must be a regular file, not a symlink");
}

function readRequiredRegistryFile(file, io = fs) {
  assertRegistryFileSafe(file, io);
  try {
    return normalizeRegistry(JSON.parse(io.readFileSync(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    if (error?.message?.startsWith("roots registry")) throw error;
    throw registryError("is malformed JSON", error);
  }
}

function readRegistryFile(file, io = fs) {
  try {
    return readRequiredRegistryFile(file, io);
  } catch (error) {
    if (error?.code === "ENOENT") return { roots: {} };
    throw error;
  }
}

function capturedRegistryFiles(file, io = fs) {
  const directory = path.dirname(file);
  if (!lstatOrNull(directory, io)?.isDirectory()) return [];
  const prefix = `.${path.basename(file)}.`;
  return io.readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".captured"))
    .map((name) => path.join(directory, name))
    .filter((candidate) => {
      const stat = lstatOrNull(candidate, io);
      return stat?.isFile() && !stat.isSymbolicLink();
    })
    .sort((left, right) => io.statSync(right).mtimeMs - io.statSync(left).mtimeMs);
}

function lockOwnerIsActive(file, io = fs) {
  const owner = path.join(path.dirname(file), ".roots.json.lock", "owner.json");
  try {
    const pid = JSON.parse(io.readFileSync(owner, "utf8"))?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readRecoverableRegistry(file, io = fs) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (exists(file, io)) {
      try {
        return readRequiredRegistryFile(file, io);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        continue;
      }
    }
    const [captured] = capturedRegistryFiles(file, io);
    if (!captured) {
      if (!exists(file, io)) return { roots: {} };
      try {
        return readRequiredRegistryFile(file, io);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        continue;
      }
    }
    let registry;
    try {
      registry = readRequiredRegistryFile(captured, io);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error?.message?.startsWith("roots registry")) throw error;
      throw registryError("captured file is malformed JSON", error);
    }
    if (lockOwnerIsActive(file, io)) return registry;
    try {
      io.linkSync(captured, file);
      io.chmodSync(file, 0o600);
      io.unlinkSync(captured);
      return registry;
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
    }
  }
  throw registryError("capture changed repeatedly while being read; retry later");
}

/** A store root is a non-symlink directory containing a valid graph index. */
export function isStoreRoot(root, { fs: io = fs } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) return false;
  const rootStat = lstatOrNull(root, io);
  const graphPath = path.join(root, "graph-index.json");
  const graphStat = lstatOrNull(graphPath, io);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || !graphStat?.isFile() || graphStat.isSymbolicLink()) return false;
  try {
    const graph = JSON.parse(io.readFileSync(graphPath, "utf8"));
    return isPlainObject(graph) && isPlainObject(graph.forward) && isPlainObject(graph.reverse);
  } catch {
    return false;
  }
}

/** Compute the global repository and store locations without creating either. */
export function globalStoreLocation(env = process.env) {
  const xdg = dataHome(env);
  const repoRoot = path.join(xdg, "knowledge-store");
  return { repoRoot, storeRoot: path.join(repoRoot, "knowledge") };
}

function assertGlobalLocationSafe(env = process.env, io = fs) {
  const { repoRoot, storeRoot } = globalStoreLocation(env);
  const xdg = dataHome(env);
  assertNoSymlinkAtOrBelow(xdg, repoRoot, io);
  assertNoSymlinkAtOrBelow(xdg, storeRoot, io);
  return { repoRoot, storeRoot };
}

function assertExistingStoreSafe(storeRoot, io = fs) {
  const stat = lstatOrNull(storeRoot, io);
  if (!stat) return;
  const alias = lstatOrNull(path.join(storeRoot, "alias-index.json"), io);
  const records = lstatOrNull(path.join(storeRoot, "records"), io);
  if (!isStoreRoot(storeRoot, { fs: io }) || !alias?.isFile() || alias.isSymbolicLink()
      || !records?.isDirectory() || records.isSymbolicLink()) {
    throw new Error(`refusing incomplete or unsafe store scaffold at ${storeRoot}`);
  }
}

/** Validate the personal-store destination without creating or repairing it. */
export function validateGlobalStoreLocation(env = process.env, { fs: io = fs } = {}) {
  const { repoRoot, storeRoot } = assertGlobalLocationSafe(env, io);
  const repoStat = lstatOrNull(repoRoot, io);
  if (repoStat && (repoStat.isSymbolicLink() || !repoStat.isDirectory())) {
    throw new Error(`global store repository must be a real directory: ${repoRoot}`);
  }
  const registry = loadRoots(env, { fs: io });
  const registeredPersonal = registry.roots[PERSONAL_ROOT_NAME];
  if (registeredPersonal && registeredPersonal !== storeRoot) {
    throw new Error(`personal root conflict: registry points to ${registeredPersonal}, not global store ${storeRoot}`);
  }
  assertExistingStoreSafe(storeRoot, io);
  return { repoRoot, storeRoot };
}

/**
 * Create the canonical empty-store shape. An incomplete or symlinked existing
 * store is refused so bootstrap never repairs state by clobbering it.
 */
export function scaffoldStore(repoRoot, { fs: io = fs } = {}) {
  const resolvedRepoRoot = assertAbsoluteDirectory(repoRoot, "store repository root");
  const storeRoot = path.join(resolvedRepoRoot, "knowledge");
  const graphPath = path.join(storeRoot, "graph-index.json");
  const aliasPath = path.join(storeRoot, "alias-index.json");
  const recordsDir = path.join(storeRoot, "records");

  assertNoSymlinkAtOrBelow(resolvedRepoRoot, storeRoot, io);
  if (isStoreRoot(storeRoot, { fs: io })) {
    const aliasStat = lstatOrNull(aliasPath, io);
    const recordsStat = lstatOrNull(recordsDir, io);
    if (!aliasStat?.isFile() || aliasStat.isSymbolicLink() || !recordsStat?.isDirectory() || recordsStat.isSymbolicLink()) {
      throw new Error(`refusing incomplete store scaffold at ${storeRoot}`);
    }
    ensurePrivateDirectory(resolvedRepoRoot, io);
    ensurePrivateDirectory(storeRoot, io);
    ensurePrivateDirectory(recordsDir, io);
    io.chmodSync(graphPath, 0o600);
    io.chmodSync(aliasPath, 0o600);
    return storeRoot;
  }
  if (exists(graphPath, io) || exists(aliasPath, io) || exists(recordsDir, io)) {
    throw new Error(`refusing incomplete or invalid store scaffold at ${storeRoot}`);
  }

  ensurePrivateDirectory(resolvedRepoRoot, io);
  ensurePrivateDirectory(storeRoot, io);
  ensurePrivateDirectory(recordsDir, io);
  io.writeFileSync(graphPath, JSON.stringify(emptyGraph(), null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  io.writeFileSync(aliasPath, JSON.stringify(emptyAliasIndex(), null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  io.writeFileSync(path.join(recordsDir, ".gitkeep"), "", { encoding: "utf8", mode: 0o600 });
  return storeRoot;
}

/** Absolute path to the MCP-compatible roots registry for an environment. */
export function rootsRegistryPath(env = process.env) {
  return path.join(globalStoreLocation(env).repoRoot, "roots.json");
}

/** Load a valid registry; malformed content is a fail-closed error. */
export function loadRoots(env = process.env, { fs: io = fs } = {}) {
  const file = rootsRegistryPath(env);
  assertGlobalLocationSafe(env, io);
  return readRecoverableRegistry(file, io);
}

function withRegistryLock(env, io, action) {
  const { repoRoot } = assertGlobalLocationSafe(env, io);
  ensurePrivateDirectory(repoRoot, io);
  const lock = path.join(repoRoot, ".roots.json.lock");
  try {
    io.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw registryError("update is locked by another writer");
    throw error;
  }
  const owner = path.join(lock, "owner.json");
  try {
    io.writeFileSync(owner, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    io.rmdirSync(lock);
    throw error;
  }
  try {
    return action();
  } finally {
    if (exists(owner, io)) io.unlinkSync(owner);
    io.rmdirSync(lock);
  }
}

function mergeChangedValue(label, base, current, incoming, incomingHasValue = true) {
  const intendedChange = incomingHasValue && incoming !== base;
  const concurrentChange = current !== base;
  if (intendedChange && concurrentChange && incoming !== current) {
    throw registryError(`concurrent conflict for ${label}`);
  }
  return intendedChange ? incoming : current;
}

function mergeRegistries(baseline, current, incoming) {
  const roots = {};
  const names = new Set([...Object.keys(baseline.roots), ...Object.keys(current.roots), ...Object.keys(incoming.roots)]);
  for (const name of [...names].sort()) {
    const selected = mergeChangedValue(
      `root '${name}'`, baseline.roots[name], current.roots[name], incoming.roots[name], Object.hasOwn(incoming.roots, name),
    );
    if (selected !== undefined) roots[name] = selected;
  }
  const defaultWrite = mergeChangedValue(
    "default_write", baseline.default_write, current.default_write, incoming.default_write, Object.hasOwn(incoming, "default_write"),
  );
  return normalizeRegistry(defaultWrite === undefined ? { roots } : { roots, default_write: defaultWrite });
}

function writeCandidate(file, registry, io) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const content = `${JSON.stringify(registry, null, 2)}\n`;
  io.writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { temp, content };
}

function captureCurrentRegistry(file, io) {
  const captured = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.captured`);
  try {
    io.renameSync(file, captured);
    return captured;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function restoreLatestCapture(file, capturedFiles, io) {
  const remaining = capturedFiles.filter((backup) => exists(backup, io));
  if (!exists(file, io) && remaining.length > 0) io.renameSync(remaining.at(-1), file);
  for (const backup of remaining) {
    if (exists(backup, io)) io.unlinkSync(backup);
  }
}

function saveRootsUnlocked(registry, baseline, env, io) {
  const file = rootsRegistryPath(env);
  const directory = path.dirname(file);
  let pending = normalizeRegistry(registry);
  const capturedFiles = [];
  assertGlobalLocationSafe(env, io);
  ensurePrivateDirectory(directory, io);
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const captured = captureCurrentRegistry(file, io);
      if (captured) {
        capturedFiles.push(captured);
        pending = mergeRegistries(baseline, readRegistryFile(captured, io), pending);
      }
      const { temp, content } = writeCandidate(file, pending, io);
      try {
        io.linkSync(temp, file);
        io.chmodSync(file, 0o600);
      } catch (error) {
        io.unlinkSync(temp);
        if (error?.code === "EEXIST") continue;
        throw error;
      }
      io.unlinkSync(temp);
      if (io.readFileSync(file, "utf8") === content) {
        for (const backup of capturedFiles) io.unlinkSync(backup);
        return file;
      }
    }
    throw registryError("changed repeatedly during an atomic update; retry later");
  } finally {
    restoreLatestCapture(file, capturedFiles, io);
  }
}

/** Merge and persist roots without replacing unrelated concurrent additions. */
export function saveRoots(registry, env = process.env, { fs: io = fs } = {}) {
  return withRegistryLock(env, io, () => saveRootsUnlocked(registry, { roots: {} }, env, io));
}

/** Register or update a root without changing unrelated roots/default_write. */
export function registerRoot(name, storeRoot, env = process.env, { fs: io = fs } = {}) {
  if (typeof name !== "string" || !name.trim()) throw new Error("registerRoot: name required");
  const root = assertAbsoluteDirectory(storeRoot, "store root");
  return withRegistryLock(env, io, () => {
    const baseline = loadRoots(env, { fs: io });
    const registry = { ...baseline, roots: { ...baseline.roots } };
    if (registry.roots[name] === root) {
      io.chmodSync(rootsRegistryPath(env), 0o600);
      return registry;
    }
    registry.roots[name] = root;
    saveRootsUnlocked(registry, baseline, env, io);
    return normalizeRegistry(registry);
  });
}

/** Resolve a registry name (preferred) or an absolute valid store-root path. */
export function resolveRoot(nameOrPath, env = process.env, { fs: io = fs } = {}) {
  if (typeof nameOrPath !== "string" || !nameOrPath.trim()) return null;
  const registry = loadRoots(env, { fs: io });
  const byName = registry.roots[nameOrPath];
  if (byName) return isStoreRoot(byName, { fs: io }) ? byName : null;
  if (!path.isAbsolute(nameOrPath)) return null;
  const candidate = path.resolve(nameOrPath);
  return isStoreRoot(candidate, { fs: io }) ? candidate : null;
}

/** Return the first stable registry name for an absolute store root, if any. */
export function nameForRoot(storeRoot, env = process.env, { fs: io = fs } = {}) {
  if (typeof storeRoot !== "string" || !path.isAbsolute(storeRoot)) return null;
  const target = path.resolve(storeRoot);
  const registry = loadRoots(env, { fs: io });
  for (const name of Object.keys(registry.roots).sort()) {
    if (registry.roots[name] === target) return name;
  }
  return null;
}

/**
 * Bootstrap the sole machine-local personal store and atomically register it.
 * A conflicting personal entry is intentionally not overwritten: resolving a
 * surprising root is worse than refusing and asking the operator to repair it.
 */
export function ensureGlobalStore(env = process.env, { fs: io = fs } = {}) {
  const { repoRoot, storeRoot } = assertGlobalLocationSafe(env, io);
  return withRegistryLock(env, io, () => {
    const baseline = loadRoots(env, { fs: io });
    const registry = { ...baseline, roots: { ...baseline.roots } };
    const registeredPersonal = registry.roots[PERSONAL_ROOT_NAME];
    if (registeredPersonal && registeredPersonal !== storeRoot) {
      throw new Error(`personal root conflict: registry points to ${registeredPersonal}, not global store ${storeRoot}`);
    }
    const bootstrapped = scaffoldStore(repoRoot, { fs: io });
    if (!registeredPersonal) {
      registry.roots[PERSONAL_ROOT_NAME] = bootstrapped;
      saveRootsUnlocked(registry, baseline, env, io);
    } else {
      io.chmodSync(rootsRegistryPath(env), 0o600);
    }
    return bootstrapped;
  });
}
