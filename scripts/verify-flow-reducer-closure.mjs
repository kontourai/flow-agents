#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const normalizeIndex = args.indexOf("--normalize-modes");
const normalizeModes = normalizeIndex !== -1;
if (normalizeModes) args.splice(normalizeIndex, 1);
if (args.length !== 2) throw new Error("usage: verify-flow-reducer-closure.mjs [--normalize-modes] <node_modules> <pin.json>");
const modules = path.resolve(args[0] ?? "");
const pin = JSON.parse(fs.readFileSync(args[1], "utf8"));
const rootStat = fs.lstatSync(modules);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error("staged node_modules must be a real directory");
}
if (normalizeModes) fs.chmodSync(modules, 0o755);

function packageMetadata(name) {
  const packageRoot = path.join(modules, ...name.split("/"));
  const root = fs.lstatSync(packageRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`staged package must be a real directory: ${name}`);
  }
  const metadataFile = path.join(packageRoot, "package.json");
  const metadataStat = fs.lstatSync(metadataFile);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
    throw new Error(`staged package metadata must be a regular file: ${name}`);
  }
  return JSON.parse(fs.readFileSync(metadataFile, "utf8"));
}

const flow = packageMetadata("@kontourai/flow");
if (flow.name !== pin.package || flow.version !== pin.package_version) {
  throw new Error("staged Flow package does not match the independently pinned identity");
}

const identityPackages = {
  hachure: "hachure",
  surface: "@kontourai/surface",
};
const dependencyVersions = pin.reducer?.dependency_versions;
if (!dependencyVersions || Object.keys(dependencyVersions).sort().join(",") !== Object.keys(identityPackages).sort().join(",")) {
  throw new Error("Flow reducer dependency identity is incomplete or unsupported");
}
for (const [identity, packageName] of Object.entries(identityPackages)) {
  const metadata = packageMetadata(packageName);
  if (metadata.version !== dependencyVersions[identity]) {
    throw new Error(`staged ${packageName} does not match the independently pinned reducer identity`);
  }
}

const digest = crypto.createHash("sha256");
function canonicalMode(stat) {
  // npm preserves executable classification but applies the caller's umask to
  // permission bits. Bind the security-relevant classification, not ambient
  // install policy; the privileged installer applies these canonical modes.
  if (stat.isDirectory()) return 0o755;
  return (stat.mode & 0o100) === 0o100 ? 0o755 : 0o644;
}
function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const entry = path.join(dir, name);
    const stat = fs.lstatSync(entry);
    const relative = path.relative(modules, entry).split(path.sep).join("/");
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(entry);
      const resolvedTarget = path.resolve(path.dirname(entry), target);
      if (path.isAbsolute(target) || !resolvedTarget.startsWith(`${modules}${path.sep}`) || !fs.statSync(resolvedTarget).isFile()) {
        throw new Error(`staged Flow closure symlink must resolve to an in-tree regular file: ${entry}`);
      }
      digest.update(`symlink\0${relative}\0${target}\0`);
    } else if (stat.isDirectory()) {
      if (normalizeModes) fs.chmodSync(entry, canonicalMode(stat));
      digest.update(`directory\0${relative}\0${canonicalMode(stat)}\0`);
      walk(entry);
    } else if (stat.isFile()) {
      if (normalizeModes) fs.chmodSync(entry, canonicalMode(stat));
      digest.update(`file\0${relative}\0${canonicalMode(stat)}\0`);
      digest.update(fs.readFileSync(entry));
      digest.update("\0");
    } else {
      throw new Error(`staged Flow closure contains an unsupported entry: ${entry}`);
    }
  }
}
walk(modules);

const actualDigest = digest.digest("hex");
if (actualDigest !== pin.closure_sha256) {
  throw new Error(`staged Flow dependency closure does not match the independently pinned digest: expected ${pin.closure_sha256}, received ${actualDigest}`);
}
