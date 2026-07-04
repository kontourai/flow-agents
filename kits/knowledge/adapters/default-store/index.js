/**
 * Knowledge Kit — Default Store Adapter
 *
 * Implements the Knowledge Kit store contract over:
 *   - Markdown files with YAML frontmatter  (records/<id>.md)
 *   - [[wikilink]] style inline links
 *   - JSON graph index                       (graph-index.json)
 *
 * Zero runtime dependencies beyond Node.js built-ins.
 * Store root is passed as a constructor argument: new DefaultKnowledgeStore({ storeRoot }).
 *
 * @module adapters/default-store
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// Record-identity resolution layer (short-id prefix + slug aliases, issue #339).
// Single-sourced in the shared codec so both bundled adapters resolve
// identically; the rest of this adapter keeps its own zero-import helpers.
import {
  resolveRecordId,
  normalizeAliases,
  emptyAliasIndex,
  loadAliasIndex,
  saveAliasIndex,
  registerAliases,
  // Record-carried freshness + derived staleness (issue #341, Addendum J).
  freshnessPatch,
  decodeFreshnessFields,
  isRecordStale,
} from "../shared/codec.js";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function missingEvidenceError(message) {
  const err = new Error(message);
  err.code = "MISSING_EVIDENCE";
  return err;
}

function notFoundError(id) {
  const err = new Error(`Record not found: ${id}`);
  err.code = "NOT_FOUND";
  return err;
}

// ---------------------------------------------------------------------------
// YAML frontmatter codec  (no external deps — handles the subset we need)
// ---------------------------------------------------------------------------

/**
 * Parse a markdown file that begins with a YAML frontmatter block.
 * Returns { meta, body }.
 */
function parseMarkdown(text) {
  if (!text.startsWith("---\n")) {
    return { meta: {}, body: text };
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    return { meta: {}, body: text };
  }
  const yaml = text.slice(4, end);
  const body = text.slice(end + 5).replace(/^\n+/, "");
  return { meta: parseYaml(yaml), body };
}

/**
 * Minimal YAML parser: handles the scalar/list/nested-object subset
 * emitted by serializeYaml below. Not a general YAML parser.
 */
function parseYaml(yaml) {
  const lines = yaml.split("\n");
  return parseYamlLines(lines, 0, 0).value;
}

function parseYamlLines(lines, start, baseIndent) {
  const obj = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) { i++; continue; }
    const indent = line.search(/\S/);
    if (indent < baseIndent) break;
    if (indent > baseIndent) { i++; continue; }

    // key: value  OR  key:
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) { i++; continue; }
    const key = line.slice(indent, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest.startsWith("[")) {
      // Inline array: [a, b, c]
      const inner = rest.slice(1, rest.lastIndexOf("]"));
      obj[key] = inner ? inner.split(",").map((s) => unquote(s.trim())).filter(Boolean) : [];
      i++;
    } else if (rest === "") {
      // Block: peek ahead
      i++;
      if (i < lines.length) {
        const nextLine = lines[i];
        const nextIndent = nextLine.search(/\S/);
        if (nextIndent > baseIndent && nextLine.trimStart().startsWith("- ")) {
          // Block sequence
          const arr = [];
          while (i < lines.length) {
            const l = lines[i];
            if (l.trim() === "") { i++; continue; }
            const ind = l.search(/\S/);
            if (ind < nextIndent) break;
            if (l.trimStart().startsWith("- ")) {
              const itemText = l.trimStart().slice(2).trim();
              if (itemText.includes(": ") || (i + 1 < lines.length && lines[i + 1].search(/\S/) > ind + 1)) {
                // Object item
                const childLines = [" ".repeat(ind + 2) + itemText];
                i++;
                while (i < lines.length) {
                  const cl = lines[i];
                  const ci = cl.search(/\S/);
                  if (cl.trim() === "" || ci <= ind) break;
                  childLines.push(cl);
                  i++;
                }
                arr.push(parseYamlLines(childLines, 0, ind + 2).value);
              } else {
                arr.push(unquote(itemText));
                i++;
              }
            } else {
              break;
            }
          }
          obj[key] = arr;
        } else if (nextIndent > baseIndent) {
          // Nested mapping
          const result = parseYamlLines(lines, i, nextIndent);
          obj[key] = result.value;
          i = result.next;
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = null;
      }
    } else {
      obj[key] = unquote(rest);
      i++;
    }
  }
  return { value: obj, next: i };
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Serialize an object to YAML-ish text suitable for frontmatter.
 * Only handles strings, numbers, arrays of primitives, and shallow objects.
 */
function serializeYaml(obj, indent = 0) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else if (value.every((v) => typeof v !== "object")) {
        lines.push(`${pad}${key}: [${value.map(yamlScalar).join(", ")}]`);
      } else {
        lines.push(`${pad}${key}:`);
        for (const item of value) {
          if (typeof item === "object" && item !== null) {
            const entries = Object.entries(item).filter(([, v]) => v !== undefined && v !== null);
            if (entries.length === 0) { lines.push(`${pad}  - {}`); continue; }
            const [firstKey, firstVal] = entries[0];
            if (typeof firstVal === "object" && firstVal !== null && !Array.isArray(firstVal)) {
              lines.push(`${pad}  - ${firstKey}:`);
              lines.push(serializeYaml(firstVal, indent + 6));
            } else {
              lines.push(`${pad}  - ${firstKey}: ${yamlScalar(firstVal)}`);
            }
            for (const [k, v] of entries.slice(1)) {
              if (typeof v === "object" && v !== null && !Array.isArray(v)) {
                lines.push(`${pad}    ${k}:`);
                lines.push(serializeYaml(v, indent + 6));
              } else {
                lines.push(`${pad}    ${k}: ${yamlScalar(v)}`);
              }
            }
          } else {
            lines.push(`${pad}  - ${yamlScalar(item)}`);
          }
        }
      }
    } else if (typeof value === "object") {
      lines.push(`${pad}${key}:`);
      lines.push(serializeYaml(value, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${yamlScalar(value)}`);
    }
  }
  return lines.join("\n");
}

function yamlScalar(v) {
  if (typeof v === "string") {
    // Quote if it contains special chars
    if (/[:#\[\]{},&*?|<>=!%@`"'\n]/.test(v) || v.trim() !== v || v === "") {
      return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return v;
  }
  return String(v);
}

function serializeMarkdown(meta, body) {
  return `---\n${serializeYaml(meta)}\n---\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Wikilink parser / indexer
// ---------------------------------------------------------------------------

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Extract all [[target_id]] and [[target_id|label]] links from body text.
 * Returns Link objects.
 */
function extractWikilinks(body) {
  const links = [];
  for (const match of body.matchAll(WIKILINK_RE)) {
    links.push({ target_id: match[1].trim(), kind: "related", label: match[2]?.trim() });
  }
  return links;
}

/**
 * Merge explicit links array with wikilink-derived links.
 * De-duplicates by (target_id, kind); explicit links win on conflict.
 */
function mergeLinks(explicit, wikilinks) {
  const key = (l) => `${l.target_id}::${l.kind}`;
  const seen = new Set(explicit.map(key));
  const merged = [...explicit];
  for (const wl of wikilinks) {
    if (!seen.has(key(wl))) {
      merged.push(wl);
      seen.add(key(wl));
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Graph index
// ---------------------------------------------------------------------------

const GRAPH_SCHEMA_VERSION = "1.0";

function emptyGraph() {
  return { schema_version: GRAPH_SCHEMA_VERSION, forward: {}, reverse: {} };
}

function loadGraph(graphPath) {
  if (!fs.existsSync(graphPath)) return emptyGraph();
  try {
    return JSON.parse(fs.readFileSync(graphPath, "utf8"));
  } catch {
    return emptyGraph();
  }
}

function saveGraph(graphPath, graph) {
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2) + "\n", "utf8");
}

function addLinksToGraph(graph, sourceId, links) {
  if (!graph.forward[sourceId]) graph.forward[sourceId] = [];
  for (const link of links) {
    const { target_id, kind, label } = link;
    // Idempotent: skip if already present
    const exists = graph.forward[sourceId].some(
      (l) => l.target_id === target_id && l.kind === kind
    );
    if (!exists) {
      const entry = { target_id, kind };
      if (label) entry.label = label;
      graph.forward[sourceId].push(entry);
      if (!graph.reverse[target_id]) graph.reverse[target_id] = [];
      graph.reverse[target_id].push({ source_id: sourceId, kind });
    }
  }
}

function removeLinksFromGraph(graph, sourceId) {
  const oldForward = graph.forward[sourceId] || [];
  for (const link of oldForward) {
    const rev = graph.reverse[link.target_id] || [];
    graph.reverse[link.target_id] = rev.filter((r) => r.source_id !== sourceId);
    if (graph.reverse[link.target_id].length === 0) delete graph.reverse[link.target_id];
  }
  delete graph.forward[sourceId];
}

// Order-independent canonical form of a graph index, for drift comparison.
function canonicalGraph(graph) {
  const norm = (obj) =>
    Object.keys(obj || {}).sort().reduce((acc, k) => {
      acc[k] = (obj[k] || []).map((e) => JSON.stringify(e)).sort();
      return acc;
    }, {});
  return JSON.stringify({ forward: norm(graph.forward), reverse: norm(graph.reverse) });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set(["raw", "compiled", "concept", "snapshot", "person"]);
const VALID_STATUSES = new Set(["active", "implemented", "retired"]);
const CATEGORY_SEGMENT_RE = /^[a-z0-9_-]+$/;

// Status transition table: from → allowed targets
const VALID_STATUS_TRANSITIONS = {
  active:      new Set(["implemented", "retired"]),
  implemented: new Set(["retired"]),
  retired:     new Set(),  // terminal — no further transitions
};

function validateCategory(cat) {
  if (!cat || typeof cat !== "string") return false;
  return cat.split(".").every((seg) => CATEGORY_SEGMENT_RE.test(seg));
}

// ---------------------------------------------------------------------------
// DefaultKnowledgeStore
// ---------------------------------------------------------------------------

export class DefaultKnowledgeStore {
  /**
   * @param {{ storeRoot: string }} options
   */
  constructor({ storeRoot }) {
    if (!storeRoot) throw new Error("storeRoot is required");
    this._root = path.resolve(storeRoot);
    this._recordsDir = path.join(this._root, "records");
    this._graphPath = path.join(this._root, "graph-index.json");
    this._aliasPath = path.join(this._root, "alias-index.json");
    fs.mkdirSync(this._recordsDir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  _recordPath(id) {
    return path.join(this._recordsDir, `${id}.md`);
  }

  // -- Record-identity resolution (short-id prefix + slug alias, issue #339) --

  /** Does a record file exist for this exact full id? */
  _idExists(id) {
    return fs.existsSync(this._recordPath(id));
  }

  /** All full record ids, derived cheaply from the records/ directory. */
  _listIds() {
    if (!fs.existsSync(this._recordsDir)) return [];
    return fs.readdirSync(this._recordsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
  }

  /**
   * Resolve a query token (exact id, slug alias, or unambiguous id prefix) to a
   * single full record id, or null when it resolves to nothing. Throws
   * AMBIGUOUS_ID when a prefix matches more than one record.
   */
  _resolveId(input) {
    const aliasIndex = loadAliasIndex(this._aliasPath);
    return resolveRecordId(input, {
      idExists: (rid) => this._idExists(rid),
      listIds: () => this._listIds(),
      bySlug: aliasIndex.by_slug,
    });
  }

  _readRecord(id) {
    const p = this._recordPath(id);
    if (!fs.existsSync(p)) return null;
    const text = fs.readFileSync(p, "utf8");
    const { meta, body } = parseMarkdown(text);
    // Coerce record-carried freshness fields to canonical types (#341).
    return decodeFreshnessFields({ ...meta, body });
  }

  _writeRecord(record) {
    const { body, ...meta } = record;
    const text = serializeMarkdown(meta, body);
    fs.writeFileSync(this._recordPath(record.id), text, "utf8");
  }

  _now() {
    return new Date().toISOString();
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(input) {
    // Required field enforcement
    if (!input.type) throw missingEvidenceError("create: missing required field: type");
    if (!VALID_TYPES.has(input.type))
      throw missingEvidenceError(`create: type must be one of raw, compiled, concept, snapshot, person; got: ${input.type}`);
    if (!input.title || !input.title.trim())
      throw missingEvidenceError("create: missing required field: title");
    if (!input.body && input.body !== "")
      throw missingEvidenceError("create: missing required field: body");
    if (input.body !== undefined && !input.body.trim && typeof input.body !== "string")
      throw missingEvidenceError("create: body must be a string");
    if (!input.category) throw missingEvidenceError("create: missing required field: category");
    if (!validateCategory(input.category))
      throw missingEvidenceError(`create: invalid category: ${input.category}`);
    if (!input.provenance?.agent)
      throw missingEvidenceError("create: missing required provenance field: provenance.agent");

    const id = input.id || randomUUID();
    const now = this._now();

    // Validate slug aliases (issue #339) and reserve them in the alias map
    // BEFORE any write, so a SLUG_CONFLICT aborts create without a partial record.
    const aliases = normalizeAliases(input.aliases);
    let aliasIndex = null;
    if (aliases.length) {
      aliasIndex = loadAliasIndex(this._aliasPath);
      registerAliases(aliasIndex, id, aliases);
    }

    // Validate optional freshness fields (#341) before any write, so a malformed
    // expires_at / ttl_seconds aborts create without a partial record.
    const fresh = freshnessPatch(input);

    // Merge explicit links + wikilinks from body
    const explicitLinks = input.links || [];
    const wikilinks = extractWikilinks(input.body || "");
    const links = mergeLinks(explicitLinks, wikilinks);

    const record = {
      id,
      type: input.type,
      title: input.title,
      category: input.category,
      tags: input.tags || [],
      ...(aliases.length ? { aliases } : {}),
      status: "active",
      created_at: now,
      updated_at: now,
      ...fresh,
      provenance: {
        agent: input.provenance.agent,
        ...(input.provenance.session_id ? { session_id: input.provenance.session_id } : {}),
        ...(input.provenance.source_ids?.length ? { source_ids: input.provenance.source_ids } : {}),
        ...(input.provenance.note ? { note: input.provenance.note } : {}),
      },
      links,
      mutation_log: [],
      body: input.body || "",
    };

    this._writeRecord(record);

    // Update graph index
    const graph = loadGraph(this._graphPath);
    addLinksToGraph(graph, id, links);
    saveGraph(this._graphPath, graph);

    // Persist the alias map only after the record is on disk.
    if (aliasIndex) saveAliasIndex(this._aliasPath, aliasIndex);

    return id;
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(id, fields, evidence) {
    if (!evidence?.agent)
      throw missingEvidenceError("update: missing required evidence field: agent");

    const record = this._readRecord(id);
    if (!record) throw notFoundError(id);

    const mutableKeys = ["title", "body", "category", "tags", "links", "aliases", "expires_at", "ttl_seconds"];
    const supplied = mutableKeys.filter((k) => fields[k] !== undefined);
    if (supplied.length === 0)
      throw missingEvidenceError("update: at least one mutable field must be supplied");

    if (fields.category !== undefined && !validateCategory(fields.category))
      throw missingEvidenceError(`update: invalid category: ${fields.category}`);

    // Validate/normalize supplied freshness fields (#341). A field set to null/""
    // clears it (patch value undefined → dropped by the serializer).
    const fresh = freshnessPatch(fields);

    const now = this._now();

    // Slug aliases are append-only: supplied aliases are UNIONED with existing
    // ones so a previously issued slug keeps resolving after a restructure (R3).
    let mergedAliases = Array.isArray(record.aliases) ? record.aliases.slice() : [];
    let aliasIndex = null;
    if (fields.aliases !== undefined) {
      const incoming = normalizeAliases(fields.aliases);
      const seen = new Set(mergedAliases);
      for (const s of incoming) if (!seen.has(s)) { seen.add(s); mergedAliases.push(s); }
      aliasIndex = loadAliasIndex(this._aliasPath);
      registerAliases(aliasIndex, id, mergedAliases);
    }

    // Merge links if updated
    let newLinks = record.links || [];
    if (fields.links !== undefined) {
      const wikilinks = extractWikilinks(fields.body !== undefined ? fields.body : record.body);
      newLinks = mergeLinks(fields.links, wikilinks);
    } else if (fields.body !== undefined) {
      const wikilinks = extractWikilinks(fields.body);
      newLinks = mergeLinks(record.links || [], wikilinks);
    }

    const updated = {
      ...record,
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.body !== undefined ? { body: fields.body } : {}),
      ...(fields.category !== undefined ? { category: fields.category } : {}),
      ...(fields.tags !== undefined ? { tags: fields.tags } : {}),
      ...(mergedAliases.length ? { aliases: mergedAliases } : {}),
      ...fresh,
      links: newLinks,
      updated_at: now,
      mutation_log: [
        ...(record.mutation_log || []),
        {
          op: "update",
          at: now,
          agent: evidence.agent,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: { fields: supplied },
        },
      ],
    };

    // Update graph index
    const graph = loadGraph(this._graphPath);
    removeLinksFromGraph(graph, id);
    addLinksToGraph(graph, id, newLinks);
    saveGraph(this._graphPath, graph);

    this._writeRecord(updated);

    if (aliasIndex) saveAliasIndex(this._aliasPath, aliasIndex);
  }

  // -------------------------------------------------------------------------
  // link
  // -------------------------------------------------------------------------

  async link(sourceId, links, evidence) {
    if (!evidence?.agent)
      throw missingEvidenceError("link: missing required evidence field: agent");
    if (!links || links.length === 0)
      throw missingEvidenceError("link: links array must be non-empty");

    const source = this._readRecord(sourceId);
    if (!source) throw notFoundError(sourceId);

    for (const l of links) {
      if (!this._readRecord(l.target_id)) throw notFoundError(l.target_id);
    }

    const now = this._now();
    const existingLinks = source.links || [];

    // Idempotent merge
    const key = (l) => `${l.target_id}::${l.kind}`;
    const seen = new Set(existingLinks.map(key));
    const newLinks = [...existingLinks];
    for (const l of links) {
      if (!seen.has(key(l))) {
        newLinks.push(l);
        seen.add(key(l));
      }
    }

    const updated = {
      ...source,
      links: newLinks,
      updated_at: now,
      mutation_log: [
        ...(source.mutation_log || []),
        {
          op: "link",
          at: now,
          agent: evidence.agent,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: { added: links },
        },
      ],
    };

    const graph = loadGraph(this._graphPath);
    removeLinksFromGraph(graph, sourceId);
    addLinksToGraph(graph, sourceId, newLinks);
    saveGraph(this._graphPath, graph);

    this._writeRecord(updated);
  }

  // -------------------------------------------------------------------------
  // propose
  // -------------------------------------------------------------------------

  async propose(conceptId, proposerId, evidence) {
    if (!evidence?.agent)
      throw missingEvidenceError("propose: missing required evidence field: agent");
    if (!evidence?.proposal || !evidence.proposal.trim())
      throw missingEvidenceError("propose: missing required evidence field: proposal");

    const concept = this._readRecord(conceptId);
    if (!concept) throw notFoundError(conceptId);
    // Any record type may receive a proposal (retire flow uses this for all types)

    const proposer = this._readRecord(proposerId);
    if (!proposer) throw notFoundError(proposerId);

    const now = this._now();

    // Add proposes link from proposer to concept
    const proposerLinks = proposer.links || [];
    const alreadyLinked = proposerLinks.some(
      (l) => l.target_id === conceptId && l.kind === "proposes"
    );
    if (!alreadyLinked) {
      const updatedProposer = {
        ...proposer,
        links: [...proposerLinks, { target_id: conceptId, kind: "proposes" }],
        updated_at: now,
        mutation_log: [
          ...(proposer.mutation_log || []),
          {
            op: "propose",
            at: now,
            agent: evidence.agent,
            evidence: { concept_id: conceptId, proposal: evidence.proposal },
          },
        ],
      };
      this._writeRecord(updatedProposer);

      const graph = loadGraph(this._graphPath);
      removeLinksFromGraph(graph, proposerId);
      addLinksToGraph(graph, proposerId, updatedProposer.links);
      saveGraph(this._graphPath, graph);
    }

    // Append mutation log to concept
    const updatedConcept = {
      ...concept,
      mutation_log: [
        ...(concept.mutation_log || []),
        {
          op: "propose",
          at: now,
          agent: evidence.agent,
          evidence: { proposer_id: proposerId, proposal: evidence.proposal },
        },
      ],
    };
    this._writeRecord(updatedConcept);
  }

  // -------------------------------------------------------------------------
  // apply
  // -------------------------------------------------------------------------

  async apply(conceptId, proposerId, evidence) {
    if (!evidence?.agent)
      throw missingEvidenceError("apply: missing required evidence field: agent");
    if (!evidence?.new_body && evidence?.new_body !== "")
      throw missingEvidenceError("apply: missing required evidence field: new_body");
    if (!evidence?.new_body?.trim?.())
      throw missingEvidenceError("apply: new_body must be non-empty");
    if (!evidence?.rationale || !evidence.rationale.trim())
      throw missingEvidenceError("apply: missing required evidence field: rationale");

    const concept = this._readRecord(conceptId);
    if (!concept) throw notFoundError(conceptId);
    // Any record type may be the apply target

    const proposer = this._readRecord(proposerId);
    if (!proposer) throw notFoundError(proposerId);

    const proposerLinks = proposer.links || [];
    const hasProposesLink = proposerLinks.some(
      (l) => l.target_id === conceptId && l.kind === "proposes"
    );
    if (!hasProposesLink)
      throw missingEvidenceError(`apply: no "proposes" link from ${proposerId} to ${conceptId}`);

    const now = this._now();
    const updatedConcept = {
      ...concept,
      body: evidence.new_body,
      updated_at: now,
      mutation_log: [
        ...(concept.mutation_log || []),
        {
          op: "apply",
          at: now,
          agent: evidence.agent,
          evidence: { proposer_id: proposerId, rationale: evidence.rationale },
        },
      ],
    };
    this._writeRecord(updatedConcept);
  }

  // -------------------------------------------------------------------------
  // reject
  // -------------------------------------------------------------------------

  async reject(conceptId, proposerId, evidence) {
    if (!evidence?.agent)
      throw missingEvidenceError("reject: missing required evidence field: agent");
    if (!evidence?.reason || !evidence.reason.trim())
      throw missingEvidenceError("reject: missing required evidence field: reason");

    const concept = this._readRecord(conceptId);
    if (!concept) throw notFoundError(conceptId);
    // Any record type may be the reject target

    const proposer = this._readRecord(proposerId);
    if (!proposer) throw notFoundError(proposerId);

    const proposerLinks = proposer.links || [];
    const hasProposesLink = proposerLinks.some(
      (l) => l.target_id === conceptId && l.kind === "proposes"
    );
    if (!hasProposesLink)
      throw missingEvidenceError(`reject: no "proposes" link from ${proposerId} to ${conceptId}`);

    const now = this._now();
    const updatedConcept = {
      ...concept,
      // updated_at NOT changed — concept body was not mutated
      mutation_log: [
        ...(concept.mutation_log || []),
        {
          op: "reject",
          at: now,
          agent: evidence.agent,
          evidence: { proposer_id: proposerId, reason: evidence.reason },
        },
      ],
    };
    this._writeRecord(updatedConcept);
  }


  // -------------------------------------------------------------------------
  // supersede
  // -------------------------------------------------------------------------

  async supersede(newId, supersededIds, evidence) {
    if (!evidence?.agent)
      throw missingEvidenceError("supersede: missing required evidence field: agent");
    if (!evidence?.rationale || !evidence.rationale.trim())
      throw missingEvidenceError("supersede: missing required evidence field: rationale");
    if (!supersededIds || supersededIds.length === 0)
      throw missingEvidenceError("supersede: supersededIds must be a non-empty array");

    const newRecord = this._readRecord(newId);
    if (!newRecord) throw notFoundError(newId);

    // Verify all superseded records exist
    for (const sid of supersededIds) {
      const rec = this._readRecord(sid);
      if (!rec) throw notFoundError(sid);
    }

    const now = this._now();

    // Add supersedes links from newId to each superseded record
    const supersededLinks = supersededIds.map((sid) => ({
      target_id: sid,
      kind: "supersedes",
    }));

    // Update newId record: add supersedes links + mutation log entry
    const existingLinks = newRecord.links || [];
    const key = (l) => `${l.target_id}::${l.kind}`;
    const seen = new Set(existingLinks.map(key));
    const newLinks = [...existingLinks];
    for (const l of supersededLinks) {
      if (!seen.has(key(l))) {
        newLinks.push(l);
        seen.add(key(l));
      }
    }

    const updatedNew = {
      ...newRecord,
      links: newLinks,
      updated_at: now,
      mutation_log: [
        ...(newRecord.mutation_log || []),
        {
          op: "supersede",
          at: now,
          agent: evidence.agent,
          rationale: evidence.rationale,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: { superseded_count: supersededIds.length },
        },
      ],
    };

    const graph = loadGraph(this._graphPath);
    removeLinksFromGraph(graph, newId);
    addLinksToGraph(graph, newId, newLinks);
    saveGraph(this._graphPath, graph);

    this._writeRecord(updatedNew);

    // Append superseded-by mutation log entry to each superseded record
    // Records are NOT deleted — supersede-not-delete invariant
    for (const sid of supersededIds) {
      const supersededRec = this._readRecord(sid);
      if (!supersededRec) continue; // already verified above; defensive
      const updatedSuperseded = {
        ...supersededRec,
        // updated_at NOT changed — the record content is not mutated
        mutation_log: [
          ...(supersededRec.mutation_log || []),
          {
            op: "superseded-by",
            at: now,
            agent: evidence.agent,
            new_id: newId,
            rationale: evidence.rationale,
            ...(evidence.note ? { note: evidence.note } : {}),
            evidence: { superseded_by_id: newId },
          },
        ],
      };
      this._writeRecord(updatedSuperseded);
    }
  }


  // -------------------------------------------------------------------------
  // retire  (Addendum B — S7)
  // -------------------------------------------------------------------------

  async retire(id, targetStatus, evidence) {
    if (!evidence?.agent)
      throw missingEvidenceError("retire: missing required evidence field: agent");
    if (!evidence?.rationale || !evidence.rationale.trim())
      throw missingEvidenceError("retire: missing required evidence field: rationale");
    if (targetStatus !== "implemented" && targetStatus !== "retired")
      throw missingEvidenceError(
        `retire: targetStatus must be "implemented" or "retired"; got: ${targetStatus}`
      );
    if (targetStatus === "implemented" && (!evidence.implementedByRef || !evidence.implementedByRef.trim()))
      throw missingEvidenceError(
        'retire: implementedByRef is required when targetStatus is "implemented"'
      );

    const record = this._readRecord(id);
    if (!record) throw notFoundError(id);

    const currentStatus = record.status || "active";
    const allowed = VALID_STATUS_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.has(targetStatus)) {
      throw missingEvidenceError(
        `retire: invalid transition from "${currentStatus}" to "${targetStatus}"`
      );
    }

    const now = this._now();
    const updated = {
      ...record,
      status: targetStatus,
      updated_at: now,
      mutation_log: [
        ...(record.mutation_log || []),
        {
          op: "retire",
          at: now,
          agent: evidence.agent,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: {
            targetStatus,
            rationale: evidence.rationale,
            ...(evidence.implementedByRef ? { implementedByRef: evidence.implementedByRef } : {}),
            ...(evidence.supersededByRef ? { supersededByRef: evidence.supersededByRef } : {}),
          },
        },
      ],
    };
    this._writeRecord(updated);
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  async get(id) {
    // Accept an exact id, a slug alias, or an unambiguous id prefix (issue #339).
    // Unresolved → null (unchanged missing-record semantics); ambiguous prefix
    // → throws AMBIGUOUS_ID.
    const resolvedId = this._resolveId(id);
    if (!resolvedId) return null;
    return this._readRecord(resolvedId);
  }

  // -------------------------------------------------------------------------
  // getLinks
  // -------------------------------------------------------------------------

  async getLinks(id) {
    // Resolve prefix/slug to a full id; fall back to the raw token when it
    // resolves to nothing so unknown ids still return empty arrays (not throw).
    const key = this._resolveId(id) || id;
    const graph = loadGraph(this._graphPath);
    return {
      forward: (graph.forward[key] || []).map((l) => ({ ...l })),
      reverse: (graph.reverse[key] || []).map((l) => ({ ...l })),
    };
  }

  // -------------------------------------------------------------------------
  // listByCategory
  // -------------------------------------------------------------------------

  async listByCategory(category, options = {}) {
    const records = this._allRecords();
    const includeRetired = options.includeRetired === true;
    // Derived staleness filter (#341): keep only records past their own effective
    // expiry at `now` (injectable for tests). Absent → no staleness filtering.
    const staleOnly = options.stale === true;
    const nowMs = options.now !== undefined ? new Date(options.now).getTime() : Date.now();
    const keep = (r) =>
      (includeRetired || (r.status || "active") !== "retired") &&
      (!staleOnly || isRecordStale(r, nowMs));
    if (options.prefix) {
      return records.filter(
        (r) => (r.category === category || r.category.startsWith(`${category}.`)) && keep(r)
      );
    }
    return records.filter((r) => r.category === category && keep(r));
  }

  // -------------------------------------------------------------------------
  // listByType
  // -------------------------------------------------------------------------

  async listByType(type, options = {}) {
    const includeRetired = options.includeRetired === true;
    // Derived staleness filter (#341) — see listByCategory.
    const staleOnly = options.stale === true;
    const nowMs = options.now !== undefined ? new Date(options.now).getTime() : Date.now();
    return this._allRecords().filter(
      (r) =>
        r.type === type &&
        (includeRetired || (r.status || "active") !== "retired") &&
        (!staleOnly || isRecordStale(r, nowMs))
    );
  }

  // -------------------------------------------------------------------------
  // reindex — rebuild graph-index.json from records' links (recovery path)
  // -------------------------------------------------------------------------

  /**
   * Rebuild the graph index authoritatively from the records' own `links`.
   * Records are the source of truth; the index is a derived cache. Use this to
   * recover from a lost, hand-edited, or drifted `graph-index.json` (issue #106).
   * @returns {Promise<{records:number, links:number, forwardSources:number, reverseTargets:number, changed:boolean}>}
   */
  async reindex() {
    const records = this._allRecords().sort((a, b) => a.id.localeCompare(b.id));
    const rebuilt = emptyGraph();
    for (const record of records) {
      addLinksToGraph(rebuilt, record.id, Array.isArray(record.links) ? record.links : []);
    }
    const links = Object.values(rebuilt.forward).reduce((n, arr) => n + arr.length, 0);
    const changed = canonicalGraph(loadGraph(this._graphPath)) !== canonicalGraph(rebuilt);
    saveGraph(this._graphPath, rebuilt);

    // The alias map is likewise derived from records' `aliases` — rebuild it so
    // a lost/hand-edited alias-index.json recovers on the same recovery path.
    const rebuiltAliases = emptyAliasIndex();
    for (const record of records) {
      const slugs = normalizeAliases(record.aliases);
      if (slugs.length) registerAliases(rebuiltAliases, record.id, slugs);
    }
    saveAliasIndex(this._aliasPath, rebuiltAliases);

    return {
      records: records.length,
      links,
      forwardSources: Object.keys(rebuilt.forward).length,
      reverseTargets: Object.keys(rebuilt.reverse).length,
      changed,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: read all records
  // -------------------------------------------------------------------------

  _allRecords() {
    if (!fs.existsSync(this._recordsDir)) return [];
    const files = fs.readdirSync(this._recordsDir).filter((f) => f.endsWith(".md"));
    const records = [];
    for (const file of files) {
      const id = file.slice(0, -3);
      const record = this._readRecord(id);
      if (record) records.push(record);
    }
    return records;
  }
}

export default DefaultKnowledgeStore;
