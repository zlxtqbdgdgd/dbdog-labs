// hypothesis-graph.mjs 的用例：从 skills/span-graph/scripts/from_spans.test.py 移植（2026-09-10），
// 输入改成英文键（intent-v2），并各留一条中文键用例证明历史 span 还能画。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { agentConclusion, build, compactGraph, parsedFromSpan, renderMd, resolveInput, run, scanClosing, scanProposals } from "./hypothesis-graph.mjs";
import { parseIntent } from "./hypothesis.mjs";

function tool(spanId, name, ts, intent, tags = {}, extra = {}) {
  const s = { span_id: spanId, kind: "tool", name, trace_id: "aa", ts, tags, ...extra };
  if (intent !== undefined) s.intent = intent;
  return s;
}
/** hook 落盘的 dbdog 调用形状（synthesize.mjs）：name 是剥掉 mcp__<server>__ 前缀的裸名，server 记在 tags.mcp_server。 */
function dbdog(spanId, name, ts, intent, tags = {}, extra = {}) {
  return tool(spanId, name, ts, intent, { mcp_server: "dbdog-mcp", ...tags }, extra);
}
function llm(spanId, ts, { output, output_local, thinking_local, kind = "llm" } = {}) {
  const s = { span_id: spanId, kind, name: "anthropic.messages", trace_id: "aa", ts, tags: {} };
  if (output !== undefined) s.output = output;
  if (output_local !== undefined) s.output_local = output_local;
  if (thinking_local !== undefined) s.thinking_local = thinking_local;
  return s;
}
const byId = (g) => Object.fromEntries(g.nodes.map((n) => [n.id, n]));

describe("hypothesis-graph · build", () => {
  it("tags build parent and tool edges", () => {
    const g = build([
      dbdog("t1", "get_dbdog_metric", 1, undefined, { hypothesis_id: "H1", hypothesis_type: "confirm", hypothesis: "instance anchored" }),
      dbdog("t2", "search_dbdog_logs", 2, undefined, { hypothesis_id: "H2", parent_hypothesis_id: "H1", hypothesis_type: "cause", hypothesis: "plan shape wrong" }),
      tool("t3", "Bash", 3),
    ]);
    expect(g.nodes.map((n) => n.id)).toEqual(["H1", "H2"]);
    expect(g.nodes[1].parent).toBe("H1");
    const kinds = new Set(g.edges.map((e) => `${e.kind} ${e.from} ${e.to ?? e.tool}`));
    expect(kinds.has("parent H1 H2")).toBe(true);
    expect(kinds.has("tool H1 get_dbdog_metric")).toBe(true);
    // 本地工具（Bash）不进图：既不算未挂，也不占 seq——只在 summary 里计次
    expect(g.unattached_tools).toHaveLength(0);
    expect(g.summary.local_tools_excluded_by_name).toEqual({ Bash: 1 });
  });

  it("falls back to the English intent line; a父 that was never stated is **not** invented", () => {
    // 2026-09-10 owner 定：不留兜底。原来这里会给 H2 补一个 declared:false 的占位节点，
    // 现在不补——H2 从没被提出过就是缺陷，让它可见（orphan_hypotheses）然后修源头。
    const g = build([dbdog("t1", "get_dbdog_metric", 1, "[H3<H2] type=cause; claim=short-circuit failed; expect=plan shows a full scan")]);
    expect(g.nodes.map((n) => n.id)).toEqual(["H3"]);
    expect(g.nodes[0]).toMatchObject({ id: "H3", declared: true, type: "cause", expect: "plan shows a full scan" });
    expect(g.nodes[0].parent).toBeFalsy();
    expect(g.summary.orphan_hypotheses).toBe(1);
  });

  it("records resolve edges and verdicts from close=", () => {
    const g = build([
      dbdog("t1", "get_dbdog_metric", 1, "[H1] type=symptom; claim=there are slow queries; expect=any found"),
      dbdog("t2", "get_dbdog_metric", 2, "[H2<H1] type=cause; claim=bad plan; expect=full scan; close=H1:supported; intent=read the plan"),
    ]);
    expect(byId(g).H1.verdict).toBe("confirmed");
    expect(g.edges.filter((e) => e.kind === "resolve")).toEqual([{ kind: "resolve", from: "H2", to: "H1", verdict: "confirmed", span_id: "t2" }]);
  });

  it("classifies unattached calls", () => {
    const g = build([
      dbdog("t1", "load_dbdog_skill", 1, "type=cause; claim=<saturated>; expect=<cpu spikes>"),
      tool("t2", "Bash", 2),
      dbdog("t3", "get_dbdog_metric", 3, ""),
    ]);
    // t2 是本地 Bash：整体排除，不再算 no_intent；seq 也不占（t3 是第 2 次 dbdog 调用）
    expect(Object.fromEntries(g.unattached_tools.map((u) => [u.span_id, u.reason]))).toEqual({ t1: "intent_without_head", t3: "no_intent" });
    expect(g.unattached_tools.map((u) => u.seq)).toEqual([1, 2]);
    expect(g.summary.unattached_intent_without_head).toBe(1);
    expect(g.summary.local_tools_excluded).toBe(1);
  });

  it("calls carry seq, purpose and agent", () => {
    const g = build([
      dbdog("t1", "get_dbdog_metric", "2026-09-09T01:00:00Z", "[H1] claim=a; expect=b; intent=read metrics"),
      dbdog("t2", "ddsql_run_query", "2026-09-09T01:00:05Z", "[H1] expect=b; intent=query sql", { agent_id: "abcdef1234" }),
    ]);
    const calls = g.nodes[0].calls;
    expect(calls.map((c) => c.seq)).toEqual([1, 2]);
    expect(calls[0].purpose).toBe("read metrics");
    expect(calls[0].agent).toBe("main");
    expect(calls[1].agent).toBe("abcdef12");
    expect(g.nodes[0].first_seq).toBe(1);
  });

  it("marks source-derived hypotheses and whether they got runtime evidence", () => {
    const g = build([
      llm("l1", 1, { output: "Propose [H5] type=cause; claim=pruning walks every partition; basis=source; code_ref=pruning.cpp:412" }),
      dbdog("t1", "get_dbdog_metric", 2, "[H6] type=cause; claim=checkpoint storm; basis=source; code_ref=bufmgr.cpp:88; expect=checkpoint_delay rises"),
    ]);
    const n = byId(g);
    expect(n.H5).toMatchObject({ basis: "source", code_ref: "pruning.cpp:412", declared: false });
    expect(n.H6).toMatchObject({ basis: "source", code_ref: "bufmgr.cpp:88", declared: true });
    expect(g.summary.source_hypotheses).toBe(2);
    expect(g.summary.source_without_evidence).toBe(1);
    const md = renderMd(g);
    expect(md).toContain("没有任何现场证据调用");
    expect(md).toContain("已有 1 次现场取证");
  });
});

describe("hypothesis-graph · 点分编号即谱系（2026-09-10）", () => {
  // 实测一轮 460 次点分编号的调用，写了 `<父` 的是 0 次，span 标签上的 parent_hypothesis_id
  // 因此全空，H4.1 在图上是孤儿、挂不到 H4 右边。标签是钩子盖的——**老 span 的标签补不回来**，
  // 所以建图这一侧也要能自己按编号推，不能只依赖标签。
  it("标签没有父时按点分前缀推：H4.1 挂到 H4 底下", () => {
    const g = build([
      dbdog("t1", "get_dbdog_metric", 1, undefined, { hypothesis_id: "H4", hypothesis: "母假设" }),
      dbdog("t2", "search_dbdog_logs", 2, undefined, { hypothesis_id: "H4.1" }),   // 标签里没有 parent
    ]);
    expect(byId(g)["H4.1"].parent).toBe("H4");
    expect(new Set(g.edges.map((e) => `${e.kind} ${e.from} ${e.to ?? e.tool}`)).has("parent H4 H4.1")).toBe(true);
  });

  it("父节点从没被提出过：**不补占位**，如实留成孤儿并计数", () => {
    // owner 2026-09-10 定：不留兜底——父不存在就是缺陷，让它可见然后修源头。
    // 补一个空节点会把「这一支是断的」这件事盖掉，从此没人知道。
    // 实测形态：只有 H4.1…H4.5，没有裸 H4（模型先分组再编号，母假设一次没写）。
    const g = build([
      dbdog("t1", "get_dbdog_metric", 1, undefined, { hypothesis_id: "H4.1" }),
      dbdog("t2", "search_dbdog_logs", 2, undefined, { hypothesis_id: "H4.2" }),
    ]);
    expect(byId(g)["H4"]).toBeUndefined();
    expect(byId(g)["H4.1"].parent).toBeFalsy();
    expect(g.summary.orphan_hypotheses).toBe(2);
  });

  it("显式写了父、而那个父从没被提出过：同样不补占位", () => {
    const g = build([dbdog("t1", "get_dbdog_metric", 1, "[H3<H2] type=cause; claim=x")]);
    expect(byId(g)["H2"]).toBeUndefined();
    expect(byId(g)["H3"].parent).toBeFalsy();
    expect(g.summary.orphan_hypotheses).toBe(1);
  });

  it("标签里显式写了父就用它，不许被点分前缀覆盖（跨号派生只能靠显式）", () => {
    const g = build([
      dbdog("t1", "get_dbdog_metric", 1, undefined, { hypothesis_id: "H1.2" }),
      dbdog("t2", "search_dbdog_logs", 2, undefined, { hypothesis_id: "H2.1", parent_hypothesis_id: "H1.2" }),
    ]);
    expect(byId(g)["H2.1"].parent).toBe("H1.2");
  });

  it("顶层编号没有父，不许推出一个空的 H", () => {
    const g = build([dbdog("t1", "get_dbdog_metric", 1, undefined, { hypothesis_id: "H4" })]);
    expect(byId(g)["H4"].parent).toBeFalsy();
    expect(byId(g)["H"]).toBeUndefined();
  });
});

describe("hypothesis-graph · prose", () => {
  it("English Propose line fills the undeclared parent", () => {
    const g = build([
      llm("l1", 1, { output: "Delegating.\nPropose [H2] type=cause; claim=connection pool exhausted; expect=active connections at the cap\nSpawn." }),
      dbdog("t1", "get_dbdog_metric", 2, "[H2.1<H2] type=cause; claim=pool held by slow transactions; expect=long transactions > 30s"),
    ]);
    const n = byId(g);
    expect(n.H2).toMatchObject({ text: "connection pool exhausted", type: "cause", expect: "active connections at the cap", declared: false, proposed_in: { span_id: "l1", in: "output" } });
    expect(g.summary.proposed_in_prose).toBe(1);
  });

  it("prefers output_local and scans thinking_local; legacy 提出 still works", () => {
    const g = build([
      llm("l1", 1, { output: "truncated…", output_local: "truncated…\nPropose [H3] type=cause; claim=WAL flush is slow", thinking_local: "hmm\n提出 [H4<H3] 类型=根因; 假设=磁盘被别的进程占满" }),
    ]);
    const n = byId(g);
    expect(n.H3.text).toBe("WAL flush is slow");
    expect(n.H3.proposed_in.in).toBe("output");
    expect(n.H4).toMatchObject({ text: "磁盘被别的进程占满", parent: "H3" });
    expect(n.H4.proposed_in.in).toBe("thinking");
  });

  it("skips protocol restatement and example lines, keeps the first proposal", () => {
    const g = build([
      llm("l1", 1, { output: "Write it in `telemetry.intent` on each dbdog call, in the shape the tool schema describes; for example `[H2.1<H1.2] type=cause; claim=connection waits`\nPropose [H9] type=cause; claim=<placeholder>\nPropose [H2] type=cause; claim=the real one" }),
      llm("l2", 2, { output: "Propose [H2] type=cause; claim=changed later" }),
    ]);
    const n = byId(g);
    expect(Object.keys(n).sort()).toEqual(["H2"]);
    expect(n.H2.text).toBe("the real one");
    expect(n.H2.proposed_in.span_id).toBe("l1");
  });

  it("closes from the hypothesis ledger at the end of How do we know (and legacy 假设收口)", () => {
    const g = build([
      dbdog("t1", "get_dbdog_metric", 1, "[H1] type=symptom; claim=anchored; expect=found"),
      dbdog("t2", "get_dbdog_metric", 2, "[H2<H1] type=cause; claim=bad plan; expect=full scan; close=H1:supported"),
      { span_id: "root", kind: "agent", name: "claude-code.task", trace_id: "aa", ts: 9,
        output: "## How do we know\n\nevidence…\n\nHypothesis ledger:\n- H1 refuted — instance not found\n- H2 inconclusive — plan missing\n- H3 supported — source confirmed\n\n## The root cause\nH2 supported" },
      { span_id: "llm9", kind: "llm", name: "anthropic.messages", trace_id: "aa", ts: 8, output: "## 假设收口\n- H3 证实 —— 源码核到" },
    ]);
    const n = byId(g);
    expect(n.H1.verdict).toBe("confirmed"); // close= on the call wins over prose
    expect(n.H2.verdict).toBe("open"); // prose says inconclusive; the line outside the ledger does not count
    expect(n.H3.verdict).toBe("confirmed");
    expect(n.H3.closed_by.in).toBe("prose");
    expect(g.edges.filter((e) => e.kind === "resolve" && e.to === "H3")).toHaveLength(1); // root and last llm repeat, recorded once
    expect(scanClosing("no ledger")).toEqual([]);
    const md = renderMd(g);
    expect(md).toContain("正文收口 → H3");
    expect(md).toContain("结论正文「假设收口」里关闭");
  });

  it("renders the tree", () => {
    const g = build([
      dbdog("t1", "get_dbdog_metric", 1, "[H1] type=symptom; claim=slow queries exist; expect=any found; intent=find slow sql"),
      dbdog("t2", "get_dbdog_metric", 2, "[H2.1<H2] type=cause; claim=bad plan; expect=full scan; close=H1:supported; intent=read plan"),
      dbdog("t3", "load_dbdog_skill", 3, "type=cause; claim=<saturated>"),
      tool("t4", "Bash", 4),
    ]);
    const md = renderMd(g);
    // `[H2.1<H2]` 里的 H2 从没被提出过 → 不补占位（owner 2026-09-10：不留兜底），
    // H2.1 如实成为孤儿，由 orphan_hypotheses 计数暴露。
    expect(g.summary.orphan_hypotheses).toBe(1);
    expect(g.nodes.map((n) => n.id)).not.toContain("H2");
    for (const needle of ["slow queries exist", "判据：any found", "find slow sql", "H2.1 → H1", "证实", "intent 不带 [H..] 头", "## 假设出现顺序"]) {
      expect(md, needle).toContain(needle);
    }
    // 本地工具只在概览里计次，不再列进「未挂到假设的工具调用」
    expect(md).toContain("本地工具调用 1 次未计入（Bash 1）");
    expect(md).not.toContain("`Bash` × 1");
  });
});

describe("hypothesis-graph · 只统计 dbdog（MCP）工具调用（2026-09-10）", () => {
  // owner：假设树里 Grep/Glob/Read 这类 Claude Code 本地工具没用，而且「H1 上来就是第 23 步」看不懂——
  // seq 原来是整条 trace 全部工具调用的全局序号，前面 22 次都是本地读文件。
  // 判据不是白名单：hook 落盘的 MCP 调用带 tags.mcp_server（name 已剥前缀），server 导出/别处的可能保留 mcp__ 前缀；
  // 两者之外一律按本地工具排除（Grep/Glob/Read/Bash/Edit/Agent/SendMessage/ReadMcpResourceTool…）。
  const spans = () => [
    tool("l1", "Read", 1),
    tool("l2", "Grep", 2),
    tool("l3", "Glob", 3),
    dbdog("t1", "get_dbdog_metric", 4, "[H1] type=cause; claim=checkpoint storm; expect=checkpoint_delay rises"),
    tool("t2", "mcp__dbdog__search_dbdog_logs", 5, "[H1] expect=error lines; intent=read logs"),
  ];

  it("seq 从 1 起只数 dbdog 调用；本地工具不进边、不算未挂、不占 seq", () => {
    const g = build(spans());
    const n = byId(g);
    expect(n.H1.first_seq).toBe(1); // 不是 4
    expect(n.H1.calls.map((c) => [c.seq, c.tool])).toEqual([[1, "get_dbdog_metric"], [2, "search_dbdog_logs"]]);
    expect(g.edges.filter((e) => e.kind === "tool")).toHaveLength(2);
    expect(g.unattached_tools).toHaveLength(0);
    expect(g.tool_call_count).toBe(2);
    expect(g.tool_call_count_all).toBe(5);
    expect(g.summary.local_tools_excluded).toBe(3);
    expect(g.summary.local_tools_excluded_by_name).toEqual({ Read: 1, Grep: 1, Glob: 1 });
  });

  it("close= 的 seq 同口径", () => {
    const g = build([
      tool("l1", "Read", 1),
      dbdog("t1", "get_dbdog_metric", 2, "[H1] type=cause; claim=a; expect=b"),
      tool("l2", "Grep", 3),
      dbdog("t2", "search_dbdog_logs", 4, "[H2<H1] type=cause; claim=c; expect=d; close=H1:refuted"),
    ]);
    expect(byId(g).H1.closed_by).toMatchObject({ from: "H2", seq: 2, span_id: "t2" });
  });

  it("renderMd 说明 seq 是 dbdog 调用序号，并把本地工具计次写进概览", () => {
    const md = renderMd(build(spans()));
    expect(md).toContain("seq 是 dbdog（MCP）工具调用的序号");
    expect(md).toContain("本地工具调用 3 次未计入（");
    for (const needle of ["Read 1", "Grep 1", "Glob 1"]) expect(md).toContain(needle);
    expect(md).toContain("工具调用 5 次");
    expect(md).toContain("dbdog（MCP）调用 2 次");
  });

  it("compactGraph 带上排除计数与全量调用数", () => {
    const c = compactGraph(build(spans()));
    expect(c.summary.local_tools_excluded).toBe(3);
    expect(c.summary.local_tools_excluded_by_name).toEqual({ Read: 1, Grep: 1, Glob: 1 });
    expect(c.tool_call_count).toBe(2);
    expect(c.tool_call_count_all).toBe(5);
  });
});

describe("hypothesis-graph · call input/output (2026-09-10)", () => {
  // owner：只看到「这次调用是干什么的」判断不了工具本身对不对——每次调用要带入参与返回。
  // JSON 带全量（本地字段 *_local 优先），markdown 给节选；报错的调用返回全文放出来。
  it("carries input and output on each call and renders excerpts", () => {
    const longOut = "x".repeat(2000);
    const g = build([
      dbdog("t1", "get_dbdog_metric", 1, "[H1] type=cause; claim=c; expect=e; intent=read", {}, { input: '{"queries":[{"metric_name":"opengauss.rows"}]}', output: "short answer", output_local: longOut }),
      dbdog("t2", "search_dbdog_logs", 2, "[H1] expect=e; intent=logs", {}, { input: '{"query":"status:error"}', output: "MCP error -32602: Invalid arguments", status: "error" }),
    ]);
    const calls = g.nodes[0].calls;
    expect(calls[0].input).toBe('{"queries":[{"metric_name":"opengauss.rows"}]}');
    expect(calls[0].output).toBe(longOut); // 本地全量优先
    expect(calls[1].status).toBe("error");
    const md = renderMd(g);
    expect(md).toContain("入参：`{\"queries\":[{\"metric_name\":\"opengauss.rows\"}]}`");
    expect(md).toContain("返回：" ); // 节选
    expect(md).not.toContain("x".repeat(700)); // 长返回被截
    expect(md).toContain("…（共 2000 字，全文见 forward-path.json）");
    expect(md).toContain("MCP error -32602: Invalid arguments"); // 报错全文
  });
});

describe("hypothesis-graph · io", () => {
  it("agentConclusion prefers the root agent span", () => {
    const spans = [
      { span_id: "r", kind: "agent", name: "claude-code.task", trace_id: "aa", ts: 1, output: "## 结论\n五段式……" },
      { span_id: "l", kind: "llm", trace_id: "aa", ts: 2, output: "middle" },
    ];
    expect(agentConclusion(spans)).toBe("## 结论\n五段式……");
    expect(agentConclusion([spans[1]])).toBe("middle");
    expect(agentConclusion([])).toBe("");
  });

  it("resolves a directory to its spans.jsonl and run() writes the three files", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "graph-"));
    const p = path.join(d, "spans.jsonl");
    fs.writeFileSync(p, [
      JSON.stringify({ span_id: "x", kind: "agent", trace_id: "cc", ts: 1, output: "answer" }),
      JSON.stringify(dbdog("t1", "get_dbdog_metric", 2, "[H1] type=cause; claim=c; expect=e", {}, { trace_id: "cc" })),
    ].join("\n") + "\n");
    expect(resolveInput(d)).toBe(p);
    const { md } = run(d, { trace: "cc" });
    expect(md).toBe(path.join(d, "forward-path.md"));
    expect(fs.existsSync(path.join(d, "forward-path.json"))).toBe(true);
    expect(fs.readFileSync(path.join(d, "forward-conclusion.md"), "utf8")).toContain("answer");
  });

  it("parsedFromSpan carries intent= purpose next to tag-derived fields", () => {
    const p = parsedFromSpan(dbdog("t", "get_dbdog_metric", 1, "[H1] claim=a; intent=why", { hypothesis_id: "H1", hypothesis: "a" }));
    expect(p).toMatchObject({ id: "H1", text: "a", purpose: "why" });
    expect(parseIntent("[H2.1<H2>] type=cause; claim=x")).toMatchObject({ id: "H2.1", parent: "H2" });
    expect(scanProposals("Propose [H7] type=cause; claim=y")).toEqual([["H7", expect.objectContaining({ id: "H7", text: "y", type: "cause" })]]);
  });
});

describe("graph-worker", () => {
  it("writes the graph for the session's trace under <obsDir>/graphs/<trace_id>", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-"));
    fs.writeFileSync(path.join(dir, "sess1.json"), JSON.stringify({ trace_id: "tr1", root_span_id: "tr1root", session_id: "sess1" }));
    fs.writeFileSync(path.join(dir, "spans.jsonl"), [
      JSON.stringify({ span_id: "tr1root", kind: "agent", name: "claude-code.task", trace_id: "tr1", ts: 1, output: "## How do we know\nHypothesis ledger:\n- H1 supported — seen" }),
      JSON.stringify(dbdog("t1", "get_dbdog_metric", 2, "[H1] type=cause; claim=c; expect=e", {}, { trace_id: "tr1" })),
      JSON.stringify(dbdog("t9", "get_dbdog_metric", 3, "[H1] claim=other trace", {}, { trace_id: "tr2" })),
    ].join("\n") + "\n");
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "graph-worker.mjs"), "sess1"], { env: { ...process.env, DBDOG_OBS_DIR: dir }, encoding: "utf8" });
    expect(r.status).toBe(0);
    const md = fs.readFileSync(path.join(dir, "graphs", "tr1", "forward-path.md"), "utf8");
    expect(md).toContain("`tr1`");
    expect(md).not.toContain("other trace");
    expect(fs.readFileSync(path.join(dir, "graph-worker.log"), "utf8")).toContain("trace=tr1 假设 1");
  });
});

describe("hypothesis-graph · compact graph for the server (2026-09-10)", () => {
  it("strips call input/output but keeps span refs, and bounds the size", () => {
    const g = build([
      dbdog("t1", "get_dbdog_metric", 1, "[H1] type=cause; claim=c; expect=e; intent=read", {}, { input: "x".repeat(5000), output: "y".repeat(5000) }),
    ]);
    const c = compactGraph(g);
    expect(c.nodes[0].calls[0]).toMatchObject({ seq: 1, span_id: "t1", tool: "get_dbdog_metric", purpose: "read" });
    expect(c.nodes[0].calls[0]).not.toHaveProperty("input");
    expect(c.nodes[0].calls[0]).not.toHaveProperty("output");
    expect(c.edges.find((e) => e.kind === "tool")).not.toHaveProperty("intent");
    expect(JSON.stringify(c).length).toBeLessThan(2000);
    expect(c.graph_version).toBe(1);
  });
});

describe("hypothesis-graph · covered_through（2026-09-10）", () => {
  // server 判「图落后于 span」靠事件时间覆盖面：图里带上参与出图的最晚 span ts，
  // 读侧拿它跟 span 水位 max(ts) 比。按入库时间比会一律 stale——SessionEnd 先出图后上报，
  // 图必然先于尾部 span 入库，可图的内容是全的（出图读的是本地 spans.jsonl）。
  it("取参与出图的全部 span 里最晚的 ts 原值，不取 now", () => {
    const g = build([
      llm("l1", "2026-09-10T08:30:00.000Z", { output: "Propose [H1] type=cause; claim=c; expect=e" }),
      dbdog("t1", "get_dbdog_metric", "2026-09-10T08:31:20.500Z", "[H1] expect=e; intent=read"),
      llm("l2", "2026-09-10T08:30:40.000Z", { output: "无关" }),
    ]);
    expect(g.covered_through).toBe("2026-09-10T08:31:20.500Z");
  });

  it("本地工具虽然不进图，事件时间照样算进覆盖面", () => {
    // 本地 Read/Grep 不占 seq、不进边，但它们确实是这次会话的 span，server 水位 max(ts) 会算上；
    // 覆盖面漏掉它们就会被误判成 stale。
    const g = build([
      dbdog("t1", "get_dbdog_metric", "2026-09-10T08:30:00.000Z", "[H1] type=cause; claim=c; expect=e"),
      tool("l1", "Read", "2026-09-10T08:32:00.000Z"),
    ]);
    expect(g.covered_through).toBe("2026-09-10T08:32:00.000Z");
  });

  it("一条 span 都没有就是 null", () => {
    expect(build([]).covered_through).toBeNull();
  });

  it("compactGraph 带上 covered_through", () => {
    const c = compactGraph(build([
      dbdog("t1", "get_dbdog_metric", "2026-09-10T08:30:00.000Z", "[H1] type=cause; claim=c; expect=e"),
    ]));
    expect(c.covered_through).toBe("2026-09-10T08:30:00.000Z");
  });
});

describe("graph-worker · pushes the graph to the server on the root span", () => {
  it("re-emits the root span with a compact graph through DBDOG_OBS_REPORT_URL", async () => {
    const http = await import("node:http");
    const received = [];
    const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { received.push(JSON.parse(b)); res.writeHead(202); res.end("{}"); }); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-"));
    fs.writeFileSync(path.join(dir, "sess2.json"), JSON.stringify({ trace_id: "tr9", root_span_id: "tr9root", session_id: "sess2" }));
    fs.writeFileSync(path.join(dir, "spans.jsonl"), [
      JSON.stringify({ span_id: "tr9root", parent_id: null, kind: "agent", name: "claude-code.task", trace_id: "tr9", ts: "2026-09-10T08:00:00Z", output: "answer", output_local: "answer full", tags: { ml_app: "x" } }),
      JSON.stringify(dbdog("t1", "get_dbdog_metric", "2026-09-10T08:00:01Z", "[H1] type=cause; claim=c; expect=e", {}, { trace_id: "tr9", output: "big".repeat(100) })),
    ].join("\n") + "\n");
    // 必须异步 spawn：spawnSync 会把本进程事件循环卡死，上面这个同进程 http server 根本接不到连接，
    // worker 的 fetch 只能撞 reportTimeoutMs() 的 3s 超时后落「未送达」（2026-09-10 实证）。
    const status = await new Promise((resolve) => {
      spawn(process.execPath, [path.join(import.meta.dirname, "graph-worker.mjs"), "sess2"], {
        env: { ...process.env, DBDOG_OBS_DIR: dir, DBDOG_OBS_REPORT_URL: `http://127.0.0.1:${port}/api/v2/llmobs/spans`, DBDOG_OBS_API_KEY: "dbdog_test" },
        stdio: "ignore",
      }).on("close", resolve);
    });
    await new Promise((r) => server.close(r));
    expect(status).toBe(0);
    expect(received).toHaveLength(1);
    const root = received[0].spans[0];
    expect(root.span_id).toBe("tr9root");
    expect(root.graph.nodes[0].id).toBe("H1");
    expect(root.graph.nodes[0].calls[0]).not.toHaveProperty("output");
    expect(root).not.toHaveProperty("output_local"); // stripLocal 照旧
    expect(fs.readFileSync(path.join(dir, "graph-worker.log"), "utf8")).toContain("已推 root+graph");
  });
});

// ── 代码证据边（2026-09-12）────────────────────────────────────────────────
// 代码证据由 graph-worker 先跑 source-evidence 两段（正则粗筛 + 模型切分）算好，再传进 build。
// **build 本身保持零模型**。原来那版在 build 里用纯正则切子代理回参，27 条历史 trace 实测
// 召回只有 12.5%（43/343）——回参格式每次都不一样，正则追不过来（见 source-evidence.mjs 文件头）。
// owner 2026-09-12 定：代码证据与遥测证据两种边都要，同级但靠 basis 区分。
describe("hypothesis-graph · 代码证据边", () => {
  const EV = {
    H2: [
      { title: "出厂构建里那道守卫无条件命中", refs: ["src/common/backend/parser/gram.y:24015-24037", "prepare.cpp:380"] },
      { title: "PGXC 在所有构建变体里都被定义", refs: ["configure.in:1930-1931", "cmake/src/build_options.cmake:172"] },
    ],
  };

  it("传进来的代码证据成 source 边，与工具边并存、靠 basis 区分", () => {
    const g = build(
      [dbdog("t1", "search_dbdog_logs", 1, "[H2] type=cause; claim=feature could be enabled on this instance")],
      { sourceEvidence: EV },
    );
    const src = g.edges.filter((e) => e.kind === "source");
    expect(src.length).toBe(2);
    expect(src.every((e) => e.from === "H2" && e.basis === "source")).toBe(true);
    expect(src[0].refs).toContain("prepare.cpp:380");
    expect(src[1].refs).toContain("cmake/src/build_options.cmake:172");
    expect(g.edges.some((e) => e.kind === "tool" && e.from === "H2")).toBe(true);
    expect(g.summary.source_edges).toBe(2);
  });

  it("子代理裁决当收口用——不必等模型在下一次调用写 close=", () => {
    const g = build(
      [dbdog("t1", "search_dbdog_logs", 1, "[H2] type=cause; claim=x")],
      { sourceEvidence: EV, sourceVerdict: { H2: "falsified" } },
    );
    expect(byId(g).H2.verdict).toBe("falsified");
    expect(g.edges.some((e) => e.kind === "resolve" && e.to === "H2" && e.verdict === "falsified")).toBe(true);
  });

  it("已经被 close= 关过的假设，子代理裁决不覆盖（工具调用上写的优先）", () => {
    const g = build(
      [
        dbdog("t1", "search_dbdog_logs", 1, "[H2] type=cause; claim=x"),
        dbdog("t2", "search_dbdog_logs", 2, "[H3] type=cause; claim=y; close=H2:supported"),
      ],
      { sourceVerdict: { H2: "falsified" } },
    );
    expect(byId(g).H2.verdict).toBe("confirmed");
  });

  it("不传代码证据时一切照旧（零模型路径不受影响）", () => {
    const g = build([dbdog("t1", "search_dbdog_logs", 1, "[H1] type=confirm; claim=z")]);
    expect(g.summary.source_edges).toBe(0);
    expect(g.edges.filter((e) => e.kind === "source").length).toBe(0);
  });
});

describe("hypothesis-graph · 裸收口：判了但没取证（2026-09-12 OG-3891 的 H4）", () => {
  // 实测那条 trace 里 H4 在图上写着「证伪」，名下却没有任何工具调用、没有代码证据、
  // 也没有子假设——凭什么证伪，读图的人看不出来。旧渲染还硬编码了一句「由子假设取证」，
  // H4 连子假设都没有，那句话是错的。
  const spans = () => [
    dbdog("t1", "get_dbdog_metric", 1, "[H1] type=symptom; claim=查询确实慢; expect=有执行记录"),
    {
      span_id: "root", kind: "agent", name: "claude-code.task", trace_id: "aa", ts: 9,
      output:
        "## How do we know\n\nevidence…\n\nHypothesis ledger:\n" +
        "- H1 supported — 执行记录在\n" +
        "- H4 refuted — 抽取不依赖统计\n",
    },
    { span_id: "l1", kind: "llm", name: "anthropic.messages", trace_id: "aa", ts: 2,
      output: "Propose [H4] type=cause; claim=统计信息过期导致代价估错" },
  ];

  it("名下什么证据都没有的收口，单独计数", () => {
    const g = build(spans());
    const n = byId(g);
    expect(n.H4.verdict).toBe("falsified");
    expect(n.H4.unsupported_close).toBe(true);
    // H1 有工具边撑着，不算裸收口
    expect(n.H1.unsupported_close).toBeFalsy();
    expect(g.summary.unsupported_closes).toBe(1);
  });

  it("图上说清楚凭什么判的，不再说「由子假设取证」", () => {
    const md = renderMd(build(spans()));
    const h4 = md.slice(md.indexOf("### H4"), md.indexOf("### H4") + 700);
    expect(h4).toContain("没有取证");
    expect(h4).not.toContain("由子假设取证");
  });

  it("有代码证据撑着的收口不算裸收口", () => {
    const g = build(spans(), {
      sourceEvidence: { H4: [{ title: "统计与抽取无关", refs: ["orclauses.cpp:71"] }] },
    });
    expect(byId(g).H4.unsupported_close).toBeFalsy();
    expect(g.summary.unsupported_closes).toBe(0);
  });
});
