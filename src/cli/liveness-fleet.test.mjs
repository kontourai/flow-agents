import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyLane, readFleet } from "../../build/src/lib/liveness-fleet.js";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

function laneFor(events, nowMs = NOW) {
  const lanes = classifyLane(events, nowMs);
  assert.equal(lanes.length, 1, `expected exactly one lane, got ${lanes.length}`);
  return lanes[0];
}

const claim = (msAgo, ttlSeconds = 1800) => ({ type: "claim", subjectId: "s", actor: "a", at: at(msAgo), ttlSeconds });
const beat = (msAgo) => ({ type: "heartbeat", subjectId: "s", actor: "a", at: at(msAgo) });
const release = (msAgo) => ({ type: "release", subjectId: "s", actor: "a", at: at(msAgo) });

// --- ordering: the stream's chronology is authoritative, not its file order ---

test("classifyLane: a release that is OLDER than a later heartbeat does not release the lane", () => {
  // Regression. freshHolders decides release-vs-active by ARRAY order while the lane's own fields
  // are chronological; when a concurrent append put an earlier-stamped release after a heartbeat,
  // the emitted row said `reclaimable` while simultaneously reporting a 60s age under a 1800s TTL.
  const lane = laneFor([claim(3 * MIN), beat(1 * MIN), release(2 * MIN)]);
  assert.equal(lane.lastEventAt, at(1 * MIN), "the heartbeat is chronologically latest");
  assert.equal(lane.state, "held");
  assert.ok(
    lane.ageSeconds * 1000 < lane.ttlSeconds * 1000,
    "a lane reported inside its TTL must never also be reported as reclaimable",
  );
});

test("classifyLane: a release that IS the latest event still releases the lane", () => {
  const lane = laneFor([claim(3 * MIN), beat(2 * MIN), release(1 * MIN)]);
  assert.equal(lane.state, "released");
});

test("classifyLane: state never contradicts the age and TTL reported beside it", () => {
  for (const events of [
    [claim(3 * MIN), beat(1 * MIN), release(2 * MIN)],
    [claim(1 * MIN), beat(2 * MIN)],
    [release(2 * MIN), claim(1 * MIN)],
    [claim(5 * MIN, 60)],
  ]) {
    const lane = laneFor(events);
    if (lane.state === "held") {
      assert.ok(lane.ageSeconds < lane.ttlSeconds, `held lane must be inside its TTL: ${JSON.stringify(lane)}`);
    }
    if (lane.state === "reclaimable") {
      assert.ok(lane.ageSeconds >= lane.ttlSeconds, `reclaimable lane must be past its TTL: ${JSON.stringify(lane)}`);
    }
  }
});

test("classifyLane: a lane past its TTL is reclaimable", () => {
  assert.equal(laneFor([claim(120 * MIN, 1800)]).state, "reclaimable");
});

test("classifyLane: an unparsable timestamp never yields held", () => {
  const lane = laneFor([claim(2 * MIN), { type: "heartbeat", subjectId: "s", actor: "a", at: "not-a-timestamp" }]);
  assert.notEqual(lane.state, "held", "an unreadable lease must not hold the lane");
});

test("classifyLane: malformed entries are skipped, not fatal", () => {
  const lanes = classifyLane(
    [null, undefined, 42, "nope", {}, { subjectId: "s" }, { subjectId: "s", actor: "a" }, claim(1 * MIN)],
    NOW,
  );
  assert.equal(lanes.length, 1, "only the one well-formed lane is reported");
  assert.equal(lanes[0].state, "held");
});

test("classifyLane: separate actors on one subject are separate lanes", () => {
  const lanes = classifyLane(
    [claim(1 * MIN), { type: "claim", subjectId: "s", actor: "b", at: at(120 * MIN), ttlSeconds: 1800 }],
    NOW,
  );
  assert.equal(lanes.length, 2);
  assert.deepEqual(lanes.map((l) => l.state).sort(), ["held", "reclaimable"]);
});

// --- readFleet over real streams on disk ---

function repoFixture(name, lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flow-agents-fleet-${name}-`));
  const stream = path.join(root, ".kontourai", "flow-agents", "liveness", "events.jsonl");
  fs.mkdirSync(path.dirname(stream), { recursive: true });
  fs.writeFileSync(stream, lines.join("\n") + "\n");
  return { root, stream };
}

test("readFleet: reads a stream and carries the ordering fix end to end", () => {
  const { root } = repoFixture("ordered", [claim(3 * MIN), beat(1 * MIN), release(2 * MIN)].map((e) => JSON.stringify(e)));
  const result = readFleet({ roots: [root], nowMs: NOW, includeStrandedStreams: false });
  assert.equal(result.lanes.length, 1);
  assert.equal(result.lanes[0].state, "held");
  assert.equal(result.lanes[0].repoRoot, root);
});

test("readFleet: a truncated final JSONL line does not lose the well-formed events", () => {
  const { root } = repoFixture("truncated", [
    JSON.stringify(claim(3 * MIN)),
    JSON.stringify(beat(1 * MIN)),
    '{"type":"heartbeat","subjectId":"s","actor":"a","at":"2026-01-0', // torn mid-append
  ]);
  const result = readFleet({ roots: [root], nowMs: NOW, includeStrandedStreams: false });
  assert.equal(result.lanes.length, 1, "a torn trailing line must not discard the whole stream");
  assert.equal(result.lanes[0].state, "held");
});

test("readFleet: a missing stream contributes no lanes and does not throw", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-fleet-empty-"));
  const result = readFleet({ roots: [root], nowMs: NOW, includeStrandedStreams: false });
  assert.deepEqual(result.lanes, []);
  assert.deepEqual(result.streams, []);
});

test("readFleet: an unreadable stream surfaces a warning rather than failing silently", () => {
  const { root, stream } = repoFixture("unreadable", [JSON.stringify(claim(1 * MIN))]);
  fs.rmSync(stream);
  fs.mkdirSync(stream); // a directory where a file is expected
  const result = readFleet({ roots: [root], nowMs: NOW, includeStrandedStreams: false });
  assert.equal(result.lanes.length, 0);
  assert.ok(result.warnings.length >= 1, "a partial fleet view that looks complete is worse than none");
  assert.match(result.warnings[0].detail, /unreadable stream/);
});

test("readFleet: lanes are sorted newest first, deterministically", () => {
  const { root } = repoFixture("sorted", [
    JSON.stringify({ type: "claim", subjectId: "older", actor: "a", at: at(30 * MIN), ttlSeconds: 1800 }),
    JSON.stringify({ type: "claim", subjectId: "newer", actor: "a", at: at(1 * MIN), ttlSeconds: 1800 }),
  ]);
  const lanes = readFleet({ roots: [root], nowMs: NOW, includeStrandedStreams: false }).lanes;
  assert.deepEqual(lanes.map((l) => l.subjectId), ["newer", "older"]);
});
