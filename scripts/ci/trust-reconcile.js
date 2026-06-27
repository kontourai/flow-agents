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
 *   TRUST_RECONCILE_BUNDLE    Path to delivered bundle (same as --bundle).
 *   TRUST_RECONCILE_COMMANDS  Comma- or newline-separated canonical commands.
 *   TRUST_RECONCILE_REPO_ROOT Repository root.
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
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

/**
 * Returns true when a command string contains an exit-code-laundering operator.
 * These operators mask real exit codes so the real sub-command may have failed silently.
 *
 * Rules (applied to claimed verification commands only):
 *   - ANY || operator — verify commands must not contain ||. This catches:
 *     || exit 0, || echo ok, || /bin/true, || true, || :, etc.
 *   - ; or newline followed by true / : / exit 0 — trailing success injection
 *
 * NOTE: Logic must stay identical to scripts/hooks/stop-goal-fit.js hasLaunderingOperator.
 * Centralize into a shared module as a follow-up (coordinate-free duplication for now).
 */
function hasLaunderingOperator(cmd) {
  // Flag ANY || operator — masks the exit code of the left-hand command.
  if (/\|\|/.test(cmd)) return true;
  // Flag ; or newline followed by true / : / exit 0
  if (/[;\n]\s*true\b/.test(cmd)) return true;
  if (/[;\n]\s*:\s*(?:$|\s|;|\n)/.test(cmd)) return true;
  if (/[;\n]\s*exit\s+0\b/.test(cmd)) return true;
  // Flag pipe to true (pipeline absorbs exit code)
  if (/\|\s*true\b/.test(cmd)) return true;
  return false;
}

/**
 * Run a single shell command under bash, capturing exit code.
 * @returns {{ cmd, exitCode, passed, stdout, stderr }}
 */
function runCommand(cmd, repoRoot) {
  const result = spawnSync('bash', ['-c', cmd], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 180000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exitCode = (result.status !== null && result.status !== undefined)
    ? result.status
    : 1;
  return {
    cmd,
    exitCode,
    passed: exitCode === 0 && !result.error,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Parse the trust.bundle and extract every evidence item asserting a command PASSED.
 * Returns an array of { cmd, claimId, evId, claimType, noEvidence? } objects.
 *
 * Source of truth: evidence[].execution.label is the command string recorded at
 * capture time. evidence[].passing (normalized) means the agent claimed this passed.
 *
 * Also collects workflow.check.command claims (or any claim with value "pass") that
 * have no matching evidence item — these represent never-captured claimed passes
 * and will produce a not-run divergence (Part-B logic mirroring stop-goal-fit.js).
 */
function getClaimedPassCommands(bundle) {
  const evidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  const claims = Array.isArray(bundle.claims) ? bundle.claims : [];

  // Build a map from claimId -> claim for fast lookup
  const claimById = new Map();
  for (const c of claims) {
    if (c && c.id) claimById.set(c.id, c);
  }

  const commands = [];
  const seen = new Set();

  // (A) Evidence items with execution.label and a passing value
  for (const ev of evidence) {
    if (!ev || !ev.execution || !ev.execution.label) continue;
    if (!isPassingValue(ev.passing)) continue; // only claimed-pass items

    const cmd = normalizeCmd(ev.execution.label);
    if (!cmd || seen.has(cmd)) continue;
    seen.add(cmd);

    const claim = claimById.get(ev.claimId);
    const claimType = claim ? String(claim.claimType || '') : '';

    commands.push({ cmd, claimId: ev.claimId, evId: ev.id, claimType });
  }

  // (B) Claims with claimType workflow.check.command (or any claim asserting pass)
  // that have NO matching evidence item with execution.label — never-captured claimed passes.
  const evidenceClaimIds = new Set(
    evidence
      .filter(ev => ev && ev.claimId && ev.execution && ev.execution.label)
      .map(ev => ev.claimId)
  );

  for (const c of claims) {
    if (!c || !c.id || typeof c.claimType !== 'string') continue;
    // Require claimType === workflow.check.command OR any claim asserting pass with no evidence
    const isCommandClaim = c.claimType === 'workflow.check.command';
    const assertsPass = isPassingValue(c.value) || c.status === 'verified';
    if (!isCommandClaim && !assertsPass) continue;
    if (evidenceClaimIds.has(c.id)) continue; // already covered in (A)

    // Use fieldOrBehavior or value as command identifier (may be non-executable — that's ok,
    // the key is that no evidence captured this pass claim, so emit not-run divergence).
    const rawCmd = c.fieldOrBehavior || c.value || '';
    const cmd = normalizeCmd(rawCmd);
    const synthetic = cmd || `[claim:${c.id}:${c.claimType}]`;
    if (seen.has(synthetic)) continue;
    seen.add(synthetic);

    commands.push({
      cmd: synthetic,
      claimId: c.id,
      evId: null,
      claimType: c.claimType,
      noEvidence: true,
    });
  }

  return commands;
}

// ---------------------------------------------------------------------------
// Argument + config parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { bundle: null, commands: [], repoRoot: null };
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
    }
  }
  return args;
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
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(
    args.repoRoot || process.env.TRUST_RECONCILE_REPO_ROOT || process.cwd()
  );

  // Resolve bundle path: explicit arg > env > auto-discovery > null (fail-open)
  const bundlePath = args.bundle
    || process.env.TRUST_RECONCILE_BUNDLE
    || discoverBundle(repoRoot)
    || null;

  const canonicalCommands = resolveCanonicalCommands(args, repoRoot);

  // FAIL-CLOSED: no comprehensive verify configured — refuse compile-only attestation.
  if (canonicalCommands === null) {
    process.stderr.write(
      '[trust-reconcile] FAILED — no comprehensive trust-reconcile-verify configured.\n' +
      '[trust-reconcile] Refusing to attest a compile-only check.\n' +
      '[trust-reconcile] Declare package.json scripts["trust-reconcile-verify"] or set TRUST_RECONCILE_COMMANDS.\n' +
      '[trust-reconcile] Example: add "trust-reconcile-verify": "npm run build && npm run eval:static && npm run eval:integration"\n'
    );
    process.exit(1);
  }

  process.stdout.write('[trust-reconcile] starting CI trust anchor reconcile\n');
  process.stdout.write(`[trust-reconcile] repo-root: ${repoRoot}\n`);
  process.stdout.write(`[trust-reconcile] canonical commands: ${canonicalCommands.join(' | ')}\n`);
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
      process.exit(1);
    }
  }

  /** @type {Map<string, {exitCode: number, passed: boolean}>} */
  const ciResults = new Map();

  for (const cmd of canonicalCommands) {
    process.stdout.write(`[trust-reconcile]   running: ${cmd}\n`);
    const result = runCommand(cmd, repoRoot);
    const key = normalizeCmd(cmd);
    ciResults.set(key, { exitCode: result.exitCode, passed: result.passed });

    if (result.passed) {
      process.stdout.write(`[trust-reconcile]   PASS: ${cmd}\n`);
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
      process.exit(1);
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
      // Full bundle: extract claimed-pass commands from evidence items + claims
      const claimedPasses = getClaimedPassCommands(bundle);
      process.stdout.write(`[trust-reconcile] found ${claimedPasses.length} claimed-pass command(s) in bundle\n`);

      for (const { cmd, claimId, claimType, noEvidence } of claimedPasses) {
        const normalCmd = normalizeCmd(cmd);

        // (d) Claims with no evidence are an immediate not-run divergence.
        // A pass was claimed but never captured — CI cannot confirm it.
        if (noEvidence) {
          issues.push({
            type: 'not-run',
            cmd,
            message: `trust divergence: claim '${claimId}' (claimType: ${claimType}) asserts pass but has no supporting evidence item — command never captured`,
          });
          continue;
        }

        // (a) Laundering operator check — must come first (most specific signal)
        if (hasLaunderingOperator(cmd)) {
          issues.push({
            type: 'laundering',
            cmd,
            message: `trust divergence: agent claimed '${cmd}' passed; command contains exit-code-laundering operator (|| ... / ; true / ; exit 0 / etc.)`,
          });
          continue;
        }

        // (b/c) Look up in CI's fresh run results
        const ciResult = ciResults.get(normalCmd);

        if (!ciResult) {
          // (c) CI never ran this claimed-pass command — fail-closed
          issues.push({
            type: 'not-run',
            cmd,
            message: `trust divergence: agent claimed '${cmd}' passed; CI did not run this command (not in canonical verify set)`,
          });
          continue;
        }

        if (!ciResult.passed) {
          // (b) Claimed pass + CI fresh FAIL = divergence
          issues.push({
            type: 'divergence',
            cmd,
            exitCode: ciResult.exitCode,
            message: `trust divergence: agent claimed '${cmd}' passed; CI fresh run = FAIL (exit ${ciResult.exitCode})`,
          });
          continue;
        }

        // Clean: claimed pass, CI confirms pass
        process.stdout.write(`[trust-reconcile]   RECONCILED: '${cmd}' — claimed pass, CI fresh run = PASS\n`);
      }
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

    process.exit(0);
  }

  process.stderr.write(`\n[trust-reconcile] FAILED — ${issues.length} issue(s) detected:\n`);
  for (const issue of issues) {
    process.stderr.write(`  [${issue.type}] ${issue.message}\n`);
  }
  process.exit(1);
}

main();
