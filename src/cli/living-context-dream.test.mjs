// Dream-produced claims as a Living Context source (kontourai/flow-agents#1595). The dream run is the real one (real Corpus store, the
// Kit's own envelope, scripted extraction in place of a model); the claims are read back from the proposals it staged, mapped by
// deriveMemoryManifest, and asked about through the real recall and answer steps against a real Git revision.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KitDefaultStoreAdapter, standaloneFileMutationLock } from "@kontourai/corpus-store";
import { runDream } from "../../kits/knowledge/dream/run.js";
import { decodeEnvelope } from "../../kits/knowledge/dream/envelope.js";
import { deriveMemoryManifest } from "../../kits/knowledge/context-check/living-context-memory.mjs";
import { askLivingContext } from "../../kits/knowledge/context-check/living-context-ask.js";
import { createLineSupportVerifier } from "../../kits/knowledge/context-check/living-context-answer.js";
import { hostFor, noApplyStore, runOptions, scriptedExtract, workspace } from "./dream-support.mjs";

const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

test("claims a dream run staged are asked about through recall: answered from the stored sitting, hidden from another reader", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  fs.mkdirSync(ws.memoryRoot, { recursive: true });
  const store = await new KitDefaultStoreAdapter({ storeRoot: ws.memoryRoot, coordinationDirectory: path.join(ws.root, "coordination"), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract());
  assert.equal((await runDream(host, runOptions(ws))).status, "success");

  const envelopes = (await store.listProposals()).map((proposal) => decodeEnvelope(proposal.candidate.body)).filter(Boolean);
  assert.ok(envelopes.length >= 2, "the dream run staged claims");
  const claims = envelopes.map((envelope) => envelope.claim);

  // The host keeps each sitting as a repository file: that file is the claim's authority at a pinned revision.
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "living-context-dream-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "f@example.test"]); git(repo, ["config", "user.name", "F"]);
  fs.mkdirSync(path.join(repo, "sittings"));
  const fileOf = (claim) => `sittings/${envelopes.find((envelope) => envelope.claim.id === claim.id).sitting.id.replace(/[^A-Za-z0-9]+/g, "-")}.md`;
  for (const claim of claims) fs.appendFileSync(path.join(repo, fileOf(claim)), `${claim.source.excerpt}\n\n`);
  git(repo, ["add", "-A"]); git(repo, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "sittings"]);
  const revision = git(repo, ["rev-parse", "HEAD"]);

  const derived = deriveMemoryManifest({ claims, authorityFor: (claim) => ({ path: fileOf(claim), citation: "stored sitting" }), recordedAtFor: () => "2026-11-02T00:00:00Z" });
  assert.deepEqual(derived.excluded, []);
  const readers = derived.manifest.readers;
  assert.ok(readers.includes("user:owner"), "the dream run stamped the owner's visibility on every claim");

  const rounding = claims.find((claim) => /rounding/i.test(`${claim.property} ${String(claim.value)}`));
  assert.ok(rounding, "the scripted sitting states a rounding rule");
  const asked = await askLivingContext({ repoRoot: repo, revision, question: "What is the rounding mode?", reader: "user:owner", readers, now: "2026-11-05T00:00:00Z", verifier: createLineSupportVerifier(), additional: [derived] });
  const answered = asked.results.find((entry) => entry.outcome === "answered");
  assert.ok(answered, JSON.stringify(asked.results.map((entry) => [entry.title, entry.outcome, entry.reason])));
  assert.match(answered.title, /^\[stated · unreviewed\]/, "posture and review label stay on the claim");
  assert.equal(answered.passage, rounding.source.excerpt);
  assert.equal(answered.status, "current");

  const stranger = await askLivingContext({ repoRoot: repo, revision, question: "What is the rounding mode?", reader: "someone-else", readers: [...readers, "someone-else"], now: "2026-11-05T00:00:00Z", verifier: createLineSupportVerifier(), additional: [derived] });
  assert.ok(!stranger.results.some((entry) => entry.outcome === "answered"), "claims stamped for the owner are not answered to anyone else");
});
