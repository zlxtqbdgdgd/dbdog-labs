// hypothesis-graph.mjs — hook span → 正向假设图（假设↔假设、假设↔工具、收口）。零模型，纯 Node 标准库。
//
// 2026-09-10 从 skills/span-graph/scripts/from_spans.py 移植过来并成为**唯一实现**：
// hook 在 SessionEnd 用它自动出图（graph-worker.mjs），span-graph skill 的入口
// （skills/span-graph/scripts/from_spans.mjs）也只是调用本文件。解析走 hypothesis.mjs，
// 英文键为准、中文键兼容，与 dbdog-web/src/lib/llmobs-hypothesis-tree.ts 同一套正则。
//
// 输入：spans.jsonl（每行一个 span）/ server 导出 {"spans":[...]} / JSON 数组 / 含 spans.jsonl 的目录。
// 正文「Propose [H2] …」事件：hook 只采原文不做语义解析，父节点文本从 llm/agent span 的正文提——
// 本地 spans.jsonl 全量字段 output_local / thinking_local 优先（读侧口径 x_local ?? x），server 导出只有截断后的 output。
import fs from "node:fs";
import path from "node:path";
import {
  HEAD,
  ID,
  TYPE,
  VERDICT,
  VERDICT_WORDS,
  hasFieldsWithoutHead,
  normalizeHypothesisText,
  parentOfId,
  parseIntent,
} from "./hypothesis.mjs";

const TYPE_ZH = { confirm: "现象确认", cause: "根因" };
const VERDICT_ZH = { falsified: "证伪", confirmed: "证实", open: "未决" };
// 正文里显式提出：英文 Propose / 中文 提出
const PROPOSE = new RegExp(`(?:Propose|提出)\\s*\\[\\s*(${ID})`, "gi");
// 结论末尾的收口小节：investigate 报告把它放在 How do we know 结尾（"hypothesis ledger"），历史报告是「## 假设收口」
const CLOSING_HEAD = /^\s*#{0,6}\s*\**\s*(?:hypothesis ledger|假设收口)/i;
const CLOSING_LINE = new RegExp(`^\\s*[-*|]?\\s*\\**\\s*(${ID})\\s*\\**\\s*[:：]?\\s*(${VERDICT_WORDS})`, "i");
// 复述约定的行、模板/示例行整行跳过（否则示例编号会被当成提出）
const PROTOCOL_RESTATE = /书写约定|telemetry\.intent|格式固定|in the shape the tool schema/i;
const RESTATE_LINE = /示例|for example|H<编号|假设=<|判据=<|claim=<|expect=<|\[H\d[^\]]*\]\s*(?:假设|claim)=/i;

function verdictOf(word) {
  return VERDICT[word.toLowerCase()] ?? VERDICT[word];
}

function spanIntent(s) {
  return s.intent ?? s.tags?.intent;
}

function typeFromTag(raw) {
  if (raw === "confirm" || raw === "cause") return raw;
  return raw ? TYPE[String(raw).toLowerCase()] ?? TYPE[raw] : undefined;
}

/** tags 优先（hook 已解析过），否则解析 intent 原文。 */
export function parsedFromSpan(s) {
  const tags = s.tags ?? {};
  const hid = String(tags.hypothesis_id ?? "").trim();
  if (hid) {
    // 标签上没有父时按**点分前缀**推（H4.1 → H4）。标签是钩子盖的，老 span 补不回来，
    // 而实测模型几乎不写 `<父`（一轮 460 次点分调用 0 命中），只信标签就会满图孤儿。
    // 推出来的父若从没被提出过，走与显式 `<父` 同一条路：ensure 补占位并标 declared:false，
    // 由 summary.undeclared 计数暴露——不新造一份计数（军规 3）。
    const out = { id: hid, parent: parentOfId(hid, String(tags.parent_hypothesis_id ?? "").trim() || undefined) };
    const t = typeFromTag(tags.hypothesis_type);
    if (t) out.type = t;
    if (tags.hypothesis) out.text = tags.hypothesis;
    if (tags.expect) out.expect = tags.expect;
    if (tags.hypothesis_basis) out.basis = tags.hypothesis_basis;
    if (tags.code_ref) out.codeRef = tags.code_ref;
    if (tags.resolve) {
      try {
        const rs = JSON.parse(tags.resolve);
        if (Array.isArray(rs) && rs.length) out.resolve = rs;
      } catch {
        /* 脏 tag 忽略 */
      }
    }
    // intent= 只在 intent 原文里，tags 不带
    const p = parseIntent(spanIntent(s));
    if (p?.intent) out.purpose = p.intent;
    return out;
  }
  const p = parseIntent(spanIntent(s));
  if (!p) return null;
  const { intent: purpose, ...rest } = p;
  return purpose ? { ...rest, purpose } : rest;
}

/** llm/agent span 可扫的正文：[来源名, 文本]。本地全量字段优先，server 导出退回截断值。 */
export function proseFields(s) {
  const out = [];
  const body = typeof s.output_local === "string" ? s.output_local : s.output;
  if (typeof body === "string" && body.trim()) out.push(["output", body]);
  if (typeof s.thinking_local === "string" && s.thinking_local.trim()) out.push(["thinking", s.thinking_local]);
  return out;
}

/** 结论正文收口小节里的「H1 refuted — 依据」→ [[hid, verdict]]。只认该小节之内、到下一个标题为止。 */
export function scanClosing(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const out = [];
  let inside = false;
  for (const line of normalizeHypothesisText(text).split("\n")) {
    if (CLOSING_HEAD.test(line)) {
      inside = true;
      continue;
    }
    if (inside && /^\s*#{1,6}\s/.test(line)) break;
    if (inside) {
      const m = CLOSING_LINE.exec(line);
      if (m) out.push([m[1], verdictOf(m[2])]);
    }
  }
  return out;
}

/** 正文里的「Propose [H2] type=…; claim=…」→ [[hid, parsed]]，按出现顺序。 */
export function scanProposals(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const norm = normalizeHypothesisText(text)
    .split("\n")
    .filter((l) => !(PROTOCOL_RESTATE.test(l) || RESTATE_LINE.test(l)))
    .join("\n");
  const found = [];
  for (const m of norm.matchAll(PROPOSE)) {
    const lineEnd = norm.indexOf("\n", m.index + m[0].length);
    const bracket = norm.indexOf("[", m.index);
    const body = norm.slice(bracket, lineEnd === -1 ? norm.length : lineEnd).trim();
    const p = parseIntent(body);
    if (p) found.push([m[1], p]);
  }
  return found;
}

function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 脏行跳过 */
    }
  }
  return out;
}

export function resolveInput(p) {
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const cand = path.join(p, "spans.jsonl");
    if (fs.existsSync(cand)) return cand;
    const jsonls = fs.readdirSync(p).filter((f) => f.endsWith(".jsonl")).sort();
    if (jsonls.length === 1) return path.join(p, jsonls[0]);
    throw new Error(`目录里没有 spans.jsonl：${p}`);
  }
  if (!fs.existsSync(p)) throw new Error(`找不到：${p}`);
  return p;
}

export function loadSpans(file, { session, trace } = {}) {
  const head = fs.readFileSync(file, "utf8").slice(0, 4096);
  let spans;
  if (head.trimStart().startsWith("{") && head.slice(0, 2000).includes('"spans"') && !head.includes("\n{")) {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    spans = d.spans ?? d.data ?? [];
  } else if (head.trimStart().startsWith("[")) {
    spans = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    spans = readJsonl(file);
  }
  return dedupe(spans, { session, trace });
}

/** 同 span_id 后写赢（hook 重发 root/agent span）；可按 session / trace 筛。 */
export function dedupe(spans, { session, trace } = {}) {
  const last = new Map();
  for (const s of spans) {
    if (!s || typeof s !== "object" || !("span_id" in s)) continue;
    if (session && s.session_id !== session) continue;
    if (trace && s.trace_id !== trace) continue;
    last.set(s.span_id, s);
  }
  return [...last.values()];
}

function ensure(nodes, hid) {
  if (!nodes.has(hid)) {
    nodes.set(hid, {
      id: hid,
      parent: null,
      type: null,
      text: null,
      expect: null,
      basis: null,
      code_ref: null,
      verdict: "open",
      declared: false,
      first_seq: null,
      closed_by: null,
      proposed_in: null,
      calls: [],
    });
  }
  return nodes.get(hid);
}

function fill(n, p) {
  if (p.parent && !n.parent) n.parent = p.parent;
  if (p.type && !n.type) n.type = p.type;
  if (p.text && !n.text) n.text = p.text;
  if (p.expect && !n.expect) n.expect = p.expect;
  if (p.basis && !n.basis) n.basis = p.basis;
  if (p.codeRef && !n.code_ref) n.code_ref = p.codeRef;
}

function sortKey(s) {
  const ts = s.ts ?? s.ts_ms ?? 0;
  const k = typeof ts === "number" ? ts.toFixed(3).padStart(20, "0") : String(ts);
  return `${k} ${s.span_id ?? ""}`;
}

/**
 * 只有 dbdog（MCP）工具调用进图（2026-09-10，owner：本地 Grep/Glob/Read 在假设树里没用，还把 seq 撑成「H1 上来就是第 23 步」）。
 * 判据不是白名单：hook 落盘的 MCP 调用 name 已剥掉 mcp__<server>__ 前缀、server 记在 tags.mcp_server（synthesize.mjs）；
 * server 导出 / 别的采集源可能保留 mcp__ 前缀。两者都不满足的一律按本地工具排除。
 */
export function isMcpTool(s) {
  return String(s.name ?? "").startsWith("mcp__") || Boolean(s.tags?.mcp_server);
}

function agentLabel(s) {
  const aid = s.tags?.agent_id;
  return aid ? String(aid).slice(0, 8) : "main";
}

function hidKey(h) {
  return h.replace(/^H/, "").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
}

function compareHid(a, b) {
  const ka = hidKey(a.id);
  const kb = hidKey(b.id);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    if (ka[i] === undefined) return -1;
    if (kb[i] === undefined) return 1;
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  }
  return 0;
}

export function build(spans) {
  const nodes = new Map();
  const toolEdges = [];
  const resolveEdges = [];
  const unattached = [];
  const traces = new Set();
  const ordered = spans.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  let seq = 0; // 只数 dbdog（MCP）调用，从 1 起连续
  let toolCallsAll = 0;
  const localExcluded = {};
  for (const s of ordered) {
    if (s.trace_id) traces.add(s.trace_id);
    const p = parsedFromSpan(s);
    if (s.kind !== "tool") {
      if (p) fill(ensure(nodes, p.id), p);
      for (const [source, text] of proseFields(s)) {
        // 正文「提出」事件：最早一次为准（span 已按 ts 排序；同一 hid 只记第一次）
        for (const [hid, pp] of scanProposals(text)) {
          const n = ensure(nodes, hid);
          if (n.proposed_in === null) {
            n.proposed_in = { span_id: s.span_id, in: source };
            fill(n, pp);
          }
        }
        // 正文收口：工具调用上的 close= 优先，正文只补没关过的
        for (const [hid, verdict] of scanClosing(text)) {
          const n = ensure(nodes, hid);
          if (n.verdict === "open" || n.closed_by?.in === "prose") {
            n.verdict = verdict;
            n.closed_by = { from: "正文收口", in: "prose", span_id: s.span_id };
            // 同一段结论会同时出现在 root span 与末轮 llm span 的 output 里，只记一条
            if (!resolveEdges.some((e) => e.from === "正文收口" && e.to === hid && e.verdict === verdict)) {
              resolveEdges.push({ kind: "resolve", from: "正文收口", to: hid, verdict, span_id: s.span_id });
            }
          }
        }
      }
      continue;
    }
    toolCallsAll += 1;
    if (!isMcpTool(s)) {
      // 本地工具整体排除：不进工具边、不进未挂列表、不占 seq；只在 summary 里计次，不静默丢
      const name = String(s.name ?? "");
      localExcluded[name] = (localExcluded[name] ?? 0) + 1;
      continue;
    }
    seq += 1;
    const tool = String(s.name ?? "").replace("mcp__dbdog__", "");
    const intent = spanIntent(s);
    const call = {
      seq,
      span_id: s.span_id,
      tool,
      ts: s.ts,
      agent: agentLabel(s),
      status: s.status,
      intent,
      purpose: p?.purpose ?? null,
      // 入参与返回（2026-09-10，owner：看不到入参和结果判断不了工具对不对）：读侧口径 x_local ?? x，JSON 全量
      input: typeof s.input_local === "string" ? s.input_local : (s.input ?? null),
      output: typeof s.output_local === "string" ? s.output_local : (s.output ?? null),
    };
    if (!p) {
      call.reason = hasFieldsWithoutHead(intent) ? "intent_without_head" : "no_intent";
      unattached.push(call);
      continue;
    }
    const n = ensure(nodes, p.id);
    n.declared = true;
    if (n.first_seq === null) n.first_seq = seq;
    fill(n, p);
    for (const r of p.resolve ?? []) {
      const c = ensure(nodes, r.id);
      c.verdict = r.verdict;
      c.closed_by = { from: p.id, seq, span_id: s.span_id };
      resolveEdges.push({ kind: "resolve", from: p.id, to: r.id, verdict: r.verdict, span_id: s.span_id });
    }
    n.calls.push(call);
    toolEdges.push({ kind: "tool", from: p.id, tool, seq, span_id: s.span_id, intent });
  }

  // 父节点不存在时**不补占位**（owner 2026-09-10 定：不留兜底）。
  // 那说明模型从一个自己从没提出过的假设往下派生（实测：只有 H4.1…H4.5，没有裸 H4），
  // 是真缺陷。凭空造一个空节点会把「这一支是断的」盖掉，从此没人知道。
  // 如实留成孤儿，由 summary.orphan_hypotheses 计数暴露，修在约定那一侧。
  const parentEdges = [];
  const seen = new Set();
  let orphans = 0;
  for (const n of [...nodes.values()]) {
    if (!n.parent) continue;
    if (!nodes.has(n.parent)) {
      orphans += 1;
      n.parent = undefined;      // 不留指向不存在节点的边
      continue;
    }
    const key = `${n.parent} ${n.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      parentEdges.push({ kind: "parent", from: n.parent, to: n.id });
    }
  }

  const nodeList = [...nodes.values()].sort(compareHid);
  // covered_through（2026-09-10）：图覆盖到的事件时间上界 = 参与出图的 span 里最晚的 ts 原值
  // （不取 now——那是出图时刻，不是覆盖面）。server 拿它跟 span 水位 max(ts) 比判「图落后于 span」；
  // 按入库时间比会一律 stale：SessionEnd 先出图后上报，图必然先于尾部 span 入库，可图的内容是全的。
  // ordered 已按 ts 排序、没 ts 的排在最前，所以取最后一条**有 ts** 的；一条都没有就是 null。
  const withTs = ordered.filter((s) => s.ts != null);
  const coveredThrough = withTs.length ? withTs[withTs.length - 1].ts : null;
  return {
    trace_ids: [...traces].sort(),
    span_count: spans.length,
    covered_through: coveredThrough,
    tool_call_count: seq,
    tool_call_count_all: toolCallsAll,
    nodes: nodeList,
    edges: [...parentEdges, ...toolEdges, ...resolveEdges],
    unattached_tools: unattached,
    summary: {
      hypotheses: nodeList.length,
      undeclared: nodeList.filter((n) => !n.declared).length,
      parent_edges: parentEdges.length,
      // 父编号（点分推出的或显式写的）指向的节点从没被提出过的数量。0 才算这棵树是连的。
      orphan_hypotheses: orphans,
      tool_edges: toolEdges.length,
      resolve_edges: resolveEdges.length,
      unattached_tools: unattached.length,
      unattached_intent_without_head: unattached.filter((u) => u.reason === "intent_without_head").length,
      // 2026-09-10：被排除的本地工具调用计次（次数 + 按名分布，name 原样）
      local_tools_excluded: toolCallsAll - seq,
      local_tools_excluded_by_name: localExcluded,
      proposed_in_prose: nodeList.filter((n) => n.proposed_in).length,
      // 2026-09-10：源码来的假设有没有现场证据——反向门的机械判定
      source_hypotheses: nodeList.filter((n) => n.basis === "source").length,
      source_without_evidence: nodeList.filter((n) => n.basis === "source" && n.calls.length === 0).length,
    },
  };
}

/** markdown 里的节选长度；报错的调用返回全文（上限 4000）。全量在 forward-path.json。 */
const EXCERPT = Number(process.env.DBDOG_OBS_GRAPH_EXCERPT_CHARS) > 0 ? Number(process.env.DBDOG_OBS_GRAPH_EXCERPT_CHARS) : 600;
const ERROR_FULL = 4000;

function excerpt(text, limit) {
  const t = String(text ?? "").replace(/\r?\n/g, " ⏎ ").trim();
  if (!t) return "";
  if (t.length <= limit) return `\`${t.replace(/`/g, "'")}\``;
  return `\`${t.slice(0, limit).replace(/`/g, "'")}\`…（共 ${t.length} 字，全文见 forward-path.json）`;
}

function shortTs(ts) {
  if (typeof ts === "string" && ts.includes("T")) return ts.slice(11, 19);
  return ts == null ? "" : String(ts);
}

function localExcludedNote(s) {
  const byName = Object.entries(s.local_tools_excluded_by_name ?? {}).sort((a, b) => b[1] - a[1]);
  const n = s.local_tools_excluded ?? 0;
  if (!n) return "本地工具调用 0 次";
  return `本地工具调用 ${n} 次未计入（${byName.map(([k, v]) => `${k} ${v}`).join(" / ")}）`;
}

export function renderMd(g) {
  const s = g.summary;
  const lines = [
    "# 正向假设图（从 hook span 重构）",
    "",
    `- trace：\`${g.trace_ids.join(", ") || "—"}\``,
    `- span ${g.span_count} 条，其中工具调用 ${g.tool_call_count_all ?? g.tool_call_count} 次；dbdog（MCP）调用 ${g.tool_call_count} 次进图，${localExcludedNote(s)}`,
    `- 假设 ${s.hypotheses} 个（其中 ${s.undeclared} 个只被引用、未在调用上声明）· ` +
      `假设↔假设边 ${s.parent_edges} · 假设↔工具边 ${s.tool_edges} · 收口边 ${s.resolve_edges} · ` +
      `未挂到假设的工具调用 ${s.unattached_tools}（其中 ${s.unattached_intent_without_head} 次写了字段但 intent 不带 [H..] 头）· ` +
      `正文提出 ${s.proposed_in_prose ?? 0}` +
      (s.source_hypotheses ? ` · 源码来源的假设 ${s.source_hypotheses}（其中 ${s.source_without_evidence} 个没有任何现场证据调用）` : ""),
    "",
    "读法：节点 = 假设；缩进 = `[H2.1<H2]` 声明的父子关系；每个假设下面的表 = 该假设名下的工具调用（seq 是 dbdog（MCP）工具调用的序号，从 1 起连续，可据此看先后；Grep/Read/Bash 等本地工具不计、不进图）。",
    "",
    "## 假设树（假设↔假设、假设↔工具）",
    "",
  ];
  const kids = new Map();
  for (const e of g.edges) {
    if (e.kind === "parent") {
      if (!kids.has(e.from)) kids.set(e.from, []);
      kids.get(e.from).push(e.to);
    }
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const roots = g.nodes.filter((n) => !n.parent || !byId.has(n.parent));

  const nodeLine = (n, depth) => {
    const typ = TYPE_ZH[n.type] ?? "类型未写";
    const ver = VERDICT_ZH[n.verdict] ?? n.verdict;
    const head = "#".repeat(Math.min(3 + depth, 6));
    let title = `${head} ${n.id} · ${typ} · ${ver}`;
    if (n.closed_by) {
      title += n.closed_by.seq
        ? `（由 ${n.closed_by.from} 在 seq ${n.closed_by.seq} 关闭）`
        : "（结论正文「假设收口」里关闭，工具调用上没写 close=）";
    }
    lines.push(title, "");
    if (n.proposed_in) {
      const src = n.proposed_in.in === "thinking" ? "思考块" : "正文";
      lines.push(`- 提出于${src}（span \`${n.proposed_in.span_id}\`）：${n.text ?? "（未写 claim=）"}`);
      if (n.expect) lines.push(`- 判据：${n.expect}`);
      if (!n.declared) lines.push(`- 未声明：没有任何工具调用以 \`[${n.id}]\` 开头（只在正文提出、由子假设取证）。`);
      else lines.push(`- 首次出现：seq ${n.first_seq}`);
    } else if (!n.declared) {
      lines.push(
        `- 未声明：没有任何工具调用以 \`[${n.id}]\` 开头，只在子假设或收口里被引用，` +
          "正文里也没有「Propose [H..]」行（server 导出的 output 截断过，本地 spans.jsonl 才是全量）。",
      );
    } else {
      lines.push(`- 假设：${n.text ?? "（未写 claim=）"}`);
      lines.push(`- 判据：${n.expect ?? "（未写 expect=）"}`);
      lines.push(`- 首次出现：seq ${n.first_seq}`);
    }
    if (n.basis === "source") {
      lines.push(
        `- 来源：源码${n.code_ref ? `（\`${n.code_ref}\`）` : ""}` +
          (n.calls.length ? `，已有 ${n.calls.length} 次现场取证` : "，**没有任何现场证据调用**——按约定只能算假设，不能进结论"),
      );
    }
    if (n.calls.length) {
      lines.push("", "| seq | 时间 | 代理 | 工具 | 意图 | 状态 |", "|---|---|---|---|---|---|");
      for (const c of n.calls) {
        const purpose = String(c.purpose ?? "").replace(/\|/g, "\\|");
        lines.push(`| ${c.seq} | ${shortTs(c.ts)} | ${c.agent} | \`${c.tool}\` | ${purpose} | ${c.status ?? ""} |`);
      }
      lines.push("", "调用明细（入参 / 返回节选；报错的给全文）：", "");
      for (const c of n.calls) {
        const isErr = c.status && c.status !== "ok";
        lines.push(`- seq ${c.seq} \`${c.tool}\`${isErr ? " **" + c.status + "**" : ""}`);
        if (c.input) lines.push(`  - 入参：${excerpt(c.input, EXCERPT)}`);
        if (c.output) lines.push(`  - 返回：${excerpt(c.output, isErr ? ERROR_FULL : EXCERPT)}`);
      }
    }
    lines.push("");
  };
  const walk = (hid, depth = 0) => {
    nodeLine(byId.get(hid), depth);
    for (const k of kids.get(hid) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r.id);

  lines.push("## 假设出现顺序", "");
  const order = g.nodes.filter((n) => n.first_seq !== null).sort((a, b) => a.first_seq - b.first_seq);
  for (const n of order) {
    lines.push(`- seq ${n.first_seq}：${n.id}（${TYPE_ZH[n.type] ?? "类型未写"}）` + (n.parent ? ` ← 父 ${n.parent}` : ""));
  }
  lines.push("");

  lines.push("## 假设收口（close=）", "");
  const res = g.edges.filter((e) => e.kind === "resolve");
  if (res.length) {
    for (const e of res) lines.push(`- ${e.from} → ${e.to}：${VERDICT_ZH[e.verdict] ?? e.verdict}（span \`${e.span_id}\`）`);
  } else {
    lines.push("- 没有任何调用写 close=，全部假设停在未决。");
  }
  lines.push("");

  lines.push("## 未挂到假设的工具调用", "");
  const bad = g.unattached_tools.filter((u) => u.reason === "intent_without_head");
  const plain = g.unattached_tools.filter((u) => u.reason !== "intent_without_head");
  if (bad.length) {
    lines.push(`### 写了字段但 intent 不带 [H..] 头（${bad.length} 次，被测 agent 未守约定）`, "");
    for (const u of bad) {
      const it = String(u.intent ?? "").replace(/\n/g, " ").replace(/\|/g, "\\|");
      lines.push(`- seq ${u.seq} \`${u.tool}\`（${u.agent}）：${it.slice(0, 160)}`);
    }
    lines.push("");
  }
  if (plain.length) {
    const counts = new Map();
    for (const u of plain) counts.set(u.tool, (counts.get(u.tool) ?? 0) + 1);
    lines.push(`### 不带 intent（${plain.length} 次 dbdog 调用没写 telemetry.intent）`, "");
    for (const [t, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) lines.push(`- \`${t}\` × ${c}`);
    lines.push("");
  }
  if (!g.unattached_tools.length) lines.push("- 无", "");
  return lines.join("\n");
}

/** 存进 server 的紧凑形（2026-09-10）：去掉每次调用的 input/output 与 edges 上的 intent 全文，只留 span_id 引用；
 *  全文仍在各自 span 行与本地 forward-path.json。graph_version 给读侧判形状用。 */
export const GRAPH_VERSION = 1;
export function compactGraph(g) {
  const nodes = g.nodes.map((n) => ({
    ...n,
    calls: n.calls.map(({ input, output, intent, ...rest }) => rest),
  }));
  const edges = g.edges.map(({ intent, ...rest }) => rest);
  return { graph_version: GRAPH_VERSION, trace_ids: g.trace_ids, span_count: g.span_count, covered_through: g.covered_through ?? null, tool_call_count: g.tool_call_count,
    tool_call_count_all: g.tool_call_count_all, nodes, edges, unattached_tools: g.unattached_tools.map(({ input, output, intent, ...rest }) => rest), summary: g.summary };
}

/** root agent span（kind=agent 且无 parent）的 output；多条取最长。没有 root 就退到最后一条 llm span 的 output。 */
export function agentConclusion(spans) {
  const roots = spans.filter((s) => s.kind === "agent" && !s.parent_id);
  const texts = roots.map((s) => s.output_local ?? s.output ?? "").filter((t) => typeof t === "string" && t.trim());
  if (texts.length) return texts.reduce((a, b) => (b.length > a.length ? b : a));
  const llm = spans
    .filter((s) => s.kind === "llm" && typeof s.output === "string" && s.output.trim())
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  return llm.length ? llm[llm.length - 1].output : "";
}

/**
 * 出图：写 forward-path.json / forward-path.md / forward-conclusion.md 到 out 目录。
 * 返回 { md, json, summary }。spans 为空抛错（调用方决定怎么报）。
 */
export function writeGraph(spans, out, source = {}) {
  if (!spans.length) throw new Error("没有读到 span（检查路径 / --trace / --session）");
  const g = build(spans);
  g.source = source;
  fs.mkdirSync(out, { recursive: true });
  const jp = path.join(out, "forward-path.json");
  const mp = path.join(out, "forward-path.md");
  fs.writeFileSync(jp, `${JSON.stringify(g, null, 2)}\n`);
  fs.writeFileSync(mp, renderMd(g));
  const concl = agentConclusion(spans);
  if (concl) {
    fs.writeFileSync(path.join(out, "forward-conclusion.md"), `# 被测 agent 的最终回答（root span output 原文）\n\n${concl.trim()}\n`);
  }
  return { md: mp, json: jp, summary: g.summary };
}

/** CLI 与 skill 共用：path 可以是文件或目录；out 缺省写在输入旁（目录形态写在该目录里）。 */
export function run(input, { out, session, trace } = {}) {
  const src = resolveInput(input);
  const spans = loadSpans(src, { session, trace });
  const isDir = fs.existsSync(input) && fs.statSync(input).isDirectory();
  const dest = out ?? (isDir ? input : path.dirname(path.resolve(src)) || ".");
  return writeGraph(spans, dest, { file: path.resolve(src), session: session ?? null, trace: trace ?? null });
}
