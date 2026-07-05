# Harness-capability matrix

**The signals a feature can rely on depend on which runtime/harness the kit is hooked into. State the
coverage; never assume it, never fabricate the gap.**

This is a cross-cutting contract: any feature whose data comes from telemetry (economics, delegation
efficiency, liveness, learning) must declare which signals it needs, which *class* each falls in, and
how it degrades when the current runtime does not expose one. A missing signal is rendered as
**unavailable**, distinct from a real zero — so a consumer never reads "harness-blind" as "measured 0."

## The load-bearing distinction: orchestrator-observable vs sub-agent-internal

Not all "we can't see inside the sub-agent" gaps are equal. Two classes:

- **Orchestrator-observable** — what our hooks see the *main agent* (the orchestrator) do. The
  orchestrator knows the prompt it dispatched, how many times it re-dispatched/re-prompted the same
  sub-agent, its own iteration/route-back count, and when it superseded or corrected a result. Our
  telemetry observes the orchestrator directly, so **these hold on any runtime that runs our hooks —
  no sub-agent introspection required.** This is where per-delegation *outcome* comes from.
- **Sub-agent-internal** — signals that live inside the sub-agent's own turn: its token usage, its
  internal reasoning, a verdict it computed but never surfaced to the orchestrator. Capturing these
  requires the harness to expose per-sub-agent instrumentation. **Most harnesses do not today**, so
  features that need them (e.g. per-delegation *cost*) must declare the signal unavailable and fall
  back to a coarser, honest proxy.

The practical upshot for #415: we can attribute **outcome** (accepted / rework / diverged / failed) from
orchestrator-observable behavior even though we cannot attribute **cost** per delegation — because
tokens are sub-agent-internal and outcome is not.

## The `signals` block

Every `kontour.console.economics` record carries a `signals` object declaring what the emitting runtime
exposed:

| Field | Class | Meaning |
| --- | --- | --- |
| `runtime` | — | the runtime that produced the record (`claude-code`, `kiro-cli`, `codex`, …) |
| `per_delegation_tokens` | sub-agent-internal | `true` iff the runtime isolates per-sub-agent token usage. **`false` on every runtime today** → per-delegation cost is unavailable; the console attributes cost at `(role, model)` granularity via `cost.by_model` instead. |
| `per_delegation_outcome` | orchestrator-observable | coverage of the outcome signal on this run: `full` (every delegation resolved to a real outcome), `partial` (some), `none` (delegations exist but none had a verdict/escalation/re-dispatch), `n/a` (no delegations observed). |

Consumers (console panels, `learning-review`) MUST read `signals` before rendering a metric: if the
signal a metric needs is unavailable, show "not measurable on this harness," not a misleading number.

## Per-runtime coverage (current, honest snapshot)

`✓` exposed · `partial` best-effort/orchestrator-derived · `✗` not exposed. Update this table as
runtimes add instrumentation — it is the single source of truth the `signals` values are stamped from.

| Signal | Class | claude-code | kiro-cli | codex | raw-model runner |
| --- | --- | --- | --- | --- | --- |
| whole-run tokens/cost (`by_model`) | run-level | ✓ | ✓ | ✓ | partial |
| delegation dispatch (role/model) | orchestrator-observable | ✓ | ✓ | partial | ✗ |
| re-dispatch / re-prompt count | orchestrator-observable | ✓ | ✓ | partial | ✗ |
| escalation (tier bump) | orchestrator-observable | ✓ | ✓ | partial | ✗ |
| supersession / correction | orchestrator-observable | partial | partial | ✗ | ✗ |
| per-sub-agent terminal verdict | mixed | partial | partial | ✗ | ✗ |
| per-sub-agent tokens/cost | sub-agent-internal | ✗ | ✗ | ✗ | ✗ |

"partial" for verdicts/supersession reflects that these depend on the workflow actually recording an
`evidence`/`verdict`/`supersession` event for the agent — capturable, but not guaranteed every run.
That is exactly why `outcome` degrades to `unavailable` rather than `accepted` when the event is absent.

## The doctrine (applies to any telemetry-dependent feature)

1. **Classify each signal** as run-level, orchestrator-observable, or sub-agent-internal. Prefer
   orchestrator-observable derivations — they are the most portable across harnesses.
2. **Declare coverage in-band** (a `signals`-style block) so a consumer can distinguish real-zero from
   harness-blind at read time.
3. **Degrade to an explicit `unavailable`**, never to a fabricated value. A cost you cannot attribute
   is not `$0`; an outcome you cannot observe is not `accepted`.
4. **Fall back to the coarsest honest proxy** when the fine signal is missing (per-delegation cost →
   `(role, model)` via `by_model`), and label the proxy as such.
5. **Keep this matrix current.** When a harness starts exposing a signal, flip the cell and the
   `signals` stamp follows — the feature "lights up" without a schema change.
