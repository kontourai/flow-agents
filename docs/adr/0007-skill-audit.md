---
title: "Skill Audit 2026-06-15: Flow / Skill / Kit / Tool Boundary"
---

# Skill Audit: Flow / Skill / Kit / Tool Boundary

**Date:** 2026-06-15  
**Companion to:** [ADR 0007](./0007-flow-skill-kit-tool-boundary.md)  
**Scope:** All 26 skills in `skills/` — no skills declared inside kit directories were found separate from those already listed here.

---

## Classification Key

| Label | Meaning |
| --- | --- |
| **KIT-SKILL** | The agent's procedural method for one step of a kit-owned flow. Belongs in the kit that owns that flow. |
| **TOOL** | A raw capability the agent wields. Not tied to any flow step. Should be provided by the runtime or harness, not packaged as a "skill." |
| **ORPHAN** | Procedural but no flow step can be cited as the home. Either implies a missing/implicit flow, or signals scope drift. |

Flow step IDs used below are from:

- `kits/builder/flows/build.flow.json` — steps: `pull-work`, `design-probe`, `plan`, `execute`, `verify`, `merge-ready`, `pr-open`, `merge-ready-ci`, `learn`, `done`
- `kits/builder/flows/shape.flow.json` — steps: `shape`, `breakdown`, `file-issues`, `shape-done`
- `kits/knowledge/flows/ingest.flow.json` — steps: `capture`, `classify`, `route`
- `kits/knowledge/flows/compile.flow.json` — steps: `select-raws`, `compile`, `link`
- `kits/knowledge/flows/synthesize.flow.json` — steps: `detect-cluster`, `propose`, `evidence-gate`, `apply-or-reject`
- `kits/knowledge/flows/consolidate.flow.json` — steps: `related-event`, `propose`, `evidence-gate`, `apply-or-reject`
- `kits/knowledge/flows/retire.flow.json` — steps: `identify`, `propose-retirement`, `evidence-gate`, `apply-or-reject`
- `kits/knowledge/flows/store-contract.flow.json` — steps: `verify-contract`

---

## Full Audit Table

| Skill | What It Does | Classification | Kit + Flow Step (if KIT-SKILL) / Rationale (if TOOL or ORPHAN) |
| --- | --- | --- | --- |
| `agentic-engineering` | Principles for eval-first loops, task decomposition (15-minute units), model routing (Haiku/Sonnet/Opus), and session strategy. | TOOL | Documents how to use the agent's cognitive capabilities and model-selection judgment. It is guidance the agent *applies* while using tools, not a method for a specific flow step. It is not tied to any flow or kit. |
| `browser-test` | Delegates browser automation tasks — screenshots, accessibility checks, form filling, UI testing, DOM inspection — to `tool-playwright`. | TOOL | Wraps raw access to a browser automation capability (`tool-playwright`). No flow step backs it; it is a harness/runtime capability the agent directs. Equivalent to "how to run Playwright." |
| `builder-shape` | User-facing entry into the Builder Kit shape flow — invokes `idea-to-backlog` as a primitive and links `kits/builder/flows/shape.flow.json`; stops at the backlog gate unless issue sync is requested. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.shape`. **Step:** `shape` (and through it, `breakdown` and `file-issues` via `idea-to-backlog` delegation). `builder-shape` is the agent's procedural method for satisfying the `builder.shape` flow's entry step. |
| `context-budget` | Audits token overhead across installed Flow Agents bundles; scans components and produces a budget report with per-component breakdown and optimization suggestions. | ORPHAN | Procedural and agent-driven, but there is no flow in any kit that has a step for "audit the agent's own context budget." **Implies missing flow:** an implicit "context-health" or "self-maintenance" flow. Until that flow exists and is owned by a kit, this skill is unanchored. |
| `deliver` | Orchestrates the full plan → execute → review → verify loop, including preflight (pull-work, pickup-probe), looping on failures, and delivery confirmation. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Steps:** orchestrates across `pull-work`, `design-probe`, `plan`, `execute`, `verify`, `merge-ready` in sequence. `deliver` is the agent's top-level orchestration method for the builder build flow. It subsumes multiple build-flow steps and is the primary orchestrator skill for that flow. |
| `dependency-update` | Analyzes and upgrades project dependencies — delegates registry/advisory lookups to `tool-dependencies-updater`, then presents a plan and applies approved updates. | TOOL | Orchestrating a dependency scanner subagent (`tool-dependencies-updater`) is a raw capability use. There is no kit-owned flow with a "dependency-update" step. |
| `design-probe` | Generic one-question-at-a-time alignment interview — turns unclear goals, designs, or workflow states into shared understanding before planning or execution. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Step:** `design-probe`. The skill's own SKILL.md names the Builder Kit `design-probe` step explicitly. It also applies outside Builder Kit, but the canonical flow binding is `builder.build:design-probe`. |
| `eval-rebuild` | Defines project-specific rebuild/reinstall steps for the eval feedback loop so the `eval-builder` agent knows how to rebuild after editing a prompt or skill. | TOOL | This is harness/tooling guidance for how to run evals — a raw capability instruction with no flow step home. It is not a method for any kit-owned step; it is instructions about how the agent's own evaluation tooling works. |
| `evidence-gate` | Evaluates whether completed work has enough trustworthy evidence, scope integrity, and provider/runtime signal to publish, continue fixing, or request a human decision. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Step:** `verify` (the gate evaluation that determines whether the verify step's evidence satisfies the gate claim `builder.verify.tests`). Also maps to `merge-ready` evidence checks. The skill explicitly separates from release-readiness and handles the `verify`-step gate logic. |
| `execute-plan` | Parallel execution primitive — reads a plan artifact, fans out to `tool-worker` subagents in waves, and updates the session artifact between waves. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Step:** `execute`. The skill is the agent's procedural method for the `execute` step of the builder build flow. |
| `explore` | Fans out parallel subagents to map codebase structure, entry points, dependencies, architectural patterns, config, tests, and documentation accuracy in one pass. | ORPHAN | Procedural and multi-wave but there is no kit-owned flow step for "explore a codebase." It is used as a support skill during discovery/shaping and debugging but is not anchored to a specific flow step. **Implies missing flow:** a "codebase-onboarding" or "repository-exploration" flow with an `explore` step, or it belongs as a tool-like capability rather than a flow step skill. |
| `feedback-loop` | Verifies that completed implementation actually works by classifying the change (visual vs. integration) and delegating to the appropriate verification method (Playwright or direct command execution). | ORPHAN | There is no kit-owned flow step called "feedback-loop." It overlaps with the `verify` step of the builder build flow, but its scope is narrower (per-implementation-task confirmation) and it is used as a support skill during `execute-plan`, not as the canonical agent method for the `verify` step. **Implies missing flow:** or this is a tool-like capability (a "quick verify" affordance) that could be subsumed into `verify-work`. |
| `fix-bug` | Bug-fix orchestrator — adds a diagnosis phase (reproduce + root-cause via `tool-planner`), then chains plan → execute → review → verify identical to `deliver`. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Steps:** `design-probe` (root-cause/diagnosis maps to alignment before planning), `plan`, `execute`, `verify`. `fix-bug` is an alternative entry into the builder build flow for defect work; it adds a diagnosis front-end and otherwise implements the same flow steps as `deliver`. |
| `frontend-design` | Delegates frontend implementation to `tool-worker` with curated design guidelines (typography, color, motion, spatial composition, anti-patterns); requires Playwright visual verification after implementation. | ORPHAN | There is no kit-owned flow with a "frontend-design" step. This skill injects design taste into the `execute` step of the builder build flow but is not the canonical method for that step — it is used as a support layer inside `execute-plan`/`deliver`. **Implies missing flow:** a "frontend" or "UI-design" flow with dedicated design and verify steps, or this is more accurately a library of guidelines that the `execute` step (via `execute-plan`) consumes. |
| `github-cli` | Uses the `gh` CLI to interact with GitHub — PRs, issues, repos, releases, Actions, gists, search, and arbitrary API calls. | TOOL | `gh` is a raw capability — a command-line tool the agent wields. The skill is a how-to for operating that tool, not a method for a kit-owned flow step. Used as support across many flow steps without being bound to one. |
| `idea-to-backlog` | Turns raw product or technical ideas into shaped, prioritized, executable GitHub issue backlog through intake, separation, opportunity review, shaping, prioritization, and issue creation. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.shape`. **Steps:** `shape` (idea intake → shaped problem/outcome/constraints/non-goals/success/risk), `breakdown` (slices and thinnest meaningful slices), `file-issues` (creating GitHub issues with provider-neutral metadata). `idea-to-backlog` is the primary agent method that implements all three active steps of `builder.shape`. |
| `knowledge-capture` | Saves durable knowledge, pointers, decisions, lessons, corrections, and source references into the knowledge base using pointer or curated-knowledge modes. | KIT-SKILL | **Kit:** knowledge. **Flow:** `knowledge.ingest`. **Step:** `capture` (the first step of `knowledge.ingest`: capture raw text → produce a raw record). This skill is the agent's method for the `capture` step of the knowledge ingest flow. |
| `learning-review` | Captures post-merge/post-deploy/post-incident learnings and routes them back to backlog, workflow skills, tests, docs, or knowledge; includes correction telemetry and a verdict. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Step:** `learn`. The skill is the agent's method for the `learn` step of the builder build flow: turn delivery outcomes into durable learning and follow-up routing. |
| `pickup-probe` | Builder Kit specialization of the `design-probe` flow step — records scope, provider state, WIP/conflict scan, revision freshness, decisions, unresolved questions, accepted gaps, and planning readiness for selected backlog work. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Step:** `design-probe` (the `pickup-probe` skill is explicitly described in its SKILL.md as "the Builder Kit pickup specialization of the `design-probe` flow step"). It implements the `design-probe` step for the productized pickup path. |
| `plan-work` | Planning primitive — delegates codebase analysis and execution plan creation to `tool-planner`; produces a plan artifact, `acceptance.json`, and `handoff.json`. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Step:** `plan`. The skill is the agent's method for the `plan` step of the builder build flow. |
| `pull-work` | Selects ready GitHub issues from the backlog, enforces WIP limits, checks dependencies, determines worktree isolation, and hands selected work to planning. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Step:** `pull-work`. The skill is the agent's method for the `pull-work` step of the builder build flow. |
| `release-readiness` | Decides whether evidence-backed work is ready to merge, release, deploy, or hold — checks committed/pushed state, provider change record, CI/checks, rollback plan, observability, and docs; produces a structured release decision. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Steps:** `merge-ready` and `merge-ready-ci`. The skill implements the agent-facing logic for both merge readiness gates: it consumes evidence-gate output, checks operational and CI state, and produces a merge/release/deploy/hold decision. |
| `review-work` | Report-only critique primitive — delegates to `tool-code-reviewer`, `tool-security-reviewer`, and optionally `tool-dependencies-updater`; records findings through the `critique.json` artifact/sink. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Step:** `verify` (review is part of the verify gate's quality checks) or more precisely as an intermediate step between `execute` and the formal `verify` gate. The SKILL.md describes it as a gate that must be satisfied before verification. Mapped to: between `execute` and `verify` in `builder.build`. |
| `search-first` | Research-before-coding workflow — searches the codebase, package registries, GitHub, and web in parallel; evaluates candidates; and decides to adopt, extend, or build before writing code. | TOOL | This is a research/lookup methodology, not the agent's method for a specific flow step. It is used as a support behavior across multiple steps (shaping, planning, execution) without being anchored to one. It could be seen as a harness capability (web + registry search). |
| `tdd-workflow` | TDD orchestrator — wraps plan → execute → review → verify with test-first constraints, git checkpoints (RED/GREEN/REFACTOR), and a coverage gate (>= 80%). | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Steps:** `plan`, `execute`, `verify`. `tdd-workflow` is an alternative parameterization of the builder build flow that enforces test-first discipline across those three steps. |
| `verify-work` | Verification primitive — delegates to `tool-verifier` and `tool-playwright`; maps evidence to acceptance criteria; updates `evidence.json` and `acceptance.json`. | KIT-SKILL | **Kit:** builder. **Flow:** `builder.build`. **Step:** `verify`. The skill is the canonical agent method for the `verify` step. |

---

## Summary Counts

| Category | Count | Notes |
| --- | --- | --- |
| **KIT-SKILL (builder kit)** | 17 | `builder-shape`, `deliver`, `design-probe`, `evidence-gate`, `execute-plan`, `fix-bug`, `idea-to-backlog`, `learning-review`, `pickup-probe`, `plan-work`, `pull-work`, `release-readiness`, `review-work`, `tdd-workflow`, `verify-work`, `knowledge-capture` (builder-side consumer), `fix-bug` (builder alt-entry) |
| **KIT-SKILL (knowledge kit)** | 1 | `knowledge-capture` implements `knowledge.ingest:capture` |
| **TOOL** | 6 | `agentic-engineering`, `browser-test`, `dependency-update`, `eval-rebuild`, `github-cli`, `search-first` |
| **ORPHAN** | 4 | `context-budget`, `explore`, `feedback-loop`, `frontend-design` |

Note: `knowledge-capture` appears in both the builder-kit count above and the knowledge-kit count. The canonical home is the Knowledge Kit (`knowledge.ingest:capture`); its use inside builder flows is as a support dependency.

Corrected final count:

- **KIT-SKILL:** 17 total — 16 belonging to the builder kit (across `builder.build` and `builder.shape` flows), 1 belonging to the knowledge kit (`knowledge.ingest:capture`)
- **TOOL:** 6
- **ORPHAN:** 4

---

## Orphans With "Implies Missing Flow" Detail

| Orphan Skill | Implication | Disposition |
| --- | --- | --- |
| `context-budget` | Implies missing flow: a "context-health" or "agent-self-audit" flow. No kit currently owns context-budget management as a named flow. This could eventually become a `builder.context-audit` or standalone kit flow. Alternatively, if the repo decides context budgeting is always a harness concern, this should be reclassified as a TOOL and the skill dissolved or folded into harness documentation. | **REMOVED** (2026-06-15). Agent self-maintenance; not a flow-step skill. Conceptually adjacent to `learning-review`; preserved intent noted in ADR 0007. |
| `explore` | Implies missing flow: a "codebase-onboarding" or "repository-exploration" flow with discrete steps (structure, entry points, dependencies, patterns, docs accuracy). Alternatively, `explore` is a multi-step capability the agent uses across many flow phases — in which case it is more accurately a TOOL (raw codebase-reading capability orchestrated across subagents) than a flow-step skill. | **REMOVED** (2026-06-15). Reclassified as a tool (parallel codebase-reading capability). Preserved intent: seed of a possible future `codebase-onboarding` flow — see ADR 0007. |
| `feedback-loop` | Implies missing flow: or more precisely, it overlaps with the `verify` step of `builder.build` without being the canonical method for it. The skill is used as a lightweight per-task verification inside `execute-plan`. If the builder build flow added a sub-step or explicit "local-verify" step between `execute` and the formal `verify` gate, `feedback-loop` would map there. Otherwise, it should be subsumed into `verify-work` or reclassified as support tooling. | **REMOVED** (2026-06-15). Subsumed: concern now handled by `verify-work` plus flow route-back. |
| `frontend-design` | Implies missing flow: a "frontend" or "UI-kit" flow with steps for design direction, implementation, and visual verification. Alternatively, the design guidelines could be packaged as a context resource injected into `execute-plan`/`tool-worker` rather than as a separate "skill." If it stays a skill, it belongs in a hypothetical UI Kit that owns a `frontend.build` flow with design and verify steps. | **REMOVED** (2026-06-15). Preserved intent: "plan-work but for UI" — seed of a possible future UI/Frontend Kit with design + visual-verify steps. Revisit if a UI kit is built. |

---

## Implementation Record (Issue #62, 2026-06-15)

The dispositions in this audit table were implemented in PR #62:

- **16 KIT-SKILLS moved to Builder Kit:** `builder-shape`, `deliver`, `design-probe`, `evidence-gate`, `execute-plan`, `fix-bug`, `idea-to-backlog`, `learning-review`, `pickup-probe`, `plan-work`, `pull-work`, `release-readiness`, `review-work`, `tdd-workflow`, `verify-work` — moved from `skills/<name>/` to `kits/builder/skills/<name>/` and declared in `kits/builder/kit.json` `skills` array.
- **1 KIT-SKILL moved to Knowledge Kit:** `knowledge-capture` — moved to `kits/knowledge/skills/knowledge-capture/` and declared in `kits/knowledge/kit.json` `skills` array.
- **4 ORPHANS deleted:** `context-budget`, `explore`, `feedback-loop`, `frontend-design` — removed per Brian's 2026-06-15 ruling above.
- **6 TOOLs left in place:** `agentic-engineering`, `browser-test`, `dependency-update`, `eval-rebuild`, `github-cli`, `search-first` — remain in `skills/` pending separate reclassification. See `skills/README.md`.

**Structural changes:**
- `src/tools/build-universal-bundles.ts`: `collectAllSkills()` function added; bundle builders now collect skills from both `skills/` (tool-skills) and kit-declared `skills` arrays. Runtime bundles (`.claude/skills/`, `.codex/skills/`, etc.) include all kit-owned skills unchanged.
- `src/tools/generate-context-map.ts`: `allSkillPaths()` function added; context map generation now includes kit-owned skills.
- `src/tools/validate-source-tree.ts`: `validateLegacyRefs()` updated to skip legacy-ref matches that resolve as declared kit-owned asset subpaths.
- The legacy `packaging/` pack-composition manifest (since removed): at the time of this audit, its skill entries were limited to the 6 remaining tool-skills in `skills/`, and kit-owned skills were already excluded (they ship as kit assets). That whole composition layer was later removed outright; the standalone `skills/`/`agents/`/`powers/` base always installs and Kits carry depth through the Kit Catalog.
- `flow-agents kit inspect kits/builder` now reports `k1: true` (skills present).
- `flow-agents kit inspect kits/knowledge` now reports `k1: true` (skills present).
