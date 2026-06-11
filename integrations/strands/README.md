# flow-agents-strands

**SPIKE — Framework Adapter Proof of Concept**

This package proves the thesis: Flow Agents' process-discipline layer
(telemetry events + workflow steering + policy gates) can compile to a
**framework adapter** hook surface — here, AWS Strands Agents — not just
coding-agent harnesses.

---

## Harness adapters vs. framework adapters

The existing Flow Agents adapters (`claude-code/`, `codex/`, `kiro/`) are
**harness adapters**: they integrate with coding-agent runtimes that each have
their own hook format (JSON on stdin, exit codes, lifecycle events named by
the harness).  Each adapter normalizes its harness's hook payloads into the
canonical Flow Agents telemetry taxonomy and then delegates to the shared
`scripts/telemetry/telemetry.sh` sink.

This package is a **framework adapter**: Strands Agents is not a coding-agent
harness — it is a general-purpose Python agent SDK.  Its hook surface
(`HookProvider` / `HookRegistry`) is class-based and synchronous rather than
process-based.  This means:

- No stdin/stdout protocol.
- No process exit codes as block signals.
- Hook callbacks receive typed Python event objects and can mutate them in
  place (e.g. set `event.cancel_tool` to block a tool call).

Despite these surface differences, the **same canonical event taxonomy** is
used.  The JSONL output from `FlowAgentsHooks` is structurally identical to
the output produced by `claude-telemetry-hook.js` and `codex-telemetry-hook.js`.

---

## Canonical event taxonomy

All telemetry events follow the schema defined in `scripts/telemetry/telemetry.sh`.
The Strands → canonical mapping is exposed as a module-level dict:

```python
from flow_agents_strands import STRANDS_TO_CANONICAL
# {
#   "AgentInitializedEvent":  "agentSpawn",
#   "BeforeInvocationEvent":  "userPromptSubmit",
#   "AfterInvocationEvent":   "stop",
#   "BeforeToolCallEvent":    "preToolUse",
#   "AfterToolCallEvent":     "postToolUse",
#   "AfterModelCallEvent":    "postToolUse",
#   "MessageAddedEvent":      "userPromptSubmit",
# }
```

Canonical names map to schema `event_type` values:

| Canonical name        | Schema event_type          |
|-----------------------|----------------------------|
| `agentSpawn`          | `session.start`            |
| `userPromptSubmit`    | `turn.user`                |
| `preToolUse`          | `tool.invoke`              |
| `permissionRequest`   | `tool.permission_request`  |
| `postToolUse`         | `tool.result`              |
| `stop`                | `session.end`              |

---

## Telemetry sink

Events are written to `.flow-agents/.telemetry/full.jsonl` by default,
matching the local-files sink convention in `scripts/telemetry/lib/config.sh`:

```
TELEMETRY_CHANNEL_FULL_LOG_FILE = <data_dir>/full.jsonl
```

The JSON record shape matches `build_base_event()` in `telemetry.sh`:

```json
{
  "schema_version": "0.3.0",
  "timestamp": "1718000000000",
  "session_id": "<uuid>",
  "event_id": "<uuid>",
  "event_type": "tool.invoke",
  "agent": { "name": "strands-agent", "runtime": "strands", "version": "unknown" },
  "hook": { "event_name": "preToolUse", "source": "strands", ... },
  "tool": { "name": "edit", "normalized_name": "fs_write", "input": {...} }
}
```

---

## Policy gates

The config-protection policy from `scripts/hooks/config-protection.js` is
reimplemented in pure Python (`flow_agents_strands/policy.py`).

**Why pure Python rather than shelling out to the JS script?**

1. Strands is a Python runtime; a mandatory Node.js subprocess would add an
   external dependency with no gain.
2. The `PROTECTED_FILES` list is a closed constant with no runtime config
   reads, so faithfully translating it to Python is safe and auditable.
3. A synchronous Python gate cannot deadlock the agent loop the way a
   subprocess timeout can inside a hook callback.

On `BeforeToolCallEvent`, if the tool name is a write-like tool and the target
file is in `PROTECTED_FILES`, `event.cancel_tool` is set to the block reason.
Strands will cancel the call and surface the message as the tool result.

---

## Workflow steering

The JS `workflow-steering.js` hook injects steering text by appending it to
the prompt payload.  Strands' `BeforeInvocationEvent` does **not** expose a
mutable system prompt at callback time.

**Spike approach:** call `hooks.steering_context()` at Agent construction and
append the result to the system prompt:

```python
hooks = FlowAgentsHooks(workspace=".")
system_prompt = "You are a helpful agent.\n" + hooks.steering_context()
agent = Agent(system_prompt=system_prompt, hooks=[hooks])
```

`steering_context()` also emits a `turn.user` telemetry event so the steering
injection is recorded in the JSONL log.

---

## Quickstart

```python
from strands import Agent
from strands.models import BedrockModel
from flow_agents_strands import FlowAgentsHooks

# Build hooks — no strands import needed for this step
hooks = FlowAgentsHooks(
    workspace=".",           # root of your project (reads .flow-agents/)
    agent_name="my-agent",   # appears in telemetry events
)

# Load steering context BEFORE constructing the agent
system_prompt = (
    "You are a helpful assistant.\n"
    + hooks.steering_context()   # appends workflow state reminders if any
)

# Wire hooks into the Agent
model = BedrockModel(model_id="anthropic.claude-3-5-sonnet-20241022-v2:0")
agent = Agent(model=model, system_prompt=system_prompt, hooks=[hooks])

result = agent("List the files in this directory.")
print(result)
```

Telemetry is written to `.flow-agents/.telemetry/full.jsonl`.

---

## Installation

```bash
# Without strands (for telemetry/policy use only, tests, etc.):
pip install flow-agents-strands

# With strands SDK:
pip install "flow-agents-strands[strands]"
```

---

## Running tests

```bash
cd integrations/strands
python3 -m unittest discover
```

Tests use stdlib `unittest` only — no pytest, no strands-agents required.

---

## Limitations (honest spike notes)

1. **Steering seam**: Strands does not allow mutating the system prompt from
   `BeforeInvocationEvent`.  The workaround (`steering_context()` at Agent
   construction) is a one-shot snapshot; it does not re-evaluate on every turn
   the way the JS hook does at `UserPromptSubmit`.  Productization would
   require either a custom Strands model wrapper that injects context per-turn,
   or upstream SDK support for mutable system-prompt context in the invocation
   event.

2. **session.usage event omitted**: The JS harness emits a `session.usage`
   event on stop with token counts pulled from the transcript.  The Strands
   `AfterInvocationEvent` does not (yet) expose token-usage data in the hook
   payload, so this event is not emitted.  Productization would need to read
   usage from the agent's response object and attach it here.

3. **No analytics channel**: The harness adapters write to two channels
   (full + analytics) with different redaction profiles.  This spike writes
   only to the `full` channel.  Adding analytics is straightforward: a second
   `TelemetrySink` instance pointed at `analytics.jsonl` with the analytics
   redact list applied.

4. **No Console/HTTP sink**: The bash transport supports POSTing events to a
   Console endpoint.  This adapter writes JSONL only.  Adding HTTP transport
   would mean replicating the `console_telemetry_emit()` logic in Python or
   calling `transport.sh` as a subprocess.

5. **Runtime version is "unknown"**: The harness adapters run
   `<runtime> --version` to populate `agent.version`.  Strands does not
   expose its version through the hook event; `importlib.metadata` could
   provide the SDK version as a proxy.

6. **No subagent / delegation event**: The Strands SDK does not have a
   built-in InvokeSubagents tool; the delegation telemetry path is not wired.

7. **Quality-gate policy omitted**: `quality-gate.js` invokes ruff/biome
   after edits.  This is omitted from the spike because it requires executing
   external formatters and has no clear Strands analogue yet.

---

## What productization would require

- Upstream Strands SDK support for mutable per-turn context injection.
- Token-usage exposure in `AfterInvocationEvent` for `session.usage` events.
- Dual-channel JSONL + optional HTTP transport mirroring the bash transport.
- Packaging as a proper release with semantic versioning once the Strands hook
  API stabilizes.
- Integration tests against a live Strands agent (currently blocked by missing
  AWS credentials in CI).
