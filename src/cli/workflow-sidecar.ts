#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// ADR 0016 Abstraction A: shared FlowDefinition resolver (P-a)
import { resolveActiveFlowStep, resolveFlowFilePath, resolvePhaseMap, resolveRouteBackPolicy, type ActiveFlowStep } from "../lib/flow-resolver.js";
import { defaultArtifactRootForRead, flowAgentsArtifactRoot } from "../lib/local-artifact-root.js";
// #291 Wave 1 Task 1.1 exports: ensure-session's ownership guard reuses the EXACT same
// assignment ⋈ liveness join / claim / supersede logic #290 already ships for the
// `assignment-provider` CLI, rather than reimplementing a second, parallel join (static ESM
// import — same idiom already used above for ../lib/flow-resolver.js).
import { computeEffectiveState, performLocalClaim, performLocalSupersede, readLocalAssignmentStatus, type ActorStruct, type EffectiveState, type FreshHolder } from "./assignment-provider.js";

type AnyObj = Record<string, any>;

export const statuses = new Set(["new", "planning", "planned", "in_progress", "blocked", "verifying", "verified", "needs_decision", "not_verified", "failed", "delivered", "accepted", "archived"]);
export const phases = ["idea", "backlog", "pickup", "planning", "execution", "verification", "goal_fit", "evidence", "release", "learning", "done"];
export const checkKinds = new Set(["build", "types", "lint", "test", "command", "security", "diff", "browser", "runtime", "policy", "external"]);
export const checkStatuses = new Set(["pass", "fail", "not_verified", "skip"]);
export const verdicts = new Set(["pass", "partial", "fail", "not_verified"]);

function now(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function read(file: string): string { return fs.readFileSync(file, "utf8"); }
export function writeJson(file: string, payload: AnyObj): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`); }
// Single-line but readable "key": "value" form. Built by collapsing the
// structural whitespace from an indented stringify — corruption-proof, unlike a
// regex that would also rewrite ":"/"," sequences inside string values.
function spacedLine(payload: AnyObj, replacer?: (string | number)[]): string {
  return JSON.stringify(payload, replacer as never, 1).replace(/\n\s*/g, " ");
}
function printJson(payload: AnyObj): void { console.log(spacedLine(payload)); }
export function loadJson(file: string, fallback: AnyObj = {}): AnyObj { return fs.existsSync(file) ? JSON.parse(read(file)) : { ...fallback }; }
export function appendJsonl(file: string, payload: AnyObj): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = spacedLine(payload, Object.keys(payload).sort());
  fs.appendFileSync(file, `${line}\n`);
}
function die(message: string): never { throw new Error(message); }
function slugify(value: string, fallback: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback; }
/** Derives a deterministic, filesystem-safe slug from a canonical work-item ref like `kontourai/flow-agents#161`.
 * Format: `<owner>-<repo>-<id>` e.g. `kontourai-flow-agents-161`.
 * Reuses slugify() for normalization. Validates that the id is a numeric GitHub issue number. */
function workItemSlug(ref: string): string {
  const hashIdx = ref.indexOf("#");
  if (hashIdx < 0 || hashIdx === ref.length - 1) die("--work-item must be in owner/repo#id format");
  const repoPath = ref.slice(0, hashIdx);
  const id = ref.slice(hashIdx + 1);
  if (!/^\d+$/.test(id)) die("--work-item id must be a numeric issue number");
  const parts = repoPath.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) die("--work-item repo must be owner/repo format");
  const [owner, repo] = parts;
  return slugify(`${owner}-${repo}-${id}`, "work-item");
}

/** Pure, lock-free, side-effect-free CLI wrapper around workItemSlug() — the single source of
 * truth for the deterministic subjectId/session-directory-name slug. Named resolveSlugCmd (not
 * resolveSlug) to avoid colliding with any future export named resolveSlug. */
function resolveSlugCmd(p: ReturnType<typeof parseArgs>): number {
  const ref = p.positional[0] || die("resolve-slug requires an owner/repo#id ref");
  console.log(workItemSlug(ref));
  return 0;
}

/** First 6 hex chars of sha256(raw) — a short deterministic disambiguator (#289 F4). Two
 * different raw inputs that both collapse to a segment's "unknown" fallback (e.g. two distinct
 * all-garbage --task-slug values, or two distinct raw actor strings that both resolve
 * "unresolved") would otherwise derive the identical fallback branch — this makes them diverge
 * while staying fully deterministic for a given raw input (same raw -> same hash every call),
 * which is required to preserve resolveSessionBranch's no-rederive/resume-continuity semantics
 * (a resumed session's already-recorded branch is never recomputed regardless of this helper). */
function unknownDisambiguator(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 6);
}

/** Encode a value (actor string or --task-slug, neither guaranteed git-ref-safe) into a
 * single git-check-ref-format(1)-safe branch path component (#289). Reuses
 * actor-identity.js's sanitizeSegment (consume, don't fork) as the base, then closes the
 * git-specific gaps sanitizeSegment's [A-Za-z0-9_.-] charset does not: the `:` delimiter
 * serializeActor() uses (disallowed in a git ref), consecutive dots, a leading dot, a trailing
 * dot (fix-plan iteration 1 F1 — git-check-ref-format forbids a component ending in `.`, and
 * the prior pass only handled a run of 2+ trailing dots via the `..`-collapse step, missing the
 * single-trailing-dot case e.g. a `--task-slug` of `my-fix.`), and a trailing `.lock`. The
 * trailing-dot strip runs BEFORE the `.lock` rewrite so a `.lock` suffix hidden behind trailing
 * dots (e.g. `foo.lock.`) is exposed and still rewritten rather than left dangling. Whenever the
 * FINAL sanitized segment equals the fallback token `"unknown"` — whether because the charset
 * filter collapsed the raw input to nothing, OR because the leading-/trailing-dot stripping
 * above collapsed a near-miss input like `"unknown."` or `".unknown"` down to the literal
 * `"unknown"`, OR because the raw input genuinely WAS the literal string `"unknown"` — a
 * deterministic disambiguator (see unknownDisambiguator) is ALWAYS appended (fix-plan iteration 2
 * F4': no literal-input carve-out). Distinct raw inputs can never collide on the bare literal
 * `"unknown"` segment; the same raw input always re-derives the same disambiguated segment. See
 * Design Decision 2 in the plan. */
function sanitizeBranchSegment(value: string, helper: { sanitizeSegment: (v: unknown) => string }): string {
  const raw = String(value ?? "");
  const colonReplaced = raw.replace(/:/g, "-");
  let seg = helper.sanitizeSegment(colonReplaced);
  seg = seg.replace(/\.{2,}/g, "-").replace(/^\.+/, "").replace(/\.+$/, "").replace(/\.lock$/i, "-lock");
  if (!seg || seg === "unknown") return `unknown-${unknownDisambiguator(raw)}`;
  return seg;
}

/** Validate an explicit `--branch` value strictly rather than trusting it verbatim (fix-plan
 * iteration 1 F2, tightened by iteration 2 F2'). Explicit `--branch` bypasses
 * `sanitizeBranchSegment` entirely by design (it is caller intent, may legitimately contain `/`
 * to nest under `agent/...`, etc.), so unlike the derived path it must be rejected outright — not
 * silently sanitized — when it cannot be a valid git ref. Whole-string checks (iteration 1):
 * any control character/newline, a space, a leading or trailing `/`, a `//` sequence, a leading
 * `.`, any `..` sequence, a trailing `.`, a trailing `.lock`, or any character outside
 * `[A-Za-z0-9_./-]`. Per-component checks (iteration 2 F2'): the whole-string checks above only
 * examine the START/END of the full value, so a charset-legal value can still smuggle an invalid
 * `/`-delimited component past them — e.g. `"-lead"` (a leading `-` breaks the whole git ref,
 * applied uniformly to every component here — stricter than git strictly requires, which is fine
 * for a caller-facing override flag), `"a/.b"` (a non-first component starting with `.`),
 * `"foo.lock/bar"` (a non-last component ending in `.lock`), or `"a/./b"` (a component that is
 * exactly `.`). Belt-and-braces (F2'): once the lexical checks above all pass, `git
 * check-ref-format --branch <value>` (the real git binary) is run as the final authority — it can
 * only ever REJECT a value the lexical checks let through (never re-legalize one they rejected),
 * so it closes any residual gap in this hand-rolled lexical pass. When git cannot be spawned at
 * all (e.g. not installed — `ENOENT`) or does not complete (e.g. the 5s timeout fires), the git
 * check is skipped silently and the lexical checks above remain the sole authority. Dies with
 * remediation, or with git's own rejection message; never mutates any artifact before this check
 * runs (resolveSessionBranch calls this before any file write). */
function validateExplicitBranch(value: string): void {
  const remediation = `Pass a --branch value matching [A-Za-z0-9_./-], with no leading/trailing "/", no "//", no leading ".", no ".." sequence, and no trailing "." or ".lock" (got: ${JSON.stringify(value)}).`;
  const fail = (reason: string): never => die(`ensure-session --branch value is not a valid git ref: ${reason}. ${remediation}`);
  if (/[\x00-\x1F\x7F]/.test(value)) fail("contains a control character or newline");
  if (/ /.test(value)) fail("contains a space");
  if (value.startsWith("/") || value.endsWith("/")) fail('must not start or end with "/"');
  if (value.includes("//")) fail('must not contain "//"');
  if (value.startsWith(".")) fail('must not start with "."');
  if (value.includes("..")) fail('must not contain a ".." sequence');
  if (value.endsWith(".")) fail('must not end with "."');
  if (/\.lock$/i.test(value)) fail('must not end with ".lock"');
  if (/[^A-Za-z0-9_./-]/.test(value)) fail("contains a character outside [A-Za-z0-9_./-]");

  // F2' per-component checks: split on "/" and validate each path component individually. The
  // whole-string checks above cannot catch a hostile component that is not at the very start or
  // end of the full value.
  for (const component of value.split("/")) {
    if (!component) fail('must not contain an empty path component ("//" or a leading/trailing "/")');
    if (component === ".") fail('must not contain a path component that is exactly "."');
    if (component.startsWith(".")) fail('must not contain a path component starting with "."');
    if (component.startsWith("-")) fail('must not contain a path component starting with "-"');
    if (component.endsWith(".")) fail('must not contain a path component ending with "."');
    if (/\.lock$/i.test(component)) fail('must not contain a path component ending with ".lock"');
  }

  // F2' belt-and-braces: the real `git check-ref-format --branch` binary is the final authority
  // when git is available. This can only REJECT a value that already passed every lexical check
  // above — it never re-legalizes a value the lexical checks rejected (those `fail()` calls
  // above already threw). argv-array form (no shell) with a 5s timeout so a hung or missing git
  // binary cannot hang or crash session creation.
  let result: { status: number | null; stderr: Buffer | string } | undefined;
  try {
    execFileSync("git", ["check-ref-format", "--branch", value], { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
    return; // exit 0 — git accepts the value; nothing further to check.
  } catch (err) {
    const spawnError = err as NodeJS.ErrnoException & { status?: number | null; stderr?: Buffer | string };
    if (spawnError && spawnError.code === "ENOENT") return; // git not installed — lexical checks stand alone.
    if (spawnError && typeof spawnError.status === "number") { result = { status: spawnError.status, stderr: spawnError.stderr ?? "" }; }
    else return; // Any other spawn failure (e.g. timeout) — skip silently; lexical checks already passed.
  }
  if (result && result.status !== 0) {
    const gitMessage = String(result.stderr ?? "").trim();
    fail(gitMessage ? `git check-ref-format rejected the value: ${gitMessage}` : "git check-ref-format rejected the value");
  }
}

/**
 * #291 Wave 2 Task 2.1: the single shared actor resolver for ensure-session — used by BOTH
 * resolveSessionBranch() (below) and the new ownership guard inside ensureSession(), so the
 * branch-naming actor and the assignment-claim actor are ALWAYS derived from the same one
 * resolution pass (never re-derived twice with any risk of divergence). Same explicit-actor
 * validation/die behavior as before this refactor (garbage --actor still dies; ambiguous/
 * unresolved actor never hard-fails session creation — Design Decision 4).
 *
 * Returns TWO distinct identity strings, not one, because this repo already has two genuinely
 * different actor-identity conventions in play and reconciling them into a single string would
 * either break existing branch-naming byte-for-byte (see test_workflow_sidecar_writer.sh AC4) or
 * break self-recognition against a durable assignment-claim record:
 *   - `branchActorKey`: the flat, single-token-or-triple string this file has ALWAYS used for
 *     branch naming, liveness `--actor`, and (Wave 2 Task 2.1 §6) per-actor current.json
 *     partitioning — exactly `resolveActor(env).actor`, or the bare sanitized explicit --actor
 *     override, unchanged from before this refactor.
 *   - `actorStruct` / `claimActorKey` (`= serializeActor(actorStruct)`): a structured ActorStruct
 *     for the assignment-provider claim record's `actor` field (Wave 1's `performLocalClaim`/
 *     `performLocalSupersede` require one), and the identity string passed as `computeEffectiveState`'s
 *     `selfActor` param. For the common/default case (no explicit --actor override — the ambient
 *     runtime-session-id or process-ancestry derivation), this is reconstructed from the SAME
 *     exported primitives `resolveActor()` uses internally, so `claimActorKey` reproduces
 *     `branchActorKey` bit-for-bit. For an explicit --actor override, no ambient ActorStruct
 *     exists (resolveActor()'s override branch is a flat bypass, never a serializeActor() triple),
 *     so a synthetic-but-deterministic wrapper is used instead — self-recognition on reentry still
 *     holds (same override value always re-derives the same claimActorKey), but this synthetic key
 *     will not equal a DIFFERENT process's flat `liveness claim --actor <sameOverrideValue>` actor
 *     string (that command's own `--actor` bypass strips the same override value's ':' or wraps it
 *     no differently — a pre-existing seam between the liveness-actor and assignment-actor
 *     identity domains, not introduced by this task; see Wave 2 Task 2.1 plan Conflict #3).
 */
function resolveEnsureSessionActor(p: ReturnType<typeof parseArgs>): { actorStruct: ActorStruct; actorKey: string; branchActorKey: string; unresolved: boolean } {
  const helper = loadActorIdentityHelper();
  const explicitActorRaw = opt(p, "actor", "").trim();
  if (explicitActorRaw && !/[A-Za-z0-9_.-]/.test(explicitActorRaw)) {
    die("ensure-session --actor value strips to empty under the allowed actor charset ([A-Za-z0-9_.-]) — pass a value containing at least one letter, digit, underscore, period, or hyphen.");
  }
  const explicitActor = explicitActorRaw ? helper.sanitizeSegment(explicitActorRaw) : "";
  const resolved = explicitActor ? { actor: explicitActor, source: "explicit-override" } : helper.resolveActor(process.env);
  const unresolved = helper.isUnresolvedActor(resolved.actor);
  const branchActorKey = unresolved ? `unknown-actor-${unknownDisambiguator(resolved.actor)}` : resolved.actor;

  if (unresolved) {
    // Design Decision 4 (unchanged): never hard-fail session creation on actor ambiguity. No real
    // ActorStruct exists for "unresolved" — the guard (ensureSession) is responsible for skipping
    // the ownership guard entirely when unresolved, rather than claiming under a synthetic identity.
    return { actorStruct: { runtime: "unresolved", session_id: branchActorKey, host: os.hostname() }, actorKey: resolved.actor, branchActorKey, unresolved: true };
  }

  const actorStruct: ActorStruct = resolved.source === "explicit-override"
    ? { runtime: "explicit-override", session_id: resolved.actor, host: os.hostname() }
    : { runtime: helper.detectRuntime(process.env), session_id: helper.runtimeSessionId(process.env) || (() => { const seed = helper.ancestorActorSeed(); return seed ? `anc-${seed}` : ""; })(), host: os.hostname() };
  const actorKey = helper.serializeActor(actorStruct);
  return { actorStruct, actorKey, branchActorKey, unresolved: false };
}

/**
 * Resolve an actor key for a READ-ONLY consumer (current(), currentDir(), recordAgentEvent(),
 * writeTrustBundle()'s default) — deliberately lenient (never
 * dies on a garbage --actor value; that enforcement belongs only to the write/claim path in
 * resolveEnsureSessionActor above). Falls back to resolveActor(process.env) exactly like every
 * write path already does. The returned value is passed straight into
 * scripts/hooks/lib/current-pointer.js's readCurrentPointer(), which already tolerates an empty
 * or unresolved actor by falling straight through to the legacy current.json branch — so an
 * unresolved actor here reproduces exactly today's (pre-#291) legacy-only read behavior.
 */
function resolveReadActorKey(p: ReturnType<typeof parseArgs>): string {
  const helper = loadActorIdentityHelper();
  const explicit = opt(p, "actor", "").trim();
  return explicit ? helper.sanitizeSegment(explicit) : helper.resolveActor(process.env).actor;
}

/** Resolve the branch to seed a brand-new session with. Only called from ensureSession's
 * `if (!md)` fresh-creation branch — an existing session's already-recorded branch is never
 * recomputed (ADR 0021 §5 takeover continuity; see Design Decision 3). Precedence: explicit
 * --branch (strictly validated, then honored verbatim — see F2) > derived agent/<actor>/<slug>.
 * Never hard-fails session creation on actor-resolution ambiguity (Design Decision 4) — only a
 * garbage explicit --actor, or a garbage explicit --branch, dies. */
function resolveSessionBranch(p: ReturnType<typeof parseArgs>, slug: string): string {
  // Deliberately NOT trimmed before validation (unlike the pre-F2 baseline): a leading/trailing
  // space must be REJECTED, not silently trimmed away — silent trimming would let a
  // caller-supplied value differ from what gets recorded without any diagnostic (F2).
  const explicitBranch = opt(p, "branch");
  if (explicitBranch) { validateExplicitBranch(explicitBranch); return explicitBranch; }
  const helper = loadActorIdentityHelper();
  // #291 Wave 2 Task 2.1: actor resolution is now single-sourced via resolveEnsureSessionActor()
  // (shared with the new ownership guard) — branchActorKey reproduces EXACTLY what this function's
  // own inline `actor` variable used to compute, so branch naming is byte-identical to before this
  // refactor (proven by test_workflow_sidecar_writer.sh's AC2/AC4/AC5 branch-naming assertions).
  const { branchActorKey, unresolved } = resolveEnsureSessionActor(p);
  const safeActor = unresolved ? branchActorKey : sanitizeBranchSegment(branchActorKey, helper);
  if (unresolved) process.stderr.write("[ensure-session] actor unresolved; branch uses \"unknown-actor\" segment (set --actor or FLOW_AGENTS_ACTOR for a stable branch name)\n");
  return `agent/${safeActor}/${sanitizeBranchSegment(slug, helper)}`;
}

/**
 * Validate a Hachure trust.bundle using @kontourai/surface's canonical validator
 * (surface is the authoritative owner of trust-bundle schema validation per ADR 0010 / ADR 0015).
 * Returns `{ valid, errors, available }`. When @kontourai/surface is unavailable,
 * `available` is false and `valid` is true (fail-open) so callers can choose to treat
 * unvalidated bundles as acceptable or gate on `available`. Surface is REQUIRED for
 * bundle writes per ADR 0010 Phase 4c — `assertBundleWritten` enforces this on the
 * write path. Surface's validator is equivalent-or-stronger than the prior hachure
 * JSON-Schema validator: it validates the same structural constraints plus cross-reference
 * integrity (evidence/event → claim references) that the JSON schema did not enforce.
 */
export async function validateTrustBundle(bundle: unknown): Promise<{ valid: boolean; errors: string[]; available: boolean }> {
  // Use the already-loaded surface module when available (zero-cost re-entry after first load).
  // When called standalone (fresh process, surface not yet loaded), attempt a one-shot import.
  let surfaceValidate: ((input: unknown) => unknown) | undefined;
  if (_surfaceModule !== undefined) {
    // Module has been attempted: use cached result (null = unavailable).
    surfaceValidate = _surfaceModule?.validateTrustBundle ?? undefined;
  } else {
    // Not yet attempted — load now for standalone callers (e.g. library consumers, tests).
    const m = await tryLoadSurface();
    surfaceValidate = m?.validateTrustBundle ?? undefined;
  }
  if (!surfaceValidate) return { valid: true, errors: [], available: false };
  try {
    surfaceValidate(bundle);
    return { valid: true, errors: [], available: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, errors: [message], available: true };
  }
}
// Validate a single InquiryRecord against the hachure inquiry-record.schema.json.
// Uses a separate AJV instance compiled against that schema (not the trust-bundle schema).
let _hachureInquiryRecordValidator: ((record: unknown) => { valid: boolean; errors: string[] }) | null | undefined;
function getHachureInquiryRecordValidator(): ((record: unknown) => { valid: boolean; errors: string[] }) | null {
  if (_hachureInquiryRecordValidator !== undefined) return _hachureInquiryRecordValidator;
  try {
    const _require = createRequire(import.meta.url);
    const hachureDir = path.dirname(_require.resolve("hachure"));
    const schemasDir = path.join(hachureDir, "schemas");
    const Ajv = _require("ajv/dist/2020");
    const schemas: Record<string, any> = {};
    for (const file of fs.readdirSync(schemasDir)) {
      if (!file.endsWith(".schema.json")) continue;
      schemas[file] = JSON.parse(fs.readFileSync(path.join(schemasDir, file), "utf8"));
    }
    const inquiryRecordSchema = schemas["inquiry-record.schema.json"];
    if (!inquiryRecordSchema) { _hachureInquiryRecordValidator = null; return null; }
    const ajv = new Ajv({ strict: false, allErrors: true });
    for (const [filename, schema] of Object.entries(schemas)) {
      if (filename === "inquiry-record.schema.json") continue;
      ajv.addSchema(schema, filename);
    }
    const validate = ajv.compile(inquiryRecordSchema);
    _hachureInquiryRecordValidator = (record: unknown) => {
      const valid = validate(record);
      if (valid) return { valid: true, errors: [] };
      const errors = ((validate as any).errors ?? []).map((err: any) => {
        const loc = err.instancePath || err.schemaPath || "";
        return `${loc} ${err.message ?? "invalid"}`.trim();
      });
      return { valid: false, errors };
    };
    return _hachureInquiryRecordValidator;
  } catch {
    _hachureInquiryRecordValidator = null;
    return null;
  }
}
/**
 * Validate a record against the canonical hachure inquiry-record.schema.json
 * (https://kontourai.io/schemas/surface/inquiry-record.schema.json).
 * Returns `{ valid, errors, available }`. Fail-open when hachure is not installed.
 */
export function validateInquiryRecord(record: unknown): { valid: boolean; errors: string[]; available: boolean } {
  const validate = getHachureInquiryRecordValidator();
  if (!validate) return { valid: true, errors: [], available: false };
  return { ...validate(record), available: true };
}
// ─── @kontourai/surface status derivation ────────────────────────────────────
// Surface is ESM-only; this module builds to CJS. Load Surface via a fail-open
// cached dynamic import(). If Surface cannot be loaded, bundle writes are
// skipped entirely — no hand-rolled fork fallback.
//
// SurfaceInquiry / SurfaceInquiryRecord — minimal local shapes mirroring the
// canonical Surface Inquiry / InquiryRecord types. Using Record-based typing
// keeps this module free of a direct ESM import at compile time.
type SurfaceInquiry = {
  id: string;
  question: string;
  askedBy: string;
  askedAt: string;
  target?: { subjectType: string; subjectId: string; fieldOrBehavior: string; qualifiers?: Record<string, string> };
  metadata?: Record<string, unknown>;
};
type SurfaceInquiryRecord = {
  id: string;
  inquiry: SurfaceInquiry;
  outcome: "matched" | "derived" | "unsupported";
  resolutionPath: {
    claimIds: string[];
    ruleId?: string;
    ruleVersion?: string;
    identityLinkIds?: string[];
    transitiveRuleIds?: string[];
  };
  answer?: { value: unknown; status: string };
  inputSnapshot: Array<{ claimId: string; status: string }>;
  statusFunctionVersion: string;
  resolvedAt: string;
};
type SurfaceModule = {
  deriveClaimStatus: (args: {
    claim: Record<string, unknown>;
    evidence: Record<string, unknown>[];
    events: Record<string, unknown>[];
    policies: Record<string, unknown>[];
    now?: Date;
  }) => { status: string; policyId: string | undefined };
  generateClaimId: (subjectId: string, facet: string, fieldOrBehavior: string) => string;
  statusFunctionVersion: string;
  resolveInquiry: (
    bundle: Record<string, unknown>,
    inquiry: SurfaceInquiry,
    options?: { now?: Date },
  ) => SurfaceInquiryRecord;
  buildTrustReport: (bundle: Record<string, unknown>, options?: { now?: Date }) => Record<string, unknown>;
  buildDerivationDrilldown: (report: Record<string, unknown>, claimId: string) => Record<string, unknown>;
  /** Canonical trust-bundle validator from @kontourai/surface. Throws on invalid input; returns TrustBundle on success. */
  validateTrustBundle: (input: unknown) => Record<string, unknown>;
  /** Freeze a derivation checkpoint from a report. */
  checkpointFromReport: (report: Record<string, unknown>) => Record<string, unknown>;
  /** Diff two derivations (prior checkpoint → later report) and emit freshness transition events. */
  diffFreshness: (prior: Record<string, unknown>, next: Record<string, unknown>) => Array<Record<string, unknown>>;
  // ─── Increment B1: in-toto / Sigstore interop (consumed from Surface) ────────
  /** Wrap a TrustBundle as an in-toto Statement v1. */
  toInTotoStatement: (bundle: Record<string, unknown>, options: { subjects: Array<{ name: string; digest: Record<string, string> }> }) => {
    _type: "https://in-toto.io/Statement/v1";
    subject: Array<{ name: string; digest: Record<string, string> }>;
    predicateType: "https://hachure.org/v1/bundle";
    predicate: Record<string, unknown>;
  };
  /** Sign an in-toto Statement with Sigstore keyless signing. Returns null when no OIDC identity is available (fail-open). */
  signStatementWithSigstore: (statement: {
    _type: "https://in-toto.io/Statement/v1";
    subject: Array<{ name: string; digest: Record<string, string> }>;
    predicateType: "https://hachure.org/v1/bundle";
    predicate: Record<string, unknown>;
  }) => Promise<{
    envelope: {
      payloadType: "application/vnd.in-toto+json";
      payload: string;
      signatures: Array<{ keyid: string; sig: string }>;
    };
    sigstoreBundle: unknown;
    assuranceLevel: "signed";
  } | null>;
};
let _surfaceModule: SurfaceModule | null | undefined; // undefined = not tried yet; null = unavailable
async function tryLoadSurface(): Promise<SurfaceModule | null> {
  // Test/diagnostic seam: simulate a degraded environment where Surface is unavailable,
  // to exercise the fail-loud (no silent data loss) path without disturbing node_modules.
  if (process.env.FLOW_AGENTS_SURFACE_UNAVAILABLE === "1") return null;
  if (_surfaceModule !== undefined) return _surfaceModule;
  try {
    const m = await import("@kontourai/surface");
    _surfaceModule = m as unknown as SurfaceModule;
    return _surfaceModule;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[trust-bundle] @kontourai/surface unavailable — bundle write skipped: ${message}\n`);
    _surfaceModule = null;
    return null;
  }
}

/** Map a workflow check status to the Surface VerificationEvent status. */
function checkStatusToEventStatus(status: string): string | null {
  if (status === "pass") return "verified";
  if (status === "fail") return "disputed";
  if (status === "skip") return "assumed";
  return null; // not_verified / unknown → no event → Surface returns "unknown"
}
/** Map an acceptance criterion status to the Surface VerificationEvent status. */
function criterionStatusToEventStatus(status: string): string | null {
  if (status === "pass") return "verified";
  if (status === "fail") return "disputed";
  if (status === "accepted_gap") return "assumed";
  return null; // pending / not_verified → no event → Surface returns "unknown"
}
/**
 * WS8 (ADR 0020): Derive Surface evidence classification (evidenceType + method)
 * from a workflow check's kind, replacing the previous hardcoded `test_output`.
 * Only command-backed re-runnable checks are `test_output` (CI-reconcilable);
 * everything else is inherently session-local (manual attestation, provider/
 * document citation, crawl observation, policy rule, source excerpt). The
 * `reconcilable` flag is informational — the CI reconciler classifies purely by
 * the emitted `evidenceType`. Every value is a member of Surface's own
 * evidence.schema.json `evidenceType`/`method` enums (consume-never-fork).
 */
function classifyEvidence(kind: string | undefined, hasCommand: boolean): { evidenceType: string; method: string; reconcilable: boolean } {
  const k = String(kind ?? "external");
  switch (k) {
    case "build":
    case "types":
    case "lint":
    case "test":
    case "command":
      return { evidenceType: "test_output", method: "validation", reconcilable: true };
    case "security":
      return hasCommand
        ? { evidenceType: "test_output", method: "validation", reconcilable: true }
        : { evidenceType: "attestation", method: "corroboration", reconcilable: false };
    case "diff":
      return { evidenceType: "source_excerpt", method: "extraction", reconcilable: false };
    case "browser":
      return hasCommand
        ? { evidenceType: "test_output", method: "validation", reconcilable: true }
        : { evidenceType: "crawl_observation", method: "observation", reconcilable: false };
    case "runtime":
      return hasCommand
        ? { evidenceType: "test_output", method: "validation", reconcilable: true }
        : { evidenceType: "attestation", method: "attestation", reconcilable: false };
    case "policy":
      return { evidenceType: "policy_rule", method: "auditability", reconcilable: false };
    case "external":
      return { evidenceType: "attestation", method: "corroboration", reconcilable: false };
    default:
      return { evidenceType: "test_output", method: "validation", reconcilable: true };
  }
}

/** Map a critique verdict to the Surface VerificationEvent status. */
function critiqueToEventStatus(verdict: string, findings: AnyObj[]): string | null {
  if (verdict === "fail") return "disputed";
  const hasOpenFinding = Array.isArray(findings) && findings.some((f: AnyObj) => f.status === "open");
  if (verdict === "pass" && hasOpenFinding) return "disputed";
  if (verdict === "pass") return "verified";
  if (verdict === "comment") return "assumed";
  return null; // not_verified or unknown → no event → Surface returns "unknown"
}

/**
 * Build a Hachure trust.bundle from raw check/criterion/critique inputs.
 * trust.bundle is the PRIMARY artifact (ADR 0010 Phase 4a producer inversion).
 * Callers pass raw inputs directly — not bespoke-sidecar-shaped objects.
 * Derives claim statuses using @kontourai/surface's canonical versioned function.
 * Returns null when Surface is unavailable (caller skips the bundle write).
 * @param slug       Task slug (used as subjectId prefix)
 * @param timestamp  ISO-8601 timestamp for createdAt / updatedAt / observedAt
 * @param checks     Normalized check objects (from record-evidence --check-json / --surface-trust-json)
 * @param criteria   Acceptance criteria objects (from acceptance.json .criteria array)
 * @param critiques  Critique objects (from critique.json .critiques array)
 * @param commandLog Optional parsed command-log.jsonl entries (capture-authoritative fold)
 */
export async function buildTrustBundle(slug: string, timestamp: string, checks: AnyObj[], criteria: AnyObj[], critiques: AnyObj[], commandLog?: AnyObj[], flowAgentsDir?: string, actorKey?: string): Promise<AnyObj | null> {
  const surface = await tryLoadSurface();
  if (!surface) return null;
  const { deriveClaimStatus, generateClaimId, statusFunctionVersion } = surface;

  // ADR 0016 Abstraction A (P-b): resolve active flow step for dual-emit.
  // When flowAgentsDir is provided AND current.json carries active_flow_id/active_step_id,
  // each produced claim gets a DECLARED primary claim (kit-typed) plus a legacy shadow
  // (workflow.* type, claimId suffix "-legacy") for backward compatibility. When null,
  // only the existing workflow.* claims are produced (zero behavior change).
  // #291 Wave 2 Task 2.1 (§7)/Task 2.2: actorKey (when the caller already resolved one — see
  // writeTrustBundle below) threads through to resolveActiveFlowStep's per-actor-first,
  // legacy-fallback current.json read; omitted, this is IDENTICAL to pre-#291 behavior.
  const activeStep: ActiveFlowStep | null = flowAgentsDir ? resolveActiveFlowStep(flowAgentsDir, actorKey) : null;

  const claims: AnyObj[] = [];
  const evidenceItems: AnyObj[] = [];
  const events: AnyObj[] = [];
  const ts = timestamp || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // One VerificationPolicy per distinct (claimType, requiredEvidence) pair, so status is
  // policy-governed (not derived against an empty policy set). Maximal-fidelity per ADR 0010.
  //
  // WS8 (AC1, iteration 2): the cache is keyed by claimType + the normalized requiredEvidence
  // set, NOT by claimType alone. Two checks of the same legacy claimType that differ in
  // command-presence (e.g. a command-backed browser check → requiredEvidence [test_output]
  // vs a no-command browser check → [crawl_observation]) previously COLLIDED: the first-seen
  // requiredEvidence won and corrupted the second claim's derived status (verified → proposed)
  // in a record-order-dependent way. Keying by (claimType, requiredEvidence) makes policy
  // construction order-independent — each distinct evidence signature gets its own policy, and
  // each claim references its own via verificationPolicyId (Surface's resolvePolicyForClaim
  // honors verificationPolicyId first, so same-claimType policies never cross-resolve).
  // Merging is NOT used because Surface's requiredEvidence is all-of (`.every`), so a union
  // would over-constrain both claims.
  const policies = new Map<string, AnyObj>();
  const ensurePolicy = (claimType: string, impactLevel: string, requiredEvidence: string[]): AnyObj => {
    const reqSorted = [...new Set(requiredEvidence)].sort();
    const key = `${claimType}::${reqSorted.join(",")}`;
    let p = policies.get(key);
    if (!p) {
      const id = reqSorted.length ? `policy:${claimType}:${reqSorted.join("+")}` : `policy:${claimType}`;
      p = { id, claimType, requiredEvidence: reqSorted, acceptanceCriteria: [`A verified verification event must support a ${claimType} claim.`], reviewAuthority: "system", validityRule: { kind: "manual" }, stalenessTriggers: [], conflictRules: [], impactLevel };
      policies.set(key, p);
    }
    return p;
  };

  // Index the deterministic capture log by normalized command (a single FAIL wins),
  // so a claimed-pass check whose command actually FAILED becomes authoritative here.
  const captureByCommand = new Map<string, { observedResult: string; exitCode: number | null }>();
  for (const entry of Array.isArray(commandLog) ? commandLog : []) {
    if (!entry || typeof entry.command !== "string") continue;
    const key = entry.command.replace(/\s+/g, " ").trim();
    if (!key) continue;
    const failed = entry.observedResult === "fail" || (Number.isInteger(entry.exitCode) && entry.exitCode !== 0);
    const prev = captureByCommand.get(key);
    captureByCommand.set(key, { observedResult: failed || (prev && prev.observedResult === "fail") ? "fail" : "pass", exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : (prev ? prev.exitCode : null) });
  }

  // ─── P-b dual-emit helper ──────────────────────────────────────────────────
  // Semantic matching table (ADR 0016 Abstraction A P-b):
  //   check (non-policy kind) → expects[] entry where claimType does NOT contain
  //     "acceptance" AND subjectType is NOT "decision". Preference: subjectType=
  //     "flow-step". Fallback: first non-decision, non-acceptance entry.
  //   check (kind=policy)     → expects[] entry whose claimType contains
  //     "compliance" or "policy". Fallback: same as non-policy.
  //   acceptance criterion    → expects[] entry whose subjectType is "flow-step"
  //     OR claimType contains "tests" OR "compliance". Fallback: first entry.
  //   critique                → expects[] entry whose claimType contains "policy"
  //     OR "compliance" AND subjectType is "artifact". Fallback: last entry.
  //
  // The DECLARED claim is primary (kit-typed claimType + subjectType).
  // The legacy claim uses the existing workflow.* claimType (suffix "-legacy") as
  // a backward-compat shadow. Both cite the same evidence. Status is derived by
  // Surface from that evidence (never hand-set).
  //
  // Per-gate producibility (ADR 0016 P-d):
  //   (a) Already handled via subjectType=flow-step preference:
  //       builder.verify.tests       (verify-gate, subjectType=flow-step)
  //       builder.verify.policy-compliance (verify-gate, kind=policy match)
  //   (b) Producible via fallback (non-decision, non-acceptance, first match):
  //       builder.plan.implementation   (plan-gate, subjectType=artifact)
  //       builder.execute.scope         (execute-gate, subjectType=change)
  //       builder.merge-ready.readiness (merge-ready-gate, subjectType=change)
  //       builder.merge-ready-ci.readiness (merge-ready-ci-gate, subjectType=pull-request)
  //   (c) No natural producer — required:false in build.flow.json (ADR 0016 P-d plan):
  //       builder.pull-work.selected        (pull-work-gate, subjectType=work-item)
  //       builder.design-probe.pickup-readiness (design-probe-gate, subjectType=work-item)
  //       builder.design-probe.decisions    (design-probe-gate, subjectType=decision)
  //       builder.pr-open.pull-request      (pr-open-gate, subjectType=pull-request)
  //       builder.learn.decisions           (learn-gate, subjectType=decision)
  //       builder.learn.evidence            (learn-gate, subjectType=release)
  //   For category (c): record-gate-claim subcommand allows skills to target a specific
  //   expects[] entry by --expectation <id>, bypassing this semantic match entirely.
  function matchExpectsEntry(kind: "check" | "acceptance" | "critique", checkKindVal?: string, expectationId?: string): { claimType: string; subjectType: string } | null {
    if (!activeStep || activeStep.gateExpects.length === 0) return null;
    const expects = activeStep.gateExpects;
    if (kind === "check") {
      // ADR 0016 P-d Increment 2: when an explicit expectation id is given (from record-gate-claim
      // --expectation), bypass heuristics and do exact lookup. This ensures multi-expects[] gates
      // (learn-gate: decision + release; design-probe-gate: work-item + decision) produce the
      // correct declared claimType rather than the heuristic-selected one.
      if (expectationId) {
        const exact = expects.find((e) => e.id === expectationId);
        if (exact) return { claimType: exact.bundle_claim.claimType, subjectType: exact.bundle_claim.subjectType };
      }
      const isPolicy = checkKindVal === "policy";
      if (isPolicy) {
        const match = expects.find((e) => {
          const ct = e.bundle_claim.claimType.toLowerCase();
          return ct.includes("compliance") || ct.includes("policy");
        });
        if (match) return { claimType: match.bundle_claim.claimType, subjectType: match.bundle_claim.subjectType };
      }
      // Non-policy: prefer flow-step subjectType, exclude decision/acceptance entries
      const preferred = expects.find((e) => {
        const ct = e.bundle_claim.claimType.toLowerCase();
        return e.bundle_claim.subjectType !== "decision" && !ct.includes("acceptance") && e.bundle_claim.subjectType === "flow-step";
      });
      if (preferred) return { claimType: preferred.bundle_claim.claimType, subjectType: preferred.bundle_claim.subjectType };
      const fallback = expects.find((e) => {
        const ct = e.bundle_claim.claimType.toLowerCase();
        return e.bundle_claim.subjectType !== "decision" && !ct.includes("acceptance");
      });
      if (fallback) return { claimType: fallback.bundle_claim.claimType, subjectType: fallback.bundle_claim.subjectType };
      return null;
    }
    if (kind === "acceptance") {
      const match = expects.find((e) => {
        const ct = e.bundle_claim.claimType.toLowerCase();
        return e.bundle_claim.subjectType === "flow-step" || ct.includes("tests") || ct.includes("compliance");
      });
      if (match) return { claimType: match.bundle_claim.claimType, subjectType: match.bundle_claim.subjectType };
      return { claimType: expects[0]!.bundle_claim.claimType, subjectType: expects[0]!.bundle_claim.subjectType };
    }
    if (kind === "critique") {
      const match = expects.find((e) => {
        const ct = e.bundle_claim.claimType.toLowerCase();
        return e.bundle_claim.subjectType === "artifact" && (ct.includes("policy") || ct.includes("compliance"));
      });
      if (match) return { claimType: match.bundle_claim.claimType, subjectType: match.bundle_claim.subjectType };
      const last = expects[expects.length - 1]!;
      return { claimType: last.bundle_claim.claimType, subjectType: last.bundle_claim.subjectType };
    }
    return null;
  }
  // ────────────────────────────────────────────────────────────────────────────

  // Evidence checks → claims + evidence items + events. Capture is authoritative.
  for (const check of Array.isArray(checks) ? checks : []) {
    if (!check.id) continue;
    const subjectId = `${slug}/${check.id}`;
    const fieldOrBehavior = String(check.summary ?? check.id);
    const claimId = generateClaimId(subjectId, "flow-agents.workflow", fieldOrBehavior);
    const evId = `ev:${claimId}`;
    const legacyClaimType = `workflow.check.${check.kind ?? "external"}`;

    const cmd = typeof check.command === "string" ? check.command.replace(/\s+/g, " ").trim() : "";
    const captured = cmd ? captureByCommand.get(cmd) : undefined;
    // WS8 (ADR 0020): classify evidence from check.kind instead of hardcoding test_output.
    // A waived accepted-gap (check._waiver, set by record-evidence/record-gate-claim
    // --accepted-gap-reason/--waived-by) is by definition session-local: it is an
    // attested accepted gap, never a CI-re-runnable command, so it is classified
    // attestation/attestation and its claim status is forced to `assumed` (reusing the
    // existing accepted_gap -> assumed mapping — no new status value).
    const waiver = (check._waiver && typeof check._waiver === "object") ? check._waiver as AnyObj : null;
    const evClass = waiver
      ? { evidenceType: "attestation", method: "attestation", reconcilable: false }
      : classifyEvidence(check.kind, cmd.length > 0);
    const policy = ensurePolicy(legacyClaimType, "high", [evClass.evidenceType]);
    const effectiveStatus = captured ? captured.observedResult : String(check.status ?? "");
    const evStatus = waiver ? "assumed" : checkStatusToEventStatus(effectiveStatus);
    // Promotion claim marker (issue #312): a `promote` check carries a session-local
    // _promotion object that must survive onto claim.metadata.promotion so the archive gate
    // (workflow-artifact-cleanup-audit) and validators can detect the promotion claim without a
    // new manifest entry. It rides alongside any waiver in a single merged metadata object.
    const promotionMeta = (check._promotion && typeof check._promotion === "object") ? check._promotion as AnyObj : null;
    // #268: stamp a stable origin discriminator so checksFromBundle / critiquesFromBundle can
    // distinguish check vs critique vs acceptance claims across round-trips even under --flow-id,
    // where all three collapse onto the same declared claimType (and a command-less critique claim
    // would otherwise be re-absorbed as a test_output check → permanent [not-run] divergence).
    const claimMetadata: AnyObj = { origin: "check", check_kind: String(check.kind ?? "external"), ...(waiver ? { waiver } : {}), ...(promotionMeta ? { promotion: promotionMeta } : {}) };

    const claimEvents: AnyObj[] = [];
    if (evStatus) {
      const evt: AnyObj = { id: `evt:${claimId}`, claimId, status: evStatus, actor: "flow-agents/workflow-sidecar", method: "validation", evidenceIds: [evId], createdAt: ts, verifiedAt: ts };
      events.push(evt);
      claimEvents.push(evt);
    }
    const evItem: AnyObj = { id: evId, claimId, evidenceType: evClass.evidenceType, method: evClass.method, sourceRef: `${slug}/evidence.json`, excerptOrSummary: fieldOrBehavior, observedAt: ts, collectedBy: "flow-agents/workflow-sidecar", passing: effectiveStatus === "pass" };
    if (captured) {
      evItem.sourceRef = `${slug}/command-log.jsonl`;
      evItem.collectedBy = "flow-agents/evidence-capture";
      evItem.execution = { runner: "bash", label: cmd, isError: captured.observedResult === "fail", ...(captured.exitCode != null ? { exitCode: captured.exitCode } : {}) };
    } else if (cmd && !waiver) {
      // WS8 (ADR 0020): always stamp execution.label on command-backed checks so the CI
      // reconciler has a stable key to match against the manifest, even when the local
      // command-log capture did not happen to run this command. isError is derived from
      // the check's own reported status (no captured exit code available in this path).
      evItem.execution = { runner: "bash", label: cmd, isError: effectiveStatus !== "pass" };
    }
    evidenceItems.push(evItem);

    // P-d: declared-only when active flow/step present (shadow retired); no-flow path unchanged.
    // When record-gate-claim sets _gate_claim_expectation_id, pass it for exact lookup (ADR 0016 P-d Increment 2).
    const declared = matchExpectsEntry("check", check.kind, typeof check._gate_claim_expectation_id === "string" ? check._gate_claim_expectation_id : undefined);
    if (declared) {
      // Declared kit-typed claim only — no legacy shadow (ADR 0016 P-d).
      const declaredPolicy = ensurePolicy(declared.claimType, "high", [evClass.evidenceType]);
      const declaredClaimObj: AnyObj = { id: claimId, subjectType: declared.subjectType, subjectId, facet: "flow-agents.workflow", claimType: declared.claimType, fieldOrBehavior, value: effectiveStatus, createdAt: ts, updatedAt: ts, impactLevel: "high", verificationPolicyId: declaredPolicy.id, ...(claimMetadata ? { metadata: claimMetadata } : {}) };
      const { status: declaredStatus } = deriveClaimStatus({ claim: declaredClaimObj as Record<string, unknown>, evidence: [evItem] as Record<string, unknown>[], events: claimEvents as Record<string, unknown>[], policies: [declaredPolicy] as Record<string, unknown>[] });
      claims.push({ ...declaredClaimObj, status: declaredStatus });
    } else {
      // No active flow step — only the workflow.* primary claim (legitimate no-flow fallback path).
      const claimObj: AnyObj = { id: claimId, subjectType: "workflow-check", subjectId, facet: "flow-agents.workflow", claimType: legacyClaimType, fieldOrBehavior, value: effectiveStatus, createdAt: ts, updatedAt: ts, impactLevel: "high", verificationPolicyId: policy.id, ...(claimMetadata ? { metadata: claimMetadata } : {}) };
      const { status: derivedStatus } = deriveClaimStatus({ claim: claimObj as Record<string, unknown>, evidence: [evItem] as Record<string, unknown>[], events: claimEvents as Record<string, unknown>[], policies: [policy] as Record<string, unknown>[] });
      claims.push({ ...claimObj, status: derivedStatus });
    }
  }

  // Acceptance criteria → claims + events
  for (const criterion of Array.isArray(criteria) ? criteria : []) {
    if (!criterion.id) continue;
    const subjectId = `${slug}/${criterion.id}`;
    const fieldOrBehavior = String(criterion.description ?? criterion.id);
    const claimId = generateClaimId(subjectId, "flow-agents.workflow", fieldOrBehavior);
    const legacyClaimType = "workflow.acceptance.criterion";
    const policy = ensurePolicy(legacyClaimType, "high", []);
    const evStatus = criterionStatusToEventStatus(String(criterion.status ?? ""));
    const claimEvents: AnyObj[] = [];
    if (evStatus) {
      const evt: AnyObj = { id: `evt:${claimId}`, claimId, status: evStatus, actor: "flow-agents/workflow-sidecar", method: "validation", evidenceIds: [], createdAt: ts, verifiedAt: ts };
      events.push(evt);
      claimEvents.push(evt);
    }

    // P-d: declared-only when active flow/step present (shadow retired); no-flow path unchanged.
    const declared = matchExpectsEntry("acceptance");
    if (declared) {
      // Declared kit-typed claim only — no legacy shadow (ADR 0016 P-d).
      const declaredPolicy = ensurePolicy(declared.claimType, "high", []);
      const declaredClaimObj: AnyObj = { id: claimId, subjectType: declared.subjectType, subjectId, facet: "flow-agents.workflow", claimType: declared.claimType, fieldOrBehavior, value: criterion.status, createdAt: ts, updatedAt: ts, impactLevel: "high", verificationPolicyId: declaredPolicy.id, metadata: { origin: "acceptance" } };
      const { status: declaredStatus } = deriveClaimStatus({ claim: declaredClaimObj as Record<string, unknown>, evidence: [], events: claimEvents as Record<string, unknown>[], policies: [declaredPolicy] as Record<string, unknown>[] });
      claims.push({ ...declaredClaimObj, status: declaredStatus });
    } else {
      // No active flow step — only the workflow.* primary claim (legitimate no-flow fallback path).
      const claimObj: AnyObj = { id: claimId, subjectType: "workflow-acceptance-criterion", subjectId, facet: "flow-agents.workflow", claimType: legacyClaimType, fieldOrBehavior, value: criterion.status, createdAt: ts, updatedAt: ts, impactLevel: "high", verificationPolicyId: policy.id, metadata: { origin: "acceptance" } };
      const { status: derivedStatus } = deriveClaimStatus({ claim: claimObj as Record<string, unknown>, evidence: [], events: claimEvents as Record<string, unknown>[], policies: [policy] as Record<string, unknown>[] });
      claims.push({ ...claimObj, status: derivedStatus });
    }
  }

  // Critique entries → claims + events
  for (const c of Array.isArray(critiques) ? critiques : []) {
    if (!c.id) continue;
    const subjectId = `${slug}/${c.id}`;
    const fieldOrBehavior = String(c.summary ?? c.verdict ?? c.id);
    // #267/#282: a critique carrying `superseded_by` is retained as HISTORY — a prior write for
    // this critique id that a later, same-reviewer critique resolved. It is preserved structurally
    // (status "superseded" + first-class metadata.superseded_by), but is excluded from reconcile
    // evaluation and from the "critique pass cannot include fail members" validator rule.
    const supersededBy = typeof c.superseded_by === "string" && c.superseded_by.length > 0 ? c.superseded_by : null;
    const critiqueReviewer = String(c.reviewer ?? "tool-code-reviewer");
    const critiqueReviewedAt = String(c.reviewed_at ?? ts);
    const critMeta: AnyObj = { origin: "critique", reviewer: critiqueReviewer, reviewed_at: critiqueReviewedAt, ...(supersededBy ? { superseded_by: supersededBy } : {}) };
    // A superseded historical write gets a distinct, stable claimId so it co-exists with the live
    // claim of the same critique id (never overwrites or duplicates it). The salt is reproducible
    // across rebuilds because superseded_by + reviewed_at are preserved in metadata.
    const claimIdSalt = supersededBy ? `${fieldOrBehavior}::superseded::${supersededBy}::${critiqueReviewedAt}` : fieldOrBehavior;
    const claimId = generateClaimId(subjectId, "flow-agents.workflow", claimIdSalt);
    const legacyClaimType = "workflow.critique.review";
    const policy = ensurePolicy(legacyClaimType, "medium", []);
    // A superseded write emits NO verification event (its status is "superseded" directly).
    const evStatus = supersededBy ? null : critiqueToEventStatus(String(c.verdict ?? ""), c.findings ?? []);
    const claimEvents: AnyObj[] = [];
    if (evStatus) {
      const evt: AnyObj = { id: `evt:${claimId}`, claimId, status: evStatus, actor: "flow-agents/workflow-sidecar", method: "validation", evidenceIds: [], createdAt: ts, verifiedAt: ts };
      events.push(evt);
      claimEvents.push(evt);
    }

    // P-d: declared-only when active flow/step present (shadow retired); no-flow path unchanged.
    const declared = matchExpectsEntry("critique");
    const claimType = declared ? declared.claimType : legacyClaimType;
    const subjectType = declared ? declared.subjectType : "workflow-critique";
    const claimPolicy = declared ? ensurePolicy(declared.claimType, "medium", []) : policy;
    const claimObj: AnyObj = { id: claimId, subjectType, subjectId, facet: "flow-agents.workflow", claimType, fieldOrBehavior, value: c.verdict, createdAt: ts, updatedAt: ts, impactLevel: "medium", verificationPolicyId: claimPolicy.id, metadata: critMeta };
    if (supersededBy) {
      // History: status is "superseded" directly (no verification event); excluded from evaluation.
      claims.push({ ...claimObj, status: "superseded" });
    } else {
      const { status: derivedStatus } = deriveClaimStatus({ claim: claimObj as Record<string, unknown>, evidence: [], events: claimEvents as Record<string, unknown>[], policies: [claimPolicy] as Record<string, unknown>[] });
      claims.push({ ...claimObj, status: derivedStatus });
    }
  }

  return {
    schemaVersion: 5,
    source: `flow-agents/workflow-sidecar;statusFunctionVersion=${statusFunctionVersion}`,
    claims,
    evidence: evidenceItems,
    policies: [...policies.values()],
    events,
  };
}

/**
 * Fail-open wrapper: builds (via Surface), validates, and writes a trust.bundle.
 * Accepts raw check/criterion/critique inputs directly (ADR 0010 Phase 4a).
 * trust.bundle is written as the PRIMARY artifact; bespoke sidecars are the
 * caller's responsibility to emit as back-compat projections AFTER this call.
 * ANY error is caught and logged to stderr — this function NEVER throws and
 * NEVER affects the exit code of its caller.
 * Returns { written: false } if Surface is unavailable (fail-open; does NOT
 * fall back to hand-rolled status derivation).
 * @param checks     Normalized check objects (same as buildTrustBundle)
 * @param criteria   Acceptance criteria objects (same as buildTrustBundle)
 * @param critiques  Critique objects (same as buildTrustBundle)
 */
export async function writeTrustBundle(dir: string, slug: string, timestamp: string, checks: AnyObj[], criteria: AnyObj[], critiques: AnyObj[], actorKey?: string): Promise<{ written: boolean; errors: string[] }> {
  try {
    // Fold the deterministic capture log (PostToolUse evidence-capture) into the
    // bundle so capture is authoritative over claimed status. Best-effort read.
    let commandLog: AnyObj[] = [];
    try {
      const raw = fs.readFileSync(path.join(dir, "command-log.jsonl"), "utf8");
      commandLog = raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l) as AnyObj; } catch { return null; } }).filter((x): x is AnyObj => x !== null);
    } catch { /* no capture log — fine */ }
    // ADR 0016 Abstraction A (P-d): pass the runtime artifact root ONLY when current.json
    // points to this session (scoped active-flow guard). If current.json.artifact_dir
    // resolves to a different session, pass null — no active-flow claim mapping for this bundle.
    // #291 Wave 2 Task 2.1 (§7): the SOURCE of "what does current.json say" now prefers the
    // resolved actor's own per-actor projection (falling back to the legacy global file) via the
    // shared readCurrentPointer() helper — the "does artifact_dir match dir?" comparison itself is
    // UNCHANGED. actorKey defaults to resolveActor(process.env) when the caller (below) does not
    // already have one resolved, exactly like every other read-path consumer in this file.
    const _flowAgentsDir = path.dirname(dir);
    const _effectiveActorKey = actorKey ?? loadActorIdentityHelper().resolveActor(process.env).actor;
    let _scopedFlowAgentsDir: string | undefined = undefined;
    try {
      const _currentRaw = loadCurrentPointerHelper().readCurrentPointer(_flowAgentsDir, _effectiveActorKey).payload;
      const _artDir = _currentRaw && typeof _currentRaw["artifact_dir"] === "string" ? (_currentRaw["artifact_dir"] as string) : null;
      if (_artDir && path.resolve(_flowAgentsDir, _artDir) === path.resolve(dir)) {
        _scopedFlowAgentsDir = _flowAgentsDir;
      }
    } catch { /* current.json absent or unreadable — no scoping */ }
    const bundle = await buildTrustBundle(slug, timestamp, checks, criteria, critiques, commandLog, _scopedFlowAgentsDir, _effectiveActorKey);
    if (!bundle) return { written: false, errors: [] }; // Surface unavailable — fail-open, skip write
    const result = await validateTrustBundle(bundle);
    if (result.available && !result.valid) {
      process.stderr.write(`[trust-bundle] schema validation failed: ${result.errors.join("; ")}\n`);
      return { written: false, errors: result.errors };
    }
    writeJson(path.join(dir, "trust.bundle"), bundle);
    return { written: true, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[trust-bundle] write failed: ${message}\n`);
    return { written: false, errors: [message] };
  }
}

// Phase 4c safety: the trust.bundle is the ONLY store (bespoke sidecars retired), so a
// fail-open write = SILENT DATA LOSS. Data-persisting writers must fail loudly when the
// bundle was not written (Surface unavailable, validation, or I/O) instead of exiting 0
// and dropping the record. (Was masked as a "flaky" concurrent-critique test.)
function assertBundleWritten(result: { written: boolean; errors: string[] }): void {
  if (result.written) return;
  const reason = result.errors.length
    ? result.errors.join("; ")
    : "@kontourai/surface is unavailable — it is REQUIRED to persist the trust.bundle (bundle-only workspace, ADR 0010 Phase 4c). Install it (>= 1.2) and retry.";
  die(`trust.bundle was NOT written — the record was not persisted: ${reason}`);
}
// ─────────────────────────────────────────────────────────────────────────────

function safeRepoIdentifier(value: string): string {
  const trimmed = value.trim().replace(/\.git$/, "");
  if (!trimmed || trimmed.length > 120) return "";
  if (path.isAbsolute(trimmed) || trimmed.includes("\\") || /[\x00-\x1F\x7F]/.test(trimmed)) return "";
  const parts = trimmed.split("/");
  if (parts.length > 2 || parts.some((part) => !part || part === "." || part === "..")) return "";
  if (!parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) return "";
  return parts.join("/");
}

function parseRepoRemote(value: string): string {
  const trimmed = value.trim().replace(/\.git$/, "");
  const ssh = /^git@[^:]+:(?<owner>[^/]+)\/(?<repo>[^/]+)$/.exec(trimmed);
  if (ssh?.groups) return safeRepoIdentifier(`${ssh.groups.owner}/${ssh.groups.repo}`);
  try {
    const url = new URL(trimmed);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return safeRepoIdentifier(`${parts.at(-2)}/${parts.at(-1)}`);
  } catch {
    // Non-URL remotes fall back to repository directory name below.
  }
  return "";
}

function repoIdentifier(): string {
  const explicit = safeRepoIdentifier(process.env.FLOW_AGENTS_REPO ?? "");
  if (explicit) return explicit;
  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const parsed = parseRepoRemote(remote);
    if (parsed) return parsed;
  } catch {
    // Keep sidecar writing independent of Git availability.
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (top) return safeRepoIdentifier(path.basename(top)) || "workspace";
  } catch {
    // Fall through to cwd basename for non-Git workspaces.
  }
  return safeRepoIdentifier(path.basename(process.cwd())) || "workspace";
}

export function sidecarBase(slug: string): AnyObj {
  return { schema_version: "1.0", task_slug: slug, repo: repoIdentifier() };
}

function parseArgs(argv: string[]): { command: string; positional: string[]; opts: Record<string, string[]>; flags: Set<string> } {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const opts: Record<string, string[]> = {};
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) flags.add(key);
    else { (opts[key] ??= []).push(next); i += 1; }
  }
  return { command: command ?? "", positional, opts, flags };
}
function opt(parsed: ReturnType<typeof parseArgs>, key: string, fallback = ""): string { return parsed.opts[key]?.at(-1) ?? fallback; }
function opts(parsed: ReturnType<typeof parseArgs>, key: string): string[] { return parsed.opts[key] ?? []; }

function isUnderDir(dir: string, root: string): boolean {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedDir = fs.realpathSync(dir);
  const relative = path.relative(resolvedRoot, resolvedDir);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function explicitArtifactRoot(p: ReturnType<typeof parseArgs>): string {
  const explicit = opt(p, "artifact-dir");
  const configuredRoot = opt(p, "artifact-root");
  if (!explicit) return configuredRoot ? path.resolve(configuredRoot) : flowAgentsArtifactRoot();
  const dir = path.resolve(explicit);
  if (!fs.existsSync(dir)) die(`artifact directory does not exist: ${dir}`);
  if (fs.lstatSync(dir).isSymbolicLink()) die(`artifact directory must not be a symlink: ${dir}`);
  if (configuredRoot) {
    const root = path.resolve(configuredRoot);
    if (!isUnderDir(dir, root)) die(`artifact directory must be under artifact root: ${dir} is outside ${root}`);
    return root;
  }
  return path.dirname(dir);
}

function requireArtifactDirUnderRoot(dir: string, root: string): void {
  if (!dir || !fs.existsSync(dir)) die("artifact directory does not exist");
  if (fs.lstatSync(dir).isSymbolicLink()) die(`artifact directory must not be a symlink: ${dir}`);
  if (!isUnderDir(dir, root)) die(`artifact directory must be under artifact root: ${dir} is outside ${root}`);
}

function isPermissionDeniedLockError(error: NodeJS.ErrnoException): boolean {
  return error.code === "EPERM" || error.code === "EACCES";
}

function lockAcquisitionFailureMessage(command: string, lockDir: string, error: NodeJS.ErrnoException): string {
  const original = error.message || error.code || String(error);
  if (!isPermissionDeniedLockError(error)) {
    return `failed to acquire workflow sidecar lock for ${command}: ${lockDir}: ${original}`;
  }
  return [
    `failed to acquire workflow sidecar lock for ${command}: ${lockDir}: ${original}`,
    "Likely cause: local directory permissions, ownership, or sandbox restrictions prevented creating the lock directory.",
    "Safe next step: fix permissions or ownership on the artifact directory, or rerun in an approved writable workspace.",
    "If still blocked: manually write schema-valid sidecars and run workflow artifact validation rather than bypassing locks.",
  ].join(" ");
}

async function withLock<T>(dir: string, create: boolean, command: string, body: () => T | Promise<T>): Promise<T> {
  if (create) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dir)) return await body();
  const lockDir = path.join(dir, ".workflow-sidecar.lockdir");
  const staleMs = Number(process.env.FLOW_AGENTS_WORKFLOW_SIDECAR_STALE_LOCK_MS ?? 5 * 60 * 1000);
  const deadline = Date.now() + 30000;
  while (true) {
    try { fs.mkdirSync(lockDir); break; }
    catch (error) {
      const lockError = error as NodeJS.ErrnoException;
      if (lockError.code !== "EEXIST") {
        die(lockAcquisitionFailureMessage(command, lockDir, lockError));
      }
      try {
        const stat = fs.statSync(lockDir);
        if (staleMs > 0 && Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (Date.now() > deadline) die(`timed out waiting for workflow sidecar lock for ${command}: ${dir}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    const delay = process.env.FLOW_AGENTS_WORKFLOW_SIDECAR_LOCK_DELAY;
    if (delay) await new Promise((resolve) => setTimeout(resolve, Number(delay) * 1000));
    return await body();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function section(text: string, heading: string): string {
  const match = new RegExp(`^(?<marks>##+)\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").exec(text);
  if (!match?.groups) return "";
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = new RegExp(`^#{2,${match.groups.marks.length}}\\s+`, "m").exec(rest);
  return rest.slice(0, next?.index).trim();
}
function definitionAcceptanceLines(markdown: string): string[] {
  const out: string[] = [];
  let active = false;
  for (const raw of section(markdown, "Definition Of Done").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^-\s+\*\*Acceptance criteria:\*\*/i.test(line)) { active = true; continue; }
    if (active && /^-\s+\*\*(Usefulness checks|Stop-short risks|Durable docs target|Scope|User outcome):\*\*/i.test(line)) break;
    if (active && /^-\s+\[[ xX]\]/.test(line)) out.push(line);
  }
  return out;
}

/** Extract a top-level `name: value` markdown field's value (e.g. `branch: agent/x/y`), mirroring
 * this file's own local-regex-parsing convention for section()/definitionAcceptanceLines() (a
 * near-duplicate of validate-workflow-artifacts.ts's field()/section() helpers — this file
 * already keeps its own local copy of that pattern rather than sharing a module). `name` is
 * regex-escaped before interpolation (fix-plan iteration 1 F3), mirroring
 * validate-workflow-artifacts.ts's own field() escaping verbatim — every current call site
 * passes a fixed literal (e.g. "branch"), but escaping keeps a future non-literal name from
 * silently changing match semantics via unescaped regex metacharacters. Returns "" when the
 * field is absent. */
function markdownField(markdown: string, name: string): string {
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.+)$`, "m");
  return re.exec(markdown)?.[1]?.trim() ?? "";
}
function parseCriterion(line: string, index: number): AnyObj {
  let text = line.replace(/^-\s+\[[ xX]\]\s*/, "").trim();
  const m = /\s+-\s+Evidence:\s*(.+)$/i.exec(text);
  const evidence = m?.[1]?.trim().replace(/\.$/, "");
  if (m) text = text.slice(0, m.index).trim().replace(/\.$/, "");
  const item: AnyObj = { id: slugify(text, `criterion-${index + 1}`), description: text, status: "pending" };
  if (evidence) item.evidence_refs = [evidenceRef("command", { excerpt: evidence })];
  return item;
}
function artifactDirFrom(value: string): string { return path.extname(value) ? path.dirname(value) : value; }
function taskSlugFor(dir: string, explicit = ""): string { return explicit || path.basename(dir); }
function relArtifacts(dir: string): string[] { return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".md") || n.endsWith(".json")).sort() : []; }
function sessionDirFor(root: string, slug: string): string {
  if (!slug) die("--task-slug is required");
  if (path.isAbsolute(slug)) die("--task-slug must be a relative slug");
  if (slug.includes("..")) die("--task-slug must not contain '..'");
  if (slug.includes("/") || slug.includes("\\") || path.basename(slug) !== slug) die("--task-slug must not contain path separators");
  const dir = path.resolve(root, slug);
  const relative = path.relative(root, dir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) die("session directory must stay under artifact root");
  return dir;
}

function validateAgentId(agent: string): string {
  if (!agent) die("--agent-id is required");
  if (path.isAbsolute(agent)) die("--agent-id must be a relative slug");
  if (agent.includes("..")) die("--agent-id must not contain '..'");
  if (agent.includes("/") || agent.includes("\\") || path.basename(agent) !== agent) die("--agent-id must not contain path separators");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agent)) die("--agent-id must be a conservative slug");
  return agent;
}

/**
 * Find the repository root by walking upward from a starting directory to locate
 * the nearest ancestor containing a kits/ subdirectory, without falling back to
 * process.cwd(). Returns null when no kits/ ancestor is found within the walk
 * bound (e.g. a scratch/temp session directory with no repo ancestor at all).
 *
 * WS5 iteration-2 part 2: extracted so publishDelivery's repo-root resolution can
 * be fail-closed (see findRepoRootFromDir below and publishDelivery). A scratch
 * test session dir (mktemp -d, no kits/ ancestor) must never resolve to whatever
 * repo happens to be the current process's cwd — that previously let a throwaway
 * eval-local trust.bundle silently clobber this real repo's delivery/trust.bundle
 * when the eval was run from a checkout of this repo (see
 * evals/integration/test_checkpoint_signing.sh TEST 2 and the WS5 session findings
 * at .kontourai/flow-agents/ws5-governance-kit-slice1).
 */
function findRepoRootFromDirStrict(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 16; i++) {
    if (fs.existsSync(path.join(dir, "kits"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Find the repository root by walking upward from a starting directory to locate
 * the nearest ancestor containing a kits/ subdirectory. Mirrors flow-resolver.ts
 * findRepoRoot, but callable from workflow-sidecar.ts without re-importing the
 * internal helper. Falls back to process.cwd() when no kits/ ancestor is found —
 * appropriate for phase-map/first-step resolution (ADR 0016 Abstraction A, P-d),
 * where the caller is always invoked from within a real repo checkout.
 *
 * Do NOT use this cwd-falling-back variant for publishDelivery's repo-root
 * resolution — use findRepoRootFromDirStrict there instead, so a scratch/test
 * session dir with no repo ancestor fails closed (skips publish) rather than
 * silently trusting process.cwd(), which could be an unrelated real repo.
 */
function findRepoRootFromDir(startDir: string): string {
  return findRepoRootFromDirStrict(startDir) ?? process.cwd();
}

/**
 * Resolve the first step id from a FlowDefinition's steps[] list.
 * Returns null when the flow cannot be loaded or has no steps.
 * Used by ensure-session to default active_step_id when --flow-id is
 * provided without --step-id (Q2 decision, P-d Increment 1).
 */
function resolveFirstStep(flowId: string, repoRoot: string): string | null {
  if (!flowId) return null;
  const dotIdx = flowId.indexOf(".");
  if (dotIdx < 1) return null;
  const kitId = flowId.slice(0, dotIdx);
  const flowName = flowId.slice(dotIdx + 1);
  if (!kitId || !flowName) return null;
  // Use resolveFlowFilePath for SLUG_RE validation + path-containment check — the same
  // defense used by resolveFlowStep and resolvePhaseMap (single implementation, DRY).
  // Returns null for any traversal attempt (e.g. flowName="../../secret") so the
  // caller gets a clean null return matching the existing null-contract.
  const flowFilePath = resolveFlowFilePath(kitId, flowName, flowId, repoRoot);
  if (!flowFilePath) return null;
  try {
    const raw = fs.readFileSync(flowFilePath, "utf8");
    const flowDef = JSON.parse(raw) as { steps?: Array<{ id: string }> };
    if (!flowDef || !Array.isArray(flowDef.steps) || flowDef.steps.length === 0) return null;
    const first = flowDef.steps[0];
    return (first && typeof first.id === "string" && first.id !== "done") ? first.id : null;
  } catch {
    return null;
  }
}

/**
 * Delegate to the shared pure-CJS per-actor current-pointer helper
 * (scripts/hooks/lib/current-pointer.js), mirroring the createRequire pattern already used above
 * by loadActorIdentityHelper()/loadLivenessWriteHelper() for cross-boundary CJS helper reuse
 * (#291 Wave 2 Task 2.1). This is the ONE place every current.json reader/writer in this file
 * goes through from here on — the per-actor-first/legacy-fallback compat-shim rule (and its
 * write-side counterpart) can never drift between call sites.
 */
function loadCurrentPointerHelper(): {
  perActorCurrentFile: (flowAgentsDir: string, actorKey: string) => string;
  readCurrentPointer: (flowAgentsDir: string, actorKey?: string) => { payload: AnyObj | null; source: "per-actor" | "legacy" | "none"; file: string | null };
  writePerActorCurrent: (flowAgentsDir: string, actorKey: string, payload: AnyObj) => void;
} {
  const _req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/current-pointer.js");
  return _req(helperPath) as {
    perActorCurrentFile: (flowAgentsDir: string, actorKey: string) => string;
    readCurrentPointer: (flowAgentsDir: string, actorKey?: string) => { payload: AnyObj | null; source: "per-actor" | "legacy" | "none"; file: string | null };
    writePerActorCurrent: (flowAgentsDir: string, actorKey: string, payload: AnyObj) => void;
  };
}

/**
 * #291 Wave 2 Task 2.1 (§5): writes the UNCHANGED legacy global `<root>/current.json` (the
 * compat-shim's write-side half — every existing consumer without an actorKey keeps reading
 * exactly this file, exactly as before this change), then ADDITIONALLY projects the SAME payload
 * into the caller's own `current/<actor>.json` when `actorKey` resolves to a real (not
 * unresolved) actor. When `actorKey` is omitted or unresolved, only the legacy file is written —
 * byte-identical to this function's pre-#291 behavior — with a stderr note mirroring the existing
 * unresolved-actor branch-naming diagnostic.
 */
function writeCurrent(root: string, dir: string, timestamp: string, owner: string, source: string, flowId?: string, stepId?: string, adHocReason?: string, actorKey?: string): void {
  // #289: mirror the active session's already-recorded branch (state.json.branch) into
  // current.json so consumers of current.json (which has no schema of its own — not one of the
  // 9 schemas under schemas/) see the routing branch without re-reading state.json separately.
  const branch = loadJson(path.join(dir, "state.json")).branch;
  const payload: AnyObj = {
    schema_version: "1.0",
    active_slug: path.basename(dir),
    artifact_dir: path.relative(root, dir) || ".",
    updated_at: timestamp,
    owner,
    source,
    active_agents: [],
    ...(branch ? { branch } : {}),
    // ADR 0016 Abstraction A (P-a): optional FlowDefinition routing keys for the producer
    // and enforcer. Both fields are optional and backward-compatible — sessions without a
    // FlowDefinition omit them and fall through to the workflow.* claim type path.
    ...(flowId ? { active_flow_id: flowId } : {}),
    ...(stepId ? { active_step_id: stepId } : {}),
    // WS8 (AC12): sanctioned ad-hoc direct entry marker. Set when --step-id explicitly
    // targets a step other than the flow's resolved first step, so stop-goal-fit /
    // gate-review can distinguish an intentional direct entry (e.g. a planning-only
    // session that skips pull-work) from a stale/mis-stamped active_step_id.
    ...(adHocReason ? { ad_hoc_entry: true, ad_hoc_reason: adHocReason } : {}),
  };
  writeJson(path.join(root, "current.json"), payload);
  if (actorKey && !loadActorIdentityHelper().isUnresolvedActor(actorKey)) {
    try {
      loadCurrentPointerHelper().writePerActorCurrent(root, actorKey, payload);
    } catch (err) {
      // Best-effort projection only — the legacy file above is already durable and authoritative;
      // a failure here must never affect ensure-session's own exit code (fail-open, visible).
      process.stderr.write(`[ensure-session] failed to write per-actor current pointer: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else {
    process.stderr.write("[ensure-session] actor unresolved or not provided; per-actor current.json projection skipped (legacy current.json remains authoritative)\n");
  }
}
function loadCurrent(root: string): AnyObj | null {
  const file = path.join(root, "current.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(read(file));
}
/**
 * #291 Wave 2 Task 2.1 (§6): resolves the active session directory via the shared
 * per-actor-first/legacy-fallback compat shim (readCurrentPointer) instead of the unconditional
 * legacy-only loadCurrent() this function used before #291. When `actorKey` is omitted, empty, or
 * unresolved, `readCurrentPointer` falls straight through to the legacy file — IDENTICAL to this
 * function's pre-#291 behavior.
 */
function currentDir(root: string, actorKey?: string): string | null {
  const pointer = loadCurrentPointerHelper().readCurrentPointer(root, actorKey);
  const c = pointer.payload;
  if (!c) return null;
  const dir = path.resolve(root, c.artifact_dir ?? c.active_slug ?? "");
  if (!fs.existsSync(dir)) return null;
  try {
    requireArtifactDirUnderRoot(dir, root);
  } catch {
    return null;
  }
  return dir;
}
/**
 * #291 Wave 2 Task 2.1 (§6): updates BOTH the legacy current.json (when IT points at `dir` — the
 * exact, unchanged existing check/write) AND the resolved actor's own per-actor current.json
 * (independently, when IT points at `dir`) — never silently drops the legacy-file update path.
 * The two checks are independent: either, both, or neither may fire depending on which
 * pointer(s) currently reference `dir`.
 */
function updateCurrentAgent(root: string, dir: string, agentId: string, status: string, timestamp: string, actorKey?: string): void {
  const applyAgentUpdate = (payload: AnyObj): AnyObj => {
    const active = Array.isArray(payload.active_agents) ? payload.active_agents.filter((a: AnyObj) => a.agent_id !== agentId) : [];
    if (status === "active" || status === "blocked") active.push({ agent_id: agentId, status, updated_at: timestamp });
    return { ...payload, active_agents: active, updated_at: timestamp };
  };

  const cur = loadCurrent(root);
  if (cur && path.resolve(root, cur.artifact_dir ?? "") === path.resolve(dir)) {
    writeJson(path.join(root, "current.json"), applyAgentUpdate(cur));
  }

  if (actorKey && !loadActorIdentityHelper().isUnresolvedActor(actorKey)) {
    const helper = loadCurrentPointerHelper();
    const perActorFile = helper.perActorCurrentFile(root, actorKey);
    let perActor: AnyObj | null = null;
    try { perActor = fs.existsSync(perActorFile) ? (JSON.parse(fs.readFileSync(perActorFile, "utf8")) as AnyObj) : null; } catch { perActor = null; }
    if (perActor && path.resolve(root, perActor.artifact_dir ?? "") === path.resolve(dir)) {
      helper.writePerActorCurrent(root, actorKey, applyAgentUpdate(perActor));
    }
  }
}

function initSidecars(dir: string, slug: string, sourceRequest: string, summary: string, nextAction: string, timestamp: string, markdown?: string): void {
  const criteria = markdown ? definitionAcceptanceLines(markdown).map(parseCriterion) : [];
  // #289/#309: `markdown` here is NOT always the session `<slug>--deliver.md` that
  // ensureSession seeds the `branch:` line into — initPlan is called against the tool-planner's
  // PLAN artifact (`<slug>--plan-work.md` etc.), a different file that typically carries no
  // `branch:` line at all. Since this function fully rewrites state.json (no merge with the
  // prior contents), naively re-deriving branch from `markdown` alone would clobber whatever
  // ensure-session already recorded there moments earlier (#309 regression). Resolve branch with
  // a three-tier fallback, preferring the most durable source first:
  //   1. EXISTING state.json.branch — once recorded, it is never re-derived or clobbered.
  //   2. The session's OWN canonical `<dir>/<slug>--deliver.md` on disk — the file ensureSession
  //      always seeds the `branch:` line into, independent of whatever `markdown` was passed in.
  //      Reading it directly (rather than trusting `markdown`) is what makes a repaired/backfilled
  //      init-plan call (re-run against the same branch-less plan artifact, after a #309-era
  //      session lost its state.json branch) recover the branch without a direct file edit.
  //   3. The `markdown` param itself (covers ensureSession's fresh-creation call, before
  //      `<slug>--deliver.md` differs from `markdown`, and any direct/legacy caller that passes
  //      the deliver markdown itself as the init-plan artifact).
  // This makes the branch survive every subsequent initSidecars call (init-plan, or a resumed
  // ensure-session) at this single choke point, without patching every other writer.
  const existingState = loadJson(path.join(dir, "state.json"));
  const existingBranch = existingState.branch;
  const deliverMdPath = path.join(dir, `${slug}--deliver.md`);
  const deliverBranch = fs.existsSync(deliverMdPath) ? markdownField(read(deliverMdPath), "branch") : "";
  const branch = existingBranch || deliverBranch || (markdown ? markdownField(markdown, "branch") : "");
  // #309 (scope addition): created_at is write-once, same class as the branch-drop bug above —
  // initSidecars fully rewrites state.json on every call (including a repair/backfill re-run of
  // init-plan against an already-existing session), so naively re-stamping created_at from the
  // current call's timestamp silently rewrites a session's original creation time. Preserve the
  // existing state.json's created_at when present; stamp only on true first-creation.
  // updated_at still reflects "now" on every call — that field is intentionally mutable.
  writeJson(path.join(dir, "state.json"), {
    ...sidecarBase(slug), status: "planned", phase: "planning", created_at: existingState.created_at || timestamp, updated_at: timestamp,
    ...(branch ? { branch } : {}),
    artifact_paths: relArtifacts(dir),
    next_action: { status: "continue", summary: nextAction || summary },
  });
  writeJson(path.join(dir, "acceptance.json"), {
    ...sidecarBase(slug), source_request: sourceRequest,
    criteria,
    goal_fit: { status: "pending", summary: "Goal fit has not been verified yet." },
  });
  writeJson(path.join(dir, "handoff.json"), {
    ...sidecarBase(slug), summary, current_state_ref: "state.json", next_steps: nextAction ? [nextAction] : [], blockers: [], warnings: [],
  });
}

/** Read a `--*-json` flag's value as a file path (or `-` for stdin), mirroring
 * assignment-provider.ts's own `loadJsonInput` convention — this file's OTHER `--*-json` flags
 * (e.g. `--check-json`) instead take a literal inline JSON string via parseJson(), a DIFFERENT
 * convention; `--effective-state-json` deliberately follows assignment-provider's file/stdin
 * convention instead, since its value is the literal JSON `assignment-provider status
 * --provider github ...` already prints to a file (or pipe), not something a caller would want to
 * inline as a shell argument. */
function loadJsonInputFile(file: string): unknown {
  return file === "-" ? JSON.parse(fs.readFileSync(0, "utf8")) : JSON.parse(read(file));
}

/**
 * #291 Wave 2 Task 2.1 (§4): ensure-session's pre-entry ownership guard. MUST be called before
 * any directory or file is created (a refusal must never leave a stray empty session dir) —
 * ensureSession() calls this immediately, before `fs.mkdirSync(dir, ...)`. Reuses #290's
 * assignment ⋈ liveness join (`computeEffectiveState`, Wave 1 export) so a fresh OTHER-actor claim
 * refuses entry, a human assignment always asks first (never auto-reclaims), a stale
 * (`reclaimable`) claim requires the explicit `--supersede-stale` takeover flag, and a `free`
 * subject establishes a durable claim for the entering actor — ensure-session becomes a SECOND
 * claim point, alongside pull-work (closing the loophole where a session entered without going
 * through pull-work never gets a durable claim at all).
 *
 * Runs INSIDE ensureSession's existing root-level `withLock` (main(), unchanged) — no second/
 * competing lock is introduced here. `performLocalClaim`/`performLocalSupersede`'s OWN internal
 * `withSubjectLock` (a DIFFERENT lockdir, under `<root>/assignment/.<subject>.lockdir`) is what
 * protects against a concurrent bare `assignment-provider claim` CLI invocation (e.g. from
 * pull-work) racing this guard — two independent, non-conflicting lock resources.
 *
 * Every interpolated actor/holder/assignee/reason field in this function's die() messages is run
 * through stripControlCharsForDisplay + a 64-char cap (AC9 — the #287/#320/#290 prompt-injection
 * mitigation class: a hostile liveness event or a hand-crafted --effective-state-json fixture must
 * never be able to smuggle raw control/ANSI bytes into this process's stderr/thrown message).
 */
function enforceEnsureSessionOwnership(
  p: ReturnType<typeof parseArgs>,
  root: string,
  slug: string,
  dir: string,
  resolution: { actorStruct: ActorStruct; actorKey: string; branchActorKey: string; unresolved: boolean },
): void {
  if (p.flags.has("skip-ownership-guard")) {
    process.stderr.write("[ensure-session] ownership guard skipped via --skip-ownership-guard\n");
    return;
  }
  // Design Decision 4 (unchanged from resolveSessionBranch): actor-resolution ambiguity never
  // hard-fails session creation. Without a resolvable actor there is no safe identity to claim
  // under, so the guard is skipped entirely (documented scope boundary, not a silent hole) rather
  // than claiming under a synthetic/unstable identity.
  if (resolution.unresolved) {
    process.stderr.write("[ensure-session] ownership guard not evaluated: actor is unresolved (set --actor or FLOW_AGENTS_ACTOR, or run inside a supported runtime) — proceeding without a durable claim, exactly as ensure-session behaved before #291\n");
    return;
  }

  // F5 fix (fix-plan iteration 1, LOW): match assignment-provider.ts's sanitizeDisplayField
  // two-tier convention (64 for id-like fields, 240 for free text) rather than asserting one
  // uniform cap applies to every field class regardless of content. `sanitize` below is 64 chars —
  // deliberately, not by uniform-cap default — because every value this function actually
  // interpolates into a die()/stderr message is id-like (holder/actor key, subject slug, assignee,
  // a claimed_at/last_at timestamp, the provider-kind enum); none of them is free text, so the
  // id-like tier is the correct (not merely convenient) cap here. sanitizeDisplayField's 240
  // free-text tier is for fields like a claim record's audit-trail `reason` (see
  // assignment-provider.ts's sanitizeAuditEntryForDisplay) — this guard never echoes `--reason`
  // into a die() message, so it has no free-text field requiring the 240 tier today.
  const sanitize = (value: unknown): string => stripControlCharsForDisplay(value).slice(0, 64);
  const nowMs = opt(p, "now") ? Date.parse(opt(p, "now")) : Date.now();
  const assignmentProviderKind = opt(p, "assignment-provider", "local-file");

  type EffectiveResult = { effective_state: EffectiveState; reason: string; holder?: { actor?: string; assignee?: string | null; idle_days?: number | null; last_at?: string } };
  let effective: EffectiveResult;

  const effectiveStateJsonFlag = opt(p, "effective-state-json");
  if (effectiveStateJsonFlag) {
    const parsed = loadJsonInputFile(effectiveStateJsonFlag) as AnyObj;
    const candidate = parsed && typeof parsed === "object" ? (parsed.effective as AnyObj | undefined) : undefined;
    const validStates = new Set(["held", "reclaimable", "human-held", "free"]);
    if (!candidate || typeof candidate.effective_state !== "string" || !validStates.has(candidate.effective_state)) {
      die(`ensure-session --effective-state-json must contain an .effective object with a recognized effective_state (held|reclaimable|human-held|free); got ${JSON.stringify(candidate ? candidate.effective_state : candidate)}`);
    }
    effective = candidate as EffectiveResult;
  } else if (assignmentProviderKind === "local-file") {
    // Conflict #3 (plan): subjectId for BOTH the assignment lookup and the liveness freshHolders
    // slug filter is `slug` — the ALREADY-COMPUTED session slug (workItemSlug()'s output), the
    // exact same identifier pull-work itself uses for both halves of this same join. Never a
    // second, independently-derived identifier.
    // F1 fix (fix-plan iteration 1, HIGH): the guard's own self-check and the liveness join must
    // key on `resolution.branchActorKey` — the canonical `resolveActor(env).actor` string — NOT
    // `resolution.actorKey` (`serializeActor(actorStruct)`). For an explicit-override actor
    // (FLOW_AGENTS_ACTOR) those two diverge: `actorKey` serializes to a triple
    // (`explicit-override:<value>:<host>`) while `branchActorKey` is the bare value every other
    // tool (`liveness whoami`, `liveness claim --actor`, per-actor current.json, pull-work's
    // --self-actor) already uses. freshHolders' `selfActor` param and computeEffectiveState's
    // `selfActor` param must both be the same canonical string the claim record's `actor_key` is
    // written as (see the performLocalClaim/performLocalSupersede calls below) — otherwise a
    // fresh heartbeat for this exact actor would never match the join, and
    // `assignment-provider status --self-actor <branchActorKey>` run by a DIFFERENT tool
    // afterward would never recognize this guard's own claim as self.
    const assignment = readLocalAssignmentStatus(root, slug);
    const events = readLivenessEvents(root);
    const freshList = loadLivenessReadHelper().freshHolders(events, slug, resolution.branchActorKey, nowMs);
    effective = computeEffectiveState(assignment, freshList, resolution.branchActorKey, nowMs);
  } else {
    // Conflict #5 (plan): GitHub-provider (and any other non-local-file) subjects get no LIVE
    // guard check here — assignment-provider.ts is deliberately render-don't-execute (no `gh`
    // calls from any CLI file). A precomputed --effective-state-json is the escape hatch; when
    // neither applies, this is a documented scope boundary (today's pre-#291 baseline behavior),
    // never a silent hole.
    process.stderr.write(`[ensure-session] ownership guard not evaluated: provider "${sanitize(assignmentProviderKind)}" requires --effective-state-json\n`);
    return;
  }

  const resolveBranchForClaim = (): string => {
    const existingBranch = fs.existsSync(path.join(dir, "state.json")) ? (loadJson(path.join(dir, "state.json")).branch as string | undefined) : undefined;
    return existingBranch || resolveSessionBranch(p, slug);
  };

  switch (effective.effective_state) {
    case "held": {
      // F1 fix (fix-plan iteration 1, HIGH): compare against branchActorKey — the same canonical
      // string just passed as computeEffectiveState's selfActor above — not actorKey (the wrapped
      // ActorStruct triple), so this redundant belt-and-suspenders check agrees with the
      // effective_state computation instead of silently using a different identity.
      const isSelf = effective.reason === "self_is_holder" || (!!effective.holder?.actor && effective.holder.actor === resolution.branchActorKey);
      if (isSelf) return; // resume own session — no refusal
      const holderActor = sanitize(effective.holder?.actor ?? "unknown");
      const lastAtSuffix = effective.holder?.last_at ? ` (last_at ${sanitize(effective.holder.last_at)})` : "";
      die(`ensure-session refused: subject ${sanitize(slug)} is currently held by a different, still-live actor (${holderActor}${lastAtSuffix}). Pick a different work item, or confirm the holder session is truly gone before considering a takeover.`);
      return;
    }
    case "human-held": {
      const assignee = effective.holder?.assignee ? sanitize(effective.holder.assignee) : "an assigned human";
      const idleSuffix = effective.holder?.idle_days != null ? ` (idle ${Number(effective.holder.idle_days)} day(s))` : "";
      die(`ensure-session refused: subject ${sanitize(slug)} is assigned to ${assignee}${idleSuffix}. This guard never auto-reclaims a human assignment — confirm with the user before proceeding.`);
      return;
    }
    case "reclaimable": {
      const holderActor = sanitize(effective.holder?.actor ?? "unknown");
      const claimedAtSuffix = effective.holder?.last_at ? ` (claimed_at ${sanitize(effective.holder.last_at)})` : "";
      if (!p.flags.has("supersede-stale")) {
        die(`ensure-session refused: subject ${sanitize(slug)}'s existing claim (held by ${holderActor}${claimedAtSuffix}) is stale. Pass --supersede-stale to take it over explicitly.`);
      }
      const assignment = readLocalAssignmentStatus(root, slug);
      const fromActor = assignment.record?.actor;
      if (!fromActor) die(`ensure-session --supersede-stale: no existing local-file claim record found for subject ${sanitize(slug)} to supersede`);
      performLocalSupersede(root, slug, fromActor, resolution.actorStruct, {
        branch: resolveBranchForClaim(),
        artifactDir: path.relative(root, dir) || ".",
        reason: opt(p, "reason", "ensure-session takeover: stale claim"),
        // F1 fix (fix-plan iteration 1, HIGH): persist the canonical actor_key on the record so
        // computeEffectiveState's holderActorKey (assignment-provider.ts) matches this same
        // branchActorKey string on the next status/guard check, cross-tool.
        actorKey: resolution.branchActorKey,
      });
      return;
    }
    case "free": {
      performLocalClaim(root, slug, resolution.actorStruct, {
        ttlSeconds: opt(p, "claim-ttl-seconds") ? Number(opt(p, "claim-ttl-seconds")) : loadLivenessPolicyHelper().resolveTtlSeconds(process.env),
        branch: resolveBranchForClaim(),
        artifactDir: path.relative(root, dir) || ".",
        reason: opt(p, "reason", "ensure-session entry"),
        // F1 fix (fix-plan iteration 1, HIGH): see the performLocalSupersede call above.
        actorKey: resolution.branchActorKey,
      });
      return;
    }
    default:
      die(`ensure-session ownership guard: unrecognized effective_state ${JSON.stringify(effective.effective_state)}`);
  }
}

/**
 * ensure-session flags added by #291 Wave 2 Task 2.1 (no printed --help/usage text exists in this
 * file to update — this doc comment is the discoverable reference instead):
 *   --skip-ownership-guard         Skip the pre-entry ownership guard entirely (logged, not silent).
 *   --effective-state-json <path|-> Precomputed `{ effective: {...} }` JSON (the exact shape
 *                                  `assignment-provider status` prints) — required to evaluate the
 *                                  guard for any --assignment-provider other than local-file.
 *   --assignment-provider <kind>   Defaults to "local-file"; see Conflict #5 in the plan for the
 *                                  GitHub-provider scope boundary.
 *   --now <iso>                    Deterministic "now" for freshness/idle-day computation (else
 *                                  Date.now()).
 *   --supersede-stale              Required to take over a `reclaimable` (stale) claim.
 *   --claim-ttl-seconds <n>        Overrides the liveness-policy TTL default for a new claim.
 *   --reason <text>                Audit-trail reason recorded on the claim/supersede record.
 */
function ensureSession(p: ReturnType<typeof parseArgs>): number {
  const root = opt(p, "artifact-root") ? path.resolve(opt(p, "artifact-root")) : flowAgentsArtifactRoot();
  const slug = opt(p, "task-slug") || (opt(p, "work-item") ? workItemSlug(opt(p, "work-item")) : die("--task-slug is required (or pass --work-item to derive it)"));
  const dir = sessionDirFor(root, slug);
  // #291 Wave 2 Task 2.1 (§3, §4): resolve the actor ONCE, then run the ownership guard BEFORE
  // any directory/file is created — a refusal must never leave a stray empty session dir. Reused
  // below (writeCurrent's per-actor dual-write) so the branch-naming actor and the
  // assignment-claim actor are always the same identity.
  const actorResolution = resolveEnsureSessionActor(p);
  enforceEnsureSessionOwnership(p, root, slug, dir, actorResolution);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = opt(p, "timestamp", now());
  let md = fs.existsSync(path.join(dir, `${slug}--deliver.md`)) ? read(path.join(dir, `${slug}--deliver.md`)) : "";
  if (!md) {
    // #289: derive the routing branch ONLY on fresh session creation (this `if (!md)` guard).
    // An existing session's already-recorded `branch:` line is never touched — that whole branch
    // of code is skipped on a resumed/taken-over session, which is what makes ADR 0021 §5
    // takeover continuity true by construction (see Design Decision 3 in the plan).
    const branch = resolveSessionBranch(p, slug);
    md = `# ${opt(p, "title", slug)}\n\nbranch: ${branch}\nworktree: main\ncreated: ${timestamp}\nstatus: planning\ntype: deliver\niteration: 1\n\n## Plan\n\n${opt(p, "summary", "")}\n\n## Definition Of Done\n\n- **User outcome:** ${opt(p, "summary", "Workflow session is durable.")}\n- **Scope:** Workflow session artifacts and sidecars.\n- **Acceptance criteria:**\n${opts(p, "criterion").map((c) => `  - [ ] ${c} - Evidence: pending.`).join("\n")}\n- **Usefulness checks:**\n  - [ ] User-facing workflow is documented or discoverable\n- **Stop-short risks:** Workflow artifacts could drift.\n- **Durable docs target:** not needed\n- **Sandbox mode:** local-edit\n\n## Execution Progress\n\n- [ ] Session initialized.\n\n## Verification Report\n\nBuild: [NOT_VERIFIED] Verification has not run yet.\n\n### Acceptance Criteria\n- [NOT_VERIFIED] Verification has not run yet - Evidence: pending workflow execution and checks.\n\n### Verdict: NOT_VERIFIED\n\n## Goal Fit Gate\n\n- [ ] Original user goal restated\n\n## Final Acceptance\n\n- [ ] CI/relevant checks passed or local equivalent recorded\n`;
    fs.writeFileSync(path.join(dir, `${slug}--deliver.md`), md);
  }
  if (!fs.existsSync(path.join(dir, "state.json")) || !fs.existsSync(path.join(dir, "acceptance.json")) || !fs.existsSync(path.join(dir, "handoff.json"))) {
    initSidecars(dir, slug, opt(p, "source-request"), opt(p, "summary"), opt(p, "next-action", "Continue."), timestamp, md);
  }
  // ADR 0016 Abstraction A (P-a): optional --flow-id / --step-id flags persist FlowDefinition
  // routing keys into current.json for the producer (P-b) and enforcer (P-c) to consume.
  // When absent, behavior is unchanged — the workflow.* claim type path is used as before.
  // P-d Increment 1 (Q2 decision): when --flow-id is given without --step-id, default
  // active_step_id to the FIRST step in the FlowDefinition's steps[] list. This ensures
  // ensure-session --flow-id builder.build produces a FlowDefinition-driven session even
  // before the first advance-state call.
  const flowId = opt(p, "flow-id");
  const explicitStep = opt(p, "step-id");
  let stepId = explicitStep;
  let adHocReason: string | undefined;
  if (flowId && !stepId) {
    const repoRoot = findRepoRootFromDir(dir);
    const firstStep = resolveFirstStep(flowId, repoRoot);
    if (firstStep) stepId = firstStep;
  } else if (flowId && explicitStep) {
    // WS8 (AC12): --step-id is the sanctioned ad-hoc direct-entry mechanism. When it names
    // a step other than the flow's resolved first step, record an explicit ad_hoc_entry
    // marker (with a reason) instead of silently letting the mis-stamp look like the
    // flow's normal first step. This is the root-cause fix for a planning-only session
    // whose active_step_id would otherwise default to builder.build's first step.
    const repoRoot = findRepoRootFromDir(dir);
    const firstStep = resolveFirstStep(flowId, repoRoot);
    if (firstStep && firstStep !== explicitStep) {
      adHocReason = opt(p, "ad-hoc-reason") || `direct entry at step "${explicitStep}" via --step-id (flow first step is "${firstStep}")`;
    }
  }
  writeCurrent(root, dir, timestamp, "workflow-sidecar", "ensure-session", flowId || undefined, stepId || undefined, adHocReason, actorResolution.unresolved ? undefined : actorResolution.branchActorKey);
  console.log(dir);
  return 0;
}

function current(p: ReturnType<typeof parseArgs>): number {
  const root = opt(p, "artifact-root") ? path.resolve(opt(p, "artifact-root")) : defaultArtifactRootForRead();
  // #291 Wave 2 Task 2.1 (§6): new optional --actor override (same convention as
  // resolveSessionBranch's existing --actor), falling back to resolveActor(process.env). Only the
  // SOURCE of "what does current.json say" changes (per-actor-first, legacy-fallback) — this
  // command's existing --format slug|path output is unchanged.
  const actorKey = resolveReadActorKey(p);
  const dir = currentDir(root, actorKey);
  if (!dir) die("no current workflow session is recorded");
  const format = opt(p, "format", "path");
  console.log(format === "slug" ? path.basename(dir) : dir);
  return 0;
}

function recordAgentEvent(p: ReturnType<typeof parseArgs>): number {
  const hasExplicitRoot = !!opt(p, "artifact-root");
  const root = explicitArtifactRoot(p);
  const explicit = opt(p, "artifact-dir");
  const actorKey = resolveReadActorKey(p);
  const dir = explicit ? path.resolve(explicit) : currentDir(root, actorKey);
  if (!dir || !fs.existsSync(dir)) die("artifact directory does not exist");
  if (explicit && fs.lstatSync(dir).isSymbolicLink()) die(`artifact directory must not be a symlink: ${dir}`);
  if (hasExplicitRoot || !explicit) requireArtifactDirUnderRoot(dir, root);
  const timestamp = opt(p, "timestamp", now());
  const agent = validateAgentId(opt(p, "agent-id"));
  // #376 model routing: optionally stamp the delegate role/model resolved from
  // .datum/config.json onto the event so a downstream economics record (#349)
  // can price role assignments per delegation, and so an escalate-on-gate-failure
  // re-dispatch records which tier it climbed FROM. Fully additive/optional: when
  // no routing flag is passed the event shape is byte-identical to before.
  // These live as TOP-LEVEL event fields (not nested) on purpose: appendJsonl's
  // serializer (spacedLine) uses the top-level key list as a JSON.stringify array
  // replacer, which is an allowlist applied at every nesting level — a nested
  // routing object would have its inner keys stripped. Flat keeps the shape a
  // simple per-event routing record a JSONL economics feed can read directly.
  const role = opt(p, "role");
  const model = opt(p, "model");
  const escalatedFrom = opt(p, "escalated-from");
  const event = {
    timestamp,
    agent_id: agent,
    kind: opt(p, "kind", "note"),
    status: opt(p, "status", "info"),
    summary: opt(p, "summary"),
    ...(opt(p, "ref") ? { ref: opt(p, "ref") } : {}),
    ...(role ? { role } : {}),
    ...(model ? { model } : {}),
    ...(escalatedFrom ? { escalated_from: escalatedFrom } : {}),
  };
  appendJsonl(path.join(dir, "agents", agent, "events.jsonl"), event);
  updateCurrentAgent(root, dir, agent, event.status, timestamp, actorKey);
  return 0;
}

function initPlan(p: ReturnType<typeof parseArgs>): number {
  const artifact = p.positional[0] || die("artifact path is required");
  const dir = artifactDirFrom(artifact);
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  initSidecars(dir, slug, opt(p, "source-request"), opt(p, "summary"), opt(p, "next-action"), opt(p, "timestamp", now()), read(artifact));
  livenessLifecycle(dir, slug, "claim", opt(p, "timestamp", now()));
  return 0;
}

function parseJson(value: string, label: string): AnyObj {
  try { const raw = JSON.parse(value); if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("object expected"); return raw; }
  catch { die(`${label} must be valid JSON object`); }
}
function evidenceRef(kind: string, fields: AnyObj): AnyObj {
  return { kind, ...fields };
}
function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
function hasPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 1;
}
export function validateEvidenceRef(ref: AnyObj, label: string): AnyObj {
  if (!["source", "command", "artifact", "provider", "external"].includes(ref.kind)) die(`${label} entry kind must be one of: source, command, artifact, provider, external`);
  for (const key of Object.keys(ref)) if (!["kind", "url", "file", "line_start", "line_end", "excerpt", "summary"].includes(key)) die(`${label} entries contain unsupported field: ${key}`);
  if (ref.url !== undefined && !hasNonEmptyString(ref.url)) die(`${label} entry url must be a non-empty string`);
  if (ref.file !== undefined && !hasNonEmptyString(ref.file)) die(`${label} entry file must be a non-empty string`);
  if (ref.excerpt !== undefined && !hasNonEmptyString(ref.excerpt)) die(`${label} entry excerpt must be a non-empty string`);
  if (ref.summary !== undefined && !hasNonEmptyString(ref.summary)) die(`${label} entry summary must be a non-empty string`);
  if (ref.line_start !== undefined && !hasPositiveInteger(ref.line_start)) die(`${label} entry line_start must be a positive integer`);
  if (ref.line_end !== undefined && !hasPositiveInteger(ref.line_end)) die(`${label} entry line_end must be a positive integer`);
  if (ref.kind === "source" && (!hasNonEmptyString(ref.file) || !hasPositiveInteger(ref.line_start) || !hasPositiveInteger(ref.line_end) || !hasNonEmptyString(ref.excerpt))) die(`${label} source refs require file, line_start, line_end, and excerpt`);
  if (ref.kind === "artifact" && (!hasNonEmptyString(ref.file) && !hasNonEmptyString(ref.url))) die(`${label} artifact refs require file or url`);
  if (ref.kind === "artifact" && (!hasNonEmptyString(ref.summary) && !hasNonEmptyString(ref.excerpt))) die(`${label} artifact refs require summary or excerpt`);
  if (ref.kind === "command" && (!hasNonEmptyString(ref.summary) && !hasNonEmptyString(ref.excerpt) && !hasNonEmptyString(ref.url))) die(`${label} command refs require summary, excerpt, or url`);
  if ((ref.kind === "provider" || ref.kind === "external") && !hasNonEmptyString(ref.url)) die(`${label} ${ref.kind} refs require url`);
  return ref;
}
export function normalizeEvidenceRefs(raw: unknown, label: string): AnyObj[] {
  if (!Array.isArray(raw)) die(`${label} must be an array`);
  return raw.map((ref) => {
    if (typeof ref === "string") die(`${label} entries must be structured evidence reference objects; legacy string refs are not supported`);
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) die(`${label} entries must be objects`);
    return validateEvidenceRef({ ...ref as AnyObj }, label);
  });
}
export function normalizeCheck(raw: AnyObj): AnyObj {
  const check = { ...raw };
  if (!check.id || !check.kind || !check.status || !check.summary) die("check requires id, kind, status, and summary");
    if (!checkKinds.has(check.kind)) die("kind must be one of: build, types, lint, test, command, security, diff, browser, runtime, policy, external");
  if (!checkStatuses.has(check.status)) die("status must be one of: pass, fail, not_verified, skip");
  if (Array.isArray(check.standard_refs)) for (const ref of check.standard_refs) if (!["junit", "sarif", "coverage", "veritas"].includes(ref.standard)) die("standard must be one of");
  if (check.artifact_refs) check.artifact_refs = normalizeEvidenceRefs(check.artifact_refs, "artifact_refs");
  if (check.surface_trust_refs) check.surface_trust_refs = normalizeSurfaceRefs(check.surface_trust_refs);
  return check;
}
function normalizeSurfaceRefs(refs: any): AnyObj[] {
  if (!Array.isArray(refs)) die("surface_trust_refs must be an array");
  // Use the cached @kontourai/surface module for advisory inline validation of referenced
  // trust.bundle files. Fail-open when surface is not yet loaded (surface loads on first
  // bundle write via tryLoadSurface; normalizeSurfaceRefs may run before that).
  const surfaceValidateFn = _surfaceModule?.validateTrustBundle ?? null;
  return refs.map((ref) => {
    const keys = JSON.stringify(ref).match(/"([^"]+)":/g) ?? [];
    for (const key of keys.map((k) => k.slice(1, -2))) if (key.toLowerCase().includes("veritas")) die(`unsupported field in Surface trust ref: ${key}`);
    const out = { ...ref };
    // trust.bundle is the canonical Hachure-aligned artifact kind; TrustReport/Trust Snapshot are legacy aliases
    if (!["trust.bundle", "TrustReport", "Trust Snapshot"].includes(out.artifact_kind)) die("artifact_kind must be one of: trust.bundle, TrustReport, Trust Snapshot");
    // When surface is loaded, validate the referenced trust artifact if it is a local file.
    // Advisory: surface's throw-based validator wraps into a fail-loud error on schema failure.
    if (surfaceValidateFn && out.artifact_ref && typeof out.artifact_ref === "string" && fs.existsSync(out.artifact_ref)) {
      try {
        const bundle = JSON.parse(fs.readFileSync(out.artifact_ref, "utf8"));
        surfaceValidateFn(bundle);
      } catch (err) {
        if (err instanceof Error) {
          // Re-throw schema validation failures (surface throws on invalid); swallow read/parse errors.
          const msg = err.message;
          const isSchemaError = !msg.startsWith("ENOENT") && !msg.startsWith("SyntaxError") && !msg.toLowerCase().startsWith("unexpected");
          if (isSchemaError) die(`trust.bundle artifact at ${out.artifact_ref} failed schema validation: ${msg}`);
        }
        // File read or parse errors are not re-thrown: the artifact_ref validation path is advisory
      }
    }
    const status = deriveSurfaceStatus(out);
    if (out.status === "pass" && status !== "pass") die("surface_trust_refs contradicts Surface trust facts");
    return out;
  });
}
function deriveSurfaceStatus(ref: AnyObj): string {
  if (ref.claim_status !== "accepted") return "fail";
  if (ref.freshness?.status !== "fresh") return "not_verified";
  if (!ref.authority || ref.authority.producer === "unknown") return "fail";
  if (ref.integrity?.status !== "matched") return "fail";
  return "pass";
}
/**
 * Derive kit identity from a parsed trust.bundle by structurally reading the
 * DECLARED primary claim (kit-typed) rather than hardcoding "builder".
 *
 * Resolution order (no fallbacks to "builder"):
 *   1. First non-workflow.* claim in bundle.claims[] → claimType drives kitId + subject.
 *   2. No kit-typed claim: try current.json active_flow_id adjacent to the bundle file
 *      (bundle lives at <session-dir>/trust.bundle → flowAgentsDir = grandparent).
 *   3. Genuinely unknown: mark as "unknown" — never hardcode a kit identity.
 */
export function kitIdentityFromBundle(
  raw: AnyObj,
  bundleFile: string,
): { claimType: string; kitId: string; subject: string; gateId: string } {
  // 1. Structurally read the bundle's declared kit-typed claim.
  const claims: AnyObj[] = Array.isArray(raw.claims) ? raw.claims : [];
  for (const claim of claims) {
    const ct = typeof claim?.claimType === "string" ? claim.claimType : "";
    if (ct && !ct.startsWith("workflow.")) {
      const kitId = ct.split(".")[0] ?? "unknown";
      if (kitId && kitId !== "unknown") {
        return { claimType: ct, kitId, subject: `${kitId}-kit`, gateId: ct };
      }
    }
  }
  // 2. No kit-typed claim in bundle — try to derive kit from current.json active_flow_id.
  //    The bundle lives at <session-dir>/trust.bundle, so:
  //      sessionDir = path.dirname(bundleFile)
  //      flowAgentsDir = path.dirname(sessionDir)
  try {
    const sessionDir = path.dirname(bundleFile);
    const flowAgentsDir = path.dirname(sessionDir);
    const currentFile = path.join(flowAgentsDir, "current.json");
    const current = JSON.parse(fs.readFileSync(currentFile, "utf8")) as Record<string, unknown>;
    const flowId = typeof current["active_flow_id"] === "string" ? current["active_flow_id"] : null;
    if (flowId && flowId.includes(".")) {
      const kitId = flowId.split(".")[0]!;
      if (kitId) {
        const derivedClaimType = `${kitId}.trust.bundle`;
        return { claimType: derivedClaimType, kitId, subject: `${kitId}-kit`, gateId: derivedClaimType };
      }
    }
  } catch {
    // Ignore — fall through to unknown
  }
  // 3. Genuinely unknown — never fallback to "builder".
  return { claimType: "unknown.trust.bundle", kitId: "unknown", subject: "unknown-kit", gateId: "unknown.trust.bundle" };
}
function surfaceCheckFromArtifact(file: string, index: number): AnyObj {
  const raw = JSON.parse(read(file));
  const lower = JSON.stringify(raw).toLowerCase();
  // Structurally read kit identity from the bundle — never hardcode "builder".
  const { claimType: bundleClaimType, subject: bundleSubject, gateId: bundleGateId } = kitIdentityFromBundle(raw, file);
  let ref: AnyObj;
  if (lower.includes("provider") && lower.includes("absent")) {
    ref = { artifact_kind: "trust.bundle", artifact_ref: file, gate_id: "provider.unavailable", claim_type: bundleClaimType, claim_status: "unknown", subject: bundleSubject, freshness: { status: "unknown", summary: "No trust provider is configured" }, authority: { producer: "unknown", summary: "No trust provider is configured" }, integrity: { status: "unknown", summary: "Unknown" }, status: "not_verified", summary: "No trust provider is configured" };
  } else if (lower.includes("artifact") && lower.includes("absent")) {
    ref = { artifact_kind: "trust.bundle", artifact_ref: file, gate_id: "artifact.unavailable", claim_type: bundleClaimType, claim_status: "unknown", subject: bundleSubject, freshness: { status: "unknown", summary: "Artifact not readable" }, authority: { producer: "unknown", summary: "Artifact not readable" }, integrity: { status: "unknown", summary: "Artifact not readable" }, status: "not_verified", summary: "artifact not readable" };
  } else {
    const claimStatus = lower.includes("rejected") ? "rejected" : "accepted";
    const freshness = lower.includes("stale") ? "stale" : "fresh";
    const producer = lower.includes("missing-authority") ? "unknown" : "surface-local";
    const integrity = lower.includes("mismatch") ? "mismatch" : "matched";
    // Use trust.bundle as the canonical Hachure-aligned artifact_kind for all trust-backed evidence refs
    ref = { artifact_kind: "trust.bundle", artifact_ref: file, gate_id: bundleGateId, claim_type: bundleClaimType, claim_status: claimStatus, subject: bundleSubject, freshness: { status: freshness, summary: freshness === "fresh" ? "fresh" : "not currently verifiable" }, authority: { producer, summary: producer === "unknown" ? "missing authority" : "Local Surface trust producer." }, integrity: { status: integrity, summary: integrity === "matched" ? "matched" : "integrity mismatch" } };
    ref.status = deriveSurfaceStatus(ref);
    ref.summary = ref.status === "pass" ? "accepted" : ref.status === "not_verified" ? "not currently verifiable" : (claimStatus === "rejected" ? "rejected" : producer === "unknown" ? "missing authority" : "integrity mismatch");
  }
  return { id: `surface-trust-${index + 1}`, kind: "policy", status: ref.status, summary: ref.summary, surface_trust_refs: [ref] };
}

function validateAcceptanceEvidenceRefs(dir: string): void {
  const file = path.join(dir, "acceptance.json");
  if (!fs.existsSync(file)) return;
  const data = loadJson(file);
  if (!Array.isArray(data.criteria)) return;
  data.criteria.forEach((criterion: AnyObj, index: number) => {
    if (criterion.evidence_refs !== undefined) normalizeEvidenceRefs(criterion.evidence_refs, `acceptance.criteria[${index}].evidence_refs`);
  });
}
export function writeState(dir: string, slug: string, status: string, phase: string, timestamp: string, summary: string, next = "continue"): void {
  writeJson(path.join(dir, "state.json"), { ...loadJson(path.join(dir, "state.json")), ...sidecarBase(slug), status, phase, updated_at: timestamp, artifact_paths: relArtifacts(dir), next_action: { status: next, summary } });
}
// ─── Phase 4c: bundle-only helpers ───────────────────────────────────────────
// After 4c, evidence.json and critique.json are no longer written.
// Extract checks and critiques from the existing trust.bundle for callers that
// need to rebuild the bundle (e.g. record-critique, record-learning).

// #268/#344: buildTrustBundle stamps a stable origin discriminator ("check" | "acceptance" |
// "critique") plus check_kind (for origin "check") on EVERY claim it writes. These stamps are
// AUTHORITATIVE and the ONLY way checksFromBundle/critiquesFromBundle (and evidenceClean/
// critiqueClean below) classify a claim.
//
// Hard cutover (owner directive, no legacy fallbacks): there is deliberately no claimType-
// derivation fallback for unstamped claims. A prior version of this file fell back to
// classifying an unstamped claim by claimType heuristic — that fallback WAS the #268 defect
// kept reachable (a no-evidence declared claim silently re-absorbed as a command-less
// test_output check, and a critique claim silently re-absorbed as a check, corrupting the
// round-trip catastrophically under --flow-id). An unstamped claim means the bundle predates
// #344 and must be regenerated, not silently reclassified — see requireStampedClaim below.
function claimOrigin(claim: AnyObj): string | null {
  const md = claim && (claim as AnyObj).metadata;
  return md && typeof md === "object" && typeof (md as AnyObj).origin === "string" && (md as AnyObj).origin.length > 0 ? String((md as AnyObj).origin) : null;
}
// Fails loud — never silent, never a heuristic reclassification — when a claim in `dir`'s
// trust.bundle lacks its metadata.origin stamp, or (for an origin==="check" claim) its
// metadata.check_kind stamp. Names the session dir and the remedy so the caller can regenerate
// a fresh, fully-stamped bundle instead of reading a pre-supersession one.
function requireStampedClaim(claim: AnyObj, dir: string): string {
  if (!claim || typeof claim !== "object") die(`trust.bundle in ${dir} contains a malformed claim entry — cannot read.`);
  const remedy = `re-record evidence to regenerate: npm run workflow:sidecar -- record-evidence ${dir} --verdict <verdict> --check-json <...>`;
  const origin = claimOrigin(claim);
  if (!origin) {
    die(`pre-supersession trust.bundle in ${dir}: claim '${claim.id ?? "<unknown>"}' has no metadata.origin stamp (this bundle predates #344's origin/check_kind stamping and cannot be read authoritatively) — ${remedy}`);
  }
  if (origin === "check") {
    const md = (claim.metadata && typeof claim.metadata === "object") ? claim.metadata as AnyObj : {};
    if (typeof md.check_kind !== "string" || md.check_kind.length === 0) {
      die(`pre-supersession trust.bundle in ${dir}: check claim '${claim.id ?? "<unknown>"}' has metadata.origin but no metadata.check_kind stamp (this bundle predates #344's stamping and cannot be read authoritatively) — ${remedy}`);
    }
  }
  return origin;
}
function checksFromBundle(dir: string): AnyObj[] {
  const bundle = loadJson(path.join(dir, "trust.bundle"));
  const allClaims: AnyObj[] = Array.isArray(bundle.claims) ? bundle.claims : [];
  // Validate stamps on every claim up front — any unstamped claim anywhere in the bundle marks
  // it pre-supersession, regardless of whether it is check/acceptance/critique-typed.
  for (const claim of allClaims) requireStampedClaim(claim, dir);
  if (!Array.isArray(bundle.evidence)) return [];
  const claimById = new Map<string, AnyObj>();
  for (const c of allClaims) if (c && c.id) claimById.set(c.id, c);
  const seen = new Set<string>();
  const checks: AnyObj[] = [];
  const kindOf = (claim: AnyObj): string => String((claim.metadata as AnyObj).check_kind);
  // Read side of the buildTrustBundle waiver round-trip (write side: buildTrustBundle reads
  // check._waiver at line ~689 and stamps it onto claimMetadata.waiver at line ~705). Without
  // this, any caller that rebuilds checks via checksFromBundle() (recordCritique/recordLearning)
  // silently drops a previously-recorded waiver on the next bundle write.
  const waiverOf = (claim: AnyObj): AnyObj | undefined => {
    const md = claim.metadata as AnyObj;
    return md && typeof md === "object" && md.waiver && typeof md.waiver === "object" ? md.waiver as AnyObj : undefined;
  };
  for (const ev of bundle.evidence) {
    if (!ev || !ev.claimId) continue;
    const claim = claimById.get(ev.claimId);
    if (!claim) continue;
    if (claimOrigin(claim) !== "check") continue;
    if (seen.has(ev.claimId)) continue;
    seen.add(ev.claimId);
    const kind = kindOf(claim);
    const status = claim.value ?? "not_verified";
    const check: AnyObj = { id: String(claim.subjectId || "").split("/").pop() || ev.claimId, kind, status, summary: claim.fieldOrBehavior || "" };
    if (ev.execution && typeof ev.execution.label === "string") check.command = ev.execution.label;
    if (ev.evidenceType) check.evidenceType = ev.evidenceType;
    const waiver = waiverOf(claim);
    if (waiver) check._waiver = waiver;
    checks.push(check);
  }
  // Also include check claims that have no evidence item (surface_trust_refs style).
  for (const claim of allClaims) {
    if (!claim) continue;
    if (claimOrigin(claim) !== "check") continue;
    if (seen.has(claim.id)) continue;
    seen.add(claim.id);
    const kind = kindOf(claim);
    const check: AnyObj = { id: String(claim.subjectId || "").split("/").pop() || claim.id, kind, status: claim.value ?? "not_verified", summary: claim.fieldOrBehavior || "" };
    const waiver = waiverOf(claim);
    if (waiver) check._waiver = waiver;
    checks.push(check);
  }
  return checks;
}
function critiquesFromBundle(dir: string): AnyObj[] {
  const bundle = loadJson(path.join(dir, "trust.bundle"));
  if (!Array.isArray(bundle.claims)) return [];
  for (const c of bundle.claims) requireStampedClaim(c, dir);
  // A claim is a CRITIQUE when its origin is "critique" (authoritative — see requireStampedClaim
  // above). reviewer / reviewed_at / superseded_by are read back from metadata so supersession
  // (#267/#282) round-trips losslessly.
  const critiqueClaims = bundle.claims.filter((c: AnyObj) => c && claimOrigin(c) === "critique");
  return critiqueClaims.map((c: AnyObj) => {
    const md = (c.metadata && typeof c.metadata === "object") ? c.metadata as AnyObj : {};
    return {
      id: String(c.subjectId || "").split("/").pop() || c.id,
      verdict: c.value ?? "not_verified",
      summary: c.fieldOrBehavior || "",
      findings: [],
      reviewer: typeof md.reviewer === "string" ? md.reviewer : "tool-code-reviewer",
      reviewed_at: typeof md.reviewed_at === "string" ? md.reviewed_at : (c.updatedAt || c.createdAt || now()),
      artifact_refs: [],
      ...(typeof md.superseded_by === "string" && md.superseded_by.length > 0 ? { superseded_by: md.superseded_by } : {}),
    };
  });
}
// ─────────────────────────────────────────────────────────────────────────────
/**
 * WS8 (ADR 0020): parse the accepted-gap waiver flags. Both --accepted-gap-reason and
 * --waived-by are required together (an accepted gap with no justification or no
 * approver is refused — no silent/default waiver). Returns the waiver record to stamp
 * onto claim.metadata.waiver, or null when neither flag is present. Reuses the existing
 * accepted_gap -> assumed status mapping; adds no new canonical status value.
 */
function parseWaiver(p: ReturnType<typeof parseArgs>, ts: string): AnyObj | null {
  const reason = opt(p, "accepted-gap-reason");
  const waivedBy = opt(p, "waived-by");
  if (!reason && !waivedBy) return null;
  if (!reason) die("--accepted-gap-reason is required when --waived-by is set (an accepted gap must carry its justification)");
  if (!waivedBy) die("--waived-by is required when --accepted-gap-reason is set (an accepted gap must name its approver)");
  return { reason, approved_by: waivedBy, approved_at: ts };
}

async function recordEvidence(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const verdict = opt(p, "verdict") || die("--verdict is required");
  if (!verdicts.has(verdict)) die("verdict must be one of: pass, partial, fail, not_verified");
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const _ts0 = opt(p, "timestamp", now());
  const _waiver = parseWaiver(p, _ts0);
  const _checksRaw = [...opts(p, "check-json").map((v) => normalizeCheck(parseJson(v, "--check-json"))), ...opts(p, "surface-trust-json").map(surfaceCheckFromArtifact)];
  // WS8 (AC4, iteration 2): a command-backed check reconciles against CI or fails — it can
  // NEVER be waived. Reject --accepted-gap-reason/--waived-by on any check whose evidence
  // classifies as test_output (build/types/lint/test/command, and security/browser/runtime
  // WHEN a command is present). Only session-local checks (attestation/observation/citation/
  // diff/policy) are waivable. The CI reconciler enforces the same rule server-side (a waiver
  // on test_output evidence is a divergence), so this producer-side guard is defense-in-depth,
  // not the sole gate. (ADR 0020)
  if (_waiver) {
    for (const c of _checksRaw) {
      const hasCmd = typeof (c as AnyObj).command === "string" && String((c as AnyObj).command).trim().length > 0;
      if (classifyEvidence((c as AnyObj).kind as string | undefined, hasCmd).evidenceType === "test_output") {
        die(`--accepted-gap-reason/--waived-by cannot be applied to a command-backed check (kind='${String((c as AnyObj).kind)}'${hasCmd ? " with a command" : ""}): a command-backed check reconciles against CI or fails and cannot be waived. Waive only session-local checks (attestation/observation/citation). (ADR 0020)`);
      }
    }
  }
  const checks = _checksRaw.map((c) => _waiver ? { ...c, _waiver } : c);
  if (!checks.length && opts(p, "surface-trust-json").length === 0) die("record-evidence requires at least one --check-json or --surface-trust-json");
  validateAcceptanceEvidenceRefs(dir);
  // Phase 4c: bundle is the sole verification artifact — stop writing evidence.json and acceptance.json update.
  const ts = opt(p, "timestamp", now());
  const _existingAcceptance = loadJson(path.join(dir, "acceptance.json"));
  const _existingCriteria: AnyObj[] = Array.isArray(_existingAcceptance.criteria) ? _existingAcceptance.criteria : [];
  const _criteriaStatus = verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "not_verified";
  const _criteriaForBundle: AnyObj[] = _existingCriteria.map((c: AnyObj) => ({ ...c, status: _criteriaStatus }));
  // #268: preserve any existing critique claims (including superseded history) instead of dropping
  // them — record-evidence previously hardcoded critiques:[] here, silently erasing finding history
  // whenever it ran after a critique existed.
  const _existingCritiques: AnyObj[] = critiquesFromBundle(dir);
  assertBundleWritten(await writeTrustBundle(dir, slug, ts, checks, _criteriaForBundle, _existingCritiques));
  const stateStatus = verdict === "pass" ? "verified" : verdict === "fail" ? "failed" : "not_verified";
  writeState(dir, slug, stateStatus, "verification", ts, "Evidence recorded.");
  return 0;
}

function diagnostic(dir: string, code: string, summary: string): never {
  const payload = { timestamp: now(), code, summary };
  appendJsonl(path.join(dir, "transition-diagnostics.jsonl"), payload);
  die(`${code}: ${summary}`);
}

/**
 * record-gate-claim — Generic gate-claim producer for skills (ADR 0016 P-d Increment 1).
 *
 * Allows a skill to record a claim that satisfies a SPECIFIC gate expectation at the
 * active step. The caller passes:
 *   --status <pass|fail|not_verified>  (required)
 *   --summary <text>                   (required)
 *   --expectation <id>                 (optional; auto-resolved when the gate has one entry)
 *   --evidence-json <json>             (optional; structured evidence refs)
 *
 * The producer emits a check of kind="external" targeting the gate expectation's declared
 * claimType + subjectType from the active step's expects[]. This populates the trust.bundle
 * with a correctly-typed claim derived by Surface, suitable for gate enforcement.
 *
 * When the gate has exactly ONE expects[] entry, --expectation is optional (auto-resolve).
 * When the gate has multiple entries, --expectation <id> is required.
 *
 * This is what Increment 2's 6 skills will call to satisfy the category (c) gates
 * (pull-work.selected, design-probe.*, pr-open.pull-request, learn.*) once producers are added.
 *
 * Error cases:
 *   - No active flow/step in current.json → die with actionable message
 *   - --expectation not found in expects[] → die
 *   - Multiple expects[] entries and --expectation omitted → die
 *   - Surface unavailable → assertBundleWritten fails loud (no silent data loss)
 */
async function recordGateClaim(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const ts = opt(p, "timestamp", now());
  const statusVal = opt(p, "status");
  if (!["pass", "fail", "not_verified"].includes(statusVal)) die("--status must be one of: pass, fail, not_verified");
  const summary = opt(p, "summary") || die("--summary is required");
  const expectationId = opt(p, "expectation");

  // Resolve the active flow step from current.json. #291 Wave 2 Task 2.1 (§7)/Task 2.2: resolve
  // the CALLING actor's own current-pointer (per-actor-first, legacy-fallback) rather than an
  // unconditional legacy-only read — this is the fix for record-gate-claim's pre-existing (#291
  // Stop-short risk) lack of a dir-scoping guard: it now resolves ITS OWN actor's current.json
  // view, not a different actor's more-recently-written legacy pointer.
  const flowAgentsDir = path.dirname(dir);
  const gateClaimActorKey = resolveReadActorKey(p);
  const activeStep = resolveActiveFlowStep(flowAgentsDir, gateClaimActorKey);
  if (!activeStep) die("record-gate-claim requires an active flow step in current.json (set via ensure-session --flow-id or advance-state --flow-definition)");

  const expects = activeStep.gateExpects;
  if (expects.length === 0) die(`record-gate-claim: active step "${activeStep.stepId}" gate "${activeStep.gateId}" has no expects[] entries`);

  // Resolve the target expects entry
  let targetExpectation: typeof expects[0] | undefined;
  if (expectationId) {
    targetExpectation = expects.find((e) => e.id === expectationId);
    if (!targetExpectation) die(`record-gate-claim: --expectation "${expectationId}" not found in gate "${activeStep.gateId}" expects[]. Available: ${expects.map((e) => e.id).join(", ")}`);
  } else if (expects.length === 1) {
    targetExpectation = expects[0]!;
  } else {
    die(`record-gate-claim: gate "${activeStep.gateId}" has ${expects.length} expects[] entries; --expectation <id> is required. Available: ${expects.map((e) => e.id).join(", ")}`);
  }

  const { claimType, subjectType } = targetExpectation.bundle_claim;

  // Build a synthetic external check that will be matched by matchExpectsEntry to produce
  // a correctly-typed claim. We use kind="external" so it routes through the non-policy,
  // non-flow-step fallback path. The subjectType on the resulting claim comes from the
  // expects[] entry via matchExpectsEntry.
  const checkId = expectationId || targetExpectation.id;
  // Build a minimal "external" check. Include _gate_claim_expectation_id so that
  // matchExpectsEntry can do an exact lookup for multi-expects[] gates (ADR 0016 P-d Increment 2).
  // normalizeCheck preserves extra underscore-prefixed fields without stripping them.
  const check: AnyObj = {
    id: `gate-claim-${checkId}`,
    kind: "external",
    status: statusVal,
    summary,
    _gate_claim_expectation_id: targetExpectation.id,
  };

  // Include structured evidence refs if provided
  const evidenceRefs: AnyObj[] = opts(p, "evidence-ref-json").map((v) => validateEvidenceRef(parseJson(v, "--evidence-ref-json"), "--evidence-ref-json"));

  if (evidenceRefs.length > 0) {
    check.artifact_refs = evidenceRefs;
  }

  const checkNormalized = normalizeCheck(check);
  // WS8 (ADR 0020): honor the accepted-gap waiver flags for a gate claim too.
  const gateWaiver = parseWaiver(p, ts);
  if (gateWaiver) checkNormalized._waiver = gateWaiver;
  // Log the targeted gate expectation for transparency (goes to stderr only)
  process.stderr.write(`[record-gate-claim] targeting ${activeStep.stepId}/${activeStep.gateId}/${targetExpectation.id} → claimType=${claimType} subjectType=${subjectType}${gateWaiver ? " (WAIVED accepted_gap)" : ""}\n`);
  assertBundleWritten(await writeTrustBundle(dir, slug, ts, [checkNormalized], [], [], gateClaimActorKey));
  return 0;
}

/**
 * promote — the promote-then-archive gate (issue #312). Durable-residue extraction is
 * the archival act: this records WHAT durable residue was promoted WHERE and writes a
 * PROMOTION CLAIM into the session trust.bundle.
 *
 * Claim shape (reconcile-safe by construction): the promotion check is kind="policy",
 * so classifyEvidence maps it to evidenceType "policy_rule" (session-local, method
 * "auditability"). It carries NO command / execution.label, so it can NEVER require a
 * reconcile-manifest entry and can NEVER become a [not-run] / unbacked-command
 * divergence at CI trust-reconcile. Its status derives to `verified` from that
 * session-local policy_rule evidence item, so the reconciler classifies it session-local
 * and accepts it as an ATTESTED claim (exit 0) — never as a test_output claim that must
 * match the manifest. The _promotion marker rides onto claim.metadata.promotion (see
 * buildTrustBundle) so the archive gate and validators can detect it without new manifest
 * entries (R1).
 *
 * Modes:
 *   promote <dir> --evidence-path <p> [--evidence-path <p> ...]
 *       Records the durable doc paths written (docs/decisions/<slug>.md, CONTEXT.md,
 *       docs/learnings/*, …). Each path MUST exist on disk at record time — a missing
 *       path fails loud (no silent empty promotion).
 *   promote <dir> --none --reason "<why nothing durable>"
 *       An explicit, auditable no-residue promotion (R3).
 */
async function promote(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const ts = opt(p, "timestamp", now());
  const none = p.flags.has("none");
  const reason = opt(p, "reason");
  const repoRoot = opt(p, "repo-root") ? path.resolve(opt(p, "repo-root")) : findRepoRootFromDir(dir);
  const rawPaths = opts(p, "evidence-path");

  if (none) {
    if (rawPaths.length) die("promote --none records a no-residue claim; do not also pass --evidence-path");
    if (!reason.trim()) die("promote --none requires --reason \"<why nothing durable was promoted>\"");
  } else {
    if (!rawPaths.length) die("promote requires at least one --evidence-path <durable-doc-path> (or --none --reason \"<why>\" for an explicit no-residue promotion)");
  }

  // Every evidence ref MUST exist on disk at record time (fail loud otherwise). Store
  // repo-relative paths when the ref lives under the repo, so the claim is portable.
  const targets: string[] = [];
  for (const raw of rawPaths) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
    if (!fs.existsSync(abs)) die(`promote --evidence-path does not exist on disk: ${raw} (resolved: ${abs}). Promotion evidence refs must point at durable docs that were actually written.`);
    const rel = path.relative(repoRoot, abs);
    targets.push(rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : raw);
  }

  const promotionMarker: AnyObj = {
    schema_version: "1.0",
    none,
    ...(none ? { reason } : {}),
    targets,
    promoted_at: ts,
  };

  const summary = opt(p, "summary") || (none
    ? `Promotion (no durable residue): ${reason}`
    : `Promoted durable residue: ${targets.join(", ")}`);

  // Session-local promotion check: kind="policy" -> policy_rule evidence, no command.
  const promotionCheck: AnyObj = { id: "promotion", kind: "policy", status: "pass", summary, _promotion: promotionMarker };

  // Add the promotion claim WITHOUT dropping the session's existing verification
  // evidence/criteria/critiques (mirror record-critique's merge pattern). Drop any prior
  // "promotion" check so re-running promote is idempotent rather than duplicating.
  const existingChecks = checksFromBundle(dir).filter((c) => c.id !== "promotion");
  const _acc = loadJson(path.join(dir, "acceptance.json"));
  const criteria: AnyObj[] = Array.isArray(_acc.criteria) ? _acc.criteria : [];
  const critiques = critiquesFromBundle(dir);
  assertBundleWritten(await writeTrustBundle(dir, slug, ts, [...existingChecks, promotionCheck], criteria, critiques));

  // Auditable record of what was promoted where (companion to the trust.bundle claim).
  writeJson(path.join(dir, "promotion.json"), { ...sidecarBase(slug), ...promotionMarker, summary });

  // Optionally republish so delivery/trust.bundle carries the promotion claim for CI.
  if (p.flags.has("publish")) {
    const publishRepoRoot = opt(p, "publish-repo-root") ? path.resolve(opt(p, "publish-repo-root")) : findRepoRootFromDirStrict(dir);
    // #356 AC6: an InvalidBundleShapeError refusal must be LOUD (rethrown, so `promote`
    // itself fails/exits non-zero) — it is NOT one of the best-effort failure modes (missing
    // kits/ ancestor, I/O) this catch otherwise tolerates. A `.catch(() => {})`-style swallow
    // here would silently defeat the whole preflight for the --publish path.
    await publishDelivery(dir, publishRepoRoot).catch((err: unknown) => {
      if (err instanceof InvalidBundleShapeError) throw err;
      if (err instanceof NotFreshHolderError) throw err;
      process.stderr.write(`[promote] WARNING: publish-delivery failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }

  process.stderr.write(`[promote] recorded ${none ? "no-residue" : targets.length + " durable ref(s)"} promotion claim for ${slug}\n`);
  printJson({ ok: true, slug, none, targets, promotion_claim: "trust.bundle" });
  return 0;
}

async function advanceState(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const status = opt(p, "status");
  const phase = opt(p, "phase");
  const target = opt(p, "target-phase");
  if (!statuses.has(status)) die(`status must be one of: ${[...statuses].join(", ")}`);
  if (!phases.includes(phase)) die(`phase must be one of: ${phases.join(", ")}`);
  if (target && !phases.includes(target)) die(`target phase must be one of: ${phases.join(", ")}`);
  const prev = loadJson(path.join(dir, "state.json"));
  if ((status === "archived" || status === "accepted") && prev.phase !== "learning") diagnostic(dir, "terminal_jump_rejected", "Terminal workflow states require release and learning gates.");
  const flow = opt(p, "flow-definition");
  // Route-back guard: FlowDefinition-driven (not hardcoded to builder.build).
  // Fires when the active flow's gate for prev.phase declares a route_back_policy
  // AND the target phase maps to a step listed in on_route_back values.
  // builder.build verify-gate already carries this declaration — behavior preserved.
  const repoRoot = flow ? findRepoRootFromDir(dir) : "";
  const routeBack = flow ? resolveRouteBackPolicy(flow, prev.phase, phase, repoRoot) : null;
  if (routeBack) {
    const reason = opt(p, "route-back-reason");
    if (!reason) diagnostic(dir, "route_back_reason_required", `Route-back from ${prev.phase} to ${phase} requires a --route-back-reason (e.g. implementation_defect).`);
    const file = path.join(dir, "transition-attempts.json");
    const attempts = loadJson(file);
    const key = `${prev.phase}->${phase}:${reason}`;
    const count = attempts[key]?.count ?? 0;
    if (count >= routeBack.maxAttempts) diagnostic(dir, "route_back_attempts_exceeded", `Route-back attempt limit (${routeBack.maxAttempts}) exceeded for ${prev.phase}→${phase}.`);
    attempts[key] = { count: count + 1, reason, updated_at: opt(p, "timestamp", now()) };
    writeJson(file, attempts);
  }
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const timestamp = opt(p, "timestamp", now());
  writeState(dir, slug, status, phase, timestamp, opt(p, "summary"));
  writeJson(path.join(dir, "handoff.json"), { ...loadJson(path.join(dir, "handoff.json")), ...sidecarBase(slug), summary: opt(p, "summary"), current_state_ref: "state.json", next_steps: [opt(p, "next-action")].filter(Boolean), blockers: [], warnings: [] });
  // ADR 0016 Abstraction A (P-d, Increment 1): when --flow-definition is provided,
  // resolve the phase→step mapping from the FlowDefinition and write active_step_id
  // into current.json. This is the single setter — no skill needs to call ensure-session
  // --step-id individually. The repoRoot is derived by walking up from dir to find kits/.
  if (flow) {
    const root = path.resolve(opt(p, "artifact-root", path.dirname(dir)));
    // repoRoot already computed above when flow is present
    const phaseMap = resolvePhaseMap(flow, repoRoot);
    const stepId = phaseMap?.[phase] ?? undefined;
    if (stepId) {
      // #291 Wave 2 Task 2.1 (§5): thread the calling actor through so this second writeCurrent()
      // call site ALSO dual-writes the per-actor projection, not only ensure-session's call site —
      // otherwise a session that only ever calls advance-state (never re-running ensure-session)
      // would never get a per-actor current.json mirror for its own FlowDefinition routing keys.
      writeCurrent(root, dir, timestamp, "workflow-sidecar", "advance-state", flow, stepId, undefined, resolveReadActorKey(p));
    }
  }
  livenessLifecycle(dir, slug, LIVENESS_TERMINAL.has(status) ? "release" : "heartbeat", timestamp);
  // Trust checkpoint: when advancing to a terminal delivered status, seal the checkpoint.
  if (status === "delivered") {
    await sealTrustCheckpoint(dir, slug, timestamp, status, "release").catch(() => { /* best-effort; checkpoint seal must not break advance-state */ });
    // Publish delivery bundle: best-effort copy to delivery/ for CI trust-reconcile.
    // Fail-closed repo-root resolution (findRepoRootFromDirStrict, no cwd fallback) — see
    // publishDelivery below. An explicit --repo-root (e.g. for a scratch/test artifact dir
    // with no kits/ ancestor of its own) always wins, matching publishDeliveryCmd. Failures
    // are visible (stderr warning), not silently swallowed.
    // #356 AC6: an InvalidBundleShapeError refusal is NOT one of those best-effort failure
    // modes — it must be LOUD and cause advance-state itself to fail (rethrown here so the
    // outer command surfaces a non-zero exit), never silently swallowed alongside a genuine
    // repo-root-resolution/I-O failure.
    const publishRepoRoot = opt(p, "repo-root") ? path.resolve(opt(p, "repo-root")) : findRepoRootFromDirStrict(dir);
    await publishDelivery(dir, publishRepoRoot).catch((err: unknown) => {
      if (err instanceof InvalidBundleShapeError) throw err;
      if (err instanceof NotFreshHolderError) throw err;
      process.stderr.write(`[advance-state] WARNING: publish-delivery failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }
  return 0;
}

export function normalizeFinding(raw: AnyObj): AnyObj {
  if (raw.file_refs !== undefined && !Array.isArray(raw.file_refs)) die("file_refs must be an array");
  return raw;
}

async function recordCritique(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  // Phase 4c: accumulate existing critiques from trust.bundle (critique.json no longer written).
  // Fall back to critique.json for legacy sessions that still have it on disk.
  const existingCritiqueJson = loadJson(path.join(dir, "critique.json"), { critiques: [] });
  const legacyCritiques: AnyObj[] = Array.isArray(existingCritiqueJson.critiques) ? existingCritiqueJson.critiques : [];
  const bundleCritiques = legacyCritiques.length === 0 ? critiquesFromBundle(dir) : legacyCritiques;
  const critique = { id: opt(p, "id") || "review", reviewer: opt(p, "reviewer", "tool-code-reviewer"), reviewed_at: opt(p, "timestamp", now()), verdict: opt(p, "verdict", "pass"), summary: opt(p, "summary"), artifact_refs: opts(p, "artifact-ref"), findings: opts(p, "finding-json").map((v) => normalizeFinding(parseJson(v, "--finding-json"))) };
  if (critique.verdict === "pass" && critique.findings.some((f: AnyObj) => f.status === "open")) die("required critique must pass");
  // #267/#282: supersede-by-critique-id. The latest write for a critique id wins for
  // reconcile / status / validator purposes; each prior LIVE write for the same id is RETAINED as
  // history (status "superseded", first-class metadata.superseded_by) but excluded from evaluation.
  // Supersession is REVIEWER-SCOPED (anti-gaming): a write may only supersede a prior live critique
  // of the same id written by the SAME reviewer — a different reviewer's disputed finding is never
  // buried, so it stays live and continues to block. DOCUMENTED GAP: reviewer identity is the
  // free-form --reviewer string (with a default); there is no cryptographic worker-vs-reviewer
  // distinction yet — that lands with the runtime actor-identity slice (#287/#290). Same-reviewer-
  // string scoping is the strongest honest enforcement available today and matches the granularity
  // the critique record already has.
  const _supersedeMarker = `${critique.id}@${critique.reviewed_at}`;
  const _mergedCritiques = bundleCritiques.map((e: AnyObj) => {
    const eSuperseded = typeof e.superseded_by === "string" && e.superseded_by.length > 0;
    const eReviewer = String(e.reviewer ?? "tool-code-reviewer");
    if (e.id === critique.id && !eSuperseded && eReviewer === critique.reviewer) return { ...e, superseded_by: _supersedeMarker };
    return e;
  });
  const critiques = [..._mergedCritiques, critique];
  // Phase 4c: build bundle from raw inputs; read checks from trust.bundle (evidence.json no longer written).
  const _critiqueEvChecks: AnyObj[] = checksFromBundle(dir);
  const _critiqueAccCriteria: AnyObj[] = Array.isArray(loadJson(path.join(dir, "acceptance.json")).criteria) ? loadJson(path.join(dir, "acceptance.json")).criteria : [];
  assertBundleWritten(await writeTrustBundle(dir, slug, critique.reviewed_at, _critiqueEvChecks, _critiqueAccCriteria, critiques));
  return 0;
}
function frontmatter(text: string, key: string): string {
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  if (end < 0) return "";
  return new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text.slice(0, end))?.[1]?.trim() ?? "";
}
async function importCritique(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const review = p.positional[1] || die("review artifact is required");
  const text = read(review);
  const role = frontmatter(text, "role");
  if (!["review", "code-review"].includes(role)) die("review artifact must declare role");
  const verdictRaw = (frontmatter(text, "verdict") || /###\s+Verdict:\s*([A-Z_]+)/i.exec(text)?.[1] || "PASS").toUpperCase();
  const verdict = verdictRaw === "CHANGES_REQUESTED" || verdictRaw === "FAIL" ? "fail" : verdictRaw === "NOT_VERIFIED" ? "not_verified" : "pass";
  const findings: AnyObj[] = [];
  const re = /^####\s+\[(?<severity>[A-Z]+)\]\s+(?<target>.+?)\s+-\s+(?<title>.+)$/gm;
  for (let m; (m = re.exec(text));) {
    const title = m.groups?.title ?? "finding";
    findings.push({ id: slugify(title, `finding-${findings.length + 1}`), severity: (m.groups?.severity ?? "info").toLowerCase(), status: opt(p, "finding-status", verdict === "pass" ? "fixed" : "open"), description: title, file_refs: [m.groups?.target ?? review] });
  }
  const parsed = { ...p, positional: [dir], opts: { ...p.opts, id: [slugify(path.basename(review).replace(/\.md$/, ""), "review")], reviewer: ["tool-code-reviewer"], verdict: [verdict], summary: [`Imported critique from ${path.basename(review)}`], "finding-json": findings.map((f) => JSON.stringify(f)) }, flags: p.flags };
  const result = await recordCritique(parsed);
  if (verdict !== "pass") die("required critique must pass");
  return result;
}
async function recordRelease(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const decision = opt(p, "decision");
  if (!["merge", "release", "deploy", "hold", "rollback_required"].includes(decision)) die("decision must be one of: merge, release, deploy, hold, rollback_required");
  const gates = opts(p, "gate-json").map((v) => parseJson(v, "--gate-json"));
  if (["merge", "release", "deploy"].includes(decision) && !gates.some((g) => g.name === decision && g.status === "pass")) die(`positive release decision requires ${decision} gate to pass`);
  const payload = { ...sidecarBase(slug), decision: opt(p, "decision"), updated_at: opt(p, "timestamp", now()), scope: opt(p, "scope"), evidence_ref: opt(p, "evidence-ref"), gates: opts(p, "gate-json").map((v) => parseJson(v, "--gate-json")), rollback_plan: parseJson(opt(p, "rollback-json", '{"status":"not_required","summary":"Not required.","owner":"maintainer"}'), "--rollback-json"), observability_plan: parseJson(opt(p, "observability-json", '{"status":"not_required","summary":"Not required."}'), "--observability-json"), post_deploy_checks: opts(p, "post-deploy-json").map((v) => parseJson(v, "--post-deploy-json")), docs: parseJson(opt(p, "docs-json", '{"status":"not_needed","summary":"Not needed."}'), "--docs-json") };
  const stateSummary = opt(p, "summary").trim() || `Release readiness recorded for ${decision}.`;
  writeJson(path.join(dir, "release.json"), payload);
  writeState(dir, slug, "delivered", "release", payload.updated_at, stateSummary);
  // Trust checkpoint: seal at the "delivered" moment (the natural terminal mark for record-release).
  await sealTrustCheckpoint(dir, slug, payload.updated_at, "delivered", "release").catch(() => { /* best-effort; checkpoint seal must not break record-release */ });
  // Publish delivery bundle: best-effort copy to delivery/ for CI trust-reconcile.
  // Fail-closed repo-root resolution (findRepoRootFromDirStrict, no cwd fallback) — see
  // publishDelivery below. An explicit --repo-root (e.g. for a scratch/test artifact dir with
  // no kits/ ancestor of its own) always wins, matching publishDeliveryCmd. Failures are
  // visible (stderr warning), not silently swallowed.
  // #356 AC6: an InvalidBundleShapeError refusal is NOT best-effort — rethrow so record-release
  // itself fails loudly (non-zero exit) rather than silently publishing nothing while reporting
  // success. This is the crux of AC6: record-release is one of the auto-publish paths that must
  // never let a shape-invalid bundle slip past unnoticed.
  const publishRepoRoot = opt(p, "repo-root") ? path.resolve(opt(p, "repo-root")) : findRepoRootFromDirStrict(dir);
  await publishDelivery(dir, publishRepoRoot).catch((err: unknown) => {
    if (err instanceof InvalidBundleShapeError) throw err;
    if (err instanceof NotFreshHolderError) throw err;
    process.stderr.write(`[record-release] WARNING: publish-delivery failed: ${err instanceof Error ? err.message : String(err)}\n`);
  });
  return 0;
}

// ─── Trust Checkpoint (Increment A) ──────────────────────────────────────────
// Per-run frozen snapshot of verified trust state at completion. Written to
// trust.checkpoint.json alongside the other workflow sidecars.
// Surface owns the DerivationCheckpoint shape; flow-agents wraps it in an
// ENVELOPE that adds per-run context surface does not carry.
//
// Envelope shape:
//   {
//     schema_version: "1.0",
//     slug: string,
//     work_item: string | null,
//     status: string,
//     phase: string,
//     sealed_at: ISO-8601,
//     commit_sha: string | null,
//     checkpoint: DerivationCheckpoint   ← surface owns this
//   }
//
// Idempotent: re-running advance-state / record-release to the same terminal
// status overwrites with the latest snapshot.
// Fail-open: if no trust.bundle exists, or Surface is unavailable, the write
// is skipped gracefully (no error surfaced to the caller).

/** Derive the current git HEAD sha — null if unavailable (not in a repo, git absent). */
function resolveCommitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Build and write trust.checkpoint.json for a completed run.
 * Skips silently when:
 *   - trust.bundle is absent (no evidence recorded yet)
 *   - Surface is unavailable (checkpointFromReport not found)
 * The caller wraps this in .catch() so it never breaks the parent command.
 *
 * Increment B1 — checkpoint signing at the release boundary:
 * After the checkpoint is written, attempts Sigstore keyless signing (OIDC).
 *   - CI/OIDC available:   writes trust.checkpoint.sig.json (cosign-verifiable DSSE envelope)
 *                          and writes attestation:{status:"signed",...} to trust.checkpoint.attestation.json.
 *   - Local (no OIDC):     writes trust.checkpoint.intoto.json (unsigned in-toto statement)
 *                          and writes attestation:{status:"unsigned",...} to trust.checkpoint.attestation.json.
 * Signing is ALWAYS fail-open — a signing failure never breaks the seal.
 */
export async function sealTrustCheckpoint(dir: string, slug: string, sealedAt: string, status: string, phase: string): Promise<void> {
  const bundlePath = path.join(dir, "trust.bundle");
  if (!fs.existsSync(bundlePath)) return; // no bundle — skip gracefully
  const surface = await tryLoadSurface();
  if (!surface || typeof surface.checkpointFromReport !== "function" || typeof surface.buildTrustReport !== "function") return; // Surface unavailable

  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const report = surface.buildTrustReport(bundle as Record<string, unknown>);
  const checkpoint = surface.checkpointFromReport(report);

  // Derive work_item from state.json if present (best-effort)
  let workItem: string | null = null;
  try {
    const stateRaw = loadJson(path.join(dir, "state.json"));
    if (typeof stateRaw.work_item === "string") workItem = stateRaw.work_item;
  } catch { /* ignored */ }

  const checkpointPath = path.join(dir, "trust.checkpoint.json");
  const envelope: AnyObj = {
    schema_version: "1.0",
    slug,
    work_item: workItem,
    status,
    phase,
    sealed_at: sealedAt,
    commit_sha: resolveCommitSha(),
    checkpoint,
  };
  writeJson(checkpointPath, envelope);

  // ─── Increment B1: sign the checkpoint at the release boundary ───────────────
  // Additive: if surface lacks in-toto/sigstore primitives, skip silently.
  // The .catch() at the call site already guards the parent command; this inner
  // catch is defense-in-depth so signing never propagates an error upward.
  await signCheckpointAttestation(dir, surface, bundle, checkpointPath).catch((err) => {
    process.stderr.write(`[checkpoint-signing] signing skipped due to error: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}

/**
 * Increment B1 — Sign the trust checkpoint with in-toto/Sigstore.
 *
 * Called from sealTrustCheckpoint AFTER trust.checkpoint.json is written.
 * Computes the sha256 digest of the checkpoint file, builds an in-toto Statement
 * (predicate = trust bundle), and attempts Sigstore keyless signing.
 *
 *   - Signed (CI/OIDC):  writes trust.checkpoint.sig.json (DSSE envelope, cosign-verifiable).
 *   - Unsigned (local):  writes trust.checkpoint.intoto.json (unsigned statement).
 *   - Always writes:     trust.checkpoint.attestation.json with attestation:{status,path,...}.
 *                        trust.checkpoint.json is NOT modified after its digest is computed.
 *
 * NEVER throws — all errors are caught and surfaced as stderr warnings.
 * Skips silently when Surface's toInTotoStatement / signStatementWithSigstore are absent.
 *
 * @param dir            Session artifact directory.
 * @param surface        Loaded Surface module (may or may not have in-toto/sigstore exports).
 * @param bundle         Parsed trust.bundle (becomes the in-toto predicate).
 * @param checkpointPath Absolute path to the already-written trust.checkpoint.json.
 */
async function signCheckpointAttestation(
  dir: string,
  surface: SurfaceModule,
  bundle: AnyObj,
  checkpointPath: string,
): Promise<void> {
  // Guard: both primitives must be present (consumed from Surface, never reimplemented).
  if (typeof surface.toInTotoStatement !== "function" || typeof surface.signStatementWithSigstore !== "function") {
    process.stderr.write("[checkpoint-signing] Surface in-toto/sigstore primitives unavailable — skipping attestation\n");
    return;
  }

  // Step A: compute sha256 digest of trust.checkpoint.json (the SUBJECT).
  // The checkpoint is self-evidencing — its digest is the external anchor.
  const checkpointBytes = fs.readFileSync(checkpointPath);
  const sha256hex = createHash("sha256").update(checkpointBytes).digest("hex");

  // Step B: build the in-toto Statement.
  //   subject  = the checkpoint file (what we are attesting TO)
  //   predicate = the trust bundle   (what the checkpoint CONTAINS)
  const subjects = [{ name: "trust.checkpoint.json", digest: { sha256: sha256hex } }];
  const statement = surface.toInTotoStatement(bundle as Record<string, unknown>, { subjects });

  // Step C: attempt Sigstore keyless signing (PRIMARY path).
  // signStatementWithSigstore returns null when no ambient OIDC credential is available
  // (local development, no ACTIONS_ID_TOKEN_REQUEST_URL). This is the expected local case.
  let signed: { envelope: { payloadType: "application/vnd.in-toto+json"; payload: string; signatures: Array<{ keyid: string; sig: string }> }; sigstoreBundle: unknown; assuranceLevel: "signed" } | null = null;
  try {
    signed = await surface.signStatementWithSigstore(statement);
  } catch (err) {
    // signStatementWithSigstore may throw on unexpected failures (network error, config error);
    // treat as fail-open: fall through to the unsigned path.
    process.stderr.write(`[checkpoint-signing] signStatementWithSigstore threw: ${err instanceof Error ? err.message : String(err)}\n`);
    signed = null;
  }

  let attestation: AnyObj;
  if (signed) {
    // CI/OIDC path: write the cosign-verifiable DSSE envelope.
    const sigPath = path.join(dir, "trust.checkpoint.sig.json");
    writeJson(sigPath, signed.envelope);
    const keyid = signed.envelope.signatures[0]?.keyid ?? "";
    attestation = {
      status: "signed",
      path: "trust.checkpoint.sig.json",
      keyid,
    };
    process.stderr.write(`[checkpoint-signing] checkpoint signed with Sigstore — envelope written to ${sigPath}\n`);
  } else {
    // Local/unsigned path: write the unsigned in-toto statement for audit purposes.
    const unsignedPath = path.join(dir, "trust.checkpoint.intoto.json");
    writeJson(unsignedPath, statement);
    attestation = {
      status: "unsigned",
      path: "trust.checkpoint.intoto.json",
      reason: "no ambient signing identity",
    };
    process.stderr.write("[checkpoint-signing] no ambient OIDC identity — unsigned in-toto statement written (expected locally)\n");
  }

  // Step D: write the attestation record to a SEPARATE companion file.
  // trust.checkpoint.json is NOT modified — it must remain byte-identical to what was signed.
  // The companion file carries the pointer/status; the subject-digest binding in the
  // in-toto statement ties it back to the checkpoint without breaking the digest.
  const attestationPath = path.join(dir, "trust.checkpoint.attestation.json");
  writeJson(attestationPath, attestation);
}

/**
 * seal-checkpoint <dir> [--timestamp <iso>]
 *
 * Explicit seal of the trust checkpoint for the given artifact dir.
 * Equivalent to the seal that fires automatically at record-release / advance-state
 * to delivered. Useful for the deliver skill or a human to seal explicitly without
 * re-running advance-state.
 *
 * Usage: workflow-sidecar seal-checkpoint <artifactDir> [--timestamp <iso>]
 */
async function sealCheckpoint(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const timestamp = opt(p, "timestamp", now());
  const stateRaw = loadJson(path.join(dir, "state.json"));
  const status = typeof stateRaw.status === "string" ? stateRaw.status : "delivered";
  const phase = typeof stateRaw.phase === "string" ? stateRaw.phase : "release";

  const bundlePath = path.join(dir, "trust.bundle");
  if (!fs.existsSync(bundlePath)) {
    process.stderr.write(`[seal-checkpoint] no trust.bundle at ${bundlePath} — skipping (nothing to seal)
`);
    return 0;
  }
  await sealTrustCheckpoint(dir, slug, timestamp, status, phase);
  const checkpointPath = path.join(dir, "trust.checkpoint.json");
  if (fs.existsSync(checkpointPath)) {
    console.log(checkpointPath);
  } else {
    process.stderr.write(`[seal-checkpoint] checkpoint was not written — @kontourai/surface may be unavailable
`);
  }
  return 0;
}


// ─── Reconcile Preflight (#356) ───────────────────────────────────────────────
// Local, pre-push shape-only preflight for a session's trust.bundle, reusing
// scripts/lib/reconcile-shape.js (WS8/#356 extraction) and scripts/ci/trust-reconcile.js's
// own exported manifest resolver — never a forked reimplementation, so this can never
// silently drift from what the CI trust-reconcile job actually enforces. Deliberately
// shape-only: it never spawns a fresh manifest/CI command (AC5) — only the already-cheap
// `run-baseline.sh --manifest-json` static registry emit, which prints the manifest, not
// test results.

/**
 * Delegate to the shared pure-CJS bundle-shape module (scripts/lib/reconcile-shape.js),
 * mirroring the createRequire pattern used by loadActorIdentityHelper()/
 * loadLivenessWriteHelper() above — the one repo/runtime boundary #356's plan flagged as
 * worth double-checking (workflow-sidecar.ts is TS→ESM-compiled-to-CJS-compatible-output;
 * scripts/lib/reconcile-shape.js is plain CommonJS). Verified clean via `npm run build`
 * + a require() smoke against build/src/cli/workflow-sidecar.js before this was wired in.
 */
function loadReconcileShapeHelper(): {
  classifyBundleClaims: (bundle: AnyObj) => {
    reconcilable: AnyObj[];
    sessionLocal: AnyObj[];
    noEvidenceCommand: AnyObj[];
    waiverOnCommand: AnyObj[];
  };
  normalizeCmd: (cmd: string) => string;
  waiverOnCommandIssues: (waiverOnCommand: AnyObj[]) => AnyObj[];
  noEvidenceCommandIssues: (noEvidenceCommand: AnyObj[]) => AnyObj[];
  reconcilableManifestIssues: (reconcilable: AnyObj[], manifestByCmd: Map<string, AnyObj>) => { issues: AnyObj[]; unresolved: AnyObj[] };
  sessionLocalShapeIssues: (
    sessionLocal: AnyObj[],
    derivedStatus: Map<string, string | null> | null,
    opts?: { onUnderivable?: "fail" | "reduce" }
  ) => { issues: AnyObj[]; attestedCount: number; logEvents: AnyObj[] };
} {
  const _req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/lib/reconcile-shape.js");
  return _req(helperPath);
}

/**
 * Delegate to scripts/ci/trust-reconcile.js's own EXPORTED pure helpers (manifest
 * resolution + the git-ancestor primitive) — same createRequire idiom as
 * loadReconcileShapeHelper() above. trust-reconcile.js is CommonJS; these exports were
 * added alongside `runTrustReconcile` specifically so a local caller (this preflight)
 * never needs a second implementation of "how the manifest is resolved" (Q1/AC5).
 */
function loadTrustReconcileHelper(): {
  resolveManifest: (args: { manifest?: string | null }, repoRoot: string, canonicalCommands: string[]) => { entries: Array<{ id: string; command: string }>; source: string };
  runBaselineManifest: (repoRoot: string) => Array<{ id: string; command: string }> | null;
  normalizeManifestEntries: (raw: unknown) => Array<{ id: string; command: string }> | null;
  slugifyLabel: (s: string) => string;
  normalizeCmd: (cmd: string) => string;
  isAncestorCommit: (repoRoot: string, ancestorSha: string, descendantSha: string) => boolean;
  resolveCanonicalCommands: (args: { commands: string[] }, repoRoot: string) => string[] | null;
} {
  const _req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ci/trust-reconcile.js");
  return _req(helperPath);
}

/**
 * Shell to scripts/ci/derive-claim-status.mjs exactly as trust-reconcile.js's own
 * deriveClaimStatuses() does (Q1's recommendation: full status-misassertion/unwaived-assumed
 * parity with CI, at the cost of one cheap local-only spawn — no CI command execution, just
 * Surface's pure deriveClaimStatus over the bundle's own evidence/events/policies). Returns
 * null when re-derivation is unavailable (Surface could not load / helper failed) — callers
 * degrade to reconcile-shape.js's documented reduced-coverage mode, they do not fail the
 * whole preflight over this.
 */
function derivePreflightClaimStatuses(bundlePath: string, repoRoot: string): Map<string, string | null> | null {
  const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ci/derive-claim-status.mjs");
  if (!fs.existsSync(helper)) return null;
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [helper, bundlePath], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
  } catch {
    return null;
  }
  if (!stdout) return null;
  try {
    const obj = JSON.parse(stdout);
    const m = new Map<string, string | null>();
    for (const [k, v] of Object.entries(obj)) m.set(k, v as string | null);
    return m;
  } catch {
    return null;
  }
}

/**
 * Distinct, identifiable error for a shape-invalid trust.bundle — NOT a generic Error, so
 * every publishDelivery() call site (advanceState/recordRelease/promote/publishDeliveryCmd)
 * can positively distinguish "refuses to publish an invalid bundle" (must be LOUD, fail
 * closed, AC6) from the other failure modes those call sites already tolerate as best-effort
 * (missing kits/ ancestor for a scratch dir, I/O errors, etc — see each catch's own comment).
 * A bare `instanceof Error` check would not suffice since every thrown failure in this file is
 * already an Error; `code` is the recognizable, grep-stable discriminator.
 */
export class InvalidBundleShapeError extends Error {
  readonly code = "RECONCILE_PREFLIGHT_INVALID_SHAPE" as const;
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`trust.bundle failed the reconcile-preflight shape check (${issues.length} issue(s)) — see .issues for the full report`);
    this.name = "InvalidBundleShapeError";
    this.issues = issues;
  }
}

/**
 * Distinct, identifiable error for a publish attempt by an actor who is NOT the fresh,
 * non-superseded holder of the subject (issue #293, ADR 0021 §3) — NOT a generic Error and NOT
 * `InvalidBundleShapeError` (#356), so every publishDelivery() call site can positively
 * distinguish "refuses to publish because the bundle shape is invalid" from "refuses to publish
 * because this actor no longer holds the subject" — two genuinely distinct fail-closed tiers
 * that must never be conflated in a catch handler (a worker fixing a shape issue must not be
 * told to "re-record evidence" when the real problem is a stale/superseded claim, and vice
 * versa). Mirrors `InvalidBundleShapeError`'s shape exactly: same `extends Error` base, same
 * `readonly code` discriminator convention, same doc-comment structure — only the payload
 * differs (the effective-state/holder/reason/guidance `runVerifyHold()` computed, rather than a
 * shape-issue list).
 */
export class NotFreshHolderError extends Error {
  readonly code = "VERIFY_HOLD_NOT_FRESH_HOLDER" as const;
  readonly effective_state: EffectiveState | "not_evaluated";
  readonly holder?: { actor?: string; assignee?: string | null; idle_days?: number | null; last_at?: string };
  readonly reason: string;
  readonly guidance: string[];
  constructor(result: { effective_state: EffectiveState | "not_evaluated"; holder?: { actor?: string; assignee?: string | null; idle_days?: number | null; last_at?: string }; reason: string; guidance: string[] }) {
    super(`verify-hold refused publish — not the fresh holder of this subject (${result.reason}) — see .guidance for reconcile steps`);
    this.name = "NotFreshHolderError";
    this.effective_state = result.effective_state;
    this.holder = result.holder;
    this.reason = result.reason;
    this.guidance = result.guidance;
  }
}

/**
 * Human-actionable fix text per divergence type (Q2: unwaived-assumed's message always
 * carries the "waiver voided by a mixed record-evidence call" root-cause hint — shape #5 is
 * NOT a distinct predicate, it is #2 enriched, per the plan's Q2 resolution).
 */
function preflightFixHint(type: string): string {
  switch (type) {
    case "unwaived-assumed":
      return "FIX: make it pass for real, or re-record with --accepted-gap-reason/--waived-by on a SEPARATE record-evidence call — a command-backed check in the SAME call voids/rejects the waiver (see the command-backed-waiver guard in workflow-sidecar.ts's recordEvidence).";
    case "waiver-on-command-check":
      return "FIX: a command-backed (test_output) check cannot be waived — either drop the waiver metadata and let it reconcile against the manifest for real, or record it as a session-local (non-command) claim if it genuinely cannot be re-run.";
    case "not-run":
      return "FIX: fold this into a non-command summary (session-local claim, no execution.label), or name the EXACT verbatim manifest command in evidence.execution.label so it reconciles.";
    case "laundering":
      return "FIX: remove the exit-code-laundering operator (||, ; true, ; exit 0, etc.) from the command — a laundered command cannot be trusted to reconcile.";
    case "session-local-failed":
      return "FIX: a disputed/failing claim always blocks reconcile. Document a disjoint pre-existing failure as prose in a WAIVED non-command summary, not as a standalone claim.";
    case "status-misassertion":
      return "FIX: the claim's asserted status does not match what Surface re-derives from the bundle's own evidence/events/policies — re-record evidence so the bundle's own data supports the asserted status; do not hand-edit status.";
    case "status-underivable":
      return "FIX: CI-side status re-derivation failed for this claim — ensure @kontourai/surface is installed/resolvable and the claim's evidence/events are well-formed, then re-record.";
    case "unwaived-session-local":
      return "FIX: this claim asserts pass but has neither a waiver nor a CI-re-derived 'verified' status — add a waiver (--accepted-gap-reason/--waived-by) or resolve it so Surface derives 'verified'.";
    default:
      return "FIX: see the divergence message above for the specific shape defect.";
  }
}

/**
 * Callable core shared by BOTH the `reconcile-preflight` CLI handler and
 * publishDelivery()'s fail-closed gate (#356 Wave 3) — one implementation, not two entry
 * points that could drift. SHAPE-only: never spawns a fresh manifest/CI command (AC5) — the
 * only subprocess calls here are the already-cheap run-baseline.sh --manifest-json static
 * registry emit (inside resolveManifest, reused unchanged from trust-reconcile.js) and the
 * local-only derive-claim-status.mjs re-derivation (no CI command execution either).
 *
 * @param dir artifact/session directory containing trust.bundle
 * @param repoRoot repo root used for manifest resolution + the optional ancestor warning
 * @param manifestOverride optional --manifest JSON string (CLI passthrough)
 */
type TrustReconcileHelper = ReturnType<typeof loadTrustReconcileHelper>;

/**
 * F4 (iteration-1): extracted from runReconcilePreflight so the main function stays under
 * the 50-line guideline. Q3 (optional, non-blocking): warn if the checkpoint's commit_sha is
 * not yet an ancestor of local HEAD — never affects ok/exit code, best-effort only. Already a
 * self-contained try/catch with no effect on the caller's `ok`/`issues`.
 */
function checkpointStalenessWarning(dir: string, repoRoot: string, tr: TrustReconcileHelper): string[] {
  const warnings: string[] = [];
  try {
    const checkpointPath = path.join(dir, "trust.checkpoint.json");
    if (fs.existsSync(checkpointPath)) {
      const checkpoint = loadJson(checkpointPath);
      const commitSha = checkpoint && typeof checkpoint === "object" ? (checkpoint as AnyObj).commit_sha : undefined;
      if (typeof commitSha === "string" && commitSha) {
        let headSha = "";
        try {
          headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        } catch {
          headSha = "";
        }
        if (headSha && !tr.isAncestorCommit(repoRoot, commitSha, headSha)) {
          warnings.push(`NON-BLOCKING: trust.checkpoint.json commit_sha '${commitSha}' is not an ancestor of local HEAD '${headSha}' — the checkpoint may be stale (e.g. after an amend/rebase). Consider re-sealing (seal-checkpoint) before publishing. This is a warning only — see #335 for the full checkpoint-staleness ownership check.`);
        }
      }
    }
  } catch {
    // best-effort only — never affects ok/exit code.
  }
  return warnings;
}

export function runReconcilePreflight(
  dir: string,
  repoRoot: string,
  manifestOverride?: string | null
): { ok: boolean; issues: string[]; warnings: string[] } {
  const bundlePath = path.join(dir, "trust.bundle");
  if (!fs.existsSync(bundlePath)) {
    // A preflight with nothing to check is a usage error, not a soft pass — an agent must
    // never read "no bundle" as "bundle is valid" (see reconcilePreflightCmd for the CLI-side
    // die()). The library entrypoint throws too, since publishDelivery() itself already has
    // its OWN, separate, pre-existing fail-soft branch for bundle-absence (guarded before this
    // function is ever called there) — this function is never invoked without a bundle.
    throw new Error(`reconcile-preflight: no trust.bundle found at ${bundlePath} — nothing to check. This is a usage error, not a soft pass.`);
  }

  const bundle = loadJson(bundlePath);
  const shape = loadReconcileShapeHelper();
  const tr = loadTrustReconcileHelper();

  // Resolve the SAME canonical (fresh-verify) commands CI would fall back to feeding into
  // resolveManifest's legacy tier (tier 5), for genuine parity on that fallback path too —
  // CLI --commands is not a preflight concept, so only the TRUST_RECONCILE_COMMANDS env /
  // package.json trust-reconcile-verify tiers apply locally; a repo with neither and no
  // manifest source resolves to the same empty legacy fallback CI itself would in that case.
  const canonicalCommands = tr.resolveCanonicalCommands({ commands: [] }, repoRoot) ?? [];
  const manifestResolution = tr.resolveManifest({ manifest: manifestOverride ?? null }, repoRoot, canonicalCommands);
  const manifestByCmd = new Map<string, AnyObj>();
  for (const e of manifestResolution.entries) manifestByCmd.set(tr.normalizeCmd(e.command), e);

  const derivedStatus = derivePreflightClaimStatuses(bundlePath, repoRoot);

  const { reconcilable, sessionLocal, noEvidenceCommand, waiverOnCommand } = shape.classifyBundleClaims(bundle);

  const issues: AnyObj[] = [];
  issues.push(...shape.waiverOnCommandIssues(waiverOnCommand));
  issues.push(...shape.noEvidenceCommandIssues(noEvidenceCommand));
  const { issues: manifestIssues } = shape.reconcilableManifestIssues(reconcilable, manifestByCmd);
  issues.push(...manifestIssues);
  // iteration-1 F1: the local preflight explicitly opts into reduced-coverage degradation
  // when re-derivation is unavailable (Surface not installed, spawn failure, etc.) — CI's
  // trust-reconcile.js does NOT opt in and stays fail-closed on the same condition (see
  // reconcile-shape.js's sessionLocalShapeIssues docstring for the full mode contract).
  const { issues: sessionLocalIssues } = shape.sessionLocalShapeIssues(sessionLocal, derivedStatus, { onUnderivable: "reduce" });
  issues.push(...sessionLocalIssues);

  const report = issues.map((i) => `${i.message} — ${preflightFixHint(i.type)}`);
  const warnings = checkpointStalenessWarning(dir, repoRoot, tr);

  return { ok: report.length === 0, issues: report, warnings };
}

/**
 * reconcile-preflight <artifact-dir> [--manifest <json>] [--repo-root <path>]
 *
 * Local, pre-push shape-only check of the session's trust.bundle — reuses
 * scripts/lib/reconcile-shape.js and scripts/ci/trust-reconcile.js's own exported
 * classification/manifest-resolution so this can never silently drift from what CI's
 * Trust Reconcile job enforces. Prints every divergence with the claim id, divergence
 * type, and a human fix instruction; exits 0 with zero issues, 1 otherwise. Never spawns a
 * fresh manifest/CI command re-run (AC5) — resolves the manifest and re-derives status
 * (both local-only, no CI command execution) but never re-runs a manifest command itself.
 *
 * Usage: workflow-sidecar reconcile-preflight <artifactDir> [--manifest <json>] [--repo-root <path>]
 */
async function reconcilePreflightCmd(p: ReturnType<typeof parseArgs>): Promise<number> {
  if (p.flags.has("help") || (!p.positional[0] && !p.opts["help"])) {
    if (p.flags.has("help")) {
      console.log("Usage: workflow-sidecar reconcile-preflight <artifactDir> [--manifest <json>] [--repo-root <path>]");
      console.log("Local, pre-push shape-only check of <artifactDir>/trust.bundle. Exits 0 with no issues, 1 otherwise.");
      return 0;
    }
  }
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const repoRoot = opt(p, "repo-root") ? path.resolve(opt(p, "repo-root")) : findRepoRootFromDirStrict(dir);
  if (!repoRoot) die(`reconcile-preflight: no kits/ ancestor found from ${dir}; pass --repo-root explicitly.`);
  const manifestOverride = p.opts["manifest"]?.at(-1) ?? null;

  const bundlePath = path.join(dir, "trust.bundle");
  if (!fs.existsSync(bundlePath)) {
    die(`reconcile-preflight: no trust.bundle at ${bundlePath} — a preflight with nothing to check is a usage error, not a soft pass. Record evidence first (record-evidence) before running reconcile-preflight.`);
  }

  const result = runReconcilePreflight(dir, repoRoot, manifestOverride);

  for (const w of result.warnings) {
    process.stderr.write(`[reconcile-preflight] ${w}\n`);
  }

  if (result.ok) {
    console.log(`[reconcile-preflight] OK — no shape issues found in ${bundlePath}`);
    return 0;
  }

  process.stderr.write(`[reconcile-preflight] FAILED — ${result.issues.length} shape issue(s) found in ${bundlePath}:\n`);
  for (const issue of result.issues) {
    process.stderr.write(`[reconcile-preflight]   - ${issue}\n`);
  }
  return 1;
}

/**
 * The ONE hard-stop gate (issue #293, ADR 0021 §3): "is my actor the fresh, non-superseded
 * holder of this subject (or is the subject free/self-held)?" Reuses the SAME assignment ⋈
 * liveness join #290/#291 already built (`computeEffectiveState` + `readLocalAssignmentStatus`
 * + `readLivenessEvents`/`freshHolders`) — no second computation is invented here. This is the
 * mirror-image check, at the OTHER end of the session lifecycle, of
 * `enforceEnsureSessionOwnership`'s pre-entry guard above: that guard decides whether entry
 * should claim/supersede/refuse; this gate decides whether PUBLISH should proceed, with a
 * different (new) per-effective-state mapping — the ownership guard's "claim"/"supersede"
 * actions are wrong at publish time, so this is new interpretation of the existing join output,
 * not a new join and not a new `EffectiveState` value (there is no literal `"superseded"` state
 * — a superseded-away actor's own re-check naturally resolves to `held`(holder=successor) or
 * `reclaimable`, never `self_is_holder`; see assignment-provider.ts's `computeEffectiveState`).
 *
 * Effective-state -> publish-decision mapping (the operative spec, from the plan's table).
 * IMPORTANT (bug fix, #397): this gate fences the durable ASSIGNMENT hold, not ambient
 * liveness — liveness is advisory everywhere else in the system, and this is the ONE hard
 * gate, so it must never false-block on liveness alone. A subject with fresh liveness by
 * another actor but NO durable assignment record (`held`, reason
 * `liveness_claim_present_assignment_lagging`) therefore PASSES, not BLOCKs — there is no
 * durable ownership conflict to protect, only ambient presence. This does NOT weaken zombie
 * protection: a superseded zombie always has an assignment record (either its own stale
 * assignment — `reclaimable` — or the successor's assignment-backed `held`/
 * `fresh_liveness_heartbeat`), both of which still BLOCK below.
 *   - `free` (no assignment ever recorded)              -> PASS (never false-block an untracked subject)
 *   - `held`, reason `self_is_holder`                    -> PASS (the caller IS the current holder)
 *   - `held`, reason `liveness_claim_present_assignment_lagging`
 *     (fresh liveness by another actor, NO durable assignment record) -> PASS (liveness alone
 *     is never a durable ownership conflict — see #397 fix note above)
 *   - `held`, reason `fresh_liveness_heartbeat`
 *     (durable assignment held by another actor + fresh liveness)     -> BLOCK (a different
 *     actor durably holds this subject and is demonstrably still live)
 *   - `reclaimable` (assignment present, stale/absent liveness)       -> BLOCK (not proof of
 *     self — safe default blocks; a durable assignment record exists)
 *   - `human-held`                                        -> BLOCK (never publish over a human assignee)
 *   - no resolvable join at all (non-local-file provider
 *     with no --effective-state-json)                    -> `not_evaluated`, PASS (documented scope
 *                                                             boundary, loud stderr note, never a silent block)
 *
 * Actor resolution mirrors `enforceEnsureSessionOwnership` EXACTLY: the bare
 * `resolveActor(env).actor` / branchActorKey string, NEVER `serializeActor(actorStruct)`'s
 * triple — the #291 flat-vs-triple seam. `opts.actorKey` (the CLI's --actor / FLOW_AGENTS_ACTOR
 * override, already sanitized by the caller) takes precedence when provided.
 *
 * Slug/artifactRoot derivation matches `publishDelivery()`'s own `slug =
 * path.basename(path.resolve(dir))` byte-for-byte (both must resolve the SAME assignment
 * record) and the `artifactRoot = path.dirname(dir)` pattern already used elsewhere in this
 * file for a `dir`-only consumer.
 *
 * github provider: read-only precomputed `--effective-state-json` escape hatch, matching
 * `enforceEnsureSessionOwnership`'s existing github branch precedent exactly (render-don't-
 * execute — assignment-provider.ts never calls `gh` directly from this CLI).
 *
 * Every interpolated actor/holder/reason string is sanitized via
 * `stripControlCharsForDisplay(...).slice(0, 64)` — reusing the exact top-level helper, never a
 * second sanitizer (AC7).
 *
 * SECOND CI-blocking false-block fix (this iteration): the hard gate above enforces ONLY for a
 * STABLY-identified actor. A caller's identity is STABLE when it comes from an explicit
 * `opts.actorKey` (a caller that hands in an actor key is asserting a stable identity — e.g. the
 * CLI's --actor / FLOW_AGENTS_ACTOR override, or the github skill's precomputed path), from
 * `FLOW_AGENTS_ACTOR` (`resolveActor` source `"explicit-override"`), or from a runtime-native
 * session id (`resolveActor` source `` `runtime-session-id:${runtime}` ``, e.g. Claude Code's
 * `CLAUDE_CODE_SESSION_ID`). It is UNSTABLE when `resolveActor` falls all the way through to the
 * process-ancestry fallback (source `"process-ancestry"`) or fails to resolve at all (source
 * `"unresolved"` / `isUnresolvedActor(actor)`). This mirrors `enforceEnsureSessionOwnership`'s
 * Design Decision 4 (never hard-fail on actor ambiguity): a session that cannot stably
 * self-identify cannot be meaningfully fenced against a durable assignment record, so hard-
 * blocking it produces exactly the false-block CI hit (no `FLOW_AGENTS_ACTOR`/runtime session id
 * in CI -> ancestry fallback -> a DIFFERENT ancestry-derived actor string than the one that
 * created the claim -> `reclaimable`/not-self -> hard BLOCK of a legitimate self-publish). A
 * real coordination participant always has a stable identity (explicit override or runtime
 * session id), so zombie protection under a stable actor is completely unaffected — this only
 * changes behavior for a caller that was never fenceable in the first place. When the resolved
 * actor identity is UNSTABLE, this function short-circuits to `{ ok: true, effective_state:
 * "not_evaluated", reason: "actor-identity-unstable-advisory-only" }` (holder included, sanitized,
 * when one exists) BEFORE running the assignment ⋈ liveness join at all, with one loud stderr
 * note — the gate degrades to advisory-only rather than ever false-blocking an unstable identity.
 * When the actor identity IS stable, the effective-state -> publish-decision mapping above
 * applies exactly as documented, unchanged.
 */
export function runVerifyHold(
  dir: string,
  repoRoot: string | null,
  opts?: { actorKey?: string; now?: number; assignmentProviderKind?: string; effectiveStateJson?: unknown },
): {
  ok: boolean;
  effective_state: EffectiveState | "not_evaluated";
  holder?: { actor?: string; assignee?: string | null; idle_days?: number | null; last_at?: string };
  reason: string;
  guidance: string[];
} {
  // repoRoot is accepted (not derived) for signature symmetry with runReconcilePreflight(dir,
  // repoRoot, ...) / publishDelivery(dir, repoRoot) — the local-file join below only needs
  // artifactRoot/slug, but a future non-local-file provider branch that resolves a live
  // repo-relative fixture would need it, so the parameter stays part of the public contract.
  void repoRoot;
  const sanitize = (value: unknown): string => stripControlCharsForDisplay(value).slice(0, 64);
  const slug = path.basename(path.resolve(dir));
  const artifactRoot = path.dirname(path.resolve(dir));
  const nowMs = opts?.now ?? Date.now();
  const assignmentProviderKind = opts?.assignmentProviderKind || "local-file";
  const helper = loadActorIdentityHelper();
  // Stability check (SECOND CI-blocking false-block fix, this iteration): an explicitly-provided
  // opts.actorKey is treated as stable outright (the caller is asserting a stable identity — see
  // doc comment above). Otherwise resolve BOTH the actor and its source so we can tell an
  // explicit-override / runtime-session-id actor (stable, enforce as today) apart from a
  // process-ancestry / unresolved one (unstable, advisory-only — never hard-block).
  const resolved = opts?.actorKey ? { actor: opts.actorKey, source: "explicit-override" } : helper.resolveActor(process.env);
  const actorKey = resolved.actor;
  const isStableActor = !!opts?.actorKey
    || resolved.source === "explicit-override"
    || resolved.source.startsWith("runtime-session-id");

  const guidanceLines = (holderActor?: string): string[] => [
    "Re-run pull-work/pickup-probe to discover the current holder of this subject and hand off cleanly (learning-review/handoff) rather than publishing over it.",
    holderActor
      ? `The current holder appears to be ${sanitize(holderActor)} — confirm with them before proceeding.`
      : "Confirm with the assigned human before proceeding.",
    "If a human confirms this session should resume ownership, run `ensure-session --supersede-stale` to explicitly re-claim the subject before retrying publish.",
  ];

  type EffectiveResult = { effective_state: EffectiveState; reason: string; holder?: { actor?: string; assignee?: string | null; idle_days?: number | null; last_at?: string } };
  let effective: EffectiveResult | null = null;

  if (opts?.effectiveStateJson !== undefined) {
    const parsed = opts.effectiveStateJson as AnyObj;
    const candidate = parsed && typeof parsed === "object" ? (parsed.effective as AnyObj | undefined) : undefined;
    const validStates = new Set(["held", "reclaimable", "human-held", "free"]);
    if (candidate && typeof candidate.effective_state === "string" && validStates.has(candidate.effective_state)) {
      effective = candidate as EffectiveResult;
    }
  } else if (assignmentProviderKind === "local-file") {
    // Same call shape as enforceEnsureSessionOwnership's local-file branch — no second
    // freshness/ownership computation is invented (see that function's F1 fix comment for why
    // branchActorKey, not the serialized ActorStruct triple, is the correct selfActor here).
    const assignment = readLocalAssignmentStatus(artifactRoot, slug);
    const events = readLivenessEvents(artifactRoot);
    const freshList = loadLivenessReadHelper().freshHolders(events, slug, actorKey, nowMs);
    effective = computeEffectiveState(assignment, freshList, actorKey, nowMs);
  }

  if (!effective) {
    // Documented scope boundary (Design Constraint): a non-local-file provider with no
    // precomputed --effective-state-json cannot be evaluated in-CLI (render-don't-execute — no
    // live `gh` call from workflow-sidecar.ts). PASS-through, never a silent block, with a loud
    // stderr note — mirroring enforceEnsureSessionOwnership's existing github branch precedent.
    process.stderr.write(`[verify-hold] not evaluated: provider "${sanitize(assignmentProviderKind)}" requires --effective-state-json (or use --assignment-provider local-file)\n`);
    return { ok: true, effective_state: "not_evaluated", reason: "provider_not_evaluated", guidance: [] };
  }

  // F1 fix (fix-plan iteration 1, HIGH): sanitize EVERY untrusted string field of
  // effective.holder before it reaches the returned JSON / NotFreshHolderError.holder — never
  // spread the raw holder and override only the discriminated field. `last_at` (sourced from
  // record.claimed_at or a liveness event's `at`, both attacker-writable in the shared
  // multi-writer liveness/assignment stream) and `actor`/`assignee` are all display strings and
  // go through the SAME `sanitize` helper (stripControlCharsForDisplay(...).slice(0, 64)) as
  // enforceEnsureSessionOwnership's equivalent call sites (AC7 injection-discipline parity).
  // `idle_days` is a `number | null` computed by computeEffectiveState from Date.parse/Math.floor
  // arithmetic (assignment-provider.ts) — never an attacker-controlled string — so it is passed
  // through as-is, but defensively re-coerced with `typeof === "number"` so a future shape change
  // upstream can never smuggle a string through this field.
  const sanitizeHolder = (
    holder: { actor?: string; assignee?: string | null; idle_days?: number | null; last_at?: string } | undefined,
  ): { actor?: string; assignee?: string | null; idle_days?: number | null; last_at?: string } | undefined => {
    if (!holder) return undefined;
    return {
      actor: holder.actor ? sanitize(holder.actor) : undefined,
      assignee: holder.assignee ? sanitize(holder.assignee) : holder.assignee,
      idle_days: typeof holder.idle_days === "number" ? holder.idle_days : undefined,
      last_at: holder.last_at ? sanitize(holder.last_at) : undefined,
    };
  };

  // SECOND CI-blocking false-block fix (this iteration): an actor identity that cannot stably
  // self-identify (process-ancestry fallback or unresolved) cannot be meaningfully fenced against
  // a durable assignment record — hard-blocking it is exactly the CI false-block this fix targets
  // (see doc comment above). Degrade to advisory-only: never hard-block, regardless of what the
  // join above computed. This check runs AFTER the join so an existing holder (if any) can still
  // be surfaced for visibility, but strictly BEFORE the effective-state switch below so no
  // unstable-actor request can ever reach a `case` that returns `ok: false`.
  if (!isStableActor) {
    process.stderr.write(
      "[verify-hold] actor identity is ancestry-derived/unresolved — gate is advisory only for unstable identities; not hard-blocking publish\n"
    );
    return {
      ok: true,
      effective_state: "not_evaluated",
      reason: "actor-identity-unstable-advisory-only",
      guidance: [],
      ...(effective.holder ? { holder: sanitizeHolder(effective.holder) } : {}),
    };
  }

  switch (effective.effective_state) {
    case "free":
      return { ok: true, effective_state: "free", reason: effective.reason, guidance: [] };
    case "held": {
      const isSelf = effective.reason === "self_is_holder" || (!!effective.holder?.actor && effective.holder.actor === actorKey);
      if (isSelf) return { ok: true, effective_state: "held", holder: sanitizeHolder(effective.holder), reason: effective.reason, guidance: [] };
      // Bug fix (#397): `liveness_claim_present_assignment_lagging` means computeEffectiveState
      // found NO durable assignment record at all — only ambient liveness by another actor
      // (assignment-provider.ts's `if (!isAssigned) { if (freshHoldersList.length > 0) return
      // held/liveness_claim_present_assignment_lagging }`). Liveness alone is advisory
      // everywhere else in this system; this ONE hard gate must fence the durable ASSIGNMENT
      // hold, not ambient presence, so this case PASSES rather than false-blocking. Every other
      // `held` reason (`fresh_liveness_heartbeat`) is reached only when an assignment record
      // DOES exist (assignment-provider.ts's `isAssigned` branch) and the recorded holder is
      // still fresh-live — a genuine durable-ownership conflict, which still BLOCKs below.
      if (effective.reason === "liveness_claim_present_assignment_lagging") {
        return { ok: true, effective_state: "held", holder: sanitizeHolder(effective.holder), reason: effective.reason, guidance: [] };
      }
      const holderActor = effective.holder?.actor;
      return {
        ok: false,
        effective_state: "held",
        holder: sanitizeHolder(effective.holder),
        reason: `subject ${sanitize(slug)} is currently held by a different, still-live actor (${sanitize(holderActor ?? "unknown")})`,
        guidance: guidanceLines(holderActor),
      };
    }
    case "reclaimable": {
      // Stop-short risk (plan): reclaimable is NEVER treated as PASS. A lapsed self-claim looks
      // reclaimable, not self_is_holder, to a woken zombie's own re-check — the safe default
      // blocks and asks for reconcile guidance rather than auto-passing a stale self-claim.
      const holderActor = effective.holder?.actor;
      return {
        ok: false,
        effective_state: "reclaimable",
        holder: sanitizeHolder(effective.holder),
        reason: `subject ${sanitize(slug)}'s existing claim (held by ${sanitize(holderActor ?? "unknown")}) is stale/unverified as self — not a confirmed fresh hold`,
        guidance: guidanceLines(holderActor),
      };
    }
    case "human-held": {
      const assignee = effective.holder?.assignee;
      return {
        ok: false,
        effective_state: "human-held",
        holder: sanitizeHolder(effective.holder),
        reason: `subject ${sanitize(slug)} is assigned to ${assignee ? sanitize(assignee) : "an assigned human"} — never publish over a human assignment without confirmation`,
        guidance: guidanceLines(undefined),
      };
    }
    default:
      return { ok: true, effective_state: "not_evaluated", reason: "unrecognized_effective_state", guidance: [] };
  }
}

/**
 * verify-hold <artifact-dir> [--actor <key>] [--now <iso>] [--assignment-provider <kind>]
 *   [--effective-state-json <path|->]
 *
 * CLI surface for runVerifyHold() (issue #293). Prints `{ role: "VerifyHoldResult", ... }` JSON
 * and exits 0 when `ok` (including `not_evaluated` — a documented scope boundary is never a
 * failure exit), 1 otherwise. NEVER throws at the CLI boundary — matches
 * `reconcilePreflightCmd`'s existing convention of printing then exiting rather than throwing;
 * the thrown `NotFreshHolderError` variant is reserved for the LIBRARY call inside
 * `publishDelivery()`.
 *
 * Usage: workflow-sidecar verify-hold <artifactDir> [--actor <key>] [--now <iso>]
 *   [--assignment-provider <kind>] [--effective-state-json <path|->]
 */
async function verifyHoldCmd(p: ReturnType<typeof parseArgs>): Promise<number> {
  if (p.flags.has("help") || (!p.positional[0] && !p.opts["help"])) {
    if (p.flags.has("help")) {
      console.log("Usage: workflow-sidecar verify-hold <artifactDir> [--actor <key>] [--now <iso>] [--assignment-provider <kind>] [--effective-state-json <path|->]");
      console.log("Checks whether the calling actor is the fresh, non-superseded holder of <artifactDir>'s subject. Exits 0 if ok (including not_evaluated), 1 otherwise.");
      return 0;
    }
  }
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const repoRoot = opt(p, "repo-root") ? path.resolve(opt(p, "repo-root")) : findRepoRootFromDirStrict(dir);
  // SECOND CI-blocking false-block fix (this iteration): only pass an explicit actorKey through
  // to runVerifyHold when the CALLER explicitly passed --actor — that is the one case where an
  // actorKey should be treated as an asserted-stable identity (see runVerifyHold's doc comment).
  // When --actor is omitted, actorKey is left undefined so runVerifyHold performs its OWN
  // resolveActor(process.env) call internally and can see the real `source` (explicit-override /
  // runtime-session-id / process-ancestry / unresolved) to decide stability — calling
  // resolveReadActorKey(p) here first would discard that source and wrongly force every ambient
  // resolution (including an ancestry fallback) to be treated as an explicit/stable actorKey.
  const actorKey = opt(p, "actor") ? loadActorIdentityHelper().sanitizeSegment(opt(p, "actor")) : undefined;
  const nowMs = opt(p, "now") ? Date.parse(opt(p, "now")) : undefined;
  const assignmentProviderKind = opt(p, "assignment-provider", "local-file");
  const effectiveStateJsonFlag = opt(p, "effective-state-json");
  const effectiveStateJson = effectiveStateJsonFlag ? loadJsonInputFile(effectiveStateJsonFlag) : undefined;

  const result = runVerifyHold(dir, repoRoot, { actorKey, now: nowMs, assignmentProviderKind, effectiveStateJson });
  printJson({ role: "VerifyHoldResult", ...result });
  return result.ok ? 0 : 1;
}

// ─── Publish Delivery Bundle ──────────────────────────────────────────────────
// Copies the session's trust.bundle (+ checkpoint companions) from the gitignored
// session artifact dir (.kontourai/flow-agents/<slug>/) to the committed delivery/ transport
// path so the CI trust-reconcile job can reconcile it against fresh CI results.
//
// Fail-soft: if trust.bundle is absent (no evidence recorded yet), does nothing.
// Idempotent: overwrites on re-delivery.
// Called automatically from recordRelease and advanceState→delivered (best-effort).
// Also exposed as the `publish-delivery <artifact-dir>` subcommand for explicit use.

/**
 * #379 supersede-on-publish cleanup: keep delivery/ bounded by pruning inherited PER-SESSION
 * seal dirs (the growth vector), scoped to avoid any cross-PR conflict.
 *
 * An inherited per-session seal dir (`delivery/<other-slug>/`) is UNIQUELY named, so pruning
 * it can never conflict with a concurrent PR: two branches deleting the same inherited dir is
 * a delete/delete (auto-merges), and each new delivery adds its OWN distinct
 * `delivery/<slug>/`. And it is HARMLESS to leave: trust-reconcile.js's prefer-newest
 * ownership selection always picks THIS session's fresher bundle over an older inherited one.
 * Pruning is therefore purely to stop unbounded accumulation of permanently-superseded dirs.
 *
 * The SHARED FLAT path (`delivery/trust.bundle` + checkpoints) is deliberately NOT pruned
 * here. During the migration window other concurrent PRs may still seal to the flat path;
 * deleting it would produce a modify/delete conflict → a DIRTY PR → the no-CI failure this
 * whole change fixes. The flat path is a single fixed location (not a growth vector) and the
 * reconciler treats a stale flat bundle as non-owning / older-owning, so leaving it is safe.
 * Removing the flat legacy seals is a one-time cleanup for a dedicated PR once no open PR
 * still seals to it — intentionally NOT bundled into every delivery.
 *
 * Best-effort: a prune failure is logged, never fatal to the delivery. Never touches
 * README.md, DECLARED, the flat seal files, or any subdir that is not itself a seal dir.
 */
function pruneSupersededSeals(deliveryDir: string, keepSlug: string): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(deliveryDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepSlug) continue;
    const subdir = path.join(deliveryDir, entry.name);
    // Only prune dirs that actually look like a seal dir (contain a trust.bundle or
    // trust.checkpoint.json) — never an unrelated directory a human placed under delivery/.
    const looksLikeSeal =
      fs.existsSync(path.join(subdir, "trust.bundle")) ||
      fs.existsSync(path.join(subdir, "trust.checkpoint.json"));
    if (!looksLikeSeal) continue;
    try {
      fs.rmSync(subdir, { recursive: true, force: true });
      process.stderr.write(`[publish-delivery] #379: pruned superseded per-session seal delivery/${entry.name}/ (older-owning/stale; the reconciler selects the newest bundle regardless)\n`);
    } catch (err) {
      process.stderr.write(`[publish-delivery] #379: could not prune per-session seal delivery/${entry.name}/ (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

/**
 * Publish the session's trust artifacts to the committed delivery/ path.
 *
 * #379: writes to a PER-SESSION path `<repoRoot>/delivery/<slug>/` (slug = the session
 * artifact dir's basename) rather than the shared flat `delivery/`. A shared path guarantees
 * a git conflict between ANY two concurrent deliveries, and a conflicting (DIRTY) PR gets NO
 * pull_request workflows — the required Trust Reconcile check silently never runs (field
 * incidents #330/#358/#378). Per-session paths make concurrent deliveries write DISTINCT
 * files that never contend. trust-reconcile.js reads both the flat (back-compat) and
 * per-session layouts via resolveDeliveryCandidates() and selects the owning candidate by
 * commit ancestry.
 *
 * Copies trust.bundle, trust.checkpoint.json, and (if present)
 * trust.checkpoint.intoto.json / trust.checkpoint.sig.json / trust.checkpoint.attestation.json
 * from the session artifact dir to <repoRoot>/delivery/<slug>/.
 *
 * Fail-soft on a missing bundle: if trust.bundle is absent, returns without throwing.
 * Fail-CLOSED on repo-root resolution: repoRoot must be a real, resolved kits/ ancestor
 * (see findRepoRootFromDirStrict) — null (no ancestor found) skips the publish with a
 * visible warning instead of writing to whatever process.cwd() happens to be. This
 * prevents a scratch/test session dir (no kits/ ancestor) from silently clobbering an
 * unrelated real repo's delivery/ seal when invoked with that repo as cwd (see
 * evals/integration/test_checkpoint_signing.sh TEST 2 and the WS5 session findings at
 * .kontourai/flow-agents/ws5-governance-kit-slice1 for the root cause this fixes).
 * Idempotent: overwrites on re-delivery to the same slug.
 *
 * #356 Wave 3 (AC6): Fail-CLOSED on bundle SHAPE. After the fail-soft absence guard below,
 * runs the SAME reconcile-preflight shape check (runReconcilePreflight) the
 * `reconcile-preflight` CLI subcommand exposes, BEFORE copying anything into delivery/. A
 * shape-invalid bundle throws InvalidBundleShapeError (a distinct, identifiable error — see
 * its own doc comment) rather than silently publishing a bundle CI's Trust Reconcile job
 * would reject anyway. This is intentionally a NEW, additive fail-closed branch — it must
 * never be conflated with the pre-existing fail-soft absence/repo-root branches above/below,
 * which stay exactly as before (see each publishDelivery call site's catch handler for how
 * the distinction is preserved end-to-end).
 *
 * #293 (SECOND, DISTINCT fail-closed gate): immediately after the shape check above and BEFORE
 * writing anything into delivery/, runs `runVerifyHold()` — the assignment ⋈ liveness join
 * asking "is the calling actor the fresh, non-superseded holder of this subject (or is it
 * free/self-held)?" A not-fresh-holder result throws `NotFreshHolderError` (distinct from
 * `InvalidBundleShapeError` — a different `code`, a different failure mode: actor hold vs
 * bundle shape). There are now THREE tiers here, and they must never be conflated in prose or
 * in a call site's catch handler: (1) fail-SOFT bundle absence / repo-root resolution (silent
 * no-op / visible warning, unchanged from before #356), (2) fail-CLOSED bundle shape (#356,
 * `InvalidBundleShapeError`), (3) fail-CLOSED verify-hold (#293, `NotFreshHolderError`). The
 * shape check runs first (per the plan's ordering) — a bundle that is BOTH shape-invalid and
 * not-held throws `InvalidBundleShapeError` specifically, never `NotFreshHolderError`.
 */
export async function publishDelivery(dir: string, repoRoot: string | null): Promise<void> {
  const bundleSrc = path.join(dir, "trust.bundle");
  if (!fs.existsSync(bundleSrc)) return; // no bundle — skip gracefully

  if (!repoRoot) {
    process.stderr.write(`[publish-delivery] WARNING: no kits/ ancestor found from ${dir}; skipping publish. Refusing to fall back to process.cwd() to avoid clobbering an unrelated repo's delivery/ seal. Pass --repo-root explicitly if this session dir is intentionally outside a repo checkout.\n`);
    return;
  }

  // #356 AC6: fail-CLOSED on shape-invalidity — runs AFTER the fail-soft absence/repo-root
  // guards above (both preserved unchanged) and BEFORE any copy into delivery/. Throws
  // InvalidBundleShapeError (never a generic Error) so every call site can positively
  // distinguish this from the failure modes they already tolerate as best-effort.
  const preflight = runReconcilePreflight(dir, repoRoot);
  if (!preflight.ok) {
    process.stderr.write(`[publish-delivery] REFUSING to publish — trust.bundle failed the reconcile-preflight shape check (${preflight.issues.length} issue(s)):\n`);
    for (const issue of preflight.issues) {
      process.stderr.write(`[publish-delivery]   - ${issue}\n`);
    }
    throw new InvalidBundleShapeError(preflight.issues);
  }

  // #293: SECOND, DISTINCT fail-closed gate — runs after the shape check above and before any
  // copy into delivery/. Throws NotFreshHolderError (never conflated with InvalidBundleShapeError)
  // so every call site can positively distinguish "not the fresh holder" from "bundle shape
  // invalid".
  const holdCheck = runVerifyHold(dir, repoRoot);
  if (!holdCheck.ok) {
    process.stderr.write(`[publish-delivery] REFUSING to publish — verify-hold gate: ${holdCheck.reason}\n`);
    for (const line of holdCheck.guidance) process.stderr.write(`[publish-delivery]   - ${line}\n`);
    throw new NotFreshHolderError(holdCheck);
  }

  const deliveryDir = path.join(repoRoot, "delivery");
  // #379: slug is the session artifact dir's basename — the same human-meaningful id used
  // throughout the session (.kontourai/flow-agents/<slug>/). The per-session dir NAME is only
  // a collision-avoidance handle; ownership is decided by commit ancestry, not by name.
  const slug = path.basename(path.resolve(dir));
  const sessionDeliveryDir = path.join(deliveryDir, slug);

  fs.mkdirSync(deliveryDir, { recursive: true });
  // Supersede inherited/flat seals BEFORE writing this session's dir (keepSlug = our own).
  pruneSupersededSeals(deliveryDir, slug);
  fs.mkdirSync(sessionDeliveryDir, { recursive: true });

  // Required: trust.bundle (the CI anchor)
  fs.copyFileSync(bundleSrc, path.join(sessionDeliveryDir, "trust.bundle"));

  // Optional companions: checkpoint + signing artifacts
  const companions = [
    "trust.checkpoint.json",
    "trust.checkpoint.intoto.json",
    "trust.checkpoint.sig.json",
    "trust.checkpoint.attestation.json",
  ];
  for (const filename of companions) {
    const src = path.join(dir, filename);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(sessionDeliveryDir, filename));
    }
  }

  process.stderr.write(`[publish-delivery] published trust.bundle and companions to ${sessionDeliveryDir} (per-session path, #379)\n`);
}

/**
 * publish-delivery <artifact-dir> [--repo-root <path>]
 *
 * Explicit publish of the session trust bundle to the committed delivery/ path.
 * Equivalent to the publish that fires automatically at record-release /
 * advance-state to delivered. Useful for the deliver skill or a human to
 * publish explicitly.
 *
 * Usage: workflow-sidecar publish-delivery <artifactDir> [--repo-root <path>]
 */
async function publishDeliveryCmd(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  // Fail-closed: an explicit --repo-root always wins; otherwise resolve strictly (no
  // process.cwd() fallback) so a scratch/test artifact dir cannot accidentally publish
  // into whichever repo happens to be the current working directory.
  const repoRoot = opt(p, "repo-root") || findRepoRootFromDirStrict(dir);
  await publishDelivery(dir, repoRoot);
  return 0;
}

export function validateLearningCorrection(record: AnyObj): void {
  const correction = record.correction;
  if (correction === undefined) return;
  if (!correction || typeof correction !== "object" || Array.isArray(correction)) die("correction must be an object");
  if (typeof correction.needed !== "boolean") die("correction.needed must be boolean");
  if (correction.needed === false) {
    if (typeof correction.evidence !== "string" || correction.evidence.length === 0) die("correction.evidence is required when correction.needed is false");
    return;
  }
  for (const key of ["type", "recurrence_key", "intended_behavior", "observed_behavior", "gap"]) {
    if (typeof correction[key] !== "string" || correction[key].length === 0) die(`correction.${key} is required when correction.needed is true`);
  }
  if (!["workflow", "skill", "agent", "tooling", "test", "doc", "process", "product", "provider", "none"].includes(correction.type)) {
    die("correction.type must be one of: workflow, skill, agent, tooling, test, doc, process, product, provider, none");
  }
  const prevention = correction.prevention;
  if (prevention !== undefined) validateLearningPrevention(prevention);
  const hasPrevention = prevention !== undefined;
  const hasNoChange = typeof correction.no_change_rationale === "string" && correction.no_change_rationale.length > 0;
  if (!hasPrevention && !hasNoChange) die("correction requires prevention route or no_change_rationale when correction.needed is true");
}
function validateLearningPrevention(prevention: unknown): void {
  if (!prevention || typeof prevention !== "object" || Array.isArray(prevention)) die("correction.prevention must be an object");
  const value = prevention as AnyObj;
  if (typeof value.target !== "string" || value.target.length === 0) die("correction.prevention.target is required");
  if (!["rule", "skill", "power", "agent", "eval", "doc", "backlog", "knowledge", "none"].includes(value.target)) die("correction.prevention.target must be one of: rule, skill, power, agent, eval, doc, backlog, knowledge, none");
  if (typeof value.action !== "string" || value.action.length === 0) die("correction.prevention.action is required");
  if (typeof value.status !== "string" || value.status.length === 0) die("correction.prevention.status is required");
  if (!["open", "completed", "accepted", "deferred", "rejected"].includes(value.status)) die("correction.prevention.status must be one of: open, completed, accepted, deferred, rejected");
}
export function normalizeLearning(raw: AnyObj, timestamp: string): AnyObj {
  if (!Array.isArray(raw.source_refs)) die("source_refs must be an array");
  if (!Array.isArray(raw.facts)) die("facts must be an array");
  if (!Array.isArray(raw.routing)) die("routing must be an array");
  if (!["success", "failure", "mixed", "unknown"].includes(raw.outcome)) die("learning outcome must be one of: success, failure, mixed, unknown");
  validateLearningCorrection(raw);
  return { recorded_at: timestamp, ...raw };
}
async function recordLearning(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const timestamp = opt(p, "timestamp", now());
  const records = opts(p, "record-json").map((v) => normalizeLearning(parseJson(v, "--record-json"), timestamp));
  const status = opt(p, "status", "learned");
  if (status === "learned" && records.some((r) => r.routing.some((x: AnyObj) => x.status === "open"))) die("learning status learned cannot have open routing");
  if (status === "learned" && records.some((r) => r.correction === undefined)) die("learning status learned requires every record to include correction.needed");
  writeJson(path.join(dir, "learning.json"), { ...sidecarBase(slug), status, updated_at: timestamp, records });
  writeState(dir, slug, "accepted", "learning", timestamp, opt(p, "summary"));
  // Phase 4c: build bundle from raw inputs; read checks/critiques from trust.bundle (bespoke sidecars no longer written).
  // #268/#344: declared builder.* claims survive the round-trip via their authoritative origin stamp.
  const _learningChecks: AnyObj[] = checksFromBundle(dir);
  const _learningCriteria: AnyObj[] = Array.isArray(loadJson(path.join(dir, "acceptance.json")).criteria) ? loadJson(path.join(dir, "acceptance.json")).criteria : [];
  const _learningCritiques: AnyObj[] = critiquesFromBundle(dir);
  assertBundleWritten(await writeTrustBundle(dir, slug, timestamp, _learningChecks, _learningCriteria, _learningCritiques));
  return 0;
}
function evidenceClean(dir: string): boolean {
  // Phase 4c: read from trust.bundle (sole verification artifact); fall back to evidence.json for
  // legacy (pre-bundle-era) sessions that never wrote a trust.bundle at all — unrelated to origin
  // stamping. When a trust.bundle IS present, every claim must be stamped (requireStampedClaim);
  // there is no claimType-derivation fallback for an unstamped claim (#268/#344).
  const bundle = loadJson(path.join(dir, "trust.bundle"));
  if (Array.isArray(bundle.claims)) {
    for (const c of bundle.claims) requireStampedClaim(c, dir);
    const checkClaims = (bundle.claims as AnyObj[]).filter((c: AnyObj) => c && claimOrigin(c) === "check");
    if (checkClaims.length === 0) return false;
    return checkClaims.every((c: AnyObj) => {
      const v = String(c.value || "");
      return v === "pass" || v === "skip";
    });
  }
  // Legacy fallback: evidence.json (pre-bundle-era sessions with no trust.bundle at all)
  const e = loadJson(path.join(dir, "evidence.json"), {});
  return e.verdict === "pass" && Array.isArray(e.checks) && e.checks.length > 0 && e.checks.every((c: AnyObj) => {
    if (!(c.status === "pass" || c.status === "skip")) return false;
    return !Array.isArray(c.standard_refs) || c.standard_refs.every((r: AnyObj) => ["junit", "sarif", "coverage", "veritas"].includes(r.standard));
  });
}
function critiqueClean(dir: string): boolean {
  // Phase 4c: read from trust.bundle (sole verification artifact); fall back to critique.json for
  // legacy (pre-bundle-era) sessions — unrelated to origin stamping. When a trust.bundle IS
  // present, every claim must be stamped (requireStampedClaim); no claimType-derivation fallback
  // for an unstamped claim (#268/#344).
  const bundle = loadJson(path.join(dir, "trust.bundle"));
  if (Array.isArray(bundle.claims)) {
    for (const c of bundle.claims) requireStampedClaim(c, dir);
    const critiqueClaims = (bundle.claims as AnyObj[]).filter((c: AnyObj) => {
      if (!c) return false;
      // #267/#282: superseded history is not evaluated for cleanliness.
      if (c.metadata && typeof c.metadata === "object" && (c.metadata as AnyObj).superseded_by) return false;
      return claimOrigin(c) === "critique";
    });
    if (critiqueClaims.length === 0) return false; // no critique written yet
    return critiqueClaims.every((c: AnyObj) => {
      const v = String(c.value || "");
      return v !== "fail" && c.status !== "disputed" && c.status !== "rejected";
    });
  }
  // Legacy fallback: critique.json
  const c = loadJson(path.join(dir, "critique.json"), {});
  return c.status === "pass" && Array.isArray(c.critiques) && c.critiques.every((x: AnyObj) => x.verdict !== "fail" && (!Array.isArray(x.findings) || x.findings.every((f: AnyObj) => f.status !== "open" && (f.file_refs === undefined || Array.isArray(f.file_refs)))));
}
function assertExistingLearningValid(dir: string): void {
  const file = path.join(dir, "learning.json");
  if (!fs.existsSync(file)) return;
  const data = loadJson(file);
  if (!Array.isArray(data.records)) die("learning records must be an array");
  for (const record of data.records) {
    if (!Array.isArray(record.source_refs)) die("source_refs must be an array");
    if (!Array.isArray(record.facts)) die("facts must be an array");
    if (!Array.isArray(record.routing)) die("routing must be an array");
    validateLearningCorrection(record);
    if (data.status === "learned" && record.correction === undefined) die("learning status learned requires every record to include correction.needed");
  }
}
async function dogfoodPass(p: ReturnType<typeof parseArgs>): Promise<number> {
  const root = opt(p, "artifact-root") ? path.resolve(opt(p, "artifact-root")) : defaultArtifactRootForRead();
  const dir = path.resolve(opt(p, "artifact-dir") || currentDir(root) || "");
  requireArtifactDirUnderRoot(dir, root);
  assertExistingLearningValid(dir);
  const verdict = opt(p, "verdict");
  if (verdict === "pass") {
    const checks = opts(p, "check-json").map((v) => normalizeCheck(parseJson(v, "--check-json")));
    if (checks.some((c) => c.status !== "pass" && c.status !== "skip")) die("clean evidence requires all non-skipped checks to pass");
    // Phase 4c: evidence check reads from trust.bundle (sole verification artifact); legacy evidence.json fallback in evidenceClean.
    // #268/#344: builder.* check/critique claims count as clean evidence via their authoritative origin stamp.
    const _hasBundleEvidence = fs.existsSync(path.join(dir, "trust.bundle")) && evidenceClean(dir);
    const _hasLegacyEvidence = fs.existsSync(path.join(dir, "evidence.json")) && evidenceClean(dir);
    if (!_hasBundleEvidence && !_hasLegacyEvidence && fs.existsSync(path.join(dir, "trust.bundle"))) die("cannot mark clean without passing evidence");
    if (!_hasBundleEvidence && !_hasLegacyEvidence && !fs.existsSync(path.join(dir, "trust.bundle")) && fs.existsSync(path.join(dir, "evidence.json"))) die("cannot mark clean without passing evidence");
    if (!_hasBundleEvidence && !_hasLegacyEvidence && !fs.existsSync(path.join(dir, "trust.bundle")) && !fs.existsSync(path.join(dir, "evidence.json")) && checks.length === 0) die("cannot mark clean without passing evidence");
    if (p.flags.has("require-critique") || opt(p, "release-decision")) {
      const newCritiqueVerdict = opt(p, "critique-verdict", "pass");
      for (const value of opts(p, "finding-json")) normalizeFinding(parseJson(value, "--finding-json"));
      if (newCritiqueVerdict !== "pass") die(opt(p, "release-decision") ? "requires clean critique" : "requires clean critique before recording pass evidence");
      if (!opt(p, "critique-id") && !critiqueClean(dir)) die("requires passing critique");
      // Phase 4c: if existing state has a dirty critique (in bundle or legacy critique.json), block even when adding a new critique-id.
      if (!critiqueClean(dir) && (fs.existsSync(path.join(dir, "trust.bundle")) || fs.existsSync(path.join(dir, "critique.json")))) die(opt(p, "release-decision") ? "requires clean critique" : "requires clean critique before recording pass evidence");
    }
  }
  const learningRecords = opts(p, "learning-record-json").map((v) => normalizeLearning(parseJson(v, "--learning-record-json"), opt(p, "timestamp", now())));
  if (opt(p, "learning-status") === "learned" && learningRecords.some((r) => r.routing.some((x: AnyObj) => x.status === "open"))) die("learned status cannot have open learning routing");
  if (opt(p, "learning-status") === "learned" && learningRecords.some((r) => r.correction === undefined)) die("learned status requires every learning record to include correction.needed");
  if (opts(p, "check-json").length) await recordEvidence({ ...p, positional: [dir], opts: { ...p.opts, verdict: [verdict] }, flags: p.flags });
  if (p.flags.has("require-critique") && opt(p, "critique-id")) await recordCritique({ ...p, positional: [dir], opts: { ...p.opts, id: [opt(p, "critique-id")], verdict: [opt(p, "critique-verdict", "pass")], summary: [opt(p, "critique-summary", opt(p, "summary"))] }, flags: p.flags });
  if (learningRecords.length) await recordLearning({ ...p, positional: [dir], opts: { ...p.opts, status: [opt(p, "learning-status", "learned")], "record-json": opts(p, "learning-record-json"), summary: [opt(p, "learning-summary", opt(p, "summary"))] }, flags: p.flags });
  if (opt(p, "release-decision")) {
    recordRelease({ ...p, positional: [dir], opts: { ...p.opts, decision: [opt(p, "release-decision")], scope: [opt(p, "release-scope")], summary: [opt(p, "release-summary", opt(p, "summary"))], "gate-json": ['{"name":"merge","status":"pass","summary":"Dogfood release gate passed."}'], "evidence-ref": ["evidence.json"], "docs-json": [`{"status":"updated","summary":"Docs updated.","refs":["${opt(p, "release-doc-ref", "docs/workflow-usage-guide.md")}"]}`] }, flags: p.flags });
    printJson({ release_decision: opt(p, "release-decision") });
    return 0;
  }
  const stateStatus = verdict === "pass" ? "verified" : verdict === "fail" ? "failed" : "not_verified";
  const handoff = loadJson(path.join(dir, "handoff.json"));
  if (verdict === "fail") {
    handoff.blockers = ["Required dogfood critique is not passing"];
    writeJson(path.join(dir, "handoff.json"), handoff);
  }
  writeState(dir, taskSlugFor(dir, opt(p, "task-slug")), stateStatus, "verification", opt(p, "timestamp", now()), opt(p, "summary"), verdict === "pass" ? "continue" : "blocked");
  // Phase 4c: bundle was already written by recordEvidence/recordCritique above (if called).
  // If neither ran (e.g. verdict=fail with no check-json), re-build from bundle (no bespoke sidecars).
  printJson({ state_status: stateStatus });
  return 0;
}

// ─── Gate Review — Canonical InquiryRecord output ────────────────────────────
// Reads trust.bundle + gate block signal, classifies gate fires/misses (as
// correct / false_block / missed_block), and emits gate-review.inquiries.json
// as an array of canonical Surface InquiryRecords. ADVISORY ONLY — #119.
// Never modifies scripts/hooks/. Consumes Surface.resolveInquiry; no fork.

/** Shape of a claim from the trust.bundle */
export interface TrustClaim {
  id: string;
  subjectType: string;
  subjectId: string;
  facet?: string;
  claimType: string;
  fieldOrBehavior: string;
  value: string;
  createdAt: string;
  updatedAt: string;
  status: "verified" | "disputed" | "assumed" | "proposed" | "rejected" | "stale" | "unknown";
}

/** Shape of the trust.bundle file */
export interface BundleFile {
  schemaVersion: number;
  source: string;
  claims: TrustClaim[];
  evidence: AnyObj[];
  events: AnyObj[];
  policies: AnyObj[];
}

/** The gate block signal read from .kontourai/flow-agents/.goal-fit-block-streak.json */
export interface GateBlockSignal {
  /** True when the streak file exists AND count >= 1 */
  blocked: boolean;
  /** The hash from the streak file (for rationale citation) */
  hash: string | null;
  /** The consecutive block count */
  count: number;
}

/**
 * The gate-review calibration verdict, stored in InquiryRecord.answer.value.
 * This is gate-review's value-add over the canonical InquiryRecord outcome.
 */
export type GateCalibration = "correct" | "false_block" | "missed_block";

/**
 * Read the gate block signal from .kontourai/flow-agents/.goal-fit-block-streak.json
 * (written by scripts/hooks/stop-goal-fit.js when block mode fires).
 * The file sits at <artifact-root>/.goal-fit-block-streak.json — one level
 * above the session artifact dir. Fail-open: returns { blocked: false } when
 * the file is absent or unreadable.
 *
 * @param artifactRoot  The runtime artifact root dir (parent of session slug dir).
 */
export function readGateBlockSignal(artifactRoot: string): GateBlockSignal {
  const streakFile = path.join(artifactRoot, ".goal-fit-block-streak.json");
  try {
    if (!fs.existsSync(streakFile)) return { blocked: false, hash: null, count: 0 };
    const raw = JSON.parse(fs.readFileSync(streakFile, "utf8"));
    const count = Number(raw?.count ?? 0);
    const hash = typeof raw?.hash === "string" ? raw.hash : null;
    return { blocked: count >= 1, hash, count };
  } catch {
    return { blocked: false, hash: null, count: 0 };
  }
}

/**
 * Derive the gate-review calibration from a resolved InquiryRecord and the
 * block signal.  Pure function — no I/O.
 *
 * Mapping (mirrors SKILL.md Bundle-Claim to Classification table):
 *   outcome="matched", status="disputed"|"rejected", blocked=true  → correct
 *   outcome="matched", status="verified"|"assumed",  blocked=true  → false_block
 *   outcome="matched", status="assumed",             blocked=true  → false_block
 *   outcome="matched", status="stale"|"unknown",     blocked=false → missed_block
 *   outcome="matched", status="proposed",            any          → missed_block
 *   outcome="unsupported" (absent claim),            any          → missed_block
 *   outcome="derived",   satisfied=true,             any          → correct/false_block by blocked flag
 *   fallthrough                                                    → missed_block
 */
export function deriveGateCalibration(
  outcome: "matched" | "derived" | "unsupported",
  answerStatus: string | undefined,
  blocked: boolean,
): GateCalibration {
  if (outcome === "unsupported") return "missed_block";
  if (outcome === "matched" || outcome === "derived") {
    const s = answerStatus ?? "unknown";
    if (blocked) {
      if (s === "disputed" || s === "rejected") return "correct";
      if (s === "verified" || s === "assumed") return "false_block";
      // stale/unknown/proposed while blocked — gate fired without solid evidence
      return "false_block";
    } else {
      // Not blocked
      if (s === "stale" || s === "unknown" || s === "proposed") return "missed_block";
      // verified/assumed and no block — correct (no block warranted, none issued)
      return "correct";
    }
  }
  return "missed_block";
}

/**
 * Compose the advisory proposed-fix string for a gate-review finding.
 * Pure function — no I/O.
 */
export function gateAdvisoryFix(
  calibration: GateCalibration,
  claimId: string,
  answerStatus: string | undefined,
): string {
  const s = answerStatus ?? "unknown";
  if (calibration === "correct") {
    return `No gate change needed — block was warranted. Resolve the failure in claim \`${claimId}\` (status: \`${s}\`) and re-run gate-review to confirm the gate clears.`;
  }
  if (calibration === "false_block") {
    return `Investigate why the gate blocked when claim \`${claimId}\` has status \`${s}\`. Check whether stop-goal-fit evaluated a stale bundle snapshot or whether the block trigger was unrelated to bundle claims. If the block was spurious, add a freshness check to the gate evaluation loop.`;
  }
  // missed_block
  if (s === "stale") {
    return `Refresh the stale claim \`${claimId}\` by re-running the evidence capture step, then re-run gate-review to confirm the gate fires on updated data.`;
  }
  if (s === "absent") {
    return `Ensure \`workflow-sidecar record-evidence\` writes a bundle claim for \`${claimId}\` before \`stop-goal-fit\` evaluates. Currently no claim exists in the bundle — the gate has nothing to evaluate.`;
  }
  return `Ensure \`workflow-sidecar record-evidence\` writes a definitive event for claim \`${claimId}\` (currently \`${s}\`) before \`stop-goal-fit\` evaluates. The gate had no resolved evidence to act on.`;
}

/**
 * Build a schema-conformant InquiryRecord for the hachure inquiry-record.schema.json.
 * Strips Surface-internal fields (identityLinkIds, transitiveRuleIds) from
 * resolutionPath that are valid in the TS type but not in the JSON schema.
 * Sets answer.value to the gate-review value-add: { calibration, advisoryFix, gateFired, sessionSlug }.
 */
function toSchemaInquiryRecord(
  raw: SurfaceInquiryRecord,
  calibration: GateCalibration,
  advisoryFix: string,
  blocked: boolean,
  slug: string,
): AnyObj {
  const resolutionPath: AnyObj = { claimIds: raw.resolutionPath.claimIds };
  if (raw.resolutionPath.ruleId !== undefined) resolutionPath["ruleId"] = raw.resolutionPath.ruleId;
  if (raw.resolutionPath.ruleVersion !== undefined) resolutionPath["ruleVersion"] = raw.resolutionPath.ruleVersion;
  const record: AnyObj = {
    id: raw.id,
    inquiry: raw.inquiry,
    outcome: raw.outcome,
    resolutionPath,
    inputSnapshot: raw.inputSnapshot,
    statusFunctionVersion: raw.statusFunctionVersion,
    resolvedAt: raw.resolvedAt,
  };
  // answer carries the canonical trust status AND gate-review's value-add advisory fix.
  // answer.status = derived TrustStatus from the resolved claim (or "unknown" when absent).
  // answer.value = { calibration, advisoryFix, gateFired, sessionSlug } — gate-review advisory.
  const answerStatus = raw.answer?.status ?? "unknown";
  record["answer"] = {
    status: answerStatus,
    value: {
      calibration,
      advisoryFix,
      gateFired: blocked,
      sessionSlug: slug,
    },
  };
  return record;
}

/**
 * Build an array of canonical InquiryRecords for all gate-fire and missed-block
 * candidates in the bundle, using Surface's resolveInquiry.  Returns null when
 * Surface is unavailable (caller skips the output file — no fork fallback).
 *
 * @param bundle              Parsed trust.bundle (BundleFile shape)
 * @param blockSignal         Result of readGateBlockSignal()
 * @param slug                Task slug (used in inquiry ids and session_slug)
 * @param expectedCriterionIds Optional list of expected criterion IDs to check
 *                            for absent claims (missed_block detection).
 * @param surface             Loaded Surface module (must have resolveInquiry)
 * @param now                 Optional timestamp override for deterministic tests
 */
export function buildGateInquiryRecords(
  bundle: BundleFile,
  blockSignal: GateBlockSignal,
  slug: string,
  expectedCriterionIds: string[],
  surface: SurfaceModule,
  now?: Date,
): AnyObj[] {
  const records: AnyObj[] = [];
  let idx = 0;
  const askedAt = (now ?? new Date()).toISOString();
  const bundleRecord = bundle as unknown as Record<string, unknown>;
  const claims = Array.isArray(bundle?.claims) ? bundle.claims : [];

  // Build a set of subjectIds already covered by bundle claims
  const claimSubjectIds = new Set<string>(claims.map((c) => c.subjectId));

  // ── Step 1: resolve each bundle claim via resolveInquiry ──────────────────
  for (const claim of claims) {
    idx += 1;
    const inquiryId = `${slug}-gr-${idx}`;
    const inquiry: SurfaceInquiry = {
      id: inquiryId,
      question: `Was gate action on claim ${claim.id} (status: ${claim.status}) justified given the trust state?`,
      askedBy: "gate-review",
      askedAt,
      target: {
        subjectType: claim.subjectType,
        subjectId: claim.subjectId,
        fieldOrBehavior: claim.fieldOrBehavior,
      },
      metadata: { sessionSlug: slug, claimId: claim.id, blocked: blockSignal.blocked },
    };
    const rawRecord = surface.resolveInquiry(bundleRecord, inquiry, { now });
    const calibration = deriveGateCalibration(rawRecord.outcome, rawRecord.answer?.status, blockSignal.blocked);
    const advisoryFix = gateAdvisoryFix(calibration, claim.id, rawRecord.answer?.status ?? claim.status);
    records.push(toSchemaInquiryRecord(rawRecord, calibration, advisoryFix, blockSignal.blocked, slug));
  }

  // ── Step 2: resolve absent expected criteria (missed_block candidates) ────
  for (const criterionId of expectedCriterionIds) {
    const subjectId = `${slug}/${criterionId}`;
    // Skip if there's already a bundle claim for this criterion
    if (claimSubjectIds.has(subjectId) || claimSubjectIds.has(criterionId)) continue;
    idx += 1;
    const inquiryId = `${slug}-gr-${idx}`;
    const inquiry: SurfaceInquiry = {
      id: inquiryId,
      question: `Was acceptance criterion "${criterionId}" claimed in the trust.bundle before gate evaluation?`,
      askedBy: "gate-review",
      askedAt,
      target: {
        subjectType: "workflow-check",
        subjectId,
        fieldOrBehavior: criterionId,
      },
      metadata: { sessionSlug: slug, criterionId, blocked: blockSignal.blocked, expectedCriterion: true },
    };
    const rawRecord = surface.resolveInquiry(bundleRecord, inquiry, { now });
    // outcome will be "unsupported" since no claim matches the absent criterion
    const calibration = deriveGateCalibration(rawRecord.outcome, rawRecord.answer?.status, blockSignal.blocked);
    const advisoryFix = gateAdvisoryFix(calibration, subjectId, "absent");
    records.push(toSchemaInquiryRecord(rawRecord, calibration, advisoryFix, blockSignal.blocked, slug));
  }

  // ── Step 3: if still empty (no claims, no expected criteria), emit one record
  if (records.length === 0) {
    idx += 1;
    const inquiryId = `${slug}-gr-${idx}`;
    const inquiry: SurfaceInquiry = {
      id: inquiryId,
      question: `Does the trust.bundle for session "${slug}" contain any claims for gate evaluation?`,
      askedBy: "gate-review",
      askedAt,
      // No target — natural-language-only inquiry → resolveInquiry returns "unsupported"
      metadata: { sessionSlug: slug, blocked: blockSignal.blocked, reason: "empty-bundle" },
    };
    const rawRecord = surface.resolveInquiry(bundleRecord, inquiry, { now });
    const advisoryFix = `Ensure \`workflow-sidecar record-evidence\` writes at least one claim to the trust.bundle for session \`${slug}\` before gate-review is invoked.`;
    records.push(toSchemaInquiryRecord(rawRecord, "missed_block", advisoryFix, blockSignal.blocked, slug));
  }

  return records;
}

/**
 * gate-review <artifact-dir>
 *
 * Reads the session's trust.bundle and the gate block signal, classifies each
 * gate fire or suspected miss using Surface's resolveInquiry, and emits
 * gate-review.inquiries.json as an array of canonical InquiryRecords.
 * ADVISORY ONLY — never modifies scripts/hooks/. Issue #119.
 *
 * The block signal is read from <artifact-root>/.goal-fit-block-streak.json,
 * written by scripts/hooks/stop-goal-fit.js when block mode fires. The file
 * lives one level above the session slug dir (the runtime artifact root).
 *
 * If @kontourai/surface is unavailable, logs a warning and returns 0
 * (fail-open — no bespoke fork fallback).
 */
async function gateReview(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  if (!fs.existsSync(dir)) die(`artifact directory does not exist: ${dir}`);
  const slug = taskSlugFor(dir, opt(p, "task-slug"));

  // Locate trust.bundle — required per SKILL.md contract
  const bundlePath = path.join(dir, "trust.bundle");
  if (!fs.existsSync(bundlePath)) {
    process.stderr.write(`[gate-review] trust.bundle absent at ${bundlePath} — NOT_VERIFIED. Build ADR 0010 Phase 1 first.\n`);
    return 1;
  }

  // Load Surface (ESM, fail-open)
  const surface = await tryLoadSurface();
  if (!surface || typeof surface.resolveInquiry !== "function") {
    process.stderr.write(`[gate-review] @kontourai/surface unavailable or missing resolveInquiry — gate-review skipped (no fork fallback)\n`);
    return 0;
  }

  const bundle: BundleFile = JSON.parse(fs.readFileSync(bundlePath, "utf8"));

  // Read gate block signal from the runtime artifact root (one level above session dir)
  const artifactRoot = path.dirname(dir);
  const blockSignal = readGateBlockSignal(artifactRoot);

  // Enumerate expected criterion IDs: primary = bundle claims (workflow.acceptance.criterion),
  // fallback = acceptance.json (back-compat for sessions without an up-to-date bundle).
  const criterionClaims = Array.isArray(bundle.claims)
    ? (bundle.claims as AnyObj[]).filter((c: AnyObj) => c.claimType === "workflow.acceptance.criterion")
    : [];
  let expectedCriterionIds: string[];
  if (criterionClaims.length > 0) {
    // Extract the final segment of subjectId (e.g. "slug/AC1" → "AC1")
    expectedCriterionIds = criterionClaims
      .map((c: AnyObj) => String(c.subjectId ?? "").split("/").pop() ?? "")
      .filter(Boolean);
  } else {
    // Fallback: read acceptance.json (back-compat for sessions without criterion claims)
    const acceptancePath = path.join(dir, "acceptance.json");
    const acceptance = fs.existsSync(acceptancePath) ? (loadJson(acceptancePath) as AnyObj) : null;
    expectedCriterionIds = Array.isArray(acceptance?.criteria)
      ? (acceptance!.criteria as AnyObj[]).map((c: AnyObj) => String(c.id ?? "")).filter(Boolean)
      : [];
  }

  const records = buildGateInquiryRecords(bundle, blockSignal, slug, expectedCriterionIds, surface);

  // Validate each record against the hachure inquiry-record.schema.json (fail-open)
  const validator = getHachureInquiryRecordValidator();
  let schemaValid = true;
  const validationErrors: string[] = [];
  for (const record of records) {
    if (validator) {
      const result = validator(record);
      if (!result.valid) {
        schemaValid = false;
        validationErrors.push(...result.errors.map((e) => `${record["id"] ?? "?"}: ${e}`));
      }
    }
  }
  if (!schemaValid) {
    process.stderr.write(`[gate-review] InquiryRecord schema validation errors:\n${validationErrors.join("\n")}\n`);
  }

  const outputPath = path.join(dir, "gate-review.inquiries.json");
  writeJson(outputPath, records);

  // Build summary counts by calibration
  const counts: Record<string, number> = {};
  for (const r of records) {
    const cal = (r["answer"] as AnyObj | undefined)?.["value"]?.["calibration"] ?? "unknown";
    counts[cal] = (counts[cal] ?? 0) + 1;
  }
  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
  const schemaTag = validator ? (schemaValid ? " schema:valid" : " schema:INVALID") : " schema:unavailable";
  console.log(`gate-review: ${records.length} InquiryRecord(s) [${summary}]${schemaTag} → ${outputPath}`);
  return 0;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── ADR 0010 Phase 3: project the local trust.bundle to the Surface Trust Panel ──
// Surface owns derivation (buildTrustReport) AND rendering (the dependency-free
// <surface-trust-panel> element). Flow Agents only assembles a standalone HTML
// shell — no trust logic or rendering reimplemented (consume-never-fork).

/** Locate Surface's self-contained, dependency-free panel element (ESM, no require). */
function loadSurfacePanelJs(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    try { return fs.readFileSync(path.join(d, "node_modules/@kontourai/surface/dist/src/trust-panel/surface-trust-panel.js"), "utf8"); } catch { /* walk up */ }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  die("could not locate @kontourai/surface trust-panel element (dist/src/trust-panel/surface-trust-panel.js)");
  return "";
}

async function renderTrustPanel(p: ReturnType<typeof parseArgs>): Promise<number> {
  const root = opt(p, "artifact-root") ? path.resolve(opt(p, "artifact-root")) : defaultArtifactRootForRead();
  const dir = p.positional[0] ? artifactDirFrom(p.positional[0]) : currentDir(root);
  if (!dir) die("render-trust-panel requires a workflow dir or a recorded current session");
  let bundle: AnyObj | null = null;
  try { bundle = JSON.parse(fs.readFileSync(path.join(dir!, "trust.bundle"), "utf8")); } catch { bundle = null; }
  if (!bundle) die(`no trust.bundle at ${path.join(dir!, "trust.bundle")} — run record-evidence first`);
  const surface = (await import("@kontourai/surface")) as unknown as { buildTrustReport?: (b: unknown) => AnyObj; diffFreshness?: (prior: unknown, next: unknown) => Array<Record<string, unknown>> };
  if (typeof surface.buildTrustReport !== "function") die("@kontourai/surface buildTrustReport unavailable — cannot derive the trust report");
  const report = surface.buildTrustReport!(bundle);
  // diffFreshness on resume: if a prior trust.checkpoint.json exists, surface the
  // fresh→stale transitions so the user sees what has gone stale since the last seal.
  const checkpointFile = path.join(dir!, "trust.checkpoint.json");
  if (fs.existsSync(checkpointFile) && typeof surface.diffFreshness === "function") {
    try {
      const envelope: AnyObj = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
      const priorCheckpoint = envelope.checkpoint;
      if (priorCheckpoint && typeof priorCheckpoint === "object") {
        const transitions = surface.diffFreshness(priorCheckpoint, report);
        const staleTransitions = transitions.filter((t) => t["to"] === "stale");
        if (staleTransitions.length > 0) {
          const claimIds = staleTransitions.map((t) => String(t["claimId"] ?? "")).filter(Boolean);
          process.stderr.write(`[trust-checkpoint] ${staleTransitions.length} claim(s) went stale since the last checkpoint (sealed ${String(envelope.sealed_at ?? "unknown")}):\n${claimIds.map((id) => `  - ${id}`).join("\n")}\n`);
        } else {
          process.stderr.write(`[trust-checkpoint] 0 claims went stale since the last checkpoint (sealed ${String(envelope.sealed_at ?? "unknown")}).\n`);
        }
      }
    } catch {
      /* diffFreshness is advisory — never block the panel render */
    }
  }
  const panelJs = loadSurfacePanelJs();
  const heading = `Flow Agents trust — ${String(path.basename(dir!)).replace(/[<>"&]/g, "")}`;
  const reportJson = JSON.stringify(report).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>
<body style="margin:0;padding:1.5rem;background:#f4f1e6">
<script type="module">
${panelJs}
</script>
<surface-trust-panel heading="${heading}"></surface-trust-panel>
<script id="trust-report" type="application/json">${reportJson}</script>
<script type="module">document.querySelector("surface-trust-panel").report = JSON.parse(document.getElementById("trust-report").textContent);</script>
</body></html>
`;
  const out = opt(p, "out") || path.join(dir!, "trust-panel.html");
  fs.writeFileSync(out, html);
  // Also emit the derived report as a first-class artifact — the universal input for
  // Surface's hosted Snapshot Viewer and a bare `<surface-trust-panel src=…>` (the HTML
  // above already embeds it). Suppress with --no-report.
  let reportOut = "";
  if (!p.flags.has("no-report")) {
    reportOut = opt(p, "report-out") || path.join(dir!, "trust-report.json");
    fs.writeFileSync(reportOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(out);
  if (reportOut) console.log(reportOut);
  return 0;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── flow-agents#137 / ADR 0011: wire Surface's MCP to surface trust reports ──
// Flow Agents produces the bundle; Surface's MCP projects it. `--mode print` is the
// zero-write default (output the snippet). `enable`/`disable` edit a runtime JSON MCP
// config (e.g. Claude Code `.mcp.json`) via a *conventional managed key* — idempotent,
// reversible, and only ever our own entry (never auto-injected; opt-in only).
const TRUST_MCP_SERVER = "flow-agents-surface-trust";
function trustMcpRegistration(): AnyObj {
  // No static `--input` (a single file can't follow many per-task bundles or a moving
  // current); the skill passes the active task's bundle as a per-call `path` arg.
  return { command: "npx", args: ["-y", "@kontourai/surface", "mcp"] };
}
function trustMcp(p: ReturnType<typeof parseArgs>): number {
  const mode = opt(p, "mode", "print");
  if (mode === "print") {
    console.log(JSON.stringify({ mcpServers: { [TRUST_MCP_SERVER]: trustMcpRegistration() } }, null, 2));
    process.stderr.write(`\n# Paste the above into your runtime MCP config (e.g. .mcp.json). Flow Agents does NOT write it for you unless you run: trust-mcp --mode enable\n`);
    process.stderr.write(`# To view a task's trust inline, call surface_summary with path=<.kontourai/flow-agents/<slug>/trust.bundle>.\n`);
    return 0;
  }
  if (mode !== "enable" && mode !== "disable") die("trust-mcp --mode must be print|enable|disable");
  const configPath = path.resolve(opt(p, "config", ".mcp.json"));
  let config: AnyObj = {};
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { config = {}; }
  if (typeof config !== "object" || config === null || Array.isArray(config)) die(`${configPath} is not a JSON object — refusing to edit`);
  if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) config.mcpServers = {};
  if (mode === "enable") {
    config.mcpServers[TRUST_MCP_SERVER] = trustMcpRegistration();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`enabled ${TRUST_MCP_SERVER} in ${configPath} (remove with: trust-mcp --mode disable)`);
    return 0;
  }
  // disable: remove only our own conventional entry; leave everything else untouched.
  if (Object.prototype.hasOwnProperty.call(config.mcpServers, TRUST_MCP_SERVER)) {
    delete config.mcpServers[TRUST_MCP_SERVER];
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`disabled ${TRUST_MCP_SERVER} in ${configPath}`);
  } else {
    console.log(`${TRUST_MCP_SERVER} not present in ${configPath} — nothing to remove`);
  }
  return 0;
}
// ─── ADR 0012: agent coordination as liveness claims (policy-centered) ──────────
// A work-claim is a regular Hachure claim governed by a *liveness policy* (ttl +
// heartbeat → held/stale/released), keyed by the work-item subjectId, appended to a
// shared stream all agents read. Status is RECOMPUTED via Surface's deriveTrustStatus
// (no forked logic). Advisory, not a lock. The liveness policy is a general archetype
// (not use-case-specific) and is a candidate to graduate upstream into Surface.
const LIVENESS_POLICY = {
  id: "policy:liveness.hold",
  claimType: "liveness.hold",
  requiredEvidence: [] as string[],
  acceptanceCriteria: ["A heartbeat within ttlSeconds holds the claim; a lapse or release frees it."],
  reviewAuthority: "system",
  validityRule: { kind: "duration", durationDays: 1 },
  stalenessTriggers: [] as string[],
  conflictRules: [] as string[],
  impactLevel: "medium",
};

/**
 * Delegate to the shared pure-CJS writer (scripts/hooks/lib/liveness-write.js), mirroring the
 * createRequire pattern used by loadActorIdentityHelper() below. Deliberately NO inline duplicate
 * fallback — the whole point of #288 Wave 2 Task 2.1 is one writer shared by the CLI and the
 * hook wrappers' tool-activity heartbeat, not two copies of the append shape that can drift.
 */
function loadLivenessWriteHelper(): {
  livenessStreamFile: (root: string) => string;
  appendLivenessEvent: (root: string, evt: AnyObj) => void;
} {
  const _req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/liveness-write.js");
  return _req(helperPath) as {
    livenessStreamFile: (root: string) => string;
    appendLivenessEvent: (root: string, evt: AnyObj) => void;
  };
}
function livenessStreamFile(root: string): string { return loadLivenessWriteHelper().livenessStreamFile(root); }
function appendLivenessEvent(root: string, evt: AnyObj): void { loadLivenessWriteHelper().appendLivenessEvent(root, evt); }
function readLivenessEvents(root: string): AnyObj[] {
  // Delegate to the shared pure-CJS helper (scripts/hooks/lib/liveness-read.js).
  // Using createRequire so the ESM sidecar can load a CJS module without bundling it.
  try {
    const _req = createRequire(import.meta.url);
    const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/liveness-read.js");
    const helper = _req(helperPath) as { readLivenessEvents: (p: string) => AnyObj[] };
    return helper.readLivenessEvents(livenessStreamFile(root));
  } catch {
    // Fallback: read inline (keeps sidecar self-sufficient if helper is unavailable)
    let raw = "";
    try { raw = fs.readFileSync(livenessStreamFile(root), "utf8"); } catch { return []; }
    return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l) as AnyObj; } catch { return null; } }).filter((x): x is AnyObj => x !== null);
  }
}
function livenessLabel(status: string): string {
  if (status === "verified") return "held";
  if (status === "stale" || status === "revoked") return "free"; // reclaimable: lapsed or released
  if (status === "superseded") return "superseded";
  return status;
}

/**
 * Delegate to the shared pure-CJS liveness reader's freshHolders() (scripts/hooks/lib/liveness-read.js),
 * mirroring the exact loader shape assignment-provider.ts already uses for the same helper (#291
 * Wave 2 Task 2.1) — so ensure-session's ownership guard computes freshness identically to
 * `assignment-provider status`'s own join, a single implementation. `readLivenessEvents` above
 * already loads this same module inline for its own narrower need (just the events reader); this
 * loader additionally exposes `freshHolders` for the guard's `computeEffectiveState` call.
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

// ─── ADR 0012 lifecycle-driven liveness (default-on; opt-out via FLOW_AGENTS_LIVENESS) ──
// init-plan claims the work-item; advance-state heartbeats (or releases on terminal),
// so the workflow lifecycle itself maintains the liveness claim — no manual liveness calls.
// Additive + fail-open: a liveness-emit failure never affects the workflow command.
export const LIVENESS_TERMINAL = new Set(["delivered", "accepted", "archived"]);
/**
 * Delegate to the shared pure-CJS resolver (scripts/hooks/lib/actor-identity.js), mirroring the
 * createRequire pattern used by readLivenessEvents() above. Deliberately NO inline duplicate
 * fallback: if the module fails to load, that failure itself must surface as an unresolved actor
 * ("") — never silently degrade back to the retired "local" default (issue #287).
 */
function loadActorIdentityHelper(): {
  resolveActor: (env: NodeJS.ProcessEnv) => { actor: string; source: string };
  sanitizeSegment: (value: unknown) => string;
  isUnresolvedActor: (actor: string) => boolean;
  // #291 Wave 2 Task 2.1: widened (additive only — every existing caller above keeps using only
  // the three fields already destructured) so resolveEnsureSessionActor() can reconstruct a real
  // ActorStruct {runtime, session_id, host} from the SAME exported primitives resolveActor()
  // already uses internally, and so serializeActor() is available for the ownership guard's
  // assignment-claim identity (a DIFFERENT identity concept from the flat actorKey used for
  // branch-naming/liveness — see resolveEnsureSessionActor's doc comment for why both exist).
  serializeActor: (actor: Partial<ActorStruct> | undefined) => string;
  detectRuntime: (env: NodeJS.ProcessEnv) => string;
  runtimeSessionId: (env: NodeJS.ProcessEnv) => string;
  ancestorActorSeed: () => string;
} {
  const _req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/actor-identity.js");
  return _req(helperPath) as {
    resolveActor: (env: NodeJS.ProcessEnv) => { actor: string; source: string };
    sanitizeSegment: (value: unknown) => string;
    isUnresolvedActor: (actor: string) => boolean;
    serializeActor: (actor: Partial<ActorStruct> | undefined) => string;
    detectRuntime: (env: NodeJS.ProcessEnv) => string;
    runtimeSessionId: (env: NodeJS.ProcessEnv) => string;
    ancestorActorSeed: () => string;
  };
}
function resolveLivenessActor(): string {
  return loadActorIdentityHelper().resolveActor(process.env).actor;
}
// isUnresolvedActor is no longer defined locally — it is single-sourced in
// scripts/hooks/lib/actor-identity.js (loadActorIdentityHelper().isUnresolvedActor) so the
// lifecycle auto-emit path, the direct CLI liveness path, and the tool-activity heartbeat path
// all consume the same predicate rather than forking their own copy (#287 re-review MEDIUM; #288
// Wave 1 Task 1.1 single-sources it there).
/**
 * Delegate to the shared pure-CJS policy predicates (scripts/hooks/lib/liveness-policy.js) — the
 * one definition of "enabled" (default-on/opt-out) and the claim TTL default, consumed by both the
 * lifecycle auto-emit path and the manual `liveness claim --ttl` default so they can never disagree
 * (#288).
 */
function loadLivenessPolicyHelper(): {
  isLivenessEnabled: (env: NodeJS.ProcessEnv) => boolean;
  resolveTtlSeconds: (env: NodeJS.ProcessEnv) => number;
} {
  const _req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/liveness-policy.js");
  return _req(helperPath) as {
    isLivenessEnabled: (env: NodeJS.ProcessEnv) => boolean;
    resolveTtlSeconds: (env: NodeJS.ProcessEnv) => number;
  };
}
function livenessEnabled(): boolean { return loadLivenessPolicyHelper().isLivenessEnabled(process.env); }
/**
 * F1 (#288 fix iteration 1, cr-HIGH fail-open violation): the `livenessEnabled()`
 * guard (and therefore its `loadLivenessPolicyHelper()` module load) must sit
 * INSIDE this function's own fail-open try/catch — previously it sat outside,
 * so a missing/broken scripts/hooks/lib/liveness-policy.js module made
 * `init-plan`/`advance-state` exit 1 instead of degrading gracefully
 * (repro-verified). Now: any failure here — including a failed helper load —
 * is caught, produces one stderr diagnostic, and the lifecycle auto-emit is
 * skipped; the workflow command's own exit code is never affected. This
 * mirrors the #287 fail-open convention already used elsewhere in this file.
 * The direct CLI write path (`async function liveness`, actions
 * claim|heartbeat|release) is deliberately NOT wrapped this way — it stays
 * fail-loud on a missing helper module, per the plan's explicit instruction
 * that only the convenience lifecycle wiring is flag-gated/fail-open.
 */
function livenessLifecycle(taskDir: string, slug: string, kind: "claim" | "heartbeat" | "release", timestamp: string): void {
  try {
    if (!livenessEnabled()) return;
    const actor = resolveLivenessActor();
    if (loadActorIdentityHelper().isUnresolvedActor(actor)) {
      process.stderr.write("[liveness] skipped auto-emit: actor unresolved (set FLOW_AGENTS_ACTOR or run inside a supported runtime)\n");
      return;
    }
    const root = path.dirname(taskDir); // .kontourai/flow-agents/<slug> → .kontourai/flow-agents (the shared liveness stream lives here)
    const evt: AnyObj = { type: kind, subjectId: slug, actor, at: timestamp, source: "lifecycle" };
    if (kind === "claim") evt.ttlSeconds = loadLivenessPolicyHelper().resolveTtlSeconds(process.env);
    appendLivenessEvent(root, evt);
  } catch (err) {
    // best-effort; liveness is advisory and must never break the workflow — but the failure
    // itself must be visible (F1), not silently absorbed.
    try {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[liveness] skipped auto-emit: ${detail}\n`);
    } catch { /* best-effort diagnostic only */ }
  }
}

/**
 * F5 (#288 fix iteration 1, sec-LOW): strip control/escape characters before echoing a
 * subjectId/actor to the terminal. subjectId is a raw CLI positional argument on the write path
 * (never sanitized before this point — it is stored as-is in the event for data fidelity) and,
 * on the `status` read path, both subjectId and actor may originate from a hand-edited or
 * otherwise hostile liveness/events.jsonl file rather than this process's own writes. Strips the
 * C0 control range (0x00-0x1F), DEL (0x7F), and the C1 range (0x80-0x9F, which includes
 * ANSI-CSI-adjacent bytes) — display-only; the persisted event itself is never mutated.
 */
function stripControlCharsForDisplay(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
}

async function liveness(p: ReturnType<typeof parseArgs>): Promise<number> {
  const root = opt(p, "artifact-root") ? path.resolve(opt(p, "artifact-root")) : flowAgentsArtifactRoot();
  const action = p.positional[0] || "";
  const subjectId = p.positional[1] || "";
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  if (action === "whoami") {
    // Read-only, lock-free, write-free advisory surface: reuses the identical resolution chain
    // as the write paths (loadActorIdentityHelper().resolveActor) but deliberately never dies on
    // an unresolved actor — the enforcement point stays at `liveness claim`, which already dies
    // loudly (see below). This lets a skill learn "who am I" during a read-only preflight without
    // emitting a bogus claim first.
    const helper = loadActorIdentityHelper();
    const explicitActorRaw = opt(p, "actor", "");
    const explicitActor = explicitActorRaw ? helper.sanitizeSegment(explicitActorRaw) : "";
    const resolved = explicitActor
      ? { actor: explicitActor, source: "explicit-override" }
      : helper.resolveActor(process.env);
    if (p.flags.has("json")) { console.log(JSON.stringify(resolved)); return 0; }
    console.log(`${stripControlCharsForDisplay(resolved.actor || "unresolved")}\t${stripControlCharsForDisplay(resolved.source)}`);
    return 0;
  }

  if (action === "claim" || action === "heartbeat" || action === "release") {
    // Actor resolution happens only for write actions (F5, #287 fix iteration 1) — "status" is a
    // read path and must not shell out via resolveLivenessActor()/resolveActor().
    const helper = loadActorIdentityHelper();
    const explicitActorRaw = opt(p, "actor", "");
    // F7 (#287 fix iteration 2): an explicit --actor value that strips to empty under the allowed
    // [A-Za-z0-9_.-] charset (e.g. "--actor ':::'") is a hard error on this write path, not a
    // silent fallback to sanitizeSegment's shared "unknown" sentinel — garbage on an explicit flag
    // is an authoring mistake the caller must fix, unlike the env-override seam (which falls
    // through to derivation instead, since there is no flag to correct).
    if (explicitActorRaw && !/[A-Za-z0-9_.-]/.test(explicitActorRaw)) {
      die(`liveness ${action} --actor value strips to empty under the allowed actor charset ([A-Za-z0-9_.-]) — pass a --actor value containing at least one letter, digit, underscore, period, or hyphen.`);
    }
    const explicitActor = explicitActorRaw ? helper.sanitizeSegment(explicitActorRaw) : "";
    const actor = explicitActor || helper.resolveActor(process.env).actor;
    if (helper.isUnresolvedActor(actor)) {
      die(`liveness ${action} requires a resolvable actor — no explicit --actor flag, no FLOW_AGENTS_ACTOR override, and runtime/ancestry resolution failed. Fix: pass --actor <id>, or set FLOW_AGENTS_ACTOR=<id>, or run inside a supported runtime.`);
    }
    if (!subjectId) die(`liveness ${action} requires a subjectId`);
    // F8(i) (#288 fix iteration 2, orphan-heartbeat invariant): heartbeat/release on the direct CLI
    // write path must never be the FIRST liveness event ever written for a (subjectId, actor) pair —
    // that is exactly how the reviewer-reproduced orphan-heartbeat bug arises (a bare heartbeat with
    // no claim behind it, later mistaken for claim evidence). A full stream read here is fine: this
    // is a rare, human/CLI-driven call, not the hot tool-activity path. `claim` itself is exempt (it
    // is the event that ESTABLISHES the pair in the first place).
    if (action === "heartbeat" || action === "release") {
      const priorEvents = readLivenessEvents(root);
      const hasPriorClaim = priorEvents.some((e) => e && e.type === "claim" && e.subjectId === subjectId && e.actor === actor);
      if (!hasPriorClaim) {
        die(`liveness ${action} requires a prior claim event for subjectId ${JSON.stringify(subjectId)} and actor ${JSON.stringify(actor)} — none was found in the liveness stream. Fix: run \`liveness claim ${subjectId} --actor ${actor}\` first, then retry ${action}.`);
      }
    }
    const evt: AnyObj = { type: action, subjectId, actor, at: opt(p, "at") || nowIso };
    if (action === "claim") {
      const defaultTtl = loadLivenessPolicyHelper().resolveTtlSeconds(process.env);
      evt.ttlSeconds = Number.parseInt(opt(p, "ttl", String(defaultTtl)), 10) || defaultTtl;
    }
    appendLivenessEvent(root, evt);
    console.log(`liveness ${action}: ${stripControlCharsForDisplay(subjectId)} by ${stripControlCharsForDisplay(actor)}`);
    return 0;
  }

  if (action === "status") {
    const surface = (await import("@kontourai/surface")) as unknown as { deriveTrustStatus?: (a: AnyObj) => string };
    if (typeof surface.deriveTrustStatus !== "function") die("@kontourai/surface deriveTrustStatus unavailable — requires surface >= 1.2");
    const subjectFilter = opt(p, "subject");
    const now = opt(p, "now") ? new Date(opt(p, "now")) : new Date();
    // Group events by subjectId::actor — one liveness claim per holder of a subject.
    const groups = new Map<string, { subjectId: string; actor: string; ttlSeconds: number; created: string; updated: string; events: AnyObj[] }>();
    for (const e of readLivenessEvents(root)) {
      if (!e.subjectId || !e.actor) continue;
      const key = `${e.subjectId}::${e.actor}`;
      let g = groups.get(key);
      if (!g) { g = { subjectId: String(e.subjectId), actor: String(e.actor), ttlSeconds: 1800, created: String(e.at), updated: String(e.at), events: [] }; groups.set(key, g); }
      g.updated = String(e.at);
      if (e.type === "claim") { g.ttlSeconds = Number(e.ttlSeconds) || g.ttlSeconds; g.events.push({ id: `c:${key}:${e.at}`, claimId: key, status: "verified", actor: g.actor, method: "observation", evidenceIds: [], createdAt: e.at, verifiedAt: e.at }); }
      else if (e.type === "heartbeat") { g.events.push({ id: `h:${key}:${e.at}`, claimId: key, status: "verified", actor: g.actor, method: "observation", evidenceIds: [], createdAt: e.at, verifiedAt: e.at }); }
      else if (e.type === "release") { g.events.push({ id: `r:${key}:${e.at}`, claimId: key, status: "revoked", type: "invalidation", actor: g.actor, method: "observation", evidenceIds: [], createdAt: e.at, verifiedAt: e.at }); }
    }
    const rows: AnyObj[] = [];
    for (const g of groups.values()) {
      if (subjectFilter && g.subjectId !== subjectFilter) continue;
      const claim: AnyObj = { id: `${g.subjectId}::${g.actor}`, subjectType: "work-item", subjectId: g.subjectId, facet: "flow.liveness", claimType: "liveness.hold", fieldOrBehavior: "held-by", value: g.actor, createdAt: g.created, updatedAt: g.updated, ttlSeconds: g.ttlSeconds, verificationPolicyId: LIVENESS_POLICY.id };
      const status = surface.deriveTrustStatus!({ claim, evidence: [], policy: LIVENESS_POLICY, events: g.events, now });
      rows.push({ subjectId: g.subjectId, actor: g.actor, status, label: livenessLabel(status) });
    }
    if (p.flags.has("json")) { console.log(JSON.stringify(rows, null, 2)); return 0; }
    for (const r of rows) console.log(`${stripControlCharsForDisplay(r.subjectId)}\t${stripControlCharsForDisplay(r.actor)}\t${r.label}`);
    return 0;
  }

  if (action === "verdict") {
    // Read-only, lock-free CLI helper (#320 AC1) — mirrors `whoami`'s lock-bypass (see
    // isLivenessVerdict in main() below): computes {subjectId, winner, losers, reason, holders}
    // as a PURE function of the shared liveness stream. Among the subject's currently-fresh
    // claim holders (via the shared `freshHolders` helper — the exact canonical
    // freshness/grouping/release-handling logic `workflow-steering.js`'s ambient digest already
    // uses, not a re-derived rule), the holder whose most recent `claim` event has the earliest
    // `at` wins; an exact-timestamp tie breaks by ascending plain string comparison of actor id
    // (never locale-aware collation, for cross-machine determinism). Same stream state ⇒ same
    // verdict, regardless of which actor invokes it — no actor-specific input is read here.
    if (!subjectId) die("liveness verdict requires a subjectId");
    const events = readLivenessEvents(root);
    const nowMs = opt(p, "now") ? Date.parse(opt(p, "now")) : Date.now();
    const _req = createRequire(import.meta.url);
    const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/liveness-read.js");
    const { freshHolders } = _req(helperPath) as { freshHolders: (events: AnyObj[], slug: string, selfActor: string, nowMs: number) => AnyObj[] };
    // Impossible-sentinel selfActor: real actors are sanitized to [A-Za-z0-9_.-]+ and can never be
    // empty (enforced on every write path above), so passing "" excludes nothing.
    const fresh = freshHolders(events, subjectId, "", nowMs);
    // freshHolders' `lastAt` tracks the group's latest event of ANY type (heartbeat-updated); the
    // tiebreak instead operates on each holder's most recent `claim`-type event `at` — the
    // "current claim timestamp", distinct from lastAt.
    const latestClaimAt = (actor: string): string => {
      let best = "";
      for (const e of events) {
        if (e && e.subjectId === subjectId && e.actor === actor && e.type === "claim" && typeof e.at === "string") {
          if (!best || e.at > best) best = e.at;
        }
      }
      return best;
    };
    const holders: AnyObj[] = fresh
      .map((h) => ({ actor: String(h.actor), claimAt: latestClaimAt(String(h.actor)) || String(h.lastAt), lastAt: String(h.lastAt), ttlSeconds: Number(h.ttlSeconds) }))
      .sort((a, b) => (a.claimAt < b.claimAt ? -1 : a.claimAt > b.claimAt ? 1 : a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0));
    let winner: AnyObj | null = null;
    let losers: AnyObj[] = [];
    let reason = "no-conflict";
    if (holders.length >= 2) {
      winner = holders[0];
      const tie = holders.filter((h) => h.claimAt === winner!.claimAt).length > 1;
      reason = tie ? "tie-actor-lexicographic" : "earlier-claim";
      losers = holders.filter((h) => h.actor !== winner!.actor);
    }
    if (p.flags.has("json")) {
      // #320 fix iteration 1 (sec-HIGH F3): `winner`/`losers`/`holders` carry raw actor/claimAt/
      // lastAt strings sourced straight from the multi-writer append-only liveness/events.jsonl
      // stream (see stripControlCharsForDisplay's header above — any process can append a
      // hostile line, bypassing the CLI write-side sanitizeSegment entirely). The pull-work
      // SKILL.md's Post-Claim Conflict Re-check instructs an LLM to read `winner.actor` /
      // `losers[].actor` straight out of THIS `--json` output into its own context — a second,
      // LLM-facing injection path alongside the mid-turn conflict hook (liveness-heartbeat.js's
      // computeConflict). Build a sanitized COPY for JSON emission only: control-char strip
      // (matching the text branch's existing stripControlCharsForDisplay treatment below) plus a
      // 64-char cap (matching sanitizeSegment's cap on the write side) on actor/claimAt/lastAt.
      // `reason`/`subjectId`/`ttlSeconds` are left as-is (enum/number, never free text). Never
      // mutates `result`/`holders`/`winner`/`losers` themselves — the text branch below still
      // needs the untouched originals for its own per-line rendering, and winner/loser identity
      // (already sanitizeSegment-clean for legitimate actors) is unaffected, so the loser-release
      // contract still works.
      const sanitizeVerdictHolderForJson = (h: AnyObj | null): AnyObj | null =>
        h
          ? {
              ...h,
              actor: stripControlCharsForDisplay(h.actor).slice(0, 64),
              claimAt: stripControlCharsForDisplay(h.claimAt).slice(0, 64),
              lastAt: stripControlCharsForDisplay(h.lastAt).slice(0, 64),
            }
          : h;
      const jsonResult = {
        subjectId,
        winner: sanitizeVerdictHolderForJson(winner),
        losers: losers.map((l) => sanitizeVerdictHolderForJson(l)),
        reason,
        holders: holders.map((h) => sanitizeVerdictHolderForJson(h)),
      };
      console.log(JSON.stringify(jsonResult));
      return 0;
    }
    for (const h of holders) {
      const tag = winner && h.actor === (winner as AnyObj).actor ? "WINNER" : (holders.length >= 2 ? "LOSER" : "HOLDER");
      console.log(`${stripControlCharsForDisplay(h.actor)}\tclaimAt=${stripControlCharsForDisplay(h.claimAt)}\t${tag}`);
    }
    if (winner) console.log(`WINNER: ${stripControlCharsForDisplay((winner as AnyObj).actor)}`);
    for (const l of losers) console.log(`LOSER: ${stripControlCharsForDisplay(l.actor)}`);
    return 0;
  }

  die("liveness action must be one of: claim | heartbeat | release | status | whoami | verdict");
  return 1;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Claim Lookup — pure helper (promotable to Surface #171) ─────────────────
// buildClaimExplanation + its types are extracted to ./sidecar-claim-explain.ts
// (ops#22): a PURE projection (report + bundle + id in, structured explanation out)
// with no fs/CLI/shared state, unit-tested in isolation. Re-exported here so the
// library facade (src/index.ts) and the IO `claimLookup` handler below are unchanged.
export { buildClaimExplanation } from "./sidecar-claim-explain.js";
export type { ClaimEvidenceItem, ClaimExplanation } from "./sidecar-claim-explain.js";
import { buildClaimExplanation } from "./sidecar-claim-explain.js";

/**
 * claim <id> <dir>
 *
 * Look up a specific claim in the session's trust.bundle and print:
 *   - Derived status and raw value
 *   - Failing evidence items (with execution block: runner, exitCode, isError)
 *   - Governing VerificationPolicy (how-to-verify)
 *   - Derivation drilldown / transparency gaps (why it is in that state)
 *
 * --json  Emit the structured ClaimExplanation object instead of text.
 *
 * Usage: workflow-sidecar claim <claimId> <artifactDir>
 */
async function claimLookup(p: ReturnType<typeof parseArgs>): Promise<number> {
  const claimId = p.positional[0] || die("claim id is required (first positional argument)");
  const rawDir = p.positional[1] || die("artifact directory is required (second positional argument)");
  const dir = path.resolve(rawDir);

  const bundlePath = path.join(dir, "trust.bundle");
  if (!fs.existsSync(bundlePath)) {
    process.stderr.write(`[claim] no trust.bundle at ${bundlePath} — run record-evidence first
`);
    return 1;
  }

  const bundle: BundleFile = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const bundleClaims = Array.isArray(bundle.claims) ? bundle.claims : [];

  const bundleClaim = bundleClaims.find((c) => c.id === claimId);
  if (!bundleClaim) {
    const available = bundleClaims.map((c) => c.id).join("\n  ");
    process.stderr.write(`[claim] unknown claim id: ${claimId}
Available claim ids:
  ${available || "(none — bundle has no claims)"}
`);
    return 1;
  }

  // Load Surface via tryLoadSurface() (ESM, cached, fail-open pattern)
  const surface = await tryLoadSurface();
  if (!surface || typeof surface.buildTrustReport !== "function" || typeof surface.buildDerivationDrilldown !== "function") {
    process.stderr.write(`[claim] @kontourai/surface unavailable or missing buildTrustReport/buildDerivationDrilldown
`);
    return 0; // fail-open, consistent with gate-review pattern
  }

  // Build TrustReport (required — buildDerivationDrilldown needs TrustReport, not TrustBundle)
  const report = surface.buildTrustReport(bundle as unknown as Record<string, unknown>);

  // Build the structured explanation (pure, promotable to #171)
  const explanation = buildClaimExplanation(report, bundle as unknown as Record<string, unknown>, claimId);

  // Enrich the why.directInputs/leafClaims/diagnostics from the drilldown
  try {
    const drilldown = surface.buildDerivationDrilldown(report, claimId) as AnyObj;
    if (drilldown) {
      explanation.why.directInputs = Array.isArray(drilldown.directInputs) ? drilldown.directInputs : [];
      explanation.why.leafClaims = Array.isArray(drilldown.leafClaims) ? drilldown.leafClaims : [];
      explanation.why.diagnostics = Array.isArray(drilldown.diagnostics) ? drilldown.diagnostics : [];
    }
  } catch {
    // buildDerivationDrilldown threw (e.g. claim not in report) — proceed without drilldown
  }

  if (p.flags.has("json")) {
    console.log(JSON.stringify(explanation, null, 2));
    return 0;
  }

  // ── Human-readable output ───────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`Claim:  ${claimId}`);
  lines.push(`Status: ${explanation.status}   Value: ${explanation.value}`);
  lines.push(`Type:   ${explanation.claimType}`);
  lines.push("");

  // Evidence section — failing items are the concrete "why disputed"
  const failingEvidence = explanation.evidence.filter((ev) => !ev.passing);
  const allEvidence = explanation.evidence;
  if (allEvidence.length > 0) {
    lines.push("Evidence:");
    for (const ev of allEvidence) {
      const passMark = ev.passing ? "pass" : "FAIL";
      const execStr = ev.execution
        ? ` [runner: ${ev.execution.runner}, exitCode: ${ev.execution.exitCode ?? "?"}, isError: ${ev.execution.isError}]`
        : "";
      lines.push(`  [${passMark}] ${ev.evidenceType}: ${ev.label || ev.summary}${execStr}`);
    }
    if (failingEvidence.length > 0) {
      lines.push("");
      lines.push(`Failing evidence (disputed because):`);
      for (const ev of failingEvidence) {
        const execStr = ev.execution
          ? ` ${ev.execution.runner} exited ${ev.execution.exitCode ?? "?"} (isError: ${ev.execution.isError})`
          : "";
        lines.push(`  ${ev.evidenceType}: ${ev.label || ev.summary}${execStr}`);
      }
    }
  } else {
    lines.push("Evidence: (none recorded for this claim)");
  }
  lines.push("");

  // Policy section — how-to-verify
  if (explanation.policy) {
    const pol = explanation.policy;
    lines.push(`Governing Policy (${pol.id}):`);
    lines.push(`  requiredEvidence:   [${pol.requiredEvidence.join(", ")}]`);
    if (pol.requiredMethods && pol.requiredMethods.length > 0) {
      lines.push(`  requiredMethods:    [${pol.requiredMethods.join(", ")}]`);
    }
    lines.push(`  acceptanceCriteria: [${pol.acceptanceCriteria.join(" | ")}]`);
    lines.push(`  reviewAuthority:    ${pol.reviewAuthority}`);
  } else {
    lines.push("Governing Policy: (none — claim has no verificationPolicyId or policy not found in bundle)");
  }
  lines.push("");

  // Why section — derivation drilldown + transparency gaps
  lines.push("Derivation Drilldown:");
  if (explanation.why.directInputs.length > 0) {
    lines.push(`  Direct inputs: ${explanation.why.directInputs.length} claim(s)`);
    for (const inp of explanation.why.directInputs) {
      const inpStatus = typeof inp.claim === "object" && inp.claim ? String((inp.claim as AnyObj).status ?? "?") : "?";
      lines.push(`    - ${inp.inputClaimId ?? "?"} (status: ${inpStatus})`);
    }
  } else {
    lines.push("  Direct inputs: (none — leaf claim)");
  }
  if (explanation.why.leafClaims.length > 0) {
    lines.push(`  Leaf claims: ${explanation.why.leafClaims.length} claim(s)`);
  }
  if (explanation.why.diagnostics.length > 0) {
    lines.push(`  Diagnostics: ${explanation.why.diagnostics.length}`);
    for (const d of explanation.why.diagnostics) {
      lines.push(`    - ${d.type ?? "?"}: ${d.message ?? ""}`);
    }
  }
  if (explanation.why.transparencyGaps.length > 0) {
    lines.push(`  Transparency gaps: ${explanation.why.transparencyGaps.length}`);
    for (const g of explanation.why.transparencyGaps) {
      lines.push(`    - [${g.severity ?? "?"}] ${g.type ?? "?"}: ${g.message ?? ""}`);
    }
  } else {
    lines.push("  Transparency gaps: (none)");
  }
  if (explanation.why.changeRecords.length > 0) {
    lines.push(`  Change records: ${explanation.why.changeRecords.length}`);
    for (const cr of explanation.why.changeRecords) {
      lines.push(`    - ${cr.action ?? "?"} at ${cr.at ?? cr.createdAt ?? "?"}`);
    }
  }

  console.log(lines.join("\n"));
  return 0;
}
// ─────────────────────────────────────────────────────────────────────────────


async function main(): Promise<number> {
  const p = parseArgs(process.argv.slice(2));
  if (!p.command) die("workflow-sidecar command is required");
  // F1 (#166 fix iteration 1): `liveness whoami` is a read-only, lock-free, write-free advisory
  // surface (see the `action === "whoami"` branch inside `liveness()` above) — it must never
  // acquire the workflow-sidecar lock, regardless of whether the artifact root already exists on
  // disk. Without this action-level bypass, `liveness` was blanket-included in the lock-routing
  // branch below, so `whoami` against an EXISTING artifact root would still resolve a real
  // lockRoot and go through `withLock`'s mkdir/lockdir path — the opposite of "genuinely
  // lock-free". This bypass mirrors `resolve-slug`'s existing empty-lockRoot special case
  // immediately below and is scoped to the `whoami` action only: `liveness status` (a read path)
  // keeps its pre-existing lock behavior unchanged (out of scope for this fix — see fix-plan
  // iteration 1, F1), and `liveness claim` / `heartbeat` / `release` (write paths) are untouched.
  const isLivenessWhoami = p.command === "liveness" && p.positional[0] === "whoami";
  // #320 AC1: `liveness verdict` is read-only and lock-free, exactly like `whoami` above — it
  // must never acquire the workflow-sidecar lock. Same bypass shape, scoped to the `verdict`
  // action only; `liveness status` (also a read path) keeps its pre-existing lock behavior.
  const isLivenessVerdict = p.command === "liveness" && p.positional[0] === "verdict";
  const lockRoot = (["ensure-session", "current", "dogfood-pass", "liveness"].includes(p.command) && !isLivenessWhoami && !isLivenessVerdict)
    ? (opt(p, "artifact-root") ? path.resolve(opt(p, "artifact-root")) : (p.command === "ensure-session" ? flowAgentsArtifactRoot() : defaultArtifactRootForRead()))
    : p.command === "record-agent-event" ? explicitArtifactRoot(p) : p.command === "claim" ? (p.positional[1] ? path.resolve(p.positional[1]) : "") : p.command === "resolve-slug" ? "" : (isLivenessWhoami || isLivenessVerdict) ? "" : p.positional[0] ? artifactDirFrom(p.positional[0]) : "";
  return withLock(lockRoot, ["ensure-session", "record-agent-event", "dogfood-pass"].includes(p.command), p.command, () => {
    switch (p.command) {
      case "ensure-session": return ensureSession(p);
      case "current": return current(p);
      case "record-agent-event": return recordAgentEvent(p);
      case "init-plan": return initPlan(p);
      case "record-evidence": return recordEvidence(p);
      case "record-gate-claim": return recordGateClaim(p);
      case "promote": return promote(p);
      case "advance-state": return advanceState(p);
      case "record-critique": return recordCritique(p);
      case "import-critique": return importCritique(p);
      case "record-release": return recordRelease(p);
      case "record-learning": return recordLearning(p);
      case "dogfood-pass": return dogfoodPass(p);
      case "gate-review": return gateReview(p);
      case "render-trust-panel": return renderTrustPanel(p);
      case "trust-mcp": return trustMcp(p);
      case "liveness": return liveness(p);
      case "claim": return claimLookup(p);
      case "resolve-slug": return resolveSlugCmd(p);
      case "seal-checkpoint": return sealCheckpoint(p);
      case "publish-delivery": return publishDeliveryCmd(p);
      case "reconcile-preflight": return reconcilePreflightCmd(p);
      case "verify-hold": return verifyHoldCmd(p);
      default: die(`unknown command: ${p.command}`);
    }
  });
}

// Run the CLI only when executed directly, not when imported as a library.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) {
  main().then((code) => process.exit(code)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
