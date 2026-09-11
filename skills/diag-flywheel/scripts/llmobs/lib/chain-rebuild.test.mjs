// chain-rebuild.test.mjs — 重建链（评测方用模型把声明树读成语义树）的纯函数层。
//
// 夹具是 2026-09-11 线上三条真 trace 的裁剪版（__fixtures__/chain/，见各文件 note）：
//   og-7458  四个粗桶全证伪后另开一级 H6，语义上 H6 是 H3 的下一环，H3 却被判证伪；
//   og-8252  账本 H1 证伪 / H2 证实，报告的机制段落写的却是 H1 的原话；
//   og-7284  H2 一出场就是压成一条的三步链（A 兼容 → 隐式 time→interval → A 分支覆盖格式串）。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAIN_FILES,
  RELATIONS,
  buildChainPrompt,
  chainMaterials,
  parseChainResponse,
  rebuildChain,
  renderChain,
} from "./chain-rebuild.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, "__fixtures__", "chain", `${name}.json`), "utf8"));

describe("chainMaterials：从 server 导出的 trace 里凑齐重建要读的材料", () => {
  it("og-7458：六个声明节点带 claim / 判定 / 提出顺序，报告正文与账本行都在", () => {
    const m = chainMaterials(fixture("og-7458-lob-insert").spans);
    expect(m.declared.map((n) => n.id)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6"]);
    const h6 = m.declared.find((n) => n.id === "H6");
    expect(h6.verdict).toBe("confirmed");
    expect(h6.claim).toMatch(/rpad/);
    expect(h6.first_seq).toBeGreaterThan(m.declared.find((n) => n.id === "H3").first_seq);
    expect(m.report).toMatch(/## The root cause/);
    expect(m.ledger.some((l) => /^H6\b.*supported/i.test(l))).toBe(true);
  });

  it("没有任何假设编号的 trace 返回 null——重建无从谈起，调用方据此跳过", () => {
    const spans = fixture("og-8252-vector-tag-filter").spans.map((s) => ({ ...s, intent: "plain", tags: {}, output: "" }));
    expect(chainMaterials(spans)).toBeNull();
  });

  it("og-8252：报告正文取五段式那条，不是 root 最后那句「结论不变」", () => {
    const m = chainMaterials(fixture("og-8252-vector-tag-filter").spans);
    expect(m.report).toMatch(/## Why that broke things/);
    expect(m.report).toMatch(/hnswscan\.cpp/);
  });
});

describe("buildChainPrompt：给模型看的材料", () => {
  it("每个声明节点的编号与 claim 都进提示词，且要求只回 JSON", () => {
    const m = chainMaterials(fixture("og-7458-lob-insert").spans);
    const p = buildChainPrompt(m);
    for (const n of m.declared) expect(p).toContain(`[${n.id}]`);
    expect(p).toMatch(/rpad/);
    expect(p).toMatch(/只输出.*JSON|只回.*JSON/);
  });

  it("提示词里不带夹具之外的示例编号——示例编号会被模型抄进输出（2026-09-10 实测 H2.1 被复述）", () => {
    const m = chainMaterials(fixture("og-7458-lob-insert").spans);
    const ids = new Set(m.declared.map((n) => n.id));
    const mentioned = new Set(buildChainPrompt(m).match(/\bH\d+(?:\.\d+)*\b/g) ?? []);
    for (const id of mentioned) expect(ids.has(id), `提示词里出现了声明树之外的编号 ${id}`).toBe(true);
  });
});

describe("parseChainResponse：模型回的 JSON 校验与派生字段", () => {
  const declared = () => chainMaterials(fixture("og-7458-lob-insert").spans);
  const answer = (nodes, extra = {}) =>
    JSON.stringify({
      nodes,
      final_mechanism_node: "H6",
      notes: "",
      ...extra,
    });

  it("H6 explains H3：深度从父链算出来（不信模型报的），声明深度 1、重建深度 2", () => {
    const c = parseChainResponse(
      "```json\n" +
        answer([
          { id: "H1", semantic_parent: null, relation: "root", claim_drift: false },
          { id: "H2", semantic_parent: null, relation: "root", claim_drift: false },
          { id: "H3", semantic_parent: null, relation: "root", claim_drift: false },
          { id: "H4", semantic_parent: null, relation: "root", claim_drift: false },
          { id: "H5", semantic_parent: null, relation: "root", claim_drift: false },
          { id: "H6", semantic_parent: "H3", relation: "explains", claim_drift: false },
        ]) +
        "\n```",
      declared(),
    );
    expect(c.depth_declared).toBe(1);
    expect(c.depth_semantic).toBe(2);
    expect(c.final_mechanism_node).toBe("H6");
  });

  it("父证伪、子证实且关系是 explains → 标出判定冲突，写明哪两个编号", () => {
    const c = parseChainResponse(
      answer([
        { id: "H1", semantic_parent: null, relation: "root", claim_drift: false },
        { id: "H2", semantic_parent: null, relation: "root", claim_drift: false },
        { id: "H3", semantic_parent: null, relation: "root", claim_drift: false },
        { id: "H4", semantic_parent: null, relation: "root", claim_drift: false },
        { id: "H5", semantic_parent: null, relation: "root", claim_drift: false },
        { id: "H6", semantic_parent: "H3", relation: "explains", claim_drift: false },
      ]),
      declared(),
    );
    expect(c.conflicts).toEqual([{ kind: "parent_refuted_child_supported", parent: "H3", child: "H6" }]);
  });

  it("每个节点都带回声明侧的父与判定，判卷方不用翻 forward.md 对照", () => {
    const c = parseChainResponse(
      answer(["H1", "H2", "H3", "H4", "H5", "H6"].map((id) => ({ id, semantic_parent: null, relation: "root", claim_drift: false }))),
      declared(),
    );
    const h6 = c.nodes.find((n) => n.id === "H6");
    expect(h6.declared_parent).toBeNull();
    expect(h6.declared_verdict).toBe("confirmed");
  });

  it("模型编了声明树里没有的编号 → 整份不收（宁缺毋滥）", () => {
    expect(() =>
      parseChainResponse(
        answer([
          ...["H1", "H2", "H3", "H4", "H5", "H6"].map((id) => ({ id, semantic_parent: null, relation: "root", claim_drift: false })),
          { id: "H3.1", semantic_parent: "H3", relation: "explains", claim_drift: false },
        ]),
        declared(),
      ),
    ).toThrow(/H3\.1/);
  });

  it("漏了声明树里的编号 → 不收", () => {
    expect(() =>
      parseChainResponse(answer([{ id: "H6", semantic_parent: null, relation: "root", claim_drift: false }]), declared()),
    ).toThrow(/H1/);
  });

  it("relation 只认词表；semantic_parent 成环不收", () => {
    const base = ["H1", "H2", "H4", "H5"].map((id) => ({ id, semantic_parent: null, relation: "root", claim_drift: false }));
    expect(() =>
      parseChainResponse(answer([...base, { id: "H3", semantic_parent: "H6", relation: "explains", claim_drift: false }, { id: "H6", semantic_parent: "H3", relation: "explains", claim_drift: false }]), declared()),
    ).toThrow(/环/);
    expect(() =>
      parseChainResponse(answer([...base, { id: "H3", semantic_parent: null, relation: "root", claim_drift: false }, { id: "H6", semantic_parent: "H3", relation: "supports", claim_drift: false }]), declared()),
    ).toThrow(/relation/);
    expect(RELATIONS).toEqual(["root", "explains", "refines", "alternative", "same_as"]);
  });

  it("不是 JSON / 没有 nodes → 抛错，错误里带原文开头方便排查", () => {
    expect(() => parseChainResponse("我觉得 H6 应该挂在 H3 下面。", declared())).toThrow(/JSON/);
  });
});

describe("parseChainResponse：粗→细与现象根的深度口径", () => {
  const declared = () => chainMaterials(fixture("og-7458-lob-insert").spans);
  const flat = (ids) => ids.map((id) => ({ id, semantic_parent: null, relation: "root", claim_drift: false }));

  it("refines（H6 是 H3 那个粗桶里的具体机制）也算往下一层，且父证伪子证实照样记冲突", () => {
    const c = parseChainResponse(
      JSON.stringify({
        nodes: [...flat(["H1", "H2", "H3", "H4", "H5"]), { id: "H6", semantic_parent: "H3", relation: "refines", claim_drift: false }],
        final_mechanism_node: "H6",
        notes: "",
      }),
      declared(),
    );
    expect(c.depth_semantic).toBe(2);
    expect(c.conflicts).toEqual([{ kind: "parent_refuted_child_supported", parent: "H3", child: "H6" }]);
  });

  it("现象确认节点是根、不占层：根因直接解释现象算第 1 层，不算第 2 层（实测模型会把所有根因挂到现象下）", () => {
    // 7458 的 H1 是 type=confirm 的现象确认
    const c = parseChainResponse(
      JSON.stringify({
        nodes: [
          { id: "H1", semantic_parent: null, relation: "root", claim_drift: false },
          { id: "H6", semantic_parent: "H1", relation: "explains", claim_drift: false },
          ...["H2", "H3", "H4", "H5"].map((id) => ({ id, semantic_parent: "H6", relation: "alternative", claim_drift: false })),
        ],
        final_mechanism_node: "H6",
        notes: "",
      }),
      declared(),
    );
    expect(c.depth_semantic).toBe(1);
    expect(c.depth_declared).toBe(1);
    expect(c.nodes.find((n) => n.id === "H1").is_symptom).toBe(true);
  });

  it("只有现象确认节点、没有根因假设 → 两个深度都是 0", () => {
    const m = declared();
    const onlySymptom = { ...m, declared: m.declared.filter((n) => n.id === "H1") };
    const c = parseChainResponse(JSON.stringify({ nodes: flat(["H1"]), final_mechanism_node: null, notes: "" }), onlySymptom);
    expect(c.depth_semantic).toBe(0);
    expect(c.depth_declared).toBe(0);
  });
});

describe("buildChainPrompt：口径要写给模型", () => {
  it("提示词讲清 refines（粗桶→具体机制）与 explains 的区别，并说明判定不影响谱系", () => {
    const p = buildChainPrompt(chainMaterials(fixture("og-7458-lob-insert").spans));
    expect(p).toMatch(/refines/);
    expect(p).toMatch(/证伪.*不影响|判定.*不影响|不看判定/);
    expect(p).toMatch(/现象确认.*根|现象.*是根/);
    expect(p).toMatch(/枚举.*例子|例子.*不.*穷举/);
  });
});

describe("renderChain：给判卷方和人读的 markdown", () => {
  it("按语义父子缩进；每行带声明判定；有冲突就单列一节", () => {
    const m = chainMaterials(fixture("og-7458-lob-insert").spans);
    const c = parseChainResponse(
      JSON.stringify({
        nodes: [
          ...["H1", "H2", "H3", "H4", "H5"].map((id) => ({ id, semantic_parent: null, relation: "root", claim_drift: false })),
          { id: "H6", semantic_parent: "H3", relation: "explains", claim_drift: false },
        ],
        final_mechanism_node: "H6",
        notes: "H6 是 H3 那个桶里的具体机制",
      }),
      m,
    );
    const md = renderChain(c, m);
    expect(md).toMatch(/^# 重建链/m);
    expect(md).toMatch(/评测方.*重建|重建.*评测方/);
    expect(md).toMatch(/^- \*\*\[H3\]\*\*.*证伪/m);
    expect(md).toMatch(/^  - \*\*\[H6\]\*\*.*证实/m);
    expect(md).toMatch(/## 判定冲突/);
    expect(md).toMatch(/H3.*H6/);
    expect(md).toMatch(/声明深度 1.*重建深度 2/);
  });
});

describe("renderChain：每个节点都要出现，包括挂在「并列」节点下面的", () => {
  it("og-8252 形态：H3 explains H2、H2 是 H1 的 alternative → H3 不能被漏画（实测第一版漏了）", () => {
    const m = chainMaterials(fixture("og-8252-vector-tag-filter").spans);
    const c = parseChainResponse(
      JSON.stringify({
        nodes: [
          { id: "H0", semantic_parent: null, relation: "root", claim_drift: false },
          { id: "H1", semantic_parent: "H0", relation: "explains", claim_drift: false },
          { id: "H2", semantic_parent: "H1", relation: "alternative", claim_drift: false },
          { id: "H3", semantic_parent: "H2", relation: "explains", claim_drift: false },
        ],
        final_mechanism_node: "H2",
        notes: "",
      }),
      m,
    );
    expect(c.depth_semantic).toBe(2);
    const md = renderChain(c, m);
    for (const id of ["H0", "H1", "H2", "H3"]) {
      const times = (md.match(new RegExp(`^\\s*- \\*\\*\\[${id}\\]\\*\\*`, "gm")) ?? []).length;
      expect(times, `${id} 应恰好画一次`).toBe(1);
    }
    expect(md).toMatch(/^  - \*\*\[H2\]\*\*/m);
    expect(md).toMatch(/^    - \*\*\[H3\]\*\*/m);
  });
});

describe("rebuildChain：一条 case 一次模型调用，成败都不阻塞判卷", () => {
  const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "chain-rebuild-"));

  it("模型答对形状 → 目录里落 chain.json + chain.md，返回 ok", async () => {
    const dir = tmp();
    const spans = fixture("og-7458-lob-insert").spans;
    fs.writeFileSync(path.join(dir, "trace.json"), JSON.stringify({ spans }));
    let seenPrompt = "";
    const runAgent = async ({ prompt }) => {
      seenPrompt = prompt;
      return {
        prose: JSON.stringify({
          nodes: [
            ...["H1", "H2", "H3", "H4", "H5"].map((id) => ({ id, semantic_parent: null, relation: "root", claim_drift: false })),
            { id: "H6", semantic_parent: "H3", relation: "explains", claim_drift: false },
          ],
          final_mechanism_node: "H6",
          notes: "",
        }),
      };
    };
    const r = await rebuildChain({ caseDir: dir, runAgent });
    expect(r.status).toBe("ok");
    expect(seenPrompt).toContain("[H6]");
    const json = JSON.parse(fs.readFileSync(path.join(dir, CHAIN_FILES.json), "utf8"));
    expect(json.depth_semantic).toBe(2);
    expect(json.model).toBeDefined();
    expect(fs.readFileSync(path.join(dir, CHAIN_FILES.md), "utf8")).toMatch(/重建链/);
  });

  it("模型回的东西不成形 → 不落文件，返回 failed 带原因；不抛", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "trace.json"), JSON.stringify({ spans: fixture("og-8252-vector-tag-filter").spans }));
    const r = await rebuildChain({ caseDir: dir, runAgent: async () => ({ prose: "抱歉，我无法确定。" }) });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/JSON/);
    expect(fs.existsSync(path.join(dir, CHAIN_FILES.json))).toBe(false);
  });

  it("trace 没有假设编号 → 不调模型，返回 skipped", async () => {
    const dir = tmp();
    const spans = fixture("og-8252-vector-tag-filter").spans.map((s) => ({ ...s, intent: "plain", tags: {}, output: "" }));
    fs.writeFileSync(path.join(dir, "trace.json"), JSON.stringify({ spans }));
    let called = 0;
    const r = await rebuildChain({ caseDir: dir, runAgent: async () => { called += 1; return { prose: "{}" }; } });
    expect(r.status).toBe("skipped");
    expect(called).toBe(0);
  });
});
