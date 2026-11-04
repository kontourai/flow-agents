/**
 * How Living Context reads prose: the one segmentation shared by the deterministic support verifier (which decides
 * whether a statement is in an authority document) and by question answering (which quotes a passage of a record). Sharing
 * it is what keeps the two honest with each other: a passage that is quoted is always a statement the verifier can find.
 *
 * Dependency-free on purpose, like `index.js`. Inline Markdown is removed by one bounded scan that never rescans its own output
 * (a marker exposed by removing another stays text), and sentence matching is a prefix test per sentence start (native string
 * comparison; 26 ms on a 52 KB unit of repeated prefixes), because the verifier runs synchronously and a timeout cannot interrupt
 * it. The same normalisation applies to a unit of any length, so a statement is judged the same in a short paragraph and a long one.
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

/**
 * Code spans in one linear scan: a run of N backticks opens a span that the next run of exactly N backticks closes (CommonMark); an
 * opener with no such run is literal text. No pattern is used, because an unbounded pattern backtracks across unmatched runs.
 */
function codeSpans(text) {
  const runs = [];
  for (let i = 0; i < text.length;) {
    if (text[i] !== "`") { i++; continue; }
    let j = i;
    while (text[j] === "`") j++;
    runs.push({ start: i, end: j, length: j - i });
    i = j;
  }
  const nextSame = new Array(runs.length).fill(-1);
  const seen = new Map();
  for (let r = runs.length - 1; r >= 0; r--) {
    nextSame[r] = seen.get(runs[r].length) ?? -1;
    seen.set(runs[r].length, r);
  }
  const spans = [];
  for (let r = 0; r < runs.length; r++) {
    const closer = nextSame[r];
    if (closer === -1) continue;
    spans.push({ index: runs[r].start, length: runs[closer].end - runs[r].start, content: text.slice(runs[r].end, runs[closer].start) });
    r = closer;
  }
  return spans;
}

const MAX_SPAN = 2000;
const MAX_DEPTH = 3;
const MAX_CANDIDATES = 50;
const isWord = (c) => c !== undefined && /\w/.test(c);
const isSpace = (c) => c === undefined || /\s/.test(c);

/**
 * One left-to-right scan that consumes formatting and never rescans its own output, so a marker exposed by removing another stays text:
 * a code span is kept exactly as written; `[label](target)` keeps its label; `**x**`, `__x__`, `~~x~~`, `*x*` and `_x_` keep their
 * inner text, which is scanned once more at the next depth (so `**a *b* c**` and `*a **b** c*` both strip). A marker with no
 * partner within MAX_SPAN characters, a run of three or more, an intraword `_` or `*`, and anything deeper than MAX_DEPTH is text.
 * A closer is looked for among at most MAX_CANDIDATES later runs of the same marker within MAX_SPAN characters, so the cost is at most
 * the text length times MAX_CANDIDATES (dense openers have dense runs, sparse ones few openers). A backslash before punctuation keeps
 * the punctuation as a character.
 */
function inline(text, depth) {
  if (depth > MAX_DEPTH) return text;
  const spans = new Map();
  const inCode = new Uint8Array(text.length);
  for (const span of codeSpans(text)) { spans.set(span.index, span); inCode.fill(1, span.index, span.index + span.length); }
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const span = spans.get(i);
    if (span) { out += span.content; i += span.length; continue; }
    if (c === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) { out += text[i + 1]; i += 2; continue; }
    if (c === "[" || (c === "!" && text[i + 1] === "[")) {
      const open = c === "!" ? i + 1 : i;
      const labelEnd = text.slice(open + 1, open + 302).indexOf("]");
      if (labelEnd !== -1 && text[open + 1 + labelEnd + 1] === "(") {
        const close = open + 1 + labelEnd;
        const targetEnd = text.slice(close + 2, close + 503).indexOf(")");
        if (targetEnd !== -1) { out += inline(text.slice(open + 1, close), depth + 1); i = close + 2 + targetEnd + 1; continue; }
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      let run = 1;
      while (text[i + run] === c) run++;
      const width = c === "~" ? (run === 2 ? 2 : 0) : (run === 1 || run === 2 ? run : 0);
      if (width > 0 && !isSpace(text[i + width]) && !isWord(text[i - 1])) {
        const limit = Math.min(text.length, i + width + MAX_SPAN);
        let closer = -1;
        let candidates = 0;
        for (let k = i + width; k < limit;) {
          if (inCode[k]) { k++; continue; }
          if (text[k] !== c) { k++; continue; }
          let length = 1;
          while (text[k + length] === c) length++;
          if (++candidates > MAX_CANDIDATES) break;
          if (length === width && !isSpace(text[k - 1]) && !isWord(text[k + length]) && text[k + length] !== c) { closer = k; break; }
          k += length;
        }
        if (closer !== -1) { out += inline(text.slice(i + width, closer), depth + 1); i = closer + width; continue; }
      }
      out += text.slice(i, i + run);
      i += run;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Inline Markdown that is formatting, not wording, removed from `text` (see `inline`). Applied to claim and document alike. */
export function stripInlineMarkdown(text) {
  return inline(text, 0);
}

const squash = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();
/** The form a statement is compared in, before the closing full stop is considered. */
// A list marker is a marker only when whitespace follows it (`*Admin` and `-5` begin with a character of the statement); a quote marker needs none.
export const comparable = (text) => squash(stripInlineMarkdown(text.replace(/^(?:\s*(?:>|[*+-](?=\s)))+/, "")));
const withoutFinalStop = (text) => text.replace(/\.$/, "");
/** Lower-cased, whitespace-collapsed, markup- and marker-free, without one trailing full stop: the form two statements are compared in. */
export const cleanStatement = (text) => withoutFinalStop(comparable(text));

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
 * one unit; a heading is one line. Each unit is cut into sentences at `. `, `! ` or `? ` before a capital, digit or opening quote
 * (case is kept until after the cut so the capital can be seen). Fenced code and front matter are not prose and yield no unit.
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
  return units.map(({ kind, parts }) => ({ kind, sentences: splitSentences(stripInlineMarkdown(parts.join(" "))).map((sentence) => sentence.trim()).filter(Boolean) }));
}

/**
 * Whether `statement` is one sentence, or consecutive whole sentences, of one unit. The unit's sentences are joined once; the statement
 * must begin where a sentence begins and end where a sentence ends (with or without its final full stop). Work is one prefix test per
 * sentence start, so it is bounded by the unit size times the number of sentences in it at worst and in practice by a single pass.
 */
export function statementInUnits(units, statement) {
  const wanted = withoutFinalStop(comparable(statement));
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
