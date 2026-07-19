import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, flagBool, flagString } from "../lib/args.js";
import { assertPathContained, assertPathsDisjoint, atomicWriteJson, copyDirAtomic, ensureSafeDirectory, isoNow, readJson, walkFiles } from "../lib/fs.js";
import { assertKitRepository, deriveKitTargets, parseKitDependencies, validateKitRepositoryDiagnostics } from "../flow-kit/validate.js";
import { provisionKit, ProvisionConflictError } from "../flow-kit/provision.js";
import { activateCodexLocal, activateStrandsLocal } from "../runtime-adapters.js";
import { defaultCodexHome } from "../lib/local-artifact-root.js";
import { root } from "../tools/common.js";

const REGISTRY_REL = path.join("kits", "local", "installed-kits.json");
const REPOSITORIES_REL = path.join("kits", "local", "repositories");

function registryPath(dest: string): string { return path.join(dest, REGISTRY_REL); }
function installedPath(dest: string, kitId: string): string { return path.join(dest, REPOSITORIES_REL, kitId); }
function resolveDest(flags: ReturnType<typeof parseArgs>["flags"]): string {
  const explicit = flagString(flags, "dest");
  return path.resolve(explicit ?? defaultCodexHome());
}

function resolveCatalogKitSource(source: string): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(source)) return null;
  const repoCatalogPath = path.join(root, "kits", "catalog.json");
  if (!fs.existsSync(repoCatalogPath)) return null;
  const catalog = readJson(repoCatalogPath) as { kits?: unknown[] };
  const entry = Array.isArray(catalog.kits)
    ? catalog.kits.find((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).id === source)
    : undefined;
  if (!entry || typeof entry !== "object") return null;
  const rel = (entry as Record<string, unknown>).path;
  if (typeof rel !== "string") return null;
  return path.resolve(path.dirname(repoCatalogPath), "..", rel);
}

function resolveProvisionKitSource(source: string, dest: string): string | null {
  const localPath = path.resolve(source);
  if (fs.existsSync(localPath)) return localPath;
  const installed = loadRegistry(dest).kits.find((entry) => entry.id === source);
  if (installed) {
    const installedSource = installedPath(dest, source);
    if (fs.existsSync(installedSource)) return installedSource;
  }
  return resolveCatalogKitSource(source);
}

function loadRegistry(dest: string): { schema_version: string; kits: Record<string, unknown>[] } {
  const file = registryPath(dest);
  if (!fs.existsSync(file)) return { schema_version: "1.0", kits: [] };
  const data = readJson(file) as { schema_version?: string; kits?: unknown[] };
  return { schema_version: data.schema_version ?? "1.0", kits: Array.isArray(data.kits) ? data.kits.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [] };
}

/**
 * Emit a non-blocking warning for each declared kit dependency that is not present
 * in the destination's LOCAL registry.
 *
 * Scope limitation (v1, accepted): this check only sees the local installed-kits
 * registry at `dest`, NOT the built-in Kit Catalog. A dependency satisfied solely by
 * a built-in catalog kit will still warn here. Presence is enforced authoritatively
 * (hard error) at activation time against the full discovered inventory
 * (built-in catalog + local registry) — see src/runtime-adapters.ts.
 */
function warnUninstalledDependencies(manifest: Record<string, unknown>, manifestPath: string, dest: string): void {
  const { entries } = parseKitDependencies(manifest, manifestPath);
  if (!entries.length) return;
  const installed = new Set(loadRegistry(dest).kits.map((entry) => String(entry.id ?? "")));
  const kitId = String(manifest.id);
  for (const dep of entries) {
    if (!installed.has(dep.kit_id)) {
      console.log(`warning: kit '${kitId}' declares a dependency on '${dep.kit_id}'${dep.reason ? ` (${dep.reason})` : ""} which is not installed at ${dest}; install it first with 'flow-agents kit install <source>' or activation will fail`);
    }
  }
}

/**
 * Print non-blocking kit-validation warnings (e.g. an agent-spawning trigger surface
 * declared without complete guard config — context/contracts/trigger-guards.md).
 * Shared by BOTH install source forms (local path and git clone) so the standing
 * warning contract cannot silently diverge between them. Same non-blocking
 * `warning:` convention as warnUninstalledDependencies above.
 */
async function printKitValidationWarnings(kitDir: string): Promise<void> {
  for (const warning of (await validateKitRepositoryDiagnostics(kitDir)).warnings) console.log(`warning: ${warning}`);
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

/** Content hash that excludes .git and other VCS/cache directories (for install git clones). */
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

/**
 * install <source> [--dest <path>] [--force] [--update] [--ref <branch|tag|sha>]
 *
 * Installs a Flow Kit from a local path or a git URL.
 *
 * - Local path: validates then copies the kit into the destination registry.
 * - Git URL (http://, https://, git+, ssh://, file://): shallow-clones the repository,
 *   validates the kit container with @kontourai/flow, then delegates to the install path.
 *   Supports an optional #ref fragment in the URL or a separate --ref flag.
 */
async function install(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const source = args.positionals[0] ?? "";
  if (!source) {
    console.error("install: missing <source> argument");
    console.error("usage: flow-agents kit install <path-or-git-url> [--dest <path>] [--ref <ref>] [--force] [--update]");
    return 2;
  }

  // Detect git URL: starts with http(s)://, git+, ssh://, file://, or ends with .git
  const isGitUrl = /^(https?:\/\/|git\+|ssh:\/\/|file:\/\/)/.test(source) || source.endsWith(".git");

  if (isGitUrl) {
    return await installGitSource(source, argv);
  }
  return await installLocalSource(resolveCatalogKitSource(source) ?? path.resolve(source), argv);
}

async function installLocalSource(source: string, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const dest = resolveDest(args.flags);
  let manifest: Record<string, unknown>;
  try {
    manifest = await assertKitRepository(source);
    await printKitValidationWarnings(source);
  } catch (error) {
    console.log("Flow Kit repository validation failed:");
    for (const diagnostic of ((error as Error & { diagnostics?: string[] }).diagnostics ?? [(error as Error).message])) console.log(` - ${diagnostic}`);
    return 1;
  }
  const kitId = String(manifest.id);
  const target = installedPath(dest, kitId);
  try {
    assertPathsDisjoint(source, target);
    ensureSafeDirectory(dest, dest);
    assertPathContained(dest, target);
    ensureSafeDirectory(dest, path.dirname(target));
    const registryFile = registryPath(dest);
    ensureSafeDirectory(dest, path.dirname(registryFile));
    if (fs.existsSync(registryFile) && fs.lstatSync(registryFile).isSymbolicLink()) {
      throw new Error(`refusing to read or replace symlink: ${registryFile}`);
    }
  } catch (error) {
    console.error(`install: unsafe source or destination: ${(error as Error).message}`);
    return 1;
  }
  warnUninstalledDependencies(manifest, path.join(source, "kit.json"), dest);
  const hash = contentHash(source);
  const registry = loadRegistry(dest);
  const existing = registry.kits.find((entry) => entry.id === kitId);
  const sourceText = source;
  if (existing && existing.source !== sourceText && !flagBool(args.flags, "update")) {
    console.log(`conflict: kit '${kitId}' is already installed from ${existing.source}; rerun with --update to replace it`);
    return 2;
  }
  if (existing && existing.source === sourceText && existing.hash === hash && fs.existsSync(target) && !flagBool(args.flags, "force")) {
    console.log(`kit '${kitId}' is already installed from ${sourceText}`);
    return 0;
  }
  copyDirAtomic(dest, source, target);
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
  atomicWriteJson(dest, registryPath(dest), registry);
  console.log(`${existing ? "updated" : "installed"} local kit '${kitId}' at ${target}`);
  return 0;
}

async function installGitSource(rawUrl: string, argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  // Parse ref: #fragment in URL takes precedence over --ref flag.
  let repoUrl = rawUrl;
  let ref: string | null = null;
  const hashIdx = rawUrl.indexOf("#");
  if (hashIdx !== -1) {
    repoUrl = rawUrl.slice(0, hashIdx);
    ref = rawUrl.slice(hashIdx + 1) || null;
  }
  if (!ref) ref = flagString(args.flags, "ref") ?? null;

  const dest = resolveDest(args.flags);
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
      console.error(`install: git clone failed: ${msg}`);
      return 1;
    }

    // Validate the cloned kit using the same logic as install local.
    let manifest: Record<string, unknown>;
    try {
      manifest = await assertKitRepository(tmpBase);
      await printKitValidationWarnings(tmpBase);
    } catch (error) {
      console.log("Flow Kit repository validation failed:");
      for (const diagnostic of ((error as Error & { diagnostics?: string[] }).diagnostics ?? [(error as Error).message])) {
        console.log(` - ${diagnostic}`);
      }
      return 1;
    }

    // Delegate to the shared install logic (copy + registry update).
    const kitId = String(manifest.id);
    warnUninstalledDependencies(manifest, path.join(tmpBase, "kit.json"), dest);
    const hash = kitContentHash(tmpBase);
    const registry = loadRegistry(dest);
    const existing = registry.kits.find((entry) => entry.id === kitId);
    const target = installedPath(dest, kitId);
    try {
      ensureSafeDirectory(dest, dest);
      assertPathContained(dest, target);
      ensureSafeDirectory(dest, path.dirname(target));
      const registryFile = registryPath(dest);
      ensureSafeDirectory(dest, path.dirname(registryFile));
      if (fs.existsSync(registryFile) && fs.lstatSync(registryFile).isSymbolicLink()) {
        throw new Error(`refusing to read or replace symlink: ${registryFile}`);
      }
    } catch (error) {
      console.error(`install: unsafe destination: ${(error as Error).message}`);
      return 1;
    }
    const sourceText = repoUrl + (ref ? `#${ref}` : "");
    if (existing && existing.source !== sourceText && !update) {
      console.log(`conflict: kit '${kitId}' is already installed from ${existing.source}; rerun with --update to replace it`);
      return 2;
    }
    if (existing && existing.source === sourceText && existing.hash === hash && fs.existsSync(target) && !force) {
      console.log(`kit '${kitId}' is already installed from ${sourceText}`);
      return 0;
    }
    copyDirAtomic(dest, tmpBase, target);
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
    atomicWriteJson(dest, registryPath(dest), registry);
    console.log(`${existing ? "updated" : "installed"} git kit '${kitId}' from ${sourceText} at ${target}`);
    return 0;
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

function list(argv: string[]): number {
  const args = parseArgs(argv);
  const dest = resolveDest(args.flags);
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
  const dest = resolveDest(args.flags);
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
  const dest = resolveDest(args.flags);
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

async function validate(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const kitDir = path.resolve(args.positionals[0] ?? ".");
  const diagnostics = await validateKitRepositoryDiagnostics(kitDir);
  for (const warning of diagnostics.warnings) console.log(`warning: ${warning}`);
  if (diagnostics.errors.length) {
    console.log("Flow Kit repository validation failed:");
    for (const error of diagnostics.errors) console.log(` - ${error}`);
    return 1;
  }
  console.log(`Flow Kit repository validation passed: ${kitDir}`);
  return 0;
}

async function provision(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const source = args.positionals[0];
  if (!source) {
    console.error("provision: missing <kit-id-or-path> argument");
    console.error("usage: flow-agents kit provision <kit-id-or-path> [--target <dir>] [--force] [--dry-run]");
    return 2;
  }
  const dest = resolveDest(args.flags);
  const kitDir = resolveProvisionKitSource(source, dest);
  if (!kitDir) {
    console.error(`provision: kit '${source}' was not found as a local path, installed kit, or catalog kit`);
    return 1;
  }
  const target = path.resolve(flagString(args.flags, "target", process.cwd()) ?? process.cwd());
  try {
    const result = await provisionKit(kitDir, target, {
      force: flagBool(args.flags, "force"),
      dryRun: flagBool(args.flags, "dry-run"),
    });
    for (const file of result.files) console.log(`${result.dry_run ? "would provision" : "provisioned"}: ${file.source} -> ${file.destination}`);
    if (result.dry_run) console.log(`dry-run: ${result.files.length} file(s) declared by kit '${result.kit_id}'; no files written`);
    else if (result.files.length === 0) console.log(`kit '${result.kit_id}' declares no provisions`);
    else console.log(`provisioned ${result.files.length} file(s) from kit '${result.kit_id}' into ${target}`);
    return 0;
  } catch (error) {
    if (error instanceof ProvisionConflictError) {
      console.error(`provision: ${error.message}; rerun with --force to overwrite`);
      for (const conflict of error.conflicts) console.error(`conflict: ${conflict.target} (${conflict.destination})`);
      return 1;
    }
    const diagnostics = (error as Error & { diagnostics?: string[] }).diagnostics;
    if (diagnostics?.length) {
      console.error("Flow Kit repository validation failed:");
      for (const diagnostic of diagnostics) console.error(` - ${diagnostic}`);
    } else console.error(`provision: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * inspect <kit-dir> [--json]
 *
 * Derives conformance level (K0/K1/K2) and consumer targets from a kit's
 * observable asset classes. Delegates core container validation to @kontourai/flow.
 * Exits 1 if the kit fails core container validation.
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
async function inspect(argv: string[]): Promise<number> {
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
  // Pass the real kitDir so @kontourai/flow can validate flow file existence for K0.
  const result = await deriveKitTargets(manifest, kitDir, root);
  console.log(JSON.stringify(result, null, 2));
  return result.conformance.k0 ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "install") return await install(rest);
  // Legacy sub-subcommands forwarded for backward compatibility within the kit subcommand.
  if (command === "install-local") return await installLocalSource(path.resolve(rest[0] ?? ""), rest);
  if (command === "install-git") return await installGitSource(rest[0] ?? "", rest);
  if (command === "list") return list(rest);
  if (command === "status") return status(rest);
  if (command === "activate") return activate(rest);
  if (command === "validate") return await validate(rest);
  if (command === "provision") return await provision(rest);
  if (command === "inspect") return await inspect(rest);
  console.error("usage: flow-agents kit <install|activate|validate|provision|inspect|list|status> ...");
  return 2;
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { main().then((code) => { process.exitCode = code; }).catch((err) => { console.error(err); process.exitCode = 1; }); }
