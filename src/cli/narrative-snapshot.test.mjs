import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseSourceId } from "../../build/src/narrative/source-ids.js";
import { snapshotNarrative } from "../../build/src/narrative/snapshot.js";

const NOW = "2026-07-14T12:00:00Z";
const compiler = { name: "test", version: "1", policy_hash: "policy" };
const captureCompleteness = { channels: { full: "active" }, known_gaps: [] };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-snapshot-"));
  const repo = path.join(root, "repo");
  const narrativeDir = path.join(root, "artifacts", "narrative", "n1");
  fs.mkdirSync(repo, { recursive: true });
  return { root, repo, narrativeDir };
}

function fileRequest(repo, relative, content) {
  fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
  fs.writeFileSync(path.join(repo, relative), content);
  const hash = createHash("sha256").update(content).digest("hex");
  return { source: parseSourceId(`fa1:file:${encodeURIComponent(relative)}:${hash}`), roots: { repoRoot: repo } };
}

function input(narrativeDir, requests) {
  return { narrativeDir, narrativeId: "n1", requests, redactionFields: ["tool.input"], compiler, captureCompleteness };
}

test("snapshot stores identical filtered content once and references it twice", () => {
  const { repo, narrativeDir } = fixture();
  const content = Buffer.from(JSON.stringify({ event: "same", tool: { input: "secret" } }));
  const result = snapshotNarrative(input(narrativeDir, [fileRequest(repo, "a.json", content), fileRequest(repo, "b.json", content)]), { now: () => NOW });
  assert.equal(result.manifest.sources.length, 2);
  assert.equal(result.manifest.sources[0].sha256, result.manifest.sources[1].sha256);
  assert.equal(fs.readdirSync(path.join(narrativeDir, "sources")).length, 1);
  assert.equal(fs.readFileSync(path.join(narrativeDir, "sources", result.manifest.sources[0].sha256), "utf8").includes("secret"), false);
});

test("a blob write failure leaves no manifest", () => {
  const { repo, narrativeDir } = fixture();
  const request = fileRequest(repo, "a.json", Buffer.from(JSON.stringify({ ok: true })));
  assert.throws(() => snapshotNarrative(input(narrativeDir, [request]), {
    now: () => NOW,
    writeBlob: () => { throw new Error("simulated blob write failure"); },
  }), /simulated blob write failure/);
  assert.equal(fs.existsSync(path.join(narrativeDir, "source-manifest.json")), false);
});

test("filter failure records unavailable redacted without leaking source values", () => {
  const { repo, narrativeDir } = fixture();
  const secret = "TOP_SECRET_617";
  const request = fileRequest(repo, "bad.json", Buffer.from(JSON.stringify({ tool: secret })));
  const result = snapshotNarrative(input(narrativeDir, [request]), { now: () => NOW });
  assert.equal(result.manifest.sources[0].status, "unavailable");
  assert.equal(result.manifest.sources[0].unavailable_reason, "redacted");
  const allNarrativeText = fs.readdirSync(narrativeDir, { recursive: true })
    .map(String).filter((name) => fs.statSync(path.join(narrativeDir, name)).isFile())
    .map((name) => fs.readFileSync(path.join(narrativeDir, name), "utf8")).join("\n");
  assert.equal(allNarrativeText.includes(secret), false);
  assert.deepEqual(fs.readdirSync(path.join(narrativeDir, "sources")), []);
});

test("manifest publication is creation-only: a concurrent racer cannot replace the winner", () => {
  const { repo, narrativeDir } = fixture();
  const request = fileRequest(repo, "good.json", Buffer.from(JSON.stringify({ ok: true })));
  const first = snapshotNarrative(input(narrativeDir, [request]), { now: () => NOW });
  assert.equal(first.manifest.sources[0].status, "snapshotted");
  const before = fs.readFileSync(path.join(narrativeDir, "source-manifest.json"), "utf8");
  // A second snapshot into the same narrative dir must fail without replacing
  // the frozen manifest, even when it skips the advisory exists pre-check by
  // racing straight to publication.
  assert.throws(() => snapshotNarrative(input(narrativeDir, [request]), { now: () => NOW }), /already exists/);
  assert.equal(fs.readFileSync(path.join(narrativeDir, "source-manifest.json"), "utf8"), before);
});

test("schema rejects malformed fa1 ids and entries without lineage", () => {
  const { repo, narrativeDir } = fixture();
  const request = fileRequest(repo, "s.json", Buffer.from(JSON.stringify({ ok: 1 })));
  const { manifest } = snapshotNarrative(input(narrativeDir, [request]), { now: () => NOW });
  const validate = (mutate) => {
    const clone = JSON.parse(JSON.stringify(manifest));
    mutate(clone);
    return clone;
  };
  // Malformed fa1 id: right prefix, structurally invalid remainder.
  const badId = validate((m) => { m.sources[0].source_id = "fa1:file:not a valid component:zz"; });
  // Missing lineage on a snapshotted entry.
  const noLineage = validate((m) => { delete m.sources[0].lineage; });
  return import("../../build/src/narrative/snapshot.js").then(({ validateNarrativeSourceManifest }) => {
    assert.equal(validateNarrativeSourceManifest(manifest).length, 0);
    assert.notEqual(validateNarrativeSourceManifest(badId).length, 0);
    assert.notEqual(validateNarrativeSourceManifest(noLineage).length, 0);
  });
});
