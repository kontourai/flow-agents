Closes #1358.

## What this changes

Public verbs made callers discover JSON shapes one refusal at a time. This adds `--explain` and folds validation into a single pass — now at the flag level as well as the payload level.

- `src/cli/public-contracts.ts` — rule bodies as data, produced by the collectors that emit them; `CRITERION_COMMAND_MATCH_FIELDS`; `parameterViolations` reading the verbs' own parameter tables.
- `src/cli/workflow.ts` — `--explain` intercepted where `--help` is, before any verb action; prints accepted shapes, filled examples, the flag table, and preconditions.
- `src/cli/workflow-sidecar.ts` — validators collect and refuse once; `#619` narrative isolation restored ahead of shape validation.
- `src/cli/workflow-explain.test.mjs` — three independent drift nets.

## Measured

| | before | after |
|---|---|---|
| one evidence ref, 4 faults | 5 refusals | 2 |
| one `--lane-json`, 5 faults | 5 refusals | 1 |
| `record-critique` flag ladder | **3 round-trips before the payload is read** | **1** |
| flag faults + payload faults | separate invocations | **7 problems, one refusal** |

---

# Review round 2 — BLOCKER and two uncaught injections

## BLOCKER (fixed) — I shadowed the #619 narrative-isolation refusal

Commit `5c355ad` reordered `validateEvidenceRef` so shape rules ran **before** the three `rejectNarrativeReference` calls. Nothing was admitted — all 15 (kind × channel) references still refused — but **8 of 15 answered with a shape rule instead of the isolation diagnostic**, so AC5's actual subject (that #619 is the *refusing authority*, not merely reachable) silently stopped holding.

A security refusal that is merely reachable is not the same as one that is authoritative.

Guard restored ahead of shape validation. Measured across all 15 pairs:

```
15 (kind x channel) pairs: isolation=15 shape-shadowed=0 accepted=0
```

`evals/integration/test_narrative_trust_isolation.sh` → sentinel `rc=0`, `✓ AC5`.

Pinned per pair so a reorder names the pairs it downgrades. The **accepted consequence is stated in the code**: a ref that is both narrative-poisoned and malformed reports only the isolation refusal, so #1359's one-pass property yields to #619 there deliberately.

## HIGH (fixed) — my round-1 nets had a *path* gap, and I had deleted the guard that covered it

`observedEvidenceRefBodies()` called the collector **directly** and never traversed the shipped validator, so a live `die()` inside `validateEvidenceRef` was enforced by the CLI, printed zero times, and went green — including the round-1 reviewer's own 200-char injection that my corpus generates `"x".repeat(201)` specifically to catch. No corpus strengthening reaches a function the corpus never calls.

Worse: commit `5c355ad` **had** a guard covering exactly that, and my round-1 rewrite of the test file **deleted** it while my own `DECLARED` cited it as having caught that injection. The finding read as closed while the hole moved.

Both fixed, and **both kept** — they miss different things and neither subsumes the other:

| injection | corpus net | restored `die(` guard |
|---|---|---|
| 200-char cap in `validateEvidenceRef` | **caught** (count pin 18≠17, set-equality names the body) | **caught** |
| absolute-path rule (corpus generates no absolute paths) | **missed** | **caught** — 18 pass / 1 fail |

## HIGH (fixed) — the source scan was blind to a second syntax

It read only `` violations.push(`…`) `` and missed three bodies written `` return [`…`] `` in the same file — a purely syntactic boundary. Both forms are read now, the expected count is **derived** from body-producing sites rather than given slack (`>= 10` had two spare against twelve), and the printed set covers both printed surfaces. A rule added in the `return` form now reds **four** tests.

## MEDIUM (fixed) — the flag ladder

```
BEFORE                                   AFTER
(no flags)   -> requires --verdict       3 problems must be fixed together:
+ --verdict  -> requires --summary         - record-critique requires --verdict
+ --summary  -> requires --lane-json       - record-critique requires --summary
+ --lane-json-> 4 problems...              - record-critique requires at least one --lane-json
```

`parameterViolations` reads `WORKFLOW_CRITIQUE_PARAMETERS` — which already declared `required`, `allowed_values`, `repeatable`, `required_when` and which nothing read — and folds those into the same refusal as the payload faults. `required_when` now surfaces `--artifact-ref` up front instead of as yet another round-trip. `--explain` prints the same table.

## LOW (fixed) — a refusal that stated something false

Two lanes both **missing** an id collapsed to a single `undefined` and emitted `--lane-json ids must be unique` when no two ids were equal. Only existing ids are compared now; a real collision is still caught.

## Verification

- `npx tsc --noEmit` exit=0; `npm run build` exit=0; `workflow-explain.test.mjs` **19/19**
- **Three fault injections**, each on a committed tree with `git status --short | wc -l` = 0 and build exit=0 so no compile error could read as a catch. All three previously green, now red. Restored, **19/19**.
- `npm run trust-reconcile-verify` → **exit=1**, see below. **0 static-check failures**; 1838 tests, 1821 pass, **1 fail**, 16 skipped. All seven round-2 tests passed inside it.

## The aggregate is RED, and #1370 is the sequencing dependency

The single failure is the EPERM teardown race — same trace, `observed-command.js:35`:

```
Error: kill EPERM
    at terminateProcessGroup (…/build/src/lib/observed-command.js:35:29)
    at beginCleanup (…/build/src/lib/observed-command.js:72:22)
```

That is the exact line **#1370** fixes, and this branch does not carry it.

Tally on this branch: `verify2` **RED**, `agg3` **GREEN**, `agg4` **RED**, standalone unit corpus **GREEN**.

**A correction to my own framing in #1370:** I measured 300 exit-path teardowns in a tight loop and got ESRCH 300/300, and called EPERM "rare". That measurement was on a near-idle loop. In the full corpus on this 3-lane host it has now fired in **2 of 3** aggregate runs. Rare in isolation, common under load — and "rare" should not be read as "won't happen".

**#1370 should land first**; this branch's aggregate should then be clean.

## Merged with `origin/main` after the aggregate ran

`origin/main` advanced during this round (#1367). Merged in — not rebased, per this repo's standing rule — and the `delivery/DECLARED` conflict resolved by taking main's file wholesale and appending only my one entry (63 + 1 = 64, verified programmatically that my scope was not already present).

That merge brings `@kontourai/surface` 2.13.0 → 2.17.0, so a fresh `npm ci` was required; my earlier verification ran against the pre-bump dependency set.

On the merged tree with real deps: `npx tsc --noEmit` exit=0, `npm run build` exit=0, and my four directly-affected suites **61/61**. **The full aggregate has NOT been re-run since the merge** — it has to be re-run after #1370 lands regardless, and that run will cover the merged tree.

## Review status

> [!IMPORTANT]
> **No independent review has run on this round.** Round 2 covered the pre-round-2 head. Everything above — the #619 reordering, the rewired nets, the restored guard, `parameterViolations`, the LOW fix — is unreviewed. Re-running the reviewer's own injections against it is my testing, not their review.

## Correction (kept from the reviewer's edit)

An earlier version of this body opened `Closes #1363` / `Closes #1365` and carried a verification table describing **#1368's** work — a test file with 0 occurrences on this branch. Merging it would have auto-closed two issues against a change that does not touch them and orphaned #1368. Caught by independent review, not by me or CI; nothing checks whether a PR body's evidence belongs to its own diff. Every claim in this body comes from a command run on this branch.

https://claude.ai/code/session_012LTz7urpKx9BEmrdsyehY4

