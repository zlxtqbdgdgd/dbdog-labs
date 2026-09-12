// judge-package.mjs — 判题包的**纯函数**层（形状、渲染、解析），零 I/O、零 fetch。
//
// 单源关系（军规 3）：
//   · label 词表与取值形状 = dbdog-web `docs/design/llmobs-diag-flywheel.md` §7.1（2026-09-11 改版：结论 / 证据 / 改进点）；
//     export 写进 manifest、import 按 manifest 的 id 回写、判题 skill 正文按同一张表判——三处共用本文件。
//   · 探针 outcome 四值与同事 skill `evidence-chain` 同口径（`../dbdog-labs/skills/evidence-chain/scripts/check_chain.py` 是它的守门）。
//   · 假设树**只认 span tags**（`hypothesis_id` / `parent_hypothesis_id` / `hypothesis` / `expect` /
//     `resolve`），不在这里再写一份 intent 解析器——那份在 dbdog-labs 的 `claude-code-hooks/hypothesis.mjs`
//     与 dbdog-web 的 `src/lib/llmobs-hypothesis-tree.ts`，书写约定单源是
//     `clients/diag-workdir-template/HYPOTHESIS.md`。tags 没有 = 那次会话没按约定写，如实说，别猜。

/** 版本章五键（D6）。谁经手谁盖，都在 root span 的 tags 上。 */
export const STAMP_KEYS = ["hooks_version", "mcp_version", "skills_digest", "tools_digest", "server_version"];

/** 判题队列名（每个 project 一个）。 */
export const QUEUE_NAME = "diag-judge";

/**
 * label schema（§7.1，2026-09-11 改版）。每个 label 回答一个不用图例就看得懂的问题；
 * `value_type` 走 server 的枚举（boolean / categorical / string / score / json），投影按 value_type 与值的形状算，
 * 不认 label 名（server ADR-0051 附注）。`options` 只有枚举型才发：nil = 不是枚举，`[]` = 是枚举但没配选项——两档不同，别混。
 *
 * 判题方写前三个 + summary；`finding_kinds` 由 import 从 findings 算出（同一件事不写两遍）；`fix_marks` 由修的人用 fix-mark.mjs 写。
 */
export const LABEL_SCHEMA = [
  { label: "verdict", value_type: "categorical", options: ["correct", "partial", "wrong", "unknown"], display: "结论对不对：对 / 部分对 / 错 / 判不了（没答案纸）" },
  { label: "evidence", value_type: "categorical", options: ["solid", "weak"], display: "证据撑不撑得住结论" },
  { label: "findings", value_type: "json", display: "改进点（一条一个）+ 对之前几轮条目的复验" },
  { label: "finding_kinds", value_type: "json", display: "改进点类别（由 import 从 findings 算出，筛选用）" },
  { label: "summary", value_type: "string", display: "总评（大白话，≤ 600 字符）" },
  { label: "fix_marks", value_type: "json", display: "修复标记（改了等复验 / 要人协助 / 不修；fix-mark.mjs 写）" },
];

/** 判题方要写的 label（其余两个由脚本写）。 */
export const JUDGE_WRITTEN_LABELS = ["verdict", "evidence", "findings", "summary"];

export const VERDICTS = ["correct", "partial", "wrong", "unknown"];
export const EVIDENCE_VALUES = ["solid", "weak"];

/**
 * 改进点六类（§7.1）：分类的唯一标准是「下一步谁去干什么、怎么验」，互斥。顺序就是 finding_kinds 的输出顺序。
 * tool 确定性（代码 / 配置，含 hooks 与跑批脚本；重放必现，改代码，复验一次即关）；skill 非确定性（给模型的话：
 * skill 正文 / 工作目录模板 / 派单提示词；改一段话，连续两轮 fixed 才关）；model 不改代码只计次；case 改用例；
 * env 回复现那一侧；unsure 要人看。
 * 2026-09-11 晚撤掉 scaffold（编排错）：按话题分、不按下一步分，一条提出来分不清改代码还是改话；原归它的拆进 tool / skill。
 * 2026-09-11 晚补 env：这次复现的窗口里现象根本没出来（靶机被重装、时间窗错位），既不是题错也不是 dbdog 的错，
 * 下一步是回复现那一侧重跑——原先无处可放，只能塞 case 或 unsure，两种都失真。
 */
export const FINDING_KINDS = ["tool", "skill", "model", "case", "env", "unsure"];

/** 这几类是能动手修的（web「有 dbdog 要修的」筛的是 tool / skill；case 改用例；env 回复现那一侧）。 */
export const FIXABLE_KINDS = ["tool", "skill", "case", "env"];

/**
 * `tool` 类落在哪一层。**这一维独立于 kind**：同是「工具错」，改 server 的查询、改 agent 的采集项、
 * 改 hooks、改跑批脚本是四个仓四个人，连「怎么验」都不同（采集项改完要重装 + 等一个采集周期，
 * 不是「重放必须变对」）。原先只靠 `key` 的第一段暗示，没有词表也不校验，于是各写各的。
 */
export const TOOL_LAYERS = ["server", "agent", "hooks", "scripts"];

/**
 * ODC（Orthogonal Defect Classification，IBM Chillarege）的 qualifier：**缺失 / 写错 / 多余**是与
 * 缺陷类别**正交的另一维**，不该塞进类别里。对我们的两处直接受益：
 *   · tool：「dbdog 根本没这个工具 / 没采这项」(missing) 与「有但返回错」(incorrect) 下一步不同——
 *     前者是排能力、后者是修 bug，验法也不同；
 *   · skill：「那条规矩没写」(missing) 与「写了但写错」(incorrect)——原先 rubric 把分界压成
 *     「规矩写没写」一句话，写错的那种会被推给 model（不改代码、只计次）从而沉底。
 */
export const FINDING_QUALIFIERS = ["missing", "incorrect", "extraneous"];

/** 必须给 qualifier 的两类（model 是模型行为、case/env/unsure 没有「实现」可言）。 */
export const QUALIFIED_KINDS = ["tool", "skill"];

/** 修复标记三值（§13.3）：改了等复验 / 要人协助 / 不修。 */
export const FIX_MARK_STATUSES = ["claimed_fixed", "needs_human", "wont_fix"];

/** 探针 outcome 四值（与 evidence-chain 同口径）。 */
export const PROBE_OUTCOMES = ["obtained_match", "obtained_mismatch", "empty_or_error", "no_tool"];

/** 两腿一致性四值。 */
export const PROBE_CONSISTENCY = ["consistent", "tool_bug_suspect", "data_absent", "not_probed"];

// ── span 侧 ────────────────────────────────────────────────────────────────────

/** root 判据与 span-stamp.ts / curate-record.mjs 同一条：没有 parent 且 kind=agent。 */
export function rootSpanOf(spans) {
  return (spans ?? []).find((s) => !s.parent_id && s.kind === "agent") ?? null;
}

/** 版本章：root tags 里那五键，缺的不补（「未盖」是有效结论，不是 0）。 */
export function stampOf(rootSpan) {
  const tags = rootSpan?.tags ?? {};
  const out = {};
  for (const key of STAMP_KEYS) if (tags[key]) out[key] = String(tags[key]);
  return out;
}

const RESOLVE_ZH = { falsified: "证伪", confirmed: "证实", open: "未决" };

function parseResolve(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 从 span tags 重建假设树。返回 `{ nodes, calls, unlabeled }`：
 *   · nodes：`Map<id, {id, parent, text, expect, type, calls:[], resolves:[]}>`，缺席的父节点补占位；
 *   · calls：全体带 intent 的工具调用，按时间升序，带全局 seq（与控制台的「第几步」同义）；
 *   · unlabeled：没有 `hypothesis_id` tag 的工具调用数。
 */
export function hypothesisTreeFromSpans(spans) {
  const tools = (spans ?? [])
    .filter((s) => s.kind === "tool")
    .sort((a, b) => (a.ts_ms ?? 0) - (b.ts_ms ?? 0) || String(a.span_id).localeCompare(String(b.span_id)));
  const nodes = new Map();
  const calls = [];
  let unlabeled = 0;
  const ensure = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, parent: undefined, text: "", expect: "", type: "", calls: [], resolves: [] });
    return nodes.get(id);
  };
  tools.forEach((span, i) => {
    const tags = span.tags ?? {};
    const call = {
      seq: i + 1,
      span_id: String(span.span_id ?? ""),
      ts_ms: span.ts_ms ?? 0,
      tool: String(span.name ?? ""),
      intent: String(span.intent ?? ""),
      status: String(span.status ?? ""),
    };
    calls.push(call);
    const id = tags.hypothesis_id;
    if (!id) {
      unlabeled += 1;
      return;
    }
    const node = ensure(String(id));
    if (tags.parent_hypothesis_id) {
      node.parent = String(tags.parent_hypothesis_id);
      ensure(node.parent);
    }
    if (tags.hypothesis && !node.text) node.text = String(tags.hypothesis);
    if (tags.expect) node.expect = String(tags.expect);
    if (tags.hypothesis_type && !node.type) node.type = String(tags.hypothesis_type);
    for (const r of parseResolve(tags.resolve)) {
      node.resolves.push({ ...r, seq: call.seq });
      ensure(String(r.id));
    }
    node.calls.push(call);
  });
  return { nodes, calls, unlabeled };
}

function childrenOf(nodes, parent) {
  return [...nodes.values()]
    .filter((n) => (n.parent ?? undefined) === parent)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/**
 * 按父子关系深度优先摊平成 `[{node, depth}]`（同层按编号自然序）。
 * **树的形状只在这一处定义**：`forward.md` 的缩进列表与训练语料的 `hypothesis_tree`
 * 走同一条遍历，两边的节点顺序天然一致（军规 3：同一事实一个 owning path）。
 * 父节点不在本 trace 里的（`ensure` 补过占位就不会有；防御性保留）单独跟在后面，depth=0。
 */
export function orderedHypothesisNodes(nodes) {
  const out = [];
  const walk = (parent, depth) => {
    for (const node of childrenOf(nodes, parent)) {
      out.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(undefined, 0);
  const seen = new Set(out.map(({ node }) => node.id));
  for (const node of nodes.values()) {
    if (!seen.has(node.id)) out.push({ node, depth: 0 });
  }
  return out;
}

/** 某个假设被哪次调用收了口：原样的 verdict（`confirmed` / `falsified` / `open` / …），没收口回 null。 */
export function resolveVerdictOf(nodes, id) {
  for (const node of nodes.values()) {
    for (const r of node.resolves) if (String(r.id) === String(id)) return String(r.verdict);
  }
  return null;
}

function verdictOf(nodes, id) {
  const raw = resolveVerdictOf(nodes, id);
  if (raw === null) return "未收口";
  return RESOLVE_ZH[raw] ?? raw;
}

/**
 * 假设树的**结构化形**（`hypothesisTreeFromSpans` 的 JSON 投影，零 I/O）。
 * `forward.md` 给人读、这份给训练语料读，**同一份树、同一个遍历**——不是第二份解析器。
 * 节点里 `parent` 缺席写 null（顶层），`resolve` 是这个编号被收口的记录（可能来自别的节点名下）。
 */
export function hypothesisTreeJson(spans) {
  const { nodes, calls, unlabeled } = hypothesisTreeFromSpans(spans);
  return {
    // false = 那次会话没按 `clients/diag-workdir-template/HYPOTHESIS.md` 写假设，
    // 只有调用序列。判题/训练时别把它当成「agent 没想」（军规 1：分不清就如实说）。
    written: nodes.size > 0,
    tool_calls: calls.length,
    unlabeled_calls: unlabeled,
    nodes: orderedHypothesisNodes(nodes).map(({ node, depth }) => ({
      id: node.id,
      parent: node.parent ?? null,
      depth,
      hypothesis: node.text || null,
      expect: node.expect || null,
      type: node.type || null,
      resolve: resolveVerdictOf(nodes, node.id),
      calls: node.calls.map((c) => ({
        seq: c.seq, span_id: c.span_id, name: c.tool, intent: c.intent || null, status: c.status || null,
      })),
    })),
  };
}

function clip(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * `forward.md`：正向假设树 + 按时间的工具调用 + root 结论。
 * 与 span-graph 的 `forward-path.md` 同构（假设树 / 出现顺序 / 收口 / 未挂到假设的调用）。
 */
export function renderForward(spans, { eventId = "", traceId = "" } = {}) {
  const root = rootSpanOf(spans);
  const { nodes, calls, unlabeled } = hypothesisTreeFromSpans(spans);
  const lines = [];
  lines.push(`# 正向：这次诊断实际走的路`);
  lines.push("");
  lines.push(`- 用例（event）：\`${eventId || "—"}\`　trace：\`${traceId || root?.trace_id || "—"}\``);
  lines.push(`- span 合计 ${(spans ?? []).length}，工具调用 ${calls.length}，其中挂到假设的 ${calls.length - unlabeled}`);
  const stamp = stampOf(root);
  lines.push(`- 版本章：${STAMP_KEYS.map((k) => `${k}=${stamp[k] ?? "未盖"}`).join("　")}`);
  lines.push("");

  if (nodes.size === 0) {
    lines.push("## 假设树");
    lines.push("");
    lines.push("**本 trace 未按约定书写（span 上没有 `hypothesis_id`），只有调用序列。**");
    lines.push("");
    lines.push("约定见 `clients/diag-workdir-template/HYPOTHESIS.md`。判题时 `hypothesis_missing` /");
    lines.push("`tool_misuse` / `reasoning_error` 这三类归因**判不了**（分不清「没想到」和「想到了没写」），");
    lines.push("按 `scaffold` 记一条，别把它算成 agent 的假设层问题。");
  } else {
    lines.push("## 假设树");
    lines.push("");
    for (const { node, depth } of orderedHypothesisNodes(nodes)) {
      const pad = "  ".repeat(depth);
      const type = node.type === "cause" ? "根因" : node.type === "confirm" ? "现象确认" : "类型未写";
      lines.push(`${pad}- **[${node.id}]** ${node.text || "（假设正文缺失：该编号第一次出现时没写 假设=）"}`);
      lines.push(`${pad}  - 类型 ${type}　结论 ${verdictOf(nodes, node.id)}　取证 ${node.calls.length} 次`);
      if (node.expect) lines.push(`${pad}  - 判据：${clip(node.expect, 200)}`);
      if (node.calls.length) {
        lines.push(`${pad}  - 调用：${node.calls.map((c) => `#${c.seq} \`${c.tool}\`（span \`${c.span_id ?? "—"}\`）`).join("、")}`);
      }
    }
    const orphan = [...nodes.values()].filter((n) => n.parent && !nodes.has(n.parent));
    for (const node of orphan) lines.push(`- **[${node.id}]**（父 ${node.parent} 在本 trace 里没出现过）`);
    lines.push("");
    lines.push("## 假设收口");
    lines.push("");
    const closings = [...nodes.values()].flatMap((n) => n.resolves.map((r) => ({ ...r, by: n.id })));
    if (closings.length === 0) lines.push("（没有任何一次调用写了 `关=`——所有假设都没在取证里收口。）");
    for (const c of closings.sort((a, b) => a.seq - b.seq)) {
      lines.push(`- 第 ${c.seq} 步（[${c.by}] 名下）把 **${c.id}** 判成 **${RESOLVE_ZH[c.verdict] ?? c.verdict}**`);
    }
  }
  lines.push("");

  lines.push("## 工具调用（按时间）");
  lines.push("");
  // span 列不是装饰：每条改进点的 pointers 要指到 span_id，回流会拿它跟 trace.json 对。
  // 而判官被告知「trace.json 几 MB 不要通读，看 forward.md」——摘要里不打 span_id，
  // 就等于逼他去翻几 MB 原文，或者编一个（编的会被整包拒）。
  lines.push("| # | span | 工具 | 假设 | 状态 | 意图 |");
  lines.push("|---|---|---|---|---|---|");
  const idOf = new Map();
  for (const node of nodes.values()) for (const c of node.calls) idOf.set(c.seq, node.id);
  for (const c of calls) {
    lines.push(`| ${c.seq} | \`${c.span_id ?? "—"}\` | \`${c.tool}\` | ${idOf.get(c.seq) ? `[${idOf.get(c.seq)}]` : "未挂"} | ${c.status || "—"} | ${clip(c.intent, 160) || "—"} |`);
  }
  if (calls.length === 0) lines.push("| — | （这条 trace 一次工具都没调） | — | — | — |");
  lines.push("");

  lines.push("## 结论（root span output 原文）");
  lines.push("");
  lines.push(root?.output ? String(root.output) : "（root span 没有 output——多半是超时被杀后收尸补的 root。）");
  lines.push("");
  return lines.join("\n");
}

// ── 反向链 / 答案纸 ────────────────────────────────────────────────────────────

/** `reverse.md`：反向证据链（record.metadata.reverse_chain）。`.json` 原样另存，本函数只渲染。 */
export function renderReverse(chain, { recordId = "" } = {}) {
  const lines = [`# 反向：这个根因本该留下哪些痕迹`, ""];
  if (recordId) lines.push(`- 用例 record：\`${recordId}\``, "");
  if (typeof chain === "string") return `${lines.join("\n")}\n${chain}\n`;
  const c = chain ?? {};
  for (const [heading, key] of [["What happened", "what_happened"], ["Why that broke things", "why"], ["The root cause", "root_cause"], ["What to do to fix", "fix"]]) {
    if (c[key]) lines.push(`## ${heading}`, "", typeof c[key] === "string" ? c[key] : JSON.stringify(c[key], null, 1), "");
  }
  const evidence = Array.isArray(c.evidence_chain) ? c.evidence_chain : [];
  lines.push("## How do we know（证据）", "");
  if (evidence.length === 0) {
    lines.push("（反向链里没有 `evidence_chain`——这份链是残的，判题时按「材料不全」写进 summary。）", "");
  } else {
    lines.push("| E | 档 | 该用的工具 | 入参 | 取证结果 | 推论 |");
    lines.push("|---|---|---|---|---|---|");
    for (const e of evidence) {
      lines.push(`| ${e.id ?? "?"} | ${e.tier ?? "—"} | ${e.tool ? `\`${e.tool}\`` : (e.source === "unavailable" ? "**无工具**" : "—")} | ${clip(e.params, 90) || "—"} | ${e.outcome ?? "—"} | ${clip(e.inference, 120) || "—"} |`);
    }
    lines.push("");
  }
  const findings = Array.isArray(c.dbdog_findings) ? c.dbdog_findings : [];
  lines.push("## 附录：dbdog 侧发现", "");
  if (findings.length === 0) lines.push("（无。）", "");
  for (const f of findings) lines.push(`- **${f.evidence_id ?? "?"}** ${f.kind ?? ""}：${clip(f.detail, 240)}（影响：${f.impact ?? "—"}）`);
  if (c.consistency?.verdict) {
    lines.push("", "## 讲不讲得通", "", `结论 **${c.consistency.verdict}**：${clip(c.consistency.verdict_why, 400)}`, "");
  }
  return `${lines.join("\n")}\n`;
}

/** `ground-truth.md`：答案纸（experiment event 的 expected_output；整个可缺 = 无参照题）。 */
export function renderGroundTruth(expected, { eventId = "" } = {}) {
  const lines = [`# 答案纸`, ""];
  if (eventId) lines.push(`- 用例（event）：\`${eventId}\``, "");
  if (typeof expected === "string") return `${lines.join("\n")}\n${expected}\n`;
  const e = expected ?? {};
  if (Array.isArray(e.expected_roots) && e.expected_roots.length) {
    // 有序列表不是排版偏好：判题方要按**这个顺序**把命中的根因编号写进 `findings.roots`，
    // 用无序列表他得自己数，数错就是整包拒。
    lines.push("## 期望根因", "", ...e.expected_roots.map((r, i) => `${i + 1}. ${r}`), "");
  }
  if (Array.isArray(e.expected_phenomena) && e.expected_phenomena.length) {
    lines.push("## 期望现象", "", ...e.expected_phenomena.map((r) => `- ${r}`), "");
  }
  if (Array.isArray(e.expected_behaviors) && e.expected_behaviors.length) {
    lines.push("## 行为基准", "", ...e.expected_behaviors.map((r) => `- ${r}`), "");
  }
  if (e.notes) lines.push("## 附注", "", String(e.notes), "");
  const known = new Set(["expected_roots", "expected_phenomena", "expected_behaviors", "notes"]);
  const rest = Object.fromEntries(Object.entries(e).filter(([k]) => !known.has(k)));
  if (Object.keys(rest).length) lines.push("## 其余字段（原样）", "", "```json", JSON.stringify(rest, null, 1), "```", "");
  return `${lines.join("\n")}\n`;
}

/** 答案纸整个可缺（无参照题，不另设标志字段）——空对象也算缺。 */
export function hasGroundTruth(expected) {
  if (expected === null || expected === undefined) return false;
  if (typeof expected === "string") return expected.trim() !== "";
  if (typeof expected !== "object") return false;
  return Object.keys(expected).length > 0;
}

// ── 回传件解析 ────────────────────────────────────────────────────────────────

/**
 * 解析 `annotations.jsonl`：每行一个 `{trace_id, labels:{…}}`。
 * 返回 `{rows, problems}`——**格式错不静默丢**：丢一行 = 少判一例，而 import 会「成功」退出。
 * 同一 trace_id 出现多次时后写赢（改判是覆盖，D5），并记一条 problem 提示。
 */
export function parseAnnotationsJsonl(text) {
  const rows = [];
  const problems = [];
  const seen = new Map();
  const lines = String(text ?? "").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      problems.push(`第 ${i + 1} 行不是合法 JSON：${e.message}`);
      return;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      problems.push(`第 ${i + 1} 行不是 JSON 对象`);
      return;
    }
    const traceId = typeof obj.trace_id === "string" ? obj.trace_id.trim() : "";
    if (!traceId) {
      problems.push(`第 ${i + 1} 行缺 trace_id——回流时找不到 interaction`);
      return;
    }
    const labels = obj.labels && typeof obj.labels === "object" && !Array.isArray(obj.labels) ? obj.labels : null;
    if (!labels) {
      problems.push(`第 ${i + 1} 行（${traceId}）缺 labels 对象`);
      return;
    }
    const labelProblems = validateLabels(labels);
    problems.push(...labelProblems.map((p) => `第 ${i + 1} 行（${traceId}）${p}`));
    // 形状不合契约的行照样交回去（import 据此整包拒写，不是悄悄丢一行）
    const row = { trace_id: traceId, labels, line: i + 1, ...(labelProblems.length ? { invalid: labelProblems } : {}) };
    if (seen.has(traceId)) {
      problems.push(`第 ${i + 1} 行：trace_id ${traceId} 重复，按后写赢覆盖第 ${seen.get(traceId)} 行`);
      rows[rows.findIndex((r) => r.trace_id === traceId)] = row;
    } else {
      seen.set(traceId, i + 1);
      rows.push(row);
    }
  });
  return { rows, problems };
}

/* ── 改进点与复验（飞轮设计 §13.3：「每次改哪里拆成一条一条」「修没修好看实际效果，不依赖人的反馈」） ── */

/** 复验结果：修好了 / 又撞上了 / 这一轮没走到那条路（不算数）。 */
export const FIX_CHECK_STATUSES = ["fixed", "still_open", "not_exercised"];

/**
 * 条目 key：小写 ascii，`<层>.<模块>.<缺什么>`。它是跨轮次认「同一个缺口」的唯一依据——
 * 换个说法再提一遍就数不清修没修，所以要短、要稳、要能 grep。
 */
export const FIX_KEY_RE = /^[a-z0-9][a-z0-9._-]{2,79}$/;

function pointerProblems(where, pointers, required) {
  const out = [];
  const list = Array.isArray(pointers) ? pointers : [];
  if (required && list.length === 0) out.push(`${where}.pointers 为空（每条改进点都得指到 span_id 或探针行）`);
  for (const pt of list) {
    if (!pt || typeof pt !== "object" || (!pt.span_id && !pt.probe)) {
      out.push(`${where}.pointers 里的 ${JSON.stringify(pt)} 既不是 {span_id} 也不是 {probe}`);
    }
  }
  return out;
}

const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * `findings` 的形状：
 * `{ items: [{key, kind, title, evidence, fix_where, suggestion, repro?, pointers}], checks: [{key, status, kind?, pointers, note}] }`。
 * - items：这一轮新发现的改进点，一条一个落点。三个属性各管一维（ODC 式，互不替代）：
 *   `kind` 谁去干（六类）、`layer` 落在哪一层（tool 必填）、`qualifier` 缺失 / 写错 / 多余（tool、skill 必填）。
 *   `title` / `evidence` 必填（读的人靠它们，不靠 key）；`fix_where` 与 `suggestion` 在 tool / skill / case / env
 *   四类必填（能动手修的必须说改哪里）；`repro` 在 tool 必填；`rule_ref` 在 model 必填；
 *   `suspected_kind` 在 unsure 必填；`unsure` 的 `suggestion` 写要人核什么。
 * - checks：这道题之前几轮提过、还没关的，逐条复验（`fixed` / `still_open` 必须带证据指针）。
 * 旧形状（`attribution`、顶层一段 `fix_where`）直接拒：一段里塞五处改动，数不出哪处修了。
 */
export function validateFindings(a) {
  const problems = [];
  if (!a || typeof a !== "object" || Array.isArray(a)) return ["findings 必须是对象"];
  if ("fix_where" in a && !("items" in a)) {
    return ["findings 是旧形状（顶层一段 fix_where）——改成 items[] 一条一个落点、checks[] 复验之前几轮提过的（skill「改进点」一节）"];
  }
  const items = a.items ?? [];
  const checks = a.checks ?? [];
  if (!Array.isArray(items)) problems.push("findings.items 必须是数组");
  if (!Array.isArray(checks)) problems.push("findings.checks 必须是数组");
  const keys = new Set();
  (Array.isArray(items) ? items : []).forEach((it, i) => {
    const w = `findings.items[${i}]`;
    if (!it || typeof it !== "object") return problems.push(`${w} 必须是对象`);
    if (!FIX_KEY_RE.test(String(it.key ?? ""))) problems.push(`${w}.key ${JSON.stringify(it.key)} 不合规（小写 ascii，<层>.<模块>.<缺什么>）`);
    else if (keys.has(it.key)) problems.push(`${w}.key ${it.key} 重复——一个缺口只提一条`);
    else keys.add(it.key);
    if (!FINDING_KINDS.includes(it.kind)) problems.push(`${w}.kind ${JSON.stringify(it.kind)} 只能是 ${FINDING_KINDS.join(" / ")}`);
    if (!nonEmpty(it.title)) problems.push(`${w}.title 缺失（一句话说谁在哪出了什么事）`);
    if (!nonEmpty(it.evidence)) problems.push(`${w}.evidence 缺失（看到了什么 / 本该是什么 / 为什么是问题）`);
    if (FIXABLE_KINDS.includes(it.kind)) {
      if (!nonEmpty(it.fix_where)) problems.push(`${w}.fix_where 缺失（${it.kind} 类必须说改哪里，且只写一处）`);
      if (!nonEmpty(it.suggestion)) problems.push(`${w}.suggestion 缺失（${it.kind} 类必须说怎么改）`);
    }
    if (it.kind === "unsure" && !nonEmpty(it.suggestion)) problems.push(`${w}.suggestion 缺失（unsure 要写清要人核什么、看哪里）`);
    // ODC 的第二维：缺失 / 写错 / 多余。不问这一句，「没这个能力」与「有但坏了」会挤在同一类里，
    // 而它们的下一步和验法都不同（见 FINDING_QUALIFIERS）。
    if (QUALIFIED_KINDS.includes(it.kind) && !FINDING_QUALIFIERS.includes(it.qualifier)) {
      problems.push(`${w}.qualifier ${JSON.stringify(it.qualifier)} 只能是 ${FINDING_QUALIFIERS.join(" / ")}（缺失 / 写错 / 多余）`);
    }
    if (!QUALIFIED_KINDS.includes(it.kind) && it.qualifier !== undefined && !FINDING_QUALIFIERS.includes(it.qualifier)) {
      problems.push(`${w}.qualifier ${JSON.stringify(it.qualifier)} 只能是 ${FINDING_QUALIFIERS.join(" / ")}`);
    }
    // 工具错要说清落在哪一层：四层四个仓四种验法，写不出来多半是还没定位到落点。
    if (it.kind === "tool" && !TOOL_LAYERS.includes(it.layer)) {
      problems.push(`${w}.layer ${JSON.stringify(it.layer)} 只能是 ${TOOL_LAYERS.join(" / ")}（tool 类必填）`);
    }
    if (it.kind !== "tool" && it.layer !== undefined && !TOOL_LAYERS.includes(it.layer)) {
      problems.push(`${w}.layer ${JSON.stringify(it.layer)} 只能是 ${TOOL_LAYERS.join(" / ")}`);
    }
    // tool 类关它的判据是「重放必须变对」——没有可重放的东西，这一条就永远关不掉。
    // （Bettenburg 等对 466 名开发者的调查：复现步骤是开发者最想要的字段，也是最常缺的那个。）
    if (it.kind === "tool" && !nonEmpty(it.repro)) {
      problems.push(`${w}.repro 缺失（tool 类必填：工具名 + 入参 + 期望 vs 实际，一条命令能重放；关它就靠重放变对）`);
    }
    // model 是「前两问都答否」的剩余类，也是归因最不可靠的一类（Who&When Pro：错误类别 macro-F1 ≤ 22.2%、
    // 定位决定性步 ≈ 14%）。所以它得给反证：规矩写在哪一节（证明不是 skill 的锅）+ 指到没照做的那一步。
    if (it.kind === "model" && !nonEmpty(it.rule_ref)) {
      problems.push(`${w}.rule_ref 缺失（model 类必填：规矩写在哪个 skill / 模板的哪一节——查不到就说明这是 skill 缺规矩，不是模型抽风）`);
    }
    // 弃判不是一种缺陷类别，它是「还没定」。记下疑似类别，这一条才留得在对应的漏斗里
    // （Autorubric 的 CANNOT_ASSESS 同理：它与判值并列，但聚合时单独处理）。
    if (it.kind === "unsure") {
      const suspects = FINDING_KINDS.filter((k) => k !== "unsure");
      if (!suspects.includes(it.suspected_kind)) {
        problems.push(`${w}.suspected_kind ${JSON.stringify(it.suspected_kind)} 只能是 ${suspects.join(" / ")}（弃判也要说清疑似谁的锅）`);
      }
    }
    // skill 类的下一步是「改一段话」：不写出原句，改的人还得自己再想一遍——那就不算能走下去的条目
    if (it.kind === "skill" && nonEmpty(it.suggestion) && !/[「“"]/.test(it.suggestion)) {
      problems.push(`${w}.suggestion 没写出要加或要改的原句（skill 类要用「」把那句话引出来）`);
    }
    if (it.kind === "scaffold") problems.push(`${w}.kind scaffold 已撤（2026-09-11）：hooks / 跑批脚本的代码错归 tool，模板 / 提示词的话归 skill`);
    problems.push(...pointerProblems(w, it.pointers, true));
  });
  (Array.isArray(checks) ? checks : []).forEach((c, i) => {
    const w = `findings.checks[${i}]`;
    if (!c || typeof c !== "object") return problems.push(`${w} 必须是对象`);
    if (!FIX_KEY_RE.test(String(c.key ?? ""))) problems.push(`${w}.key ${JSON.stringify(c.key)} 不合规`);
    if (!FIX_CHECK_STATUSES.includes(c.status)) problems.push(`${w}.status 只能是 ${FIX_CHECK_STATUSES.join(" / ")}`);
    // `still_open` 的 kind 必填：`finding_kinds` 只把**带 kind** 的 still_open 算进去，
    // 缺了这条缺口就不进页面的类别筛选——「又撞上了」却在类别里查无此人。
    if (c.status === "still_open" && !FINDING_KINDS.includes(c.kind)) {
      problems.push(`${w}.kind 缺失或不在词表里（${FINDING_KINDS.join(" / ")}）：又撞上的那条要带类别，否则页面上这个缺口不显形`);
    } else if (c.kind !== undefined && !FINDING_KINDS.includes(c.kind)) {
      problems.push(`${w}.kind ${JSON.stringify(c.kind)} 不在词表里（${FINDING_KINDS.join(" / ")}）`);
    }
    problems.push(...pointerProblems(w, c.pointers, c.status === "fixed" || c.status === "still_open"));
    if (keys.has(c.key)) problems.push(`${w}.key ${c.key} 同时出现在 items 里——又撞上的只写 still_open 复验，不要再提一条`);
  });
  return problems;
}

/**
 * 这一条批注里的**弃判**：几条、各疑似谁的锅。
 *
 * 单独算是因为弃判与缺陷不是一回事（Autorubric 的 `CANNOT_ASSESS`、以及 rubric 判题一致性
 * 测量的惯例：弃判率要与一致率分开报）。混在 `finding_kinds` 里看，会让「这轮挖到几条 tool」
 * 和「这轮有几条没敢定」长得一样；而这两件事要采取的动作完全相反——前者去修，后者去核。
 */
export function deriveAbstention(findings) {
  const { items } = normalizeFindings(findings);
  const suspected = [];
  let count = 0;
  for (const it of items) {
    if (it?.kind !== "unsure") continue;
    count += 1;
    const s = it?.suspected_kind;
    if (FINDING_KINDS.includes(s) && s !== "unsure" && !suspected.includes(s)) suspected.push(s);
  }
  return { count, suspected };
}

/**
 * 根因集合 → 三值。**verdict 是推出来的，不是判官填的**：答案纸里的根因不止一条时
 * （`expected_roots` 本来就是数组），「命中一条算不算对」原先没有口径，各判各的。
 * 口径按 owner 2026-09-06 定的那句：找齐 / 找到一部分 / 没找到。
 *
 * 记集合还有第二个好处：**口径以后再改，历史轮次能重算，不用重判**——AIOps 的根因评测
 * （RCAEval 等）用 precision / recall / AC@k 也是同一个理由：先留下命中集合，再谈怎么折算。
 */
export function deriveVerdictFromRoots(roots) {
  const matched = Array.isArray(roots?.matched) ? roots.matched : [];
  const missed = Array.isArray(roots?.missed) ? roots.missed : [];
  if (matched.length === 0) return "wrong";
  return missed.length === 0 ? "correct" : "partial";
}

/**
 * 跟**这道题的材料**对一遍——`validateLabels` 只看得见批注自己，这一层看得见答案纸与轨迹。
 *
 * 两件事：
 * ① 根因集合与答案纸对得上，且 `verdict` 与集合推导的一致（判官把「命中一条」写成 `correct`
 *    是这条 loop 最贵的错：分数是它的主产出之一）；
 * ② **指针能在轨迹里找到**。原先只校验形状（是不是 `{span_id}`），而 TRAIL 的结论是长轨迹下
 *    模型的错误定位准确率极低、部分模型连完整轨迹都读不下——只校验形状等于在鼓励编 span id。
 *    判官常写前 8 位，所以前缀唯一命中也算数；配到两条以上不算（指到「某几步之一」等于没指）。
 *
 * @param {object} labels 一行批注的 labels
 * @param {{ expectedRoots?: string[], spanIds?: string[] }} ctx 这道题的答案纸根因（顺序即编号）与这条 trace 的 span 清单。
 *   **给不出就不查**：蓝区离线包可能没带 trace.json，宁可不拦，也不假装校验过。
 */
export function validateAgainstCase(labels, ctx = {}) {
  const problems = [];
  const f = labels?.findings;
  const roots = (f && typeof f === "object" && !Array.isArray(f)) ? f.roots : undefined;
  const expected = ctx.expectedRoots;

  if (Array.isArray(expected)) {
    if (expected.length === 0) {
      // 无答案纸 = 题坏了（不是「判不出」）：verdict 只能 unknown，也没有集合可记。
      if (labels?.verdict !== undefined && labels.verdict !== "unknown") {
        problems.push(`这道题没有答案纸，verdict 只能是 unknown（现在是 ${JSON.stringify(labels.verdict)}）——没有答案纸就没有「对」这个判断`);
      }
      if (roots !== undefined) problems.push("这道题没有答案纸，findings.roots 不该有值——先回建用例那一步补根因");
    } else if (!roots || typeof roots !== "object" || Array.isArray(roots)) {
      problems.push(`findings.roots 缺失：答案纸有 ${expected.length} 条根因，要按顺序编号划进 matched / missed`);
    } else {
      const matched = Array.isArray(roots.matched) ? roots.matched : [];
      const missed = Array.isArray(roots.missed) ? roots.missed : [];
      const all = [...matched, ...missed];
      const seen = new Set();
      for (const n of all) {
        if (!Number.isInteger(n)) {
          // 最常见的写法错误是把根因原文抄进来。说「越界」会让人往数字上找问题，说不到点子上。
          problems.push(`findings.roots 里的 ${JSON.stringify(n)} 不是编号：这里只写数字（答案纸里根因的出现序号，1..${expected.length}），不写根因原文`);
          continue;
        }
        if (n < 1 || n > expected.length) {
          problems.push(`findings.roots 里的 ${JSON.stringify(n)} 越界：答案纸只有 ${expected.length} 条根因，编号 1..${expected.length}`);
          continue;
        }
        if (seen.has(n)) problems.push(`findings.roots 里第 ${n} 条根因重复：一条根因只能算命中或没命中之一`);
        seen.add(n);
      }
      const absent = [];
      for (let i = 1; i <= expected.length; i++) if (!seen.has(i)) absent.push(i);
      if (absent.length) problems.push(`findings.roots 漏了第 ${absent.join(" / ")} 条根因：答案纸上每一条都要表态（命中或没命中）`);
      // 集合本身有问题时不拿它推 verdict（推出来的没意义），但**要说一句**——
      // 不说的话判官改完集合、下一轮才撞上 verdict 这条，又白烧一次判题会话。
      if (labels?.verdict !== undefined) {
        if (problems.length) {
          problems.push(`verdict 这次没核：上面的根因集合先改对（改完请自查——找齐 correct / 找到一部分 partial / 一条没找到 wrong）`);
        } else {
          const derived = deriveVerdictFromRoots({ matched, missed });
          if (labels.verdict !== derived) {
            problems.push(`verdict ${JSON.stringify(labels.verdict)} 与根因集合对不上：命中 ${matched.length}/${expected.length} 条，按口径是 ${derived}`);
          }
        }
      }
    }
  }

  const spanIds = Array.isArray(ctx.spanIds) ? ctx.spanIds.filter(Boolean).map(String) : [];
  if (spanIds.length) {
    const { items, checks } = normalizeFindings(f);
    for (const [where, list] of [["items", items], ["checks", checks]]) {
      list.forEach((entry, i) => {
        for (const pt of Array.isArray(entry?.pointers) ? entry.pointers : []) {
          const id = typeof pt?.span_id === "string" ? pt.span_id.trim() : "";
          if (!id) continue;
          if (spanIds.includes(id)) continue;
          const hits = spanIds.filter((s) => s.startsWith(id));
          if (hits.length === 0) problems.push(`findings.${where}[${i}].pointers 的 span ${id} 不在这条 trace 里——指不到就说明证据还没找到，写进 summary，别编一个`);
          else if (hits.length > 1) problems.push(`findings.${where}[${i}].pointers 的 span ${id} 配到 ${hits.length} 条，指到「某几步之一」等于没指：写全一点`);
        }
      });
    }
  }
  return problems;
}

/**
 * `finding_kinds` = items 的 kind ∪ still_open 复验的 kind，去重、按词表顺序。
 * **算出来的，判题方不写**——写了也被这个覆盖（军规 3：能推导的值不许再钉一份）。
 */
export function deriveFindingKinds(findings) {
  const f = normalizeFindings(findings);
  const present = new Set();
  for (const it of f.items) if (FINDING_KINDS.includes(it?.kind)) present.add(it.kind);
  for (const c of f.checks) if (c?.status === "still_open" && FINDING_KINDS.includes(c?.kind)) present.add(c.kind);
  return FINDING_KINDS.filter((k) => present.has(k));
}

/**
 * 读侧把一条批注里的 `findings` 摊成 `{items, checks}`（双重编码也认）。只认新形状：
 * 2026-09-11 改版时活栈的旧判题已按新口径重判，库里不再有旧形状（web `llmobs-fix-items` 同一条规则）。
 */
export function normalizeFindings(value) {
  let v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return { items: [], checks: [] }; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { items: [], checks: [] };
  return { items: Array.isArray(v.items) ? v.items : [], checks: Array.isArray(v.checks) ? v.checks : [] };
}

/**
 * 一道题之前几轮的判题，交给判下一轮的判题方做复验的材料（`prior-judgments.json` / `case-history.mjs`）。
 *
 * **只给原料，不替判题方算「哪些还没关」**：规则就一句（最后一次有效复验不是 fixed、或 fixed 之后又被提出来，
 * 都算没关），写在 skill 里；web 读侧另有一份算状态的实现给人看。这里多算一遍就是第三份副本。
 * 修复标记（`fix_marks`）也原样带上：修的人说「改了」，判题方复验时该走到那条路去验。
 *
 * @param {{ experiment: {id:string,name:string,created_at:string}, traceId: string }[]} runs 这道题**之前**的运行
 * @param {Map<string, any[]>} interactionsByTrace `findAllAnnotationsByContent` 的返回
 */
export function priorJudgments(runs, interactionsByTrace) {
  return [...runs]
    .sort((a, b) => String(a.experiment.created_at).localeCompare(String(b.experiment.created_at)))
    .map(({ experiment, traceId }) => {
      const labels = new Map();
      for (const it of interactionsByTrace.get(traceId) ?? []) {
        for (const an of it.annotations ?? []) if (an.label && !labels.has(an.label)) labels.set(an.label, an.value);
      }
      if (!labels.size) return { round: experiment.name, round_id: experiment.id, created_at: experiment.created_at, trace_id: traceId, judged: false };
      const { items, checks } = normalizeFindings(labels.get("findings"));
      let marks = labels.get("fix_marks") ?? {};
      if (typeof marks === "string") { try { marks = JSON.parse(marks); } catch { marks = {}; } }
      return {
        round: experiment.name,
        round_id: experiment.id,
        created_at: experiment.created_at,
        trace_id: traceId,
        judged: true,
        verdict: labels.get("verdict") ?? null,
        evidence: labels.get("evidence") ?? null,
        items,
        checks,
        fix_marks: marks && typeof marks === "object" && !Array.isArray(marks) ? marks : {},
      };
    });
}

/** label 值的形状校验（只判形状，不判判得对不对）。 */
export function validateLabels(labels) {
  const problems = [];
  if (labels.verdict !== undefined && !VERDICTS.includes(labels.verdict)) {
    problems.push(`verdict 只能是 ${VERDICTS.join(" / ")}`);
  }
  if (labels.evidence !== undefined && !EVIDENCE_VALUES.includes(labels.evidence)) {
    problems.push(`evidence 只能是 ${EVIDENCE_VALUES.join(" / ")}`);
  }
  if (labels.findings !== undefined) problems.push(...validateFindings(labels.findings));
  if (labels.summary !== undefined && typeof labels.summary !== "string") problems.push("summary 必须是字符串");
  if (labels.summary !== undefined && typeof labels.summary === "string" && labels.summary.length > 600) {
    problems.push(`summary 太长（${labels.summary.length} 字，上限 600）——总评三句以内，细节写进各条改进点`);
  }
  for (const k of ["finding_kinds", "fix_marks"]) {
    if (labels[k] !== undefined) problems.push(`${k} 不由判题方写（finding_kinds 由 import 从 findings 算出；fix_marks 由 fix-mark.mjs 写）`);
  }
  for (const k of ["trustworthy", "needs_fix", "lucky_guess", "attribution_tags", "attribution"]) {
    if (labels[k] !== undefined) problems.push(`${k} 是 2026-09-11 之前的旧词表——结论看 verdict，证据看 evidence，其余都是 findings 里一条条的改进点`);
  }
  const unknown = Object.keys(labels).filter((k) => !LABEL_SCHEMA.some((l) => l.label === k) && !["trustworthy", "needs_fix", "lucky_guess", "attribution_tags", "attribution"].includes(k));
  if (unknown.length) problems.push(`未知 label：${unknown.join(", ")}（词表见 §7.1）`);
  return problems;
}

/**
 * 一行 labels → POST annotations 的条目。label id **只从 manifest 取**（PUT labels 不带原 id
 * 重发会把该队列已有的 annotation 级联删光——这是取证到的坑，所以 id 是包的一等资产）。
 * `finding_kinds` 在这里从 findings 算出来一起发：判题方写的那份（如果有）被覆盖。
 */
export function annotationPayload({ interactionId, labels, labelIds, annotator }) {
  const withKinds = labels.findings !== undefined ? { ...labels, finding_kinds: deriveFindingKinds(labels.findings) } : labels;
  const out = [];
  for (const { label } of LABEL_SCHEMA) {
    if (withKinds[label] === undefined) continue;
    const labelId = labelIds[label];
    if (!labelId) throw new Error(`manifest 里没有 label ${label} 的 id——包过期了，重跑 export`);
    out.push({
      interaction_id: interactionId,
      label_id: labelId,
      value: withKinds[label],
      ...(annotator ? { annotator } : {}),
    });
  }
  return out;
}
