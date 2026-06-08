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

Flow Agents should expose small discovery metadata first, then load guidance only when it is useful. Skills, powers, workflow contracts, context packs, and references should be activated just in time.

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
