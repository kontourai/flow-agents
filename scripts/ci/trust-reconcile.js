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
 *   0 — fresh verify passed AND no divergence (bundle reconciled clean, OR bundle
 *       absence is covered by a well-formed, in-scope delivery/DECLARED marker)
 *   1 — fresh verify failed OR any divergence detected OR compile-only fallback OR
 *       bundle absent with no valid delivery/DECLARED marker (bundle-required by default)
 *
 * Bundle-required by default (ADR 0022 §1): if no bundle is provided (and none
 * auto-discovered at delivery/trust.bundle or delivery/trust.checkpoint.json), the
 * reconciler no longer fails open. It looks for a delivery/DECLARED no-agent-delivery
 * marker (ADR 0022 §2) — a single {scope, reason, approved_by, declared_at} object, or a
 * JSON array of such objects, resolved via the same path seam bundle discovery uses (see
 * resolveDeliveryCandidates()). A well-formed marker whose `scope` matches this change
 * (`ref:`, `commit:`/`commit:a..b`, `author:`, or `branch-prefix:` — see matchesScope())
 * exempts Step 2 ONLY; Step 1 (fresh verify) still runs unconditionally and is never
 * skipped. An absent, malformed (missing any required field), or out-of-scope marker is
 * treated the same as bundle-absence-with-no-exemption: it produces a
 * `bundle-required-no-declared-marker` issue and exits 1. Fail-closed on divergence: any
 * claimed-pass command CI cannot confirm blocks. Fail-closed on compile-only: if no
 * comprehensive verify is configured, exits 1.
 *
 * "Bundle-required" means a bundle FOR THIS CHANGE (ADR 0022 addendum §2), not merely a
 * bundle reachable at the checkout: an AUTO-DISCOVERED bundle whose trust.checkpoint.json
 * `commit_sha` neither equals nor is a git-ancestor of this change's own commit sha
 * (TRUST_RECONCILE_SHA/GITHUB_SHA) is treated as ABSENT, not present — see
 * bundleAttestsThisChange(). Without this, a bundle inherited unchanged from main via
 * update-branch/rebase (live incident: PR #278) would satisfy Step 2 trivially for every
 * dependabot/release-please PR, since neither bot's branch ever runs the deliver skill
 * itself. A stale bundle prints a loud `stale bundle ignored — attests <theirs>, this
 * change is <ours>` line and then falls through to delivery/DECLARED resolution exactly
 * as if no bundle had been discovered at all. This check applies ONLY to auto-discovery —
 * an explicit --bundle/TRUST_RECONCILE_BUNDLE is a deliberate caller choice (tests,
 * programmatic callers), not something silently inherited from committed git tree state.
 *
 * Event-scoped enforcement (ADR 0022 addendum, part 4): bundle-required enforcement (the
 * `bundle-required-no-declared-marker` fail-closed branch, and the staleness-gate
 * consequence of it above) applies ONLY when this run is gating a proposed change —
 * TRUST_RECONCILE_EVENT (set from `github.event_name` by
 * .github/workflows/trust-reconcile.yml) resolving to anything other than 'push'
 * (conservative default: unknown/absent → enforce; see resolveEnforcementEvent()). On a
 * 'push' event, an absent or stale auto-discovered bundle is a LOUD NO-OP (`push event:
 * ... — skipping Step 2 (gating happened on the PR run)`, exit 0), never a failure and
 * never a delivery/DECLARED requirement — a push run on a protected branch happens AFTER
 * the gating PR run already passed (branch protection already excludes direct pushes),
 * and after a squash-merge the merge commit almost never has git ancestry back to the
 * feature-branch commit a checkpoint was sealed against, so bundle absence/staleness on
 * push is the EXPECTED case, not a divergence (reproduced empirically as a HIGH
 * launch-blocker: without this scoping, every delivery would fail Trust Reconcile on
 * `main` immediately post-merge and Phase 2 attestation minting would stop). Step 1
 * (fresh verify) is unaffected by event scoping — it always runs. A fresh auto-discovered
 * bundle on push still reconciles normally (Step 2 runs, forming the Phase 2 attestation
 * basis) — only absence/staleness is treated differently by event.
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
 *   TRUST_RECONCILE_REF/_ACTOR/_SHA       Override the delivery/DECLARED scope-matching
 *                                         context (ref / actor / commit sha) that otherwise
 *                                         falls back to GITHUB_HEAD_REF|GITHUB_REF,
 *                                         GITHUB_ACTOR, GITHUB_SHA respectively — for
 *                                         deterministic local/eval testing.
 *   TRUST_RECONCILE_EVENT                 CI event name (`github.event_name`) driving
 *                                         event-scoped bundle-required enforcement (ADR
 *                                         0022 addendum, part 4) — see
 *                                         resolveEnforcementEvent(). Default (unset/
 *                                         unrecognized): treated as a gating event.
 *
 * Auto-discovery (when no --bundle or TRUST_RECONCILE_BUNDLE is set):
 *   Checks delivery/trust.bundle, then delivery/trust.checkpoint.json under repo root
 *   (via the resolveDeliveryCandidates() seam). If neither exists, falls through to
 *   delivery/DECLARED marker resolution — see "Bundle-required by default" above.
 *
 * Canonical commands resolution (fail-closed on compile-only):
 *   Priority: CLI --commands > TRUST_RECONCILE_COMMANDS env > package.json
 *   scripts["trust-reconcile-verify"]. If NONE of those is configured, exits 1 with
 *   "no comprehensive trust-reconcile-verify configured" — refuses to attest a
 *   compile-only check.
 *
 * NOTE: This job IS ALREADY a required status check in GitHub branch protection on
 * `main` (verified via the GitHub branch-protection API — required_status_checks.contexts
 * includes "Trust Reconcile", enforce_admins: true). Disabling or downgrading that
 * requirement is a server-side branch-protection change — it cannot be done by editing
 * this file or .github/workflows/trust-reconcile.yml.
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
    // #267/#282: a superseded critique write is HISTORY — excluded from reconcile evaluation so a
    // resolved session converges (a fail critique that a later same-reviewer pass superseded no
    // longer blocks). Scoped to NON-test_output claims so a command-backed claim can never launder
    // a real failure by carrying superseded_by — a test_output claim always reconciles or diverges.
    if (c.metadata && typeof c.metadata === 'object' && c.metadata.superseded_by && !claimHasTestOutputEvidence.has(c.id)) continue;
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

// ---------------------------------------------------------------------------
// delivery/ path-resolution seam (#335-aware) + ADR 0022 DECLARED-marker support.
// ---------------------------------------------------------------------------

const DELIVERY_DIR = 'delivery';

/**
 * Single seam: every delivery/ path resolution in this file routes through here.
 * #335 (per-session delivery paths, e.g. delivery/<session-slug>/<filename> instead of
 * one shared path) is expected to change ONLY this function's body — e.g. glob
 * delivery/<slug-glob>/<filename> and return every match in a defined precedence order,
 * or
 * resolve the current PR's session slug and return its single subpath. discoverBundle()
 * and discoverDeclaredMarker() both iterate whatever candidates this returns and pick the
 * first existing one, so a future per-session layout composes with zero call-site changes.
 */
function resolveDeliveryCandidates(repoRoot, filename) {
  return [path.join(repoRoot, DELIVERY_DIR, filename)];
}

/**
 * Auto-discover the delivery bundle when no explicit path is provided.
 * Checks delivery/trust.bundle, then delivery/trust.checkpoint.json under repo root
 * (via resolveDeliveryCandidates()). Returns null if neither is present — the caller
 * then falls through to delivery/DECLARED marker resolution (ADR 0022 §1); bundle
 * absence is no longer fail-open on its own.
 */
function discoverBundle(repoRoot) {
  for (const filename of ['trust.bundle', 'trust.checkpoint.json']) {
    for (const candidate of resolveDeliveryCandidates(repoRoot, filename)) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Auto-discover the delivery/DECLARED no-agent-delivery marker (ADR 0022 §2) via the
 * same resolveDeliveryCandidates() seam bundle discovery uses. Returns null if absent.
 */
function discoverDeclaredMarker(repoRoot) {
  for (const candidate of resolveDeliveryCandidates(repoRoot, 'DECLARED')) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Required, non-empty-string fields on every delivery/DECLARED marker entry (ADR 0022 §2). */
const DECLARED_REQUIRED_FIELDS = ['scope', 'reason', 'approved_by', 'declared_at'];

/**
 * Parse and validate a delivery/DECLARED marker file. Accepts either a single
 * {scope, reason, approved_by, declared_at} object, or a JSON array of such objects
 * (small, backward-compatible extension so one marker file can cover multiple
 * non-agent-delivery scopes, e.g. dependabot AND release-please, without a blanket scope).
 *
 * @returns {{ok:false, reason:string}} on unreadable/malformed-JSON input, else
 *   {{ok:true, wellFormed:object[], malformed:{entry:*, missing:string[]}[], totalEntries:number}}
 *   — every entry is validated; malformed entries are reported individually rather than
 *   invalidating the whole file (so one bad entry cannot silently mask a good one).
 */
function parseDeclaredMarker(markerPath) {
  let raw;
  try {
    raw = fs.readFileSync(markerPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `delivery/DECLARED marker is malformed: not valid JSON (unreadable: ${err.message})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'delivery/DECLARED marker is malformed: not valid JSON' };
  }
  if (Array.isArray(parsed) && parsed.length === 0) {
    return { ok: false, reason: 'delivery/DECLARED marker is malformed: array contains zero entries' };
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const wellFormed = [];
  const malformed = [];
  for (const entry of entries) {
    const missing = DECLARED_REQUIRED_FIELDS.filter((field) => {
      const value = entry && typeof entry === 'object' ? entry[field] : undefined;
      return typeof value !== 'string' || value.trim() === '';
    });
    if (missing.length > 0) {
      malformed.push({ entry, missing });
    } else {
      wellFormed.push(entry);
    }
  }
  return { ok: true, wellFormed, malformed, totalEntries: entries.length };
}

/**
 * Resolve the scope-matching context for delivery/DECLARED evaluation:
 * ref = TRUST_RECONCILE_REF || GITHUB_HEAD_REF || GITHUB_REF stripped of 'refs/heads/' || ''
 * actor = TRUST_RECONCILE_ACTOR || GITHUB_ACTOR || ''
 * sha = TRUST_RECONCILE_SHA || GITHUB_SHA || ''
 * An empty context value never matches any scope segment (see matchesScope) — this
 * prevents an empty-string scope segment from becoming an accidental wildcard.
 */
function resolveScopeContext(repoRoot) {
  const githubRef = process.env.GITHUB_REF || '';
  const strippedGithubRef = githubRef.startsWith('refs/heads/')
    ? githubRef.slice('refs/heads/'.length)
    : githubRef;
  const ref = process.env.TRUST_RECONCILE_REF
    || process.env.GITHUB_HEAD_REF
    || strippedGithubRef
    || '';
  const actor = process.env.TRUST_RECONCILE_ACTOR || process.env.GITHUB_ACTOR || '';
  const sha = process.env.TRUST_RECONCILE_SHA || process.env.GITHUB_SHA || '';
  return { ref, actor, sha, repoRoot };
}

/**
 * Resolve the CI event this run is gating (ADR 0022 addendum, part 4 — event-scoped
 * bundle-required enforcement). `TRUST_RECONCILE_EVENT` (set by
 * .github/workflows/trust-reconcile.yml from `github.event_name`) is the source.
 *
 * Conservative default: an unknown/absent event value is treated as a GATING event
 * (enforce) — every existing local/test caller that sets no TRUST_RECONCILE_EVENT keeps
 * today's fail-closed behavior unchanged, and a misconfigured/unrecognized CI event fails
 * toward the STRICTER gate, never the looser post-merge one. Only the literal value
 * 'push' is treated as a post-merge run — bundle-required enforcement (and its
 * staleness-gate consequence) applies to every other event, including
 * `workflow_dispatch`, which is not guaranteed to be post-merge.
 *
 * Residual (HIGH, documented not solved): the VALUE `github.event_name` resolves to is
 * authoritative GitHub Actions context, but the WORKFLOW FILE that sets
 * `TRUST_RECONCILE_EVENT: ${{ github.event_name }}` is itself PR-editable content on a
 * `pull_request` run — a PR could hardcode `TRUST_RECONCILE_EVENT: push` in its own copy
 * of the workflow to fake the post-merge no-op path. This is closed by required
 * code-owner review on `.github/workflows/trust-reconcile.yml` (#225, not yet server-side
 * enforced), the same residual class as every other self-asserted CI input in this file.
 * Step 1 (fresh verify) is unaffected by event scoping either way — it always runs and
 * must pass regardless of which branch this function's caller takes.
 */
function resolveEnforcementEvent() {
  return (process.env.TRUST_RECONCILE_EVENT || '').trim() || 'pull_request';
}

/**
 * Best-effort single-direction ancestor check: is `ancestorSha` an ancestor of (or equal
 * to) `descendantSha`? Uses `git merge-base --is-ancestor` (a commit is its own ancestor).
 * Never throws — underivable (git missing, shallow clone, unknown sha, etc.) → false.
 * Shared by isShaInRange() (commit: scope ranges) and bundleAttestsThisChange() (the
 * bundle-ownership staleness check, ADR 0022 addendum §2).
 */
function isAncestorCommit(repoRoot, ancestorSha, descendantSha) {
  if (!ancestorSha || !descendantSha) return false;
  try {
    const res = spawnSync('git', ['merge-base', '--is-ancestor', ancestorSha, descendantSha], {
      cwd: repoRoot, stdio: 'ignore',
    });
    return !!res && !res.error && res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Best-effort commit-range membership check: is `sha` reachable from `to` AND is `from`
 * an ancestor of `sha`? (a commit is its own ancestor, so sha === from or sha === to both
 * count as in-range). Never throws — underivable → false, never a match.
 */
function isShaInRange(repoRoot, sha, from, to) {
  if (!sha || !from || !to) return false;
  return isAncestorCommit(repoRoot, from, sha) && isAncestorCommit(repoRoot, sha, to);
}

/**
 * Match a SINGLE scope condition (one of the four forms) against the resolved context.
 * Extracted from matchesScope() so a compound (space-separated, AND) scope can validate
 * each condition independently and still fail closed if any one is unrecognized.
 * String equality/prefix ops ONLY — zero RegExp construction from marker content (AC4).
 * Supported forms: `ref:<exact>`, `commit:<sha>` or `commit:<from>..<to>` (range, via
 * isShaInRange), `author:<exact>`, `branch-prefix:<prefix>` (via String#startsWith).
 * An unrecognized prefix does not match (not an error — fails closed silently). Every
 * arm requires the COMPARED CONTEXT value to be non-empty, so an empty ref/actor/sha
 * (e.g. running outside CI with no override) can never be treated as a wildcard match.
 */
function matchesScopeCondition(condition, ctx) {
  const s = typeof condition === 'string' ? condition : '';

  if (s.startsWith('ref:')) {
    const want = s.slice('ref:'.length);
    return !!want && !!ctx.ref && ctx.ref === want;
  }

  if (s.startsWith('commit:')) {
    const want = s.slice('commit:'.length);
    if (!want || !ctx.sha) return false;
    const rangeSep = want.indexOf('..');
    if (rangeSep === -1) {
      return ctx.sha === want;
    }
    const from = want.slice(0, rangeSep);
    const to = want.slice(rangeSep + 2);
    if (!from || !to) return false;
    return isShaInRange(ctx.repoRoot, ctx.sha, from, to);
  }

  if (s.startsWith('author:')) {
    const want = s.slice('author:'.length);
    return !!want && !!ctx.actor && ctx.actor === want;
  }

  if (s.startsWith('branch-prefix:')) {
    const want = s.slice('branch-prefix:'.length);
    return !!want && !!ctx.ref && ctx.ref.startsWith(want);
  }

  // Unrecognized prefix (or empty condition) — does not match, not an error.
  return false;
}

/**
 * Match a delivery/DECLARED marker's `scope` string against the resolved context.
 *
 * `scope` is either a single condition (backward compatible, unchanged behavior) OR
 * multiple space-separated conditions that must ALL match (AND) — e.g.
 * `"author:github-actions[bot] branch-prefix:release-please--"` binds an identity claim
 * (`author:`, bound to the platform-set `GITHUB_ACTOR`, not attacker-controlled) to a
 * narrower blast radius (`branch-prefix:`) rather than trusting either alone. This
 * closes a security-review finding: `ref:`/`branch-prefix:` ALONE match against
 * `GITHUB_HEAD_REF`, which is PUSHER-CONTROLLED on a fork PR — a `ref:`-only or
 * `branch-prefix:`-only scope can therefore be satisfied by anyone who can name a
 * branch, not just the bot the marker is meant to identify. Compound (AND) scopes let a
 * marker require both signals. Any unrecognized-prefix condition anywhere in a compound
 * scope makes the WHOLE scope never match (fail closed) — see matchesScopeCondition().
 * Zero RegExp construction from marker content (AC4) — space-splitting uses a plain
 * string split, not a marker-derived pattern.
 */
function matchesScope(scope, ctx) {
  const s = typeof scope === 'string' ? scope : '';
  const conditions = s.split(' ').map((c) => c.trim()).filter(Boolean);
  if (conditions.length === 0) return false;
  return conditions.every((condition) => matchesScopeCondition(condition, ctx));
}

/**
 * Orchestrate delivery/DECLARED resolution for the bundle-absent path: discover → parse
 * → scope-match → return {exempt, marker?, diagnostic?}. First in-scope, well-formed
 * entry wins (array form); every entry is validated regardless, and malformed entries
 * are logged individually so a bad entry never silently masks a good one.
 *
 * Diagnostic strings below are pinned (grepped by callers/evals) — do not reword.
 */
function resolveDeclaredExemption(repoRoot, ctx) {
  const markerPath = discoverDeclaredMarker(repoRoot);
  if (!markerPath) {
    return {
      exempt: false,
      diagnostic: 'no bundle present and no delivery/DECLARED marker found — bundle-required by default (ADR 0022 §1); publish delivery/trust.bundle, or add a well-formed, in-scope delivery/DECLARED marker',
    };
  }

  const parsed = parseDeclaredMarker(markerPath);
  if (!parsed.ok) {
    return { exempt: false, diagnostic: parsed.reason };
  }

  for (const { missing } of parsed.malformed) {
    process.stderr.write(`[trust-reconcile] delivery/DECLARED marker is malformed: missing required field(s) [${missing.join(', ')}]\n`);
  }

  if (parsed.wellFormed.length === 0) {
    const first = parsed.malformed[0];
    const diagnostic = first
      ? `delivery/DECLARED marker is malformed: missing required field(s) [${first.missing.join(', ')}]`
      : 'delivery/DECLARED marker is malformed: not valid JSON';
    return { exempt: false, diagnostic };
  }

  for (const marker of parsed.wellFormed) {
    if (matchesScope(marker.scope, ctx)) {
      return { exempt: true, marker };
    }
  }

  return {
    exempt: false,
    diagnostic: 'delivery/DECLARED marker present but out of scope for this change',
  };
}

/**
 * Extract the strongest available commit-identity binding from a discovered bundle/
 * checkpoint, for the bundle-ownership staleness check (ADR 0022 addendum §2). Returns
 * the commit sha string the bundle/checkpoint attests to, or null if no usable binding
 * exists (fail-closed: the caller treats null the same as a mismatch — stale/absent).
 *
 * trust.checkpoint.json's envelope carries `commit_sha` directly (stamped by
 * sealTrustCheckpoint() from `git rev-parse HEAD` at seal time —
 * src/cli/workflow-sidecar.ts). trust.bundle itself carries NO commit/branch metadata
 * (schemaVersion 5: {schemaVersion, source, claims, evidence, policies, events} — confirmed
 * by inspection), so when the discovered bundle IS trust.bundle, this falls through to its
 * sibling delivery/trust.checkpoint.json (same resolveDeliveryCandidates() seam) for the
 * binding — publishDelivery() always copies both together.
 */
function extractBundleCommitSha(repoRoot, bundlePath, bundleJson) {
  if (bundleJson && typeof bundleJson.commit_sha === 'string' && bundleJson.commit_sha.trim()) {
    return bundleJson.commit_sha.trim();
  }
  for (const candidate of resolveDeliveryCandidates(repoRoot, 'trust.checkpoint.json')) {
    if (candidate === bundlePath || !fs.existsSync(candidate)) continue;
    try {
      const checkpoint = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (checkpoint && typeof checkpoint.commit_sha === 'string' && checkpoint.commit_sha.trim()) {
        return checkpoint.commit_sha.trim();
      }
    } catch {
      // Malformed sibling checkpoint — no usable binding from it; keep looking / fall through.
    }
  }
  return null;
}

/**
 * Does the discovered bundle/checkpoint attest THIS change? "Bundle-required" (ADR 0022
 * §1) means a bundle FOR THIS CHANGE, not any bundle merely reachable at the checkout — a
 * bundle inherited unchanged from main via update-branch/rebase (live incident: PR #278, a
 * dependabot PR whose stale main-authored trust.checkpoint.json otherwise satisfied Step 2
 * trivially) must NOT be treated as owned by this change.
 *
 * "Attests this change" = the bundle's commit_sha equals this change's own sha, OR is an
 * ancestor of it (the bundle was sealed earlier in the SAME open PR's own linear commit
 * history, before a later delivery commit — the normal, legitimate shape; sealTrustCheckpoint
 * necessarily stamps a commit that precedes its own delivery commit, so exact equality alone
 * would reject every legitimate delivery). Reuses the same `git merge-base --is-ancestor`
 * primitive `commit:` scope ranges already use (isAncestorCommit()) rather than a new check.
 *
 * FAIL CLOSED on ambiguity: no extractable commit_sha (bundle/checkpoint carries none, or
 * this change's own sha is unresolvable) → never treated as fresh/owned.
 *
 * CORRECTNESS REQUIRES the caller's CI context to provide two things (see
 * .github/workflows/trust-reconcile.yml's "CI-context contract" comment for the concrete
 * settings this repo's own required check uses):
 *   1. A full-history (non-shallow) checkout. `git merge-base --is-ancestor` needs the
 *      parent commit objects; a shallow clone (the common `fetch-depth: 1` default) does
 *      not have them, so the underlying `git merge-base` call exits 128 (unresolvable).
 *   2. `changeSha` bound to the actual commit a checkpoint could plausibly have been
 *      sealed against — on a GitHub `pull_request` trigger this is the PR's own HEAD
 *      commit, NOT the synthetic merge commit `GITHUB_SHA` resolves to by default (a
 *      seal-checkpoint run never stamps a merge commit that did not exist yet).
 * Shallow-clone / missing-object conditions are DEGRADED-BUT-SAFE, never silently
 * accepted: isAncestorCommit() (and therefore this function) fails toward STALE, the same
 * as any other unresolvable ancestry, so a real fresh bundle under a misconfigured shallow
 * checkout is loudly, diagnosably rejected (the `stale bundle ignored — attests <theirs>,
 * this change is <ours>` line still names both shas — an operator can immediately see the
 * mismatch is a checkout-depth artifact, not a real staleness), rather than a bundle CI
 * cannot actually verify slipping through as accepted.
 *
 * @returns {{fresh: boolean, bundleSha: string|null}}
 */
function bundleAttestsThisChange(repoRoot, bundlePath, bundleJson, changeSha) {
  const bundleSha = extractBundleCommitSha(repoRoot, bundlePath, bundleJson);
  if (!bundleSha || !changeSha) return { fresh: false, bundleSha };
  const fresh = bundleSha === changeSha || isAncestorCommit(repoRoot, bundleSha, changeSha);
  return { fresh, bundleSha };
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

  // Resolve bundle path: explicit arg > env > auto-discovery > null. The staleness check
  // below (ADR 0022 addendum §2) applies ONLY to the auto-discovered case — an explicit
  // --bundle/TRUST_RECONCILE_BUNDLE is a deliberate caller choice (tests, programmatic
  // callers), not something silently picked up from committed git tree state, and real CI
  // (.github/workflows/trust-reconcile.yml) never passes --bundle; it always relies on
  // auto-discovery, which is exactly the path PR #278's stale-bundle incident went through.
  const explicitBundlePath = bundle || process.env.TRUST_RECONCILE_BUNDLE || null;
  let bundlePath = explicitBundlePath || discoverBundle(resolvedRepoRoot) || null;
  const bundleWasAutoDiscovered = !explicitBundlePath && !!bundlePath;

  // Scope-matching context (ref/actor/sha) — resolved once, reused by both the
  // bundle-ownership staleness check below and the delivery/DECLARED exemption path
  // further down (bundle-absent branch).
  const scopeCtx = resolveScopeContext(resolvedRepoRoot);

  // Event-scoped enforcement (ADR 0022 addendum, part 4): bundle-required enforcement
  // (and the staleness-gate consequence of it, immediately below) applies ONLY when this
  // run is gating a proposed change. A push run on main happens AFTER the gating PR run
  // already passed — see the isPostMergeEvent branch further down for the full rationale.
  const enforcementEvent = resolveEnforcementEvent();
  const isPostMergeEvent = enforcementEvent === 'push';

  // Bundle-ownership staleness check (ADR 0022 addendum §2): an AUTO-DISCOVERED bundle
  // must attest THIS change, not a historically-committed bundle inherited via
  // update-branch/rebase (live incident: PR #278). A stale bundle is treated as ABSENT —
  // on a gating event it falls through to the exact same DECLARED/fail-closed branch as
  // no-bundle-at-all; on a push event it falls through to a loud no-op instead (below).
  // A bundle that fails to parse here is NOT treated as stale (left alone so the existing
  // Step 2 "failed to read bundle" diagnostic still fires with its own clearer message).
  // bundleWasDiscardedAsStale is tracked only to word the push-event no-op line accurately
  // (an auto-discovered-but-stale bundle vs. no bundle ever being found are both a no-op
  // on push, but "inherited bundle does not attest" is only true of the former).
  let bundleWasDiscardedAsStale = false;
  if (bundlePath && bundleWasAutoDiscovered) {
    let bundleJsonForStaleness = null;
    try {
      bundleJsonForStaleness = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    } catch {
      bundleJsonForStaleness = null;
    }
    if (bundleJsonForStaleness) {
      const { fresh, bundleSha } = bundleAttestsThisChange(resolvedRepoRoot, bundlePath, bundleJsonForStaleness, scopeCtx.sha);
      if (!fresh) {
        const theirs = bundleSha || 'no usable commit binding';
        const ours = scopeCtx.sha || 'unknown (no TRUST_RECONCILE_SHA/GITHUB_SHA)';
        process.stdout.write(`[trust-reconcile] stale bundle ignored — attests ${theirs}, this change is ${ours}\n`);
        bundlePath = null;
        bundleWasDiscardedAsStale = true;
      }
    }
  }

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
  } else if (isPostMergeEvent) {
    process.stdout.write('[trust-reconcile] no bundle present — push event (post-merge run): Step 1 still runs; Step 2/delivery-DECLARED enforcement does not apply here (ADR 0022 addendum, part 4)\n');
  } else {
    process.stdout.write('[trust-reconcile] no bundle present — bundle-required by default (ADR 0022 §1); Step 1 still runs, then checking delivery/DECLARED for a Step-2 exemption\n');
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
  } else if (isPostMergeEvent) {
    // Event-scoped enforcement (ADR 0022 addendum, part 4): bundle-required enforcement
    // (and delivery/DECLARED as its only exemption) exists to gate a PROPOSED change —
    // it applies on pull_request (and any other/unknown event, conservatively). A push
    // run on `main` happens AFTER the gating PR run already passed: branch protection
    // already excludes direct pushes from anyone but the merge machinery, so this run's
    // job is Step 1 fresh-verify (unconditional, already ran above) plus, IF the
    // just-merged bundle happens to still attest this exact commit, Step 2 reconcile as
    // the basis for Phase 2 attestation minting (handled by the `if (bundlePath)` branch
    // above when fresh — unaffected by this branch). A squash-merge commit on main almost
    // never has git ancestry back to the feature-branch commit a checkpoint was sealed
    // against (squash discards the original commit graph — see the staleness-check
    // addendum), so bundlePath being null here on push is the EXPECTED, common case, not
    // a divergence — reproduced empirically (synthetic squash pair) as a HIGH
    // launch-blocker: without this branch, EVERY delivery would falsely fail Trust
    // Reconcile on main immediately post-merge and Phase 2 attestation minting would stop
    // entirely. Requiring a delivery/DECLARED marker on every push to main would also be
    // nonsensical — there is no "change" being gated here to declare an exemption from.
    // This is a loud no-op: exit 0, no issue pushed.
    const detail = bundleWasDiscardedAsStale
      ? 'inherited bundle does not attest this commit'
      : 'no bundle to reconcile';
    process.stdout.write(`[trust-reconcile] push event: ${detail} — skipping Step 2 (gating happened on the PR run)\n`);
  } else {
    // Bundle absent (ADR 0022 §1) — either never discovered, or discovered-but-stale and
    // nulled out above. The ONLY exemption is a well-formed, in-scope delivery/DECLARED
    // marker, and it exempts Step 2 ONLY — Step 1 (fresh verify, above) already ran
    // unconditionally and was never skipped. Reuses the scopeCtx resolved above (same
    // context the staleness check already used).
    const exemption = resolveDeclaredExemption(resolvedRepoRoot, scopeCtx);
    if (exemption.exempt) {
      const { scope, reason, approved_by, declared_at } = exemption.marker;
      process.stdout.write(`[trust-reconcile] DECLARED (no-agent-delivery): ${scope} — ${reason} (approved by ${approved_by}, declared ${declared_at})\n`);
    } else {
      process.stderr.write(`[trust-reconcile] ${exemption.diagnostic}\n`);
      issues.push({
        type: 'bundle-required-no-declared-marker',
        message: exemption.diagnostic,
      });
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
