// training-corpus.mjs — 训练语料的**纯函数**层（选样口径、样本形状），零 I/O、零 fetch。
//
// 单源关系（军规 3）：
//   · 选样口径 = dbdog-web `docs/design/llmobs-diag-flywheel.md` D4（2026-09-11 版：证据撑得住 + 没有工具错 = 能当训练样本），
//     这里只把 D4 翻译成判据，不另立口径。
//   · 标签落到 span 上的键名 = 设计 §7.2 的服务端投影（root span 的 `evaluation.*` tag），
//     server 侧单源在 `internal/api/llmobs_annotation_projection.go`。
//   · 假设树不在这里重建——用 `judge-package.mjs` 的 `hypothesisTreeJson`（与 forward.md 同一份树）。

import { hypothesisTreeJson, rootSpanOf, stampOf } from "./judge-package.mjs";
import { subagentSpans } from "./orchestration-metrics.mjs";

/**
 * root span 上的 `evaluation.*` tag 键（设计 §7.2 投影出来的三个，2026-09-11 改版）。
 * CH 的 tags 是 `Map(String,String)` ⇒ 改进点类别到了这里是逗号连接的一串——**不是数组**，别直接当数组用。
 */
export const EVAL_TAG_KEYS = {
  verdict: "evaluation.verdict",
  evidence: "evaluation.evidence",
  kinds: "evaluation.finding_kinds",
};

/** 判题 skill 的总结 span（hooks 的 `summary-worker.mjs` 推的那条；web `llmobs-trace-view.ts` 同一对常量）。 */
export const SUMMARY_KIND = "workflow";
export const SUMMARY_NAME = "diagnosis-summary";

/** root span 的 `evaluation.*` 读回可用形（缺的是 null / []，不补默认值）。 */
export function evaluationOf(span) {
  const tags = span?.tags ?? {};
  const raw = String(tags[EVAL_TAG_KEYS.kinds] ?? "").trim();
  return {
    verdict: tags[EVAL_TAG_KEYS.verdict] ? String(tags[EVAL_TAG_KEYS.verdict]) : null,
    evidence: tags[EVAL_TAG_KEYS.evidence] ? String(tags[EVAL_TAG_KEYS.evidence]) : null,
    kinds: raw ? raw.split(",").map((t) => t.trim()).filter(Boolean) : [],
  };
}

/**
 * 一条 root span 收不收、收成哪一档（D4 2026-09-11 版：「这条 trace 还能用来干什么」是算出来的）。
 *
 * · 没判（没有 verdict）→ 不收：判了一半的样本进训练集，等于把「不知道」当成「没问题」。
 * · 证据撑不住（`evidence=weak`）→ 不收：结论对也是蒙的，学它就是学蒙。证据没判也不收（同上一条理由）。
 * · 有工具错（`finding_kinds` 含 `tool`）→ dbdog 返回过错值 / 空 / 报错，默认不收；
 *   `--include-tool-errors` 时收成 `dbdog_gap`（trace 还能用，只是当训练样本要知道它带着已知缺口）。
 * · 其余 → `model`：纯模型 + prompt 行为样本，不论对错都进（D4 owner 原话：不同反应都是样本）。
 *   skill / model / scaffold / case / unsure 这几类改进点不影响收不收——它们说的是模型或题怎么样，不是数据假不假。
 */
export function selectSample(span, { includeToolErrors = false } = {}) {
  const ev = evaluationOf(span);
  if (!ev.verdict) return { keep: false, reason: "unjudged", evaluation: ev };
  if (ev.evidence !== "solid") return { keep: false, reason: ev.evidence === "weak" ? "weak_evidence" : "evidence_unjudged", evaluation: ev };
  if (ev.kinds.includes("tool")) {
    return includeToolErrors
      ? { keep: true, sample_kind: "dbdog_gap", reason: "", evaluation: ev }
      : { keep: false, reason: "tool_error", evaluation: ev };
  }
  return { keep: true, sample_kind: "model", reason: "", evaluation: ev };
}

/** 总结 span 的 output（`kind=workflow` / `name=diagnosis-summary`）；没有这条 span 回 null。 */
export function summaryOutputOf(spans) {
  const hit = (spans ?? []).find((s) => s.kind === SUMMARY_KIND && s.name === SUMMARY_NAME);
  const out = hit?.output;
  return out ? String(out) : null;
}

/**
 * 批注读口的 `annotated_interactions` → `{label: 原件}`。
 *
 * server 的行里 `value` 是 `json.RawMessage` ⇒ 到这里已经是**原生 JSON**
 * （数组就是数组、对象就是对象），**不再解析一遍**，也不改形状——
 * 训练语料要的是判题原件，不是我方再加工过的投影（投影已经在 span tag 上了）。
 * 同一条 trace 可能跨多个队列有 interaction：按取回顺序后写赢，与 D5「改判是覆盖」同向。
 */
export function flattenJudgeLabels(interactions) {
  const out = {};
  for (const it of interactions ?? []) {
    for (const an of it?.annotations ?? []) {
      const label = String(an?.label ?? "").trim();
      if (!label) continue; // label schema 被删过的孤儿批注：没有名字就折不平，如实丢
      out[label] = an.value;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 一条样本（= corpus.jsonl 的一行）。
 * `spans` 是整条 trace 的 span（trace 读口原样），`rootSpan` 缺省从里面找。
 */
export function buildSample({ traceId, spans, rootSpan, judge = null, sampleKind = "model", mlApp = null }) {
  const root = rootSpan ?? rootSpanOf(spans);
  const tree = hypothesisTreeJson(spans);
  const all = spans ?? [];
  return {
    trace_id: String(traceId ?? root?.trace_id ?? ""),
    // ml_app 只活在 `tags['ml_app']`：span 的北向形（server `llmobsSpanOut`）**没有这一列**，
    // 检索请求里的 `ml_app` 也是翻译成 `tags['ml_app'] = ?` 去查的。别去读不存在的顶层字段。
    ml_app: mlApp ?? (root?.tags?.ml_app ? String(root.tags.ml_app) : null),
    stamps: stampOf(root), // 五键里没盖的不补（`judge-package.mjs` 的口径：「未盖」是有效结论）
    prompt: root?.input ? String(root.input) : null,
    answer: root?.output ? String(root.output) : null,
    summary: summaryOutputOf(all),
    hypothesis_tree: tree,
    tool_calls_count: tree.tool_calls,
    // 子代理判据（有父的 agent span，root 自己不算）单源在 `orchestration-metrics.mjs`——
    // 跑批的编排指标数的是同一批 span，这里不留第二份（军规 3）。
    subagent_count: subagentSpans(all).length,
    judge,
    sample_kind: sampleKind,
  };
}
