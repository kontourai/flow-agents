import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { flagBool, flagString, parseArgs } from "../lib/args.js";
import { buildWorkflowLearningProjection, readWorkflowLearningSources } from "../lib/workflow-learning-projection.js";

type Summary = {
  scanned_learning_file_count: number;
  emitted_learning_count: number;
  destination: string | null;
  producer: string;
  scope: {
    kind: string;
    id: string;
  };
  dry_run: boolean;
};

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function printHelp(): void {
  console.log("Usage: flow-agents console-learning-projection [options]");
  console.log("");
  console.log("Build an inert Console learning projection from local workflow learning sidecars.");
  console.log("");
  console.log("Options:");
  console.log("  --artifact-root <path>  Workflow artifact root to scan (default: .flow-agents)");
  console.log("  --kontour-root <path>   Local Kontour root to write under (default: .kontour)");
  console.log("  --scope <id>            Projection scope id (default: current directory name)");
  console.log("  --scope-kind <kind>     Projection scope kind (default: repo)");
  console.log("  --producer <id>         Projection producer id (default: flow-agents-learning)");
  console.log("  --generated-at <ISO>    Override generated timestamp for deterministic output");
  console.log("  --dry-run               Do not write a projection file");
  console.log("  --json                  Print stable JSON summary");
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
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) throw new Error(`destination directory is not a directory: ${target}`);
}

function containedPath(root: string, destination: string): void {
  const relative = path.relative(root, destination);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`destination escapes kontour root: ${destination}`);
  }
}

function destinationPath(kontourRoot: string, producer: string, scopeKind: string, scopeId: string): string {
  const root = path.resolve(kontourRoot);
  const destination = path.resolve(root, "projections", producer, `${scopeKind}-${scopeId}.json`);
  containedPath(root, destination);
  return destination;
}

function writeProjection(file: string, root: string, projection: unknown): void {
  containedPath(root, file);
  ensureDirectory(path.dirname(file));
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`refusing to write symlinked projection file: ${file}`);
  }
  fs.writeFileSync(file, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
}

function printText(summary: Summary): void {
  console.log(`Scanned learning files: ${summary.scanned_learning_file_count}`);
  console.log(`Emitted learnings: ${summary.emitted_learning_count}`);
  if (summary.dry_run) console.log("Dry run: no projection written");
  else console.log(`Projection: ${summary.destination}`);
}

export function main(argv = process.argv.slice(2)): number {
  const { flags } = parseArgs(argv);
  if (flagBool(flags, "help") || flagBool(flags, "h")) {
    printHelp();
    return 0;
  }

  try {
    const artifactRoot = path.resolve(flagString(flags, "artifact-root", ".flow-agents") ?? ".flow-agents");
    const kontourRoot = path.resolve(flagString(flags, "kontour-root", ".kontour") ?? ".kontour");
    const producer = requireSafeSegment(flagString(flags, "producer", "flow-agents-learning") ?? "flow-agents-learning", "--producer");
    const scope = {
      kind: requireSafeSegment(flagString(flags, "scope-kind", "repo") ?? "repo", "--scope-kind"),
      id: requireSafeSegment(flagString(flags, "scope", defaultScopeId()) ?? defaultScopeId(), "--scope"),
    };
    const dryRun = flagBool(flags, "dry-run");
    const sources = readWorkflowLearningSources(artifactRoot);
    const projection = buildWorkflowLearningProjection(sources, {
      scope,
      producer: { id: producer, product: "flow-agents" },
      generatedAt: flagString(flags, "generated-at"),
    });
    const destination = dryRun ? null : destinationPath(kontourRoot, producer, scope.kind, scope.id);
    if (destination) writeProjection(destination, kontourRoot, projection);
    const summary: Summary = {
      scanned_learning_file_count: sources.length,
      emitted_learning_count: projection.learnings.length,
      destination,
      producer,
      scope,
      dry_run: dryRun,
    };
    if (flagBool(flags, "json")) console.log(JSON.stringify(summary, null, 2));
    else printText(summary);
    return 0;
  } catch (error) {
    console.error(`console-learning-projection: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
