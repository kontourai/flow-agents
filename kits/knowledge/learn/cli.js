#!/usr/bin/env node
/**
 * `flow-agents learn`: mine your existing coding-agent transcripts for corrections you keep repeating, and propose
 * (never apply) rules, skills, hooks or executable checks for a human to ratify. No Flow run or kit adoption needed.
 *
 *   flow-agents learn [--since 30d|YYYY-MM-DD|ISO] [--dry-run] [--json] [--all-projects] [--transcripts DIR]...
 *                     [--ledger PATH] [--rules-file PATH] [--role NAME] [--min-occurrences N] [--min-sessions N] [--min-high-pain N]
 *
 * By default only sessions whose working directory is inside the current Git repository (any subdirectory or
 * worktree of it) count; see learn/scope.js. `--all-projects` reads every project and warns that their excerpts
 * will be written into this repository's ledger. `--infer-human` (off by default) lets a model judge whether an
 * `unknown`-origin turn was typed by a person; see learn/author.js.
 *
 * The model is the Datum role named by --role (default: the dream run's `extraction-default`), routed through Relay
 * and Dispatch exactly as the dream run's is. --dry-run makes no model call and writes nothing.
 *
 * Exit codes: 0 ran (including dry run and insufficient data), 1 failed, 2 usage or configuration (including no
 * model set up, and transcripts whose importer derives no message origin).
 *
 * @module learn/cli
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_ROLE } from "../dream/config.js";
import { createRoleRuntime } from "../dream/model.js";
import { modelJudge } from "./judge.js";
import { learnError, toolInvoker } from "./model.js";
import { DEFAULT_THRESHOLDS, SOURCE_FAMILY } from "./propose.js";
import { DEFAULT_SINCE_DAYS, runLearn } from "./run.js";
import { defaultLedger, resolveLedgerTarget } from "./ledger.js";

export { defaultLedger };
import { defaultTranscriptRoots } from "./sessions.js";

const CONFIGURATION_CODES = new Set([
  "LEARN_USAGE", "LEARN_CONFIG_INVALID", "LEARN_ORIGIN_UNAVAILABLE", "LEARN_LEDGER_CORRUPT", "LEARN_LEDGER_TRACKED", "LEARN_NOT_A_REPOSITORY",
  "DREAM_CONFIG_INVALID", "DREAM_MODEL_UNCONFIGURED", "DREAM_MODEL_UNAVAILABLE", "DREAM_MODEL_UNSUPPORTED",
]);
const DAY_MS = 86_400_000;
const USAGE = "usage: flow-agents learn [--since 30d|YYYY-MM-DD|ISO] [--dry-run] [--json] [--all-projects] [--infer-human] [--print-ledger-path] [--transcripts DIR]... [--ledger PATH] [--rules-file PATH] [--role NAME] [--min-occurrences N] [--min-sessions N] [--min-high-pain N]";

/** `30d`, `YYYY-MM-DD` (UTC midnight) or a full ISO-8601 timestamp. Anything else is refused. */
export function parseSince(value, nowMs) {
  const relative = /^([1-9][0-9]{0,3})d$/.exec(value);
  if (relative) return nowMs - Number(relative[1]) * DAY_MS;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
    if (Number.isFinite(ms)) return ms;
  }
  throw learnError("LEARN_USAGE", `--since must be Nd, YYYY-MM-DD or an ISO-8601 timestamp, not ${JSON.stringify(value)}`);
}

const NUMERIC = { "--min-occurrences": "minOccurrences", "--min-sessions": "minSessions", "--min-high-pain": "minHighPain" };

export function parseArgs(argv, nowMs = Date.now()) {
  const out = { dryRun: false, json: false, allProjects: false, inferHuman: false, transcripts: [], thresholds: {}, since: `${DEFAULT_SINCE_DAYS}d` };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") out.dryRun = true;
    else if (flag === "--json") out.json = true;
    else if (flag === "--all-projects") out.allProjects = true;
    else if (flag === "--infer-human") out.inferHuman = true;
    else if (flag === "--print-ledger-path") out.printLedgerPath = true;
    else if (flag === "-h" || flag === "--help") out.help = true;
    else if (["--since", "--transcripts", "--ledger", "--rules-file", "--role", ...Object.keys(NUMERIC)].includes(flag)) {
      const value = argv[(i += 1)];
      if (value === undefined || value.startsWith("--")) throw learnError("LEARN_USAGE", `missing value for ${flag}`);
      if (flag === "--transcripts") out.transcripts.push(path.resolve(value));
      else if (flag === "--ledger") out.ledger = path.resolve(value);
      else if (flag === "--rules-file") out.rulesFile = path.resolve(value);
      else if (flag === "--since") out.since = value;
      else if (flag === "--role") out.role = value;
      else {
        if (!/^(0|[1-9][0-9]{0,5})$/.test(value)) throw learnError("LEARN_USAGE", `${flag} must be a non-negative integer`);
        out.thresholds[NUMERIC[flag]] = Number(value);
      }
    } else throw learnError("LEARN_USAGE", `unknown option: ${flag}`);
  }
  out.sinceMs = parseSince(out.since, nowMs);
  return out;
}


/** AGENTS.md, else CLAUDE.md, in `dir` (a symlink to a file counts; readRulesFile then checks its target). */
export function defaultRulesFile(dir = process.cwd()) {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const file = path.join(dir, name);
    try {
      if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).isFile()) return file;
    } catch {
      // absent
    }
  }
  return null;
}

export function summarize(document) {
  const r = document.report;
  const lines = [
    `flow-agents learn (${SOURCE_FAMILY}, contract ${document.schema} v${document.version})${document.dry_run ? " [dry run: no model calls, nothing written]" : ""}`,
    `  scope: ${document.scope.kind === "repo" ? `this repository (${document.scope.repo}); ${r.sessions_out_of_scope} sessions from other projects ignored` : "ALL projects"}`,
    `  transcripts: ${r.files_seen} seen, ${r.files_read} read, ${r.sessions_read} sessions${Object.keys(r.files_skipped).length ? `; skipped ${Object.entries(r.files_skipped).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""}`,
    `  user messages: ${r.user_messages} (${Object.entries(r.user_messages_by_origin).sort().map(([k, v]) => `${k}=${v}`).join(", ") || "none"}); only origin human counts`,
    `  unknown-origin turns in window: ${r.unknown_turns_in_window}${r.infer_human ? ` (--infer-human: ${r.unknown_candidates} to judge${document.dry_run ? ` in ${r.author_batches} model batch(es)` : `, ${r.inferred_human_turns} judged human`})` : " (not counted; --infer-human would let a model judge them)"}`,
    `  human turns in window: ${r.human_turns_in_window} across ${r.human_sessions_in_window} sessions; ${r.continuation_pings_excluded} continuation pings excluded; ${r.candidates} to classify${document.dry_run ? ` in ${r.classify_batches} model batch(es)` : ""}`,
  ];
  if (!document.dry_run && document.outcome === "ok") {
    lines.push(`  classified: ${r.occurrences} general corrections/nudges/frustrations (${r.classified_invalid} refused by validation); ${r.themes} themes, ${r.qualifying_themes} over threshold; ${r.model_calls} model calls`);
    lines.push(`  effects measured on ratified proposals: ${r.effects_measured}; themes with an open proposal: ${r.themes_open}; themes held (ratified, not measured as failing): ${r.themes_held}`);
    for (const proposal of document.proposals) {
      const c = proposal.evidence.cost;
      lines.push(`  - [${proposal.already_proposed ? "already proposed" : "NEW"}] ${proposal.proposal_id}`);
      lines.push(`      rule: ${proposal.rule}`);
      lines.push(`      ${c.occurrences} times in ${c.sessions} sessions, ${c.high_pain} high-pain; enforcement: ${proposal.enforcement.recommended} (${proposal.enforcement.reason})`);
      if (proposal.authority === "inferred") lines.push(`      authority: INFERRED (${c.inferred_occurrences} of ${c.occurrences} occurrences are unknown-origin turns a model judged human)`);
      if (proposal.conflict) lines.push(`      CONFLICTS with ${proposal.conflict.file}:${proposal.conflict.line}: ${proposal.conflict.text}`);
      if (proposal.covered_by) lines.push(`      already in ${proposal.covered_by.file}:${proposal.covered_by.line}: ${proposal.covered_by.text}`);
    }
    if (document.proposals.length) {
      lines.push(`  review: ${document.review_items_path} (Survey ReviewItems); decide with`);
      lines.push("    scripts/telemetry/learning-review-decide.sh <ledger> <proposal-id> --ratify|--reject|--defer --decided-by NAME");
    }
  } else if (document.outcome !== "ok") {
    lines.push(`  outcome: ${document.outcome}`);
  }
  for (const note of document.notes) lines.push(`  note: ${note}`);
  return `${lines.join("\n")}\n`;
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: {write: Function}, stderr?: {write: Function}, env?: object, cwd?: string, nowMs?: number,
 *   createRuntime?: (role: string) => Promise<import("@kontourai/relay").ModelRuntime> }} [io]
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd(), nowMs = Date.now() } = io;
  try {
    const args = parseArgs(argv, nowMs);
    if (args.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    // One resolver for the CLI and for `@kontourai/flow-agents/learning-review-proposals` (ledger.js).
    const target = resolveLedgerTarget({ cwd, env, allProjects: args.allProjects });
    const ledgerPath = args.ledger ?? target.ledgerPath;
    if (args.printLedgerPath) {
      stdout.write(`${ledgerPath}\n`);
      return 0;
    }
    const roots = args.transcripts.length ? args.transcripts : defaultTranscriptRoots(env);
    if (roots.length === 0) throw learnError("LEARN_CONFIG_INVALID", "no transcript directory found (~/.claude/projects, ~/.codex/sessions); pass --transcripts DIR");
    for (const root of roots) {
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw learnError("LEARN_CONFIG_INVALID", `transcript directory not found: ${root}`);
    }
    const scope = target.scope;
    if (args.allProjects) {
      stderr.write("WARNING: --all-projects reads sessions from every repository on this machine; excerpts of corrections made in other repositories will be written into this repository's ledger.\n");
    }
    const rulesFile = args.rulesFile ?? defaultRulesFile(scope.kind === "repo" ? scope.root : cwd);
    let invoke;
    if (!args.dryRun) {
      const role = args.role ?? DEFAULT_ROLE;
      const runtime = io.createRuntime ? await io.createRuntime(role) : await createRoleRuntime({ role });
      invoke = toolInvoker(runtime);
    }
    const document = await runLearn({
      roots,
      // The default ledger is at the repository's main checkout, shared by all of its worktrees (ledger.js).
      ledgerPath,
      inferHuman: args.inferHuman,
      sinceMs: args.sinceMs,
      nowMs,
      scope,
      dryRun: args.dryRun,
      thresholds: { ...DEFAULT_THRESHOLDS, ...args.thresholds },
      rulesFile,
      ...(invoke ? { invoke, judge: modelJudge(invoke) } : {}),
    });
    stdout.write(args.json ? `${JSON.stringify(document)}\n` : summarize(document));
    return 0;
  } catch (error) {
    stderr.write(`${error.code ?? "LEARN_FAILED"}: ${String(error.message ?? error).slice(0, 400)}\n`);
    if (typeof error.help === "string") stderr.write(`${error.help}\n`);
    if (error.code === "LEARN_USAGE") stderr.write(`${USAGE}\n`);
    return CONFIGURATION_CODES.has(error.code) ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
