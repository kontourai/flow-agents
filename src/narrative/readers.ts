import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assertPathContained } from "../lib/fs.js";
import type { UnavailableReason } from "./integrity.js";

interface CommandLogChainPrimitives {
  CHAIN_GENESIS: string;
  computeChainHash(previousHash: string, record: Record<string, unknown>): string;
}

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const commandLogChain = require(path.resolve(moduleDir, "../../../scripts/lib/command-log-chain.js")) as CommandLogChainPrimitives;

export class NarrativeReaderError extends Error {
  readonly name = "NarrativeReaderError";

  constructor(
    readonly reason: UnavailableReason,
    readonly source: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ReadCandidate<T = unknown> {
  file: string;
  raw: Buffer;
  record: T;
  lineIndex?: number;
  originPackage?: { name: string; version: string };
}

function readerError(reason: UnavailableReason, source: string, message: string): never {
  throw new NarrativeReaderError(reason, source, message);
}

function assertSafeRoot(root: string, source: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return readerError("not_captured", source, `${source} root was not captured`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return readerError("corrupt", source, `${source} root must be a non-symlink directory`);
}

function assertSafePathBelowRoot(root: string, file: string, source: string): void {
  assertSafeRoot(root, source);
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return readerError("unauthorized", source, `${source} path escapes its explicit root`);
  let current = path.resolve(root);
  for (const component of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, component);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return readerError("corrupt", source, `${source} path contains a symlink`);
  }
  try {
    assertPathContained(root, file);
  } catch {
    return readerError("unauthorized", source, `${source} path escapes its explicit root`);
  }
}

function readRegularFileBytes(file: string, source: string): Buffer {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return readerError("not_captured", source, `${source} was not captured`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return readerError("corrupt", source, `${source} must be a non-symlink regular file`);
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    return readerError("corrupt", source, `${source} could not be opened without following links`);
  }
  try {
    const opened = fs.fstatSync(fd);
    // The descriptor must be the same inode the pre-open lstat admitted;
    // a swap between the checks reads as corruption, not as the new file.
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return readerError("corrupt", source, `${source} changed between validation and read`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function nonEmptyLines(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 0x0a) continue;
    let end = index;
    if (end > start && bytes[end - 1] === 0x0d) end -= 1;
    const line = bytes.subarray(start, end);
    if (line.toString("utf8").trim()) lines.push(Buffer.from(line));
    start = index + 1;
  }
  return lines;
}

function parseObject(raw: Buffer, source: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return readerError("corrupt", source, `${source} record must be a JSON object`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof NarrativeReaderError) throw error;
    return readerError("corrupt", source, `${source} contains malformed JSON`);
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha8(bytes: Buffer): string {
  return sha256(bytes).slice(0, 8);
}

function telemetryFiles(telemetryDir: string, channel: string): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(channel)) return readerError("unauthorized", "telemetry", "telemetry channel is invalid");
  assertSafeRoot(telemetryDir, "telemetry");
  const currentName = `${channel}.jsonl`;
  let names: string[];
  try {
    names = fs.readdirSync(telemetryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rotated = names
    .map((name) => ({ name, match: new RegExp(`^${channel}\\.([1-9][0-9]*)\\.jsonl$`).exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .map((entry) => entry.name);
  return [currentName, ...rotated].filter((name) => names.includes(name)).map((name) => path.join(telemetryDir, name));
}

export function readTelemetryCandidates(input: {
  telemetryDir: string;
  channel: string;
  sessionId: string;
  eventId: string;
  sha8: string;
  ordinal?: number;
}): ReadCandidate<Record<string, unknown>>[] {
  const idMatches: ReadCandidate<Record<string, unknown>>[] = [];
  for (const file of telemetryFiles(input.telemetryDir, input.channel)) {
    const lines = nonEmptyLines(readRegularFileBytes(file, "telemetry log"));
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const raw = lines[lineIndex];
      const record = parseObject(raw, "telemetry log");
      if (record["session_id"] === input.sessionId && record["event_id"] === input.eventId) idMatches.push({ file, raw, record, lineIndex });
    }
  }
  // The content pin decides which record the id names. Records sharing the
  // event id but not the pinned content are rebind attempts, never candidates.
  const matches = idMatches.filter((candidate) => sha8(candidate.raw) === input.sha8);
  if (idMatches.length > 0 && matches.length === 0) return readerError("corrupt", "telemetry", "telemetry content pin does not match any record with this event id");
  if (input.ordinal === undefined) return matches;
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) return readerError("corrupt", "telemetry", "telemetry ordinal is invalid");
  const selected = matches[input.ordinal];
  if (!selected) return readerError("not_captured", "telemetry", "telemetry ordinal was not captured");
  return [selected];
}

interface ChainLink {
  seq?: unknown;
  prevHash?: unknown;
  hash?: unknown;
}

function verifiedCommandLogEntries(lines: Buffer[]): Array<{ raw: Buffer; record: Record<string, unknown> }> {
  const entries = lines.map((raw) => ({ raw, record: parseObject(raw, "command log") }));
  const reachable = new Set([commandLogChain.CHAIN_GENESIS]);
  // Mirrors the canonical fork classification in scripts/hooks/stop-goal-fit.js:
  // a parent claimed by more than one entry is benign only when EVERY sibling is
  // a PostToolUse capture racing on the same tip; any non-capture sibling is
  // structural tamper and poisons the whole log for citation purposes.
  const parentSources = new Map<string, string[]>();
  let chainStarted = false;
  for (const entry of entries) {
    const chain = entry.record["_chain"] as ChainLink | undefined;
    if (!chain || typeof chain.hash !== "string") {
      if (chainStarted) return readerError("corrupt", "command log", "command log contains an unchained entry after its chain begins");
      continue;
    }
    chainStarted = true;
    if (!Number.isSafeInteger(chain.seq) || typeof chain.prevHash !== "string") return readerError("corrupt", "command log", "command log chain metadata is malformed");
    if (commandLogChain.computeChainHash(chain.prevHash, entry.record) !== chain.hash || !reachable.has(chain.prevHash)) {
      return readerError("corrupt", "command log", "command log chain verification failed");
    }
    const siblings = parentSources.get(chain.prevHash) ?? [];
    siblings.push(String(entry.record["source"] ?? ""));
    parentSources.set(chain.prevHash, siblings);
    if (siblings.length > 1 && !siblings.every((source) => source === "postToolUse-capture")) {
      return readerError("corrupt", "command log", "command log chain contains a non-capture fork sibling");
    }
    reachable.add(chain.hash);
  }
  return entries;
}

export function readCommandLogCandidate(input: {
  sessionDir: string;
  locator: { kind: "chained"; seq: number; hash8: string } | { kind: "legacy"; line: number; sha8: string };
}): ReadCandidate<Record<string, unknown>> {
  const file = path.join(input.sessionDir, "command-log.jsonl");
  assertSafePathBelowRoot(input.sessionDir, file, "command log");
  const lines = nonEmptyLines(readRegularFileBytes(file, "command log"));
  if (input.locator.kind === "legacy") {
    const raw = lines[input.locator.line - 1];
    if (!raw) return readerError("not_captured", "command log", "legacy command-log line was not captured");
    if (sha8(raw) !== input.locator.sha8) return readerError("corrupt", "command log", "legacy command-log line hash pin does not match");
    return { file, raw, record: parseObject(raw, "command log"), lineIndex: input.locator.line - 1 };
  }

  const locator = input.locator;
  const entries = verifiedCommandLogEntries(lines);
  const found = entries.find((entry) => {
    const chain = entry.record["_chain"] as ChainLink | undefined;
    return chain?.seq === locator.seq && typeof chain.hash === "string" && chain.hash.slice(0, 8) === locator.hash8;
  });
  if (!found) return readerError("not_captured", "command log", "chained command-log entry was not captured with the requested pin");
  return { file, ...found, lineIndex: entries.indexOf(found) };
}

export function readAgentEventCandidate(input: {
  sessionDir: string;
  agentId: string;
  lineIndex: number;
  sha8: string;
  delegation?: boolean;
}): ReadCandidate<Record<string, unknown>> {
  if (!input.agentId || input.agentId.includes("/") || input.agentId.includes("\\")) return readerError("unauthorized", "agent event", "agent id is invalid");
  const file = path.join(input.sessionDir, "agents", input.agentId, "events.jsonl");
  assertSafePathBelowRoot(input.sessionDir, file, "agent event");
  const lines = nonEmptyLines(readRegularFileBytes(file, "agent event log"));
  const raw = lines[input.lineIndex];
  if (!raw) return readerError("not_captured", "agent event", "agent event line was not captured");
  if (sha8(raw) !== input.sha8) return readerError("corrupt", "agent event", "agent event line hash pin does not match");
  const record = parseObject(raw, "agent event");
  if (input.delegation && record["kind"] !== "delegation") return readerError("corrupt", "delegation", "pinned agent event is not a delegation");
  return { file, raw, record, lineIndex: input.lineIndex };
}

export function readDelegationCandidate(input: Omit<Parameters<typeof readAgentEventCandidate>[0], "delegation">): ReadCandidate<Record<string, unknown>> {
  return readAgentEventCandidate({ ...input, delegation: true });
}

export function readTrustCandidate(input: {
  sessionDir: string;
  bundleSha8: string;
  id: string;
  kind: "claim" | "evidence";
}): ReadCandidate<Record<string, unknown>> {
  const file = path.join(input.sessionDir, "trust.bundle");
  assertSafePathBelowRoot(input.sessionDir, file, "trust bundle");
  const rawBundle = readRegularFileBytes(file, "trust bundle");
  if (sha8(rawBundle) !== input.bundleSha8) return readerError("corrupt", "trust bundle", "trust bundle hash pin does not match");
  const bundle = parseObject(rawBundle, "trust bundle");
  const collectionName = input.kind === "claim" ? "claims" : "evidence";
  const collection = bundle[collectionName];
  if (!Array.isArray(collection)) return readerError("corrupt", "trust bundle", `trust bundle ${collectionName} is malformed`);
  const records = collection.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry) && entry["id"] === input.id);
  if (records.length === 0) return readerError("not_captured", `trust ${input.kind}`, `trust ${input.kind} was not captured`);
  if (records.length !== 1) return readerError("corrupt", `trust ${input.kind}`, `trust ${input.kind} id is not unique`);
  const record = records[0];
  return { file, raw: Buffer.from(JSON.stringify(record)), record };
}

export function readTrustClaimCandidate(input: Omit<Parameters<typeof readTrustCandidate>[0], "kind">): ReadCandidate<Record<string, unknown>> {
  return readTrustCandidate({ ...input, kind: "claim" });
}

export function readTrustEvidenceCandidate(input: Omit<Parameters<typeof readTrustCandidate>[0], "kind">): ReadCandidate<Record<string, unknown>> {
  return readTrustCandidate({ ...input, kind: "evidence" });
}

function readFlowState(flowRoot: string, runId: string): { file: string; raw: Buffer; state: Record<string, unknown> } {
  if (!runId || runId.includes("/") || runId.includes("\\")) return readerError("unauthorized", "flow run", "flow run id is invalid");
  const file = path.join(flowRoot, "runs", runId, "state.json");
  assertSafePathBelowRoot(flowRoot, file, "flow run");
  const raw = readRegularFileBytes(file, "flow run state");
  const state = parseObject(raw, "flow run state");
  if (state["run_id"] !== runId) return readerError("corrupt", "flow run state", "flow state run id does not match its directory");
  return { file, raw, state };
}

export function readFlowStateCandidate(input: { flowRoot: string; runId: string; sha8: string }): ReadCandidate<Record<string, unknown>> {
  const { file, raw, state } = readFlowState(input.flowRoot, input.runId);
  if (sha8(raw) !== input.sha8) return readerError("corrupt", "flow run state", "flow state hash pin does not match");
  return { file, raw, record: state };
}

export function readFlowReportCandidate(input: { flowRoot: string; runId: string; sha8: string }): ReadCandidate<Record<string, unknown>> {
  if (!input.runId || input.runId.includes("/") || input.runId.includes("\\")) return readerError("unauthorized", "flow report", "flow run id is invalid");
  const file = path.join(input.flowRoot, "runs", input.runId, "report.json");
  assertSafePathBelowRoot(input.flowRoot, file, "flow run");
  const raw = readRegularFileBytes(file, "flow report");
  if (sha8(raw) !== input.sha8) return readerError("corrupt", "flow report", "flow report hash pin does not match");
  return { file, raw, record: parseObject(raw, "flow report") };
}

interface SurfaceModule {
  buildTrustReport(bundle: Record<string, unknown>): unknown;
  explainClaim(report: unknown, claimId: string): unknown;
}

let surfaceModule: { api: SurfaceModule; version: string } | null | undefined;

function tryLoadSurface(): { api: SurfaceModule; version: string } | null {
  if (process.env.FLOW_AGENTS_SURFACE_UNAVAILABLE === "1") return null;
  if (surfaceModule !== undefined) return surfaceModule;
  try {
    // snapshotNarrative is intentionally synchronous. Node >=22 can require an
    // ESM module synchronously, preserving that public contract while loading
    // Surface only when this stream is actually captured.
    const entry = fileURLToPath(import.meta.resolve("@kontourai/surface"));
    const api = require(entry) as SurfaceModule;
    const packageFile = path.resolve(path.dirname(entry), "../../package.json");
    const metadata = parseObject(fs.readFileSync(packageFile), "surface package metadata");
    const version = typeof metadata["version"] === "string" ? metadata["version"] : "unknown";
    if (typeof api.buildTrustReport !== "function" || typeof api.explainClaim !== "function") {
      surfaceModule = null;
    } else {
      surfaceModule = { api, version };
    }
  } catch {
    surfaceModule = null;
  }
  return surfaceModule;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  }, 2);
}

export function readSurfaceExplanationCandidate(input: {
  sessionDir: string;
  bundleSha8: string;
  claimId: string;
}): ReadCandidate<Record<string, unknown>> {
  const file = path.join(input.sessionDir, "trust.bundle");
  assertSafePathBelowRoot(input.sessionDir, file, "trust bundle");
  const rawBundle = readRegularFileBytes(file, "trust bundle");
  if (sha8(rawBundle) !== input.bundleSha8) return readerError("corrupt", "surface explanation", "trust bundle hash pin does not match");
  const bundle = parseObject(rawBundle, "trust bundle");
  const claims = bundle["claims"];
  if (!Array.isArray(claims)) return readerError("corrupt", "surface explanation", "trust bundle claims are malformed");
  const matchingClaims = claims.filter((claim) => !!claim && typeof claim === "object" && !Array.isArray(claim) && (claim as Record<string, unknown>)["id"] === input.claimId);
  if (matchingClaims.length === 0) return readerError("not_captured", "surface explanation", "surface claim was not captured");
  if (matchingClaims.length !== 1) return readerError("corrupt", "surface explanation", "surface claim id is not unique");
  const surface = tryLoadSurface();
  if (!surface) return readerError("not_captured", "surface explanation", "@kontourai/surface is unavailable");
  let explanation: unknown;
  try {
    // Flow Agents trust.bundle predates Surface's camel-case schema field and
    // may omit empty collections. Supply only those structural compatibility
    // defaults; Surface still owns all report and explanation derivation.
    const surfaceBundle = {
      ...bundle,
      schemaVersion: bundle["schemaVersion"] ?? bundle["schema_version"],
      source: bundle["source"] ?? "flow-agents:trust.bundle",
      policies: bundle["policies"] ?? [],
      events: bundle["events"] ?? [],
    };
    const report = surface.api.buildTrustReport(surfaceBundle);
    explanation = surface.api.explainClaim(report, input.claimId);
  } catch {
    return readerError("not_captured", "surface explanation", "surface claim explanation could not be produced");
  }
  // explainClaim is deliberately fail-soft: a found:false result remains the
  // authority-owned explanation and is frozen rather than treated as absence.
  if (!explanation || typeof explanation !== "object" || Array.isArray(explanation)) {
    return readerError("corrupt", "surface explanation", "surface returned a malformed claim explanation");
  }
  const record = explanation as Record<string, unknown>;
  const raw = Buffer.from(stableStringify(record));
  return { file, raw, record, originPackage: { name: "@kontourai/surface", version: surface.version } };
}

export function readFlowTransitionCandidate(input: { flowRoot: string; runId: string; index: number; sha8: string }): ReadCandidate<Record<string, unknown>> {
  const { file, state } = readFlowState(input.flowRoot, input.runId);
  const transitions = state["transitions"];
  if (!Array.isArray(transitions)) return readerError("corrupt", "flow transition", "flow transitions are malformed");
  const record = transitions[input.index];
  if (!record || typeof record !== "object" || Array.isArray(record)) return readerError("not_captured", "flow transition", "flow transition was not captured");
  const raw = Buffer.from(JSON.stringify(record));
  if (sha8(raw) !== input.sha8) return readerError("corrupt", "flow transition", "flow transition hash pin does not match");
  return { file, raw, record: record as Record<string, unknown>, lineIndex: input.index };
}

export function readTranscriptCandidate(input: { absolutePath: string; byteStart: number; byteEnd: number }): Buffer {
  if (!path.isAbsolute(input.absolutePath)) return readerError("unauthorized", "transcript", "transcript path must be absolute");
  const bytes = readRegularFileBytes(input.absolutePath, "transcript");
  if (!Number.isSafeInteger(input.byteStart) || !Number.isSafeInteger(input.byteEnd) || input.byteStart < 0 || input.byteEnd < input.byteStart || input.byteEnd > bytes.length) {
    return readerError("corrupt", "transcript", "transcript byte range is invalid");
  }
  return Buffer.from(bytes.subarray(input.byteStart, input.byteEnd));
}

function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function readFileCandidate(input: { repoRoot: string; repoRelativePath: string; hash: string }): ReadCandidate<Buffer> {
  if (path.isAbsolute(input.repoRelativePath)) return readerError("unauthorized", "file", "file path must be repository-relative");
  const file = path.resolve(input.repoRoot, input.repoRelativePath);
  assertSafePathBelowRoot(input.repoRoot, file, "file");
  const raw = readRegularFileBytes(file, "file source");
  const actual = input.hash.length === 64 ? sha256(raw) : input.hash.length === 40 ? gitBlobSha(raw) : "";
  if (!actual || actual !== input.hash) return readerError("corrupt", "file", "file hash pin does not match");
  return { file, raw, record: raw };
}
