// #1098: environment defaults must not require a shell in the hook path.
//
// The bundle emitters used to ship the goal-fit block default as a shell prefix
// (`FLOW_AGENTS_GOAL_FIT_MODE="${FLOW_AGENTS_GOAL_FIT_MODE:-block}" node …`),
// which is exactly the dependency that made every hook exit 127 on stock
// Windows (bash resolves to the WSL2 shim). The default now travels as an
// `--env-default=KEY=VALUE` adapter argument. These tests pin the two
// semantics that make that substitution faithful to the shell form:
//   1. `${VAR:-block}` semantics — the default applies when the variable is
//      unset OR empty, and an operator's explicit value always wins;
//   2. the flag is stripped from argv so the adapters' positional contract
//      (event/hookId/script/profiles) is unchanged wherever the flag appears.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const require_ = createRequire(import.meta.url);
const { extractEnvDefaults, applyEnvDefaults } = require_(
  path.join(packageRoot, "scripts", "hooks", "lib", "env-defaults.js"),
);

test("extractEnvDefaults strips the flag and preserves positional order", () => {
  const { argv, defaults } = extractEnvDefaults([
    "node",
    "adapter.js",
    "Stop",
    "stop-goal-fit",
    "stop-goal-fit.js",
    "default",
    "--env-default=FLOW_AGENTS_GOAL_FIT_MODE=block",
  ]);
  assert.deepEqual(argv, ["node", "adapter.js", "Stop", "stop-goal-fit", "stop-goal-fit.js", "default"]);
  assert.deepEqual(defaults, { FLOW_AGENTS_GOAL_FIT_MODE: "block" });
});

test("extractEnvDefaults handles the flag in any position and values containing =", () => {
  const { argv, defaults } = extractEnvDefaults(["node", "--env-default=A=x=y", "adapter.js", "--env-default=B=2", "evt"]);
  assert.deepEqual(argv, ["node", "adapter.js", "evt"]);
  assert.deepEqual(defaults, { A: "x=y", B: "2" });
});

test("extractEnvDefaults drops malformed flags instead of throwing (hooks never fail closed on plumbing)", () => {
  const { argv, defaults } = extractEnvDefaults(["node", "adapter.js", "--env-default=", "--env-default=NOVALUE", "--env-default==broken"]);
  assert.deepEqual(argv, ["node", "adapter.js"]);
  assert.deepEqual(defaults, {});
});

test("applyEnvDefaults applies when unset or empty; explicit operator value always wins (${VAR:-} semantics)", () => {
  const defaults = { FLOW_AGENTS_GOAL_FIT_MODE: "block" };
  assert.equal(applyEnvDefaults({}, defaults).FLOW_AGENTS_GOAL_FIT_MODE, "block");
  assert.equal(applyEnvDefaults({ FLOW_AGENTS_GOAL_FIT_MODE: "" }, defaults).FLOW_AGENTS_GOAL_FIT_MODE, "block");
  assert.equal(applyEnvDefaults({ FLOW_AGENTS_GOAL_FIT_MODE: "warn" }, defaults).FLOW_AGENTS_GOAL_FIT_MODE, "warn");
  assert.equal(applyEnvDefaults({ FLOW_AGENTS_GOAL_FIT_MODE: "off" }, defaults).FLOW_AGENTS_GOAL_FIT_MODE, "off");
});

test("applyEnvDefaults does not mutate the input env", () => {
  const env = { KEEP: "1" };
  const out = applyEnvDefaults(env, { NEW: "v" });
  assert.equal(out.NEW, "v");
  assert.equal(out.KEEP, "1");
  assert.equal("NEW" in env, false);
});
