import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateSchemaValue, type Issue } from "./mini-json-schema.js";
import { flowAgentsPackageRoot } from "./package-version.js";

type ReviewControlAnchors = {
  version: 1;
  execution_mode: "verification_appendix" | "entire_report";
  execution_sha256: string;
  plan_sha256: string;
  acceptance_sha256: string;
  scope_claims_sha256: string;
};

export type ReviewArtifact = {
  file: string;
  sha256: string;
  role?: "review_subject" | "review_context";
  source_file?: string;
  control_anchors?: ReviewControlAnchors;
};

export class ReviewControlDriftError extends Error {}

const MAX_CONTEXT_BYTES = 8 * 1024 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
let artifactSchema: Record<string, unknown> | undefined;

function digest(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// The appendix is informational verification output. Scope, DoD and criteria
// stay in the execution prefix and their canonical planning records.
function executionControl(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("execution report is not valid UTF-8");
  let fence: { character: string; length: number } | null = null;
  let appendix: number | null = null;
  let offset = 0;
  for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const line = raw.replace(/\r?\n$/, "");
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
    } else if (marker) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length };
    } else if (line === "## Verification Evidence") {
      if (appendix !== null) throw new Error("execution report has duplicate verification appendices");
      appendix = offset;
    } else if (appendix !== null && /^ {0,3}#{1,6}(?:\s|$)/.test(line)) {
      throw new Error("verification appendix must contain evidence, not additional control sections");
    }
    offset += raw.length;
  }
  if (fence) throw new Error("execution report has an unclosed code fence");
  if (appendix === null) throw new Error("execution report has no designated verification appendix");
  return text.slice(0, appendix).replace(/(?:\r?\n)+$/, "");
}

function optionalBytes(file: string): Buffer | null {
  try { return stableBytes(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function controlAnchors(sessionDir: string, report: Buffer, mode: ReviewControlAnchors["execution_mode"]): ReviewControlAnchors {
  const slug = path.basename(sessionDir);
  const plan = optionalBytes(path.join(sessionDir, `${slug}--plan-work.md`));
  const acceptanceBytes = optionalBytes(path.join(sessionDir, "acceptance.json"));
  let acceptance: unknown = "absent";
  if (acceptanceBytes) {
    const value = JSON.parse(acceptanceBytes.toString("utf8")) as Record<string, unknown>;
    if (!Array.isArray(value.criteria) || value.criteria.some(criterion => !criterion || typeof criterion !== "object"
      || typeof criterion.id !== "string" || typeof criterion.description !== "string")) throw new Error("review acceptance control is malformed");
    acceptance = { schema_version: value.schema_version, task_slug: value.task_slug, repo: value.repo,
      source_request: value.source_request, criteria: value.criteria.map(criterion => ({ id: criterion.id, description: criterion.description })) };
  }
  const bundleBytes = optionalBytes(path.join(sessionDir, "trust.bundle"));
  const scopes: unknown[] = [];
  if (bundleBytes) {
    const bundle = JSON.parse(bundleBytes.toString("utf8")) as Record<string, unknown>;
    const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
    if (!Array.isArray(bundle.claims) || !bundle.claims.every(isRecord)) throw new Error("review scope control bundle is malformed");
    for (const expectation of ["implementation-plan", "implementation-scope"]) {
      const matching = bundle.claims.filter(claim => {
        const metadata = isRecord(claim.metadata) ? claim.metadata : {};
        const gate = isRecord(metadata.gate_claim) ? metadata.gate_claim : {};
        return gate.expectation_id === expectation && claim.status !== "superseded"
          && claim.producerStatus !== "superseded" && !metadata.superseded_by;
      });
      if (matching.length > 1) throw new Error("review scope controls have ambiguous live claims");
      const claim = matching[0];
      const metadata = claim && isRecord(claim.metadata) ? claim.metadata : {};
      scopes.push(claim ? { expectation, id: claim.id, claimType: claim.claimType, subjectId: claim.subjectId, value: claim.value,
        fieldOrBehavior: claim.fieldOrBehavior, recorded_by: metadata.recorded_by, gate_claim: metadata.gate_claim,
        acceptance_contract: metadata.acceptance_contract, artifact_refs: metadata.artifact_refs } : { expectation, absent: true });
    }
  }
  return { version: 1, execution_mode: mode, execution_sha256: digest(mode === "verification_appendix" ? executionControl(report) : report),
    plan_sha256: digest(plan ? Buffer.concat([Buffer.from("present\0"), plan]) : "absent\0"),
    acceptance_sha256: digest(canonical(acceptance)), scope_claims_sha256: digest(canonical(scopes)) };
}

function relativeFile(projectRoot: string, absolute: string): string {
  return path.relative(projectRoot, absolute).replaceAll(path.sep, "/");
}

function executionReport(projectRoot: string, sessionDir: string): string {
  const slug = path.basename(sessionDir);
  if (!SLUG.test(slug) || path.resolve(sessionDir) !== path.join(path.resolve(projectRoot), ".kontourai", "flow-agents", slug)) {
    throw new Error("review context must belong to a canonical session");
  }
  return relativeFile(projectRoot, path.join(sessionDir, `${slug}--deliver.md`));
}

function assertDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("review context directory must be a non-symlink directory");
}

function stableBytes(file: string): Buffer {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_CONTEXT_BYTES) throw new Error("review context must be a bounded regular file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("review context changed while opening");
    const bytes = fs.readFileSync(fd);
    const settled = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (bytes.length > MAX_CONTEXT_BYTES || named.isSymbolicLink()
      || settled.dev !== opened.dev || settled.ino !== opened.ino || settled.size !== opened.size || settled.mtimeMs !== opened.mtimeMs
      || named.dev !== opened.dev || named.ino !== opened.ino || named.size !== opened.size || named.mtimeMs !== opened.mtimeMs) {
      throw new Error("review context changed while reading");
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** Only the workflow-owned execution report is context; every other ref remains a subject. */
export function captureExecutionReviewContext(projectRoot: string, sessionDir: string, artifacts: ReviewArtifact[]): ReviewArtifact[] {
  const report = executionReport(projectRoot, sessionDir);
  const output = artifacts.map((artifact): ReviewArtifact => {
    if (artifact.file !== report) return { ...artifact, role: "review_subject" };
    for (const directory of [path.join(projectRoot, ".kontourai"), path.dirname(sessionDir), sessionDir]) assertDirectory(directory);
    const bytes = stableBytes(path.join(projectRoot, report));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256) throw new Error("execution report changed before review context capture");
    try { executionControl(bytes); }
    catch { return { ...artifact, role: "review_subject", control_anchors: controlAnchors(sessionDir, bytes, "entire_report") }; }
    const anchors = controlAnchors(sessionDir, bytes, "verification_appendix");
    const contextDir = path.join(sessionDir, "review-context");
    fs.mkdirSync(contextDir, { recursive: true });
    assertDirectory(contextDir);
    const file = path.join(contextDir, `${sha256}.md`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o444);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    if (!stableBytes(file).equals(bytes)) throw new Error("captured review context does not match its content address");
    if (!isDeepStrictEqual(anchors, controlAnchors(sessionDir, stableBytes(path.join(projectRoot, report)), "verification_appendix"))) {
      throw new Error("review controls changed during context capture");
    }
    return { file: relativeFile(projectRoot, file), sha256, role: "review_context", source_file: report, control_anchors: anchors };
  });
  if (new Set(output.map(artifact => artifact.file)).size !== output.length) throw new Error("review artifacts must remain unique after context capture");
  return output;
}

/** Legacy refs are subjects. Context may never classify arbitrary source or control paths. */
export function assertReviewArtifactRole(projectRoot: string, artifact: Record<string, unknown>, sessionDir?: string): void {
  // Legacy refs retain their original subject behavior. Typed context is a
  // closed writer-owned contract with no caller-selected path exemption.
  if (artifact.role !== undefined) {
    artifactSchema ??= JSON.parse(fs.readFileSync(path.join(flowAgentsPackageRoot(), "schemas", "review-artifact.schema.json"), "utf8"));
    const issues: Issue[] = [];
    validateSchemaValue("review artifact", artifact, artifactSchema, "$", issues);
    if (issues.length > 0) throw new Error("review artifact role metadata is malformed");
  }
  if (artifact.role === undefined || artifact.role === "review_subject") {
    if (artifact.source_file !== undefined) throw new Error("review subjects cannot carry a context source path");
    if (artifact.control_anchors !== undefined) {
      if (artifact.role !== "review_subject" || typeof artifact.file !== "string") throw new Error("review subject control anchors are invalid");
      const parts = artifact.file.split("/");
      const slug = parts[2];
      if (parts.length !== 4 || parts[0] !== ".kontourai" || parts[1] !== "flow-agents" || !slug || !SLUG.test(slug)
        || parts[3] !== `${slug}--deliver.md`) throw new Error("only the owned execution subject can carry control anchors");
      const owner = path.join(path.resolve(projectRoot), ".kontourai", "flow-agents", slug);
      if (sessionDir && owner !== path.resolve(sessionDir)) throw new Error("review controls belong to another session");
      for (const directory of [path.join(projectRoot, ".kontourai"), path.dirname(owner), owner]) assertDirectory(directory);
      const current = controlAnchors(owner, stableBytes(path.join(projectRoot, artifact.file)), "entire_report");
      if (!isDeepStrictEqual(current, artifact.control_anchors)) throw new ReviewControlDriftError("reviewed execution, plan, acceptance or scope controls changed");
    }
    return;
  }
  if (artifact.role !== "review_context" || typeof artifact.source_file !== "string" || typeof artifact.file !== "string"
    || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("review artifact role is invalid");
  const parts = artifact.source_file.split("/");
  const slug = parts[2];
  if (parts.length !== 4 || parts[0] !== ".kontourai" || parts[1] !== "flow-agents"
    || !slug || !SLUG.test(slug) || parts[3] !== `${slug}--deliver.md`) throw new Error("only the owned execution report can be review context");
  const owner = path.join(path.resolve(projectRoot), ".kontourai", "flow-agents", slug);
  if (sessionDir && path.resolve(sessionDir) !== owner) throw new Error("review context belongs to another session");
  const expected = relativeFile(projectRoot, path.join(owner, "review-context", `${artifact.sha256}.md`));
  if (artifact.file !== expected) throw new Error("review context must reference its immutable captured version");
  for (const directory of [path.join(projectRoot, ".kontourai"), path.dirname(owner), owner, path.join(owner, "review-context")]) assertDirectory(directory);
  const digest = createHash("sha256").update(stableBytes(path.join(projectRoot, artifact.file))).digest("hex");
  if (digest !== artifact.sha256) throw new Error("captured review context digest changed");
  let current: ReviewControlAnchors;
  try { current = controlAnchors(owner, stableBytes(path.join(projectRoot, artifact.source_file)), "verification_appendix"); }
  catch (error) { throw new ReviewControlDriftError(`reviewed execution controls are unavailable or changed: ${error instanceof Error ? error.message : String(error)}`); }
  if (!isDeepStrictEqual(current, artifact.control_anchors)) throw new ReviewControlDriftError("reviewed execution, plan, acceptance or scope controls changed");
}
