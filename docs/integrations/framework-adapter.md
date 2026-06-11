---
title: Framework Adapter
---

# Framework Adapter

This page walks through the `integrations/strands/` reference implementation: a Python `HookProvider` for AWS Strands Agents. It covers how to construct `FlowAgentsHooks`, what telemetry it emits, how the policy gate binds to the canonical engine contract, and the documented limitations of this spike.

Everything in this page is grounded in the files under `integrations/strands/`. No behavior is inferred or aspirational unless explicitly labeled as direction.

## Harness adapters vs. framework adapters

Harness adapters (Claude Code, Codex, Kiro, opencode, pi) integrate with coding-agent runtimes that have their own hook format: JSON on stdin, exit codes, and lifecycle events named by the harness. Each harness adapter normalizes its runtime's hook payloads into the canonical Flow Agents telemetry taxonomy and delegates to `scripts/telemetry/telemetry.sh`.

Framework adapters are in-process packages. Strands Agents is not a coding-agent harness — it is a general-purpose Python agent SDK. Its hook surface (`HookProvider` / `HookRegistry`) is class-based and synchronous. There is no stdin/stdout protocol and no process exit codes as block signals. Hook callbacks receive typed Python event objects and can mutate them in place.

Despite the surface differences, the same canonical event taxonomy is used. The JSONL output from `FlowAgentsHooks` is structurally identical to the output produced by `claude-telemetry-hook.js` and `codex-telemetry-hook.js`.

## Constructing FlowAgentsHooks

`FlowAgentsHooks` is the main entry point. It implements the Strands `HookProvider` protocol via duck typing, so `strands-agents` is not required at import time.

```python
from flow_agents_strands import FlowAgentsHooks

hooks = FlowAgentsHooks(
    workspace=".",           # root of your project (reads .flow-agents/)
    agent_name="my-agent",   # appears in telemetry events
)
```

Constructor parameters (all optional):

| Parameter | Default | Purpose |
| --- | --- | --- |
| `sink_path` | `<workspace>/.flow-agents/.telemetry/full.jsonl` | JSONL telemetry output path or directory |
| `workspace` | `os.getcwd()` | Root of the workspace; used to discover `.flow-agents/` |
| `agent_name` | `"strands-agent"` | Agent identifier embedded in telemetry events |
| `runtime` | `"strands"` | Runtime label embedded in telemetry events |
| `policy_gate` | `PolicyGate()` | Optional custom `PolicyGate` instance (for testing) |

`FlowAgentsHooks` is usable without `strands-agents` installed. Telemetry emission and `steering_context()` work in any Python environment. The `register_hooks` method (which wires callbacks into a `HookRegistry`) requires `strands-agents` and raises `ImportError` if the SDK is absent.

## Wiring into an Agent

```python
from strands import Agent
from strands.models import BedrockModel
from flow_agents_strands import FlowAgentsHooks

hooks = FlowAgentsHooks(workspace=".")

# Load steering context BEFORE constructing the agent.
# Strands' BeforeInvocationEvent does not expose a mutable system prompt,
# so steering must be injected at construction time.
system_prompt = (
    "You are a helpful assistant.\n"
    + hooks.steering_context()
)

model = BedrockModel(model_id="anthropic.claude-3-5-sonnet-20241022-v2:0")
agent = Agent(model=model, system_prompt=system_prompt, hooks=[hooks])

result = agent("List the files in this directory.")
```

`register_hooks` is called by the Strands runtime when `hooks=[hooks]` is passed to `Agent`. It registers five callbacks:

| Strands event | Canonical event | What fires |
| --- | --- | --- |
| `AgentInitializedEvent` | `agentSpawn` | `emit_session_start()` — records `session.start` |
| `BeforeInvocationEvent` | `userPromptSubmit` | `emit("userPromptSubmit")` — records `turn.user` |
| `AfterInvocationEvent` | `stop` | `emit_session_end(duration_s=…)` — records `session.end` |
| `BeforeToolCallEvent` | `preToolUse` | Telemetry + policy gate (config-protection) |
| `AfterToolCallEvent` | `postToolUse` | `emit_tool_result(…)` — records `tool.result` |

This mapping is the `STRANDS_TO_CANONICAL` dict exposed at module level by `integrations/strands/flow_agents_strands/telemetry.py`:

```python
STRANDS_TO_CANONICAL = {
    "AgentInitializedEvent":  "agentSpawn",
    "BeforeInvocationEvent":  "userPromptSubmit",
    "AfterInvocationEvent":   "stop",
    "BeforeToolCallEvent":    "preToolUse",
    "AfterToolCallEvent":     "postToolUse",
    "AfterModelCallEvent":    "postToolUse",   # closest analogue; no tool name
    "MessageAddedEvent":      "userPromptSubmit",
}
```

## Telemetry emitted

Events are written to `.flow-agents/.telemetry/full.jsonl` by default. The record shape matches `build_base_event()` in `scripts/telemetry/telemetry.sh`:

```json
{
  "schema_version": "0.3.0",
  "timestamp": "1718000000000",
  "session_id": "<uuid>",
  "event_id": "<uuid>",
  "event_type": "tool.invoke",
  "agent": { "name": "my-agent", "runtime": "strands", "version": "unknown" },
  "hook": {
    "event_name": "preToolUse",
    "source": "strands",
    "stop_hook_active": null,
    "raw_input": null
  },
  "tool": { "name": "edit", "normalized_name": "fs_write", "input": { ... } }
}
```

Canonical names map to schema `event_type` values via `_CANONICAL_TO_SCHEMA` in `telemetry.py`:

| Canonical name | Schema event_type |
| --- | --- |
| `agentSpawn` | `session.start` |
| `userPromptSubmit` | `turn.user` |
| `preToolUse` | `tool.invoke` |
| `permissionRequest` | `tool.permission_request` |
| `postToolUse` | `tool.result` |
| `stop` | `session.end` |

Telemetry is always fail-open: if the JSONL file cannot be written (`OSError`), the exception is swallowed silently. Telemetry must never block agent work.

## Policy gate: config-protection

The config-protection policy binds to the canonical Node.js engine via subprocess. The binding is in `integrations/strands/flow_agents_strands/policy.py` in the `PolicyGate` class.

**Primary mode — engine subprocess:**

On `BeforeToolCallEvent`, if the tool name is a write-like tool (one of `edit`, `write`, `fs_write`, `apply_patch`, `create_file`, `str_replace_editor`), the gate serializes the event to a canonical JSON payload and spawns:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"edit","tool_input":{"path":"biome.json"}}' \
  | node scripts/hooks/run-hook.js config-protection config-protection.js
```

The engine exits 2 (block) or 0 (allow). Exit code 2 causes `event.cancel_tool` to be set to the block reason from stderr. Strands cancels the call and surfaces the message as the tool result. All other exit codes fail open.

The engine is located by `_find_engine_paths()` in this priority order:

1. `FLOW_AGENTS_ENGINE_PATH` environment variable (explicit override).
2. Relative to the package source file: `../../../../scripts/hooks/run-hook.js` (works from a repo checkout).
3. Walked up from `os.getcwd()` looking for `node_modules/@kontourai/flow-agents/scripts/hooks/run-hook.js` (npm-installed package).

**Fallback mode — Python evaluation:**

If `node` is not on PATH or `run-hook.js` cannot be located, the gate degrades to a built-in Python implementation of the same logic and emits a one-time `RuntimeWarning`. The Python fallback uses the same `PROTECTED_FILES` frozenset as `config-protection.js` and is auditable. This is not silent: the warning is printed once to stderr.

**Custom protected set:**

If a `PolicyGate` is constructed with a custom `protected_files` frozenset, Python evaluation is used directly (the engine subprocess cannot receive a runtime-custom set). This path is intended for tests and local override only.

## Workflow steering

Strands' `BeforeInvocationEvent` does not expose a mutable system prompt at callback time.

The spike approach: call `hooks.steering_context()` at `Agent` construction time and append the result to the system prompt. `steering_context()` reads the current workflow state from `.flow-agents/` and returns a text block. It also emits a `turn.user` telemetry event so the injection is recorded in the JSONL log.

This is a one-shot snapshot. It does not re-evaluate on every turn the way `workflow-steering.js` does at `UserPromptSubmit`. See the Limitations section for the productization path.

## Documented limitations

The following limitations are from `integrations/strands/README.md` and reflect the current spike state. They are not defects to be worked around silently — they are honest gaps.

1. **Node.js subprocess dependency**: The primary policy binding spawns a Node.js subprocess for each `BeforeToolCallEvent` involving a write-like tool. If `node` is not on PATH or the package is not installed, the gate degrades to the Python fallback with a one-time `RuntimeWarning`. To force the subprocess path, set `FLOW_AGENTS_ENGINE_PATH` to the absolute path of `run-hook.js`.

2. **Steering seam**: Strands does not allow mutating the system prompt from `BeforeInvocationEvent`. The workaround (`steering_context()` at Agent construction) is a one-shot snapshot; it does not re-evaluate on every turn. Productization would require either a custom Strands model wrapper that injects context per-turn, or upstream SDK support for mutable system-prompt context in the invocation event.

3. **session.usage event omitted**: The JS harness emits a `session.usage` event on stop with token counts. The Strands `AfterInvocationEvent` does not expose token-usage data in the hook payload, so this event is not emitted.

4. **No analytics channel**: The harness adapters write to two channels (full + analytics) with different redaction profiles. This spike writes only to the `full` channel.

5. **No Console/HTTP sink**: The bash transport supports POSTing events to a Console endpoint. This adapter writes JSONL only.

6. **Runtime version is "unknown"**: Strands does not expose its version through the hook event; `agent.version` is hardcoded to `"unknown"`.

7. **No subagent/delegation event**: The Strands SDK does not have a built-in delegation tool; the `subagentStart`/`subagentStop` telemetry path is not wired.

8. **Quality-gate policy omitted**: `quality-gate.js` invokes ruff/biome after edits. There is no clear Strands analogue yet.

## Conformance declaration

The Strands adapter is L0 plus config protection via `BeforeToolCallEvent` cancellation. A full conformance declaration would read:

```
conformance_level: L0  (+ config-protection via BeforeToolCallEvent)
host: AWS Strands Agents
event_coverage:
  agentSpawn: AgentInitializedEvent (full fidelity)
  userPromptSubmit: BeforeInvocationEvent (no per-turn injection — spike limitation)
  preToolUse: BeforeToolCallEvent (full fidelity, cancellable)
  postToolUse: AfterToolCallEvent (full fidelity)
  stop: AfterInvocationEvent (full fidelity)
  permissionRequest: no native equivalent
  subagentStart: no native equivalent
  subagentStop: no native equivalent
policy_coverage:
  workflow_steering: partial — injected once at Agent construction, not per-turn
  quality_gate: omitted — no current Strands analogue
  stop_goal_fit: omitted — AfterInvocationEvent used for telemetry only
  config_protection: wired at BeforeToolCallEvent (blocking via event.cancel_tool)
```

## Running tests

The spike ships 50 unit tests that require no Strands SDK:

```bash
cd integrations/strands
python3 -m unittest discover
```

## Related references

- `integrations/strands/flow_agents_strands/hooks.py` — `FlowAgentsHooks` and `register_hooks`
- `integrations/strands/flow_agents_strands/telemetry.py` — `TelemetrySink`, `STRANDS_TO_CANONICAL`
- `integrations/strands/flow_agents_strands/policy.py` — `PolicyGate`, engine subprocess binding
- `integrations/strands/flow_agents_strands/steering.py` — `SteeringContext`
- `integrations/strands/README.md` — spike README with quickstart and full limitations list
- <a href="../spec/runtime-hook-surface.html">Runtime Hook Surface spec §6.2</a> — framework adapter contract and minimum viable adapter pseudocode
- <a href="conformance.html">Conformance</a> — how to self-certify using the conformance kit

---

## TypeScript native-import adapter (`integrations/strands-ts/`)

`@kontourai/flow-agents-strands` is the first **native-import** consumer of the policy engine contract. Where the Python adapter spawns a subprocess for each `BeforeToolCallEvent` policy check, the TS adapter calls `config-protection.js`'s exported `run()` function directly — zero subprocess overhead on the hot path.

### Key differences from the Python adapter

| | Python adapter | TypeScript adapter |
|--|----------------|-------------------|
| Engine binding | subprocess (`node run-hook.js …`) | `require("config-protection.js").run()` — in-process |
| Strands SDK | `register_hooks(registry)` → `registry.add_callback` | `registerHooks(registry)` → `registry.addCallback` |
| Cancel signal | `event.cancel_tool = reason` | `event.cancel = reason` (TS variant) |
| Conformance | L0 + config-protection | L2 (all four policy classes via shim) |
| Test framework | stdlib unittest (Python) | node:test (no extra deps) |

### Constructing FlowAgentsHooks (TypeScript)

```typescript
import { FlowAgentsHooks } from "@kontourai/flow-agents-strands";

const hooks = new FlowAgentsHooks({
  workspace: ".",        // root of your project
  agentName: "my-agent",
  // engineRoot: "/path/to/flow-agents"  // optional: explicit engine path
});
```

### Event mapping

The TS adapter exports `STRANDS_TO_CANONICAL` matching the Python adapter's dict:

| Strands TS Event | Canonical event |
|------------------|-----------------|
| `BeforeInvocationEvent` | `userPromptSubmit` |
| `AfterInvocationEvent` | `stop` |
| `BeforeToolCallEvent` | `preToolUse` |
| `AfterToolCallEvent` | `postToolUse` |
| `AgentInitializedEvent` | `agentSpawn` |

### Conformance

The TS adapter achieves **L2** via `bin/conformance-shim.mjs`:

```bash
node packaging/conformance/run-conformance.js \
  --adapter-cmd "node integrations/strands-ts/bin/conformance-shim.mjs" \
  --level L2
```

12/12 fixtures pass. See `integrations/strands-ts/README.md` for the full conformance declaration and limitations.
