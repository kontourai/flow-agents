// #1172 review HIGH-2/HIGH-3: the Stop gate's turn-ending contract.
//
// The reviewed defect was not "Stop ends the turn" or "Stop does not" — it was that ONE signal
// (`stop_hook_active`) was being used to decide for two classes of block with opposite needs:
//
//   SOFT blocks own their own termination (goal-fit's max-blocks release valve). Any adapter
//     fence pre-empts that valve, truncating it below the count the gate promises the operator.
//   HARD blocks are non-releasable by design and have NO termination of their own, so the
//     adapter must supply one — and must not depend solely on a runtime field that is no longer
//     in the published hooks reference.
//
// So these tests pin three things: the classification channel (a structured control line, never
// prose), the asymmetric decision it drives, and the backstop that bounds the case where the
// runtime signal never arrives.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require_ = createRequire(import.meta.url);
const {
  STOP_CONTROL_PREFIX,
  DEFAULT_MAX_STOP_BLOCKS,
  resolveMaxStopBlocks,
  parseStopControl,
  stripStopControl,
  stopEscalationFile,
  recordStopBlock,
  clearStopBlocks,
  stopTurnDecision,
} = require_(path.join(packageRoot, "scripts", "hooks", "lib", "stop-escalation.js"));
const goalFit = require_(path.join(packageRoot, "scripts", "hooks", "stop-goal-fit.js"));

function scratch() {
  return makeFixtureDir("stop-escalation-");
}

const TERMINAL_LINE = `${STOP_CONTROL_PREFIX} {"v":1,"terminal":true,"code":"non-releasable-hard-block"}`;

// ---------------------------------------------------------------------------
// The contract literal
// ---------------------------------------------------------------------------

test("contract: stop-goal-fit.js and the adapter lib agree on the control-line literal", () => {
  // The hook cannot require this lib (it ships a byte-identical context/ mirror with a fixed lib
  // subset), so it declares its own copy. A one-sided rename would silently unlatch hard-block
  // escalation — every hard block would read as soft and never reach a human.
  assert.equal(goalFit.STOP_CONTROL_PREFIX, STOP_CONTROL_PREFIX);
});

// ---------------------------------------------------------------------------
// Parsing and stripping
// ---------------------------------------------------------------------------

test("control line: a terminal declaration is parsed out of surrounding hook text", () => {
  const parsed = parseStopControl(`[stop-gate] Goal Fit warning:\n - a gap\n${TERMINAL_LINE}`);
  assert.equal(parsed.terminal, true);
  assert.deepEqual(parsed.codes, ["non-releasable-hard-block"]);
});

test("control line: absence reads as SOFT, never terminal", () => {
  assert.equal(parseStopControl("[stop-gate] Stop blocked — 3 evidence gap(s) (block 1)").terminal, false);
});

test("control line: a malformed payload degrades to SOFT rather than throwing", () => {
  // Failing soft is the safe direction: a false "terminal" truncates goal-fit's release valve,
  // while a missed one is still bounded by the consecutive-block backstop.
  assert.equal(parseStopControl(`${STOP_CONTROL_PREFIX} not json at all`).terminal, false);
  assert.equal(parseStopControl(`${STOP_CONTROL_PREFIX} ["array"]`).terminal, false);
  assert.equal(parseStopControl(`${STOP_CONTROL_PREFIX}`).terminal, false);
});

test("control line: never reaches a model or a human", () => {
  const stripped = stripStopControl(`[stop-gate] Goal Fit warning:\n - a gap\n${TERMINAL_LINE}`);
  assert.ok(!stripped.includes(STOP_CONTROL_PREFIX));
  assert.ok(!stripped.includes("terminal"));
  assert.equal(stripped, "[stop-gate] Goal Fit warning:\n - a gap");
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const noStreak = { count: 1, threshold: 5, exhausted: false };

test("decision: a SOFT block never ends the turn, even on the continuation firing", () => {
  // This is the regression the review caught. Fencing here truncates goal-fit's documented
  // 3-block valve to ~2 and makes its own "after 3 identical blocks I stop blocking" a lie.
  const decision = stopTurnDecision({ control: { terminal: false }, stopHookActive: true, streak: noStreak });
  assert.equal(decision.endTurn, false);
});

test("decision: a HARD block's FIRST contact hands the reason to the model", () => {
  const decision = stopTurnDecision({ control: { terminal: true }, stopHookActive: false, streak: noStreak });
  assert.equal(decision.endTurn, false, "the model gets one self-correction attempt");
});

test("decision: a HARD block's continuation firing ends the turn", () => {
  const decision = stopTurnDecision({ control: { terminal: true }, stopHookActive: true, streak: noStreak });
  assert.equal(decision.endTurn, true);
  assert.equal(decision.cause, "terminal-continuation");
});

test("decision: the backstop ends the turn with no marker and no runtime signal at all", () => {
  // The missing-`stop_hook_active` failure mode: without this, a non-releasable block would
  // re-prompt the model forever with no human ever seeing it.
  const decision = stopTurnDecision({
    control: { terminal: false },
    stopHookActive: undefined,
    streak: { count: 5, threshold: 5, exhausted: true },
  });
  assert.equal(decision.endTurn, true);
  assert.equal(decision.cause, "consecutive-blocks-exhausted");
  assert.match(decision.note, /blocked 5 times in a row/);
});

test("decision: the backstop threshold sits above goal-fit's soft valve", () => {
  // If it did not, the backstop would fire during ordinary soft blocking and re-break the valve
  // by a different route. goal-fit's default max_blocks is 3.
  assert.ok(DEFAULT_MAX_STOP_BLOCKS > 3, `expected > 3, got ${DEFAULT_MAX_STOP_BLOCKS}`);
  assert.equal(resolveMaxStopBlocks({ FLOW_AGENTS_STOP_MAX_BLOCKS: "2" }), 2);
  assert.equal(resolveMaxStopBlocks({ FLOW_AGENTS_STOP_MAX_BLOCKS: "nonsense" }), DEFAULT_MAX_STOP_BLOCKS);
  assert.equal(resolveMaxStopBlocks({ FLOW_AGENTS_STOP_MAX_BLOCKS: "0" }), DEFAULT_MAX_STOP_BLOCKS);
});

// ---------------------------------------------------------------------------
// The counter
// ---------------------------------------------------------------------------

test("counter: consecutive blocks accumulate to the threshold, then stay exhausted", () => {
  const cwd = scratch();
  const opts = { cwd, actorKey: "counter-actor", env: { FLOW_AGENTS_STOP_MAX_BLOCKS: "3" } };
  assert.deepEqual([recordStopBlock(opts).exhausted, recordStopBlock(opts).exhausted], [false, false]);
  assert.equal(recordStopBlock(opts).exhausted, true);
  assert.equal(recordStopBlock(opts).exhausted, true, "an unresolved situation keeps escalating");
});

test("counter: clearing resets the streak (a non-blocking Stop, or a SessionStart)", () => {
  const cwd = scratch();
  const opts = { cwd, actorKey: "counter-actor", env: { FLOW_AGENTS_STOP_MAX_BLOCKS: "2" } };
  recordStopBlock(opts);
  clearStopBlocks({ cwd, actorKey: "counter-actor" });
  assert.equal(recordStopBlock(opts).count, 1);
});

test("counter: state is filed per actor, so one agent's Stop strikes never escalate another's", () => {
  const cwd = scratch();
  const env = { FLOW_AGENTS_STOP_MAX_BLOCKS: "2" };
  recordStopBlock({ cwd, actorKey: "actor-a", env });
  const other = recordStopBlock({ cwd, actorKey: "actor-b", env });
  assert.equal(other.count, 1);
  assert.equal(other.exhausted, false);
  assert.notEqual(stopEscalationFile(cwd, "actor-a"), stopEscalationFile(cwd, "actor-b"));
});

test("counter: an unwritable store degrades to never escalating, never to a dropped block", () => {
  // Fail-open direction matters: the block is already decided by the hook. Storage only decides
  // whether we stop ASKING, so a broken store must lose the escalation, not the refusal.
  const cwd = scratch();
  const file = stopEscalationFile(cwd, "blocked-actor");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(file, { recursive: true }); // a directory where the record should be: read + write both fail
  const first = recordStopBlock({ cwd, actorKey: "blocked-actor", env: { FLOW_AGENTS_STOP_MAX_BLOCKS: "2" } });
  const second = recordStopBlock({ cwd, actorKey: "blocked-actor", env: { FLOW_AGENTS_STOP_MAX_BLOCKS: "2" } });
  assert.equal(first.exhausted, false);
  assert.equal(second.exhausted, false, "an unpersistable counter can never reach its threshold");
});
