/**
 * Transition log — the CLI witnessing itself.
 *
 * Every gate scorecard so far has been assembled by hand: an operator appending an
 * exit code to a TSV after each transition. That is not instrumentation, it is
 * recollection with extra steps — it produces data only when a human remembers, and
 * it produced exactly one run's worth before this module existed.
 *
 * The two mechanisms that look like they should already cover this do not:
 *
 *   - `evidence-capture.js` (postToolUse hook) records every shell command with its
 *     exit code, hash-chained. It only runs when the kit is installed into a provider
 *     that fires hooks — so it is structurally blind to any period when the kit is
 *     deactivated, which is precisely when "is this worth reinstalling?" is asked.
 *     An instrument that cannot measure its own absence reports silence as health.
 *     (It reads the exit code from the same host payload the transcript does, so it
 *     shares the wrapper blindness below; installation alone would not have helped.)
 *
 *   - The host transcript records the command text and the tool's exit status. A
 *     transition invoked inside a wrapper that captures `$?` and continues exits 0 at
 *     the tool boundary, so the refusal is invisible there. Every transition in the
 *     first measured run was wrapped that way.
 *
 * So the tool records its own outcome, at the point where `src/cli.ts` exits. That is
 * provider-independent, wrapper-immune, and carries the semantic fields (verb,
 * expectation id) a generic command log cannot recover from argv without
 * re-implementing this CLI's parser.
 *
 * It is NOT every invocation of every binary: `flow-agents-workflow-sidecar` and
 * `flow-agents-validate-artifacts` have their own entry points, and `init` exits
 * directly when an operator interrupts a prompt. Those produce no record. Naming the
 * gap rather than asserting completeness, because a log that quietly omits a path has
 * the same defect this module opens by indicting.
 *
 * Redaction: argv is not recorded as such. Only the command (validated against the
 * registry), the verb, flag NAMES (validated as flag names), and the values of an
 * explicit allowlist of flags whose values are kit-defined identifiers and which match
 * an identifier pattern. Free-text flags (--summary, --body, --reason) contribute their
 * name only. Anything this module declines to parse is recorded as a placeholder that
 * carries no content, never verbatim.
 */

import fs from "node:fs";
import path from "node:path";

import { durableFlowAgentsRoot, resolveSharedRepoRoot } from "./lib/local-artifact-root.js";

export const TRANSITION_LOG_FILENAME = "transitions.jsonl";
export const TRANSITION_RECORD_KIND = "kontour.flow-agents.transition";
export const TRANSITION_RECORD_SCHEMA_VERSION = "1.0";
/** Envelope field names, matching the sibling records in scripts/telemetry/. */

/**
 * Flags whose values are identifiers defined by a kit or flow definition — safe to
 * record because they are drawn from a fixed vocabulary, and necessary to record
 * because they are what distinguishes one gate from another. Anything not listed
 * contributes its NAME only.
 *
 * Every entry is a flag this CLI actually defines. An earlier version listed four that
 * did not exist (`--gate`, `--kit`, and two since removed): harmless, since a flag
 * nobody passes never matches, but it made the list read as checked when it was not.
 * A test pins the invariant so the next addition has to be real.
 */
const IDENTIFIER_FLAGS = new Set([
  "--expectation",
  "--flow",
  "--provider",
  "--assignment-provider",
  "--decision",
  "--status",
  "--outcome",
  "--critique",
  "--work-item",
  "--subject-id",
]);

/**
 * Recorded when a command name is not one this CLI registers. The first positional
 * argument is argv, and argv is not something to write down: a misplaced shell
 * variable or a pasted clipboard line arrives here verbatim. The exit code already
 * says the invocation was rejected, so the name itself carries nothing worth the risk.
 */
export const UNKNOWN_COMMAND = "«unknown»";

/** Stands in for any token this module declines to record. Carries no content. */
export const UNPARSED = "«unparsed»";

/**
 * The flow a command is operating on, when the command resolves one.
 *
 * Expectation ids are unique within a flow but not across flows — the shipped kits
 * share one — so a record naming only its expectation cannot always be attributed to a
 * gate. The flow is the discriminator, and asking the operator to repeat it on every
 * write would be both redundant and unreachable: `workflow evidence` validates against
 * a fixed flag set. The command already knows it from run state, so it says so here.
 */
let activeFlow: string | null = null;

/**
 * The gate's own verdict, which the exit code does not carry.
 *
 * `workflow evidence` returns 0 on BOTH branches: when the gate advanced, and when it
 * recorded the evidence but is still awaiting the rest of its expectations. So exit 0
 * covers "the gate passed" and "the gate is still refusing", and exit 70 is dominated
 * by operator friction — a mistyped flag and a genuine contract refusal share it. An
 * outcome axis built on the exit code alone measures roughly the inverse of gate
 * behaviour, and the partial-satisfaction case — likely the largest class — is
 * invisible in it.
 *
 * The command knows the truth (`report.attached`) and used to discard it. It says so
 * here instead.
 */
let activeGateOutcome: { attached: boolean; missing: string[] } | null = null;

export function noteGateOutcome(outcome: { attached: boolean; missing?: readonly string[] } | null): void {
  activeGateOutcome = outcome
    ? {
        attached: outcome.attached === true,
        missing: (outcome.missing ?? []).filter((id): id is string => typeof id === "string" && IDENTIFIER_VALUE.test(id)),
      }
    : null;
}

export function resetGateOutcome(): void {
  activeGateOutcome = null;
}

export function noteActiveFlow(flowId: string | null | undefined): void {
  activeFlow = typeof flowId === "string" && IDENTIFIER_VALUE.test(flowId) ? flowId : null;
}

/** Test seam: the module-level note persists for the life of the process. */
export function resetActiveFlow(): void {
  activeFlow = null;
}

/** A value is only recorded if it looks like an identifier, never free text. */
const IDENTIFIER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/;

/**
 * A well-formed flag name. Without this, any VALUE beginning with `-` was treated as
 * the next flag and recorded verbatim and unbounded — so `--summary "-> rotated token
 * ..."` put the whole sentence in the log under the redaction this module advertises.
 * Diff text, negative numbers and a bare `--` all take that path.
 */
const FLAG_NAME = /^--?[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * A verb is a word. Every verb this CLI defines is lowercase letters and hyphens; the
 * wider identifier charset admits URLs, paths and token-shaped strings, and argv[3] is
 * the same class of operator-controlled input as argv[2] — which is redacted three
 * lines up for exactly that reason. Underscores are excluded deliberately: they are
 * not used by any verb here and they are used by API-key prefixes.
 */
const VERB = /^[a-z][a-z0-9-]{0,31}$/i;

export type TransitionOutcome = "ok" | "nonzero" | "unhandled-error" | "usage";

export interface TransitionRecord {
  /** `schema` + `version`, as economics-record and stop-gate-summary use. `kind` is
   * already taken in this repo for a WITHIN-type discriminator (workflow-outcome's
   * "terminal"), so carrying a type id there would make `.kind` mean two things. */
  schema: string;
  version: string;
  command: string | null;
  verb: string | null;
  targets: Record<string, string>;
  flags: string[];
  exit_code: number;
  outcome: TransitionOutcome;
  /**
   * The thrown error's CLASS name on the unhandled-error path — never its message.
   *
   * The message was the obvious discriminator between "the gate correctly rejected a
   * malformed claim" and "the CLI broke", since both exit 70. It is also a channel
   * straight through this module's redaction: several throw sites interpolate raw
   * operator input into the text (`--route-reason`, `--scope`, provider names), and
   * `workflow` — the most-used surface — has no local catch, so those reach the top
   * level verbatim. A class name is derived from the code rather than from what
   * somebody typed, so it cannot carry content.
   *
   * It is a WEAK discriminator: most throws are a bare `Error`. The real fix is a
   * typed refusal with its own exit code
   * (kontourai/flow-agents#1273) rather than reading tea leaves from prose.
   */
  error_name?: string;
  /**
   * "advanced" | "awaiting" — present only when the invocation resolved a gate. This,
   * not `outcome`, is what a gate did: `outcome` is the process exit code, and the two
   * disagree precisely where it matters (see noteGateOutcome).
   */
  gate_outcome?: "advanced" | "awaiting";
  /** Expectations the gate is still missing, when it is awaiting them. */
  gate_missing?: string[];
  started_at: string;
  duration_ms: number;
  cwd_repo: string | null;
  actor: { runtime: string | null; session_id: string | null };
  /**
   * Output-token attribution — WRITTEN BY THE ENRICHER, NEVER BY THIS MODULE.
   *
   * `scripts/telemetry/enrich-transitions.mjs` stamps these afterwards, from the host
   * transcript, using the same rule `scripts/telemetry/gate-scorecard.mjs` folds with
   * (both import `scripts/telemetry/token-attribution.mjs`). They are declared here
   * because they are part of this record's published shape, and consumers — Console's
   * `ConsoleTransitionRecord` among them — read them off it.
   *
   * This module must not fill them in, and a test pins that it does not. Three reasons,
   * in descending order of how badly guessing would go:
   *
   *   1. "At most one transition per turn" is a decision about a SET of competing
   *      transitions. A process exiting knows one invocation. Whatever it wrote would be
   *      a guess that later evidence contradicts, and an inflated total is worse than no
   *      total because it cannot be told apart from a real one.
   *   2. This write is best-effort and must never change the outcome of the command it
   *      describes. Parsing a multi-megabyte host transcript on every CLI exit trades
   *      that guarantee away for a number available a second later.
   *   3. This module is provider-independent and wrapper-immune by construction — that is
   *      its entire justification over the capture hook and the transcript. Reading one
   *      host's private, explicitly-unstable file format here would reintroduce exactly
   *      the blindness it was built to remove.
   *
   * `output_tokens` is present IFF `token_attribution.attributed` is true. An
   * unattributable transition carries NO `output_tokens` key — never a zero. Absent cost
   * and zero cost are different claims, and only the second one says a gate was free.
   */
  output_tokens?: number;
  token_attribution?: TransitionTokenAttribution;
}

/**
 * The granularity label travelling WITH the number, mirroring console's
 * `EconomicsDelegationCostGranularity = "model-proxy"` precedent: name what the figure is
 * rather than implying precision. Output tokens are roughly 6.6% of spend on this repo's
 * own corpus and are not proportional to it, so the figure is a FLOOR — a lower bound on
 * one token class, which is a lower bound on spend. It is never a total and never currency.
 */
export interface TransitionTokenAttribution {
  granularity: "output-tokens-only";
  /**
   * TRUE means a turn was found and charged. FALSE is a positive finding, not an absence:
   * this transition was examined and had no turn to charge, so it must be COUNTED as
   * unattributable rather than folded in as an attributed zero. The block's presence is
   * what distinguishes an enriched log from one nothing has looked at — deriving
   * "without turn" from a missing `output_tokens` alone cannot tell those apart, and
   * reports an unmeasured run as a measured one whose gates happened to cost nothing.
   */
  attributed: boolean;
  /** Path-free, session-scoped hash of the turn charged (or the turn that was unavailable). */
  turn_ref?: string;
  /** Why nothing was attributed, when nothing was. Emitted, never inferred by the reader. */
  reason?: string;
  /** The turn was claimed by two transitions stamped at the same instant; line order, not the data, decided. */
  ambiguous?: boolean;
  /** What the attribution was derived from. Names the derivation, not the machine. */
  source?: string;
}

/** A class name is developer-authored, but it is still bounded before recording. */
const MAX_ERROR_NAME = 80;

/**
 * Split argv into the semantic fields worth keeping. Deliberately dumb: it does not
 * consult the command registry, because a record that fails to parse an unknown verb
 * is still a true record of an invocation, and a parser that throws here would take
 * the CLI down with it.
 */
export function summarizeArgv(argv: readonly string[]): {
  verb: string | null;
  targets: Record<string, string>;
  flags: string[];
} {
  const targets: Record<string, string> = {};
  const flags: string[] = [];
  let verb: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("-")) {
      if (verb === null) verb = VERB.test(token) ? token : UNPARSED;
      continue;
    }

    // Normalize --flag=value into the same shape as --flag value.
    const equalsAt = token.indexOf("=");
    const name = equalsAt === -1 ? token : token.slice(0, equalsAt);
    const inlineValue = equalsAt === -1 ? null : token.slice(equalsAt + 1);
    if (!FLAG_NAME.test(name)) {
      // Not a flag: an operator-supplied value that merely starts with a dash.
      if (!flags.includes(UNPARSED)) flags.push(UNPARSED);
      continue;
    }
    if (!flags.includes(name)) flags.push(name);
    if (!IDENTIFIER_FLAGS.has(name)) continue;

    let value = inlineValue;
    if (value === null) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        value = next;
        index += 1;
      }
    }
    if (value !== null && IDENTIFIER_VALUE.test(value)) targets[name.replace(/^--/, "")] = value;
  }

  return { verb, targets, flags };
}

export function classifyOutcome(exitCode: number): TransitionOutcome {
  if (exitCode === 0) return "ok";
  if (exitCode === 64) return "usage";
  // 70 is this CLI's top-level catch (see src/cli.ts). It is NOT "crashed": every
  // refusal in the workflow verb throws, so this bucket mixes both. Named for what it
  // observably is rather than what it is assumed to mean.
  if (exitCode === 70) return "unhandled-error";
  return "nonzero";
}

export function buildTransitionRecord(input: {
  command: string | null;
  argv: readonly string[];
  exitCode: number;
  startedAt: Date;
  endedAt: Date;
  errorName?: string | null;
  repoRoot?: string | null;
  flow?: string | null;
  gateOutcome?: { attached: boolean; missing: string[] } | null;
  env?: NodeJS.ProcessEnv;
}): TransitionRecord {
  const env = input.env ?? process.env;
  const { verb, targets, flags } = summarizeArgv(input.argv);
  // Run state wins over a flag: it is derived, and the flag is not accepted by every
  // verb that writes evidence.
  const resolvedFlow = input.flow ?? activeFlow;
  if (resolvedFlow && !targets["flow"]) targets["flow"] = resolvedFlow;
  const record: TransitionRecord = {
    schema: TRANSITION_RECORD_KIND,
    version: TRANSITION_RECORD_SCHEMA_VERSION,
    command: input.command ?? null,
    verb,
    targets,
    flags,
    exit_code: input.exitCode,
    outcome: classifyOutcome(input.exitCode),
    started_at: input.startedAt.toISOString(),
    duration_ms: Math.max(0, input.endedAt.getTime() - input.startedAt.getTime()),
    cwd_repo: input.repoRoot ?? null,
    actor: {
      runtime: env["FLOW_AGENTS_RUNTIME"] ?? (env["CLAUDE_CODE_SESSION_ID"] ? "claude-code" : null),
      session_id: env["CLAUDE_CODE_SESSION_ID"] ?? env["FLOW_AGENTS_SESSION_ID"] ?? null,
    },
  };
  if (input.errorName) record.error_name = input.errorName.slice(0, MAX_ERROR_NAME);
  const gate = input.gateOutcome ?? activeGateOutcome;
  if (gate) {
    record.gate_outcome = gate.attached ? "advanced" : "awaiting";
    if (!gate.attached && gate.missing.length) record.gate_missing = gate.missing;
  }
  return record;
}

/**
 * Append one record, best effort. A telemetry write must never change the outcome of
 * the command it is describing, so every failure here is swallowed: an unwritable
 * disk, a read-only checkout and a missing directory all degrade to "no record", not
 * to a failed transition. Returns whether the write happened, for tests.
 */
export function appendTransitionRecord(record: TransitionRecord, cwd = process.cwd()): boolean {
  if (transitionLogDisabled()) return false;
  try {
    const root = transitionLogRoot(cwd);
    if (root === null) return false;
    // NOT under `.kontourai/`. That tree is the run's artifact state, and this repo
    // asserts in two independent evals that a read-only or rejected command leaves it
    // byte-identical (`workflow status mutated durable artifacts`, `... did not reject
    // before every durable write`). A per-invocation record inside it breaks both, and
    // narrowing those assertions to accommodate a writer would erode the invariant they
    // exist to hold. Tool-state belongs in the durable tool directory.
    const dir = path.join(durableFlowAgentsRoot(root), "telemetry");
    fs.mkdirSync(dir, { recursive: true });
    ensureTelemetryResidueIgnored(dir);
    const file = path.join(dir, TRANSITION_LOG_FILENAME);
    // Appending through a symlink writes to whatever it points at, so every component
    // this writer creates is checked, not just the leaf — a symlinked `.kontourai` or
    // `telemetry` redirects the write just as effectively as a symlinked file, and the
    // first version of this guard checked only the file and returned success.
    for (const candidate of [path.dirname(dir), dir, file]) {
      if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
    }
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * One repository, one log. `telemetryDataDir` resolves against the working directory,
 * so invoking the CLI from a subdirectory would start a second, independent
 * transitions.jsonl — and an analyzer reading either one would silently report a
 * fragment of the run as the whole of it. Anchor on the shared repository root, and
 * fall back to the working directory only outside a repository.
 */
/**
 * Keep the log out of a developer's commits AND out of `git status`.
 *
 * The rule ignores itself — no `!.gitignore` exception. The sibling helper for
 * `.kontourai/` keeps its own ignore file visible, which is safe there because the
 * repository root already ignores that whole tree. Here it is not: an exempted
 * `.gitignore` leaves the directory untracked, the working tree dirty, and the evidence
 * writer refusing its own provenance mid-run — the #1264 failure, reintroduced one
 * directory over.
 */
function ensureTelemetryResidueIgnored(dir: string): void {
  try {
    fs.writeFileSync(
      path.join(dir, ".gitignore"),
      [
        "# Written by flow-agents: per-invocation transition records are local telemetry,",
        "# not source. This rule ignores itself so the directory never dirties the working",
        "# tree — a dirty tree makes the evidence writer refuse its own provenance (#1264).",
        "*",
        "",
      ].join("\n"),
      { mode: 0o644, flag: "wx" },
    );
  } catch {
    // An existing file is the expected case; anything else is not worth failing a write.
  }
}

export function transitionLogDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["FLOW_AGENTS_TRANSITION_LOG"] === "0";
}

export function transitionLogRoot(cwd = process.cwd()): string | null {
  try {
    // NULL outside a repository, and the write is skipped. Falling back to the working
    // directory meant that running the CLI from anywhere — a home directory, a temp
    // dir, a caller's cwd during a delegated retry — created a `.kontourai/` there.
    // That is litter in someone else's directory, and this repo tests against it
    // (evals/integration/test_public_workflow_cli.sh asserts the caller's cwd is
    // untouched). An invocation with no project to attribute to is not worth a record.
    return resolveSharedRepoRoot(cwd);
  } catch {
    return null;
  }
}

/**
 * Build and append in one call, so callers cannot accidentally record a root that
 * disagrees with the one written to.
 */
export function recordTransition(input: {
  command: string | null;
  argv: readonly string[];
  exitCode: number;
  startedAt: Date;
  endedAt: Date;
  errorName?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  // Checked before resolving the root: that resolution shells out to git, and an
  // opted-out operator should not pay a subprocess on every invocation to be told so.
  if (transitionLogDisabled(input.env ?? process.env)) return false;
  const cwd = input.cwd ?? process.cwd();
  const repoRoot = transitionLogRoot(cwd);
  if (repoRoot === null) return false;
  return appendTransitionRecord(buildTransitionRecord({ ...input, repoRoot }), cwd);
}
