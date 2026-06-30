#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

const VERITAS_GENERATED = new Set([
  "evidence",
  "claims",
  "runs",
  "repo-conformance",
  "external",
  "eval-drafts",
  "evals",
  "checkins",
  "init-plans",
  "recommendations",
  "surface-console",
]);

function parseArgs(argv) {
  const opts = { repos: [], workspaces: [], apply: false, dryRun: true, json: false, includeFlowAgents: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") { opts.apply = true; opts.dryRun = false; continue; }
    if (arg === "--dry-run") { opts.dryRun = true; opts.apply = false; continue; }
    if (arg === "--json") { opts.json = true; continue; }
    if (arg === "--include-flow-agents") { opts.includeFlowAgents = true; continue; }
    if (arg === "--force") { opts.force = true; continue; }
    if (arg === "--repo") { opts.repos.push(requireValue(argv, ++i, arg)); continue; }
    if (arg === "--workspace") { opts.workspaces.push(requireValue(argv, ++i, arg)); continue; }
    if (arg === "--help" || arg === "-h") { opts.help = true; continue; }
    throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a path`);
  return value;
}

function usage() {
  return `Usage: node scripts/migrate-local-artifacts.mjs [--workspace <path>] [--repo <path>] [--include-flow-agents] [--apply] [--force] [--json]

Dry-run is the default. --apply copies generated local artifacts into .kontourai without deleting old paths.
`;
}

function unique(values) {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function repoCandidates(opts) {
  const repos = [...opts.repos.map((repo) => path.resolve(repo))];
  const workspaces = opts.workspaces.length ? opts.workspaces : (opts.repos.length ? [] : [process.cwd()]);
  for (const workspace of workspaces) {
    const root = path.resolve(workspace);
    if (isDirectory(root)) repos.push(root);
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      repos.push(path.join(root, entry.name));
    }
  }
  return unique(repos).filter(isDirectory);
}

function isDirectory(file) {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
}

function exists(file) {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

function symlinkStatus(file) {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

function hasSymlinkParent(repo, target) {
  const relativeParent = path.relative(repo, path.dirname(target));
  if (!relativeParent || relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) return false;
  let current = repo;
  for (const part of relativeParent.split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    if (symlinkStatus(current)) return true;
  }
  return false;
}

function generatedMappings(repo, includeFlowAgents) {
  const mappings = [
    [".kontour", ".kontourai/console"],
    [".telemetry", ".kontourai/telemetry"],
    [".flow/runs", ".kontourai/flow/runs"],
    [".surface/runs", ".kontourai/surface/runs"],
  ];
  for (const name of VERITAS_GENERATED) mappings.push([`.veritas/${name}`, `.kontourai/veritas/${name}`]);
  mappings.push([".veritas/standards-feedback", ".kontourai/veritas/standards-feedback"]);
  mappings.push([".veritas/standards-feedback-drafts", ".kontourai/veritas/standards-feedback-drafts"]);
  if (includeFlowAgents) mappings.push([".flow-agents", ".kontourai/flow-agents"]);
  return mappings.map(([from, to]) => ({ repo, from: path.join(repo, from), to: path.join(repo, to), relFrom: from, relTo: to }));
}

function durableSkips(repo, includeFlowAgents) {
  const paths = [
    ".flow/config.json",
    ".flow/definitions",
    ".veritas/repo-map.json",
    ".veritas/repo-standards",
    ".veritas/authority",
    ".veritas/proof-families",
    ".agents",
    ".claude/commands",
    "docs",
  ];
  if (!includeFlowAgents) paths.push(".flow-agents");
  return paths.map((rel) => ({ repo, path: path.join(repo, rel), rel, reason: "durable-or-not-included" })).filter((item) => exists(item.path));
}

function listFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        out.push({ file: full, symlink: true });
      } else if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push({ file: full, symlink: false });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function planRepo(repo, opts) {
  const copies = [];
  const skipped = durableSkips(repo, opts.includeFlowAgents);
  for (const mapping of generatedMappings(repo, opts.includeFlowAgents)) {
    if (!exists(mapping.from)) continue;
    const stat = fs.lstatSync(mapping.from);
    if (stat.isSymbolicLink()) {
      skipped.push({ repo, path: mapping.from, rel: mapping.relFrom, reason: "source-is-symlink" });
      continue;
    }
    if (stat.isFile()) {
      skipped.push({ repo, path: mapping.from, rel: mapping.relFrom, reason: "generated-root-is-file" });
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const item of listFiles(mapping.from)) {
      const rel = path.relative(mapping.from, item.file);
      const target = path.join(mapping.to, rel);
      if (item.symlink) {
        skipped.push({ repo, path: item.file, rel: path.join(mapping.relFrom, rel), reason: "source-is-symlink" });
      } else if (hasSymlinkParent(repo, target)) {
        skipped.push({ repo, path: item.file, rel: path.join(mapping.relFrom, rel), target, reason: "target-parent-is-symlink" });
      } else if (exists(target)) {
        if (symlinkStatus(target)) {
          skipped.push({ repo, path: item.file, rel: path.join(mapping.relFrom, rel), target, reason: "target-is-symlink" });
        } else if (!opts.force) {
          skipped.push({ repo, path: item.file, rel: path.join(mapping.relFrom, rel), target, reason: "target-exists" });
        } else {
          copies.push({ repo, source: item.file, target, relSource: path.join(mapping.relFrom, rel), relTarget: path.join(mapping.relTo, rel) });
        }
      } else {
        copies.push({ repo, source: item.file, target, relSource: path.join(mapping.relFrom, rel), relTarget: path.join(mapping.relTo, rel) });
      }
    }
  }
  return { repo, copies, skipped };
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

export function run(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) return { help: usage(), reports: [], summary: { repos: 0, copies: 0, skipped: 0, applied: false, dry_run: true } };
  const reports = repoCandidates(opts).map((repo) => planRepo(repo, opts));
  if (opts.apply) {
    for (const report of reports) for (const copy of report.copies) copyFile(copy.source, copy.target);
  }
  const summary = {
    repos: reports.length,
    copies: reports.reduce((sum, report) => sum + report.copies.length, 0),
    skipped: reports.reduce((sum, report) => sum + report.skipped.length, 0),
    applied: opts.apply,
    dry_run: !opts.apply,
  };
  return { reports, summary };
}

function printText(result) {
  if (result.help) {
    process.stdout.write(result.help);
    return;
  }
  console.log(`Local artifact migration ${result.summary.dry_run ? "dry-run" : "apply"}`);
  console.log(`Repositories scanned: ${result.summary.repos}`);
  console.log(`Files to copy: ${result.summary.copies}`);
  console.log(`Skipped paths: ${result.summary.skipped}`);
  for (const report of result.reports) {
    if (!report.copies.length && !report.skipped.length) continue;
    console.log(`\n${report.repo}`);
    for (const copy of report.copies) console.log(`  COPY ${copy.relSource} -> ${copy.relTarget}`);
    for (const skip of report.skipped) console.log(`  SKIP ${skip.rel}${skip.target ? ` -> ${path.relative(report.repo, skip.target)}` : ""} (${skip.reason})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = run();
    if (parseArgs(process.argv.slice(2)).json) console.log(JSON.stringify(result, null, 2));
    else printText(result);
  } catch (error) {
    console.error(`migrate-local-artifacts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
