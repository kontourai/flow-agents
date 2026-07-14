import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GroundedNarrativeError,
  SourceIdParseError,
  composeGroundedNarrative,
  formatSourceId,
  parseSourceId,
  resolveSource,
  snapshotNarrative,
  stableStringify,
  validateGroundedNarrative,
  writeEnvelope,
} from "../../build/src/index.js";

const CAPTURED_AT = "2026-07-14T15:00:00.000Z";
const COMPILED_AT = "2026-07-14T16:00:00.000Z";
const compiler = { name: "envelope-test", version: "1", policy_hash: "policy" };
const captureCompleteness = {
  channels: { full: "active" },
  known_gaps: [{ class: "mcp_non_native_tools", ref: "flow-agents#492" }],
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha8 = (bytes) => sha256(bytes).slice(0, 8);

function constructedNarrative({ missingReport = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-envelope-"));
  const narrativeDir = path.join(root, "narrative");
  const flowRoot = path.join(root, "flow");
  const sessionDir = path.join(root, "session");
  const reportBytes = Buffer.from('{\n  "run_id": "run-envelope",\n  "status": "passed",\n  "steps": []\n}\n');
  if (!missingReport) {
    fs.mkdirSync(path.join(flowRoot, "runs", "run-envelope"), { recursive: true });
    fs.writeFileSync(path.join(flowRoot, "runs", "run-envelope", "report.json"), reportBytes);
  }

  fs.mkdirSync(sessionDir, { recursive: true });
  const fixtureBundle = fs.readFileSync(path.resolve("evals/fixtures/narrative-sources/session/trust.bundle"));
  fs.writeFileSync(path.join(sessionDir, "trust.bundle"), fixtureBundle);
  const requests = [
    {
      source: parseSourceId(`fa1:flow-report:run-envelope:report/${sha8(reportBytes)}`),
      roots: { flowRoot },
    },
  ];
  if (!missingReport) {
    requests.push({
      source: parseSourceId(`fa1:surface-explanation:session/${sha8(fixtureBundle)}:claim-fixture`),
      roots: { sessionDir },
    });
  }
  const { manifest } = snapshotNarrative({
    narrativeDir,
    narrativeId: "envelope-test",
    requests,
    redactionFields: [],
    compiler,
    captureCompleteness,
  }, { now: () => CAPTURED_AT });
  return { root, narrativeDir, reportBytes, fixtureBundle, manifest };
}

test("new source-id streams round-trip encoded components and reject invalid locators", () => {
  const report = parseSourceId("fa1:flow-report:run%2Fone:report/0123abcd");
  assert.equal(report.stream, "flow-report");
  assert.equal(report.scope.runId, "run/one");
  assert.equal(formatSourceId(report), "fa1:flow-report:run%2Fone:report/0123abcd");

  const surface = parseSourceId("fa1:surface-explanation:slug%2Fone/89abcdef:claim%2Fone");
  assert.equal(surface.stream, "surface-explanation");
  assert.deepEqual(surface.scope, { slug: "slug/one", bundleSha8: "89abcdef" });
  assert.equal(surface.locator.claimId, "claim/one");
  assert.equal(formatSourceId(surface), "fa1:surface-explanation:slug%2Fone/89abcdef:claim%2Fone");

  assert.throws(
    () => parseSourceId("fa1:flow-report:run:state/0123abcd"),
    (error) => error instanceof SourceIdParseError && error.code === "invalid_locator",
  );
  assert.throws(
    () => parseSourceId("fa1:surface-explanation:slug/not-a-sha:claim"),
    (error) => error instanceof SourceIdParseError && error.code === "invalid_locator",
  );
});

test("snapshot capture preserves Flow bytes and freezes a stable Surface explanation", () => {
  const { narrativeDir, reportBytes, manifest } = constructedNarrative();
  const flow = manifest.sources.find((entry) => entry.source_id.includes(":flow-report:"));
  const surface = manifest.sources.find((entry) => entry.source_id.includes(":surface-explanation:"));
  assert.equal(flow.status, "snapshotted");
  assert.equal(flow.integrity_class, "path_only");
  assert.deepEqual(Buffer.from(resolveSource(narrativeDir, flow.source_id).content), reportBytes);

  assert.equal(surface.status, "snapshotted");
  assert.equal(surface.integrity_class, "path_only");
  assert.deepEqual(surface.origin.package, { name: "@kontourai/surface", version: "2.10.0" });
  const resolvedSurface = resolveSource(narrativeDir, surface.source_id);
  assert.equal(resolvedSurface.status, "resolved");
  const explanation = JSON.parse(Buffer.from(resolvedSurface.content).toString("utf8"));
  assert.equal(explanation.found, true);
  assert.equal(Buffer.from(resolvedSurface.content).toString("utf8"), stableStringify(explanation));
});

test("compiler emits byte-stable grounded sections with verbatim foreign hashes", () => {
  const { narrativeDir, manifest, reportBytes } = constructedNarrative();
  const config = { compiledAt: COMPILED_AT, renderTitle: "Fixture narrative" };
  const first = composeGroundedNarrative(narrativeDir, config);
  const second = composeGroundedNarrative(narrativeDir, config);
  assert.equal(stableStringify(first), stableStringify(second));
  assert.deepEqual(validateGroundedNarrative(first), []);
  assert.deepEqual(first.capture_completeness, manifest.capture_completeness);
  assert.deepEqual(first.correlation, { turns: [], unplaced: [] });
  assert.deepEqual(first.conclusions, []);
  assert.deepEqual(first.coverage, { sources: 2, embedded: 2, unavailable: 0 });

  const flow = first.sections.find((section) => section.authority === "flow");
  const surface = first.sections.find((section) => section.authority === "surface");
  const runtime = first.sections.find((section) => section.authority === "flow-agents");
  assert.deepEqual(flow.embedded, JSON.parse(reportBytes.toString("utf8")));
  assert.equal(flow.sha256, sha256(reportBytes));
  const surfaceBytes = Buffer.from(stableStringify(surface.embedded));
  assert.equal(surface.sha256, sha256(surfaceBytes));
  assert.equal(runtime.sha256, sha256(Buffer.from(stableStringify(runtime.embedded))));
  assert.deepEqual(first.sections.map((section) => section.authority), ["flow", "surface", "flow-agents"]);
});

test("validator rejects missing sections/provenance and unknown keys", () => {
  const { narrativeDir } = constructedNarrative();
  const valid = composeGroundedNarrative(narrativeDir, { compiledAt: COMPILED_AT });
  const missingSections = structuredClone(valid);
  delete missingSections.sections;
  assert.ok(validateGroundedNarrative(missingSections).some((issue) => issue.path === "$.sections"));
  const missingProvenance = structuredClone(valid);
  delete missingProvenance.provenance;
  assert.ok(validateGroundedNarrative(missingProvenance).some((issue) => issue.path === "$.provenance"));
  const unknown = structuredClone(valid);
  unknown.unratified = true;
  assert.ok(validateGroundedNarrative(unknown).some((issue) => issue.path === "$.unratified" && issue.message === "is not allowed"));
});

test("writer is content-addressed/idempotent and lineage remains append-only", () => {
  const { narrativeDir } = constructedNarrative();
  const envelope = composeGroundedNarrative(narrativeDir, { compiledAt: COMPILED_AT });
  const first = writeEnvelope(narrativeDir, envelope);
  const firstBytes = fs.readFileSync(first.envelopePath);
  const second = writeEnvelope(narrativeDir, envelope);
  assert.equal(second.envelopePath, first.envelopePath);
  assert.equal(second.envelopeSha256, first.envelopeSha256);
  assert.deepEqual(fs.readFileSync(second.envelopePath), firstBytes);
  assert.equal(first.envelopeSha256, sha256(Buffer.from(stableStringify(envelope))));
  const lineage = fs.readFileSync(first.lineagePath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lineage.length, 2);
  assert.deepEqual(lineage[0], lineage[1]);
  assert.equal(lineage[0].envelope_sha256, first.envelopeSha256);
});

test("declared unavailable source is propagated while mutated blobs fail typed verification", () => {
  const unavailableFixture = constructedNarrative({ missingReport: true });
  const envelope = composeGroundedNarrative(unavailableFixture.narrativeDir, { compiledAt: COMPILED_AT });
  assert.deepEqual(envelope.unavailable_sources, [{
    source_ref: unavailableFixture.manifest.sources[0].source_id,
    reason: "not_captured",
  }]);
  assert.deepEqual(envelope.coverage, { sources: 1, embedded: 0, unavailable: 1 });
  assert.deepEqual(validateGroundedNarrative(envelope), []);

  const corruptFixture = constructedNarrative();
  const entry = corruptFixture.manifest.sources.find((source) => source.status === "snapshotted");
  fs.writeFileSync(path.join(corruptFixture.narrativeDir, "sources", entry.sha256), "mutated");
  assert.throws(
    () => composeGroundedNarrative(corruptFixture.narrativeDir, { compiledAt: COMPILED_AT }),
    (error) => error instanceof GroundedNarrativeError
      && error.code === "source_integrity_failed"
      && error.sourceId === entry.source_id,
  );
});
