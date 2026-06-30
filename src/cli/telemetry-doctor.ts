import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
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

type DoctorReport = {
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
    reachability: Reachability;
  };
  warnings: string[];
};

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

function endpointAllowed(endpointUrl: string, allowNetwork = false): boolean {
  if (!endpointUrl || endpointUrl.includes("\n") || endpointUrl.includes("\r") || endpointUrl.includes('"')) return false;
  const url = parseUrl(endpointUrl);
  if (!url) return false;
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return allowNetwork || isLocalHostname(url.hostname);
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

async function buildReport(argv: string[]): Promise<DoctorReport> {
  const args = parseArgs(argv);
  const allowNetwork = flagBool(args.flags, "allow-network");
  const dest = path.resolve(flagString(args.flags, "dest", process.cwd()) ?? process.cwd());
  const telemetryDir = path.join(dest, "scripts", "telemetry");
  const configFile = path.join(telemetryDir, "telemetry.conf");
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
  const warnings = reportWarnings(configFile, endpointUrl, allowed, allowNetwork);
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
      reachability,
    },
    warnings,
  };
}

function reportWarnings(configFile: string, endpointUrl: string, allowed: boolean, allowNetwork: boolean): string[] {
  const warnings: string[] = [];
  if (!fs.existsSync(configFile)) warnings.push("telemetry.conf was not found under destination scripts/telemetry");
  if (endpointUrl && !allowed) warnings.push(allowNetwork ? "Console endpoint is malformed or contains credentials" : "Console endpoint is not allowed without --allow-network; local http(s) endpoints are allowed by default");
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
