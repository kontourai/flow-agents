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
  const staticLiteral = String.raw`(?:"([^"]+)"|'([^']+)'|\x60((?:\$(?!\{)|[^\x60$])+)\x60)`;
  const patterns = [
    new RegExp(String.raw`\bfrom\s+${staticLiteral}`, "g"),
    new RegExp(String.raw`\bimport\s+${staticLiteral}`, "g"),
    new RegExp(String.raw`\bimport\s*\(\s*${staticLiteral}\s*\)`, "g"),
    new RegExp(String.raw`\brequire\s*\(\s*${staticLiteral}\s*\)`, "g"),
    new RegExp(String.raw`\bimport\.meta\.resolve\s*\(\s*${staticLiteral}\s*\)`, "g"),
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)]
    .map((match) => match[1] ?? match[2] ?? match[3]));
}

function isAllowedImport(file, specifier) {
  if (specifier.startsWith("node:")) return true;
  if (ALLOWED_SHARED_IMPORTS.has(specifier)) return true;
  if (/^\.\/[^/]+\.js$/.test(specifier)) return true;
  return path.basename(file) === "readers.ts" && specifier === "@kontourai/surface";
}

test("architecture import extraction covers static require and import.meta.resolve forms", () => {
  const bannedSpecifier = "../cli/workflow-sidecar.js";
  const fixtures = [
    ["require with quotes", `const sidecar = require("${bannedSpecifier}");`],
    ["require with a static template", `const sidecar = require(\`${bannedSpecifier}\`);`],
    ["import.meta.resolve with quotes", `const sidecar = import.meta.resolve("${bannedSpecifier}");`],
    ["import.meta.resolve with a static template", `const sidecar = import.meta.resolve(\`${bannedSpecifier}\`);`],
  ];

  for (const [name, source] of fixtures) {
    assert.deepEqual(sourceImports(source), [bannedSpecifier], `${name} must be detected`);
    assert.equal(isAllowedImport("src/narrative/fixture.ts", bannedSpecifier), false, `${name} must be disallowed`);
    assert.match(bannedSpecifier, BANNED_IMPORTS.find(([label]) => label === "workflow-sidecar")[1]);
  }
});

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
    {
      // #622 (D4/R3/AC4): an at-action agent_stated intent annotation is a typed
      // self-report and can NEVER be cited as gate evidence — a narrative-kind
      // entry referencing its write-once channel must not satisfy a trust.bundle.
      id: "intent-annotation",
      kind: "file",
      requested_kind: "file",
      status: "passed",
      original_path: ".kontourai/narrative/run-622/narrative-1/intent-annotation.json",
    },
    {
      id: "intent-annotation-narrative",
      kind: "narrative",
      requested_kind: "narrative",
      status: "passed",
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
