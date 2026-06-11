import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseArgs, flagBool, flagList, flagString } from "../lib/args.js";
import { activateCodexLocal } from "../runtime-adapters.js";
import { main as buildBundles } from "../tools/build-universal-bundles.js";
import { root } from "../tools/common.js";

type Runtime = "base" | "codex" | "claude-code" | "kiro" | "opencode" | "pi";
type TelemetrySink = "local-files" | "local-kontour-console" | "kontour-hosted-console" | "user-hosted-console" | "kontour-cloud" | "hosted-kontour-console";

type InitOptions = {
  runtime: Runtime;
  dest: string;
  consoleUrl?: string;
  consoleEndpoint?: string;
  consoleTokenFile?: string;
  consoleTokenValue?: string;
  consoleTenant?: string;
  telemetrySinks: TelemetrySink[];
  packs?: string;
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
  --telemetry-sink local-files|local-kontour-console|kontour-hosted-console|user-hosted-console
  --console-url URL
  --console-endpoint URL
  --console-token-file PATH
  --console-tenant ID
  --packs LIST
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
    const destDefault = flagString(args.flags, "dest", defaultDest(runtime)) ?? defaultDest(runtime);
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
      dest: path.resolve(destAnswer.trim() || destDefault),
      consoleUrl: consoleUrl?.trim() || undefined,
      consoleEndpoint: consoleEndpoint?.trim() || undefined,
      consoleTokenFile: consoleTokenFile?.trim() || undefined,
      consoleTokenValue: consoleTokenValue?.trim() || undefined,
      consoleTenant: consoleTenant?.trim() || undefined,
      telemetrySinks,
      packs: flagString(args.flags, "packs"),
      activateKits: runtime === "codex" && parseYesNo(activateAnswer, activateDefault),
    };
  } finally {
    rl.close();
  }
}

function headlessOptions(argv: string[]): InitOptions {
  const args = parseArgs(argv);
  const runtime = normalizeRuntime(flagString(args.flags, "runtime")) ?? "base";
  return {
    runtime,
    dest: path.resolve(flagString(args.flags, "dest", defaultDest(runtime)) ?? defaultDest(runtime)),
    consoleUrl: flagString(args.flags, "console-url"),
    consoleEndpoint: flagString(args.flags, "console-endpoint") ?? flagString(args.flags, "console-endpoint-url"),
    consoleTokenFile: flagString(args.flags, "console-token-file"),
    consoleTenant: flagString(args.flags, "console-tenant") ?? flagString(args.flags, "console-tenant-id"),
    telemetrySinks: telemetrySinksFromFlags(args.flags),
    packs: flagString(args.flags, "packs"),
    activateKits: runtime === "codex" && flagBool(args.flags, "activate-kits"),
  };
}

function ensureBundle(runtime: Runtime): string {
  const bundle = path.join(root, "dist", runtimeBundles[runtime]);
  if (!fs.existsSync(path.join(bundle, "install.sh"))) {
    const rc = buildBundles();
    if (rc !== 0) throw new Error(`bundle build failed with exit code ${rc}`);
  }
  if (!fs.existsSync(path.join(bundle, "install.sh"))) throw new Error(`bundle installer missing: ${bundle}`);
  return bundle;
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
  if (options.packs) env.FLOW_AGENTS_PACKS = options.packs;
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
      checkScopeCollision();
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
 * Write the claude-code hook-wiring artifacts into dest.
 * Reads dist/claude-code/.claude/settings.json (generated by build-bundles),
 * strips the permissive-mode permission keys (defaultMode, skipDangerousModePermissionPrompt),
 * and writes .claude/settings.json to dest.
 */
function dogfoodClaudeCode(bundleRoot: string, dest: string): void {
  const sourcePath = path.join(bundleRoot, ".claude", "settings.json");
  if (!fs.existsSync(sourcePath)) throw new Error(`dogfood: bundle settings missing: ${sourcePath}`);
  const settings = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
  // Remove permissive defaults that are only appropriate for installed workspaces.
  // These keys must not be present in the source repo's .claude/settings.json.
  delete settings["permissions"];
  delete settings["skipDangerousModePermissionPrompt"];
  const outDir = path.join(dest, ".claude");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/**
 * Write the codex hook-wiring artifacts into dest.
 * Reads dist/codex/.codex/hooks.json and writes .codex/hooks.json to dest.
 * The monolithic .codex/config.toml is not written here because it contains
 * workspace settings (approvals_reviewer, features) that would override the
 * developer's existing codex configuration. Only the hooks file is written.
 */
function dogfoodCodex(bundleRoot: string, dest: string): void {
  const sourcePath = path.join(bundleRoot, ".codex", "hooks.json");
  if (!fs.existsSync(sourcePath)) throw new Error(`dogfood: bundle hooks.json missing: ${sourcePath}`);
  const hooks = fs.readFileSync(sourcePath, "utf8");
  const outDir = path.join(dest, ".codex");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "hooks.json"), hooks, "utf8");
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

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
