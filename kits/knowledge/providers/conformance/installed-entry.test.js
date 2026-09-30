import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const kitRoot = fileURLToPath(new URL("../../", import.meta.url));

test("the installed public provider entry reads a vault without optional Surface dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-public-entry-"));
  try {
    const installed = join(root, "knowledge");
    cpSync(kitRoot, installed, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(installed, "kit.json"), "utf8"));
    const providerEntry = manifest.adapters.find((entry) => entry.id === "knowledge.store-providers");
    const storeEntry = manifest.adapters.find((entry) => entry.id === "knowledge.default-store");
    assert.ok(providerEntry && storeEntry);
    const program = `
      import assert from "node:assert/strict";
      import { pathToFileURL } from "node:url";
      import { join } from "node:path";
      const [providerPath, storePath, root] = process.argv.slice(1);
      const { MarkdownVaultProvider, checkDependencyLinkIntegrity, buildKnowledgeTrustBundle } = await import(pathToFileURL(providerPath));
      const { default: Store } = await import(pathToFileURL(storePath));
      const store = new Store({ storeRoot: join(root, "records-root") });
      const raw = await store.create({ type: "raw", title: "Source", body: "Recorded source", category: "repo", provenance: { agent: "fixture" } });
      const note = await store.create({ type: "compiled", title: "Explanation", body: "Source-backed explanation", category: "repo", provenance: { agent: "fixture", session_id: "capture", note: "Derived snapshot; semantic review unknown" } });
      await store.link(note, [{ target_id: raw, kind: "source", label: "Recorded review dependency: changed-or-missing" }], { agent: "fixture" });
      const provider = new MarkdownVaultProvider({ store, agent: "reader" });
      const graph = await provider.readGraph();
      assert.equal(graph.nodes.length, 2);
      assert.equal(graph.edges.length, 1);
      assert.equal(graph.edges[0].type, "evidence-of");
      assert.deepEqual(graph.nodes.find(item => item.id === note).attributes.record_provenance, (await store.get(note)).provenance);
      assert.equal(graph.nodes.find(item => item.id === note).provenance.agent, "reader");
      assert.equal(graph.edges[0].attributes.vault_link_kind, "source");
      assert.equal(graph.edges[0].attributes.vault_link_label, "Recorded review dependency: changed-or-missing");
      assert.equal(graph.edges[0].provenance.agent, "reader");
      const health = checkDependencyLinkIntegrity(graph);
      assert.equal(health.findings.length, 0);
      const before = await store.get(note);
      await assert.rejects(buildKnowledgeTrustBundle({ store }), (error) => error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("@kontourai/surface"));
      assert.deepEqual(await store.get(note), before);
      console.log("isolated public entry and explicit optional-dependency refusal passed");
    `;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program, resolve(installed, providerEntry.path), resolve(installed, storeEntry.path), root], {
      cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 20_000,
    });
    assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /isolated public entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
