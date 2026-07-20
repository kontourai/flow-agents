import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { distillRuntimeResidue, loadDistillerAdapter } from "./distiller.js";

test("conservative distiller is bounded and re-scrubs transcript content", async () => {
  const result = await distillRuntimeResidue({ slug: "fixture", runtime: "codex", transcriptRefs: ["codex.jsonl"], transcriptEntries: [{ kind: "message", text: `Remember api_key=sk-${"A".repeat(24)} and use stable ids.` }] });
  assert.equal(result.records.length, 1);
  assert.match(result.records[0].body, /<SECRET>/);
  assert.equal(result.records[0].body.includes("sk-"), false);
  assert.ok(result.request.instructions.includes("redact"));
});

test("distiller bounds aggregate tags/refs and adapter root containment", async () => {
  const residue = { slug: "fixture", runtime: "codex", transcriptRefs: ["codex.jsonl"], transcriptEntries: [{ kind: "message", text: "hello" }] };
  await assert.rejects(() => distillRuntimeResidue(residue, { adapter: () => [{ title: "x", body: "x", category: "memory.runtime", tags: Array.from({ length: 33 }, (_, index) => `t${index}`) }] }), /tags exceed/);
  await assert.rejects(() => distillRuntimeResidue({ ...residue, transcriptRefs: Array.from({ length: 65 }, (_, index) => `r${index}`) }), /references exceed/);
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-adapter-"));
  try {
    const inside = path.join(root, "inside"); const outside = path.join(root, "outside.js"); fs.mkdirSync(inside); fs.writeFileSync(outside, "export function distill() { return []; }\n", { mode: 0o600 });
    await assert.rejects(() => loadDistillerAdapter(outside, { allowedRoot: inside }), /outside/);
    const link = path.join(inside, "link.js"); fs.symlinkSync(outside, link); await assert.rejects(() => loadDistillerAdapter(link, { allowedRoot: inside }), /symlink/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("distiller rejects malformed or oversized trusted-adapter output without shell/provider fallback", async () => {
  const residue = { slug: "fixture", runtime: "codex", transcriptRefs: ["codex.jsonl"], transcriptEntries: [{ kind: "message", text: "hello" }] };
  await assert.rejects(() => distillRuntimeResidue(residue, { adapter: () => [{ title: "", body: "x", category: "memory.runtime" }] }), /malformed/);
  await assert.rejects(() => distillRuntimeResidue(residue, { adapter: () => Array.from({ length: 9 }, () => ({ title: "x", body: "x", category: "memory.runtime" })) }), /invalid record batch/);
});

test("trusted adapters cannot self-approve or forge dream-owned tags", async () => {
  const residue = { slug: "fixture", runtime: "codex", transcriptRefs: ["codex.jsonl"], transcriptEntries: [{ kind: "message", text: "hello" }] };
  for (const tag of ["brief-approved", "trust:reviewed", "source:manual", "confidence:1", "runtime:codex"]) {
    await assert.rejects(() => distillRuntimeResidue(residue, { adapter: () => [{ title: "x", body: "x", category: "memory.runtime", tags: [tag] }] }), /owned|reserved|tag/i);
  }
});

test("adapter root itself must be owner-controlled and non-writable by group/world", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-adapter-mode-"));
  try {
    const adapter = path.join(root, "adapter.js"); fs.writeFileSync(adapter, "export function distill() { return []; }\n", { mode: 0o600 }); fs.chmodSync(root, 0o777);
    await assert.rejects(() => loadDistillerAdapter(adapter, { allowedRoot: root }), /directory|owner|mode|writable|unsafe/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
