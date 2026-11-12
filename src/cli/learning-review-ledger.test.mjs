// `@kontourai/flow-agents/learning-review-proposals`: the read-only ledger contract for other programs. Synthetic
// fixtures only. The resolver is checked against the real `flow-agents learn` CLI (`--print-ledger-path`, a child
// process) AND against literal expected paths, so a divergence on either side fails.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as published from "@kontourai/flow-agents/learning-review-proposals";
import * as ledger from "../../kits/knowledge/learn/ledger.js";
import * as scope from "../../kits/knowledge/learn/scope.js";
import { toolInvoker } from "../../kits/knowledge/learn/model.js";
import { runLearn } from "../../kits/knowledge/learn/run.js";
import { validate } from "../../kits/knowledge/providers/lib/schema-validate.js";
import { DAY_MS, NOW_MS, fix, recordingRuntime, sessionsWith, transcriptRoot, workspace } from "./learn-support.mjs";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const LEARN_CLI = path.join(ROOT, "kits", "knowledge", "learn", "cli.js");
const ANALYZER = path.join(ROOT, "scripts", "telemetry", "learning-review-proposals.sh");
const DECLARATIONS = "kits/knowledge/learn/learning-review-proposals.d.ts";
const LEDGER_FILE = path.join(".kontourai", "telemetry", "learning-review-proposals.jsonl");

// ── the published surface ────────────────────────────────────────────────────────────────────────────────────────

test("the subpath is the learn loop's own code, and its declarations name exactly its exports", () => {
  const declared = [...fs.readFileSync(path.join(ROOT, DECLARATIONS), "utf8").matchAll(/^export (?:const|function) (\w+)/gm)].map((match) => match[1]).sort();
  assert.deepEqual(Object.keys(published).sort(), declared);
  for (const name of Object.keys(published)) {
    const own = name in ledger ? ledger[name] : scope[name];
    assert.equal(published[name], own, `${name} is the canonical export, not a copy`);
  }
  assert.equal(published.LEDGER_SCHEMA_PATH, path.join(ROOT, "scripts", "telemetry", "learning-review-proposals.schema.json"));
});

test("the schema path export and the declarations work for a TypeScript consumer", () => {
  const exported = JSON.parse(fs.readFileSync(import.meta.resolve("@kontourai/flow-agents/schemas/learning-review-proposals.schema.json").replace("file://", ""), "utf8"));
  assert.equal(exported.$id, "https://kontourai.dev/schemas/kontour.learning-review-proposals/0.2.json");
  const run = spawnSync(process.execPath, [path.join(ROOT, "node_modules/typescript/bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", path.join(ROOT, "evals/fixtures/learning-review-proposals-host-types.mts")], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

// ── resolving the ledger: the same answer as flow-agents learn ───────────────────────────────────────────────────

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "LEARNING_REVIEW_PROPOSALS_LEDGER" && name !== "TELEMETRY_DATA_DIR"));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { stdio: "ignore" });

function repo() {
  const dir = fs.realpathSync(makeFixtureDir("ledger-repo-"));
  git(dir, "init", "-q");
  fs.mkdirSync(path.join(dir, "pkg", "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".kontourai/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

/** What `flow-agents learn --print-ledger-path` prints, run as a child in `cwd`. */
function cliLedger(cwd, env = {}, args = []) {
  const run = spawnSync(process.execPath, [LEARN_CLI, "--print-ledger-path", ...args], { cwd, env: { ...CLEAN_ENV, ...env }, encoding: "utf8" });
  return { status: run.status, path: run.stdout.trim(), stderr: run.stderr };
}

function agree(cwd, expected, env = {}, extra = {}) {
  const cli = cliLedger(cwd, env, extra.allProjects ? ["--all-projects"] : []);
  assert.equal(cli.status, 0, cli.stderr);
  const resolved = published.resolveLearningReviewLedger({ cwd, env, ...extra });
  assert.equal(cli.path, expected, "the CLI resolves the expected path");
  assert.equal(resolved.ledgerPath, expected, "the export resolves the expected path");
  return resolved;
}

test("main checkout: from the root or a subdirectory, the ledger is at the main checkout", () => {
  const main = repo();
  const expected = path.join(main, LEDGER_FILE);
  agree(main, expected);
  const { scope: resolvedScope } = agree(path.join(main, "pkg", "sub"), expected);
  assert.deepEqual(resolvedScope, { kind: "repo", repo: main.replace(process.env.HOME ?? "\u0000", "~") });
});

test("linked worktree: the ledger is the main checkout's, not the worktree's", () => {
  const main = repo();
  const worktree = path.join(fs.realpathSync(makeFixtureDir("ledger-wt-")), "lane");
  git(main, "worktree", "add", "-q", worktree);
  const { scope: fromWorktree } = agree(worktree, path.join(main, LEDGER_FILE));
  assert.deepEqual(fromWorktree, published.resolveLearningReviewLedger({ cwd: main }).scope, "one scope for every worktree");
});

test("bare repository: there is no main checkout, so the ledger is the worktree's", () => {
  const source = repo();
  const bare = path.join(fs.realpathSync(makeFixtureDir("ledger-bare-")), "project.git");
  execFileSync("git", ["clone", "-q", "--bare", source, bare], { stdio: "ignore" });
  const worktree = path.join(path.dirname(bare), "work");
  git(bare, "worktree", "add", "-q", worktree);
  agree(worktree, path.join(worktree, LEDGER_FILE));
});

test("LEARNING_REVIEW_PROPOSALS_LEDGER and TELEMETRY_DATA_DIR override, relative to the directory resolved from", () => {
  const main = repo();
  const elsewhere = fs.realpathSync(makeFixtureDir("ledger-env-"));
  const sub = path.join(main, "pkg");
  agree(sub, path.join(elsewhere, "custom.jsonl"), { LEARNING_REVIEW_PROPOSALS_LEDGER: path.join(elsewhere, "custom.jsonl") });
  agree(sub, path.join(elsewhere, LEDGER_FILE), { TELEMETRY_DATA_DIR: elsewhere });
  // The ledger override wins over the data dir; a relative value resolves against the main checkout.
  agree(sub, path.join(main, "rel", "l.jsonl"), { LEARNING_REVIEW_PROPOSALS_LEDGER: "rel/l.jsonl", TELEMETRY_DATA_DIR: elsewhere });
  agree(sub, path.join(main, "data", LEDGER_FILE), { TELEMETRY_DATA_DIR: "data" });
});

test("outside a repository both refuse, and --all-projects keeps the ledger where it runs", () => {
  const plain = fs.realpathSync(makeFixtureDir("ledger-plain-"));
  const cli = cliLedger(plain);
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /LEARN_NOT_A_REPOSITORY/);
  assert.throws(() => published.resolveLearningReviewLedger({ cwd: plain, env: {} }), { code: "LEARN_NOT_A_REPOSITORY" });
  const { scope: all } = agree(plain, path.join(plain, LEDGER_FILE), {}, { allProjects: true });
  assert.deepEqual(all, { kind: "all-projects" });
});

// ── reading it ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A ledger written by the real writers: `runLearn` (v0.2) and the v0.1 bash analyzer. */
async function writtenLedger() {
  const ws = workspace();
  const sessions = sessionsWith(Array.from({ length: 5 }, () => [fix("fetch-main"), "hello"]));
  await runLearn({ roots: [transcriptRoot(sessions)], ledgerPath: ws.ledger, nowMs: NOW_MS, sinceMs: NOW_MS - 60 * DAY_MS, invoke: toolInvoker(recordingRuntime()), scope: { kind: "all-projects" } });
  const pp = path.join(ROOT, "evals", "fixtures", "learning-review-proposals", "pattern-present");
  const analyzer = spawnSync("bash", [ANALYZER, "--sessions-root", path.join(pp, "sessions"), "--ledger", ws.ledger, path.join(pp, "economics.jsonl")], { encoding: "utf8" });
  assert.equal(analyzer.status, 0, analyzer.stderr);
  return ws.ledger;
}

test("a ledger the real writers produced reads as typed entries with no gaps", async () => {
  const file = await writtenLedger();
  const { exists, entries, gaps } = published.readLearningReviewLedger(file);
  assert.equal(exists, true);
  assert.deepEqual(gaps, []);
  const patterns = entries.map((entry) => entry.pattern);
  assert.ok(patterns.includes("correction-recurrence"), JSON.stringify(patterns));
  assert.ok(patterns.some((pattern) => pattern.startsWith("kit-") || pattern.startsWith("gate-")), JSON.stringify(patterns));
  const learned = entries.find((entry) => entry.pattern === "correction-recurrence");
  assert.ok(learned.proposal_id.endsWith(`-${published.scopeTag(learned.scope)}`), "ids carry the scope tag the export computes");
});

test("corrupt lines become typed gaps with their line numbers, never dropped; BOM and CRLF are tolerated", async () => {
  const file = await writtenLedger();
  const good = fs.readFileSync(file, "utf8").trim().split("\n");
  const learned = JSON.parse(good.find((line) => line.includes('"correction-recurrence"')));
  const noCitations = { ...learned, proposal_id: "bad-citations", evidence: { ...learned.evidence, defect: { ...learned.evidence.defect, citations: [] } } };
  const longExcerpt = structuredClone(learned);
  longExcerpt.proposal_id = "long-excerpt";
  longExcerpt.evidence.defect.citations[0].excerpt = "x".repeat(201);
  const kitLine = JSON.parse(good.find((line) => line.includes('"kit-review-cost-inflation"')));
  const kitAsSkill = { ...kitLine, proposal_id: "kit-as-skill", target: { kind: "skill", id: "x" } };
  const lines = [good[0], "{not json", "[1,2]", JSON.stringify({ hello: "world" }), JSON.stringify(noCitations), JSON.stringify(longExcerpt), JSON.stringify(kitAsSkill), ...good.slice(1)];
  fs.writeFileSync(file, `﻿${lines.join("\r\n")}\r\n`);
  const { entries, gaps } = published.readLearningReviewLedger(file);
  assert.equal(entries.length, good.length, "every good line is still an entry");
  assert.deepEqual(gaps.map((gap) => [gap.line, gap.code]), [[2, "invalid-json"], [3, "not-an-object"], [4, "schema"], [5, "schema"], [6, "schema"], [7, "schema"]]);
  assert.deepEqual(gaps.slice(3).map((gap) => gap.proposal_id), ["bad-citations", "long-excerpt", "kit-as-skill"]);
  assert.match(gaps[2].message, /missing required property 'proposal_id'/);
  assert.match(gaps[4].message, /maxLength 200/);
  // The writer's strict read refuses the same file.
  assert.throws(() => ledger.readLedger(file), { code: "LEARN_LEDGER_CORRUPT" });
});

test("a scope keeps that repository's correction-recurrence entries and every kit or gate entry", async () => {
  const file = await writtenLedger();
  const good = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const learned = good.find((entry) => entry.pattern === "correction-recurrence");
  const mine = { kind: "repo", repo: "~/dev/mine" };
  const theirs = { kind: "repo", repo: "~/dev/theirs" };
  const as = (s) => ({ ...learned, scope: s, proposal_id: `${learned.proposal_id.replace(/-all$/, "")}-${published.scopeTag(s)}` });
  fs.appendFileSync(file, `${JSON.stringify(as(mine))}\n${JSON.stringify(as(theirs))}\n`);
  const ids = (s) => published.readLearningReviewLedger(file, s ? { scope: s } : {}).entries.map((entry) => `${entry.pattern}:${published.scopeKey(entry.scope) ?? "-"}`).sort();
  const kitGate = ids().filter((id) => !id.startsWith("correction-recurrence"));
  assert.ok(kitGate.length > 0);
  assert.deepEqual(ids(mine), [...kitGate, "correction-recurrence:repo:~/dev/mine"].sort());
  assert.deepEqual(ids({ kind: "all-projects" }), [...kitGate, "correction-recurrence:all-projects"].sort());
  assert.equal(ids().length, kitGate.length + 3, "no scope: everything");
  assert.throws(() => published.readLearningReviewLedger(file, { scope: { kind: "nope" } }), { code: "LEARN_CONFIG_INVALID" });
});

test("a missing ledger is reported as not existing, not as an error", () => {
  const missing = path.join(fs.realpathSync(makeFixtureDir("ledger-missing-")), "none.jsonl");
  assert.deepEqual(published.readLearningReviewLedger(missing), { exists: false, entries: [], gaps: [] });
});

test("the shipped validator applies allOf, if/then/else and not, as the document schema needs", () => {
  const document = { schema: "kontour.learning-review-proposals", version: "0.1", window: { since: null, until: null }, outcome: "ok", aggregates: { by_kit: [], by_gate: [], partial: false }, proposals: [] };
  assert.equal(validate(document, published.ledgerDocumentSchema).valid, true);
  assert.equal(validate({ ...document, source_family: "correction-recurrence" }, published.ledgerDocumentSchema).valid, false, "not: a v0.1 document has no source family");
  assert.equal(validate({ ...document, outcome: "origin-unavailable" }, published.ledgerDocumentSchema).valid, false, "if/then: a v0.1 outcome");
  const ifElse = { if: { type: "string" }, then: { minLength: 2 }, else: { minimum: 5 } };
  assert.deepEqual([validate("ab", ifElse).valid, validate("a", ifElse).valid, validate(7, ifElse).valid, validate(3, ifElse).valid], [true, false, true, false]);
});
