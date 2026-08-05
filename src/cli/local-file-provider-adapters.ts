/**
 * Local-file adapters that formally satisfy `provider-interfaces.ts`'s `AssignmentProvider`
 * (plus its `LocalAssignmentProviderExt` capability extension) and `WorkItemMutationProvider`
 * interfaces (#777 implementability proof), mirroring `github-change-provider.ts`'s
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
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson } from "../lib/fs.js";
import type { AssignmentProvider, LocalAssignmentProviderExt, WorkItemMutationProvider } from "./provider-interfaces.js";
import {
  canonicalHolderActorKey,
  performLocalClaim,
  performLocalRelease,
  performLocalSupersede,
  readLocalAssignmentStatus,
  type AssignmentClaimRecord,
} from "./assignment-provider.js";
import { applyLocalFileMutation } from "./work-item-mutation-provider.js";

/**
 * Enumerate subject ids with an active (`status: "claimed"`) local-file assignment record,
 * optionally filtered to one actor's CANONICAL actor key. Mirrors `listCommand`'s local-file
 * branch in `assignment-provider.ts` for the directory-scan convention (same
 * `<artifactRoot>/assignment/*.json` layout, same `readJson` helper — that branch is
 * CLI-internal, not exported as a bare function, so this directory scan is the one piece of glue
 * this module cannot import outright). The actor-key COMPARISON itself, however, deliberately
 * does NOT mirror `listCommand`'s (`serializeActor(record.actor)`, unconditionally re-derived):
 * that comparison gives the wrong answer for an explicit-override actor whose stored `actor_key`
 * diverges from a re-serialization of its `actor` struct (assignment-provider-contract.md's
 * `actor_key` field doc). This function instead delegates to the exported
 * `canonicalHolderActorKey()` (`assignment-provider.ts`) — the SAME canonical-key rule
 * `computeEffectiveState` already uses for self-recognition — so this adapter's `list()` and the
 * rest of this repository's holder-identity comparisons can never diverge (#777 review finding 3).
 */
function listLocalFileAssignments(artifactRoot: string, actorKey?: string): string[] {
  const dir = path.join(artifactRoot, "assignment");
  if (!fs.existsSync(dir)) return [];
  const subjectIds: string[] = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
    const record = readJson(path.join(dir, name)) as AssignmentClaimRecord;
    if (record.status !== "claimed") continue;
    if (actorKey && canonicalHolderActorKey(record) !== actorKey) continue;
    subjectIds.push(record.subject_id);
  }
  return subjectIds;
}

/**
 * `AssignmentProvider` (+ `LocalAssignmentProviderExt`) adapter over the local-file assignment
 * record store rooted at `artifactRoot` (the same
 * `<artifactRoot>/assignment/<sanitized-subject-id>.json` convention
 * assignment-provider-contract.md's "local-file mapping" section documents).
 *
 * The neutral `claim`/`release`/`supersede` methods delegate to the same
 * `performLocalClaim`/`performLocalRelease`/`performLocalSupersede` functions as their
 * `*Returning` extension counterparts, only discarding the return value to match
 * `AssignmentProvider`'s ADR-0021-faithful `void` surface (#777 review finding 1) — there is
 * exactly one write path per operation, never two independent implementations to keep in sync.
 * `status`/`list` have no `Returning` counterpart (the neutral interface already returns their
 * full value).
 */
export function createLocalFileAssignmentProvider(artifactRoot: string): AssignmentProvider & LocalAssignmentProviderExt {
  return {
    claim: (subjectId, actor, meta) => {
      performLocalClaim(artifactRoot, subjectId, actor, meta);
    },
    release: (subjectId, releasedBy, meta) => {
      performLocalRelease(artifactRoot, subjectId, releasedBy, meta ?? {});
    },
    supersede: (subjectId, from, to, meta) => {
      performLocalSupersede(artifactRoot, subjectId, from, to, meta ?? {});
    },
    status: (subjectId) => readLocalAssignmentStatus(artifactRoot, subjectId),
    list: (actorKey) => listLocalFileAssignments(artifactRoot, actorKey),
    claimReturning: (subjectId, actor, meta) => performLocalClaim(artifactRoot, subjectId, actor, meta),
    releaseReturning: (subjectId, releasedBy, meta) => performLocalRelease(artifactRoot, subjectId, releasedBy, meta ?? {}),
    supersedeReturning: (subjectId, from, to, meta) => performLocalSupersede(artifactRoot, subjectId, from, to, meta ?? {}),
  } satisfies AssignmentProvider & LocalAssignmentProviderExt;
}

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
