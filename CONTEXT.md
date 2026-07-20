# Flow Agents Context

## Glossary

### Flow Agents

An operating layer that helps agents route natural user requests into the right procedures, tools, state, evidence, knowledge, and follow-ups without requiring the user to remember implementation details. Flow Agents is a product that applies Flow and Veritas discipline inside the agent tools people already use.

### User

The person asking Flow Agents for an outcome. Use `end user` only when contrasting the user's vocabulary with Flow Agents internals.

### Work Mode

A user-facing category of intent, such as Build, Understand, Capture, Prepare, or Follow Up. Work modes help Flow Agents decide which operating path to use.

### Build

The work mode for creating, changing, fixing, verifying, publishing, or shipping software and other buildable artifacts.

### Builder Kit

The first Kontour-authored Flow Kit for opinionated AI-assisted building work. The Builder Kit owns shaping, probing, planning, execution, verification, merge readiness, PR readiness, and learning workflows.
_Avoid_: Development pack, generic coding workflow

### Initiative

A larger product, platform, governance, or dogfood outcome that groups related executable work. Initiatives are optional first-class Kontour Resource Contracts for planning and traceability, not executable units. Initiatives explain why related work belongs together; dependency links explain what must happen before other work can proceed.
_Avoid_: Epic, Feature as the generic term

### Understand

The work mode for explaining what exists, researching context, comparing options, or making accumulated information understandable.

### Capture

The work mode for turning raw input into durable memory, such as notes, decisions, meetings, transcripts, source material, and useful pointers.

### Prepare

The work mode for getting ready for a meeting, review, planning session, customer conversation, or decision.

### Follow Up

The work mode for tracking commitments, open loops, tasks, reminders, activity logging, and next actions.

### Capability

Something a work mode needs from the outside world or from Flow Agents infrastructure, such as a backlog, knowledge store, CRM, calendar, email, docs store, CI system, or code host.

### Provider

A configured implementation of a capability, such as GitHub for backlog, Obsidian for knowledge storage, or Google Calendar for calendar access.

### Provider Contract

The declared capabilities, defaults, conventions, and limits of a provider type. Provider contracts make integrations predictable and testable without requiring the live provider.

### Knowledge Graph

The Knowledge Kit's storage-independent model: typed nodes (recommended core: note, decision, issue, session, person — extensible) and typed edges (supersedes, merged-into, blocks, evidence-of, mentions, relates — a closed vocabulary), each carrying provenance so every assertion is traceable to the store it came from. Storage and synchronisation are provider concerns; the same ingest, link, and health verbs run over every provider.
_Avoid_: Graph database as the generic term (the model is provider-independent; a graph-database provider is a separate spike)

### Knowledge Store Provider

A configured implementation of the knowledge-store capability behind the Knowledge Graph model. Providers expose a read interface (nodes, edges, query-by-type) and a proposals-only write interface (proposeWrite returns a proposal, never mutating a human-curated store). The reference providers are markdown-vault (the Obsidian-shaped vault), git-repo (decision registry, CONTEXT.md vocabulary, learnings), and work-item (GitHub issues as a source/sink adapter). See context/contracts/knowledge-store-contract.md.
_Avoid_: Knowledge adapter when contrasting the provider interface with a single store adapter

### Graph Knowledge Provider

The owner's opt-in Neo4j-backed Knowledge Store Provider (the `neo4j` provider). A queryable materialized view of the Knowledge Graph, synced from the file/work-item providers with idempotent MERGE semantics — the file stores stay the source of truth and the write side stays proposals-only. Selected via `KNOWLEDGE_PROVIDER=neo4j`; degrades to the file providers when no Neo4j is reachable. The file providers remain the portfolio default; the graph is a personal default only. See docs/decisions/graph-knowledge-provider.md.
_Avoid_: Graph database as the default store (it is opt-in and a view, not the source of truth)

### Knowledge Promote Sub-Flow

The Knowledge Kit's codebase-facing pipeline (the "flow within a flow") that a delivered session's promotion runs through: ingest the session artifacts, distill schema-valid draft decision/vocabulary/learning deltas, link their provenance (PR, merge SHA, session archive, touched topics), and health-check the registry for contradictions with a merge-repair proposal. It is proposals-only — every output is a draft under the session's proposals directory that the promote step applies; the sub-flow never writes docs directly. Invokable standalone and composable from the Builder promote step. See docs/decisions/knowledge-promote-sub-flow.md.
_Avoid_: Promotion gate as a synonym (the gate is the recorded promote claim; this is the assisted pipeline)

### Runtime Session Residue

A schema-valid, bounded, deterministically redacted projection of a real Claude Code or Codex transcript referenced by canonical telemetry. It is an input candidate for offline Knowledge distillation, not a transcript archive or a trust claim. A dream-owned byte-offset cursor advances only through successfully handled telemetry records and stops before unreadable or drifted content.
_Avoid_: Runtime transcript (the raw transcript remains runtime-owned and is never copied verbatim into residue)

### Kontour Resource Contract

A versioned Kontour record shape for durable machine-readable configuration, scope, run state, evidence, provider output, and cross-product interchange. Kontour Resource Contracts are the default for new pre-public durable contracts unless a product records why a native shape is clearer.
_Avoid_: Manifest as the generic term, Kubernetes resource when Kubernetes is not the runtime

### Local-First Default

A baseline provider choice that works with local files before hosted integrations are configured. Local-first defaults should preserve durable records, relationship links, source pointers, follow-ups, status, searchability, and migration paths.

### Relationship Link

A durable connection between records, people, customers, projects, initiatives, issues, meetings, follow-ups, or source systems. Local-first providers may store relationship links as Markdown links or pointers; richer providers may map them to backlinks, graph edges, CRM relationships, or issue links.

### Skill

A reusable procedure Flow Agents can invoke to carry out part of a work mode. Skills are implementation details from the user's perspective.

### Flow Kit

Flow's distribution unit for portable workflow bundles. A Flow Kit has two layers: (1) the **container** (owned by Kontour Flow) — a `kit.json` manifest with `schema_version`, `id`, `name`, and a non-empty `flows` list, plus optional `description` and `product_name`; and (2) the **agent extension** (owned by Flow Agents) — optional `skills`, `docs`, `adapters`, `evals`, and `assets` fields that make it a Flow Agents Kit. The container contract permits unknown top-level fields so consumers can extend it without breaking core validation. A kit with only core container fields is a valid Flow Kit; adding Flow Agents extension fields makes it a Flow Agents Kit.
_Avoid_: Pack, plugin, marketplace package

### Flow Kit Repository

A local folder or remote repository with a Flow Kit manifest at its root. A Flow Kit Repository can be installed by Flow or Flow Agents from a local path, git URL, GitHub shorthand, or package registry source.
_Avoid_: Skill repository as the generic term

### Workflow

A stateful multi-step path with gates, handoffs, evidence, and next actions. Not every task or skill needs a workflow.

### Gate

A workflow checkpoint that decides whether a Workflow Run can advance, must stop, or should route back. Gates record structured evidence, gaps, authority, actors, attempts, and route decisions, while exposing Status Condition summaries for shared reporting rather than relying on hidden agent confidence.

### Status Condition

A current, inspectable statement about the lifecycle state of a Kontour Resource Contract, Gate, Workflow Run, or Delivery Run. Status Conditions summarize status, reason, message, evidence pointers, and transition time without replacing the underlying evidence record. Static definitions do not need Status Conditions unless they are installed or applied into an environment.

### Core Condition Vocabulary

The small shared set of Status Condition meanings Flow Agents standardizes for interoperability, reporting, Console views, evals, and analytics. Flow Kits may add domain-specific condition reasons, but shared conditions such as ready, blocked, in progress, scope overlap, scope changed, configuration gap, missing evidence, and route-back required should keep the same meaning across kits.

### Scope Overlap

A Status Condition indicating that one Workflow Run's active Selected Scope intersects with another active Workflow Run or provider-backed work record. Scope Overlap supports Alignment Gate coordination without implying distributed lock, lease, or reservation semantics.
_Avoid_: Scope Reservation, Lease, Lock

### Gate Role

Optional metadata that describes the kind of decision a Gate is making, such as alignment, readiness, review, verification, evidence, publication, release, or approval. Gate Roles provide shared language for reporting and adapters; Workflow or Flow Kit definitions decide the required evidence and route-back behavior.
_Avoid_: Gate Type when implying rigid core behavior

### Alignment Gate

A Gate that confirms intent, selected scope, assumptions, authority, or user decisions before a Workflow Run advances. Alignment Gates may be satisfied from context, provider state, explicit approval, or a kit-specific interaction such as a Probe.

### Publication Gate

A Gate that makes a Workflow Run output externally inspectable or consumable through a provider or durable artifact. Publication Gates are core; Builder Kit's Prepare PR is the code-host pull request implementation.

### Release Gate

A Gate that decides whether a published Workflow Run output can be accepted, merged, released, deployed, held, or rolled back. Release Gates are core; Builder Kit's Merge Readiness is the code-host pull request implementation.

### Gate Actor

The person, agent, provider, automation, or authority allowed to evaluate, satisfy, or approve a Gate. Gate Actors are separate from Gate Roles because a verification, release, or approval gate may require different actors in different Workflows.
_Avoid_: Gate Role for permission semantics

### Required Capability

The provider, tool, or runtime capability needed to evaluate a Gate, such as CI checks, a code host pull request, browser automation, a calendar provider, a CRM, a governance adapter, or a Surface trust provider.

### Required Evidence

The proof a Workflow or Flow Kit says a Gate needs before it can pass. Flow Agents owns the evidence mechanics; the Workflow or Flow Kit defines which evidence is required for each Gate.

### Route Back

The workflow transition selected when a Gate cannot advance and the next useful action is an earlier step. Flow Agents owns route-back recording and loop-protection mechanics; the Workflow or Flow Kit defines the route reasons and target steps.

### Attempt

A deterministic count of how many times a Workflow Run has evaluated or retried a Gate, Step, or Route Back path. Flow owns attempt counting for workflow enforcement; Flow Agents records attempt metadata for agent workflow analysis, evals, and learning.

### Reason Code

A stable explanation for why a Gate passed, failed, could not be verified, or routed back. Flow Agents provides a small shared reason vocabulary for analytics and interoperability, while Flow Kits may define domain-specific reason codes.

### Workflow Run

One execution of a Workflow from selected scope through its gates, evidence, route-backs, and terminal outcome. A Workflow Run references its canonical Selected Scope and snapshots the selected subject identifiers for audit history. Builder Kit Delivery Runs are a build-specific kind of Workflow Run.
_Avoid_: Delivery Run as the generic term

### Workflow Entry Authority

The authority to create a new Workflow Run or resume an existing one. A new run always starts at the Workflow's first step; a later current step is valid only when recovered from persisted run state whose transitions, gate outcomes, evidence, and accepted exceptions validate against the canonical Workflow definition. Gate exceptions may authorize a gate outcome inside an existing run, but never authorize selecting a later starting step.
_Avoid_: Ad-hoc entry, skip-step override

### Run Plan

The core workflow-level plan for a Workflow Run. Run Plans describe intended gate order, selected scope, required capabilities, required evidence, route-back policy, and learning points without assuming the work is software delivery.
_Avoid_: Execution Plan as the generic term

### Selected Scope

The first-class Kontour Resource Contract that declares the explicit subject or set of subjects a Workflow Run is authorized to operate on. Selected Scope may include Work Items, files, documents, customers, meetings, research sources, or other provider-backed records, and it should be narrow enough for the workflow's gates to evaluate coherently. Material Selected Scope changes route back to an Alignment Gate.
_Avoid_: Work Item Group as the generic term

### Scope Change

A recorded event or Status Condition describing a change to the Selected Scope of a Workflow Run. Material Scope Changes route back to an Alignment Gate so coordination, authority, overlap, and downstream Work Item impact can be evaluated before continuing.
_Avoid_: Boundary Crossing as the generic Flow Agents term

### Work Item

An executable backlog or queue unit selected by a workflow. Work Items are provider-backed when a backlog provider is configured, and Flow Agents keeps a portable local-first Kontour Resource Contract shape for local use, tests, kit demos, and migration. A Work Item is smaller than an Initiative and large enough to move through one coherent Workflow Run with clear acceptance evidence.
_Avoid_: Task as the generic term, Issue as the provider-neutral term

### Backlog Readiness Source

The provider-backed signal that marks a Work Item intentionally ready for pickup, read by `pull-work` to build the ready queue. The readiness source is declared by backlog provider settings (currently the configured BoardProvider's ready statuses); a configured readiness source that yields nothing is a surfaced warning, never a silent fallback to unranked issue listing. The live decision is recorded in `docs/decisions/backlog-readiness-source.md`.
_Avoid_: ready label, board status as interchangeable generic terms

### Work Item Group

A Builder Kit Selected Scope containing multiple related Work Items delivered through one Delivery Run because grouping reduces coordination risk and preserves one coherent acceptance and evidence story. Work Item Groups are exceptions justified by `pull-work`; they do not replace Initiatives.
_Avoid_: Initiative, Execution Wave, batch as the generic term

### Delivery Run

One attempt to deliver a selected Work Item or justified Work Item Group through alignment, planning, execution, review, verification, publication, evidence, release readiness, and learning.
_Avoid_: Task, issue, wave

### Execution Plan

The Builder Kit delivery-specific plan for a selected Work Item or Work Item Group. An Execution Plan specializes a Run Plan with implementation approach, file ownership, verification strategy, publication strategy, and how work is divided into Execution Waves.
_Avoid_: Run Plan as the generic term, Backlog plan, Initiative plan

### Execution Wave

A subdivision inside one Execution Plan used to organize implementation work, often for parallel workers. Execution Waves are not backlog units and do not create new Work Item scope.
_Avoid_: Work Item, Work Item Group

### Prepare PR

The Builder Kit Publication Gate that turns a locally verified Delivery Run into a reviewable external code-host change. Prepare PR includes commits, branch push, pull request creation or update, Work Item links, PR body evidence, and CI trigger preparation.
_Avoid_: Evidence Gate, Release Readiness

### Merge Readiness

The Builder Kit Release Gate that decides whether a published code-host change is ready to merge. Merge Readiness may use provider state such as pull request mergeability and CI checks, and may also use optional governance evidence such as Veritas when configured.
_Avoid_: Veritas readiness as the only meaning

### Provider Mergeability

The code-host provider's merge signal for a published change, such as pull request existence, mergeable state, branch protection, review state, and CI or status checks. Provider Mergeability is one sub-check of Builder Kit Merge Readiness.

### Governance Readiness

Optional policy or trust-backed readiness evidence for a published change, such as Veritas readiness, Surface trust claims, repo standards, protected area authority, evidence freshness, or boundary checks. Governance Readiness is one sub-check of Builder Kit Merge Readiness when configured.

### Configuration Gap

A reason code for a Gate that cannot be evaluated or cannot pass because a required provider, capability, or setting is missing, invalid, unavailable, or incompatible. Required Configuration Gaps block advancement; optional Configuration Gaps should be recorded as advisory or not verified with remediation.

### Probe

A Builder Kit Alignment Gate that explores context, challenges assumptions, and records aligned decisions before the process continues. A Probe asks one question at a time, recommends an answer, and uses repository context before asking when the answer can be discovered. As understanding crystallizes, a Probe writes it into durable docs in the same motion: a vocabulary delta into this glossary and a decision delta into the Decision Registry, per [context/contracts/probe-docs-write-contract.md](context/contracts/probe-docs-write-contract.md).
_Avoid_: Grill, interrogation

### Flow

Kontour AI's process transparency and gate enforcement layer. Flow owns steps, gates, transitions, Flow Runs, exceptions, continuation, and Flow Reports. Flow Agents consumes Flow for agent-facing workflows rather than owning the generic enforcement kernel.

### Project Settings

Settings that apply to a repo, folder, team workspace, customer effort, writing effort, or personal initiative. Project Settings override Global Settings for that project.

### Global Settings

The user's default Flow Agents setup across projects.

### Runtime Adapter

The translation layer that turns Flow Agents source configuration and operating concepts into a specific runtime's native shape.

### Framework Adapter

A Runtime Adapter for API- or framework-based agents such as LangGraph, Strands, CrewAI, VoltAgent, or direct model-inference systems. Framework Adapters map framework events, state, and tool calls into Flow Runs, gates, and evidence.
_Avoid_: Skill, hook, plugin as the generic term

### Runtime Portability

The requirement that Flow Agents provide a consistent operating experience across agent runtimes such as Pi, Claude Code, Codex, Kiro CLI, Droid, Hermes, and future runtimes. Flow Agents should not depend on owning the chat interface or agent runtime.

### Workflow Enforcement

The Flow Agents principle that important work should move through explicit gates without hidden shortcuts. Each gate should expose inspectable evidence, gaps, or user decisions before the workflow advances.

### Learning

The feedback loop that turns workflow outcomes, friction, failures, user corrections, and evidence gaps into durable improvement candidates. Learning is a core capability, but not every terminal Workflow Run needs a Learning record.
_Avoid_: Retrospective as the generic term

### Traceability

The ability to inspect what the agent was asked to do, which operating path it followed, what evidence was collected, which gates passed or failed, and why the next action is trustworthy or blocked.

### Decision Records

Topic-keyed living decision records at `docs/decisions/<topic-slug>.md`, one file per decision subject, that hold the current answer to a settled question plus lean rationale. Supersession is an edit to the file; derivation context is linked via evidence refs, never inlined. Slugs are nouns from this glossary. Numbered ADRs under `docs/adr/` are frozen history and are never written for new decisions.
_Avoid_: Numbered ADR as the format for new decisions

### Decision Registry

The system of Decision Records plus the generated index at [docs/decisions/index.md](docs/decisions/index.md) (slug + one-line summary). The contract is [context/contracts/decision-registry-contract.md](context/contracts/decision-registry-contract.md); the frontmatter schema is `schemas/decision-record.schema.json`; `npm run check:decisions` validates it. Consult the index at write time to decide revise-vs-create.

### Standing Directives

A short, numbered, quotable list of ratified owner directives, each with a one-line rationale and date, kept at [context/contracts/standing-directives.md](context/contracts/standing-directives.md) and pointed to from the header of every other contract file in `context/contracts/`. Standing Directives override default engineering conservatism (such as keeping a compatibility path "just in case") wherever they apply; they exist so a ratified correction has a durable home instead of living only in the ephemeral context of the orchestrator session that ratified it.
_Avoid_: Operating discipline as the generic term for owner-ratified policy, restating a directive from memory instead of citing the file

### Promotion Gate

The gated sequence — final acceptance -> promote -> archive — that makes durable-residue extraction the archival act: a delivered session's decisions, vocabulary, learnings, and doc updates must be promoted into durable living docs before the session is archived. The `promote` step records what was promoted where and writes a session-local **promotion claim** into the session `trust.bundle` (evidence refs = the durable doc paths written, or an explicit `--none` no-residue reason). `workflow-artifact-cleanup-audit` classifies a delivered/accepted session with no promotion claim as a cleanup candidate (archive blocked), not terminal. See [docs/decisions/promotion-gate.md](docs/decisions/promotion-gate.md) and [docs/workflow-artifact-lifecycle.md](docs/workflow-artifact-lifecycle.md).
_Avoid_: Docs-promotion as a parallel checklist chore

### Governance Adapter

An optional integration that supplies policy, proof, or trust evidence without making Flow Agents own the external tool's rule semantics. Veritas is the first known governance adapter candidate.

### Claim Expectation

A gate-level expectation for a Surface claim type, accepted trust statuses, and whether missing or rejected evidence should block the transition. Claim Expectations describe what a Flow gate needs without naming the producer that will satisfy it.
_Avoid_: Provider-specific requirement, Veritas requirement

### Trusted Producer

A Surface producer accepted by a project or runtime config as authoritative for one or more claim types. Trusted Producers satisfy Claim Expectations by emitting Surface claims with acceptable trust status and authority trace.
_Avoid_: Hardcoded provider, tool name inside a Flow Definition

### Flow Agents Source Config

The portable Flow Agents configuration owned by Flow Agents itself.

### Kit Catalog

The Flow Agents index that lists available Flow Kits and the runtime assets each kit installs. The Kit Catalog points to Flow Kit content; it does not define workflow gate semantics itself.
_Avoid_: Pack manifest, global workflow spec

### Runtime Config

Configuration generated or maintained for a specific runtime such as Codex, Claude Code, or Kiro.

### Console

The optional visual setup, status, usage, and improvement surface for Flow Agents. Flow Agents should work without opening the Console, but the Console helps users configure modes and providers, inspect global and project settings, view active workflow state, review telemetry and eval outcomes, and act on suggested improvements.

### Project Console

The default Console view when launched from a workspace. It shows effective settings, provider overrides, active workflow state, usage, evals, and improvement opportunities for the current project while also explaining inherited Global Settings.

### Global Console

The Console overview for global setup, registered projects, cross-project usage, global providers, and system-wide improvement opportunities.

### Control API

The shared tool layer used by the Console, CLI, AI agents, and automation. The Control API owns operations such as reading effective settings, explaining provider resolution, testing provider health, previewing config changes, writing config, inspecting workflow state, and reporting usage or eval outcomes.

### Workflow trust state

The trust bundle a workflow gate reads to decide whether to advance — claims, evidence, verification events, and derived status expressed as a Hachure Trust Bundle — so gates consume inspectable trust state rather than raw tool output. Provenance lives in frozen ADRs; the subject is open in the Decision Registry as [docs/decisions/workflow-trust-state.md](docs/decisions/workflow-trust-state.md).

### TypeScript-first source policy

The policy that Kontour product and runtime source defaults to TypeScript, with narrow JavaScript/MJS exceptions (config/tooling, generated assets, thin launchers, fixtures, historical artifacts) and staged per-repo migration for existing non-TypeScript source. Ratified in the Decision Registry as [docs/decisions/typescript-source-policy.md](docs/decisions/typescript-source-policy.md).

### Flow / Skill / Kit / Tool boundary

The layering that separates a Flow (workflow semantics) from a Skill (agent-facing procedure), a Flow Kit (installable bundle), and a Tool (an executable operation), so each concern has one home and does not leak into the others. Subject open in the Decision Registry as [docs/decisions/flow-skill-kit-tool-boundary.md](docs/decisions/flow-skill-kit-tool-boundary.md).

### Kit operation boundary

The rule for what a kit-owned operation may do versus what belongs to the core, keeping kit operations scoped to their capability and free of core enforcement responsibilities. Subject open in the Decision Registry as [docs/decisions/kit-operation-boundary.md](docs/decisions/kit-operation-boundary.md).

### Hook core/kit boundary

The division between canonical hook behavior owned by the core and hook contributions owned by kits, so enforcement hooks have a single authoritative implementation. Subject open in the Decision Registry as [docs/decisions/hook-core-kit-boundary.md](docs/decisions/hook-core-kit-boundary.md).

### MCP posture

Flow Agents' stance on the Model Context Protocol: enforcement stays in hooks, Surface owns any MCP projection, and no MCP configuration is auto-injected into a runtime. Subject open in the Decision Registry as [docs/decisions/mcp-posture.md](docs/decisions/mcp-posture.md).

### Agent coordination

How concurrent agents avoid stepping on each other's work, modeled as Hachure liveness claims plus assignment leases with stale-claim takeover, so a work item's holder is advisory-visible and reclaimable when stale. Subject open in the Decision Registry as [docs/decisions/agent-coordination.md](docs/decisions/agent-coordination.md).

### Context lifecycle

The lifecycle of an agent's working context — workflow-boundary compaction, freshness-gated reuse, and the split between durable learnings and ephemeral context — so context is refreshed rather than silently stale. Subject open in the Decision Registry as [docs/decisions/context-lifecycle.md](docs/decisions/context-lifecycle.md).

### Core vs domain kit boundary

The generic/kit boundary that keeps the Flow Agents core domain-agnostic while domain behavior lives in kits, so the core carries no kit-specific knowledge. Subject open in the Decision Registry as [docs/decisions/core-domain-kit-boundary.md](docs/decisions/core-domain-kit-boundary.md).

### Flow / Flow Agents boundary

The reconciled division of responsibility between Flow (the workflow engine consumed for enforcement) and Flow Agents (the product that consumes it), so each owns a distinct layer without duplicating the other. Subject open in the Decision Registry as [docs/decisions/flow-flow-agents-boundary.md](docs/decisions/flow-flow-agents-boundary.md).

### Three-hard-boundary model

The FlowDefinition-driven, kit-agnostic model that names the three hard boundaries the core enforces, unifying the individual boundary decisions into one architecture. Subject open in the Decision Registry as [docs/decisions/three-hard-boundary-model.md](docs/decisions/three-hard-boundary-model.md).

### Anti-gaming trust security

The layered-defense trust security model that assumes the local agent can be gamed and anchors enforcement in an external CI check, freezing the local shell-parsing heuristics and routing new enforcement to the CI anchor. Subject open in the Decision Registry as [docs/decisions/anti-gaming-trust-security.md](docs/decisions/anti-gaming-trust-security.md).

### Kit dependency ownership

The rule for which layer owns a kit's runtime dependencies, keeping dependency declaration and installation with the kit that needs them rather than the core. Subject open in the Decision Registry as [docs/decisions/kit-dependency-ownership.md](docs/decisions/kit-dependency-ownership.md).

### Trust-reconcile and delivery reconciliation

The CI-anchored reconciliation of a session's trust claims against a manifest — classifying command, session-local, and attested claims, honoring governed waivers — and the fail-closed delivery reconciliation that blocks publication on unreconciled residue unless an exemption is recorded. Subject open in the Decision Registry as [docs/decisions/trust-reconcile.md](docs/decisions/trust-reconcile.md).

### Model Routing

The policy that maps a delegate role name (such as `delegate-mechanical`, `delegate-implementation`, `delegate-design`, `orchestrator`, `extraction-default`) to a specific `model@provider` ref. Model Routing is data, not code: it lives in `.datum/config.json` (read by the `@kontourai/datum` registry, schema `datum.schema.json`) and never in generated files or per-agent frontmatter. The orchestrator resolves the role at delegation time (`datum resolve <role> --json`) and passes the resolved model explicitly when spawning each delegate. See [context/contracts/execution-contract.md](context/contracts/execution-contract.md) § Delegation: Model Routing and [docs/decisions/model-routing.md](docs/decisions/model-routing.md).
_Avoid_: Generated per-agent model frontmatter, environment-variable-only model selection
