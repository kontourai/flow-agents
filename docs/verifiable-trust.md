# Verifiable Trust — why "done" actually means done

> **The problem with autonomous coding agents: they grade their own homework.**
> An agent writes the code, runs the tests, and reports "all green, shipped." If it's
> wrong — or if it learns it can just *say* the tests passed — you find out in production.
> Flow Agents is built so an agent **can't** mark work complete that isn't.

## The one-line pitch

Flow Agents treats "the work is done" as a **claim that must be proven**, not a status the
agent gets to assert. Completion is gated by **evidence the system re-derives itself**, and
the authoritative check runs in **CI — an environment the agent can't disable or fake** —
with **cryptographically signed provenance** of exactly what was verified.

Most agent frameworks trust the model's self-report. Flow Agents doesn't trust the agent,
its claims, *or* its environment.

## What that buys you

- **"Done" you can rely on.** A finished task ends with real evidence — tests, build, lint,
  review findings, captured command results — and the gate *re-derives* the verdict from
  that evidence. A claimed pass that contradicts a captured failure is **blocked**, not shipped.
- **Anti-gaming by design.** The gate independently captures real command results and
  reconciles them against the agent's claims — namespace-agnostic, and independent of any
  status the agent self-declares. Tricks like `npm test || true` (laundering the exit code)
  are rejected.
- **An external anchor that can't be switched off.** On every pull request, CI re-runs the
  verification *fresh* in a clean environment and **fails the merge on any divergence**
  between what the agent claimed and what CI actually observed. The agent can tamper with its
  own machine all it likes; it can't reach into CI.
- **Signed provenance.** CI mints a Sigstore-signed attestation over its *own* results. The
  agent has no signing identity, so a fabricated "green" can't be signed — you get a
  tamper-evident, externally-verifiable record of what shipped.
- **The gate can't be silently weakened.** The anti-gaming test suite runs as a **required
  CI check**, and the gate/CI/verify config require **code-owner review** — so a change that
  guts the protections can't merge.

## Who it's for

- **Solo builders and teams shipping agent-written code.** Run the agent, and trust that
  what it marks "done" is verified — not just asserted. Less re-checking, fewer "it said it
  passed but it didn't" surprises.
- **Unattended / AFK and overnight agents.** When you're not watching, the gate is. An agent
  running autonomously can't quietly ship broken work past a green self-report.
- **High-assurance, regulated, and audited environments.** Every delivery carries a signed,
  reproducible record of *what was verified and how* — provenance you can hand to an auditor,
  not a screenshot of a passing run.
- **Multi-agent and at-scale delivery.** Every agent's output is held to the same external,
  un-gameable bar — so you can fan out work without fanning out the risk that one agent
  learns to game its gate.
- **Platform teams adopting agents.** Add the trust anchor as a required check in your repos
  and get a consistent, enforced "agents must prove it" policy across every team.

## How it's different

| | Typical agent setup | Flow Agents |
|---|---|---|
| "Is it done?" | The agent says so | Re-derived from independent evidence |
| Failure hiding | Easy (claim pass, launder exit codes) | Caught — captured results reconcile against claims |
| Where trust lives | In the agent's environment | **External** — CI re-runs fresh, agent can't disable it |
| Provenance | A log line | **Sigstore-signed** attestation of CI's own results |
| Tampering with the gate | Possible | Required tests + code-owner review block it |

## The honest part

This is a **defense-in-depth bar-raiser, not a magic wall** — and the docs say so plainly.
The local gate raises the cost of casual or direct self-tampering; the *real* tamper-proof
boundary is **external**: CI's fresh re-run, the CI-minted signatures, and human (owner)
review — none of which the agent can reach. Known residuals (and their mitigations) are
documented openly rather than hidden, because overstating security is its own risk. We'd
rather you trust this *because* you can see where the lines are.

> This posture wasn't designed on paper and declared safe — it was **earned by an adversarial
> loop**: independent reviewers repeatedly tried to defeat the gate (and found real holes we
> closed) until a round came back clean. That loop is now part of the policy, and the
> regression suite that proves it runs on every change.

## Learn more

- **Architecture, threat model, and residuals:** [ADR 0017 — The Anti-Gaming Trust Security
  Model](adr/0017-anti-gaming-trust-security-model.md)
- **The trust state model it builds on:** [ADR 0010 — Workflow Trust State as a Hachure
  Bundle](adr/0010-workflow-trust-state-as-hachure-bundle.md), [ADR 0004 — Gates Expect
  Surface Claims](adr/0004-gates-expect-surface-claims.md)
- **Turning on the external teeth** (admin, one-time): the CI anchor + code-owner review are
  armed by two server-side branch-protection settings — see the activation note in ADR 0017.
