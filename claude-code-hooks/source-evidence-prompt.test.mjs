import { describe, expect, it } from "vitest";
import { buildSourceEvidencePrompt, parseSourceEvidenceReply } from "./source-evidence-prompt.mjs";

const CAND = {
  spanId: "a1",
  hint: "Verify H2 source conditionality",
  heads: ["## H2 verdict: **refuted**", "### 1. Rejection site"],
  lines: [
    { text: "- `gram.y:24015-24037`: the only production", refs: ["gram.y:24015-24037"] },
    { text: "- `configure.in:1930-1931`: CFLAGS=\"-DPGXC\"", refs: ["configure.in:1930-1931"] },
  ],
};

describe("buildSourceEvidencePrompt", () => {
  it("没候选不发请求", () => {
    expect(buildSourceEvidencePrompt(null)).toBe("");
    expect(buildSourceEvidencePrompt({ lines: [] })).toBe("");
  });
  it("派单、小节标题、原文行都带上，并明说「顺口提到的丢掉」", () => {
    const p = buildSourceEvidencePrompt(CAND);
    expect(p).toContain("Verify H2 source conditionality");
    expect(p).toContain("## H2 verdict");
    expect(p).toContain("`gram.y:24015-24037`");
    expect(p).toContain("整行丢掉");
    expect(p).toContain("合成一步");
  });
});

describe("parseSourceEvidenceReply", () => {
  it("认 JSON；模型即使回了裁决也一律丢掉——裁决走 verdictFromReturn 的正则", () => {
    // 2026-09-12 实测：模型会拿「证据很硬」当「假设成立」——子代理原文 `[H2] refuted`，
    // 模型回 supported。所以这里硬性置 null，不给它influence 图上的假设状态。
    const g = parseSourceEvidenceReply('{"hypothesis_id":"H2","verdict":"supported","steps":[{"title":"出厂构建必拒","refs":["gram.y:24015-24037"]}]}');
    expect(g).toEqual({ id: "H2", verdict: null, steps: [{ title: "出厂构建必拒", refs: ["gram.y:24015-24037"] }] });
  });
  it("外面包了 ```json 也认", () => {
    expect(parseSourceEvidenceReply('```json\n{"hypothesis_id":"H1","verdict":null,"steps":[]}\n```').id).toBe("H1");
  });
  it("没有编号就整条不要——半截结果会让上层去猜挂在哪", () => {
    expect(parseSourceEvidenceReply('{"hypothesis_id":null,"verdict":"refuted","steps":[{"title":"x","refs":["a.c:1"]}]}')).toBe(null);
  });
  it("没有 refs 的步丢掉；坏 JSON / 空回参返回 null", () => {
    const g = parseSourceEvidenceReply('{"hypothesis_id":"H1","steps":[{"title":"空","refs":[]},{"title":"有","refs":["a.c:1"]}]}');
    expect(g.steps.length).toBe(1);
    expect(parseSourceEvidenceReply("不是 JSON")).toBe(null);
    expect(parseSourceEvidenceReply("")).toBe(null);
  });
});
