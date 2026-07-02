#!/usr/bin/env node
/**
 * trust-reconcile.js — CI trust anchor (Phase 1).
 *
 * EXTERNAL anti-gaming anchor. Runs in a clean CI environment the agent does not
 * control. Enforces:
 *
 *   Step 1  Re-run canonical verification FRESH. Real exit codes from CI. Authoritative.
 *   Step 2  If a delivered bundle is present, RECONCILE: for every evidence item
 *           asserting a command PASSED (evidence.passing normalized to boolean + claims
 *           asserting pass), look up CI's fresh result for that command.
 *           a. Claimed-pass + laundering operator (|| ..., ; true, ; exit 0, etc.) → DIVERGENCE
 *           b. Claimed-pass + CI FAIL                                               → DIVERGENCE
 *           c. Claimed-pass + CI never ran the command                              → DIVERGENCE
 *           d. workflow.check.command claim with no evidence (never captured)       → DIVERGENCE
 *           e. checkpoint-only bundle (no evidence/claims) → DIVERGENCE (full bundle required)
 *
 * Exit codes:
 *   0 — fresh verify passed AND no divergence (or no bundle present)
 *   1 — fresh verify failed OR any divergence detected OR compile-only fallback
 *
 * Fail-open on bundle absence: if no bundle is provided (and none auto-discovered at
 * delivery/trust.bundle or delivery/trust.checkpoint.json), only the fresh verify is
 * enforced. Fail-closed on divergence: any claimed-pass command CI cannot confirm blocks.
 * Fail-closed on compile-only: if no comprehensive verify is configured, exits 1.
 *
 * Inputs (CLI args take precedence over env):
 *   --bundle <path>      Delivered trust.bundle (JSON) path. May also be a
 *                        trust.checkpoint.json for lightweight checkpoint-level checks.
 *   --commands <cmd,...> Canonical verify commands. Comma-separated.
 *                        May be specified multiple times (each appended).
 *   --repo-root <path>   Repository root. Default: TRUST_RECONCILE_REPO_ROOT or cwd.
 *
 * Environment fallbacks:
 *   TRUST_RECONCILE_BUNDLE               Path to delivered bundle (same as --bundle).
 *   TRUST_RECONCILE_COMMANDS              Comma- or newline-separated canonical commands.
 *   TRUST_RECONCILE_REPO_ROOT             Repository root.
 *   TRUST_RECONCILE_COMMAND_TIMEOUT_MS    Timeout (ms) for each canonical/manifest command
 *                                         run (Step 1 fresh-verify + on-demand manifest
 *                                         reconcile). Default: 600000 (10 min).
 *
 * Auto-discovery (when no --bundle or TRUST_RECONCILE_BUNDLE is set):
 *   Checks delivery/trust.bundle, then delivery/trust.checkpoint.json under repo root.
 *   If neither exists, continues fail-open (fresh verify only).
 *
 * Canonical commands resolution (fail-closed on compile-only):
 *   Priority: CLI --commands > TRUST_RECONCILE_COMMANDS env > package.json
 *   scripts["trust-reconcile-verify"]. If NONE of those is configured, exits 1 with
 *   "no comprehensive trust-reconcile-verify configured" — refuses to attest a
 *   compile-only check.
 *
 * NOTE: This job is intended to be a REQUIRED status check in GitHub branch
 * protection (making it the un-disablable CI anchor). Enabling it as required is
 * a server-side branch-protection step — see .github/workflows/trust-reconcile.yml.
 *
 * Programmatic use:
 *   const { runTrustReconcile } = require('./trust-reconcile.js');
 *   const exitCode = runTrustReconcile({ bundle, commands, repoRoot });
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
// One normative definition shared with scripts/hooks/stop-goal-fit.js — the local
// copy here had drifted (it was missing the trailing `/bin/true` check), which is
// exactly why this is now imported rather than duplicated.
const { hasLaunderingOperator } = require('../lib/command-log-chain.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a command string: collapse whitespace, trim. */
function normalizeCmd(cmd) {
  return String(cmd || '').replace(/\s+/g, ' ').trim();
}

/**
 * Normalize ev.passing to a boolean.
 * Treats true / 1 / "true" / "pass" as passing.
 * Prevents a claim from dodging reconciliation via a non-boolean value.
 */
function isPassingValue(v) {
  return v === true || v === 1 || v === 'true' || v === 'pass';
}

// hasLaunderingOperator is imported from ../lib/command-log-chain.js (above) so this
// CI reconciler and the stop-goal-fit verifier apply the identical exit-code-mask
// heuristic — see that module for the rules.

/**
 * Default manifest/canonical-command execution timeout (ms). Overridable via
 * TRUST_RECONCILE_COMMAND_TIMEOUT_MS. 10 minutes is comfortably above the slowest
 * required-lane check (this repo's own CI lanes allow up to ~10 min); the prior
 * hardcoded 180000ms (3 min) killed legitimately slow evals (e.g.
 * evals/integration/test_workflow_sidecar_writer.sh, ~150s on a fast Mac, >180s on
 * GitHub Actions runners) mid-run, producing a spurious divergence rather than a real
 * failure.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 600000;

/** Resolve the manifest/canonical-command timeout: TRUST_RECONCILE_COMMAND_TIMEOUT_MS env, else default. */
function resolveCommandTimeoutMs() {
  const raw = process.env.TRUST_RECONCILE_COMMAND_TIMEOUT_MS;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_COMMAND_TIMEOUT_MS;
}

/**
 * Run a single shell command under bash, capturing exit code.
 * @returns {{ cmd, exitCode, passed, timedOut, timeoutMs, stdout, stderr }}
 */
function runCommand(cmd, repoRoot) {
  const timeoutMs = resolveCommandTimeoutMs();
  const result = spawnSync('bash', ['-c', cmd], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exitCode = (result.status !== null && result.status !== undefined)
    ? result.status
    : 1;
  // spawnSync sets result.error (ETIMEDOUT) when the timeout kills the process — this is
  // NOT a real command failure and must be distinguishable in the FAIL log line so a
  // future reader chases the timeout config, not a phantom test bug.
  const timedOut = !!(result.error && result.error.code === 'ETIMEDOUT');
  return {
    cmd,
    exitCode,
    passed: exitCode === 0 && !result.error,
    timedOut,
    timeoutMs,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Classify a trust.bundle's claims into: reconcilable command claims (test_output +
 * execution.label), session-local claims (attestation/observation/citation), never-captured
 * or unbacked command claims (not-run divergence), and command-backed claims carrying a
 * waiver (waiver-on-command divergence). Returns
 *   { reconcilable, sessionLocal, noEvidenceCommand, waiverOnCommand }.
 *
 * Source of truth: evidence[].execution.label is the command string recorded at capture time.
 * evidence[].passing (normalized) means the agent claimed this passed. `claim.status` is NOT
 * trusted here — the caller re-derives it CI-side (see derive-claim-status.mjs / finding-3).
 *
 * WS8 iteration-2 hardening:
 *   - finding 1: ANY pass-asserting claim whose evidence is `evidenceType: test_output`
 *     (Surface's default when unset) but which did NOT reconcile — i.e. it has no
 *     manifest-matchable execution.label — is a divergence, NOT session-local. A test_output
 *     claim either reconciles against the manifest or is a divergence; it is never accepted on
 *     self-reported status. (Previously only the literal claimType `workflow.check.command`
 *     was guarded, so a fabricated kind:"test" claim with no command slipped through.)
 *   - finding 4: a command-backed (test_output) claim carrying a waiver is a divergence — a
 *     command-backed check reconciles against CI or fails; it cannot be waived.
 */
function classifyBundleClaims(bundle) {
  const evidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  const claims = Array.isArray(bundle.claims) ? bundle.claims : [];

  const claimById = new Map();
  for (const c of claims) if (c && c.id) claimById.set(c.id, c);

  // Evidence indexing. A missing evidenceType defaults to test_output for backward
  // compatibility with pre-classification bundles (same default classifyEvidence uses).
  const claimHasLabeledTestOutput = new Set(); // test_output evidence WITH an execution.label
  const claimHasTestOutputEvidence = new Set(); // ANY test_output evidence (label or not)
  // WS8 iteration-4 (converged finding): the session-local (non-test_output) evidenceType per
  // claim, so the reconciler can name it on the loud ATTESTED marker below — a fabricated
  // human_attestation/attestation/external claim with no --command is otherwise
  // indistinguishable, in the reconciler's own output, from a genuinely re-runnable check.
  const claimEvidenceType = new Map();
  for (const ev of evidence) {
    if (!ev || !ev.claimId) continue;
    const evType = ev.evidenceType || 'test_output';
    if (evType !== 'test_output') {
      if (!claimEvidenceType.has(ev.claimId)) claimEvidenceType.set(ev.claimId, evType);
      continue;
    }
    claimHasTestOutputEvidence.add(ev.claimId);
    if (ev.execution && ev.execution.label) claimHasLabeledTestOutput.add(ev.claimId);
  }

  // finding 4: a command-backed (test_output-evidence) claim that also carries a waiver.
  const waiverOnCommand = [];
  for (const c of claims) {
    if (!c || !c.id) continue;
    const waiver = (c.metadata && typeof c.metadata === 'object') ? c.metadata.waiver : undefined;
    if (waiver && typeof waiver === 'object' && claimHasTestOutputEvidence.has(c.id)) {
      waiverOnCommand.push({ claimId: c.id, claimType: String(c.claimType || ''), subject: c.subjectId || c.fieldOrBehavior || c.id });
    }
  }

  // (A) Reconcilable claimed-passes: evidence items that are test_output (CI-reconcilable),
  // carry an execution.label, and assert pass. Session-local evidenceTypes
  // (crawl_observation, human_attestation, attestation, policy_rule, source_excerpt,
  // document_citation, calculation_trace) are NOT reconciled per-command — they are handled
  // by the session-local/waiver path below.
  const reconcilable = [];
  const reconcilableClaimIds = new Set();
  const seen = new Set();
  for (const ev of evidence) {
    if (!ev || !ev.execution || !ev.execution.label) continue;
    if (!isPassingValue(ev.passing)) continue;
    const evType = ev.evidenceType || 'test_output';
    if (evType !== 'test_output') continue; // session-local — not CI-reconcilable
    const cmd = normalizeCmd(ev.execution.label);
    if (!cmd) continue;
    reconcilableClaimIds.add(ev.claimId);
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    const claim = claimById.get(ev.claimId);
    reconcilable.push({ cmd, claimId: ev.claimId, evId: ev.id, claimType: claim ? String(claim.claimType || '') : '' });
  }

  // (B) Session-local claims, never-captured command claims, and unreconciled test_output.
  const sessionLocal = [];
  const noEvidenceCommand = [];
  const seenClaims = new Set();
  for (const c of claims) {
    if (!c || !c.id || typeof c.claimType !== 'string') continue;
    if (reconcilableClaimIds.has(c.id)) continue; // handled by (A)
    if (seenClaims.has(c.id)) continue;
    const status = String(c.status || '');
    const assertsPass = isPassingValue(c.value) || status === 'verified' || status === 'assumed';
    const isFailing = status === 'disputed' || status === 'rejected';
    if (!assertsPass && !isFailing) continue; // pending/unknown non-asserting — ignore (as before)
    seenClaims.add(c.id);

    // finding 1: a pass-asserting claim backed by test_output evidence that did NOT reconcile
    // (it has test_output evidence but no manifest-matchable execution.label — otherwise it
    // would be in bucket A) is a not-run divergence. A test_output claim reconciles against the
    // manifest or it is a divergence — it is NEVER accepted as session-local on self-report.
    if (assertsPass && claimHasTestOutputEvidence.has(c.id)) {
      const rawCmd = normalizeCmd(c.fieldOrBehavior || c.value || '');
      noEvidenceCommand.push({ cmd: rawCmd || `[claim:${c.id}]`, claimId: c.id, claimType: c.claimType, reason: 'test_output-unreconciled' });
      continue;
    }

    // A workflow.check.command claim with no captured (labeled) evidence is a never-captured
    // claimed pass — not-run divergence (anti-gaming teeth preserved).
    if (assertsPass && c.claimType === 'workflow.check.command' && !claimHasLabeledTestOutput.has(c.id)) {
      const rawCmd = normalizeCmd(c.fieldOrBehavior || c.value || '');
      noEvidenceCommand.push({ cmd: rawCmd || `[claim:${c.id}:${c.claimType}]`, claimId: c.id, claimType: c.claimType, reason: 'no-evidence-command' });
      continue;
    }

    const waiver = (c.metadata && typeof c.metadata === 'object') ? c.metadata.waiver : undefined;
    sessionLocal.push({
      claimId: c.id,
      claimType: c.claimType,
      assertedStatus: status,
      value: c.value,
      waiver: (waiver && typeof waiver === 'object') ? waiver : null,
      subject: c.subjectId || c.fieldOrBehavior || c.id,
      evidenceType: claimEvidenceType.get(c.id) || 'unknown',
    });
  }

  return { reconcilable, sessionLocal, noEvidenceCommand, waiverOnCommand };
}

/**
 * WS8 (finding 3): re-derive every claim's status CI-side from the bundle's OWN
 * evidence/events/policies, using @kontourai/surface's canonical deriveClaimStatus (the same
 * function the producer used). The reconciler MUST NOT trust a bundle's self-reported
 * `claim.status`; it compares the asserted status to this re-derived status and treats a
 * mismatch as a `status-misassertion` divergence.
 *
 * Runs the ESM helper scripts/ci/derive-claim-status.mjs via spawnSync (Surface is ESM-only;
 * this reconciler is CJS with a synchronous entrypoint). Surface is resolved from the helper's
 * own location (the reconciler's node_modules), so it works even when reconciling an adopter
 * repo that does not itself depend on Surface.
 *
 * @returns {Map<string,string|null>|null} claimId → derived status; null if re-derivation is
 *   unavailable (Surface could not load / helper failed to run). A per-claim null value means
 *   that specific claim could not be derived.
 */
function deriveClaimStatuses(bundlePath, repoRoot) {
  const helper = path.join(__dirname, 'derive-claim-status.mjs');
  if (!fs.existsSync(helper)) return null;
  const res = spawnSync('node', [helper, bundlePath], { cwd: repoRoot, encoding: 'utf8', timeout: 60000 });
  if (res.status !== 0 || !res.stdout) {
    if (res.stderr) process.stderr.write(`[trust-reconcile] status re-derivation unavailable: ${res.stderr.trim()}
`);
    return null;
  }
  try {
    const obj = JSON.parse(res.stdout);
    const m = new Map();
    for (const [k, v] of Object.entries(obj)) m.set(k, v);
    return m;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Argument + config parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { bundle: null, commands: [], repoRoot: null, manifest: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--bundle' && next) {
      args.bundle = next; i++;
    } else if (arg === '--commands' && next) {
      args.commands.push(...next.split(',').map(c => c.trim()).filter(Boolean));
      i++;
    } else if (arg === '--repo-root' && next) {
      args.repoRoot = next; i++;
    } else if (arg === '--manifest' && next) {
      args.manifest = next; i++;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// WS8 (ADR 0020): reconcile manifest resolution + slugification.
// The manifest is a list of named {id, command} entries the reconciler treats as
// individually CI-reconcilable. It is resolved (priority order) from:
//   1. CLI --manifest <json>
//   2. env TRUST_RECONCILE_MANIFEST <json>
//   3. package.json "trust-reconcile-manifest" (inline array, OR a string command
//      that emits the JSON — this repo points it at run-baseline.sh --manifest-json)
//   4. evals/ci/run-baseline.sh --manifest-json (this repo's live LANE_* registry —
//      every entry runs in a required ci.yml lane by construction)
//   5. legacy fallback: the resolved fresh-verify commands as a manifest of size N
//      (so the historical single-command behavior is a strict subset — backward compat).
// ---------------------------------------------------------------------------

/** Slugify a label the same way evals/ci/run-baseline.sh's slugify() does. */
function slugifyLabel(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Normalize a raw manifest array (of strings or {id, command}) to {id, command}[]. */
function normalizeManifestEntries(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const cmd = normalizeCmd(item);
      if (cmd) out.push({ id: slugifyLabel(cmd), command: cmd });
    } else if (item && typeof item === 'object' && typeof item.command === 'string') {
      const cmd = normalizeCmd(item.command);
      if (cmd) out.push({ id: item.id ? String(item.id) : slugifyLabel(cmd), command: cmd });
    }
  }
  return out.length ? out : null;
}

function parseManifestJson(text, label) {
  try {
    return normalizeManifestEntries(JSON.parse(text));
  } catch {
    process.stderr.write(`[trust-reconcile] ignoring ${label}: not a valid JSON array of {id, command} entries\n`);
    return null;
  }
}

function runBaselineManifest(repoRoot) {
  const script = path.join(repoRoot, 'evals', 'ci', 'run-baseline.sh');
  if (!fs.existsSync(script)) return null;
  const res = spawnSync('bash', [script, '--manifest-json'], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  if (res.status !== 0 || !res.stdout) return null;
  return parseManifestJson(res.stdout, 'evals/ci/run-baseline.sh --manifest-json');
}

/**
 * Resolve the reconcile manifest. Returns { entries: {id, command}[], source }.
 * canonicalCommands is used only for the legacy size-N fallback (tier 5).
 */
function resolveManifest(args, repoRoot, canonicalCommands) {
  if (args.manifest) {
    const m = parseManifestJson(args.manifest, '--manifest');
    if (m) return { entries: m, source: 'cli:--manifest' };
  }
  if (process.env.TRUST_RECONCILE_MANIFEST) {
    const m = parseManifestJson(process.env.TRUST_RECONCILE_MANIFEST, 'TRUST_RECONCILE_MANIFEST');
    if (m) return { entries: m, source: 'env:TRUST_RECONCILE_MANIFEST' };
  }
  try {
    const pkgPath = path.join(repoRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const raw = (pkg && pkg['trust-reconcile-manifest'])
        || (pkg && pkg.scripts && pkg.scripts['trust-reconcile-manifest']);
      if (Array.isArray(raw)) {
        const m = normalizeManifestEntries(raw);
        if (m) return { entries: m, source: 'package.json:trust-reconcile-manifest (inline array)' };
      } else if (typeof raw === 'string' && raw.trim()) {
        const res = spawnSync('bash', ['-c', raw], { cwd: repoRoot, encoding: 'utf8', timeout: 60000 });
        if (res.status === 0 && res.stdout) {
          const m = parseManifestJson(res.stdout, 'package.json trust-reconcile-manifest emit');
          if (m) return { entries: m, source: `package.json:trust-reconcile-manifest (${raw})` };
        }
      }
    }
  } catch { /* ignore */ }
  const rb = runBaselineManifest(repoRoot);
  if (rb) return { entries: rb, source: 'evals/ci/run-baseline.sh' };
  const legacy = (canonicalCommands || [])
    .map((c) => ({ id: slugifyLabel(normalizeCmd(c)), command: normalizeCmd(c) }))
    .filter((e) => e.command);
  return { entries: legacy, source: 'legacy:fresh-verify-commands' };
}

/**
 * Resolve the list of canonical verify commands.
 * Priority: CLI --commands > TRUST_RECONCILE_COMMANDS env > package.json scripts key.
 *
 * FAIL-CLOSED: if none of those is configured (only the bare "npm run build" default
 * would apply), returns null — main() must exit 1 with a diagnostic message.
 * A compile-only check is NOT sufficient for attestation.
 */
function resolveCanonicalCommands(args, repoRoot) {
  if (args.commands.length > 0) return args.commands;

  const envCmds = process.env.TRUST_RECONCILE_COMMANDS;
  if (envCmds) {
    const parsed = envCmds.split(/[,\n]/).map(c => c.trim()).filter(Boolean);
    if (parsed.length > 0) return parsed;
  }

  // Check package.json for a "trust-reconcile-verify" scripts key
  try {
    const pkgPath = path.join(repoRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const customKey = pkg && pkg.scripts && pkg.scripts['trust-reconcile-verify'];
      if (customKey && typeof customKey === 'string') {
        return ['npm run trust-reconcile-verify'];
      }
    }
  } catch { /* ignore */ }

  // FAIL CLOSED: no comprehensive verify configured.
  // Returning null signals to main() to exit 1 — refuse compile-only attestation.
  return null;
}

/**
 * Auto-discover the delivery bundle when no explicit path is provided.
 * Checks delivery/trust.bundle, then delivery/trust.checkpoint.json under repo root.
 * Returns null if neither is present (fail-open on bundle absence).
 */
function discoverBundle(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'delivery', 'trust.bundle'),
    path.join(repoRoot, 'delivery', 'trust.checkpoint.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core reconcile function (exported for programmatic use)
// ---------------------------------------------------------------------------

/**
 * Run the full trust reconcile logic and return an exit code.
 *
 * This is the same logic as the CLI entrypoint, extracted so it can be called
 * programmatically (e.g. from the `flow-agents verify` CLI subcommand).
 * All output is written directly to process.stdout/stderr.
 *
 * @param {object}        opts
 * @param {string|null}   [opts.bundle]    - Explicit bundle path. null = env fallback + auto-discovery.
 * @param {string[]}      [opts.commands]  - Canonical verify commands. [] = env + package.json fallback.
 * @param {string|null}   [opts.repoRoot]  - Repo root path. null = TRUST_RECONCILE_REPO_ROOT env or cwd.
 * @returns {number} Exit code: 0 = pass, 1 = fail/divergence.
 */
function runTrustReconcile({ bundle = null, commands = [], repoRoot = null, manifest = null } = {}) {
  const resolvedRepoRoot = path.resolve(
    repoRoot || process.env.TRUST_RECONCILE_REPO_ROOT || process.cwd()
  );

  // Resolve bundle path: explicit arg > env > auto-discovery > null (fail-open)
  const bundlePath = bundle
    || process.env.TRUST_RECONCILE_BUNDLE
    || discoverBundle(resolvedRepoRoot)
    || null;

  const canonicalCommands = resolveCanonicalCommands({ commands: commands || [] }, resolvedRepoRoot);

  // FAIL-CLOSED: no comprehensive verify configured — refuse compile-only attestation.
  if (canonicalCommands === null) {
    process.stderr.write(
      '[trust-reconcile] FAILED — no comprehensive trust-reconcile-verify configured.\n' +
      '[trust-reconcile] Refusing to attest a compile-only check.\n' +
      '[trust-reconcile] Declare package.json scripts["trust-reconcile-verify"] or set TRUST_RECONCILE_COMMANDS.\n' +
      '[trust-reconcile] Example: add "trust-reconcile-verify": "npm run build && npm run eval:static && npm run eval:integration"\n'
    );
    return 1;
  }

  // WS8 (ADR 0020): resolve the reconcile manifest (named {id, command} entries used
  // for per-command classification-aware reconcile). The canonical (fresh-verify)
  // commands above remain the standalone CI-truth run; the manifest is the set of
  // required-lane commands a test_output claim is permitted to reconcile against.
  const manifestResolution = resolveManifest({ manifest }, resolvedRepoRoot, canonicalCommands);
  const manifestEntries = manifestResolution.entries;
  const manifestByCmd = new Map();
  for (const e of manifestEntries) manifestByCmd.set(normalizeCmd(e.command), e);

  process.stdout.write('[trust-reconcile] starting CI trust anchor reconcile\n');
  process.stdout.write(`[trust-reconcile] repo-root: ${resolvedRepoRoot}\n`);
  process.stdout.write(`[trust-reconcile] canonical commands: ${canonicalCommands.join(' | ')}\n`);
  process.stdout.write(`[trust-reconcile] manifest: ${manifestEntries.length} entr${manifestEntries.length === 1 ? 'y' : 'ies'} (source: ${manifestResolution.source})\n`);
  for (const e of manifestEntries) {
    process.stdout.write(`[trust-reconcile]   manifest[${e.id}] = ${e.command}\n`);
  }
  if (bundlePath) {
    process.stdout.write(`[trust-reconcile] bundle: ${bundlePath}\n`);
  } else {
    process.stdout.write('[trust-reconcile] no bundle present — fresh verify only (fail-open on bundle absence)\n');
  }

  // -------------------------------------------------------------------------
  // Step 1: re-run canonical verification FRESH (authoritative CI truth)
  // -------------------------------------------------------------------------
  process.stdout.write('\n[trust-reconcile] Step 1: re-running canonical verification fresh...\n');

  // The canonical verify is the anchor's own truth source — it must not be
  // exit-code-laundered (e.g. `npm run build || true`). If it is, the fresh run
  // would report PASS regardless of the real result. Fail closed.
  // (Residual: a wrapper script that exits 0 without `||` still evades — covered
  // by the anti-gaming suite running in a required lane + CODEOWNERS on the verify
  // config; noted honestly.)
  for (const cmd of canonicalCommands) {
    if (hasLaunderingOperator(cmd)) {
      process.stderr.write(`[trust-reconcile] FAILED — canonical verify command is laundered ('${cmd}') — refusing to attest a result whose exit code is masked.\n`);
      return 1;
    }
  }

  /** @type {Map<string, {exitCode: number, passed: boolean}>} */
  const ciResults = new Map();

  for (const cmd of canonicalCommands) {
    process.stdout.write(`[trust-reconcile]   running: ${cmd}\n`);
    const result = runCommand(cmd, resolvedRepoRoot);
    const key = normalizeCmd(cmd);
    ciResults.set(key, { exitCode: result.exitCode, passed: result.passed });

    if (result.passed) {
      process.stdout.write(`[trust-reconcile]   PASS: ${cmd}\n`);
    } else if (result.timedOut) {
      process.stderr.write(`[trust-reconcile]   FAIL: ${cmd} (TIMED OUT after ${result.timeoutMs}ms — this is a timeout kill, not a real command failure; if this command is a legitimately slow check, raise TRUST_RECONCILE_COMMAND_TIMEOUT_MS)\n`);
    } else {
      process.stderr.write(`[trust-reconcile]   FAIL: ${cmd} (exit ${result.exitCode})\n`);
      if (result.stderr) {
        const lines = result.stderr.trim().split('\n');
        const tail = lines.slice(-5).join('\n');
        process.stderr.write(`[trust-reconcile]   --- stderr tail ---\n${tail}\n[trust-reconcile]   ---\n`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Collect issues (Step 1 failures + Step 2 divergences)
  // -------------------------------------------------------------------------
  /** @type {Array<{type: string, cmd?: string, exitCode?: number, message: string}>} */
  const issues = [];

  // Step 1 failures
  for (const [cmd, result] of ciResults) {
    if (!result.passed) {
      issues.push({
        type: 'fresh-fail',
        cmd,
        exitCode: result.exitCode,
        message: `verification failed in CI: '${cmd}' exited ${result.exitCode}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: reconcile against delivered bundle (if present)
  // -------------------------------------------------------------------------
  if (bundlePath) {
    process.stdout.write('\n[trust-reconcile] Step 2: reconciling claimed-pass commands against CI fresh results...\n');

    let bundle;
    try {
      bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    } catch (err) {
      process.stderr.write(`[trust-reconcile] failed to read bundle at ${bundlePath}: ${err.message}\n`);
      return 1;
    }

    const hasEvidence = Array.isArray(bundle.evidence) && bundle.evidence.length > 0;
    const hasClaims = Array.isArray(bundle.claims) && bundle.claims.length > 0;

    if (!hasEvidence && !hasClaims) {
      // Checkpoint-only bundle: no evidence/claims → DIVERGENCE.
      // Cannot perform per-command reconcile without evidence. A full trust.bundle is
      // required. (Auto-discovery always prefers delivery/trust.bundle over
      // delivery/trust.checkpoint.json — this fires only when a checkpoint was
      // explicitly provided or no full bundle exists alongside it.)
      process.stderr.write('[trust-reconcile] checkpoint-only bundle detected: no evidence[] or claims[]\n');
      issues.push({
        type: 'checkpoint-bypass',
        message: 'trust divergence: checkpoint-only bundle cannot be reconciled per-command; full trust.bundle required',
      });

      // Still check checkpoint statusByClaimId for explicit failures (belt-and-suspenders)
      const statusByClaimId = bundle.checkpoint && bundle.checkpoint.statusByClaimId;
      if (statusByClaimId && typeof statusByClaimId === 'object') {
        for (const [claimId, status] of Object.entries(statusByClaimId)) {
          if (status === 'failed' || status === 'rejected' || status === 'disputed') {
            issues.push({
              type: 'checkpoint-fail',
              message: `trust divergence: checkpoint shows claim '${claimId}' with status '${status}'`,
            });
          }
        }
      }
    } else {
      // WS8 (ADR 0020): classify the bundle's claims into reconcilable (test_output,
      // manifest-matched), session-local (waiver/Surface-status), and never-captured
      // command claims — instead of forcing every claim to match one composite command.
      const { reconcilable, sessionLocal, noEvidenceCommand, waiverOnCommand } = classifyBundleClaims(bundle);
      process.stdout.write(`[trust-reconcile] classified bundle: ${reconcilable.length} reconcilable command claim(s), ${sessionLocal.length} session-local claim(s), ${noEvidenceCommand.length} unbacked/unreconciled command claim(s), ${waiverOnCommand.length} waiver-on-command claim(s)\n`);

      // finding 3: re-derive every claim's status CI-side (never trust self-reported
      // claim.status). Consumed by the session-local loop below to catch status-misassertion.
      const derivedStatus = deriveClaimStatuses(bundlePath, resolvedRepoRoot);
      if (derivedStatus) {
        process.stdout.write(`[trust-reconcile] re-derived ${derivedStatus.size} claim status(es) CI-side from the bundle's own evidence/events/policies (self-reported claim.status is NOT trusted)\n`);
      } else {
        process.stderr.write(`[trust-reconcile] WARNING: CI-side status re-derivation is unavailable — every session-local pass-asserting claim will fail closed (cannot verify self-reported status)\n`);
      }

      // finding 4 (server-side): a command-backed (test_output-evidence) claim carrying a
      // waiver is a divergence — a command-backed check reconciles against CI or fails; it
      // cannot be waived away.
      for (const { claimId, claimType, subject } of waiverOnCommand) {
        issues.push({
          type: 'waiver-on-command-check',
          message: `trust divergence: claim '${claimId}' (${subject}, claimType: ${claimType}) carries a waiver but is backed by test_output evidence — a command-backed check reconciles against CI or fails and cannot be waived`,
        });
      }

      // not-run divergences: never-captured command claims (no evidence) AND test_output
      // claims that did not reconcile (no manifest-matchable execution.label).
      for (const { cmd, claimId, claimType, reason } of noEvidenceCommand) {
        const message = reason === 'test_output-unreconciled'
          ? `trust divergence: claim '${claimId}' (claimType: ${claimType}) asserts pass with test_output evidence but has no manifest-matched execution.label — a test_output claim must reconcile against the manifest or it is a divergence (never accepted as session-local)`
          : `trust divergence: claim '${claimId}' (claimType: ${claimType}) asserts pass but has no supporting evidence item — command never captured`;
        issues.push({ type: 'not-run', cmd, message });
      }

      // Reconcilable test_output claims: laundering → manifest match → CI fresh result.
      for (const { cmd } of reconcilable) {
        const normalCmd = normalizeCmd(cmd);

        // (a) Laundering operator check — must come first (most specific signal).
        if (hasLaunderingOperator(cmd)) {
          issues.push({
            type: 'laundering',
            cmd,
            message: `trust divergence: agent claimed '${cmd}' passed; command contains exit-code-laundering operator (|| ... / ; true / ; exit 0 / etc.)`,
          });
          continue;
        }

        // A test_output claim MUST name a manifest (required-lane) command. An agent
        // cannot self-label an arbitrary command test_output to dodge the manifest.
        const entry = manifestByCmd.get(normalCmd);
        if (!entry) {
          issues.push({
            type: 'not-run',
            cmd,
            message: `trust divergence: agent claimed '${cmd}' passed; command is not in the reconcile manifest — a test_output claim must name a manifest/required-lane command (CI cannot self-declare an arbitrary command)`,
          });
          continue;
        }

        // Prefer the fresh-verify Step 1 result; otherwise re-run this (manifest, and
        // therefore required-lane) command fresh now. Only manifest commands are ever
        // run on demand, so the set is bounded by the registry.
        let ciResult = ciResults.get(normalCmd);
        if (!ciResult) {
          process.stdout.write(`[trust-reconcile]   manifest reconcile: running '${entry.command}' (id: ${entry.id})\n`);
          const r = runCommand(entry.command, resolvedRepoRoot);
          ciResult = { exitCode: r.exitCode, passed: r.passed };
          ciResults.set(normalCmd, ciResult);
          if (r.passed) {
            process.stdout.write(`[trust-reconcile]   PASS: ${entry.command}\n`);
          } else if (r.timedOut) {
            process.stderr.write(`[trust-reconcile]   FAIL: ${entry.command} (TIMED OUT after ${r.timeoutMs}ms — this is a timeout kill, not a real command failure; if this manifest command is a legitimately slow check, raise TRUST_RECONCILE_COMMAND_TIMEOUT_MS)\n`);
          } else {
            process.stderr.write(`[trust-reconcile]   FAIL: ${entry.command} (exit ${r.exitCode})\n`);
            if (r.stderr) {
              const tail = r.stderr.trim().split('\n').slice(-5).join('\n');
              process.stderr.write(`[trust-reconcile]   --- stderr tail ---\n${tail}\n[trust-reconcile]   ---\n`);
            }
          }
        }

        if (!ciResult.passed) {
          issues.push({
            type: 'divergence',
            cmd,
            exitCode: ciResult.exitCode,
            message: `trust divergence: agent claimed '${cmd}' passed; CI fresh run = FAIL (exit ${ciResult.exitCode})`,
          });
          continue;
        }

        process.stdout.write(`[trust-reconcile]   RECONCILED: '${cmd}' (manifest id: ${entry.id}) — claimed pass, CI fresh run = PASS\n`);
      }

      // Session-local claims: not CI-reconcilable, but NOT a pass bypass. Each must either
      // (a) carry a loud, justified waiver, or (b) resolve a real CI-RE-DERIVED `verified`
      // status. WS8 iteration-2 hardening:
      //   - finding 3: the status used here is RE-DERIVED CI-side, never the self-reported
      //     claim.status. A mismatch is a `status-misassertion` divergence. If re-derivation
      //     is unavailable we fail closed (`status-underivable`) — we never fall back to
      //     trusting the bundle's own status.
      //   - finding 2: `assumed` alone is NO LONGER a silent pass. `assumed` is acceptable
      //     ONLY with a waiver (printed as a loud WAIVED line). An unwaived `assumed` claim is
      //     an `unwaived-assumed` divergence (restores pre-WS8 semantics where `assumed` alone
      //     never satisfied assertsPass).
      //
      // WS8 iteration-4 (converged iteration-3 finding, both gates): a session-local claim
      // that re-derives `verified` with NO waiver is, by definition, backed only by
      // human_attestation/attestation/external/etc. evidence with no --command — i.e.
      // `deriveClaimStatus` only proves the bundle is internally self-consistent, never that
      // the underlying attestation is true. A fully fabricated bundle (fake claim + fake
      // evidence + fake event, all hand-authored to agree) is INDISTINGUISHABLE from a real
      // one at this layer. This was previously printed as a quiet `SESSION-LOCAL OK` line
      // indistinguishable from a genuinely reconciled check. It is now always printed as a
      // loud, distinct `ATTESTED (not independently verifiable at L0)` marker — see ADR 0020
      // Residuals. This does NOT change the exit code (attestations are not blocked at L0;
      // blocking every honest human-attestation use is not the fix) — it is a visibility-only
      // change so a reviewer/downstream tool can grep for and count exactly how many claims in
      // a passing bundle rest on bundle-internal consistency alone rather than independent
      // (CI fresh-run or cryptographically-signed) verification.
      let attestedCount = 0;
      for (const { claimId, claimType, assertedStatus, waiver, subject, evidenceType } of sessionLocal) {
        // finding 3: re-derive; never trust the asserted status.
        let status;
        if (!derivedStatus) {
          issues.push({
            type: 'status-underivable',
            message: `trust divergence: session-local claim '${claimId}' (claimType: ${claimType}) asserts status '${assertedStatus || 'unknown'}' but CI-side re-derivation is unavailable — refusing to trust a self-reported status (fail-closed)`,
          });
          continue;
        }
        const derived = derivedStatus.get(claimId);
        if (derived === undefined || derived === null) {
          issues.push({
            type: 'status-underivable',
            message: `trust divergence: session-local claim '${claimId}' (claimType: ${claimType}) could not be re-derived CI-side from the bundle's own evidence/events/policies — refusing to trust its self-reported status '${assertedStatus || 'unknown'}' (fail-closed)`,
          });
          continue;
        }
        if (derived !== assertedStatus) {
          issues.push({
            type: 'status-misassertion',
            message: `trust divergence: session-local claim '${claimId}' (claimType: ${claimType}) asserts status '${assertedStatus || 'unknown'}' but CI re-derivation from the bundle's own evidence/events/policies yields '${derived}' — the reconciler does not trust self-reported claim.status`,
          });
          continue;
        }
        status = derived;

        if (status === 'disputed' || status === 'rejected') {
          issues.push({
            type: 'session-local-failed',
            message: `trust divergence: session-local claim '${claimId}' (claimType: ${claimType}) has re-derived status '${status}' — a failing/rejected claim blocks (session-local classification is not a pass bypass)`,
          });
          continue;
        }
        // finding 2: a waiver is the ONLY way an `assumed` (or otherwise non-`verified`)
        // session-local claim passes, and it is printed loudly. `verified` still passes on its
        // own re-derived status.
        if (waiver && waiver.reason && waiver.approved_by) {
          process.stdout.write(`[trust-reconcile] WAIVED: ${subject} (${claimType}) status=${status} — ${waiver.reason} (approved by ${waiver.approved_by})\n`);
          continue;
        }
        if (status === 'verified') {
          attestedCount++;
          process.stdout.write(`[trust-reconcile] ATTESTED (not independently verifiable at L0): '${claimId}' (${claimType}) evidenceType=${evidenceType} — accepted on bundle-internal consistency only; see ADR 0020 Residuals\n`);
          continue;
        }
        if (status === 'assumed') {
          issues.push({
            type: 'unwaived-assumed',
            message: `trust divergence: session-local claim '${claimId}' (claimType: ${claimType}) has re-derived status 'assumed' but carries no waiver — 'assumed' alone is not a pass; it requires a documented waiver (--accepted-gap-reason/--waived-by) to be accepted`,
          });
          continue;
        }
        issues.push({
          type: 'unwaived-session-local',
          message: `trust divergence: session-local claim '${claimId}' (claimType: ${claimType}) asserts pass with re-derived status '${status || 'unknown'}' but has no waiver and no CI-re-derived verified status`,
        });
      }

      // WS8 iteration-4: always emit the summary count, even when zero, so a passing bundle
      // with zero attested claims is distinguishable in the log from one where the count line
      // is simply absent (grep-stable for downstream tooling / reviewers).
      process.stdout.write(`[trust-reconcile] ${attestedCount} attested claim(s) accepted without independent verification\n`);
    }
  }

  // -------------------------------------------------------------------------
  // Report and exit
  // -------------------------------------------------------------------------
  if (issues.length === 0) {
    process.stdout.write('\n[trust-reconcile] exit 0: fresh verify passed');
    if (bundlePath) process.stdout.write(', all claimed-pass commands reconciled clean');
    process.stdout.write('\n');

    // Write CI results file for mint-attestation.js to consume.
    // Path mirrors what mint-attestation.js reads: RUNNER_TEMP/ci-trust-reconcile-results.json
    // (or os.tmpdir() locally). Failure is non-fatal — mint-attestation synthesizes if missing.
    const resultsDir = process.env.RUNNER_TEMP || os.tmpdir();
    const resultsFilePath = path.join(resultsDir, 'ci-trust-reconcile-results.json');
    const ciResultsArr = Array.from(ciResults.entries()).map(([cmd, r]) => ({
      command: cmd,
      exitCode: r.exitCode,
      passed: r.passed,
    }));
    const resultsPayload = {
      commit_sha: process.env.GITHUB_SHA || 'unknown',
      canonical_commands: ciResultsArr,
      reconciled: bundlePath !== null,
      built_at: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(resultsFilePath, JSON.stringify(resultsPayload, null, 2));
      process.stdout.write(`[trust-reconcile] results written: ${resultsFilePath}\n`);
    } catch (err) {
      // Non-fatal: mint-attestation will synthesize from env if this file is absent.
      process.stdout.write(`[trust-reconcile] results write skipped (${err.message})\n`);
    }

    return 0;
  }

  process.stderr.write(`\n[trust-reconcile] FAILED — ${issues.length} issue(s) detected:\n`);
  for (const issue of issues) {
    process.stderr.write(`  [${issue.type}] ${issue.message}\n`);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// CLI entrypoint (direct script invocation)
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  process.exit(runTrustReconcile({
    bundle: args.bundle || null,
    commands: args.commands,
    repoRoot: args.repoRoot || null,
    manifest: args.manifest || null,
  }));
}

// Export core function for programmatic use (e.g. flow-agents verify CLI subcommand).
// The direct-CLI behavior is preserved: when run as a script, main() is called below.
module.exports.runTrustReconcile = runTrustReconcile;

if (require.main === module) {
  main();
}
