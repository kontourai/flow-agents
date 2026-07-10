#!/usr/bin/env node
// Install a prepared Flow Agents overlay without claiming or deleting unrelated files.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  process.stderr.write(`install-owned-files: ${message}\n`);
  process.exit(1);
}

const [sourceArg, destArg, manifestArg] = process.argv.slice(2);
if (!sourceArg || !destArg || !manifestArg) fail("usage: install-owned-files.js <overlay> <destination> <manifest-relative-path>");
const source = fs.realpathSync(sourceArg);
const dest = fs.realpathSync(destArg);
const manifestPath = path.join(dest, manifestArg);

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function relativeFiles(root, current = root) {
  const out = [];
  for (const name of fs.readdirSync(current).sort()) {
    const file = path.join(current, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fail(`refusing symlink in install overlay: ${file}`);
    if (stat.isDirectory()) out.push(...relativeFiles(root, file));
    else if (stat.isFile()) out.push(path.relative(root, file).split(path.sep).join("/"));
    else fail(`unsupported install overlay entry: ${file}`);
  }
  return out;
}

function targetFor(rel) {
  if (!rel || rel.split("/").some((part) => !part || part === "." || part === "..")) fail(`unsafe relative path: ${rel}`);
  const target = path.resolve(dest, ...rel.split("/"));
  const relative = path.relative(dest, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail(`path escapes destination: ${rel}`);
  return target;
}

function ensureSafeParent(target, create) {
  const relative = path.relative(dest, path.dirname(target));
  let current = dest;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) fail(`refusing to write through symlink: ${current}`);
      if (!stat.isDirectory()) fail(`destination component is not a directory: ${current}`);
    } else if (create) {
      fs.mkdirSync(current);
    }
  }
}

function readManifest() {
  if (!fs.existsSync(manifestPath)) return new Map();
  ensureSafeParent(manifestPath, false);
  const stat = fs.lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`ownership manifest is not a regular file: ${manifestPath}`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch (error) { fail(`invalid ownership manifest: ${error.message}`); }
  if (parsed.schema_version !== "1.0" || !Array.isArray(parsed.files)) fail("unsupported ownership manifest; remove it only after manually auditing installed files");
  return new Map(parsed.files.map((entry) => [String(entry.path), String(entry.sha256)]));
}

function legacyInstallCutoff() {
  if (fs.existsSync(manifestPath)) return null;
  const recordPath = path.join(dest, ".flow-agents", "install.json");
  const hooksPath = path.join(dest, "hooks.json");
  for (const file of [recordPath, hooksPath]) {
    if (!fs.existsSync(file)) return null;
    ensureSafeParent(file, false);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
  }
  let record;
  try { record = JSON.parse(fs.readFileSync(recordPath, "utf8")); } catch { return null; }
  const installedAt = Date.parse(String(record.installedAt ?? ""));
  if (record.runtime !== "codex" || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(String(record.version ?? "")) || !Number.isFinite(installedAt)) return null;
  const hooks = fs.readFileSync(hooksPath, "utf8");
  if (!hooks.includes("Recording Flow Agents telemetry") && !hooks.includes("stop-goal-fit.js")) return null;
  return installedAt + 2000;
}

// Exact path classes managed by the pre-manifest installer. These are an
// auditable historical contract, intentionally narrower than "all incoming
// files": root config/auth/hooks, kits/local, user-extensible skills/agents,
// and arbitrary destination files are never bootstrapped from timestamps.
function wasLegacyManagedPath(rel) {
  const [top] = rel.split("/");
  const managedTrees = new Set([
    ".flow-agents", "agent-cards", "build", "context", "docs", "evals",
    "integrations", "packaging", "powers", "prompts", "schemas", "scripts",
  ]);
  if (managedTrees.has(top)) return rel !== ".flow-agents/install.json";
  if (top === "kits") return !rel.startsWith("kits/local/");
  return new Set(["README.md", "console.telemetry.json", "install.sh"]).has(rel);
}

const previous = readManifest();
const legacyCutoff = legacyInstallCutoff();
const incoming = relativeFiles(source).map((rel) => ({ rel, source: path.join(source, ...rel.split("/")), hash: hashFile(path.join(source, ...rel.split("/"))) }));

// Complete preflight before the first destination mutation.
for (const entry of incoming) {
  const target = targetFor(entry.rel);
  ensureSafeParent(target, false);
  if (!fs.existsSync(target)) continue;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fail(`refusing to replace symlink: ${target}`);
  if (!stat.isFile()) fail(`destination collision is not a regular file: ${target}`);
  const oldHash = previous.get(entry.rel);
  const currentHash = hashFile(target);
  // Migration from the pre-manifest installer: byte-identical bundle files can
  // be adopted without overwriting them. Any differing unowned file is a hard
  // collision and remains untouched.
  if (!oldHash) {
    if (currentHash !== entry.hash) {
      const recognizableLegacy = legacyCutoff !== null && wasLegacyManagedPath(entry.rel) && stat.mtimeMs <= legacyCutoff;
      if (!recognizableLegacy) fail(`refusing to overwrite unowned or ambiguous file: ${target}`);
    }
  } else if (currentHash !== oldHash && currentHash !== entry.hash) {
    fail(`refusing to overwrite modified Flow Agents file: ${target}`);
  }
}
for (const [rel] of previous) {
  const target = targetFor(rel);
  ensureSafeParent(target, false);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) fail(`refusing to remove symlink replacing owned file: ${target}`);
}

for (const entry of incoming) {
  const target = targetFor(entry.rel);
  ensureSafeParent(target, true);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.flow-agents-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.copyFileSync(entry.source, temp, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temp, fs.statSync(entry.source).mode & 0o777);
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

const incomingPaths = new Set(incoming.map((entry) => entry.rel));
const staleParents = new Set();
for (const [rel, oldHash] of previous) {
  if (incomingPaths.has(rel)) continue;
  const target = targetFor(rel);
  if (!fs.existsSync(target)) continue;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || hashFile(target) !== oldHash) {
    process.stderr.write(`install-owned-files: preserving modified former Flow Agents file: ${target}\n`);
    continue;
  }
  fs.rmSync(target);
  staleParents.add(path.dirname(target));
}
for (const start of [...staleParents].sort((a, b) => b.length - a.length)) {
  let current = start;
  while (current !== dest) {
    try { fs.rmdirSync(current); } catch { break; }
    current = path.dirname(current);
  }
}

ensureSafeParent(manifestPath, true);
if (fs.existsSync(manifestPath) && fs.lstatSync(manifestPath).isSymbolicLink()) fail(`refusing to replace symlink: ${manifestPath}`);
const manifestTemp = `${manifestPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
try {
  fs.writeFileSync(manifestTemp, `${JSON.stringify({ schema_version: "1.0", files: incoming.map((entry) => ({ path: entry.rel, sha256: entry.hash })) }, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(manifestTemp, manifestPath);
} finally {
  fs.rmSync(manifestTemp, { force: true });
}
