---
title: Knowledge Kit Live Example
---

# Knowledge Kit Live Example

This page documents `integrations/strands/examples/knowledge_kit_live.py`: a keyless, ollama-backed end-to-end proof of the Knowledge Kit's ingest and compile flows running against a real Strands agent.

Everything on this page is grounded in the source files and in the acceptance test that was run to validate the commands. Limitations are documented honestly.

## What it proves

The example exercises the full `knowledge.ingest` → `knowledge.compile` pipeline in a temporary workspace:

- Two raw records are created programmatically via direct Node.js subprocess calls to the kit's flow-runner (`kits/knowledge/adapters/flow-runner/index.js`).
- One raw record is created by the Strands agent calling the `capture_knowledge` tool.
- The Strands agent calls `compile_knowledge` with all three raw record IDs, producing a compiled record with verified provenance links.

Two telemetry streams are asserted:

| Stream | Path | Contents |
| --- | --- | --- |
| Kit gate telemetry | `<workspace>/.telemetry/full.jsonl` | `tool.invoke` + `tool.result` per ingest/compile gate point |
| Session telemetry | `<workspace>/.flow-agents/.telemetry/full.jsonl` | `session.start`, `turn.user`, `tool.invoke`, `tool.result`, `session.end` from FlowAgentsHooks |

## Prerequisites

- ollama installed and `qwen3:1.7b` pulled:

  ```bash
  ollama pull qwen3:1.7b
  ```

- Python venv with `strands-agents[ollama]` at `/tmp/strands-py-live/venv`:

  ```bash
  python3 -m venv /tmp/strands-py-live/venv
  /tmp/strands-py-live/venv/bin/pip install 'strands-agents[ollama]'
  ```

- Node.js on PATH (for the kit's ESM flow-runner and bridge script).

## Running the example

```bash
# From the repo root:
ollama serve &
FLOW_AGENTS_ROOT=$(pwd) \
  /tmp/strands-py-live/venv/bin/python3 \
  integrations/strands/examples/knowledge_kit_live.py
```

Expected output (session IDs and UUIDs vary):

```
=== Knowledge Kit S5: Keyless Live Example ===
Repo root: /path/to/flow-agents

Node.js: v24.16.0
Workspace: /tmp/knowledge-kit-live-xxxxxxxx
Corpus: 3 doc snippets
  docs/integrations/framework-adapter.md (engineering.docs)
  docs/integrations/index.md (engineering.docs)
  kits/knowledge/docs/README.md (research.notes)

--- Step 1: Programmatic captures (2 records) ---
  docs/integrations/framework-adapter.md → <raw-id-1>
  docs/integrations/index.md → <raw-id-2>

--- Step 2: Agent-driven capture ---
  Agent turn: 2.9s
  Reply snippet: 'The captured knowledge record has been successfully stored with ID: ...'
  Raw records in store: 3

--- Step 3: Agent-driven compile ---
  Agent turn: 4.3s
  Reply snippet: 'The compiled knowledge record has been successfully created with ID: ...'
  Compiled records in store: 1

--- Provenance verification ---
  Compiled record: <compiled-id>
  Source IDs present in provenance: True
  Source links in graph index: 3

Kit gate telemetry (.telemetry/full.jsonl): 18 events
  [tool.invoke] knowledge.ingest.classify-gate
  [tool.result] knowledge.ingest.classify-gate
  ...
  [tool.invoke] knowledge.compile.link-gate
  [tool.result] knowledge.compile.link-gate

Session telemetry (.flow-agents/.telemetry/full.jsonl): 9 events
  [session.start]
  [turn.user]
  [tool.invoke] (capture_knowledge)
  [tool.result] (capture_knowledge)
  [session.end]
  [turn.user]
  [tool.invoke] (compile_knowledge)
  [tool.result] (compile_knowledge)
  [session.end]

--- Summary ---
Kit event types:     ['tool.invoke', 'tool.result']
Session event types: ['session.end', 'session.start', 'tool.invoke', 'tool.result', 'turn.user']
Raw records:         3
Compiled records:    1
Provenance ok:       True

Overall: PASS
```

## Running the acceptance test

The acceptance harness gates on ollama binary, model presence, and venv presence. If any gate is absent it skips cleanly.

```bash
# Run the knowledge-kit-live acceptance test directly:
bash evals/acceptance/test_knowledge_kit_live.sh

# Or through the acceptance runner:
bash evals/acceptance/run.sh knowledge-kit-live
```

The harness asserts:

| Assertion | What is checked |
| --- | --- |
| A1 | Example script exits 0 |
| A2 | `<workspace>/.telemetry/full.jsonl` contains `tool.invoke` + `tool.result` |
| A3 | `<workspace>/.flow-agents/.telemetry/full.jsonl` contains `session.start`, `tool.invoke`, `tool.result` |
| A4 | No `.telemetry` directory leaked to the workspace parent |
| A5 | At least 1 compiled record in the knowledge store |
| A6 | Compiled record has `source_ids` provenance referencing raw records |

## How the kit tools work

The example defines two Strands `@tool` functions that call the kit's flow-runner via Node.js subprocess:

```python
@tool
def capture_knowledge(text: str, category: str) -> str:
    """Capture raw knowledge text. Returns JSON: {"id": "<uuid>"}."""
    meta_json = json.dumps({"category": category})
    data = _call_node_bridge(bridge, "capture", text, meta_json, workspace=workspace)
    return json.dumps(data)

@tool
def compile_knowledge(id1: str, id2: str, id3: str) -> str:
    """Compile three raw records into a compiled record. Returns JSON: {"id": ...}."""
    raw_ids = [i for i in [id1, id2, id3] if i and i.strip()]
    data = _call_node_bridge(bridge, "compile", json.dumps(raw_ids), workspace=workspace)
    return json.dumps(data)
```

The bridge script (`_kit_bridge.mjs`) is written into the workspace at runtime. It imports the kit's ESM modules using absolute paths resolved from `FLOW_AGENTS_ROOT`:

```javascript
import { DefaultKnowledgeStore } from "<FLOW_AGENTS_ROOT>/kits/knowledge/adapters/default-store/index.js";
import { capture, compile } from "<FLOW_AGENTS_ROOT>/kits/knowledge/adapters/flow-runner/index.js";
```

Kit gate telemetry is written by the Node flow-runner to `<workspace>/.telemetry/full.jsonl` (via the `FLOW_AGENTS_WORKSPACE` env var). This path is separate from the FlowAgentsHooks telemetry path (`<workspace>/.flow-agents/.telemetry/full.jsonl`) — both files are asserted in the acceptance test.

## Why two programmatic + one agent-driven capture

`qwen3:1.7b` (1.7B parameters) reliably calls single-tool prompts, but complex multi-capture prompts cause it to loop or produce unexpected output. The example uses programmatic captures for the first two records to keep runtime bounded (~30 seconds total), and agent-driven calls for the third capture and the compile step. This gives evidence that:

- The `capture_knowledge` and `compile_knowledge` tools are callable from a real Strands agent.
- FlowAgentsHooks records session events for those calls.
- The kit's gate telemetry is written correctly for all operations regardless of call path.

The acceptance harness asserts on filesystem evidence, not on model output quality.

## console.telemetry.json mapping

A `knowledge` flow entry is registered in `console.telemetry.json` to make knowledge flow events visible in the Flow Agents Console:

```json
{
  "id": "knowledge",
  "label": "Knowledge flows",
  "match": { "attribute": "flow", "includes": "knowledge." },
  "titleAttribute": "title",
  "detailAttributes": { ... }
}
```

This matches telemetry events where the `flow` attribute includes `"knowledge."` — for example, the kit gate events emitted by the flow-runner use `knowledge.ingest` and `knowledge.compile` as the flow identifiers.

## Documented limitations

1. **Model quality**: `qwen3:1.7b` is a 1.7B parameter model. It works for single-tool prompts but has limited reliability for complex multi-step instructions. Larger models will work more reliably but require API keys or more memory.

2. **Single-turn scope**: Each agent invocation covers one operation. Multi-turn chaining with full context tracking across many captures is out of scope for this sprint.

3. **Steering seam**: The `FlowAgentsHooks` spike injects workflow steering context once at `Agent` construction time. Per-turn steering re-evaluation is not implemented. See `docs/integrations/framework-adapter.md` § Limitations for details.

4. **Kit telemetry path**: The kit's flow-runner writes telemetry to `<workspace>/.telemetry/full.jsonl` (not the `.flow-agents/.telemetry/` subdirectory used by `FlowAgentsHooks`). Both paths are separate by design: kit telemetry captures gate-point evidence, session telemetry captures agent lifecycle events.

5. **compile_knowledge tool signature**: The tool takes three separate `id1`, `id2`, `id3` parameters instead of a JSON array. This is because `qwen3:1.7b` does not reliably produce valid JSON array syntax when prompted. This signature change is limited to this example and does not affect the kit's flow-runner API.

## Related references

- `integrations/strands/examples/knowledge_kit_live.py` — the example script
- `evals/acceptance/test_knowledge_kit_live.sh` — the acceptance test
- `kits/knowledge/adapters/flow-runner/index.js` — the kit flow-runner (capture + compile)
- `kits/knowledge/adapters/default-store/index.js` — the store adapter
- `kits/knowledge/kit.json` — kit manifest
- <a href="framework-adapter.html">Framework Adapter</a> — `FlowAgentsHooks` documentation and limitations
- <a href="../spec/runtime-hook-surface.html">Runtime Hook Surface spec</a> — canonical event taxonomy
