---
title: Parallel-Session Coordination Guide
---

# Parallel-Session Coordination Guide

This is the plain-language, end-to-end explanation of how Flow Agents lets **many sessions work the
same repository at once** without two of them silently taking the same work, redoing each other's
effort, or clobbering one another's changes at publish time.

> **Which doc do I want?** This page is the *living reference* for coordination — the model and the
> four guard points, as actually shipped. The frozen [ADRs](adr/) (0012, 0021, 0020, 0022) are the
> immutable record of *why* each decision was made; this guide is where you look to understand *what
> runs today*. The [System Guidebook](agent-system-guidebook.md) is the broader map of the whole
> operating layer. For the optional hosted tier that turns this local substrate into a team-wide
> fleet view, see [Flow Agents × Console](integrations/flow-agents-console.md).

---

## The problem, in one paragraph

You want to run *X* parallel Builder sessions and never think about collisions. That means four
moments in a session's life must be fenced: **selection** (don't pick work someone already holds),
**entry** (don't re-enter a subject someone else owns), **mid-flight** (notice fast if an overlap
happened anyway, and correct it), and **publish** (never let a session that was superseded while it
slept push over the session that replaced it). Everything else is convenience; those four are the
safety. Flow Agents makes all four advisory-by-default and cheap, with exactly **one hard fence** —
at publish — because a false block anywhere else would just annoy you, while a missing block at
publish loses work.

## The mental model: two independent streams, joined

Coordination is not one lock. It's **two independent, append-only signals about a subject** (a work
item / slug), joined at read time into a single *effective state*:

| Stream | Question it answers | Lifetime | Where it lives |
| --- | --- | --- | --- |
| **Liveness** | "Is someone *actively working* right now?" | Ephemeral — TTL-reaped, heartbeat-refreshed | `liveness/` event stream ([ADR 0012](adr/0012-agent-coordination-as-liveness-claims.md)) |
| **Assignment** | "Who *durably owns* this subject?" | Durable — an explicit claim record / GitHub assignee | `AssignmentProvider` ([ADR 0021](adr/0021-assignment-leases-and-stale-claim-takeover.md)) |

Neither alone is enough. Liveness without assignment can't tell a crashed session from a finished
one. Assignment without liveness can't tell an actively-working owner from a stale lease nobody is
servicing. **Joined**, they answer the only question that matters — *can I safely take this?* — and
the answer degrades gracefully when one signal is missing.

Here is the lifecycle, mapped to the code that fences each moment:

| Session phase | Guard point | Command / hook | Effect |
| --- | --- | --- | --- |
| **Selection** | pull-work preflight | `pull-work` skill → `assignment-provider status` | Excludes `held`/`reclaimable`; asks first on `human-held` |
| **Entry** | ensure-session ownership guard | `workflow-sidecar ensure-session` | `free`→claim; `reclaimable`+`--supersede-stale`→take over; `human-held`→ask |
| **Mid-flight** | liveness heartbeat + supersession steering | Activity hooks + `workflow-steering.js` | Refreshes the claim; warns every turn if you were superseded |
| **Exit** | Stop-hook clean release | Stop hook → `liveness release` + assignment release | Frees both streams, leaves a handoff note |
| **Publish** | verify-hold gate (**the one hard fence**) | `workflow-sidecar verify-hold` inside `publishDelivery` | Blocks a superseded/zombie session from pushing |

The rest of this guide walks each layer bottom-up: first *who am I* (the actor model — the part that
caused the most bugs, so it goes first), then the two streams, then the join, then each guard point,
then how delivery itself is made tamper-resistant.

---

## 1. The actor model — "who am I?"

Every claim, heartbeat, and ownership check is attributed to an **actor**. Getting actor identity
subtly wrong is what caused nearly every hard bug in this substrate (#291, #292, #293), so understand
this section before the rest.

### The resolution chain

`resolveActor(env)` (in the canonical `scripts/hooks/lib/actor-identity.js`, loaded by TypeScript consumers rather than mirrored) returns
`{ actor, source }` by trying four sources in strict priority order:

1. **`explicit-override`** — `FLOW_AGENTS_ACTOR` is set. The actor is the **bare token** you provided,
   verbatim. Source string: `"explicit-override"`.
2. **`runtime-session-id:<runtime>`** — the host runtime exposes a native session id. For Codex,
   `CODEX_THREAD_ID` is preferred over the legacy-compatible `CODEX_SESSION_ID`. The raw thread id
   is never persisted: it becomes a domain-separated 96-bit `thread-<digest>` token. The actor is a **serialized triple** `runtime:session:host`. Source string:
   `"runtime-session-id:<runtime>"`.
3. **`process-ancestry`** — no session id; identity is derived from the parent process and start
   time. It is serialized explicitly as `process-ancestry:anc-<digest>:<host>`, never as an
   `unknown` runtime. Source string: `"process-ancestry"`; this remains unstable/advisory.
4. **`unresolved`** — nothing worked. Source string: `"unresolved"`.

The `"local"` literal default from the old design is **retired as an error, not a fallback** — a
shared default actor structurally defeats collision detection on the one machine (your laptop) where
co-located sessions are most likely.

### The seam that caused the bugs: flat token vs. serialized triple

Here is the trap. An **override** actor is a *bare token* (`alice`). A **derived** actor is a
*serialized triple* (`claude:sess-abc:host`). So there are two different string forms for "the
actor," and they **diverge for override actors but agree for derived actors**:

- `resolveActor(env).actor` → the canonical form (bare token for overrides; triple for derived).
- `serializeActor(actorStruct)` → **always** a triple `<runtime>:<session>:<host>`. For an override
  actor the struct's `<runtime>` is whatever the reconstructing site fills in (`detectRuntime()`,
  typically `unknown`, in `assignment-provider.ts`), so it serializes to something like
  `unknown:alice:host` — **not** equal to the bare `alice` the rest of the system uses. The exact
  prefix doesn't matter; what matters is that the serialized form is a triple and the canonical form
  is a bare token, so the two **diverge for override actors** (and happen to agree for derived ones).

Every other surface — `liveness whoami`, `liveness claim --actor`, per-actor `current.json`,
pull-work's `--self-actor` — uses the canonical `resolveActor().actor` form. If a self-recognition
check compared the *serialized* form of a stored claim against the *canonical* self, an override
session would **fail to recognize its own claim** and either double-claim or false-block itself.

### The fix: a canonical `actor_key` on every record

Claim records carry an explicit `actor_key` field (schema ≥ 1.0): the canonical
`resolveActor(env).actor` string of the claiming actor. Self-recognition and the liveness join always
compare against **this**, with a backward-compatible fallback for pre-#291 records:

```
holderActorKey = record.actor_key || serializeActor(record.actor)
```

A record written by a current session has `actor_key` and compares canonically; an old record without
it falls back to `serializeActor`, reproducing pre-#291 behavior exactly. This one field is why the
override/derived divergence no longer bites.

Historical `unknown:anc-*` values remain opaque, readable actor keys and are not rewritten or
aliased. Because ancestry is intentionally unstable, a process crossing this upgrade boundary may
need to release/reclaim rather than treating the old and new display forms as the same identity.

### Stable vs. unstable identity (this powers the publish gate)

The `source` matters beyond attribution. An identity is **stable** if it came from
`explicit-override` or `runtime-session-id:*` — those are reproducible across a session's lifetime. It
is **unstable** if it came from `process-ancestry` or `unresolved` — those can shift (e.g. a CI job
with a different process tree on each step). The publish gate (§8) *enforces* only for stable
identities and degrades to advisory for unstable ones, because a hard block keyed on an identity that
might not reproduce would false-block legitimate work. Making CI identity stable is the subject of the
forthcoming CI-runtime identity tier (#398).

---

## 2. The liveness stream — "is someone working right now?"

Liveness ([ADR 0012](adr/0012-agent-coordination-as-liveness-claims.md)) is an **advisory,
append-only** stream of `claim` / `heartbeat` / `release` events, one file under `liveness/`, reaped
by TTL. It is computed, never authoritative:

- A session **claims** a subject when it starts working it, and **heartbeats** on activity to refresh
  freshness. Auto-emit is wired into the lifecycle (default-on since #288).
- A holder is **fresh** if its most recent event is within the TTL window; **stale** otherwise.
- On clean exit the session emits **release**; on a crash it simply stops heartbeating and ages out.

Liveness answers "active *now*," cheaply and without provider mutation. It cannot, alone, distinguish
"crashed mid-work" from "finished and moved on" — that's what assignment adds.

Helpers: `scripts/hooks/lib/liveness-read.js` reads the stream; `liveness whoami` prints the current
actor; `workflow-sidecar liveness claim|heartbeat|release` manage events.

---

## 3. The assignment layer — "who durably owns this?"

The `AssignmentProvider` ([ADR 0021](adr/0021-assignment-leases-and-stale-claim-takeover.md),
`src/cli/assignment-provider.ts`) is the durable half. It's an abstraction with two implementations
behind one contract ([`context/contracts/assignment-provider-contract.md`](https://github.com/kontourai/flow-agents/blob/main/context/contracts/assignment-provider-contract.md)):

- **`github`** — maps ownership onto native GitHub primitives: **assignee** (the durable claim),
  **label** (the state), **comment** (the audit trail). This is the shared-truth provider for a team.
- **`local-file`** — a per-repo claim record on disk, for solo/offline use.

Operations: `claim`, `release`, `supersede`, `status`, `list`. A claim record is versioned
(`schema_version: "1.0"`) and carries the canonical `actor_key` (§1), a `claimed_at`, and an
`audit_trail` of `claim`/`release`/`supersede` transitions.

### Render-don't-execute

A crucial design rule ([ADR 0021](adr/0021-assignment-leases-and-stale-claim-takeover.md), Decision
1): **the CLI never runs `gh` itself.** For the `github` provider it emits the exact `gh` argv and
comment bodies as pure data; the skill layer executes them via the harness Bash tool (argv arrays,
never shell strings). No `gh` subprocess exists in `src/`. This keeps the trust boundary clean and the
provider testable.

---

## 4. The join — assignment ⋈ liveness → effective state

`computeEffectiveState()` (`src/cli/assignment-provider.ts`) joins the two streams into one of four
**effective states**, each with a specific machine-readable `reason`. This table *is* the coordination
logic — everything downstream is a policy over these outcomes:

| effective_state | reason | Meaning |
| --- | --- | --- |
| `free` | `no_assignment_no_liveness` | Nobody owns it and nobody is working it. Take it. |
| `held` | `self_is_holder` | *You* hold it (canonical `actor_key` matches self). Proceed. |
| `held` | `fresh_liveness_heartbeat` | Someone else holds it **and** is actively heartbeating. Hands off. |
| `held` | `liveness_claim_present_assignment_lagging` | Liveness present but **no durable assignment yet** — an actively-working session that hasn't recorded a durable claim. |
| `reclaimable` | `assignment_present_liveness_stale_or_absent` | A durable assignment exists but **nobody is heartbeating** — a stale lease / crashed or finished session. Eligible for takeover. |
| `human-held` | `assignee_is_human` | A human is assigned. **Ask first**, always. |
| `human-held` | `assignee_without_claim_record` | A human assignee with no agent claim record. **Ask first.** |

Two subtleties worth internalizing:

- **`held / liveness_claim_present_assignment_lagging`** is "working but not yet durably claimed." It
  is a *hold* (don't barge in) but it is **not** an assignment-backed conflict — which is exactly why
  the publish gate treats it as a pass (§8).
- **`reclaimable`** is the takeover-eligible state: the durable owner is gone (stale/absent liveness)
  but left a lease. Reclaiming it is deliberate and gated (§7, §10), never automatic.

---

## 5. Guard point 1 — pull-work selection

When a session selects work, the `pull-work` skill computes the join for each candidate and **excludes
anything not takeable**: `held` and `reclaimable` subjects are filtered out; `human-held` triggers an
ask-first prompt rather than a silent skip. Only after selection does it **emit** — first a liveness
claim, then (via render-don't-execute) the assignment claim. This is what stops *N* concurrent sessions
from all classifying the same issue "ready" and all taking it. Selection reads and writes both streams;
it never mutates a provider it hasn't been told to.

## 6. Guard point 2 — ensure-session ownership guard

`workflow-sidecar ensure-session` (`src/cli/workflow-sidecar.ts`, `enforceEnsureSessionOwnership`) is
the fence at **entry** — the moment a session commits to a subject. It computes the effective state and
branches:

- **`free`** → claim and enter.
- **`self_is_holder`** → already yours; enter.
- **`reclaimable`** → enter **only** with an explicit `--supersede-stale`; that performs a `supersede`
  (recording the takeover in the audit trail) and enters. Without the flag, it stops and explains.
- **`held` (someone else, fresh)** → stop; someone is actively working it.
- **`human-held`** → stop and ask first.

It resolves *self* through the same `resolveActor` path and compares on the canonical `actor_key`, so
an override session recognizes its own in-progress claim (this is the seam from §1). Every untrusted
field it echoes back (holder actor, `last_at`, branch) is sanitized at construction — see §9.

## 7. Guard point 4 — Stop-hook clean release

On clean session end, the **Stop hook** releases *both* streams: `liveness release` plus an assignment
release, and writes a **handoff note** so the next session (human or agent) picks up from recorded
state rather than guesswork. A crash skips this — and that's fine: the liveness claim simply ages out
to `stale`, the assignment becomes `reclaimable`, and takeover (§10) handles it. Clean release just
makes the common case instant instead of TTL-delayed.

**Ownership scoping (#440):** the Stop hook's evidence scanning, its non-terminal release (above), the
tool-activity liveness heartbeat, and the SessionStart/UserPromptSubmit re-ground banner all resolve
**only** from the stopping/heartbeating/steered actor's own per-actor `current/<actor>.json` pointer
when that actor is resolved — never from the shared legacy `current.json` or a repo-wide newest-mtime
scan, which would otherwise let a session co-located with another actor's work inherit that actor's gate
debt or steer onto its slug. Accepted gap: a resolved actor with no per-actor pointer yet (pre any
`workflow-sidecar` command in this session) is simply ungated/unbannered until its next sidecar command
establishes one — never gated on another actor's unrelated work. An unresolved actor keeps the pre-#440
legacy-fallback behavior unchanged (compat + anti-gaming: identity cannot be unset to escape the gate).

## 8. Guard point 3 — the verify-hold publish gate (the one hard fence)

This is the **only** place coordination *blocks*, and it earned three fix iterations, so its design is
the most carefully tuned in the system. It lives in `runVerifyHold` and composes into `publishDelivery`
(`src/cli/workflow-sidecar.ts`) as a distinct fail-closed tier.

**The scenario it exists for:** a session claims a subject, goes idle (laptop sleeps), gets
legitimately superseded by another session that finishes and merges. The first session wakes and tries
to push — over the top of the work that replaced it. Nothing upstream catches this, because the zombie
*was* the valid holder when it started. The publish gate is the backstop.

**The converged rule — enforce narrowly, degrade safely:**

> The gate **blocks (hard)** only when **(1) the session's identity is stable** (`explicit-override`
> or `runtime-session-id:*`, or an explicitly-passed `actorKey`) **AND (2) there is a durable
> assignment conflict** — the effective state is `reclaimable`, an assignment-backed `held`-by-another,
> or `human-held`. In every other case it **degrades to advisory** and passes.

Concretely:

- **Unstable identity** (`process-ancestry` / `unresolved`) → short-circuits to
  `{ ok: true, effective_state: "not_evaluated", reason: "actor-identity-unstable-advisory-only" }`.
  It never hard-blocks on an identity that might not reproduce. (This is why CI, which currently
  resolves via ancestry, gets advisory treatment — and why #398, giving CI a stable identity, upgrades
  it to enforcing.)
- **Liveness-only hold** (`held / liveness_claim_present_assignment_lagging`) → **passes.** There is no
  durable assignment conflict; blocking here would false-block a legitimate publish.
- **Genuine durable conflict + stable identity** → throws `NotFreshHolderError`
  (`.code === "VERIFY_HOLD_NOT_FRESH_HOLDER"`), which `publishDelivery` refuses to swallow.

**Why this doesn't weaken zombie protection:** a superseded session *always* leaves a durable
assignment record (supersede writes one), and a real interactive session *always* carries a stable
identity. So the exact case the gate must catch — a stable session whose durable claim was superseded —
always lands in the enforcing branch. The advisory degradations only ever apply to cases that were
never a real conflict.

**The load-bearing lesson** (captured as a learning + a deliver-guidance correction): a hard block
added to a *shared* code path (`publishDelivery` is traversed by every delivery and many tests) must
**default to advisory and enforce only on high-confidence signals.** Two of the three defects were
*false-blocks* invisible to all eight acceptance criteria and two review passes — because every AC
scenario naturally used a stable identity with an assignment record. They only surfaced when CI's broad
suite ran under a *neutral* (ancestry) identity. Targeted ACs and a broad-suite-under-neutral-identity
are **different safety nets**; a hard-block-on-shared-path change needs both.

## 9. The injection-safety invariant (everywhere untrusted fields are echoed)

Coordination reads fields written by *other* sessions — actor, holder, `last_at`, branch,
`artifact_dir`, reason. These are **untrusted** and flow into agent-facing output, so a hostile value
could inject instructions or blow up a display. The invariant, applied at *construction* (not at print
time), everywhere such a field crosses into output:

```
stripControlCharsForDisplay(value).slice(0, 64)   // (larger caps for known-long fields, e.g. reason → 240)
```

This class recurred across #287/#320/#290/#291/#293. The subtlest miss: sanitizing only the
*discriminated* field (`actor`) while a sibling (`last_at`) slipped through raw — fixed by sanitizing
the *whole holder object* at construction. `safeStateText` in `workflow-steering.js` was found to only
collapse whitespace (not strip control chars) and was hardened. When you add a new field to any
coordination output, sanitize it at construction — no exceptions.

## 10. Takeover protocol (forthcoming — #294)

Takeover is the deliberate reclaiming of a `reclaimable` subject. The pieces already exist —
`reclaimable` detection (§4), `--supersede-stale` entry (§6), supersede audit records (§3), and the
publish gate that catches the woken zombie (§8). #294 is the remaining slice that ties them into a
first-class protocol: **stale detect → grace beat → supersede → resume the branch**, with the original
session caught cleanly at publish if it ever wakes. Until it lands, takeover works via the manual
`ensure-session --supersede-stale` path. *(This section describes intended behavior; #294 is not yet
shipped.)*

---

## How delivery itself is made tamper-resistant

Coordination decides *who* may publish; the **delivery machinery** makes the publish itself honest and
non-colliding. Three mechanisms
([ADR 0020](adr/0020-trust-reconcile-manifest-and-claim-classification.md),
[ADR 0022](adr/0022-fail-closed-delivery-reconciliation-with-governed-exemptions.md)):

**Per-session delivery paths (#379).** Each session writes its bundle under `delivery/<slug>/` instead
of a shared `delivery/trust.bundle`. Two sessions delivering concurrently no longer overwrite each
other; CI selects prefer-newest. (A recurring publish trap: after a soft-reset, `git add -A` would
stage the *deletion* of other sessions' `delivery/<slug>/` dirs — always restore sibling delivery dirs
from `origin/main` before committing.)

**Three-tier fail-closed `publishDelivery`.** Publishing passes through, in order:
1. **fail-soft** — absent/repo-root bundle is tolerated (nothing to publish).
2. **shape gate (#356)** — `InvalidBundleShapeError` (`.code === "RECONCILE_PREFLIGHT_INVALID_SHAPE"`):
   an invalid *bundle shape* is refused before anything is copied into `delivery/`.
3. **hold gate (#293)** — `NotFreshHolderError` (§8): a valid-shaped bundle from a superseded holder is
   refused.

These are **distinct error types**, asserted by `.code`/`instanceof` (not message text) so a future
refactor can't silently collapse them.

**reconcile-preflight (#356).** A local, pre-push mirror of the CI reconcile check, sharing
`scripts/lib/reconcile-shape.js` so it can never drift from CI. It runs the *same* shape classification
CI enforces, catching an invalid bundle on your laptop instead of in a red CI run. Its one deliberate
difference is the `onUnderivable` mode: CI passes `'fail'` (fail-closed — an underivable status fails
the run); the local preflight may pass `'reduce'` (trust a session-local self-reported status when
re-derivation is unavailable). The default is `'fail'`, so nothing degrades to fail-open by accident.

**Staleness binding (ADR 0022).** A checkpoint's `commit_sha` must be an ancestor of `HEAD`, achieved
by *sealing at the parent commit*: soft-reset `HEAD~1` → seal → publish → recommit. This binds a bundle
to the exact history it attests, so a stale bundle can't be replayed onto a moved branch.

The canonical publish sequence that ties coordination + delivery together:

```
rebase early  →  seal at parent (commit_sha = HEAD~1)  →  reconcile-preflight (local backstop)
              →  restore sibling delivery/<slug>/ dirs  →  verify-hold  →  push
```

---

## Where this goes next: the Console tier

Everything above runs **locally** and needs no server — that's the design invariant (the Console is
never required). The optional [Kontour Console](integrations/flow-agents-console.md) tier turns this
per-repo substrate into a **team-wide fleet view**: a liveness relay so you can see every teammate's
active sessions, project/team economics and insight views alongside your own, an in-hub janitor that
reaps stale claims centrally, and — eventually — a Console-backed `AssignmentProvider` so assignment is
authoritative across machines. It also makes CI a first-class, attributable participant (paired with
#398). See the [Flow Agents × Console integration doc](integrations/flow-agents-console.md) for the
phased plan.

---

## Provenance

This guide is the living reference. The decisions behind it are recorded, immutable, in the ADRs it
links; the ratified subject decisions live in [`docs/decisions/`](decisions/index.md)
([agent-coordination](decisions/agent-coordination.md), [trust-reconcile](decisions/trust-reconcile.md)).
Shipped across issues #287 (actor identity), #288 (liveness), #289 (branches), #166 (pull-work), #320
(overlap), #290 (AssignmentProvider), #291 (ensure-session guard), #292 (stop-release), #356
(reconcile-preflight), #293 (verify-hold); #294 (takeover) and #398 (CI identity) forthcoming.
