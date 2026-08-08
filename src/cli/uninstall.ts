// flow-agents init --uninstall — remove a prior claude-code install.
//
// Two removal modes, chosen purely by whether an ownership manifest exists (never mixed):
//   - manifest-backed: `.flow-agents/owned-files.json` (written by a manifest-era install,
//     see owned-files-manifest.ts) lists every file the install wrote with a sha256. A file is
//     removed only when its current content still matches; anything modified is preserved and
//     reported. Every manifest entry is validated (path containment, sha256 shape) before use --
//     a manifest is not a trusted input (see resolveManifestEntryPath in owned-files-manifest.ts)
//     -- and the whole run aborts, before any deletion, on the first unsafe/malformed entry.
//   - legacy inference: no manifest. The candidate set is derived by hashing the *executing*
//     package's own dist/claude-code bundle content against the target and removing only exact
//     matches (skills/, agents/, and the known pre-manifest full-bundle-rsync payload names).
//     Anything present-but-differing is preserved and reported as user-modified/unknown; anything
//     present at dest that the current bundle doesn't ship at all (renamed/removed upstream, or
//     genuinely user-added) is reported as unrecognized residue rather than left invisible.
//
// Independent of both modes: `settings.json`'s managed hook ENTRIES (not whole groups -- a group
// mixing an FA-owned hook with a user's own hook keeps the user's entry) and the managed
// statusLine are always stripped by marker (never file-deleted -- settings.json is a merged
// file, not an owned one), and a fixed set of durable `.flow-agents/*` stamp files are removed
// when they belong to claude-code.
//
// Safety discipline: `buildPlan()` is pure/read-only (no filesystem mutation). `applyPlan()` is
// the only mutating step, is only reached after an explicit confirmation, re-verifies every
// file's content hash immediately before removing it (closing the plan/confirm/apply TOCTOU
// window -- a file that changed since planning is preserved, not deleted), and never lets an
// exception escape mid-loop: every removal is individually try/caught so one failure never hides
// the accounting of everything else that happened, and the final report always distinguishes
// removed / preserved / failed / residue rather than claiming success for anything it didn't
// verify.
//
// Known accepted gaps (LOW severity, disclosed, not fixed here):
//   - A manifest's own `runtime`/`global` fields are not cross-checked against the invocation's
//     target (`--global`/`--dest`); low-risk today because each runtime's durable root lives at
//     a runtime-specific dest, so a cross-runtime manifest collision at the same path is not
//     reachable by the current single-runtime feature.
//   - Legacy-mode skill matching compares `path.basename(realDir) !== name`; a skill renamed only
//     by case on a case-insensitive-but-case-preserving filesystem (default macOS/APFS) fails
//     that check and is preserved rather than removed -- safe (never deletes), just imprecise.
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseArgs, flagBool, flagString } from "../lib/args.js";
import { root } from "../tools/common.js";
import { durableFlowAgentsRoot } from "../lib/local-artifact-root.js";
import {
  hashFile,
  listOwnedTree,
  readOwnedFilesManifest,
  resolveManifestEntryPath,
  resolveManifestEntrySha256,
  type OwnedFilesManifest,
} from "../lib/owned-files-manifest.js";
import { ensureBundle, globalDest } from "./init.js";

type InstallMergeModule = { isManagedHookGroup: (hookGroup: unknown) => boolean; FA_MARKERS: string[] };

function loadInstallMergeModule(): InstallMergeModule {
  const installMergePath = path.join(root, "scripts", "install-merge.js");
  const _require = createRequire(import.meta.url);
  return _require(installMergePath) as InstallMergeModule;
}

// The generated statusLine's command is the one value in settings.json that both is FA-owned
// and lives outside `hooks` (see build-universal-bundles.ts's exportClaudeSettings /
// installScript). Matched by this filename substring rather than an exact-value compare so a
// stale statusLine command from an older package version is still recognized and removed.
const STATUSLINE_MARKER = "flow-agents-statusline.js";

function usage(): void {
  console.error(`usage: flow-agents init --uninstall --runtime claude-code [--global | --dest PATH] [options]

Removes a prior Flow Agents claude-code install: managed settings.json hook entries/statusLine,
installed skill/agent files (manifest-backed when an ownership manifest is present, otherwise
inferred against the currently-installed package's own bundle content), and the durable
.flow-agents/* stamp files. Never removes: per-repo .kontourai/ state, the /etc/kontourai
lifecycle authority, telemetry data files, or the npm package itself (a final
'npm rm -g @kontourai/flow-agents' instruction is printed).

Options:
  --runtime claude-code   Required; only claude-code is currently supported.
  --global                Target the runtime's global install (~/.claude, honors
                          FLOW_AGENTS_USER_CLAUDE_SETTINGS for test isolation).
  --dest PATH             Target an explicit project-scoped destination.
                          A bare positional argument is accepted as an alias for --dest.
  --dry-run               Print the removal plan without deleting or modifying anything.
  --yes, --headless       Confirm the destructive removal non-interactively. Without one of
                          these, a non-interactive invocation (no TTY, e.g. CI or a pipe) is
                          refused rather than silently proceeding or silently doing nothing.

Exit codes: 0 ok, 1 confirmation declined/not given, 2 usage or validation error (including an
unsafe or malformed owned-files.json entry -- the run aborts before any deletion), 3 nothing
found to uninstall, 4 one or more removals failed (see the report's "Failed to remove" section).
`);
}

// ─── Discovery types ────────────────────────────────────────────────────────────────────────

type RemovableFile = { relPath: string; absPath: string; reason: string; expectedSha256: string };
type PreservedFile = { relPath: string; absPath: string; reason: string };
type RemovableSymlink = { relPath: string; symlinkPath: string; targetDir: string; reason: string; bundleSkillDir: string };
type RemovalFailure = { relPath: string; absPath: string; reason: string };
type ResidueEntry = { path: string; note: string };

type SettingsPlan = {
  settingsPath: string;
  exists: boolean;
  removedHookEntryCount: number;
  removedEventKeys: string[];
  removedStatusLine: boolean;
  // "none": nothing FA-owned found, leave the file untouched.
  // "rewrite": FA entries stripped, other content remains -- write nextContent back.
  // "delete": FA entries stripped and nothing else was in the file -- remove it entirely,
  //   so a settings.json this install created from nothing round-trips back to absent,
  //   rather than leaving a vestigial `{}` behind.
  action: "none" | "rewrite" | "delete";
  nextContent: Record<string, unknown> | null; // set only when action === "rewrite"
};

type UninstallPlan = {
  dest: string;
  global: boolean;
  settings: SettingsPlan;
  mode: "manifest" | "legacy" | "none";
  removeFiles: RemovableFile[];
  removeSymlinks: RemovableSymlink[];
  preserved: PreservedFile[];
  removeDurable: { path: string; reason: string }[];
  residue: ResidueEntry[];
};

// ─── Settings (hooks + statusLine) ─────────────────────────────────────────────────────────

function settingsPathFor(dest: string, global: boolean): string {
  return global ? path.join(dest, "settings.json") : path.join(dest, ".claude", "settings.json");
}

/**
 * True when a single INNER hook object (`{ type, command, statusMessage, ... }`, one entry of a
 * hook group's `hooks` array) carries an FA marker in its `statusMessage`. Deliberately entry-
 * granular, not group-granular: the Claude Code settings schema allows multiple entries in one
 * group's `hooks` array, and nothing prevents a user (or another tool) appending its own hook
 * into a group FA also writes into. Stripping at group granularity would silently delete that
 * co-located user hook (and, if it was the only other content in the file, the whole
 * settings.json) along with the FA one.
 */
function isManagedInnerHook(hook: unknown, faMarkers: string[]): boolean {
  if (typeof hook !== "object" || hook === null) return false;
  const statusMessage = (hook as Record<string, unknown>)["statusMessage"];
  const sm = typeof statusMessage === "string" ? statusMessage : "";
  return faMarkers.some((marker) => sm.includes(marker));
}

function planSettings(dest: string, global: boolean, faMarkers: string[]): SettingsPlan {
  const settingsPath = settingsPathFor(dest, global);
  if (!fs.existsSync(settingsPath)) {
    return { settingsPath, exists: false, removedHookEntryCount: 0, removedEventKeys: [], removedStatusLine: false, action: "none", nextContent: null };
  }
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`existing settings file is not valid JSON, refusing to modify it: ${settingsPath}: ${(error as Error).message}`);
  }
  const next: Record<string, unknown> = { ...existing };
  let removedHookEntryCount = 0;
  const removedEventKeys: string[] = [];
  if (existing["hooks"] && typeof existing["hooks"] === "object") {
    const hooks = existing["hooks"] as Record<string, unknown>;
    const nextHooks: Record<string, unknown> = {};
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) {
        nextHooks[event] = groups;
        continue;
      }
      const keptGroups: unknown[] = [];
      let eventChanged = false;
      for (const group of groups) {
        const groupObj = typeof group === "object" && group !== null ? (group as Record<string, unknown>) : null;
        const innerHooks = groupObj && Array.isArray(groupObj["hooks"]) ? (groupObj["hooks"] as unknown[]) : null;
        if (!groupObj || !innerHooks) {
          keptGroups.push(group);
          continue;
        }
        const keptInner = innerHooks.filter((hook) => !isManagedInnerHook(hook, faMarkers));
        const removedInner = innerHooks.length - keptInner.length;
        if (removedInner === 0) {
          keptGroups.push(group);
          continue;
        }
        removedHookEntryCount += removedInner;
        eventChanged = true;
        // Strip only the FA-owned inner hook entries; keep the group (with every other key
        // untouched) whenever a co-located user entry survives. Only drop the group entirely
        // when every one of its inner entries was FA-owned.
        if (keptInner.length > 0) keptGroups.push({ ...groupObj, hooks: keptInner });
      }
      if (eventChanged) removedEventKeys.push(event);
      if (keptGroups.length > 0) nextHooks[event] = keptGroups;
    }
    next["hooks"] = nextHooks;
  }
  let removedStatusLine = false;
  const statusLine = existing["statusLine"];
  if (statusLine !== undefined && JSON.stringify(statusLine).includes(STATUSLINE_MARKER)) {
    delete next["statusLine"];
    removedStatusLine = true;
  }
  const changed = removedHookEntryCount > 0 || removedStatusLine;
  if (!changed) {
    return { settingsPath, exists: true, removedHookEntryCount: 0, removedEventKeys: [], removedStatusLine: false, action: "none", nextContent: null };
  }
  // Never leave a spurious `"hooks": {}` behind once every managed entry is gone -- mirrors
  // mergeSettings' own "don't inject a spurious empty hooks key" rule (install-merge.js), applied
  // in reverse for removal.
  if (Object.prototype.hasOwnProperty.call(next, "hooks") && Object.keys(next["hooks"] as Record<string, unknown>).length === 0) {
    delete next["hooks"];
  }
  // If nothing but Flow Agents content was ever in this file, remove it entirely instead of
  // leaving an empty `{}` -- a settings.json this install created from nothing round-trips back
  // to genuinely absent, not to a vestigial empty file. Because stripping is now entry-granular,
  // this is never true while a co-located user hook (or any other user key) survives.
  const action: SettingsPlan["action"] = Object.keys(next).length === 0 ? "delete" : "rewrite";
  return { settingsPath, exists: true, removedHookEntryCount, removedEventKeys, removedStatusLine, action, nextContent: action === "rewrite" ? next : null };
}

function applySettings(plan: SettingsPlan): string | null {
  if (plan.action === "none") return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${plan.settingsPath}.bak-uninstall-${ts}`;
  fs.copyFileSync(plan.settingsPath, backupPath);
  if (plan.action === "delete") {
    fs.rmSync(plan.settingsPath);
    return backupPath;
  }
  const tmp = `${plan.settingsPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(plan.nextContent, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, plan.settingsPath);
  return backupPath;
}

// ─── Manifest-backed removal ────────────────────────────────────────────────────────────────

function planFromManifest(dest: string, manifest: OwnedFilesManifest): { removeFiles: RemovableFile[]; preserved: PreservedFile[] } {
  const removeFiles: RemovableFile[] = [];
  const preserved: PreservedFile[] = [];
  for (const entry of manifest.files) {
    // Fail closed on the FIRST unsafe/malformed entry: a manifest is not a trusted input (it can
    // be hand-edited, corrupted, or -- for project-scoped installs -- committed to a shared repo
    // and edited by anyone with write access), so it is treated as untrustworthy as a whole
    // rather than partially honored. Nothing has been deleted yet at this point (buildPlan is
    // pure/read-only), so this throw aborts the whole run before any mutation.
    const absPath = resolveManifestEntryPath(dest, (entry as { path?: unknown }).path);
    const expectedSha256 = resolveManifestEntrySha256(String((entry as { path?: unknown }).path), (entry as { sha256?: unknown }).sha256);
    const relPath = entry.path;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absPath);
    } catch {
      continue; // already gone
    }
    if (stat.isSymbolicLink()) {
      preserved.push({ relPath, absPath, reason: "manifest entry is now a symlink; refusing to remove" });
      continue;
    }
    if (!stat.isFile()) {
      preserved.push({ relPath, absPath, reason: "manifest entry is no longer a regular file" });
      continue;
    }
    if (hashFile(absPath) === expectedSha256) {
      removeFiles.push({ relPath, absPath, reason: "owned-files.json: content unmodified since install", expectedSha256 });
    } else {
      preserved.push({ relPath, absPath, reason: "content modified since install (sha256 mismatch)" });
    }
  }
  return { removeFiles, preserved };
}

// ─── Legacy inference removal ───────────────────────────────────────────────────────────────

const LEGACY_TOP_LEVEL_DIRS = ["agent-cards", "build", "context", "docs", "evals", "kits", "packaging", "powers", "prompts", "schemas", "scripts"];
const LEGACY_TOP_LEVEL_FILES = ["console.telemetry.json", "install.sh", "README.md"];

function diffBundleFilesAgainstDest(bundleDir: string, destDir: string): { removeFiles: RemovableFile[]; preserved: PreservedFile[] } {
  const removeFiles: RemovableFile[] = [];
  const preserved: PreservedFile[] = [];
  if (!fs.existsSync(bundleDir) || !fs.existsSync(destDir)) return { removeFiles, preserved };
  const { files } = listOwnedTree(bundleDir);
  const bundleRelSet = new Set(files);
  for (const rel of files) {
    const bundleFile = path.join(bundleDir, ...rel.split("/"));
    const destFile = path.join(destDir, ...rel.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destFile);
    } catch {
      continue; // not present at dest, nothing to do
    }
    if (stat.isSymbolicLink()) {
      preserved.push({ relPath: rel, absPath: destFile, reason: "unexpected symlink at a legacy-managed path" });
      continue;
    }
    if (!stat.isFile()) {
      preserved.push({ relPath: rel, absPath: destFile, reason: "not a regular file" });
      continue;
    }
    const bundleHash = hashFile(bundleFile);
    if (hashFile(destFile) === bundleHash) {
      removeFiles.push({ relPath: rel, absPath: destFile, reason: "legacy inference: content matches the currently-installed package's bundle", expectedSha256: bundleHash });
    } else {
      preserved.push({ relPath: rel, absPath: destFile, reason: "content differs from the shipped bundle (user-modified or unknown)" });
    }
  }
  // Files present at dest but absent from the CURRENT bundle are never visited by the loop
  // above (its candidate set is derived from the bundle, not the destination) -- report them
  // explicitly as unrecognized residue instead of leaving them invisible in every report
  // section. This covers a file renamed/removed upstream between the version that was
  // originally installed and the currently-installed package version, as well as anything
  // genuinely user-added under a Flow-Agents-managed directory.
  const { files: destFiles } = listOwnedTree(destDir);
  for (const rel of destFiles) {
    if (bundleRelSet.has(rel)) continue;
    preserved.push({
      relPath: rel,
      absPath: path.join(destDir, ...rel.split("/")),
      reason: "not present in the currently-installed package's bundle (renamed/removed upstream, or user-added); left in place as unrecognized residue",
    });
  }
  return { removeFiles, preserved };
}

/**
 * True when every file the currently-installed bundle ships for one skill matches, byte for
 * byte, at `targetDir`. Shared between plan time (diffSkillsForLegacyRemoval) and apply time
 * (applyPlan's TOCTOU re-check immediately before removing a symlink chain) so both use exactly
 * the same match definition.
 */
function skillContentMatchesBundle(bundleSkillDir: string, targetDir: string): boolean {
  const { files: bundleRelFiles } = listOwnedTree(bundleSkillDir);
  for (const rel of bundleRelFiles) {
    const target = path.join(targetDir, ...rel.split("/"));
    let targetStat: fs.Stats;
    try {
      targetStat = fs.lstatSync(target);
    } catch {
      return false;
    }
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) return false;
    if (hashFile(target) !== hashFile(path.join(bundleSkillDir, ...rel.split("/")))) return false;
  }
  return true;
}

/**
 * Legacy skill removal, resolving the one documented symlink chain:
 * `<skillsDestDir>/<name>` may itself be a symlink (historically to
 * `~/.agents/skills/<name>`) rather than a real directory. A skill is only removable when
 * EVERY file the currently-installed bundle ships for it matches at the resolved location;
 * removal then unlinks the symlink (if any) and deletes the resolved real directory.
 */
function diffSkillsForLegacyRemoval(
  skillsBundleDir: string,
  skillsDestDir: string
): { removeFiles: RemovableFile[]; removeSymlinks: RemovableSymlink[]; preserved: PreservedFile[] } {
  const removeFiles: RemovableFile[] = [];
  const removeSymlinks: RemovableSymlink[] = [];
  const preserved: PreservedFile[] = [];
  if (!fs.existsSync(skillsBundleDir) || !fs.existsSync(skillsDestDir)) return { removeFiles, removeSymlinks, preserved };
  const bundleSkillNames = new Set(
    fs.readdirSync(skillsBundleDir).filter((name) => fs.statSync(path.join(skillsBundleDir, name)).isDirectory())
  );
  for (const name of [...bundleSkillNames].sort()) {
    const bundleSkillDir = path.join(skillsBundleDir, name);
    const destEntry = path.join(skillsDestDir, name);
    let destStat: fs.Stats;
    try {
      destStat = fs.lstatSync(destEntry);
    } catch {
      continue; // not installed here
    }
    let symlinkPath: string | undefined;
    let realDir: string;
    if (destStat.isSymbolicLink()) {
      symlinkPath = destEntry;
      try {
        realDir = fs.realpathSync(destEntry);
      } catch {
        preserved.push({ relPath: `skills/${name}`, absPath: destEntry, reason: "symlink target is not resolvable" });
        continue;
      }
      if (!fs.existsSync(realDir) || !fs.statSync(realDir).isDirectory() || path.basename(realDir) !== name) {
        preserved.push({ relPath: `skills/${name}`, absPath: destEntry, reason: "symlink does not resolve to a same-named directory" });
        continue;
      }
    } else if (destStat.isDirectory()) {
      realDir = destEntry;
    } else {
      preserved.push({ relPath: `skills/${name}`, absPath: destEntry, reason: "not a directory or symlink" });
      continue;
    }
    if (skillContentMatchesBundle(bundleSkillDir, realDir)) {
      const reason = symlinkPath
        ? "legacy inference: skill symlink chain content matches the currently-installed package's bundle"
        : "legacy inference: skill directory content matches the currently-installed package's bundle";
      if (symlinkPath) {
        removeSymlinks.push({ relPath: `skills/${name}`, symlinkPath, targetDir: realDir, reason, bundleSkillDir });
      } else {
        const { files: bundleRelFiles } = listOwnedTree(bundleSkillDir);
        for (const rel of bundleRelFiles) {
          removeFiles.push({
            relPath: `skills/${name}/${rel}`,
            absPath: path.join(realDir, ...rel.split("/")),
            reason,
            expectedSha256: hashFile(path.join(bundleSkillDir, ...rel.split("/"))),
          });
        }
      }
    } else {
      preserved.push({ relPath: `skills/${name}`, absPath: destEntry, reason: "content differs from the shipped bundle (user-modified or unknown)" });
    }
  }
  // A dest skill directory/symlink whose name the current bundle doesn't ship at all is never
  // visited above -- report it as unrecognized residue rather than leaving it invisible (mirrors
  // diffBundleFilesAgainstDest's same fix for generic bundle-managed trees).
  for (const name of fs.readdirSync(skillsDestDir).sort()) {
    if (bundleSkillNames.has(name)) continue;
    preserved.push({
      relPath: `skills/${name}`,
      absPath: path.join(skillsDestDir, name),
      reason: "not present in the currently-installed package's bundle (renamed/removed upstream, or user-added); left in place as unrecognized residue",
    });
  }
  return { removeFiles, removeSymlinks, preserved };
}

function planLegacy(bundle: string, dest: string, global: boolean): { removeFiles: RemovableFile[]; removeSymlinks: RemovableSymlink[]; preserved: PreservedFile[] } {
  const removeFiles: RemovableFile[] = [];
  const removeSymlinks: RemovableSymlink[] = [];
  const preserved: PreservedFile[] = [];

  const skillsDestDir = global ? path.join(dest, "skills") : path.join(dest, ".claude", "skills");
  const agentsDestDir = global ? path.join(dest, "agents") : path.join(dest, ".claude", "agents");
  const skills = diffSkillsForLegacyRemoval(path.join(bundle, ".claude", "skills"), skillsDestDir);
  removeFiles.push(...skills.removeFiles);
  removeSymlinks.push(...skills.removeSymlinks);
  preserved.push(...skills.preserved);
  const agents = diffBundleFilesAgainstDest(path.join(bundle, ".claude", "agents"), agentsDestDir);
  removeFiles.push(...agents.removeFiles.map((f) => ({ ...f, relPath: `agents/${f.relPath}` })));
  preserved.push(...agents.preserved.map((f) => ({ ...f, relPath: `agents/${f.relPath}` })));

  for (const name of LEGACY_TOP_LEVEL_DIRS) {
    const result = diffBundleFilesAgainstDest(path.join(bundle, name), path.join(dest, name));
    removeFiles.push(...result.removeFiles.map((f) => ({ ...f, relPath: `${name}/${f.relPath}` })));
    preserved.push(...result.preserved.map((f) => ({ ...f, relPath: `${name}/${f.relPath}` })));
  }
  for (const name of LEGACY_TOP_LEVEL_FILES) {
    const result = diffSingleLegacyFile(path.join(bundle, name), path.join(dest, name), name);
    if (result) (result.match ? removeFiles : preserved).push(result.match ? result.removable! : result.preservedEntry!);
  }
  // catalog.json ships at the dist ROOT (sibling of the per-runtime bundle), not inside it --
  // see build-universal-bundles.ts's buildCatalog()/writeText(dist/catalog.json, ...).
  const catalogResult = diffSingleLegacyFile(path.join(path.dirname(bundle), "catalog.json"), path.join(dest, "catalog.json"), "catalog.json");
  if (catalogResult) (catalogResult.match ? removeFiles : preserved).push(catalogResult.match ? catalogResult.removable! : catalogResult.preservedEntry!);

  return { removeFiles, removeSymlinks, preserved };
}

function diffSingleLegacyFile(
  sourceFile: string,
  destFile: string,
  relPath: string
): { match: boolean; removable?: RemovableFile; preservedEntry?: PreservedFile } | null {
  if (!fs.existsSync(sourceFile) || !fs.existsSync(destFile)) return null;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(destFile);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { match: false, preservedEntry: { relPath, absPath: destFile, reason: "not a regular file" } };
  }
  const sourceHash = hashFile(sourceFile);
  if (hashFile(destFile) === sourceHash) {
    return { match: true, removable: { relPath, absPath: destFile, reason: "legacy inference: content matches the currently-installed package's bundle", expectedSha256: sourceHash } };
  }
  return { match: false, preservedEntry: { relPath, absPath: destFile, reason: "content differs from the shipped bundle (user-modified or unknown)" } };
}

// ─── Durable artifacts + residue ────────────────────────────────────────────────────────────

const DURABLE_ARTIFACT_FILES = ["install.json", "skills-manifest.json", "owned-files.json", "runtime-assets.json", "registry-latest.json"];
const DURABLE_ARTIFACT_DIRS = ["runtime"];

function planDurableArtifacts(dest: string): { removeDurable: { path: string; reason: string }[]; note?: string } {
  const durableRoot = durableFlowAgentsRoot(dest);
  const installRecordPath = path.join(durableRoot, "install.json");
  if (fs.existsSync(installRecordPath)) {
    try {
      const record = JSON.parse(fs.readFileSync(installRecordPath, "utf8")) as Record<string, unknown>;
      if (record["runtime"] !== undefined && record["runtime"] !== "claude-code") {
        return { removeDurable: [], note: `${installRecordPath}: durable install record belongs to runtime '${String(record["runtime"])}', not claude-code; leaving all .flow-agents/* durable artifacts in place` };
      }
    } catch {
      // Unreadable install.json: fall through and still offer to remove the known durable
      // names below -- they are self-evidently Flow Agents' own namespaced files regardless.
    }
  }
  const removeDurable: { path: string; reason: string }[] = [];
  for (const name of DURABLE_ARTIFACT_FILES) {
    const file = path.join(durableRoot, name);
    if (fs.existsSync(file) && fs.lstatSync(file).isFile()) removeDurable.push({ path: file, reason: "flow-agents durable install artifact" });
  }
  for (const name of DURABLE_ARTIFACT_DIRS) {
    const dir = path.join(durableRoot, name);
    if (fs.existsSync(dir) && fs.lstatSync(dir).isDirectory()) removeDurable.push({ path: dir, reason: "flow-agents durable install artifact" });
  }
  return { removeDurable };
}

function planResidue(dest: string, global: boolean): ResidueEntry[] {
  const residue: ResidueEntry[] = [];
  if (!global) {
    const kontourai = path.join(dest, ".kontourai");
    if (fs.existsSync(kontourai)) residue.push({ path: kontourai, note: "per-repo Flow Agents coordination/telemetry state; not runtime-specific, never removed by uninstall" });
  }
  const etcLifecycleAuthority = "/etc/kontourai";
  if (fs.existsSync(etcLifecycleAuthority)) residue.push({ path: etcLifecycleAuthority, note: "system-wide lifecycle authority; out of scope for a per-destination uninstall" });
  return residue;
}

// ─── Plan assembly ──────────────────────────────────────────────────────────────────────────

function buildPlan(dest: string, global: boolean): UninstallPlan {
  const { FA_MARKERS } = loadInstallMergeModule();
  const settings = planSettings(dest, global, FA_MARKERS);

  const manifest = readOwnedFilesManifest(dest);
  let mode: UninstallPlan["mode"];
  let removeFiles: RemovableFile[] = [];
  let removeSymlinks: RemovableSymlink[] = [];
  let preserved: PreservedFile[] = [];
  if (manifest) {
    mode = "manifest";
    // Validated entry-by-entry inside planFromManifest -- throws (aborting before any deletion)
    // on the first unsafe or malformed entry rather than skipping it and continuing.
    const result = planFromManifest(dest, manifest);
    removeFiles = result.removeFiles;
    preserved = result.preserved;
  } else {
    const bundle = ensureBundle("claude-code");
    const result = planLegacy(bundle, dest, global);
    removeFiles = result.removeFiles;
    removeSymlinks = result.removeSymlinks;
    preserved = result.preserved;
    mode = removeFiles.length > 0 || removeSymlinks.length > 0 || preserved.length > 0 ? "legacy" : "none";
  }

  const { removeDurable } = planDurableArtifacts(dest);
  const residue = planResidue(dest, global);

  return { dest, global, settings, mode, removeFiles, removeSymlinks, preserved, removeDurable, residue };
}

function planIsEmpty(plan: UninstallPlan): boolean {
  return (
    plan.settings.action === "none" &&
    plan.removeFiles.length === 0 &&
    plan.removeSymlinks.length === 0 &&
    plan.removeDurable.length === 0
  );
}

// ─── Execution ──────────────────────────────────────────────────────────────────────────────

function pruneEmptyDirs(root: string, startDirs: Iterable<string>): void {
  const rootResolved = path.resolve(root);
  const sorted = [...new Set(startDirs)].sort((a, b) => b.length - a.length);
  for (const start of sorted) {
    let current = path.resolve(start);
    while (current !== rootResolved && current.startsWith(`${rootResolved}${path.sep}`)) {
      try {
        fs.rmdirSync(current);
      } catch {
        break; // not empty, or already gone -- stop walking up this branch
      }
      current = path.dirname(current);
    }
  }
}

type ApplyOutcome = {
  settingsBackupPath: string | null;
  removedFiles: RemovableFile[];
  removedSymlinks: RemovableSymlink[];
  failed: RemovalFailure[];
  preservedAtApply: PreservedFile[];
};

/**
 * The only mutating step. Never lets an exception escape: every removal (settings, each file,
 * each symlink chain, each durable artifact) is individually try/caught, so a single failure
 * midway through never hides the accounting of everything that happened before or after it --
 * the caller always gets a complete, truthful outcome to report. Re-verifies each file/symlink
 * chain's content immediately before removing it (closing the plan/confirm/apply TOCTOU window):
 * anything that no longer matches what `buildPlan()` observed is preserved, not deleted.
 */
function applyPlan(plan: UninstallPlan): ApplyOutcome {
  const failed: RemovalFailure[] = [];
  const preservedAtApply: PreservedFile[] = [];
  const removedFiles: RemovableFile[] = [];
  const removedSymlinks: RemovableSymlink[] = [];

  let settingsBackupPath: string | null = null;
  try {
    settingsBackupPath = applySettings(plan.settings);
  } catch (error) {
    failed.push({ relPath: plan.settings.settingsPath, absPath: plan.settings.settingsPath, reason: `settings update failed: ${(error as Error).message}` });
  }

  const removedParents = new Set<string>();
  for (const entry of plan.removeFiles) {
    try {
      if (!fs.existsSync(entry.absPath)) continue; // already gone -- nothing to do, not a failure
      const stat = fs.lstatSync(entry.absPath);
      if (stat.isSymbolicLink() || !stat.isFile() || hashFile(entry.absPath) !== entry.expectedSha256) {
        preservedAtApply.push({ relPath: entry.relPath, absPath: entry.absPath, reason: "content changed since the plan was computed; preserved (re-checked immediately before removal)" });
        continue;
      }
      fs.rmSync(entry.absPath);
      removedFiles.push(entry);
      removedParents.add(path.dirname(entry.absPath));
    } catch (error) {
      failed.push({ relPath: entry.relPath, absPath: entry.absPath, reason: (error as Error).message });
    }
  }
  for (const entry of plan.removeSymlinks) {
    let stillMatches: boolean;
    try {
      stillMatches = skillContentMatchesBundle(entry.bundleSkillDir, entry.targetDir);
    } catch (error) {
      preservedAtApply.push({ relPath: entry.relPath, absPath: entry.symlinkPath, reason: `could not re-verify before removal: ${(error as Error).message}` });
      continue;
    }
    if (!stillMatches) {
      preservedAtApply.push({ relPath: entry.relPath, absPath: entry.symlinkPath, reason: "content changed since the plan was computed; preserved (re-checked immediately before removal)" });
      continue;
    }
    let symlinkPresent = true;
    try {
      fs.lstatSync(entry.symlinkPath);
    } catch {
      symlinkPresent = false;
    }
    let symlinkRemoved = !symlinkPresent;
    if (symlinkPresent) {
      try {
        fs.unlinkSync(entry.symlinkPath);
        symlinkRemoved = true;
        removedParents.add(path.dirname(entry.symlinkPath));
      } catch (error) {
        failed.push({ relPath: entry.relPath, absPath: entry.symlinkPath, reason: `symlink removal failed: ${(error as Error).message}` });
      }
    }
    // Never touch the (more destructive) target directory removal if the symlink itself could
    // not be unlinked -- a partial failure here must leave the LESS destructive half undone,
    // not the more destructive half done and unreported.
    if (!symlinkRemoved) continue;
    if (fs.existsSync(entry.targetDir)) {
      try {
        // Deliberately does NOT prune the target's parent (e.g. ~/.agents/skills) even if it
        // becomes empty -- that directory is shared, cross-tool infrastructure this install
        // never created, so it is out of scope for this uninstall regardless of occupancy.
        fs.rmSync(entry.targetDir, { recursive: true, force: true });
        removedSymlinks.push(entry);
      } catch (error) {
        failed.push({ relPath: entry.relPath, absPath: entry.targetDir, reason: `target directory removal failed: ${(error as Error).message}` });
      }
    } else {
      removedSymlinks.push(entry);
    }
  }
  pruneEmptyDirs(plan.dest, removedParents);

  for (const entry of plan.removeDurable) {
    try {
      if (!fs.existsSync(entry.path)) continue;
      fs.rmSync(entry.path, { recursive: true, force: true });
    } catch (error) {
      failed.push({ relPath: entry.path, absPath: entry.path, reason: (error as Error).message });
    }
  }
  pruneEmptyDirs(plan.dest, [durableFlowAgentsRoot(plan.dest)]);

  return { settingsBackupPath, removedFiles, removedSymlinks, failed, preservedAtApply };
}

// ─── Reporting ──────────────────────────────────────────────────────────────────────────────

function printReport(plan: UninstallPlan, applied: boolean, outcome: ApplyOutcome): void {
  const heading = applied ? "Flow Agents claude-code uninstall" : "Flow Agents claude-code uninstall (dry run — nothing changed)";
  console.log(`${heading}`);
  console.log(`  target: ${plan.dest} (${plan.global ? "global" : "project-scoped"})`);
  console.log(`  ownership mode: ${plan.mode}`);
  console.log("");

  console.log(`Settings: ${plan.settings.settingsPath}`);
  if (!plan.settings.exists) {
    console.log("  no settings file found");
  } else if (plan.settings.action === "none") {
    console.log("  no managed hook entries or statusLine found");
  } else {
    console.log(`  ${applied ? "removed" : "would remove"} ${plan.settings.removedHookEntryCount} managed hook entries across event(s): ${plan.settings.removedEventKeys.join(", ") || "(none)"}`);
    if (plan.settings.removedStatusLine) console.log(`  ${applied ? "removed" : "would remove"} the managed statusLine entry`);
    if (plan.settings.action === "delete") console.log(`  settings file contained only Flow Agents content; ${applied ? "removed" : "would remove"} it entirely`);
    if (applied && outcome.settingsBackupPath) console.log(`  backup written: ${outcome.settingsBackupPath}`);
  }
  console.log("");

  const removedTotal = outcome.removedFiles.length + outcome.removedSymlinks.length;
  console.log(`${applied ? "Removed" : "Would remove"} (${removedTotal}):`);
  for (const entry of outcome.removedFiles) console.log(`  ${entry.relPath}  [${entry.reason}]`);
  for (const entry of outcome.removedSymlinks) console.log(`  ${entry.relPath} (symlink -> ${entry.targetDir})  [${entry.reason}]`);
  if (removedTotal === 0) console.log("  (none)");
  console.log("");

  const allPreserved = [...plan.preserved, ...outcome.preservedAtApply];
  console.log(`Preserved — modified or unknown (${allPreserved.length}):`);
  for (const entry of allPreserved) console.log(`  ${entry.relPath}  [${entry.reason}]`);
  if (allPreserved.length === 0) console.log("  (none)");
  console.log("");

  console.log(`Failed to remove (${outcome.failed.length}):`);
  for (const entry of outcome.failed) console.log(`  ${entry.relPath}  [${entry.reason}]`);
  if (outcome.failed.length === 0) console.log("  (none)");
  console.log("");

  console.log(`Durable artifacts ${applied ? "removed" : "to remove"} (${plan.removeDurable.length}):`);
  for (const entry of plan.removeDurable) console.log(`  ${entry.path}`);
  if (plan.removeDurable.length === 0) console.log("  (none)");
  console.log("");

  console.log(`Residue (never removed by uninstall, reported only) (${plan.residue.length}):`);
  for (const entry of plan.residue) console.log(`  ${entry.path}  — ${entry.note}`);
  if (plan.residue.length === 0) console.log("  (none)");
  console.log("");

  console.log("The npm package itself is not removed. To finish, run:");
  console.log("  npm rm -g @kontourai/flow-agents");
}

function dryRunOutcome(plan: UninstallPlan): ApplyOutcome {
  return { settingsBackupPath: null, removedFiles: plan.removeFiles, removedSymlinks: plan.removeSymlinks, failed: [], preservedAtApply: [] };
}

// ─── CLI entry ──────────────────────────────────────────────────────────────────────────────

async function confirmDestructive(dest: string, flags: ReturnType<typeof parseArgs>["flags"]): Promise<boolean> {
  if (flagBool(flags, "yes") || flagBool(flags, "headless")) return true;
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`This will permanently remove Flow Agents claude-code files from ${dest}. Type "yes" to continue: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return 0;
  }
  try {
    const args = parseArgs(argv);
    const runtime = flagString(args.flags, "runtime");
    if (runtime !== "claude-code") {
      console.error(`flow-agents init --uninstall: --runtime is required and only 'claude-code' is currently supported (got: ${runtime ?? "(none)"})`);
      usage();
      return 2;
    }
    const isGlobal = flagBool(args.flags, "global");
    const destFlag = flagString(args.flags, "dest") ?? args.positionals[0];
    if (isGlobal && destFlag) {
      console.error("flow-agents init --uninstall: --global and an explicit destination are mutually exclusive");
      return 2;
    }
    if (!isGlobal && !destFlag) {
      console.error("flow-agents init --uninstall: provide --global or an explicit destination (--dest PATH, or a positional path)");
      return 2;
    }
    const dest = isGlobal ? globalDest("claude-code") : path.resolve(destFlag as string);
    if (!fs.existsSync(dest)) {
      console.error(`flow-agents init --uninstall: nothing to uninstall (destination does not exist): ${dest}`);
      return 3;
    }

    const plan = buildPlan(dest, isGlobal);
    const dryRun = flagBool(args.flags, "dry-run");

    if (planIsEmpty(plan)) {
      printReport(plan, false, dryRunOutcome(plan));
      console.error("flow-agents init --uninstall: nothing found to uninstall");
      return 3;
    }

    if (dryRun) {
      printReport(plan, false, dryRunOutcome(plan));
      return 0;
    }

    // TEST-ONLY hook: simulates a file changing during the plan/confirm/apply window (e.g. the
    // interactive confirmation prompt's stdin wait) so the apply-time TOCTOU re-verification can
    // be exercised deterministically without racing a real background process. Never read
    // outside this module's own eval fixtures; not part of the public CLI surface.
    const toctouTestMutateFile = process.env["FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_MUTATE_FILE"];
    if (toctouTestMutateFile) {
      fs.appendFileSync(toctouTestMutateFile, "\nTOCTOU-test-mutation\n", "utf8");
    }

    const confirmed = await confirmDestructive(dest, args.flags);
    if (!confirmed) {
      console.error("flow-agents init --uninstall: destructive removal was not confirmed (pass --yes or --headless to confirm non-interactively)");
      return 1;
    }

    const outcome = applyPlan(plan);
    printReport(plan, true, outcome);
    return outcome.failed.length > 0 ? 4 : 0;
  } catch (error) {
    console.error(`flow-agents init --uninstall: ${(error as Error).message}`);
    return 2;
  }
}

// Use process.exitCode (not process.exit) so stdout flushes before exit; resolve real paths to
// handle symlinks so the entry-point guard fires correctly when loaded directly (see init.ts).
const _selfRealPath = (() => {
  try {
    return fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return new URL(import.meta.url).pathname;
  }
})();
const _argv1RealPath = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? "");
  } catch {
    return process.argv[1] ?? "";
  }
})();
if (_selfRealPath === _argv1RealPath) {
  process.exitCode = await main();
}
