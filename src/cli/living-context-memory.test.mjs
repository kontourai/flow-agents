// Memory claims as a Living Context source (kontourai/flow-agents#1595): the claims are the real output of the Kit's own distill
// step, presented through presentMemoryClaims, and recalled from a real Git revision through the real recall and answer steps.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { memoryClaim } from "@kontourai/flow-agents/memory-claims";
import { memoryReviewItemName } from "@kontourai/flow-agents/memory-routing";
import { deriveMemoryManifest } from "../../kits/knowledge/context-check/living-context-memory.mjs";
import { askLivingContext } from "../../kits/knowledge/context-check/living-context-ask.js";
import { createLineSupportVerifier } from "../../kits/knowledge/context-check/living-context-answer.js";
import { distillFixtureSitting } from "./memory-claims-support.mjs";

const NOW = "2026-11-04T16:00:00Z";
const verifier = createLineSupportVerifier();
const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

async function fixture() {
  const earlier = await distillFixtureSitting(0);
  const later = await distillFixtureSitting(1, { current: earlier.result.claims });
  const claims = [...earlier.result.claims, ...later.result.claims];
  // The host stores each sitting as a repository file; the claim's excerpts are verbatim lines of it.
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "living-context-memory-")));
  git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "f@example.test"]); git(repo, ["config", "user.name", "F"]);
  fs.mkdirSync(path.join(repo, "knowledge/records"), { recursive: true });
  fs.mkdirSync(path.join(repo, "sittings"));
  const fileOf = claim => `sittings/${claim.source.ref.replace(/[^A-Za-z0-9]+/g, "-")}.md`;
  for (const claim of claims) fs.appendFileSync(path.join(repo, fileOf(claim)), `${claim.source.excerpt}\n\n`);
  fs.writeFileSync(path.join(repo, "knowledge/records/placeholder.md"), "---\nid: placeholder\ntype: raw\ntitle: Placeholder\ncategory: x.y\nstatus: active\ncreated_at: \"2026-10-01T00:00:00.000Z\"\nupdated_at: \"2026-10-01T00:00:00.000Z\"\nlinks: []\nmutation_log: []\n---\n\nUnrelated.\n");
  git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", "seed"]);
  const options = { claims, authorityFor: claim => ({ path: fileOf(claim), citation: `sitting ${claim.source.ref}` }), recordedAtFor: () => "2026-10-31T00:00:00Z" };
  return { repo, revision: git(repo, ["rev-parse", "HEAD"]), claims, options, fileOf };
}
const mem = claim => `mem-${claim.id.replace(/^sha256:/, "")}`;

test("distilled claims become manifest claims: posture, visibility, validity, slot and supersession are carried, not invented", async () => {
  const { claims, options } = await fixture();
  const derived = deriveMemoryManifest(options);
  assert.deepEqual(derived.excluded, []);
  const by = Object.fromEntries(derived.manifest.claims.map(claim => [claim.id, claim]));
  const stated = claims.filter(claim => claim.posture === "stated");
  assert.ok(stated.length > 0 && claims.some(claim => claim.posture !== "stated"), "the fixture has stated and non-stated claims");
  for (const claim of claims) {
    const out = by[mem(claim)];
    assert.match(out.claim, new RegExp(`^\\[${claim.posture} · unreviewed\\] `), "posture and review label are in the text, as presentMemoryClaims requires");
    assert.equal(out.review.posture, "proposed");
    assert.deepEqual(out.visibility, { audiences: [...claim.visibility.audiences] });
    assert.equal(out.recorded_at, "2026-10-31T00:00:00Z");
    if (claim.posture !== "stated") assert.equal(out.status, "unverifiable", `${claim.posture} is not a fact in effect`);
  }
  const successor = claims.find(claim => claim.supersedes?.length);
  const predecessor = by[mem({ id: successor.supersedes[0].claimId })];
  assert.equal(predecessor.status, "superseded");
  assert.equal(predecessor.superseded_by, mem(successor));
  assert.equal(predecessor.supersession_kind, successor.supersedes[0].kind);
  assert.equal(predecessor.supersession_recorded_at, "2026-10-31T00:00:00Z");
  assert.equal(predecessor.slot, by[mem(successor)].slot);
  assert.deepEqual(by[mem(successor)].valid_time, { from: "2026-10-30T00:00:00.000Z" });
  assert.deepEqual(derived.manifest.readers, ["user:fixture"]);
});

test("withheld, ungrounded and untimed claims are named, never dropped or guessed", async () => {
  const { claims, options } = await fixture();
  const target = claims.find(claim => claim.posture === "stated");
  const rejected = [{ kind: "ReviewDecision", spec: { reviewItemName: memoryReviewItemName(target.id), status: "rejected", reviewerKind: "human", reviewedAt: "2026-10-31T01:00:00Z" } }];
  const ungrounded = claims.find(claim => claim.id !== target.id);
  const derived = deriveMemoryManifest({ ...options, reviewDecisions: rejected, authorityFor: claim => (claim.id === ungrounded.id ? undefined : options.authorityFor(claim)), recordedAtFor: () => undefined });
  assert.ok(derived.excluded.some(entry => entry.claim_id === target.id && entry.reason === "withheld:rejected-in-review"));
  assert.ok(derived.excluded.some(entry => entry.claim_id === ungrounded.id && entry.reason === "no_authority"));
  assert.ok(derived.manifest.claims.every(claim => claim.recorded_at === undefined), "observedAt is when the turn happened, not when the store learned of it");
  const bare = { ...memoryClaim({ ...claims[0], posture: "stated" }), posture: undefined };
  assert.ok(deriveMemoryManifest({ ...options, claims: [bare] }).excluded.some(entry => entry.reason === "withheld:posture-missing"));
  assert.throws(() => deriveMemoryManifest({ claims }), { code: "AUTHORITY_REQUIRED" });
});

test("a confirmed claim is reviewed only when the host names the reviewer", async () => {
  const { claims, options } = await fixture();
  const target = claims.find(claim => claim.posture === "stated");
  const decision = [{ kind: "ReviewDecision", spec: { reviewItemName: memoryReviewItemName(target.id), status: "verified", reviewerKind: "human", reviewedAt: "2026-10-31T01:00:00Z" } }];
  const anonymous = deriveMemoryManifest({ ...options, reviewDecisions: decision });
  assert.match(anonymous.manifest.claims.find(claim => claim.id === mem(target)).claim, /\[stated · confirmed\]/);
  assert.equal(anonymous.manifest.claims.find(claim => claim.id === mem(target)).review.posture, "proposed", "a review nobody is named for is not a review");
  const named = deriveMemoryManifest({ ...options, reviewDecisions: decision, reviewerFor: id => (id === target.id ? "reviewer-1" : undefined) });
  assert.deepEqual(named.manifest.claims.find(claim => claim.id === mem(target)).review, { posture: "reviewed", reviewer: "reviewer-1" });
});

test("asked through recall: a stated claim is answered with its excerpt, a superseded one is not, and the claim carries its posture", async () => {
  const { repo, revision, claims, options } = await fixture();
  const derived = deriveMemoryManifest(options);
  const target = claims.find(claim => claim.posture === "stated" && claim.supersedes?.length);
  const result = await askLivingContext({
    repoRoot: repo, revision, reader: "user:fixture", readers: ["user:fixture"], now: NOW, verifier, additional: [derived],
    question: `What is the ${target.property} of the ${target.subject.label ?? target.subject.id}?`,
  });
  const byId = Object.fromEntries(result.results.map(entry => [entry.claim_id, entry]));
  assert.equal(byId[mem(target)].outcome, "answered");
  assert.equal(byId[mem(target)].passage, target.source.excerpt);
  assert.match(byId[mem(target)].title, /^\[stated · unreviewed\]/);
  const old = byId[mem({ id: target.supersedes[0].claimId })];
  assert.equal(old.status, "superseded");
  assert.equal(old.outcome, "abstained");
  // A reader the claims are not visible to gets nothing of them.
  const other = await askLivingContext({ repoRoot: repo, revision, reader: "someone-else", readers: ["someone-else"], now: NOW, verifier, additional: [derived], question: `${target.property} ${target.subject.label}` });
  assert.ok(!other.results.some(entry => entry.claim_id.startsWith("mem-") && entry.outcome === "answered"));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("a presented claim longer than a recall result may be is excluded by name, not truncated", async () => {
  const { claims, options } = await fixture();
  const long = memoryClaim({ ...claims.find(claim => claim.posture === "stated"), value: "x".repeat(1500), supersedes: undefined });
  const derived = deriveMemoryManifest({ ...options, claims: [long], authorityFor: () => ({ path: "knowledge/records/placeholder.md", citation: "placeholder" }) });
  assert.deepEqual(derived.excluded, [{ claim_id: long.id, reason: "claim_too_long" }]);
  assert.deepEqual(derived.manifest.claims, []);
});
