// Spoken Korean math -> AsciiMath2: what a speech recognizer heard while
// someone read a formula aloud ("엑스 승 이 더하기 일") becomes the AsciiMath2
// this package renders ("x ^ 2 + 1"). Pure string work, no DOM.
//
// The vocabulary isn't built in: it's a CSV the caller loads with
// setSpokenMathVocabulary(parseSpokenMathCsv(text)). One rule per line,
// "word, symbol": the word is everything before the first comma and the
// symbol everything after it, so a symbol may itself be a comma ("과, ,").
// Special symbols:
//   \n          a line break inside the formula ("이고, \n")
//   $$          opens or closes a math block - such words are found in the
//               raw transcript by splitMathBlockCommands, before conversion
//   {1} / {2}   a template: the chunk said just before / after the word,
//               for words whose order differs from AsciiMath's
//               ("분의, {2} / {1}": 삼 분의 일 -> 1 / 3)
// Lines starting with "#" are comments; a later line wins over an earlier
// one for the same word. Spaces inside a word don't matter - matching
// ignores spaces between Korean syllables, since recognizers space Korean
// inconsistently ("라지 에이" and "라지에이" alike).

let vocabulary = new Map();
let longestWord = 0;

export function parseSpokenMathCsv(content) {
  const rules = new Map();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const comma = line.indexOf(",");
    if (comma === -1) continue;
    const word = line.slice(0, comma).replace(/\s+/g, "");
    // "\n" as a symbol is a line break inside the formula.
    const symbol = line.slice(comma + 1).trim().replace(/^\\n$/, "\n");
    if (word && symbol) rules.set(word, symbol);
  }
  return rules;
}

// Words whose symbol is "$$" aren't written as symbols: they open a math
// block where dictation is writing, or close the one it's in - what typing
// $$ there would do ("수식시작, $$" / "수식끝, $$"). Heard anywhere, not
// just inside a block, so they're split out of the raw transcript before
// anything else (see splitMathBlockCommands).
let blockCommand = null;

// Capitals are spoken with a prefix ("라지에프" -> F). A recognizer often
// writes a letter name as the letter itself, though - "에프" as "F", and
// just as often upper- as lowercase - so a lone Latin letter it wrote is
// read as lowercase, and as a capital only right after the prefix ("라지 F").
// The prefix isn't fixed here: it's whatever the vocabulary puts in front
// of a lowercase letter's word to get its capital (라지 + 에프 -> F).
let capitalPrefixes = [];

export function setSpokenMathVocabulary(rules) {
  vocabulary = rules;
  longestWord = Math.max(0, ...[...rules.keys()].map((word) => word.length));
  const words = [...rules].filter(([, symbol]) => symbol === "$$").map(([word]) => word);
  // Longest first, spaces allowed between syllables like everywhere else.
  blockCommand = words.length
    ? new RegExp(
        words
          .sort((a, b) => b.length - a.length)
          .map((word) => [...word].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"))
          .join("|"),
        "g"
      )
    : null;
  const prefixes = new Set();
  for (const [word, symbol] of rules) {
    if (!/^[A-Z]$/.test(symbol)) continue;
    for (const [lower, lowerSymbol] of rules) {
      if (lowerSymbol === symbol.toLowerCase() && word.length > lower.length && word.endsWith(lower)) {
        prefixes.add(word.slice(0, -lower.length));
      }
    }
  }
  capitalPrefixes = [...prefixes].sort((a, b) => b.length - a.length);
}

// "엑스 더하기 와이 수식끝 다음은" -> ["엑스 더하기 와이 ", "다음은"]: the
// text between block commands, each boundary being one command.
export function splitMathBlockCommands(text) {
  return blockCommand ? text.split(blockCommand) : [text];
}

// Where those commands are: [start, end] character offsets in `text`, for a
// caller that needs to line them up with something else (word timings).
export function findMathBlockCommands(text) {
  return blockCommand ? [...text.matchAll(blockCommand)].map((m) => [m.index, m.index + m[0].length]) : [];
}

const HANGUL = /[가-힣]/;

// Sentence punctuation a recognizer adds on its own ("엑스 더하기 와이.") -
// meaningless in a formula. A "." or "," between digits stays (3.14, 1,000).
function dropSentencePunctuation(text) {
  return text.replace(/[.,?!。、，]/g, (mark, offset) =>
    (mark === "." || mark === ",") && /\d/.test(text[offset - 1] || "") && /\d/.test(text[offset + 1] || "") ? mark : " "
  );
}

// Longest match first over a run of Korean syllables (spaces removed), so
// "라지에이" is A rather than "라지" + a, and "집합 열고" is "{" rather than Set (.
// A syllable no word starts with is kept as it was said (a particle, say).
function convertHangulRun(run, out) {
  let i = 0;
  let unknown = "";
  while (i < run.length) {
    let matched = null;
    for (let len = Math.min(longestWord, run.length - i); len > 0; len--) {
      const symbol = vocabulary.get(run.slice(i, i + len));
      if (symbol !== undefined) {
        matched = { symbol, len };
        break;
      }
    }
    if (!matched) {
      unknown += run[i];
      i += 1;
      continue;
    }
    if (unknown) out.push(unknown);
    unknown = "";
    out.push(matched.symbol);
    i += matched.len;
  }
  if (unknown) out.push(unknown);
}

// Words whose order differs from AsciiMath's are templates: in a symbol,
// {1} stands for the chunk said just before the word and {2} for the one
// just after - Korean reads a fraction denominator first ("삼 분의 일" with
// "분의, {2} / {1}" -> 1 / 3) and puts a bound's particle after it ("영 에서"
// with "에서, _ {1}" -> _ 0). A chunk is one token, or one bracket group as
// a whole ("열고 엑스 더하기 일 닫고"), together with any sub/superscripts
// on it ("엑스 승 삼": 삼 분의 엑스 승 삼 -> x ^ 3 / 3, not x / 3 ^ 3) and,
// for a function, its argument ("사인 엑스": 엑스 분의 사인 엑스 ->
// sin x / x); a
// template's result is a chunk in turn ("영 에서 삼 분의 일 까지" ->
// _ 0 ^ (1 / 3)). A chunk that wasn't said (yet) is left out.
const TEMPLATE = /\{[12]\}/;
const OPENER = /^(\(:?|\[|\{:?|[A-Za-z]+\()$/;
const CLOSER = /^(\)|\]|\}|:\)|:\})$/;
const SCRIPT = /^[_^]$/;
// AsciiMath's function names (f and g aside - as spoken variables they'd
// swallow whatever follows).
const FUNCTION = /^(a?(sin|cos|tan|sec|csc|cot)h?|arc(sin|cos|tan)|exp|log|ln|det|dim|gcd|lcm|min|max)$/;

// A chunk inside another template: a multi-token one is bracketed so it
// stays one piece (AsciiMath drops those brackets under _, ^ and /).
function asChunk(item) {
  return item.composite && item.text.includes(" ") ? `( ${item.text} )` : item.text;
}

// One token or bracket group off the end of `done`, or null if there is none.
function atomBefore(done) {
  const last = done[done.length - 1];
  if (!last || last.text === "\n" || TEMPLATE.test(last.text) || (!last.composite && SCRIPT.test(last.text))) return null;
  if (!CLOSER.test(last.text)) return asChunk(done.pop());
  let depth = 0;
  for (let i = done.length - 1; i >= 0; i--) {
    if (CLOSER.test(done[i].text)) depth += 1;
    else if (OPENER.test(done[i].text)) depth -= 1;
    if (depth === 0) return done.splice(i).map(asChunk).join(" ");
  }
  return asChunk(done.pop());
}

function chunkBefore(done) {
  let chunk = atomBefore(done);
  if (chunk === null) return "";
  // Take the base it's a sub/superscript of along: x ^ 2, x _ 1 ^ 2.
  while (done.length >= 2 && !done[done.length - 1].composite && SCRIPT.test(done[done.length - 1].text)) {
    const script = done.pop();
    const base = atomBefore(done);
    if (base === null) {
      done.push(script);
      break;
    }
    chunk = `${base} ${script.text} ${chunk}`;
  }
  // ... and the function it's the argument of: sin x, cos ^ 2 x, log _ 2 x.
  const plain = (k) => done[done.length - k] && !done[done.length - k].composite && done[done.length - k].text;
  for (const length of [5, 3, 1]) {
    const head = Array.from({ length }, (_, k) => plain(length - k));
    const scriptsOk = head.every((text, k) => (k % 2 === 1 ? SCRIPT.test(text || "") : k === 0 || (text && !TEMPLATE.test(text))));
    if (head.every(Boolean) && FUNCTION.test(head[0]) && scriptsOk) {
      done.splice(done.length - length);
      return `${head.join(" ")} ${chunk}`;
    }
  }
  return chunk;
}

// Whether `chunk` is already one bracket group from end to end.
function enclosed(chunk) {
  const tokens = chunk.split(" ");
  if (!OPENER.test(tokens[0]) || !CLOSER.test(tokens[tokens.length - 1])) return false;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (OPENER.test(tokens[i])) depth += 1;
    else if (CLOSER.test(tokens[i])) depth -= 1;
    if (depth === 0 && i < tokens.length - 1) return false;
  }
  return true;
}

// A chunk of several tokens goes into a template bracketed, so it stays one
// operand ("sin x" over x is (sin x) / x, not sin (x / x)); AsciiMath drops
// those brackets under /, _ and ^, so they don't show.
function operand(chunk) {
  return chunk.includes(" ") && !enclosed(chunk) ? `( ${chunk} )` : chunk;
}

// One token or bracket group starting at tokens[at]: [text, index after],
// or null if there is none.
function atomAfter(tokens, at) {
  const first = tokens[at];
  if (first === undefined || first === "\n" || TEMPLATE.test(first) || SCRIPT.test(first)) return null;
  if (!OPENER.test(first)) return [first, at + 1];
  let depth = 0;
  for (let i = at; i < tokens.length; i++) {
    if (OPENER.test(tokens[i])) depth += 1;
    else if (CLOSER.test(tokens[i])) depth -= 1;
    if (depth === 0) return [resolveTemplates(tokens.slice(at, i + 1)), i + 1];
  }
  return [resolveTemplates(tokens.slice(at)), tokens.length];
}

// Returns [chunk, index after it] - with any sub/superscripts on it.
function chunkAfter(tokens, at) {
  const base = atomAfter(tokens, at);
  if (!base) return ["", at];
  let [chunk, next] = base;
  while (SCRIPT.test(tokens[next] || "")) {
    const script = atomAfter(tokens, next + 1);
    if (!script) break;
    chunk = `${chunk} ${tokens[next]} ${script[0]}`;
    next = script[1];
  }
  // A function takes its argument along: sin x, sin ^ 2 x, log (x + 1).
  if (FUNCTION.test(base[0]) && next < tokens.length) {
    const [argument, after] = chunkAfter(tokens, next);
    if (argument) [chunk, next] = [`${chunk} ${argument}`, after];
  }
  return [chunk, next];
}

function resolveTemplates(tokens) {
  const done = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!TEMPLATE.test(token)) {
      done.push({ text: token, composite: false });
      continue;
    }
    const before = token.includes("{1}") ? chunkBefore(done) : "";
    let after = "";
    if (token.includes("{2}")) {
      const [chunk, next] = chunkAfter(tokens, i + 1);
      after = chunk;
      i = next - 1;
    }
    const text = token.replace("{1}", operand(before)).replace("{2}", operand(after)).replace(/ +/g, " ").trim();
    if (text) done.push({ text, composite: true });
  }
  return done.map((item) => item.text).join(" ");
}

// "엑스 승 2 더하기 라지 와이 는 열고 에이 과 비 닫고" -> "x ^ 2 + Y = ( a , b )".
// Tokens come out space-separated; AsciiMath reads "x ^ 2" as x^2 all the
// same. Anything that isn't Korean (digits, letters the recognizer already
// wrote as x, symbols) passes through as its own token.
export function spokenMathToAsciiMath(text) {
  const out = [];
  const tokens = dropSentencePunctuation(text).split(/\s+/).filter(Boolean);
  let run = "";
  for (const token of tokens) {
    // Split a token like "x승" into its Korean and non-Korean stretches.
    for (const piece of token.match(/[가-힣]+|[^가-힣]+/g)) {
      if (HANGUL.test(piece)) {
        run += piece;
        continue;
      }
      const prefix = /^[A-Za-z]$/.test(piece) && capitalPrefixes.find((p) => run.endsWith(p));
      if (prefix) run = run.slice(0, -prefix.length);
      if (run) convertHangulRun(run, out);
      run = "";
      // Capitals standing alone - one letter, or two or three run together
      // ("DX" for 디엑스) - are variables the recognizer spelled out:
      // lowercase unless capitalized. Mixed-case words ("sin") stay as said.
      out.push(prefix ? piece.toUpperCase() : piece.replace(/(?<![A-Za-z])[A-Z]{1,3}(?![A-Za-z])/g, (c) => c.toLowerCase()));
    }
  }
  if (run) convertHangulRun(run, out);
  return resolveTemplates(out).replace(/ *\n */g, "\n");
}
