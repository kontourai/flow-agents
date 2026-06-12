/**
 * Entity Cards Demo — Acme Example
 *
 * Demonstrates the full entity extraction flow:
 *   1. Capture a raw note with Attendees line (Dana Smith + Lee Wong)
 *   2. Compile the raw note
 *   3. Extract person entities → create person cards with bidirectional links
 *   4. Print Dana's person card verbatim (as Obsidian markdown)
 *
 * Run:
 *   node kits/knowledge/evals/entities/demo-acme.js
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "../../../..");

// Use Obsidian adapter for richest output
const obsidianPath = path.join(KIT_ROOT, "kits/knowledge/adapters/obsidian-store/index.js");
const runnerPath   = path.join(KIT_ROOT, "kits/knowledge/adapters/flow-runner/index.js");

const { ObsidianKnowledgeStore } = await import(obsidianPath);
const { KnowledgeFlowRunner }    = await import(runnerPath);

// ---------------------------------------------------------------------------
// Setup temp store
// ---------------------------------------------------------------------------

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "acme-entity-demo-"));

const store  = new ObsidianKnowledgeStore({ storeRoot: storeDir, sourcesDir: "meetings" });
const runner = new KnowledgeFlowRunner({ store, agent: "acme-demo" });

console.log("Store root:", storeDir);
console.log("");

// ---------------------------------------------------------------------------
// 1. Capture a raw Acme meeting note
// ---------------------------------------------------------------------------

const meetingNote = `Acme Q3 Kickoff — 2026-06-12

Attendees: Dana Smith (Acme VP Eng), Lee Wong

Agenda:
- Q3 roadmap review
- Engineering capacity planning
- Open items from Q2 retro

Action Items:
- Dana Smith to share updated roadmap by Friday
- Lee Wong to provide capacity estimates

Next meeting: 2026-06-19`;

const { id: rawId } = await runner.capture(meetingNote, {
  title: "Acme Q3 Kickoff",
  category: "sales.acme.meetings",
});

console.log("Captured raw note:", rawId);

// ---------------------------------------------------------------------------
// 2. Compile the raw note
// ---------------------------------------------------------------------------

const { id: compiledId } = await runner.compile([rawId], {
  title: "Compiled: Acme Q3 Kickoff",
  category: "sales.acme.meetings",
});

console.log("Compiled note:    ", compiledId);

// ---------------------------------------------------------------------------
// 3. Extract entities → create person cards
// ---------------------------------------------------------------------------

const result = await runner.extractEntities(compiledId);

console.log("");
console.log("Person cards created:");
for (const pc of result.personCards) {
  const card = await store.get(pc.cardId);
  console.log(`  - ${card.title} (id: ${pc.cardId}, created: ${pc.created})`);
}

// ---------------------------------------------------------------------------
// 4. Print Dana's person card verbatim (as Obsidian markdown)
// ---------------------------------------------------------------------------

const danaResult = result.personCards.find((pc) => pc.name === "Dana Smith");
if (!danaResult) throw new Error("Dana Smith card not found");

// Read the file directly from the vault
const { default: DefaultKnowledgeStore } = await import(
  path.join(KIT_ROOT, "kits/knowledge/adapters/default-store/index.js")
);

// Find the obsidian file for Dana's card
const pathIndexFile = path.join(storeDir, ".graph-index.json");
const pathIndex = JSON.parse(fs.readFileSync(pathIndexFile, "utf8"));
const danaEntry = pathIndex.by_id[danaResult.cardId];
if (!danaEntry) throw new Error("Dana card not found in path index");

const danaFilePath = path.join(storeDir, danaEntry.path);
const danaMarkdown = fs.readFileSync(danaFilePath, "utf8");

console.log("");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("Dana Smith's person card (verbatim Obsidian markdown):");
console.log("File:", danaFilePath.replace(storeDir, "<vault>"));
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(danaMarkdown);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

fs.rmSync(storeDir, { recursive: true, force: true });
console.log("\nDemo complete.");
