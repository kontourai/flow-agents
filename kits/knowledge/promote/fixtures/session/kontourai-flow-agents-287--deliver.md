# kontourai-flow-agents-287

branch: agent/287-actor-identity
worktree: /tmp/wt-287
created: 2026-07-02T19:35:52Z
status: delivered
type: deliver
iteration: 3

## Plan

Actor struct {runtime, session_id, host, human?} with a stable serialized id; SessionStart derives FLOW_AGENTS_ACTOR; the sidecar fails loudly on a missing/local actor for liveness writes.

## Definition Of Done

- **User outcome:** Actor identity is a stable serialized struct so two concurrent sessions on one host never collide in the liveness stream.
- **Scope:** Workflow session artifacts and sidecars.
- **Acceptance criteria:**
  - [x] Two concurrent sessions on one host produce distinct actors; liveness status shows two holders; an unset actor on a liveness write fails with remediation.
- **Durable docs target:** docs/decisions (actor identity)
- **Sandbox mode:** local-edit

## Decisions

- **Actor identity** — Agent identity is a serialized struct {runtime, session_id, host, human?} with a stable id; the sidecar fails closed (loud) on a missing or `local` actor for any liveness write, so concurrent same-host sessions never collide.

## Execution Progress

- [x] Actor struct + resolver implemented; SessionStart derives FLOW_AGENTS_ACTOR.
- [x] Liveness writes fail closed on unset/local actor.

## Verification Report

Build: [PASS]

### Acceptance Criteria
- [PASS] Two concurrent sessions produce distinct actors; unset actor fails loud - Evidence: integration eval test_actor_identity.sh.

### Verdict: PASS

## Goal Fit Gate

- [x] Original user goal restated and met.

## Final Acceptance

- [x] CI/relevant checks passed.
