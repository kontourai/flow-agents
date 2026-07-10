import assert from "node:assert/strict";
import test from "node:test";
import { codexAgentRoutingErrors } from "../../build/src/tools/codex-agent-routing.js";

const agents = ["tool-planner", "tool-worker"];
const valid = {
  codex: { allowed_agent_models: ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra"] },
  codex_model_map: { default: "gpt-5.5" },
  codex_reasoning_map: { default: "medium" },
  codex_agent_map: {
    "tool-planner": { model: "gpt-5.6-sol", reasoning_effort: "high" },
    "tool-worker": { model: "gpt-5.6-terra", reasoning_effort: "high" },
  },
};

test("accepts complete role-specific Codex routing", () => {
  assert.deepEqual(codexAgentRoutingErrors(valid, agents), []);
});

test("rejects unknown agents, unsupported fields, models, and reasoning efforts", () => {
  const malformed = structuredClone(valid);
  malformed.codex_agent_map["tool-missing"] = {
    model: "gpt-unknown",
    reasoning_effort: "extreme",
    extra: true,
  };
  const errors = codexAgentRoutingErrors(malformed, agents).join("\n");
  assert.match(errors, /agent 'tool-missing' does not exist/);
  assert.match(errors, /must contain exactly model and reasoning_effort/);
  assert.match(errors, /uses unsupported model 'gpt-unknown'/);
  assert.match(errors, /reasoning_effort is invalid: 'extreme'/);
});

test("rejects partial overrides and invalid family fallbacks", () => {
  const malformed = structuredClone(valid);
  malformed.codex_agent_map["tool-planner"] = { model: "gpt-5.6-sol" };
  malformed.codex_model_map.default = "gpt-unknown";
  malformed.codex_reasoning_map.default = "extreme";
  const errors = codexAgentRoutingErrors(malformed, agents).join("\n");
  assert.match(errors, /tool-planner must contain exactly model and reasoning_effort/);
  assert.match(errors, /tool-planner.reasoning_effort is invalid: 'undefined'/);
  assert.match(errors, /codex_model_map.default uses unsupported model 'gpt-unknown'/);
  assert.match(errors, /codex_reasoning_map.default uses invalid reasoning effort 'extreme'/);
});
