# Scripts Directory

`scripts/` is the public compatibility and shell-runtime surface for Flow Agents. Keep command paths stable unless a migration includes wrappers, docs updates, and bundle/install validation.

## Public Wrappers

These files are stable launchers for TypeScript code compiled under `build/src/`:

| Wrapper | Compiled implementation |
| --- | --- |
| `build-universal-bundles.js` | `build/src/tools/build-universal-bundles.js` |
| `build-docs-preview.js` | `build/src/cli/docs-preview.js` |
| `filter-installed-packs.js` | `build/src/tools/filter-installed-packs.js` |
| `generate-context-map.js` | `build/src/tools/generate-context-map.js` |
| `flow-kit.js` | `build/src/cli.js flow-kit` through package command wiring |
| `pull-work-provider.js` | `build/src/cli.js pull-work-provider` through package command wiring |
| `effective-backlog-settings.js` | `build/src/cli.js effective-backlog-settings` through package command wiring |
| `publish-change-helper.js` | `build/src/cli.js publish-change` through package command wiring |
| `promote-workflow-artifact.js` | `build/src/cli.js promote-workflow-artifact` through package command wiring |
| `usage-feedback.js` | `build/src/cli.js usage-feedback` through package command wiring |
| `validate-source-tree.js` | `build/src/cli.js validate-source` through package command wiring |

If implementation moves, update these wrappers rather than breaking callers.

## Runtime Hooks

`scripts/hooks/` contains runtime hook adapters and policies for Claude Code, Codex, Kiro-style hooks, and repo guardrails. Canonical hook behavior lives here and in TypeScript bundle generation, not in local `.codex/` or `.claude/` installs.

Important groups:

- `claude-*-hook.js` and `codex-*-hook.js`: runtime-specific adapters.
- `workflow-steering.js`, `stop-goal-fit.js`, `quality-gate.js`, `config-protection.js`: policy hooks.
- `hooks/lib/`: shared shell/JavaScript hook helpers.

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
local Console, `--telemetry-sink kontour-cloud` for Kontour's hosted Console, or
`--telemetry-sink hosted-kontour-console --console-url ...` for a self-hosted
Console. `--console-token` and `--console-tenant` can be used with any Console
sink. Prefer `flow-agents init` for a prompted setup; use `--yes` with the same
flags for CI/headless installs.

## Install And Repo Utilities

- `install-codex-home.sh`: installs the isolated generated Codex home.
- `setup-repo-hooks.sh`: configures this clone's Git hook path.
- `check-content-boundary.cjs`, `detect-tools.sh`, `discover-agents.sh`, `git-status.sh`: repo-local helper commands.
- `context-budget/` and `statusline/`: specialized support tooling copied into bundles where needed.

## Bundle Policy

`scripts/` is copied into generated bundles intentionally. Do not remove scripts from bundle output only to reduce size unless the corresponding source, generated install behavior, docs, and evals are updated together.
