// hypothesis-graph.mjs 的用例：从 skills/span-graph/scripts/from_spans.test.py 移植（2026-09-10），
// 输入改成英文键（intent-v2），并各留一条中文键用例证明历史 span 还能画。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { agentConclusion, build, parsedFromSpan, renderMd, resolveInput, run, scanClosing, scanProposals } from "./hypothesis-graph.mjs";
import { parseIntent } from "./hypothesis.mjs";

function tool(spanId, name, ts, intent, tags = {}, extra = {}) {
  const s = { span_id: spanId, kind: "tool", name, trace_id: "aa", ts, tags, ...extra };
  if (intent !== undefined) s.intent = intent;
  return s;
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
      tool("t1", "get_dbdog_metric", 1, undefined, { hypothesis_id: "H1", hypothesis_type: "confirm", hypothesis: "instance anchored" }),
      tool("t2", "search_dbdog_logs", 2, undefined, { hypothesis_id: "H2", parent_hypothesis_id: "H1", hypothesis_type: "cause", hypothesis: "plan shape wrong" }),
      tool("t3", "Bash", 3),
    ]);
    expect(g.nodes.map((n) => n.id)).toEqual(["H1", "H2"]);
    expect(g.nodes[1].parent).toBe("H1");
    const kinds = new Set(g.edges.map((e) => `${e.kind} ${e.from} ${e.to ?? e.tool}`));
    expect(kinds.has("parent H1 H2")).toBe(true);
    expect(kinds.has("tool H1 get_dbdog_metric")).toBe(true);
    expect(g.unattached_tools).toHaveLength(1);
    expect(g.unattached_tools[0].tool).toBe("Bash");
  });

  it("falls back to the English intent line and creates the placeholder parent", () => {
    const g = build([tool("t1", "get_dbdog_metric", 1, "[H3<H2] type=cause; claim=short-circuit failed; expect=plan shows a full scan")]);
    expect(g.nodes[0].id).toBe("H2");
    expect(g.nodes[0].declared).toBe(false);
    expect(g.nodes[1]).toMatchObject({ id: "H3", declared: true, parent: "H2", type: "cause", expect: "plan shows a full scan" });
  });

  it("records resolve edges and verdicts from close=", () => {
    const g = build([
      tool("t1", "get_dbdog_metric", 1, "[H1] type=symptom; claim=there are slow queries; expect=any found"),
      tool("t2", "get_dbdog_metric", 2, "[H2<H1] type=cause; claim=bad plan; expect=full scan; close=H1:supported; intent=read the plan"),
    ]);
    expect(byId(g).H1.verdict).toBe("confirmed");
    expect(g.edges.filter((e) => e.kind === "resolve")).toEqual([{ kind: "resolve", from: "H2", to: "H1", verdict: "confirmed", span_id: "t2" }]);
  });

  it("classifies unattached calls", () => {
    const g = build([
      tool("t1", "load_dbdog_skill", 1, "type=cause; claim=<saturated>; expect=<cpu spikes>"),
      tool("t2", "Bash", 2),
      tool("t3", "get_dbdog_metric", 3, ""),
    ]);
    expect(Object.fromEntries(g.unattached_tools.map((u) => [u.span_id, u.reason]))).toEqual({ t1: "intent_without_head", t2: "no_intent", t3: "no_intent" });
    expect(g.summary.unattached_intent_without_head).toBe(1);
  });

  it("calls carry seq, purpose and agent", () => {
    const g = build([
      tool("t1", "get_dbdog_metric", "2026-09-09T01:00:00Z", "[H1] claim=a; expect=b; intent=read metrics"),
      tool("t2", "ddsql_run_query", "2026-09-09T01:00:05Z", "[H1] expect=b; intent=query sql", { agent_id: "abcdef1234" }),
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
      tool("t1", "get_dbdog_metric", 2, "[H6] type=cause; claim=checkpoint storm; basis=source; code_ref=bufmgr.cpp:88; expect=checkpoint_delay rises"),
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

describe("hypothesis-graph · prose", () => {
  it("English Propose line fills the undeclared parent", () => {
    const g = build([
      llm("l1", 1, { output: "Delegating.\nPropose [H2] type=cause; claim=connection pool exhausted; expect=active connections at the cap\nSpawn." }),
      tool("t1", "get_dbdog_metric", 2, "[H2.1<H2] type=cause; claim=pool held by slow transactions; expect=long transactions > 30s"),
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
      tool("t1", "get_dbdog_metric", 1, "[H1] type=symptom; claim=anchored; expect=found"),
      tool("t2", "get_dbdog_metric", 2, "[H2<H1] type=cause; claim=bad plan; expect=full scan; close=H1:supported"),
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
      tool("t1", "get_dbdog_metric", 1, "[H1] type=symptom; claim=slow queries exist; expect=any found; intent=find slow sql"),
      tool("t2", "get_dbdog_metric", 2, "[H2.1<H2] type=cause; claim=bad plan; expect=full scan; close=H1:supported; intent=read plan"),
      tool("t3", "load_dbdog_skill", 3, "type=cause; claim=<saturated>"),
      tool("t4", "Bash", 4),
    ]);
    const md = renderMd(g);
    for (const needle of ["slow queries exist", "判据：any found", "find slow sql", "H2", "未声明", "H2.1 → H1", "证实", "intent 不带 [H..] 头", "Bash", "## 假设出现顺序"]) {
      expect(md, needle).toContain(needle);
    }
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
      JSON.stringify(tool("t1", "get_dbdog_metric", 2, "[H1] type=cause; claim=c; expect=e", {}, { trace_id: "cc" })),
    ].join("\n") + "\n");
    expect(resolveInput(d)).toBe(p);
    const { md } = run(d, { trace: "cc" });
    expect(md).toBe(path.join(d, "forward-path.md"));
    expect(fs.existsSync(path.join(d, "forward-path.json"))).toBe(true);
    expect(fs.readFileSync(path.join(d, "forward-conclusion.md"), "utf8")).toContain("answer");
  });

  it("parsedFromSpan carries intent= purpose next to tag-derived fields", () => {
    const p = parsedFromSpan(tool("t", "get_dbdog_metric", 1, "[H1] claim=a; intent=why", { hypothesis_id: "H1", hypothesis: "a" }));
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
      JSON.stringify(tool("t1", "get_dbdog_metric", 2, "[H1] type=cause; claim=c; expect=e", {}, { trace_id: "tr1" })),
      JSON.stringify(tool("t9", "get_dbdog_metric", 3, "[H1] claim=other trace", {}, { trace_id: "tr2" })),
    ].join("\n") + "\n");
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "graph-worker.mjs"), "sess1"], { env: { ...process.env, DBDOG_OBS_DIR: dir }, encoding: "utf8" });
    expect(r.status).toBe(0);
    const md = fs.readFileSync(path.join(dir, "graphs", "tr1", "forward-path.md"), "utf8");
    expect(md).toContain("`tr1`");
    expect(md).not.toContain("other trace");
    expect(fs.readFileSync(path.join(dir, "graph-worker.log"), "utf8")).toContain("trace=tr1 假设 1");
  });
});
