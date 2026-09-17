# asciimath-markdown

A dependency-light Markdown renderer for documents whose math isn't always
LaTeX. `$...$` can mean **LaTeX** or **[AsciiMath2](https://github.com/iasandcb/asciimath2)**,
and which one it means is a property of the document itself:

```markdown
<!-- math: asciimath -->

The identity $sum_(i=1)^n i = (n(n+1))/2$ holds for all $n >= 1$.
```

```markdown
<!-- math: latex -->

The identity $\sum_{i=1}^n i = \frac{n(n+1)}{2}$ holds for all $n \ge 1$.
```

Both render the same thing. Nothing else in the document changes — which is
the point: AsciiMath is far easier to *type* and to read as source, LaTeX is
what everything else understands, and a document can move between them
without being rewritten.

## Install

```bash
npm install asciimath-markdown
```

KaTeX is an optional peer dependency — install it (or load it from a CDN) if
you want math actually rendered rather than marked as unrenderable.

## Use

```js
import { renderMarkdown, setKatex } from "asciimath-markdown";
import katex from "katex";

setKatex(katex); // optional if `globalThis.katex` is already set

document.querySelector("#out").innerHTML = renderMarkdown(source);
```

In a browser with no build step at all, load it and its dependencies straight
from a CDN — `/+esm` resolves the bare imports for you:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.18.4/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.18.4/dist/katex.min.js"></script>
<script type="module">
  import { renderMarkdown } from "https://cdn.jsdelivr.net/npm/asciimath-markdown@0.1/+esm";
  document.body.innerHTML = renderMarkdown("# hi $x^2$");
</script>
```

## The three dialects

| Directive | `$...$` and `$$...$$` mean | `\(...\)` and `\[...\]` mean |
| --- | --- | --- |
| `<!-- math: latex -->` (default) | LaTeX | LaTeX |
| `<!-- math: asciimath -->` | AsciiMath2 | LaTeX |
| `<!-- math: hybrid -->` | AsciiMath2 | LaTeX |

`\(...\)` and `\[...\]` are native LaTeX notation with no AsciiMath
equivalent, so they always mean LaTeX — as do fenced ` ```math ` blocks.
That's what makes `hybrid` usable: a document can be mostly AsciiMath and
still drop into raw LaTeX where it has to, with no escaping dance. The last
directive in the document wins; `detectMathDirective()` reports it.

## API

| Export | What it does |
| --- | --- |
| `renderMarkdown(source, fallbackDialect?)` | Markdown → HTML. `fallbackDialect` (`"latex"`, `"asciimath"`, `"hybrid"`) applies when the document declares none of its own. |
| `setKatex(katex)` | Supplies the KaTeX instance. Optional — `globalThis.katex` is used otherwise. |
| `detectMathDirective(source)` | The document's declared dialect, or `null`. |
| `firstH1Heading(source)` | The document's own title (a leading `# ...`), or `null`. Skips a leading directive and blank lines, and deliberately ignores any later heading. |
| `convertAsciiMathToLatex(source)` | Rewrites a whole document's AsciiMath2 math spans to LaTeX and switches its directive, leaving code fences and `\(...\)` alone. |
| `setCustomAsciiMathSymbols(rows)` | Adds `[token, latex]` pairs to the AsciiMath2 symbol table, e.g. `[["span", "\\operatorname{span}"]]`. |
| `parseCustomSymbolsCsv(text)` | Parses such pairs out of a two-column CSV. |

## What it renders

Headings, nested lists (by indentation), tables with alignment, block
quotes, fenced and inline code, images, links, bare URLs, `**bold**` /
`*italic*`, horizontal rules — and two things a plain Markdown renderer
doesn't:

- **Math**, as above: `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, and fenced
  ` ```math ` / ` ```asciimath ` blocks. Malformed math degrades to
  `<span class="math-error">` rather than throwing or swallowing the page.
- **Wikilinks**: `[[notes]]` and `[[notes.md|my notes]]`, resolving to
  `notes.md` either way.

**Every input is HTML-escaped before any markup is applied**, so raw HTML in
the source can never execute — which matters when the source is something a
language model just produced.

Not a CommonMark implementation and not trying to be: it covers what
technical notes actually use, in one dependency-free file you can read in an
afternoon.

## License

MIT
