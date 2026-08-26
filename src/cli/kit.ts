import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, flagBool, flagString } from "../lib/args.js";
import { assertPathContained, assertPathsDisjoint, atomicWriteJson, cleanupDirectoryCopyBackups, copyDirAtomicTransaction, ensureSafeDirectory, isoNow, pruneEmptyDirs, readJson } from "../lib/fs.js";
import { assertKitRepository, deriveKitTargets, parseKitDependencies, validateKitRepositoryDiagnostics } from "../flow-kit/validate.js";
import { provisionKit, ProvisionConflictError } from "../flow-kit/provision.js";
import { observeInstalledKitIntegrity, observeKitContentHash } from "../flow-kit/content-hash.js";
import { activateCodexLocal, activateStrandsLocal } from "../runtime-adapters.js";
import { defaultCodexHome, claudeCodeGlobalDest } from "../lib/local-artifact-root.js";
import { root } from "../tools/common.js";
import {
  hashFile,
  listOwnedTree,
  readOwnedFilesManifest,
  writeOwnedFilesManifest,
  mergeOwnedFilesManifestEntries,
  removeOwnedFilesManifestEntries,
  resolveManifestEntryPath,
  resolveManifestEntrySha256,
  assertManifestEntryParentContained,
  ManifestContainmentViolationError,
  type OwnedFileEntry,
} from "../lib/owned-files-manifest.js";
import {
  catalogKitIds as registryCatalogKitIds,
  loadCatalogKitManifest,
  kitDependencyIds,
  catalogKitSkillNames,
  activeKitIdSet,
  readActiveKitsValidated,
  writeActiveKits,
  readPackageVersion,
  type ActiveKitEntry,
} from "../lib/kit-registry.js";

const REGISTRY_REL = path.join("kits", "local", "installed-kits.json");
const REPOSITORIES_REL = path.join("kits", "local", "repositories");
const REPOSITORIES_REL_POSIX = "kits/local/repositories";
const MAX_RECORD_SOURCE_LENGTH = 1024;
// These Unicode categories can alter terminal/log rendering or provenance display.
// Property escapes are standardized in supported Node runtimes, so this remains
// deterministic without maintaining a partial hand-written Unicode range table.
const UNSAFE_RECORD_SOURCE_CHARACTER_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export type KitCliTestHooks = {
  beforeCopy?: (source: string, target: string) => void;
  afterCopy?: (source: string, target: string) => void;
  writeRegistry?: (root: string, registryFile: string, registry: Record<string, unknown>) => void;
  cleanupBackup?: (backup: string) => void;
};

let testHooks: KitCliTestHooks | undefined;

/** Test-only deterministic race seam. Production callers never set this. */
export function setKitCliTestHooksForTests(hooks: KitCliTestHooks | undefined): void {
  testHooks = hooks;
}

const KIT_USAGE: Record<string, string> = {
  install: "usage: flow-agents kit install <path-or-git-url> [--dest <path>] [--ref <ref>] [--record-source <locator>] [--force] [--update]",
  activate: "usage: flow-agents kit activate [--adapter <codex-local|strands-local>] [--dest <path>] [--source-root <path>]\n"
    + "   or: flow-agents kit activate <kit-id> [<kit-id> ...] (--global | --dest <path>) [--dry-run]  (built-in kit activation)",
  deactivate: "usage: flow-agents kit deactivate <kit-id> [<kit-id> ...] (--global | --dest <path>) [--dry-run] [--force]\n"
    + "   or: flow-agents kit deactivate --all (--global | --dest <path>) [--dry-run] [--force]  (built-in kit deactivation)\n"
    + "   set preflight: dependency/set-rule refusals exit 1; malformed input or containment refusals exit 2; mixed refusals use the highest class, then first encountered.",
  validate: "usage: flow-agents kit validate [<kit-dir>]",
  provision: "usage: flow-agents kit provision <kit-id-or-path> [--target <dir>] [--dest <path>] [--force] [--dry-run]",
  inspect: "usage: flow-agents kit inspect [<kit-dir>] [--json]",
  list: "usage: flow-agents kit list [--dest <path>]",
  status: "usage: flow-agents kit status [<kit-id>] [--dest <path>]",
};

function hasHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function printKitUsage(): void {
  console.log(`Usage: flow-agents kit <install|activate|deactivate|validate|provision|inspect|list|status> [args]

Commands:
  install    Install a Flow Kit from a local path or Git URL.
  activate   Write runtime projections for installed and built-in kits, OR (with a <kit-id>
             positional) activate one or more built-in kits for a claude-code install.
  deactivate Deactivate one or more built-in kits (<kit-id>), or --all, for a claude-code install.
  validate   Validate a Flow Kit repository.
  provision  Copy a kit's declared provisions into a target repository.
  inspect    Report a kit's conformance and consumer targets.
  list       List locally installed Flow Kits.
  status     Report local Flow Kit installation status.

Install notes:
  --record-source <locator> is local-path-only caller-declared provenance metadata.
  The recorded hash, not --record-source, verifies copied Kit bytes.`);
}

function printCommandUsage(command: keyof typeof KIT_USAGE): void {
  console.log(KIT_USAGE[command]);
}

function registryPath(dest: string): string { return path.join(dest, REGISTRY_REL); }
function installedPath(dest: string, kitId: string): string { return path.join(dest, REPOSITORIES_REL, kitId); }
function installedPathRelative(kitId: string): string { return `${REPOSITORIES_REL_POSIX}/${kitId}`; }
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

type InstalledKitRegistry = ReturnType<typeof loadRegistry>;

/**
 * Make the copied target and registry entry one transaction. The target swap
 * remains reversible until the registry's atomic write has completed, so a
 * registry failure cannot leave an unregistered replacement on disk.
 */
function installCopiedKit(options: {
  source: string;
  dest: string;
  target: string;
  manifest: Record<string, unknown>;
  registry: InstalledKitRegistry;
  existing: Record<string, unknown> | undefined;
  sourceText: string;
  update: boolean;
}): void {
  const { source, dest, target, manifest, registry, existing, sourceText, update } = options;
  const transaction = copyDirAtomicTransaction(dest, source, target, (completedTarget) => {
    testHooks?.afterCopy?.(source, completedTarget);
    const targetObservation = observeKitContentHash(completedTarget, { trustedRoot: dest });
    if (targetObservation.state !== "observed") throw new Error(targetObservation.diagnostic);
    return targetObservation.observed_hash;
  }, { removeBackup: testHooks?.cleanupBackup });
  if (!transaction.value) {
    transaction.rollback();
    throw new Error("completed copied kit did not produce a content hash");
  }

  const entry: Record<string, unknown> = {
    id: String(manifest.id),
    source: sourceText,
    hash: transaction.value,
    installed_at: existing && existing.source === sourceText && !update ? existing.installed_at : isoNow(),
    installed_path: installedPathRelative(String(manifest.id)),
    state: "installed",
  };
  if (typeof manifest.version === "string" && manifest.version) entry.version = manifest.version;
  registry.kits = existing ? registry.kits.map((item) => item.id === entry.id ? entry : item) : [...registry.kits, entry];

  try {
    const file = registryPath(dest);
    if (testHooks?.writeRegistry) testHooks.writeRegistry(dest, file, registry);
    else atomicWriteJson(dest, file, registry);
  } catch (error) {
    try {
      transaction.rollback();
    } catch (rollbackError) {
      throw new Error(`registry write failed and target rollback also failed: ${(error as Error).message}; ${(rollbackError as Error).message}`);
    }
    throw new Error(`registry write failed; target rolled back: ${(error as Error).message}`);
  }
  const cleanupError = transaction.commit();
  if (cleanupError) {
    console.warn(`warning: kit '${String(manifest.id)}' is installed and registered, but cleanup of its replaced target failed: ${cleanupError.message}; a later install will retry cleanup`);
  }
}

function cleanStaleInstallArtifacts(dest: string, target: string, existing: Record<string, unknown> | undefined): void {
  if (!existing || typeof existing.hash !== "string") return;
  const observed = observeKitContentHash(target, { trustedRoot: dest });
  if (observed.state !== "observed" || observed.observed_hash !== existing.hash) return;
  for (const cleanupError of cleanupDirectoryCopyBackups(dest, target)) {
    console.warn(`warning: could not clean stale installer artifact for '${path.basename(target)}': ${cleanupError.message}; a later install will retry cleanup`);
  }
}

function acquireInstallRegistryLock(dest: string): () => Error | undefined {
  const lock = path.join(ensureSafeDirectory(dest, path.dirname(registryPath(dest))), ".installed-kits.flow-agents.lock");
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      const error = new Error(`destination install/registry transaction is active or requires recovery: ${lock}`) as Error & { code?: string };
      error.code = "INSTALL_REGISTRY_LOCKED";
      throw error;
    }
    throw cause;
  }
  return () => {
    try {
      fs.rmdirSync(lock);
      return undefined;
    } catch (cause) {
      return cause instanceof Error ? cause : new Error(String(cause));
    }
  };
}

function withInstallRegistryLock<T>(dest: string, action: () => T): T {
  const release = acquireInstallRegistryLock(dest);
  let completed = false;
  try {
    const result = action();
    completed = true;
    return result;
  } finally {
    const releaseError = release();
    if (releaseError) {
      console.warn(`warning: destination install/registry lock cleanup failed${completed ? " after the install transaction completed" : " while preserving the primary transaction outcome"}: ${releaseError.message}; later installs will fail closed until recovery`);
    }
  }
}

type RegistryInstallOutcome =
  | { status: "installed"; existing: boolean }
  | { status: "idempotent" }
  | { status: "conflict"; source: unknown };

/**
 * Serialize every registry-dependent install decision before taking the
 * narrower target-copy lock. The ordering is always registry then target.
 */
function installWithRegistryTransaction(options: {
  source: string;
  manifestPath: string;
  dest: string;
  target: string;
  manifest: Record<string, unknown>;
  sourceText: string;
  hash: string;
  update: boolean;
  force: boolean;
}): RegistryInstallOutcome {
  const { source, manifestPath, dest, target, manifest, sourceText, hash, update, force } = options;
  return withInstallRegistryLock(dest, () => {
    warnUninstalledDependencies(manifest, manifestPath, dest);
    const registry = loadRegistry(dest);
    const kitId = String(manifest.id);
    const existing = registry.kits.find((entry) => entry.id === kitId);
    cleanStaleInstallArtifacts(dest, target, existing);
    if (existing && existing.source !== sourceText && !update) return { status: "conflict", source: existing.source };
    if (existing && existing.source === sourceText && existing.hash === hash && fs.existsSync(target) && !force && !update) return { status: "idempotent" };
    testHooks?.beforeCopy?.(source, target);
    installCopiedKit({ source, dest, target, manifest, registry, existing, sourceText, update });
    return { status: "installed", existing: Boolean(existing) };
  });
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
    console.error("usage: flow-agents kit install <path-or-git-url> [--dest <path>] [--ref <ref>] [--record-source <locator>] [--force] [--update]");
    return 2;
  }

  // Detect git URL: starts with http(s)://, git+, ssh://, file://, or ends with .git
  const isGitUrl = /^(https?:\/\/|git\+|ssh:\/\/|file:\/\/)/.test(source) || source.endsWith(".git");

  if (isGitUrl) {
    return await installGitSource(source, argv);
  }
  return await installLocalSource(resolveCatalogKitSource(source) ?? path.resolve(source), argv);
}

function resolveLocalRecordSource(flags: ReturnType<typeof parseArgs>["flags"], source: string): string | null {
  if (!Object.hasOwn(flags, "record-source")) return source;
  const recordSource = flagString(flags, "record-source");
  if (
    typeof recordSource !== "string"
    || !recordSource.trim()
    || recordSource !== recordSource.trim()
    || recordSource.length > MAX_RECORD_SOURCE_LENGTH
    || UNSAFE_RECORD_SOURCE_CHARACTER_RE.test(recordSource)
  ) {
    console.error(`install: --record-source must be a trimmed non-blank locator no longer than ${MAX_RECORD_SOURCE_LENGTH} characters and must not contain unsafe Unicode control, format, or separator characters`);
    return null;
  }
  return recordSource;
}

async function installLocalSource(source: string, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const dest = resolveDest(args.flags);
  const sourceText = resolveLocalRecordSource(args.flags, source);
  if (sourceText === null) return 2;
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
  const hashObservation = observeKitContentHash(source);
  if (hashObservation.state !== "observed") {
    console.error(`install: cannot safely observe kit content: ${hashObservation.diagnostic}`);
    return 1;
  }
  const hash = hashObservation.observed_hash;
  let outcome: RegistryInstallOutcome;
  try {
    outcome = installWithRegistryTransaction({
      source,
      manifestPath: path.join(source, "kit.json"),
      dest,
      target,
      manifest,
      sourceText,
      hash,
      update: flagBool(args.flags, "update") ?? false,
      force: flagBool(args.flags, "force") ?? false,
    });
  } catch (error) {
    console.error(`install: copied kit or registry transaction failed: ${(error as Error).message}`);
    return 1;
  }
  if (outcome.status === "conflict") {
    console.log(`conflict: kit '${kitId}' is already installed from ${outcome.source}; rerun with --update to replace it`);
    return 2;
  }
  if (outcome.status === "idempotent") {
    console.log(`kit '${kitId}' is already installed from ${sourceText}`);
    return 0;
  }
  const sourceNote = Object.hasOwn(args.flags, "record-source")
    ? `; recorded caller-declared source metadata '${sourceText}' (hash verifies copied bytes)`
    : "";
  console.log(`${outcome.existing ? "updated" : "installed"} local kit '${kitId}' at ${target}${sourceNote}`);
  return 0;
}

async function installGitSource(rawUrl: string, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (Object.hasOwn(args.flags, "record-source")) {
    console.error("install: --record-source is supported only for local path installs; Git installs record their URL and ref");
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
    const hashObservation = observeKitContentHash(tmpBase);
    if (hashObservation.state !== "observed") {
      console.error(`install: cannot safely observe cloned kit content: ${hashObservation.diagnostic}`);
      return 1;
    }
    const hash = hashObservation.observed_hash;
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
    let outcome: RegistryInstallOutcome;
    try {
      outcome = installWithRegistryTransaction({
        source: tmpBase,
        manifestPath: path.join(tmpBase, "kit.json"),
        dest,
        target,
        manifest,
        sourceText,
        hash,
        update,
        force,
      });
    } catch (error) {
      console.error(`install: copied kit or registry transaction failed: ${(error as Error).message}`);
      return 1;
    }
    if (outcome.status === "conflict") {
      console.log(`conflict: kit '${kitId}' is already installed from ${outcome.source}; rerun with --update to replace it`);
      return 2;
    }
    if (outcome.status === "idempotent") {
      console.log(`kit '${kitId}' is already installed from ${sourceText}`);
      return 0;
    }
    console.log(`${outcome.existing ? "updated" : "installed"} git kit '${kitId}' from ${sourceText} at ${target}`);
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
    const integrity = observeInstalledKitIntegrity(entry, dest);
    console.log(JSON.stringify({
      ...entry,
      state: integrity.state,
      recorded_hash: integrity.recorded_hash,
      observed_hash: integrity.observed_hash,
      ...(integrity.diagnostic ? { diagnostic: integrity.diagnostic } : {}),
    }, null, 2));
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

// ─── Built-in kit activation lifecycle ─────────────────────────────────────────────────────
//
// `flow-agents kit activate <kit-id>` / `flow-agents kit deactivate <kit-id>` give a BUILT-IN
// kit (kits/catalog.json: builder, knowledge, release-evidence) a real on/off switch for a
// claude-code install, distinct from the third-party install/activate machinery above (which
// targets `dest/kits/local/` and codex/strands runtime projections). Scope, deliberately:
//   - claude-code only (--global | --dest), mirroring `flow-agents init --uninstall`'s own
//     runtime scope and reusing its dest-resolution shape.
//   - Requires a manifest-backed install (`.flow-agents/owned-files.json`, written by every
//     current `flow-agents init --runtime claude-code` install). A legacy pre-manifest install
//     has no per-file ownership record to safely add to or remove from, so both verbs fail
//     closed with a clear message rather than guessing; this is a disclosed scope decision, not
//     an oversight (see kontourai/flow-agents kit-activation-registry delivery notes).
//   - Only touches SKILL files a kit's own `kit.json` `skills` array declares (the flat
//     `.claude/skills/<name>/` or `skills/<name>/` directories a compiled bundle installs them
//     into -- see src/tools/build-universal-bundles.ts's collectAllSkills()). The ENGINE
//     (hooks, telemetry, agents/) is never touched by either verb.

type BuiltinKitDestResult = { ok: true; dest: string; global: boolean } | { ok: false; error: string };

function resolveBuiltinKitDest(flags: ReturnType<typeof parseArgs>["flags"]): BuiltinKitDestResult {
  const isGlobal = flagBool(flags, "global") ?? false;
  const destFlag = flagString(flags, "dest");
  if (isGlobal && destFlag) return { ok: false, error: "kit activate/deactivate: --global and --dest are mutually exclusive" };
  if (!isGlobal && !destFlag) return { ok: false, error: "kit activate/deactivate: provide --global or --dest <path>" };
  return { ok: true, dest: isGlobal ? claudeCodeGlobalDest() : path.resolve(destFlag as string), global: isGlobal };
}

/**
 * Resolve the compiled claude-code bundle directory (`dist/claude-code`), which
 * `flow-agents kit activate <id>` copies a built-in kit's skill files FROM. Deliberately does
 * NOT auto-build it (unlike `src/cli/init.ts`'s `ensureBundle`, which falls back to invoking
 * `build-universal-bundles.ts`) -- that fallback statically imports esbuild, and importing it
 * from this module would break `scripts/kit.js` when it runs standalone from an installed
 * destination that ships no node_modules (e.g. a Codex home install -- see kontourai/flow-agents
 * kit-activation-registry delivery notes). A missing bundle here is reported as an actionable
 * error instead.
 */
function resolveClaudeCodeBundleDir(): string {
  const bundle = path.join(root, "dist", "claude-code");
  if (!fs.existsSync(path.join(bundle, "install.sh"))) {
    throw new Error(`compiled claude-code bundle not found at ${bundle}; run 'npm run build:bundles' first`);
  }
  return bundle;
}

function skillsPrefixFor(global: boolean): string {
  return global ? "skills" : ".claude/skills";
}

function knownBuiltinKitIds(): Set<string> {
  return new Set(registryCatalogKitIds(root));
}

function unknownBuiltinKitError(command: string, kitId: string): string {
  const known = [...knownBuiltinKitIds()].sort();
  return `kit ${command}: unknown built-in kit '${kitId}'; known kits: ${known.join(", ") || "(none)"}`;
}

function parsedFlagsArgv(flags: ReturnType<typeof parseArgs>["flags"]): string[] {
  const argv: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      argv.push(`--${key}`);
      if (item !== true) argv.push(String(item));
    }
  }
  return argv;
}

/** Topologically order only the requested kits. Dependencies outside the requested set do not
 * change activation's established suggestion-only behavior. */
function orderBuiltinKitSet(kitIds: string[], action: "activate" | "deactivate"): string[] {
  const requested = new Set(kitIds);
  if (action === "deactivate") {
    // Kahn's algorithm with request order as its tie-breaker: each edge is dependent ->
    // dependency, so a dependent is selected first while unrelated requested kits retain the
    // caller's order (rather than a blanket reverse that would scramble them).
    const dependencies = new Map<string, string[]>();
    for (const kitId of kitIds) {
      const loaded = loadCatalogKitManifest(root, kitId);
      if (!loaded) throw new Error(`could not load kit.json for catalog kit '${kitId}'`);
      dependencies.set(kitId, kitDependencyIds(loaded.manifest, loaded.manifestPath).filter((id) => requested.has(id)));
    }
    const indegree = new Map(kitIds.map((id) => [id, 0]));
    for (const deps of dependencies.values()) for (const dependency of deps) indegree.set(dependency, (indegree.get(dependency) ?? 0) + 1);
    const remaining = new Set(kitIds);
    const ordered: string[] = [];
    while (remaining.size) {
      const next = kitIds.find((id) => remaining.has(id) && indegree.get(id) === 0);
      if (!next) throw new Error("built-in kit dependency cycle in requested deactivation set");
      ordered.push(next);
      remaining.delete(next);
      for (const dependency of dependencies.get(next) ?? []) indegree.set(dependency, (indegree.get(dependency) ?? 0) - 1);
    }
    return ordered;
  }
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (kitId: string): void => {
    if (visited.has(kitId)) return;
    if (visiting.has(kitId)) throw new Error(`built-in kit dependency cycle includes '${kitId}'`);
    visiting.add(kitId);
    const loaded = loadCatalogKitManifest(root, kitId);
    if (!loaded) throw new Error(`could not load kit.json for catalog kit '${kitId}'`);
    for (const dependency of kitDependencyIds(loaded.manifest, loaded.manifestPath)) {
      if (requested.has(dependency)) visit(dependency);
    }
    visiting.delete(kitId);
    visited.add(kitId);
    ordered.push(kitId);
  };
  for (const kitId of kitIds) visit(kitId);
  return ordered;
}

/** Shared, mutation-free validation for a whole built-in activation/deactivation set. */
function validateBuiltinKitSet(action: "activate" | "deactivate", kitIds: string[], dest: string): { ok: true; activeKits: ActiveKitEntry[] } | { ok: false; code: number } {
  const errors: string[] = [];
  const catalogIds = knownBuiltinKitIds();
  for (const kitId of kitIds) {
    if (!catalogIds.has(kitId)) errors.push(unknownBuiltinKitError(action, kitId));
    else if (!loadCatalogKitManifest(root, kitId)) errors.push(`kit ${action}: could not load kit.json for catalog kit '${kitId}'`);
  }
  if (!fs.existsSync(dest)) errors.push(`kit ${action}: ${action === "deactivate" ? "nothing to deactivate (destination does not exist)" : "destination does not exist"}: ${dest}`);
  const manifest = fs.existsSync(dest) ? readOwnedFilesManifest(dest) : null;
  if (fs.existsSync(dest) && !manifest) errors.push(`kit ${action}: no ownership manifest found at ${dest}; built-in kit ${action} requires a manifest-backed claude-code install`);
  if (manifest && manifest.runtime !== "claude-code") errors.push(`kit ${action}: durable ownership manifest at ${dest} belongs to runtime '${manifest.runtime}', not claude-code`);
  const activeResult = fs.existsSync(dest) ? readActiveKitsValidated(dest, root) : { ok: true as const, entries: [] };
  if (!activeResult.ok) errors.push(`kit ${action}: active_kits registry at ${dest} is corrupt, refusing before any change: ${activeResult.errors.join("; ")}`);
  if (errors.length) {
    for (const error of errors) console.error(error);
    return { ok: false, code: action === "deactivate" && !fs.existsSync(dest) && errors.length === 1 ? 3 : errors.some((error) => error.includes("unknown built-in kit")) ? 2 : 1 };
  }
  return { ok: true, activeKits: activeResult.ok ? activeResult.entries : [] };
}

async function runBuiltinKitSet(action: "activate" | "deactivate", argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const dryRun = flagBool(args.flags, "dry-run") ?? false;
  const all = flagBool(args.flags, "all") ?? false;
  if (args.flags["all"] !== undefined && args.flags["all"] !== true) {
    console.error(`kit ${action}: --all does not accept a value`);
    return 2;
  }
  const destResult = resolveBuiltinKitDest(args.flags);
  if (!destResult.ok) { console.error(destResult.error); return 2; }
  if (all && action !== "deactivate") { console.error("kit activate: --all is only supported by kit deactivate"); return 2; }
  if (all && args.positionals.length) { console.error("kit deactivate: --all cannot be combined with kit ids"); return 2; }
  if (!all && !args.positionals.length) { console.error(`${action}: missing <kit-id> argument`); console.error(KIT_USAGE[action]); return 2; }

  if (!all && new Set(args.positionals).size !== args.positionals.length) {
    console.error(`kit ${action}: duplicate kit ids in one invocation are not allowed`);
    return 2;
  }
  const requested = all ? (() => {
    const current = readActiveKitsValidated(destResult.dest, root);
    return current.ok ? current.entries.map((entry) => entry.id) : [];
  })() : [...new Set(args.positionals)];
  const validation = validateBuiltinKitSet(action, requested, destResult.dest);
  if (!validation.ok) return validation.code;
  if (!requested.length) {
    console.log(`kit deactivate: nothing to deactivate at ${destResult.dest}`);
    return 3;
  }

  let ordered: string[];
  try { ordered = orderBuiltinKitSet(requested, action); }
  catch (error) { console.error(`kit ${action}: ${(error as Error).message}`); return 1; }
  const initialActive = activeKitIdSet(validation.activeKits);
  const targetIds = ordered.filter((kitId) => action === "activate" ? !initialActive.has(kitId) : initialActive.has(kitId));
  const skipped = ordered.filter((kitId) => !targetIds.includes(kitId));
  for (const kitId of skipped) console.log(`kit '${kitId}' is already ${action === "activate" ? "active" : "inactive"} at ${destResult.dest}; skipped`);
  if (!targetIds.length) {
    console.log(`kit ${action} set summary: 0 ${dryRun ? "would apply" : "applied"}, ${skipped.length} skipped`);
    return action === "deactivate" ? 3 : 0;
  }

  // A set is a transaction at its validation boundary: discover every member's actual
  // filesystem plan, including containment, before the first member is allowed to write.
  // Do not delegate this to the per-member functions below: doing so makes a bad later member
  // observable only after an earlier member has changed the destination.
  try {
    preflightBuiltinKitSet(action, targetIds, destResult.dest, destResult.global, validation.activeKits, flagBool(args.flags, "force") ?? false);
  } catch (error) {
    console.error(`kit ${action}: refusing whole set before apply: ${(error as Error).message}`);
    return error instanceof BuiltinKitSetPreflightError ? error.exitCode : 1;
  }

  const flagArgv = parsedFlagsArgv(args.flags);
  const completed: string[] = [];
  for (const kitId of targetIds) {
    // Test-only pre-member seam. It runs after set preflight but before this member touches disk,
    // so it retains a validation-class exit and an `untouched` report.
    if (process.env["FLOW_AGENTS_KIT_TEST_FAIL_APPLY_KIT"] === kitId) {
      console.error(`kit '${kitId}': pre-apply validation failed (test-injected failure); remaining kit(s) not attempted`);
      console.log(`kit ${action} set summary: ${completed.length} committed, 1 untouched, ${targetIds.length - completed.length - 1} not attempted`);
      return 1;
    }
    console.log(`kit ${action} '${kitId}' (${completed.length + 1}/${targetIds.length})`);
    let code: number;
    try {
      const injectedCode = process.env["FLOW_AGENTS_KIT_TEST_RETURN_APPLY_CODE"];
      if (injectedCode && injectedCode.startsWith(`${kitId}:`)) {
        code = Number(injectedCode.slice(kitId.length + 1));
      } else {
        code = action === "activate"
          ? await activateBuiltinKit(kitId, flagArgv)
          : await deactivateBuiltinKit(kitId, flagArgv, new Set(targetIds));
      }
    } catch (error) {
      console.error(`kit '${kitId}': apply threw: ${(error as Error).message}`);
      console.log(`kit ${action} set summary: ${completed.length} committed, 1 untouched, ${targetIds.length - completed.length - 1} not attempted`);
      return 1;
    }
    if (code !== 0) {
      const state = code === 4 ? "partially_applied" : "untouched";
      console.error(`kit '${kitId}': apply ${state} with exit ${code}; remaining kit(s) not attempted`);
      console.log(`kit ${action} set summary: ${completed.length} committed, 1 ${state}, ${targetIds.length - completed.length - 1} not attempted`);
      return code === 4 ? 4 : code;
    }
    completed.push(kitId);
  }
  console.log(`kit ${action} set summary: ${completed.length} ${dryRun ? "would apply" : "applied"}, ${skipped.length} skipped`);
  return 0;
}

type ActivateFilePlan = { skillName: string; rel: string; manifestPath: string; srcFile: string; destFile: string };

/**
 * Classify every file a kit's skills would install against the current destination state,
 * BEFORE any copy happens (r1 review HIGH finding: `copyDirMerge` used to overwrite any
 * differing dest file unconditionally, silently clobbering a file `kit deactivate` had just
 * preserved and reported as user-modified).
 *
 * A file is a CONFLICT (preserved, not overwritten, unless `force`) when it exists at dest, its
 * content differs from the incoming bundle content, AND EITHER there is no existing manifest
 * record for it OR the manifest's recorded hash does not match the file's current content -- i.e.
 * it was modified since it was last (or would have been) recorded, exactly uninstall.ts's own
 * "content modified since install (sha256 mismatch)" signal, reused here on the write side. A
 * file whose current content matches what the manifest already recorded is NOT a conflict even
 * though it differs from the new bundle content -- that is an ordinary kit-content update
 * (a newer bundle shipping different skill text), safe to overwrite exactly like a normal
 * reinstall already does.
 */
type ActivateFileConflict = { plan: ActivateFilePlan; reason: string };

function planActivateFiles(
  dest: string,
  skillNames: string[],
  skillsSourceRoot: string,
  skillsDestRoot: string,
  skillsPrefix: string,
  manifestByPath: Map<string, OwnedFileEntry>,
): { toCopy: ActivateFilePlan[]; conflicts: ActivateFileConflict[] } {
  const toCopy: ActivateFilePlan[] = [];
  const conflicts: ActivateFileConflict[] = [];
  for (const name of skillNames) {
    const sourceDir = path.join(skillsSourceRoot, name);
    const destDir = path.join(skillsDestRoot, name);
    const { files } = listOwnedTree(sourceDir);
    for (const rel of files) {
      const srcFile = path.join(sourceDir, ...rel.split("/"));
      const destFile = path.join(destDir, ...rel.split("/"));
      const manifestPath = `${skillsPrefix}/${name}/${rel}`;
      const plan: ActivateFilePlan = { skillName: name, rel, manifestPath, srcFile, destFile };
      // PLAN-TIME containment, reusing assertManifestEntryParentContained -- the exact primitive
      // deactivateBuiltinKit/uninstall.ts use for removal, not a re-implementation -- BEFORE any
      // lstat-based classification below. r2 review HIGH finding: classification used to run off
      // fs.lstatSync(destFile) on the FINAL path component only; if the skill DIRECTORY itself
      // had been replaced by a symlink to a location that does not yet contain the file,
      // lstatSync(destFile) threw ENOENT (nothing exists at the resolved-through-symlink
      // location), silently treated as "ordinary new file, safe to copy" -- the OS transparently
      // resolves a symlinked ancestor, so this check must run unconditionally for every planned
      // file, not only ones that already exist. Throws on the first violation, aborting the WHOLE
      // activate call before any write (propagates to activateBuiltinKit's try/catch) -- exactly
      // how a poisoned manifest entry aborts the whole uninstall/deactivate plan, never partially
      // proceeding on files planned before the bad one.
      assertManifestEntryParentContained(dest, destFile, manifestPath);
      let destStat: fs.Stats | undefined;
      try {
        destStat = fs.lstatSync(destFile);
      } catch {
        destStat = undefined;
      }
      if (!destStat) {
        toCopy.push(plan);
        continue;
      }
      if (destStat.isSymbolicLink() || !destStat.isFile()) {
        conflicts.push({ plan, reason: "existing destination is not a regular file; preserved" });
        continue;
      }
      const destHash = hashFile(destFile);
      const srcHash = hashFile(srcFile);
      if (destHash === srcHash) {
        toCopy.push(plan); // already identical; harmless to (re-)write
        continue;
      }
      const manifestEntry = manifestByPath.get(manifestPath);
      if (manifestEntry && manifestEntry.sha256 === destHash) {
        toCopy.push(plan); // matches what was recorded installed -- an ordinary kit-content update
        continue;
      }
      conflicts.push({ plan, reason: "content modified since install (sha256 mismatch); preserved" });
    }
  }
  return { toCopy, conflicts };
}

/**
 * Write one file, NEVER following a symlink (or any non-regular-file) sitting at `destFile`
 * itself: if one is present, it is unlinked first so a fresh regular file is created AT that
 * exact path, never through it to wherever it points. r2 review HIGH-adjacent finding: `--force`
 * used to fold a symlinked-file conflict straight into a plain `fs.copyFileSync(src, destFile)`,
 * which follows the symlink and overwrites its EXTERNAL target while the CLI reported
 * `overwritten (--force): <in-dest manifest path>` as if the write had landed inside `dest`.
 * Returns whether an existing symlink/non-regular-file was replaced, so the caller can report
 * truthfully what actually happened rather than what was merely planned.
 */
function writeActivateFileNeverFollowingSymlink(plan: ActivateFilePlan): { replacedSymlink: boolean } {
  let existingStat: fs.Stats | undefined;
  try {
    existingStat = fs.lstatSync(plan.destFile);
  } catch {
    existingStat = undefined;
  }
  const replacedSymlink = Boolean(existingStat && (existingStat.isSymbolicLink() || !existingStat.isFile()));
  if (replacedSymlink) fs.rmSync(plan.destFile, { force: true });
  fs.mkdirSync(path.dirname(plan.destFile), { recursive: true });
  fs.copyFileSync(plan.srcFile, plan.destFile);
  return { replacedSymlink };
}

async function activateBuiltinKit(kitId: string, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const dryRun = flagBool(args.flags, "dry-run") ?? false;
  const force = flagBool(args.flags, "force") ?? false;
  const destResult = resolveBuiltinKitDest(args.flags);
  if (!destResult.ok) {
    console.error(destResult.error);
    return 2;
  }
  const { dest, global } = destResult;

  const catalogIds = knownBuiltinKitIds();
  if (!catalogIds.has(kitId)) {
    console.error(unknownBuiltinKitError("activate", kitId));
    return 2;
  }
  if (!fs.existsSync(dest)) {
    console.error(`kit activate: destination does not exist: ${dest}`);
    return 1;
  }
  const manifest = readOwnedFilesManifest(dest);
  if (!manifest) {
    console.error(`kit activate: no ownership manifest found at ${dest}; built-in kit activation requires a manifest-backed claude-code install (run 'flow-agents init --runtime claude-code' first)`);
    return 1;
  }
  if (manifest.runtime !== "claude-code") {
    console.error(`kit activate: durable ownership manifest at ${dest} belongs to runtime '${manifest.runtime}', not claude-code`);
    return 1;
  }

  // Validate the registry BEFORE any filesystem mutation (r1 review MEDIUM finding: a single
  // corrupt/hand-edited entry anywhere in active_kits used to only surface as an unhandled
  // exception thrown by writeActiveKits AFTER files had already been copied).
  const activeKitsResult = readActiveKitsValidated(dest, root);
  if (!activeKitsResult.ok) {
    console.error(`kit activate: active_kits registry at ${dest} is corrupt, refusing before any change: ${activeKitsResult.errors.join("; ")}`);
    return 1;
  }
  const activeKits = activeKitsResult.entries;
  if (activeKits.some((entry) => entry.id === kitId)) {
    console.log(`kit '${kitId}' is already active at ${dest}`);
    return 0;
  }

  const loaded = loadCatalogKitManifest(root, kitId);
  if (!loaded) {
    console.error(`kit activate: could not load kit.json for catalog kit '${kitId}'`);
    return 1;
  }
  const skillNames = catalogKitSkillNames(root, kitId);
  let bundle: string;
  try {
    bundle = resolveClaudeCodeBundleDir();
  } catch (error) {
    console.error(`kit activate: ${(error as Error).message}`);
    return 1;
  }
  const skillsPrefix = skillsPrefixFor(global);
  const skillsDestRoot = path.join(dest, ...skillsPrefix.split("/"));
  const skillsSourceRoot = path.join(bundle, ".claude", "skills");

  const missingSource = skillNames.find((name) => !fs.existsSync(path.join(skillsSourceRoot, name, "SKILL.md")));
  if (missingSource) {
    console.error(`kit activate: kit '${kitId}' declares skill '${missingSource}' but it is missing from the compiled claude-code bundle`);
    return 1;
  }

  const manifestByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  let toCopy: ActivateFilePlan[];
  let conflicts: ActivateFileConflict[];
  try {
    ({ toCopy, conflicts } = planActivateFiles(dest, skillNames, skillsSourceRoot, skillsDestRoot, skillsPrefix, manifestByPath));
  } catch (error) {
    // r2 review HIGH finding: a plan-time containment violation (a symlinked skill directory
    // pointing outside dest) must hard-abort the WHOLE call before any write, naming the entry --
    // never partially proceed on files planned before the bad one.
    console.error(`kit activate: ${(error as Error).message}`);
    return 2;
  }
  // With --force, a conflict is overwritten instead of preserved -- fold it into the copy set.
  const preserved = force ? [] : conflicts;
  const forced = force ? conflicts : [];
  const filesToWrite: ActivateFilePlan[] = [...toCopy, ...forced.map((c) => c.plan)];

  if (dryRun) {
    for (const plan of filesToWrite) console.log(`would copy: ${plan.srcFile} -> ${plan.destFile}`);
    for (const entry of preserved) console.log(`  would preserve: ${entry.plan.manifestPath}  [${entry.reason}]`);
    for (const entry of forced) console.log(`  would overwrite (--force): ${entry.plan.manifestPath}  [${entry.reason}]`);
    console.log(`dry-run: would activate kit '${kitId}' (${skillNames.length} skill(s), ${filesToWrite.length} file(s) to copy, ${preserved.length} preserved) at ${dest}`);
    return 0;
  }

  // Persist ownership immediately after each copy. A member's registry entry is still delayed
  // until all copies finish, but a crash or apply failure can never leave a copied file absent
  // from the ownership manifest that later deactivation relies upon.
  const newManifestEntries: OwnedFileEntry[] = [];
  let manifestAfterCopiedFiles = manifest;
  const applyPreserved: { relPath: string; reason: string }[] = [];
  const replacedSymlinkPaths = new Set<string>();
  let applyFailure: Error | undefined;
  for (const plan of filesToWrite) {
    if (process.env["FLOW_AGENTS_KIT_TEST_FAIL_ACTIVATE_AFTER"] === kitId && newManifestEntries.length > 0) {
      applyFailure = new Error("test-injected activation failure during copy loop");
      break;
    }
    // APPLY-TIME containment re-check (TOCTOU), same class and same reused primitive as
    // deactivateBuiltinKit's own apply-time re-check: violation here does NOT abort the rest of
    // the run (plan-time already ruled out every OTHER entry) -- preserve-not-write this one file
    // and continue, matching uninstall.ts's own apply-vs-plan asymmetry (plan aborts everything;
    // apply preserves just the one entry that changed underneath it).
    try {
      assertManifestEntryParentContained(dest, plan.destFile, plan.manifestPath);
    } catch (error) {
      const reason = error instanceof ManifestContainmentViolationError
        ? "parent directory now resolves outside the install root through a symlink"
        : `could not verify parent directory containment: ${(error as Error).message}`;
      applyPreserved.push({ relPath: plan.manifestPath, reason: `${reason}; preserved (re-checked immediately before write)` });
      continue;
    }
    // r2 review HIGH-adjacent finding: NEVER follow a symlink (or write through any non-regular-
    // file) sitting at the exact destination path -- --force used to fold a symlinked-FILE
    // conflict into a plain fs.copyFileSync, which follows the symlink and overwrites its
    // EXTERNAL target while the report claimed the in-dest manifest path was overwritten.
    try {
      const { replacedSymlink } = writeActivateFileNeverFollowingSymlink(plan);
      if (replacedSymlink) replacedSymlinkPaths.add(plan.manifestPath);
      const copied = { path: plan.manifestPath, sha256: hashFile(plan.destFile) };
      const nextManifest = mergeOwnedFilesManifestEntries(manifestAfterCopiedFiles, [copied]);
      writeOwnedFilesManifest(dest, nextManifest);
      manifestAfterCopiedFiles = nextManifest;
      newManifestEntries.push(copied);
    } catch (error) {
      applyFailure = error instanceof Error ? error : new Error(String(error));
      break;
    }
  }
  if (applyFailure) {
    console.error(`kit activate: '${kitId}' was partially applied after copying ${newManifestEntries.length} file(s): ${applyFailure.message}`);
    for (const entry of newManifestEntries) console.log(`  copied: ${entry.path}`);
    console.log(`kit '${kitId}' remains inactive because activation did not complete`);
    return 4;
  }

  let nextActiveKits: ActiveKitEntry[];
  try {
    const pkgVersion = readPackageVersion(root);
    nextActiveKits = [...activeKits, { id: kitId, version: pkgVersion, activated_at: isoNow(), scope: global ? "global" : "project" }];
    writeActiveKits(dest, root, nextActiveKits);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`kit activate: '${kitId}' was partially applied after copying ${newManifestEntries.length} file(s): active_kits registry was not updated: ${reason}`);
    for (const entry of newManifestEntries) console.log(`  copied: ${entry.path}`);
    console.log(`kit '${kitId}' remains inactive because activation did not complete`);
    return 4;
  }

  console.log(`activated kit '${kitId}' (${skillNames.length} skill(s), ${newManifestEntries.length} file(s) copied) at ${dest}`);
  if (preserved.length) {
    console.log(`${preserved.length} file(s) were user-modified and NOT overwritten (rerun with --force to overwrite):`);
    for (const entry of preserved) console.log(`  preserved: ${entry.plan.manifestPath}  [${entry.reason}]`);
  }
  if (applyPreserved.length) {
    console.log(`${applyPreserved.length} file(s) were preserved due to a containment check immediately before write:`);
    for (const entry of applyPreserved) console.log(`  preserved: ${entry.relPath}  [${entry.reason}]`);
  }
  if (forced.length) {
    // Truthful report (r2 review): say what ACTUALLY happened at write time (recorded in
    // replacedSymlinkPaths), never just restate the plan-time classification reason.
    console.log(`${forced.length} conflicting file(s) were overwritten because --force was given:`);
    for (const entry of forced) {
      const wasPreservedAtApply = applyPreserved.some((p) => p.relPath === entry.plan.manifestPath);
      if (wasPreservedAtApply) continue; // already reported above; --force cannot override a containment violation
      const action = replacedSymlinkPaths.has(entry.plan.manifestPath)
        ? "replaced symlink with a regular file (--force)"
        : "overwritten (--force)";
      console.log(`  ${action}: ${entry.plan.manifestPath}  [${entry.reason}]`);
    }
  }

  // Dependency awareness (non-blocking): suggest, never auto-install.
  const depIds = kitDependencyIds(loaded.manifest, loaded.manifestPath);
  const activeIdSet = new Set(nextActiveKits.map((entry) => entry.id));
  const destArg = global ? "--global" : `--dest ${dest}`;
  for (const dep of depIds) {
    if (!activeIdSet.has(dep)) {
      console.log(`suggestion: kit '${kitId}' declares a dependency on '${dep}' which is not active; consider 'flow-agents kit activate ${dep} ${destArg}'`);
    }
  }
  return 0;
}

type DeactivatePlanEntry = { relPath: string; absPath: string; expectedSha256: string };

/**
 * Classify each planned removal against the CURRENT on-disk state, without mutating anything --
 * the accurate removed/preserved split, shared by `--dry-run` (report only) and the real apply
 * path (report AND actually remove). r1 review MEDIUM finding: `--dry-run` used to print `would
 * remove: X` for every planned entry unconditionally, overclaiming for any file a real run would
 * preserve because it was user-modified -- this is the single source of truth both paths now read
 * from, matching uninstall.ts's own dry-run/apply parity (`dryRunOutcome` there is fed from the
 * same plan-time hash-checked split apply uses, never a separate weaker check).
 */
function classifyDeactivateEntries(planned: DeactivatePlanEntry[]): { toRemove: DeactivatePlanEntry[]; preserved: { relPath: string; reason: string }[] } {
  const toRemove: DeactivatePlanEntry[] = [];
  const preserved: { relPath: string; reason: string }[] = [];
  for (const entry of planned) {
    if (!fs.existsSync(entry.absPath)) {
      toRemove.push(entry); // already gone -- counts as "removed" (no-op) for both dry-run and apply
      continue;
    }
    const stat = fs.lstatSync(entry.absPath);
    if (stat.isSymbolicLink() || !stat.isFile() || hashFile(entry.absPath) !== entry.expectedSha256) {
      preserved.push({ relPath: entry.relPath, reason: "content modified since install (sha256 mismatch); preserved" });
      continue;
    }
    toRemove.push(entry);
  }
  return { toRemove, preserved };
}

class BuiltinKitSetPreflightError extends Error {
  constructor(readonly exitCode: 1 | 2, message: string) { super(message); }
}

/**
 * Build every member's exact pre-apply plan. This deliberately repeats no mutation and keeps
 * the coordinator's set-level refusal independent of the member apply functions' progress.
 * Member failures retain their established CLI class: dependency/set-rule failures are 1 and
 * malformed-manifest or containment failures are 2. When several members refuse, the set exits
 * with the highest class; within that class, the first encountered failure supplies its message.
 */
function preflightBuiltinKitSet(
  action: "activate" | "deactivate",
  kitIds: string[],
  dest: string,
  global: boolean,
  activeKits: ActiveKitEntry[],
  force: boolean,
): void {
  const manifest = readOwnedFilesManifest(dest);
  if (!manifest) throw new BuiltinKitSetPreflightError(1, "ownership manifest disappeared during preflight");
  const failures: BuiltinKitSetPreflightError[] = [];
  const capture = (exitCode: 1 | 2, plan: () => void): void => {
    try {
      plan();
    } catch (error) {
      failures.push(new BuiltinKitSetPreflightError(exitCode, (error as Error).message));
    }
  };
  const throwFailures = (): void => {
    if (!failures.length) return;
    const highestClass = Math.max(...failures.map((failure) => failure.exitCode)) as 1 | 2;
    throw failures.find((failure) => failure.exitCode === highestClass)!;
  };
  const skillsPrefix = skillsPrefixFor(global);
  if (action === "deactivate") {
    const requested = new Set(kitIds);
    // Validate the requested post-state up front: a dependency may disappear only when every
    // active dependent is also in this same requested set (or --force says otherwise).
    for (const kitId of kitIds) {
      const dependents = activeKits.filter((other) => {
        if (other.id === kitId || requested.has(other.id)) return false;
        const loaded = loadCatalogKitManifest(root, other.id);
        return Boolean(loaded && kitDependencyIds(loaded.manifest, loaded.manifestPath).includes(kitId));
      });
      if (dependents.length && !force) failures.push(new BuiltinKitSetPreflightError(1, `'${kitId}' is a dependency of active kit(s): ${dependents.map((entry) => entry.id).join(", ")}`));
    }
    for (const kitId of kitIds) {
      const ownedPrefixes = catalogKitSkillNames(root, kitId).map((name) => `${skillsPrefix}/${name}/`);
      for (const entry of manifest.files.filter((candidate) => ownedPrefixes.some((prefix) => candidate.path.startsWith(prefix)))) {
        // These are the same malformed-manifest/containment plan failures that a single-kit
        // deactivate reports as exit 2.
        capture(2, () => {
          const absPath = resolveManifestEntryPath(dest, entry.path);
          resolveManifestEntrySha256(entry.path, entry.sha256);
          assertManifestEntryParentContained(dest, absPath, entry.path);
        });
      }
    }
    throwFailures();
    return;
  }

  let bundle = "";
  capture(1, () => { bundle = resolveClaudeCodeBundleDir(); });
  if (!bundle) throwFailures();
  const sourceRoot = path.join(bundle, ".claude", "skills");
  const destinationRoot = path.join(dest, ...skillsPrefix.split("/"));
  const manifestByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const kitId of kitIds) {
    const skillNames = catalogKitSkillNames(root, kitId);
    const missing = skillNames.find((name) => !fs.existsSync(path.join(sourceRoot, name, "SKILL.md")));
    if (missing) failures.push(new BuiltinKitSetPreflightError(1, `kit '${kitId}' declares skill '${missing}' but it is missing from the compiled claude-code bundle`));
    // planActivateFiles performs the containment verification before it classifies even a
    // missing destination path, which is the important symlink-ancestor case.
    capture(2, () => { planActivateFiles(dest, skillNames, sourceRoot, destinationRoot, skillsPrefix, manifestByPath); });
  }
  throwFailures();
}

async function deactivateBuiltinKit(kitId: string, argv: string[], requestedDeactivationIds = new Set<string>()): Promise<number> {
  const args = parseArgs(argv);
  const dryRun = flagBool(args.flags, "dry-run") ?? false;
  const force = flagBool(args.flags, "force") ?? false;
  const destResult = resolveBuiltinKitDest(args.flags);
  if (!destResult.ok) {
    console.error(destResult.error);
    return 2;
  }
  const { dest, global } = destResult;

  const catalogIds = knownBuiltinKitIds();
  if (!catalogIds.has(kitId)) {
    console.error(unknownBuiltinKitError("deactivate", kitId));
    return 2;
  }
  if (!fs.existsSync(dest)) {
    console.error(`kit deactivate: nothing to deactivate (destination does not exist): ${dest}`);
    return 3;
  }
  const manifest = readOwnedFilesManifest(dest);
  if (!manifest) {
    console.error(`kit deactivate: no ownership manifest found at ${dest}; built-in kit deactivation requires a manifest-backed claude-code install`);
    return 1;
  }
  // Parity with activateBuiltinKit's own check (r1 review LOW finding). Currently unreachable in
  // practice -- owned-files.json is only ever written on claude-code install paths -- but a
  // future manifest-writing runtime must not silently let deactivate touch its files.
  if (manifest.runtime !== "claude-code") {
    console.error(`kit deactivate: durable ownership manifest at ${dest} belongs to runtime '${manifest.runtime}', not claude-code`);
    return 1;
  }

  // Validate the registry BEFORE any filesystem mutation (same rationale as activateBuiltinKit).
  const activeKitsResult = readActiveKitsValidated(dest, root);
  if (!activeKitsResult.ok) {
    console.error(`kit deactivate: active_kits registry at ${dest} is corrupt, refusing before any change: ${activeKitsResult.errors.join("; ")}`);
    return 1;
  }
  const activeKits = activeKitsResult.entries;
  if (!activeKits.some((entry) => entry.id === kitId)) {
    console.log(`kit '${kitId}' is not active at ${dest}`);
    return 3;
  }

  // Dependency awareness: deactivating a dependency of another ACTIVE kit is blocked unless
  // --force. The dependent kit's own activation record is left untouched either way -- this
  // only warns/blocks removing what it depends on.
  const dependents: string[] = [];
  for (const other of activeKits) {
    if (other.id === kitId) continue;
    // Set semantics are evaluated against the requested post-state. A dependent which is also
    // being deactivated cannot block its dependency; a dependent left active still must.
    if (requestedDeactivationIds.has(other.id)) continue;
    const loadedOther = loadCatalogKitManifest(root, other.id);
    if (!loadedOther) continue;
    if (kitDependencyIds(loadedOther.manifest, loadedOther.manifestPath).includes(kitId)) dependents.push(other.id);
  }
  if (dependents.length && !force) {
    console.error(`kit deactivate: '${kitId}' is a dependency of active kit(s): ${dependents.join(", ")}; rerun with --force to deactivate anyway (their workflows may break)`);
    return 1;
  }
  if (dependents.length && force) {
    console.log(`warning: deactivating '${kitId}' which active kit(s) ${dependents.join(", ")} depend on; those kits' workflows may now be broken`);
  }

  const skillNames = catalogKitSkillNames(root, kitId);
  const skillsPrefix = skillsPrefixFor(global);
  const ownedPrefixes = skillNames.map((name) => `${skillsPrefix}/${name}/`);
  const relevantEntries = manifest.files.filter((entry) => ownedPrefixes.some((prefix) => entry.path.startsWith(prefix)));

  const planned: DeactivatePlanEntry[] = [];
  try {
    for (const entry of relevantEntries) {
      const absPath = resolveManifestEntryPath(dest, entry.path);
      const expectedSha256 = resolveManifestEntrySha256(entry.path, entry.sha256);
      assertManifestEntryParentContained(dest, absPath, entry.path);
      planned.push({ relPath: entry.path, absPath, expectedSha256 });
    }
  } catch (error) {
    // r2 review MEDIUM finding: this plan-time loop's three throwing calls (a malformed manifest
    // path/sha256, or a poisoned entry whose parent resolves outside dest -- e.g. the r2 activate
    // HIGH finding's exact poisoned-manifest byproduct) were previously unguarded, reaching
    // kit.ts's top-level `.catch` and printing a raw Node stack trace with internal file paths.
    // uninstall.ts's own equivalent plan-time call is protected by its caller's try/catch
    // (buildPlan() wrapped in main()); this mirrors that -- a clean, defined CLI error before any
    // removal, matching uninstall.ts's own "malformed manifest entry" exit code (2).
    console.error(`kit deactivate: ${(error as Error).message}`);
    return 2;
  }

  if (dryRun) {
    const { toRemove, preserved } = classifyDeactivateEntries(planned);
    for (const entry of toRemove) console.log(`would remove: ${entry.relPath}`);
    for (const entry of preserved) console.log(`  would preserve: ${entry.relPath}  [${entry.reason}]`);
    console.log(`dry-run: would deactivate kit '${kitId}' (${toRemove.length} file(s) to remove, ${preserved.length} preserved) at ${dest}`);
    return 0;
  }

  // TEST-ONLY hook (mirrors uninstall.ts's FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_SYMLINK_SWAP_*):
  // simulate an external actor swapping a planned entry's parent directory for a symlink escaping
  // `dest` between planning and removal, so the apply-time containment re-check below can be
  // exercised deterministically without racing a real background process. Never read outside this
  // module's own eval fixtures; not part of the public CLI surface.
  const toctouSwapPath = process.env["FLOW_AGENTS_KIT_TEST_TOCTOU_SYMLINK_SWAP_PATH"];
  const toctouSwapTarget = process.env["FLOW_AGENTS_KIT_TEST_TOCTOU_SYMLINK_SWAP_TARGET"];
  if (toctouSwapPath && toctouSwapTarget) {
    fs.rmSync(toctouSwapPath, { recursive: true, force: true });
    fs.symlinkSync(toctouSwapTarget, toctouSwapPath);
  }

  const { toRemove, preserved } = classifyDeactivateEntries(planned);
  const removedRelPaths = new Set<string>();
  const removedParentDirs = new Set<string>();
  const failed: { relPath: string; reason: string }[] = [];
  let removalAttempts = 0;
  for (const entry of toRemove) {
    try {
      if (!fs.existsSync(entry.absPath)) {
        removedRelPaths.add(entry.relPath); // already gone: treat as removed for manifest purposes
        continue;
      }
      // Apply-time re-check #1 (r1 review MEDIUM finding): re-verify the REAL (symlink-resolved)
      // parent directory still sits inside `dest` immediately before touching anything --
      // `owned-files-manifest.ts`'s own docstring for assertManifestEntryParentContained mandates
      // this at BOTH plan time (above) and apply time (here), since an intermediate directory
      // could be swapped for an escaping symlink during the window between the two. Reuses
      // uninstall.ts's exact helper and classification, not a re-implementation.
      try {
        assertManifestEntryParentContained(dest, entry.absPath, entry.relPath);
      } catch (error) {
        const reason = error instanceof ManifestContainmentViolationError
          ? "parent directory now resolves outside the install root through a symlink"
          : `could not verify parent directory containment: ${(error as Error).message}`;
        preserved.push({ relPath: entry.relPath, reason: `${reason}; preserved (re-checked immediately before removal)` });
        continue;
      }
      // Apply-time re-check #2: content hash TOCTOU re-check, same class as uninstall.ts's own
      // apply loop (redundant with classifyDeactivateEntries under normal conditions; exists for
      // the race window between classification and this removal).
      const stat = fs.lstatSync(entry.absPath);
      if (stat.isSymbolicLink() || !stat.isFile() || hashFile(entry.absPath) !== entry.expectedSha256) {
        preserved.push({ relPath: entry.relPath, reason: "content changed since the plan was computed; preserved (re-checked immediately before removal)" });
        continue;
      }
      // Test-only apply-time fault seam. Unlike the old coordinator seam this runs inside a
      // member after earlier files have actually been removed, so it exercises recovery truth.
      if (process.env["FLOW_AGENTS_KIT_TEST_FAIL_REMOVE_AFTER"] === kitId
          && removalAttempts++ > 0) throw new Error("test-injected removal failure during apply");
      fs.rmSync(entry.absPath);
      removedRelPaths.add(entry.relPath);
      removedParentDirs.add(path.dirname(entry.absPath));
    } catch (error) {
      failed.push({ relPath: entry.relPath, reason: (error as Error).message });
    }
  }
  try {
    pruneEmptyDirs(dest, removedParentDirs);
    // The manifest describes the disk, even in a partial member result. The active registry is
    // intentionally NOT advanced to the requested post-state until every removal succeeded.
    writeOwnedFilesManifest(dest, removeOwnedFilesManifestEntries(manifest, removedRelPaths));
  } catch (error) {
    failed.push({ relPath: "ownership manifest", reason: (error as Error).message });
  }

  if (!failed.length) {
    try {
      writeActiveKits(dest, root, activeKits.filter((entry) => entry.id !== kitId));
    } catch (error) {
      failed.push({ relPath: "active_kits registry", reason: (error as Error).message });
    }
  }

  console.log(`deactivated kit '${kitId}': removed ${removedRelPaths.size} file(s), preserved ${preserved.length} modified file(s), failed ${failed.length}`);
  for (const entry of preserved) console.log(`  preserved: ${entry.relPath}  [${entry.reason}]`);
  for (const entry of failed) console.log(`  failed: ${entry.relPath}  [${entry.reason}]`);
  if (failed.length) console.log(`kit '${kitId}' remains registered as active because its filesystem removal was only partially applied`);
  return failed.length > 0 ? 4 : 0;
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
  if (command === "--help" || command === "-h") {
    printKitUsage();
    return 0;
  }
  if (command === "install" && hasHelp(rest)) {
    printCommandUsage("install");
    return 0;
  }
  if (command === "activate" && hasHelp(rest)) {
    printCommandUsage("activate");
    return 0;
  }
  if (command === "deactivate" && hasHelp(rest)) {
    printCommandUsage("deactivate");
    return 0;
  }
  if (command === "validate" && hasHelp(rest)) {
    printCommandUsage("validate");
    return 0;
  }
  if (command === "provision" && hasHelp(rest)) {
    printCommandUsage("provision");
    return 0;
  }
  if (command === "inspect" && hasHelp(rest)) {
    printCommandUsage("inspect");
    return 0;
  }
  if (command === "list" && hasHelp(rest)) {
    printCommandUsage("list");
    return 0;
  }
  if (command === "status" && hasHelp(rest)) {
    printCommandUsage("status");
    return 0;
  }
  if (command === "install") return await install(rest);
  // Legacy sub-subcommands forwarded for backward compatibility within the kit subcommand.
  if (command === "install-local") return await installLocalSource(path.resolve(rest[0] ?? ""), rest);
  if (command === "install-git") return await installGitSource(rest[0] ?? "", rest);
  if (command === "list") return list(rest);
  if (command === "status") return status(rest);
  // `kit activate` overloads on argument shape: a leading non-flag positional is a built-in kit
  // id (the new activation-lifecycle verb); no positional (only flags, e.g. --adapter) is the
  // pre-existing runtime-projection verb. Third-party/local kits have no per-id activation verb
  // (activateCodexLocal/activateStrandsLocal already operate over the whole installed inventory),
  // so this overload is unambiguous: a positional here can only mean a built-in kit id.
  if (command === "activate") {
    const [maybeKitId] = rest;
    if (maybeKitId && !maybeKitId.startsWith("-")) return await runBuiltinKitSet("activate", rest);
    return activate(rest);
  }
  if (command === "deactivate") {
    return await runBuiltinKitSet("deactivate", rest);
  }
  if (command === "validate") return await validate(rest);
  if (command === "provision") return await provision(rest);
  if (command === "inspect") return await inspect(rest);
  console.error("usage: flow-agents kit <install|activate|deactivate|validate|provision|inspect|list|status> ...");
  return 2;
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { main().then((code) => { process.exitCode = code; }).catch((err) => { console.error(err); process.exitCode = 1; }); }
