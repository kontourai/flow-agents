# Verifiable Trust — tamper-evident done

> **The problem with autonomous coding agents: they grade their own homework.**
> An agent writes the code, runs the tests, and reports "all green, shipped." If it's
> wrong — or if it learns it can just *say* the tests passed — you find out in production.
> Flow Agents is built so "done" is a claim with evidence, not a status the model gets
> to assert.

## The one-line pitch

Flow Agents treats "the work is done" as a **claim that must be proven**, not a status the
agent gets to assert. Completion is gated by evidence the system re-derives, with two
different trust tiers:

- **L1 local runtime gate and capture** — advisory, best-effort protection inside the agent
  runtime. It catches native command evidence, stop-short behavior, and obvious divergence
  before the work leaves the session.
- **L2 controlled re-run anchor** — CI re-executes manifest commands and reconciles them
  against git diff as ground truth. This is the authoritative boundary for CI-verified
  status.

Most agent frameworks trust the model's self-report. Flow Agents treats that self-report as
input to reconcile, not as truth. The posture is **tamper-evident**, not tamper-proof.

## What that buys you

- **"Done" you can inspect.** A finished task ends with evidence — tests, build, lint,
  review findings, captured command results, CI output, or an explicit `NOT_VERIFIED` gap.
  A claimed pass that contradicts captured or reconciled evidence is blocked or downgraded,
  not laundered into verified status.
- **Anti-gaming by design.** Local capture raises the cost of direct native-command
  self-tampering, and CI reconciles manifest commands against fresh results. Tricks like
  `npm test || true` are rejected when they are represented as command evidence.
- **An external anchor that can't be switched off locally.** On pull requests wired to the
  trust anchor, CI re-runs verification fresh in a clean environment and fails on divergence
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
  evidence-backed bar — so you can fan out work without fanning out the risk that one agent
  learns to game its gate.
- **Platform teams adopting agents.** Add the trust anchor as a required check in your repos
  and get a consistent, enforced "agents must prove it" policy across every team.

## How it's different

| | Typical agent setup | Flow Agents |
|---|---|---|
| "Is it done?" | The agent says so | Re-derived from evidence; CI-verified only after the controlled anchor reconciles |
| Failure hiding | Easy (claim pass, launder exit codes) | Native command capture locally; manifest-command reconciliation in CI |
| Where trust lives | In the agent's environment | Local tier is advisory; authoritative tier is **external** CI + git ground truth |
| Provenance | A log line | **Sigstore-signed** attestation of CI's own results |
| Tampering with the gate | Possible | Required tests + code-owner review block it |

## Trust tiers

### L1: local runtime gate and capture

The local tier runs inside the agent's runtime. It can steer the workflow, capture native
command results, detect stop-short behavior, and warn or block depending on the host's hook
surface. It is useful because it catches problems early, while the agent is still in the
session.

It is not the authoritative trust boundary. The agent and its tools can still affect the
local machine. Local evidence is treated as session-local until it is either reconciled by
the controlled anchor or explicitly carried as a lower-trust attestation.

### L2: controlled CI re-run

The controlled anchor runs outside the agent session. CI re-executes the manifest commands,
checks the resulting status against the agent's claims, and uses git diff as the ground truth
for what changed. A write that bypassed local capture still appears in the diff. A command
claim that cannot be tied to a manifest command re-run does not become CI-verified just
because the agent said it passed.

The CI tier is where evidence can become independently reconciled. That is the line between
"the session reported this" and "the controlled environment re-ran or inspected this."

## Threat model note

The local tier keys on native command tools. MCP or other non-native tool effects can bypass
local capture, including file writes and test runs.

That blind spot is disclosed, not hidden:

- **File writes** still hit the CI/git boundary because the pull request diff is ground
  truth for delivered changes.
- **Non-native test runs** do not become CI-verified evidence unless the same check is
  represented by a manifest command that CI re-runs. Otherwise they remain session-local or
  `NOT_VERIFIED`.
- **Bypassed local capture** should refuse, escalate, or degrade confidence. It must not be
  laundered into a verified CI claim.

Every trust claim should be traceable to public artifacts: the recorded evidence, the
manifest command, the CI run, the git diff, or an explicit verification gap.

## The honest part

This is a **defense-in-depth bar-raiser, not a magic wall** — and the docs say so plainly.
The local gate raises the cost of casual or direct self-tampering; the real authoritative
boundary is **external**: CI's fresh re-run, git diff reconciliation, CI-minted signatures,
and human (owner) review. Known residuals are documented openly rather than hidden, because
overstating security is its own risk. We'd rather you trust this *because* you can see where
the lines are.

> This posture wasn't designed on paper and declared safe — it was **earned by an adversarial
> loop**: independent reviewers repeatedly tried to defeat the gate (and found real holes we
> closed) until a round came back clean. That loop is now part of the policy, and the
> regression suite that proves it runs on every change.

## Add it to your repo

The same external anchor works in **any** repo that uses Flow Agents — add the
[`trust-verify` composite action](trust-anchor-adoption.md) as a required check, or run it
locally / in any CI with `npx @kontourai/flow-agents verify`. See the
[Trust Anchor Adoption guide](trust-anchor-adoption.md) for the full wiring (publish the
bundle → add the action → make it a required, no-bypass check + CODEOWNERS).

## Learn more

- **Add the anchor to your repo:** [Trust Anchor Adoption guide](trust-anchor-adoption.md)
- **Architecture, threat model, and residuals:** [ADR 0017 — The Anti-Gaming Trust Security
  Model](adr/0017-anti-gaming-trust-security-model.md)
- **The trust state model it builds on:** [ADR 0010 — Workflow Trust State as a Hachure
  Bundle](adr/0010-workflow-trust-state-as-hachure-bundle.md), [ADR 0004 — Gates Expect
  Surface Claims](adr/0004-gates-expect-surface-claims.md)
- **Turning on the external teeth** (admin, one-time): the CI anchor + code-owner review are
  armed by two server-side branch-protection settings — see the activation note in ADR 0017.
