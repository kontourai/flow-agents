import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertPathsDisjoint, ensureSafeDirectory } from "./lib/fs.js";
import { validateKitRepositoryDiagnostics } from "./flow-kit/validate.js";
import { WORKSPACE_KIT_TREE_SCHEME, WorkspaceArtifactError, captureWorkspaceKitTree, observeWorkspaceKitTree, sealWorkspaceKitTree, createWorkspaceArtifactBudget } from "./flow-kit/workspace-artifact.js";

export type WorkspaceKitStatus = "verified" | "stale-declaration" | "missing" | "corrupt" | "unsupported" | "busy" | "recovery-required";
export interface WorkspaceKitDeclaration {
  schema_version: "1.0";
  selected: string[];
  sources: Record<string, { kind: "local"; alias: string }>;
  options: Record<string, never>;
  provider_bindings: Record<string, never>;
  contributions: "all";
}
export interface WorkspaceKitArtifact {
  kit_id: string;
  scheme: typeof WORKSPACE_KIT_TREE_SCHEME;
  digest: string;
  dependencies: string[];
  manifest_schema_version: "1.0";
  manifest_version?: string;
}
export interface WorkspaceKitLock {
  schema_version: "1.0";
  declaration_digest: string;
  selected: string[];
  artifacts: WorkspaceKitArtifact[];
}
export interface WorkspaceKitResult {
  status: WorkspaceKitStatus;
  scope?: string;
  cache?: string;
  declaration_digest?: string;
  lock_digest?: string;
  lock?: WorkspaceKitLock;
  artifacts: Array<{ kit_id: string; digest: string; status: WorkspaceKitStatus }>;
  diagnostics: Array<{ code: string; message: string }>;
}
export interface WorkspaceKitOptions { scope: string; cache: string }
export interface ResolveWorkspaceKitOptions extends WorkspaceKitOptions { bindings?: Record<string, string>; update?: boolean }
const ID = /^[a-z][a-z0-9-]*$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const DECLARATION = ".flow-agents/workspace.kits.json";
const LOCK = ".flow-agents/workspace.kits.lock.json";
const OPERATION = ".kontourai/flow-agents/workspace-kit.lock";
const MAX_JSON_BYTES = 1024 * 1024;
export class WorkspaceKitError extends Error {
  constructor(readonly status: Exclude<WorkspaceKitStatus, "verified">, readonly code: string, message: string) { super(message); }
}
function refuse(status: Exclude<WorkspaceKitStatus, "verified">, code: string, message: string): never { throw new WorkspaceKitError(status, code, message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("corrupt", "invalid-object", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) refuse("unsupported", "unsupported-field", "Unsupported contract field");
  if (required.some(key => !Object.hasOwn(value, key))) refuse("corrupt", "missing-field", "Missing required contract field");
}
function ids(value: unknown, label: string): string[] {
  if (Array.isArray(value) && value.length > 32) refuse("unsupported", "kit-limit", "Selected closure exceeds 32 Kits");
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !ID.test(id)) || new Set(value).size !== value.length) refuse("corrupt", "invalid-ids", `${label} requires at most 32 unique Kit IDs`);
  return [...value].sort();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: string | Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function encoded(value: unknown): string { return `${canonical(value)}\n`; }
export function parseWorkspaceKitDeclaration(value: unknown): WorkspaceKitDeclaration {
  const obj = object(value, "declaration");
  fields(obj, ["schema_version", "selected", "sources", "options", "provider_bindings", "contributions"]);
  if (obj.schema_version !== "1.0" || obj.contributions !== "all") refuse("unsupported", "unsupported-declaration", "Only schema 1.0 and all contributions are supported");
  for (const field of ["options", "provider_bindings"]) if (Object.keys(object(obj[field], field)).length) refuse("unsupported", "unsupported-configuration", "Workspace v1 accepts empty options and provider bindings only");
  const sources = object(obj.sources, "sources");
  const parsed: WorkspaceKitDeclaration["sources"] = Object.create(null);
  for (const [id, raw] of Object.entries(sources)) {
    const source = object(raw, "source");
    fields(source, ["kind", "alias"]);
    if (!ID.test(id) || source.kind !== "local" || typeof source.alias !== "string" || !ID.test(source.alias)) refuse("unsupported", "unsupported-source", "Sources require a Kit ID and a local alias");
    parsed[id] = { kind: "local", alias: source.alias };
  }
  return { schema_version: "1.0", selected: ids(obj.selected, "selected"), sources: parsed, options: {}, provider_bindings: {}, contributions: "all" };
}
export function parseWorkspaceKitLock(value: unknown): WorkspaceKitLock {
  const obj = object(value, "lock");
  fields(obj, ["schema_version", "declaration_digest", "selected", "artifacts"]);
  if (obj.schema_version !== "1.0") refuse("unsupported", "unsupported-lock", "Unsupported lock schema");
  if (typeof obj.declaration_digest !== "string" || !HASH.test(obj.declaration_digest)) refuse("corrupt", "invalid-digest", "Invalid declaration digest");
  if (Array.isArray(obj.artifacts) && obj.artifacts.length > 32) refuse("unsupported", "kit-limit", "Selected closure exceeds 32 Kits");
  if (!Array.isArray(obj.artifacts)) refuse("corrupt", "invalid-artifacts", "Lock requires at most 32 artifacts");
  const artifacts = obj.artifacts.map((raw): WorkspaceKitArtifact => {
    const item = object(raw, "artifact");
    fields(item, ["kit_id", "scheme", "digest", "dependencies", "manifest_schema_version"], ["manifest_version"]);
    if (item.scheme !== WORKSPACE_KIT_TREE_SCHEME || item.manifest_schema_version !== "1.0") refuse("unsupported", "unsupported-artifact", "Unsupported artifact or manifest scheme");
    if (typeof item.kit_id !== "string" || !ID.test(item.kit_id) || typeof item.digest !== "string" || !HASH.test(item.digest)) refuse("corrupt", "invalid-artifact", "Invalid artifact identity");
    if (item.manifest_version !== undefined && (typeof item.manifest_version !== "string" || !item.manifest_version)) refuse("corrupt", "invalid-version", "Manifest version must be a nonempty string");
    return { kit_id: item.kit_id, scheme: WORKSPACE_KIT_TREE_SCHEME, digest: item.digest, dependencies: ids(item.dependencies, "dependencies"), manifest_schema_version: "1.0" as const, ...(item.manifest_version === undefined ? {} : { manifest_version: item.manifest_version }) };
  });
  const result = { schema_version: "1.0" as const, declaration_digest: obj.declaration_digest, selected: ids(obj.selected, "selected"), artifacts: artifacts.sort((a, b) => a.kit_id < b.kit_id ? -1 : a.kit_id > b.kit_id ? 1 : 0) };
  checkClosure(result);
  return result;
}
function checkClosure(lock: WorkspaceKitLock): void {
  const map = new Map(lock.artifacts.map(item => [item.kit_id, item]));
  if (map.size !== lock.artifacts.length) refuse("corrupt", "duplicate-kit", "A lock may contain only one identity per Kit ID");
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) refuse("corrupt", "dependency-cycle", "Required dependency cycle");
    if (visited.has(id)) return;
    const artifact = map.get(id);
    if (!artifact) refuse("corrupt", "missing-dependency", `Lock omits required Kit ${id}`);
    active.add(id);
    for (const dep of artifact.dependencies) visit(dep);
    active.delete(id); visited.add(id);
  }
  lock.selected.forEach(visit);
  if (visited.size !== map.size) refuse("corrupt", "unselected-artifact", "Lock contains artifacts outside the selected closure");
}
function requirePlatform(): void {
  if (process.platform === "win32" || !(fs.constants.O_NOFOLLOW > 0) || !(fs.constants.O_DIRECTORY > 0)) refuse("unsupported", "artifact-platform", "Workspace Kits v1 requires POSIX no-follow directory and mode semantics");
}
function assertAnchor(root: string, before: fs.Stats): void {
  const current = fs.lstatSync(root);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) refuse("corrupt", "root-changed", "Directory root identity changed during the operation");
}
function rootDirectory(input: string): string {
  if (typeof input !== "string" || !path.isAbsolute(input)) refuse("unsupported", "explicit-root-required", "An explicit absolute directory is required");
  input = path.resolve(input);
  const stat = fs.lstatSync(input);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("corrupt", "unsafe-root", "Root must be an existing nonsymlink directory");
  const canonical = fs.realpathSync(input);
  assertAnchor(canonical, stat);
  return canonical;
}
function confined(root: string, relative: string): string {
  const segments = relative.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index < segments.length - 1 && !stat.isDirectory())) refuse("corrupt", "unsafe-path", "Refusing a symlink or nondirectory path component");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}
function readBytes(file: string, optional = false): Buffer | undefined {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_JSON_BYTES) refuse("corrupt", "invalid-json-file", "Contract JSON must be a regular file of at most 1 MiB");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    const after = fs.fstatSync(fd);
    const visible = fs.lstatSync(file);
    if (offset !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== visible.ino || before.dev !== visible.dev) refuse("corrupt", "changed-input", "Input changed while reading");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function json(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return refuse("corrupt", "invalid-json", "Invalid UTF-8 JSON"); }
}
export function readWorkspaceKitBindings(file: string): Record<string, string> {
  requirePlatform();
  let bytes: Buffer;
  try { bytes = readBytes(path.resolve(file))!; }
  catch (error) {
    if (error instanceof WorkspaceKitError) throw error;
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    refuse(missing ? "missing" : "corrupt", missing ? "missing-bindings" : "invalid-bindings", "Could not read the explicit local bindings file");
  }
  const value = object(json(bytes), "bindings");
  if (Object.entries(value).some(([alias, directory]) => !ID.test(alias) || typeof directory !== "string" || !path.isAbsolute(directory))) refuse("unsupported", "invalid-bindings", "Bindings map local aliases to absolute directories");
  return value as Record<string, string>;
}
function metadata(artifact: WorkspaceKitArtifact): string { return encoded({ schema_version: "1.0", scheme: artifact.scheme, digest: artifact.digest }); }
function entryRelative(artifact: WorkspaceKitArtifact): string { return `artifacts/kit-tree-v1/${artifact.digest.slice(7)}`; }
function markerExists(root: string, relative: string): boolean { return fs.existsSync(confined(root, relative)); }
async function manifestRecord(payload: string, id: string, contentDigest: string): Promise<{ artifact: WorkspaceKitArtifact; warnings: string[] }> {
  const manifest = object(json(readBytes(confined(payload, "kit.json"))!), "manifest");
  if (manifest.schema_version !== "1.0") refuse("unsupported", "unsupported-manifest", "Only container schema 1.0 is supported");
  if (manifest.id !== id) refuse("corrupt", "manifest-id-mismatch", `Manifest must declare ${id}`);
  if (manifest.version !== undefined && (typeof manifest.version !== "string" || !manifest.version)) refuse("corrupt", "invalid-version", "Manifest version must be a nonempty string");
  const dependencies: string[] = [];
  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies)) refuse("corrupt", "invalid-dependencies", "Dependencies must be an array");
    for (const raw of manifest.dependencies) {
      const dep = object(raw, "dependency"); fields(dep, ["kit_id"], ["reason"]);
      if (typeof dep.kit_id !== "string" || !ID.test(dep.kit_id) || dep.kit_id === id || dependencies.includes(dep.kit_id) || (dep.reason !== undefined && typeof dep.reason !== "string")) refuse("corrupt", "invalid-dependency", "Invalid, self or duplicate required dependency");
      dependencies.push(dep.kit_id);
    }
  }
  const diagnostics = await validateKitRepositoryDiagnostics(payload);
  if (diagnostics.errors.length) refuse("corrupt", "invalid-container", diagnostics.errors.slice(0, 3).join("; ").slice(0, 1024));
  return { artifact: { kit_id: id, scheme: WORKSPACE_KIT_TREE_SCHEME, digest: contentDigest, dependencies: dependencies.sort(), manifest_schema_version: "1.0", ...(manifest.version === undefined ? {} : { manifest_version: manifest.version }) }, warnings: diagnostics.warnings };
}
async function verifyArtifact(cache: string, artifact: WorkspaceKitArtifact, budget: ReturnType<typeof createWorkspaceArtifactBudget>, ownPublicationLock = false): Promise<string[]> {
  if (!ownPublicationLock && markerExists(cache, `locks/${artifact.digest.slice(7)}.lock`)) refuse("busy", "artifact-busy", "Artifact publication lock exists; recovery may be required");
  const cacheAnchor = fs.lstatSync(cache);
  const entry = confined(cache, entryRelative(artifact));
  const stat = fs.lstatSync(entry);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("corrupt", "invalid-entry", "Artifact entry is not a directory");
  if (fs.readdirSync(entry).sort().join("\n") !== "artifact.json\npayload") refuse("corrupt", "unaccounted-entry", "Unexpected cache entry members");
  if (readBytes(confined(entry, "artifact.json"))!.toString("utf8") !== metadata(artifact)) refuse("corrupt", "invalid-metadata", "Artifact metadata differs from its content address");
  const payload = confined(entry, "payload");
  const tree = observeWorkspaceKitTree(payload, budget);
  if (`sha256:${tree.digest}` !== artifact.digest) refuse("corrupt", "artifact-digest-mismatch", `Changed cached artifact ${artifact.kit_id}`);
  const observed = await manifestRecord(payload, artifact.kit_id, artifact.digest);
  assertAnchor(cache, cacheAnchor); confined(cache, entryRelative(artifact)); assertAnchor(entry, stat);
  if (`sha256:${observeWorkspaceKitTree(confined(entry, "payload")).digest}` !== artifact.digest) refuse("corrupt", "artifact-changed", "Cached bytes changed during manifest validation");
  if (canonical(observed.artifact) !== canonical(artifact)) refuse("corrupt", "artifact-manifest-mismatch", "Lock record differs from verified manifest");
  return observed.warnings;
}
function appendWarnings(result: WorkspaceKitResult, warnings: string[]): void {
  for (const warning of warnings) {
    if (result.diagnostics.length >= 16) break;
    result.diagnostics.push({ code: "container-warning", message: warning.slice(0, 1024) });
  }
}
function failure(result: WorkspaceKitResult, error: unknown): WorkspaceKitResult {
  if (error instanceof WorkspaceKitError || error instanceof WorkspaceArtifactError) return { ...result, status: error.status, diagnostics: [{ code: error.code, message: error.message.slice(0, 1024) }] };
  const code = (error as NodeJS.ErrnoException).code;
  return { ...result, status: code === "ENOENT" ? "missing" : "corrupt", diagnostics: [{ code: code === "ENOENT" ? "missing-input" : "io-error", message: code === "ENOENT" ? "A required input is missing" : String((error as Error).message).slice(0, 1024) }] };
}
interface Inputs { scope: string; cache: string; scopeAnchor: fs.Stats; cacheAnchor: fs.Stats; declaration: WorkspaceKitDeclaration; declarationBytes: Buffer; lockBytes?: Buffer; lock?: WorkspaceKitLock }
function inputs(options: WorkspaceKitOptions, result: WorkspaceKitResult): Inputs {
  requirePlatform();
  const scope = rootDirectory(options.scope); result.scope = scope;
  const cache = rootDirectory(options.cache); result.cache = cache;
  assertPathsDisjoint(scope, cache);
  const scopeAnchor = fs.lstatSync(scope); const cacheAnchor = fs.lstatSync(cache);
  const declarationBytes = readBytes(confined(scope, DECLARATION))!;
  const declaration = parseWorkspaceKitDeclaration(json(declarationBytes));
  result.declaration_digest = digest(canonical(declaration));
  const lockBytes = readBytes(confined(scope, LOCK), true);
  const lock = lockBytes && parseWorkspaceKitLock(json(lockBytes));
  if (lock) { result.lock_digest = digest(lockBytes!); result.lock = lock; }
  assertAnchor(scope, scopeAnchor); assertAnchor(cache, cacheAnchor);
  return { scope, cache, scopeAnchor, cacheAnchor, declaration, declarationBytes, lockBytes, lock };
}
function initial(): WorkspaceKitResult { return { status: "missing", artifacts: [], diagnostics: [] }; }
export async function inspectWorkspaceKits(options: WorkspaceKitOptions): Promise<WorkspaceKitResult> {
  const result = initial();
  try {
    const input = inputs(options, result);
    if (markerExists(input.scope, OPERATION)) refuse("busy", "scope-busy", "Scope operation lock exists; recovery may be required");
    if (!input.lock) refuse("missing", "missing-lock", "Scope has no resolved lock");
    const budget = createWorkspaceArtifactBudget();
    for (const artifact of input.lock.artifacts) {
      try { appendWarnings(result, await verifyArtifact(input.cache, artifact, budget)); result.artifacts.push({ kit_id: artifact.kit_id, digest: artifact.digest, status: "verified" }); }
      catch (error) { const refused = failure(result, error); result.artifacts.push({ kit_id: artifact.kit_id, digest: artifact.digest, status: refused.status }); throw error; }
    }
    unchanged(input);
    if (markerExists(input.scope, OPERATION)) refuse("busy", "scope-busy", "Scope operation began during inspection");
    if (input.lock.declaration_digest !== result.declaration_digest || canonical(input.lock.selected) !== canonical(input.declaration.selected)) refuse("stale-declaration", "declaration-changed", "Declaration differs from the retained lock; explicit update is required");
    return { ...result, status: "verified" };
  } catch (error) { return failure(result, error); }
}
function lockDirectory(root: string, relative: string): () => void {
  const anchor = fs.lstatSync(root);
  const target = confined(root, relative);
  ensureSafeDirectory(root, path.dirname(target));
  try { fs.mkdirSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") refuse("busy", "operation-busy", "Operation lock exists; no automatic stale-lock reclamation"); throw error; }
  const lockAnchor = fs.lstatSync(target);
  return () => { assertAnchor(root, anchor); confined(root, relative); assertAnchor(target, lockAnchor); fs.rmdirSync(target); };
}
function removeStage(root: string): void {
  if (!fs.existsSync(root)) return;
  const visit = (entry: string): void => {
    const stat = fs.lstatSync(entry);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { fs.chmodSync(entry, 0o755); for (const child of fs.readdirSync(entry)) visit(path.join(entry, child)); }
    else if (stat.isFile()) fs.chmodSync(entry, 0o644);
  };
  visit(root); fs.rmSync(root, { recursive: true });
}
function unchanged(input: Inputs): void {
  assertAnchor(input.scope, input.scopeAnchor); assertAnchor(input.cache, input.cacheAnchor);
  const declaration = readBytes(confined(input.scope, DECLARATION));
  const lock = readBytes(confined(input.scope, LOCK), true);
  if (!declaration?.equals(input.declarationBytes) || (lock === undefined) !== (input.lockBytes === undefined) || (lock && !lock.equals(input.lockBytes!))) refuse("corrupt", "scope-changed", "Declaration or prior lock changed during resolution");
}
export async function resolveWorkspaceKits(options: ResolveWorkspaceKitOptions): Promise<WorkspaceKitResult> {
  const result = initial();
  let outcome = result;
  let releaseScope: (() => void) | undefined;
  let staging: string | undefined;
  let cleanupStage: (() => void) | undefined;
  let temporaryLock: string | undefined;
  let cleanupRoots: (() => void) | undefined;
  try {
    const input = inputs(options, result);
    cleanupRoots = () => { assertAnchor(input.scope, input.scopeAnchor); assertAnchor(input.cache, input.cacheAnchor); };
    releaseScope = lockDirectory(input.scope, OPERATION);
    unchanged(input);
    if (input.lock && !options.update && (input.lock.declaration_digest !== result.declaration_digest || canonical(input.lock.selected) !== canonical(input.declaration.selected))) refuse("stale-declaration", "declaration-changed", "Explicit update is required for changed declaration");
    const budget = createWorkspaceArtifactBudget();
    const records = new Map<string, WorkspaceKitArtifact>();
    const staged = new Map<string, string>();
    const active = new Set<string>();
    const prior = new Map(input.lock?.artifacts.map(item => [item.kit_id, item]) ?? []);
    const sourceRoots = new Map<string, string>();
    const stage = (): string => {
      if (!staging) {
        const parent = ensureSafeDirectory(input.cache, path.join(input.cache, "staging"));
        const ownedStage = fs.mkdtempSync(path.join(parent, "resolve-"));
        const stageAnchor = fs.lstatSync(ownedStage);
        staging = ownedStage;
        cleanupStage = () => {
          confined(input.cache, path.relative(input.cache, ownedStage).split(path.sep).join("/"));
          assertAnchor(ownedStage, stageAnchor);
          removeStage(ownedStage);
        };
      }
      return staging;
    };
    async function visit(id: string): Promise<void> {
      if (active.has(id)) refuse("corrupt", "dependency-cycle", "Required dependency cycle");
      if (records.has(id)) return;
      if (records.size >= 32) refuse("unsupported", "kit-limit", "Selected closure exceeds 32 Kits");
      active.add(id);
      let artifact: WorkspaceKitArtifact | undefined;
      const expected = !options.update ? prior.get(id) : undefined;
      if (expected) {
        try { appendWarnings(result, await verifyArtifact(input.cache, expected, budget)); artifact = expected; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (!artifact) {
        const source = input.declaration.sources[id];
        const binding = source && options.bindings && Object.hasOwn(options.bindings, source.alias) ? options.bindings[source.alias] : undefined;
        if (!source || !binding) refuse("missing", "missing-source-binding", `Explicit source binding required for ${id}`);
        const sourceRoot = rootDirectory(binding);
        assertPathsDisjoint(input.scope, sourceRoot); assertPathsDisjoint(input.cache, sourceRoot);
        for (const [otherId, otherRoot] of sourceRoots) { if (otherId !== id) assertPathsDisjoint(sourceRoot, otherRoot); }
        sourceRoots.set(id, sourceRoot);
        const entry = path.join(stage(), id); fs.mkdirSync(entry);
        const payload = path.join(entry, "payload");
        const tree = captureWorkspaceKitTree(sourceRoot, payload, budget);
        const entryAnchor = fs.lstatSync(entry); const payloadAnchor = fs.lstatSync(payload);
        const inspected = await manifestRecord(payload, id, `sha256:${tree.digest}`);
        assertAnchor(input.cache, input.cacheAnchor); assertAnchor(input.scope, input.scopeAnchor);
        confined(input.cache, path.relative(input.cache, entry).split(path.sep).join("/"));
        assertAnchor(entry, entryAnchor); assertAnchor(payload, payloadAnchor);
        artifact = inspected.artifact; appendWarnings(result, inspected.warnings);
        if (expected && canonical(expected) !== canonical(artifact)) refuse("corrupt", "locked-source-mismatch", "Reacquired bytes differ from the existing lock");
        fs.writeFileSync(path.join(entry, "artifact.json"), metadata(artifact), { flag: "wx", mode: 0o644 });
        sealWorkspaceKitTree(payload);
        if (`sha256:${observeWorkspaceKitTree(payload).digest}` !== artifact.digest) refuse("corrupt", "artifact-changed", "Staged bytes changed during manifest validation");
        fs.chmodSync(path.join(entry, "artifact.json"), 0o444);
        staged.set(id, entry);
      }
      records.set(id, artifact);
      for (const dep of artifact.dependencies) await visit(dep);
      active.delete(id);
    }
    for (const id of input.declaration.selected) await visit(id);
    const lock = parseWorkspaceKitLock({ schema_version: "1.0", declaration_digest: result.declaration_digest, selected: input.declaration.selected, artifacts: [...records.values()] });
    unchanged(input);
    for (const artifact of lock.artifacts) {
      assertAnchor(input.cache, input.cacheAnchor);
      const entry = staged.get(artifact.kit_id);
      if (!entry) continue;
      const relative = entryRelative(artifact);
      const releaseArtifact = lockDirectory(input.cache, `locks/${artifact.digest.slice(7)}.lock`);
      let published = false;
      let sealed = false;
      try {
        const target = confined(input.cache, relative);
        if (fs.existsSync(target)) {
          await verifyArtifact(input.cache, artifact, createWorkspaceArtifactBudget(), true);
          continue;
        }
        ensureSafeDirectory(input.cache, path.dirname(target));
        fs.renameSync(entry, target);
        published = true;
        fs.chmodSync(target, 0o555);
        sealed = true;
      } catch (error) {
        if (published && !sealed) refuse("recovery-required", "publication-seal-failed", "Published entry could not be sealed; its publication marker is retained");
        throw error;
      } finally { if (!published || sealed) releaseArtifact(); }
    }
    unchanged(input);
    const lockFile = confined(input.scope, LOCK);
    if (!input.lockBytes || canonical(input.lock) !== canonical(lock)) {
      temporaryLock = path.join(path.dirname(lockFile), `.workspace.kits.lock.${randomUUID()}.tmp`);
      fs.writeFileSync(temporaryLock, encoded(lock), { flag: "wx", mode: 0o644 });
      unchanged(input);
      fs.renameSync(temporaryLock, lockFile); temporaryLock = undefined;
    }
    result.lock = lock; result.lock_digest = digest(readBytes(lockFile)!);
    result.artifacts = lock.artifacts.map(item => ({ kit_id: item.kit_id, digest: item.digest, status: "verified" }));
    outcome = { ...result, status: "verified" };
  } catch (error) { outcome = failure(result, error); }
  const cleanupErrors: string[] = [];
  for (const cleanup of [
    () => { if (temporaryLock) fs.rmSync(temporaryLock, { force: true }); },
    () => cleanupStage?.(),
    () => releaseScope?.(),
  ]) {
    try { cleanupRoots?.(); cleanup(); } catch (error) { cleanupErrors.push(String((error as Error).message).slice(0, 256)); }
  }
  if (cleanupErrors.length) return { ...outcome, status: "recovery-required", diagnostics: [...outcome.diagnostics, { code: "cleanup-failed", message: cleanupErrors.join("; ") }] };
  return outcome;
}
