import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as contract from "../../build/src/assignment-contract.js";
import * as github from "../../build/src/assignment-github.js";
import { createLocalFileAssignmentProvider, assignmentFilePath } from "../../build/src/assignment-local-file.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const {
  computeEffectiveState, decideTakeover, decodeAssignmentClaimRecord, findAssignmentClaimRecordProblems,
  humanHeldDisposition, isAutoSupersedable, isTakeoverGraceElapsed, parseAssignmentClaimRecord,
  serializeActor, sanitizeSegment, serializeAssignmentClaimRecord, TAKEOVER_RULES, DEFAULT_TAKEOVER_GRACE_SECONDS,
  canonicalHolderActorKey, isHumanActor, resolveEffectiveState,
} = contract;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const require = createRequire(import.meta.url);
const NOW = Date.parse("2026-10-05T12:00:00Z");

const AGENT = { runtime: "claude-code", session_id: "session-a", host: "host-a", human: null };
const OTHER = { runtime: "claude-code", session_id: "session-b", host: "host-a", human: null };
const HUMAN = { runtime: "human", session_id: "brian", host: "laptop", human: "brian" };
const AGENT_KEY = serializeActor(AGENT);

function claimRecord(actor, overrides = {}) {
  return {
    schema_version: "1.0", role: "AssignmentClaimRecord", subject_id: "subject-1", actor,
    claimed_at: "2026-10-05T11:00:00Z", ttl_seconds: 1800, branch: "agent/x/subject-1",
    artifact_dir: ".kontourai/flow-agents/subject-1", status: "claimed", ...overrides,
  };
}
const statusOf = (record, assignee = record ? serializeActor(record.actor) : null) => ({ subject_id: "subject-1", provider: "test", assignee, record });
const fresh = (actor) => [{ actor, lastAt: "2026-10-05T11:59:00Z", ttlSeconds: 1800, fresh: true }];

// ─── The ADR 0021 join table: every row, with the expected state READ FROM THE ADR ──────────────

function adrJoinRows() {
  const adr = fs.readFileSync(path.join(REPO, "docs/adr/0021-assignment-leases-and-stale-claim-takeover.md"), "utf8");
  const start = adr.indexOf("| Assignment | Liveness | Effective state |");
  assert.ok(start >= 0, "the ADR 0021 join table must still exist");
  const rows = [];
  for (const line of adr.slice(start).split("\n").slice(2)) {
    if (!line.startsWith("|")) break;
    const [assignment, liveness, effective] = line.split("|").slice(1, 4).map((cell) => cell.trim());
    rows.push({ assignment, liveness, state: /\*\*([a-z-]+)\*\*/.exec(effective)[1] });
  }
  return rows;
}

// One scenario per ADR row, keyed by the row's own Assignment/Liveness cells.
const SCENARIOS = {
  "assigned|fresh heartbeat": () => computeEffectiveState(statusOf(claimRecord(AGENT)), fresh(AGENT_KEY), serializeActor(OTHER), NOW),
  "assigned|stale / absent": () => computeEffectiveState(statusOf(claimRecord(AGENT)), [], serializeActor(OTHER), NOW),
  "assigned (human)|n/a (humans don't heartbeat)": () => computeEffectiveState(statusOf(claimRecord(HUMAN)), [], serializeActor(OTHER), NOW),
  "unassigned|fresh (claim only)": () => computeEffectiveState(statusOf(null), fresh(AGENT_KEY), serializeActor(OTHER), NOW),
  "unassigned|absent": () => computeEffectiveState(statusOf(null), [], serializeActor(OTHER), NOW),
};

test("the join covers every ADR 0021 table row, and each row's effective state is the ADR's", () => {
  const rows = adrJoinRows();
  assert.equal(rows.length, 5, "the ADR table has five rows; a new row needs a scenario here");
  for (const row of rows) {
    const scenario = SCENARIOS[`${row.assignment}|${row.liveness}`];
    assert.ok(scenario, `no scenario for ADR row ${row.assignment} / ${row.liveness}`);
    assert.equal(scenario().effective_state, row.state, `ADR row ${row.assignment} / ${row.liveness}`);
  }
  assert.deepEqual(new Set(rows.map((r) => r.state)), new Set(["held", "reclaimable", "human-held", "free"]));
});

test("join reasons name which row fired", () => {
  assert.equal(SCENARIOS["assigned|fresh heartbeat"]().reason, "fresh_liveness_heartbeat");
  assert.equal(SCENARIOS["assigned|stale / absent"]().reason, "assignment_present_liveness_stale_or_absent");
  assert.equal(SCENARIOS["assigned (human)|n/a (humans don't heartbeat)"]().reason, "assignee_is_human");
  assert.equal(SCENARIOS["unassigned|fresh (claim only)"]().reason, "liveness_claim_present_assignment_lagging");
  assert.equal(SCENARIOS["unassigned|absent"]().reason, "no_assignment_no_liveness");
});

test("human rule: a human assignee is human-held no matter how idle or what liveness says", () => {
  const ancient = claimRecord(HUMAN, { claimed_at: "2020-01-01T00:00:00Z" });
  for (const live of [[], fresh(serializeActor(HUMAN)), fresh(AGENT_KEY)]) {
    const result = computeEffectiveState(statusOf(ancient), live, serializeActor(OTHER), NOW);
    assert.equal(result.effective_state, "human-held");
    assert.ok(result.holder.idle_days > 2000, "idle duration is reported, never used to reclaim");
  }
  assert.equal(isAutoSupersedable({ effective_state: "human-held" }), false);
});

test("human rule gates on the actor's `human` field, not a username heuristic", () => {
  const humanishName = { runtime: "claude-code", session_id: "brian", host: "brian-laptop", human: null };
  assert.equal(computeEffectiveState(statusOf(claimRecord(humanishName)), [], undefined, NOW).effective_state, "reclaimable");
  const blankHuman = { ...AGENT, human: "   " };
  assert.equal(isHumanActor(blankHuman), false);
  assert.equal(computeEffectiveState(statusOf(claimRecord(blankHuman)), [], undefined, NOW).effective_state, "reclaimable");
  assert.equal(isHumanActor(HUMAN), true);
});

test("an assignee with no parseable claim record is human-held (ask first), never reclaimable", () => {
  const result = computeEffectiveState({ subject_id: "s", provider: "github", assignee: "octocat", record: null }, [], undefined, NOW);
  assert.equal(result.effective_state, "human-held");
  assert.equal(result.reason, "assignee_without_claim_record");
});

test("self recognition and the canonical holder key", () => {
  assert.equal(computeEffectiveState(statusOf(claimRecord(AGENT)), [], AGENT_KEY, NOW).reason, "self_is_holder");
  // An explicit-override actor: the stored actor_key is the bare token, NOT serializeActor(actor).
  const explicit = claimRecord({ runtime: "explicit-override", session_id: "canonical-x", host: "h", human: null }, { actor_key: "canonical-x" });
  assert.equal(canonicalHolderActorKey(explicit), "canonical-x");
  assert.equal(computeEffectiveState(statusOf(explicit), [], "canonical-x", NOW).reason, "self_is_holder");
  assert.equal(computeEffectiveState(statusOf(explicit), fresh("canonical-x"), "someone-else", NOW).effective_state, "held");
  // A pre-actor_key record falls back to the serialized actor.
  assert.equal(canonicalHolderActorKey(claimRecord(AGENT)), AGENT_KEY);
});

test("a released or superseded record is not an assignment", () => {
  assert.equal(computeEffectiveState(statusOf(claimRecord(AGENT, { status: "released" }), null), [], undefined, NOW).effective_state, "free");
  assert.equal(computeEffectiveState(statusOf(claimRecord(AGENT, { status: "superseded" }), null), [], undefined, NOW).effective_state, "free");
});

test("an unparseable claimed_at reports idle_days null instead of throwing", () => {
  const result = computeEffectiveState(statusOf(claimRecord(HUMAN, { claimed_at: "not-a-date" })), [], undefined, NOW);
  assert.equal(result.holder.idle_days, null);
});

test("resolveEffectiveState joins a host liveness source; a host that stops reporting ages into reclaimable", async () => {
  const status = statusOf(claimRecord(AGENT));
  const live = { freshHolders: async () => fresh(AGENT_KEY) };
  const silent = { freshHolders: () => [] };
  assert.equal((await resolveEffectiveState(status, live, { selfActor: serializeActor(OTHER), nowMs: NOW })).effective_state, "held");
  assert.equal((await resolveEffectiveState(status, silent, { selfActor: serializeActor(OTHER), nowMs: NOW })).effective_state, "reclaimable");
  const seen = [];
  await resolveEffectiveState(status, { freshHolders: (...args) => { seen.push(args); return []; } }, { selfActor: "me", nowMs: NOW });
  assert.deepEqual(seen, [["subject-1", "me", NOW]]);
});

// ─── Takeover rules ──────────────────────────────────────────────────────────────────────────────

test("takeover: only reclaimable is auto-supersedable; a human is never eligible", () => {
  assert.deepEqual(TAKEOVER_RULES.autoSupersedableStates, ["reclaimable"]);
  assert.deepEqual(TAKEOVER_RULES.neverAutoSupersede, ["human-held"]);
  for (const [state, expected] of [["reclaimable", true], ["held", false], ["human-held", false], ["free", false]]) {
    assert.equal(isAutoSupersedable({ effective_state: state }), expected, state);
  }
});

test("takeover decisions per join result (ADR 0021 §5/§6)", () => {
  assert.deepEqual(decideTakeover({ effective_state: "reclaimable", reason: "x" }), { ok: true, action: "grace-then-supersede" });
  assert.deepEqual(decideTakeover({ effective_state: "held", reason: "self_is_holder" }), { ok: true, action: "proceed" });
  assert.deepEqual(decideTakeover({ effective_state: "held", reason: "fresh_liveness_heartbeat" }), { ok: false, action: "back-off" });
  assert.deepEqual(decideTakeover({ effective_state: "human-held", reason: "x" }), { ok: false, action: "ask-first" });
  assert.deepEqual(decideTakeover({ effective_state: "free", reason: "x" }), { ok: true, action: "claim" });
});

test("takeover rules are frozen data", () => {
  assert.equal(Object.isFrozen(TAKEOVER_RULES), true);
  assert.equal(Object.isFrozen(TAKEOVER_RULES.autoSupersedableStates), true);
  assert.equal(Object.isFrozen(TAKEOVER_RULES.humanAssignee), true);
  assert.throws(() => { TAKEOVER_RULES.graceSeconds = 0; }, TypeError);
  assert.deepEqual({ ...TAKEOVER_RULES.humanAssignee }, { behavior: "ask_first", idle_threshold_days: 3 });
});

test("grace beat: elapsed exactly at the interval, not before", () => {
  const start = NOW;
  assert.equal(isTakeoverGraceElapsed(start, start + 59_999), false);
  assert.equal(isTakeoverGraceElapsed(start, start + 60_000), true);
  assert.equal(isTakeoverGraceElapsed(start, start + 9_999, 10), false);
  assert.equal(isTakeoverGraceElapsed(start, start + 10_000, 10), true);
});

test("human policy: ask_first surfaces only a known-idle assignment; never_reclaim never surfaces; never a supersede", () => {
  const idle = (days) => ({ effective_state: "human-held", reason: "assignee_is_human", holder: { idle_days: days } });
  const ask = { behavior: "ask_first", idle_threshold_days: 3 };
  assert.equal(humanHeldDisposition(idle(3), ask), "surface");
  assert.equal(humanHeldDisposition(idle(2), ask), "leave");
  assert.equal(humanHeldDisposition(idle(null), ask), "leave");
  assert.equal(humanHeldDisposition(idle(999), { behavior: "never_reclaim", idle_threshold_days: 3 }), "leave");
  assert.equal(humanHeldDisposition(idle(3)), "surface", "defaults to ask_first / 3 days");
  assert.equal(humanHeldDisposition({ effective_state: "reclaimable", reason: "x" }, ask), "leave");
});

// ─── Parity with the hook runtime's CJS copies ───────────────────────────────────────────────────

test("serializeActor / sanitizeSegment match scripts/hooks/lib/actor-identity.js over a corpus", () => {
  const helper = require(path.join(REPO, "scripts/hooks/lib/actor-identity.js"));
  const values = ["", null, undefined, 0, "a:b", "x".repeat(200), "héllo wörld", "a b\tc\n", "../../etc", "ok-1_2.3", "::::", "🙂", "  ", "A".repeat(64), "A".repeat(65)];
  for (const v of values) assert.equal(sanitizeSegment(v), helper.sanitizeSegment(v), `sanitizeSegment(${JSON.stringify(v)})`);
  for (const runtime of values) for (const human of [undefined, null, "", "  ", "brian", "b:r"]) {
    const actor = { runtime, session_id: "s:1", host: "h", human };
    assert.equal(serializeActor(actor), helper.serializeActor(actor));
  }
  assert.equal(serializeActor(undefined), helper.serializeActor(undefined));
});

test("DEFAULT_TAKEOVER_GRACE_SECONDS is the hook runtime's default heartbeat interval", () => {
  const policy = require(path.join(REPO, "scripts/hooks/lib/liveness-policy.js"));
  assert.equal(DEFAULT_TAKEOVER_GRACE_SECONDS, policy.DEFAULT_HEARTBEAT_THROTTLE_SECONDS);
  assert.equal(TAKEOVER_RULES.graceSeconds, DEFAULT_TAKEOVER_GRACE_SECONDS);
  assert.equal(DEFAULT_TAKEOVER_GRACE_SECONDS, 60, "pinned literal beside the derived comparison");
});

test("the CLI's `status` output is the contract's join (one implementation)", () => {
  const dir = path.join(REPO, "evals/fixtures/assignment-provider");
  const out = JSON.parse(execFileSync(process.execPath, [
    path.join(REPO, "build/src/cli.js"), "assignment-provider", "status", "--provider", "github",
    "--issue-json", path.join(dir, "github-issue-claimed.json"), "--repo", "kontourai/flow-agents",
    "--liveness-events-json", path.join(dir, "liveness-fresh.json"), "--self-actor", "someone-else", "--now", "2026-06-01T12:20:00Z",
  ], { encoding: "utf8" }));
  const direct = computeEffectiveState(out.assignment, JSON.parse(fs.readFileSync(path.join(dir, "liveness-fresh.json"), "utf8")).map((e) => ({ actor: e.actor, lastAt: e.at, ttlSeconds: e.ttlSeconds, fresh: true })), "someone-else", Date.parse("2026-06-01T12:20:00Z"));
  assert.deepEqual(out.effective, direct);
  assert.equal(out.effective.effective_state, "held");
});

// ─── Claim-record codec: round trips on records the real writers produce ─────────────────────────

test("codec: local-file records round-trip byte for byte (claim, supersede, release)", () => {
  const dir = makeFixtureDir("assignment-codec-");
  try {
    const provider = createLocalFileAssignmentProvider(dir);
    const file = assignmentFilePath(dir, "subject-1");
    provider.claim("subject-1", AGENT, { ttlSeconds: 1800, branch: "agent/a/subject-1", artifactDir: ".kontourai/flow-agents/subject-1", actorKey: "key-a", workItemRef: "TASK-42" });
    provider.supersede("subject-1", AGENT, OTHER, { reason: "stale takeover" });
    provider.release("subject-1", OTHER, { reason: "session end" });
    const bytes = fs.readFileSync(file, "utf8");
    const decoded = parseAssignmentClaimRecord(bytes);
    assert.equal(decoded.ok, true);
    assert.equal(serializeAssignmentClaimRecord(decoded.record), bytes, "the record re-encodes to the exact bytes the writer produced");
    assert.equal(decoded.record.status, "released");
    assert.equal(decoded.record.audit_trail.length, 3);
    assert.equal(decoded.record.work_item_ref, "TASK-42", "work_item_ref is opaque to the codec: a host Task id survives");
    assert.deepEqual(findAssignmentClaimRecordProblems(decoded.record), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("codec: a record written by the built CLI reads back and re-encodes unchanged", () => {
  const dir = makeFixtureDir("assignment-codec-cli-");
  try {
    const actorFile = path.join(REPO, "evals/fixtures/assignment-provider/actor-a.json");
    execFileSync(process.execPath, [path.join(REPO, "build/src/cli.js"), "assignment-provider", "claim", "--provider", "local-file",
      "--artifact-root", dir, "--subject-id", "cli-subject", "--branch", "agent/a/cli", "--artifact-dir", ".kontourai/flow-agents/cli-subject", "--actor-json", actorFile], { encoding: "utf8" });
    const bytes = fs.readFileSync(assignmentFilePath(dir, "cli-subject"), "utf8");
    const decoded = parseAssignmentClaimRecord(bytes);
    assert.equal(decoded.ok, true);
    assert.equal(serializeAssignmentClaimRecord(decoded.record), bytes);
    assert.equal(decoded.record.actor.session_id, "eval-actor-a-session");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function githubInput(overrides = {}) {
  return {
    repo: { owner: "kontourai", name: "flow-agents" }, issue_number: 4242, assignee_login: "bot", label_name: undefined,
    ttl_seconds: 1800, branch: "agent/a/x", artifact_dir: ".kontourai/flow-agents/x", actor_key: AGENT_KEY, work_item_ref: "kontourai/flow-agents#4242", ...overrides,
  };
}

test("codec: the GitHub claim comment round-trips (render -> parse -> re-render is identical)", () => {
  const rendered = github.renderGithubClaim("kontourai/flow-agents#4242", githubInput(), AGENT, "2026-10-05T11:00:00Z");
  const issue = { number: 4242, assignees: ["bot"], labels: ["agent:claimed"], comments: [{ id: 7, body: rendered.claim_comment_body, author: "bot", createdAt: "2026-10-05T11:00:00Z" }] };
  const status = github.githubAssignmentStatus(issue, github.GITHUB_CLAIM_LABEL_DEFAULT, github.GITHUB_CLAIM_COMMENT_MARKER_DEFAULT);
  // The display sanitizer leaves an `audit_trail: undefined` key; JSON drops it, so compare as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(status.record)), JSON.parse(JSON.stringify(rendered.record)));
  assert.equal(status.claim_comment_author, "bot");
  assert.equal(status.has_claim_label, true);
  assert.equal(github.renderGithubClaimCommentBody(status.record, github.GITHUB_CLAIM_COMMENT_MARKER_DEFAULT), rendered.claim_comment_body);
  const fenced = /```json\n([\s\S]*?)\n```/.exec(rendered.claim_comment_body)[1];
  assert.equal(serializeAssignmentClaimRecord(parseAssignmentClaimRecord(fenced, { requireRole: true }).record), `${fenced}\n`);
});

test("codec: the committed GitHub fixture's pre-actor_key record parses and re-renders to its own comment text", () => {
  const issue = JSON.parse(fs.readFileSync(path.join(REPO, "evals/fixtures/assignment-provider/github-issue-claimed.json"), "utf8"));
  const status = github.githubAssignmentStatus(issue, "agent:claimed", github.GITHUB_CLAIM_COMMENT_MARKER_DEFAULT);
  assert.equal(status.record.actor_key, undefined);
  assert.equal(github.renderGithubClaimCommentBody(status.record, github.GITHUB_CLAIM_COMMENT_MARKER_DEFAULT), issue.comments[1].body);
});

test("codec: the CLI's render-claim output is the exported renderer's output", () => {
  const dir = makeFixtureDir("assignment-codec-render-");
  try {
    const inputFile = path.join(dir, "input.json");
    fs.writeFileSync(inputFile, JSON.stringify(githubInput()));
    const actorFile = path.join(dir, "actor.json");
    fs.writeFileSync(actorFile, JSON.stringify(AGENT));
    const cli = JSON.parse(execFileSync(process.execPath, [path.join(REPO, "build/src/cli.js"), "assignment-provider", "render-claim", "--provider", "github", "--subject-id", "s", "--input-json", inputFile, "--actor-json", actorFile], { encoding: "utf8" }));
    const direct = github.renderGithubClaim("s", githubInput(), AGENT, cli.record.claimed_at);
    assert.deepEqual(cli, JSON.parse(JSON.stringify(direct)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("codec: forward compatibility, unknown fields survive and incompatible versions are refused", () => {
  const withExtra = { ...claimRecord(AGENT), future_field: { a: 1 } };
  const decoded = decodeAssignmentClaimRecord(withExtra);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.record.future_field, { a: 1 });
  assert.deepEqual(decodeAssignmentClaimRecord({ ...claimRecord(AGENT), schema_version: "2.0" }), { ok: false, code: "unsupported_schema_version", found: "2.0" });
  assert.deepEqual(decodeAssignmentClaimRecord({ ...claimRecord(AGENT), role: "Other" }, { requireRole: true }), { ok: false, code: "unexpected_role", found: "Other" });
  assert.equal(decodeAssignmentClaimRecord({ ...claimRecord(AGENT), role: "Other" }).ok, true, "role is only enforced where content is mixed (GitHub comments)");
  assert.equal(decodeAssignmentClaimRecord(null).code, "not_an_object");
  assert.equal(decodeAssignmentClaimRecord([]).code, "not_an_object");
  assert.equal(parseAssignmentClaimRecord("{nope").code, "invalid_json");
});

test("codec: a GitHub claim comment with the wrong role or schema_version fails loud, never reads as 'no claim'", () => {
  const rendered = github.renderGithubClaim("s", githubInput(), AGENT, "2026-10-05T11:00:00Z");
  const issueWith = (body) => ({ number: 1, comments: [{ id: 1, body }] });
  const marker = github.GITHUB_CLAIM_COMMENT_MARKER_DEFAULT;
  const wrongRole = rendered.claim_comment_body.replace('"role": "AssignmentClaimRecord"', '"role": "Other"');
  const wrongVersion = rendered.claim_comment_body.replace('"schema_version": "1.0"', '"schema_version": "2.0"');
  assert.throws(() => github.githubAssignmentStatus(issueWith(wrongRole), "agent:claimed", marker), /unexpected role Other/);
  assert.throws(() => github.githubAssignmentStatus(issueWith(wrongVersion), "agent:claimed", marker), /unsupported schema_version 2\.0/);
  assert.throws(() => github.githubAssignmentStatus(issueWith(`${marker}\nno fence`), "agent:claimed", marker), /no fenced JSON block/);
});

test("findAssignmentClaimRecordProblems names a host record's missing required fields", () => {
  assert.deepEqual(findAssignmentClaimRecordProblems(claimRecord(AGENT)), []);
  const broken = { schema_version: "1.0", role: "AssignmentClaimRecord", actor: { runtime: "x" }, ttl_seconds: 0, status: "weird" };
  const problems = findAssignmentClaimRecordProblems(broken);
  for (const field of ["subject_id", "claimed_at", "branch", "artifact_dir", "ttl_seconds", "status", "actor.session_id", "actor.host"]) {
    assert.ok(problems.some((p) => p.startsWith(field)), `expected a problem for ${field}: ${problems.join("; ")}`);
  }
});

// ─── Boundary: GitHub-shaped identity lives in the GitHub provider, not the core ─────────────────

test("subject and work identity are opaque to the core; the GitHub provider owns owner/repo#number validation", () => {
  const taskRecord = claimRecord(AGENT, { subject_id: "host-task-9f3", work_item_ref: "task://9f3" });
  assert.deepEqual(findAssignmentClaimRecordProblems(taskRecord), []);
  assert.equal(computeEffectiveState(statusOf(taskRecord), [], undefined, NOW).effective_state, "reclaimable");
  assert.throws(() => github.renderGithubClaim("s", githubInput({ work_item_ref: "task://9f3" }), AGENT, "2026-10-05T11:00:00Z"), /work_item_ref must exactly match kontourai\/flow-agents#4242/);
});
