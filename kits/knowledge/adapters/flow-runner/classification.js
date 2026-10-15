// Infer a category from raw text and provided meta. The caller may supply
// category directly in meta; otherwise we derive it from keywords.
export function inferCategory(rawText, meta) {
  if (meta?.category) return meta.category;

  const text = (rawText || "").toLowerCase();

  // Simple keyword-based classifier — good enough for an ingest gate
  if (/\b(api|rest|graphql|endpoint|http)\b/.test(text)) return "engineering.api";
  if (/\b(test|spec|unit|assertion)\b/.test(text)) return "engineering.testing";
  if (/\b(architecture|design|pattern|system)\b/.test(text)) return "engineering.architecture";
  if (/\b(meeting|standup|decision|action item)\b/.test(text)) return "team.meeting";
  if (/\b(research|study|paper|finding)\b/.test(text)) return "research.notes";
  if (/\b(bug|fix|issue|error|exception)\b/.test(text)) return "engineering.bugs";
  if (/\b(deploy|release|version|ci|cd)\b/.test(text)) return "engineering.ops";

  return "general";
}

// Derive a title from the raw text (first line, truncated)
export function inferTitle(rawText, meta) {
  if (meta?.title) return meta.title;
  const firstLine = (rawText || "").split("\n")[0].trim().slice(0, 80);
  return firstLine || "Untitled capture";
}
