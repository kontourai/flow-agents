#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, writeText } from "./common.js";

type PacksManifest = { packs?: Array<Record<string, unknown>> };
type Selection = Record<"skills" | "agents" | "powers", Set<string>>;

function splitPacks(value: string): Set<string> {
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}

function namesFor(packs: PacksManifest): Set<string> {
  return new Set((packs.packs ?? []).map((pack) => String(pack.name ?? "")));
}

function entries(pack: Record<string, unknown>, field: keyof Selection): string[] {
  const value = pack[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function assertSafeName(name: string, label: string): void {
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(name)) throw new Error(`${label} contains unsafe pack member name: ${name}`);
}

function assertContained(rootDir: string, target: string): void {
  const rootReal = fs.realpathSync(rootDir);
  const parentReal = fs.realpathSync(path.dirname(target));
  const resolved = path.resolve(parentReal, path.basename(target));
  const relative = path.relative(rootReal, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`refusing to remove path outside install root: ${target}`);
  if (fs.existsSync(target)) {
    const targetReal = fs.realpathSync(target);
    const targetRelative = path.relative(rootReal, targetReal);
    if (!targetRelative || targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) throw new Error(`refusing to remove path outside install root: ${target}`);
  }
}

function packSelection(packs: PacksManifest, requested: Set<string>): [Set<string>, Selection] {
  const selectedNames = new Set<string>();
  for (const pack of packs.packs ?? []) if (pack.default === true) selectedNames.add(String(pack.name));
  for (const name of requested) selectedNames.add(name);
  const unknown = [...selectedNames].filter((name) => !namesFor(packs).has(name)).sort();
  if (unknown.length) throw new Error(`unknown pack(s): ${unknown.join(", ")}`);
  const selected: Selection = { skills: new Set(), agents: new Set(), powers: new Set() };
  for (const pack of packs.packs ?? []) {
    if (!selectedNames.has(String(pack.name))) continue;
    for (const field of Object.keys(selected) as Array<keyof Selection>) {
      for (const item of entries(pack, field)) selected[field].add(item);
    }
  }
  return [selectedNames, selected];
}

function allPackMembers(packs: PacksManifest, field: keyof Selection): Set<string> {
  const values = new Set<string>();
  for (const pack of packs.packs ?? []) for (const item of entries(pack, field)) values.add(item);
  return values;
}

function removePath(rootDir: string, target: string, dryRun: boolean): boolean {
  if (!fs.existsSync(target)) return false;
  assertContained(rootDir, target);
  if (dryRun) {
    console.log(`would remove ${target}`);
    return true;
  }
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`removed ${target}`);
  return true;
}

function pruneNamedDirs(rootDir: string, parent: string, known: Set<string>, keep: Set<string>, dryRun: boolean): number {
  let removed = 0;
  for (const name of [...known].filter((name) => !keep.has(name)).sort()) {
    assertSafeName(name, parent);
    if (removePath(rootDir, path.join(rootDir, parent, name), dryRun)) removed += 1;
  }
  return removed;
}

function pruneAgentFiles(rootDir: string, parent: string, suffix: string, known: Set<string>, keep: Set<string>, dryRun: boolean): number {
  let removed = 0;
  for (const name of [...known].filter((name) => !keep.has(name)).sort()) {
    assertSafeName(name, parent);
    if (removePath(rootDir, path.join(rootDir, parent, `${name}${suffix}`), dryRun)) removed += 1;
  }
  return removed;
}

export function main(argv = process.argv.slice(2)): number {
  const args = argv;
  const dryRun = args.includes("--dry-run");
  const rootArg = args.find((arg) => !arg.startsWith("--"));
  const packsFlag = args.indexOf("--packs");
  if (!rootArg || packsFlag < 0 || !args[packsFlag + 1]) {
    console.error("usage: filter-installed-packs <root> --packs <packs> [--dry-run]");
    return 2;
  }
  const rootDir = path.resolve(rootArg);
  const packsPath = path.join(rootDir, "packaging", "packs.json");
  if (!fs.existsSync(packsPath)) throw new Error(`pack manifest not found: ${packsPath}`);
  const packs = loadJson<PacksManifest>(packsPath);
  const [selectedNames, selected] = packSelection(packs, splitPacks(args[packsFlag + 1]));
  let removed = 0;
  removed += pruneNamedDirs(rootDir, "skills", allPackMembers(packs, "skills"), selected.skills, dryRun);
  removed += pruneNamedDirs(rootDir, ".claude/skills", allPackMembers(packs, "skills"), selected.skills, dryRun);
  removed += pruneNamedDirs(rootDir, ".codex/skills", allPackMembers(packs, "skills"), selected.skills, dryRun);
  removed += pruneNamedDirs(rootDir, "powers", allPackMembers(packs, "powers"), selected.powers, dryRun);
  removed += pruneAgentFiles(rootDir, "agents", ".json", allPackMembers(packs, "agents"), selected.agents, dryRun);
  removed += pruneAgentFiles(rootDir, ".claude/agents", ".md", allPackMembers(packs, "agents"), selected.agents, dryRun);
  removed += pruneAgentFiles(rootDir, ".codex/agents", ".toml", allPackMembers(packs, "agents"), selected.agents, dryRun);
  const summary = {
    selected_packs: [...selectedNames].sort(),
    removed_entries: removed,
    kept: Object.fromEntries(Object.entries(selected).map(([field, values]) => [field, [...values].sort()])),
  };
  if (!dryRun) writeText(path.join(rootDir, ".flow-agents/installed-packs.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]))) try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
