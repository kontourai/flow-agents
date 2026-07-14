import test from "node:test";
import assert from "node:assert/strict";

import {
  SourceIdParseError,
  buildCaptureCompleteness,
  compareSourceIds,
  formatSourceId,
  integrityClassForSource,
  parseSourceId,
} from "../../build/src/index.js";

const ids = [
  "fa1:telemetry:full/session%2Fone:event%3Aone#1",
  "fa1:cmdlog:task-617:7/0123abcd",
  "fa1:cmdlog:task-617:line-2/89abcdef",
  "fa1:agent-event:task-617/agent%3A1:0/0123abcd",
  "fa1:delegation:task-617/agent-1:3/89abcdef",
  "fa1:trust-claim:task-617/0123abcd:claim%3Aone",
  "fa1:trust-evidence:task-617/89abcdef:evidence%2Fone",
  "fa1:flow-state:run%2Fone:state/0123abcd",
  "fa1:flow-transition:run-1:4/89abcdef",
  "fa1:transcript:0123abcd:10-25",
  `fa1:file:src%2Fnarrative%2Fsource-ids.ts:${"a".repeat(64)}`,
  `fa1:file:src%2Findex.ts:${"b".repeat(40)}`,
];

test("source IDs round-trip every stream with canonical component encoding", () => {
  for (const id of ids) assert.equal(formatSourceId(parseSourceId(id)), id, id);
});

test("telemetry ordinal is a stable duplicate disambiguator", () => {
  const first = parseSourceId("fa1:telemetry:full/s:event#0");
  const second = parseSourceId("fa1:telemetry:full/s:event#1");
  assert.equal(first.stream, "telemetry");
  assert.equal(first.ordinal, 0);
  assert.equal(second.ordinal, 1);
  assert.equal(compareSourceIds(first, second), -1);
});

test("parser rejects malformed, noncanonical, and misplaced components with typed errors", () => {
  for (const id of [
    "fa2:telemetry:full/s:e",
    "fa1:unknown:a:b",
    "fa1:telemetry:full/s:e#01",
    "fa1:cmdlog:slug:1/ABCDEF12",
    "fa1:flow-state:run:other/0123abcd",
    "fa1:transcript:0123abcd:9-2",
    "fa1:file:src/raw:path",
    "fa1:agent-event:slug/agent:one/0123abcd",
  ]) {
    assert.throws(() => parseSourceId(id), (error) => error instanceof SourceIdParseError && typeof error.code === "string", id);
  }
});

test("compareSourceIds canonicalizes string inputs", () => {
  assert.equal(compareSourceIds(ids[0], ids[0]), 0);
  assert.equal(compareSourceIds(ids[0], ids[1]), ids[0] < ids[1] ? -1 : 1);
});

test("integrity defaults distinguish legacy command logs and file locator kinds", () => {
  assert.equal(integrityClassForSource(parseSourceId(ids[0])), "rotatable");
  assert.equal(integrityClassForSource(parseSourceId(ids[1])), "hash_chained");
  assert.equal(integrityClassForSource(parseSourceId(ids[2])), "append_only_unhashed");
  assert.equal(integrityClassForSource(parseSourceId(ids[10])), "overwritten_in_place");
  assert.equal(integrityClassForSource(parseSourceId(ids[11])), "hash_chained");
});

test("capture completeness detects configured channel presence and always discloses known gaps", () => {
  const completeness = buildCaptureCompleteness({ full: {}, analytics: false, custom: { enabled: true } }, ["full", "analytics", "custom", "missing"]);
  assert.deepEqual(completeness.channels, { full: "active", analytics: "inactive", custom: "active", missing: "unknown" });
  assert.deepEqual(completeness.known_gaps.map((gap) => [gap.class, gap.ref]), [
    ["mcp_non_native_tools", "flow-agents#492"],
    ["actor_attribution_conflation", "flow-agents#423"],
    ["cross_session_event_contamination", "flow-agents#271"],
  ]);
});
