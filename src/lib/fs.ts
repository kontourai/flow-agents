import * as fs from "node:fs";
import * as path from "node:path";

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function copyDir(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => !source.split(path.sep).some((part) => [".git", "__pycache__", ".pytest_cache"].includes(part)),
  });
}

export function assertPathContained(root: string, target: string): void {
  const rootReal = fs.realpathSync(root);
  let existingParent = path.dirname(target);
  const missingParts = [path.basename(target)];
  while (!fs.existsSync(existingParent)) {
    missingParts.unshift(path.basename(existingParent));
    const next = path.dirname(existingParent);
    if (next === existingParent) break;
    existingParent = next;
  }
  const parentReal = fs.realpathSync(existingParent);
  const resolved = path.resolve(parentReal, ...missingParts);
  const relative = path.relative(rootReal, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`path escapes root: ${target}`);
  if (fs.existsSync(target)) {
    const targetReal = fs.realpathSync(target);
    const targetRelative = path.relative(rootReal, targetReal);
    if (!targetRelative || targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) throw new Error(`path escapes root: ${target}`);
  }
}

export function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root).sort()) {
    const file = path.join(root, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) out.push(...walkFiles(file));
    else if (stat.isFile()) out.push(file);
  }
  return out;
}

export function relPath(root: string, file: string): string {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : file.split(path.sep).join("/");
}

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
