// flow-agents init --uninstall — remove a prior runtime install.
//
// Two removal modes, chosen purely by whether an ownership manifest exists (never mixed):
//   - manifest-backed: `.flow-agents/owned-files.json` (written by a manifest-era install,
//     see owned-files-manifest.ts) lists every file the install wrote with a sha256. A file is
//     removed only when its current content still matches; anything modified is preserved and
//     reported. Every manifest entry is validated (path containment, sha256 shape) before use --
//     a manifest is not a trusted input (see resolveManifestEntryPath in owned-files-manifest.ts)
//     -- and the whole run aborts, before any deletion, on the first unsafe/malformed entry.
//   - legacy inference: claude-code only, when no manifest exists. The candidate set is derived by hashing the *executing*
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
// Removal uses a three-tier ownership rule. A valid pre-install snapshot is authoritative.
// Without one, an installation-specific value is removable only when it is byte-identical to
// the value this install writes; a marker match that differs is retained and disclosed. Generic
// defaults (for example OpenCode's public $schema URL) are never removed without a snapshot.
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
//   - The unrecognized-residue walk (`listOwnedTree(destDir)` inside `diffBundleFilesAgainstDest`
//     / `diffSkillsForLegacyRemoval`) has no depth/size bound on the dest side of each fixed
//     legacy-managed directory name; it is read-only reporting (never follows symlinks, never
//     deletes), so an adversarially deep/wide tree there is at most a slow run, not a data-
//     integrity risk -- not worth bounding given the small fixed set of directory names it walks.
//   - Exit code does not distinguish a containment-violation preserve (a symlink swap correctly
//     detected and blocked mid-apply) from an ordinary content-drift preserve (ordinary TOCTOU or
//     ordinary "user modified this") -- both exit 0, consistent with this file's existing
//     content-hash TOCTOU preserve design; the report's "Preserved" section always names the
//     specific reason, so this is a coarser exit code, not a report accuracy gap.
//   - `--dry-run` reports the PLAN, not a simulation of apply-time re-verification: a file whose
//     content drifts (or whose parent containment would fail) between plan and a hypothetical
//     apply is printed as "would be removed" even though a real run's apply-time re-checks would
//     preserve it. The error direction is conservative (dry-run over-states removal; the real run
//     never removes more than dry-run showed), and no eval currently exercises dry-run fidelity.
//   - `--authorize-backing-root` revalidates a canonical pathname immediately before each config
//     write. It is not an openat-style defense against a same-user filesystem race that replaces
//     the backing directory at that pathname between validation and the pathname-based operation.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseArgs, flagBool, flagList, flagString } from "../lib/args.js";
import { root } from "../tools/common.js";
import { durableFlowAgentsRoot } from "../lib/local-artifact-root.js";
import {
  hashFile,
  listOwnedTree,
  readOwnedFilesManifest,
  resolveManifestEntryPath,
  resolveManifestEntrySha256,
  assertManifestEntryParentContained,
  ManifestContainmentViolationError,
  type OwnedFilesManifest,
} from "../lib/owned-files-manifest.js";
import { ensureBundle, globalDest, opencodeGlobalConfigPath, resolveOpenCodeConfigBinding, revalidateOpenCodeConfigBinding, type OpenCodeConfigBinding } from "./init.js";

type UninstallRuntime = "claude-code" | "codex" | "opencode";
type RuntimeConfig = { runtime: UninstallRuntime; manifestName: string; configPath: (dest: string, global: boolean) => string; removeStatusLine: boolean; removeInstructionsPath?: (dest: string) => string; removeOwnedValues?: Record<string, unknown>; additionalManifestRoots?: () => { dest: string; manifestName: string; label: string }[] };

const RUNTIME_CONFIGS: Record<UninstallRuntime, RuntimeConfig> = {
  "claude-code": { runtime: "claude-code", manifestName: "owned-files.json", configPath: (dest, global) => global ? path.join(dest, "settings.json") : path.join(dest, ".claude", "settings.json"), removeStatusLine: true, removeOwnedValues: { "permissions.defaultMode": "auto", "skipDangerousModePermissionPrompt": true } },
  codex: { runtime: "codex", manifestName: "codex-install-manifest.json", configPath: (dest) => path.join(dest, "hooks.json"), removeStatusLine: false,
    additionalManifestRoots: () => [{ dest: path.resolve(process.env["FLOW_AGENTS_SKILLS_DIR"] ?? path.join(os.homedir(), ".agents", "skills")), manifestName: "codex-universal-skills-install-manifest.json", label: "universal-skills" }] },
  opencode: { runtime: "opencode", manifestName: "runtime-assets.json", configPath: (dest, global) => global ? opencodeGlobalConfigPath(dest) : path.join(dest, "opencode.json"), removeStatusLine: false, removeInstructionsPath: (dest) => path.join(dest, ".flow-agents", "runtime", "AGENTS.md"), removeOwnedValues: { "$schema": "https://opencode.ai/config.json" } },
};

type InstallMergeModule = {
  isManagedHookGroup: (hookGroup: unknown) => boolean;
  isManagedInnerHook: (hook: unknown) => boolean;
  FA_MARKERS: string[];
  restoreConfigPremergeBytes: (premerge: unknown, nextContent: unknown, currentBytes: Buffer) => Buffer | null;
};

type ConfigPremergeSnapshot = {
  schema_version: "1.0";
  existed: boolean;
  bytes_base64: string;
  parsed: Record<string, unknown>;
  post_install_sha256: string;
  config_path: string;
  runtime: UninstallRuntime;
};

type PremergeRead = {
  /** Earliest lineage baseline: only scalar ownership/provenance reads this. */
  origin?: ConfigPremergeSnapshot;
  /** Immediately before this install: only byte-fidelity restore reads this. */
  previous?: ConfigPremergeSnapshot;
  provenanceReason: string;
  restoreReason: string;
  hasPreviousRecord: boolean;
  /** Exact managed values the installing version wrote, keyed by canonical config path. */
  installedValues?: { hooks?: unknown[]; statusLine?: unknown; instructions?: unknown[] };
};

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
  console.error(`usage: flow-agents init --uninstall --runtime <claude-code|codex|opencode> [--global | --dest PATH] [options]

Removes a prior Flow Agents runtime install: managed settings.json hook entries/statusLine,
installed skill/agent files (manifest-backed when an ownership manifest is present, otherwise
inferred against the currently-installed package's own bundle content), and the durable
.flow-agents/* stamp files. Never removes: per-repo .kontourai/ state, the /etc/kontourai
lifecycle authority, telemetry data files, or the npm package itself (a final
'npm rm -g @kontourai/flow-agents' instruction is printed).

For merged Claude Code and OpenCode configs, .flow-agents/install.json contains a copy of the
pre-install config bytes so uninstall can restore exact formatting when the installed config is
otherwise unchanged. That record is written owner-readable only and removed by uninstall.

Options:
  --runtime RUNTIME       Required: claude-code, codex, or opencode.
  --global                Target the runtime's global install (~/.claude, honors
                          FLOW_AGENTS_USER_CLAUDE_SETTINGS for test isolation).
  --dest PATH             Target an explicit project-scoped destination.
                          A bare positional argument is accepted as an alias for --dest.
  --dry-run               Print the removal plan without deleting or modifying anything.
  --authorize-backing-root PATH
                          OpenCode only; explicitly authorize one resolved, real backing root
                          for this invocation. Repeat for each currently referenced root. This
                          is never recorded in install.json. Revalidated by canonical path
                          immediately before write; not a defense against a same-user
                          filesystem race.
  --yes, --headless       Confirm the destructive removal non-interactively. Without one of
                          these, a non-interactive invocation (no TTY, e.g. CI or a pipe) is
                          refused rather than silently proceeding or silently doing nothing.

Exit codes: 0 ok, 1 confirmation declined/not given, 2 usage or validation error (including an
unsafe or malformed owned-files.json entry -- the run aborts before any deletion), 3 nothing
found to uninstall, 4 one or more removals failed (see the report's "Failed to remove" section).
`);
}

// ─── Discovery types ────────────────────────────────────────────────────────────────────────

type RemovableFile = { relPath: string; absPath: string; root?: string; reason: string; expectedSha256: string };
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
  // The surgical JSON result. Kept even for "delete" so a matching pre-install `{}` can be
  // restored byte-for-byte instead of being mistaken for an originally absent config.
  nextContent: Record<string, unknown> | null;
  preserved: PreservedFile[];
  protectedRuntimePaths: string[];
};

type UninstallPlan = {
  runtime: UninstallRuntime;
  dest: string;
  global: boolean;
  settings: SettingsPlan;
  mode: "manifest" | "legacy" | "none";
  removeFiles: RemovableFile[];
  removeSymlinks: RemovableSymlink[];
  preserved: PreservedFile[];
  removeDurable: DurableFile[];
  residue: ResidueEntry[];
  opencodeBinding?: OpenCodeConfigBinding;
  operatorAuthorizedBackingRoots: string[];
};

type DurableFile = { path: string; relPath: string; root: string; expectedSha256: string; reason: string };

// ─── Settings (hooks + statusLine) ─────────────────────────────────────────────────────────

// Entry-granular "is this hook FA-owned" is imported from install-merge.js's
// isManagedInnerHook (see loadInstallMergeModule/buildPlan) rather than duplicated here --
// mergeSettings' hooks step (the ordinary `flow-agents init` merge/re-install path) and this
// module's settings stripping now both strip at inner-hook granularity via the exact same
// function, so the two paths can never independently drift on which hooks count as FA-owned.
// A group mixing a user hook with an FA hook keeps the user hook (and every other group-level
// field, e.g. `matcher`); a group is dropped entirely only when every inner hook was FA-owned.

function getPath(value: Record<string, unknown>, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((current, segment) => current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>)[segment] : undefined, value);
}

function deletePath(value: Record<string, unknown>, dotted: string): void {
  const parts = dotted.split("."); let current: Record<string, unknown> = value;
  for (const part of parts.slice(0, -1)) { const child = current[part]; if (!child || typeof child !== "object" || Array.isArray(child)) return; current = child as Record<string, unknown>; }
  delete current[parts[parts.length - 1]];
  if (parts.length === 2 && Object.keys(value[parts[0]] as Record<string, unknown>).length === 0) delete value[parts[0]];
}

function snapshotHasManagedHook(premerge: ConfigPremergeSnapshot, isManagedInnerHook: (hook: unknown) => boolean): boolean {
  const hooks = premerge.parsed["hooks"];
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  return Object.values(hooks as Record<string, unknown>).some((groups) => Array.isArray(groups) && groups.some((group) => {
    const inner = group && typeof group === "object" && Array.isArray((group as Record<string, unknown>)["hooks"]) ? (group as Record<string, unknown>)["hooks"] as unknown[] : [];
    return inner.some(isManagedInnerHook);
  }));
}

function rewriteExpectedGlobalClaudeCommands(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) rewriteExpectedGlobalClaudeCommands(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (key === "command" && typeof entry === "string") {
      record[key] = entry
        .replace(/root="\$\{CLAUDE_PROJECT_DIR:-\$\(pwd\)\}";\s*/g, "")
        .replace(/"\$root\//g, `"${root}/`);
    } else rewriteExpectedGlobalClaudeCommands(entry);
  }
}

/** Values emitted by this package for this runtime/install location. */
function expectedManagedConfig(config: RuntimeConfig, global: boolean): Record<string, unknown> {
  const bundle = ensureBundle(config.runtime);
  const source = config.runtime === "claude-code"
    ? path.join(bundle, ".claude", "settings.json")
    : config.runtime === "codex"
      ? path.join(bundle, ".codex", "hooks.json")
      : path.join(bundle, "opencode.json");
  const managed = JSON.parse(fs.readFileSync(source, "utf8")) as Record<string, unknown>;
  if (config.runtime === "claude-code" && global) {
    delete managed["permissions"];
    delete managed["skipDangerousModePermissionPrompt"];
    rewriteExpectedGlobalClaudeCommands(managed);
  }
  return managed;
}

function expectedManagedInnerHooks(managed: Record<string, unknown>): unknown[] {
  const hooks = managed["hooks"];
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const expected: unknown[] = [];
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== "object" || !Array.isArray((group as Record<string, unknown>)["hooks"])) continue;
      expected.push(...(group as Record<string, unknown>)["hooks"] as unknown[]);
    }
  }
  return expected;
}

function originManagedHookGroups(premerge: ConfigPremergeSnapshot, isManagedInnerHook: (hook: unknown) => boolean): Record<string, unknown[]> {
  const hooks = premerge.parsed["hooks"];
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return {};
  const restored: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== "object" || !Array.isArray((group as Record<string, unknown>)["hooks"])) continue;
      const marked = ((group as Record<string, unknown>)["hooks"] as unknown[]).filter(isManagedInnerHook);
      if (marked.length > 0) (restored[event] ??= []).push({ ...(group as Record<string, unknown>), hooks: marked });
    }
  }
  return restored;
}

function valuesByteIdentical(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function scalarRemovalProvenance(snapshot: PremergeRead, key: string): { introduced: boolean; reason: string } {
  const premerge = snapshot.origin;
  if (!premerge) {
    return { introduced: false, reason: `cannot prove Flow Agents added it (${snapshot.provenanceReason})` };
  }
  if (getPath(premerge.parsed, key) !== undefined) {
    return { introduced: false, reason: "cannot prove Flow Agents added it (pre-install snapshot shows it already existed)" };
  }
  return { introduced: true, reason: "" };
}

function planSettings(dest: string, global: boolean, config: RuntimeConfig, isManagedInnerHook: (hook: unknown) => boolean, snapshot: PremergeRead, settingsPathOverride?: string): SettingsPlan {
  const settingsPath = settingsPathOverride ?? config.configPath(dest, global);
  if (!fs.existsSync(settingsPath)) {
    return { settingsPath, exists: false, removedHookEntryCount: 0, removedEventKeys: [], removedStatusLine: false, action: "none", nextContent: null, preserved: [], protectedRuntimePaths: [] };
  }
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`existing settings file is not valid JSON, refusing to modify it: ${settingsPath}: ${(error as Error).message}`);
  }
  const next: Record<string, unknown> = { ...existing };
  // Structural ownership decisions use the lineage origin, never the current
  // reinstall baseline. Byte restoration below deliberately uses `previous`.
  const premerge = snapshot.origin;
  const managed = expectedManagedConfig(config, global);
  // A corrupt installed_values.hooks (e.g. `{}` or a truncated string) must fall back to the
  // current package's values, not propagate a non-array into `.some(...)` -- throwing there
  // fails safe against deletion but PREVENTS UNINSTALL, which is its own failure mode.
  const recordedHooks = snapshot.installedValues?.hooks;
  const expectedHooks = Array.isArray(recordedHooks) ? recordedHooks : expectedManagedInnerHooks(managed);
  const preserved: PreservedFile[] = [];
  const protectedRuntimePaths: string[] = [];
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
        const markedHooks = innerHooks.filter(isManagedInnerHook);
        const removableMarked = premerge
          ? markedHooks
          : markedHooks.filter((hook) => expectedHooks.some((expected) => valuesByteIdentical(hook, expected)));
        const retainedMarked = markedHooks.filter((hook) => !removableMarked.includes(hook));
        if (!premerge && retainedMarked.length > 0) {
          preserved.push({ relPath: `${path.basename(settingsPath)}#hooks`, absPath: settingsPath, reason: `marker-matching but not byte-identical to this install's value; cannot prove Flow Agents authored it (${snapshot.provenanceReason})` });
        }
        const keptInner = innerHooks.filter((hook) => !removableMarked.includes(hook));
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
    // A marker is not exclusive ownership. When the earliest baseline itself
    // contains marker-matching hooks, put those exact user entries back after
    // removing the installed image. Retaining the current groups would both
    // lose the user's command and leave the harness wired.
    if (premerge && snapshotHasManagedHook(premerge, isManagedInnerHook)) {
      for (const [event, groups] of Object.entries(originManagedHookGroups(premerge, isManagedInnerHook))) {
        nextHooks[event] = [...((nextHooks[event] as unknown[]) ?? []), ...groups];
      }
      preserved.push({ relPath: `${path.basename(settingsPath)}#hooks`, absPath: settingsPath, reason: "pre-install snapshot contains marker-matching hooks; restored exact prior entries" });
    }
  }
  let removedStatusLine = false;
  const statusLine = existing["statusLine"];
  if (config.removeStatusLine && typeof statusLine === "object" && statusLine !== null
    && (statusLine as Record<string, unknown>)["type"] === "command"
    && typeof (statusLine as Record<string, unknown>)["command"] === "string"
    && ((statusLine as Record<string, unknown>)["command"] as string).includes(STATUSLINE_MARKER)) {
    if (premerge && Object.prototype.hasOwnProperty.call(premerge.parsed, "statusLine")) {
      next["statusLine"] = premerge.parsed["statusLine"];
      preserved.push({ relPath: `${path.basename(settingsPath)}#statusLine`, absPath: settingsPath, reason: "pre-install snapshot shows a statusLine; restored its prior value" });
    } else if (premerge) { delete next["statusLine"]; removedStatusLine = true; }
    else if (valuesByteIdentical(statusLine, snapshot.installedValues?.statusLine ?? managed["statusLine"])) { delete next["statusLine"]; removedStatusLine = true; }
    else preserved.push({ relPath: `${path.basename(settingsPath)}#statusLine`, absPath: settingsPath, reason: `marker-matching but not byte-identical to this install's value; cannot prove Flow Agents authored it (${snapshot.provenanceReason})` });
  }
  let removedInstructions = false;
  if (config.removeInstructionsPath && Array.isArray(existing["instructions"])) {
    const instructionPath = config.removeInstructionsPath(dest);
    const kept = (existing["instructions"] as unknown[]).filter((entry) => entry !== instructionPath);
    if (premerge && Array.isArray(premerge.parsed["instructions"]) && (premerge.parsed["instructions"] as unknown[]).includes(instructionPath)) {
      next["instructions"] = [...kept, ...(premerge.parsed["instructions"] as unknown[]).filter((entry) => entry === instructionPath)];
      preserved.push({ relPath: `${path.basename(settingsPath)}#instructions`, absPath: settingsPath, reason: "pre-install snapshot shows the runtime instruction; restored its prior entry" });
    } else {
    for (const entry of kept) {
      if (typeof entry !== "string") continue;
      // Exact string match is ownership. A lexical variant that resolves to the managed
      // instruction is user drift: retain and name it, then protect the referenced runtime
      // file from the otherwise independent manifest cleanup.
      if (path.resolve(entry) === path.resolve(instructionPath)) {
        preserved.push({ relPath: `${path.basename(settingsPath)}#instructions`, absPath: settingsPath, reason: "managed OpenCode instruction was edited; retained and its referenced runtime file is preserved" });
        protectedRuntimePaths.push(instructionPath);
      }
    }
    if (kept.length !== (existing["instructions"] as unknown[]).length) {
      removedInstructions = true;
      if (kept.length > 0) next["instructions"] = kept;
      else delete next["instructions"];
    }
    }
  }
  let removedOwnedValue = false;
  for (const [key, value] of Object.entries(config.removeOwnedValues ?? {})) {
    if (JSON.stringify(getPath(existing, key)) === JSON.stringify(value)) {
      const provenance = scalarRemovalProvenance(snapshot, key);
      if (provenance.introduced) {
        deletePath(next, key);
        removedOwnedValue = true;
      } else {
        preserved.push({ relPath: `${path.basename(settingsPath)}#${key}`, absPath: settingsPath, reason: provenance.reason });
      }
    } else if (getPath(existing, key) !== undefined) {
      preserved.push({ relPath: `${path.basename(settingsPath)}#${key}`, absPath: settingsPath, reason: "managed OpenCode setting was modified; retained" });
    }
  }
  const changed = removedHookEntryCount > 0 || removedStatusLine || removedInstructions || removedOwnedValue;
  if (!changed) {
    return { settingsPath, exists: true, removedHookEntryCount: 0, removedEventKeys: [], removedStatusLine: false, action: "none", nextContent: null, preserved, protectedRuntimePaths };
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
  return { settingsPath, exists: true, removedHookEntryCount, removedEventKeys, removedStatusLine, action, nextContent: next, preserved, protectedRuntimePaths };
}

function validateConfigPremerge(value: unknown, runtime: UninstallRuntime, configPath: string): { premerge?: ConfigPremergeSnapshot; reason: string } {
  let premerge = value as Record<string, unknown> | undefined;
  // v1 records emitted before snapshot-local identity deliberately relied on
  // their enclosing install record and target config. Infer only absent fields;
  // explicitly inconsistent fields still fail closed below.
  if (premerge?.["schema_version"] === "1.0") premerge = { ...premerge, ...(premerge["runtime"] === undefined ? { runtime } : {}), ...(premerge["config_path"] === undefined ? { config_path: path.resolve(configPath) } : {}) };
  if (!premerge || premerge["schema_version"] !== "1.0" || typeof premerge["existed"] !== "boolean" || typeof premerge["bytes_base64"] !== "string" || typeof premerge["post_install_sha256"] !== "string" || !/^[a-f0-9]{64}$/i.test(premerge["post_install_sha256"] as string) || typeof premerge["config_path"] !== "string" || premerge["runtime"] !== runtime || typeof premerge["parsed"] !== "object" || premerge["parsed"] === null || Array.isArray(premerge["parsed"])) return { reason: "snapshot is malformed or incomplete" };
  if (path.resolve(premerge["config_path"] as string) !== path.resolve(configPath)) return { reason: "snapshot config path does not match this uninstall" };
  if (premerge["existed"] === false) {
    if (premerge["bytes_base64"] !== "" || Object.keys(premerge["parsed"] as Record<string, unknown>).length > 0) return { reason: "snapshot claims the config did not exist but carries prior content" };
    return { premerge: premerge as ConfigPremergeSnapshot, reason: "" };
  }
  try {
    const bytes = Buffer.from(premerge["bytes_base64"] as string, "base64");
    if (bytes.toString("base64") !== premerge["bytes_base64"] || JSON.stringify(JSON.parse(bytes.toString("utf8"))) !== JSON.stringify(premerge["parsed"])) return { reason: "snapshot bytes do not match its parsed value" };
    return { premerge: premerge as ConfigPremergeSnapshot, reason: "" };
  } catch { return { reason: "snapshot is unreadable" }; }
}

function readConfigPremerge(dest: string, runtime: UninstallRuntime, configPath: string): PremergeRead {
  const none = (reason: string, installedValues?: PremergeRead["installedValues"]): PremergeRead => ({ provenanceReason: reason, restoreReason: reason, hasPreviousRecord: false, installedValues });
  try {
    const record = JSON.parse(fs.readFileSync(path.join(durableFlowAgentsRoot(dest), "install.json"), "utf8")) as Record<string, unknown>;
    const premerge = record["config_premerge"] as Record<string, unknown> | undefined;
    const installed = record["installed_values"] as Record<string, unknown> | undefined;
    const rawInstalledValues = installed?.[path.resolve(configPath)];
    const installedValues = rawInstalledValues && typeof rawInstalledValues === "object" && !Array.isArray(rawInstalledValues)
      ? rawInstalledValues as { hooks?: unknown[]; statusLine?: unknown; instructions?: unknown[] }
      : undefined;
    if (!premerge) return none("no pre-install snapshot", installedValues);
    if (record["runtime"] !== runtime) return none("snapshot runtime does not match this uninstall", installedValues);
    // v1 records carry no snapshot-local identity, so the config they describe is inferred from
    // the enclosing record's own scope. Identity is the resolved FILE, not the invocation flags:
    // `--global --dest X` and `--dest X` can name the same file, while a genuinely global record
    // must never become a *different* (project) config's origin -- accepting it would let a key
    // the global config never had authorize deleting the user's project value.
    if (premerge["schema_version"] === "1.0" && premerge["config_path"] === undefined) {
      const recordedConfigPath = RUNTIME_CONFIGS[runtime].configPath(dest, Boolean(record["global"]));
      if (path.resolve(recordedConfigPath) !== path.resolve(configPath)) {
        return none("snapshot describes a different config than this uninstall", installedValues);
      }
    }
    // v1 intentionally remains compatible: its single snapshot was previously used for both.
    if (premerge["schema_version"] === "1.0") {
      const validated = validateConfigPremerge(premerge, runtime, configPath);
      return { origin: validated.premerge, previous: validated.premerge, provenanceReason: validated.reason, restoreReason: validated.reason, hasPreviousRecord: true, installedValues };
    }
    if (premerge["schema_version"] !== "2.0") return none("pre-install snapshot has an unsupported schema version");
    const origin = validateConfigPremerge(premerge["origin"], runtime, configPath);
    const previous = validateConfigPremerge(premerge["previous"], runtime, configPath);
    return { origin: origin.premerge, previous: previous.premerge, provenanceReason: origin.reason, restoreReason: previous.reason, hasPreviousRecord: true, installedValues };
  } catch { return none("pre-install snapshot is unreadable");
  }
}

function applySettings(dest: string, global: boolean, config: RuntimeConfig, isManagedInnerHook: (hook: unknown) => boolean, opencodeBinding?: OpenCodeConfigBinding): { backupPath: string | null; preserved?: PreservedFile } {
  // Deliberately re-plan after confirmation. Config is user-owned and a hook or setting can
  // arrive while confirmation is pending; applying the stale object would silently erase it.
  // For OpenCode, bind its authorized canonical target BEFORE the read/plan so the object
  // inspected and the object rewritten are the same file even if the visible link is raced.
  const binding = config.runtime === "opencode" ? opencodeBinding : undefined;
  const snapshot = readConfigPremerge(dest, config.runtime, binding?.canonicalPath ?? config.configPath(dest, global));
  const plan = planSettings(dest, global, config, isManagedInnerHook, snapshot, binding?.canonicalPath);
  if (plan.action === "none") return { backupPath: null };
  const writePath = binding?.canonicalPath ?? plan.settingsPath;
  // The binding check is immediately adjacent to the write: for Stow, write the canonical
  // backing file and keep the host-visible link intact.
  if (binding) revalidateOpenCodeConfigBinding(binding);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${writePath}.bak-uninstall-${ts}`;
  let tmp: string | undefined;
  try {
    fs.copyFileSync(writePath, backupPath);
    const currentBytes = fs.readFileSync(writePath);
    const originalBytes = loadInstallMergeModule().restoreConfigPremergeBytes(snapshot.previous, plan.nextContent, currentBytes);
    // Test-only fault seam: exercise the failure path after applyPlan's pre-apply check and
    // after this attempt has created its backup, without a nondeterministic background race.
    const testSwapPath = process.env["FLOW_AGENTS_UNINSTALL_TEST_APPLY_SETTINGS_SYMLINK_SWAP_PATH"];
    const testSwapTarget = process.env["FLOW_AGENTS_UNINSTALL_TEST_APPLY_SETTINGS_SYMLINK_SWAP_TARGET"];
    if (testSwapPath && testSwapTarget) {
      fs.rmSync(testSwapPath, { recursive: true, force: true });
      fs.symlinkSync(testSwapTarget, testSwapPath);
    }
    // Deleting the config is also a write through the backing link, so it gets the same late
    // binding check as the replacement path.
    if (plan.action === "delete" && !originalBytes) {
      if (binding) revalidateOpenCodeConfigBinding(binding);
      fs.rmSync(writePath);
      return { backupPath };
    }
    tmp = `${writePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, originalBytes ?? `${JSON.stringify(plan.nextContent, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: fs.statSync(writePath).mode & 0o777 });
    if (binding) revalidateOpenCodeConfigBinding(binding);
    fs.renameSync(tmp, writePath);
    return {
      backupPath,
      ...((snapshot.previous || snapshot.hasPreviousRecord) && !originalBytes
        ? { preserved: { relPath: path.basename(plan.settingsPath), absPath: plan.settingsPath, reason: snapshot.previous ? "config content drifted since install; retained surgical result but exact pre-install bytes could not be restored" : `previous-install snapshot is invalid (${snapshot.restoreReason}); retained surgical result but exact pre-install bytes could not be restored` } }
        : {}),
    };
  } catch (error) {
    // A failed backing-link revalidation must be transactional: no temporary or backup artifact
    // from this attempt may remain in either the original or a newly re-pointed backing root.
    if (tmp) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* retain the original failure */ }
    }
    try { fs.rmSync(backupPath, { force: true }); } catch { /* retain the original failure */ }
    throw error;
  }
}

// ─── Manifest-backed removal ────────────────────────────────────────────────────────────────

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readRecordedBackingRoots(dest: string): string[] {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(durableFlowAgentsRoot(dest), "install.json"), "utf8")) as Record<string, unknown>;
    const roots = record["authorized_backing_roots"];
    if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) return [];
    // A record only remains trustworthy while each stored canonical root still resolves to
    // itself. This rejects an install-time backing directory later replaced by a symlink.
    return roots.filter((root) => {
      try { return fs.realpathSync(root) === root; } catch { return false; }
    });
  } catch {
    return [];
  }
}

/** Resolve before reading, and only follow a Stow link explicitly authorized at install time. */
function validateOperatorBackingRoots(values: string[]): string[] {
  return [...new Set(values.map((value) => {
    if (!path.isAbsolute(value)) throw new Error(`--authorize-backing-root must be the resolved real absolute path, got: ${value}`);
    let real: string;
    try { real = fs.realpathSync(value); } catch { throw new Error(`--authorize-backing-root does not resolve to an existing root: ${value}`); }
    if (value !== real) throw new Error(`--authorize-backing-root must be the resolved real path (not a symlink or lexical alias): ${value}; use: ${real}`);
    if (!fs.statSync(real).isDirectory()) throw new Error(`--authorize-backing-root is not a directory: ${real}`);
    return real;
  }))];
}

/** Resolve before reading, accepting only a recorded root or an invocation-scoped exact match. */
function resolveAuthorizedOpenCodeUninstallBinding(dest: string, global: boolean, operatorRoots: string[]): { binding: OpenCodeConfigBinding; operatorAuthorizedRoots: string[] } {
  const visiblePath = RUNTIME_CONFIGS.opencode.configPath(dest, global);
  const binding = resolveOpenCodeConfigBinding(visiblePath);
  if (!binding.wasSymlink) {
    if (operatorRoots.length > 0) throw new Error(`--authorize-backing-root was supplied, but this install does not reference a symlinked OpenCode backing root: ${operatorRoots.join(", ")}`);
    return { binding, operatorAuthorizedRoots: [] };
  }
  const currentRoot = binding.trustedSymlinkRoot ? fs.realpathSync(binding.trustedSymlinkRoot) : undefined;
  if (!currentRoot) throw new Error(`OpenCode config symlink has no resolvable backing root: ${visiblePath}`);
  const matchingOperatorRoots = operatorRoots.filter((root) => root === currentRoot);
  const unreferencedOperatorRoots = operatorRoots.filter((root) => root !== currentRoot);
  if (unreferencedOperatorRoots.length > 0) {
    throw new Error(`--authorize-backing-root does not match a backing root currently referenced by this install: ${unreferencedOperatorRoots.join(", ")}`);
  }
  if (!readRecordedBackingRoots(dest).includes(currentRoot) && matchingOperatorRoots.length === 0) {
    throw new Error(`OpenCode config backing root was not authorized by this install record; refusing to follow symlink: ${visiblePath}. To authorize this invocation only, pass --authorize-backing-root ${currentRoot}`);
  }
  return { binding, operatorAuthorizedRoots: matchingOperatorRoots };
}

/** Re-check the exact plan binding and its invocation-scoped authorization before any mutation. */
function revalidateAuthorizedOpenCodeUninstallBinding(binding: OpenCodeConfigBinding | undefined, operatorRoots: string[]): void {
  if (!binding) return;
  revalidateOpenCodeConfigBinding(binding);
  if (binding.wasSymlink && operatorRoots.length > 0) {
    const currentRoot = binding.trustedSymlinkRoot ? fs.realpathSync(binding.trustedSymlinkRoot) : undefined;
    if (!currentRoot || !operatorRoots.includes(currentRoot)) {
      throw new Error(`OpenCode config backing root changed before write; refusing to follow symlink: ${binding.visiblePath}`);
    }
  }
}

/**
 * Resolve a manifest path through the one Stow shape the OpenCode installer explicitly
 * authorizes: a direct plugins/, agents/, or skills/ child link whose target is exactly the
 * corresponding child of the private backing root of the bound opencode.json link. All other
 * links remain hostile.
 */
function resolveManifestPathWithBackingRoot(dest: string, relPath: string, backingRoot?: string): { absPath: string; root: string } {
  const lexical = resolveManifestEntryPath(dest, relPath);
  const [first, ...rest] = relPath.split("/");
  const visibleChild = path.join(dest, first);
  let stat: fs.Stats | undefined;
  try { stat = fs.lstatSync(visibleChild); } catch { /* absent child uses ordinary root */ }
  if (!stat?.isSymbolicLink()) return { absPath: lexical, root: dest };
  // For ordinary roots, defer the containment refusal until after the harmless lstat below:
  // missing stale manifest entries need no removal plan, while a present one is rejected by
  // assertManifestEntryParentContained with that exact entry named in the diagnostic.
  if (!backingRoot) return { absPath: lexical, root: dest };
  if (!["plugins", "agents", "skills"].includes(first)) {
    throw new ManifestContainmentViolationError(`owned-files.json manifest entry "${relPath}" escapes the install root through a symlinked parent directory`);
  }
  const target = fs.realpathSync(visibleChild);
  const expectedTarget = path.join(backingRoot, first);
  if (!fs.statSync(target).isDirectory() || target !== expectedTarget) {
    throw new ManifestContainmentViolationError(`owned-files.json manifest entry "${relPath}" uses a symlink target other than the authorized OpenCode asset tree: expected ${expectedTarget}`);
  }
  return { absPath: path.join(target, ...rest), root: target };
}

function planFromManifest(dest: string, manifest: OwnedFilesManifest, label = "", backingRoot?: string): { removeFiles: RemovableFile[]; preserved: PreservedFile[] } {
  const removeFiles: RemovableFile[] = [];
  const preserved: PreservedFile[] = [];
  for (const entry of manifest.files) {
    // Fail closed on the FIRST unsafe/malformed entry: a manifest is not a trusted input (it can
    // be hand-edited, corrupted, or -- for project-scoped installs -- committed to a shared repo
    // and edited by anyone with write access), so it is treated as untrustworthy as a whole
    // rather than partially honored. Nothing has been deleted yet at this point (buildPlan is
    // pure/read-only), so this throw aborts the whole run before any mutation.
    const manifestPath = (entry as { path?: unknown }).path;
    // Keep lexical validation separate from backing-root resolution so malformed manifest
    // paths still fail closed before any filesystem lookup.
    resolveManifestEntryPath(dest, manifestPath);
    const { absPath, root: entryRoot } = resolveManifestPathWithBackingRoot(dest, String(manifestPath), backingRoot);
    const expectedSha256 = resolveManifestEntrySha256(String((entry as { path?: unknown }).path), (entry as { sha256?: unknown }).sha256);
    const relPath = entry.path;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absPath);
    } catch {
      continue; // already gone
    }
    // Second, filesystem-real containment. An absent entry needs no removal plan, but a
    // present entry must never be planned through an intermediate symlink outside its root.
    // This order keeps the refusal diagnostic tied to the actual present manifest entry.
    assertManifestEntryParentContained(entryRoot, absPath, relPath);
    if (stat.isSymbolicLink()) {
      preserved.push({ relPath, absPath, reason: "manifest entry is now a symlink; refusing to remove" });
      continue;
    }
    if (!stat.isFile()) {
      preserved.push({ relPath, absPath, reason: "manifest entry is no longer a regular file" });
      continue;
    }
    if (hashFile(absPath) === expectedSha256) {
      removeFiles.push({ relPath: `${label}${relPath}`, absPath, root: entryRoot, reason: "ownership manifest: content unmodified since install", expectedSha256 });
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

// Manifest stamp names are derived from runtime configuration so a newly added runtime cannot
// accidentally leave its ownership record behind (or reintroduce a second hand-maintained list).
const DURABLE_ARTIFACT_FILES = ["install.json", "skills-manifest.json", "registry-latest.json", ...new Set(Object.values(RUNTIME_CONFIGS).map((config) => config.manifestName))];

function planDurableArtifacts(dest: string, runtime: UninstallRuntime): { removeDurable: DurableFile[]; note?: string } {
  const durableRoot = durableFlowAgentsRoot(dest);
  const installRecordPath = path.join(durableRoot, "install.json");
  if (fs.existsSync(installRecordPath)) {
    try {
      const record = JSON.parse(fs.readFileSync(installRecordPath, "utf8")) as Record<string, unknown>;
      if (record["runtime"] !== undefined && record["runtime"] !== runtime) {
        return { removeDurable: [], note: `${installRecordPath}: durable install record belongs to runtime '${String(record["runtime"])}', not ${runtime}; leaving all .flow-agents/* durable artifacts in place` };
      }
    } catch {
      // Unreadable install.json: fall through and still offer to remove the known durable
      // names below -- they are self-evidently Flow Agents' own namespaced files regardless.
    }
  }
  const removeDurable: DurableFile[] = [];
  for (const name of DURABLE_ARTIFACT_FILES) {
    const file = path.join(durableRoot, name);
    if (!fs.existsSync(file)) continue;
    // Stamps are user-visible durable files, not a license to recurse through their parent.
    // Capture their hash now and re-check it at apply just like every owned payload file.
    assertManifestEntryParentContained(dest, file, `.flow-agents/${name}`);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    removeDurable.push({ path: file, relPath: `.flow-agents/${name}`, root: dest, expectedSha256: hashFile(file), reason: "flow-agents durable install artifact" });
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
  // Runtime telemetry is deliberately outside the ownership manifest: a runtime can continue
  // to hold its historical evidence after uninstall. Report the surviving in-destination tree
  // explicitly so the report never implies that `.flow-agents/runtime` was fully cleaned.
  const runtimeTelemetry = path.join(dest, ".flow-agents", "runtime", ".kontourai", "telemetry");
  if (fs.existsSync(runtimeTelemetry)) {
    let fileCount = 0;
    const countFiles = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) countFiles(child);
        else if (entry.isFile() || entry.isSymbolicLink()) fileCount += 1;
      }
    };
    countFiles(runtimeTelemetry);
    residue.push({ path: runtimeTelemetry, note: `runtime telemetry data (${fileCount} file${fileCount === 1 ? "" : "s"}); never removed by uninstall` });
  }
  return residue;
}

// ─── Plan assembly ──────────────────────────────────────────────────────────────────────────

function buildPlan(dest: string, global: boolean, runtime: UninstallRuntime, operatorRoots: string[]): UninstallPlan {
  const config = RUNTIME_CONFIGS[runtime];
  const { isManagedInnerHook } = loadInstallMergeModule();
  // Resolve the canonical OpenCode file before reading it. This makes planning use the same
  // authorized target that applySettings will bind and revalidate before writing.
  const opencodeAuthorization = runtime === "opencode" ? resolveAuthorizedOpenCodeUninstallBinding(dest, global, operatorRoots) : undefined;
  const opencodeBinding = opencodeAuthorization?.binding;
  const settings = planSettings(dest, global, config, isManagedInnerHook, readConfigPremerge(dest, runtime, opencodeBinding?.canonicalPath ?? config.configPath(dest, global)), opencodeBinding?.canonicalPath);

  const manifest = readOwnedFilesManifest(dest, config.manifestName);
  let mode: UninstallPlan["mode"];
  let removeFiles: RemovableFile[] = [];
  let removeSymlinks: RemovableSymlink[] = [];
  let preserved: PreservedFile[] = [];
  preserved.push(...settings.preserved);
  const extraDurable: DurableFile[] = [];
  if (manifest) {
    mode = "manifest";
    // Validated entry-by-entry inside planFromManifest -- throws (aborting before any deletion)
    // on the first unsafe or malformed entry rather than skipping it and continuing.
    const backingRoot = opencodeBinding?.trustedSymlinkRoot;
    const result = planFromManifest(dest, manifest, "", backingRoot);
    removeFiles = result.removeFiles;
    preserved = result.preserved;
    preserved.push(...settings.preserved);
    if (settings.protectedRuntimePaths.length > 0) {
      const protectedPaths = new Set(settings.protectedRuntimePaths.map((entry) => path.resolve(entry)));
      const protectedFiles = removeFiles.filter((entry) => protectedPaths.has(path.resolve(entry.absPath)));
      removeFiles = removeFiles.filter((entry) => !protectedPaths.has(path.resolve(entry.absPath)));
      preserved.push(...protectedFiles.map((entry) => ({ relPath: entry.relPath, absPath: entry.absPath, reason: "retained drifted OpenCode instruction still references this runtime file" })));
    }
    for (const extra of config.additionalManifestRoots?.() ?? []) {
      const extraManifest = readOwnedFilesManifest(extra.dest, extra.manifestName);
      if (!extraManifest) {
        throw new Error(`${runtime} uninstall requires its ownership manifest (${path.join(durableFlowAgentsRoot(extra.dest), extra.manifestName)}); refusing manifest-less inference`);
      }
      const extraResult = planFromManifest(extra.dest, extraManifest, `${extra.label}/`);
      removeFiles.push(...extraResult.removeFiles);
      preserved.push(...extraResult.preserved.map((entry) => ({ ...entry, relPath: `${extra.label}/${entry.relPath}` })));
      const extraStamp = path.join(durableFlowAgentsRoot(extra.dest), extra.manifestName);
      assertManifestEntryParentContained(extra.dest, extraStamp, `.flow-agents/${extra.manifestName}`);
      extraDurable.push({ path: extraStamp, relPath: `${extra.label}/.flow-agents/${extra.manifestName}`, root: extra.dest, expectedSha256: hashFile(extraStamp), reason: "flow-agents durable install artifact" });
    }
  } else if (runtime === "claude-code") {
    const bundle = ensureBundle("claude-code");
    const result = planLegacy(bundle, dest, global);
    removeFiles = result.removeFiles;
    removeSymlinks = result.removeSymlinks;
    preserved = result.preserved;
    preserved.push(...settings.preserved);
    mode = removeFiles.length > 0 || removeSymlinks.length > 0 || preserved.length > 0 ? "legacy" : "none";
  } else {
    const expectedManifest = path.join(durableFlowAgentsRoot(dest), config.manifestName);
    throw new Error(`${runtime} uninstall requires its ownership manifest (${expectedManifest}); refusing manifest-less inference`);
  }

  const { removeDurable } = planDurableArtifacts(dest, runtime);
  removeDurable.push(...extraDurable);
  const residue = planResidue(dest, global);

  return { runtime, dest, global, settings, mode, removeFiles, removeSymlinks, preserved, removeDurable, residue, opencodeBinding, operatorAuthorizedBackingRoots: opencodeAuthorization?.operatorAuthorizedRoots ?? [] };
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

type ApplyOutcome = {
  settingsBackupPath: string | null;
  removedFiles: RemovableFile[];
  removedSymlinks: RemovableSymlink[];
  removedDurable: DurableFile[];
  failed: RemovalFailure[];
  preservedAtApply: PreservedFile[];
};

/**
 * The only mutating step. Settings are applied before every irreversible asset or durable
 * manifest deletion. A settings failure therefore aborts the remaining apply; in particular a
 * backing-link validation failure leaves runtime assets and durable manifests untouched.
 * After settings succeeds, every removal (each file, each symlink chain, each durable artifact)
 * is individually try/caught so one failure never hides the accounting of everything that
 * happened before or after it. Re-verifies each file/symlink
 * chain's content immediately before removing it (closing the plan/confirm/apply TOCTOU window):
 * anything that no longer matches what `buildPlan()` observed is preserved, not deleted.
 */
function applyPlan(plan: UninstallPlan): ApplyOutcome {
  // This is deliberately before the first settings backup, file removal, or durable-stamp
  // deletion: a re-pointed operator-authorized link aborts the whole apply with zero writes.
  revalidateAuthorizedOpenCodeUninstallBinding(plan.opencodeBinding, plan.operatorAuthorizedBackingRoots);
  const failed: RemovalFailure[] = [];
  const preservedAtApply: PreservedFile[] = [];
  const removedFiles: RemovableFile[] = [];
  const removedSymlinks: RemovableSymlink[] = [];
  const removedDurable: DurableFile[] = [];

  let settingsBackupPath: string | null = null;
  try {
    const settingsOutcome = applySettings(plan.dest, plan.global, RUNTIME_CONFIGS[plan.runtime], loadInstallMergeModule().isManagedInnerHook, plan.opencodeBinding);
    settingsBackupPath = settingsOutcome.backupPath;
    if (settingsOutcome.preserved) preservedAtApply.push(settingsOutcome.preserved);
  } catch (error) {
    failed.push({ relPath: plan.settings.settingsPath, absPath: plan.settings.settingsPath, reason: `settings update failed: ${(error as Error).message}` });
    return { settingsBackupPath, removedFiles, removedSymlinks, removedDurable, failed, preservedAtApply };
  }

  const removedParents = new Set<string>();
  for (const entry of plan.removeFiles) {
    try {
      if (!fs.existsSync(entry.absPath)) continue; // already gone -- nothing to do, not a failure
      // Re-verify real (symlink-resolved) parent containment immediately before touching
      // anything, same TOCTOU class as the hash re-check below: an intermediate directory could
      // have been swapped for a symlink pointing outside dest during the window between planning
      // and confirmation. Preserve, don't delete, and don't abort the rest of the run -- unlike
      // the plan-time check (which aborts everything before any deletion has happened), apply is
      // already mid-run, so treating this the same as any other "changed since planning" case
      // keeps the report accurate without turning one suspicious entry into a hard stop for
      // items already confirmed safe.
      let containmentOk = true;
      let containmentPreserveReason: string | undefined;
      try {
        assertManifestEntryParentContained(entry.root ?? plan.dest, entry.absPath, entry.relPath);
      } catch (error) {
        containmentOk = false;
        // Distinguish a genuine containment violation (the function's own thrown error type)
        // from an unrelated filesystem error (e.g. ELOOP/EACCES resolving a component other than
        // a missing leaf, which the function re-throws verbatim) -- both are always fail-safe
        // (preserve, never delete), but the report should never claim "symlink escape" for what
        // was actually an I/O error.
        containmentPreserveReason = error instanceof ManifestContainmentViolationError
          ? "parent directory now resolves outside the install root through a symlink"
          : `could not verify parent directory containment: ${(error as Error).message}`;
      }
      if (!containmentOk) {
        preservedAtApply.push({ relPath: entry.relPath, absPath: entry.absPath, reason: `${containmentPreserveReason}; preserved (re-checked immediately before removal)` });
        continue;
      }
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
    // TOCTOU re-check, same class as the containment/hash re-checks above: if the symlink's
    // target was swapped between plan and apply (an attacker, or a coincidental race), the
    // removal below only ever touches the ORIGINALLY-resolved `entry.targetDir` (never re-
    // resolving the live symlink), so a swap alone cannot redirect what gets deleted -- but
    // proceeding to unlink+delete under a stale assumption is still wrong. Detect the swap and
    // preserve rather than silently acting on out-of-date information.
    let currentSymlinkStat: fs.Stats | undefined;
    try {
      currentSymlinkStat = fs.lstatSync(entry.symlinkPath);
    } catch {
      currentSymlinkStat = undefined;
    }
    if (currentSymlinkStat?.isSymbolicLink()) {
      let currentRealTarget: string | undefined;
      try {
        currentRealTarget = fs.realpathSync(entry.symlinkPath);
      } catch {
        currentRealTarget = undefined;
      }
      if (currentRealTarget !== undefined && path.resolve(currentRealTarget) !== path.resolve(entry.targetDir)) {
        preservedAtApply.push({ relPath: entry.relPath, absPath: entry.symlinkPath, reason: "symlink target changed since the plan was computed; preserved (re-checked immediately before removal)" });
        continue;
      }
    }
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
  pruneEmptyDirsSafely(plan.dest, removedParents);

  for (const entry of plan.removeDurable) {
    try {
      if (!fs.existsSync(entry.path)) continue;
      assertManifestEntryParentContained(entry.root, entry.path, entry.relPath);
      const stat = fs.lstatSync(entry.path);
      if (stat.isSymbolicLink() || !stat.isFile() || hashFile(entry.path) !== entry.expectedSha256) {
        preservedAtApply.push({ relPath: entry.relPath, absPath: entry.path, reason: "content changed since the plan was computed; preserved (re-checked immediately before removal)" });
        continue;
      }
      fs.rmSync(entry.path);
      removedDurable.push(entry);
      removedParents.add(path.dirname(entry.path));
    } catch (error) {
      failed.push({ relPath: entry.path, absPath: entry.path, reason: (error as Error).message });
    }
  }
  pruneEmptyDirsSafely(plan.dest, [...removedParents, durableFlowAgentsRoot(plan.dest)]);

  return { settingsBackupPath, removedFiles, removedSymlinks, removedDurable, failed, preservedAtApply };
}

/** Remove only empty, real directories whose live canonical path remains under root. */
function pruneEmptyDirsSafely(rootPath: string, starts: Iterable<string>): void {
  let rootReal: string;
  try { rootReal = fs.realpathSync(rootPath); } catch { return; }
  for (const start of starts) {
    let current = start;
    while (path.resolve(current) !== path.resolve(rootPath)) {
      try {
        assertManifestEntryParentContained(rootPath, current, path.relative(rootPath, current));
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory() || !pathIsWithin(rootReal, fs.realpathSync(current))) break;
        fs.rmdirSync(current);
        current = path.dirname(current);
      } catch {
        break;
      }
    }
  }
}

// ─── Reporting ──────────────────────────────────────────────────────────────────────────────

function printReport(plan: UninstallPlan, applied: boolean, outcome: ApplyOutcome, runtime: UninstallRuntime): void {
  const heading = applied ? `Flow Agents ${runtime} uninstall` : `Flow Agents ${runtime} uninstall (dry run — nothing changed)`;
  console.log(`${heading}`);
  console.log(`  target: ${plan.dest} (${plan.global ? "global" : "project-scoped"})`);
  console.log(`  ownership mode: ${plan.mode}`);
  if (plan.operatorAuthorizedBackingRoots.length > 0) {
    console.log("  operator-authorized backing roots (this invocation only):");
    for (const backingRoot of plan.operatorAuthorizedBackingRoots) {
      console.log(`    ${backingRoot}`);
      const paths = [plan.settings.settingsPath, ...plan.removeFiles.map((entry) => entry.absPath)].filter((entry) => pathIsWithin(backingRoot, entry));
      for (const writePath of paths) console.log(`      ${applied ? "wrote through" : "would write through"}: ${writePath}`);
    }
  }
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

  const durableEntries = applied ? outcome.removedDurable : plan.removeDurable;
  console.log(`Durable artifacts ${applied ? "removed" : "to remove"} (${durableEntries.length}):`);
  for (const entry of durableEntries) console.log(`  ${entry.path}`);
  if (durableEntries.length === 0) console.log("  (none)");
  console.log("");

  // Header intentionally still starts with "Residue" -- report sections are anchored by their
  // leading word (evals and any downstream parser match /^Residue/), so the coverage caveat goes
  // after it rather than in front of it.
  console.log(`Residue — explicitly retained (never removed by uninstall; covers known telemetry/coordination locations only, not every surviving path under the destination) (${plan.residue.length}):`);
  for (const entry of plan.residue) console.log(`  ${entry.path}  — ${entry.note}`);
  if (plan.residue.length === 0) console.log("  (none)");
  console.log("");

  console.log("The npm package itself is not removed. To finish, run:");
  console.log("  npm rm -g @kontourai/flow-agents");
}

function dryRunOutcome(plan: UninstallPlan): ApplyOutcome {
  return { settingsBackupPath: null, removedFiles: plan.removeFiles, removedSymlinks: plan.removeSymlinks, removedDurable: plan.removeDurable, failed: [], preservedAtApply: [] };
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
    if (runtime !== "claude-code" && runtime !== "codex" && runtime !== "opencode") {
      console.error(`flow-agents init --uninstall: --runtime must be claude-code, codex, or opencode (got: ${runtime ?? "(none)"})`);
      usage();
      return 2;
    }
    if (args.flags["authorize-backing-root"] === true) {
      console.error("flow-agents init --uninstall: --authorize-backing-root requires a path");
      return 2;
    }
    const operatorRoots = validateOperatorBackingRoots(flagList(args.flags, "authorize-backing-root"));
    if (operatorRoots.length > 0 && runtime !== "opencode") {
      console.error("flow-agents init --uninstall: --authorize-backing-root is only valid with --runtime opencode");
      return 2;
    }
    const isGlobal = flagBool(args.flags, "global");
    const destFlag = flagString(args.flags, "dest") ?? args.positionals[0];
    if (isGlobal && destFlag) {
      console.error("flow-agents init --uninstall: --global and an explicit destination are mutually exclusive");
      return 2;
    }
    if (!isGlobal && !destFlag && runtime === "claude-code") {
      console.error("flow-agents init --uninstall: provide --global or an explicit destination (--dest PATH, or a positional path)");
      return 2;
    }
    const dest = isGlobal || !destFlag ? globalDest(runtime) : path.resolve(destFlag);
    if (!fs.existsSync(dest)) {
      console.error(`flow-agents init --uninstall: nothing to uninstall (destination does not exist): ${dest}`);
      return 3;
    }

    const plan = buildPlan(dest, isGlobal || !destFlag, runtime, operatorRoots);
    const dryRun = flagBool(args.flags, "dry-run");

    if (planIsEmpty(plan)) {
      printReport(plan, false, dryRunOutcome(plan), runtime);
      console.error("flow-agents init --uninstall: nothing found to uninstall");
      return 3;
    }

    if (dryRun) {
      printReport(plan, false, dryRunOutcome(plan), runtime);
      return 0;
    }

    // TEST-ONLY hooks: simulate the filesystem changing during the plan/confirm/apply window
    // (e.g. the interactive confirmation prompt's stdin wait) so the apply-time TOCTOU
    // re-verification can be exercised deterministically without racing a real background
    // process. Never read outside this module's own eval fixtures; not part of the public CLI
    // surface.
    const toctouTestMutateFile = process.env["FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_MUTATE_FILE"];
    if (toctouTestMutateFile) {
      fs.appendFileSync(toctouTestMutateFile, "\nTOCTOU-test-mutation\n", "utf8");
    }
    const toctouAddHook = process.env["FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_ADD_USER_HOOK"];
    if (toctouAddHook) {
      const existing = JSON.parse(fs.readFileSync(toctouAddHook, "utf8")) as Record<string, unknown>;
      const hooks = (existing["hooks"] && typeof existing["hooks"] === "object" ? existing["hooks"] : {}) as Record<string, unknown>;
      const stop = Array.isArray(hooks["Stop"]) ? hooks["Stop"] : [];
      stop.push({ hooks: [{ type: "command", command: "echo user-hook-added-during-confirmation" }] });
      hooks["Stop"] = stop;
      existing["hooks"] = hooks;
      fs.writeFileSync(toctouAddHook, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
    }
    // Re-points an existing symlink, or replaces an existing directory with a new symlink, at
    // PATH to point at TARGET -- used to exercise both the removeSymlinks branch's live-target
    // re-check (re-pointing an already-planned symlink) and the manifest-mode apply-time
    // containment re-check (swapping a plain directory a plan already captured for a symlink
    // escaping dest) after planning but before removal.
    const toctouSymlinkSwapPath = process.env["FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_SYMLINK_SWAP_PATH"];
    const toctouSymlinkSwapTarget = process.env["FLOW_AGENTS_UNINSTALL_TEST_TOCTOU_SYMLINK_SWAP_TARGET"];
    if (toctouSymlinkSwapPath && toctouSymlinkSwapTarget) {
      fs.rmSync(toctouSymlinkSwapPath, { recursive: true, force: true });
      fs.symlinkSync(toctouSymlinkSwapTarget, toctouSymlinkSwapPath);
    }

    const confirmed = await confirmDestructive(dest, args.flags);
    if (!confirmed) {
      console.error("flow-agents init --uninstall: destructive removal was not confirmed (pass --yes or --headless to confirm non-interactively)");
      return 1;
    }

    const outcome = applyPlan(plan);
    printReport(plan, true, outcome, runtime);
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
