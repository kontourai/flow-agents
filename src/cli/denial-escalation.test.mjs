// #1005: a denied tool call must end THE CALL, not THE TURN.
//
// The mechanism the issue asked to establish first turned out to be harness-mechanical and
// ours: claude-hook-adapter.js emitted `continue: false` on every PreToolUse block, which
// the Claude Code hook contract defines as "stops Claude processing entirely after the hook
// runs" and which "takes precedence over any event-specific decision fields" -- so the deny
// reason (permissionDecisionReason) never reached the model, and the reason that DID travel
// (stopReason) is shown to the user and explicitly not to Claude. That is the stall.
//
// These tests pin the three tiers:
//   tier 1 -- the message reads as recoverable guidance, keeping every remediation path;
//   tier 2 -- a per-flow-step counter keyed on denial identity (rule id + resolved target),
//             escalating only on the third identical denial in one step;
//   tier 3 -- Stop's own wire contract. #1172 finished the job #1005 started: a blocking Stop
//             now returns decision:"block" + reason (the model-facing channel) on first contact
//             and ends the turn only on the continuation firing (stop_hook_active).
//
// The two cases that ARE the policy are the last two sections: a compliant route-around to a
// different supported form must not increment, and the third identical denial must escalate.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const require_ = createRequire(import.meta.url);

const hooksLib = path.join(packageRoot, "scripts", "hooks", "lib");
const { stripIncidentRegister, shapeDenialMessage } = require_(path.join(hooksLib, "denial-guidance.js"));
const { denialIdentity, recordDenial, resolveTarget, denialStreakFile } =
  require_(path.join(hooksLib, "denial-escalation.js"));

// Real message text produced by config-protection.js today (captured verbatim from a live
// denial), so the shaping and identity rules are proven against the actual wire format.
const INTERPRETER_DENIAL_SETTINGS =
  'BLOCKED: Detected node -e with protected path token ".claude/settings.json" in a Bash command. ' +
  "Interpreter invocations (node -e, py3 -c, sed -i, perl -e) that reference protected gate files " +
  "could tamper with the gate. Do not disable this hook. There is no sanctioned automated writer " +
  "for this file. Ask a human maintainer to edit it directly. Never disable this hook to make the " +
  "write. NOTE: This check has INCOMPLETE COVERAGE — runtime path construction evades it. " +
  "If you only need to READ this file: `python3 -m json.tool <file>` is never blocked by this hook.";

const PROTECTED_FILE_DENIAL =
  "BLOCKED: Modifying prettier.config.js is not allowed. Fix the source code to satisfy " +
  "linter/formatter rules instead of weakening the config. If this is a legitimate config change, " +
  "disable the config-protection hook temporarily.";

const STATE_JSON_DENIAL =
  "BLOCKED: Writing to .kontourai/flow-agents/<slug>/state.json is not allowed. This file is " +
  "protected because it carries lifecycle state. Use `npm run workflow:sidecar -- advance-state " +
  "<artifact-dir> --status <status> --phase <phase>`. Never disable this hook to make the write.";

/** Isolated scratch root, so no test ever writes into the real .kontourai tree. */
function scratchRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "denial-streak-"));
}

// ---------------------------------------------------------------------------
// Tier 1 -- message design: recoverable guidance, not an incident report.
// ---------------------------------------------------------------------------

test("tier 1: the BLOCKED: opener is dropped", () => {
  const shaped = shapeDenialMessage(INTERPRETER_DENIAL_SETTINGS, { escalate: false });
  assert.ok(!/BLOCKED:/.test(shaped), `incident opener survived: ${shaped}`);
  assert.match(shaped, /^Refused: /);
});

test("tier 1: the doubled 'never disable this hook' warnings are dropped", () => {
  const shaped = shapeDenialMessage(INTERPRETER_DENIAL_SETTINGS, { escalate: false });
  assert.ok(!/disable this hook/i.test(shaped), `disable-warning survived: ${shaped}`);
});

test("tier 1: advice to disable the hook is dropped (enforces config-protection AC7 centrally)", () => {
  const shaped = shapeDenialMessage(PROTECTED_FILE_DENIAL, { escalate: false });
  assert.ok(
    !/disable the config-protection hook/i.test(shaped),
    `message still advises disabling the gate: ${shaped}`,
  );
});

test("tier 1: the self-disclosed incomplete-coverage note is dropped", () => {
  const shaped = shapeDenialMessage(INTERPRETER_DENIAL_SETTINGS, { escalate: false });
  assert.ok(!/INCOMPLETE COVERAGE/i.test(shaped), `coverage disclosure survived: ${shaped}`);
  assert.ok(!/NOTE: This check/i.test(shaped), `coverage note survived: ${shaped}`);
});

test("tier 1: every remediation path is preserved", () => {
  const interpreter = shapeDenialMessage(INTERPRETER_DENIAL_SETTINGS, { escalate: false });
  // The read escape -- the genuinely useful part of the current message.
  assert.match(interpreter, /python3 -m json\.tool/);
  assert.match(interpreter, /Ask a human maintainer to edit it directly/);

  const state = shapeDenialMessage(STATE_JSON_DENIAL, { escalate: false });
  // The sanctioned-writer form.
  assert.match(state, /npm run workflow:sidecar -- advance-state/);

  const protectedFile = shapeDenialMessage(PROTECTED_FILE_DENIAL, { escalate: false });
  assert.match(protectedFile, /Fix the source code to satisfy/);
});

test("tier 1: an ordinary refusal tells the agent the turn continues", () => {
  const shaped = shapeDenialMessage(STATE_JSON_DENIAL, { escalate: false });
  assert.match(shaped, /refused the tool call, not your turn/i);
});

test("tier 1: an escalated refusal reports the escalation instead", () => {
  const shaped = shapeDenialMessage(STATE_JSON_DENIAL, {
    escalate: true, count: 3, threshold: 3, ruleId: "config-protection.protected-path", target: "state.json",
  });
  assert.match(shaped, /Escalating/);
  assert.match(shaped, /3 times in this flow step/);
  assert.ok(!/refused the tool call, not your turn/i.test(shaped));
});

test("tier 1: stripping is text-only -- it never empties a message", () => {
  assert.ok(stripIncidentRegister(INTERPRETER_DENIAL_SETTINGS).length > 80);
  assert.equal(shapeDenialMessage("", { escalate: false }).split("\n")[0], "Refused by Flow Agents hook policy.");
});

// ---------------------------------------------------------------------------
// Tier 2 -- denial identity: rule id + resolved target, never raw command text.
// ---------------------------------------------------------------------------

test("identity: distinct rules get distinct rule ids", () => {
  assert.equal(denialIdentity("config-protection", PROTECTED_FILE_DENIAL).ruleId, "config-protection.protected-file");
  assert.equal(denialIdentity("config-protection", STATE_JSON_DENIAL).ruleId, "config-protection.protected-path");
  assert.equal(
    denialIdentity("config-protection", INTERPRETER_DENIAL_SETTINGS).ruleId,
    "config-protection.interpreter-write",
  );
});

test("identity: the resolved target is the protected path, not the command", () => {
  const id = denialIdentity("config-protection", INTERPRETER_DENIAL_SETTINGS);
  assert.equal(id.target, ".claude/settings.json");
  assert.ok(!/node -e/.test(id.key), `command text leaked into the counter key: ${id.key}`);
});

test("identity: swapping the interpreter does not change the identity (same rule, same file)", () => {
  const viaNode = denialIdentity("config-protection", INTERPRETER_DENIAL_SETTINGS);
  const viaPython = denialIdentity(
    "config-protection",
    INTERPRETER_DENIAL_SETTINGS.replace("node -e", "python3 -c"),
  );
  assert.equal(viaPython.key, viaNode.key, "rephrasing the same offence must not reset the counter");
});

test("identity: a different protected path under the same rule is a different identity", () => {
  const a = denialIdentity("config-protection", INTERPRETER_DENIAL_SETTINGS);
  const b = denialIdentity(
    "config-protection",
    INTERPRETER_DENIAL_SETTINGS.replace(".claude/settings.json", ".kontourai/flow-agents/current.json"),
  );
  assert.equal(a.ruleId, b.ruleId);
  assert.notEqual(a.key, b.key);
});

test("identity: an unrecognised denial still gets a stable, non-command-text id", () => {
  const msg = "BLOCKED: Some future rule refused /repo/some/path/thing.txt for reason 42.";
  const a = denialIdentity("future-hook", msg);
  const b = denialIdentity("future-hook", msg.replace("/repo/some/path/thing.txt", "/repo/other/file.txt").replace("42", "7"));
  assert.equal(a.key, b.key, "the fallback must key on the rule skeleton, not the particulars");
  assert.match(a.ruleId, /^future-hook\.unclassified-/);
});

test("identity: resolveTarget narrows detector prose to the resolved thing", () => {
  assert.equal(resolveTarget('node -e with protected path token ".claude/settings.json"'), ".claude/settings.json");
  assert.equal(resolveTarget("shell redirect (>) to /repo/.kontourai/flow-agents/current.json"), "/repo/.kontourai/flow-agents/current.json");
  assert.equal(resolveTarget("cp into delivery (delivery-protected destination)"), "delivery");
});

// ---------------------------------------------------------------------------
// THE POLICY, CASE (a): a compliant route-around must NOT increment.
// ---------------------------------------------------------------------------

test("counter: routing around to a different supported form does not accumulate strikes", () => {
  const cwd = scratchRepo();
  const actorKey = "test:route-around";

  // The agent is refused once for an interpreter write to settings.json.
  const first = recordDenial({ hookId: "config-protection", message: INTERPRETER_DENIAL_SETTINGS, cwd, actorKey });
  assert.equal(first.count, 1);
  assert.equal(first.escalate, false);

  // It complies: it stops trying to write settings.json and instead hits a DIFFERENT rule
  // on a different target (the legitimate route-around is, by definition, a different call).
  const second = recordDenial({ hookId: "config-protection", message: STATE_JSON_DENIAL, cwd, actorKey });
  const third = recordDenial({ hookId: "config-protection", message: PROTECTED_FILE_DENIAL, cwd, actorKey });

  // Three denials in the step, but no identity repeated -- nothing escalates. Keying on
  // command text (three different commands) would have been equally wrong in the other
  // direction; what matters is that each distinct identity is still on its first strike.
  assert.equal(second.count, 1, "a different rule must start its own count");
  assert.equal(third.count, 1, "a different rule must start its own count");
  assert.equal(second.escalate, false);
  assert.equal(third.escalate, false);
});

test("counter: a repeat under the same rule but a different resolved target does not escalate", () => {
  const cwd = scratchRepo();
  const actorKey = "test:same-rule-different-target";
  const other = INTERPRETER_DENIAL_SETTINGS.replace(".claude/settings.json", ".kontourai/flow-agents/current.json");

  assert.equal(recordDenial({ hookId: "config-protection", message: INTERPRETER_DENIAL_SETTINGS, cwd, actorKey }).count, 1);
  assert.equal(recordDenial({ hookId: "config-protection", message: other, cwd, actorKey }).count, 1);
  const back = recordDenial({ hookId: "config-protection", message: INTERPRETER_DENIAL_SETTINGS, cwd, actorKey });
  assert.equal(back.count, 2, "the interleaved different-target denial must not have consumed a strike");
  assert.equal(back.escalate, false);
});

// ---------------------------------------------------------------------------
// THE POLICY, CASE (b): the third IDENTICAL denial in one step MUST escalate.
// ---------------------------------------------------------------------------

test("counter: the third identical denial in one flow step escalates", () => {
  const cwd = scratchRepo();
  const actorKey = "test:third-strike";
  const run = () => recordDenial({ hookId: "config-protection", message: INTERPRETER_DENIAL_SETTINGS, cwd, actorKey });

  const first = run();
  assert.equal(first.count, 1);
  assert.equal(first.escalate, false, "a first denial is refusal-with-guidance, never escalation");

  const second = run();
  assert.equal(second.count, 2);
  assert.equal(second.escalate, false, "a second denial still continues the turn");

  const third = run();
  assert.equal(third.count, 3);
  assert.equal(third.escalate, true, "the third identical denial in one step must escalate");
  assert.equal(third.threshold, 3);
});

test("counter: a rephrased-but-identical offence still reaches the third strike", () => {
  const cwd = scratchRepo();
  const actorKey = "test:rephrase";
  const spellings = [
    INTERPRETER_DENIAL_SETTINGS,
    INTERPRETER_DENIAL_SETTINGS.replace("node -e", "python3 -c"),
    INTERPRETER_DENIAL_SETTINGS.replace("node -e", "perl -e"),
  ];
  const results = spellings.map((message) => recordDenial({ hookId: "config-protection", message, cwd, actorKey }));
  assert.deepEqual(results.map((r) => r.count), [1, 2, 3]);
  assert.equal(results[2].escalate, true, "rephrasing the same offence must not buy extra attempts");
});

// ---------------------------------------------------------------------------
// Tier 2 -- scope: per flow step, reset on step transition.
// ---------------------------------------------------------------------------

test("counter: counts reset when the flow step transitions", () => {
  const cwd = scratchRepo();
  const actorKey = "test:step-transition";
  const streakFile = denialStreakFile(cwd, actorKey);
  const run = () => recordDenial({ hookId: "config-protection", message: INTERPRETER_DENIAL_SETTINGS, cwd, actorKey });

  assert.equal(run().count, 1);
  assert.equal(run().count, 2);

  // Simulate a step transition by moving the persisted step key. (The live step key comes
  // from the per-actor current pointer's active_flow_id/active_step_id.)
  const persisted = JSON.parse(fs.readFileSync(streakFile, "utf8"));
  persisted.step = "builder.build/verify";
  fs.writeFileSync(streakFile, JSON.stringify(persisted));

  const afterTransition = run();
  assert.equal(afterTransition.count, 1, "a new flow step must start every identity at zero");
  assert.equal(afterTransition.escalate, false);
});

test("counter: a long delivery does not accumulate strikes across unrelated steps", () => {
  const cwd = scratchRepo();
  const actorKey = "test:no-cross-step";
  const streakFile = denialStreakFile(cwd, actorKey);
  for (const step of ["builder.build/plan", "builder.build/execute", "builder.build/verify"]) {
    const result = recordDenial({ hookId: "config-protection", message: INTERPRETER_DENIAL_SETTINGS, cwd, actorKey });
    assert.equal(result.escalate, false, `one denial per step must never escalate (${step})`);
    const persisted = JSON.parse(fs.readFileSync(streakFile, "utf8"));
    persisted.step = step;
    fs.writeFileSync(streakFile, JSON.stringify(persisted));
  }
});

test("counter: the threshold is operator-overridable", () => {
  const cwd = scratchRepo();
  const actorKey = "test:threshold";
  const env = { ...process.env, FLOW_AGENTS_DENIAL_MAX_REPEATS: "2" };
  const run = () => recordDenial({ hookId: "config-protection", message: STATE_JSON_DENIAL, cwd, actorKey, env });
  assert.equal(run().escalate, false);
  assert.equal(run().escalate, true);
});

// ---------------------------------------------------------------------------
// Tier 3 / mechanism -- the wire contract the Claude Code harness actually reads.
//
// These drive the real adapter end to end, because the defect was never in a hook's
// verdict: it was in the JSON the adapter emitted around that verdict.
// ---------------------------------------------------------------------------

/** Run claude-hook-adapter.js against a payload, in an isolated cwd, as a fixed actor. */
function runClaudeAdapter(event, payload, { cwd, actorKey, hookId, script, env = {} }) {
  const result = spawnSync(
    process.execPath,
    [path.join(packageRoot, "scripts", "hooks", "claude-hook-adapter.js"), event, hookId, script, "standard,strict"],
    {
      input: JSON.stringify(payload),
      encoding: "utf8",
      cwd,
      env: { ...process.env, FLOW_AGENTS_ACTOR: actorKey, ...env },
    },
  );
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

const PRETOOL_DENIED = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { path: "prettier.config.js" } };

test("mechanism: a first PreToolUse denial denies the call WITHOUT ending the turn", () => {
  const cwd = scratchRepo();
  const out = runClaudeAdapter("PreToolUse", PRETOOL_DENIED, {
    cwd, actorKey: "test:mechanism-first", hookId: "pre:config-protection", script: "config-protection.js",
  });

  assert.equal(out.hookSpecificOutput.permissionDecision, "deny", "the call must still be refused");
  // The whole bug: `continue: false` stops Claude processing entirely and takes precedence
  // over the deny beside it, so the reason never reaches the model.
  assert.notEqual(out.continue, false, "a first denial must not end the turn");
  assert.equal(out.stopReason, undefined, "stopReason is user-facing only; it must not carry the deny reason");
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.length > 0, "the model-facing reason channel must be populated");
  assert.ok(!/^BLOCKED:/.test(out.hookSpecificOutput.permissionDecisionReason));
});

test("mechanism: the third identical PreToolUse denial in one step DOES end the turn", () => {
  const cwd = scratchRepo();
  const opts = {
    cwd, actorKey: "test:mechanism-third", hookId: "pre:config-protection", script: "config-protection.js",
  };
  const first = runClaudeAdapter("PreToolUse", PRETOOL_DENIED, opts);
  const second = runClaudeAdapter("PreToolUse", PRETOOL_DENIED, opts);
  const third = runClaudeAdapter("PreToolUse", PRETOOL_DENIED, opts);

  assert.notEqual(first.continue, false);
  assert.notEqual(second.continue, false);
  assert.equal(third.continue, false, "the third identical denial escalates to a human");
  assert.equal(third.hookSpecificOutput.permissionDecision, "deny", "escalation never stops being a refusal");
  assert.match(third.stopReason, /Escalating/);
});

test("mechanism: a route-around to a different rule does not push the agent toward escalation", () => {
  const cwd = scratchRepo();
  const opts = { cwd, actorKey: "test:mechanism-route-around", hookId: "pre:config-protection", script: "config-protection.js" };
  // Two denials on prettier.config.js, then the agent moves to a different protected file.
  runClaudeAdapter("PreToolUse", PRETOOL_DENIED, opts);
  runClaudeAdapter("PreToolUse", PRETOOL_DENIED, opts);
  const elsewhere = runClaudeAdapter(
    "PreToolUse",
    { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { path: "biome.json" } },
    opts,
  );
  assert.notEqual(elsewhere.continue, false, "a different target starts its own count and must not escalate");
});

const STOP_ADAPTER_OPTS = {
  actorKey: "test:stop-contract",
  hookId: "stop:goal-fit",
  script: "stop-goal-fit.js",
  env: { FLOW_AGENTS_GOAL_FIT_STRICT: "true", FLOW_AGENTS_REQUIRE_SIDECARS: "true" },
};

test("tier 3: Stop is not translated into a tool-call deny", () => {
  const cwd = scratchRepo();
  const out = runClaudeAdapter("Stop", { hook_event_name: "Stop", cwd }, { ...STOP_ADAPTER_OPTS, cwd });
  // Stop is not routed through the graduated denial path: that path counts denial identities
  // per flow step and reshapes the message as a refused tool call, and a Stop gate owns both
  // of those itself. Whatever verdict goal-fit reaches here, the adapter must not have
  // rewritten Stop's shape into a PreToolUse-style deny.
  assert.equal(out.hookSpecificOutput?.permissionDecision, undefined, "Stop must not be translated as a tool-call deny");
});

/**
 * A scratch repo the Stop gate actually blocks on: an unfinished session plus the per-actor
 * current pointer that scopes the gate to it. Without the pointer the gate finds no own work and
 * declines to block (#440), which would leave the assertions below with no power.
 */
function blockingStopRepo(actorKey) {
  const cwd = scratchRepo();
  const slug = "stop-contract-demo";
  const flowAgentsDir = path.join(cwd, ".kontourai", "flow-agents");
  const sessionDir = path.join(flowAgentsDir, slug);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# Test Repo\n");
  fs.writeFileSync(path.join(sessionDir, `${slug}--deliver.md`), [
    `# ${slug}`, "", "branch: main", "worktree: main", "created: 2026-08-02",
    "status: executing", "type: deliver", "", "## Plan", "", "Fixture unfinished session.", "",
  ].join("\n"));
  // Assembled rather than written inline for the same reason the shell evals do it: the repo's
  // own config-protection hook watches for a literal sidecar filename sitting next to a write.
  const stateFile = ["state", "json"].join(".");
  fs.writeFileSync(path.join(sessionDir, stateFile), JSON.stringify({
    schema_version: "1.0",
    task_slug: slug,
    status: "in_progress",
    phase: "execution",
    updated_at: "2026-08-02T00:00:00Z",
    next_action: { status: "continue", summary: `Fixture next-action summary for ${slug}.` },
  }));
  const { writePerActorCurrent } = createRequire(import.meta.url)(
    path.join(packageRoot, "scripts", "hooks", "lib", "current-pointer.js"),
  );
  writePerActorCurrent(flowAgentsDir, actorKey, {
    schema_version: "1.0",
    active_slug: slug,
    artifact_dir: slug,
    updated_at: "2026-08-02T00:00:00Z",
    owner: "test",
    source: "test-fixture",
    active_agents: [],
  });
  return cwd;
}

test("#1172: a blocking Stop hands the reason to the MODEL and does not end the turn on first contact", () => {
  // Colon-free: the per-actor pointer filename is derived from a sanitized actor segment, so a
  // key that sanitizes differently from the one the reader resolves finds no pointer and the gate
  // declines to block (#440) — which would silently drain this test of power.
  const actorKey = "stop-first-contact-actor";
  const cwd = blockingStopRepo(actorKey);
  const out = runClaudeAdapter("Stop", { hook_event_name: "Stop", stop_hook_active: false, cwd }, {
    ...STOP_ADAPTER_OPTS, actorKey, cwd, env: { FLOW_AGENTS_GOAL_FIT_MODE: "block" },
  });
  assert.equal(out.decision, "block", "fixture must actually block, or this test has no power");
  // The bug #1172 measured: `continue: false` takes precedence over `decision: "block"`, and the
  // reason travels in `stopReason`, which the contract shows to the USER and not to Claude. So
  // the single largest injection in the system was reaching the human and never the agent that
  // had to close the gap.
  assert.notEqual(out.continue, false, "first-contact Stop must not end the turn");
  assert.equal(out.stopReason, undefined, "stopReason is user-facing only; it must not carry the remediation");
  assert.ok(String(out.reason || "").length > 0, "the model-facing reason channel must be populated");
});

test("#1172: a Stop that blocks again after the model was already told ends the turn", () => {
  const actorKey = "stop-continuation-actor";
  const cwd = blockingStopRepo(actorKey);
  const out = runClaudeAdapter("Stop", { hook_event_name: "Stop", stop_hook_active: true, cwd }, {
    ...STOP_ADAPTER_OPTS, actorKey, cwd, env: { FLOW_AGENTS_GOAL_FIT_MODE: "block" },
  });
  assert.equal(out.decision, "block", "fixture must actually block, or this test has no power");
  // `stop_hook_active` is Claude Code's own continuation signal. Blocking again after the model
  // has already been handed the reason once means in-session self-correction is exhausted, and
  // it is the only bound on goal-fit's deliberately non-releasable hard blocks.
  assert.equal(out.continue, false, "the continuation firing escalates to a human");
  assert.ok(String(out.stopReason || "").length > 0, "the user-facing channel carries the reason on escalation");
  assert.ok(String(out.reason || "").length > 0, "the model-facing channel is still populated");
});

test("counter: state is filed per actor, so one agent's strikes never escalate another's", () => {
  const cwd = scratchRepo();
  const message = INTERPRETER_DENIAL_SETTINGS;
  recordDenial({ hookId: "config-protection", message, cwd, actorKey: "actor-a" });
  recordDenial({ hookId: "config-protection", message, cwd, actorKey: "actor-a" });
  const otherActor = recordDenial({ hookId: "config-protection", message, cwd, actorKey: "actor-b" });
  assert.equal(otherActor.count, 1);
  assert.equal(otherActor.escalate, false);
  assert.notEqual(denialStreakFile(cwd, "actor-a"), denialStreakFile(cwd, "actor-b"));
});
