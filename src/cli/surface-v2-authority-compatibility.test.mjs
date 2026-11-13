// Offline controls for the historical-v2 consumer fence. No provider
// or live gate is called; Flow normalization below is its pure public reducer.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as surface from "@kontourai/surface";
import * as legacy from "@kontourai/surface-legacy";
import { normalizeTrustBundle } from "@kontourai/flow";
import { buildTrustBundle } from "../../build/src/cli/workflow-sidecar.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const require = createRequire(import.meta.url);
const { statusFunctionVersionForBundle } = require("../../scripts/lib/status-function-version.js");
const ROOT = path.resolve(import.meta.dirname, "../..");
const AMBIGUOUS = /historical statusFunctionVersion "2" authority-time ordering is ambiguous/;
const AT = "2026-01-01T00:00:01Z";

async function resolutionBundle(bound = {}) {
  const bundle = await buildTrustBundle("authority-time-fixture", "2026-01-01T00:00:00Z",
    [{ id: "failed-check", kind: "test", status: "fail", summary: "Older blocking failure" }], [], []);
  assert.ok(bundle);
  assert.equal(bundle.claims.length, 1);
  const claim = bundle.claims[0];
  claim.status = "verified";
  bundle.source = "fixture;statusFunctionVersion=2";
  bundle.events = [{ id: "resolution", claimId: claim.id, status: "verified", actor: "fixture-owner", method: "attestation",
    evidenceIds: bundle.evidence.map((item) => item.id), createdAt: AT, resolvesDispute: true, authorityRef: "fixture-authority" }];
  bundle.authorityTrace = [{ id: "trace", subject: { subjectType: claim.subjectType, subjectId: claim.subjectId },
    actorRef: "fixture-owner", authorityType: "system", authorityRef: "fixture-authority", sourceRef: "fixture",
    observedAt: "2026-01-01T00:00:00Z", claimIds: [claim.id], ...bound }];
  return bundle;
}

function scalar(bundle) {
  const dir = makeFixtureDir("surface-v2-authority-");
  const file = path.join(dir, "trust.bundle");
  fs.writeFileSync(file, JSON.stringify(bundle));
  const derived = spawnSync(process.execPath, [path.join(ROOT, "scripts/ci/derive-claim-status.mjs"), file], { encoding: "utf8" });
  assert.equal(derived.status, 0, `${derived.stdout}\n${derived.stderr}`);
  return { dir, statuses: JSON.parse(derived.stdout), stderr: derived.stderr };
}

for (const [name, bounds] of [
  ["offset revocation", { revokedAt: "2026-01-01T01:00:01+01:00" }],
  ["offset validFrom", { validFrom: "2026-01-01T01:00:01+01:00" }],
  ["offset validUntil", { validUntil: "2025-12-31T23:00:01-01:00" }],
  ["fractional spelling", { validUntil: "2026-01-01T00:00:01.000Z" }],
]) {
  test(`valid ${name} survives public validation but is refused by historical consumers`, async () => {
    const bundle = await resolutionBundle(bounds);
    const before = JSON.stringify(bundle);
    assert.doesNotThrow(() => legacy.validateTrustBundle(bundle, { statusFunctionVersion: "2" }));
    assert.doesNotThrow(() => surface.validateTrustBundle(bundle, { statusFunctionVersion: "2" }));
    const normalized = normalizeTrustBundle(bundle);
    assert.deepEqual(normalized.bundle, bundle, "Flow admission preserves timestamp spelling in the snapshot");
    const args = { claim: bundle.claims[0], evidence: bundle.evidence, policies: bundle.policies, events: bundle.events,
      authorityTrace: bundle.authorityTrace, statusFunctionVersion: "2" };
    assert.notEqual(legacy.deriveClaimStatus(args).status, surface.deriveClaimStatus(args).status,
      "the real published evaluators must expose the negative control");
    assert.throws(() => statusFunctionVersionForBundle(bundle, surface), AMBIGUOUS);
    assert.equal(JSON.stringify(bundle), before, "selection must preserve the historical bytes");
    const result = scalar(bundle);
    assert.ok(Object.values(result.statuses).length > 0);
    assert.ok(Object.values(result.statuses).every((value) => value === null));
    assert.match(result.stderr, AMBIGUOUS);
    const explained = spawnSync(process.execPath, [path.join(ROOT, "build/src/cli/workflow-sidecar.js"), "claim", bundle.claims[0].id, result.dir, "--json"], { encoding: "utf8" });
    assert.equal(explained.status, 1, explained.stderr);
    assert.equal(explained.stdout, "");
    assert.match(explained.stderr, AMBIGUOUS);
  });
}

test("unambiguous offsets remain selectable without expanding scalar authority admission", async () => {
  const bundle = await resolutionBundle({ validFrom: "2025-12-31T12:00:00-01:00", validUntil: "2026-01-01T02:00:00+01:00" });
  assert.deepEqual(statusFunctionVersionForBundle(bundle, surface), { version: "2", stamped: true });
  const result = scalar(bundle);
  const noAuthority = structuredClone(bundle);
  delete noAuthority.authorityTrace;
  assert.deepEqual(result.statuses, scalar(noAuthority).statuses, "the scalar consumer still omits authorityTrace");
  assert.equal(result.statuses[bundle.claims[0].id], "disputed", "selection must not newly authorize a scalar resolution");
  assert.equal(result.stderr, "");
  const refused = await resolutionBundle({ revokedAt: "2026-01-01T00:00:00Z" });
  assert.deepEqual(statusFunctionVersionForBundle(refused, surface), { version: "2", stamped: true });
  assert.equal(scalar(refused).statuses[refused.claims[0].id], "disputed", "both algorithms deny revoked authority");
});

test("an irrelevant trace or non-resolution event does not create a timestamp-wide ban", async () => {
  const bundle = await resolutionBundle({ revokedAt: "2026-01-01T01:00:01+01:00" });
  bundle.authorityTrace[0].authorityRef = "other-fixture-authority";
  assert.deepEqual(statusFunctionVersionForBundle(bundle, surface), { version: "2", stamped: true });
  bundle.authorityTrace[0].authorityRef = "fixture-authority";
  bundle.authorityTrace[0].actorRef = "other-fixture-owner";
  assert.deepEqual(statusFunctionVersionForBundle(bundle, surface), { version: "2", stamped: true });
  bundle.authorityTrace[0].actorRef = "fixture-owner";
  delete bundle.events[0].resolvesDispute;
  assert.deepEqual(statusFunctionVersionForBundle(bundle, surface), { version: "2", stamped: true });
});

test("a stable alternative trace preserves the same authorization union", async () => {
  const bundle = await resolutionBundle({ revokedAt: "2026-01-01T01:00:01+01:00" });
  const stable = { ...bundle.authorityTrace[0], id: "stable" };
  delete stable.revokedAt;
  bundle.authorityTrace.push(stable);
  assert.deepEqual(statusFunctionVersionForBundle(bundle, surface), { version: "2", stamped: true });
  assert.equal(scalar(bundle).statuses[bundle.claims[0].id], "disputed", "the scalar authority boundary remains unchanged");
});

test("unevaluable relevant authority is refused without changing v3/v4 or new-writer selection", async () => {
  const bundle = await resolutionBundle({ validUntil: "not-a-timestamp" });
  assert.throws(() => statusFunctionVersionForBundle(bundle, surface), AMBIGUOUS);
  assert.throws(() => normalizeTrustBundle(bundle), /schema|validation|date-time/);
  assert.ok(Object.values(scalar(bundle).statuses).every((value) => value === null));
  bundle.source = "fixture;statusFunctionVersion=1";
  assert.throws(() => statusFunctionVersionForBundle(bundle, surface), AMBIGUOUS, "the exact v1-to-v2 fallback must cross the same fence");
  for (const version of ["3", "4"]) {
    bundle.source = `fixture;statusFunctionVersion=${version}`;
    assert.deepEqual(statusFunctionVersionForBundle(bundle, surface), { version, stamped: true });
    assert.equal(scalar(bundle).statuses[bundle.claims[0].id], "disputed", "this patch adds no scalar authority admission or validation on other versions");
  }
  assert.deepEqual(statusFunctionVersionForBundle({ ...bundle, source: "unstamped" }, surface), { version: "4", stamped: false });
});


test("no-authority evidence retains its existing scalar outcomes on each supported version", async () => {
  for (const passing of [false, true]) {
    const bundle = await buildTrustBundle("no-authority-fixture", "2026-01-01T00:00:00Z",
      [{ id: "check", kind: "test", status: passing ? "pass" : "fail", summary: "Recorded fixture result" }], [], []);
    assert.ok(bundle);
    assert.equal(bundle.authorityTrace, undefined);
    for (const version of ["2", "3", "4"]) {
      bundle.source = `fixture;statusFunctionVersion=${version}`;
      assert.deepEqual(statusFunctionVersionForBundle(bundle, surface), { version, stamped: true });
      const result = scalar(bundle);
      assert.equal(result.statuses[bundle.claims[0].id], passing ? "verified" : "disputed");
      assert.equal(result.stderr, "");
    }
  }
});

test("claim, actor and optional authority reference relevance follows the actual evaluator", async () => {
  const bundle = await resolutionBundle({ revokedAt: "2026-01-01T01:00:01+01:00" });
  const claimId = bundle.claims[0].id;
  bundle.events[0].claimId = "absent-claim";
  assert.deepEqual(statusFunctionVersionForBundle(bundle, surface), { version: "2", stamped: true }, "an event for no evaluated claim is irrelevant");
  bundle.events[0].claimId = claimId;
  bundle.authorityTrace[0].authorityRef = "other-fixture-authority";
  assert.deepEqual(statusFunctionVersionForBundle(bundle, surface), { version: "2", stamped: true });
  delete bundle.events[0].authorityRef;
  assert.throws(() => statusFunctionVersionForBundle(bundle, surface), AMBIGUOUS, "an omitted event authorityRef does not require a matching ref");
  bundle.events[0].authorityRef = bundle.authorityTrace[0].authorityRef;
  const second = { ...bundle.claims[0], id: `${claimId}-other`, subjectId: "other-subject" };
  bundle.claims.push(second);
  bundle.authorityTrace[0].claimIds = [second.id];
  bundle.authorityTrace[0].subject = { subjectType: second.subjectType, subjectId: second.subjectId };
  assert.throws(() => statusFunctionVersionForBundle(bundle, surface), AMBIGUOUS, "the published resolution predicate does not filter traces by subject or claimIds");
  // The raw scalar reader does not validate schema before selecting a version.
  // Mirror the evaluator's strict identity comparison even for a raw numeric id;
  // this asserts refusal, never admission of malformed public bundle shapes.
  bundle.claims = [{ ...bundle.claims[0], id: 7 }];
  bundle.events[0].claimId = 7;
  assert.throws(() => statusFunctionVersionForBundle(bundle, surface), AMBIGUOUS);
});
