#!/usr/bin/env node
// Install a prepared Flow Agents overlay without claiming or deleting unrelated files.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  process.stderr.write(`install-owned-files: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
if (checkOnly) args.shift();
const trustedSymlinkRootIndex = args.indexOf("--trusted-symlink-root");
let trustedSymlinkRoot;
let trustedSymlinkRootInput;
let trustedSymlinkRootIdentity;
const trustedSymlinkChildren = new Set();
if (trustedSymlinkRootIndex !== -1) {
  trustedSymlinkRootInput = args[trustedSymlinkRootIndex + 1];
  if (!trustedSymlinkRootInput || trustedSymlinkRootInput.startsWith("--")) fail("--trusted-symlink-root requires an existing directory");
  try {
    trustedSymlinkRoot = fs.realpathSync(trustedSymlinkRootInput);
    if (!fs.statSync(trustedSymlinkRoot).isDirectory()) fail(`trusted symlink root is not a directory: ${trustedSymlinkRootInput}`);
    trustedSymlinkRootIdentity = fs.statSync(trustedSymlinkRoot);
    if (typeof process.getuid === "function" && trustedSymlinkRootIdentity.uid !== process.getuid()) {
      fail(`trusted symlink root is not owned by the current user: ${trustedSymlinkRootInput}`);
    }
    if ((trustedSymlinkRootIdentity.mode & 0o022) !== 0) fail(`trusted symlink root is group- or world-writable: ${trustedSymlinkRootInput}`);
  } catch (error) {
    fail(`invalid trusted symlink root: ${trustedSymlinkRootInput}: ${error.message}`);
  }
  args.splice(trustedSymlinkRootIndex, 2);
}
while (args.includes("--trusted-symlink-child")) {
  const childIndex = args.indexOf("--trusted-symlink-child");
  const child = args[childIndex + 1];
  if (!trustedSymlinkRoot) fail("--trusted-symlink-child requires --trusted-symlink-root");
  if (!child || child.includes("/") || child.includes("\\") || child === "." || child === ".." || child.startsWith("--")) {
    fail("--trusted-symlink-child requires one direct destination child name");
  }
  trustedSymlinkChildren.add(child);
  args.splice(childIndex, 2);
}
const metadataIndex = args.indexOf("--metadata-json");
let manifestMetadata = {};
if (metadataIndex !== -1) {
  const metadataJson = args[metadataIndex + 1];
  if (!metadataJson) fail("--metadata-json requires a JSON object");
  try { manifestMetadata = JSON.parse(metadataJson); } catch (error) { fail(`invalid manifest metadata: ${error.message}`); }
  if (!manifestMetadata || typeof manifestMetadata !== "object" || Array.isArray(manifestMetadata)) fail("manifest metadata must be a JSON object");
  if (Object.hasOwn(manifestMetadata, "schema_version") || Object.hasOwn(manifestMetadata, "files")) fail("manifest metadata cannot replace schema_version or files");
  args.splice(metadataIndex, 2);
}
const adoptGeneratedMarkerIndex = args.indexOf("--adopt-generated-seed-marker");
let adoptGeneratedSeedMarker;
if (adoptGeneratedMarkerIndex !== -1) {
  adoptGeneratedSeedMarker = args[adoptGeneratedMarkerIndex + 1];
  if (!adoptGeneratedSeedMarker || adoptGeneratedSeedMarker.startsWith("--")) {
    fail("--adopt-generated-seed-marker requires an exact first-line marker");
  }
  args.splice(adoptGeneratedMarkerIndex, 2);
}
const [sourceArg, destArg, manifestArg, ...extraArgs] = args;
if (!sourceArg || !destArg || !manifestArg) fail("usage: install-owned-files.js <overlay> <destination> <manifest-relative-path>");
if (extraArgs.length) fail(`unexpected arguments: ${extraArgs.join(" ")}`);
const source = fs.realpathSync(sourceArg);
function canonicalizeMissing(value) {
  let current = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(current)) {
    missing.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(fs.realpathSync(current), ...missing);
}
const dest = canonicalizeMissing(destArg);
const manifestPath = path.join(dest, manifestArg);

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function isAdoptableGeneratedSeed(rel, target) {
  // Codex config/profile seeds are generated from the packaging manifest. A
  // legacy install predating ownership manifests can therefore be adopted only
  // when its first line carries the exact generated-file marker. This remains
  // deliberately narrower than a general overwrite exception.
  if (!adoptGeneratedSeedMarker || (rel !== "config.toml" && !rel.endsWith(".config.toml"))) return false;
  const firstLine = fs.readFileSync(target, "utf8").split(/\r?\n/, 1)[0];
  return firstLine === adoptGeneratedSeedMarker;
}

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    fail(`unable to inspect destination entry: ${file}: ${error.message}`);
  }
}

function relativeFiles(root, current = root) {
  const out = [];
  for (const name of fs.readdirSync(current).sort()) {
    const file = path.join(current, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fail(`refusing symlink in install overlay: ${file}`);
    if (stat.isDirectory()) for (const nested of relativeFiles(root, file)) out.push(nested);
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

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function currentTrustedSymlinkRoot() {
  if (!trustedSymlinkRoot || !trustedSymlinkRootInput) return undefined;
  let current;
  try {
    current = fs.realpathSync(trustedSymlinkRootInput);
  } catch (error) {
    fail(`trusted symlink root is no longer resolvable: ${trustedSymlinkRootInput}: ${error.message}`);
  }
  if (current !== trustedSymlinkRoot) fail(`trusted symlink root changed during install: ${trustedSymlinkRootInput}`);
  const identity = fs.statSync(current);
  if (identity.dev !== trustedSymlinkRootIdentity.dev || identity.ino !== trustedSymlinkRootIdentity.ino) {
    fail(`trusted symlink root identity changed during install: ${trustedSymlinkRootInput}`);
  }
  return current;
}

function ensureSafeParent(target, create) {
  const relative = path.relative(dest, path.dirname(target));
  let current = dest;
  for (const [index, part] of relative.split(path.sep).filter(Boolean).entries()) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error && error.code !== "ENOENT") fail(`unable to inspect destination component: ${current}: ${error.message}`);
    }
    if (stat) {
      if (stat.isSymbolicLink()) {
        const root = currentTrustedSymlinkRoot();
        if (!root || index !== 0 || !trustedSymlinkChildren.has(part)) fail(`refusing to write through symlink: ${current}`);
        let canonicalTarget;
        try {
          canonicalTarget = fs.realpathSync(current);
        } catch (error) {
          fail(`trusted destination symlink is not resolvable: ${current}: ${error.message}`);
        }
        let canonicalStat;
        try {
          canonicalStat = fs.lstatSync(canonicalTarget);
        } catch (error) {
          fail(`unable to inspect trusted destination symlink target: ${current}: ${error.message}`);
        }
        if (!canonicalStat.isDirectory()) fail(`trusted destination symlink must target a directory: ${current}`);
        if (!containedBy(root, canonicalTarget)) fail(`trusted destination symlink escapes its bound root: ${current}`);
        continue;
      }
      if (!stat.isDirectory()) fail(`destination component is not a directory: ${current}`);
    } else if (create) {
      fs.mkdirSync(current);
    }
  }
}

function readManifest() {
  const stat = lstatIfPresent(manifestPath);
  if (!stat) return new Map();
  ensureSafeParent(manifestPath, false);
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
  const stat = lstatIfPresent(target);
  if (!stat) continue;
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
      if (!recognizableLegacy && !isAdoptableGeneratedSeed(entry.rel, target)) {
        fail(`refusing to overwrite unowned or ambiguous file: ${target}`);
      }
    }
  } else if (currentHash !== oldHash && currentHash !== entry.hash) {
    fail(`refusing to overwrite modified Flow Agents file: ${target}`);
  }
}
for (const [rel] of previous) {
  const target = targetFor(rel);
  ensureSafeParent(target, false);
  const stat = lstatIfPresent(target);
  if (stat?.isSymbolicLink()) fail(`refusing to remove symlink replacing owned file: ${target}`);
}

if (checkOnly) process.exit(0);

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
  // Revalidate the logical parent immediately before removal. A trusted
  // top-level Stow link remains allowed only while it resolves inside its
  // explicitly bound backing root.
  ensureSafeParent(target, false);
  const stat = lstatIfPresent(target);
  if (!stat) continue;
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
if (lstatIfPresent(manifestPath)?.isSymbolicLink()) fail(`refusing to replace symlink: ${manifestPath}`);
const manifestTemp = `${manifestPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
try {
  fs.writeFileSync(manifestTemp, `${JSON.stringify({ schema_version: "1.0", ...manifestMetadata, files: incoming.map((entry) => ({ path: entry.rel, sha256: entry.hash })) }, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(manifestTemp, manifestPath);
} finally {
  fs.rmSync(manifestTemp, { force: true });
}
