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
    /**
     * The installed telemetry.conf carries `telemetry_sink_pin=local-files` (#1483) and no
     * TELEMETRY_CONFIG_FILE overrides it, so the operator Console confs are not consulted.
     */
    localOnlyPinned: boolean;
    /**
     * The installed telemetry.conf carries the pin line, whether or not it applies right now
     * (TELEMETRY_CONFIG_FILE overrides it).
     */
    pinRecorded: boolean;
    /** For a recorded pin: each destination still contacted, what it is, and where it resolves from. */
    pinOverrides: Array<{ what: string; source: string; url: string }>;
    /** For an applied pin: the installed telemetry.conf lines the allowlist ignored, and why. */
    pinIgnored: PinIgnored[];
    /** Operator Console confs present on disk that the local-only pin causes resolution to skip. */
    skippedConfigFiles: string[];
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
    /**
     * Where the resolved Console endpoint comes from, named for a person: an environment
     * variable, `TELEMETRY_CONFIG_FILE (<path>)`, or the resolved config file. Absent when no
     * endpoint resolves.
     */
    endpointSource?: string;
    reachability: Reachability;
  };
  warnings: string[];
};

/** Provenance of a resolved Console value. "absent" means nothing set it anywhere. */
export type ConsoleValueSource = "environment" | "config-file" | "absent";

function resolvedSource(vars: Map<string, { value: string; envName?: string }>, name: string): ConsoleValueSource {
  const entry = vars.get(name);
  if (!entry?.value) return "absent";
  return entry.envName ? "environment" : "config-file";
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

/** A value lib/config.sh resolved, and where it came from. */
type Resolved = { value: string; envName?: string };

const ASCII_SPACE = /[ \t\n\r\f\v]/g;
const ASCII_TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

/** config.sh's standard keys, mapped to the variable each one sets. Matched exactly, as its `case` does. */
const CONF_KEY_VARS: Readonly<Record<string, string>> = {
  enabled: "TELEMETRY_ENABLED",
  channels: "TELEMETRY_CHANNELS",
  console_url: "CONSOLE_TELEMETRY_URL",
  console_telemetry_url: "CONSOLE_TELEMETRY_URL",
  console_telemetry_endpoint_url: "CONSOLE_TELEMETRY_ENDPOINT_URL",
  console_telemetry_token: "CONSOLE_TELEMETRY_TOKEN",
  console_tenant_id: "CONSOLE_TENANT_ID",
  console_pricing_url: "TELEMETRY_PRICING_URL",
  pricing_url: "TELEMETRY_PRICING_URL",
  pricing_file: "TELEMETRY_PRICING_FILE",
  console_economics_endpoint_url: "FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL",
  console_liveness_endpoint_url: "FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL",
};

/** config.sh's relay keys: 1/true/yes/on become 1, 0/false/no/off become 0, anything else is kept. */
const CONF_RELAY_KEYS: Readonly<Record<string, string>> = {
  console_economics_relay: "RELAY_RAW:ECONOMICS",
  console_liveness_relay: "RELAY_RAW:LIVENESS",
};

/** A pinned conf line the allowlist dropped, for the report. */
export type PinIgnored = { key: string; reason: string };

/**
 * The variables this report needs, resolved the way lib/config.sh resolves them (#1483 review). It
 * covers only those variables, and it trusts the file it is given: resolveTelemetryConfigFile has
 * already applied config.sh's file choice and trust gate.
 *
 *   - environment defaults first, with `${VAR:-}` semantics, so an empty variable is unset and
 *     CONSOLE_URL / CONSOLE_AUTH_TOKEN / FLOW_AGENTS_PRICING_URL are fallbacks;
 *   - then the config file, line by line, each matching key overriding the environment;
 *   - lines read the way `while IFS='=' read -r key value` reads them: a final line with no newline
 *     is skipped, a remainder with one '=' and only at its end loses it, the key loses all ASCII
 *     whitespace and the value is trimmed;
 *   - channel.<name>.<key> becomes TELEMETRY_CHANNEL_<NAME>_<KEY> when both parts are
 *     [A-Za-z0-9_]+;
 *   - for a pinned install, the same allowlist as config.sh: standard keys through
 *     pinnedKeyAllowed, channel settings by the derived variable name through
 *     pinnedChannelVarAllowed. Every line it drops is listed in `ignored`.
 * Whitespace is ASCII only throughout, as config.sh's tr/sed run under LC_ALL=C.
 */
function resolveLikeConfigSh(file: string, pinned: boolean, env: NodeJS.ProcessEnv = process.env): { vars: Map<string, Resolved>; ignored: PinIgnored[] } {
  const vars = new Map<string, Resolved>();
  const ignored: PinIgnored[] = [];
  const fromEnv = (name: string, ...names: string[]) => {
    for (const envName of names) {
      const value = env[envName];
      if (value) {
        vars.set(name, { value, envName });
        return;
      }
    }
  };
  fromEnv("TELEMETRY_ENABLED", "TELEMETRY_ENABLED");
  fromEnv("TELEMETRY_CHANNELS", "TELEMETRY_CHANNELS");
  fromEnv("CONSOLE_TELEMETRY_URL", "CONSOLE_TELEMETRY_URL", "CONSOLE_URL");
  fromEnv("CONSOLE_TELEMETRY_ENDPOINT_URL", "CONSOLE_TELEMETRY_ENDPOINT_URL");
  fromEnv("CONSOLE_TELEMETRY_TOKEN", "CONSOLE_TELEMETRY_TOKEN", "CONSOLE_AUTH_TOKEN");
  fromEnv("CONSOLE_TENANT_ID", "CONSOLE_TENANT_ID");
  fromEnv("TELEMETRY_PRICING_URL", "TELEMETRY_PRICING_URL", "FLOW_AGENTS_PRICING_URL");
  fromEnv("TELEMETRY_PRICING_FILE", "TELEMETRY_PRICING_FILE", "FLOW_AGENTS_PRICING_FILE");
  // The relays read CONSOLE_URL again after config.sh, so a conf `console_url=` cannot hide it there.
  fromEnv("ENV:CONSOLE_URL", "CONSOLE_URL");
  for (const name of ["FLOW_AGENTS_CONSOLE_URL", "FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY", "FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL", "FLOW_AGENTS_CONSOLE_LIVENESS_RELAY", "FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL"]) fromEnv(name, name);
  for (const name of Object.keys(env)) if (name.startsWith("TELEMETRY_CHANNEL_")) fromEnv(name, name);
  if (!fs.existsSync(file)) return { vars, ignored };
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.pop(); // the text after the last newline: `read` never returns it
  for (const line of lines) {
    const eq = line.indexOf("=");
    const rawKey = eq === -1 ? line : line.slice(0, eq);
    if (!rawKey || /^[ \t\n\r\f\v]*#/.test(rawKey)) continue;
    let rest = eq === -1 ? "" : line.slice(eq + 1);
    if (rest.indexOf("=") === rest.length - 1 && rest.length > 0) rest = rest.slice(0, -1);
    const key = rawKey.replace(ASCII_SPACE, "");
    if (key.startsWith("#")) continue;
    const value = rest.replace(ASCII_TRIM, "");
    const channel = /^channel\.([^.]+)\.(.+)$/.exec(key);
    if (channel) {
      if (!/^[A-Za-z0-9_]+$/.test(channel[1]) || !/^[A-Za-z0-9_]+$/.test(channel[2])) continue;
      const name = `TELEMETRY_CHANNEL_${channel[1].toUpperCase()}_${channel[2].toUpperCase()}`;
      if (pinned && !pinnedChannelVarAllowed(name, value)) {
        ignored.push({ key, reason: /_(ENDPOINT_URL|LOG_FILE|REDACT)$/.test(name) ? "value not allowed for a pinned install" : "not on the pinned allowlist" });
        continue;
      }
      vars.set(name, { value });
      continue;
    }
    if (pinned && !pinnedKeyAllowed(key, value)) {
      ignored.push({ key, reason: PINNED_STANDARD_KEYS.has(key) ? "value not allowed for a pinned install" : "not on the pinned allowlist" });
      continue;
    }
    const relay = CONF_RELAY_KEYS[key];
    if (relay) {
      const lower = value.toLowerCase();
      vars.set(relay, { value: ["1", "true", "yes", "on"].includes(lower) ? "1" : ["0", "false", "no", "off"].includes(lower) ? "0" : value });
      continue;
    }
    const name = CONF_KEY_VARS[key];
    if (name) vars.set(name, { value });
  }
  return { vars, ignored };
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

const PIN_LINE = "telemetry_sink_pin=local-files";

/**
 * Whether `file` (an installed telemetry.conf) pins the install local-only: it has a line that is
 * exactly `telemetry_sink_pin=local-files`, optionally followed by a CR. Mirrors config.sh's
 * telemetry_conf_pinned_local_only and liveness-write.js's isPinnedLocalOnly.
 */
export function isPinnedLocalOnly(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, "utf8").split("\n").some((line) => line === PIN_LINE || line === `${PIN_LINE}\r`);
}

// ASCII whitespace only, as config.sh matches [[:space:]] under LC_ALL=C.
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?(\/[^ \t\n\r\f\v"\\]*)?$/;

const asciiLower = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());

/** config.sh's telemetry_ordinary_path: absolute, canonical-looking, no control character, not under /dev or /proc. */
export function isOrdinaryPath(value: string): boolean {
  if (!/^\/./s.test(value)) return false;
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  if (/\/\/|\/\.\/|\/\.\.\/|\/\.$|\/\.\.$|\/$/.test(value)) return false;
  const lower = asciiLower(value);
  return !(lower === "/dev" || lower.startsWith("/dev/") || lower === "/proc" || lower.startsWith("/proc/"));
}

const PINNED_STANDARD_KEYS: ReadonlySet<string> = new Set([
  "enabled", "enrich_system", "enrich_workspace", "enrich_auth", "usage_tracking", "notifications", "governance",
  "channels", "max_log_size_mb", "max_log_files", "governance_audit_max_size_mb", "governance_audit_max_files",
  "notification_profile", "sync_include", "sync_exclude", "console_economics_relay", "console_liveness_relay", "pricing_file",
  "telemetry_sink_pin",
]);

/**
 * The allowlist a pinned install's installed telemetry.conf is held to (config.sh's
 * telemetry_pinned_key_allowed): only settings that are local by construction, each with a value
 * grammar. The file is not trust-gated, so everything else is dropped.
 */
function pinnedKeyAllowed(key: string, value: string): boolean {
  switch (key) {
    case "enabled": case "enrich_system": case "enrich_workspace": case "enrich_auth":
    case "usage_tracking": case "notifications": case "governance":
      return value === "true" || value === "false";
    case "channels": return /^[A-Za-z0-9_, ]*$/.test(value);
    case "max_log_size_mb": case "max_log_files": case "governance_audit_max_size_mb": case "governance_audit_max_files":
      return /^[0-9]+$/.test(value);
    case "notification_profile": return /^[A-Za-z0-9_-]+$/.test(value);
    case "sync_include": case "sync_exclude": return true;
    case "console_economics_relay": case "console_liveness_relay": return ["0", "false", "no", "off"].includes(asciiLower(value));
    case "pricing_file": return isOrdinaryPath(value);
    case "telemetry_sink_pin": return true;
    default: return false;
  }
}

/** config.sh's telemetry_pinned_channel_var_allowed, on the derived TELEMETRY_CHANNEL_<NAME>_<KEY>. */
function pinnedChannelVarAllowed(name: string, value: string): boolean {
  if (name.endsWith("_ENDPOINT_URL")) return LOOPBACK_URL.test(value);
  if (name.endsWith("_LOG_FILE")) return isOrdinaryPath(value);
  return name.endsWith("_REDACT");
}

const RELAY_ON = new Set(["1", "true", "TRUE", "yes", "on"]);

/**
 * The economics and liveness relays a pinned install would still run, resolved as config.sh's
 * default-on rules and economics-record.sh / liveness/relay.sh's endpoint lookup resolve them: an
 * explicit conf key, else a pre-set environment value, else on once a Console URL or endpoint
 * resolves; the endpoint is the relay's own *_ENDPOINT_URL, else FLOW_AGENTS_CONSOLE_URL or the
 * resolved Console URL plus /records (economics also falls back to the Console endpoint's origin).
 */
function relayEndpoints(
  vars: Map<string, Resolved>,
  consoleUrl: string,
  consoleEndpoint: string,
  sourceOf: (name: string) => string | undefined,
): Array<{ what: string; source: string; url: string }> {
  const found: Array<{ what: string; source: string; url: string }> = [];
  for (const [kind, label] of [["ECONOMICS", "economics"], ["LIVENESS", "liveness"]] as const) {
    const raw = vars.get(`RELAY_RAW:${kind}`)?.value;
    const decision = raw ? raw : vars.get(`FLOW_AGENTS_CONSOLE_${kind}_RELAY`)?.value || (consoleUrl || consoleEndpoint ? "1" : "");
    if (!RELAY_ON.has(decision)) continue;
    const endpointVar = `FLOW_AGENTS_CONSOLE_${kind}_ENDPOINT_URL`;
    let url = vars.get(endpointVar)?.value ?? "";
    let source = url ? sourceOf(endpointVar) : undefined;
    if (!url) {
      const baseVar = ["FLOW_AGENTS_CONSOLE_URL", "CONSOLE_TELEMETRY_URL", "ENV:CONSOLE_URL"].find((name) => vars.get(name)?.value);
      let base = baseVar ? vars.get(baseVar)?.value ?? "" : "";
      source = baseVar ? sourceOf(baseVar) : undefined;
      if (!base && kind === "ECONOMICS" && consoleEndpoint) {
        base = /^(https?:\/\/[^/]+)/.exec(consoleEndpoint)?.[1] ?? consoleEndpoint;
        source = sourceOf("CONSOLE_TELEMETRY_ENDPOINT_URL");
      }
      if (!base) continue;
      url = `${base.endsWith("/") ? base.slice(0, -1) : base}/records`;
    }
    found.push({ what: `the ${label} relay`, source: source ?? "the environment", url });
  }
  return found;
}

/** Whether no TELEMETRY_CONFIG_FILE is set and the installed telemetry.conf is pinned local-only. */
function localOnlyPinApplies(telemetryDir: string): boolean {
  return !process.env.TELEMETRY_CONFIG_FILE && isPinnedLocalOnly(path.join(telemetryDir, "telemetry.conf"));
}

/**
 * Resolve the config file the bash runtime would actually load, in
 * scripts/telemetry/lib/config.sh's order: explicit TELEMETRY_CONFIG_FILE, the
 * shipped default when it is pinned local-only (#1483), a
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
  if (localOnlyPinApplies(telemetryDir)) return path.join(telemetryDir, "telemetry.conf");
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
  const localOnlyPinned = localOnlyPinApplies(telemetryDir);
  const pinRecorded = isPinnedLocalOnly(path.join(telemetryDir, "telemetry.conf"));
  const config = readConfig(configFile);
  const { vars, ignored: pinIgnored } = resolveLikeConfigSh(configFile, localOnlyPinned);
  const resolved = (name: string, fallback = ""): string => vars.get(name)?.value ?? fallback;
  const fileLabel = process.env.TELEMETRY_CONFIG_FILE ? `TELEMETRY_CONFIG_FILE (${configFile})` : configFile;
  const sourceOf = (name: string): string | undefined => {
    const entry = vars.get(name);
    if (!entry?.value) return undefined;
    return entry.envName ? `environment variable ${entry.envName}` : fileLabel;
  };
  const enabled = resolved("TELEMETRY_ENABLED", "true") !== "false";
  const dataDir = telemetryDataDir(dest);
  const sessionDir = path.resolve(process.env.TELEMETRY_SESSION_DIR ?? config.telemetry_session_dir ?? path.join(dataDir, "sessions"));
  const channels = resolved("TELEMETRY_CHANNELS", defaultChannels).split(",").map((channel) => channel.replace(ASCII_SPACE, "")).filter(Boolean);
  const channelVar = (name: string, key: string) => `TELEMETRY_CHANNEL_${name.toUpperCase()}_${key}`;
  const channelReports = channels.map((name) => {
    const defaultLog = name === "full" ? path.join(dataDir, "full.jsonl") : name === "analytics" ? path.join(dataDir, "analytics.jsonl") : "";
    const logFile = resolved(channelVar(name, "LOG_FILE"), defaultLog);
    const endpointUrl = resolved(channelVar(name, "ENDPOINT_URL"));
    return { name, logFile: logFile ? path.resolve(dest, logFile) : undefined, endpointUrl: safeReportUrl(endpointUrl), active: enabled };
  });
  const consoleUrl = resolved("CONSOLE_TELEMETRY_URL");
  const explicitEndpoint = resolved("CONSOLE_TELEMETRY_ENDPOINT_URL");
  const endpointUrl = deriveConsoleEndpoint(consoleUrl, explicitEndpoint);
  const endpointSource = !endpointUrl ? undefined : sourceOf(explicitEndpoint ? "CONSOLE_TELEMETRY_ENDPOINT_URL" : "CONSOLE_TELEMETRY_URL");
  // What still leaves the machine from a pinned install, and why (#1483 review): the pin filters only
  // the installed telemetry.conf, never the environment or TELEMETRY_CONFIG_FILE.
  const pinOverrides: Array<{ what: string; source: string; url: string }> = [];
  if (pinRecorded) {
    if (endpointUrl) pinOverrides.push({ what: "a Console endpoint", source: endpointSource ?? "the environment", url: endpointUrl });
    if (enabled) {
      for (const name of channels) {
        const url = resolved(channelVar(name, "ENDPOINT_URL"));
        if (url && !LOOPBACK_URL.test(url)) pinOverrides.push({ what: `the ${name} channel endpoint`, source: sourceOf(channelVar(name, "ENDPOINT_URL")) ?? "the environment", url });
      }
    }
    const pricingUrl = resolved("TELEMETRY_PRICING_URL");
    if (pricingUrl) pinOverrides.push({ what: "a pricing URL", source: sourceOf("TELEMETRY_PRICING_URL") ?? "the environment", url: pricingUrl });
    if (enabled) {
      // bash turns a write to /dev/tcp or /dev/udp into a connection (transport.sh's `>> "$log_file"`).
      for (const name of channels) {
        const logFile = resolved(channelVar(name, "LOG_FILE"));
        if (/^\/dev\/(tcp|udp)\//.test(logFile)) pinOverrides.push({ what: `the ${name} channel log file`, source: sourceOf(channelVar(name, "LOG_FILE")) ?? "the environment", url: logFile });
      }
    }
    for (const relay of relayEndpoints(vars, consoleUrl, explicitEndpoint, sourceOf)) pinOverrides.push(relay);
  }
  const allowed = endpointAllowed(endpointUrl, allowNetwork);
  const timeoutMs = Number.parseInt(flagString(args.flags, "timeout-ms", "2000") ?? "2000", 10);
  const reachability = await checkConsoleReachability(endpointUrl, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2000, allowNetwork);
  const skippedConfigFiles = localOnlyPinned
    ? [path.join(dest, ".kontourai", "telemetry-console.conf"), path.join(os.homedir(), ".flow-agents", "telemetry-console.conf")].filter((file) => fs.existsSync(file))
    : [];
  const warnings = reportWarnings(configFile, endpointUrl, allowed, allowNetwork, dest, localOnlyPinned);
  for (const override of pinOverrides) {
    const where = override.url.startsWith("/") ? override.url : safeReportUrl(override.url);
    warnings.push(`This install is pinned local-only (${PIN_LINE} in ${path.join(telemetryDir, "telemetry.conf")}), but ${override.what} still resolves from ${override.source}, so it is contacted at ${where}. Unset it to keep this install local-only.`);
  }
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
      localOnlyPinned,
      pinRecorded,
      pinOverrides: pinOverrides.map((override) => ({ ...override, url: override.url.startsWith("/") ? override.url : safeReportUrl(override.url) ?? "" })),
      pinIgnored,
      skippedConfigFiles,
    },
    console: {
      sink: endpointUrl ? "console" : "local-only",
      url: safeReportUrl(consoleUrl),
      endpointUrl: safeReportUrl(endpointUrl),
      endpointAllowed: allowed,
      tokenConfigured: Boolean(resolved("CONSOLE_TELEMETRY_TOKEN")),
      tenantConfigured: Boolean(resolved("CONSOLE_TENANT_ID")),
      tokenSource: resolvedSource(vars, "CONSOLE_TELEMETRY_TOKEN"),
      tenantSource: resolvedSource(vars, "CONSOLE_TENANT_ID"),
      urlSource: resolvedSource(vars, explicitEndpoint ? "CONSOLE_TELEMETRY_ENDPOINT_URL" : "CONSOLE_TELEMETRY_URL"),
      ...(endpointSource ? { endpointSource } : {}),
      reachability,
    },
    warnings,
  };
}

function reportWarnings(configFile: string, endpointUrl: string, allowed: boolean, allowNetwork: boolean, dest: string, localOnlyPinned: boolean): string[] {
  const warnings: string[] = [];
  // Only meaningful when the shipped default is the resolved file; a workspace
  // or user-global conf living elsewhere is the normal, supported case.
  if (!fs.existsSync(configFile) && configFile.startsWith(path.join(dest, "scripts", "telemetry")))
    warnings.push("telemetry.conf was not found under destination scripts/telemetry");
  if (endpointUrl && !allowed) warnings.push(allowNetwork ? "Console endpoint is malformed or contains credentials" : "Console endpoint is not allowed without --allow-network; local http(s) endpoints and the known hosted Console host are allowed by default");
  // Mirrors config.sh's local-before-global precedence for the warning only
  // (see isConfTrusted's doc comment for the accepted config-resolution-parity gap).
  // A pinned install never reads either conf, so whether one is trusted does not matter (config.sh
  // does not warn about them either).
  if (localOnlyPinned) return warnings;
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
  if (report.telemetry.localOnlyPinned) {
    console.log("Pinned local-only: telemetry_sink_pin=local-files in the installed telemetry.conf; operator Console configs are not read (TELEMETRY_CONFIG_FILE still overrides)");
    for (const file of report.telemetry.skippedConfigFiles) console.log(`Skipped by the pin: ${file}`);
    for (const line of report.telemetry.pinIgnored) console.log(`Ignored by the pin: ${line.key} (${line.reason})`);
  }
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
