import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  loadKitObservabilityContribution,
  validateKitObservabilityRecord,
} from "../../build/src/index.js";
import { validateKitRepository, validateKitRepositoryDiagnostics } from "../../build/src/flow-kit/validate.js";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixtureRoot = path.join(root, "evals/fixtures/kit-observability");
const contributionSchema = json("schemas/kit-observability-contribution.schema.json");
const recordSchema = json("schemas/kit-observability-record.schema.json");

function json(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

function recordFor(contribution) {
  const projection = contribution.spec.projections[0];
  return {
    apiVersion: "flowagents.kontourai.io/v1alpha1",
    kind: "KitObservabilityRecord",
    metadata: { name: `${contribution.spec.kit.id}-run` },
    spec: {
      contribution: { kit_id: contribution.spec.kit.id, contract_version: "1.0" },
      projection,
      authority_refs: contribution.spec.authority_refs,
      data: { state: "observed" },
    },
  };
}

test("Builder and Knowledge opt in through the same public contribution interface", async () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validateContributionSchema = ajv.compile(contributionSchema);
  const validateRecordSchema = ajv.compile(recordSchema);
  for (const kit of ["builder", "knowledge"]) {
    const kitDir = path.join(root, "kits", kit);
    const loaded = loadKitObservabilityContribution(kitDir);
    assert.equal(loaded.status, "supported", JSON.stringify(loaded));
    assert.equal(loaded.contribution.spec.kit.id, kit);
    assert.equal(validateContributionSchema(loaded.contribution), true, JSON.stringify(validateContributionSchema.errors));
    const record = validateKitObservabilityRecord(recordFor(loaded.contribution), loaded.contribution);
    assert.deepEqual(record.spec.authority_refs, loaded.contribution.spec.authority_refs);
    assert.equal(validateRecordSchema(record), true, JSON.stringify(validateRecordSchema.errors));
    assert.deepEqual(await validateKitRepository(kitDir), []);
  }
});

test("a third-party Kit validates without a Kit-ID conditional or host installation", async () => {
  const kitDir = path.join(fixtureRoot, "third-party-kit");
  const loaded = loadKitObservabilityContribution(kitDir);
  assert.equal(loaded.status, "supported", JSON.stringify(loaded));
  assert.equal(loaded.contribution.spec.kit.id, "partner-review");
  assert.doesNotMatch(fs.readFileSync(path.join(root, "src", "kit-observability-contract.ts"), "utf8"), /partner-review/);
  assert.doesNotThrow(() => validateKitObservabilityRecord(recordFor(loaded.contribution), loaded.contribution));
  assert.deepEqual(await validateKitRepository(kitDir), []);
});

test("absent, invalid, and future contributions report typed diagnostics without blocking the Kit", async () => {
  const absent = loadKitObservabilityContribution(path.join(root, "kits", "release-evidence"));
  assert.deepEqual(absent, {
    status: "absent",
    diagnostics: [{ code: "contribution_absent", message: "Kit does not declare an observability contribution." }],
  });
  const futureDir = path.join(fixtureRoot, "future-version-kit");
  const future = loadKitObservabilityContribution(futureDir);
  assert.equal(future.status, "unsupported");
  assert.equal(future.diagnostics[0].code, "unsupported_contract_version");
  assert.match(future.diagnostics[0].message, /contract_version/);
  const diagnostics = await validateKitRepositoryDiagnostics(futureDir);
  assert.deepEqual(diagnostics.errors, []);
  assert.equal(diagnostics.warnings.length, 1);
  assert.match(diagnostics.warnings[0], /unsupported_contract_version/);
  assert.deepEqual(await validateKitRepository(futureDir), []);
});

test("a contribution record preserves authorities but cannot carry Flow gate or Surface claim authority", () => {
  const loaded = loadKitObservabilityContribution(path.join(root, "kits", "builder"));
  assert.equal(loaded.status, "supported");
  const record = recordFor(loaded.contribution);
  const validateRecordSchema = new Ajv2020({ strict: false, allErrors: true }).compile(recordSchema);
  record.spec.data = { gate: { status: "passed" } };
  assert.throws(
    () => validateKitObservabilityRecord(record, loaded.contribution),
    /cannot contain Flow gate or Surface claim authority/,
  );
  assert.equal(validateRecordSchema(record), false, "the published schema must reject gate authority too");
  record.spec.data = { claim: { status: "trusted" } };
  assert.throws(
    () => validateKitObservabilityRecord(record, loaded.contribution),
    /cannot contain Flow gate or Surface claim authority/,
  );
  assert.equal(validateRecordSchema(record), false, "the published schema must reject claim authority too");
  record.spec.data = { domain: { gate: "boarding", claim: "claim-number" } };
  assert.doesNotThrow(() => validateKitObservabilityRecord(record, loaded.contribution));
  assert.equal(validateRecordSchema(record), true, "opaque nested domain data must remain Kit-owned");
});
