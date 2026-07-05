---
title: Flow Agents × Kontour Console
---

# Flow Agents × Kontour Console

Flow Agents' [coordination substrate](../coordination-guide.md) is **local-first and complete on a
single machine** — the local liveness stream plus the GitHub `AssignmentProvider` give you full
parallel-session safety with no server. The **Kontour Console** (`console.kontourai.io`) is the
**optional fleet tier** layered on top: it never becomes the authority for coordination; it *relays,
projects, and eventually arbitrates* across machines and teammates.

> This is the design boundary, stated plainly: **single-machine parallelism is fully unlocked
> locally, for free.** Multi-machine fleets, cross-teammate visibility, human oversight, history, and
> team-level insight are what the hosted tier adds — and sells. See [ADR 0021 §7](../adr/0021-assignment-leases-and-stale-claim-takeover.md)
> for the ratifying decision.

**Tracking:** flow-agents epic [#394](https://github.com/kontourai/flow-agents/issues/394) · console
epic [#123](https://github.com/kontourai/console/issues/123). This doc is the in-repo narrative; the
issues carry live slice status.

---

## What the Console already is

The Console is a Node/TypeScript monorepo (`console-core` / `console-server` / `console-ui`), backed
by Postgres (Neon), deployed on Render, running the dogfood instance at `console.kontourai.io`. It
already ingests and projects agent telemetry:

- **Ingest** — `POST /records` accepts telemetry records; auth via `Bearer` / `X-Console-API-Token`
  plus `X-Console-Tenant-Id` (tokens configured through `CONSOLE_AUTH_TOKENS_JSON`).
- **Projection** — `GET /state` returns an `OperatingState` projection; **SSE** streams live updates.
- **Economics** — per-session cost/usage views (console #117) and an org-scoped registry (#118).

Its multi-tenancy today is **strong at the infrastructure layer** (Postgres primary keys per tenant,
per-tenant hubs and SSE fan-out) but **weak at the schema layer**: records don't self-identify their
tenant — tenancy is carried by the request header, not the record body. Closing that gap is part of
this epic (see *Tenant hardening* below).

## The design invariant: relay, never authority

Two rules keep the Console from compromising the local-first guarantee:

1. **Heartbeats are never written to a provider.** They mirror to the Console relay (the one vantage
   with global heartbeat visibility) but never to GitHub — rate-limit abuse for no benefit. At most a
   claim comment refreshes on phase transitions, doubling as board-level progress.
2. **The advisory stream stays advisory.** The Console projects the same liveness/assignment signals
   the local substrate computes; in Phase 1 it adds *visibility*, not new authority. Only in Phase 2,
   opt-in, does a Console-backed `AssignmentProvider` make assignment authoritative across machines —
   and even then it implements the exact same contract the GitHub/local providers do.

## The phased plan (one epic, two phases)

### Phase 1 — read-only fleet insight (the relay)

Turn per-repo coordination into a team-wide view, without changing where authority lives.

| Slice | Repo | What it does |
| --- | --- | --- |
| **ApiSink** ([console #73]) | console | The ingest substrate the relay rides on — the prerequisite. |
| **Liveness relay** (flow-agents [#295]) | flow-agents | An optional sink: sessions mirror `claim`/`heartbeat`/`release` events to the Console, reusing its idempotent ingest + tenant auth + SSE. Off by default; strictly additive. |
| **Fleet projection** | console | Active actors, `held`/`reclaimable` subjects, and per-session cost, projected per tenant — the fleet view. |
| **In-hub janitor** | console | The [coordination janitor](../coordination-guide.md#10-takeover-protocol-forthcoming--294) run centrally: the Console is the one vantage with global heartbeat visibility, so stale-claim reaping for a *fleet* is its natural first cross-machine duty. (Decision: the janitor lives **in the console hub**, not per-client.) |

Phase 1 delivers the "see everyone's active sessions, and your own usage in team context" outcome —
project/team insight views alongside individual ones — while coordination authority stays exactly
where it is today (local + GitHub).

#### Liveness relay — flow-agents side (shipped)

The flow-agents EMIT half of the relay ships as an **optional, off-by-default** sink
(`scripts/liveness/relay.sh`). When enabled, each liveness event (`claim`/`heartbeat`/`release`) is
mirrored to the Console as a `kontour.console.liveness` record over the **same transport core** the
telemetry mirror uses — `console_post_json` in `scripts/telemetry/lib/transport.sh` (endpoint-allow
gate, `Authorization: Bearer` + `x-console-tenant-id`, timeouts, detached fire), shared not forked.

It is **strictly local-first** (ADR 0012 §5): the relay fires *after* the durable local
`liveness/events.jsonl` write, fully detached and best-effort, so it can never block, slow, or fail
the local emit — and with the flag off or no console configured it is a true no-op. Enable it with:

```
FLOW_AGENTS_CONSOLE_LIVENESS_RELAY=1
FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL=<console>/records   # or FLOW_AGENTS_CONSOLE_URL / CONSOLE_TELEMETRY_URL + /records
CONSOLE_TELEMETRY_TOKEN=<bearer>   (or FLOW_AGENTS_CONSOLE_TOKEN_FILE)   ·   CONSOLE_TENANT_ID / FLOW_AGENTS_CONSOLE_TENANT
```

Untrusted fields (actor, subjectId, branch, artifact_dir) are JSON-escaped by `jq` at record
construction, so hostile control bytes are `\u`-escaped, never emitted raw.

The paired **console side** — ingesting `kontour.console.liveness`, the fleet OperatingState
projection (actors + held/reclaimable subjects + last-seen + per-session cost), and the ADR 0021 §4
janitor — is tracked in the console repo (**console #125**), and feeds the redesigned console
**Fleet** panel (its per-actor `coordinationState` is already wired to render the pills). Two-machine
visibility and the janitor sweep are console-side acceptance; this repo ships only the emit half.

### Phase 2 — authoritative fleet coordination

Opt-in, for teams that want cross-machine assignment arbitration:

- **Console `AssignmentProvider`** — a third implementation of the [assignment-provider contract](https://github.com/kontourai/flow-agents/blob/main/context/contracts/assignment-provider-contract.md),
  making assignment authoritative across machines (not just within one repo's GitHub board). Same
  `claim`/`release`/`supersede`/`status`/`list` operations; same effective-state join. This is also
  what lets [verify-hold](../coordination-guide.md#8-guard-point-3--the-verify-hold-publish-gate-the-one-hard-fence)
  enforce against a *fleet-wide* holder, not just a local one.
- **Tenant hardening** (console #98–#100) — close the schema-level gap: put an **explicit `tenant_id`
  on records** (decision) so tenancy is self-describing in the body, not only in the request header,
  hardening the phased auth model end-to-end.
- **Native init step** — `flow-agents init` gains a first-class, optional Console-integration step:
  configure the relay sink, tenant, and (Phase 2) the Console provider at install time, so joining a
  fleet is a setup choice rather than manual wiring.

## How CI fits (paired with #398)

The [CI-runtime actor identity tier (#398)](https://github.com/kontourai/flow-agents/issues/398) makes
CI sessions carry a **stable identity** (e.g. `github-actions:<run-id>` plus `GITHUB_ACTOR`/repo/SHA).
That has two payoffs here: the [verify-hold gate](../coordination-guide.md#1-the-actor-model--who-am-i)
upgrades from *advisory* to *enforcing* in CI, and CI becomes an **attributable participant** in the
fleet — its records land in the same Console projections, so team/project/individual insight views
include automated work, not just interactive sessions. #398 is the keystone that makes the Console
fleet view whole.

## Dogfooding

`console.kontourai.io` runs from the `console` repo; the deployment lives in `console-deploy` (the
dogfood instance). Flow Agents development itself is intended to run against it — the fleet view of our
own parallel Builder sessions is both the first real test and the first sales demo of the tier.

---

## Status

Designed and ratified ([ADR 0021 §7](../adr/0021-assignment-leases-and-stale-claim-takeover.md)); the
local substrate it builds on is complete (see the [coordination guide](../coordination-guide.md)). Phase
1 begins with console #73 (ApiSink) → flow-agents #295 (relay). This is forward-looking: no Console
integration ships in the coordination substrate itself — it is strictly the optional tier above it.
