// source-evidence-prompt.mjs — 把粗筛出来的代码引用交给模型切分与判真伪。
//
// 粗筛（source-evidence.mjs）只能说「这一行里有个带行号的源码引用」。它分不清三件事：
//   ① 一条证据步：`gram.y:24028-24034` 在 `#ifdef PGXC` 里无条件 ereport ——支撑「出厂构建必拒」
//   ② 顺口提到：`见 gram.y:100 附近还有别的产生式` ——不支撑任何断言
//   ③ 几行凑一步：报错点 + 它的上下文 + 同一结论的第二处佐证，本来是**一条**证据
// 2026-09-12 在 27 条历史 trace 上实测：严格正则按「反引号 + `**N.` 小节」切，召回只有
// 12.5%（43/343），漏的全是格式抖动（`## H3 verdict:` / `### 1. …` / 行号写在正文里）。
// 子代理每次回参形状都不同，而 skill 压不住格式——所以切分这件事交给模型，正则只管召回。

/** 输出的 JSON 形状（提示词里逐字给模型，解析侧按同一形状校验）。 */
// 注意：**裁决不问模型**。2026-09-12 实测——让它顺带判时，它会拿「证据很硬」当成
// 「假设成立」：子代理原文 `[H2] refuted`（假设被推翻），模型回了 supported。
// 裁决是单个关键词、形状可穷举，走 source-evidence.mjs 的 verdictFromReturn 正则。
export const SOURCE_EVIDENCE_SCHEMA = `{
  "hypothesis_id": "H2" | null,
  "steps": [ { "title": "一句话说清这一步证明了什么", "refs": ["路径:行", ...] } ]
}`;

/**
 * 候选 → 提示词。没有候选返回空串（调用方据此跳过这次模型调用）。
 * `cand` 是 source-evidence.mjs 的 `candidatesFromReturn` 产物。
 */
export function buildSourceEvidencePrompt(cand) {
  if (!cand || !Array.isArray(cand.lines) || cand.lines.length === 0) return "";
  const heads = (cand.heads ?? []).map((h) => `- ${h}`).join("\n");
  const lines = cand.lines
    .map((l, i) => `${i + 1}. ${l.text}\n   （其中的引用：${l.refs.join(", ")}）`)
    .join("\n");
  return `一次数据库诊断里，某个子代理被派去验证一条假设，下面是它**回参里所有带行号的源码引用**（已粗筛，原文行照抄）。

派单说的是：${cand.hint || "（没给）"}

回参里出现过的小节标题（可能含裁决，也可能只是排版）：
${heads || "（没有）"}

带引用的原文行：
${lines}

你要做两件事，只做这两件（**不要判这条假设成不成立**——那个另有出处，你判了也不会被采用）：

1. **判这次验的是哪条假设**。编号形如 H1 / H2.1。派单里点了就用它；派单没点，就从回参里认。认不出写 null。
2. **把原文行切成若干「证据步」**。一步 = 一个能支撑或推翻该假设的完整论点。
   - 同一个论点的多行**合成一步**（报错点 + 它的编译条件 + 同结论的第二处佐证，是一步不是三步）。
   - **只是顺口提到某个文件位置、不支撑任何断言的行，整行丢掉**，不要硬凑成一步。
   - 标题用一句中文说清**这一步证明了什么**，不要照抄英文小节名。
   - refs 只填该步真正用到的引用，照抄原文里的 \`路径:行\`，不要改写、不要补全路径。

只输出 JSON，不要任何解释文字：

${SOURCE_EVIDENCE_SCHEMA}`;
}

/** 模型回参 → 结构化。解析不了或形状不对返回 null（上层 best-effort 吞，图照出只是没有代码证据）。 */
export function parseSourceEvidenceReply(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/); // 模型偶尔在 JSON 外面包一层 ```json
  if (!m) return null;
  let d;
  try {
    d = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!d || typeof d !== "object") return null;
  const id = typeof d.hypothesis_id === "string" && /^H\d+(\.\d+)*$/.test(d.hypothesis_id) ? d.hypothesis_id : null;
  const V = { supported: "confirmed", refuted: "falsified", inconclusive: "open", 证实: "confirmed", 证伪: "falsified", 未决: "open" };
  // 裁决即使模型回了也不采用（见文件头）——由 verdictFromReturn 的正则给
  const verdict = null;
  const steps = Array.isArray(d.steps)
    ? d.steps
        .map((s) => ({
          title: typeof s?.title === "string" ? s.title.trim() : "",
          refs: Array.isArray(s?.refs) ? s.refs.filter((r) => typeof r === "string" && /:\d/.test(r)) : [],
        }))
        .filter((s) => s.refs.length > 0)
    : [];
  // 没有编号就挂不上任何假设，等于没有产出——不返回半截结果让上层去猜
  if (!id) return null;
  return { id, verdict, steps };
}
