import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import {
  composeGroundedNarrative,
  decodeGroundedNarrativeRef,
  parseSourceId,
  projectRetainedNarrativeProcess,
  readGroundedNarrative,
  snapshotNarrative,
  writeEnvelope,
} from "../../build/src/index.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const sha8 = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 8);
const captureCompleteness = { channels: { full: "active" }, known_gaps: [{ class: "mcp_non_native_tools", ref: "fixture-gap" }] };

function fixture({ custom = false, oldCompiler = false } = {}) {
  const root = makeFixtureDir("narrative-retained-reader-");
  const narrativeDir = path.join(root, "narrative");
  const flowRoot = path.join(root, "flow");
  const report = Buffer.from(JSON.stringify({
    run_id: "retained-reader", gate_summaries: [], command: "PRIVATE_COMMAND_CANARY", path: "/private/PATH_CANARY",
  }));
  fs.mkdirSync(path.join(flowRoot, "runs", "retained-reader"), { recursive: true });
  fs.writeFileSync(path.join(flowRoot, "runs", "retained-reader", "report.json"), report);
  snapshotNarrative({
    narrativeDir,
    narrativeId: "retained-reader-fixture",
    requests: [{ source: parseSourceId(`fa1:flow-report:retained-reader:report/${sha8(report)}`), roots: { flowRoot } }],
    redactionFields: [],
    compiler: { name: "fixture", version: "1", policy_hash: "fixture" },
    captureCompleteness,
  }, { now: () => "2026-08-26T00:00:00.000Z" });
  const envelope = composeGroundedNarrative(narrativeDir, { compiledAt: "2026-08-26T00:01:00.000Z" });
  if (oldCompiler) envelope.provenance.compiler.version = "0.0.1"; // retained provenance is historical, not a current-version check.
  const outDir = custom ? path.join(root, "retained-custom") : undefined;
  const written = writeEnvelope(narrativeDir, envelope, { outDir });
  return { root, narrativeDir, flowRoot, envelope, written, scope: { narrativeDir, ...(outDir ? { envelopeOutDir: outDir } : {}) } };
}

function ref(written) { return { schemaVersion: "grounded-narrative-ref/v1", narrativeId: "retained-reader-fixture", envelopeSha256: written.envelopeSha256 }; }
function tree(root) {
  return fs.readdirSync(root, { recursive: true }).sort().map((name) => {
    const file = path.join(root, name);
    return fs.lstatSync(file).isFile() ? [name, fs.readFileSync(file).toString("base64")] : [name, "directory"];
  });
}

test("retained reader replays a content-addressed envelope after a compiler upgrade, including a server-owned custom output directory", async () => {
  const data = fixture({ custom: true, oldCompiler: true });
  const before = tree(data.root);
  const result = await readGroundedNarrative({ scope: data.scope, ref: ref(data.written), authorize: () => true });
  assert.equal(result.status, "available");
  assert.equal(result.envelope.provenance.compiler.version, "0.0.1");
  assert.deepEqual(tree(data.root), before, "read is side-effect free");
  // A fresh dynamic module instance models a post-restart consumer; it reads only the frozen bytes.
  const restarted = await import(`../../build/src/index.js?retained-reader-restart=${Date.now()}`);
  const replay = await restarted.readGroundedNarrative({ scope: data.scope, ref: ref(data.written), authorize: () => true });
  assert.equal(replay.status, "available");
});

test("reader rejects malformed, tampered, missing, oversized, and source-corrupt retained bytes without partial results", async () => {
  const data = fixture();
  const goodRef = ref(data.written);
  fs.writeFileSync(data.written.envelopePath, "{");
  assert.deepEqual(await readGroundedNarrative({ scope: data.scope, ref: goodRef, authorize: () => true }), { status: "unavailable", reason: "corrupt" });

  const missing = fixture();
  fs.rmSync(missing.written.envelopePath);
  assert.deepEqual(await readGroundedNarrative({ scope: missing.scope, ref: ref(missing.written), authorize: () => true }), { status: "unavailable", reason: "not_captured" });

  const oversized = fixture();
  assert.deepEqual(await readGroundedNarrative({ scope: oversized.scope, ref: ref(oversized.written), limits: { maxEnvelopeBytes: 1 }, authorize: () => true }), { status: "unavailable", reason: "limits_exceeded" });
  assert.deepEqual(await readGroundedNarrative({ scope: oversized.scope, ref: ref(oversized.written), limits: { maxSourceBytes: 1 }, authorize: () => true }), { status: "unavailable", reason: "limits_exceeded" });

  const corruptSource = fixture();
  const source = JSON.parse(fs.readFileSync(path.join(corruptSource.narrativeDir, "source-manifest.json"), "utf8")).sources[0];
  fs.writeFileSync(path.join(corruptSource.narrativeDir, "sources", source.sha256), "changed");
  assert.deepEqual(await readGroundedNarrative({ scope: corruptSource.scope, ref: ref(corruptSource.written), authorize: () => true }), { status: "unavailable", reason: "corrupt" });
});

test("reader neither probes mutable origins nor succeeds after queued authorization revocation", async () => {
  const data = fixture();
  fs.writeFileSync(path.join(data.flowRoot, "runs", "retained-reader", "report.json"), "mutable-origin-is-not-read");
  assert.equal((await readGroundedNarrative({ scope: data.scope, ref: ref(data.written), authorize: () => true })).status, "available");
  let calls = 0;
  assert.deepEqual(await readGroundedNarrative({ scope: data.scope, ref: ref(data.written), authorize: async () => ++calls === 1 }), { status: "unavailable", reason: "authorization_revoked" });
});

test("bounded descriptor reads reject deterministic growth and inode/path swaps", async () => {
  const growth = fixture();
  const originalRead = fs.readSync;
  let grew = false;
  try {
    fs.readSync = (...args) => {
      if (!grew) { grew = true; fs.appendFileSync(growth.written.envelopePath, "x"); }
      return originalRead(...args);
    };
    syncBuiltinESMExports();
    const size = fs.statSync(growth.written.envelopePath).size;
    assert.deepEqual(await readGroundedNarrative({ scope: growth.scope, ref: ref(growth.written), limits: { maxEnvelopeBytes: size }, authorize: () => true }), { status: "unavailable", reason: "limits_exceeded" });
  } finally { fs.readSync = originalRead; syncBuiltinESMExports(); }

  const swapped = fixture();
  const replacement = `${swapped.written.envelopePath}.replacement`;
  let didSwap = false;
  try {
    fs.readSync = (...args) => {
      if (!didSwap) { didSwap = true; fs.writeFileSync(replacement, fs.readFileSync(swapped.written.envelopePath)); fs.renameSync(replacement, swapped.written.envelopePath); }
      return originalRead(...args);
    };
    syncBuiltinESMExports();
    assert.deepEqual(await readGroundedNarrative({ scope: swapped.scope, ref: ref(swapped.written), authorize: () => true }), { status: "unavailable", reason: "corrupt" });
  } finally { fs.readSync = originalRead; syncBuiltinESMExports(); }
});

test("path-free references and the browser-safe projection exclude foreign bytes, paths, commands, sources, and statements", async () => {
  const data = fixture();
  assert.equal(decodeGroundedNarrativeRef({ schemaVersion: "grounded-narrative-ref/v1", narrativeId: "x", envelopeSha256: "a".repeat(64), path: "/client/controlled" }), undefined);
  assert.equal(decodeGroundedNarrativeRef({ schemaVersion: "grounded-narrative-ref/v2", narrativeId: "x", envelopeSha256: "a".repeat(64) }), undefined);
  const result = await readGroundedNarrative({ scope: data.scope, ref: ref(data.written), authorize: () => true });
  assert.equal(result.status, "available");
  const projection = projectRetainedNarrativeProcess(result.ref, result.envelope);
  const json = JSON.stringify(projection);
  assert.ok(projection);
  assert.doesNotMatch(json, /PRIVATE_COMMAND_CANARY|PATH_CANARY|embedded_bytes|source_refs|statements|sessionId|known_gap_refs/);
  assert.equal(projection.runtime.coverage.sources, 1);
  const hostile = structuredClone(result.envelope);
  hostile.capture_completeness.known_gaps[0].note = "/private/CAPTURE_NOTE_CANARY";
  hostile.sections.find((section) => section.authority === "flow-agents").embedded.turns[0] = {
    ordinal: 1, sessionId: "/private/SESSION_CANARY", boundary: { derived: true }, known_gap_refs: ["/private/GAP_CANARY"], statements: [], purpose: { step: "/private/STEP_CANARY", gate: "/private/GATE_CANARY" },
  };
  assert.doesNotMatch(JSON.stringify(projectRetainedNarrativeProcess(result.ref, hostile)), /CAPTURE_NOTE_CANARY|SESSION_CANARY|GAP_CANARY|STEP_CANARY|GATE_CANARY/);
});
