/**
 * The `kontour.learning-review-proposals` ledger, for `flow-agents learn` and for read-only consumers
 * (`@kontourai/flow-agents/learning-review-proposals`). One implementation of each piece:
 *
 *   - where a repository's ledger is (`resolveLearningReviewLedger`; the learn CLI resolves through `resolveLedgerTarget`,
 *     the same function, so the two cannot drift);
 *   - which repository a proposal belongs to (`scopeKey`, `scopeTag`, from scope.js);
 *   - the per-line schema (`ledgerLineSchema`, `validateLedgerLine`: `#/$defs/proposal` of the document schema);
 *   - reading it: `readLedger` (strict, for the writer: a bad line stops the run) and `readLearningReviewLedger`
 *     (tolerant, for a viewer: a bad line becomes a typed gap).
 *
 * Nothing here takes the ledger lock or writes anything.
 *
 * @module learn/ledger
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { validate } from "../providers/lib/schema-validate.js";
import { learnError } from "./model.js";
import { repoScope, scopeKey, scopeRecord, scopeTag } from "./scope.js";

export { scopeKey, scopeRecord, scopeTag };

/** The document schema, as shipped (and exported as `@kontourai/flow-agents/schemas/learning-review-proposals.schema.json`). */
export const LEDGER_SCHEMA_PATH = fileURLToPath(new URL("../../../scripts/telemetry/learning-review-proposals.schema.json", import.meta.url));
export const ledgerDocumentSchema = Object.freeze(JSON.parse(fs.readFileSync(LEDGER_SCHEMA_PATH, "utf8")));

/** One ledger line: the document schema's `#/$defs/proposal`, rooted so its `#/$defs/*` references resolve. */
export const ledgerLineSchema = Object.freeze({ ...ledgerDocumentSchema.$defs.proposal, $defs: ledgerDocumentSchema.$defs });

/** @returns {{ valid: boolean, errors: string[] }} */
export function validateLedgerLine(value) {
  return validate(value, ledgerLineSchema);
}

const LEDGER_FILE = path.join(".kontourai", "telemetry", "learning-review-proposals.jsonl");

/**
 * The ledger file for `dir`: `LEARNING_REVIEW_PROPOSALS_LEDGER` when set, else `<TELEMETRY_DATA_DIR or dir>/` plus
 * `.kontourai/telemetry/learning-review-proposals.jsonl`. A relative override resolves against `dir`.
 */
export function defaultLedger(env = process.env, dir = process.cwd()) {
  if (env.LEARNING_REVIEW_PROPOSALS_LEDGER) return path.resolve(dir, env.LEARNING_REVIEW_PROPOSALS_LEDGER);
  return path.join(env.TELEMETRY_DATA_DIR ? path.resolve(dir, env.TELEMETRY_DATA_DIR) : dir, LEDGER_FILE);
}

/**
 * Where `flow-agents learn` run in `cwd` keeps its ledger, and the repository scope it learns for. `scope` here is the
 * full scope (with `matches`, for reading sessions); `resolveLearningReviewLedger` returns its plain record.
 *
 * The default ledger is in the repository's main checkout (`git rev-parse --git-common-dir`), shared by every worktree;
 * a bare repository has no main checkout, so it stays in the worktree. Outside a repository it refuses
 * (`LEARN_NOT_A_REPOSITORY`) unless `allProjects`, whose ledger is in `cwd`. The env overrides win over both.
 */
export function resolveLedgerTarget({ cwd = process.cwd(), env = process.env, allProjects = false } = {}) {
  const dir = path.resolve(cwd);
  if (allProjects) return { ledgerPath: defaultLedger(env, dir), scope: { kind: "all-projects" } };
  const scope = repoScope(dir);
  if (!scope) throw learnError("LEARN_NOT_A_REPOSITORY", `${dir} is not inside a Git repository; run flow-agents learn in the repository to learn for, or pass --all-projects`);
  return { ledgerPath: defaultLedger(env, scope.ledgerRoot), scope };
}

/**
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, allProjects?: boolean }} [options]
 * @returns {{ ledgerPath: string, scope: { kind: "repo", repo: string } | { kind: "all-projects" } }}
 */
export function resolveLearningReviewLedger(options = {}) {
  const { ledgerPath, scope } = resolveLedgerTarget(options);
  return { ledgerPath, scope: scopeRecord(scope) };
}

/** Non-empty lines of a ledger file's text. A byte-order mark and CRLF line ends are accepted. */
export function ledgerLines(text) {
  const lines = [];
  text.replace(/^﻿/, "").split(/\r?\n/).forEach((line, index) => {
    if (line.trim() !== "") lines.push({ text: line, number: index + 1 });
  });
  return lines;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The writer's read: a line that is not a JSON object with a proposal_id stops the run before anything is written
 * (`LEARN_LEDGER_CORRUPT`). Returns the raw lines (kept byte for byte by a rewrite) and the parsed entries.
 */
export function readLedger(file) {
  const text = readText(file);
  if (text === null) return { lines: [], entries: [] };
  const lines = ledgerLines(text);
  const entries = lines.map(({ text: line, number }) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = null;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.proposal_id !== "string") {
      throw learnError("LEARN_LEDGER_CORRUPT", `ledger line ${number} of ${file} is not a proposal; repair it and retry (nothing was written)`);
    }
    return entry;
  });
  return { lines: lines.map((line) => line.text), entries };
}

const MAX_GAP_ERRORS = 5;

/**
 * The viewer's read: every line becomes an entry or a gap, never dropped silently. An entry is a line that validates
 * against the per-line schema; a gap says why one did not (`invalid-json`, `not-an-object`, `schema`), with its
 * 1-based line number. `scope` keeps only that repository's correction-recurrence entries (by `scopeKey`); kit and gate
 * entries carry no scope and are always returned. Takes no lock and writes nothing.
 *
 * @param {string} file
 * @param {{ scope?: { kind: "repo", repo: string } | { kind: "all-projects" } }} [options]
 */
export function readLearningReviewLedger(file, { scope } = {}) {
  const text = readText(file);
  if (text === null) return { exists: false, entries: [], gaps: [] };
  const wanted = scope === undefined ? null : scopeKey(scope);
  if (scope !== undefined && wanted === null) throw learnError("LEARN_CONFIG_INVALID", "scope must be { kind: \"repo\", repo } or { kind: \"all-projects\" }");
  const entries = [];
  const gaps = [];
  for (const { text: line, number } of ledgerLines(text)) {
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      gaps.push({ line: number, code: "invalid-json", message: String(error?.message ?? error).slice(0, 200) });
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      gaps.push({ line: number, code: "not-an-object", message: `line ${number} is ${Array.isArray(value) ? "an array" : JSON.stringify(value)?.slice(0, 40)}, not a proposal` });
      continue;
    }
    const { valid, errors } = validateLedgerLine(value);
    if (!valid) {
      gaps.push({ line: number, code: "schema", message: errors.slice(0, MAX_GAP_ERRORS).join("; "), ...(typeof value.proposal_id === "string" ? { proposal_id: value.proposal_id } : {}) });
      continue;
    }
    if (wanted !== null && value.pattern === "correction-recurrence" && scopeKey(value.scope) !== wanted) continue;
    entries.push(value);
  }
  return { exists: true, entries, gaps };
}
