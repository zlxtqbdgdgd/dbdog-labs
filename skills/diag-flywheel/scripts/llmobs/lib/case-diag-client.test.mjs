// case-diag-client 的纯函数部分。跑：node --test skills/diag-flywheel/scripts/llmobs/lib/
import assert from "node:assert/strict";
import test from "node:test";
import { parseDiagnosisMap } from "./case-diag-client.mjs";

// loop 把「这条 record 跑的是哪一行诊断」交给 run-experiment，好让它一跑完就把 trace 写回去。
// 映射必须**显式传**，不能让 run-experiment 自己去猜「这个 record 当前 diagnosing 的是哪行」：
// 同一道题可以有多行复现，猜错了就把 trace 记到另一次复现头上，而页面上看不出来。
test("解析 record=diagnosis 映射：逗号分隔、可重复给", () => {
  const m = parseDiagnosisMap(["rec-a=diag-1,rec-b=diag-2", "rec-c=diag-3"]);
  assert.equal(m.size, 3);
  assert.equal(m.get("rec-a"), "diag-1");
  assert.equal(m.get("rec-b"), "diag-2");
  assert.equal(m.get("rec-c"), "diag-3");
});

test("空输入回空表，不炸", () => {
  assert.equal(parseDiagnosisMap([]).size, 0);
  assert.equal(parseDiagnosisMap(undefined).size, 0);
});

// 缺等号 / 半截的项一律丢掉，不许变成 key 为空串或 value 为 undefined 的条目——
// 那种条目会让后面 `map.get(record.id)` 拿到一个假 id，往 server 发一条改不动任何行的请求。
test("畸形项丢掉，不污染整张表", () => {
  const m = parseDiagnosisMap(["rec-a=diag-1,坏的,=diag-x,rec-y=, , rec-b = diag-2 "]);
  assert.deepEqual([...m.entries()], [["rec-a", "diag-1"], ["rec-b", "diag-2"]]);
});
