// source-evidence.mjs — 一层子代理回参 → **代码证据候选**（粗筛，零模型）。
//
// 链条与 prose-hypotheses 那套同形（owner 2026-09-12 定走这条）：
//   ① hook 抓原文（已有，不动）
//   ② 本文件：宽松抓「带行号的源码引用」，把 5000+ 字符的回参压到几百 token
//   ③ 模型判切分与真伪：哪几行凑成一条证据步、标题是什么、哪些只是顺口提了个文件名
//
// 为什么 ② 不能直接当结论 —— 2026-09-12 在 27 条历史 trace 上实测：
//   · 宽松匹配 file:line 343 处，而按「反引号 + `**N.` 小节」的严格正则只抽出 43 处（召回 12.5%）；
//   · 漏的原因全是格式抖动：`## H3 verdict:` / `### 1. …` / `**Verdict: supported.**` /
//     第一行是「All evidence gathered.」/ 行号写在正文不在反引号里。
//   子代理每次回参形状都不同，而 skill 压不住格式（同期四轮验证已证），正则追不过来。
// 所以这里只负责**召回**，不做判断：宁可多给候选，让 ③ 去筛。

/** 宽松：不要求反引号、不要求小节。扩展名白名单挡掉 `3.14:15` 这类误命中。 */
const LOOSE_REF =
  /\b([\w./-]+\.(?:y|ya?ml|cpp|cc|c|hpp|h|in|cmake|txt|mjs|ts|tsx|py|sh|po|sql|conf|proto|rs|go|java))[:：](\d+(?:\s*[-–]\s*\d+)?)/g;

/** 一行里抓到的引用去重后规整成 `路径:行` / `路径:行-行`。 */
export function refsInLine(line) {
  const out = [];
  for (const m of String(line ?? "").matchAll(LOOSE_REF)) {
    const ref = `${m[1]}:${m[2].replace(/\s*[-–]\s*/, "-")}`;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

const MAX_LINE = 300; // 单行上限：证据行偶尔很长（贴了整段代码），截断不影响模型判断
const MAX_LINES = 60; // 单条回参的候选行上限：再多就不是证据链而是全文转储

/**
 * 一条 Agent span → 候选。没有任何带行号引用则返回 null（遥测侧子代理走这条路，它的证据在工具边上）。
 * `hint` 是派单 description（`Verify H2 source conditionality`），模型据此定编号。
 */
export function candidatesFromReturn(text, { spanId = "", hint = "" } = {}) {
  const body = String(text ?? "");
  if (!body.trim()) return null;
  const lines = [];
  for (const raw of body.split(/\r?\n/)) {
    const refs = refsInLine(raw);
    if (!refs.length) continue;
    lines.push({ text: raw.trim().slice(0, MAX_LINE), refs });
    if (lines.length >= MAX_LINES) break;
  }
  if (!lines.length) return null;
  // 小节标题一并带上（`### 1. …` / `**2. …**` / `## Verdict…`），模型用它给证据步命名；
  // 严格解析器当初就是死在这些形状的抖动上，这里只收集、不判定。
  const heads = body
    .split(/\r?\n/)
    .filter((l) => /^\s*(#{2,4}\s|\*\*\s*(?:\d+\.|[A-Z])|\(?[a-z]\)\s|\d+\.\s)/.test(l))
    .map((l) => l.trim().slice(0, 160))
    .slice(0, 30);
  return { spanId, hint: String(hint ?? "").slice(0, 160), verdict: verdictFromReturn(body), heads, lines };
}

/**
 * 回参里的裁决 → 内部表示。**这一项用正则不用模型**（2026-09-12 实测教训）：
 * 让模型顺带判裁决时它会拿「证据很硬」当成「假设成立」——第四轮那条子代理原文写的是
 * `[H2] refuted`（假设「是配置/版本差异造成的」被证据推翻），模型回了 supported。
 * 裁决是**单个关键词**，形状可穷举；切分才是自由文本、穷举不了。分工要照这条切。
 * 已见过的形状：`[H2] refuted` / `## H3 verdict: **refuted**` / `**Verdict: supported.**`
 * / `VERDICT: **inconclusive**` / `H1 判定：证伪`。只扫前 12 行——再往后是正文里引用别人的裁决。
 */
// `\b` 对 CJK 不成立（`：` 与 `证` 之间没有词边界），所以中英文两支分开写。
const VERDICT_LINE =
  /(?:^|\n)\s*(?:#{0,4}\s*)?(?:\[\s*H[0-9.]+\s*\]|H[0-9.]+)?\s*\**\s*(?:verdict|判定|裁决)?\s*\**\s*[:：]?\s*\**\s*(?:\b(refuted|supported|inconclusive)\b|(证伪|证实|未决))/i;
const VERDICT_MAP = { refuted: "falsified", supported: "confirmed", inconclusive: "open", 证伪: "falsified", 证实: "confirmed", 未决: "open" };

export function verdictFromReturn(text) {
  const head = String(text ?? "").split(/\r?\n/).slice(0, 12).join("\n");
  const m = VERDICT_LINE.exec(head);
  if (!m) return null;
  const w = m[1] ?? m[2];
  return VERDICT_MAP[String(w).toLowerCase()] ?? VERDICT_MAP[w] ?? null;
}

/** 整条 trace 的 span 列表 → 候选列表（只看 Agent 工具 span）。 */
export function sourceEvidenceCandidates(spans) {
  const out = [];
  const seen = new Set();
  for (const s of spans ?? []) {
    if (s?.kind !== "tool" || String(s.name ?? "") !== "Agent") continue;
    if (seen.has(s.span_id)) continue;
    seen.add(s.span_id);
    let hint = "";
    try {
      hint = String(JSON.parse(String(s.input ?? "{}")).description ?? "");
    } catch {
      /* 入参不是 JSON 就算了 */
    }
    const c = candidatesFromReturn(s.output_local ?? s.output, { spanId: s.span_id, hint });
    if (c) out.push(c);
  }
  return out;
}
