import { spawnSync } from "node:child_process";
import { ensureArtifactResidueIgnored } from "../lib/artifact-residue-ignore.js";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseArgs, flagBool, flagList, flagString } from "../lib/args.js";
import { activateCodexLocal } from "../runtime-adapters.js";
import { provisionKit, ProvisionConflictError } from "../flow-kit/provision.js";
import { main as buildBundles } from "../tools/build-universal-bundles.js";
import { root } from "../tools/common.js";
import { defaultCodexHome, durableInstallRecordPath, skillsManifestPath } from "../lib/local-artifact-root.js";
import { buildOwnedFilesManifest, writeOwnedFilesManifest } from "../lib/owned-files-manifest.js";
import {
  bundleInstallExcludeRel,
  computeInstallPlan,
  executePlanCopies,
  executePlanRemovals,
  formatDryRunLines,
  formatInstallSummaryLines,
  installerSupportsPreserveExcludes,
  verifyInstallPlanMatchesDisk,
} from "./install-plan.js";
import {
  catalogKitIds as registryCatalogKitIds,
  readPackageVersion,
  validateActiveKitEntries,
  type ActiveKitEntry,
  type KitScope,
} from "../lib/kit-registry.js";
import { runConsoleConnectWizard, describeConsoleStatus, buildPostInstallSummaryLines } from "../lib/console-connect-options.js";
import { buildReport } from "./telemetry-doctor.js";
import { bootstrapProviders, type ProviderScope } from "./provider-bootstrap.js";
import { createOpenCodeAdapter, type InstallationReceipt, type PortableAsset } from "@kontourai/conduit";

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
  activeKitIds?: string[];
  // Informational only -- never read by installBundle()/install-console-config.sh
  // (not part of the install writer contract). Set when the runtime was not
  // given via an explicit --runtime flag/typed answer and the layered
  // detector (detectRuntimeFromProcessEnv/detectRuntimeFromFilesystem)
  // actually matched a signal, for the post-install summary's
  // "(auto-detected)" annotation. headlessOptions() itself never sets this
  // (untouched) -- main() merges it onto the headless result separately.
  runtimeAutoDetected?: boolean;
  configureProviders?: boolean;
  providerScope?: ProviderScope;
  providerRepoPath?: string;
  providerProjectNumber?: number;
  providerOnline?: boolean;
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
  --activate-kit KIT_ID   Activate one catalog kit by id. Repeat for multiple kits.
  --configure-providers   Configure backlog, assignment, and change providers together.
  --provider-scope project|global
  --provider-repo-path PATH
  --provider-project NUMBER
  --online               Verify GitHub auth/project and create the claim label if missing.
  --dry-run              List every path the install would create, replace, remove, or
                         preserve; write nothing. Implies --headless. Supported for
                         project (bundle) installs and --global claude-code.
  --force                Overwrite existing destination files that are NOT known
                         bundle-owned content. Without --force such files are always
                         preserved and reported. Supported for project (bundle)
                         installs and --global claude-code.
  --yes, --headless
  --uninstall             Remove a prior install instead of installing.
                          Usage: flow-agents init --uninstall --runtime claude-code [--global | --dest PATH]
                          Run \`flow-agents init --uninstall --help\` for uninstall-specific options.
`);
}

function parseProviderScope(value: string | undefined): ProviderScope {
  if (value === undefined || value === "project") return "project";
  if (value === "global") return "global";
  throw new Error(`unknown provider scope '${value}'; expected project or global`);
}

function parseProviderProject(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error("--provider-project must be a positive integer");
  return number;
}

function catalogKitIds(): string[] {
  return registryCatalogKitIds(root);
}

function selectedKitIdsFromFlags(flags: ReturnType<typeof parseArgs>["flags"]): string[] {
  const explicit = flagList(flags, "activate-kit").map((id) => id.trim()).filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];
  if (flagBool(flags, "activate-kits")) return catalogKitIds();
  return [];
}

/**
 * Compute the `active_kits` durable-record field (kontourai/flow-agents kit activation
 * registry): a richer, explicit companion to the pre-existing `active_kit_ids: string[]` field
 * (kept unchanged for backward compatibility -- opencode/codex installs already key runtime asset
 * selection off it, and existing evals assert its exact shape).
 *
 * - When the caller made an explicit kit selection (`activeKitIds` non-empty, via
 *   `--activate-kit`/`--activate-kits`), that selection is what gets recorded, for every runtime.
 * - Otherwise (the common default-flags case), claude-code records EVERY catalog kit: that has
 *   always been the actual physical install behavior (the install's `.claude/skills` sync is
 *   unconditional, not filtered by kit selection), and this
 *   makes that implicit "all built-ins active" behavior explicit and queryable rather than
 *   leaving `active_kit_ids` empty while the skills are, in fact, all present on disk. Other
 *   runtimes install no kit-specific assets by default (opencode/codex only provision kit
 *   content when a selection is made), so their default `active_kits` stays empty, matching
 *   what is actually on disk for them too.
 */
function computeActiveKits(runtime: Runtime, global: boolean | undefined, activeKitIds: string[], version: string, installedAt: string): ActiveKitEntry[] {
  const scope: KitScope = global ? "global" : "project";
  const catalogIds = new Set(catalogKitIds());
  // `active_kits` (the built-in kit activation registry -- see src/lib/kit-registry.ts) tracks
  // ONLY built-in (catalog) kits, by design: third-party/local kits have their own independent
  // activation lifecycle (presence in kits/local/installed-kits.json IS their activation). The
  // caller's raw `--activate-kit` selection (`activeKitIds`, preserved verbatim in the separate
  // `active_kit_ids` field below) can legitimately include a local kit id -- e.g. one just
  // `kit install`ed -- for runtimes whose own activation step (`activateCodexLocal`'s
  // `kitIdFilter`, `resolveOpencodeSkillNames`) accepts a mix of catalog and local ids. Filtering
  // to catalog ids HERE (not rejecting the whole call) is the fix for a real bug caught by
  // src/cli/kit-provisioning.test.mjs: `init --activate-kit <local-kit-id>` used to crash with
  // "active_kits references unknown kit id" because every explicitly-selected id was recorded
  // into active_kits unfiltered, then rejected by the catalog-membership check below.
  const ids = activeKitIds.length > 0
    ? activeKitIds.filter((id) => catalogIds.has(id))
    : (runtime === "claude-code" ? catalogKitIds() : []);
  const entries = ids.map((id) => ({ id, version, activated_at: installedAt, scope }));
  // Defensive only: `ids` is now always the catalog itself or a subset of it (filtered above), so
  // this must never fire in practice -- but a record this function itself computed incorrectly
  // should fail loudly, not get silently persisted as a bogus `active_kits` value.
  const invalid = validateActiveKitEntries(entries, catalogIds);
  if (invalid.length) throw new Error(`internal error computing active_kits: ${invalid.join("; ")}`);
  return entries;
}

/**
 * Ensure the workflow artifact root ignores the writer's own transient residue.
 *
 * #1264: `workflow evidence` with command evidence executes each `--command` itself and
 * captures Git provenance AT EXECUTION TIME, from a session directory it has just written
 * into. Every passing claim therefore requires a clean working tree at the moment the
 * writer is busy dirtying it -- with transaction directories, lock files and its own
 * append-only command log. In a repository that does not ignore those paths, the writer
 * refuses its own observation, and the error names a precondition rather than the cause.
 *
 * This was invisible during development because THIS repository has `.kontourai/` in its
 * own .gitignore; a fresh `init` never wrote one, so the path worked where it was built
 * and was structurally broken everywhere else.
 *
 * The ignore is written INSIDE the artifact root rather than appended to the repository's
 * .gitignore, deliberately: it needs no edit to a user-authored file, it cannot conflict
 * with one, and it disappears with the directory it governs, so uninstall stays honest
 * without special-casing a line it once added somewhere else. It is also deliberately
 * NARROW -- only the transient residue is ignored, so a project that chooses to commit
 * its durable run artifacts still can.
 */

function writeInstallRecord(dest: string, runtime: Runtime, global: boolean | undefined, activeKitIds: string[] = [], configPremerge?: unknown, authorizedBackingRoots: string[] = [], installedValues?: unknown): void {
  const recordPath = durableInstallRecordPath(dest);
  const installRecordDir = path.dirname(recordPath);
  fs.mkdirSync(installRecordDir, { recursive: true });
  const version = readPackageVersion(root);
  const installedAt = new Date().toISOString();
  const activeKits = computeActiveKits(runtime, global, activeKitIds, version, installedAt);
  // A v2 snapshot explicitly separates the stable lineage origin (provenance)
  // from the immediately preceding image (byte-exact restore). Older v1 records
  // remain readable as the best available origin during upgrade.
  let normalizedPremerge = configPremerge;
  try {
    const prior = JSON.parse(fs.readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    const candidate = prior["config_premerge"] as Record<string, unknown> | undefined;
    if ((configPremerge as Record<string, unknown> | undefined)?.["schema_version"] === "2.0") { /* bundle installer already wrote the complete lineage */ }
    else if (prior["runtime"] === runtime && candidate?.["schema_version"] === "2.0") normalizedPremerge = { schema_version: "2.0", origin: candidate["origin"], previous: configPremerge };
    else if (prior["runtime"] === runtime && candidate?.["schema_version"] === "1.0" && configPremerge && typeof configPremerge === "object") normalizedPremerge = { schema_version: "2.0", origin: candidate, previous: configPremerge };
    else if (prior["runtime"] === runtime && configPremerge && typeof configPremerge === "object") normalizedPremerge = { schema_version: "2.0", origin: { schema_version: "unknown" }, previous: configPremerge };
  } catch {
    // A prior path that cannot be read is evidence of a damaged lineage, not
    // evidence that the just-installed image was the user's original config.
    if (fs.existsSync(recordPath) && configPremerge && typeof configPremerge === "object") normalizedPremerge = { schema_version: "2.0", origin: { schema_version: "unknown" }, previous: configPremerge };
  }
  if (normalizedPremerge && typeof normalizedPremerge === "object" && (normalizedPremerge as Record<string, unknown>)["schema_version"] === "1.0") {
    normalizedPremerge = { schema_version: "2.0", origin: normalizedPremerge, previous: normalizedPremerge };
  }
  const record = { version, installedAt, runtime, ...(global ? { global: true } : {}), active_kit_ids: activeKitIds, active_kits: activeKits, ...(normalizedPremerge ? { config_premerge: normalizedPremerge } : {}), ...(installedValues ? { installed_values: installedValues } : {}), ...(authorizedBackingRoots.length > 0 ? { authorized_backing_roots: authorizedBackingRoots } : {}) };
  const recordTmp = `${recordPath}.tmp.${process.pid}`;
  fs.writeFileSync(recordTmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.chmodSync(recordTmp, 0o600);
  fs.renameSync(recordTmp, recordPath);
  fs.chmodSync(recordPath, 0o600);
}

function normalizeRuntime(value: string | undefined): Runtime | undefined {
  if (!value) return undefined;
  if (value === "claude") return "claude-code";
  if (value === "base" || value === "codex" || value === "claude-code" || value === "kiro" || value === "opencode" || value === "pi") return value;
  throw new Error(`unknown runtime '${value}'; expected base, codex, claude-code, kiro, opencode, or pi`);
}

type ActorIdentityModule = { detectRuntime: (env: NodeJS.ProcessEnv) => string };

/**
 * The three candidate global config directories a runtime's own tooling uses,
 * shared between `globalDest` (the `--global` install target) and
 * `detectRuntimeFromFilesystem` (auto-detection fallback) so "where does
 * runtime X's global config live" is defined in exactly one place.
 */
function runtimeGlobalConfigCandidates(
  homedir: string,
  env: NodeJS.ProcessEnv,
): { "claude-code": string; codex: string; opencode: string } {
  return {
    "claude-code": path.join(homedir, ".claude"),
    codex: defaultCodexHome(env, homedir),
    opencode: path.join(env["XDG_CONFIG_HOME"] ?? path.join(homedir, ".config"), "opencode"),
  };
}

/**
 * Detect the current runtime from environment-variable signals already
 * ambient in the invoking process (Claude Code / Codex / opencode session
 * markers). Reuses the single existing `detectRuntime` implementation from
 * `scripts/hooks/lib/actor-identity.js` (via the same `createRequire` pattern
 * used elsewhere in this file for `install-merge.js`/`skill-drift.js`)
 * instead of forking a second copy of the env-var contract. `pi`'s env-var
 * contract is unverified there (see actor-identity.js's own docstring) and is
 * intentionally out of scope for auto-detection, so it maps down to
 * `"unknown"` here (pi still falls back to `"base"` like today).
 */
export function detectRuntimeFromProcessEnv(env: NodeJS.ProcessEnv = process.env): Runtime | "unknown" {
  const actorIdentityPath = path.join(root, "scripts", "hooks", "lib", "actor-identity.js");
  const _require = createRequire(import.meta.url);
  const { detectRuntime } = _require(actorIdentityPath) as ActorIdentityModule;
  const detected = detectRuntime(env);
  if (detected === "claude-code" || detected === "codex" || detected === "opencode") return detected;
  return "unknown";
}

/**
 * Detect the current runtime by probing for exactly one runtime's own global
 * config directory on disk (the same paths `globalDest` computes for
 * `--global` installs — see `runtimeGlobalConfigCandidates`). Zero matches or
 * 2+ matches are both ambiguous and must never guess: only a single
 * unambiguous hit returns a runtime; everything else is `"unknown"`.
 */
export function detectRuntimeFromFilesystem(
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Runtime | "unknown" {
  const candidates = runtimeGlobalConfigCandidates(homedir, env);
  const matches = (Object.keys(candidates) as Array<keyof typeof candidates>).filter((runtime) => {
    try {
      return fs.existsSync(candidates[runtime]);
    } catch {
      return false;
    }
  });
  return matches.length === 1 ? matches[0] : "unknown";
}

/**
 * Layered runtime auto-detection default used to pre-fill both the
 * interactive prompt and the headless `--runtime` fallback: (1) env-var
 * signals from the invoking process, (2) failing that, an unambiguous
 * filesystem probe, (3) failing that, today's `"base"` default. An explicit
 * `--runtime` flag or interactive answer always overrides this — this
 * function only supplies the fallback default (see `interactiveOptions` /
 * `headlessOptions`).
 */
export function detectDefaultRuntime(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): Runtime {
  const fromEnv = detectRuntimeFromProcessEnv(env);
  if (fromEnv !== "unknown") return fromEnv;
  const fromFilesystem = detectRuntimeFromFilesystem(homedir, env);
  if (fromFilesystem !== "unknown") return fromFilesystem;
  return "base";
}

/**
 * Returns the runtime the layered detector actually matched (env signal
 * first, then an unambiguous filesystem probe), or "unknown" if neither
 * fired. Distinct from `detectDefaultRuntime()`, which additionally falls
 * back to `"base"` when detection is unknown -- the post-install summary's
 * "(auto-detected)" annotation needs to distinguish "detection fired" from
 * "detection defaulted to base," which `detectDefaultRuntime()`'s return
 * value alone cannot express.
 */
function detectedRuntimeSignal(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): Runtime | "unknown" {
  const fromEnv = detectRuntimeFromProcessEnv(env);
  if (fromEnv !== "unknown") return fromEnv;
  return detectRuntimeFromFilesystem(homedir, env);
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

const DEFAULT_HOSTED_CONSOLE_URL = "https://console.kontourai.io";
const DEFAULT_LOCAL_CONSOLE_URL = "http://127.0.0.1:3737";

/**
 * Resolve one of `console-presets.sh`'s bash functions (by name) against the
 * source root, so the interactive wizard's printed defaults are never a
 * second hardcoded literal competing with the one bash source of truth
 * (itself overridable via FLOW_AGENTS_KONTOUR_CLOUD_CONSOLE_URL /
 * FLOW_AGENTS_LOCAL_KONTOUR_CONSOLE_URL, depending on which function is
 * named). `fallback` is only a defensive floor for the rare case the
 * subprocess produces no output (e.g. an unreadable source tree) -- it is not
 * a second default.
 */
function presetConsoleUrl(bashFnName: string, fallback: string): string {
  const scriptPath = path.join(root, "scripts", "telemetry", "console-presets.sh");
  const result = spawnSync("bash", ["-c", `source "${scriptPath}" && ${bashFnName}`], { encoding: "utf8" });
  const stdout = (result.stdout ?? "").trim();
  return stdout || fallback;
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
  // Shared with detectRuntimeFromFilesystem so the "where is runtime X's global
  // config" path logic is defined exactly once.
  const candidates = runtimeGlobalConfigCandidates(os.homedir(), process.env);
  if (runtime === "claude-code") {
    // Honor FLOW_AGENTS_USER_CLAUDE_SETTINGS for test isolation (same as checkScopeCollision).
    const override = process.env["FLOW_AGENTS_USER_CLAUDE_SETTINGS"];
    if (override) return path.dirname(override);
    return candidates["claude-code"];
  }
  if (runtime === "opencode") {
    // Honor FLOW_AGENTS_USER_OPENCODE_CONFIG (points to the opencode.json FILE) for test isolation,
    // mirroring FLOW_AGENTS_USER_CLAUDE_SETTINGS for claude-code.
    const override = process.env["FLOW_AGENTS_USER_OPENCODE_CONFIG"];
    if (override) return path.dirname(override);
    // Global opencode config: ~/.config/opencode/ (honor XDG_CONFIG_HOME when set, else ~/.config).
    return candidates.opencode;
  }
  if (runtime === "codex") {
    // codex --global routes to the standard Codex home. --dest remains an explicit override.
    // `candidates.codex` is built from the same `CODEX_HOME || ~/.codex` resolution as
    // `defaultCodexHome()` (see runtimeGlobalConfigCandidates above), so this is byte-identical
    // to calling `defaultCodexHome()` directly while keeping the candidate map the single
    // source of truth for "where does runtime X's global config live".
    return candidates.codex;
  }
  if (runtime === "pi") {
    // pi has no documented global config dir.
    // NOT_VERIFIED: fall back to workspace default and warn caller.
    return defaultDest(runtime);
  }
  return defaultDest(runtime);
}

type ConsoleConnectGatherResult = {
  telemetrySinks: TelemetrySink[];
  consoleUrl: string | undefined;
  consoleTokenValue: string | undefined;
  consoleTenant: string | undefined;
};

/**
 * Console-connect sink/credential gathering for interactiveOptions(),
 * extracted as a pure refactor (identical behavior, identical returned
 * shape) so interactiveOptions() itself stays a thin top-level orchestration.
 * Covers both branches of "did the caller already give --telemetry-sink(s)
 * on argv":
 *  - sinkFlagsGiven: the guided wizard is bypassed entirely (same as the old
 *    hidden sinkAnswer skip); only whichever of URL/token/tenant was not
 *    already supplied via flag gets its own prompt.
 *  - not given: the full guided wizard runs, with askWithFlagOverrides /
 *    askHiddenWithFlagOverrides short-circuiting any individual sub-prompt
 *    whose answer was already supplied via flag -- same flag-wins precedence
 *    as the sinkFlagsGiven branch, just applied per-sub-prompt instead of
 *    skipping the whole wizard.
 * Flag-wins-over-prompt precedence is unchanged from before this wizard
 * existed.
 */
async function gatherConsoleConnectOptions(
  rl: ReturnType<typeof createInterface>,
  args: ReturnType<typeof parseArgs>,
  consoleTokenFile: string | undefined,
): Promise<ConsoleConnectGatherResult> {
  const sinkFlagsGiven = flagList(args.flags, "telemetry-sink").length > 0 || flagList(args.flags, "telemetry-sinks").length > 0;
  const consoleUrlFlag = flagString(args.flags, "console-url");
  const consoleTenantFlag = flagString(args.flags, "console-tenant") ?? flagString(args.flags, "console-tenant-id");

  if (sinkFlagsGiven) {
    const telemetrySinks = telemetrySinksFromFlags(args.flags);
    const needsUserHostedUrl = telemetrySinks.includes("user-hosted-console") || telemetrySinks.includes("hosted-kontour-console");
    const consoleUrl = consoleUrlFlag ?? (needsUserHostedUrl ? await rl.question("User-hosted Console URL: ") : undefined);
    const consoleTokenValue = consoleTokenFile ? undefined : (needsConsoleCredentials(telemetrySinks) ? await questionHidden("Console telemetry token (blank to skip): ") : undefined);
    const consoleTenant = consoleTenantFlag ?? (needsConsoleCredentials(telemetrySinks) ? await rl.question("Console tenant ID (blank to skip): ") : undefined);
    return { telemetrySinks, consoleUrl, consoleTokenValue, consoleTenant };
  }

  const askWithFlagOverrides = async (prompt: string): Promise<string> => {
    if (prompt.includes("Self-hosted Console URL") && consoleUrlFlag !== undefined) return consoleUrlFlag;
    if (prompt.includes("Console tenant ID") && consoleTenantFlag !== undefined) return consoleTenantFlag;
    return rl.question(prompt);
  };
  const askHiddenWithFlagOverrides = async (prompt: string): Promise<string> => {
    if (consoleTokenFile) return "";
    return questionHidden(prompt);
  };
  const wizardResult = await runConsoleConnectWizard(
    { ask: askWithFlagOverrides, askHidden: askHiddenWithFlagOverrides },
    {
      hostedUrl: presetConsoleUrl("flow_agents_kontour_hosted_console_url", DEFAULT_HOSTED_CONSOLE_URL),
      localUrl: presetConsoleUrl("flow_agents_local_kontour_console_url", DEFAULT_LOCAL_CONSOLE_URL),
    },
  );
  for (const warning of wizardResult.warnings) console.warn(`flow-agents init: ${warning}`);
  return {
    telemetrySinks: wizardResult.telemetrySinks,
    consoleUrl: consoleUrlFlag ?? wizardResult.consoleUrl,
    consoleTokenValue: consoleTokenFile ? undefined : wizardResult.consoleTokenValue,
    consoleTenant: consoleTenantFlag ?? wizardResult.consoleTenant,
  };
}

async function interactiveOptions(argv: string[]): Promise<InitOptions> {
  const args = parseArgs(argv);
  const rl = createInterface({ input, output });
  try {
    const explicitRuntimeFlag = flagString(args.flags, "runtime");
    const runtimeDefault = normalizeRuntime(explicitRuntimeFlag) ?? detectDefaultRuntime();
    const runtimeAnswer = explicitRuntimeFlag ?? await rl.question(`Runtime [${runtimeDefault}]: `);
    const runtimeAnswerTrimmed = runtimeAnswer.trim();
    const runtime = normalizeRuntime(runtimeAnswerTrimmed || runtimeDefault) ?? runtimeDefault;
    // "(auto-detected)" is only accurate when the runtime was neither an
    // explicit --runtime flag nor a typed interactive answer AND the layered
    // detector actually matched a signal (not merely defaulted to "base").
    const runtimeAutoDetected = !explicitRuntimeFlag && !runtimeAnswerTrimmed && detectedRuntimeSignal() === runtime;
    const isGlobal = flagBool(args.flags, "global");
    const destBase = isGlobal ? globalDest(runtime) : defaultDest(runtime);
    const destDefault = flagString(args.flags, "dest", destBase) ?? destBase;
    const destAnswer = flagString(args.flags, "dest") ?? await rl.question(`Install destination [${destDefault}]: `);

    // Guided "Connect to Kontour Console?" wizard (Hosted/Local/Self-hosted/Skip)
    // replaces the old hidden sink-keyword prompt -- see gatherConsoleConnectOptions
    // for the flag-override / sink-flags-given branching.
    const consoleEndpoint = flagString(args.flags, "console-endpoint") ?? flagString(args.flags, "console-endpoint-url");
    const consoleTokenFile = flagString(args.flags, "console-token-file");
    const { telemetrySinks, consoleUrl, consoleTokenValue, consoleTenant } = await gatherConsoleConnectOptions(rl, args, consoleTokenFile);

    const activeKitIds = selectedKitIdsFromFlags(args.flags);
    if (!activeKitIds.length && !flagBool(args.flags, "activate-kits") && !flagList(args.flags, "activate-kit").length) {
      const available = catalogKitIds();
      if (available.length) {
        const answer = await rl.question(`Activate kits by id (comma-separated, default none) [none]: `);
        activeKitIds.push(...answer.split(",").map((id) => id.trim()).filter((id) => available.includes(id)));
      }
    }
    const configureProvidersFlag = flagBool(args.flags, "configure-providers");
    const configureProvidersAnswer = configureProvidersFlag
      ? "y"
      : await rl.question("Configure GitHub backlog, assignment, and change providers? [Y/n]: ");
    const configureProviders = configureProvidersFlag || !["n", "no"].includes(configureProvidersAnswer.trim().toLowerCase());
    const providerScopeAnswer = flagString(args.flags, "provider-scope")
      ?? (configureProviders ? (await rl.question("Provider settings scope [project/global] [project]: ")).trim() : undefined);
    const providerScope = configureProviders ? parseProviderScope(providerScopeAnswer || "project") : undefined;
    const providerOnlineFlag = flagBool(args.flags, "online");
    const providerOnlineAnswer = configureProviders && !providerOnlineFlag
      ? await rl.question("Verify github.com state and create the configured claim label if missing? [y/N]: ")
      : "";
    const providerOnline = configureProviders
      && (providerOnlineFlag || ["y", "yes"].includes(providerOnlineAnswer.trim().toLowerCase()));
    const providerProjectFlag = flagString(args.flags, "provider-project");
    const providerProjectAnswer = configureProviders && providerProjectFlag === undefined
      ? await rl.question(`GitHub Project number${providerOnline ? " (blank to discover)" : ""}: `)
      : providerProjectFlag;
    if (configureProviders && !providerOnline && !(providerProjectAnswer?.trim())) {
      throw new Error("offline provider setup requires a GitHub Project number");
    }
    return {
      runtime,
      runtimeAutoDetected,
      global: isGlobal,
      dest: path.resolve(destAnswer.trim() || destDefault),
      consoleUrl: consoleUrl?.trim() || undefined,
      consoleEndpoint: consoleEndpoint?.trim() || undefined,
      consoleTokenFile: consoleTokenFile?.trim() || undefined,
      consoleTokenValue: consoleTokenValue?.trim() || undefined,
      consoleTenant: consoleTenant?.trim() || undefined,
      telemetrySinks,
      activateKits: activeKitIds.length > 0,
      activeKitIds,
      configureProviders,
      providerScope,
      providerRepoPath: flagString(args.flags, "provider-repo-path"),
      providerProjectNumber: parseProviderProject(providerProjectAnswer?.trim() || undefined),
      providerOnline,
    };
  } finally {
    rl.close();
  }
}

function headlessOptions(argv: string[]): InitOptions {
  const args = parseArgs(argv);
  const runtime = normalizeRuntime(flagString(args.flags, "runtime")) ?? detectDefaultRuntime();
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
    activateKits: selectedKitIdsFromFlags(args.flags).length > 0,
    activeKitIds: selectedKitIdsFromFlags(args.flags),
    configureProviders: flagBool(args.flags, "configure-providers"),
    providerScope: flagBool(args.flags, "configure-providers") ? parseProviderScope(flagString(args.flags, "provider-scope")) : undefined,
    providerRepoPath: flagString(args.flags, "provider-repo-path"),
    providerProjectNumber: parseProviderProject(flagString(args.flags, "provider-project")),
    providerOnline: flagBool(args.flags, "online"),
  };
}

function configureWorkflowProviders(options: InitOptions): number {
  if (!options.configureProviders) return 0;
  const repoPath = path.resolve(options.providerRepoPath ?? (options.global ? process.cwd() : options.dest));
  const result = bootstrapProviders({
    scope: options.providerScope ?? "project",
    repoPath,
    projectSettingsRoot: options.providerScope === "project"
      ? path.join(options.global ? repoPath : options.dest, "context", "settings")
      : undefined,
    projectNumber: options.providerProjectNumber,
    online: options.providerOnline,
  });
  console.log(`Configured GitHub workflow providers for ${result.repo.owner}/${result.repo.name} (Project ${result.project.number})`);
  for (const file of result.files) console.log(`  ${file}`);
  if (result.offlineRemediation) console.warn(result.offlineRemediation);
  return 0;
}

export function ensureBundle(runtime: Runtime): string {
  return ensureBundleReporting(runtime).bundle;
}

/**
 * ensureBundle plus a `rebuilt` report so `init --dry-run` can disclose the one write it may
 * perform outside the destination (regenerating the package's own dist/ bundle).
 *
 * Rebuild when the installer is missing OR predates the overwrite guard's `--exclude-path`
 * support (kontourai/flow-agents#1288): a stale dist/ from an older build would reject the
 * exclude flags init now passes. The check is SEMANTIC (the rsync line must carry the
 * exclude-args expansion -- see installerSupportsPreserveExcludes), not a substring grep: an
 * installer that merely parses the flag but drops it from the rsync would silently overwrite
 * everything while accepting the arguments.
 */
export function ensureBundleReporting(runtime: Runtime): { bundle: string; rebuilt: boolean } {
  const bundle = path.join(root, "dist", runtimeBundles[runtime]);
  const installSh = path.join(bundle, "install.sh");
  let rebuilt = false;
  if (!fs.existsSync(installSh) || !installerSupportsPreserveExcludes(fs.readFileSync(installSh, "utf8"))) {
    const rc = buildBundles();
    if (rc !== 0) throw new Error(`bundle build failed with exit code ${rc}`);
    rebuilt = true;
  }
  if (!fs.existsSync(installSh)) throw new Error(`bundle installer missing: ${bundle}`);
  return { bundle, rebuilt };
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

// Relative paths install.sh's rsync excludes per runtime now live in install-plan.ts
// (bundleInstallExcludeRel), shared between the overwrite guard's plan walk and the
// project-scoped ownership manifest walk so both skip exactly what the rsync itself
// never unconditionally overwrites/owns as a plain file.

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

export type OpenCodeConfigBinding = {
  visiblePath: string;
  canonicalPath: string;
  trustedSymlinkRoot?: string;
  wasSymlink: boolean;
};

export function opencodeGlobalConfigPath(dest: string): string {
  const override = process.env["FLOW_AGENTS_USER_OPENCODE_CONFIG"];
  return override ? path.resolve(override) : path.join(dest, "opencode.json");
}

function assertPrivateOpenCodeBackingRoot(rootPath: string): void {
  const stat = fs.statSync(rootPath);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isDirectory()) throw new Error(`OpenCode config backing root is not a directory: ${rootPath}`);
  if (currentUid !== undefined && stat.uid !== currentUid) throw new Error(`OpenCode config backing root is not owned by the current user: ${rootPath}`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`OpenCode config backing root is group- or world-writable: ${rootPath}`);
}

/**
 * Bind a global OpenCode config link once, then write only its canonical file
 * target. The target's parent is deliberately the sole trusted backing root
 * passed to the ownership writer for direct Stow-style child links.
 */
export function resolveOpenCodeConfigBinding(visiblePath: string): OpenCodeConfigBinding {
  let visibleStat: fs.Stats;
  try {
    visibleStat = fs.lstatSync(visiblePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { visiblePath, canonicalPath: visiblePath, wasSymlink: false };
    }
    throw error;
  }
  if (!visibleStat.isSymbolicLink()) {
    if (!visibleStat.isFile()) throw new Error(`existing OpenCode config is not a regular file: ${visiblePath}`);
    return { visiblePath, canonicalPath: visiblePath, wasSymlink: false };
  }
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(visiblePath);
  } catch (error) {
    throw new Error(`OpenCode config symlink is not resolvable: ${visiblePath}: ${(error as Error).message}`);
  }
  if (!fs.lstatSync(canonicalPath).isFile()) throw new Error(`OpenCode config symlink target is not a regular file: ${visiblePath}`);
  assertPrivateOpenCodeBackingRoot(path.dirname(canonicalPath));
  return {
    visiblePath,
    canonicalPath,
    trustedSymlinkRoot: path.dirname(canonicalPath),
    wasSymlink: true,
  };
}

export function revalidateOpenCodeConfigBinding(binding: OpenCodeConfigBinding): void {
  if (binding.wasSymlink) {
    const stat = fs.lstatSync(binding.visiblePath);
    if (!stat.isSymbolicLink()) throw new Error(`OpenCode config symlink changed during install: ${binding.visiblePath}`);
    if (fs.realpathSync(binding.visiblePath) !== binding.canonicalPath) {
      throw new Error(`OpenCode config symlink target changed during install: ${binding.visiblePath}`);
    }
  }
  let canonicalStat: fs.Stats | undefined;
  try {
    canonicalStat = fs.lstatSync(binding.canonicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!binding.wasSymlink && canonicalStat?.isSymbolicLink()) {
    throw new Error(`OpenCode config path became a symlink during install: ${binding.canonicalPath}`);
  }
  if (canonicalStat && !canonicalStat.isFile()) {
    throw new Error(`OpenCode config write target is not a regular file: ${binding.canonicalPath}`);
  }
}

function writeJsonAtomic(target: string, value: unknown): void {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.flow-agents-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`OpenCode config write target is not a regular file: ${target}`);
    mode = stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function stampConfigPremergePostInstallHash(premerge: unknown, configPath: string): unknown {
  if (!premerge || typeof premerge !== "object") return premerge;
  return {
    ...(premerge as Record<string, unknown>),
    post_install_sha256: crypto.createHash("sha256").update(fs.readFileSync(configPath)).digest("hex"),
  };
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

function resolveOpencodeSkillNames(bundle: string, skillsSource: string, activeKitIds: string[]): string[] {
  const selected = new Set<string>();
  const coreSkills = path.join(bundle, "skills");
  for (const entry of fs.readdirSync(coreSkills, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(coreSkills, entry.name, "SKILL.md"))) selected.add(entry.name);
  }
  const visited = new Set<string>();
  const visit = (kitId: string): void => {
    if (visited.has(kitId)) return;
    visited.add(kitId);
    const kitRoot = path.join(bundle, "kits", kitId);
    const manifestPath = path.join(kitRoot, "kit.json");
    if (!fs.existsSync(manifestPath)) throw new Error(`activated OpenCode kit is missing its manifest: ${kitId}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { id?: unknown; skills?: unknown; dependencies?: unknown };
    if (manifest.id !== kitId) throw new Error(`activated OpenCode kit manifest identity mismatch: ${kitId}`);
    if (Array.isArray(manifest.skills)) {
      for (const skill of manifest.skills) {
        if (!skill || typeof skill !== "object") throw new Error(`activated OpenCode kit has an invalid skill: ${kitId}`);
        const skillPath = (skill as Record<string, unknown>)["path"];
        if (typeof skillPath !== "string" || path.basename(skillPath) !== "SKILL.md") throw new Error(`activated OpenCode kit has an invalid skill: ${kitId}`);
        const skillName = path.basename(path.dirname(skillPath));
        const exportedSkill = path.join(skillsSource, skillName, "SKILL.md");
        if (!fs.existsSync(exportedSkill)) throw new Error(`activated OpenCode kit skill is missing from the runtime export: ${kitId}/${skillName}`);
        selected.add(skillName);
      }
    }
    if (Array.isArray(manifest.dependencies)) {
      for (const dependency of manifest.dependencies) {
        if (!dependency || typeof dependency !== "object") throw new Error(`activated OpenCode kit has an invalid dependency: ${kitId}`);
        const dependencyId = (dependency as Record<string, unknown>)["kit_id"];
        if (typeof dependencyId !== "string" || dependencyId.length === 0) throw new Error(`activated OpenCode kit has an invalid dependency: ${kitId}`);
        visit(dependencyId);
      }
    }
  };
  for (const kitId of activeKitIds) visit(kitId);
  const skillNames = [...selected].sort();
  for (const skillName of skillNames) {
    const skillPath = path.join(skillsSource, skillName, "SKILL.md");
    const content = fs.readFileSync(skillPath, "utf8");
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!frontmatter || !frontmatter[1].split(/\r?\n/).some((line) => line.match(/^name:\s*["']?([^"']+)["']?\s*$/)?.[1] === skillName)) {
      throw new Error(`generated OpenCode skill is corrupt or has the wrong identity: ${skillName}`);
    }
  }
  return skillNames;
}

function stageOpenCodeRuntimeAsset(source: string, destinationRelative: string, overlay: string): number {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`generated OpenCode asset must not be a symlink: ${source}`);
  if (stat.isDirectory()) {
    return fs.readdirSync(source).sort().reduce(
      (count, name) => count + stageOpenCodeRuntimeAsset(path.join(source, name), path.join(destinationRelative, name), overlay),
      0,
    );
  }
  if (!stat.isFile()) throw new Error(`generated OpenCode asset must be a regular file: ${source}`);
  const destination = path.join(overlay, destinationRelative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, stat.mode & 0o777);
  return 1;
}

function addOpenCodePortableAssets(
  source: string,
  destinationRelative: string,
  kind: PortableAsset["kind"],
  overlay: string,
  assetSources: Map<string, string>,
  assets: PortableAsset[],
): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`generated OpenCode asset must not be a symlink: ${source}`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(source).sort()) {
      addOpenCodePortableAssets(path.join(source, name), path.join(destinationRelative, name), kind, overlay, assetSources, assets);
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`generated OpenCode asset must be a regular file: ${source}`);
  const target = path.resolve(overlay, ...destinationRelative.split("/"));
  const relative = path.relative(overlay, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`generated OpenCode asset has an unsafe destination: ${destinationRelative}`);
  if (assetSources.has(target)) throw new Error(`generated OpenCode asset has a duplicate destination: ${destinationRelative}`);
  assetSources.set(target, source);
  assets.push({ id: destinationRelative, kind, content: fs.readFileSync(source, "utf8"), targetHint: destinationRelative });
}

async function stageOpenCodeConduitAssets(bundle: string, skillNames: string[], overlay: string): Promise<InstallationReceipt> {
  const assetSources = new Map<string, string>();
  const assets: PortableAsset[] = [];
  addOpenCodePortableAssets(path.join(bundle, ".opencode", "plugins", "flow-agents.js"), "plugins/flow-agents.js", "hook", overlay, assetSources, assets);
  addOpenCodePortableAssets(path.join(bundle, ".opencode", "agents"), "agents", "agent", overlay, assetSources, assets);
  for (const skillName of skillNames) {
    addOpenCodePortableAssets(path.join(bundle, ".opencode", "skills", skillName), path.join("skills", skillName), "skill", overlay, assetSources, assets);
  }
  const conduit = createOpenCodeAdapter({
    resolveTarget: (asset) => asset.targetHint ? path.resolve(overlay, ...asset.targetHint.split("/")) : undefined,
    write: (target, content) => {
      const source = assetSources.get(target);
      if (!source) throw new Error(`Conduit attempted to write an unbound OpenCode asset: ${target}`);
      if (content !== fs.readFileSync(source, "utf8")) throw new Error(`Conduit content changed before staging: ${source}`);
      const stat = fs.lstatSync(source);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
      fs.chmodSync(target, stat.mode & 0o777);
    },
  });
  const receipt = await conduit.install(assets);
  if (receipt.skipped.length > 0 || receipt.installed.length !== assets.length) throw new Error("Conduit did not stage every required OpenCode asset");
  return receipt;
}

function installOpenCodeOverlay(overlay: string, dest: string, metadata: string, trustedSymlinkRoot?: string): void {
  const installerArgs = [path.join(root, "scripts", "install-owned-files.js"), overlay, dest, ".flow-agents/runtime-assets.json", "--metadata-json", metadata];
  if (trustedSymlinkRoot) {
    installerArgs.push(
      "--trusted-symlink-root", trustedSymlinkRoot,
      "--trusted-symlink-child", "plugins",
      "--trusted-symlink-child", "agents",
      "--trusted-symlink-child", "skills",
    );
  }
  const result = spawnSync(process.execPath, installerArgs, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `OpenCode runtime asset install failed with exit code ${result.status ?? "unknown"}`);
}

async function installOpencodeGlobalAssets(dest: string, bundle: string, runtimeSources: string[], runtimeFiles: string[], skillNames: string[], activeKitIds: string[], trustedSymlinkRoot?: string): Promise<number> {
  const overlay = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-opencode-"));
  try {
    const receipt = await stageOpenCodeConduitAssets(bundle, skillNames, overlay);
    let fileCount = 0;
    for (const entry of [...runtimeSources, ...runtimeFiles]) {
      fileCount += stageOpenCodeRuntimeAsset(path.join(bundle, entry), path.join(".flow-agents", "runtime", entry), overlay);
    }
    const pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, string>;
    const metadata = JSON.stringify({ runtime: "opencode", package_version: pkgJson["version"] ?? "0.0.0", active_kit_ids: activeKitIds, conduit_receipt: receipt });
    installOpenCodeOverlay(overlay, dest, metadata, trustedSymlinkRoot);
    return fileCount + receipt.installed.length;
  } finally {
    fs.rmSync(overlay, { recursive: true, force: true });
  }
}

function installBundle(bundle: string, options: InitOptions, preservedRelPaths: string[] = []): number {
  const args = ["install.sh", options.dest];
  // Overwrite guard (#1288): paths the install plan classified as "preserve" are
  // excluded from install.sh's rsync entirely, so the copy never touches them. Raw
  // relative paths -- install.sh itself escapes rsync wildcard characters, so the same
  // literal value also scopes its token substitution and console-config guards.
  for (const rel of preservedRelPaths) args.push("--exclude-path", rel);
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

function kitPathForInit(kitId: string, dest: string): string | null {
  const catalogPath = path.join(root, "kits", "catalog.json");
  if (fs.existsSync(catalogPath)) {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as { kits?: unknown[] };
    const entry = Array.isArray(catalog.kits)
      ? catalog.kits.find((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).id === kitId)
      : undefined;
    const rel = entry && typeof entry === "object" ? (entry as Record<string, unknown>).path : undefined;
    if (typeof rel === "string") return path.resolve(root, rel);
  }
  const installed = path.join(dest, "kits", "local", "repositories", kitId);
  return fs.existsSync(installed) ? installed : null;
}

async function activateKits(options: InitOptions): Promise<number> {
  const activeKitIds = options.activeKitIds ?? [];
  if (!options.activateKits || activeKitIds.length === 0 || options.runtime !== "codex") return 0;
  const result = activateCodexLocal(options.dest, options.dest, { kitIdFilter: activeKitIds });
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    console.error(JSON.stringify(result, null, 2));
    return 1;
  }
  const generated = Array.isArray(result.generated_runtime_files) ? result.generated_runtime_files : [];
  console.log(`Activated ${generated.length} Codex local runtime asset(s)`);
  for (const kitId of activeKitIds) {
    const kitDir = kitPathForInit(kitId, options.dest);
    if (!kitDir) throw new Error(`activated kit '${kitId}' could not be resolved for provisioning`);
    try {
      const provisioned = await provisionKit(kitDir, options.dest);
      if (provisioned.files.length > 0) console.log(`Provisioned ${provisioned.files.length} file(s) from kit '${kitId}'`);
    } catch (error) {
      if (!(error instanceof ProvisionConflictError)) throw error;
      for (const conflict of error.conflicts) {
        console.warn(`flow-agents init: warning: skipped existing provision '${conflict.target}' from kit '${kitId}'`);
      }
    }
  }
  return 0;
}

/**
 * Headless counterpart of interactiveOptions()'s inline `runtimeAutoDetected`
 * computation. headlessOptions() itself is untouched (see its doc note) --
 * this is computed separately in main() and merged onto its result, so the
 * "(auto-detected)" annotation applies to both install paths without adding
 * a new required prompt or changing headlessOptions()'s own behavior.
 */
function headlessRuntimeAutoDetected(argv: string[]): boolean {
  const args = parseArgs(argv);
  if (flagString(args.flags, "runtime")) return false;
  return detectedRuntimeSignal() !== "unknown";
}

/**
 * G2 auto-verify + G3 post-install summary, shared by both the headless and
 * interactive install paths (applies identically regardless of which one
 * reached main()'s successful non-global install tail). Calls
 * telemetry-doctor.ts's buildReport() in-process against the endpoint
 * install-console-config.sh just wrote. Never allowed to change the exit
 * code or hang the install: buildReport already has its own bounded default
 * reachability timeout (2000ms unless overridden), and any thrown/rejected
 * error here is caught and downgraded to a warning line only.
 */
async function printPostInstallSummary(options: InitOptions): Promise<void> {
  let doctorConsole: {
    sink: "local-only" | "console";
    reachability: { checked: boolean; ok: boolean | null; error?: string; statusCode?: number };
  } = { sink: "local-only", reachability: { checked: false, ok: null } };
  let tokenConfigured = false;
  let tenantConfigured = false;
  try {
    const report = await buildReport(["--dest", options.dest]);
    doctorConsole = report.console;
    tokenConfigured = report.console.tokenConfigured;
    tenantConfigured = report.console.tenantConfigured;
  } catch (error) {
    console.warn(`flow-agents init: WARNING: could not verify the Console connection: ${(error as Error).message} (telemetry still installed; run 'flow-agents telemetry-doctor' to re-check).`);
  }
  const consoleStatus = describeConsoleStatus({ console: doctorConsole });
  const nextSteps = [`Run your agent inside ${options.dest} -- Flow Agents hooks are already wired.`];
  if (consoleStatus.status !== "local-only") {
    nextSteps.push("Telemetry now flows to Kontour Console; visit the Console for ROI/economics views.");
  }
  // Only for the "reachability was never attempted" case (self-hosted/BYO
  // HTTPS hosts default to not-allowed without --allow-network) -- never for
  // local-only (nothing to verify) or the already-verified case (nothing left
  // to do). doctorConsole.reachability.checked is the same raw signal
  // describeConsoleStatus used to pick its NOT_CHECKED_DETAIL branch, so this
  // stays in sync with that classifier without re-parsing its detail string.
  if (consoleStatus.status === "connected-unverified" && doctorConsole.reachability.checked === false) {
    nextSteps.push("Self-hosted/BYO Console reachability was not checked; run `flow-agents telemetry-doctor --allow-network` to verify it.");
  }
  nextSteps.push("Re-run `flow-agents init` anytime to reconfigure runtime, destination, or Console connection.");
  const summaryLines = buildPostInstallSummaryLines({
    runtime: options.runtime,
    runtimeAutoDetected: Boolean(options.runtimeAutoDetected),
    dest: options.dest,
    telemetrySinks: options.telemetrySinks,
    consoleStatus,
    tokenConfigured,
    tenantConfigured,
    nextSteps,
  });
  for (const line of summaryLines) console.log(line);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  // `flow-agents init --uninstall --runtime claude-code [--global | --dest PATH]` removes what
  // a prior claude-code install wrote. Dispatched here (rather than as its own top-level
  // subcommand) so it stays discoverable from `flow-agents init --help` and shares init's own
  // flag surface (--runtime, --global, --dest, --yes/--headless); the implementation itself
  // lives in uninstall.ts, which owns its own --help/usage.
  if (argv.includes("--uninstall")) {
    const { main: uninstallMain } = await import("./uninstall.js");
    return uninstallMain(argv.filter((arg) => arg !== "--uninstall"));
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return 0;
  }
  // Read as bare argv membership (not parseArgs) so a following positional can never be
  // swallowed as the flag's value: `--dry-run` and `--force` are always boolean.
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  // --dry-run implies headless: a preview must never prompt.
  const headless = argv.includes("--yes") || argv.includes("--headless") || dryRun || !process.stdin.isTTY;
  try {
    const options = headless
      ? { ...headlessOptions(argv), runtimeAutoDetected: headlessRuntimeAutoDetected(argv) }
      : await interactiveOptions(argv);
    // The overwrite guard covers project (bundle rsync) installs and the --global
    // claude-code skills/agents sync (#1288 review BLOCKING-2). The --global codex and
    // opencode paths delegate to installers that already fail closed on unowned collisions
    // (install-codex-home.sh / install-owned-files.js refuse rather than overwrite), so
    // --dry-run/--force have no meaning there; refusing the flags is honest, silently
    // ignoring them is not. (pi --global falls through to a workspace install and keeps
    // full flag support.)
    if ((dryRun || force) && options.global && (options.runtime === "codex" || options.runtime === "opencode")) {
      console.error(`flow-agents init: --dry-run and --force are not supported with --global for ${options.runtime} (its installer already refuses unowned collisions instead of overwriting)`);
      return 2;
    }
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
      const { bundle, rebuilt } = ensureBundleReporting(options.runtime);
      // For --global, dest is ~/.claude/ (the global settings dir).
      // dogfoodClaudeCode writes to dest/.claude/settings.json — but for global,
      // the settings.json lives at dest/settings.json (dest IS ~/.claude/).
      // We use a special global-merge path: merge directly into dest/settings.json.
      const sourcePath = path.join(bundle, ".claude", "settings.json");
      if (!fs.existsSync(sourcePath)) {
        console.error(`flow-agents init: bundle settings missing: ${sourcePath}`);
        return 1;
      }
      // #1288 review BLOCKING-2: the skills/agents sync used to be copyDirMerge, which
      // overwrote every differing collision (a user-authored ~/.claude/agents file was
      // replaced with no classification and no --force). It now runs through the same
      // ownership plan as project installs: unowned differing files are preserved and
      // reported, stale bundle-owned files (hash-matching the previous install's global
      // ownership manifest) update without --force, and --force overrides preserves.
      // Removals stay disabled here: the historical sync was additive-only and ~/.claude
      // holds unrelated user content; deletion would be new destructive surface.
      // Intermediate symlinks are tolerated (refuseSymlinkParents: false): the legacy
      // skills chain (~/.claude/skills/<name> -> ~/.agents/skills/<name>) is a supported
      // layout this writer has always updated through, and this path copies files itself
      // (no rsync that would replace the link object).
      const globalPlan = computeInstallPlan({
        mappings: [
          { sourceDir: path.join(bundle, ".claude", "skills"), destDir: path.join(options.dest, "skills"), prefix: "skills" },
          { sourceDir: path.join(bundle, ".claude", "agents"), destDir: path.join(options.dest, "agents"), prefix: "agents" },
        ],
        manifestDest: options.dest,
        excludeRel: new Set<string>(),
        force,
        removals: false,
        refuseSymlinkParents: false,
      });
      if (dryRun) {
        for (const line of formatDryRunLines(globalPlan, `${options.runtime} --global skills/agents`, options.dest)) console.log(line);
        console.log("Note: settings.json is merge-owned (hooks merged into your existing settings; user keys preserved) and is not part of the file plan above.");
        if (rebuilt) console.log("Note: rebuilt the claude-code bundle in the package dist/ to compute this plan (outside the destination).");
        return 0;
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
      const { mergeSettings, captureConfigPremerge, installedValues } = _require(installMergePath) as { mergeSettings: MergeSettingsFn; captureConfigPremerge: (configPath: string) => unknown; installedValues: (configPath: string, merged: Record<string, unknown>, managed: Record<string, unknown>) => unknown };
      const configPremerge = { ...(captureConfigPremerge(destSettingsPath) as Record<string, unknown>), runtime: "claude-code" };
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(destSettingsPath)) {
        try { existing = JSON.parse(fs.readFileSync(destSettingsPath, "utf8")) as Record<string, unknown>; } catch { existing = {}; }
      }
      const merged = mergeInstallSettings(mergeSettings, existing, managed);
      const tmp = `${destSettingsPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, destSettingsPath);
      // HIGH-3 posture: revalidate the plan's decisions immediately before applying them.
      verifyInstallPlanMatchesDisk(globalPlan, {
        mappings: [
          { sourceDir: path.join(bundle, ".claude", "skills"), destDir: path.join(options.dest, "skills"), prefix: "skills" },
          { sourceDir: path.join(bundle, ".claude", "agents"), destDir: path.join(options.dest, "agents"), prefix: "agents" },
        ],
        manifestDest: options.dest,
        excludeRel: new Set<string>(),
        force,
        removals: false,
        refuseSymlinkParents: false,
      });
      executePlanCopies(globalPlan);
      // Write version stamp.
      writeInstallRecord(options.dest, "claude-code", true, options.activeKitIds ?? [], { ...configPremerge, post_install_sha256: crypto.createHash("sha256").update(fs.readFileSync(destSettingsPath)).digest("hex") }, [], installedValues(destSettingsPath, merged, managed));
      console.log(`Flow Agents global hooks merged for claude-code in ${options.dest}`);
      for (const line of formatInstallSummaryLines(globalPlan, options.dest)) console.log(line);
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
      // Write the ownership manifest `flow-agents init --uninstall` reads back (kontourai/flow-agents#uninstall).
      // Derived from the bundle SOURCE trees (never dest), so it can never misattribute a
      // pre-existing dest entry (e.g. a legacy skill symlink) that this install did not itself
      // write. settings.json is intentionally excluded -- it is merge-owned, not file-owned;
      // uninstall strips only the managed hook/statusLine entries from it (see uninstall.ts).
      // Paths the guard PRESERVED are excluded too: their on-disk content is the user's, and
      // recording it as bundle-owned would authorize the next init to overwrite it.
      const globalManifestPkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, string>;
      writeOwnedFilesManifest(options.dest, buildOwnedFilesManifest({
        mappings: [
          { sourceDir: path.join(bundle, ".claude", "skills"), destDir: path.join(options.dest, "skills"), prefix: "skills" },
          { sourceDir: path.join(bundle, ".claude", "agents"), destDir: path.join(options.dest, "agents"), prefix: "agents" },
        ],
        excludeRel: new Set(globalPlan.preserved),
        runtime: "claude-code",
        version: globalManifestPkgJson["version"] ?? "0.0.0",
        global: true,
      }));
      return configureWorkflowProviders(options);
    }
    // --global for opencode: merge config and sync the runtime assets OpenCode discovers globally.
    // Global path: ~/.config/opencode/opencode.json (honor XDG_CONFIG_HOME).
    // Test isolation: FLOW_AGENTS_USER_OPENCODE_CONFIG points to the opencode.json FILE.
    if (options.global && options.runtime === "opencode") {
      const bundle = ensureBundle(options.runtime);
      const sourcePath = path.join(bundle, "opencode.json");
      const pluginSource = path.join(bundle, ".opencode", "plugins", "flow-agents.js");
      const agentsSource = path.join(bundle, ".opencode", "agents");
      const skillsSource = path.join(bundle, ".opencode", "skills");
      const runtimeSources = ["build", "context", "kits", "packaging", "schemas", "scripts"];
      const runtimeFiles = ["AGENTS.md", "console.telemetry.json"];
      const requiredSources = [sourcePath, pluginSource, agentsSource, skillsSource, ...runtimeSources.map((entry) => path.join(bundle, entry)), ...runtimeFiles.map((entry) => path.join(bundle, entry))];
      const missingSource = requiredSources.find((entry) => !fs.existsSync(entry));
      if (missingSource) {
        console.error(`flow-agents init: bundle OpenCode asset missing: ${missingSource}`);
        return 1;
      }
      const pluginCheck = spawnSync(process.execPath, ["--check", pluginSource], { encoding: "utf8" });
      if (pluginCheck.status !== 0 || !fs.readFileSync(pluginSource, "utf8").includes("export const FlowAgentsPlugin")) {
        console.error(`flow-agents init: generated OpenCode plugin is corrupt: ${pluginCheck.stderr.trim()}`);
        return 1;
      }
      const skillNames = resolveOpencodeSkillNames(bundle, skillsSource, options.activeKitIds ?? []);
      const managed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
      fs.mkdirSync(options.dest, { recursive: true });
      const runtimeRoot = path.join(options.dest, ".flow-agents", "runtime");
      managed["instructions"] = [path.join(runtimeRoot, "AGENTS.md")];
      // Bind the host-visible config symlink before any host mutation. Its
      // canonical target is the only config file we ever replace, while the
      // host-visible config root remains the OpenCode discovery root.
      const configBinding = resolveOpenCodeConfigBinding(opencodeGlobalConfigPath(options.dest));
      const installMergePath = path.join(root, "scripts", "install-merge.js");
      const _require = createRequire(import.meta.url);
      const { mergeSettings, captureConfigPremerge, installedValues } = _require(installMergePath) as { mergeSettings: MergeSettingsFn; captureConfigPremerge: (configPath: string) => unknown; installedValues: (configPath: string, merged: Record<string, unknown>, managed: Record<string, unknown>) => unknown };
      const configPremerge = { ...(captureConfigPremerge(configBinding.canonicalPath) as Record<string, unknown>), runtime: "opencode" };
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(configBinding.canonicalPath)) {
        try {
          existing = JSON.parse(fs.readFileSync(configBinding.canonicalPath, "utf8")) as Record<string, unknown>;
        } catch (error) {
          throw new Error(`existing OpenCode config is invalid JSON; refusing to replace it: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const merged = mergeInstallSettings(mergeSettings, existing, managed);
      const existingInstructions = existing["instructions"];
      if (existingInstructions !== undefined && (!Array.isArray(existingInstructions) || existingInstructions.some((entry) => typeof entry !== "string"))) {
        throw new Error("existing OpenCode instructions must be an array of strings");
      }
      const managedInstructions = managed["instructions"] as string[];
      merged["instructions"] = [...new Set([...(existingInstructions as string[] | undefined ?? []), ...managedInstructions])];
      const installedAssetCount = await installOpencodeGlobalAssets(
        options.dest,
        bundle,
        runtimeSources,
        runtimeFiles,
        skillNames,
        options.activeKitIds ?? [],
        configBinding.trustedSymlinkRoot,
      );
      revalidateOpenCodeConfigBinding(configBinding);
      writeJsonAtomic(configBinding.canonicalPath, merged);
      // Stamp only after every required runtime asset and its content manifest exist.
      writeInstallRecord(options.dest, "opencode", true, options.activeKitIds ?? [], stampConfigPremergePostInstallHash(configPremerge, configBinding.canonicalPath), configBinding.trustedSymlinkRoot ? [fs.realpathSync(configBinding.trustedSymlinkRoot)] : [], installedValues(configBinding.canonicalPath, merged, managed));
      console.log(`Flow Agents global config and runtime assets synced for opencode in ${options.dest}`);
      console.log(`Reconciled ${installedAssetCount} managed runtime files and ${skillNames.length} discoverable skills`);
      return configureWorkflowProviders(options);
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
      writeInstallRecord(options.dest, "codex", true, options.activeKitIds ?? []);
      const activated = await activateKits(options);
      return activated === 0 ? configureWorkflowProviders(options) : activated;
    }
    // --global for pi: NOT_VERIFIED (no documented global dir). Warn and fall through to workspace install.
    if (options.global && options.runtime === "pi") {
      console.warn(
        `flow-agents init: NOT_VERIFIED: pi has no documented global config directory. ` +
        `The --global flag for pi is not verified against pi documentation. ` +
        `Falling back to workspace default destination: ${options.dest}`
      );
    }
    const { bundle, rebuilt } = ensureBundleReporting(options.runtime);
    // Overwrite guard (#1288): classify every bundle path against the destination BEFORE
    // any write. Existing files that are not known bundle-owned content (no hash match
    // against the incoming bundle or the previous install's ownership manifest) are
    // preserved -- excluded from the rsync -- unless --force explicitly overrides.
    // Removals are manifest-driven only (previously-owned, absent from the bundle, bytes
    // still matching -- replacing kiro's blanket `rsync --delete`), and any bundle path
    // whose destination parent is a symlinked directory refuses the whole install
    // (InstallPlanSymlinkParentError) before anything is written.
    const excludeRel = bundleInstallExcludeRel(options.runtime);
    const planParams = {
      mappings: [{ sourceDir: bundle, destDir: options.dest, prefix: "" }],
      manifestDest: options.dest,
      excludeRel,
      force,
      removals: true,
      refuseSymlinkParents: true,
    };
    const plan = computeInstallPlan(planParams);
    if (dryRun) {
      for (const line of formatDryRunLines(plan, options.runtime, options.dest)) console.log(line);
      if (rebuilt) console.log(`Note: rebuilt the ${options.runtime} bundle in the package dist/ to compute this plan (outside the destination).`);
      return 0;
    }
    // #1288 review HIGH-3: re-derive the plan immediately before the installer runs and
    // refuse on any divergence, so a file created or modified in the classify->install
    // window is never overwritten under a stale decision.
    verifyInstallPlanMatchesDisk(plan, planParams);
    const installed = installBundle(bundle, options, plan.preserved);
    if (installed !== 0) return installed;
    // Manifest-driven stale-owned cleanup (BLOCKING-1): each candidate is re-contained and
    // re-hashed immediately before deletion; anything that changed is preserved instead.
    const executedRemovals = executePlanRemovals(plan, options.dest);
    // Project bundle installers create the merge snapshot themselves. Forward it
    // into the richer outer record instead of erasing provenance on return.
    let configPremerge: unknown;
    let installedValues: unknown;
    try {
      const generated = JSON.parse(fs.readFileSync(durableInstallRecordPath(options.dest), "utf8")) as Record<string, unknown>;
      configPremerge = generated["config_premerge"];
      installedValues = generated["installed_values"];
    } catch { /* runtimes without a merged config have no snapshot */ }
    ensureArtifactResidueIgnored(options.dest);
    writeInstallRecord(options.dest, options.runtime, options.global, options.activeKitIds ?? [], configPremerge, [], installedValues);
    // Every project bundle install writes the ownership manifest `flow-agents init
    // --uninstall` (claude-code) reads back -- and, since #1288, the manifest is ALSO what
    // lets the NEXT init recognize stale bundle-owned files and update them without
    // --force (the upgrade path). Historically only claude-code wrote it; base/codex/
    // opencode/kiro/pi project installs write it too now, or their upgrade path would
    // preserve every stale bundle file forever. The source tree is the whole bundle root,
    // matching exactly what install.sh's rsync copies into dest (bundleInstallExcludeRel
    // mirrors installScript()'s exclude list -- merge-owned configs are merge-owned, not
    // file-owned). Paths the guard PRESERVED are excluded too: their on-disk content is
    // the user's, and recording it as bundle-owned would authorize the next init to
    // overwrite it.
    {
      const projectManifestPkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, string>;
      writeOwnedFilesManifest(options.dest, buildOwnedFilesManifest({
        mappings: [{ sourceDir: bundle, destDir: options.dest, prefix: "" }],
        excludeRel: new Set([...excludeRel, ...plan.preserved]),
        runtime: options.runtime,
        version: projectManifestPkgJson["version"] ?? "0.0.0",
        global: false,
      }));
    }
    // #1288: a silent no-op and a 191-file overwrite must not both read as a bare success.
    for (const line of formatInstallSummaryLines(plan, options.dest, executedRemovals)) console.log(line);
    const activated = await activateKits(options);
    // G2/G3: shared post-install auto-verify + summary tail. Applies
    // identically whether main() reached here via headlessOptions() or
    // interactiveOptions() -- never changes `activated`'s exit code.
    await printPostInstallSummary(options);
    return activated === 0 ? configureWorkflowProviders(options) : activated;
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
