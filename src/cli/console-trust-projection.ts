import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { flagBool, flagString, parseArgs } from "../lib/args.js";
import { defaultArtifactRootForRead } from "../lib/local-artifact-root.js";
import {
  buildWorkflowTrustProjection,
  projectionTimestamp,
  readWorkflowTrustSources,
} from "../lib/workflow-trust-projection.js";

type Summary = {
  scanned_workflow_count: number;
  emitted_trust_count: number;
  destination: string | null;
  producer: string;
  scope: {
    kind: string;
    id: string;
  };
  dry_run: boolean;
  warnings: string[];
};

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const DEFAULT_KONTOUR_ROOT = path.join(".kontourai", "console");

function printHelp(): void {
  console.log("Usage: flow-agents console-trust-projection [options]");
  console.log("");
  console.log("Build an inert Console trust projection from canonically validated local workflow trust.bundle files (issue #891).");
  console.log("");
  console.log("Options:");
  console.log("  --artifact-root <path>  Workflow artifact root to scan (default: .kontourai/flow-agents)");
  console.log(`  --kontour-root <path>   Local Kontour root to write under (default: ${DEFAULT_KONTOUR_ROOT})`);
  console.log("  --out <file>            Override the projection file; use '-' for stdout");
  console.log("  --scope <id>            Projection scope id (default: current directory name)");
  console.log("  --scope-kind <kind>     Projection scope kind (default: repo)");
  console.log("  --producer <id>         Projection producer id (default: flow-agents-trust)");
  console.log("  --generated-at <ISO>    Override generated timestamp for deterministic output");
  console.log("  --skip-invalid          No-op, accepted for flag-surface consistency with console-process-projection: trust projection already unconditionally warns and skips an invalid workflow sidecar or trust.bundle (issue #891 finding 2); this flag cannot change that default");
  console.log("  --dry-run               Do not write a projection file");
  console.log("  --json                  Print stable JSON summary (file output only)");
  console.log("  --help                  Show this help");
}

function defaultScopeId(): string {
  return path.basename(process.cwd()) || "local";
}

function requireSafeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, dot, underscore, or hyphen: ${value}`);
  }
  return value;
}

function ensureNoSymlinkPath(target: string): void {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`refusing to write through symlink path: ${cursor}`);
    }
  }
}

function ensureDirectory(target: string): void {
  ensureNoSymlinkPath(target);
  fs.mkdirSync(target, { recursive: true });
  ensureNoSymlinkPath(target);
  if (!fs.statSync(target).isDirectory()) throw new Error(`destination directory is not a directory: ${target}`);
}

function containedPath(root: string, destination: string): void {
  const relative = path.relative(root, destination);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`destination escapes kontour root: ${destination}`);
  }
}

function defaultDestination(kontourRoot: string, producer: string, scopeKind: string, scopeId: string): string {
  const root = path.resolve(kontourRoot);
  const destination = path.resolve(root, "projections", producer, `${scopeKind}-${scopeId}.json`);
  containedPath(root, destination);
  return destination;
}

function writeProjection(file: string, projection: unknown, kontourRoot?: string): void {
  if (kontourRoot) containedPath(path.resolve(kontourRoot), file);
  ensureDirectory(path.dirname(file));
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`refusing to write symlinked projection file: ${file}`);
  }
  fs.writeFileSync(file, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) console.error(`warning: ${warning}`);
}

function printText(summary: Summary): void {
  console.log(`Scanned workflows: ${summary.scanned_workflow_count}`);
  console.log(`Emitted trust projections: ${summary.emitted_trust_count}`);
  if (summary.dry_run) console.log("Dry run: no projection written");
  else console.log(`Projection: ${summary.destination}`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { flags } = parseArgs(argv);
  if (flagBool(flags, "help") || flagBool(flags, "h")) {
    printHelp();
    return 0;
  }

  try {
    const artifactRoot = path.resolve(flagString(flags, "artifact-root") ?? defaultArtifactRootForRead());
    const kontourRoot = path.resolve(flagString(flags, "kontour-root", DEFAULT_KONTOUR_ROOT) ?? DEFAULT_KONTOUR_ROOT);
    const producer = requireSafeSegment(flagString(flags, "producer", "flow-agents-trust") ?? "flow-agents-trust", "--producer");
    const scope = {
      kind: requireSafeSegment(flagString(flags, "scope-kind", "repo") ?? "repo", "--scope-kind"),
      id: requireSafeSegment(flagString(flags, "scope", defaultScopeId()) ?? defaultScopeId(), "--scope"),
    };
    const generatedAt = projectionTimestamp(flagString(flags, "generated-at"));
    // Issue #918: accepted (parsed, never rejected) for flag-surface consistency with
    // console-process-projection's --skip-invalid. readWorkflowTrustSources already always
    // warns and skips an invalid workflow sidecar internally (#891 finding 2) -- that default
    // does not change based on this flag's presence or value.
    flagBool(flags, "skip-invalid");
    const read = await readWorkflowTrustSources(artifactRoot, { generatedAt });
    const projection = buildWorkflowTrustProjection(read.sources, {
      scope,
      producer: { id: producer, product: "flow-agents" },
      generatedAt,
    });
    const dryRun = flagBool(flags, "dry-run");
    const requestedOut = flagString(flags, "out");
    if (requestedOut === "-" && flagBool(flags, "json")) throw new Error("--json cannot be combined with --out -");
    if (requestedOut === "-" && dryRun) throw new Error("--dry-run cannot be combined with --out -");

    let destination: string | null = null;
    if (!dryRun) {
      if (requestedOut === "-") {
        process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
      } else if (requestedOut) {
        destination = path.resolve(requestedOut);
        writeProjection(destination, projection);
      } else {
        destination = defaultDestination(kontourRoot, producer, scope.kind, scope.id);
        writeProjection(destination, projection, kontourRoot);
      }
    }

    const summary: Summary = {
      scanned_workflow_count: read.scannedWorkflowCount,
      emitted_trust_count: projection.trusts.length,
      destination,
      producer,
      scope,
      dry_run: dryRun,
      warnings: read.warnings,
    };
    printWarnings(read.warnings);
    if (requestedOut !== "-") {
      if (flagBool(flags, "json")) console.log(JSON.stringify(summary, null, 2));
      else printText(summary);
    }
    return 0;
  } catch (error) {
    console.error(`console-trust-projection: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) {
  void main().then((code) => { process.exitCode = code; });
}
