/**
 * Local-file adapters that formally satisfy `provider-interfaces.ts`'s `AssignmentProvider` and
 * `WorkItemMutationProvider` interfaces (#777 implementability proof), mirroring
 * `github-change-provider.ts`'s `createGithubChangeProvider(...): ChangeProvider` precedent: each
 * factory below returns an object literal annotated with the interface's return type, so `tsc`
 * itself rejects a drifted adapter shape — the type-level half of the proof. The behavioral half
 * is `local-file-provider-adapters.test.mjs`, which constructs each adapter through its interface
 * and drives it exactly as a host would (claim -> status -> list -> release; mutate -> status).
 *
 * Why local-file, not GitHub, for both: `AssignmentProvider`'s local-file operations
 * (`performLocalClaim`/`performLocalRelease`/`performLocalSupersede`/`readLocalAssignmentStatus`)
 * already match the interface's per-call shape exactly (no adapter-construction-time state beyond
 * `artifactRoot`, which plays the same role `file` plays for the mutation adapter below). The
 * GitHub side of both interfaces (`render-claim`/`render-supersede`,
 * `renderGithubMutation`) is deliberately NOT adapted here — it needs extra per-call GitHub
 * coordinates (`RenderClaimInput`, `GithubMutationTarget`) the provider-neutral interfaces do not
 * carry (see `provider-interfaces.ts`'s `WorkItemMutationProvider.mutate` doc comment for why),
 * so forcing a same-shaped factory for it would either narrow the interface to GitHub's shape or
 * silently drop required GitHub inputs — neither is a faithful proof.
 *
 * @module
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson } from "../lib/fs.js";
import type { AssignmentProvider, WorkItemMutationProvider } from "./provider-interfaces.js";
import {
  performLocalClaim,
  performLocalRelease,
  performLocalSupersede,
  readLocalAssignmentStatus,
  type AssignmentClaimRecord,
} from "./assignment-provider.js";
import { applyLocalFileMutation } from "./work-item-mutation-provider.js";

/**
 * Enumerate subject ids with an active (`status: "claimed"`) local-file assignment record,
 * optionally filtered to one actor's canonical actor key. Mirrors `listCommand`'s local-file
 * branch in `assignment-provider.ts` exactly (same `<artifactRoot>/assignment/*.json` directory
 * convention, same `readJson` helper) — that branch is CLI-internal (not exported as a bare
 * function), so this is the one piece of glue this module cannot import outright; the actor-key
 * comparison itself is NOT reimplemented here — it delegates to the already-exported
 * `readLocalAssignmentStatus`, whose `assignee` field is the same serialized actor key
 * `listCommand` compares against, so no second actor-serialization logic exists in this file.
 */
function listLocalFileAssignments(artifactRoot: string, actorKey?: string): string[] {
  const dir = path.join(artifactRoot, "assignment");
  if (!fs.existsSync(dir)) return [];
  const subjectIds: string[] = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
    const record = readJson(path.join(dir, name)) as AssignmentClaimRecord;
    if (record.status !== "claimed") continue;
    if (actorKey && readLocalAssignmentStatus(artifactRoot, record.subject_id).assignee !== actorKey) continue;
    subjectIds.push(record.subject_id);
  }
  return subjectIds;
}

/**
 * `AssignmentProvider` adapter over the local-file assignment record store rooted at
 * `artifactRoot` (the same `<artifactRoot>/assignment/<sanitized-subject-id>.json` convention
 * `assignment-provider-contract.md`'s "local-file mapping" section documents). Every method below
 * delegates directly to `assignment-provider.ts`'s existing exported functions — `claim`/
 * `release`/`supersede`/`status` have no logic of their own here, only the `artifactRoot`
 * partial-application `performLocalClaim` et al. already require as their first argument.
 */
export function createLocalFileAssignmentProvider(artifactRoot: string): AssignmentProvider {
  return {
    claim: (subjectId, actor, meta) => performLocalClaim(artifactRoot, subjectId, actor, meta),
    release: (subjectId, releasedBy, meta) => performLocalRelease(artifactRoot, subjectId, releasedBy, meta ?? {}),
    supersede: (subjectId, from, to, meta) => performLocalSupersede(artifactRoot, subjectId, from, to, meta ?? {}),
    status: (subjectId) => readLocalAssignmentStatus(artifactRoot, subjectId),
    list: (actorKey) => listLocalFileAssignments(artifactRoot, actorKey),
  } satisfies AssignmentProvider;
}

/**
 * `WorkItemMutationProvider` adapter over a local-file backlog document at `file` (the
 * `LocalFileBacklogDoc` shape `work-item-mutation-provider.ts` reads/writes). `mutate` delegates
 * directly to `applyLocalFileMutation`, which self-observes current state under
 * `withSubjectLock` and always returns `applied`/`conflict`/`rejected` — the `observed` parameter
 * `WorkItemMutationProvider.mutate` accepts for adapters that cannot self-observe is therefore
 * unused here by design, not an oversight (see that interface method's doc comment).
 */
export function createLocalFileMutationProvider(file: string): WorkItemMutationProvider {
  return {
    mutate: (request) => applyLocalFileMutation(file, request),
  } satisfies WorkItemMutationProvider;
}
