---
title: Integration Examples
---

# Integration Examples

Flow Agents reaches host runtimes and agent frameworks through two distinct distribution models. This section provides worked examples for each model and a guide to the conformance kit for third-party adapter authors.

## Distribution models at a glance

**Harness runtimes** ship as self-contained bundles under `dist/<runtime>/`. The `npm run build:bundles` command generates each bundle from the canonical manifest and policy scripts. `flow-agents init` (or the dogfood variant) places the generated files at the host-expected paths inside a target workspace. Claude Code, Codex, Kiro, opencode, and pi are harness adapters.

**Framework adapters** live in `integrations/<name>/` as language-native packages. They register Flow Agents callbacks with the framework's lifecycle system using the framework's native registration API. `integrations/strands/` is the reference implementation: `flow-agents-strands` is a Python `HookProvider` that wires into AWS Strands Agents without requiring the Strands SDK at import time.

**Third-party adapters** self-certify by running the conformance kit in `packaging/conformance/`. The kit provides golden fixtures and a runner that pipes each fixture through the adapter command and reports per-level verdict.

## Conformance levels

| Level | What is required |
| --- | --- |
| L0 | Telemetry only — at least `agentSpawn` fires on session start |
| L1 | L0 plus workflow steering and stop-goal-fit in warning mode |
| L2 | L1 plus config protection (blocking) and quality gate — the reference level |

Claude Code and Codex are L2 reference implementations. opencode is L1 (no prompt-submit hook). pi is L1 (no stop hook). The Strands adapter is L0 plus config protection via `BeforeToolCallEvent` cancellation.

The <a href="../spec/runtime-hook-surface.html">Runtime Hook Surface spec</a> defines the canonical event taxonomy, policy classes, conformance levels, and engine contract in full.

## Pages in this section

<div class="doc-grid">
  <a class="doc-card" href="harness-install.html">
    <strong>Harness Install</strong>
    <span>Worked example installing into a Claude Code project, and the two newest runtimes: opencode and pi. Includes the dogfood variant and scope-collision warning behavior.</span>
  </a>
  <a class="doc-card" href="framework-adapter.html">
    <strong>Framework Adapter</strong>
    <span>Worked example based on <code>integrations/strands/</code>: constructing FlowAgentsHooks, telemetry emitted, the engine-contract binding for policy, and documented limitations.</span>
  </a>
  <a class="doc-card" href="conformance.html">
    <strong>Conformance</strong>
    <span>How a third-party adapter self-certifies: the engine contract 1.0, running the conformance runner, what each level requires, and how to declare gaps.</span>
  </a>
  <a class="doc-card" href="../spec/runtime-hook-surface.html">
    <strong>Runtime Hook Surface Spec</strong>
    <span>Canonical event taxonomy, four policy classes, conformance levels L0/L1/L2, mapping tables, and the engine contract for adapter authors.</span>
  </a>
</div>
