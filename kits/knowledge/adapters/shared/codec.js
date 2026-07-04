/**
 * Knowledge Kit — Shared Codec
 *
 * Utility functions shared between Knowledge Kit store adapters:
 *   - Error helpers (MISSING_EVIDENCE, NOT_FOUND)
 *   - YAML frontmatter codec (zero-dep subset)
 *   - Wikilink parser / indexer
 *   - Graph index helpers
 *   - Validation constants and helpers
 *
 * @module adapters/shared/codec
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

export function missingEvidenceError(message) {
  const err = new Error(message);
  err.code = "MISSING_EVIDENCE";
  return err;
}

export function notFoundError(id) {
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
export function parseMarkdown(text) {
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
export function parseYaml(yaml) {
  const lines = yaml.split("\n");
  return parseYamlLines(lines, 0, 0).value;
}

export function parseYamlLines(lines, start, baseIndent) {
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

export function unquote(s) {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(\\|n|r|")/g, (_, c) => {
      if (c === "\\") return "\\";
      if (c === "n") return "\n";
      if (c === "r") return "\r";
      if (c === '"') return '"';
      return c;
    });
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Serialize an object to YAML-ish text suitable for frontmatter.
 * Only handles strings, numbers, arrays of primitives, and shallow objects.
 */
export function serializeYaml(obj, indent = 0) {
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

export function yamlScalar(v) {
  if (typeof v === "string") {
    // Quote if it contains special chars or actual newlines/carriage returns
    if (/[:#\[\]{},&*?|<>=!%@`"'\n\r]/.test(v) || v.trim() !== v || v === "") {
      return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
    }
    return v;
  }
  return String(v);
}

export function serializeMarkdown(meta, body) {
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
export function extractWikilinks(body) {
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
export function mergeLinks(explicit, wikilinks) {
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

export const GRAPH_SCHEMA_VERSION = "1.0";

export function emptyGraph() {
  return { schema_version: GRAPH_SCHEMA_VERSION, forward: {}, reverse: {} };
}

export function loadGraph(graphPath) {
  if (!fs.existsSync(graphPath)) return emptyGraph();
  try {
    return JSON.parse(fs.readFileSync(graphPath, "utf8"));
  } catch {
    return emptyGraph();
  }
}

export function saveGraph(graphPath, graph) {
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2) + "\n", "utf8");
}

export function addLinksToGraph(graph, sourceId, links) {
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

export function removeLinksFromGraph(graph, sourceId) {
  const oldForward = graph.forward[sourceId] || [];
  for (const link of oldForward) {
    const rev = graph.reverse[link.target_id] || [];
    graph.reverse[link.target_id] = rev.filter((r) => r.source_id !== sourceId);
    if (graph.reverse[link.target_id].length === 0) delete graph.reverse[link.target_id];
  }
  delete graph.forward[sourceId];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export const VALID_TYPES = new Set(["raw", "compiled", "concept", "snapshot", "person"]);
export const VALID_STATUSES = new Set(["active", "implemented", "retired"]);
const CATEGORY_SEGMENT_RE = /^[a-z0-9_-]+$/;

// Status transition table: from → allowed targets
export const VALID_STATUS_TRANSITIONS = {
  active:      new Set(["implemented", "retired"]),
  implemented: new Set(["retired"]),
  retired:     new Set(),  // terminal — no further transitions
};

export function validateCategory(cat) {
  if (!cat || typeof cat !== "string") return false;
  return cat.split(".").every((seg) => CATEGORY_SEGMENT_RE.test(seg));
}

// ---------------------------------------------------------------------------
// Record identity resolution — short-id prefix + slug aliases  (issue #339)
//
// On-disk identity is unchanged: records remain keyed by their full `id`
// (§9). The functions below add a *resolution layer* on top of that identity
// so a query token may be the full id, a category-scoped human-readable slug
// alias, or an unambiguous id prefix. See store-contract.md Addendum H.
// ---------------------------------------------------------------------------

// Minimum length of an id prefix that `get`/`getLinks` will attempt to resolve.
// Tokens shorter than this are never treated as prefixes (they resolve to null
// rather than risk a wildly ambiguous match). The ops design partner cites
// records by 8-char short ids, so 8 is the contract minimum.
export const MIN_ID_PREFIX = 8;

// A slug alias is a lowercase, category-scoped handle, e.g.
// `decision.strategy/2026-07-03-gtm-direction`. It must start and end with an
// alphanumeric and may contain dots, slashes, hyphens and underscores between.
export const SLUG_PATTERN = "^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$";
const SLUG_RE = new RegExp(SLUG_PATTERN);

export function validateSlug(slug) {
  return typeof slug === "string" && slug.length > 0 && slug.length <= 200 && SLUG_RE.test(slug);
}

/**
 * Validate + de-duplicate a caller-supplied `aliases` array. Throws
 * MISSING_EVIDENCE (the contract's rejection channel) on a non-array or a
 * malformed slug so bad aliases are rejected at the mutation boundary.
 * @returns {string[]} normalized, order-preserving, de-duplicated slug list
 */
export function normalizeAliases(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input))
    throw missingEvidenceError("aliases must be an array of slug strings");
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (!validateSlug(raw))
      throw missingEvidenceError(
        `invalid slug alias: ${JSON.stringify(raw)} (must match ${SLUG_PATTERN})`
      );
    if (!seen.has(raw)) { seen.add(raw); out.push(raw); }
  }
  return out;
}

export function ambiguousIdError(input, matches) {
  const shown = matches.slice(0, 5).join(", ");
  const err = new Error(
    `Ambiguous id prefix "${input}" matches ${matches.length} records: ${shown}${matches.length > 5 ? ", …" : ""}`
  );
  err.code = "AMBIGUOUS_ID";
  err.matches = matches.slice();
  return err;
}

/**
 * Resolve a query token to a single record id.
 *
 * Resolution order (first hit wins):
 *   1. Exact full-id match — preserves exact-id semantics and the O(1) hot path.
 *   2. Slug alias — an entry in the alias map (`bySlug`) whose target still exists.
 *   3. Unambiguous id prefix (length >= MIN_ID_PREFIX) matching exactly one id.
 *
 * @param {string} input
 * @param {{ idExists:(id:string)=>boolean, listIds:()=>Iterable<string>, bySlug?:Record<string,string> }} ctx
 * @returns {string|null} resolved id, or null when the token resolves to nothing
 * @throws error with `code === "AMBIGUOUS_ID"` when a prefix matches >1 record
 */
export function resolveRecordId(input, ctx) {
  if (typeof input !== "string" || input.length === 0) return null;
  // 1. Exact full-id match.
  if (ctx.idExists(input)) return input;
  // 2. Slug alias.
  const bySlug = ctx.bySlug || {};
  if (Object.prototype.hasOwnProperty.call(bySlug, input)) {
    const target = bySlug[input];
    if (target && ctx.idExists(target)) return target;
  }
  // 3. Unambiguous id prefix.
  if (input.length >= MIN_ID_PREFIX) {
    const matches = [];
    for (const id of ctx.listIds()) {
      if (typeof id === "string" && id.startsWith(input)) matches.push(id);
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw ambiguousIdError(input, matches);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Alias map (alias-index.json) — the durable slug → id mapping.
//
// Like the graph index, the alias map is a DERIVED cache: each record's own
// `aliases` array is the source of truth, so the map is fully rebuildable by
// scanning records. Keying by full id (never by category or file path) is what
// lets aliases survive store restructures — recategorizing a record or moving
// its file leaves the slug → id mapping untouched.
// ---------------------------------------------------------------------------

export const ALIAS_INDEX_SCHEMA_VERSION = "1.0";

export function emptyAliasIndex() {
  return { schema_version: ALIAS_INDEX_SCHEMA_VERSION, by_slug: {} };
}

export function loadAliasIndex(aliasPath) {
  if (!fs.existsSync(aliasPath)) return emptyAliasIndex();
  try {
    const idx = JSON.parse(fs.readFileSync(aliasPath, "utf8"));
    if (!idx || typeof idx.by_slug !== "object" || idx.by_slug === null) return emptyAliasIndex();
    return idx;
  } catch {
    return emptyAliasIndex();
  }
}

export function saveAliasIndex(aliasPath, index) {
  fs.writeFileSync(aliasPath, JSON.stringify(index, null, 2) + "\n", "utf8");
}

/**
 * Point each slug at `id` in the alias map. A slug already owned by a
 * different record is a genuine collision — throws `SLUG_CONFLICT` (rather than
 * silently re-pointing the alias). Re-registering a slug already owned by `id`
 * is a no-op, so this is idempotent per record.
 */
export function registerAliases(index, id, slugs) {
  for (const slug of slugs) {
    const owner = index.by_slug[slug];
    if (owner && owner !== id) {
      const err = new Error(`slug alias "${slug}" already assigned to record ${owner}`);
      err.code = "SLUG_CONFLICT";
      throw err;
    }
    index.by_slug[slug] = id;
  }
}
