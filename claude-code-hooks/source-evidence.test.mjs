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
  it("只看 Agent span，同一 span 不重复收", () => {
    const agent = (id, out) => ({
      span_id: id, kind: "tool", name: "Agent",
      input: JSON.stringify({ description: "Verify H2" }), output_local: out,
    });
    const spans = [
      agent("a1", "- `gram.y:10` 命中"),
      agent("a1", "- `gram.y:10` 命中"),
      { span_id: "t1", kind: "tool", name: "Bash", output: "`gram.y:99`" },
      { span_id: "l1", kind: "llm", output_local: "`gram.y:88`" },
    ];
    const got = sourceEvidenceCandidates(spans);
    expect(got.length).toBe(1);
    expect(got[0].spanId).toBe("a1");
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
