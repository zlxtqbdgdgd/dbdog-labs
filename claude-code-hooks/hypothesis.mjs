// intent-v1 假设字段解析。书写约定单源：
// dbdog-mcp/clients/diag-workdir-template/HYPOTHESIS.md
// （2026-09-10 起：原指的 opengauss-issue-corpus/loop/lib/hypothesis-rules.txt 只有语料 loop
//  够得着，三处解析器各自分叉过一次；新单源按三处解析器互证复原，与本文件同改同不改。）
// 必须与 dbdog-web/src/lib/llmobs-hypothesis-tree.ts、skills/span-graph/scripts/from_spans.py 对齐。
const ID = "H[0-9]+(?:\\.[0-9]+)*";
// 父编号后可带一个多余的 >：模板「[H<编号><H<父编号>]」常被照抄成 [H2.1<H2>]（2026-09-09 一轮 21 次）
const HEAD = new RegExp(`^\\s*\\[\\s*(${ID})\\s*(?:<\\s*(${ID})\\s*>?)?\\s*\\]\\s*([\\s\\S]*)$`);
const KV = /^\s*(假设|判据|关|意图|类型)\s*=\s*(.*?)\s*$/;
const RES = new RegExp(`^\\s*(${ID})\\s*:\\s*(证伪|证实|未决)\\s*$`);
const TYPE = { 现象确认: "confirm", 根因: "cause", 前提: "confirm" };
const VERDICT = { 证伪: "falsified", 证实: "confirmed", 未决: "open" };

export function normalizeHypothesisText(s) {
  return String(s)
    .replace(/＜/g, "<")
    .replace(/＝/g, "=")
    .replace(/；/g, ";")
    .replace(/：/g, ":")
    .replace(/，/g, ",")
    .replace(/　/g, " ");
}

export function parseIntent(intent) {
  if (typeof intent !== "string" || !intent.trim()) return null;
  const m = HEAD.exec(normalizeHypothesisText(intent));
  if (!m) return null;
  const out = { id: m[1], parent: m[2] || undefined };
  for (const seg of m[3].split(/[;\n]/)) {
    const kv = KV.exec(seg);
    if (!kv || !kv[2]) continue;
    const [, k, v] = kv;
    if (k === "假设") out.text = v;
    else if (k === "判据") out.expect = v;
    else if (k === "意图") out.intent = v;
    else if (k === "类型" && TYPE[v]) out.type = TYPE[v];
    else if (k === "关") {
      const rs = [];
      for (const part of v.split(",")) {
        const r = RES.exec(part);
        if (r) rs.push({ id: r[1], verdict: VERDICT[r[2]] });
      }
      if (rs.length) out.resolve = rs;
    }
  }
  return out;
}

/** 挂到 tool span tags 上，控制台按 tags.hypothesis_id 建树。解析不出则空对象。 */
export function hypothesisTags(intent) {
  const p = parseIntent(intent);
  if (!p) return {};
  return {
    hypothesis_id: p.id,
    ...(p.parent ? { parent_hypothesis_id: p.parent } : {}),
    ...(p.text ? { hypothesis: p.text } : {}),
    ...(p.expect ? { expect: p.expect } : {}),
    ...(p.type ? { hypothesis_type: p.type } : {}),
    ...(p.resolve ? { resolve: JSON.stringify(p.resolve) } : {}),
  };
}
