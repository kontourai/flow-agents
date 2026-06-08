import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findRoot(start: string): string {
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json")) && fs.existsSync(path.join(current, "packaging"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export const root = findRoot(path.dirname(fileURLToPath(import.meta.url)));

export function rel(file: string): string {
  const relative = path.relative(root, file).split(path.sep).join("/");
  return relative.startsWith("..") ? file.split(path.sep).join("/") : relative || ".";
}

export function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

export function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

export function loadJson<T = unknown>(file: string): T {
  return JSON.parse(readText(file)) as T;
}

export function exists(file: string): boolean {
  return fs.existsSync(file);
}

export function walkFiles(dir: string): string[] {
  if (!exists(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function oneLine(value: string, limit = 240): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 3).trimEnd()}...`;
}

export function markdownTable(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => cell.replace(/\n/g, " ")).join(" | ")} |`),
  ];
}
