import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("standalone Knowledge projection accepts erasure-capable Surface and rejects older or broken Surface", () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-surface-fallback-"));
  try {
    const installed = join(root, "kit");
    cpSync(kitRoot, installed, { recursive: true });
    const adapter = join(installed, "providers/surface-adapter/index.js");
    const scope = join(root, "node_modules/@kontourai");
    mkdirSync(scope, { recursive: true });
    const publicName = join(scope, "surface");
    const packageRoot = (specifier) => resolve(fileURLToPath(import.meta.resolve(specifier)), "../../..");
    const livingEntry = join(installed, "context-check/living-context.js");
    const runLiving = (expectSuccess) => {
      const program = `
        import assert from "node:assert/strict";
        import { pathToFileURL } from "node:url";
        const { assertSurfaceVisibility } = await import(pathToFileURL(process.argv[1]));
        if (${expectSuccess}) assert.doesNotThrow(() => assertSurfaceVisibility());
        else assert.throws(() => assertSurfaceVisibility(), { code: "SURFACE_VISIBILITY_UNAVAILABLE" });
      `;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
      return spawnSync(process.execPath, ["--input-type=module", "-e", program, livingEntry], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    };
    const run = (expectSuccess) => {
      const program = `
        import { pathToFileURL } from "node:url";
        const { buildKnowledgeTrustBundle } = await import(pathToFileURL(process.argv[1]));
        const at = "2026-11-02T12:00:00.000Z";
        const store = { readGraph: async () => ({ nodes: [{ id: "erased", type: "note", title: "[purged]",
          attributes: { record_type: "raw", category: "purged", status: "purged", created_at: at, updated_at: at,
            mutation_log: [{ op: "purged", at, agent: "owner", rationale: "request" }] },
          provenance: { source: "knowledge:erased", retrieved_at: at } }], edges: [] }) };
        try {
          const bundle = await buildKnowledgeTrustBundle({ store });
          if (!${expectSuccess} || bundle.claims[0]?.metadata?.surfaceRetention?.state !== "deleted") process.exit(2);
        } catch (error) {
          if (${expectSuccess} || !/requires @kontourai\\/surface 6\\.3\\.0/.test(error.message)) throw error;
        }
      `;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
      return spawnSync(process.execPath, ["--input-type=module", "-e", program, adapter], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    };
    symlinkSync(packageRoot("@kontourai/surface"), publicName, "junction");
    let result = run(true);
    assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    result = runLiving(true);
    assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);

    // An older Surface (before 6.3.0) has no deletion or derived-visibility API. Stand one in
    // with the export the projection would otherwise use, so the refusal is what is tested.
    rmSync(publicName);
    mkdirSync(publicName);
    writeFileSync(join(publicName, "package.json"), JSON.stringify({ name: "@kontourai/surface", version: "5.0.0", type: "module", exports: "./index.js" }));
    writeFileSync(join(publicName, "index.js"), "export class TrustBundleBuilder {}\n");
    result = run(false);
    assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    result = runLiving(false);
    assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);

    // A Surface install with a missing transitive dependency is broken, not absent:
    // its own error must reach the caller.
    rmSync(publicName, { recursive: true, force: true });
    mkdirSync(publicName);
    writeFileSync(join(publicName, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
    writeFileSync(join(publicName, "index.js"), 'import "flow-agents-missing-surface-test-dependency";\n');
    const brokenProgram = `
      import assert from "node:assert/strict";
      import { pathToFileURL } from "node:url";
      const { buildKnowledgeTrustBundle } = await import(pathToFileURL(process.argv[1]));
      await assert.rejects(() => buildKnowledgeTrustBundle({ store: { readGraph: async () => ({ nodes: [], edges: [] }) } }),
        (error) => error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("'flow-agents-missing-surface-test-dependency'"));
    `;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
    result = spawnSync(process.execPath, ["--input-type=module", "-e", brokenProgram, adapter], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    const brokenLiving = `import assert from "node:assert/strict"; import { pathToFileURL } from "node:url";
      await assert.rejects(import(pathToFileURL(process.argv[1])), (error) => error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("'flow-agents-missing-surface-test-dependency'"));`;
    result = spawnSync(process.execPath, ["--input-type=module", "-e", brokenLiving, livingEntry], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
