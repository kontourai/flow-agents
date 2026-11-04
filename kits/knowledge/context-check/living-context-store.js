/**
 * Living Context manifest producer for a Knowledge store.
 *
 * Recall (living-context.js) reads a claims manifest. Nothing in a store writes one, so this module derives it: one
 * claim per store record, read from the pinned Git revision (never the working tree), with every decision the record
 * cannot make for itself made here, written down, and conservative. The result is a manifest object, not a file:
 * `runLivingContext({ derivedManifests: { [rootId]: manifest } })` takes it in place of the `git show` of `manifest_path`, so
 * the store need not be modified. `manifest_path` then only names the derived manifest.
 *
 * The mapping (the contract of this module; docs/README.md repeats it):
 *
 *   id                   the record id (a record id that is not a safe claim id is excluded: `invalid_id`).
 *   claim                the record title, whitespace collapsed. A title labels the record; it is not a verified
 *                        statement. An answer quotes the record body (see living-context-ask.js). Blank: `blank_title`.
 *   authority            the record's file at the pinned revision; owning source is `{ owner, path: <same file> }`.
 *   status               a record some other record `supersedes` is `superseded` by it (the Kit's derived rule: the
 *                        edge, never the stored status); with several successors it is `unverifiable`
 *                        (`multiple_successors`). Otherwise `active` and `implemented` are `current`, and every other
 *                        status (`retired` without a successor included) is `unverifiable`. Nothing unknown is current.
 *   slot                 the supersession lineage a record belongs to (`lineage:<smallest id>`); a record in no lineage
 *                        has a slot of its own (`record:<id>`), so no unrelated pair is ever treated as a replacement.
 *   recorded_at          the record `created_at` (when the store received it). Absent or unreadable: omitted, and recall
 *                        reports `knowledge_time_unknown` rather than guessing.
 *   valid_time           `{ from: created_at }`. A record asserts nothing about when it stops being true.
 *   supersession edge    `succession`, recorded at the successor's `supersede` log entry (else its `updated_at`).
 *   expires_at/ttl       the record's own `expires_at` / `ttl_seconds` when it has them; otherwise a record never expires
 *                        (its age is the reader's to judge: `updated_at` is returned with the record).
 *   visibility           the store has no per-record visibility, so the host declares who reads the store (`readers`)
 *                        and every record is visible to exactly those readers. No `readers`, no manifest.
 *   review               omitted, which recall reads as `proposed`: no record carries a per-claim human review.
 *
 * Excluded, with a reason (never silently dropped): duplicate ids (all copies), over-size files, blank titles,
 * unsafe ids. Files under `archive/` or a dot directory, symlinks, and Markdown without a record's `id` and `category`
 * frontmatter are not records and are only counted.
 *
 * @module living-context-store
 */

import * as path from "node:path";
import { parseMarkdown } from "../adapters/shared/codec.js";
import { error, gitRaw, isIdentity, resolveRevisionBoundRepository, safeClaimId, safeRelativePath } from "./index.js";

/** A record file larger than this is excluded rather than read: the answer step also refuses an authority over 64 KiB, so a bigger record could never be answered from. */
export const MAX_RECORD_BYTES = 262144;
export const DEFAULT_STORE_ROOT_ID = "knowledge-store";

const LS_TREE_ENTRY = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t([\s\S]+)$/;
const SERVED_STATUSES = new Set(["active", "implemented"]);

/** A UTC instant in the form recall parses (`YYYY-MM-DDTHH:MM:SS.mmmZ`), or undefined. Never a guess: an unparseable value is no value. */
function instantOf(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const collapse = (text) => String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const asList = (value) => (Array.isArray(value) ? value : []);

/** The Knowledge root a derived manifest is passed under, in the form `input.knowledge_roots` takes. */
export function storeKnowledgeRoot(storePath = "knowledge", id = DEFAULT_STORE_ROOT_ID) {
  return { id, provider: "git-repo", manifest_path: `${safeRelativePath(storePath, "storePath").replace(/\/+$/, "")}/derived-claims.json` };
}

/** Blob contents by object id, in order, from one `git cat-file --batch` (sizes are in bytes, so the output is parsed as bytes). */
function readBlobs(root, objects) {
  if (objects.length === 0) return [];
  const out = gitRaw(root, ["cat-file", "--batch"], { input: `${objects.join("\n")}\n`, buffer: true });
  const texts = [];
  let offset = 0;
  for (const object of objects) {
    const end = out.indexOf(10, offset);
    const header = out.subarray(offset, end).toString("utf8").split(" ");
    if (header[0] !== object || header[1] !== "blob") throw error("REVISION_READ_FAILED", "Context Check could not read a record blob from the pinned revision");
    const size = Number(header[2]);
    texts.push(out.subarray(end + 1, end + 1 + size).toString("utf8"));
    offset = end + 1 + size + 1;
  }
  return texts;
}

function listStoreFiles(root, revision, store) {
  const out = gitRaw(root, ["ls-tree", "-r", "-z", "--long", revision, "--", store]);
  const files = [];
  for (const line of out.split("\0")) {
    if (line === "") continue;
    const match = LS_TREE_ENTRY.exec(line);
    if (!match) throw error("REVISION_READ_FAILED", "Context Check could not parse the Git tree listing of the store");
    const [, mode, type, object, size, file] = match;
    const relative = path.posix.relative(store, file);
    const segments = relative.split("/");
    if (type !== "blob" || mode === "120000" || !file.endsWith(".md")) continue;
    if (segments.some((segment) => segment === "archive" || segment.startsWith("."))) continue;
    files.push({ path: file, object, size: size === "-" ? 0 : Number(size) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Derive the claims manifest of the store at `storePath` as of the raw commit `revision`.
 *
 * @param {{repoRoot: string, revision: string, storePath?: string, readers: string[], owner?: string}} options
 * @returns {{manifest: {readers: string[], claims: object[]}, records: object[], excluded: {path: string, id?: string, reason: string}[], stats: object, revision: string, store: string}}
 */
export function deriveStoreManifest({ repoRoot, revision, storePath = "knowledge", readers, owner = "knowledge-store" } = {}) {
  if (!Array.isArray(readers) || readers.length === 0 || readers.some((reader) => !isIdentity(reader)) || new Set(readers).size !== readers.length) {
    throw error("READERS_REQUIRED", "deriveStoreManifest needs `readers`: the unique, non-blank identities the host declares may read this store (the store itself carries no visibility)");
  }
  if (!isIdentity(owner)) throw error("INVALID_IDENTITY", "owner must be a non-blank identity");
  const { root, revision: pinned } = resolveRevisionBoundRepository(repoRoot, revision);
  const store = safeRelativePath(storePath, "storePath").replace(/\/+$/, "");
  const excluded = [];
  const parsed = [];
  let skipped = 0;
  const files = listStoreFiles(root, pinned, store);
  const readable = [];
  for (const file of files) {
    if (file.size > MAX_RECORD_BYTES) excluded.push({ path: file.path, reason: "too_large" }); else readable.push(file);
  }
  const texts = readBlobs(root, readable.map((file) => file.object));
  for (const [index, file] of readable.entries()) {
    const { meta, body } = parseMarkdown(texts[index]);
    if (typeof meta?.id !== "string" || !meta.id || typeof meta.category !== "string" || !meta.category) { skipped++; continue; }
    parsed.push({ file, meta, body });
  }

  const copies = new Map();
  for (const entry of parsed) copies.set(entry.meta.id, [...(copies.get(entry.meta.id) ?? []), entry]);
  const records = [];
  for (const [id, group] of copies) {
    if (group.length > 1) { for (const entry of group) excluded.push({ path: entry.file.path, id, reason: "duplicate_id" }); continue; }
    const [{ file, meta, body }] = group;
    try { safeClaimId(id, "record id"); } catch { excluded.push({ path: file.path, id, reason: "invalid_id" }); continue; }
    const title = collapse(meta.title);
    if (!title) { excluded.push({ path: file.path, id, reason: "blank_title" }); continue; }
    records.push({ id, path: file.path, title, type: meta.type, category: meta.category, tags: asList(meta.tags).map(collapse).filter(Boolean), status: collapse(meta.status) || "active", meta, body });
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(records.map((record) => [record.id, record]));

  // A record that another record `supersedes` is superseded by it. Targets that are not manifest records (a filename, an excluded record) are no edge.
  const successors = new Map();
  for (const record of records) {
    for (const link of asList(record.meta.links)) {
      if (link?.kind !== "supersedes" || typeof link.target_id !== "string" || !byId.has(link.target_id) || link.target_id === record.id) continue;
      successors.set(link.target_id, new Set([...(successors.get(link.target_id) ?? []), record.id]));
    }
  }
  // Slots: connected components of the supersession graph, so only records of one lineage can replace each other.
  const parent = new Map(records.map((record) => [record.id, record.id]));
  const find = (id) => { let current = id; while (parent.get(current) !== current) current = parent.get(current); return current; };
  for (const [old, news] of successors) for (const next of news) {
    const [a, b] = [find(old), find(next)];
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const slotOf = (id) => { const rootId = find(id); const members = records.filter((record) => find(record.id) === rootId); return members.length > 1 ? `lineage:${rootId}` : `record:${id}`; };

  const edgeRecordedAt = (successor) => {
    const logged = asList(successor.meta.mutation_log).filter((entry) => entry?.op === "supersede").map((entry) => instantOf(entry.at)).filter(Boolean).sort();
    return logged.at(-1) ?? instantOf(successor.meta.updated_at);
  };

  const claims = [];
  const described = [];
  const visibility = { audiences: [...readers] };
  for (const record of records) {
    const recordedAt = instantOf(record.meta.created_at);
    const successorIds = [...(successors.get(record.id) ?? [])].sort();
    let status, mapping, edge = {};
    if (successorIds.length === 1) {
      status = "superseded";
      mapping = "superseded_by_record";
      edge = { superseded_by: successorIds[0], supersession_kind: "succession", ...(edgeRecordedAt(byId.get(successorIds[0])) ? { supersession_recorded_at: edgeRecordedAt(byId.get(successorIds[0])) } : {}) };
    } else if (successorIds.length > 1) { status = "unverifiable"; mapping = "multiple_successors"; }
    else if (SERVED_STATUSES.has(record.status)) { status = "current"; mapping = `status:${record.status}`; }
    else { status = "unverifiable"; mapping = record.status === "retired" ? "retired_without_successor" : `unrecognised_status:${record.status}`; }
    const expiresAt = instantOf(record.meta.expires_at);
    const ttl = Number(record.meta.ttl_seconds);
    claims.push({
      id: record.id,
      claim: record.title,
      status,
      ...edge,
      authority: { path: record.path, citation: `${record.category} record ${record.id}` },
      owning_source: { owner, path: record.path },
      affected_surfaces: [record.path],
      visibility,
      ...(recordedAt ? { recorded_at: recordedAt, valid_time: { from: recordedAt } } : {}),
      ...(expiresAt ? { expires_at: expiresAt } : {}),
      ...(record.meta.ttl_seconds !== undefined && Number.isFinite(ttl) && ttl >= 0 ? { ttl_seconds: ttl } : {}),
      slot: slotOf(record.id),
    });
    described.push({ claim_id: record.id, path: record.path, title: record.title, type: record.type, category: record.category, tags: record.tags, record_status: record.status, mapping, created_at: record.meta.created_at, updated_at: record.meta.updated_at, body: record.body });
  }
  return {
    manifest: { readers: [...readers], claims },
    records: described,
    excluded,
    stats: { files: files.length, records: records.length, claims: claims.length, excluded: excluded.length, skipped_not_record: skipped },
    revision: pinned,
    store,
  };
}
