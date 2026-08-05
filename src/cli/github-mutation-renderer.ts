/**
 * GitHub-render adapter that formally satisfies `provider-interfaces.ts`'s
 * `WorkItemMutationProvider` interface (#777 review finding 4), proving that interface types BOTH
 * shipped mutation implementations, not only the local-file one (`local-file-provider-adapters.ts`).
 *
 * `renderGithubMutation` (`work-item-mutation-provider.ts`) needs two things the local-file
 * adapter does not: a freshly observed provider-state snapshot (`observed`) and a validated
 * `GithubMutationTarget` (repo/number/optional project-field coordinate) — and needs the target
 * PER CALL, not bound once at construction, because a single renderer instance renders mutations
 * for many different work items over its lifetime (unlike the local-file adapter's `file`, which
 * genuinely is construction-stable). `ProviderMutationContext`'s `observed`/`providerTarget` slots
 * (`provider-interfaces.ts`) exist exactly for this shape — see that interface's doc comment.
 *
 * Render, don't execute: like `renderGithubMutation` itself, this factory's `mutate` never shells
 * out to `gh` — it only renders argv. The calling host executes the rendered `gh_commands`.
 *
 * @module
 */
import { renderGithubMutation, parseGithubMutationTarget } from "./work-item-mutation-provider.js";
import type { WorkItemMutationProvider } from "./provider-interfaces.js";

/**
 * Construct a `WorkItemMutationProvider` that renders `gh` argv via `renderGithubMutation` and
 * never executes it. `providerTarget` is REQUIRED per call via
 * `ProviderMutationContext.providerTarget` — validated/normalized through the already-reviewed
 * `parseGithubMutationTarget` (throws `WorkItemMutationError` on a malformed shape; a well-shaped
 * but MISMATCHED target is instead a `"rejected"` result from `renderGithubMutation` itself, per
 * that function's "Render Target Identity Guard"). `context.observed` is passed straight through
 * to `renderGithubMutation` — `null` when omitted, which yields `not_verified` for any
 * non-`comment` operation exactly as calling `renderGithubMutation` directly would.
 */
export function createGithubMutationRenderer(): WorkItemMutationProvider {
  return {
    mutate: (request, context) => renderGithubMutation(request, context?.observed ?? null, parseGithubMutationTarget(context?.providerTarget)),
  } satisfies WorkItemMutationProvider;
}
