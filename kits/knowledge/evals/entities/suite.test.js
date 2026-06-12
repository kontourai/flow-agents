/**
 * Knowledge Kit — Entity Cards Eval Suite (Issue #48)
 *
 * Covers AC1-AC4 for person/entity cards with backlinks + gated resolution:
 *
 *   AC1: compiling a raw note with 'Attendees: Dana Smith (Acme VP Eng), Lee Wong'
 *        yields two person cards with role text, each backlinking the raw+compiled
 *        notes; compiled note body wikilinks both cards.
 *
 *   AC2: a second meeting with 'Dana Smith' updates the SAME card (new backlink,
 *        no duplicate); 'Dana S.' creates a separate card with a possible-duplicate
 *        link, NOT an auto-merge.
 *
 *   AC3: card merge via propose/apply unions backlinks+aliases and supersedes the
 *        duplicate (queryable in archive); reject leaves both cards byte-identical.
 *
 *   AC4: both store adapters pass the extended contract suite; Obsidian adapter
 *        renders cards in people/ with [[name]] resolution.
 *
 * Run:
 *   node --test kits/knowledge/evals/entities/suite.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "../../../..");

// ---------------------------------------------------------------------------
// Adapter resolution (same pattern as contract-suite)
// ---------------------------------------------------------------------------

function resolveAdapterPath() {
  const adapterFlag = process.argv.find((a) => a.startsWith("--adapter="));
  if (adapterFlag) return path.resolve(adapterFlag.slice("--adapter=".length));
  if (process.env.KNOWLEDGE_ADAPTER) return path.resolve(process.env.KNOWLEDGE_ADAPTER);
  return path.join(KIT_ROOT, "kits/knowledge/adapters/default-store/index.js");
}

const adapterPath = resolveAdapterPath();
const adapterModule = await import(adapterPath);
const AdapterClass = adapterModule.default
  || adapterModule.DefaultKnowledgeStore
  || adapterModule.ObsidianKnowledgeStore;

const runnerPath = path.join(KIT_ROOT, "kits/knowledge/adapters/flow-runner/index.js");
const extractorPath = path.join(KIT_ROOT, "kits/knowledge/adapters/flow-runner/entity-extractor.js");
const { KnowledgeFlowRunner } = await import(runnerPath);
const { defaultEntityExtractor, isPossibleDuplicate, isExactMatch, normalizeName } = await import(extractorPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-entities-"));
}

function makeStore(dir) {
  return new AdapterClass({ storeRoot: dir });
}

function makeRunner(store, dir) {
  return new KnowledgeFlowRunner({ store, workspace: dir, agent: "test-runner" });
}

// ---------------------------------------------------------------------------
// §1 Person type — contract extension (both adapters)
// ---------------------------------------------------------------------------
describe("person type: contract extension", () => {
  let dir, store;
  before(() => { dir = makeTempDir(); store = makeStore(dir); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("person type is accepted by create (C addendum)", async () => {
    const id = await store.create({
      type: "person",
      title: "Dana Smith",
      body: "**Role/Org:** Acme VP Eng",
      category: "team",
      tags: [],
      provenance: { agent: "tester" },
    });
    assert.ok(id, "person record created");
    const record = await store.get(id);
    assert.equal(record.type, "person");
    assert.equal(record.title, "Dana Smith");
  });

  test("person record round-trips with aliases in tags", async () => {
    const id = await store.create({
      type: "person",
      title: "Dana Smith",
      body: "**Role/Org:** Acme VP Eng",
      category: "team",
      tags: ["alias:Dana S."],
      provenance: { agent: "tester" },
    });
    const record = await store.get(id);
    assert.ok(record.tags.includes("alias:Dana S."), "alias tag round-trips");
  });

  test("listByType person returns only person records", async () => {
    await store.create({
      type: "raw",
      title: "Some raw note",
      body: "content",
      category: "team",
      provenance: { agent: "tester" },
    });
    const persons = await store.listByType("person");
    assert.ok(persons.every((r) => r.type === "person"), "all returned are person type");
  });

  test("invalid type still rejected", async () => {
    await assert.rejects(
      () => store.create({ type: "bogus-type", title: "T", body: "B", category: "test", provenance: { agent: "tester" } }),
      { code: "MISSING_EVIDENCE" }
    );
  });
});

// ---------------------------------------------------------------------------
// §2 Entity extractor
// ---------------------------------------------------------------------------
describe("entity extractor: defaultEntityExtractor", () => {
  test("parses Attendees line with role/org", async () => {
    const record = {
      body: "Attendees: Dana Smith (Acme VP Eng), Lee Wong\n\nMeeting notes here.",
    };
    const mentions = await defaultEntityExtractor(record);
    assert.equal(mentions.length, 2);
    const dana = mentions.find((m) => m.name === "Dana Smith");
    assert.ok(dana, "Dana Smith found");
    assert.ok(dana.role, "Dana has role text");
    assert.ok(dana.role.includes("Acme VP Eng"), "role includes Acme VP Eng");
    const lee = mentions.find((m) => m.name === "Lee Wong");
    assert.ok(lee, "Lee Wong found");
  });

  test("parses Attendees line without role", async () => {
    const record = { body: "Attendees: Lee Wong\n" };
    const mentions = await defaultEntityExtractor(record);
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].name, "Lee Wong");
    assert.equal(mentions[0].role, undefined);
  });

  test("deduplicates names across Attendees and wikilinks", async () => {
    const record = {
      body: "Attendees: Dana Smith (Acme VP Eng)\n[[Dana Smith]] confirmed.",
    };
    const mentions = await defaultEntityExtractor(record);
    const danaCount = mentions.filter((m) => m.name === "Dana Smith").length;
    assert.equal(danaCount, 1, "duplicate Dana Smith deduplicated");
  });

  test("extracts wikilinks when no Attendees line", async () => {
    const record = { body: "Follow up with [[Lee Wong]] and [[Dana Smith]]." };
    const mentions = await defaultEntityExtractor(record);
    assert.equal(mentions.length, 2);
  });

  test("returns empty array for body with no names", async () => {
    const record = { body: "General meeting notes about the API design." };
    const mentions = await defaultEntityExtractor(record);
    assert.equal(mentions.length, 0);
  });
});

// ---------------------------------------------------------------------------
// §2b Entity extractor: trailing-punctuation regression (issue #48)
// ---------------------------------------------------------------------------
describe("entity extractor: trailing-punctuation regression (#48)", () => {
  test("last-entry-with-trailing-period: role not folded into name", async () => {
    // 'Lee Wong (Acme procurement).' — trailing period on last entry
    // Before fix: name='Lee Wong (Acme procurement).', role=undefined
    // After fix:  name='Lee Wong', role='Acme procurement'
    const record = {
      body: "Attendees: Dana Smith (Acme VP Eng), Lee Wong (Acme procurement).",
    };
    const mentions = await defaultEntityExtractor(record);
    assert.equal(mentions.length, 2, "two mentions extracted");
    const lee = mentions.find((m) => m.name === "Lee Wong");
    assert.ok(lee, "Lee Wong found with correct name (not 'Lee Wong Acme procurement')");
    assert.ok(lee.role, "Lee Wong has role");
    assert.ok(lee.role.includes("Acme procurement"), "role is 'Acme procurement'");
  });

  test("last-entry-no-period: baseline still works without trailing period", async () => {
    const record = {
      body: "Attendees: Dana Smith (Acme VP Eng), Lee Wong (Acme procurement)",
    };
    const mentions = await defaultEntityExtractor(record);
    const lee = mentions.find((m) => m.name === "Lee Wong");
    assert.ok(lee, "Lee Wong found");
    assert.equal(lee.role, "Acme procurement", "role correct without trailing period");
  });

  test("single-attendee line with trailing period", async () => {
    const record = {
      body: "Attendees: Lee Wong (Acme procurement).",
    };
    const mentions = await defaultEntityExtractor(record);
    assert.equal(mentions.length, 1, "one mention");
    const lee = mentions[0];
    assert.equal(lee.name, "Lee Wong", "name is 'Lee Wong'");
    assert.equal(lee.role, "Acme procurement", "role is 'Acme procurement'");
  });

  test("single-attendee line without trailing period", async () => {
    const record = {
      body: "Attendees: Lee Wong (Acme procurement)",
    };
    const mentions = await defaultEntityExtractor(record);
    assert.equal(mentions.length, 1, "one mention");
    assert.equal(mentions[0].name, "Lee Wong");
    assert.equal(mentions[0].role, "Acme procurement");
  });

  test("role containing comma: 'Lee Wong (Acme, procurement).'", async () => {
    // Commas inside the parenthetical are part of the role, not entry separators
    const record = {
      body: "Attendees: Lee Wong (Acme, procurement).",
    };
    const mentions = await defaultEntityExtractor(record);
    assert.equal(mentions.length, 1, "one mention despite comma in role");
    const lee = mentions[0];
    assert.equal(lee.name, "Lee Wong", "name correct");
    assert.ok(lee.role.includes("Acme"), "role includes Acme");
    assert.ok(lee.role.includes("procurement"), "role includes procurement");
  });

  test("role containing periods: 'Dr. Lee Wong (Acme Sr. Eng.)'", async () => {
    const record = {
      body: "Attendees: Dr. Lee Wong (Acme Sr. Eng.)",
    };
    const mentions = await defaultEntityExtractor(record);
    assert.equal(mentions.length, 1, "one mention");
    const lee = mentions[0];
    assert.equal(lee.name, "Dr. Lee Wong", "name with title prefix correct");
    assert.ok(lee.role.includes("Acme Sr. Eng"), "role with internal periods correct");
  });
});

// ---------------------------------------------------------------------------
// §3 Name resolution helpers
// ---------------------------------------------------------------------------
describe("name resolution: exact match and possible-duplicate", () => {
  test("isExactMatch handles case/whitespace", () => {
    assert.ok(isExactMatch("Dana Smith", "dana smith"));
    assert.ok(isExactMatch("  Dana Smith  ", "Dana Smith"));
    assert.ok(!isExactMatch("Dana Smith", "Dana S."));
  });

  test("isPossibleDuplicate: same surname + initial", () => {
    assert.ok(isPossibleDuplicate("Dana S.", "Dana Smith"));
    assert.ok(isPossibleDuplicate("D. Smith", "Dana Smith"));
    assert.ok(!isPossibleDuplicate("Dana Smith", "Dana Smith"), "exact match is not duplicate");
    assert.ok(!isPossibleDuplicate("Lee Wong", "Dana Smith"), "different person is not duplicate");
    assert.ok(!isPossibleDuplicate("Dana Johnson", "Dana Smith"), "different surname is not duplicate");
  });
});

// ---------------------------------------------------------------------------
// §4 AC1: compile + extractEntities yields person cards with role + backlinks
// ---------------------------------------------------------------------------
describe("AC1: compile + extractEntities yields person cards with backlinks", () => {
  let dir, store, runner;
  before(() => {
    dir = makeTempDir();
    store = makeStore(dir);
    runner = makeRunner(store, dir);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("AC1: two person cards created with role text", async () => {
    const rawBody = "Attendees: Dana Smith (Acme VP Eng), Lee Wong\n\nDiscussed Q3 roadmap.";

    // Capture raw
    const { id: rawId } = await runner.capture(rawBody, {
      title: "Acme Q3 Meeting",
      category: "team.meeting",
    });

    // Compile
    const { id: compiledId } = await runner.compile([rawId], {
      title: "Compiled: Acme Q3 Meeting",
      category: "team.meeting",
    });

    // Extract entities
    const result = await runner.extractEntities(compiledId);

    assert.equal(result.personCards.length, 2, "two person cards created");

    const danaResult = result.personCards.find((c) => c.name === "Dana Smith");
    const leeResult = result.personCards.find((c) => c.name === "Lee Wong");
    assert.ok(danaResult, "Dana Smith card found");
    assert.ok(leeResult, "Lee Wong card found");

    // Verify Dana's card has role text
    const danaCard = await store.get(danaResult.cardId);
    assert.ok(danaCard.body.includes("Acme VP Eng"), "Dana card has role text");

    // Verify both cards have appears-in links to the compiled record
    const danaLinks = await store.getLinks(danaResult.cardId);
    const danaCompiledLink = danaLinks.forward.some(
      (l) => l.target_id === compiledId && l.kind === "appears-in"
    );
    assert.ok(danaCompiledLink, "Dana card links to compiled (appears-in)");

    const leeLinks = await store.getLinks(leeResult.cardId);
    const leeCompiledLink = leeLinks.forward.some(
      (l) => l.target_id === compiledId && l.kind === "appears-in"
    );
    assert.ok(leeCompiledLink, "Lee card links to compiled (appears-in)");

    // Verify compiled record has person links to both cards
    const compiledLinks = await store.getLinks(compiledId);
    const hasDanaPersonLink = compiledLinks.forward.some(
      (l) => l.target_id === danaResult.cardId && l.kind === "person"
    );
    const hasLeePersonLink = compiledLinks.forward.some(
      (l) => l.target_id === leeResult.cardId && l.kind === "person"
    );
    assert.ok(hasDanaPersonLink, "compiled links to Dana (person)");
    assert.ok(hasLeePersonLink, "compiled links to Lee (person)");
  });

  test("AC1: person cards backlink the raw source records", async () => {
    const rawBody = "Attendees: Tina Ramos (PM)\nProduct review discussion.";
    const { id: rawId } = await runner.capture(rawBody, { title: "Product Review", category: "team.meeting" });
    const { id: compiledId } = await runner.compile([rawId], { title: "Compiled: Product Review", category: "team.meeting" });
    const { personCards } = await runner.extractEntities(compiledId);

    assert.equal(personCards.length, 1, "one person card for Tina");
    const tinaLinks = await store.getLinks(personCards[0].cardId);
    const tinaRawLink = tinaLinks.forward.some(
      (l) => l.target_id === rawId && l.kind === "appears-in"
    );
    assert.ok(tinaRawLink, "Tina card links to raw source (appears-in)");
  });
});

// ---------------------------------------------------------------------------
// §5 AC2: idempotent resolution and possible-duplicate handling
// ---------------------------------------------------------------------------
describe("AC2: second meeting updates same card; initial creates separate card", () => {
  let dir, store, runner;
  before(() => {
    dir = makeTempDir();
    store = makeStore(dir);
    runner = makeRunner(store, dir);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("AC2a: second meeting with 'Dana Smith' updates the SAME card", async () => {
    // First meeting
    const raw1Body = "Attendees: Dana Smith (Acme VP Eng)\nQ3 kickoff.";
    const { id: raw1Id } = await runner.capture(raw1Body, { title: "Acme Kickoff", category: "team.meeting" });
    const { id: compiled1Id } = await runner.compile([raw1Id], { title: "Compiled: Acme Kickoff", category: "team.meeting" });
    const result1 = await runner.extractEntities(compiled1Id);
    const danaCardId = result1.personCards.find((c) => c.name === "Dana Smith").cardId;

    // Second meeting
    const raw2Body = "Attendees: Dana Smith (Acme VP Eng)\nQ4 planning.";
    const { id: raw2Id } = await runner.capture(raw2Body, { title: "Acme Q4 Planning", category: "team.meeting" });
    const { id: compiled2Id } = await runner.compile([raw2Id], { title: "Compiled: Q4 Planning", category: "team.meeting" });
    const result2 = await runner.extractEntities(compiled2Id);

    const danaMention2 = result2.personCards.find((c) => c.name === "Dana Smith");
    assert.ok(danaMention2, "Dana Smith found in second extraction");
    assert.equal(danaMention2.cardId, danaCardId, "same card id — no duplicate created");
    assert.equal(danaMention2.created, false, "card was NOT newly created");

    // Verify the card now has appears-in links to both compiled records
    const danaLinks = await store.getLinks(danaCardId);
    const hasCompiled1 = danaLinks.forward.some((l) => l.target_id === compiled1Id && l.kind === "appears-in");
    const hasCompiled2 = danaLinks.forward.some((l) => l.target_id === compiled2Id && l.kind === "appears-in");
    assert.ok(hasCompiled1, "Dana links to first compiled");
    assert.ok(hasCompiled2, "Dana links to second compiled (new backlink)");
  });

  test("AC2b: 'Dana S.' creates SEPARATE card with possible-duplicate link", async () => {
    // Create a known Dana Smith card first
    const raw1Body = "Attendees: Dana Smith (Acme VP Eng)\nKickoff.";
    const { id: raw1Id } = await runner.capture(raw1Body, { title: "Meeting A", category: "team.meeting" });
    const { id: compiled1Id } = await runner.compile([raw1Id], { title: "Compiled: Meeting A", category: "team.meeting" });
    const result1 = await runner.extractEntities(compiled1Id);
    const danaCardId = result1.personCards.find((c) => c.name === "Dana Smith").cardId;

    // Now process a record with 'Dana S.'
    const raw2Body = "Attendees: Dana S.\nFollow-up call.";
    const { id: raw2Id } = await runner.capture(raw2Body, { title: "Follow-up Call", category: "team.meeting" });
    const { id: compiled2Id } = await runner.compile([raw2Id], { title: "Compiled: Follow-up Call", category: "team.meeting" });
    const result2 = await runner.extractEntities(compiled2Id);

    const danaS = result2.personCards.find((c) => c.name === "Dana S.");
    assert.ok(danaS, "Dana S. card found");
    assert.notEqual(danaS.cardId, danaCardId, "separate card — not auto-merged");
    assert.equal(danaS.created, true, "new card was created");
    assert.equal(danaS.duplicate, true, "flagged as possible duplicate");

    // The new card should have a possible-duplicate related link to the original
    const danaSLinks = await store.getLinks(danaS.cardId);
    const hasDupLink = danaSLinks.forward.some(
      (l) => l.target_id === danaCardId && l.kind === "related" && l.label === "possible-duplicate"
    );
    assert.ok(hasDupLink, "possible-duplicate related link from Dana S. to Dana Smith");
  });
});

// ---------------------------------------------------------------------------
// §6 AC3: merge via propose/apply/reject
// ---------------------------------------------------------------------------
describe("AC3: card merge via propose/apply unions backlinks+aliases; reject leaves byte-identical", () => {
  let dir, store, runner;
  before(() => {
    dir = makeTempDir();
    store = makeStore(dir);
    runner = makeRunner(store, dir);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("AC3-apply: merge unions aliases+backlinks and supersedes duplicate", async () => {
    // Create the primary person card
    const primaryId = await store.create({
      type: "person",
      title: "Dana Smith",
      body: "**Role/Org:** Acme VP Eng",
      category: "team.meeting",
      tags: [],
      provenance: { agent: "tester" },
    });

    // Create a raw + compiled + link to primary so it has appears-in
    const rawId = await store.create({
      type: "raw",
      title: "Meeting A",
      body: "Attendees: Dana Smith (Acme VP Eng)",
      category: "team.meeting",
      provenance: { agent: "tester" },
    });
    await store.link(primaryId, [{ target_id: rawId, kind: "appears-in" }], { agent: "tester" });

    // Create the duplicate card with a different appears-in source
    const duplicateId = await store.create({
      type: "person",
      title: "Dana S.",
      body: "**Role/Org:** Acme",
      category: "team.meeting",
      tags: [],
      provenance: { agent: "tester" },
    });
    const raw2Id = await store.create({
      type: "raw",
      title: "Meeting B",
      body: "Attendees: Dana S.",
      category: "team.meeting",
      provenance: { agent: "tester" },
    });
    await store.link(duplicateId, [{ target_id: raw2Id, kind: "appears-in" }], { agent: "tester" });

    // Merge: apply
    const mergeResult = await runner.mergePerson(primaryId, duplicateId, {
      decision: "apply",
      rationale: "Confirmed same person via email domain",
    });
    assert.equal(mergeResult.decision, "apply");

    // Primary now has alias:Dana S.
    const primaryAfter = await store.get(primaryId);
    assert.ok(
      (primaryAfter.tags || []).includes("alias:Dana S."),
      "alias added to primary card"
    );

    // Primary has the union of backlinks
    const primaryLinks = await store.getLinks(primaryId);
    const hasRaw1 = primaryLinks.forward.some((l) => l.target_id === rawId && l.kind === "appears-in");
    const hasRaw2 = primaryLinks.forward.some((l) => l.target_id === raw2Id && l.kind === "appears-in");
    assert.ok(hasRaw1, "primary retains original backlink");
    assert.ok(hasRaw2, "primary gained backlink from duplicate");

    // Duplicate is archived (superseded — still queryable)
    const dupRecord = await store.get(duplicateId);
    assert.ok(dupRecord, "duplicate still queryable (supersede-not-delete)");
    const dupLog = dupRecord.mutation_log || [];
    const supersededByEntry = dupLog.find((e) => e.op === "superseded-by");
    assert.ok(supersededByEntry, "duplicate has superseded-by mutation log entry");
  });

  test("AC3-reject: reject leaves both cards byte-identical", async () => {
    // Create primary and duplicate
    const primaryId = await store.create({
      type: "person",
      title: "Lee Wong",
      body: "**Role/Org:** Acme Engineer",
      category: "team.meeting",
      tags: [],
      provenance: { agent: "tester" },
    });
    const duplicateId = await store.create({
      type: "person",
      title: "L. Wong",
      body: "**Role/Org:** Acme",
      category: "team.meeting",
      tags: [],
      provenance: { agent: "tester" },
    });

    // Snapshot the state before reject
    const primaryBefore = await store.get(primaryId);
    const dupBefore = await store.get(duplicateId);
    const primaryBodyBefore = primaryBefore.body;
    const dupBodyBefore = dupBefore.body;
    const primaryTagsBefore = JSON.stringify(primaryBefore.tags || []);
    const dupTagsBefore = JSON.stringify(dupBefore.tags || []);

    // Reject the merge
    await runner.mergePerson(primaryId, duplicateId, {
      decision: "reject",
      rejectReason: "Different people — different first names confirmed",
    });

    // Both cards have byte-identical body + tags
    const primaryAfter = await store.get(primaryId);
    const dupAfter = await store.get(duplicateId);
    assert.equal(primaryAfter.body, primaryBodyBefore, "primary body unchanged");
    assert.equal(dupAfter.body, dupBodyBefore, "duplicate body unchanged");
    assert.equal(JSON.stringify(primaryAfter.tags || []), primaryTagsBefore, "primary tags unchanged");
    assert.equal(JSON.stringify(dupAfter.tags || []), dupTagsBefore, "duplicate tags unchanged");
  });
});

// ---------------------------------------------------------------------------
// §7 AC4: Obsidian adapter renders person cards in people/ folder
// ---------------------------------------------------------------------------

const obsidianAdapterPath = path.join(
  KIT_ROOT, "kits/knowledge/adapters/obsidian-store/index.js"
);
let _obsidianModule = null;
try {
  _obsidianModule = await import(obsidianAdapterPath);
} catch {
  _obsidianModule = null;
}
const ObsidianStore = _obsidianModule?.default || _obsidianModule?.ObsidianKnowledgeStore;

describe("AC4: Obsidian adapter — people/ folder and wikilink rendering", () => {

  if (!ObsidianStore) {
    test("AC4: obsidian adapter not available — skip", () => {});
  } else {
    test("AC4: person record stored in people/ folder", async () => {
      const dir = makeTempDir();
      try {
        const store = new ObsidianStore({ storeRoot: dir });
        const id = await store.create({
          type: "person",
          title: "Dana Smith",
          body: "**Role/Org:** Acme VP Eng",
          category: "team.meeting",
          tags: [],
          provenance: { agent: "tester" },
        });

        // Verify the file is in people/
        const files = [];
        function walkDir(d) {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.isDirectory()) walkDir(path.join(d, entry.name));
            else if (entry.name.endsWith(".md")) files.push(path.join(d, entry.name));
          }
        }
        walkDir(dir);
        const personFiles = files.filter((f) => f.includes("/people/"));
        assert.ok(personFiles.length > 0, "person record stored in people/ folder");
        assert.ok(personFiles.some((f) => f.includes("dana-smith")), "filename is slugified title");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("AC4: person card rendered with Appears In section", async () => {
      const dir = makeTempDir();
      try {
        const store = new ObsidianStore({ storeRoot: dir });
        const rawId = await store.create({
          type: "raw",
          title: "Acme Meeting",
          body: "Attendees: Dana Smith (Acme VP Eng)\n",
          category: "team.meeting",
          provenance: { agent: "tester" },
        });
        const personId = await store.create({
          type: "person",
          title: "Dana Smith",
          body: "**Role/Org:** Acme VP Eng",
          category: "team.meeting",
          links: [{ target_id: rawId, kind: "appears-in" }],
          provenance: { agent: "tester" },
        });

        // Read the written file
        const files = [];
        function walkDir(d) {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.isDirectory()) walkDir(path.join(d, entry.name));
            else if (entry.name.endsWith(".md")) files.push(path.join(d, entry.name));
          }
        }
        walkDir(dir);
        const personFile = files.find((f) => f.includes("/people/") && f.includes("dana-smith"));
        assert.ok(personFile, "person file found in people/");

        const content = fs.readFileSync(personFile, "utf8");
        assert.ok(content.includes("## Appears In"), "Appears In section present");
        assert.ok(content.includes("[["), "wikilinks present in Appears In section");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("AC4: Obsidian adapter passes extended contract suite for person type", async () => {
      const dir = makeTempDir();
      try {
        const store = new ObsidianStore({ storeRoot: dir });
        // Basic contract ops on person type
        const id = await store.create({
          type: "person",
          title: "Test Person",
          body: "Test body",
          category: "test",
          provenance: { agent: "tester" },
        });
        const record = await store.get(id);
        assert.equal(record.type, "person");
        assert.equal(record.title, "Test Person");

        await store.update(id, { body: "Updated body" }, { agent: "tester" });
        const updated = await store.get(id);
        assert.equal(updated.body, "Updated body");

        const persons = await store.listByType("person");
        assert.ok(persons.some((r) => r.id === id));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// §8 Extended contract suite: person type validity (both adapters)
// ---------------------------------------------------------------------------
describe("extended contract: person type accepted as valid (both adapters)", () => {
  let dir, store;
  before(() => { dir = makeTempDir(); store = makeStore(dir); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("person is a VALID_TYPES member — create succeeds", async () => {
    const id = await store.create({
      type: "person",
      title: "Contract Test Person",
      body: "Test body",
      category: "test",
      provenance: { agent: "tester" },
    });
    assert.ok(id);
    const r = await store.get(id);
    assert.equal(r.type, "person");
  });

  test("propose accepts person as target (Addendum B: all types)", async () => {
    const personId = await store.create({
      type: "person",
      title: "Proposal Target",
      body: "body",
      category: "test",
      provenance: { agent: "tester" },
    });
    const proposerId = await store.create({
      type: "raw",
      title: "Proposer",
      body: "p",
      category: "test",
      provenance: { agent: "tester" },
    });
    await store.propose(personId, proposerId, { agent: "tester", proposal: "merge proposal" });
    const { forward } = await store.getLinks(proposerId);
    assert.ok(forward.some((l) => l.target_id === personId && l.kind === "proposes"));
  });

  test("apply/reject work on person records", async () => {
    const personId = await store.create({
      type: "person",
      title: "Apply Target Person",
      body: "original body",
      category: "test",
      provenance: { agent: "tester" },
    });
    const proposerId = await store.create({
      type: "raw",
      title: "Proposer for Person",
      body: "p",
      category: "test",
      provenance: { agent: "tester" },
    });
    await store.propose(personId, proposerId, { agent: "tester", proposal: "update body" });
    await store.apply(personId, proposerId, { agent: "tester", new_body: "updated body", rationale: "confirmed" });
    const after = await store.get(personId);
    assert.equal(after.body, "updated body");
  });
});
