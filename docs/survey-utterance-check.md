---
title: Survey Utterance Check Integration
---

# Survey Utterance Check Integration

Flow Agents can optionally check agent utterances for evidence coverage using `@kontourai/survey`. This integration is disabled by default and intentionally optional — ordinary Flow Agents workflows do not require Survey.

The guiding rule mirrors the Veritas boundary: Flow Agents owns the hook wiring and badge guidance format; Survey owns the extraction, claim resolution, and trust report semantics.

## Background: ADR 0003 §9

ADR 0003 §9 designates agent-utterance extraction as a **Survey producer profile** — Survey pointed at agent prose instead of web sources. Each factual statement in agent output is extracted as a candidate claim and run through Survey's Inquiry pipeline. Flow Agents supplies the enforcement point (hooks) that ADR 0003 calls out. This integration is step 6 of the ADR sequencing and depends on the Inquiry pipeline already existing in Survey.

## User-Facing Story

```text
Agent: "The test coverage for auth-service is 92%. All critical paths have been verified."

Flow Agents (hook active):
1. Captures the agent's response text from the PostToolUse event.
2. Invokes the utterance-check CLI adapter with the response text.
3. @kontourai/survey extracts factual statements: coverage:92%, paths:verified.
4. Survey resolves each statement against the configured trust bundle.
5. Statements without matching claims resolve as "unsupported".
6. Flow Agents injects badge guidance into the agent context:
   UTTERANCE CHECK: 2 statement(s) lack evidence coverage.
   - [unsupported] "test coverage for auth-service is 92%"
   - [unsupported] "All critical paths have been verified"
```

The agent sees honest gap disclosure rather than silent pass-through.

## Ownership Split

| Area | Flow Agents Owns | Survey Owns |
| --- | --- | --- |
| Hook wiring | PostToolUse/Stop hook, badge guidance format, enable/disable flags | None |
| Extraction | Invoking the CLI adapter | Statement extraction, extractor interface |
| Resolution | Passing the trust bundle path | Inquiry pipeline, claim resolution |
| Output | Guidance text injected into agent context | UtteranceTrustReport with per-statement badges |
| Packaging | Optional hook activation, CLI adapter | @kontourai/survey npm package |

Flow Agents does not own trust claim models, inquiry semantics, or extractor implementations. Survey's `referenceUtteranceExtractor` is the default extractor; production use should inject `createAnthropicUtteranceExtractor` from `@kontourai/survey/anthropic` for model-backed extraction.

## Enabling the Hook

The hook is disabled by default. Set environment variables before starting the agent session:

```bash
export FLOW_AGENTS_UTTERANCE_CHECK_ENABLED=true

# Optional: path to a trust bundle JSON file for claim resolution
export FLOW_AGENTS_UTTERANCE_CHECK_BUNDLE_PATH=/path/to/trust-bundle.json

# Optional: agent identifier for provenance
export FLOW_AGENTS_UTTERANCE_CHECK_AGENT_ID=my-codex-session

# Optional: strict mode — blocks Stop when concerning badges are present
export FLOW_AGENTS_UTTERANCE_CHECK_STRICT=true
```

The hook runs through the standard `run-hook.js` runner and respects `SA_DISABLED_HOOKS` and `SA_HOOK_PROFILE`.

## CLI Adapter Contract

The utterance check CLI is available as:

```bash
node build/src/cli.js utterance-check check \
  --utterance "The coverage is 92% and all tests pass." \
  --bundle-path .surface/trust-bundle.json \
  --agent-id my-session
```

Options:

```
  --utterance TEXT      Utterance text to check (required unless --not-configured).
  --bundle-path FILE    Trust bundle JSON file. Omit for an empty bundle (all unsupported).
  --agent-id ID         Agent identifier for provenance (default: flow-agents-utterance-check).
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
| --- | --- |
| `verified` | Matched a claim with verified status |
| `assumed` | Matched a claim with assumed status |
| `stale` | Matched a claim that is stale |
| `disputed` | Matched a claim with conflicting evidence |
| `rejected` | Matched a claim that was rejected |
| `unsupported` | No matching claim in the trust bundle |

Exit codes: `0` = pass, `1` = survey unavailable, `2` = strict mode with concerning badges, `3` = usage error.

When `@kontourai/survey` is not installed, the CLI outputs `status: "not_configured"` and exits `1`. The hook treats `not_configured` as a silent pass-through.

## Registering the Hook

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

## Installing @kontourai/survey

The CLI adapter uses a dynamic import so flow-agents itself does not list `@kontourai/survey` as a dependency. Install it in the target workspace:

```bash
npm install @kontourai/survey
```

For model-backed extraction (production-quality, requires `@anthropic-ai/sdk`):

```bash
npm install @kontourai/survey @anthropic-ai/sdk
```

Then inject the Anthropic extractor by extending the CLI adapter or creating a wrapper script that calls `surveyAgentUtterance` with `createAnthropicUtteranceExtractor`.

## Non-Goals

- Do not make `@kontourai/survey` a mandatory dependency of flow-agents.
- Do not copy Survey's extraction or inquiry schemas into flow-agents.
- Do not auto-register the hook in the default pack; it is opt-in only.
- Do not make the hook blocking without explicit `--strict` / `FLOW_AGENTS_UTTERANCE_CHECK_STRICT=true`.
- Do not silently decide anything. The hook injects guidance; the agent decides next steps.

## Current Integration Shape

The integration delivers:

1. `src/cli/utterance-check.ts` — TypeScript CLI adapter. Accepts utterance text, optional bundle path, and agent ID. Dynamically imports `@kontourai/survey`. Outputs a JSON badge report to stdout and human-readable guidance to stderr. Mirrors the `veritas-governance` adapter pattern.

2. `scripts/hooks/utterance-check.js` — CJS hook script. PostToolUse/Stop, non-blocking by default. Reads agent output text from the hook event, invokes the CLI adapter when `FLOW_AGENTS_UTTERANCE_CHECK_ENABLED=true`, and injects badge guidance into the agent context. Always fails open.

The forward path (out of scope for this slice):

- Register the hook in a dedicated `survey` pack for opt-in activation.
- Support injecting the Anthropic extractor via `FLOW_AGENTS_UTTERANCE_CHECK_EXTRACTOR=anthropic`.
- Surface badge results as evidence sidecar entries (linking utterance coverage to workflow evidence).
- Auto-propose new claim mappings from unsupported statements via the Survey mapping proposer.

Survey source and API details: https://github.com/kontourai/survey
