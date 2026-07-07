import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, flagBool, flagString } from "../lib/args.js";
import { skillsManifestPath } from "../lib/local-artifact-root.js";
import { root } from "../tools/common.js";
import { globalDest, ensureBundle } from "./init.js";

type DriftState = "in_sync" | "kit_updated" | "user_modified" | "unbaselined" | "missing_install" | "kit_removed";

type DriftFileEntry = {
  path: string;
  state: DriftState;
  installedHash: string | null;
  kitHash: string | null;
  manifestHash: string | null;
};

type DriftReport = {
  checkedAt: string;
  installedDir: string;
  kitSourceDir: string;
  manifestFound: boolean;
  files: DriftFileEntry[];
  summary: {
    total: number;
    inSync: number;
    kitUpdated: number;
    userModified: number;
    unbaselined: number;
    missingInstall: number;
    kitRemoved: number;
  };
  hasDrift: boolean;
};

type SkillDriftLib = {
  loadManifest: (manifestPath: string) => unknown;
  compareSkillDrift: (params: { installedDir: string; kitSourceDir: string; manifest: unknown }) => DriftReport;
};

const REFRESH_COMMAND_LINE =
  "Run `flow-agents init --runtime claude-code --global` to refresh drifted or missing skill copies " +
  "(user-modified files are reported here, not overwritten — review them before refreshing).";

function usage(): void {
  console.log(`usage: flow-agents skill-drift-check [options]

Read-only comparison of installed Claude Code skill files against the current
kit/bundle source and the last-recorded install manifest. Never writes under
the installed skills directory or the kit source directory.

Options:
  --dest PATH             Installed Claude Code global destination (contains
                           skills/ and .flow-agents/skills-manifest.json).
                           Defaults to the global claude-code destination
                           (honors FLOW_AGENTS_USER_CLAUDE_SETTINGS).
  --kit-source-dir PATH   Kit/bundle skills source directory to compare
                           against. Defaults to the current built bundle's
                           .claude/skills directory.
  --json                  Emit the machine-readable drift report as JSON.
  --help, -h              Show this help.

Exit codes:
  0   Clean — every checked file is in_sync, no unbaselined/missing entries.
  1   Drift found — at least one file is not in_sync (kit_updated,
      user_modified, unbaselined, missing_install, or kit_removed).
  2   Cannot fully check — no manifest exists yet, or <dest>/skills is
      missing. Reported with guidance, not a stack trace.
`);
}

function loadSkillDriftLib(): SkillDriftLib {
  const skillDriftLibPath = path.join(root, "scripts", "hooks", "lib", "skill-drift.js");
  const _require = createRequire(import.meta.url);
  return _require(skillDriftLibPath) as SkillDriftLib;
}

function printStatePaths(report: DriftReport, state: DriftState, label: string): void {
  const paths = report.files.filter((entry) => entry.state === state).map((entry) => entry.path);
  if (!paths.length) return;
  console.log(`  ${label}:`);
  for (const p of paths) console.log(`    - ${p}`);
}

function printReport(report: DriftReport): void {
  const s = report.summary;
  console.log(`Skill drift check: ${report.installedDir}`);
  console.log(`  kit source: ${report.kitSourceDir}`);
  console.log(`  manifest found: ${report.manifestFound ? "yes" : "no"}`);
  console.log(
    `  total ${s.total} — in_sync ${s.inSync}, kit_updated ${s.kitUpdated}, user_modified ${s.userModified}, ` +
      `unbaselined ${s.unbaselined}, missing_install ${s.missingInstall}, kit_removed ${s.kitRemoved}`
  );
  printStatePaths(report, "kit_updated", "kit_updated (installed matches last recorded baseline; kit source has changed)");
  printStatePaths(report, "user_modified", "user_modified (installed bytes changed locally since last recorded install)");
  printStatePaths(report, "unbaselined", "unbaselined (no recorded baseline for this file yet)");
  printStatePaths(report, "missing_install", "missing_install (present in kit source, not installed yet)");
  printStatePaths(report, "kit_removed", "kit_removed (installed file no longer present in current kit source)");
  if (report.hasDrift) {
    console.log("");
    console.log(REFRESH_COMMAND_LINE);
  } else {
    console.log("");
    console.log("All installed skill files are in sync with the current kit source.");
  }
  if (s.kitRemoved > 0) {
    console.log("");
    console.log(
      "kit_removed files were removed from the current kit source; refresh will NOT delete them " +
        "— review and remove them manually if appropriate."
    );
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Whole-body error containment (#439 review fix): any unexpected error (a bug in this CLI, a
  // filesystem error not already handled below, etc.) must never surface as a raw stack trace to
  // the user — print one stderr line and exit 2 ("cannot fully check"), same exit code already
  // used for the other known cannot-check conditions below.
  try {
    const args = parseArgs(argv);
    if (flagBool(args.flags, "help") || flagBool(args.flags, "h")) {
      usage();
      return 0;
    }

    const dest = path.resolve(flagString(args.flags, "dest") ?? globalDest("claude-code"));
    const installedDir = path.join(dest, "skills");

    let kitSourceDir: string;
    const kitSourceOverride = flagString(args.flags, "kit-source-dir");
    if (kitSourceOverride) {
      kitSourceDir = path.resolve(kitSourceOverride);
    } else {
      try {
        kitSourceDir = path.join(ensureBundle("claude-code"), ".claude", "skills");
      } catch (error) {
        console.error(`flow-agents skill-drift-check: could not resolve current kit source: ${(error as Error).message}`);
        console.error("Pass --kit-source-dir explicitly, or build the bundle first.");
        return 2;
      }
    }

    const { loadManifest, compareSkillDrift } = loadSkillDriftLib();
    const manifestPath = skillsManifestPath(dest);
    const manifest = loadManifest(manifestPath);
    const installedDirExists = fs.existsSync(installedDir);

    // Cannot fully check when there is no recorded baseline manifest at all yet, OR the installed
    // skills directory itself does not exist — reported explicitly with guidance, never silently
    // mis-reported as in_sync and never a stack trace (plan's exit-code-2 contract; see also the
    // "drifted-but-never-manifested install" stop-short risk).
    if (!manifest || !installedDirExists) {
      const reasons: string[] = [];
      if (!manifest) reasons.push(`no manifest found at ${manifestPath}`);
      if (!installedDirExists) reasons.push(`installed skills directory does not exist at ${installedDir}`);
      if (flagBool(args.flags, "json")) {
        console.log(JSON.stringify({ ok: false, reason: reasons.join("; "), manifestFound: Boolean(manifest), installedDirExists, manifestPath, installedDir, kitSourceDir }, null, 2));
      } else {
        console.error(`flow-agents skill-drift-check: cannot fully check — ${reasons.join("; ")}.`);
        console.error("Run this once to establish or refresh a baseline, then re-run skill-drift-check:");
        console.error(REFRESH_COMMAND_LINE);
      }
      return 2;
    }

    const report = compareSkillDrift({ installedDir, kitSourceDir, manifest });

    if (flagBool(args.flags, "json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }

    // Exit 1 iff any file is not in_sync — kit_updated, user_modified, unbaselined,
    // missing_install, and kit_removed are ALL drift (plan's five/six-state exit-code contract;
    // previously only kit_updated/user_modified tripped this, silently exiting 0 for
    // unbaselined/missing_install/kit_removed despite printing drift guidance).
    if (report.hasDrift) return 1;
    return 0;
  } catch (error) {
    console.error(`flow-agents skill-drift-check: unexpected error: ${(error as Error).message}`);
    return 2;
  }
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) {
  main().then((code) => { process.exitCode = code; }).catch((err) => { console.error(err); process.exitCode = 1; });
}
