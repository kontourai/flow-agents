import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, flagBool, flagString } from "../lib/args.js";
import { assertPathContained, copyDir, isoNow, readJson, walkFiles, writeJson } from "../lib/fs.js";
import { assertKitRepository, deriveKitTargets } from "../flow-kit/validate.js";
import { activateCodexLocal, activateStrandsLocal } from "../runtime-adapters.js";

const REGISTRY_REL = path.join("kits", "local", "installed-kits.json");
const REPOSITORIES_REL = path.join("kits", "local", "repositories");

function registryPath(dest: string): string { return path.join(dest, REGISTRY_REL); }
function installedPath(dest: string, kitId: string): string { return path.join(dest, REPOSITORIES_REL, kitId); }

function loadRegistry(dest: string): { schema_version: string; kits: Record<string, unknown>[] } {
  const file = registryPath(dest);
  if (!fs.existsSync(file)) return { schema_version: "1.0", kits: [] };
  const data = readJson(file) as { schema_version?: string; kits?: unknown[] };
  return { schema_version: data.schema_version ?? "1.0", kits: Array.isArray(data.kits) ? data.kits.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [] };
}

function contentHash(root: string): string {
  const hash = crypto.createHash("sha256");
  for (const file of walkFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Content hash that excludes .git and other VCS/cache directories (for install-git clones). */
function kitContentHash(root: string): string {
  const EXCLUDE_DIRS = new Set([".git", "__pycache__", ".pytest_cache"]);
  const hash = crypto.createHash("sha256");
  for (const file of walkFiles(root)) {
    const parts = path.relative(root, file).split(path.sep);
    if (parts.some((p) => EXCLUDE_DIRS.has(p))) continue;
    const rel = parts.join("/");
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function installLocal(argv: string[]): number {
  const args = parseArgs(argv);
  const source = path.resolve(args.positionals[0] ?? "");
  const dest = path.resolve(flagString(args.flags, "dest", ".") ?? ".");
  let manifest: Record<string, unknown>;
  try {
    manifest = assertKitRepository(source);
  } catch (error) {
    console.log("Flow Kit repository validation failed:");
    for (const diagnostic of ((error as Error & { diagnostics?: string[] }).diagnostics ?? [(error as Error).message])) console.log(` - ${diagnostic}`);
    return 1;
  }
  const kitId = String(manifest.id);
  const hash = contentHash(source);
  const registry = loadRegistry(dest);
  const existing = registry.kits.find((entry) => entry.id === kitId);
  const target = installedPath(dest, kitId);
  assertPathContained(dest, target);
  const sourceText = source;
  if (existing && existing.source !== sourceText && !flagBool(args.flags, "update")) {
    console.log(`conflict: kit '${kitId}' is already installed from ${existing.source}; rerun with --update to replace it`);
    return 2;
  }
  if (existing && existing.source === sourceText && existing.hash === hash && fs.existsSync(target) && !flagBool(args.flags, "force")) {
    console.log(`kit '${kitId}' is already installed from ${sourceText}`);
    return 0;
  }
  copyDir(source, target);
  const entry: Record<string, unknown> = {
    id: kitId,
    source: sourceText,
    hash,
    installed_at: existing && existing.source === sourceText && !flagBool(args.flags, "update") ? existing.installed_at : isoNow(),
    installed_path: target,
    state: "installed",
  };
  if (typeof manifest.version === "string" && manifest.version) entry.version = manifest.version;
  registry.kits = existing ? registry.kits.map((item) => item.id === kitId ? entry : item) : [...registry.kits, entry];
  writeJson(registryPath(dest), registry);
  console.log(`${existing ? "updated" : "installed"} local kit '${kitId}' at ${target}`);
  return 0;
}

function list(argv: string[]): number {
  const args = parseArgs(argv);
  const dest = path.resolve(flagString(args.flags, "dest", ".") ?? ".");
  const entries = loadRegistry(dest).kits;
  if (!entries.length) {
    console.log("No local Flow Kits installed.");
    return 0;
  }
  for (const entry of entries.sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")))) {
    console.log(`${entry.id} | source=${entry.source} | hash=${entry.hash} | installed_at=${entry.installed_at} | path=${entry.installed_path} | state=${entry.state ?? "unknown"}`);
  }
  return 0;
}

function status(argv: string[]): number {
  const args = parseArgs(argv);
  const dest = path.resolve(flagString(args.flags, "dest", ".") ?? ".");
  let entries = loadRegistry(dest).kits;
  const kitId = args.positionals[0];
  if (kitId) {
    entries = entries.filter((entry) => entry.id === kitId);
    if (!entries.length) {
      console.log(`local Flow Kit '${kitId}' is not installed`);
      return 1;
    }
  }
  if (!entries.length) {
    console.log("No local Flow Kits installed.");
    return 0;
  }
  for (const entry of entries.sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")))) {
    console.log(JSON.stringify({ ...entry, state: fs.existsSync(String(entry.installed_path ?? "")) ? "installed" : "missing" }, null, 2));
  }
  return 0;
}

// Available adapters for the activate subcommand (Issue #32: added strands-local).
const AVAILABLE_ADAPTERS = ["codex-local", "strands-local"];

function activate(argv: string[]): number {
  const args = parseArgs(argv);
  const dest = path.resolve(flagString(args.flags, "dest", ".") ?? ".");
  const sourceRoot = path.resolve(flagString(args.flags, "source-root", path.resolve(path.dirname(process.argv[1]), "..")) ?? ".");
  const adapter = flagString(args.flags, "adapter");
  if (adapter && !AVAILABLE_ADAPTERS.includes(adapter)) {
    console.log(JSON.stringify({ selected_adapter: null, available_adapters: AVAILABLE_ADAPTERS, supported_asset_classes: [], generated_runtime_files: [], skipped_assets: [], warnings: [], errors: [`unknown runtime adapter '${adapter}'; available adapters: ${AVAILABLE_ADAPTERS.join(", ")}`] }, null, 2));
    return 2;
  }
  // Default to codex-local for backward compatibility; strands-local is opt-in via --adapter.
  const result = adapter === "strands-local"
    ? activateStrandsLocal(sourceRoot, dest)
    : activateCodexLocal(sourceRoot, dest);
  console.log(JSON.stringify(result, null, 2));
  return Array.isArray(result.errors) && result.errors.length ? 1 : 0;
}

/**
 * inspect <kit-dir> [--json]
 *
 * Derives conformance level (K0/K1/K2) and consumer targets from a kit's
 * observable asset classes. Exits 1 if the kit fails core container validation.
 * Outputs stable JSON suitable for use by catalog tooling and CI.
 *
 * K-levels (issue #52):
 *   K0  valid core Flow Kit container — gates evaluable agentlessly by any Flow consumer.
 *   K1  K0 + Flow Agents extension assets present (skills/docs/adapters/evals/assets).
 *   K2  K1 + evals present (live evidence layer).
 *
 * Consumer targets derived from observable asset classes:
 *   flow          always present at K0 (any Flow consumer: gates/definition-of-done)
 *   flow-agents   present at K1+ (Flow Agents extension activated)
 *   <namespace>   unknown top-level keys list verbatim as third-party consumer targets
 */
function inspect(argv: string[]): number {
  const args = parseArgs(argv);
  const kitDir = path.resolve(args.positionals[0] ?? ".");
  const manifestPath = path.join(kitDir, "kit.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`inspect: kit.json not found at ${manifestPath}`);
    return 1;
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    console.error(`inspect: invalid JSON in ${manifestPath}: ${(err as Error).message}`);
    return 1;
  }
  const result = deriveKitTargets(manifest);
  console.log(JSON.stringify(result, null, 2));
  return result.conformance.k0 ? 0 : 1;
}


/**
 * install-git <repo-url>[#ref] [--ref <branch|tag|sha>] [--dest <path>] [--force] [--update]
 *
 * Shallow-clones a remote git repository to a temporary directory, validates the kit
 * container with the same logic used by install-local, then delegates to the existing
 * install path. Supports an optional #ref fragment in the URL or a separate --ref flag.
 *
 * Implements kontourai/flow-agents#56 (git-ref install surface).
 */
function installGit(argv: string[]): number {
  const args = parseArgs(argv);
  const rawUrl = args.positionals[0] ?? "";
  if (!rawUrl) {
    console.error("install-git: missing <repo-url> argument");
    console.error("usage: flow-kit install-git <repo-url>[#ref] [--ref <branch|tag|sha>] [--dest <path>]");
    return 2;
  }

  // Parse ref: #fragment in URL takes precedence over --ref flag.
  let repoUrl = rawUrl;
  let ref: string | null = null;
  const hashIdx = rawUrl.indexOf("#");
  if (hashIdx !== -1) {
    repoUrl = rawUrl.slice(0, hashIdx);
    ref = rawUrl.slice(hashIdx + 1) || null;
  }
  if (!ref) ref = flagString(args.flags, "ref") ?? null;

  const dest = path.resolve(flagString(args.flags, "dest", ".") ?? ".");
  const force = flagBool(args.flags, "force") ?? false;
  const update = flagBool(args.flags, "update") ?? false;

  // Shallow-clone into a temporary directory.
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flow-kit-git-"));
  try {
    const cloneArgs = ["clone", "--depth", "1"];
    if (ref) cloneArgs.push("--branch", ref);
    cloneArgs.push("--", repoUrl, tmpBase);
    try {
      child_process.execFileSync("git", cloneArgs, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const msg = err instanceof Error && (err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr
        ? ((err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr as Buffer).toString().trim()
        : String(err);
      console.error(`install-git: git clone failed: ${msg}`);
      return 1;
    }

    // Validate the cloned kit using the same logic as install-local.
    let manifest: Record<string, unknown>;
    try {
      manifest = assertKitRepository(tmpBase);
    } catch (error) {
      console.log("Flow Kit repository validation failed:");
      for (const diagnostic of ((error as Error & { diagnostics?: string[] }).diagnostics ?? [(error as Error).message])) {
        console.log(` - ${diagnostic}`);
      }
      return 1;
    }

    // Delegate to the shared install logic (copy + registry update).
    const kitId = String(manifest.id);
    const hash = kitContentHash(tmpBase);
    const registry = loadRegistry(dest);
    const existing = registry.kits.find((entry) => entry.id === kitId);
    const target = installedPath(dest, kitId);
    assertPathContained(dest, target);
    const sourceText = repoUrl + (ref ? `#${ref}` : "");
    if (existing && existing.source !== sourceText && !update) {
      console.log(`conflict: kit '${kitId}' is already installed from ${existing.source}; rerun with --update to replace it`);
      return 2;
    }
    if (existing && existing.source === sourceText && existing.hash === hash && fs.existsSync(target) && !force) {
      console.log(`kit '${kitId}' is already installed from ${sourceText}`);
      return 0;
    }
    copyDir(tmpBase, target);
    const entry: Record<string, unknown> = {
      id: kitId,
      source: sourceText,
      hash,
      installed_at: existing && existing.source === sourceText && !update ? existing.installed_at : isoNow(),
      installed_path: target,
      state: "installed",
    };
    if (typeof manifest.version === "string" && manifest.version) entry.version = manifest.version;
    registry.kits = existing ? registry.kits.map((item) => item.id === kitId ? entry : item) : [...registry.kits, entry];
    writeJson(registryPath(dest), registry);
    console.log(`${existing ? "updated" : "installed"} git kit '${kitId}' from ${sourceText} at ${target}`);
    return 0;
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2)): number {
  const [command, ...rest] = argv;
  if (command === "install-local") return installLocal(rest);
  if (command === "install-git") return installGit(rest);
  if (command === "list") return list(rest);
  if (command === "status") return status(rest);
  if (command === "activate") return activate(rest);
  if (command === "inspect") return inspect(rest);
  console.error("usage: flow-kit <install-local|install-git|list|status|activate|inspect> ...");
  return 2;
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
