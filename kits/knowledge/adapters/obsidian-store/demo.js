#!/usr/bin/env node
/**
 * Knowledge Kit — Obsidian Store Demo
 *
 * Generates a small set of realistic sample notes in a temporary vault,
 * then prints the snapshot note verbatim to demonstrate the file-is-the-record
 * thesis.
 *
 * Run:
 *   node kits/knowledge/adapters/obsidian-store/demo.js
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adapterPath = path.join(__dirname, "index.js");
const { ObsidianKnowledgeStore } = await import(adapterPath);

// ---------------------------------------------------------------------------
// Setup: ephemeral vault
// ---------------------------------------------------------------------------

const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-demo-"));
const store = new ObsidianKnowledgeStore({ storeRoot: vaultRoot });

console.log(`\nDemo vault: ${vaultRoot}\n`);
console.log("─".repeat(70));

// ---------------------------------------------------------------------------
// 1. Raw capture: meeting transcript
// ---------------------------------------------------------------------------

const rawId = await store.create({
  type: "raw",
  title: "Q2 Planning Meeting — Transcript",
  body: `Discussed moving deploy pipeline to GitHub Actions.
Ben: we should retire the Jenkins instance, it's costing us $300/mo.
Alice: agreed, but we need the secrets migration plan first.
Action items: Alice to draft secrets migration doc by Friday.`,
  category: "eng.decisions",
  tags: ["meeting", "infra", "q2"],
  provenance: {
    agent: "demo-agent",
    session_id: "demo-sess-001",
    note: "Captured from Zoom transcript",
  },
});

console.log(`\n[1/4] Created raw capture: ${rawId}`);

// ---------------------------------------------------------------------------
// 2. Compiled: distilled from the raw
// ---------------------------------------------------------------------------

const compiledId = await store.create({
  type: "compiled",
  title: "Jenkins Retirement Decision",
  body: `Team agreed to retire the Jenkins CI instance in Q2.
Prerequisite: secrets migration plan must be completed first (owner: Alice).
Cost savings: ~$300/month after retirement.`,
  category: "eng.decisions",
  tags: ["infra", "ci", "cost"],
  links: [{ target_id: rawId, kind: "source" }],
  provenance: {
    agent: "demo-agent",
    source_ids: [rawId],
    note: "Compiled from Q2 planning meeting transcript",
  },
});

console.log(`[2/4] Created compiled note: ${compiledId}`);

// ---------------------------------------------------------------------------
// 3. Placeholder snapshot (to be superseded)
// ---------------------------------------------------------------------------

const placeholderSnapshotId = await store.create({
  type: "snapshot",
  title: "CI Strategy Snapshot — Draft",
  body: "Placeholder: CI strategy under discussion. No final decision yet.",
  category: "eng.decisions",
  tags: ["ci", "strategy", "draft"],
  provenance: {
    agent: "demo-agent",
    note: "Placeholder snapshot pending planning meeting outcome",
  },
});

console.log(`[3/4] Created placeholder snapshot: ${placeholderSnapshotId}`);

// ---------------------------------------------------------------------------
// 4. Final snapshot that supersedes the placeholder
// ---------------------------------------------------------------------------

const finalSnapshotId = await store.create({
  type: "snapshot",
  title: "CI Strategy Snapshot — Q2 2026",
  body: `Decision: Migrate from Jenkins to GitHub Actions in Q2 2026.

Key constraints:
- Secrets migration must complete before Jenkins decommission.
- Target: Jenkins instance retired by end of June 2026.
- Owner: Platform team (Alice lead).

Cost impact: -$300/month after retirement.`,
  category: "eng.decisions",
  tags: ["ci", "strategy", "q2-2026"],
  links: [
    { target_id: compiledId, kind: "source" },
  ],
  provenance: {
    agent: "demo-agent",
    source_ids: [compiledId],
    note: "Final Q2 snapshot after planning meeting",
  },
});

// Supersede the placeholder
await store.supersede(finalSnapshotId, [placeholderSnapshotId], {
  agent: "demo-agent",
  rationale: "Q2 planning meeting resolved the CI strategy; placeholder superseded by final snapshot.",
});

console.log(`[4/4] Created final snapshot ${finalSnapshotId} (supersedes ${placeholderSnapshotId})\n`);
console.log("─".repeat(70));

// ---------------------------------------------------------------------------
// Print the final snapshot note verbatim
// ---------------------------------------------------------------------------

// Find the file via the path index
const pathIndexRaw = fs.readFileSync(path.join(vaultRoot, ".graph-index.json"), "utf8");
const pathIndex = JSON.parse(pathIndexRaw);
const snapshotEntry = pathIndex.by_id[finalSnapshotId];
const snapshotPath = path.join(vaultRoot, snapshotEntry.path);

console.log(`\nFinal snapshot note on disk: ${snapshotPath}\n`);
console.log("═".repeat(70));
console.log(fs.readFileSync(snapshotPath, "utf8"));
console.log("═".repeat(70));

// ---------------------------------------------------------------------------
// Show the archived placeholder
// ---------------------------------------------------------------------------

const archivedEntry = pathIndex.by_id[placeholderSnapshotId];
console.log(`\nSuperseded placeholder archived at: ${archivedEntry.path}`);
console.log(`(archived: ${archivedEntry.archived})`);

// Confirm it's still queryable
const archived = await store.get(placeholderSnapshotId);
console.log(`\nArchived record still queryable via get(): title = "${archived.title}"`);
console.log(`Mutation log has ${archived.mutation_log.length} entr${archived.mutation_log.length === 1 ? "y" : "ies"}.`);
const sbEntry = archived.mutation_log.find((e) => e.op === "superseded-by");
if (sbEntry) {
  console.log(`  - superseded-by: new_id = ${sbEntry.new_id}`);
}

// ---------------------------------------------------------------------------
// Vault structure
// ---------------------------------------------------------------------------

console.log("\nVault layout:");
function printTree(dir, prefix = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const isLast = entry === entries[entries.length - 1];
    console.log(`${prefix}${isLast ? "└── " : "├── "}${entry.name}`);
    if (entry.isDirectory()) {
      printTree(path.join(dir, entry.name), prefix + (isLast ? "    " : "│   "));
    }
  }
}
printTree(vaultRoot);

// Cleanup
fs.rmSync(vaultRoot, { recursive: true, force: true });
console.log(`\nDemo vault cleaned up.\n`);
