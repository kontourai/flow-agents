// Deterministic subject identity + the collision join that keys off it (#1099).
//
// The defect these cover: `freshHolders` joins on the subject STRING, so the subject IS the
// collision key — and until now nothing made two lanes on one backlog item produce the same
// string. One repo's artifact root held 95 subjects across four naming schemes.
//
// Run: `npm run test:unit`
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { workItemSlug, githubWorkItemIdentity } from "../../build/src/lib/work-item-identity.js";

const require_ = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const subjectIdentity = require_(path.join(REPO_ROOT, "scripts/hooks/lib/subject-identity.js"));
const livenessRead = require_(path.join(REPO_ROOT, "scripts/hooks/lib/liveness-read.js"));
const subjectBinding = require_(path.join(REPO_ROOT, "scripts/hooks/lib/subject-binding.js"));

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

// ── canonical derivation ─────────────────────────────────────────────────────

test("canonical subject id is derived from the backlog item, not chosen", () => {
  assert.equal(subjectIdentity.canonicalSubjectId("octo/demo#1061"), "octo-demo-1061");
  assert.equal(subjectIdentity.canonicalSubjectId("octo/demo#1254"), "octo-demo-1254");
  // Same item, two callers, zero coordination -> identical key. This is the whole property.
  assert.equal(
    subjectIdentity.canonicalSubjectId("octo/demo#1254"),
    subjectIdentity.canonicalSubjectId("octo/demo#1254"),
  );
});

test("canonical subject id rejects non-references rather than inventing one", () => {
  assert.equal(subjectIdentity.canonicalSubjectId("s1254-tokens"), null);
  assert.equal(subjectIdentity.canonicalSubjectId("octo/demo#0"), null);
  assert.equal(subjectIdentity.canonicalSubjectId(""), null);
  assert.equal(subjectIdentity.canonicalSubjectId(null), null);
});

test("provider-neutral refs keep their own derivation", () => {
  assert.equal(subjectIdentity.canonicalSubjectId("local:my-fix"), "local-my-fix");
  assert.equal(subjectIdentity.canonicalSubjectId("jira:PROJ-12"), "jira-proj-12");
});

test("namespaces are separate: local: is free text, provider refs are joinable", () => {
  assert.equal(subjectIdentity.subjectNamespace("octo/demo#1061"), "work-item");
  assert.equal(subjectIdentity.subjectNamespace("local:my-fix"), "local");
  assert.equal(subjectIdentity.subjectNamespace("hand-typed words"), "local");
});

// ── the TS CLI and the CJS hooks are ONE implementation, not two ─────────────

test("TS workItemSlug delegates to the shared CJS derivation (no forked copy)", () => {
  for (const ref of ["octo/demo#1061", "a/b#1", "owner/repo#987654", "local:x", "jira:PROJ-1"]) {
    assert.equal(workItemSlug(ref), subjectIdentity.canonicalSubjectId(ref), ref);
  }
  assert.equal(githubWorkItemIdentity("octo/demo#1061").slug, "octo-demo-1061");
});

test("TS workItemSlug preserves its exact error contract through the delegation", () => {
  assert.throws(() => workItemSlug("octo/demo#0"), /provider-neutral provider:id ref or owner\/repo#numeric-id|exact owner\/repo#positive-numeric-id/);
  assert.throws(() => workItemSlug("not a ref"), /provider-neutral provider:id ref/);
  assert.throws(() => githubWorkItemIdentity("local:x"), /exact owner\/repo#positive-numeric-id/);
});

// ── binding-derived alias (the migration answer for 95 legacy subjects) ──────

test("canonicalSubjectKeyFromRefs derives the key from the recorded binding, not the name", () => {
  assert.equal(subjectIdentity.canonicalSubjectKeyFromRefs(["octo/demo#1254"]), "octo-demo-1254");
  assert.equal(subjectIdentity.canonicalSubjectKeyFromRefs(["local:s1254-tokens"]), null);
  assert.equal(subjectIdentity.canonicalSubjectKeyFromRefs([]), null);
  assert.equal(subjectIdentity.canonicalSubjectKeyFromRefs(undefined), null);
});

test("canonicalSubjectKey reads a legacy-named session's own binding", () => {
  const root = tmpdir("fa-subject-key-");
  fs.mkdirSync(path.join(root, "s1254-tokens"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "s1254-tokens", "state.json"),
    JSON.stringify({ task_slug: "s1254-tokens", status: "in_progress", work_item_refs: ["octo/demo#1254"] }),
  );
  assert.equal(subjectIdentity.canonicalSubjectKey(root, "s1254-tokens"), "octo-demo-1254");
  // Traversal is refused rather than resolved.
  assert.equal(subjectIdentity.canonicalSubjectKey(root, "../etc"), null);
  assert.equal(subjectIdentity.canonicalSubjectKey(root, "missing"), null);
});

// ── the collision join ───────────────────────────────────────────────────────

const NOW = Date.parse("2026-07-29T12:00:00Z");
const RECENT = new Date(NOW - 60_000).toISOString();

test("BASELINE: two lanes on one item under different legacy schemes do NOT collide on subjectId alone", () => {
  const events = [{ type: "claim", subjectId: "s1254-tokens", actor: "lane-b", at: RECENT, ttlSeconds: 1800 }];
  const holders = livenessRead.freshHolders(events, "octo-demo-1254", "lane-a", NOW);
  assert.equal(holders.length, 0, "this is the #1099 defect, pinned so the fix below is meaningful");
});

test("two lanes on one item collide once the canonical key is stamped", () => {
  const events = [
    { type: "claim", subjectId: "s1254-tokens", subjectKey: "octo-demo-1254", actor: "lane-b", at: RECENT, ttlSeconds: 1800 },
  ];
  const holders = livenessRead.freshHolders(events, "octo-demo-1254", "lane-a", NOW, { subjectKey: "octo-demo-1254" });
  assert.equal(holders.length, 1);
  assert.equal(holders[0].actor, "lane-b");
});

test("the collision is symmetric — canonical lane seen from the legacy lane", () => {
  const events = [
    { type: "claim", subjectId: "octo-demo-1254", subjectKey: "octo-demo-1254", actor: "lane-a", at: RECENT, ttlSeconds: 1800 },
  ];
  const holders = livenessRead.freshHolders(events, "s1254-tokens", "lane-b", NOW, { subjectKey: "octo-demo-1254" });
  assert.equal(holders.length, 1);
  assert.equal(holders[0].actor, "lane-a");
});

test("two legacy schemes on the same item collide with each other", () => {
  const events = [
    { type: "claim", subjectId: "tokens-1254", subjectKey: "octo-demo-1254", actor: "lane-c", at: RECENT, ttlSeconds: 1800 },
  ];
  const holders = livenessRead.freshHolders(events, "s1254-tokens", "lane-b", NOW, { subjectKey: "octo-demo-1254" });
  assert.equal(holders.length, 1);
  assert.equal(holders[0].actor, "lane-c");
});

test("aliasing never widens across DIFFERENT items", () => {
  const events = [
    { type: "claim", subjectId: "s1168-css", subjectKey: "octo-demo-1168", actor: "lane-x", at: RECENT, ttlSeconds: 1800 },
  ];
  assert.equal(
    livenessRead.freshHolders(events, "octo-demo-1254", "lane-a", NOW, { subjectKey: "octo-demo-1254" }).length,
    0,
  );
});

test("aliasing never resurrects a released or expired claim", () => {
  const released = [
    { type: "claim", subjectId: "s1254-tokens", subjectKey: "octo-demo-1254", actor: "lane-b", at: RECENT, ttlSeconds: 1800 },
    { type: "release", subjectId: "s1254-tokens", subjectKey: "octo-demo-1254", actor: "lane-b", at: new Date(NOW - 30_000).toISOString() },
  ];
  assert.equal(livenessRead.freshHolders(released, "octo-demo-1254", "lane-a", NOW, { subjectKey: "octo-demo-1254" }).length, 0);

  const expired = [
    { type: "claim", subjectId: "s1254-tokens", subjectKey: "octo-demo-1254", actor: "lane-b", at: new Date(NOW - 3_600_000).toISOString(), ttlSeconds: 1800 },
  ];
  assert.equal(livenessRead.freshHolders(expired, "octo-demo-1254", "lane-a", NOW, { subjectKey: "octo-demo-1254" }).length, 0);
});

test("self is still excluded through the alias path", () => {
  const events = [
    { type: "claim", subjectId: "s1254-tokens", subjectKey: "octo-demo-1254", actor: "lane-a", at: RECENT, ttlSeconds: 1800 },
  ];
  assert.equal(livenessRead.freshHolders(events, "octo-demo-1254", "lane-a", NOW, { subjectKey: "octo-demo-1254" }).length, 0);
});

test("4-argument callers are unchanged (no subjectKey => exact subjectId match only)", () => {
  const events = [
    { type: "claim", subjectId: "octo-demo-1254", subjectKey: "octo-demo-1254", actor: "lane-b", at: RECENT, ttlSeconds: 1800 },
  ];
  assert.equal(livenessRead.freshHolders(events, "octo-demo-1254", "lane-a", NOW).length, 1);
  assert.equal(livenessRead.freshHolders(events, "s1254-tokens", "lane-a", NOW).length, 0);
});

// ── one key, one lookup ──────────────────────────────────────────────────────

test("subjectStatus answers 'already claimed?' and 'session exists?' from ONE key", () => {
  const repo = tmpdir("fa-subject-status-");
  const artifactRoot = path.join(repo, ".kontourai", "flow-agents");
  fs.mkdirSync(path.join(artifactRoot, "octo-demo-1254"), { recursive: true });
  fs.writeFileSync(
    path.join(artifactRoot, "octo-demo-1254", "state.json"),
    JSON.stringify({ task_slug: "octo-demo-1254", status: "in_progress", work_item_refs: ["octo/demo#1254"] }),
  );
  fs.mkdirSync(path.join(artifactRoot, "liveness"), { recursive: true });
  fs.writeFileSync(
    path.join(artifactRoot, "liveness", "events.jsonl"),
    `${JSON.stringify({ type: "claim", subjectId: "s1254-tokens", subjectKey: "octo-demo-1254", actor: "lane-b", at: RECENT, ttlSeconds: 1800 })}\n`,
  );

  const status = subjectBinding.subjectStatus({ root: repo, ref: "octo/demo#1254", selfActor: "lane-a", nowMs: NOW });
  assert.equal(status.subjectId, "octo-demo-1254");
  assert.ok(status.session, "the local session for the item is found by the same key");
  assert.equal(status.holders.length, 1, "and so is the other lane, including under its legacy name");
  assert.equal(status.holders[0].actor, "lane-b");
});

// ── prompt-text reference extraction ─────────────────────────────────────────

test("backlogRefsInText lifts explicit refs, and bare #N only with a known repo", () => {
  assert.deepEqual(subjectIdentity.backlogRefsInText("fix octo/demo#1043 please"), ["octo/demo#1043"]);
  assert.deepEqual(subjectIdentity.backlogRefsInText("work #1043", null), []);
  assert.deepEqual(subjectIdentity.backlogRefsInText("work #1043", "octo/demo"), ["octo/demo#1043"]);
  assert.deepEqual(subjectIdentity.backlogRefsInText("no references here", "octo/demo"), []);
  // Bounded output.
  const many = subjectIdentity.backlogRefsInText("#1 #2 #3 #4 #5", "o/r");
  assert.equal(many.length, subjectIdentity.MAX_TEXT_REFS);
});

test("readOriginRepo prefers FLOW_AGENTS_REPO and parses a .git/config origin", () => {
  assert.equal(subjectIdentity.readOriginRepo("/nonexistent", { FLOW_AGENTS_REPO: "octo/demo" }), "octo/demo");
  const repo = tmpdir("fa-origin-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "config"), '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:kontourai/flow-agents.git\n');
  assert.equal(subjectIdentity.readOriginRepo(repo, {}), "kontourai/flow-agents");
  fs.writeFileSync(path.join(repo, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/octo/demo.git\n');
  assert.equal(subjectIdentity.readOriginRepo(repo, {}), "octo/demo");
  fs.writeFileSync(path.join(repo, ".git", "config"), "[core]\n\tbare = false\n");
  assert.equal(subjectIdentity.readOriginRepo(repo, {}), null);
});
