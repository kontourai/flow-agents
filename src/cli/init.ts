import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseArgs, flagBool, flagList, flagString } from "../lib/args.js";
import { activateCodexLocal } from "../runtime-adapters.js";
import { main as buildBundles } from "../tools/build-universal-bundles.js";
import { root } from "../tools/common.js";
import { defaultCodexHome, durableInstallRecordPath, skillsManifestPath } from "../lib/local-artifact-root.js";

type Runtime = "base" | "codex" | "claude-code" | "kiro" | "opencode" | "pi";
type TelemetrySink = "local-files" | "local-kontour-console" | "kontour-hosted-console" | "user-hosted-console" | "kontour-cloud" | "hosted-kontour-console";

type InitOptions = {
  runtime: Runtime;
  dest: string;
  global?: boolean;
  consoleUrl?: string;
  consoleEndpoint?: string;
  consoleTokenFile?: string;
  consoleTokenValue?: string;
  consoleTenant?: string;
  telemetrySinks: TelemetrySink[];
  activateKits: boolean;
};

const runtimeBundles: Record<Runtime, string> = {
  base: "base",
  codex: "codex",
  "claude-code": "claude-code",
  kiro: "kiro",
  opencode: "opencode",
  pi: "pi",
};

// Stable marker present in every Flow Agents claude-code hook command.
// Used by scope-collision detection to identify an existing flow-agents install.
// Marker must be distinctive to Flow Agents generated settings. Sibling
// products from the same lineage ship identically named hook scripts such
// as claude-hook-adapter.js, so script filenames are NOT a safe marker.
export const COLLISION_MARKER = "Recording Flow Agents telemetry";

/**
 * Check whether a user-level Claude Code settings file already contains
 * Flow Agents hook commands. If it does, print a WARNING explaining that
 * Claude Code merges user-level and project-level settings and runs ALL
 * matching hooks, so having flow-agents in both places causes duplicate
 * hook execution (double telemetry, double policy enforcement).
 *
 * The check does NOT block the install; it is advisory only.
 *
 * @param userSettingsFile Path to inspect (defaults to $HOME/.claude/settings.json;
 *   overridable via FLOW_AGENTS_USER_CLAUDE_SETTINGS env var for testability).
 * @returns true if a collision was detected, false otherwise.
 */
export function checkScopeCollision(userSettingsFile?: string): boolean {
  const filePath = userSettingsFile
    ?? process.env["FLOW_AGENTS_USER_CLAUDE_SETTINGS"]
    ?? path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(filePath)) return false;
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  if (!text.includes(COLLISION_MARKER)) return false;
  console.warn(
    `\nWARNING: Flow Agents scope collision detected.\n` +
    `  ${filePath}\n` +
    `already contains Flow Agents hook commands (marker: ${COLLISION_MARKER}).\n` +
    `\n` +
    `Claude Code merges user-level (~/.claude/settings.json) and project-level\n` +
    `(.claude/settings.json) settings, then runs ALL matching hooks from both files.\n` +
    `Installing Flow Agents at the project level while it is also present at the\n` +
    `user level will cause duplicate hook execution: telemetry events are recorded\n` +
    `twice and policy hooks (workflow-steering, config-protection, quality-gate,\n` +
    `stop-goal-fit) run twice per event.\n` +
    `\n` +
    `To resolve:\n` +
    `  - Remove the hooks section from ${filePath} and rely solely on the\n` +
    `    project-level .claude/settings.json installed by flow-agents init, OR\n` +
    `  - Remove the project-level install and keep only the user-level one.\n` +
    `\n` +
    `The install will continue; resolve the collision before running Claude Code.\n`
  );
  return true;
}

function usage(): void {
  console.error(`usage: flow-agents init [options]

Options:
  --runtime base|codex|claude-code|kiro|opencode|pi
  --dest PATH
  --global              Target the runtime's global/user-level config path.
                        claude-code: merges FA hooks into ~/.claude/settings.json.
                          Honors FLOW_AGENTS_USER_CLAUDE_SETTINGS for test isolation.
                        opencode: merges opencode.json into ~/.config/opencode/opencode.json
                          (honors XDG_CONFIG_HOME; test isolation via FLOW_AGENTS_USER_OPENCODE_CONFIG).
                        codex: runs install-codex-home.sh into CODEX_HOME or ~/.codex
                          (hooks merged, not overwritten).
                        pi: NOT_VERIFIED (no documented global dir); warns and falls back to workspace default.
  --telemetry-sink local-files|local-kontour-console|kontour-hosted-console|user-hosted-console
  --console-url URL
  --console-endpoint URL
  --console-token-file PATH
  --console-tenant ID
  --activate-kits
  --yes, --headless
`);
}

function normalizeRuntime(value: string | undefined): Runtime | undefined {
  if (!value) return undefined;
  if (value === "claude") return "claude-code";
  if (value === "base" || value === "codex" || value === "claude-code" || value === "kiro" || value === "opencode" || value === "pi") return value;
  throw new Error(`unknown runtime '${value}'; expected base, codex, claude-code, kiro, opencode, or pi`);
}

function normalizeTelemetrySink(value: string): TelemetrySink {
  if (value === "local-files" || value === "local-kontour-console" || value === "kontour-hosted-console" || value === "user-hosted-console" || value === "kontour-cloud" || value === "hosted-kontour-console") return value;
  throw new Error(`unknown telemetry sink '${value}'`);
}

function telemetrySinksFromValues(values: string[]): TelemetrySink[] {
  const sinks = values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean).map(normalizeTelemetrySink);
  return sinks.length ? Array.from(new Set(sinks)) : ["local-files"];
}

function telemetrySinksFromFlags(flags: ReturnType<typeof parseArgs>["flags"]): TelemetrySink[] {
  return telemetrySinksFromValues(flagList(flags, "telemetry-sink").concat(flagList(flags, "telemetry-sinks")));
}

function needsConsoleCredentials(sinks: TelemetrySink[]): boolean {
  return sinks.some((sink) => sink !== "local-files");
}

async function questionHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  return await new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const onData = (buffer: Buffer) => {
      const text = buffer.toString("utf8");
      if (text === "") {
        stdout.write("\n");
        process.exit(130);
      }
      if (text === "\r" || text === "\n") {
        stdout.write("\n");
        stdin.setRawMode(wasRaw);
        stdin.off("data", onData);
        resolve(value);
        return;
      }
      if (text === "") {
        value = value.slice(0, -1);
        return;
      }
      value += text;
    };
    stdin.on("data", onData);
  });
}

function defaultDest(runtime: Runtime): string {
  if (runtime === "kiro") return path.join(os.homedir(), ".flow-agents");
  return process.cwd();
}

export function globalDest(runtime: Runtime): string {
  if (runtime === "claude-code") {
    // Honor FLOW_AGENTS_USER_CLAUDE_SETTINGS for test isolation (same as checkScopeCollision).
    const override = process.env["FLOW_AGENTS_USER_CLAUDE_SETTINGS"];
    if (override) return path.dirname(override);
    return path.join(os.homedir(), ".claude");
  }
  if (runtime === "opencode") {
    // Honor FLOW_AGENTS_USER_OPENCODE_CONFIG (points to the opencode.json FILE) for test isolation,
    // mirroring FLOW_AGENTS_USER_CLAUDE_SETTINGS for claude-code.
    const override = process.env["FLOW_AGENTS_USER_OPENCODE_CONFIG"];
    if (override) return path.dirname(override);
    // Global opencode config: ~/.config/opencode/ (honor XDG_CONFIG_HOME when set, else ~/.config).
    return path.join(process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"), "opencode");
  }
  if (runtime === "codex") {
    // codex --global routes to the standard Codex home. --dest remains an explicit override.
    return defaultCodexHome();
  }
  if (runtime === "pi") {
    // pi has no documented global config dir.
    // NOT_VERIFIED: fall back to workspace default and warn caller.
    return defaultDest(runtime);
  }
  return defaultDest(runtime);
}

function parseYesNo(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["y", "yes", "true", "1"].includes(normalized)) return true;
  if (["n", "no", "false", "0"].includes(normalized)) return false;
  return fallback;
}

async function interactiveOptions(argv: string[]): Promise<InitOptions> {
  const args = parseArgs(argv);
  const rl = createInterface({ input, output });
  try {
    const runtimeDefault = normalizeRuntime(flagString(args.flags, "runtime")) ?? "base";
    const runtimeAnswer = flagString(args.flags, "runtime") ?? await rl.question(`Runtime [${runtimeDefault}]: `);
    const runtime = normalizeRuntime(runtimeAnswer.trim() || runtimeDefault) ?? runtimeDefault;
    const isGlobal = flagBool(args.flags, "global");
    const destBase = isGlobal ? globalDest(runtime) : defaultDest(runtime);
    const destDefault = flagString(args.flags, "dest", destBase) ?? destBase;
    const destAnswer = flagString(args.flags, "dest") ?? await rl.question(`Install destination [${destDefault}]: `);
    const sinkDefault = telemetrySinksFromFlags(args.flags);
    const sinkAnswer = flagList(args.flags, "telemetry-sink").length || flagList(args.flags, "telemetry-sinks").length
      ? sinkDefault.join(",")
      : await rl.question(`Telemetry sinks [${sinkDefault.join(",")}]: `);
    const telemetrySinks = telemetrySinksFromValues([sinkAnswer || sinkDefault.join(",")]);
    const needsUserHostedUrl = telemetrySinks.includes("user-hosted-console") || telemetrySinks.includes("hosted-kontour-console");
    const consoleUrl = flagString(args.flags, "console-url") ?? (needsUserHostedUrl ? await rl.question("User-hosted Console URL: ") : undefined);
    const consoleEndpoint = flagString(args.flags, "console-endpoint") ?? flagString(args.flags, "console-endpoint-url");
    const consoleTokenFile = flagString(args.flags, "console-token-file");
    const consoleTokenValue = consoleTokenFile ? undefined : (needsConsoleCredentials(telemetrySinks) ? await questionHidden("Console telemetry token (blank to skip): ") : undefined);
    const consoleTenant = flagString(args.flags, "console-tenant") ?? flagString(args.flags, "console-tenant-id") ?? (needsConsoleCredentials(telemetrySinks) ? await rl.question("Console tenant ID (blank to skip): ") : undefined);
    const activateDefault = false;
    const activateAnswer = flagBool(args.flags, "activate-kits")
      ? "yes"
      : runtime === "codex"
        ? await rl.question(`Activate local Builder Kit runtime assets [${activateDefault ? "Y/n" : "y/N"}]: `)
        : "no";
    return {
      runtime,
      global: isGlobal,
      dest: path.resolve(destAnswer.trim() || destDefault),
      consoleUrl: consoleUrl?.trim() || undefined,
      consoleEndpoint: consoleEndpoint?.trim() || undefined,
      consoleTokenFile: consoleTokenFile?.trim() || undefined,
      consoleTokenValue: consoleTokenValue?.trim() || undefined,
      consoleTenant: consoleTenant?.trim() || undefined,
      telemetrySinks,
      activateKits: runtime === "codex" && parseYesNo(activateAnswer, activateDefault),
    };
  } finally {
    rl.close();
  }
}

function headlessOptions(argv: string[]): InitOptions {
  const args = parseArgs(argv);
  const runtime = normalizeRuntime(flagString(args.flags, "runtime")) ?? "base";
  const isGlobal = flagBool(args.flags, "global");
  const destBase = isGlobal ? globalDest(runtime) : defaultDest(runtime);
  return {
    runtime,
    global: isGlobal,
    dest: path.resolve(flagString(args.flags, "dest", destBase) ?? destBase),
    consoleUrl: flagString(args.flags, "console-url"),
    consoleEndpoint: flagString(args.flags, "console-endpoint") ?? flagString(args.flags, "console-endpoint-url"),
    consoleTokenFile: flagString(args.flags, "console-token-file"),
    consoleTenant: flagString(args.flags, "console-tenant") ?? flagString(args.flags, "console-tenant-id"),
    telemetrySinks: telemetrySinksFromFlags(args.flags),
    activateKits: runtime === "codex" && flagBool(args.flags, "activate-kits"),
  };
}

export function ensureBundle(runtime: Runtime): string {
  const bundle = path.join(root, "dist", runtimeBundles[runtime]);
  if (!fs.existsSync(path.join(bundle, "install.sh"))) {
    const rc = buildBundles();
    if (rc !== 0) throw new Error(`bundle build failed with exit code ${rc}`);
  }
  if (!fs.existsSync(path.join(bundle, "install.sh"))) throw new Error(`bundle installer missing: ${bundle}`);
  return bundle;
}

// The bundle's hook commands resolve the flow-agents scripts directory via
// ${CLAUDE_PROJECT_DIR:-$(pwd)}. That is correct for a project-scoped install
// (installBundle rsyncs scripts/ alongside .claude/, so CLAUDE_PROJECT_DIR ==
// the install destination). It is NOT correct for a --global install: there
// is no per-destination copy of scripts/, and CLAUDE_PROJECT_DIR varies with
// whichever project happens to be open, so the hook resolves to a path that
// exists in at most one project (and never for most sessions). Global
// installs need an absolute, session-independent path instead.
const GLOBAL_INSTALL_PROJECT_DIR_PREFIX = /root="\$\{CLAUDE_PROJECT_DIR:-\$\(pwd\)\}";\s*/g;
const GLOBAL_INSTALL_PROJECT_DIR_VAR = /"\$root\//g;

type InstallMergeConflict = {
  path: string;
  existingValue: unknown;
  managedValue: unknown;
};

type MergeSettingsFn = (
  existing: Record<string, unknown>,
  managed: Record<string, unknown>,
  options?: { onConflict?: (conflict: InstallMergeConflict) => void },
) => Record<string, unknown>;

function warnInstallMergeConflicts(conflicts: InstallMergeConflict[]): void {
  for (const conflict of conflicts) {
    console.warn(`install-merge: conflict: preserving existing setting '${conflict.path}' and not applying Flow Agents managed value`);
  }
}

function mergeInstallSettings(
  mergeSettings: MergeSettingsFn,
  existing: Record<string, unknown>,
  managed: Record<string, unknown>,
): Record<string, unknown> {
  const conflicts: InstallMergeConflict[] = [];
  const merged = mergeSettings(existing, managed, { onConflict: (conflict) => conflicts.push(conflict) });
  warnInstallMergeConflicts(conflicts);
  return merged;
}

function rewriteCommandForGlobalInstall(command: string, sourceRoot: string): string {
  return command
    .replace(GLOBAL_INSTALL_PROJECT_DIR_PREFIX, "")
    .replace(GLOBAL_INSTALL_PROJECT_DIR_VAR, `"${sourceRoot}/`);
}

/** Recursively rewrite every `command` string found under `value` in place. */
function rewriteCommandsForGlobalInstall(value: unknown, sourceRoot: string): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteCommandsForGlobalInstall(item, sourceRoot);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === "command" && typeof obj[key] === "string") {
      obj[key] = rewriteCommandForGlobalInstall(obj[key] as string, sourceRoot);
      continue;
    }
    rewriteCommandsForGlobalInstall(obj[key], sourceRoot);
  }
}

/**
 * Additively copy every file under srcDir into destDir, creating directories
 * as needed and overwriting files whose content changed. Never deletes files
 * in destDir that srcDir does not own — destDir may contain unrelated content
 * (other kits, other tools) that this sync must not touch.
 */
function copyDirMerge(srcDir: string, destDir: string): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  if (!fs.existsSync(srcDir)) return { added, updated };
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      const nested = copyDirMerge(srcPath, destPath);
      added += nested.added;
      updated += nested.updated;
      continue;
    }
    if (!entry.isFile()) continue;
    const content = fs.readFileSync(srcPath);
    if (fs.existsSync(destPath)) {
      if (Buffer.compare(fs.readFileSync(destPath), content) === 0) continue;
      updated += 1;
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      added += 1;
    }
    fs.writeFileSync(destPath, content);
  }
  return { added, updated };
}

function installBundle(bundle: string, options: InitOptions): number {
  const args = ["install.sh", options.dest];
  for (const sink of options.telemetrySinks) args.push("--telemetry-sink", sink);
  if (options.consoleUrl) args.push("--console-url", options.consoleUrl);
  if (options.consoleEndpoint) args.push("--console-endpoint", options.consoleEndpoint);
  let tempTokenFile: string | undefined;
  const consoleTokenFile = options.consoleTokenFile ?? (() => {
    if (!options.consoleTokenValue) return undefined;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-token-")), "console-token");
    fs.writeFileSync(file, options.consoleTokenValue, { encoding: "utf8", mode: 0o600 });
    tempTokenFile = file;
    return file;
  })();
  if (consoleTokenFile) args.push("--console-token-file", consoleTokenFile);
  if (options.consoleTenant) args.push("--console-tenant", options.consoleTenant);
  const env = { ...process.env };
  const result = spawnSync("bash", args, { cwd: bundle, env, encoding: "utf8", stdio: "inherit" });
  if (tempTokenFile) fs.rmSync(path.dirname(tempTokenFile), { recursive: true, force: true });
  if (result.error) {
    console.error(`flow-agents init: unable to run bundle installer: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function activateKits(options: InitOptions): number {
  if (!options.activateKits) return 0;
  const result = activateCodexLocal(options.dest, options.dest);
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    console.error(JSON.stringify(result, null, 2));
    return 1;
  }
  const generated = Array.isArray(result.generated_runtime_files) ? result.generated_runtime_files : [];
  console.log(`Activated ${generated.length} Codex local runtime asset(s)`);
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return 0;
  }
  const headless = argv.includes("--yes") || argv.includes("--headless") || !process.stdin.isTTY;
  try {
    const options = headless ? headlessOptions(argv) : await interactiveOptions(argv);
    // Scope-collision check for claude-code: Claude Code merges user-level
    // (~/.claude/settings.json) and project-level (.claude/settings.json) settings
    // and runs ALL matching hooks from both files. If a user-level settings file
    // already contains flow-agents hooks, installing at the project level will
    // cause duplicate hook execution. We warn but do not block.
    //
    // Codex note: Codex hooks live in .codex/hooks.json (project-level only).
    // There is no well-known user-level codex hooks file in our install paths,
    // so no collision check is needed for codex.
    if (options.runtime === "claude-code") {
      // Skip collision check when --global is set: the user is intentionally
      // targeting the global settings, so the collision they'd create is expected.
      if (!options.global) checkScopeCollision();
    }
    // --global for claude-code: merge hook-wiring into the global/user-level
    // settings dir, plus additively sync skills/agents so a global install
    // does not silently go stale as new Builder Kit skills ship. This does
    // NOT rsync the full workspace bundle (no context/, powers/, prompts/,
    // etc.) — only the parts a global Claude Code user-config needs. The
    // global settings dir is the claude config root, so the settings.json
    // lives directly in dest (not dest/.claude/).
    if (options.global && options.runtime === "claude-code") {
      const bundle = ensureBundle(options.runtime);
      // For --global, dest is ~/.claude/ (the global settings dir).
      // dogfoodClaudeCode writes to dest/.claude/settings.json — but for global,
      // the settings.json lives at dest/settings.json (dest IS ~/.claude/).
      // We use a special global-merge path: merge directly into dest/settings.json.
      const sourcePath = path.join(bundle, ".claude", "settings.json");
      if (!fs.existsSync(sourcePath)) {
        console.error(`flow-agents init: bundle settings missing: ${sourcePath}`);
        return 1;
      }
      const managed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
      // Remove permissive defaults (not appropriate for global user settings).
      delete managed["permissions"];
      delete managed["skipDangerousModePermissionPrompt"];
      // See rewriteCommandsForGlobalInstall: bundle hook commands assume
      // CLAUDE_PROJECT_DIR points at this package; a global install must not
      // depend on which project is currently open, so pin to an absolute path.
      rewriteCommandsForGlobalInstall(managed, root);
      fs.mkdirSync(options.dest, { recursive: true });
      const destSettingsPath = path.join(options.dest, "settings.json");
      const installMergePath = path.join(root, "scripts", "install-merge.js");
      const _require = createRequire(import.meta.url);
      const { mergeSettings } = _require(installMergePath) as { mergeSettings: MergeSettingsFn };
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(destSettingsPath)) {
        try { existing = JSON.parse(fs.readFileSync(destSettingsPath, "utf8")) as Record<string, unknown>; } catch { existing = {}; }
      }
      const merged = mergeInstallSettings(mergeSettings, existing, managed);
      const tmp = `${destSettingsPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, destSettingsPath);
      // Additive skills/agents sync: adds new files and updates changed ones,
      // never deletes — dest may hold unrelated content from other kits/tools.
      const skillsSync = copyDirMerge(path.join(bundle, ".claude", "skills"), path.join(options.dest, "skills"));
      const agentsSync = copyDirMerge(path.join(bundle, ".claude", "agents"), path.join(options.dest, "agents"));
      // Write version stamp.
      const recordPath = durableInstallRecordPath(options.dest);
      const installRecordDir = path.dirname(recordPath);
      fs.mkdirSync(installRecordDir, { recursive: true });
      const pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, string>;
      const record = { version: pkgJson["version"] ?? "0.0.0", installedAt: new Date().toISOString(), runtime: "claude-code", global: true };
      const recordTmp = `${recordPath}.tmp.${process.pid}`;
      fs.writeFileSync(recordTmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      fs.renameSync(recordTmp, recordPath);
      console.log(`Flow Agents global hooks merged for claude-code in ${options.dest}`);
      console.log(`Synced skills (+${skillsSync.added} new, ~${skillsSync.updated} updated) and agents (+${agentsSync.added} new, ~${agentsSync.updated} updated) in ${options.dest}`);
      // Write a per-skill-file sha256 content-hash manifest, sibling of install.json, so
      // `flow-agents skill-drift-check` and the SessionStart advisory can classify installed
      // skill files as in_sync/kit_updated/user_modified/unbaselined/missing_install/kit_removed
      // without re-deriving a second hashing convention (kontourai/flow-agents#439). This is an
      // additive convenience feature layered on top of the install that already succeeded above
      // (settings merge + skills/agents sync) — a failure writing this manifest must never fail
      // the whole `init --global` run, so it is contained here: warn and continue.
      try {
        const skillDriftLibPath = path.join(root, "scripts", "hooks", "lib", "skill-drift.js");
        const _requireSkillDrift = createRequire(import.meta.url);
        const { buildManifest, writeManifestAtomic } = _requireSkillDrift(skillDriftLibPath) as {
          buildManifest: (params: { skillsSourceDir: string; runtime: string }) => unknown;
          writeManifestAtomic: (manifestPath: string, manifest: unknown) => void;
        };
        const skillsManifest = buildManifest({ skillsSourceDir: path.join(bundle, ".claude", "skills"), runtime: "claude-code" });
        writeManifestAtomic(skillsManifestPath(options.dest), skillsManifest);
      } catch (error) {
        console.error(
          `flow-agents init: WARNING: could not write skills drift-detection manifest: ${(error as Error).message} ` +
            "(drift detection will report unbaselined until the next successful --global sync)."
        );
      }
      return 0;
    }
    // --global for opencode: merge FA opencode.json into the global opencode config dir.
    // Global path: ~/.config/opencode/opencode.json (honor XDG_CONFIG_HOME).
    // Test isolation: FLOW_AGENTS_USER_OPENCODE_CONFIG points to the opencode.json FILE.
    if (options.global && options.runtime === "opencode") {
      const bundle = ensureBundle(options.runtime);
      const sourcePath = path.join(bundle, "opencode.json");
      if (!fs.existsSync(sourcePath)) {
        console.error(`flow-agents init: bundle opencode.json missing: ${sourcePath}`);
        return 1;
      }
      const managed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
      fs.mkdirSync(options.dest, { recursive: true });
      // The global opencode.json lives directly at dest/opencode.json.
      const destConfigPath = path.join(options.dest, "opencode.json");
      const installMergePath = path.join(root, "scripts", "install-merge.js");
      const _require = createRequire(import.meta.url);
      const { mergeSettings } = _require(installMergePath) as { mergeSettings: MergeSettingsFn };
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(destConfigPath)) {
        try { existing = JSON.parse(fs.readFileSync(destConfigPath, "utf8")) as Record<string, unknown>; } catch { existing = {}; }
      }
      const merged = mergeInstallSettings(mergeSettings, existing, managed);
      const tmp = `${destConfigPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}
`, "utf8");
      fs.renameSync(tmp, destConfigPath);
      // Write version stamp.
      const recordPath = durableInstallRecordPath(options.dest);
      const installRecordDir = path.dirname(recordPath);
      fs.mkdirSync(installRecordDir, { recursive: true });
      const pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, string>;
      const record = { version: pkgJson["version"] ?? "0.0.0", installedAt: new Date().toISOString(), runtime: "opencode", global: true };
      const recordTmp = `${recordPath}.tmp.${process.pid}`;
      fs.writeFileSync(recordTmp, `${JSON.stringify(record, null, 2)}
`, "utf8");
      fs.renameSync(recordTmp, recordPath);
      console.log(`Flow Agents global config merged for opencode in ${options.dest}`);
      return 0;
    }
    // --global for codex: run install-codex-home.sh to install into the Codex home.
    // Defaults to CODEX_HOME or ~/.codex. --dest remains an explicit override.
    if (options.global && options.runtime === "codex") {
      const codexHomeScript = path.join(root, "scripts", "install-codex-home.sh");
      if (!fs.existsSync(codexHomeScript)) {
        console.error(`flow-agents init: install-codex-home.sh missing: ${codexHomeScript}`);
        return 1;
      }
      const scriptArgs: string[] = [options.dest];
      for (const sink of options.telemetrySinks) scriptArgs.push("--telemetry-sink", sink);
      if (options.consoleUrl) scriptArgs.push("--console-url", options.consoleUrl);
      if (options.consoleEndpoint) scriptArgs.push("--console-endpoint", options.consoleEndpoint);
      if (options.consoleTokenFile) scriptArgs.push("--console-token-file", options.consoleTokenFile);
      if (options.consoleTenant) scriptArgs.push("--console-tenant", options.consoleTenant);
      const result = spawnSync("bash", [codexHomeScript, ...scriptArgs], { env: { ...process.env }, encoding: "utf8", stdio: "inherit" });
      if (result.error) {
        console.error(`flow-agents init: unable to run install-codex-home.sh: ${result.error.message}`);
        return 1;
      }
      const installed = result.status ?? 1;
      if (installed !== 0) return installed;
      return activateKits(options);
    }
    // --global for pi: NOT_VERIFIED (no documented global dir). Warn and fall through to workspace install.
    if (options.global && options.runtime === "pi") {
      console.warn(
        `flow-agents init: NOT_VERIFIED: pi has no documented global config directory. ` +
        `The --global flag for pi is not verified against pi documentation. ` +
        `Falling back to workspace default destination: ${options.dest}`
      );
    }
    const bundle = ensureBundle(options.runtime);
    const installed = installBundle(bundle, options);
    if (installed !== 0) return installed;
    return activateKits(options);
  } catch (error) {
    console.error(`flow-agents init: ${(error as Error).message}`);
    return 2;
  }
}

// ---------------------------------------------------------------------------
// Dogfood subcommand
//
// `flow-agents dogfood --runtime claude-code [--dest PATH]`
//
// Writes only the hook-wiring artifacts for the specified runtime into the
// target directory (default: cwd). Unlike a full install, dogfood:
//   - Does NOT rsync the full bundle (no agents/skills duplication).
//   - Reads the generated settings/config from dist/<runtime>/ so the output
//     cannot drift from what the bundle generates (DRY guarantee).
//   - For claude-code: OMITS permissions.defaultMode and
//     skipDangerousModePermissionPrompt (permissive defaults are for installed
//     workspaces, not source repos).
//   - Runs the same scope-collision warning as init.
// ---------------------------------------------------------------------------

function dogfoodUsage(): void {
  console.error(`usage: flow-agents dogfood [options]

Options:
  --runtime claude-code|codex|opencode|pi   (required)
  --dest PATH                               (default: cwd)
  --yes, --headless
`);
}

type DogfoodRuntime = "claude-code" | "codex" | "opencode" | "pi";

function normalizeDogfoodRuntime(value: string | undefined): DogfoodRuntime | undefined {
  if (!value) return undefined;
  if (value === "claude" || value === "claude-code") return "claude-code";
  if (value === "codex" || value === "opencode" || value === "pi") return value;
  throw new Error(`dogfood: unsupported runtime '${value}'; expected claude-code, codex, opencode, or pi`);
}

/**
 * Write the claude-code hook-wiring artifacts into dest using merge semantics.
 * Reads dist/claude-code/.claude/settings.json (generated by build-bundles),
 * strips the permissive-mode permission keys (defaultMode, skipDangerousModePermissionPrompt)
 * from the managed bundle settings, then MERGES into any existing dest settings.json —
 * preserving user keys, auth, and non-flow-agents hooks. Writes version stamp.
 */
function dogfoodClaudeCode(bundleRoot: string, dest: string): void {
  const sourcePath = path.join(bundleRoot, ".claude", "settings.json");
  if (!fs.existsSync(sourcePath)) throw new Error(`dogfood: bundle settings missing: ${sourcePath}`);
  const managed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
  // Remove permissive defaults that are only appropriate for installed workspaces.
  // These keys must not be present in the source repo's .claude/settings.json.
  delete managed["permissions"];
  delete managed["skipDangerousModePermissionPrompt"];
  const outDir = path.join(dest, ".claude");
  fs.mkdirSync(outDir, { recursive: true });
  const destSettingsPath = path.join(outDir, "settings.json");
  // Merge: read existing, strip FA hooks, append new FA hooks, preserve all other keys.
  const installMergePath = path.join(root, "scripts", "install-merge.js");
  const _require = createRequire(import.meta.url);
  const { mergeSettings } = _require(installMergePath) as { mergeSettings: MergeSettingsFn };
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(destSettingsPath)) {
    try { existing = JSON.parse(fs.readFileSync(destSettingsPath, "utf8")) as Record<string, unknown>; } catch { existing = {}; }
  }
  const merged = mergeInstallSettings(mergeSettings, existing, managed);
  const tmp = `${destSettingsPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, destSettingsPath);
  // Write version stamp.
  const recordPath = durableInstallRecordPath(dest);
  const installRecordDir = path.dirname(recordPath);
  fs.mkdirSync(installRecordDir, { recursive: true });
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, string>;
  const record = { version: pkgJson["version"] ?? "0.0.0", installedAt: new Date().toISOString(), runtime: "claude-code" };
  const recordTmp = `${recordPath}.tmp.${process.pid}`;
  fs.writeFileSync(recordTmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(recordTmp, recordPath);
}

/**
 * Write the codex hook-wiring artifacts into dest using merge semantics.
 * Reads dist/codex/.codex/hooks.json and MERGES into any existing dest hooks.json —
 * preserving user non-FA hook groups. Writes version stamp.
 * The monolithic .codex/config.toml is not written here because it contains
 * workspace settings (approvals_reviewer, features) that would override the
 * developer's existing codex configuration. Only the hooks file is merged.
 */
function dogfoodCodex(bundleRoot: string, dest: string): void {
  const sourcePath = path.join(bundleRoot, ".codex", "hooks.json");
  if (!fs.existsSync(sourcePath)) throw new Error(`dogfood: bundle hooks.json missing: ${sourcePath}`);
  const managed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
  const outDir = path.join(dest, ".codex");
  fs.mkdirSync(outDir, { recursive: true });
  const destHooksPath = path.join(outDir, "hooks.json");
  // Merge: read existing, strip FA hook-groups, append new FA hook-groups, preserve user groups.
  const installMergePath = path.join(root, "scripts", "install-merge.js");
  const _require = createRequire(import.meta.url);
  const { mergeSettings } = _require(installMergePath) as { mergeSettings: MergeSettingsFn };
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(destHooksPath)) {
    try { existing = JSON.parse(fs.readFileSync(destHooksPath, "utf8")) as Record<string, unknown>; } catch { existing = {}; }
  }
  const merged = mergeInstallSettings(mergeSettings, existing, managed);
  const tmp = `${destHooksPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, destHooksPath);
  // Write version stamp.
  const recordPath = durableInstallRecordPath(dest);
  const installRecordDir = path.dirname(recordPath);
  fs.mkdirSync(installRecordDir, { recursive: true });
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, string>;
  const record = { version: pkgJson["version"] ?? "0.0.0", installedAt: new Date().toISOString(), runtime: "codex" };
  const recordTmp = `${recordPath}.tmp.${process.pid}`;
  fs.writeFileSync(recordTmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(recordTmp, recordPath);
}

/**
 * Write the opencode hook-wiring artifacts into dest.
 * Reads dist/opencode/.opencode/plugins/flow-agents.js and opencode.json,
 * and writes them into dest. These are the minimal hook-wiring files; the
 * full skill/agent tree is not copied.
 */
function dogfoodOpencode(bundleRoot: string, dest: string): void {
  const pluginSource = path.join(bundleRoot, ".opencode", "plugins", "flow-agents.js");
  const configSource = path.join(bundleRoot, "opencode.json");
  if (!fs.existsSync(pluginSource)) throw new Error(`dogfood: bundle plugin missing: ${pluginSource}`);
  const pluginDir = path.join(dest, ".opencode", "plugins");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.copyFileSync(pluginSource, path.join(pluginDir, "flow-agents.js"));
  // Write opencode.json only if it does not already exist to avoid clobbering
  // any workspace-specific opencode configuration.
  const destConfig = path.join(dest, "opencode.json");
  if (!fs.existsSync(destConfig) && fs.existsSync(configSource)) {
    fs.copyFileSync(configSource, destConfig);
  }
}

/**
 * Write the pi hook-wiring artifacts into dest.
 * Reads dist/pi/.pi/extensions/flow-agents.ts and writes it to dest.
 * The extension is the only hook-wiring file needed for pi.
 */
function dogfoodPi(bundleRoot: string, dest: string): void {
  const extSource = path.join(bundleRoot, ".pi", "extensions", "flow-agents.ts");
  if (!fs.existsSync(extSource)) throw new Error(`dogfood: bundle extension missing: ${extSource}`);
  const extDir = path.join(dest, ".pi", "extensions");
  fs.mkdirSync(extDir, { recursive: true });
  fs.copyFileSync(extSource, path.join(extDir, "flow-agents.ts"));
}

export async function mainDogfood(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    dogfoodUsage();
    return 0;
  }
  const args = parseArgs(argv);
  try {
    const runtimeRaw = flagString(args.flags, "runtime");
    const runtime = normalizeDogfoodRuntime(runtimeRaw);
    if (!runtime) {
      console.error("dogfood: --runtime is required (claude-code, codex, opencode, or pi)");
      dogfoodUsage();
      return 2;
    }
    const dest = path.resolve(flagString(args.flags, "dest") ?? process.cwd());

    // Ensure the bundle for the requested runtime is built.
    const bundleRuntime: Runtime = runtime as Runtime;
    const bundleRoot = ensureBundle(bundleRuntime);

    // Scope-collision check: warn if user-level claude settings already has flow-agents.
    // Codex: no user-level hooks file in our install paths — skip with note above.
    if (runtime === "claude-code") {
      checkScopeCollision();
    }

    // Write only the hook-wiring artifacts, not the full bundle.
    fs.mkdirSync(dest, { recursive: true });
    if (runtime === "claude-code") dogfoodClaudeCode(bundleRoot, dest);
    else if (runtime === "codex") dogfoodCodex(bundleRoot, dest);
    else if (runtime === "opencode") dogfoodOpencode(bundleRoot, dest);
    else if (runtime === "pi") dogfoodPi(bundleRoot, dest);

    console.log(`Flow Agents dogfood hooks wired for ${runtime} in ${dest}`);
    return 0;
  } catch (error) {
    console.error(`flow-agents dogfood: ${(error as Error).message}`);
    return 2;
  }
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = await main(); }
