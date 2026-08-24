/**
 * Provider-graph → Knowledge-store ingest.
 *
 * Turns a provider's `{ nodes, edges }` graph (WorkItemProvider, GitRepoProvider,
 * …) into store records AND links, so the cached backlog keeps its blocker and
 * relation structure instead of flattening to disconnected items (#1214: a live
 * board's 385 edges previously ingested to zero links, leaving the Surface
 * projection structurally blind and blocker data provider-only).
 *
 * OWNERSHIP MODEL: records in `itemCategory` (and the board record in its
 * category) are PROVIDER-OWNED — on re-ingest their title, body, tags, and
 * links are replaced wholesale from the provider graph (stale links from
 * resolved blockers disappear; stale tags clear). Records OUTSIDE the ingest
 * categories are never touched: an alias that resolves to a record of a
 * different category or type is skipped and reported, so ingest cannot
 * overwrite human-curated notes that happen to share a slug.
 *
 * Re-ingest is an UPSERT, not a duplicate: each provider node id is slugified
 * into a store alias, and a node whose alias already resolves to a
 * provider-owned record updates it in place (`updated_at` bumps — which is
 * exactly what the pull-work TTL check reads). The alias also gives records a
 * durable provider identity across sessions. Distinct provider ids that
 * slugify to the same alias are an in-run collision: the first wins, the rest
 * are skipped and reported.
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
 * each provider-owned record's links are set WHOLESALE from this graph's edges
 * (created records get `store.link()`; updated records get a full `links`
 * replacement so edges that vanished upstream vanish here too). Failures are
 * collected and reported, never thrown mid-batch: a partly unusable graph
 * still ingests its usable part, and the report says exactly what was skipped
 * and why.
 *
 * @param {Object} store - KnowledgeStoreAdapter (create/update/link/get, e.g. DefaultKnowledgeStore)
 * @param {{ nodes: Array, edges: Array }} graph - Provider graph (readGraph() shape)
 * @param {Object} options
 * @param {string} options.agent - Provenance agent (required by the store)
 * @param {string} [options.itemCategory="backlog.item"] - Category for node records (provider-owned)
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
  const updatedRecordIds = new Set();
  const skipped = [];
  let created = 0;
  let updated = 0;

  /**
   * Upsert one provider-owned record. Returns the record id, or null when the
   * alias is held by a record OUTSIDE the ingest ownership (category/type
   * mismatch) — reported by the caller, never overwritten.
   */
  const upsert = async ({ ref, kind, alias, title, body, tags, type, category }) => {
    let existing = null;
    if (alias) {
      try {
        existing = await store.get(alias);
      } catch (err) {
        // AMBIGUOUS_ID from prefix resolution etc. — treat as unresolvable.
        skipped.push({ kind, ref, reason: `alias resolution failed: ${err?.message || err}` });
        return null;
      }
    }
    if (existing) {
      if (existing.category !== category || existing.type !== type) {
        skipped.push({
          kind,
          ref,
          reason: `alias "${alias}" is held by a record outside ingest ownership (type=${existing.type}, category=${existing.category}); not touched`,
        });
        return null;
      }
      await store.update(
        existing.id,
        { title, body, tags, parse_wikilinks: false },
        { agent, note: "ingest-graph refresh" },
      );
      updated += 1;
      updatedRecordIds.add(existing.id);
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
  // own title). Distinct provider ids colliding on one alias: first wins.
  const aliasOwner = new Map();
  for (const node of nodes) {
    if (byNodeId.has(node?.id)) {
      skipped.push({ kind: "node", ref: String(node?.id), reason: "duplicate node id in graph" });
      continue;
    }
    const alias = aliasForNodeId(node?.id);
    if (alias && aliasOwner.has(alias)) {
      skipped.push({
        kind: "node",
        ref: String(node?.id),
        reason: `alias collision: "${alias}" already claimed by node "${aliasOwner.get(alias)}" in this graph`,
      });
      continue;
    }
    const title = typeof node?.title === "string" && node.title.trim() ? node.title : String(node?.id ?? "untitled");
    const rawBody = typeof node?.body === "string" && node.body.trim() ? node.body : title;
    try {
      const recordId = await upsert({
        ref: String(node?.id),
        kind: "node",
        alias,
        title: title.slice(0, 200),
        body: rawBody.slice(0, bodyLimit),
        tags: tagsForNode(node),
        type: itemType,
        category: itemCategory,
      });
      if (recordId !== null) {
        byNodeId.set(node.id, recordId);
        if (alias) aliasOwner.set(alias, String(node.id));
      }
    } catch (err) {
      skipped.push({ kind: "node", ref: String(node?.id), reason: err?.message || String(err) });
    }
  }

  // Board snapshot upsert (optional): gives the pull-work TTL loop its record.
  // Counted separately from item created/updated tallies.
  let boardRecordId = null;
  if (board && typeof board === "object") {
    const beforeCreated = created;
    const beforeUpdated = updated;
    try {
      boardRecordId = await upsert({
        ref: String(board.alias ?? "board"),
        kind: "board",
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
    created = beforeCreated;
    updated = beforeUpdated;
    if (boardRecordId) updatedRecordIds.delete(boardRecordId);
  }

  // Pass 2: edges → links. Provider-owned records get their link set from THIS
  // graph: updated records receive a wholesale replacement (stale links from
  // edges that vanished upstream are removed — links on provider-owned records
  // belong to the provider); created records receive their links via link().
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
      skipped.push({ kind: "edge", ref: `${edge.from}->${edge.to}`, reason: "endpoint not ingested (missing, failed, or skipped node)" });
      continue;
    }
    if (!linksBySource.has(fromRecord)) linksBySource.set(fromRecord, []);
    linksBySource.get(fromRecord).push({ target_id: toRecord, kind });
  }

  let linked = 0;
  for (const recordId of byNodeId.values()) {
    const links = linksBySource.get(recordId) ?? [];
    try {
      if (updatedRecordIds.has(recordId)) {
        // Wholesale replacement (including down to []): provider-owned links.
        await store.update(recordId, { links, parse_wikilinks: false }, { agent, note: "ingest-graph edge pass" });
        linked += links.length;
      } else if (links.length) {
        await store.link(recordId, links, { agent, note: "ingest-graph edge pass" });
        linked += links.length;
      }
    } catch (err) {
      skipped.push({ kind: "edge", ref: recordId, reason: err?.message || String(err) });
    }
  }

  return { byNodeId, created, updated, linked, boardRecordId, skipped };
}

export default { ingestProviderGraph, aliasForNodeId };
