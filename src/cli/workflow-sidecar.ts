#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type AnyObj = Record<string, any>;

export const statuses = new Set(["new", "planning", "planned", "in_progress", "blocked", "verifying", "verified", "needs_decision", "not_verified", "failed", "delivered", "accepted", "archived"]);
export const phases = ["idea", "backlog", "pickup", "planning", "execution", "verification", "goal_fit", "evidence", "release", "learning", "done"];
export const checkKinds = new Set(["build", "types", "lint", "test", "security", "diff", "browser", "runtime", "policy", "external"]);
export const checkStatuses = new Set(["pass", "fail", "not_verified", "skip"]);
export const verdicts = new Set(["pass", "partial", "fail", "not_verified"]);

function now(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function read(file: string): string { return fs.readFileSync(file, "utf8"); }
export function writeJson(file: string, payload: AnyObj): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`); }
function printJson(payload: AnyObj): void { console.log(JSON.stringify(payload).replace(/":/g, '": ').replace(/,"/g, ', "')); }
export function loadJson(file: string, fallback: AnyObj = {}): AnyObj { return fs.existsSync(file) ? JSON.parse(read(file)) : { ...fallback }; }
export function appendJsonl(file: string, payload: AnyObj): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(payload, Object.keys(payload).sort()).replace(/":/g, '": ').replace(/,"/g, ', "');
  fs.appendFileSync(file, `${line}\n`);
}
function die(message: string): never { throw new Error(message); }
function slugify(value: string, fallback: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback; }

// Optional Hachure trust-bundle validation. No-ops gracefully when hachure is not installed.
// Install hachure (^0.4.0) as an optional dependency to enable schema validation.
function tryLoadHachureValidator(): ((bundle: unknown) => { valid: boolean; errors: string[] }) | null {
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
    const ajv = new Ajv({ strict: false, allErrors: true });
    for (const [filename, schema] of Object.entries(schemas)) {
      if (filename === "trust-bundle.schema.json") continue;
      ajv.addSchema(schema, filename);
    }
    const trustBundleSchema = schemas["trust-bundle.schema.json"];
    if (!trustBundleSchema) return null;
    const validate = ajv.compile(trustBundleSchema);
    return (bundle: unknown) => {
      const valid = validate(bundle);
      if (valid) return { valid: true, errors: [] };
      const errors = ((validate as any).errors ?? []).map((err: any) => {
        const loc = err.instancePath || err.schemaPath || "";
        return `${loc} ${err.message ?? "invalid"}`.trim();
      });
      return { valid: false, errors };
    };
  } catch {
    return null;
  }
}
let _hachureValidator: ReturnType<typeof tryLoadHachureValidator> | undefined;
function getHachureValidator(): ReturnType<typeof tryLoadHachureValidator> {
  if (_hachureValidator === undefined) _hachureValidator = tryLoadHachureValidator();
  return _hachureValidator;
}

/**
 * Validate a Hachure trust.bundle against the canonical trust-bundle schema.
 * Returns `{ valid, errors, available }`. When the optional `hachure` dependency
 * is not installed, validation is unavailable and this returns
 * `{ valid: true, errors: [], available: false }` (fail-open) so callers can
 * choose to treat unvalidated bundles as acceptable or gate on `available`.
 * This is the same validator the sidecar writer uses for trust-backed evidence.
 */
export function validateTrustBundle(bundle: unknown): { valid: boolean; errors: string[]; available: boolean } {
  const validate = getHachureValidator();
  if (!validate) return { valid: true, errors: [], available: false };
  return { ...validate(bundle), available: true };
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
  generateClaimId: (subjectId: string, surface: string, fieldOrBehavior: string) => string;
  statusFunctionVersion: string;
  resolveInquiry: (
    bundle: Record<string, unknown>,
    inquiry: SurfaceInquiry,
    options?: { now?: Date },
  ) => SurfaceInquiryRecord;
};
let _surfaceModule: SurfaceModule | null | undefined; // undefined = not tried yet; null = unavailable
async function tryLoadSurface(): Promise<SurfaceModule | null> {
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
export async function buildTrustBundle(slug: string, timestamp: string, checks: AnyObj[], criteria: AnyObj[], critiques: AnyObj[], commandLog?: AnyObj[]): Promise<AnyObj | null> {
  const surface = await tryLoadSurface();
  if (!surface) return null;
  const { deriveClaimStatus, generateClaimId, statusFunctionVersion } = surface;

  const claims: AnyObj[] = [];
  const evidenceItems: AnyObj[] = [];
  const events: AnyObj[] = [];
  const ts = timestamp || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // One VerificationPolicy per distinct claimType, so status is policy-governed
  // (not derived against an empty policy set). Maximal-fidelity per ADR 0010.
  const policies = new Map<string, AnyObj>();
  const ensurePolicy = (claimType: string, impactLevel: string, requiredEvidence: string[]): AnyObj => {
    let p = policies.get(claimType);
    if (!p) {
      p = { id: `policy:${claimType}`, claimType, requiredEvidence, acceptanceCriteria: [`A verified verification event must support a ${claimType} claim.`], reviewAuthority: "system", validityRule: { kind: "manual" }, stalenessTriggers: [], conflictRules: [], impactLevel };
      policies.set(claimType, p);
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

  // Evidence checks → claims + evidence items + events. Capture is authoritative.
  for (const check of Array.isArray(checks) ? checks : []) {
    if (!check.id) continue;
    const subjectId = `${slug}/${check.id}`;
    const fieldOrBehavior = String(check.summary ?? check.id);
    const claimId = generateClaimId(subjectId, "flow-agents.workflow", fieldOrBehavior);
    const evId = `ev:${claimId}`;
    const claimType = `workflow.check.${check.kind ?? "external"}`;
    const policy = ensurePolicy(claimType, "high", ["test_output"]);

    const cmd = typeof check.command === "string" ? check.command.replace(/\s+/g, " ").trim() : "";
    const captured = cmd ? captureByCommand.get(cmd) : undefined;
    const effectiveStatus = captured ? captured.observedResult : String(check.status ?? "");
    const evStatus = checkStatusToEventStatus(effectiveStatus);

    const claimEvents: AnyObj[] = [];
    if (evStatus) {
      const evt: AnyObj = { id: `evt:${claimId}`, claimId, status: evStatus, actor: "flow-agents/workflow-sidecar", method: "validation", evidenceIds: [evId], createdAt: ts, verifiedAt: ts };
      events.push(evt);
      claimEvents.push(evt);
    }
    const evItem: AnyObj = { id: evId, claimId, evidenceType: "test_output", method: "validation", sourceRef: `${slug}/evidence.json`, excerptOrSummary: fieldOrBehavior, observedAt: ts, collectedBy: "flow-agents/workflow-sidecar", passing: effectiveStatus === "pass" };
    if (captured) {
      evItem.sourceRef = `${slug}/command-log.jsonl`;
      evItem.collectedBy = "flow-agents/evidence-capture";
      evItem.execution = { runner: "bash", label: cmd, isError: captured.observedResult === "fail", ...(captured.exitCode != null ? { exitCode: captured.exitCode } : {}) };
    }
    evidenceItems.push(evItem);
    const claimObj: AnyObj = { id: claimId, subjectType: "workflow-check", subjectId, surface: "flow-agents.workflow", claimType, fieldOrBehavior, value: effectiveStatus, createdAt: ts, updatedAt: ts, impactLevel: "high", verificationPolicyId: policy.id };
    const { status: derivedStatus } = deriveClaimStatus({ claim: claimObj as Record<string, unknown>, evidence: [evItem] as Record<string, unknown>[], events: claimEvents as Record<string, unknown>[], policies: [policy] as Record<string, unknown>[] });
    claims.push({ ...claimObj, status: derivedStatus });
  }

  // Acceptance criteria → claims + events
  for (const criterion of Array.isArray(criteria) ? criteria : []) {
    if (!criterion.id) continue;
    const subjectId = `${slug}/${criterion.id}`;
    const fieldOrBehavior = String(criterion.description ?? criterion.id);
    const claimId = generateClaimId(subjectId, "flow-agents.workflow", fieldOrBehavior);
    const claimType = "workflow.acceptance.criterion";
    const policy = ensurePolicy(claimType, "high", []);
    const evStatus = criterionStatusToEventStatus(String(criterion.status ?? ""));
    const claimEvents: AnyObj[] = [];
    if (evStatus) {
      const evt: AnyObj = { id: `evt:${claimId}`, claimId, status: evStatus, actor: "flow-agents/workflow-sidecar", method: "validation", evidenceIds: [], createdAt: ts, verifiedAt: ts };
      events.push(evt);
      claimEvents.push(evt);
    }
    const claimObj: AnyObj = { id: claimId, subjectType: "workflow-acceptance-criterion", subjectId, surface: "flow-agents.workflow", claimType, fieldOrBehavior, value: criterion.status, createdAt: ts, updatedAt: ts, impactLevel: "high", verificationPolicyId: policy.id };
    const { status: derivedStatus } = deriveClaimStatus({ claim: claimObj as Record<string, unknown>, evidence: [], events: claimEvents as Record<string, unknown>[], policies: [policy] as Record<string, unknown>[] });
    claims.push({ ...claimObj, status: derivedStatus });
  }

  // Critique entries → claims + events
  for (const c of Array.isArray(critiques) ? critiques : []) {
    if (!c.id) continue;
    const subjectId = `${slug}/${c.id}`;
    const fieldOrBehavior = String(c.summary ?? c.verdict ?? c.id);
    const claimId = generateClaimId(subjectId, "flow-agents.workflow", fieldOrBehavior);
    const claimType = "workflow.critique.review";
    const policy = ensurePolicy(claimType, "medium", []);
    const evStatus = critiqueToEventStatus(String(c.verdict ?? ""), c.findings ?? []);
    const claimEvents: AnyObj[] = [];
    if (evStatus) {
      const evt: AnyObj = { id: `evt:${claimId}`, claimId, status: evStatus, actor: "flow-agents/workflow-sidecar", method: "validation", evidenceIds: [], createdAt: ts, verifiedAt: ts };
      events.push(evt);
      claimEvents.push(evt);
    }
    const claimObj: AnyObj = { id: claimId, subjectType: "workflow-critique", subjectId, surface: "flow-agents.workflow", claimType, fieldOrBehavior, value: c.verdict, createdAt: ts, updatedAt: ts, impactLevel: "medium", verificationPolicyId: policy.id };
    const { status: derivedStatus } = deriveClaimStatus({ claim: claimObj as Record<string, unknown>, evidence: [], events: claimEvents as Record<string, unknown>[], policies: [policy] as Record<string, unknown>[] });
    claims.push({ ...claimObj, status: derivedStatus });
  }

  return {
    schemaVersion: 3,
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
export async function writeTrustBundle(dir: string, slug: string, timestamp: string, checks: AnyObj[], criteria: AnyObj[], critiques: AnyObj[]): Promise<{ written: boolean; errors: string[] }> {
  try {
    // Fold the deterministic capture log (PostToolUse evidence-capture) into the
    // bundle so capture is authoritative over claimed status. Best-effort read.
    let commandLog: AnyObj[] = [];
    try {
      const raw = fs.readFileSync(path.join(dir, "command-log.jsonl"), "utf8");
      commandLog = raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l) as AnyObj; } catch { return null; } }).filter((x): x is AnyObj => x !== null);
    } catch { /* no capture log — fine */ }
    const bundle = await buildTrustBundle(slug, timestamp, checks, criteria, critiques, commandLog);
    if (!bundle) return { written: false, errors: [] }; // Surface unavailable — fail-open, skip write
    const result = validateTrustBundle(bundle);
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
  if (!explicit) return path.resolve(configuredRoot || ".flow-agents");
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

function writeCurrent(root: string, dir: string, timestamp: string, owner: string, source: string): void {
  writeJson(path.join(root, "current.json"), {
    schema_version: "1.0",
    active_slug: path.basename(dir),
    artifact_dir: path.relative(root, dir) || ".",
    updated_at: timestamp,
    owner,
    source,
    active_agents: [],
  });
}
function loadCurrent(root: string): AnyObj | null {
  const file = path.join(root, "current.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(read(file));
}
function currentDir(root: string): string | null {
  const c = loadCurrent(root);
  if (!c) return null;
  const dir = path.resolve(root, c.artifact_dir ?? c.active_slug ?? "");
  return fs.existsSync(dir) ? dir : null;
}
function updateCurrentAgent(root: string, dir: string, agentId: string, status: string, timestamp: string): void {
  const cur = loadCurrent(root);
  if (!cur || path.resolve(root, cur.artifact_dir ?? "") !== path.resolve(dir)) return;
  const active = Array.isArray(cur.active_agents) ? cur.active_agents.filter((a: AnyObj) => a.agent_id !== agentId) : [];
  if (status === "active" || status === "blocked") active.push({ agent_id: agentId, status, updated_at: timestamp });
  cur.active_agents = active;
  cur.updated_at = timestamp;
  writeJson(path.join(root, "current.json"), cur);
}

function initSidecars(dir: string, slug: string, sourceRequest: string, summary: string, nextAction: string, timestamp: string, markdown?: string): void {
  const criteria = markdown ? definitionAcceptanceLines(markdown).map(parseCriterion) : [];
  writeJson(path.join(dir, "state.json"), {
    ...sidecarBase(slug), status: "planned", phase: "planning", created_at: timestamp, updated_at: timestamp,
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

function ensureSession(p: ReturnType<typeof parseArgs>): number {
  const root = path.resolve(opt(p, "artifact-root", ".flow-agents"));
  const slug = opt(p, "task-slug") || die("--task-slug is required");
  const dir = sessionDirFor(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = opt(p, "timestamp", now());
  let md = fs.existsSync(path.join(dir, `${slug}--deliver.md`)) ? read(path.join(dir, `${slug}--deliver.md`)) : "";
  if (!md) {
    md = `# ${opt(p, "title", slug)}\n\nbranch: main\nworktree: main\ncreated: ${timestamp}\nstatus: planning\ntype: deliver\niteration: 1\n\n## Plan\n\n${opt(p, "summary", "")}\n\n## Definition Of Done\n\n- **User outcome:** ${opt(p, "summary", "Workflow session is durable.")}\n- **Scope:** Workflow session artifacts and sidecars.\n- **Acceptance criteria:**\n${opts(p, "criterion").map((c) => `  - [ ] ${c} - Evidence: pending.`).join("\n")}\n- **Usefulness checks:**\n  - [ ] User-facing workflow is documented or discoverable\n- **Stop-short risks:** Workflow artifacts could drift.\n- **Durable docs target:** not needed\n- **Sandbox mode:** local-edit\n\n## Execution Progress\n\n- [ ] Session initialized.\n\n## Verification Report\n\nBuild: [NOT_VERIFIED] Verification has not run yet.\n\n### Acceptance Criteria\n- [NOT_VERIFIED] Verification has not run yet - Evidence: pending workflow execution and checks.\n\n### Verdict: NOT_VERIFIED\n\n## Goal Fit Gate\n\n- [ ] Original user goal restated\n\n## Final Acceptance\n\n- [ ] CI/relevant checks passed or local equivalent recorded\n`;
    fs.writeFileSync(path.join(dir, `${slug}--deliver.md`), md);
  }
  if (!fs.existsSync(path.join(dir, "state.json")) || !fs.existsSync(path.join(dir, "acceptance.json")) || !fs.existsSync(path.join(dir, "handoff.json"))) {
    initSidecars(dir, slug, opt(p, "source-request"), opt(p, "summary"), opt(p, "next-action", "Continue."), timestamp, md);
  }
  writeCurrent(root, dir, timestamp, "workflow-sidecar", "ensure-session");
  console.log(dir);
  return 0;
}

function current(p: ReturnType<typeof parseArgs>): number {
  const root = path.resolve(opt(p, "artifact-root", ".flow-agents"));
  const dir = currentDir(root);
  if (!dir) die("no current workflow session is recorded");
  const format = opt(p, "format", "path");
  console.log(format === "slug" ? path.basename(dir) : dir);
  return 0;
}

function recordAgentEvent(p: ReturnType<typeof parseArgs>): number {
  const hasExplicitRoot = !!opt(p, "artifact-root");
  const root = explicitArtifactRoot(p);
  const explicit = opt(p, "artifact-dir");
  const dir = explicit ? path.resolve(explicit) : currentDir(root);
  if (!dir || !fs.existsSync(dir)) die("artifact directory does not exist");
  if (explicit && fs.lstatSync(dir).isSymbolicLink()) die(`artifact directory must not be a symlink: ${dir}`);
  if (hasExplicitRoot) requireArtifactDirUnderRoot(dir, root);
  const timestamp = opt(p, "timestamp", now());
  const agent = validateAgentId(opt(p, "agent-id"));
  const event = { timestamp, agent_id: agent, kind: opt(p, "kind", "note"), status: opt(p, "status", "info"), summary: opt(p, "summary"), ...(opt(p, "ref") ? { ref: opt(p, "ref") } : {}) };
  appendJsonl(path.join(dir, "agents", agent, "events.jsonl"), event);
  updateCurrentAgent(root, dir, agent, event.status, timestamp);
  return 0;
}

function initPlan(p: ReturnType<typeof parseArgs>): number {
  const artifact = p.positional[0] || die("artifact path is required");
  const dir = artifactDirFrom(artifact);
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  initSidecars(dir, slug, opt(p, "source-request"), opt(p, "summary"), opt(p, "next-action"), opt(p, "timestamp", now()), read(artifact));
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
  if (!checkKinds.has(check.kind)) die("kind must be one of: build, types, lint, test, security, diff, browser, runtime, policy, external");
  if (!checkStatuses.has(check.status)) die("status must be one of: pass, fail, not_verified, skip");
  if (Array.isArray(check.standard_refs)) for (const ref of check.standard_refs) if (!["junit", "sarif", "coverage", "veritas"].includes(ref.standard)) die("standard must be one of");
  if (check.artifact_refs) check.artifact_refs = normalizeEvidenceRefs(check.artifact_refs, "artifact_refs");
  if (check.surface_trust_refs) check.surface_trust_refs = normalizeSurfaceRefs(check.surface_trust_refs);
  return check;
}
function normalizeSurfaceRefs(refs: any): AnyObj[] {
  if (!Array.isArray(refs)) die("surface_trust_refs must be an array");
  const hachureValidate = getHachureValidator();
  return refs.map((ref) => {
    const keys = JSON.stringify(ref).match(/"([^"]+)":/g) ?? [];
    for (const key of keys.map((k) => k.slice(1, -2))) if (key.toLowerCase().includes("veritas")) die(`unsupported field in Surface trust ref: ${key}`);
    const out = { ...ref };
    // trust.bundle is the canonical Hachure-aligned artifact kind; TrustReport/Trust Snapshot are legacy aliases
    if (!["trust.bundle", "TrustReport", "Trust Snapshot"].includes(out.artifact_kind)) die("artifact_kind must be one of: trust.bundle, TrustReport, Trust Snapshot");
    // When hachure is installed, validate the referenced trust artifact if it is a local file
    if (hachureValidate && out.artifact_ref && typeof out.artifact_ref === "string" && fs.existsSync(out.artifact_ref)) {
      try {
        const bundle = JSON.parse(fs.readFileSync(out.artifact_ref, "utf8"));
        const result = hachureValidate(bundle);
        if (!result.valid) {
          const errorSummary = result.errors.slice(0, 3).join("; ");
          die(`trust.bundle artifact at ${out.artifact_ref} failed Hachure schema validation: ${errorSummary}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("failed Hachure schema validation")) throw err;
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
function surfaceCheckFromArtifact(file: string, index: number): AnyObj {
  const raw = JSON.parse(read(file));
  const lower = JSON.stringify(raw).toLowerCase();
  let ref: AnyObj;
  if (lower.includes("provider") && lower.includes("absent")) {
    ref = { artifact_kind: "trust.bundle", artifact_ref: file, gate_id: "provider.unavailable", claim_type: "builder.trust.bundle", claim_status: "unknown", subject: "builder-kit", freshness: { status: "unknown", summary: "No trust provider is configured" }, authority: { producer: "unknown", summary: "No trust provider is configured" }, integrity: { status: "unknown", summary: "Unknown" }, status: "not_verified", summary: "No trust provider is configured" };
  } else if (lower.includes("artifact") && lower.includes("absent")) {
    ref = { artifact_kind: "trust.bundle", artifact_ref: file, gate_id: "artifact.unavailable", claim_type: "builder.trust.bundle", claim_status: "unknown", subject: "builder-kit", freshness: { status: "unknown", summary: "Artifact not readable" }, authority: { producer: "unknown", summary: "Artifact not readable" }, integrity: { status: "unknown", summary: "Artifact not readable" }, status: "not_verified", summary: "artifact not readable" };
  } else {
    const claimStatus = lower.includes("rejected") ? "rejected" : "accepted";
    const freshness = lower.includes("stale") ? "stale" : "fresh";
    const producer = lower.includes("missing-authority") ? "unknown" : "surface-local";
    const integrity = lower.includes("mismatch") ? "mismatch" : "matched";
    // Use trust.bundle as the canonical Hachure-aligned artifact_kind for all trust-backed evidence refs
    ref = { artifact_kind: "trust.bundle", artifact_ref: file, gate_id: "builder.trust.bundle", claim_type: "builder.trust.bundle", claim_status: claimStatus, subject: "builder-kit", freshness: { status: freshness, summary: freshness === "fresh" ? "fresh" : "not currently verifiable" }, authority: { producer, summary: producer === "unknown" ? "missing authority" : "Local Surface trust producer." }, integrity: { status: integrity, summary: integrity === "matched" ? "matched" : "integrity mismatch" } };
    ref.status = deriveSurfaceStatus(ref);
    ref.summary = ref.status === "pass" ? "accepted" : ref.status === "not_verified" ? "not currently verifiable" : (claimStatus === "rejected" ? "rejected" : producer === "unknown" ? "missing authority" : "integrity mismatch");
  }
  return { id: `surface-trust-${index + 1}`, kind: "policy", status: ref.status, summary: ref.summary, surface_trust_refs: [ref] };
}
function updateAcceptance(dir: string, verdict: string): void {
  const file = path.join(dir, "acceptance.json");
  if (!fs.existsSync(file)) return;
  const data = loadJson(file);
  const status = verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "not_verified";
  if (Array.isArray(data.criteria)) data.criteria = data.criteria.map((c: AnyObj) => ({ ...c, status }));
  data.goal_fit = { ...(data.goal_fit ?? {}), status, summary: verdict === "pass" ? "Evidence passed." : "Evidence requires follow-up." };
  writeJson(file, data);
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
async function recordEvidence(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const verdict = opt(p, "verdict") || die("--verdict is required");
  if (!verdicts.has(verdict)) die("verdict must be one of: pass, partial, fail, not_verified");
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const checks = [...opts(p, "check-json").map((v) => normalizeCheck(parseJson(v, "--check-json"))), ...opts(p, "surface-trust-json").map(surfaceCheckFromArtifact)];
  if (!checks.length && opts(p, "surface-trust-json").length === 0) die("record-evidence requires at least one --check-json or --surface-trust-json");
  validateAcceptanceEvidenceRefs(dir);
  const payload = { ...sidecarBase(slug), verdict, checks, not_verified_gaps: opts(p, "gap") };
  // Phase 4a inversion: build bundle from raw inputs FIRST; emit bespoke sidecars as back-compat projections after.
  const ts = opt(p, "timestamp", now());
  const _existingAcceptance = loadJson(path.join(dir, "acceptance.json"));
  const _existingCriteria: AnyObj[] = Array.isArray(_existingAcceptance.criteria) ? _existingAcceptance.criteria : [];
  const _criteriaStatus = verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "not_verified";
  const _criteriaForBundle: AnyObj[] = _existingCriteria.map((c: AnyObj) => ({ ...c, status: _criteriaStatus }));
  await writeTrustBundle(dir, slug, ts, checks, _criteriaForBundle, []);
  // Back-compat projections: write evidence.json and update acceptance.json (same content as before)
  writeJson(path.join(dir, "evidence.json"), payload);
  updateAcceptance(dir, verdict);
  const stateStatus = verdict === "pass" ? "verified" : verdict === "fail" ? "failed" : "not_verified";
  writeState(dir, slug, stateStatus, "verification", ts, "Evidence recorded.");
  return 0;
}

function diagnostic(dir: string, code: string, summary: string): never {
  const payload = { timestamp: now(), code, summary };
  appendJsonl(path.join(dir, "transition-diagnostics.jsonl"), payload);
  die(`${code}: ${summary}`);
}
function advanceState(p: ReturnType<typeof parseArgs>): number {
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
  if (flow === "builder.build" && prev.phase === "verification" && phase === "execution") {
    const reason = opt(p, "route-back-reason");
    if (!reason) diagnostic(dir, "route_back_reason_required", "Builder Kit route-back requires implementation_defect or equivalent reason.");
    const file = path.join(dir, "transition-attempts.json");
    const attempts = loadJson(file);
    const key = `verification->execution:${reason}`;
    const count = attempts[key]?.count ?? 0;
    if (count >= 3) diagnostic(dir, "route_back_attempts_exceeded", "Builder Kit route-back attempts exceeded.");
    attempts[key] = { count: count + 1, reason, updated_at: opt(p, "timestamp", now()) };
    writeJson(file, attempts);
  }
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const timestamp = opt(p, "timestamp", now());
  writeState(dir, slug, status, phase, timestamp, opt(p, "summary"));
  writeJson(path.join(dir, "handoff.json"), { ...loadJson(path.join(dir, "handoff.json")), ...sidecarBase(slug), summary: opt(p, "summary"), current_state_ref: "state.json", next_steps: [opt(p, "next-action")].filter(Boolean), blockers: [], warnings: [] });
  return 0;
}

export function normalizeFinding(raw: AnyObj): AnyObj {
  if (raw.file_refs !== undefined && !Array.isArray(raw.file_refs)) die("file_refs must be an array");
  return raw;
}
function critiqueStatus(critiques: AnyObj[], required: boolean): string {
  if (!required && critiques.length === 0) return "not_required";
  if (critiques.some((c) => c.verdict === "fail" || (Array.isArray(c.findings) && c.findings.some((f: AnyObj) => f.status === "open")))) return "fail";
  return "pass";
}
async function recordCritique(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const existing = loadJson(path.join(dir, "critique.json"), { critiques: [] });
  const critique = { id: opt(p, "id") || "review", reviewer: opt(p, "reviewer", "tool-code-reviewer"), reviewed_at: opt(p, "timestamp", now()), verdict: opt(p, "verdict", "pass"), summary: opt(p, "summary"), artifact_refs: opts(p, "artifact-ref"), findings: opts(p, "finding-json").map((v) => normalizeFinding(parseJson(v, "--finding-json"))) };
  const critiques = [...(Array.isArray(existing.critiques) ? existing.critiques : []), critique];
  if (critique.verdict === "pass" && critique.findings.some((f: AnyObj) => f.status === "open")) die("required critique must pass");
  // Phase 4a inversion: build bundle from raw inputs FIRST; emit bespoke sidecar as back-compat projection after.
  const _critiqueEvChecks: AnyObj[] = Array.isArray(loadJson(path.join(dir, "evidence.json")).checks) ? loadJson(path.join(dir, "evidence.json")).checks : [];
  const _critiqueAccCriteria: AnyObj[] = Array.isArray(loadJson(path.join(dir, "acceptance.json")).criteria) ? loadJson(path.join(dir, "acceptance.json")).criteria : [];
  await writeTrustBundle(dir, slug, critique.reviewed_at, _critiqueEvChecks, _critiqueAccCriteria, critiques);
  // Back-compat projection: write critique.json (same content as before)
  writeJson(path.join(dir, "critique.json"), { ...sidecarBase(slug), status: critiqueStatus(critiques, true), required: true, updated_at: critique.reviewed_at, critiques });
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
function recordRelease(p: ReturnType<typeof parseArgs>): number {
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
  // Phase 4a inversion: build bundle from raw inputs (re-read from on-disk sidecars).
  const _learningChecks: AnyObj[] = Array.isArray(loadJson(path.join(dir, "evidence.json")).checks) ? loadJson(path.join(dir, "evidence.json")).checks : [];
  const _learningCriteria: AnyObj[] = Array.isArray(loadJson(path.join(dir, "acceptance.json")).criteria) ? loadJson(path.join(dir, "acceptance.json")).criteria : [];
  const _learningCritiques: AnyObj[] = Array.isArray(loadJson(path.join(dir, "critique.json")).critiques) ? loadJson(path.join(dir, "critique.json")).critiques : [];
  await writeTrustBundle(dir, slug, timestamp, _learningChecks, _learningCriteria, _learningCritiques);
  return 0;
}
function evidenceClean(dir: string): boolean {
  const e = loadJson(path.join(dir, "evidence.json"), {});
  return e.verdict === "pass" && Array.isArray(e.checks) && e.checks.length > 0 && e.checks.every((c: AnyObj) => {
    if (!(c.status === "pass" || c.status === "skip")) return false;
    return !Array.isArray(c.standard_refs) || c.standard_refs.every((r: AnyObj) => ["junit", "sarif", "coverage", "veritas"].includes(r.standard));
  });
}
function critiqueClean(dir: string): boolean {
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
  const root = path.resolve(opt(p, "artifact-root", ".flow-agents"));
  const dir = path.resolve(opt(p, "artifact-dir") || currentDir(root) || "");
  requireArtifactDirUnderRoot(dir, root);
  assertExistingLearningValid(dir);
  const verdict = opt(p, "verdict");
  if (verdict === "pass") {
    const checks = opts(p, "check-json").map((v) => normalizeCheck(parseJson(v, "--check-json")));
    if (checks.some((c) => c.status !== "pass" && c.status !== "skip")) die("clean evidence requires all non-skipped checks to pass");
    if (fs.existsSync(path.join(dir, "evidence.json")) && !evidenceClean(dir)) die("cannot mark clean without passing evidence");
    if (!fs.existsSync(path.join(dir, "evidence.json")) && checks.length === 0) die("cannot mark clean without passing evidence");
    if (p.flags.has("require-critique") || opt(p, "release-decision")) {
      const newCritiqueVerdict = opt(p, "critique-verdict", "pass");
      for (const value of opts(p, "finding-json")) normalizeFinding(parseJson(value, "--finding-json"));
      if (newCritiqueVerdict !== "pass") die(opt(p, "release-decision") ? "requires clean critique" : "requires clean critique before recording pass evidence");
      if (!opt(p, "critique-id") && !critiqueClean(dir)) die("requires passing critique");
      if (fs.existsSync(path.join(dir, "critique.json")) && !critiqueClean(dir)) die(opt(p, "release-decision") ? "requires clean critique" : "requires clean critique before recording pass evidence");
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
  const _slug = taskSlugFor(dir, opt(p, "task-slug")); const _ts = opt(p, "timestamp", now());
  // Phase 4a inversion: build bundle from raw inputs (re-read from on-disk sidecars).
  const _dogfoodChecks: AnyObj[] = Array.isArray(loadJson(path.join(dir, "evidence.json")).checks) ? loadJson(path.join(dir, "evidence.json")).checks : [];
  const _dogfoodCriteria: AnyObj[] = Array.isArray(loadJson(path.join(dir, "acceptance.json")).criteria) ? loadJson(path.join(dir, "acceptance.json")).criteria : [];
  const _dogfoodCritiques: AnyObj[] = Array.isArray(loadJson(path.join(dir, "critique.json")).critiques) ? loadJson(path.join(dir, "critique.json")).critiques : [];
  await writeTrustBundle(dir, _slug, _ts, _dogfoodChecks, _dogfoodCriteria, _dogfoodCritiques);
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
  surface: string;
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

/** The gate block signal read from .flow-agents/.goal-fit-block-streak.json */
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
 * Read the gate block signal from .flow-agents/.goal-fit-block-streak.json
 * (written by scripts/hooks/stop-goal-fit.js when block mode fires).
 * The file sits at <artifact-root>/.goal-fit-block-streak.json — one level
 * above the session artifact dir. Fail-open: returns { blocked: false } when
 * the file is absent or unreadable.
 *
 * @param artifactRoot  The .flow-agents root dir (parent of session slug dir).
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
 * lives one level above the session slug dir (the .flow-agents root).
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

  // Read gate block signal from .flow-agents root (one level above session dir)
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
  const root = path.resolve(opt(p, "artifact-root", ".flow-agents"));
  const dir = p.positional[0] ? artifactDirFrom(p.positional[0]) : currentDir(root);
  if (!dir) die("render-trust-panel requires a workflow dir or a recorded current session");
  let bundle: AnyObj | null = null;
  try { bundle = JSON.parse(fs.readFileSync(path.join(dir!, "trust.bundle"), "utf8")); } catch { bundle = null; }
  if (!bundle) die(`no trust.bundle at ${path.join(dir!, "trust.bundle")} — run record-evidence first`);
  const surface = (await import("@kontourai/surface")) as unknown as { buildTrustReport?: (b: unknown) => AnyObj };
  if (typeof surface.buildTrustReport !== "function") die("@kontourai/surface buildTrustReport unavailable — cannot derive the trust report");
  const report = surface.buildTrustReport!(bundle);
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
    process.stderr.write(`# To view a task's trust inline, call surface_summary with path=<.flow-agents/<slug>/trust.bundle>.\n`);
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
// ─────────────────────────────────────────────────────────────────────────────


async function main(): Promise<number> {
  const p = parseArgs(process.argv.slice(2));
  if (!p.command) die("workflow-sidecar command is required");
  const lockRoot = ["ensure-session", "current", "dogfood-pass"].includes(p.command) ? path.resolve(opt(p, "artifact-root", ".flow-agents")) : p.command === "record-agent-event" ? explicitArtifactRoot(p) : p.positional[0] ? artifactDirFrom(p.positional[0]) : "";
  return withLock(lockRoot, ["ensure-session", "record-agent-event", "dogfood-pass"].includes(p.command), p.command, () => {
    switch (p.command) {
      case "ensure-session": return ensureSession(p);
      case "current": return current(p);
      case "record-agent-event": return recordAgentEvent(p);
      case "init-plan": return initPlan(p);
      case "record-evidence": return recordEvidence(p);
      case "advance-state": return advanceState(p);
      case "record-critique": return recordCritique(p);
      case "import-critique": return importCritique(p);
      case "record-release": return recordRelease(p);
      case "record-learning": return recordLearning(p);
      case "dogfood-pass": return dogfoodPass(p);
      case "gate-review": return gateReview(p);
      case "render-trust-panel": return renderTrustPanel(p);
      case "trust-mcp": return trustMcp(p);
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
