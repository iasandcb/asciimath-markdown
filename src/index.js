// Minimal, dependency-free Markdown -> HTML renderer.
// All text is HTML-escaped before any markup is applied, so raw HTML/script
// content coming back from an LLM can never execute in the page.
//
// Math syntax:
//   $...$          inline math (LaTeX by default; rendered via KaTeX)
//   $$...$$        block math (own line(s), or a single "$$ ... $$" line)
//   \(...\)        inline math, always LaTeX regardless of directive
//   \[...\]        block math, always LaTeX (own line(s), or a single "\[ ... \]" line)
//   ```asciimath   fenced block AsciiMath (always AsciiMath, regardless of directive)
//   ```math/latex  fenced block LaTeX (always LaTeX, regardless of directive)
//
// \(...\) and \[...\] are native LaTeX notation with no AsciiMath equivalent,
// so — like the fenced ```math blocks — they ignore the document's math
// directive entirely and always render as LaTeX.
//
// A document-wide directive switches what bare $ and $$ mean for that whole
// document (fenced blocks above are unaffected, since they're already explicit):
//   <!-- math: asciimath -->   makes $...$ / $$...$$ parse as AsciiMath
//   <!-- math: latex -->       makes $...$ / $$...$$ parse as LaTeX (the default)
//   <!-- math: hybrid -->      same as asciimath for $/$$ - the two only
//                              differ in what \(...\)/\[...\] mean going
//                              *into* the document (see
//                              latex_to_asciimath.py's `hybrid` param): a
//                              deliberate, permanent LaTeX+AsciiMath2 mix
//                              rather than best-effort-convert-everything's
//                              incidental leftover LaTeX. Renders identically
//                              to asciimath either way, since \(...\)/\[...\]
//                              are already always LaTeX above regardless.
// The directive line itself is stripped from the rendered output and may
// appear anywhere in the document; the last occurrence wins. A document with
// no directive of its own falls back to the `fallbackDialect` argument passed
// to renderMarkdown() — a host app can use this to inherit a dialect from
// prompt directive into every other document in that session.
//
// The AsciiMath dialect here is AsciiMath2 (https://github.com/iasandcb/asciimath2
// documents the grammar) - the asciimath.org base plus matrices, aligned
// multi-line equations, colors, fonts, accents, etc. - rendered via
// `asciimath-parser` (https://github.com/widcardw/asciimath-parser).
//
// LaTeX spans are handed to KaTeX, which is an *optional* peer dependency:
// pass it in with setKatex(), or leave it on `globalThis` (a plain
// <script> tag from a CDN does that). Without it, math spans render as
// `<span class="math-error">` and the rest of the document is unaffected -
// see renderLatex below.
import { AsciiMath, TokenTypes } from "asciimath-parser";

// `display` is passed per-call to `toTex()` instead (see `renderAsciiMath`/
// `renderMathBlock` below), so it doesn't matter here.
//
// `symbols` below repoints "<="/">=" to \le/\ge instead of asciimath-parser's
// own default \leqslant/\geqslant (see packages/core/src/symbols.ts on the
// widcardw/asciimath-parser main branch) - a deviation from asciimath.org's
// original grammar (there, "<=" was always \le) that this library introduced
// as a side effect of adding "le"/"ge" as extra mnemonic aliases, contrary to
// SPEC.md section 2.3 ("le"/"ge" as ASCII-safe spellings of the *same* \le
// \ge, not a different slanted variant). \leqslant/\geqslant become
// unreachable from AsciiMath2 source as a result - an accepted loss, since
// essentially nothing but French/Russian-convention documents uses them over
// plain \le/\ge. Must match asciimath2/src/asciimath2/symbols.py's own
// le/ge/leqslant/geqslant entries, which collapse the same way for the
// reverse (LaTeX -> AsciiMath2) direction.
//
// A `symbols` config mutates asciimath-parser's shared, module-level
// SYMBOLMAP in place (see widcardw/asciimath-parser#21) rather than scoping
// to just this instance - harmless here since `asciiMath` (below) is the
// only AsciiMath instance ever created for the page's lifetime, and the
// point is exactly to change the meaning everywhere, permanently.
const BUILTIN_SYMBOL_OVERRIDES = [
  ["<=", { type: TokenTypes.Const, tex: "\\le" }],
  [">=", { type: TokenTypes.Const, tex: "\\ge" }],
];

// The custom-symbols table (see
// selectGlobalCustomSymbols / setCustomAsciiMathSymbols) adds further
// `[token, latex]` rows on top of BUILTIN_SYMBOL_OVERRIDES - taken verbatim,
// with no classification needed (unlike a converter's own table, which
// harder reverse-direction job): asciimath-parser's `symbols` config is
// already exactly "input token -> literal LaTeX", the same shape a CSV row
// is. A row naming "<=" or ">=" again would simply override
// BUILTIN_SYMBOL_OVERRIDES's entry - later entries win (see
// asciimath-parser's own config-merging logic) - which is the right
// behavior for a deliberate user customization.
function buildAsciiMath(customRows) {
  return new AsciiMath({
    display: false,
    symbols: [
      ...BUILTIN_SYMBOL_OVERRIDES,
      ...customRows.map(([token, latex]) => [token, { type: TokenTypes.Const, tex: latex }]),
    ],
  });
}

let asciiMath = buildAsciiMath([]);

// Called once at startup and again whenever the custom-symbols document is
// saved - `customRows` is `[token, latex]` pairs, e.g. from
// parseCustomSymbolsCsv below.
export function setCustomAsciiMathSymbols(customRows) {
  asciiMath = buildAsciiMath(customRows);
}

// Minimal RFC4180-ish single-line CSV field splitter (quoted fields, ""
// escaping a literal quote) - deliberately matches Python's `csv` module,
// so the same table file can be parsed on both sides of an app that
// generates AsciiMath2 server-side and renders it here.
function splitCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// Parses a custom-symbols CSV into `[token, latex]` pairs, ready for
// setCustomAsciiMathSymbols - blank lines and rows missing either column
// are dropped, same as the backend's parse_custom_symbols_rows.
export function parseCustomSymbolsCsv(content) {
  const rows = [];
  for (const line of (content || "").replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const fields = splitCsvLine(line);
    if (fields.length < 2) continue;
    const token = fields[0].trim();
    const latex = fields[1].trim();
    if (token && latex) rows.push([token, latex]);
  }
  return rows;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let injectedKatex = null;

/**
 * Supplies the KaTeX instance used to render LaTeX spans. Optional: without
 * it, `globalThis.katex` is used, which is what a <script> tag from a CDN
 * leaves behind. Resolved per call rather than once at import time, so a
 * KaTeX that loads after this module does still gets picked up.
 *
 * @param {{ renderToString: (tex: string, options?: object) => string }} katex
 */
export function setKatex(katex) {
  injectedKatex = katex;
}

function renderLatex(source, displayMode) {
  try {
    const katex = injectedKatex || globalThis.katex;
    return katex.renderToString(source, { throwOnError: false, displayMode });
  } catch (err) {
    return `<span class="math-error">${escapeHtml(source)}</span>`;
  }
}

function renderAsciiMath(source, displayMode) {
  try {
    let tex = asciiMath.toTex(source, { display: displayMode });
    // asciimath-parser always wraps multi-row output in LaTeX's `aligned`
    // environment (SPEC.md 2.2). `aligned` is amsmath's *alignment*
    // environment: a row with no `&` in it becomes one implicit
    // right-aligned column, so several unrelated equations just stacked
    // with blank lines (no `&` anywhere) come out right-justified to a
    // shared edge instead of each centered on its own - which reads as
    // ragged/off-center, not "centered", even though the block as a whole
    // is centered on the page. Swap to `gathered` (the same environment
    // already used for the LaTeX dialect's own multi-row stacking below)
    // whenever the source has no `&` to align on anywhere - `gathered`
    // centers each row independently, matching what plain stacked
    // equations should look like.
    if (!source.includes("&") && tex.includes("\\begin{aligned}")) {
      tex = tex.replace(/\\begin\{aligned\}/g, "\\begin{gathered}").replace(/\\end\{aligned\}/g, "\\end{gathered}");
    }
    return renderLatex(tex, displayMode);
  } catch (err) {
    return `<span class="math-error">${escapeHtml(source)}</span>`;
  }
}

// "asciimath" and "hybrid" both mean $...$/$$...$$ is AsciiMath2 - they
// only differ in what \(...\)/\[...\] mean going *into* a document (see
// latex_to_asciimath.py's `hybrid` param), which doesn't affect rendering
// at all here: \(...\)/\[...\] are already always LaTeX regardless of
// dialect (see the DIRECTIVE_RE doc-comment above), in every dialect.
function isAsciiMathDialect(dialect) {
  return dialect === "asciimath" || dialect === "hybrid";
}

// Renders a bare $...$ / $$...$$ span according to the document's math directive.
function renderDollarMath(source, displayMode, dialect) {
  return isAsciiMathDialect(dialect) ? renderAsciiMath(source, displayMode) : renderLatex(source, displayMode);
}

// Renders a block of (possibly multi-line) math source.
//
// AsciiMath2 rows are separated on output, with `&` as a literal in-row
// alignment marker that `asciimath-parser` turns into a proper
// `\begin{aligned}` (see asciimath2/SPEC.md section 2.2). SPEC.md documents
// a `singleNewlineBreak` render config that would make the *parser* treat a
// lone newline as a row break - but that config comes from the user's own
// unmerged widcardw/asciimath-parser PR #22, and the published package
// (currently 0.6.11) doesn't have it yet: only an actual blank line between
// rows is recognized. LLM output (and most people) reliably use one row per
// physical line but don't reliably add the blank line, so relying on the
// parser's native behavior silently ran different rows together with no
// line break at all. Every non-blank physical line is therefore treated as
// its own row here - joined with a blank line before being handed to the
// parser in one call, so its `&`-alignment handling (§2.2) still applies -
// regardless of whether the source itself used blank lines between rows.
//
// LaTeX has no such convention, and unlike AsciiMath2 a line break inside a
// LaTeX block is already meaningful (or already not) exactly as the source
// wrote it: a `\\` row inside its own `\begin{cases}`/`\begin{align}`, or
// one expression simply split across lines for readability with no line
// break intended at all. KaTeX itself already treats a bare newline as
// plain whitespace, so passing the block through untouched - not split
// into per-line "rows" and re-wrapped in a `gathered` environment the way
// AsciiMath2 needs - is what actually respects that syntax; wrapping it
// instead forced every line break into its own row and could nest a
// `gathered` around an environment the source already had of its own.
function renderMathBlock(source, dialect) {
  if (isAsciiMathDialect(dialect)) {
    const rows = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (rows.length === 0) return "";
    return renderAsciiMath(rows.join("\n\n"), true);
  }

  const trimmed = source.trim();
  return trimmed ? renderLatex(trimmed, true) : "";
}

// Scans forward from `lines[start]` for a line matching `closeRe`,
// collecting the lines in between. By default gives up (returns null) at
// the first blank line, without consuming it or anything past it.
//
// An opening marker with no matching close before its paragraph ends is
// almost always a malformed/typo'd delimiter in the source (e.g. a stray
// "$[" that was probably meant to be "\[" or "$$", several lines above a
// stray "$$" left over from what it actually meant to close) - not a
// genuine block that happens to be very long. Scanning all the way to
// end-of-document looking for that unrelated later "$$"/"\]" swallows
// everything in between into one broken block instead of leaving the
// single malformed line as the only casualty.
//
// `allowBlankLines` opts out of that guard for the two delimiters that
// can't plausibly be a typo of something else ("$$" and "\[" are each
// their own unambiguous open/close pair) - there a blank line is just a
// blank line inside a multi-equation block, or the still-empty line a
// cursor sits on while typing a new one, not evidence of a stray marker.
// The ambiguous "$[" opener (closed by either "$$" or "\]", so a genuine
// typo is far more likely) keeps the strict default.
function scanMultilineBlock(lines, start, closeRe, { allowBlankLines = false } = {}) {
  const mathLines = [];
  let j = start;
  while (j < lines.length) {
    if (!allowBlankLines && lines[j].trim() === "") return null;
    const closeMatch = lines[j].match(closeRe);
    if (closeMatch) {
      mathLines.push(closeMatch[1]);
      return { nextIndex: j + 1, mathLines };
    }
    mathLines.push(lines[j]);
    j++;
  }
  return null;
}

const DIRECTIVE_RE = /^<!--\s*math:\s*(latex|asciimath|hybrid)\s*-->\s*$/i;

// Scans the whole document for a `<!-- math: asciimath|latex -->` directive
// (last one wins) and strips those lines out. Everything else about parsing
// stays line-based, so this just pre-filters the line array. `fallbackDialect`
// is used when the document itself has no directive of its own (e.g. a
// session's math dialect inherited from its system prompt document).
function extractMathDirective(lines, fallbackDialect) {
  let dialect = fallbackDialect;
  const kept = [];
  for (const line of lines) {
    const match = line.match(DIRECTIVE_RE);
    if (match) {
      dialect = match[1].toLowerCase();
    } else {
      kept.push(line);
    }
  }
  return { dialect, lines: kept };
}

// Looks for a `<!-- math: asciimath|latex -->` directive in a document
// without rendering it, for callers that need to know one document's math
// dialect so they can apply it as the fallback for another (e.g. inheriting
// the session's system prompt directive into its other documents' previews).
// Returns null if the document has no directive of its own.
export function detectMathDirective(source) {
  const lines = (source || "").replace(/\r\n/g, "\n").split("\n");
  let found = null;
  for (const line of lines) {
    const match = line.match(DIRECTIVE_RE);
    if (match) found = match[1].toLowerCase();
  }
  return found;
}

// A document's own declared title, if it has one, favored over its raw
// filename the same way a webpage's <title> usually beats its URL slug -
// but only when that heading is the document's very first *content* line:
// something the user actually titled the document with, not just the first
// "# " to show up anywhere (a conversation log's assistant reply can
// easily contain one mid-document - e.g. explaining a dotfile under its
// own "# ~/.zprofile" heading - which isn't the document's title at all).
// Leading blank lines and a leading `<!-- math: ... -->` directive (see
// DIRECTIVE_RE) don't count as "content" and are skipped over first - a
// document commonly opens with its math directive, then a blank line,
// then its actual heading, and none of that should hide the heading from
// this the way scanning past *any* other line would. Only a level-1 ATX
// heading ("# ", not "##"+) counts, and CommonMark requires that space
// after the #. Useful for a document title (a browser tab, a link label,
// the tree's "copy link" button's link label) and public.js (the
// published page's tab title) - all three want the same "this document's
// own title, if it declares one" text.
export function firstH1Heading(content) {
  const lines = (content || "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || DIRECTIVE_RE.test(lines[i]))) i++;
  const match = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[i] || "");
  return match ? match[1].trim() : null;
}

// Converts a whole document's $...$ / $$...$$ math spans from AsciiMath2 to
// LaTeX and switches its directive to `<!-- math: latex -->` - the reverse
// of the asciimath2 package's convert_document_to_asciimath.
// Done client-side (no backend round-trip needed) by reusing the same
// asciimath-parser instance already loaded above for rendering. \(...\) and
// \[...\] spans are already-LaTeX by definition (see the module doc-comment)
// and are left untouched; fenced code blocks are passed through unchanged,
// same as the backend converter. Any pre-existing directive is stripped
// first so the new one isn't shadowed by a stale one further down the
// document (see markdown.js's own DIRECTIVE_RE "last one wins" scan).
function convertAsciiMathBlock(source) {
  const normalized = source
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  if (!normalized) return "";
  try {
    return asciiMath.toTex(normalized, { display: true });
  } catch (err) {
    return normalized;
  }
}

function convertAsciiMathInline(source) {
  try {
    return asciiMath.toTex(source, { display: false });
  } catch (err) {
    return source;
  }
}

export function convertAsciiMathToLatex(source) {
  const rawLines = (source || "").replace(/\r\n/g, "\n").split("\n");
  const lines = rawLines.filter((line) => !DIRECTIVE_RE.test(line));
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fenceMatch = line.match(/^```/);
    if (fenceMatch) {
      out.push(line);
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        out.push(lines[i]);
        i++;
      }
      continue;
    }

    const oneLineDisplay = line.match(/^\s*\$\$(.+)\$\$\s*$/);
    if (oneLineDisplay) {
      out.push(`$$\n${convertAsciiMathBlock(oneLineDisplay[1])}\n$$`);
      i++;
      continue;
    }

    const dollarOpen = line.match(/^\s*\$\$(.*)$/);
    if (dollarOpen) {
      const scanned = scanMultilineBlock(lines, i + 1, /^(.*)\$\$\s*$/, { allowBlankLines: true });
      if (scanned) {
        const block = [dollarOpen[1], ...scanned.mathLines].join("\n");
        out.push(`$$\n${convertAsciiMathBlock(block)}\n$$`);
        i = scanned.nextIndex;
        continue;
      }
      // No closing "$$" before the paragraph ends - not a real block; fall
      // through and process this line as ordinary text instead.
    }

    out.push(line.replace(/\$([^$\n]+)\$/g, (_, src) => `$${convertAsciiMathInline(src.trim())}$`));
    i++;
  }

  return `<!-- math: latex -->\n${out.join("\n")}`;
}

// Pulls $...$ and \(...\) spans out of raw text before HTML-escaping (math
// source may contain <, >, & which must reach KaTeX unescaped), rendering
// each to KaTeX HTML and leaving a placeholder token in its place. \(...\)
// is always LaTeX; $...$ follows the document's math directive.
function extractMathSpans(text, dialect) {
  const spans = [];
  const replaced = text.replace(/\\\(([^\n]+?)\\\)|\$([^$\n]+)\$/g, (_, latexSrc, dollarSrc) => {
    const token = `${spans.length}`;
    if (latexSrc !== undefined) {
      spans.push(renderLatex(latexSrc.trim(), false));
    } else {
      spans.push(renderDollarMath(dollarSrc.trim(), false, dialect));
    }
    return token;
  });
  return { replaced, spans };
}

function renderInline(text, dialect) {
  const { replaced, spans } = extractMathSpans(text, dialect);
  let out = escapeHtml(replaced);

  // Markup produced below is parked behind a placeholder the moment it's
  // built, so the emphasis passes at the end can't reach inside it. Without
  // this, two links on one line turn their own `target="_blank"` attributes
  // into a matched pair of italic underscores - `target="<em>blank"` and
  // `target="</em>blank"` - and a URL containing `_` or `*` gets chewed up
  // the same way. Only the *tags* are parked, not a link's label, since
  // `[**bold**](url)` should still come out bold.
  const tags = [];
  const park = (html) => `${tags.push(html) - 1}`;

  // inline code - parked whole: `a_b_c` is code, not an emphasis site.
  out = out.replace(/`([^`]+)`/g, (_, code) => park(`<code>${code}</code>`));
  // images ![alt](url)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {
    return park(`<img alt="${alt}" src="${url}">`);
  });
  // wikilinks [[target]] / [[target|label]] - not CommonMark, a popular
  // convention for referencing another document by relative path instead
  // (Obsidian, GitHub wikis, ...). `target` is either a bare filename (the
  // document currently being rendered's own folder) or "<folder>/filename"
  // (a folder elsewhere in the same collection) - the exact same two shapes
  // a plain [text](url) link's url can already point at, which is what this
  // expands into: same rendering, same click handling, just shorter to type
  // and with ".md" appended automatically so "[[0002]]" and "[[0002.md]]"
  // land on the same file. Runs before the [text](url)
  // regex below so its own brackets can never be mistaken for one.
  out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
    const trimmedTarget = target.trim();
    const href = /\.md$/i.test(trimmedTarget) ? trimmedTarget : `${trimmedTarget}.md`;
    const display = (label !== undefined ? label : trimmedTarget).trim();
    return park(`<a href="${href}" target="_blank" rel="noopener noreferrer">`) + display + park("</a>");
  });
  // links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
    return park(`<a href="${url}" target="_blank" rel="noopener noreferrer">`) + label + park("</a>");
  });
  // bare URLs (not written as a [text](url) link at all - just typed
  // plainly), autolinked the same way. The lookbehind-by-hand guard
  // (excluded leading chars) is what keeps this from re-linking a URL a
  // second time where one of the forms above already consumed it: `="`
  // covers an href/src attribute value (the links/images/wikilinks steps
  // above), and `>` covers a URL sitting right after some other tag's own
  // opening bracket - which in practice means either straight inside an
  // `<a href="...">url</a>` this same step or one of the steps above just
  // produced (a link whose label happens to be a bare URL, e.g.
  // `[https://a](https://b)`), or inside `<code>url</code>` (deliberately
  // left as literal code, not linked). Trailing punctuation that reads as
  // sentence punctuation rather than URL content (a closing paren from
  // "(see https://x.com)", a sentence's own trailing period, ...) is
  // peeled off the link and put back outside it.
  out = out.replace(/(^|[^"'=>])(https?:\/\/[^\s<>"']+)/g, (_, pre, rawUrl) => {
    const trailing = rawUrl.match(/[).,;:!?\]}'"]+$/);
    const url = trailing ? rawUrl.slice(0, -trailing[0].length) : rawUrl;
    if (!url) return pre + rawUrl;
    // Parked whole, label included: the label *is* the URL here, and a URL
    // is never something to find emphasis markers in.
    return pre + park(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + (trailing ? trailing[0] : "");
  });
  // ~~strikethrough~~ and ==highlight== (the Markdown Guide's extended
  // syntax). A highlight's markers have to hug their text, so an equality
  // written out in prose ("a == b") is never mistaken for one.
  out = out.replace(/~~(?=\S)([^~\n]*?\S)~~/g, "<del>$1</del>");
  out = out.replace(/==(?=\S)([^=\n]*?\S)==/g, "<mark>$1</mark>");
  // bold
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // italic
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1<em>$2</em>");

  // put the generated tags back now that nothing else will rewrite them
  out = out.replace(/(\d+)/g, (_, index) => tags[Number(index)]);
  // swap in the pre-rendered KaTeX HTML for each math placeholder
  out = out.replace(/(\d+)/g, (_, index) => spans[Number(index)]);

  return out;
}

// GFM-style pipe tables:
//   | a | b |
//   |---|--:|
//   | 1 | 2 |
// Splits one row's raw line into its cell strings. A leading/trailing "|"
// (the row's own boundary markers, not a real empty cell) is stripped
// first; the rest is split on "|" that isn't escaped (`\|`) or inside a
// backtick code span or a `\(...\)`/`\[...\]` LaTeX span - both can
// legitimately contain a literal "|" (e.g. an absolute-value bar in a
// table cell), and splitting inside them would corrupt the math instead of
// the column count.
function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);

  const cells = [];
  let current = "";
  let inCode = false;
  let mathDepth = 0;
  let inDollar = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    const two = trimmed.slice(i, i + 2);
    if (!inDollar && mathDepth === 0 && ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (!inCode && !inDollar && (two === "\\(" || two === "\\[")) {
      mathDepth++;
      current += two;
      i++;
      continue;
    }
    if (!inCode && mathDepth > 0 && (two === "\\)" || two === "\\]")) {
      mathDepth--;
      current += two;
      i++;
      continue;
    }
    if (!inCode && mathDepth === 0 && ch === "$") {
      inDollar = !inDollar;
      current += ch;
      continue;
    }
    if (!inCode && !inDollar && mathDepth === 0 && ch === "|") {
      if (current.endsWith("\\")) {
        current = current.slice(0, -1) + "|";
        continue;
      }
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

const TABLE_DELIMITER_CELL_RE = /^:?-+:?$/;

function tableRowAlignments(delimiterCells) {
  return delimiterCells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

function renderTableRowHtml(cells, aligns, tag, dialect) {
  const tds = cells
    .map((cell, idx) => {
      const align = aligns[idx];
      const style = align ? ` style="text-align:${align}"` : "";
      return `<${tag}${style}>${renderInline(cell, dialect)}</${tag}>`;
    })
    .join("");
  return `<tr>${tds}</tr>`;
}

export function renderMarkdown(source, fallbackDialect = "latex") {
  const rawLines = (source || "").replace(/\r\n/g, "\n").split("\n");
  const { dialect, lines } = extractMathDirective(rawLines, fallbackDialect);
  const html = [];

  let i = 0;
  let paragraph = [];
  // One entry per currently-open nesting level, outermost first - not just
  // a single `{type}`, since a level's `<li>` is deliberately left
  // unclosed (see the list-item handling below) until either a sibling
  // item at the same indent closes it, a deeper item nests a new list
  // inside it, or closeList() closes everything at once (blank line,
  // heading, end of document, ...). That's what makes actual nested
  // `<ul>`/`<ol>` output possible from a flat array of pushed strings.
  let listStack = [];
  let inQuote = false;

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${renderInline(paragraph.join(" "), dialect)}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    while (listStack.length) {
      const level = listStack.pop();
      html.push("</li>");
      html.push(level.type === "ul" ? "</ul>" : "</ol>");
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      html.push("</blockquote>");
      inQuote = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block (also used for ```asciimath / ```math / ```latex)
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      flushParagraph();
      closeList();
      closeQuote();
      const lang = fenceMatch[1];
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const body = codeLines.join("\n");
      if (lang === "asciimath" || lang === "am") {
        html.push(`<div class="math-display">${renderMathBlock(body, "asciimath")}</div>`);
      } else if (lang === "math" || lang === "latex" || lang === "tex") {
        html.push(`<div class="math-display">${renderMathBlock(body, "latex")}</div>`);
      } else {
        const cls = lang ? ` class="language-${lang}"` : "";
        html.push(`<pre><code${cls}>${escapeHtml(body)}</code></pre>`);
      }
      continue;
    }

    // block math: a single "$$ ... $$" line, or a $$ ... $$ fenced span
    // (interpreted as LaTeX or AsciiMath per the document's math directive).
    // Opening markers tolerate leading indentation - LLMs commonly indent a
    // block formula that continues a numbered/bulleted list item - but the
    // indentation isn't captured, since block math always breaks out of the
    // surrounding list/paragraph flow anyway (see the closeList() calls
    // right below), so there's nothing meaningful to preserve it for.
    const oneLineDisplayMath = line.match(/^\s*\$\$(.+)\$\$\s*$/);
    if (oneLineDisplayMath) {
      flushParagraph();
      closeList();
      closeQuote();
      html.push(`<div class="math-display">${renderMathBlock(oneLineDisplayMath[1], dialect)}</div>`);
      i++;
      continue;
    }
    // Multi-line $$ ... $$: the markers don't need to be alone on their own
    // line - LLMs often write "$$f(x)=\n...\n=g(x)$$" with content attached
    // right after the opening marker or right before the closing one.
    const dollarOpen = line.match(/^\s*\$\$(.*)$/);
    if (dollarOpen) {
      const scanned = scanMultilineBlock(lines, i + 1, /^(.*)\$\$\s*$/, { allowBlankLines: true });
      if (scanned) {
        flushParagraph();
        closeList();
        closeQuote();
        const mathLines = [dollarOpen[1], ...scanned.mathLines];
        html.push(`<div class="math-display">${renderMathBlock(mathLines.join("\n"), dialect)}</div>`);
        i = scanned.nextIndex;
        continue;
      }
      // No closing "$$" before the paragraph ends - not a real block; fall
      // through and process this line as ordinary text instead.
    }

    // "$[" is a real, recurring LLM typo for either "\[" or "$$". Recognized
    // as an opener, closed by *either* "$$" or "\]" (whichever the model
    // actually typed - its choice of closer is exactly as unreliable as its
    // choice of opener was). The asciimath2 package's own converter is
    // lenient about this in the same way, so documents it produced may
    // contain the pattern.
    const oneLineDollarBracket = line.match(/^\s*\$\[(.+?)(?:\$\$|\\\])\s*$/);
    if (oneLineDollarBracket) {
      flushParagraph();
      closeList();
      closeQuote();
      html.push(`<div class="math-display">${renderMathBlock(oneLineDollarBracket[1], dialect)}</div>`);
      i++;
      continue;
    }
    const dollarBracketOpen = line.match(/^\s*\$\[(.*)$/);
    if (dollarBracketOpen) {
      const scanned = scanMultilineBlock(lines, i + 1, /^(.*)(?:\$\$|\\\])\s*$/);
      if (scanned) {
        flushParagraph();
        closeList();
        closeQuote();
        const mathLines = [dollarBracketOpen[1], ...scanned.mathLines];
        html.push(`<div class="math-display">${renderMathBlock(mathLines.join("\n"), dialect)}</div>`);
        i = scanned.nextIndex;
        continue;
      }
      // No closing "$$"/"\]" before the paragraph ends either - genuinely
      // not recoverable; fall through and process as ordinary text.
    }

    // block math: a single "\[ ... \]" line, or a \[ ... \] span across
    // multiple lines (same "markers needn't be alone on their line" relief
    // as $$ above). Always LaTeX (native LaTeX notation, ignores directive).
    const oneLineBracketMath = line.match(/^\s*\\\[(.+)\\\]\s*$/);
    if (oneLineBracketMath) {
      flushParagraph();
      closeList();
      closeQuote();
      html.push(`<div class="math-display">${renderMathBlock(oneLineBracketMath[1], "latex")}</div>`);
      i++;
      continue;
    }
    const bracketOpen = line.match(/^\s*\\\[(.*)$/);
    if (bracketOpen) {
      const scanned = scanMultilineBlock(lines, i + 1, /^(.*)\\\]\s*$/, { allowBlankLines: true });
      if (scanned) {
        flushParagraph();
        closeList();
        closeQuote();
        const mathLines = [bracketOpen[1], ...scanned.mathLines];
        html.push(`<div class="math-display">${renderMathBlock(mathLines.join("\n"), "latex")}</div>`);
        i = scanned.nextIndex;
        continue;
      }
      // No closing "\]" before the paragraph ends - not a real block; fall
      // through and process this line as ordinary text instead.
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      // A blank line alone doesn't end a list - a "loose" list (blank lines
      // between items, as most LLM output uses) is still one list, not one
      // per item. Deliberately not closeList() here: whatever comes after
      // decides for real - another item at this level continues it (see the
      // sibling case below), an indented line continues the current item's
      // own content, and anything else closes it via its own closeList()
      // call before it does anything else.
      closeQuote();
      i++;
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      flushParagraph();
      closeList();
      closeQuote();
      const level = line.match(/^#+/)[0].length;
      const text = line.replace(/^#{1,6}\s/, "");
      html.push(`<h${level}>${renderInline(text, dialect)}</h${level}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      closeList();
      closeQuote();
      html.push("<hr>");
      i++;
      continue;
    }

    // GFM pipe table: a header row followed immediately by a delimiter row
    // (only "-"/":" cells, same column count as the header) starts one;
    // every subsequent non-blank line containing "|" is a body row.
    if (line.includes("|") && i + 1 < lines.length) {
      const headerCells = splitTableRow(line);
      const delimiterCells = splitTableRow(lines[i + 1]);
      const isDelimiterRow =
        delimiterCells.length === headerCells.length &&
        delimiterCells.every((cell) => TABLE_DELIMITER_CELL_RE.test(cell));
      if (isDelimiterRow) {
        flushParagraph();
        closeList();
        closeQuote();
        const aligns = tableRowAlignments(delimiterCells);
        const bodyRows = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim() !== "" && lines[j].includes("|")) {
          bodyRows.push(splitTableRow(lines[j]));
          j++;
        }
        const thead = renderTableRowHtml(headerCells, aligns, "th", dialect);
        const tbody = bodyRows.map((cells) => renderTableRowHtml(cells, aligns, "td", dialect)).join("");
        html.push(`<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
        i = j;
        continue;
      }
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      closeList();
      if (!inQuote) {
        html.push("<blockquote>");
        inQuote = true;
      }
      html.push(`<p>${renderInline(line.replace(/^>\s?/, ""), dialect)}</p>`);
      i++;
      continue;
    }
    closeQuote();

    // Leading whitespace is captured (not just consumed by `\s*`) so nesting
    // depth can be read off it below - any increase in indentation over the
    // enclosing item, by even one space, opens one deeper level. This is
    // deliberately more tolerant than requiring exactly 2/4-space steps:
    // hand-typed and LLM-generated markdown indent inconsistently (a single
    // leading space is common), and a flat, unindented-looking list is a far
    // more confusing failure mode than a nested one from generous matching.
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (ulMatch || olMatch) {
      flushParagraph();
      const [, indentStr, itemText] = ulMatch || olMatch;
      const indent = indentStr.length;
      const wantType = ulMatch ? "ul" : "ol";

      // Close every level at least as deep as this line, except a level at
      // exactly the same indent AND the same list type - that one is this
      // line's own enclosing list, continued as a sibling, not closed.
      while (
        listStack.length &&
        (listStack[listStack.length - 1].indent > indent ||
          (listStack[listStack.length - 1].indent === indent && listStack[listStack.length - 1].type !== wantType))
      ) {
        const level = listStack.pop();
        html.push("</li>");
        html.push(level.type === "ul" ? "</ul>" : "</ol>");
      }

      if (listStack.length && listStack[listStack.length - 1].indent === indent) {
        // A sibling item continuing the level found above - close its
        // predecessor's <li> (left open for exactly this) before opening
        // this one.
        html.push("</li>");
      } else {
        // Either the first list line in the document, or nesting one level
        // deeper inside the still-open <li> of the level right below it.
        html.push(wantType === "ul" ? "<ul>" : "<ol>");
        listStack.push({ indent, type: wantType });
      }
      // Left open (no `</li>` yet) - closed by whichever of the three cases
      // above applies once the next line is known. A task item ("- [ ] do",
      // "- [x] done") gets a read-only checkbox in place of its marker; the
      // classes match GitHub's, so existing task-list CSS applies as-is.
      const task = itemText.match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) {
        const checked = task[1] !== " " ? " checked" : "";
        html.push(
          `<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled${checked}> ${renderInline(task[2], dialect)}`
        );
      } else {
        html.push(`<li>${renderInline(itemText, dialect)}`);
      }
      i++;
      continue;
    }

    // An indented line while a list is open is lazy continuation text for
    // the innermost open item - very common LLM output shape (marker line,
    // then an indented explanatory line or two, often after a trailing
    // double-space/<br>). Appended straight into that item's still-open
    // `<li>` (see above) rather than closing the list, which would otherwise
    // end it after its very first item and start a fresh, independently-
    // numbered `<ol>` for every later one (all showing "1." - numbering is
    // per-`<ol>`, not carried across separate lists).
    if (listStack.length && /^\s+\S/.test(line)) {
      html.push(" " + renderInline(line.trim(), dialect));
      i++;
      continue;
    }
    closeList();

    paragraph.push(line.trim());
    i++;
  }

  flushParagraph();
  closeList();
  closeQuote();

  return html.join("\n");
}
