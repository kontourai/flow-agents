/**
 * Cypher for the neo4j knowledge-store provider.
 *
 * Two responsibilities:
 *   1. The label/relationship mapping between the storage-independent graph model
 *      (contract node `type` / edge `type`) and Neo4j's labelled property graph,
 *      plus the read/merge statements the provider and sync command issue.
 *   2. The five CANONICAL health/analysis queries from the #318 spike
 *      (docs/spikes/graph-provider-2026-07.md §3), written in the Neo4j dialect.
 *      The spike found ~80% of Cypher portable and isolated the three divergent
 *      areas (existence predicates, string/list stdlib incl. 0- vs 1-indexed
 *      substring, shortest-path/path-projection). These strings are the Neo4j
 *      spelling; graph-queries.js is the portable JS spelling used in degraded
 *      mode. The live integration test asserts the two agree.
 *
 * Nodes are stored one Neo4j label per contract type (Issue, Decision, Note,
 * Session, Person, …) with a flat property bag; nested `attributes`/`provenance`
 * are serialised to `*_json` strings (Neo4j properties cannot nest) and a few
 * scalars (`state`, `status`) are promoted for queryability, matching the
 * property catalogue the spike's Neo4j Browser panel showed.
 *
 * @module providers/neo4j/cypher
 */

/** Sanitise a contract node type into a Neo4j label (PascalCase, alnum only). */
export function typeToLabel(type) {
  const clean = String(type || "node").replace(/[^A-Za-z0-9]+/g, " ").trim();
  if (!clean) return "Node";
  return clean
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/** Sanitise a closed-vocabulary edge type into a Neo4j relationship type. */
export function edgeTypeToRel(type) {
  return String(type || "relates").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** Reserved label for the sync snapshot metadata node (never part of the graph). */
export const SNAPSHOT_LABEL = "_KGSnapshot";
export const SNAPSHOT_ID = "current";

/** Serialise a contract node into a flat Neo4j property bag. */
export function nodeToProps(n, hash) {
  const props = {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body || "",
    attributes_json: JSON.stringify(n.attributes || {}),
    provenance_json: JSON.stringify(n.provenance || {}),
    _kg_hash: hash,
  };
  // Promote a few queryable scalars (matches the spike's property catalogue).
  const attrs = n.attributes || {};
  if (attrs.state != null) props.state = String(attrs.state);
  if (attrs.status != null) props.status = String(attrs.status);
  if (attrs.registry_status != null) props.status = String(attrs.registry_status);
  return props;
}

/** Rebuild a contract node from a Neo4j property bag. */
export function propsToNode(props) {
  const n = {
    id: props.id,
    type: props.type,
    title: props.title,
    provenance: safeParse(props.provenance_json, {}),
  };
  if (props.body) n.body = props.body;
  const attrs = safeParse(props.attributes_json, {});
  if (attrs && Object.keys(attrs).length) n.attributes = attrs;
  return n;
}

/** Serialise a contract edge into a flat Neo4j property bag. */
export function edgeToProps(e, hash) {
  const props = {
    id: e.id,
    type: e.type,
    from: e.from,
    to: e.to,
    resolved: e.resolved === false ? false : true,
    attributes_json: JSON.stringify(e.attributes || {}),
    provenance_json: JSON.stringify(e.provenance || {}),
    _kg_hash: hash,
  };
  return props;
}

/** Rebuild a contract edge from a Neo4j relationship property bag. */
export function propsToEdge(props) {
  const e = {
    id: props.id,
    type: props.type,
    from: props.from,
    to: props.to,
    provenance: safeParse(props.provenance_json, {}),
  };
  if (props.resolved === false) e.resolved = false;
  const attrs = safeParse(props.attributes_json, {});
  if (attrs && Object.keys(attrs).length) e.attributes = attrs;
  return e;
}

function safeParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// --- fixed read statements ------------------------------------------------

/** All graph nodes (excludes the snapshot metadata node). */
export const READ_NODES_CYPHER = `MATCH (n) WHERE NOT n:${SNAPSHOT_LABEL} RETURN properties(n) AS props`;

/** All graph relationships as flat property bags. */
export const READ_EDGES_CYPHER = `MATCH ()-[r]->() RETURN properties(r) AS props`;

/** The recorded sync snapshot (digest + timestamp), or null. */
export const READ_SNAPSHOT_CYPHER = `MATCH (s:${SNAPSHOT_LABEL} {id:$id}) RETURN properties(s) AS props`;

// --- canonical queries (Neo4j dialect, from the spike) --------------------

/**
 * The five canonical queries as Neo4j Cypher. `blocks` is stored from→to
 * ("from must complete before to"), so a node's transitive blockers are reached
 * by following INCOMING :BLOCKS. Placeholders are $-parameters (never string
 * interpolation — the spike's escaping lesson).
 */
export const CANONICAL_CYPHER = Object.freeze({
  // Q1 — transitive blocker closure (spike: variable-length *1..N, portable).
  transitiveBlockers: `MATCH (b:Issue)-[:BLOCKS*1..$maxDepth]->(x:Issue {id:$rootId})
RETURN DISTINCT b.id AS id, b.state AS state ORDER BY b.id`,

  // Q2 — contradiction candidates: decisions sharing a subject with divergent
  // status (the ADR-0007 numbering-collision failure mode).
  contradictionCandidates: `MATCH (a:Decision),(b:Decision)
WHERE a.id < b.id AND a.title = b.title AND coalesce(a.status,'') <> coalesce(b.status,'')
RETURN a.id AS a_id, b.id AS b_id, a.status AS a_status, b.status AS b_status, a.title AS title`,

  // Q3 — orphans, node-type aware (spike Q3: leaf types are source-only; the
  // meaningful query is issues/decisions with no inbound edge).
  orphans: `MATCH (n) WHERE NOT n:${SNAPSHOT_LABEL} AND NOT ( ()-->(n) )
AND NOT n:Session AND NOT n:Pr AND NOT n:Learning
RETURN labels(n)[0] AS label, n.id AS id ORDER BY id`,

  // Q4 — duplicate candidates WITH 5-char-prefix stemming (spike Q4: exact
  // tokens missed traverse#14~#8; substring() is 0-indexed in Neo4j).
  duplicateStemmed: `MATCH (a),(b) WHERE a.id < b.id AND labels(a)[0] = labels(b)[0]
WITH a, b,
  [w IN split(toLower(a.title),' ') WHERE size(w)>=5 | substring(w,0,5)] AS sa,
  [w IN split(toLower(b.title),' ') WHERE size(w)>=5 | substring(w,0,5)] AS sb
WITH a, b, sa, sb, size([w IN sa WHERE w IN sb]) AS inter
WHERE inter > 0 AND toFloat(inter)/size(sa + [w IN sb WHERE NOT w IN sa]) >= $threshold
RETURN a.id AS a_id, b.id AS b_id, a.title AS a_title, b.title AS b_title`,

  // Q5 — shortest path between two decisions (spike Q5: shortestPath() +
  // list-comprehension projection is the Neo4j spelling).
  shortestPath: `MATCH p=shortestPath((a {id:$fromId})-[*..$maxDepth]-(b {id:$toId}))
RETURN [n IN nodes(p) | n.id] AS path, length(p) AS length`,
});

/**
 * The spike's dialect note, kept with the queries so a future Kuzu/other-engine
 * provider has the divergence map: existence predicates, string/list stdlib
 * (incl. 0- vs 1-indexed substring), and shortest-path/path-projection spelling.
 */
export const DIALECT_NOTES = Object.freeze({
  engine: "neo4j-community-5",
  divergent_areas: ["existence-predicates", "string-list-stdlib", "shortest-path-projection"],
  substring_indexing: "0-based",
});

/**
 * Neo4j forbids a parameter in a variable-length bound (`*1..$maxDepth`). Bounds
 * must be literals, so we validate maxDepth is a small positive integer and
 * interpolate it — the ONLY interpolation in this module; every value stays a
 * $-parameter (the spike's parameterise-don't-escape lesson).
 */
export function renderBounds(cypher, maxDepth) {
  const n = Number(maxDepth);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error(`renderBounds: maxDepth must be an integer in [1,100], got ${maxDepth}`);
  }
  return cypher.replace(/\$maxDepth/g, String(n));
}
