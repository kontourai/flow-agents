---
status: needs-decision
subject: Embeddable engine and adapter model
decided: 2026-07-07
evidence:
  - kind: doc
    ref: docs/spec/runtime-hook-surface.md
  - kind: doc
    ref: docs/decisions/flow-flow-agents-boundary.md
  - kind: doc
    ref: docs/decisions/trust-ledger-retention.md
  - kind: pr
    ref: https://github.com/kontourai/flow-agents/pull/497
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/410
---

# Embeddable engine and adapter model

> Status: **proposed** direction (shaped with Brian Anderson, 2026-07-07). Not yet
> fully built. Ratify + carry forward as the runtime is factored. This record is
> the north star the adapter/port refactors implement against; the linked backlog
> issues are the work.

**Decision.** Flow Agents is one **runtime-agnostic engine** with **thin
adapters** on the edges. A development harness (Claude Code, Codex, opencode, pi,
Kiro) and a customer agent built on a framework/SDK (AWS Strands, VoltAgent,
LangGraph, OpenAI Agents SDK) are the **same shape**: both are adapters that feed
canonical Flow events into the one engine and honor the same contracts. A Flow or
Flow-Agent-Kit implementation should behave **consistently** across development
workflows and customer agent implementations, with **explicit callouts** wherever
a runtime genuinely cannot offer a Flow feature — never silent divergence.

Five rules follow.

1. **One core, adapters at the edge (DRY by construction).** The engine owns
   everything runtime-independent: the canonical event vocabulary, the redaction
   contract, project/session/actor attribution, dual-channel transport, trust
   bundles, gate/claim semantics, and state projection. An adapter's only job is
   to translate a runtime's native surface into canonical events and to invoke
   engine decisions — it holds **no policy of its own**. Today the harness
   adapters already prove this: one shared shell core
   (`scripts/telemetry/telemetry.sh` + `lib/*.sh`) with thin per-runtime JS
   adapters (~130 lines each) that normalize hook input and shell into the core.
   Duplicated logic across adapters is a bug against this record.

2. **Harness adapters and framework adapters are the same category.** A CLI
   harness emits events from shell hooks; an in-process framework emits the same
   canonical events from a language-native package — no shelling out, honoring the
   same redaction contract in-process. The difference is the **transport into the
   core**, not the **contract or the semantics**. `context.project`,
   `context.cwd` redaction, actor identity, and dual-channel routing are derived
   the same way everywhere (see `docs/spec/runtime-hook-surface.md`, which is now
   the canonical adapter surface, and PR #497 which made `context.project` a
   canonical field). Where the shell core cannot be reused verbatim in-process,
   the engine's runtime-agnostic logic is extracted to a language port the
   framework adapter calls; the shell adapter becomes one caller of that port, not
   the definition of it.

3. **Flow Agents is an "SDK" engine layer, and Console is its remote backend.**
   The same engine that instruments a dev session is the layer a customer embeds
   in their own agent to get Flow's trust/state/economics for free. When embedded,
   the **Console is the remote trust and state backend** for those SDK-embedded
   agents — the same projection surface described in
   `docs/decisions/trust-ledger-retention.md` (git/CI authoritative, console a
   rebuildable projection), now fed by customer agents as well as dev harnesses.
   The engine does not care whether the events came from a terminal or from a
   long-running service.

4. **Cooperative in-process, authoritative at the boundary ("agent proposes, CI
   disposes").** A framework/SDK adapter runs inside the customer's process, which
   the engine does not control, so in-process enforcement is **cooperative**: the
   embedded engine emits claims and honors gates as a good citizen. Authority
   lives at the trust boundary the customer does not own — the **Console ingest
   and CI trust-reconcile** re-verify what the agent claimed against independent
   results (the fail-closed reconciliation from
   `docs/adr/0022`). An adapter can be sloppy or hostile and the boundary still
   holds the line. This is the same posture that already governs harness delivery;
   it generalizes unchanged to embedded agents.

5. **Consistency is guaranteed by a conformance suite, not by hope
   (OpenTelemetry model).** Every adapter — shell harness or language framework —
   must pass a shared **conformance suite** that asserts the canonical contracts:
   event shape, redaction defaults (full local path never leaves the machine),
   attribution precedence, dual-channel routing, and gate/claim behavior. A new
   adapter is "done" when it passes the suite, exactly as an OpenTelemetry SDK is
   conformant when it passes the spec's tests. Feature gaps a runtime cannot close
   are declared **explicitly** in the adapter's conformance report, not left for a
   user to discover.

## Consequences / required refactors

The backlog issues that carry this direction:

- **Extract a runtime-agnostic core** (#500). The engine logic currently expressed
  in shell (`scripts/telemetry/lib/*`) must be factored so its policy — event
  canonicalization, redaction, attribution precedence, transport routing — is a
  reusable port with at least a shell binding (today) and a language binding
  (first framework adapter). No new policy may be added to an adapter that isn't
  in the core.
- **The artifact/state store becomes a pluggable port** (#501). Trust bundles,
  delivery records, and state projection are written today against a filesystem +
  git + Console assumption. For embedded agents that seam must be an interface
  (local-fs, git, Console-remote, customer-supplied) so the engine backend is
  swappable without touching adapters. This is the storage-port dependency of the
  Console-as-backend rule (3).
- **An adapter conformance suite** (#502) makes rule 5 checkable — one shared spec
  every adapter (harness or framework) must pass, with explicit gap declarations.
- **A first framework adapter proves the model** (#503). AWS Strands (the
  non-terminal runtime that motivated this) is the reference in-process adapter:
  it must emit canonical events in-process, honor redaction without a shell, and
  pass the conformance suite. Its explicit callouts define the template for "what
  a framework cannot do that a harness can."
- **`runtime-hook-surface.md` is promoted from a harness spec to the adapter
  contract** every adapter category conforms to.

## Rationale

The owner's model — "harness adapters and framework adapters would work in a very
similar if not exactly the same way, such that a Flow or Flow-Agent-Kit
implementation is consistent across development workflows and customer agent
implementations" — only holds if there is a single engine and the runtimes are
adapters over it. The alternative (per-runtime reimplementations that happen to
agree) drifts the moment two runtimes are maintained by different hands, which is
precisely the failure the numbered-ADR redesign already diagnosed elsewhere in
this portfolio. DRY here is not a style preference; it is what makes "Flow behaves
the same everywhere" a checkable property (rule 5) instead of a marketing claim.

Making Console the remote backend for embedded agents (rule 3) is the same
git-authoritative / console-projection split already ratified for trust retention;
it costs nothing new conceptually and turns the dogfood console into the customer
product surface. The cooperative-vs-authoritative split (rule 4) is the only
honest enforcement story for code running in a process we do not own, and it is
already how delivery reconciliation works — so embedding does not weaken the trust
model, it inherits it.

The explicit-callout requirement is the guard against the seductive failure mode:
quietly letting a framework adapter skip a Flow feature because it was hard,
leaving customers with an inconsistent product and no signal. A conformance report
that names the gap keeps the promise of consistency honest.

## Open questions

- **Language of the first extracted core port** (TypeScript is the source-policy
  default; the shell core stays as a binding). Tracked in the extract-core issue.
- **Conformance-suite substrate** — reuse the existing `evals/integration`
  harness vs a new adapter-conformance package.
- **Storage-port interface shape** and whether the Console-remote binding reuses
  the existing telemetry ingest or a dedicated port.

These are implementation decisions for the linked backlog; the direction above is
the fixed part.
