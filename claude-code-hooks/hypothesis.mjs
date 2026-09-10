// intent-v2 假设字段解析（2026-09-10 起英文键为准）。书写约定的规范文字在 dbdog-mcp 的
// `src/toolsets/shared/schema.ts`（`telemetry.intent` 描述），但**模型实际读到它的地方是 skill 正文**
// （investigate 的「Hypothesis ledger」段，经 load_dbdog_skill 发出去）——
// 2026-09-10 在活栈上实证：tools/list 服务出去的 intent 描述只有官方那一句，dbdog 扩展不在里面，
// 因为 inputSchema 一律由官方 descriptor 逐字回写（ADR-0004），zod 只用于校验。
// 工作目录模板 dbdog-mcp/clients/diag-workdir-template/HYPOTHESIS.md 是它的展开版。
// 三处解析器同一套正则：本文件（hook 打 span tag）、本目录 hypothesis-graph.mjs（假设图）、
// dbdog-web/src/lib/llmobs-hypothesis-tree.ts（控制台建树）。改一处三处同改。
//
// 一行的形状：
//   [H2.1<H1.2] type=cause; claim=…; expect=…; close=H1.1:refuted; intent=…; basis=source; code_ref=file:line
// 中文键（类型/假设/判据/关/意图，证伪/证实/未决）是 intent-v1 的历史形态，继续认，内部表示不变：
//   type → confirm | cause，verdict → falsified | confirmed | open。
// 编号 = H + 数字点分；容忍一个 `-` 后缀（2026-09-10 实测模型按英文键写出 [H0-anchor]、[H1-root]，
// 不收就整圈挂不上；约定里仍只写 H1 / H2.1 这种，后缀是容错不是格式）。
export const ID = "H[0-9]+(?:\\.[0-9]+)*(?:-[A-Za-z0-9_]+)?";
// 父编号后可带一个多余的 >：模板「[H<编号><H<父编号>]」常被照抄成 [H2.1<H2>]（2026-09-09 一轮 21 次）
export const HEAD = new RegExp(`^\\s*\\[\\s*(${ID})\\s*(?:<\\s*(${ID})\\s*>?)?\\s*\\]\\s*([\\s\\S]*)$`);
const KV = /^\s*(type|claim|expect|close|intent|basis|code_ref|假设|判据|关|意图|类型)\s*=\s*(.*?)\s*$/i;
const RES = new RegExp(`^\\s*(${ID})\\s*:\\s*(refuted|supported|inconclusive|证伪|证实|未决)\\s*$`, "i");
export const TYPE = { symptom: "confirm", cause: "cause", 现象确认: "confirm", 根因: "cause", 前提: "confirm" };
export const VERDICT = {
  refuted: "falsified",
  supported: "confirmed",
  inconclusive: "open",
  证伪: "falsified",
  证实: "confirmed",
  未决: "open",
};
const BASIS = new Set(["source", "telemetry", "log", "user"]);
/** 收口行里的结论词（英文 / 中文都认）。 */
export const VERDICT_WORDS = "refuted|supported|inconclusive|证伪|证实|未决";

export function normalizeHypothesisText(s) {
  return String(s)
    .replace(/＜/g, "<")
    .replace(/＝/g, "=")
    .replace(/；/g, ";")
    .replace(/：/g, ":")
    .replace(/，/g, ",")
    .replace(/　/g, " ");
}

/** 方括号头之后的字段段 → 结构；没有任何可识别字段返回 {}。 */
export function parseFields(body) {
  const out = {};
  for (const seg of String(body).split(/[;\n]/)) {
    const kv = KV.exec(seg);
    if (!kv || !kv[2]) continue;
    const k = kv[1].toLowerCase();
    const v = kv[2];
    if (k === "claim" || k === "假设") out.text = v;
    else if (k === "expect" || k === "判据") out.expect = v;
    else if (k === "intent" || k === "意图") out.intent = v;
    else if (k === "type" || k === "类型") {
      const t = TYPE[v.toLowerCase()] ?? TYPE[v];
      if (t) out.type = t;
    } else if (k === "basis") {
      const b = v.toLowerCase();
      if (BASIS.has(b)) out.basis = b;
    } else if (k === "code_ref") out.codeRef = v;
    else if (k === "close" || k === "关") {
      const rs = [];
      for (const part of v.split(",")) {
        const r = RES.exec(part);
        if (r) rs.push({ id: r[1], verdict: VERDICT[r[2].toLowerCase()] ?? VERDICT[r[2]] });
      }
      if (rs.length) out.resolve = rs;
    }
  }
  return out;
}

/**
 * 谁是它的父：**显式写的 `<父` 优先**（跨号派生只能靠它），没写就按**点分前缀**推
 * （`H4.1` → `H4`，`H4.3.2` → `H4.3`）；顶层编号没有父。
 *
 * 为什么要推：2026-09-10 实测一轮 460 次点分编号的调用，写了 `<父` 的是 **0 次**——
 * 模型读到 `[H4.1]` 就认为层级已经表达完了，那个 `<H4` 在它看来是冗余。
 * 不推的话这些节点全是孤儿，树上挂不到任何地方（页面表现：H4.1 没挂在 H4 右边）。
 * 容错后缀（`[H4.1-root]`）先剥掉再推。
 */
export function parentOfId(id, explicit) {
  if (explicit) return explicit;
  const bare = String(id ?? "").replace(/-[A-Za-z0-9_]+$/, "");
  const i = bare.lastIndexOf(".");
  return i > 0 ? bare.slice(0, i) : undefined;
}

export function parseIntent(intent) {
  if (typeof intent !== "string" || !intent.trim()) return null;
  const m = HEAD.exec(normalizeHypothesisText(intent));
  if (!m) return null;
  return { id: m[1], parent: parentOfId(m[1], m[2]), ...parseFields(m[3]) };
}

/** 写了 claim=/expect= 等字段却没有 [H..] 头（不守约定的典型形态）。 */
export function hasFieldsWithoutHead(intent) {
  if (typeof intent !== "string" || !intent.trim()) return false;
  return Object.keys(parseFields(normalizeHypothesisText(intent))).length > 0;
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
    ...(p.basis ? { hypothesis_basis: p.basis } : {}),
    ...(p.codeRef ? { code_ref: p.codeRef } : {}),
    ...(p.resolve ? { resolve: JSON.stringify(p.resolve) } : {}),
  };
}
