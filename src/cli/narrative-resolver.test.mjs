import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseSourceId, formatSourceId } from "../../build/src/narrative/source-ids.js";
import { snapshotNarrative, validateNarrativeSourceManifest } from "../../build/src/narrative/snapshot.js";
import { resolveSource, verifyManifest } from "../../build/src/narrative/resolver.js";

const NOW = "2026-07-14T12:00:00Z";

function setup() {
  const scope = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-resolver-"));
  const repo = path.join(scope, "repo");
  const narrativeDir = path.join(scope, "artifacts", "narrative", "n1");
  fs.mkdirSync(repo, { recursive: true });
  const raw = Buffer.from(JSON.stringify({ event: "kept", tool: { input: "remove" } }));
  fs.writeFileSync(path.join(repo, "source.json"), raw);
  const hash = createHash("sha256").update(raw).digest("hex");
  const source = parseSourceId(`fa1:file:source.json:${hash}`);
  const result = snapshotNarrative({
    narrativeDir, narrativeId: "n1", requests: [{ source, roots: { repoRoot: repo } }], redactionFields: ["tool.input"],
    compiler: { name: "test", version: "1", policy_hash: "policy" }, captureCompleteness: { channels: {}, known_gaps: [] },
  }, { now: () => NOW });
  return { scope, narrativeDir, sourceId: formatSourceId(source), entry: result.manifest.sources[0] };
}

test("resolve returns the exact hash-verified snapshot bytes", () => {
  const { narrativeDir, sourceId, entry } = setup();
  const result = resolveSource(narrativeDir, sourceId);
  assert.equal(result.status, "resolved");
  assert.equal(createHash("sha256").update(result.content).digest("hex"), result.sha256);
  assert.equal(result.sha256, entry.sha256);
  assert.deepEqual(result.lineage, [{ at: NOW, event: "source_snapshotted" }]);
});

test("byte flip and same-size replacement are corrupt", () => {
  const { narrativeDir, sourceId, entry } = setup();
  const blob = path.join(narrativeDir, "sources", entry.sha256);
  const bytes = fs.readFileSync(blob);
  bytes[0] ^= 1;
  fs.writeFileSync(blob, bytes);
  assert.deepEqual(resolveSource(narrativeDir, sourceId).reason, "corrupt");
});

test("symlinked blob is corrupt", { skip: process.platform === "win32" }, () => {
  const { narrativeDir, sourceId, entry } = setup();
  const blob = path.join(narrativeDir, "sources", entry.sha256);
  const target = path.join(narrativeDir, "replacement");
  fs.writeFileSync(target, "replacement");
  fs.rmSync(blob);
  fs.symlinkSync(target, blob);
  assert.deepEqual(resolveSource(narrativeDir, sourceId).reason, "corrupt");
});

test("manifest traversal-shaped sha is rejected and resolves corrupt", () => {
  const { narrativeDir, sourceId } = setup();
  const manifestFile = path.join(narrativeDir, "source-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.sources[0].sha256 = "../x";
  assert.ok(validateNarrativeSourceManifest(manifest).length > 0);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.deepEqual(resolveSource(narrativeDir, sourceId).reason, "corrupt");
});

test("unknown source id is not_captured", () => {
  const { narrativeDir } = setup();
  assert.deepEqual(resolveSource(narrativeDir, `fa1:file:missing:${"0".repeat(64)}`).reason, "not_captured");
});

test("scope mismatch is unauthorized", () => {
  const { narrativeDir, sourceId } = setup();
  const otherScope = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-other-scope-"));
  assert.deepEqual(resolveSource(narrativeDir, sourceId, { scope: otherScope }).reason, "unauthorized");
});

test("verifyManifest reports every source and fails after corruption", () => {
  const { narrativeDir, entry } = setup();
  assert.deepEqual(verifyManifest(narrativeDir), { ok: true, perSource: [{ sourceId: entry.source_id, status: "resolved" }] });
  fs.appendFileSync(path.join(narrativeDir, "sources", entry.sha256), "x");
  const report = verifyManifest(narrativeDir);
  assert.equal(report.ok, false);
  assert.deepEqual(report.perSource, [{ sourceId: entry.source_id, status: "unavailable", reason: "corrupt" }]);
});

test("a symlinked sources directory is rejected as corrupt, never followed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-resolver-symdir-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const narrativeDir = path.join(root, "narrative", "n1");
  const elsewhere = path.join(root, "elsewhere");
  const { repo } = { repo: path.join(root, "repo") };
  fs.mkdirSync(repo, { recursive: true });
  const content = Buffer.from(JSON.stringify({ ok: true }));
  fs.writeFileSync(path.join(repo, "f.json"), content);
  const hash = createHash("sha256").update(content).digest("hex");
  const request = { source: parseSourceId(`fa1:file:f.json:${hash}`), roots: { repoRoot: repo } };
  const { manifest } = snapshotNarrative({
    narrativeDir, narrativeId: "n1", requests: [request], redactionFields: [],
    compiler: { name: "test", version: "1", policy_hash: "p" },
    captureCompleteness: { channels: {}, known_gaps: [] },
  }, { now: () => "2026-07-14T12:00:00Z" });
  const entry = manifest.sources[0];
  assert.equal(entry.status, "snapshotted");
  // Replace the sources directory (the blob's intermediate ancestor) with a
  // symlink pointing elsewhere carrying an identical blob.
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.copyFileSync(path.join(narrativeDir, "sources", entry.sha256), path.join(elsewhere, entry.sha256));
  fs.rmSync(path.join(narrativeDir, "sources"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(narrativeDir, "sources"));
  const result = resolveSource(narrativeDir, entry.source_id);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "corrupt");
});
