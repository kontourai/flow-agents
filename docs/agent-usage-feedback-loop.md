---
title: Agent Usage Feedback Loop
---

# Agent Usage Feedback Loop

This document defines the usage feedback loop for comparing agent runs across repositories, runtimes, profiles, prompts, skills, and future setups. The measurement schema is runtime-neutral: every runtime should import or emit normalized session, event, and outcome records before reporting. Codex and Claude Code can both flow through the shared telemetry envelope; Kiro uses the same canonical telemetry script when hooks are installed.

The loop has three parts:

1. Import or read runtime telemetry into normalized usage records.
2. Sync quality outcomes from task artifacts, evals, release gates, or humans.
3. Report usage and outcome metrics by repo, runtime, profile, prompt, skill, or task type.

Quality outcomes are not inferred from raw telemetry alone. The CLI can automatically derive coarse outcomes from task artifacts such as `.kontourai/flow-agents/<slug>/*.md`: `delivered` and `complete` become `success`, `failed` becomes `failure`, and optionally open artifacts can be recorded as `not_verified`. It does not invent `quality_score` or `human_minutes_saved`; those remain human/eval/release-gate facts.

### Malformed input and partial reports

Read-only reports and telemetry-source imports quarantine malformed JSONL records
and continue over valid records. JSON reports expose a `measurement` object with
total, valid, and malformed counts plus content-free diagnostics; Markdown
reports show the same counts under **Measurement State**. The CLI also emits one
stderr warning per affected logical source. Diagnostics include only a logical
source name, line number, SHA-256 content hash, and parse error class. They never
include the malformed record or an absolute path.

This tolerance applies only to source analysis. A destination that an import,
sync, or upsert operation would rewrite remains strict: one malformed existing
record aborts before any write. The command does not silently discard corrupt
state.

## Storage Defaults

Repo-local telemetry defaults to `.telemetry/`:

- `.telemetry/full.jsonl`: raw runtime telemetry events.
- `.telemetry/analytics.jsonl`: summarized analytics emitted by telemetry hooks.
- `.telemetry/sessions/`: per-session runtime artifacts, when the runtime writes them.
- `.telemetry/outcomes.jsonl`: human/eval outcome records for completed work.
- `.telemetry/reports/`: generated Markdown or JSON usage reports.

Locations are configurable. CLI commands should accept `--telemetry-dir`, and shell workflows may set `TELEMETRY_DATA_DIR`. User-level or global Codex telemetry roots, such as `~/.codex/telemetry` or `~/.flow-agents/telemetry`, should be treated as configurable installation choices, not hard-coded truth. When comparing multiple repositories or machines, pass each telemetry root explicitly with repeatable `--telemetry-dir` flags.

Runtime hooks can also mirror redacted telemetry to Console without changing the
event shape. Set `CONSOLE_TELEMETRY_URL=http://127.0.0.1:3737` for a local
Console, or `CONSOLE_URL=https://console.kontourai.io` for a deployed Console.
The transport posts to `/api/telemetry/records` by default. Hosted Console URLs
must use `https://`; `http://` is accepted only for `localhost` or `127.0.0.1`
local development. Use `CONSOLE_TELEMETRY_ENDPOINT_URL` only when the API path
is nonstandard, `CONSOLE_TELEMETRY_TOKEN` or `CONSOLE_AUTH_TOKEN` for bearer
auth, and `CONSOLE_TENANT_ID` for hosted tenant routing. If no Console URL is
set, telemetry remains local-only.

Flow Agents owns the Console telemetry descriptor at `console.telemetry.json`.
Generated bundles include that root descriptor beside `AGENTS.md`, scripts, and
kit assets. The descriptor maps Flow Agents runtime telemetry and workflow
sidecars into generic Console facets for skills, tools, flows, repositories,
projects, runtimes, agents, models, statuses, and outcomes. Console consumes
those mappings as product-owned display metadata; Flow-owned gate and transition
semantics stay in Flow contracts and sidecars. Repository and project metadata
are stable cross-user workspace identifiers when present. Local working-directory
paths stay out of the descriptor so Console display metadata does not expose
usernames or machine-local paths; records without a repository identifier should
fall back to their logical product root such as `product:flow-agents:.kontourai/flow-agents` (the runtime artifact root; #778 corrected the descriptor's own record-source roots to match after they drifted from the `.flow-agents` -> `.kontourai/flow-agents` runtime-root migration).

Packaged setup modes are:

- `local-files`: default local JSONL telemetry only; no Console URL or token.
- `local-kontour-console`: mirror to a separately running local Console, using
  `http://127.0.0.1:3737` unless `FLOW_AGENTS_LOCAL_KONTOUR_CONSOLE_URL` is set.
- `kontour-hosted-console`: mirror to Kontour's hosted Console default URL.
  Pass `--console-token-file` and `--console-tenant` for headless hosted setup.
- `user-hosted-console`: mirror to a self-hosted Console; requires
  `--console-url` or `--console-endpoint`.

Use `flow-agents init --yes` or `--headless` with the same flags in CI. The
legacy sink names `kontour-cloud` and `hosted-kontour-console` are still
accepted for existing scripts.

### Owner machine mirror

For a personal machine or repo where an owner wants Claude Code (or other
runtime) hook sessions mirrored to a hosted Console, without editing the
tracked `scripts/telemetry/telemetry.conf` default template (that file ships
verbatim into every packaged bundle, so writing a personal token/tenant into
it would leak to downstream consumers) and without exporting env vars per
session, `scripts/telemetry/lib/config.sh` auto-discovers a gitignored,
operator-created conf at either of two conventional paths, no extra wiring
required:

1. `<workspace>/.kontourai/telemetry-console.conf` — repo-scoped, checked
   first.
2. `~/.flow-agents/telemetry-console.conf` — machine-scoped, used when no
   workspace-scoped conf is present.

Populate either path with the existing preset installer:
`scripts/telemetry/install-console-config.sh <conf-path> --telemetry-sink
kontour-hosted-console --console-token-file <token-file> --console-tenant
<tenant>`. The installer `chmod 600`s the file, sets it to be owned by the
current user, and never echoes the token. Both conditions matter: config.sh
only honors a discovered conf if it is mode 600 and owned by the current
user, since that combination can only come from an operator running the
installer (or an equivalent manual `chmod 600`) — it distinguishes an
operator-created conf from one that arrived via `git clone`, a tarball, a
PR, or any other supply-chain path, none of which can produce a 600-mode
file. A conf that fails that check is treated as if it were absent (fail
open) and resolution falls through to the next tier.

The explicit `TELEMETRY_CONFIG_FILE` env var still overrides both
auto-discovered paths and always wins. Wiring it from a login-shell profile
(for example `~/.profile` on `bash -l` setups) remains available for exotic
setups that need a config path outside both conventional locations, but is
no longer required for the common case.

Check an installed telemetry setup without opening an interactive prompt:

```bash
flow-agents telemetry-doctor --dest /path/to/installed/flow-agents --json --headless
```

The doctor reads `scripts/telemetry/telemetry.conf`, reports active local and
Console sinks, the resolved local telemetry files, Console URL/endpoint
configuration, and a bounded Console reachability check. JSON output is stable
for CI and setup scripts; a missing or unreachable configured Console makes the
command exit nonzero while still emitting the report. By default, reachability
checks are limited to local endpoints; pass `--allow-network` to probe a
non-local HTTPS Console endpoint explicitly.

## Normalized Records

### Session

A session record represents one agent run after import or aggregation. It should include:

- `schema_version`
- `source_id`
- `repo`
- `repo_root`
- `runtime`
- `runtime_session_id`
- `session_id`
- `agent`
- `model`
- `profile_id`
- `prompt_id`
- `prompt_variant`
- `skill_ids`
- `skill_variant`
- `started_at`
- `ended_at`
- `duration_s`
- `turns`
- `tool_invocations`
- `delegations`
- `permission_requests`
- `imported_at`

### Event

An event record is a runtime-neutral envelope around a runtime event. It keeps report code from depending on Codex-specific names. Runtime adapters can map native event names like `session.start`, `turn.user`, `tool.invoke`, `tool.permission_request`, `agent.delegate`, `session.usage`, and `session.end` into a shared event shape.

### Outcome

An outcome record captures quality and effectiveness facts:

- `schema_version`
- `outcome_id`
- `recorded_at`
- `session_id`
- `runtime_session_id`
- `runtime`
- `repo`
- `agent`
- `profile_id`
- `prompt_id`
- `prompt_variant`
- `skill_ids`
- `skill_variant`
- `task_type`
- `task_slug`
- `result`: `success`, `partial`, `failure`, or `not_verified`
- `quality_score`: `1` through `5`, or null
- `human_minutes_saved`
- `rework_required`
- `notes`
- `evidence`

Do not store sensitive prompt text, tool payloads, secrets, or customer data in outcome records. Use evidence paths or stable identifiers instead.

## Metrics

Recommended reports should include:

- Joined-outcome success rate, with the joined outcome count named as its denominator.
- Joined partial, failure, and not-verified outcome counts.
- Session duration, including total and average duration.
- Tool invocations per session.
- Delegations per session.
- Permission requests per session.
- Joined-outcome rework rate.
- Average quality score from recorded outcomes.
- Human minutes saved from recorded outcomes.
- Sessions with joined outcomes versus sessions without joined outcomes.
- Total, joined, and unjoined outcome records, including content-free unjoined reason counts.

Usage-only metrics can be computed from telemetry. Quality and value metrics require outcome records.
An outcome contributes to quality metrics only when it resolves to exactly one session through a
valid run-correlation ID, an explicit runtime-session ID, or the documented legacy
`{runtime, session_id}` pair, in that precedence order. Missing, invalid, unmatched, and ambiguous
identities remain visible as unjoined records and never contribute to a success or rework claim.
Reports are partial when source records are malformed, outcomes are unjoined, or recorded sessions
lack joined outcome coverage.

## Core Commands

### Project Dashboard

Generate the local HTML dashboard. This syncs terminal task artifacts from `.kontourai/flow-agents` into `.telemetry/outcomes.jsonl` before rendering:

```bash
npm run usage-feedback -- dashboard --force
```

The dashboard is written to `.telemetry/reports/dashboard.html` by default.

Sync artifacts without rendering the dashboard:

```bash
npm run usage-feedback -- sync-artifacts \
  --artifact-dir .kontourai/flow-agents \
  --repo flow-agents \
  --profile-id codex-default \
  --prompt-id deliver-v1 \
  --skill-id deliver
```

Import Codex telemetry from an explicit source and tag it with comparable identifiers:

```bash
npm run usage-feedback -- import-codex \
  --input-telemetry-dir ../repo-a/.telemetry \
  --telemetry-dir .telemetry/repo-a \
  --source-id repo-a \
  --repo repo-a \
  --profile-id codex-builder \
  --prompt-id deliver-v1 \
  --skill-id deliver
```

Import telemetry from any runtime that emits the shared event envelope:

```bash
npm run usage-feedback -- import-telemetry \
  --runtime claude-code \
  --input-telemetry-dir ../repo-b/.telemetry \
  --telemetry-dir .telemetry/repo-b \
  --source-id repo-b \
  --repo repo-b \
  --profile-id claude-dev \
  --prompt-id deliver-v1 \
  --skill-id deliver
```

Record a human or eval outcome for one session:

```bash
npm run usage-feedback -- record-outcome \
  --telemetry-dir .telemetry/repo-a \
  --session-id session-123 \
  --runtime codex \
  --repo repo-a \
  --agent dev \
  --profile-id codex-builder \
  --prompt-id deliver-v1 \
  --skill-id deliver \
  --task-type delivery \
  --task-slug usage-feedback-docs \
  --result success \
  --quality-score 5 \
  --human-minutes-saved 35 \
  --evidence .kontourai/flow-agents/agent-usage-feedback-loop/agent-usage-feedback-loop--deliver.md
```

Generate a report:

```bash
npm run usage-feedback -- report \
  --telemetry-dir .telemetry/repo-a \
  --group-by profile_id \
  --output reports/usage-feedback.md
```

Generate a standalone HTML report without artifact syncing:

```bash
npm run usage-feedback -- report \
  --telemetry-dir .telemetry/repo-a \
  --group-by profile_id \
  --format html \
  --output reports/usage-feedback.html
```

### Global Dashboard

Use a global telemetry root when you want one view across projects. The default global root is `~/.flow-agents/telemetry`.

Register the current project once with stable comparison labels:

```bash
npm run usage-feedback -- register-project \
  --global-dir ~/.flow-agents/telemetry \
  --repo-root "$PWD" \
  --name flow-agents \
  --profile-id codex-default \
  --prompt-id deliver-v1 \
  --skill-id deliver
```

Sync registered projects into the global root:

```bash
npm run usage-feedback -- sync-projects \
  --global-dir ~/.flow-agents/telemetry
```

Render the global dashboard:

```bash
npm run usage-feedback -- global-dashboard \
  --global-dir ~/.flow-agents/telemetry \
  --group-by repo \
  --force
```

The global dashboard writes `~/.flow-agents/telemetry/reports/global-dashboard.html`.

You can also target projects directly without registering them first:

```bash
npm run usage-feedback -- global-dashboard \
  --global-dir ~/.flow-agents/telemetry \
  --repo-root /path/to/project-a \
  --repo-root /path/to/project-b \
  --group-by repo \
  --force
```

Or discover direct child projects under a parent directory:

```bash
npm run usage-feedback -- global-dashboard \
  --global-dir ~/.flow-agents/telemetry \
  --discover ~/dev/github \
  --group-by repo \
  --force
```

Global project stores live under `~/.flow-agents/telemetry/projects/<project>/`. Each project store contains normalized sessions and outcomes, so reports can compare projects, profiles, prompts, and skills from one dashboard.

## Comparison Examples

Compare two repositories:

```bash
npm run usage-feedback -- report \
  --telemetry-dir ../repo-a/.telemetry \
  --telemetry-dir ../repo-b/.telemetry \
  --group-by repo
```

Compare two Codex profiles over the same task family:

```bash
npm run usage-feedback -- report \
  --telemetry-dir .telemetry/codex-default \
  --telemetry-dir .telemetry/codex-bedrock \
  --runtime codex \
  --group-by profile_id
```

Compare prompt variants:

```bash
npm run usage-feedback -- report \
  --telemetry-dir .telemetry/prompt-a \
  --telemetry-dir .telemetry/prompt-b \
  --group-by prompt_variant
```

Compare skill setups:

```bash
npm run usage-feedback -- report \
  --telemetry-dir .telemetry/with-deliver \
  --telemetry-dir .telemetry/with-tdd \
  --group-by skill_id
```

Compare Codex with Kiro or another future runtime after import:

```bash
npm run usage-feedback -- report \
  --telemetry-dir .telemetry/codex \
  --telemetry-dir .telemetry/kiro \
  --group-by runtime
```

The non-Codex runtime must provide or import normalized records with the same session and outcome fields. Codex-specific paths and event names should stay inside the Codex adapter.
