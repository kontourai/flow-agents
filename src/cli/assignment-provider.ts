import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, flagString, type ParsedArgs } from "../lib/args.js";
import { readJson, isoNow } from "../lib/fs.js";
import {
  canonicalHolderActorKey,
  computeEffectiveState,
  serializeActor,
  type ActorStruct,
  type AssignmentClaimRecord,
  type FreshHolder,
} from "../lib/assignment-model.js";
import {
  githubAssignmentStatus,
  renderGithubClaim,
  renderGithubRelease,
  renderGithubSupersede,
  GITHUB_CLAIM_COMMENT_MARKER_DEFAULT,
  GITHUB_CLAIM_LABEL_DEFAULT,
  type GithubAssignmentStatus,
  type GithubIssueDoc,
  type RenderClaimInput,
} from "../lib/assignment-github.js";
import {
  assignmentFilePath,
  performLocalClaim,
  performLocalRelease,
  performLocalReleaseUnderLock,
  performLocalSupersede,
  readLocalAssignmentStatus,
  readLocalRecord,
  withSubjectLock,
  withSubjectLockAsync,
  writeLocalRecord,
} from "../lib/assignment-local-store.js";

// ─── AssignmentProvider CLI (#290) ──────────────────────────────────────────
// context/contracts/assignment-provider-contract.md is the governing vocabulary doc for this
// module. Read it first if the shapes below are unclear — it documents the five operations, the
// assignment ⋈ liveness join table, the lazy-correction transition table, and the versioned
// claim-record format.
//
// The primitive itself (types, claim-record codec, the join, takeover rules) lives in
// `src/lib/assignment-model.ts`; the GitHub render/parse in `src/lib/assignment-github.ts`; the
// local-file store and its locking in `src/lib/assignment-local-store.ts`. They are published as
// the `./assignment-contract`, `./assignment-github`, and `./assignment-local-file` subpaths. This
// file is the CLI over them (argument parsing, JSON envelopes, env-derived actor resolution) and
// re-exports their API under the names the rest of the CLI has always imported from here.
//
// Three distinct "claim" concepts exist in this repo (see the contract doc's terminology
// callout): this file implements the *assignment* claim only — never the ADR 0012 *liveness*
// claim (workflow-sidecar.ts `liveness claim` / `freshHolders`) or the Hachure *trust* claim
// (workflow-sidecar.ts `claim <id> <dir>` / `claimLookup`). Always qualify "claim" in prose here.
//
// GitHub mutation path is render-don't-execute (Design Decision 1): every `render-*` subcommand
// is a pure function — no I/O beyond reading its `--input-json`/`--actor-json` inputs — that
// emits the exact `gh` argv the calling skill must run verbatim via its Bash tool. This file must
// never itself shell out to `gh` (no execFileSync/spawn/exec to `gh` anywhere below).

export type { ActorStruct, AssignmentClaimRecord, AssignmentStatus, EffectiveState, FreshHolder } from "../lib/assignment-model.js";
export type { GithubIssueDoc, RenderClaimInput, AssignmentRenderResult } from "../lib/assignment-github.js";
export { canonicalHolderActorKey, computeEffectiveState } from "../lib/assignment-model.js";
export { renderGithubClaim } from "../lib/assignment-github.js";
export {
  assignmentFilePath,
  performLocalClaim,
  performLocalRelease,
  performLocalReleaseUnderLock,
  performLocalSupersede,
  readLocalAssignmentStatus,
  readLocalRecord,
  withSubjectLock,
  withSubjectLockAsync,
  writeLocalRecord,
};

type AnyObj = Record<string, unknown>;

const DEFAULT_LABEL_NAME = GITHUB_CLAIM_LABEL_DEFAULT;
const CLAIM_COMMENT_MARKER_DEFAULT = GITHUB_CLAIM_COMMENT_MARKER_DEFAULT;

/**
 * Delegate to the shared pure-CJS resolver (scripts/hooks/lib/actor-identity.js), mirroring the
 * exact createRequire pattern `workflow-sidecar.ts`'s loadActorIdentityHelper() already uses for
 * this module. Only the ENVIRONMENT-derived resolution stays here (it reads env, `os`, and process
 * ancestry, so it cannot be part of the pure contract); actor serialization is the contract's
 * `serializeActor`, pinned to the CJS copy by a parity test. Deliberately NO inline duplicate
 * fallback: if the module fails to load, that failure must surface loudly.
 */
function loadActorIdentityHelper(): {
  resolveActor: (env: NodeJS.ProcessEnv) => { actor: string; source: string };
  resolveActorIdentity: (env: NodeJS.ProcessEnv) => { actor: string; source: string; actorStruct: ActorStruct | null };
  isUnresolvedActor: (actor: string) => boolean;
} {
  const _req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/actor-identity.js");
  return _req(helperPath) as {
    resolveActor: (env: NodeJS.ProcessEnv) => { actor: string; source: string };
    resolveActorIdentity: (env: NodeJS.ProcessEnv) => { actor: string; source: string; actorStruct: ActorStruct | null };
    isUnresolvedActor: (actor: string) => boolean;
  };
}

/**
 * Delegate to the shared pure-CJS liveness reader (scripts/hooks/lib/liveness-read.js), same
 * createRequire idiom as loadActorIdentityHelper() above. Used only for the join computation —
 * this module never writes liveness events (that stays the ADR 0012 lifecycle's job).
 */
function loadLivenessReadHelper(): {
  readLivenessEvents: (streamPath: string) => AnyObj[];
  freshHolders: (events: AnyObj[], slug: string, selfActor: string, nowMs: number) => FreshHolder[];
} {
  const _req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/liveness-read.js");
  return _req(helperPath) as {
    readLivenessEvents: (streamPath: string) => AnyObj[];
    freshHolders: (events: AnyObj[], slug: string, selfActor: string, nowMs: number) => FreshHolder[];
  };
}

function loadJsonInput(file: string): unknown {
  return file === "-" ? JSON.parse(fs.readFileSync(0, "utf8")) : readJson(file);
}

function requireFlag(args: ParsedArgs, name: string): string {
  const value = flagString(args.flags, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/**
 * Build an ActorStruct from an already-loaded JSON value (used for --actor-json,
 * --from-actor-json, --to-actor-json). Fails loud on a malformed/incomplete struct — a
 * durable claim record must never carry a partial actor identity.
 */
function actorStructFromJson(data: unknown, sourceLabel: string): ActorStruct {
  if (typeof data !== "object" || data === null) throw new Error(`${sourceLabel} must contain an object`);
  const struct = data as Partial<ActorStruct>;
  if (!struct.runtime || !struct.session_id || !struct.host) throw new Error(`${sourceLabel} must include runtime, session_id, and host`);
  return {
    runtime: String(struct.runtime),
    session_id: String(struct.session_id),
    host: String(struct.host),
    human: struct.human != null && String(struct.human).trim() !== "" ? String(struct.human) : null,
  };
}

function loadActorStructFromFile(file: string): ActorStruct {
  return actorStructFromJson(loadJsonInput(file), `actor JSON (${file})`);
}

/**
 * Resolve the acting actor for a local-file mutation: --actor-json is the deterministic,
 * fixture-friendly path (used by evals and any caller that already knows its own struct);
 * when omitted, auto-derive from the live environment via the shared resolver, mirroring
 * (never forking) the exact struct fields serializeActor() already defines.
 *
 * F1 fix (fix-plan iteration 1, HIGH): also returns `actorKey` — set to the canonical
 * `resolveActor(env).actor` string ONLY on the auto-derive path (pull-work's real path, and any
 * other caller with no --actor-json), so a claim made via `assignment-provider claim` and one
 * made via ensure-session share the same canonical key. `--actor-json` explicit fixtures leave
 * `actorKey` unset — `performLocalClaim`/`performLocalSupersede` then fall back to
 * `serializeActor(actor)` for the record's `actor_key`, preserving existing fixture behavior.
 */
function loadActorStruct(args: ParsedArgs): { actor: ActorStruct; actorKey?: string } {
  const actorJsonPath = flagString(args.flags, "actor-json");
  if (actorJsonPath) return { actor: loadActorStructFromFile(actorJsonPath) };
  return resolveCurrentAssignmentActor();
}

export function resolveCurrentAssignmentActor(): { actor: ActorStruct; actorKey: string } {
  const helper = loadActorIdentityHelper();
  const resolved = helper.resolveActorIdentity(process.env);
  if (helper.isUnresolvedActor(resolved.actor)) throw new Error("could not resolve an actor identity (no --actor-json and no resolvable environment actor); pass --actor-json explicitly");
  if (!resolved.actorStruct) throw new Error("actor identity resolved without a canonical actor struct");
  return { actor: { ...resolved.actorStruct, human: resolved.actorStruct.human ?? null }, actorKey: resolved.actor };
}

function loadLivenessInputs(args: ParsedArgs): { events: AnyObj[] | null; selfActor: string | undefined } {
  const eventsJsonPath = flagString(args.flags, "liveness-events-json");
  const streamPath = flagString(args.flags, "liveness-stream");
  const selfActor = flagString(args.flags, "self-actor");
  if (eventsJsonPath) {
    const data = loadJsonInput(eventsJsonPath);
    if (!Array.isArray(data)) throw new Error(`--liveness-events-json must contain a JSON array: ${eventsJsonPath}`);
    return { events: data as AnyObj[], selfActor };
  }
  if (streamPath) return { events: loadLivenessReadHelper().readLivenessEvents(streamPath), selfActor };
  return { events: null, selfActor };
}

// ─── local-file: claim | release | supersede (the durable-write path; real I/O by design — no
// external mutation to defer to a skill for this provider kind, per Design Decision 1) ─────────

function claimLocalFile(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = flagString(args.flags, "provider", "local-file");
  if (provider !== "local-file") throw new Error(`claim: --provider must be local-file (use render-claim for github); got ${provider}`);
  const artifactRoot = requireFlag(args, "artifact-root");
  const subjectId = requireFlag(args, "subject-id");
  const { actor, actorKey } = loadActorStruct(args);

  const ttlSecondsRaw = flagString(args.flags, "ttl-seconds", "1800") ?? "1800";
  const ttlSeconds = Number(ttlSecondsRaw);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error(`--ttl-seconds must be a positive number; got ${ttlSecondsRaw}`);
  const branch = requireFlag(args, "branch");
  const artifactDir = requireFlag(args, "artifact-dir");
  const reason = flagString(args.flags, "reason") ?? "claim";

  const record = performLocalClaim(artifactRoot, subjectId, actor, { ttlSeconds, branch, artifactDir, reason, actorKey });
  console.log(JSON.stringify({ role: "AssignmentClaimResult", subject_id: subjectId, record }, null, 2));
  return 0;
}

function releaseLocalFile(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = flagString(args.flags, "provider", "local-file");
  if (provider !== "local-file") throw new Error(`release: --provider must be local-file (use render-release for github); got ${provider}`);
  const artifactRoot = requireFlag(args, "artifact-root");
  const subjectId = requireFlag(args, "subject-id");
  const releasedBy = flagString(args.flags, "actor-json") ? loadActorStructFromFile(requireFlag(args, "actor-json")) : null;
  const reason = flagString(args.flags, "reason") ?? "released";

  const record = performLocalRelease(artifactRoot, subjectId, releasedBy, { reason, tolerateNoActiveClaim: false });
  console.log(JSON.stringify({ role: "AssignmentReleaseResult", subject_id: subjectId, record }, null, 2));
  return 0;
}

function supersedeLocalFile(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = flagString(args.flags, "provider", "local-file");
  if (provider !== "local-file") throw new Error(`supersede: --provider must be local-file (use render-supersede for github); got ${provider}`);
  const artifactRoot = requireFlag(args, "artifact-root");
  const subjectId = requireFlag(args, "subject-id");
  const fromActor = loadActorStructFromFile(requireFlag(args, "from-actor-json"));
  const toActor = loadActorStructFromFile(requireFlag(args, "to-actor-json"));
  const reason = flagString(args.flags, "reason") ?? "supersede";
  const ttlSecondsOverride = flagString(args.flags, "ttl-seconds");
  const branchOverride = flagString(args.flags, "branch");
  const artifactDirOverride = flagString(args.flags, "artifact-dir");

  const record = performLocalSupersede(artifactRoot, subjectId, fromActor, toActor, {
    ttlSeconds: ttlSecondsOverride != null ? Number(ttlSecondsOverride) : undefined,
    branch: branchOverride ?? undefined,
    artifactDir: artifactDirOverride ?? undefined,
    reason,
  });
  console.log(JSON.stringify({ role: "AssignmentSupersedeResult", subject_id: subjectId, record }, null, 2));
  return 0;
}

// ─── GitHub: render-claim | render-release | render-supersede (render, don't execute — Design
// Decision 1). Pure functions: no I/O beyond reading --input-json/--actor-json. Never invoke
// `gh` (or any process) here — the calling skill runs the emitted argv verbatim. ────────────────

function githubRepositoryIdentity(value: string | undefined): { owner: string; name: string } | null {
  if (value == null) return null;
  const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error("status --provider github --repo must be an exact owner/repo identity");
  return { owner: match[1], name: match[2] };
}

function renderClaim(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = flagString(args.flags, "provider", "github");
  if (provider !== "github") throw new Error(`render-claim: --provider must be github; got ${provider}`);
  const subjectId = requireFlag(args, "subject-id");
  const input = loadJsonInput(requireFlag(args, "input-json")) as RenderClaimInput;
  const actor = loadActorStructFromFile(requireFlag(args, "actor-json"));
  console.log(JSON.stringify(renderGithubClaim(subjectId, input, actor, isoNow()), null, 2));
  return 0;
}

function renderRelease(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = flagString(args.flags, "provider", "github");
  if (provider !== "github") throw new Error(`render-release: --provider must be github; got ${provider}`);
  const subjectId = requireFlag(args, "subject-id");
  const input = loadJsonInput(requireFlag(args, "input-json")) as RenderClaimInput;
  console.log(JSON.stringify(renderGithubRelease(subjectId, input, isoNow()), null, 2));
  return 0;
}

function renderSupersede(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = flagString(args.flags, "provider", "github");
  if (provider !== "github") throw new Error(`render-supersede: --provider must be github; got ${provider}`);
  const subjectId = requireFlag(args, "subject-id");
  const input = loadJsonInput(requireFlag(args, "input-json")) as RenderClaimInput;
  const toActor = loadActorStructFromFile(requireFlag(args, "actor-json"));
  console.log(JSON.stringify(renderGithubSupersede(subjectId, input, toActor, isoNow()), null, 2));
  return 0;
}

// ─── status | list (both provider kinds) ────────────────────────────────────────────────────

function statusCommand(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = requireFlag(args, "provider");
  const requestedSubjectId = flagString(args.flags, "subject-id");
  let assignment: GithubAssignmentStatus;

  if (provider === "local-file") {
    const artifactRoot = requireFlag(args, "artifact-root");
    if (!requestedSubjectId) throw new Error("--subject-id is required for status --provider local-file");
    assignment = readLocalAssignmentStatus(artifactRoot, requestedSubjectId);
  } else if (provider === "github") {
    const issueJsonPath = requireFlag(args, "issue-json");
    const issue = loadJsonInput(issueJsonPath) as GithubIssueDoc;
    const repository = githubRepositoryIdentity(flagString(args.flags, "repo"));
    const labelName = flagString(args.flags, "label-name", DEFAULT_LABEL_NAME) ?? DEFAULT_LABEL_NAME;
    const marker = flagString(args.flags, "claim-comment-marker", CLAIM_COMMENT_MARKER_DEFAULT) ?? CLAIM_COMMENT_MARKER_DEFAULT;
    assignment = githubAssignmentStatus(issue, labelName, marker);
    if (requestedSubjectId && assignment.record && assignment.record.subject_id !== requestedSubjectId) {
      throw new Error(`claim record subject_id ${assignment.record.subject_id} does not match requested --subject-id ${requestedSubjectId}`);
    }
    if (requestedSubjectId) assignment.subject_id = requestedSubjectId;
    const issueNumber = Number(issue.number);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("status --provider github issue JSON must expose a positive safe-integer issue number");
    }
    assignment.repository = repository;
    assignment.issue_number = issueNumber;
  } else {
    throw new Error(`status: unsupported --provider ${provider}`);
  }

  const { events, selfActor } = loadLivenessInputs(args);
  const nowMs = flagString(args.flags, "now") ? Date.parse(flagString(args.flags, "now") as string) : Date.now();
  const freshList = events !== null ? loadLivenessReadHelper().freshHolders(events, assignment.subject_id, selfActor ?? "", nowMs) : [];
  const effective = events !== null
    ? computeEffectiveState(assignment, freshList, selfActor, nowMs)
    : { effective_state: null, reason: "liveness input not provided (pass --liveness-events-json or --liveness-stream); effective state not computed" };
  console.log(JSON.stringify({ role: "AssignmentStatus", provider, assignment, effective }, null, 2));
  return 0;
}

function listCommand(argv: string[]): number {
  const args = parseArgs(argv);
  const provider = requireFlag(args, "provider");
  const actorJsonFilter = flagString(args.flags, "actor-json");
  const actorFilter = actorJsonFilter ? serializeActor(loadActorStructFromFile(actorJsonFilter)) : flagString(args.flags, "actor");
  const subjectIds: string[] = [];

  if (provider === "local-file") {
    const artifactRoot = requireFlag(args, "artifact-root");
    const dir = path.join(artifactRoot, "assignment");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
    for (const name of files) {
      const record = readJson(path.join(dir, name)) as AssignmentClaimRecord;
      if (record.status !== "claimed") continue;
      // #777 review: filter on the CANONICAL holder key (stored actor_key first, serialized
      // actor as fallback) — explicit-override actors deliberately diverge between the two.
      if (actorFilter && canonicalHolderActorKey(record) !== actorFilter) continue;
      subjectIds.push(record.subject_id);
    }
  } else if (provider === "github") {
    const issuesJsonPath = requireFlag(args, "issues-json");
    const doc = loadJsonInput(issuesJsonPath);
    const issues = Array.isArray(doc) ? doc as GithubIssueDoc[] : ((doc as AnyObj).items as GithubIssueDoc[] ?? []);
    const labelName = flagString(args.flags, "label-name", DEFAULT_LABEL_NAME) ?? DEFAULT_LABEL_NAME;
    const marker = flagString(args.flags, "claim-comment-marker", CLAIM_COMMENT_MARKER_DEFAULT) ?? CLAIM_COMMENT_MARKER_DEFAULT;
    for (const issue of issues) {
      const assignment = githubAssignmentStatus(issue, labelName, marker);
      if (!assignment.record || assignment.record.status !== "claimed") continue;
      // #777 review: same canonical-key rule as the local-file branch above.
      if (actorFilter && canonicalHolderActorKey(assignment.record) !== actorFilter) continue;
      subjectIds.push(assignment.record.subject_id);
    }
  } else {
    throw new Error(`list: unsupported --provider ${provider}`);
  }

  console.log(JSON.stringify({ role: "AssignmentList", provider, actor: actorFilter ?? null, subject_ids: subjectIds }, null, 2));
  return 0;
}

const ASSIGNMENT_USAGE: Record<string, string> = {
  claim: "usage: flow-agents assignment-provider claim --provider local-file --artifact-root <path> --subject-id <slug> --branch <branch> --artifact-dir <reldir> [--actor-json <path>] [--ttl-seconds <n>] [--reason <text>]",
  release: "usage: flow-agents assignment-provider release --provider local-file --artifact-root <path> --subject-id <slug> [--actor-json <path>] [--reason <text>]",
  supersede: "usage: flow-agents assignment-provider supersede --provider local-file --artifact-root <path> --subject-id <slug> --from-actor-json <path> --to-actor-json <path> [--ttl-seconds <n>] [--branch <branch>] [--artifact-dir <reldir>] [--reason <text>]",
  "render-claim": "usage: flow-agents assignment-provider render-claim --provider github --subject-id <slug> --input-json <path> --actor-json <path>",
  "render-release": "usage: flow-agents assignment-provider render-release --provider github --subject-id <slug> --input-json <path>",
  "render-supersede": "usage: flow-agents assignment-provider render-supersede --provider github --subject-id <slug> --input-json <path> --actor-json <path>",
  status: "usage: flow-agents assignment-provider status --provider <local-file|github> [--subject-id <slug>] [--artifact-root <path>] [--issue-json <path>] [--repo <owner/name>] [--label-name <name>] [--claim-comment-marker <marker>] [--liveness-events-json <path>|--liveness-stream <path>] [--self-actor <key>] [--now <iso8601>]",
  list: "usage: flow-agents assignment-provider list --provider <local-file|github> [--artifact-root <path>] [--issues-json <path>] [--actor-json <path>|--actor <key>] [--label-name <name>] [--claim-comment-marker <marker>]",
};

function hasHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function printAssignmentUsage(): void {
  console.log(`Usage: flow-agents assignment-provider <command> [flags]

Commands:
  claim            Claim a subject for the current actor (local-file provider).
  release          Release the current actor's claim on a subject.
  supersede        Transfer a claim from one actor to another.
  render-claim     Render the gh argv for a GitHub assignment claim.
  render-release   Render the gh argv for a GitHub assignment release.
  render-supersede Render the gh argv for a GitHub assignment supersede.
  status           Report assignment and effective state for a subject.
  list             List active claims for a provider.

Run \`flow-agents assignment-provider <command> --help\` for command-specific flags.`);
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const [command, ...rest] = argv;
    if (command === "--help" || command === "-h") {
      printAssignmentUsage();
      return 0;
    }
    if (typeof command === "string" && hasHelp(rest) && Object.prototype.hasOwnProperty.call(ASSIGNMENT_USAGE, command)) {
      console.log(ASSIGNMENT_USAGE[command]);
      return 0;
    }
    if (command === "claim") return claimLocalFile(rest);
    if (command === "release") return releaseLocalFile(rest);
    if (command === "supersede") return supersedeLocalFile(rest);
    if (command === "render-claim") return renderClaim(rest);
    if (command === "render-release") return renderRelease(rest);
    if (command === "render-supersede") return renderSupersede(rest);
    if (command === "status") return statusCommand(rest);
    if (command === "list") return listCommand(rest);
    console.error("usage: assignment-provider <claim|release|supersede|render-claim|render-release|render-supersede|status|list> [flags]");
    return 2;
  } catch (error) {
    console.error(`assignment-provider: ${(error as Error).message}`);
    return 1;
  }
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
