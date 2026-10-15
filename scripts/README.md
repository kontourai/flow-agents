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
| `../telemetry/run-correlation-binding.js` | shared telemetry adapter | `src/cli/telemetry-run-binding.test.mjs`, `evals/integration/test_installed_runtime_correlation.sh` | Resolves only the authenticated runtime actor's Builder binding and projects its validated run-correlation envelope into telemetry. |
| `post-edit-accumulator.js` | policy hook | `evals/integration/test_hook_category_behaviors.sh` | Tracks edited files across a turn for later quality hooks. |
| `quality-gate.js` | policy hook | `evals/integration/test_hook_category_behaviors.sh` | Runs configured quality checks as hook policy. |
| `report-only-guard.js` | policy hook | `evals/integration/test_hook_category_behaviors.sh` | Protects report-only specialist roles from production edits. |
| `stop-format-typecheck.js` | policy hook | `evals/integration/test_hook_category_behaviors.sh` | Runs stop-time format/typecheck feedback. |
| `stop-goal-fit.js` | policy hook | `evals/integration/test_goal_fit_hook.sh` | Warns when a workflow is about to stop short of Goal Fit. |
| `utterance-check.js` | policy hook | `evals/integration/test_utterance_check.sh` | Optionally checks agent utterances for evidence coverage using @kontourai/survey (disabled by default; opt-in via FLOW_AGENTS_UTTERANCE_CHECK_ENABLED). |
| `workflow-steering.js` | policy hook | `evals/integration/test_workflow_steering_hook.sh` | Provides workflow guidance from current artifact state. |
| `pre-commit-quality.js` | repo guardrail hook | `evals/integration/test_hook_category_behaviors.sh` | Supports repository Git hook checks, not installed runtime hooks. |
| `desktop-notify.sh` | local notification helper | `evals/integration/test_hook_category_behaviors.sh` | Optional local desktop notification helper. |
| `lib/actor-identity.js` | shared hook library | `evals/integration/test_actor_identity.sh` | Canonical runtime-agnostic actor resolver (`resolveActor`), including privacy-safe Codex thread identity and explicitly unstable process-ancestry fallback. TypeScript consumers load this file directly; there is no maintained mirror. |
| `lib/anchored-jsonl-stage.js` | shared hook library | `src/cli/anchored-jsonl-stage.test.mjs`, `evals/integration/test_workflow_sidecar_writer.sh` | Stages an agent event append relative to an inode-validated agent directory descriptor and retains rollback authority until the matching current-pointer update commits. |
| `lib/audit-transport.sh` | shared hook library | `evals/integration/test_hook_category_behaviors.sh`, `evals/integration/test_telemetry.sh` | Shared audit event transport functions. |
| `lib/codex-exit-code.js` | shared hook library | `evals/acceptance/prove-capture-teeth.sh` | Shared codex-only host-banner exit-code extraction (`extractExitCodeFromBanner`, `readExitCodeFromRollout`) — parses the `Process exited with code N` prose the codex CLI writes into a `function_call_output` payload or session rollout so `codex-hook-adapter.js` can inject a structured exit code before `evidence-capture.js` observes (issue #470). |
| `lib/config-protection-remedies.js` | shared hook library | `evals/integration/test_hook_category_behaviors.sh` | Sanctioned-remedy table for `config-protection.js` (WS8/ADR 0020 extraction). |
| `lib/continuation-turn-authority.js` | shared hook library | `src/cli/continuation-driver.test.mjs`, `evals/integration/test_goal_fit_hook.sh` | Signed transient authority for one public continuation adapter turn, independently anchored by the signer digest in driver mission state. Assignment-gated evidence mutation can fall back to its live signed assignment identity only after ordinary resolution mismatches; lifecycle controls never use it. Stop keeps a base-valid signed run selected across canonical dispositions, validates canonical state against its definition, and treats only ordinary active-gate warnings as advisory. Same-UID filesystem/process attacks remain outside the cooperative boundary. |
| `lib/current-pointer.js` | shared hook library | `evals/integration/test_current_json_per_actor.sh` | Shared per-actor "current" pointer reader/writer (`readCurrentPointer`, `writePerActorCurrent`) — the compat-shim fallback (per-actor `current/<actor>.json` first, legacy global `current.json` fallback) every actor-aware consumer routes through (issue #291). |
| `lib/declared-artifact-roots.js` | shared hook library | `src/cli/fixture-and-hook-scoping.test.mjs` | Declared-artifact-root resolver the config-protection Bash detectors scope to (#783): computes protected roots (cwd/git/shared-repo/workspace-env, each contributing `.kontourai/flow-agents`, `.flow-agents`, `delivery/`) with a fail-closed ambiguity contract (`isCandidateWithinDeclaredRoots`); TypeScript twin `src/lib/declared-artifact-roots.ts` backs the sanctioned `fixture write` subcommand. |
| `lib/denial-escalation.js` | shared hook library | `src/cli/denial-escalation.test.mjs` | Per-flow-step denial counter (issue #1005). Keys on denial identity -- rule id plus resolved target, never raw command text, so a compliant route-around to a different supported form never counts as a strike -- scopes counts to the active flow step and resets them on step transition. The third identical denial in one step escalates; every earlier denial ends the call only. |
| `lib/denial-guidance.js` | shared hook library | `src/cli/denial-escalation.test.mjs` | Agent-facing denial message shaping (issue #1005). Pure text transform with no policy authority: strips the incident register (the `BLOCKED:` opener, doubled "never disable this hook" warnings, advice to disable the hook, self-disclosed incomplete-coverage notes) while preserving every remediation path, so a first denial reads as recoverable guidance. |
| `lib/effective-flow-agents-config.js` | shared hook library | `src/cli/effective-flow-agents-config.test.mjs`, `evals/integration/test_goal_fit_config.sh` | Committed-only goal-fit configuration resolver (`resolveGoalFitConfig`). It reads an immutable `HEAD` blob with replacement objects and ambient Git configuration disabled; malformed committed policy fails closed and working-tree bytes have no authority. |
| `lib/env-defaults.js` | shared hook library | `src/cli/env-defaults.test.mjs` | `--env-default=KEY=VALUE` adapter-argument support (#1098). Replaces the shell-prefix env defaulting (`VAR="${VAR:-block}"`) that required a shell in the hook path: the adapters strip these flags from argv and apply each default to the child environment only when the key is unset or empty, so an operator's explicit value always wins. |
| `lib/flow-recovery-fence.js` | shared hook library | `evals/integration/test_goal_fit_hook.sh`, `evals/integration/test_workflow_steering_hook.sh` | Strict read-only parser for the canonical Flow run recovery fence. Hooks refuse canonical state projection while a recovery is active or the fence record is malformed or unsupported. |
| `lib/hook-flags.js` | shared hook library | `evals/integration/test_hook_category_behaviors.sh` | Shared profile/disable flag parsing. |
| `lib/hook-workflow-scope.js` | shared hook library | `src/cli/hook-worktree-scope.test.mjs`, `evals/integration/test_liveness_worktree_root.sh` | Resolves and publishes exact actor-bound physical workflow discovery while retaining shared coordination roots; stale or retired bindings cannot select another actor's run. |
| `lib/install-freshness.js` | shared hook library | `evals/integration/test_workflow_steering_hook.sh` | Install-freshness classifier (`installFreshnessAdvisory`) behind the SessionStart advisory (issue #1180): `checkoutStaleness` proves the installed commit is a strict ancestor behind the session checkout's `origin/main` (ancestry, never a version compare, so a tarball packed from `main` is correctly silent); `registryStaleness` reads only a 24h TTL cache beside `install.json` and never contacts the registry, refreshing it through a detached best-effort child. Every undeterminable or error path returns silence. |
| `lib/stop-escalation.js` | shared hook library | `src/cli/stop-escalation.test.mjs`, `evals/integration/test_goal_fit_hook.sh` | The Stop gate's turn-ending contract (issue #1172). Parses and strips the `[flow-agents:stop-control]` line a hook emits to declare a NON-RELEASABLE (hard) block, so an adapter classifies without pattern-matching prose; decides turn-ending asymmetrically (soft blocks are left to the gate's own max-blocks release valve, hard blocks end the turn on the continuation firing); and keeps a per-actor consecutive-blocking-Stop counter as a runtime-agnostic backstop when `stop_hook_active` is absent. |
| `lib/read-only-grammar.js` | shared hook library | `src/cli/config-protection-readonly.test.mjs` | Provably-read-only command grammar for the config-protection interpreter detector (#799): positive-match allowlist (json.tool invocations; load/print-only `-c`/`-e` bodies) that fails closed on any ambiguity, so genuine gate-file reads stop false-positive blocking while every write-shaped command still blocks. |
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
| `lib/trusted-git.js` | shared hook library | `src/cli/trusted-git.test.mjs`, `evals/integration/test_trusted_git_namespace.sh` | Canonical bounded system Git primitive shared by CLI and hooks, with protected executable routes, sanitized configuration, identity checks and supported Linux namespace provenance. |

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

`flow-agents init --global` for `claude-code` and `opencode` does not write
Console settings anywhere, so it refuses every `--console-*` flag and any
`--telemetry-sink` other than `local-files`, and exits without writing
anything. Interactive `init --global` for these runtimes skips the Console
prompt. Their telemetry reads the user-global
`~/.flow-agents/telemetry-console.conf` described below. Write it with
`bash scripts/telemetry/install-console-config.sh ~/.flow-agents/telemetry-console.conf --telemetry-sink ... --console-url ...`;
the refusal prints this command with your flags. That file applies to every
Flow Agents install for the user, except one with its own
`.kontourai/telemetry-console.conf` and one pinned local-only (below).
`--global` installs for the other runtimes apply the flags. A
`--telemetry-sink local-files` given to `init --global` for `claude-code` or
`opencode` is accepted, but it records no local-only pin, since those hooks
run from the package's own `scripts/telemetry`; init prints a warning saying so.
The same `init --global` installs also do not apply the Console environment
variables `install-console-config.sh` reads (`FLOW_AGENTS_TELEMETRY_SINK(S)`,
`FLOW_AGENTS_CONSOLE_*`, `CONSOLE_TELEMETRY_*`, `CONSOLE_URL`,
`CONSOLE_TENANT_ID`); init warns on stderr naming the ones that are set and
points to the operator conf, since that script reads them when you write it.

Selecting only `local-files`, with no `--console-*` flag and no Console URL in
the installer's environment, writes no Console settings. When `local-files` is
typed as `--telemetry-sink` (not merely left as the default), the installer
also records `telemetry_sink_pin=local-files` in the installed
`telemetry.conf`, which pins the install local-only. At runtime the
telemetry scripts read exactly one config file: `TELEMETRY_CONFIG_FILE` if
set; otherwise, for a pinned install, the installed `telemetry.conf`;
otherwise a trusted `.kontourai/telemetry-console.conf` in the directory
that contains the `scripts/telemetry/` the hooks run from (the install
destination for project and Codex installs); otherwise a trusted
`~/.flow-agents/telemetry-console.conf`; otherwise the installed
`telemetry.conf`. Trusted means mode 600, owned by the current user, and not a
symlink; an untrusted file is skipped with a warning. The chosen file replaces
the installed `telemetry.conf` entirely. If it sets a Console URL or endpoint,
telemetry is mirrored to that Console even for a `local-files` install, the
economics and liveness relays turn on unless that file sets
`console_economics_relay=0` or `console_liveness_relay=0` (or the environment
already sets `FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY` or
`FLOW_AGENTS_CONSOLE_LIVENESS_RELAY`, for example to `0`), and receipt relay
and board sync use the same Console. To keep one install from sending
telemetry to a Console on a machine with a user-global Console config, install
it with an explicit `--telemetry-sink local-files`. The liveness relay
pre-gate and `telemetry-doctor` follow the same order, and the doctor reports
`localOnlyPinned` and the operator confs the pin skipped. A pinned
`telemetry.conf` supplies no Console URL, token or tenant and no non-loopback
channel endpoint (see "Owner machine mirror" in
[`docs/agent-usage-feedback-loop.md`](../docs/agent-usage-feedback-loop.md)).
Re-running `init` without `--telemetry-sink local-files`, or with a Console
sink, removes the pin, because an unedited installed `telemetry.conf` is reset
to the bundle's copy on every re-run. A `telemetry.conf` edited after install is
preserved with its pin, and the re-run applies no sink to it. Deleting the
`telemetry_sink_pin` line also removes the pin.
Environment variables still apply to a pinned install, so launch the agent host
with no `CONSOLE_*` or `FLOW_AGENTS_CONSOLE_*` variables set; the doctor warns
and names the source when one of them, or `TELEMETRY_CONFIG_FILE`, still
resolves a Console endpoint. For an install
that cannot be pinned (`init --global` for `claude-code` or `opencode`), launch
the agent host with `TELEMETRY_CONFIG_FILE` pointing at a file with no Console
keys.

Run `flow-agents telemetry-doctor --dest PATH --json --headless` to inspect an
installed telemetry configuration. It reports active sinks, local JSONL paths,
Console target settings, and bounded local Console reachability without
prompting. Add `--allow-network` to probe a non-local HTTPS Console endpoint.

## Install And Repo Utilities

- `install-codex-home.sh`: installs the prebuilt Codex bundle shipped in the npm package into `CODEX_HOME` (or `~/.codex`) and portable skills into `$HOME/.agents/skills`; it never compiles TypeScript at install time. Use `--skills-dir PATH` or `FLOW_AGENTS_SKILLS_DIR` to select a hermetic or advanced-user skill catalog independently of the positional runtime destination. Before writing, the installer rejects symlinks and special files anywhere in the shipped Codex tree, copies verified content into a private snapshot, rechecks the source for mutation, and consumes only that snapshot. It reports both resolved roots, preserves user-owned files, migrates only unchanged Flow Agents-owned legacy skills, and refuses symlink destinations rather than creating a compatibility symlink. A missing or corrupt bundle fails with package-reinstall guidance and names `npm run build:bundles` as the source-checkout remediation.
- `setup-repo-hooks.sh`: configures this clone's Git hook path.
- `check-content-boundary.cjs`, `detect-tools.sh`, `discover-agents.sh`, `git-status.sh`: repo-local helper commands.
- `context-budget/` and `statusline/`: specialized support tooling copied into bundles where needed.

## Bundle Policy

`scripts/` is copied into generated bundles intentionally. Do not remove scripts from bundle output only to reduce size unless the corresponding source, generated install behavior, docs, and evals are updated together.

`evals/static/test_universal_bundles.sh` rebuilds bundles and checks the output
shape. It also verifies reproducibility by building the same source into two
fresh output directories and diffing the results. A failure means generated
content is non-deterministic or a bundle build step is carrying stale state.
