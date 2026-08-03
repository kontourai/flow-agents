/**
 * Knowledge Kit Context Check — deterministic, revision-bound Living Context.
 *
 * This standalone adapter reads selected claim manifests from the caller's exact
 * raw Git commit, then identifies only the claims whose declared surfaces need
 * reconciliation. Surface intersection is not a trust or contradiction verdict.
 * It never reads a working tree as a fallback and can write only new private
 * proposal artifacts beneath an explicit, verified proposal directory.
 *
 * @module context-check
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validate } from "../providers/lib/schema-validate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../schemas/knowledge/context-check-input.schema.json"), "utf8"));
const RESULT_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../schemas/knowledge/context-check-result.schema.json"), "utf8"));
const REVISION_RE = /^[0-9a-f]{40}$/i;
const CLAIM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CLAIM_STATUS = new Set(["current", "superseded", "unverifiable"]);
const GIT_ENVIRONMENT = Object.freeze({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });

function error(code, message) {
  const value = new Error(message);
  value.code = code;
  return value;
}

function isIdentity(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeRelativePath(value, field) {
  const normalized = typeof value === "string" ? value.replace(/\\/g, "/") : value;
  if (!isIdentity(value) || path.isAbsolute(value) || path.posix.isAbsolute(normalized) || value.split(/[\\/]+/).includes("..")) {
    throw error("INVALID_PATH", `${field} must be a non-empty repository-relative path without traversal`);
  }
  return normalized;
}

function safeClaimId(value, field) {
  if (!isIdentity(value) || !CLAIM_ID_RE.test(value)) throw error("INVALID_IDENTITY", `${field} must be a non-blank identifier ([A-Za-z0-9._-])`);
  return value;
}

function sanitizedGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, ...GIT_ENVIRONMENT };
}

/** Run Git with all inherited Git overrides cleared and replace/graft behavior disabled. */
function git(repoRoot, args) {
  try {
    return execFileSync("git", [
      "-C", repoRoot,
      "-c", "core.useReplaceRefs=false",
      "-c", "core.graftFile=/dev/null",
      "--no-replace-objects",
      ...args,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: sanitizedGitEnvironment(),
    }).trim();
  } catch (cause) {
    throw error("REVISION_READ_FAILED", `Context Check could not read the requested Git revision: ${cause.stderr?.toString().trim() || cause.message}`);
  }
}

/** Validate the portable, revision-bound Context Check input contract. */
export function validateContextCheckInput(input) {
  return validate(input, INPUT_SCHEMA).errors;
}

/** Validate the full Context Check result envelope through its shared JSON schema. */
export function validateContextCheckResult(result) {
  const errors = validate(result, RESULT_SCHEMA).errors;
  if (!result || typeof result !== "object" || Array.isArray(result)) return errors;
  if (result.verdict === "pass" && Array.isArray(result.recalls) && result.recalls.some((recall) => recall?.status === "unverifiable")) {
    errors.push("$/verdict: pass is invalid when any recall is unverifiable or no_answer");
  }
  return errors;
}

function resolveRevisionBoundRepository(repoRoot, requestedRevision) {
  if (!isIdentity(repoRoot)) throw error("REPO_ROOT_REQUIRED", "runContextCheck requires repoRoot");
  if (!REVISION_RE.test(requestedRevision)) throw error("INVALID_CONTEXT_CHECK_INPUT", "revision must be an exact 40-character Git commit SHA");
  let root;
  try { root = fs.realpathSync(repoRoot); } catch { throw error("REPO_ROOT_REQUIRED", "repoRoot must resolve to an existing repository worktree"); }
  const gitRoot = fs.realpathSync(git(root, ["rev-parse", "--show-toplevel"]));
  if (gitRoot !== root) throw error("REPOSITORY_IDENTITY_MISMATCH", "repoRoot must name the repository worktree root exactly");
  if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw error("REPOSITORY_IDENTITY_MISMATCH", "repoRoot is not a Git worktree");
  const revision = git(root, ["rev-parse", "--verify", `${requestedRevision}^{commit}`]).toLowerCase();
  if (revision !== requestedRevision.toLowerCase()) throw error("REVISION_IDENTITY_MISMATCH", "requested revision did not resolve to its raw commit identity");
  if (git(root, ["cat-file", "-t", revision]) !== "commit") throw error("REVISION_IDENTITY_MISMATCH", "requested revision is not a raw commit object");
  git(root, ["cat-file", "-e", `${revision}^{commit}`]);
  return { root, revision };
}

function normalizedAuthority(authority, field) {
  if (!authority || typeof authority !== "object") throw error("INVALID_CLAIM_MANIFEST", `${field} requires authority`);
  return {
    path: safeRelativePath(authority.path, `${field}.path`),
    citation: isIdentity(authority.citation) ? authority.citation : (() => { throw error("INVALID_CLAIM_MANIFEST", `${field}.citation must be non-blank`); })(),
  };
}

function readClaimsAtRevision(repoRoot, revision, root) {
  const manifestPath = safeRelativePath(root.manifest_path, "knowledge_roots[].manifest_path");
  const bytes = git(repoRoot, ["show", "--no-ext-diff", "--no-textconv", "--format=", `${revision}:${manifestPath}`]);
  let parsed;
  try { parsed = JSON.parse(bytes); } catch { throw error("INVALID_CLAIM_MANIFEST", `${manifestPath} at ${revision} is not valid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => key !== "claims") || !Array.isArray(parsed.claims)) {
    throw error("INVALID_CLAIM_MANIFEST", `${manifestPath} must contain only a claims array`);
  }
  return parsed.claims.map((claim, index) => normalizeClaim(claim, root, manifestPath, index));
}

function normalizeClaim(claim, root, manifestPath, index) {
  const prefix = `${manifestPath}: claims[${index}]`;
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) throw error("INVALID_CLAIM_MANIFEST", `${prefix} must be an object`);
  const allowed = new Set(["id", "claim", "status", "superseded_by", "authority", "owning_source", "affected_surfaces", "reconciliation_evidence"]);
  for (const key of Object.keys(claim)) if (!allowed.has(key)) throw error("INVALID_CLAIM_MANIFEST", `${prefix} has unexpected property '${key}'`);
  const id = safeClaimId(claim.id, `${prefix}.id`);
  if (!isIdentity(claim.claim)) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.claim must be non-blank`);
  if (!CLAIM_STATUS.has(claim.status)) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.status must be current, superseded, or unverifiable`);
  const authority = normalizedAuthority(claim.authority, `${prefix}.authority`);
  if (!claim.owning_source || typeof claim.owning_source !== "object" || Array.isArray(claim.owning_source)) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.owning_source is required`);
  const owningSource = {
    owner: isIdentity(claim.owning_source.owner) ? claim.owning_source.owner : (() => { throw error("INVALID_CLAIM_MANIFEST", `${prefix}.owning_source.owner must be non-blank`); })(),
    path: safeRelativePath(claim.owning_source.path, `${prefix}.owning_source.path`),
  };
  if (!Array.isArray(claim.affected_surfaces)) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.affected_surfaces must be a string array`);
  const affectedSurfaces = [...new Set(claim.affected_surfaces.map((surface) => safeRelativePath(surface, `${prefix}.affected_surfaces`)))];
  const supersededBy = claim.superseded_by === undefined ? undefined : safeClaimId(claim.superseded_by, `${prefix}.superseded_by`);
  if (claim.status === "superseded" && !supersededBy) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.superseded_by is required for superseded claims`);
  let reconciliationEvidence;
  if (claim.reconciliation_evidence !== undefined) {
    if (!claim.reconciliation_evidence || typeof claim.reconciliation_evidence !== "object" || Array.isArray(claim.reconciliation_evidence)
      || claim.reconciliation_evidence.status !== "contradicted") {
      throw error("INVALID_CLAIM_MANIFEST", `${prefix}.reconciliation_evidence must explicitly declare status 'contradicted'`);
    }
    reconciliationEvidence = { authority: normalizedAuthority(claim.reconciliation_evidence.authority, `${prefix}.reconciliation_evidence.authority`) };
  }
  return { id, claim: claim.claim, status: claim.status, ...(supersededBy ? { superseded_by: supersededBy } : {}), authority, owning_source: owningSource, affected_surfaces: affectedSurfaces, ...(reconciliationEvidence ? { reconciliation_evidence: reconciliationEvidence } : {}), root, manifestPath };
}

function authorityAtRevision(authority, revision) {
  return { ...authority, revision };
}

function retrievalProvenance(revision, roots) {
  return {
    provider: "git-repo",
    knowledge_roots: [...new Set(roots.map((root) => root.id))],
    manifest_paths: [...new Set(roots.map((root) => root.manifest_path))],
    revision,
    read_mode: "git-show",
  };
}

function recall(claim, revision) {
  return {
    claim_id: claim.id,
    claim: claim.claim,
    status: claim.status,
    ...(claim.superseded_by ? { superseded_by: claim.superseded_by } : {}),
    authority: authorityAtRevision(claim.authority, revision),
    retrieval_provenance: retrievalProvenance(revision, [{ id: claim.root.id, manifest_path: claim.manifestPath }]),
  };
}

function noAnswer(claimId, revision, roots) {
  return {
    claim_id: claimId,
    status: "unverifiable",
    reason: "no_answer",
    retrieval_provenance: retrievalProvenance(revision, roots),
  };
}

function reconciliationFor(claim, changedSurfaces, revision) {
  const affectedSurfaces = changedSurfaces.filter((surface) => claim.affected_surfaces.includes(surface));
  const authority = authorityAtRevision(claim.authority, revision);
  if (affectedSurfaces.length === 0) return { claim_id: claim.id, status: "clean", affected_surfaces: [], authority };
  if (claim.status === "unverifiable") return { claim_id: claim.id, status: "unverifiable", affected_surfaces: affectedSurfaces, authority };
  if (claim.reconciliation_evidence) {
    return {
      claim_id: claim.id,
      status: "contradicted",
      affected_surfaces: affectedSurfaces,
      authority,
      evidence: { authority: authorityAtRevision(claim.reconciliation_evidence.authority, revision) },
    };
  }
  return { claim_id: claim.id, status: "affected", affected_surfaces: affectedSurfaces, authority };
}

function proposalFor(claim, reconciliation, revision) {
  if (reconciliation.status === "clean") return null;
  const rationale = reconciliation.status === "contradicted"
    ? `Claim '${claim.id}' has explicit authoritative contradiction evidence for ${reconciliation.affected_surfaces.join(", ")} at ${revision}.`
    : reconciliation.status === "unverifiable"
      ? `Claim '${claim.id}' is affected by ${reconciliation.affected_surfaces.join(", ")} but remains unverifiable; route review to its owning source.`
      : `Claim '${claim.id}' is affected by ${reconciliation.affected_surfaces.join(", ")} and requires reconciliation by its owning source.`;
  return {
    schema_version: "1.0",
    id: `context-update-${claim.id}`,
    status: "proposed",
    kind: "context-update",
    claim_id: claim.id,
    route: { owner: claim.owning_source.owner, path: claim.owning_source.path },
    rationale,
    provenance: { authority: authorityAtRevision(claim.authority, revision), retrieval: "git-show" },
  };
}

function ensurePrivateDirectory(directory, label) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch { throw error("UNSAFE_PROPOSAL_DIR", `${label} must already exist as a private directory`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw error("UNSAFE_PROPOSAL_DIR", `${label} must be a directory, never a symlink`);
  if ((stat.mode & 0o077) !== 0) throw error("UNSAFE_PROPOSAL_DIR", `${label} must not be group/world accessible`);
  return fs.realpathSync(directory);
}

function ensurePrivateChildDirectory(root, relative) {
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw error("PROPOSAL_PATH_ESCAPE", `proposal directory escaped proposalDir: ${relative}`);
  let created = false;
  try {
    fs.mkdirSync(candidate, { mode: 0o700 });
    created = true;
  } catch (cause) {
    if (cause.code !== "EEXIST") throw cause;
  }
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw error("UNSAFE_PROPOSAL_DIR", `proposal directory component '${relative}' must be a private non-symlink directory`);
  const physical = fs.realpathSync(candidate);
  if (!physical.startsWith(`${root}${path.sep}`)) throw error("PROPOSAL_PATH_ESCAPE", `proposal directory component '${relative}' resolves outside proposalDir`);
  return { path: physical, created };
}

function outputDestination(root, relative) {
  const destination = path.resolve(root, relative);
  if (!destination.startsWith(`${root}${path.sep}`)) throw error("PROPOSAL_PATH_ESCAPE", `proposal write escaped proposalDir: ${relative}`);
  const parent = ensurePrivateDirectory(path.dirname(destination), `proposal parent for ${relative}`);
  if (!parent.startsWith(`${root}${path.sep}`) && parent !== root) throw error("PROPOSAL_PATH_ESCAPE", `proposal parent for ${relative} resolves outside proposalDir`);
  return destination;
}

function requireNewDestination(destination, relative) {
  try {
    fs.lstatSync(destination);
  } catch (cause) {
    if (cause.code === "ENOENT") return;
    throw error("PROPOSAL_WRITE_FAILED", `refused proposal write '${relative}': ${cause.message}`);
  }
  throw error("PROPOSAL_WRITE_FAILED", `refused proposal write '${relative}': destination already exists or is a symlink`);
}

function writeStagedJson(root, name, value) {
  const destination = path.join(root, name);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  let descriptor;
  try {
    descriptor = fs.openSync(destination, flags, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return { path: destination, stat: fs.fstatSync(descriptor) };
  } catch (cause) {
    throw error("PROPOSAL_WRITE_FAILED", `could not stage proposal output '${name}': ${cause.message}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function removeCommittedOutputs(entries) {
  for (const entry of entries.reverse()) {
    try {
      const stat = fs.lstatSync(entry.destination);
      if (stat.dev === entry.staged.stat.dev && stat.ino === entry.staged.stat.ino) fs.unlinkSync(entry.destination);
    } catch {
      // Preserve the original write error. We only remove the exact hard link we created.
    }
  }
}

function removeEmptyCreatedDirectory(directory) {
  try { fs.rmdirSync(directory); } catch { /* It was not left empty, or another actor owns it now. */ }
}

function writeResult(proposalDir, result) {
  if (!isIdentity(proposalDir)) throw error("PROPOSAL_DIR_REQUIRED", "Context Check writes require an explicit proposalDir");
  const requestedRoot = path.resolve(proposalDir);
  const outputRoot = ensurePrivateDirectory(requestedRoot, "proposalDir");
  const written = ["context-check-result.json", ...result.proposals.map((proposal) => `proposals/${proposal.id}.json`)];
  result.written = written;
  const committed = [];
  let proposals;
  let stagingRoot;
  try {
    // Refuse every existing or symlink target before creating any visible output.
    const resultDestination = outputDestination(outputRoot, "context-check-result.json");
    requireNewDestination(resultDestination, "context-check-result.json");
    proposals = ensurePrivateChildDirectory(outputRoot, "proposals");
    const outputs = [
      { relative: "context-check-result.json", destination: resultDestination, value: result },
      ...result.proposals.map((proposal) => ({
        relative: `proposals/${proposal.id}.json`,
        destination: outputDestination(proposals.path, `${proposal.id}.json`),
        value: proposal,
      })),
    ];
    for (const output of outputs) requireNewDestination(output.destination, output.relative);

    stagingRoot = fs.mkdtempSync(path.join(outputRoot, ".context-check-stage-"));
    ensurePrivateDirectory(stagingRoot, "Context Check staging directory");
    for (const [index, output] of outputs.entries()) output.staged = writeStagedJson(stagingRoot, String(index), output.value);

    for (const output of outputs) {
      // Revalidate the parent and target immediately before the no-replace commit.
      outputDestination(output.relative.startsWith("proposals/") ? proposals.path : outputRoot, output.relative.startsWith("proposals/") ? output.relative.slice("proposals/".length) : output.relative);
      requireNewDestination(output.destination, output.relative);
      fs.linkSync(output.staged.path, output.destination);
      committed.push(output);
    }
  } catch (cause) {
    removeCommittedOutputs(committed);
    if (proposals?.created) removeEmptyCreatedDirectory(proposals.path);
    if (cause.code) throw cause;
    throw error("PROPOSAL_WRITE_FAILED", `refused Context Check output transaction: ${cause.message}`);
  } finally {
    if (stagingRoot) fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
  return written;
}

/**
 * Run a deterministic Context Check.
 *
 * Repository content is read only with a sanitized `git show <raw-sha>:<path>`.
 * `write: true` requires an existing private proposalDir and only creates new,
 * no-follow files below it; it never modifies repoRoot.
 */
export function runContextCheck({ repoRoot, input, proposalDir, write = true } = {}) {
  const inputErrors = validateContextCheckInput(input);
  if (inputErrors.length) throw error("INVALID_CONTEXT_CHECK_INPUT", inputErrors.join("; "));
  const { root: resolvedRoot, revision } = resolveRevisionBoundRepository(repoRoot, input.revision);
  const changedSurfaces = [...new Set(input.changed_surfaces || input.diff.paths)].map((surface) => safeRelativePath(surface, "changed surface"));
  if (new Set(input.knowledge_roots.map((knowledgeRoot) => knowledgeRoot.id)).size !== input.knowledge_roots.length) {
    throw error("DUPLICATE_KNOWLEDGE_ROOT_ID", "selected Knowledge root ids must be unique");
  }
  const claims = input.knowledge_roots.flatMap((knowledgeRoot) => readClaimsAtRevision(resolvedRoot, revision, knowledgeRoot));
  const claimsById = new Map();
  for (const claim of claims) {
    if (claimsById.has(claim.id)) throw error("DUPLICATE_CLAIM_ID", `claim id '${claim.id}' appears in more than one selected Knowledge root`);
    claimsById.set(claim.id, claim);
  }
  const requestedIds = input.claim_ids ?? ([...claimsById.keys()].length ? [...claimsById.keys()] : ["no-matching-claims"]);
  const selected = requestedIds.flatMap((claimId) => claimsById.has(claimId) ? [claimsById.get(claimId)] : []);
  const recalls = requestedIds.map((claimId) => claimsById.has(claimId) ? recall(claimsById.get(claimId), revision) : noAnswer(claimId, revision, input.knowledge_roots));
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
      knowledge_roots: input.knowledge_roots.map(({ id, provider, manifest_path }) => ({ id, provider, manifest_path })),
    },
    recalls,
    reconciliation,
    proposals,
    verdict: recalls.some((entry) => entry.status === "unverifiable") ? "not_verified" : "pass",
    written: [],
  };
  const resultErrors = validateContextCheckResult(result);
  if (resultErrors.length) throw error("INVALID_CONTEXT_CHECK_RESULT", resultErrors.join("; "));
  if (write) writeResult(proposalDir, result);
  const finalErrors = validateContextCheckResult(result);
  if (finalErrors.length) throw error("INVALID_CONTEXT_CHECK_RESULT", finalErrors.join("; "));
  return result;
}

export default runContextCheck;
