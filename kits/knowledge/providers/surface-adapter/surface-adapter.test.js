/**
 * Surface adapter (Knowledge Kit -> @kontourai/surface TrustBundle),
 * issue #1206, wave 6 / 16 + 20.
 *
 * End-to-end proof that buildKnowledgeTrustBundle() produces a
 * schema-valid TrustBundle on the INSTALLED Surface package (build()
 * validates against the real schemas, not a mock), from a real
 * DefaultKnowledgeStore exercised through evidence links, a supersede,
 * and a mutation history. Also covers the injected-store path and the
 * markdown-vault read memoization (finding 7 / wave 2 item 8).
 *
 * Run: node --test kits/knowledge/providers/surface-adapter/surface-adapter.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import DefaultKnowledgeStore from "../../adapters/default-store/index.js";
import { MarkdownVaultProvider } from "../markdown-vault/index.js";
import { buildKnowledgeTrustBundle } from "./index.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kg-surface-adapter-"));
}

describe("buildKnowledgeTrustBundle: end-to-end over a real DefaultKnowledgeStore", () => {
  let dir, store;
  let rawId, conceptId, oldConceptId, retiredId;

  before(async () => {
    dir = makeTempDir();
    store = new DefaultKnowledgeStore({ storeRoot: dir });

    // Raw source + a concept citing it as evidence.
    rawId = await store.create({
      type: "raw",
      title: "Raw source",
      body: "raw material",
      category: "eng",
      provenance: { agent: "tester" },
    });
    conceptId = await store.create({
      type: "concept",
      title: "A concept",
      body: "concept body",
      category: "eng",
      ttl_seconds: 3600,
      provenance: { agent: "tester" },
    });
    await store.link(conceptId, [{ target_id: rawId, kind: "source" }], { agent: "tester" });

    // A second concept related to the first (identity-link edge), plus an
    // update so a mutation_log exists for it.
    oldConceptId = await store.create({
      type: "concept",
      title: "Related concept",
      body: "related body",
      category: "eng",
      provenance: { agent: "tester" },
    });
    await store.link(conceptId, [{ target_id: oldConceptId, kind: "related" }], { agent: "tester" });
    await store.update(conceptId, { tags: ["surfaced"] }, { agent: "tester" });

    // A record that gets superseded, then retired, so status/supersedes and
    // the retired-record path are both exercised.
    retiredId = await store.create({
      type: "concept",
      title: "Superseded concept",
      body: "old body",
      category: "eng",
      provenance: { agent: "tester" },
    });
    await store.supersede(conceptId, [retiredId], { agent: "tester", rationale: "concept supersedes it" });
    await store.retire(retiredId, "retired", { agent: "tester", rationale: "no longer applicable" });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("builds successfully via storeRoot (MarkdownVaultProvider) path", async () => {
    const bundle = await buildKnowledgeTrustBundle({ storeRoot: dir, includeRetired: true });
    assert.ok(Array.isArray(bundle.claims));
    assert.ok(bundle.claims.length >= 4);
  });

  test("no claim ever carries status 'verified' (unearned-trust regression guard)", async () => {
    const bundle = await buildKnowledgeTrustBundle({ storeRoot: dir, includeRetired: true });
    for (const claim of bundle.claims) {
      assert.notEqual(claim.status, "verified", `claim ${claim.id} must never be labeled verified`);
      assert.ok(
        claim.status === "proposed" || claim.status === "superseded",
        `claim ${claim.id} has unexpected status ${claim.status}`
      );
    }
  });

  test("retired record's claim is 'superseded'; active records are 'proposed'", async () => {
    const bundle = await buildKnowledgeTrustBundle({ storeRoot: dir, includeRetired: true });
    const retiredClaim = bundle.claims.find((c) => c.subjectId === retiredId);
    const activeClaim = bundle.claims.find((c) => c.subjectId === conceptId);
    assert.ok(retiredClaim, "retired record must still produce a claim when includeRetired: true");
    assert.equal(retiredClaim.status, "superseded");
    assert.equal(activeClaim.status, "proposed");
  });

  test("expiresAt/ttlSeconds pass through from the record onto the claim", async () => {
    const bundle = await buildKnowledgeTrustBundle({ storeRoot: dir, includeRetired: true });
    const claim = bundle.claims.find((c) => c.subjectId === conceptId);
    assert.equal(claim.ttlSeconds, 3600);
  });

  test("evidence entries use the valid document_citation vocabulary", async () => {
    const bundle = await buildKnowledgeTrustBundle({ storeRoot: dir, includeRetired: true });
    assert.ok(bundle.evidence.length >= 1, "expected at least one evidence entry from the source link");
    for (const ev of bundle.evidence) {
      assert.equal(ev.evidenceType, "document_citation");
      assert.notEqual(ev.evidenceType, "document", "the invalid legacy value must never appear");
    }
  });

  test("a supersedes policy exists for the supersede relationship", async () => {
    const bundle = await buildKnowledgeTrustBundle({ storeRoot: dir, includeRetired: true });
    const policy = bundle.policies.find((p) => p.id.startsWith("policy:supersedes."));
    assert.ok(policy, "expected a supersedes policy");
    assert.deepEqual(policy.requiredEvidence, ["document_citation"]);
  });

  test("metadata.knowledgeMutationLog is present for the mutated record and absent otherwise", async () => {
    const bundle = await buildKnowledgeTrustBundle({ storeRoot: dir, includeRetired: true });
    const mutatedClaim = bundle.claims.find((c) => c.subjectId === conceptId);
    assert.ok(Array.isArray(mutatedClaim.metadata.knowledgeMutationLog));
    assert.ok(mutatedClaim.metadata.knowledgeMutationLog.length > 0);
    for (const entry of mutatedClaim.metadata.knowledgeMutationLog) {
      assert.ok(entry.op, "compact mutation-log entry must carry op");
      assert.ok(entry.at, "compact mutation-log entry must carry at");
    }

    const rawClaim = bundle.claims.find((c) => c.subjectId === rawId);
    assert.equal(
      rawClaim.metadata.knowledgeMutationLog,
      undefined,
      "an unmutated record must not carry a mutation log in claim metadata"
    );
  });

  test("no verification events are ever emitted from the mutation log (producer lifecycle != verification)", async () => {
    const bundle = await buildKnowledgeTrustBundle({ storeRoot: dir, includeRetired: true });
    assert.deepEqual(bundle.events, [], "the adapter must never fabricate verification events from mutations");
  });

  test("identity links reference ids that exist among bundle.claims", async () => {
    const bundle = await buildKnowledgeTrustBundle({ storeRoot: dir, includeRetired: true });
    assert.ok(Array.isArray(bundle.identityLinks) && bundle.identityLinks.length >= 1, "expected the related edge to produce an identity link");
    const claimSubjectIds = new Set(bundle.claims.map((c) => c.subjectId));
    for (const link of bundle.identityLinks) {
      assert.ok(Array.isArray(link.subjects) && link.subjects.length >= 2);
      for (const subject of link.subjects) {
        assert.equal(subject.subjectType, "knowledge");
        assert.ok(
          claimSubjectIds.has(subject.subjectId),
          `identity link subject ${subject.subjectId} must correspond to an emitted claim`
        );
      }
    }
  });
});

describe("buildKnowledgeTrustBundle: injected-store path", () => {
  test("succeeds against a store object that only exposes readGraph()", async () => {
    const dir = makeTempDir();
    try {
      const store = new DefaultKnowledgeStore({ storeRoot: dir });
      await store.create({
        type: "raw",
        title: "Injected raw",
        body: "content",
        category: "eng",
        provenance: { agent: "tester" },
      });
      const vaultProvider = new MarkdownVaultProvider({ store, storeRoot: dir, agent: "tester" });
      // Minimal KnowledgeStoreAdapter-shaped injection: readGraph() only,
      // proving the adapter never calls readNodes()/readEdges() directly.
      const injectedStore = { readGraph: () => vaultProvider.readGraph() };

      const bundle = await buildKnowledgeTrustBundle({ store: injectedStore });
      assert.equal(bundle.claims.length, 1);
      assert.equal(bundle.claims[0].status, "proposed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildKnowledgeTrustBundle: record status 'implemented' (verify round — regression guard for finding #4)", () => {
  // The original finding #4 defect mapped record status "implemented" ->
  // claim status "verified" (fabricated trust). statusFor() was fixed to
  // only ever return "superseded" (retired) or "proposed" (everything
  // else, including "implemented"). No other test in this file drives a
  // record to status "implemented" through the store's real transition, so
  // the "no claim ever carries status verified" guard elsewhere in this
  // file is happy-path-only against that specific defect. This closes that
  // gap: a record genuinely at status "implemented" (via the store's real
  // retire() transition, not a hand-built fixture) must still produce a
  // claim (implemented records are not filtered out — only "retired" is),
  // and that claim's status must be "proposed", never "verified".
  test("an 'implemented' record still yields a claim, with status 'proposed' — never 'verified'", async () => {
    const dir = makeTempDir();
    try {
      const store = new DefaultKnowledgeStore({ storeRoot: dir });
      const implementedId = await store.create({
        type: "concept",
        title: "Shipped concept",
        body: "concept body",
        category: "eng",
        provenance: { agent: "tester" },
      });

      // Real store transition to "implemented" (active -> implemented is a
      // valid VALID_STATUS_TRANSITIONS edge; implementedByRef is required
      // evidence for this targetStatus — see
      // kits/knowledge/evals/retirement/suite.test.js "retire with
      // targetStatus='implemented' and implementedByRef transitions to
      // 'implemented'" for the same evidence shape exercised there).
      await store.retire(implementedId, "implemented", {
        agent: "tester",
        rationale: "Shipped in PR #42.",
        implementedByRef: "https://github.com/org/repo/pull/42",
      });

      const record = await store.get(implementedId);
      assert.equal(record.status, "implemented", "precondition: the store transition actually landed");

      const bundle = await buildKnowledgeTrustBundle({ storeRoot: dir });

      const claim = bundle.claims.find((c) => c.subjectId === implementedId);
      assert.ok(claim, "an 'implemented' record must still yield a claim — only 'retired' is filtered out");
      assert.equal(claim.status, "proposed", "an 'implemented' record's claim status must be 'proposed'");

      for (const c of bundle.claims) {
        assert.notEqual(c.status, "verified", `claim ${c.id} must never be labeled verified`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MarkdownVaultProvider: version-keyed read memoization (wave 2 / finding 7)", () => {
  test("repeated readGraph() calls without a mutation hit the underlying store only once", async () => {
    const dir = makeTempDir();
    try {
      const store = new DefaultKnowledgeStore({ storeRoot: dir });
      await store.create({ type: "raw", title: "R", body: "b", category: "eng", provenance: { agent: "t" } });

      let listByTypeCalls = 0;
      const countingStore = Object.create(store);
      countingStore.listByType = (...args) => {
        listByTypeCalls += 1;
        return store.listByType(...args);
      };

      const provider = new MarkdownVaultProvider({ store: countingStore, storeRoot: dir, agent: "t" });

      // ALL_RECORD_TYPES in markdown-vault/index.js has 5 entries (raw,
      // compiled, concept, snapshot, person) -> readNodes()/readEdges() each
      // loop over all 5 via _allRecords(). readGraph() dispatches both
      // concurrently via Promise.all on a COLD memo; single-flight in-flight
      // promise memoization must make them share ONE underlying fetch, so
      // this must be exactly 5 listByType calls, not 10.
      const RECORD_TYPE_COUNT = 5;
      await provider.readGraph();
      const callsAfterFirst = listByTypeCalls;
      assert.equal(
        callsAfterFirst,
        RECORD_TYPE_COUNT,
        "cold readGraph() must issue exactly one underlying fetch (single-flight), not double-fetch via the readNodes/readEdges race"
      );

      await provider.readGraph();
      await provider.queryByType("note");
      assert.equal(listByTypeCalls, callsAfterFirst, "unchanged version must be served from the memo, not refetched");

      // Mutate -> cache version bumps -> next read must refetch.
      await store.create({ type: "raw", title: "R2", body: "b2", category: "eng", provenance: { agent: "t" } });
      await provider.readGraph();
      assert.equal(
        listByTypeCalls,
        callsAfterFirst + RECORD_TYPE_COUNT,
        "a mutation must invalidate the memo and trigger exactly one refetch"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("single-flight: a rejected in-flight fetch is cleared so the next call retries", async () => {
    const dir = makeTempDir();
    try {
      const store = new DefaultKnowledgeStore({ storeRoot: dir });
      await store.create({ type: "raw", title: "R", body: "b", category: "eng", provenance: { agent: "t" } });

      let calls = 0;
      const failOnceStore = Object.create(store);
      failOnceStore.listByType = (...args) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("transient failure"));
        return store.listByType(...args);
      };

      const provider = new MarkdownVaultProvider({ store: failOnceStore, storeRoot: dir, agent: "t" });
      await assert.rejects(() => provider.readGraph(), /transient failure/);

      const graph = await provider.readGraph();
      assert.ok(graph.nodes.length >= 1, "the next call must retry, not stay stuck on the cleared in-flight promise");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a store with no getCacheVersion() is never cached (always refetches)", async () => {
    const dir = makeTempDir();
    try {
      const store = new DefaultKnowledgeStore({ storeRoot: dir });
      await store.create({ type: "raw", title: "R", body: "b", category: "eng", provenance: { agent: "t" } });

      let listByTypeCalls = 0;
      // Wrap without exposing getCacheVersion, simulating a KnowledgeStoreAdapter
      // that doesn't support versioning.
      const noVersionStore = {
        listByType: (...args) => {
          listByTypeCalls += 1;
          return store.listByType(...args);
        },
        getLinks: (...args) => store.getLinks(...args),
      };

      const provider = new MarkdownVaultProvider({ store: noVersionStore, storeRoot: dir, agent: "t" });
      await provider.readGraph();
      const callsAfterFirst = listByTypeCalls;
      await provider.readGraph();
      assert.ok(listByTypeCalls > callsAfterFirst, "no getCacheVersion() means every read refetches");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
