// orchestration-metrics.mjs — 编排质量的**零模型**指标（纯函数，零 I/O、零 fetch、零模型）。
//
// 为什么有这一层（dbdog-web `docs/design/llmobs-diag-flywheel.md` §8 第 2 行）：两轮 opus 体检
// 各 821s / 1287s、$21.69、25–29 个子代理，两次撞「Concurrent subagent limit reached」；判题还指出
// 一级假设 owner 在二级取证未返回时就交 `inconclusive`、root 绕过假设层拼结论、引用了树上不存在的
// 假设编号。**这些事实全都写在 span 树上**——以前只能靠 LLM 判题事后发现（一次判题很贵），
// 这里把它们算成每轮自动出的确定性数。
//
// **本轮只观测不管控**：这里只出数，不设阈值、不加 cap、不改 SERVER_INSTRUCTIONS / skill 正文。
// 现在只有 2 个样本，拍任何阈值都是猜（军规 1）——先攒分布。
//
// 单源关系（军规 3）：
//   · 假设树只有 `judge-package.mjs` 的 `hypothesisTreeFromSpans` 一份解析器，这里不另写；
//     `tool_calls` 也取那棵树的 `calls.length`（= kind=tool 的 span 数），不再数第二遍。
//   · 子代理判据「kind=agent 且有 parent_id」原本散在 `training-corpus.mjs` 里，已收编到本文件
//     的 `subagentSpans`，那边改成调它。
//   · root 判据用 `judge-package.mjs` 的 `rootSpanOf`（无 parent 且 kind=agent）。

import { hypothesisTreeFromSpans, resolveVerdictOf, rootSpanOf } from "./judge-package.mjs";

/**
 * 「撞到子代理并发上限」的判据。**从真 trace 的原文抓的，不是凭印象写的**：
 * 2026-09-09 那轮体检（trace `b3f2f4b28fe1fc73c926d1fdb28bbdfe`，判题包 pkg-p3acc）里有两条
 * `kind=tool` / `name=Agent` / `status=error` 的 span，`output` 逐字是：
 *
 *   Concurrent subagent limit reached. You can run 20 subagents at once. Do not retry.
 *   If the user wants more concurrent subagents, ask them to increase CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS.
 *
 * 另一轮（trace `d199c72b9fa6421744f2bfbc5596a147`）一次都没撞到，全 trace 零命中——两档都实证过。
 * 只匹配前半句（数字 20 与后半句提示随版本会变，钉死会漏），空白放宽成 `\s+`。
 */
export const SUBAGENT_LIMIT_RE = /concurrent\s+subagent\s+limit\s+reached/gi;

/**
 * 只扫**结果**侧文本，不扫 `input`：上限提示会被主会话原样转述进下一个子代理的 prompt，
 * 扫 input 会把「一次撞墙」数成好几次。
 */
const OUTCOME_FIELDS = ["output", "error_message"];

/** 子代理 = 有父的 agent span（root 自己不算）。hooks 侧同一条判据见 dbdog-labs `claude-code-hooks/`。 */
export function subagentSpans(spans) {
  return (spans ?? []).filter((s) => s?.kind === "agent" && s.parent_id);
}

/**
 * 每个 agent span 的嵌套层数：沿 `parent_id` 往上走，数路上有几个 agent 祖先（root 记 0）。
 * 中间隔着的 `kind=tool` / `name=Agent` span 不计层——那是「谁派的」，不是另一层代理。
 * 父 span 不在本数组里（trace 被截断）就走到哪算哪，如实少算，不猜。
 */
export function agentDepthOf(spans, span) {
  const byId = spans instanceof Map ? spans : new Map((spans ?? []).map((s) => [s?.span_id, s]));
  let depth = 0;
  let cur = span;
  const seen = new Set([span?.span_id]); // 自引用 / 环（数据坏了）不许死循环，也不许把自己数成祖先
  while (cur?.parent_id && !seen.has(cur.parent_id)) {
    const parent = byId.get(cur.parent_id);
    if (!parent) break;
    seen.add(parent.span_id);
    if (parent.kind === "agent") depth += 1;
    cur = parent;
  }
  return depth;
}

/**
 * 扫描线求「同时在跑的子代理峰值」。区间取 `[ts_ms, ts_ms + duration_ms]`，
 * **同一时刻先结束后开始**（相邻不重叠的两段算 1，不算 2）。
 * `duration_ms` 缺失或为 0（被 kill 没收上尾巴）的整条不进统计——它没有任何一刻在跑的证据，
 * 宁可少算；混进来还会因为「先结束后开始」把同刻别人的在跑数抵掉。
 *
 * 口径注意（2026-09-10 实测）：两轮体检峰值都恰好 **21**，而 Claude Code 的 cap 是 20。
 * 说明 span 的起点是**派发时刻**、终点是**收到结果**，含排队等位那一段，
 * 不等于「真在跑」。当「压着上限编排」的信号读没问题，别当成越权跑了 21 个。
 */
/**
 * span 的起始毫秒。**同一条 span 在三种形状里叫法不同**，都要认（2026-09-10 线上栽过一次）：
 * hook 落盘的 `spans.jsonl` 写 `ts` 是 ISO 8601 串（`synthesize.mjs`），server 北向与判题包
 * 导出的 `trace.json` 写 `ts_ms` 是数字毫秒。runner 喂的正是前者——只读 `ts_ms` 的话
 * `Number(undefined)` = NaN，每条区间都被跳过，峰值恒 0，而单测拿手搓对象跑照样绿
 * （p5-orch 那轮线上实测：子代理 28 个、峰值报 0）。拿不到时间返回 NaN，由调用方跳过。
 */
export function spanStartMs(span) {
  const ms = Number(span?.ts_ms);
  if (Number.isFinite(ms)) return ms;
  const parsed = Date.parse(span?.ts ?? "");
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function peakConcurrent(intervals) {
  const events = [];
  for (const { start, end } of intervals) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    events.push({ t: start, delta: 1 });
    events.push({ t: end, delta: -1 });
  }
  events.sort((a, b) => a.t - b.t || a.delta - b.delta); // 同刻 -1 在前
  let cur = 0;
  let peak = 0;
  for (const e of events) {
    cur += e.delta;
    if (cur > peak) peak = cur;
  }
  return peak;
}

/** root span 正文里引用的假设编号（`H1` / `H2.3` 这种），去重后按出现顺序。 */
export function hypothesisRefsIn(text) {
  return [...new Set(String(text ?? "").match(/\bH\d+(?:\.\d+)*\b/g) ?? [])];
}

/**
 * 一棵 trace 的编排质量指标。**全部零模型**，输入是 span 数组（trace 读口 / 判题包 `trace.json`
 * 的 `spans` 原样、或 hooks 落盘的 spans.jsonl 过滤出同一条 trace 的那些）。
 *
 * 返回（缺数据时给 null，不给 0——「没读到」和「真的是 0」不是一回事）：
 *   · `tool_calls`                  工具调用数（= kind=tool 的 span 数，与假设树同一份计数）
 *   · `subagent_count`              子代理数（kind=agent 且有 parent_id）
 *   · `subagent_depth_max`          子代理最大嵌套层数（root 记 0，只有 root 时是 0）
 *   · `subagent_peak_concurrent`    同时在跑的子代理峰值（扫描线）
 *   · `subagent_limit_hits`         撞并发上限的次数（判据 `SUBAGENT_LIMIT_RE`）
 *   · `hypothesis_count`            假设树节点数（0 = 那次会话没按约定写假设，不是「没想」）
 *   · `hypothesis_resolved`         明确收口的节点数（`confirmed` / `falsified` 一类；`open` 与
 *                                   没收口都不算——「未决」是没收口的另一种写法）
 *   · `hypothesis_dangling_refs`    root 正文引用了、但树上不存在的假设编号数（判题抓到过的实病）
 *   · `tool_calls_per_hypothesis`   工具调用 ÷ 假设数（假设数 0 时 null，不写 0 也不写 Infinity）
 */
export function orchestrationMetrics(spans) {
  const all = spans ?? [];
  const { nodes, calls } = hypothesisTreeFromSpans(all);
  const byId = new Map(all.map((s) => [s?.span_id, s]));
  const subs = subagentSpans(all);

  let depthMax = 0;
  for (const s of all) {
    if (s?.kind !== "agent") continue;
    const d = agentDepthOf(byId, s);
    if (d > depthMax) depthMax = d;
  }

  let limitHits = 0;
  for (const s of all) {
    for (const field of OUTCOME_FIELDS) {
      const v = s?.[field];
      if (typeof v !== "string" || !v) continue;
      limitHits += [...v.matchAll(SUBAGENT_LIMIT_RE)].length;
    }
  }

  const ids = new Set([...nodes.keys()].map(String));
  const dangling = hypothesisRefsIn(rootSpanOf(all)?.output).filter((ref) => !ids.has(ref));

  let resolved = 0;
  for (const id of ids) {
    const verdict = resolveVerdictOf(nodes, id);
    if (verdict && verdict !== "open") resolved += 1;
  }

  return {
    tool_calls: calls.length,
    subagent_count: subs.length,
    subagent_depth_max: depthMax,
    subagent_peak_concurrent: peakConcurrent(
      subs.map((s) => {
        const start = spanStartMs(s);
        return { start, end: start + Number(s.duration_ms ?? 0) };
      }),
    ),
    subagent_limit_hits: limitHits,
    hypothesis_count: ids.size,
    hypothesis_resolved: resolved,
    hypothesis_dangling_refs: dangling.length,
    tool_calls_per_hypothesis: ids.size ? Math.round((calls.length / ids.size) * 1000) / 1000 : null,
  };
}
