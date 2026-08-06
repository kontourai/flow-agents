---
status: current
subject: Console record delivery
decided: 2026-07-29
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1073
  - kind: issue
    ref: https://github.com/kontourai/console/issues/268
  - kind: adr
    ref: docs/adr/0021-assignment-leases-and-stale-claim-takeover.md
  - kind: doc
    ref: scripts/liveness/relay.sh
---
# Console record delivery

Delivery class is a property of the record class, declared once. It is not a
per-script choice, and it is not decided by which transport a caller happened to
reach for.

## The two shapes, and why they want opposite guarantees

Console's ingest already models both, and stores them differently:

- **Events** append (`events/<producer>/<scope>.jsonl`; one row per record id).
- **Projections** upsert (`projections/<producer>/<scope>.json` locally; hosted,
  `on conflict (tenant_id, record_id) do update set` guarded so a late snapshot
  cannot clobber a newer one).

That difference is the whole decision:

A **projection is a fold of current state, so it is self-healing.** Any
successful emission repairs every prior miss. Dropping one costs *freshness,
never correctness* — the board may lag, it cannot be wrong.

An **event is an independent fact, so a miss is a hole** — and an invisible one:
nothing distinguishes "no verdict was recorded" from "the verdict was lost."

## Decision

**Board state — "where is this work, is it done" — is derived from a fold, never
from event replay.** It is emitted as a projection over durable local state
(`trust.bundle` + `state.json`), upserted per scope. Best-effort delivery is
correct here *because* the next emission repairs the last miss. A read surface
must be derivable from state that can be re-read, not from a stream that had to
be caught.

**Receipts — gate claims, critiques, verdicts, releases — are events, delivered
at-least-once**, with a local outbox (append, detached flush, mark-sent, re-flush
unsent on the next run) and gap detection. `/records`' idempotent upsert makes
at-least-once safe. Only this class justifies the cost.

**At-least-once without gap detection is theatre.** If a class cannot answer
"which records never acked," it has retries, not durability. Gap detection is
therefore required for the receipt class and pointless for the others.

### Class assignment

| Class | Examples | Posture | Why |
| --- | --- | --- | --- |
| Receipts | gate claims, critiques, verdicts, releases | at-least-once + gap detection | loss is silent and material |
| Board / workflow state | flow position, completion | projection fold, upserted, best-effort | self-healing; loss costs freshness only |
| High-frequency observation | per-tool-use hooks, heartbeats | best-effort, fire-and-forget | statistical; an outbox here puts I/O on the hot path of every tool call |
| Periodic aggregates | kit economics per run | replay on next run | re-derivable from local state; per-run, not per-event |

Best-effort for hook telemetry and liveness is the *correct* answer, not a
compromise. The test is whether loss is **both silent and material**; if loss is
detectable or immaterial, durability buys nothing and costs latency.

## Consequences

**Filesystem scraping is retired, not extended.** Today trust facts are written
to gitignored, worktree-local projection files and later scraped by a bridge bin
(`kontour-process-bridge` and a proposed `kontour-trust-bridge`). That model
loses receipts whenever a worktree is pruned, and makes Console's contents a
function of when a scraper last ran. Flow Agents emits instead — the shape
`scripts/liveness/relay.sh` already uses, posting through the shared
`console_post_json` core to `POST /records` after the durable local write.
A `kontour-trust-bridge` bin should **not** be built; it would entrench the
scrape path.

**Console renders core primitives; kits contribute their own outcome views.** Console represents
Flow and Flow Agents — runs, claims, trust bundles, attestation, provenance tier. Those are
generic. A kit's *outcome* is not: "merge-ready" belongs to Builder Kit, and another kit composes
the same evidence into something else entirely. So Console should not hardcode a kit's vocabulary
as a first-class view; it should expose an extension surface a kit contributes to, the way
Station's manifest-driven plugin UI lets a plugin contribute layouts. Ideally the same contract
rather than a second parallel one — a kit that already describes its surfaces should not have to
describe them twice in a different shape. Baking "Merge Readiness" into core Console would put a
Builder Kit concept in the product every other kit also has to live with.

**Records carry the provenance tier established at delivery.** A receipt is not just a fact that
something happened; it is a fact with a provenance, and Console must never render
`independently-verified` and `self-asserted` identically — if it does, the signing is decorative
and Console is only as trustworthy as its weakest accepted producer. The tier is defined once, in
[trust-reconcile](./trust-reconcile.md#delivery-provenance-is-an-attestation-not-a-claim); Console
displays it rather than deciding it, and a kit's view interprets it rather than redefining it.

**Local-first is unchanged.** The durable local write happens first and remains
authoritative; Console is the tenant's durable mirror, not the enforcement point.

**Liveness stays advisory.** A missed *release* degrades a lane to `reclaimable`
on TTL — safe, self-correcting. A missed *claim* is the dangerous direction:
Console would show free while the lane is held. That is tolerable only because
the authoritative liveness write is local and precedes the relay. Any capability
that ever *enforces* on the Console fleet view needs the projection treatment,
not best-effort events.

**One core, two modes.** The single shared transport keeps its
"one core, never forked" rule and grows an at-least-once path behind it, selected
by declared class. Today the guarantee diverges by implementation language
instead: the bash `console_post_json` is `curl --connect-timeout 2 --max-time 5`,
detached, no retry, quiet `exit 0`; the JS `ApiSink` carries `maxAttempts`,
`retryBackoffMs`, and a `sentIds` dedup set. Nobody chose that split.
