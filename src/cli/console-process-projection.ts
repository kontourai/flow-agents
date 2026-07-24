import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { flagBool, flagString, parseArgs } from "../lib/args.js";
import { defaultArtifactRootForRead } from "../lib/local-artifact-root.js";
import {
  buildWorkflowProcessProjection,
  filterCritiquesForSlug,
  hasUnresolvedLiveCritique,
  readWorkflowProcessSources,
  type BundleCritique,
  type WorkflowProcessSource,
} from "../lib/workflow-process-projection.js";
// Issue #778 review finding 1: review_pending must read the AUTHORITATIVE
// trust.bundle critique state, not the retired critique.json sidecar.
// critiquesFromBundle is workflow-sidecar.ts's own bundle reader (exported
// for this exact purpose) -- src/lib must not import src/cli (layering), so
// this join step lives here, in the CLI layer, not in workflow-process-projection.ts.
import { critiquesFromBundle } from "./workflow-sidecar.js";

type Summary = {
  scanned_state_file_count: number;
  emitted_process_count: number;
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
// Console's actual local runtime root (console-server's
// DEFAULT_CONSOLE_RUNTIME_ROOT, docs/migrations/console-runtime-root.md):
// "Console now reads and writes generated local state only under
// .kontourai/console. It does not read, merge, or write the former .kontour
// tree." Issue #778 review finding 4: the prior default (".kontour") named
// that retired tree.
const DEFAULT_KONTOUR_ROOT = path.join(".kontourai", "console");

function printHelp(): void {
  console.log("Usage: flow-agents console-process-projection [options]");
  console.log("");
  console.log("Build an inert Console process-state projection from local workflow state/handoff sidecars and trust.bundle critique state (issue #778).");
  console.log("");
  console.log("Options:");
  console.log("  --artifact-root <path>  Workflow artifact root to scan (default: .kontourai/flow-agents)");
  console.log(`  --kontour-root <path>   Local Kontour root to write under (default: ${DEFAULT_KONTOUR_ROOT})`);
  console.log("  --scope <id>            Projection scope id (default: current directory name)");
  console.log("  --scope-kind <kind>     Projection scope kind (default: repo)");
  console.log("  --producer <id>         Projection producer id (default: flow-agents-process)");
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
  console.log(`Scanned state files: ${summary.scanned_state_file_count}`);
  console.log(`Emitted processes: ${summary.emitted_process_count}`);
  if (summary.dry_run) console.log("Dry run: no projection written");
  else console.log(`Projection: ${summary.destination}`);
}

// Always printed to stderr, in BOTH --json and text mode, so join-key mismatch
// warnings (issue #778 review finding 3) are never silently swallowed just
// because a caller asked for a clean JSON summary on stdout.
function printWarnings(warnings: string[]): void {
  for (const warning of warnings) console.error(`warning: ${warning}`);
}

/**
 * Joins each source's trust.bundle critique state onto it (issue #778 review
 * finding 1), applying the join-key identity check (findings 3 and its
 * work-item-ref follow-up) first. Mutates nothing on disk; trust.bundle reads
 * are read-only via critiquesFromBundle.
 *
 * A missing trust.bundle already degrades to `[]` inside critiquesFromBundle
 * (no file -> loadJson's `{}` fallback -> no claims array). A MALFORMED one
 * (unreadable, narrative-isolation-tripped, or pre-#344 unstamped claims)
 * instead THROWS -- per-session, caught here so ONE bad bundle never aborts
 * the whole batch: the affected session is projected without the critique
 * refinement (`hasUnresolvedCritique` stays undefined, its own documented
 * "no bundle-derived signal available" meaning) and a warning is reported,
 * rather than the entire projection run failing loud for every sibling
 * session too. This mirrors readWorkflowProcessSources' own per-source
 * (not whole-batch) handling of a mismatched handoff.json.
 */
function joinCritiqueState(artifactRoot: string, sources: WorkflowProcessSource[]): { sources: WorkflowProcessSource[]; warnings: string[] } {
  const warnings: string[] = [];
  const joined = sources.map((source) => {
    const sessionDir = path.join(artifactRoot, source.slug);
    let rawCritiques: BundleCritique[];
    try {
      rawCritiques = critiquesFromBundle(sessionDir) as BundleCritique[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/recovery fence|fenced for recovery/i.test(message)) throw error;
      warnings.push(`${source.slug}: trust.bundle could not be read (${error instanceof Error ? error.message : String(error)}) -- projecting this session without the critique/review_pending refinement`);
      return source;
    }
    const filtered = filterCritiquesForSlug(rawCritiques, source.slug, source.state.work_item_refs ?? []);
    warnings.push(...filtered.warnings);
    return { ...source, hasUnresolvedCritique: hasUnresolvedLiveCritique(filtered.critiques) };
  });
  return { sources: joined, warnings };
}

export function main(argv = process.argv.slice(2)): number {
  const { flags } = parseArgs(argv);
  if (flagBool(flags, "help") || flagBool(flags, "h")) {
    printHelp();
    return 0;
  }

  try {
    const artifactRoot = path.resolve(flagString(flags, "artifact-root") ?? defaultArtifactRootForRead());
    const kontourRoot = path.resolve(flagString(flags, "kontour-root", DEFAULT_KONTOUR_ROOT) ?? DEFAULT_KONTOUR_ROOT);
    const producer = requireSafeSegment(flagString(flags, "producer", "flow-agents-process") ?? "flow-agents-process", "--producer");
    const scope = {
      kind: requireSafeSegment(flagString(flags, "scope-kind", "repo") ?? "repo", "--scope-kind"),
      id: requireSafeSegment(flagString(flags, "scope", defaultScopeId()) ?? defaultScopeId(), "--scope"),
    };
    const dryRun = flagBool(flags, "dry-run");
    const read = readWorkflowProcessSources(artifactRoot);
    const critiqueJoin = joinCritiqueState(artifactRoot, read.sources);
    const warnings = [...read.warnings, ...critiqueJoin.warnings];
    const projection = buildWorkflowProcessProjection(critiqueJoin.sources, {
      scope,
      producer: { id: producer, product: "flow-agents" },
      generatedAt: flagString(flags, "generated-at"),
    });
    const destination = dryRun ? null : destinationPath(kontourRoot, producer, scope.kind, scope.id);
    if (destination) writeProjection(destination, kontourRoot, projection);
    const summary: Summary = {
      scanned_state_file_count: read.sources.length,
      emitted_process_count: projection.processes.length,
      destination,
      producer,
      scope,
      dry_run: dryRun,
      warnings,
    };
    printWarnings(warnings);
    if (flagBool(flags, "json")) console.log(JSON.stringify(summary, null, 2));
    else printText(summary);
    return 0;
  } catch (error) {
    console.error(`console-process-projection: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
