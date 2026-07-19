import test from "node:test";
import assert from "node:assert/strict";

import { buildTurnSpine } from "../../build/src/index.js";

const event = (sourceId, sessionId, eventType, turnId) => ({
  sourceId,
  record: {
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    event_type: eventType,
    ...(turnId === undefined ? {} : { hook: { turn_id: turnId } }),
  },
});

test("turn IDs group by session and first appearance order", () => {
  assert.deepEqual(buildTurnSpine([
    event("s1", "session-a", "turn.user", "turn-2"),
    event("s2", "session-a", "tool.invoke", "turn-1"),
    event("s3", "session-a", "tool.result", "turn-2"),
    event("s4", "session-b", "tool.invoke", "turn-2"),
  ]), [
    { ordinal: 0, sessionId: "session-a", turnId: "turn-2", boundary: { derived: false }, sources: ["s1", "s3"] },
    { ordinal: 1, sessionId: "session-a", turnId: "turn-1", boundary: { derived: false }, sources: ["s2"] },
    { ordinal: 2, sessionId: "session-b", turnId: "turn-2", boundary: { derived: false }, sources: ["s4"] },
  ]);
});

test("spine-less events retain turn zero and turn.user owns the boundary it starts", () => {
  assert.deepEqual(buildTurnSpine([
    event("before", "session-a", "session.start"),
    event("user-1", "session-a", "turn.user", ""),
    event("tool-1", "session-a", "tool.invoke"),
    event("user-2", "session-a", "turn.user"),
  ]), [
    { ordinal: 0, sessionId: "session-a", boundary: { derived: true, rule_id: "turn-spine/v1" }, sources: ["before"] },
    { ordinal: 1, sessionId: "session-a", boundary: { derived: true, rule_id: "turn-spine/v1" }, sources: ["user-1", "tool-1"] },
    { ordinal: 2, sessionId: "session-a", boundary: { derived: true, rule_id: "turn-spine/v1" }, sources: ["user-2"] },
  ]);
});

test("spine-less turns advance independently when sessions interleave", () => {
  assert.deepEqual(buildTurnSpine([
    event("a0", "a", "session.start"),
    event("b1", "b", "turn.user"),
    event("a1", "a", "tool.invoke"),
    event("a2", "a", "turn.user"),
    event("b2", "b", "tool.result"),
  ]), [
    { ordinal: 0, sessionId: "a", boundary: { derived: true, rule_id: "turn-spine/v1" }, sources: ["a0", "a1"] },
    { ordinal: 1, sessionId: "b", boundary: { derived: true, rule_id: "turn-spine/v1" }, sources: ["b1", "b2"] },
    { ordinal: 2, sessionId: "a", boundary: { derived: true, rule_id: "turn-spine/v1" }, sources: ["a2"] },
  ]);
});

test("records without a session are retained in one quarantine turn", () => {
  const turns = buildTurnSpine([
    event("bad-1", undefined, "tool.invoke"),
    event("good", "a", "turn.user"),
    event("bad-2", "", "tool.result"),
  ]);
  assert.deepEqual(turns.at(-1), {
    ordinal: -1,
    sessionId: "quarantine",
    boundary: { derived: true, rule_id: "turn-spine/v1" },
    sources: ["bad-1", "bad-2"],
  });
});

test("turn correlation is deterministic and does not mutate inputs", () => {
  const records = [event("u", "a", "turn.user"), event("t", "a", "tool.invoke")];
  const before = structuredClone(records);
  assert.deepEqual(buildTurnSpine(records), buildTurnSpine(records));
  assert.deepEqual(records, before);
});
