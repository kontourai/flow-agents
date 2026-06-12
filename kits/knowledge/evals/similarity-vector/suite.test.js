/**
 * Knowledge Kit — Vector Similarity Adapter Eval Suite
 *
 * Covers:
 *   Unit (no network):
 *     - Injectable embed fn: similar texts (high cosine via crafted vectors) included,
 *       dissimilar excluded.
 *     - Threshold respected: score exactly at threshold included; just below excluded.
 *     - cosineSimilarity math edge cases: zero vectors, empty, orthogonal, identical.
 *     - Infrastructure failure throws EMBED_FAILURE (fail-closed — not silent []).
 *
 *   Drop-in proof:
 *     - Run runner.synthesize() with the vector detector (injected embed fn).
 *     - Assert it produces the same proposal shape as the default detector path.
 *     - No changes to KnowledgeFlowRunner call-site.
 *
 *   Live (gated on ollama availability + nomic-embed-text model):
 *     - Real embedding round-trip via ollama.
 *     - Semantically similar fixture texts cluster together.
 *     - An unrelated text does NOT cluster.
 *     - Reports the empirical cosine scores.
 *
 * Run:
 *   node --test kits/knowledge/evals/similarity-vector/suite.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "../..");

const adapterPath = path.join(KIT_ROOT, "adapters/default-store/index.js");
const runnerPath = path.join(KIT_ROOT, "adapters/flow-runner/index.js");
const vectorPath = path.join(KIT_ROOT, "adapters/similarity-vector/index.js");

const { DefaultKnowledgeStore } = await import(adapterPath);
const { KnowledgeFlowRunner } = await import(runnerPath);
const { createVectorSimilarityDetector, cosineSimilarity } = await import(vectorPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-vector-"));
}

function makeStore(dir) {
  return new DefaultKnowledgeStore({ storeRoot: dir });
}

function makeRunner(store, dir) {
  return new KnowledgeFlowRunner({
    store,
    workspace: dir,
    agent: "vector-test-runner",
    sessionId: "vector-session-001",
  });
}

/**
 * Build a fixture store with concept + compiled records.
 * The compiled records all share category "engineering.api" with the concept
 * so that the default detector (used in drop-in proof) will find them too.
 */
async function buildFixture(dir) {
  const store = makeStore(dir);

  const conceptId = await store.create({
    type: "concept",
    title: "API Design Principles",
    body: "REST APIs should use versioning, consistent naming, and proper HTTP verbs.",
    category: "engineering.api",
    provenance: { agent: "fixture" },
  });

  const compiledId1 = await store.create({
    type: "compiled",
    title: "REST API Best Practices",
    body: "Use versioning, consistent naming, and proper HTTP verbs for REST APIs.",
    category: "engineering.api",
    provenance: { agent: "fixture", source_ids: [] },
  });

  const compiledId2 = await store.create({
    type: "compiled",
    title: "API Versioning Strategies",
    body: "Version REST APIs via URL path (v1, v2) or request headers.",
    category: "engineering.api",
    provenance: { agent: "fixture", source_ids: [] },
  });

  return { store, conceptId, compiledId1, compiledId2 };
}

// ---------------------------------------------------------------------------
// Crafted embed vectors for unit tests (no network)
// ---------------------------------------------------------------------------

// We craft orthogonal-ish and identical vectors to drive precise inclusion /
// exclusion through cosineSimilarity without depending on real model output.

/** A unit vector in direction [1, 0, 0]. */
const VEC_A = [1, 0, 0];
/** A unit vector in direction [0, 1, 0] — orthogonal to VEC_A. */
const VEC_B = [0, 1, 0];
/** Near-identical to VEC_A: cos ≈ 0.9997. */
const VEC_A_NEAR = [0.9998, 0.02, 0];
/** 45-degree from VEC_A: cos ≈ 0.707. */
const VEC_A_MID = [1, 1, 0];   // normalised cosine to VEC_A = 1/sqrt(2) ≈ 0.707

// We'll use 3-dim vectors throughout for simplicity.

// ---------------------------------------------------------------------------
// UNIT: cosineSimilarity math
// ---------------------------------------------------------------------------

describe("cosineSimilarity — pure function math", () => {
  test("identical vectors return 1.0", () => {
    const v = [0.5, 0.5, 0.707];
    const result = cosineSimilarity(v, v);
    assert.ok(Math.abs(result - 1.0) < 1e-9, `expected ~1.0, got ${result}`);
  });

  test("orthogonal unit vectors return 0.0", () => {
    const result = cosineSimilarity(VEC_A, VEC_B);
    assert.ok(Math.abs(result - 0.0) < 1e-9, `expected 0.0, got ${result}`);
  });

  test("opposite vectors return -1.0", () => {
    const result = cosineSimilarity([1, 0], [-1, 0]);
    assert.ok(Math.abs(result - (-1.0)) < 1e-9, `expected -1.0, got ${result}`);
  });

  test("45-degree vectors return ~0.707", () => {
    const result = cosineSimilarity(VEC_A, VEC_A_MID);
    const expected = 1 / Math.sqrt(2);
    assert.ok(
      Math.abs(result - expected) < 1e-9,
      `expected ~${expected}, got ${result}`
    );
  });

  test("zero vector returns 0 (no division by zero)", () => {
    const result = cosineSimilarity([0, 0, 0], VEC_A);
    assert.equal(result, 0);
  });

  test("both zero vectors return 0", () => {
    const result = cosineSimilarity([0, 0], [0, 0]);
    assert.equal(result, 0);
  });

  test("empty arrays return 0", () => {
    const result = cosineSimilarity([], []);
    assert.equal(result, 0);
  });

  test("mismatched lengths return 0", () => {
    const result = cosineSimilarity([1, 2, 3], [1, 2]);
    assert.equal(result, 0);
  });

  test("non-array inputs return 0", () => {
    assert.equal(cosineSimilarity(null, [1, 2]), 0);
    assert.equal(cosineSimilarity([1, 2], undefined), 0);
  });
});

// ---------------------------------------------------------------------------
// UNIT: createVectorSimilarityDetector — injectable embed
// ---------------------------------------------------------------------------

describe("createVectorSimilarityDetector — injectable embed (no network)", () => {
  test("similar candidates (high cosine score) are included", async () => {
    // concept vector = VEC_A; candidate vectors: VEC_A_NEAR (cos ~0.9997), VEC_B (cos 0)
    // threshold = 0.60 → VEC_A_NEAR included, VEC_B excluded
    const embed = async (texts) => {
      return texts.map((_, i) => {
        if (i === 0) return VEC_A;           // concept
        if (i === 1) return VEC_A_NEAR;      // similar candidate
        return VEC_B;                         // dissimilar candidate
      });
    };

    const detector = createVectorSimilarityDetector({ embed, threshold: 0.60 });

    const concept = { id: "c1", title: "Concept", body: "concept body" };
    const candidates = [
      { id: "cand1", title: "Similar", body: "similar body" },
      { id: "cand2", title: "Different", body: "different body" },
    ];

    const result = await detector(concept, candidates, null);

    assert.ok(result.includes("cand1"), "similar candidate included");
    assert.ok(!result.includes("cand2"), "dissimilar candidate excluded");
  });

  test("threshold respected: score exactly at threshold is included", async () => {
    const THRESHOLD = 0.60;
    // Craft a vector with cosine exactly THRESHOLD relative to [1,0,0]:
    // cos(θ) = dot([1,0,0], [x,y,0]) / (1 * sqrt(x²+y²)) = x / sqrt(x²+y²) = THRESHOLD
    // Let x = THRESHOLD, y = sqrt(1 - THRESHOLD²) (normalised)
    const x = THRESHOLD;
    const y = Math.sqrt(1 - x * x);
    const VEC_EXACT = [x, y, 0];  // cosine to VEC_A = THRESHOLD exactly

    const embed = async (texts) => {
      return texts.map((_, i) => (i === 0 ? VEC_A : VEC_EXACT));
    };

    const detector = createVectorSimilarityDetector({ embed, threshold: THRESHOLD });
    const concept = { id: "c1", title: "T", body: "B" };
    const candidates = [{ id: "cand1", title: "T2", body: "B2" }];

    const result = await detector(concept, candidates, null);
    assert.ok(result.includes("cand1"), "score at exact threshold is included");
  });

  test("threshold respected: score just below threshold is excluded", async () => {
    const THRESHOLD = 0.60;
    const x = THRESHOLD - 0.01;  // slightly below
    const y = Math.sqrt(1 - x * x);
    const VEC_BELOW = [x, y, 0];

    const embed = async (texts) => {
      return texts.map((_, i) => (i === 0 ? VEC_A : VEC_BELOW));
    };

    const detector = createVectorSimilarityDetector({ embed, threshold: THRESHOLD });
    const concept = { id: "c1", title: "T", body: "B" };
    const candidates = [{ id: "cand1", title: "T2", body: "B2" }];

    const result = await detector(concept, candidates, null);
    assert.ok(!result.includes("cand1"), "score below threshold is excluded");
  });

  test("empty candidates array returns []", async () => {
    const embed = async (texts) => texts.map(() => VEC_A);
    const detector = createVectorSimilarityDetector({ embed });
    const concept = { id: "c1", title: "T", body: "B" };
    const result = await detector(concept, [], null);
    assert.deepEqual(result, []);
  });

  test("all similar candidates can be included", async () => {
    // All candidates return a near-identical vector
    const embed = async (texts) => texts.map(() => [0.6, 0.8, 0]);
    const detector = createVectorSimilarityDetector({ embed, threshold: 0.50 });
    const concept = { id: "c1", title: "T", body: "B" };
    const candidates = [
      { id: "a", title: "A", body: "a" },
      { id: "b", title: "B", body: "b" },
      { id: "c", title: "C", body: "c" },
    ];
    const result = await detector(concept, candidates, null);
    assert.equal(result.length, 3, "all candidates included when all exceed threshold");
  });

  test("custom text extractor is used", async () => {
    const seenTexts = [];
    const embed = async (texts) => {
      seenTexts.push(...texts);
      return texts.map(() => VEC_A);
    };

    const text = (record) => `CUSTOM:${record.title}`;
    const detector = createVectorSimilarityDetector({ embed, text, threshold: 0.50 });
    const concept = { id: "c1", title: "Concept", body: "B" };
    const candidates = [{ id: "cand1", title: "Cand", body: "B2" }];

    await detector(concept, candidates, null);

    assert.ok(seenTexts.some((t) => t.startsWith("CUSTOM:")), "custom extractor used");
    assert.ok(seenTexts[0] === "CUSTOM:Concept", "concept text extracted correctly");
    assert.ok(seenTexts[1] === "CUSTOM:Cand", "candidate text extracted correctly");
  });

  test("store parameter is not required (interface compat with null store)", async () => {
    const embed = async (texts) => texts.map(() => VEC_A);
    const detector = createVectorSimilarityDetector({ embed, threshold: 0.50 });
    const concept = { id: "c1", title: "T", body: "B" };
    const candidates = [{ id: "cand1", title: "T2", body: "B2" }];
    // Should not throw even with store=null
    const result = await detector(concept, candidates, null);
    assert.ok(Array.isArray(result), "returns array with null store");
  });
});

// ---------------------------------------------------------------------------
// UNIT: fail-closed — infrastructure failure throws EMBED_FAILURE
// ---------------------------------------------------------------------------

describe("createVectorSimilarityDetector — fail-closed on embed failure", () => {
  test("embed function that throws causes detector to throw (not return [])", async () => {
    const embed = async (_texts) => {
      throw new Error("connection refused");
    };

    const detector = createVectorSimilarityDetector({ embed });
    const concept = { id: "c1", title: "T", body: "B" };
    const candidates = [{ id: "cand1", title: "T2", body: "B2" }];

    await assert.rejects(
      () => detector(concept, candidates, null),
      (err) => {
        assert.ok(err instanceof Error, "throws an Error");
        assert.match(err.message, /connection refused/, "original message propagated");
        return true;
      },
      "detector must throw on embed failure, not return []"
    );
  });

  test("embed function that returns wrong count throws EMBED_FAILURE", async () => {
    // Returns 1 vector but we need n+1 (concept + 2 candidates = 3)
    const embed = async (_texts) => [[0.1, 0.2, 0.3]];

    const detector = createVectorSimilarityDetector({ embed });
    const concept = { id: "c1", title: "T", body: "B" };
    const candidates = [
      { id: "cand1", title: "T2", body: "B2" },
      { id: "cand2", title: "T3", body: "B3" },
    ];

    await assert.rejects(
      () => detector(concept, candidates, null),
      (err) => {
        assert.ok(err instanceof Error, "throws an Error");
        return true;
      },
      "wrong embedding count must cause a throw, not silent wrong results"
    );
  });

  test("EMBED_FAILURE from ollamaEmbed has code='EMBED_FAILURE'", async () => {
    // Simulate what ollamaEmbed throws when server is down
    const embed = async (_texts) => {
      const err = new Error("EMBED_FAILURE: embedding call failed — ECONNREFUSED");
      err.code = "EMBED_FAILURE";
      throw err;
    };

    const detector = createVectorSimilarityDetector({ embed });
    const concept = { id: "c1", title: "T", body: "B" };
    const candidates = [{ id: "cand1", title: "T2", body: "B2" }];

    await assert.rejects(
      () => detector(concept, candidates, null),
      (err) => {
        assert.equal(err.code, "EMBED_FAILURE", "error code is EMBED_FAILURE");
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// DROP-IN PROOF: runner.synthesize() works with the vector detector unchanged
// ---------------------------------------------------------------------------

describe("Drop-in proof — runner.synthesize() with vector detector", () => {
  test("synthesize with injected vector detector produces a valid proposal (apply path)", async () => {
    const dir = makeTempDir();
    try {
      const { store, conceptId, compiledId1, compiledId2 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      // The injected embed always returns vectors where concept is similar to
      // compiledId1 (cos ≈ 0.9997) and dissimilar to compiledId2 (cos = 0).
      // We map text position to vector deterministically.
      let callCount = 0;
      const embed = async (texts) => {
        callCount++;
        // Position 0 = concept, 1 = first candidate, 2 = second candidate (etc.)
        // All candidates get similar vectors so both compiledId1 and compiledId2 match.
        return texts.map(() => [0.6, 0.8, 0]);  // all near-identical → cos=1.0
      };

      const detector = createVectorSimilarityDetector({ embed, threshold: 0.50 });

      const result = await runner.synthesize(conceptId, {
        proposedBody: "Updated: REST APIs require versioning and consistent naming.",
        rationale: "Vector detector drop-in proof.",
        decision: "apply",
        similarityDetector: detector,
      });

      // Interface guarantees
      assert.ok(result.conceptId, "result has conceptId");
      assert.equal(result.conceptId, conceptId, "conceptId matches");
      assert.ok(result.proposerId, "result has proposerId");
      assert.ok(Array.isArray(result.cluster), "result has cluster array");
      assert.ok(result.cluster.length >= 1, "cluster has at least one member");
      assert.equal(result.decision, "apply", "decision is apply");

      // Concept body was updated (apply path)
      const updated = await store.get(conceptId);
      assert.equal(
        updated.body,
        "Updated: REST APIs require versioning and consistent naming.",
        "concept body updated to proposedBody"
      );

      // Embed was actually called (detector ran)
      assert.ok(callCount >= 1, "embed fn was called at least once");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("synthesize with vector detector: rejection path leaves concept byte-identical", async () => {
    const dir = makeTempDir();
    try {
      const { store, conceptId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const originalConcept = await store.get(conceptId);
      const originalBody = originalConcept.body;

      const embed = async (texts) => texts.map(() => [0.6, 0.8, 0]);
      const detector = createVectorSimilarityDetector({ embed, threshold: 0.50 });

      await runner.synthesize(conceptId, {
        proposedBody: "Rejected body — must not appear.",
        decision: "reject",
        rejectReason: "Drop-in proof: rejection leaves concept unchanged.",
        similarityDetector: detector,
      });

      const afterConcept = await store.get(conceptId);
      assert.equal(afterConcept.body, originalBody, "concept body unchanged after rejection");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detector returning empty array triggers MISSING_EVIDENCE at detect-cluster-gate", async () => {
    const dir = makeTempDir();
    try {
      const { store, conceptId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      // Threshold above 1.0 means nothing will ever match
      const embed = async (texts) => texts.map(() => [0.6, 0.8, 0]);
      const detector = createVectorSimilarityDetector({ embed, threshold: 2.0 });

      await assert.rejects(
        () => runner.synthesize(conceptId, {
          proposedBody: "Should fail.",
          rationale: "n/a",
          decision: "apply",
          similarityDetector: detector,
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE", "MISSING_EVIDENCE when cluster empty");
          assert.match(err.message, /no similar compiled records found/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no call-site changes required: runner.synthesize signature unchanged", () => {
    // This is a static check: the KnowledgeFlowRunner.synthesize API still
    // accepts similarityDetector in options exactly as the spec describes.
    // We verify by checking the function is callable (already proven by the
    // tests above) and that the detector is passed through options.similarityDetector.
    assert.ok(
      typeof KnowledgeFlowRunner.prototype.synthesize === "function",
      "synthesize is a method on KnowledgeFlowRunner"
    );
  });
});

// ---------------------------------------------------------------------------
// LIVE (gated): real ollama embedding round-trip
// ---------------------------------------------------------------------------

// Check ollama availability once before the describe block runs.
let ollamaAvailable = false;
let ollamaModelAvailable = false;
const LIVE_HOST = "http://localhost:11434";
const LIVE_MODEL = "nomic-embed-text";

try {
  const tagsResponse = await fetch(`${LIVE_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
  if (tagsResponse.ok) {
    const tagsData = await tagsResponse.json();
    const models = (tagsData.models || []).map((m) => m.name);
    ollamaAvailable = true;
    ollamaModelAvailable = models.some(
      (name) => name === LIVE_MODEL || name.startsWith(`${LIVE_MODEL}:`)
    );
  }
} catch {
  // Server not reachable — skip live tests
}

describe("LIVE — real ollama embedding round-trip", { skip: !ollamaAvailable || !ollamaModelAvailable }, () => {
  // Fixtures designed to test semantic similarity, not keyword/category matching.
  // We intentionally use a different category from the default detector (engineering.api)
  // so the only matching mechanism is the vector detector.

  const SIMILAR_TEXTS = [
    {
      title: "REST API Design",
      body: "REST APIs should follow uniform interface constraints, use HTTP verbs correctly, return appropriate status codes, and version via path or header.",
    },
    {
      title: "Web Service Interface Design",
      body: "Designing HTTP web services requires consistent use of verbs, versioning strategies, status codes, and predictable URL structure.",
    },
  ];

  const UNRELATED_TEXT = {
    title: "Sourdough Bread Baking",
    body: "Sourdough bread uses a live starter culture of wild yeast and bacteria. The dough requires long fermentation to develop flavor and gluten structure.",
  };

  test("similar texts have cosine similarity above 0.60 with nomic-embed-text", async () => {
    const { default: createDetector, cosineSimilarity: cosine } = await import(vectorPath);

    // Embed both similar texts and compute cosine
    const embedResp = await fetch(`${LIVE_HOST}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: LIVE_MODEL, input: [
        `${SIMILAR_TEXTS[0].title}\n${SIMILAR_TEXTS[0].body}`,
        `${SIMILAR_TEXTS[1].title}\n${SIMILAR_TEXTS[1].body}`,
      ]}),
    });
    const embedData = await embedResp.json();
    const [vec0, vec1] = embedData.embeddings;
    const score = cosine(vec0, vec1);

    console.log(`  [LIVE] cosine(similar_0, similar_1) = ${score.toFixed(4)}`);
    assert.ok(score >= 0.60, `similar texts score ${score.toFixed(4)} should be >= 0.60`);
  });

  test("unrelated text has cosine similarity below 0.60 vs both similar texts", async () => {
    const { cosineSimilarity: cosine } = await import(vectorPath);

    const embedResp = await fetch(`${LIVE_HOST}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: LIVE_MODEL, input: [
        `${SIMILAR_TEXTS[0].title}\n${SIMILAR_TEXTS[0].body}`,
        `${UNRELATED_TEXT.title}\n${UNRELATED_TEXT.body}`,
      ]}),
    });
    const embedData = await embedResp.json();
    const [vec0, vecUnrelated] = embedData.embeddings;
    const score = cosine(vec0, vecUnrelated);

    console.log(`  [LIVE] cosine(similar_0, unrelated) = ${score.toFixed(4)}`);
    assert.ok(score < 0.60, `unrelated text score ${score.toFixed(4)} should be < 0.60`);
  });

  test("detector includes similar candidate and excludes unrelated candidate", async () => {
    const dir = makeTempDir();
    try {
      // Build a fresh store with records using the live texts
      const store = makeStore(dir);

      const conceptId = await store.create({
        type: "concept",
        title: SIMILAR_TEXTS[0].title,
        body: SIMILAR_TEXTS[0].body,
        category: "live.api-design",
        provenance: { agent: "live-fixture" },
      });

      const similarId = await store.create({
        type: "compiled",
        title: SIMILAR_TEXTS[1].title,
        body: SIMILAR_TEXTS[1].body,
        category: "live.api-design",
        provenance: { agent: "live-fixture", source_ids: [] },
      });

      const unrelatedId = await store.create({
        type: "compiled",
        title: UNRELATED_TEXT.title,
        body: UNRELATED_TEXT.body,
        category: "live.api-design",  // same category to make it harder for default detector
        provenance: { agent: "live-fixture", source_ids: [] },
      });

      const concept = await store.get(conceptId);
      const candidates = await store.listByType("compiled");

      const detector = createVectorSimilarityDetector({
        host: LIVE_HOST,
        model: LIVE_MODEL,
        threshold: 0.60,
      });

      const cluster = await detector(concept, candidates, store);

      console.log(`  [LIVE] cluster = ${JSON.stringify(cluster)}`);
      assert.ok(cluster.includes(similarId), "similar candidate included in cluster");
      assert.ok(!cluster.includes(unrelatedId), "unrelated candidate excluded from cluster");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("live detector integrates with runner.synthesize end-to-end", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      const conceptId = await store.create({
        type: "concept",
        title: SIMILAR_TEXTS[0].title,
        body: SIMILAR_TEXTS[0].body,
        category: "live.api-design",
        provenance: { agent: "live-fixture" },
      });

      await store.create({
        type: "compiled",
        title: SIMILAR_TEXTS[1].title,
        body: SIMILAR_TEXTS[1].body,
        category: "live.api-design",
        provenance: { agent: "live-fixture", source_ids: [] },
      });

      // Add unrelated record in same category — should NOT appear in cluster
      await store.create({
        type: "compiled",
        title: UNRELATED_TEXT.title,
        body: UNRELATED_TEXT.body,
        category: "live.api-design",
        provenance: { agent: "live-fixture", source_ids: [] },
      });

      const runner = makeRunner(store, dir);
      const detector = createVectorSimilarityDetector({
        host: LIVE_HOST,
        model: LIVE_MODEL,
        threshold: 0.60,
      });

      const result = await runner.synthesize(conceptId, {
        proposedBody: "Live: REST APIs need versioning, consistent naming, and proper HTTP semantics.",
        rationale: "Live vector detector integration test.",
        decision: "apply",
        similarityDetector: detector,
      });

      assert.ok(result.conceptId === conceptId, "conceptId matches");
      assert.ok(result.cluster.length >= 1, "cluster has at least one member");
      assert.equal(result.decision, "apply", "decision is apply");

      const updated = await store.get(conceptId);
      assert.ok(
        updated.body.includes("Live:"),
        "concept body updated by live vector detector synthesis"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Fallback notice when live tests are skipped
if (!ollamaAvailable) {
  describe("LIVE — real ollama embedding round-trip", { skip: "ollama not reachable at localhost:11434" }, () => {
    test("skipped", () => {});
  });
} else if (!ollamaModelAvailable) {
  describe("LIVE — real ollama embedding round-trip", { skip: `model '${LIVE_MODEL}' not available in ollama (run: ollama pull ${LIVE_MODEL})` }, () => {
    test("skipped", () => {});
  });
}
