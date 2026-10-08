import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSpokenMathCsv,
  setSpokenMathVocabulary,
  spokenMathToAsciiMath,
  splitMathBlockCommands,
  findMathBlockCommands,
} from "../src/spoken-math.js";

const VOCABULARY = `# a comment
수식시작, $$
수식끝, $$
엑스, x
에프, f
라지에프, F
승, ^
더하기, +
과, ,
이고, \\n
열고, (
닫고, )
일, 1
이, 2
삼, 3
영, 0
적분, int
분의, {2} / {1}
에서, _ {1}
까지, ^ {1}
무한대, oo
로, -> {1}
엑스, x
`;

setSpokenMathVocabulary(parseSpokenMathCsv(VOCABULARY));

test("parses rules: first comma splits, comments skipped, spaces in words ignored", () => {
  const rules = parseSpokenMathCsv("# skip\n과, ,\n집합 열고, {\n이고, \\n\nbroken line\n");
  assert.deepEqual([...rules], [["과", ","], ["집합열고", "{"], ["이고", "\n"]]);
});

test("converts word by word, longest match first", () => {
  assert.equal(spokenMathToAsciiMath("엑스 승 이 더하기 라지 에프"), "x ^ 2 + F");
  assert.equal(spokenMathToAsciiMath("엑스 이고 에프."), "x\nf");
});

test("lone capitals the recognizer wrote are lowercase unless after the capital prefix", () => {
  assert.equal(spokenMathToAsciiMath("F 열고 X 닫고 더하기 DX"), "f ( x ) + dx");
  assert.equal(spokenMathToAsciiMath("라지 F 더하기 sin X"), "F + sin x");
});

test("keeps a decimal point, drops sentence punctuation", () => {
  assert.equal(spokenMathToAsciiMath("엑스 더하기 3.14."), "x + 3.14");
});

test("templates reorder chunks: fractions, bounds, limits", () => {
  assert.equal(spokenMathToAsciiMath("삼 분의 일"), "1 / 3");
  assert.equal(spokenMathToAsciiMath("열고 엑스 더하기 일 닫고 분의 이"), "2 / ( x + 1 )");
  assert.equal(spokenMathToAsciiMath("적분 영에서 삼 분의 일 까지 엑스"), "int _ 0 ^ ( 1 / 3 ) x");
  assert.equal(spokenMathToAsciiMath("엑스 무한대로"), "x -> oo");
  // A chunk not said yet is left out.
  assert.equal(spokenMathToAsciiMath("삼 분의"), "/ 3");
});

test("splits block commands out of a transcript, across spacing", () => {
  assert.deepEqual(splitMathBlockCommands("정리하면 수식 시작 엑스 수식끝 입니다"), ["정리하면 ", " 엑스 ", " 입니다"]);
});

test("finds block commands with their offsets", () => {
  assert.deepEqual(findMathBlockCommands("정리하면 수식 시작 엑스 수식끝"), [[5, 10], [14, 17]]);
});
