---
name: "verify-work"
description: "Verification primitive — session file path to structured evidence verdict via tool-verifier + tool-playwright. Reads acceptance criteria from plan artifact."
---

# Verify

Session file in, structured evidence verdict out. Delegates to tool-verifier and tool-playwright.

Verification is not critique. Run `review-work` first when the task needs maintainability, security, architecture, or standards review. Verification should start only after the required critique gate has been recorded or explicitly marked `not_verified`. `verify-work` records proof in `evidence.json`; `review-work` records critique through the critique artifact/sink, currently `critique.json` locally.

## Agents

| Agent | Role |
|---|---|
| tool-verifier | Code verification, acceptance criteria checking, structured verdicts |
| tool-playwright | Visual verification, screenshots, accessibility checks |

## Model Routing

Verify roles never resolve **below** the tier of the work they check (Goodhart
guard): default `delegate-implementation`, raised to match or exceed the tier
that produced the work under verification — a verifier of `delegate-design` work
resolves `delegate-design` or `orchestrator`, never a cheaper tier. Resolve the
role from `.datum/config.json` (`npx @kontourai/datum resolve <role> --json`) and
pass the model explicitly. See `context/contracts/execution-contract.md`
§ Delegation: Model Routing and § Goodhart guard. Fallback: inherit the session
model when datum/config is absent, noted in the artifact.

## Orchestrator Rule

You do not review source files. You delegate to tool-verifier and tool-playwright, then read the verdict artifact.

## Shared Contracts

Follow:
- `context/contracts/artifact-contract.md`
- `context/contracts/verification-contract.md`
- `context/contracts/planning-contract.md` for acceptance criteria and Definition Of Done

This skill owns orchestration and routing. The verification contract owns phases, report-only behavior, verdict rules, report shape, Goal Fit checks, and `NOT_VERIFIED` handling.

## Read-Only Rule (STRICT)

**Verifiers NEVER modify source code.** tool-verifier and tool-playwright are read-only reporters:
- They may run commands (build, test, lint) but NEVER apply fixes
- No format fixes, no lint auto-fixes, no "1 format fix applied"
- No code patches, no "found and fixed" — report findings only
- If a fix is needed, report it as a finding. The orchestrator routes it back to execute-plan.

## Input

- **Session file path**: the session file in `.kontourai/flow-agents/<slug>/` (preferred)
- The session file references the plan artifact (which has acceptance criteria) and execution progress (which has modified files)
- If NO session file exists, delegate to tool-verifier directly (see Standalone Verification below)

## Standalone Verification (no session file)

When invoked without a session file (e.g., user says "verify this project" or "run verification"):

1. Delegate to tool-verifier with:
   - The user's verification request
   - The current working directory
   - Modified files from `git diff --name-only` (if available)
2. Delegate to tool-playwright in parallel if UI changes are mentioned
3. Read the verdict and report to the user

Skip session file lookup — go straight to delegation.

## Workflow (with session file)

1. Read the session file to find the plan artifact path and modified files
2. Confirm the review-before-verify gate: the critique artifact/sink should show the required review pass, blocking findings, or an explicit `not_verified` gap. If the critique gate is missing for work that requires review, stop and route to `review-work` instead of treating verification as a substitute critique.
3. Set session file `status: verifying` and update `state.json` phase/status. Use `npm run workflow:sidecar -- advance-state <artifact-dir> --status verifying --phase verification --summary ... --next-action ...` when the repository provides it.
4. Delegate in parallel:
   ```
   tool-verifier:
   - Acceptance criteria from plan artifact
   - Acceptance criteria from acceptance.json when present
   - Definition Of Done and stop-short risks from plan artifact
   - Modified files from execution progress
   - Requirement to preserve each AC id and map it to command/test evidence plus structured source evidence refs when implementation behavior is claimed
   - Evidence ref schema: objects with `kind`, `url`, `file`, `line_start`, `line_end`, and `excerpt` where applicable; source refs require local file/line/excerpt and should use immutable GitHub blob permalinks pinned to a commit SHA when provider URLs are available
   - Build/test commands from AGENTS.md or plan
   - todo_file path for writing verdict artifact
   - Workflow artifact root path; append verifier progress with record-agent-event

   tool-playwright (if UI changes exist):
   - Pages/components to check
   - Expected visual state
   - Workflow artifact root path; append browser evidence or blockers with record-agent-event
   ```
5. Read the verdict artifact: `<session-basename>-review.md`
6. Update session file: paste verdict summary into `## Verification Report`
7. Write or update `evidence.json` with verification checks, top-level verdict, and `not_verified_gaps`
   - use `npm run workflow:sidecar -- record-evidence <artifact-dir> --verdict ... --check-json ...` when the repository provides it
   - `checks[].artifact_refs` must use structured evidence ref objects, not legacy strings
   - for multi-repo or cross-product work, preserve a coverage matrix in the
     evidence report or check summaries that lists each affected root and its
     build/test, dependency/security, provider/CI, and accepted-gap status
   - if external dependency audit or provider checks are blocked by approval,
     privacy, credentials, network, or missing change-provider state, record the
     affected roots as `not_verified` instead of collapsing the lane into a
     generic pass/fail
8. Update `acceptance.json` with criterion statuses and structured evidence refs
   - `criteria[].evidence_refs` must use structured evidence refs and map each AC id to command/test proof plus source refs for behavior claims
   - when source refs are missing for a behavior claim, mark the criterion `not_verified` or record an accepted gap instead of using broad prose-only evidence
9. Route on verdicts:
   - **All PASS** → set `status: verified`
   - **Any FAIL** → set `status: failed`, list failures
   - **Any NOT_VERIFIED** → set Markdown status `needs-decision`, set `state.json` status `needs_decision`, and surface to user

## Verification Contract

tool-verifier writes the verdict artifact using `context/contracts/verification-contract.md`.

You do not override verdicts. FAIL is FAIL until re-verified. `NOT_VERIFIED` items are surfaced to the user so they can decide whether to accept, fix, or skip. A technically green build is not enough for PASS when the `Definition Of Done` says the user still cannot run, understand, inspect, or act on the result.

## Output

- Verdict artifact: `<session-basename>-review.md`
- Session file updated with verification report and status
- Structured sidecars updated: `state.json`, `acceptance.json`, and `evidence.json`
- Acceptance evidence preserves AC ids and uses structured evidence refs; prose-only behavior claims are not clean verification evidence
- Verdict follows `context/contracts/verification-contract.md`

If `record-evidence` or artifact validation is unavailable or blocked, keep the verdict explicit and record the sidecar-write gap as `NOT_VERIFIED`. Do not convert verifier output into `PASS` without structured evidence when sidecars are required.
