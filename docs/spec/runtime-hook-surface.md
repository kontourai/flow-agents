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
| `preToolUse` | Immediately before a tool call is executed. Maps from `PreToolUse`. | `hook_event_name`, `tool_name`, `tool_input` | `tool_id`, `cwd`, `usage.model`, `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, `usage.estimated_cost_usd`, `usage.pricing_version` |
| `permissionRequest` | The runtime is asking for permission to run a tool or action. Maps from `PermissionRequest`. | `hook_event_name`, `tool_name` | `tool_input`, `cwd` |
| `postToolUse` | After a tool call completes (success or failure). Maps from `PostToolUse` and `PostToolUseFailure`. | `hook_event_name`, `tool_name`, `tool_response` | `tool_input`, `tool_output`, `error`, `cwd`, `tool.duration_ms`, `tool.outcome`, `tool.status`, `usage.model`, `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, `usage.estimated_cost_usd`, `usage.pricing_version` |
| `stop` | The agent is about to stop and return control to the user. Maps from `Stop` and `SessionEnd`. | `hook_event_name` | `stop_reason`, `cwd` |
| `subagentStart` | A subagent or specialist delegate is spawning. Maps from `SubagentStart` (Claude Code). | `hook_event_name` | `agent_name`, `agent_type` |
| `subagentStop` | A subagent or specialist delegate has stopped. Maps from `SubagentStop` (Claude Code). | `hook_event_name` | `agent_name`, `outcome` |

**`usage.*` on `preToolUse`/`postToolUse` (#568 slice 1).** These two events carry an optional `.usage` object — `model`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `estimated_cost_usd`, `pricing_version` — sourced from the runtime transcript's LAST assistant turn (the turn that produced this specific tool call), joined via a bounded tail-read of `hook.transcript_path`. This is **per-turn, not a per-tool-call cost fraction**: multiple tool calls inside the same assistant turn (parallel tool_use blocks) report the *same* whole-turn usage figures — do not sum `estimated_cost_usd` across `tool.invoke`/`tool.result` rows within one turn, or cost will be double-counted; `session.usage`'s cumulative totals remain the authoritative aggregate. When the transcript join is unavailable but the runtime's `.model` hook field is present, only `usage.model` is populated and every token/cost field is explicitly `null` (never a guessed number); `.model` itself is best-effort on these two events (see §8.2), not a contractually guaranteed field. `tool.permission_request` (`permissionRequest`) is explicitly excluded from this enrichment.

**`tool.duration_ms` / `tool.outcome` / `tool.status` on `tool.result` (#580).** Every `tool.result` record (from `postToolUse`/`PostToolUse`/`PostToolUseFailure`) carries three intrinsic tool-result fields on its `.tool` object (co-located with `.tool.name`/`.tool.output`):
- **`duration_ms`** — non-negative wall-clock milliseconds between this tool's invoke and its result, correlated per tool call (host call id when present, else a content hash of `tool_name` + compact `tool_input`). The invoke's start time is recorded on `preToolUse` and read+unlinked on the matching result. It is **`null`** — never a fabricated `0` or a stale value — when the matching start record is absent (a result with no prior recorded invoke). Best-effort and non-blocking; a missing/corrupt start record degrades to `null`. Resolution is millisecond on hosts with a sub-second clock (`$EPOCHREALTIME`/GNU `date +%s%3N`) and second-granular on the portable fallback.
- **`outcome`** — the deterministic tri-state `pass` | `fail` | `ambiguous` from the canonical observation contract (§2.5), computed in-process by a jq port of `scripts/hooks/evidence-capture.js observeResult` so the Claude hot path stays hermetic (no node subprocess). A `PostToolUseFailure` event folds to `fail`. Never derived from stdout text or model narration. On the Codex runtime only — where the exit code lives in the rollout banner rather than the payload — the code is resolved via `scripts/hooks/lib/codex-exit-code.js` and fed through the same tri-state; an unreadable rollout degrades to `ambiguous`.
- **`status`** — the host-surfaced integer exit code when one is cleanly present (the same fields §2.5 scans), else **`null`**.

`tool.invoke` and `tool.permission_request` records carry none of these three fields (an invoke has no result yet; a permission request is not a tool result). The three fields are derived scalars only (a timestamp delta, a verdict, an integer) — no args/output/secret material — and the start record stores a bare timestamp, so the console-relay sanitize backstop is unaffected.

### Redaction Defaults

Telemetry channels redact sensitive payload fields before emission. Adapters must honor these defaults and must not log raw hook payloads without applying channel redaction.

| Channel | Default Redacted Fields |
| --- | --- |
| `full` | `hook.raw_input`, `turn.prompt_text`, `tool.input`, `tool.output` |
| `analytics` | `tool.input`, `tool.output`, `turn.prompt_text`, `delegation.targets.query`, `context.cwd`, `hook.raw_input` |

These defaults are configurable via `TELEMETRY_CHANNEL_FULL_REDACT` and `TELEMETRY_CHANNEL_ANALYTICS_REDACT` environment variables.

### Attribution Fields (canonical, all adapters)

Because `context.cwd` is redacted on the analytics/console relay (the full local path must never
leave the machine), adapters cannot rely on the consumer deriving a project name from it. So the
attribution label is itself canonical and every adapter — harness **and** framework — must produce it:

| Field | Semantics | Redacted? | Producer requirement |
| --- | --- | --- | --- |
| `context.project` | Coarse, path-free project label identifying the project a session is working in. | **No** (path-free by construction; safe to relay) | Adapters SHOULD populate `context.project` before emission when `context.project` is not already set, using the **canonical derivation precedence** below. Never send the full path. |

**Canonical derivation precedence (all adapters MUST resolve in this order, first match wins).** A
bare `basename(cwd)` is *not* sufficient — folder names differ between developers, clones, and
worktrees, so the same project would report inconsistent labels. Resolve most-stable-first:

1. `FLOW_AGENTS_PROJECT` — explicit operator override; always wins.
2. **Nearest project manifest name** walking up from the working dir — `package.json` `name` today
   (monorepo-granular *and* committed, so every developer of the same package resolves the same
   label). Other ecosystems (`pyproject.toml`, `Cargo.toml`, `go.mod`, …) extend this step — see
   the consistency callout.
3. **Git remote `org/repo`** (from `remote.origin.url`, `.git` stripped, path-free) — repo-level
   identity that is stable across clones and worktrees.
4. **Git toplevel directory basename** — the repo dir even when invoked from a worktree or subdir.
5. **`basename(cwd)`** — last resort.

Derivation is deterministic for a given working tree, so adapters SHOULD compute it once per
project per session and cache it rather than re-resolving per event.

Consumers (the console projection) prefer `context.project` and fall back to `basename(context.cwd)`
only when a non-redacted cwd is present. This keeps project attribution consistent across every
runtime — a Claude Code shell hook and an in-process Strands adapter derive the same label the same
way.

**Consistency callouts (features that cannot be identical across runtimes — surface, don't hide):**
- A runtime that exposes no working directory cannot resolve steps 2–5 and attributes to "unknown"
  by design; that gap must be surfaced, not silently bucketed (§"Degradation when host lacks
  trigger").
- Step 2's manifest matrix is inherently language-specific. Until an adapter's ecosystem manifest is
  supported, it resolves from step 3 onward. Adapters MUST document which manifests they honor so the
  attribution granularity difference is explicit, not surprising.

#### Work-item attribution (`task_slug`)

Where `context.project` groups events by *codebase*, `task_slug` groups them by the *active Builder
work item* — so the console can report cost and activity per unit of work (the "Cost by work-item"
breakdown), not just per project.

| Field | Semantics | Redacted? | Producer requirement |
| --- | --- | --- | --- |
| `task_slug` | Top-level slug of the Builder run active in `context.cwd` at emission time. | **No** (an opaque work-item slug; carries no path or content) | Adapters SHOULD stamp `task_slug` when a Builder run is active in the working dir. **Omit the field entirely when no run is active — never emit an empty string and never fabricate a slug.** |

Canonical resolution (harness adapter), first match wins, read from the *same* `current.json` the
economics relay reads so both surfaces attribute to one identifier:

1. `<cwd>/.kontourai/flow-agents/current.json` → `.active_slug`, else `.artifact_dir`.
2. `<cwd>/.flow-agents/current.json` (legacy location) → `.active_slug`, else `.artifact_dir`.
3. No file, or both fields empty → **no `task_slug` key on the record.**

Only the slug string is stored; no prompt, args, or file content is ever read into it. A non-Builder
session (no `current.json`) therefore emits records with no `task_slug`, and the console buckets
those under "unknown" rather than inventing an attribution.

### Exit Code Protocol (Canonical Hook Scripts)

Canonical hook scripts in `scripts/hooks/` use the following exit code contract — originally derived from Kiro conventions and shared across all harness adapters via the adapter translation layer:

| Exit Code | Semantics |
| --- | --- |
| `0` | Allow / pass through. The policy has no objection. |
| `2` | Block. The policy is vetoing the action (applicable to `preToolUse` and strict stop hooks). |
| other | Error. Adapters must treat errors as fail-open (allow). |

Adapters translate these exit codes into the host-native response format. The `claude-hook-adapter.js` and `codex-hook-adapter.js` wrappers perform this translation, and all errors fail open so hook runtime failures never block agent work.

### Block Reason Channel

A block (exit `2` → deny) is only useful if the agent learns *why* it was blocked and how to proceed. When a policy blocks, the hook script writes a human-readable reason — for example, config-protection's "Fix the source code … instead of weakening the config." The adapter **must surface that reason to the model** through the host's native deny-reason mechanism, **not only to a log or stderr**, where it dies before the agent sees it. A deny without a model-visible reason makes the agent retry the same blocked action instead of self-correcting.

| Host surface | Model-facing reason channel |
| --- | --- |
| Claude Code | `hookSpecificOutput.permissionDecisionReason` (preToolUse); `reason` (stop) |
| Codex | `hookSpecificOutput.permissionDecisionReason` (preToolUse); `reason` (stop) |
| opencode | the thrown error message on the blocked `tool.execute.before` (surfaced as the tool result) |
| pi | the `reason` field of the `{ block: true, reason }` tool-call result |
| Native pre-dispatch host (e.g. an orchestration layer) | the blocked call's tool-result text |

The reason text is the canonical steering message: it should tell the agent what to do *instead* (edit the source, not the generated artifact), so the agent can self-correct on the next turn. An adapter that denies the call but drops the reason to a log only is a **conformance gap** — record it in the adapter's conformance declaration.

---

## 2. Policy Classes

Flow Agents currently ships five canonical policy classes. Each policy class has a canonical hook script under `scripts/hooks/` and may be wired to one or more canonical trigger events.

### 2.1 Workflow Steering

**Intent**: Inject phase-transition reminders and ambient workflow-state guidance so the agent does not lose track of where it is in the delivery pipeline after subagent calls or context compaction.

**Canonical script**: `scripts/hooks/workflow-steering.js`

**Canonical trigger event**: `userPromptSubmit` and `agentSpawn`/`SessionStart` (active-goal re-grounding), `postToolUse` (after `InvokeSubagents` tool calls)

**Inputs consumed**:
- `.kontourai/flow-agents/<slug>/state.json` — current workflow phase and status
- `.kontourai/flow-agents/<slug>/critique.json` — open critique findings
- `docs/context-map.md` — structure hint for repo navigation

**Decision contract**: Non-blocking. Always exits 0. Appends steering text to the agent's context via `additionalContext`. It re-grounds the active workflow goal (status, phase, recorded next step) at the start of every user turn — not only for flagged/blocked states — and on `SessionStart`, which fires after context compaction and on resume. Canonical Builder run creation is part of session orchestration rather than a model-mediated hook action.

**Degradation when host lacks trigger**: If the host has no `userPromptSubmit`-equivalent hook, workflow steering is silent. The agent receives no ambient phase reminders at turn start. This is a capability loss, not a blocking failure. Log the gap in the adapter's conformance declaration.

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
- `.kontourai/flow-agents/<slug>/*.md` — workflow artifact files (scanned for active status, DOD, Goal Fit Gate sections)
- `.kontourai/flow-agents/<slug>/state.json` — workflow phase and next action
- `.kontourai/flow-agents/<slug>/evidence.json` — verification verdict and NOT_VERIFIED gaps
- `.kontourai/flow-agents/<slug>/critique.json` — critique status and open findings
- `.kontourai/flow-agents/<slug>/command-log.jsonl` — the deterministic capture log written by the Evidence Capture policy (see §2.5); cross-referenced against `evidence.json` claimed-pass command checks
- `.kontourai/flow-agents/<slug>/acceptance.json` — acceptance criteria; a criterion's `command`-kind `evidence_ref` (`excerpt`) is the most-trusted backstop command
- `.kontourai/flow-agents/current.json` (`active_flow_id`/`active_step_id`) — when present, resolves the active kit FlowDefinition's gate `expects[]` via the compiled `build/src/lib/flow-resolver.js` (`loadActiveFlowStep`, ADR 0016 Abstraction A P-c); requires `build/` to exist and fails open to the legacy `workflow.*`-only behavior when it does not (the `hasBuild` guard — the same fail-open pattern already used for the trust-bundle validator)
- The active kit's `kits/<kit>/flows/<flow>.flow.json` — the FlowDefinition file `current.json` resolves against; the matching gate's `expects[].bundle_claim.claimType` values become the declared claim types enforced for the active step (see FlowDefinition-driven claim selection below)
- `FLOW_AGENTS_GOAL_FIT_MODE` env var — `block` | `warn` | `off` (the legacy `FLOW_AGENTS_GOAL_FIT_STRICT=true` is an alias for `block`)
- `FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS` env var — consecutive-identical-block cap before the escape hatch releases (default 3)
- `FLOW_AGENTS_GOAL_FIT_BACKSTOP` env var — `block` (default) | `off`/`warn` | `skip`; controls the capture backstop re-run (see Capture cross-reference below)
- `FLOW_AGENTS_GOAL_FIT_BACKSTOP_TIMEOUT_MS` env var — per-backstop-command timeout in ms (default 120000; runaway commands are SIGKILL'd)
- `FLOW_AGENTS_GOAL_FIT_RECHECK` env var — `true` opts into re-running the model's free-form `evidence.checks[].command` (the RCE-risky path; off by default)

**Decision contract**:
- `warn` (canonical engine default): exits 0, writes guidance to stderr. Non-blocking.
- `block`: exits 2 when the active workflow artifact has state, Definition Of Done, Goal Fit, evidence, sidecar, or capture cross-reference issues that classify as blocking. Shipped L2 runtime configs (Claude Code, Codex) set `block` by default, overridable per-operator via the env var.
- `off`: silent (exits 0, no stderr).
- Escape hatch: in `block` mode the same goal-fit gap is refused up to `FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS` (default 3) consecutive times, then released (exit 0 with a loud notice) so a genuinely-unsatisfiable goal cannot trap the agent. A changing gap resets the streak.

**FlowDefinition-driven claim selection (ADR 0016 Abstraction A)**: When `current.json` resolves an active flow/step, `bundleEnforcement`'s claim-selection predicate (`isSelectedClaim`) is a **union**: `workflow.*`-prefixed claims are always selected as a baseline floor, and the active gate's declared `claimType` set (from `expects[].bundle_claim.claimType`, e.g. `builder.verify.tests`) is selected *in addition to* that floor — never instead of it. An earlier design used a pure if/else (declared types selected only when a FlowDefinition was active, with no `workflow.*` fallback) and was found in PR #215 to compose into a HIGH-severity gate-bypass chain: a forged `current.json` pointing at an `expects: []` flow made the if/else select zero claims, silently skipping all re-derivation, tamper-detection, and high/critical enforcement. The union floor closed that chain and is a **permanent** design decision, not a transitional step toward the if/else — see [ADR 0016](../adr/0016-three-hard-boundary-model.md) and the PR #215 post-mortem in [ADR 0015](../adr/0015-flow-flow-agents-boundary-reconciliation.md). Consequently, an active FlowDefinition whose gate resolves to an **empty** `expects[]` is always a `HARD_BLOCK` (`gate misconfiguration: active FlowDefinition has empty expects[]...`) — an empty declared set is treated as a possible tampered flow definition, never as a legitimately-empty gate that quietly enforces nothing beyond the floor.

**Capture cross-reference (capture-first determinism)**: For each `evidence.checks[]` of `kind:"command"` claiming `status:"pass"` that carries a `command`, the gate cross-references the deterministic capture log (`command-log.jsonl`, §2.5) *before* trusting the model's claim:

1. **Log shows the command ran and FAILED** → this is a caught false-completion → a blocking goal-fit gap (feeds the existing block/`MAX_BLOCKS` machinery).
2. **Log shows the command ran and PASSED** → satisfied deterministically, with no re-run.
3. **Log has NO execution for that claimed-pass command** (it was never actually run) → resolve a TRUSTED command to re-run as a thin backstop, in priority order:
   - **(a) acceptance criterion** — the `command`-kind evidence ref of the matching `acceptance.json` criterion (authored upfront, most trusted).
   - **(b) declared manifest target** — the project's own declared `package.json` `scripts.{test,build,lint}` (or `typecheck`), `Makefile` target, `cargo test`/`build`, `tox`/`pytest`, or `just`/`task` target. The NAMED declared target is run — never an arbitrary allowlisted string. (`veritas readiness` is just one such declared command — no special-casing.)
   - **(c) model free-form command** — `evidence.checks[].command`, ONLY when `FLOW_AGENTS_GOAL_FIT_RECHECK=true` (opt-in; the RCE-risky path).

   If the resolved backstop re-run fails, it is a caught false-completion. If NO trusted command resolves, the gate records `NOT_VERIFIED` — never a guess, never a silent pass, never auto-running an unlisted string.

**Backstop guardrails**: each backstop command runs under a per-command timeout (`FLOW_AGENTS_GOAL_FIT_BACKSTOP_TIMEOUT_MS`, default 120s; runaway commands are killed). The trusted-source backstop (a/b) rides `block` mode by default but is operator-disablable for latency: `FLOW_AGENTS_GOAL_FIT_BACKSTOP=off` (re-run becomes warn-only, never blocks) or `=skip` (no re-run at all → record `NOT_VERIFIED`). The arbitrary-model-command backstop (c) is opt-in only via `FLOW_AGENTS_GOAL_FIT_RECHECK`.

**Degradation when host lacks trigger**: If the host has no stop hook, stop-goal-fit cannot fire. The agent may complete without the check. Log the gap as `stop: no native equivalent — stop-goal-fit policy unavailable`.

### 2.4 Config Protection

**Intent**: Block the agent from weakening linter and formatter configuration files. Steers the agent to fix source code instead.

**Canonical script**: `scripts/hooks/config-protection.js`

**Canonical trigger event**: `preToolUse` (on write/edit tool calls)

**Inputs consumed**:
- `tool_input.path` or `tool_input.file_path` — the target file path
- `SA_HOOK_INPUT_TRUNCATED` env var — whether input was truncated (truncated payloads are blocked unconditionally)
- Protected file set: `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `prettier.config.*`, `biome.json`, `biome.jsonc`, `.ruff.toml`, `ruff.toml`, `.shellcheckrc`, `.stylelintrc*`, `.markdownlint*`

**Decision contract**: Blocking (exits 2) when the target file basename is in the protected set. Writes a descriptive message directing the agent to fix source instead, which the adapter surfaces to the model as the deny reason (see [Block Reason Channel](#block-reason-channel)). Exits 0 (allow) otherwise.

**Degradation when host lacks trigger**: If the host has no `preToolUse`-equivalent blocking hook, config protection cannot veto tool calls. The agent may modify linter configs without interception. Log the gap as `preToolUse: no native blocking equivalent — config-protection policy unavailable`.

### 2.5 Evidence Capture (capture-first determinism)

**Intent**: Make evidence about what actually ran *machine-recorded at the source* rather than transcribed later by the model. `evidence.json` is the model's narration and can claim a test passed when it did not. The capture policy deterministically records every command/shell tool execution and its observed result to an append-only log, which the Stop-Goal-Fit gate (§2.3) cross-references against the model's claims. This makes re-running at the gate a thin backstop, not the primary check.

**Canonical script**: `scripts/hooks/evidence-capture.js`

**Canonical trigger event**: `postToolUse` (after command/shell tool calls)

**Inputs consumed**:
- `tool_name` + `tool_input.command` — identifies a command/shell execution (a command string present, with a command-shaped tool name; when no tool name is present but a command string is, it is still captured).
- `tool_response` / `tool_output` / `error` — the host tool result (per §1, `postToolUse`); the source of the deterministically-observed outcome.
- `.kontourai/flow-agents/current.json` (`active_slug` / `artifact_dir`) then newest-mtime `state.json` — resolves the active artifact dir, the same way Workflow Steering and Stop-Goal-Fit do.

**Output**: appends one JSON object per line to `.kontourai/flow-agents/<slug>/command-log.jsonl`:

```json
{ "command": "npm test", "observedResult": "pass", "exitCode": 0, "capturedAt": "2026-06-23T00:00:00Z", "source": "postToolUse-capture" }
```

**Exit-code handling (deterministic observation only)**: a clean integer exit code is host-dependent. The policy extracts the real exit code where the host surfaces one (`tool_response`/`tool_output` `.exitCode`/`.exit_code`/`.status`/`.code`/`.returnCode`, or top-level equivalents) and sets `observedResult` to `pass` iff that code is `0`. When no clean integer exit code is present, `exitCode` is recorded as `null` and `observedResult` is inferred *only* from deterministic failure signals — a non-empty `error`, a `success:false`/`failed:true`/`is_error:true` flag, or a non-empty stderr with no stdout. When no clean integer exit code is present AND no deterministic failure signal exists, `exitCode` is recorded as `null` and `observedResult` is **`ambiguous`** — never `pass`. A `pass` always requires positive evidence (a clean integer exit code of 0; no host currently surfaces a positive success flag). Plain stdout text is never scanned for the words "error"/"fail"; the model's narration is never consulted.

**Consumer semantics of `ambiguous`**: `ambiguous` is non-confirming everywhere it is consumed — it never confirms a claimed pass and never itself resolves to a `verified` event, regardless of which runtime or extraction path produced it. `workflow-sidecar`'s trust-bundle build (`reduceCaptureLogByCommand` / `captureByCommand`) maps a command-log `ambiguous` capture to the existing canonical `not_verified` status — the same status record-check already uses for an ambiguous grep/diff exit — so the evidence item is `passing:false` and no `verified` event is ever emitted for it. `stop-goal-fit` (§2.3) further distinguishes the ORIGIN of an ambiguous capture: the absence-ambiguous case (a bare `grep`/`diff` that exited exactly `1`, which re-running yields no new information for) keeps its grep/diff-flavored `NOT_VERIFIED (ambiguous)` message and HARD_BLOCKs a terminal stop; a generic no-signal-ambiguous capture — no exit code observed at all, e.g. an unreadable Codex rollout banner or a bounded read that exceeded its caps — gets a grep/diff-free `NOT_VERIFIED —` message that is warn-only at a terminal stop but still blocks a non-terminal (in-flight) stop via the same `NOT_VERIFIED —` pattern. Neither path ever demotes to a confirmed `pass`.

**Codex host-banner carve-out**: On the Codex runtime, the host serializes the real exit code as host-generated prose (`Process exited with code N`) inside the tool result / session rollout rather than as a structured field (observed on codex-cli 0.142.5). The codex ADAPTER (`scripts/hooks/codex-hook-adapter.js`, scoped to the evidence-capture invocation on `postToolUse` only) extracts exactly that banner and injects it as a structured `tool_response.exitCode` BEFORE capture observes; this is a deterministic HOST signal (host-authored fixed format), not narration scanning — capture itself still never scans stdout or model narration. Extraction (`scripts/hooks/lib/codex-exit-code.js`) is **preamble-anchored**: the banner in a `function_call_output.output` string sits in the HOST-authored preamble, before the model's own stdout, which the codex CLI appends after a literal `Output:` delimiter; extraction matches the banner only in the portion BEFORE that delimiter (the FIRST match when no delimiter is present) and never scans the post-delimiter model stdout, so a command that deliberately prints a forged `Process exited with code 0` to its own stdout cannot override the real host-reported code. Reads are **head-anchored and bounded**: the target rollout line is located via a bounded backward scan (default 1MB), and only the first ~64KB of that line is read/parsed — the preamble/banner lives within the first few hundred bytes of the `output` field regardless of how much model stdout follows, so a >64KB flood of stdout after the banner can never displace it out of the read window; beyond either bound, extraction yields no signal (`null` → the `ambiguous` default above), never a guess. Extraction **correlates or declines** rather than blindly trusting the newest rollout entry: a payload-carried call_id match is authoritative when present; absent that, the newest `function_call_output` is cross-checked against its paired `function_call`'s command, and a resolvable match uses it while a resolvable **mismatch DECLINES to no signal** (never attributes another call's exit code); only when no correlation signal exists at all (the common single-call case) does it fall back to the newest banner. The `transcript_path` is resolved through `realpath` and required to be a regular file — and, when the codex sessions root itself is resolvable, contained within it — before any read. Extraction is fail-open throughout (missing/unreadable rollout, an unresolvable line, a declined correlation, or no banner → no injection → the `ambiguous` default above, subject to the consumer semantics described above).

**Decision contract**: Non-blocking. Always exits 0 and echoes stdin. Idempotent/append-only. Fail-open on any error — a capture failure must never block the agent or corrupt the log. Only records when an active workflow artifact dir resolves (otherwise there is nothing to anchor the log to).

**Degradation when host lacks trigger**: If the host has no `postToolUse` hook, command results are not captured. The Stop gate then has no capture log to cross-reference and falls back to its trusted backstop re-run (§2.3) for claimed-pass command checks. Log the gap as `postToolUse: no native equivalent — evidence capture unavailable; Stop gate relies on backstop re-run only`.

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
- Every block surfaces its reason to the model through the host's deny-reason channel (see [Block Reason Channel](#block-reason-channel)), not only to a log.
- Quality gate fires on `postToolUse`.
- Stop-goal-fit fires on `stop` with `FLOW_AGENTS_GOAL_FIT_MODE` configurable. Shipped L2 configs default to `block`; the canonical engine default remains `warn`, and any mode must be operator-overridable.
- Workflow steering additionally re-grounds the active goal on `agentSpawn`/`SessionStart` so an in-flight goal survives context compaction and resume.

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
| `preToolUse` | `hook_event_name` | `tool_name`, `tool_input.path`, `tool_input.file_path`, `cwd`, `usage.model`, `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, `usage.estimated_cost_usd`, `usage.pricing_version` |
| `postToolUse` | `hook_event_name` | `tool_name`, `tool_input.path`, `tool_input.file_path`, `tool_response`, `cwd`, `usage.model`, `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, `usage.estimated_cost_usd`, `usage.pricing_version` |
| `userPromptSubmit` | `hook_event_name` | `tool_input` (for subagent calls), `cwd` |
| `stop` | `hook_event_name` | `cwd`, `stop_reason` |

`usage.*` on `preToolUse`/`postToolUse` above is emitted output, not required input — it is populated by the telemetry adapter from the runtime transcript's last assistant turn (or degrades to `usage.model`-only / fully-null per the documented fallback tiers in §1), not read from the hook's stdin payload. It is **per-turn**, not a per-tool-call cost fraction: consumers must not sum `estimated_cost_usd` across tool events within the same assistant turn (see §1). The runtime-native `.model` field these events derive part of this from is best-effort, not contractually guaranteed by any host today.

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
| stop-goal-fit | Engine default warn (fail-open); blocks in `FLOW_AGENTS_GOAL_FIT_MODE=block` (shipped L2 default) | Yes — hook runtime errors exit 0 | Yes (stop, block mode) |
| workflow-steering | Fail-open (exit 0 always) | Yes | No |
| evidence-capture | Fail-open (exit 0 always) | Yes — capture errors never block or corrupt the log | No |

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
| `FLOW_AGENTS_GOAL_FIT_MODE` | `block` / `warn` / `off` | `stop-goal-fit.js` |
| `FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS` | Integer string (default 3) | `stop-goal-fit.js` |
| `FLOW_AGENTS_GOAL_FIT_STRICT` | `true` / `false` (legacy alias for mode=block) | `stop-goal-fit.js` |
| `FLOW_AGENTS_GOAL_FIT_BACKSTOP` | `block` (default) / `off` (=`warn`) / `skip` | `stop-goal-fit.js` |
| `FLOW_AGENTS_GOAL_FIT_BACKSTOP_TIMEOUT_MS` | Integer string (default 120000) | `stop-goal-fit.js` |
| `FLOW_AGENTS_GOAL_FIT_RECHECK` | `true` / `false` (opt-in re-run of model free-form command) | `stop-goal-fit.js` |
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

---

## 9. Framework-Path Kit Activation (strands-local adapter)

**Added**: Issue #32 — Knowledge Kit S4: framework-path kit activation.

### 9.1 Decision record (Q3)

Kit flow activation for Strands workspaces is implemented as a new runtime adapter id (`strands-local`) in `src/runtime-adapters.ts`, not as kit-flow loading inside `FlowAgentsHooks`. This keeps the `FlowAgentsHooks` class free of catalog-layout knowledge and reuses the `readKitInventory` + `safeSegment` helpers from the `codex-local` path.

The CLI command is:

```bash
flow-agents kit activate --adapter strands-local [--dest DIR] [--source-root DIR]
```

This writes activated flow files to `.kontourai/flow-agents/projections/strands/flows/<kit-id>/<asset-id>.flow.json` and produces a parity-diagnostic `activation.json` (same schema as codex-local: `schema_version`, `adapter`, `supported_asset_classes`, `generated_runtime_files`, `skipped_assets`, `warnings`, `errors`).

### 9.2 Steering context surfacing (AC2)

`FlowAgentsHooks.steering_context()` (Python) and `FlowAgentsHooks.steeringContext()` (TypeScript) read the runtime flow files written by `strands-local` activation and include a `KIT FLOWS:` section in the steering context text. This section lists each activated kit flow by id and description so the agent is aware of available workflow guidance without the hooks needing to know the catalog layout at construction time.

**Python usage** (see ):

```
hooks = FlowAgentsHooks(workspace=".")
system_prompt = base_prompt + hooks.steering_context()
# steering_context() includes KIT FLOWS section if .kontourai/flow-agents/projections/strands/flows/ is populated
```

**TypeScript usage**:

```typescript
const hooks = new FlowAgentsHooks({ workspace: "." });
const systemPrompt = basePrompt + hooks.steeringContext();
// steeringContext() includes KIT FLOWS section if .kontourai/flow-agents/projections/strands/flows/ is populated
```

### 9.3 Co-existence with codex-local

The `codex-local` and `strands-local` runtime directories are independent:

- `codex-local` writes to `.kontourai/flow-agents/projections/codex/`
- `strands-local` writes to `.kontourai/flow-agents/projections/strands/`

Running either adapter does not affect the other's runtime directory. Both adapters skip non-flow asset classes (skills, docs, adapters, evals, assets) with `reason: "asset class is diagnostic-only for <adapter>"`.
