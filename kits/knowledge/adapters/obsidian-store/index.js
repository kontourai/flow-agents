/**
 * Knowledge Kit — Obsidian Store Adapter
 *
 * Implements the Knowledge Kit store contract where each record on disk
 * is ONE human-canonical Obsidian markdown note.
 *
 * Storage layout:
 *   <storeRoot>/
 *     <category-as-path>/<title-slug>.md   (active records)
 *     archive/<category-as-path>/<title-slug>.md  (superseded records)
 *     graph-index.json                     (link graph — required by suite §13)
 *     .graph-index.json                    (path index — id→{path,archived})
 *
 * Frontmatter carries ALL contract fields; body rendered for Obsidian readability.
 * Category dots map to directory segments: "eng.api" → "eng/api/".
 * Filename: slugified title, collision-suffixed (-2, -3, …).
 * Superseded records MOVE to archive/ (supersede-not-delete invariant).
 *
 * Zero runtime dependencies beyond Node.js built-ins.
 *
 * @module adapters/obsidian-store
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
  missingEvidenceError,
  notFoundError,
  parseMarkdown,
  serializeYaml,
  extractWikilinks,
  mergeLinks,
  loadGraph,
  saveGraph,
  addLinksToGraph,
  removeLinksFromGraph,
  VALID_TYPES,
  VALID_STATUS_TRANSITIONS,
  validateCategory,
} from "../shared/codec.js";

// ---------------------------------------------------------------------------
// ObsidianKnowledgeStore
// ---------------------------------------------------------------------------

export class ObsidianKnowledgeStore {
  /**
   * @param {{ storeRoot: string }} options
   */
  constructor({ storeRoot }) {
    if (!storeRoot) throw new Error("storeRoot is required");
    this._root = path.resolve(storeRoot);
    // Link graph (required by suite §13): { schema_version, forward, reverse }
    this._graphPath = path.join(this._root, "graph-index.json");
    // Path index (internal): { by_id: { id: { path, archived } }, by_path: { relPath: id } }
    this._pathIndexPath = path.join(this._root, ".graph-index.json");
    fs.mkdirSync(this._root, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Path / slug helpers
  // -------------------------------------------------------------------------

  _slugify(title) {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      || "untitled";
  }

  /**
   * Compute a unique relative path for a record, respecting collision suffix.
   * Category dots → directory separators: "eng.api" → "eng/api".
   */
  _computeRelPath(category, title, id, pathIndex) {
    const catDir = category.replace(/\./g, "/");
    const baseSlug = this._slugify(title);
    let slug = baseSlug;
    let suffix = 2;
    while (true) {
      const relPath = `${catDir}/${slug}.md`;
      const existingId = pathIndex.by_path[relPath];
      if (!existingId || existingId === id) return relPath;
      slug = `${baseSlug}-${suffix++}`;
    }
  }

  // -------------------------------------------------------------------------
  // Path index I/O
  // -------------------------------------------------------------------------

  _loadPathIndex() {
    if (!fs.existsSync(this._pathIndexPath)) return { by_id: {}, by_path: {} };
    try {
      return JSON.parse(fs.readFileSync(this._pathIndexPath, "utf8"));
    } catch {
      return { by_id: {}, by_path: {} };
    }
  }

  _savePathIndex(index) {
    fs.writeFileSync(this._pathIndexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
  }

  // -------------------------------------------------------------------------
  // Record I/O
  // -------------------------------------------------------------------------

  /**
   * Returns the absolute path for a record id, or null if not indexed.
   */
  _getAbsPath(id, pathIndex) {
    const entry = (pathIndex || this._loadPathIndex()).by_id[id];
    if (!entry) return null;
    return path.join(this._root, entry.path);
  }

  /**
   * Read a record by id. Returns the full record object (all fields from
   * frontmatter, with `body` included) or null if not found.
   */
  _readRecord(id, pathIndex) {
    const absPath = this._getAbsPath(id, pathIndex);
    if (!absPath || !fs.existsSync(absPath)) return null;
    const text = fs.readFileSync(absPath, "utf8");
    const { meta } = parseMarkdown(text);
    if (!meta.id) return null;
    // body is stored in frontmatter as meta.body
    return { ...meta };
  }

  /**
   * Write a record to disk.
   *
   * - On first write: computes slug path, registers in path index.
   * - On update with title change: renames file (old deleted, new path used).
   * - All contract fields stored in YAML frontmatter.
   * - Below the frontmatter: Obsidian-readable human body for the note type.
   */
  _writeRecord(record, pathIndex) {
    const ownedIndex = !pathIndex;
    if (ownedIndex) pathIndex = this._loadPathIndex();

    const existingEntry = pathIndex.by_id[record.id];
    let targetRelPath;

    if (existingEntry && existingEntry.archived) {
      // Archived record — keep in archive path (supersede-not-delete writes back there)
      targetRelPath = existingEntry.path;
    } else if (existingEntry) {
      // Existing active record — check if path needs to change (title changed)
      const newRelPath = this._computeRelPath(record.category, record.title, record.id, pathIndex);
      if (newRelPath !== existingEntry.path) {
        // Move: delete old file, register new path
        const oldAbs = path.join(this._root, existingEntry.path);
        if (fs.existsSync(oldAbs)) fs.unlinkSync(oldAbs);
        delete pathIndex.by_path[existingEntry.path];
        pathIndex.by_id[record.id] = { path: newRelPath, archived: false };
        pathIndex.by_path[newRelPath] = record.id;
        targetRelPath = newRelPath;
      } else {
        targetRelPath = existingEntry.path;
      }
    } else {
      // New record
      const newRelPath = this._computeRelPath(record.category, record.title, record.id, pathIndex);
      pathIndex.by_id[record.id] = { path: newRelPath, archived: false };
      pathIndex.by_path[newRelPath] = record.id;
      targetRelPath = newRelPath;
    }

    // Render: all contract fields in frontmatter; human body below
    const { body, ...frontmatterFields } = record;
    // Store body in frontmatter so round-trip is lossless
    const frontmatter = { ...frontmatterFields, body };
    const obsidianBody = this._renderObsidianBody(record, pathIndex);
    const text = `---\n${serializeYaml(frontmatter)}\n---\n\n${obsidianBody}`;

    const absPath = path.join(this._root, targetRelPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, text, "utf8");

    if (ownedIndex) this._savePathIndex(pathIndex);
    return targetRelPath;
  }

  /**
   * Move an active record to archive/ and mark it archived in path index.
   * Called after writing the superseded-by mutation log entry.
   */
  _archiveRecord(id, pathIndex) {
    const ownedIndex = !pathIndex;
    if (ownedIndex) pathIndex = this._loadPathIndex();

    const entry = pathIndex.by_id[id];
    if (!entry || entry.archived) {
      if (ownedIndex) this._savePathIndex(pathIndex);
      return;
    }

    const archiveRelPath = `archive/${entry.path}`;
    const archiveAbs = path.join(this._root, archiveRelPath);
    fs.mkdirSync(path.dirname(archiveAbs), { recursive: true });

    const currentAbs = path.join(this._root, entry.path);
    if (fs.existsSync(currentAbs)) fs.renameSync(currentAbs, archiveAbs);

    delete pathIndex.by_path[entry.path];
    pathIndex.by_id[id] = { path: archiveRelPath, archived: true };
    pathIndex.by_path[archiveRelPath] = id;

    if (ownedIndex) this._savePathIndex(pathIndex);
  }

  // -------------------------------------------------------------------------
  // Obsidian body rendering
  // -------------------------------------------------------------------------

  /**
   * Resolve a record id to its filename slug for use as a wikilink target.
   * Falls back to the id itself if not in the index.
   */
  _idToFilename(id, pathIndex) {
    const entry = pathIndex.by_id[id];
    if (!entry) return id;
    return path.basename(entry.path, ".md");
  }

  /**
   * Render the human-readable Obsidian body below the frontmatter fence.
   * This is decorative — the canonical data lives in frontmatter.
   */
  _renderObsidianBody(record, pathIndex) {
    const links = record.links || [];
    const relatedLinks = links.filter((l) => l.kind === "related" || l.kind === "refines");
    const sourceLinks = links.filter((l) => l.kind === "source");

    const wikiLinks = (linkList) =>
      linkList
        .map((l) => {
          const slug = this._idToFilename(l.target_id, pathIndex);
          return l.label ? `[[${slug}|${l.label}]]` : `[[${slug}]]`;
        })
        .join(", ");

    const sections = [];

    if (record.type === "raw") {
      sections.push(`> [!note]- Raw Notes\n> ${record.body.replace(/\n/g, "\n> ")}`);
    } else {
      // compiled / concept / snapshot: insight as readable body
      sections.push(record.body);
    }

    if (sourceLinks.length > 0) {
      sections.push(`## Sources\n\n${wikiLinks(sourceLinks)}`);
    }

    if (relatedLinks.length > 0) {
      sections.push(`## Related\n\n${wikiLinks(relatedLinks)}`);
    }

    return sections.join("\n\n");
  }

  // -------------------------------------------------------------------------
  // _allRecords: walk path index
  // -------------------------------------------------------------------------

  _allRecords() {
    const pathIndex = this._loadPathIndex();
    const records = [];
    for (const [id, entry] of Object.entries(pathIndex.by_id)) {
      if (entry.archived) continue;
      const record = this._readRecord(id, pathIndex);
      if (record) records.push(record);
    }
    return records;
  }

  _now() {
    return new Date().toISOString();
  }

  // =========================================================================
  // Store contract operations
  // =========================================================================

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(input) {
    if (!input.type) throw missingEvidenceError("create: missing required field: type");
    if (!VALID_TYPES.has(input.type))
      throw missingEvidenceError(`create: type must be raw, compiled, concept, or snapshot; got: ${input.type}`);
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

    const explicitLinks = input.links || [];
    const wikilinks = extractWikilinks(input.body || "");
    const links = mergeLinks(explicitLinks, wikilinks);

    const record = {
      id,
      type: input.type,
      title: input.title,
      category: input.category,
      tags: input.tags || [],
      status: "active",
      created_at: now,
      updated_at: now,
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

    const graph = loadGraph(this._graphPath);
    addLinksToGraph(graph, id, links);
    saveGraph(this._graphPath, graph);

    return id;
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(id, fields, evidence) {
    if (!evidence?.agent)
      throw missingEvidenceError("update: missing required evidence field: agent");

    const pathIndex = this._loadPathIndex();
    const record = this._readRecord(id, pathIndex);
    if (!record) throw notFoundError(id);

    const mutableKeys = ["title", "body", "category", "tags", "links"];
    const supplied = mutableKeys.filter((k) => fields[k] !== undefined);
    if (supplied.length === 0)
      throw missingEvidenceError("update: at least one mutable field must be supplied");

    if (fields.category !== undefined && !validateCategory(fields.category))
      throw missingEvidenceError(`update: invalid category: ${fields.category}`);

    const now = this._now();

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

    const graph = loadGraph(this._graphPath);
    removeLinksFromGraph(graph, id);
    addLinksToGraph(graph, id, newLinks);
    saveGraph(this._graphPath, graph);

    this._writeRecord(updated, pathIndex);
    this._savePathIndex(pathIndex);
  }

  // -------------------------------------------------------------------------
  // link
  // -------------------------------------------------------------------------

  async link(sourceId, links, evidence) {
    if (!evidence?.agent)
      throw missingEvidenceError("link: missing required evidence field: agent");
    if (!links || links.length === 0)
      throw missingEvidenceError("link: links array must be non-empty");

    const pathIndex = this._loadPathIndex();
    const source = this._readRecord(sourceId, pathIndex);
    if (!source) throw notFoundError(sourceId);

    for (const l of links) {
      if (!this._readRecord(l.target_id, pathIndex)) throw notFoundError(l.target_id);
    }

    const now = this._now();
    const existingLinks = source.links || [];

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

    this._writeRecord(updated, pathIndex);
    this._savePathIndex(pathIndex);
  }

  // -------------------------------------------------------------------------
  // propose
  // -------------------------------------------------------------------------

  async propose(conceptId, proposerId, evidence) {
    if (!evidence?.agent)
      throw missingEvidenceError("propose: missing required evidence field: agent");
    if (!evidence?.proposal || !evidence.proposal.trim())
      throw missingEvidenceError("propose: missing required evidence field: proposal");

    const pathIndex = this._loadPathIndex();
    const concept = this._readRecord(conceptId, pathIndex);
    if (!concept) throw notFoundError(conceptId);

    const proposer = this._readRecord(proposerId, pathIndex);
    if (!proposer) throw notFoundError(proposerId);

    const now = this._now();

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
      this._writeRecord(updatedProposer, pathIndex);

      const graph = loadGraph(this._graphPath);
      removeLinksFromGraph(graph, proposerId);
      addLinksToGraph(graph, proposerId, updatedProposer.links);
      saveGraph(this._graphPath, graph);
    }

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
    this._writeRecord(updatedConcept, pathIndex);
    this._savePathIndex(pathIndex);
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

    const pathIndex = this._loadPathIndex();
    const concept = this._readRecord(conceptId, pathIndex);
    if (!concept) throw notFoundError(conceptId);

    const proposer = this._readRecord(proposerId, pathIndex);
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
    this._writeRecord(updatedConcept, pathIndex);
    this._savePathIndex(pathIndex);
  }

  // -------------------------------------------------------------------------
  // reject
  // -------------------------------------------------------------------------

  async reject(conceptId, proposerId, evidence) {
    if (!evidence?.agent)
      throw missingEvidenceError("reject: missing required evidence field: agent");
    if (!evidence?.reason || !evidence.reason.trim())
      throw missingEvidenceError("reject: missing required evidence field: reason");

    const pathIndex = this._loadPathIndex();
    const concept = this._readRecord(conceptId, pathIndex);
    if (!concept) throw notFoundError(conceptId);

    const proposer = this._readRecord(proposerId, pathIndex);
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
    this._writeRecord(updatedConcept, pathIndex);
    this._savePathIndex(pathIndex);
  }

  // -------------------------------------------------------------------------
  // supersede  (Addendum A)
  // -------------------------------------------------------------------------

  async supersede(newId, supersededIds, evidence) {
    if (!evidence?.agent)
      throw missingEvidenceError("supersede: missing required evidence field: agent");
    if (!evidence?.rationale || !evidence.rationale.trim())
      throw missingEvidenceError("supersede: missing required evidence field: rationale");
    if (!supersededIds || supersededIds.length === 0)
      throw missingEvidenceError("supersede: supersededIds must be a non-empty array");

    const pathIndex = this._loadPathIndex();
    const newRecord = this._readRecord(newId, pathIndex);
    if (!newRecord) throw notFoundError(newId);

    for (const sid of supersededIds) {
      const rec = this._readRecord(sid, pathIndex);
      if (!rec) throw notFoundError(sid);
    }

    const now = this._now();

    const supersededLinks = supersededIds.map((sid) => ({
      target_id: sid,
      kind: "supersedes",
    }));

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

    this._writeRecord(updatedNew, pathIndex);

    // Write superseded-by mutation log to each superseded record, then archive
    for (const sid of supersededIds) {
      const supersededRec = this._readRecord(sid, pathIndex);
      if (!supersededRec) continue;
      const updatedSuperseded = {
        ...supersededRec,
        // updated_at NOT changed — content not mutated
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
      this._writeRecord(updatedSuperseded, pathIndex);
      // Move superseded file to archive/ (supersede-not-delete invariant)
      this._archiveRecord(sid, pathIndex);
    }

    this._savePathIndex(pathIndex);
  }

  // -------------------------------------------------------------------------
  // retire  (Addendum B)
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

    const pathIndex = this._loadPathIndex();
    const record = this._readRecord(id, pathIndex);
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
    this._writeRecord(updated, pathIndex);
    this._savePathIndex(pathIndex);
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  async get(id) {
    return this._readRecord(id);
  }

  // -------------------------------------------------------------------------
  // getLinks
  // -------------------------------------------------------------------------

  async getLinks(id) {
    const graph = loadGraph(this._graphPath);
    return {
      forward: (graph.forward[id] || []).map((l) => ({ ...l })),
      reverse: (graph.reverse[id] || []).map((l) => ({ ...l })),
    };
  }

  // -------------------------------------------------------------------------
  // listByCategory
  // -------------------------------------------------------------------------

  async listByCategory(category, options = {}) {
    const records = this._allRecords();
    const includeRetired = options.includeRetired === true;
    if (options.prefix) {
      return records.filter(
        (r) =>
          (r.category === category || r.category.startsWith(`${category}.`)) &&
          (includeRetired || (r.status || "active") !== "retired")
      );
    }
    return records.filter(
      (r) =>
        r.category === category &&
        (includeRetired || (r.status || "active") !== "retired")
    );
  }

  // -------------------------------------------------------------------------
  // listByType
  // -------------------------------------------------------------------------

  async listByType(type, options = {}) {
    const includeRetired = options.includeRetired === true;
    return this._allRecords().filter(
      (r) =>
        r.type === type &&
        (includeRetired || (r.status || "active") !== "retired")
    );
  }
}

export default ObsidianKnowledgeStore;
