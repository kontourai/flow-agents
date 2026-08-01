import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  loadKitObservabilityContribution,
  negotiateKitObservabilityContribution,
  validateKitObservabilityContribution,
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
  const [kind] = Object.keys(contribution.spec.projections);
  return {
    apiVersion: "flowagents.kontourai.io/v1alpha1",
    kind: "KitObservabilityRecord",
    metadata: { name: `${contribution.metadata.name}-run` },
    spec: {
      contribution_ref: contribution.metadata.name,
      projection: { kind },
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
    assert.equal(loaded.contribution.metadata.name, kit);
    assert.equal(validateContributionSchema(loaded.contribution), true, JSON.stringify(validateContributionSchema.errors));
    const record = validateKitObservabilityRecord(recordFor(loaded.contribution), loaded.contribution);
    assert.equal(record.spec.contribution_ref, loaded.contribution.metadata.name);
    assert.equal(validateRecordSchema(record), true, JSON.stringify(validateRecordSchema.errors));
    assert.deepEqual(await validateKitRepository(kitDir), []);
  }
});

test("a third-party Kit validates without a Kit-ID conditional or host installation", async () => {
  const kitDir = path.join(fixtureRoot, "third-party-kit");
  const loaded = loadKitObservabilityContribution(kitDir);
  assert.equal(loaded.status, "supported", JSON.stringify(loaded));
  assert.equal(loaded.contribution.metadata.name, "partner-review");
  assert.doesNotMatch(fs.readFileSync(path.join(root, "src", "kit-observability-contract.ts"), "utf8"), /partner-review/);
  assert.doesNotThrow(() => validateKitObservabilityRecord(recordFor(loaded.contribution), loaded.contribution));
  assert.deepEqual(await validateKitRepository(kitDir), []);
});

test("absent, invalid, and future contributions report typed diagnostics without blocking the Kit", async () => {
  const absent = loadKitObservabilityContribution(path.join(root, "kits", "release-evidence"));
  assert.deepEqual(absent, { status: "absent", diagnostics: [{ code: "contribution_absent", message: "Kit does not declare an observability contribution." }] });
  const futureDir = path.join(fixtureRoot, "future-version-kit");
  const future = loadKitObservabilityContribution(futureDir);
  assert.equal(future.status, "unsupported");
  assert.equal(future.diagnostics[0].code, "unsupported_contract_version");
  assert.match(future.diagnostics[0].message, /contract_version/);
  const futureNegotiation = negotiateKitObservabilityContribution(future, json("evals/fixtures/kit-observability/host-states.json").mcp_apps_full);
  assert.equal(futureNegotiation.status, "incompatible");
  assert.equal(futureNegotiation.diagnostics[0].code, "unsupported_contract_version");
  const diagnostics = await validateKitRepositoryDiagnostics(futureDir);
  assert.deepEqual(diagnostics.errors, []);
  assert.equal(diagnostics.warnings.length, 1);
  assert.match(diagnostics.warnings[0], /unsupported_contract_version/);
  assert.deepEqual(await validateKitRepository(futureDir), []);
});

test("host lifecycle and capabilities negotiate presentation without blocking the Kit", () => {
  const loaded = loadKitObservabilityContribution(path.join(root, "kits", "builder"));
  assert.equal(loaded.status, "supported");
  const states = json("evals/fixtures/kit-observability/host-states.json");
  const disabled = negotiateKitObservabilityContribution(loaded, states.disabled);
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.diagnostics[0].code, "contribution_disabled");
  const uninstalled = negotiateKitObservabilityContribution(loaded, states.not_installed);
  assert.equal(uninstalled.status, "disabled");
  assert.equal(uninstalled.diagnostics[0].code, "contribution_not_installed");
  const standard = negotiateKitObservabilityContribution(loaded, states.standard_views_only);
  assert.equal(standard.status, "enabled");
  assert.equal(standard.presentation, "standard_views");
  assert.equal(standard.available_operator_intents.length, 0);
  assert.ok(standard.diagnostics.some(({ code }) => code === "optional_host_capability_unavailable"));
  assert.ok(standard.diagnostics.some(({ code }) => code === "operator_intent_capability_unavailable"));
  const mcp = negotiateKitObservabilityContribution(loaded, states.mcp_apps_full);
  assert.equal(mcp.status, "enabled");
  assert.equal(mcp.presentation, "mcp_apps_resource_bridge");
  assert.equal(mcp.available_operator_intents.length, 3);
  assert.deepEqual(mcp.diagnostics, []);
  const missingRequired = negotiateKitObservabilityContribution(loaded, states.missing_standard_views);
  assert.equal(missingRequired.status, "incompatible");
  assert.equal(missingRequired.diagnostics[0].code, "required_host_capability_missing");
  const incompatibleVersion = negotiateKitObservabilityContribution(loaded, states.unsupported_contract_version);
  assert.equal(incompatibleVersion.status, "incompatible");
  assert.equal(incompatibleVersion.diagnostics[0].code, "host_contract_version_unsupported");
});

test("published JSON schemas and typed validators reject the same local descriptor faults", () => {
  const loaded = loadKitObservabilityContribution(path.join(root, "kits", "builder"));
  assert.equal(loaded.status, "supported");
  const validateContributionSchema = new Ajv2020({ strict: false, allErrors: true }).compile(contributionSchema);
  assert.equal(validateContributionSchema(loaded.contribution), true, JSON.stringify(validateContributionSchema.errors));
  const faults = [
    (value) => { value.spec.views = []; },
    (value) => { delete value.spec.projections.run_summary.schema_ref; },
    (value) => { value.spec.host.presentation.fallback = "direct_provider_command"; },
    (value) => { value.spec.operator_intents[0].required_capability = "provider.execute"; },
    (value) => { value.spec.operator_intents[0].ref = "provider://mutation"; },
  ];
  for (const fault of faults) {
    const candidate = structuredClone(loaded.contribution);
    fault(candidate);
    assert.throws(() => validateKitObservabilityContribution(candidate));
    assert.equal(validateContributionSchema(candidate), false, JSON.stringify(validateContributionSchema.errors));
  }
});

test("a contribution record preserves a semantic descriptor link but cannot carry Flow gate or Surface claim authority", () => {
  const loaded = loadKitObservabilityContribution(path.join(root, "kits", "builder"));
  assert.equal(loaded.status, "supported");
  const record = recordFor(loaded.contribution);
  const validateRecordSchema = new Ajv2020({ strict: false, allErrors: true }).compile(recordSchema);
  record.spec.data = { gate: { status: "passed" } };
  assert.throws(() => validateKitObservabilityRecord(record, loaded.contribution), /cannot contain Flow gate or Surface claim authority/);
  assert.equal(validateRecordSchema(record), false, "the published schema must reject gate authority too");
  record.spec.data = { claim: { status: "trusted" } };
  assert.throws(() => validateKitObservabilityRecord(record, loaded.contribution), /cannot contain Flow gate or Surface claim authority/);
  assert.equal(validateRecordSchema(record), false, "the published schema must reject claim authority too");
  record.spec.data = { domain: { gate: "boarding", claim: "claim-number" } };
  assert.doesNotThrow(() => validateKitObservabilityRecord(record, loaded.contribution));
  assert.equal(validateRecordSchema(record), true, "opaque nested domain data must remain Kit-owned");
  record.spec.contribution_ref = "another-kit";
  assert.throws(() => validateKitObservabilityRecord(record, loaded.contribution), /does not match the descriptor/);
  assert.equal(validateRecordSchema(record), true, "descriptor linkage is documented semantic validation, not a duplicated schema field");
});

test("a symlinked descriptor cannot escape the Kit root", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kit-observability-symlink-"));
  try {
    const kitDir = path.join(tempRoot, "kit");
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(kitDir);
    fs.mkdirSync(outsideDir);
    fs.copyFileSync(path.join(fixtureRoot, "symlink-escape-kit", "kit.json"), path.join(kitDir, "kit.json"));
    fs.copyFileSync(path.join(root, "kits", "builder", "kit-observability.contribution.json"), path.join(outsideDir, "descriptor.json"));
    fs.symlinkSync(path.join(outsideDir, "descriptor.json"), path.join(kitDir, "descriptor-link.json"));
    const result = loadKitObservabilityContribution(kitDir);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics[0].code, "invalid_contribution");
    assert.match(result.diagnostics[0].message, /escapes the Kit through a symlink/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
