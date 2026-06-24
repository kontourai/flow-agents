---
title: Flow Agents North Star
---

# Flow Agents North Star

Flow Agents is the agent-facing vertical of Kontour Flow. It makes agents more reliable than they are out of the box by surrounding them with just-in-time guidance, scoped capabilities, durable context, Flow-backed workflow enforcement, evidence gates, and self-improving feedback loops.

The long-term goal is not to build another agent runtime, coding assistant, workflow engine, or orchestration control plane. Flow Agents should compose open standards, Kontour Flow, Kontour Veritas, and portable runtime conventions into a coherent system that works across coding, knowledge work, meetings, sales contexts, research, operations, and personal productivity.

## Product Promise

Flow Agents should help an agent do the right thing even when:

- the context window is crowded
- the conversation has drifted
- the user request is underspecified
- the agent is overconfident
- tools are numerous or risky
- prior work needs to be resumed
- verification evidence is missing
- the user does not know which specialized workflow to invoke

The system earns trust by reducing the amount of agent behavior that depends on a perfect prompt, perfect memory, or perfect model output.

## Design Principles

### Standards First

Use existing standards before inventing new formats:

- `AGENTS.md` for project instructions
- Agent Skills / `SKILL.md` for reusable capabilities
- MCP for tools, resources, prompts, and integrations
- OpenAPI for HTTP APIs
- OAuth/OIDC for delegated access
- JSON Schema for Flow Agents-owned machine-readable artifacts
- OpenTelemetry GenAI conventions for traces and metrics
- SARIF for code, security, and review findings
- CycloneDX and SLSA for supply chain and provenance workflows
- iCalendar, JSContact, JMAP, WebVTT/SRT, CommonMark, and JSON-LD where they fit knowledge and communication workflows

Flow Agents should only invent a format when no durable standard or Kontour foundation product fits. Generic process enforcement belongs in Flow. Repo-local development governance belongs in Veritas. Any Flow Agents-owned format must be small, schema-described, human-inspectable, versionable, and exportable.

### Progressive Disclosure

Do not load the whole operating manual into every session.

Flow Agents should expose small discovery metadata first, then load guidance only when it is useful. Skills, powers, workflow contracts, context bundles, and references should be activated just in time.

### Reliability Over Ceremony

Workflow gates are valuable only when they improve outcomes.

Small tasks should stay lightweight. Larger or riskier tasks should gain more structure: planning, acceptance criteria, sandbox decisions, verification, Flow gate evidence, Veritas repo readiness when relevant, release checks, and learning capture.

### User Simplicity, System Depth

The user should not need to know whether the system used a rule, skill, power, subagent, memory lookup, workflow contract, or telemetry artifact.

Flow Agents should preserve a simple user experience while making the underlying behavior more disciplined.

### Safe Autonomy

Autonomy should increase only inside appropriate boundaries.

Flow Agents should distinguish local read-only work, local edits, git worktrees, containers, cloud sandboxes, and privileged integrations. Risky tools need explicit scope, clear ownership, and evidence that the result was checked.

### Evidence Beats Confidence

Flow Agents should prefer verifiable evidence over agent self-assessment.

Important work should end with concrete proof: tests, lint, browser checks, runtime checks, CI, screenshots, trace evidence, review findings, or explicit `NOT_VERIFIED` gaps.

### Learning Loops

Every repeated failure, correction, successful pattern, or quality outcome should have a path back into the system.

Learning may update rules, skills, prompts, evals, docs, telemetry dashboards, backlog items, or knowledge notes. The system should improve without relying on hidden memory alone.

## Operating Layers

Flow Agents should converge toward a small set of clear layers.

| Layer | Purpose | Preferred Standards |
| --- | --- | --- |
| Rules | Persistent guidance and constraints | `AGENTS.md`, Markdown, frontmatter |
| Skills | Reusable task procedures | Agent Skills / `SKILL.md` |
| Powers | Tools plus activation guidance | MCP, OpenAPI, OAuth/OIDC |
| Agents | Specialized roles with scoped tools | Harness-native subagents, A2A where useful |
| Workflows | Durable state, gates, and handoffs | Kontour Flow, JSON Schema, Markdown summaries |
| Knowledge | People, orgs, meetings, decisions, notes | JSContact, iCalendar, JMAP, CommonMark, JSON-LD |
| Evidence | Traces, evals, findings, provenance | OpenTelemetry, SARIF, CycloneDX, SLSA |

These layers should be understandable independently and composable together.

## Global-On Behavior

Flow Agents should be useful as a global companion, not just a project-local coding tool.

For development work, it should help with exploration, planning, implementation, review, verification, delivery, dependency hygiene, and release confidence.



For personal productivity, it should help route requests into the right workflow, remember durable preferences in inspectable form, and keep scheduled or recurring work from depending on prompt recall.

## What Flow Agents Owns

Flow Agents does not need to own the model, runtime, IDE, agent UI, calendar store, CRM, inbox, workflow engine, process transparency kernel, or repo governance engine.

Flow Agents owns the glue:

- discovery of relevant context and capabilities
- activation of the right guidance at the right time
- scoped delegation to tools and subagents
- Flow-backed workflow state and gate enforcement inside agent harnesses
- evidence-backed completion
- feedback loops that make the next run better
- portable exports across agent harnesses

Flow owns generic process transparency: steps, gates, transitions, Flow Runs, exceptions, continuation, and Flow Reports. Veritas owns repo-local development governance: repo standards, requirements, evidence checks, change guidance, and merge readiness. Flow Agents packages those foundations into useful agent modes, skills, provider settings, runtime adapters, hooks, and Console views.

## Success Criteria

Flow Agents is working when:

- users get better outcomes without writing better prompts
- agents recover from context drift instead of compounding it
- workflow state survives long sessions and context compaction
- tools are available without overwhelming the context window
- risky work is isolated or gated
- completed work has evidence, not just a confident summary
- recurring corrections become system improvements
- standards-based artifacts can move across Codex, Claude Code, Kiro, and future harnesses
- Flow and Veritas evidence can be surfaced without making users learn their internal product vocabularies

The system should feel simple at the surface because the complexity has been organized underneath it.

## Roadmap

This roadmap turns the north star above into incremental work.

The goal is not to add ceremony. The goal is to make agents more reliable while keeping the user experience simple: users ask for outcomes, and Flow Agents supplies the right context, capabilities, tools, checks, and learning loops just in time.

### Progress Checklist

| Status | Workstream | Target Outcome |
| --- | --- | --- |
| [x] | North star | Durable direction documented in `docs/north-star.md`. |
| [x] | Layer taxonomy | Repo vocabulary clearly separates rules, skills, powers, agents, workflows, knowledge, and evidence. |
| [x] | Neutral base vs Kit depth | The standalone `skills/`/`agents/`/`powers/` base always installs; opinion and depth live in Flow Kits surfaced through the Kit Catalog and activated on demand. |
| [x] | Standards register | Supported standards and Flow Agents-owned formats are documented with adoption rules. |
| [ ] | Structured workflow state | Draft schemas, contracts, validation, explicit current-session identity, delegation-safe agent event logs, sidecar writer commands, and direct workflow-skill writer instructions exist for state, acceptance, evidence, handoff, critique, release, and learning; automatic enforcement remains partial. |
| [ ] | Context map | Generated repo/context map exists; workflow steering and core planner/worker/verifier agents now use it, but broader agent coverage remains. |
| [ ] | JIT guidance | Stop hook checks sidecars; workflow steering reads `state.json`, `critique.json`, context-map availability, and high-risk state after non-subagent tools; the opt-in utterance evidence-check hook (ADR 0003 §9) badges unsupported agent statements via Survey; broader file/task-aware guidance remains. |
| [x] | Sandbox policy | `context/contracts/sandbox-policy.md` and https://github.com/kontourai/flow-agents/blob/main/docs/sandbox-policy.md classify local read-only, local edit, worktree, container, cloud sandbox, and privileged integration modes. |
| [ ] | Evidence integration | Evidence sidecars now carry `standard_refs` for SARIF, OpenTelemetry, JUnit/TAP, Veritas, and custom proof; a local Veritas readiness wrapper records native Veritas reports as optional evidence; utterance trust reports from `@kontourai/survey` cover agent statements. |
| [ ] | Feedback loop | Runtime telemetry, outcomes, evals, and recurring corrections feed back into docs, skills, rules, or backlog. |
| [ ] | Export validation | Codex, Claude Code, and Kiro exports preserve the same operating layers and now install telemetry, Goal Fit, and workflow steering hook wiring; adapter output, installed-command coverage, Claude live hook influence, and Kiro live strict-stop coverage exist. |

### Now / Next / Later

Use this as the pickup list for future sessions.

| Priority | Work | Exit Signal |
| --- | --- | --- |
| Now | Hook influence evals | `evals/fixtures/hook-influence/cases.json` validates expected agent behavior after hook guidance, and runtime gaps are explicit instead of implied. |
| Now | Self-validation loop | Each Flow Agents change creates or resumes a workflow artifact, then uses `dogfood-pass` when checks and critique are ready to record evidence, critique, state, handoff, and optional learning follow-ups. |
| Now | Guidebook UX | The GitHub Pages guidebook explains the system with examples, diagrams, and “user says / Flow Agents does” framing. |
| Now | Veritas spike | Run Veritas readiness through the governance adapter boundary and record native output as Flow Agents evidence without taking a dependency. |
| Next | Runtime upgrades | Upgrade documented hook-influence gaps when Codex or Kiro expose post-tool hook guidance as model context in live harnesses. |
| Later | Automatic learning proposals | Detect repeated workflow friction from telemetry/evidence and propose rule, skill, eval, doc, backlog, or knowledge updates. |
| Later | Broader file-aware JIT guidance | Surface task/file-specific guidance before risky edits, not only after sidecar state indicates a problem. |

## Phase 1: Clarify The System Shape

**Purpose:** Make Flow Agents easy to understand before adding more machinery.

Tasks:

- Document the public layers: rules, skills, powers, agents, workflows, knowledge, and evidence. **Done:** see https://github.com/kontourai/flow-agents/blob/main/docs/operating-layers.md.
- Mark which directories are canonical source, generated exports, runtime state, and optional integrations.
- Separate the neutral standalone base (always installed) from opinionated depth in Flow Kits. **Done:** the `skills/`/`agents/`/`powers/` base always ships; Kits carry depth through the Kit Catalog.
- Add a standards register that lists each external standard, how Flow Agents uses it, and what Flow Agents-owned schemas still exist. **Done:** see https://github.com/kontourai/flow-agents/blob/main/docs/standards-register.md.
- Add a "do not invent without checking standards" rule to contributor docs.

Exit criteria:

- A new contributor can explain where to put persistent guidance, a reusable skill, an MCP integration, workflow state, evidence, or knowledge notes.
- The default mental model has fewer top-level concepts than the current repo surface.

## Phase 2: Make Workflow State Durable

**Purpose:** Preserve reliability when context windows are full, sessions are resumed, or agent output quality drifts.

Tasks:

- Define JSON Schemas for workflow state, acceptance criteria, evidence, handoff, critique, release readiness, and learning records. **Done:** draft schemas exist under `schemas/`.
- Keep Markdown artifacts as human summaries, but make JSON sidecars the machine-readable source for gates.
- Update `plan-work`, `execute-plan`, `verify-work`, `evidence-gate`, and `release-readiness` to read and update the sidecars. **Started:** `npm run workflow:sidecar --` provides a reusable writer for plan, state, evidence, critique, release, and learning records, and core workflow skills now direct agents to use it when available.
- Make sidecar writes serialized or conflict-aware so concurrent critique/evidence updates cannot overwrite each other during parallel self-validation. **Started:** `npm run workflow:sidecar --` takes a per-artifact lock around writer commands.
- Add validation to `npm run workflow:validate-artifacts --`.
- Add eval fixtures for context-compaction and long-session recovery.

Exit criteria:

- A workflow can resume from artifacts without relying on the model remembering prior turns.
- Goal Fit, evidence status, and next action can be read mechanically.
- Multiple agents can share one workflow root by resolving `.flow-agents/current.json` and appending agent-local events instead of racing on root state.

## Phase 3: Add Just-In-Time Guidance

**Purpose:** Give the agent small, relevant guidance at the moment it matters.

Tasks:

- Generate a compact context map for each repo: structure, commands, test strategy, key conventions, recent workflow state, and available Kits. **Started:** `npm run context-map --` writes `docs/context-map.md` and supports drift checks.
- Extend hooks so they can surface file-specific, workflow-specific, or evidence-specific guidance without loading whole docs. **Started:** workflow steering now emits ambient reminders after non-subagent tools when sidecars show `not_verified`, `needs_decision`, `blocked`, `failed`, or `needs_user`.
- Add skill discovery metadata that lets agents choose a skill from a short summary, then progressively load the body.
- Add missing-evidence prompts: when a workflow is about to stop without proof, show the specific gate that failed. **Started:** the Goal Fit stop hook now reads `state.json`, `evidence.json`, and `critique.json` to report unfinished phase, next action, failed checks, `NOT_VERIFIED` gaps, and open critique findings.
- Extend stop hooks to require sidecars in strict mode. **Started:** `FLOW_AGENTS_REQUIRE_SIDECARS=true` makes the Goal Fit hook block missing or invalid sidecars; `FLOW_AGENTS_REQUIRE_CRITIQUE=true` also requires a passing critique record.
- Keep guidance output short enough to be useful inside a degraded or crowded context window.

Exit criteria:

- Agents receive targeted reminders before risky edits, before stopping, and when proof is missing.
- Routine tasks do not carry the full operating manual in prompt context.
- Codex, Claude Code, and Kiro exports install equivalent Goal Fit and workflow-steering hooks for the same workflow state.
- Claude Code, Codex, and Pi-compatible extension paths expose the loaded workflow and progress in runtime status surfaces where the host supports them.
- Hook evals prove guidance is delivered through each runtime's hook protocol. Live harnesses prove Claude Code responds to prompt-submit workflow guidance and Kiro surfaces strict Stop gates; Codex `exec` currently remains covered by installed-command and protocol evals rather than live hook-context injection.
- Hook-influence behavioral cases define what the agent must do after receiving guidance and classify evidence as installed-command, live-acceptance, or documented-runtime-gap.

## Phase 4: Evidence And Governance

**Purpose:** Replace agent confidence with proof and make recurring mistakes self-correcting.

Tasks:

- Map Flow Agents telemetry and workflow evidence toward OpenTelemetry GenAI conventions.
- Define how lint, review, security, and policy findings can emit SARIF or SARIF-like summaries.
- Add a governance/evidence adapter point so an external tool can enforce repo-local rules. **Started:** see `context/contracts/governance-adapter-contract.md`.
- Prototype optional Veritas integration for development workflows. **Next:** keep the integration on the governance adapter contract and implement any reusable bridge as TypeScript, not as a repo-specific Python wrapper.
- Decide which checks belong in Flow Agents itself and which should be delegated to Veritas or other tools.
- Keep the user-facing boundary in the Veritas Integration Boundary:
  https://github.com/kontourai/flow-agents/blob/main/docs/veritas-integration.md

Exit criteria:

- Evidence can answer: what changed, what proof ran, what failed, what is not verified, and what should happen next.
- Governance checks can be introduced without baking repo-specific policy into Flow Agents core.

## Phase 6: Self-Improving Loop

**Purpose:** Turn repeated usage into system improvement.

Tasks:

- Normalize runtime telemetry, workflow evidence, eval outcomes, and human quality feedback into one reporting model.
- Identify recurring failures: missing tests, premature stopping, wrong skill choice, context drift, bad tool use, weak handoffs, or stale knowledge.
- Route findings into the right improvement target: rules, skills, powers, evals, docs, backlog, or knowledge notes.
- Add promotion gates so guidance becomes stricter only after evidence shows it helps.
- Make dashboards answer whether Flow Agents is improving outcomes over time.
- Dogfood the workflow artifacts on Flow Agents changes: each substantial pass should produce sidecars, run artifact validation, delegate critique, update durable docs, and route accepted critique into the next slice. **Started:** `npm run workflow:sidecar -- dogfood-pass` records evidence, required critique, optional release readiness, optional learning, state, and handoff in one fail-closed validated pass.
- Automatically create or select the current session artifact so self-validation does not depend on the user or orchestrator hand-picking `.flow-agents/<slug>`. **Started:** `npm run workflow:sidecar -- ensure-session` creates or selects a delivery session artifact plus initial state, acceptance, and handoff sidecars.

Exit criteria:

- The system can show which guidance is working, which rules are noisy, and which failures keep recurring.
- Improvements are reviewable and not hidden in opaque memory.

## Veritas Fit Assessment

`~/dev/github/kontourai/veritas` appears strongly aligned with the evidence and governance parts of the north star.

Veritas already provides:

- repo-local adapters, repo standards, and authority settings
- lint-style feedback designed for agents
- just-in-time `explain` guidance
- evidence records with JSON Schemas
- evidence checks and verification budgets
- advisory readiness runs and eval history
- governance blocks for AI instruction files
- agent-agnostic activation through repo-local artifacts, hooks, and CI

That overlaps with Flow Agents' desired evidence layer, but it should not be folded in blindly.

Recommended stance:

- Treat Veritas as a first-class optional integration candidate, not a vendored subsystem.
- Use Veritas for repo-local development governance where path/surface/policy checks are valuable.
- Keep Flow Agents responsible for cross-domain orchestration, skills, powers, global knowledge, workflow state, and harness exports.
- Define a small adapter contract: Flow Agents can invoke Veritas and ingest its evidence, but Flow Agents does not need to own Veritas policy semantics.

Decision gate before adopting Veritas in Flow Agents:

- Does Flow Agents need repo-local policy enforcement for its own workflows now, or only later?
- Can Veritas output map cleanly into Flow Agents evidence artifacts without duplicating schemas?
- Can installation remain optional so non-development knowledge workflows stay lightweight?
- Does Veritas' Surface terminology create confusion inside Flow Agents, or can it stay behind the adapter boundary?
- Would using Veritas improve Flow Agents' reliability faster than building a smaller local evidence checker?

Initial experiment:

1. Add a Flow Agents Veritas spike issue or plan, not a dependency yet.
2. Configure Veritas against Flow Agents in advisory readiness mode in a branch or local artifact.
3. Test three rules: instruction governance block intact, workflow docs require eval updates when contracts change, and hook/script changes require validation evidence.
4. Compare the output against Flow Agents' current `evidence-gate` and telemetry artifacts.
5. Decide whether to adopt Veritas as an optional dev-governance power.

## First Implementation Slice

The thinnest meaningful slice is:

1. Add the layer taxonomy and standards register.
2. Add the roadmap checklist to docs.
3. Define the first JSON Schemas for workflow state and evidence.
4. Update one workflow path, likely `plan-work -> verify-work -> evidence-gate`, to write/read sidecars.
5. Add validation and eval fixtures for that path.
6. Run a Veritas advisory-readiness spike separately before making it a Flow Agents dependency.

This gives Flow Agents a concrete path toward the north star without prematurely coupling it to any one external project.
