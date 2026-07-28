import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRequire } from "node:module";

import { classifyLane, readFleet } from "../../build/src/lib/liveness-fleet.js";

const { freshHolders } = createRequire(import.meta.url)("../../scripts/hooks/lib/liveness-read.js");

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

// --- ordering: APPEND order is authoritative, and must agree with the real gate ---

test("classifyLane: APPEND order decides, so the reported event is the one the gate walked to", () => {
  // Regression, and the second attempt at it. The original bug was that the lane's fields were
  // picked by TIMESTAMP while freshHolders decides by ARRAY order, so the row could contradict
  // itself. Sorting by timestamp "fixed" that and broke something worse: `at` is client-written,
  // so a skewed or spoofed clock could pin a lane `held` here while the real gate reclaimed it.
  // Append order is the one ordering a writer cannot forge after the fact, so it decides both.
  const lane = laneFor([claim(3 * MIN), beat(1 * MIN), release(2 * MIN)]);
  assert.equal(lane.state, "released", "the release is last in the file, so the lane is released");
  assert.equal(lane.lastEventAt, at(2 * MIN), "and the reported event is that same release");
});

test("classifyLane: a future-dated stamp cannot pin a lane held (clock skew or spoofing)", () => {
  const lane = laneFor([
    { type: "claim", subjectId: "s", actor: "a", at: "2075-12-20T12:00:00.000Z", ttlSeconds: 1800 },
    release(1 * MIN),
  ]);
  assert.equal(lane.state, "released", "a bogus future claim must not outrank a later real release");
});

test("classifyLane: never disagrees with the real gate about who is held", () => {
  // The invariant that matters. `freshHolders` is what actually blocks a push; a read surface that
  // describes the fleet differently from the gate it describes is worse than one that is merely
  // internally inconsistent.
  const fixtures = [
    [claim(1 * MIN)],
    [claim(3 * MIN), beat(1 * MIN), release(2 * MIN)],
    [claim(3 * MIN), release(2 * MIN), beat(1 * MIN)],
    [claim(120 * MIN, 1800)],
    [release(5 * MIN), claim(1 * MIN)],
    [{ type: "claim", subjectId: "s", actor: "a", at: "2075-12-20T12:00:00.000Z", ttlSeconds: 1800 }, release(1 * MIN)],
    [claim(2 * MIN), { type: "heartbeat", subjectId: "s", actor: "a", at: "not-a-timestamp" }],
  ];
  for (const events of fixtures) {
    const lane = laneFor(events);
    const gateSaysHeld = (freshHolders(events, "s", null, NOW) ?? []).some((h) => h.actor === "a" && h.fresh);
    assert.equal(
      lane.state === "held",
      gateSaysHeld,
      `fleet view and gate disagree for ${JSON.stringify(events)} -> ${JSON.stringify(lane)}`,
    );
  }
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

test("readFleet: append order carries end to end through a real stream", () => {
  const { root } = repoFixture("ordered", [claim(3 * MIN), beat(1 * MIN), release(2 * MIN)].map((e) => JSON.stringify(e)));
  const result = readFleet({ roots: [root], nowMs: NOW, includeStrandedStreams: false });
  assert.equal(result.lanes.length, 1);
  assert.equal(result.lanes[0].state, "released", "the release is last in the file");
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
  assert.equal(result.lanes[0].state, "held", "the surviving heartbeat is well inside its TTL");
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

test("readFleet: a dangling symlink at a stream path warns instead of reading as 'never claimed'", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-fleet-symlink-"));
  const stream = path.join(root, ".kontourai", "flow-agents", "liveness", "events.jsonl");
  fs.mkdirSync(path.dirname(stream), { recursive: true });
  fs.symlinkSync(path.join(root, "gone", "events.jsonl"), stream);
  const result = readFleet({ roots: [root], nowMs: NOW, includeStrandedStreams: false });
  assert.equal(result.lanes.length, 0);
  assert.ok(result.warnings.length >= 1, "a broken link is evidence of a vanished target, not of an idle repo");
  assert.match(result.warnings[0].detail, /unreadable stream/);
});
