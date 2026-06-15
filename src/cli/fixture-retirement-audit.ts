#!/usr/bin/env node
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

type FixtureAuditItem = {
  fixture: string;
  classification: "kept" | "retire_candidate";
  owners: string[];
  direct_refs: string[];
  reasons: string[];
};

type FixtureAuditResult = {
  fixture_root: string;
  totals: {
    scanned: number;
    kept: number;
    retire_candidates: number;
  };
  fixtures: FixtureAuditItem[];
};

const root = path.resolve(".");
const fixtureRoot = "evals/fixtures";
const ownerScanRoots = ["evals/static", "evals/integration", "scripts"];
const textExtensions = new Set([".md", ".yaml", ".yml", ".json", ".sh", ".js", ".ts"]);
const selfAuditRefs = new Set([
  "evals/integration/test_fixture_retirement_audit.sh",
]);

function printHelp(): void {
  console.log("Usage: flow-agents fixture-retirement-audit [--json]");
  console.log("");
  console.log("Read-only audit for canonical eval fixture retirement candidates.");
  console.log("");
  console.log("A fixture group is kept when docs/fixture-ownership.md lists existing");
  console.log("owners and at least one live eval/script reference still points at it.");
  console.log("The command never deletes, archives, or rewrites fixtures.");
}

function readText(file: string): string {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function walkFiles(dir: string): string[] {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path.relative(root, full).split(path.sep).join("/")));
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}

function fixtureDirs(): string[] {
  const abs = path.join(root, fixtureRoot);
  return fs.readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${fixtureRoot}/${entry.name}`)
    .sort();
}

function ownerInventory(): Map<string, string[]> {
  const doc = readText("docs/fixture-ownership.md");
  const rows = new Map<string, string[]>();
  for (const line of doc.split(/\r?\n/)) {
    if (!line.startsWith("| `evals/fixtures/")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const fixture = cells[1]?.replace(/^`|`$/g, "");
    const ownersCell = cells[3] ?? "";
    if (!fixture) continue;
    const owners = [...ownersCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
    rows.set(fixture, owners);
  }
  return rows;
}

function scanFiles(): string[] {
  return ownerScanRoots
    .flatMap((dir) => walkFiles(dir))
    .filter((file) => textExtensions.has(path.extname(file)))
    .sort();
}

function audit(): FixtureAuditResult {
  const inventory = ownerInventory();
  const files = scanFiles();
  const fixtures = fixtureDirs().map((fixture): FixtureAuditItem => {
    const owners = inventory.get(fixture) ?? [];
    const directRefs = files
      .filter((file) => readText(file).includes(fixture))
      .filter((file) => !file.startsWith(`${fixture}/`))
      .filter((file) => !selfAuditRefs.has(file))
      .sort();
    const reasons: string[] = [];
    if (!inventory.has(fixture)) reasons.push("missing from docs/fixture-ownership.md");
    const missingOwners = owners.filter((owner) => !fs.existsSync(path.join(root, owner)));
    if (missingOwners.length) reasons.push(`owner path missing: ${missingOwners.join(", ")}`);
    if (!owners.length) reasons.push("no owners listed");
    if (!directRefs.length) reasons.push("no direct eval/script references");
    const unlistedRefs = directRefs.filter((ref) => !owners.includes(ref));
    if (unlistedRefs.length) reasons.push(`direct references not listed as owners: ${unlistedRefs.join(", ")}`);
    return {
      fixture,
      classification: reasons.length ? "retire_candidate" : "kept",
      owners,
      direct_refs: directRefs,
      reasons: reasons.length ? reasons : ["owned fixture with live eval/script references"],
    };
  });
  return {
    fixture_root: path.join(root, fixtureRoot),
    totals: {
      scanned: fixtures.length,
      kept: fixtures.filter((item) => item.classification === "kept").length,
      retire_candidates: fixtures.filter((item) => item.classification === "retire_candidate").length,
    },
    fixtures,
  };
}

function printText(result: FixtureAuditResult): void {
  console.log("Fixture retirement audit (dry run, read-only)");
  console.log(`Fixture root: ${result.fixture_root}`);
  console.log(`Scanned fixture groups: ${result.totals.scanned}`);
  console.log(`Kept: ${result.totals.kept}`);
  console.log(`Retire candidates: ${result.totals.retire_candidates}`);
  for (const item of result.fixtures) {
    console.log(`- ${item.classification}: ${item.fixture}`);
    console.log(`  owners: ${item.owners.join(", ") || "none"}`);
    console.log(`  direct_refs: ${item.direct_refs.join(", ") || "none"}`);
    for (const reason of item.reasons) console.log(`  reason: ${reason}`);
  }
}

export function main(argv = process.argv.slice(2)): number {
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      printHelp();
      return 0;
    }
    const result = audit();
    if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else printText(result);
    return 0;
  } catch (error) {
    console.error(`fixture-retirement-audit: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
