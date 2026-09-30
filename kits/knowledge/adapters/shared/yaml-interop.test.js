import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { parseYaml } from "./codec.js";
import DefaultStore from "../default-store/index.js";
import ObsidianStore from "../obsidian-store/index.js";
import { MarkdownVaultProvider } from "../../providers/index.js";

const legacyRoot = fileURLToPath(new URL("./fixtures/legacy-dash/", import.meta.url));
const legacy = JSON.parse(readFileSync(join(legacyRoot, "manifest.json"), "utf8"));
for (const fixture of legacy.records) {
  test(`${fixture.adapter} reads historical ${JSON.stringify(fixture.record.title)} through get, list and graph without rewriting`, async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-legacy-roundtrip-"));
    try {
      const Store = fixture.adapter === "default-store" ? DefaultStore : ObsidianStore;
      const store = new Store({ storeRoot: root });
      const id = await store.create(fixture.record);
      const relative = fixture.adapter === "default-store" ? `records/${id}.md` : JSON.parse(readFileSync(join(root, ".graph-index.json"), "utf8")).by_id[id].path;
      const recordPath = join(root, relative);
      const bytes = readFileSync(join(legacyRoot, fixture.file));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
      writeFileSync(recordPath, bytes);
      assert.deepEqual(await store.get(id), fixture.record);
      assert.deepEqual(await store.listByType(fixture.record.type), [fixture.record]);
      const graph = await new MarkdownVaultProvider({ store, agent: "reader" }).readGraph();
      assert.equal(graph.nodes[0].title, fixture.record.title);
      assert.equal(graph.nodes[0].body, fixture.record.body);
      assert.deepEqual(readFileSync(recordPath), bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const Store of [DefaultStore, ObsidianStore]) {
  test(`${Store.name} reads the string scalars its create operation writes`, async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-scalar-roundtrip-"));
    try {
      const store = new Store({ storeRoot: root });
      for (const title of ["- item", "-", "true", "null", "123", "control\u0000text", "tab\ttext", "quote\"slash\\", "line\n---\ntwo", "A long explanation\n\nwhose multiple lines exceed forty characters."]) {
        const id = await store.create({ type: "raw", title, body: "Original body", category: "repo", provenance: { agent: "original" } });
        assert.equal((await store.get(id)).title, title);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("YAML anchors retain nested evidence objects and text scalar semantics", () => {
  assert.deepEqual(parseYaml(`title: true
category: null
agent: 123
note: |
  first line
  second line
links:
  - &edge {target_id: source, kind: related, label: 'Owner, source'}
mutation_log:
  - evidence:
      added: [*edge]
`), {
    title: "true", category: "null", agent: "123", note: "first line\nsecond line\n",
    links: [{ target_id: "source", kind: "related", label: "Owner, source" }],
    mutation_log: [{ evidence: { added: [{ target_id: "source", kind: "related", label: "Owner, source" }] } }],
  });
});

test("legacy dash compatibility is field-scoped and leaves block scalar contents intact", () => {
  assert.equal(parseYaml("title: - one\u2028two").title, "- one\u2028two");
  assert.deepEqual(parseYaml(`title: - item
provenance:
  agent: - reader
  note: |
    nested: - words
    title: - unchanged
links:
  - target_id: source
    kind: related
    label: - label
`), {
    title: "- item",
    provenance: { agent: "- reader", note: "nested: - words\ntitle: - unchanged\n" },
    links: [{ target_id: "source", kind: "related", label: "- label" }],
  });
  for (const source of [
    "title: - item\ntitle: duplicate",
    "title: - item\nvalue: *missing",
    "title: - item\nvalue: &cycle [*cycle]",
    "unknown: - item",
    "title: - item # not emitted bare by the legacy writer",
    "mutation_log:\n  - op: custom\n    evidence:\n      proposal: - item",
  ]) assert.throws(() => parseYaml(source));
  assert.deepEqual(parseYaml("mutation_log:\n  - op: propose\n    evidence:\n      proposal: - replace").mutation_log[0].evidence, { proposal: "- replace" });
});

for (const [name, yaml] of [
  ["unresolved aliases", "value: *missing"],
  ["cyclic aliases", "value: &cycle [*cycle]"],
  ["duplicate keys", "value: first\nvalue: second"],
  ["malformed sequences", "value: [first"],
  ["non-mapping roots", "[first, second]"],
  ["complex keys", "? [first, second]\n: value"],
  ["unsupported tags", "value: !untrusted data"],
  ["excessive depth", `value: ${"[".repeat(70)}item${"]".repeat(70)}`],
  ["excessive input bytes", `value: ${"x".repeat(4 * 1024 * 1024)}`],
  ["excessive values", `value: [${Array(100_001).fill("x").join(",")}]`],
  ["excessive alias expansion", `a: &a [one, two]\nb: &b [${Array(20).fill("*a").join(", ")}]\nc: [${Array(20).fill("*b").join(", ")}]`],
]) test(`YAML refuses ${name}`, () => assert.throws(() => parseYaml(yaml)));

for (const adapterId of ["knowledge.default-store", "knowledge.obsidian-store"]) {
  test(`installed ${adapterId} reads aliased history without changing record bytes`, async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-yaml-interop-"));
    try {
      const installed = join(root, "knowledge");
      cpSync(fileURLToPath(new URL("../../", import.meta.url)), installed, { recursive: true });
      const manifest = JSON.parse(readFileSync(join(installed, "kit.json"), "utf8"));
      const entry = manifest.adapters.find((item) => item.id === adapterId);
      assert.ok(entry);
      const { default: Store } = await import(pathToFileURL(join(installed, entry.path)));
      const storeRoot = join(root, "records");
      const store = new Store({ storeRoot });
      const id = await store.create({ type: "raw", title: "true", body: "Original body", category: "repo", provenance: { agent: "original" } });
      const before = await store.get(id);
      const relative = adapterId === "knowledge.default-store" ? `records/${id}.md` : JSON.parse(readFileSync(join(storeRoot, ".graph-index.json"), "utf8")).by_id[id].path;
      const recordPath = join(storeRoot, relative);
      const original = readFileSync(recordPath, "utf8");
      const body = original.slice(original.indexOf("\n---\n", 4) + 5);
      const header = `id: ${id}
type: raw
title: true
category: repo
tags: []
created_at: ${before.created_at}
updated_at: ${before.updated_at}
provenance: {agent: original}
links:
  - &edge {target_id: source, kind: related, label: Source}
mutation_log:
  - op: link
    at: ${before.updated_at}
    agent: reviewer
    evidence:
      added: [*edge]`;
      writeFileSync(recordPath, `---\n${header}\n---\n${body}`);
      const bytes = readFileSync(recordPath);
      const record = await store.get(id);
      assert.equal(record.title, "true");
      assert.equal(record.body, before.body);
      assert.deepEqual(record.provenance, before.provenance);
      assert.deepEqual(record.mutation_log[0].evidence.added, record.links);
      assert.deepEqual(record.links, [{ target_id: "source", kind: "related", label: "Source" }]);
      assert.deepEqual(readFileSync(recordPath), bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
