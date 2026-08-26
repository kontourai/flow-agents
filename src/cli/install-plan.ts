// Overwrite guard for `flow-agents init`'s bundle install paths (kontourai/flow-agents#1288).
//
// The project bundle installers (`dist/<runtime>/install.sh`) rsync the bundle tree into the
// destination, and the --global claude-code path copies skills/agents into the user's config
// root. Before this guard, any existing destination file whose path collided with a bundle
// path -- including a user-authored README.md or ~/.claude/agents file -- was silently
// overwritten, and kiro's `--delete` sync could remove destination files the install never
// classified at all. This module computes, BEFORE any write, what the install would do to
// every bundle-shipped path, and classifies each one:
//
//   - create:    no destination entry exists; the install writes a new file.
//   - unchanged: the destination file is byte-identical to the incoming bundle file. It is
//                not rewritten (the guarded installer only writes absent paths).
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
// Separately, the plan REPORTS stale bundle-owned leftovers: paths the ownership manifest
// records as installed by a previous run, absent from the incoming bundle, whose on-disk
// content still hash-matches the manifest. The install never deletes them (a writable
// manifest is not deletion authority -- a poisoned or stale entry must not be able to remove
// an arbitrary path); the summary names them and points at `flow-agents init --uninstall`
// or manual removal. Kiro's old blanket `rsync --delete` is gone entirely.
//
// Preserved paths are passed to install.sh as `--exclude-path` rsync excludes, and init
// passes `--only-absent` so the rsync runs with --ignore-existing: the copy layer can only
// ever write paths that did not exist, while replace/force-overwrite writes go through
// executePlanCopies' temp-write -> re-hash -> rename sequence. This deliberately REUSES the
// uninstall path's ownership machinery (owned-files-manifest.ts: listOwnedTree/hashFile/
// readOwnedFilesManifest) rather than inventing a second hashing convention.
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { hashFile, listOwnedTree, readOwnedFilesManifest } from "../lib/owned-files-manifest.js";

export type InstallPlanAction = "create" | "unchanged" | "replace" | "preserve" | "force-overwrite";

export type InstallPlanEntry = {
  rel: string;
  action: InstallPlanAction;
  sourcePath: string;
  destPath: string;
  /** Plan-time sha256 of the existing destination file (absent for "create"). */
  destSha256?: string;
};

export type InstallPlanMapping = { sourceDir: string; destDir: string; prefix: string };

export type InstallPlan = {
  entries: InstallPlanEntry[];
  created: string[];
  unchanged: string[];
  replaced: string[];
  preserved: string[];
  forced: string[];
  /**
   * Manifest-owned, absent from the incoming bundle, still hash-matching the recorded
   * install: REPORTED, never deleted (see module doc).
   */
  staleOwned: string[];
  staleOwnedReported: boolean;
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

/** Thrown when the destination diverged from the plan's decisions before/while applying them. */
export class InstallPlanDriftError extends Error {
  constructor(public readonly driftedPaths: string[]) {
    super(
      `destination changed between planning and install for: ${driftedPaths.slice(0, 20).join(", ")}` +
      `${driftedPaths.length > 20 ? ` (+${driftedPaths.length - 20} more)` : ""} -- re-run flow-agents init`
    );
  }
}

// Relative paths install.sh's rsync always excludes, mirrored from
// build-universal-bundles.ts installScript(): the two instruction files (installed
// no-overwrite by instructionBlock), the three provider-settings files, and -- per
// runtime -- the merge-owned config file install-merge.js merges rather than copies.
// Mirrored here (not imported) because installScript() builds a bash script, not a
// reusable list; this set must stay in lockstep with that generator.
//
// NOTE: an rsync exclude is NOT the same thing as "outside the install". The runtime's own
// instruction file is removed from this set again by bundleInstallExcludeRel() so it is
// planned and owned -- see BUNDLE_INSTRUCTION_REL below (#1343).
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

/**
 * The ONE instruction file each runtime's bundle actually ships, mirrored from
 * build-universal-bundles.ts's BUNDLE_CAPABILITIES.instructionPath. (Codex ships none.)
 *
 * kontourai/flow-agents#1343: this file used to be excluded from the plan outright, which
 * meant install created it (install.sh's no-overwrite instructionBlock) while the ownership
 * manifest disclaimed it and `--uninstall` could not see it -- so a durable instruction file
 * a coding agent reads every session survived the removal path a user runs specifically to
 * undo the install, under a summary reading `Preserved -- modified or unknown (0)`.
 *
 * #1238 established that REMOVAL requires positive provenance. The other half of that
 * contract is that CREATION requires manifest registration: anything the installer writes
 * must be owned, or the manifest stops being a truthful account of the install. Keeping the
 * runtime's own instruction file IN the plan gives it the normal ownership semantics for
 * free -- created when absent, preserved and reported when the destination's copy is the
 * user's, updated only when it hash-matches a previous install's manifest entry -- with no
 * change to install.sh, whose rsync still excludes it and whose instructionBlock still
 * refuses to overwrite anything that already exists.
 *
 * The OTHER runtime's instruction filename stays excluded: the rsync excludes both
 * unconditionally, and no bundle ships both, so planning a path the bundle does not contain
 * would be meaningless.
 */
const BUNDLE_INSTRUCTION_REL: Readonly<Record<string, string>> = {
  base: "AGENTS.md",
  kiro: "AGENTS.md",
  "claude-code": "CLAUDE.md",
  opencode: "AGENTS.md",
  pi: "AGENTS.md",
};

/** The set of bundle-relative paths install.sh's rsync never unconditionally copies for `runtime`. */
export function bundleInstallExcludeRel(runtime: string): Set<string> {
  const set = new Set(BUNDLE_INSTALL_COMMON_EXCLUDE_REL);
  const mergeConfig = BUNDLE_MERGE_CONFIG_REL[runtime];
  if (mergeConfig) set.add(mergeConfig);
  const instruction = BUNDLE_INSTRUCTION_REL[runtime];
  if (instruction) set.delete(instruction);
  return set;
}

/**
 * MEDIUM-1 (#1288 review): the stale-installer check must be semantic, not a substring grep.
 * An installer that PARSES `--exclude-path` but whose rsync invocation dropped the
 * `${EXCLUDE_ARGS[@]+...}` expansion would accept the flags and still overwrite everything.
 * True only when the installer carries the guard contract's observable properties:
 *   - the rsync line itself expands the exclude args AND the `--only-absent` ignore-existing
 *     args (the never-overwrite copy layer);
 *   - the rsync line no longer hardcodes `--delete` (stale-owned handling is report-only in
 *     the caller now, never a blanket sync);
 *   - the raw `EXCLUDE_RELS` list exists (token substitution and the console-config write
 *     are scoped by it).
 */
export function installerSupportsPreserveExcludes(installShText: string): boolean {
  const rsyncLine = installShText.split("\n").find((line) => line.trimStart().startsWith("rsync "));
  if (!rsyncLine) return false;
  if (!rsyncLine.includes('${EXCLUDE_ARGS[@]+')) return false;
  if (!rsyncLine.includes('${IGNORE_EXISTING_ARGS[@]+')) return false;
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
  /** Report (never delete) manifest-owned paths the incoming bundle no longer ships. */
  reportStaleOwned: boolean;
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

/** A clean bundle-relative manifest path safe to JOIN under the destination, or null. */
function safeManifestRelParts(rel: string): string[] | null {
  if (typeof rel !== "string" || rel.length === 0 || rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) return null;
  const parts = rel.split("/");
  // Backslashes are path separators on Windows: a POSIX-clean segment like "..\\x" must
  // not be admitted anywhere.
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))) return null;
  return parts;
}

export function computeInstallPlan(params: ComputeInstallPlanParams): InstallPlan {
  const manifest = readOwnedFilesManifest(params.manifestDest);
  // #1288 round-4 FIX-3: the manifest grants OVERWRITE authority ("replace" without
  // --force), so admission applies the same containment/shape filter as stale reporting:
  // an entry only enters ownedHashes if it is a clean bundle-relative path (no absolute
  // paths, no traversal segments) that resolves inside the destination. A valid-shaped
  // but poisoned entry styled to point at anything else never becomes authority; it is
  // skipped, not fatal. (An entry with an exact clean path and the correct hash of a
  // colliding user file remains the manifest's designed authority -- that is the
  // same-user adversarial class dispositioned in the accepted-gap note.)
  const manifestDestResolved = path.resolve(params.manifestDest);
  const ownedHashes = new Map<string, string>();
  for (const entry of manifest?.files ?? []) {
    if (typeof entry?.path !== "string" || typeof entry?.sha256 !== "string") continue;
    const parts = safeManifestRelParts(entry.path);
    if (!parts) continue;
    const resolved = path.resolve(manifestDestResolved, ...parts);
    const relative = path.relative(manifestDestResolved, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    ownedHashes.set(entry.path, entry.sha256.toLowerCase());
  }
  const plan: InstallPlan = {
    entries: [], created: [], unchanged: [], replaced: [], preserved: [], forced: [],
    staleOwned: [], staleOwnedReported: params.reportStaleOwned,
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
      if (currentHash === incomingHash) record({ rel: combined, action: "unchanged", sourcePath, destPath: target, destSha256: currentHash });
      else if (ownedHashes.get(combined) === currentHash) record({ rel: combined, action: "replace", sourcePath, destPath: target, destSha256: currentHash });
      else if (params.force) record({ rel: combined, action: "force-overwrite", sourcePath, destPath: target, destSha256: currentHash });
      else record({ rel: combined, action: "preserve", sourcePath, destPath: target, destSha256: currentHash });
    }
  }
  if (symlinkParents.size > 0) throw new InstallPlanSymlinkParentError([...symlinkParents].sort());
  if (params.reportStaleOwned) {
    // Report-only (#1288 round-3 BLOCKING-1): the ownership manifest is a writable input,
    // so it must never be deletion authority. A previously-owned path the bundle no longer
    // ships, whose bytes still match the recorded hash, is NAMED in the summary with a
    // removal suggestion; nothing is deleted. Malformed entries are skipped -- a poisoned
    // manifest must not brick or steer the install.
    const prefixes = params.mappings.map((mapping) => mapping.prefix);
    for (const [rel, sha256] of ownedHashes) {
      if (incoming.has(rel) || params.excludeRel.has(rel)) continue;
      if (!prefixes.some((prefix) => prefix === "" || rel === prefix || rel.startsWith(`${prefix}/`))) continue;
      const parts = safeManifestRelParts(rel);
      if (!parts) continue;
      const destPath = path.join(params.manifestDest, ...parts);
      const stat = lstatIfPresent(destPath);
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) continue;
      if (hashFile(destPath) === sha256) plan.staleOwned.push(rel);
    }
    plan.staleOwned.sort();
  }
  return plan;
}

/**
 * HIGH-3 (#1288 review): re-derive the plan immediately before the install executes and
 * refuse -- naming the drifted paths -- if any classification changed. Write-time enforcement
 * then closes what this cannot see: creates open exclusively (executePlanCopies /
 * install.sh's --ignore-existing rsync) and replaces re-hash the destination immediately
 * before renaming over it.
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
  if (drifted.size > 0) throw new InstallPlanDriftError([...drifted].sort());
}

export type ExecutedCopies = {
  copied: number;
  /** Planned creates that lost the exclusive-create race: left as found, reported. */
  racedPaths: string[];
};

/**
 * Apply the plan's copies directly, with write-time race enforcement:
 *   - "create" opens the destination with O_EXCL ('wx'): if a file appeared since planning,
 *     the open FAILS and that failure IS the guard -- the path is left as found and
 *     reported (racedPaths), never overwritten.
 *   - "replace"/"force-overwrite" write a temp sibling, re-hash the destination immediately
 *     before renaming over it, and throw InstallPlanDriftError if the bytes are no longer
 *     the ones the plan decided to replace.
 * `actions` limits which classifications this executor applies (the project path routes
 * only replace/force-overwrite here; creates go through install.sh's --ignore-existing
 * rsync, which carries the same only-write-absent-paths guarantee).
 */
export function executePlanCopies(
  plan: InstallPlan,
  actions: ReadonlySet<InstallPlanAction> = new Set(["create", "replace", "force-overwrite"]),
): ExecutedCopies {
  const result: ExecutedCopies = { copied: 0, racedPaths: [] };
  for (const entry of plan.entries) {
    if (!actions.has(entry.action)) continue;
    if (entry.action === "create") {
      fs.mkdirSync(path.dirname(entry.destPath), { recursive: true });
      try {
        fs.writeFileSync(entry.destPath, fs.readFileSync(entry.sourcePath), { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        result.racedPaths.push(entry.rel);
        continue;
      }
      fs.chmodSync(entry.destPath, fs.statSync(entry.sourcePath).mode & 0o777);
      result.copied += 1;
      continue;
    }
    if (entry.action === "replace" || entry.action === "force-overwrite") {
      const temp = path.join(
        path.dirname(entry.destPath),
        `.${path.basename(entry.destPath)}.flow-agents-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
      );
      try {
        fs.writeFileSync(temp, fs.readFileSync(entry.sourcePath), { flag: "wx" });
        fs.chmodSync(temp, fs.statSync(entry.sourcePath).mode & 0o777);
        // Re-hash the destination immediately before the rename: the plan decided to
        // replace THESE bytes; anything else appearing here is not ours to destroy.
        const current = lstatIfPresent(entry.destPath);
        if (!current || !current.isFile() || current.isSymbolicLink() || hashFile(entry.destPath) !== entry.destSha256) {
          throw new InstallPlanDriftError([entry.rel]);
        }
        fs.renameSync(temp, entry.destPath);
        result.copied += 1;
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
  }
  return result;
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
  for (const rel of plan.staleOwned) lines.push(`  stale bundle-owned (not removed): ${rel}`);
  lines.push(...formatInstallSummaryLines(plan, dest));
  lines.push("Re-run without --dry-run to apply. Preserved paths are only overwritten with --force.");
  return lines;
}

export function formatInstallSummaryLines(plan: InstallPlan, dest: string, racedPaths: string[] = []): string[] {
  // A raced path was planned as "create" but lost the exclusive-create race; count it as
  // preserved, not created.
  const racedSet = new Set(racedPaths);
  const parts = [
    `${plan.created.filter((rel) => !racedSet.has(rel)).length} created`,
    `${plan.replaced.length} replaced (bundle-owned, stale)`,
    `${plan.unchanged.length} unchanged`,
    `${plan.preserved.length + racedPaths.length} preserved`,
  ];
  if (plan.forced.length > 0) parts.push(`${plan.forced.length} overwritten (--force)`);
  if (plan.staleOwnedReported && plan.staleOwned.length > 0) {
    parts.push(`${plan.staleOwned.length} stale bundle-owned (not removed)`);
  }
  const lines = [`Install summary for ${dest}: ${parts.join(", ")}`];
  for (const rel of plan.preserved) {
    lines.push(`  preserved: ${rel} (existing content is not bundle-owned; kept)`);
  }
  for (const rel of racedPaths) {
    lines.push(`  preserved: ${rel} (appeared while installing; left as found)`);
  }
  for (const rel of plan.forced) {
    lines.push(`  overwrote (--force): ${rel}`);
  }
  for (const rel of plan.staleOwned) {
    lines.push(`  stale bundle-owned (from a previous install; NOT removed): ${rel}`);
  }
  if (plan.staleOwnedReported && plan.staleOwned.length > 0) {
    lines.push(`${plan.staleOwned.length} stale bundle-owned file(s) remain from a previous install; remove them with \`flow-agents init --uninstall\` or manually.`);
  }
  if (plan.preserved.length > 0) {
    lines.push("Preserved files were NOT overwritten. Preview with --dry-run; pass --force to overwrite them with bundle content.");
  }
  return lines;
}
