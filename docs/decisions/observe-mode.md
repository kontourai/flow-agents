---
status: current
subject: Observe Mode
decided: 2026-11-13
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1249
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/626
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1172
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1360
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1644
  - kind: adr
    ref: docs/adr/0016-three-hard-boundary-model.md
  - kind: adr
    ref: docs/adr/0017-anti-gaming-trust-security-model.md
  - kind: adr
    ref: docs/adr/0018-freeze-local-shell-heuristics.md
  - kind: doc
    ref: docs/decisions/writer-observed-execution.md
  - kind: doc
    ref: docs/decisions/workflow-enforcement.md
---
# Observe Mode

**Decision.** Builder gains an opt-in **observe-and-remind profile**, the `builder.observe` flow.
The agent is trusted to do the work. The kit declares what must be true when the work is done,
and hooks observe what actually happened. At natural boundaries the harness evaluates those
truths. When some are unmet, it tells the agent exactly which ones. After a bounded number of
reminders it hands off to a human with a computed summary. The agent does not drive the workflow
state machine. In an observe run its only workflow CLI call besides `workflow start` is the
review record.

`builder.build` is unchanged and stays the default. Observe mode ships next to it. The default
switches only after measurement (see [Migration](#migration-and-coexistence)).

## The three layers

1. **Definition: what is true when done.** The gate's expectations are predicates over evidence.
   The agent writes the plan (`<slug>--plan-work.md`) and the acceptance definition
   (`acceptance.json`) as files. Each criterion names the command that proves it as a `command`
   evidence ref, the shape the Stop hook's backstop already reads. The gate reads these files;
   nothing submits them. At the first boundary where `acceptance.json` defines a check for every
   criterion, the harness **locks** the checks. It records each check's SHA-256 in a hash-chained
   observe ledger. From then on the harness runs only the locked commands. An edit to a locked
   check is reported and never executed. Optional human plan approval (a checkpoint, like a full
   spec against a quick one) is off by default and follows in the next PR.
2. **Path: the agent works freely.** Orchestration (multi-agent work, ordering) belongs to the
   host, Station, or an external recipe, not to Builder. The flow has one working step, `observe`.
   Phases are inferred from observed activity: planning, editing, checking, review. The agent does
   not declare them.
3. **Enforcement loop.** Hooks capture commands (`evidence-capture`), the diff (trusted Git) and
   check hashes (the ledger). At **Stop** the harness evaluates the gate. The Stop hook becomes a
   **reminder engine**. TaskCompleted and SubagentStop are not boundaries yet; see the host table.
   In observe mode the engine replaces the non-releasable "canonical Flow run remains active" hard
   block (`stop-goal-fit.js`). Every other hard block is unchanged.

The flow definition declares both properties, so the core does not branch on a flow name
(ADR 0016, Abstraction A). `evidence_mode: "observed"` selects the engine.
`source_binding: {"base": "recorded-at-start"}` makes `workflow start` persist the base commit in
the canonical run's `params.source_base`. Scope is diffed against that commit.

## Expectation mapping

| Current Builder expectation | In observe mode | What is lost | Why acceptable |
| --- | --- | --- | --- |
| `selected-work` (pull-work) | **Removed.** `workflow start --task-slug` binds the local work item. It records no evidence. | Provider-backed readiness selection | Selection belongs to the host or recipe. Provider-backed pickup can wrap `start`. |
| `pickup-probe-readiness`, `probe-decisions-or-accepted-gaps` | **Removed.** They fold into the plan file. Questions under `## Open Questions` become attention items in the handoff, never gates. | A gated probe record | An unanswerable question goes to the human anyway. Gating on it only delayed that. |
| `implementation-plan` | **Removed as a submission.** The plan file is read for `## Expected Modified Files`. | A recorded plan claim | The plan's operative content (files, acceptance) is consumed directly by derivations. |
| `implementation-scope` | **Derived.** `git diff` from `params.source_base` to the worktree, compared with the declared files or globs. An extra file needs a one-line reason under `## Scope Changes`, a judgment record. The worktree must also be committed. | Nothing. #1249: the old claim carried no file set, so it could not see this defect class. | The derivation is exactly the defect class's input. |
| `tests-evidence` | **Observed.** At least one locked check is a recognised test command (`testExecutionProof`). It has a passing observation at the current commit, from the capture log or the hook-triggered writer re-run. | Nothing | Same observation sources and fold as `record-gate-claim`. |
| `acceptance-criteria` | **Derived.** Each criterion's locked check has a passing observation at the current commit. | Criteria whose proof is not a command | Such a criterion is an explicit `accepted_gap` (with `notes`), which goes to the human, never to a pass. |
| `clean-critique` | **Judgment record, kept.** `workflow critique` from a separate reviewer session. Same-session and self-declared reviewers are still refused (#1643). | Nothing | Review cannot be observed. #1644's authenticated reviewer remains open. |
| `merge-readiness`, `ci-merge-readiness`, learning | **Not in this flow yet.** | Publication and learning gates | They follow with the publish boundary (PR series below). |
| Status syncs, provisional publish | **Removed.** | Nothing. Provisional publish only served the retired CI anchor (`trust-reconcile.md`). | |
| Accepted gaps | **Judgment record, kept.** A criterion with `status: "accepted_gap"` and `notes`. | They never satisfied a gate before either; they derive `assumed`. | A gap ends reminders for that criterion and goes into the handoff summary. |

## Reminder-engine contract

**Inputs:** the session files (plan, `acceptance.json`, observe ledger), the hash-chained
`command-log.jsonl`, trusted Git (HEAD, worktree snapshot, diff from `params.source_base`), the
critique claims in `trust.bundle`, the pinned run definition, and the Stop payload's
`stop_hook_active`.

**Evaluation.** The engine turns each observation into a fact, then into a claim with its own
policy, evidence and (only when met) a `verified` event. Critique claims come from `trust.bundle`.
The engine evaluates `observe-gate` with Flow's `evaluateGate` against the run's pinned
definition. Flow and Surface decide whether the gate passes; the engine only explains why it does
not. If every fact is met but Flow refuses the bundle, that is an engine defect. It is reported
and handed to a human, never allowed through. The derived bundle is written to
`observe.bundle.json`, so a verifier can recompute the decision from the same inputs.

**Message.** One line per unmet fact, citing where it lives and the last observation. Example:
`acceptance.json:rejects-empty — locked check "npm test" last FAIL (exit 1) at 3f2a1c0; changed
since last reminder: src/parse.ts`. Satisfied facts are never listed again. The message stays
short and ends with the optional query (`flow-agents observe status`).

**Cap and handoff.** Unmet boundaries are counted since the last handoff or satisfaction. The
default cap is 5, set by `FLOW_AGENTS_OBSERVE_MAX_REMINDERS`, and counts boundaries the way
goal-fit's `max_blocks` does. At the Nth unmet boundary the Stop is released with a computed
handoff summary instead of another reminder: unmet facts, accepted gaps, open questions, scope
reasons, locked-check edits, the lock digest, and the head commit. So at most N−1 reminders reach
the model. N must not exceed the adapter's consecutive-block backstop
(`FLOW_AGENTS_STOP_MAX_BLOCKS`, default 5), so the gate's own handoff always fires first. A larger
value is refused loudly and the default applies. The handoff reaches the human as the released
Stop's `systemMessage` (Claude Code; Codex uses the same field).

**Loop safety.** When `stop_hook_active` is true and the unmet set is identical to the previous
reminder's, the agent made no progress on a reminder it has already seen. The engine hands off
immediately instead of spending the rest of the budget. Hosts without that signal stay bounded by
the cap and by the adapter backstop.

**Bounded verification.** The engine re-runs a locked check only when no observation at the
current commit confirms or refutes it and the worktree is clean. It uses the writer-observed
runner (`runObservedCommand`) and appends with `source: canonical-writer-execution`. The
re-runs share a time budget, `FLOW_AGENTS_OBSERVE_VERIFY_BUDGET_MS`, default 20000, below the
adapters' 30 s hook timeout. A check cut off by the budget is not recorded, because a killed
process cannot confirm or refute. Its reminder names `flow-agents observe verify`, the same runner
outside the Stop timeout.

## Per-host behavior

| Host | Stop can block | Observe mode here | Notes |
| --- | --- | --- | --- |
| Claude Code | Yes (`Stop`, reason reaches the model, #1172) | Full | PostToolUse carries no exit code, so captures are `ambiguous` and the hook-triggered re-run provides the pass. |
| Codex | Yes (`Stop`) | Full | Exit codes come from the rollout banner. No adapter turn-ending path (#1172 gap), so the cap is the only bound. |
| Kiro CLI | Host can block | Reminders only. Evidence capture is now wired (`agents/dev.json`). | The Stop hook timeout is 5 s, so the hook-triggered re-run cannot fit and checks run through `observe verify`. |
| OpenCode | No (`session.idle` is advisory) | Advisory | The reminder is emitted. Nothing holds the agent. |
| pi | No stop hook | Unavailable | Declared gap in the policy table. |
| Cursor | Advisory stop | Unavailable | Flow Agents installs no hooks there today (`hook_enforcement: NOT_INSTALLED`). |
| Copilot CLI, Factory | Host can block | Unavailable until wired | Flow Agents projects skills only, no hooks. The host capability exists, but nothing here uses it. |

**Engagement check.** At session start the steering hook reports loudly for an observe run:
whether observe mode is active, and whether this host can block Stop. `flow-agents observe status`
reports the same.

## Anti-gaming posture

ADR 0017 and 0018 stand: the local layer is a bar-raiser. The authoritative boundary is
external: required CI checks, the git diff, and owner review. The dedicated CI reconcile check
was retired (`trust-reconcile.md`). The attention-routing positioning is unratified, so this
record does not depend on it. Observe mode routes what it cannot settle to a human, and **every
existing catch still applies**:

- **Backstop re-run.** Locked checks are re-run by the harness, not reported by the agent.
- **Claim against capture.** An observed failure is sticky from either source (writer-observed
  fold). The existing `capturedFailReconciliation` and `captureCrossReference` hard blocks still
  run in observe mode.
- **Laundering.** A locked check containing an exit-masking operator (`hasLaunderingOperator`) is
  never treated as proof.
- **Log-chain tamper.** A broken `command-log.jsonl` chain still blocks. The observe ledger uses
  the same chain primitives, so an in-place edit to a lock record breaks the chain.
- **Locked-check edit.** The engine runs the locked command, never the edited one. The edit is
  reported until reverted, and the handoff lists it.
- **Same-session review.** `workflow critique` refuses it at write time, unchanged.

Residuals, accepted and disclosed:

- Deleting the observe ledger and then weakening the checks re-locks them. This is the same class
  as deleting `command-log.jsonl`. Backstops: the lock digest is printed in every reminder,
  handoff and status, so a reviewer sees the check set. The next PR also attaches the lock claim
  to the canonical `trust.bundle`, which `config-protection` already guards.
- A test suite slower than the Stop budget is never re-run by the hook. The agent must run
  `observe verify`, or the handoff says the check was not verified.

No new shell-parsing rule is added (ADR 0018). Integrity rides existing primitives.

## Migration and coexistence

- **This PR:** the decision, the `builder.observe` flow, `source_binding.base`, the engine (lock,
  scope, bounded re-run, Flow evaluation, reminders, handoff), `flow-agents observe status|verify`,
  the engagement check, Kiro capture wiring, and seam tests. A satisfied observe run allows Stop,
  but its canonical run stays at `observe`.
- **Next:** the harness attaches the derived claims and the lock through the canonical writer, so
  the run completes and `trust.bundle` and publication consume it. Committed observe settings,
  including plan approval. A publish boundary (before PR or publish). TaskCompleted and
  SubagentStop where hosts support them.
- **Default switch:** only after an evaluation-portfolio arm compares `builder.observe` with
  `builder.build`. A neutral or negative result is kept (#626's rule: fewer gates are not promoted
  for token savings alone).
