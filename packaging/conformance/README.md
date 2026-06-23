# Flow Agents Conformance Kit

The conformance kit lets third-party adapter authors self-certify their implementation against the Flow Agents policy engine contract.

---

## What is the conformance kit?

Flow Agents ships four canonical policy classes (config-protection, quality-gate, stop-goal-fit, workflow-steering) that adapters must invoke via subprocess or native import. The conformance kit provides:

1. **Golden fixtures** (`fixtures/`) — payload→expected-decision JSON pairs, one per policy class × canonical event × case, extracted from real engine behavior.
2. **Conformance runner** (`run-conformance.js`) — a standalone Node.js script (no npm deps) that pipes each fixture through an adapter command and reports per-level verdict.

---

## Conformance levels

| Level | What is required |
|-------|-----------------|
| **L0** | No policy fixtures required. Adapter wires telemetry only. |
| **L1** | Workflow steering (`userPromptSubmit`) and stop-goal-fit (`stop`) in warning mode must pass. |
| **L2** | All L1 requirements plus config-protection (`preToolUse`, blocking) and quality-gate (`postToolUse`, non-blocking). |

These levels match the definitions in `docs/spec/runtime-hook-surface.md` §4.

---

## Quick start

```bash
# Self-test the canonical engine (must report L2):
node packaging/conformance/run-conformance.js --self

# Test a third-party adapter:
node packaging/conformance/run-conformance.js \
  --adapter-cmd "node /path/to/your-adapter.js" \
  --level L2

# Test at L1 only:
node packaging/conformance/run-conformance.js \
  --adapter-cmd "node /path/to/your-adapter.js" \
  --level L1
```

---

## Adapter contract

Your adapter command:
- Receives a canonical JSON payload on **stdin** (one JSON object, see §Payload schema).
- Writes the input JSON (or augmented form) to **stdout** on allow.
- Writes nothing meaningful to stdout on block (or empty/echoed input).
- Exits **0** to allow, **2** to block, any other code for error (treated as allow / fail-open).

The runner invokes your command exactly once per fixture via `sh -c "<your-cmd>"`.

---

## Payload schema (contract_version "1.0")

All payloads are JSON objects with:

| Field | Type | Description |
|-------|------|-------------|
| `hook_event_name` | string | Canonical event name: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` |
| `tool_name` | string? | Tool name (for tool-call events) |
| `tool_input` | object? | Tool input (for tool-call events); contains `path` or `file_path` for write tools |
| `cwd` | string? | Current working directory of the agent session |

Full payload/decision schema is documented in `docs/spec/runtime-hook-surface.md` §8 (Engine Contract).

---

## Fixture inventory

| Fixture | Policy class | Event | Level | What it tests |
|---------|-------------|-------|-------|---------------|
| `config-protection--block-eslintrc.json` | config-protection | preToolUse | L2 | Block write to `.eslintrc.json` |
| `config-protection--block-biome.json` | config-protection | preToolUse | L2 | Block edit to `biome.json` via `file_path` |
| `config-protection--allow-safe-file.json` | config-protection | preToolUse | L2 | Allow write to `src/main.ts` |
| `config-protection--allow-no-path.json` | config-protection | preToolUse | L2 | Allow when no path in tool_input |
| `quality-gate--allow-nonexistent-file.json` | quality-gate | postToolUse | L2 | Non-blocking for missing .ts file |
| `quality-gate--allow-no-path.json` | quality-gate | postToolUse | L2 | Non-blocking when no path in tool_input |
| `stop-goal-fit--allow-clean-cwd.json` | stop-goal-fit | stop | L1 | No warnings in clean workspace |
| `stop-goal-fit--warn-active-delivery.json` | stop-goal-fit | stop | L1 | Warnings for active delivery without DOD/GoalFit |
| `stop-goal-fit--block-strict-mode.json` | stop-goal-fit | stop | L2 | Exit 2 with FLOW_AGENTS_GOAL_FIT_STRICT=true |
| `stop-goal-fit--block-mode.json` | stop-goal-fit | stop | L2 | Exit 2 with FLOW_AGENTS_GOAL_FIT_MODE=block |
| `stop-goal-fit--off-mode.json` | stop-goal-fit | stop | L1 | Silent (exit 0, no stderr) with FLOW_AGENTS_GOAL_FIT_MODE=off |
| `workflow-steering--allow-no-state.json` | workflow-steering | userPromptSubmit | L1 | Pass-through when no active workflow state |
| `workflow-steering--inject-active-state.json` | workflow-steering | userPromptSubmit | L1 | Injects STATE hint for blocked task |
| `workflow-steering--inject-subagent-steering.json` | workflow-steering | postToolUse | L1 | Injects EXECUTION COMPLETE hint after tool-worker |
| `workflow-steering--reground-active-prompt.json` | workflow-steering | userPromptSubmit | L1 | Re-grounds an ordinary in_progress task (not just flagged states) |
| `workflow-steering--reground-session-start.json` | workflow-steering | sessionStart | L1 | Re-grounds the active goal on SessionStart (survives compaction/resume) |

Fixtures with `workspace_setup` create a temporary directory with the listed files before invoking the adapter, and clean it up afterward. The `cwd` field in those payloads is replaced with the temp directory path at runtime.

### Goal-fit enforcement mode

`stop-goal-fit` enforcement is controlled by `FLOW_AGENTS_GOAL_FIT_MODE` (`block` | `warn` | `off`); the legacy `FLOW_AGENTS_GOAL_FIT_STRICT=true` is honored as an alias for `block`. The canonical engine default is `warn`, so the conformance contract stays warning-by-default. Shipped L2 runtime configs (Claude Code, Codex) set `block` by default — overridable per-operator via the env var — so the installed product enforces while the engine default and these fixtures remain warn. In `block` mode the same goal-fit gap is refused up to `FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS` (default 3) consecutive times, then released to avoid trapping the agent on an unsatisfiable goal.

---

## How to declare conformance

After running the conformance kit, include a conformance declaration in your adapter documentation:

```yaml
conformance_level: L2          # or L0 / L1
engine_contract_version: "1.0"
runner_version: "run-conformance.js"
test_date: 2026-06-11
verdict: PASS
fixture_count: 18
fixtures_passed: 18
gaps: []                       # List any declared gaps here
```

If any fixtures fail, list them under `gaps` with a description of the degradation behavior.

---

## Declaring gaps

If your adapter legitimately cannot satisfy a fixture (e.g., the host runtime has no blocking `preToolUse` equivalent), declare it explicitly:

```yaml
gaps:
  - fixture: config-protection--block-eslintrc.json
    reason: "Host does not support blocking tool calls; config-protection fails open"
    degradation: "Agent may modify linter configs without interception"
    workaround: "Run config-protection as a linting step in CI instead"
```

Declared gaps do not prevent reaching a lower conformance level.

---

## CLI reference

```
node packaging/conformance/run-conformance.js [options]

  --self              Run against the canonical engine (target L2)
  --adapter-cmd CMD   Shell command to pipe fixtures to (adapter under test)
  --level L0|L1|L2    Minimum conformance level to enforce (default: L2 for --self, L0 for --adapter-cmd)
  --fixtures DIR      Override fixture directory (default: packaging/conformance/fixtures/)
  --verbose           Print fixture payloads and full output in per-fixture results
```

Exit codes: `0` = target level reached, `1` = target level not reached, `2` = usage error.
