---
title: Fixture Ownership
---

# Fixture Ownership

`evals/fixtures/` is canonical eval source, not generic sample data. Keep fixture
groups only when an owning eval or validator names the behavior they protect.
When adding, moving, or deleting a fixture directory, update this inventory and
run `npm run validate:source --` and `npm run fixture:retirement-audit --`.

## Ownership Inventory

| Fixture directory | Classification | Owners | Cleanup rule |
| --- | --- | --- | --- |
| `evals/fixtures/assignment-provider` | AssignmentProvider local-file and GitHub render/status fixtures (#290) | `evals/integration/test_assignment_provider_local_file.sh`, `evals/integration/test_assignment_provider_github.sh`, `evals/integration/test_pull_work_assignment_join.sh` | Keep while the assignment provider contract's claim/release/supersede/status/list operations and the assignment ⋈ liveness join are tested against local-file and GitHub fixture inputs. |
| `evals/fixtures/backlog-provider-settings` | settings precedence fixtures | `evals/integration/test_effective_backlog_settings.sh` | Keep while backlog provider settings resolution supports global defaults and project overrides. |
| `evals/fixtures/builder-kit-workflow-state` | Builder Kit workflow-state fixtures | `evals/static/test_workflow_skills.sh` | Keep while Builder Kit state contract and resume behavior are documented in workflow skill contracts. |
| `evals/fixtures/console-learning-projection` | console learning projection fixtures | `evals/integration/test_console_learning_projection.sh` | Keep while learning projection supports correction and open-route examples. |
| `evals/fixtures/flow-kit-repository` | Flow Kit repository contract fixtures | `evals/integration/test_flow_kit_repository.sh`, `evals/integration/test_local_flow_kit_install.sh`, `evals/integration/test_runtime_adapter_activation.sh`, `evals/integration/test_activate_npx_context.sh`, `evals/integration/test_flow_kit_install_git.sh`, `evals/static/test_workflow_skills.sh` | Keep valid and invalid cases paired with the Flow Kit repository contract. |
| `evals/fixtures/kit-conformance-levels` | K-level conformance and consumer-target derivation fixtures | `evals/integration/test_kit_conformance_levels.sh` | Keep while K-level derivation, degradation invariant, and consumer-target badge rules are tested. |
| `evals/fixtures/hook-influence` | hook influence behavioral cases | `evals/integration/test_hook_influence_cases.sh`, `evals/static/test_workflow_skills.sh`, `scripts/validate-hook-influence-cases.js` | Keep while hook influence cases define agent guidance behavior. |
| `evals/fixtures/pull-work-provider` | work item provider normalization fixtures | `evals/integration/test_pull_work_provider.sh` | Keep while provider normalization preserves blockers, artifact refs, board membership, and freshness metadata. |
| `evals/fixtures/pull-work-wip-shepherding` | WIP shepherding state fixtures | `evals/static/test_workflow_skills.sh` | Keep while pull-work documents personal versus global WIP behavior. |
| `evals/fixtures/surface-trust` | Surface trust evidence fixtures | `evals/integration/test_workflow_sidecar_writer.sh` | Keep while sidecar writer maps Surface trust evidence into workflow records. |
| `evals/fixtures/trust-reconcile-exploits` | WS8 trust-reconcile anti-gaming exploit fixtures (frozen negative regressions) | `evals/integration/test_trust_reconcile_negatives.sh` | Keep while trust-reconcile.js enforces the WS8 iteration-2 soundness properties (no-label test_output, unwaived-assumed, status-misassertion, waiver-on-command); each fixture is a permanent negative regression. |
| `evals/fixtures/trust-reconcile-mixed-bundle` | WS8 trust-reconcile mixed-evidence end-to-end proof fixture | `evals/integration/test_trust_reconcile_mixed_bundle.sh` | Keep while the trust-reconcile manifest/classification/waiver contract (ADR 0020) is enforced; proves a mixed test_output + session-local + waived bundle passes the CI anchor. |
| `evals/fixtures/trust-reconcile-ws3` | WS8 AC6 backward-compat fixture: real ws3-kit-dependencies-namespacing old-style bundle | `evals/integration/test_trust_reconcile_negatives.sh` | Keep while backward compatibility with pre-classification (all-test_output) bundles is asserted; proves an old-style bundle still FAILS the same way (no silent pass). |
| `evals/fixtures/usage-feedback` | usage feedback import/outcome fixtures | `evals/integration/test_usage_feedback_import.sh`, `evals/integration/test_usage_feedback_outcomes.sh`, `evals/integration/test_usage_feedback_report.sh` | Keep while usage feedback import, outcome, and report flows accept JSONL fixture input. |
| `evals/fixtures/veritas-governance-adapter` | Veritas governance adapter fixtures | `evals/integration/test_veritas_governance_adapter.sh` | Keep while the Veritas adapter supports pass, unconfigured, and secret-failure governance paths. |

## Cleanup Policy

Do not delete a fixture group just because a filename has no obvious direct
reference. Many fixture directories are consumed as directories by integration
tests. A fixture deletion is safe only when:

1. The owning eval or validator no longer needs the behavior.
2. This inventory is updated in the same change.
3. `npm run validate:source --` and the owning eval pass.
4. Any contract or docs that described the fixture behavior are updated.

Generated eval output belongs under ignored result directories, not under
`evals/fixtures/`.

`npm run fixture:retirement-audit --` is a read-only retirement pass. It reports
fixture groups as kept when they have documented owners and live eval/script
references. A nonzero retire-candidate count is not permission to delete by
itself; it is a prompt to update or remove the owning eval and fixture together.
