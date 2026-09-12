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

/** 小节标题的形状（`### 1. …` / `**2. …**` / `(a) …` / `1. …`）。 */
const HEAD_LINE = /^\s*(#{2,4}\s|\*\*\s*(?:\d+\.|[A-Z])|\(?[a-z]\)\s|\d+\.\s)/;

/**
 * 一段文本是不是**结论式回参**——只看内容，不看它挂在哪种 span 上（owner 2026-09-12 定）。
 *
 * 为什么不能按 span 的类型名收：异步派发时 `Agent` 工具 span 的回参只有一行
 * 「Async agent launched successfully… agentId: …」，真回参落在另一条 span 上；
 * 换一种派发形态，承载它的 span 又会叫别的名字。2026-09-12 OG-3891 实测整条漏掉。
 *
 * 判据是两条一起：**带行号的源码引用**（refs，调用方已算）+ **结论形状**（裁决行，
 * 或两个以上小节标题）。后一条挡掉 grep/cat 的原始输出——同一轮实测 62 条 Bash span
 * 里 28 条带行号引用（359 行），它们是取证的原材料而不是演绎链，全进图会把图淹掉，
 * 而且每条候选要单独调一次模型，SessionEnd 那 30 秒预算扛不住。
 */
function looksLikeReturn(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  if (verdictFromReturn(body)) return true;
  return lines.filter((l) => HEAD_LINE.test(l)).length >= 2;
}

/** 派单 description：自己的入参里有就用，没有就回溯到派发它的那条 span。 */
function hintFor(span, byId) {
  for (let s = span, depth = 0; s && depth < 4; s = byId.get(s.parent_id), depth++) {
    try {
      const d = JSON.parse(String(s.input ?? "{}")).description;
      if (d) return String(d);
    } catch {
      /* 入参不是 JSON 就往上找 */
    }
  }
  return "";
}

/** 整条 trace 的 span 列表 → 候选列表（**按内容认回参**，不按 span 类型）。 */
export function sourceEvidenceCandidates(spans) {
  const out = [];
  const seen = new Set();
  const seenRefs = new Set();
  const byId = new Map();
  for (const s of spans ?? []) if (s?.span_id && !byId.has(s.span_id)) byId.set(s.span_id, s);
  for (const s of spans ?? []) {
    if (!s || seen.has(s.span_id)) continue;
    const body = s.output_local ?? s.output;
    if (!looksLikeReturn(body)) continue;
    const c = candidatesFromReturn(body, { spanId: s.span_id, hint: hintFor(s, byId) });
    if (!c) continue;
    seen.add(s.span_id);
    // 同一份回参常同时落在子代理 span 与它最后一条 llm span 上：引用集合一样就只收一次，
    // 否则同一条证据链会被送两遍模型、在图上画成两条边。
    const key = c.lines.flatMap((l) => l.refs).sort().join("|");
    if (key && seenRefs.has(key)) continue;
    if (key) seenRefs.add(key);
    out.push(c);
  }
  return out;
}

