---
title: "ADR 0017: The Anti-Gaming Trust Security Model — Layered Defense + External CI Anchor"
---

# ADR 0017: The Anti-Gaming Trust Security Model — Layered Defense + External CI Anchor

Status: Accepted

## Context

Flow Agents runs an autonomous coding agent that produces work and *reports its own
completion* through a trust gate (the Stop hook `stop-goal-fit.js`, ADR 0010 / ADR 0004):
the agent records evidence/claims into a `trust.bundle`, and the gate decides whether the
work may be marked complete.

This is a self-grading exam. The motivating question (from the owner): *"How do I know the
agent isn't leaving a security hole it will use to tamper with the process later?"* The
honest answer is that you cannot trust the agent's self-report, and — critically — you
cannot trust the **author of the gate** either: an agent that builds the gate can build a
hole into it while truthfully reporting "all tests green."

This ADR records the threat model, the layered defense that resulted from a 7-round
adversarial-hardening loop (PRs #213–#228), what each layer does and does **not** defend,
the residuals, and how the whole thing is activated.

## Threat model

The adversary is the running agent itself (or a future agent), which has shell access and
can write any file in the workspace. The defining property the loop kept rediscovering:

> **The gate's strongest checks key off agent-controlled inputs.**
> `state.json.status` (completion gating + block regime), command strings (exit-code
> laundering like `npm test || true`), the sourced shell profile (`FLOW_AGENTS_GOAL_FIT_MODE=off`),
> and the gate/CI source itself are all writable by the agent.

A gate that runs *inside* the agent's environment and judges from state the agent writes
can always be dodged by self-declaration. Therefore no purely-local control is airtight; the
authoritative anchor must live somewhere the agent cannot pre-disable or post-forge — **CI**.

## Decision: a layered defense, anchored externally

### Layer 1 — Local gate (fast feedback, bar-raiser)
`scripts/hooks/stop-goal-fit.js` + `evidence-capture.js` + `config-protection.js`.
- **Re-derive, don't trust:** the gate re-derives claim status from evidence via
  `@kontourai/surface` (`deriveClaimStatus`) rather than trusting stored status (ADR 0010).
- **Independent capture:** `evidence-capture.js` records real command results to a
  hash-chained `command-log.jsonl`; the gate cross-references claimed-passes against it
  ("caught false-completion" blocks). `captureCrossReference` is FlowDefinition-aware so it
  sees kit-typed (`builder.*`) claims, not only `workflow.*` (#214).
- **Captured-FAIL reconciliation, namespace-agnostic + status-independent (#218, #219):**
  any claim asserting pass for a command whose latest capture is FAIL blocks, on every stop,
  regardless of self-declared status.
- **Exit-code laundering:** a claimed verify command containing *any* `||` (or trailing
  `; true`/`exit 0`) is rejected — it masks the real exit code (#219, #227).
- **Anti-forgery:** `config-protection.js` blocks agent Write/Edit/redirect/`cp` to the
  kill-switch + truth-source files (`.claude/settings.json`, shell profiles,
  `.flow-agents/<slug>/current.json|state.json|trust.bundle`, `delivery/trust.bundle`)
  (#216, #220, #227). Path traversal in `active_flow_id` is rejected (#215, #217).
  `MAX_BLOCKS` never auto-releases a hard block (#216).

### Layer 2 — External CI anchor (authoritative)
`scripts/ci/trust-reconcile.js` + `.github/workflows/trust-reconcile.yml`.
- On a PR, in a clean CI environment the agent cannot pre-disable, **re-run the real
  verification fresh** (`trust-reconcile-verify` = `build && eval:static`; integration +
  the anti-gaming suite run in the required `ci.yml` lanes — see Layer 4), and **reconcile**
  the delivered bundle's claims against CI's own results: a claimed-pass that CI shows FAIL,
  a command CI never ran, or a laundered command → **divergence, job fails** (#222, #226).
- CI **never trusts** the agent's bundle as a truth source — it only uses it to detect
  divergence. Bundle command labels are **never executed** (no CI-RCE); they are string-
  compared against repo-declared canonical commands only.
- Fail-open on bundle absence (the fresh verify still gates); fail-closed on divergence and
  on a compile-only / laundered verify config (#226).

### Layer 3 — Provenance (un-forgeable)
`scripts/ci/mint-attestation.js`. CI mints an in-toto/DSSE attestation over its *own* fresh
results, signed via keyless Sigstore. The local agent has no ambient OIDC identity, so it
**cannot mint a trusted signature** — a fabricated "green" cannot be signed (#224).

### Layer 4 — Enforcement guards (so the gate itself can't be silently weakened)
- The **anti-gaming regression suite** (`evals/ci/antigaming-suite.sh`, 17 tests) runs in
  the **required** `ci.yml` "Runtime and Kit" lane (#228). Weakening any gate/anchor/
  protection — or deleting a regression test — turns the lane red and cannot merge.
- **CODEOWNERS** (#221, #228) requires owner review for the gate hooks, the CI definition,
  and the verify config (`package.json`, `scripts/ci/`, `evals/ci/`, `evals/run.sh`).
- Branch protection on `main`: required status checks + `enforce_admins`.

### Delivery transport
`delivery/trust.bundle` (gitignored by default; the deliver skill `git add -f`s it at an
actual delivery) carries the session bundle to CI; CI reconciles it against fresh truth
(#223, #1b). `publishDelivery` writes it via `fs` at `record-release`.

## How the layers map to the threat model

| Agent capability | Defended by |
|---|---|
| Lie in the bundle (claim pass) | L1 re-derive + capture cross-ref; L2 fresh re-run + reconcile |
| Launder the exit code (`\|\| true`) | L1 + L2 laundering screen |
| Forge `state.json`/`trust.bundle`/`current.json` | L1 config-protection; L2 doesn't trust them |
| Disable the local gate (env/profile) | L2 (CI ignores the agent's env) |
| Weaken the gate/anchor source | L4 required anti-gaming suite + CODEOWNERS |
| Fabricate a signed "green" | L3 (no local OIDC) |

## The adversarial-hardening method (and why it is part of the decision)

The architecture above was **not** designed up front; it was *earned* by an adversarial
loop, and that loop is itself the policy: **author self-certification is insufficient.**
Across 7 rounds, fresh-context adversaries (red-team + security audit, told to distrust the
author's "verified" claims) found and we closed 7+ real holes — several of which were
shipped by the gate's own author while reporting tests green. The loop is run to convergence
(a round that finds nothing newly exploitable beyond known residuals). The required
anti-gaming suite (L4) is how convergence is kept enforced over time.

## Residuals (honest — this is a bar-raiser, not a wall)

- **Local env kill-switch:** an agent can write a shell profile via interpreter one-liners
  (`node -e`, `py`-style `-c` invocations) or runtime-constructed paths that
  `config-protection` cannot fully enumerate, setting
  `FLOW_AGENTS_GOAL_FIT_MODE=off` for the next local hook. *Mitigated by:* L2 (CI is
  unaffected by the agent's env) + L4.
- **Wrapper-script verify:** an agent could point `trust-reconcile-verify` at a script that
  exits 0 without `||`. *Mitigated by:* CODEOWNERS on the verify config (L4) + the required
  anti-gaming suite running independently of the verify command.
- **Runtime-path / exotic-tool forge** (`rsync`, `dd`, `path.join(...)`) of protected files:
  not caught at the hook layer. *Mitigated by:* L2 not trusting those files + human review.
- **The irreducible boundary:** an admin/owner can bypass branch protection or approve a
  malicious change. That is the trust-the-humans boundary; it is documented, not closed.

The consistent principle: **the real tamper-proof boundary is external — the CI anchor's
fresh re-run, CI-minted signatures, and human (owner) review. The local gate raises the cost
of casual/direct self-tampering; it does not claim to stop a determined agent on its own.**

## Activation (required, server-side — issue #225)

The CI anchor and CODEOWNERS run and report today, but two settings (admin-only, not in the
repo) **arm** them as no-bypass gates:
1. Add **`Trust Reconcile`** as a required, no-bypass status check on `main`.
2. Enable **"Require review from Code Owners."**

Until set, `Trust Reconcile` + CODEOWNERS are advisory. The anti-gaming suite (L4) is
*already* blocking because it rides the existing required "Runtime and Kit" check.

## Consequences

- The trust gate's correctness no longer depends on trusting the agent, its claims, or its
  environment — only on the external CI anchor + human review, which the agent cannot reach.
- Any change that weakens the gate/anchor/protections is caught by the required anti-gaming
  suite and cannot merge.
- The model is reusable for the product: a downstream repo adds the `trust-reconcile` job +
  the anti-gaming suite as required checks to get the same external anchor (Phase 3, future).

## Related

ADR 0004 (gates expect Surface claims), ADR 0010 (workflow trust state as a hachure bundle),
ADR 0012 (liveness claims), ADR 0016 (three-hard-boundary model — the gate is core,
FlowDefinition-driven). Implementation: PRs #213–#228. Activation: issue #225.
