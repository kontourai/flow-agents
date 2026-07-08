# Implementing Trust Reconciliation Correctly

> Status: DRAFT for review (not yet a merged doc). Companion to
> ADR 0017 (anti-gaming trust/security model), ADR 0020 (reconcile manifest +
> claim classification), and ADR 0022 (fail-closed delivery reconciliation).

This guide is the "how to build it without re-breaking it" companion to the
trust ADRs. Every principle below either drew blood in a real delivery or is
load-bearing config in `.github/workflows/trust-reconcile.yml`. If you are
porting this pattern to another repo/org, read this first.

## The one sentence to internalize

**The trust gate fires at PR time; after merge, the same bundle becomes an
audit record, not a gate.**

That single framing decides where the check lives and what the artifact is
_for_ at each stage:

- **At PR time** the reconcile job is a required, admin-enforced status check.
  It is the thing that prevents a bad merge.
- **After merge** the committed bundle is a dated, immutable receipt of what was
  claimed and how it was verified — provenance, not enforcement.

Get this wrong and you either gate on the post-merge `main` push (which either
no-ops or falsely fails — see §2) or you misjudge what the bundle is worth once
the work has landed.

## Gate mechanics (the non-obvious CI gotchas)

### 1. CI must re-run verification fresh; the bundle is only a divergence detector

Never let the reconcile job _believe_ the bundle's "pass." Re-run the canonical
verification in a clean CI environment the agent does not control, and use the
bundle solely to detect divergence ("claimed pass, CI fails" / "claimed pass,
command CI never ran" / "checkpoint-only bundle"). If your job reads the bundle
and trusts it, you have built theater, not a gate. This is invariant #1.

### 2. Fail closed on ambiguity — which forces full git history

Ownership is decided by: _is the bundle's checkpoint commit a git-ancestor of
(or equal to) the change's HEAD?_ (`git merge-base --is-ancestor`). On a shallow
clone that check is unresolvable (exit 128) and MUST be treated as stale/fail,
never pass. Therefore the reconcile job's checkout needs full history
(`fetch-depth: 0`); the default shallow clone would falsely stale every
legitimate bundle. Cause and required config travel together.

### 3. Compare against the PR head SHA, not the synthetic merge SHA

On a `pull_request` trigger, `github.sha` is GitHub's ephemeral merge commit
(`refs/pull/N/merge`) — a commit no locally-sealed checkpoint ever stamps. Use
`pull_request.head.sha` for the ownership comparison (fall back to `github.sha`
only on `push`/`workflow_dispatch`, where it IS the real commit). Get this wrong
and every bundle falsely stales. Silent footgun; call it out.

### 4. Post-merge is a deliberate no-op — don't re-gate it

A squash-merge creates a new commit with no git ancestry back to the
feature-branch commit the checkpoint was sealed against. The reconcile job on
the post-merge `main` push must be a loud no-op: gating already happened at PR
time. Event-scope enforcement by trigger (`pull_request` gates; `push` to `main`
observes). Do not "strengthen" this into a main-branch gate — it will only ever
falsely fail on squash ancestry.

### 5. Bundles seal to the work-commit and tolerate lag — don't regenerate per push

The ancestor check (§2) plus the fresh re-run (§1) absorb new commits landing on
top of a sealed checkpoint. Re-seal only when the _claim set_ materially
changes, not on every commit. A bundle sealed at commit A is still valid at
HEAD B as long as A is an ancestor of B. Building "regenerate on every push"
flows is brittle and unnecessary.

## Claims (and the single worst trap)

### 6. Separate executable manifest commands from human-readable evidence — never `bash -lc` the prose

If you build any re-check/backstop layer, it must reconcile ONLY against
declared, runnable manifest commands. Attestation summaries, check descriptions,
and acceptance-criteria prose are DATA, not code. Re-executing a check's
_summary_ as `bash -lc "<summary text>"` yields garbage exit codes (2/127) and
false "caught false-completion" alarms — noise that can mask a real failure
sitting in the same run. This is the highest-frequency failure mode observed in
practice; guard against it explicitly.

### 7. `not_verified`-by-design is correct, not a gap

An agent that cannot run a command-backed check should record it at
`not_verified` with the exact reconcile-manifest command attached; CI runs it
for real and reconciles. This is the auditor-session pattern. Do not let agents
"helpfully" self-mark those `pass` — that reintroduces gaming. Require every
command-backed claim to either name its exact manifest command or be typed
`external` (an independent-review/human attestation that CI does not re-run).

## Storage & retention (git is the authority)

### 8. Two stores, two retention tiers

Git is the authority: the bundle is committed (`delivery/<slug>/trust.bundle`)
and pinned to the merge commit — permanent, distributed, survives any console
outage. The database/console is a _rebuildable, queryable projection_ over those
bundles. Keep coarse audit records (bundles, decisions, gate/claim outcomes)
long; expire and roll up the fine-grained raw telemetry firehose. Retention here
is a cost decision, not a correctness one.

Rule of thumb from real data: one delivery ≈ a handful of small bundle rows; a
single working session ≈ tens of thousands of raw tool-event rows. The bundles
are not what grows — the raw event stream is. Prune the firehose; keep the
ledger.

### 9. Make the projection actually rebuildable from the authority

If the console cannot re-hydrate itself from the committed bundles across repos,
then "the DB is just a cache of git" is false in practice — a restart/wipe loses
queryability until producers re-push. If you claim the projection is derived,
build the backfill/import from `delivery/*/trust.bundle` that proves it.

### Bonus: "stale as history" is not "stale as current state"

A bundle is a dated receipt; it never becomes _wrong_, it only misleads if you
surface an old one as _current_ truth. The query layer answers "true now?" from
latest-state-per-subject and "true at commit X?" from the bundle. The same
principle keeps the audit ledger from leaking into the operational
"needs-attention" view — attention is a view-filter (terminal-state + recency),
never a delete-sweep of history.

## The tagline

**The agent proposes, CI disposes, git remembers, the console indexes — and
nothing re-executes prose.**
