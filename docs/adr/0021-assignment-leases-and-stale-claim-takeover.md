---
title: "ADR 0021: Assignment Leases and Stale-Claim Takeover"
---

> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0021: Assignment Leases and Stale-Claim Takeover

**Date:** 2026-07-02
**Status:** Draft (shaped with Brian Anderson, 2026-07-02). Completes the coordination loop
designed in [ADR 0012](./0012-agent-coordination-as-liveness-claims.md); gated on the same
Surface ≥1.2.x bump.

---

## Context

ADR 0012 designed the primitive — an advisory liveness claim stream (`claim` / `heartbeat` /
`release`, TTL-reaped, recomputed via the Surface status function) — and the implementation
exists (`src/cli/workflow-sidecar.ts` `liveness` command, `scripts/hooks/lib/liveness-read.js`,
the `workflow-steering.js` SessionStart warning). But the loop is unwired in practice:

1. **Nothing emits.** Lifecycle auto-emit is gated behind `FLOW_AGENTS_LIVENESS` (default off);
   no skill calls `liveness claim`; the live runtime has no `liveness/` stream at all.
2. **`pull-work` never reads.** Selection writes no claim, label, or assignee (provider
   mutation is forbidden by the skill), so N concurrent sessions independently classify the
   same issue "ready" and all take it (#166, under epic #151).
3. **Actor identity collapses.** `FLOW_AGENTS_ACTOR` defaults to the shared literal `"local"`,
   so co-located sessions are indistinguishable — held/conflict detection is structurally
   defeated on exactly the machine where it matters most.
4. **The sidecar directory is a collision point.** `workItemSlug()` is deterministic per work
   item, so two sessions on one issue race last-writer-wins on the same `state.json` and the
   single global `current.json` pointer.
5. **The merge race is unguarded.** No branch convention (templates default `branch: main`),
   no hold check before push/PR/merge — a lapsed-and-superseded session can still publish over
   its successor's work.
6. **Durable assignment is missing entirely.** The liveness stream is local and ephemeral by
   design; there is no cross-machine, human-visible, crash-surviving record of *who owns what*.

The user-level requirement: run X concurrent sessions unattended, with no duplicate pickup, no
clobbered merges, visibility into who holds what — and **no lost locks**: a claim must never
outlive its holder's usefulness just because a terminal window was forgotten.

## Decision

### 1. Effective claim state is a join: `assignment ⋈ liveness`. Neither layer alone is truth.

Two layers with distinct jobs, never conflated:

| Layer | Records | Lifetime | Medium |
|---|---|---|---|
| **Assignment** | intent / ownership | durable, survives crashes | provider (issue assignee/label/comment) |
| **Liveness** | presence / freshness | ephemeral, TTL-reaped | ADR 0012 claim stream |

Readers always compute the join; provider state is **never trusted alone**:

| Assignment | Liveness | Effective state | `pull-work` treatment |
|---|---|---|---|
| assigned | fresh heartbeat | **held** | excluded |
| assigned | stale / absent | **reclaimable** | offered, via takeover protocol (§5) |
| assigned (human) | n/a (humans don't heartbeat) | **human-held** | surfaced, never auto-taken (§6) |
| unassigned | fresh (claim only) | **held** (assignment lagging) | excluded |
| unassigned | absent | **free** | offered |

This join rule is what makes lost locks structurally impossible: staleness — not assignment —
is what excludes, so an orphaned assignee/label from a dead session can never gate work.

### 2. Assignment is a provider abstraction — GitHub is an implementation, not the model.

A third provider leg beside the existing backlog and change providers
(`backlog-provider-settings.schema.json`, `ChangeProvider`):

```
AssignmentProvider:
  claim(subjectId, actor, meta)      # assign + attach machine-readable claim record
  release(subjectId, actor, meta)    # unassign + handoff note
  supersede(subjectId, from, to, meta)  # reassign with audit trail
  status(subjectId) -> {assignee?, actor?, claimedAt?, meta?}
  list(actor?) -> [subjectId]
```

The **GitHub implementation**: assignee (notification/board hook) + a single `agent:claimed`
label (board filter) + a **machine-readable claim comment** carrying the full actor struct,
`claimed_at`, TTL, branch, and artifact-dir pointer. The comment carries identity because the
assignee field cannot: N agent sessions typically share one GitHub account, so per-session
identity lives in the attached record, and each provider decides what it can natively
represent versus what goes in the record. Other implementations (Linear, Jira, GitLab,
local-file for tracker-less repos) map the same operations.

**Actor identity is runtime-agnostic**: `{runtime, session_id, host, human?}` — Claude Code,
codex, opencode, and pi sessions (all of which already have telemetry hook adapters) and
humans are all actors. The SessionStart hook derives and exports `FLOW_AGENTS_ACTOR` from the
runtime session id automatically; the `"local"` default is retired as an error, not a fallback.

### 3. Liveness is cross-cutting: ambient reads, lifecycle writes, one hard gate.

Five touchpoints, one policy:

| Touchpoint | Direction | Behavior |
|---|---|---|
| `workflow-steering.js`, every turn | read | one-line liveness digest; "superseded" interrupt for the held subject |
| `pull-work` | read + write | exclude held; claim (liveness + provider) on selection |
| `ensure-session` / pickup | read + write | refuse entry to a session dir under a fresh other-actor claim; supersede-then-enter if stale |
| `advance-state` + tool activity | write | heartbeat rides existing writes; no bespoke timer |
| **publish (push / PR / merge)** | **read, blocking** | **verify-hold**: hard-stop if not the fresh, non-superseded holder |

Once an actor holds a fresh claim it is "heads down": the ambient check narrows from "what is
everyone doing" to "have I been superseded". The verify-hold gate is the fencing token — the
advisory layer's single mutex moment, placed at the integration layer exactly where ADR 0012 §4
assigns real serialization. It is what defeats the zombie: a session that sleeps past TTL, gets
superseded, and wakes is caught deterministically before it can publish over its successor.

`FLOW_AGENTS_LIVENESS` flips to default-on. Branch becomes a first-class routing field in
`state.json` with the convention `agent/<actor>/<slug>`; `current.json` becomes per-actor
rather than one global last-writer-wins pointer.

### 4. Provider state is corrected lazily at claim transitions — plus a janitor for humans.

Nothing updates the provider on a timer; every mutation has a responsible actor:

| Transition | Mutator | When |
|---|---|---|
| claim | the claiming session | at selection |
| clean release | the incumbent (Stop hook / terminal `advance-state`) | session end — unassign + handoff comment |
| supersede | the **successor**, inside the takeover protocol | after the grace beat |
| crash, no successor | nobody, initially | corrected by the next actor to want the subject, or the janitor |

Lazy correction is *safe* by §1 (stale assignment excludes nothing) but leaves the human board
lying in the crash case. The supplement is a **janitor**: a sweep that joins `agent:claimed`
subjects against the liveness stream and relabels/unassigns past-TTL claims with an explanatory
comment. Locally this is a cron sweep; for fleets it is the natural first coordination duty of
the hosted Console relay (§7), which is the one vantage with global heartbeat visibility.
Heartbeats are **never** written to the provider (rate-limit abuse for no benefit); at most the
claim comment refreshes on phase transitions, doubling as board-level progress.

### 5. Takeover is resumption, not restart — `continue-work` triggered by staleness.

ADR 0012 §3 established that durable evidence outlives the ephemeral claim. This ADR makes the
resume path concrete. On seeing `assigned + stale`:

1. Emit a supersede claim on the subject.
2. **Grace beat**: wait one heartbeat interval; if the incumbent revives, back off (the
   "laptop just woke" race resolves in the incumbent's favor).
3. `supersede()` via the provider — reassign with the audit-trail comment ("superseded actor X,
   last seen T, resuming from trust bundle").
4. Resume through the existing handoff/trust-bundle machinery — the deterministic work-item
   slug means the successor inherits the same artifact dir by construction (the prior
   collision hazard becomes the resume feature once claims gate entry).
5. **Continue the incumbent's branch** (fetched from `state.json`'s branch field), never a
   parallel one — otherwise takeover recreates the duplicate work it exists to prevent.

The woken zombie is then caught twice: its next turn's steering digest says "superseded", and
the verify-hold gate blocks it at publish regardless.

### 6. Human assignees are never auto-superseded.

Humans do not heartbeat, so `assigned-to-human + no-liveness` is normal, not stale. Agents
**surface** idle human assignments ("assigned to brian 3 days ago, no linked activity —
reclaim?") and act only on explicit confirmation. The threshold and behavior are a policy knob
in the assignment-provider settings; the default is ask-first.

### 7. Local-first stands; the Console is the fleet tier, never required.

Per ADR 0012 §5 the sink ladder is local file → git ref → optional hosted relay. Everything in
§§1–6 works on a single machine with the local JSONL stream and the GitHub provider. The hosted
Console (console.kontourai.io) adds, strictly as a relay/projection of the advisory stream —
consistent with its "never becomes the authority" stance:

- **liveness relay**: sessions mirror claim/heartbeat/release events (its existing idempotent
  ingest + tenant auth + SSE substrate fits without new authority semantics);
- **fleet view**: active actors, held/reclaimable subjects, per-session cost it already has;
- **the janitor** (§4), the first genuinely cross-machine duty.

This is the deliberate product boundary: single-machine parallelism is fully unlocked locally;
multi-machine fleets, human oversight, and history are what the hosted tier sells.

## Consequences

- Running X unattended concurrent sessions becomes safe by construction: duplicate pickup is
  excluded by the join rule, clobbered merges by verify-hold, lost locks by TTL + Stop-hook
  release, and abandoned work is resumed — not restarted — via takeover.
- The Stop hook gains a duty: emit `release`-with-handoff on every non-terminal session end, so
  the common case (closed terminal) frees work instantly and TTL only covers real crashes. This
  keeps TTLs generous, which ADR 0012 §4 identifies as the operational risk.
- `pull-work` loses its blanket no-provider-mutation rule in favor of one narrow, audited
  mutation: the claim at selection.
- New surface to maintain: the `AssignmentProvider` contract + settings schema, the actor
  struct, a branch-naming convention, per-actor `current.json`, and the janitor.
- Cross-repo dependency: the Console relay/fleet-view/janitor land in the console repo; this
  repo only gains the optional relay sink.

## Alternatives Considered

- **Liveness-only (no durable assignment).** Fails cross-machine and human visibility; a crash
  leaves no record of ownership anywhere a human looks. Rejected — it is the presence layer,
  not the ownership layer.
- **Provider-only (assignee/label, no liveness).** ADR 0012 already rejected as insufficient;
  additionally it has no freshness, so it *creates* the lost-lock problem this ADR exists to
  prevent. TTL logic bolted onto provider comments is the same design with worse atomicity.
- **Hard leases (provider-side CAS, lock server).** Re-rejected per ADR 0012 — stale leases
  orphan work; the verify-hold gate gets mutex safety at the single point that needs it.
- **Heartbeating to the provider.** Rejected: rate limits, comment spam, and it duplicates the
  stream that already exists.
- **Auto-superseding humans symmetrically with agents.** Rejected: humans lack heartbeats, so
  symmetry manufactures false reclaims against exactly the actors least able to defend a claim.

## References

- [ADR 0012: Agent Coordination as Hachure Liveness Claims](./0012-agent-coordination-as-liveness-claims.md) — the primitive this ADR wires and completes. (Its reference to
  #137 for pull-work claim wiring is stale; the live tracking is #166 under epic #151.)
- #151 — the ADR 0012 coordination epic; this ADR shapes its remaining slices. #166
  (pull-work claim emit/exclude) is extended by §1's join rule; #167 (advisory surface,
  warn-never-block) is deliberately upgraded by §3 at exactly one point — the verify-hold
  publish gate; #153 (resume from the durable record) is the substrate §5's takeover
  builds on; #161 (deterministic work-item slug) is the landed foundation.
- `src/cli/workflow-sidecar.ts` (`liveness`, `withLock`, `writeCurrent`, `workItemSlug`);
  `scripts/hooks/workflow-steering.js` (ambient read side, already live);
  `scripts/hooks/stop-goal-fit.js` (release-with-handoff injection point).
- `docs/kontour-resource-contract.md` `ScopeOverlap` — the declared-file-scope seam for
  work-*area* (vs work-item) conflict detection; claims should carry declared scope so
  `pull-work`'s `global_conflicts` can consult live claims, closing the gap ADR 0012 names.
- Console: `docs/integrations/flow-agents-console.md`, console repo `POST /records` +
  `/ingest/flow` + SSE (the relay substrate).
