/**
 * Bounded repository-change observation for Context Check input.
 *
 * `@kontourai/lookout` observes drift in registered web, API and structured-file sources over guarded
 * HTTP; it has no source kind for a Git revision pair, so this is the thin shim between "two raw
 * commits" and the `diff.paths` a Context Check takes. Tracked as an upstream request in the
 * owning repo (see the Living Context PR). Replace this shim with the Lookout source when it exists.
 *
 * @module observe-change
 */

import { error, gitRaw, resolveRevisionBoundRepository, safeRelativePath } from "./index.js";

/** Default ceiling on changed paths. A larger change is refused, not truncated: a partial surface set would under-report drift. */
export const DEFAULT_MAX_CHANGED_PATHS = 500;

/**
 * Observe the paths touched between two raw commits.
 *
 * @param {{ repoRoot: string, base: string, head: string, maxPaths?: number }} options
 * @returns {{ base: string, head: string, diff: { paths: string[] } }}
 */
export function observeRepositoryChange({ repoRoot, base, head, maxPaths = DEFAULT_MAX_CHANGED_PATHS } = {}) {
  if (!Number.isInteger(maxPaths) || maxPaths < 1) throw error("INVALID_CHANGE_BOUND", "maxPaths must be a positive integer");
  const from = resolveRevisionBoundRepository(repoRoot, base);
  const to = resolveRevisionBoundRepository(repoRoot, head);
  // --no-renames lists both sides of a rename; -z keeps unusual path bytes intact; hooks and textconv never run.
  const raw = gitRaw(to.root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", from.revision, to.revision]);
  const paths = [...new Set(raw.split("\0").filter((entry) => entry.length > 0))].sort();
  if (paths.length === 0) throw error("EMPTY_CHANGE", "the two revisions touch no paths; there is no change to reconcile");
  // Read the whole list, then refuse above the bound; a truncated list would silently under-report.
  if (paths.length > maxPaths) throw error("CHANGE_TOO_LARGE", `the change touches ${paths.length} paths, above the ${maxPaths}-path bound; narrow the revision range`);
  return { base: from.revision, head: to.revision, diff: { paths: paths.map((entry) => safeRelativePath(entry, "changed path")) } };
}
