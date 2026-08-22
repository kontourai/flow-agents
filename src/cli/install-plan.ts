// Overwrite guard for `flow-agents init`'s project-scoped bundle install (kontourai/flow-agents#1288).
//
// The bundle installers (`dist/<runtime>/install.sh`) rsync the bundle tree into the
// destination. Before this guard, any existing destination file whose path collided with a
// bundle path -- including a user-authored README.md -- was silently overwritten. This module
// computes, BEFORE install.sh runs, what the rsync would do to every bundle-shipped path, and
// classifies each one:
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
//
// Preserved paths are then passed to install.sh as `--exclude-path` rsync excludes, so the
// copy itself never touches them. This deliberately REUSES the uninstall path's ownership
// machinery (owned-files-manifest.ts: listOwnedTree/hashFile/readOwnedFilesManifest) rather
// than inventing a second hashing convention -- "user-modified => keep + report" is the same
// rule uninstall already honours in the opposite direction.
import * as fs from "node:fs";
import * as path from "node:path";
import { hashFile, listOwnedTree, readOwnedFilesManifest } from "../lib/owned-files-manifest.js";

export type InstallPlanAction = "create" | "unchanged" | "replace" | "preserve" | "force-overwrite";

export type InstallPlanEntry = { rel: string; action: InstallPlanAction };

export type InstallPlan = {
  entries: InstallPlanEntry[];
  created: string[];
  unchanged: string[];
  replaced: string[];
  preserved: string[];
  forced: string[];
};

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

export function computeInstallPlan(params: {
  bundleDir: string;
  dest: string;
  excludeRel: Set<string>;
  force: boolean;
}): InstallPlan {
  const manifest = readOwnedFilesManifest(params.dest);
  const ownedHashes = new Map<string, string>();
  for (const entry of manifest?.files ?? []) {
    if (typeof entry?.path === "string" && typeof entry?.sha256 === "string") {
      ownedHashes.set(entry.path, entry.sha256.toLowerCase());
    }
  }
  const { files } = listOwnedTree(params.bundleDir);
  const plan: InstallPlan = { entries: [], created: [], unchanged: [], replaced: [], preserved: [], forced: [] };
  const record = (rel: string, action: InstallPlanAction): void => {
    plan.entries.push({ rel, action });
    if (action === "create") plan.created.push(rel);
    else if (action === "unchanged") plan.unchanged.push(rel);
    else if (action === "replace") plan.replaced.push(rel);
    else if (action === "preserve") plan.preserved.push(rel);
    else plan.forced.push(rel);
  };
  for (const rel of files) {
    if (params.excludeRel.has(rel)) continue;
    const target = path.join(params.dest, ...rel.split("/"));
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(target);
    } catch {
      stat = undefined;
    }
    if (!stat) {
      record(rel, "create");
      continue;
    }
    if (!stat.isFile()) {
      // A symlink or directory at a colliding path is never known bundle-owned content;
      // keep it even under --force (rsync semantics for replacing it are undefined enough
      // that "preserve and report" is the only honest classification).
      record(rel, "preserve");
      continue;
    }
    const currentHash = hashFile(target);
    const incomingHash = hashFile(path.join(params.bundleDir, ...rel.split("/")));
    if (currentHash === incomingHash) record(rel, "unchanged");
    else if (ownedHashes.get(rel) === currentHash) record(rel, "replace");
    else if (params.force) record(rel, "force-overwrite");
    else record(rel, "preserve");
  }
  return plan;
}

/**
 * Escape a bundle-relative path for use as an rsync exclude pattern value
 * (install.sh anchors it with a leading `/`). rsync treats `*`, `?`, `[` and `]`
 * as wildcards; a literal backslash must itself be escaped first.
 */
export function rsyncExcludeLiteral(rel: string): string {
  return rel.replace(/([\\*?[\]])/g, "\\$1");
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
  lines.push(...formatInstallSummaryLines(plan, dest));
  lines.push("Re-run without --dry-run to apply. Preserved paths are only overwritten with --force.");
  return lines;
}

export function formatInstallSummaryLines(plan: InstallPlan, dest: string): string[] {
  const parts = [
    `${plan.created.length} created`,
    `${plan.replaced.length} replaced (bundle-owned, stale)`,
    `${plan.unchanged.length} unchanged`,
    `${plan.preserved.length} preserved`,
  ];
  if (plan.forced.length > 0) parts.push(`${plan.forced.length} overwritten (--force)`);
  const lines = [`Install summary for ${dest}: ${parts.join(", ")}`];
  for (const rel of plan.preserved) {
    lines.push(`  preserved: ${rel} (existing content is not bundle-owned; kept)`);
  }
  for (const rel of plan.forced) {
    lines.push(`  overwrote (--force): ${rel}`);
  }
  if (plan.preserved.length > 0) {
    lines.push("Preserved files were NOT overwritten. Preview with --dry-run; pass --force to overwrite them with bundle content.");
  }
  return lines;
}
