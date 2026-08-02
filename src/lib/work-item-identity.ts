import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export type GitHubWorkItemIdentity = {
  owner: string;
  name: string;
  issueNumber: number;
  ref: string;
  slug: string;
};

type SubjectIdentityHelper = {
  workItemSlugResult: (ref: string) => { slug: string | null; error: string | null };
  parseGitHubWorkItemRefResult: (ref: string) => { parsed: { owner: string; name: string; issueNumber: number } | null; error: string | null };
};

/**
 * Delegate to the shared pure-CJS subject-identity derivation
 * (`scripts/hooks/lib/subject-identity.js`) — the SINGLE definition of the deterministic
 * subject id, so the hooks (which cannot import TypeScript) and this CLI can never
 * disagree about what a backlog item's collision key is. A divergence here would
 * silently un-join the liveness collision check, which is the exact defect class
 * flow-agents#1099 records.
 *
 * Same createRequire idiom as src/lib/liveness-fleet.ts / src/lib/flow-resolver.ts:
 * `build/src/lib/*.js` → `../../../scripts/hooks/lib/*.js`. Loaded lazily and memoized so a
 * module-scope import of this file never pays for the resolve.
 *
 * The helper returns `{ value, error }` rather than throwing so hook code can call it on
 * untrusted prompt text; the thrown-message strings live in the helper and are re-thrown
 * verbatim here, keeping this function's observable error contract unchanged.
 */
let helperCache: SubjectIdentityHelper | null = null;
function subjectIdentity(): SubjectIdentityHelper {
  if (helperCache) return helperCache;
  const req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/subject-identity.js");
  helperCache = req(helperPath) as SubjectIdentityHelper;
  return helperCache;
}

function parseGitHubWorkItemRef(ref: string): { owner: string; name: string; issueNumber: number } {
  const { parsed, error } = subjectIdentity().parseGitHubWorkItemRefResult(ref);
  if (error !== null) throw new Error(error);
  return parsed!;
}

export function workItemSlug(ref: string): string {
  const { slug, error } = subjectIdentity().workItemSlugResult(ref);
  if (error !== null) throw new Error(error);
  return slug!;
}

export function githubWorkItemIdentity(ref: string): GitHubWorkItemIdentity {
  const parsed = parseGitHubWorkItemRef(ref);
  return {
    owner: parsed.owner,
    name: parsed.name,
    issueNumber: parsed.issueNumber,
    ref,
    slug: workItemSlug(ref),
  };
}
