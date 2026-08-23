// Overwrite guard for `flow-agents init`'s bundle install paths (kontourai/flow-agents#1288).
//
// The project bundle installers (`dist/<runtime>/install.sh`) rsync the bundle tree into the
// destination, and the --global claude-code path copies skills/agents into the user's config
// root. Before this guard, any existing destination file whose path collided with a bundle
// path -- including a user-authored README.md or ~/.claude/agents file -- was silently
// overwritten, and kiro's `--delete` sync could remove destination files the install never
// classified at all. This module computes, BEFORE any write, what the install would do to
// every bundle-shipped path (and, when removals are enabled, to every previously-owned path
// the bundle no longer ships), and classifies each one:
//
//   - create:    no destination entry exists; the install writes a new file.
//   - unchanged: the destination file is byte-identical to the incoming bundle file.
//   - replace:   the destination file differs from the incoming bundle file but hash-matches
//                the ownership manifest a PREVIOUS install recorded (`.flow-agents/
//                owned-files.json`, the same contract `init --uninstall` consumes via
//                readOwnedFilesManifest) -- i.e. stale bundle-owned content. Updating it is
//                the normal upgrade path and needs no --force.
//   - preserve:  the destination entry exists and is NOT known bundle-owned content (a
//                user-authored or user-modified file, or a non-regular entry such as a
//                symlink). The install must keep it and report it.
//   - force-overwrite: a would-be "preserve" entry the caller explicitly opted to overwrite
//                with --force.
//   - remove:    (removals mode, replacing kiro's blanket `rsync --delete`) a path the
//                ownership manifest records as installed by a previous run, absent from the
//                incoming bundle, whose on-disk content still hash-matches the manifest.
//                Only these are deleted; a modified formerly-owned file is preserved and
//                reported, and unowned files are never deletion candidates at all.
//
// Preserved paths are passed to install.sh as `--exclude-path` rsync excludes, so the copy
// itself never touches them. This deliberately REUSES the uninstall path's ownership
// machinery (owned-files-manifest.ts: listOwnedTree/hashFile/readOwnedFilesManifest and the
// manifest-entry containment checks) rather than inventing a second hashing convention --
// "user-modified => keep + report" is the same rule uninstall already honours.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertManifestEntryParentContained,
  hashFile,
  listOwnedTree,
  readOwnedFilesManifest,
  resolveManifestEntryPath,
} from "../lib/owned-files-manifest.js";

export type InstallPlanAction = "create" | "unchanged" | "replace" | "preserve" | "force-overwrite";

export type InstallPlanEntry = { rel: string; action: InstallPlanAction; sourcePath: string; destPath: string };

/** A manifest-driven removal candidate (see module doc: "remove"). */
export type InstallPlanRemoval = { rel: string; destPath: string; sha256: string };

export type InstallPlanMapping = { sourceDir: string; destDir: string; prefix: string };

export type InstallPlan = {
  entries: InstallPlanEntry[];
  created: string[];
  unchanged: string[];
  replaced: string[];
  preserved: string[];
  forced: string[];
  /** Manifest-owned, absent from the bundle, still hash-matching: deleted by the install. */
  removals: InstallPlanRemoval[];
  /** Manifest-owned, absent from the bundle, since modified (or now a symlink): kept + reported. */
  preservedFormerlyOwned: string[];
  removalsEnabled: boolean;
};

/**
 * Thrown when a bundle path's PARENT directory exists in the destination as a symlink.
 * Children classified through the link would not be what the rsync actually touches -- rsync
 * replaces the unclassified symlink itself with a real directory -- so the only honest
 * disposition is to refuse before any write, naming every offending component.
 */
export class InstallPlanSymlinkParentError extends Error {
  constructor(public readonly symlinkParents: string[]) {
    super(
      `refusing to install through symlinked destination directories: ${symlinkParents.join(", ")} ` +
      "(the install would replace the symlink itself with a real directory; resolve or remove the symlink first)"
    );
  }
}

/** Thrown by verifyInstallPlanMatchesDisk when the destination changed after planning. */
export class InstallPlanDriftError extends Error {
  constructor(public readonly driftedPaths: string[]) {
    super(
      `destination changed between planning and install for: ${driftedPaths.slice(0, 20).join(", ")}` +
      `${driftedPaths.length > 20 ? ` (+${driftedPaths.length - 20} more)` : ""}; nothing was written -- re-run flow-agents init`
    );
  }
}

// Relative paths install.sh's rsync always excludes, mirrored from
// build-universal-bundles.ts installScript(): the two instruction files (installed
// no-overwrite by instructionBlock), the three provider-settings files, and -- per
// runtime -- the merge-owned config file install-merge.js merges rather than copies.
// Mirrored here (not imported) because installScript() builds a bash script, not a
// reusable list; this set must stay in lockstep with that generator.
const BUNDLE_INSTALL_COMMON_EXCLUDE_REL: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  "context/settings/backlog-provider-settings.json",
  "context/settings/assignment-provider-settings.json",
  "context/settings/change-provider-settings.json",
];

const BUNDLE_MERGE_CONFIG_REL: Readonly<Record<string, string>> = {
  "claude-code": ".claude/settings.json",
  codex: ".codex/hooks.json",
  opencode: "opencode.json",
};

/** The set of bundle-relative paths install.sh's rsync never unconditionally copies for `runtime`. */
export function bundleInstallExcludeRel(runtime: string): Set<string> {
  const set = new Set(BUNDLE_INSTALL_COMMON_EXCLUDE_REL);
  const mergeConfig = BUNDLE_MERGE_CONFIG_REL[runtime];
  if (mergeConfig) set.add(mergeConfig);
  return set;
}

/**
 * MEDIUM-1 (#1288 review): the stale-installer check must be semantic, not a substring grep.
 * An installer that PARSES `--exclude-path` but whose rsync invocation dropped the
 * `${EXCLUDE_ARGS[@]+...}` expansion would accept the flags and still overwrite everything.
 * True only when the installer carries the guard contract's observable properties:
 *   - the rsync line itself expands the exclude args;
 *   - the rsync line no longer uses `--delete` (BLOCKING-1: deletion is manifest-driven in
 *     the caller now, never a blanket sync);
 *   - the raw `EXCLUDE_RELS` list exists (HIGH-1/HIGH-2: token substitution and the
 *     console-config write are scoped by it).
 */
export function installerSupportsPreserveExcludes(installShText: string): boolean {
  const rsyncLine = installShText.split("\n").find((line) => line.trimStart().startsWith("rsync "));
  if (!rsyncLine) return false;
  if (!rsyncLine.includes('${EXCLUDE_ARGS[@]+')) return false;
  if (rsyncLine.includes("--delete")) return false;
  return installShText.includes("EXCLUDE_RELS=()");
}

export type ComputeInstallPlanParams = {
  mappings: InstallPlanMapping[];
  /** Where `.flow-agents/owned-files.json` lives (the install destination root). */
  manifestDest: string;
  /** Matched against the prefixed relative path; these paths never enter the plan. */
  excludeRel: Set<string>;
  force: boolean;
  /** Enable manifest-driven stale-owned removals (project rsync installs). */
  removals: boolean;
  /** Refuse symlinked intermediate destination directories (project rsync installs). */
  refuseSymlinkParents: boolean;
};

function lstatIfPresent(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch {
    return undefined;
  }
}

export function computeInstallPlan(params: ComputeInstallPlanParams): InstallPlan {
  const manifest = readOwnedFilesManifest(params.manifestDest);
  const ownedHashes = new Map<string, string>();
  for (const entry of manifest?.files ?? []) {
    if (typeof entry?.path === "string" && typeof entry?.sha256 === "string") {
      ownedHashes.set(entry.path, entry.sha256.toLowerCase());
    }
  }
  const plan: InstallPlan = {
    entries: [], created: [], unchanged: [], replaced: [], preserved: [], forced: [],
    removals: [], preservedFormerlyOwned: [], removalsEnabled: params.removals,
  };
  const record = (entry: InstallPlanEntry): void => {
    plan.entries.push(entry);
    if (entry.action === "create") plan.created.push(entry.rel);
    else if (entry.action === "unchanged") plan.unchanged.push(entry.rel);
    else if (entry.action === "replace") plan.replaced.push(entry.rel);
    else if (entry.action === "preserve") plan.preserved.push(entry.rel);
    else plan.forced.push(entry.rel);
  };
  const incoming = new Set<string>();
  const symlinkParents = new Set<string>();
  // Cache of already-inspected destination directory components (absolute path -> isSymlink).
  const parentChecked = new Map<string, boolean>();
  for (const mapping of params.mappings) {
    if (!fs.existsSync(mapping.sourceDir)) continue;
    const { files } = listOwnedTree(mapping.sourceDir);
    for (const rel of files) {
      const combined = mapping.prefix ? `${mapping.prefix}/${rel}` : rel;
      if (params.excludeRel.has(combined)) continue;
      incoming.add(combined);
      const parts = rel.split("/");
      const target = path.join(mapping.destDir, ...parts);
      if (params.refuseSymlinkParents) {
        // HIGH-4 (#1288 review): a child path classified through a symlinked intermediate
        // directory is a lie -- the rsync replaces the (unclassified) symlink itself. Check
        // every destination component above the file, once each.
        let current = mapping.destDir;
        for (const part of parts.slice(0, -1)) {
          current = path.join(current, part);
          let isLink = parentChecked.get(current);
          if (isLink === undefined) {
            isLink = lstatIfPresent(current)?.isSymbolicLink() ?? false;
            parentChecked.set(current, isLink);
          }
          if (isLink) symlinkParents.add(path.relative(mapping.destDir, current) || current);
        }
      }
      const sourcePath = path.join(mapping.sourceDir, ...parts);
      const stat = lstatIfPresent(target);
      if (!stat) {
        record({ rel: combined, action: "create", sourcePath, destPath: target });
        continue;
      }
      if (!stat.isFile()) {
        // A symlink or directory at a colliding path is never known bundle-owned content;
        // keep it even under --force (replace semantics for it are undefined enough that
        // "preserve and report" is the only honest classification).
        record({ rel: combined, action: "preserve", sourcePath, destPath: target });
        continue;
      }
      const currentHash = hashFile(target);
      const incomingHash = hashFile(sourcePath);
      if (currentHash === incomingHash) record({ rel: combined, action: "unchanged", sourcePath, destPath: target });
      else if (ownedHashes.get(combined) === currentHash) record({ rel: combined, action: "replace", sourcePath, destPath: target });
      else if (params.force) record({ rel: combined, action: "force-overwrite", sourcePath, destPath: target });
      else record({ rel: combined, action: "preserve", sourcePath, destPath: target });
    }
  }
  if (symlinkParents.size > 0) throw new InstallPlanSymlinkParentError([...symlinkParents].sort());
  if (params.removals) {
    // BLOCKING-1 (#1288 review): replace kiro's blanket `rsync --delete` with manifest-driven
    // removal, reusing the uninstall contract: only a previously-owned path, absent from the
    // incoming bundle, whose bytes still match the recorded hash may be deleted. Entries go
    // through the same lexical + filesystem containment checks the uninstaller mandates for
    // any manifest-driven deletion (the manifest is not a trusted input).
    const prefixes = params.mappings.map((mapping) => mapping.prefix);
    for (const [rel, sha256] of ownedHashes) {
      if (incoming.has(rel) || params.excludeRel.has(rel)) continue;
      if (!prefixes.some((prefix) => prefix === "" || rel === prefix || rel.startsWith(`${prefix}/`))) continue;
      const destPath = resolveManifestEntryPath(params.manifestDest, rel);
      assertManifestEntryParentContained(params.manifestDest, destPath, rel);
      const stat = lstatIfPresent(destPath);
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) {
        plan.preservedFormerlyOwned.push(rel);
        continue;
      }
      if (hashFile(destPath) === sha256) plan.removals.push({ rel, destPath, sha256 });
      else plan.preservedFormerlyOwned.push(rel);
    }
    plan.removals.sort((a, b) => a.rel.localeCompare(b.rel));
    plan.preservedFormerlyOwned.sort();
  }
  return plan;
}

/**
 * HIGH-3 (#1288 review): re-derive the plan immediately before the install executes and
 * refuse -- naming the drifted paths -- if any classification changed. This shrinks the
 * classify->write race window to the moment before the installer is spawned; it cannot
 * eliminate it (nothing short of an FS transaction can), which is disclosed in the error.
 */
export function verifyInstallPlanMatchesDisk(plan: InstallPlan, params: ComputeInstallPlanParams): void {
  const fresh = computeInstallPlan(params);
  const drifted = new Set<string>();
  const byRel = (entries: InstallPlanEntry[]): Map<string, InstallPlanAction> =>
    new Map(entries.map((entry) => [entry.rel, entry.action]));
  const before = byRel(plan.entries);
  const after = byRel(fresh.entries);
  for (const [rel, action] of before) if (after.get(rel) !== action) drifted.add(rel);
  for (const rel of after.keys()) if (!before.has(rel)) drifted.add(rel);
  const removalKey = (removal: InstallPlanRemoval): string => `${removal.rel} ${removal.sha256}`;
  const beforeRemovals = new Set(plan.removals.map(removalKey));
  const afterRemovals = new Set(fresh.removals.map(removalKey));
  for (const key of beforeRemovals) if (!afterRemovals.has(key)) drifted.add(key.split(" ")[0]);
  for (const key of afterRemovals) if (!beforeRemovals.has(key)) drifted.add(key.split(" ")[0]);
  if (drifted.size > 0) throw new InstallPlanDriftError([...drifted].sort());
}

export type ExecutedRemovals = { removed: string[]; preservedAtRemoval: string[] };

/**
 * Execute the plan's removals with the uninstaller's TOCTOU posture: re-assert containment
 * and re-hash immediately before each deletion; anything that changed in the window is
 * preserved and reported, never deleted. Empty parent directories are pruned up to `dest`.
 */
export function executePlanRemovals(plan: InstallPlan, dest: string): ExecutedRemovals {
  const result: ExecutedRemovals = { removed: [], preservedAtRemoval: [] };
  const staleParents = new Set<string>();
  for (const removal of plan.removals) {
    assertManifestEntryParentContained(dest, removal.destPath, removal.rel);
    const stat = lstatIfPresent(removal.destPath);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || hashFile(removal.destPath) !== removal.sha256) {
      result.preservedAtRemoval.push(removal.rel);
      continue;
    }
    fs.rmSync(removal.destPath);
    result.removed.push(removal.rel);
    staleParents.add(path.dirname(removal.destPath));
  }
  const destResolved = path.resolve(dest);
  for (const start of [...staleParents].sort((a, b) => b.length - a.length)) {
    let current = start;
    while (current !== destResolved && current.startsWith(`${destResolved}${path.sep}`)) {
      try {
        fs.rmdirSync(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }
  return result;
}

/** Apply the plan's create/replace/force-overwrite copies directly (the --global claude-code sync path). */
export function executePlanCopies(plan: InstallPlan): number {
  let copied = 0;
  for (const entry of plan.entries) {
    if (entry.action !== "create" && entry.action !== "replace" && entry.action !== "force-overwrite") continue;
    fs.mkdirSync(path.dirname(entry.destPath), { recursive: true });
    fs.copyFileSync(entry.sourcePath, entry.destPath);
    fs.chmodSync(entry.destPath, fs.statSync(entry.sourcePath).mode & 0o777);
    copied += 1;
  }
  return copied;
}

export function formatDryRunLines(plan: InstallPlan, runtime: string, dest: string): string[] {
  const lines: string[] = [
    "Dry run: no files were written.",
    `Planned install of the ${runtime} bundle into ${dest}:`,
  ];
  for (const entry of plan.entries) {
    if (entry.action === "create") lines.push(`  create: ${entry.rel}`);
    else if (entry.action === "replace") lines.push(`  replace (bundle-owned, stale): ${entry.rel}`);
    else if (entry.action === "preserve") lines.push(`  preserve (existing content kept): ${entry.rel}`);
    else if (entry.action === "force-overwrite") lines.push(`  overwrite (--force): ${entry.rel}`);
  }
  for (const removal of plan.removals) lines.push(`  remove (bundle-owned, stale): ${removal.rel}`);
  for (const rel of plan.preservedFormerlyOwned) lines.push(`  preserve (formerly bundle-owned, since modified): ${rel}`);
  lines.push(...formatInstallSummaryLines(plan, dest));
  lines.push("Re-run without --dry-run to apply. Preserved paths are only overwritten with --force.");
  return lines;
}

export function formatInstallSummaryLines(
  plan: InstallPlan,
  dest: string,
  executedRemovals?: ExecutedRemovals,
): string[] {
  const removed = executedRemovals ? executedRemovals.removed : plan.removals.map((removal) => removal.rel);
  const preservedAtRemoval = executedRemovals?.preservedAtRemoval ?? [];
  const parts = [
    `${plan.created.length} created`,
    `${plan.replaced.length} replaced (bundle-owned, stale)`,
    `${plan.unchanged.length} unchanged`,
    `${plan.preserved.length + plan.preservedFormerlyOwned.length + preservedAtRemoval.length} preserved`,
  ];
  if (plan.removalsEnabled) parts.push(`${removed.length} removed (bundle-owned, stale)`);
  if (plan.forced.length > 0) parts.push(`${plan.forced.length} overwritten (--force)`);
  const lines = [`Install summary for ${dest}: ${parts.join(", ")}`];
  for (const rel of plan.preserved) {
    lines.push(`  preserved: ${rel} (existing content is not bundle-owned; kept)`);
  }
  for (const rel of plan.preservedFormerlyOwned) {
    lines.push(`  preserved: ${rel} (formerly bundle-owned, since modified; kept)`);
  }
  for (const rel of preservedAtRemoval) {
    lines.push(`  preserved: ${rel} (changed while installing; kept)`);
  }
  for (const rel of removed) {
    lines.push(`  removed (bundle-owned, stale): ${rel}`);
  }
  for (const rel of plan.forced) {
    lines.push(`  overwrote (--force): ${rel}`);
  }
  if (plan.preserved.length > 0) {
    lines.push("Preserved files were NOT overwritten. Preview with --dry-run; pass --force to overwrite them with bundle content.");
  }
  return lines;
}
