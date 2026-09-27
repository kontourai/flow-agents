import { isMap, isSeq, parseDocument } from "./vendor/yaml.mjs";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const LEGACY_EVIDENCE_STRINGS = {
  propose: ["concept_id", "proposer_id", "proposal"],
  apply: ["proposer_id", "rationale"],
  reject: ["proposer_id", "reason"],
  "superseded-by": ["superseded_by_id"],
  retire: ["targetStatus", "rationale", "implementedByRef", "supersededByRef"],
};

function legacyDashScalars(source, document) {
  if (!isMap(document.contents)) return source;
  const replacements = [];
  const inspect = (map, fields) => {
    if (!isMap(map)) return;
    for (const pair of map.items) {
      const token = pair.srcToken?.value;
      if (!fields.includes(pair.key?.value) || token?.type !== "error" || token.source !== "-") continue;
      const newline = source.indexOf("\n", token.offset);
      const end = newline === -1 ? source.length : newline;
      const value = source.slice(token.offset, end);
      // These are precisely bare dash strings the old scalar writers admitted.
      if (!/^-(?:[ \t][^\r\n]*)?$/.test(value) || value.trim() !== value || /[:#\[\]{},&*?|<>=!%@`"'\r]/.test(value)) continue;
      replacements.push({ start: token.offset, end, value: JSON.stringify(value) });
    }
  };
  const root = document.contents;
  inspect(root, ["id", "type", "title", "category", "status", "created_at", "updated_at", "expires_at"]);
  inspect(root.get("provenance", true), ["agent", "session_id", "note"]);
  for (const [name, fields] of [
    ["links", ["target_id", "kind", "label"]],
    ["mutation_log", ["op", "at", "agent", "note"]],
  ]) {
    const sequence = root.get(name, true);
    if (isSeq(sequence)) for (const item of sequence.items) {
      inspect(item, fields);
      if (name === "mutation_log" && isMap(item)) {
        if (item.get("op") === "supersede") inspect(item, ["rationale"]);
        if (item.get("op") === "superseded-by") inspect(item, ["new_id", "rationale"]);
        const evidenceFields = LEGACY_EVIDENCE_STRINGS[item.get("op")];
        if (Array.isArray(evidenceFields)) inspect(item.get("evidence", true), evidenceFields);
      }
    }
  }
  if (!replacements.length) return source;
  const chunks = [];
  let offset = 0;
  for (const item of replacements.sort((a, b) => a.start - b.start)) {
    chunks.push(source.slice(offset, item.start), item.value);
    offset = item.end;
  }
  chunks.push(source.slice(offset));
  return chunks.join("");
}

/** YAML failsafe preserves the original adapters' text scalars, including true/null/numerals. */
export function readKnowledgeYaml(source) {
  if (Buffer.byteLength(source) > MAX_BYTES) throw new Error("Knowledge YAML byte limit exceeded.");
  const options = {
    schema: "failsafe", version: "1.2", merge: false, resolveKnownTags: false,
    strict: true, uniqueKeys: true, stringKeys: true, prettyErrors: false, keepSourceTokens: true,
  };
  let document = parseDocument(source, options);
  if (document.errors.length) {
    const compatible = legacyDashScalars(source, document);
    if (compatible !== source) document = parseDocument(compatible, options);
  }
  if (document.errors.length || document.warnings.length) throw new Error("Invalid Knowledge YAML frontmatter.");
  const value = document.toJS({ maxAliasCount: 100 });
  if (value === null && source.trim() === "") return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Knowledge YAML frontmatter must be a mapping.");
  const ancestors = new Set();
  let nodes = 0;
  const check = (item, depth) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("Knowledge YAML structure limit exceeded.");
    if (item === null || typeof item === "string") return;
    if (typeof item !== "object" || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) throw new Error("Knowledge YAML metadata must be JSON-compatible.");
    if (ancestors.has(item)) throw new Error("Cyclic Knowledge YAML metadata is not supported.");
    ancestors.add(item);
    for (const child of Object.values(item)) check(child, depth + 1);
    ancestors.delete(item);
  };
  check(value, 0);
  return value;
}
