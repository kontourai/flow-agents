---
title: Runtime Hook Surface Spec
---

# Runtime Hook Surface Spec

This document is the canonical reference for adapter authors who need to surface Flow Agents canonical policies and telemetry events on a new agent runtime or framework. It is runtime-neutral: the policies compile to whatever hook surface a host exposes.

## Audience

Adapter authors building:

- **Harness adapters** — install-time file wiring for agent runtimes (Claude Code, Codex, Kiro, opencode, pi).
- **Framework adapters** — in-process language-native packages for agent frameworks (AWS Strands, VoltAgent, LangGraph, OpenAI Agents SDK).

Readers should be familiar with the Flow Agents operating layer described in [Developer Architecture](../developer-architecture.html) and the operating layers in [Operating Layers](../operating-layers.html).

---

## 1. Canonical Event Taxonomy

Every Flow Agents event has a canonical name that is runtime-neutral. Adapters map these canonical names to host-native event names. The source of truth is `scripts/hooks/claude-telemetry-hook.js` and `scripts/hooks/codex-telemetry-hook.js`.

### Canonical Telemetry Events

| Canonical Name | Trigger Semantics | Required Payload Fields | Optional Payload Fields |
| --- | --- | --- | --- |
| `agentSpawn` | A new agent session starts. Maps from `SessionStart` on Claude Code and Codex. | `hook_event_name`, `cwd` | `session_id`, `agent_id`, `model`, `runtime` |
| `userPromptSubmit` | The user submits a new turn or message. Maps from `UserPromptSubmit`. | `hook_event_name` | `turn.prompt_text` (redacted by default), `cwd` |
| `preToolUse` | Immediately before a tool call is executed. Maps from `PreToolUse`. | `hook_event_name`, `tool_name`, `tool_input` | `tool_id`, `cwd` |
| `permissionRequest` | The runtime is asking for permission to run a tool or action. Maps from `PermissionRequest`. | `hook_event_name`, `tool_name` | `tool_input`, `cwd` |
| `postToolUse` | After a tool call completes (success or failure). Maps from `PostToolUse` and `PostToolUseFailure`. | `hook_event_name`, `tool_name`, `tool_response` | `tool_input`, `tool_output`, `error`, `cwd` |
| `stop` | The agent is about to stop and return control to the user. Maps from `Stop` and `SessionEnd`. | `hook_event_name` | `stop_reason`, `cwd` |
| `subagentStart` | A subagent or specialist delegate is spawning. Maps from `SubagentStart` (Claude Code). | `hook_event_name` | `agent_name`, `agent_type` |
| `subagentStop` | A subagent or specialist delegate has stopped. Maps from `SubagentStop` (Claude Code). | `hook_event_name` | `agent_name`, `outcome` |

### Redaction Defaults

Telemetry channels redact sensitive payload fields before emission. Adapters must honor these defaults and must not log raw hook payloads without applying channel redaction.

| Channel | Default Redacted Fields |
| --- | --- |
| `full` | `hook.raw_input`, `turn.prompt_text`, `tool.input`, `tool.output` |
| `analytics` | `tool.input`, `tool.output`, `turn.prompt_text`, `delegation.targets.query`, `context.cwd`, `hook.raw_input` |

These defaults are configurable via `TELEMETRY_CHANNEL_FULL_REDACT` and `TELEMETRY_CHANNEL_ANALYTICS_REDACT` environment variables.

### Exit Code Protocol (Canonical Hook Scripts)

Canonical hook scripts in `scripts/hooks/` use the following exit code contract — originally derived from Kiro conventions and shared across all harness adapters via the adapter translation layer:

| Exit Code | Semantics |
| --- | --- |
| `0` | Allow / pass through. The policy has no objection. |
| `2` | Block. The policy is vetoing the action (applicable to `preToolUse` and strict stop hooks). |
| other | Error. Adapters must treat errors as fail-open (allow). |

Adapters translate these exit codes into the host-native response format. The `claude-hook-adapter.js` and `codex-hook-adapter.js` wrappers perform this translation, and all errors fail open so hook runtime failures never block agent work.

---

## 2. Policy Classes

Flow Agents currently ships four canonical policy classes. Each policy class has a canonical hook script under `scripts/hooks/` and may be wired to one or more canonical trigger events.

### 2.1 Workflow Steering

**Intent**: Inject phase-transition reminders and ambient workflow-state guidance so the agent does not lose track of where it is in the delivery pipeline after subagent calls or context compaction.

**Canonical script**: `scripts/hooks/workflow-steering.js`

**Canonical trigger event**: `userPromptSubmit` (ambient state guidance), `postToolUse` (after `InvokeSubagents` tool calls)

**Inputs consumed**:
- `.flow-agents/<slug>/state.json` — current workflow phase and status
- `.flow-agents/<slug>/critique.json` — open critique findings
- `docs/context-map.md` — structure hint for repo navigation

**Decision contract**: Non-blocking. Always exits 0. Appends steering text to the agent's context via `additionalContext` in the hook response. Does not block any action.

**Degradation when host lacks trigger**: If the host has no `userPromptSubmit`-equivalent hook, workflow steering is silent. The agent receives no ambient phase reminders at turn start. This is a capability loss, not a blocking failure. Log the gap in the adapter's conformance declaration as `userPromptSubmit: no native equivalent — steering context injection unavailable`.

**Codex live hook influence caveat**: Codex hook influence on live sessions is limited — the agent may not honor all injected context. The hook influence behavioral cases in `evals/fixtures/hook-influence/cases.json` document which behaviors are expected (`agent_must_do`) versus which may only be soft guidance. Adapters on similar runtimes should apply the same classification.

**opencode no-prompt-submit-hook caveat**: opencode does not expose a `prompt.submit`-equivalent event (see mapping table in section 5). Workflow steering context injection is unavailable for opencode adapters at the `userPromptSubmit` trigger point. Adapters may approximate this by injecting steering context into `session.created` or `session.idle`, but these are lower-fidelity substitutes because they do not fire at each user turn.

### 2.2 Quality Gate

**Intent**: Run per-file format and lint checks immediately after edit tool calls to catch style regressions while the file is still in scope.

**Canonical script**: `scripts/hooks/quality-gate.js`

**Canonical trigger event**: `postToolUse` (after write/edit tool calls)

**Inputs consumed**:
- `tool_input.path` or `tool_input.file_path` — the modified file path
- `SA_QUALITY_GATE_FIX` env var — whether to auto-fix (`true`) or only check
- `SA_QUALITY_GATE_STRICT` env var — whether to emit warnings (`true`)
- Formatter detection (`biome.json`, `.prettierrc`, `ruff.toml`, etc.) from the file's project root

**Decision contract**: Non-blocking. Always exits 0. Logs warnings to stderr. Does not block any tool call. Only runs when the modified file extension matches a supported formatter (`.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.md`, `.go`, `.py`).

**Degradation when host lacks trigger**: If the host has no `postToolUse` hook, quality gate checks do not fire. The agent must rely on batch checks at stop time or explicit lint commands. Log the gap as `postToolUse: no native equivalent — per-file quality gate unavailable`.

### 2.3 Stop-Goal-Fit

**Intent**: Warn (and optionally block) when the agent is about to stop but the active workflow artifact shows unresolved state: missing Definition Of Done, unchecked Goal Fit items, open evidence gaps, or failing sidecar validation.

**Canonical script**: `scripts/hooks/stop-goal-fit.js`

**Canonical trigger event**: `stop`

**Inputs consumed**:
- `.flow-agents/<slug>/*.md` — workflow artifact files (scanned for active status, DOD, Goal Fit Gate sections)
- `.flow-agents/<slug>/state.json` — workflow phase and next action
- `.flow-agents/<slug>/evidence.json` — verification verdict and NOT_VERIFIED gaps
- `.flow-agents/<slug>/critique.json` — critique status and open findings
- `FLOW_AGENTS_GOAL_FIT_STRICT` env var — `true` to make blocking (exit 2) instead of warning-only (exit 0)

**Decision contract**:
- Default mode: warning-only (exits 0). Writes guidance to stderr.
- Strict mode (`FLOW_AGENTS_GOAL_FIT_STRICT=true`): blocking (exits 2) when the active workflow artifact has state, Definition Of Done, Goal Fit, or sidecar issues that classify as blocking.

**Degradation when host lacks trigger**: If the host has no stop hook, stop-goal-fit cannot fire. The agent may complete without the check. Log the gap as `stop: no native equivalent — stop-goal-fit policy unavailable`.

### 2.4 Config Protection

**Intent**: Block the agent from weakening linter and formatter configuration files. Steers the agent to fix source code instead.

**Canonical script**: `scripts/hooks/config-protection.js`

**Canonical trigger event**: `preToolUse` (on write/edit tool calls)

**Inputs consumed**:
- `tool_input.path` or `tool_input.file_path` — the target file path
- `SA_HOOK_INPUT_TRUNCATED` env var — whether input was truncated (truncated payloads are blocked unconditionally)
- Protected file set: `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `prettier.config.*`, `biome.json`, `biome.jsonc`, `.ruff.toml`, `ruff.toml`, `.shellcheckrc`, `.stylelintrc*`, `.markdownlint*`

**Decision contract**: Blocking (exits 2) when the target file basename is in the protected set. Writes a descriptive message to stderr directing the agent to fix source instead. Exits 0 (allow) otherwise.

**Degradation when host lacks trigger**: If the host has no `preToolUse`-equivalent blocking hook, config protection cannot veto tool calls. The agent may modify linter configs without interception. Log the gap as `preToolUse: no native blocking equivalent — config-protection policy unavailable`.

---

## 3. Hook Profiles

The `run-hook.js` runner supports a three-level profile system, controlled by the `SA_HOOK_PROFILE` environment variable.

| Profile | Behavior |
| --- | --- |
| `minimal` | Hooks in the `minimal` allowlist run. All others are skipped. |
| `standard` | Default. Hooks targeting `standard` or `strict` profiles run. Most hooks use this profile. |
| `strict` | All hooks run. Stricter behavior (e.g., `SA_QUALITY_GATE_STRICT=true`) may be implied. |

Individual hooks may be disabled by listing their IDs in `SA_DISABLED_HOOKS` (comma-separated). Adapters should expose these controls through their configuration surface.

---

## 4. Conformance Levels

Conformance levels define what a host adapter implements. These levels are intended to be referenced by the runtime matrix in product and marketing materials.

### L0: Telemetry-Only

The adapter wires the canonical telemetry script (`scripts/telemetry/telemetry.sh` via a language-specific wrapper) to at least one lifecycle event. No policy hooks are wired.

**Required**: At minimum, `agentSpawn` telemetry fires on session start.

**Permitted gaps**: All policy classes (workflow steering, quality gate, stop-goal-fit, config protection) are absent.

**Use case**: Framework adapters and runtimes where the telemetry signal is valuable but blocking or injecting context is not feasible.

### L1: Steering

The adapter implements L0 plus workflow steering context injection and, where the host has a stop hook, stop-goal-fit in warning mode.

**Required**:
- L0 telemetry.
- Workflow steering fires on `userPromptSubmit` (or the closest equivalent; document which event is used and any fidelity loss).
- Stop-goal-fit fires on `stop` in warning-only mode (exits 0 always).

**Permitted gaps**: Quality gate and config protection are absent. Stop-goal-fit runs in warning mode only.

**Use case**: Harness adapters where the runtime supports prompt-submit and stop hooks, but tool-level blocking is not available or desired.

### L2: Enforcing Gates

The adapter implements L1 plus all blocking policy classes.

**Required**:
- L1 steering and stop telemetry.
- Config protection fires on `preToolUse` and can block (exit 2 translates to a deny response).
- Quality gate fires on `postToolUse`.
- Stop-goal-fit fires on `stop` with `FLOW_AGENTS_GOAL_FIT_STRICT` configurable (default may be warning mode; strict mode must be possible to enable).

**Permitted gaps**: None. All four policy classes are wired. Any missing host trigger must be documented as a named gap in the adapter's conformance declaration.

**Use case**: Claude Code (current reference implementation), Codex (current reference implementation). The target conformance level for new harness adapters.

---

## 5. Mapping Tables

The following tables show the canonical Flow Agents events and their corresponding host-native event surfaces. "No native equivalent" entries are honest gaps, not future work unless noted.

### 5.1 Canonical Event to Host Surface

| Canonical Event | Claude Code | Codex | Kiro | opencode | pi |
| --- | --- | --- | --- | --- | --- |
| `agentSpawn` | `SessionStart` | `SessionStart` | `SessionStart` | `session.created` (interactive mode only — NOT delivered to plugin hooks in `run`/non-interactive mode; verified v1.16.2) | `session_start` |
| `userPromptSubmit` | `UserPromptSubmit` | `UserPromptSubmit` | `UserPromptSubmit` | No native equivalent | `input` (closest; fires on user input, not confirmed submission) |
| `preToolUse` | `PreToolUse` | `PreToolUse` | `PreToolUse` | `tool.execute.before` | `tool_call` (blockable) |
| `permissionRequest` | `PermissionRequest` | `PermissionRequest` | No native equivalent | No native equivalent | No native equivalent |
| `postToolUse` | `PostToolUse`, `PostToolUseFailure` | `PostToolUse` | `PostToolUse` | `tool.execute.after` | `tool_result` |
| `stop` | `Stop`, `SessionEnd` | `Stop` | `Stop` | `session.idle` (closest; not a true stop event) | No native equivalent |
| `subagentStart` | `SubagentStart` | No native equivalent | No native equivalent | No native equivalent | No native equivalent |
| `subagentStop` | `SubagentStop` | No native equivalent | No native equivalent | No native equivalent | No native equivalent |

### 5.2 Canonical Policy to Host Blocking Capability

| Policy Class | Claude Code | Codex | Kiro | opencode | pi |
| --- | --- | --- | --- | --- | --- |
| Workflow steering (inject) | `UserPromptSubmit` additionalContext | `UserPromptSubmit` additionalContext | `UserPromptSubmit` context | No prompt-submit hook — gap (see section 2.1) | `input` (reduced fidelity) |
| Quality gate (warn) | `PostToolUse` additionalContext | `PostToolUse` additionalContext | `PostToolUse` | `tool.execute.after` | `tool_result` |
| Stop-goal-fit (warn/block) | `Stop` — can block | `Stop` — can block | `Stop` — can block | `session.idle` — no block capability | No stop hook — gap |
| Config protection (block) | `PreToolUse` deny | `PreToolUse` deny | `PreToolUse` deny | `tool.execute.before` deny | `tool_call` block |

### 5.3 Framework Adapter Mapping

| Canonical Event | AWS Strands | VoltAgent | LangGraph | OpenAI Agents SDK |
| --- | --- | --- | --- | --- |
| `agentSpawn` | `BeforeInvocationEvent` | `onStart` | `on_chain_start` | Lifecycle: `on_agent_start` |
| `userPromptSubmit` | No native equivalent — inject via system prompt at invocation | No native equivalent | `on_chain_start` (partial) | No native equivalent |
| `preToolUse` | `BeforeToolCallEvent` (cancellable) | `onToolStart` | `on_tool_start` | No native blocking equivalent |
| `postToolUse` | `AfterToolCallEvent` | `onToolEnd` | `on_tool_end` | No native equivalent |
| `stop` | `AfterInvocationEvent` | `onEnd` | `on_chain_end` | `on_agent_end` |
| Context injection | `MessageAddedEvent` (Strands: message context) | No native equivalent | Callback / middleware | Guardrails (input/output) |

**Note on AWS Strands**: The `BeforeToolCallEvent` is cancellable, which maps directly to the blocking policy contract. The `MessageAddedEvent` may be used to approximate workflow steering context injection. A Strands spike is being scaffolded under `integrations/strands/`.

---

## 6. Distribution Models

### 6.1 Harness Adapters (File Install via Bundles)

Harness adapters are file sets that the `npm run build:bundles` command generates and the host-specific install script places on disk. The bundle builder (`src/tools/build-universal-bundles.ts`) generates the host config files from the canonical manifest and policy scripts.

**What an adapter must implement**:

1. **Event wiring config** — A host-specific configuration file (e.g., `.claude/settings.json` hooks object, `.codex/hooks.json`) that maps host event names to shell commands that invoke the canonical hook adapter wrapper.
2. **Adapter wrapper** — A host-specific JS (or equivalent) wrapper (e.g., `claude-hook-adapter.js`, `codex-hook-adapter.js`) that:
   - Reads stdin JSON from the host.
   - Invokes `run-hook.js` with the canonical script path and profile.
   - Translates the exit code and output to the host-native hook response format.
   - Fails open on errors (never blocks work due to hook runtime failure).
3. **Telemetry wrapper** — A host-specific wrapper (e.g., `claude-telemetry-hook.js`, `codex-telemetry-hook.js`) that:
   - Maps host event names to canonical telemetry event names.
   - Invokes `scripts/telemetry/telemetry.sh` with the canonical event name and agent name.
   - Emits a valid host-native hook response (telemetry is always non-blocking).
4. **Install script** — A shell script that places the generated files at the host-expected paths and applies any path token substitution (e.g., `__KIRO_PACKAGE_ROOT__`).

**Generated hook command pattern** (from `src/tools/build-universal-bundles.ts` lines 198–242):

```
# Telemetry (fires first, always non-blocking):
bash -lc 'root="${<HOST_ROOT_VAR>:-$(pwd)}"; node "$root/scripts/hooks/<host>-telemetry-hook.js" <EventName> dev'

# Policy (fires second, may block on preToolUse):
bash -lc 'root="${<HOST_ROOT_VAR>:-$(pwd)}"; node "$root/scripts/hooks/<host>-hook-adapter.js" <EventName> <hook-id> <script.js> default'
```

**Timeout defaults**: Telemetry hooks default to 10 seconds. Policy hooks default to 30 seconds. Override via `FLOW_AGENTS_<RUNTIME>_HOOK_TIMEOUT_MS` and `FLOW_AGENTS_<RUNTIME>_TELEMETRY_TIMEOUT_MS`.

**Environment variable set by adapters**:

| Variable | Value | Purpose |
| --- | --- | --- |
| `FLOW_AGENTS_HOOK_RUNTIME` | `claude-code`, `codex`, etc. | Identifies the runtime to downstream hooks |
| `FLOW_AGENTS_TELEMETRY_RUNTIME` | `claude-code`, `codex`, etc. | Identifies the runtime to telemetry |
| `SA_HOOK_INPUT_TRUNCATED` | `0` or `1` | Whether the stdin payload was truncated at `MAX_STDIN` (1 MiB) |
| `SA_HOOK_INPUT_MAX_BYTES` | integer string | The truncation threshold in bytes |

### 6.2 Framework Adapters (Language-Native Package)

Framework adapters are in-process packages (npm, PyPI, Maven, etc.) that register Flow Agents hooks with the framework's lifecycle system using the framework's native registration API.

**What an adapter must implement**:

1. **Lifecycle registration** — Register callbacks with the framework at the hook points that correspond to canonical events (see mapping table, section 5.3).
2. **Canonical script invocation** — When a registered callback fires, invoke the corresponding canonical hook script (`scripts/hooks/<policy>.js`) via a subprocess or by calling the exported `run()` function directly (preferred for performance — see `run-hook.js` for the `module.exports.run` fast path).
3. **Blocking translation** — For blocking-capable hooks (e.g., `BeforeToolCallEvent` in Strands, `tool_call` in pi), translate exit code 2 from the canonical script into the framework-native cancellation or deny signal.
4. **Fail-open error handling** — If the canonical script exits with a non-0, non-2 code, or fails to execute, treat the result as allow (pass through). Never allow hook runtime errors to block agent work.
5. **Telemetry dispatch** — For each canonical event, invoke `scripts/telemetry/telemetry.sh <canonical-event-name> <agent-name>` with the JSON payload on stdin. Telemetry must not block the framework callback chain.
6. **Profile and disable controls** — Honor `SA_HOOK_PROFILE` (minimal/standard/strict) and `SA_DISABLED_HOOKS` either by passing them as environment variables to the subprocess or by implementing the same logic from `scripts/hooks/lib/hook-flags.js` natively.

**Minimum viable framework adapter** (pseudocode):

```
on_before_tool_call(event):
  result = invoke_canonical("config-protection.js", event.as_json())
  if result.exit_code == 2:
    event.cancel(reason=result.stderr)
  dispatch_telemetry("preToolUse", event.as_json())  # non-blocking

on_after_tool_call(event):
  invoke_canonical("quality-gate.js", event.as_json())  # non-blocking
  dispatch_telemetry("postToolUse", event.as_json())

on_agent_start(event):
  dispatch_telemetry("agentSpawn", event.as_json())

on_agent_end(event):
  invoke_canonical("stop-goal-fit.js", event.as_json())  # blocking if STRICT=true
  dispatch_telemetry("stop", event.as_json())
```

---

## 7. Conformance Declaration

Each adapter must include a conformance declaration in its adapter documentation or metadata. The declaration must name:

1. **Conformance level**: L0, L1, or L2.
2. **Host runtime**: The target host name and version range.
3. **Canonical event coverage**: Which canonical events are wired and which are gaps, using the naming from section 1.
4. **Policy coverage**: Which policy classes are wired, at which trigger points, and with what blocking capability.
5. **Named gaps**: For every "no native equivalent" mapping, state the gap explicitly, describe the degradation behavior, and note whether any lower-fidelity approximation is used.

**Example** (opencode adapter, L1):

```
conformance_level: L1
host: opencode
event_coverage:
  agentSpawn: session.created — delivered in interactive mode; NOT delivered to plugin
    hooks in run (non-interactive) mode (verified v1.16.2, 2026-06-11). agentSpawn
    telemetry is absent from run-mode sessions; tool.invoke/tool.result are present.
  userPromptSubmit: no native equivalent — workflow steering unavailable at turn boundary
  preToolUse: tool.execute.before (full fidelity, blocking available)
  postToolUse: tool.execute.after (full fidelity)
  stop: session.idle (reduced fidelity — not a true stop; fires on idle, not completion)
  permissionRequest: no native equivalent
  subagentStart: no native equivalent
  subagentStop: no native equivalent
policy_coverage:
  workflow_steering: partial — injected at session.created only (interactive mode); unavailable in run mode
  quality_gate: wired at tool.execute.after
  stop_goal_fit: degraded — session.idle does not reliably fire at completion
  config_protection: wired at tool.execute.before (blocking)
named_gaps:
  session.created_run_mode: In opencode run mode, session.created is not delivered
    to plugin hooks. This is an opencode runtime limitation with no known workaround
    at the plugin API level. agentSpawn telemetry is NOT_VERIFIED for run-mode sessions.
```

---

## Related Documents

- [Developer Architecture](../developer-architecture.html) — coordination map and product boundaries.
- [Operating Layers](../operating-layers.html) — layer model and placement rules.
- [Eval Strategy](../workflow-eval-strategy.html) — how hook influence behavior is validated.
- [Developer Hook Setup](../developer-hook-setup.html) — runtime boundary for repo-local git hooks vs. runtime hooks.
- `scripts/hooks/` — canonical policy implementations.
- `src/tools/build-universal-bundles.ts` — bundle generation logic including hook command patterns.
- `evals/fixtures/hook-influence/cases.json` — behavioral cases that define expected agent responses to hook guidance.

---

## 8. Engine Contract (contract_version "1.0")

This section is the versioned public contract for the Flow Agents policy engine. Third-party adapters bind to this contract. Breaking changes will increment the major version and be announced via CHANGELOG.

### 8.1 Invocation forms

**Form 1 — Subprocess CLI** (the standard form, used by all current adapters):

```
echo '<JSON payload>' | node scripts/hooks/run-hook.js <hookId> <scriptRelativePath> [profilesCsv]
```

- `hookId`: an identifier string for the hook (e.g., `config-protection`). Used for profile/disable checks.
- `scriptRelativePath`: path relative to `scripts/hooks/` (e.g., `config-protection.js`).
- `profilesCsv`: comma-separated profile names that must include the current `SA_HOOK_PROFILE` value (default `standard`). Hooks not in the allowed profiles are skipped (fail-open).
- Payload is read from stdin. Max 1 MiB (`SA_HOOK_INPUT_MAX_BYTES`). If truncated, `SA_HOOK_INPUT_TRUNCATED=1` is set.

**Form 2 — Native import** (for TypeScript/Node.js adapters, preferred for performance):

```javascript
const { run } = require('./scripts/hooks/config-protection.js');
const output = run(rawJsonString, { truncated: false, maxStdin: 1024 * 1024 });
// output: string (pass-through) | { exitCode, stderr?, stdout? } (structured)
```

All four policy scripts export `module.exports = { run }`.

**Version query** (additive, backward-compatible):

```
node scripts/hooks/run-hook.js --contract-version
# → {"contract_version":"1.0","runner":"run-hook.js"}
```

### 8.2 Payload schema per canonical event

All payloads are a single JSON object on stdin. Required and optional fields:

| Canonical event | Required fields | Optional fields |
|----------------|-----------------|-----------------|
| `preToolUse` | `hook_event_name` | `tool_name`, `tool_input.path`, `tool_input.file_path`, `cwd` |
| `postToolUse` | `hook_event_name` | `tool_name`, `tool_input.path`, `tool_input.file_path`, `tool_response`, `cwd` |
| `userPromptSubmit` | `hook_event_name` | `tool_input` (for subagent calls), `cwd` |
| `stop` | `hook_event_name` | `cwd`, `stop_reason` |

`hook_event_name` is the **host-native** event name (e.g., `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`) or may be omitted — policy scripts read the canonical fields (`tool_input.path`, `cwd`) directly and do not require the event name field for their decisions.

### 8.3 Decision schema (stdout / exit code)

| Exit code | Semantics | Stdout |
|-----------|-----------|--------|
| `0` | **Allow** — policy has no objection | Echo of raw input JSON (or input + appended guidance for steering) |
| `2` | **Block** — policy vetoes the action | Empty or irrelevant (adapters use stderr message for the block reason) |
| other | **Error** — hook runtime failure | Treat as allow (fail-open). Never block agent work on hook errors. |

For steering/quality hooks that return guidance, the output format is:

```
<original input JSON>\n\n---\n<guidance text>\n---
```

For structured `run()` responses (native import form), the return value is:
- A string: treated as the full stdout replacement.
- `{ exitCode, stderr?, stdout? }`: `exitCode` drives allow/block; `stderr` is written to stderr; `stdout` overrides stdout (if absent, raw input is echoed on allow).

### 8.4 Fail-open vs. fail-closed rules per policy class

| Policy class | Default mode | Fail-open on error? | Blocking capable? |
|-------------|-------------|--------------------|--------------------|
| config-protection | Fail-closed (exit 2 on protected file) | Yes — hook runtime errors exit 0 | Yes (preToolUse) |
| quality-gate | Fail-open (exit 0 always) | Yes | No |
| stop-goal-fit | Fail-open by default; fail-closed with `FLOW_AGENTS_GOAL_FIT_STRICT=true` | Yes — hook runtime errors exit 0 | Yes (stop, strict mode only) |
| workflow-steering | Fail-open (exit 0 always) | Yes | No |

**Telemetry**: Always fail-open. Hook runtime errors in telemetry scripts must never block agent work.

**Truncated payloads**: config-protection exits 2 (block) when `SA_HOOK_INPUT_TRUNCATED=1`, because it cannot safely evaluate an incomplete payload. All other policies fail-open on truncated input.

### 8.5 Environment variables consumed by the engine

| Variable | Values | Consumed by |
|----------|--------|-------------|
| `SA_HOOK_PROFILE` | `minimal` \| `standard` (default) \| `strict` | `run-hook.js` |
| `SA_DISABLED_HOOKS` | Comma-separated hook IDs | `run-hook.js` |
| `SA_HOOK_INPUT_TRUNCATED` | `0` or `1` | `config-protection.js` |
| `SA_HOOK_INPUT_MAX_BYTES` | Integer string | `config-protection.js` |
| `SA_QUALITY_GATE_FIX` | `true` / `false` | `quality-gate.js` |
| `SA_QUALITY_GATE_STRICT` | `true` / `false` | `quality-gate.js` |
| `FLOW_AGENTS_GOAL_FIT_STRICT` | `true` / `false` | `stop-goal-fit.js` |
| `FLOW_AGENTS_REQUIRE_SIDECARS` | `true` / `false` | `stop-goal-fit.js` |
| `FLOW_AGENTS_REQUIRE_CRITIQUE` | `true` / `false` | `stop-goal-fit.js` |
| `FLOW_AGENTS_HOOK_RUNTIME` | `claude-code`, `codex`, etc. | Hook adapters (forwarded to scripts) |

### 8.6 Self-certification via the conformance kit

The `packaging/conformance/` directory contains golden fixtures and a test runner. To self-certify:

```bash
# Verify the canonical engine reaches L2 (required to pass):
node packaging/conformance/run-conformance.js --self

# Test a third-party adapter at L1:
node packaging/conformance/run-conformance.js \
  --adapter-cmd "node /path/to/your-adapter.js" \
  --level L1
```

See `packaging/conformance/README.md` for the full fixture inventory and declaration format.
