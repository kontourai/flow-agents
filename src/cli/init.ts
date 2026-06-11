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
      if (text === "\u0003") {
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
      if (text === "\u007f") {
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
    const bundle = ensureBundle(options.runtime);
    const installed = installBundle(bundle, options);
    if (installed !== 0) return installed;
    return activateKits(options);
  } catch (error) {
    console.error(`flow-agents init: ${(error as Error).message}`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
