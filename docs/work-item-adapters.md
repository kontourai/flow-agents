---
title: Work Item And Change Adapters
---

# Work Item And Change Adapters

Flow Agents uses provider-neutral workflow vocabulary and maps it to concrete tools through adapters. GitHub is the first adapter and the most common example, but core workflow gates should talk about work items, boards, changes, checks, and evidence instead of assuming GitHub-specific records.

The source contract is `context/contracts/work-item-contract.md`.

## Provider Roles

Use these roles in artifacts and docs:

- `WorkItemProvider`: issue-like requested work, defects, chores, or decisions.
- `BoardProvider`: project, board, queue, sprint, milestone, or planning state.
- `ChangeProvider`: published implementation records such as pull requests, merge requests, changesets, release proposals, or deploy requests.

A provider can implement more than one role. GitHub Issues maps to `WorkItemProvider`, GitHub Projects maps to `BoardProvider`, and GitHub Pull Requests maps to `ChangeProvider`.

## Publish Change

`publish-change` runs after local evidence is clean enough to share and before release readiness. It should produce a `PublishChangeResult` with:

- `work_item_refs`: the selected work items the change intends to satisfy.
- `board_refs`: any board/project/queue records that contextualize the work.
- `change_ref`: the published provider change record.
- `closing_reference_check`: whether the provider recognized expected close/resolve references.
- `provider_checks`: CI, status, review, mergeability, deployment, policy, or equivalent checks.
- `evidence_refs`: local sidecars, verification reports, standard evidence artifacts, and provider-native proof.

If a provider is unavailable, record `not_verified` unless the workflow explicitly selected a low-risk no-provider path.

### Authenticated operation boundary

The Builder `pull-request-opened` gate is completed through the provider-neutral public operation,
not by writing a generic `PublishChangeResult`. When effective ChangeProvider settings are
configured, status exposes `flow-agents publish-change execute --session-dir <session-dir>` with
bounded title, body, base ref, head ref, and optional draft inputs. Settings are deep-merged in
ascending precedence: global defaults, matching global project entry, project defaults, then the
matching project entry in `context/settings/change-provider-settings.json`; the global file is
`$HOME/.config/flow-agents/change-provider-settings.json`. Unconfigured or incompatible settings stay
`external_capability_required` and expose no executable completion path.

The command derives repository, immutable head SHA, assignment actor, canonical run, and current
gate visit. The adapter returns a bounded, authenticated observation containing provider identity
and adapter, repository, provider record id/number/HTTPS URL, normalized published state
(`open` or `merged`), base/head refs and SHA,
actor, and observation time. Flow rechecks the assignment, gate visit, request binding, and provider
configuration under its subject lock; it then persists only `publish-change.result.json`, records
only `pull-request-opened`, requires Flow to advance exactly one canonical step, and projects the result.

Caller-authored JSON, generic continuation evidence, and package-private writers are not adapter
results and cannot advance the gate. Authentication material and raw provider diagnostics must not
be placed in settings, result artifacts, evidence, logs, or snapshots. Provider failures remain
failures: callers correct the condition and retry the public operation; they do not bypass it with
a local result file.

## Planning Base Drift

When a work item is shaped for the backlog, record the target ref and commit SHA that informed the plan, usually current `main`. Provider adapters should preserve that as `planned_base_ref`, `planned_base_sha`, `planned_at`, and `planning_artifact_ref` when possible.

At pickup time, compare the current target SHA with the planned base SHA before planning implementation. If relevant files, docs, contracts, schemas, or dependency states changed, pickup Probe should classify the drift as `no_material_drift`, `scope_drift`, `dependency_drift`, `contract_drift`, or `conflict_risk` and ask for alignment when the drift changes scope or risk. This material-drift judgment is a distinct dimension from `pull-work`'s mechanical `fresh`/`drifted`/`stale`/`not_verified` freshness severity (work-item-contract.md "Planning Base And Drift") — Probe produces the former from the latter plus dependency/scope/conflict context, it does not replace it.

GitHub can store this in the issue body, a managed comment, a source artifact, or adapter metadata. Core workflow logic should still treat it as provider-neutral work item metadata.

## GitHub Adapter Example

For GitHub, `publish-change` usually means:

- commit the verified diff
- push the branch
- open or update a pull request
- render the pull request body from a file or structured template
- include issue closing references, workflow evidence, verification summary, and artifact links
- ask GitHub which issue references it recognizes
- collect pull request checks, required reviews, mergeability, and status checks

The shipped GitHub adapter uses direct `gh` argv behind the `ChangeProvider` interface. It
authenticates, finds an exact published pull request by configured repository/base/head/SHA and
title/body/draft intent, or creates one only when none exists; it then re-observes the canonical
record. Open records support the normal path, while merged records support truthful reconciliation
after provider work completed ahead of the local run. An ambiguous create failure triggers one
recovery query before failure is returned. Multiple matches, a closed-but-unmerged/stale/wrong record, malformed output, unavailable `gh`, or failed
authentication must not select a record or create a duplicate.

GitHub-specific words belong in adapter sections and examples. The shared workflow result should still be expressed as `change_ref`, `closing_reference_check`, `provider_checks`, and `evidence_refs`.

## Risk-Based Missing Checks

Provider checks are not equally important for every change.

Docs-only changes can pass with an explicit `skip` when:

- the repository does not require a provider check for the change
- local diff review or docs validation is enough for the stated risk
- the evidence names the skipped check and the reason

Runtime, schema, package, hook, security, migration, release, infrastructure, or deployment changes require stronger evidence. Missing provider checks for those changes must become `not_verified` in evidence-gate or `hold` in release-readiness until CI or equivalent proof is available.

Do not treat missing CI, missing required review, missing branch protection data, or provider API failure as a clean pass for risky changes.

## Artifact Lifecycle

Local workflow artifacts under `.kontourai/flow-agents/<slug>/` or a distribution-specific artifact root are runtime/session state by default. Provider records may link to those artifacts, but long-lived decisions should be promoted into durable docs, release notes, changelogs, ADRs, or provider comments/descriptions that are intended to persist.
