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
 *   **x** __x__ ~~x~~ strong or struck text, shown as x
 *   *x* _x_           emphasis, shown as x
 *   [x](target)       a link, shown as x
 *
 * and only where x holds NO markup character (`* _ ~ ` [ ] \ < >`), the opener follows a space or an opening bracket or quote, and
 * the closer is not followed by a letter or digit, so that any CommonMark renderer reads it the same way. Everything else that
 * could be markup (a nested pair, a run of three markers, an unpaired marker, an escape, a double-backtick span, an image,
 * HTML, an intraword `*`) makes the WHOLE paragraph be taken exactly as written, so it can only be matched by a claim written the same
 * way and otherwise abstains. Nothing is ever rescanned, so removing one marker cannot turn another into formatting. A lone `_` inside
 * a word (`snake_case`) and a lone `*` between spaces are text, as in CommonMark. The scan is one pass over the paragraph.
 *
 * Stated limits: the sentence cut is a heuristic (a full stop, space, then a capital, digit or opening quote). An abbreviation
 * it does not know can cut a sentence early, and then a sentence tail is supported as if it were a sentence. Negation is not read.
 *
 * @module living-context-text
 */

// A quote marker (`>`, `>>`, `> >`) needs no space after it; a list marker or heading needs one.
const BLOCK_MARKER = /^\s*(?:(?:>\s*)+|(?:[-*+]|\d{1,3}[.)]|#{1,6})\s+)/;
const HEADING = /^\s*#{1,6}\s/;
// Words that end in a full stop without ending a sentence, and dotted initialisms (`U.S.`, `e.g.`, `a.m.`).
const ABBREVIATION = /(?:^|\s)(?:(?:[a-z]\.)*[a-z]|etc|vs|cf|approx|fig|no|dr|mr|mrs|ms|st|inc|ltd)\.$/i;

const MARKUP = /[*_~`[\]\\<>]/;
const isAlnum = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c) => c === undefined || /\s/.test(c);
const OPENS_AFTER = new Set([" ", "(", "[", "{", "\"", "'"]);

/**
 * The text a paragraph displays, for the forms in the module comment; the paragraph itself, unchanged, when it holds anything else
 * that could be markup. Never returns text that a CommonMark renderer would display differently.
 */
export function renderInline(text) {
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
    if (c === "*" || c === "_" || c === "~") {
      let run = 1;
      while (text[i + run] === c) run++;
      const prev = text[i - 1];
      const next = text[i + run];
      // Text, as in CommonMark: a lone `_` inside a word, and a lone marker between spaces.
      if (run === 1 && ((c === "_" && isAlnum(prev) && isAlnum(next)) || (isSpace(prev) && isSpace(next)))) { out += c; i++; continue; }
      const width = c === "~" ? (run === 2 ? 2 : 0) : (run === 1 || run === 2 ? run : 0);
      if (width === 0 || (prev !== undefined && !OPENS_AFTER.has(prev)) || !isAlnum(next)) return text;
      const close = text.indexOf(c, i + width);
      if (close === -1) return text;
      let closeRun = 1;
      while (text[close + closeRun] === c) closeRun++;
      const content = text.slice(i + width, close);
      if (closeRun !== width || MARKUP.test(content) || isSpace(content[content.length - 1]) || isAlnum(text[close + width])) return text;
      out += content; i = close + width; continue;
    }
    return text; // `\`, `<`, `>`, `]`: an escape, HTML, a quote marker or a stray bracket
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
 * one unit; a heading is one line. A unit is rendered (`renderInline`) and then cut into sentences at `. `, `! ` or `? ` before a
 * capital, digit or opening quote (case is kept until after the cut so the capital can be seen). Fenced code and front matter are
 * not prose and yield no unit.
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
    if (fence) {
      const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = undefined;
      continue;
    }
    const opening = /^\s*(`{3,}|~{3,})/.exec(line);
    if (opening) { fence = { char: opening[1][0], length: opening[1].length }; current = undefined; continue; }
    if (line.trim() === "") { current = undefined; continue; }
    const body = line.replace(BLOCK_MARKER, "").replace(/\s+/g, " ").trim();
    const starts = BLOCK_MARKER.test(line);
    if (starts || current === undefined) {
      const kind = HEADING.test(line) ? "heading" : starts ? "item" : "paragraph";
      current = { kind, parts: [body] };
      units.push(current);
      if (kind === "heading") current = undefined;
    } else current.parts.push(body);
  }
  return units.map(({ kind, parts }) => ({ kind, sentences: splitSentences(renderInline(parts.join(" "))).map((sentence) => sentence.trim()).filter(Boolean) }));
}

/**
 * Whether `statement` (plain text) is one sentence, or consecutive whole sentences, of one unit. The unit's sentences are joined once;
 * the statement must begin where a sentence begins and end where a sentence ends (with or without its final full stop). Work is one
 * prefix test per sentence start (native string comparison; 26 ms on a 52 KB unit of repeated prefixes).
 */
export function statementInUnits(units, statement) {
  const wanted = cleanStatement(statement);
  if (wanted === "") return false;
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
