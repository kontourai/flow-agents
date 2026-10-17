# Flow Agents Eval Suite

Evaluation coverage for the canonical Flow Agents source tree and generated universal bundles.

## Quick Start

```bash
npm install

# Run the fast local gate: source validation, static package checks, integration checks
bash evals/run.sh

# Run only source/static checks
bash evals/run.sh static

# Run only integration checks
bash evals/run.sh integration

# Run harness-native acceptance checks
bash evals/run.sh acceptance

# Claude acceptance is cheap by default. Opt in to prompt-mode Claude usage only when needed.
FLOW_AGENTS_ACCEPTANCE_CLAUDE_LLM=1 bash evals/run.sh acceptance claude

# Run behavioral evals through the default Kiro runtime
bash evals/run.sh llm

# Run one behavioral suite through Codex as subject runtime and judge
bash evals/run.sh llm dev --runtime codex

# Run Claude Code as the subject runtime while Codex judges rubrics
bash evals/run.sh llm dev --runtime claude --judge-runtime codex

# Run cheaper behavioral subsets
bash evals/run.sh llm dev --suite smoke
bash evals/run.sh llm dev --suite regression

# View promptfoo results
npm run promptfoo:view
```

## Layers

### Layer 1: Static (`bash evals/run.sh static`)

Validates the source tree and generated bundle exports:
- canonical source validation via `npm run validate:source --`
- package shape, schemas, resources, hooks, routing, MCP server references, write-tool invariants, and agent cards
- universal bundle build/export checks for Kiro, Claude Code, and Codex

Runs in seconds and has no LLM cost.

### Layer 2: Integration (`bash evals/run.sh integration`)

Validates runtime-adjacent contracts:
- telemetry event schemas, type mapping, field presence, prompt capture, tool capture, redaction, and agent discovery
- workflow artifact quality and deterministic end-to-end delivery chain fixtures
- bundle install smoke tests for Kiro, Claude Code, and Codex temp installs

Runs in seconds and has no LLM cost.

### Layer 3: Behavioral (`bash evals/run.sh llm`)

Runs selected agents through an eval runtime and scores responses with deterministic telemetry assertions plus LLM rubrics. Kiro is the default subject runtime. Pass `--runtime codex` or `--runtime claude` to run Codex or Claude Code where supported.

Subject runtime and judge runtime are separate:

```bash
bash evals/run.sh llm dev --runtime claude --judge-runtime codex
bash evals/run.sh llm dev --runtime claude --judge-runtime claude
```

Use `--suite smoke`, `--suite regression`, or `--suite capability` to avoid running the full behavioral suite when a targeted gate is enough. `smoke` runs the first few cases, `regression` filters `metadata.type=regression`, and `capability` filters `metadata.type=capability`.

Current behavioral suites:
- `dev`

The root `evals/promptfooconfig.yaml` is a legacy combined promptfoo config for targeted manual runs. Prefer `bash evals/run.sh llm <agent>` or the per-agent configs in `evals/cases/<agent>/promptfooconfig.yaml`.

### Layer 4: Acceptance (`bash evals/run.sh acceptance`)

Runs harness-native smoke tests against generated bundles:
- `Claude Code` discovers workspace agents and can answer through `dev`
- `claude` lists project agents and verifies exported telemetry hook configuration without model usage by default
- `codex exec` loads the exported `.codex` bundle and returns a final response

This layer is environment-dependent and requires installed, authenticated CLIs.

Claude prompt-mode acceptance is opt-in with `FLOW_AGENTS_ACCEPTANCE_CLAUDE_LLM=1`. Real Claude CLI hook telemetry assertions are opt-in with `FLOW_AGENTS_ACCEPTANCE_REQUIRE_CLAUDE_TELEMETRY=1`; deterministic integration tests cover the telemetry wrapper without spending Claude usage.

## Coverage

Covered now:
- source/package drift and bundle export drift
- telemetry schema and redaction contracts
- install smoke tests for generated bundles
- normalized telemetry for Kiro, Codex, and Claude Code hook events
- behavioral routing and workflow checks for the supported per-agent suites

Deferred:
- multi-turn conversation evals
- adversarial/red-team evals
- behavioral coverage for every exported tool agent
- full LLM-driven end-to-end delivery runs on every edit; deterministic artifact-chain E2E coverage runs in integration
- direct token usage assertions, because CLI-backed exec providers do not expose reliable token counts today

## Adding Eval Cases

Add behavioral cases to `evals/cases/<agent>/promptfooconfig.yaml`. Each test should include:
- `vars.prompt` with the user prompt
- `options.provider.id` or suite default provider
- deterministic assertions when telemetry can prove the behavior
- an `llm-rubric` for workflow quality when needed
- `metadata.type` set to `capability` or `regression`

Run the affected suite with:

```bash
bash evals/run.sh llm <agent>
```

## Prerequisites

- `jq` for static and integration checks
- `Claude Code` for default behavioral and Kiro acceptance checks
- `codex` for `--runtime codex`, `--judge-runtime codex`, and Codex acceptance checks
- `claude` for `--runtime claude`, `--judge-runtime claude`, and Claude Code acceptance checks
- `promptfoo` for behavioral evals and result viewing, installed with `pnpm install --frozen-lockfile` from the repo root. Promptfoo 0.124.1 requires Node >=22.22; this tooling requirement is separate from the published Flow Agents runtime's Node >=22 baseline.

The credential-free compatibility check is `node --test evals/integration/promptfoo-offline.test.mjs`.
It runs the installed CLI with repository custom assertions, deterministic passing and failing
cases, isolated telemetry files, disabled Promptfoo telemetry, and blocked external connections.
Metadata-client checks use a loopback fixture, including missing-resource and missing-header
refusals. These checks exercise config and JSON result compatibility; they do not qualify real
cloud/model providers or optional multimodal inference.

Dependency security follow-up remains on #1135/#931, with metadata-chain ownership on #967
and Socket.IO ownership on #708. The scoped refresh removes brace-expansion 2.1.2 and
ws 8.20.1 and updates Promptfoo's direct Sharp path to 0.35.5. Optional
`@huggingface/transformers@4.2.0 -> sharp@0.34.5` remains vulnerable; denied install scripts
do not make its prebuilt native binary unreachable. Public transformers 4.3.1 can accept
Sharp 0.35.x, but its ONNX/tokenizer changes require separate multimodal qualification under
#1135/#931. No native scripts are enabled or cross-major override applied here.
The full pnpm audit still reports findings; this is a bounded remediation,
not closure of those issues. The production-only audit improved from 11 high and 9 moderate
findings to zero in this lockfile snapshot; it does not qualify all development tooling.
Compatible transitive refreshes also remove findings in parser, HTTP, archive, and proxy
packages without changing the published direct runtime dependency declarations.
Remaining development paths are owned by #1135/#931:

| Path | Remaining constraint or qualification gap |
| --- | --- |
| transformers 4.2.0 -> Sharp 0.34.5 / ONNX -> adm-zip, protobufjs, sprintf-js | Multimodal parent migration and native inference are unqualified. |
| optional IBM SDK -> axios 1.18.0 | SDK core 5.9.1 publicly pins axios 1.20.0; the existing optional peer still resolves core 5.5.0 and needs a qualified peer refresh. |
| proxy-agent -> get-uri 8.0.1 -> basic-ftp 5.3.1 | Current public get-uri still requires 5.x; the advisory fix starts at 6.2.1. No compatible parent fix found. |
| jks-js 1.1.7 -> node-forge 1.4.0 | Current public parent still selects the affected version; the advisory publishes no patched version. |

These are retained findings, not approved exceptions or exploitability determinations.
The pinned Traverse/Lookout
reference migration remains deferred under #1513; its existing exact-version and refusal
checks must continue to pass.
