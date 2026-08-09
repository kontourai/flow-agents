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
capture fold's precedence is **outcome-ranked, source-blind**: observed fail > observed
pass > ambiguous, with the exit code always traveling with the winning status. The
properties that matter follow: a writer pass can lift ambiguity but can never bury an
independently captured failure (fail is sticky from either source), and a writer-observed
failure likewise defeats any pass. Passes from the two sources rank equally — the
distinction between them lives in the permanent `source` attribution, not in the fold. The chain
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

## Revision-bound observations (#1081)

**Decision.** A command result is observed only when its result and its repository state have
both settled. The canonical writer captures its Git-worktree snapshot after the child process's
`close` event; the PostToolUse capture records the host result first, then captures Git state
before it appends and chain-hashes the command-log record. Each captured command therefore carries
its own `observed_at_commit` and `worktree_clean`, as well as the observation-time
`verification_workspace_snapshot` where the writer can provide it. The fields are copied without
re-stamping through `command-log.jsonl`, `metadata.observed_commands`, and the canonical
`trust.bundle` rebuild.

`worktree_clean: false`, missing provenance, a non-Git root, shallow or otherwise unresolved Git
history, and trusted-Git capture failure are all non-confirming. A successful exit remains useful
diagnostic evidence, but it is `not_verified` rather than a verified command observation and
cannot satisfy a gate. Version 1 records are rejected and must be re-recorded with capture-time
provenance.

**Why both revision and snapshot are required.** For each item that would contribute to a passing
gate, trusted Git must resolve `observed_at_commit` and prove it is an ancestor of the trusted
current `HEAD`; the item's captured snapshot must also exactly match the current canonical
Git-worktree snapshot. Ancestry makes history substitution visible, while the exact snapshot
catches changed tracked or untracked bytes. Ancestry alone does not prove byte identity, and a
cleanliness flag alone does not establish currentness. The `trust.bundle` is the runtime authority
for this decision; `workflow-evidence` v2 is its consumer-facing projection contract, not a second
authority.
