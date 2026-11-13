/**
 * Observe mode: the reminder engine for flows that declare `evidence_mode: "observed"`.
 *
 * The agent writes the plan and acceptance.json as files and works freely. This module turns what
 * hooks observed (the hash-chained command log, trusted Git, the observe ledger's check locks, the
 * distinct-reviewer critique) into facts, derives one trust-bundle claim per gate expectation from
 * those facts, and lets Flow's `evaluateGate` decide against the run's pinned definition. The
 * engine never decides pass on its own: it explains a non-pass, and it treats "every fact met but
 * Flow refuses" as its own defect, routed to a human.
 *
 * Decision record: docs/decisions/observe-mode.md.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { evaluateGate } from "@kontourai/flow";
import { captureReviewWorkspaceSnapshot, isGitWorktreeSnapshot, type GitWorktreeSnapshot } from "./lib/review-workspace-snapshot.js";
import { execTrustedGitSync, isExactLowercaseCommitSha } from "./lib/trusted-git.js";
import { runObservedCommand } from "./lib/observed-command.js";
import { appendWriterObservedCommands, inferExecutedTestCount, testExecutionProof, WRITER_OBSERVATION_SOURCE } from "./cli/workflow-sidecar.js";

type AnyObj = Record<string, any>;

export const OBSERVE_LEDGER_FILE = "observe-ledger.jsonl";
export const OBSERVE_STATE_FILE = "observe-state.json";
export const OBSERVE_BUNDLE_FILE = "observe.bundle.json";
export const OBSERVE_COLLECTOR = "flow-agents/observe-mode";
const DEFAULT_MAX_REMINDERS = 5;
const DEFAULT_STOP_BACKSTOP = 5;
const DEFAULT_VERIFY_BUDGET_MS = 20000;
/** Claude Code and Codex adapters kill a hook at 30 s; the re-run budget must leave headroom. */
const MAX_VERIFY_BUDGET_MS = 25000;
const MAX_LISTED = 6;
const MAX_LOCKED_DIR_FILES = 200;
const TEST_PROTOCOL_RUNNERS = new Set(["node --test", "go test", "cargo test"]);

// ─── Settings ────────────────────────────────────────────────────────────────────────────

export type ObserveSettings = { maxReminders: number; verifyBudgetMs: number; issues: string[] };

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
}

/**
 * The reminder cap counts boundaries the way goal-fit's max_blocks does: the Nth unmet boundary
 * hands off, so N-1 reminders reach the model. N may not exceed the adapter's consecutive-block
 * backstop, or the adapter would end the turn before the gate's own handoff. Out-of-range values
 * are refused loudly (reported as issues), never silently truncated into range.
 */
export function resolveObserveSettings(env: NodeJS.ProcessEnv = process.env): ObserveSettings {
  const issues: string[] = [];
  const backstopRaw = positiveInt(env.FLOW_AGENTS_STOP_MAX_BLOCKS);
  const backstop = backstopRaw && Number.isInteger(backstopRaw) && backstopRaw > 0 ? backstopRaw : DEFAULT_STOP_BACKSTOP;
  const fallbackCap = Math.min(DEFAULT_MAX_REMINDERS, backstop);
  let maxReminders = fallbackCap;
  const cap = positiveInt(env.FLOW_AGENTS_OBSERVE_MAX_REMINDERS);
  if (cap !== null) {
    if (!Number.isInteger(cap) || cap < 1 || cap > backstop) {
      issues.push(`FLOW_AGENTS_OBSERVE_MAX_REMINDERS=${JSON.stringify(env.FLOW_AGENTS_OBSERVE_MAX_REMINDERS)} refused: must be an integer from 1 to the adapter backstop FLOW_AGENTS_STOP_MAX_BLOCKS=${backstop}; using ${fallbackCap}`);
    } else {
      maxReminders = cap;
    }
  }
  let verifyBudgetMs = DEFAULT_VERIFY_BUDGET_MS;
  const budget = positiveInt(env.FLOW_AGENTS_OBSERVE_VERIFY_BUDGET_MS);
  if (budget !== null) {
    if (!Number.isInteger(budget) || budget > MAX_VERIFY_BUDGET_MS) {
      issues.push(`FLOW_AGENTS_OBSERVE_VERIFY_BUDGET_MS=${JSON.stringify(env.FLOW_AGENTS_OBSERVE_VERIFY_BUDGET_MS)} refused: must be an integer from 0 to ${MAX_VERIFY_BUDGET_MS} (the Stop hook is killed at 30000); using ${DEFAULT_VERIFY_BUDGET_MS}`);
    } else {
      verifyBudgetMs = budget;
    }
  }
  return { maxReminders, verifyBudgetMs, issues };
}

// ─── Small helpers ──────────────────────────────────────────────────────────────────────

const requireCjs = createRequire(import.meta.url);
type CommandLogChain = {
  computeChainHash: (prevHash: string, record: AnyObj) => string;
  verifyCommandLogRaw: (raw: string) => { status: "legacy" | "ok" | "forked" | "broken"; append: { seq: number; hash: string } | null };
  acquireGenerationLock: (base: string, options?: AnyObj) => AnyObj | null;
  releaseGenerationLock: (lock: AnyObj) => boolean;
  hasLaunderingOperator: (cmd: string) => boolean;
};
let chainModule: CommandLogChain | null = null;
function chain(): CommandLogChain {
  if (!chainModule) {
    chainModule = requireCjs(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/lib/command-log-chain.js")) as CommandLogChain;
  }
  return chainModule;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as AnyObj).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as AnyObj)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readJson(file: string): AnyObj | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function short(sha: string | null | undefined): string {
  return typeof sha === "string" && sha ? sha.slice(0, 7) : "?";
}

function quoted(text: string, max = 120): string {
  const one = text.replace(/\s+/g, " ").trim();
  return `\`${one.length > max ? `${one.slice(0, max - 1)}…` : one}\``;
}

function listWithMore(items: string[], max = MAX_LISTED): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

function git(projectRoot: string, args: string[]): string {
  return String(execTrustedGitSync(projectRoot, args, "utf8", 16 * 1024 * 1024, 5000));
}

function zList(output: string): string[] {
  return output.split("\0").map((entry) => entry.trim()).filter(Boolean);
}

// ─── Plan and acceptance files ──────────────────────────────────────────────────────────

export type PlanFile = {
  path: string;
  present: boolean;
  expected: string[];
  expectedDeclared: boolean;
  scopeReasons: Map<string, string>;
  checkChangeReasons: Map<string, string>;
  openQuestions: string[];
};

function sections(markdown: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1]!.toLowerCase();
      out.set(current, []);
      continue;
    }
    if (current) out.get(current)!.push(line);
  }
  return out;
}

function bullets(lines: string[] | undefined): string[] {
  return (lines ?? []).map((line) => /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1] ?? "").filter(Boolean);
}

function pathToken(item: string): string {
  const code = /`([^`]+)`/.exec(item);
  return (code ? code[1]! : item.split(/\s+/)[0]!).replace(/[:,]+$/, "").replace(/^\.\//, "");
}

/** `- \`path\`: reason` bullets. A bullet with no reason text is not a reason. */
function reasonMap(lines: string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of bullets(lines)) {
    const match = /^`([^`]+)`\s*[:—-]\s*(.+)$/.exec(item) ?? /^(\S+?):\s+(.+)$/.exec(item);
    if (!match) continue;
    const reason = match[2]!.trim();
    if (reason && !/^<.*>$/.test(reason)) map.set(match[1]!.replace(/^\.\//, ""), reason);
  }
  return map;
}

export function readPlanFile(sessionDir: string, slug: string): PlanFile {
  const file = path.join(sessionDir, `${slug}--plan-work.md`);
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* absent plan is a fact, not an error */ }
  const parts = sections(text);
  const expectedLines = parts.get("expected modified files");
  return {
    path: file,
    present: text.length > 0,
    expected: bullets(expectedLines).map(pathToken).filter(Boolean),
    expectedDeclared: expectedLines !== undefined,
    scopeReasons: reasonMap(parts.get("scope changes")),
    checkChangeReasons: reasonMap(parts.get("check changes")),
    openQuestions: bullets(parts.get("open questions")),
  };
}

export type Criterion = {
  id: string;
  description: string;
  status: string;
  notes: string;
  command: string | null;
  declaredFiles: string[];
};

export type AcceptanceFile = { path: string; present: boolean; valid: boolean; error: string | null; criteria: Criterion[]; sha256: string | null };

export function readAcceptance(sessionDir: string): AcceptanceFile {
  const file = path.join(sessionDir, "acceptance.json");
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { path: file, present: false, valid: false, error: "acceptance.json is missing", criteria: [], sha256: null }; }
  let parsed: AnyObj;
  try { parsed = JSON.parse(raw); } catch (error) { return { path: file, present: true, valid: false, error: `acceptance.json is not valid JSON (${(error as Error).message})`, criteria: [], sha256: sha256(raw) }; }
  if (!parsed || !Array.isArray(parsed.criteria) || parsed.criteria.length === 0) {
    return { path: file, present: true, valid: false, error: "acceptance.json defines no criteria", criteria: [], sha256: sha256(raw) };
  }
  const criteria: Criterion[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.criteria as AnyObj[]) {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim() || seen.has(entry.id)) {
      return { path: file, present: true, valid: false, error: "every acceptance.json criterion needs a unique non-empty id", criteria: [], sha256: sha256(raw) };
    }
    seen.add(entry.id);
    const refs = Array.isArray(entry.evidence_refs) ? entry.evidence_refs as AnyObj[] : [];
    // Standing directive 3: an excerpt is a runnable command; summary is prose and never runs.
    const commandRef = refs.find((ref) => ref && ref.kind === "command" && typeof ref.excerpt === "string" && ref.excerpt.trim());
    const declaredFiles = refs
      .filter((ref) => ref && (ref.kind === "command" || ref.kind === "source") && typeof ref.file === "string" && ref.file.trim())
      .map((ref) => String(ref.file).replace(/^\.\//, ""));
    criteria.push({
      id: entry.id,
      description: typeof entry.description === "string" ? entry.description : "",
      status: typeof entry.status === "string" ? entry.status : "pending",
      notes: typeof entry.notes === "string" ? entry.notes.trim() : "",
      command: commandRef ? String(commandRef.excerpt).trim() : null,
      declaredFiles,
    });
  }
  return { path: file, present: true, valid: true, error: null, criteria, sha256: sha256(raw) };
}

// ─── Check locks (the observe ledger) ───────────────────────────────────────────────────

export type LockedFile = { path: string; sha256: string | null };
export type LockedScript = { name: string; sha256: string | null };
export type LockedCheck = { criterion_id: string; command: string; command_sha256: string; files: LockedFile[]; scripts: LockedScript[] };
export type Ledger = { file: string; status: "absent" | "ok" | "broken"; locks: Map<string, LockedCheck>; digest: string | null };

function hashFile(projectRoot: string, rel: string): string | null {
  try {
    return sha256(fs.readFileSync(path.join(projectRoot, rel)));
  } catch {
    return null;
  }
}

/** Package scripts a command invokes directly: `npm test`, `npm run x`, `pnpm x`, `yarn x`. */
function invokedPackageScripts(command: string): string[] {
  const match = /^\s*(npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?([A-Za-z0-9:_.-]+)/.exec(command);
  if (!match) return [];
  const name = match[2]!;
  if (["install", "ci", "i", "add", "exec", "dlx", "x"].includes(name)) return [];
  return [name];
}

function packageScripts(projectRoot: string): AnyObj {
  const pkg = readJson(path.join(projectRoot, "package.json"));
  return pkg && pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
}

/**
 * The files a check runs, as observable from the definition: path tokens in the command and in
 * the bodies of the package scripts it invokes, plus files the criterion declares. Directories
 * expand to their tracked files. This is what makes a WEAKENED TEST visible: editing the test
 * file changes a locked hash even though the command string is unchanged.
 */
function checkFiles(projectRoot: string, command: string, declared: string[]): string[] {
  const scripts = packageScripts(projectRoot);
  const texts = [command, ...invokedPackageScripts(command).map((name) => String(scripts[name] ?? ""))];
  const candidates = new Set<string>(declared);
  for (const text of texts) {
    for (const token of text.split(/[\s;&|()<>"']+/)) {
      const clean = token.replace(/^\.\//, "");
      if (!clean || clean.startsWith("-") || clean.includes("$") || path.isAbsolute(clean) || clean.split("/").includes("..")) continue;
      if (!/[./]/.test(clean)) continue;
      candidates.add(clean);
    }
  }
  const files = new Set<string>();
  for (const candidate of candidates) {
    const abs = path.join(projectRoot, candidate);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isFile()) files.add(candidate);
    else if (stat.isDirectory()) {
      try {
        for (const tracked of zList(git(projectRoot, ["ls-files", "-z", "--", candidate])).slice(0, MAX_LOCKED_DIR_FILES)) files.add(tracked);
      } catch { /* untracked directory: its files are not locked */ }
    }
  }
  return [...files].sort();
}

function lockFor(projectRoot: string, criterion: Criterion): LockedCheck {
  const command = criterion.command!;
  const scripts = packageScripts(projectRoot);
  return {
    criterion_id: criterion.id,
    command,
    command_sha256: sha256(command),
    files: checkFiles(projectRoot, command, criterion.declaredFiles).map((rel) => ({ path: rel, sha256: hashFile(projectRoot, rel) })),
    scripts: invokedPackageScripts(command).map((name) => ({ name, sha256: typeof scripts[name] === "string" ? sha256(scripts[name]) : null })),
  };
}

export function readLedger(sessionDir: string): Ledger {
  const file = path.join(sessionDir, OBSERVE_LEDGER_FILE);
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { file, status: "absent", locks: new Map(), digest: null }; }
  if (!raw.trim()) return { file, status: "absent", locks: new Map(), digest: null };
  const verdict = chain().verifyCommandLogRaw(raw);
  const records = raw.split("\n").filter((line) => line.trim()).map((line) => { try { return JSON.parse(line); } catch { return null; } });
  // Every ledger record is written chained; an unchained or unparseable record is tamper.
  if (verdict.status === "broken" || verdict.status === "legacy" || records.some((record) => !record || !record._chain)) {
    return { file, status: "broken", locks: new Map(), digest: null };
  }
  const locks = new Map<string, LockedCheck>();
  for (const record of records as AnyObj[]) {
    if (record.type !== "lock" || !Array.isArray(record.checks)) continue;
    for (const check of record.checks as LockedCheck[]) if (!locks.has(check.criterion_id)) locks.set(check.criterion_id, check);
  }
  return { file, status: "ok", locks, digest: locks.size ? sha256(canonicalJson([...locks.values()].sort((a, b) => a.criterion_id.localeCompare(b.criterion_id)))) : null };
}

function appendLedger(ledger: Ledger, record: AnyObj): boolean {
  const c = chain();
  const lock = c.acquireGenerationLock(`${ledger.file}.lock`, { wait: true, attempts: 400, retryMs: 5 });
  if (!lock) return false;
  try {
    let raw = "";
    try { raw = fs.readFileSync(ledger.file, "utf8"); } catch { /* genesis */ }
    const authority = c.verifyCommandLogRaw(raw).append;
    if (!authority) return false;
    const seq = authority.seq + 1;
    const hash = c.computeChainHash(authority.hash, record);
    fs.appendFileSync(ledger.file, `${JSON.stringify({ ...record, _chain: { seq, prevHash: authority.hash, hash } })}\n`);
    return true;
  } finally {
    c.releaseGenerationLock(lock);
  }
}

/** Lock every criterion check not yet locked. Locks are first-write-wins and never rewritten. */
function extendLocks(projectRoot: string, acceptance: AcceptanceFile, ledger: Ledger, now: Date): Ledger {
  if (ledger.status === "broken" || !acceptance.valid) return ledger;
  const fresh = acceptance.criteria.filter((criterion) => criterion.command && !ledger.locks.has(criterion.id)).map((criterion) => lockFor(projectRoot, criterion));
  if (fresh.length === 0) return ledger;
  if (!appendLedger(ledger, { type: "lock", at: now.toISOString(), acceptance_sha256: acceptance.sha256, checks: fresh })) return ledger;
  return readLedger(path.dirname(ledger.file));
}

// ─── Command observations ───────────────────────────────────────────────────────────────

export type Observation = { result: "pass" | "fail" | "ambiguous" | "none"; exitCode: number | null; source: string | null; testCount: number | null; at: string | null };
type LogState = { status: "absent" | "ok" | "forked" | "broken" | "legacy"; entries: AnyObj[] };

function readCommandLog(sessionDir: string): LogState {
  const file = path.join(sessionDir, "command-log.jsonl");
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { status: "absent", entries: [] }; }
  const verdict = chain().verifyCommandLogRaw(raw);
  const entries = raw.split("\n").filter((line) => line.trim()).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) as AnyObj[];
  return { status: verdict.status, entries };
}

/** An entry confirms or refutes only when bound to the current clean snapshot (#1081). */
function boundToSnapshot(entry: AnyObj, snapshot: GitWorktreeSnapshot): boolean {
  if (!snapshot.worktree_clean || entry.observed_at_commit !== snapshot.head_sha || entry.worktree_clean !== true) return false;
  if (entry.source === WRITER_OBSERVATION_SOURCE) return isDeepStrictEqual(entry.writer?.verification_workspace_snapshot, snapshot);
  return entry.source === "postToolUse-capture";
}

/** Outcome-ranked, source-blind fold: an observed fail from either source is sticky. */
function foldAt(log: LogState, command: string, snapshot: GitWorktreeSnapshot): Observation {
  let pass: AnyObj | null = null;
  let ambiguous: AnyObj | null = null;
  for (const entry of log.entries) {
    if (typeof entry.command !== "string" || entry.command.trim() !== command || !boundToSnapshot(entry, snapshot)) continue;
    if (entry.observedResult === "fail") return { result: "fail", exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : null, source: entry.source ?? null, testCount: null, at: entry.capturedAt ?? null };
    if (entry.observedResult === "pass") pass = entry;
    else ambiguous = entry;
  }
  if (pass) return { result: "pass", exitCode: 0, source: pass.source ?? null, testCount: Number.isSafeInteger(pass.writer?.test_count) ? pass.writer.test_count : null, at: pass.capturedAt ?? null };
  if (ambiguous) return { result: "ambiguous", exitCode: null, source: ambiguous.source ?? null, testCount: null, at: ambiguous.capturedAt ?? null };
  return { result: "none", exitCode: null, source: null, testCount: null, at: null };
}

function lastObservation(log: LogState, command: string): AnyObj | null {
  for (let index = log.entries.length - 1; index >= 0; index -= 1) {
    const entry = log.entries[index]!;
    if (typeof entry.command === "string" && entry.command.trim() === command) return entry;
  }
  return null;
}

function testCapable(command: string, projectRoot: string): boolean {
  try {
    const proof = testExecutionProof(command, projectRoot) as AnyObj | null;
    return Boolean(proof) && (proof!.kind !== "local-process-exit" || TEST_PROTOCOL_RUNNERS.has(String(proof!.runner)));
  } catch {
    return false;
  }
}

export type RerunNote = { command: string; outcome: "recorded" | "budget-exceeded" | "skipped-budget" | "error"; ms: number; detail?: string };

/**
 * Hook-triggered verification: run each locked check that has no confirming or refuting
 * observation at the current clean snapshot, through the writer-observed runner, and append the
 * result to the command log. A check cut off by the budget is NOT appended: a killed process
 * neither confirms nor refutes.
 */
async function rerunLockedChecks(projectRoot: string, sessionDir: string, locks: LockedCheck[], snapshot: GitWorktreeSnapshot, budgetMs: number | null, now: () => Date): Promise<RerunNote[]> {
  const notes: RerunNote[] = [];
  if (!snapshot.worktree_clean) return notes;
  const started = Date.now();
  const priorTimeout = process.env.FLOW_AGENTS_EVIDENCE_COMMAND_TIMEOUT_MS;
  const priorGrace = process.env.FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS;
  try {
    for (const check of locks) {
      if (chain().hasLaunderingOperator(check.command)) continue;
      const log = readCommandLog(sessionDir);
      const current = foldAt(log, check.command, snapshot);
      if (current.result === "pass" || current.result === "fail") continue;
      const remaining = budgetMs === null ? null : budgetMs - (Date.now() - started);
      if (remaining !== null && remaining < 250) {
        notes.push({ command: check.command, outcome: "skipped-budget", ms: 0 });
        continue;
      }
      if (remaining !== null) {
        process.env.FLOW_AGENTS_EVIDENCE_COMMAND_TIMEOUT_MS = String(Math.max(1, remaining - 200));
        process.env.FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS = "150";
      }
      const t0 = Date.now();
      try {
        const result = await runObservedCommand(check.command, projectRoot);
        if (result.timed_out || result.exit_code === null) {
          notes.push({ command: check.command, outcome: "budget-exceeded", ms: Date.now() - t0 });
          continue;
        }
        const captured = result.observation.status === "captured" ? result.observation : null;
        let proof: AnyObj | null = null;
        try { proof = testExecutionProof(check.command, projectRoot) as AnyObj | null; } catch { proof = null; }
        appendWriterObservedCommands(sessionDir, [{
          command: check.command,
          exit_code: result.exit_code,
          output_sha256: result.output_sha256,
          source: WRITER_OBSERVATION_SOURCE,
          ...(captured ? { observed_at_commit: captured.observed_at_commit, worktree_clean: captured.worktree_clean, verification_workspace_snapshot: captured.verification_workspace_snapshot as unknown as AnyObj } : {}),
          ...(proof ? { test_count: inferExecutedTestCount(check.command, projectRoot, result.stdout_tail ?? result.output), execution_proof: proof as any } : {}),
        }], now().toISOString());
        notes.push({ command: check.command, outcome: "recorded", ms: Date.now() - t0 });
      } catch (error) {
        notes.push({ command: check.command, outcome: "error", ms: Date.now() - t0, detail: (error as Error).message });
      }
    }
  } finally {
    if (priorTimeout === undefined) delete process.env.FLOW_AGENTS_EVIDENCE_COMMAND_TIMEOUT_MS; else process.env.FLOW_AGENTS_EVIDENCE_COMMAND_TIMEOUT_MS = priorTimeout;
    if (priorGrace === undefined) delete process.env.FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS; else process.env.FLOW_AGENTS_EVIDENCE_COMMAND_KILL_GRACE_MS = priorGrace;
  }
  return notes;
}

// ─── Scope ──────────────────────────────────────────────────────────────────────────────

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index]!;
    if (ch === "*" && pattern[index + 1] === "*") { out += ".*"; index += 1; if (pattern[index + 1] === "/") index += 1; }
    else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function declaredCovers(declared: string[], file: string): boolean {
  return declared.some((entry) => {
    if (/[*?]/.test(entry)) return globToRegExp(entry).test(file);
    const bare = entry.replace(/\/+$/, "");
    return file === bare || file.startsWith(`${bare}/`);
  });
}

/** Files changed since the recorded base: committed and uncommitted tracked changes plus untracked files. */
export function changedSinceBase(projectRoot: string, base: string, excluded: string[]): string[] {
  const tracked = zList(git(projectRoot, ["diff", "--name-only", "--no-renames", "-z", base, "--"]));
  const untracked = zList(git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])]
    .filter((file) => !excluded.some((root) => file === root || file.startsWith(`${root}/`)))
    .sort();
}

// ─── Facts ──────────────────────────────────────────────────────────────────────────────

export type FactStatus = "met" | "unmet" | "gap" | "attention";
export type Fact = { key: string; expectation: string | null; status: FactStatus; text: string };

export type ObserveAction = "satisfied" | "remind" | "handoff" | "hard";
export type ObserveDecision = {
  action: ObserveAction;
  message: string;
  facts: Fact[];
  gate: { id: string; status: string; missing: string[] };
  head: string | null;
  base: string | null;
  lock_digest: string | null;
  reruns: RerunNote[];
  latency_ms: number;
  settings: ObserveSettings;
  reminder: { count: number; cap: number };
};

export type ObserveInput = {
  projectRoot: string;
  sessionDir: string;
  /** "boundary": the Stop hook (locks, bounded re-run, reminder state). "verify": locks and re-runs without the Stop budget. "status": read-only. */
  mode: "boundary" | "verify" | "status";
  stopHookActive?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  canonical?: { state: AnyObj; definition: AnyObj };
};

function readCanonical(projectRoot: string, slug: string): { state: AnyObj; definition: AnyObj } | null {
  const runDir = path.join(projectRoot, ".kontourai", "flow", "runs", slug);
  const state = readJson(path.join(runDir, "state.json"));
  const definition = readJson(path.join(runDir, "definition.json"));
  return state && definition ? { state, definition } : null;
}

function currentGate(definition: AnyObj, step: string): [string, AnyObj] | null {
  for (const [id, gate] of Object.entries((definition.gates ?? {}) as AnyObj)) {
    if (gate && typeof gate === "object" && (gate as AnyObj).step === step) return [id, gate as AnyObj];
  }
  return null;
}

function currentCritiques(bundle: AnyObj | null, snapshot: GitWorktreeSnapshot | null): { current: AnyObj | null; latest: AnyObj | null } {
  const claims = Array.isArray(bundle?.claims) ? bundle!.claims as AnyObj[] : [];
  const critiques = claims
    .filter((claim) => claim.claimType === "workflow.critique.review" && claim.metadata?.origin === "critique")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const latest = critiques.at(-1) ?? null;
  if (!latest || !snapshot) return { current: null, latest };
  const target = latest.metadata?.review_target?.workspace_snapshot;
  const current = target && target.digest === snapshot.digest && target.head_sha === snapshot.head_sha && latest.value === "pass" ? latest : null;
  return { current, latest };
}

// ─── Derived bundle and Flow evaluation ─────────────────────────────────────────────────

/** Surface's closed EvidenceType vocabulary; an unknown type makes the whole bundle invalid. */
const EVIDENCE_TYPE: Record<string, string> = {
  "acceptance-lock": "calculation_trace",
  "git-scope": "runtime_observation",
  "locked-test-checks": "test_output",
  "locked-criterion-checks": "runtime_observation",
};

function derivedClaim(slug: string, expectation: AnyObj, met: boolean, summary: string, head: string, at: string): { claim: AnyObj; evidence: AnyObj; policy: AnyObj; events: AnyObj[] } {
  const selector = expectation.bundle_claim ?? {};
  const claimType = String(selector.claimType);
  const kind = String(expectation.observed_by);
  const evidenceType = EVIDENCE_TYPE[kind] ?? "runtime_observation";
  const id = `${slug}.observe.${expectation.id}`;
  const integrityRef = `commit:${head}`;
  const policyId = `policy:observe:${claimType}`;
  return {
    claim: {
      id, subjectType: selector.subjectType ?? "flow-step", subjectId: `${slug}/${expectation.id}`, facet: "flow-agents.observe",
      claimType, fieldOrBehavior: expectation.id, value: met ? "pass" : "fail", createdAt: at, updatedAt: at, impactLevel: "high",
      currentIntegrityRef: integrityRef, verificationPolicyId: policyId, metadata: { origin: "observe", observed_by: kind },
    },
    evidence: {
      id: `ev:${id}`, claimId: id, evidenceType, passing: met, method: "validation", sourceRef: `observe:${kind}`,
      excerptOrSummary: summary.slice(0, 2000), observedAt: at, collectedBy: OBSERVE_COLLECTOR, integrityRef,
    },
    policy: {
      id: policyId, claimType, requiredEvidence: [evidenceType], requiredMethods: ["validation"], requiresCorroboration: false,
      acceptanceCriteria: [String(expectation.description ?? expectation.id)], reviewAuthority: "system", validityRule: { kind: "commit" },
      stalenessTriggers: ["new commit"], conflictRules: [], impactLevel: "high",
    },
    events: met ? [{ id: `evt:${id}`, claimId: id, status: "verified", actor: OBSERVE_COLLECTOR, method: "validation", evidenceIds: [`ev:${id}`], createdAt: at, verifiedAt: at }] : [],
  };
}

function buildBundle(slug: string, gate: AnyObj, metByKind: Map<string, { met: boolean; summary: string }>, critique: AnyObj | null, trustBundle: AnyObj | null, head: string, at: string): AnyObj {
  const bundle: AnyObj = { schemaVersion: 5, source: `${OBSERVE_COLLECTOR};statusFunctionVersion=4`, claims: [], evidence: [], policies: [], events: [] };
  for (const expectation of (Array.isArray(gate.expects) ? gate.expects : []) as AnyObj[]) {
    if (typeof expectation.observed_by !== "string") continue;
    const derived = metByKind.get(expectation.observed_by) ?? { met: false, summary: `no derivation for ${expectation.observed_by}` };
    const parts = derivedClaim(slug, expectation, derived.met, derived.summary, head, at);
    bundle.claims.push(parts.claim);
    bundle.evidence.push(parts.evidence);
    if (!bundle.policies.some((policy: AnyObj) => policy.id === parts.policy.id)) bundle.policies.push(parts.policy);
    bundle.events.push(...parts.events);
  }
  // Only the CURRENT critique travels: Flow accepts any verified claim of a type, so an older
  // review of a different tree must never be present to satisfy the selector.
  if (critique && trustBundle) {
    const { metadata: _metadata, status: _status, ...claim } = critique;
    bundle.claims.push({ ...claim, metadata: critique.metadata });
    for (const evidence of (trustBundle.evidence ?? []) as AnyObj[]) if (evidence.claimId === critique.id) bundle.evidence.push(evidence);
    for (const event of (trustBundle.events ?? []) as AnyObj[]) if (event.claimId === critique.id) bundle.events.push(event);
    const policy = ((trustBundle.policies ?? []) as AnyObj[]).find((entry) => entry.id === critique.verificationPolicyId);
    if (policy) bundle.policies.push(policy);
  }
  return bundle;
}

// ─── Reminder state ─────────────────────────────────────────────────────────────────────

type ReminderState = { window: number; last_unmet_digest: string | null; file_hashes: Record<string, string | null> };

function readReminderState(sessionDir: string): ReminderState {
  const raw = readJson(path.join(sessionDir, OBSERVE_STATE_FILE));
  return {
    window: Number.isSafeInteger(raw?.window) && raw!.window >= 0 ? raw!.window : 0,
    last_unmet_digest: typeof raw?.last_unmet_digest === "string" ? raw.last_unmet_digest : null,
    file_hashes: raw?.file_hashes && typeof raw.file_hashes === "object" ? raw.file_hashes : {},
  };
}

function writeReminderState(sessionDir: string, state: ReminderState): void {
  try { fs.writeFileSync(path.join(sessionDir, OBSERVE_STATE_FILE), `${JSON.stringify(state)}\n`); } catch { /* best effort: losing it only resets the window */ }
}

// ─── The evaluation ─────────────────────────────────────────────────────────────────────

export async function evaluateObserveRun(input: ObserveInput): Promise<ObserveDecision> {
  const t0 = Date.now();
  const now = input.now ?? (() => new Date());
  const settings = resolveObserveSettings(input.env ?? process.env);
  const projectRoot = input.projectRoot;
  const sessionDir = input.sessionDir;
  const slug = path.basename(sessionDir);
  const facts: Fact[] = [];
  const hard: string[] = [];
  const push = (key: string, expectation: string | null, status: FactStatus, text: string) => facts.push({ key, expectation, status, text });

  const canonical = input.canonical ?? readCanonical(projectRoot, slug);
  if (!canonical) {
    return finish("hard", [`observe mode: canonical run ${slug} is unreadable; nothing can be evaluated`], null, null, null, [], { id: "?", status: "unavailable", missing: [] });
  }
  const { state, definition } = canonical;
  const gateEntry = currentGate(definition, String(state.current_step));
  const base = typeof state.params?.source_base === "string" && isExactLowercaseCommitSha(state.params.source_base) ? state.params.source_base : null;

  let snapshot: GitWorktreeSnapshot | null = null;
  try {
    const captured = captureReviewWorkspaceSnapshot(projectRoot, []);
    if (isGitWorktreeSnapshot(captured)) snapshot = captured;
  } catch { /* reported below */ }
  const head = snapshot?.head_sha ?? null;

  // Definition layer: plan + acceptance files and the locks.
  const plan = readPlanFile(sessionDir, slug);
  const acceptance = readAcceptance(sessionDir);
  let ledger = readLedger(sessionDir);
  if (ledger.status === "broken") hard.push(`observe ledger integrity check FAILED (${path.relative(projectRoot, ledger.file)}): the check locks were edited or reordered. Restore it or ask an operator; locks are never rewritten.`);
  if (input.mode !== "status") ledger = extendLocks(projectRoot, acceptance, ledger, now());

  const accRel = path.relative(projectRoot, acceptance.path);
  const planRel = path.relative(projectRoot, plan.path);
  if (!acceptance.valid) push("acceptance", "acceptance-lock", "unmet", `${accRel}: ${acceptance.error}. Define criteria, each with a command evidence_ref ({"kind":"command","excerpt":"<check>"}) or status "accepted_gap" with notes.`);

  const scopeExcluded = [path.relative(projectRoot, path.dirname(sessionDir)).split(path.sep).join("/")];
  const changed = base ? changedSinceBase(projectRoot, base, scopeExcluded) : [];
  const fileHashes: Record<string, string | null> = {};
  for (const file of changed.slice(0, 500)) fileHashes[file] = hashFile(projectRoot, file);

  const definitionIssues: string[] = [];
  const lockedChecks: LockedCheck[] = [];
  const checkEdits: string[] = [];
  for (const criterion of acceptance.criteria) {
    const cite = `${accRel}:${criterion.id}`;
    const locked = ledger.locks.get(criterion.id);
    if (criterion.status === "accepted_gap") {
      if (criterion.notes) push(`gap:${criterion.id}`, "locked-criterion-checks", "gap", `${cite} accepted gap${locked ? " (accepted after its check was locked)" : ""}: ${criterion.notes}`);
      else { definitionIssues.push(criterion.id); push(`gap:${criterion.id}`, "acceptance-lock", "unmet", `${cite} is marked accepted_gap without notes: give the one-line reason.`); }
      continue;
    }
    if (!locked) {
      if (!criterion.command) { definitionIssues.push(criterion.id); push(`check:${criterion.id}`, "acceptance-lock", "unmet", `${cite} has no command check: add {"kind":"command","excerpt":"<command that proves it>"} to its evidence_refs, or mark it accepted_gap with notes.`); }
      else if (input.mode === "status") push(`lock:${criterion.id}`, "acceptance-lock", "unmet", `${cite} check ${quoted(criterion.command)} is not locked yet (the next Stop locks it).`);
      else { definitionIssues.push(criterion.id); push(`lock:${criterion.id}`, "acceptance-lock", "unmet", `${cite} check could not be locked (observe ledger unavailable).`); }
      continue;
    }
    lockedChecks.push(locked);
    if (criterion.command !== locked.command) {
      checkEdits.push(`${cite} command ${quoted(locked.command)} → ${criterion.command ? quoted(criterion.command) : "removed"}`);
      push(`edit:${criterion.id}`, "acceptance-lock", "unmet", `${cite} locked check was edited (locked ${quoted(locked.command)}, now ${criterion.command ? quoted(criterion.command) : "none"}). The locked command is what runs; revert the edit.`);
    }
    for (const file of locked.files) {
      const nowHash = hashFile(projectRoot, file.path);
      if (nowHash === file.sha256) continue;
      const reason = plan.checkChangeReasons.get(file.path);
      checkEdits.push(`${file.path} (check file of ${criterion.id})${reason ? `: ${reason}` : ""}`);
      if (reason) push(`edit:${criterion.id}:${file.path}`, "acceptance-lock", "attention", `${file.path}, a locked check file of ${criterion.id}, changed after the lock. Reason given: ${reason}`);
      else push(`edit:${criterion.id}:${file.path}`, "acceptance-lock", "unmet", `${file.path}, a locked check file of ${cite}, changed after the lock (possible weakened test). Revert it, or add "- \`${file.path}\`: <why>" under ## Check Changes in ${planRel}; the human sees that reason either way.`);
    }
    const scripts = packageScripts(projectRoot);
    for (const script of locked.scripts) {
      const nowHash = typeof scripts[script.name] === "string" ? sha256(scripts[script.name]) : null;
      if (nowHash === script.sha256) continue;
      checkEdits.push(`package.json script "${script.name}" (check of ${criterion.id})`);
      push(`edit:${criterion.id}:script:${script.name}`, "acceptance-lock", "unmet", `package.json script "${script.name}", run by the locked check of ${cite}, changed after the lock. Revert it.`);
    }
  }
  for (const [id, locked] of ledger.locks) {
    if (!acceptance.criteria.some((criterion) => criterion.id === id)) {
      checkEdits.push(`${accRel}:${id} removed`);
      push(`edit:${id}`, "acceptance-lock", "unmet", `${accRel}:${id} was locked (${quoted(locked.command)}) and has been removed from acceptance.json. Restore it.`);
    }
  }

  // Scope.
  if (!base) push("scope:base", "git-scope", "unmet", "the run has no recorded base commit (params.source_base); scope cannot be derived. Start a new builder.observe run.");
  if (!plan.present) push("plan", "git-scope", "unmet", `${planRel} is missing: write it with an "## Expected Modified Files" list.`);
  else if (!plan.expectedDeclared) push("plan", "git-scope", "unmet", `${planRel} has no "## Expected Modified Files" section.`);
  const outside = changed.filter((file) => !declaredCovers(plan.expected, file));
  const unexplained = outside.filter((file) => !plan.scopeReasons.has(file));
  for (const file of unexplained.slice(0, MAX_LISTED)) {
    push(`scope:${file}`, "git-scope", "unmet", `scope: ${file} changed but is not in ## Expected Modified Files. Add "- \`${file}\`: <one-line reason>" under ## Scope Changes in ${planRel}, or revert it.`);
  }
  if (unexplained.length > MAX_LISTED) push("scope:more", "git-scope", "unmet", `scope: ${unexplained.length - MAX_LISTED} more unexplained files (flow-agents observe status lists them).`);
  if (!snapshot) push("committed", "git-scope", "unmet", "the Git worktree could not be captured; nothing can be bound to a revision.");
  else if (!snapshot.worktree_clean) {
    const dirty = (() => { try { return zList(git(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).map((entry) => entry.slice(3)); } catch { return []; } })();
    push("committed", "git-scope", "unmet", `uncommitted changes (${listWithMore(dirty.slice(0, 20))}): commit them so the checks can bind to a revision.`);
  }

  // Path layer, observed: bounded hook-triggered re-run, then the fold.
  let reruns: RerunNote[] = [];
  if (input.mode !== "status" && snapshot?.worktree_clean && hard.length === 0) {
    reruns = await rerunLockedChecks(projectRoot, sessionDir, lockedChecks, snapshot, input.mode === "boundary" ? settings.verifyBudgetMs : null, now);
  }
  const log = readCommandLog(sessionDir);
  if (log.status === "broken") hard.push("command-log integrity check FAILED for the observe run: observations cannot be trusted.");

  let criteriaMet = 0;
  let testMet = 0;
  let testCapableCount = 0;
  for (const check of lockedChecks) {
    const criterion = acceptance.criteria.find((entry) => entry.id === check.criterion_id);
    if (!criterion || criterion.status === "accepted_gap") continue;
    const cite = `${accRel}:${check.criterion_id}`;
    const capable = testCapable(check.command, projectRoot);
    if (capable) testCapableCount += 1;
    if (chain().hasLaunderingOperator(check.command)) {
      push(`result:${check.criterion_id}`, "locked-criterion-checks", "unmet", `${cite} locked check ${quoted(check.command)} contains an exit-masking operator, so it cannot prove anything. This needs a human: the check is locked.`);
      continue;
    }
    if (!snapshot) continue;
    const observed = foldAt(log, check.command, snapshot);
    if (observed.result === "pass") {
      criteriaMet += 1;
      if (capable && !(observed.source === WRITER_OBSERVATION_SOURCE && observed.testCount === 0)) testMet += 1;
      push(`result:${check.criterion_id}`, "locked-criterion-checks", "met", `${cite} passes at ${short(head)}`);
      continue;
    }
    const last = lastObservation(log, check.command);
    const lastText = last ? `last ${String(last.observedResult).toUpperCase()}${Number.isInteger(last.exitCode) ? ` (exit ${last.exitCode})` : ""} at ${short(last.observed_at_commit)}${last.worktree_clean === false ? "+uncommitted" : ""}` : "never observed";
    const rerun = reruns.find((note) => note.command === check.command);
    let why: string;
    // False done: the boundary's own verification refuses a stop whose locked check fails, the
    // same refusal the CLI's tests-evidence writer applies to a failing outcome.
    if (observed.result === "fail") why = `locked check ${quoted(check.command)} FAILS at ${short(head)} (exit ${observed.exitCode ?? "?"}${observed.source === "postToolUse-capture" ? ", captured" : ", run by the observed runner"}); you stopped as if done. Fix it and commit; a failure at a commit stays a failure.`;
    else if (!snapshot.worktree_clean) why = `locked check ${quoted(check.command)} has no result for a committed tree (${lastText}).`;
    else if (rerun?.outcome === "budget-exceeded" || rerun?.outcome === "skipped-budget") why = `locked check ${quoted(check.command)} did not finish within the Stop budget (${settings.verifyBudgetMs} ms); run \`flow-agents observe verify\` (${lastText}).`;
    else if (rerun?.outcome === "error") why = `locked check ${quoted(check.command)} could not be run (${rerun.detail ?? "error"}).`;
    else why = `locked check ${quoted(check.command)} has no result at ${short(head)} (${lastText}).`;
    push(`result:${check.criterion_id}`, "locked-criterion-checks", "unmet", `${cite} ${why}`);
  }
  if (acceptance.valid && testCapableCount === 0 && lockedChecks.length > 0) {
    push("tests", "locked-test-checks", "unmet", `no locked check is a recognised test run (a package test script or node --test/go test/cargo test). Add one to ${accRel}.`);
  }

  // Judgment record: the distinct-reviewer critique.
  const trustBundle = readJson(path.join(sessionDir, "trust.bundle"));
  const critique = currentCritiques(trustBundle, snapshot && snapshot.worktree_clean ? snapshot : null);
  if (!critique.current) {
    const reviewed = critique.latest?.metadata?.review_target?.workspace_snapshot?.head_sha;
    push("review", null, "unmet", critique.latest
      ? `review: the latest critique (${String(critique.latest.value)}) reviewed ${short(reviewed)}${critique.latest.metadata?.review_target?.workspace_snapshot?.worktree_clean === false ? "+uncommitted" : ""}, not the current ${short(head)}. Have a separate reviewer session record \`workflow critique\` again.`
      : `review: no critique of ${short(head)} from a distinct reviewer. A separate reviewer session records \`workflow critique\` (review-work); the implementing session cannot.`);
  }

  // Attention items: never gates.
  for (const question of plan.openQuestions) push(`question:${question}`, null, "attention", `open question: ${question}`);
  for (const [file, reason] of plan.scopeReasons) if (changed.includes(file)) push(`scope-reason:${file}`, null, "attention", `scope reason for ${file}: ${reason}`);
  for (const issue of settings.issues) push(`setting:${issue}`, null, "attention", issue);

  // Derive claims and let Flow decide.
  const unmet = (expectation: string) => facts.some((fact) => fact.expectation === expectation && fact.status === "unmet");
  const metByKind = new Map<string, { met: boolean; summary: string }>([
    ["acceptance-lock", { met: acceptance.valid && ledger.status === "ok" && ledger.locks.size > 0 && definitionIssues.length === 0 && !unmet("acceptance-lock"), summary: `locked ${ledger.locks.size} check(s), digest ${ledger.digest ?? "none"}` }],
    ["git-scope", { met: Boolean(base) && plan.expectedDeclared && unexplained.length === 0 && Boolean(snapshot?.worktree_clean), summary: `${changed.length} changed since ${short(base)}; ${outside.length - unexplained.length} with scope reasons` }],
    ["locked-test-checks", { met: testMet > 0 && !unmet("locked-criterion-checks") && !unmet("locked-test-checks"), summary: `${testMet} passing locked test check(s) at ${short(head)}` }],
    ["locked-criterion-checks", { met: lockedChecks.length > 0 && !unmet("locked-criterion-checks") && !unmet("acceptance-lock") && criteriaMet > 0, summary: `${criteriaMet} criterion check(s) pass at ${short(head)}` }],
  ]);
  let gate = { id: gateEntry?.[0] ?? "?", status: "unavailable", missing: [] as string[] };
  let engineDefect: string | null = null;
  if (!gateEntry) engineDefect = `no gate is declared for the run's current step ${String(state.current_step)}`;
  else if (head) {
    const at = now().toISOString();
    const bundle = buildBundle(slug, gateEntry[1], metByKind, critique.current, trustBundle, head, at);
    if (input.mode !== "status") {
      try { fs.writeFileSync(path.join(sessionDir, OBSERVE_BUNDLE_FILE), `${JSON.stringify(bundle, null, 2)}\n`); } catch { /* the decision does not depend on the copy */ }
    }
    try {
      const manifest = { schema_version: "0.1", evidence: [{ id: "observe-derived", gate_id: gateEntry[0], kind: "trust.bundle", requested_kind: "trust.bundle", status: "passed", bundle, attached_at: at }] };
      const outcome = evaluateGate(definition, state, manifest, gateEntry[0], undefined, at) as AnyObj;
      gate = { id: gateEntry[0], status: String(outcome.status), missing: Array.isArray(outcome.missing) ? outcome.missing.map(String) : [] };
    } catch (error) {
      engineDefect = `Flow could not evaluate ${gateEntry[0]}: ${(error as Error).message}`;
    }
  }
  const anyUnmet = facts.some((fact) => fact.status === "unmet");
  if (!engineDefect && gate.status !== "pass" && !anyUnmet && hard.length === 0) {
    engineDefect = `every observed fact is met but Flow refused ${gate.id} (${gate.status}; missing ${gate.missing.join(", ") || "none"})`;
  }
  if (engineDefect) push("engine", null, "unmet", `observe-mode engine defect: ${engineDefect}. This needs a human.`);

  return finish(hard.length ? "hard" : (gate.status === "pass" && !anyUnmet && !engineDefect) ? "satisfied" : "unmet" as any, hard, head, base, ledger.digest, checkEdits, gate);

  function finish(kind: "hard" | "satisfied" | "unmet", hardIssues: string[], headSha: string | null, baseSha: string | null, digest: string | null, edits: string[], gateResult: { id: string; status: string; missing: string[] }): ObserveDecision {
    const label = `[${String(canonical?.definition?.id ?? "builder.observe")}/${gateResult.id}]`;
    const tail = `Lock ${digest ? `sha256:${digest.slice(0, 12)}` : "none"} · head ${short(headSha)} · base ${short(baseSha)}`;
    const attention = facts.filter((fact) => fact.status === "attention" || fact.status === "gap");
    const external = "Not observed by this run (needs you): publication of the change and hosted CI.";
    const decision = (action: ObserveAction, message: string, count: number): ObserveDecision => ({
      action, message, facts, gate: gateResult, head: headSha, base: baseSha, lock_digest: digest, reruns, latency_ms: Date.now() - t0, settings,
      reminder: { count, cap: settings.maxReminders },
    });
    if (kind === "hard") {
      return decision("hard", [`${label} observe mode integrity failure:`, ...hardIssues.map((issue) => ` - ${issue}`)].join("\n"), 0);
    }
    if (kind === "satisfied") {
      if (input.mode === "boundary") writeReminderState(sessionDir, { window: 0, last_unmet_digest: null, file_hashes: {} });
      const lines = [`${label} All observed truths are met at ${short(headSha)}; the work may stop.`, ...attention.map((fact) => ` - ${fact.text}`), ` - ${external}`, tail];
      return decision("satisfied", lines.join("\n"), 0);
    }
    const unmetFacts = facts.filter((fact) => fact.status === "unmet");
    const actionable = unmetFacts.filter((fact) => fact.key !== "engine");
    const digestNow = sha256(canonicalJson(unmetFacts.map((fact) => fact.text)));
    const prior = readReminderState(sessionDir);
    const changedSince = Object.keys(fileHashes).filter((file) => prior.file_hashes[file] !== undefined && prior.file_hashes[file] !== fileHashes[file]);
    const count = prior.window + 1;
    let handoffReason: string | null = null;
    if (input.mode !== "boundary") handoffReason = null;
    else if (actionable.length === 0) handoffReason = "only items that need a human remain";
    else if (input.stopHookActive === true && prior.last_unmet_digest === digestNow) handoffReason = "no progress since the last reminder";
    else if (count >= settings.maxReminders) handoffReason = `reminder cap reached (${settings.maxReminders} unmet stops)`;
    if (input.mode !== "boundary") {
      const lines = [`${label} ${unmetFacts.length} unmet:`, ...unmetFacts.map((fact) => ` - ${fact.text}`), ...attention.map((fact) => ` - (attention) ${fact.text}`), tail];
      return decision("remind", lines.join("\n"), prior.window);
    }
    if (handoffReason) {
      writeReminderState(sessionDir, { window: 0, last_unmet_digest: null, file_hashes: fileHashes });
      const lines = [
        `${label} Handing off to you: ${handoffReason}. Task ${slug} at ${short(headSha)}.`,
        `Unmet (${unmetFacts.length}):`, ...unmetFacts.map((fact) => ` - ${fact.text}`),
        ...(attention.length ? ["Needs your call:", ...attention.map((fact) => ` - ${fact.text}`)] : []),
        ...(edits.length ? ["Locked-check edits:", ...edits.map((edit) => ` - ${edit}`)] : []),
        ` - ${external}`,
        tail,
      ];
      return decision("handoff", lines.join("\n"), count);
    }
    writeReminderState(sessionDir, { window: count, last_unmet_digest: digestNow, file_hashes: fileHashes });
    const lines = [
      `${label} Not done yet: ${unmetFacts.length} unmet (reminder ${count} of ${settings.maxReminders - 1}; then this goes to a human).`,
      ...unmetFacts.map((fact) => ` - ${fact.text}`),
      ...(changedSince.length ? [`Changed since the last reminder: ${listWithMore(changedSince)}.`] : []),
      `${tail}. Optional: flow-agents observe status`,
    ];
    return decision("remind", lines.join("\n"), count);
  }
}

/** True when the run's pinned definition declares observe semantics. */
export function definitionIsObserved(definition: unknown): boolean {
  return Boolean(definition && typeof definition === "object" && (definition as AnyObj).evidence_mode === "observed");
}
