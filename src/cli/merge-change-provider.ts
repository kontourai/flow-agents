import type { ChangeProviderSettings } from "./public-contracts.js";
import { inspectGithubMergeBranchPolicy, mergeGithubChangeExactHead, type GithubChangeProviderDependencies, type MergeBranchPolicyPreflight } from "./github-change-provider.js";
import {
  assertAuthenticatedMergeChangeObservation,
  assertIssuedMergeChangeAction,
  type AuthenticatedMergeChangeObservation,
  type IssuedMergeChangeAction,
} from "../merge-change-operation-authority.js";

/**
 * Provider-neutral merge completion boundary.  Callers may provide an issued
 * action only; they cannot provide a provider result or bypass exact-head
 * check refresh.  The GitHub adapter is intentionally the sole implementation.
 */
export async function executeMergeChangeProvider(
  settings: ChangeProviderSettings,
  actionInput: IssuedMergeChangeAction,
  dependencies: GithubChangeProviderDependencies = {},
): Promise<AuthenticatedMergeChangeObservation> {
  const action = assertIssuedMergeChangeAction(actionInput);
  if (!settings.capabilities.includes("change.merge")) {
    throw new Error("merge-change requires a ChangeProvider configured with change.merge capability");
  }
  return assertAuthenticatedMergeChangeObservation(action, await mergeGithubChangeExactHead(settings, action, dependencies));
}

export type { MergeBranchPolicyPreflight };

/**
 * Read-only, provider-neutral merge precondition preflight (#1318).  It runs
 * the same repository/branch-level policy observations `executeMergeChangeProvider`
 * asserts immediately before mutation, so `merge-change request` can refuse an
 * unsatisfiable branch policy BEFORE an authorization is minted and signed.
 * It performs no mutation and returns a verdict rather than throwing on policy.
 */
export async function preflightMergeChangeProvider(
  settings: ChangeProviderSettings,
  actionInput: IssuedMergeChangeAction,
  dependencies: GithubChangeProviderDependencies = {},
): Promise<MergeBranchPolicyPreflight> {
  const action = assertIssuedMergeChangeAction(actionInput);
  if (!settings.capabilities.includes("change.merge")) {
    throw new Error("merge-change requires a ChangeProvider configured with change.merge capability");
  }
  return inspectGithubMergeBranchPolicy(settings, action, dependencies);
}
