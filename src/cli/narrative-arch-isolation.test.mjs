import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evidenceMatchesExpectation } from "@kontourai/flow";
import {
  NARRATIVE_PROMOTE_OPERATION,
  NARRATIVE_PROMOTE_OPERATION_PROTOCOL,
  PUBLIC_OPERATION_CONTRACTS,
  PUBLIC_OPERATION_IDS,
} from "../../build/src/cli/public-contracts.js";
import { rejectOperationBoundExpectation } from "../../build/src/cli/workflow-sidecar.js";
import { main as narrativeSourcesMain, NARRATIVE_NAMESPACE_ROOT } from "../../build/src/cli/narrative-sources.js";

const NARRATIVE_SOURCE_ROOT = path.resolve("src/narrative");
const ALLOWED_SHARED_IMPORTS = new Set([
  "../lib/fs.js",
  "../lib/package-version.js",
]);
const BANNED_IMPORTS = [
  ["builder-flow-runtime", /builder-flow-runtime/],
  ["workflow-sidecar", /workflow-sidecar/],
  ["@kontourai/flow", /^@kontourai\/flow(?:$|\/)/],
  ["builder-lifecycle-authority", /builder-lifecycle-authority/],
  ["builder-gate-action-envelope", /builder-gate-action-envelope/],
  ["continuation-*", /(?:^|\/)continuation-[^/]*$/],
];

function sourceImports(source) {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
}

function isAllowedImport(file, specifier) {
  if (specifier.startsWith("node:")) return true;
  if (ALLOWED_SHARED_IMPORTS.has(specifier)) return true;
  if (/^\.\/[^/]+\.js$/.test(specifier)) return true;
  return path.basename(file) === "readers.ts" && specifier === "@kontourai/surface";
}

test("narrative sources remain isolated from Flow trust and mutation machinery", () => {
  const files = fs.readdirSync(NARRATIVE_SOURCE_ROOT)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => path.join(NARRATIVE_SOURCE_ROOT, name));
  assert.ok(files.length > 0, "expected narrative TypeScript sources");

  for (const file of files) {
    const imports = sourceImports(fs.readFileSync(file, "utf8"));
    for (const specifier of imports) {
      assert.ok(
        isAllowedImport(file, specifier),
        `${path.relative(process.cwd(), file)} imports disallowed dependency ${specifier}`,
      );
      for (const [name, pattern] of BANNED_IMPORTS) {
        assert.doesNotMatch(specifier, pattern, `${path.relative(process.cwd(), file)} must not import ${name}`);
      }
    }
  }
});

test("narrative snapshots resolve beneath the canonical project namespace", { concurrency: false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-namespace-"));
  const projectRoot = path.join(root, "project");
  const repoRoot = path.join(projectRoot, "repo");
  const sourceFile = path.join(repoRoot, "input.json");
  fs.mkdirSync(repoRoot, { recursive: true });
  const sourceBytes = Buffer.from('{"result":"ok"}');
  fs.writeFileSync(sourceFile, sourceBytes);
  const sourceId = `fa1:file:input.json:${createHash("sha256").update(sourceBytes).digest("hex")}`;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(narrativeSourcesMain([
      "snapshot", "--artifact-root", projectRoot, "--narrative-id", "standalone",
      "--source", sourceId, "--repo-root", repoRoot,
    ]), 0);
    assert.ok(fs.existsSync(path.join(projectRoot, NARRATIVE_NAMESPACE_ROOT, "standalone", "source-manifest.json")));

    process.chdir(projectRoot);
    assert.equal(narrativeSourcesMain([
      "snapshot", "--session-slug", "run-619", "--narrative-id", "session",
      "--source", sourceId, "--repo-root", repoRoot,
    ]), 0);
    assert.ok(fs.existsSync(path.join(projectRoot, NARRATIVE_NAMESPACE_ROOT, "run-619", "session", "source-manifest.json")));
    assert.equal(fs.existsSync(path.join(projectRoot, ".kontourai", "flow-agents", "run-619", "narrative")), false);
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Flow evidence matching rejects narrative-shaped entries", () => {
  const expectation = {
    id: "implementation-scope",
    kind: "trust.bundle",
    bundle_claim: {
      claimType: "builder.execute.scope",
      subjectType: "change",
    },
  };
  const narrativeEntries = [
    { id: "narrative", kind: "narrative", requested_kind: "narrative", status: "passed" },
    { id: "artifact", kind: "artifact", requested_kind: "artifact", status: "passed" },
    {
      id: "rendered-markdown",
      kind: "file",
      requested_kind: "file",
      status: "passed",
      original_path: ".kontourai/narrative/run-619/narrative-1/envelopes/rendered.md",
    },
  ];

  for (const entry of narrativeEntries) {
    assert.equal(evidenceMatchesExpectation(entry, expectation), false, `${entry.id} must not satisfy trust.bundle`);
  }

  const trustBundleEntry = {
    id: "trust-bundle",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    bundle: {
      schemaVersion: 5,
      source: "narrative-arch-isolation-positive-control",
      claims: [],
      evidence: [],
      policies: [],
      events: [],
    },
    bundle_report: {
      claims: [{
        id: "implementation-scope-claim",
        claimType: "builder.execute.scope",
        subjectType: "change",
        status: "verified",
      }],
    },
  };
  assert.equal(evidenceMatchesExpectation(trustBundleEntry, expectation), true, "valid trust.bundle remains a positive control");
});

test("narrative.promote is external-only and cannot be completed by the workflow writer", () => {
  assert.equal(PUBLIC_OPERATION_IDS.has(NARRATIVE_PROMOTE_OPERATION), true);
  assert.equal(PUBLIC_OPERATION_CONTRACTS[NARRATIVE_PROMOTE_OPERATION], NARRATIVE_PROMOTE_OPERATION_PROTOCOL);
  assert.equal(NARRATIVE_PROMOTE_OPERATION_PROTOCOL.capability, "narrative.promote");
  assert.equal(NARRATIVE_PROMOTE_OPERATION_PROTOCOL.result.persist_as, "evidence");
  assert.equal(NARRATIVE_PROMOTE_OPERATION_PROTOCOL.availability.executable_by_flow_agents, false);
  assert.equal(NARRATIVE_PROMOTE_OPERATION_PROTOCOL.availability.direct_write_allowed, false);
  assert.throws(
    () => rejectOperationBoundExpectation("narrative-promotion", NARRATIVE_PROMOTE_OPERATION),
    /operation-bound expectation.*narrative\.promote.*authenticated external narrative provider completion/,
  );
});
