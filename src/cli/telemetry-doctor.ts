import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs, flagBool, flagString } from "../lib/args.js";
import { telemetryDataDir as defaultTelemetryDataDir } from "../lib/local-artifact-root.js";

type Config = Record<string, string>;

type Reachability = {
  checked: boolean;
  ok: boolean | null;
  statusCode?: number;
  error?: string;
};

export type DoctorReport = {
  ok: boolean;
  destination: string;
  telemetry: {
    configFile: string;
    configExists: boolean;
    enabled: boolean;
    dataDir: string;
    sessionDir: string;
    channels: Array<{ name: string; logFile?: string; endpointUrl?: string; active: boolean }>;
    activeSinks: string[];
  };
  console: {
    sink: "local-only" | "console";
    url?: string;
    endpointUrl?: string;
    endpointAllowed: boolean;
    tokenConfigured: boolean;
    tenantConfigured: boolean;
    /**
     * WHERE each Console value came from, not merely whether one exists.
     *
     * `tokenConfigured: true` alone cannot answer "did this install configure Console?" --
     * it is equally true of an ambient machine-wide credential in
     * ~/.flow-agents/telemetry-console.conf or an exported environment variable. That
     * conflation is what made `init` print "Console: connected + verified / token
     * configured / tenant configured" for an install run with `--telemetry-sink
     * local-files` into a repo whose own telemetry.conf had both values commented out
     * (kontourai/flow-agents#1344): the doctor resolved the user-global conf, and the
     * summary reported that resolution as this install's outcome.
     *
     * Callers that report on a specific install must combine these with `configFile` (see
     * `configFileScope`) rather than reading a bare boolean.
     */
    tokenSource: ConsoleValueSource;
    tenantSource: ConsoleValueSource;
    urlSource: ConsoleValueSource;
    reachability: Reachability;
  };
  warnings: string[];
};

/** Provenance of a resolved Console value. "absent" means nothing set it anywhere. */
export type ConsoleValueSource = "environment" | "config-file" | "absent";

function valueSource(envValue: string | undefined, configValue: string | undefined): ConsoleValueSource {
  if (envValue !== undefined && envValue !== "") return "environment";
  if (configValue !== undefined && configValue !== "") return "config-file";
  return "absent";
}

const defaultChannels = "full";
const sensitiveQueryKeys = new Set(["token", "api_key", "apikey", "key", "secret", "password", "auth", "authorization", "access_token"]);

function usage(): void {
  console.error(`usage: flow-agents telemetry-doctor [options]

Options:
  --dest PATH       Installed Flow Agents root. Defaults to current directory.
  --json           Emit machine-readable JSON.
  --headless       Do not prompt; suitable for CI.
  --timeout-ms N   Console reachability timeout. Defaults to 2000.
  --allow-network  Allow reachability checks to non-local HTTPS Console hosts.
`);
}

function readConfig(file: string): Config {
  if (!fs.existsSync(file)) return {};
  const config: Config = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) config[key] = value;
  }
  return config;
}

function configValue(config: Config, envName: string, key: string, fallback = ""): string {
  return process.env[envName] ?? config[key] ?? fallback;
}

function channelEnvName(channel: string, key: string): string {
  return `TELEMETRY_CHANNEL_${channel.toUpperCase()}_${key.toUpperCase()}`;
}

function channelConfigValue(config: Config, channel: string, key: string, fallback = ""): string {
  const envName = channelEnvName(channel, key);
  return process.env[envName] ?? config[`channel.${channel}.${key}`] ?? fallback;
}

function telemetryDataDir(dest: string): string {
  const configured = process.env.TELEMETRY_DATA_DIR;
  return configured ? path.resolve(dest, configured) : defaultTelemetryDataDir(dest);
}

function deriveConsoleEndpoint(consoleUrl: string, explicitEndpoint: string): string {
  if (explicitEndpoint) return explicitEndpoint;
  if (!consoleUrl) return "";
  const base = consoleUrl.replace(/\/+$/, "");
  if (base.endsWith("/api/telemetry/records")) return base;
  if (base.endsWith("/api/telemetry")) return `${base}/records`;
  return `${base}/api/telemetry/records`;
}

// The one known hosted Kontour Console host is reachability-checkable by
// default (no --allow-network): reuses the exact override knob
// scripts/telemetry/console-presets.sh already defines
// (FLOW_AGENTS_KONTOUR_CLOUD_CONSOLE_URL / https://console.kontourai.io), so
// it self-corrects if that default ever changes rather than drifting via a
// second hardcoded literal. Scoped to this one hostname only -- a generic
// non-local HTTPS endpoint still requires --allow-network exactly as today.
function isKnownHostedConsoleHostname(hostname: string): boolean {
  const hostedUrl = parseUrl(process.env["FLOW_AGENTS_KONTOUR_CLOUD_CONSOLE_URL"] ?? "https://console.kontourai.io");
  return hostedUrl !== null && hostname === hostedUrl.hostname;
}

export function endpointAllowed(endpointUrl: string, allowNetwork = false): boolean {
  if (!endpointUrl || endpointUrl.includes("\n") || endpointUrl.includes("\r") || endpointUrl.includes('"')) return false;
  const url = parseUrl(endpointUrl);
  if (!url) return false;
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return allowNetwork || isLocalHostname(url.hostname) || isKnownHostedConsoleHostname(url.hostname);
  return url.protocol === "http:" && isLocalHostname(url.hostname);
}

function activeSinks(enabled: boolean, channels: DoctorReport["telemetry"]["channels"], consoleEndpoint: string, allowed: boolean): string[] {
  const sinks: string[] = [];
  if (enabled && channels.some((channel) => channel.active && channel.logFile)) sinks.push("local-files");
  if (enabled && channels.some((channel) => channel.active && channel.endpointUrl)) sinks.push("channel-endpoint");
  if (enabled && consoleEndpoint && allowed) sinks.push("console");
  return sinks;
}

function checkConsoleReachability(endpointUrl: string, timeoutMs: number, allowNetwork: boolean): Promise<Reachability> {
  if (!endpointUrl) return Promise.resolve({ checked: false, ok: null });
  if (!endpointAllowed(endpointUrl, allowNetwork)) return Promise.resolve({ checked: false, ok: null, error: "endpoint is not allowed" });
  const url = parseUrl(endpointUrl);
  if (!url) return Promise.resolve({ checked: false, ok: null, error: "endpoint URL is malformed" });
  return new Promise((resolve) => {
    let settled = false;
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, { method: "HEAD", timeout: timeoutMs }, (res) => {
      settled = true;
      res.resume();
      resolve({ checked: true, ok: Boolean(res.statusCode && res.statusCode < 500), statusCode: res.statusCode });
    });
    req.on("timeout", () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ checked: true, ok: false, error: `timeout after ${timeoutMs}ms` });
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ checked: true, ok: false, error: error.message });
    });
    req.end();
  });
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

// TS mirror of scripts/telemetry/lib/config.sh's telemetry_conf_trusted
// (mode-600 + owner-uid + no-symlink gate). Symlink-then-existence guard order
// mirrors console-learning-projection.ts and workflow-sidecar.ts's existing
// lstatSync-before-statSync precedent.
function isConfTrusted(file: string): boolean {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return false;
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if ((stat.mode & 0o777) !== 0o600) return false;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the config file the bash runtime would actually load, in
 * scripts/telemetry/lib/config.sh's order: explicit TELEMETRY_CONFIG_FILE, a
 * trusted per-workspace .kontourai/telemetry-console.conf, a trusted
 * user-global ~/.flow-agents/telemetry-console.conf, then the shipped default.
 *
 * This doctor used to report the shipped default unconditionally, which made a
 * perfectly good machine-wide install read as unconfigured: "Console endpoint:
 * not configured" while the hooks were resolving a URL, token and tenant from
 * ~/.flow-agents/telemetry-console.conf and mirroring happily. A diagnostic
 * that answers "is my telemetry configured?" with the wrong answer sends
 * people to rewrite config that was never broken, which is worse than having
 * no diagnostic at all.
 */
export function resolveTelemetryConfigFile(dest: string, telemetryDir: string): string {
  const explicit = process.env.TELEMETRY_CONFIG_FILE;
  if (explicit) return path.resolve(explicit);
  const localConf = path.join(dest, ".kontourai", "telemetry-console.conf");
  if (isConfTrusted(localConf)) return localConf;
  const globalConf = path.join(os.homedir(), ".flow-agents", "telemetry-console.conf");
  if (isConfTrusted(globalConf)) return globalConf;
  return path.join(telemetryDir, "telemetry.conf");
}

function safeReportUrl(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = parseUrl(value);
  if (!parsed) return "[malformed-url]";
  parsed.username = "";
  parsed.password = "";
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (sensitiveQueryKeys.has(key.toLowerCase())) parsed.searchParams.set(key, "[redacted]");
  }
  return parsed.toString();
}

export async function buildReport(argv: string[]): Promise<DoctorReport> {
  const args = parseArgs(argv);
  const allowNetwork = flagBool(args.flags, "allow-network");
  const dest = path.resolve(flagString(args.flags, "dest", process.cwd()) ?? process.cwd());
  const telemetryDir = path.join(dest, "scripts", "telemetry");
  const configFile = resolveTelemetryConfigFile(dest, telemetryDir);
  const config = readConfig(configFile);
  const enabled = configValue(config, "TELEMETRY_ENABLED", "enabled", "true") !== "false";
  const dataDir = telemetryDataDir(dest);
  const sessionDir = path.resolve(configValue(config, "TELEMETRY_SESSION_DIR", "telemetry_session_dir", path.join(dataDir, "sessions")));
  const channels = configValue(config, "TELEMETRY_CHANNELS", "channels", defaultChannels).split(",").map((channel) => channel.trim()).filter(Boolean);
  const channelReports = channels.map((name) => {
    const defaultLog = name === "full" ? path.join(dataDir, "full.jsonl") : name === "analytics" ? path.join(dataDir, "analytics.jsonl") : "";
    const logFile = channelConfigValue(config, name, "log_file", defaultLog);
    const endpointUrl = channelConfigValue(config, name, "endpoint_url");
    return { name, logFile: logFile ? path.resolve(dest, logFile) : undefined, endpointUrl: safeReportUrl(endpointUrl), active: enabled };
  });
  const consoleUrl = process.env.CONSOLE_TELEMETRY_URL ?? process.env.CONSOLE_URL ?? config.console_telemetry_url ?? config.console_url ?? "";
  const explicitEndpoint = process.env.CONSOLE_TELEMETRY_ENDPOINT_URL ?? config.console_telemetry_endpoint_url ?? "";
  const endpointUrl = deriveConsoleEndpoint(consoleUrl, explicitEndpoint);
  const allowed = endpointAllowed(endpointUrl, allowNetwork);
  const timeoutMs = Number.parseInt(flagString(args.flags, "timeout-ms", "2000") ?? "2000", 10);
  const reachability = await checkConsoleReachability(endpointUrl, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2000, allowNetwork);
  const warnings = reportWarnings(configFile, endpointUrl, allowed, allowNetwork, dest);
  return {
    ok: enabled && (!endpointUrl || (allowed && reachability.ok !== false)),
    destination: dest,
    telemetry: {
      configFile,
      configExists: fs.existsSync(configFile),
      enabled,
      dataDir,
      sessionDir,
      channels: channelReports,
      activeSinks: activeSinks(enabled, channelReports, endpointUrl, allowed),
    },
    console: {
      sink: endpointUrl ? "console" : "local-only",
      url: safeReportUrl(consoleUrl),
      endpointUrl: safeReportUrl(endpointUrl),
      endpointAllowed: allowed,
      tokenConfigured: Boolean(process.env.CONSOLE_TELEMETRY_TOKEN ?? process.env.CONSOLE_AUTH_TOKEN ?? config.console_telemetry_token),
      tenantConfigured: Boolean(process.env.CONSOLE_TENANT_ID ?? config.console_tenant_id),
      tokenSource: valueSource(process.env.CONSOLE_TELEMETRY_TOKEN ?? process.env.CONSOLE_AUTH_TOKEN, config.console_telemetry_token),
      tenantSource: valueSource(process.env.CONSOLE_TENANT_ID, config.console_tenant_id),
      urlSource: valueSource(
        process.env.CONSOLE_TELEMETRY_URL ?? process.env.CONSOLE_URL ?? process.env.CONSOLE_TELEMETRY_ENDPOINT_URL,
        config.console_telemetry_url ?? config.console_url ?? config.console_telemetry_endpoint_url,
      ),
      reachability,
    },
    warnings,
  };
}

function reportWarnings(configFile: string, endpointUrl: string, allowed: boolean, allowNetwork: boolean, dest: string): string[] {
  const warnings: string[] = [];
  // Only meaningful when the shipped default is the resolved file; a workspace
  // or user-global conf living elsewhere is the normal, supported case.
  if (!fs.existsSync(configFile) && configFile.startsWith(path.join(dest, "scripts", "telemetry")))
    warnings.push("telemetry.conf was not found under destination scripts/telemetry");
  if (endpointUrl && !allowed) warnings.push(allowNetwork ? "Console endpoint is malformed or contains credentials" : "Console endpoint is not allowed without --allow-network; local http(s) endpoints and the known hosted Console host are allowed by default");
  // Mirrors config.sh's local-before-global precedence for the warning only
  // (see isConfTrusted's doc comment for the accepted config-resolution-parity gap).
  const localConf = path.join(dest, ".kontourai", "telemetry-console.conf");
  const globalConf = path.join(os.homedir(), ".flow-agents", "telemetry-console.conf");
  if (fs.existsSync(localConf) && !isConfTrusted(localConf)) {
    warnings.push(`Untrusted telemetry console conf at ${localConf} (must be mode 600, owned by the current user, and not a symlink); it is being ignored and telemetry stays fail-open`);
  } else if (fs.existsSync(globalConf) && !isConfTrusted(globalConf)) {
    warnings.push(`Untrusted telemetry console conf at ${globalConf} (must be mode 600, owned by the current user, and not a symlink); it is being ignored and telemetry stays fail-open`);
  }
  return warnings;
}

function printText(report: DoctorReport): void {
  console.log(`Telemetry doctor for ${report.destination}`);
  console.log(`Config: ${report.telemetry.configFile} (${report.telemetry.configExists ? "found" : "missing"})`);
  console.log(`Telemetry enabled: ${report.telemetry.enabled}`);
  console.log(`Local telemetry dir: ${report.telemetry.dataDir}`);
  console.log(`Active sinks: ${report.telemetry.activeSinks.length ? report.telemetry.activeSinks.join(", ") : "none"}`);
  console.log(`Console endpoint: ${report.console.endpointUrl || "not configured"}`);
  console.log(`Console reachability: ${report.console.reachability.checked ? (report.console.reachability.ok ? "ok" : `failed (${report.console.reachability.error ?? report.console.reachability.statusCode ?? "unknown"})`) : "not checked"}`);
  for (const warning of report.warnings) console.log(`Warning: ${warning}`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (flagBool(args.flags, "help") || flagBool(args.flags, "h")) {
    usage();
    return 0;
  }
  const report = await buildReport(argv);
  if (flagBool(args.flags, "json")) console.log(JSON.stringify(report, null, 2));
  else printText(report);
  return report.ok ? 0 : 1;
}
