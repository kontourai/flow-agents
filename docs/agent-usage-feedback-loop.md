# Agent Usage Feedback Loop

This document defines the usage feedback loop for comparing agent runs across repositories, runtimes, profiles, prompts, skills, and future setups. The measurement schema is runtime-neutral: every runtime should import or emit normalized session, event, and outcome records before reporting. Codex and Claude Code can both flow through the shared telemetry envelope; Kiro uses the same canonical telemetry script when hooks are installed.

The loop has three parts:

1. Import or read runtime telemetry into normalized usage records.
2. Sync quality outcomes from task artifacts, evals, release gates, or humans.
3. Report usage and outcome metrics by repo, runtime, profile, prompt, skill, or task type.

Quality outcomes are not inferred from raw telemetry alone. The CLI can automatically derive coarse outcomes from task artifacts such as `.agents/flow-agents/<slug>/*.md`: `delivered` and `complete` become `success`, `failed` becomes `failure`, and optionally open artifacts can be recorded as `not_verified`. It does not invent `quality_score` or `human_minutes_saved`; those remain human/eval/release-gate facts.

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

- Success rate.
- Partial, failure, and not-verified rates.
- Session duration, including total and average duration.
- Tool invocations per session.
- Delegations per session.
- Permission requests per session.
- Rework rate.
- Average quality score from recorded outcomes.
- Human minutes saved from recorded outcomes.
- Sessions with outcomes versus sessions without outcomes.

Usage-only metrics can be computed from telemetry. Quality and value metrics require outcome records.

## Core Commands

### Project Dashboard

Generate the local HTML dashboard. This syncs terminal task artifacts from `.agents/flow-agents` into `.telemetry/outcomes.jsonl` before rendering:

```bash
npm run usage-feedback -- dashboard --force
```

The dashboard is written to `.telemetry/reports/dashboard.html` by default.

Sync artifacts without rendering the dashboard:

```bash
npm run usage-feedback -- sync-artifacts \
  --artifact-dir .agents/flow-agents \
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
  --profile-id codex-kdev \
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
  --profile-id codex-kdev \
  --prompt-id deliver-v1 \
  --skill-id deliver \
  --task-type delivery \
  --task-slug usage-feedback-docs \
  --result success \
  --quality-score 5 \
  --human-minutes-saved 35 \
  --evidence .agents/flow-agents/agent-usage-feedback-loop/agent-usage-feedback-loop--deliver.md
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
