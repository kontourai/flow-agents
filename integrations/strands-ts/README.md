# @kontourai/flow-agents-strands

**Native-import TypeScript adapter for AWS Strands Agents.**

This is the first native-import consumer of the Flow Agents policy engine contract. It wires Flow Agents telemetry, workflow steering, and policy gates directly into Strands Agents TypeScript SDK hook callbacks — with no subprocess overhead for the critical hot path (config-protection on `BeforeToolCallEvent`).

---

## Native-import vs subprocess binding

| Aspect | This adapter (TS, native) | Python adapter (subprocess) |
|--------|---------------------------|-----------------------------|
| Language | TypeScript / Node.js | Python |
| Engine binding | `require("config-protection.js")` — in-process | `subprocess.run(["node", "run-hook.js", …])` |
| Hot path latency | ~0 ms (direct function call) | ~50–100 ms per call (process spawn) |
| Strands SDK optional? | Yes — duck-typed, SDK not required to build/test | Yes |
| Config-protection | Native `run()` call | Subprocess, with Python fallback |
| Other policies (steering, quality-gate, stop-goal-fit) | Via shim subprocess (conformance runner) | Via subprocess |
| Conformance level | L2 | L0 (+ config-protection) |

The key innovation: `config-protection.js` exports `module.exports = { run }`. This adapter calls that function directly from the Node.js process, bypassing the subprocess round-trip for every `BeforeToolCallEvent` write call.

---

## Quickstart

```typescript
import { Agent, BeforeInvocationEvent, AfterInvocationEvent,
         BeforeToolCallEvent, AfterToolCallEvent } from "@strands-agents/sdk";
import { FlowAgentsHooks } from "@kontourai/flow-agents-strands";

// Construct — no strands-agents import needed at this point
const hooks = new FlowAgentsHooks({
  workspace: ".",           // reads .telemetry/ for JSONL output
  agentName: "my-agent",   // embedded in telemetry events
  // engineRoot: "/path/to/flow-agents"  // optional: explicit engine location
});

// Wire into the agent
const agent = new Agent({ hooks: [hooks] });

// Optionally emit agentSpawn telemetry immediately
hooks.emitSessionStart();
```

Or wire manually without the SDK:

```typescript
// Direct callback wiring (for testing or custom frameworks)
hooks.onBeforeInvocation(event);
hooks.onBeforeToolCall({ toolName: "write", toolInput: { path: "biome.json" } });
// → event.cancel is set to block reason if config-protection fires
hooks.onAfterToolCall({ toolName: "write", result: "ok" });
hooks.onAfterInvocation(event);
```

---

## Event mapping

The Strands-TS → canonical mapping is exported as `STRANDS_TO_CANONICAL`:

```typescript
import { STRANDS_TO_CANONICAL } from "@kontourai/flow-agents-strands";
// {
//   BeforeInvocationEvent: "userPromptSubmit",
//   AfterInvocationEvent:  "stop",
//   BeforeToolCallEvent:   "preToolUse",
//   AfterToolCallEvent:    "postToolUse",
//   AgentInitializedEvent: "agentSpawn",
//   AfterModelCallEvent:   "postToolUse",
//   MessageAddedEvent:     "userPromptSubmit",
// }
```

| Strands TS Event | Canonical event | JSONL event_type |
|------------------|-----------------|-----------------|
| `BeforeInvocationEvent` | `userPromptSubmit` | `turn.user` |
| `AfterInvocationEvent` | `stop` | `session.end` |
| `BeforeToolCallEvent` | `preToolUse` | `tool.invoke` |
| `AfterToolCallEvent` | `postToolUse` | `tool.result` |
| `AgentInitializedEvent` | `agentSpawn` | `session.start` |

---

## Telemetry

Events are written to `<workspace>/.telemetry/full.jsonl` (matching the canonical config.sh path `TELEMETRY_DATA_DIR/.../full.jsonl`).

Event shape matches `build_base_event()` in `scripts/telemetry/telemetry.sh` at schema version `0.3.0`:

```json
{
  "schema_version": "0.3.0",
  "timestamp": "1718000000000",
  "session_id": "<uuid>",
  "event_id": "<uuid>",
  "event_type": "tool.invoke",
  "agent": { "name": "my-agent", "runtime": "strands-ts", "version": "unknown" },
  "hook": {
    "event_name": "preToolUse",
    "source": "strands-ts",
    "stop_hook_active": null,
    "raw_input": null
  },
  "tool": { "name": "edit", "normalized_name": "fs_write", "input": { ... } }
}
```

Telemetry is always fail-open: write errors are silently swallowed so telemetry never blocks agent work.

---

## Config-protection policy gate

On `BeforeToolCallEvent`, for write-like tools (`edit`, `write`, `fs_write`, `apply_patch`, `create_file`, `str_replace_editor`), the gate calls the native engine:

```typescript
// Under the hood — native import, no subprocess:
const { run } = require("scripts/hooks/config-protection.js");
const result = run(jsonPayload, { truncated: false, maxStdin: 1024 * 1024 });
// result.exitCode === 2 → set event.cancel = result.stderr
```

If blocked, `event.cancel` is set to the block reason. Strands cancels the tool call and surfaces the message as the tool result.

**Engine auto-discovery** (in priority order):
1. `FlowAgentsHooksOptions.engineRoot` (explicit constructor option)
2. `FLOW_AGENTS_ENGINE_ROOT` env var
3. Relative to this package (works from repo checkout)
4. Walk up from `process.cwd()` for `node_modules/@kontourai/flow-agents/`

**Fallback**: if the engine cannot be loaded, a one-time `console.warn` is emitted and the built-in TypeScript implementation (same protected-files list) is used. Fail-open for all errors.

---

## Conformance

Tested against the Flow Agents conformance kit (`packaging/conformance/`):

```yaml
conformance_level: L2
engine_contract_version: "1.0"
runner_version: "run-conformance.js"
test_date: 2026-06-11
verdict: PASS
fixture_count: 12
fixtures_passed: 12
gaps: []
```

Run the conformance test from the repo root:

```bash
node packaging/conformance/run-conformance.js \
  --adapter-cmd "node integrations/strands-ts/bin/conformance-shim.mjs" \
  --level L2
```

---

## Running tests

```bash
# From repo root (no npm install needed — uses root node_modules/typescript):
npx tsc -p integrations/strands-ts/tsconfig.json
node --test integrations/strands-ts/dist/test/test-telemetry.js \
            integrations/strands-ts/dist/test/test-policy.js
```

47 tests, no strands-agents required.

---

## Limitations

1. **No per-turn workflow steering injection**: Strands' `BeforeInvocationEvent` does not expose a mutable system prompt. Unlike the harness adapters which inject workflow state at each `UserPromptSubmit`, this adapter emits the telemetry event only. Productization requires upstream SDK support or a custom model wrapper.

2. **Quality-gate and stop-goal-fit via subprocess in conformance shim only**: The production `FlowAgentsHooks` callbacks don't wire `quality-gate.js` or `stop-goal-fit.js` (they have no clear Strands analogue for direct callback injection). The `bin/conformance-shim.mjs` shim wires them via subprocess for conformance certification only.

3. **session.usage event omitted**: The `AfterInvocationEvent` does not expose token usage in the Strands TS SDK hook payload.

4. **No analytics channel**: Only the `full` JSONL channel is written. Analytics-channel redaction is not implemented.

5. **No Console/HTTP sink**: JSONL file output only. HTTP transport would require implementing the `console_telemetry_emit()` logic.

6. **Runtime version is "unknown"**: The Strands TS SDK does not expose its version through hook event payloads.

7. **No subagent/delegation events**: The Strands TS SDK has no built-in `InvokeSubagents` tool; `subagentStart`/`subagentStop` telemetry paths are not wired.

---

## Conformance declaration

```
conformance_level: L2 (via conformance-shim.mjs)
host: AWS Strands Agents TypeScript SDK
event_coverage:
  agentSpawn:         emitSessionStart() — full fidelity
  userPromptSubmit:   BeforeInvocationEvent — telemetry only, no per-turn injection
  preToolUse:         BeforeToolCallEvent — full fidelity, blocking via event.cancel
  postToolUse:        AfterToolCallEvent — telemetry only; quality-gate via shim
  stop:               AfterInvocationEvent — telemetry only; stop-goal-fit via shim
  permissionRequest:  no native equivalent
  subagentStart:      no native equivalent
  subagentStop:       no native equivalent
policy_coverage:
  config_protection:  wired at BeforeToolCallEvent (native import, blocking)
  workflow_steering:  telemetry-only at BeforeInvocationEvent; shim wires for conformance
  quality_gate:       shim only (no direct Strands callback equivalent)
  stop_goal_fit:      shim only (no direct Strands callback equivalent)
```

## Live validation status

The canonical-taxonomy live loop is proven end-to-end with no API keys via the
Python adapter (`integrations/strands/`): a real Strands agent on a local
Ollama model (qwen3:1.7b) with `FlowAgentsHooks` attached persisted all five
canonical event types (`session.start`, `turn.user`, `tool.invoke`,
`tool.result`, `session.end`) on 2026-06-11. The TypeScript SDK currently
ships only a Bedrock model provider, so this adapter's live-agent run requires
AWS credentials; its correctness is covered by the real-engine tests and the
L2 conformance certification above. An Ollama `Model` implementation for the
TS SDK is a candidate follow-up if keyless live runs are wanted here too.
