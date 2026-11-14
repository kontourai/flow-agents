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
import { assertTrustedGitAncestor, execTrustedGitSync, isExactLowercaseCommitSha } from "./lib/trusted-git.js";
import { runObservedCommand } from "./lib/observed-command.js";
import { bindHolderRuntimeSession, holderBindingRecovery, type HolderSessionBinding } from "./lib/holder-session-binding.js";
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
/** Package-script indirection deeper than this is refused (unverifiable), never truncated. */
export const MAX_SCRIPT_DEPTH = 5;
/** Bounded output: at most this many fact lines in a reminder, and this many characters per line. */
const MAX_REMINDER_FACTS = 12;
const MAX_HANDOFF_ITEMS = 25;
const MAX_FACT_CHARS = 600;
/**
 * Hosts whose Stop hook deadline is known. The Stop-time re-run must finish well inside it, so the
 * budget is min(configured, deadline - STOP_RESERVE_MS). An unknown host gets no Stop-time re-run:
 * a check killed by the host produces no reminder at all, which is worse than asking for
 * `flow-agents observe verify`.
 */
const HOST_STOP_DEADLINE_MS: Record<string, number> = { "claude-code": 30000, codex: 30000, kiro: 5000 };
const STOP_RESERVE_MS = 8000;
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
export type LockedCheck = { criterion_id: string; command: string; command_sha256: string; files: LockedFile[]; scripts: LockedScript[]; unverifiable?: string | null };
/** `reset`: the ledger file exists but is empty; locks were written and then wiped. */
export type Ledger = { file: string; status: "absent" | "ok" | "broken" | "reset"; locks: Map<string, LockedCheck>; digest: string | null };

function hashFile(projectRoot: string, rel: string): string | null {
  try {
    return sha256(fs.readFileSync(path.join(projectRoot, rel)));
  } catch {
    return null;
  }
}

function packageScripts(projectRoot: string): AnyObj {
  const pkg = readJson(path.join(projectRoot, "package.json"));
  return pkg && pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
}

const NOT_A_SCRIPT = new Set(["install", "ci", "i", "add", "remove", "exec", "dlx", "x", "create", "init", "publish", "pack", "link", "version"]);

/**
 * The package script a command segment runs, or null when the segment is not a script invocation:
 * `npm test`/`npm t`/`npm start`, `npm run[-script] x`, `pnpm [run] x`, `yarn [run] x`.
 */
function packageScriptName(segment: string): string | null {
  const match = /^\s*(npm|pnpm|yarn)\s+(.*)$/.exec(segment);
  if (!match) return null;
  const tokens = match[2]!.trim().split(/\s+/).filter((token) => token && !token.startsWith("-"));
  const [first, second] = tokens;
  if (!first) return null;
  if (first === "run" || first === "run-script") return second ?? null;
  if (match[1] === "npm") {
    if (first === "t" || first === "tst") return "test";
    return ["test", "start", "stop", "restart"].includes(first) ? first : null;
  }
  return NOT_A_SCRIPT.has(first) ? null : first;
}

const UNRESOLVABLE_SHELL = /\$\(|`|\$\{?[A-Za-z_]|(^|[\s;&|])(?:eval|source|\.)\s/;

type CheckResolution = { files: string[]; scripts: LockedScript[]; unverifiable: string | null };

/**
 * Everything a check runs that the agent could change, resolved TRANSITIVELY: every package-script
 * body it reaches through npm/pnpm/yarn script indirection and `&&`/`;`/`|` chains (with any
 * pre/post scripts), and the files and directories its leaf commands name, plus files the criterion
 * declares. A weakened nested test or an edited nested script then changes a locked hash.
 * Resolution REFUSES rather than truncates: an undefined script, a script cycle, indirection deeper
 * than MAX_SCRIPT_DEPTH, or shell expansion that cannot be read statically makes the lock
 * `unverifiable`, which the engine reports instead of passing.
 */
export function resolveCheck(projectRoot: string, command: string, declared: string[]): CheckResolution {
  const scripts = packageScripts(projectRoot);
  const scriptHashes = new Map<string, string | null>();
  const candidates = new Set<string>(declared);
  let unverifiable: string | null = null;
  const visit = (text: string, depth: number, stack: string[]): void => {
    if (unverifiable) return;
    if (UNRESOLVABLE_SHELL.test(text)) { unverifiable = `${quoted(text, 80)} uses shell expansion that cannot be resolved statically`; return; }
    for (const segment of text.split(/&&|\|\||;|\|/)) {
      const name = packageScriptName(segment);
      if (name === null) {
        for (const token of segment.split(/[\s()<>"']+/)) {
          const clean = token.replace(/^\.\//, "");
          if (!clean || clean.startsWith("-") || path.isAbsolute(clean) || clean.split("/").includes("..")) continue;
          if (!/[./]/.test(clean)) continue;
          candidates.add(clean);
        }
        continue;
      }
      if (depth >= MAX_SCRIPT_DEPTH) { unverifiable = `package-script indirection is deeper than ${MAX_SCRIPT_DEPTH} levels (${[...stack, name].join(" → ")})`; return; }
      if (stack.includes(name)) { unverifiable = `package script cycle (${[...stack, name].join(" → ")})`; return; }
      if (typeof scripts[name] !== "string") { unverifiable = `package script "${name}" is not defined in package.json`; return; }
      for (const hook of [`pre${name}`, name, `post${name}`]) {
        if (typeof scripts[hook] !== "string") continue;
        scriptHashes.set(hook, sha256(scripts[hook]));
        visit(String(scripts[hook]), depth + 1, [...stack, name]);
        if (unverifiable) return;
      }
    }
  };
  visit(command, 0, []);
  const files = new Set<string>();
  for (const candidate of candidates) {
    const abs = path.join(projectRoot, candidate);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isFile()) files.add(candidate);
    else if (stat.isDirectory()) {
      let tracked: string[] = [];
      try { tracked = zList(git(projectRoot, ["ls-files", "-z", "--", candidate])); } catch { /* untracked directory */ }
      if (tracked.length > MAX_LOCKED_DIR_FILES && !unverifiable) unverifiable = `${candidate} holds more than ${MAX_LOCKED_DIR_FILES} tracked files; name the test files the check runs`;
      for (const file of tracked.slice(0, MAX_LOCKED_DIR_FILES)) files.add(file);
    }
  }
  return {
    files: [...files].sort(),
    scripts: [...scriptHashes].map(([name, sha]) => ({ name, sha256: sha })).sort((a, b) => a.name.localeCompare(b.name)),
    unverifiable,
  };
}

function lockFor(projectRoot: string, criterion: Criterion): LockedCheck {
  const command = criterion.command!;
  const resolved = resolveCheck(projectRoot, command, criterion.declaredFiles);
  return {
    criterion_id: criterion.id,
    command,
    command_sha256: sha256(command),
    files: resolved.files.map((rel) => ({ path: rel, sha256: hashFile(projectRoot, rel) })),
    scripts: resolved.scripts,
    unverifiable: resolved.unverifiable,
  };
}

export function readLedger(sessionDir: string): Ledger {
  const file = path.join(sessionDir, OBSERVE_LEDGER_FILE);
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { file, status: "absent", locks: new Map(), digest: null }; }
  // The engine never writes an empty ledger: an existing file with no records was wiped.
  if (!raw.trim()) return { file, status: "reset", locks: new Map(), digest: null };
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
  if (ledger.status === "broken" || ledger.status === "reset" || !acceptance.valid) return ledger;
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

/** A host runtime session (not process ancestry, not a coordination label): the only holder binding observe mode accepts. */
export function isHostRuntimeSessionSource(source: unknown): boolean {
  return typeof source === "string" && source.startsWith("runtime-session-id:");
}

/**
 * Why a critique of the current tree does not count, or null when it does. Re-derived at every
 * boundary against the assignment's CURRENT held sessions, so a binding recorded later
 * invalidates a review that turns out to be self-review (#1648 fix round):
 *  - the reviewer's session has held this assignment (same-session, possibly learned after the review);
 *  - the implementer was not bound to a host runtime session when the review was recorded
 *    (separation was undetermined then, so the review cannot be independent).
 */
function critiqueStanding(critique: AnyObj, heldRefs: string[]): string | null {
  const assurance = critique.metadata?.reviewer_assurance;
  const reviewer = assurance?.reviewer?.session_ref;
  if (typeof reviewer === "string" && heldRefs.includes(reviewer)) return "its reviewer session has held this assignment, so it is self-review";
  const implementer = assurance?.implementer;
  if (!implementer || !isHostRuntimeSessionSource(implementer.resolved_by)) {
    return "it was recorded before the worker's host runtime session was bound to the assignment, so reviewer separation was undetermined";
  }
  return null;
}

function currentCritiques(bundle: AnyObj | null, snapshot: GitWorktreeSnapshot | null, heldRefs: string[]): { current: AnyObj | null; latest: AnyObj | null; refused: string | null } {
  const claims = Array.isArray(bundle?.claims) ? bundle!.claims as AnyObj[] : [];
  const critiques = claims
    .filter((claim) => claim.claimType === "workflow.critique.review" && claim.metadata?.origin === "critique")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const latest = critiques.at(-1) ?? null;
  if (!latest || !snapshot) return { current: null, latest, refused: null };
  const target = latest.metadata?.review_target?.workspace_snapshot;
  const onTree = target && target.digest === snapshot.digest && target.head_sha === snapshot.head_sha && latest.value === "pass";
  if (!onTree) return { current: null, latest, refused: null };
  const refused = critiqueStanding(latest, heldRefs);
  return { current: refused ? null : latest, latest, refused };
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

/**
 * `locks` records every criterion lock ever seen (criterion id → lock entry digest) and only grows,
 * so a ledger that later loses or rewrites a lock is detected as a reset even after re-locking.
 */
type ReminderState = { present: boolean; window: number; last_unmet_digest: string | null; file_hashes: Record<string, string | null>; locks: Record<string, string> };

function readReminderState(sessionDir: string): ReminderState {
  const raw = readJson(path.join(sessionDir, OBSERVE_STATE_FILE));
  return {
    present: raw !== null,
    window: Number.isSafeInteger(raw?.window) && raw!.window >= 0 ? raw!.window : 0,
    last_unmet_digest: typeof raw?.last_unmet_digest === "string" ? raw.last_unmet_digest : null,
    file_hashes: raw?.file_hashes && typeof raw.file_hashes === "object" ? raw.file_hashes : {},
    locks: raw?.locks && typeof raw.locks === "object" && !Array.isArray(raw.locks) ? raw.locks : {},
  };
}

/** Returns the write error, or null. The caller fails closed: an unsaved count cannot bound reminders. */
function writeReminderState(sessionDir: string, state: Omit<ReminderState, "present">): string | null {
  try {
    fs.writeFileSync(path.join(sessionDir, OBSERVE_STATE_FILE), `${JSON.stringify(state)}\n`);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? (error as Error).message;
  }
}

function lockEntryDigest(lock: LockedCheck): string {
  return sha256(canonicalJson(lock));
}

function clip(text: string, max = MAX_FACT_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function boundedLines(items: string[], max: number, more: string): string[] {
  const lines = items.slice(0, max).map((item) => ` - ${clip(item)}`);
  if (items.length > max) lines.push(` - … and ${items.length - max} more (${more})`);
  return lines;
}

/** The host this process runs under: adapters stamp it; otherwise the shared runtime detector. */
function hostRuntimeFor(env: NodeJS.ProcessEnv): string {
  const stamped = String(env.FLOW_AGENTS_HOOK_RUNTIME || "").trim();
  if (stamped) return stamped;
  try {
    const engagement = requireCjs(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/hooks/lib/observe-engagement.js")) as { hostRuntime: (env: NodeJS.ProcessEnv) => string };
    return engagement.hostRuntime(env);
  } catch {
    return "unknown";
  }
}

/** The Stop-time re-run budget for this host, or null when no check can run inside its Stop deadline. */
export function stopBudgetFor(host: string, configuredMs: number): { budgetMs: number | null; deadlineMs: number | null; why: string } {
  const deadline = HOST_STOP_DEADLINE_MS[host] ?? null;
  if (configuredMs < 1000) return { budgetMs: null, deadlineMs: deadline, why: `Stop-time re-runs are disabled (FLOW_AGENTS_OBSERVE_VERIFY_BUDGET_MS=${configuredMs})` };
  if (deadline === null) return { budgetMs: null, deadlineMs: null, why: `the Stop hook does not run checks on ${host} (its Stop deadline is unknown)` };
  const budget = Math.min(configuredMs, deadline - STOP_RESERVE_MS);
  if (budget < 1000) return { budgetMs: null, deadlineMs: deadline, why: `the Stop hook does not run checks on ${host} (its Stop deadline is ${Math.round(deadline / 1000)} s)` };
  return { budgetMs: budget, deadlineMs: deadline, why: "" };
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
  // Conditions under which the reminder loop cannot be trusted to stay bounded or honest: always
  // released as an immediate handoff, never as a pass (fix round for #1649).
  const forcedHandoff: string[] = [];
  let reruns: RerunNote[] = [];
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

  // #1648: this process runs in the holder's runtime (the Stop hook or `observe verify`), so an
  // orchestrator-acquired claim gets the worker's session here at the latest. Never in status mode.
  let holderBinding: HolderSessionBinding | null = null;
  if (input.mode !== "status") {
    try { holderBinding = bindHolderRuntimeSession(sessionDir); } catch { holderBinding = null; }
  }

  // Definition layer: plan + acceptance files and the locks.
  const plan = readPlanFile(sessionDir, slug);
  const acceptance = readAcceptance(sessionDir);
  let ledger = readLedger(sessionDir);
  if (ledger.status === "broken") hard.push(`observe ledger integrity check FAILED (${path.relative(projectRoot, ledger.file)}): the check locks were edited or reordered. Restore it or ask an operator; locks are never rewritten.`);
  const priorState = readReminderState(sessionDir);
  if (ledger.status === "reset") forcedHandoff.push(`the observe ledger ${path.relative(projectRoot, ledger.file)} exists but is empty: its check locks were wiped, so they cannot be trusted or re-created`);
  if (input.mode !== "status") ledger = extendLocks(projectRoot, acceptance, ledger, now());
  // A lock seen before must still be in the ledger, byte-for-byte. Deleting or truncating the ledger
  // and re-locking a weakened check is caught here as long as the reminder state survives.
  const lostLocks = Object.entries(priorState.locks).filter(([id, digest]) => {
    const current = ledger.locks.get(id);
    return !current || lockEntryDigest(current) !== digest;
  }).map(([id]) => id);
  if (lostLocks.length) forcedHandoff.push(`the observe ledger lost or rewrote locks it held before (${listWithMore(lostLocks)}): it was deleted, truncated or reset, so the current locks cannot be trusted`);

  const accRel = path.relative(projectRoot, acceptance.path);
  const planRel = path.relative(projectRoot, plan.path);
  if (!acceptance.valid) push("acceptance", "acceptance-lock", "unmet", `${accRel}: ${acceptance.error}. Define criteria, each with a command evidence_ref ({"kind":"command","excerpt":"<check>"}) or status "accepted_gap" with notes.`);

  // The recorded base must be an ancestor of HEAD: `git diff` happily compares unrelated trees, so
  // replacing history with an unrelated root would otherwise satisfy scope.
  let baseIsAncestor = false;
  if (base && head) {
    try { assertTrustedGitAncestor(projectRoot, base, head); baseIsAncestor = true; } catch { baseIsAncestor = false; }
  }
  const scopeExcluded = [path.relative(projectRoot, path.dirname(sessionDir)).split(path.sep).join("/")];
  const changed = base ? changedSinceBase(projectRoot, base, scopeExcluded) : [];
  const fileHashes: Record<string, string | null> = {};
  for (const file of changed.slice(0, 500)) fileHashes[file] = hashFile(projectRoot, file);

  const definitionIssues: string[] = [];
  const gapIds: string[] = [];
  const lockedChecks: LockedCheck[] = [];
  const checkEdits: string[] = [];
  for (const criterion of acceptance.criteria) {
    const cite = `${accRel}:${criterion.id}`;
    const locked = ledger.locks.get(criterion.id);
    if (criterion.status === "accepted_gap") {
      // An agent-declared gap is a judgment for a HUMAN, never a truth the harness can treat as met.
      gapIds.push(criterion.id);
      if (criterion.notes) push(`gap:${criterion.id}`, "locked-criterion-checks", "gap", `criterion ${cite} not demonstrated${locked ? " (marked a gap after its check was locked)" : ""}; agent reason: ${criterion.notes}`);
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
    if (locked.unverifiable) {
      push(`unverifiable:${criterion.id}`, "acceptance-lock", "unmet", `${cite} locked check ${quoted(locked.command)} cannot be locked statically: ${locked.unverifiable}. Use a check whose scripts and test files can be resolved (a direct command, or package scripts at most ${MAX_SCRIPT_DEPTH} deep), or this needs a human.`);
    }
    // Re-resolve the locked command against today's package.json: every script it now reaches,
    // directly or nested, must be a locked script with an unchanged body.
    const nowResolved = resolveCheck(projectRoot, locked.command, criterion.declaredFiles);
    const scriptsNow = new Map(nowResolved.scripts.map((script) => [script.name, script.sha256]));
    const scriptNames = new Set([...locked.scripts.map((script) => script.name), ...scriptsNow.keys()]);
    for (const name of scriptNames) {
      const before = locked.scripts.find((script) => script.name === name)?.sha256;
      const after = scriptsNow.get(name);
      if (before !== undefined && before === after) continue;
      const what = before === undefined ? "was added to" : after === undefined ? "was removed from" : "changed in";
      checkEdits.push(`package.json script "${name}" ${what} the check of ${criterion.id}`);
      push(`edit:${criterion.id}:script:${name}`, "acceptance-lock", "unmet", `package.json script "${name}" ${what} the locked check of ${cite} after the lock (nested scripts included). Revert it.`);
    }
    if (!locked.unverifiable && nowResolved.unverifiable) {
      push(`unverifiable-now:${criterion.id}`, "acceptance-lock", "unmet", `${cite} locked check ${quoted(locked.command)} can no longer be resolved statically: ${nowResolved.unverifiable}. Revert the package.json change.`);
    }
    const lockedPaths = new Set(locked.files.map((file) => file.path));
    for (const added of nowResolved.files.filter((file) => !lockedPaths.has(file))) {
      const reason = plan.checkChangeReasons.get(added);
      checkEdits.push(`${added} now runs as part of the check of ${criterion.id}${reason ? `: ${reason}` : ""}`);
      if (reason) push(`edit:${criterion.id}:${added}`, "acceptance-lock", "attention", `${added} was added to the locked check of ${criterion.id} after the lock. Reason given: ${reason}`);
      else push(`edit:${criterion.id}:${added}`, "acceptance-lock", "unmet", `${added} now runs as part of the locked check of ${cite} but was not part of it at the lock. Remove it, or add "- \`${added}\`: <why>" under ## Check Changes in ${planRel}.`);
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
  else if (head && !baseIsAncestor) push("scope:ancestry", "git-scope", "unmet", `scope: the run's recorded base ${short(base)} is not an ancestor of HEAD ${short(head)}: history was replaced or rewritten, so the diff no longer describes this run's changes. Restore history that contains ${short(base)}, or start a new run.`);
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
  const host = hostRuntimeFor(input.env ?? process.env);
  const stopBudget = stopBudgetFor(host, settings.verifyBudgetMs);
  const canRerun = input.mode === "verify" || (input.mode === "boundary" && stopBudget.budgetMs !== null);
  if (canRerun && snapshot?.worktree_clean && hard.length === 0) {
    reruns = await rerunLockedChecks(projectRoot, sessionDir, lockedChecks.filter((lock) => !lock.unverifiable), snapshot, input.mode === "boundary" ? stopBudget.budgetMs : null, now);
  }
  const noStopRerun = input.mode === "boundary" && stopBudget.budgetMs === null;
  const log = readCommandLog(sessionDir);
  if (log.status === "broken") hard.push("command-log integrity check FAILED for the observe run: observations cannot be trusted.");

  let criteriaMet = 0;
  let testMet = 0;
  let testCapableCount = 0;
  for (const check of lockedChecks) {
    const criterion = acceptance.criteria.find((entry) => entry.id === check.criterion_id);
    if (!criterion || criterion.status === "accepted_gap") continue;
    if (check.unverifiable) continue;
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
    else if (rerun?.outcome === "budget-exceeded" || rerun?.outcome === "skipped-budget") why = `locked check ${quoted(check.command)} did not finish within the Stop budget (${stopBudget.budgetMs ?? 0} ms on ${host}); run \`flow-agents observe verify\` (${lastText}).`;
    else if (noStopRerun && !check.unverifiable) why = `locked check ${quoted(check.command)} has no result for this commit and lock, and ${stopBudget.why}: run \`flow-agents observe verify\` (${lastText}).`;
    else if (rerun?.outcome === "error") why = `locked check ${quoted(check.command)} could not be run (${rerun.detail ?? "error"}).`;
    else why = `locked check ${quoted(check.command)} has no result at ${short(head)} (${lastText}).`;
    push(`result:${check.criterion_id}`, "locked-criterion-checks", "unmet", `${cite} ${why}`);
  }
  if (acceptance.valid && testCapableCount === 0 && lockedChecks.length > 0) {
    push("tests", "locked-test-checks", "unmet", `no locked check is a recognised test run (a package test script or node --test/go test/cargo test). Add one to ${accRel}.`);
  }

  // Judgment record: the distinct-reviewer critique.
  const trustBundle = readJson(path.join(sessionDir, "trust.bundle"));
  const assignment = readJson(path.join(path.dirname(sessionDir), "assignment", `${slug}.json`));
  const heldRefs = [
    ...(Array.isArray(assignment?.runtime_session_refs) ? assignment!.runtime_session_refs.filter((ref: unknown): ref is string => typeof ref === "string") : []),
    ...(typeof assignment?.runtime_session_ref === "string" ? [assignment.runtime_session_ref] : []),
  ];
  const critique = currentCritiques(trustBundle, snapshot && snapshot.worktree_clean ? snapshot : null, heldRefs);
  // Only a HOST runtime session counts as the holder's binding: process ancestry (for example from
  // an orchestrator's own process) never does.
  const holderSessionMissing = Boolean(assignment) && !(typeof assignment!.runtime_session_ref === "string" && assignment!.runtime_session_ref && isHostRuntimeSessionSource(assignment!.runtime_session_source));
  if (!critique.current && critique.refused) {
    push("review", null, "unmet", `review: the critique of ${short(head)} does not count: ${critique.refused}. A separate reviewer session must record \`workflow critique\` again${holderSessionMissing ? " after the worker's host session is bound" : ""}.`);
  } else if (!critique.current && holderSessionMissing) {
    push("review", null, "unmet", `review: the worker's runtime session is not recorded on the assignment (an orchestrator acquired the claim from its own process), so no passing review can be recorded yet${holderBinding?.status === "no-runtime-session" ? "; this Stop could not record it because it is not running in the holder's runtime session" : ""}. ${holderBindingRecovery({ artifactRoot: path.dirname(sessionDir), slug, branch: typeof assignment!.branch === "string" ? assignment!.branch : undefined })}`);
  } else if (!critique.current) {
    const reviewed = critique.latest?.metadata?.review_target?.workspace_snapshot?.head_sha;
    push("review", null, "unmet", critique.latest
      ? `review: the latest critique (${String(critique.latest.value)}) reviewed ${short(reviewed)}${critique.latest.metadata?.review_target?.workspace_snapshot?.worktree_clean === false ? "+uncommitted" : ""}, not the current ${short(head)}. Have a separate reviewer session record \`workflow critique\` again.`
      : `review: no critique of ${short(head)} from a distinct reviewer. A separate reviewer session records \`workflow critique\` (review-work); the implementing session cannot.`);
  }

  // Attention items: never gates.
  for (const question of plan.openQuestions) push(`question:${question}`, null, "attention", `open question: ${question}`);
  for (const [file, reason] of plan.scopeReasons) if (changed.includes(file)) push(`scope-reason:${file}`, null, "attention", `scope reason for ${file}: ${reason}`);
  for (const issue of settings.issues) push(`setting:${issue}`, null, "attention", issue);

  for (const reason of forcedHandoff) push(`integrity:${reason.slice(0, 40)}`, "acceptance-lock", "unmet", `observe integrity: ${reason}. This needs a human.`);

  // Derive claims and let Flow decide.
  const unmet = (expectation: string) => facts.some((fact) => fact.expectation === expectation && fact.status === "unmet");
  const metByKind = new Map<string, { met: boolean; summary: string }>([
    ["acceptance-lock", { met: acceptance.valid && ledger.status === "ok" && forcedHandoff.length === 0 && ledger.locks.size > 0 && definitionIssues.length === 0 && !unmet("acceptance-lock"), summary: `locked ${ledger.locks.size} check(s), digest ${ledger.digest ?? "none"}` }],
    ["git-scope", { met: Boolean(base) && baseIsAncestor && plan.expectedDeclared && unexplained.length === 0 && Boolean(snapshot?.worktree_clean), summary: `${changed.length} changed since ${short(base)}; ${outside.length - unexplained.length} with scope reasons` }],
    ["locked-test-checks", { met: testMet > 0 && !unmet("locked-criterion-checks") && !unmet("locked-test-checks"), summary: `${testMet} passing locked test check(s) at ${short(head)}` }],
    ["locked-criterion-checks", { met: lockedChecks.length > 0 && gapIds.length === 0 && !unmet("locked-criterion-checks") && !unmet("acceptance-lock") && criteriaMet > 0, summary: `${criteriaMet} criterion check(s) pass at ${short(head)}${gapIds.length ? `; ${gapIds.length} accepted gap(s) not demonstrated: ${gapIds.join(", ")}` : ""}` }],
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
  if (!engineDefect && gate.status !== "pass" && !anyUnmet && gapIds.length === 0 && hard.length === 0) {
    engineDefect = `every observed fact is met but Flow refused ${gate.id} (${gate.status}; missing ${gate.missing.join(", ") || "none"})`;
  }
  if (engineDefect) push("engine", null, "unmet", `observe-mode engine defect: ${engineDefect}. This needs a human.`);

  // Defense in depth: a pass is reported only when Flow passed AND nothing is unmet AND no agent-declared gap exists.
  return finish(hard.length ? "hard" : (gate.status === "pass" && !anyUnmet && gapIds.length === 0 && !engineDefect) ? "satisfied" : "unmet" as any, hard, head, base, ledger.digest, checkEdits, gate);

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
    const lockMap = { ...priorState.locks };
    for (const [id, lock] of ledger.locks) if (!(id in lockMap)) lockMap[id] = lockEntryDigest(lock);
    if (kind === "satisfied") {
      const lines = [`${label} All observed truths are met at ${short(headSha)}; the work may stop.`, ...boundedLines(attention.map((fact) => fact.text), MAX_HANDOFF_ITEMS, "flow-agents observe status lists all"), ` - ${external}`, tail];
      if (input.mode === "boundary") {
        const error = writeReminderState(sessionDir, { window: 0, last_unmet_digest: null, file_hashes: {}, locks: lockMap });
        if (error) lines.splice(1, 0, ` - (attention) the observe reminder state could not be saved (${error}); later Stops will hand off until it can be.`);
      }
      return decision("satisfied", lines.join("\n"), 0);
    }
    const unmetFacts = facts.filter((fact) => fact.status === "unmet");
    const gaps = facts.filter((fact) => fact.status === "gap");
    const actionable = unmetFacts.filter((fact) => fact.key !== "engine" && !fact.key.startsWith("integrity:"));
    const digestNow = sha256(canonicalJson(unmetFacts.map((fact) => fact.text)));
    const changedSince = Object.keys(fileHashes).filter((file) => priorState.file_hashes[file] !== undefined && priorState.file_hashes[file] !== fileHashes[file]);
    const count = priorState.window + 1;
    if (input.mode !== "boundary") {
      const lines = [`${label} ${unmetFacts.length} unmet${gaps.length ? `, ${gaps.length} accepted gap(s) for a human` : ""}:`, ...boundedLines(unmetFacts.map((fact) => fact.text), MAX_HANDOFF_ITEMS, "fix these first"), ...boundedLines(attention.map((fact) => `(attention) ${fact.text}`), MAX_HANDOFF_ITEMS, "more attention items"), tail];
      return decision("remind", lines.join("\n"), priorState.window);
    }
    let handoffReason: string | null = null;
    if (forcedHandoff.length) handoffReason = "the observe records cannot be trusted (see Unmet)";
    else if (actionable.length === 0 && gaps.length) handoffReason = "every remaining item is an accepted gap the agent declared; a human must decide";
    else if (actionable.length === 0) handoffReason = "only items that need a human remain";
    // Loop safety from the runtime's own continuation signal, independent of persisted state: a
    // continuation whose reminder state is missing cannot prove progress, so it hands off.
    else if (input.stopHookActive === true && !priorState.present) handoffReason = "this Stop continues a refused Stop, but the reminder state is missing, so progress cannot be checked";
    else if (input.stopHookActive === true && priorState.last_unmet_digest === digestNow) handoffReason = "no progress since the last reminder";
    else if (count >= settings.maxReminders) handoffReason = `reminder cap reached (${settings.maxReminders} unmet stops)`;
    if (!handoffReason) {
      const error = writeReminderState(sessionDir, { window: count, last_unmet_digest: digestNow, file_hashes: fileHashes, locks: lockMap });
      // Fail closed: without a saved count the cap cannot bound the reminders.
      if (error) handoffReason = `the reminder state could not be saved (${error}), so the reminder cap cannot be enforced`;
    }
    if (handoffReason) {
      const persisted = writeReminderState(sessionDir, { window: 0, last_unmet_digest: null, file_hashes: fileHashes, locks: lockMap });
      const lines = [
        `${label} Handing off to you: ${handoffReason}. Task ${slug} at ${short(headSha)}.`,
        ...(unmetFacts.length ? [`Unmet (${unmetFacts.length}):`, ...boundedLines(unmetFacts.map((fact) => fact.text), MAX_HANDOFF_ITEMS, "flow-agents observe status lists all")] : []),
        ...(attention.length ? ["Needs your call:", ...boundedLines(attention.map((fact) => fact.text), MAX_HANDOFF_ITEMS, "flow-agents observe status lists all")] : []),
        ...(edits.length ? ["Locked-check edits:", ...boundedLines(edits, MAX_HANDOFF_ITEMS, "flow-agents observe status lists all")] : []),
        ` - ${external}`,
        ...(persisted ? [` - the observe reminder state could not be saved (${persisted}).`] : []),
        tail,
      ];
      return decision("handoff", lines.join("\n"), count);
    }
    const lines = [
      `${label} Not done yet: ${unmetFacts.length} unmet (reminder ${count} of ${settings.maxReminders - 1}; then this goes to a human).`,
      ...boundedLines(actionable.map((fact) => fact.text), MAX_REMINDER_FACTS, "flow-agents observe status lists all"),
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
