---
title: "ADR 0007: Flow / Skill / Kit / Tool Boundary"
---

> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0007: Flow / Skill / Kit / Tool Boundary

**Date:** 2026-06-15  
**Status:** Accepted

> **Cross-Kit Skill Sharing resolved by [ADR 0019](./0019-kit-dependency-ownership.md) (2026-07-01).** The "Cross-Kit Skill Sharing: DEFERRED" question below is resolved: the npm-dependency-style model (Kit B declares a peer dependency on Kit A and consumes its skills by reference) is adopted at the Flow Agents extension layer via a `kit.json` `dependencies` field. The single-kit-ownership principle recorded here still stands; only the deferral is lifted.

---

## Context

Flow Agents has accumulated ~26 skills. When kits were first introduced, the word "skill" was used loosely for anything the agent knew how to do — from kit-specific workflow procedures to general capabilities (search, browser, dependency scanning) to cross-cutting concerns (agentic engineering principles, context budgeting). That blurred three genuinely different things: the agent's *procedural methods for flow steps*, the *raw capabilities it wields*, and the *containers that package flows with their implementations*.

The boundary became sharper when the Flow Definition container moved to `kontourai/flow` (ADR 0001). Once Flow owns the process contract and Flow Agents owns the agent-facing implementation, a natural question emerges: where does each skill belong, and what is a skill in the first place?

A related accumulation was an informal "general capability skill tier" — skills like `agentic-engineering`, `search-first`, `github-cli`, and `eval-rebuild` that described how the agent uses runtime capabilities, not how it implements a specific flow step. That tier was never designed; it accreted as the skill list grew. It is not a peer design concept alongside Kit-skills; it is an artifact of undifferentiated naming.

This ADR records the conceptual model that was agreed in a design conversation with Brian Anderson on 2026-06-15 and makes it the authoritative reference for future skill placement, kit authoring, and orphan triage.

---

## Decision

### The Four Definitions

#### 1. Flow Definition = the WHAT

A Flow Definition is a process contract: steps, gates, expected evidence, and definition-of-done. It is the container for *what* a workflow accomplishes, not *how* the agent does it.

- Flow Definitions are owned and validated by `kontourai/flow`.
- They are agentless-capable: a CI job or a human can satisfy a flow without an agent, as proven by the agentless gate-eval work (issues #52 and #60).
- Flow Agents *consumes* Flow Definitions; it does not own them (ADR 0001).

#### 2. Skill = the HOW = the *do* of a specific flow step

A skill is the agent's procedural method for accomplishing one step or gate of a flow. Brian's framing: *"skills are the do part of the flow definition."*

Consequences of this definition:

- There is exactly **one kind of skill** in the intended design.
- Every skill is bound to a flow step: it implements the agent's side of that step.
- Every skill belongs to the kit that owns that flow.
- A skill with no flow step behind it is not a skill in this model — it is either a tool, an orphan, or evidence of a missing flow.

The earlier informal "general capability skill tier" was an accreted artifact, not a designed concept. It is not a peer category to Kit-skills. Skills in that tier are reclassified as tools, orphans, or — where a missing flow is strongly implied — candidates for a future kit.

#### 3. Tool = a raw capability the agent wields

A tool is something the agent *uses* to do the work: run bash, read/write files, drive a browser, call `gh`, look up packages, search the web. Tools are:

- Provided by the runtime or harness, not tied to any flow.
- The agent's *hands*, not its *method*.
- Distinct from a skill even when the agent wraps a tool call in a named skill file — if the "skill" is just "here is how to invoke this capability," it is a tool description, not a flow-step method.

A skill that only describes how to use a tool (e.g., `github-cli`, `browser-test`, `eval-rebuild`) belongs in harness documentation or an agent system prompt, not in the `skills/` directory as a first-class skill.

#### 4. Kit = packages a flow with its skills

A kit:

- Owns one or more Flow Definitions.
- Provides the agent-side skills that implement those flows' steps.
- May include store adapters, evals, and docs.

A kit's skills are the agent-side implementation of that kit's flows, in a one-to-one relationship between skills and flow steps (or a small cluster of closely related steps).

### Core Rule

> **A skill that has no flow step behind it is not a Kit-skill.** It is either:
> - (a) a **TOOL** mislabeled as a skill — it describes a raw capability and should live in harness docs or an agent system prompt, or
> - (b) an **ORPHAN** — it is procedural and agent-driven but the flow that would own its step has not been defined yet; it signals a missing or implicit flow, or
> - (c) **scope drift** — it does not belong in this repo's skill layer at all.

### Cross-Kit Skill Sharing: DEFERRED

A question arose during this discussion: can a skill be shared across kits? For example, `knowledge-capture` is implemented as a Knowledge Kit skill (`knowledge.ingest:capture`) but is used as a support step inside Builder Kit flows (e.g., `learning-review` calls `knowledge-capture`).

The sharing model under active consideration is an npm-dependency model: Kit B declares a peer dependency on Kit A and invokes Kit A's skills as a consumer, without absorbing them into Kit B's skill list.

**This alternative is not adopted now.** The cross-kit sharing question is deferred. Until it is resolved:

- Each skill belongs to exactly one kit.
- When a skill is consumed across kits, the consumer kit calls the skill by reference; it does not duplicate or re-own it.
- The audit table in the companion document (`0007-skill-audit.md`) reflects the intended single-kit ownership for each skill.

---

## Consequences

### Immediate Structural Clarity

- The `skills/` directory contains a mix of Kit-skills, tools, and orphans. The audit table in `docs/adr/0007-skill-audit.md` maps each skill to one of those three classifications.
- Skills that are tools (`agentic-engineering`, `browser-test`, `dependency-update`, `eval-rebuild`, `github-cli`, `search-first`) should eventually migrate to agent system prompts, harness context, or be removed from `skills/` entirely. No move is made in this ADR.
- Orphans (`context-budget`, `explore`, `feedback-loop`, `frontend-design`) each implied either a missing flow or a reclassification. All four were ruled on 2026-06-15 (see "Orphan Rulings — 2026-06-15" below); all are REMOVED, with preserved intents recorded.

### Builder Kit Fix (Issue #62) Becomes Mechanical

With this model, the Builder Kit fix discussed in issue #62 is straightforward: every skill in `skills/` that maps to `builder.build` or `builder.shape` steps belongs in the Builder Kit. The audit table provides the exact step-to-skill mapping. The fix is to move those skills into `kits/builder/` — but that move is explicitly out of scope for this ADR. This ADR provides the analysis that makes the move mechanical.

### Tools Are Flow-Agnostic

Runtime-provided tools (`gh`, Playwright, bash, file read/write, package registries) are not skills. They do not belong to flows. The agent wields them as hands while executing flow steps. Packaging them as skills creates false parallelism with Kit-skills and inflates the skill list.

### Orphan Triage Protocol

For each orphan, one of these outcomes is required:

1. **Define the missing flow.** If the orphan describes a coherent procedural method that deserves a kit, define the flow, create the kit, and move the skill.
2. **Reclassify as a tool.** If the orphan is really a description of how to use a raw capability, remove it from `skills/` and fold its content into agent context or harness docs.
3. **Accept scope drift.** If the orphan does not belong in this repo's skill layer, remove it.

No orphan should remain permanently in `skills/` without a documented triage outcome.

### Orphan Rulings — 2026-06-15

Brian ruled on all four orphans on 2026-06-15. All four are **REMOVED** for now; preserved intents are recorded below so the rationale is not lost.

| Orphan Skill | Ruling | Preserved Intent |
| --- | --- | --- |
| `explore` | **REMOVED** — reclassified as a tool: parallel codebase-reading capability. | The original aim was multi-angle codebase capture (dependencies, security, runnability/testability, business logic, patterns). This preserved intent is the seed of a possible future `codebase-onboarding` flow if that capability is ever wanted as a first-class kit flow. |
| `feedback-loop` | **REMOVED** — subsumed. Its "did the change work locally" concern is now handled by `verify-work` plus the flow route-back capability. | No separate preserved intent; the concern is covered. |
| `context-budget` | **REMOVED** — agent self-maintenance; relates conceptually to `learning-review`. Not a flow-step skill. | Conceptually adjacent to `learning-review`; could inform a future self-maintenance flow, but is not a flow-step skill under the current model. |
| `frontend-design` | **REMOVED** for now. | "Plan-work but for UI" — the seed of a possible future UI/Frontend Kit with design + visual-verify steps. Revisit if a UI kit is ever built. |

These rulings do not change this ADR's status. The ADR remains **Proposed** pending Brian's separate confirmation of the whole document.

### Knowledge Kit Boundary

`knowledge-capture` is the one skill in `skills/` that belongs to the Knowledge Kit rather than the Builder Kit. Its canonical flow is `knowledge.ingest:capture`. Its presence in the top-level `skills/` directory (rather than in `kits/knowledge/`) is itself a consequence of the pre-ADR undifferentiated structure. Future kit authoring should place kit skills inside their kit directory.

### Audit Table as Evidence

The companion document `docs/adr/0007-skill-audit.md` is the authoritative mapping of every skill in `skills/` to this model. It provides the evidence base for Builder Kit issue #62 and any future kit migrations.

---

## Alternatives Considered

### Keep the "General Capability Skill Tier" as a Peer Category

Rejected. The general capability tier was never designed — it accreted. Treating it as a first-class category alongside Kit-skills would institutionalize an accident. The model is simpler with exactly one kind of skill.

### Allow Skills to Be Defined Without Flow Binding

Rejected. The whole value of the model is that a skill's purpose, ownership, and location are derivable from its flow step. A skill with no flow binding is undefined in the model — it either needs a flow or needs to be reclassified.

### Cross-Kit Skill Sharing via npm Dependency (DEFERRED)

Not rejected but not adopted now. The npm-dependency model for cross-kit sharing is the most likely future path if skills need to be consumed across kits. It is deferred until a concrete cross-kit case requires it. See "Cross-Kit Skill Sharing: DEFERRED" above.

### Move All Tool-like Skills to Agent System Prompts Immediately

Deferred. The tool-like skills in `skills/` have runtime users. Moving them without updating agent specs and evals would break existing behavior. This ADR records the intended direction; the migrations should be sequenced through backlog issues.

---

## References

- [ADR 0001: Flow Agents Consumes Flow For Workflow Enforcement](./0001-flow-agents-consumes-flow.md) — establishes that Flow owns Flow Definitions and Flow Agents consumes them.
- [ADR 0002: Flow Kits as Extension Unit](./0002-flow-kits-as-extension-unit.md) — establishes the kit as the packaging unit.
- [ADR 0003: Flow Agents Coordinates Kits and Adapters](./0003-flow-agents-coordinates-kits-and-adapters.md) — establishes how Flow Agents relates to kits.
- [docs/adr/0007-skill-audit.md](./0007-skill-audit.md) — companion skill audit table.
- `kits/builder/flows/build.flow.json` — Builder Kit build flow step IDs.
- `kits/builder/flows/shape.flow.json` — Builder Kit shape flow step IDs.
- `kits/knowledge/flows/ingest.flow.json` — Knowledge Kit ingest flow step IDs.
- GitHub issue #62 — Builder Kit skill placement fix (becomes mechanical given this model).
- GitHub issues #52 and #60 — agentless gate-eval work proving Flow Definitions are agentless-capable.
