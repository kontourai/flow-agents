/**
 * Knowledge Kit Context Check — deterministic, revision-bound Living Context.
 *
 * This standalone adapter recalls claim manifests from an exact Git commit and
 * reconciles their declared affected surfaces against a bounded change set. It
 * deliberately does not use the working tree as a fallback and can write only
 * to an explicitly supplied proposal directory. It is not a Surface trust
 * derivation and it makes no effectiveness claim.
 *
 * @module context-check
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const REVISION_RE = /^[0-9a-f]{40}$/i;
const CLAIM_STATUS = new Set(["current", "superseded", "unverifiable"]);

function error(code, message) {
  const value = new Error(message);
  value.code = code;
  return value;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeRelativePath(value, field) {
  if (!isNonEmptyString(value) || path.isAbsolute(value) || value.split(/[\\/]+/).includes("..")) {
    throw error("INVALID_PATH", `${field} must be a non-empty repository-relative path`);
  }
  return value.replace(/\\/g, "/");
}

function git(repoRoot, args) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    throw error("REVISION_READ_FAILED", `Context Check could not read the requested Git revision: ${cause.stderr?.toString().trim() || cause.message}`);
  }
}

/** Validate the portable, revision-bound Context Check input contract. */
export function validateContextCheckInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["input must be an object"];
  if (input.schema_version !== "1.0") errors.push("schema_version must be '1.0'");
  for (const field of ["workspace", "repository", "target_audience"]) if (!isNonEmptyString(input[field])) errors.push(`${field} must be a non-empty string`);
  if (!isNonEmptyString(input.revision) || !REVISION_RE.test(input.revision)) errors.push("revision must be an exact 40-character Git commit SHA");
  const changed = Array.isArray(input.changed_surfaces) ? input.changed_surfaces : input.diff?.paths;
  if (!Array.isArray(changed) || changed.length === 0 || changed.some((surface) => !isNonEmptyString(surface))) errors.push("changed_surfaces or diff.paths must be a non-empty string array");
  if (!Array.isArray(input.knowledge_roots) || input.knowledge_roots.length === 0) errors.push("knowledge_roots must be a non-empty array");
  else for (const root of input.knowledge_roots) {
    if (!root || typeof root !== "object" || !isNonEmptyString(root.id) || root.provider !== "git-repo") errors.push("each knowledge root requires id and provider 'git-repo'");
    try { safeRelativePath(root?.manifest_path, "knowledge_roots[].manifest_path"); } catch (cause) { errors.push(cause.message); }
  }
  if (input.claim_ids !== undefined && (!Array.isArray(input.claim_ids) || input.claim_ids.some((id) => !isNonEmptyString(id)))) errors.push("claim_ids must be an array of non-empty strings when supplied");
  return errors;
}

/** Validate the stable result envelope without turning this adapter into a trust authority. */
export function validateContextCheckResult(result) {
  const errors = [];
  if (!result || result.schema_version !== "1.0") errors.push("result schema_version must be '1.0'");
  if (result?.flow !== "knowledge.context-check") errors.push("result flow must be 'knowledge.context-check'");
  if (!Array.isArray(result?.recalls) || !Array.isArray(result?.reconciliation) || !Array.isArray(result?.proposals)) errors.push("result must contain recalls, reconciliation, and proposals arrays");
  if (!["pass", "not_verified"].includes(result?.verdict)) errors.push("result verdict must be pass or not_verified");
  return errors;
}

function readClaimsAtRevision(repoRoot, revision, root) {
  const manifestPath = safeRelativePath(root.manifest_path, "knowledge_roots[].manifest_path");
  const bytes = git(repoRoot, ["show", `${revision}:${manifestPath}`]);
  let parsed;
  try { parsed = JSON.parse(bytes); } catch { throw error("INVALID_CLAIM_MANIFEST", `${manifestPath} at ${revision} is not valid JSON`); }
  if (!Array.isArray(parsed.claims)) throw error("INVALID_CLAIM_MANIFEST", `${manifestPath} must contain a claims array`);
  return parsed.claims.map((claim, index) => normalizeClaim(claim, root, manifestPath, index));
}

function normalizeClaim(claim, root, manifestPath, index) {
  const prefix = `${manifestPath}: claims[${index}]`;
  if (!claim || typeof claim !== "object" || !isNonEmptyString(claim.id) || !isNonEmptyString(claim.claim)) throw error("INVALID_CLAIM_MANIFEST", `${prefix} requires id and claim`);
  if (!CLAIM_STATUS.has(claim.status)) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.status must be current, superseded, or unverifiable`);
  if (!claim.authority || !isNonEmptyString(claim.authority.citation)) throw error("INVALID_CLAIM_MANIFEST", `${prefix} requires authoritative citation`);
  const authorityPath = safeRelativePath(claim.authority.path, `${prefix}.authority.path`);
  const owningPath = safeRelativePath(claim.owning_source?.path, `${prefix}.owning_source.path`);
  if (!Array.isArray(claim.affected_surfaces) || claim.affected_surfaces.some((surface) => !isNonEmptyString(surface))) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.affected_surfaces must be a string array`);
  return { ...claim, authority: { ...claim.authority, path: authorityPath }, owning_source: { ...claim.owning_source, path: owningPath }, root, manifestPath };
}

function recall(claim, revision) {
  return {
    claim_id: claim.id,
    claim: claim.claim,
    status: claim.status,
    ...(claim.superseded_by ? { superseded_by: claim.superseded_by } : {}),
    authority: { ...claim.authority, revision },
    retrieval_provenance: {
      provider: claim.root.provider,
      knowledge_root: claim.root.id,
      manifest_path: claim.manifestPath,
      revision,
      read_mode: "git-show"
    }
  };
}

function matchingSurface(claim, changedSurfaces) {
  return changedSurfaces.find((surface) => claim.affected_surfaces.includes(surface));
}

function reconciliationFor(claim, changedSurfaces, revision) {
  const affectedSurface = matchingSurface(claim, changedSurfaces);
  if (!affectedSurface) return { claim_id: claim.id, status: "clean", affected_surfaces: [] };
  if (claim.status === "unverifiable") return { claim_id: claim.id, status: "unverifiable", affected_surfaces: [affectedSurface], reason: "claim_source_unverifiable" };
  return {
    claim_id: claim.id,
    status: claim.status === "superseded" ? "stale" : "contradicted",
    affected_surfaces: [affectedSurface],
    authority: { ...claim.authority, revision }
  };
}

function proposalFor(claim, reconciliation, revision) {
  if (reconciliation.status === "clean" || reconciliation.status === "unverifiable") return null;
  return {
    schema_version: "1.0",
    id: `context-update-${claim.id}`,
    status: "proposed",
    kind: "context-update",
    claim_id: claim.id,
    route: {
      owner: claim.owning_source.owner || "owning-source",
      path: claim.owning_source.path
    },
    rationale: `Claim '${claim.id}' is ${reconciliation.status} by ${reconciliation.affected_surfaces.join(", ")} at ${revision}.`,
    provenance: { authority: { ...claim.authority, revision }, retrieval: "git-show" }
  };
}

function writeResult(proposalDir, result) {
  if (!isNonEmptyString(proposalDir)) throw error("PROPOSAL_DIR_REQUIRED", "Context Check writes require an explicit proposalDir");
  const outputRoot = path.resolve(proposalDir);
  fs.mkdirSync(outputRoot, { recursive: true });
  const written = [];
  const write = (relative, value) => {
    const destination = path.resolve(outputRoot, relative);
    if (!destination.startsWith(`${outputRoot}${path.sep}`)) throw error("PROPOSAL_PATH_ESCAPE", `proposal write escaped proposalDir: ${relative}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    written.push(relative);
  };
  write("context-check-result.json", result);
  for (const proposal of result.proposals) write(path.join("proposals", `${proposal.id}.json`), proposal);
  return written;
}

/**
 * Run a deterministic Context Check.
 *
 * The only repository reads are `git show <resolved-sha>:<manifest-path>`.
 * `write: true` requires an explicit proposalDir and never modifies repoRoot.
 */
export function runContextCheck({ repoRoot, input, proposalDir, write = true } = {}) {
  const inputErrors = validateContextCheckInput(input);
  if (inputErrors.length) throw error("INVALID_CONTEXT_CHECK_INPUT", inputErrors.join("; "));
  if (!isNonEmptyString(repoRoot)) throw error("REPO_ROOT_REQUIRED", "runContextCheck requires repoRoot");
  const resolvedRoot = fs.realpathSync(repoRoot);
  const revision = git(resolvedRoot, ["rev-parse", "--verify", `${input.revision}^{commit}`]).toLowerCase();
  const changedSurfaces = [...new Set(input.changed_surfaces || input.diff.paths)];
  const claims = input.knowledge_roots.flatMap((root) => readClaimsAtRevision(resolvedRoot, revision, root));
  const requestedIds = input.claim_ids ? new Set(input.claim_ids) : new Set(claims.map((claim) => claim.id));
  const selected = claims.filter((claim) => requestedIds.has(claim.id));
  const recalls = selected.length ? selected.map((claim) => recall(claim, revision)) : [{ status: "unverifiable", reason: "no_answer", retrieval_provenance: { revision, read_mode: "git-show" } }];
  const reconciliation = selected.map((claim) => reconciliationFor(claim, changedSurfaces, revision));
  const proposals = selected.map((claim, index) => proposalFor(claim, reconciliation[index], revision)).filter(Boolean);
  const result = {
    schema_version: "1.0",
    flow: "knowledge.context-check",
    input: {
      workspace: input.workspace,
      repository: input.repository,
      revision,
      target_audience: input.target_audience,
      changed_surfaces: changedSurfaces,
      knowledge_roots: input.knowledge_roots.map(({ id, provider, manifest_path }) => ({ id, provider, manifest_path }))
    },
    recalls,
    reconciliation,
    proposals,
    verdict: recalls.some((entry) => entry.status === "unverifiable") ? "not_verified" : "pass"
  };
  const resultErrors = validateContextCheckResult(result);
  if (resultErrors.length) throw error("INVALID_CONTEXT_CHECK_RESULT", resultErrors.join("; "));
  result.written = write ? writeResult(proposalDir, result) : [];
  return result;
}

export default runContextCheck;
