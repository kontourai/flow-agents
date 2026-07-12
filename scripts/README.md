# Scripts Directory

`scripts/` is the public compatibility and shell-runtime surface for Flow Agents. Keep command paths stable unless a migration includes wrappers, docs updates, and bundle/install validation.

## Public Wrappers

These files are stable launchers for TypeScript code compiled under `build/src/`:

| Wrapper | Compiled implementation |
| --- | --- |
| `build-universal-bundles.js` | `build/src/tools/build-universal-bundles.js` |
| `generate-context-map.js` | `build/src/tools/generate-context-map.js` |
| `kit.js` | `build/src/cli/kit.js` |
| `pull-work-provider.js` | `build/src/cli/pull-work-provider.js` |
| `effective-backlog-settings.js` | `build/src/cli/effective-backlog-settings.js` |
| `publish-change-helper.js` | `build/src/cli/publish-change-helper.js` |
| `promote-workflow-artifact.js` | `build/src/cli/promote-workflow-artifact.js` |
| `usage-feedback.js` | `build/src/cli/usage-feedback.js` |
| `validate-hook-influence-cases.js` | `build/src/cli/validate-hook-influence.js` |
| `validate-source-tree.js` | `build/src/cli.js validate-source` through package command wiring |

If implementation moves, update these wrappers rather than breaking callers.
`npm run validate:source --` enforces this table: public wrappers must remain
thin launchers, and implementation logic belongs under `src/cli/` or
`src/tools/`.

## Package Command Surface

`package.json` exposes command names through npm scripts and package bins.
Commands that run `node build/src/cli.js <command>` must be registered in
`src/cli.ts`; bins that point at `build/src/cli.js` must have a matching
`flow-agents-*` alias in `src/cli.ts`. Direct bins may point at compiled
single-command entry points such as `build/src/cli/workflow-sidecar.js` when
callers need a stable executable name without the multiplexer.

`npm run validate:source --` checks this command surface and rejects stale
migration scaffolding such as pending command registries. Add a real command,
document a compatibility wrapper, or delete the stale surface.

## Runtime Hooks

`scripts/hooks/` contains runtime hook adapters and policies for Claude Code, Codex, Kiro-style hooks, and repo guardrails. Canonical hook behavior lives here and in TypeScript bundle generation, not in local `.codex/` or `.claude/` installs.

`npm run validate:source --` enforces this inventory. If a hook moves, is
renamed, or changes category, update the table and the validator together.

| Hook file | Category | Owning checks | Purpose |
| --- | --- | --- | --- |
| `claude-hook-adapter.js` | runtime adapter | `evals/integration/test_hook_category_behaviors.sh`, `evals/integration/test_runtime_adapter_activation.sh` | Translates Claude hook events into the shared hook runner contract. |
| `codex-hook-adapter.js` | runtime adapter | `evals/integration/test_hook_category_behaviors.sh`, `evals/integration/test_runtime_adapter_activation.sh` | Translates Codex hook events into the shared hook runner contract. |
| `claude-telemetry-hook.js` | telemetry shim | `evals/integration/test_hook_category_behaviors.sh`, `evals/integration/test_telemetry.sh` | Captures Claude hook telemetry and fails open. |
| `codex-telemetry-hook.js` | telemetry shim | `evals/integration/test_hook_category_behaviors.sh`, `evals/integration/test_telemetry.sh` | Captures Codex hook telemetry and fails open. |
| `run-hook.js` | hook runner | `evals/integration/test_hook_category_behaviors.sh`, `evals/integration/test_goal_fit_hook.sh`, `evals/integration/test_workflow_steering_hook.sh` | Applies profile/disable flags, traversal checks, and hook execution. |
| `config-protection.js` | policy hook | `evals/integration/test_hook_category_behaviors.sh` | Blocks unsafe runtime config edits. |
| `evidence-capture.js` | policy hook | `evals/integration/test_evidence_capture_hook.sh` | Deterministically captures command executions to `.kontourai/flow-agents/<slug>/command-log.jsonl` so evidence is machine-recorded, not model-claimed (cross-referenced by stop-goal-fit). |
| `governance-audit.sh` | policy hook | `evals/integration/test_hook_category_behaviors.sh`, `evals/integration/test_telemetry.sh` | Emits governance/Veritas audit context when configured. |
| `opencode-hook-adapter.js` | runtime adapter | `evals/integration/test_bundle_install.sh` | Translates opencode plugin events into the shared hook runner contract. |
| `opencode-telemetry-hook.js` | telemetry shim | `evals/integration/test_bundle_install.sh` | Captures opencode plugin telemetry and fails open. |
| `pi-hook-adapter.js` | runtime adapter | `evals/integration/test_bundle_install.sh` | Translates pi extension events into the shared hook runner contract. |
| `pi-telemetry-hook.js` | telemetry shim | `evals/integration/test_bundle_install.sh` | Captures pi extension telemetry and fails open. |
| `post-edit-accumulator.js` | policy hook | `evals/integration/test_hook_category_behaviors.sh` | Tracks edited files across a turn for later quality hooks. |
| `quality-gate.js` | policy hook | `evals/integration/test_hook_category_behaviors.sh` | Runs configured quality checks as hook policy. |
| `report-only-guard.js` | policy hook | `evals/integration/test_hook_category_behaviors.sh` | Protects report-only specialist roles from production edits. |
| `stop-format-typecheck.js` | policy hook | `evals/integration/test_hook_category_behaviors.sh` | Runs stop-time format/typecheck feedback. |
| `stop-goal-fit.js` | policy hook | `evals/integration/test_goal_fit_hook.sh` | Warns when a workflow is about to stop short of Goal Fit. |
| `utterance-check.js` | policy hook | `evals/integration/test_utterance_check.sh` | Optionally checks agent utterances for evidence coverage using @kontourai/survey (disabled by default; opt-in via FLOW_AGENTS_UTTERANCE_CHECK_ENABLED). |
| `workflow-steering.js` | policy hook | `evals/integration/test_workflow_steering_hook.sh` | Provides workflow guidance from current artifact state. |
| `pre-commit-quality.js` | repo guardrail hook | `evals/integration/test_hook_category_behaviors.sh` | Supports repository Git hook checks, not installed runtime hooks. |
| `desktop-notify.sh` | local notification helper | `evals/integration/test_hook_category_behaviors.sh` | Optional local desktop notification helper. |
| `lib/actor-identity.js` | shared hook library | `evals/integration/test_actor_identity.sh` | Shared runtime-agnostic actor identity resolver (`resolveActor`) consumed by `workflow-steering.js` and `workflow-sidecar.js` to retire the shared `"local"` liveness-actor default (issue #287). |
| `lib/audit-transport.sh` | shared hook library | `evals/integration/test_hook_category_behaviors.sh`, `evals/integration/test_telemetry.sh` | Shared audit event transport functions. |
| `lib/codex-exit-code.js` | shared hook library | `evals/acceptance/prove-capture-teeth.sh` | Shared codex-only host-banner exit-code extraction (`extractExitCodeFromBanner`, `readExitCodeFromRollout`) — parses the `Process exited with code N` prose the codex CLI writes into a `function_call_output` payload or session rollout so `codex-hook-adapter.js` can inject a structured exit code before `evidence-capture.js` observes (issue #470). |
| `lib/config-protection-remedies.js` | shared hook library | `evals/integration/test_hook_category_behaviors.sh` | Sanctioned-remedy table for `config-protection.js` (WS8/ADR 0020 extraction). |
| `lib/current-pointer.js` | shared hook library | `evals/integration/test_current_json_per_actor.sh` | Shared per-actor "current" pointer reader/writer (`readCurrentPointer`, `writePerActorCurrent`) — the compat-shim fallback (per-actor `current/<actor>.json` first, legacy global `current.json` fallback) every actor-aware consumer routes through (issue #291). |
| `lib/hook-flags.js` | shared hook library | `evals/integration/test_hook_category_behaviors.sh` | Shared profile/disable flag parsing. |
| `lib/kit-catalog.js` | shared hook library | `evals/integration/test_workflow_steering_hook.sh` | Build-free kit catalog reader used by `workflow-steering.js` to load kit-declared workflow triggers while hooks remain fail-open and independent of compiled TypeScript output. |
| `lib/liveness-heartbeat.js` | shared hook library | `evals/integration/test_liveness_heartbeat.sh` | Shared tool-activity liveness heartbeat (`maybeEmitHeartbeat`); rides `postToolUse` across all four telemetry hook wrappers, throttled and fail-open (issue #288). |
| `lib/liveness-policy.js` | shared hook library | `evals/integration/test_workflow_sidecar_writer.sh`, `evals/integration/test_liveness_heartbeat.sh` | Shared liveness on/off predicate (`isLivenessEnabled`, default-on/opt-out) and TTL/heartbeat-throttle default resolution (issue #288). |
| `lib/liveness-read.js` | shared hook library | `evals/integration/test_session_resume_roundtrip.sh` | Shared liveness event reader + freshness check (`readLivenessEvents`, `freshHolders`); consumed by the reground hook and `workflow-sidecar liveness status`. |
| `lib/liveness-write.js` | shared hook library | `evals/integration/test_workflow_sidecar_writer.sh`, `evals/integration/test_liveness_heartbeat.sh` | Shared liveness event stream writer (`livenessStreamFile`, `appendLivenessEvent`), lifted from `workflow-sidecar.ts` so the CLI and hook wrappers share one writer (issue #288). |
| `lib/local-artifact-paths.js` | shared hook library | `evals/integration/test_migrate_local_artifacts.sh`, `evals/integration/test_workflow_sidecar_writer.sh` | Shared `.kontourai/flow-agents` artifact-root helpers for CJS hooks. |
| `lib/patterns.sh` | shared hook library | `evals/integration/test_hook_category_behaviors.sh`, `evals/integration/test_telemetry.sh` | Shared shell pattern constants. |
| `lib/resolve-formatter.js` | shared hook library | `evals/integration/test_hook_category_behaviors.sh` | Shared formatter resolution helper. |
| `lib/runnable-command.js` | shared hook library | `evals/integration/test_goal_fit_hook.sh` | Shared runnable-command-text heuristic (`isRunnableCommandText`) consumed by `stop-goal-fit.js` and `workflow-sidecar.js` so record-time and Stop-time checks never drift (issue #412). |
| `lib/skill-drift.js` | shared hook library | `evals/integration/test_skill_drift_check.sh` | Shared installed-Claude-Code-skill manifest builder and drift classifier (`buildManifest`, `compareSkillDrift`) — the single choke point the `init --global` manifest writer, the `flow-agents skill-drift-check` CLI, and the SessionStart advisory all route through so they never disagree on drift classification (issue #439). |

## Telemetry

`scripts/telemetry/` contains shell telemetry collection and redaction helpers. Runtime hook wrappers call these scripts; generated bundles copy them for installed runtime use.

Set `CONSOLE_TELEMETRY_URL` or `CONSOLE_URL` to mirror redacted runtime
telemetry to a Console API. The transport derives `/api/telemetry/records`
unless `CONSOLE_TELEMETRY_ENDPOINT_URL` is set explicitly. Hosted Console URLs
must use `https://`; `http://` is accepted only for `localhost` or `127.0.0.1`
local development. Use `CONSOLE_TELEMETRY_TOKEN` or `CONSOLE_AUTH_TOKEN` for
bearer auth, and `CONSOLE_TENANT_ID` for hosted tenant routing. Leaving the
Console URL unset keeps telemetry local-only.

Installers persist telemetry sink choices into the installed
`scripts/telemetry/telemetry.conf`. `local-files` is the default and requires no
Console. Add `--telemetry-sink local-kontour-console` for a separately running
local Console, `--telemetry-sink kontour-hosted-console` for Kontour's hosted
Console, or `--telemetry-sink user-hosted-console --console-url ...` for a
self-hosted Console. Legacy `kontour-cloud` and `hosted-kontour-console` names
remain accepted. `--console-token-file` and `--console-tenant` can be used with
any Console sink. Prefer `flow-agents init` for a prompted setup; use `--yes`
with the same flags for CI/headless installs.

Run `flow-agents telemetry-doctor --dest PATH --json --headless` to inspect an
installed telemetry configuration. It reports active sinks, local JSONL paths,
Console target settings, and bounded local Console reachability without
prompting. Add `--allow-network` to probe a non-local HTTPS Console endpoint.

## Install And Repo Utilities

- `install-codex-home.sh`: installs Codex runtime assets into `CODEX_HOME` (or `~/.codex`) and portable skills into `$HOME/.agents/skills`. Use `--skills-dir PATH` or `FLOW_AGENTS_SKILLS_DIR` to select a hermetic or advanced-user skill catalog independently of the positional runtime destination. The installer reports both resolved roots, preserves user-owned files, migrates only unchanged Flow Agents-owned legacy skills, and refuses symlink destinations rather than creating a compatibility symlink.
- `setup-repo-hooks.sh`: configures this clone's Git hook path.
- `check-content-boundary.cjs`, `detect-tools.sh`, `discover-agents.sh`, `git-status.sh`: repo-local helper commands.
- `context-budget/` and `statusline/`: specialized support tooling copied into bundles where needed.

## Bundle Policy

`scripts/` is copied into generated bundles intentionally. Do not remove scripts from bundle output only to reduce size unless the corresponding source, generated install behavior, docs, and evals are updated together.

`evals/static/test_universal_bundles.sh` rebuilds bundles and checks the output
shape. It also verifies reproducibility by building the same source into two
fresh output directories and diffing the results. A failure means generated
content is non-deterministic or a bundle build step is carrying stale state.
