import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import type { ObservedProcessResult } from "./observed-command.js";
import { execTrustedGitSync } from "./trusted-git.js";

export const COORDINATED_COMMAND_RECEIPT_PROTOCOL = "flow-agents.coordinated-command-receipt/v1";

export type CoordinatedCommandBinding = {
  command: string;
  lane_id: string;
  entrypoint: string;
  argv: string[];
};

export type CoordinatedCommandReceiptProof = {
  kind: "coordinated-command-receipt";
  protocol: typeof COORDINATED_COMMAND_RECEIPT_PROTOCOL;
  request_key: string;
  receipt_sha256: string;
  receipt_commit_sha256: string;
};

type JsonRecord = Record<string, unknown>;

function normalized(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function currentWorkspaceBinding(projectRoot: string): { head_sha: string; workspace_digest: string } {
  const root = fs.realpathSync(projectRoot);
  const git = (args: string[]): Buffer => execTrustedGitSync(root, args, "buffer", 64 * 1024 * 1024) as Buffer;
  const gitRoot = fs.realpathSync(git(["rev-parse", "--show-toplevel"]).toString("utf8").trim());
  if (gitRoot !== root) throw new Error("coordinated receipt project root must be the Git worktree root");
  const headSha = git(["rev-parse", "HEAD"]).toString("utf8").trim();
  if (!/^[a-f0-9]{40}$/.test(headSha)) throw new Error("coordinated receipt Git head is invalid");
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean).sort();
  const digest = createHash("sha256").update(git(["diff", "--binary", "HEAD", "--"]));
  for (const relative of untracked) {
    const file = path.resolve(root, relative);
    if (path.relative(root, file).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(root, file))) throw new Error("coordinated receipt untracked workspace path escapes the Git root");
    const before = fs.lstatSync(file);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("coordinated receipt untracked workspace input is not a regular file");
    const bytes = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("coordinated receipt untracked workspace input changed while reading");
    digest.update("\0").update(relative).update("\0").update(bytes);
  }
  return { head_sha: headSha, workspace_digest: digest.digest("hex") };
}

function regularProjectFile(projectRoot: string, relative: string): string | null {
  if (!relative || path.isAbsolute(relative)) return null;
  const normalizedPath = path.posix.normalize(relative.replaceAll("\\", "/"));
  if (normalizedPath === "." || normalizedPath === ".." || normalizedPath.startsWith("../")) return null;
  const candidate = path.resolve(projectRoot, normalizedPath);
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const root = fs.realpathSync(projectRoot);
    const real = fs.realpathSync(candidate);
    const relativeReal = path.relative(root, real);
    return relativeReal && !relativeReal.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeReal) ? real : null;
  } catch {
    return null;
  }
}

function npmScriptName(command: string): string | null {
  const tokens = normalized(command).split(" ");
  if (tokens[0] !== "npm") return null;
  if (tokens[1] === "run" || tokens[1] === "run-script") return tokens.length === 3 ? tokens[2]! : null;
  return tokens.length === 2 ? tokens[1]! : null;
}

/**
 * Admit only a declared public command that delegates directly to one local Node
 * coordinator. This intentionally names neither a product nor a coordinator
 * filename: the receipt, not the filename, is the run-time proof.
 */
export function resolveCoordinatedCommandBinding(command: string, projectRoot: string): CoordinatedCommandBinding | null {
  const exactCommand = normalized(command);
  const scriptName = npmScriptName(exactCommand);
  if (!scriptName) return null;
  let pkg: JsonRecord;
  try {
    const packageFile = regularProjectFile(projectRoot, "package.json");
    if (!packageFile) return null;
    const parsed = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    if (!isRecord(parsed)) return null;
    pkg = parsed;
  } catch {
    return null;
  }
  const scripts = pkg.scripts;
  const manifest = pkg["trust-reconcile-manifest"];
  if (!isRecord(scripts) || !Array.isArray(manifest)) return null;
  const postScript = scripts[`post${scriptName}`];
  if (postScript !== undefined && (typeof postScript !== "string" || postScript.trim().length > 0)) return null;
  const matchingManifest = manifest.filter((entry) => isRecord(entry) && entry.command === exactCommand && typeof entry.id === "string");
  if (matchingManifest.length !== 1) return null;
  const laneId = matchingManifest[0]!.id as string;
  const body = scripts[scriptName];
  if (typeof body !== "string" || /[;&|`$()]/.test(body)) return null;
  const tokens = body.trim().split(/\s+/);
  if (tokens[0] !== "node" || tokens.length < 3 || tokens[2] !== "request") return null;
  const entrypoint = tokens[1]!;
  const argv = tokens.slice(2);
  if (argv.length !== 2 || argv[1] !== laneId || argv.some((token) => token.startsWith("-"))) return null;
  if (!regularProjectFile(projectRoot, entrypoint)) return null;
  return { command: exactCommand, lane_id: laneId, entrypoint, argv };
}

function parseCoordinatorSummary(output: string): JsonRecord | null {
  const starts = [...output.matchAll(/\{/g)].map((match) => match.index!);
  const candidates = starts.flatMap((start) => {
    try {
      const parsed = JSON.parse(output.slice(start));
      return isRecord(parsed) ? [parsed] : [];
    } catch { return []; }
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

function currentCoordinatorRequest(binding: CoordinatedCommandBinding, projectRoot: string): { request: JsonRecord; file: string } {
  const entrypoint = regularProjectFile(projectRoot, binding.entrypoint);
  if (!entrypoint) throw new Error("coordinated receipt entrypoint is unavailable");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const output = execFileSync("bash", ["-lc", `node ${shellQuote(entrypoint)} explain ${shellQuote(binding.lane_id)}`], {
    cwd: projectRoot, env, encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  const explained = parseCoordinatorSummary(output);
  const request = explained?.request;
  if (!isRecord(request) || !isDigest(request.key) || request.command !== binding.command || request.laneId !== binding.lane_id
    || request.worktree !== fs.realpathSync(projectRoot)) throw new Error("coordinated receipt requires its declared producer's exact current request");
  const file = path.join(fs.realpathSync(projectRoot), ".kontourai", "verification-receipts", `${request.key}.canonical.json`);
  if (explained?.canonicalReceipt !== file) throw new Error("coordinated receipt canonical location does not match its current request");
  return { request, file };
}

function v3ReceiptPasses(receipt: JsonRecord, expected: JsonRecord, current: { head_sha: string; workspace_digest: string }): boolean {
  if (receipt.schemaVersion !== 3 || !["executed", "joined", "reused", "forced"].includes(String(receipt.disposition))) return false;
  if (Object.keys(receipt).some((key) => !["schemaVersion", "request", "disposition", "terminal", "counts", "artifacts", "cleanup", "provenance", "reusableOutputs"].includes(key))) return false;
  const request = receipt.request, terminal = receipt.terminal, counts = receipt.counts, cleanup = receipt.cleanup, provenance = receipt.provenance;
  if (!isRecord(request) || !isRecord(terminal) || !isRecord(counts) || !isRecord(cleanup) || !isRecord(provenance)) return false;
  if (stableJson(request) !== stableJson(expected) || request.headSha !== current.head_sha || request.workspaceDigest !== current.workspace_digest) return false;
  if (!exactKeys(request, ["repositoryId", "worktree", "headSha", "workspaceDigest", "environmentDigest", "laneId", "command", "manifestDigest", "dependencyDigest", "nodeVersion", "toolchain", "toolchainIdentity", "platform", "arch", "key"])) return false;
  const { key: _key, ...unsignedRequest } = request;
  if (createHash("sha256").update(stableJson(unsignedRequest)).digest("hex") !== request.key) return false;
  if (![request.repositoryId, request.workspaceDigest, request.environmentDigest, request.manifestDigest, request.dependencyDigest, request.toolchainIdentity, request.key].every(isDigest)) return false;
  if (terminal.status !== "completed" || terminal.exitCode !== 0 || terminal.passed !== true || terminal.indeterminate !== undefined) return false;
  if (Object.keys(terminal).some((key) => !["status", "exitCode", "passed", "recoveredFailures", "reconcileNote"].includes(key))) return false;
  if (terminal.reconcileNote !== undefined && (typeof terminal.reconcileNote !== "string" || terminal.reconcileNote.length > 1024)) return false;
  if (terminal.recoveredFailures !== undefined && (!Array.isArray(terminal.recoveredFailures) || terminal.recoveredFailures.length > 32
    || terminal.recoveredFailures.some((failure) => !isRecord(failure) || !exactKeys(failure, ["file", "name"])
      || typeof failure.file !== "string" || typeof failure.name !== "string" || failure.file.length > 512 || failure.name.length > 512))) return false;
  if (!exactKeys(counts, ["executed", "passed", "failed", "infrastructureErrors"]) || !Number.isSafeInteger(counts.executed)
    || Number(counts.executed) < 1 || counts.passed !== counts.executed || counts.failed !== 0 || counts.infrastructureErrors !== 0) return false;
  if (!exactKeys(cleanup, ["status", "survivingOwnedChildren"]) || !["passed", "not_required"].includes(String(cleanup.status)) || cleanup.survivingOwnedChildren !== 0) return false;
  if (!exactKeys(provenance, ["stable", "before", "after"]) || provenance.stable !== true || !isRecord(provenance.before) || !isRecord(provenance.after)) return false;
  const fields = ["repositoryId", "worktree", "headSha", "workspaceDigest", "environmentDigest", "dependencyDigest", "nodeVersion", "toolchain", "platform", "arch"];
  return [provenance.before, provenance.after].every((snapshot) => fields.every((field) => snapshot[field] === request[field])
    && isRecord(snapshot.toolchainIdentity) && snapshot.toolchainIdentity.digest === request.toolchainIdentity);
}

function readV3Receipt(projectRoot: string, binding: CoordinatedCommandBinding, requestKey: string, current: { head_sha: string; workspace_digest: string }): { receipt: JsonRecord; receiptBytes: Buffer; commitBytes: Buffer } | null {
  const root = fs.realpathSync(projectRoot);
  const canonical = path.join(root, ".kontourai", "verification-receipts", `${requestKey}.canonical.json`);
  if (!fs.existsSync(canonical)) return null;
  const file = regularProjectFile(root, path.relative(root, canonical));
  const commitFile = regularProjectFile(root, `${path.relative(root, canonical)}.commit.json`);
  if (!file || !commitFile) throw new Error("coordinated receipt canonical files must remain protected regular project files");
  if (fs.statSync(file).size > 16 * 1024 * 1024 || fs.statSync(commitFile).size > 4096) throw new Error("coordinated receipt exceeds its bounded contract size");
  const receiptBytes = fs.readFileSync(file), commitBytes = fs.readFileSync(commitFile);
  const receipt = JSON.parse(receiptBytes.toString("utf8")), commit = JSON.parse(commitBytes.toString("utf8"));
  if (!isRecord(receipt) || receipt.schemaVersion !== 3) return null;
  const expected = currentCoordinatorRequest(binding, projectRoot);
  if (expected.file !== canonical || expected.request.key !== requestKey) {
    const recorded = isRecord(receipt.request) ? receipt.request : {};
    const changed = Object.keys(expected.request).filter((field) => stableJson(expected.request[field]) !== stableJson(recorded[field]));
    throw new Error(`coordinated v3 receipt does not bind the exact current producer inputs (${changed.join(", ")}); no previous execution can confirm this request`);
  }
  if (!v3ReceiptPasses(receipt, expected.request, current)) throw new Error("coordinated v3 receipt does not bind the exact current producer inputs and successful execution");
  if (!isRecord(commit) || !exactKeys(commit, ["requestKey", "receiptDigest", "committed"]) || commit.requestKey !== requestKey
    || commit.committed !== true || commit.receiptDigest !== createHash("sha256").update(receiptBytes).digest("hex")) throw new Error("coordinated v3 receipt committed digest is invalid");
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length > 1024) throw new Error("coordinated v3 receipt artifacts are unavailable or exceed the bounded contract");
  for (const artifact of receipt.artifacts) {
    if (!isRecord(artifact) || !exactKeys(artifact, ["path", "sha256"]) || typeof artifact.path !== "string"
      || !/^\.kontourai\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+$/u.test(artifact.path)
      || artifact.path.split("/").some((part) => part === "." || part === "..") || !isDigest(artifact.sha256)) throw new Error("coordinated v3 receipt artifact binding is invalid");
    const artifactFile = regularProjectFile(projectRoot, artifact.path);
    if (!artifactFile || createHash("sha256").update(fs.readFileSync(artifactFile)).digest("hex") !== artifact.sha256) throw new Error("coordinated v3 receipt artifact bytes do not match their committed digest");
  }
  return { receipt, receiptBytes, commitBytes };
}

function receiptPasses(receipt: JsonRecord, binding: CoordinatedCommandBinding, projectRoot: string, requestKey: string, current: { head_sha: string; workspace_digest: string }): boolean {
  if (!exactKeys(receipt, ["schemaVersion", "request", "disposition", "terminal", "counts", "artifacts", "cleanup", "provenance"]) || receipt.schemaVersion !== 1) return false;
  const request = receipt.request;
  const terminal = receipt.terminal;
  const counts = receipt.counts;
  const cleanup = receipt.cleanup;
  const provenance = receipt.provenance;
  if (!isRecord(request) || !isRecord(terminal) || !isRecord(counts) || !isRecord(cleanup) || !isRecord(provenance)) return false;
  if (!exactKeys(request, ["repositoryId", "worktree", "headSha", "workspaceDigest", "environmentDigest", "laneId", "command", "manifestDigest", "dependencyDigest", "nodeVersion", "toolchain", "platform", "arch", "key"])) return false;
  if (request.key !== requestKey || request.command !== binding.command || request.laneId !== binding.lane_id || request.worktree !== fs.realpathSync(projectRoot) || request.headSha !== current.head_sha || request.workspaceDigest !== current.workspace_digest) return false;
  if (![request.repositoryId, request.workspaceDigest, request.environmentDigest, request.manifestDigest, request.dependencyDigest, request.key].every(isDigest) || typeof request.headSha !== "string" || !/^[a-f0-9]{40}$/.test(request.headSha)) return false;
  const { key: _key, ...unsignedRequest } = request;
  if (createHash("sha256").update(stableJson(unsignedRequest)).digest("hex") !== request.key) return false;
  if (!exactKeys(terminal, ["status", "exitCode", "passed"]) || terminal.status !== "completed" || terminal.exitCode !== 0 || terminal.passed !== true) return false;
  const executed = counts.executed;
  if (!exactKeys(counts, ["executed", "passed", "failed", "infrastructureErrors"]) || typeof executed !== "number" || !Number.isSafeInteger(executed) || executed < 1 || counts.passed !== executed || counts.failed !== 0 || counts.infrastructureErrors !== 0) return false;
  if (!exactKeys(cleanup, ["status", "survivingOwnedChildren"]) || !["passed", "not_required"].includes(String(cleanup.status)) || cleanup.survivingOwnedChildren !== 0) return false;
  if (provenance.stable !== true || !isRecord(provenance.before) || !isRecord(provenance.after)) return false;
  return [provenance.before, provenance.after].every((snapshot) => snapshot.headSha === request.headSha && snapshot.workspaceDigest === request.workspaceDigest && snapshot.environmentDigest === request.environmentDigest && snapshot.worktree === request.worktree);
}

function receiptCandidates(projectRoot: string, binding: CoordinatedCommandBinding, requestKey: string, current: { head_sha: string; workspace_digest: string }): Array<{ receipt: JsonRecord; receiptBytes: Buffer; commitBytes: Buffer }> {
  const root = path.join(projectRoot, ".kontourai");
  const files: string[] = [];
  const walk = (directory: string): void => {
    if (files.length > 1024) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".commit.json")) files.push(candidate);
    }
  };
  try { walk(root); } catch { return []; }
  return files.flatMap((file) => {
    try {
      const receiptStat = fs.lstatSync(file);
      const commitFile = `${file}.commit.json`;
      const commitStat = fs.lstatSync(commitFile);
      if (receiptStat.isSymbolicLink() || !receiptStat.isFile() || commitStat.isSymbolicLink() || !commitStat.isFile()) return [];
      const receiptBytes = fs.readFileSync(file);
      const receipt = JSON.parse(receiptBytes.toString("utf8"));
      const commitBytes = fs.readFileSync(commitFile);
      const commit = JSON.parse(commitBytes.toString("utf8"));
      if (!isRecord(receipt) || !isRecord(commit) || !receiptPasses(receipt, binding, projectRoot, requestKey, current)) return [];
      if (!exactKeys(commit, ["requestKey", "receiptDigest", "committed"]) || commit.requestKey !== requestKey || commit.committed !== true || commit.receiptDigest !== createHash("sha256").update(receiptBytes).digest("hex")) return [];
      return [{ receipt, receiptBytes, commitBytes }];
    } catch { return []; }
  });
}

/**
 * Consume a coordinator's receipt only after the exact top-level command was
 * observed to exit successfully. A receipt cannot be selected by a filename;
 * it must self-bind to the observed command, declared lane, current worktree,
 * terminal success, complete positive counts, stable provenance, and a digest
 * committed sidecar.
 */
export function observeCoordinatedCommandReceipt(binding: CoordinatedCommandBinding, projectRoot: string, result: ObservedProcessResult): { test_count: number; execution_proof: CoordinatedCommandReceiptProof } {
  if (result.exit_code !== 0 || result.timed_out === true) throw new Error("coordinated test command did not exit zero within its execution deadline");
  if (normalized(result.command) !== binding.command) throw new Error("coordinated receipt command does not match the observed command");
  const summary = parseCoordinatorSummary(result.stdout_tail ?? result.output);
  const request = summary?.request;
  const terminal = summary?.summary;
  if (!isRecord(request) || request.laneId !== binding.lane_id || !isDigest(request.key) || !isRecord(terminal)) throw new Error("coordinated test command did not emit one bound terminal summary");
  const current = currentWorkspaceBinding(projectRoot);
  const v3 = readV3Receipt(projectRoot, binding, request.key, current);
  const candidates = v3 ? [v3] : receiptCandidates(projectRoot, binding, request.key, current);
  if (candidates.length !== 1) throw new Error("coordinated test command requires exactly one matching committed receipt for the current workspace");
  const candidate = candidates[0]!;
  const summaryTerminalMatches = candidate.receipt.schemaVersion === 3 && typeof terminal.terminal === "string"
    ? terminal.terminal === (candidate.receipt.terminal as JsonRecord).status && terminal.passed === true && terminal.indeterminate !== true
    : stableJson(terminal.terminal) === stableJson(candidate.receipt.terminal);
  if (!summaryTerminalMatches
    || stableJson(terminal.counts) !== stableJson(candidate.receipt.counts)
    || stableJson(terminal.cleanup) !== stableJson(candidate.receipt.cleanup)) {
    throw new Error("coordinated test command summary does not match its committed receipt");
  }
  const counts = candidate.receipt.counts as JsonRecord;
  if (stableJson(currentWorkspaceBinding(projectRoot)) !== stableJson(current)) throw new Error("coordinated receipt workspace changed during admission");
  return {
    test_count: counts.executed as number,
    execution_proof: {
      kind: "coordinated-command-receipt",
      protocol: COORDINATED_COMMAND_RECEIPT_PROTOCOL,
      request_key: request.key,
      receipt_sha256: createHash("sha256").update(candidate.receiptBytes).digest("hex"),
      receipt_commit_sha256: createHash("sha256").update(candidate.commitBytes).digest("hex"),
    },
  };
}
