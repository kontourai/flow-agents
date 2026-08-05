#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const modules = path.resolve(process.argv[2] ?? "");
const pin = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const roots = [];
const seen = new Set();

function inspectPackage(packageRoot) {
  packageRoot = path.resolve(packageRoot);
  if (seen.has(packageRoot)) return;
  if (!packageRoot.startsWith(`${modules}${path.sep}`)) throw new Error("Flow dependency escapes staged node_modules");
  const stat = fs.lstatSync(packageRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Flow dependency root must be a real directory");
  seen.add(packageRoot); roots.push(packageRoot);
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  for (const name of Object.keys(metadata.dependencies ?? {}).sort()) inspectPackage(path.join(modules, name));
}

inspectPackage(path.join(modules, "@kontourai", "flow"));
const digest = crypto.createHash("sha256");
for (const packageRoot of roots.sort()) {
  const prefix = path.relative(modules, packageRoot).split(path.sep).join("/");
  const files = [];
  const walk = (dir) => fs.readdirSync(dir).sort().forEach((name) => {
    const file = path.join(dir, name); const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`staged Flow dependency must not contain symlinks: ${file}`);
    if (stat.isDirectory()) walk(file); else if (stat.isFile()) files.push(file);
  });
  walk(packageRoot);
  for (const file of files) {
    digest.update(`${prefix}/${path.relative(packageRoot, file).split(path.sep).join("/")}`);
    digest.update("\0"); digest.update(fs.readFileSync(file)); digest.update("\0");
  }
}
if (digest.digest("hex") !== pin.closure_sha256) throw new Error("staged Flow dependency closure does not match the independently pinned digest");
