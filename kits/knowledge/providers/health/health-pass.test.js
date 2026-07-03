/**
 * Provider-agnostic health verbs — AC1 + AC2 (issue #317).
 *
 *   AC1: the SAME health command over the vault provider and the git-repo
 *        provider yields schema-valid reports (R1, R2, R4).
 *   AC2: a backlog pass over the work-item adapter flags a SEEDED duplicate and
 *        a SEEDED broken blocker link, from a fixture — never the real board
 *        (R3, R4).
 *
 * Run: node --test kits/knowledge/providers/health/health-pass.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { MarkdownVaultProvider } from "../markdown-vault/index.js";
import { GitRepoProvider } from "../git-repo/index.js";
import { WorkItemProvider } from "../work-item/index.js";
import DefaultKnowledgeStore from "../../adapters/default-store/index.js";
import { detectDuplicates, checkDependencyLinkIntegrity } from "./index.js";
import { loadSchemas } from "../lib/model.js";
import { validate } from "../lib/schema-validate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "../conformance/fixtures");
const { healthReport: REPORT_SCHEMA } = loadSchemas();

function assertReport(report, expectCheck, expectProvider) {
  const { valid, errors } = validate(report, REPORT_SCHEMA);
  assert.ok(valid, `report not schema-valid:\n  ${errors.join("\n  ")}`);
  assert.equal(report.check, expectCheck);
  assert.equal(report.provider, expectProvider);
  assert.equal(report.summary.finding_count, report.findings.length);
}

async function vaultGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-vault-health-"));
  const store = new DefaultKnowledgeStore({ storeRoot: dir });
  const a = await store.create({ type: "compiled", title: "Caching strategy", body: "use LRU", category: "eng", provenance: { agent: "t" } });
  const b = await store.create({ type: "compiled", title: "Caching strategy", body: "use LRU everywhere", category: "eng", provenance: { agent: "t" } });
  await store.link(b, [{ target_id: a, kind: "refines" }], { agent: "t" });
  const provider = new MarkdownVaultProvider({ store, storeRoot: dir, agent: "t" });
  const graph = await provider.readGraph();
  fs.rmSync(dir, { recursive: true, force: true });
  return graph;
}

describe("AC1: same health command over two providers yields schema-valid reports", () => {
  test("vault provider: duplicate + integrity reports are schema-valid", async () => {
    const graph = await vaultGraph();
    assertReport(detectDuplicates(graph, { provider: "markdown-vault" }), "duplicate-detection", "markdown-vault");
    assertReport(checkDependencyLinkIntegrity(graph, { provider: "markdown-vault" }), "dependency-link-integrity", "markdown-vault");
  });

  test("git-repo provider: duplicate + integrity reports are schema-valid", async () => {
    const provider = new GitRepoProvider({ repoRoot: path.join(FIXTURES, "git-repo"), agent: "t" });
    const graph = await provider.readGraph();
    assertReport(detectDuplicates(graph, { provider: "git-repo" }), "duplicate-detection", "git-repo");
    assertReport(checkDependencyLinkIntegrity(graph, { provider: "git-repo" }), "dependency-link-integrity", "git-repo");
  });
});

describe("AC2: backlog pass over the work-item adapter flags seeded dupe + broken blocker", () => {
  async function workItemGraph() {
    const issues = fs.readFileSync(path.join(FIXTURES, "work-item", "issues.json"), "utf8");
    const provider = new WorkItemProvider({ repo: "seed/fixture", runner: async () => issues, agent: "t" });
    return provider.readGraph();
  }

  test("duplicate detection flags the seeded #14 ~ #15 pair", async () => {
    const graph = await workItemGraph();
    const report = detectDuplicates(graph, { provider: "work-item" });
    assertReport(report, "duplicate-detection", "work-item");
    const dupe = report.findings.find(
      (f) => f.node_ids.includes("issue:14") && f.node_ids.includes("issue:15"),
    );
    assert.ok(dupe, "expected a duplicate finding for issue:14 ~ issue:15");
    assert.equal(dupe.kind, "duplicate-nodes");
  });

  test("dependency-link integrity flags the seeded broken blocker (#999 -> #20)", async () => {
    const graph = await workItemGraph();
    const report = checkDependencyLinkIntegrity(graph, { provider: "work-item" });
    assertReport(report, "dependency-link-integrity", "work-item");
    const broken = report.findings.find(
      (f) => f.node_ids.includes("issue:999") && f.node_ids.includes("issue:20"),
    );
    assert.ok(broken, "expected a broken-blocker finding for issue:999 -> issue:20");
    assert.equal(broken.kind, "broken-dependency-link");
    assert.equal(broken.severity, "error");
    // the valid blocker #14 -> #20 must NOT be flagged
    const falsePositive = report.findings.find((f) => f.node_ids.includes("issue:14") && f.node_ids.includes("issue:20"));
    assert.ok(!falsePositive, "valid blocker #14 -> #20 must not be flagged");
  });
});
