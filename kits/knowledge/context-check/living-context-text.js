/**
 * How Living Context reads prose: the one segmentation shared by the deterministic support verifier (which decides
 * whether a statement is in an authority document) and by question answering (which quotes a passage of a record). Sharing
 * it is what keeps the two honest with each other: a passage that is quoted is always a statement the verifier can find.
 *
 * Dependency-free on purpose, like `index.js`.
 *
 * @module living-context-text
 */

const BLOCK_MARKER = /^\s*(?:[-*+>]|\d{1,3}[.)]|#{1,6})\s+/;
// `Mr`, `e.g` and the like end in a full stop without ending a sentence. A cut that is missed makes the verifier stricter (a sentence
// run it cannot see); a cut at an abbreviation this list lacks makes a sentence tail look like a sentence, so the list errs long.
const ABBREVIATION = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf|approx|fig|no|dr|mr|mrs|ms|st|inc|ltd|[a-z])\.$/i;

/** Inline Markdown that is formatting, not wording: links keep their text; emphasis and code markers go. Applied to claim and document alike. */
export function stripInlineMarkdown(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/(^|[\s(])[*_](?=\S)/g, "$1")
    .replace(/(?<=\S)[*_](?=[\s).,;:!?]|$)/g, "");
}

/** Lower-cased, whitespace-collapsed, markdown- and marker-free, without one trailing full stop: the form two statements are compared in. */
export const cleanStatement = (text) => stripInlineMarkdown(text.replace(/^[\s>*+-]+/, "")).replace(/\s+/g, " ").trim().toLowerCase().replace(/\.$/, "");

function splitSentences(text) {
  const sentences = [];
  let start = 0;
  const cut = /(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/g;
  for (let match = cut.exec(text); match; match = cut.exec(text)) {
    if (ABBREVIATION.test(text.slice(start, match.index))) continue;
    sentences.push(text.slice(start, match.index));
    start = match.index + match[0].length;
  }
  sentences.push(text.slice(start));
  return sentences;
}

/**
 * The statements a document makes, as complete sentences. A document is read the way a person reads it: a blank line, a list
 * item, a quote or a heading starts a new unit, and a line without one continues the unit above, so a hard-wrapped paragraph is
 * one unit. Each unit is cut into sentences at `. `, `! ` or `? ` before a capital, digit or opening quote (case is kept until
 * after the cut so the capital can be seen). Fenced code and front matter are not prose and yield no unit.
 *
 * @returns {{kind: "heading"|"item"|"paragraph", sentences: string[]}[]}
 */
export function documentUnits(text) {
  const units = [];
  let current;
  let fence;
  const lines = text.split(/\r?\n/);
  let index = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) index = end + 1;
  }
  for (; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (fence) { if (marker && marker[1].startsWith(fence)) fence = undefined; continue; }
    if (marker) { fence = marker[1][0].repeat(3); current = undefined; continue; }
    if (line.trim() === "") { current = undefined; continue; }
    const body = stripInlineMarkdown(line.replace(BLOCK_MARKER, "")).replace(/\s+/g, " ").trim();
    const starts = BLOCK_MARKER.test(line);
    if (starts || current === undefined) {
      const kind = /^\s*#{1,6}\s/.test(line) ? "heading" : starts ? "item" : "paragraph";
      current = { kind, parts: [body] };
      units.push(current);
    } else current.parts.push(body);
  }
  return units.map(({ kind, parts }) => ({ kind, sentences: splitSentences(parts.join(" ")).map((sentence) => sentence.trim()).filter(Boolean) }));
}
