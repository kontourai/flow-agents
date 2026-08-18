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
 *
 *   - The host transcript records the command text and the tool's exit status. A
 *     transition invoked inside a wrapper that captures `$?` and continues exits 0 at
 *     the tool boundary, so the refusal is invisible there. Every transition in the
 *     first measured run was wrapped that way.
 *
 * So the tool records its own outcome, at the one place every invocation passes
 * through. This is provider-independent, wrapper-immune, and carries the semantic
 * fields (verb, expectation id) that a generic command log cannot recover from argv
 * without re-implementing this CLI's parser.
 *
 * Redaction: argv is NOT recorded. Only the command, the verb, flag NAMES, and the
 * values of an explicit allowlist of flags whose values are kit-defined identifiers.
 * Free-text flags (--summary, --body, --reason) carry operator prose and stay out.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveSharedRepoRoot, telemetryDataDir } from "./lib/local-artifact-root.js";

export const TRANSITION_LOG_FILENAME = "transitions.jsonl";
export const TRANSITION_RECORD_KIND = "kontour.flow-agents.transition";
export const TRANSITION_RECORD_SCHEMA_VERSION = "1.0";

/**
 * Flags whose values are identifiers defined by a kit or flow definition — safe to
 * record because they are drawn from a fixed vocabulary, and necessary to record
 * because they are what distinguishes one gate from another. Anything not listed
 * contributes its NAME only.
 */
const IDENTIFIER_FLAGS = new Set([
  "--expectation",
  "--gate",
  "--flow",
  "--kit",
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

/** A value is only recorded if it looks like an identifier, never free text. */
const IDENTIFIER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/;

export type TransitionOutcome = "ok" | "nonzero" | "unhandled-error" | "usage";

export interface TransitionRecord {
  schema_version: string;
  kind: string;
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
   * It is a WEAK discriminator: most throws are a bare `Error`. That is the honest
   * state of things, and the real fix is a typed refusal with its own exit code
   * (kontourai/flow-agents#1273) rather than reading tea leaves from prose.
   */
  error_name?: string;
  started_at: string;
  duration_ms: number;
  cwd_repo: string | null;
  actor: { runtime: string | null; session_id: string | null };
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
      if (verb === null) verb = IDENTIFIER_VALUE.test(token) ? token : "«unparsed»";
      continue;
    }

    // Normalize --flag=value into the same shape as --flag value.
    const equalsAt = token.indexOf("=");
    const name = equalsAt === -1 ? token : token.slice(0, equalsAt);
    const inlineValue = equalsAt === -1 ? null : token.slice(equalsAt + 1);
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
  env?: NodeJS.ProcessEnv;
}): TransitionRecord {
  const env = input.env ?? process.env;
  const { verb, targets, flags } = summarizeArgv(input.argv);
  const record: TransitionRecord = {
    schema_version: TRANSITION_RECORD_SCHEMA_VERSION,
    kind: TRANSITION_RECORD_KIND,
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
  return record;
}

/**
 * Append one record, best effort. A telemetry write must never change the outcome of
 * the command it is describing, so every failure here is swallowed: an unwritable
 * disk, a read-only checkout and a missing directory all degrade to "no record", not
 * to a failed transition. Returns whether the write happened, for tests.
 */
export function appendTransitionRecord(record: TransitionRecord, cwd = process.cwd()): boolean {
  if (process.env["FLOW_AGENTS_TRANSITION_LOG"] === "0") return false;
  try {
    const dir = telemetryDataDir(transitionLogRoot(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, TRANSITION_LOG_FILENAME);
    // Appending through a symlink writes to whatever it points at. The rest of this
    // codebase guards its writes the same way; a telemetry file is no place to make
    // an exception.
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
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
export function transitionLogRoot(cwd = process.cwd()): string {
  try {
    return resolveSharedRepoRoot(cwd) ?? cwd;
  } catch {
    return cwd;
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
  const cwd = input.cwd ?? process.cwd();
  const repoRoot = transitionLogRoot(cwd);
  return appendTransitionRecord(buildTransitionRecord({ ...input, repoRoot }), cwd);
}
