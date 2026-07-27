import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { withSubjectLockAsync } from "./assignment-provider.js";
import { validateSchemaValue, type Issue } from "../lib/mini-json-schema.js";

export const WORKER_REPORTED_STATUSES = ["completed", "failed", "blocked"] as const;
export const WAVE_RESULT_STATUSES = [...WORKER_REPORTED_STATUSES, "not_reported"] as const;
export type WorkerReportedStatus = typeof WORKER_REPORTED_STATUSES[number];

export function waveStepOwnsCanonicalStep(definitionId: string, currentStep: string, declaredStep: string): boolean {
  return currentStep === declaredStep
    || (definitionId === "builder.build" && currentStep === "verify" && declaredStep === "review");
}

type JsonRecord = Record<string, unknown>;
type ExpectedWorker = { worker_id: string; task: string; role?: string; owned_files?: string[] };
type WorkerResult = { worker_id: string; status: typeof WAVE_RESULT_STATUSES[number]; summary: string; recorded_at: string; evidence_refs?: JsonRecord[] };
type Wave = { wave_id: string; step: string; declared_at: string; expected_workers: ExpectedWorker[]; worker_results?: WorkerResult[]; reconciliation?: JsonRecord };
type WaveDocument = { schema_version: "1.0"; task_slug: string; waves: Wave[] };
type WaveAuthority = (expectedStep: string) => Promise<void>;
type FileIdentity = { dev: number; ino: number };
type FixedSession = {
  sessionDir: string;
  projectRoot: string;
  kontouraiRoot: string;
  artifactRoot: string;
  assignmentRoot: string;
  slug: string;
  file: string;
  artifactDescriptor?: number;
  artifactIdentity?: FileIdentity;
  sessionDescriptor?: number;
  sessionIdentity?: FileIdentity;
  pinnedDirectories?: Array<{ descriptor: number; identity: FileIdentity; path: string; label: string }>;
};
type LoadedDocument = {
  document: WaveDocument;
  descriptor: number | null;
  identity: FileIdentity | null;
  digest: string | null;
};

const MAX_STATE_BYTES = 1_048_576;
export const MAX_WAVES_BYTES = 4_194_304;
export const MAX_WAVES = 128;
export const MAX_WORKERS_PER_WAVE = 128;
export const MAX_TOTAL_WORKERS = 1_024;
export const MAX_EVIDENCE_REFS = 32;
const MAX_OWNED_FILES = 256;
const MAX_ID_BYTES = 256;
const MAX_STEP_BYTES = 128;
const MAX_ROLE_BYTES = 256;
const MAX_TASK_BYTES = 16_384;
const MAX_SUMMARY_BYTES = 16_384;
const MAX_PATH_BYTES = 4_096;
const MAX_EVIDENCE_REF_BYTES = 65_536;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const safeSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
let cachedSchema: JsonRecord | null = null;

/** Fault seams are test-only; production callers cannot select a path or publication primitive. */
export let workflowWavesTestHooks: {
  beforeCommit?: () => void;
  write?: typeof fs.writeSync;
  afterRename?: () => void;
  directoryFsync?: (descriptor: number) => void;
} = {};
export function setWorkflowWavesTestHooksForTest(hooks: typeof workflowWavesTestHooks): void { workflowWavesTestHooks = hooks; }

export class WaveCommitUncertainError extends Error {
  readonly code = "commit_uncertain";
  readonly candidate_digest: string;
  readonly canonical_readback: "matched" | "unknown";
  readonly recovery = "retry the exact same wave command; exact committed transitions are idempotent";

  constructor(digest: string, readback: "matched" | "unknown", cause: unknown) {
    super(`workflow waves commit_uncertain: canonical publication may have committed; candidate sha256:${digest}; canonical readback ${readback}; ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "WaveCommitUncertainError";
    this.candidate_digest = digest;
    this.canonical_readback = readback;
  }
}

function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function now(): string { return new Date().toISOString(); }
function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }
function identity(stat: fs.Stats): FileIdentity { return { dev: stat.dev, ino: stat.ino }; }
function sameIdentity(stat: fs.Stats, expected: FileIdentity): boolean { return stat.dev === expected.dev && stat.ino === expected.ino; }
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function readDescriptorExactly(descriptor: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (count <= 0) throw new Error("workflow waves protected descriptor ended before its declared size");
    offset += count;
  }
  return bytes;
}

function boundedStringIssue(issues: Issue[], file: string, loc: string, value: unknown, maxBytes: number): void {
  if (typeof value === "string" && byteLength(value) > maxBytes) issues.push({ path: file, message: `${loc} exceeds ${maxBytes} UTF-8 bytes` });
}

function validateWaveResourceBounds(file: string, value: unknown, issues: Issue[]): void {
  const waves = Array.isArray((value as JsonRecord | undefined)?.waves) ? (value as JsonRecord).waves as unknown[] : [];
  if (waves.length > MAX_WAVES) issues.push({ path: file, message: `waves.json.waves exceeds ${MAX_WAVES} waves` });
  let totalWorkers = 0;
  for (const [index, rawWave] of waves.slice(0, MAX_WAVES + 1).entries()) {
    if (!isRecord(rawWave)) continue;
    const loc = `waves.json.waves[${index}]`;
    boundedStringIssue(issues, file, `${loc}.wave_id`, rawWave.wave_id, MAX_ID_BYTES);
    boundedStringIssue(issues, file, `${loc}.step`, rawWave.step, MAX_STEP_BYTES);
    const expected = Array.isArray(rawWave.expected_workers) ? rawWave.expected_workers : [];
    const results = Array.isArray(rawWave.worker_results) ? rawWave.worker_results : [];
    totalWorkers += expected.length;
    if (expected.length > MAX_WORKERS_PER_WAVE) issues.push({ path: file, message: `${loc}.expected_workers exceeds ${MAX_WORKERS_PER_WAVE} workers` });
    if (results.length > MAX_WORKERS_PER_WAVE) issues.push({ path: file, message: `${loc}.worker_results exceeds ${MAX_WORKERS_PER_WAVE} results` });
    for (const [workerIndex, worker] of expected.slice(0, MAX_WORKERS_PER_WAVE + 1).entries()) {
      if (!isRecord(worker)) continue;
      boundedStringIssue(issues, file, `${loc}.expected_workers[${workerIndex}].worker_id`, worker.worker_id, MAX_ID_BYTES);
      boundedStringIssue(issues, file, `${loc}.expected_workers[${workerIndex}].task`, worker.task, MAX_TASK_BYTES);
      boundedStringIssue(issues, file, `${loc}.expected_workers[${workerIndex}].role`, worker.role, MAX_ROLE_BYTES);
      const ownedFiles = Array.isArray(worker.owned_files) ? worker.owned_files : [];
      if (ownedFiles.length > MAX_OWNED_FILES) issues.push({ path: file, message: `${loc}.expected_workers[${workerIndex}].owned_files exceeds ${MAX_OWNED_FILES} files` });
      for (const [fileIndex, ownedFile] of ownedFiles.slice(0, MAX_OWNED_FILES + 1).entries()) boundedStringIssue(issues, file, `${loc}.expected_workers[${workerIndex}].owned_files[${fileIndex}]`, ownedFile, MAX_PATH_BYTES);
    }
    for (const [resultIndex, result] of results.slice(0, MAX_WORKERS_PER_WAVE + 1).entries()) {
      if (!isRecord(result)) continue;
      boundedStringIssue(issues, file, `${loc}.worker_results[${resultIndex}].worker_id`, result.worker_id, MAX_ID_BYTES);
      boundedStringIssue(issues, file, `${loc}.worker_results[${resultIndex}].summary`, result.summary, MAX_SUMMARY_BYTES);
      const refs = Array.isArray(result.evidence_refs) ? result.evidence_refs : [];
      if (refs.length > MAX_EVIDENCE_REFS) issues.push({ path: file, message: `${loc}.worker_results[${resultIndex}].evidence_refs exceeds ${MAX_EVIDENCE_REFS} references` });
      for (const [refIndex, ref] of refs.slice(0, MAX_EVIDENCE_REFS + 1).entries()) {
        if (byteLength(JSON.stringify(ref)) > MAX_EVIDENCE_REF_BYTES) issues.push({ path: file, message: `${loc}.worker_results[${resultIndex}].evidence_refs[${refIndex}] exceeds ${MAX_EVIDENCE_REF_BYTES} JSON bytes` });
      }
    }
    if (isRecord(rawWave.reconciliation)) boundedStringIssue(issues, file, `${loc}.reconciliation.summary`, rawWave.reconciliation.summary, MAX_SUMMARY_BYTES);
  }
  if (totalWorkers > MAX_TOTAL_WORKERS) issues.push({ path: file, message: `waves.json declares more than ${MAX_TOTAL_WORKERS} workers across all waves` });
}

/** Shared semantic authority used by both the writer and the independent artifact validator. */
export function validateWaveSemantics(file: string, value: unknown, issues: Issue[]): void {
  validateWaveResourceBounds(file, value, issues);
  const waves = Array.isArray((value as JsonRecord | undefined)?.waves) ? (value as JsonRecord).waves as unknown[] : [];
  const waveIds = new Set<string>();
  waves.slice(0, MAX_WAVES + 1).forEach((rawWave, index) => {
    const wave = isRecord(rawWave) ? rawWave : {};
    const loc = `waves.json.waves[${index}]`;
    const waveId = typeof wave.wave_id === "string" ? wave.wave_id : "";
    if (waveId) {
      if (waveIds.has(waveId)) issues.push({ path: file, message: `${loc}.wave_id ${waveId} is duplicated; every declared wave_id must be unique` });
      waveIds.add(waveId);
    }
    const expected = Array.isArray(wave.expected_workers) ? wave.expected_workers : [];
    const results = Array.isArray(wave.worker_results) ? wave.worker_results : [];
    const expectedIds = expected.slice(0, MAX_WORKERS_PER_WAVE + 1).map((worker) => isRecord(worker) && typeof worker.worker_id === "string" ? worker.worker_id : "").filter(Boolean);
    const expectedIdSet = new Set(expectedIds);
    if (expectedIdSet.size !== expectedIds.length) issues.push({ path: file, message: `${loc}.expected_workers must declare unique worker_id values` });
    const resultIds = results.slice(0, MAX_WORKERS_PER_WAVE + 1).map((result) => isRecord(result) && typeof result.worker_id === "string" ? result.worker_id : "").filter(Boolean);
    const seen = new Set<string>();
    for (const id of resultIds) {
      if (seen.has(id)) issues.push({ path: file, message: `${loc}.worker_results has more than one terminal status record for worker ${id}; each worker lands exactly one` });
      seen.add(id);
      if (!expectedIdSet.has(id)) issues.push({ path: file, message: `${loc}.worker_results records worker ${id} that is not declared in expected_workers; declare every worker in the manifest before dispatch` });
    }
    const reconciliation = isRecord(wave.reconciliation) ? wave.reconciliation : null;
    if (!reconciliation) return;
    const expectedCount = expectedIds.length;
    const reportedIds = new Set(results.flatMap((result) => isRecord(result)
      && WORKER_REPORTED_STATUSES.includes(result.status as WorkerReportedStatus)
      && typeof result.worker_id === "string" && expectedIdSet.has(result.worker_id) ? [result.worker_id] : []));
    const reportedCount = reportedIds.size;
    if (reconciliation.expected_count !== expectedCount) issues.push({ path: file, message: `${loc}.reconciliation.expected_count is ${String(reconciliation.expected_count)} but expected_workers declares ${expectedCount}` });
    if (reconciliation.reported_count !== reportedCount) issues.push({ path: file, message: `${loc}.reconciliation.reported_count is ${String(reconciliation.reported_count)} but ${reportedCount} of ${expectedCount} expected workers have a worker-landed terminal status (completed|failed|blocked)` });
    const missing = expectedIds.filter((id) => !results.some((result) => isRecord(result) && result.worker_id === id));
    for (const id of missing) issues.push({ path: file, message: `${loc} is reconciled but worker ${id} has no terminal status record; record it explicitly as not_reported — never silently absorb a missing worker` });
    const notReported = results.filter((result) => isRecord(result) && result.status === "not_reported" && typeof result.worker_id === "string" && expectedIdSet.has(result.worker_id));
    if (reconciliation.status === "complete" && (missing.length > 0 || notReported.length > 0 || reportedCount !== expectedCount)) issues.push({ path: file, message: `${loc}.reconciliation.status complete requires every expected worker to have a worker-landed terminal status; got ${reportedCount} of ${expectedCount} reported` });
    if (reconciliation.status === "incomplete" && missing.length === 0 && notReported.length === 0 && reportedCount === expectedCount) issues.push({ path: file, message: `${loc}.reconciliation.status incomplete contradicts the records: all ${expectedCount} expected workers reported` });
  });
}

function schema(): JsonRecord {
  cachedSchema ??= JSON.parse(fs.readFileSync(path.join(packageRoot, "schemas", "workflow-waves.schema.json"), "utf8")) as JsonRecord;
  return cachedSchema;
}

function assertValidDocument(document: unknown): asserts document is WaveDocument {
  const issues: Issue[] = [];
  validateWaveResourceBounds("waves.json", document, issues);
  if (issues.length === 0) {
    const waveSchema = schema();
    validateSchemaValue("waves.json", document, waveSchema, "waves.json", issues, waveSchema);
    validateWaveSemantics("waves.json", document, issues);
  }
  if (issues.length) throw new Error(`waves.json is invalid: ${issues.map((issue) => issue.message).join("; ")}`);
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  if (byteLength(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}

function parseExpectedWorker(value: unknown, index: number): ExpectedWorker {
  if (!isRecord(value)) throw new Error(`--worker-json #${index + 1} must be a JSON object`);
  const allowed = new Set(["worker_id", "task", "role", "owned_files"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`--worker-json #${index + 1} does not support ${unknown}; use worker_id, task, role, and owned_files`);
  const worker: ExpectedWorker = {
    worker_id: requireBoundedString(value.worker_id, `--worker-json #${index + 1}.worker_id`, MAX_ID_BYTES),
    task: requireBoundedString(value.task, `--worker-json #${index + 1}.task`, MAX_TASK_BYTES),
  };
  if (value.role !== undefined) worker.role = requireBoundedString(value.role, `--worker-json #${index + 1}.role`, MAX_ROLE_BYTES);
  if (value.owned_files !== undefined) {
    if (!Array.isArray(value.owned_files) || value.owned_files.length > MAX_OWNED_FILES || value.owned_files.some((file) => typeof file !== "string" || !file || byteLength(file) > MAX_PATH_BYTES)) {
      throw new Error(`--worker-json #${index + 1}.owned_files must contain at most ${MAX_OWNED_FILES} non-empty paths of at most ${MAX_PATH_BYTES} UTF-8 bytes`);
    }
    worker.owned_files = [...value.owned_files];
  }
  return worker;
}

function assertOwnedAndNotWritable(stat: fs.Stats, label: string): void {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && stat.uid !== currentUid) throw new Error(`workflow waves ${label} must be owned by the current runtime user`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`workflow waves ${label} must not be group- or world-writable`);
}

function assertPathIdentity(file: string, expected: FileIdentity, type: "file" | "directory", label: string): void {
  const current = fs.lstatSync(file);
  if (current.isSymbolicLink() || (type === "file" ? !current.isFile() : !current.isDirectory()) || !sameIdentity(current, expected)) {
    throw new Error(`workflow waves ${label} pathname identity changed`);
  }
}

function openStableDirectory(directory: string, label: string, protectedMode = false): { descriptor: number; identity: FileIdentity } {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isDirectory()) throw new Error(`workflow waves ${label} must be a directory`);
    if (protectedMode) assertOwnedAndNotWritable(stat, label);
    const expected = identity(stat);
    assertPathIdentity(directory, expected, "directory", label);
    return { descriptor, identity: expected };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function readProtectedFile(file: string, label: string, maxBytes: number, writerOwned = false): { descriptor: number; identity: FileIdentity; bytes: Buffer } {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`workflow waves ${label} must be a regular file`);
    assertOwnedAndNotWritable(stat, label);
    if (writerOwned && (stat.mode & 0o777) !== 0o600) throw new Error(`workflow waves ${label} must retain writer-owned mode 0600`);
    if (stat.size > maxBytes) throw new Error(`workflow waves ${label} exceeds ${maxBytes} bytes`);
    const expected = identity(stat);
    assertPathIdentity(file, expected, "file", label);
    const bytes = readDescriptorExactly(descriptor, stat.size);
    if (bytes.length !== stat.size || bytes.length > maxBytes) throw new Error(`workflow waves ${label} changed or exceeded ${maxBytes} bytes while reading`);
    assertPathIdentity(file, expected, "file", label);
    return { descriptor, identity: expected, bytes };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

type ProtectedSessionDirectory = { label: string; path: string };

function fixedSessionPaths(sessionDir: string): FixedSession {
  const resolved = path.resolve(sessionDir);
  const artifactRoot = path.dirname(resolved);
  const kontouraiRoot = path.dirname(artifactRoot);
  const projectRoot = path.dirname(kontouraiRoot);
  const assignmentRoot = path.join(artifactRoot, "assignment");
  const slug = path.basename(resolved);
  if (!safeSlug.test(slug) || path.basename(artifactRoot) !== "flow-agents" || path.basename(kontouraiRoot) !== ".kontourai" || path.dirname(resolved) !== artifactRoot) {
    throw new Error("workflow waves requires --session-dir .kontourai/flow-agents/<safe-slug>");
  }
  return { sessionDir: resolved, projectRoot, kontouraiRoot, artifactRoot, assignmentRoot, slug, file: path.join(resolved, "waves.json") };
}

function protectedSessionDirectories(target: FixedSession): ProtectedSessionDirectory[] {
  return [
    { label: "project root", path: target.projectRoot },
    { label: ".kontourai root", path: target.kontouraiRoot },
    { label: "artifact root", path: target.artifactRoot },
    { label: "assignment directory", path: target.assignmentRoot },
    { label: "session directory", path: target.sessionDir },
  ];
}

function assertProtectedSessionDirectories(directories: ProtectedSessionDirectory[]): void {
  for (const { label, path: directory } of directories) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`workflow waves ${label} must be a non-symlink directory`);
    assertOwnedAndNotWritable(stat, label);
  }
}

function assertFixedSessionState(target: FixedSession): void {
  const state = readProtectedFile(path.join(target.sessionDir, "state.json"), "workflow state", MAX_STATE_BYTES);
  try {
    const parsed = JSON.parse(state.bytes.toString("utf8")) as JsonRecord;
    if (parsed.task_slug !== target.slug) throw new Error("workflow waves state.task_slug must exactly match the session directory basename");
  } finally {
    fs.closeSync(state.descriptor);
  }
}

function pinSessionDirectories(target: FixedSession, directories: ProtectedSessionDirectory[]): FixedSession {
  const pinnedDirectories: NonNullable<FixedSession["pinnedDirectories"]> = [];
  try {
    for (const { label, path: directory } of directories) {
      const pinned = openStableDirectory(directory, label, true);
      pinnedDirectories.push({ ...pinned, path: directory, label });
    }
    const artifact = pinnedDirectories.find((entry) => entry.path === target.artifactRoot)!;
    const session = pinnedDirectories.find((entry) => entry.path === target.sessionDir)!;
    return { ...target, artifactDescriptor: artifact.descriptor, artifactIdentity: artifact.identity, sessionDescriptor: session.descriptor, sessionIdentity: session.identity, pinnedDirectories };
  } catch (error) {
    for (const pinned of pinnedDirectories) fs.closeSync(pinned.descriptor);
    throw error;
  }
}

function assertFixedSession(sessionDir: string, pin = false): FixedSession {
  const target = fixedSessionPaths(sessionDir);
  const directories = protectedSessionDirectories(target);
  assertProtectedSessionDirectories(directories);
  assertFixedSessionState(target);
  if (!pin) return target;
  return pinSessionDirectories(target, directories);
}

function assertPinnedSession(target: FixedSession): void {
  for (const pinned of target.pinnedDirectories ?? []) {
    const stat = fs.fstatSync(pinned.descriptor);
    if (!stat.isDirectory() || !sameIdentity(stat, pinned.identity)) {
      throw new Error(`workflow waves pinned ${pinned.label} descriptor identity changed`);
    }
    assertOwnedAndNotWritable(stat, pinned.label);
    assertPathIdentity(pinned.path, pinned.identity, "directory", pinned.label);
  }
}

function loadDocument(target: FixedSession): LoadedDocument {
  try {
    const opened = readProtectedFile(target.file, "waves.json preimage", MAX_WAVES_BYTES, true);
    try {
      const parsed = JSON.parse(opened.bytes.toString("utf8"));
      assertValidDocument(parsed);
      return { document: parsed, descriptor: opened.descriptor, identity: opened.identity, digest: sha256(opened.bytes) };
    } catch (error) {
      fs.closeSync(opened.descriptor);
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { document: { schema_version: "1.0", task_slug: target.slug, waves: [] }, descriptor: null, identity: null, digest: null };
  }
}

function assertBaseline(target: FixedSession, loaded: LoadedDocument): void {
  assertPinnedSession(target);
  if (loaded.descriptor === null) {
    try {
      fs.lstatSync(target.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new Error("workflow waves target appeared after an absent preimage");
  }
  const stat = fs.fstatSync(loaded.descriptor);
  if (!stat.isFile() || !sameIdentity(stat, loaded.identity!)) throw new Error("workflow waves preimage descriptor identity changed");
  assertPathIdentity(target.file, loaded.identity!, "file", "waves.json preimage");
  const bytes = readDescriptorExactly(loaded.descriptor, stat.size);
  if (sha256(bytes) !== loaded.digest) throw new Error("workflow waves preimage bytes changed before commit");
}

function exactCanonicalReadback(target: FixedSession, expected: Buffer, digest: string): boolean {
  try {
    assertPinnedSession(target);
    const opened = readProtectedFile(target.file, "canonical waves.json", MAX_WAVES_BYTES, true);
    try { return opened.bytes.equals(expected) && sha256(opened.bytes) === digest; }
    finally { fs.closeSync(opened.descriptor); }
  } catch {
    return false;
  }
}

function writeCandidateAtomically(target: FixedSession, loaded: LoadedDocument, document: WaveDocument): void {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  if (bytes.length > MAX_WAVES_BYTES) throw new Error(`waves.json candidate exceeds ${MAX_WAVES_BYTES} bytes`);
  const digest = sha256(bytes);
  const temporary = path.join(target.sessionDir, `.waves.json.flow-agents-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let descriptor: number | null = null;
  let renamed = false;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const wrote = (workflowWavesTestHooks.write ?? fs.writeSync)(descriptor, bytes, offset, bytes.length - offset);
      if (!Number.isSafeInteger(wrote) || wrote <= 0) throw new Error("waves.json candidate write made no progress");
      offset += wrote;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    const staged = readProtectedFile(temporary, "staged candidate", MAX_WAVES_BYTES, true);
    try {
      if (!staged.bytes.equals(bytes) || sha256(staged.bytes) !== digest) throw new Error("waves.json candidate reread did not match staged bytes");
    } finally { fs.closeSync(staged.descriptor); }
    workflowWavesTestHooks.beforeCommit?.();
    assertBaseline(target, loaded);
    fs.renameSync(temporary, target.file);
    renamed = true;
    workflowWavesTestHooks.afterRename?.();
    (workflowWavesTestHooks.directoryFsync ?? fs.fsyncSync)(target.sessionDescriptor!);
    if (!exactCanonicalReadback(target, bytes, digest)) throw new Error("canonical waves.json readback did not match the staged candidate");
  } catch (error) {
    if (renamed) throw new WaveCommitUncertainError(digest, exactCanonicalReadback(target, bytes, digest) ? "matched" : "unknown", error);
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (!renamed) {
      try {
        assertPinnedSession(target);
        fs.rmSync(temporary, { force: true });
      } catch { /* retained stage is safer than pathname cleanup after ancestry drift */ }
    }
  }
}

async function mutate(
  sessionDir: string,
  authority: WaveAuthority,
  expectedStep: (document: WaveDocument) => string,
  transition: (document: WaveDocument) => JsonRecord,
): Promise<JsonRecord> {
  const target = assertFixedSession(sessionDir);
  return await withSubjectLockAsync(target.artifactRoot, target.slug, async () => {
    const lockedTarget = assertFixedSession(target.sessionDir, true);
    let loaded: LoadedDocument | null = null;
    try {
      loaded = loadDocument(lockedTarget);
      await authority(expectedStep(loaded.document));
      const report = transition(loaded.document);
      if (report.recovered === true) return report;
      assertValidDocument(loaded.document);
      writeCandidateAtomically(lockedTarget, loaded, loaded.document);
      return report;
    } finally {
      if (loaded?.descriptor !== null && loaded?.descriptor !== undefined) fs.closeSync(loaded.descriptor);
      for (const pinned of lockedTarget.pinnedDirectories ?? []) fs.closeSync(pinned.descriptor);
    }
  });
}

function waveFor(document: WaveDocument, waveId: string, action: string): Wave {
  const wave = document.waves.find((candidate) => candidate.wave_id === waveId);
  if (!wave) throw new Error(`workflow ${action} wave_id ${waveId} is not declared`);
  return wave;
}

export async function declareWave(sessionDir: string, authority: WaveAuthority, input: { wave_id: unknown; step: unknown; workers: unknown[] }): Promise<JsonRecord> {
  const waveId = requireBoundedString(input.wave_id, "--wave-id", MAX_ID_BYTES);
  const step = requireBoundedString(input.step, "--step", MAX_STEP_BYTES);
  if (!Array.isArray(input.workers) || input.workers.length === 0 || input.workers.length > MAX_WORKERS_PER_WAVE) throw new Error(`workflow wave-declare requires 1 through ${MAX_WORKERS_PER_WAVE} --worker-json values`);
  const workers = input.workers.map(parseExpectedWorker);
  if (new Set(workers.map((worker) => worker.worker_id)).size !== workers.length) throw new Error(`workflow wave-declare ${waveId} requires unique worker_id values`);
  return await mutate(sessionDir, authority, () => step, (document) => {
    const existing = document.waves.find((wave) => wave.wave_id === waveId);
    if (existing) {
      if (existing.step === step && isDeepStrictEqual(existing.expected_workers, workers)) return { action: "wave-declare", wave_id: waveId, expected_count: workers.length, recovered: true };
      throw new Error(`workflow wave-declare rejects duplicate wave_id ${waveId}; choose a unique wave id`);
    }
    if (document.waves.length >= MAX_WAVES) throw new Error(`workflow wave-declare cannot exceed ${MAX_WAVES} waves`);
    document.waves.push({ wave_id: waveId, step, declared_at: now(), expected_workers: workers, worker_results: [] });
    return { action: "wave-declare", wave_id: waveId, expected_count: workers.length };
  });
}

export async function recordWaveResult(sessionDir: string, authority: WaveAuthority, input: { wave_id: unknown; worker_id: unknown; status: unknown; summary: unknown; evidence_refs?: unknown[] }): Promise<JsonRecord> {
  const waveId = requireBoundedString(input.wave_id, "--wave-id", MAX_ID_BYTES);
  const workerId = requireBoundedString(input.worker_id, "--worker-id", MAX_ID_BYTES);
  const status = requireBoundedString(input.status, "--status", MAX_ID_BYTES);
  const summary = requireBoundedString(input.summary, "--summary", MAX_SUMMARY_BYTES);
  if (!WORKER_REPORTED_STATUSES.includes(status as WorkerReportedStatus)) throw new Error(`workflow wave-result status ${status} is invalid; use completed, failed, or blocked. not_reported is derived only by wave-reconcile`);
  const evidenceRefs = input.evidence_refs ?? [];
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length > MAX_EVIDENCE_REFS || evidenceRefs.some((ref) => !isRecord(ref) || byteLength(JSON.stringify(ref)) > MAX_EVIDENCE_REF_BYTES)) {
    throw new Error(`--evidence-ref-json accepts at most ${MAX_EVIDENCE_REFS} object values of at most ${MAX_EVIDENCE_REF_BYTES} JSON bytes each`);
  }
  return await mutate(sessionDir, authority, (document) => waveFor(document, waveId, "wave-result").step, (document) => {
    const wave = waveFor(document, waveId, "wave-result");
    if (!wave.expected_workers.some((worker) => worker.worker_id === workerId)) throw new Error(`workflow wave-result worker ${workerId} is not declared for wave ${waveId}`);
    const existing = (wave.worker_results ?? []).find((result) => result.worker_id === workerId);
    if (existing) {
      const exact = existing.status === status && existing.summary === summary && isDeepStrictEqual(existing.evidence_refs ?? [], evidenceRefs);
      if (exact) return { action: "wave-result", wave_id: waveId, worker_id: workerId, status, recovered: true };
      throw new Error(`workflow wave-result worker ${workerId} already has a terminal status record for wave ${waveId}`);
    }
    if (wave.reconciliation) throw new Error(`workflow wave-result wave ${waveId} is already reconciled; declare a follow-up wave instead of changing closed results`);
    (wave.worker_results ??= []).push({ worker_id: workerId, status: status as WorkerReportedStatus, summary, recorded_at: now(), ...(evidenceRefs.length ? { evidence_refs: evidenceRefs as JsonRecord[] } : {}) });
    return { action: "wave-result", wave_id: waveId, worker_id: workerId, status };
  });
}

function reconciliationProjection(wave: Wave): { status: "complete" | "incomplete"; expectedCount: number; reportedCount: number; missing: string[]; summary: string } {
  const results = wave.worker_results ?? [];
  const missing = wave.expected_workers.filter((worker) => !results.some((result) => result.worker_id === worker.worker_id)).map((worker) => worker.worker_id);
  const reportedCount = results.filter((result) => WORKER_REPORTED_STATUSES.includes(result.status as WorkerReportedStatus)).length;
  const expectedCount = wave.expected_workers.length;
  return {
    status: missing.length === 0 && !results.some((result) => result.status === "not_reported") ? "complete" : "incomplete",
    expectedCount,
    reportedCount,
    missing,
    summary: missing.length ? `${reportedCount} of ${expectedCount} reported; ${missing.join(", ")} not_reported` : `${reportedCount} of ${expectedCount} reported`,
  };
}

export async function reconcileWave(sessionDir: string, authority: WaveAuthority, input: { wave_id: unknown }): Promise<JsonRecord> {
  const waveId = requireBoundedString(input.wave_id, "--wave-id", MAX_ID_BYTES);
  return await mutate(sessionDir, authority, (document) => waveFor(document, waveId, "wave-reconcile").step, (document) => {
    const wave = waveFor(document, waveId, "wave-reconcile");
    if (wave.reconciliation) {
      const existingMissing = (wave.worker_results ?? []).filter((result) => result.status === "not_reported").map((result) => result.worker_id);
      return {
        action: "wave-reconcile",
        wave_id: waveId,
        status: wave.reconciliation.status,
        expected_count: wave.reconciliation.expected_count,
        reported_count: wave.reconciliation.reported_count,
        not_reported: existingMissing,
        recovered: true,
      };
    }
    const projection = reconciliationProjection(wave);
    const results = wave.worker_results ?? (wave.worker_results = []);
    for (const workerId of projection.missing) results.push({ worker_id: workerId, status: "not_reported", summary: `Worker ${workerId} did not report before reconciliation.`, recorded_at: now() });
    wave.reconciliation = { status: projection.status, expected_count: projection.expectedCount, reported_count: projection.reportedCount, summary: projection.summary, reconciled_at: now() };
    return { action: "wave-reconcile", wave_id: waveId, status: projection.status, expected_count: projection.expectedCount, reported_count: projection.reportedCount, not_reported: projection.missing };
  });
}
