Closes #1363
Closes #1365

Both issues are the same defect at the same boundary: **the fold into `trust.bundle` consumes a provenance distinction and emits something that cannot express it.** Fixed together because they are one change to one region of `buildTrustBundle`.

## Before / after, measured on a real bundle

Not asserted from code reading. Both columns come from the **same** real scenario — the writer eval's tests-evidence fixture, which drives `record-gate-claim --actor multi-observed-actor` (executing a real command through the canonical writer, completing two acceptance criteria) and `record-critique --reviewer multi-reviewer` — run against a pristine build of `origin/main` (94030774) in a detached worktree and against this branch, dumping the resulting `trust.bundle` from each.

| field | before | after |
|---|---|---|
| `events[].actor` | `["flow-agents/workflow-sidecar"]` | `["multi-observed-actor", "multi-reviewer"]` |
| `evidence[].collectedBy` | `["flow-agents/workflow-sidecar"]` | `multi-observed-actor` on every process-backed item |
| `evidence[].supportStrength` | unset everywhere | `"entails"` on the process-backed items |
| `observed_commands[].source` | unset on all four observations | `"canonical-writer-execution"` on all four |
| `metadata.criterion.verified_by` | *(field did not exist)* | `multi-observed-actor` |

Per event, before → after:

```
check/verified      -> flow-agents/workflow-sidecar   ->  multi-observed-actor
acceptance/verified -> flow-agents/workflow-sidecar   ->  multi-observed-actor
critique/verified   -> flow-agents/workflow-sidecar   ->  multi-reviewer
```

The reviewer-is-not-the-implementer distinction that the whole verify gate exists to create is now visible in the **delivered** bundle, not only in flow-agents-private `claim.metadata` where `deriveClaimStatus` cannot see it.

## What was done, per origin

Present iff derived. Every value is read from something that was already recorded; nothing is invented at fold time.

- **check** — `check._recorded_by`, stamped by `record-gate-claim` and restored across rebuilds by `checksFromBundle`'s producer stamp.
- **critique** — `metadata.reviewer`, read off the *reconstructed* critique metadata so a rebuild reports the reviewer the critique was recorded under, not whoever triggered the rebuild.
- **acceptance** — **this is the one that recorded no actor at all, and needed a decision.** `completePassingCriteria` is the only path in the codebase that ever moves a criterion to `pass` with observed commands; it runs inside `record-gate-claim`; the actor running it *is* the criterion's verifier. So that identity is stamped as `criterion._verified_by`, persisted as `metadata.criterion.verified_by`, and restored by `criteriaFromBundle`. **A criterion in any other state was verified by nobody and carries nothing** — no placeholder, no back-fill from the rebuild's actor.

An empty or retired-`"local"` actor key is not an identity; it is rejected through the single-sourced `isUnresolvedActor` predicate (consumed from `scripts/hooks/lib/actor-identity.js`, not re-implemented), and if that helper cannot be loaded the field records nothing. Where no identity is derived the fields keep the literal `flow-agents/workflow-sidecar`, which is not a valid actor key and so reads as *"no verifier was recorded"* rather than as a stand-in for one.

## `supportStrength` is deliberately not blanket-set

Surface's `evaluateCorroboration` counts distinct `collectedBy` values over evidence carrying the **literal** `"entails"` — an omitted value does not count. It is set **only** where the support relation is a process the canonical writer itself spawned (`source: "canonical-writer-execution"`) **and** the recorded outcome agrees with the claim value. A hook-captured observation keeps `flow-agents/evidence-capture` and earns nothing: marking a self-report `entails` would let corroboration count it as an independent verification, which is exactly the harm #1363 names.

**The alternative mapping #1365 offered — demote hook captures to `"cited"` — was rejected, and the rejection is load-bearing.** Surface's `deriveClaimStatus` reads an *absent* `supportStrength` as `entails`, so `"cited"` would have flipped currently-verified hook-backed claims to a lower status on every host whose PostToolUse payloads carry no exit code. Leaving them unset is status-neutral by construction, which is why **no claim's derived status moves in this change.**

`source` is therefore carried **verbatim** onto `observed_commands` (the field #1365 names), copied rather than re-stamped: an observation restored from a bundle written before this change has no `source` and is given none. `docs/decisions/writer-observed-execution.md` needs no narrowing — its promise that the attribution is permanent and auditable now holds across the fold as well as in `command-log.jsonl`.

## `corroboration.minActors` is NOT enabled here

No verification policy in this change declares `corroboration: { minActors: N }`. Recording the fields is the prerequisite; arming the refusal is a separate, behaviour-changing decision that would make every single-actor gate claim underivable the moment it lands, and belongs in its own PR with its own blast-radius analysis.

**What it would take now:** add `corroboration: { minActors: 2 }` to the critique claim's policy in `ensurePolicy`, and nothing else — the input it reads is populated and correct, and a test in this PR asserts that two commands run by *one* actor still count as one actor, so `minActors: 2` cannot be satisfied by volume. Worth noting that `builder-flow-runtime.ts:2196` already enforces reviewer ≠ implementer from the *private* metadata; what changes here is that the same fact is now derivable from the delivered bundle by any Surface consumer.

## Did anything pin the old constants?

Checked, not assumed. **No.** Every occurrence of `flow-agents/workflow-sidecar` / `flow-agents/evidence-capture` outside the producer is a hand-written **input** fixture fed to a hook or validator (`packaging/conformance/fixtures/*`, `test_goal_fit_hook.sh`, `test_gate_lockdown.sh`, `test_captured_fail_reconciliation.sh`, `test_verify_cli.sh:80`, `test_workflow_sidecar_writer.sh:4999`), never an assertion on the writer's output. `scripts/ci/trust-reconcile.js` does not read `collectedBy`, `actor`, `supportStrength` or `observed_commands` at all. So neither the test nor the code was wrong — there was no pin to reconcile.

## Verification

Real exit codes from sentinel files; no pipeline tails.

| check | result |
|---|---|
| `npm run typecheck` | `exit=0` |
| `npm run build` | `exit=0` |
| `node --test src/cli/trust-bundle-verifying-actor.test.mjs` (new) | 9 tests, 9 pass, 0 fail, `exit=0` |
| `bash evals/integration/test_workflow_sidecar_writer.sh` | `exit=0`, 255 checks pass, 0 fail |
| `run-baseline.sh --lane source-and-static` | sentinel `OK`, 17 PASS / 0 FAIL |
| `run-baseline.sh --lane workflow-contracts` | sentinel `FAIL rc=1`, 32 PASS / 2 FAIL — see below |

Also green outside those lanes: `test_verify_cli`, `test_golden_run_e2e`, `test_critique_supersession_roundtrip`, `test_wedge_830_squash_critique`, `test_wedge_1164_head_desync`, `test_gate_certification_matrix`, `test_gate_review_inquiry_records`, `test_builder_flow_completion`, `test_promote_gate`, `test_public_workflow_cli`.

The new unit suite is reached in CI through `evals/static/test_unit_helpers.sh` (the *Static eval suite* check); the new end-to-end assertion rides the existing *Workflow sidecar writer integration* check.

### The two residual lane failures are ambient-environment contamination

`test_assignment_provider_local_file` (*"Codex assignment record did not store the canonical privacy-safe struct/key"*, `Error: wrong runtime`) and `test_ensure_session_ownership_guard` (*"ensure-session persisted a divergent or unsafe Codex actor struct/key"*) both simulate a Codex runtime with `CODEX_THREAD_ID`, but `detectRuntime` returns `claude-code` whenever `CLAUDECODE === '1'` **or** `CLAUDE_CODE_SESSION_ID` is set — both ambient in the delivering agent's shell — so the assertion is unsatisfiable regardless of the code under test. Proven three ways:

1. both fail **identically** against a detached build of `origin/main` 94030774 in a separate worktree (per-check pass/fail lists byte-identical to this branch, modulo one race-ordering line that passes either way);
2. with `CLAUDECODE` and `CLAUDE_CODE_SESSION_ID` unset **both go green** — as does `test_public_workflow_cli`, whose identical earlier failure had the same cause;
3. the surface is actor *resolution*, which this change never touches — it reads an already-recorded actor string and never resolves one.

CI sets neither variable.

### A second red was self-inflicted, root-caused, and is disclosed

An intermediate scrubbed-environment run showed `test_record_check` failing (*"expected claim status verified for a passing command, got proposed"*) while `origin/main` passed — which looked like a real regression. It was not. `record-check` refuses to confirm a pass without clean Git provenance, and the delivering worktree had an **uncommitted edit to `delivery/DECLARED`** at the time, so `worktree_clean` was false. With both trees committed and clean, an alternating main-vs-branch A/B over three iterations is **3/3 green on both** — and the same dirty-tree condition reproduces the failure on `origin/main` too. The eval was doing its job.

## Fault injection

From a committed tree, `git status --short | wc -l` printing `0` before every injection, and **every injection compiled cleanly** (`build exit=0`, zero TS errors) so no compile error could be misread as a catch.

**1. Reverted the check-origin actor threading to the tool constant.** Unit suite RED 2/9:

```
AssertionError [ERR_ASSERTION]: VerificationEvent.actor must be the verifying identity, not the writing tool
  + actual   - expected
  + 'flow-agents/workflow-sidecar'
  - 'agent-alpha'

AssertionError [ERR_ASSERTION]: before the fix both events read 'flow-agents/workflow-sidecar'
and an independent critique was indistinguishable from a self-recorded check
  actual: [ 'flow-agents/workflow-sidecar', 'reviewer-beta' ]
  expected: [ 'agent-alpha', 'reviewer-beta' ]
```

Integration eval also RED, at `exit 3` (the event-actor check).

**2. Mis-attributed a writer execution as a hook capture** (`source: "postToolUse-capture"` in the fold) — a wrong value rather than a missing one:

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual   - expected
  + 'postToolUse-capture'
  - 'canonical-writer-execution'

AssertionError [ERR_ASSERTION]: a writer-spawned process whose outcome agrees with the claim entails it
  + actual   - expected
  + undefined
  - 'entails'
```

The second failure also proves the `entails` derivation is genuinely **coupled** to the source rather than independently true.

**3. Removed the acceptance-origin `_verified_by` stamp.** Integration eval RED at `exit 6` — the `criterion.verified_by` check. This is the injection that matters most: the acceptance path is unreachable from a unit test (its canonically-observed marker is a module-private `WeakSet`), so the end-to-end eval is its only cover, and this proves that cover has power.

Restored with `git checkout --`, rebuilt: unit **9/9**, writer eval **0 failures**.

*Disclosed:* a first attempt at injection (1) produced `error TS6133` and is recorded as **invalid** even though it happened to red correctly — it was redone with the unused local consumed so the build was clean.

## Open risks / NOT VERIFIED

- **No independent report-only review has run on this branch.**
- The full `run-baseline` was not run end to end — two of its four lanes plus ten targeted evals from the other two. CI's required lanes are the authoritative aggregate check. No local configuration makes `workflow-contracts` fully green on this host: with `CLAUDECODE` set the two Codex-runtime evals are red; with it unset `test_workflow_sidecar_writer`'s actor-binding cases go red instead (**also identically on `origin/main`**). Both configurations are disclosed rather than one being presented as the clean run.
- **Known, deliberate gap:** claims recorded through `record-check` and `record-evidence` still carry the tool constant, because those verbs do not stamp a recorder today. Inventing one at fold time would *be* the defect this change removes, so the honest output is the tool constant. Visible in the after-bundle above: the `acceptance-rebuild-probe` check reads `collectedBy=flow-agents/workflow-sidecar` with no `supportStrength`, which is correct. Stamping those verbs is a separate change.
- `delivery/DECLARED` scope added for `author:briananderson1222 branch-prefix:fix/record-real-verifier-1363`.

---

# Review round 1 — four findings addressed

Independent review returned **no BLOCKER** (central safety claim held under 249 differential probes, 0 newly accepted inputs). Four findings, all fixed.

## MEDIUM — the printed criterion example was refused by the rule printed two lines above it

#1358's own defect, inside the fix for #1358. `exampleEvidenceRef` took `rule.fields[0]`, which for `command` is `summary`, while the rule named `excerpt`. The reviewer ran the printed example verbatim and it was **REFUSED**.

Root cause: I corrected the *rule text* and not the *example*, and they had no shared source. Fixed by introducing `CRITERION_COMMAND_MATCH_FIELDS`, read by **all three** of the matcher (`commandTextFromEvidenceRef`), the printed rule, and the printed example. The drift test now drives criterion examples through the **criterion path**, not just the shape validator.

## HIGH — the drift guard was scoped to one function; the rules live a module away

The old guard counted `die(` in `validateEvidenceRef`'s body. The reviewer added a live rule in `public-contracts.ts`: build exit=0, 12/12 green, rule enforced, `--explain` silent.

Replaced with **set-equality over emitted output** — a generated corpus through the real collectors, canonicalized to bodies — which has no notion of *where* a rule lives.

### My first version of that guard also failed their injection, and I am not smoothing that over

Re-running the reviewer's 4th injection against the new set-equality guard: build exit=0, **14/14 GREEN**. The injection keys on a >200-character summary; my generator only produced short strings, so the rule was never provoked and the equality held **vacuously**. A corpus cannot be complete for arbitrary predicates.

Two nets now:

| net | mechanism |
|---|---|
| corpus set-equality | strengthened with boundary/length values |
| **source scan** | reads every violation template in the module; requires a printed body to match. **Coverage-independent.** |

Re-run of the reviewer's injection with both: **RED, 4 of 15 failing** — source scan naming `${label} entry summary must be at most 200 characters`, count pin reporting `actual 18 expected 17`.

A **fifth injection proves the nets are complementary, not redundant**: a rule keyed on an `ftp://` url — which the strengthened corpus still never produces — was **missed by set-equality (14 pass)** and **caught by the source scan alone**. Restored, rebuilt, 15/15 green.

## MEDIUM — "refused verbatim" was false for 9 of 26

The refusal prefixes the body with the offending object's label. Rules are now produced **by the collectors**, the header states the `<label> <body>` shape, and byte-identity is asserted over **every** object-shape rule rather than the one regex subset where the old claim held. The two never-emitted paraphrases are gone; `requires reviewable evidence_refs` and `requires structured reviewable evidence_refs` are now printed.

## MEDIUM — precondition parameter made required

`preconditionProblems: readonly string[] = []` → required. A future second call site omitting it can no longer silently skip the precondition.

## Verification this round

- `npx tsc --noEmit` exit=0; `npm run build` exit=0; `workflow-explain.test.mjs` **15/15**
- **integration eval now executed, not asserted** (the reviewer's catch — neither `test:unit` nor `trust-reconcile-verify` runs it): `test_workflow_sidecar_writer.sh` **exit=0, 254 pass, 0 fail**, including my changed assertion and the three criterion assertions the collector change touches
- full unit corpus **exit=0** — 1834 tests, 1818 pass, **0 fail**, 16 skipped

## The aggregate: red once, then green twice — reported both ways

`npm run trust-reconcile-verify` → **exit=1**, from one unit test (`coordinated-command-receipt`) dying with `Error: kill EPERM` in `terminateProcessGroup`.

**It is not this change.** `src/lib/observed-command.ts:59-61` swallows only `ESRCH` and **rethrows `EPERM`**; macOS returns EPERM when a process-group leader exits between the check and `kill(-pid)`. My diff touches none of that file. Four independent lines of evidence:

1. passes **3/3 in isolation**;
2. full corpus re-run on the **same commit** → exit=0, that same test green;
3. the earlier full aggregate on this branch (54eb08a2) was exit=0;
4. the failing code path is untouched by the diff.

### Re-run to a green sentinel

Rather than merge on a flake diagnosis, however well evidenced, the aggregate was re-run at this exact HEAD:

**`npm run trust-reconcile-verify` → exit=0** — 1799 unit assertions pass, **0 fail**, 0 static-check failures, and `coordinated-command-receipt` **green** (`✔ … (3874ms)`).

That is three runs of the EPERM path on this branch: **red once, green twice**, consistent with a race rather than a regression.

The root cause is fixed on its own branch: **#1370** (closes #1369) — `terminateProcessGroup` now treats `EPERM` like `ESRCH`. If this lane reds again on that path, **#1370 is the sequencing dependency**.

## Review status

> [!IMPORTANT]
> **No independent review has run on this round.** The round-1 review covered the **pre-fix head**; everything above — the rule-body table, both drift nets, the `CRITERION_COMMAND_MATCH_FIELDS` binding, the required precondition parameter — is **unreviewed**. The reviewer's own injections were re-run against it (and one defeated the first attempt), but that is my testing, not their review.

The EPERM flake is now fixed on its own branch: **#1370** (closes #1369). If this PR's aggregate reds again on that same path, **#1370 is the sequencing dependency** and should land first.

https://claude.ai/code/session_012LTz7urpKx9BEmrdsyehY4
