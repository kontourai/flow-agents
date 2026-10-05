'use strict';
// status-function-version.js — which Surface status function re-derives a PERSISTED trust.bundle.
//
// The flow-agents writer stamps the status function version it derived every claim with into the
// bundle's `source` ("flow-agents/workflow-sidecar;statusFunctionVersion=2"), and has done so since
// the first trust.bundle writer. Surface 5 changed the default status function from "2" to "3"
// (omission fails closed) and keeps "2" selectable so a record resolved under it can be re-derived
// as it was. A reader that re-derives a stored bundle (the CI reconciler, `workflow-sidecar claim`)
// must use the stamped version, or every committed delivery re-derives differently and the
// reconciler reports a status-misassertion against a bundle that was honest when it was written.
//
// Decisions (#1422):
//   - A bundle with NO stamp derives under the installed Surface's current (default) version. No
//     flow-agents writer has ever emitted an unstamped bundle, so an unstamped bundle came from
//     another producer or was edited; the current version is the strictest one Surface offers, and
//     leaving the stamp out must never buy the more lenient rules.
//   - A stamp the installed Surface cannot evaluate (for example "3" on a Surface that only
//     implements "2") is refused, not mapped to a neighbouring version: a status derived with an
//     algorithm the producer did not use is not that bundle's status.
//   - One exception, because it is exact: status function "1" (Surface < 1.2.0, which the first
//     writers stamped for about a day in June 2026) differs from "2" in three inputs only -- an
//     event with status `revoked` (terminal as-is under "1", `stale` under "2"), an event of type
//     `invalidation` (ignored under "1"), and a claim-intrinsic validity window `expiresAt` /
//     `ttlSeconds` (ignored under "1"). Compared on the Surface 1.1.0 and 1.2.0 sources: the change
//     to `deriveTrustStatus` is exactly those three, and policy resolution is unchanged. A "1"
//     bundle that carries none of them derives identically under "2", so it is re-derived under
//     "2"; one that carries any of them is refused like any other unsupported stamp.
//   - A malformed stamp (empty value, or the key repeated) is refused.
//
// Accepted residual: the stamp is producer-written, so any bundle can claim "2". That is inherent
// to honouring stamps at all -- installed writers on Surface 2.x keep producing honest "2" bundles
// after this repo moves -- and is recorded on #1422 rather than papered over here.
//
// Pure CommonJS with no dependencies, so the composite trust-verify action (which installs with
// --ignore-scripts and never builds) and the compiled sidecar load the same file.

const STAMP_KEY = 'statusFunctionVersion';

/**
 * The status function version stamped in a bundle's `source`, or null when it carries none.
 * Throws on a malformed stamp.
 */
function stampedStatusFunctionVersion(bundle) {
  const source = bundle && typeof bundle === 'object' ? bundle.source : undefined;
  if (typeof source !== 'string') return null;
  const values = source
    .split(';')
    .map((segment) => segment.trim())
    .filter((segment) => segment.startsWith(`${STAMP_KEY}=`))
    .map((segment) => segment.slice(STAMP_KEY.length + 1));
  if (values.length === 0) return null;
  if (values.length > 1) throw new Error(`trust.bundle source stamps ${STAMP_KEY} ${values.length} times: ${JSON.stringify(source)}`);
  if (values[0].length === 0) throw new Error(`trust.bundle source has an empty ${STAMP_KEY} stamp: ${JSON.stringify(source)}`);
  return values[0];
}

/**
 * The inputs on which status function "1" and "2" disagree, found in `bundle`, as human-readable
 * reasons. Empty means "2" derives every claim of the bundle exactly as "1" did.
 */
function statusFunctionV1Divergences(bundle) {
  const reasons = [];
  const events = Array.isArray(bundle && bundle.events) ? bundle.events : [];
  const claims = Array.isArray(bundle && bundle.claims) ? bundle.claims : [];
  if (events.some((event) => event && event.status === 'revoked')) reasons.push('an event with status "revoked"');
  if (events.some((event) => event && event.type === 'invalidation')) reasons.push('an invalidation event');
  if (claims.some((claim) => claim && (claim.expiresAt !== undefined || claim.ttlSeconds !== undefined))) reasons.push('a claim with expiresAt/ttlSeconds');
  return reasons;
}

/** Versions the loaded Surface module can evaluate. Surface < 5 exposes only its single version. */
function supportedStatusFunctionVersions(surface) {
  if (Array.isArray(surface.supportedStatusFunctionVersions)) return surface.supportedStatusFunctionVersions.map(String);
  return typeof surface.statusFunctionVersion === 'string' ? [surface.statusFunctionVersion] : [];
}

/**
 * The version to re-derive `bundle` with on the loaded Surface module.
 * @returns {{ version: string, stamped: boolean }}
 */
function statusFunctionVersionForBundle(bundle, surface) {
  const supported = supportedStatusFunctionVersions(surface);
  const current = typeof surface.statusFunctionVersion === 'string' ? surface.statusFunctionVersion : null;
  if (!current || !supported.includes(current)) throw new Error('the loaded @kontourai/surface does not declare a status function version it supports');
  const stamped = stampedStatusFunctionVersion(bundle);
  if (stamped === null) return { version: current, stamped: false };
  if (stamped === '1' && !supported.includes('1') && supported.includes('2')) {
    const divergences = statusFunctionV1Divergences(bundle);
    if (divergences.length === 0) return { version: '2', stamped: true };
    throw new Error(`trust.bundle was derived with ${STAMP_KEY} "1" and carries ${divergences.join(', ')}, on which status function "2" derives differently; the installed @kontourai/surface cannot evaluate "1" (supported: ${supported.join(', ')}), so refusing to re-derive it`);
  }
  if (!supported.includes(stamped)) {
    throw new Error(`trust.bundle was derived with ${STAMP_KEY} ${JSON.stringify(stamped)}, which the installed @kontourai/surface cannot evaluate (supported: ${supported.join(', ')}); refusing to re-derive it with a different status function`);
  }
  return { version: stamped, stamped: true };
}

module.exports = { stampedStatusFunctionVersion, supportedStatusFunctionVersions, statusFunctionV1Divergences, statusFunctionVersionForBundle };
