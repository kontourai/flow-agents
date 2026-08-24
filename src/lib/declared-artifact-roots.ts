/**
 * declared-artifact-roots.ts — TypeScript twin of scripts/hooks/lib/declared-artifact-roots.js
 * (#783). Computes the same DECLARED artifact roots the config-protection hook scopes its
 * Bash-command detectors to, so workflow-sidecar.ts's `fixture write` subcommand can refuse to
 * write inside a real declared root using the EXACT same fail-closed contract — a fixture
 * writer that disagreed with the hook about what counts as "inside a declared root" would let an
 * agent author a forged state.json/trust.bundle in a real session directory just by routing the
 * write through the sanctioned CLI instead of a Bash redirect.
 *
 * A path is inside a declared root when it is nested under one of:
 *   1. `cwd`'s OWN git working-tree root (nearest ancestor with a `.git` entry).
 *   2. The SHARED repo root `resolveSharedRepoRoot` resolves for `cwd` (same resolver
 *      `flowAgentsArtifactRoot` uses) — the primary checkout in a linked worktree.
 *   3. Any CONFIGURED workspace root (`SA_PROTECTED_WORKSPACE_ROOTS`, a comma-separated list of
 *      absolute paths) — the SAME env var the hook reads, so one setting scopes both surfaces.
 *
 * Each root contributes three flow-agents-owned sub-roots: `.kontourai/flow-agents`,
 * `.flow-agents`, `delivery`.
 *
 * FAIL-CLOSED CONTRACT (do not weaken): `declaredArtifactRoots` returns `{ ambiguous: true }`
 * whenever `cwd` is genuinely inside a git working tree but `resolveSharedRepoRoot` failed
 * (root detection was ATTEMPTED and FAILED — corrupted gitlink, bad GIT_DIR, git binary
 * missing). Callers MUST treat `ambiguous: true` as "refuse the write", never as "no roots, so
 * nothing is protected".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSharedRepoRoot } from "./local-artifact-root.js";

export const WORKSPACE_ROOTS_ENV = "SA_PROTECTED_WORKSPACE_ROOTS";

export type DeclaredArtifactRoots = { roots: string[]; ambiguous: boolean; repoRoots: string[] };

/** The three flow-agents-owned sub-roots under a single repo/workspace root. */
function subRootsFor(root: string): string[] {
  return [path.join(root, ".kontourai", "flow-agents"), path.join(root, ".flow-agents"), path.join(root, "delivery")];
}

/**
 * isWithinRuntimeArtifactRoot(absPath) -> boolean  (#1280 review FIX-1)
 *
 * The STRUCTURAL half of `subRootsFor`, inverted: rather than enumerate every repo/workspace
 * root and join the three sub-root names onto each, walk the candidate's own ancestors and ask
 * whether any of them OCCUPIES one of those three positions. That answers the question for a
 * path belonging to a repo this process never resolved (a sibling checkout, an installed
 * package tree, a path handed in through an env var) — which is exactly the population
 * `flow-resolver.ts` has to judge when it decides whether a FlowDefinition source is runtime
 * artifact storage rather than shipped, digest-covered kit content.
 *
 * The three positions are the SAME ones `subRootsFor` declares: `<root>/.kontourai/flow-agents`,
 * `<root>/.flow-agents`, `<root>/delivery`. Only `delivery` needs its parent qualified — it is an
 * ordinary word, and a directory named `delivery` is runtime storage only when its parent is a
 * root `declaredArtifactRoots` would derive. That qualification is `isDeclarableRootPosition`,
 * and it is the SAME predicate `declaredArtifactRoots` uses to decide it has one.
 *
 * #1316 review FIX-3: the qualification used to be `walkForGitMarker(parent) === parent` — parent
 * is a git working tree — while `declaredArtifactRoots` ALSO derives a root for a cwd with no git
 * ancestor at all, and declares that root's `delivery/`. So `<non-git-root>/delivery` was declared
 * by one surface and unrecognized by the other, and `<non-git-root>/kits` could symlink into it
 * and still pass `canonicalKitsRoot`. The comment claiming the two "cannot drift" was a claim
 * nothing computed; they now share the predicate, and `declared-artifact-roots.test.mjs` asserts
 * the equivalence directly (every root `declaredArtifactRoots` declares is recognized here)
 * rather than asserting it in prose.
 *
 * Configured workspace roots (`SA_PROTECTED_WORKSPACE_ROOTS`) contribute their three sub-roots
 * verbatim, so one setting still scopes every surface.
 *
 * The path is canonicalized first, so a symlink pointing INTO runtime storage is judged by
 * where it lands, not by how it was spelled.
 *
 * WHAT THIS DOES NOT DERIVE (do not let the name drift back into a claim): it is not a
 * permission or ownership test. Flow Agents' runtime and the agents it governs run as the SAME
 * uid, so no writability check can separate "the agent wrote this" from "the operator wrote
 * this" — an agent-supplied `/tmp/anything` is writable and so is a legitimate custom install
 * directory. What IS derivable, and what this computes, is whether a path lies inside the
 * storage the runtime itself writes session artifacts into. Callers that need a stronger
 * guarantee than "not runtime storage" must require provenance (a packaged, digest-covered
 * artifact), not writability — see `assertKitDeclaredFlow` in src/cli/workflow.ts.
 */
export function isWithinRuntimeArtifactRoot(absPath: string): boolean {
  let dir: string;
  try {
    dir = canonicalize(path.resolve(absPath));
  } catch {
    return true; // cannot canonicalize → cannot prove it is outside runtime storage → fail closed
  }
  const configured = configuredWorkspaceRoots().flatMap((root) => subRootsFor(canonicalize(root)));
  if (isWithinAnyRoot(dir, configured)) return true;
  const root = path.parse(dir).root;
  for (let depth = 0; depth < 1024; depth++) {
    const parent = path.dirname(dir);
    const base = path.basename(dir);
    if (base === ".flow-agents") return true;
    if (base === "flow-agents" && path.basename(parent) === ".kontourai") return true;
    if (base === "delivery" && isDeclarableRootPosition(parent)) return true;
    if (dir === root || parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * True when `dir` occupies a position `declaredArtifactRoots` would derive a root at.
 *
 * The two cases it derives, and nothing else:
 *   - `dir` IS a git working tree (`walkForGitMarker(dir) === dir`) — the `worktreeOwnRoot` branch.
 *   - `dir` has NO git ancestor (`walkForGitMarker(dir) === null`) — the "genuinely no git repo
 *     anywhere above cwd" branch, which mirrors `flowAgentsArtifactRoot`'s own cwd fallback.
 *
 * A directory INSIDE a repo but not its root is neither, which is what keeps an ordinary
 * `src/delivery/` from being read as runtime artifact storage.
 */
function isDeclarableRootPosition(dir: string): boolean {
  const marker = walkForGitMarker(dir);
  return marker === dir || marker === null;
}

/**
 * Nearest ancestor of `startDir` containing a `.git` entry (a directory for a primary checkout,
 * or a file for a linked worktree's gitdir pointer), or null if none found within the bounded
 * walk. Never throws.
 */
function walkForGitMarker(startDir: string): string | null {
  try {
    let dir = path.resolve(startDir);
    const root = path.parse(dir).root;
    for (let depth = 0; depth < 1024; depth++) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Canonicalize a path that may not exist yet: realpath the deepest EXISTING ancestor
 * (resolving symlinks and platform aliases like macOS /var -> /private/var), then re-append
 * the not-yet-existing remainder. Twin of the hook lib's canonicalize — keep in sync.
 */
export function canonicalize(p: string): string {
  try {
    let dir = path.resolve(p);
    const pending: string[] = [];
    const root = path.parse(dir).root;
    for (let depth = 0; depth < 64 && !fs.existsSync(dir); depth++) {
      if (dir === root) break;
      pending.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
    const real = fs.realpathSync(dir);
    return pending.length ? path.join(real, ...pending) : real;
  } catch {
    return path.resolve(p);
  }
}

function configuredWorkspaceRoots(): string[] {
  const raw = String(process.env[WORKSPACE_ROOTS_ENV] || "");
  if (!raw.trim()) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => path.resolve(entry));
}

/**
 * declaredArtifactRoots(cwd) -> { roots, ambiguous, repoRoots }
 *
 * `roots` is always an absolute-path array. When `ambiguous` is true, `roots` is deliberately
 * empty — callers must treat ambiguous as "refuse the write", never fall back to scoping
 * against an empty root list (which would mean "nothing is protected").
 */
export function declaredArtifactRoots(cwd: string = process.cwd()): DeclaredArtifactRoots {
  const resolvedCwd = path.resolve(cwd);
  const worktreeOwnRoot = walkForGitMarker(resolvedCwd);
  const repoRoots = new Set<string>();
  let ambiguous = false;

  if (worktreeOwnRoot) {
    repoRoots.add(worktreeOwnRoot);
    const sharedRoot = resolveSharedRepoRoot(resolvedCwd);
    if (sharedRoot) {
      repoRoots.add(sharedRoot);
    } else {
      // A `.git` entry exists (git resolution was ATTEMPTED) but resolveSharedRepoRoot FAILED.
      // We cannot trust ANY root boundary here. FAIL CLOSED.
      ambiguous = true;
    }
  } else if (isDeclarableRootPosition(resolvedCwd)) {
    // Genuinely no git repo anywhere above cwd: mirror flowAgentsArtifactRoot's own cwd
    // fallback so the declared root matches what a real sidecar session invoked from this same
    // cwd would actually write to. Routed through the SAME predicate the inverted check applies,
    // so this branch cannot declare a `delivery/` the inverted check would not recognize
    // (#1316 review FIX-3). `worktreeOwnRoot` being null already implies this is true; asking
    // through the predicate is what keeps the two surfaces reading one rule.
    repoRoots.add(resolvedCwd);
  }

  const roots: string[] = [];
  if (!ambiguous) {
    // Canonical forms on both sides of every containment comparison (symlinks, /var aliases).
    for (const root of repoRoots) roots.push(...subRootsFor(canonicalize(root)));
    for (const extra of configuredWorkspaceRoots()) roots.push(...subRootsFor(canonicalize(extra)));
  }

  return { roots: [...new Set(roots)], ambiguous, repoRoots: [...repoRoots] };
}

/** True when `absPath` equals, or is nested under, one of `roots`. */
export function isWithinAnyRoot(absPath: string | null | undefined, roots: string[]): boolean {
  if (!absPath) return false;
  return roots.some((root) => absPath === root || absPath.startsWith(root + path.sep));
}

/**
 * isProvablyOutsideDeclaredRoots(candidatePath, cwd) -> boolean
 *
 * The single fail-closed decision point the `fixture write` subcommand uses: true ONLY when
 * root detection succeeded (not ambiguous) AND the resolved candidate path is outside every
 * declared root. False (refuse to treat as safe) when detection is ambiguous OR the path is
 * inside a declared root — the fixture writer's malformed mode requires this to be true before
 * it will write verbatim content anywhere.
 */
export function isProvablyOutsideDeclaredRoots(candidatePath: string, cwd: string = process.cwd()): boolean {
  const { roots, ambiguous } = declaredArtifactRoots(cwd);
  if (ambiguous) return false;
  const canonical = canonicalize(path.resolve(cwd, candidatePath));
  if (isWithinAnyRoot(canonical, roots)) return false;
  // #783 review F3/F4: a target inside ANY git working tree (a sibling checkout, another
  // lane's worktree) is never a provably-safe fixture location, even though that checkout is
  // not among THIS cwd's declared roots — and canonicalization above means a symlink routed
  // into one cannot hide it. Scratch/temp dirs are not git trees, so the sanctioned fixture
  // path is unaffected.
  if (walkForGitMarker(path.dirname(canonical)) !== null) return false;
  return true;
}
