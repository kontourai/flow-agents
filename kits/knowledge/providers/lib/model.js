/**
 * Knowledge graph model helpers: node / edge / proposal / provenance
 * constructors, the closed edge-type vocabulary, the recommended node-type
 * vocabulary, and loaders for the JSON schemas that define them.
 *
 * @module providers/lib/model
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(__dirname, "../../../../schemas/knowledge");

/** Closed vocabulary of edge types (schema-enforced). */
export const EDGE_TYPES = Object.freeze([
  "supersedes",
  "merged-into",
  "blocks",
  "evidence-of",
  "mentions",
  "relates",
]);

/** Recommended core node types. EXTENSIBLE — providers may emit others. */
export const CORE_NODE_TYPES = Object.freeze([
  "note",
  "decision",
  "issue",
  "session",
  "person",
]);

let _schemaCache = null;
/** Load and cache the four graph schemas. */
export function loadSchemas() {
  if (_schemaCache) return _schemaCache;
  const read = (name) => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), "utf8"));
  _schemaCache = {
    node: read("node.schema.json"),
    edge: read("edge.schema.json"),
    proposal: read("proposal.schema.json"),
    healthReport: read("health-report.schema.json"),
  };
  return _schemaCache;
}

/** Build a provenance object. */
export function provenance({ provider, source, locator, retrievedAt, agent }) {
  const p = {
    provider,
    source,
    retrieved_at: retrievedAt || new Date().toISOString(),
  };
  if (locator) p.locator = locator;
  if (agent) p.agent = agent;
  return p;
}

/** Build a node. Omits empty optional fields so schema additionalProperties holds. */
export function node({ id, type, title, body, attributes, provenance: prov }) {
  const n = { id, type, title, provenance: prov };
  if (body !== undefined) n.body = body;
  if (attributes && Object.keys(attributes).length) n.attributes = attributes;
  return n;
}

/** Build an edge. `resolved` defaults to true (an internal dependency link). */
export function edge({ id, type, from, to, resolved, attributes, provenance: prov }) {
  const e = { id, type, from, to, provenance: prov };
  if (resolved === false) e.resolved = false;
  if (attributes && Object.keys(attributes).length) e.attributes = attributes;
  return e;
}

/** Build a proposal. status is always "proposed" — proposals-only by construction. */
export function proposal({ provider, kind, target, payload, rendered, rationale, provenance: prov }) {
  const p = {
    schema_version: "1.0",
    provider,
    kind,
    target: target || {},
    status: "proposed",
    provenance: prov,
  };
  if (payload) p.payload = payload;
  if (rendered !== undefined) p.rendered = rendered;
  if (rationale) p.rationale = rationale;
  return p;
}
