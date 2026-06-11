---
title: Conformance
---

# Conformance

This page explains how a third-party adapter self-certifies against the Flow Agents policy engine contract. It covers the engine contract version 1.0, how to run the conformance kit, what each conformance level requires, and how to declare gaps using the opencode and pi built-in examples as the pattern.

Everything in this page is grounded in `packaging/conformance/` and `docs/spec/runtime-hook-surface.md`. No behavior is inferred.

## Engine contract 1.0

The engine contract is the versioned public interface between Flow Agents policy scripts and adapters. Third-party adapters bind to this contract. Breaking changes will increment the major version and be announced via CHANGELOG.

The contract is defined in <a href="../spec/runtime-hook-surface.html">the spec, section 8</a>. In summary:

**Invocation — subprocess form** (standard, used by all current adapters):

```bash
echo '<JSON payload>' | node scripts/hooks/run-hook.js <hookId> <scriptRelativePath> [profilesCsv]
```

- `hookId`: identifier for the hook (e.g., `config-protection`). Used for profile/disable checks.
- `scriptRelativePath`: path relative to `scripts/hooks/` (e.g., `config-protection.js`).
- `profilesCsv`: comma-separated profile names. Hooks not in the current `SA_HOOK_PROFILE` are skipped.
- Payload is read from stdin. Max 1 MiB. If truncated, `SA_HOOK_INPUT_TRUNCATED=1` is set.

**Invocation — native import form** (for Node.js adapters, preferred for performance):

```javascript
const { run } = require('./scripts/hooks/config-protection.js');
const output = run(rawJsonString, { truncated: false, maxStdin: 1024 * 1024 });
```

All four policy scripts export `module.exports = { run }`.

**Version query:**

```bash
node scripts/hooks/run-hook.js --contract-version
# → {"contract_version":"1.0","runner":"run-hook.js"}
```

**Exit code semantics:**

| Exit code | Semantics |
| --- | --- |
| `0` | Allow — policy has no objection |
| `2` | Block — policy vetoes the action |
| other | Error — treat as allow (fail-open) |

**Fail-open rule**: Hook runtime errors must never block agent work. Every policy except `config-protection` exits 0 always on non-policy errors. `config-protection` exits 2 only on a protected file match or a truncated payload; runtime errors exit 0.

## What each conformance level requires

Conformance levels are defined in <a href="../spec/runtime-hook-surface.html">the spec, section 4</a>.

### L0: Telemetry only

The adapter wires the telemetry script to at least one lifecycle event. No policy hooks are required.

**Required:** At minimum, `agentSpawn` telemetry fires on session start.

**Permitted gaps:** All four policy classes (workflow steering, quality gate, stop-goal-fit, config protection) may be absent.

**Use case:** Framework adapters and runtimes where the telemetry signal is valuable but blocking or context injection is not feasible.

### L1: Steering

The adapter implements L0 plus workflow steering and stop-goal-fit in warning mode.

**Required:**
- L0 telemetry.
- Workflow steering fires on `userPromptSubmit` (or the closest equivalent — document which event is used and any fidelity loss).
- Stop-goal-fit fires on `stop` in warning-only mode (exits 0 always).

**Permitted gaps:** Quality gate and config protection may be absent. Stop-goal-fit runs in warning mode only.

**Use case:** Harness adapters where the runtime supports prompt-submit and stop hooks, but tool-level blocking is not available or desired.

### L2: Enforcing gates

The adapter implements L1 plus all blocking policy classes.

**Required:**
- L1 steering and stop telemetry.
- Config protection fires on `preToolUse` and can block (exit 2 translates to a deny response).
- Quality gate fires on `postToolUse`.
- Stop-goal-fit fires on `stop` with `FLOW_AGENTS_GOAL_FIT_STRICT` configurable.

**Permitted gaps:** None. All four policy classes must be wired. Any missing host trigger must be documented as a named gap in the conformance declaration.

**Use case:** Claude Code and Codex are L2 reference implementations.

## Running the conformance kit

The conformance kit is in `packaging/conformance/`. It requires no npm dependencies — only Node.js.

**Self-test the canonical engine (must report L2):**

```bash
node packaging/conformance/run-conformance.js --self
```

**Test a third-party adapter at L2:**

```bash
node packaging/conformance/run-conformance.js \
  --adapter-cmd "node /path/to/your-adapter.js" \
  --level L2
```

**Test at L1 only:**

```bash
node packaging/conformance/run-conformance.js \
  --adapter-cmd "node /path/to/your-adapter.js" \
  --level L1
```

**CLI reference:**

```
node packaging/conformance/run-conformance.js [options]

  --self              Run against the canonical engine (target L2)
  --adapter-cmd CMD   Shell command to pipe fixtures to (adapter under test)
  --level L0|L1|L2    Minimum conformance level to enforce (default: L2 for --self, L0 for --adapter-cmd)
  --fixtures DIR      Override fixture directory (default: packaging/conformance/fixtures/)
  --verbose           Print fixture payloads and full output in per-fixture results
```

Exit codes: `0` = target level reached, `1` = target level not reached, `2` = usage error.

### Adapter contract for the runner

Your adapter command:
- Receives a canonical JSON payload on stdin (one JSON object).
- Writes the input JSON (or augmented form) to stdout on allow.
- Exits `0` to allow, `2` to block, any other code for error (treated as allow, fail-open).

The runner invokes your command exactly once per fixture via `sh -c "<your-cmd>"`.

### Fixture inventory

The fixtures in `packaging/conformance/fixtures/` cover all four policy classes:

| Fixture | Policy class | Event | Level |
| --- | --- | --- | --- |
| `config-protection--block-eslintrc.json` | config-protection | preToolUse | L2 |
| `config-protection--block-biome.json` | config-protection | preToolUse | L2 |
| `config-protection--allow-safe-file.json` | config-protection | preToolUse | L2 |
| `config-protection--allow-no-path.json` | config-protection | preToolUse | L2 |
| `quality-gate--allow-nonexistent-file.json` | quality-gate | postToolUse | L2 |
| `quality-gate--allow-no-path.json` | quality-gate | postToolUse | L2 |
| `stop-goal-fit--allow-clean-cwd.json` | stop-goal-fit | stop | L1 |
| `stop-goal-fit--warn-active-delivery.json` | stop-goal-fit | stop | L1 |
| `stop-goal-fit--block-strict-mode.json` | stop-goal-fit | stop | L2 |
| `workflow-steering--allow-no-state.json` | workflow-steering | userPromptSubmit | L1 |
| `workflow-steering--inject-active-state.json` | workflow-steering | userPromptSubmit | L1 |
| `workflow-steering--inject-subagent-steering.json` | workflow-steering | postToolUse | L1 |

Fixtures with `workspace_setup` create a temporary directory with the listed files before invoking the adapter and clean up afterward. The `cwd` field in those payloads is replaced with the temp directory path at runtime.

## How to declare gaps

If your adapter legitimately cannot satisfy a fixture — because the host runtime has no blocking `preToolUse` equivalent, or no stop hook — declare the gap explicitly in your adapter documentation. The opencode and pi adapters are the reference pattern.

### opencode: no prompt-submit hook

opencode has no native `prompt.submit`-equivalent event. Workflow steering cannot fire at each user turn. The gap is declared in the plugin source comment and in the conformance declaration:

```yaml
conformance_level: L1
host: opencode
event_coverage:
  agentSpawn: session.created (full fidelity)
  userPromptSubmit: no native equivalent — workflow steering fires at session.created only
  preToolUse: tool.execute.before (full fidelity, blocking available via thrown Error)
  postToolUse: tool.execute.after (full fidelity)
  stop: session.idle (reduced fidelity — fires on idle, not on completion)
  permissionRequest: permission.asked (telemetry only — no blocking capability)
policy_coverage:
  workflow_steering: partial — injected at session.created only, not at each turn
  quality_gate: wired at tool.execute.after
  stop_goal_fit: degraded — session.idle does not reliably fire at completion
  config_protection: wired at tool.execute.before (blocking)
gaps:
  - event: userPromptSubmit
    reason: opencode has no prompt.submit equivalent
    degradation: Workflow steering fires once at session.created instead of at each user turn
  - event: stop
    reason: session.idle is the closest event but is not a true completion signal
    degradation: stop-goal-fit warnings may not fire reliably at session end
```

### pi: no stop hook

pi has no stop hook. Stop-goal-fit cannot fire at session end. The gap is declared in the extension source comment and in the conformance declaration:

```yaml
conformance_level: L1
host: pi
event_coverage:
  agentSpawn: session_start (full fidelity)
  userPromptSubmit: before_agent_start (reduced fidelity — fires at agent start, not per-turn)
  preToolUse: tool_call (full fidelity, blockable via return { block: true })
  postToolUse: tool_result (full fidelity)
  stop: no native equivalent — session_shutdown used as closest analogue
policy_coverage:
  workflow_steering: partial — injected at before_agent_start, not at each user turn
  quality_gate: wired at tool_result
  stop_goal_fit: degraded — session_shutdown does not reliably carry stop semantics
  config_protection: wired at tool_call (blocking)
gaps:
  - event: stop
    reason: pi has no stop hook
    degradation: stop-goal-fit cannot fire; agent may complete without the check
    workaround: Run stop-goal-fit checks explicitly in CI or via a post-session script
```

## Including a conformance declaration in your adapter

After running the conformance kit, include a declaration in your adapter documentation:

```yaml
conformance_level: L2          # or L0 / L1
engine_contract_version: "1.0"
runner_version: "run-conformance.js"
test_date: 2026-06-11
verdict: PASS
fixture_count: 12
fixtures_passed: 12
gaps: []
```

If any fixtures fail, list them under `gaps` with a description of the degradation behavior. Declared gaps do not prevent reaching a lower conformance level — they make the adapter's behavior honest and auditable.

## Related references

- `packaging/conformance/run-conformance.js` — conformance runner
- `packaging/conformance/fixtures/` — golden fixtures
- `packaging/conformance/README.md` — conformance kit README
- <a href="../spec/runtime-hook-surface.html">Runtime Hook Surface spec §8</a> — engine contract 1.0 in full
- <a href="harness-install.html">Harness Install</a> — worked install examples for opencode and pi
- <a href="framework-adapter.html">Framework Adapter</a> — worked example of a language-native adapter
