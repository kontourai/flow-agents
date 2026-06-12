/**
 * Knowledge Kit — Vector Similarity Adapter
 *
 * Provides a drop-in SimilarityDetector implementation backed by dense vector
 * embeddings (cosine similarity) instead of the default category-prefix /
 * link-overlap heuristic.
 *
 * SimilarityDetector interface (from adapters/flow-runner/index.js):
 *   async (concept: Record, candidates: Record[], store: KnowledgeStoreAdapter) => string[]
 *
 * Usage:
 *   import { createVectorSimilarityDetector } from './adapters/similarity-vector/index.js';
 *
 *   // Ollama (default):
 *   const detector = createVectorSimilarityDetector();
 *
 *   // Ollama with non-default model/host:
 *   const detector = createVectorSimilarityDetector({
 *     host: 'http://localhost:11434',
 *     model: 'nomic-embed-text',
 *     threshold: 0.60,
 *   });
 *
 *   // Injectable embed fn (for tests / custom providers):
 *   const detector = createVectorSimilarityDetector({
 *     embed: async (texts) => texts.map(() => [0.1, 0.9, 0.0]),
 *     threshold: 0.60,
 *   });
 *
 *   // Pass to synthesize:
 *   await runner.synthesize(conceptId, {
 *     proposedBody: '...',
 *     rationale: '...',
 *     similarityDetector: detector,
 *   });
 *
 * Zero npm dependencies — uses Node.js built-in fetch (Node >= 18).
 *
 * Fail-closed policy:
 *   If the embedding call fails (network error, non-200, malformed response),
 *   the detector throws an Error with code="EMBED_FAILURE". This is intentional:
 *   silently returning [] would look identical to "no similar records found" and
 *   mask infrastructure failures as legitimate empty clusters, blocking synthesis
 *   with a misleading MISSING_EVIDENCE rather than a clear infrastructure error.
 *
 * @module adapters/similarity-vector
 */

// ---------------------------------------------------------------------------
// Pure cosine similarity (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Compute the cosine similarity between two equal-length numeric vectors.
 *
 * Returns a value in [-1, 1]:
 *   1.0  — identical direction
 *   0.0  — orthogonal
 *  -1.0  — opposite direction
 *
 * Edge cases:
 *   - Zero-magnitude vector(s): returns 0 (no similarity signal).
 *   - Empty or unequal-length vectors: returns 0.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ---------------------------------------------------------------------------
// Ollama embed call
// ---------------------------------------------------------------------------

/**
 * Call ollama's /api/embed endpoint.
 *
 * Throws an Error with code="EMBED_FAILURE" on any failure.
 *
 * @param {string} host
 * @param {string} model
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function ollamaEmbed(host, model, texts) {
  const url = `${host}/api/embed`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
    });
  } catch (cause) {
    const err = new Error(
      `EMBED_FAILURE: embedding call to ${url} failed — ${cause.message}`
    );
    err.code = "EMBED_FAILURE";
    err.cause = cause;
    throw err;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    const err = new Error(
      `EMBED_FAILURE: embedding call to ${url} returned HTTP ${response.status}: ${body}`
    );
    err.code = "EMBED_FAILURE";
    throw err;
  }

  let data;
  try {
    data = await response.json();
  } catch (cause) {
    const err = new Error(
      `EMBED_FAILURE: embedding response from ${url} was not valid JSON — ${cause.message}`
    );
    err.code = "EMBED_FAILURE";
    err.cause = cause;
    throw err;
  }

  // ollama /api/embed returns { embeddings: number[][] }
  if (!data.embeddings || !Array.isArray(data.embeddings)) {
    const err = new Error(
      `EMBED_FAILURE: embedding response missing .embeddings array (got: ${JSON.stringify(Object.keys(data || {}))})`
    );
    err.code = "EMBED_FAILURE";
    throw err;
  }

  if (data.embeddings.length !== texts.length) {
    const err = new Error(
      `EMBED_FAILURE: expected ${texts.length} embedding(s), got ${data.embeddings.length}`
    );
    err.code = "EMBED_FAILURE";
    throw err;
  }

  return data.embeddings;
}

// ---------------------------------------------------------------------------
// createVectorSimilarityDetector
// ---------------------------------------------------------------------------

/**
 * Create a SimilarityDetector backed by dense vector embeddings.
 *
 * The returned detector satisfies the SimilarityDetector interface:
 *   async (concept, candidates, store) => string[]
 *
 * @param {object} [options]
 * @param {((texts: string[]) => Promise<number[][]>)} [options.embed]
 *   Injectable embedding function. When provided, `host` and `model` are
 *   ignored. Signature: async (texts: string[]) => number[][]
 *   Must return one vector per input text.
 * @param {string} [options.host="http://localhost:11434"]
 *   Ollama server base URL. Used when `embed` is not provided.
 * @param {string} [options.model="nomic-embed-text"]
 *   Embedding model name passed to ollama. Used when `embed` is not provided.
 * @param {number} [options.threshold=0.60]
 *   Minimum cosine similarity score for a candidate to be included.
 *   Range: [-1, 1]. Default 0.60 is calibrated for nomic-embed-text where
 *   semantically related texts from the same domain typically score ≥ 0.70
 *   and unrelated texts score < 0.50.
 * @param {((record: object) => string)} [options.text]
 *   Extractor that converts a store record to the text to embed.
 *   Default: `record.title + "\n" + record.body`.
 * @returns {(concept: object, candidates: object[], store: object) => Promise<string[]>}
 */
export function createVectorSimilarityDetector(options = {}) {
  const {
    embed: injectEmbed = null,
    host = "http://localhost:11434",
    model = "nomic-embed-text",
    threshold = 0.60,
    text: extractText = defaultTextExtractor,
  } = options;

  // Resolve the actual embed function once (avoid re-resolving on each call)
  const embedFn = injectEmbed
    ? injectEmbed
    : (texts) => ollamaEmbed(host, model, texts);

  /**
   * SimilarityDetector: returns candidate IDs whose cosine similarity to the
   * concept embedding meets or exceeds `threshold`.
   *
   * Fail-closed: any embedding failure throws EMBED_FAILURE rather than
   * silently returning [].
   *
   * @param {object} concept
   * @param {object[]} candidates
   * @param {object} _store  (not used by vector detector; kept for interface compat)
   * @returns {Promise<string[]>}
   */
  async function vectorSimilarityDetector(concept, candidates, _store) {
    if (!candidates || candidates.length === 0) {
      return [];
    }

    // Exclude retired records from the working set (Addendum B — R3)
    const activeCandidates = candidates.filter(
      (c) => (c.status || "active") !== "retired"
    );

    if (activeCandidates.length === 0) {
      return [];
    }

    const conceptText = extractText(concept);

    // Build the batch: concept first, then all active candidates.
    // One round-trip minimises latency and keeps the batch API simple.
    const allTexts = [conceptText, ...activeCandidates.map(extractText)];

    // Embedding call — throws EMBED_FAILURE on any infrastructure error.
    const embeddings = await embedFn(allTexts);

    // Validate count: the embed fn must return one vector per input text.
    // A count mismatch would produce silent wrong results (undefined vectors
    // scoring 0 and being excluded) — throw EMBED_FAILURE instead.
    if (!Array.isArray(embeddings) || embeddings.length !== allTexts.length) {
      const err = new Error(
        `EMBED_FAILURE: embed function returned ${Array.isArray(embeddings) ? embeddings.length : typeof embeddings} vector(s) but expected ${allTexts.length} (1 concept + ${activeCandidates.length} active candidates)`
      );
      err.code = 'EMBED_FAILURE';
      throw err;
    }

    const conceptVec = embeddings[0];
    const similar = [];

    for (let i = 0; i < activeCandidates.length; i++) {
      const candidateVec = embeddings[i + 1];
      const score = cosineSimilarity(conceptVec, candidateVec);
      if (score >= threshold) {
        similar.push(activeCandidates[i].id);
      }
    }

    return similar;
  }

  return vectorSimilarityDetector;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default text extractor: title + newline + body.
 * Gracefully handles missing fields.
 *
 * @param {object} record
 * @returns {string}
 */
function defaultTextExtractor(record) {
  const title = record?.title || "";
  const body = record?.body || "";
  return `${title}\n${body}`;
}

export default createVectorSimilarityDetector;
