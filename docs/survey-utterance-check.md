---
title: Survey Utterance Check Integration
---

# Survey Utterance Check Integration

When an agent says something factual — "test coverage is 92%", "the API is backward-compatible", "no breaking changes in this release" — that claim either has evidence behind it or it doesn't. The utterance check feature bridges Flow Agents hooks to `@kontourai/survey` so that every factual statement in an agent response is compared against a trust bundle and tagged with a badge. Statements with no backing evidence are flagged inline so the agent can acknowledge the gap rather than assert silently.

This document explains how to enable and configure the feature, what the workflow looks like end to end, and what to watch out for.

---

## What actually happens

Here is a concrete walkthrough from agent response to badge guidance:

```
Agent says: "The test coverage for auth-service is 92%.
             All critical paths have been verified."

Flow Agents hook (PostToolUse):
  1. Captures the agent response text from the PostToolUse event.
  2. Invokes the utterance-check CLI with the response text and your trust bundle.

@kontourai/survey (inside the CLI):
  3. Extractor splits the response into factual statements:
       - "test coverage for auth-service is 92%"
       - "All critical paths have been verified"
  4. Each statement is resolved against the trust bundle.
  5. Neither statement has a matching verified claim → both resolve as "unsupported".

Flow Agents hook injects guidance into the agent context:
  UTTERANCE CHECK: 2 statement(s) in this response lack evidence coverage.
  Summary: unsupported:2
    - [unsupported] "test coverage for auth-service is 92%"
    - [unsupported] "All critical paths have been verified"
  Evidence note: unsupported = no matching claim in the trust bundle; ...
```

The agent sees honest gap disclosure rather than silent pass-through. It can then cite sources, note the gap explicitly, or record a coverage claim via `@kontourai/survey`.

---

## Deciding between report and strict mode

The hook has two modes:

| Mode | Effect |
|------|--------|
| `report` (default) | Appends badge guidance to the agent context. Never blocks. Agent decides next step. |
| `strict` | If any statement is `unsupported`, `disputed`, or `rejected`, the hook exits 2, which routes the Stop event back to the agent for revision. |

Use **report** when you want visibility without gate behavior — good for exploratory sessions, onboarding, or repos where the trust bundle is still being built out. Use **strict** when you want the agent to revise or cite sources before completing a turn — appropriate for regulated workflows, production deployments, or repos with a well-populated bundle.

The empty-bundle caveat: if you enable the hook without a `bundlePath`, every factual statement the extractor finds will resolve as `unsupported` because there are no claims to match against. In strict mode this means every response with factual statements will be blocked. Make sure you either provide a `bundlePath` or use report mode until you have a bundle.

---

## The trust bundle

The trust bundle is a JSON file with a `claims` array. It is the authoritative record of what is considered evidenced for your codebase. Two practical sources:

- **Veritas-generated bundle**: if your repo uses `@veritas/veritas`, it can produce a `trust.bundle.json` from `.veritas/evidence`. Point `bundlePath` at that output.
- **Surface report**: the `@kontourai/surface` package can generate a trust bundle from a surface verification run. If your repo runs surface checks, look for the generated bundle in the surface output directory (e.g. `dist/trust-bundle.json` or a named artifact).
- **Hand-authored bundle**: a minimal bundle is just `{ "claims": [] }`. Add claims incrementally as you record evidence.

An empty or missing bundle means everything is unsupported. That is not necessarily wrong — it is an honest starting state — but it is only useful in report mode.

---

## Choosing an extractor

The extractor is responsible for splitting the agent utterance into discrete factual statements. Two are available:

| Extractor | How it works | Requirements |
|-----------|-------------|--------------|
| `reference` (default) | Pattern-based heuristics. Fast, no API call, no key needed. Works offline. Lower recall on complex prose. | `@kontourai/survey` installed |
| `model` | Flow Agents' model-backed producer over Relay. The same prompt, schema, parser, and Survey projection run through a local harness or hosted runtime. | `@kontourai/survey` plus the selected runtime |

For most exploratory use, `reference` is sufficient. Switch to `model` when the reference extractor misses statements that matter for your domain.

The `model` extractor fails open when its runtime is not configured. Local profiles use an installed and authenticated harness; the hosted `anthropic` profile uses `ANTHROPIC_API_KEY`. The CLI reports `not_configured` rather than silently substituting a different runtime.

Each `--runtime` uses `PROFILE:MODEL`. Supported profiles are `claude-code`, `codex`, `opencode`, and hosted `anthropic`. Repeat the option for ordered fallback. Multiple candidates, an attempt ceiling, or receipt persistence opt into Dispatch; one candidate otherwise invokes Relay directly.

Native structured output is the default requirement. OpenCode currently uses prompt-enforced JSON and is rejected unless `--allow-prompted-structured-output` is explicit. `--max-attempts` limits attempts, and `--receipt-path` appends secret-free terminal Dispatch receipts as NDJSON.

---

## Per-repo configuration

The canonical way to enable utterance checking is a `context/settings/flow-agents-settings.json` file in the consumer repo. This is a peer to `context/settings/backlog-provider-settings.json` — the same directory, the same convention.

**Minimal example (report mode, reference extractor):**

```json
{
  "$schema": "../../node_modules/@kontourai/flow-agents/schemas/flow-agents-settings.schema.json",
  "schema_version": "1.0",
  "utteranceCheck": {
    "enabled": true,
    "mode": "report",
    "extractor": "reference"
  }
}
```

**With a trust bundle and a local runtime:**

```json
{
  "$schema": "../../node_modules/@kontourai/flow-agents/schemas/flow-agents-settings.schema.json",
  "schema_version": "1.0",
  "utteranceCheck": {
    "enabled": true,
    "mode": "report",
    "extractor": "model",
    "bundlePath": ".veritas/trust.bundle.json",
    "runtimes": ["claude-code:sonnet"],
    "agentId": "surface-agent"
  }
}
```

**Strict mode:**

```json
{
  "$schema": "../../node_modules/@kontourai/flow-agents/schemas/flow-agents-settings.schema.json",
  "schema_version": "1.0",
  "utteranceCheck": {
    "enabled": true,
    "mode": "strict",
    "extractor": "model",
    "runtimes": ["codex:gpt-5"],
    "bundlePath": "dist/trust-bundle.json"
  }
}
```

Config field reference:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Whether utterance checking is active for this repo. |
| `mode` | `"report"` \| `"strict"` | `"report"` | How to handle concerning badges. See above. |
| `extractor` | `"reference"` \| `"model"` | `"reference"` | Extractor to use. See above. |
| `bundlePath` | string | — | Repo-relative or absolute path to the trust bundle JSON. Omit to use an empty bundle. |
| `runtimes` | string[] | — | Ordered `PROFILE:MODEL` candidates for the model extractor. |
| `allowPromptedStructuredOutput` | boolean | `false` | Explicitly permit prompted structured output for profiles without native schema enforcement. |
| `agentId` | string | `"flow-agents-hook"` | Agent identifier for provenance in the trust report. |

---

## Environment variable overrides

For one-off sessions or CI pipelines, you can override the config with environment variables. These take precedence over `flow-agents-settings.json`.

| Variable | Effect |
|----------|--------|
| `FLOW_AGENTS_UTTERANCE_CHECK_ENABLED=true\|false` | Force the hook on or off, overriding the config `enabled` field. |
| `FLOW_AGENTS_UTTERANCE_CHECK_STRICT=true` | Force strict mode. |
| `FLOW_AGENTS_UTTERANCE_CHECK_BUNDLE_PATH=/path/to/bundle.json` | Override `bundlePath`. |
| `FLOW_AGENTS_UTTERANCE_CHECK_AGENT_ID=my-agent` | Override `agentId`. |
| `FLOW_AGENTS_UTTERANCE_CHECK_EXTRACTOR=model\|reference` | Override `extractor`. |
| `FLOW_AGENTS_UTTERANCE_CHECK_RUNTIMES=codex:gpt-5,opencode:zai/glm-5` | Override ordered runtime candidates. |
| `FLOW_AGENTS_UTTERANCE_CHECK_ALLOW_PROMPTED=true` | Permit prompted structured output. |

**When the config file is absent and no env vars are set**, the hook is disabled. This is the safe default — existing repos are not affected until they opt in.

---

## Registering the hook

Add the utterance check to a Claude Code session via `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/hooks/claude-hook-adapter.js PostToolUse post:utterance-check utterance-check.js standard,strict"
          }
        ]
      }
    ]
  }
}
```

Or run the hook directly (Kiro/Codex convention, exit 2 blocks):

```bash
node scripts/hooks/run-hook.js post:utterance-check utterance-check.js standard,strict
```

The hook reads `context/settings/flow-agents-settings.json` relative to the repo root it detects from the hook event `cwd` or `process.cwd()`. No configuration needed in the hook command itself.

---

## CLI reference

The utterance check CLI is available as:

```bash
node build/src/cli.js utterance-check check \
  --utterance "The coverage is 92% and all tests pass." \
  --bundle-path .veritas/trust.bundle.json \
  --extractor model \
  --runtime claude-code:sonnet \
  --agent-id my-session
```

Options:

```
  --utterance TEXT      Utterance text to check (required unless --not-configured).
  --bundle-path FILE    Trust bundle JSON file. Omit for an empty bundle (all unsupported).
  --agent-id ID         Agent identifier for provenance (default: flow-agents-utterance-check).
  --extractor NAME      'reference' (default) or 'model'.
  --runtime PROFILE:MODEL  Ordered runtime candidate; repeat for fallback.
  --allow-prompted-structured-output  Permit lower-fidelity prompted JSON.
  --max-attempts N      Dispatch attempt ceiling (defaults to candidate count).
  --receipt-path FILE   Append secret-free terminal Dispatch receipts as NDJSON.
  --not-configured      Skip survey call; output not_configured without error.
  --strict              Exit non-zero when any badge is disputed, rejected, or unsupported.
  --help                Show this help.
```

The CLI outputs a JSON report to stdout:

```json
{
  "status": "ok",
  "agent_id": "my-session",
  "utterance_excerpt": "The coverage is 92% and all tests pass.",
  "statements": [
    {
      "excerpt": "coverage is 92%",
      "badge": "unsupported",
      "target": {
        "subjectType": "unknown",
        "subjectId": "coverage",
        "fieldOrBehavior": "is"
      }
    }
  ],
  "summary": "unsupported:2"
}
```

Badge values:

| Badge | Meaning |
|-------|---------|
| `verified` | Matched a claim with verified status. |
| `assumed` | Matched a claim with assumed status. |
| `stale` | Matched a claim that is stale. |
| `disputed` | Matched a claim with conflicting evidence. |
| `rejected` | Matched a claim that was rejected. |
| `unsupported` | No matching claim in the trust bundle. |

Exit codes: `0` = pass or model runtime not_configured (fail open), `1` = Survey unavailable, `2` = strict mode with concerning badges, `3` = usage error.

---

## Installing dependencies

The CLI adapter uses dynamic imports so flow-agents itself does not list `@kontourai/survey` as a dependency. Install in the target workspace:

```bash
# Reference extractor only (default)
npm install @kontourai/survey

# Model-backed hosted extractor
npm install @kontourai/survey
```

---

## Ownership split

| Area | Flow Agents owns | Survey owns |
|------|-----------------|-------------|
| Hook wiring | PostToolUse/Stop hook, badge guidance format, config loading | None |
| Extraction | Producer prompt/schema/parsing, runtime injection, extractor selection, fail-open handling | Framework-neutral extractor interface and review projection |
| Resolution | Passing the trust bundle path | Inquiry pipeline, claim resolution |
| Output | Guidance text injected into agent context | UtteranceTrustReport with per-statement badges |
| Config | Per-repo `flow-agents-settings.json`, env var overrides | None |

Flow Agents owns this producer implementation but does not own trust claim models or inquiry semantics. Relay owns the model-runtime port and provider adapters; Dispatch owns routing, attempt budgets, fallback, and terminal receipts. Survey receives normalized statements and owns framework-neutral review behavior.

---

## Non-goals

- Do not make `@kontourai/survey` a mandatory dependency of flow-agents.
- Do not copy Survey's extraction or inquiry schemas into flow-agents.
- Do not auto-register the hook in the standalone base; it is opt-in only.
- Do not make the hook blocking without explicit `mode: "strict"` or the env override.
- Do not silently decide anything. The hook injects guidance; the agent decides next steps.

---

## Current integration shape

The integration delivers:

1. `src/cli/utterance-check.ts` — TypeScript CLI adapter. Accepts utterance text, optional bundle path, agent ID, extractor name, and runtime-selection options. Dynamically imports `@kontourai/survey`. Outputs a JSON badge report to stdout and human-readable guidance to stderr.

2. `scripts/hooks/utterance-check.js` — CJS hook script. PostToolUse/Stop, non-blocking in report mode. Reads per-repo policy from `context/settings/flow-agents-settings.json`, uses env vars as overrides. Resolves repo root from hook event `cwd`. Always fails open.

3. `schemas/flow-agents-settings.schema.json` — JSON Schema for the per-repo settings file.

Survey source and API details: https://github.com/kontourai/survey
