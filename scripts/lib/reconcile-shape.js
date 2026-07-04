'use strict';
//
// Shared bundle-shape classification/divergence-construction, extracted from
// scripts/ci/trust-reconcile.js so a local, pre-push preflight (issue #356) can reuse
// EXACTLY the same shape checks CI enforces, rather than risk a forked copy that
// silently drifts from what trust-reconcile.js actually does (the historical failure
// mode this module exists to close off — see command-log-chain.js for the identical
// rationale applied to the hash-chain/laundering primitives).
//
// This module is SHAPE-only: it classifies a bundle's own claims/evidence and builds
// the `issues[]` entries that do not require a fresh CI command re-run (no `runCommand`,
// no manifest command execution). The ACTUAL fresh-run comparison for reconcilable
// command claims (`ciResult.passed`) stays in trust-reconcile.js, since that requires a
// live CI/local command execution a local preflight must not perform.
//
// trust-reconcile.js requires this module instead of defining these functions inline —
// see its own comments at the require() site and the (former) location of
// classifyBundleClaims for the extraction history.

// hasLaunderingOperator is imported (not re-implemented) so this module and
// scripts/ci/trust-reconcile.js apply the identical exit-code-mask heuristic.
const { hasLaunderingOperator } = require('./command-log-chain.js');

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

/** Normalize a command string: collapse whitespace, trim. (Mirrors trust-reconcile.js's own.) */
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

// ---------------------------------------------------------------------------
// Pure shape-level divergence ("issue") construction.
//
// Each function below takes already-computed classification inputs (the buckets
// classifyBundleClaims returns, plus a resolved manifest / derived-status map) and
// returns an issues[] array structurally IDENTICAL in shape (`{ type, cmd?, message }`)
// to what trust-reconcile.js's Step 2 block pushes inline. None of these functions
// execute a command or otherwise perform a fresh CI run — they are pure, local, and fast.
// ---------------------------------------------------------------------------

/**
 * finding 4 (server-side): a command-backed (test_output-evidence) claim carrying a
 * waiver is a divergence — a command-backed check reconciles against CI or fails; it
 * cannot be waived away.
 */
function waiverOnCommandIssues(waiverOnCommand) {
  const issues = [];
  for (const { claimId, claimType, subject } of waiverOnCommand || []) {
    issues.push({
      type: 'waiver-on-command-check',
      message: `trust divergence: claim '${claimId}' (${subject}, claimType: ${claimType}) carries a waiver but is backed by test_output evidence — a command-backed check reconciles against CI or fails and cannot be waived`,
    });
  }
  return issues;
}

/**
 * not-run divergences: never-captured command claims (no evidence) AND test_output
 * claims that did not reconcile (no manifest-matchable execution.label).
 */
function noEvidenceCommandIssues(noEvidenceCommand) {
  const issues = [];
  for (const { cmd, claimId, claimType, reason } of noEvidenceCommand || []) {
    const message = reason === 'test_output-unreconciled'
      ? `trust divergence: claim '${claimId}' (claimType: ${claimType}) asserts pass with test_output evidence but has no manifest-matched execution.label — a test_output claim must reconcile against the manifest or it is a divergence (never accepted as session-local)`
      : `trust divergence: claim '${claimId}' (claimType: ${claimType}) asserts pass but has no supporting evidence item — command never captured`;
    issues.push({ type: 'not-run', cmd, message });
  }
  return issues;
}

/**
 * Manifest-membership subset of the `reconcilable` loop: ONLY the "not in the reconcile
 * manifest" `not-run` case, plus the laundering check (via the shared hasLaunderingOperator).
 * The ACTUAL fresh-run comparison (`ciResult.passed`) is NOT here — it requires a live CI/
 * local command execution the preflight must not perform, and stays in trust-reconcile.js.
 *
 * Returns { issues, unresolved } where `unresolved` is the subset of `reconcilable` entries
 * that passed the laundering + manifest-membership checks and therefore DO require a fresh
 * CI run to fully reconcile — callers that need full parity (trust-reconcile.js) continue
 * from there; callers that are shape-only (the local preflight) simply do not resolve them
 * further and treat "manifest-matched, not laundered" as shape-clean.
 */
function reconcilableManifestIssues(reconcilable, manifestByCmd) {
  const issues = [];
  const unresolved = [];
  for (const entry of reconcilable || []) {
    const { cmd } = entry;
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
    const manifestEntry = manifestByCmd.get(normalCmd);
    if (!manifestEntry) {
      issues.push({
        type: 'not-run',
        cmd,
        message: `trust divergence: agent claimed '${cmd}' passed; command is not in the reconcile manifest — a test_output claim must name a manifest/required-lane command (CI cannot self-declare an arbitrary command)`,
      });
      continue;
    }

    unresolved.push({ ...entry, manifestEntry });
  }
  return { issues, unresolved };
}

/**
 * Session-local claims: not CI-reconcilable, but NOT a pass bypass. Each must either
 * (a) carry a loud, justified waiver, or (b) resolve a real CI-RE-DERIVED `verified`
 * status. WS8 iteration-2 hardening:
 *   - finding 3: the status used here is RE-DERIVED CI-side, never the self-reported
 *     claim.status. A mismatch is a `status-misassertion` divergence.
 *   - finding 2: `assumed` alone is NO LONGER a silent pass. `assumed` is acceptable
 *     ONLY with a waiver (printed as a loud WAIVED line by the caller). An unwaived
 *     `assumed` claim is an `unwaived-assumed` divergence (restores pre-WS8 semantics
 *     where `assumed` alone never satisfied assertsPass).
 *
 * Q1/iteration-1-F1 (extraction-granularity + caller-controlled mode): `derivedStatus` is a
 * `Map<string,string|null>|null` — the SAME value trust-reconcile.js's `deriveClaimStatuses()`
 * produces (shells out to derive-claim-status.mjs, local-only, no CI command execution).
 * `opts.onUnderivable` makes the `derivedStatus === null` behavior an EXPLICIT caller choice —
 * there is no silent default that fails open:
 *   - `'fail'` (DEFAULT — the safe/original CI behavior; a caller that forgets `opts` never
 *     fails open): when `derivedStatus` is null, EVERY session-local pass-asserting claim
 *     becomes a `status-underivable` divergence (verbatim pre-#356 message + `continue`) —
 *     we never fall back to trusting the bundle's own status. `scripts/ci/trust-reconcile.js`
 *     MUST use this mode; it is CI's trust anchor.
 *   - `'reduce'` (LOCAL-PREFLIGHT-ONLY opt-in): when `derivedStatus` is null, DEGRADE to a
 *     documented reduced-coverage mode — status-misassertion/status-underivable checks are
 *     skipped entirely (nothing to re-derive against), but the waiver/unwaived-assumed/
 *     session-local-failed/unwaived-session-local checks still run against the claim's own
 *     self-reported `assertedStatus`. Only `src/cli/workflow-sidecar.ts`'s local
 *     `runReconcilePreflight` opts into this (and surfaces the reduced coverage to the user via
 *     a warning) — CI must never reach this branch.
 * When `derivedStatus` is non-null, both modes behave identically (full parity with CI).
 *
 * Returns { issues, attestedCount, logEvents } — attestedCount mirrors trust-reconcile.js's
 * own "N attested claim(s) accepted without independent verification" summary line;
 * logEvents is the ordered list of WAIVED/ATTESTED terminal classifications (F3, iteration-1)
 * so a caller's stdout narrative (e.g. trust-reconcile.js's WAIVED/ATTESTED log lines) is
 * driven by this single classification instead of a parallel re-derivation.
 */
function sessionLocalShapeIssues(sessionLocal, derivedStatus, opts) {
  const onUnderivable = (opts && opts.onUnderivable) || 'fail';
  const issues = [];
  let attestedCount = 0;
  // F3 (iteration-1): single source of truth for the WAIVED/ATTESTED classification, so
  // trust-reconcile.js's stdout narrative loop consumes this instead of re-deriving its own
  // (previously parallel, driftable) copy. Only populated when a claim reaches the WAIVED or
  // ATTESTED terminal below (never for issues) — callers that don't log can ignore it.
  const logEvents = [];

  for (const { claimId, claimType, assertedStatus, waiver, subject, evidenceType } of sessionLocal || []) {
    let status;
    if (derivedStatus) {
      // finding 3: re-derive; never trust the asserted status.
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
    } else if (onUnderivable === 'reduce') {
      // Reduced-coverage mode (derivedStatus === null, explicit local-preflight opt-in): trust
      // the self-reported status for the remaining shape checks only. status-misassertion/
      // status-underivable are, by definition, not checkable without a derivation source —
      // documented gap, not a bug.
      status = assertedStatus;
    } else {
      // Fail-closed mode (default; CI): restores the pre-#356 inline behavior verbatim — we
      // never fall back to trusting a self-reported status.
      issues.push({
        type: 'status-underivable',
        message: `trust divergence: session-local claim '${claimId}' (claimType: ${claimType}) asserts status '${assertedStatus || 'unknown'}' but CI-side re-derivation is unavailable — refusing to trust a self-reported status (fail-closed)`,
      });
      continue;
    }

    if (status === 'disputed' || status === 'rejected') {
      issues.push({
        type: 'session-local-failed',
        message: `trust divergence: session-local claim '${claimId}' (claimType: ${claimType}) has re-derived status '${status}' — a failing/rejected claim blocks (session-local classification is not a pass bypass)`,
      });
      continue;
    }
    // finding 2: a waiver is the ONLY way an `assumed` (or otherwise non-`verified`)
    // session-local claim passes. `verified` still passes on its own re-derived status.
    if (waiver && waiver.reason && waiver.approved_by) {
      logEvents.push({ kind: 'waived', claimId, claimType, subject, evidenceType, status, waiver });
      continue; // WAIVED — caller may log this loudly; not an issue.
    }
    if (status === 'verified') {
      attestedCount++;
      logEvents.push({ kind: 'attested', claimId, claimType, subject, evidenceType, status });
      continue; // ATTESTED (not independently verifiable at L0) — caller may log; not an issue.
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

  return { issues, attestedCount, logEvents };
}

module.exports = {
  classifyBundleClaims,
  normalizeCmd,
  isPassingValue,
  waiverOnCommandIssues,
  noEvidenceCommandIssues,
  reconcilableManifestIssues,
  sessionLocalShapeIssues,
};
