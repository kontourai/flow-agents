---
title: "ADR 0011: MCP Posture — Enforcement Stays Hooks; Surface Owns MCP Projection; No Auto-Injected Config"
---

# ADR 0011: MCP Posture

**Date:** 2026-06-24
**Status:** Accepted (decided with Brian Anderson, 2026-06-24).

---

## Context

Flow Agents integrates with agent runtimes through two mechanisms: **hooks** (PostToolUse
capture, Stop gate, SessionStart — deterministic, automatic, can block) and a **CLI**
(`workflow-sidecar` — operations the agent invokes: `init-plan`, `record-evidence`,
`advance-state`, `current`, `render-trust-panel`). The question arose whether Flow Agents
should also expose an **MCP** surface — and specifically how to surface a workflow's
**trust report inline in the conversation** by leveraging Surface's existing MCP-UI trust
panel (`buildTrustPanelUiResource`, `ui://surface/trust-panel/…`).

Two facts shaped the decision:

- MCP tools are **agent-invoked** — the agent *chooses* to call them; they cannot be forced
  and cannot block.
- Surface **already** exposes an MCP server (`surface mcp`) whose tools re-derive a trust
  report from a trust input and return the MCP-UI panel.

## Decision

### 1. Enforcement stays hooks. MCP never carries the gate.

The gate (`stop-goal-fit` blocking) and capture (PostToolUse) are deterministic runtime
**interception** — they fire automatically and exit non-zero to block. MCP tools are
agent-invoked and cannot intercept or block. **MCP therefore cannot carry Flow Agents'
differentiator (deterministic teeth); enforcement remains hooks.** Any MCP surface is
*additive* to — never a replacement for — hooks.

### 2. Trust-surfacing in-conversation = consume Surface's MCP; do not build our own.

Flow Agents **produces** `.flow-agents/<slug>/trust.bundle`; **Surface's MCP projects** it
to the MCP-UI trust panel. Flow Agents writes **zero MCP code** (consume-never-fork; Surface
owns projection). Ingestion uses Surface's **per-call `path`** argument (the skill passes the
active task's bundle, resolved from `current.json`), **not** a static `--input` set at server
launch — a single static input cannot follow a session's many per-task bundles or its moving
"current." A directory / `current`-aware Surface ingestion is the cleaner long-term shape,
but that is **Surface's** design to evaluate (kontourai/surface#95) — not something Flow
Agents hacks around.

### 3. Never auto-inject MCP config into files we do not own.

Registering an MCP server edits runtime config (Claude Code `.mcp.json`, Codex equivalent)
that belongs to the **user**, not Flow Agents. **Hooks are core** to Flow Agents' function
(justified to write); **MCP-surfacing is optional sugar** (must not be force-injected).
Therefore:

- **Default — zero writes:** the installer *documents/prints* the exact `surface mcp`
  registration snippet; the user adds it if they want it.
- **Convenience — explicit, reversible opt-in:** a `flow-agents trust:mcp enable|disable`
  command writes a **fenced managed block** (`# BEGIN flow-agents (managed) … # END`) — easy
  to enable, trivial to remove. Never on plain install. Tracked in flow-agents#137.

### 4. A Flow Agents *invocation* MCP is a separate, deferred decision.

Flow Agents *could* expose its workflow operations as MCP **tools** — valuable for **reach**
(MCP hosts without shell access, e.g. claude.ai web) and first-class, discoverable
operations. But an **MCP-only host gets invocation without enforcement** (no hooks) — a
**capped conformance tier** (invoke-without-enforce ranks below hook-enforce in the L0/L1/L2
model). This is a larger architecture decision, **not adopted here**; recorded as a future
possibility gated on a real need for non-shell reach.

## Consequences

- Trust-in-conversation is **opt-in and boundary-pure** — Surface owns the MCP + the UI;
  Flow Agents produces the bundle and (optionally, with consent) points Surface at it.
- The **local HTML projection (`render-trust-panel`, #135) stays the no-config default**;
  MCP-surfacing is the opt-in upgrade.
- Flow Agents' config posture is explicit: **core (hooks) writes; optional (MCP) is
  documented / opt-in / reversible.**
- The `surface mcp --input` ingestion is referred to Surface for evaluation (kontourai/surface#95).

## Alternatives Considered

- **Auto-inject Surface's MCP on install.** Rejected: edits config Flow Agents does not own,
  for optional sugar; surprising and hard to cleanly remove.
- **Build an MCP-UI trust panel in Flow Agents.** Rejected: forks Surface's
  `buildTrustPanelUiResource` and requires standing up an MCP server (consume-never-fork
  violation).
- **Replace hooks with MCP tools.** Rejected: MCP is agent-invoked and cannot block — it
  cannot carry deterministic enforcement.
- **Static `--input` for trust ingestion.** Rejected for Flow Agents' use: cannot follow
  per-task bundles or a moving current; use per-call `path`. The exposure itself is referred
  to Surface (kontourai/surface#95).

## References

- [ADR 0010: Workflow Trust State as a Hachure Trust Bundle](./0010-workflow-trust-state-as-hachure-bundle.md) — the bundle this surfaces; #135 (`render-trust-panel` local projection).
- `@kontourai/surface` `src/commands/mcp.ts` (`surface mcp --input`, per-call `path`, `buildTrustPanelUiResource`).
- kontourai/surface#95 — evaluate `surface mcp --input` ingestion exposure.
- flow-agents#137 — opt-in `trust:mcp` wiring command.
