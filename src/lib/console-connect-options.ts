/**
 * Pure, side-effect-free decision logic for the guided "Connect to Kontour
 * Console?" wizard (install-flow-console-connect PR2). Mirrors the doc-comment
 * convention of `console-telemetry-validate.ts` (this literally is "the future
 * guided console-connect wizard (PR2/PR3)" that file's own docstring names).
 *
 * No `fs`/`child_process`/network imports here — every export is a pure
 * function or a thin orchestration over injected `ask`/`askHidden` callbacks,
 * so `interactiveOptions()` in `src/cli/init.ts` stays a thin caller and this
 * module is fully unit-testable without a TTY.
 *
 * `TelemetrySink` is re-declared as a local type alias (not imported from
 * `init.ts`) to avoid a lib -> cli import direction. Keep this union in sync
 * with `src/cli/init.ts`'s `TelemetrySink` by comment cross-reference:
 *   "local-files" | "local-kontour-console" | "kontour-hosted-console" |
 *   "user-hosted-console" | "kontour-cloud" | "hosted-kontour-console"
 */
import { isValidConsoleUrl, isValidConsoleToken, isValidConsoleTenant } from "./console-telemetry-validate.js";

export type TelemetrySink =
  | "local-files"
  | "local-kontour-console"
  | "kontour-hosted-console"
  | "user-hosted-console"
  | "kontour-cloud"
  | "hosted-kontour-console";

export type ConsoleConnectChoice = "hosted" | "local" | "self-hosted" | "skip";

/**
 * Case-insensitive match on the four accepted choice spellings. Blank or
 * unrecognized input falls back to `fallback` (the caller decides the
 * default, typically "hosted").
 */
export function normalizeConsoleConnectChoice(answer: string, fallback: ConsoleConnectChoice): ConsoleConnectChoice {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "hosted" || normalized === "h") return "hosted";
  if (normalized === "local" || normalized === "l") return "local";
  if (normalized === "self-hosted" || normalized === "selfhosted" || normalized === "self" || normalized === "s") return "self-hosted";
  if (normalized === "skip" || normalized === "none" || normalized === "n") return "skip";
  return fallback;
}

/** Pure lookup table: choice -> the exact `telemetrySinks` array to install with. */
export function mapConsoleConnectChoiceToSinks(choice: ConsoleConnectChoice): TelemetrySink[] {
  if (choice === "hosted") return ["kontour-hosted-console"];
  if (choice === "local") return ["local-kontour-console"];
  if (choice === "self-hosted") return ["user-hosted-console"];
  return ["local-files"];
}

/** Only "self-hosted" requires an inline URL prompt. */
export function needsConsoleUrlPrompt(choice: ConsoleConnectChoice): boolean {
  return choice === "self-hosted";
}

/**
 * Mirrors `needsConsoleCredentials`'s existing semantics one-for-one
 * (choice-based instead of sinks-based): every choice except "skip" wants
 * token/tenant prompts.
 */
export function needsConsoleCredentialPrompts(choice: ConsoleConnectChoice): boolean {
  return choice !== "skip";
}

/**
 * The one hard-fail guard this PR adds: self-hosted Console with a blank URL
 * is a downstream `die` in `install-console-config.sh` (the `user-hosted-console`
 * branch requires `--console-url`/`--console-endpoint`). Falls back to
 * `local-files` with a one-line warning instead of letting that crash happen.
 *
 * Only handles the blank case — a non-blank-but-malformed URL (e.g. a typo)
 * is NOT this guard's job; callers separately run `isValidConsoleUrl` for
 * that format-only warn-and-continue case.
 */
export function resolveSelfHostedUrlOrFallback(url: string): { sinks: TelemetrySink[]; url: string; fallbackWarning?: string } {
  if (url.trim() === "") {
    return {
      sinks: ["local-files"],
      url: "",
      fallbackWarning: "Self-hosted Console requires a URL; no URL was given, so telemetry stays local-only. Re-run init or telemetry-doctor to add a Console URL later.",
    };
  }
  return { sinks: ["user-hosted-console"], url };
}

export type ConsoleConnectIo = {
  ask: (prompt: string) => Promise<string>;
  askHidden: (prompt: string) => Promise<string>;
};

export type ConsoleConnectDefaults = {
  hostedUrl: string;
  localUrl: string;
};

export type ConsoleConnectResult = {
  telemetrySinks: TelemetrySink[];
  consoleUrl?: string;
  consoleTokenValue?: string;
  consoleTenant?: string;
  warnings: string[];
};

// Token provisioning is console-side (CONSOLE_AUTH_TOKENS_JSON), not
// flow-agents-side. This hint is folded into the token prompt string itself
// (rather than printed directly via console.log) so the whole orchestration
// stays testable via the injected `askHidden` stub's captured prompt argument.
const TOKEN_PROVISIONING_HINT =
  "Tokens are provisioned by your Console admin via CONSOLE_AUTH_TOKENS_JSON -- see docs/integrations/flow-agents-console.md.";

/**
 * Full interactive orchestration used by `interactiveOptions()`: prompts the
 * four-way "Connect to Kontour Console?" choice (default Hosted, showing the
 * real `console-presets.sh`-resolved hosted URL), applies the self-hosted
 * blank-URL guard, prompts hidden token + tenant when a console connection is
 * wanted, runs PR1's pure validators (validate-and-warn, not
 * validate-and-block), and returns any format warnings in `warnings` for the
 * caller to print -- rather than printing directly, so this stays testable
 * via return-value assertions, not console-spy assertions.
 */
export async function runConsoleConnectWizard(
  io: ConsoleConnectIo,
  defaults: ConsoleConnectDefaults,
): Promise<ConsoleConnectResult> {
  const warnings: string[] = [];

  const choiceAnswer = await io.ask(
    `Connect to Kontour Console? [Hosted (${defaults.hostedUrl})/Local (${defaults.localUrl})/Self-hosted/Skip] [Hosted]: `,
  );
  const choice = normalizeConsoleConnectChoice(choiceAnswer, "hosted");

  let sinks = mapConsoleConnectChoiceToSinks(choice);
  let consoleUrl: string | undefined;

  if (needsConsoleUrlPrompt(choice)) {
    const urlAnswer = await io.ask("Self-hosted Console URL: ");
    const resolved = resolveSelfHostedUrlOrFallback(urlAnswer);
    sinks = resolved.sinks;
    consoleUrl = resolved.url ? resolved.url : undefined;
    if (resolved.fallbackWarning) {
      warnings.push(resolved.fallbackWarning);
    } else if (consoleUrl && !isValidConsoleUrl(consoleUrl)) {
      warnings.push(
        `Console URL '${consoleUrl}' does not look valid (expected https://, or http:// to localhost/127.0.0.1); continuing anyway.`,
      );
    }
  }

  let consoleTokenValue: string | undefined;
  let consoleTenant: string | undefined;
  // Only prompt for credentials when a console sink actually survived (the
  // self-hosted blank-URL fallback above may have already downgraded to
  // local-files, in which case there is nothing to authenticate).
  const wantsConsole = needsConsoleCredentialPrompts(choice) && sinks.some((sink) => sink !== "local-files");
  if (wantsConsole) {
    const tokenAnswer = await io.askHidden(`${TOKEN_PROVISIONING_HINT}\nConsole telemetry token (blank to skip): `);
    consoleTokenValue = tokenAnswer.trim() || undefined;
    if (consoleTokenValue && !isValidConsoleToken(consoleTokenValue)) {
      warnings.push(
        "Console token format looks unusual (expected <=4096 chars, charset [A-Za-z0-9._~+/=-]); continuing anyway.",
      );
    }
    const tenantAnswer = await io.ask("Console tenant ID (blank to skip): ");
    consoleTenant = tenantAnswer.trim() || undefined;
    if (consoleTenant && !isValidConsoleTenant(consoleTenant)) {
      warnings.push(
        "Console tenant format looks unusual (expected charset [A-Za-z0-9._:-]); continuing anyway.",
      );
    }
  }

  return { telemetrySinks: sinks, consoleUrl, consoleTokenValue, consoleTenant, warnings };
}

/**
 * Four distinguishable outcomes, deliberately NOT collapsed (kontourai/flow-agents#1344).
 *
 * The precedent this follows is `cost_availability`, which distinguishes `unavailable` from
 * `activity_only` from `floor` rather than flattening them into one number, and
 * `output_tokens`, which is present iff attributed rather than defaulting to zero. "A
 * connection was attempted and it worked" and "no connection was ever attempted" are
 * different facts about the world; a summary that prints the same check mark for both is
 * asserting an observation nothing made.
 *
 *   verified                  -- a reachability check ran against the endpoint and succeeded.
 *   unverified-failed         -- a check ran and failed (detail carries the error/status).
 *   unverified-not-attempted  -- an endpoint is configured; no check was attempted (detail says why).
 *   not-configured            -- no Console endpoint resolved at all. Absent reads as absent.
 */
export type ConsoleStatus = "verified" | "unverified-failed" | "unverified-not-attempted" | "not-configured";

type DoctorConsoleShape = {
  sink: "local-only" | "console";
  reachability: { checked: boolean; ok: boolean | null; error?: string; statusCode?: number };
};

/**
 * Pure classifier over the exact structural shape `telemetry-doctor.ts`'s
 * `DoctorReport.console` already has. Deliberately accepts a narrow
 * structural type rather than importing `DoctorReport` itself, keeping this
 * module dependency-free (no lib -> cli import).
 */
// Actionable detail shown when a Console sink's reachability was never
// attempted (checked:false). In practice this branch is reached ONLY via
// telemetry-doctor.ts's pre-attempt guard clauses (endpointAllowed() said no,
// or the endpoint URL was malformed) -- an actually-attempted check that
// fails always sets checked:true (see checkConsoleReachability's HEAD
// request path) and is handled by the branch above, which keeps surfacing
// error/statusCode unchanged. The most common guard-clause reason by far is
// a self-hosted/BYO HTTPS host that --allow-network was not passed for, so
// the hint below points at the one flag that unblocks it.
const NOT_CHECKED_DETAIL =
  "not checked — self-hosted/BYO consoles need `flow-agents telemetry-doctor --allow-network` to verify reachability";

export function describeConsoleStatus(doctor: { console: DoctorConsoleShape }): { status: ConsoleStatus; detail?: string } {
  const { sink, reachability } = doctor.console;
  if (sink === "local-only") return { status: "not-configured" };
  if (reachability.checked && reachability.ok === true) return { status: "verified" };
  if (reachability.checked && reachability.ok === false) {
    const detail = reachability.error ?? (reachability.statusCode !== undefined ? `HTTP ${reachability.statusCode}` : "reachability check failed");
    return { status: "unverified-failed", detail };
  }
  // reachability.checked === false: never attempted (see NOT_CHECKED_DETAIL's
  // doc comment for why this is always the not-allowed/skipped reason here,
  // never an attempted-and-failed check).
  return { status: "unverified-not-attempted", detail: NOT_CHECKED_DETAIL };
}

/** Where the telemetry configuration the summary describes was actually resolved from. */
export type ResolvedConfigScope = "destination" | "workspace" | "user-global" | "explicit" | "absent";

export type ConsoleValueProvenance = "environment" | "config-file" | "absent";

export type PostInstallSummaryInput = {
  runtime: string;
  runtimeAutoDetected: boolean;
  dest: string;
  telemetrySinks: string[];
  consoleStatus: { status: ConsoleStatus; detail?: string };
  /** Absolute path of the telemetry config file the resolution actually read. */
  resolvedConfigFile?: string;
  /** Whether that file belongs to this install's destination, or came from somewhere else. */
  resolvedConfigScope?: ResolvedConfigScope;
  tokenSource?: ConsoleValueProvenance;
  tenantSource?: ConsoleValueProvenance;
  nextSteps: string[];
};

const SCOPE_NOTE: Readonly<Record<ResolvedConfigScope, string>> = {
  destination: "",
  workspace: " (workspace override, not written by this install)",
  "user-global": " (user-global, not written by this install)",
  explicit: " (TELEMETRY_CONFIG_FILE override, not written by this install)",
  absent: "",
};

function consoleStatusLine(consoleStatus: { status: ConsoleStatus; detail?: string }): string {
  const detail = consoleStatus.detail ? `: ${consoleStatus.detail}` : "";
  switch (consoleStatus.status) {
    // "verified" is claimed ONLY here, where a reachability check actually ran and returned ok.
    case "verified": return "✓ Console: reachability checked and verified";
    case "unverified-failed": return `✗ Console: endpoint configured, reachability check FAILED${detail}`;
    case "unverified-not-attempted": return `- Console: endpoint configured, reachability not attempted${detail}`;
    case "not-configured": return "- Console: not configured (no Console endpoint in the resolved telemetry configuration)";
  }
}

function valueLine(label: string, source: ConsoleValueProvenance | undefined): string {
  if (source === "environment") return `    ${label}: configured (from the environment, not from a config file)`;
  if (source === "config-file") return `    ${label}: configured`;
  return `    ${label}: not configured`;
}

/**
 * Pure string[]-builder for the post-install summary block: one array entry per line, so
 * callers `console.log` each entry and tests assert on array contents rather than scraping
 * stdout. Never receives or emits the raw console token value -- only provenance labels.
 *
 * Every Console line here is DERIVED from the resolved configuration the caller measured,
 * never from install intent (kontourai/flow-agents#1344). The selected sink is printed as
 * the primary fact; the resolved configuration FILE is named, with a note when it is not the
 * one this install wrote; "verified" appears only for a connection that was attempted and
 * succeeded; and an absent token or tenant reads as "not configured" rather than being
 * omitted, so absence is visible instead of merely unstated.
 */
export function buildPostInstallSummaryLines(input: PostInstallSummaryInput): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push("Flow Agents install summary:");
  const runtimeLine = input.runtimeAutoDetected ? `${input.runtime} (auto-detected)` : input.runtime;
  lines.push(`  ✓ Runtime: ${runtimeLine}`);
  lines.push(`  ✓ Destination: ${input.dest}`);
  lines.push(`  ✓ Telemetry sink (selected): ${input.telemetrySinks.length ? input.telemetrySinks.join(", ") : "local-files"}`);
  const scope = input.resolvedConfigScope ?? "absent";
  lines.push(
    input.resolvedConfigFile && scope !== "absent"
      ? `  ${scope === "destination" ? "✓" : "!"} Telemetry config resolved from: ${input.resolvedConfigFile}${SCOPE_NOTE[scope]}`
      : "  - Telemetry config resolved from: no telemetry config file found",
  );
  lines.push(`  ${consoleStatusLine(input.consoleStatus)}`);
  lines.push(valueLine("Console token", input.tokenSource));
  lines.push(valueLine("Console tenant", input.tenantSource));
  if (input.nextSteps.length) {
    lines.push("");
    lines.push("Next steps:");
    for (const step of input.nextSteps) lines.push(`  - ${step}`);
  }
  return lines;
}
