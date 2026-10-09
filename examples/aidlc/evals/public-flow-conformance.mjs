import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRun, attachEvidence, evaluateRun, runDir } from "@kontourai/flow";
import { validateTrustBundle, buildTrustReport } from "@kontourai/surface";

async function packageVersion(name) {
  let directory = path.dirname(fileURLToPath(import.meta.resolve(name)));
  for (let depth = 0; depth < 6; depth++) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
      if (manifest.name === name) return manifest.version;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot locate installed package version: ${name}`);
}

// This suite exercises public package contracts with deliberately synthetic evidence.
// It does not execute a model, authenticate a human approval, or assess design quality.
export async function runPublicFlowConformance() {
  const package_versions = {
    "@kontourai/flow": await packageVersion("@kontourai/flow"),
    "@kontourai/surface": await packageVersion("@kontourai/surface"),
  };
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aidlc-public-conformance-"));
  const now = new Date().toISOString();
  const observedAt = new Date(Date.parse(now) - 1000).toISOString();
  const currentSubject = "synthetic-artifact:sha256:current";
  const definition = {
    id: "aidlc.public-contract-fixture", version: "1",
    steps: [{ id: "check", next: null }],
    gates: {
      "check-gate": {
        step: "check",
        expects: [{
          id: "artifact-check", kind: "trust.bundle", required: true,
          description: "The synthetic artifact check is verified for the selected revision.",
          bundle_claim: {
            claimType: "aidlc.fixture.check", subjectType: "artifact",
            subjectId: currentSubject, accepted_statuses: ["verified"],
          },
        }],
      },
    },
  };
  function bundle({ passing = true, stale = false, subject = currentSubject } = {}) {
    return {
      schemaVersion: 5, source: "aidlc/synthetic-public-contract-fixtures;statusFunctionVersion=3",
      claims: [{
        id: "claim", subjectType: "artifact", subjectId: subject, facet: "quality",
        claimType: "aidlc.fixture.check", fieldOrBehavior: "Synthetic artifact check passes",
        value: passing, createdAt: observedAt, updatedAt: observedAt,
        verificationPolicyId: "policy", metadata: { workflow_subject_ref: "local:synthetic-fixture" },
      }],
      evidence: [{
        id: "evidence", claimId: "claim", evidenceType: "test_output", method: "validation",
        sourceRef: "fixture:synthetic-test-result", excerptOrSummary: "Deliberately synthetic contract fixture.",
        observedAt, collectedBy: "aidlc-fixture", passing,
      }],
      events: [{
        id: "verification", claimId: "claim", status: "verified", actor: "aidlc-fixture",
        method: "validation", evidenceIds: ["evidence"], createdAt: observedAt, verifiedAt: observedAt,
      }, ...(stale ? [{
        id: "invalidation", claimId: "claim", type: "invalidation", status: "stale",
        actor: "aidlc-fixture", method: "validation", evidenceIds: [], createdAt: now,
      }] : [])],
      policies: [{
        id: "policy", claimType: "aidlc.fixture.check", requiredEvidence: ["test_output"],
        acceptanceCriteria: ["The synthetic check passes."], reviewAuthority: "system",
        validityRule: { kind: "manual" }, stalenessTriggers: [], conflictRules: [], impactLevel: "low",
      }],
    };
  }
  const scenarios = [
    { id: "verified-evidence", expected: { gate: "pass", run: "completed", claim: "verified" } },
    { id: "missing-evidence", missing: true, expected: { gate: "block", run: "blocked", claim: null } },
    { id: "failed-evidence", options: { passing: false }, expected: { gate: "block", run: "blocked", claim: "disputed" } },
    { id: "stale-evidence", options: { stale: true }, reason: "stale", expected: { gate: "block", run: "blocked", claim: "stale" } },
    { id: "wrong-revision-subject", options: { subject: "synthetic-artifact:sha256:old" }, reason: "claim_not_found", expected: { gate: "block", run: "blocked", claim: "verified" } },
    { id: "tampered-stored-bundle", tamper: true, reason: "integrity_mismatch", expected: { gate: "block", run: "blocked", claim: "verified" } },
  ];
  const cases = [];
  try {
    const file = path.join(cwd, "flow.json");
    await fs.writeFile(file, JSON.stringify(definition));
    for (const scenario of scenarios) {
      await startRun(file, { cwd, runId: scenario.id, params: { subject: "local:synthetic-fixture" } });
      let claim = null;
      if (!scenario.missing) {
        const value = bundle(scenario.options);
        claim = buildTrustReport(validateTrustBundle(value), { now: new Date(now) }).claims[0].status;
        const evidenceFile = path.join(cwd, `${scenario.id}.json`);
        await fs.writeFile(evidenceFile, JSON.stringify(value));
        const entry = await attachEvidence(scenario.id, {
          cwd, gate: "check-gate", file: evidenceFile, bundle: true, producer: "aidlc-fixture",
        });
        if (scenario.tamper) await fs.appendFile(path.join(runDir(scenario.id, cwd), entry.stored_path), " ");
      }
      const evaluated = await evaluateRun(scenario.id, { cwd, now });
      const result = evaluated.outcomes[0];
      const diagnostics = result.diagnostics?.claim_evaluation ?? [];
      const observed = { gate: result.status, run: evaluated.state.status, claim };
      const matches = Object.entries(scenario.expected).every(([key, value]) => observed[key] === value)
        && (!scenario.reason || diagnostics.some((item) => item.reason === scenario.reason));
      cases.push({
        id: scenario.id, expected: scenario.expected, observed,
        ...(scenario.reason ? { expected_reason: scenario.reason } : {}),
        diagnostics, outcome: matches ? "pass" : "fail", package_versions,
      });
    }
    return {
      schema_version: 1, evidence_class: "synthetic-public-contract-fixtures",
      package_versions, generated_at: now,
      outcome: cases.every((item) => item.outcome === "pass") ? "pass" : "fail", cases,
      limitations: [
        "Synthetic evidence tests package contracts, not model execution or semantic efficacy.",
        "Explicit invalidation and revision selection do not prove automatic artifact lineage tracking.",
        "No authenticated human approval or independent reviewer execution is asserted.",
      ],
    };
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The CLI has a hard deadline; the fixture API remains composable with test-runner deadlines.
  const timeout = setTimeout(() => {
    process.stderr.write("AI-DLC public conformance exceeded its 30 second deadline.\n");
    process.exit(1);
  }, 30_000);
  try {
    const report = await runPublicFlowConformance();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.outcome === "pass" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}
