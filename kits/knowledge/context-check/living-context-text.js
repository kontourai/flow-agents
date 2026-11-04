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
 * Block structure follows CommonMark's rules for the constructs below and treats everything else as not prose: quote prefixes are a
 * container (consecutive quoted lines are one paragraph; an unprefixed line continues a quoted paragraph unless it starts a block), a fence
 * closes only in the container that opened it, a fence inside a list item may be indented, an ordered marker other than `1.` cannot
 * interrupt a paragraph, HTML blocks, tables and link definitions are skipped to the end of their block, lone CR is a line ending and NUL
 * becomes U+FFFD. Not modelled, so not claimed: nested lists beyond a continuation line, a list item's own container indentation, setext
 * headings of several lines inside a quote, and block constructs this module does not list. This is a floor; production callers inject a
 * model or human verifier.
 *
 * Stated limits: a passage taken from a paragraph is normally found again by the verifier, but not always (a list nested in a list,
 * a code literal that begins with `-`, `>` or `*`); `bestPassage` checks it and `ask` abstains when it is not. The sentence cut is a heuristic (a full stop, space, then a capital, digit or opening quote). An abbreviation
 * it does not know can cut a sentence early, and then a sentence tail is supported as if it were a sentence. Negation is not read.
 *
 * @module living-context-text
 */

// Block syntax, read from CommonMark and kept deliberately narrower than it: whatever is not recognised as prose is not prose.
const QUOTE_PREFIX = /^(?:[ ]{0,3}>[ ]?)+/;
const LIST_MARKER = /^[ \t]*(?:[-*+]|(\d{1,9})[.)])(?:[ \t]+|$)/;
const ATX = /^[ ]{0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC = /^[ ]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^[ ]{0,3}(?:=+|-+)[ \t]*$/;
const FENCE = /^[ ]{0,3}(`{3,}|~{3,})/;
const HTML_START = /^[ ]{0,3}<[!/?A-Za-z]/;
const DEFINITION = /^[ ]{0,3}\[[^\]]+\]:/;
// How an HTML block ends: a comment, a processing instruction, CDATA, a declaration and pre/script/style/textarea have their own closer; any other tag ends at a blank line.
const HTML_CLOSERS = [[/^[ ]{0,3}<!--/, /-->/], [/^[ ]{0,3}<\?/, /\?>/], [/^[ ]{0,3}<!\[CDATA\[/, /\]\]>/], [/^[ ]{0,3}<![A-Za-z]/, />/], [/^[ ]{0,3}<(?:pre|script|style|textarea)\b/i, /<\/(?:pre|script|style|textarea)>/i]];
// Words that end in a full stop without ending a sentence, and dotted initialisms (`U.S.`, `e.g.`, `a.m.`); tested on the last word only.
const ABBREVIATION = /^(?:(?:[a-z]\.)*[a-z]|etc|vs|cf|approx|fig|no|dr|mr|mrs|ms|st|inc|ltd)\.$/i;

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
  let current; // the open paragraph, item or heading: { kind, parts, container }
  let fence;   // { char, length, container }
  let skip;    // a table, an HTML block or a link definition: not prose up to its end { until?, closed, container }
  const lines = text.replace(/\u0000/g, "\uFFFD").split(/\r\n|\r|\n/);
  let index = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) index = end + 1;
  }
  const blank = (line, container, core) => line.trim() === "" || (container === skip?.container && core.trim() === "");
  for (; index < lines.length; index++) {
    const line = lines[index];
    const prefix = QUOTE_PREFIX.exec(line)?.[0] ?? "";
    const container = prefix.replace(/[^>]/g, ""); // the quote nesting this line is in: "", ">", ">>"
    const core = line.slice(prefix.length);
    if (fence) {
      // A fence opened in a container closes only on a line of that container: a `>` in code is code.
      const closing = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(core);
      if (container === fence.container && closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (skip) {
      if (skip.until && !skip.closed) { if (skip.until.test(core)) skip.closed = true; continue; }
      if (blank(line, container, core)) { skip = undefined; current = undefined; }
      continue;
    }
    if (core.trim() === "") { current = undefined; continue; }
    const list = LIST_MARKER.exec(core);
    const orderedStart = list && list[1] !== undefined;
    const listStart = list && core.slice(list[0].length).trim() !== "" && !(orderedStart && current?.kind === "paragraph" && Number(list[1]) !== 1);
    const opensFence = FENCE.exec(core) ?? (current?.kind === "item" ? /^[ \t]+(`{3,}|~{3,})/.exec(core) : null);
    const html = HTML_START.test(core);
    const table = core.includes("|");
    const startsBlock = ATX.test(core) || THEMATIC.test(core) || opensFence || html || table || listStart;
    // A line that drops a quote prefix continues the quote's paragraph (laziness); anything that starts a block, or a different quote depth, does not.
    if (current && current.container !== container) {
      if (container === "" && !startsBlock && current.kind !== "heading") { current.parts.push(core.replace(/\s+/g, " ").trim()); continue; }
      current = undefined;
    }
    if (opensFence) { fence = { char: opensFence[1][0], length: opensFence[1].length, container }; current = undefined; continue; }
    if (current && (current.kind === "paragraph" || (current.kind === "item" && /^[ \t]{2,}/.test(core))) && SETEXT.test(core)) { current.kind = "heading"; current = undefined; continue; } // a setext underline
    if (THEMATIC.test(core)) { current = undefined; continue; }
    // Not prose, and not allowed to leave half a paragraph behind. A table runs to the next blank line; an HTML block to its end and then to
    // the next blank line; a link definition (only at a block start: it cannot interrupt a paragraph) with whatever continues it.
    if (table || html || (current === undefined && DEFINITION.test(core))) {
      if (current && units.at(-1) === current) units.pop();
      current = undefined;
      const kind = html ? HTML_CLOSERS.find(([opener]) => opener.test(core)) : undefined;
      // An HTML block that closes on its own opening line still skips to the next blank line: what follows a tag is not read as prose.
      skip = { until: kind?.[1], closed: kind ? kind[1].test(core.replace(kind[0], "")) : true, container };
      continue;
    }
    if (current === undefined && /^(?: {4}|\t)/.test(core)) continue; // an indented code block
    const heading = ATX.test(core);
    let body = core.replace(heading ? /^[ ]{0,3}#{1,6}[ \t]*/ : list && listStart ? LIST_MARKER : /^$/, "").replace(/\s+/g, " ").trim();
    if (heading) body = body.replace(/\s+#+$/, ""); // an ATX heading's optional closing sequence is not displayed
    if (heading || listStart || current === undefined) {
      const kind = heading ? "heading" : listStart ? "item" : "paragraph";
      current = { kind, parts: [body], container };
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
