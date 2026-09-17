import assert from "node:assert/strict";
import test from "node:test";

import {
  renderMarkdown,
  detectMathDirective,
  firstH1Heading,
  parseCustomSymbolsCsv,
  setKatex,
} from "../src/index.js";

// Stands in for KaTeX so the LaTeX path can be tested without pulling the
// real thing in: it records what it was handed rather than rendering it,
// which is what these tests actually care about (which dialect a span was
// routed to, and with which display mode).
const katexCalls = [];
setKatex({
  renderToString(tex, options) {
    katexCalls.push({ tex, displayMode: !!options?.displayMode });
    return `<katex display="${!!options?.displayMode}">${tex}</katex>`;
  },
});

test("renders ordinary Markdown structure", () => {
  const html = renderMarkdown("# Title\n\nSome *emphasis* and `code`.");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<em>emphasis<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test("escapes HTML before any markup is applied", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(!html.includes("<img"), "raw HTML must not survive into the output");
  assert.match(html, /&lt;img/);
});

test("nests lists by indentation", () => {
  const html = renderMarkdown("- a\n  - b\n- c");
  assert.match(html, /<ul>[\s\S]*<ul>[\s\S]*<\/ul>[\s\S]*<\/ul>/);
});

test("renders tables with alignment", () => {
  const html = renderMarkdown("| a | b |\n| :-- | --: |\n| 1 | 2 |");
  assert.match(html, /<table>/);
  assert.match(html, /text-align:right/);
});

test("expands wikilinks, appending .md when missing", () => {
  const html = renderMarkdown("see [[0002]] and [[notes.md|my notes]]");
  assert.match(html, /<a href="0002\.md"[^>]*>0002<\/a>/);
  assert.match(html, /<a href="notes\.md"[^>]*>my notes<\/a>/);
});

test("$...$ is LaTeX by default", () => {
  katexCalls.length = 0;
  renderMarkdown("inline $x^2$ here");
  assert.equal(katexCalls.length, 1);
  assert.equal(katexCalls[0].tex, "x^2");
  assert.equal(katexCalls[0].displayMode, false);
});

test("the math directive switches $...$ to AsciiMath2", () => {
  katexCalls.length = 0;
  const html = renderMarkdown("<!-- math: asciimath -->\n\ninline $sqrt(x)$ here");
  // AsciiMath2 goes through asciimath-parser first, so what reaches KaTeX is
  // the LaTeX it produced - not the source that was typed.
  assert.equal(katexCalls.length, 1);
  assert.notEqual(katexCalls[0].tex, "sqrt(x)");
  assert.match(katexCalls[0].tex, /\\sqrt/);
  assert.match(html, /<katex/);
});

test(String.raw`\(...\) stays LaTeX even under the asciimath directive`, () => {
  katexCalls.length = 0;
  renderMarkdown(String.raw`<!-- math: asciimath -->` + "\n\n" + String.raw`inline \(x^2\) here`);
  assert.equal(katexCalls[0].tex, "x^2");
});

test("$$...$$ renders in display mode", () => {
  katexCalls.length = 0;
  renderMarkdown("$$x^2$$");
  assert.equal(katexCalls[0].displayMode, true);
});

test("fenced code is left alone", () => {
  const html = renderMarkdown("```\n$x^2$\n```");
  assert.match(html, /<pre><code>\$x\^2\$<\/code><\/pre>/);
});

// Regression: the emphasis passes used to run over the generated markup, so
// the `target="_blank"` of two links on one line read as a matched pair of
// italic underscores and both attributes were rewritten.
test("two links on one line keep their attributes intact", () => {
  const html = renderMarkdown("[one](a.md) and [two](b.md)");
  assert.equal((html.match(/target="_blank"/g) || []).length, 2);
  assert.ok(!html.includes("<em>"), `emphasis leaked into markup: ${html}`);
});

test("underscores and asterisks inside a URL survive", () => {
  const html = renderMarkdown("see https://example.com/a_b_c and https://example.com/d_e_f");
  assert.match(html, /href="https:\/\/example\.com\/a_b_c"/);
  assert.match(html, /href="https:\/\/example\.com\/d_e_f"/);
  assert.ok(!html.includes("<em>"), `emphasis leaked into URLs: ${html}`);
});

test("inline code is not an emphasis site", () => {
  const html = renderMarkdown("`a_b_c` and `d_e_f`");
  assert.match(html, /<code>a_b_c<\/code>/);
  assert.ok(!html.includes("<em>"), `emphasis leaked into code: ${html}`);
});

test("a link label still gets emphasis", () => {
  const html = renderMarkdown("[**bold**](a.md)");
  assert.match(html, /<a href="a\.md"[^>]*><strong>bold<\/strong><\/a>/);
});

test("detectMathDirective reports the last directive, or null", () => {
  assert.equal(detectMathDirective("<!-- math: hybrid -->\n# hi"), "hybrid");
  assert.equal(detectMathDirective("<!-- math: latex -->\n<!-- math: asciimath -->"), "asciimath");
  assert.equal(detectMathDirective("# no directive"), null);
});

test("firstH1Heading only counts the first content line", () => {
  assert.equal(firstH1Heading("# Title\n\ntext"), "Title");
  assert.equal(firstH1Heading("<!-- math: hybrid -->\n\n# Title"), "Title");
  assert.equal(firstH1Heading("text first\n\n# Not the title"), null);
  assert.equal(firstH1Heading("## Subheading"), null);
});

test("parseCustomSymbolsCsv drops blank and incomplete rows", () => {
  const rows = parseCustomSymbolsCsv('span, \\operatorname{span}\n\nbroken\n"q,uoted", \\text{x}\n');
  assert.deepEqual(rows, [
    ["span", "\\operatorname{span}"],
    ["q,uoted", "\\text{x}"],
  ]);
});

test("a missing KaTeX degrades to a math-error span, not a throw", () => {
  setKatex(null);
  const html = renderMarkdown("inline $x^2$ here");
  assert.match(html, /<span class="math-error">x\^2<\/span>/);
  setKatex({ renderToString: (tex) => `<katex>${tex}</katex>` });
});
