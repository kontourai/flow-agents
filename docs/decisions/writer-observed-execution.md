---
status: current
subject: Writer-observed execution
decided: 2026-07-14
evidence:
  - kind: issue
    ref: "634"
  - kind: adr
    ref: docs/adr/0017-anti-gaming-trust-security-model.md
  - kind: adr
    ref: docs/adr/0020-trust-reconcile-manifest-and-claim-classification.md
---
# Writer-observed execution

**Decision.** When `record-gate-claim` executes a declared evidence command itself
(`runObservedCommand` — a real process it spawned, with a real exit code, output hash, and,
for tests, a `local-process-exit` execution proof), it appends that observation to the same
hash-chained `command-log.jsonl` the PostToolUse capture hook writes, under the same
lockfile protocol, visibly attributed via `source: "canonical-writer-execution"`. The
capture fold's effective precedence is **observed fail > observed pass > ambiguous**
regardless of source, which yields the intended ordering hook-fail > hook-pass >
writer-pass > ambiguous: a writer observation can lift ambiguity but can never bury an
independently captured failure, and a writer-observed failure is itself sticky. The chain
fork classifier tolerates shared-parent siblings only when every sibling's source is
`postToolUse-capture` or `canonical-writer-execution`; any other source on a shared parent
remains tamper.

**Context.** ADR 0017/0020 make the independent capture log the truth source for command
outcomes, and #470 hardened capture to never record `pass` without positive evidence. On
hosts whose runtime hook payloads carry no exit code (Claude Code's PostToolUse
`tool_response` today), every captured entry is honestly `ambiguous` — and #634 showed the
consequence: `builder.verify.*` claims can never derive `verified`, while the sanctioned
accepted-gap waiver produces `assumed`, which no gate's `accepted_statuses` admits. The
verify gate was structurally unclosable on such hosts regardless of evidence quality.

**Why this preserves the anti-gaming posture.** A writer observation is not an inference or
a self-report of intent — it is the exit code of a process the canonical writer itself
spawned and waited on. It enters the record distinguishable forever (the `source` field),
tamper-evident (chain-hashed), serialized against the hook (shared lock), and subordinate
on conflict (an observed fail from either source wins). The waiver path is untouched:
accepted gaps remain disclosure that derives `assumed`, never gate satisfaction.

**Residual risk, accepted.** A compromised writer process could self-attest a pass the hook
never saw. Mitigations: the attribution is permanent and auditable; the chain makes
retroactive editing detectable; a hook-observed failure always prevails; and PR CI Trust
Reconcile re-executes manifest commands independently of any local observation. Follow-up
(#634 option c): when runtime harnesses surface exit codes in hook payloads, hook capture
naturally resumes confirming passes first-hand; writer observations then serve as
corroboration rather than the sole deterministic signal.
