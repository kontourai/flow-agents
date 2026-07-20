import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import DefaultKnowledgeStore from "../../adapters/default-store/index.js";
import { applyCreateProposals } from "../../dream/apply.js";
import { renderBrief, utf8TokenUpperBound } from "../../dream/brief.js";
import { scaffoldStore } from "../../adapters/shared/store-resolve.js";

function record(id, project, confidence, bodySize) {
  return { id, type: "compiled", title: id, body: `${id} ${"x".repeat(bodySize)}`, category: project ? `project.${project}` : "memory.global", confidence, updated_at: "2026-07-20T00:00:00.000Z", ...(project ? { provenance: { project } } : {}) };
}

test("AC6: an overfull 3x candidate set retains top-ranked fitting global and project records", () => {
  const records = [
    record("global-top", null, 1, 200), record("project-top", "alpha", 1, 200), record("global-mid", null, 0.8, 200),
    ...Array.from({ length: 12 }, (_, index) => record(`low-${index}`, index % 2 ? "alpha" : null, 0.1, 200)),
    { ...record("retired", null, 1, 20), status: "retired" },
  ];
  const global = renderBrief(records, { budget: 512, now: "2026-07-20T00:00:00.000Z" });
  const project = renderBrief(records, { project: "alpha", budget: 512, now: "2026-07-20T00:00:00.000Z" });
  assert.ok(utf8TokenUpperBound(global.content) <= 512); assert.ok(utf8TokenUpperBound(project.content) <= 512);
  assert.ok(global.recordIds.includes("global-top")); assert.ok(project.recordIds.includes("project-top"));
  assert.equal(global.recordIds.includes("retired"), false); assert.equal(project.recordIds.includes("retired"), false);
});

test("AC6 persisted path: stored confidence tags drive top-ranked reviewed records", async () => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-ranking-store-")); const repo = path.join(fixture, "store-repo"); fs.mkdirSync(repo); const root = scaffoldStore(repo);
  const proposal = (title, confidence) => ({ schema_version: "1.0", provider: "test", kind: "create-node", target: { root: "personal", path: "proposals/pending/eval" }, status: "proposed", provenance: { provider: "test", source: "eval", retrieved_at: "2026-07-20" }, payload: { type: "compiled", title, body: `${title} body`, category: "memory.eval", tags: [`confidence:${confidence}`], provenance: { agent: "eval", session_id: "eval", source_ids: [title] } } });
  try {
    await applyCreateProposals({ storeRoot: root, proposals: [proposal("top", 1), proposal("low", 0.1)], policy: "auto" });
    const store = new DefaultKnowledgeStore({ storeRoot: root }); const records = await store.listByType("compiled"); const brief = renderBrief(records, { budget: 128, now: "2026-07-20T00:00:00.000Z" });
    assert.equal(brief.recordIds[0], records.find((record) => record.title === "top").id); assert.ok(utf8TokenUpperBound(brief.content) <= 128);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
