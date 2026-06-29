---
title: "ADR 0018: Freeze the Local Shell-Parsing Heuristics; Route New Enforcement to the CI Anchor"
---

# ADR 0018: Freeze the Local Shell-Parsing Heuristics; Route New Enforcement to the CI Anchor

Status: Accepted

## Context

ADR 0017 records the anti-gaming trust model: a **layered** defense whose *authoritative*
boundary is the external CI anchor (`trust-reconcile.js` + the required anti-gaming suite),
with the local Stop gate and `config-protection.js` as **Layer 1 bar-raisers** — explicitly
"a bar-raiser, not a wall." That model was earned by a 7-round adversarial loop (PRs
#213–#228), and ADR 0017 states the loop is "run to convergence."

The local shell-parsing heuristics have nonetheless kept accreting per-round string-matching
rules:

- `config-protection.js` — redirect detection (`>`, `>>`, `tee`), interpreter-write
  detection (`node -e`, `py -c`, `sed -i`, `perl -e`), and `cp`/`mv`/`install` target
  matching, grown across R5a / R6 / R7.
- `hasLaunderingOperator` (now in `scripts/lib/command-log-chain.js`) — the exit-code-mask
  screen, extended in R6a / R7.

Their **own headers already admit the ceiling**: *"An agent with shell access can still
evade. The real anchor is external."* Each new round adds another regex for another evasion
shape (runtime-constructed paths, base64, exotic tools, here-docs, …) while the set remains,
by construction, non-exhaustive. This is **low-ROI churn** that also manufactures *false
confidence* in a control ADR 0017 already classifies as best-effort.

Worse, the pattern-chasing has a real cost beyond effort: the blanket `||` rule in
`hasLaunderingOperator` flags **any** `||` in a claimed verification command, which
**false-positives legitimate commands** that use `||` for control flow rather than exit-code
laundering — e.g. `test -d node_modules || npm ci`, `command -v shellcheck || npm i -g shellcheck`.
It errs toward blocking, which is acceptable for a bar-raiser but not something to keep
extending.

## Decision

**Freeze the local shell-parsing heuristics as feature-complete bar-raisers.** Specifically:

1. **No new evasion-pattern rules** are added to `config-protection.js`'s redirect/
   interpreter/copy detection or to `hasLaunderingOperator`. The current rule sets are the
   frozen surface. They stand as documented, intentionally-incomplete local bar-raisers.

2. **New enforcement concerns route to the external anchor**, not to new local regex:
   - a new way to launder a verification result → strengthen the CI **`trust-reconcile`**
     reconciliation and add a case to the required **anti-gaming suite**
     (`evals/ci/antigaming-suite.sh`);
   - a new self-tamper / kill-switch vector → it is already defended structurally by Layer 2
     (CI does not trust the agent's files or environment) and Layer 4 (CODEOWNERS + required
     checks). Encode the *regression test* there, not another local path matcher.

3. **Still allowed** under the freeze: correctness/bug fixes that do **not** expand the
   pattern surface (e.g. removing a clear false-positive, consolidating duplicated copies as
   in ops#20), and changes required to keep the existing rules working. The freeze targets
   *scope growth*, not maintenance.

The decisive line — already the consistent finding of ADR 0017 — is that a local control
running inside the agent's environment cannot be made airtight by adding rules; effort spent
making the bar-raiser taller has sharply diminishing returns once the external anchor exists.

## Accepted limitations (documented, not closed)

These are now **accepted properties** of the frozen Layer 1, with the CI anchor as the
authoritative backstop:

- **`config-protection.js` — incomplete coverage.** Runtime-constructed protected paths
  (`homedir() + '/.bashrc'`), base64/multi-step path assembly, interpreters outside the
  listed set (ruby, php, …), `rsync`/`dd`/process-substitution writes, and here-docs are
  **not** caught. *Backstop:* Layer 2 does not trust those files; Layer 4 + human review.
- **`hasLaunderingOperator` — blanket `||` over-blocks.** A legitimate verification command
  that uses `||` for control flow is flagged as laundering. *Backstop / workaround:* split
  the conditional out of the single claimed-verify command; CI reconciles the real result
  regardless. We keep the blanket rule (fail-toward-blocking) rather than enumerate "safe"
  `||` forms — enumeration is exactly the churn this ADR freezes.

## Consequences

- The adversarial-hardening loop is declared **converged at the local layer**: ongoing trust
  investment goes to the external anchor (re-run freshness, reconciliation breadth, the
  required suite, activation of `Trust Reconcile` as a no-bypass check — ADR 0017 §Activation,
  issue #225), not to more local string parsing.
- Reviewers can decline new "Round N" local-heuristic PRs by pointing here: the bar-raiser is
  frozen by decision, and the gap belongs in the CI anchor.
- No behavior change ships with this ADR. The heuristics keep doing exactly what they do; we
  stop growing them and we write down why.

## Related

ADR 0017 (anti-gaming trust security model — the layered defense this freezes the local
layer of), ADR 0016 (three-hard-boundary model), ADR 0010 (workflow trust state as a hachure
bundle). Implements ops#21. Consolidation of the frozen helpers: ops#20
(`scripts/lib/command-log-chain.js`).
