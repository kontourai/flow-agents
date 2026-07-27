import type { ChangeProviderSettings } from "./public-contracts.js";
import { mergeGithubChangeExactHead, type GithubChangeProviderDependencies } from "./github-change-provider.js";
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
