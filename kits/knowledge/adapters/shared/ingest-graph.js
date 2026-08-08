/**
 * Provider-graph → Knowledge-store ingest.
 *
 * Turns a provider's `{ nodes, edges }` graph (WorkItemProvider, GitRepoProvider,
 * …) into store records AND links, so the cached backlog keeps its blocker and
 * relation structure instead of flattening to disconnected items (#1214: a live
 * board's 385 edges previously ingested to zero links, leaving the Surface
 * projection structurally blind and blocker data provider-only).
 *
 * Re-ingest is an UPSERT, not a duplicate: each provider node id is slugified
 * into a store alias, and a node whose alias already resolves updates the
 * existing record in place (title/body/tags refresh, `updated_at` bumps —
 * which is exactly what the pull-work TTL check reads). The alias also gives
 * records a durable provider identity across sessions.
 *
 * Provider bodies are untrusted text: ingest suppresses the store's
 * [[wikilink]] extraction (`parse_wikilinks: false`) so issue bodies cannot
 * inject graph edges.
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
  "merged-into": "merged-into",
  supersedes: "supersedes",
  "evidence-of": "source",
  mentions: "appears-in",
  relates: "related",
});

/**
 * Slugify a provider node id into a store alias (SLUG_PATTERN allows
 * [a-z0-9._/-], no leading/trailing separator). `issue:7` → `issue-7`.
 * Returns null when nothing slug-safe remains.
 */
export function aliasForNodeId(nodeId) {
  const slug = String(nodeId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return slug.length ? slug : null;
}

/** Tags carried onto the record from provider node attributes (labels + state). */
function tagsForNode(node) {
  const tags = [];
  const attrs = node?.attributes ?? {};
  if (Array.isArray(attrs.labels)) {
    for (const label of attrs.labels) if (typeof label === "string" && label) tags.push(label);
  }
  if (typeof attrs.state === "string" && attrs.state) tags.push(attrs.state.toLowerCase());
  return tags;
}

/**
 * Ingest a provider graph into a knowledge store, preserving edges as links.
 *
 * Nodes are upserted first (building a provider-node-id → record-id map), then
 * edges are grouped by source record and written with `store.link()` (itself an
 * idempotent merge, so re-ingesting the same edges is a no-op). Failures are
 * collected and reported, never thrown mid-batch: a partly unusable graph still
 * ingests its usable part, and the report says exactly what was skipped and why.
 *
 * @param {Object} store - KnowledgeStoreAdapter (create/update/link/get, e.g. DefaultKnowledgeStore)
 * @param {{ nodes: Array, edges: Array }} graph - Provider graph (readGraph() shape)
 * @param {Object} options
 * @param {string} options.agent - Provenance agent (required by the store)
 * @param {string} [options.itemCategory="backlog.item"] - Category for node records
 * @param {string} [options.itemType="raw"] - Record type for node records
 * @param {number} [options.bodyLimit=4000] - Truncate node bodies to this length
 * @param {Object} [options.board] - Board snapshot record to upsert alongside the
 *   items: `{ title, body, alias = "board", category = "backlog.board" }`. Its
 *   `updated_at` refresh is what the pull-work TTL check reads on the next pass.
 * @returns {Promise<{ byNodeId: Map<string,string>, created: number, updated: number,
 *   linked: number, boardRecordId: string|null,
 *   skipped: Array<{ kind: "node"|"edge"|"board", ref: string, reason: string }> }>}
 */
export async function ingestProviderGraph(store, graph, options = {}) {
  const {
    agent,
    itemCategory = "backlog.item",
    itemType = "raw",
    bodyLimit = 4000,
    board,
  } = options;
  if (!agent) {
    throw new Error("ingestProviderGraph requires options.agent for store provenance");
  }
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  const byNodeId = new Map();
  const skipped = [];
  let created = 0;
  let updated = 0;

  const upsert = async ({ nodeRef, alias, title, body, tags, type, category }) => {
    const existing = alias ? await store.get(alias) : null;
    if (existing) {
      await store.update(
        existing.id,
        { title, body, ...(tags.length ? { tags } : {}), parse_wikilinks: false },
        { agent, note: "ingest-graph refresh" },
      );
      updated += 1;
      return existing.id;
    }
    const recordId = await store.create({
      type,
      title,
      body,
      category,
      ...(alias ? { aliases: [alias] } : {}),
      ...(tags.length ? { tags } : {}),
      parse_wikilinks: false,
      provenance: { agent },
    });
    created += 1;
    return recordId;
  };

  // Pass 1: nodes → records (upsert by alias). Empty bodies normalize to the
  // title (the store requires a body; no content is invented beyond the node's
  // own title).
  for (const node of nodes) {
    if (byNodeId.has(node?.id)) {
      skipped.push({ kind: "node", ref: String(node?.id), reason: "duplicate node id in graph" });
      continue;
    }
    const title = typeof node?.title === "string" && node.title.trim() ? node.title : String(node?.id ?? "untitled");
    const rawBody = typeof node?.body === "string" && node.body.trim() ? node.body : title;
    try {
      const recordId = await upsert({
        nodeRef: node?.id,
        alias: aliasForNodeId(node?.id),
        title: title.slice(0, 200),
        body: rawBody.slice(0, bodyLimit),
        tags: tagsForNode(node),
        type: itemType,
        category: itemCategory,
      });
      byNodeId.set(node.id, recordId);
    } catch (err) {
      skipped.push({ kind: "node", ref: String(node?.id), reason: err?.message || String(err) });
    }
  }

  // Board snapshot upsert (optional): gives the pull-work TTL loop its record.
  let boardRecordId = null;
  if (board && typeof board === "object") {
    try {
      boardRecordId = await upsert({
        nodeRef: "board",
        alias: aliasForNodeId(board.alias ?? "board"),
        title: String(board.title ?? "board snapshot").slice(0, 200),
        body: String(board.body ?? `${byNodeId.size} items ingested`).slice(0, bodyLimit),
        tags: [],
        type: "snapshot",
        category: board.category ?? "backlog.board",
      });
    } catch (err) {
      skipped.push({ kind: "board", ref: String(board.alias ?? "board"), reason: err?.message || String(err) });
    }
  }

  // Pass 2: edges → links, grouped by source record. store.link() merges
  // idempotently on (target_id, kind), so re-ingested edges do not duplicate.
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
      skipped.push({ kind: "edge", ref: `${edge.from}->${edge.to}`, reason: "endpoint not ingested (missing or failed node)" });
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

  return { byNodeId, created, updated, linked, boardRecordId, skipped };
}

export default { ingestProviderGraph, aliasForNodeId };
