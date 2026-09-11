// judge-package.mjs — 判题包的**纯函数**层（形状、渲染、解析），零 I/O、零 fetch。
//
// 单源关系（军规 3）：
//   · label 词表与取值形状 = dbdog-web `docs/design/llmobs-diag-flywheel.md` §7.1（D4 落形）；
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
 * label schema（§7.1 七条，逐字）。`value_type` 走 server 的枚举
 * （boolean / categorical / string / score / json），投影时直接映射成 experiment metric 的 metric_type。
 * `options` 只有枚举型才发：nil = 不是枚举，`[]` = 是枚举但没配选项——两档不同，别混。
 */
export const LABEL_SCHEMA = [
  { label: "trustworthy", value_type: "boolean", display: "可信（这条 trace 能不能当参考/训练）" },
  { label: "needs_fix", value_type: "boolean", display: "要修 dbdog" },
  { label: "verdict", value_type: "categorical", options: ["correct", "partial", "wrong"], display: "结论 对/部分/错" },
  { label: "lucky_guess", value_type: "boolean", display: "蒙对" },
  { label: "attribution_tags", value_type: "json", display: "归因标签（扁平，用来过滤）" },
  { label: "attribution", value_type: "json", display: "归因与建议" },
  { label: "summary", value_type: "string", display: "总评" },
];

/** `attribution_tags` 的词表（前三 = dbdog 侧，中三 = agent 侧，末二 = 脚手架 / 题本身）。 */
export const ATTRIBUTION_TAGS = [
  "no_tool", "empty_or_error", "obtained_mismatch",
  "hypothesis_missing", "tool_misuse", "reasoning_error",
  "scaffold", "case_issue",
];

export const VERDICTS = ["correct", "partial", "wrong"];

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
        lines.push(`${pad}  - 调用：${node.calls.map((c) => `#${c.seq} \`${c.tool}\``).join("、")}`);
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
  lines.push("| # | 工具 | 假设 | 状态 | 意图 |");
  lines.push("|---|---|---|---|---|");
  const idOf = new Map();
  for (const node of nodes.values()) for (const c of node.calls) idOf.set(c.seq, node.id);
  for (const c of calls) {
    lines.push(`| ${c.seq} | \`${c.tool}\` | ${idOf.get(c.seq) ? `[${idOf.get(c.seq)}]` : "未挂"} | ${c.status || "—"} | ${clip(c.intent, 160) || "—"} |`);
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
    lines.push("## 期望根因", "", ...e.expected_roots.map((r) => `- ${r}`), "");
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

/* ── 待修条目与复验（飞轮设计 §13.3：「每次改哪里拆成一条一条」「修没修好看实际效果，不依赖人的反馈」） ── */

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
  if (required && list.length === 0) out.push(`${where}.pointers 为空（归因必须指到 span_id 或探针行）`);
  for (const pt of list) {
    if (!pt || typeof pt !== "object" || (!pt.span_id && !pt.probe)) {
      out.push(`${where}.pointers 里的 ${JSON.stringify(pt)} 既不是 {span_id} 也不是 {probe}`);
    }
  }
  return out;
}

/**
 * `attribution` 的形状：`{ items: [{key, fix_where, suggestion, pointers}], checks: [{key, status, pointers, note}] }`。
 * - items：这一轮新发现的待修，一条一个落点；
 * - checks：这道题之前几轮提过、还没关的，逐条复验（`fixed` / `still_open` 必须带证据指针）。
 * 旧形状（整段 `fix_where` 塞在顶层）直接拒：一段里塞五处改动，数不出哪处修了。
 */
export function validateAttribution(a, needsFix) {
  const problems = [];
  if (!a || typeof a !== "object" || Array.isArray(a)) return ["attribution 必须是对象"];
  if ("fix_where" in a && !("items" in a)) {
    return ["attribution 是旧形状（顶层一段 fix_where）——改成 items[] 一条一个落点、checks[] 复验之前几轮提过的（skill「待修条目」一节）"];
  }
  const items = a.items ?? [];
  const checks = a.checks ?? [];
  if (!Array.isArray(items)) problems.push("attribution.items 必须是数组");
  if (!Array.isArray(checks)) problems.push("attribution.checks 必须是数组");
  const keys = new Set();
  (Array.isArray(items) ? items : []).forEach((it, i) => {
    const w = `attribution.items[${i}]`;
    if (!it || typeof it !== "object") return problems.push(`${w} 必须是对象`);
    if (!FIX_KEY_RE.test(String(it.key ?? ""))) problems.push(`${w}.key ${JSON.stringify(it.key)} 不合规（小写 ascii，<层>.<模块>.<缺什么>）`);
    else if (keys.has(it.key)) problems.push(`${w}.key ${it.key} 重复——一个缺口只提一条`);
    else keys.add(it.key);
    if (!String(it.fix_where ?? "").trim()) problems.push(`${w}.fix_where 缺失（建议必须说改哪里，且只写一处）`);
    problems.push(...pointerProblems(w, it.pointers, true));
  });
  let stillOpen = 0;
  (Array.isArray(checks) ? checks : []).forEach((c, i) => {
    const w = `attribution.checks[${i}]`;
    if (!c || typeof c !== "object") return problems.push(`${w} 必须是对象`);
    if (!FIX_KEY_RE.test(String(c.key ?? ""))) problems.push(`${w}.key ${JSON.stringify(c.key)} 不合规`);
    if (!FIX_CHECK_STATUSES.includes(c.status)) problems.push(`${w}.status 只能是 ${FIX_CHECK_STATUSES.join(" / ")}`);
    if (c.status === "still_open") stillOpen += 1;
    problems.push(...pointerProblems(w, c.pointers, c.status === "fixed" || c.status === "still_open"));
    if (keys.has(c.key)) problems.push(`${w}.key ${c.key} 同时出现在 items 里——又撞上的只写 still_open 复验，不要再提一条`);
  });
  // 与 needs_fix 自洽：判了要修却一条待修都没有（也没有又撞上的），或判了不用修却提了待修——必有一项判错了
  const hasWork = keys.size > 0 || stillOpen > 0;
  if (needsFix === true && !hasWork) problems.push("needs_fix=true 却没有一条待修（items 为空，也没有 still_open 的复验）");
  if (needsFix === false && keys.size > 0) problems.push("needs_fix=false 却提了待修条目");
  return problems;
}

/**
 * 读侧把一条批注里的 `attribution` 摊成 `{items, checks}`。旧形状（顶层一段 fix_where，09-10 之前的判题）
 * 当成**一条**，key 记成 `legacy.<trace 前 8 位>`——web 读侧同一条规则（dbdog-web 的 llmobs-fix-items），
 * 判下一轮时就能拿这个 key 复验它。
 */
export function normalizeAttribution(value, traceId) {
  let v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return { items: [], checks: [] }; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { items: [], checks: [] };
  if (Array.isArray(v.items) || Array.isArray(v.checks)) {
    return { items: Array.isArray(v.items) ? v.items : [], checks: Array.isArray(v.checks) ? v.checks : [] };
  }
  if (typeof v.fix_where === "string" && v.fix_where.trim()) {
    return {
      items: [{ key: `legacy.${String(traceId).slice(0, 8)}`, fix_where: v.fix_where, suggestion: v.suggestion ?? "", pointers: v.pointers ?? [] }],
      checks: [],
    };
  }
  return { items: [], checks: [] };
}

/**
 * 一道题之前几轮的判题，交给判下一轮的判题方做复验的材料（`prior-judgments.json` / `case-history.mjs`）。
 *
 * **只给原料，不替判题方算「哪些还没关」**：规则就一句（最后一次有效复验不是 fixed、或 fixed 之后又被提出来，
 * 都算没关），写在 skill 里；web 读侧另有一份算状态的实现给人看。这里多算一遍就是第三份副本。
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
      const { items, checks } = normalizeAttribution(labels.get("attribution"), traceId);
      return {
        round: experiment.name,
        round_id: experiment.id,
        created_at: experiment.created_at,
        trace_id: traceId,
        judged: true,
        verdict: labels.get("verdict") ?? null,
        needs_fix: labels.get("needs_fix") ?? null,
        items,
        checks,
      };
    });
}

/** label 值的形状校验（只判形状，不判判得对不对）。 */
export function validateLabels(labels) {
  const problems = [];
  for (const key of ["trustworthy", "needs_fix", "lucky_guess"]) {
    if (labels[key] !== undefined && typeof labels[key] !== "boolean") problems.push(`${key} 必须是布尔`);
  }
  if (labels.verdict !== undefined && !VERDICTS.includes(labels.verdict)) {
    problems.push(`verdict 只能是 ${VERDICTS.join(" / ")}`);
  }
  if (labels.attribution_tags !== undefined) {
    if (!Array.isArray(labels.attribution_tags)) problems.push("attribution_tags 必须是字符串数组");
    else {
      for (const t of labels.attribution_tags) {
        if (!ATTRIBUTION_TAGS.includes(t)) problems.push(`attribution_tags 里的 ${JSON.stringify(t)} 不在词表`);
      }
    }
  }
  if (labels.attribution !== undefined) problems.push(...validateAttribution(labels.attribution, labels.needs_fix));
  if (labels.summary !== undefined && typeof labels.summary !== "string") problems.push("summary 必须是字符串");
  const unknown = Object.keys(labels).filter((k) => !LABEL_SCHEMA.some((l) => l.label === k));
  if (unknown.length) problems.push(`未知 label：${unknown.join(", ")}（词表见 §7.1）`);
  return problems;
}

/**
 * 一行 labels → POST annotations 的条目。label id **只从 manifest 取**（PUT labels 不带原 id
 * 重发会把该队列已有的 annotation 级联删光——这是取证到的坑，所以 id 是包的一等资产）。
 */
export function annotationPayload({ interactionId, labels, labelIds, annotator }) {
  const out = [];
  for (const { label } of LABEL_SCHEMA) {
    if (labels[label] === undefined) continue;
    const labelId = labelIds[label];
    if (!labelId) throw new Error(`manifest 里没有 label ${label} 的 id——包过期了，重跑 export`);
    out.push({
      interaction_id: interactionId,
      label_id: labelId,
      value: labels[label],
      ...(annotator ? { annotator } : {}),
    });
  }
  return out;
}
