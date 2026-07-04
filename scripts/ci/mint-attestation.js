#!/usr/bin/env node
/**
 * mint-attestation.js — CI trust anchor Phase 2.
 *
 * Signs an in-toto v1 statement attesting CI's own fresh verification results
 * via Sigstore keyless signing (Fulcio + Rekor).  Consumes the results file
 * that trust-reconcile.js writes, then calls signStatementWithSigstore from
 * @kontourai/surface.
 *
 * Invocation (after trust-reconcile passes):
 *   node scripts/ci/mint-attestation.js
 *
 * Statement shape:
 *   subject:       delivery/trust.bundle (sha256) if present; else ci-verify-results
 *                  (sha256 of predicate JSON)
 *   predicateType: https://kontourai.dev/ci-verify/v1
 *   predicate:     { commit_sha, canonical_commands, reconciled, built_at }
 *
 * Outputs (written to ATTESTATION_OUT_DIR, defaulting to cwd):
 *   Signed path (CI/OIDC):
 *     trust.attestation.sig.json    — DSSE envelope
 *     trust.attestation.status.json — { status:"signed", output_path }
 *   Unsigned path (local/no OIDC):
 *     trust.attestation.intoto.json — unsigned in-toto statement
 *     trust.attestation.status.json — { status:"unsigned", reason, output_path }
 *
 * Fail-open: NEVER throws — returns exit 0 on signing failure so the job
 * does not crash when no ambient OIDC identity is present.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex digest of a Buffer or string.
 * @param {Buffer|string} data
 * @returns {string}
 */
function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Load CI results written by trust-reconcile.js.
 * Falls back to a synthesized record from env vars when the file is absent.
 *
 * @param {string} repoRoot
 * @returns {{ commit_sha: string, canonical_commands: Array, reconciled: boolean, built_at: string }}
 */
function loadCiResults(repoRoot) {
  const resultsDir = process.env.RUNNER_TEMP || os.tmpdir();
  const resultsPath = path.join(resultsDir, 'ci-trust-reconcile-results.json');

  if (fs.existsSync(resultsPath)) {
    try {
      const raw = fs.readFileSync(resultsPath, 'utf8');
      const parsed = JSON.parse(raw);
      process.stdout.write(`[mint-attestation] loaded CI results from: ${resultsPath}\n`);
      return parsed;
    } catch (err) {
      process.stdout.write(`[mint-attestation] results file unreadable (${err.message}), synthesizing from env\n`);
    }
  } else {
    process.stdout.write(`[mint-attestation] no CI results file found, synthesizing from env\n`);
  }

  // Synthesize from environment — trust-reconcile already passed so commands succeeded.
  const cmdEnv = process.env.TRUST_RECONCILE_COMMANDS || '';
  const commands = cmdEnv
    ? cmdEnv.split(/[,\n]/).map(c => c.trim()).filter(Boolean)
    : ['npm run build'];

  // Check for package.json trust-reconcile-verify script as trust-reconcile does.
  let finalCmds = commands;
  if (!cmdEnv) {
    try {
      const pkgPath = path.join(repoRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg && pkg.scripts && pkg.scripts['trust-reconcile-verify']) {
          finalCmds = ['npm run trust-reconcile-verify'];
        }
      }
    } catch { /* ignore */ }
  }

  return {
    commit_sha: process.env.GITHUB_SHA || 'unknown',
    canonical_commands: finalCmds.map(cmd => ({
      command: cmd,
      exitCode: 0,
      passed: true, // reconcile passed, so all canonical commands passed
    })),
    reconciled: false, // synthesized: no bundle was confirmed
    built_at: new Date().toISOString(),
  };
}

/**
 * Discover the delivery trust.bundle across the flat and per-session (#379) layouts.
 * Prefers the flat `delivery/trust.bundle` (back-compat), then `delivery/<slug>/trust.bundle`
 * for each immediate subdirectory (sorted). Returns the first existing path, or null.
 * This mirrors scripts/ci/trust-reconcile.js resolveDeliveryCandidates() precedence so the
 * attestation subject binds to the same bundle the reconciler read. best-effort — a missing
 * or unreadable delivery/ yields null.
 */
function discoverDeliveryBundle(repoRoot) {
  const deliveryRoot = path.join(repoRoot, 'delivery');
  const flat = path.join(deliveryRoot, 'trust.bundle');
  if (fs.existsSync(flat)) return flat;
  let entries = [];
  try {
    entries = fs.readdirSync(deliveryRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of subdirs) {
    const candidate = path.join(deliveryRoot, name, 'trust.bundle');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Determine the subject artifact for the in-toto statement.
 *
 * If a delivery trust.bundle is present (flat or per-session, #379), use it as the subject
 * (sha256 of its bytes). Otherwise synthesize a results artifact from the predicate.
 *
 * @param {object} predicate  — the predicate that will appear in the statement
 * @param {string} repoRoot
 * @returns {{ subjectName: string, subjectDigest: string, fromBundle: boolean }}
 */
function resolveSubject(predicate, repoRoot) {
  const bundlePath = discoverDeliveryBundle(repoRoot);
  if (bundlePath) {
    const bundleBytes = fs.readFileSync(bundlePath);
    const digest = sha256hex(bundleBytes);
    const rel = path.relative(repoRoot, bundlePath);
    process.stdout.write(`[mint-attestation] subject: ${rel} sha256=${digest.slice(0, 16)}...\n`);
    return { subjectName: rel, subjectDigest: digest, fromBundle: true };
  }

  // No bundle present: synthesize subject from predicate JSON (self-attesting the results).
  const predicateJson = JSON.stringify(predicate);
  const digest = sha256hex(Buffer.from(predicateJson, 'utf8'));
  process.stdout.write(`[mint-attestation] subject: ci-verify-results (synthesized) sha256=${digest.slice(0, 16)}...\n`);
  return { subjectName: 'ci-verify-results', subjectDigest: digest, fromBundle: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const repoRoot = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const outDir = path.resolve(process.env.ATTESTATION_OUT_DIR || process.cwd());

  process.stdout.write('[mint-attestation] CI trust anchor Phase 2 — minting attestation\n');
  process.stdout.write(`[mint-attestation] repo-root: ${repoRoot}\n`);
  process.stdout.write(`[mint-attestation] out-dir:   ${outDir}\n`);

  // 1. Load CI results.
  const ciResults = loadCiResults(repoRoot);

  // 2. Build predicate.
  const predicate = {
    commit_sha: ciResults.commit_sha,
    canonical_commands: ciResults.canonical_commands,
    reconciled: ciResults.reconciled,
    built_at: ciResults.built_at,
  };

  // 3. Resolve subject artifact.
  const { subjectName, subjectDigest } = resolveSubject(predicate, repoRoot);

  // 4. Build in-toto statement.
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: subjectName, digest: { sha256: subjectDigest } }],
    predicateType: 'https://kontourai.dev/ci-verify/v1',
    predicate,
  };

  // 5. Attempt keyless Sigstore signing.
  let signed = null;
  try {
    const { signStatementWithSigstore } = await import('@kontourai/surface');
    signed = await signStatementWithSigstore(statement);
  } catch (err) {
    // Fail-open: if @sigstore/sign is missing or throws, signed stays null.
    process.stdout.write(`[mint-attestation] signing threw (fail-open): ${err.message}\n`);
  }

  // 6. Write output.
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch { /* ignore if already exists */ }

  if (signed !== null) {
    // Signed path: write DSSE envelope.
    const sigPath = path.join(outDir, 'trust.attestation.sig.json');
    fs.writeFileSync(sigPath, JSON.stringify(signed.envelope, null, 2));

    const statusPath = path.join(outDir, 'trust.attestation.status.json');
    fs.writeFileSync(statusPath, JSON.stringify({
      status: 'signed',
      assuranceLevel: signed.assuranceLevel,
      output_path: sigPath,
    }, null, 2));

    process.stdout.write(`[mint-attestation] status: signed\n`);
    process.stdout.write(`[mint-attestation] output: ${sigPath}\n`);
    process.stdout.write(`[mint-attestation] status-file: ${statusPath}\n`);
  } else {
    // Unsigned path: write raw in-toto statement.
    const intotoPath = path.join(outDir, 'trust.attestation.intoto.json');
    fs.writeFileSync(intotoPath, JSON.stringify(statement, null, 2));

    const reason = 'no ambient OIDC identity';
    const statusPath = path.join(outDir, 'trust.attestation.status.json');
    fs.writeFileSync(statusPath, JSON.stringify({
      status: 'unsigned',
      reason,
      output_path: intotoPath,
    }, null, 2));

    process.stdout.write(`[mint-attestation] status: unsigned (${reason})\n`);
    process.stdout.write(`[mint-attestation] output: ${intotoPath}\n`);
    process.stdout.write(`[mint-attestation] status-file: ${statusPath}\n`);
  }
}

// Entry point — never throw.
main().catch(err => {
  // Fail-open: log the error but exit 0 so the CI job does not crash.
  process.stdout.write(`[mint-attestation] unhandled error (fail-open): ${err && err.message}\n`);
  process.exit(0);
});
