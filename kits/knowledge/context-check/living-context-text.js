/**
 * How Living Context reads prose: the one segmentation shared by the deterministic support verifier (which decides
 * whether a statement is in an authority document) and by question answering (which quotes a passage of a record). Sharing
 * it is what keeps the two honest with each other: a passage that is quoted is always a statement the verifier can find.
 *
 * Dependency-free on purpose, like `index.js`.
 *
 * The contract: a CLAIM is plain text, compared as written (case, whitespace, a leading list or quote marker and one closing full
 * stop aside). A DOCUMENT is read as a person sees it: hard wraps are joined, and a small set of Markdown forms is rendered to the
 * text they display. The set is deliberately the part of Markdown whose meaning needs no judgement:
 *
 *   `code`            a single-backtick span, no backtick inside, no space at either edge, shown as its content
 *   **x** __x__       strong text, shown as x
 *   *x* _x_           emphasis, shown as x
 *   [x](target)       a link, shown as x
 *
 * and only where x holds NO markup character (`* _ ~ ` [ ] \ < >`), the opener follows a space or an opening bracket or quote, and
 * the closer is not followed by a letter or digit, so that a CommonMark renderer reads it the same way. Everything else that
 * could be markup (a nested pair, a run of three markers, an unpaired marker, an escape, an entity reference, a double-backtick
 * span, an image, HTML, an intraword `*`, GFM strikethrough, which CommonMark does not have) makes the WHOLE paragraph be taken
 * exactly as written: it then matches only a claim that is a verbatim sentence of its source, and otherwise the verifier abstains.
 * Block structure is read the same cautious way (`documentUnits`): only paragraphs, list items and headings are prose; indented
 * and fenced code (also inside a quote), tables, HTML blocks, thematic breaks, setext underlines and link definitions are not. Nothing is ever rescanned, so removing one marker cannot turn another into formatting. A lone `_` inside
 * a word (`snake_case`) and a lone `*` between spaces are text, as in CommonMark. The scan is one pass over the paragraph.
 *
 * Block structure is read only for flat documents (see `documentUnits`): paragraphs, ATX headings, top-level list items with continuation
 * lines, tables and fenced code at column 0 (skipped) and thematic breaks. A document that has anything whose meaning depends on a container
 * or on context further up (a quote, an indented fence, an HTML block, a reference definition, a nested list item, indented code, a setext underline, a lone CR, a NUL) is read
 * one physical line per unit: the version 2 rule and nothing more. The hard cases of CommonMark (laziness, container-relative fences,
 * interrupting rules) are never modelled; they switch the sentence reading off. This is a floor; production callers inject a model or
 * human verifier.
 *
 * Stated limits: a passage taken from a paragraph is normally found again by the verifier, but not always (a list nested in a list,
 * a code literal that begins with `-`, `>` or `*`); `bestPassage` checks it and `ask` abstains when it is not. The sentence cut is a heuristic (a full stop, space, then a capital, digit or opening quote). An abbreviation
 * it does not know can cut a sentence early, and then a sentence tail is supported as if it were a sentence. Negation is not read.
 *
 * @module living-context-text
 */

// Block syntax. Only the flat, common subset is read; a document that uses anything whose meaning depends on a container or on context
// further up (see POISON) is not read as prose at all, line by line only. That is the whole safety argument for the block layer.
const LIST_MARKER = /^[ ]?(?:[-*+]|(\d{1,9})[.)])(?:[ \t]+|$)/; // top level only: at most one space of indentation
const ATX = /^[ ]{0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC = /^[ ]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BLANK = /^[ ]*$/; // a blank line is spaces only (a tab anywhere outside a fence makes the document contextual; Unicode spaces are text, as in CommonMark)
const FENCE_OPEN = /^(`{3,}|~{3,})/; // a fence at column 0 only; it swallows lines up to its closing fence (or the end of the document)
const FENCE_LIKE = /^[ \t]*(?:`{3,}|~{3,})/;
const fenceCloses = (line, fence) => { const match = /^(`{3,}|~{3,})[ \t]*$/.exec(line); return Boolean(match) && match[1][0] === fence.char && match[1].length >= fence.length; };
const SETEXT = /^[ ]{0,3}(?:=+|-+)[ \t]*$/;
const POISON = [
  /^[ \t]*>/,                               // a quote: containers, laziness
  /^[ \t]+(?:`{3,}|~{3,})/,                 // an indented fence: its closer is relative to a container
  /\t/,                                     // a tab: columns, not characters, decide indentation
  /^[ ]?(?:[-*+]|\d{1,9}[.)])[ ]*$/,         // an empty list item: it ends the item above and does not start a paragraph
  /^[ \t]*<[!/?A-Za-z]/,                    // an HTML block (or a tag that starts one)
  /^[ ]{0,3}\[[^\]]+\]:/,                   // a link reference or footnote definition, with continuation lines
  /^[ \t]{2,}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/, // a nested list item
  // A list item whose content is itself a block: a quote, a fence, a heading, HTML, another item, or indented code (five spaces after the marker).
  /^[ ]?(?:[-*+]|\d{1,9}[.)])(?:[ \t]+(?:>|`{3,}|~{3,}|#{1,6}(?:[ \t]|$)|<[!/?A-Za-z]|\[[^\]]+\]:|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))|[ ]{5,}\S|\t)/,
];
// Words that end in a full stop without ending a sentence, and dotted initialisms (`U.S.`, `e.g.`, `a.m.`); tested on the last word only.
const ABBREVIATION = /^(?:(?:[a-z]\.)*[a-z]|etc|vs|cf|approx|fig|no|dr|mr|mrs|ms|st|inc|ltd)\.$/i;

/** A statement longer than this is not matched by the sentence reading (a claim is capped at 1,000 characters, a passage at 700); it bounds the cost of a repeated-prefix document. */
const MAX_STATEMENT_CHARS = 4000;
const MARKUP = /[*_~`[\]\\<>]/;
const ENTITY = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;
const isAlnum = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c) => c === undefined || /\s/.test(c);
const OPENS_AFTER = new Set([" ", "(", "[", "{", "\"", "'"]);

/**
 * The text a paragraph displays, for the forms in the module comment; the paragraph itself, unchanged, when it holds anything else
 * that could be markup. Never returns text that a CommonMark renderer would display differently.
 */
export function renderInline(text) {
  if (ENTITY.test(text)) return text; // `&amp;` displays `&`: a reference is not text a claim can match without reading it
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (!MARKUP.test(c) && c !== "!") { out += c; i++; continue; }
    if (c === "!") {
      if (text[i + 1] === "[") return text; // an image displays its alt text, not "!"
      out += c; i++; continue;
    }
    if (c === "`") {
      if (text[i + 1] === "`") return text;
      const close = text.indexOf("`", i + 1);
      const content = close === -1 ? "" : text.slice(i + 1, close);
      if (close === -1 || content === "" || text[close + 1] === "`" || /^\s|\s$/.test(content)) return text;
      out += content; i = close + 1; continue;
    }
    if (c === "[") {
      const close = text.indexOf("]", i + 1);
      const label = close === -1 ? "" : text.slice(i + 1, close);
      if (close === -1 || label === "" || MARKUP.test(label) || text[close + 1] !== "(") return text;
      const end = text.indexOf(")", close + 2);
      const target = end === -1 ? "" : text.slice(close + 2, end);
      if (end === -1 || !/^[^\s()\\<>`*_[\]]*$/.test(target)) return text;
      out += label; i = end + 1; continue;
    }
    if (c === "*" || c === "_") {
      let run = 1;
      while (text[i + run] === c) run++;
      const prev = text[i - 1];
      const next = text[i + run];
      // Text, as in CommonMark: a lone `_` inside a word, and a lone marker between spaces.
      if (run === 1 && ((c === "_" && isAlnum(prev) && isAlnum(next)) || (isSpace(prev) && isSpace(next)))) { out += c; i++; continue; }
      const width = run === 1 || run === 2 ? run : 0;
      if (width === 0 || (prev !== undefined && !OPENS_AFTER.has(prev)) || !isAlnum(next)) return text;
      const close = text.indexOf(c, i + width);
      if (close === -1) return text;
      let closeRun = 1;
      while (text[close + closeRun] === c) closeRun++;
      const content = text.slice(i + width, close);
      if (closeRun !== width || MARKUP.test(content) || isSpace(content[content.length - 1]) || isAlnum(text[close + width])) return text;
      out += content; i = close + width; continue;
    }
    return text; // `~`, `\`, `<`, `>`, `]`: strikethrough (an extension), an escape, HTML, a quote marker or a stray bracket
  }
  return out;
}

const squash = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();
// A list marker is a marker only when whitespace follows it (`*Admin` and `-5` begin with a character of the statement); a quote marker needs none.
const withoutMarker = (text) => text.replace(/^(?:\s*(?:>|[*+-](?=\s)))+/, "");
const withoutFinalStop = (text) => text.replace(/\.$/, "");
/** Lower-cased, whitespace-collapsed, without a leading list or quote marker or one closing full stop: the form a claim, or a physical line, is compared in. */
export const cleanStatement = (text) => withoutFinalStop(squash(withoutMarker(text)));

function splitSentences(text) {
  const sentences = [];
  let start = 0;
  const cut = /(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/g;
  for (let match = cut.exec(text); match; match = cut.exec(text)) {
    const wordStart = Math.max(start, text.lastIndexOf(" ", match.index - 1) + 1);
    if (ABBREVIATION.test(text.slice(wordStart, match.index))) continue;
    sentences.push(text.slice(start, match.index));
    start = match.index + match[0].length;
  }
  sentences.push(text.slice(start));
  return sentences;
}

/**
 * The statements a document makes, as complete sentences. A document is read the way a person reads it: a blank line, a list item or
 * a heading starts a new unit, and a line without one continues the unit above, so a hard-wrapped paragraph is one unit; a heading is
 * one line. A unit is rendered (`renderInline`) and then cut into sentences at `. `, `! ` or `? ` before a capital, digit or opening
 * quote (case is kept until after the cut so the capital can be seen). Tables are skipped to their blank line.
 *
 * Only a flat document is read this way: paragraphs, ATX headings, top-level list items with continuation lines, tables, thematic
 * breaks and fenced code at column 0 (skipped). If the document has anything else whose meaning depends on a container or on context further up (a quote, an indented fence, an HTML
 * block, a reference definition, a nested list item, indented code, a setext underline, a lone CR or a NUL), it is read one physical
 * line per unit, which is the version 2 rule and nothing more.
 *
 * @returns {{kind: "heading"|"item"|"paragraph", sentences: string[]}[]}
 */
export function documentUnits(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) start = end + 1;
  }
  if (/[\r\u0000]/.test(lines.join("\n")) || isContextual(lines, start)) return lineUnits(lines.slice(start));
  const units = [];
  let current;
  let fence;
  let skipping = false; // a table: not prose up to the blank line
  for (let index = start; index < lines.length; index++) {
    const line = lines[index];
    if (fence) { if (fenceCloses(line, fence)) fence = undefined; continue; }
    const opening = FENCE_OPEN.exec(line);
    if (opening) { fence = { char: opening[1][0], length: opening[1].length }; current = undefined; skipping = false; continue; }
    if (BLANK.test(line)) { current = undefined; skipping = false; continue; }
    if (skipping) continue;
    if (THEMATIC.test(line)) { current = undefined; continue; }
    if (line.includes("|")) {
      if (current && units.at(-1) === current) units.pop();
      current = undefined;
      skipping = true;
      continue;
    }
    const list = LIST_MARKER.exec(line);
    const listStart = list && !BLANK.test(line.slice(list[0].length)) && !(list[1] !== undefined && current?.kind === "paragraph" && Number(list[1]) !== 1);
    const heading = ATX.test(line);
    let body = line.replace(heading ? /^[ ]{0,3}#{1,6}/ : listStart ? LIST_MARKER : /^$/, "");
    // An ATX heading's optional closing sequence is not displayed. It is separated from the text, or from the opening hashes, by spaces or tabs only.
    if (heading) body = body.replace(/[ \t]+#+[ \t]*$/, "");
    body = body.replace(/\s+/g, " ").trim();
    if (heading || listStart || current === undefined) {
      current = { kind: heading ? "heading" : listStart ? "item" : "paragraph", parts: [body] };
      units.push(current);
      if (heading) current = undefined;
    } else current.parts.push(body);
  }
  return units.map(({ kind, parts }) => ({ kind, sentences: splitSentences(renderInline(parts.join(" "))).map((sentence) => sentence.trim()).filter(Boolean) }));
}

/** Whether `documentUnits` reads this document as prose (the flat reading) rather than one line per unit. */
export function isFlatDocument(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines[0] === "---" && lines.indexOf("---", 1) > 0 ? lines.indexOf("---", 1) + 1 : 0;
  return !/[\r\u0000]/.test(lines.join("\n")) && !isContextual(lines, start);
}

/** Whether the document uses anything the flat reading cannot place: see `documentUnits`. */
function isContextual(lines, start) {
  let previous = ""; // the previous line, "" at the start, after a blank line and around a fence
  let previousIsHeading = false;
  let fence;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index];
    if (fence) {
      if (fenceCloses(line, fence)) { fence = undefined; previous = ""; }
      else if (FENCE_LIKE.test(line) && !FENCE_OPEN.test(line)) return true; // an indented fence-like line may or may not close it, depending on the renderer
      continue;
    }
    const opening = FENCE_OPEN.exec(line);
    if (opening) {
      if (opening[1][0] === "`" && line.slice(opening[1].length).includes("`")) return true; // not a fence at all: inline code
      fence = { char: opening[1][0], length: opening[1].length };
      previous = "";
      previousIsHeading = false;
      continue;
    }
    if (POISON.some((pattern) => pattern.test(line))) return true;
    if (/^ {2,}(?:#{1,6}(?:[ \t]|$)|([-*_])(?:[ \t]*\1){2,}[ \t]*$)/.test(line)) return true; // a heading or a rule inside a list item (indented): it resets the item's paragraph
    if (SETEXT.test(line) && !BLANK.test(previous)) return true; // an underline turns the line above into a heading
    if (/^ {2}/.test(line) && (BLANK.test(previous) || previousIsHeading)) return true; // indented code, or a loose list item's next paragraph: both depend on the item above
    previousIsHeading = ATX.test(line);
    previous = line;
  }
  return false;
}

/** One unit per physical line: exactly the version 2 reading (a leading list or quote marker is not part of the line; nothing else is touched). */
function lineUnits(lines) {
  return lines.filter((line) => !BLANK.test(line)).map((line) => {
    const sentence = withoutMarker(line).replace(/\s+/g, " ").trim();
    return { kind: ATX.test(line) ? "heading" : "paragraph", sentences: sentence ? [sentence] : [] };
  });
}

/**
 * Whether `statement` (plain text) is one sentence, or consecutive whole sentences, of one unit. The unit's sentences are joined once;
 * the statement must begin where a sentence begins and end where a sentence ends (with or without its final full stop). Work is one
 * prefix test per sentence start (native string comparison; 26 ms on a 52 KB unit of repeated prefixes).
 */
export function statementInUnits(units, statement) {
  const wanted = cleanStatement(statement);
  if (wanted === "" || wanted.length > MAX_STATEMENT_CHARS) return false;
  for (const { sentences } of units) {
    const keys = sentences.map(squash);
    const starts = [];
    const ends = new Set();
    let offset = 0;
    for (const key of keys) {
      starts.push(offset);
      ends.add(offset + key.length);
      if (key.endsWith(".")) ends.add(offset + key.length - 1);
      offset += key.length + 1;
    }
    const joined = keys.join(" ");
    for (const start of starts) {
      if (joined.startsWith(wanted, start) && ends.has(start + wanted.length)) return true;
    }
  }
  return false;
}
