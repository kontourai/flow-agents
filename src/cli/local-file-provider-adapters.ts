/**
 * Local-file adapters that formally satisfy `provider-interfaces.ts`'s `AssignmentProvider`
 * (plus its `LocalAssignmentProviderExt` capability extension; the assignment adapter itself now
 * lives in `src/lib/assignment-local-store.ts` so it can ship as its own subpath and is re-exported
 * here unchanged) and `WorkItemMutationProvider` interfaces (#777 implementability proof), mirroring `github-change-provider.ts`'s
 * `createGithubChangeProvider(...): ChangeProvider` precedent: each factory below returns an
 * object literal annotated with the interface's return type, so `tsc` itself rejects a drifted
 * adapter shape — the type-level half of the proof. The behavioral half is
 * `local-file-provider-adapters.test.mjs`, which constructs each adapter through its interface
 * and drives it exactly as a host would (claim -> status -> list -> release; mutate -> status).
 *
 * Why local-file, not GitHub, for both: `AssignmentProvider`'s local-file operations
 * (`performLocalClaim`/`performLocalRelease`/`performLocalSupersede`/`readLocalAssignmentStatus`)
 * already match the interface's per-call shape exactly (no adapter-construction-time state beyond
 * `artifactRoot`, which plays the same role `file` plays for the mutation adapter below). The
 * GitHub side of `AssignmentProvider` (`render-claim`/`render-release`/`render-supersede`) is
 * deliberately NOT adapted here — it needs extra per-call GitHub coordinates (`RenderClaimInput`)
 * the provider-neutral interface does not carry. The GitHub side of `WorkItemMutationProvider` IS
 * proven, but in a separate file — see `github-mutation-renderer.ts`'s `createGithubMutationRenderer`
 * (#777 review finding 4).
 *
 * @module
 */
import type { WorkItemMutationProvider } from "./provider-interfaces.js";
import { applyLocalFileMutation } from "./work-item-mutation-provider.js";

export { createLocalFileAssignmentProvider } from "../lib/assignment-local-store.js";

/**
 * `WorkItemMutationProvider` adapter over a local-file backlog document at `file` (the
 * `LocalFileBacklogDoc` shape `work-item-mutation-provider.ts` reads/writes). `mutate` delegates
 * directly to `applyLocalFileMutation`, which self-observes current state under
 * `withSubjectLock` and always returns `applied`/`conflict`/`rejected` — `context` (the
 * `WorkItemMutationProvider.mutate` parameter for adapters that cannot self-observe, or that need
 * an adapter-specific `providerTarget`) is therefore unused here by design, not an oversight (see
 * that interface method's doc comment; contrast with `github-mutation-renderer.ts`'s
 * `createGithubMutationRenderer`, which DOES require `context`).
 */
export function createLocalFileMutationProvider(file: string): WorkItemMutationProvider {
  return {
    mutate: (request) => applyLocalFileMutation(file, request),
  } satisfies WorkItemMutationProvider;
}
