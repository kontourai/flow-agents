#!/usr/bin/env node
/**
 * Stop Hook: warn when an active workflow is about to stop short of its goal.
 *
 * The hook reads .kontourai/flow-agents artifacts, looks for the most recent active
 * delivery/session file, and reports missing Definition Of Done, Goal Fit, or
 * Final Acceptance state.
 *
 * Enforcement is controlled by FLOW_AGENTS_GOAL_FIT_MODE:
 *   - block: return exit code 2 (blocks the Stop) when local goal fit is incomplete.
 *   - warn:  return exit code 0 but still emit the guidance on stderr (default).
 *   - off:   stay silent.
 * The legacy FLOW_AGENTS_GOAL_FIT_STRICT=true is honored as an alias for block.
 * The canonical engine default is warn; shipped runtime configs (e.g. Claude
 * Code at L2) set block so the installed product enforces while the engine
 * default and conformance contract stay warn.
 *
 * Scope: the gate evaluates the session's current task (.kontourai/flow-agents/current.json)
 * when set, so an unrelated active workflow elsewhere in the repo does not gate
 * this stop. A pre-execution sidecar remains warning-only unless it has an active
 * canonical Flow run; once Flow is active, its unfinished gate remains blocking.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

// Hash-chain primitives + the exit-code-laundering heuristic come from ONE shared
// module, so this verifier can never drift from the writer (evidence-capture.js).
// CHAIN_GENESIS is re-aliased to CHAIN_GENESIS_VERIFY to preserve the long-standing
// export name consumed by repair-command-log.js and the fork-classification eval.
const {
  CHAIN_GENESIS: CHAIN_GENESIS_VERIFY,
  canonicalJsonForChain,
  hasLaunderingOperator,
} = require('../lib/command-log-chain.js');
const {
  flowAgentsArtifactRoot,
  flowAgentsArtifactRootsForRead,
  resolveSharedRepoRoot,
  warnIfFailingOpenInsideGitTree,
} = require('./lib/local-artifact-paths');
const { resolveActor, isUnresolvedActor, detectRuntime } = require('./lib/actor-identity.js');
const { readCurrentPointer, readOwnCurrentPointer } = require('./lib/current-pointer.js');
const { isRunnableCommandText, isAmbiguousAbsenceCommand } = require('./lib/runnable-command.js');
let validateActiveTurnAuthority = () => ({ valid: false, reason: 'continuation authority validator is unavailable' });
let validateSignedActiveTurnAssignmentAuthority = validateActiveTurnAuthority;
try {
  ({ validateActiveTurnAuthority, validateSignedActiveTurnAssignmentAuthority } = require('./lib/continuation-turn-authority.js'));
} catch {
  // A partial legacy install must retain ordinary hard Stop blocking, not fail
  // open because the optional continuation feature is unavailable.
}

const MAX_STDIN = 1024 * 1024;
const MAX_CANONICAL_FLOW_STATE_BYTES = 1024 * 1024;
const MAX_CANONICAL_FLOW_DEFINITION_BYTES = 1024 * 1024;
const CANONICAL_FLOW_STATUSES = new Set(['active', 'blocked', 'needs_decision', 'paused', 'canceled', 'completed', 'failed', 'accepted_by_exception']);
const CANONICAL_FLOW_TERMINAL_STATUSES = new Set(['completed', 'canceled', 'failed']);
const ACTIVE_STATUSES = new Set([
  'planning',
  'planned',
  'executing',
  'executed',
  'reviewing',
  'verifying',
  'failed',
  'needs-decision',
  'in-progress',
  'blocked',
  'partial',
]);
// WORKFLOW_SESSION_TYPES: used for artifact identification only, not for verdict production.
const WORKFLOW_SESSION_TYPES = new Set(['deliver', 'delivery', 'fix-bug', 'execute-plan', 'verify-work']);
// Phase 4c: bundle-only. Required set = {state.json, handoff.json, trust.bundle}. Drop evidence.json/acceptance.json/critique.json.
const SIDECAR_NAMES = new Set(['state.json', 'handoff.json', 'trust.bundle']);
const OPTIONAL_SIDECAR_NAMES = new Set();

// A sidecar that has not started execution is normally expected to be incomplete.
// An active canonical Flow run is the exception: its current gate remains live and
// blocks Stop even while the projected sidecar is in pickup or planning.
const PRE_EXECUTION_STATUSES = new Set(['new', 'planning', 'planned', 'backlog']);
const PRE_EXECUTION_PHASES = new Set(['idea', 'backlog', 'pickup', 'planning']);

// Terminal tasks are complete — they must never gate a stop or count as "active".
// A stale current.json pointing at one, or a graveyard of finished states, must
// not block an unrelated session.
const TERMINAL_STATUSES = new Set(['done', 'delivered', 'canceled', 'accepted', 'archived', 'complete', 'completed']);

function isTerminalDeliveredState(state) {
  if (!state || typeof state !== 'object') return false;
  const status = normalizedStatus(state.status || '');
  const phase = normalizedStatus(state.phase || '');
  return TERMINAL_STATUSES.has(status) || phase === 'done';
}

function parseJson(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function findRepoRoot(startDir) {
  const resolvedStartDir = path.resolve(startDir || process.cwd());
  // #357: prefer git's SHARED common-dir root (the primary checkout's repo root, resolved
  // identically from any linked worktree) before falling back to the plain `.git`/AGENTS.md
  // ancestor walk below. Without this, a worktree's OWN `.git` FILE (not the shared `.git`
  // DIRECTORY) satisfies `fs.existsSync(path.join(dir, '.git'))` at the very first directory
  // checked, so the walk always stopped at the worktree root instead of resolving to the
  // shared primary checkout — see src/lib/local-artifact-root.ts's resolveSharedRepoRoot doc
  // comment for the full rationale. Fails open to the walk below (unchanged) when git is
  // unavailable, `resolvedStartDir` is not inside a git working tree, or the command fails —
  // this is also exactly today's behavior in the single-checkout case, where
  // `--git-common-dir` resolves to `.git` under `resolvedStartDir` itself.
  const sharedRoot = resolveSharedRepoRoot(resolvedStartDir);
  if (sharedRoot) return sharedRoot;
  let dir = resolvedStartDir;
  const root = path.parse(dir).root;
  for (let depth = 0; dir && depth < 40; depth++) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      // #413 iteration-2 Fix 1: resolveSharedRepoRoot failed above even though a `.git` entry
      // exists right here — git resolution was ATTEMPTED and FAILED (corrupted gitlink, bad
      // GIT_DIR, git unavailable, etc.), not merely "no git repo at all". Loud, not silent —
      // see warnIfFailingOpenInsideGitTree's own doc comment for the full rationale. This walk
      // still returns `dir` (the ancestor-walk fallback is preserved unchanged) after warning.
      warnIfFailingOpenInsideGitTree(resolvedStartDir, dir);
      return dir;
    }
    if (fs.existsSync(path.join(dir, 'AGENTS.md'))) return dir;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return resolvedStartDir;
}

function walkMarkdown(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'archive') continue;
      walkMarkdown(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function readArtifact(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const stat = fs.statSync(file);
  const status = (text.match(/^status:\s*([A-Za-z0-9_-]+)/m) || [])[1] || '';
  const type = (text.match(/^type:\s*([A-Za-z0-9_-]+)/m) || [])[1] || '';
  const role = (text.match(/^role:\s*([A-Za-z0-9_-]+)/m) || [])[1] || '';
  return { file, text, status, type, role, mtimeMs: stat.mtimeMs };
}

function hasSidecars(dir) {
  try {
    return fs.readdirSync(dir).some(name => SIDECAR_NAMES.has(name));
  } catch {
    return false;
  }
}

/**
 * Returns true if a line of validator output looks like a validator-environment
 * error (shell/npm error, tsc missing, spawn failure) rather than a real
 * artifact validation message. Environment errors must never block goal-fit.
 */
function isEnvironmentError(line) {
  return /tsc[:\s]|command not found|npm ERR!|npm error|ENOENT|EACCES|Cannot find module|node_modules\/.bin|TypeScript version|version conflict|error TS[0-9]/i.test(line);
}

function readPackageManifest(packageRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

function resolveArtifactValidator() {
  let packageRoot;
  try { packageRoot = fs.realpathSync(path.resolve(__dirname, '..', '..')); } catch { return null; }
  const rootManifest = readPackageManifest(packageRoot);
  const buildManifest = readPackageManifest(path.join(packageRoot, 'build'));
  if (rootManifest?.name !== '@kontourai/flow-agents'
    && buildManifest?.name !== '@kontourai/flow-agents') return null;
  const builtValidator = path.join(packageRoot, 'build', 'src', 'cli', 'validate-workflow-artifacts.js');
  try {
    const stat = fs.lstatSync(builtValidator);
    if (stat.isFile() && !stat.isSymbolicLink()) return { packageRoot, builtValidator };
  } catch { /* validator is unavailable until this package is built */ }
  return null;
}

function sidecarValidation(root, artifactDir) {
  const requireSidecars = String(process.env.FLOW_AGENTS_REQUIRE_SIDECARS || '').toLowerCase() === 'true';
  const requireCritique = String(process.env.FLOW_AGENTS_REQUIRE_CRITIQUE || '').toLowerCase() === 'true';
  if (!requireSidecars && !requireCritique && !hasSidecars(artifactDir)) return [];

  let sidecarFiles = [];
  try {
    sidecarFiles = fs.readdirSync(artifactDir)
      .filter(name => SIDECAR_NAMES.has(name) || OPTIONAL_SIDECAR_NAMES.has(name))
      .map(name => path.join(artifactDir, name));
  } catch {
    sidecarFiles = [];
  }

  if (requireSidecars || requireCritique) {
    const present = new Set(sidecarFiles.map(file => path.basename(file)));
    const requiredNames = new Set(requireSidecars ? SIDECAR_NAMES : []);
    // Phase 4c: critique.json is no longer written; trust.bundle carries critique claims.
    // FLOW_AGENTS_REQUIRE_CRITIQUE is satisfied by:
    //   - critique.json (legacy, may not be in SIDECAR_NAMES but may still be on disk), OR
    //   - trust.bundle that contains at least one workflow.critique.review claim.
    if (requireCritique) {
      // Check disk directly (critique.json is no longer in SIDECAR_NAMES so may not be in present)
      const hasCritiqueJson = fs.existsSync(path.join(artifactDir, 'critique.json'));
      const bundleFile = path.join(artifactDir, 'trust.bundle');
      let hasBundleCritique = false;
      if (fs.existsSync(bundleFile)) {
        try {
          const b = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
          hasBundleCritique = Array.isArray(b.claims) && b.claims.some(c => c && c.claimType === 'workflow.critique.review');
        } catch { /* fall through — no bundle critique */ }
      }
      if (!hasCritiqueJson && !hasBundleCritique) requiredNames.add('critique.json');
    }
    const missing = [...requiredNames].filter(name => !present.has(name)).sort();
    if (missing.length > 0) {
      return missing.map(name => `${relative(root, path.join(artifactDir, name))} sidecar validation: required sidecar is missing`);
    }
  }

  if (sidecarFiles.length === 0) return [];

  // Resolve validation from Flow Agents itself. A consumer package.json does not imply
  // that the consumer owns this script; installed hooks commonly run inside unrelated
  // Node repositories whose npm scripts must not become Flow Agents validators.
  const validator = resolveArtifactValidator();
  if (!validator) {
    return [`${relative(root, artifactDir)} sidecar validation skipped: Flow Agents validator is unavailable`];
  }

  const validatorArgs = ['--skip-markdown-validation'];
  if (requireSidecars) validatorArgs.push('--require-sidecars');
  if (requireCritique) validatorArgs.push('--require-critique');
  validatorArgs.push(artifactDir);

  // Direct node invocation: no PATH executable lookup and no consumer npm script.
  const result = spawnSync(process.execPath, [validator.builtValidator, ...validatorArgs], {
    cwd: validator.packageRoot,
    encoding: 'utf8',
    timeout: 30000,
  });

  // Part 2 fix: treat validator-environment failures as SKIP, never as blocking.
  // A spawn error (ENOENT, timeout) means the validator couldn't run at all.
  if (result.error) {
    // Validator couldn't be launched — environment issue, not a goal-fit failure.
    return [`${relative(root, artifactDir)} sidecar validation skipped: validator could not run (${result.error.code || result.error.message})`];
  }

  if (result.status === 0) return [];

  // Validator ran and exited non-zero. Separate real validation errors from
  // environment errors (tsc missing, npm ERR!, shell errors) so that a broken
  // validator environment never blocks goal-fit.
  const allLines = `${result.stdout || ''}\n${result.stderr || ''}`
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const envLines = allLines.filter(isEnvironmentError);
  const validationLines = allLines.filter(line => !isEnvironmentError(line));

  if (envLines.length > 0 && validationLines.length === 0) {
    // Pure environment failure — skip, do not block.
    return [`${relative(root, artifactDir)} sidecar validation skipped: validator environment error (${envLines[0].slice(0, 120)})`];
  }

  // Real validation errors (possibly mixed with a few env noise lines).
  const output = validationLines.length > 0 ? validationLines : allLines;
  const trimmed = output.slice(0, 12);
  if (trimmed.length === 0) trimmed.push(`validator exited with status ${result.status ?? 'unknown'}`);
  return trimmed.map(line => `${relative(root, artifactDir)} sidecar validation: ${line}`);
}

function isWorkflowArtifact(artifact) {
  if (!artifact) return false;
  if (artifact.role === 'plan' || artifact.role === 'review') return false;
  if (artifact.file.endsWith('-plan.md') || artifact.file.endsWith('-review.md')) return false;
  if (WORKFLOW_SESSION_TYPES.has(artifact.type)) return true;
  return /--(deliver|fix-bug|execute-plan|verify-work)\b/.test(path.basename(artifact.file));
}

function uncheckedInSection(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return [];
  const rest = text.slice(start + heading.length + 3);
  const next = rest.search(/\n##\s+/);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  return section
    .split('\n')
    .filter(line => /^\s*-\s+\[\s\]/.test(line))
    .map(line => line.replace(/^\s*-\s+\[\s\]\s*/, '').trim())
    .filter(Boolean);
}

function hasHeading(text, heading) {
  return new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(text);
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ─── ADR 0010 Phase 2b: re-derive-at-gate via Surface (fail-open) ─────────────
// Surface (@kontourai/surface) is ESM-only; stop-goal-fit.js is CJS.
// Load it via a fail-open dynamic import(), cached after the first attempt.
// If Surface cannot be loaded (package absent, env mismatch), we fall back to
// the stored claim.status check from #133 — no regression for environments that
// lack @kontourai/surface. The module is never written to disk.
let _surfaceModule; // undefined = not tried yet; null = unavailable
async function tryLoadSurface() {
  if (_surfaceModule !== undefined) return _surfaceModule;
  try {
    const m = await import('@kontourai/surface');
    _surfaceModule = m;
    return _surfaceModule;
  } catch {
    _surfaceModule = null;
    return null;
  }
}

// ─── ADR 0016 Abstraction A P-c: flow-resolver integration ────────────────────
// Load the compiled flow-resolver (build/src/lib/flow-resolver.js) via CJS
// require behind the same hasBuild guard used for the validator. Fail-open:
// returns null when build/ is absent, require throws, or current.json has no
// active_flow_id / active_step_id. The caller (bundleEnforcement, sidecarGuidance)
// treats null as "no active FlowDefinition" and falls back to the workflow.* path.
function loadActiveFlowStep(flowAgentsDir, actorKey) {
  const packageRoot = path.resolve(__dirname, '..', '..');
  const builtResolver = path.join(packageRoot, 'build', 'src', 'lib', 'flow-resolver.js');
  if (!fs.existsSync(builtResolver)) return null; // hasBuild guard: no build/ yet
  try {
    const resolver = require(builtResolver);
    if (typeof resolver.resolveActiveFlowStep !== 'function') return null;
    return resolver.resolveActiveFlowStep(flowAgentsDir, actorKey);
  } catch {
    return null; // require failed or resolver threw — fail-open
  }
}

/**
 * Message-assembly only: derive the user-facing gate identity prefix from the
 * resolved active FlowDefinition step (loadActiveFlowStep). Produces
 * "[<flowId>/<gateId>]" (e.g. "[builder.build/verify-gate]") when a
 * FlowDefinition gate is active, else the generic "[stop-gate]" fallback.
 * Purely cosmetic — never affects claim selection, HARD_BLOCK/FULL_BLOCK
 * classification, block counting, or exit codes.
 */
function gateLabel(activeFlowStep) {
  return activeFlowStep && activeFlowStep.flowId && activeFlowStep.gateId
    ? `[${activeFlowStep.flowId}/${activeFlowStep.gateId}]`
    : '[stop-gate]';
}

/**
 * Derive the declared claimType Set from an active FlowDefinition's gate expects[].
 * Returns null when no FlowDefinition is active (callers fall back to workflow.* only).
 */
function declaredClaimTypesFor(activeFlowStep) {
  return activeFlowStep && Array.isArray(activeFlowStep.gateExpects)
    ? new Set(activeFlowStep.gateExpects.map(e => e && e.bundle_claim && e.bundle_claim.claimType).filter(Boolean))
    : null;
}

function safeOneLine(value, maxLength = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function normalizedStatus(value) {
  return safeOneLine(value, 80).toLowerCase();
}

// ─── ADR 0010 Phase 4b: bundle-first helpers for consumer migration ────────────
// These helpers extract evidence/critique/acceptance data from the trust.bundle
// when it is present, falling back to the bespoke sidecar for bundle-less sessions.
// The sidecar content is IDENTICAL to the bundle projection (Phase 4a guarantee),
// so consumer reads produce identical verdicts.

/**
 * Extract the effective "verdict" from trust.bundle workflow.check.* claims,
 * or from declared claimTypes when a FlowDefinition is active (P-c extension).
 * Priority of non-pass statuses: fail > not_verified > partial > pass.
 * Returns null when the bundle has no matching claims.
 *
 * @param {Array} claims - trust.bundle claims array
 * @param {Set<string>|null} [declaredClaimTypes] - optional set of declared claimTypes from gateExpects[]
 */
function bundleEvidenceVerdict(claims, declaredClaimTypes) {
  const checkClaims = claims.filter(c => {
    if (!c || typeof c.claimType !== 'string') return false;
    if (c.claimType.startsWith('workflow.check.')) return true;
    return declaredClaimTypes != null && declaredClaimTypes.has(c.claimType);
  });
  if (checkClaims.length === 0) return null;
  let worst = 'pass';
  const PRIORITY = { fail: 4, failed: 4, not_verified: 3, 'not-verified': 3, partial: 2, pass: 1, skip: 0 };
  for (const c of checkClaims) {
    const v = normalizedStatus(c.value || 'pass');
    if ((PRIORITY[v] || 0) > (PRIORITY[worst] || 0)) worst = v;
  }
  return worst;
}

/**
 * Extract the check ID from a claim's subjectId (format: "${slug}/${checkId}").
 * Returns the part after the first slash, or the full subjectId if no slash.
 */
function claimCheckId(subjectId) {
  const s = String(subjectId || '');
  const slash = s.indexOf('/');
  return slash >= 0 ? s.slice(slash + 1) : s;
}

/**
 * Build the list of blocking check-claims from trust.bundle (equivalent to
 * evidence.json.checks filtered to non-pass status).
 * Returns objects shaped like { id, status, summary } (summary from fieldOrBehavior).
 *
 * @param {Array} claims - trust.bundle claims array
 * @param {Set<string>|null} [declaredClaimTypes] - optional set of declared claimTypes from gateExpects[]
 */
function bundleBlockingChecks(claims, declaredClaimTypes) {
  return claims.filter(c => {
    if (!c || typeof c.claimType !== 'string') return false;
    const typeMatch = c.claimType.startsWith('workflow.check.')
      || (declaredClaimTypes != null && declaredClaimTypes.has(c.claimType));
    if (!typeMatch) return false;
    const v = normalizedStatus(c.value || '');
    return v === 'fail' || v === 'failed' || v === 'not_verified' || v === 'not-verified';
  }).map(c => ({
    id: claimCheckId(c.subjectId),
    status: c.value || 'unknown',
    summary: c.fieldOrBehavior || '',
  }));
}

/**
 * Determine critique status from trust.bundle workflow.critique.review claims,
 * or from declared claimTypes when a FlowDefinition is active (P-c extension).
 * Returns the "worst" value among critique claims, or null when none present.
 *
 * @param {Array} claims - trust.bundle claims array
 * @param {Set<string>|null} [declaredClaimTypes] - optional set of declared claimTypes from gateExpects[]
 */
function bundleCritiqueStatus(claims, declaredClaimTypes) {
  const critiqueClaims = claims.filter(c => {
    if (!c || typeof c.claimType !== 'string') return false;
    if (c.claimType === 'workflow.critique.review') return true;
    return declaredClaimTypes != null && declaredClaimTypes.has(c.claimType);
  });
  if (critiqueClaims.length === 0) return null;
  // A disputed or failed critique is blocking
  for (const c of critiqueClaims) {
    const v = normalizedStatus(c.value || '');
    if (v === 'fail' || v === 'failed' || c.status === 'disputed' || c.status === 'rejected') return c.value || 'fail';
  }
  return 'pass';
}

/**
 * Build the list of claimed-pass command checks from the trust.bundle's evidence[]
 * (items with execution.label) and from workflow.check.command claims whose effective
 * value is "pass" (never-captured claimed pass). Falls back to an empty list when
 * the bundle has no evidence items.
 *
 * Returns objects shaped like { id, kind, status, command } — same shape as
 * evidence.json.checks — so captureCrossReference's body logic is unchanged.
 *
 * @param {object} bundle - trust.bundle object
 * @param {Set<string>|null} [declaredClaimTypes] - optional set of declared claimTypes from gateExpects[]
 */
function bundleClaimedPassCommandChecks(bundle, declaredClaimTypes) {
  const allEvidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  const allClaims = Array.isArray(bundle.claims) ? bundle.claims : [];

  // Build a map from claimId -> claim for fast lookup
  const claimById = new Map();
  for (const c of allClaims) {
    if (c && c.id) claimById.set(c.id, c);
  }

  const checks = [];
  const seen = new Set();

  // (A) Evidence items with execution.label (command captures).
  // These represent commands that actually ran — include them regardless of
  // effective status so we can cross-reference against the live log.
  for (const ev of allEvidence) {
    if (!ev || !ev.execution || !ev.execution.label) continue;
    const cmd = String(ev.execution.label || '').replace(/\s+/g, ' ').trim();
    if (!cmd) continue;
    const claim = claimById.get(ev.claimId);
    if (!claim) continue;
    const claimTypeStr = String(claim.claimType || '');
    if (!claimTypeStr.startsWith('workflow.check.') && !(declaredClaimTypes != null && declaredClaimTypes.has(claimTypeStr))) continue;
    // Deduplicate by command
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    const id = claimCheckId(claim.subjectId);
    // Use 'pass' as the nominal claimed status; cross-reference catches contradictions.
    checks.push({ id, kind: 'command', status: 'pass', command: cmd });
  }

  // (B) Workflow.check.command claims with effective value "pass" but no capture
  // (no evidence item with execution) — these are originally-claimed-pass checks
  // that were never captured.
  for (const c of allClaims) {
    if (!c || typeof c.claimType !== 'string') continue;
    const isCommandType = c.claimType === 'workflow.check.command'
      || (declaredClaimTypes != null && declaredClaimTypes.has(c.claimType));
    if (!isCommandType) continue;
    if (normalizedStatus(c.value || '') !== 'pass') continue;
    // Check if this claim already has a capture evidence item (covered in (A))
    const hasCapture = allEvidence.some(ev => ev && ev.claimId === c.id && ev.execution && ev.execution.label);
    if (hasCapture) continue;
    // No capture — use fieldOrBehavior as command identifier for backstop resolution.
    const evItem = allEvidence.find(ev => ev && ev.claimId === c.id);
    const cmd = evItem
      ? normalizeCommand(evItem.excerptOrSummary || '')
      : normalizeCommand(c.fieldOrBehavior || '');
    const id = claimCheckId(c.subjectId);
    if (!cmd) {
      checks.push({ id, kind: 'command', status: 'pass', command: '' });
      continue;
    }
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    checks.push({ id, kind: 'command', status: 'pass', command: cmd });
  }

  return checks;
}

/**
 * Extract pending acceptance criteria from trust.bundle workflow.acceptance.criterion claims,
 * or from declared claimTypes when a FlowDefinition is active (P-c extension).
 * Returns the count of claims whose value is pending/not_started/empty/unknown.
 * Returns null when the bundle has no matching claims.
 *
 * @param {Array} claims - trust.bundle claims array
 * @param {Set<string>|null} [declaredClaimTypes] - optional set of declared claimTypes from gateExpects[]
 */
function bundlePendingCriteriaCount(claims, declaredClaimTypes) {
  const criteriaClaims = claims.filter(c => {
    if (!c || typeof c.claimType !== 'string') return false;
    if (c.claimType === 'workflow.acceptance.criterion') return true;
    return declaredClaimTypes != null && declaredClaimTypes.has(c.claimType);
  });
  if (criteriaClaims.length === 0) return null;
  const pending = criteriaClaims.filter(c => {
    const v = normalizedStatus(c.value || '');
    return v === 'pending' || v === 'not_started' || v === '' || v === 'unknown';
  });
  return pending.length;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * ADR 0010 Phase 4b: sidecarGuidance — bundle-first evidence/critique reads.
 * state.json reads are UNCHANGED (state.json stays as primary source).
 * evidence.json verdict/checks: read from trust.bundle when present, fall back
 *   to evidence.json for bundle-less sessions (no regression).
 * not_verified_gaps: always from evidence.json (no bundle equivalent).
 * critique status: read from trust.bundle when present, fall back to critique.json.
 *   Finding details: still from critique.json when present (both bundle and sidecar paths).
 *
 * ADR 0016 P-c: when activeFlowStep is non-null, pass its declared claimTypes to
 * bundle helpers so declared-type claims (e.g. builder.verify.tests) produce the
 * same sidecar guidance signals as workflow.* claims.
 */
function sidecarGuidance(root, artifactDir, activeFlowStep) {
  // Build the declared claimType set from the FlowDefinition gate expects[] (P-c).
  // Null when no FlowDefinition is active (fallback: helpers use workflow.* prefix only).
  const declaredClaimTypes = declaredClaimTypesFor(activeFlowStep);
  const warnings = [];
  const state = readJsonFile(path.join(artifactDir, 'state.json'));
  const base = relative(root, artifactDir);

  if (state) {
    const status = normalizedStatus(state.status || 'unknown');
    const phase = normalizedStatus(state.phase || 'unknown');
    const next = state.next_action && typeof state.next_action === 'object' ? state.next_action : null;
    const nextStatus = next ? normalizedStatus(next.status || 'unknown') : 'unknown';
    // The agent's work is complete when the recorded next action is done — the
    // gate must not block the agent for a remaining human/CI step (e.g. a verified
    // task whose only next_action is "commit the migration").
    const agentComplete = nextStatus === 'done';
    if (!TERMINAL_STATUSES.has(status) && !agentComplete) {
      const nextSummary = next && next.summary ? `; next_action:${nextStatus} "${safeOneLine(next.summary)}"` : '';
      warnings.push(`${base} workflow state: status:${status} phase:${phase}${nextSummary}`);
    }
  }

  if (state && state.next_action && normalizedStatus(state.next_action.status) !== 'done') {
    const next = state.next_action;
    warnings.push(`${base} next action: ${safeOneLine(next.summary)}${next.target_phase ? ` (target phase: ${safeOneLine(next.target_phase, 80)})` : ''}`);
    if (Array.isArray(next.skills) && next.skills.length) warnings.push(`${base} required skills: ${next.skills.map(skill => safeOneLine(skill, 80)).join(' -> ')}`);
    if (Array.isArray(next.operations) && next.operations.length) warnings.push(`${base} required operations: ${next.operations.map(operation => safeOneLine(operation, 80)).join(' -> ')}`);
    if (next.command) warnings.push(`${base} next command: ${safeOneLine(next.command, 240)}`);
  }

  // ── Evidence verdict + checks: bundle-first, fallback to evidence.json ────
  const bundle = readJsonFile(path.join(artifactDir, 'trust.bundle'));
  const bundleClaims = bundle && Array.isArray(bundle.claims) ? bundle.claims : null;

  if (bundleClaims) {
    // Phase 4b: read verdict and per-check signals from trust.bundle claims.
    // P-c: pass declaredClaimTypes so declared-type claims are included alongside workflow.*.
    const verdict = bundleEvidenceVerdict(bundleClaims, declaredClaimTypes);
    if (verdict && verdict !== 'pass' && verdict !== 'skip') {
      warnings.push(`${base} evidence verdict:${safeOneLine(verdict, 40)}; do not deliver without accepted gap or new evidence.`);
    }
    const blockingChecks = bundleBlockingChecks(bundleClaims, declaredClaimTypes);
    for (const check of blockingChecks.slice(0, 4)) {
      const status = safeOneLine(check.status || 'unknown', 40);
      warnings.push(`${base} evidence check ${safeOneLine(check.id || 'unknown', 80)} status:${status}: ${safeOneLine(check.summary)}`);
    }
  } else {
    // Fallback: no bundle — read from evidence.json (existing behavior, no regression).
    const evidence = readJsonFile(path.join(artifactDir, 'evidence.json'));
    if (evidence && normalizedStatus(evidence.verdict) && normalizedStatus(evidence.verdict) !== 'pass') {
      warnings.push(`${base} evidence verdict:${safeOneLine(evidence.verdict, 40)}; do not deliver without accepted gap or new evidence.`);
    }
    if (evidence && Array.isArray(evidence.checks)) {
      const blockingChecks = evidence.checks.filter(check => {
        const status = normalizedStatus(check && check.status);
        return status === 'fail' || status === 'failed' || status === 'not_verified' || status === 'not-verified';
      });
      for (const check of blockingChecks.slice(0, 4)) {
        const status = safeOneLine(check.status || 'unknown', 40);
        warnings.push(`${base} evidence check ${safeOneLine(check.id || 'unknown', 80)} status:${status}: ${safeOneLine(check.summary)}`);
      }
    }
  }

  // not_verified_gaps: always from evidence.json (no bundle equivalent).
  const evidence = readJsonFile(path.join(artifactDir, 'evidence.json'));
  if (evidence && Array.isArray(evidence.not_verified_gaps) && evidence.not_verified_gaps.length > 0) {
    for (const gap of evidence.not_verified_gaps.slice(0, 3)) {
      warnings.push(`${base} evidence NOT_VERIFIED gap: ${safeOneLine(gap)}`);
    }
  }

  // ── Critique: bundle-first status, critique.json for finding details ──────
  const critique = readJsonFile(path.join(artifactDir, 'critique.json'));

  if (bundleClaims) {
    // Phase 4b: read critique status from trust.bundle claims.
    // P-c: pass declaredClaimTypes so declared-type critique claims are included.
    const critiqueStatusVal = bundleCritiqueStatus(bundleClaims, declaredClaimTypes);
    const critiqueIsBlocking = critiqueStatusVal !== null && normalizedStatus(critiqueStatusVal) !== 'pass';
    if (critiqueIsBlocking) {
      warnings.push(`${base} critique status:${safeOneLine(critiqueStatusVal || 'unknown', 40)}; required critique must pass or findings be accepted.`);
      // Finding details: still from critique.json when present (both paths use the same details source).
      const critiques = critique && Array.isArray(critique.critiques) ? critique.critiques : [];
      let openCount = 0;
      for (const review of critiques) {
        const findings = Array.isArray(review && review.findings) ? review.findings : [];
        for (const finding of findings) {
          if (!finding || normalizedStatus(finding.status) !== 'open') continue;
          warnings.push(`${base} critique open ${safeOneLine(finding.severity || 'unknown', 40)}: ${safeOneLine(finding.description)}`);
          openCount += 1;
          if (openCount >= 3) break;
        }
        if (openCount >= 3) break;
      }
    }
  } else {
    // Fallback: no bundle — read from critique.json (existing behavior, no regression).
    if (critique && critique.required === true && normalizedStatus(critique.status) !== 'pass') {
      warnings.push(`${base} critique status:${safeOneLine(critique.status || 'unknown', 40)}; required critique must pass or findings be accepted.`);
      const critiques = Array.isArray(critique.critiques) ? critique.critiques : [];
      let openCount = 0;
      for (const review of critiques) {
        const findings = Array.isArray(review && review.findings) ? review.findings : [];
        for (const finding of findings) {
          if (!finding || normalizedStatus(finding.status) !== 'open') continue;
          warnings.push(`${base} critique open ${safeOneLine(finding.severity || 'unknown', 40)}: ${safeOneLine(finding.description)}`);
          openCount += 1;
          if (openCount >= 3) break;
        }
        if (openCount >= 3) break;
      }
    }
  }

  return warnings;
}

// -----------------------------------------------------------------------
// Capture-first evidence determinism (Part B)
//
// The trust.bundle (emitted by workflow-sidecar via @kontourai/surface) carries
// capture-authoritative evidence items. The capture hook (evidence-capture.js)
// writes REAL command results to command-log.jsonl at the source. Here at the
// Stop gate we cross-reference claimed-pass command checks against that captured
// truth, and only fall back to re-running a TRUSTED command when the log has no
// execution for a claimed-pass command (i.e. it was never actually run).
//
// ADR 0010 Phase 4b: source the claimed-pass command checks from the bundle's
// evidence[] (execution/command items) instead of evidence.json checks.
// command-log.jsonl path UNCHANGED — it stays the capture truth source.
// -----------------------------------------------------------------------

function normalizeCommand(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * #362 (iteration-2 fix item 4/LOW): single-sourced human-facing remediation phrase for an
 * ambiguous bare grep/diff exit-1 command. Every emission site below (captureCrossReference's
 * capture-log cross-reference branch, its live-backstop-re-run branch, and
 * capturedFailReconciliation's ambiguous bucket) interpolates this constant rather than
 * re-duplicating the literal string — mirrors how `isAmbiguousAbsenceCommand` itself is
 * single-sourced (required once from ./lib/runnable-command.js, never reimplemented per call
 * site). Cross-ref: src/cli/workflow-sidecar.ts keeps its OWN copy of the shared fragment
 * (`AMBIGUOUS_REMEDIATION_ADVICE`) for its two record-time emission sites — the two files do not
 * share a module for this string, so each file single-sources independently.
 */
const AMBIGUOUS_REMEDIATION = "re-record this check as a self-asserting command ('! grep ...' or 'grep -c ... | grep -qx 0')";

/**
 * #362: a bare (non-self-asserting) grep/diff exit 1 is exit-code-AMBIGUOUS (zero
 * matches/no diff — could be the author's intended PASS for an absence check, or an
 * unintended miss for a presence check), not a genuine FAIL. This is the SAME narrow,
 * two-binary-only carve-out `isAmbiguousAbsenceCommand` already applies at capture time
 * (`evidence-capture.js`'s `observeResult`) — reused here (not reimplemented) so a log
 * entry's `observedResult` and this re-derivation from raw exitCode can never disagree.
 * Exit codes >=2 for grep/diff remain hard FAILs (real tool errors) — this carve-out is
 * exactly exitCode === 1, nothing wider.
 *
 * Iteration-2 (re-plan) finding #3 (HIGH): `ambiguous` now has TWO distinct origins, threaded
 * via the additive `absenceAmbiguous` discriminator so existing #362 callers are unaffected:
 *   - absence-ambiguous (#362 carve-out): `exitCode===1` on a bare grep/diff — the command
 *     genuinely RAN and produced exit 1. `absenceAmbiguous:true`.
 *   - no-signal-ambiguous (rule-3 default): `observedResult==='ambiguous'` with no exit code
 *     recoverable (e.g. an unreadable codex host banner) — capture saw the command run but got
 *     NO usable pass/fail signal. `absenceAmbiguous:false`.
 * Callers that need the #362-specific grep/diff wording/HARD_BLOCK branch on `absenceAmbiguous`;
 * callers that just need "was this ambiguous at all" keep using `ambiguous`.
 *
 * @param {{command?: string, observedResult?: string, exitCode?: number}} entry
 * @returns {{failed: boolean, ambiguous: boolean, absenceAmbiguous: boolean}}
 */
function classifyLogEntry(entry) {
  const exitCode = Number.isInteger(entry.exitCode) ? entry.exitCode : null;
  const absenceAmbiguous = exitCode === 1 && isAmbiguousAbsenceCommand(entry.command);
  const ambiguous = entry.observedResult === 'ambiguous' || absenceAmbiguous;
  if (ambiguous) return { failed: false, ambiguous: true, absenceAmbiguous };
  const failed = entry.observedResult === 'fail' || (exitCode !== null && exitCode !== 0);
  return { failed, ambiguous: false, absenceAmbiguous: false };
}

/**
 * Read command-log.jsonl into a map of normalized-command -> aggregate outcome.
 * If the same command was run more than once, a single FAIL makes the aggregate
 * a fail (a caught false-completion must not be masked by a later pass-claim). A
 * bare grep/diff exit-1 (#362) is carved out as `ambiguous` rather than `failed` — it
 * is surfaced as a distinct warning class by callers, never silently dropped, and
 * never treated as a hard block.
 */
function readCommandLog(artifactDir) {
  const file = path.join(artifactDir, 'command-log.jsonl');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return new Map(); }
  const byCommand = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (!entry || typeof entry.command !== 'string') continue;
    const key = normalizeCommand(entry.command);
    if (!key) continue;
    const { failed, ambiguous, absenceAmbiguous } = classifyLogEntry(entry);
    const prev = byCommand.get(key);
    byCommand.set(key, {
      ran: true,
      failed: failed || (prev ? prev.failed : false),
      ambiguous: !failed && (ambiguous || (prev ? prev.ambiguous : false)),
      absenceAmbiguous: !failed && (absenceAmbiguous || (prev ? prev.absenceAmbiguous : false)),
      exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : (prev ? prev.exitCode : null),
    });
  }
  return byCommand;
}

/**
 * Read command-log.jsonl into a map of normalized-command -> LATEST capture outcome.
 * The LAST entry for each command wins (unlike readCommandLog which makes FAIL sticky).
 * Used for both capturedFailReconciliation and captureCrossReference (Fix C): we want to
 * know the LAST result, so a genuine re-run-to-pass clears the earlier FAIL. Only an actual
 * re-run (new PASS entry in the log) clears it — a new claim cannot change the log. #362: a
 * bare grep/diff exit-1 is carved out as `ambiguous` (via the shared `classifyLogEntry`), not
 * `failed` — same rationale as `readCommandLog` above.
 */
function readLatestCommandLog(artifactDir) {
  const file = path.join(artifactDir, 'command-log.jsonl');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return new Map(); }
  const byCommand = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (!entry || typeof entry.command !== 'string') continue;
    const key = normalizeCommand(entry.command);
    if (!key) continue;
    const { failed, ambiguous, absenceAmbiguous } = classifyLogEntry(entry);
    // LAST entry wins — genuine re-run-to-pass overwrites the earlier FAIL/ambiguous.
    byCommand.set(key, {
      ran: true,
      failed,
      ambiguous,
      absenceAmbiguous,
      exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : null,
    });
  }
  return byCommand;
}

// ─── Claim-status helpers for capturedFailReconciliation ─────────────────────

/**
 * Returns true when a claim's stored status+value asserts the command PASSED.
 * Used to detect namespace-agnostic false-completions.
 */
function claimAssertsPass(status, value) {
  const s = String(status || '').toLowerCase();
  const v = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // Fix E: added 'approved' status alias and 'true'/'ok' value aliases
  return (s === 'verified' || s === 'assumed' || s === 'accepted' || s === 'trusted' || s === 'approved')
    && (v === 'pass' || v === 'passed' || v === 'verified' || v === 'true' || v === 'ok');
}

/**
 * Returns true when a claim's stored status+value ACKNOWLEDGES a failure
 * (the agent owned the failure rather than claiming pass).
 */
function claimAcknowledgesFailure(status, value) {
  const s = String(status || '').toLowerCase();
  const v = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return s === 'disputed' || s === 'rejected' || s === 'failing' || s === 'failed'
    || s === 'not_verified' || s === 'not-verified'
    || v === 'fail' || v === 'failed' || v === 'not_verified' || v === 'failing';
}

// hasLaunderingOperator (the exit-code-mask heuristic) is imported from
// ../lib/command-log-chain.js so this verifier and scripts/ci/trust-reconcile.js
// share one normative definition. Applied in captureCrossReference's satisfied
// path and capturedFailReconciliation.

// ─── Hash-chain integrity verification (Increment B2, tamper-EVIDENCE) ────────
//
// command-log.jsonl is the independent capture truth source. Each chained entry
// carries a `_chain` block: {seq, prevHash, hash} where
//   hash = sha256(prevHash + canonicalJson(record))
// and canonicalJson is the record WITHOUT `_chain`, keys sorted alphabetically.
//
// HONEST FRAMING: this is tamper-EVIDENCE, not tamper-PROOF. An agent that
// rewrites all hashes can still forge a valid chain. The real tamper-proof
// boundary is the signed checkpoint (B1). This raises the local bar and catches
// casual/accidental tampering and corruption.
//
// verifyCommandLogChain returns:
//   "ok"     — all entries have _chain and every hash/linkage is valid.
//   "legacy" — no _chain fields at all (pre-B2 log); treat as today, no
//              integrity claim. Backward-compat: existing fixtures stay green.
//   "broken" — a chained entry has a bad hash or bad linkage; the capture
//              truth source appears altered/removed/reordered.
//
// The genesis prevHash is a fixed arbitrary sentinel — NOT the SHA256 of any
// specific input string. The comment in evidence-capture.js previously (and
// incorrectly) claimed it was sha256("flow-agents:command-log:genesis"); it is not.
// Both the genesis (CHAIN_GENESIS_VERIFY, imported above) and the canonical-JSON
// helper (canonicalJsonForChain) come from ../lib/command-log-chain.js, the single
// source the writer in evidence-capture.js imports too — so they cannot diverge.

/**
 * Verify the hash chain of command-log.jsonl.
 * Returns { status, brokenAt, forkAt } where:
 *   status  = "ok" | "legacy" | "broken" | "forked"
 *   brokenAt = index (0-based) of the first broken entry, or null
 *   forkAt   = index (0-based) of the first concurrent-fork sibling, or null
 *
 * "forked" is a BENIGN concurrent-append race, not tampering: two PostToolUse
 * captures appended off the same parent tip (e.g. parallel agents sharing one
 * log) before the writer lock (flow-agents#232) serialized them. It is
 * distinguished from "broken" because:
 *   - every entry's hash is still self-consistent (no content was edited), and
 *   - every entry's parent is reachable (nothing was reordered or removed);
 *   - the only anomaly is a parent claimed by >1 capture-sourced sibling.
 * Tamper — a content edit (self-hash mismatch), a reorder, or a deletion
 * (unreachable parent) — still returns "broken". A fork cannot be used to
 * launder a content edit: editing a record breaks its self-hash, which is
 * checked before fork classification.
 */
function verifyCommandLogChain(artifactDir) {
  const file = path.join(artifactDir, 'command-log.jsonl');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { status: 'legacy', brokenAt: null, forkAt: null }; }

  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { status: 'legacy', brokenAt: null, forkAt: null };

  // Parse all entries, tolerating unparseable lines (they count as legacy/unchained).
  const entries = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object') entries.push(entry);
    } catch { /* skip malformed lines */ }
  }
  if (entries.length === 0) return { status: 'legacy', brokenAt: null, forkAt: null };

  // Classify: are there any chained entries?
  const hasAnyChain = entries.some(e => e._chain && typeof e._chain.hash === 'string');
  if (!hasAnyChain) return { status: 'legacy', brokenAt: null, forkAt: null };

  // Walk in file order. A chained entry is ACCEPTED when both:
  //   (a) self-consistent: hash === sha256(prevHash + canonicalJson(record)),
  //       so a content edit (e.g. flipping exitCode) without rehashing fails; and
  //   (b) reachable: prevHash is genesis or the hash of any prior accepted entry.
  // We track the SET of reachable hashes (not just the latest tip) so that
  // concurrent-fork siblings — which share a still-reachable parent — are
  // tolerated, while a reorder/deletion (parent not reachable) is caught.
  const reachable = new Set([CHAIN_GENESIS_VERIFY]);
  const parentSources = new Map(); // prevHash -> [source, ...] (fork detection)
  let prevWasChained = false;
  let forked = false;
  let firstForkAt = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const chain = entry._chain;
    if (!chain || typeof chain.hash !== 'string') {
      // Legacy entry without _chain. If we have already seen a chained entry,
      // a gap in the chain (a legacy entry in the middle) counts as broken
      // (it could indicate a removed chained entry was replaced by a legacy one).
      if (prevWasChained) return { status: 'broken', brokenAt: i, forkAt: null };
      // Before any chained entry: tolerate (legacy prefix).
      continue;
    }

    // (a) Self-consistency. A content edit without rehashing fails here.
    if (typeof chain.prevHash !== 'string') return { status: 'broken', brokenAt: i, forkAt: null };
    const selfHash = crypto.createHash('sha256')
      .update(chain.prevHash + canonicalJsonForChain(entry), 'utf8')
      .digest('hex');
    if (chain.hash !== selfHash) return { status: 'broken', brokenAt: i, forkAt: null };

    // (b) Reachability. An unreachable parent means a reorder or a removed
    // predecessor — structural tamper, not a benign concurrent append.
    if (!reachable.has(chain.prevHash)) return { status: 'broken', brokenAt: i, forkAt: null };

    // Fork detection: a parent claimed by more than one entry is a fork. It is
    // benign only when EVERY sibling on that parent is a PostToolUse capture
    // (two captures racing on the same tip). Any non-capture sibling on a
    // shared parent is treated as tamper (conservative).
    const sources = parentSources.get(chain.prevHash) || [];
    sources.push(entry.source);
    parentSources.set(chain.prevHash, sources);
    if (sources.length > 1) {
      if (!sources.every(s => s === 'postToolUse-capture')) {
        return { status: 'broken', brokenAt: i, forkAt: null };
      }
      if (firstForkAt === null) firstForkAt = i;
      forked = true;
    }

    reachable.add(chain.hash);
    prevWasChained = true;
  }

  if (forked) return { status: 'forked', brokenAt: null, forkAt: firstForkAt };
  return { status: 'ok', brokenAt: null, forkAt: null };
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a TRUSTED command to re-run for a claimed-pass check whose command was
 * never captured. Priority (most trusted first):
 *   (a) the command named by the matching acceptance criterion (acceptance.json
 *       evidence_ref of kind "command", `excerpt`/`command`) — authored upfront.
 *   (b) the project's declared manifest target — package.json scripts.{test,
 *       build,lint}, Makefile target, cargo test, pyproject/tox, just/task.
 *   (c) the model's free-form evidence.checks[].command — ONLY when
 *       FLOW_AGENTS_GOAL_FIT_RECHECK=true (the RCE-risky opt-in path).
 * Returns { argv, cwd, source } or null when nothing trusted resolves.
 */
// WS8 (AC10b): isRunnableCommandText now lives in ./lib/runnable-command.js (single
// source of truth shared with workflow-sidecar.ts's record-time validation, #412).

function resolveTrustedCommand(root, artifactDir, check, acceptance) {
  // (a) acceptance criterion command for the matching criterion.
  const fromAcceptance = acceptanceCommandFor(check, acceptance);
  if (fromAcceptance) {
    // WS8 (AC10b): never spawn a prose "excerpt" as bash. A kind:"command" ref whose text
    // is not a runnable shell command is malformed-evidence — reported distinctly, not
    // executed, and not conflated with a caught false-completion.
    if (!isRunnableCommandText(fromAcceptance)) return { malformed: fromAcceptance };
    // DIALECT-PRESERVATION INVARIANT (#362): from THIS POINT ONWARD, `fromAcceptance` MUST be
    // passed through to argv[2] unmodified from `acceptanceCommandFor`'s return value — never
    // re-trimmed, re-escaped, re-quoted, or reconstructed from a parsed/tokenized form. The
    // recorded command's regex dialect and flags (e.g. `grep -E '(foo|bar)'`'s ERE alternation/
    // grouping, or any other -E/-P/-G flag combination) are part of the evidence-ref text itself;
    // re-deriving the command string from anything other than this exact `fromAcceptance` value
    // would silently reinterpret an ERE-recorded pattern as BRE (or vice versa) on re-run,
    // corrupting the very check this backstop exists to confirm.
    //
    // KNOWN ACCEPTED UPSTREAM BOUNDARY: this guarantee begins at `acceptanceCommandFor`'s return
    // value, NOT at the raw evidence-ref text — it is NOT "byte-for-byte, exactly as recorded in
    // the evidence ref" (a prior version of this comment overclaimed that). `acceptanceCommandFor`
    // derives `fromAcceptance` via `normalizeCommand` (~line 686: `.replace(/\s+/g, ' ').trim()`),
    // which collapses whitespace runs and trims BEFORE this invariant's scope begins. Regex
    // dialect metacharacters (-E, |, +, (), etc.) are single characters/short tokens, not
    // whitespace, so they are untouched by this collapse and survive intact — but a literal
    // multi-space or tab run *inside* a recorded pattern (e.g. two spaces in `grep -E 'foo  bar'`)
    // does NOT survive verbatim; it is already collapsed to one space by the time it reaches this
    // function. That is a pre-existing, accepted normalization boundary (not introduced by this
    // invariant, and not something this invariant claims to cover) — not a dialect-preservation
    // gap.
    // `runBackstop` (below) preserves this invariant on its side by reading `trusted.argv[2]`
    // verbatim rather than re-joining `argv` with spaces — see runBackstop's own
    // DIALECT-PRESERVATION INVARIANT comment for that half of the contract.
    // A regression eval (evals/integration/test_goal_fit_hook.sh, "#362 dialect preservation")
    // pins this end-to-end with a `grep -E` ERE-only alternation construct.
    return { argv: ['bash', '-lc', fromAcceptance], cwd: root, source: 'acceptance' };
  }

  // (b) declared manifest target. Map the check command/id to a declared script.
  const declared = declaredManifestTarget(root, check);
  if (declared) return { argv: declared.argv, cwd: declared.cwd || root, source: 'manifest' };

  // (c) free-form model command — opt-in only.
  if (String(process.env.FLOW_AGENTS_GOAL_FIT_RECHECK || '').toLowerCase() === 'true') {
    const cmd = normalizeCommand(check && check.command);
    if (cmd) return { argv: ['bash', '-lc', cmd], cwd: root, source: 'model-command (FLOW_AGENTS_GOAL_FIT_RECHECK)' };
  }
  return null;
}

function acceptanceCommandFor(check, acceptance) {
  if (!acceptance || !Array.isArray(acceptance.criteria)) return null;
  const checkId = normalizedStatus(check && check.id);
  const checkCmd = normalizeCommand(check && check.command);
  let firstCommand = null;
  for (const criterion of acceptance.criteria) {
    const refs = Array.isArray(criterion && criterion.evidence_refs) ? criterion.evidence_refs : [];
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object' || ref.kind !== 'command') continue;
      const refCmd = normalizeCommand(ref.excerpt || ref.command);
      if (!refCmd) continue;
      if (!firstCommand) firstCommand = refCmd;
      // Strong match: the criterion id matches the check id, or the commands match.
      const idMatch = checkId && normalizedStatus(criterion.id) === checkId;
      if (idMatch || (checkCmd && refCmd === checkCmd)) return refCmd;
    }
  }
  // No id/command match — only fall back to the first authored command when the
  // check itself names no command (so we still have an upfront-trusted target).
  return checkCmd ? null : firstCommand;
}

/**
 * Map a claimed-pass command check to a project-declared, NAMED manifest target.
 * Never allowlists arbitrary strings: we only run a target the project itself
 * declared (npm script, Makefile target, cargo/tox/just/task). The check's
 * command/id is used to pick WHICH declared target (test|build|lint), not to run
 * the raw string. `veritas readiness` is just one such declared command — no
 * special-casing.
 */
function declaredManifestTarget(root, check) {
  const haystack = `${normalizeCommand(check && check.command)} ${normalizedStatus(check && check.id)} ${normalizedStatus(check && check.kind)}`.toLowerCase();
  let want = null;
  if (/\btest|spec|jest|vitest|pytest\b/.test(haystack)) want = 'test';
  else if (/\bbuild|compile|bundle\b/.test(haystack)) want = 'build';
  else if (/\blint|format|style|typecheck\b/.test(haystack)) want = 'lint';
  if (!want) return null;

  // package.json scripts.{test,build,lint}
  const pkg = readJsonFile(path.join(root, 'package.json'));
  if (pkg && pkg.scripts && typeof pkg.scripts === 'object') {
    const scriptName = pkg.scripts[want] ? want
      : want === 'lint' && pkg.scripts.typecheck ? 'typecheck'
        : null;
    if (scriptName) return { argv: ['npm', 'run', scriptName, '--silent'], cwd: root };
  }
  // Makefile target
  const makefile = ['Makefile', 'makefile', 'GNUmakefile'].map(n => path.join(root, n)).find(p => fs.existsSync(p));
  if (makefile) {
    try {
      const text = fs.readFileSync(makefile, 'utf8');
      if (new RegExp(`^${want}\\s*:`, 'm').test(text)) return { argv: ['make', want], cwd: root };
    } catch { /* ignore */ }
  }
  // cargo
  if (want === 'test' && fs.existsSync(path.join(root, 'Cargo.toml'))) return { argv: ['cargo', 'test'], cwd: root };
  if (want === 'build' && fs.existsSync(path.join(root, 'Cargo.toml'))) return { argv: ['cargo', 'build'], cwd: root };
  // py ecosystem: tox / pyproject (declared test target)
  if (want === 'test' && fs.existsSync(path.join(root, 'tox.ini'))) return { argv: ['tox'], cwd: root };
  if (want === 'test' && fs.existsSync(path.join(root, 'pyproject.toml'))) return { argv: ['pytest'], cwd: root };
  // just / task runners
  for (const runner of [['just', 'justfile'], ['task', 'Taskfile.yml'], ['task', 'Taskfile.yaml']]) {
    if (fs.existsSync(path.join(root, runner[1]))) return { argv: [runner[0], want], cwd: root };
  }
  return null;
}

function resolveBackstopTimeout() {
  const raw = Number.parseInt(process.env.FLOW_AGENTS_GOAL_FIT_BACKSTOP_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 120000;
}

/**
 * Whether the trusted backstop re-run may ride block mode. Default-on so a
 * never-actually-run claimed-pass command is caught, but operator-disablable for
 * latency via FLOW_AGENTS_GOAL_FIT_BACKSTOP=off (re-run becomes warn-only) or
 * =skip (no re-run at all → record NOT_VERIFIED instead).
 */
function resolveBackstopMode() {
  const v = String(process.env.FLOW_AGENTS_GOAL_FIT_BACKSTOP || '').trim().toLowerCase();
  if (v === 'off' || v === 'warn' || v === 'skip' || v === 'block') return v === 'warn' ? 'off' : v;
  return 'block';
}

/**
 * #362: `classification` is a three-state result (`'pass'`/`'fail'`/`'ambiguous'`) rather than
 * the old boolean `passed` — `'ambiguous'` iff the re-run command text is a bare (non-negated,
 * non-count-asserted, non-chained) `grep`/`diff` invocation (`isAmbiguousAbsenceCommand`) AND
 * `exitCode === 1` (zero matches/no diff — could be the author's intended PASS for an absence
 * check, never silently coerced to pass OR fail). `'fail'` iff `exitCode !== 0` and not the
 * ambiguous case (this still includes exitCode >= 2 for grep/diff — a real tool error, e.g. a
 * missing file — which stays a hard fail, proving the carve-out is narrowly scoped). `'pass'`
 * iff `exitCode === 0`. `trusted.argv.join(' ')` is passed to `isAmbiguousAbsenceCommand` (it
 * already unwraps a `bash -lc '<command>'` wrapper on its own, so the `['bash', '-lc', cmd]`
 * shape `resolveTrustedCommand`'s acceptance/model-command sources produce is inspected
 * correctly; a `declared`-manifest-target argv like `['npm', 'test']` simply never matches
 * `grep`/`diff` as its first token, so it is never misclassified ambiguous).
 *
 * DIALECT-PRESERVATION INVARIANT (#362): `commandText` below MUST be `trusted.argv[2]`'s value,
 * verbatim — never re-derived, re-joined, or re-quoted from `trusted.argv`. The recorded
 * command's exact dialect/flags (e.g. `grep -E '(foo|bar)'`'s ERE alternation) are part of the
 * evidence ref text; re-joining `argv` with spaces (or any other reconstruction) would silently
 * reintroduce a BRE/ERE dialect mismatch — the exact bug this invariant exists to prevent. This
 * mirrors the equivalent invariant on `resolveTrustedCommand`'s `acceptance` branch below (search
 * DIALECT-PRESERVATION INVARIANT there, including its accepted whitespace-collapse boundary
 * note) — the same recorded string must survive unmodified from `acceptanceCommandFor`'s return
 * value through to this spawnSync call.
 *
 * @param {{argv: string[], cwd: string}} trusted
 * @returns {{ran: boolean, exitCode?: number, classification?: 'pass'|'fail'|'ambiguous', error?: string, timedOut?: boolean}}
 */
function runBackstop(trusted) {
  const result = spawnSync(trusted.argv[0], trusted.argv.slice(1), {
    cwd: trusted.cwd,
    encoding: 'utf8',
    timeout: resolveBackstopTimeout(),
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return { ran: false, error: result.error.code || result.error.message };
  if (result.signal) return { ran: false, error: `killed (${result.signal})`, timedOut: result.signal === 'SIGKILL' || result.signal === 'SIGTERM' };
  const exitCode = result.status;
  // The `['bash', '-lc', <command-text>]` shape resolveTrustedCommand's acceptance/
  // model-command sources produce carries the ORIGINAL recorded command text verbatim in
  // argv[2] — pass THAT (not a re-joined/re-quoted `argv.join(' ')`, which would lose the
  // shell-quoting isAmbiguousAbsenceCommand's `bash -lc '...'` unwrap regex requires) to the
  // heuristic. A `declared`-manifest-target argv (e.g. `['npm', 'test']`) has no such wrapper;
  // joining it is fine since its first token is never `grep`/`diff` anyway.
  const commandText = (trusted.argv.length === 3 && trusted.argv[0] === 'bash' && trusted.argv[1] === '-lc')
    ? trusted.argv[2]
    : trusted.argv.join(' ');
  const ambiguous = exitCode === 1 && isAmbiguousAbsenceCommand(commandText);
  const classification = ambiguous ? 'ambiguous' : (exitCode === 0 ? 'pass' : 'fail');
  return { ran: true, exitCode, classification };
}

/**
 * ADR 0010 Phase 4b: captureCrossReference — bundle-first command check sourcing.
 * Sources the claimed-pass command checks from trust.bundle evidence[] (execution/
 * command items) when the bundle is present, falling back to evidence.json checks
 * for bundle-less sessions. command-log.jsonl UNCHANGED — it stays the capture
 * truth source. The teeth (claimed-pass + captured-fail → block) are byte-identical.
 *
 * ADR 0016 P-c (fix): accept activeFlowStep so declared-type sessions (e.g.
 * builder.verify.tests) are visible to the cross-reference, closing the hole
 * where captureCrossReference was the only capture consumer not threaded with
 * the FlowDefinition. Mirrors the pattern in bundleEnforcement / sidecarGuidance.
 */
function captureCrossReference(root, artifactDir, activeFlowStep) {
  // Build the declared claimType set from the FlowDefinition gate expects[] (P-c).
  // Null when no FlowDefinition is active (fallback: bundleClaimedPassCommandChecks
  // uses workflow.check.* prefix only — no regression for non-FlowDefinition sessions).
  const declaredClaimTypes = declaredClaimTypesFor(activeFlowStep);
  const bundle = readJsonFile(path.join(artifactDir, 'trust.bundle'));
  const acceptance = readJsonFile(path.join(artifactDir, 'acceptance.json'));
  const log = readLatestCommandLog(artifactDir); // Fix C: latest-wins; genuine fix-then-rerun-to-pass clears the block
  const base = relative(root, artifactDir);
  const backstopMode = resolveBackstopMode();
  const warnings = [];
  const captureState = readJsonFile(path.join(artifactDir, 'state.json'));
  const terminalDelivered = isTerminalDeliveredState(captureState);

  // AC3 fail-closed: detect a missing command log in a post-execution session.
  // When state.json confirms the session is past the planning phase (commands should
  // have run), but command-log.jsonl is absent, emit a FULL_BLOCK warning.
  // A genuine pre-execution session (no commands expected yet) is NOT blocked —
  // distinguished by requiring BOTH a non-pre-execution phase AND a non-pre-execution
  // status (avoids blocking a freshly planned task that has state.json but no log yet).
  //
  // BAR-RAISER: an agent could forge state.json with a pre-execution phase to avoid
  // this. The real anchor is external (signed checkpoints + human review).
  {
    const logFileMissing = !fs.existsSync(path.join(artifactDir, 'command-log.jsonl'));
    if (logFileMissing) {
      if (captureState) {
        const capturePhase = normalizedStatus(captureState.phase || '');
        const captureStatus = normalizedStatus(captureState.status || '');
        // Post-execution: phase is set AND not a pre-execution phase (idea/backlog/pickup/planning).
        // Also require status is not a pre-execution status (new/planning/planned/backlog).
        const postExecPhase = capturePhase && !PRE_EXECUTION_PHASES.has(capturePhase);
        const preExecStatus = !captureStatus || captureStatus === 'new' || PRE_EXECUTION_STATUSES.has(captureStatus);
        if (postExecPhase && !preExecStatus) {
          // Fix #216 over-block: only emit the missing-log warning when a command was
          // actually EXPECTED to be captured — i.e., the trust.bundle evidence has at
          // least one item with execution.label (concrete proof a command was meant to
          // be captured). A no-command session (doc review, policy task advanced to
          // verification without running shell commands) must NOT be blocked here.
          // Note: `bundle` is already read at the top of captureCrossReference.
          const captureEvidence = bundle && Array.isArray(bundle.evidence) ? bundle.evidence : [];
          const hasExpectedCapture = captureEvidence.some(ev => ev && ev.execution && ev.execution.label);
          if (hasExpectedCapture) {
            warnings.push(
              `${base} expected capture log is missing — possible deletion of the capture truth source; ` +
              `phase:${capturePhase} status:${captureStatus} indicates commands should have run. ` +
              'Cannot verify command execution deterministically. ' +
              'Restore from a checkpoint or investigate.'
            );
          }
        }
      }
    }
  }

  // ── Hash-chain integrity check ──────────────────────────────────────────────
  // Verify command-log.jsonl before trusting its pass/fail signals. If the chain
  // is broken (altered, removed, or reordered entries), the capture truth source
  // is compromised: we must NOT trust its pass signals for claimed-pass checks.
  //
  // ok     → proceed normally (chain is valid, log is trustworthy).
  // legacy → proceed normally (pre-B2 log, no chain to verify, existing behavior).
  // forked → benign concurrent-append race (not tampering): emit a loud but
  //          NON-blocking advisory and keep trusting the records. The capture
  //          contradiction teeth still run (the records are genuine, just not
  //          linearly ordered); the operator can re-linearize with the repair
  //          tool. This is what stops honest parallel work from being trapped.
  // broken → emit a loud warning and treat ALL claimed-pass commands relying on
  //          this log as NOT_VERIFIED/blocking — do not let them sail through.
  let chainBroken = false;
  {
    const chainResult = verifyCommandLogChain(artifactDir);
    if (chainResult.status === 'broken') {
      chainBroken = true;
      const brokenIdx = chainResult.brokenAt !== null ? ` (entry ${chainResult.brokenAt})` : '';
      warnings.push(
        `${base} command-log integrity check FAILED — capture truth source appears tampered${brokenIdx}: ` +
        'claimed-pass checks relying on it are NOT trusted. ' +
        'This is tamper-EVIDENCE (hash-chain broken); alteration, removal, or reordering detected. ' +
        'NOT_VERIFIED: cannot confirm or deny claimed passes.'
      );
    } else if (chainResult.status === 'forked') {
      // NOT a hard block: this string must not match HARD_BLOCK/FULL_BLOCK. A
      // concurrent fork is benign — no content was edited and nothing was
      // removed — so honest parallel work proceeds. We surface it loudly and
      // point at the deterministic repair.
      const forkIdx = chainResult.forkAt !== null ? ` (entry ${chainResult.forkAt})` : '';
      warnings.push(
        `${base} command-log shows a concurrent-capture fork${forkIdx} — two PostToolUse captures appended off the same parent ` +
        '(parallel writers before the writer lock). This is NOT tampering: every record is self-consistent and reachable. ' +
        'Records remain trusted; re-linearize with: node scripts/repair-command-log.js <artifact-dir>'
      );
    }
  }

  // Build the list of claimed-pass command checks — bundle-first, evidence.json fallback.
  let claimedPass;
  if (bundle && Array.isArray(bundle.claims)) {
    // Phase 4b: source from trust.bundle evidence[] (execution/command items).
    claimedPass = bundleClaimedPassCommandChecks(bundle, declaredClaimTypes);
  } else {
    // Fallback: no bundle — read from evidence.json (existing behavior, no regression).
    const evidence = readJsonFile(path.join(artifactDir, 'evidence.json'));
    if (!evidence || !Array.isArray(evidence.checks)) return warnings;
    claimedPass = evidence.checks.filter(check => {
      if (!check || typeof check !== 'object') return false;
      const kind = normalizedStatus(check.kind);
      const status = normalizedStatus(check.status);
      return kind === 'command' && (status === 'pass' || status === 'passed') && normalizeCommand(check.command);
    });
  }

  for (const check of claimedPass.slice(0, 8)) {
    const cmd = normalizeCommand(check.command);
    if (!cmd) continue;
    const id = safeOneLine(check.id || cmd, 80);
    const logged = log.get(cmd);

    if (!chainBroken && logged && logged.ran) {
      // (1) Cross-reference the capture log first (only when chain is intact).
      // A broken chain means we cannot trust the log's pass signals — skip this
      // shortcut and fall through to the backstop/NOT_VERIFIED path below.
      if (logged.failed) {
        const exit = Number.isInteger(logged.exitCode) ? ` (exitCode:${logged.exitCode})` : '';
        warnings.push(`${base} evidence check ${id}: capture log CONTRADICTS claimed pass — command "${safeOneLine(cmd, 120)}" was recorded as FAIL${exit}. This is a caught false-completion.`);
      } else if (logged.ambiguous && logged.absenceAmbiguous) {
        // #362: a bare grep/diff logged exit 1 — ambiguous (zero matches/no diff), not a
        // caught false-completion. Distinct warning class, never silently dropped, never a
        // hard block. UNCHANGED (byte-identical) — iteration-2 (re-plan) finding #3 Decision A
        // keeps this absence-ambiguous branch verbatim; only the sibling no-signal branch below
        // is new.
        const exit = Number.isInteger(logged.exitCode) ? ` (exitCode:${logged.exitCode})` : '';
        warnings.push(`${base} evidence check ${id}: capture log shows command "${safeOneLine(cmd, 120)}" exited 1${exit} — for bare grep/diff this may mean zero matches/no differences (PASS for an absence check) or an unintended miss (FAIL for a presence check); NOT_VERIFIED (ambiguous): ${AMBIGUOUS_REMEDIATION} to remove the ambiguity.`);
      } else if (logged.ambiguous) {
        // Iteration-2 (re-plan) finding #3 (HIGH), Decision A: generic no-signal-ambiguous — the
        // rule-3 default (`observedResult:'ambiguous'`, no exit code recoverable, e.g. an
        // unreadable/missing codex host banner). This is NOT the #362 grep/diff carve-out (no
        // `absenceAmbiguous`), so the message is grep/diff-FREE and accurate for any command.
        // Deliberately does NOT contain `NOT_VERIFIED (ambiguous)`, `caught false-completion`, or
        // `status:` so it MISSES HARD_BLOCK (warn-only on a terminal/pre-execution stop) while
        // `evidence check` / `NOT_VERIFIED —` still match FULL_BLOCK (blocks a non-terminal stop).
        warnings.push(`${base} evidence check ${id}: claimed pass but NOT_VERIFIED — command "${safeOneLine(cmd, 120)}" was captured with no deterministic pass/fail signal (no exit code observed on this host); a pass requires positive evidence. Re-run it to produce a definitive exit code, or record it as not_verified/accepted_gap.`);
      } else if (hasLaunderingOperator(cmd)) {
        // Fix D: exit-code laundering. The captured exit-0 is not trustworthy — the command
        // baked in '|| true' / '|| :' / '; true' / '; exit 0' / '| true' to mask the real result.
        warnings.push(`${base} evidence check ${id}: claimed pass relies on an exit-code-laundered command "${safeOneLine(cmd, 120)}" — the exit code is not a trustworthy signal (laundering operators mask the real exit code).`);
      }
      // else: log shows it ran and passed with no laundering → satisfied deterministically.
      continue;
    }

    // (2) Backstop: the log has NO execution for this claimed-pass command.
    if (backstopMode === 'skip') {
      warnings.push(`${base} evidence check ${id}: claimed pass but NOT_VERIFIED — command "${safeOneLine(cmd, 120)}" was never captured and backstop re-run is disabled (FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip).`);
      continue;
    }
    const trusted = resolveTrustedCommand(root, artifactDir, check, acceptance);
    if (trusted && trusted.malformed) {
      // WS8 (AC10b): the matching acceptance criterion named a kind:"command" evidence ref
      // whose text is prose, not a runnable command. Do NOT execute it; classify it.
      warnings.push(`${base} evidence check ${id}: malformed-evidence — acceptance criterion names a kind:"command" evidence ref whose text is not a runnable shell command ("${safeOneLine(trusted.malformed, 120)}"); it was NOT executed. Use a literal runnable command, or record the check as not_verified/accepted_gap (see context/contracts/planning-contract.md).`);
      continue;
    }
    if (!trusted) {
      warnings.push(`${base} evidence check ${id}: claimed pass but NOT_VERIFIED — command "${safeOneLine(cmd, 120)}" was never captured and no trusted command (acceptance criterion / declared manifest target) resolves to re-run it. Set FLOW_AGENTS_GOAL_FIT_RECHECK=true to opt into re-running the model's free-form command.`);
      continue;
    }
    if (terminalDelivered && trusted.source === 'model-command (FLOW_AGENTS_GOAL_FIT_RECHECK)') {
      // Terminal delivered/done sessions have finalized evidence. Do not turn
      // model-asserted command text into a new RECHECK false-completion. Captured
      // execution evidence and CI/L2 checks remain the anchors for terminal tasks.
      warnings.push(`${base} evidence check ${id}: malformed-evidence — terminal delivered/done session recorded model-command text asserted by FLOW_AGENTS_GOAL_FIT_RECHECK ("${safeOneLine(cmd, 120)}"); it was NOT re-run on a terminal session. Captured-execution evidence and CI/L2 checks remain the anchors.`);
      continue;
    }
    const outcome = runBackstop(trusted);
    if (!outcome.ran) {
      warnings.push(`${base} evidence check ${id}: claimed pass but NOT_VERIFIED — trusted backstop (${trusted.source}) could not run (${safeOneLine(outcome.error, 80)}).`);
      continue;
    }
    if (outcome.classification === 'ambiguous') {
      // #362: bare grep/diff backstop re-run exited 1 — ambiguous, not a caught
      // false-completion. Never silently PASS (a presence check recorded without
      // negation could genuinely be a miss) and never silently dropped.
      const note = `${base} evidence check ${id}: trusted backstop (${trusted.source}) re-run of "${trusted.argv.join(' ')}" exited 1 — for grep/diff this may mean zero matches/no differences (PASS for an absence check) or an unintended miss (FAIL for a presence check); NOT_VERIFIED (ambiguous): ${AMBIGUOUS_REMEDIATION} to remove the ambiguity.`;
      warnings.push(note);
    } else if (outcome.classification === 'fail') {
      const note = `${base} evidence check ${id}: trusted backstop (${trusted.source}) re-run of "${trusted.argv.join(' ')}" FAILED with exit ${outcome.exitCode}, contradicting the claimed pass. This is a caught false-completion.`;
      if (backstopMode === 'off') warnings.push(`${note} [backstop in warn mode — not blocking]`);
      else warnings.push(note);
    }
    // backstop classification 'pass' → claim deterministically confirmed by re-run, no warning.
  }

  return warnings;
}

/**
 * Namespace-agnostic captured-FAIL reconciliation (AC1 — closes the allowlist bypass).
 *
 * The existing captureCrossReference only checks claims that pass the namespace
 * allowlist (workflow.* prefix or declared gateExpects[]). A kit-typed claim
 * (e.g. builder.verify.tests) whose command-log entry says FAIL can slip through
 * when no active FlowDefinition declares that claimType.
 *
 * This function is namespace-agnostic: it builds the LATEST-capture-per-command map
 * and for each command whose last capture is FAIL it checks:
 *   (A) Any claim (ANY namespace) asserting pass for that command → false-completion HARD_BLOCK
 *       Fix A: runs on EVERY stop (status-independent). A claim contradicting the capture is
 *       a false-completion regardless of whether state.json shows the task as 'done'.
 * Fix D: also checks commands with laundering operators whose latest capture is PASS (exit 0);
 *   a claimed-pass for a laundered command is NOT a trustworthy signal.
 * Fix B: Case B (unaccounted at completion — no-claim-at-all branch) REMOVED.
 *   It over-blocked incidental failures (grep no-match, git diff --exit-code, etc.).
 *   Case A covers the real threat (claimed pass contradicts captured fail).
 * Fix E: verifyCommandLogChain called; on broken chain reconciliation is skipped (log
 *   integrity is already signalled by captureCrossReference).
 *
 * No-over-block guarantees:
 *   - Fail-then-re-run-to-pass: latest is PASS → not in latestFails → no warning.
 *   - Acknowledged failure: claim has failing/disputed status → ackClaims → no warning.
 *   - No-command session: no log → latestLog empty → no warning.
 *   - Incidental fail (grep/diff/find) with no pass-claim → no warning (Case B removed).
 */
function capturedFailReconciliation(root, artifactDir, taskStatus) {
  // Fix A: removed the `completing` guard. Run on EVERY stop — status-independent.
  // A claim contradicting the capture is a false-completion whether or not the agent
  // has set state.json.status to a terminal value. (taskStatus param kept for compat.)

  const latestLog = readLatestCommandLog(artifactDir);
  if (latestLog.size === 0) return []; // No captures — nothing to reconcile

  // Fix E: verify chain integrity; skip reconciliation when broken (log untrusted).
  // The main integrity warning is already emitted by captureCrossReference.
  const chainResult = verifyCommandLogChain(artifactDir);
  if (chainResult.status === 'broken') return []; // Can't trust pass/fail signals

  // Collect commands whose LATEST capture is FAIL (Case A).
  const latestFails = new Map(); // cmd -> {failed:true, exitCode}
  for (const [cmd, info] of latestLog) {
    if (info.failed) latestFails.set(cmd, info);
  }

  // Fix D: Collect commands whose latest capture is PASS (exit 0) but whose command
  // string contains an exit-code-neutralizing operator (laundering). The captured
  // exit-0 is not a trustworthy signal for these — real test failures are hidden.
  const launderedPass = new Map(); // cmd -> {failed:false, exitCode:0}
  for (const [cmd, info] of latestLog) {
    if (!info.failed && hasLaunderingOperator(cmd)) launderedPass.set(cmd, info);
  }

  // Iteration-2 fix item 4 (HIGH, ambiguity-must-not-slip-terminal-stops): a THIRD bucket —
  // commands whose LATEST capture is `ambiguous` (a bare, non-self-asserting grep/diff exit 1;
  // #362) — collected separately from `latestFails`, never merged into it. An ambiguous capture
  // is NOT a caught false-completion (it may genuinely be the author's intended pass for an
  // absence check) — it gets its own distinct re-record-self-asserting message below, never the
  // "caught false-completion" accusation `latestFails`/`launderedPass` use.
  const latestAmbiguous = new Map(); // cmd -> {failed:false, ambiguous:true, exitCode}
  for (const [cmd, info] of latestLog) {
    if (!info.failed && info.ambiguous) latestAmbiguous.set(cmd, info);
  }

  if (latestFails.size === 0 && launderedPass.size === 0 && latestAmbiguous.size === 0) return []; // Nothing to flag

  const base = relative(root, artifactDir);
  const warnings = [];

  // Load the trust.bundle for claim/evidence analysis.
  const bundle = readJsonFile(path.join(artifactDir, 'trust.bundle'));
  const allClaims = bundle && Array.isArray(bundle.claims) ? bundle.claims : [];
  const allEvidence = bundle && Array.isArray(bundle.evidence) ? bundle.evidence : [];

  // Build: claimId → claim (for fast evidence→claim lookup)
  const claimById = new Map();
  for (const c of allClaims) {
    if (c && c.id) claimById.set(c.id, c);
  }

  // commandsToCheck: FAIL-latest commands + laundered-pass commands + ambiguous-latest commands
  const commandsToCheck = new Set([...latestFails.keys(), ...launderedPass.keys(), ...latestAmbiguous.keys()]);

  // For each relevant command, track what claims say about it.
  // cmdAcc: cmd → {passClaims: [...], ackClaims: []}
  const cmdAcc = new Map();
  const initAcc = (cmd) => {
    if (!cmdAcc.has(cmd)) cmdAcc.set(cmd, { passClaims: [], ackClaims: [] });
    return cmdAcc.get(cmd);
  };

  // Path A: evidence items with execution.label link a claim to a specific command.
  for (const ev of allEvidence) {
    if (!ev || !ev.execution || !ev.execution.label) continue;
    const cmd = normalizeCommand(ev.execution.label);
    if (!cmd || !commandsToCheck.has(cmd)) continue;
    const claim = claimById.get(ev.claimId);
    if (!claim) continue;
    const acc = initAcc(cmd);
    const s = String(claim.status || '').toLowerCase();
    const v = normalizedStatus(claim.value || '');
    if (claimAssertsPass(s, v)) acc.passClaims.push(claim);
    if (claimAcknowledgesFailure(s, v)) acc.ackClaims.push(claim);
  }

  // Path B: claim.fieldOrBehavior resolves directly to the command (field-based resolution).
  for (const c of allClaims) {
    if (!c) continue;
    const cmd = normalizeCommand(c.fieldOrBehavior || '');
    if (!cmd || !commandsToCheck.has(cmd)) continue;
    const acc = initAcc(cmd);
    const s = String(c.status || '').toLowerCase();
    const v = normalizedStatus(c.value || '');
    if (claimAssertsPass(s, v)) acc.passClaims.push(c);
    if (claimAcknowledgesFailure(s, v)) acc.ackClaims.push(c);
  }

  // Case A: Evaluate each FAIL-latest command for pass-claims (status-independent).
  for (const [cmd, failInfo] of latestFails) {
    const exit = Number.isInteger(failInfo.exitCode) ? failInfo.exitCode : null;
    const exitStr = exit !== null ? ` (exit ${exit})` : '';
    const acc = cmdAcc.get(cmd);

    if (acc && acc.passClaims.length > 0) {
      // Any-namespace claim asserts pass for a command whose latest capture is FAIL.
      // This is the namespace-agnostic false-completion signal.
      const claim = acc.passClaims[0];
      warnings.push(
        `${base} captured command '${safeOneLine(cmd, 120)}' last ran FAIL${exitStr} ` +
        `but claim ${safeOneLine(claim.subjectId || claim.id, 80)} (${safeOneLine(claim.claimType, 48)}) ` +
        `asserts pass — namespace-agnostic caught false-completion.`
      );
    }
    // Fix B: Case B (unaccounted at completion — no-claim-at-all) REMOVED.
    // It over-blocked incidental failures with no pass-claim. Case A covers the real threat.
    // Acknowledged failure (ackClaims.length > 0) → OK, no warning.
  }

  // Fix D: Evaluate laundered-pass commands for pass-claims.
  for (const [cmd] of launderedPass) {
    const acc = cmdAcc.get(cmd);
    if (acc && acc.passClaims.length > 0) {
      const claim = acc.passClaims[0];
      warnings.push(
        `${base} captured command '${safeOneLine(cmd, 120)}' claimed pass relies on an ` +
        `exit-code-laundered command — claim ${safeOneLine(claim.subjectId || claim.id, 80)} ` +
        `(${safeOneLine(claim.claimType, 48)}) asserts pass but the exit code is not a ` +
        `trustworthy signal (laundering operators mask the real exit code).`
      );
    }
  }

  // Iteration-2 fix item 4 (HIGH): THIRD bucket — commands whose latest capture is `ambiguous`
  // AND some claim asserts pass for them. This is deliberately gated on `acc.passClaims.length >
  // 0` (mirroring Case A / Fix D above) — an ambiguous capture with NO pass-claim at all is not
  // reconciled here (nothing was asserted against it to reconcile), matching the existing
  // no-over-block guarantee for incidental runs. When a claim DOES assert pass for an ambiguous
  // command, this is a DISTINCT re-record-self-asserting message — NEVER the "caught
  // false-completion" accusation Case A/Fix D use, since a bare grep/diff exit 1 may genuinely be
  // the author's intended pass (zero matches/no differences for an absence check). This bucket
  // still BLOCKS a terminal stop (via HARD_BLOCK's dedicated ambiguous pattern below) because the
  // claim is asserting something the capture cannot actually confirm — recording is not the same
  // as verified completion.
  for (const [cmd, ambiguousInfo] of latestAmbiguous) {
    const exit = Number.isInteger(ambiguousInfo.exitCode) ? ambiguousInfo.exitCode : null;
    const exitStr = exit !== null ? ` (exit ${exit})` : '';
    const acc = cmdAcc.get(cmd);
    if (acc && acc.passClaims.length > 0) {
      const claim = acc.passClaims[0];
      if (ambiguousInfo.absenceAmbiguous) {
        // #362 absence-ambiguous — UNCHANGED (byte-identical) message + HARD_BLOCK marker.
        warnings.push(
          `${base} captured command '${safeOneLine(cmd, 120)}' last ran AMBIGUOUS${exitStr} ` +
          `(bare grep/diff exit 1 — zero matches/no differences) and claim ${safeOneLine(claim.subjectId || claim.id, 80)} ` +
          `(${safeOneLine(claim.claimType, 48)}) asserts pass — NOT_VERIFIED (ambiguous): ${AMBIGUOUS_REMEDIATION} and re-run it, then re-record the claim.`
        );
      } else {
        // Iteration-2 (re-plan) finding #3 Decision A: generic no-signal-ambiguous (no exit code
        // ever recoverable) — grep/diff-FREE wording, misses HARD_BLOCK, still matches FULL_BLOCK
        // via `NOT_VERIFIED —` so a non-terminal stop still blocks.
        warnings.push(
          `${base} captured command '${safeOneLine(cmd, 120)}' last ran with no deterministic pass/fail signal${exitStr} ` +
          `(no exit code observed on this host) and claim ${safeOneLine(claim.subjectId || claim.id, 80)} ` +
          `(${safeOneLine(claim.claimType, 48)}) asserts pass — NOT_VERIFIED — re-run it to produce a definitive exit code, then re-record the claim.`
        );
      }
    }
  }

  return warnings;
}

// ─── ADR 0010 Phase 2: enforce on the canonical Hachure trust.bundle ──────────

// ─── ADR 0010 Phase 2: enforce on the canonical Hachure trust.bundle ──────────
// The trust.bundle (emitted by workflow-sidecar via @kontourai/surface) carries
// each claim's Surface-derived status — including capture-authoritative results
// (a claimed-pass whose captured command FAILED is already `disputed` here). A
// high-impact `disputed` claim is the canonical false-completion signal; we gate
// on the bundle the producers already emit, not on bespoke markdown.
//
// ADR 0010 Phase 2b: re-derive-at-gate hardening.
// We re-derive each claim's status from the bundle's own evidence/events/policies
// via Surface's canonical deriveClaimStatus, so editing the stored `claim.status`
// field does not bypass the gate. If the re-derived status is disputed/rejected
// for a high/critical claim, we block. If the re-derived status DIFFERS from the
// stored status (e.g. stored "verified" but evidence re-derives to "disputed"),
// that mismatch is a strong tamper signal — block with an explicit warning.
// Fail-open: if Surface is unavailable, fall back to the stored-status check.
//
// ADR 0016 P-c: when activeFlowStep is non-null, claim-selection uses the gate's
// declared claimType set (gateExpects[].bundle_claim.claimType). When null, the
// existing workflow.* prefix filter runs unchanged (fallback). The re-derivation
// loop, tamper-detection, high/critical filter, and block/exit-2 logic are
// STRUCTURALLY UNCHANGED — only WHICH claims are selected changes.
async function bundleEnforcement(artifactDir, activeFlowStep) {
  const bundle = readJsonFile(path.join(artifactDir, 'trust.bundle'));
  if (!bundle || !Array.isArray(bundle.claims)) return [];

  const surface = await tryLoadSurface();
  const warnings = [];

  const allEvidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  const allEvents = Array.isArray(bundle.events) ? bundle.events : [];
  const allPolicies = Array.isArray(bundle.policies) ? bundle.policies : [];

  // P-c: claim-selection predicate.
  // When activeFlowStep is non-null, select claims whose claimType is in the
  // gate's declared set. When null, fall back to the existing workflow.* prefix
  // filter so no-FlowDefinition sessions are unaffected.
  const declaredClaimTypes = declaredClaimTypesFor(activeFlowStep);

  // SECURITY (Layer 2 — gate-bypass-chain fix): use UNION form instead of if/else.
  // With the old if/else, an empty declaredClaimTypes (Set{}) from a fake flow with
  // expects:[] caused isSelectedClaim to return false for EVERY claim — all
  // bundleEnforcement checks were silently bypassed. The union form ensures workflow.*
  // claims are ALWAYS enforced regardless of whether a FlowDefinition is active or what
  // its expects[] contains. Declared claimTypes are added on top of the baseline.
  //
  // AC3 two-part dependency (regression guard — see test_captured_fail_reconciliation.sh):
  //   Part 1 (this union form): ensures bundleEnforcement always enforces workflow.* claims
  //     regardless of declaredClaimTypes being null or empty Set.
  //   Part 2 (empty-expects guard below): emits gate-misconfiguration HARD_BLOCK when
  //     declaredClaimTypes is a non-null empty Set (active flow with expects:[]).
  //   Both parts are required: Part 1 alone lets the empty-expects bypass slip through
  //   without a loud signal; Part 2 alone without the union would silently pass 0 claims.
  const isSelectedClaim = (claim) => {
    const ct = String(claim.claimType || '');
    // Union: workflow.* is always selected (baseline); declared types extend it.
    return ct.startsWith('workflow.') || (declaredClaimTypes != null && declaredClaimTypes.has(ct));
  };

  // Misconfiguration guard: an active FlowDefinition with zero expects[] is suspicious.
  // Empty expects can indicate a tampered flow definition (the gate-bypass exploit).
  // Emit a hard warning so operators see it regardless of session phase.
  if (declaredClaimTypes !== null && declaredClaimTypes.size === 0) {
    warnings.push(`gate misconfiguration: active FlowDefinition has empty expects[] (possible tampered flow definition or zero-expects bypass attempt); verify the flow definition is authentic before delivery.`);
  }

  // AC3 fail-closed (high-assurance path): when @kontourai/surface is unavailable, we
  // cannot re-derive claim status from evidence/events/policies. For high/critical-impact
  // selected claims this means we silently trust the stored status field — exactly the
  // vector re-derive-at-gate (ADR 0010 Phase 2b) was designed to close.
  // Fail-closed: emit a FULL_BLOCK warning so operators see that re-derivation is absent.
  // Low-impact-only bundles stay non-blocking (noise reduction for common dev sessions).
  //
  // BAR-RAISER, NOT AIRTIGHT: an agent that deletes/corrupts @kontourai/surface to force
  // surface=null would trigger this path deliberately. The real anchor is external:
  // signed checkpoints + human review. This raises the cost of the silent-trust vector.
  if (!surface) {
    const highImpactCount = bundle.claims.reduce((n, claim) => {
      if (!claim || typeof claim !== 'object') return n;
      const impact = String(claim.impactLevel || '').toLowerCase();
      if (impact !== 'high' && impact !== 'critical') return n;
      return isSelectedClaim(claim) ? n + 1 : n;
    }, 0);
    if (highImpactCount > 0) {
      warnings.push(
        `surface unavailable — ${highImpactCount} high/critical-impact claim(s) could not be re-derived at gate; ` +
        'stored claim status is trusted without independent re-derivation (fail-closed: high-assurance path). ' +
        'Ensure @kontourai/surface is installed and importable, or escalate for operator review.'
      );
    }
  }

  for (const claim of bundle.claims) {
    if (!claim || typeof claim !== 'object') continue;
    const impact = String(claim.impactLevel || '').toLowerCase();
    const storedStatus = String(claim.status || '').toLowerCase();
    if (impact !== 'high' && impact !== 'critical') continue;
    // P-c: claim-selection — only process claims matching the active predicate.
    if (!isSelectedClaim(claim)) continue;

    // Step 1: Re-derive status via Surface when available.
    // This closes the gaming vector: editing the stored status field cannot bypass
    // the gate because we recompute from evidence/events/policies.
    let recomputedStatus = null; // null means re-derive was not attempted or threw
    if (surface && typeof surface.deriveClaimStatus === 'function') {
      const claimId = claim.id;
      const claimEvidence = allEvidence.filter(ev => ev && ev.claimId === claimId);
      const claimEvents = allEvents.filter(evt => evt && evt.claimId === claimId);
      try {
        const result = surface.deriveClaimStatus({
          claim,
          evidence: claimEvidence,
          events: claimEvents,
          policies: allPolicies,
        });
        recomputedStatus = result && typeof result.status === 'string' ? result.status.toLowerCase() : 'unknown';
      } catch {
        // deriveClaimStatus threw (e.g. schema mismatch) — fall back to stored status.
        recomputedStatus = null;
      }
    }

    // Step 2: Compute the effective blocking status.
    // Use the STRICTER of stored vs recomputed so neither can be individually
    // gamed: deleting evidence cannot clear a stored `disputed`, and flipping
    // stored to "verified" cannot hide a recomputed `disputed`.
    const effectiveDisputed = storedStatus === 'disputed' || storedStatus === 'rejected'
      || recomputedStatus === 'disputed' || recomputedStatus === 'rejected';

    if (!effectiveDisputed) continue; // neither stored nor recomputed is blocking

    // Step 3: Emit the appropriate warning.
    // Tamper-detection: stored "verified"/"assumed" but evidence re-derives to
    // "disputed"/"rejected" — the stored status was likely altered to bypass the gate.
    const isTampered = recomputedStatus !== null
      && (storedStatus === 'verified' || storedStatus === 'assumed')
      && (recomputedStatus === 'disputed' || recomputedStatus === 'rejected');

    if (isTampered) {
      warnings.push(`trust.bundle claim tampered: ${safeOneLine(claim.subjectId || claim.id, 80)} (${safeOneLine(claim.claimType, 48)}) — stored status "${storedStatus}" does not match recompute "${recomputedStatus}" (possible tampered bundle); caught false-completion. Run: npm run workflow:sidecar -- claim ${safeOneLine(claim.subjectId || claim.id, 80)} ${artifactDir}`);
    } else {
      warnings.push(`trust.bundle claim disputed: ${safeOneLine(claim.subjectId || claim.id, 80)} (${safeOneLine(claim.claimType, 48)}) — Surface recompute shows not verified; caught false-completion. Run: npm run workflow:sidecar -- claim ${safeOneLine(claim.subjectId || claim.id, 80)} ${artifactDir}`);
    }
  }
  return warnings;
}

/**
 * Scope to the session's current task when .kontourai/flow-agents/current.json points at
 * one (mirroring evidence-capture.js). Returns the slug dir, or null to fall back
 * to scanning all of .kontourai/flow-agents (newest-mtime).
 */
function preferredArtifactDir(flowAgentsDir) {
  const { payload: current } = readOwnCurrentPointer(flowAgentsDir, resolveActor(process.env).actor);
  if (!current) return null;
  const slug = current.artifact_dir || current.active_slug;
  if (typeof slug !== 'string' || !slug.trim()) return null;
  const safe = slug.replace(/\.\.+/g, '').replace(/^[/\\]+/, '');
  const dir = path.join(flowAgentsDir, safe);
  return dir.startsWith(flowAgentsDir + path.sep) && fs.existsSync(dir) ? dir : null;
}

/** WS8 (AC10a): a session dir is eligible as "active" only with real sidecar presence. */
function hasSidecarPresence(artifactDir) {
  return fs.existsSync(path.join(artifactDir, 'state.json')) || fs.existsSync(path.join(artifactDir, 'trust.bundle'));
}

function canonicalFlowState(root, artifactDir) {
  if (!artifactDir) return { state: null, definition: null, error: null };
  const slug = path.basename(artifactDir);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { state: null, definition: null, error: 'canonical Flow run slug is malformed' };
  const runDir = path.join(root, '.kontourai', 'flow', 'runs', slug);
  const components = [
    path.join(root, '.kontourai'),
    path.join(root, '.kontourai', 'flow'),
    path.join(root, '.kontourai', 'flow', 'runs'),
    runDir,
  ];
  try {
    const parents = components.map(component => secureDirectoryIdentity(component, 'canonical Flow run parent'));
    const stateRead = readSecureCanonicalJson(path.join(runDir, 'state.json'), 'canonical Flow state', parents, MAX_CANONICAL_FLOW_STATE_BYTES);
    const definitionRead = readSecureCanonicalJson(path.join(runDir, 'definition.json'), 'canonical Flow definition', parents, MAX_CANONICAL_FLOW_DEFINITION_BYTES);
    const state = stateRead.value;
    const definition = definitionRead.value;
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || !CANONICAL_FLOW_STATUSES.has(state.status)
      || state.run_id !== slug
      || typeof state.definition_id !== 'string' || !state.definition_id
      || typeof state.definition_version !== 'string' || !state.definition_version
      || typeof state.current_step !== 'string' || !state.current_step.trim()) {
      return { state: null, definition: null, error: 'canonical Flow state is malformed' };
    }
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)
      || typeof definition.id !== 'string' || !definition.id
      || typeof definition.version !== 'string' || !definition.version
      || !Array.isArray(definition.steps) || definition.steps.length === 0
      || definition.steps.some(step => !step || typeof step !== 'object' || Array.isArray(step) || typeof step.id !== 'string' || !step.id)) {
      return { state: null, definition: null, error: 'canonical Flow definition is malformed' };
    }
    if (state.definition_id !== definition.id || state.definition_version !== definition.version) {
      return { state: null, definition: null, error: 'canonical Flow definition identity does not match state' };
    }
    if (!definition.steps.some(step => step.id === state.current_step)) {
      return { state: null, definition: null, error: 'canonical Flow current_step is not present in definition' };
    }
    assertSecureCanonicalReadStable(stateRead);
    assertSecureCanonicalReadStable(definitionRead);
    assertSecureDirectoriesStable(parents);
    return { state, definition, error: null };
  } catch (error) {
    return { state: null, definition: null, error: `canonical Flow state is unavailable or malformed: ${safeOneLine(error && error.message || error, 120)}` };
  }
}

function readSecureCanonicalJson(file, label, parents, maxBytes) {
  const expected = secureFileIdentity(file, label);
  if (expected.size > maxBytes) throw new Error(`${label} exceeds maximum size`);
  assertSecureDirectoriesStable(parents);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  let bytes;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes || !sameFileIdentity(expected, opened)) throw new Error(`${label} identity changed while opening`);
    bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!sameFileIdentity(expected, after)) throw new Error(`${label} identity changed while reading`);
  } finally {
    fs.closeSync(fd);
  }
  const final = secureFileIdentity(file, label);
  if (!sameFileIdentity(expected, final)) throw new Error(`${label} identity changed after reading`);
  assertSecureDirectoriesStable(parents);
  return { value: JSON.parse(bytes.toString('utf8')), file, label, identity: expected };
}

function assertSecureCanonicalReadStable(read) {
  const final = secureFileIdentity(read.file, read.label);
  if (!sameFileIdentity(read.identity, final)) throw new Error(`${read.label} identity changed before authorization`);
}

function secureDirectoryIdentity(target, label) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a non-symlink directory: ${target}`);
  return { path: target, realpath: fs.realpathSync(target), dev: stat.dev, ino: stat.ino };
}

function secureFileIdentity(target, label) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a non-symlink regular file`);
  return { dev: stat.dev, ino: stat.ino, size: stat.size };
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function assertSecureDirectoriesStable(parents) {
  for (const parent of parents) {
    const current = secureDirectoryIdentity(parent.path, 'canonical Flow run parent');
    if (!sameFileIdentity(parent, current) || current.realpath !== parent.realpath) throw new Error('canonical Flow run parent identity changed');
  }
}

function validatedActiveTurnScope(root) {
  try {
    const runId = process.env.FLOW_AGENTS_CONTINUATION_RUN_ID;
    const turnSecret = process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET;
    if (typeof runId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(runId) || typeof turnSecret !== 'string' || !turnSecret) return null;
    const artifactRoot = path.resolve(flowAgentsArtifactRoot(root));
    const candidate = path.resolve(artifactRoot, runId);
    if (path.dirname(candidate) !== artifactRoot) return null;
    const base = validateSignedActiveTurnAssignmentAuthority({ sessionDir: candidate, runId, turnSecret });
    if (!base.valid) return null;
    const canonicalFlow = canonicalFlowState(root, candidate);
    return { artifactDir: candidate, canonicalFlow, baseAuthority: base };
  } catch {
    return null;
  }
}

// WS8 (AC10a): when current.json names a slug whose session directory does NOT exist,
// return that slug so analyze() can log the staleness rather than silently falling back to
// a global mtime scan that could resurface an abandoned/never-real session as active.
function staleCurrentSlug(flowAgentsDir) {
  const { payload: current } = readOwnCurrentPointer(flowAgentsDir, resolveActor(process.env).actor);
  if (!current) return null;
  const slug = current.artifact_dir || current.active_slug;
  if (typeof slug !== 'string' || !slug.trim()) return null;
  const safe = slug.replace(/\.\.+/g, '').replace(/^[/\\]+/, '');
  const dir = path.join(flowAgentsDir, safe);
  return (dir.startsWith(flowAgentsDir + path.sep) && !fs.existsSync(dir)) ? slug : null;
}

/**
 * A task is pre-execution (work not yet started) when its state.json status/phase
 * is still in the idea→planning band, or (no state.json) its markdown status is.
 */
function isPreExecution(artifactDir, markdownStatus) {
  const state = readJsonFile(path.join(artifactDir, 'state.json'));
  if (state) {
    return PRE_EXECUTION_STATUSES.has(normalizedStatus(state.status))
      || PRE_EXECUTION_PHASES.has(normalizedStatus(state.phase));
  }
  return PRE_EXECUTION_STATUSES.has(normalizedStatus(markdownStatus));
}


// ─── Wave 2c: no-bundle/no-state fallback gate ────────────────────────────────
// Sessions that have NEITHER a trust.bundle NOR a state.json fall through
// both bundleEnforcement (no bundle) and sidecarGuidance (no state). Without the
// old markdown heading checks this would create a silent ungated-session path.
// If a trust.bundle exists, bundleEnforcement handles it. If state.json exists,
// sidecarGuidance handles it. The gap: a session with only a markdown artifact.
//
// ADR 0010 Phase 4b: Adjustment A (Final Acceptance hygiene):
// When the task is delivered but acceptance criteria are still pending, emit the
// Final Acceptance reminder. Read from trust.bundle claims when present; fall back
// to acceptance.json for bundle-less sessions.
//
// ADR 0016 P-c: pass activeFlowStep so bundlePendingCriteriaCount includes declared types.
function missingBundleOrStateSignal(artifactDir, activeFlowStep) {
  // Build the declared claimType set from the FlowDefinition gate expects[] (P-c).
  const declaredClaimTypes = declaredClaimTypesFor(activeFlowStep);
  const warnings = [];
  const hasBundle = fs.existsSync(path.join(artifactDir, 'trust.bundle'));
  const state = readJsonFile(path.join(artifactDir, 'state.json'));

  if (!hasBundle && !state) {
    // Neither trust.bundle nor state.json: session is untracked by sidecar path.
    // Emit a NOT_VERIFIED warning so execution-phase sessions remain gated.
    const base = path.basename(artifactDir);
    warnings.push(`${base} NOT_VERIFIED — no trust.bundle or state.json found; run 'workflow-sidecar record-evidence' to build the evidence record before delivery.`);
    return warnings;
  }

  // Adjustment A: Final Acceptance hygiene.
  // When the task is delivered but acceptance criteria are still pending, emit the
  // Final Acceptance reminder. Bundle-first; fall back to acceptance.json.
  const bundle = readJsonFile(path.join(artifactDir, 'trust.bundle'));
  const bundleClaims = bundle && Array.isArray(bundle.claims) ? bundle.claims : null;

  if (bundleClaims) {
    // Phase 4b: read pending criteria count from trust.bundle claims.
    // P-c: pass declaredClaimTypes so declared-type acceptance claims are included.
    const pendingCount = bundlePendingCriteriaCount(bundleClaims, declaredClaimTypes);
    if (pendingCount !== null && pendingCount > 0) {
      const base = path.basename(artifactDir);
      warnings.push(`${base} Final Acceptance: ${pendingCount} acceptance criterion/criteria still pending; complete CI/merge/docs before final delivery.`);
    }
  } else {
    // Fallback: no bundle — read from acceptance.json (existing behavior, no regression).
    const acceptance = readJsonFile(path.join(artifactDir, 'acceptance.json'));
    if (acceptance && Array.isArray(acceptance.criteria)) {
      const pendingCriteria = acceptance.criteria.filter(c => {
        const s = normalizedStatus(c && c.status);
        return s === 'pending' || s === 'not_started' || s === '' || s === 'unknown';
      });
      if (pendingCriteria.length > 0) {
        const base = path.basename(artifactDir);
        warnings.push(`${base} Final Acceptance: ${pendingCriteria.length} acceptance criterion/criteria still pending; complete CI/merge/docs before final delivery.`);
      }
    }
  }

  return warnings;
}

// ─── Gate severity classification regexes (module scope — used by analyze() and run()) ─
//
// HARD_BLOCK: always blocks, even for pre-execution and terminal tasks.
//   Fires on genuine false-completion signals (a claimed pass the capture log or
//   evidence.json contradicts), integrity failures, gate misconfiguration, and — iteration-2 fix
//   item 4 (HIGH) — the unified ambiguous-with-a-pass-claim signal (`NOT_VERIFIED (ambiguous)`,
//   built from the shared AMBIGUOUS_REMEDIATION const). ALL THREE emission sites — the capture-log
//   shortcut in captureCrossReference, the live re-run in runBackstop, and the THIRD bucket in
//   capturedFailReconciliation — emit this same marker, and it is DELIBERATELY distinct text from
//   `caught false-completion` (never the false-completion accusation for a bare grep/diff exit 1,
//   which may genuinely be the author's intended pass). All three DELIBERATELY match HARD_BLOCK,
//   so an ambiguous claimed-pass BLOCKS a terminal/pre-execution stop in every config
//   (evidence.json-only, never-captured, and captured+bundle) — a claim asserting pass for a
//   command whose exit code cannot actually confirm that is not a verified completion either. Do
//   NOT revert any of the three sites back to plain `NOT_VERIFIED —` text: that would desync them
//   from HARD_BLOCK and reopen the terminal-stop ambiguous bypass. (The genuinely non-ambiguous
//   `NOT_VERIFIED —` cases — never-captured, backstop-disabled, no-trust-bundle, etc. — are a
//   separate, unrelated class: they stay warn-only for a terminal/pre-execution stop and only
//   block a non-terminal stop via FULL_BLOCK's broader `NOT_VERIFIED —` pattern, unchanged.)
//
// FULL_BLOCK: fires for execution-onward tasks (post-planning, non-terminal).
//   Includes all HARD_BLOCK patterns plus completeness/hygiene and not-done state.
//
// Both are used in analyze() for blocking decisions AND in run() for the AC2
// MAX_BLOCKS hard-block guard (preventing auto-release of hard blocks).
const HARD_BLOCK = /contradicts evidence\.json|caught false-completion|evidence verdict:|evidence check .+ status:|critique status|critique open|required sidecar is missing|command-log integrity check FAILED|gate misconfiguration:|exit-code-laundered|NOT_VERIFIED \(ambiguous\)|canonical Flow (?:run remains active|state is unsafe or malformed)/;
// FULL_BLOCK adds: workflow-state hygiene, surface-unavailable fail-closed, missing log.
const FULL_BLOCK = /status:|Definition Of Done|Goal Fit|sidecar validation:|contradicts evidence\.json|workflow state|evidence verdict|evidence check|NOT_VERIFIED gap|critique status|critique open|next action|caught false-completion|NOT_VERIFIED —|command-log integrity check FAILED|gate misconfiguration:|surface unavailable —|expected capture log is missing|exit-code-laundered|malformed-evidence|NOT_VERIFIED \(ambiguous\)/;

async function analyze(root, now = Date.now()) {
  const flowAgentsDirs = flowAgentsArtifactRootsForRead(root);
  const { actor: actorKey } = resolveActor(process.env);
  const activeTurnScope = validatedActiveTurnScope(root);
  // Scope to the session's current task when current.json names one, so an
  // unrelated active workflow elsewhere in the repo does not gate this stop.
  const scoped = activeTurnScope?.artifactDir || flowAgentsDirs.map(preferredArtifactDir).find(Boolean);

  // #440 D1/D2: a RESOLVED actor with no scoped own artifactDir (no per-actor pointer, or an
  // own pointer naming a nonexistent dir) never falls back to the legacy current.json or a
  // global newest-mtime scan for BLOCKING purposes — those are informational-only for a
  // resolved actor. Accepted gap: this actor's stop stays ungated until its next
  // workflow-sidecar command re-establishes its own per-actor pointer; it is never gated on
  // another actor's unrelated work. #589: a signed continuation active-turn scope (validated via
  // FLOW_AGENTS_CONTINUATION_RUN_ID/TURN_SECRET, independent of actor identity/ownership) is
  // resolved into `activeTurnScope` above and OR'd into `scoped` first, so a resolved actor
  // legitimately handling an authorized continuation-driver turn is never treated as "no own
  // work to scope to" here, even without its own per-actor current pointer — this check only
  // fires when NEITHER mechanism finds a scope.
  if (!scoped && !isUnresolvedActor(actorKey)) {
    const ownStale = flowAgentsDirs.map(staleCurrentSlug).find(Boolean);
    process.stderr.write(ownStale
      ? `[Hook] Goal Fit: actor "${safeOneLine(actorKey, 80)}"'s own current-pointer names slug "${safeOneLine(ownStale, 80)}" but no such session directory exists — ignoring the stale own pointer; other sessions' sidecars are informational only, not blocking (#440).\n`
      : `[Hook] Goal Fit: no per-actor current-pointer for actor "${safeOneLine(actorKey, 80)}" — stop-gate evidence scoping finds no own work to scope to; not blocking (any workflow-sidecar command re-establishes it; other sessions' sidecars are informational only, #440).\n`);
    return { warnings: [], blocking: false, activeFlowRun: false, latestArtifactDir: null };
  }

  // Everything below this point is UNCHANGED for: (a) a resolved actor with a valid `scoped`
  // own artifactDir (the common, post-fix path), (b) an unresolved actor (full legacy +
  // global-scan compat, D3), and (c) an authorized continuation-driver turn (#589, scoped via
  // activeTurnScope regardless of actor ownership).
  // WS8 (AC10a): if current.json points at a nonexistent slug, LOG the staleness and, in
  // the global fallback, require sidecar presence so a stale pointer cannot resurface an
  // abandoned/never-real markdown-only directory as "the active session".
  const staleSlug = scoped ? null : flowAgentsDirs.map(staleCurrentSlug).find(Boolean);
  if (staleSlug) {
    process.stderr.write(`[Hook] Goal Fit: current.json names slug "${safeOneLine(staleSlug, 80)}" but no such session directory exists — ignoring the stale pointer instead of resurfacing an abandoned session via a global mtime scan.\n`);
  }
  const searchDirs = scoped ? [scoped] : flowAgentsDirs;
  let artifacts = searchDirs
    .flatMap(dir => walkMarkdown(dir))
    .map(readArtifact)
    .filter(isWorkflowArtifact)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (staleSlug) {
    artifacts = artifacts.filter(a => a && hasSidecarPresence(path.dirname(a.file)));
  }

  const scopedCanonicalFlow = activeTurnScope && scoped === activeTurnScope.artifactDir
    ? activeTurnScope.canonicalFlow
    : canonicalFlowState(root, scoped);
  const scopedState = scoped ? readJsonFile(path.join(scoped, 'state.json')) : null;
  const scopedProjectedActive = Boolean(scopedState && scopedState.flow_run && normalizedStatus(scopedState.flow_run.status) === 'active');
  if (scopedProjectedActive && scopedCanonicalFlow.error) {
    return {
      warnings: [`workflow state: canonical Flow state is unsafe or malformed for the active scoped session: ${scopedCanonicalFlow.error}. Resolve the canonical run before stopping.`],
      blocking: true,
      activeFlowRun: true,
      latestArtifactDir: scoped,
      gatePrefix: '[stop-gate]',
    };
  }
  if (activeTurnScope && scoped === activeTurnScope.artifactDir && scopedCanonicalFlow.error) {
    return {
      warnings: [`workflow state: canonical Flow state is unsafe or malformed for the signed continuation session: ${scopedCanonicalFlow.error}. Resolve the canonical run before stopping.`],
      blocking: true,
      activeFlowRun: false,
      activeTurnAuthority: false,
      latestArtifactDir: scoped,
      gatePrefix: '[stop-gate]',
    };
  }
  if (artifacts.length === 0) {
    if (scoped) {
      const stateFile = path.join(scoped, 'state.json');
      let mtimeMs = now;
      try { mtimeMs = fs.statSync(stateFile).mtimeMs; } catch { /* missing state is evaluated below */ }
      artifacts = [{ file: stateFile, status: normalizedStatus(scopedState?.status || 'unknown'), type: 'deliver', mtimeMs }];
    } else {
      return { warnings: [], blocking: false, activeFlowRun: false, latestArtifactDir: null };
    }
  }

  const latest = artifacts[0];
  const latestArtifactDir = path.dirname(latest.file);
  const warnings = [];
  const relPath = relative(root, latest.file);
  const status = latest.status || 'unknown';
  const ageMinutes = Math.max(0, Math.round((now - latest.mtimeMs) / 60000));

  if (ACTIVE_STATUSES.has(status)) {
    warnings.push(`${relPath} is still status:${status} (${ageMinutes}m old). Do not final-answer as complete unless the next step is explicit.`);
  }

  // Builder heading completeness checks (hasHeading DOD/Goal Fit Gate) removed in ADR 0010 2c.
  // Verdict is now bundle-driven via bundleEnforcement + sidecarGuidance.
  // Sessions with neither trust.bundle nor state.json are caught by missingBundleOrStateSignal.

  // ADR 0016 P-c: load the active FlowDefinition gate (fail-open: null when absent).
  // Null → existing workflow.* fallback path unchanged. Non-null → expects[]-driven claim selection.
  const activeFlowStep = loadActiveFlowStep(path.dirname(latestArtifactDir), actorKey);

  warnings.push(...sidecarValidation(root, latestArtifactDir));
  warnings.push(...sidecarGuidance(root, latestArtifactDir, activeFlowStep));
  const captureWarnings = captureCrossReference(root, latestArtifactDir, activeFlowStep);
  warnings.push(...captureWarnings);
  // Dedup: bundleEnforcement and captureCrossReference can both fire "caught false-completion"
  // for the same disputed claim. Suppress the bundleEnforcement warning ONLY when
  // captureCrossReference already produced a hard-block warning ("caught false-completion")
  // for the same check. NOT_VERIFIED / backstop-skip capture warnings must NOT suppress
  // the bundle tamper/disputed signal — that mismatch is a re-derive block independent of
  // whether the command was ever captured (anti-gaming guarantee, ADR 0010 Phase 2b).
  const captureHardBlockIds = new Set();
  for (const w of captureWarnings) {
    if (!/caught false-completion/.test(w)) continue; // only hard blocks suppress bundle warning
    const m = /evidence check ([^\s:]+):/.exec(w);
    if (m) captureHardBlockIds.add(m[1]);
  }
  const bundleWarnings = (await bundleEnforcement(latestArtifactDir, activeFlowStep)).filter(w => {
    if (!captureHardBlockIds.size) return true;
    // bundleEnforcement warns: "trust.bundle claim disputed: <subjectId> ..."
    const m = /trust\.bundle claim (?:disputed|tampered): ([^\s(]+)/.exec(w);
    if (!m) return true;
    const subjectId = m[1];
    // subjectId = "slug/checkId" — extract the checkId (last segment)
    const checkId = subjectId.includes('/') ? subjectId.slice(subjectId.indexOf('/') + 1) : subjectId;
    // If captureCrossReference already hard-blocked this check, suppress the bundle warning.
    return !captureHardBlockIds.has(checkId);
  });
  warnings.push(...bundleWarnings);
  warnings.push(...missingBundleOrStateSignal(latestArtifactDir, activeFlowStep));

  // A pre-execution task (not started) OR a terminal task (which is itself a
  // completion *claim*) must not block on mere incompleteness — but a FALSE claim
  // (capture/evidence contradiction) still blocks at any phase. This is the whole
  // point of the capture cross-reference: catch a task that falsely claims done.
  const gateState = readJsonFile(path.join(latestArtifactDir, 'state.json'));
  const taskStatus = gateState ? normalizedStatus(gateState.status) : normalizedStatus(status);
  const preExecution = isPreExecution(latestArtifactDir, status);
  const terminal = TERMINAL_STATUSES.has(taskStatus);

  // Namespace-agnostic captured-FAIL reconciliation (AC1 — closes the allowlist bypass).
  // Fix A: status-independent — runs on EVERY stop. A claim contradicting the capture
  // is a false-completion whether or not the agent says the task is 'done'.
  warnings.push(...capturedFailReconciliation(root, latestArtifactDir, taskStatus));

  // Use module-scope HARD_BLOCK / FULL_BLOCK (defined above analyze()).
  // pre-execution/terminal tasks: only HARD_BLOCK signals cause a block.
  // execution-onward tasks: FULL_BLOCK signals cause a block.
  const canonicalFlow = activeTurnScope && latestArtifactDir === activeTurnScope.artifactDir
    ? activeTurnScope.canonicalFlow
    : canonicalFlowState(root, latestArtifactDir);
  const activeProjectedFlow = gateState && gateState.flow_run && normalizedStatus(gateState.flow_run.status) === 'active';
  const unsafeActiveCanonical = Boolean(activeProjectedFlow && canonicalFlow.error);
  if (unsafeActiveCanonical) {
    warnings.push(`workflow state: canonical Flow state is unsafe or malformed for the active scoped session: ${canonicalFlow.error}. Resolve the canonical run before stopping.`);
  }
  const activeFlowRun = normalizedStatus(canonicalFlow.state?.status) === 'active'
    || (gateState && gateState.flow_run && normalizedStatus(gateState.flow_run.status) === 'active');
  if (activeFlowRun && !warnings.some(w => /canonical Flow run remains active/.test(w))) {
    const activeStep = safeOneLine(canonicalFlow.state?.current_step || gateState?.flow_run?.current_step || 'unknown', 80);
    warnings.push(`workflow state: canonical Flow run remains active at step ${activeStep}; complete or explicitly cancel the run before stopping.`);
  }
  const blockRe = ((preExecution && !activeFlowRun) || terminal) ? HARD_BLOCK : FULL_BLOCK;
  const activeTurnAuthority = activeFlowRun && !terminal && canonicalFlow.state && !unsafeActiveCanonical
    ? validateActiveTurnAuthority({
      sessionDir: latestArtifactDir,
      runId: process.env.FLOW_AGENTS_CONTINUATION_RUN_ID,
      turnSecret: process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET,
      canonicalState: canonicalFlow.state,
    })
    : { valid: false, reason: 'canonical Flow is not safely active' };
  if (activeTurnAuthority.valid) {
    warnings.push('continuation driver active turn is authorized; the ordinary unfinished canonical Flow gate is advisory until this adapter turn returns.');
  }
  const blockingRe = activeTurnAuthority.valid ? FULL_BLOCK : blockRe;
  const blocking = (activeFlowRun && !activeTurnAuthority.valid) || warnings.some(w => {
    // Capture cross-reference warn-mode notes never block (operator opted out).
    if (/\[backstop in warn mode — not blocking\]/.test(w)) return false;
    if (activeTurnAuthority.valid && isOrdinaryActiveGateWarning(w, relPath)) return false;
    return blockingRe.test(w);
  });
  return { warnings, blocking, activeFlowRun, activeTurnAuthority: activeTurnAuthority.valid, preExecution, gatePrefix: gateLabel(activeFlowStep), latestArtifactDir };
}

function isOrdinaryActiveGateWarning(warning, relPath) {
  const normalizedRelPath = relPath.replaceAll('\\', '/');
  const sessionSlug = path.posix.basename(path.posix.dirname(normalizedRelPath));
  const canonicalActive = /^workflow state: canonical Flow run remains active at step .+; complete or explicitly cancel the run before stopping\.$/.test(warning);
  if (HARD_BLOCK.test(warning) && !canonicalActive) return false;
  const finalAcceptancePrefix = `${sessionSlug} Final Acceptance:`;
  const currentFinalAcceptance = warning.startsWith(finalAcceptancePrefix)
    && /^ \d+ acceptance criterion\/criteria still pending; complete CI\/merge\/docs before final delivery\.$/.test(warning.slice(finalAcceptancePrefix.length));
  const surfaceUnavailable = /^surface unavailable — \d+ high\/critical-impact claim\(s\) could not be re-derived at gate; stored claim status is trusted without independent re-derivation \(fail-closed: high-assurance path\)\. Ensure @kontourai\/surface is installed and importable, or escalate for operator review\.$/.test(warning);
  return warning.startsWith(`${relPath} is still status:`)
    || /(?:^|\/)\.kontourai\/flow-agents\/[^/]+ workflow state:/.test(warning)
    || /(?:^|\/)\.kontourai\/flow-agents\/[^/]+ (?:next action|required skills|required operations|next command):/.test(warning)
    || currentFinalAcceptance
    || surfaceUnavailable
    || canonicalActive;
}

function isHardStopWarning(warning, relPath, activeTurnAuthority) {
  if (/\[backstop in warn mode — not blocking\]/.test(warning)) return false;
  if (!activeTurnAuthority) return HARD_BLOCK.test(warning);
  return FULL_BLOCK.test(warning) && !isOrdinaryActiveGateWarning(warning, relPath);
}

/**
 * Resolve the enforcement mode. FLOW_AGENTS_GOAL_FIT_MODE (block|warn|off) wins;
 * the legacy FLOW_AGENTS_GOAL_FIT_STRICT=true maps to block; otherwise the
 * canonical engine default is warn.
 */
function resolveGoalFitMode() {
  const explicit = String(process.env.FLOW_AGENTS_GOAL_FIT_MODE || '').trim().toLowerCase();
  if (explicit === 'block' || explicit === 'warn' || explicit === 'off') return explicit;
  const strict = String(process.env.FLOW_AGENTS_GOAL_FIT_STRICT || '').toLowerCase() === 'true';
  return strict ? 'block' : 'warn';
}

/**
 * Escape hatch: cap how many times block mode may refuse the SAME goal-fit gap
 * in a row, so a genuinely-unsatisfiable goal cannot trap the agent forever.
 * After this many consecutive identical blocks the hook releases (exit 0) with a
 * loud notice. Configurable via FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS (default 3).
 */
function resolveMaxBlocks() {
  const raw = Number.parseInt(process.env.FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
}

function blockStreakFile(root) {
  const artifactRoot = flowAgentsArtifactRoot(root);
  return path.join(artifactRoot, '.goal-fit-block-streak.json');
}

function reasonsHash(warnings) {
  const text = (warnings || []).join('\n');
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return String(h);
}

function clearBlockStreak(root) {
  try { fs.rmSync(blockStreakFile(root), { force: true }); } catch { /* best effort */ }
}

function bumpBlockStreak(root, hash) {
  const file = blockStreakFile(root);
  const prev = readJsonFile(file) || {};
  const count = prev.hash === hash ? (Number(prev.count) || 0) + 1 : 1;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hash, count }));
  } catch { /* best effort */ }
  return count;
}

/**
 * Message-assembly only: per-gap remediation guidance (linter-style "  → " line)
 * appended under a matching warning. Fix-first / accept-second ordering per
 * class; the "accept" path always names a reason requirement and is never the
 * only or primary option. Does not affect which warnings are emitted, HARD_BLOCK/
 * FULL_BLOCK classification, block counting, or exit codes — text only.
 * Returns null when a warning does not match one of the four known classes.
 */
function remediationFor(warning) {
  const w = String(warning || '');

  // (1) claimed pass but the trusted re-run failed — reuse the exact command
  // already named in the warning text; never invent a different one.
  // NOTE: anchor on the quoted command substring + fixed tail, NOT on
  // `trusted backstop (<source>)` paren-matching. trusted.source can itself
  // contain parens (e.g. "model-command (FLOW_AGENTS_GOAL_FIT_RECHECK)"), and a
  // non-nesting `[^)]*` silently fails to match that nested-paren source,
  // dropping the guidance line for the RECHECK backstop path.
  const rerun = /re-run of "([\s\S]+?)" FAILED with exit \d+, contradicting the claimed pass/.exec(w);
  if (rerun) {
    return `  → run: ${rerun[1]} — fix the failures, then re-record the check`;
  }

  // (2) claimed pass never captured (no trusted command resolved, backstop
  // disabled via FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip, or the backstop could not launch).
  // Same nested-paren fix as (1): match on the invariant "could not run" tail
  // rather than paren-counting the `(<source>)` segment.
  if (/claimed pass but NOT_VERIFIED — command ".+?" was never captured/.test(w)
    || /claimed pass but NOT_VERIFIED — trusted backstop .*could not run/.test(w)) {
    return "  → run the command in this session (evidence capture is active), then re-record the check with the exact command string via: npm run workflow:sidecar -- record-evidence <artifact-dir> --verdict <v> --check-json '...'";
  }

  // (3) critique verdict fail / open findings.
  if (/critique status:/.test(w) || /critique open /.test(w)) {
    return '  → resolve the findings and record a passing critique (record-critique), or mark each finding accepted with a reason';
  }

  // (4) evidence verdict fail / missing acceptance evidence.
  if (/evidence verdict:/.test(w) || /evidence check .+ status:/.test(w)
    || /evidence NOT_VERIFIED gap:/.test(w) || /Final Acceptance:/.test(w)) {
    return '  → fix the failing check, or record it as an accepted gap with justification in the session artifact';
  }

  return null;
}

// ─── #292 Wave 2: Stop-hook non-terminal release-with-handoff ────────────────
//
// When a session's Stop event fires and the session's state.json status is NOT
// one of workflow-sidecar.ts's LIVENESS_TERMINAL statuses (delivered/accepted/
// archived — the SAME set advance-state's terminal path already tests against,
// imported here rather than re-declared, per AC8), the liveness claim and (for
// the local-file assignment provider) the durable assignment claim would
// otherwise sit held until TTL, even though the session has genuinely ended.
// This closes that gap: always emit a provider-agnostic liveness release (AC1),
// and for local-file additionally perform the real release inline (AC2), while
// honestly disclosing (never executing) the equivalent GitHub-provider release
// as a pending handoff.json intent (AC3). See the plan artifact
// (.kontourai/flow-agents/kontourai-flow-agents-292/kontourai-flow-agents-292--plan-work.md,
// "Wave 2") for the full design rationale and the render-don't-execute
// constraint this deliberately does not cross.
//
// Fail-open (AC7): the ENTIRE body runs under one try/catch. Any failure —
// missing build/, corrupt assignment record, unresolved actor, missing/
// malformed provider settings — degrades to a single stderr diagnostic and
// returns, never throwing, never affecting the Stop hook's own exit code or
// goal-fit's warnings/blocking output (this function's return value is not
// consumed by that contract at all — it is a pure side effect).

/**
 * require() the compiled workflow-sidecar.js the same hasBuild/fs.existsSync-guarded
 * way loadActiveFlowStep() already requires flow-resolver.js. Returns null (never
 * throws) when build/ is absent or the require fails — the caller treats null as
 * "the LIVENESS_TERMINAL boundary is unknown; do not guess it" and skips the whole
 * release (fail-open, never a re-derived duplicate Set — AC8).
 */
function loadWorkflowSidecarBuilt() {
  const packageRoot = path.resolve(__dirname, '..', '..');
  const builtSidecar = path.join(packageRoot, 'build', 'src', 'cli', 'workflow-sidecar.js');
  if (!fs.existsSync(builtSidecar)) return null; // hasBuild guard
  try {
    const mod = require(builtSidecar);
    if (!(mod.LIVENESS_TERMINAL instanceof Set)) return null;
    return mod;
  } catch {
    return null; // require failed — fail-open
  }
}

/** Same hasBuild-guarded require idiom, for build/src/cli/assignment-provider.js. */
function loadAssignmentProviderBuilt() {
  const packageRoot = path.resolve(__dirname, '..', '..');
  const builtProvider = path.join(packageRoot, 'build', 'src', 'cli', 'assignment-provider.js');
  if (!fs.existsSync(builtProvider)) return null;
  try {
    const mod = require(builtProvider);
    if (typeof mod.performLocalRelease !== 'function') return null;
    return mod;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective assignment-provider kind for this repo ('local-file' | 'github'),
 * or null when it cannot be determined. Prefers reading context/settings/
 * assignment-provider-settings.json directly (project settings first, matching
 * effective-assignment-provider-settings.ts's own lookup precedence) rather than shelling
 * out to or refactoring that CLI-shaped file (see plan Unresolved Question 1) — this task's
 * scope is the Stop hook, not that file. Returns null (never guesses) when no settings file
 * is present/parseable or names no provider kind for a project entry.
 *
 * Deliberately reads ONLY the project settings file (context/settings/
 * assignment-provider-settings.json relative to repo root) — the common case for this repo
 * and the one confirmed present. The effective() merge/repo-matching logic in
 * effective-assignment-provider-settings.ts is intentionally NOT reimplemented here (that
 * would fork a second merge algorithm); a repo whose provider kind can only be resolved via
 * global settings or multi-project merge degrades to "unknown, skip assignment-layer
 * release" rather than guessing.
 */
function resolveAssignmentProviderKind(root) {
  const settingsFile = path.join(root, 'context', 'settings', 'assignment-provider-settings.json');
  const settings = readJsonFile(settingsFile);
  if (!settings) return null;
  const candidates = [];
  if (settings.defaults && settings.defaults.provider) candidates.push(settings.defaults.provider);
  if (Array.isArray(settings.projects)) {
    for (const project of settings.projects) {
      if (project && project.provider) candidates.push(project.provider);
    }
  }
  const kind = candidates.map(p => p && p.kind).find(k => k === 'local-file' || k === 'github');
  return kind || null;
}

/**
 * Refresh handoff.json by merge (read+spread the existing file's JSON, overwrite only the
 * fields this task owns), mirroring advanceState's own handoff-write shape
 * (`{ ...loadJson(...), ...sidecarBase(slug), summary, current_state_ref: "state.json",
 * next_steps, blockers: [], warnings: [] }`) and current-pointer.js's writePerActorCurrent
 * write idiom (`fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n")`). next_steps
 * is appended to (not clobbered) when a provider-release next-step is due.
 */
function refreshHandoffAfterRelease(artifactDir, slug, state, providerReleasePending, providerReleaseNextCommand) {
  const file = path.join(artifactDir, 'handoff.json');
  const existing = readJsonFile(file) || {};
  const status = state ? normalizedStatus(state.status || 'unknown') : 'unknown';
  const phase = state ? normalizedStatus(state.phase || 'unknown') : 'unknown';
  const summary = (state && state.next_action && state.next_action.summary)
    ? String(state.next_action.summary)
    : `session ended at status:${status} phase:${phase}`;
  const existingNextSteps = Array.isArray(existing.next_steps) ? existing.next_steps.slice() : [];
  const nextSteps = existingNextSteps.slice();
  if (providerReleasePending && providerReleaseNextCommand && !nextSteps.includes(providerReleaseNextCommand)) {
    nextSteps.push(providerReleaseNextCommand);
  }
  const payload = {
    ...existing,
    schema_version: existing.schema_version || '1.0',
    task_slug: existing.task_slug || slug,
    summary,
    current_state_ref: 'state.json',
    next_steps: nextSteps,
    ...(providerReleasePending ? { provider_release_pending: true } : {}),
    ...(providerReleaseNextCommand ? { provider_release_next_command: providerReleaseNextCommand } : {}),
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * #292 Wave 2: on a Stop event whose resolved session is at a NON-terminal status, release
 * the session's liveness claim (always, provider-agnostic — AC1) and, for the local-file
 * assignment provider, its durable assignment claim too (AC2), then refresh handoff.json
 * (AC4). A terminal-status session (already released by advance-state) is a deliberate no-op
 * (AC5). For the github provider, never calls render-release or gh — only records an
 * honestly-labeled pending intent in handoff.json (AC3). Actor-scoped: only ever releases
 * the CURRENT actor's own held claim (AC6, enforced inside performLocalRelease).
 *
 * Called once from run(), reusing analyze()'s already-resolved latestArtifactDir — this
 * function does not re-derive "what is the active session" a second time.
 *
 * Fail-open (AC7): the entire body is wrapped in one try/catch. Any failure degrades to a
 * single stderr diagnostic and returns, never throwing, never affecting the Stop hook's exit
 * code or goal-fit's warnings/blocking contract (this function's return value is unused by
 * that contract).
 *
 * @param {string} root - repo root (as resolved by findRepoRoot)
 * @param {string|null} artifactDir - analyze()'s already-resolved latestArtifactDir
 */
function releaseOnNonTerminalStop(root, artifactDir) {
  try {
    if (!artifactDir) return; // no active session resolved — nothing to release.

    const state = readJsonFile(path.join(artifactDir, 'state.json'));
    if (!state) return; // AC5: no state.json — nothing to gate a release decision on.
    const signedScope = validatedActiveTurnScope(root);
    const exactSignedScope = signedScope && signedScope.artifactDir === artifactDir;
    const canonicalFlow = exactSignedScope ? signedScope.canonicalFlow : canonicalFlowState(root, artifactDir);
    const canonicalStatus = normalizedStatus(canonicalFlow.state?.status);
    const projectedCanonicalStatus = normalizedStatus(state.flow_run?.status);
    const canonicalOwned = CANONICAL_FLOW_STATUSES.has(canonicalStatus) && !CANONICAL_FLOW_TERMINAL_STATUSES.has(canonicalStatus);
    const projectedCanonicalOwned = CANONICAL_FLOW_STATUSES.has(projectedCanonicalStatus) && !CANONICAL_FLOW_TERMINAL_STATUSES.has(projectedCanonicalStatus);
    if ((exactSignedScope && canonicalFlow.error) || canonicalOwned || projectedCanonicalOwned) {
      const ownershipLabel = canonicalStatus === 'active' || projectedCanonicalStatus === 'active' ? 'active Flow run' : 'nonterminal Flow run';
      process.stderr.write(`[Hook] Goal Fit: stop-hook release skipped for ${ownershipLabel} "${safeOneLine(state.flow_run?.run_id || state.task_slug || path.basename(artifactDir), 80)}"; continuation remains governed by canonical Flow state.\n`);
      return;
    }

    const sidecar = loadWorkflowSidecarBuilt();
    if (!sidecar) {
      process.stderr.write('[Hook] Goal Fit: stop-hook release skipped — build/src/cli/workflow-sidecar.js not available (LIVENESS_TERMINAL boundary unknown).\n');
      return;
    }

    const status = normalizedStatus(state.status || 'unknown');
    if (sidecar.LIVENESS_TERMINAL.has(status)) return; // AC5: terminal — advance-state already released.

    // Slug: artifact dir's basename, or state.json's own task_slug field — reuse whichever
    // this file already has, never a new slug-derivation rule.
    const slug = (state.task_slug && String(state.task_slug).trim()) || path.basename(artifactDir);

    const { actor } = resolveActor(process.env);
    if (isUnresolvedActor(actor)) {
      process.stderr.write(`[Hook] Goal Fit: stop-hook release skipped for "${safeOneLine(slug, 80)}" — actor identity is unresolved; never releasing under a synthetic identity.\n`);
      return;
    }

    const flowAgentsDir = path.dirname(artifactDir);
    const nowIso = new Date().toISOString();

    // AC1: ALWAYS emit the liveness release, regardless of provider kind — liveness is
    // provider-agnostic and this is the ONE shared writer every other liveness emitter uses.
    try {
      require('./lib/liveness-write.js').appendLivenessEvent(flowAgentsDir, {
        type: 'release',
        subjectId: slug,
        actor,
        at: nowIso,
        source: 'stop-hook',
      });
    } catch (err) {
      process.stderr.write(`[Hook] Goal Fit: stop-hook liveness release failed for "${safeOneLine(slug, 80)}": ${safeOneLine(err && err.message || err, 160)}\n`);
    }

    // Resolve the effective assignment-provider kind — unknown means "do not guess",
    // skip the assignment-layer release entirely (fail-open).
    const providerKind = resolveAssignmentProviderKind(root);
    if (!providerKind) {
      process.stderr.write(`[Hook] Goal Fit: stop-hook release — provider kind unknown for "${safeOneLine(slug, 80)}", skipping assignment-layer release (liveness release already emitted).\n`);
      refreshHandoffAfterRelease(artifactDir, slug, state, false, null);
      return;
    }

    let providerReleasePending = false;
    let providerReleaseNextCommand = null;

    if (providerKind === 'local-file') {
      const provider = loadAssignmentProviderBuilt();
      if (!provider) {
        process.stderr.write('[Hook] Goal Fit: stop-hook local-file release skipped — build/src/cli/assignment-provider.js not available.\n');
      } else {
        try {
          // Mirror assignment-provider.ts's loadActorStruct() exactly: runtime is derived via
          // detectRuntime (not a literal 'unknown'), since serializeActor()'s comparison key
          // includes runtime — a mismatched runtime segment here would make performLocalRelease's
          // AC6 actor-match check wrongly treat this session's own claim as foreign.
          //
          // actorKey: opts.actorKey MUST be the same canonical `resolveActor(env).actor` string
          // already resolved above (`actor`) — the identical bare-or-triple form
          // computeEffectiveState()'s holderActorKey preference (`record.actor_key ||
          // serializeActor(record.actor)`) and performLocalRelease's mirrored ownership check
          // both key on. Without this, an explicit-override actor's release-side comparison
          // would fall back to serializeActor(releasedBy) — a re-derived triple that never
          // equals the stored bare actor_key — and this hook would wrongly treat its own claim
          // as foreign (the #291 seam, relocated to the release path; see performLocalRelease's
          // doc comment in src/cli/assignment-provider.ts).
          const releasedBy = { runtime: detectRuntime(process.env), session_id: actor, host: os.hostname(), human: null };
          const artifactRoot = flowAgentsArtifactRoot(root);
          provider.performLocalRelease(artifactRoot, slug, releasedBy, {
            reason: 'stop-hook non-terminal release',
            tolerateNoActiveClaim: true,
            actorKey: actor,
          });
        } catch (err) {
          process.stderr.write(`[Hook] Goal Fit: stop-hook local-file release failed for "${safeOneLine(slug, 80)}": ${safeOneLine(err && err.message || err, 160)}\n`);
        }
      }
    } else {
      // AC3: github (or any non-local-file kind) — render-don't-execute. Never call
      // render-release, never invoke gh. Disclose the pending intent honestly.
      providerReleasePending = true;
      providerReleaseNextCommand = `npm run workflow -- assignment-provider status --provider github --subject-id "${slug}" ...   # then: assignment-provider render-release --provider github --subject-id "${slug}" ... (emits the gh argv to run)`;
    }

    // AC4: refresh handoff.json — merge, never fully overwrite.
    refreshHandoffAfterRelease(artifactDir, slug, state, providerReleasePending, providerReleaseNextCommand);
  } catch (err) {
    // Fail-open (AC7): any unexpected failure anywhere above (JSON parse error, fs error,
    // etc.) must never crash the Stop hook or affect its exit code / goal-fit's output.
    try {
      process.stderr.write(`[Hook] Goal Fit: stop-hook release logic error (fail-open): ${safeOneLine(err && err.message || err, 160)}\n`);
    } catch { /* best-effort diagnostic only */ }
  }
}

async function run(rawInput) {
  const input = parseJson(rawInput);
  const root = findRepoRoot(input.cwd || process.cwd());
  const mode = resolveGoalFitMode();
  if (mode === 'off') return rawInput;
  const result = await analyze(root);
  // #292 Wave 2: additive side effect only — never changes analyze()'s warnings/blocking
  // contract or this function's return value. Reuses analyze()'s already-resolved
  // latestArtifactDir rather than re-deriving a second "what is the active session" path.
  // Runs regardless of whether goal-fit itself has any warnings this turn (AC1: the
  // liveness release must always be attempted on a non-terminal Stop, independent of
  // whether goal-fit found anything to warn about).
  releaseOnNonTerminalStop(root, result.latestArtifactDir || null);
  if (result.warnings.length === 0) {
    clearBlockStreak(root);
    return rawInput;
  }

  const gatePrefix = result.gatePrefix || '[stop-gate]';
  const message = [
    `${gatePrefix} Goal Fit warning:`,
    ...result.warnings.flatMap(w => {
      const lines = [` - ${w}`];
      const guidance = remediationFor(w);
      if (guidance) lines.push(guidance);
      return lines;
    }),
  ].join('\n');

  if (mode !== 'block' || !result.blocking) {
    clearBlockStreak(root);
    return { stdout: rawInput, stderr: message, exitCode: 0 };
  }

  const maxBlocks = resolveMaxBlocks();
  const count = bumpBlockStreak(root, reasonsHash(result.warnings));
  if (count >= maxBlocks) {
    // AC2: never auto-release a HARD block (caught false-completion, capture contradiction,
    // tamper signal, gate misconfiguration, integrity failure). An agent burning through
    // N identical hard blocks to escape via the streak counter must not work.
    //
    // BAR-RAISER, NOT AIRTIGHT: an agent with shell access can still reset the streak
    // with runtime-constructed paths or by modifying the warning
    // text so the hash changes. The real anchor is external (signed checkpoints + human
    // review). This raises the cost of the burn-through-the-counter escape vector.
    const isHardBlock = (result.activeFlowRun && !result.activeTurnAuthority) || result.warnings.some(w => isHardStopWarning(w, relative(root, result.latestArtifactDir || root), result.activeTurnAuthority));
    if (isHardBlock) {
      // Do NOT clear the streak — keep accumulating so the same hard block stays visible.
      return {
        stdout: rawInput,
        stderr: result.activeFlowRun && !result.activeTurnAuthority
          ? `${message}\n${gatePrefix} max-blocks reached but canonical Flow remains active — not auto-releasing; complete or explicitly cancel the run.`
          : `${message}\n${gatePrefix} max-blocks reached but the block is a caught false-completion / integrity failure — not auto-releasing; requires a real fix or operator override.`,
        exitCode: 2,
      };
    }
    clearBlockStreak(root);
    return {
      stdout: rawInput,
      stderr: `${message}\n${gatePrefix} released — the same gap(s) blocked ${count}x without progress; needs your decision (listed above).`,
      exitCode: 0,
    };
  }
  return {
    stdout: rawInput,
    stderr: `${message}\n${gatePrefix} Stop blocked — ${result.warnings.length} evidence gap(s) (block ${count}; after ${maxBlocks} identical blocks I stop blocking and hand this to you)`,
    exitCode: 2,
  };
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) data += chunk.substring(0, MAX_STDIN - data.length);
  });
  process.stdin.on('end', () => {
    // run() is now async (Surface load). We wrap in an async IIFE so the
    // stdin/exit flow is preserved and errors are surfaced as warnings (fail-open).
    (async () => {
      let output;
      try {
        output = await run(data);
      } catch (err) {
        // Unexpected failure in the async gate path — fail-open, allow the Stop.
        process.stderr.write(`[Hook] Goal Fit async error (fail-open): ${String(err && err.message || err)}\n`);
        process.stdout.write(data);
        process.exit(0);
        return;
      }
      if (output && typeof output === 'object') {
        if (output.stderr) process.stderr.write(output.stderr.endsWith('\n') ? output.stderr : `${output.stderr}\n`);
        process.stdout.write(String(output.stdout ?? data));
        process.exit(Number.isInteger(output.exitCode) ? output.exitCode : 0);
        return;
      }
      process.stdout.write(String(output));
    })();
  });
}

module.exports = { analyze, run, resolveGoalFitMode, uncheckedInSection, findRepoRoot, sidecarGuidance, safeOneLine, captureCrossReference, bundleEnforcement, loadActiveFlowStep, readCommandLog, resolveTrustedCommand, declaredManifestTarget, verifyCommandLogChain, CHAIN_GENESIS_VERIFY, hasLaunderingOperator, releaseOnNonTerminalStop, isHardStopWarning, canonicalFlowState };
