# Delivery Contract

Delivery chains planning, execution, review, verification, Goal Fit, and final acceptance until the user-facing goal is genuinely handled.

## Workflow

1. Create or resume a session artifact that follows `context/contracts/artifact-contract.md`.
2. Plan with `context/contracts/planning-contract.md`.
3. Execute with `context/contracts/execution-contract.md`.
4. Review code quality and security where relevant. Reviews are report-only.
5. Verify with `context/contracts/verification-contract.md`.
6. Route failures, findings, and `NOT_VERIFIED` gaps back through execution or to an explicit user decision.
7. Complete the Goal Fit Gate before final response.
8. Publish verified changes before release readiness: commit the verified diff, push the branch, open or update the provider change record or record an explicit no-provider-change reason, and collect provider check evidence.
9. Run release readiness against the provider change/branch/check state, not only local verification.
10. Complete Final Acceptance and docs promotion after CI, merge, release, or explicit acceptance.

## Delegation Gates

Delivery orchestrators must invoke the primitive delegates for the planning and verification gates:

- `plan-work` delegates planning to `tool-planner`.
- `review-work` delegates critique to `tool-code-reviewer` and conditionally to `tool-security-reviewer`.
- `verify-work` delegates verification to `tool-verifier`.
- UI or browser-facing verification also delegates to `tool-playwright`.

These gates still apply when the environment is read-only, the repository is not writable, or a prerequisite is missing. In blocked environments, attempt the required delegation first when the tool is available, then report the blocked result as `NOT_VERIFIED` or `FAIL` with evidence. Do not replace the delegate gate with a local summary.

When reporting gate progress or final delivery evidence, name the exact delegate ids (`tool-planner`, `tool-worker`, `tool-code-reviewer`, `tool-security-reviewer`, `tool-verifier`, `tool-playwright`) rather than generic labels like planner, worker, reviewer, verifier, or browser verifier. Exact names make telemetry gaps and text-only evals auditable.

## Goal Fit Gate

Before claiming delivery, the session artifact must answer:

- [ ] Original user goal restated
- [ ] Every acceptance criterion has evidence
- [ ] User-facing workflow was exercised or documented
- [ ] Local/project and global scope are handled when relevant
- [ ] Unknown, NOT_VERIFIED, and TODO gaps are resolved or explicitly accepted
- [ ] Dashboard/UI changes have visual evidence when relevant
- [ ] Durable docs target is updated, scheduled for final acceptance, or marked not needed with reason

## Loop Rules

- Reviewers and verifiers are report-only.
- Any code change after review or verification requires another clean review and verification pass.
- CRITICAL or HIGH review findings route through re-planning unless the fix is explicitly narrow and safe.
- MEDIUM findings and verification FAIL items route through an execution fix pass.
- The loop exits only when review and verification are clean in the same iteration and Goal Fit is complete or explicitly accepted.

## Final Acceptance

After CI passes and the work is merged, released, or otherwise accepted:

- [ ] CI/relevant checks passed
- [ ] verified diff committed and pushed
- [ ] provider change record created or updated, or explicit no-provider-change reason recorded
- [ ] merge, release, or hold decision recorded
- [ ] working artifacts archived or linked
- [ ] long-lived docs updated with why and how the feature was built
- [ ] durable docs link back to the provider record, archived plan, or session artifact when useful
- [ ] local `.flow-agents/` runtime artifacts remain untracked, and durable outcomes are promoted before merge to `main`
- [ ] follow-up issues or learning-review items created for deferred work
- [ ] **workspace cleaned up after a confirmed merge**: the merge is verified from the provider's own merge record (a merge commit / `mergedAt`), not a green check or a command exit code; then the isolated worktree is removed and the now-merged branch is deleted locally and on the remote, honoring the `worktree_lifecycle` (`retain_until: pr_merged`) recorded at selection. Never delete a branch or worktree before the merge is confirmed. A delivery is not complete while it leaves a stale worktree or merged branch behind.

## Distribution Rule

This contract is shared across Codex, Kiro, Claude Code, and future distributions. Distribution-specific files may adapt paths, tool names, and hook wiring, but they should not redefine the workflow rules independently.

GitHub PRs are the first `ChangeProvider` adapter example: in GitHub-backed projects, the provider change record is normally a PR and provider checks are normally PR checks.
