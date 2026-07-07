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

#### Economics record — flow-agents side (shipped, #349)

Every kit-driven run emits **one per-run economics record** — a `kontour.console.economics` v0.1 fact
carrying `cost`, `time`, `iterations`, and `defects` caught — so "flow kits save money and produce
more accurate results" becomes a **measurable, falsifiable** claim. It is the measurement substrate
for the Kit-economics telemetry initiative and is consumed by the baseline harness (#350), the
small-model headline (#409), and the console value view (console #117). The full field-by-field
contract is in [`docs/specs/economics-record-contract.md`](../specs/economics-record-contract.md).

The emitter (`scripts/telemetry/economics-record.sh`) is modeled byte-for-byte on the liveness relay:
it assembles the record with a **single `jq -c` filter** (valid JSON + `\u`-escaping of every untrusted
field — `task_slug`, model names, finding text) and hands off to the **same** `console_post_json`
transport core (endpoint-allow gate, `Bearer` + `x-console-tenant-id`, detached fire), shared not
forked. It is wired into the telemetry **stop path** (`add_stop_data_and_emit_usage` in
`scripts/telemetry/telemetry.sh`): right after the `session.usage` event is emitted, the economics
record is assembled from that event's `.usage` block (token/cost **ground truth** parsed by
`usage_parse_transcript` from the transcript — never re-estimated) joined with the run's review
sidecars (`critique.json` for defects, `state.json` for verdict / phase / iterations).

It is **strictly local-first** (ADR 0003 call 6): the record is **always** written to the local
economics log (`<TELEMETRY_DATA_DIR>/economics.jsonl`) *first*; only then is a **detached, opt-in,
best-effort** POST fired — a true no-op when the relay flag is off or no console is configured, and
`exit 0` on every failure path so it can never block, slow, or fail a run. flow-agents emits a per-run
**fact**, never a rollup — economics aggregation and the value view are console-side **projections**
over the immutable record stream (ADR 0003 call 3). Tenancy is stamped console-side from the verified
principal (call 2); the record's `tenant_id` is self-description only. Structurally, `cost` and
`defects` are **co-required** in the schema (the R7 Goodhart guard) — no consumer can render "cheaper"
without also rendering "and here is what it caught / missed." Enable the relay with:

```
FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL=<console>/records   # or FLOW_AGENTS_CONSOLE_URL / CONSOLE_TELEMETRY_URL + /records
CONSOLE_TELEMETRY_TOKEN=<bearer>   (or FLOW_AGENTS_CONSOLE_TOKEN_FILE)   ·   CONSOLE_TENANT_ID / FLOW_AGENTS_CONSOLE_TENANT
```

#### Economics relay config (default-on, opt-out — #469)

Like the telemetry mirror (see the "Owner machine mirror" section of
[`docs/agent-usage-feedback-loop.md`](../agent-usage-feedback-loop.md)), the economics relay is
now **config-driven** rather than requiring the env vars above to be exported by hand: once a
Console telemetry sink is configured (`console_telemetry_url` / `console_telemetry_endpoint_url`
in a trusted conf), the relay turns on **automatically**. It rides the exact same trusted-conf
gate as the telemetry mirror — `.kontourai/telemetry-console.conf` or
`~/.flow-agents/telemetry-console.conf`, mode `600` and owned by the current user — and the same
`https://`/`localhost` transport allowlist (`console_telemetry_endpoint_allowed` in
`scripts/telemetry/lib/transport.sh`). The derived endpoint is `<console-origin>/records` — the
same shared kind-routed ingress the liveness relay uses, and **distinct** from the telemetry
mirror's `/api/telemetry/records` path. An explicit `console_economics_relay=0` conf key, or
`install-console-config.sh --no-economics-relay`, opts back out; `console_economics_endpoint_url`
overrides the derived endpoint when needed. Full resolution order is documented in
[`docs/specs/economics-record-contract.md`](../specs/economics-record-contract.md#enabling-the-relay-config-driven-opt-out--469).

On the console side, `POST /records` already accepts the `kontour.console.economics` kind into a
per-tenant `EconomicsStore`, read back via `GET /api/economics` (console #117) — deployed.

The paired **console side** — ingesting `kontour.console.liveness`, the fleet OperatingState
projection (actors + held/reclaimable subjects + last-seen + per-session cost), and the ADR 0021 §4
janitor — is tracked in the console repo (**console #125**), and feeds the redesigned console
**Fleet** panel (its per-actor `coordinationState` is already wired to render the pills). Two-machine
visibility and the janitor sweep are console-side acceptance; this repo ships only the emit half.

#### Multi-tenant install runbook (adding tenant #2 to an existing install)

Installing a second tenant against the same Console instance is a **one-command** operation, with
either installer entry point:

```
npx @kontourai/flow-agents init --telemetry-sink kontour-hosted-console --console-tenant <tenant-id> --console-token-file <path>
```

```
bash install.sh <workspace> --telemetry-sink kontour-hosted-console --console-tenant <tenant-id> --console-token-file <path>
```

Both forms drive the same mechanism. `install.sh` collects the Console-related flags into
`CONSOLE_CONFIG_ARGS` (`install.sh:21,24-27`) and passes them straight through to the installed
`scripts/telemetry/install-console-config.sh` once the bundle is copied into place (`install.sh:54-55`).
`flow-agents init`'s `installBundle()` shells out to that same freshly-installed `install.sh` with the
equivalent flags (`src/cli/init.ts:385-408`); when a raw token value (rather than a file) is supplied,
`installBundle()` first writes it to a private `mkdtemp` file with `mode: 0o600` before passing
`--console-token-file` through (`src/cli/init.ts:390-398`), so a bearer token never sits in argv or an
unprotected file even transiently.

**Token provisioning** is console-side, not flow-agents-side: see the "Ingest" bullet above — tokens
are configured through `CONSOLE_AUTH_TOKENS_JSON`. Issuing tenant #2 a token, or rotating an existing
one, is entirely console-repo scope; this repo only ever consumes a token file/value handed to it by
that process, it does not mint or manage tokens itself.

**Idempotency:** re-running the installer (e.g. to update a tenant's token after rotation, or to add
`--console-tenant` to an install that didn't originally have one) is safe to repeat. `set_config_key`
in `install-console-config.sh` (lines 88-100) rewrites `telemetry.conf` by awk-filtering out any
existing `key=` line for that key and appending the new value, so re-running with the same or updated
flags updates the same conf keys in place rather than duplicating or appending stale entries.

**Post-install verification:** run

```bash
flow-agents telemetry-doctor --dest <workspace> --json --headless
```

and check the `console` block of the report: `tokenConfigured` and `tenantConfigured`
(`src/cli/telemetry-doctor.ts:208-209`) should both be `true`, and `reachability`
(`src/cli/telemetry-doctor.ts:210`) should report `ok: true` for a healthy install. A misconfigured
tenant install typically shows `tenantConfigured: false` (no `--console-tenant` at install time) or
`reachability.ok: false` (endpoint unreachable, or the token was rejected).

**Isolation proof:** `evals/integration/test_console_tenant_isolation.sh` installs two distinct
tenants side by side through this exact `install-console-config.sh` → `config.sh` → `transport.sh`
path against a local HTTP stub, and asserts each tenant's outbound POST carries only its own
`x-console-tenant-id` and bearer token, never the other's. This proves the **client-side wire
contract** — that a correctly configured install sends the right headers for the right tenant. It
does **not** prove server-side tenant isolation or enforcement (that a token cannot be used to read
another tenant's data); that remains Console-repo scope (console #98–#100 tenant hardening, see
*Phase 2* below).


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
