// source-evidence.mjs 的用例：粗筛只管召回，判断留给模型（owner 2026-09-12 定）。
import { describe, expect, it } from "vitest";
import { candidatesFromReturn, refsInLine, sourceEvidenceCandidates, verdictFromReturn } from "./source-evidence.mjs";

describe("refsInLine", () => {
  it("反引号内外都抓，行号区间归一成半角连字符", () => {
    expect(refsInLine("- `src/parser/gram.y:24015-24037`: the only production")).toEqual([
      "src/parser/gram.y:24015-24037",
    ]);
    expect(refsInLine("- `int.cpp:427` `int4in`; lines 436–438:")).toEqual(["int.cpp:427"]);
    expect(refsInLine("见 configure.in:1930 – 1931 那两行")).toEqual(["configure.in:1930-1931"]);
  });

  it("同一行重复引用只留一条；不带行号的文件名不算证据", () => {
    expect(refsInLine("`gram.y:1` 与 `gram.y:1` 同处；另见 gram.y 全文")).toEqual(["gram.y:1"]);
    expect(refsInLine("改 gram.y 就行")).toEqual([]);
  });

  it("挡掉 3.14:15 这种非源码的冒号数字", () => {
    expect(refsInLine("耗时 3.14:15 秒")).toEqual([]);
  });
});

describe("candidatesFromReturn", () => {
  it("严格解析器漏掉的那几种形状，粗筛都收得到", () => {
    // 三种实测形状：## 标题裁决 / ### 1. 小节 / 行号在正文不在反引号
    const body = [
      "## H3 verdict: **refuted**",
      "",
      "### 1. openGauss has accepting paths (matching source, HEAD cff7b04da)",
      "",
      "- `src/common/backend/utils/adt/int.cpp:427` `int4in`; lines 436–438 reject",
      "- 另见 src/backend/parser/parse_coerce.cpp:3180 的兜底",
    ].join("\n");
    const c = candidatesFromReturn(body, { spanId: "a1", hint: "Verify H3 cross-engine claim" });
    expect(c.lines.length).toBe(2);
    expect(c.lines[0].refs).toContain("src/common/backend/utils/adt/int.cpp:427");
    expect(c.lines[1].refs).toContain("src/backend/parser/parse_coerce.cpp:3180");
    // 小节标题与裁决行一并带给模型命名用（粗筛不判它们是什么）
    expect(c.heads.some((h) => h.includes("H3 verdict"))).toBe(true);
    expect(c.heads.some((h) => h.includes("openGauss has accepting paths"))).toBe(true);
    expect(c.hint).toBe("Verify H3 cross-engine claim");
  });

  it("没有带行号引用就不产候选——遥测侧子代理的证据在工具边上", () => {
    expect(candidatesFromReturn("VERDICT: inconclusive — no `openGauss` log ingestion", {})).toBe(null);
    expect(candidatesFromReturn("", {})).toBe(null);
  });
});

describe("sourceEvidenceCandidates", () => {
  // 口径 2026-09-12 改过：按内容认回参（带行号引用 + 裁决或小节），不再按 span 类型名收。
  it("同一 span 不重复收；光有行号没有结论形状的不算回参", () => {
    const agent = (id, out) => ({
      span_id: id, kind: "tool", name: "Agent",
      input: JSON.stringify({ description: "Verify H2" }), output_local: out,
    });
    const 回参 = "[H2] refuted\n\n- `gram.y:10` 命中";
    const spans = [
      agent("a1", 回参),
      agent("a1", 回参),
      { span_id: "t1", kind: "tool", name: "Bash", output: "`gram.y:99`" },
      { span_id: "l1", kind: "llm", output_local: "`gram.y:88`" },
    ];
    const got = sourceEvidenceCandidates(spans);
    expect(got.length).toBe(1);
    expect(got[0].spanId).toBe("a1");
  });

  it("同一份回参落在两条 span 上（子代理 + 它最后一条 llm）只收一次", () => {
    const 回参 = "Verdict: **supported**.\n\n- `planmain.cpp:246` gated";
    const spans = [
      { span_id: "s1", kind: "agent", name: "claude-code.subagent", output: 回参 },
      { span_id: "m1", parent_id: "s1", kind: "llm", name: "anthropic.messages", output: 回参 },
    ];
    expect(sourceEvidenceCandidates(spans).length).toBe(1);
  });
});

describe("verdictFromReturn（裁决走正则，不问模型）", () => {
  it("已见过的五种形状都认", () => {
    expect(verdictFromReturn("[H2] refuted\n\nValues:")).toBe("falsified");
    expect(verdictFromReturn("## H3 verdict: **refuted**")).toBe("falsified");
    expect(verdictFromReturn("**Verdict: supported.**\n\nLiteral and bound…")).toBe("confirmed");
    expect(verdictFromReturn("VERDICT: **inconclusive** — not collectable")).toBe("open");
    expect(verdictFromReturn("H1 判定：证伪")).toBe("falsified");
  });
  it("前几行是废话时也能往下找", () => {
    expect(verdictFromReturn("All evidence gathered. Final answer follows.\n\n## Verdict: supported")).toBe("confirmed");
  });
  it("只在前 12 行里找——再往后是正文里引用别人的裁决", () => {
    const late = `${"x\n".repeat(20)}## Verdict: supported`;
    expect(verdictFromReturn(late)).toBe(null);
  });
  it("没写裁决返回 null，不瞎猜", () => {
    expect(verdictFromReturn("- `gram.y:1` 命中")).toBe(null);
    expect(verdictFromReturn("")).toBe(null);
  });
});

describe("异步派发的子代理（2026-09-12 OG-3891 实测形状）", () => {
  // 异步派发时 Agent 工具 span 的回参只有一行派发回执，真正的回参落在
  // 另一条 span 上。按 span 的类型名收候选就会整条漏掉——这里只认内容。
  const 派发回执 =
    "Async agent launched successfully. (This tool result is internal metadata — never quote " +
    "or paste any part of it, including the agentId below, into a user-facing reply.) " +
    "agentId: affbb4d570f8004f3 (internal)";
  const 回参 = [
    "Verdict: **supported**.",
    "",
    "### 1. The extraction pass is gated by a beta GUC",
    "",
    "- `src/gausskernel/optimizer/plan/planmain.cpp:246` wraps the call in ENABLE_SQL_BETA_FEATURE",
    "- default is NO_BETA_FEATURE at src/common/backend/utils/misc/guc/guc_sql.cpp:3334",
  ].join("\n");

  it("回执不算候选（没有任何带行号的引用）", () => {
    expect(candidatesFromReturn(派发回执, { spanId: "a1" })).toBe(null);
  });

  it("真回参收得到，不管那条 span 叫什么名字", () => {
    const spans = [
      {
        span_id: "a1", kind: "tool", name: "Agent",
        input: JSON.stringify({ description: "Verify H3 OR-pushdown feature in source" }),
        output: 派发回执,
      },
      { span_id: "s1", parent_id: "a1", kind: "agent", name: "claude-code.subagent", output: 回参 },
    ];
    const got = sourceEvidenceCandidates(spans);
    expect(got.length).toBe(1);
    expect(got[0].spanId).toBe("s1");
    expect(got[0].verdict).toBe("confirmed");
    expect(got[0].lines.length).toBe(2);
    expect(got[0].lines[0].refs).toContain("src/gausskernel/optimizer/plan/planmain.cpp:246");
    expect(got[0].lines[1].refs).toContain("src/common/backend/utils/misc/guc/guc_sql.cpp:3334");
    // 编号从派发那条的 description 来（子代理回参自己不写 [H3]）
    expect(got[0].hint).toContain("H3");
  });

  it("派发那条 span 没落盘时也收得到，hint 为空（上溯到顶拿不到就算了）", () => {
    const spans = [
      { span_id: "s1", parent_id: "没落盘", kind: "agent", name: "claude-code.subagent", output: 回参 },
    ];
    const got = sourceEvidenceCandidates(spans);
    expect(got.length).toBe(1);
    expect(got[0].hint).toBe("");
  });

  it("grep 的原始输出不算证据链——有行号但没有裁决、没有小节", () => {
    const grep输出 = [
      "src/gausskernel/optimizer/plan/planmain.cpp:246:    if (ENABLE_SQL_BETA_FEATURE(EXTRACT_PUSHDOWN_OR_CLAUSE)) {",
      "src/gausskernel/optimizer/util/orclauses.cpp:71:void extract_restriction_or_clauses(PlannerInfo *root)",
    ].join("\n");
    const spans = [{ span_id: "b1", kind: "tool", name: "Bash", output: grep输出 }];
    expect(sourceEvidenceCandidates(spans).length).toBe(0);
  });
});
