import test from "node:test";
import assert from "node:assert/strict";
import { inspectionWords } from "../scripts/inspection-command.mjs";

test("只读命令解析保留引号内正则并识别拼接参数", () => {
  assert.deepEqual(inspectionWords("rtk rg -n 'foo|bar;baz' README.md"), ["rtk", "rg", "-n", "foo|bar;baz", "README.md"]);
  assert.deepEqual(inspectionWords('rg --pre="touch sentinel" x'), ["rg", "--pre=touch sentinel", "x"]);
  assert.deepEqual(inspectionWords("rg '$(literal)' x"), ["rg", "$(literal)", "x"]);
});

test("执行语法及不完整引号不能进入 L0", () => {
  for (const cmd of ['rg x | head', 'rg "$(touch x)" .', 'rg `pwd` .', 'rg x > out', 'rg x; pwd', 'rg "$PATTERN" .', "rg 'unterminated", 'rg x\npwd', 'cat <(pwd)', 'cat *.json']) assert.equal(inspectionWords(cmd), null, cmd);
});
