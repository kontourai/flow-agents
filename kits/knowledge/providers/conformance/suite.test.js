/**
 * Knowledge Store Provider — Conformance Suite (issue #317, AC3).
 *
 * One parameterized suite every provider must pass. Proves that markdown-vault,
 * git-repo, and work-item all satisfy the read + proposals-only interface and
 * emit schema-valid nodes/edges/proposals. Run:
 *   node --test kits/knowledge/providers/conformance/suite.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { MarkdownVaultProvider } from "../markdown-vault/index.js";
import { GitRepoProvider } from "../git-repo/index.js";
import { WorkItemProvider } from "../work-item/index.js";
import { Neo4jProvider } from "../neo4j/index.js";
import { syncToNeo4j } from "../neo4j/sync.js";
import { makeFakeDriver } from "../neo4j/fake-driver.js";
import DefaultKnowledgeStore from "../../adapters/default-store/index.js";
import { loadSchemas, EDGE_TYPES } from "../lib/model.js";
import { validate } from "../lib/schema-validate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const schemas = loadSchemas();

function assertSchema(value, schema, label) {
  const { valid, errors } = validate(value, schema);
  assert.ok(valid, `${label} not schema-valid:\n  ${errors.join("\n  ")}`);
}

// --- per-provider fixture builders --------------------------------------

async function buildVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-vault-conf-"));
  const store = new DefaultKnowledgeStore({ storeRoot: dir });
  const rawId = await store.create({ type: "raw", title: "Raw source", body: "raw material", category: "eng", provenance: { agent: "test" } });
  const compiledId = await store.create({ type: "compiled", title: "Compiled note", body: "distilled", category: "eng", provenance: { agent: "test" } });
  await store.link(compiledId, [{ target_id: rawId, kind: "source" }], { agent: "test" });
  const provider = new MarkdownVaultProvider({ store, storeRoot: dir, agent: "test" });
  return { provider, proposeIntent: { title: "Proposed note", body: "content", category: "eng" }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function buildGitRepo() {
  const provider = new GitRepoProvider({ repoRoot: path.join(FIXTURES, "git-repo"), agent: "test" });
  return { provider, proposeIntent: { subject: "Fixture decision", body: "the answer", evidence: [{ kind: "issue", ref: "#317" }] }, cleanup: () => {} };
}

async function buildWorkItem() {
  const issues = fs.readFileSync(path.join(FIXTURES, "work-item", "issues.json"), "utf8");
  const runner = async () => issues;
  const provider = new WorkItemProvider({ repo: "seed/fixture", runner, agent: "test" });
  return { provider, proposeIntent: { issue: 14, commentBody: "draft comment" }, cleanup: () => {} };
}

async function buildNeo4j() {
  // Materialize the same git-repo + work-item fixtures the other providers use
  // into an injected fake driver, then read them back through the neo4j provider.
  // This exercises the read side over the graph store with no Docker (issue #327
  // CI proof: conformance passes for the neo4j read side via an injected mock).
  const gitRepo = new GitRepoProvider({ repoRoot: path.join(FIXTURES, "git-repo"), agent: "test" });
  const issues = fs.readFileSync(path.join(FIXTURES, "work-item", "issues.json"), "utf8");
  const workItem = new WorkItemProvider({ repo: "seed/fixture", runner: async () => issues, agent: "test" });
  const driver = makeFakeDriver();
  await syncToNeo4j({ driver, providers: [gitRepo, workItem] });
  const provider = new Neo4jProvider({ driver, agent: "test" });
  return { provider, proposeIntent: { kind: "create-node", type: "note", title: "Proposed graph note" }, cleanup: () => {} };
}

const PROVIDERS = [
  { name: "markdown-vault", build: buildVault, expectedId: "markdown-vault" },
  { name: "git-repo", build: buildGitRepo, expectedId: "git-repo" },
  { name: "work-item", build: buildWorkItem, expectedId: "work-item" },
  { name: "neo4j", build: buildNeo4j, expectedId: "neo4j" },
];

for (const { name, build, expectedId } of PROVIDERS) {
  describe(`conformance: ${name}`, () => {
    let ctx;
    before(async () => { ctx = await build(); });
    after(() => ctx.cleanup());

    test("capabilities() declares proposals-only, non-writable", () => {
      const cap = ctx.provider.capabilities();
      assert.equal(cap.id, expectedId);
      assert.equal(cap.writable, false);
      assert.equal(cap.write_mode, "proposals-only");
      assert.ok(Array.isArray(cap.proposal_targets) && cap.proposal_targets.length > 0);
    });

    test("readNodes() returns schema-valid nodes with unique ids and provider provenance", async () => {
      const nodes = await ctx.provider.readNodes();
      assert.ok(Array.isArray(nodes) && nodes.length > 0, "expected at least one node");
      const ids = new Set();
      for (const n of nodes) {
        assertSchema(n, schemas.node, `${name} node ${n.id}`);
        assert.equal(n.provenance.provider, expectedId);
        assert.ok(!ids.has(n.id), `duplicate node id ${n.id}`);
        ids.add(n.id);
      }
    });

    test("readEdges() returns schema-valid edges in the closed edge vocabulary", async () => {
      const edges = await ctx.provider.readEdges();
      assert.ok(Array.isArray(edges));
      for (const e of edges) {
        assertSchema(e, schemas.edge, `${name} edge ${e.id}`);
        assert.ok(EDGE_TYPES.includes(e.type), `edge type ${e.type} outside closed vocabulary`);
        assert.equal(e.provenance.provider, expectedId);
      }
    });

    test("queryByType() is a consistent subset of readNodes()", async () => {
      const nodes = await ctx.provider.readNodes();
      const types = [...new Set(nodes.map((n) => n.type))];
      for (const t of types) {
        const q = await ctx.provider.queryByType(t);
        assert.ok(q.every((n) => n.type === t), `queryByType(${t}) returned off-type node`);
        assert.equal(q.length, nodes.filter((n) => n.type === t).length);
      }
    });

    test("readGraph() returns { nodes, edges }", async () => {
      const g = await ctx.provider.readGraph();
      assert.ok(Array.isArray(g.nodes) && Array.isArray(g.edges));
    });

    test("proposeWrite() returns a schema-valid 'proposed' proposal and mutates nothing", async () => {
      const before = await ctx.provider.readNodes();
      const p = await ctx.provider.proposeWrite(ctx.proposeIntent);
      assertSchema(p, schemas.proposal, `${name} proposal`);
      assert.equal(p.status, "proposed");
      assert.equal(p.provider, expectedId);
      assert.equal(typeof p.rendered, "string");
      const after = await ctx.provider.readNodes();
      assert.equal(after.length, before.length, "proposeWrite must not add nodes to the store");
    });
  });
}
