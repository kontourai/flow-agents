# Agent Eval Suite Architecture

## Purpose

The eval suite checks whether canonical Flow Agents source and generated bundles still match the behavior promised by agent prompts, routing files, skills, and package conventions. It combines cheap source/package validation with targeted runtime behavior checks.

## Layers

```
Layer 4: Acceptance smoke tests
  Harness-native Kiro, Claude Code, and Codex install/execution checks

Layer 3: Behavioral evals
  promptfoo runs selected agents and scores telemetry plus response quality

Layer 2: Integration checks
  Telemetry contract and bundle install smoke tests

Layer 1: Static checks
  Source validation, package structure, and universal bundle export checks
```

The golden path is:

```bash
bash evals/run.sh static
bash evals/run.sh integration
bash evals/run.sh acceptance
bash evals/run.sh llm <agent>
```

`bash evals/run.sh` runs the fast static and integration gate.

## Behavioral Runtime Flow

```
promptfoo eval
  -> runtime provider, for example lib/kiro-provider.sh or lib/codex-provider.sh
  -> agent invocation
  -> stdout response returned to promptfoo
  -> deterministic telemetry assertions and optional LLM rubrics
```

Key design choices:
- Providers snapshot telemetry before each run so assertions read only new events.
- Deterministic assertions check tool calls, delegation targets, and write-tool constraints.
- LLM rubrics judge workflow quality from response text when telemetry alone is insufficient.
- Kiro wrapper scripts such as `kiro-dev.sh` exist because promptfoo `exec:` providers cannot reliably pass inline environment variables.

## File Structure

```
evals/
├── run.sh
├── static/
│   ├── test_package.sh
│   └── test_universal_bundles.sh
├── integration/
│   ├── test_bundle_install.sh
│   └── test_telemetry.sh
├── acceptance/
│   ├── test_claude_harness.sh
│   ├── test_codex_harness.sh
│   └── test_kiro_harness.sh
├── lib/
│   ├── eval-*.sh
│   ├── kiro-*.sh
│   ├── codex-*.sh
│   └── assertions/
├── cases/
│   └── dev/
├── results/
├── promptfooconfig.yaml
├── ARCHITECTURE.md
├── CONVENTIONS.md
└── README.md
```

## Current Behavioral Suites

### Dev

The `dev` suite covers development workflows such as codebase exploration, planning/execution workflow, dependency review, code review, delivery, search-first behavior, TDD, and verification. Cases live in `evals/cases/dev/promptfooconfig.yaml` with supporting reference YAML files by skill.

### Legacy Combined Config

`evals/promptfooconfig.yaml` remains for manual promptfoo runs across `dev` cases. It should not be treated as the authoritative suite inventory. Prefer `bash evals/run.sh llm <agent>` and per-agent configs under `evals/cases/`.

## Telemetry Boundaries

Captured and usable for deterministic assertions:
- `session.start` / `session.end`
- `turn.user`
- `tool.invoke`
- `tool.result`

Not captured today:
- assistant response events
- loaded resource/skill events
- token usage and cost
- model reasoning between tool calls

Response text is captured from stdout, while behavioral intent is verified from telemetry where possible.

## Coverage Status

Covered now:
- canonical source tree validation
- static package and universal bundle validation
- telemetry contract checks
- generated bundle install smoke tests
- behavioral evals for `dev`

Deferred:
- multi-turn eval cases
- adversarial/red-team eval cases
- behavioral suites for every exported tool agent
- telemetry-based validation of resource loading and token usage

## Grader Taxonomy

| Grader | Implementation | Cost | Use |
|--------|----------------|------|-----|
| Code | JS assertions in `lib/assertions/` | Free | Tool calls, delegation targets, structural constraints |
| Model | `llm-rubric` in promptfoo | LLM cost | Workflow compliance and response quality |
| Human | Report flag | Free | Subjective or security-sensitive review |

Prefer code graders when telemetry can prove the behavior. Use model graders for quality and workflow assertions that require interpreting the response.

## Extending the Suite

1. Create or update `evals/cases/<agent>/promptfooconfig.yaml`.
2. Use an existing provider wrapper from `evals/lib/` or add a thin wrapper for the target agent.
3. Add deterministic assertions for observable telemetry.
4. Add `llm-rubric` assertions only where response quality matters.
5. Run `bash evals/run.sh llm <agent>`.

## Anti-Patterns

- Overfitting prompts to eval wording instead of real behavior.
- Happy-path-only cases with no edge cases.
- Relying on model graders when telemetry can provide a deterministic check.
- Letting docs or combined configs advertise agents, tools, or cases that no longer exist.
