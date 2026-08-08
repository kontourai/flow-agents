/**
 * Provider-graph → Knowledge-store ingest.
 *
 * Turns a provider's `{ nodes, edges }` graph (WorkItemProvider, GitRepoProvider,
 * …) into store records AND links, so the cached backlog keeps its blocker and
 * relation structure instead of flattening to disconnected items (#1214: a live
 * board's 385 edges previously ingested to zero links, leaving the Surface
 * projection structurally blind and blocker data provider-only).
 *
 * Edge types map to the link kinds `MarkdownVaultProvider.edgeTypeFor` maps
 * back — the exact inverse, so an ingested graph round-trips through
 * `readEdges()` with its types intact.
 *
 * @module adapters/shared/ingest-graph
 */

/** Provider edge type -> vault link kind (inverse of markdown-vault edgeTypeFor). */
const LINK_KIND_BY_EDGE_TYPE = Object.freeze({
  blocks: "blocks",
  supersedes: "supersedes",
  "evidence-of": "source",
  mentions: "appears-in",
  relates: "related",
});

/**
 * Ingest a provider graph into a knowledge store, preserving edges as links.
 *
 * Nodes are created first (building a provider-node-id → record-id map), then
 * edges are grouped by source record and written with `store.link()`. Failures
 * are collected and reported, never thrown mid-batch: a partly unusable graph
 * still ingests its usable part, and the report says exactly what was skipped
 * and why.
 *
 * @param {Object} store - KnowledgeStoreAdapter (create/link, e.g. DefaultKnowledgeStore)
 * @param {{ nodes: Array, edges: Array }} graph - Provider graph (readGraph() shape)
 * @param {Object} options
 * @param {string} options.agent - Provenance agent (required by the store)
 * @param {string} [options.itemCategory="backlog.item"] - Category for node records
 * @param {string} [options.itemType="raw"] - Record type for node records
 * @param {number} [options.bodyLimit=4000] - Truncate node bodies to this length
 * @returns {Promise<{ byNodeId: Map<string,string>, created: number, linked: number, skipped: Array<{ kind: "node"|"edge", ref: string, reason: string }> }>}
 */
export async function ingestProviderGraph(store, graph, options = {}) {
  const {
    agent,
    itemCategory = "backlog.item",
    itemType = "raw",
    bodyLimit = 4000,
  } = options;
  if (!agent) {
    throw new Error("ingestProviderGraph requires options.agent for store provenance");
  }
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  const byNodeId = new Map();
  const skipped = [];

  // Pass 1: nodes → records. Empty bodies normalize to the title (the store
  // requires a body field; no content is invented beyond the node's own title).
  for (const node of nodes) {
    const title = typeof node?.title === "string" && node.title.trim() ? node.title : String(node?.id ?? "untitled");
    const rawBody = typeof node?.body === "string" && node.body.trim() ? node.body : title;
    try {
      const recordId = await store.create({
        type: itemType,
        title: title.slice(0, 200),
        body: rawBody.slice(0, bodyLimit),
        category: itemCategory,
        provenance: { agent },
      });
      byNodeId.set(node.id, recordId);
    } catch (err) {
      skipped.push({ kind: "node", ref: String(node?.id), reason: err?.message || String(err) });
    }
  }

  // Pass 2: edges → links, grouped by source record.
  const linksBySource = new Map();
  for (const edge of edges) {
    const kind = LINK_KIND_BY_EDGE_TYPE[edge?.type];
    if (!kind) {
      skipped.push({ kind: "edge", ref: `${edge?.from}->${edge?.to}`, reason: `unmapped edge type: ${edge?.type}` });
      continue;
    }
    const fromRecord = byNodeId.get(edge.from);
    const toRecord = byNodeId.get(edge.to);
    if (!fromRecord || !toRecord) {
      skipped.push({ kind: "edge", ref: `${edge.from}->${edge.to}`, reason: "endpoint not ingested" });
      continue;
    }
    if (!linksBySource.has(fromRecord)) linksBySource.set(fromRecord, []);
    linksBySource.get(fromRecord).push({ target_id: toRecord, kind });
  }

  let linked = 0;
  for (const [recordId, links] of linksBySource) {
    try {
      await store.link(recordId, links, { agent, note: "ingest-graph edge pass" });
      linked += links.length;
    } catch (err) {
      skipped.push({ kind: "edge", ref: recordId, reason: err?.message || String(err) });
    }
  }

  return { byNodeId, created: byNodeId.size, linked, skipped };
}

export default { ingestProviderGraph };
