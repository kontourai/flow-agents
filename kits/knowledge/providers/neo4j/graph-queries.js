/**
 * Portable JS spelling of the five canonical spike queries, over a contract
 * graph ({ nodes, edges }).
 *
 * The #318 spike proved "the value is the MODEL and the QUERIES, not either
 * engine" — at portfolio scale an in-memory JS graph answers every canonical
 * query in milliseconds. These functions are that spelling: they back the
 * neo4j provider's query/health verbs when no live Neo4j is reachable (AC4
 * graceful degradation to file providers), and they are the ground-truth oracle
 * the live Cypher path is asserted against (AC3). Same answers, two backends —
 * exactly the portability the spike's dialect-shim note calls for.
 *
 * @module providers/neo4j/graph-queries
 */

/** Tokenise a title into lowercased alnum tokens. */
function tokens(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Stemmed token set: 5-char prefix of tokens of length >= 5 (the spike's Q4
 * stemming — "chunk"/"chunking" -> "chunk", "extraction"/"extractor" -> "extra").
 * Short tokens are dropped, matching the spike's `WHERE size(w)>=5`.
 */
function stemSet(title) {
  return new Set(tokens(title).filter((w) => w.length >= 5).map((w) => w.slice(0, 5)));
}

/** Exact token set (what naive title matching sees — the spike's miss). */
function exactSet(title) {
  return new Set(tokens(title));
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Q1 — transitive blocker closure. A `blocks` edge is from -> to ("from must
 * complete before to"), so a node's transitive blockers are reached by walking
 * INCOMING blocks edges. Returns blocker nodes (excluding the root) with state.
 */
export function transitiveBlockers(graph, { rootId, maxDepth = 10 } = {}) {
  const edges = (graph.edges || []).filter((e) => e.type === "blocks");
  const byId = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const incoming = new Map();
  for (const e of edges) {
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to).push(e.from);
  }
  const seen = new Set();
  let frontier = [rootId];
  let depth = 0;
  while (frontier.length && depth < maxDepth) {
    const next = [];
    for (const node of frontier) {
      for (const from of incoming.get(node) || []) {
        if (from === rootId || seen.has(from)) continue;
        seen.add(from);
        next.push(from);
      }
    }
    frontier = next;
    depth++;
  }
  return [...seen]
    .sort()
    .map((id) => ({ id, state: (byId.get(id)?.attributes || {}).state ?? null }));
}

/**
 * Q2 — contradiction candidates: decision nodes that share a subject (stemmed
 * title match) but carry divergent status. The ADR-0007 numbering-collision
 * failure mode the spike caught red-handed.
 */
export function contradictionCandidates(graph, { threshold = 0.7 } = {}) {
  const decisions = (graph.nodes || []).filter((n) => n.type === "decision");
  const out = [];
  for (let i = 0; i < decisions.length; i++) {
    for (let j = i + 1; j < decisions.length; j++) {
      const a = decisions[i];
      const b = decisions[j];
      const sim = jaccard(stemSet(a.title), stemSet(b.title));
      if (sim < threshold) continue;
      const sa = status(a);
      const sb = status(b);
      if (sa === sb) continue;
      out.push({
        a_id: a.id,
        b_id: b.id,
        a_status: sa,
        b_status: sb,
        title: a.title,
        similarity: Number(sim.toFixed(4)),
      });
    }
  }
  return out.sort((x, y) => (x.a_id + x.b_id).localeCompare(y.a_id + y.b_id));
}

function status(n) {
  const a = n.attributes || {};
  return a.status ?? a.registry_status ?? "";
}

/**
 * Q3 — orphans, node-type aware. Leaf/source-only types (session, pr, learning)
 * originate edges by construction, so flagging them is noise (spike Q3 lesson).
 * Meaningful orphans are non-leaf nodes with no inbound edge.
 */
export function orphans(graph, { excludeTypes = ["session", "pr", "learning"] } = {}) {
  const exclude = new Set(excludeTypes);
  const inbound = new Set((graph.edges || []).map((e) => e.to));
  return (graph.nodes || [])
    .filter((n) => !exclude.has(n.type) && !inbound.has(n.id))
    .map((n) => ({ id: n.id, type: n.type, title: n.title }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Q4 — duplicate candidates WITH stemming. Same-type pairs whose STEMMED token
 * sets cross the threshold. Exact-token Jaccard is reported alongside so callers
 * (and the AC3 test) can see the spike's finding: exact tokens miss traverse#14,
 * stemming catches it.
 */
export function duplicateCandidates(graph, { threshold = 0.7, crossType = false } = {}) {
  const nodes = graph.nodes || [];
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (!crossType && a.type !== b.type) continue;
      const stemmed = jaccard(stemSet(a.title), stemSet(b.title));
      const exact = jaccard(exactSet(a.title), exactSet(b.title));
      if (stemmed < threshold) continue;
      out.push({
        a_id: a.id,
        b_id: b.id,
        a_title: a.title,
        b_title: b.title,
        type: a.type,
        stemmed_similarity: Number(stemmed.toFixed(4)),
        exact_similarity: Number(exact.toFixed(4)),
        caught_only_by_stemming: exact < threshold,
      });
    }
  }
  return out.sort((x, y) => y.stemmed_similarity - x.stemmed_similarity);
}

/**
 * Q5 — shortest path between two nodes over the undirected edge set. Returns the
 * node-id path and its length, or null if unreachable within maxDepth.
 */
export function shortestPath(graph, { fromId, toId, maxDepth = 8 } = {}) {
  if (fromId === toId) return { path: [fromId], length: 0 };
  const adj = new Map();
  const add = (u, v) => {
    if (!adj.has(u)) adj.set(u, new Set());
    adj.get(u).add(v);
  };
  for (const e of graph.edges || []) {
    add(e.from, e.to);
    add(e.to, e.from);
  }
  const prev = new Map([[fromId, null]]);
  let frontier = [fromId];
  let depth = 0;
  while (frontier.length && depth < maxDepth) {
    const next = [];
    for (const u of frontier) {
      for (const v of adj.get(u) || []) {
        if (prev.has(v)) continue;
        prev.set(v, u);
        if (v === toId) {
          const path = [];
          let cur = toId;
          while (cur != null) {
            path.unshift(cur);
            cur = prev.get(cur);
          }
          return { path, length: path.length - 1 };
        }
        next.push(v);
      }
    }
    frontier = next;
    depth++;
  }
  return null;
}

/** Named registry of the five canonical query verbs (portable JS backend). */
export const CANONICAL_QUERIES = Object.freeze({
  transitiveBlockers,
  contradictionCandidates,
  orphans,
  duplicateCandidates,
  shortestPath,
});
